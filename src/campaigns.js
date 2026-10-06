// الرسائل الجماعية: جمهور → أهلية → معاينة → إرسال مُنظَّم (بتأخير بين الرسائل) → تقارير → إعادة محاولة آمنة
import crypto from "node:crypto";
import { db, J, P, now, paginate } from "./db.js";
import { normalizePhone, phoneToJid } from "./phone.js";
import * as audit from "./audit.js";
import { getSetting } from "./db.js";

const MIN_DELAY = 2500; // أقل تأخير بين رسالتين (حماية من الحظر على الربط غير الرسمي)

export const campRow = (r) => r && ({
  id: r.id, name: r.name, accountId: r.account_id, status: r.status, messageText: r.message_text, templateId: r.template_id, media: P(r.media_json),
  audience: P(r.audience_json, {}), scheduledAt: r.scheduled_at, startedAt: r.started_at, finishedAt: r.finished_at, createdBy: r.created_by,
  createdAt: r.created_at, updatedAt: r.updated_at, delayMs: r.delay_ms, accountLabel: r.account_label, createdByName: r.created_by_name,
});
const SELECT = "SELECT c.*, a.label account_label, u.name created_by_name FROM campaigns c LEFT JOIN accounts a ON a.id = c.account_id LEFT JOIN users u ON u.id = c.created_by";

export function get(id) { return campRow(db.prepare(`${SELECT} WHERE c.id = ?`).get(id)) || null; }
export function list({ page, limit, status } = {}) {
  const { limit: l, offset, page: p } = paginate({ page, limit, max: 100 });
  const w = status ? "WHERE c.status = ?" : ""; const args = status ? [status] : [];
  const total = db.prepare(`SELECT COUNT(*) c FROM campaigns c ${w}`).get(...args).c;
  const rows = db.prepare(`${SELECT} ${w} ORDER BY c.created_at DESC LIMIT ? OFFSET ?`).all(...args, l, offset).map((r) => ({ ...campRow(r), stats: stats(r.id) }));
  return { rows, total, page: p, limit: l };
}
export function stats(id) {
  const rows = db.prepare("SELECT status, COUNT(*) c FROM campaign_recipients WHERE campaign_id = ? GROUP BY status").all(id);
  const s = { total: 0, pending: 0, queued: 0, sent: 0, delivered: 0, read: 0, failed: 0, skipped: 0 };
  for (const r of rows) { s[r.status] = r.c; s.total += r.c; }
  return s;
}
export function recipients(id, { page, limit, status } = {}) {
  const { limit: l, offset, page: p } = paginate({ page, limit, max: 200 });
  const w = status ? "AND status = ?" : ""; const args = status ? [status] : [];
  const total = db.prepare(`SELECT COUNT(*) c FROM campaign_recipients WHERE campaign_id = ? ${w}`).get(id, ...args).c;
  const rows = db.prepare(`SELECT * FROM campaign_recipients WHERE campaign_id = ? ${w} ORDER BY updated_at DESC LIMIT ? OFFSET ?`).all(id, ...args, l, offset);
  return { rows, total, page: p, limit: l };
}

// ---------- المتغيرات والمعاينة ----------
export function render(text, contact) {
  const vars = { name: contact?.name || "", company: contact?.company || "", phone: contact?.phone || "", first_name: (contact?.name || "").split(" ")[0] || "" };
  return (text || "").replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => vars[k] ?? "");
}

