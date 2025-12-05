// index.js
import express from "express";
import dotenv from "dotenv";
import { SAMMY_SYSTEM_PROMPT } from "./sammy-personality.js";
import OpenAI from "openai";
import fetch from "node-fetch";

dotenv.config();

const app = express();
app.use(express.json());

// Load environment variables
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;

if (!OPENAI_API_KEY || !ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID) {
  console.error("❌ Missing environment variables.");
  process.exit(1);
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ------------------------------
// 🧠 Handle Incoming Twilio Call
// ------------------------------
app.post("/incoming", async (req, res) => {
  try {
    const callerText = req.body.speech || req.body.SpeechResult || "";

    const aiResponse = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: SAMMY_SYSTEM_PROMPT },
        { role: "user", content: callerText }
      ],
      max_tokens: 120,
      temperature: 0.7
    });

    const text = aiResponse.choices[0].message.content;
    console.log("Sammy says:", text);

    // Convert reply to speech via ElevenLabs
    const audioResponse = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "xi-api-key": ELEVENLABS_API_KEY
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_turbo_v2",
        voice_settings: {
          stability: 0.55,
          similarity_boost: 0.8
        }
      })
    });

    const audioBuffer = Buffer.from(await audioResponse.arrayBuffer());
    const base64Audio = audioBuffer.toString("base64");

    res.set("Content-Type", "text/xml");
    return res.send(`
      <Response>
        <Play>data:audio/mpeg;base64,${base64Audio}</Play>
      </Response>
    `);

  } catch (err) {
    console.error("Sammy error:", err);
    res.set("Content-Type", "text/xml");
    res.send(`
      <Response>
        <Say>Sorry mate, something broke on my end.</Say>
      </Response>
    `);
  }
});

app.get("/", (req, res) => res.send("Sammy voice agent active!"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Sammy running on port ${PORT}`));
