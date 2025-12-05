import express from "express";
import { twiml } from "twilio";

const app = express();
app.use(express.urlencoded({ extended: false }));

// --- Sammy Voice Endpoint ---
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

// Default homepage
app.get("/", (req, res) => {
  res.send("Sammy Voice Server is running!");
});

// Render port
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
