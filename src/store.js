// التخزين الأساسي على SQLite: الأرقام، المحادثات، الرسائل، الوسائط، القوالب، الردود التلقائية
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { db, DATA_DIR, J, P, now, paginate, convRef } from "./db.js";
import { normalizePhone, jidToPhone } from "./phone.js";

const MAX_MESSAGES_PER_CHAT = 5000;

// ---------- الحسابات (أرقام واتساب) ----------
const accRow = (r) => r && ({ id: r.id, label: r.label, type: r.type, phone: r.phone, pushName: r.push_name, phoneNumberId: r.phone_number_id, accessToken: r.access_token, createdAt: r.created_at });
export function listAccounts() { return db.prepare("SELECT * FROM accounts ORDER BY created_at").all().map(accRow); }
export function getAccount(id) { return accRow(db.prepare("SELECT * FROM accounts WHERE id = ?").get(id)) || null; }
export function saveAccount(a) {
  const cur = getAccount(a.id);
  if (!cur) {
    db.prepare("INSERT INTO accounts (id, label, type, phone, push_name, phone_number_id, access_token, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(a.id, a.label || "رقم جديد", a.type || "qr", a.phone || "", a.pushName || "", a.phoneNumberId || null, a.accessToken || null, a.createdAt || now());
  } else {
    db.prepare("UPDATE accounts SET label = ?, type = ?, phone = ?, push_name = ?, phone_number_id = ?, access_token = ? WHERE id = ?")
      .run(a.label ?? cur.label, a.type ?? cur.type, a.phone ?? cur.phone, a.pushName ?? cur.pushName, a.phoneNumberId ?? cur.phoneNumberId, a.accessToken ?? cur.accessToken, a.id);
  }
  return getAccount(a.id);
}
export function deleteAccount(id) {
  db.transaction(() => {
    db.prepare("DELETE FROM message_media WHERE account_id = ?").run(id);
    db.prepare("DELETE FROM messages WHERE account_id = ?").run(id);
    db.prepare("DELETE FROM conversations WHERE account_id = ?").run(id);
    db.prepare("DELETE FROM accounts WHERE id = ?").run(id);
  })();
  fs.rmSync(path.join(DATA_DIR, "media", id), { recursive: true, force: true });
  fs.rmSync(path.join(DATA_DIR, "sessions", id), { recursive: true, force: true });
}
export function sessionDir(accountId) {
  const dir = path.join(DATA_DIR, "sessions", accountId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------- المحادثات ----------
export const convRow = (r) => r && ({
  id: r.chat_id, ref: r.ref, accountId: r.account_id, contactId: r.contact_id, name: r.name, isGroup: !!r.is_group,
  lastMessage: r.last_message, lastTimestamp: r.last_timestamp, unread: r.unread, status: r.status,
  assignedTo: r.assigned_to, assignedName: r.assigned_name, closedAt: r.closed_at, updatedAt: r.updated_at,
});
export function getChatByRef(ref) {
  const r = db.prepare("SELECT c.*, a.label account_label, a.phone account_phone FROM conversations c JOIN accounts a ON a.id = c.account_id WHERE c.ref = ?").get(ref);
  return r ? { ...convRow(r), accountLabel: r.account_label, accountPhone: r.account_phone } : null;
}
export function getChat(accountId, chatId) { return convRow(db.prepare("SELECT * FROM conversations WHERE account_id = ? AND chat_id = ?").get(accountId, chatId)) || null; }
export function listChats(accountId) {
  return db.prepare("SELECT * FROM conversations WHERE account_id = ? ORDER BY last_timestamp DESC").all(accountId).map(convRow);
}
// ربط المحادثة بسجل عميل عبر الرقم الموحّد (ينشئ العميل تلقائيًا للمحادثات الفردية)
function linkContact(accountId, chatId, name) {
  if (chatId.endsWith("@g.us")) return null;
  const n = normalizePhone(jidToPhone(chatId));
  if (!n.ok) return null;
  let c = db.prepare("SELECT id, name FROM contacts WHERE phone = ?").get(n.phone);
  if (!c) {
    const id = crypto.randomUUID();
    db.prepare("INSERT INTO contacts (id, phone, name, source, created_at, updated_at) VALUES (?, ?, ?, 'whatsapp', ?, ?)").run(id, n.phone, name || "", now(), now());
    c = { id, name: name || "" };
  } else if (!c.name && name) {
    db.prepare("UPDATE contacts SET name = ?, updated_at = ? WHERE id = ?").run(name, now(), c.id);
  }
  return c.id;
}
export function upsertChat(accountId, chat) {
  const cur = db.prepare("SELECT * FROM conversations WHERE account_id = ? AND chat_id = ?").get(accountId, chat.id);
  if (!cur) {
    const contactId = linkContact(accountId, chat.id, chat.name);
    db.prepare(`INSERT INTO conversations (account_id, chat_id, ref, contact_id, name, is_group, last_message, last_timestamp, unread, status, assigned_to, assigned_name, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(accountId, chat.id, convRef(accountId, chat.id), contactId, chat.name || "", chat.id.endsWith("@g.us") ? 1 : 0, chat.lastMessage || "", chat.lastTimestamp || 0, chat.unread || 0, chat.status || "new", chat.assignedTo || null, chat.assignedName || "", now());
  } else {
    const contactId = cur.contact_id || linkContact(accountId, chat.id, chat.name || cur.name);
    db.prepare(`UPDATE conversations SET contact_id = ?, name = ?, last_message = ?, last_timestamp = ?, unread = ?, status = ?, assigned_to = ?, assigned_name = ?, closed_at = ?, updated_at = ?
      WHERE account_id = ? AND chat_id = ?`)
      .run(contactId, chat.name ?? cur.name, chat.lastMessage ?? cur.last_message, chat.lastTimestamp ?? cur.last_timestamp, chat.unread ?? cur.unread,
        chat.status ?? cur.status, chat.assignedTo === undefined ? cur.assigned_to : chat.assignedTo || null, chat.assignedName === undefined ? cur.assigned_name : chat.assignedName || "",
        chat.closedAt === undefined ? cur.closed_at : chat.closedAt, now(), accountId, chat.id);
  }
  return getChat(accountId, chat.id);
}
export function markChatRead(accountId, chatId) { db.prepare("UPDATE conversations SET unread = 0 WHERE account_id = ? AND chat_id = ?").run(accountId, chatId); }

// صندوق موحّد مع فلاتر وترقيم
export function queryConversations({ accountIds, status, unreadOnly, assignedTo, unassigned, assignedIn, q, contactIds, page, limit }) {
  if (!accountIds?.length) return { rows: [], total: 0, page: 1, limit: 25 };
  const where = [`c.account_id IN (${accountIds.map(() => "?").join(",")})`]; const args = [...accountIds];
  if (status && status !== "all") { where.push("c.status = ?"); args.push(status); }
  if (unreadOnly) where.push("c.unread > 0");
  if (assignedTo) { where.push("c.assigned_to = ?"); args.push(assignedTo); }
  if (unassigned) where.push("c.assigned_to IS NULL");
  if (assignedIn?.length) { where.push(`(c.assigned_to IN (${assignedIn.map(() => "?").join(",")}))`); args.push(...assignedIn); }
  if (contactIds) { if (!contactIds.length) return { rows: [], total: 0, page: 1, limit: 25 }; where.push(`c.contact_id IN (${contactIds.map(() => "?").join(",")})`); args.push(...contactIds); }
  if (q) {
    const qa = `%${String(q).replace(/[أإآ]/g, "ا").replace(/ة/g, "ه").replace(/ى/g, "ي")}%`;
    where.push("(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(c.name,'أ','ا'),'إ','ا'),'آ','ا'),'ة','ه'),'ى','ي') LIKE ? OR c.chat_id LIKE ? OR c.last_message LIKE ?)"); args.push(qa, `%${String(q).replace(/\D/g, "") || q}%`, `%${q}%`);
  }
  const { limit: l, offset, page: p } = paginate({ page, limit, max: 100 });
  const w = where.join(" AND ");
  const total = db.prepare(`SELECT COUNT(*) c FROM conversations c WHERE ${w}`).get(...args).c;
  const rows = db.prepare(`SELECT c.*, a.label account_label, a.phone account_phone, ct.category contact_category FROM conversations c
    JOIN accounts a ON a.id = c.account_id LEFT JOIN contacts ct ON ct.id = c.contact_id WHERE ${w} ORDER BY c.last_timestamp DESC LIMIT ? OFFSET ?`).all(...args, l, offset)
    .map((r) => ({ ...convRow(r), accountLabel: r.account_label, accountPhone: r.account_phone, category: r.contact_category || "" }));
  return { rows, total, page: p, limit: l };
}
export function conversationsForContact(contactId) {
  return db.prepare("SELECT c.*, a.label account_label FROM conversations c JOIN accounts a ON a.id = c.account_id WHERE c.contact_id = ? ORDER BY c.last_timestamp DESC").all(contactId)
    .map((r) => ({ ...convRow(r), accountLabel: r.account_label }));
}

// ---------- الرسائل ----------
const mediaRow = (r) => r && r.m_media_type ? ({
  mediaType: r.m_media_type, mimetype: r.m_mime_type, fileName: r.m_file_name, size: r.m_file_size, url: r.m_url, thumbnail: r.m_thumbnail,
  caption: r.m_caption, state: r.m_state, providerMediaId: r.m_provider_media_id,
}) : undefined;
const MSG_SELECT = `SELECT m.*, md.media_type m_media_type, md.mime_type m_mime_type, md.file_name m_file_name, md.file_size m_file_size, md.url m_url,
  md.thumbnail m_thumbnail, md.caption m_caption, md.state m_state, md.provider_media_id m_provider_media_id
  FROM messages m LEFT JOIN message_media md ON md.account_id = m.account_id AND md.message_id = m.id`;
export const msgRow = (r) => r && ({
  id: r.id, accountId: r.account_id, chatId: r.chat_id, fromMe: !!r.from_me, text: r.text, mediaType: r.media_type || null, timestamp: r.timestamp,
  status: r.status, statusReason: r.status_reason || null, sender: r.sender, isGroup: !!r.is_group, edited: !!r.edited, key: P(r.key_json), campaignId: r.campaign_id || null,
  media: mediaRow(r),
});
export function listMessages(accountId, chatId, { before, limit = 50 } = {}) {
  const l = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const rows = before
    ? db.prepare(`${MSG_SELECT} WHERE m.account_id = ? AND m.chat_id = ? AND m.timestamp < ? ORDER BY m.timestamp DESC LIMIT ?`).all(accountId, chatId, Number(before), l)
    : db.prepare(`${MSG_SELECT} WHERE m.account_id = ? AND m.chat_id = ? ORDER BY m.timestamp DESC LIMIT ?`).all(accountId, chatId, l);
  return rows.reverse().map(msgRow);
}
export function getMessage(accountId, id) { return msgRow(db.prepare(`${MSG_SELECT} WHERE m.account_id = ? AND m.id = ?`).get(accountId, id)) || null; }
export function oldestMessage(accountId, chatId) { return msgRow(db.prepare(`${MSG_SELECT} WHERE m.account_id = ? AND m.chat_id = ? ORDER BY m.timestamp ASC LIMIT 1`).get(accountId, chatId)) || null; }

const insMsg = db.prepare(`INSERT INTO messages (account_id, id, chat_id, from_me, text, media_type, timestamp, status, status_reason, sender, is_group, edited, key_json, campaign_id, sent_by, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const insMedia = db.prepare(`INSERT OR REPLACE INTO message_media (account_id, message_id, media_type, mime_type, file_name, file_size, path, url, thumbnail, caption, state, provider_media_id, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
function writeMedia(accountId, message) {
  const m = message.media;
  if (!m && !message.mediaType) return;
  insMedia.run(accountId, message.id, message.mediaType || m?.mediaType || "document", m?.mimetype || "", m?.fileName || "", m?.size || 0, m?.path || "", m?.url || "",
    m?.thumbnail || null, m?.caption || "", m?.state || (m?.url ? "ready" : "unavailable"), m?.providerMediaId || null, now());
}
function insertRaw(accountId, m) {
  insMsg.run(accountId, m.id, m.chatId, m.fromMe ? 1 : 0, m.text || "", m.mediaType || null, m.timestamp, m.status || (m.fromMe ? "sent" : "received"), m.statusReason || null,
    m.sender || "", m.isGroup ? 1 : 0, m.edited ? 1 : 0, m.key ? J(m.key) : null, m.campaignId || null, m.sentBy || null, now());
  writeMedia(accountId, m);
}
export function addMessage(accountId, message) {
  const existing = db.prepare("SELECT id FROM messages WHERE account_id = ? AND id = ?").get(accountId, message.id);
  if (existing) {
    if (message.edited) db.prepare("UPDATE messages SET text = ?, edited = 1 WHERE account_id = ? AND id = ?").run(message.text, accountId, message.id);
    return getMessage(accountId, message.id);
  }
  db.transaction(() => {
    insertRaw(accountId, message);
    const cur = db.prepare("SELECT * FROM conversations WHERE account_id = ? AND chat_id = ?").get(accountId, message.chatId);
    const nextStatus = !cur ? (message.fromMe ? "replied" : "new")
      : message.fromMe ? (cur.status === "closed" ? "closed" : "replied")
      : (cur.status === "new" ? "new" : "waiting");
    upsertChat(accountId, {
      id: message.chatId, name: cur?.name || message.chatName || undefined,
      lastMessage: (message.text || "").slice(0, 120), lastTimestamp: message.timestamp,
      unread: message.fromMe ? 0 : (cur?.unread || 0) + 1, status: nextStatus, closedAt: nextStatus === "closed" ? undefined : null,
    });
    if (!message.isGroup) {
      const conv = getChat(accountId, message.chatId);
      if (conv?.contactId) db.prepare("UPDATE contacts SET last_contact_at = ? WHERE id = ? AND (last_contact_at IS NULL OR last_contact_at < ?)").run(message.timestamp, conv.contactId, message.timestamp);
    }
    trimChat(accountId, message.chatId);
  })();
  return getMessage(accountId, message.id);
}
function trimChat(accountId, chatId) {
  const c = db.prepare("SELECT COUNT(*) c FROM messages WHERE account_id = ? AND chat_id = ?").get(accountId, chatId).c;
  if (c > MAX_MESSAGES_PER_CHAT + 200) {
    db.prepare(`DELETE FROM messages WHERE account_id = ? AND chat_id = ? AND id IN (SELECT id FROM messages WHERE account_id = ? AND chat_id = ? ORDER BY timestamp ASC LIMIT ?)`)
      .run(accountId, chatId, accountId, chatId, c - MAX_MESSAGES_PER_CHAT);
  }
}
// استيراد سجل الهاتف: بدون زيادة "غير مقروء"
export function importHistory(accountId, messages) {
  let added = 0;
  db.transaction(() => {
    const touched = new Map();
    for (const m of messages) {
      if (db.prepare("SELECT 1 FROM messages WHERE account_id = ? AND id = ?").get(accountId, m.id)) continue;
      insertRaw(accountId, m);
      added++;
      const t = touched.get(m.chatId);
      if (!t || t.timestamp < m.timestamp) touched.set(m.chatId, m);
    }
    for (const [chatId, m] of touched) {
      const cur = db.prepare("SELECT * FROM conversations WHERE account_id = ? AND chat_id = ?").get(accountId, chatId);
      const newer = !cur || m.timestamp >= (cur.last_timestamp || 0);
      upsertChat(accountId, {
        id: chatId, name: cur?.name || m.chatName || undefined,
        lastMessage: newer ? (m.text || "").slice(0, 120) : undefined, lastTimestamp: newer ? m.timestamp : undefined,
        unread: cur?.unread ?? 0, status: cur?.status || (m.fromMe ? "replied" : "waiting"),
      });
    }
  })();
  return added;
}
export function updateMessageStatus(accountId, chatId, messageId, status, reason = null) {
  const r = db.prepare("UPDATE messages SET status = ?, status_reason = COALESCE(?, status_reason) WHERE account_id = ? AND id = ?").run(status, reason, accountId, messageId);
  return r.changes > 0;
}
export function updateMediaState(accountId, messageId, state) { db.prepare("UPDATE message_media SET state = ? WHERE account_id = ? AND message_id = ?").run(state, accountId, messageId); }

// ---------- الوسائط على القرص ----------
export function mediaDir(accountId) {
  const dir = path.join(DATA_DIR, "media", accountId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
export function mimeToExt(mimetype = "") {
  const map = {
    "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif", "video/mp4": ".mp4", "video/3gpp": ".3gp",
    "audio/ogg; codecs=opus": ".ogg", "audio/ogg": ".ogg", "audio/mpeg": ".mp3", "audio/mp4": ".m4a", "audio/aac": ".aac", "audio/wav": ".wav",
    "application/pdf": ".pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx", "application/vnd.ms-excel": ".xls", "text/csv": ".csv", "text/plain": ".txt",
  };
  return map[mimetype] || map[mimetype.split(";")[0]] || ".bin";
}
export function saveMedia(accountId, messageId, buffer, mimetype, fileName, extra = {}) {
  const ext = (fileName && path.extname(fileName)) || mimeToExt(mimetype);
  const safeId = String(messageId).replace(/[^a-zA-Z0-9_-]/g, "_");
  const name = `${safeId}${ext}`;
  const abs = path.join(mediaDir(accountId), name);
  fs.writeFileSync(abs, buffer);
  return { url: `/media/${accountId}/${name}`, path: abs, mimetype, fileName: fileName || name, size: buffer.length, state: "ready", ...extra };
}
export function mediaFilePath(accountId, file) { return path.join(DATA_DIR, "media", accountId, path.basename(file)); }

// ---------- القوالب ----------
const tplRow = (r) => r && ({ id: r.id, title: r.title, text: r.text, kind: r.kind, metaName: r.meta_name, language: r.language, createdAt: r.created_at, updatedAt: r.updated_at });
export function listTemplates(kind) {
  return (kind ? db.prepare("SELECT * FROM templates WHERE kind = ? ORDER BY title").all(kind) : db.prepare("SELECT * FROM templates ORDER BY kind, title").all()).map(tplRow);
}
export function getTemplate(id) { return tplRow(db.prepare("SELECT * FROM templates WHERE id = ?").get(id)) || null; }
export function saveTemplate(t) {
  const id = t.id || crypto.randomUUID();
  db.prepare(`INSERT INTO templates (id, title, text, kind, meta_name, language, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET title = excluded.title, text = excluded.text, kind = excluded.kind, meta_name = excluded.meta_name, language = excluded.language, updated_at = excluded.updated_at`)
    .run(id, t.title, t.text, t.kind || "quick", t.metaName || null, t.language || "ar", now(), now());
  return getTemplate(id);
}
export function deleteTemplate(id) { db.prepare("DELETE FROM templates WHERE id = ?").run(id); }

// ---------- الردود التلقائية ----------
export function listRules() { return db.prepare("SELECT * FROM rules ORDER BY created_at").all().map((r) => ({ id: r.id, ...P(r.config, {}) })); }
export function saveRule(r) {
  const id = r.id || crypto.randomUUID();
  const { id: _, ...config } = r;
  db.prepare("INSERT INTO rules (id, config, created_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET config = excluded.config").run(id, J(config), now());
  return { id, ...config };
}
export function deleteRule(id) { db.prepare("DELETE FROM rules WHERE id = ?").run(id); }
