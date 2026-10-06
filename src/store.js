// تخزين بسيط بملفات JSON: الحسابات، الرسائل، والإعدادات
import fs from "node:fs";
import path from "node:path";

const DATA_DIR = process.env.DATA_DIR || path.resolve("data");
const ACCOUNTS_FILE = path.join(DATA_DIR, "accounts.json");
const MESSAGES_DIR = path.join(DATA_DIR, "messages");
const MAX_MESSAGES_PER_CHAT = 500;

fs.mkdirSync(MESSAGES_DIR, { recursive: true });

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

// ---------- الحسابات ----------
export function listAccounts() {
  return readJson(ACCOUNTS_FILE, []);
}

export function getAccount(id) {
  return listAccounts().find((a) => a.id === id) || null;
}

export function saveAccount(account) {
  const accounts = listAccounts();
  const idx = accounts.findIndex((a) => a.id === account.id);
  if (idx === -1) accounts.push(account);
  else accounts[idx] = { ...accounts[idx], ...account };
  writeJson(ACCOUNTS_FILE, accounts);
  return getAccount(account.id);
}

export function deleteAccount(id) {
  writeJson(
    ACCOUNTS_FILE,
    listAccounts().filter((a) => a.id !== id),
  );
  fs.rmSync(path.join(MESSAGES_DIR, id), { recursive: true, force: true });
  fs.rmSync(path.join(DATA_DIR, "sessions", id), { recursive: true, force: true });
}

// ---------- المحادثات والرسائل ----------
function chatsFile(accountId) {
  return path.join(MESSAGES_DIR, accountId, "chats.json");
}

function chatFile(accountId, chatId) {
  return path.join(MESSAGES_DIR, accountId, `${encodeURIComponent(chatId)}.json`);
}

export function listChats(accountId) {
  return readJson(chatsFile(accountId), []).sort(
    (a, b) => (b.lastTimestamp || 0) - (a.lastTimestamp || 0),
  );
}

export function upsertChat(accountId, chat) {
  const chats = readJson(chatsFile(accountId), []);
  const idx = chats.findIndex((c) => c.id === chat.id);
  const merged = idx === -1 ? chat : { ...chats[idx], ...chat };
  if (idx === -1) chats.push(merged);
  else chats[idx] = merged;
  writeJson(chatsFile(accountId), chats);
  return merged;
}

export function listMessages(accountId, chatId) {
  return readJson(chatFile(accountId, chatId), []);
}

export function addMessage(accountId, message) {
  const file = chatFile(accountId, message.chatId);
  const messages = readJson(file, []);
  const dup = messages.find((m) => m.id === message.id);
  if (dup) {
    if (!message.edited) return dup;
    dup.text = message.text; // تعديل رسالة سابقة
    writeJson(file, messages);
    return dup;
  }
  messages.push(message);
  if (messages.length > MAX_MESSAGES_PER_CHAT) messages.splice(0, messages.length - MAX_MESSAGES_PER_CHAT);
  writeJson(file, messages);

  const existing = readJson(chatsFile(accountId), []).find((c) => c.id === message.chatId);
  upsertChat(accountId, {
    id: message.chatId,
    name: existing?.name || message.chatName || message.chatId.split("@")[0],
    lastMessage: message.text?.slice(0, 120) || "",
    lastTimestamp: message.timestamp,
    unread: message.fromMe ? 0 : (existing?.unread || 0) + 1,
  });
  return message;
}

