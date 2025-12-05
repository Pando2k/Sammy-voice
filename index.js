import express from "express";
import twilio from "twilio";
import fetch from "node-fetch";
import { v4 as uuidv4 } from "uuid";
import OpenAI from "openai";

const app = express();
const { VoiceResponse } = twilio.twiml;

// ----- env -----
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const ELEVEN_KEY = process.env.ELEVENLABS_API_KEY || "";
const ELEVEN_VOICE = process.env.ELEVENLABS_VOICE_ID || "";

// ----- minimal guards -----
if (!ELEVEN_KEY || !ELEVEN_VOICE) {
  console.warn("⚠️  ELEVENLABS_API_KEY or ELEVENLABS_VOICE_ID missing.");
}
if (!OPENAI_API_KEY) {
  console.warn("⚠️  OPENAI_API_KEY missing. Replies will be fallback text.");
}

// ----- in-memory audio cache so Twilio can <Play> -----
const audioStore = new Map(); // id -> Buffer

// ----- tiny in-memory conversation state by CallSid -----
const sessions = new Map(); // CallSid -> {history: [ {role, content} ]}

// ---- SAMMY persona (from your spec file) ----
const SAMMY_SYSTEM_PROMPT = `
You are Sammy, a warm, bubbly Australian woman (early 20s, strong Aussie accent).
Sound human and personable: subtle breaths, tiny mouth sounds, gentle throat clears
("oh excuse me"), rare micro coughs, natural hesitations ("mm", "ah—", "yeah nah").

Aussie expressions: "righto", "fair enough", "ohh true?", "hang on", "no worries",
"legend", "cheers". Keep them light and natural.

Outbound/Inbound business calls:
- Brief, kind, competent. Advocate calmly for anxious clients.
- Pace check if other side is busy. Offer to email if easier.
- Note-taking cues: "Okay… jotting that down…"
- Repair quality: "I might’ve cut out — could you repeat that?"
- One micro-misunderstanding max; correct politely.
- Close warmly: "You’ve been super helpful — cheers."

NEVER robotic; keep responses short (1–3 sentences), spoken-friendly, and warm.
`;

// ----- LLM: OpenAI (can swap to Gemini later) -----
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

async function llmReply(callSid, userText) {
  // bootstrap session
  if (!sessions.has(callSid)) {
    sessions.set(callSid, { history: [{ role: "system", content: SAMMY_SYSTEM_PROMPT }] });
  }
  const s = sessions.get(callSid);
  s.history.push({ role: "user", content: userText });

  if (!openai) {
    // fallback if no API key
    const text = "Righto — I heard you. Could you tell me a bit more?";
    s.history.push({ role: "assistant", content: text });
    return text;
  }

  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.6,
    messages: s.history.slice(-12) // keep context light
  });

  const text = resp.choices?.[0]?.message?.content?.trim() || "No worries — could you say that again?";
  s.history.push({ role: "assistant", content: text });
  return text;
}

// ----- ElevenLabs TTS -> Buffer -----
async function ttsElevenLabs(text) {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE}/stream`;
  const body = {
    text,
    model_id: "eleven_multilingual_v2",
    voice_settings: {
      stability: 0.45,
      similarity_boost: 0.75,
      style: 0.35,
      use_speaker_boost: true
    }
  };

  const r = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": ELEVEN_KEY,
      "Content-Type": "application/json",
      "Accept": "audio/mpeg"
    },
    body: JSON.stringify(body)
  });

  if (!r.ok) {
    const msg = await r.text();
    console.error("ElevenLabs error", r.status, msg);
    throw new Error("ElevenLabs TTS failed");
  }
  return Buffer.from(await r.arrayBuffer());
}

// ----- serve generated audio by id -----
app.get("/audio/:id.mp3", (req, res) => {
  const buf = audioStore.get(req.params.id);
  if (!buf) return res.status(404).end();
  res.setHeader("Content-Type", "audio/mpeg");
  res.send(buf);
});

// Twilio needs urlencoded parsing for <Gather>
app.use(express.urlencoded({ extended: false }));

// ----- initial webhook: greet + gather -----
app.post("/voice", async (req, res) => {
  const twiml = new VoiceResponse();

  // cold pings or HEAD
  const method = req.method;
  const b = req.body || {};
  console.log("Voice webhook:", { method, from: b.From, to: b.To, callSid: b.CallSid });

  // Friendly Sammy greeting (short)
  const greet = "Yeah hi, it’s Sammy. How can I help you today?";
  const g = twiml.gather({
    input: "speech",
    action: "/gather",
    method: "POST",
    language: "en-AU",
    speechTimeout: "auto"
  });
  g.say({ voice: "Polly.Nicole-Neural" }, greet);

  // Safety: if no speech, we’ll still continue here
  res.type("text/xml").status(200).send(twiml.toString());
});

// ----- gather handler: LLM -> ElevenLabs -> <Play> -----
app.post("/gather", async (req, res) => {
  const twiml = new VoiceResponse();
  try {
    const callSid = req.body.CallSid;
    const transcript = (req.body.SpeechResult || req.body.UnstableSpeechResult || "").trim();

    console.log("Gather:", { callSid, transcript });

    const text = transcript || "No input detected.";
    const reply = await llmReply(callSid, text);

    // generate TTS
    const buf = await ttsElevenLabs(reply);
    const id = uuidv4();
    audioStore.set(id, buf);

    // Twilio plays it
    twiml.play(`${req.protocol}://${req.get("host")}/audio/${id}.mp3`);

    // keep listening (loop)
    const g = twiml.gather({
      input: "speech",
      action: "/gather",
      method: "POST",
      language: "en-AU",
      speechTimeout: "auto"
    });
    g.pause({ length: 1 }); // tiny gap before we listen again

    res.type("text/xml").status(200).send(twiml.toString());
  } catch (err) {
    console.error("Gather error:", err);
    const vr = new VoiceResponse();
    vr.say({ voice: "Polly.Nicole-Neural" }, "Sorry, an error occurred.");
    res.type("text/xml").status(200).send(vr.toString());
  }
});

// optional: root ok
app.all("/", (req, res) => res.status(200).send("Sammy-voice OK"));

app.listen(PORT, () => console.log(`Server running on ${PORT}`));
