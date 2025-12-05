import express from "express";
import twilio from "twilio";

const app = express();
const { VoiceResponse } = twilio.twiml;

app.use(express.urlencoded({ extended: false }));

const handleVoice = (req, res) => {
  try {
    const b = req.body || {};

    console.log("[/voice] webhook hit", {
      method: req.method,
      from: b.From,
      to: b.To,
      callSid: b.CallSid,
      ua: req.get("user-agent"),
    });

    const vr = new VoiceResponse();
    vr.say(
      { voice: "Olivia" }, 
      "Hi, it's Sammy. How can I help you today?"
    );

    res.type("text/xml; charset=utf-8")
       .status(200)
       .send(vr.toString());
  } catch (err) {
    console.error(err);
    const vr = new VoiceResponse();
    vr.say("Sorry, an error occurred.");
    res.type("text/xml").status(200).send(vr.toString());
  }
};

app.post("/voice", handleVoice);
app.get("/voice", handleVoice);

app.get("/health", (_req, res) => res.send("OK"));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
