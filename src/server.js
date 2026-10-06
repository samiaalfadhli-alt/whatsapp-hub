// خادم WhatsApp Hub CRM: REST API + Socket.IO + واجهة الويب
import "dotenv/config";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import express from "express";
import cookieParser from "cookie-parser";
import multer from "multer";
import XLSX from "xlsx";
import { Server as SocketServer } from "socket.io";
import { db, DATA_DIR, getSetting, setSetting, markEventProcessed } from "./db.js";
import * as store from "./store.js";
import * as users from "./users.js";
import * as contacts from "./contacts.js";
import * as campaigns from "./campaigns.js";
import * as dashboard from "./dashboard.js";
import * as audit from "./audit.js";
import * as alerts from "./alerts.js";
import { AccountManager } from "./manager.js";
import { EmailWatcher, imapConfigured } from "./providers/email-watcher.js";
import { migrateFromJson } from "./migrate-json.js";
import { normalizePhone, maskPhone, jidToPhone, phoneToJid } from "./phone.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || "";
const META_APP_SECRET = process.env.META_APP_SECRET || "";

migrateFromJson();
users.bootstrapAdmin();

const app = express();
const server = http.createServer(app);
const io = new SocketServer(server, { maxHttpBufferSize: 1e6 });
const manager = new AccountManager(io);
const runner = new campaigns.CampaignRunner(manager, io);
manager.campaigns = runner;
const emailWatcher = new EmailWatcher(io, (st) => io.to("admins").emit("email:status", st));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 64 * 1024 * 1024 } });

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(express.json({ limit: "2mb", verify: (req, _res, buf) => { if (req.path.startsWith("/webhooks/")) req.rawBody = buf; } }));
app.use(cookieParser());

// ---------- أدوات ----------
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const cookieOpts = { httpOnly: true, sameSite: "lax", secure: process.env.COOKIE_SECURE === "true", maxAge: users.SESSION_MAX_AGE };
const userOf = (req) => users.userFromToken(req.cookies?.[users.SESSION_COOKIE]);
const perm = (p) => (req, _res, next) => (users.can(req.user, p) ? next() : next(new HttpError(403, "لا تملك صلاحية تنفيذ هذا الإجراء")));
const anyPerm = (...ps) => (req, _res, next) => (ps.some((p) => users.can(req.user, p)) ? next() : next(new HttpError(403, "لا تملك صلاحية تنفيذ هذا الإجراء")));

// نطاق الرؤية للمستخدم
function contactScope(user) { return users.can(user, "view_all_contacts") ? { all: true } : { userIds: users.teamIds(user) }; }
function accountIdsFor(user) { return users.allowedAccountIds(user, store.listAccounts().map((a) => a.id)); }
function convFilter(user) {
  const all = users.can(user, "view_all_conversations");
  return { accountIds: accountIdsFor(user), assignedIn: all ? undefined : users.teamIds(user), includeUnassigned: !all && getSetting("agents_see_unassigned", true) };
}
function canSeeConversation(user, conv) {
  if (!conv) return false;
  if (!users.canAccessAccount(user, conv.accountId)) return false;
  if (users.can(user, "view_all_conversations")) return true;
  if (!users.can(user, "view_assigned_conversations")) return false;
  return users.teamIds(user).includes(conv.assignedTo) || (!conv.assignedTo && getSetting("agents_see_unassigned", true));
}
const showPhone = (user) => users.can(user, "view_phone_numbers");
function publicConv(user, c) {
  if (!c) return null;
  const phone = c.isGroup ? "" : jidToPhone(c.id);
  const { id, ...rest } = c;
  return { ...rest, phone: showPhone(user) ? phone : maskPhone(phone), phoneMasked: !showPhone(user), title: c.name || (showPhone(user) ? `+${phone}` : maskPhone(phone)) || "مجموعة" };
}
function publicMsg(user, m) {
  if (!m) return null;
  const { chatId, key, ...rest } = m;
  if (!showPhone(user) && m.isGroup) rest.sender = maskPhone(jidToPhone(m.sender));
  return rest;
}

// ---------- المصادقة ----------
app.post("/api/setup", wrap((req, res) => {
  if (users.hasUsers()) throw new HttpError(400, "تم الإعداد مسبقًا");
  const u = users.createUser({ ...req.body, role: "super_admin" });
  res.cookie(users.SESSION_COOKIE, users.createSession(u.id), cookieOpts);
  audit.log(u, "user.setup", "user", u.id);
  res.json({ ok: true, user: u });
}));
const loginAttempts = new Map();
app.post("/api/login", wrap((req, res) => {
  const ip = req.ip; const a = loginAttempts.get(ip) || { n: 0, t: 0 };
  if (a.n >= 10 && Date.now() - a.t < 15 * 60_000) throw new HttpError(429, "محاولات كثيرة. حاول بعد 15 دقيقة");
  const u = users.findByUsername(req.body?.username);
  if (!users.verifyPassword(u, req.body?.password)) { loginAttempts.set(ip, { n: a.n + 1, t: Date.now() }); throw new HttpError(401, "اسم المستخدم أو كلمة المرور غير صحيحة"); }
  loginAttempts.delete(ip);
  res.cookie(users.SESSION_COOKIE, users.createSession(u.id), cookieOpts);
  users.touchSeen(u.id);
  res.json({ ok: true, user: users.publicUser(u) });
}));
app.post("/api/logout", (req, res) => { users.destroySession(req.cookies?.[users.SESSION_COOKIE]); res.clearCookie(users.SESSION_COOKIE); res.json({ ok: true }); });
app.get("/api/auth", (req, res) => res.json({ setupRequired: !users.hasUsers(), user: users.publicUser(userOf(req)) }));

