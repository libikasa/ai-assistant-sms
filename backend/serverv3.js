import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { google } from "googleapis";
import OpenAI from "openai";
import twilio from "twilio";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// === Twilio Setup ===
const twilioClient = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH);
const TWILIO_NUMBER = process.env.TWILIO_NUMBER;

// === Google OAuth Setup ===
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

const TOKEN_FILE = path.join(__dirname, "token.json");

function saveToken(token) {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(token, null, 2));
}
function loadToken() {
  if (!fs.existsSync(TOKEN_FILE)) return null;
  return JSON.parse(fs.readFileSync(TOKEN_FILE));
}

// === OpenAI Setup ===
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// === Simple memory for user sessions ===
const sessions = new Map();

// === Google OAuth Routes ===
app.get("/setup/google", (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [
      "https://www.googleapis.com/auth/calendar",
      "https://www.googleapis.com/auth/calendar.events",
      "https://www.googleapis.com/auth/userinfo.email",
      "openid",
    ],
  });
  res.redirect(url);
});

app.get("/auth/google/callback", async (req, res) => {
  try {
    const { tokens } = await oauth2Client.getToken(req.query.code);
    saveToken(tokens);
    res.send("<h2>✅ Kalender erfolgreich verbunden! Bot ist einsatzbereit.</h2>");
  } catch (err) {
    console.error(err);
    res.status(500).send("❌ Fehler bei der Google-Verbindung.");
  }
});

// === Kalender-Helper ===
async function isSlotFree(authClient, start, end) {
  const calendar = google.calendar({ version: "v3", auth: authClient });
  const events = await calendar.events.list({
    calendarId: "primary",
    timeMin: start,
    timeMax: end,
    singleEvents: true,
  });
  return events.data.items.length === 0;
}

async function createEvent(authClient, { summary, startIso, endIso, attendeeEmail }) {
  const calendar = google.calendar({ version: "v3", auth: authClient });

  const event = {
    summary,
    start: { dateTime: startIso },
    end: { dateTime: endIso },
    attendees: [{ email: attendeeEmail }],
    conferenceData: {
      createRequest: {
        requestId: `meet-${Date.now()}`,
        conferenceSolutionKey: { type: "hangoutsMeet" },
      },
    },
  };

  const response = await calendar.events.insert({
    calendarId: "primary",
    resource: event,
    conferenceDataVersion: 1,
    sendUpdates: "all",
  });

  return response.data;
}

// === Helper für Datum & Uhrzeit ===
function parseGermanDateTime(dateStr, timeStr) {
  const [day, month, year] = dateStr.split(".").map(Number);
  const [hour, minute = 0] = timeStr.split(":").map(Number);
  return new Date(year, month - 1, day, hour, minute);
}
function toLocalISOStringWithOffset(date) {
  const tzOffset = date.getTimezoneOffset() * 60000;
  const localISOTime = new Date(date - tzOffset).toISOString().slice(0, -1);
  return localISOTime;
}

// === Gemeinsame Logik für Chat & SMS ===
// === Handle User Message (v2-style, Twilio-kompatibel) ===
async function handleUserMessage(userPhone, message, userLang = "de") {
  // Session
  const session = sessions.get(userPhone) || { stage: "start", data: {} };
  sessions.set(userPhone, session);

  const text = (message || "").toLowerCase();
  let reply = "";

  try {
    // === Start / AI-Prompt ===
    if (session.stage === "start") {
      if (text.includes("termin")) {
        reply = "Klar! Für wann möchten Sie den Termin vereinbaren?";
        session.stage = "awaiting_date";
      } else {
        // AI-Prompt **ohne Google Calendar**
        const prompt = `
          Du bist ${BOT_NAME}, Mortgage Broker. Lead hat Interesse an einer Hypothek.
          Antworte freundlich, stelle qualifizierte Fragen, leite ggf. zur Terminbuchung über.
          Nutzer: "${message}" (${userLang})
        `;
        const aiRes = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: prompt }],
          temperature: 0.7,
        });
        reply = aiRes.choices[0].message.content.trim();
      }
    }

    // === Termin Flow ===
    else if (session.stage === "awaiting_date") { ... } // unverändert
    else if (session.stage === "awaiting_time") { ... }
    else if (session.stage === "awaiting_duration") { ... }
    else if (session.stage === "awaiting_email") { ... }

    // === Termin erstellen (Token hier prüfen) ===
    else if (session.stage === "creating") {
      const tokens = loadToken();
      if (!tokens) return "❌ Bot ist nicht verbunden. Bitte zuerst Google Setup durchführen.";

      oauth2Client.setCredentials(tokens);

      const { date, time, duration, email } = session.data;
      // ... Rest bleibt gleich
    }

    else if (session.stage === "completed") {
      reply = "✅ Der Termin wurde bereits vereinbart. Möchten Sie noch etwas besprechen?";
    }

    sessions.set(userPhone, session);
    return reply;
  } catch (err) {
    console.error("❌ Chat-Fehler:", err);
    return "❌ Es gab einen Fehler bei der Verarbeitung Ihrer Anfrage.";
  }
}


// === Twilio Incoming SMS Endpoint ===
app.post("/twilio/incoming-sms", async (req, res) => {
  try {
    const from = normalizePhone(req.body.From);
    const body = req.body.Body || "";
    const reply = await handleUserMessage(from, body);
    await sendSms(from, reply);
    res.status(200).send("OK");
  } catch (err) {
    console.error(err);
    res.status(500).send("Server error");
  }
});




// === Webchat Endpoint ===
app.post("/chat", async (req, res) => {
  const { message, userLang, userEmail } = req.body;
  const userId = userEmail || req.ip;
  const reply = await handleUserMessage(userId, message);
  res.json({ reply });
});

// === Twilio Incoming SMS ===
/*
app.post("/twilio/incoming-sms", async (req, res) => {
  const from = req.body.From;
  const body = req.body.Body;
  const reply = await handleUserMessage(from, body);

  const twimlResponse = `
    <Response>
      <Message>${reply}</Message>
    </Response>
  `;

  res.type("text/xml").send(twimlResponse);
});*/

// === Lead-WebHook (GHL etc.) ===
app.post("/lead", async (req, res) => {
  try {
    const lead = req.body;
    console.log("📩 Neuer Lead empfangen:", lead);

    if (lead.phone) {
      await twilioClient.messages.create({
        from: TWILIO_NUMBER,
        to: lead.phone,
        body: `Hallo ${lead.name || ""}! Hier ist dein persönlicher KI-Assistent. Danke für dein Interesse! Antworte einfach, um deine Beratung zu starten.`,
      });
    }

    res.json({ success: true });
  } catch (err) {
    console.error("❌ Fehler bei Lead:", err);
    res.status(500).json({ error: "Fehler beim Senden der SMS" });
  }
});

// === Frontend bereitstellen ===
const frontendPath = path.join(__dirname, "../frontend");
app.use(express.static(frontendPath));
app.get("/", (req, res) => res.sendFile(path.join(frontendPath, "indexv3.html")));

// === Server starten ===
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`✅ Server läuft auf Port ${PORT}`));
