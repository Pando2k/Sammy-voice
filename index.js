import express from "express";
import twilio from "twilio";

const app = express();
const { VoiceResponse } = twilio;

// Parse form-encoded payloads (what Twilio sends)
app.use(express.urlencoded({ extended: false }));

// ---- Voice Webhook Handler ----
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
      { voice: "Polly.Nicole-Neural" },  // Strong Australian female voice
      "Hi, it's Sammy. How can I help you today?"
    );

    res.type("text/xml");
    res.status(200).send(response.toString());
  } catch (err) {
    console.error("Webhook error:", err);
    res
      .status(500)
      .send(
        `<Response><Say>Sorry, an error occurred.</Say></Response>`
      );
  }
};

// Accept both POST (normal Twilio) and GET (fallback)
app.post("/voice", handleVoice);
app.get("/voice", handleVoice);

// Homepage
app.get("/", (_, res) => {
  res.send("Sammy Voice Server is running!");
});

// Render uses PORT environment variable
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
