// server.js — Sammy v4 (humanized replies + en-AU STT + robust turn-taking)

const express = require("express");
const dotenv = require("dotenv");
const axios = require("axios");

dotenv.config();

const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY  = process.env.OPENAI_API_KEY || "";
const ELEVEN_API_KEY  = process.env.ELEVENLABS_API_KEY || "";
const ELEVEN_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "";
const SAMMY_MODE      = (process.env.SAMMY_MODE || "friendly").toLowerCase(); // friendly|flirty|pro
const QUIRKS_LEVEL    = Math.max(0, Math.min(3, parseInt(process.env.SAMMY_QUIRKS_LEVEL || "2", 10)));
const STT_HINTS       = process.env.SAMMY_HINTS || ""; // optional CSV of domain phrases

if (!OPENAI_API_KEY)  console.warn("⚠️ Missing OPENAI_API_KEY");
if (!ELEVEN_API_KEY)  console.warn("⚠️ Missing ELEVENLABS_API_KEY");
if (!ELEVEN_VOICE_ID) console.warn("⚠️ Missing ELEVENLABS_VOICE_ID");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---------- tiny landing / health ----------
app.get("/", (_req, res) => {
  res.type("text/plain").send("✅ Sammy Voice Agent is running. Twilio uses POST /voice");
});
app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "sammy-voice", time: new Date().toISOString() });
});
app.get("/voice", (_req, res) => res.status(405).type("text/plain").send("Use POST /voice (Twilio webhook)"));

// ---------- personality ----------
function modeSnippet() {
  if (SAMMY_MODE === "flirty") return "Mode: flirty; playful, cheeky but respectful; never crude.";
  if (SAMMY_MODE === "pro")    return "Mode: professional; concise, warm, no flirting; efficient.";
  return "Mode: friendly; warm Perth Aussie vibe, relaxed and a touch cheeky.";
}

const SAMMY_SYSTEM = `
You are Sammy, a lifelike Aussie voice agent from Perth.

Core traits:
- Friendly, witty, grounded; warm empathy; solution-oriented.
- Keep answers short (1–2 sentences); let the caller speak.
- Subtle WA flavour: "mate", "no worries", "too easy" where it fits.

${modeSnippet()}

Speaking style:
- Return only what you will speak (no brackets or stage directions).
- Natural back-channeling (mm, yeah, right) sparingly; vary cadence; sound present.
- Ask at most one clear follow-up question.

Boundaries:
- No medical/legal/financial advice beyond general info; keep it safe and kind.
`.trim();

// ---------- per-call session ----------
const sessions = new Map(); // callSid -> { history, turns, emptyCount, lastErrorAt, last }
function session(sid) {
  let s = sessions.get(sid);
  if (!s) { s = { history: [], turns: 0, emptyCount: 0, lastErrorAt: 0, last: Date.now() }; sessions.set(sid, s); }
  s.last = Date.now(); return s;
}
function pushUser(sid, t) { const s = session(sid); s.history.push({ role:"user", content:t }); if (s.history.length>14) s.history=s.history.slice(-14); }
function pushAssistant(sid, t){ const s=session(sid); s.history.push({ role:"assistant", content:t }); if (s.history.length>14) s.history=s.history.slice(-14); s.turns++; }

