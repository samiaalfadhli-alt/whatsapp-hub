// مزوّد WhatsApp Business Cloud API (أرقام Meta الرسمية)
// الاستقبال يتم عبر Webhook على المسار /webhooks/cloud
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

  // يُستدعى من مسار الـ webhook عند وصول حدث من Meta
  handleWebhook(value) {
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
      this.events.onMessage({
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
