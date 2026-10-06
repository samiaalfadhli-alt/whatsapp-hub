// المستخدمون والأدوار والصلاحيات والجلسات (التحقق يتم في الـ Backend دائمًا)
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { db, J, P, now } from "./db.js";

const SESSION_DAYS = 30;
export const SESSION_COOKIE = "hub_session";
export const SESSION_MAX_AGE = SESSION_DAYS * 86400_000;

// ---------- مصفوفة الصلاحيات ----------
export const PERMISSIONS = [
  ["view_all_contacts", "عرض كل العملاء"], ["view_assigned_contacts", "عرض العملاء المسندين إليه"],
  ["create_contact", "إضافة عميل"], ["edit_contact", "تعديل عميل"], ["delete_contact", "حذف عميل"],
  ["view_phone_numbers", "عرض أرقام الجوال كاملة"], ["view_all_conversations", "عرض كل المحادثات"],
  ["view_assigned_conversations", "عرض المحادثات المسندة إليه"], ["send_message", "إرسال رسائل"],
  ["assign_conversation", "إسناد المحادثات"], ["close_conversation", "إغلاق المحادثات"],
  ["create_campaign", "إنشاء حملات"], ["send_campaign", "إرسال حملات"], ["view_campaign_reports", "عرض تقارير الحملات"],
  ["export_contacts", "تصدير العملاء"], ["import_contacts", "استيراد العملاء"],
  ["manage_users", "إدارة المستخدمين"], ["manage_roles", "إدارة الأدوار والصلاحيات"],
  ["manage_whatsapp", "إدارة أرقام WhatsApp"], ["manage_settings", "إدارة الإعدادات"],
  ["view_reports", "عرض التقارير"], ["manage_tags", "إدارة القوائم والتصنيفات"], ["manage_templates", "إدارة القوالب"],
  ["view_audit_log", "عرض سجل النشاط"], ["manage_tasks", "إدارة المهام والمتابعات"],
];
export const PERMISSION_KEYS = PERMISSIONS.map(([k]) => k);

const ALL = PERMISSION_KEYS;
const ADMIN = ALL.filter((p) => !["manage_roles"].includes(p));
const SUPERVISOR = ["view_assigned_contacts", "create_contact", "edit_contact", "view_phone_numbers", "view_assigned_conversations", "send_message", "assign_conversation", "close_conversation", "view_campaign_reports", "view_reports", "manage_tasks", "manage_templates", "manage_tags", "export_contacts"];
const AGENT = ["view_assigned_contacts", "create_contact", "edit_contact", "view_assigned_conversations", "send_message", "close_conversation", "manage_tasks"];

export const SYSTEM_ROLES = [
  { id: "super_admin", name: "Super Admin", perms: ALL },
  { id: "admin", name: "مدير", perms: ADMIN },
  { id: "supervisor", name: "مشرف", perms: SUPERVISOR },
  { id: "agent", name: "موظف", perms: AGENT },
];

export function ensureRoles() {
  const ins = db.prepare("INSERT OR IGNORE INTO roles (id, name, is_system, created_at) VALUES (?, ?, 1, ?)");
  const insP = db.prepare("INSERT OR IGNORE INTO role_permissions (role_id, permission) VALUES (?, ?)");
  db.transaction(() => {
    for (const r of SYSTEM_ROLES) {
      const existed = db.prepare("SELECT 1 FROM roles WHERE id = ?").get(r.id);
      ins.run(r.id, r.name, now());
      if (!existed) for (const p of r.perms) insP.run(r.id, p);
    }
    // Super Admin يملك كل الصلاحيات دائمًا، بما فيها الجديدة
    for (const p of ALL) insP.run("super_admin", p);
  })();
}

