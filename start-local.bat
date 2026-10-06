@echo off
REM تشغيل WhatsApp Hub محليًا على Windows مع cloudflared
cd /d "%~dp0"
if not exist .env (copy .env.example .env & echo انشأت .env - عدّل القيم ثم اعد التشغيل & pause & exit /b 1)
where node >nul 2>nul || (echo ثبّت Node.js 22+ اولا: https://nodejs.org & pause & exit /b 1)
if not exist node_modules call npm install
for /f "usebackq tokens=1,* delims==" %%a in (".env") do (if "%%a"=="CLOUDFLARE_TUNNEL_TOKEN" set TUNNEL_TOKEN=%%b)
start "WhatsApp Hub" cmd /k node src\server.js
if defined TUNNEL_TOKEN (where cloudflared >nul 2>nul && start "Cloudflare Tunnel" cmd /k cloudflared tunnel --no-autoupdate run --token %TUNNEL_TOKEN%)
echo تم التشغيل. افتح http://localhost:3000
