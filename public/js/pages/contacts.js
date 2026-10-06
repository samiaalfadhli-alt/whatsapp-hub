// العملاء: جدول احترافي + نموذج + ملف العميل + استيراد
import { state, $, $$, api, qs, esc, can, h, toast, toastErr, modal, drawer, confirm, debounce, fmtDate, fmtDateTime, fmtPhone, avatar, pager, skeleton, empty, catLabel, srcLabel, CONV_STATUS } from "../core.js";
import { navigate, loadMeta } from "../app.js";
import { addNoteDialog, addTaskDialog } from "./tasks.js";

const STATUS_AR = { active: ["نشط", "good"], blocked: ["محظور", "bad"], archived: ["مؤرشف", ""] };
const opts = (list, sel, lbl = (x) => x) => list.map((x) => `<option value="${esc(x.id ?? x)}" ${(x.id ?? x) === sel ? "selected" : ""}>${esc(lbl(x))}</option>`).join("");

// ---------- نموذج إضافة/تعديل ----------
export function openContactForm(contact = null, onDone) {
  if (!can(contact?.id ? "edit_contact" : "create_contact")) return toast("لا تملك صلاحية لهذا الإجراء", "err");
  const m = state.meta; const c = contact || {};
  const cc = m.settings.defaultCountryCode;
  const dlg = drawer({ title: c.id ? "تعديل عميل" : "إضافة عميل", body: `<form data-form class="form-grid">
      <label>الاسم<input name="name" value="${esc(c.name || "")}" /></label>
      ${c.id ? `<label>رقم الجوال<input value="${esc(fmtPhone(c.phone))}" disabled /></label>` : `<label>رقم الجوال<div style="display:flex;gap:6px"><input name="countryCode" value="${esc(cc)}" style="width:80px" class="ltr" title="مفتاح الدولة" /><input name="phone" class="ltr" placeholder="05xxxxxxxx" value="${esc(c.phone || "")}" required /></div><div class="field-hint">يُحفظ بصيغة دولية موحدة لمنع التكرار</div></label>`}
      <label>البريد الإلكتروني<input name="email" type="email" value="${esc(c.email || "")}" /></label>
      <label>الشركة<input name="company" value="${esc(c.company || "")}" /></label>
      <label>المصدر<select name="source">${opts(m.sources, c.source || "manual", srcLabel)}</select></label>
      <label>التصنيف<select name="category"><option value="">—</option>${opts(m.categories, c.category, catLabel)}</select></label>
      <label>الموظف المسؤول<select name="assignedTo"><option value="">— بدون —</option>${opts(m.users.filter((u) => u.active), c.assignedTo, (u) => u.name)}</select></label>
      <label>الحالة<select name="status">${opts(Object.keys(STATUS_AR), c.status || "active", (s) => STATUS_AR[s][0])}</select></label>
      <div class="full"><label>الوسوم</label><div class="chips" data-tags style="margin-top:6px">${m.tags.map((t) => `<button type="button" class="chip ${(c.tags || []).some((x) => x.id === t.id) ? "active" : ""}" data-tag="${t.id}">${esc(t.name)}</button>`).join("") || '<span class="muted small">لا توجد وسوم بعد — أضفها من «القوائم والتصنيفات»</span>'}</div></div>
      <label class="full check"><input type="checkbox" name="optIn" ${c.optIn === false ? "" : "checked"} /> موافق على استقبال الرسائل الجماعية</label>
      <label class="full">ملاحظات<textarea name="notes" rows="3">${esc(c.notes || "")}</textarea></label>
      <p class="form-error full" data-error></p>
    </form>`, foot: `<button class="btn primary" data-save>${c.id ? "حفظ التعديلات" : "إضافة العميل"}</button><button class="btn" data-close>إلغاء</button>` });
  $("[data-tags]", dlg.body).addEventListener("click", (e) => { const b = e.target.closest("[data-tag]"); if (b) b.classList.toggle("active"); });
  const save = async () => {
    const f = $("[data-form]", dlg.body); const body = Object.fromEntries(new FormData(f).entries());
    body.optIn = f.optIn.checked; body.tagIds = $$("[data-tag].active", dlg.body).map((b) => b.dataset.tag);
    const err = $("[data-error]", dlg.body); err.textContent = "";
    try {
      if (c.id) { const r = await api(`/contacts/${c.id}`, { method: "PATCH", body }); dlg.close(); toast("تم حفظ التعديلات", "ok"); onDone?.(r); }
      else {
        const r = await api("/contacts", { method: "POST", body });
        dlg.close();
        if (r.created) { toast("تمت إضافة العميل", "ok"); onDone?.(r.contact); openContact(r.contact.id); }
        else { toast("هذا الرقم مسجّل مسبقًا — تم فتح العميل الموجود"); openContact(r.contact.id); }
      }
    } catch (e) { err.textContent = e.message; }
  };
  $("[data-save]", dlg.foot).onclick = save;
  $("[data-form]", dlg.body).addEventListener("submit", (e) => { e.preventDefault(); save(); });
}

