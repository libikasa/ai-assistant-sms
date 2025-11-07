console.log("Widget JS läuft");

document.addEventListener("DOMContentLoaded", () => {
  // === Chat-Bubble erstellen ===
  const chatBubble = document.createElement("div");
  chatBubble.id = "chat-bubble";
  Object.assign(chatBubble.style, {
    position: "fixed",
    bottom: "20px",
    right: "20px",
    width: "60px",
    height: "60px",
    background: "#4f46e5",
    borderRadius: "50%",
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    color: "white",
    fontSize: "30px",
    cursor: "pointer",
    zIndex: 9999
  });
  chatBubble.innerHTML = "💬";
  document.body.appendChild(chatBubble);

  // === Chat-Container erstellen ===
  const chatWidget = document.createElement("div");
  chatWidget.id = "chat-container";
  Object.assign(chatWidget.style, {
    position: "fixed",
    bottom: "90px",
    right: "20px",
    width: "350px",
    height: "450px",
    background: "white",
    border: "1px solid #ccc",
    borderRadius: "12px",
    display: "none",
    flexDirection: "column",
    fontFamily: "sans-serif",
    boxShadow: "0 4px 10px rgba(0,0,0,0.2)",
    zIndex: 9998
  });
  document.body.appendChild(chatWidget);

  // === Header & Close ===
  chatWidget.innerHTML = `
    <div id="chat-header" style="
      background: #4f46e5; color: white; padding: 10px;
      border-top-left-radius: 12px; border-top-right-radius: 12px;
      display: flex; justify-content: space-between; align-items: center;
    ">
      <strong>AI-Assistent 🤖</strong>
      <span id="chat-close" style="cursor:pointer;">✖</span>
    </div>
    <div id="chat-messages" style="flex: 1; padding: 10px; overflow-y: auto;"></div>
    <div style="display: flex; border-top: 1px solid #ccc;">
      <input id="chat-input" type="text" placeholder="Nachricht eingeben..." style="flex:1; border:none; padding:10px; outline:none;">
      <button id="chat-send" type="button" style="background:#4f46e5; color:white; border:none; padding:10px 15px; cursor:pointer;">➤</button>
    </div>
  `;

  // === Öffnen/Schließen ===
  chatBubble.addEventListener("click", () => {
    chatWidget.style.display = chatWidget.style.display === "flex" ? "none" : "flex";
  });
  document.getElementById("chat-close").addEventListener("click", () => {
    chatWidget.style.display = "none";
  });

  const messages = document.getElementById("chat-messages");
  const input = document.getElementById("chat-input");
  const sendBtn = document.getElementById("chat-send");

  // === Erste Nachricht vom Bot direkt beim Laden ===
  addMessage("AI", "Hallo! Ich bin dein AI-Assistent. Wie kann ich Ihnen helfen?");

  // === Send-Event ===
  sendBtn.addEventListener("click", sendMessage);
  input.addEventListener("keypress", (e) => { if(e.key==="Enter") sendMessage(); });

  // === Helper: Nachricht hinzufügen ===
  function addMessage(sender, text) {
    const div = document.createElement("div");
    div.style.marginBottom = "8px";
    if(sender === "AI") div.style.color = "#4f46e5";
    div.innerHTML = `<strong>${sender}:</strong> ${text}`;
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
  }

  // === Funktion: Nachricht senden ===
  async function sendMessage() {
    const text = input.value.trim();
    if(!text) return;
    addMessage("Du", text);
    input.value = "";

    try {
      const res = await fetch("/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          userLang: navigator.language.substring(0,2),
          userEmail: "" // optional: kann hier E-Mail des Kunden übergeben werden
        })
      });
      const data = await res.json();
      addMessage("AI", data.reply || "Entschuldigung, ich konnte nicht antworten.");
    } catch(err) {
      console.error(err);
      addMessage("AI", "Fehler bei der Kommunikation mit dem Server.");
    }
  }
});
