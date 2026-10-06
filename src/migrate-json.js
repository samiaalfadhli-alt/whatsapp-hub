// ترحيل آمن لمرة واحدة من ملفات JSON القديمة إلى SQLite (الملفات القديمة لا تُحذف)
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { db, DATA_DIR, J, getSetting, setSetting, now } from "./db.js";
import * as store from "./store.js";
import { ensureRoles } from "./users.js";

const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return fb; } };

export function migrateFromJson() {
  if (getSetting("json_migrated")) return null;
  const accountsFile = path.join(DATA_DIR, "accounts.json");
  const usersFile = path.join(DATA_DIR, "users.json");
  if (!fs.existsSync(accountsFile) && !fs.existsSync(usersFile)) { setSetting("json_migrated", { at: now(), empty: true }); return null; }

  const report = { accounts: 0, chats: 0, messages: 0, users: 0, sessions: 0, templates: 0, rules: 0, leads: 0 };
  ensureRoles(); // الأدوار النظامية قبل المستخدمين (مفتاح أجنبي)
  db.transaction(() => {
    // الأرقام
    for (const a of readJson(accountsFile, [])) { store.saveAccount(a); report.accounts++; }
    // المحادثات والرسائل
    const msgDir = path.join(DATA_DIR, "messages");
    if (fs.existsSync(msgDir)) {
      for (const accountId of fs.readdirSync(msgDir)) {
        const dir = path.join(msgDir, accountId);
        if (!fs.statSync(dir).isDirectory()) continue;
        const chats = readJson(path.join(dir, "chats.json"), []);
        for (const c of chats) { store.upsertChat(accountId, { id: c.id, name: c.name, lastMessage: c.lastMessage, lastTimestamp: c.lastTimestamp, unread: c.unread || 0, assignedTo: c.assignedTo, assignedName: c.assignedName, status: c.unread ? "new" : "replied" }); report.chats++; }
        for (const f of fs.readdirSync(dir)) {
          if (f === "chats.json" || !f.endsWith(".json")) continue;
          const msgs = readJson(path.join(dir, f), []);
          report.messages += store.importHistory(accountId, msgs.map((m) => ({ ...m, media: m.media ? { ...m.media, state: "ready" } : undefined })));
        }
      }
    }
    // المستخدمون: الدور القديم admin → super_admin، agent → agent
    for (const u of readJson(usersFile, [])) {
      if (db.prepare("SELECT 1 FROM users WHERE username = ?").get(u.username)) continue;
      db.prepare("INSERT INTO users (id, name, username, password_hash, role_id, account_ids, extra_permissions, active, created_at) VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?)")
        .run(u.id, u.name, u.username, u.passwordHash, u.role === "admin" ? "super_admin" : "agent", J(u.accountIds || []), u.active === false ? 0 : 1, u.createdAt || now());
      report.users++;
    }
    for (const [token, s] of Object.entries(readJson(path.join(DATA_DIR, "sessions.json"), {}))) {
      if (!s?.userId || !db.prepare("SELECT 1 FROM users WHERE id = ?").get(s.userId)) continue;
      db.prepare("INSERT OR IGNORE INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(token, s.userId, s.createdAt || now(), s.expiresAt || now());
      report.sessions++;
    }
    for (const t of readJson(path.join(DATA_DIR, "templates.json"), [])) { store.saveTemplate({ id: t.id, title: t.title, text: t.text, kind: "quick" }); report.templates++; }
    for (const r of readJson(path.join(DATA_DIR, "auto-replies.json"), [])) { store.saveRule(r); report.rules++; }
    for (const l of readJson(path.join(DATA_DIR, "leads.json"), [])) {
      db.prepare(`INSERT OR IGNORE INTO leads (id, timestamp, channel, from_addr, from_name, subject, text, matched, status, notified, notify_error, account_id, account_label, account_phone, chat_id, mailbox)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(l.id || crypto.randomUUID(), l.timestamp || now(), l.channel || "whatsapp", l.from || "", l.fromName || "", l.subject || "", l.text || "", J(l.matched || []), l.status || "new", l.notified ? 1 : 0, l.notifyError || null, l.accountId || null, l.accountLabel || null, l.accountPhone || null, l.chatId || null, l.mailbox || null);
      report.leads++;
    }
    const alerts = readJson(path.join(DATA_DIR, "alerts.json"), null);
    if (alerts) setSetting("alerts", alerts);
    setSetting("json_migrated", { at: now(), report });
  })();
  console.log("تم ترحيل البيانات القديمة إلى SQLite:", JSON.stringify(report));
  return report;
}