// ---------- ملف العميل ----------
export async function openContact(id) {
  const dlg = drawer({ title: "ملف العميل", size: "lg", body: skeleton(8), foot: null });
  const load = async () => {
    try {
      const p = await api(`/contacts/${id}`); const c = p.contact;
      const st = STATUS_AR[c.status] || ["", ""];
      dlg.body.innerHTML = `
        <div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap;margin-bottom:16px">${avatar(c.name || c.phone, "lg")}
          <div style="flex:1;min-width:200px"><div style="font-size:18px;font-weight:700">${esc(c.name || "بدون اسم")}</div><div class="ltr" style="text-align:end;color:var(--text-2)">${esc(fmtPhone(c.phone))}</div>
            <div style="margin-top:4px;display:flex;gap:6px;flex-wrap:wrap"><span class="badge ${st[1]}">${st[0]}</span>${c.category ? `<span class="badge primary">${esc(catLabel(c.category))}</span>` : ""}${c.tags.map((t) => `<span class="tag">${esc(t.name)}</span>`).join("")}</div></div>
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            ${can("send_message") && state.meta.accounts.length ? `<button class="btn primary small" data-chat>💬 محادثة</button>` : ""}
            ${can("edit_contact") ? `<button class="btn small" data-edit>تعديل</button>` : ""}
            ${can("delete_contact") ? `<button class="btn small danger" data-del>حذف</button>` : ""}
          </div></div>
        <div class="grid-2">
          <div class="card"><div class="card-head"><h3>البيانات الأساسية</h3></div><div class="card-body"><dl class="kv">
            <dt>البريد</dt><dd>${esc(c.email || "—")}</dd><dt>الشركة</dt><dd>${esc(c.company || "—")}</dd><dt>المصدر</dt><dd>${esc(srcLabel(c.source))}</dd>
            <dt>المسؤول</dt><dd>${esc(c.assignedName || "—")}</dd><dt>القوائم</dt><dd>${c.lists?.length ? c.lists.map((l) => `<span class="tag">${esc(l.name)}</span>`).join(" ") : "—"}</dd>
            <dt>موافقة الرسائل</dt><dd>${c.optIn ? "نعم" : "لا"}</dd><dt>آخر تواصل</dt><dd>${fmtDateTime(c.lastContactAt)}</dd><dt>أُضيف</dt><dd>${fmtDateTime(c.createdAt)}${p.createdByName ? " · " + esc(p.createdByName) : ""}</dd>
            </dl>${c.notes ? `<p style="white-space:pre-wrap;margin:10px 0 0;color:var(--text-2)">${esc(c.notes)}</p>` : ""}</div></div>
          <div class="card"><div class="card-head"><h3>المحادثات</h3></div><div class="card-body">${p.conversations.length ? p.conversations.map((v) => { const s = CONV_STATUS[v.status] || ["", ""]; return `<div class="task-item"><span>💬</span><div style="flex:1"><a href="#/inbox/${v.ref}" data-nav>${esc(v.accountLabel)}</a> <span class="badge ${s[1]}">${s[0]}</span><div class="muted small truncate">${esc(v.lastMessage || "")}</div></div><span class="muted small">${fmtDate(v.lastTimestamp)}</span></div>`; }).join("") : '<div class="muted small">لا توجد محادثات بعد</div>'}</div></div>
          <div class="card"><div class="card-head"><h3>ملاحظات داخلية</h3>${can("send_message") || can("edit_contact") ? `<button class="btn small" data-note>+ إضافة</button>` : ""}</div><div class="card-body">${p.notes.length ? p.notes.map((n) => `<div class="note-item"><div class="by"><span>${esc(n.user_name)}</span><span>${fmtDateTime(n.created_at)}</span></div>${esc(n.text)}</div>`).join("") : '<div class="muted small">لا توجد ملاحظات</div>'}</div></div>
          <div class="card"><div class="card-head"><h3>المهام والمتابعات</h3>${can("manage_tasks") ? `<button class="btn small" data-task>+ إضافة</button>` : ""}</div><div class="card-body">${p.tasks.length ? p.tasks.map((t) => `<div class="task-item ${t.status}"><span>${t.type === "followup" ? "🔁" : "☑️"}</span><div><div>${esc(t.title)}</div><div class="due ${t.due_at && t.due_at < Date.now() && t.status === "open" ? "late" : ""}">${t.due_at ? fmtDateTime(t.due_at) : "بدون موعد"}${t.assignedName ? " · " + esc(t.assignedName) : ""}</div></div></div>`).join("") : '<div class="muted small">لا توجد مهام</div>'}</div></div>
          <div class="card" style="grid-column:1/-1"><div class="card-head"><h3>سجل النشاط</h3></div><div class="card-body timeline">${p.activity.length ? p.activity.map((a) => `<div class="ev"><time>${fmtDateTime(a.created_at)}</time><span><b>${esc(a.user_name)}</b> · ${esc(ACTION_AR[a.action] || a.action)}${a.metadata?.to !== undefined ? ` (${esc(a.metadata.from ? userName(a.metadata.from) : "—")} ← ${esc(userName(a.metadata.to) || "—")})` : ""}</span></div>`).join("") : '<div class="muted small">لا يوجد نشاط</div>'}</div></div>
        </div>`;
      $("[data-edit]", dlg.body)?.addEventListener("click", () => openContactForm(c, load));
      $("[data-note]", dlg.body)?.addEventListener("click", () => addNoteDialog({ contactId: c.id }, load));
      $("[data-task]", dlg.body)?.addEventListener("click", () => addTaskDialog({ contactId: c.id }, load));
      $("[data-del]", dlg.body)?.addEventListener("click", async () => { if (await confirm({ title: "حذف العميل", text: `سيُحذف "${c.name || c.phone}" نهائيًا مع ملاحظاته ومهامه. المحادثات تبقى.`, danger: true, okText: "حذف" })) { try { await api(`/contacts/${c.id}`, { method: "DELETE" }); dlg.close(); toast("تم الحذف"); document.dispatchEvent(new Event("contacts:changed")); } catch (e) { toastErr(e); } } });
      $("[data-chat]", dlg.body)?.addEventListener("click", () => startChat(c, dlg));
      $$("[data-nav]", dlg.body).forEach((a) => a.addEventListener("click", () => dlg.close()));
    } catch (e) { dlg.body.innerHTML = empty("تعذر فتح العميل", e.message, "⚠️"); }
  };
  await load();
}
const userName = (id) => state.meta.users.find((u) => u.id === id)?.name || "";
const ACTION_AR = { "contact.create": "أضاف العميل", "contact.update": "عدّل البيانات", "contact.assign": "غيّر الموظف المسؤول", "contact.delete": "حذف العميل", "contact.import": "استيراد", "task.create": "أضاف مهمة", "task.update": "عدّل مهمة", "conversation.assign": "أسند المحادثة", "conversation.close": "أغلق المحادثة" };

