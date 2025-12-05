import express from "express";
import twilio from "twilio";

const app = express();
const { VoiceResponse } = twilio.twiml;

// Twilio sends application/x-www-form-urlencoded
app.use(express.urlencoded({ extended: false }));

// --- One handler that never throws ---
const handleVoice = (req, res) => {
  try {
    // Guard GET/cold probes that have no body
    const b = req.body || {};

    console.log("[/voice] webhook hit", {
      method: req.method,
      from: b.From,
      to: b.To,
      callSid: b.CallSid,
      ua: req.get("user-agent"),
    });

    const vr = new VoiceResponse();
    vr.say({ voice: "Polly.Nicole-Neural" }, "Hi, it is Sammy. How can I help you today?");

    // Always reply 200 with TwiML
    res
      .type("text/xml; charset=utf-8")
      .status(200)
      .send(vr.toString());
  } catch (err) {
    // Log and STILL return 200 TwiML so Twilio never says “Application error”
    console.error("[/voice] error:", err);
    const vr = new VoiceResponse();
    vr.say("Sorry, an error occurred.");
    res
      .type("text/xml; charset=utf-8")
      .status(200)
      .send(vr.toString());
  }
};

// Answer both POST (normal) and GET (pings/fallbacks)
app.post("/voice", handleVoice);
app.get("/voice", handleVoice);

// Lightweight health check to wake the dyno before calling
app.get("/health", (_req, res) => {
  res.type("text/plain").send("OK");
});

// Render port
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
