// طبقة قاعدة البيانات: SQLite مضمّنة (ملف واحد في DATA_DIR) مع ترحيلات مرقّمة وفهارس
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import Database from "better-sqlite3";

export const DATA_DIR = process.env.DATA_DIR || path.resolve("data");
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(path.join(DATA_DIR, "hub.db"));
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");

// ---------- الترحيلات (تُنفَّذ مرة واحدة بالترتيب) ----------
const migrations = [
  // v1: المخطط الأساسي
  `
  CREATE TABLE IF NOT EXISTS roles (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, is_system INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS role_permissions (
    role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE, permission TEXT NOT NULL, PRIMARY KEY (role_id, permission)
  );
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
    role_id TEXT NOT NULL REFERENCES roles(id), supervisor_id TEXT, account_ids TEXT NOT NULL DEFAULT '[]',
    extra_permissions TEXT NOT NULL DEFAULT '[]', active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, last_seen_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_users_supervisor ON users(supervisor_id);
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

  CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY, label TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'qr', phone TEXT NOT NULL DEFAULT '', push_name TEXT NOT NULL DEFAULT '',
    phone_number_id TEXT, access_token TEXT, created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tags (
    id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, color TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS lists (
    id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS contacts (
    id TEXT PRIMARY KEY, phone TEXT NOT NULL UNIQUE, name TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '',
    company TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT '',
    assigned_to TEXT, notes TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active', opt_in INTEGER NOT NULL DEFAULT 1,
    created_by TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_contact_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_contacts_name ON contacts(name);
  CREATE INDEX IF NOT EXISTS idx_contacts_company ON contacts(company);
  CREATE INDEX IF NOT EXISTS idx_contacts_assigned ON contacts(assigned_to);
  CREATE INDEX IF NOT EXISTS idx_contacts_created ON contacts(created_at);
  CREATE INDEX IF NOT EXISTS idx_contacts_last ON contacts(last_contact_at);
  CREATE INDEX IF NOT EXISTS idx_contacts_category ON contacts(category);
  CREATE INDEX IF NOT EXISTS idx_contacts_source ON contacts(source);
  CREATE TABLE IF NOT EXISTS contact_tags (
    contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE, tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE, PRIMARY KEY (contact_id, tag_id)
  );
  CREATE INDEX IF NOT EXISTS idx_contact_tags_tag ON contact_tags(tag_id);
  CREATE TABLE IF NOT EXISTS list_contacts (
    list_id TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE, contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE, PRIMARY KEY (list_id, contact_id)
  );

  CREATE TABLE IF NOT EXISTS conversations (
    account_id TEXT NOT NULL, chat_id TEXT NOT NULL, contact_id TEXT, name TEXT NOT NULL DEFAULT '', is_group INTEGER NOT NULL DEFAULT 0,
    last_message TEXT NOT NULL DEFAULT '', last_timestamp INTEGER NOT NULL DEFAULT 0, unread INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'new', assigned_to TEXT, assigned_name TEXT NOT NULL DEFAULT '', closed_at INTEGER, updated_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (account_id, chat_id)
  );
  CREATE INDEX IF NOT EXISTS idx_conv_last ON conversations(last_timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_conv_assigned ON conversations(assigned_to);
  CREATE INDEX IF NOT EXISTS idx_conv_status ON conversations(status);
  CREATE INDEX IF NOT EXISTS idx_conv_contact ON conversations(contact_id);
  CREATE TABLE IF NOT EXISTS conversation_assignments (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL, chat_id TEXT NOT NULL, from_user TEXT, to_user TEXT, by_user TEXT, created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_conv_assign ON conversation_assignments(account_id, chat_id, created_at);

  CREATE TABLE IF NOT EXISTS messages (
    account_id TEXT NOT NULL, id TEXT NOT NULL, chat_id TEXT NOT NULL, from_me INTEGER NOT NULL DEFAULT 0, text TEXT NOT NULL DEFAULT '',
    media_type TEXT, timestamp INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'received', status_reason TEXT, sender TEXT NOT NULL DEFAULT '',
    is_group INTEGER NOT NULL DEFAULT 0, edited INTEGER NOT NULL DEFAULT 0, key_json TEXT, campaign_id TEXT, sent_by TEXT, created_at INTEGER NOT NULL,
    PRIMARY KEY (account_id, id)
  );
  CREATE INDEX IF NOT EXISTS idx_msg_chat ON messages(account_id, chat_id, timestamp);
  CREATE INDEX IF NOT EXISTS idx_msg_time ON messages(timestamp);
  CREATE INDEX IF NOT EXISTS idx_msg_campaign ON messages(campaign_id);
  CREATE TABLE IF NOT EXISTS message_media (
    account_id TEXT NOT NULL, message_id TEXT NOT NULL, media_type TEXT NOT NULL, mime_type TEXT NOT NULL DEFAULT '', file_name TEXT NOT NULL DEFAULT '',
    file_size INTEGER NOT NULL DEFAULT 0, path TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '', thumbnail TEXT, caption TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL DEFAULT 'ready', provider_media_id TEXT, created_at INTEGER NOT NULL,
    PRIMARY KEY (account_id, message_id)
  );

  CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY, contact_id TEXT REFERENCES contacts(id) ON DELETE CASCADE, account_id TEXT, chat_id TEXT,
    user_id TEXT, user_name TEXT NOT NULL DEFAULT '', text TEXT NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_notes_contact ON notes(contact_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_notes_chat ON notes(account_id, chat_id, created_at);
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY, contact_id TEXT REFERENCES contacts(id) ON DELETE CASCADE, title TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'task',
    due_at INTEGER, status TEXT NOT NULL DEFAULT 'open', assigned_to TEXT, created_by TEXT, created_at INTEGER NOT NULL, done_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_tasks_contact ON tasks(contact_id);
  CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(assigned_to, status, due_at);

  CREATE TABLE IF NOT EXISTS campaigns (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, account_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft',
    message_text TEXT NOT NULL DEFAULT '', template_id TEXT, media_json TEXT, audience_json TEXT NOT NULL DEFAULT '{}',
    scheduled_at INTEGER, started_at INTEGER, finished_at INTEGER, created_by TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    delay_ms INTEGER NOT NULL DEFAULT 4000
  );
  CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status);
  CREATE TABLE IF NOT EXISTS campaign_recipients (
    id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE, contact_id TEXT, phone TEXT NOT NULL, name TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending', reason TEXT, message_id TEXT, sent_at INTEGER, updated_at INTEGER NOT NULL,
    UNIQUE (campaign_id, phone)
  );
  CREATE INDEX IF NOT EXISTS idx_cr_status ON campaign_recipients(campaign_id, status);
  CREATE INDEX IF NOT EXISTS idx_cr_message ON campaign_recipients(message_id);

  CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY, user_id TEXT, user_name TEXT NOT NULL DEFAULT '', action TEXT NOT NULL, target_type TEXT NOT NULL DEFAULT '',
    target_id TEXT NOT NULL DEFAULT '', metadata TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_logs(target_type, target_id);

  CREATE TABLE IF NOT EXISTS leads (
    id TEXT PRIMARY KEY, timestamp INTEGER NOT NULL, channel TEXT NOT NULL, from_addr TEXT NOT NULL, from_name TEXT NOT NULL DEFAULT '',
    subject TEXT NOT NULL DEFAULT '', text TEXT NOT NULL DEFAULT '', matched TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'new',
    notified INTEGER NOT NULL DEFAULT 0, notify_error TEXT, account_id TEXT, account_label TEXT, account_phone TEXT, chat_id TEXT, mailbox TEXT, contact_id TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_leads_time ON leads(timestamp DESC);

  CREATE TABLE IF NOT EXISTS templates (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, text TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'quick', meta_name TEXT, language TEXT NOT NULL DEFAULT 'ar',
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS rules (
    id TEXT PRIMARY KEY, config TEXT NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY, value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS processed_events (
    id TEXT PRIMARY KEY, created_at INTEGER NOT NULL
  );
  `,
  // v2: معرّف مبهم للمحادثة (ref) حتى لا يظهر رقم الجوال في مسارات الـ API لمن لا يملك الصلاحية
  `
  ALTER TABLE conversations ADD COLUMN ref TEXT;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_ref ON conversations(ref);
  `,
  // v3: توحيد الرسائل القديمة المخزّنة بنص "غير مدعومة" أو "[type]" إلى علامة موحّدة
  `
  UPDATE messages SET text = '[unsupported:legacy]' WHERE text = '[رسالة غير مدعومة]';
  UPDATE messages SET text = '[unsupported:' || substr(text, 2) WHERE text GLOB '[[a-zA-Z]*]' AND text NOT LIKE '[unsupported:%';
  UPDATE conversations SET last_message = 'رسالة غير مدعومة' WHERE last_message = '[رسالة غير مدعومة]' OR last_message GLOB '[[a-zA-Z]*]';
  `,
];

