import express from "express";
import twilio from "twilio";

const ELEVEN_API_KEY = process.env.ELEVENLABS_API_KEY || "";
const ELEVEN_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "";

const app = express();
const { VoiceResponse } = twilio.twiml;

app.use(express.urlencoded({ extended: false }));

// health
app.get("/", (_req, res) => res.send("Sammy Voice Agent is running!"));

// serve synthesized audio
app.get("/audio/:file", (req, res) => {
  res.setHeader("Cache-Control", "public, max-age=300");
  res.sendFile(`/tmp/${req.params.file}`, { root: "/" }, (err) => {
    if (err) res.status(404).end();
  });
});

// ---------- entry: gather speech ----------
app.all("/voice", (req, res) => {
  const vr = new VoiceResponse();

  // ALWAYS call our action, even if Twilio hears nothing
  const g = vr.gather({
    input: "speech",
    language: "en-AU",
    speechTimeout: "auto",
    timeout: 6,
    actionOnEmptyResult: true,
    action: "/handle_speech",
    method: "POST"
  });

  // Initial prompt (Twilio TTS just to start the convo)
  g.say({ voice: "alice", language: "en-AU" },
        "Hi, it's Sammy. How can I help you today?");

  // If gather didn’t fire for any reason, reprompt by redirecting back here
  vr.redirect("/voice");

  res.type("text/xml").status(200).send(vr.toString());
});

// ---------- handle user speech, synth with ElevenLabs, loop ----------
app.post("/handle_speech", async (req, res) => {
  const vr = new VoiceResponse();
  try {
    const b = req.body || {};
    console.log("HANDLE_SPEECH body:", JSON.stringify(b));

    const user = (b.SpeechResult || "").trim();
    const reply = buildReply(user);

    const fileName = `sammy_${Date.now()}.mp3`;
    const ok = await synthElevenLabs(reply, `/tmp/${fileName}`);

    if (ok) {
      const host = req.headers["x-forwarded-host"] || req.headers.host;
      const base = `https://${host}`;
      vr.play(`${base}/audio/${fileName}`);
    } else {
      vr.say({ voice: "alice", language: "en-AU" }, reply);
    }

    // keep the conversation going
    vr.redirect("/voice");
    res.type("text/xml").status(200).send(vr.toString());
  } catch (e) {
    console.error("handle_speech error:", e);
    vr.say({ voice: "alice", language: "en-AU" },
           "Sorry, something went wrong. Let's try again.");
    vr.redirect("/voice");
    res.type("text/xml").status(200).send(vr.toString());
  }
});

// ---------- tiny rule-based brain ----------
function buildReply(user) {
  if (!user) return "I didn’t catch that. Could you say that again?";
  const u = user.toLowerCase();

  if (/(hi|hello|hey)/.test(u)) return "Hi! I’m Sammy. What can I do for you?";
  if (/name/.test(u)) return "I’m Sammy, your Aussie voice agent.";
  if (/(help|support|problem|issue)/.test(u))
    return "No worries. Tell me what’s happening and I’ll help.";
  if (/(thank|thanks)/.test(u))
    return "You’re welcome! Anything else I can do?";

  return `You said: ${user}. Do you want me to take a message or help with something else?`;
}

// ---------- ElevenLabs TTS ----------
async function synthElevenLabs(text, outPath) {
  try {
    if (!ELEVEN_API_KEY || !ELEVEN_VOICE_ID) {
      console.warn("Missing ELEVENLABS_API_KEY or ELEVENLABS_VOICE_ID");
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
        voice_settings: {
          stability: 0.4,
          similarity_boost: 0.85,
          style: 0.2,
          use_speaker_boost: true
        }
      })
    });
    if (!r.ok) {
      console.error("ElevenLabs HTTP", r.status, await safeText(r));
      return false;
    }
    const buf = Buffer.from(await r.arrayBuffer());
    const fs = await import("node:fs/promises");
    await fs.writeFile(outPath, buf);
    return true;
  } catch (e) {
    console.error("synthElevenLabs exception:", e);
    return false;
  }
}
async function safeText(resp) { try { return await resp.text(); } catch { return "<no body>"; } }

// ---------- port ----------
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
