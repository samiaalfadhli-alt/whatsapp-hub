// القوالب: ردود جاهزة (/ في المحادثة) وقوالب حملات
import { $, $$, api, esc, can, h, toast, toastErr, modal, confirm, empty, skeleton } from "../core.js";

export async function render(view) {
  const edit = (t = null) => {
    const m = modal({ title: t ? "تعديل القالب" : "قالب جديد", body: `<div class="form-grid"><label>العنوان<input data-f="title" value="${esc(t?.title || "")}" /></label>
      <label>النوع<select data-f="kind"><option value="quick" ${t?.kind !== "campaign" ? "selected" : ""}>رد جاهز للمحادثات</option><option value="campaign" ${t?.kind === "campaign" ? "selected" : ""}>قالب حملة</option></select></label>
      <label class="full">النص<textarea data-f="text" rows="5">${esc(t?.text || "")}</textarea><div class="field-hint">المتغيرات: {{name}} الاسم · {{first_name}} · {{company}} الشركة</div></label>
      <label>اسم القالب لدى Meta (Cloud API فقط)<input data-f="metaName" value="${esc(t?.metaName || "")}" class="ltr" /></label></div>`, foot: `<button class="btn primary" data-ok>حفظ</button><button class="btn" data-close>إلغاء</button>` });
    $("[data-ok]", m.foot).onclick = async () => { try { await api("/templates", { method: "POST", body: { id: t?.id, ...Object.fromEntries($$("[data-f]", m.body).map((x) => [x.dataset.f, x.value])) } }); m.close(); toast("تم الحفظ", "ok"); load(); } catch (e) { toastErr(e); } };
  };
  view.innerHTML = `<div class="page-head"><h1>القوالب</h1><div class="actions">${can("manage_templates") ? `<button class="btn primary" data-new>+ قالب</button>` : ""}</div></div><div class="card"><div class="table-wrap" data-table>${skeleton()}</div></div>`;
  let list = [];
  async function load() {
    try {
      list = await api("/templates");
      $("[data-table]", view).innerHTML = list.length ? `<table class="table"><thead><tr><th>العنوان</th><th>النوع</th><th>النص</th><th></th></tr></thead><tbody>${list.map((t) => `<tr data-id="${t.id}"><td><b>${esc(t.title)}</b>${t.metaName ? `<div class="small muted ltr">${esc(t.metaName)}</div>` : ""}</td><td><span class="badge ${t.kind === "campaign" ? "accent" : "primary"}">${t.kind === "campaign" ? "حملة" : "رد جاهز"}</span></td><td class="muted" style="white-space:pre-wrap;max-width:480px">${esc(t.text)}</td><td class="nowrap">${can("manage_templates") ? `<button class="btn small ghost" data-edit>تعديل</button><button class="btn small ghost danger" data-del>حذف</button>` : ""}</td></tr>`).join("")}</tbody></table>` : empty("لا توجد قوالب", "أضف ردودًا جاهزة لتسريع المحادثات (اكتب / في المحادثة)", "📝");
    } catch (e) { toastErr(e); }
  }
  $("[data-table]", view).addEventListener("click", async (e) => {
    const tr = e.target.closest("tr[data-id]"); if (!tr) return; const t = list.find((x) => x.id === tr.dataset.id);
    if (e.target.closest("[data-edit]")) edit(t);
    if (e.target.closest("[data-del]") && await confirm({ title: "حذف القالب", text: `حذف "${t.title}"؟`, danger: true, okText: "حذف" })) { try { await api(`/templates/${t.id}`, { method: "DELETE" }); load(); } catch (err) { toastErr(err); } }
  });
  $("[data-new]", view)?.addEventListener("click", () => edit());
  await load();
}
