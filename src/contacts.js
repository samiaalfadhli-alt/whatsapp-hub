// العملاء: إنشاء/تعديل/بحث/فلترة/ترقيم/إجراءات جماعية/وسوم/قوائم/ملاحظات/مهام/استيراد/تصدير
import crypto from "node:crypto";
import { db, J, now, paginate } from "./db.js";
import { normalizePhone, maskPhone } from "./phone.js";
import { conversationsForContact } from "./store.js";
import * as audit from "./audit.js";

export const SOURCES = ["whatsapp", "website", "referral", "ads", "import", "manual", "other"];
export const CATEGORIES = ["lead", "interested", "customer", "registered", "not_interested", "other"];
export const CATEGORY_AR = { lead: "عميل محتمل", interested: "مهتم", customer: "عميل", registered: "مسجّل", not_interested: "غير مهتم", other: "أخرى" };

// ---------- الوسوم والقوائم ----------
export function listTags() {
  return db.prepare("SELECT t.*, (SELECT COUNT(*) FROM contact_tags ct WHERE ct.tag_id = t.id) count FROM tags t ORDER BY name").all();
}
export function saveTag({ id, name, color }) {
  if (!name?.trim()) throw new Error("اسم الوسم مطلوب");
  const tid = id || crypto.randomUUID();
  const dup = db.prepare("SELECT id FROM tags WHERE name = ? AND id != ?").get(name.trim(), tid);
  if (dup) throw new Error("الوسم موجود مسبقًا");
  db.prepare("INSERT INTO tags (id, name, color, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, color = excluded.color")
    .run(tid, name.trim(), color || "", now());
  return db.prepare("SELECT * FROM tags WHERE id = ?").get(tid);
}
export function deleteTag(id) { db.prepare("DELETE FROM tags WHERE id = ?").run(id); }
export function ensureTagByName(name) {
  const n = (name || "").trim();
  if (!n) return null;
  const t = db.prepare("SELECT id FROM tags WHERE name = ?").get(n);
  return t ? t.id : saveTag({ name: n }).id;
}
export function listLists() {
  return db.prepare("SELECT l.*, (SELECT COUNT(*) FROM list_contacts lc WHERE lc.list_id = l.id) count FROM lists l ORDER BY name").all();
}
export function saveList({ id, name, description }) {
  if (!name?.trim()) throw new Error("اسم القائمة مطلوب");
  const lid = id || crypto.randomUUID();
  const dup = db.prepare("SELECT id FROM lists WHERE name = ? AND id != ?").get(name.trim(), lid);
  if (dup) throw new Error("القائمة موجودة مسبقًا");
  db.prepare("INSERT INTO lists (id, name, description, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description")
    .run(lid, name.trim(), description || "", now());
  return db.prepare("SELECT * FROM lists WHERE id = ?").get(lid);
}
export function deleteList(id) { db.prepare("DELETE FROM lists WHERE id = ?").run(id); }

// ---------- تسلسل العميل للعرض ----------
const tagsFor = db.prepare("SELECT t.id, t.name, t.color FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id WHERE ct.contact_id = ? ORDER BY t.name");
const listsFor = db.prepare("SELECT l.id, l.name FROM list_contacts lc JOIN lists l ON l.id = lc.list_id WHERE lc.contact_id = ? ORDER BY l.name");
export function serialize(r, { showPhone = true, withLists = false } = {}) {
  if (!r) return null;
  const assignedName = r.assigned_name ?? (r.assigned_to ? db.prepare("SELECT name FROM users WHERE id = ?").get(r.assigned_to)?.name : "");
  return {
    id: r.id, phone: showPhone ? r.phone : maskPhone(r.phone), phoneMasked: !showPhone, name: r.name, email: r.email, company: r.company, source: r.source,
    category: r.category, assignedTo: r.assigned_to, assignedName: assignedName || "", notes: r.notes, status: r.status, optIn: !!r.opt_in,
    createdAt: r.created_at, updatedAt: r.updated_at, lastContactAt: r.last_contact_at, tags: tagsFor.all(r.id), ...(withLists && { lists: listsFor.all(r.id) }),
  };
}
export function getContact(id) { return db.prepare("SELECT * FROM contacts WHERE id = ?").get(id) || null; }
export function findByPhone(phoneInput) {
  const n = normalizePhone(phoneInput);
  if (!n.ok) return null;
  return db.prepare("SELECT * FROM contacts WHERE phone = ?").get(n.phone) || null;
}

