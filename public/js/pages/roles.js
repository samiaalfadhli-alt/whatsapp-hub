// الصلاحيات: مصفوفة الأدوار × الصلاحيات
import { state, $, $$, api, esc, toast, toastErr, confirm, prompt, skeleton } from "../core.js";
import { loadMeta } from "../app.js";

export async function render(view) {
  view.innerHTML = `<div class="page-head"><h1>الصلاحيات</h1><div class="actions"><button class="btn primary" data-new>+ دور مخصص</button></div></div>
    <p class="muted small">الصلاحيات تُطبَّق في الخادم على كل طلب. Super Admin يملك كل الصلاحيات دائمًا. تغييرات الأدوار تسري فورًا على المستخدمين.</p>
    <div class="card matrix" data-table>${skeleton(8)}</div>`;
  let roles = [], perms = [];
  async function load() {
    try {
      ({ roles, permissions: perms } = await api("/roles"));
      $("[data-table]", view).innerHTML = `<table class="table"><thead><tr><th>الصلاحية</th>${roles.map((r) => `<th>${esc(r.name)}<div class="small muted">${r.users} مستخدم</div>${!r.is_system ? `<div><button class="btn small ghost" data-rename="${r.id}">✏️</button><button class="btn small ghost danger" data-del="${r.id}">🗑</button></div>` : ""}</th>`).join("")}</tr></thead>
        <tbody>${perms.map(([k, l]) => `<tr><td>${esc(l)}<div class="small muted ltr" style="text-align:end">${k}</div></td>${roles.map((r) => `<td><input type="checkbox" data-role="${r.id}" data-perm="${k}" ${r.permissions.includes(k) ? "checked" : ""} ${r.id === "super_admin" ? "disabled" : ""} /></td>`).join("")}</tr>`).join("")}</tbody></table>`;
    } catch (e) { toastErr(e); }
  }
  $("[data-table]", view).addEventListener("change", async (e) => {
    const cb = e.target; if (!cb.matches("[data-role]")) return;
    const r = roles.find((x) => x.id === cb.dataset.role); const next = cb.checked ? [...new Set([...r.permissions, cb.dataset.perm])] : r.permissions.filter((p) => p !== cb.dataset.perm);
    try { const u = await api(`/roles/${r.id}`, { method: "PATCH", body: { permissions: next } }); r.permissions = u.permissions; toast("تم تحديث الصلاحية", "ok"); if (r.id === state.me.role) await loadMeta(); } catch (err) { toastErr(err); cb.checked = !cb.checked; }
  });
  $("[data-table]", view).addEventListener("click", async (e) => {
    try {
      const rn = e.target.closest("[data-rename]"); if (rn) { const name = await prompt({ title: "اسم الدور", label: "الاسم", value: roles.find((r) => r.id === rn.dataset.rename).name }); if (name) { await api(`/roles/${rn.dataset.rename}`, { method: "PATCH", body: { name } }); load(); } }
      const dl = e.target.closest("[data-del]"); if (dl && await confirm({ title: "حذف الدور", text: "حذف هذا الدور؟", danger: true, okText: "حذف" })) { await api(`/roles/${dl.dataset.del}`, { method: "DELETE" }); load(); }
    } catch (err) { toastErr(err); }
  });
  $("[data-new]", view).addEventListener("click", async () => { const name = await prompt({ title: "دور مخصص", label: "اسم الدور (مثال: مسوّق)" }); if (name) { try { await api("/roles", { method: "POST", body: { name, permissions: [] } }); load(); } catch (e) { toastErr(e); } } });
  await load();
}
