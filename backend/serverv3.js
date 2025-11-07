// serverv3.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { google } from "googleapis";
import OpenAI from "openai";
import Twilio from "twilio";
import nodemailer from "nodemailer";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();

// parse JSON and form-encoded (Twilio posts form data)
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CONFIG
const PORT = process.env.PORT || 3002;
const BOT_NAME = process.env.BOT_NAME || "Jean-Mikael Lavoie";
const TOKEN_FILE = path.join(__dirname, "token.json");
const DEFAULT_COUNTRY = process.env.DEFAULT_COUNTRY_CODE || "+49"; // fallback

// OpenAI
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Twilio
const twilioClient = Twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
async function sendSms(to, body) {
  if (!to) throw new Error("Kein Ziel-Telefonnummer");
  const toNorm = normalizePhone(to);
  return twilioClient.messages.create({
    from: process.env.TWILIO_PHONE,
    to: toNorm,
    body,
  });
}

// Nodemailer
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
});
async function sendEmail(to, subject, text) {
  await transporter.sendMail({ from: process.env.EMAIL_USER, to, subject, text });
}

// Google OAuth
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);
function saveToken(token) { fs.writeFileSync(TOKEN_FILE, JSON.stringify(token, null, 2)); }
function loadToken() { if (!fs.existsSync(TOKEN_FILE)) return null; return JSON.parse(fs.readFileSync(TOKEN_FILE)); }

// Sessions (keyed by phone E.164)
const sessions = new Map();

// Helpers
function normalizePhone(phone) {
  if (!phone) return phone;
  phone = phone.trim();
  if (phone.startsWith("+")) return phone;
  const cleaned = phone.replace(/[^\d]/g, "");
  return `${DEFAULT_COUNTRY}${cleaned}`;
}

function pad(n){ return n.toString().padStart(2,'0'); }
function toLocalISOStringWithOffset(date) {
  const year = date.getFullYear();
  const month = pad(date.getMonth()+1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());
  const tzOffset = -date.getTimezoneOffset();
  const sign = tzOffset >= 0 ? "+" : "-";
  const tzHour = pad(Math.floor(Math.abs(tzOffset)/60));
  const tzMin = pad(Math.abs(tzOffset)%60);
  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}${sign}${tzHour}:${tzMin}`;
}

// Kalender-Helper (Google)
async function isSlotFree(authClient, startIso, endIso) {
  const calendar = google.calendar({ version: "v3", auth: authClient });
  const events = await calendar.events.list({
    calendarId: "primary",
    timeMin: startIso,
    timeMax: endIso,
    singleEvents: true,
    orderBy: "startTime",
  });
  return (events.data.items || []).length === 0;
}
async function createEvent(authClient, { summary, startIso, endIso, attendeeEmail }) {
  const calendar = google.calendar({ version: "v3", auth: authClient });
  const eventBody = {
    summary,
    start: { dateTime: startIso },
    end: { dateTime: endIso },
    attendees: attendeeEmail ? [{ email: attendeeEmail }] : [],
    conferenceData: { createRequest: { requestId: `meet-${Date.now()}`, conferenceSolutionKey: { type: "hangoutsMeet" } } },
  };
  const res = await calendar.events.insert({
    calendarId: "primary",
    requestBody: eventBody,
    conferenceDataVersion: 1,
    sendUpdates: "all",
  });
  return res.data;
}

// Utility: parse German date/time -> local Date object
function parseGermanDateTime(dateDDMMYYYY, timeStr) {
  const [d,m,y] = dateDDMMYYYY.split(".").map(s => parseInt(s,10));
  let hh = 0, mm = 0;
  const tMatch = (timeStr || "").match(/(\d{1,2})(?::(\d{2}))?/);
  if (tMatch) { hh = parseInt(tMatch[1],10); mm = tMatch[2]?parseInt(tMatch[2],10):0; }
  return new Date(y,m-1,d,hh,mm,0,0);
}

// ----------------------- Endpoints -----------------------

// 1) GHL Lead webhook -> start session + welcome SMS
app.post("/lead-webhook", async (req, res) => {
  try {
    const body = req.body || {};
    const firstName = body.firstName || body.first_name || "";
    const lastName  = body.lastName || body.last_name || "";
    const phoneRaw  = body.phone || body.phone_number || body.mobile || "";
    const email     = body.email || "";

    if (!phoneRaw) return res.status(400).json({ error: "Lead ohne Telefonnummer" });

    const phone = normalizePhone(phoneRaw);
    const greeting = `Hallo ${firstName} ${lastName}, hier ist ${BOT_NAME} – danke für Ihre Anfrage! Ich werde Ihnen ein paar Fragen stellen, um Ihre Bedürfnisse als Mortgage-Broker-Kunde besser zu verstehen.`;

    sessions.set(phone, { stage: "start", data: { firstName, lastName, email, company: body.company || "" } });
    await sendSms(phone, greeting);

    console.log("✅ Lead verarbeitet, Begrüßung gesendet an", phone);
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("❌ /lead-webhook Fehler:", err);
    return res.status(500).json({ error: "Lead konnte nicht verarbeitet werden" });
  }
});

// 2) Twilio Incoming SMS -> AI Chat + Termin
app.post("/twilio/incoming-sms", async (req,res)=>{
  try {
    const from = req.body.From;
    const body = (req.body.Body||"").trim();
    if(!from) return res.status(400).send("No From");

    const phone = normalizePhone(from);
    const session = sessions.get(phone) || { stage: "start", data:{} };
    let reply="";

    const text = body.toLowerCase();

    if(session.stage==="start"){
      const prompt = `
