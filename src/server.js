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
import * as users from "./users.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || "";

const app = express();
const server = http.createServer(app);
const io = new SocketServer(server);
const manager = new AccountManager(io);
const emailWatcher = new EmailWatcher(io, (st) => io.to("admins").emit("email:status", st));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 64 * 1024 * 1024 } });

app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

const wrap = (fn) => (req, res) => fn(req, res).catch((e) => res.status(400).json({ error: e.message }));

// ---------- المستخدمون والجلسات ----------
users.bootstrapAdmin();
const cookieOpts = { httpOnly: true, sameSite: "lax", maxAge: users.SESSION_MAX_AGE };
function userOf(req) { return users.userFromToken(req.cookies?.[users.SESSION_COOKIE]); }

// أول تشغيل بدون أي مستخدم: إنشاء حساب المدير من الواجهة
app.post("/api/setup", (req, res) => {
  if (users.hasUsers()) return res.status(400).json({ error: "تم الإعداد مسبقًا" });
  try {
    const { name, username, password } = req.body || {};
    const u = users.createUser({ name, username, password, role: "admin" });
    res.cookie(users.SESSION_COOKIE, users.createSession(u.id), cookieOpts);
    res.json({ ok: true, user: u });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post("/api/login", (req, res) => {
  const { username, password } = req.body || {};
  const u = users.findByUsername(username);
  if (!users.verifyPassword(u, password)) return res.status(401).json({ error: "اسم المستخدم أو كلمة المرور غير صحيحة" });
  res.cookie(users.SESSION_COOKIE, users.createSession(u.id), cookieOpts);
  res.json({ ok: true, user: users.publicUser(u) });
});
app.post("/api/logout", (req, res) => {
  users.destroySession(req.cookies?.[users.SESSION_COOKIE]);
  res.clearCookie(users.SESSION_COOKIE);
  res.json({ ok: true });
});
app.get("/api/auth", (req, res) => res.json({ setupRequired: !users.hasUsers(), user: users.publicUser(userOf(req)) }));
app.use("/api", (req, res, next) => {
  const u = userOf(req);
  if (!u) return res.status(401).json({ error: "غير مصرح" });
  req.user = u;
  next();
});
const adminOnly = (req, res, next) => (req.user.role === "admin" ? next() : res.status(403).json({ error: "هذه الصلاحية للمدير فقط" }));
// يتحقق أن المستخدم يملك صلاحية على الرقم المطلوب في المسار
const accountAccess = (req, res, next) => (users.canAccessAccount(req.user, req.params.id) ? next() : res.status(403).json({ error: "لا تملك صلاحية على هذا الرقم" }));
function allowedAccounts(user) {
  return manager.listAccounts().filter((a) => users.canAccessAccount(user, a.id));
}

// Socket.IO: كل مستخدم ينضم لغرف الأرقام المسموح له بها فقط
io.use((socket, next) => {
  const cookie = socket.handshake.headers.cookie || "";
  const token = cookie.split(";").map((c) => c.trim()).find((c) => c.startsWith(`${users.SESSION_COOKIE}=`))?.slice(users.SESSION_COOKIE.length + 1);
  const u = users.userFromToken(token);
  if (!u) return next(new Error("unauthorized"));
  socket.data.user = u;
  next();
});
io.on("connection", (socket) => {
  const u = socket.data.user;
  if (u.role === "admin") socket.join("admins");
  for (const a of allowedAccounts(u)) socket.join(`account:${a.id}`);
  socket.join(`user:${u.id}`);
});
// عند تغيير صلاحيات مستخدم: إعادة ضبط غرفه
function refreshUserRooms(userId) {
  for (const [, socket] of io.sockets.sockets) {
    if (socket.data.user?.id !== userId) continue;
    const u = users.getUser(userId);
    if (!u || u.active === false) { socket.disconnect(true); continue; }
    socket.data.user = u;
    for (const room of socket.rooms) if (room.startsWith("account:") || room === "admins") socket.leave(room);
    if (u.role === "admin") socket.join("admins");
    for (const a of allowedAccounts(u)) socket.join(`account:${a.id}`);
  }
}

// ---------- إدارة المستخدمين (المدير فقط) ----------
app.get("/api/users", adminOnly, (req, res) => res.json(users.listUsers().map(users.publicUser)));
app.post("/api/users", adminOnly, wrap(async (req, res) => {
  const { name, username, password, role, accountIds } = req.body || {};
  res.json(users.createUser({ name, username, password, role, accountIds }));
}));
app.patch("/api/users/:id", adminOnly, wrap(async (req, res) => {
  const { name, role, accountIds, active, password } = req.body || {};
  const u = users.updateUser(req.params.id, { name, role, accountIds, active, password });
  refreshUserRooms(req.params.id);
  res.json(u);
}));
app.delete("/api/users/:id", adminOnly, wrap(async (req, res) => {
  if (req.params.id === req.user.id) throw new Error("لا يمكنك حذف حسابك الحالي");
  users.deleteUser(req.params.id);
  refreshUserRooms(req.params.id);
  res.json({ ok: true });
}));
// الزملاء الذين يمكن إسناد محادثة لهم (لرقم معين)
app.get("/api/assignees", (req, res) => {
  const accountId = req.query.accountId;
  res.json(users.listUsers().filter((u) => u.active !== false && (!accountId || users.canAccessAccount(u, accountId))).map((u) => ({ id: u.id, name: u.name, role: u.role })));
});

// ---------- الحسابات ----------
app.get("/api/accounts", (req, res) => res.json(allowedAccounts(req.user)));
app.post("/api/accounts", adminOnly, wrap(async (req, res) => {
  const { label, type, phoneNumberId, accessToken } = req.body || {};
  if (type === "cloud" && (!phoneNumberId || !accessToken)) throw new Error("phoneNumberId و accessToken مطلوبان");
  res.json(await manager.addAccount({ label, type, phoneNumberId, accessToken }));
}));
app.patch("/api/accounts/:id", adminOnly, wrap(async (req, res) => {
  const account = store.getAccount(req.params.id);
  if (!account) throw new Error("الحساب غير موجود");
  const { label } = req.body || {};
  res.json(manager.publicAccount(store.saveAccount({ id: account.id, ...(label && { label }) })));
}));
app.post("/api/accounts/:id/connect", adminOnly, wrap(async (req, res) => res.json(await manager.connect(req.params.id))));
app.post("/api/accounts/:id/disconnect", adminOnly, wrap(async (req, res) => { await manager.disconnect(req.params.id); res.json({ ok: true }); }));
app.post("/api/accounts/:id/logout", adminOnly, wrap(async (req, res) => { await manager.logout(req.params.id); res.json({ ok: true }); }));
app.delete("/api/accounts/:id", adminOnly, wrap(async (req, res) => { await manager.removeAccount(req.params.id); res.json({ ok: true }); }));

// ---------- المحادثات والرسائل ----------
app.get("/api/accounts/:id/chats", accountAccess, (req, res) => res.json(store.listChats(req.params.id)));
// إسناد محادثة لموظف (أو إلغاء الإسناد بقيمة فارغة)
app.patch("/api/accounts/:id/chats/:chatId", accountAccess, wrap(async (req, res) => {
  const { assignedTo } = req.body || {};
  let assignee = null;
  if (assignedTo) {
    assignee = users.getUser(assignedTo);
    if (!assignee || !users.canAccessAccount(assignee, req.params.id)) throw new Error("هذا المستخدم لا يملك صلاحية على الرقم");
  }
  const chat = store.upsertChat(req.params.id, { id: req.params.chatId, assignedTo: assignee?.id || "", assignedName: assignee?.name || "" });
  io.to(`account:${req.params.id}`).emit("chat:update", { accountId: req.params.id, chat });
  if (assignee && assignee.id !== req.user.id) io.to(`user:${assignee.id}`).emit("chat:assigned", { accountId: req.params.id, chat, by: req.user.name });
  res.json(chat);
}));
// سحب رسائل أقدم من الهاتف
app.post("/api/accounts/:id/chats/:chatId/history", accountAccess, wrap(async (req, res) => res.json(await manager.fetchOlder(req.params.id, req.params.chatId))));
app.get("/api/accounts/:id/chats/:chatId/messages", accountAccess, (req, res) => {
  store.markChatRead(req.params.id, req.params.chatId);
  res.json(store.listMessages(req.params.id, req.params.chatId));
});
app.post("/api/accounts/:id/send", accountAccess, wrap(async (req, res) => {
  const { chatId, text } = req.body || {};
  if (!chatId || !text?.trim()) throw new Error("الرقم والنص مطلوبان");
  res.json(await manager.sendText(req.params.id, chatId, text.trim()));
}));

app.post("/api/accounts/:id/send-media", accountAccess, upload.single("file"), wrap(async (req, res) => {
  const { chatId, caption } = req.body || {};
  if (!chatId || !req.file) throw new Error("الرقم والملف مطلوبان");
  const fileName = Buffer.from(req.file.originalname, "latin1").toString("utf8");
  res.json(await manager.sendMedia(req.params.id, chatId, { buffer: req.file.buffer, mimetype: req.file.mimetype, fileName, caption: caption?.trim() || "" }));
}));

// ---------- الردود الجاهزة ----------
app.get("/api/templates", (req, res) => res.json(store.listTemplates()));
app.post("/api/templates", adminOnly, wrap(async (req, res) => {
  const { id, title, text } = req.body || {};
  if (!title?.trim() || !text?.trim()) throw new Error("العنوان والنص مطلوبان");
  res.json(store.saveTemplate({ id: id || crypto.randomUUID(), title: title.trim(), text: text.trim() }));
}));
app.delete("/api/templates/:id", adminOnly, (req, res) => { store.deleteTemplate(req.params.id); res.json({ ok: true }); });

// ---------- الردود التلقائية ----------
app.get("/api/rules", adminOnly, (req, res) => res.json(store.listRules()));
app.post("/api/rules", adminOnly, wrap(async (req, res) => {
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
app.delete("/api/rules/:id", adminOnly, (req, res) => { store.deleteRule(req.params.id); res.json({ ok: true }); });

// ---------- تنبيهات الاستفسارات ----------
app.get("/api/alerts/settings", adminOnly, (req, res) => res.json({
  ...alerts.getSettings(),
  smtpConfigured: alerts.mailerConfigured(),
  imapConfigured: imapConfigured(),
  imapUser: process.env.IMAP_USER || "",
  emailStatus: emailWatcher.status, emailError: emailWatcher.error || null,
}));
app.post("/api/alerts/settings", adminOnly, wrap(async (req, res) => {
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
app.post("/api/alerts/test", adminOnly, wrap(async (req, res) => {
  const to = (req.body?.to || alerts.getSettings().notifyEmail || "").trim();
  if (!to) throw new Error("حدد إيميل التنبيهات أولًا");
  await alerts.sendTestEmail(to);
  res.json({ ok: true });
}));
// الموظف يرى استفسارات أرقامه فقط؛ المدير يرى الكل (بما فيها الإيميل)
app.get("/api/leads", (req, res) => res.json(alerts.listLeads().filter((l) => req.user.role === "admin" || (l.channel === "whatsapp" && users.canAccessAccount(req.user, l.accountId)))));
app.patch("/api/leads/:id", wrap(async (req, res) => {
  const { status } = req.body || {};
  const lead = alerts.listLeads().find((l) => l.id === req.params.id);
  if (!lead || (req.user.role !== "admin" && !(lead.channel === "whatsapp" && users.canAccessAccount(req.user, lead.accountId)))) throw new Error("الاستفسار غير موجود");
  if (!["new", "contacted", "done"].includes(status)) throw new Error("حالة غير صحيحة");
  res.json(alerts.markLead(req.params.id, { status }));
}));

// ملفات الوسائط المحفوظة
app.use("/media/:accountId", (req, res, next) => {
  const u = userOf(req);
  if (!u) return res.sendStatus(401);
  if (!users.canAccessAccount(u, req.params.accountId)) return res.sendStatus(403);
  next();
});
app.use("/media", express.static(path.join(process.env.DATA_DIR || path.resolve("data"), "media")));

// صندوق موحّد لكل الحسابات
app.get("/api/inbox", (req, res) => {
  const all = [];
  for (const account of allowedAccounts(req.user)) {
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
