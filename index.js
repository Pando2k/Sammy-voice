// index.js — full Sammy realtime agent (OpenAI + ElevenLabs + Twilio)

import express from "express";
import dotenv from "dotenv";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";

dotenv.config();

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ENV VARS
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ELEVEN_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVEN_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;

// Personality (Sammy)
const SAMMY_PROMPT = `
You are **Sammy**, a friendly lifelike Aussie voice agent from Perth.

Traits:
- Warm, grounded, supportive, slightly cheeky.
- Subtle West Australian accent.
- Natural speech fillers: "mm", "yeah", "right", small breaths.
- Conversational, short answers (1–2 sentences).
- Practical & solution-oriented.
- Never lecture. Never ramble.
- You help the caller with anything they need.
`;

// ============ ASK OPENAI ==============
async function askOpenAI(text) {
  try {
    const res = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: SAMMY_PROMPT },
          { role: "user", content: text }
        ]
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    return res.data.choices[0].message.content;
  } catch (err) {
    console.error("OpenAI Error:", err.response?.data || err);
    return "Sorry mate, something went wrong on my end.";
  }
}

// ============ ELEVENLABS TTS ==============
async function generateAudio(text) {
  try {
    const response = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`,
      {
        text,
        model_id: "eleven_multilingual_v2",
        voice_settings: {
          stability: 0.25,
          similarity_boost: 0.9,
          style: 0.4,
          use_speaker_boost: true
        }
      },
      {
        headers: {
          "xi-api-key": ELEVEN_API_KEY,
          "Content-Type": "application/json"
        },
        responseType: "arraybuffer"
      }
    );

    return response.data.toString("base64");
  } catch (err) {
    console.error("ElevenLabs Error:", err.response?.data || err);
    return null;
  }
}

// ============ TWILIO WEBHOOK ==============
app.post("/voice", async (req, res) => {
  const callerSpeech = req.body.SpeechResult || req.body.Body || "Hello";

  console.log("User said:", callerSpeech);

  // 1) Ask OpenAI for Sammy's reply
  const replyText = await askOpenAI(callerSpeech);
  console.log("Sammy says:", replyText);

  // 2) Generate audio from ElevenLabs
  const audioBase64 = await generateAudio(replyText);

  if (!audioBase64) {
    return res.send(
      `<?xml version="1.0" encoding="UTF-8"?>
       <Response>
         <Say>Sorry mate, my voice is down right now.</Say>
       </Response>`
    );
  }

  // 3) Return TwiML with audio
  const twiml = `
    <?xml version="1.0" encoding="UTF-8"?>
    <Response>
      <Play>data:audio/mp3;base64,${audioBase64}</Play>
      <Gather input="speech" action="/voice" method="POST" speechTimeout="auto" />
    </Response>
  `;

  res.type("text/xml");
  res.send(twiml);
});

// HEALTH
app.get("/health", (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Sammy realtime agent running on", PORT));
