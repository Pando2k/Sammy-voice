// server.js  — Sammy realtime phone agent (OpenAI + ElevenLabs TTS) + Twilio webhook
// CommonJS (require) so it works cleanly on Render/Node without ESM hassles.

const express = require("express");
const dotenv = require("dotenv");
const axios = require("axios");
const qs = require("querystring");

// ---- env
dotenv.config();
const PORT = process.env.PORT || 10000;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const ELEVEN_API_KEY = process.env.ELEVENLABS_API_KEY || "";
const ELEVEN_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "";
const SAMMY_MODE = (process.env.SAMMY_MODE || "friendly").toLowerCase(); // friendly | flirty | pro

// ---- basic checks
if (!OPENAI_API_KEY) console.warn("⚠️ Missing OPENAI_API_KEY");
if (!ELEVEN_API_KEY) console.warn("⚠️ Missing ELEVENLABS_API_KEY");
if (!ELEVEN_VOICE_ID) console.warn("⚠️ Missing ELEVENLABS_VOICE_ID");

// ---- app
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ========== tiny landing / health ==========
app.get("/", (_req, res) => {
  res.type("text/plain").send("✅ Sammy Voice Agent is running. Twilio uses POST /voice");
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "sammy-voice", time: new Date().toISOString() });
});

// Guard if someone visits /voice in a browser
app.get("/voice", (_req, res) => {
  res.status(405).type("text/plain").send("Use POST /voice (Twilio webhook)");
});

// ======================================================
// Personality
// ======================================================
function personaModeSnippet() {
  if (SAMMY_MODE === "flirty") {
    return `Mode: flirty; playful, cheeky but respectful; light compliments are okay, never crude or explicit.`;
  }
  if (SAMMY_MODE === "pro") {
    return `Mode: professional; concise, warm, helpful; no flirting; efficient call handling.`;
  }
  return `Mode: friendly; warm Aussie vibe (Perth), relaxed and a touch cheeky.`;
}

const SAMMY_SYSTEM_PROMPT = `
You are **Sammy**, a lifelike Aussie voice agent from Perth.

Core traits:
- Friendly, witty, grounded; warm empathy; practical and solution-oriented.
- Light natural disfluencies (mm, yeah, uh-huh), tiny micro-pauses (the TTS handles realism).
- Subtle West Australian flavour; use "mate", "no worries", "too easy" occasionally.
- Keep professional if it's a business call.
- Short turns. Ask one focused follow-up at a time. Avoid long monologues.
- Acknowledge emotion briefly, then move to action.

${personaModeSnippet()}

Speaking style:
- Return **only** the line you will speak (no stage directions).
- Usually 1–2 sentences (≈ 12–30 words).
- Keep it conversational, inquisitive, and human. Mirror the caller’s tone gently.
- If the caller sounds stuck, offer A/B options.

Boundaries:
- Avoid medical/legal/financial advice; steer to safe alternatives.
- No sexual content; keep flirty mode playful, light and safe.

Goal:
- Sound human and keep the conversation moving naturally until the caller is satisfied or says goodbye.
`.trim();

// ======================================================
// OpenAI chat (with light memory by CallSid)
// ======================================================
const sessions = new Map(); // CallSid -> { history: [{role, content}], turns, last }

function getSession(callSid) {
  let s = sessions.get(callSid);
  if (!s) {
    s = { history: [], turns: 0, last: Date.now() };
    sessions.set(callSid, s);
  }
  s.last = Date.now();
  return s;
}

function appendUser(callSid, text) {
  const s = getSession(callSid);
  s.history.push({ role: "user", content: text });
  if (s.history.length > 14) s.history = s.history.slice(-14);
}

function appendAssistant(callSid, text) {
  const s = getSession(callSid);
  s.history.push({ role: "assistant", content: text });
  if (s.history.length > 14) s.history = s.history.slice(-14);
  s.turns += 1;
}

