// مدير الحسابات: يشغّل مزوّدًا لكل رقم ويوحّد الأحداث في مكان واحد
import crypto from "node:crypto";
import * as store from "./store.js";
import { BaileysProvider } from "./providers/baileys.js";
import { CloudApiProvider } from "./providers/cloud.js";
import { processIncoming } from "./alerts.js";
import * as users from "./users.js";
import { maskPhone, jidToPhone } from "./phone.js";

export class AccountManager {
  constructor(io) {
    this.io = io;
    this.providers = new Map(); // accountId -> provider
    this.runtime = new Map(); // accountId -> { status, qr, error }
  }

  async init() {
    for (const account of store.listAccounts()) {
      await this.connect(account.id).catch((e) => this.setStatus(account.id, "error", { error: e.message }));
    }
  }

  publicAccount(account) {
    const rt = this.runtime.get(account.id) || {};
    const { accessToken, ...safe } = account;
    return { ...safe, status: rt.status || "disconnected", qr: rt.qr || null, error: rt.error || null };
  }

  listAccounts() {
    return store.listAccounts().map((a) => this.publicAccount(a));
  }

  // بث بدون كشف الأرقام لمن لا يملك الصلاحية: غرفتان لكل رقم (full / masked)
  emitMessage(accountId, saved) {
    const { chatId, key, ...rest } = saved;
    const base = { ...rest, chatRef: store.getChat(accountId, chatId)?.ref };
    this.io.to(`account:${accountId}:full`).emit("message:new", { accountId, message: base });
    this.io.to(`account:${accountId}:masked`).emit("message:new", { accountId, message: { ...base, sender: saved.isGroup ? maskPhone(jidToPhone(saved.sender)) : "" } });
  }
  emitChat(accountId, chatId) {
    const c = store.getChat(accountId, chatId); if (!c) return;
    const { id, ...rest } = c; const phone = c.isGroup ? "" : jidToPhone(id);
    this.io.to(`account:${accountId}:full`).emit("chat:update", { accountId, chat: { ...rest, phone } });
    this.io.to(`account:${accountId}:masked`).emit("chat:update", { accountId, chat: { ...rest, phone: maskPhone(phone) } });
  }

  setStatus(accountId, status, extra = {}) {
    const rt = this.runtime.get(accountId) || {};
    const next = { ...rt, status, error: extra.error || null };
    if (status !== "qr") next.qr = null;
    this.runtime.set(accountId, next);
    if (extra.phone || extra.pushName) {
      store.saveAccount({ id: accountId, ...(extra.phone && { phone: extra.phone }), ...(extra.pushName && { pushName: extra.pushName }) });
    }
    const account = store.getAccount(accountId);
    if (account) this.io.to(`account:${account.id}`).emit("account:update", this.publicAccount(account));
  }

  events(accountId) {
    return {
      onStatus: (status, extra) => this.setStatus(accountId, status, extra),
      onQr: (qr) => {
        const rt = this.runtime.get(accountId) || {};
        this.runtime.set(accountId, { ...rt, qr, status: "qr" });
        const account = store.getAccount(accountId);
        if (account) this.io.to(`account:${account.id}`).emit("account:update", this.publicAccount(account));
      },
      onMessage: (message) => {
        const saved = store.addMessage(accountId, message);
        this.emitMessage(accountId, saved);
        this.emitChat(accountId, message.chatId);
        if (!message.fromMe) {
          this.runAutoReplies(accountId, saved).catch(() => {});
          if (!message.isGroup) {
            const account = store.getAccount(accountId);
            processIncoming({
              channel: "whatsapp", from: message.chatId.split("@")[0], fromName: message.chatName || "",
              text: message.text, chatId: message.chatId, accountId, accountLabel: account?.label, accountPhone: account?.phone,
            }, this.io).catch(() => {});
          }
        }
      },
      onHistory: ({ added, progress, isLatest }) => {
        this.io.to(`account:${accountId}`).emit("history:synced", { accountId, added, progress, isLatest });
      },
      onStatusUpdate: ({ chatId, messageId, status, reason }) => {
        const st = status === "error" ? "failed" : status;
        if (!store.updateMessageStatus(accountId, chatId, messageId, st, reason || null)) return;
        this.io.to(`account:${accountId}`).emit("message:status", { accountId, messageId, status: st, reason: reason || null });
        this.campaigns?.onMessageStatus(accountId, messageId, st, reason);
      },
      onMediaState: ({ messageId, state }) => {
        store.updateMediaState(accountId, messageId, state);
        this.io.to(`account:${accountId}`).emit("message:media", { accountId, messageId, state });
      },
    };
  }

