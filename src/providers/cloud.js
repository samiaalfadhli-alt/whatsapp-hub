// مزوّد WhatsApp Business Cloud API (أرقام Meta الرسمية)
// الاستقبال يتم عبر Webhook على المسار /webhooks/cloud
import * as store from "../store.js";

export class CloudApiProvider {
  constructor(account, events) {
    this.account = account; // { id, phoneNumberId, accessToken, phone }
    this.events = events;
    this.apiVersion = process.env.META_API_VERSION || "v21.0";
  }

  async start() {
    const res = await fetch(
      `https://graph.facebook.com/${this.apiVersion}/${this.account.phoneNumberId}?fields=display_phone_number,verified_name`,
      { headers: { Authorization: `Bearer ${this.account.accessToken}` } },
    );
    if (!res.ok) {
      this.events.onStatus("error", { error: `Meta API: ${res.status}` });
      return;
    }
    const info = await res.json();
    this.events.onStatus("connected", {
      phone: (info.display_phone_number || "").replace(/\D/g, ""),
      pushName: info.verified_name || "",
    });
  }

  async sendText(chatId, text) {
    const to = chatId.replace(/@.*$/, "").replace(/\D/g, "");
    const res = await fetch(
      `https://graph.facebook.com/${this.apiVersion}/${this.account.phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.account.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to,
          type: "text",
          text: { body: text },
        }),
      },
    );
    const body = await res.json();
    if (!res.ok) throw new Error(body.error?.message || "فشل الإرسال عبر Cloud API");
    return {
      id: body.messages?.[0]?.id || `cloud-${Date.now()}`,
      chatId: `${to}@s.whatsapp.net`,
      fromMe: true,
      text,
      timestamp: Date.now(),
      status: "sent",
      isGroup: false,
      sender: "me",
    };
  }

  get base() { return `https://graph.facebook.com/${this.apiVersion}`; }
  get authHeader() { return { Authorization: `Bearer ${this.account.accessToken}` }; }

  async sendMedia(chatId, { buffer, mimetype, fileName, caption }) {
    const to = chatId.replace(/@.*$/, "").replace(/\D/g, "");
    // 1) رفع الملف إلى Meta
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("file", new Blob([buffer], { type: mimetype }), fileName || "file");
    const up = await fetch(`${this.base}/${this.account.phoneNumberId}/media`, { method: "POST", headers: this.authHeader, body: form });
    const upBody = await up.json();
    if (!up.ok) throw new Error(upBody.error?.message || "فشل رفع الملف إلى Meta");
    // 2) إرسال الرسالة بمعرّف الوسائط
    const type = mimetype.startsWith("image/") ? "image" : mimetype.startsWith("video/") ? "video" : mimetype.startsWith("audio/") ? "audio" : "document";
    const obj = { id: upBody.id };
    if (type !== "audio" && caption) obj.caption = caption;
    if (type === "document" && fileName) obj.filename = fileName;
    const res = await fetch(`${this.base}/${this.account.phoneNumberId}/messages`, {
      method: "POST",
      headers: { ...this.authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to, type, [type]: obj }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error?.message || "فشل الإرسال عبر Cloud API");
    const id = body.messages?.[0]?.id || `cloud-${Date.now()}`;
    const media = store.saveMedia(this.account.id, id, buffer, mimetype, fileName);
    return { id, chatId: `${to}@s.whatsapp.net`, fromMe: true, text: caption || fileName || "", mediaType: type, media, timestamp: Date.now(), status: "sent", isGroup: false, sender: "me" };
  }

  async downloadMedia(mediaId) {
    const meta = await fetch(`${this.base}/${mediaId}`, { headers: this.authHeader }).then((r) => r.json());
    if (!meta.url) throw new Error("لا يوجد رابط للوسائط");
    const res = await fetch(meta.url, { headers: this.authHeader });
    return { buffer: Buffer.from(await res.arrayBuffer()), mimetype: meta.mime_type || "" };
  }

  // يُستدعى من مسار الـ webhook عند وصول حدث من Meta
  async handleWebhook(value) {
    const contactNames = Object.fromEntries((value.contacts || []).map((c) => [c.wa_id, c.profile?.name]));
    for (const m of value.messages || []) {
      const chatId = `${m.from}@s.whatsapp.net`;
      const text =
        m.text?.body ||
        m.image?.caption ||
        m.video?.caption ||
        m.document?.filename ||
        (m.image && "📷 صورة") ||
        (m.audio && "🎤 رسالة صوتية") ||
        (m.location && "📍 موقع") ||
        m.button?.text ||
        m.interactive?.button_reply?.title ||
        m.interactive?.list_reply?.title ||
        "[رسالة غير مدعومة]";
      const mediaObj = m.image || m.video || m.audio || m.document || m.sticker;
      const mediaType = m.image ? "image" : m.video ? "video" : m.audio ? "audio" : m.document ? "document" : m.sticker ? "sticker" : null;
      let media;
      if (mediaObj?.id) {
        media = await this.downloadMedia(mediaObj.id)
          .then(({ buffer, mimetype }) => store.saveMedia(this.account.id, m.id, buffer, mimetype || mediaObj.mime_type || "", m.document?.filename))
          .catch(() => undefined);
      }
      this.events.onMessage({
        mediaType,
        media,
        id: m.id,
        chatId,
        chatName: contactNames[m.from],
        fromMe: false,
        text,
        timestamp: Number(m.timestamp) * 1000 || Date.now(),
        status: "received",
        isGroup: false,
        sender: chatId,
      });
    }
    for (const s of value.statuses || []) {
      this.events.onStatusUpdate({
        chatId: `${s.recipient_id}@s.whatsapp.net`,
        messageId: s.id,
        status: s.status,
      });
    }
  }

  async logout() {}
  async stop() {}
}