Du bist ${BOT_NAME}, ein Mortgage Broker. Der Lead hat bereits Interesse gezeigt.
Stelle gezielt qualifizierende Fragen:
- Budget
- gewünschte Laufzeit
- Art der Finanzierung
- Zeitpunkt der Entscheidung
Antworte freundlich und kurz. 
Nutzer: "${body}"`;
      const aiRes = await openai.chat.completions.create({
        model:"gpt-3.5-turbo",
        messages:[{role:"user",content:prompt}],
        temperature:0.7
      });
      reply = aiRes.choices?.[0]?.message?.content?.trim() || "Danke für Ihre Nachricht! Wie kann ich helfen?";
      session.stage="awaiting_date";
    } else if(session.stage==="awaiting_date"){
      const dateMatch = text.match(/\d{1,2}\.\d{1,2}\.\d{4}/);
      if(dateMatch){ session.data.date=dateMatch[0]; reply=`Super! Zu welcher Uhrzeit am ${dateMatch[0]} würde es Ihnen passen?`; session.stage="awaiting_time";}
      else reply="Bitte Datum im Format TT.MM.JJJJ angeben, z.B. 08.11.2025.";
    } else if(session.stage==="awaiting_time"){
      const timeMatch = text.match(/\d{1,2}(:\d{2})?/);
      if(timeMatch){ session.data.time=timeMatch[0]; reply="Wie lange soll das Gespräch dauern (Minuten)?"; session.stage="awaiting_duration";}
      else reply="Bitte Uhrzeit angeben, z.B. 10:00.";
    } else if(session.stage==="awaiting_duration"){
      const durMatch=text.match(/\d+/);
      if(durMatch){ session.data.duration=parseInt(durMatch[0],10); reply="Bitte Ihre E-Mail-Adresse für die Einladung angeben"; session.stage="awaiting_email";}
      else reply="Dauer in Minuten angeben, z.B. 30 oder 60.";
    } else if(session.stage==="awaiting_email"){
      const emailMatch = text.match(/[^\s@]+@[^\s@]+\.[^\s@]+/);
      if(emailMatch){ session.data.email=emailMatch[0]; reply="Danke, ich trage den Termin ein…"; session.stage="creating";}
      else reply="Bitte gültige E-Mail-Adresse senden.";
    }

    if(session.stage==="creating"){
      const tokens=loadToken();
      if(!tokens){ reply="Kalender nicht verbunden."; }
      else{
        oauth2Client.setCredentials(tokens);
        const {date,time,duration,email} = session.data;
        try{
          const start=parseGermanDateTime(date,time);
          const end=new Date(start.getTime() + (duration||30)*60000);
          const startIso=toLocalISOStringWithOffset(start);
          const endIso=toLocalISOStringWithOffset(end);
          const free = await isSlotFree(oauth2Client,startIso,endIso);
          if(!free){ reply="⚠️ Zeitraum belegt. Andere Zeit vorschlagen."; session.stage="awaiting_time"; }
          else{
            const ev = await createEvent(oauth2Client,{summary:"Beratungsgespräch Mortgage Broker",startIso,endIso,attendeeEmail:email});
            const meetLink=ev.hangoutLink||ev.conferenceData?.entryPoints?.[0]?.uri||"kein Link";
            reply=`✅ Termin am ${date} um ${time} eingetragen. Einladung an ${email} gesendet. Link: ${meetLink}`;
            // optional E-Mail
            await sendEmail(email,"Ihr Termin Mortgage Broker",`Ihr Termin wurde gebucht: ${date} ${time}. Link: ${meetLink}`);
            session.stage="completed";
          }
        }catch(e){ console.error(e); reply="Fehler beim Erstellen des Termins."; }
      }
    }

    sessions.set(phone,session);
    await sendSms(phone,reply);
    return res.status(200).send("OK");

  }catch(err){ console.error(err); return res.status(500).send("Server error"); }
});

// Serve frontend
const frontendPath=path.join(__dirname,"../frontend");
app.use(express.static(frontendPath));
app.get("/",(req,res)=>res.sendFile(path.join(frontendPath,"indexv3.html")));

// Start server
app.listen(PORT,()=>console.log(`✅ Server läuft auf Port ${PORT}`));
