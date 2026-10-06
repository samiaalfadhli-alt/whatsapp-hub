// سجل النشاط: من فعل ماذا ومتى، بدون كلمات مرور أو توكنات
import crypto from "node:crypto";
import { db, J, P, now, paginate } from "./db.js";

const SENSITIVE = /password|token|secret|hash|cookie/i;
function clean(meta) {
  if (!meta || typeof meta !== "object") return {};
  const out = {};
  for (const [k, v] of Object.entries(meta)) {
    if (SENSITIVE.test(k)) continue;
    out[k] = typeof v === "string" && v.length > 300 ? v.slice(0, 300) + "…" : v;
  }
  return out;
}

const insert = db.prepare("INSERT INTO audit_logs (id, user_id, user_name, action, target_type, target_id, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");

export function log(user, action, targetType = "", targetId = "", metadata = {}) {
  insert.run(crypto.randomUUID(), user?.id || null, user?.name || "النظام", action, targetType, String(targetId ?? ""), J(clean(metadata)), now());
}

export function list({ page, limit, targetType, targetId, userId, action } = {}) {
  const { limit: l, offset } = paginate({ page, limit, max: 100 });
  const where = []; const args = [];
  if (targetType) { where.push("target_type = ?"); args.push(targetType); }
  if (targetId) { where.push("target_id = ?"); args.push(String(targetId)); }
  if (userId) { where.push("user_id = ?"); args.push(userId); }
  if (action) { where.push("action = ?"); args.push(action); }
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = db.prepare(`SELECT COUNT(*) c FROM audit_logs ${w}`).get(...args).c;
  const rows = db.prepare(`SELECT * FROM audit_logs ${w} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...args, l, offset)
    .map((r) => ({ ...r, metadata: P(r.metadata, {}) }));
  return { rows, total, page: Math.floor(offset / l) + 1, limit: l };
}
