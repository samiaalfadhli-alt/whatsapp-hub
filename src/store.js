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
  if (messages.some((m) => m.id === message.id)) return message;
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
