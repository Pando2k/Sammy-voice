import express from "express";
import twilio from "twilio";

const app = express();
const { twiml } = twilio;

// Twilio sends form-encoded data, so we enable URL encoding
app.use(express.urlencoded({ extended: false }));

// --- Voice endpoint for Twilio ---
app.post("/voice", (req, res) => {
  const response = new twiml.VoiceResponse();

  response.say(
    {
      voice: "Polly.Nicole-Neural" // Australian female neural voice
    },
    "Hi, it's Sammy. How can I help you today?"
  );

  res.type("text/xml");
  res.send(response.toString());
});

// Default homepage (useful for testing)
app.get("/", (req, res) => {
  res.send("Sammy Voice Server is running!");
});

// Render uses process.env.PORT
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