app.use("/api", (req, _res, next) => {
  const u = userOf(req);
  if (!u) return next(new HttpError(401, "انتهت الجلسة. سجّل الدخول مجددًا"));
  req.user = u;
  if (!u.last_seen_at || Date.now() - u.last_seen_at > 60_000) users.touchSeen(u.id);
  next();
});

// بيانات مرجعية للواجهة في طلب واحد
app.get("/api/meta", (req, res) => {
  const lightUsers = db.prepare("SELECT id, name, role_id role, active FROM users ORDER BY name").all();
  res.json({
    me: users.publicUser(req.user), permissions: req.user.permissions,
    users: lightUsers, roles: users.can(req.user, "manage_users") || users.can(req.user, "manage_roles") ? users.listRoles() : [],
    accounts: manager.listAccounts().filter((a) => users.canAccessAccount(req.user, a.id)),
    tags: contacts.listTags(), lists: contacts.listLists(), sources: contacts.SOURCES, categories: contacts.CATEGORIES, categoryLabels: contacts.CATEGORY_AR,
    permissionList: users.PERMISSIONS, settings: { defaultCountryCode: getSetting("default_country_code", "966"), agentsSeeUnassigned: getSetting("agents_see_unassigned", true) },
  });
});

// ---------- لوحة التحكم والتقارير ----------
app.get("/api/dashboard/summary", wrap((req, res) => {
  const accs = manager.listAccounts().filter((a) => users.canAccessAccount(req.user, a.id));
  res.json(dashboard.summary({ accountIds: accs.map((a) => a.id), accountsStatus: accs.map((a) => ({ id: a.id, label: a.label, status: a.status, phone: showPhone(req.user) ? a.phone : maskPhone(a.phone) })) }));
}));
app.get("/api/dashboard/series", (req, res) => res.json(dashboard.series({ accountIds: accountIdsFor(req.user), days: Math.min(Number(req.query.days) || 14, 90) })));
app.get("/api/dashboard/breakdowns", perm("view_reports"), (req, res) => res.json(dashboard.breakdowns({ accountIds: accountIdsFor(req.user), days: Math.min(Number(req.query.days) || 30, 365) })));

// ---------- البحث الشامل ----------
app.get("/api/search", wrap((req, res) => {
  const q = String(req.query.q || "").trim();
  if (q.length < 2) return res.json({ contacts: [], conversations: [] });
  const c = contacts.query({ scope: contactScope(req.user), q, limit: 8, showPhone: showPhone(req.user) }).rows;
  const f = convFilter(req.user);
  const conv = store.queryConversations({ accountIds: f.accountIds, q, limit: 8, assignedIn: f.includeUnassigned ? undefined : f.assignedIn }).rows
    .filter((x) => canSeeConversation(req.user, x)).map((x) => publicConv(req.user, x));
  res.json({ contacts: c, conversations: conv });
}));

