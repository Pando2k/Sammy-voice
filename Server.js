// server.js — Sammy v4.1 FAST & SNAPPY
// Twilio <Gather> (barge-in) ⇄ OpenAI short-turn brain ⇄ ElevenLabs TTS (micro-chunks)
// Design goals:
// - Replies start playing fast (first chunk ASAP)
// - Short lines only (6–12 words). No long pauses. Minimal fillers.
// - Tight <Gather> timeouts to kill dead air
// - Still playful + Aussie, but light

const express = require("express");
const dotenv  = require("dotenv");
const axios   = require("axios");
const { v4: uuidv4 } = require("uuid");

dotenv.config();

const PORT                = process.env.PORT || 10000;
const OPENAI_API_KEY      = process.env.OPENAI_API_KEY || "";
const ELEVEN_API_KEY      = process.env.ELEVENLABS_API_KEY || "";
const ELEVEN_VOICE_ID     = process.env.ELEVENLABS_VOICE_ID || "";
const TWILIO_SPEECH_MODEL = process.env.TWILIO_SPEECH_MODEL || "mmm";
const STT_HINTS           = (process.env.STT_HINTS || "").trim();
const QUIRKS_LEVEL        = Math.max(0, Math.min(3, parseInt(process.env.QUIRKS_LEVEL || "1", 10))); // keep light

