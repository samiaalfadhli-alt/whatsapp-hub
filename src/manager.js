// مدير الحسابات: يشغّل مزوّدًا لكل رقم ويوحّد الأحداث في مكان واحد
import crypto from "node:crypto";
import * as store from "./store.js";
import { BaileysProvider } from "./providers/baileys.js";
import { CloudApiProvider } from "./providers/cloud.js";

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

  setStatus(accountId, status, extra = {}) {
    const rt = this.runtime.get(accountId) || {};
    const next = { ...rt, status, error: extra.error || null };
    if (status !== "qr") next.qr = null;
    this.runtime.set(accountId, next);
    if (extra.phone || extra.pushName) {
      store.saveAccount({ id: accountId, ...(extra.phone && { phone: extra.phone }), ...(extra.pushName && { pushName: extra.pushName }) });
    }
    const account = store.getAccount(accountId);
    if (account) this.io.emit("account:update", this.publicAccount(account));
  }

  events(accountId) {
    return {
      onStatus: (status, extra) => this.setStatus(accountId, status, extra),
      onQr: (qr) => {
        const rt = this.runtime.get(accountId) || {};
        this.runtime.set(accountId, { ...rt, qr, status: "qr" });
        const account = store.getAccount(accountId);
        if (account) this.io.emit("account:update", this.publicAccount(account));
      },
      onMessage: (message) => {
        const saved = store.addMessage(accountId, message);
        this.io.emit("message:new", { accountId, message: saved });
        this.io.emit("chat:update", { accountId, chat: store.listChats(accountId).find((c) => c.id === message.chatId) });
      },
      onStatusUpdate: ({ chatId, messageId, status }) => {
        store.updateMessageStatus(accountId, chatId, messageId, status);
        this.io.emit("message:status", { accountId, chatId, messageId, status });
      },
    };
  }

  async addAccount({ label, type = "qr", phoneNumberId, accessToken }) {
    const id = crypto.randomUUID();
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
    this.io.emit("account:removed", { accountId });
  }

  async sendText(accountId, chatId, text) {
    const provider = this.providers.get(accountId);
    if (!provider) throw new Error("الحساب غير متصل");
    const message = await provider.sendText(chatId, text);
    const saved = store.addMessage(accountId, message);
    this.io.emit("message:new", { accountId, message: saved });
    this.io.emit("chat:update", { accountId, chat: store.listChats(accountId).find((c) => c.id === message.chatId) });
    return saved;
  }

  cloudProviderByPhoneNumberId(phoneNumberId) {
    for (const [id, provider] of this.providers) {
      if (provider instanceof CloudApiProvider && provider.account.phoneNumberId === phoneNumberId) return { id, provider };
    }
    return null;
  }
}
