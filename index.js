import express from "express";
import dotenv from "dotenv";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";
import { sammyPersonality } from "./sammy-personality.js";

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// -----------------------------------------------------
// ROOT + HEALTH + GUARD ROUTES
// -----------------------------------------------------

// Root landing page
app.get("/", (_req, res) => {
  res
    .type("text/plain")
    .send("✅ Sammy Voice Agent is running. Twilio uses POST /voice");
});

// Health check
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "sammy-voice",
    time: new Date().toISOString(),
  });
});

// If someone GETs /voice in browser → warn them
app.get("/voice", (_req, res) => {
  res
    .type("text/plain")
    .status(405)
    .send("Use POST /voice (Twilio webhook)");
});

// -----------------------------------------------------
// ENVIRONMENT VARIABLES
// -----------------------------------------------------
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ELEVEN_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVEN_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;

// -----------------------------------------------------
// OPENAI brain (text generation)
// -----------------------------------------------------
async function askOpenAI(userInput) {
  try {
    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: sammyPersonality },
          { role: "user", content: userInput },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    return response.data.choices[0].message.content;
  } catch (err) {
    console.error("OpenAI error →", err.response?.data || err);
    return "Sorry mate, something went wrong on my end.";
  }
}

// -----------------------------------------------------
// ElevenLabs TTS
// -----------------------------------------------------
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

    return response.data;
  } catch (err) {
    console.error("ElevenLabs error →", err.response?.data || err);
    return null;
  }
}

// -----------------------------------------------------
// TWILIO /voice WEBHOOK (main endpoint)
// -----------------------------------------------------
app.post("/voice", async (req, res) => {
  try {
    const callerInput = req.body.SpeechResult || req.body.Body || "";

    console.log("User said:", callerInput);

    const aiReply = await askOpenAI(callerInput);
    console.log("Sammy says:", aiReply);

    const audioBuffer = await generateAudio(aiReply);

    if (!audioBuffer) {
      return res
        .type("text/xml")
        .send(`<Response><Say>Sorry mate, I had trouble speaking.</Say></Response>`);
    }

    const base64Audio = audioBuffer.toString("base64");

    const twiml = `
      <Response>
        <Play>data:audio/mp3;base64,${base64Audio}</Play>
      </Response>
    `;

    res.type("text/xml").send(twiml);
  } catch (err) {
    console.error("Webhook ERROR:", err);
    res
      .status(500)
      .type("text/xml")
      .send(`<Response><Say>Something went wrong, mate.</Say></Response>`);
  }
});

// -----------------------------------------------------
// START SERVER
// -----------------------------------------------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("Sammy realtime agent running on", PORT);
});