// ---------- تحليل الجمهور (بدون كتابة) ----------
// audience: { listIds, tagIds, categories, sources, assignedTo, contactIds, excludeTagIds }
export function resolveAudience(audience = {}) {
  const parts = []; const args = [];
  const add = (sql, a = []) => { parts.push(sql); args.push(...a); };
  if (audience.contactIds?.length) add(`id IN (${audience.contactIds.map(() => "?").join(",")})`, audience.contactIds);
  if (audience.listIds?.length) add(`id IN (SELECT contact_id FROM list_contacts WHERE list_id IN (${audience.listIds.map(() => "?").join(",")}))`, audience.listIds);
  if (audience.tagIds?.length) add(`id IN (SELECT contact_id FROM contact_tags WHERE tag_id IN (${audience.tagIds.map(() => "?").join(",")}))`, audience.tagIds);
  if (audience.categories?.length) add(`category IN (${audience.categories.map(() => "?").join(",")})`, audience.categories);
  if (audience.sources?.length) add(`source IN (${audience.sources.map(() => "?").join(",")})`, audience.sources);
  if (audience.assignedTo?.length) add(`assigned_to IN (${audience.assignedTo.map(() => "?").join(",")})`, audience.assignedTo);
  if (!parts.length) return { contacts: [], eligible: [], excluded: [], summary: { total: 0, eligible: 0, excluded: 0, invalid: 0, duplicates: 0, optOut: 0, blocked: 0 } };
  let sql = `SELECT id, phone, name, company, opt_in, status FROM contacts WHERE (${parts.join(" OR ")})`;
  if (audience.excludeTagIds?.length) { sql += ` AND id NOT IN (SELECT contact_id FROM contact_tags WHERE tag_id IN (${audience.excludeTagIds.map(() => "?").join(",")}))`; args.push(...audience.excludeTagIds); }
  const rows = db.prepare(sql).all(...args);
  const seen = new Set(); const eligible = []; const excluded = [];
  const summary = { total: rows.length, eligible: 0, excluded: 0, invalid: 0, duplicates: 0, optOut: 0, blocked: 0 };
  for (const c of rows) {
    const n = normalizePhone(c.phone);
    let reason = null;
    if (!n.ok) { reason = "invalid"; summary.invalid++; }
    else if (seen.has(n.phone)) { reason = "duplicate"; summary.duplicates++; }
    else if (!c.opt_in) { reason = "opt_out"; summary.optOut++; }
    else if (c.status !== "active") { reason = "blocked"; summary.blocked++; }
    if (n.ok) seen.add(n.phone);
    if (reason) { excluded.push({ ...c, reason }); summary.excluded++; } else { eligible.push({ ...c, phone: n.phone }); summary.eligible++; }
  }
  return { eligible, excluded, summary };
}

// ---------- إنشاء/تعديل (مسودة) ----------
export function save(data, user) {
  if (!data.name?.trim()) throw new Error("اسم الحملة مطلوب");
  if (!data.accountId) throw new Error("اختر رقم الإرسال");
  const id = data.id || crypto.randomUUID();
  const cur = data.id ? get(data.id) : null;
  if (cur && !["draft", "scheduled"].includes(cur.status)) throw new Error("لا يمكن تعديل حملة بدأ إرسالها");
  const delay = Math.max(Number(data.delayMs) || 4000, MIN_DELAY);
  db.prepare(`INSERT INTO campaigns (id, name, account_id, status, message_text, template_id, media_json, audience_json, scheduled_at, created_by, created_at, updated_at, delay_ms)
    VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, account_id = excluded.account_id, message_text = excluded.message_text, template_id = excluded.template_id,
      media_json = excluded.media_json, audience_json = excluded.audience_json, scheduled_at = excluded.scheduled_at, updated_at = excluded.updated_at, delay_ms = excluded.delay_ms`)
    .run(id, data.name.trim(), data.accountId, data.messageText || "", data.templateId || null, data.media ? J(data.media) : null, J(data.audience || {}), data.scheduledAt ? Number(data.scheduledAt) : null, cur?.createdBy || user.id, cur?.createdAt || now(), now(), delay);
  audit.log(user, cur ? "campaign.update" : "campaign.create", "campaign", id, { name: data.name });
  return get(id);
}
export function remove(id, user) {
  const c = get(id);
  if (!c) return;
  if (c.status === "running") throw new Error("أوقف الحملة أولًا");
  db.prepare("DELETE FROM campaigns WHERE id = ?").run(id);
  audit.log(user, "campaign.delete", "campaign", id, { name: c.name });
}