// ---------- نطاق الرؤية (يُطبَّق في كل استعلام) ----------
// scope: { all: true } أو { userIds: [...] } (المسندون إلى هؤلاء)
export function scopeWhere(scope, alias = "c") {
  if (scope.all) return { sql: "1=1", args: [] };
  if (!scope.userIds?.length) return { sql: "1=0", args: [] };
  return { sql: `${alias}.assigned_to IN (${scope.userIds.map(() => "?").join(",")})`, args: [...scope.userIds] };
}
export function canSee(scope, contact) {
  if (!contact) return false;
  return scope.all || (scope.userIds || []).includes(contact.assigned_to);
}

// تطبيع عربي خفيف للبحث (أ/إ/آ → ا، ة → ه، ى → ي)
const AR_NORM_SQL = (col) => `REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(${col},'أ','ا'),'إ','ا'),'آ','ا'),'ة','ه'),'ى','ي')`;
export const arNorm = (s) => String(s || "").replace(/[أإآ]/g, "ا").replace(/ة/g, "ه").replace(/ى/g, "ي");

// ---------- الاستعلام الرئيسي ----------
const SORTABLE = { name: "c.name", company: "c.company", created: "c.created_at", last: "c.last_contact_at", category: "c.category", source: "c.source" };
export function query({ scope, q, category, source, tagId, listId, assignedTo, status, optIn, dateFrom, dateTo, sort = "created", dir = "desc", page, limit, showPhone = true }) {
  const sc = scopeWhere(scope);
  const where = [sc.sql]; const args = [...sc.args];
  if (q) {
    const n = normalizePhone(q);
    const qa = `%${arNorm(q)}%`;
    where.push(`(${AR_NORM_SQL("c.name")} LIKE ? OR ${AR_NORM_SQL("c.company")} LIKE ? OR c.email LIKE ? OR c.phone LIKE ? OR EXISTS (SELECT 1 FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id WHERE ct.contact_id = c.id AND ${AR_NORM_SQL("t.name")} LIKE ?))`);
    args.push(qa, qa, `%${q}%`, `%${n.ok ? n.phone : q.replace(/\D/g, "") || q}%`, qa);
  }
  if (category) { where.push("c.category = ?"); args.push(category); }
  if (source) { where.push("c.source = ?"); args.push(source); }
  if (status) { where.push("c.status = ?"); args.push(status); }
  if (optIn !== undefined && optIn !== "") { where.push("c.opt_in = ?"); args.push(optIn ? 1 : 0); }
  if (assignedTo === "none") where.push("c.assigned_to IS NULL");
  else if (assignedTo) { where.push("c.assigned_to = ?"); args.push(assignedTo); }
  if (tagId) { where.push("EXISTS (SELECT 1 FROM contact_tags ct WHERE ct.contact_id = c.id AND ct.tag_id = ?)"); args.push(tagId); }
  if (listId) { where.push("EXISTS (SELECT 1 FROM list_contacts lc WHERE lc.contact_id = c.id AND lc.list_id = ?)"); args.push(listId); }
  if (dateFrom) { where.push("c.created_at >= ?"); args.push(Number(dateFrom)); }
  if (dateTo) { where.push("c.created_at <= ?"); args.push(Number(dateTo)); }
  const w = where.join(" AND ");
  const { limit: l, offset, page: p } = paginate({ page, limit, max: 200 });
  const order = `${SORTABLE[sort] || "c.created_at"} ${dir === "asc" ? "ASC" : "DESC"} NULLS LAST`;
  const total = db.prepare(`SELECT COUNT(*) c FROM contacts c WHERE ${w}`).get(...args).c;
  const rows = db.prepare(`SELECT c.*, u.name assigned_name FROM contacts c LEFT JOIN users u ON u.id = c.assigned_to WHERE ${w} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...args, l, offset);
  return { rows: rows.map((r) => serialize(r, { showPhone })), total, page: p, limit: l };
}
// معرّفات مطابقة للفلتر (للإجراءات الجماعية "تحديد الكل" وجمهور الحملات)
export function idsMatching(filters) {
  const all = []; let page = 1;
  for (;;) {
    const r = query({ ...filters, page, limit: 200, showPhone: false });
    all.push(...r.rows.map((x) => x.id));
    if (all.length >= r.total || !r.rows.length) break;
    page++;
  }
  return all;
}

// ---------- إنشاء وتعديل ----------
function validate(data) {
  const out = {};
  if (data.name !== undefined) out.name = String(data.name || "").trim().slice(0, 120);
  if (data.email !== undefined) {
    const e = String(data.email || "").trim().toLowerCase();
    if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new Error("البريد الإلكتروني غير صحيح");
    out.email = e;
  }
  if (data.company !== undefined) out.company = String(data.company || "").trim().slice(0, 120);
  if (data.source !== undefined) out.source = String(data.source || "").trim().slice(0, 40);
  if (data.category !== undefined) out.category = String(data.category || "").trim().slice(0, 40);
  if (data.notes !== undefined) out.notes = String(data.notes || "").slice(0, 4000);
  if (data.assignedTo !== undefined) out.assigned_to = data.assignedTo || null;
  if (data.status !== undefined) { if (!["active", "blocked", "archived"].includes(data.status)) throw new Error("حالة غير صحيحة"); out.status = data.status; }
  if (data.optIn !== undefined) out.opt_in = data.optIn ? 1 : 0;
  return out;
}
function setTags(contactId, tagIds) {
  db.prepare("DELETE FROM contact_tags WHERE contact_id = ?").run(contactId);
  for (const t of new Set(tagIds || [])) db.prepare("INSERT OR IGNORE INTO contact_tags (contact_id, tag_id) VALUES (?, ?)").run(contactId, t);
}

// يعيد { created: bool, contact } — لا يُنشئ مكررًا؛ يعيد الموجود
export function create(data, user) {
  const n = normalizePhone(data.phone, data.countryCode);
  if (!n.ok) throw new Error(n.reason === "empty" ? "رقم الجوال مطلوب" : "رقم الجوال غير صحيح");
  const existing = db.prepare("SELECT * FROM contacts WHERE phone = ?").get(n.phone);
  if (existing) return { created: false, contact: existing };
  const v = validate(data);
  const id = crypto.randomUUID();
  db.transaction(() => {
    db.prepare(`INSERT INTO contacts (id, phone, name, email, company, source, category, assigned_to, notes, status, opt_in, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`)
      .run(id, n.phone, v.name || "", v.email || "", v.company || "", v.source || "manual", v.category || "", v.assigned_to || null, v.notes || "", v.opt_in ?? 1, user?.id || null, now(), now());
    if (data.tagIds) setTags(id, data.tagIds);
    if (data.tagNames) setTags(id, data.tagNames.map(ensureTagByName).filter(Boolean));
    // اربط أي محادثة موجودة بنفس الرقم
    db.prepare("UPDATE conversations SET contact_id = ? WHERE contact_id IS NULL AND chat_id = ?").run(id, `${n.phone}@s.whatsapp.net`);
  })();
  audit.log(user, "contact.create", "contact", id, { phone: n.phone, name: v.name });
  return { created: true, contact: getContact(id) };
}

export function update(id, data, user) {
  const cur = getContact(id);
  if (!cur) throw new Error("العميل غير موجود");
  const v = validate(data);
  const changed = {};
  for (const [k, val] of Object.entries(v)) if (cur[k] !== val) changed[k] = val;
  db.transaction(() => {
    if (Object.keys(changed).length) {
      const sets = Object.keys(changed).map((k) => `${k} = ?`);
      db.prepare(`UPDATE contacts SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`).run(...Object.values(changed), now(), id);
    }
    if (data.tagIds) setTags(id, data.tagIds);
  })();
  if (changed.assigned_to !== undefined) audit.log(user, "contact.assign", "contact", id, { from: cur.assigned_to, to: changed.assigned_to });
  const { assigned_to, ...rest } = changed;
  if (Object.keys(rest).length || data.tagIds) audit.log(user, "contact.update", "contact", id, { fields: Object.keys(rest), tags: !!data.tagIds });
  return getContact(id);
}

export function remove(id, user) {
  const cur = getContact(id);
  if (!cur) return;
  db.transaction(() => {
    db.prepare("UPDATE conversations SET contact_id = NULL WHERE contact_id = ?").run(id);
    db.prepare("DELETE FROM contacts WHERE id = ?").run(id);
  })();
  audit.log(user, "contact.delete", "contact", id, { phone: cur.phone, name: cur.name });
}

// ---------- إجراءات جماعية ----------
export function bulk(ids, action, payload, user) {
  if (!ids?.length) throw new Error("لم يتم تحديد عملاء");
  const ph = ids.map(() => "?").join(",");
  let n = 0;
  db.transaction(() => {
    if (action === "add_tag") { for (const id of ids) n += db.prepare("INSERT OR IGNORE INTO contact_tags (contact_id, tag_id) VALUES (?, ?)").run(id, payload.tagId).changes; }
    else if (action === "remove_tag") n = db.prepare(`DELETE FROM contact_tags WHERE tag_id = ? AND contact_id IN (${ph})`).run(payload.tagId, ...ids).changes;
    else if (action === "set_category") n = db.prepare(`UPDATE contacts SET category = ?, updated_at = ? WHERE id IN (${ph})`).run(payload.category || "", now(), ...ids).changes;
    else if (action === "assign") n = db.prepare(`UPDATE contacts SET assigned_to = ?, updated_at = ? WHERE id IN (${ph})`).run(payload.userId || null, now(), ...ids).changes;
    else if (action === "add_to_list") { for (const id of ids) n += db.prepare("INSERT OR IGNORE INTO list_contacts (list_id, contact_id) VALUES (?, ?)").run(payload.listId, id).changes; }
    else if (action === "remove_from_list") n = db.prepare(`DELETE FROM list_contacts WHERE list_id = ? AND contact_id IN (${ph})`).run(payload.listId, ...ids).changes;
    else if (action === "set_status") n = db.prepare(`UPDATE contacts SET status = ?, updated_at = ? WHERE id IN (${ph})`).run(payload.status, now(), ...ids).changes;
    else if (action === "set_opt_in") n = db.prepare(`UPDATE contacts SET opt_in = ?, updated_at = ? WHERE id IN (${ph})`).run(payload.optIn ? 1 : 0, now(), ...ids).changes;
    else if (action === "delete") { db.prepare(`UPDATE conversations SET contact_id = NULL WHERE contact_id IN (${ph})`).run(...ids); n = db.prepare(`DELETE FROM contacts WHERE id IN (${ph})`).run(...ids).changes; }
    else throw new Error("إجراء غير معروف");
  })();
  audit.log(user, `contact.bulk.${action}`, "contact", "", { count: ids.length, affected: n, ...payload });
  return n;
}

// ---------- الملاحظات الداخلية ----------
export function listNotes({ contactId, accountId, chatId }) {
  if (contactId) return db.prepare("SELECT * FROM notes WHERE contact_id = ? ORDER BY created_at DESC").all(contactId);
  return db.prepare("SELECT * FROM notes WHERE account_id = ? AND chat_id = ? ORDER BY created_at DESC").all(accountId, chatId);
}
export function addNote({ contactId, accountId, chatId, text }, user) {
  if (!text?.trim()) throw new Error("نص الملاحظة مطلوب");
  const id = crypto.randomUUID();
  db.prepare("INSERT INTO notes (id, contact_id, account_id, chat_id, user_id, user_name, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, contactId || null, accountId || null, chatId || null, user.id, user.name, text.trim().slice(0, 4000), now());
  return db.prepare("SELECT * FROM notes WHERE id = ?").get(id);
}
export function deleteNote(id, user) {
  const n = db.prepare("SELECT * FROM notes WHERE id = ?").get(id);
  if (!n) return false;
  db.prepare("DELETE FROM notes WHERE id = ?").run(id);
  return true;
}

// ---------- المهام والمتابعات ----------
const taskRow = (r) => r && ({ ...r, assignedName: r.assigned_name || "", contactName: r.contact_name || "", contactPhone: r.contact_phone || "" });
const TASK_SELECT = `SELECT t.*, u.name assigned_name, c.name contact_name, c.phone contact_phone FROM tasks t LEFT JOIN users u ON u.id = t.assigned_to LEFT JOIN contacts c ON c.id = t.contact_id`;
export function listTasks({ contactId, assignedTo, status, scopeUserIds, page, limit, dueBefore }) {
  const where = []; const args = [];
  if (contactId) { where.push("t.contact_id = ?"); args.push(contactId); }
  if (assignedTo) { where.push("t.assigned_to = ?"); args.push(assignedTo); }
  if (scopeUserIds) { where.push(`(t.assigned_to IN (${scopeUserIds.map(() => "?").join(",") || "''"}) OR t.created_by = ?)`); args.push(...scopeUserIds, scopeUserIds[0] || ""); }
  if (status) { where.push("t.status = ?"); args.push(status); }
  if (dueBefore) { where.push("t.due_at <= ?"); args.push(Number(dueBefore)); }
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const { limit: l, offset, page: p } = paginate({ page, limit, max: 200 });
  const total = db.prepare(`SELECT COUNT(*) c FROM tasks t ${w}`).get(...args).c;
  const rows = db.prepare(`${TASK_SELECT} ${w} ORDER BY CASE t.status WHEN 'open' THEN 0 ELSE 1 END, t.due_at ASC NULLS LAST, t.created_at DESC LIMIT ? OFFSET ?`).all(...args, l, offset).map(taskRow);
  return { rows, total, page: p, limit: l };
}
export function saveTask(data, user) {
  if (!data.title?.trim()) throw new Error("عنوان المهمة مطلوب");
  const id = data.id || crypto.randomUUID();
  const cur = data.id ? db.prepare("SELECT * FROM tasks WHERE id = ?").get(data.id) : null;
  if (data.id && !cur) throw new Error("المهمة غير موجودة");
  const status = data.status === "done" ? "done" : "open";
  db.prepare(`INSERT INTO tasks (id, contact_id, title, type, due_at, status, assigned_to, created_by, created_at, done_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET contact_id = excluded.contact_id, title = excluded.title, type = excluded.type, due_at = excluded.due_at, status = excluded.status, assigned_to = excluded.assigned_to, done_at = excluded.done_at`)
    .run(id, data.contactId || cur?.contact_id || null, data.title.trim().slice(0, 200), data.type === "followup" ? "followup" : "task", data.dueAt ? Number(data.dueAt) : null, status,
      data.assignedTo ?? cur?.assigned_to ?? user.id, cur?.created_by || user.id, cur?.created_at || now(), status === "done" ? (cur?.done_at || now()) : null);
  audit.log(user, cur ? "task.update" : "task.create", "task", id, { title: data.title, status });
  return taskRow(db.prepare(`${TASK_SELECT} WHERE t.id = ?`).get(id));
}
export function deleteTask(id, user) { db.prepare("DELETE FROM tasks WHERE id = ?").run(id); audit.log(user, "task.delete", "task", id); }

// ---------- ملف العميل الكامل ----------
export function profile(id, { showPhone }) {
  const c = getContact(id);
  if (!c) return null;
  return {
    contact: serialize(c, { showPhone, withLists: true }),
    conversations: conversationsForContact(id),
    notes: listNotes({ contactId: id }),
    tasks: listTasks({ contactId: id, limit: 50 }).rows,
    activity: audit.list({ targetType: "contact", targetId: id, limit: 30 }).rows,
    createdByName: c.created_by ? db.prepare("SELECT name FROM users WHERE id = ?").get(c.created_by)?.name || "" : "",
  };
}

// ---------- الاستيراد ----------
export const IMPORT_FIELDS = ["phone", "name", "email", "company", "source", "category", "tags", "notes"];
// يعيد معاينة بدون كتابة: { total, valid, newCount, duplicates, invalid, errors, rows }
export function previewImport(records, mapping) {
  const seen = new Set();
  const out = { total: records.length, newCount: 0, duplicates: 0, invalid: 0, existing: 0, rows: [] };
  for (const [i, rec] of records.entries()) {
    const get = (f) => (mapping[f] ? String(rec[mapping[f]] ?? "").trim() : "");
    const n = normalizePhone(get("phone"));
    const row = { line: i + 1, phone: n.phone || get("phone"), name: get("name"), company: get("company"), status: "new" };
    if (!n.ok) { row.status = "invalid"; out.invalid++; }
    else if (seen.has(n.phone)) { row.status = "duplicate"; out.duplicates++; }
    else if (db.prepare("SELECT 1 FROM contacts WHERE phone = ?").get(n.phone)) { row.status = "existing"; out.existing++; }
    else out.newCount++;
    if (n.ok) seen.add(n.phone);
    if (out.rows.length < 200) out.rows.push(row);
  }
  return out;
}
export function runImport(records, mapping, { updateExisting = false, defaultSource = "import", tagIds = [], assignedTo = null }, user) {
  const seen = new Set();
  const res = { created: 0, updated: 0, skipped: 0, invalid: 0 };
  db.transaction(() => {
    for (const rec of records) {
      const get = (f) => (mapping[f] ? String(rec[mapping[f]] ?? "").trim() : "");
      const n = normalizePhone(get("phone"));
      if (!n.ok || seen.has(n.phone)) { n.ok ? res.skipped++ : res.invalid++; continue; }
      seen.add(n.phone);
      const data = { name: get("name"), email: get("email"), company: get("company"), source: get("source") || defaultSource, category: get("category"), notes: get("notes") };
      const tagNames = get("tags").split(/[,;|،]/).map((t) => t.trim()).filter(Boolean);
      const existing = db.prepare("SELECT * FROM contacts WHERE phone = ?").get(n.phone);
      if (existing) {
        if (!updateExisting) { res.skipped++; continue; }
        const patch = Object.fromEntries(Object.entries(data).filter(([, v]) => v));
        update(existing.id, patch, null);
        for (const t of [...tagIds, ...tagNames.map(ensureTagByName)]) if (t) db.prepare("INSERT OR IGNORE INTO contact_tags (contact_id, tag_id) VALUES (?, ?)").run(existing.id, t);
        res.updated++;
      } else {
        const id = crypto.randomUUID();
        db.prepare(`INSERT INTO contacts (id, phone, name, email, company, source, category, assigned_to, notes, status, opt_in, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?, ?)`)
          .run(id, n.phone, data.name, data.email.toLowerCase(), data.company, data.source, data.category, assignedTo || null, data.notes, user?.id || null, now(), now());
        for (const t of [...tagIds, ...tagNames.map(ensureTagByName)]) if (t) db.prepare("INSERT OR IGNORE INTO contact_tags (contact_id, tag_id) VALUES (?, ?)").run(id, t);
        db.prepare("UPDATE conversations SET contact_id = ? WHERE contact_id IS NULL AND chat_id = ?").run(id, `${n.phone}@s.whatsapp.net`);
        res.created++;
      }
    }
  })();
  audit.log(user, "contact.import", "contact", "", { ...res, total: records.length });
  return res;
}

// ---------- التصدير ----------
export function exportRows(filters, user) {
  const rows = [];
  let page = 1;
  for (;;) {
    const r = query({ ...filters, page, limit: 200, showPhone: true });
    rows.push(...r.rows);
    if (rows.length >= r.total || !r.rows.length) break;
    page++;
  }
  audit.log(user, "contact.export", "contact", "", { count: rows.length });
  return rows;
}

// ---------- إحصاءات سريعة ----------
export function counts() {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const week = today.getTime() - 6 * 86400_000;
  return {
    total: db.prepare("SELECT COUNT(*) c FROM contacts").get().c,
    today: db.prepare("SELECT COUNT(*) c FROM contacts WHERE created_at >= ?").get(today.getTime()).c,
    week: db.prepare("SELECT COUNT(*) c FROM contacts WHERE created_at >= ?").get(week).c,
  };
}
