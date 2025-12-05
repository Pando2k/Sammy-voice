// ===================================================
// Sammy Voice Agent v3 — "Lifelike Extreme"
// Natural rhythm, micro-acks, memory, fast barge-in
// ===================================================

import express from "express";
import dotenv from "dotenv";
import axios from "axios";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---------- ENV ----------
const OPENAI_API_KEY   = process.env.OPENAI_API_KEY;
const ELEVEN_API_KEY   = process.env.ELEVENLABS_API_KEY;
const ELEVEN_VOICE_ID  = process.env.ELEVENLABS_VOICE_ID;
const SAMMY_MODE       = (process.env.SAMMY_MODE || "friendly").toLowerCase(); // friendly | flirty | pro
const PORT             = process.env.PORT || 10000;

if (!OPENAI_API_KEY)  console.warn("❗ Missing OPENAI_API_KEY");
if (!ELEVEN_API_KEY)  console.warn("❗ Missing ELEVENLABS_API_KEY");
if (!ELEVEN_VOICE_ID) console.warn("❗ Missing ELEVENLABS_VOICE_ID");

// ---------- tiny file persistence (per-caller memory) ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const MEM_PATH   = path.join(__dirname, "sammy_memory.json");

// shape: { "<caller>": { name, facts:[], lastMood, lastSeen } }
let longTerm = {};
try {
  if (fs.existsSync(MEM_PATH)) longTerm = JSON.parse(fs.readFileSync(MEM_PATH, "utf-8"));
} catch (e) {
  console.error("Memory load failed:", e);
}
function saveMemory() {
  try { fs.writeFileSync(MEM_PATH, JSON.stringify(longTerm, null, 2)); }
  catch(e){ console.error("Memory write failed:", e); }
}

// ---------- in-call sessions ----------
/*
  sessions[CallSid] = {
    history: [{role, content}],
    greeted: bool,
    turns: number,
    caller: "+614…",
    name: "Kai" | null,
    lastMood: "positive|neutral|frustrated|sad|excited"
  }
*/
const sessions = new Map();
function getSession(callSid, from="+unknown") {
  let s = sessions.get(callSid);
  if (!s) {
    s = { history: [], greeted:false, turns:0, caller: from, name:null, lastMood:"neutral" };
    sessions.set(callSid, s);
  }
  return s;
}
function addUser(callSid, text) {
  const s = sessions.get(callSid);
  s.history.push({ role:"user", content:text });
  if (s.history.length > 28) s.history = s.history.slice(-28);
}
function addAssistant(callSid, text) {
  const s = sessions.get(callSid);
  s.history.push({ role:"assistant", content:text });
  if (s.history.length > 28) s.history = s.history.slice(-28);
  s.turns++;
}

// ---------- helpers ----------
function modeSnippet() {
  if (SAMMY_MODE === "flirty") return `Flirty, playful, cheeky but respectful—never crude. Light compliments are okay.`;
  if (SAMMY_MODE === "pro")    return `Professional, efficient, warm but concise. No flirting.`;
  return `Friendly Aussie warmth; relaxed and a touch cheeky where appropriate.`;
}

function baseSystemPrompt(profile) {
  return `
You are **Sammy** — an Australian woman from Perth. You sound human.
Your lines must be natural speech in 1–2 sentences. No stage directions, no brackets.

Persona mode: ${modeSnippet()}

Delivery:
- Flow like real conversation: contractions, tiny hesitations (mm / ah) sparingly.
- Sprinkle Aussie flavour occasionally (“no worries”, “yeah right”, “too easy”, “no dramas”).
- Mirror mood lightly (softer when upset, lively when excited).
- Ask one crisp question when you need input. Avoid multi-question stacks.

Memory:
- If they tell you their name or a fact, remember it and use later.
- If unsure about a memory, ask lightly rather than inventing.

Boundaries:
- No medical, legal, or financial advice beyond general info. Keep it safe.

${profile ? `Known about caller: ${profile}` : ""}
`;
}

function profileForCaller(caller) {
  const p = longTerm[caller];
  if (!p) return "";
  const name = p.name ? `name=${p.name}` : "";
  const facts = (p.facts||[]).slice(-6).join("; ");
  return `${name} ${facts}`.trim();
}

