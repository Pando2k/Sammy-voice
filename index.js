import express from "express";
import twilio from "twilio";

const app = express();
const { VoiceResponse } = twilio.twiml;

// Twilio posts x-www-form-urlencoded
app.use(express.urlencoded({ extended: false }));

// ---- Voice webhook handler (safe / unthrowable) ----
const handleVoice = (req, res) => {
  try {
    const b = req.body || {}; // guard against undefined on odd GET/probes
    console.log("Voice webhook hit:", {
      method: req.method,
      from: b.From,
      to: b.To,
      callSid: b.CallSid,
    });

    const vr = new VoiceResponse();
    vr.say({ voice: "Polly.Nicole-Neural" }, "Hi, it's Sammy. How can I help you today?");

    res.type("text/xml").status(200).send(vr.toString());
  } catch (err) {
    console.error("Webhook error:", err);

    // Always send valid TwiML + 200 so Twilio doesn't error/retry
    const vr = new VoiceResponse();
    vr.say("Sorry, an error occurred.");
    res.type("text/xml").status(200).send(vr.toString());
  }
};

// Support POST (normal) and GET (fallback/health)
app.post("/voice", handleVoice);
app.get("/voice", handleVoice);

// Simple home page
app.get("/", (_req, res) => {
  res.status(200).send("Sammy Voice Server is running!");
});

// Render provides PORT env; default for local
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