export function listRoles() {
  const roles = db.prepare("SELECT * FROM roles ORDER BY is_system DESC, name").all();
  const perms = db.prepare("SELECT role_id, permission FROM role_permissions").all();
  const counts = Object.fromEntries(db.prepare("SELECT role_id, COUNT(*) c FROM users GROUP BY role_id").all().map((r) => [r.role_id, r.c]));
  return roles.map((r) => ({ ...r, is_system: !!r.is_system, permissions: perms.filter((p) => p.role_id === r.id).map((p) => p.permission), users: counts[r.id] || 0 }));
}
export function getRole(id) { return listRoles().find((r) => r.id === id) || null; }
export function createRole({ name, permissions = [] }) {
  if (!name?.trim()) throw new Error("اسم الدور مطلوب");
  const id = "role_" + crypto.randomUUID().slice(0, 8);
  db.transaction(() => {
    db.prepare("INSERT INTO roles (id, name, is_system, created_at) VALUES (?, ?, 0, ?)").run(id, name.trim(), now());
    for (const p of permissions.filter((p) => PERMISSION_KEYS.includes(p))) db.prepare("INSERT OR IGNORE INTO role_permissions (role_id, permission) VALUES (?, ?)").run(id, p);
  })();
  return getRole(id);
}
export function updateRole(id, { name, permissions }) {
  const role = getRole(id);
  if (!role) throw new Error("الدور غير موجود");
  if (id === "super_admin") throw new Error("لا يمكن تعديل صلاحيات Super Admin");
  db.transaction(() => {
    if (name?.trim() && !role.is_system) db.prepare("UPDATE roles SET name = ? WHERE id = ?").run(name.trim(), id);
    if (Array.isArray(permissions)) {
      db.prepare("DELETE FROM role_permissions WHERE role_id = ?").run(id);
      for (const p of permissions.filter((p) => PERMISSION_KEYS.includes(p))) db.prepare("INSERT OR IGNORE INTO role_permissions (role_id, permission) VALUES (?, ?)").run(id, p);
    }
  })();
  return getRole(id);
}
export function deleteRole(id) {
  const role = getRole(id);
  if (!role) return;
  if (role.is_system) throw new Error("لا يمكن حذف دور نظامي");
  if (role.users) throw new Error("انقل مستخدمي هذا الدور إلى دور آخر أولًا");
  db.prepare("DELETE FROM roles WHERE id = ?").run(id);
}

// ---------- المستخدمون ----------
function rowToUser(r) {
  if (!r) return null;
  return { ...r, accountIds: P(r.account_ids, []), extraPermissions: P(r.extra_permissions, []), active: !!r.active, role: r.role_id, supervisorId: r.supervisor_id };
}
function withPerms(u) {
  if (!u) return null;
  const rolePerms = db.prepare("SELECT permission FROM role_permissions WHERE role_id = ?").all(u.role_id).map((p) => p.permission);
  u.permissions = [...new Set([...rolePerms, ...u.extraPermissions])];
  return u;
}
export function listUsers() { return db.prepare("SELECT * FROM users ORDER BY created_at").all().map(rowToUser).map(withPerms); }
export function getUser(id) { return withPerms(rowToUser(db.prepare("SELECT * FROM users WHERE id = ?").get(id))); }
export function findByUsername(username) {
  return withPerms(rowToUser(db.prepare("SELECT * FROM users WHERE username = ?").get((username || "").trim().toLowerCase())));
}
export function publicUser(u) {
  if (!u) return null;
  const { password_hash, account_ids, extra_permissions, role_id, supervisor_id, ...safe } = u;
  const role = db.prepare("SELECT name FROM roles WHERE id = ?").get(u.role_id);
  return { ...safe, role: u.role_id, roleName: role?.name || u.role_id, isSuper: u.role_id === "super_admin" };
}
export function hasUsers() { return !!db.prepare("SELECT 1 FROM users LIMIT 1").get(); }
export function countActive() { return db.prepare("SELECT COUNT(*) c FROM users WHERE active = 1").get().c; }

export function createUser({ name, username, password, role = "agent", accountIds = [], supervisorId = null, extraPermissions = [] }) {
  const uname = (username || "").trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,32}$/.test(uname)) throw new Error("اسم المستخدم: 3-32 حرفًا إنجليزيًا أو أرقامًا بدون مسافات");
  if (!name?.trim()) throw new Error("الاسم مطلوب");
  if (!password || password.length < 6) throw new Error("كلمة المرور 6 أحرف على الأقل");
  if (findByUsername(uname)) throw new Error("اسم المستخدم مستخدم مسبقًا");
  if (!db.prepare("SELECT 1 FROM roles WHERE id = ?").get(role)) throw new Error("الدور غير موجود");
  const id = crypto.randomUUID();
  db.prepare("INSERT INTO users (id, name, username, password_hash, role_id, supervisor_id, account_ids, extra_permissions, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)")
    .run(id, name.trim(), uname, bcrypt.hashSync(password, 10), role, supervisorId || null, J(Array.isArray(accountIds) ? accountIds : []), J(extraPermissions.filter((p) => PERMISSION_KEYS.includes(p))), now());
  return publicUser(getUser(id));
}

