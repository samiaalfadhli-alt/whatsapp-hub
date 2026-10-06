// تنبيهات الاستفسارات: يكتشف رسائل الاستفسار عن الدورات/الشهادات ويرسل تنبيهًا بالإيميل
import crypto from "node:crypto";
import nodemailer from "nodemailer";
import { db, J, P, now, paginate, getSetting, setSetting } from "./db.js";

const DEFAULT_KEYWORDS = "دورة, دورات, الدورة, الدورات, شهادة, شهادات, الشهادة, الشهادات, تدريب, تسجيل, course, courses, certificate, certification, training";

// ---------- الإعدادات ----------
export function getSettings() {
  return {
    enabled: true,
    notifyEmail: process.env.ALERT_EMAIL || "",
    keywords: DEFAULT_KEYWORDS,
    whatsapp: true,
    email: true,
    cooldownMinutes: 60, // لا يُرسل تنبيهًا لنفس الشخص أكثر من مرة خلال هذه المدة
    ...(getSetting("alerts", {}) || {}),
  };
}
export function saveSettings(patch) {
  const next = { ...getSettings(), ...patch };
  setSetting("alerts", next);
  return next;
}

// ---------- سجل الاستفسارات ----------
const leadRow = (r) => r && ({
  id: r.id, timestamp: r.timestamp, channel: r.channel, from: r.from_addr, fromName: r.from_name, subject: r.subject, text: r.text, matched: P(r.matched, []),
  status: r.status, notified: !!r.notified, notifyError: r.notify_error, accountId: r.account_id, accountLabel: r.account_label, accountPhone: r.account_phone,
  chatId: r.chat_id, mailbox: r.mailbox, contactId: r.contact_id,
});
export function listLeads({ status, accountIds, page, limit } = {}) {
  const where = []; const args = [];
  if (status && status !== "all") { where.push("status = ?"); args.push(status); }
  if (accountIds) { where.push(`(channel = 'email' OR account_id IN (${accountIds.map(() => "?").join(",") || "''"}))`); args.push(...accountIds); }
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const { limit: l, offset, page: p } = paginate({ page, limit: limit || 100, max: 500 });
  const total = db.prepare(`SELECT COUNT(*) c FROM leads ${w}`).get(...args).c;
  const rows = db.prepare(`SELECT * FROM leads ${w} ORDER BY timestamp DESC LIMIT ? OFFSET ?`).all(...args, l, offset).map(leadRow);
  return { rows, total, page: p, limit: l };
}
export function getLead(id) { return leadRow(db.prepare("SELECT * FROM leads WHERE id = ?").get(id)) || null; }
export function markLead(id, patch) {
  const sets = []; const args = [];
  if (patch.status !== undefined) { sets.push("status = ?"); args.push(patch.status); }
  if (patch.notified !== undefined) { sets.push("notified = ?"); args.push(patch.notified ? 1 : 0); }
  if (patch.notifyError !== undefined) { sets.push("notify_error = ?"); args.push(patch.notifyError || null); }
  if (sets.length) db.prepare(`UPDATE leads SET ${sets.join(", ")} WHERE id = ?`).run(...args, id);
  return getLead(id);
}
function addLead(lead) {
  const contact = lead.channel === "whatsapp" ? db.prepare("SELECT id FROM contacts WHERE phone = ?").get(lead.from) : null;
  db.prepare(`INSERT INTO leads (id, timestamp, channel, from_addr, from_name, subject, text, matched, status, notified, account_id, account_label, account_phone, chat_id, mailbox, contact_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new', 0, ?, ?, ?, ?, ?, ?)`)
    .run(lead.id, lead.timestamp, lead.channel, lead.from || "", lead.fromName || "", lead.subject || "", (lead.text || "").slice(0, 4000), J(lead.matched), lead.accountId || null, lead.accountLabel || null, lead.accountPhone || null, lead.chatId || null, lead.mailbox || null, contact?.id || null);
  if (Math.random() < 0.01) db.prepare("DELETE FROM leads WHERE id IN (SELECT id FROM leads ORDER BY timestamp DESC LIMIT -1 OFFSET 5000)").run();
  return getLead(lead.id);
}

// ---------- الكشف ----------
export function matchKeywords(text, keywords = getSettings().keywords) {
  const t = (text || "").toLowerCase();
  return keywords.split(",").map((k) => k.trim().toLowerCase()).filter(Boolean).filter((k) => t.includes(k));
}

