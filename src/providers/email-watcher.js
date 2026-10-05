// مراقب صندوق البريد (IMAP): يلتقط الرسائل الواردة الجديدة ويمررها لكاشف الاستفسارات
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { processIncoming } from "../alerts.js";

export function imapConfigured() {
  return !!(process.env.IMAP_HOST && process.env.IMAP_USER && process.env.IMAP_PASS);
}

export class EmailWatcher {
  constructor(io, onStatus) {
    this.io = io;
    this.onStatus = onStatus || (() => {});
    this.client = null;
    this.stopped = false;
    this.lastUid = 0;
    this.status = "disconnected";
  }

  setStatus(status, error = null) {
    this.status = status;
    this.error = error;
    this.onStatus({ status, error });
  }

  async start() {
    if (!imapConfigured()) { this.setStatus("not_configured"); return; }
    this.stopped = false;
    this.setStatus("connecting");
    this.client = new ImapFlow({
      host: process.env.IMAP_HOST,
      port: Number(process.env.IMAP_PORT || 993),
      secure: String(process.env.IMAP_SECURE ?? "true") !== "false",
      auth: { user: process.env.IMAP_USER, pass: process.env.IMAP_PASS },
      logger: false,
    });
    this.client.on("error", (e) => this.setStatus("error", e.message));
    this.client.on("close", () => { if (!this.stopped) this.reconnect(); });

    try {
      await this.client.connect();
      const mailbox = await this.client.mailboxOpen(process.env.IMAP_MAILBOX || "INBOX");
      this.lastUid = mailbox.uidNext - 1; // نبدأ من الرسائل الجديدة فقط
      this.setStatus("connected");
      this.client.on("exists", () => this.fetchNew().catch(() => {}));
      this.idleLoop();
    } catch (e) {
      this.setStatus("error", e.message);
      this.reconnect();
    }
  }

  async idleLoop() {
    while (!this.stopped && this.client?.usable) {
      try { await this.client.idle(); } catch { break; }
    }
  }

  reconnect() {
    if (this.stopped) return;
    this.setStatus("reconnecting");
    setTimeout(() => this.start().catch(() => {}), 15_000);
  }

  async fetchNew() {
    const range = `${this.lastUid + 1}:*`;
    for await (const msg of this.client.fetch(range, { uid: true, source: true }, { uid: true })) {
      if (msg.uid <= this.lastUid) continue;
      this.lastUid = msg.uid;
      const parsed = await simpleParser(msg.source).catch(() => null);
      if (!parsed) continue;
      const from = parsed.from?.value?.[0] || {};
      await processIncoming({
        channel: "email",
        from: from.address || "",
        fromName: from.name || "",
        subject: parsed.subject || "",
        text: (parsed.text || parsed.html?.replace(/<[^>]+>/g, " ") || "").trim().slice(0, 4000),
        mailbox: process.env.IMAP_USER,
      }, this.io);
    }
  }

  async stop() {
    this.stopped = true;
    try { await this.client?.logout(); } catch {}
    this.client = null;
    this.setStatus("disconnected");
  }
}
