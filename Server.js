// server.js — Sammy v3 (smoother turn-taking, en-AU STT, anti-loop)
// Twilio <Gather speech> -> OpenAI reply -> ElevenLabs TTS -> <Play> -> next <Gather>

const express = require("express");
const dotenv = require("dotenv");
const axios = require("axios");
const qs = require("querystring");

dotenv.config();

// ---- ENV
const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY     = process.env.OPENAI_API_KEY || "";
const ELEVEN_API_KEY     = process.env.ELEVENLABS_API_KEY || "";
const ELEVEN_VOICE_ID    = process.env.ELEVENLABS_VOICE_ID || "";
const SAMMY_MODE         = (process.env.SAMMY_MODE || "friendly").toLowerCase(); // friendly|flirty|pro
const STT_HINTS          = process.env.SAMMY_HINTS || ""; // optional comma-separated phrases for Twilio STT

if (!OPENAI_API_KEY)  console.warn("⚠️ Missing OPENAI_API_KEY");
if (!ELEVEN_API_KEY)  console.warn("⚠️ Missing ELEVENLABS_API_KEY");
if (!ELEVEN_VOICE_ID) console.warn("⚠️ Missing ELEVENLABS_VOICE_ID");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ====== tiny landing / health ======
app.get("/", (_req, res) => {
  res.type("text/plain").send("✅ Sammy Voice Agent is running. Twilio uses POST /voice");
});
app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "sammy-voice", time: new Date().toISOString() });
});
app.get("/voice", (_req, res) => {
  res.status(405).type("text/plain").send("Use POST /voice (Twilio webhook)");
});

// ====== Personality ======
function personaModeSnippet() {
  if (SAMMY_MODE === "flirty")
    return `Mode: flirty; playful, cheeky but respectful; light compliments ok, never crude.`;
  if (SAMMY_MODE === "pro")
    return `Mode: professional; concise, warm, no flirting; efficient call handling.`;
  return `Mode: friendly; warm Perth Aussie vibe, relaxed and a touch cheeky.`;
}

const SAMMY_SYSTEM = `
You are **Sammy**, a lifelike Aussie voice agent from Perth.

Core traits:
- Friendly, witty, grounded; warm empathy; practical and solution-oriented.
- Use light natural cues (mm, yeah, uh-huh), short answers; let the caller speak.
- Subtle WA flavour: "mate", "no worries", "too easy" sometimes; still professional.

${personaModeSnippet()}

Speaking style:
- **Return only what you’ll speak** (no brackets/stage directions).
- 1–2 sentences, ~10–25 words. Back-channel briefly if they speak long.
- Ask one, clear follow-up max.

Boundaries:
- No medical/legal/financial advice; avoid sexual content; keep it safe and kind.

Goal:
- Sound human and keep the momentum until the caller is satisfied or says goodbye.
`.trim();

// ====== light memory per CallSid ======
const sessions = new Map(); // callSid -> { history, turns, emptyCount, lastErrorAt }

function getSession(sid) {
  let s = sessions.get(sid);
  if (!s) {
    s = { history: [], turns: 0, emptyCount: 0, lastErrorAt: 0, last: Date.now() };
    sessions.set(sid, s);
  }
  s.last = Date.now();
  return s;
}
function appendUser(sid, text) {
  const s = getSession(sid);
  s.history.push({ role: "user", content: text });
  if (s.history.length > 14) s.history = s.history.slice(-14);
}
function appendAssistant(sid, text) {
  const s = getSession(sid);
  s.history.push({ role: "assistant", content: text });
  if (s.history.length > 14) s.history = s.history.slice(-14);
  s.turns++;
}

// ====== OpenAI chat with small retry/backoff ======
async function askOpenAI(sid, userText, isGreeting=false) {
  const s = getSession(sid);
  const messages = [{ role: "system", content: SAMMY_SYSTEM }];

  if (isGreeting) {
    messages.push({
      role: "user",
      content:
        "Caller just connected. Greet naturally in a Perth Aussie vibe and ask one friendly opener.",
    });
  } else {
    for (const m of s.history) messages.push(m);
    messages.push({ role: "user", content: userText });
  }

  const payload = {
    model: "gpt-4o-mini",
    temperature: 0.7,
    max_tokens: 90,
    messages
  };

  for (let i = 0; i < 3; i++) {
    try {
      const resp = await axios.post("https://api.openai.com/v1/chat/completions", payload, {
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }
      });
      const text = (resp.data.choices?.[0]?.message?.content || "").trim();
      if (text) return text;
    } catch (err) {
      const code = err.response?.data?.error?.code || err.response?.status || err.code;
      console.error("OpenAI error:", code, err.response?.data || err.message);
      getSession(sid).lastErrorAt = Date.now();
      // backoff a touch on rate limits
      await new Promise(r => setTimeout(r, 400 + i * 600));
    }
  }
  return "Give me a sec… all good now. What were you saying?";
}