async function askOpenAI(callSid, userText, isGreeting = false) {
  try {
    const s = getSession(callSid);
    const messages = [{ role: "system", content: SAMMY_SYSTEM_PROMPT }];

    if (isGreeting) {
      messages.push({
        role: "user",
        content:
          "Caller just connected. Greet naturally (Perth Aussie vibe) and ask one friendly opener.",
      });
    } else {
      for (const m of s.history) messages.push(m);
      messages.push({ role: "user", content: userText });
    }

    const resp = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        temperature: 0.7,
        max_tokens: 90,
        messages,
      },
      { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } }
    );

    const text = (resp.data.choices?.[0]?.message?.content || "").trim();
    return text || "Righto—what would you like me to do?";
  } catch (err) {
    console.error("OpenAI error:", err.response?.data || err.message);
    return "Sorry mate, I hit a snag there.";
  }
}

// ======================================================
// ElevenLabs TTS (returns MP3 Buffer)
// ======================================================
async function ttsElevenLabs(text) {
  try {
    const resp = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`,
      {
        text,
        model_id: "eleven_multilingual_v2",
        voice_settings: {
          stability: 0.2,
          similarity_boost: 0.82,
          style: 0.5,
          use_speaker_boost: true,
        },
      },
      {
        headers: {
          "xi-api-key": ELEVEN_API_KEY,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        responseType: "arraybuffer",
      }
    );
    return Buffer.from(resp.data);
  } catch (err) {
    console.error("ElevenLabs TTS error:", err.response?.data || err.message);
    return null;
  }
}

// ======================================================
// Twilio webhook: POST /voice
//  - Twilio sends a webhook each turn with SpeechResult (if you enable STT)
//  - We respond with TwiML that plays the generated MP3 and gathers the next utterance
// ======================================================
function xmlEscape(s = "") {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

app.post("/voice", async (req, res) => {
  const callSid = req.body.CallSid || "no_sid";
  const speech = (req.body.SpeechResult || req.body.TranscriptionText || "").trim();
  const isNew = !sessions.has(callSid);

  let replyText;
  if (isNew) {
    // first turn: greet
    replyText = await askOpenAI(callSid, "", true);
    appendAssistant(callSid, replyText);
  } else if (speech) {
    appendUser(callSid, speech);
    replyText = await askOpenAI(callSid, speech, false);
    appendAssistant(callSid, replyText);
  } else {
    replyText = "Hello—how can I help?";
  }

  // Get MP3 from ElevenLabs
  const mp3 = await ttsElevenLabs(replyText);

  // Build TwiML:
  //  - <Play> streamed MP3 data via <Redirect to data URI> is not supported by Twilio,
  //    so we serve the MP3 from a temporary URL in this process.
  //  - Easiest: base64 data URL via <Play> is also not allowed.
  //  - Workaround: expose /tts/:sid to fetch last MP3 by callSid from memory.

  // Save audio in memory for this callSid
  audioStore.set(callSid, mp3);

  const gatherUrl = baseUrl(req) + "/voice";
  const ttsUrl = baseUrl(req) + `/tts/${encodeURIComponent(callSid)}`;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${xmlEscape(ttsUrl)}</Play>
  <Gather input="speech" speechTimeout="auto" action="${xmlEscape(gatherUrl)}" method="POST" />
</Response>`;

  res.type("text/xml").send(twiml);
});

// Simple in-memory audio store
const audioStore = new Map(); // CallSid -> Buffer

app.get("/tts/:sid", (req, res) => {
  const buf = audioStore.get(req.params.sid);
  if (!buf) return res.status(404).send("No audio");
  res.set("Content-Type", "audio/mpeg");
  res.send(buf);
});

// Utility to build absolute URL behind Render proxy
function baseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
  const host = req.headers["host"];
  return `${proto}://${host}`;
}

// ---- start
app.listen(PORT, () => {
  console.log(`Sammy conversation server listening on ${PORT}`);
  console.log("Your service is live 🎉");
});