// استيراد دفعة رسائل من سجل الهاتف: بدون زيادة "غير مقروء"، مع ترتيب زمني وحفظ آخر 500
export function importHistory(accountId, messages) {
  const byChat = new Map();
  for (const m of messages) {
    if (!byChat.has(m.chatId)) byChat.set(m.chatId, []);
    byChat.get(m.chatId).push(m);
  }
  const chats = readJson(chatsFile(accountId), []);
  let added = 0;
  for (const [chatId, list] of byChat) {
    const file = chatFile(accountId, chatId);
    const existing = readJson(file, []);
    const ids = new Set(existing.map((m) => m.id));
    const fresh = list.filter((m) => !ids.has(m.id));
    if (!fresh.length) continue;
    added += fresh.length;
    const merged = [...existing, ...fresh].sort((a, b) => a.timestamp - b.timestamp);
    if (merged.length > MAX_MESSAGES_PER_CHAT) merged.splice(0, merged.length - MAX_MESSAGES_PER_CHAT);
    writeJson(file, merged);
    const last = merged[merged.length - 1];
    const idx = chats.findIndex((c) => c.id === chatId);
    const base = idx === -1 ? { id: chatId, unread: 0 } : chats[idx];
    const next = {
      ...base,
      name: base.name || fresh.find((m) => m.chatName)?.chatName || chatId.split("@")[0],
      lastMessage: (last.timestamp >= (base.lastTimestamp || 0) ? last.text : base.lastMessage || "")?.slice(0, 120) || "",
      lastTimestamp: Math.max(base.lastTimestamp || 0, last.timestamp),
    };
    if (idx === -1) chats.push(next); else chats[idx] = next;
  }
  writeJson(chatsFile(accountId), chats);
  return added;
}

export function oldestMessage(accountId, chatId) {
  return readJson(chatFile(accountId, chatId), [])[0] || null;
}

export function markChatRead(accountId, chatId) {
  upsertChat(accountId, { id: chatId, unread: 0 });
}

export function updateMessageStatus(accountId, chatId, messageId, status) {
  const file = chatFile(accountId, chatId);
  const messages = readJson(file, []);
  const msg = messages.find((m) => m.id === messageId);
  if (!msg) return;
  msg.status = status;
  writeJson(file, messages);
}

export function sessionDir(accountId) {
  const dir = path.join(DATA_DIR, "sessions", accountId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------- الوسائط ----------
export function mediaDir(accountId) {
  const dir = path.join(DATA_DIR, "media", accountId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function saveMedia(accountId, messageId, buffer, mimetype, fileName) {
  const ext = (fileName && path.extname(fileName)) || mimeToExt(mimetype);
  const safeId = messageId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const name = `${safeId}${ext}`;
  fs.writeFileSync(path.join(mediaDir(accountId), name), buffer);
  return { url: `/media/${accountId}/${name}`, mimetype, fileName: fileName || name, size: buffer.length };
}

export function mimeToExt(mimetype = "") {
  const map = {
    "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif",
    "video/mp4": ".mp4", "audio/ogg; codecs=opus": ".ogg", "audio/ogg": ".ogg", "audio/mpeg": ".mp3", "audio/mp4": ".m4a",
    "application/pdf": ".pdf",
  };
  return map[mimetype] || map[mimetype.split(";")[0]] || ".bin";
}

// ---------- الردود الجاهزة ----------
const TEMPLATES_FILE = path.join(DATA_DIR, "templates.json");
export function listTemplates() { return readJson(TEMPLATES_FILE, []); }
export function saveTemplate(t) {
  const all = listTemplates();
  const idx = all.findIndex((x) => x.id === t.id);
  if (idx === -1) all.push(t); else all[idx] = { ...all[idx], ...t };
  writeJson(TEMPLATES_FILE, all);
  return all.find((x) => x.id === t.id);
}
export function deleteTemplate(id) { writeJson(TEMPLATES_FILE, listTemplates().filter((x) => x.id !== id)); }

// ---------- الردود التلقائية ----------
const RULES_FILE = path.join(DATA_DIR, "auto-replies.json");
export function listRules() { return readJson(RULES_FILE, []); }
export function saveRule(r) {
  const all = listRules();
  const idx = all.findIndex((x) => x.id === r.id);
  if (idx === -1) all.push(r); else all[idx] = { ...all[idx], ...r };
  writeJson(RULES_FILE, all);
  return all.find((x) => x.id === r.id);
}
export function deleteRule(id) { writeJson(RULES_FILE, listRules().filter((x) => x.id !== id)); }
