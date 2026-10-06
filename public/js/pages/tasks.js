// المهام والمتابعات + نوافذ الملاحظة والمهمة المشتركة
import { state, $, $$, api, qs, esc, can, h, toast, toastErr, modal, confirm, fmtDateTime, pager, skeleton, empty, fmtPhone } from "../core.js";
import { navigate } from "../app.js";

const toLocalInput = (ts) => { if (!ts) return ""; const d = new Date(ts); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };

export function addNoteDialog({ contactId, conversationRef }, onDone) {
  const m = modal({ title: "ملاحظة داخلية", body: `<p class="muted small">الملاحظة تظهر للفريق فقط ولا تُرسل للعميل.</p><label>النص<textarea data-text rows="4"></textarea></label>`, foot: `<button class="btn primary" data-ok>حفظ</button><button class="btn" data-close>إلغاء</button>` });
  $("[data-ok]", m.foot).onclick = async () => {
    try { const n = await api(conversationRef ? `/conversations/${conversationRef}/notes` : `/contacts/${contactId}/notes`, { method: "POST", body: { text: $("[data-text]", m.body).value } }); m.close(); toast("أُضيفت الملاحظة", "ok"); onDone?.(n); } catch (e) { toastErr(e); }
  };
}
export function addTaskDialog({ contactId, task }, onDone) {
  const users = state.meta.users.filter((u) => u.active);
  const m = modal({ title: task ? "تعديل المهمة" : "مهمة / متابعة جديدة", body: `<div class="form-grid">
      <label class="full">العنوان<input data-f="title" value="${esc(task?.title || "")}" required /></label>
      <label>النوع<select data-f="type"><option value="task" ${task?.type === "task" ? "selected" : ""}>مهمة</option><option value="followup" ${task?.type === "followup" ? "selected" : ""}>متابعة مع العميل</option></select></label>
      <label>الموعد<input data-f="dueAt" type="datetime-local" value="${toLocalInput(task?.due_at)}" /></label>
      <label>المسؤول<select data-f="assignedTo">${users.map((u) => `<option value="${u.id}" ${(task?.assigned_to || state.me.id) === u.id ? "selected" : ""}>${esc(u.name)}</option>`).join("")}</select></label>
      <label>الحالة<select data-f="status"><option value="open" ${task?.status !== "done" ? "selected" : ""}>مفتوحة</option><option value="done" ${task?.status === "done" ? "selected" : ""}>منجزة</option></select></label>
    </div>`, foot: `<button class="btn primary" data-ok>حفظ</button><button class="btn" data-close>إلغاء</button>` });
  $("[data-ok]", m.foot).onclick = async () => {
    const f = Object.fromEntries($$("[data-f]", m.body).map((x) => [x.dataset.f, x.value]));
    try { const t = await api("/tasks", { method: "POST", body: { id: task?.id, contactId: contactId || task?.contact_id, ...f, dueAt: f.dueAt ? new Date(f.dueAt).getTime() : null } }); m.close(); toast("تم الحفظ", "ok"); onDone?.(t); } catch (e) { toastErr(e); }
  };
}

export async function render(view) {
  const S = { status: "open", assignedTo: "", page: 1 };
  view.innerHTML = `<div class="page-head"><h1>المهام والمتابعات</h1><div class="actions">${can("manage_tasks") ? `<button class="btn primary" data-new>+ مهمة جديدة</button>` : ""}</div></div>
    <div class="toolbar"><div class="chips">${[["open", "مفتوحة"], ["done", "منجزة"], ["", "الكل"]].map(([k, l]) => `<button class="chip ${k === "open" ? "active" : ""}" data-s="${k}">${l}</button>`).join("")}</div>
      <select data-assigned><option value="">كل الموظفين</option>${state.meta.users.filter((u) => u.active).map((u) => `<option value="${u.id}" ${u.id === state.me.id ? "" : ""}>${esc(u.name)}</option>`).join("")}</select></div>
    <div class="card"><div class="table-wrap" data-table>${skeleton()}</div><div data-pager></div></div>`;
  async function load() {
    try {
      const r = await api(`/tasks${qs({ status: S.status, assignedTo: S.assignedTo, page: S.page, limit: 25 })}`);
      $("[data-table]", view).innerHTML = r.rows.length ? `<table class="table"><thead><tr><th></th><th>المهمة</th><th>العميل</th><th>الموعد</th><th>المسؤول</th><th>الحالة</th><th></th></tr></thead><tbody>${r.rows.map((t) => `<tr data-id="${t.id}" class="${t.status}">
        <td><input type="checkbox" data-done ${t.status === "done" ? "checked" : ""} ${can("manage_tasks") ? "" : "disabled"} /></td>
        <td>${t.type === "followup" ? "🔁 " : ""}${esc(t.title)}</td>
        <td>${t.contact_id ? `<a href="#/contacts/${t.contact_id}">${esc(t.contactName || fmtPhone(t.contactPhone))}</a>` : "—"}</td>
        <td class="${t.due_at && t.due_at < Date.now() && t.status === "open" ? "badge bad" : ""}">${fmtDateTime(t.due_at)}</td><td>${esc(t.assignedName || "—")}</td>
        <td><span class="badge ${t.status === "done" ? "good" : "warn"}">${t.status === "done" ? "منجزة" : "مفتوحة"}</span></td>
        <td class="nowrap">${can("manage_tasks") ? `<button class="btn small ghost" data-edit>تعديل</button><button class="btn small ghost danger" data-del>حذف</button>` : ""}</td></tr>`).join("")}</tbody></table>` : empty("لا توجد مهام", "", "✅");
      $("[data-pager]", view).replaceChildren(pager(r, (p) => { S.page = p; load(); }));
      $("[data-table]", view).onclick = async (e) => {
        const tr = e.target.closest("tr[data-id]"); if (!tr) return; const t = r.rows.find((x) => x.id === tr.dataset.id);
        if (e.target.matches("[data-done]")) { try { await api("/tasks", { method: "POST", body: { ...t, dueAt: t.due_at, assignedTo: t.assigned_to, contactId: t.contact_id, status: e.target.checked ? "done" : "open" } }); load(); } catch (err) { toastErr(err); } }
        if (e.target.closest("[data-edit]")) addTaskDialog({ task: t }, load);
        if (e.target.closest("[data-del]") && await confirm({ title: "حذف المهمة", text: `حذف "${t.title}"؟`, danger: true, okText: "حذف" })) { try { await api(`/tasks/${t.id}`, { method: "DELETE" }); load(); } catch (err) { toastErr(err); } }
      };
    } catch (e) { toastErr(e); }
  }
  $$("[data-s]", view).forEach((b) => b.onclick = () => { $$("[data-s]", view).forEach((x) => x.classList.toggle("active", x === b)); S.status = b.dataset.s; S.page = 1; load(); });
  $("[data-assigned]", view).onchange = (e) => { S.assignedTo = e.target.value; S.page = 1; load(); };
  $("[data-new]", view)?.addEventListener("click", () => addTaskDialog({}, load));
  await load();
}
