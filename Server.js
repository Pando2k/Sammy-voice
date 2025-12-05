// server.js  — Sammy v3 (Realistic + Low-Latency, chunked replies)
// ---------------------------------------------------------------
// What this version does better:
// - Short, fast turns (no long monologues)
// - Chunked reply: speak first sentence ASAP, then continue
// - Human disfluencies (light "mm", "yeah", soft laughs) injected tastefully
// - Natural Aussie tone + guardrails
// - Interrupt-friendly Twilio <Gather> barge-in flow
//
// Env vars used (Render -> Environment Variables):
// OPENAI_API_KEY
// ELEVENLABS_API_KEY
// ELEVENLABS_VOICE_ID
// SAMMY_MODE              (flirty | pro)           [optional]
// QUIRKS_LEVEL            (0..3)                   [optional, default 2]
// STT_HINTS               (comma separated hints)  [optional]
// GREETING_OVERRIDE       (string)                 [optional]

import express from "express";
import dotenv from "dotenv";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";

dotenv.config();
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ====== ENV ======
const OPENAI_API_KEY    = process.env.OPENAI_API_KEY || "";
const ELEVEN_API_KEY    = process.env.ELEVENLABS_API_KEY || "";
const ELEVEN_VOICE_ID   = process.env.ELEVENLABS_VOICE_ID || "";
const SAMMY_MODE        = (process.env.SAMMY_MODE || "").toLowerCase(); // "", "flirty", "pro"
const QUIRKS_LEVEL      = Math.max(0, Math.min(3, Number(process.env.QUIRKS_LEVEL || 2)));
const STT_HINTS         = (process.env.STT_HINTS || "").trim();
const GREETING_OVERRIDE = (process.env.GREETING_OVERRIDE || "").trim();
const TWILIO_SPEECH_MODEL = process.env.TWILIO_SPEECH_MODEL || "mmm"; // faster STT on Twilio side (documented to them)

// ====== in-memory audio store ======
const audioStore = new Map(); // id -> Buffer

// ====== tiny helpers ======
const xmlEscape = (s="") =>
  s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");

const baseUrl = (req) => {
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
  return `${proto}://${req.get("host")}`;
};

// ====== Personality v3 ======
// “Human realism” prompt with Aussie warmth and short turns.
function systemPersona() {
  const modeLine = SAMMY_MODE === "flirty"
    ? "Flirt lightly when invited, keep it classy and kind."
    : (SAMMY_MODE === "pro"
        ? "Professional, calm, and reassuring when needed."
        : "Friendly Aussie vibe.");

  return `
You are **Sammy**, a lifelike Aussie voice agent from Perth.
Core style:
- Warm, grounded; practical; friendly humour.
- Very short turns (1–2 sentences). Offer to continue.
- Invite the caller back with a soft tag (“yeah?” “sound good?”).
- Respect interruptions; if user starts speaking, stop and listen.
- No stage directions in your text.

Speech feel:
- Subtle disfluencies that *sound natural*: “mm”, “yeah”, soft breath, tiny chuckles.
- Use them sparingly (never every sentence). Keep them short.
- Aussie rhythm: “mate” sometimes, “no worries”, “righto”, “too easy”.

Boundaries:
- Avoid medical/legal/financial decisions; steer to safe help.
- No profanity or sexual content unless the user explicitly asks and it's harmless. Keep it classy.

${modeLine}
Return only what you *will say aloud* (no brackets, no scene text).`;
}

// inject tiny human-like quirks without overdoing it
function sprinkleQuirks(text) {
  if (QUIRKS_LEVEL <= 0) return text;

  const tiny = ["mm", "yeah", "uh", "right", "okay"];
  const soft = ["(soft laugh)", "(small breath)"];
  // We don't keep the parentheses in final speech; we transform to punctuation later.

  let out = text;

  // Small chance to add a 2-word tag at start
  if (Math.random() < 0.25 * QUIRKS_LEVEL) {
    const tag = tiny[Math.floor(Math.random() * tiny.length)];
    out = `${tag}, ${out}`;
  }

  // Occasionally drop a soft cue mid-sentence
  if (Math.random() < 0.20 * QUIRKS_LEVEL) {
    const cue = tiny[Math.floor(Math.random() * tiny.length)];
    out = out.replace(/, /, `, ${cue}, `);
  }

  // Rare soft effects -> convert to subtle punctuation later
  if (Math.random() < 0.10 * QUIRKS_LEVEL) {
    out += " (small breath)";
  }

  // Translate soft effects to punctuation ElevenLabs performs well with
  out = out
    .replace(/\(small breath\)/gi, "…")
    .replace(/\(soft laugh\)/gi, "…")
    .replace(/\s{2,}/g, " ")
    .trim();

  // keep it short
  if (out.split(" ").length > 36) {
    out = out.split(". ").slice(0, 2).join(". ");
  }
  return out;
}

// split reply into a fast first sentence + remainder (for low-latency)
function splitForTurn(text) {
  const parts = text.split(/(?<=[.!?])\s+/);
  const first = parts.shift() || text;
  const rest  = parts.join(" ");
  return [first, rest];
}

