import express from "express";
import dotenv from "dotenv";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";
import { sammyPersonality } from "./sammy-personality.js";

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ===== ENV =====
const OPENAI_API_KEY   = process.env.OPENAI_API_KEY;
const ELEVEN_API_KEY   = process.env.ELEVENLABS_API_KEY;
const ELEVEN_VOICE_ID  = process.env.ELEVENLABS_VOICE_ID;

if (!OPENAI_API_KEY)  console.warn("⚠️ Missing OPENAI_API_KEY");
if (!ELEVEN_API_KEY)  console.warn("⚠️ Missing ELEVENLABS_API_KEY");
if (!ELEVEN_VOICE_ID) console.warn("⚠️ Missing ELEVENLABS_VOICE_ID");

// ===== SIMPLE IN-MEMORY STORES =====
const audioStore = new Map();                 // id -> Buffer (mp3)
const sessions  = new Map();                  // CallSid -> {history, greeted, turns, last}

// Session helpers
function getSession(callSid) {
  let s = sessions.get(callSid);
  if (!s) {
    s = { history: [], greeted: false, turns: 0, last: Date.now() };
    sessions.set(callSid, s);
  }
  s.last = Date.now();
  return s;
}
function appendUser(callSid, text) {
  const s = getSession(callSid);
  s.history.push({ role: "user", content: text });
  if (s.history.length > 12) s.history = s.history.slice(-12); // keep last 12 exchanges
}
function appendAssistant(callSid, text) {
  const s = getSession(callSid);
  s.history.push({ role: "assistant", content: text });
  if (s.history.length > 12) s.history = s.history.slice(-12);
  s.turns += 1;
}
function shouldEnd(callSid, lastUserText, turns) {
  const byeRegex = /\b(bye|goodbye|hang ?up|that'?s all|finish|stop|end)\b/i;
  return byeRegex.test(lastUserText || "") || turns >= 20;
}

// ===== UTILS =====
function baseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
  return `${proto}://${req.get("host")}`;
}
const xmlEscape = s => (s || "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ===== OPENAI =====
async function askOpenAI(callSid, userText, isGreeting = false) {
  try {
    const sys = sammyPersonality + `
Rules for multi-turn:
- Keep it conversational and short (1–2 sentences).
- Ask a simple follow-up when helpful.
- Use Aussie warmth.
- Avoid over-apologising.`;

    const s = getSession(callSid);
    const messages = [{ role: "system", content: sys }];

    // Add prior turns
    for (const m of s.history) messages.push(m);

    // If greeting: steer opening
    if (isGreeting) {
      messages.push({
        role: "user",
        content: "Caller just connected. Offer a friendly Aussie greeting and ask how you can help."
      });
    } else {
      messages.push({ role: "user", content: userText || "Continue the conversation." });
    }

    const resp = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        messages,
        temperature: 0.65,
        max_tokens: 220,
        presence_penalty: 0.2,
        frequency_penalty: 0.2
      },
      {
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
        timeout: 20000
      }
    );

    const text = resp?.data?.choices?.[0]?.message?.content?.trim();
    return text || "Righto. How can I help?";
  } catch (err) {
    console.error("OpenAI error:", err.response?.data || err.message);
    return "Sorry mate, my brain glitched for a sec. What did you say?";
  }
}

// ===== ELEVENLABS TTS =====
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
          stability: 0.25,
          similarity_boost: 0.9,
          style: 0.5,
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

// ===== HEALTH / LANDING / GUARD =====
app.get("/", (_req, res) => {
  res.type("text/plain").send("✅ Sammy Voice Agent is running. Twilio uses POST /voice");
});
app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "sammy-voice", time: new Date().toISOString() });
});
app.get("/voice", (_req, res) => {
  res.type("text/plain").status(405).send("Use POST /voice (Twilio webhook)");
});

