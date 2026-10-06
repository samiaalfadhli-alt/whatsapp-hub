// إحصاءات لوحة التحكم والتقارير (استعلامات مجمّعة خفيفة)
import { db } from "./db.js";

const dayStart = (d = new Date()) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); };
const DAY = 86400_000;

function accountFilter(accountIds, col = "account_id") {
  if (!accountIds) return { sql: "1=1", args: [] };
  if (!accountIds.length) return { sql: "1=0", args: [] };
  return { sql: `${col} IN (${accountIds.map(() => "?").join(",")})`, args: [...accountIds] };
}

export function summary({ accountIds, accountsStatus }) {
  const today = dayStart(); const week = today - 6 * DAY;
  const f = accountFilter(accountIds);
  const q1 = (sql, ...a) => db.prepare(sql).get(...a).c;
  const msgToday = db.prepare(`SELECT
      SUM(CASE WHEN from_me = 1 THEN 1 ELSE 0 END) sent, SUM(CASE WHEN from_me = 0 THEN 1 ELSE 0 END) received,
      SUM(CASE WHEN status IN ('failed','error') THEN 1 ELSE 0 END) failed
    FROM messages WHERE ${f.sql} AND timestamp >= ?`).get(...f.args, today);
  return {
    contacts: {
      total: q1("SELECT COUNT(*) c FROM contacts"),
      today: q1("SELECT COUNT(*) c FROM contacts WHERE created_at >= ?", today),
      week: q1("SELECT COUNT(*) c FROM contacts WHERE created_at >= ?", week),
    },
    conversations: {
      active: q1(`SELECT COUNT(*) c FROM conversations WHERE ${f.sql} AND status != 'closed' AND last_timestamp >= ?`, ...f.args, today - 7 * DAY),
      unread: db.prepare(`SELECT COALESCE(SUM(unread),0) c FROM conversations WHERE ${f.sql}`).get(...f.args).c,
      waiting: q1(`SELECT COUNT(*) c FROM conversations WHERE ${f.sql} AND status IN ('new','waiting')`, ...f.args),
    },
    messagesToday: { sent: msgToday.sent || 0, received: msgToday.received || 0, failed: msgToday.failed || 0 },
    users: { active: q1("SELECT COUNT(*) c FROM users WHERE active = 1"), online: q1("SELECT COUNT(*) c FROM users WHERE active = 1 AND last_seen_at >= ?", Date.now() - 5 * 60_000) },
    whatsapp: accountsStatus,
    tasksDue: q1("SELECT COUNT(*) c FROM tasks WHERE status = 'open' AND due_at IS NOT NULL AND due_at <= ?", Date.now() + DAY),
  };
}

// سلاسل زمنية لآخر N يومًا
export function series({ accountIds, days = 14 }) {
  const start = dayStart() - (days - 1) * DAY;
  const f = accountFilter(accountIds);
  const bucket = (rows, key = "d") => { const m = new Map(rows.map((r) => [r[key], r])); return Array.from({ length: days }, (_, i) => { const d = start + i * DAY; return { date: d, ...(m.get(d) || {}) }; }); };
  const contacts = db.prepare("SELECT (created_at / 86400000) * 86400000 d, COUNT(*) count FROM contacts WHERE created_at >= ? GROUP BY d").all(start);
  const messages = db.prepare(`SELECT (timestamp / 86400000) * 86400000 d, SUM(from_me) sent, SUM(1 - from_me) received FROM messages WHERE ${f.sql} AND timestamp >= ? GROUP BY d`).all(...f.args, start);
  const conversations = db.prepare(`SELECT (last_timestamp / 86400000) * 86400000 d, COUNT(*) count FROM conversations WHERE ${f.sql} AND last_timestamp >= ? GROUP BY d`).all(...f.args, start);
  // تقريب المجموعات إلى بداية اليوم المحلي
  const fix = (rows) => rows.map((r) => ({ ...r, d: dayStart(new Date(r.d + 12 * 3600_000)) }));
  return { days, start, contacts: bucket(fix(contacts)), messages: bucket(fix(messages)), conversations: bucket(fix(conversations)) };
}

export function breakdowns({ accountIds, days = 30 }) {
  const start = dayStart() - (days - 1) * DAY;
  const f = accountFilter(accountIds, "c.account_id");
  return {
    sources: db.prepare("SELECT COALESCE(NULLIF(source,''),'غير محدد') label, COUNT(*) count FROM contacts GROUP BY label ORDER BY count DESC LIMIT 8").all(),
    categories: db.prepare("SELECT COALESCE(NULLIF(category,''),'غير مصنف') label, COUNT(*) count FROM contacts GROUP BY label ORDER BY count DESC LIMIT 8").all(),
    agents: db.prepare(`SELECT u.id, u.name label,
        (SELECT COUNT(*) FROM conversations c WHERE c.assigned_to = u.id AND ${f.sql}) conversations,
        (SELECT COUNT(*) FROM conversations c WHERE c.assigned_to = u.id AND c.status = 'closed' AND ${f.sql}) closed,
        (SELECT COUNT(*) FROM messages m WHERE m.sent_by = u.id AND m.timestamp >= ?) sent,
        (SELECT COUNT(*) FROM contacts ct WHERE ct.assigned_to = u.id) contacts
      FROM users u WHERE u.active = 1 ORDER BY sent DESC`).all(...f.args, ...f.args, start),
    statuses: db.prepare(`SELECT status label, COUNT(*) count FROM conversations c WHERE ${f.sql} GROUP BY status`).all(...f.args),
    messageStatuses: db.prepare(`SELECT status label, COUNT(*) count FROM messages m WHERE from_me = 1 AND timestamp >= ? AND ${accountFilter(accountIds, "m.account_id").sql} GROUP BY status`).all(start, ...accountFilter(accountIds).args),
  };
}
