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
async function handleUserMessage(userId, message) {
  const tokens = loadToken();
  if (!tokens) return "❌ Bot ist nicht verbunden. Bitte Google Setup durchführen.";

  oauth2Client.setCredentials(tokens);

  // Session laden oder neu anlegen
  const session = sessions.get(userId) || { stage: "start", data: {} };
  sessions.set(userId, session); // sofort speichern

  // Nachricht bereinigen für Datum/Uhrzeit-Erkennung
  const cleanedText = (message || "").replace(/\b(um|gegen|Uhr)\b/gi, "").trim();
  const textLower = cleanedText.toLowerCase();
  let reply = "";

  try {
    // ==========================
    // Stage: start / awaiting_date
    // ==========================
    if (session.stage === "start" || session.stage === "awaiting_date") {
      if (textLower.includes("termin") && session.stage === "start") {
        reply = "Klar! Für wann möchten Sie den Termin vereinbaren? (TT.MM.JJJJ)";
        session.stage = "awaiting_date";
      } else {
        // Datum + Zeit erkennen
        const dateMatch = cleanedText.match(/\d{1,2}\.\d{1,2}\.\d{4}/);
        const timeMatch = cleanedText.match(/\d{1,2}(:\d{2})?/);

        if (dateMatch) session.data.date = dateMatch[0];
        if (timeMatch) session.data.time = timeMatch[0];

        if (session.data.date && session.data.time) {
          reply = "Perfekt! Wie lange soll das Meeting dauern? (z. B. 30 oder 60 Minuten)";
          session.stage = "awaiting_duration";
        } else if (!session.data.date) {
          reply = "Für wann möchten Sie den Termin vereinbaren? (TT.MM.JJJJ)";
          session.stage = "awaiting_date";
        } else if (!session.data.time) {
          reply = `Super! Zu welcher Uhrzeit am ${session.data.date} würde es Ihnen passen?`;
          session.stage = "awaiting_time";
        }
      }
    }

    // ==========================
    // Stage: awaiting_time
    // ==========================
    else if (session.stage === "awaiting_time") {
      const timeMatch = cleanedText.match(/\d{1,2}(:\d{2})?/);
      if (timeMatch) {
        session.data.time = timeMatch[0];
        reply = "Perfekt! Wie lange soll das Meeting dauern? (z. B. 30 oder 60 Minuten)";
        session.stage = "awaiting_duration";
      } else {
        reply = "Bitte geben Sie eine Uhrzeit an, z. B. 10:00 Uhr.";
      }
    }

    // ==========================
    // Stage: awaiting_duration
    // ==========================
    else if (session.stage === "awaiting_duration") {
      const durMatch = cleanedText.match(/\d+/);
      if (durMatch) {
        session.data.duration = parseInt(durMatch[0]);
        reply = "Alles klar. Bitte geben Sie Ihre E-Mail-Adresse an, damit ich den Termin eintragen kann.";
        session.stage = "awaiting_email";
      } else {
        reply = "Wie lange soll der Termin dauern (in Minuten)?";
      }
    }

    // ==========================
    // Stage: awaiting_email
    // ==========================
    else if (session.stage === "awaiting_email") {
      const emailMatch = cleanedText.match(/[^\s@]+@[^\s@]+\.[^\s@]+/);
      if (emailMatch) {
        session.data.email = emailMatch[0];
        reply = "Einen Moment, ich prüfe, ob der Termin verfügbar ist …";
        session.stage = "creating";
      } else {
        reply = "Bitte geben Sie eine gültige E-Mail-Adresse an.";
      }
    }

    // ==========================
    // Stage: creating
    // ==========================
    if (session.stage === "creating") {
      const { date, time, duration, email } = session.data;

      if (!date || !time || !duration || !email) {
        reply = "❌ Es fehlen noch Informationen. Bitte geben Sie Datum, Uhrzeit, Dauer und E-Mail an.";
        session.stage = !date ? "awaiting_date" : !time ? "awaiting_time" : !duration ? "awaiting_duration" : "awaiting_email";
      } else {
        try {
          const start = parseGermanDateTime(date, time);
          const end = new Date(start.getTime() + duration * 60000);
          const startIso = toLocalISOStringWithOffset(start);
          const endIso = toLocalISOStringWithOffset(end);

          const free = await isSlotFree(oauth2Client, startIso, endIso);
          if (!free) {
            reply = "⚠️ Dieser Zeitraum ist leider schon belegt. Bitte schlagen Sie eine andere Zeit vor.";
            session.stage = "awaiting_time";
          } else {
            const event = await createEvent(oauth2Client, {
              summary: "Beratungstermin zur Finanzierung",
              startIso,
              endIso,
              attendeeEmail: email,
            });
            const meetLink = event.hangoutLink || event.conferenceData?.entryPoints?.[0]?.uri || "kein Link verfügbar";
            reply = `✅ Termin am ${date} um ${time} wurde erfolgreich eingetragen.\n📧 Einladung an ${email}.\n🔗 Google Meet Link: ${meetLink}`;
            session.stage = "completed";
          }
        } catch (err) {
          console.error(err);
          reply = "❌ Es gab einen Fehler bei der Verarbeitung Ihrer Anfrage.";
          session.stage = "awaiting_email"; // zurücksetzen auf letzte Eingabe
        }
      }
    }

    // ==========================
    // Stage: completed
    // ==========================
    else if (session.stage === "completed") {
      reply = "✅ Der Termin wurde bereits vereinbart. Möchten Sie noch etwas besprechen?";
    }

    sessions.set(userId, session); // Session speichern
    return reply;

  } catch (err) {
    console.error("❌ Chat-Fehler:", err);
    return "❌ Es gab einen Fehler bei der Verarbeitung Ihrer Anfrage.";
  }
}



// === Webchat Endpoint ===
app.post("/chat", async (req, res) => {
  const { message, userLang, userEmail } = req.body;
  const userId = userEmail || req.ip;
  const reply = await handleUserMessage(userId, message);
  res.json({ reply });
});

// === Twilio Incoming SMS ===
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
});

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
