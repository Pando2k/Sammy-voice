import express from "express";
import twilio from "twilio";

// ====== CONFIG ======
const ELEVEN_API_KEY = process.env.ELEVENLABS_API_KEY || "";   // <-- set in Render
const ELEVEN_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || ""; // Sammy voice id
// ====================

const app = express();
const { VoiceResponse } = twilio.twiml;

// Twilio posts x-www-form-urlencoded
app.use(express.urlencoded({ extended: false }));

// Serve synthesized audio back to Twilio
app.get("/audio/:file", (req, res) => {
  res.setHeader("Cache-Control", "public, max-age=300");
  res.sendFile(`/tmp/${req.params.file}`, { root: "/" }, (err) => {
    if (err) res.status(404).end();
  });
});

// Health
app.get("/", (_req, res) => res.send("Sammy Voice Agent is running!"));

// ---------- CALL ENTRY: prompt & keep line open ----------
app.all("/voice", (req, res) => {
  const vr = new VoiceResponse();
  const g = vr.gather({
    input: "speech",
    speechTimeout: "auto",
    language: "en-AU",
    action: "/handle_speech",
    method: "POST"
  });

  // Fallback TTS so there’s *always* a voice even if ElevenLabs fails later
  g.say({ voice: "alice", language: "en-AU" },
        "Hi, it's Sammy. How can I help you today?");

  // If no speech captured, re-prompt
  vr.say({ voice: "alice", language: "en-AU" }, "Sorry, I didn't catch that.");
  vr.redirect("/voice");

  res.type("text/xml").status(200).send(vr.toString());
});

// ---------- HANDLE USER SPEECH ----------
app.post("/handle_speech", async (req, res) => {
  const vr = new VoiceResponse();
  try {
    const b = req.body || {};
    const text = (b.SpeechResult || "").trim();
    const conf = b.Confidence;

    console.log("User said:", text, "conf:", conf);

    // 1) Make a friendly reply (simple small-talk brain)
    const reply = buildReply(text);

    // 2) Synthesize with ElevenLabs "Sammy"
    const fileName = `sammy_${Date.now()}.mp3`;
    const ok = await synthElevenLabs(reply, `/tmp/${fileName}`);

    if (ok) {
      const host = req.headers["x-forwarded-host"] || req.headers.host;
      const baseUrl = `https://${host}`;
      vr.play(`${baseUrl}/audio/${fileName}`);
    } else {
      // Fallback to Twilio TTS if synthesis fails
      vr.say({ voice: "alice", language: "en-AU" }, reply);
    }

    // Keep convo going
    vr.redirect("/voice");
    res.type("text/xml").status(200).send(vr.toString());
  } catch (err) {
    console.error("handle_speech error:", err);
    vr.say({ voice: "alice", language: "en-AU" }, "Sorry, something went wrong.");
    vr.redirect("/voice");
    res.type("text/xml").status(200).send(vr.toString());
  }
});

// ---------- Small-talk brain (replace with OpenAI later) ----------
function buildReply(user) {
  if (!user) return "Hey there. What would you like to do?";
  const u = user.toLowerCase();

  if (/(hi|hello|hey)/.test(u)) return "Hi! I’m Sammy. What can I help with today?";
  if (/name/.test(u)) return "I’m Sammy, your Aussie voice agent.";
  if (/(time|date)/.test(u)) return "I can help route your request or take a message.";
  if (/(help|support|problem)/.test(u)) return "Sure thing. Tell me what’s going on and I’ll sort it.";
  if (/(thank|thanks)/.test(u)) return "No worries! Anything else I can do for you?";

  return `Got it. You said: ${user}. Do you want me to take a message or help with something else?`;
}

// ---------- ElevenLabs TTS helper ----------
async function synthElevenLabs(text, outPath) {
  try {
    if (!ELEVEN_API_KEY || !ELEVEN_VOICE_ID) {
      console.warn("Missing ElevenLabs env vars; skipping TTS.");
      return false;
    }
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}?optimize_streaming_latency=2`;

    const r = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": ELEVEN_API_KEY,
        "Content-Type": "application/json",
        "Accept": "audio/mpeg"
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_monolingual_v1",
        voice_settings: { stability: 0.4, similarity_boost: 0.85, style: 0.2, use_speaker_boost: true }
      })
    });

    if (!r.ok) {
      console.error("ElevenLabs error:", r.status, await safeText(r));
      return false;
    }

    const arrayBuf = await r.arrayBuffer();
    await import("node:fs/promises")
      .then(fs => fs.writeFile(outPath, Buffer.from(arrayBuf)));
    return true;
  } catch (e) {
    console.error("synthElevenLabs exception:", e);
    return false;
  }
}

async function safeText(resp) {
  try { return await resp.text(); } catch { return "<no body>"; }
}

// ---------- Render port ----------
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