const lastAlert = new Map(); // contactKey -> timestamp
function inCooldown(key, minutes) {
  const last = lastAlert.get(key) || 0;
  if (Date.now() - last < minutes * 60_000) return true;
  lastAlert.set(key, Date.now());
  return false;
}

// ---------- الإيميل ----------
export function mailerConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}
let transporter = null;
function getTransporter() {
  if (!mailerConfigured()) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 465),
      secure: String(process.env.SMTP_SECURE ?? (process.env.SMTP_PORT === "587" ? "false" : "true")) !== "false",
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }
  return transporter;
}

export async function sendTestEmail(to) {
  const t = getTransporter();
  if (!t) throw new Error("إعدادات SMTP غير مكتملة في ملف .env");
  await t.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to, subject: "✅ اختبار تنبيهات WhatsApp Hub", text: "إعدادات البريد تعمل بنجاح." });
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

async function sendAlertEmail(lead, settings) {
  const t = getTransporter();
  if (!t || !settings.notifyEmail) return false;
  const via = lead.channel === "whatsapp" ? `واتساب (${lead.accountLabel || ""} ${lead.accountPhone ? "+" + lead.accountPhone : ""})` : `الإيميل (${lead.mailbox || ""})`;
  const subject = `📩 استفسار جديد عن ${lead.matched.slice(0, 2).join("/")} — ${lead.fromName || lead.from}`;
  const html = `
    <div dir="rtl" style="font-family:system-ui,sans-serif;line-height:1.8">
      <h2 style="margin:0 0 8px">استفسار جديد</h2>
      <table style="border-collapse:collapse">
        <tr><td style="color:#666;padding:2px 12px 2px 0">القناة</td><td>${esc(via)}</td></tr>
        <tr><td style="color:#666;padding:2px 12px 2px 0">من</td><td>${esc(lead.fromName || "")} &lt;${esc(lead.from)}&gt;</td></tr>
        <tr><td style="color:#666;padding:2px 12px 2px 0">الوقت</td><td>${new Date(lead.timestamp).toLocaleString("ar-SA")}</td></tr>
        <tr><td style="color:#666;padding:2px 12px 2px 0">الكلمات</td><td>${esc(lead.matched.join("، "))}</td></tr>
      </table>
      ${lead.subject ? `<p><b>الموضوع:</b> ${esc(lead.subject)}</p>` : ""}
      <blockquote style="border-right:3px solid #00a884;margin:12px 0;padding:8px 12px;background:#f6f8f7;white-space:pre-wrap">${esc(lead.text)}</blockquote>
      ${lead.channel === "whatsapp" ? `<p><a href="https://wa.me/${esc(lead.from.replace(/\D/g, ""))}">الرد عبر واتساب</a></p>` : `<p><a href="mailto:${esc(lead.from)}">الرد بالإيميل</a></p>`}
    </div>`;
  await t.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to: settings.notifyEmail, subject, html, text: `${via}\nمن: ${lead.fromName || ""} <${lead.from}>\n\n${lead.text}` });
  return true;
}

// ---------- نقطة الدخول: يُستدعى لكل رسالة واردة من أي قناة ----------
// input: { channel: "whatsapp"|"email", from, fromName, text, subject?, accountId?, accountLabel?, accountPhone?, mailbox?, chatId? }
export async function processIncoming(input, io) {
  const settings = getSettings();
  if (!settings.enabled) return null;
  if (input.channel === "whatsapp" && !settings.whatsapp) return null;
  if (input.channel === "email" && !settings.email) return null;
  const matched = matchKeywords(`${input.subject || ""} ${input.text || ""}`, settings.keywords);
  if (!matched.length) return null;

  const lead = addLead({
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    matched,
    status: "new",
    notified: false,
    ...input,
  });
  if (io) (input.channel === "whatsapp" && input.accountId ? io.to(`account:${input.accountId}`).to("admins") : io.to("admins")).emit("lead:new", lead);

  const key = `${input.channel}:${input.from}`;
  if (!inCooldown(key, Number(settings.cooldownMinutes) || 0)) {
    try {
      lead.notified = await sendAlertEmail(lead, settings);
    } catch (e) {
      lead.notifyError = e.message;
    }
    markLead(lead.id, { notified: lead.notified, notifyError: lead.notifyError });
  }
  return lead;
}