export function updateUser(id, patch) {
  const u = getUser(id);
  if (!u) throw new Error("المستخدم غير موجود");
  const sets = []; const args = [];
  if (patch.name !== undefined) { if (!patch.name.trim()) throw new Error("الاسم مطلوب"); sets.push("name = ?"); args.push(patch.name.trim()); }
  if (patch.role !== undefined) { if (!db.prepare("SELECT 1 FROM roles WHERE id = ?").get(patch.role)) throw new Error("الدور غير موجود"); sets.push("role_id = ?"); args.push(patch.role); }
  if (patch.accountIds !== undefined) { sets.push("account_ids = ?"); args.push(J(Array.isArray(patch.accountIds) ? patch.accountIds : [])); }
  if (patch.supervisorId !== undefined) { sets.push("supervisor_id = ?"); args.push(patch.supervisorId || null); }
  if (patch.extraPermissions !== undefined) { sets.push("extra_permissions = ?"); args.push(J((patch.extraPermissions || []).filter((p) => PERMISSION_KEYS.includes(p)))); }
  if (patch.active !== undefined) { sets.push("active = ?"); args.push(patch.active ? 1 : 0); }
  if (patch.password) {
    if (patch.password.length < 6) throw new Error("كلمة المرور 6 أحرف على الأقل");
    sets.push("password_hash = ?"); args.push(bcrypt.hashSync(patch.password, 10));
  }
  const nextRole = patch.role ?? u.role_id; const nextActive = patch.active ?? u.active;
  if ((nextRole !== "super_admin" || !nextActive) && !db.prepare("SELECT 1 FROM users WHERE id != ? AND role_id = 'super_admin' AND active = 1").get(id) && u.role_id === "super_admin") {
    throw new Error("يجب أن يبقى Super Admin واحد نشط على الأقل");
  }
  if (sets.length) db.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).run(...args, id);
  if (patch.password || patch.active === false) revokeUserSessions(id);
  return publicUser(getUser(id));
}

export function deleteUser(id) {
  const u = getUser(id);
  if (!u) return;
  if (u.role_id === "super_admin" && !db.prepare("SELECT 1 FROM users WHERE id != ? AND role_id = 'super_admin' AND active = 1").get(id)) throw new Error("لا يمكن حذف Super Admin الوحيد");
  db.transaction(() => {
    db.prepare("UPDATE users SET supervisor_id = NULL WHERE supervisor_id = ?").run(id);
    db.prepare("UPDATE conversations SET assigned_to = NULL, assigned_name = '' WHERE assigned_to = ?").run(id);
    db.prepare("UPDATE contacts SET assigned_to = NULL WHERE assigned_to = ?").run(id);
    db.prepare("DELETE FROM users WHERE id = ?").run(id);
  })();
}

export function verifyPassword(user, password) {
  return !!user && user.active && bcrypt.compareSync(password || "", user.password_hash);
}
export function touchSeen(id) { db.prepare("UPDATE users SET last_seen_at = ? WHERE id = ?").run(now(), id); }

export function bootstrapAdmin() {
  ensureRoles();
  if (hasUsers()) return;
  const pw = process.env.ADMIN_PASSWORD;
  if (!pw) return;
  createUser({ name: "المدير", username: process.env.ADMIN_USERNAME || "admin", password: pw, role: "super_admin" });
  console.log(`تم إنشاء حساب Super Admin: ${process.env.ADMIN_USERNAME || "admin"}`);
}

// ---------- الصلاحيات ----------
export const can = (user, perm) => !!user && (user.role_id === "super_admin" || (user.permissions || []).includes(perm));
export const isSuper = (user) => user?.role_id === "super_admin";

// معرّفات المستخدمين الذين يراهم المشرف (هو + فريقه)
export function teamIds(user) {
  if (!user) return [];
  const members = db.prepare("SELECT id FROM users WHERE supervisor_id = ?").all(user.id).map((r) => r.id);
  return [user.id, ...members];
}
export function canAccessAccount(user, accountId) {
  if (!user) return false;
  if (isSuper(user) || can(user, "view_all_conversations")) return true;
  return user.accountIds.includes(accountId);
}
export function allowedAccountIds(user, allIds) {
  if (!user) return [];
  return isSuper(user) || can(user, "view_all_conversations") ? allIds : allIds.filter((id) => user.accountIds.includes(id));
}

// ---------- الجلسات ----------
export function createSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  db.prepare("INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(token, userId, now(), now() + SESSION_MAX_AGE);
  if (Math.random() < 0.02) db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(now());
  return token;
}
export function userFromToken(token) {
  if (!token) return null;
  const s = db.prepare("SELECT user_id, expires_at FROM sessions WHERE token = ?").get(token);
  if (!s || s.expires_at < now()) return null;
  const u = getUser(s.user_id);
  return u && u.active ? u : null;
}
export function destroySession(token) { if (token) db.prepare("DELETE FROM sessions WHERE token = ?").run(token); }
export function revokeUserSessions(userId) { db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId); }