// ---------- utilities ----------
function xmlEsc(s=""){ return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
function baseUrl(req){ const proto=req.headers["x-forwarded-proto"]||req.protocol||"https"; return `${proto}://${req.headers["host"]}`; }
function rand(a,b){ return a+Math.random()*(b-a); }
function pick(arr){ return arr[Math.floor(Math.random()*arr.length)]; }

// ---------- Humanizer: add Aussie cues, micro-pauses, shorten ----------
function humanize(text){
  if (!text) return text;

  // 1) normalize and split into sentences (very light)
  let t = text.trim().replace(/\s+/g," ");
  let parts = t.split(/(?<=[.!?])\s+/);
  if (parts.length === 0) parts = [t];

  // 2) cap to 2 short sentences (~10–25 words each)
  const keep = [];
  for (const p of parts){
    if (!p) continue;
    const words = p.split(" ");
    if (words.length > 22) {
      // split long into two using comma/and heuristics
      const cut = Math.min(words.length-1, Math.max(10, Math.floor(words.length*0.55)));
      keep.push(words.slice(0,cut).join(" ") + "…");
      keep.push(words.slice(cut).join(" "));
    } else keep.push(p);
    if (keep.length >= 2) break;
  }
  let out = keep.slice(0,2).join(" ");

  // 3) add micropauses + interjections by intensity
  const fillersA = ["mm", "yeah", "right", "uh", "ah"];
  const openers  = ["mm,", "yeah,", "right,", "look,", "hey,"];
  const tails    = [", mate", ", hey", ", you reckon?", ", if that suits?", ", too easy."];
  const aussie   = ["no worries", "too easy", "all good", "no drama"];

  if (QUIRKS_LEVEL >= 1){
    // opener 40%
    if (Math.random() < 0.4) out = `${pick(openers)} ${out}`;
    // ellipsis or dash mid-sentence 40%
    out = out.replace(/, /, Math.random()<0.5 ? " — " : "… ");
  }
  if (QUIRKS_LEVEL >= 2){
    // sprinkle filler 30%
    if (Math.random() < 0.3) out = `${pick(fillersA)}, ${out}`;
    // occasional aussie phrase 25%
    if (Math.random() < 0.25) out += `, ${pick(aussie)}.`;
  }
  if (QUIRKS_LEVEL >= 3){
    // add soft tag tail 30%
    if (Math.random() < 0.3) out += pick(tails);
    // add another tiny pause
    out = out.replace(/\sand\s/i, " … and ");
  }

  // keep it tidy
  out = out.replace(/\s+/g," ").replace(/\s([?.!])/g,"$1").trim();
  return out;
}

// ---------- OpenAI (small backoff) ----------
async function askOpenAI(sid, userText, greet=false){
  const s = session(sid);
  const msgs = [{ role:"system", content: SAMMY_SYSTEM }];
  if (greet){
    msgs.push({ role:"user", content: "Caller just connected. Greet naturally with a Perth Aussie vibe and one short opener." });
  } else {
    for (const m of s.history) msgs.push(m);
    msgs.push({ role:"user", content: userText });
  }
  const payload = { model:"gpt-4o-mini", temperature:0.7, max_tokens:90, messages:msgs };

  for (let i=0;i<3;i++){
    try{
      const r = await axios.post("https://api.openai.com/v1/chat/completions", payload, {
        headers:{ Authorization:`Bearer ${OPENAI_API_KEY}` }
      });
      const text = (r.data.choices?.[0]?.message?.content || "").trim();
      if (text) return text;
    }catch(e){
      const code = e.response?.data?.error?.code || e.response?.status || e.code;
      console.error("OpenAI error:", code, e.response?.data || e.message);
      s.lastErrorAt = Date.now();
      await new Promise(r=>setTimeout(r, 400 + i*600));
    }
  }
  return "Mm… give me a tick. All good now — what were you saying?";
}

// ---------- ElevenLabs TTS ----------
async function synth(text){
  try{
    const resp = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`,
      {
        text,
        model_id: "eleven_multilingual_v2",
        voice_settings: {
          stability: 0.15,          // a bit more expressive
          similarity_boost: 0.9,
          style: 0.7,
          use_speaker_boost: true
        }
      },
      {
        headers:{
          "xi-api-key": ELEVEN_API_KEY,
          "Content-Type": "application/json",
          Accept: "audio/mpeg"
        },
        responseType: "arraybuffer"
      }
    );
    return Buffer.from(resp.data);
  }catch(e){
    console.error("ElevenLabs error:", e.response?.data || e.message);
    return null;
  }
}

// ---------- simple audio cache per call ----------
const audio = new Map(); // sid -> Buffer
app.get("/tts/:sid", (req, res) => {
  const buf = audio.get(req.params.sid);
  if (!buf) return res.status(404).send("No audio");
  res.set("Content-Type", "audio/mpeg");
  res.send(buf);
});

// ---------- Twilio webhook ----------
app.post("/voice", async (req, res) => {
  const sid        = req.body.CallSid || "no_sid";
  const speech     = (req.body.SpeechResult || req.body.TranscriptionText || "").trim();
  const confidence = parseFloat(req.body.Confidence || "0");
  const isNewCall  = !sessions.has(sid);

  const s = session(sid);
  let botText;

  if (isNewCall){
    botText = await askOpenAI(sid, "", true);
  } else {
    if (!speech || (isFinite(confidence) && confidence < 0.45)){
      s.emptyCount++;
    } else {
      s.emptyCount = 0;
      pushUser(sid, speech);
      botText = await askOpenAI(sid, speech, false);
    }

    if (!botText){
      if (s.emptyCount === 1) botText = "Yeah, I might’ve missed that — could you say it again a tad slower?";
      else if (s.emptyCount === 2) botText = "Mm, still a bit patchy on my end. A short version would help, mate.";
      else botText = "No worries — one quick line does the trick. What would you like me to do?";
    }
  }

  // Humanize
  const spoken = humanize(botText);
  pushAssistant(sid, spoken);

  // TTS
  const mp3 = await synth(spoken);
  audio.set(sid, mp3);

  const url = baseUrl(req);
  const gatherUrl = `${url}/voice`;
  const ttsUrl    = `${url}/tts/${encodeURIComponent(sid)}`;
  const language  = `language="en-AU"`;
  const hintsAttr = STT_HINTS ? ` hints="${xmlEsc(STT_HINTS)}"` : "";

  // TwiML: play -> gather next
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${xmlEsc(ttsUrl)}</Play>
  <Gather input="speech" ${language} enhanced="true"${hintsAttr}
          timeout="8" speechTimeout="auto"
          profanityFilter="false"
          action="${xmlEsc(gatherUrl)}" method="POST" />
</Response>`;
  res.type("text/xml").send(twiml);
});

// ---------- start ----------
app.listen(PORT, () => {
  console.log(`Sammy v4 listening on ${PORT}`);
});