  async addAccount({ label, type = "qr", phoneNumberId, accessToken }) {
    const id = crypto.randomUUID();
    // المديرون ينضمون لغرفة الرقم الجديد فورًا
    for (const [, socket] of this.io.sockets.sockets) {
      const u = socket.data.user;
      if (users.can(u, "view_all_conversations")) { socket.join(`account:${id}`); socket.join(`account:${id}:${users.can(u, "view_phone_numbers") ? "full" : "masked"}`); }
    }
    const account = store.saveAccount({
      id,
      label: label || "رقم جديد",
      type,
      phone: "",
      pushName: "",
      createdAt: Date.now(),
      ...(type === "cloud" && { phoneNumberId, accessToken }),
    });
    await this.connect(id);
    return this.publicAccount(account);
  }

  async connect(accountId) {
    const account = store.getAccount(accountId);
    if (!account) throw new Error("الحساب غير موجود");
    await this.disconnect(accountId);
    const provider =
      account.type === "cloud"
        ? new CloudApiProvider(account, this.events(accountId))
        : new BaileysProvider(account, this.events(accountId));
    this.providers.set(accountId, provider);
    this.setStatus(accountId, "connecting");
    await provider.start();
    return this.publicAccount(store.getAccount(accountId));
  }

  async disconnect(accountId) {
    const provider = this.providers.get(accountId);
    if (provider) {
      await provider.stop();
      this.providers.delete(accountId);
    }
    if (store.getAccount(accountId)) this.setStatus(accountId, "disconnected");
  }

  async logout(accountId) {
    const provider = this.providers.get(accountId);
    if (provider) await provider.logout();
    await this.disconnect(accountId);
  }

  async removeAccount(accountId) {
    await this.logout(accountId);
    store.deleteAccount(accountId);
    this.runtime.delete(accountId);
    this.io.to(`account:${accountId}`).emit("account:removed", { accountId });
  }

  requireProvider(accountId) {
    const provider = this.providers.get(accountId);
    const rt = this.runtime.get(accountId);
    if (!provider || rt?.status !== "connected") throw new Error("رقم واتساب غير متصل حاليًا. تحقق من حالة الاتصال في إعدادات WhatsApp");
    return provider;
  }

  async sendText(accountId, chatId, text, opts = {}) {
    const provider = this.requireProvider(accountId);
    const message = await provider.sendText(chatId, text);
    const saved = store.addMessage(accountId, { ...message, campaignId: opts.campaignId || null, sentBy: opts.userId || null });
    this.emitMessage(accountId, saved);
    this.emitChat(accountId, message.chatId);
    return saved;
  }

  async sendMedia(accountId, chatId, file, opts = {}) {
    const provider = this.requireProvider(accountId);
    const message = await provider.sendMedia(chatId, file);
    const saved = store.addMessage(accountId, { ...message, campaignId: opts.campaignId || null, sentBy: opts.userId || null });
    this.emitMessage(accountId, saved);
    this.emitChat(accountId, message.chatId);
    return saved;
  }

  // الردود التلقائية: قواعد كلمات مفتاحية + رسالة ترحيب/غياب
  async runAutoReplies(accountId, message) {
    if (message.isGroup) return;
    const rules = store.listRules().filter((r) => r.enabled !== false && (!r.accountId || r.accountId === accountId));
    if (!rules.length) return;
    const text = (message.text || "").toLowerCase();
    const history = store.listMessages(accountId, message.chatId, { limit: 50 });
    const lastFromMe = [...history].reverse().find((m) => m.fromMe);
    const hoursSinceReply = lastFromMe ? (Date.now() - lastFromMe.timestamp) / 36e5 : Infinity;
    for (const rule of rules) {
      let hit = false;
      if (rule.trigger === "keyword") {
        const kws = (rule.keywords || "").split(",").map((k) => k.trim().toLowerCase()).filter(Boolean);
        hit = kws.some((k) => (rule.match === "exact" ? text === k : text.includes(k)));
      } else if (rule.trigger === "welcome") {
        hit = hoursSinceReply >= (Number(rule.cooldownHours) || 24);
      } else if (rule.trigger === "away") {
        const h = new Date().getHours();
        const from = Number(rule.fromHour ?? 18), to = Number(rule.toHour ?? 8);
        const outside = from < to ? h >= from && h < to : h >= from || h < to;
        hit = outside && hoursSinceReply >= (Number(rule.cooldownHours) || 12);
      }
      if (!hit) continue;
      const name = message.chatName || message.chatId.split("@")[0];
      const reply = (rule.reply || "").replaceAll("{name}", name);
      if (reply.trim()) await this.sendText(accountId, message.chatId, reply);
      if (rule.stop !== false) break;
    }
  }

  async fetchOlder(accountId, chatId) {
    const provider = this.providers.get(accountId);
    if (!provider) throw new Error("الحساب غير متصل");
    if (!provider.fetchOlder) throw new Error("هذا النوع من الحسابات لا يدعم سحب السجل");
    return provider.fetchOlder(chatId);
  }

  cloudProviderByPhoneNumberId(phoneNumberId) {
    for (const [id, provider] of this.providers) {
      if (provider instanceof CloudApiProvider && provider.account.phoneNumberId === phoneNumberId) return { id, provider };
    }
    return null;
  }
}
