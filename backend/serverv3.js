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

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Config
const PORT = process.env.PORT || 3002;
const BOT_NAME = process.env.BOT_NAME || "Jean-Mikael Lavoie";
const TOKEN_FILE = path.join(__dirname, "token.json");
const DEFAULT_COUNTRY = process.env.DEFAULT_COUNTRY_CODE || "+49";

// OpenAI
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Twilio
const twilioClient = Twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
async function sendSms(to, body) {
  if (!to) throw new Error("Keine Telefonnummer angegeben");
  const toNorm = normalizePhone(to);
  return twilioClient.messages.create({ from: process.env.TWILIO_PHONE, to: toNorm, body });
}

// Google OAuth
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

function saveToken(token) { fs.writeFileSync(TOKEN_FILE, JSON.stringify(token, null, 2)); }
function loadToken() { if (!fs.existsSync(TOKEN_FILE)) return null; return JSON.parse(fs.readFileSync(TOKEN_FILE)); }

// Sessions
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
  const year=date.getFullYear(), month=pad(date.getMonth()+1), day=pad(date.getDate());
  const hours=pad(date.getHours()), minutes=pad(date.getMinutes()), seconds=pad(date.getSeconds());
  const tzOffset=-date.getTimezoneOffset(), sign=tzOffset>=0?"+":"-";
  const tzHour=pad(Math.floor(Math.abs(tzOffset)/60)), tzMin=pad(Math.abs(tzOffset)%60);
  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}${sign}${tzHour}:${tzMin}`;
}

function parseGermanDateTime(dateDDMMYYYY,timeStr){
  const [d,m,y]=dateDDMMYYYY.split(".").map(s=>parseInt(s,10));
  let hh=0, mm=0;
  const tMatch=(timeStr||"").match(/(\d{1,2})(?::(\d{2}))?/);
  if(tMatch){ hh=parseInt(tMatch[1],10); mm=tMatch[2]?parseInt(tMatch[2],10):0; }
  return new Date(y,m-1,d,hh,mm,0,0);
}

// Google Calendar
async function isSlotFree(authClient,startIso,endIso){
  const calendar=google.calendar({version:"v3",auth:authClient});
  const events=await calendar.events.list({ calendarId:"primary", timeMin:startIso, timeMax:endIso, singleEvents:true, orderBy:"startTime" });
  return (events.data.items||[]).length===0;
}

async function createEvent(authClient,{summary,startIso,endIso,attendeeEmail}){
  const calendar=google.calendar({version:"v3",auth:authClient});
  const eventBody={ summary, start:{dateTime:startIso}, end:{dateTime:endIso}, attendees:attendeeEmail?[{email:attendeeEmail}]:[], conferenceData:{createRequest:{requestId:`meet-${Date.now()}`, conferenceSolutionKey:{type:"hangoutsMeet"}}} };
  const res=await calendar.events.insert({ calendarId:"primary", requestBody:eventBody, conferenceDataVersion:1, sendUpdates:"all" });
  return res.data;
}

// -------------------- Lead Webhook --------------------
app.post("/lead-webhook", async(req,res)=>{
  try{
    const body=req.body||{};
    const firstName=body.firstName||body.first_name||"";
    const lastName=body.lastName||body.last_name||"";
    const phoneRaw=body.phone||body.phone_number||"";
    if(!phoneRaw) return res.status(400).json({error:"Lead ohne Telefonnummer"});
    const phone=normalizePhone(phoneRaw);
    const greeting=`Hallo ${firstName} ${lastName}, hier ist ${BOT_NAME} – danke für Ihre Anfrage! Wie kann ich Ihnen am besten helfen?`;
    sessions.set(phone,{stage:"start",data:{firstName,lastName}});
    await sendSms(phone,greeting);
    res.status(200).json({success:true});
  }catch(e){ console.error(e); res.status(500).json({error:e.message}); }
});

// -------------------- Twilio Incoming SMS --------------------
async function handleUserMessage(userPhone,message){
  const session=sessions.get(userPhone)||{stage:"start",data:{}};
  sessions.set(userPhone,session);
  const text=(message||"").toLowerCase();
  let reply="";

  try{
    // === STAGE LOGIC ===
    if(session.stage==="start"){
      if(text.includes("termin")){ reply="Klar! Für wann möchten Sie den Termin vereinbaren?"; session.stage="awaiting_date"; }
      else{
        try{
          const prompt=`Du bist ${BOT_NAME}, Mortgage Broker. Lead hat Interesse an einer Hypothek. Antworte freundlich. Nutzer: "${message}"`;
          const aiRes=await openai.chat.completions.create({ model:"gpt-4o-mini", messages:[{role:"user",content:prompt}], temperature:0.7 });
          reply=aiRes?.choices?.[0]?.message?.content?.trim()||"Danke für Ihre Nachricht! Wie kann ich helfen?";
        }catch(err){ console.error("❌ Fehler beim OpenAI-Call:",err); reply="❌ AI momentan nicht verfügbar. Bitte später erneut versuchen."; }
      }
    }
    else if(session.stage==="awaiting_date"){
      const dateMatch=text.match(/\d{1,2}\.\d{1,2}\.\d{4}/);
      if(dateMatch){ session.data.date=dateMatch[0]; reply=`Super! Zu welcher Uhrzeit am ${dateMatch[0]} möchten Sie den Termin?`; session.stage="awaiting_time"; }
      else reply="Bitte geben Sie ein Datum an, z. B. 08.11.2025.";
    }
    else if(session.stage==="awaiting_time"){
      const timeMatch=text.match(/(\d{1,2})(?::(\d{2}))?/);
      if(timeMatch){ session.data.time=`${timeMatch[1]}:${timeMatch[2]||"00"}`; reply="Perfekt. Wie lange soll das Meeting dauern? (z. B. 30 oder 60 Minuten)"; session.stage="awaiting_duration"; }
      else reply="Bitte geben Sie eine Uhrzeit an, z. B. 10:00 Uhr.";
    }
    else if(session.stage==="awaiting_duration"){
      const durMatch=text.match(/\d+/);
      if(durMatch){ session.data.duration=parseInt(durMatch[0],10); reply="Alles klar. Bitte geben Sie Ihre E-Mail-Adresse an, damit ich den Termin eintragen kann."; session.stage="awaiting_email"; }
      else reply="Wie lange soll der Termin dauern (in Minuten)?";
    }
    else if(session.stage==="awaiting_email"){
      const emailMatch=text.match(/[^\s@]+@[^\s@]+\.[^\s@]+/);
      if(emailMatch){ session.data.email=emailMatch[0]; reply="Einen Moment, ich prüfe, ob der Termin verfügbar ist …"; session.stage="creating"; }
      else reply="Bitte geben Sie eine gültige E-Mail-Adresse an.";
    }
    else if(session.stage==="creating"){
      const tokens=loadToken();
      if(!tokens){ reply="❌ Bot ist nicht verbunden. Bitte Google Setup durchführen."; return reply; }
      oauth2Client.setCredentials(tokens);
      const {date,time,duration,email}=session.data;
      const start=parseGermanDateTime(date,time);
      const end=new Date(start.getTime()+duration*60000);
      const startIso=toLocalISOStringWithOffset(start);
      const endIso=toLocalISOStringWithOffset(end);

      const free=await isSlotFree(oauth2Client,startIso,endIso);
      if(!free){ reply="⚠️ Dieser Zeitraum ist leider schon belegt. Bitte schlagen Sie eine andere Zeit vor."; session.stage="awaiting_time"; }
      else{
        const ev=await createEvent(oauth2Client,{summary:"Beratungstermin",startIso,endIso,attendeeEmail:email});
        const meetLink=ev.hangoutLink||ev.conferenceData?.entryPoints?.[0]?.uri||"kein Link verfügbar";
        reply=`✅ Termin am ${date} um ${time} wurde erfolgreich eingetragen.\n📧 Einladung an ${email} gesendet.\n🔗 Google Meet Link: ${meetLink}`;
        session.stage="completed";
      }
    }
    else if(session.stage==="completed"){ reply="✅ Der Termin wurde bereits vereinbart. Möchten Sie noch etwas besprechen?"; }

    sessions.set(userPhone,session);
    return reply;
  }catch(err){ console.error(err); return "❌ Es gab einen Fehler bei der Verarbeitung Ihrer Anfrage."; }
}

app.post("/twilio/incoming-sms", async(req,res)=>{
  try{
    const from=normalizePhone(req.body.From);
    const body=req.body.Body||"";
    const reply=await handleUserMessage(from,body);
    await sendSms(from,reply);
    res.status(200).send("OK");
  }catch(err){ console.error(err); res.status(500).send("Server error"); }
});

// Frontend
const frontendPath=path.join(__dirname,"../frontend");
app.use(express.static(frontendPath));
app.get("/",(req,res)=>res.sendFile(path.join(frontendPath,"indexv3.html")));

// Google OAuth
app.get("/setup/google",(req,res)=>{
  const url=oauth2Client.generateAuthUrl({ access_type:"offline", prompt:"consent", scope:["https://www.googleapis.com/auth/calendar","https://www.googleapis.com/auth/calendar.events"] });
  res.redirect(url);
});

app.get("/auth/google/callback",async(req,res)=>{
  const code=req.query.code;
  if(!code) return res.status(400).send("Kein Code erhalten.");
  try{ const {tokens}=await oauth2Client.getToken(code); saveToken(tokens); res.send("<h2>✅ Kalender erfolgreich verbunden! Bot ist einsatzbereit.</h2>"); }
  catch(err){ console.error(err); res.status(500).send("❌ Fehler bei der Google-Verbindung."); }
});

// Server
app.listen(PORT,()=>console.log(`✅ Server läuft auf Port ${PORT}`));
