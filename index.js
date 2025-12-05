import express from "express";
import twilio from "twilio";

const app = express();
const { twiml: { VoiceResponse } } = twilio;

// Parse application/x-www-form-urlencoded like Twilio sends
app.use(express.urlencoded({ extended: false }));

// ---- Voice webhook: accept both POST and GET just in case ----
const handleVoice = (req, res) => {
  try {
    // Log a few useful fields (shows up in Render logs)
    console.log("Voice webhook hit:", {
      method: req.method,
      from: req.body.From,
      to: req.body.To,
      callSid: req.body.CallSid
    });

    const response = new VoiceResponse();
    response.say(
      { voice: "Polly.Nicole-Neural" },  // AU female neural voice
      "Hi, it's Sammy. How can I help you today?"
    );

    res.type("text/xml");
    res.status(200).send(response.toString());
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(500).send("<Response><Say>Sorry, an error occurred.</Say></Response>");
  }
};

// Accept POST (normal Twilio) and GET (fallback if misconfigured)
app.post("/voice", handleVoice);
app.get("/voice", handleVoice);

// Simple home page (helps wake free Render dyno)
app.get("/", (_req, res) => {
  res.send("Sammy Voice Server is running!");
});

// Use Render port
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
