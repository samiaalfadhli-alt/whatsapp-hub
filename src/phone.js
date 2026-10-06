// توحيد أرقام الجوال إلى صيغة دولية بدون "+" (مثل 9665xxxxxxxx) للمقارنة ومنع التكرار
import { getSetting } from "./db.js";

const ARABIC_DIGITS = { "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4", "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9" };

export function defaultCountryCode() {
  return String(getSetting("default_country_code", process.env.DEFAULT_COUNTRY_CODE || "966")).replace(/\D/g, "") || "966";
}

// يعيد { ok, phone, display, reason }
export function normalizePhone(input, countryCode = defaultCountryCode()) {
  if (input == null) return { ok: false, reason: "empty" };
  let s = String(input).trim().replace(/[٠-٩]/g, (d) => ARABIC_DIGITS[d]);
  if (s.includes("@")) s = s.split("@")[0]; // معرّف واتساب
  const hadPlus = s.startsWith("+");
  s = s.replace(/\D/g, "");
  if (!s) return { ok: false, reason: "empty" };
  if (s.startsWith("00")) s = s.slice(2);
  else if (!hadPlus) {
    if (s.startsWith("0")) s = countryCode + s.slice(1); // 05xxxxxxxx ← 9665xxxxxxxx
    else if (countryCode === "966" && s.length === 9 && s.startsWith("5")) s = countryCode + s; // 5xxxxxxxx
    else if (s.length <= 10 && !s.startsWith(countryCode)) s = countryCode + s;
  }
  if (s.length < 8 || s.length > 15) return { ok: false, reason: "length", phone: s };
  if (s.startsWith("966") && !/^9665\d{8}$/.test(s)) return { ok: false, reason: "invalid_sa", phone: s };
  return { ok: true, phone: s, display: `+${s}` };
}

export const phoneToJid = (phone) => `${phone}@s.whatsapp.net`;
export const jidToPhone = (jid) => (jid || "").split("@")[0].split(":")[0];

// إخفاء جزء من الرقم لمن لا يملك صلاحية view_phone_numbers: 9665****123
export function maskPhone(phone) {
  if (!phone) return "";
  const s = String(phone);
  if (s.length <= 6) return s[0] + "*".repeat(s.length - 1);
  return s.slice(0, 4) + "*".repeat(Math.max(s.length - 7, 2)) + s.slice(-3);
}
