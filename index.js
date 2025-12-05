import express from "express";
import dotenv from "dotenv";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// === ENVIRONMENT VARIABLES ===
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ELEVEN_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVEN_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;

// Personality config
import { sammyPersonality } from "./sammy-personality.js";

// --- OpenAI Chat Completion ---
async function askOpenAI(userInput) {
  try {
    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: sammyPersonality },
          { role: "user", content: userInput }
        ]
      },
      {
        headers: {
          "Authorization": `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    return response.data.choices[0].message.content;
  } catch (err) {
    console.error("OpenAI error:", err.response?.data || err);
    return "Sorry mate, something went wrong on my end.";
  }
}

// --- ElevenLabs TTS ---
async function generateAudio(text) {
  try {
    const response = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`,
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
          "Content-Type": "application/json",
          "Accept": "audio/mpeg"
        },
        responseType: "arraybuffer"
      }
    );

    return response.data;
  } catch (err) {
    console.error("ElevenLabs error:", err.response?.data || err);
    return null;
  }
}

// --- Twilio Webhook ---
app.post("/voice-webhook", async (req, res) => {
  const userInput = req.body.SpeechResult || req.body.Body || "Hello?";

  console.log("User said:", userInput);

  const reply = await askOpenAI(userInput);
  const audioBuffer = await generateAudio(reply);

  if (!audioBuffer) {
    return res.send(`
      <Response>
        <Say>Something went wrong with the voice system.</Say>
      </Response>
    `);
  }

  const base64Audio = audioBuffer.toString("base64");

  res.send(`
    <Response>
      <Play>data:audio/mp3;base64,${base64Audio}</Play>
    </Response>
  `);
});

// --- Health Check ---
app.get("/", (req, res) => {
  res.send("Sammy voice agent is running.");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
