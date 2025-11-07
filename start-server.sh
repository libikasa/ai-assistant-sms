#!/bin/bash

# In den Backend-Ordner wechseln
cd "/Users/libikasa/ai-assistant-v3/backend"

# Prüfen, ob Port 3000 belegt ist, ggf. alten Prozess killen
if lsof -i :3002 >/dev/null; then
    echo "Port 3000 belegt, beende alten Prozess..."
    kill -9 $(lsof -t -i :3002)
fi

# Server starten (ESM-kompatibel)
node serverv3.js &

# Kurze Pause, damit Server hochfährt
sleep 2

# Frontend im Safari öffnen
open -a "Safari" "http://localhost:3002"
