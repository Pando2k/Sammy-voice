// server.js — Sammy v4 ULTRA-INTERACTIVE (Playful + Cheeky)
// Twilio <Gather> (barge-in)  ⇄  OpenAI short-turn brain  ⇄  ElevenLabs TTS (chunked)
// Goals: instant feel, short turns, playful Aussie rhythm, zero awkward pauses.

const express = require("express");
const dotenv  = require("dotenv");
const axios   = require("axios");
const { v4: uuidv4 } = require("uuid");

dotenv.config();

const PORT               = process.env.PORT || 10000;
const OPENAI_API_KEY     = process.env.OPENAI_API_KEY || "";
const ELEVEN_API_KEY     = process.env.ELEVENLABS_API_KEY || "";
const ELEVEN_VOICE_ID    = process.env.ELEVENLABS_VOICE_ID || "";
const TWILIO_SPEECH_MODEL= process.env.TWILIO_SPEECH_MODEL || "mmm"; // faster STT
const STT_HINTS          = (process.env.STT_HINTS || "").trim();
const QUIRKS_LEVEL       = Math.max(0, Math.min(3, parseInt(process.env.QUIRKS_LEVEL || "2", 10))); // 0..3

if (!OPENAI_API_KEY)  console.warn("⚠️ Missing OPENAI_API_KEY");
if (!ELEVEN_API_KEY)  console.warn("⚠️ Missing ELEVENLABS_API_KEY");
if (!ELEVEN_VOICE_ID) console.warn("⚠️ Missing ELEVENLABS_VOICE_ID");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// -------------------------- tiny utils --------------------------
function xmlEsc(s=""){return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}
function baseUrl(req){const proto=req.headers["x-forwarded-proto"]||req.protocol||"https";return `${proto}://${req.headers["host"]}`;}
function pick(a){return a[Math.floor(Math.random()*a.length)];}

// -------------------------- session store --------------------------
/*
sessions[CallSid] = {
  history: [{role,content}],   // short rolling context
  turns:   number               // to avoid monologues
}
*/
const sessions = new Map();
function sess(id){ let s=sessions.get(id); if(!s){ s={history:[],turns:0}; sessions.set(id,s);} return s; }
function pushUser(id,t){const s=sess(id); s.history.push({role:"user",content:t}); if(s.history.length>10) s.history=s.history.slice(-10);}
function pushBot (id,t){const s=sess(id); s.history.push({role:"assistant",content:t}); if(s.history.length>10) s.history=s.history.slice(-10); s.turns++;}

// -------------------------- personality (Playful + Cheeky) --------------------------
const SYSTEM_PROMPT = `
You are **Sammy**, a lifelike young Australian woman from Perth.
Style: playful, cheeky, warm, quick on your feet. Human timing. Short turns.

Rules:
- Speak like a real Aussie: casual, upbeat, helpful. Sprinkle: “no worries”, “too easy”, “righto”, “yeah mate” — only when natural.
- Keep replies very short: **1–2 sentences**, ~8–18 words. No long monologues.
- If the caller sounds stressed, soften and slow slightly; if excited, match lightly.
- Invite them back with a soft tag: “yeah?”, “sound good?”, “keen?”, but not every line.
- **Never** output stage directions or brackets. Only the words you’ll say aloud.
- If you need details, ask **one** crisp follow-up question.

Boundaries:
- Avoid medical/legal/financial decisions. Stay kind, safe, and respectful.
`.trim();

// -------------------------- humanizer (ultra-interactive, playful) --------------------------
const OPENERS  = ["yeah,", "mm,", "right,", "hey,", "look,"];
const TAILS    = ["no worries.", "too easy.", "all good.", "sound good?"];
const FILLERS  = ["mm", "yeah", "right", "okay", "ah"];

function humanizePlayful(text){
  if(!text) return text;

  // 1) trim and micro-cap length (never drone)
  let t = text.trim().replace(/\s+/g," ");
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
  t = keep.join(" ");

  // 2) playful spice without slowing TTS
  if (QUIRKS_LEVEL >= 1) {
    if (Math.random() < 0.25) t = `${pick(OPENERS)} ${t}`;
    if (Math.random() < 0.20) t = t.replace(", ", " — "); // tiny micro-pause
  }
  if (QUIRKS_LEVEL >= 2) {
    if (Math.random() < 0.25) t += " " + pick(TAILS);
    if (Math.random() < 0.18) t = t.replace(/\b(and|so)\b/i, "… and");
  }
  if (QUIRKS_LEVEL >= 3) {
    if (Math.random() < 0.2) t = `${pick(FILLERS)}, ${t}`;
  }

  return t.replace(/\s([?.!])/g,"$1").trim();
}

// split into fast-first + remainder to start speaking ASAP
function splitForSpeed(text){
  const parts = text.split(/(?<=[.!?])\s+/);
  const first = parts.shift() || text;
  const rest  = parts.join(" ");
  return [first, rest];
}

// -------------------------- OpenAI (short-turn brain) --------------------------
async function askBrain(history, userText){
  const messages = [{ role:"system", content: SYSTEM_PROMPT }, ...history, { role:"user", content:userText }];
  try{
    const r = await axios.post("https://api.openai.com/v1/chat/completions", {
      model: "gpt-4o-mini",
      temperature: 0.8,
      max_tokens: 120,
      messages
    }, { headers:{ Authorization:`Bearer ${OPENAI_API_KEY}` }, timeout: 20000 });

    const out = (r.data.choices?.[0]?.message?.content || "").trim();
    return humanizePlayful(out);
  }catch(e){
    console.error("OpenAI error:", e.response?.data || e.message);
    return "Ah I glitched for a sec — give me that again, yeah?";
  }
}