function updateLongTerm(caller, patch) {
  if (!longTerm[caller]) longTerm[caller] = { name:null, facts:[], lastMood:"neutral", lastSeen:Date.now() };
  const obj = longTerm[caller];
  if (patch.name && !obj.name) obj.name = patch.name;
  if (patch.mood) obj.lastMood = patch.mood;
  if (patch.fact) obj.facts.push(patch.fact);
  obj.lastSeen = Date.now();
  saveMemory();
}

function shouldEnd(userText, turns) {
  const bye = /\b(bye|goodbye|hang\s?up|finish|end|talk later)\b/i;
  return bye.test(userText || "") || turns >= 64;
}

// ---------- OpenAI with retry ----------
async function openAIChat(messages, temperature=0.9, tries=3) {
  let lastErr;
  for (let i=0; i<tries; i++) {
    try {
      const r = await axios.post(
        "https://api.openai.com/v1/chat/completions",
        { model: "gpt-4o-mini", messages, temperature },
        { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } }
      );
      return r.data.choices[0].message.content.trim();
    } catch (e) {
      lastErr = e;
      await new Promise(r=>setTimeout(r, 400*(i+1)));
    }
  }
  throw lastErr;
}

async function analyzeUser(text) {
  const prompt = [
    { role:"system", content: "Classify sentiment+mood and extract first name if present. JSON: {mood:(positive|neutral|frustrated|sad|excited), name?:string}. Only JSON." },
    { role:"user", content: text }
  ];
  const raw = await openAIChat(prompt, 0.2);
  try { return JSON.parse(raw); } catch { return { mood:"neutral" }; }
}

// ---------- “Lifelike” shaping ----------
const backchannels = [
  "mm", "yeah?", "right", "uh-huh", "yep", "yeah right", "mm-hm", "okay?"
];

function randomPick(arr){ return arr[Math.floor(Math.random()*arr.length)]; }

function shapeReply(text, mood="neutral") {
  if (!text) return "Sorry, say that again?";
  let t = text.trim();

  // keep very short
  if (t.length > 160) {
    // cut to ~140–160 without breaking last sentence hard
    let cut = t.slice(0, 160);
    const lastPunct = Math.max(cut.lastIndexOf("."), cut.lastIndexOf("?"), cut.lastIndexOf("!"));
    if (lastPunct > 60) cut = cut.slice(0, lastPunct+1);
    t = cut;
  }

  // soften edges
  t = t.replace(/\b(I will|I shall)\b/gi, "I'll")
       .replace(/\b(we will|we shall)\b/gi, "we'll")
       .replace(/\b(do not)\b/gi, "don't")
       .replace(/\b(cannot)\b/gi, "can't");

  // sprinkle aussie particles lightly
  if (!/[?!.]$/.test(t)) t += ".";
  if (Math.random() < 0.35) {
    const tails = [" No worries.", " Too easy.", " Yeah right.", " No dramas."];
    t += tails[Math.floor(Math.random()*tails.length)];
  }

  // mood mirroring micro-cue
  if (mood === "frustrated" || mood === "sad") {
    if (Math.random() < 0.6) t = "Yeah, I hear you—" + t.charAt(0).toLowerCase() + t.slice(1);
  } else if (mood === "excited") {
    if (Math.random() < 0.6) t = "Nice! " + t;
  }

  // hint tiny natural hesitation occasionally
  if (Math.random() < 0.35) {
    const cues = ["mm,", "ah,", "okay,"];
    t = cues[Math.floor(Math.random()*cues.length)] + " " + t;
  }

  return t;
}

// tiny quick-ack voice to feel immediate
async function speakAck() {
  const short = randomPick(backchannels);
  return speak(short);
}

