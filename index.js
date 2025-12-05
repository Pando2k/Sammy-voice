import express from "express";
import twilio from "twilio";

const app = express();
const { VoiceResponse } = twilio.twiml;

// Parse Twilio form-encoded payloads
app.use(express.urlencoded({ extended: false }));

// ---- One handler that never throws ----
const handleVoice = (req, res) => {
  try {
    // guard against missing body on odd GET probes or cold pings
    const b = req.body || {};
    console.log("Voice webhook hit:", {
      method: req.method,
      from: b.From,
      to: b.To,
      callSid: b.CallSid,
    });

    const vr = new VoiceResponse();
    vr.say({ voice: "Polly.Nicole-Neural" }, "Hi, it is Sammy. How can I help you today?");
    res.type("text/xml").status(200).send(vr.toString());
  } catch (err) {
    console.error("Webhook error:", err);
    const vr = new VoiceResponse();
    vr.say("Sorry, an error occurred.");
    res.type("text/xml").status(200).send(vr.toString()); // still 200 so Twilio never says "Application error"
  }
};

// Answer on /voice (POST from Twilio) and also GET (pings)
app.post("/voice", handleVoice);
app.get("/voice", handleVoice);

// Also answer at root to survive a mis-paste of the URL
app.all("/", handleVoice);

// Render port
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
