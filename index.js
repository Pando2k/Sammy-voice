import express from "express";
import twilio from "twilio";

const app = express();
const { twiml: { VoiceResponse } } = twilio;

// Parse application/x-www-form-urlencoded like Twilio sends
app.use(express.urlencoded({ extended: false }));

// ---- Voice webhook: accept both POST and GET ----
const handleVoice = (req, res) => {
  try {
    console.log("Voice webhook hit:", {
      method: req.method,
      from: req.body.From,
      to: req.body.To,
      callSid: req.body.CallSid
    });

    const response = new VoiceResponse();

    response.say(
      { voice: "Polly.Nicole-Neural" },
      "Hi, it's Sammy. How can I help you today?"
    );

    res.type("text/xml");
    res.status(200).send(response.toString());
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(500).send("<Response><Say>Sorry, an error occurred.</Say></Response>");
  }
};

// Accept POST and GET
app.post("/voice", handleVoice);
app.get("/voice", handleVoice);

// Homepage
app.get("/", (_req, res) => {
  res.send("Sammy Voice Server is running!");
});

// Render port
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