// ====== OpenAI ======
async function askOpenAI(history, userText) {
  const messages = [
    { role: "system", content: systemPersona() },
    ...history.slice(-8),
    { role: "user", content: userText }
  ];

  try {
    const r = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        temperature: 0.8,
        max_tokens: 160,
        messages
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        timeout: 20000
      }
    );
    const raw = r.data.choices?.[0]?.message?.content?.trim() || "Sorry, something went odd on my end.";
    return sprinkleQuirks(raw);
  } catch (err) {
    console.error("OpenAI err:", err.response?.data || err.message);
    return "Ah, sorry—little traffic jam on my end. Mind saying that again?";
  }
}

// ====== ElevenLabs TTS ======
async function makeTTS(text) {
  // Keep TTS snappy by using expressive but stable-ish settings
  const body = {
    text,
    model_id: "eleven_multilingual_v2",
    voice_settings: {
      stability: 0.15,
      similarity_boost: 0.92,
      style: SAMMY_MODE === "pro" ? 0.35 : 0.65,
      use_speaker_boost: true
    }
  };

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`;
  try {
    const r = await axios.post(url, body, {
      headers: {
        "xi-api-key": ELEVEN_API_KEY,
        "Content-Type": "application/json",
        Accept: "audio/mpeg"
      },
      responseType: "arraybuffer",
      timeout: 25000
    });
    return Buffer.from(r.data);
  } catch (err) {
    console.error("ElevenLabs err:", err.response?.data || err.message);
    return null;
  }
}

// ====== Session store ======
const sessions = new Map(); // callSid -> { history: [...], last:Date }

function getSession(callSid) {
  let s = sessions.get(callSid);
  if (!s) {
    s = { history: [], last: Date.now() };
    sessions.set(callSid, s);
  }
  s.last = Date.now();
  return s;
}

// ====== Routes ======

// landing + health
app.get("/", (_req, res) => {
  res.type("text/plain").send("✅ Sammy Voice Agent v3 is running. Twilio uses POST /voice");
});
app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "sammy-voice-v3", time: new Date().toISOString() });
});

// serve mp3 from memory
app.get("/a/:id", (req, res) => {
  const buf = audioStore.get(req.params.id);
  if (!buf) return res.status(404).send("Not found");
  res.set("Content-Type", "audio/mpeg");
  res.send(buf);
});

// Main entry from Twilio
app.post("/voice", async (req, res) => {
  const callSid = req.body.CallSid || `local-${uuidv4()}`;
  const base = baseUrl(req);
  const s = getSession(callSid);

  const greet = GREETING_OVERRIDE ||
    (SAMMY_MODE === "pro"
      ? "G'day, Sammy here. How can I help you today?"
      : "Heya, Sammy here. How can I help, mate?");

  // Make a short greeting mp3 immediately for clean barge-in
  const gAudio = await makeTTS(greet);
  const id = uuidv4();
  if (gAudio) audioStore.set(id, gAudio);

  const hints = STT_HINTS ? `hints="${xmlEscape(STT_HINTS)}"` : "";

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" enhanced="true" speechModel="${xmlEscape(TWILIO_SPEECH_MODEL)}"
          language="en-AU" speechTimeout="auto" action="/gather" method="POST"
          bargeIn="true" ${hints}>
    <Play>${xmlEscape(base)}/a/${id}</Play>
  </Gather>
  <!-- If they say nothing, loop back once -->
  <Redirect method="POST">/voice</Redirect>
</Response>`;

  res.type("text/xml").send(twiml);
});

// After user speaks
app.post("/gather", async (req, res) => {
  const callSid = req.body.CallSid || `local-${uuidv4()}`;
  const userText = (req.body.SpeechResult || "").trim();
  const base = baseUrl(req);
  const s = getSession(callSid);

  if (!userText) {
    const retry = await makeTTS("Sorry, I didn’t catch that—could you say it again, yeah?");
    const rid = uuidv4(); if (retry) audioStore.set(rid, retry);
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" enhanced="true" speechModel="${xmlEscape(TWILIO_SPEECH_MODEL)}"
          language="en-AU" speechTimeout="auto" action="/gather" method="POST"
          bargeIn="true">
    <Play>${xmlEscape(base)}/a/${rid}</Play>
  </Gather>
  <Redirect method="POST">/voice</Redirect>
</Response>`;
    return res.type("text/xml").send(twiml);
  }

  // add to history
  s.history.push({ role: "user", content: userText });

  // get a lifelike short answer
  const full = await askOpenAI(s.history, userText);
  // split into first + remainder to reduce perceived latency
  const [first, rest] = splitForTurn(full);

  // first chunk TTS
  const a1 = await makeTTS(first);
  const id1 = uuidv4(); if (a1) audioStore.set(id1, a1);

  // optionally prep second chunk (very short)
  let secondUrl = "";
  if (rest && rest.split(" ").length > 3) {
    const a2 = await makeTTS(rest);
    if (a2) {
      const id2 = uuidv4();
      audioStore.set(id2, a2);
      secondUrl = `<Play>${xmlEscape(base)}/a/${id2}</Play>`;
    }
  }

  // add assistant text to history (full)
  s.history.push({ role: "assistant", content: full });

  // keep convo moving; immediately listen again with barge-in
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" enhanced="true" speechModel="${xmlEscape(TWILIO_SPEECH_MODEL)}"
          language="en-AU" speechTimeout="auto" action="/gather" method="POST"
          bargeIn="true">
    <Play>${xmlEscape(base)}/a/${id1}</Play>
    ${secondUrl}
  </Gather>
  <Redirect method="POST">/voice</Redirect>
</Response>`;

  res.type("text/xml").send(twiml);
});

// start
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("Sammy v3 listening on", PORT);
});
