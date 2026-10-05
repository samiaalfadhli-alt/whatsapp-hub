# نشر WhatsApp Hub

التطبيق يحتاج خادمًا دائمًا (لا يعمل على Vercel/Netlify). الخيارات:

## 1) Railway (الأسهل)
1. railway.app ← New Project ← Deploy from GitHub ← اختر مستودع `atlas`.
2. Settings ← **Root Directory**: `whatsapp-hub`.
3. Variables: أضف `ADMIN_PASSWORD`, `ALERT_EMAIL`, `SMTP_*`, `IMAP_*` (انظر `.env.example`).
4. Settings ← Volumes ← Add Volume ← Mount path: `/data` (ضروري لحفظ جلسات واتساب).
5. Settings ← Networking ← Generate Domain. افتح الرابط وامسح QR.

## 2) Render
1. render.com ← New ← **Blueprint** ← اختر المستودع (سيقرأ `render.yaml` تلقائيًا).
   أو: New ← Web Service ← Root Directory `whatsapp-hub` ← Runtime Docker.
2. أدخل قيم المتغيرات المطلوبة عند الإنشاء.
3. Disk بمسار `/data` موجود في الـ Blueprint (ضروري).

## 3) VPS (Hetzner / DigitalOcean / أي خادم Linux)
```bash
git clone <repo> && cd atlas/whatsapp-hub
cp .env.example .env && nano .env
docker compose up -d
```
ثم ضع Nginx/Caddy أمامه مع HTTPS. مثال Caddy:
```
hub.yourdomain.com {
  reverse_proxy localhost:3000
}
```

## ملاحظات
- يجب تشغيل **نسخة واحدة** فقط من التطبيق (لا Autoscaling) لأن جلسة واتساب لا تقبل اتصالين.
- `/data` يحتوي الجلسات والرسائل والوسائط؛ انسخه عند الترحيل.
- لحسابات Meta Cloud API: ضع Webhook على `https://<domain>/webhooks/cloud`.
