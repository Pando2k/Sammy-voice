// server.js — Sammy v5 FAST (tight turn-taking + light quirks)

const express = require("express");
const dotenv = require("dotenv");
const axios = require("axios");

dotenv.config();

const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY  = process.env.OPENAI_API_KEY || "";
const ELEVEN_API_KEY  = process.env.ELEVENLABS_API_KEY || "";
const ELEVEN_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "";
const SAMMY_MODE      = (process.env.SAMMY_MODE || "friendly").toLowerCase(); // friendly|flirty|pro
const QUIRKS_LEVEL    = Math.max(0, Math.min(3, parseInt(process.env.SAMMY_QUIRKS_LEVEL || "1", 10))); // default lighter
const STT_HINTS       = process.env.SAMMY_HINTS || "";

if (!OPENAI_API_KEY)  console.warn("⚠️ Missing OPENAI_API_KEY");
if (!ELEVEN_API_KEY)  console.warn("⚠️ Missing ELEVENLABS_API_KEY");
if (!ELEVEN_VOICE_ID) console.warn("⚠️ Missing ELEVENLABS_VOICE_ID");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// -------- landing / health
app.get("/", (_req, res) => res.type("text/plain").send("✅ Sammy FAST is running. Twilio uses POST /voice"));
app.get("/health", (_req, res) => res.json({ ok:true, service:"sammy-voice-fast", time:new Date().toISOString() }));
app.get("/voice", (_req, res) => res.status(405).type("text/plain").send("Use POST /voice (Twilio webhook)"));

// -------- system prompt
function modeSnippet() {
  if (SAMMY_MODE === "flirty") return "Mode: flirty; playful but respectful.";
  if (SAMMY_MODE === "pro")    return "Mode: professional; concise, warm, efficient.";
  return "Mode: friendly; relaxed Perth Aussie vibe.";
}

const SAMMY_SYSTEM = `
You are Sammy, a lifelike Aussie voice agent from Perth.

Keep replies short (1–2 lines, ~12–18 words), helpful, present.
Subtle WA flavour: "mate", "no worries", "too easy" when natural.
Never include stage directions or bracketed text.

${modeSnippet()}

Ask at most one clear follow-up question.
Boundaries: no medical/legal/financial advice beyond general info.
`.trim();

// -------- sessions
const sessions = new Map(); // callSid -> { history, turns, emptyCount, last }
function sess(id){ let s=sessions.get(id); if(!s){ s={history:[],turns:0,emptyCount:0,last:Date.now()}; sessions.set(id,s);} s.last=Date.now(); return s; }
function pushUser(id,t){const s=sess(id); s.history.push({role:"user",content:t}); if(s.history.length>12) s.history=s.history.slice(-12);}
function pushBot (id,t){const s=sess(id); s.history.push({role:"assistant",content:t}); if(s.history.length>12) s.history=s.history.slice(-12); s.turns++;}

// -------- utils
function xmlEsc(s=""){return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}
function baseUrl(req){const proto=req.headers["x-forwarded-proto"]||req.protocol||"https";return `${proto}://${req.headers["host"]}`;}
function pick(a){return a[Math.floor(Math.random()*a.length)];}

// -------- light humanizer (fast)
function humanize(text){
  if(!text) return text;
  let t = text.trim().replace(/\s+/g," ");

  // sentence split and HARD cap
  let parts = t.split(/(?<=[.!?])\s+/).filter(Boolean);
  if (parts.length === 0) parts = [t];
  const keep = [];
  for (const p of parts){
    const words = p.split(" ");
    if (words.length > 18) {
      keep.push(words.slice(0, Math.min(16, Math.floor(words.length*0.6))).join(" ") + ".");
    } else {
      keep.push(p);
    }
    if (keep.length >= 2) break;
  }
  t = keep.slice(0,2).join(" ");

  // modest Aussie flavour without long pauses
  if (QUIRKS_LEVEL >= 1){
    if (Math.random()<0.2) t = "yeah, " + t;                  // 20% opener
    if (Math.random()<0.2) t = t.replace(", ", " — ");        // tiny micro-pause
  }
  if (QUIRKS_LEVEL >= 2){
    if (Math.random()<0.2) t += " no worries.";               // small tail
  }
  // level 3 would add a touch more, but keep pauses minimal
  return t.replace(/\s([?.!])/g,"$1").trim();
}