// -------------------------- ElevenLabs TTS (expressive, not monotone) --------------------------
async function tts(text){
  try{
    const r = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`,
      {
        text,
        model_id: "eleven_multilingual_v2",
        voice_settings: {
          stability: 0.15,          // expressive and lively
          similarity_boost: 0.92,
          style: 0.7,               // playful edge
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

// -------------------------- audio cache (per-chunk) --------------------------
const audioStore = new Map(); // id -> Buffer
app.get("/a/:id", (req, res) => {
  const buf = audioStore.get(req.params.id);
  if (!buf) return res.status(404).send("Not found");
  res.set("Content-Type","audio/mpeg");
  res.send(buf);
});

// -------------------------- landing / health --------------------------
app.get("/", (_req, res) => res.type("text/plain").send("✅ Sammy v4 Ultra-Interactive is running. Twilio uses POST /voice"));
app.get("/health", (_req, res) => res.json({ok:true, service:"sammy-v4", time:new Date().toISOString()}));
app.get("/voice", (_req, res) => res.status(405).type("text/plain").send("Use POST /voice"));

// -------------------------- CALL ENTRY --------------------------
app.post("/voice", async (req, res) => {
  const callSid = req.body.CallSid || `local-${uuidv4()}`;
  const s = sess(callSid);
  const base = baseUrl(req);

  // lively, short greeting (immediate)
  const greeting = "Heya, Sammy here—what d’you need sorted?";
  const gBuf = await tts(greeting);
  const gId  = uuidv4(); if (gBuf) audioStore.set(gId, gBuf);

  const hints = STT_HINTS ? `hints="${xmlEsc(STT_HINTS)}"` : "";

  // barge-in enabled, short timeouts to kill dead air
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" bargeIn="true" enhanced="true"
          speechModel="${xmlEsc(TWILIO_SPEECH_MODEL)}"
          language="en-AU" timeout="1" speechTimeout="0.6"
          action="/gather" method="POST" ${hints}>
    <Play>${xmlEsc(base)}/a/${gId}</Play>
  </Gather>
  <Redirect method="POST">/voice</Redirect>
</Response>`;
  res.type("text/xml").send(twiml);
});

// -------------------------- TURN HANDLER --------------------------
app.post("/gather", async (req, res) => {
  const callSid = req.body.CallSid || `local-${uuidv4()}`;
  const base    = baseUrl(req);
  const s       = sess(callSid);

  const speech  = (req.body.SpeechResult || "").trim();
  const confVal = parseFloat(req.body.Confidence || "0");
  const lowConf = isFinite(confVal) && confVal > 0 && confVal < 0.45;

  let reply;

  if (!speech || lowConf){
    // graceful, playful retries (no spammy apologies)
    reply = !speech
      ? "Missed that—short version?"
      : "Bit choppy—give me the short take?";
  } else {
    pushUser(callSid, speech);

    // brain reply
    const brainOut = await askBrain(s.history, speech);

    // chunk for instant start
    const [first, rest] = splitForSpeed(brainOut);

    // FIRST CHUNK
    const a1 = await tts(first);
    const id1 = uuidv4(); if (a1) audioStore.set(id1, a1);

    // OPTIONAL SECOND CHUNK (very short)
    let second = "";
    if (rest && rest.split(" ").length > 3) {
      const a2 = await tts(rest);
      if (a2){
        const id2 = uuidv4();
        audioStore.set(id2, a2);
        second = `<Play>${xmlEsc(base)}/a/${id2}</Play>`;
      }
    }

    // record full bot text
    pushBot(callSid, brainOut);

    const hints = STT_HINTS ? `hints="${xmlEsc(STT_HINTS)}"` : "";

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" bargeIn="true" enhanced="true"
          speechModel="${xmlEsc(TWILIO_SPEECH_MODEL)}"
          language="en-AU" timeout="1" speechTimeout="0.6"
          action="/gather" method="POST" ${hints}>
    <Play>${xmlEsc(base)}/a/${id1}</Play>
    ${second}
  </Gather>
  <Redirect method="POST">/voice</Redirect>
</Response>`;
    return res.type("text/xml").send(twiml);
  }

  // Fallback path (no/low speech)
  const a = await tts(humanizePlayful(reply));
  const id = uuidv4(); if (a) audioStore.set(id, a);

  const hints = STT_HINTS ? `hints="${xmlEsc(STT_HINTS)}"` : "";

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" bargeIn="true" enhanced="true"
          speechModel="${xmlEsc(TWILIO_SPEECH_MODEL)}"
          language="en-AU" timeout="1" speechTimeout="0.6"
          action="/gather" method="POST" ${hints}>
    <Play>${xmlEsc(base)}/a/${id}</Play>
  </Gather>
  <Redirect method="POST">/voice</Redirect>
</Response>`;
  res.type("text/xml").send(twiml);
});

// -------------------------- start --------------------------
app.listen(PORT, () => {
  console.log(`Sammy v4 Ultra-Interactive listening on ${PORT}`);
});
