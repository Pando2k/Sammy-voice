/**
 * Sammy — Streaming Voice Agent (Twilio Media Streams + OpenAI Realtime)
 * Paste this entire file as `server.js`
 * 
 * Requires:
 *  - Node 18+
 *  - ENV: PORT, OPENAI_API_KEY, SAMMY_REGION (optional)
 *  - Twilio phone number Voice -> "Webhook" -> https://<your-render-url>/voice (HTTP POST)
 *
 * Flow:
 *  1) /voice returns TwiML that opens a bidirectional <Stream> to wss://<your-render-url>/stream
 *  2) We receive Twilio 8kHz μ-law audio frames, forward to OpenAI Realtime
 *  3) OpenAI streams back synthesized speech + natural turn-taking
 *  4) We forward the audio stream back to Twilio in real-time ("media" messages)
 */

import express from "express";
import crypto from "crypto";
import dotenv from "dotenv";
import WebSocket, { WebSocketServer } from "ws";
import bodyParser from "body-parser";

// ================== ENV ==================
dotenv.config();

const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error("❌ Missing OPENAI_API_KEY in env");
  process.exit(1);
}

// Optional: Australian flavor for STT/TTS
const SAMMY_REGION = process.env.SAMMY_REGION || "en-AU";

// ================== Sammy prompt ==================
const SAMMY_SYSTEM = `
You are **Sammy**, a warm Aussie voice agent from Perth.

GOALS
- Sound natural, human, and brief.
- Be helpful, friendly, and practical.

VOICE
- Light West Australian vibe; casual but professional.
- Use tiny backchannels sparingly (e.g., "mm", "right", "yeah") only when natural.

TURN RULES (hard):
- Keep each utterance short and spoken (~6–12 words, 1 sentence).
- Ask at most one concise follow-up question when useful.
- No lists, no brackets, no stage directions.

BOUNDARIES
- No medical/legal/financial advice beyond general info.
- Stay safe and respectful.

OUTPUT
- Return only the line you would say aloud.
`;

// ================== Express (TwiML + health) ==================
const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// Tiny landing + health (handy for quick checks)
app.get("/", (_req, res) =>
  res.type("text/plain").send("✅ Sammy Realtime is running. Twilio hits POST /voice")
);
app.get("/health", (_req, res) =>
  res.json({ ok: true, service: "sammy-realtime", time: new Date().toISOString() })
);