async function startChat(c, dlg) {
  const accs = state.meta.accounts.filter((a) => a.status === "connected");
  if (!accs.length) return toast("لا يوجد رقم واتساب متصل حاليًا", "err");
  const go = async (accountId) => { try { const v = await api(`/contacts/${c.id}/start-conversation`, { method: "POST", body: { accountId } }); dlg?.close(); navigate(`#/inbox/${v.ref}`); } catch (e) { toastErr(e); } };
  if (accs.length === 1) return go(accs[0].id);
  const m = modal({ title: "اختر رقم الإرسال", body: `<div class="chips">${accs.map((a) => `<button class="chip" data-acc="${a.id}">${esc(a.label)}</button>`).join("")}</div>`, foot: null });
  m.body.addEventListener("click", (e) => { const b = e.target.closest("[data-acc]"); if (b) { m.close(); go(b.dataset.acc); } });
}

// ---------- الاستيراد ----------
export function openImport(onDone) {
  const m = state.meta;
  const dlg = modal({ title: "استيراد عملاء من CSV / Excel", size: "lg", body: `<div data-step1>
      <p class="muted">الصف الأول يجب أن يحتوي أسماء الأعمدة. الحد الأقصى المقترح 20,000 صف لكل ملف.</p>
      <input type="file" data-file accept=".csv,.xlsx,.xls,text/csv" />
    </div><div data-step2 class="hidden"></div>`, foot: `<button class="btn primary hidden" data-run>بدء الاستيراد</button><button class="btn" data-close>إغلاق</button>` });
  let token, columns;
  $("[data-file]", dlg.body).addEventListener("change", async (e) => {
    const file = e.target.files[0]; if (!file) return;
    const fd = new FormData(); fd.append("file", file);
    $("[data-step2]", dlg.body).innerHTML = skeleton(4); $("[data-step2]", dlg.body).classList.remove("hidden");
    try {
      const r = await api("/contacts/import/preview", { method: "POST", form: fd });
      token = r.token; columns = r.columns;
      const fields = [["phone", "رقم الجوال *"], ["name", "الاسم"], ["email", "البريد"], ["company", "الشركة"], ["source", "المصدر"], ["category", "التصنيف"], ["tags", "الوسوم"], ["notes", "ملاحظات"]];
      $("[data-step2]", dlg.body).innerHTML = `<h4 style="margin:12px 0 6px">ربط الأعمدة</h4><div class="form-grid">${fields.map(([f, l]) => `<label>${l}<select data-map="${f}"><option value="">— تجاهل —</option>${columns.map((c) => `<option value="${esc(c)}" ${r.guess[f] === c ? "selected" : ""}>${esc(c)}</option>`).join("")}</select></label>`).join("")}
        <label>وسم لكل المستوردين<select data-tag><option value="">—</option>${m.tags.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join("")}</select></label>
        <label>الموظف المسؤول<select data-assigned><option value="">—</option>${m.users.filter((u) => u.active).map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join("")}</select></label>
        <label class="full check"><input type="checkbox" data-update /> تحديث بيانات العملاء الموجودين مسبقًا بدل تخطيهم</label></div>
        <div data-summary style="margin-top:12px"></div>`;
      const analyze = async () => {
        const mapping = Object.fromEntries($$("[data-map]", dlg.body).map((s) => [s.dataset.map, s.value]).filter(([, v]) => v));
        if (!mapping.phone) { $("[data-summary]", dlg.body).innerHTML = '<p class="form-error">حدد عمود رقم الجوال</p>'; $("[data-run]", dlg.foot).classList.add("hidden"); return; }
        const p = await api("/contacts/import/analyze", { method: "POST", body: { token, mapping } });
        $("[data-summary]", dlg.body).innerHTML = `<div class="audience-summary">${[["إجمالي السجلات", p.total], ["جديدة", p.newCount], ["موجودة مسبقًا", p.existing], ["مكررة داخل الملف", p.duplicates], ["أرقام غير صحيحة", p.invalid]].map(([l, v]) => `<div class="stat"><div class="lbl">${l}</div><div class="val">${v}</div></div>`).join("")}</div>
          ${p.invalid ? `<details style="margin-top:8px"><summary class="small">عرض الأرقام غير الصحيحة</summary><div class="small muted">${p.rows.filter((x) => x.status === "invalid").slice(0, 30).map((x) => `سطر ${x.line}: ${esc(x.phone)} ${esc(x.name)}`).join("<br>")}</div></details>` : ""}`;
        $("[data-run]", dlg.foot).classList.toggle("hidden", !p.newCount && !($("[data-update]", dlg.body).checked && p.existing));
        $("[data-run]", dlg.foot).dataset.mapping = JSON.stringify(mapping);
      };
      $$("[data-map], [data-update]", dlg.body).forEach((s) => s.addEventListener("change", () => analyze().catch(toastErr)));
      await analyze();
    } catch (err) { toastErr(err); $("[data-step2]", dlg.body).innerHTML = ""; }
  });
  $("[data-run]", dlg.foot).addEventListener("click", async (e) => {
    const btn = e.currentTarget; if (!await confirm({ title: "تأكيد الاستيراد", text: "سيتم إنشاء العملاء الجدد الآن. هل تريد المتابعة؟", okText: "استيراد" })) return;
    btn.disabled = true;
    try {
      const r = await api("/contacts/import/run", { method: "POST", body: { token, mapping: JSON.parse(btn.dataset.mapping), updateExisting: $("[data-update]", dlg.body).checked, tagIds: [$("[data-tag]", dlg.body).value].filter(Boolean), assignedTo: $("[data-assigned]", dlg.body).value } });
      dlg.close(); toast(`تم: ${r.created} جديد، ${r.updated} محدّث، ${r.skipped} متخطى، ${r.invalid} غير صحيح`, "ok"); onDone?.();
    } catch (err) { toastErr(err); btn.disabled = false; }
  });
}

