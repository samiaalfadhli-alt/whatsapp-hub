// خادم WhatsApp Hub: REST API + Socket.IO + واجهة الويب
import "dotenv/config";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import express from "express";
import cookieParser from "cookie-parser";
import multer from "multer";
import { Server as SocketServer } from "socket.io";
import * as store from "./store.js";
import { AccountManager } from "./manager.js";
import * as alerts from "./alerts.js";
import { EmailWatcher, imapConfigured } from "./providers/email-watcher.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || "";

const app = express();
const server = http.createServer(app);
const io = new SocketServer(server);
const manager = new AccountManager(io);
const emailWatcher = new EmailWatcher(io, (st) => io.emit("email:status", st));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 64 * 1024 * 1024 } });

app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

// ---------- حماية بكلمة مرور (اختيارية عبر ADMIN_PASSWORD) ----------
const sessions = new Set();
function isAuthed(req) {
  return !ADMIN_PASSWORD || sessions.has(req.cookies?.hub_session);
}
app.post("/api/login", (req, res) => {
  if (!ADMIN_PASSWORD) return res.json({ ok: true });
  if (req.body?.password !== ADMIN_PASSWORD) return res.status(401).json({ error: "كلمة المرور غير صحيحة" });
  const token = crypto.randomBytes(24).toString("hex");
  sessions.add(token);
  res.cookie("hub_session", token, { httpOnly: true, sameSite: "lax", maxAge: 30 * 24 * 3600 * 1000 });
  res.json({ ok: true });
});
app.post("/api/logout", (req, res) => {
  sessions.delete(req.cookies?.hub_session);
  res.clearCookie("hub_session");
  res.json({ ok: true });
});
app.get("/api/auth", (req, res) => res.json({ required: !!ADMIN_PASSWORD, authed: isAuthed(req) }));
app.use("/api", (req, res, next) => (isAuthed(req) ? next() : res.status(401).json({ error: "غير مصرح" })));

io.use((socket, next) => {
  if (!ADMIN_PASSWORD) return next();
  const cookie = socket.handshake.headers.cookie || "";
  const token = cookie.split(";").map((c) => c.trim()).find((c) => c.startsWith("hub_session="))?.slice("hub_session=".length);
  return sessions.has(token) ? next() : next(new Error("unauthorized"));
});

// ---------- الحسابات ----------
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => res.status(400).json({ error: e.message }));

app.get("/api/accounts", (req, res) => res.json(manager.listAccounts()));
app.post("/api/accounts", wrap(async (req, res) => {
  const { label, type, phoneNumberId, accessToken } = req.body || {};
  if (type === "cloud" && (!phoneNumberId || !accessToken)) throw new Error("phoneNumberId و accessToken مطلوبان");
  res.json(await manager.addAccount({ label, type, phoneNumberId, accessToken }));
}));
app.patch("/api/accounts/:id", wrap(async (req, res) => {
  const account = store.getAccount(req.params.id);
  if (!account) throw new Error("الحساب غير موجود");
  const { label } = req.body || {};
  res.json(manager.publicAccount(store.saveAccount({ id: account.id, ...(label && { label }) })));
}));
app.post("/api/accounts/:id/connect", wrap(async (req, res) => res.json(await manager.connect(req.params.id))));
app.post("/api/accounts/:id/disconnect", wrap(async (req, res) => { await manager.disconnect(req.params.id); res.json({ ok: true }); }));
app.post("/api/accounts/:id/logout", wrap(async (req, res) => { await manager.logout(req.params.id); res.json({ ok: true }); }));
app.delete("/api/accounts/:id", wrap(async (req, res) => { await manager.removeAccount(req.params.id); res.json({ ok: true }); }));

// ---------- المحادثات والرسائل ----------
app.get("/api/accounts/:id/chats", (req, res) => res.json(store.listChats(req.params.id)));
app.get("/api/accounts/:id/chats/:chatId/messages", (req, res) => {
  store.markChatRead(req.params.id, req.params.chatId);
  res.json(store.listMessages(req.params.id, req.params.chatId));
});
app.post("/api/accounts/:id/send", wrap(async (req, res) => {
  const { chatId, text } = req.body || {};
  if (!chatId || !text?.trim()) throw new Error("الرقم والنص مطلوبان");
  res.json(await manager.sendText(req.params.id, chatId, text.trim()));
}));

app.post("/api/accounts/:id/send-media", upload.single("file"), wrap(async (req, res) => {
  const { chatId, caption } = req.body || {};
  if (!chatId || !req.file) throw new Error("الرقم والملف مطلوبان");
  const fileName = Buffer.from(req.file.originalname, "latin1").toString("utf8");
  res.json(await manager.sendMedia(req.params.id, chatId, { buffer: req.file.buffer, mimetype: req.file.mimetype, fileName, caption: caption?.trim() || "" }));
}));

