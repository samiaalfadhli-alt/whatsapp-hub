// تنبيهات الاستفسارات: يكتشف رسائل الاستفسار عن الدورات/الشهادات ويرسل تنبيهًا بالإيميل
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import nodemailer from "nodemailer";

const DATA_DIR = process.env.DATA_DIR || path.resolve("data");
const SETTINGS_FILE = path.join(DATA_DIR, "alerts.json");
const LEADS_FILE = path.join(DATA_DIR, "leads.json");
const MAX_LEADS = 2000;

const DEFAULT_KEYWORDS = "دورة, دورات, الدورة, الدورات, شهادة, شهادات, الشهادة, الشهادات, تدريب, تسجيل, course, courses, certificate, certification, training";

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2));
  fs.renameSync(`${file}.tmp`, file);
}

// ---------- الإعدادات ----------
export function getSettings() {
  return {
    enabled: true,
    notifyEmail: process.env.ALERT_EMAIL || "",
    keywords: DEFAULT_KEYWORDS,
    whatsapp: true,
    email: true,
    cooldownMinutes: 60, // لا يُرسل تنبيهًا لنفس الشخص أكثر من مرة خلال هذه المدة
    ...readJson(SETTINGS_FILE, {}),
  };
}
export function saveSettings(patch) {
  const next = { ...getSettings(), ...patch };
  writeJson(SETTINGS_FILE, next);
  return next;
}

// ---------- سجل الاستفسارات ----------
export function listLeads() { return readJson(LEADS_FILE, []); }
export function markLead(id, patch) {
  const leads = listLeads();
  const l = leads.find((x) => x.id === id);
  if (!l) return null;
  Object.assign(l, patch);
  writeJson(LEADS_FILE, leads);
  return l;
}
function addLead(lead) {
  const leads = listLeads();
  leads.unshift(lead);
  if (leads.length > MAX_LEADS) leads.length = MAX_LEADS;
  writeJson(LEADS_FILE, leads);
  return lead;
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
  io?.emit("lead:new", lead);

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
