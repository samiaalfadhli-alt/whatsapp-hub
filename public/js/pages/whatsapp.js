// إعدادات WhatsApp: الأرقام المربوطة، QR، Cloud API
import { state, $, $$, api, esc, h, toast, toastErr, modal, confirm, prompt, empty, skeleton, fmtPhone } from "../core.js";
import { bus, loadMeta } from "../app.js";

const WA = { connected: ["متصل", "good"], connecting: ["جارٍ الاتصال…", "warn"], reconnecting: ["إعادة الاتصال…", "warn"], qr: ["بانتظار مسح QR", "warn"], disconnected: ["غير متصل", "bad"], logged_out: ["تم تسجيل الخروج", "bad"], error: ["خطأ", "bad"] };
let qrModal = null;

export async function render(view) {
  let accounts = [];
  const draw = async () => {
    try {
      accounts = await api("/accounts");
      view.innerHTML = `<div class="page-head"><h1>إعدادات WhatsApp</h1><div class="actions"><button class="btn primary" data-add>+ ربط رقم</button></div></div>
        <div class="card" style="margin-bottom:14px"><div class="card-body small muted">التكامل الحالي: <b>ربط QR عبر واتساب ويب</b> (غير رسمي من Meta — مناسب للأرقام الحالية) و<b>Meta Cloud API</b> الرسمي (يتطلب حساب أعمال وقوالب معتمدة). يجب تشغيل نسخة واحدة فقط من الخادم لكل رقم.</div></div>
        <div class="card"><div class="table-wrap">${accounts.length ? `<table class="table"><thead><tr><th>الاسم</th><th>النوع</th><th>الرقم</th><th>الحالة</th><th></th></tr></thead><tbody>${accounts.map((a) => { const st = WA[a.status] || [a.status, ""]; return `<tr data-id="${a.id}"><td><b>${esc(a.label)}</b></td><td><span class="badge">${a.type === "cloud" ? "Cloud API" : "QR"}</span></td><td class="ltr">${esc(fmtPhone(a.phone)) || "—"}</td><td><span class="badge ${st[1]}">${st[0]}</span>${a.error ? `<div class="small" style="color:var(--bad)">${esc(a.error)}</div>` : ""}</td>
          <td class="nowrap">${a.status === "qr" ? `<button class="btn small primary" data-qr>📱 عرض QR</button>` : ""}${a.status === "connected" ? `<button class="btn small" data-disconnect>فصل مؤقت</button>` : `<button class="btn small" data-connect>اتصال</button>`}<button class="btn small ghost" data-rename>إعادة تسمية</button><button class="btn small ghost danger" data-remove>إزالة</button></td></tr>`; }).join("")}</tbody></table>` : empty("لا توجد أرقام مربوطة", "اضغط «ربط رقم» وامسح QR من هاتفك", "📱")}</div></div>`;
    } catch (e) { toastErr(e); }
  };
  const openQr = (id) => {
    qrModal?.close();
    qrModal = modal({ title: "امسح رمز QR", body: `<div class="qr-box"><p class="muted small">من هاتفك: واتساب ← الأجهزة المرتبطة ← ربط جهاز</p><img data-qr-img alt="QR" /><p class="muted" data-qr-st></p></div>`, foot: `<button class="btn" data-close>إغلاق</button>`, onClose: () => (qrModal = null) });
    qrModal.accountId = id; updateQr(accounts.find((a) => a.id === id));
  };
  const updateQr = (a) => { if (!qrModal || !a || a.id !== qrModal.accountId) return; const img = $("[data-qr-img]", qrModal.body); img.src = a.qr || ""; img.style.visibility = a.qr ? "visible" : "hidden"; $("[data-qr-st]", qrModal.body).textContent = (WA[a.status] || [a.status])[0]; if (a.status === "connected") { toast(`تم ربط ${a.label} ✅ — سيبدأ سحب سجل الدردشات تلقائيًا`, "ok"); setTimeout(() => qrModal?.close(), 800); } };
  view.addEventListener("click", async (e) => {
    if (e.target.closest("[data-add]")) {
      const m = modal({ title: "ربط رقم جديد", body: `<div class="form-grid"><label class="full">الاسم التعريفي<input data-f="label" placeholder="مثال: خدمة العملاء" /></label>
        <label class="full">نوع الربط<select data-f="type"><option value="qr">واتساب عادي / بزنس — عبر QR</option><option value="cloud">WhatsApp Business Cloud API (Meta)</option></select></label>
        <div class="full hidden" data-cloud><div class="form-grid"><label>Phone Number ID<input data-f="phoneNumberId" class="ltr" /></label><label>Access Token<input data-f="accessToken" type="password" class="ltr" /></label></div><p class="small muted">Webhook: <code class="ltr">${location.origin}/webhooks/cloud</code></p></div></div>`, foot: `<button class="btn primary" data-ok>ربط</button><button class="btn" data-close>إلغاء</button>` });
      $("[data-f=type]", m.body).onchange = (ev) => $("[data-cloud]", m.body).classList.toggle("hidden", ev.target.value !== "cloud");
      $("[data-ok]", m.foot).onclick = async () => { try { const a = await api("/accounts", { method: "POST", body: Object.fromEntries($$("[data-f]", m.body).map((x) => [x.dataset.f, x.value])) }); m.close(); await loadMeta(); await draw(); if (a.type !== "cloud") openQr(a.id); } catch (err) { toastErr(err); } };
      return;
    }
    const tr = e.target.closest("tr[data-id]"); if (!tr) return; const id = tr.dataset.id; const a = accounts.find((x) => x.id === id);
    try {
      if (e.target.closest("[data-qr]")) openQr(id);
      if (e.target.closest("[data-connect]")) { await api(`/accounts/${id}/connect`, { method: "POST" }); draw(); }
      if (e.target.closest("[data-disconnect]")) { await api(`/accounts/${id}/disconnect`, { method: "POST" }); draw(); }
      if (e.target.closest("[data-rename]")) { const label = await prompt({ title: "إعادة تسمية", label: "الاسم", value: a.label }); if (label) { await api(`/accounts/${id}`, { method: "PATCH", body: { label } }); await loadMeta(); draw(); } }
      if (e.target.closest("[data-remove]") && await confirm({ title: "إزالة الرقم", text: `سيتم تسجيل الخروج من "${a.label}" وحذف محادثاته ووسائطه من النظام. العملاء يبقون.`, danger: true, okText: "إزالة" })) { await api(`/accounts/${id}`, { method: "DELETE" }); await loadMeta(); draw(); }
    } catch (err) { toastErr(err); }
  });
  const onUpd = (e) => { const a = e.detail; const i = accounts.findIndex((x) => x.id === a.id); if (i === -1) accounts.push(a); else accounts[i] = a; updateQr(a); clearTimeout(onUpd.t); onUpd.t = setTimeout(draw, 300); };
  bus.addEventListener("account:update", onUpd); bus.addEventListener("account:removed", onUpd);
  await draw();
  return { destroy: () => { bus.removeEventListener("account:update", onUpd); bus.removeEventListener("account:removed", onUpd); qrModal?.close(); } };
}
