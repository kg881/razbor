#!/bin/bash
# YouTube IFrame API не работает по file:// (уникальный origin → postMessage не проходит).
# Поэтому прототип открываем только по http.
#
# Слушаем ВСЕ интерфейсы, а не 127.0.0.1: с телефона приложение открывается по
# LAN-адресу Мака (http://<ip>:8777), и на bind 127.0.0.1 телефон видел пустоту —
# соединение просто не устанавливалось (жалоба 18.08.2026).
cd "$(dirname "$0")"
PORT=${1:-8777}
IP=$(ipconfig getifaddr en0 2>/dev/null)
echo "→ на этом Маке:  http://localhost:$PORT/index.html"
[ -n "$IP" ] && echo "→ с телефона:    http://$IP:$PORT/index.html  (тот же Wi-Fi)"
python3 -m http.server "$PORT" --bind 0.0.0.0
