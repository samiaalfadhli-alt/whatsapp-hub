// المستخدمون والجلسات: مدير (admin) يرى كل شيء، وموظف (agent) يرى أرقامًا محددة فقط
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";

const DATA_DIR = process.env.DATA_DIR || path.resolve("data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");
const SESSION_DAYS = 30;

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2));
  fs.renameSync(`${file}.tmp`, file);
}

// ---------- المستخدمون ----------
export function listUsers() { return readJson(USERS_FILE, []); }
export function getUser(id) { return listUsers().find((u) => u.id === id) || null; }
export function findByUsername(username) {
  const u = (username || "").trim().toLowerCase();
  return listUsers().find((x) => x.username === u) || null;
}
export function publicUser(u) {
  if (!u) return null;
  const { passwordHash, ...safe } = u;
  return safe;
}
export function hasUsers() { return listUsers().length > 0; }

export function createUser({ name, username, password, role = "agent", accountIds = [] }) {
  const uname = (username || "").trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,32}$/.test(uname)) throw new Error("اسم المستخدم: 3-32 حرفًا إنجليزيًا أو أرقامًا بدون مسافات");
  if (!name?.trim()) throw new Error("الاسم مطلوب");
  if (!password || password.length < 6) throw new Error("كلمة المرور 6 أحرف على الأقل");
  if (findByUsername(uname)) throw new Error("اسم المستخدم مستخدم مسبقًا");
  const user = {
    id: crypto.randomUUID(),
    name: name.trim(),
    username: uname,
    passwordHash: bcrypt.hashSync(password, 10),
    role: role === "admin" ? "admin" : "agent",
    accountIds: Array.isArray(accountIds) ? accountIds : [],
    active: true,
    createdAt: Date.now(),
  };
  writeJson(USERS_FILE, [...listUsers(), user]);
  return publicUser(user);
}

export function updateUser(id, patch) {
  const users = listUsers();
  const u = users.find((x) => x.id === id);
  if (!u) throw new Error("المستخدم غير موجود");
  if (patch.name !== undefined) { if (!patch.name.trim()) throw new Error("الاسم مطلوب"); u.name = patch.name.trim(); }
  if (patch.role !== undefined) u.role = patch.role === "admin" ? "admin" : "agent";
  if (patch.accountIds !== undefined) u.accountIds = Array.isArray(patch.accountIds) ? patch.accountIds : [];
  if (patch.active !== undefined) u.active = !!patch.active;
  if (patch.password) {
    if (patch.password.length < 6) throw new Error("كلمة المرور 6 أحرف على الأقل");
    u.passwordHash = bcrypt.hashSync(patch.password, 10);
    revokeUserSessions(id);
  }
  if (u.role !== "admin" && !users.some((x) => x.id !== id && x.role === "admin" && x.active)) throw new Error("يجب أن يبقى مدير واحد نشط على الأقل");
  writeJson(USERS_FILE, users);
  return publicUser(u);
}

export function deleteUser(id) {
  const users = listUsers();
  const u = users.find((x) => x.id === id);
  if (!u) return;
  if (u.role === "admin" && !users.some((x) => x.id !== id && x.role === "admin" && x.active)) throw new Error("لا يمكن حذف المدير الوحيد");
  writeJson(USERS_FILE, users.filter((x) => x.id !== id));
  revokeUserSessions(id);
}

export function verifyPassword(user, password) {
  return !!user && user.active !== false && bcrypt.compareSync(password || "", user.passwordHash);
}

// عند أول تشغيل: إن وُجد ADMIN_PASSWORD في البيئة ولا يوجد مستخدمون، ننشئ المدير تلقائيًا
export function bootstrapAdmin() {
  if (hasUsers()) return;
  const pw = process.env.ADMIN_PASSWORD;
  if (!pw) return;
  createUser({ name: "المدير", username: process.env.ADMIN_USERNAME || "admin", password: pw, role: "admin" });
  console.log(`تم إنشاء حساب المدير: ${process.env.ADMIN_USERNAME || "admin"}`);
}

// ---------- الصلاحيات ----------
export function canAccessAccount(user, accountId) {
  if (!user) return false;
  if (user.role === "admin") return true;
  return (user.accountIds || []).includes(accountId);
}
export function allowedAccountIds(user, allAccountIds) {
  if (!user) return [];
  return user.role === "admin" ? allAccountIds : allAccountIds.filter((id) => (user.accountIds || []).includes(id));
}

// ---------- الجلسات (محفوظة على القرص لتبقى بعد إعادة التشغيل) ----------
function loadSessions() {
  const now = Date.now();
  const all = readJson(SESSIONS_FILE, {});
  let changed = false;
  for (const [t, s] of Object.entries(all)) if (!s || s.expiresAt < now) { delete all[t]; changed = true; }
  if (changed) writeJson(SESSIONS_FILE, all);
  return all;
}
export function createSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const all = loadSessions();
  all[token] = { userId, createdAt: Date.now(), expiresAt: Date.now() + SESSION_DAYS * 86400_000 };
  writeJson(SESSIONS_FILE, all);
  return token;
}
export function userFromToken(token) {
  if (!token) return null;
  const s = loadSessions()[token];
  if (!s) return null;
  const u = getUser(s.userId);
  return u && u.active !== false ? u : null;
}
export function destroySession(token) {
  const all = loadSessions();
  if (all[token]) { delete all[token]; writeJson(SESSIONS_FILE, all); }
}
function revokeUserSessions(userId) {
  const all = loadSessions();
  for (const [t, s] of Object.entries(all)) if (s.userId === userId) delete all[t];
  writeJson(SESSIONS_FILE, all);
}
export const SESSION_COOKIE = "hub_session";
export const SESSION_MAX_AGE = SESSION_DAYS * 86400_000;
