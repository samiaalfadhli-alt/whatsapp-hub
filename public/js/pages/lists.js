// القوائم والوسوم والتصنيفات
import { state, $, $$, api, esc, can, h, toast, toastErr, modal, confirm, prompt, empty } from "../core.js";
import { loadMeta, navigate } from "../app.js";

export async function render(view) {
  const draw = async () => {
    const [tags, lists] = await Promise.all([api("/tags"), api("/lists")]);
    view.innerHTML = `<div class="page-head"><h1>القوائم والتصنيفات</h1></div>
      <div class="grid-2">
        <div class="card"><div class="card-head"><h3>الوسوم (Tags)</h3><button class="btn small primary" data-add-tag>+ وسم</button></div><div class="card-body">
          <p class="muted small">الوسوم مرنة وتُضاف لأي عميل بعدد غير محدود، وتُستخدم في الفلاتر وجمهور الحملات.</p>
          ${tags.length ? `<table class="table"><thead><tr><th>الوسم</th><th>العملاء</th><th></th></tr></thead><tbody>${tags.map((t) => `<tr><td><span class="tag">${esc(t.name)}</span></td><td><a href="#/contacts" data-filter-tag="${t.id}">${t.count}</a></td><td class="nowrap"><button class="btn small ghost" data-edit-tag="${t.id}" data-name="${esc(t.name)}">تعديل</button><button class="btn small ghost danger" data-del-tag="${t.id}" data-name="${esc(t.name)}">حذف</button></td></tr>`).join("")}</tbody></table>` : empty("لا توجد وسوم", "", "🏷️")}</div></div>
        <div class="card"><div class="card-head"><h3>القوائم</h3><button class="btn small primary" data-add-list>+ قائمة</button></div><div class="card-body">
          <p class="muted small">القوائم مجموعات ثابتة من العملاء (مثل: دفعة يناير، المهتمون بدورة X) تُستخدم للحملات.</p>
          ${lists.length ? `<table class="table"><thead><tr><th>القائمة</th><th>الوصف</th><th>العملاء</th><th></th></tr></thead><tbody>${lists.map((l) => `<tr><td>${esc(l.name)}</td><td class="muted">${esc(l.description || "")}</td><td><a href="#/contacts" data-filter-list="${l.id}">${l.count}</a></td><td class="nowrap"><button class="btn small ghost" data-edit-list="${l.id}">تعديل</button><button class="btn small ghost danger" data-del-list="${l.id}" data-name="${esc(l.name)}">حذف</button></td></tr>`).join("")}</tbody></table>` : empty("لا توجد قوائم", "", "📋")}</div></div>
        <div class="card" style="grid-column:1/-1"><div class="card-head"><h3>التصنيفات</h3></div><div class="card-body"><p class="muted small">التصنيف حالة واحدة لكل عميل في مسار البيع:</p><div class="chips">${state.meta.categories.map((c) => `<span class="chip">${esc(state.meta.categoryLabels[c])}</span>`).join("")}</div></div></div>
      </div>`;
    view.onclick = async (e) => {
      const t = e.target;
      try {
        if (t.closest("[data-add-tag]")) { const name = await prompt({ title: "وسم جديد", label: "اسم الوسم" }); if (name) { await api("/tags", { method: "POST", body: { name } }); await loadMeta(); draw(); } }
        if (t.closest("[data-edit-tag]")) { const b = t.closest("[data-edit-tag]"); const name = await prompt({ title: "تعديل الوسم", label: "الاسم", value: b.dataset.name }); if (name) { await api("/tags", { method: "POST", body: { id: b.dataset.editTag, name } }); await loadMeta(); draw(); } }
        if (t.closest("[data-del-tag]")) { const b = t.closest("[data-del-tag]"); if (await confirm({ title: "حذف الوسم", text: `حذف "${b.dataset.name}" من كل العملاء؟`, danger: true, okText: "حذف" })) { await api(`/tags/${b.dataset.delTag}`, { method: "DELETE" }); await loadMeta(); draw(); } }
        if (t.closest("[data-add-list]") || t.closest("[data-edit-list]")) {
          const id = t.closest("[data-edit-list]")?.dataset.editList; const cur = id ? lists.find((l) => l.id === id) : {};
          const m = modal({ title: id ? "تعديل القائمة" : "قائمة جديدة", body: `<label>الاسم<input data-n value="${esc(cur.name || "")}" /></label><label style="margin-top:10px">الوصف<input data-d value="${esc(cur.description || "")}" /></label>`, foot: `<button class="btn primary" data-ok>حفظ</button><button class="btn" data-close>إلغاء</button>` });
          $("[data-ok]", m.foot).onclick = async () => { try { await api("/lists", { method: "POST", body: { id, name: $("[data-n]", m.body).value, description: $("[data-d]", m.body).value } }); m.close(); await loadMeta(); draw(); } catch (err) { toastErr(err); } };
        }
        if (t.closest("[data-del-list]")) { const b = t.closest("[data-del-list]"); if (await confirm({ title: "حذف القائمة", text: `حذف "${b.dataset.name}"؟ (العملاء لا يُحذفون)`, danger: true, okText: "حذف" })) { await api(`/lists/${b.dataset.delList}`, { method: "DELETE" }); await loadMeta(); draw(); } }
      } catch (err) { toastErr(err); }
    };
  };
  await draw();
}