db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
const applied = new Set(db.prepare("SELECT version FROM schema_migrations").all().map((r) => r.version));
db.transaction(() => {
  migrations.forEach((sql, i) => {
    const v = i + 1;
    if (applied.has(v)) return;
    db.exec(sql);
    db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(v, Date.now());
  });
})();

// ---------- أدوات مساعدة ----------
export const now = () => Date.now();
export const convRef = (accountId, chatId) => crypto.createHash("sha256").update(`${accountId}:${chatId}`).digest("hex").slice(0, 24);
// تعبئة ref للصفوف القديمة
db.prepare("SELECT account_id, chat_id FROM conversations WHERE ref IS NULL").all().forEach((r) => db.prepare("UPDATE conversations SET ref = ? WHERE account_id = ? AND chat_id = ?").run(convRef(r.account_id, r.chat_id), r.account_id, r.chat_id));
export const J = (v) => JSON.stringify(v ?? null);
export const P = (s, fallback = null) => { try { return s == null ? fallback : JSON.parse(s); } catch { return fallback; } };

export function getSetting(key, fallback = null) {
  const r = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return r ? P(r.value, fallback) : fallback;
}
export function setSetting(key, value) {
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, J(value));
  return value;
}

// منع تكرار معالجة أحداث المزوّد (Webhook/idempotency)؛ يحتفظ بآخر 7 أيام
export function markEventProcessed(id) {
  const r = db.prepare("INSERT OR IGNORE INTO processed_events (id, created_at) VALUES (?, ?)").run(id, now());
  if (Math.random() < 0.01) db.prepare("DELETE FROM processed_events WHERE created_at < ?").run(now() - 7 * 86400_000);
  return r.changes === 1; // true = جديد
}

// ترقيم الصفحات الموحّد
export function paginate({ page = 1, limit = 25, max = 200 } = {}) {
  const l = Math.min(Math.max(Number(limit) || 25, 1), max);
  const p = Math.max(Number(page) || 1, 1);
  return { limit: l, offset: (p - 1) * l, page: p };
}
