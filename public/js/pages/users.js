// المستخدمون
import { state, $, $$, api, esc, can, h, toast, toastErr, drawer, confirm, fmtDateTime, empty, skeleton } from "../core.js";
import { loadMeta } from "../app.js";

export async function render(view) {
  view.innerHTML = `<div class="page-head"><h1>المستخدمون</h1><div class="actions"><button class="btn primary" data-new>+ مستخدم</button></div></div><div class="card"><div class="table-wrap" data-table>${skeleton()}</div></div>`;
  let list = [], roles = [];
  const form = (u = null) => {
    const accs = state.meta.accounts; const sups = list.filter((x) => x.active && ["supervisor", "admin", "super_admin"].includes(x.role) && x.id !== u?.id);
    const d = drawer({ title: u ? `تعديل: ${u.name}` : "مستخدم جديد", body: `<div class="form-grid">
        <label>الاسم<input data-f="name" value="${esc(u?.name || "")}" /></label>
        <label>اسم المستخدم<input data-f="username" value="${esc(u?.username || "")}" ${u ? "disabled" : ""} class="ltr" autocomplete="off" /></label>
        <label>${u ? "كلمة مرور جديدة (اختياري)" : "كلمة المرور"}<input data-f="password" type="password" autocomplete="new-password" /></label>
        <label>الدور<select data-f="role">${roles.filter((r) => r.id !== "super_admin" || state.me.isSuper).map((r) => `<option value="${r.id}" ${(u?.role || "agent") === r.id ? "selected" : ""}>${esc(r.name)}</option>`).join("")}</select></label>
        <label>المشرف (للموظفين)<select data-f="supervisorId"><option value="">—</option>${sups.map((s) => `<option value="${s.id}" ${u?.supervisorId === s.id ? "selected" : ""}>${esc(s.name)}</option>`).join("")}</select></label>
        <label class="check" style="align-self:end"><input type="checkbox" data-f="active" ${u?.active === false ? "" : "checked"} /> نشط</label>
        <div class="full"><label>أرقام WhatsApp التي يراها (لمن لا يملك «عرض كل المحادثات»)</label><div class="chips" data-accs style="margin-top:6px">${accs.map((a) => `<button type="button" class="chip ${(u?.accountIds || []).includes(a.id) ? "active" : ""}" data-v="${a.id}">${esc(a.label)}</button>`).join("") || '<span class="muted small">لا توجد أرقام</span>'}</div></div>
        <div class="full"><label>صلاحيات إضافية فوق الدور</label><div class="perm-grid" style="margin-top:6px">${state.meta.permissionList.map(([k, l]) => `<label class="check"><input type="checkbox" data-xp="${k}" ${(u?.extraPermissions || []).includes(k) ? "checked" : ""} /> ${esc(l)}</label>`).join("")}</div></div>
        <p class="form-error full" data-error></p></div>`, foot: `<button class="btn primary" data-ok>حفظ</button><button class="btn" data-close>إلغاء</button>` });
    $("[data-accs]", d.body).addEventListener("click", (e) => e.target.closest("[data-v]")?.classList.toggle("active"));
    $("[data-ok]", d.foot).onclick = async () => {
      const b = Object.fromEntries($$("[data-f]", d.body).map((x) => [x.dataset.f, x.type === "checkbox" ? x.checked : x.value]));
      b.accountIds = $$("[data-accs] .active", d.body).map((x) => x.dataset.v); b.extraPermissions = $$("[data-xp]:checked", d.body).map((x) => x.dataset.xp);
      if (!b.password) delete b.password;
      try { await api(u ? `/users/${u.id}` : "/users", { method: u ? "PATCH" : "POST", body: b }); d.close(); toast("تم الحفظ", "ok"); await loadMeta(); load(); } catch (e) { $("[data-error]", d.body).textContent = e.message; }
    };
  };
  async function load() {
    try {
      [list, roles] = await Promise.all([api("/users"), api("/roles").then((r) => r.roles)]);
      $("[data-table]", view).innerHTML = `<table class="table"><thead><tr><th>الاسم</th><th>اسم المستخدم</th><th>الدور</th><th>المشرف</th><th>الأرقام</th><th>آخر ظهور</th><th>الحالة</th><th></th></tr></thead><tbody>${list.map((u) => `<tr data-id="${u.id}">
        <td><b>${esc(u.name)}</b>${u.id === state.me.id ? ' <span class="badge">أنا</span>' : ""}</td><td class="ltr">@${esc(u.username)}</td><td><span class="badge ${u.isSuper ? "warn" : "primary"}">${esc(u.roleName)}</span></td>
        <td>${esc(list.find((x) => x.id === u.supervisorId)?.name || "—")}</td><td class="small">${u.accountIds.map((id) => esc(state.meta.accounts.find((a) => a.id === id)?.label || "")).filter(Boolean).join("، ") || (u.permissions.includes("view_all_conversations") || u.isSuper ? "الكل" : "—")}</td>
        <td class="nowrap small">${fmtDateTime(u.last_seen_at)}</td><td><span class="badge ${u.active ? "good" : "bad"}">${u.active ? "نشط" : "معطّل"}</span></td>
        <td class="nowrap"><button class="btn small ghost" data-edit>تعديل</button>${u.id !== state.me.id ? `<button class="btn small ghost" data-toggle>${u.active ? "تعطيل" : "تفعيل"}</button><button class="btn small ghost danger" data-del>حذف</button>` : ""}</td></tr>`).join("")}</tbody></table>`;
    } catch (e) { toastErr(e); }
  }
  $("[data-table]", view).addEventListener("click", async (e) => {
    const tr = e.target.closest("tr[data-id]"); if (!tr) return; const u = list.find((x) => x.id === tr.dataset.id);
    try {
      if (e.target.closest("[data-edit]")) form(u);
      if (e.target.closest("[data-toggle]")) { await api(`/users/${u.id}`, { method: "PATCH", body: { active: !u.active } }); load(); }
      if (e.target.closest("[data-del]") && await confirm({ title: "حذف المستخدم", text: `حذف "${u.name}"؟ ستُلغى إسناداته.`, danger: true, okText: "حذف" })) { await api(`/users/${u.id}`, { method: "DELETE" }); await loadMeta(); load(); }
    } catch (err) { toastErr(err); }
  });
  $("[data-new]", view).addEventListener("click", () => form());
  await load();
}