// TwiML: open a bidirectional stream to our WS endpoint
app.post("/voice", (req, res) => {
  const host = req.get("host");
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
  const streamUrl = `wss://${host}/stream`;

  // Twilio <Connect><Stream> TwiML
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${streamUrl}"/>
  </Connect>
</Response>`;
  res.type("text/xml").send(twiml);
});

// Start HTTP server
const server = app.listen(PORT, () => {
  console.log(`🚀 Sammy realtime server listening on :${PORT}`);
});

// ================== WebSocket bridge ==================
/**
 * Twilio media stream <-> OpenAI Realtime WS
 * We:
 *  - Accept Twilio's JSON messages over WS (/stream)
 *  - Forward audio to OpenAI Realtime
 *  - Pipe audio from OpenAI back to Twilio as "media" messages
 */

// Twilio sends μ-law 8kHz mono audio frames base64-encoded.
// OpenAI Realtime accepts PCM16 16kHz by default, but can accept 8kHz μ-law as raw frames
// if we specify the correct format metadata. We'll use the convenience "telephony" preset.

const wss = new WebSocketServer({ server, path: "/stream" });

wss.on("connection", async (twilioSocket, req) => {
  console.log("🔌 Twilio connected to /stream");

  // Create OpenAI Realtime session WebSocket
  // Realtime endpoint (model name may update over time)
  const openaiUrl = "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17";

  // Attach headers for auth + session config
  const oaHeaders = {
    "Authorization": `Bearer ${OPENAI_API_KEY}`,
    "OpenAI-Beta": "realtime=v1",
  };

  const openaiSocket = new WebSocket(openaiUrl, { headers: oaHeaders });

  // State
  let started = false;
  let closed = false;

  const safeClose = (code = 1000, reason = "normal") => {
    if (closed) return;
    closed = true;
    try { openaiSocket.close(code, reason); } catch {}
    try { twilioSocket.close(); } catch {}
  };

  // When OpenAI WS opens, configure the session (system prompt, input format, TTS voice)
  openaiSocket.on("open", () => {
    console.log("🤝 Connected to OpenAI Realtime");
    // Set up the session: telephony audio, language, and system prompt
    // We also enable OpenAI TTS so it speaks back directly.
    openaiSocket.send(JSON.stringify({
      type: "session.update",
      session: {
        // Telephony preset: μ-law 8kHz in/out for Twilio
        audio_format: {
          type: "telephony",
          codec: "mulaw",
          sample_rate_hz: 8000
        },
        input_audio_format: {
          type: "telephony",
          codec: "mulaw",
          sample_rate_hz: 8000
        },
        output_audio_format: {
          type: "telephony",
          codec: "mulaw",
          sample_rate_hz: 8000
        },
        // Language & voice
        turn_detection: { type: "server_vad" }, // server-side VAD for barge-in
        instructions: SAMMY_SYSTEM,
        voice: SAMMY_REGION === "en-AU" ? "alloy" : "alloy", // pick a neutral; AU prosody will come from system+region
        modalities: ["audio", "text"]
      }
    }));
    started = true;
  });

  // Handle audio and events coming back from OpenAI and relay to Twilio
  openaiSocket.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      // Realtime emits many event types; we care about audio chunks
      if (msg.type === "response.audio.delta") {
        // msg.audio is base64 μ-law 8kHz frame (when telephony configured)
        const b64 = msg.audio;
        // Send to Twilio: media message
        const mediaMsg = {
          event: "media",
          media: { payload: b64 }
        };
        twilioSocket.send(JSON.stringify(mediaMsg));
      }

      // When a "response.completed" arrives, tell Twilio playback segment ended
      if (msg.type === "response.completed") {
        const mark = {
          event: "mark",
          mark: { name: "openai_segment_done" }
        };
        twilioSocket.send(JSON.stringify(mark));
      }

    } catch (e) {
      console.error("OpenAI message parse error:", e);
    }
  });

  openaiSocket.on("close", (code, reason) => {
    console.log("🔻 OpenAI WS closed:", code, reason?.toString());
    safeClose();
  });
  openaiSocket.on("error", (err) => {
    console.error("OpenAI WS error:", err?.message || err);
    safeClose();
  });

  // Handle Twilio -> forward audio to OpenAI, and forward marks/DTMF if needed
  twilioSocket.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      switch (msg.event) {
        case "start":
          console.log("▶️ Twilio stream start", msg.start?.streamSid);
          break;

        case "media":
          // Twilio sends μ-law 8kHz frame as base64 in msg.media.payload
          // Forward to OpenAI as input audio chunk
          if (started) {
            openaiSocket.send(JSON.stringify({
              type: "input_audio_buffer.append",
              audio: msg.media.payload // same base64
            }));
          }
          break;

        case "mark":
          // playback mark acknowledged
          break;

        case "stop":
          console.log("⏹️ Twilio stream stop");
          // Flush end-of-input to OpenAI so it can finish a thought
          try {
            openaiSocket.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
            openaiSocket.send(JSON.stringify({ type: "response.create", response: {} }));
          } catch {}
          safeClose();
          break;

        default:
          break;
      }
    } catch (e) {
      console.error("Twilio WS parse error:", e);
    }
  });

  twilioSocket.on("close", () => {
    console.log("🔻 Twilio WS closed");
    safeClose();
  });

  twilioSocket.on("error", (err) => {
    console.error("Twilio WS error:", err?.message || err);
    safeClose();
  });

  // Heartbeat: keep connections alive
  const pingIv = setInterval(() => {
    if (closed) return clearInterval(pingIv);
    try { twilioSocket.ping(); } catch {}
    try { openaiSocket.ping?.(); } catch {}
  }, 15000);
});
