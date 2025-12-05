import express from "express";
import dotenv from "dotenv";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";
import { sammyPersonality } from "./sammy-personality.js";

dotenv.config();
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ===== Env =====
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ELEVEN_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVEN_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;

// ===== In-memory audio store =====
const audioStore = new Map(); // id -> Buffer (mp3)

// ===== Helpers =====
function baseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
  return `${proto}://${req.get("host")}`;
}
const xmlEscape = (s = "") =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ===== OpenAI (chat) =====
async function askOpenAI(userInput) {
  try {
    const resp = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: sammyPersonality },
          { role: "user", content: userInput || "Say a short friendly greeting." }
        ],
        temperature: 0.6,
        max_tokens: 140
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        timeout: 20000
      }
    );
    return resp?.data?.choices?.[0]?.message?.content?.trim() || "G'day, how's it going?";
  } catch (err) {
    console.error("OpenAI error:", err.response?.data || err.message);
    return "Sorry mate, something went wrong on my end.";
  }
}

// ===== ElevenLabs (TTS) -> mp3 Buffer =====
async function ttsElevenLabs(text) {
  if (!ELEVEN_API_KEY || !ELEVEN_VOICE_ID) return null;
  try {
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`;
    const resp = await axios.post(
      url,
      {
        text,
        model_id: "eleven_multilingual_v2",
        voice_settings: {
          stability: 0.2,
          similarity_boost: 0.85,
          style: 0.45,
          use_speaker_boost: true
        }
      },
      {
        headers: {
          "xi-api-key": ELEVEN_API_KEY,
          Accept: "audio/mpeg",
          "Content-Type": "application/json"
        },
        responseType: "arraybuffer",
        timeout: 30000
      }
    );
    return Buffer.from(resp.data);
  } catch (err) {
    console.error("ElevenLabs error:", err.response?.data || err.message);
    return null;
  }
}

// ===== Small GET routes (health + landing + guard) =====
app.get("/", (_req, res) => {
  res.type("text/plain").send("✅ Sammy Voice Agent is running. Twilio uses POST /voice");
});
app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "sammy-voice", time: new Date().toISOString() });
});
app.get("/voice", (_req, res) => {
  res.type("text/plain").status(405).send("Use POST /voice (Twilio webhook)");
});

// ===== Serve generated audio to Twilio <Play> =====
app.get("/audio/:id", (req, res) => {
  const buf = audioStore.get(req.params.id);
  if (!buf) return res.status(404).type("text/plain").send("Audio not found");
  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Cache-Control", "public, max-age=300");
  res.send(buf);
});

// ===== Build TwiML that PROMPTS + GATHERS =====
function twimlGatherPlayOrSay(req, text, opts = {}) {
  const {
    playUrl,                 // if provided, <Play> this
    action = "/voice",       // where Twilio POSTs speech
    method = "POST",
    language = "en-AU",
    input = "speech",
    speechTimeout = "auto",
    profanityFilter = "false",
    hints = ""               // speech hints (comma-delimited)
  } = opts;

  const safeSay = xmlEscape(text);

  // <Gather> can nest <Play> or <Say> as a prompt
  const prompt = playUrl
    ? `<Play>${playUrl}</Play>`
    : `<Say language="${language}" voice="Polly.Nicole-Neural">${safeSay}</Say>`;

  // After Gather, redirect back to /voice to keep the line open if silence
  const twiml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response>` +
      `<Gather input="${input}" language="${language}" action="${action}" method="${method}" speechTimeout="${speechTimeout}" profanityFilter="${profanityFilter}" hints="${xmlEscape(hints)}">` +
        prompt +
      `</Gather>` +
      `<Redirect method="POST">${action}</Redirect>` +
    `</Response>`;

  return twiml;
}

// ===== Twilio webhook (POST /voice) =====
app.post("/voice", async (req, res) => {
  // If Twilio sends speech, it will be here:
  const speech = (req.body.SpeechResult || req.body.TranscriptionText || "").trim();
  const hasSpeech = Boolean(speech);

  // First turn: greet briefly if there’s no speech yet
  const userInput = hasSpeech ? speech : "Greet the caller briefly and ask how you can help.";

  // Get Sammy's reply
  const reply = await askOpenAI(userInput);

  // Try TTS (preferred)
  let playUrl = null;
  const mp3 = await ttsElevenLabs(reply);
  if (mp3) {
    const id = uuidv4();
    audioStore.set(id, mp3);
    setTimeout(() => audioStore.delete(id), 10 * 60 * 1000);
    playUrl = `${baseUrl(req)}/audio/${id}`;
  }

  // Build Gather TwiML
  const twiml = twimlGatherPlayOrSay(req, reply, {
    playUrl,
    hints: "yes,no,okay,right,book,booking,order,account,email,address,Perth,Australia"
  });

  res.set("Content-Type", "text/xml");
  res.send(twiml);
});

// ===== Start server =====
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Sammy conversation server listening on ${PORT}`);
});
