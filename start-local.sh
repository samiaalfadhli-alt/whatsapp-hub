#!/usr/bin/env bash
# تشغيل WhatsApp Hub محليًا بدون Docker (Linux/macOS) مع cloudflared
set -e
cd "$(dirname "$0")"
[ -f .env ] || { cp .env.example .env; echo "أنشأت .env — عدّل القيم ثم أعد التشغيل"; exit 1; }
command -v node >/dev/null || { echo "ثبّت Node.js 22+ أولًا: https://nodejs.org"; exit 1; }
[ -d node_modules ] || npm install
set -a; source .env; set +a
node src/server.js &
APP=$!
if [ -n "$CLOUDFLARE_TUNNEL_TOKEN" ] && command -v cloudflared >/dev/null; then
  cloudflared tunnel --no-autoupdate run --token "$CLOUDFLARE_TUNNEL_TOKEN" &
fi
trap "kill $APP 2>/dev/null; pkill -f 'cloudflared tunnel' 2>/dev/null" EXIT
wait $APP
