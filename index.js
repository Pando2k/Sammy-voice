import express from "express";
import twilio from "twilio";
import axios from "axios";

const app = express();
const { VoiceResponse } = twilio.twiml;

app.use(express.urlencoded({ extended: false }));

// --- Env vars from Render ---
const ELEVEN_API_KEY   = process.env.ELEVENLABS_API_KEY; // required
const ELEVEN_VOICE_ID  = process.env.ELEVENLABS_VOICE_ID; // required
const ELEVEN_MODEL_ID  = process.env.ELEVENLABS_MODEL_ID || "eleven_turbo_v2"; // optional

// Tiny health check
app.get("/", (_, res) => res.send("Sammy Voice Server is running!"));

// Generate an MP3 with ElevenLabs on the fly and stream it back
app.get("/greet.mp3", async (req, res) => {
  try {
    if (!ELEVEN_API_KEY || !ELEVEN_VOICE_ID) {
      res.status(500).send("Missing ELEVENLABS_API_KEY or ELEVENLABS_VOICE_ID");
      return;
    }

    const text = "Hi, it's Sammy. How can I help you today?";

    const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`;
    const resp = await axios.post(
      url,
      {
        text,
        model_id: ELEVEN_MODEL_ID,       // uses your model, or the default
        // You can fine-tune style here if you want:
        // voice_settings: { stability: 0.5, similarity_boost: 0.8, style: 0.3, use_speaker_boost: true }
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

    res.setHeader("Content-Type", "audio/mpeg");
    res.send(Buffer.from(resp.data));
  } catch (err) {
    console.error("ElevenLabs TTS error:", err?.response?.status, err?.response?.data || err.message);
    res.status(500).send("TTS failed");
  }
});

// Twilio Voice webhook – plays the ElevenLabs audio
app.post("/voice", (req, res) => {
  try {
    // Build absolute URL for /greet.mp3 (Render can be under your custom host)
    const base =
      `${req.headers["x-forwarded-proto"] || req.protocol}://${req.headers.host}`;

    const vr = new VoiceResponse();
    vr.play(`${base}/greet.mp3`);

    // Optional: start listening for speech after the greeting
    const g = vr.gather({
      input: "speech",
      action: "/handle-speech",
      method: "POST",
      speechTimeout: "auto",
      timeout: 5
    });
    // You can also add a short tone or silence here if you want

    res.type("text/xml").status(200).send(vr.toString());
  } catch (err) {
    console.error("Webhook error:", err);
    const vr = new VoiceResponse();
    vr.say("Sorry, an error occurred.");
    res.type("text/xml").status(200).send(vr.toString());
  }
});

// Just echoes that we heard you (placeholder for real NLU/agent)
app.post("/handle-speech", (req, res) => {
  const vr = new VoiceResponse();
  vr.say("Thanks. I heard you. We’ll wire this to Sammy’s brain next.");
  vr.hangup();
  res.type("text/xml").status(200).send(vr.toString());
});

// Render port
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