// -------- OpenAI (fast)
async function askOpenAI(callSid, userText, greet=false){
  const s = sess(callSid);
  const messages = [{ role:"system", content:SAMMY_SYSTEM }];
  if (greet){
    messages.push({ role:"user", content:"Caller just connected. Greet naturally in one short line and ask a simple opener."});
  } else {
    for (const m of s.history) messages.push(m);
    messages.push({ role:"user", content:userText });
  }
  const payload = { model:"gpt-4o-mini", temperature:0.6, max_tokens:70, messages };

  for (let i=0;i<2;i++){
    try{
      const r = await axios.post("https://api.openai.com/v1/chat/completions", payload, {
        headers:{ Authorization:`Bearer ${OPENAI_API_KEY}` }
      });
      const out = (r.data.choices?.[0]?.message?.content || "").trim();
      if (out) return out;
    }catch(e){
      console.error("OpenAI error:", e.response?.data || e.message);
      await new Promise(r=>setTimeout(r, 300 + 300*i));
    }
  }
  return "Quick one — could you say that again in a few words, mate?";
}

// -------- ElevenLabs TTS
async function tts(text){
  try{
    const resp = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`,
      {
        text,
        model_id: "eleven_multilingual_v2",
        voice_settings: {
          stability: 0.22,          // slightly steadier, still lively
          similarity_boost: 0.92,
          style: 0.55,
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

// -------- tiny per-call audio cache
const audio = new Map(); // sid -> Buffer
app.get("/tts/:sid", (req, res) => {
  const buf = audio.get(req.params.sid);
  if(!buf) return res.status(404).send("No audio");
  res.set("Content-Type","audio/mpeg");
  res.send(buf);
});

// -------- Twilio webhook
app.post("/voice", async (req, res) => {
  const sid        = req.body.CallSid || "no_sid";
  const speech     = (req.body.SpeechResult || req.body.TranscriptionText || "").trim();
  const confidence = parseFloat(req.body.Confidence || "0");
  const isNew      = !sessions.has(sid);

  let bot;
  if (isNew){
    bot = await askOpenAI(sid, "", true);
  } else {
    if (!speech || (isFinite(confidence) && confidence < 0.45)){
      const s = sess(sid);
      s.emptyCount++;
      bot = s.emptyCount === 1
        ? "Sorry, that clipped on my end. One short line?"
        : "Still choppy. Give me the short version, mate.";
    } else {
      pushUser(sid, speech);
      bot = await askOpenAI(sid, speech, false);
    }
  }

  const spoken = humanize(bot);
  pushBot(sid, spoken);

  const mp3 = await tts(spoken);
  audio.set(sid, mp3);

  const url = baseUrl(req);
  const ttsUrl = `${url}/tts/${encodeURIComponent(sid)}`;
  const gatherUrl = `${url}/voice`;
  const language = `language="en-AU"`;
  const hintsAttr = STT_HINTS ? ` hints="${xmlEsc(STT_HINTS)}"` : "";

  // *** FAST GATHER: short timeouts to avoid dead air ***
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${xmlEsc(ttsUrl)}</Play>
  <Gather input="speech" ${language} enhanced="true"${hintsAttr}
          timeout="1" speechTimeout="0.6"
          profanityFilter="false"
          action="${xmlEsc(gatherUrl)}" method="POST" />
</Response>`;
  res.type("text/xml").send(twiml);
});

// -------- start
app.listen(PORT, () => console.log(`Sammy v5 FAST listening on ${PORT}`));
