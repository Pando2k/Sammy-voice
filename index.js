// index.js  — Sammy voice agent (Twilio <-> OpenAI + ElevenLabs)
// ESM module. Node 18+.
// Env required: ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID, OPENAI_API_KEY

import express from "express";
import twilio from "twilio";
import { Readable } from "stream";

const app = express();
const { VoiceResponse } = twilio.twiml;

// Parse Twilio form-encoded posts
app.use(express.urlencoded({ extended: false }));

// ---- Helper: make OpenAI reply ----
async function askOpenAI(userText) {
  const sys = `
You are Sammy: a warm, personable Australian female voice agent.
Traits: upbeat, friendly, small-talky, lightly cheeky, very helpful.
Mannerisms: subtle Aussie slang occasionally ("no worries", "too easy"), a quick "mm-hmm" now and then, natural pauses. 
Keep replies SHORT (1–2 sentences), conversational, and ask a clarifying question when helpful.
Avoid reading punctuation or emojis literally. Never mention being an AI.
`;
  const body = {
    model: "gpt-4.1-mini",
    messages: [
      { role: "system", content: sys.trim() },
      { role: "user", content: userText || "Say hello." }
    ],
    temperature: 0.7,
  };

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!r.ok) {
    const e = await r.text();
    console.error("OpenAI error:", e);
    return "Sorry, I hit a snag thinking about that. Want to try again?";
  }

  const data = await r.json();
  const text = data?.choices?.[0]?.message?.content?.trim();
  return text || "Okay! What would you like to do next?";
}

// ---- ElevenLabs TTS streaming endpoint ----
// Twilio <Play> will call /tts?text=...
app.get("/tts", async (req, res) => {
  try {
    const text = (req.query.text || "Hello").toString().slice(0, 400); // keep it short for URLs
    const voiceId = process.env.ELEVENLABS_VOICE_ID;
    const apiKey  = process.env.ELEVENLABS_API_KEY;

    if (!voiceId || !apiKey) {
      res.set("Content-Type", "audio/mpeg");
      return res.end(); // fail silently; Twilio will just skip audio
    }

    const ttsResp = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        "Accept": "audio/mpeg"
      },
      body: JSON.stringify({
        text,
        voice_settings: { stability: 0.4, similarity_boost: 0.85 },
        // You can tweak style, pronunciation, etc., later
      })
    });

    if (!ttsResp.ok) {
      console.error("ElevenLabs TTS error", await ttsResp.text());
      res.set("Content-Type", "audio/mpeg");
      return res.end();
    }

    res.set("Content-Type", "audio/mpeg");
    // Pipe the web stream to Node stream => response
    if (ttsResp.body?.getReader) {
      Readable.fromWeb(ttsResp.body).pipe(res);
    } else {
      const buf = Buffer.from(await ttsResp.arrayBuffer());
      res.end(buf);
    }
  } catch (err) {
    console.error("TTS route error:", err);
    res.set("Content-Type", "audio/mpeg");
    res.end();
  }
});

// ---- Main voice webhook: greet + gather speech ----
const greetText = "Hi, it's Sammy. How can I help you today?";

const handleVoice = async (req, res) => {
  try {
    const b = req.body || {};
    console.log("Voice webhook hit:", {
      method: req.method, from: b.From, to: b.To, callSid: b.CallSid
    });

    const vr = new VoiceResponse();

    // First interaction: greet and ask for speech
    const gather = vr.gather({
      input: "speech",
      language: "en-AU",
      speechTimeout: "auto",
      action: "/gather",
      method: "POST"
    });

    // Use ElevenLabs voice for the greeting via our /tts endpoint
    gather.play({ loop: 1 }, `${baseUrl(req)}/tts?text=${encodeURIComponent(greetText)}`);

    // Fallback if /tts fails for any reason
    gather.say({ voice: "Polly.Nicole-Neural" }, greetText);

    res.type("text/xml").status(200).send(vr.toString());
  } catch (err) {
    console.error("Webhook error at /voice:", err);
    const vr = new VoiceResponse();
    vr.say({ voice: "Polly.Nicole-Neural" }, "Sorry, an error occurred.");
    res.type("text/xml").status(200).send(vr.toString());
  }
};

// ---- Handle what the caller said, reply with ELabs, loop back ----
const handleGather = async (req, res) => {
  try {
    const b = req.body || {};
    const said = (b.SpeechResult || "").trim();
    console.log("Gather received:", { said });

    // If Twilio didn’t catch anything, re-prompt
    const prompt = said || "No speech detected. Please ask again.";
    const reply = await askOpenAI(prompt);

    const vr = new VoiceResponse();

    // Speak the reply in ElevenLabs voice
    vr.play({ loop: 1 }, `${baseUrl(req)}/tts?text=${encodeURIComponent(reply)}`);

    // Fallback TTS (Twilio Polly) just in case
    vr.say({ voice: "Polly.Nicole-Neural" }, reply);

    // Send them back to /voice for the next turn
    vr.redirect({ method: "POST" }, "/voice");

    res.type("text/xml").status(200).send(vr.toString());
  } catch (err) {
    console.error("Webhook error at /gather:", err);
    const vr = new VoiceResponse();
    vr.say({ voice: "Polly.Nicole-Neural" }, "Oops, I hit a snag. Let's try again.");
    vr.redirect({ method: "POST" }, "/voice");
    res.type("text/xml").status(200).send(vr.toString());
  }
};

// Small helper to build absolute URLs for /tts (works on Render)
function baseUrl(req) {
  // Prefer Render's canonical URL if present; otherwise derive
  const hdr = req.headers["x-forwarded-host"] || req.headers.host;
  const proto = (req.headers["x-forwarded-proto"] || "https");
  return `${proto}://${hdr}`;
}

// Routes (answer both POST & GET, and a root ok)
app.post("/voice", handleVoice);
app.get("/voice", handleVoice);
app.post("/gather", handleGather);
app.get("/", (_req, res) => res.send("Sammy Voice is running!"));

// Port
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