// تثبيت الجمهور كمستلمين (مرة واحدة عند التأكيد)
export function materialize(id) {
  const c = get(id);
  const { eligible, excluded } = resolveAudience(c.audience);
  db.transaction(() => {
    db.prepare("DELETE FROM campaign_recipients WHERE campaign_id = ? AND status IN ('pending','skipped')").run(id);
    const ins = db.prepare("INSERT OR IGNORE INTO campaign_recipients (id, campaign_id, contact_id, phone, name, status, reason, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    for (const e of eligible) ins.run(crypto.randomUUID(), id, e.id, e.phone, e.name || "", "pending", null, now());
    for (const x of excluded) ins.run(crypto.randomUUID(), id, x.id, x.phone || "", x.name || "", "skipped", x.reason, now());
  })();
  return stats(id);
}

// ---------- المُرسِل (يعمل حملة واحدة في كل مرة لكل رقم) ----------
export class CampaignRunner {
  constructor(manager, io) { this.manager = manager; this.io = io; this.timers = new Map(); this.running = new Set(); }

  // عند تشغيل الخادم: استئناف الجارية والمجدولة
  resume() {
    for (const c of db.prepare("SELECT id, status, scheduled_at FROM campaigns WHERE status IN ('running','scheduled')").all()) {
      if (c.status === "running") this.run(c.id).catch(() => {});
      else this.schedule(c.id, c.scheduled_at);
    }
  }
  schedule(id, at) {
    clearTimeout(this.timers.get(id));
    const delay = Math.max((at || 0) - now(), 0);
    db.prepare("UPDATE campaigns SET status = 'scheduled', scheduled_at = ?, updated_at = ? WHERE id = ?").run(at, now(), id);
    this.timers.set(id, setTimeout(() => this.run(id).catch(() => {}), Math.min(delay, 2 ** 31 - 1)));
    this.emit(id);
  }
  async start(id, user, { scheduledAt } = {}) {
    const c = get(id);
    if (!c) throw new Error("الحملة غير موجودة");
    if (!["draft", "scheduled", "paused"].includes(c.status)) throw new Error("الحملة ليست في حالة تسمح بالبدء");
    if (!c.messageText?.trim() && !c.media) throw new Error("نص الرسالة مطلوب");
    if (c.status !== "paused") {
      const st = materialize(id);
      if (!st.pending) throw new Error("لا يوجد مستلمون مؤهلون");
    }
    audit.log(user, scheduledAt ? "campaign.schedule" : "campaign.send", "campaign", id, { name: c.name, scheduledAt: scheduledAt || null });
    if (scheduledAt && scheduledAt > now()) return this.schedule(id, scheduledAt), get(id);
    this.run(id).catch(() => {});
    return get(id);
  }
  pause(id, user) {
    db.prepare("UPDATE campaigns SET status = 'paused', updated_at = ? WHERE id = ? AND status IN ('running','scheduled')").run(now(), id);
    clearTimeout(this.timers.get(id));
    audit.log(user, "campaign.pause", "campaign", id);
    this.emit(id);
    return get(id);
  }
  // إعادة محاولة الفاشلين فقط (الذين لم تُسجَّل لهم رسالة مُرسلة) — لا تكرار
  retryFailed(id, user) {
    const n = db.prepare("UPDATE campaign_recipients SET status = 'pending', reason = NULL, updated_at = ? WHERE campaign_id = ? AND status = 'failed' AND message_id IS NULL").run(now(), id).changes;
    if (!n) throw new Error("لا توجد رسائل فاشلة يمكن إعادتها بأمان");
    audit.log(user, "campaign.retry", "campaign", id, { count: n });
    this.run(id).catch(() => {});
    return n;
  }
  emit(id) { this.io.to("admins").emit("campaign:update", { campaign: get(id), stats: stats(id) }); }

  async run(id) {
    if (this.running.has(id)) return;
    this.running.add(id);
    try {
      const c = get(id);
      if (!c) return;
      db.prepare("UPDATE campaigns SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ?").run(now(), now(), id);
      this.emit(id);
      const next = db.prepare("SELECT * FROM campaign_recipients WHERE campaign_id = ? AND status = 'pending' ORDER BY updated_at LIMIT 1");
      let lastEmit = 0;
      for (;;) {
        const live = db.prepare("SELECT status, delay_ms FROM campaigns WHERE id = ?").get(id);
        if (!live || live.status !== "running") return;
        const r = next.get(id);
        if (!r) break;
        const contact = r.contact_id ? db.prepare("SELECT name, company, phone FROM contacts WHERE id = ?").get(r.contact_id) : { name: r.name, phone: r.phone };
        const text = render(c.messageText, contact);
        db.prepare("UPDATE campaign_recipients SET status = 'queued', updated_at = ? WHERE id = ?").run(now(), r.id);
        try {
          const jid = phoneToJid(r.phone);
          let msg;
          if (c.media?.path) {
            const fs = await import("node:fs");
            msg = await this.manager.sendMedia(c.accountId, jid, { buffer: fs.readFileSync(c.media.path), mimetype: c.media.mimetype, fileName: c.media.fileName, caption: text }, { campaignId: id });
          } else {
            msg = await this.manager.sendText(c.accountId, jid, text, { campaignId: id });
          }
          db.prepare("UPDATE campaign_recipients SET status = 'sent', message_id = ?, sent_at = ?, updated_at = ?, reason = NULL WHERE id = ?").run(msg.id, now(), now(), r.id);
        } catch (e) {
          db.prepare("UPDATE campaign_recipients SET status = 'failed', reason = ?, updated_at = ? WHERE id = ?").run(String(e.message || e).slice(0, 200), now(), r.id);
          // فقدان الاتصال: نوقف مؤقتًا بدل إفشال البقية
          if (/غير متصل|not connected|closed/i.test(e.message || "")) { db.prepare("UPDATE campaigns SET status = 'paused', updated_at = ? WHERE id = ?").run(now(), id); this.emit(id); return; }
        }
        if (now() - lastEmit > 2000) { this.emit(id); lastEmit = now(); }
        // تأخير عشوائي حول القيمة المحددة
        const d = Math.max(live.delay_ms, MIN_DELAY);
        await new Promise((res) => setTimeout(res, d * (0.7 + Math.random() * 0.6)));
      }
      const pendingLeft = db.prepare("SELECT COUNT(*) c FROM campaign_recipients WHERE campaign_id = ? AND status = 'pending'").get(id).c;
      if (!pendingLeft) db.prepare("UPDATE campaigns SET status = 'done', finished_at = ?, updated_at = ? WHERE id = ? AND status = 'running'").run(now(), now(), id);
      this.emit(id);
    } finally { this.running.delete(id); }
  }

  // تحديث حالة مستلم من حالة الرسالة (delivered/read/failed)
  onMessageStatus(accountId, messageId, status, reason) {
    const r = db.prepare("SELECT id, campaign_id, status FROM campaign_recipients WHERE message_id = ?").get(messageId);
    if (!r) return;
    const rank = { sent: 1, delivered: 2, read: 3 };
    if (status === "failed" || status === "error") db.prepare("UPDATE campaign_recipients SET status = 'failed', reason = ?, updated_at = ? WHERE id = ?").run(reason || "فشل التسليم", now(), r.id);
    else if (rank[status] && rank[status] > (rank[r.status] || 0)) db.prepare("UPDATE campaign_recipients SET status = ?, updated_at = ? WHERE id = ?").run(status, now(), r.id);
    else return;
    this.emit(r.campaign_id);
  }
}
