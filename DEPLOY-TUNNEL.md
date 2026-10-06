# تشغيل WhatsApp Hub على جهاز محلي + Cloudflare Tunnel (مجاني)

النتيجة: التطبيق يعمل على جهازك (كمبيوتر مكتب / لابتوب قديم / Mini PC)، وتفتحينه من أي مكان عبر رابط مثل
`https://hub.yourdomain.com` بـ HTTPS، بدون فتح منافذ في الراوتر وبدون IP ثابت.

## المتطلبات
- جهاز يبقى شغّالًا (Windows / macOS / Linux).
- حساب Cloudflare مجاني + نطاق (Domain) مضاف إليه. *(بدون نطاق خاص: استخدمي Quick Tunnel في الأسفل)*.

---

## الخطوة 1: إنشاء الـ Tunnel في Cloudflare (مرة واحدة)
1. ادخلي https://one.dash.cloudflare.com ← **Networks** ← **Tunnels** ← **Create a tunnel**.
2. اختاري **Cloudflared** ← اسم: `whatsapp-hub` ← Save.
3. ستظهر لك شاشة تثبيت فيها أمر طويل ينتهي بـ **token**؛ انسخي الجزء بعد `--token` (نص طويل يبدأ بـ `eyJ`).
4. تبويب **Public Hostname** ← Add:
   - Subdomain: `hub` — Domain: نطاقك
   - Type: `HTTP` — URL: `whatsapp-hub:3000` (إن كنتِ تستخدمين Docker) أو `localhost:3000` (بدون Docker)
5. Save.

## الخطوة 2: إعداد الجهاز

### الطريقة A — Docker (الأسهل والأثبت) ✅
1. ثبّتي **Docker Desktop**: https://www.docker.com/products/docker-desktop
2. حمّلي المشروع (مجلد `whatsapp-hub`) على الجهاز.
3. `cp .env.example .env` وعدّلي:
   ```
   ADMIN_PASSWORD=كلمة-سر-قوية
   CLOUDFLARE_TUNNEL_TOKEN=eyJ...   ← التوكن من الخطوة 1
   ALERT_EMAIL= / SMTP_* / IMAP_*   ← لتنبيهات الاستفسارات
   ```
4. شغّلي:
   ```bash
   docker compose -f docker-compose.tunnel.yml up -d
   ```
5. افتحي `https://hub.yourdomain.com` ← «+ إضافة رقم» ← امسحي QR.

يعمل تلقائيًا بعد إعادة تشغيل الجهاز (`restart: unless-stopped`).

### الطريقة B — بدون Docker
1. ثبّتي Node.js 22+ من https://nodejs.org
2. ثبّتي cloudflared: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
3. `.env` كما في الطريقة A (مع `URL: localhost:3000` في Public Hostname).
4. شغّلي:
   - Windows: انقري `start-local.bat` مرتين
   - macOS/Linux: `./start-local.sh`

للتشغيل الدائم على Windows: ضعي اختصارًا لـ `start-local.bat` في مجلد Startup
(`Win+R` ← `shell:startup`).

---

## بدون نطاق خاص؟ (Quick Tunnel — للتجربة فقط)
```bash
cloudflared tunnel --url http://localhost:3000
```
يعطيك رابطًا مؤقتًا `https://xxxx.trycloudflare.com` يتغير مع كل تشغيل. مناسب للتجربة، لا للعمل اليومي.

---

## حماية إضافية (اختياري، مجاني)
Cloudflare Zero Trust ← **Access** ← Applications ← Add ← Self-hosted ← `hub.yourdomain.com`
← سياسة: Emails = إيميلك. يصبح الدخول بكود يُرسل لإيميلك قبل الوصول للتطبيق أصلًا.

## ملاحظات
- جلسات واتساب والرسائل والوسائط في مجلد `data/` — انسخيه عند تغيير الجهاز.
- أوقفي وضع السكون (Sleep) على الجهاز حتى لا ينقطع الاتصال.
- لحسابات Meta Cloud API: Webhook = `https://hub.yourdomain.com/webhooks/cloud`.
