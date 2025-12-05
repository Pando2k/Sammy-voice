import express from "express";

const app = express();

// Twilio may send urlencoded form data; we don't need JSON here
app.use(express.urlencoded({ extended: false }));

// ---- Voice endpoint (handles both POST and GET) ----
const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Nicole-Neural">Hi, it's Sammy. How can I help you today?</Say>
</Response>`;

app.post("/voice", (req, res) => {
  res.type("text/xml").send(twiml);
});

app.get("/voice", (req, res) => {
  // In case Twilio is configured as GET by mistake
  res.type("text/xml").send(twiml);
});

// Default homepage (warming check)
app.get("/", (_req, res) => {
  res.send("Sammy Voice Server is running!");
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