// ---------- الردود الجاهزة ----------
app.get("/api/templates", (req, res) => res.json(store.listTemplates()));
app.post("/api/templates", wrap(async (req, res) => {
  const { id, title, text } = req.body || {};
  if (!title?.trim() || !text?.trim()) throw new Error("العنوان والنص مطلوبان");
  res.json(store.saveTemplate({ id: id || crypto.randomUUID(), title: title.trim(), text: text.trim() }));
}));
app.delete("/api/templates/:id", (req, res) => { store.deleteTemplate(req.params.id); res.json({ ok: true }); });

// ---------- الردود التلقائية ----------
app.get("/api/rules", (req, res) => res.json(store.listRules()));
app.post("/api/rules", wrap(async (req, res) => {
  const r = req.body || {};
  if (!["keyword", "welcome", "away"].includes(r.trigger)) throw new Error("نوع القاعدة غير صحيح");
  if (!r.reply?.trim()) throw new Error("نص الرد مطلوب");
  if (r.trigger === "keyword" && !r.keywords?.trim()) throw new Error("الكلمات المفتاحية مطلوبة");
  res.json(store.saveRule({
    id: r.id || crypto.randomUUID(), name: r.name?.trim() || "", trigger: r.trigger, accountId: r.accountId || "",
    keywords: r.keywords || "", match: r.match === "exact" ? "exact" : "contains", reply: r.reply.trim(),
    cooldownHours: Number(r.cooldownHours) || undefined, fromHour: r.fromHour !== undefined && r.fromHour !== "" ? Number(r.fromHour) : undefined,
    toHour: r.toHour !== undefined && r.toHour !== "" ? Number(r.toHour) : undefined, enabled: r.enabled !== false && r.enabled !== "false",
  }));
}));
app.delete("/api/rules/:id", (req, res) => { store.deleteRule(req.params.id); res.json({ ok: true }); });

// ---------- تنبيهات الاستفسارات ----------
app.get("/api/alerts/settings", (req, res) => res.json({
  ...alerts.getSettings(),
  smtpConfigured: alerts.mailerConfigured(),
  imapConfigured: imapConfigured(),
  imapUser: process.env.IMAP_USER || "",
  emailStatus: emailWatcher.status, emailError: emailWatcher.error || null,
}));
app.post("/api/alerts/settings", wrap(async (req, res) => {
  const b = req.body || {};
  res.json(alerts.saveSettings({
    enabled: b.enabled !== false && b.enabled !== "false",
    notifyEmail: (b.notifyEmail || "").trim(),
    keywords: (b.keywords || "").trim() || alerts.getSettings().keywords,
    whatsapp: b.whatsapp !== false && b.whatsapp !== "false",
    email: b.email !== false && b.email !== "false",
    cooldownMinutes: Number(b.cooldownMinutes) >= 0 ? Number(b.cooldownMinutes) : 60,
  }));
}));
app.post("/api/alerts/test", wrap(async (req, res) => {
  const to = (req.body?.to || alerts.getSettings().notifyEmail || "").trim();
  if (!to) throw new Error("حدد إيميل التنبيهات أولًا");
  await alerts.sendTestEmail(to);
  res.json({ ok: true });
}));
app.get("/api/leads", (req, res) => res.json(alerts.listLeads()));
app.patch("/api/leads/:id", wrap(async (req, res) => {
  const { status } = req.body || {};
  if (!["new", "contacted", "done"].includes(status)) throw new Error("حالة غير صحيحة");
  res.json(alerts.markLead(req.params.id, { status }));
}));

// ملفات الوسائط المحفوظة
app.use("/media", (req, res, next) => (isAuthed(req) ? next() : res.sendStatus(401)), express.static(path.join(process.env.DATA_DIR || path.resolve("data"), "media")));

// صندوق موحّد لكل الحسابات
app.get("/api/inbox", (req, res) => {
  const all = [];
  for (const account of manager.listAccounts()) {
    for (const chat of store.listChats(account.id)) all.push({ ...chat, accountId: account.id, accountLabel: account.label, accountPhone: account.phone });
  }
  all.sort((a, b) => (b.lastTimestamp || 0) - (a.lastTimestamp || 0));
  res.json(all);
});

// ---------- Webhook لـ Meta Cloud API ----------
app.get("/webhooks/cloud", (req, res) => {
  if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === META_VERIFY_TOKEN && META_VERIFY_TOKEN) {
    return res.send(req.query["hub.challenge"]);
  }
  res.sendStatus(403);
});
app.post("/webhooks/cloud", (req, res) => {
  res.sendStatus(200); // Meta تتوقع ردًا سريعًا؛ المعالجة تتم بعده
  for (const entry of req.body?.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const target = manager.cloudProviderByPhoneNumberId(value.metadata?.phone_number_id);
      if (target) target.provider.handleWebhook(value).catch(() => {});
    }
  }
});

// ---------- الواجهة ----------
app.use(express.static(path.join(__dirname, "..", "public")));

server.listen(PORT, async () => {
  console.log(`WhatsApp Hub يعمل على http://localhost:${PORT}`);
  await manager.init();
  emailWatcher.start().catch(() => {});
});
