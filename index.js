// index.js — minimal sanity server for Twilio webhook

import express from "express";
import dotenv from "dotenv";
dotenv.config();

const app = express();

// Accept both Twilio form posts and JSON tests
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// quick smoke routes
app.get("/", (req, res) => res.send("Sammy voice server up"));
app.get("/health", (req, res) => res.json({ ok: true }));

// Twilio voice webhook
app.post("/voice", (req, res) => {
  console.log("POST /voice body:", req.body); // should show From/To/CallSid in Render logs

  const say =
    "Hi, it’s Sammy. How can I help you, mate?"; // simple proof it works

  const twiml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response><Say voice="alice">${say}</Say></Response>`;

  res.set("Content-Type", "text/xml");
  res.send(twiml);
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Sammy running on port", PORT));