// ---------- الصفحة ----------
export async function render(view, [id]) {
  const m = state.meta;
  const S = { q: "", category: "", source: "", tagId: "", listId: "", assignedTo: "", status: "", sort: "created", dir: "desc", page: 1, limit: 25, selected: new Set(), rows: [], total: 0 };
  view.innerHTML = `<div class="page-head"><h1>العملاء <span class="muted small" data-total></span></h1><div class="actions">
      ${can("import_contacts") ? `<button class="btn" data-import>⬆ استيراد</button>` : ""}${can("export_contacts") ? `<button class="btn" data-export>⬇ تصدير CSV</button>` : ""}${can("create_contact") ? `<button class="btn primary" data-new>+ إضافة عميل</button>` : ""}</div></div>
    <div class="toolbar">
      <input type="search" class="grow" data-q placeholder="بحث بالاسم أو الجوال أو الشركة أو الوسم" />
      <select data-f="category"><option value="">كل التصنيفات</option>${opts(m.categories, "", catLabel)}</select>
      <select data-f="source"><option value="">كل المصادر</option>${opts(m.sources, "", srcLabel)}</select>
      <select data-f="tagId"><option value="">كل الوسوم</option>${opts(m.tags, "", (t) => t.name)}</select>
      <select data-f="listId"><option value="">كل القوائم</option>${opts(m.lists, "", (l) => l.name)}</select>
      <select data-f="assignedTo"><option value="">كل الموظفين</option><option value="none">بدون موظف</option>${opts(m.users.filter((u) => u.active), "", (u) => u.name)}</select>
      <select data-f="status"><option value="">كل الحالات</option>${opts(Object.keys(STATUS_AR), "", (s) => STATUS_AR[s][0])}</select>
    </div>
    <div class="bulk-bar hidden" data-bulk></div>
    <div class="card"><div class="table-wrap" data-table>${skeleton()}</div><div data-pager></div></div>`;

  const cols = [["name", "الاسم"], ["phone", "الجوال", false], ["company", "الشركة"], ["category", "التصنيف"], ["tags", "الوسوم", false], ["source", "المصدر"], ["assigned", "الموظف المسؤول", false], ["last", "آخر تواصل"], ["created", "تاريخ الإضافة"], ["status", "الحالة", false]];
  async function load() {
    try {
      const r = await api(`/contacts${qs({ q: S.q, category: S.category, source: S.source, tagId: S.tagId, listId: S.listId, assignedTo: S.assignedTo, status: S.status, sort: S.sort, dir: S.dir, page: S.page, limit: S.limit })}`);
      S.rows = r.rows; S.total = r.total;
      $("[data-total]", view).textContent = `(${r.total})`;
      const allSel = r.rows.length && r.rows.every((c) => S.selected.has(c.id));
      $("[data-table]", view).innerHTML = r.rows.length ? `<table class="table"><thead><tr><th><input type="checkbox" data-all ${allSel ? "checked" : ""} /></th>${cols.map(([k, l, sortable = true]) => `<th class="${sortable ? "sortable" : ""}" data-sort="${sortable ? k : ""}">${l}${S.sort === k ? (S.dir === "asc" ? " ↑" : " ↓") : ""}</th>`).join("")}</tr></thead><tbody>
        ${r.rows.map((c) => { const st = STATUS_AR[c.status] || ["", ""]; return `<tr data-id="${c.id}" class="${S.selected.has(c.id) ? "selected" : ""}"><td><input type="checkbox" data-sel ${S.selected.has(c.id) ? "checked" : ""} /></td>
          <td class="row-link"><div style="display:flex;align-items:center;gap:8px">${avatar(c.name || c.phone, "sm")}<span>${esc(c.name || "بدون اسم")}</span></div></td>
          <td class="ltr nowrap">${esc(fmtPhone(c.phone))}</td><td>${esc(c.company || "—")}</td><td>${c.category ? `<span class="badge primary">${esc(catLabel(c.category))}</span>` : "—"}</td>
          <td>${c.tags.slice(0, 3).map((t) => `<span class="tag">${esc(t.name)}</span>`).join(" ")}${c.tags.length > 3 ? ` <span class="muted small">+${c.tags.length - 3}</span>` : ""}</td>
          <td>${esc(srcLabel(c.source))}</td><td>${esc(c.assignedName || "—")}</td><td class="nowrap">${fmtDate(c.lastContactAt)}</td><td class="nowrap">${fmtDate(c.createdAt)}</td><td><span class="badge ${st[1]}">${st[0]}</span></td></tr>`; }).join("")}</tbody></table>`
        : empty("لا يوجد عملاء مطابقون", S.q || S.category || S.tagId ? "جرّب تعديل البحث أو الفلاتر" : "ابدأ بإضافة عميل أو استيراد ملف", "👥");
      $("[data-pager]", view).replaceChildren(pager(r, (p) => { S.page = p; load(); }));
      renderBulk();
    } catch (e) { toastErr(e); }
  }
  function renderBulk() {
    const bar = $("[data-bulk]", view); const n = S.selected.size;
    bar.classList.toggle("hidden", !n); if (!n) return;
    bar.innerHTML = `<b>${n} محدد</b>${S.total > n && S.rows.every((c) => S.selected.has(c.id)) ? `<button class="btn small ghost" data-select-all>تحديد كل النتائج (${S.total})</button>` : ""}
      ${can("edit_contact") ? `<select data-ba><option value="">— إجراء —</option><option value="add_tag">إضافة وسم</option><option value="remove_tag">إزالة وسم</option><option value="set_category">تغيير التصنيف</option><option value="assign">تعيين موظف</option><option value="add_to_list">إضافة لقائمة</option><option value="set_opt_in">موافقة الرسائل</option><option value="set_status">تغيير الحالة</option>${can("delete_contact") ? '<option value="delete">حذف</option>' : ""}</select><span data-ba-arg></span><button class="btn small primary" data-ba-run>تنفيذ</button>` : ""}
      ${can("create_campaign") ? `<button class="btn small" data-campaign>📣 حملة للمحددين</button>` : ""}<button class="btn small ghost" data-clear>إلغاء التحديد</button>`;
    const argEl = $("[data-ba-arg]", bar);
    $("[data-ba]", bar)?.addEventListener("change", (e) => {
      const a = e.target.value; const sel = (list, lbl) => `<select data-arg>${list.map((x) => `<option value="${esc(x.id ?? x)}">${esc(lbl(x))}</option>`).join("")}</select>`;
      argEl.innerHTML = a === "add_tag" || a === "remove_tag" ? sel(m.tags, (t) => t.name) : a === "set_category" ? sel(m.categories, catLabel) : a === "assign" ? sel(m.users.filter((u) => u.active), (u) => u.name) : a === "add_to_list" ? sel(m.lists, (l) => l.name) : a === "set_opt_in" ? sel([{ id: "1", n: "موافق" }, { id: "0", n: "غير موافق" }], (x) => x.n) : a === "set_status" ? sel(Object.keys(STATUS_AR), (s) => STATUS_AR[s][0]) : "";
    });
    $("[data-ba-run]", bar)?.addEventListener("click", async () => {
      const action = $("[data-ba]", bar).value; if (!action) return; const arg = $("[data-arg]", bar)?.value;
      const payload = { add_tag: { tagId: arg }, remove_tag: { tagId: arg }, set_category: { category: arg }, assign: { userId: arg }, add_to_list: { listId: arg }, set_opt_in: { optIn: arg === "1" }, set_status: { status: arg }, delete: {} }[action];
      if (action === "delete" && !await confirm({ title: "حذف العملاء", text: `حذف ${S.selected.size} عميل نهائيًا؟`, danger: true, okText: "حذف" })) return;
      try { const r = await api("/contacts/bulk", { method: "POST", body: { ids: [...S.selected], action, payload } }); toast(`تم تنفيذ الإجراء على ${r.count} عميل`, "ok"); S.selected.clear(); load(); } catch (e) { toastErr(e); }
    });
    $("[data-select-all]", bar)?.addEventListener("click", async () => { try { const ids = await api(`/contacts${qs({ q: S.q, category: S.category, source: S.source, tagId: S.tagId, listId: S.listId, assignedTo: S.assignedTo, status: S.status, limit: 200, page: 1 })}`); /* نحدد الصفحة الحالية + نرسل الفلاتر للخادم */ S.selectAllFilters = true; toast("سيُطبَّق الإجراء على كل النتائج المطابقة"); } catch (e) { toastErr(e); } });
    $("[data-clear]", bar)?.addEventListener("click", () => { S.selected.clear(); load(); });
    $("[data-campaign]", bar)?.addEventListener("click", () => { sessionStorage.setItem("campaign:contactIds", JSON.stringify([...S.selected])); navigate("#/campaigns/new"); });
  }
  $("[data-table]", view).addEventListener("click", (e) => {
    const th = e.target.closest("[data-sort]"); if (th?.dataset.sort) { S.dir = S.sort === th.dataset.sort && S.dir === "desc" ? "asc" : "desc"; S.sort = th.dataset.sort; load(); return; }
    if (e.target.matches("[data-all]")) { S.rows.forEach((c) => (e.target.checked ? S.selected.add(c.id) : S.selected.delete(c.id))); load(); return; }
    const tr = e.target.closest("tr[data-id]"); if (!tr) return;
    if (e.target.matches("[data-sel]")) { e.target.checked ? S.selected.add(tr.dataset.id) : S.selected.delete(tr.dataset.id); tr.classList.toggle("selected", e.target.checked); renderBulk(); return; }
    if (e.target.closest(".row-link") || !e.target.closest("input")) openContact(tr.dataset.id);
  });
  $("[data-q]", view).addEventListener("input", debounce((e) => { S.q = e.target.value.trim(); S.page = 1; load(); }, 350));
  $$("[data-f]", view).forEach((s) => s.addEventListener("change", (e) => { S[e.target.dataset.f] = e.target.value; S.page = 1; load(); }));
  $("[data-new]", view)?.addEventListener("click", () => openContactForm(null, load));
  $("[data-import]", view)?.addEventListener("click", () => openImport(load));
  $("[data-export]", view)?.addEventListener("click", () => { window.open(`/api/contacts/export${qs({ q: S.q, category: S.category, source: S.source, tagId: S.tagId, listId: S.listId, assignedTo: S.assignedTo, status: S.status })}`, "_blank"); });
  const onChanged = () => load();
  document.addEventListener("contacts:changed", onChanged);
  await load();
  if (id) openContact(id);
  return { destroy: () => document.removeEventListener("contacts:changed", onChanged) };
}
