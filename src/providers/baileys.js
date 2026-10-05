// مزوّد الربط عبر واتساب ويب (QR) باستخدام Baileys
import baileys, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  jidNormalizedUser,
  downloadMediaMessage,
} from "@whiskeysockets/baileys";
import pino from "pino";
import QRCode from "qrcode";
import * as store from "../store.js";

const makeWASocket = baileys.default ?? baileys;
const logger = pino({ level: process.env.BAILEYS_LOG_LEVEL || "silent" });

export class BaileysProvider {
  constructor(account, events) {
    this.account = account;
    this.events = events; // { onStatus, onQr, onMessage, onStatusUpdate }
    this.sock = null;
    this.stopped = false;
  }

  async start() {
    this.stopped = false;
    const { state, saveCreds } = await useMultiFileAuthState(store.sessionDir(this.account.id));
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));

    this.sock = makeWASocket({
      version,
      auth: state,
      logger,
      printQRInTerminal: false,
      browser: ["WhatsApp Hub", "Chrome", "1.0"],
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });

    this.sock.ev.on("creds.update", saveCreds);

    // إن لم يصل QR أو اتصال خلال 60 ثانية فغالبًا الشبكة تمنع الوصول لخوادم واتساب
    const watchdog = setTimeout(() => {
      if (this.stopped || this.connected || this.gotQr) return;
      this.events.onStatus("error", { error: "تعذر الوصول لخوادم واتساب (تحقق من الشبكة/الجدار الناري)" });
      this.sock?.end(undefined);
    }, 60_000);

    this.sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        this.gotQr = true;
        const dataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 280 });
        this.events.onQr(dataUrl);
        this.events.onStatus("qr");
      }
      if (connection === "open") {
        this.connected = true;
        clearTimeout(watchdog);
        const jid = jidNormalizedUser(this.sock.user?.id || "");
        const phone = jid.split("@")[0];
        store.saveAccount({ id: this.account.id, phone, pushName: this.sock.user?.name || "" });
        this.events.onStatus("connected", { phone });
      }
      if (connection === "close") {
        this.connected = false;
        clearTimeout(watchdog);
        const code = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;
        if (loggedOut) {
          this.events.onStatus("logged_out");
          return;
        }
        this.events.onStatus("reconnecting");
        if (!this.stopped) setTimeout(() => this.start().catch(() => {}), 3000);
      }
    });

    this.sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify" && type !== "append") return;
      for (const m of messages) {
        const parsed = this.parseMessage(m);
        if (!parsed) continue;
        if (parsed.mediaType) await this.attachMedia(m, parsed).catch(() => {});
        this.events.onMessage(parsed);
      }
    });

    this.sock.ev.on("messages.update", (updates) => {
      for (const u of updates) {
        if (u.update?.status === undefined) continue;
        const status = ["error", "pending", "sent", "delivered", "read", "played"][u.update.status] || "sent";
        this.events.onStatusUpdate({ chatId: u.key.remoteJid, messageId: u.key.id, status });
      }
    });

    this.sock.ev.on("chats.upsert", (chats) => {
      for (const c of chats) {
        store.upsertChat(this.account.id, { id: c.id, name: c.name || undefined });
      }
    });

    this.sock.ev.on("contacts.upsert", (contacts) => {
      for (const c of contacts) {
        if (c.name || c.notify) store.upsertChat(this.account.id, { id: c.id, name: c.name || c.notify });
      }
    });
  }

  parseMessage(m) {
    const jid = m.key?.remoteJid;
    if (!jid || jid === "status@broadcast") return null;
    const content = m.message || {};
    const text =
      content.conversation ||
      content.extendedTextMessage?.text ||
      content.imageMessage?.caption ||
      content.videoMessage?.caption ||
      content.documentMessage?.fileName ||
      (content.imageMessage && "📷 صورة") ||
      (content.videoMessage && "🎬 فيديو") ||
      (content.audioMessage && "🎤 رسالة صوتية") ||
      (content.stickerMessage && "🩵 ملصق") ||
      (content.locationMessage && "📍 موقع") ||
      (content.contactMessage && "👤 جهة اتصال") ||
      "";
    if (!text && !Object.keys(content).length) return null;
    const mediaType = content.imageMessage ? "image" : content.videoMessage ? "video" : content.audioMessage ? "audio" : content.documentMessage ? "document" : content.stickerMessage ? "sticker" : null;
    return {
      mediaType,
      id: m.key.id,
      chatId: jid,
      chatName: m.pushName || undefined,
      fromMe: !!m.key.fromMe,
      text: text || "[رسالة غير مدعومة]",
      timestamp: Number(m.messageTimestamp) * 1000 || Date.now(),
      status: m.key.fromMe ? "sent" : "received",
      isGroup: jid.endsWith("@g.us"),
      sender: m.key.participant || jid,
    };
  }

  async attachMedia(m, parsed) {
    const buffer = await downloadMediaMessage(m, "buffer", {}, { logger, reuploadRequest: this.sock.updateMediaMessage });
    const content = m.message || {};
    const inner = content.imageMessage || content.videoMessage || content.audioMessage || content.documentMessage || content.stickerMessage || {};
    parsed.media = store.saveMedia(this.account.id, parsed.id, buffer, inner.mimetype || "", inner.fileName);
  }

  jidOf(chatId) {
    return chatId.includes("@") ? chatId : `${chatId.replace(/\D/g, "")}@s.whatsapp.net`;
  }

  async sendMedia(chatId, { buffer, mimetype, fileName, caption }) {
    if (!this.sock) throw new Error("الحساب غير متصل");
    const jid = this.jidOf(chatId);
    let payload, mediaType;
    if (mimetype.startsWith("image/")) { payload = { image: buffer, caption }; mediaType = "image"; }
    else if (mimetype.startsWith("video/")) { payload = { video: buffer, caption }; mediaType = "video"; }
    else if (mimetype.startsWith("audio/")) { payload = { audio: buffer, mimetype }; mediaType = "audio"; }
    else { payload = { document: buffer, mimetype, fileName, caption }; mediaType = "document"; }
    const sent = await this.sock.sendMessage(jid, payload);
    const media = store.saveMedia(this.account.id, sent.key.id, buffer, mimetype, fileName);
    return {
      id: sent.key.id, chatId: jid, fromMe: true, text: caption || fileName || "", mediaType, media,
      timestamp: Date.now(), status: "sent", isGroup: jid.endsWith("@g.us"), sender: "me",
    };
  }

  async sendText(chatId, text) {
    if (!this.sock) throw new Error("الحساب غير متصل");
    const jid = this.jidOf(chatId);
    const sent = await this.sock.sendMessage(jid, { text });
    return {
      id: sent.key.id,
      chatId: jid,
      fromMe: true,
      text,
      timestamp: Date.now(),
      status: "sent",
      isGroup: jid.endsWith("@g.us"),
      sender: "me",
    };
  }

  async logout() {
    this.stopped = true;
    try {
      await this.sock?.logout();
    } catch {}
  }

  async stop() {
    this.stopped = true;
    try {
      this.sock?.end(undefined);
    } catch {}
    this.sock = null;
  }
}