if (!OPENAI_API_KEY)  console.warn("⚠️ Missing OPENAI_API_KEY");
if (!ELEVEN_API_KEY)  console.warn("⚠️ Missing ELEVENLABS_API_KEY");
if (!ELEVEN_VOICE_ID) console.warn("⚠️ Missing ELEVENLABS_VOICE_ID");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---------------- utils ----------------
function xmlEsc(s=""){ return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
function baseUrl(req){ const proto=req.headers["x-forwarded-proto"]||req.protocol||"https"; return `${proto}://${req.headers["host"]}`; }
function pick(a){ return a[Math.floor(Math.random()*a.length)]; }

// ---------------- sessions ----------------
const sessions = new Map(); // callSid -> { history:[], turns:number }
function sess(id){ let s=sessions.get(id); if(!s){ s={history:[],turns:0}; sessions.set(id,s);} return s; }
function pushUser(id,t){ const s=sess(id); s.history.push({role:"user",content:t}); if(s.history.length>10) s.history=s.history.slice(-10); }
function pushBot (id,t){ const s=sess(id); s.history.push({role:"assistant",content:t}); if(s.history.length>10) s.history=s.history.slice(-10); s.turns++; }

// ---------------- system prompt (fast style) ----------------
const SYSTEM_PROMPT = `
You are **Sammy**, a young Aussie woman from Perth.
Fast, helpful, natural. Speak like a real person.

HARD RULES:
- Keep replies VERY short: 6–12 words. One sentence, two max.
- No stage directions. No brackets. Only spoken words.
- Minimal fillers. No long pauses. Snappy rhythm.
- If you need info, ask ONE crisp question.
- Be warm and casual; light Aussie flavour ("no worries", "too easy") sometimes.

If caller is stressed, soften and keep it short.
If excited, match lightly.
`.trim();

// ---------------- fast humanizer ----------------
// Keep it lean: tiny opener sometimes, tiny dash for micro-pause, no ellipses.
const OPENERS = ["yeah,", "right,", "okay,", "look,"];
function humanizeFast(text){
  if (!text) return text;
  let t = text.trim().replace(/\s+/g, " ");

  // Split to sentences, then HARD cap each to ~12 words
  let parts = t.split(/(?<=[.!?])\s+/).filter(Boolean);
  if (parts.length === 0) parts = [t];

  const keep = [];
  for (const p of parts){
    const words = p.split(" ").filter(Boolean);
    if (words.length > 12) keep.push(words.slice(0, 12).join(" ") + ".");
    else keep.push(p);
    if (keep.length >= 2) break; // at most 2 short sentences
  }
  t = keep.join(" ");

  // light quirk (but fast)
  if (QUIRKS_LEVEL >= 1 && Math.random() < 0.18) t = `${pick(OPENERS)} ${t}`;
  if (QUIRKS_LEVEL >= 1 && Math.random() < 0.18) t = t.replace(", ", " — "); // tiny micro-pause

  // absolutely no ellipses to avoid stretched pauses
  t = t.replace(/…/g, " — ");

  // final clean
  return t.replace(/\s([?.!])/g, "$1").trim();
}

// Split into tiny chunks so the first plays ASAP
function splitForSpeed(text){
  const parts = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  if (parts.length === 0) return [text, ""];
  const first = parts.shift();
  const rest  = parts.join(" ");
  return [first, rest];
}

// ---------------- OpenAI short-turn brain ----------------
async function askBrain(history, userText){
  try{
    const r = await axios.post("https://api.openai.com/v1/chat/completions", {
      model: "gpt-4o-mini",
      temperature: 0.6,        // tighter / less rambly
      max_tokens: 90,          // short
      messages: [
        { role:"system", content: SYSTEM_PROMPT },
        ...history,
        { role:"user", content: userText }
      ]
    }, { headers:{ Authorization:`Bearer ${OPENAI_API_KEY}` }, timeout: 20000 });

    const raw = (r.data.choices?.[0]?.message?.content || "").trim();
    return humanizeFast(raw);
  }catch(e){
    console.error("OpenAI error:", e.response?.data || e.message);
    return "Quick one—say that again, short and sweet?";
  }
}

// ---------------- ElevenLabs TTS (anti-monotone, fast) ----------------
async function tts(text){
  try{
    const r = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`,
      {
        text,
        model_id: "eleven_multilingual_v2",
        voice_settings: {
          stability: 0.18,        // a bit expressive
          similarity_boost: 0.9,
          style: 0.6,             // lively but not theatrical
          use_speaker_boost: true
        }
      },
      {
        headers:{
          "xi-api-key": ELEVEN_API_KEY,
          "Content-Type": "application/json",
          Accept: "audio/mpeg"
        },
        responseType: "arraybuffer",
        timeout: 25000
      }
    );
    return Buffer.from(r.data);
  }catch(e){
    console.error("ElevenLabs error:", e.response?.data || e.message);
    return null;
  }
}

// ---------------- audio store ----------------
const audioStore = new Map(); // id -> Buffer
app.get("/a/:id", (req, res) => {
  const buf = audioStore.get(req.params.id);
  if (!buf) return res.status(404).send("Not found");
  res.set("Content-Type","audio/mpeg");
  res.send(buf);
});

// ---------------- health ----------------
app.get("/", (_req, res) => res.type("text/plain").send("✅ Sammy v4.1 Fast & Snappy is running. POST /voice"));
app.get("/health", (_req, res) => res.json({ok:true, service:"sammy-v4.1", time:new Date().toISOString()}));
app.get("/voice", (_req, res) => res.status(405).type("text/plain").send("Use POST /voice"));

// ---------------- call entry ----------------
app.post("/voice", async (req, res) => {
  const callSid = req.body.CallSid || `local-${uuidv4()}`;
  const s = sess(callSid);
  const base = baseUrl(req);

  const greeting = "Heya, Sammy here. What d’you need sorted?";
  const g = await tts(greeting);
  const gid = uuidv4(); if (g) audioStore.set(gid, g);

  const hints = STT_HINTS ? `hints="${xmlEsc(STT_HINTS)}"` : "";

  // Tight timeouts to avoid dead air; barge-in so you can interrupt
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" bargeIn="true" enhanced="true"
          speechModel="${xmlEsc(TWILIO_SPEECH_MODEL)}"
          language="en-AU" timeout="1" speechTimeout="0.45"
          action="/gather" method="POST" ${hints}>
    <Play>${xmlEsc(base)}/a/${gid}</Play>
  </Gather>
  <Redirect method="POST">/voice</Redirect>
</Response>`;
  res.type("text/xml").send(twiml);
});

// ---------------- turn handler ----------------
app.post("/gather", async (req, res) => {
  const callSid = req.body.CallSid || `local-${uuidv4()}`;
  const base    = baseUrl(req);
  const s       = sess(callSid);

  const speech  = (req.body.SpeechResult || "").trim();
  const confVal = parseFloat(req.body.Confidence || "0");
  const lowConf = isFinite(confVal) && confVal > 0 && confVal < 0.45;

  let bot;
  if (!speech || lowConf){
    bot = !speech ? "Didn’t catch that—give me the short version?" : "Bit choppy—one short line?";
  } else {
    pushUser(callSid, speech);
    const brain = await askBrain(s.history, speech);
    // play first sentence immediately, optional tiny second
    const [first, rest] = splitForSpeed(brain);

    const a1 = await tts(first);
    const id1 = uuidv4(); if (a1) audioStore.set(id1, a1);

    let second = "";
    if (rest && rest.split(" ").length > 3) {
      const a2 = await tts(rest);
      if (a2){ const id2=uuidv4(); audioStore.set(id2,a2); second = `<Play>${xmlEsc(base)}/a/${id2}</Play>`; }
    }

    pushBot(callSid, brain);

    const hints = STT_HINTS ? `hints="${xmlEsc(STT_HINTS)}"` : "";

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" bargeIn="true" enhanced="true"
          speechModel="${xmlEsc(TWILIO_SPEECH_MODEL)}"
          language="en-AU" timeout="1" speechTimeout="0.45"
          action="/gather" method="POST" ${hints}>
    <Play>${xmlEsc(base)}/a/${id1}</Play>
    ${second}
  </Gather>
  <Redirect method="POST">/voice</Redirect>
</Response>`;
    return res.type("text/xml").send(twiml);
  }

  // fallback path
  const a = await tts(humanizeFast(bot));
  const id = uuidv4(); if (a) audioStore.set(id, a);

  const hints = STT_HINTS ? `hints="${xmlEsc(STT_HINTS)}"` : "";

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" bargeIn="true" enhanced="true"
          speechModel="${xmlEsc(TWILIO_SPEECH_MODEL)}"
          language="en-AU" timeout="1" speechTimeout="0.45"
          action="/gather" method="POST" ${hints}>
    <Play>${xmlEsc(base)}/a/${id}</Play>
  </Gather>
  <Redirect method="POST">/voice</Redirect>
</Response>`;
  res.type("text/xml").send(twiml);
});

// ---------------- start ----------------
app.listen(PORT, () => {
  console.log(`Sammy v4.1 Fast & Snappy listening on ${PORT}`);
});