// Serve audio
app.get("/audio/:id", (req, res) => {
  const buf = audioStore.get(req.params.id);
  if (!buf) return res.status(404).type("text/plain").send("Audio not found");
  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Cache-Control", "public, max-age=300");
  res.send(buf);
});

// ===== TwiML builders =====
function twimlGather({ promptSay, promptPlayUrl, action = "/voice" }) {
  // We use actionOnEmptyResult so even if silence, we loop back into /voice
  const say = promptPlayUrl
    ? `<Play>${promptPlayUrl}</Play>`
    : `<Say language="en-AU" voice="Polly.Nicole-Neural">${xmlEscape(promptSay)}</Say>`;

  const twiml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response>` +
      `<Gather input="speech"` +
              ` language="en-AU"` +
              ` action="${action}" method="POST"` +
              ` speechTimeout="auto"` +
              ` actionOnEmptyResult="true"` +
              ` hints="${xmlEscape('yes,no,okay,booking,order,account,email,address,Perth,Australia')}">` +
        `${say}` +
      `</Gather>` +
      `<Redirect method="POST">${action}</Redirect>` +
    `</Response>`;
  return twiml;
}

function twimlGoodbye(text = "Cheers then — talk soon!") {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="en-AU" voice="Polly.Nicole-Neural">${xmlEscape(text)}</Say>
  <Hangup/>
</Response>`;
}

// ===== MAIN TWILIO WEBHOOK =====
app.post("/voice", async (req, res) => {
  const callSid = req.body.CallSid || "unknown";
  const speech  = (req.body.SpeechResult || req.body.TranscriptionText || "").trim();
  const hasSpeech = Boolean(speech);

  const s = getSession(callSid);

  // Greeting turn
  if (!s.greeted) {
    s.greeted = true;
    const reply = await askOpenAI(callSid, "", true);
    appendAssistant(callSid, reply);

    // TTS
    let playUrl = null;
    const mp3 = await ttsElevenLabs(reply);
    if (mp3) {
      const id = uuidv4();
      audioStore.set(id, mp3);
      setTimeout(() => audioStore.delete(id), 10 * 60 * 1000);
      playUrl = `${baseUrl(req)}/audio/${id}`;
    }

    const twiml = twimlGather({ promptSay: reply, promptPlayUrl: playUrl });
    res.type("text/xml").send(twiml);
    return;
  }

  // Conversational turn
  const userText = hasSpeech ? speech : "";
  if (hasSpeech) appendUser(callSid, userText);

  // End conditions
  if (shouldEnd(callSid, userText, s.turns)) {
    const bye = "No worries — I’ll let you go. Have a good one!";
    res.type("text/xml").send(twimlGoodbye(bye));
    sessions.delete(callSid);
    return;
  }

  // If no speech came through, reprompt softly
  const repromptIfSilent = !hasSpeech;

  // Ask LLM with history
  const reply = await askOpenAI(callSid, userText, false);
  appendAssistant(callSid, reply);

  // TTS preferred
  let playUrl = null;
  const mp3 = await ttsElevenLabs(reply);
  if (mp3) {
    const id = uuidv4();
    audioStore.set(id, mp3);
    setTimeout(() => audioStore.delete(id), 10 * 60 * 1000);
    playUrl = `${baseUrl(req)}/audio/${id}`;
  }

  const prompt = repromptIfSilent
    ? "Sorry, I didn’t catch that — could you say that again?"
    : reply;

  const twiml = twimlGather({ promptSay: prompt, promptPlayUrl: playUrl });
  res.type("text/xml").send(twiml);
});

// ===== START =====
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Sammy conversation server listening on ${PORT}`);
});

// ===== OPTIONAL CLEANUP: expire old sessions (memory) =====
setInterval(() => {
  const now = Date.now();
  for (const [sid, s] of sessions.entries()) {
    if (now - s.last > 30 * 60 * 1000) sessions.delete(sid); // 30 min idle
  }
}, 5 * 60 * 1000);
