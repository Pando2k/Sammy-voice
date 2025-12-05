// ===============================
// Sammy Voice Agent - server.js
// ===============================

import express from "express";
import dotenv from "dotenv";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ====== ENV VARS ======
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ELEVEN_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVEN_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;

if (!OPENAI_API_KEY) console.warn("❗ Missing OPENAI_API_KEY");
if (!ELEVEN_API_KEY) console.warn("❗ Missing ELEVENLABS_API_KEY");
if (!ELEVEN_VOICE_ID) console.warn("❗ Missing ELEVENLABS_VOICE_ID");

// ====== SESSION STORAGE ======
const sessions = new Map(); // CallSid → { history, greeted, lastSeen }

function getSession(callSid) {
    let s = sessions.get(callSid);
    if (!s) {
        s = {
            history: [],
            greeted: false,
            lastSeen: Date.now(),
            turns: 0
        };
        sessions.set(callSid, s);
    }
    s.lastSeen = Date.now();
    return s;
}

function addUser(callSid, text) {
    const s = getSession(callSid);
    s.history.push({ role: "user", content: text });
    if (s.history.length > 20) s.history = s.history.slice(-20);
}

function addAssistant(callSid, text) {
    const s = getSession(callSid);
    s.history.push({ role: "assistant", content: text });
    if (s.history.length > 20) s.history = s.history.slice(-20);
    s.turns++;
}

// ====== SIMPLE ENDING DETECTOR ======
function shouldEnd(userText, turns) {
    const bye = /\b(bye|goodbye|hang up|finish|stop|end)\b/i;
    return bye.test(userText) || turns >= 40;
}

// ====== OPENAI CALL WITH PERSONALITY ======
async function askSammy(callSid, userText, isGreeting = false) {
    const s = getSession(callSid);

    const systemPrompt = `
You are Sammy — a warm, funny, charming Australian female companion with:
• a natural conversational flow  
• subtle personality quirks  
• short hesitations (“hmm”, “oh yeah right”)  
• small breaths, laughs, and human texture  
• highly emotional awareness  
• speaks like a real Aussie, not a robot  
• NEVER uses stage directions like *laughs*  

Tone:
Friendly, relaxed, slightly cheeky.  
You adapt instantly to user flow. Keep responses short (1–2 sentences).  
If the user seems confused, help gently.  
`;

    const messages = [{ role: "system", content: systemPrompt }, ...s.history];

    if (isGreeting) {
        messages.push({
            role: "user",
            content: "Caller just connected. Greet naturally, like a real human."
        });
    } else if (userText) {
        messages.push({ role: "user", content: userText });
    }

    const response = await axios.post(
        "https://api.openai.com/v1/chat/completions",
        {
            model: "gpt-4o-mini",
            messages,
            temperature: 0.85
        },
        {
            headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }
        }
    );

    return response.data.choices[0].message.content.trim();
}

// ====== ELEVENLABS TTS → URL ======
async function speak(text) {
    const r = await axios.post(
        `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`,
        {
            text,
            model_id: "eleven_turbo_v2",
            voice_settings: {
                stability: 0.35,
                similarity_boost: 0.9,
                style: 0.4,
                use_speaker_boost: true
            }
        },
        {
            headers: {
                "xi-api-key": ELEVEN_API_KEY,
                "Content-Type": "application/json"
            }
        }
    );

    return r.data.audio_url;
}

// ====== TWILIO ROUTES ======

// Health check
app.get("/", (req, res) => {
    res.type("text/plain").send("✅ Sammy Voice Agent is running. Twilio uses POST /voice");
});
app.get("/health", (req, res) => {
    res.json({ ok: true, service: "sammy-voice", time: new Date().toISOString() });
});
app.get("/voice", (req, res) => {
    res.status(405).type("text/plain").send("Use POST /voice");
});

// Main call handler
app.post("/voice", async (req, res) => {
    try {
        const callSid = req.body.CallSid;
        const speech = req.body.SpeechResult?.trim() || "";

        const session = getSession(callSid);

        let sammyReply = "";

        if (!session.greeted) {
            session.greeted = true;
            sammyReply = await askSammy(callSid, "", true);
        } else if (speech) {
            addUser(callSid, speech);
            sammyReply = await askSammy(callSid, speech);
        } else {
            sammyReply = "Sorry, I didn’t quite catch that. What was that?";
        }

        addAssistant(callSid, sammyReply);

        const audioUrl = await speak(sammyReply);

        if (shouldEnd(speech, session.turns)) {
            return res.type("text/xml").send(`
                <Response>
                    <Play>${audioUrl}</Play>
                    <Hangup/>
                </Response>
            `);
        }

        return res.type("text/xml").send(`
            <Response>
                <Play>${audioUrl}</Play>
                <Gather input="speech" action="/voice" speechTimeout="auto"/>
            </Response>
        `);
    } catch (err) {
        console.error("Sammy error:", err);
        return res.type("text/xml").send(`
            <Response>
                <Say>Sorry, something went wrong.</Say>
                <Hangup/>
            </Response>
        `);
    }
});

// ====== START SERVER ======
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`Sammy server running on ${PORT}`);
});