// ---------- المحادثات ----------
app.get("/api/conversations", wrap((req, res) => {
  const f = convFilter(req.user);
  const { status, filter, assignedTo, tagId, category, q, page, limit, accountId } = req.query;
  let contactIds;
  if (tagId || category) contactIds = contacts.idsMatching({ scope: { all: true }, tagId, category });
  const accountIds = accountId ? f.accountIds.filter((id) => id === accountId) : f.accountIds;
  const base = { accountIds, q, page, limit, contactIds, status: status && status !== "all" ? status : undefined, unreadOnly: filter === "unread" };
  if (assignedTo === "none") base.unassigned = true; else if (assignedTo) base.assignedTo = assignedTo;
  if (filter === "mine") base.assignedTo = req.user.id;
  let out;
  if (f.assignedIn && !base.assignedTo) {
    // نطاق الموظف/المشرف: المسندة إليه أو لفريقه (+ غير المسندة إن سُمح)
    out = store.queryConversations({ ...base, assignedIn: f.assignedIn });
    if (f.includeUnassigned && !base.unassigned) {
      const un = store.queryConversations({ ...base, unassigned: true });
      const seen = new Set(out.rows.map((r) => r.ref));
      out.rows = [...out.rows, ...un.rows.filter((r) => !seen.has(r.ref))].sort((a, b) => b.lastTimestamp - a.lastTimestamp).slice(0, out.limit);
      out.total += un.total;
    }
  } else if (f.assignedIn && base.assignedTo && !f.assignedIn.includes(base.assignedTo)) {
    out = { rows: [], total: 0, page: 1, limit: 25 };
  } else out = store.queryConversations(base);
  res.json({ ...out, rows: out.rows.map((c) => publicConv(req.user, c)) });
}));
function loadConv(req, _res, next) {
  const conv = store.getChatByRef(req.params.ref);
  if (!canSeeConversation(req.user, conv)) return next(new HttpError(404, "المحادثة غير موجودة أو لا تملك صلاحية عرضها"));
  req.conv = conv;
  next();
}
app.get("/api/conversations/:ref", loadConv, wrap((req, res) => {
  const c = req.conv;
  const contact = c.contactId ? contacts.getContact(c.contactId) : null;
  res.json({
    conversation: publicConv(req.user, c),
    contact: contact ? contacts.serialize(contact, { showPhone: showPhone(req.user), withLists: true }) : null,
    notes: contacts.listNotes(contact ? { contactId: contact.id } : { accountId: c.accountId, chatId: c.id }),
    tasks: contact ? contacts.listTasks({ contactId: contact.id, limit: 20 }).rows : [],
    assignees: db.prepare("SELECT id, name, role_id role FROM users WHERE active = 1 ORDER BY name").all().filter((u) => users.canAccessAccount(users.getUser(u.id), c.accountId)),
    assignments: db.prepare("SELECT ca.*, f.name from_name, t.name to_name, b.name by_name FROM conversation_assignments ca LEFT JOIN users f ON f.id = ca.from_user LEFT JOIN users t ON t.id = ca.to_user LEFT JOIN users b ON b.id = ca.by_user WHERE ca.account_id = ? AND ca.chat_id = ? ORDER BY ca.created_at DESC LIMIT 20").all(c.accountId, c.id),
  });
}));
app.get("/api/conversations/:ref/messages", loadConv, (req, res) => {
  const rows = store.listMessages(req.conv.accountId, req.conv.id, { before: req.query.before, limit: req.query.limit || 50 });
  if (!req.query.before) store.markChatRead(req.conv.accountId, req.conv.id);
  res.json({ rows: rows.map((m) => publicMsg(req.user, m)), hasMore: rows.length >= Number(req.query.limit || 50) });
});
app.post("/api/conversations/:ref/read", loadConv, (req, res) => { store.markChatRead(req.conv.accountId, req.conv.id); res.json({ ok: true }); });
app.post("/api/conversations/:ref/send", loadConv, perm("send_message"), wrap(async (req, res) => {
  const text = String(req.body?.text || "").trim();
  if (!text) throw new HttpError(400, "اكتب نص الرسالة");
  const m = await manager.sendText(req.conv.accountId, req.conv.id, text, { userId: req.user.id });
  res.json(publicMsg(req.user, m));
}));
app.post("/api/conversations/:ref/send-media", loadConv, perm("send_message"), upload.single("file"), wrap(async (req, res) => {
  if (!req.file) throw new HttpError(400, "اختر ملفًا");
  const fileName = Buffer.from(req.file.originalname, "latin1").toString("utf8");
  const m = await manager.sendMedia(req.conv.accountId, req.conv.id, { buffer: req.file.buffer, mimetype: req.file.mimetype, fileName, caption: String(req.body?.caption || "").trim() }, { userId: req.user.id });
  res.json(publicMsg(req.user, m));
}));
app.post("/api/conversations/:ref/history", loadConv, wrap(async (req, res) => res.json(await manager.fetchOlder(req.conv.accountId, req.conv.id))));
app.patch("/api/conversations/:ref", loadConv, wrap((req, res) => {
  const c = req.conv; const b = req.body || {};
  const patch = { id: c.id };
  if (b.assignedTo !== undefined) {
    if (!users.can(req.user, "assign_conversation")) throw new HttpError(403, "لا تملك صلاحية إسناد المحادثات");
    let to = null;
    if (b.assignedTo) { to = users.getUser(b.assignedTo); if (!to || !users.canAccessAccount(to, c.accountId)) throw new HttpError(400, "هذا المستخدم لا يملك صلاحية على هذا الرقم"); }
    patch.assignedTo = to?.id || ""; patch.assignedName = to?.name || "";
    db.prepare("INSERT INTO conversation_assignments (id, account_id, chat_id, from_user, to_user, by_user, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(crypto.randomUUID(), c.accountId, c.id, c.assignedTo || null, to?.id || null, req.user.id, Date.now());
    audit.log(req.user, "conversation.assign", "conversation", c.ref, { from: c.assignedName || null, to: to?.name || null, contactId: c.contactId });
    if (c.contactId && to) db.prepare("UPDATE contacts SET assigned_to = COALESCE(assigned_to, ?) WHERE id = ?").run(to.id, c.contactId);
  }
  if (b.status !== undefined) {
    if (!["new", "waiting", "replied", "closed"].includes(b.status)) throw new HttpError(400, "حالة غير صحيحة");
    if (b.status === "closed" && !users.can(req.user, "close_conversation")) throw new HttpError(403, "لا تملك صلاحية إغلاق المحادثات");
    patch.status = b.status; patch.closedAt = b.status === "closed" ? Date.now() : null;
    audit.log(req.user, b.status === "closed" ? "conversation.close" : "conversation.status", "conversation", c.ref, { status: b.status, contactId: c.contactId });
  }
  const chat = store.upsertChat(c.accountId, patch);
  manager.emitChat(c.accountId, c.id);
  if (patch.assignedTo && patch.assignedTo !== req.user.id) { const to = users.getUser(patch.assignedTo); io.to(`user:${patch.assignedTo}`).emit("chat:assigned", { chat: publicConv(to, chat), by: req.user.name }); }
  res.json(publicConv(req.user, chat));
}));
app.post("/api/conversations/:ref/notes", loadConv, wrap((req, res) => {
  const n = contacts.addNote({ contactId: req.conv.contactId, accountId: req.conv.accountId, chatId: req.conv.id, text: req.body?.text }, req.user);
  res.json(n);
}));

// بدء محادثة مع عميل من رقم محدد
app.post("/api/contacts/:id/start-conversation", perm("send_message"), wrap((req, res) => {
  const c = contacts.getContact(req.params.id);
  if (!c || !contacts.canSee(contactScope(req.user), c)) throw new HttpError(404, "العميل غير موجود");
  const accountId = req.body?.accountId;
  if (!accountId || !users.canAccessAccount(req.user, accountId)) throw new HttpError(400, "اختر رقم إرسال تملك صلاحية عليه");
  const chatId = phoneToJid(c.phone);
  let conv = store.getChat(accountId, chatId);
  if (!conv) conv = store.upsertChat(accountId, { id: chatId, name: c.name, status: "replied", assignedTo: req.user.id, assignedName: req.user.name });
  res.json(publicConv(req.user, conv));
}));

// ---------- العملاء ----------
app.get("/api/contacts", anyPerm("view_all_contacts", "view_assigned_contacts"), (req, res) => {
  const { q, category, source, tagId, listId, assignedTo, status, optIn, dateFrom, dateTo, sort, dir, page, limit } = req.query;
  res.json(contacts.query({ scope: contactScope(req.user), q, category, source, tagId, listId, assignedTo, status, optIn: optIn === "" || optIn === undefined ? undefined : optIn === "1", dateFrom, dateTo, sort, dir, page, limit, showPhone: showPhone(req.user) }));
});
app.post("/api/contacts", perm("create_contact"), wrap((req, res) => {
  const r = contacts.create(req.body || {}, req.user);
  if (!r.created && !contacts.canSee(contactScope(req.user), r.contact)) throw new HttpError(409, "الرقم مسجّل لعميل آخر خارج نطاقك");
  res.status(r.created ? 201 : 200).json({ created: r.created, contact: contacts.serialize(r.contact, { showPhone: showPhone(req.user), withLists: true }) });
}));
app.get("/api/contacts/export", perm("export_contacts"), (req, res) => {
  const rows = contacts.exportRows({ scope: contactScope(req.user), ...req.query }, req.user);
  const head = ["الاسم", "الجوال", "البريد", "الشركة", "المصدر", "التصنيف", "الوسوم", "الموظف المسؤول", "الحالة", "موافقة التواصل", "آخر تواصل", "تاريخ الإضافة"];
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const d = (t) => (t ? new Date(t).toISOString().slice(0, 16).replace("T", " ") : "");
  const lines = [head.map(esc).join(","), ...rows.map((c) => [c.name, "+" + c.phone, c.email, c.company, c.source, contacts.CATEGORY_AR[c.category] || c.category, c.tags.map((t) => t.name).join("|"), c.assignedName, c.status, c.optIn ? "نعم" : "لا", d(c.lastContactAt), d(c.createdAt)].map(esc).join(","))];
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="contacts-${Date.now()}.csv"`);
  res.send("﻿" + lines.join("\r\n"));
});
function parseUpload(file) {
  const name = (file.originalname || "").toLowerCase();
  if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
    const wb = XLSX.read(file.buffer, { type: "buffer" });
    return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "", raw: false });
  }
  const text = file.buffer.toString("utf8").replace(/^﻿/, "");
  const wb = XLSX.read(text, { type: "string", raw: true });
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "", raw: false });
}
const importCache = new Map(); // token -> { records, at }
app.post("/api/contacts/import/preview", perm("import_contacts"), upload.single("file"), wrap((req, res) => {
  if (!req.file) throw new HttpError(400, "اختر ملف CSV أو Excel");
  const records = parseUpload(req.file);
  if (!records.length) throw new HttpError(400, "الملف فارغ أو غير مقروء");
  const columns = Object.keys(records[0]);
  const guess = {}; const g = (f, re) => { const col = columns.find((c) => re.test(c)); if (col) guess[f] = col; };
  g("phone", /جوال|هاتف|رقم|phone|mobile|tel/i); g("name", /اسم|name/i); g("email", /بريد|ايميل|إيميل|email/i); g("company", /شركة|company/i);
  g("source", /مصدر|source/i); g("category", /تصنيف|category/i); g("tags", /وسم|وسوم|tags?/i); g("notes", /ملاحظ|notes?/i);
  const token = crypto.randomUUID();
  importCache.set(token, { records, at: Date.now() });
  for (const [k, v] of importCache) if (Date.now() - v.at > 30 * 60_000) importCache.delete(k);
  const mapping = req.body?.mapping ? JSON.parse(req.body.mapping) : guess;
  res.json({ token, columns, guess, total: records.length, sample: records.slice(0, 5), preview: contacts.previewImport(records, mapping) });
}));
app.post("/api/contacts/import/analyze", perm("import_contacts"), wrap((req, res) => {
  const c = importCache.get(req.body?.token);
  if (!c) throw new HttpError(400, "انتهت صلاحية الملف، ارفعه مجددًا");
  res.json(contacts.previewImport(c.records, req.body.mapping || {}));
}));
app.post("/api/contacts/import/run", perm("import_contacts"), wrap((req, res) => {
  const c = importCache.get(req.body?.token);
  if (!c) throw new HttpError(400, "انتهت صلاحية الملف، ارفعه مجددًا");
  if (!req.body.mapping?.phone) throw new HttpError(400, "حدد عمود رقم الجوال");
  const r = contacts.runImport(c.records, req.body.mapping, { updateExisting: !!req.body.updateExisting, tagIds: req.body.tagIds || [], assignedTo: req.body.assignedTo || null, defaultSource: req.body.source || "import" }, req.user);
  importCache.delete(req.body.token);
  res.json(r);
}));
app.post("/api/contacts/bulk", wrap((req, res) => {
  const { ids, action, payload = {}, filters } = req.body || {};
  const scope = contactScope(req.user);
  const targetIds = filters ? contacts.idsMatching({ ...filters, scope }) : (ids || []).filter((id) => contacts.canSee(scope, contacts.getContact(id)));
  const need = action === "delete" ? "delete_contact" : action === "export" ? "export_contacts" : "edit_contact";
  if (!users.can(req.user, need)) throw new HttpError(403, "لا تملك صلاحية تنفيذ هذا الإجراء");
  res.json({ affected: contacts.bulk(targetIds, action, payload, req.user), count: targetIds.length });
}));
function loadContact(req, _res, next) {
  const c = contacts.getContact(req.params.id);
  if (!c || !contacts.canSee(contactScope(req.user), c)) return next(new HttpError(404, "العميل غير موجود أو خارج نطاقك"));
  req.contact = c; next();
}
app.get("/api/contacts/:id", loadContact, (req, res) => res.json(contacts.profile(req.contact.id, { showPhone: showPhone(req.user) })));
app.patch("/api/contacts/:id", loadContact, perm("edit_contact"), wrap((req, res) => {
  const b = { ...req.body };
  if (b.assignedTo !== undefined && !users.can(req.user, "view_all_contacts") && b.assignedTo && !users.teamIds(req.user).includes(b.assignedTo)) throw new HttpError(403, "لا يمكنك تعيين عميل لموظف خارج فريقك");
  res.json(contacts.serialize(contacts.update(req.contact.id, b, req.user), { showPhone: showPhone(req.user), withLists: true }));
}));
app.delete("/api/contacts/:id", loadContact, perm("delete_contact"), (req, res) => { contacts.remove(req.contact.id, req.user); res.json({ ok: true }); });
app.post("/api/contacts/:id/notes", loadContact, wrap((req, res) => res.json(contacts.addNote({ contactId: req.contact.id, text: req.body?.text }, req.user))));
app.delete("/api/notes/:id", (req, res) => {
  const n = db.prepare("SELECT user_id FROM notes WHERE id = ?").get(req.params.id);
  if (n && (n.user_id === req.user.id || users.can(req.user, "manage_users"))) contacts.deleteNote(req.params.id, req.user);
  res.json({ ok: true });
});

// ---------- الوسوم والقوائم ----------
app.get("/api/tags", (req, res) => res.json(contacts.listTags()));
app.post("/api/tags", perm("manage_tags"), wrap((req, res) => res.json(contacts.saveTag(req.body || {}))));
app.delete("/api/tags/:id", perm("manage_tags"), (req, res) => { contacts.deleteTag(req.params.id); res.json({ ok: true }); });
app.get("/api/lists", (req, res) => res.json(contacts.listLists()));
app.post("/api/lists", perm("manage_tags"), wrap((req, res) => res.json(contacts.saveList(req.body || {}))));
app.delete("/api/lists/:id", perm("manage_tags"), (req, res) => { contacts.deleteList(req.params.id); res.json({ ok: true }); });

// ---------- القوالب ----------
app.get("/api/templates", (req, res) => res.json(store.listTemplates(req.query.kind)));
app.post("/api/templates", perm("manage_templates"), wrap((req, res) => {
  const { id, title, text, kind, metaName, language } = req.body || {};
  if (!title?.trim() || !text?.trim()) throw new HttpError(400, "العنوان والنص مطلوبان");
  const t = store.saveTemplate({ id, title: title.trim(), text: text.trim(), kind: kind === "campaign" ? "campaign" : "quick", metaName, language });
  audit.log(req.user, id ? "template.update" : "template.create", "template", t.id, { title: t.title });
  res.json(t);
}));
app.delete("/api/templates/:id", perm("manage_templates"), (req, res) => { store.deleteTemplate(req.params.id); audit.log(req.user, "template.delete", "template", req.params.id); res.json({ ok: true }); });

// ---------- المهام والمتابعات ----------
app.get("/api/tasks", (req, res) => {
  const all = users.can(req.user, "view_all_contacts");
  res.json(contacts.listTasks({ ...req.query, scopeUserIds: all ? undefined : users.teamIds(req.user) }));
});
app.post("/api/tasks", perm("manage_tasks"), wrap((req, res) => res.json(contacts.saveTask(req.body || {}, req.user))));
app.delete("/api/tasks/:id", perm("manage_tasks"), (req, res) => { contacts.deleteTask(req.params.id, req.user); res.json({ ok: true }); });

// ---------- الحملات ----------
app.get("/api/campaigns", anyPerm("create_campaign", "send_campaign", "view_campaign_reports"), (req, res) => res.json(campaigns.list(req.query)));
app.post("/api/campaigns/audience", perm("create_campaign"), (req, res) => { const r = campaigns.resolveAudience(req.body?.audience || {}); res.json({ summary: r.summary, excluded: r.excluded.slice(0, 50).map((x) => ({ name: x.name, phone: showPhone(req.user) ? x.phone : maskPhone(x.phone), reason: x.reason })) }); });
app.post("/api/campaigns/media", perm("create_campaign"), upload.single("file"), wrap((req, res) => {
  if (!req.file) throw new HttpError(400, "اختر ملفًا");
  const dir = path.join(DATA_DIR, "campaign-media"); fs.mkdirSync(dir, { recursive: true });
  const fileName = Buffer.from(req.file.originalname, "latin1").toString("utf8");
  const p = path.join(dir, `${crypto.randomUUID()}${path.extname(fileName) || store.mimeToExt(req.file.mimetype)}`);
  fs.writeFileSync(p, req.file.buffer);
  res.json({ path: p, mimetype: req.file.mimetype, fileName, size: req.file.size });
}));
app.post("/api/campaigns", perm("create_campaign"), wrap((req, res) => {
  if (!users.canAccessAccount(req.user, req.body?.accountId)) throw new HttpError(400, "لا تملك صلاحية على رقم الإرسال");
  res.json(campaigns.save(req.body || {}, req.user));
}));
app.get("/api/campaigns/:id", anyPerm("create_campaign", "send_campaign", "view_campaign_reports"), (req, res) => {
  const c = campaigns.get(req.params.id); if (!c) return res.status(404).json({ error: "الحملة غير موجودة" });
  res.json({ campaign: c, stats: campaigns.stats(c.id) });
});
app.get("/api/campaigns/:id/recipients", perm("view_campaign_reports"), (req, res) => {
  const r = campaigns.recipients(req.params.id, req.query);
  res.json({ ...r, rows: r.rows.map((x) => ({ ...x, phone: showPhone(req.user) ? x.phone : maskPhone(x.phone) })) });
});
app.post("/api/campaigns/:id/preview", perm("create_campaign"), (req, res) => {
  const c = campaigns.get(req.params.id); if (!c) return res.status(404).json({ error: "الحملة غير موجودة" });
  const { eligible } = campaigns.resolveAudience(c.audience);
  const sample = eligible.slice(0, 3).map((ct) => ({ name: ct.name, text: campaigns.render(c.messageText, ct) }));
  res.json({ sample, generic: campaigns.render(c.messageText, { name: "اسم العميل", company: "الشركة" }) });
});
app.post("/api/campaigns/:id/start", perm("send_campaign"), wrap(async (req, res) => res.json(await runner.start(req.params.id, req.user, { scheduledAt: req.body?.scheduledAt ? Number(req.body.scheduledAt) : null }))));
app.post("/api/campaigns/:id/pause", perm("send_campaign"), (req, res) => res.json(runner.pause(req.params.id, req.user)));
app.post("/api/campaigns/:id/retry", perm("send_campaign"), wrap((req, res) => res.json({ retried: runner.retryFailed(req.params.id, req.user) })));
app.delete("/api/campaigns/:id", perm("create_campaign"), wrap((req, res) => { campaigns.remove(req.params.id, req.user); res.json({ ok: true }); }));

// ---------- المستخدمون والأدوار ----------
app.get("/api/users", perm("manage_users"), (req, res) => res.json(users.listUsers().map(users.publicUser)));
app.post("/api/users", perm("manage_users"), wrap((req, res) => {
  if (req.body?.role === "super_admin" && !users.isSuper(req.user)) throw new HttpError(403, "فقط Super Admin يمكنه إنشاء Super Admin");
  const u = users.createUser(req.body || {}); audit.log(req.user, "user.create", "user", u.id, { username: u.username, role: u.role }); res.json(u);
}));
app.patch("/api/users/:id", perm("manage_users"), wrap((req, res) => {
  const target = users.getUser(req.params.id);
  if (!target) throw new HttpError(404, "المستخدم غير موجود");
  if ((target.role_id === "super_admin" || req.body?.role === "super_admin") && !users.isSuper(req.user)) throw new HttpError(403, "فقط Super Admin يمكنه تعديل حسابات Super Admin");
  const u = users.updateUser(req.params.id, req.body || {});
  const { password, ...meta } = req.body || {};
  audit.log(req.user, "user.update", "user", u.id, { fields: Object.keys(meta) });
  refreshUserRooms(u.id);
  res.json(u);
}));
app.delete("/api/users/:id", perm("manage_users"), wrap((req, res) => {
  if (req.params.id === req.user.id) throw new HttpError(400, "لا يمكنك حذف حسابك الحالي");
  const t = users.getUser(req.params.id);
  if (t?.role_id === "super_admin" && !users.isSuper(req.user)) throw new HttpError(403, "فقط Super Admin يمكنه حذف Super Admin");
  users.deleteUser(req.params.id); audit.log(req.user, "user.delete", "user", req.params.id, { username: t?.username }); refreshUserRooms(req.params.id); res.json({ ok: true });
}));
app.get("/api/roles", anyPerm("manage_roles", "manage_users"), (req, res) => res.json({ roles: users.listRoles(), permissions: users.PERMISSIONS }));
app.post("/api/roles", perm("manage_roles"), wrap((req, res) => { const r = users.createRole(req.body || {}); audit.log(req.user, "role.create", "role", r.id, { name: r.name }); res.json(r); }));
app.patch("/api/roles/:id", perm("manage_roles"), wrap((req, res) => {
  const r = users.updateRole(req.params.id, req.body || {}); audit.log(req.user, "role.update", "role", r.id, { permissions: r.permissions.length });
  for (const u of users.listUsers()) if (u.role_id === r.id) refreshUserRooms(u.id);
  res.json(r);
}));
app.delete("/api/roles/:id", perm("manage_roles"), wrap((req, res) => { users.deleteRole(req.params.id); audit.log(req.user, "role.delete", "role", req.params.id); res.json({ ok: true }); }));

// ---------- سجل النشاط ----------
app.get("/api/audit", perm("view_audit_log"), (req, res) => res.json(audit.list(req.query)));

// ---------- الإعدادات ----------
app.get("/api/settings", perm("manage_settings"), (req, res) => res.json({
  defaultCountryCode: getSetting("default_country_code", "966"), agentsSeeUnassigned: getSetting("agents_see_unassigned", true),
  alerts: { ...alerts.getSettings(), smtpConfigured: alerts.mailerConfigured(), imapConfigured: imapConfigured(), imapUser: process.env.IMAP_USER || "", emailStatus: emailWatcher.status, emailError: emailWatcher.error || null },
  rules: store.listRules(), webhookUrl: "/webhooks/cloud", webhookSigned: !!META_APP_SECRET,
}));
app.post("/api/settings", perm("manage_settings"), wrap((req, res) => {
  const b = req.body || {};
  if (b.defaultCountryCode !== undefined) setSetting("default_country_code", String(b.defaultCountryCode).replace(/\D/g, "") || "966");
  if (b.agentsSeeUnassigned !== undefined) setSetting("agents_see_unassigned", !!b.agentsSeeUnassigned);
  if (b.alerts) alerts.saveSettings({ enabled: !!b.alerts.enabled, notifyEmail: (b.alerts.notifyEmail || "").trim(), keywords: (b.alerts.keywords || "").trim() || alerts.getSettings().keywords, whatsapp: !!b.alerts.whatsapp, email: !!b.alerts.email, cooldownMinutes: Number(b.alerts.cooldownMinutes) >= 0 ? Number(b.alerts.cooldownMinutes) : 60 });
  audit.log(req.user, "settings.update", "settings", "", { keys: Object.keys(b) });
  res.json({ ok: true });
}));
app.post("/api/settings/alerts/test", perm("manage_settings"), wrap(async (req, res) => { await alerts.sendTestEmail((req.body?.to || alerts.getSettings().notifyEmail || "").trim()); res.json({ ok: true }); }));
app.post("/api/rules", perm("manage_settings"), wrap((req, res) => {
  const r = req.body || {};
  if (!["keyword", "welcome", "away"].includes(r.trigger)) throw new HttpError(400, "نوع القاعدة غير صحيح");
  if (!r.reply?.trim()) throw new HttpError(400, "نص الرد مطلوب");
  res.json(store.saveRule({ id: r.id, name: r.name?.trim() || "", trigger: r.trigger, accountId: r.accountId || "", keywords: r.keywords || "", match: r.match === "exact" ? "exact" : "contains", reply: r.reply.trim(), cooldownHours: Number(r.cooldownHours) || undefined, fromHour: r.fromHour !== "" && r.fromHour !== undefined ? Number(r.fromHour) : undefined, toHour: r.toHour !== "" && r.toHour !== undefined ? Number(r.toHour) : undefined, enabled: r.enabled !== false && r.enabled !== "false" }));
}));
app.delete("/api/rules/:id", perm("manage_settings"), (req, res) => { store.deleteRule(req.params.id); res.json({ ok: true }); });
app.get("/api/leads", (req, res) => res.json(alerts.listLeads({ status: req.query.status, accountIds: users.can(req.user, "view_all_conversations") ? undefined : accountIdsFor(req.user), page: req.query.page, limit: req.query.limit })));
app.patch("/api/leads/:id", wrap((req, res) => {
  if (!["new", "contacted", "done"].includes(req.body?.status)) throw new HttpError(400, "حالة غير صحيحة");
  res.json(alerts.markLead(req.params.id, { status: req.body.status }));
}));

// ---------- أرقام WhatsApp ----------
app.get("/api/accounts", (req, res) => res.json(manager.listAccounts().filter((a) => users.canAccessAccount(req.user, a.id)).map((a) => ({ ...a, phone: showPhone(req.user) || users.can(req.user, "manage_whatsapp") ? a.phone : maskPhone(a.phone) }))));
app.post("/api/accounts", perm("manage_whatsapp"), wrap(async (req, res) => {
  const { label, type, phoneNumberId, accessToken } = req.body || {};
  if (type === "cloud" && (!phoneNumberId || !accessToken)) throw new HttpError(400, "Phone Number ID و Access Token مطلوبان");
  const a = await manager.addAccount({ label, type, phoneNumberId, accessToken });
  audit.log(req.user, "whatsapp.add", "account", a.id, { label: a.label, type: a.type }); res.json(a);
}));
app.patch("/api/accounts/:id", perm("manage_whatsapp"), wrap((req, res) => {
  const a = store.getAccount(req.params.id); if (!a) throw new HttpError(404, "الرقم غير موجود");
  res.json(manager.publicAccount(store.saveAccount({ id: a.id, ...(req.body?.label && { label: String(req.body.label).trim() }) })));
}));
app.post("/api/accounts/:id/connect", perm("manage_whatsapp"), wrap(async (req, res) => res.json(await manager.connect(req.params.id))));
app.post("/api/accounts/:id/disconnect", perm("manage_whatsapp"), wrap(async (req, res) => { await manager.disconnect(req.params.id); res.json({ ok: true }); }));
app.post("/api/accounts/:id/logout", perm("manage_whatsapp"), wrap(async (req, res) => { await manager.logout(req.params.id); audit.log(req.user, "whatsapp.logout", "account", req.params.id); res.json({ ok: true }); }));
app.delete("/api/accounts/:id", perm("manage_whatsapp"), wrap(async (req, res) => { await manager.removeAccount(req.params.id); audit.log(req.user, "whatsapp.remove", "account", req.params.id); res.json({ ok: true }); }));

// ---------- الوسائط (خلف المصادقة وصلاحية الرقم) ----------
app.get("/media/:accountId/:file", (req, res) => {
  const u = userOf(req);
  if (!u) return res.sendStatus(401);
  if (!users.canAccessAccount(u, req.params.accountId)) return res.sendStatus(403);
  const p = store.mediaFilePath(req.params.accountId, req.params.file);
  if (!fs.existsSync(p)) return res.status(404).json({ error: "الملف غير متوفر" });
  if (req.query.download) res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(req.query.download)}`);
  res.sendFile(p, { maxAge: "7d" });
});

