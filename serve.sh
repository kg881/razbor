#!/bin/bash
# YouTube IFrame API не работает по file:// (уникальный origin → postMessage не проходит).
# Поэтому прототип открываем только по http.
cd "$(dirname "$0")"
PORT=${1:-8777}
echo "→ http://localhost:$PORT/index.html"
python3 -m http.server "$PORT" --bind 127.0.0.1