// ====== ElevenLabs TTS (MP3 Buffer) ======
async function tts(text) {
  try {
    const r = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`,
      {
        text,
        model_id: "eleven_multilingual_v2",
        voice_settings: {
          stability: 0.2,
          similarity_boost: 0.85,
          style: 0.55,
          use_speaker_boost: true
        }
      },
      {
        headers: {
          "xi-api-key": ELEVEN_API_KEY,
          "Content-Type": "application/json",
          Accept: "audio/mpeg"
        },
        responseType: "arraybuffer"
      }
    );
    return Buffer.from(r.data);
  } catch (e) {
    console.error("ElevenLabs TTS error:", e.response?.data || e.message);
    return null;
  }
}

// In-memory audio per call
const audioStore = new Map(); // sid -> Buffer

// Serve last audio for a call
app.get("/tts/:sid", (req, res) => {
  const buf = audioStore.get(req.params.sid);
  if (!buf) return res.status(404).send("No audio");
  res.set("Content-Type", "audio/mpeg");
  res.send(buf);
});

function xmlEscape(s = "") {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function baseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
  const host  = req.headers["host"];
  return `${proto}://${host}`;
}

// ====== Twilio webhook (POST /voice) ======
app.post("/voice", async (req, res) => {
  const sid        = req.body.CallSid || "no_sid";
  const speech     = (req.body.SpeechResult || req.body.TranscriptionText || "").trim();
  const confidence = parseFloat(req.body.Confidence || "0");
  const isNewCall  = !sessions.has(sid);

  const sess = getSession(sid);

  let replyText;

  if (isNewCall) {
    // First turn: greet
    replyText = await askOpenAI(sid, "", true);
    appendAssistant(sid, replyText);
  } else {
    // Handle STT quality gracefully
    if (!speech) {
      sess.emptyCount++;
    } else if (!isFinite(confidence) || confidence < 0.45) {
      // Twilio may include Confidence; if absent we ignore.
      sess.emptyCount++;
    } else {
      sess.emptyCount = 0;
      appendUser(sid, speech);
      replyText = await askOpenAI(sid, speech, false);
      appendAssistant(sid, replyText);
    }

    if (!replyText) {
      // Choose gentle prompts depending on how many empties in a row
      if (sess.emptyCount === 1) {
        replyText = "Sorry mate — I might’ve missed that. What did you say?";
      } else if (sess.emptyCount === 2) {
        replyText = "I still didn’t catch it. Mind saying that a tad slower?";
      } else {
        replyText = "No worries. A quick yes or no might help — what would you like me to do?";
      }
    }
  }

  // TTS
  const mp3 = await tts(replyText);
  audioStore.set(sid, mp3);

  // TwiML: play response, then gather next turn with generous settings
  const gatherUrl = baseUrl(req) + "/voice";
  const ttsUrl    = baseUrl(req) + `/tts/${encodeURIComponent(sid)}`;

  const languageAttr = `language="en-AU"`; // Aussie English
  const hintsAttr    = STT_HINTS ? ` hints="${xmlEscape(STT_HINTS)}"` : "";

  // timeout: how long Twilio waits for FIRST speech (secs)
  // speechTimeout: how long of silence to stop listening ("auto" or seconds)
  // enhanced: use improved model if available
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${xmlEscape(ttsUrl)}</Play>
  <Gather input="speech" ${languageAttr} enhanced="true"${hintsAttr}
          timeout="8" speechTimeout="auto"
          profanityFilter="false" action="${xmlEscape(gatherUrl)}" method="POST" />
</Response>`;

  res.type("text/xml").send(twiml);
});

// ====== start server ======
app.listen(PORT, () => {
  console.log(`Sammy conversation server listening on ${PORT}`);
  console.log("Your service is live 🎉");
});