// ---------- Webhook لـ Meta Cloud API ----------
app.get("/webhooks/cloud", (req, res) => {
  if (META_VERIFY_TOKEN && req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === META_VERIFY_TOKEN) return res.send(req.query["hub.challenge"]);
  res.sendStatus(403);
});
app.post("/webhooks/cloud", (req, res) => {
  if (META_APP_SECRET) {
    const sig = String(req.get("x-hub-signature-256") || "");
    const expected = "sha256=" + crypto.createHmac("sha256", META_APP_SECRET).update(req.rawBody || Buffer.alloc(0)).digest("hex");
    if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return res.sendStatus(401);
  }
  res.sendStatus(200); // Meta تتوقع ردًا سريعًا
  for (const entry of req.body?.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      // منع تكرار نفس الحدث
      value.messages = (value.messages || []).filter((m) => markEventProcessed(`msg:${m.id}`));
      value.statuses = (value.statuses || []).filter((s) => markEventProcessed(`st:${s.id}:${s.status}`));
      if (!value.messages.length && !value.statuses.length) continue;
      const target = manager.cloudProviderByPhoneNumberId(value.metadata?.phone_number_id);
      if (target) target.provider.handleWebhook(value).catch((e) => console.error("webhook:", e.message));
    }
  }
});

