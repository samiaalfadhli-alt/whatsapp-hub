// خادم WhatsApp Hub: REST API + Socket.IO + واجهة الويب
import "dotenv/config";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import express from "express";
import cookieParser from "cookie-parser";
import { Server as SocketServer } from "socket.io";
import * as store from "./store.js";
import { AccountManager } from "./manager.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || "";

const app = express();
const server = http.createServer(app);
const io = new SocketServer(server);
const manager = new AccountManager(io);

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
  for (const entry of req.body?.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const target = manager.cloudProviderByPhoneNumberId(value.metadata?.phone_number_id);
      if (target) target.provider.handleWebhook(value);
    }
  }
  res.sendStatus(200);
});

// ---------- الواجهة ----------
app.use(express.static(path.join(__dirname, "..", "public")));

server.listen(PORT, async () => {
  console.log(`WhatsApp Hub يعمل على http://localhost:${PORT}`);
  await manager.init();
});