// ---------- ElevenLabs TTS ----------
async function speak(text) {
  const content = text && text.trim() ? text : "Sorry, could you repeat that?";
  const r = await axios.post(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`,
    {
      text: content,
      // low-latency general model (non-streaming). Keep stable + natural.
      model_id: "eleven_turbo_v2",
      voice_settings: {
        stability: 0.35,
        similarity_boost: 0.92,
        style: 0.45,
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

// ---------- Twilio basic endpoints ----------
app.get("/", (_req, res) => {
  res.type("text/plain").send("✅ Sammy v3 is running. Twilio uses POST /voice");
});
app.get("/health", (_req, res) => {
  res.json({ ok:true, service:"sammy-voice-v3", time:new Date().toISOString() });
});
app.get("/voice", (_req, res) => res.status(405).type("text/plain").send("Use POST /voice"));

// ---------- Main call loop ----------
app.post("/voice", async (req, res) => {
  const callSid = req.body.CallSid;
  const from    = (req.body.From || "").trim();
  const speech  = (req.body.SpeechResult || "").trim();

  const s = getSession(callSid, from);

  try {
    // First arrival: greet fast, then listen
    if (!s.greeted) {
      s.greeted = true;

      const profile = profileForCaller(from);
      const system  = baseSystemPrompt(profile);
      const greet   = await openAIChat([
        { role:"system", content: system },
        { role:"user", content: "Caller just connected. Greet very naturally in 1 short sentence, then ask a tiny open question." }
      ]);

      const shaped = shapeReply(greet, s.lastMood);
      addAssistant(callSid, shaped);

      // Play quick ack THEN greeting (two clips) for realism
      const [ackUrl, greetUrl] = await Promise.all([speakAck(), speak(shaped)]);

      return res.type("text/xml").send(`
        <Response>
          <Play>${ackUrl}</Play>
          <Play>${greetUrl}</Play>
          <Gather input="speech" action="/voice" speechTimeout="auto" bargeIn="true"/>
        </Response>
      `);
    }

    // No speech captured
    if (!speech) {
      const ackUrl = await speakAck();
      const askUrl = await speak("Sorry, didn’t catch that—what did you say?");
      return res.type("text/xml").send(`
        <Response>
          <Play>${ackUrl}</Play>
          <Play>${askUrl}</Play>
          <Gather input="speech" action="/voice" speechTimeout="auto" bargeIn="true"/>
        </Response>
      `);
    }

    // capture user turn
    addUser(callSid, speech);

    // analyze mood + possible name
    try {
      const analysis = await analyzeUser(speech);
      s.lastMood = analysis.mood || s.lastMood;
      if (analysis.name && !s.name) {
        s.name = analysis.name;
        updateLongTerm(from, { name:s.name, mood:s.lastMood, fact:`They said their name is ${s.name}.` });
      } else {
        updateLongTerm(from, { mood:s.lastMood });
      }
    } catch { /* non-fatal */ }

    // build system + chat context
    const profile = profileForCaller(from);
    const system  = baseSystemPrompt(profile);
    const messages = [{ role:"system", content: system }, ...s.history];

    // quick micro-ack so the caller feels heard immediately
    const ackUrlPromise = speakAck();

    // craft reply
    let reply = await openAIChat(messages);
    reply = shapeReply(reply, s.lastMood);
    addAssistant(callSid, reply);

    // end?
    if (shouldEnd(speech, s.turns)) {
      const [ackUrl, byeUrl] = await Promise.all([ackUrlPromise, speak(reply)]);
      return res.type("text/xml").send(`
        <Response>
          <Play>${ackUrl}</Play>
          <Play>${byeUrl}</Play>
          <Hangup/>
        </Response>
      `);
    }

    // speak reply
    const replyUrl = await speak(reply);
    const ackUrl   = await ackUrlPromise;

    // We play: short ack → the proper line → immediately Gather with bargeIn
    return res.type("text/xml").send(`
      <Response>
        <Play>${ackUrl}</Play>
        <Play>${replyUrl}</Play>
        <Gather input="speech" action="/voice" speechTimeout="auto" bargeIn="true"/>
      </Response>
    `);

  } catch (err) {
    console.error("Sammy v3 error:", err?.response?.data || err.message || err);
    const ackUrl = await speakAck();
    const fallback = await speak("Ah, my bad—hit a snag. Mind trying that again?");
    return res.type("text/xml").send(`
      <Response>
        <Play>${ackUrl}</Play>
        <Play>${fallback}</Play>
        <Gather input="speech" action="/voice" speechTimeout="auto" bargeIn="true"/>
      </Response>
    `);
  }
});

// ---------- launch ----------
app.listen(PORT, () => {
  console.log(`Sammy v3 live on ${PORT}`);
});