// ---------- Socket.IO ----------
io.use((socket, next) => {
  const cookie = socket.handshake.headers.cookie || "";
  const token = cookie.split(";").map((c) => c.trim()).find((c) => c.startsWith(`${users.SESSION_COOKIE}=`))?.slice(users.SESSION_COOKIE.length + 1);
  const u = users.userFromToken(token);
  if (!u) return next(new Error("unauthorized"));
  socket.data.user = u; next();
});
function joinRooms(socket) {
  const u = socket.data.user;
  for (const room of [...socket.rooms]) if (room !== socket.id) socket.leave(room);
  socket.join(`user:${u.id}`);
  if (users.can(u, "view_all_conversations") || users.can(u, "view_reports")) socket.join("admins");
  const variant = users.can(u, "view_phone_numbers") ? "full" : "masked";
  for (const id of accountIdsFor(u)) { socket.join(`account:${id}`); socket.join(`account:${id}:${variant}`); }
}
io.on("connection", (socket) => joinRooms(socket));
function refreshUserRooms(userId) {
  for (const [, socket] of io.sockets.sockets) {
    if (socket.data.user?.id !== userId) continue;
    const u = users.getUser(userId);
    if (!u || !u.active) { socket.disconnect(true); continue; }
    socket.data.user = u; joinRooms(socket);
  }
}

// ---------- الواجهة والأخطاء ----------
app.use(express.static(path.join(__dirname, "..", "public"), { maxAge: "1h", etag: true }));
app.get(/^\/(?!api|media|webhooks|socket\.io).*/, (req, res) => res.sendFile(path.join(__dirname, "..", "public", "index.html")));
app.use("/api", (req, res) => res.status(404).json({ error: "المسار غير موجود" }));
app.use((err, req, res, _next) => {
  const status = err.status || (err.code === "LIMIT_FILE_SIZE" ? 413 : 400);
  const msg = err.code === "LIMIT_FILE_SIZE" ? "حجم الملف يتجاوز 64 ميجابايت" : err.status ? err.message : (err.message || "حدث خطأ غير متوقع");
  if (!err.status) console.error(`[${req.method} ${req.path}]`, err.message);
  res.status(status).json({ error: msg });
});

server.listen(PORT, async () => {
  console.log(`WhatsApp Hub CRM يعمل على http://localhost:${PORT}`);
  await manager.init();
  runner.resume();
  emailWatcher.start().catch(() => {});
});
