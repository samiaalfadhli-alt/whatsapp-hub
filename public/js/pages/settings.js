// الإعدادات العامة: الأرقام، التنبيهات، الردود التلقائية
import { state, $, $$, api, esc, h, toast, toastErr, modal, confirm, empty, skeleton } from "../core.js";
import { bus } from "../app.js";

const TRIGGER_AR = { keyword: "كلمة مفتاحية", welcome: "ترحيب", away: "خارج الدوام" };
export async function render(view) {
  const draw = async () => {
    try {
      const s = await api("/settings");
      const EMAIL_ST = { connected: "متصل ✅", connecting: "جارٍ الاتصال…", reconnecting: "إعادة الاتصال…", error: "خطأ ❌", not_configured: "غير مُعدّ", disconnected: "غير متصل" };
      view.innerHTML = `<div class="page-head"><h1>الإعدادات</h1></div><div class="grid-2">
        <div class="card"><div class="card-head"><h3>عام</h3></div><div class="card-body"><form data-general class="form-grid">
          <label>مفتاح الدولة الافتراضي<input name="defaultCountryCode" value="${esc(s.defaultCountryCode)}" class="ltr" /><div class="field-hint">يُستخدم لتوحيد الأرقام المحلية (05…) عند الإضافة والاستيراد.</div></label>
          <label class="check" style="align-self:end"><input type="checkbox" name="agentsSeeUnassigned" ${s.agentsSeeUnassigned ? "checked" : ""} /> الموظفون يرون المحادثات غير المُسندة على أرقامهم</label>
          <div class="full"><button class="btn primary">حفظ</button></div></form></div></div>
        <div class="card"><div class="card-head"><h3>🔔 تنبيهات الاستفسارات بالإيميل</h3></div><div class="card-body"><form data-alerts class="form-grid">
          <label class="check full"><input type="checkbox" name="enabled" ${s.alerts.enabled ? "checked" : ""} /> تفعيل التنبيهات</label>
          <label class="full">إيميل استقبال التنبيهات<input name="notifyEmail" type="email" value="${esc(s.alerts.notifyEmail || "")}" /></label>
          <label class="full">الكلمات التي تُعتبر استفسارًا (افصل بفاصلة)<textarea name="keywords" rows="2">${esc(s.alerts.keywords || "")}</textarea></label>
          <label class="check"><input type="checkbox" name="whatsapp" ${s.alerts.whatsapp ? "checked" : ""} /> مراقبة واتساب</label><label class="check"><input type="checkbox" name="email" ${s.alerts.email ? "checked" : ""} /> مراقبة الإيميل الوارد</label>
          <label>عدم التكرار لنفس الشخص خلال (دقائق)<input name="cooldownMinutes" type="number" min="0" value="${s.alerts.cooldownMinutes ?? 60}" /></label>
          <div class="full small muted">SMTP: ${s.alerts.smtpConfigured ? "مُعدّ ✅" : "غير مُعدّ — أضف SMTP_HOST/USER/PASS في متغيرات البيئة"} · IMAP: ${s.alerts.imapConfigured ? `${esc(s.alerts.imapUser)} — ${EMAIL_ST[s.alerts.emailStatus] || s.alerts.emailStatus}${s.alerts.emailError ? " (" + esc(s.alerts.emailError) + ")" : ""}` : "غير مُعدّ"}</div>
          <div class="full" style="display:flex;gap:8px"><button class="btn primary">حفظ</button><button class="btn" type="button" data-test>إرسال إيميل تجريبي</button></div></form></div></div>
        <div class="card" style="grid-column:1/-1"><div class="card-head"><h3>🤖 الردود التلقائية</h3><button class="btn small primary" data-new-rule>+ قاعدة</button></div><div class="card-body" data-rules>
          ${s.rules.length ? `<table class="table"><thead><tr><th>القاعدة</th><th>النوع</th><th>الرقم</th><th>التفاصيل</th><th>الرد</th><th></th></tr></thead><tbody>${s.rules.map((r) => `<tr class="${r.enabled === false ? "muted" : ""}" data-id="${r.id}"><td><b>${esc(r.name || TRIGGER_AR[r.trigger])}</b></td><td><span class="badge">${TRIGGER_AR[r.trigger]}</span></td><td>${esc(state.meta.accounts.find((a) => a.id === r.accountId)?.label || "كل الأرقام")}</td><td class="small muted">${r.trigger === "keyword" ? "الكلمات: " + esc(r.keywords) : r.trigger === "away" ? `من ${r.fromHour ?? 18}:00 إلى ${r.toHour ?? 8}:00` : `مرة كل ${r.cooldownHours || 24} ساعة`}</td><td class="small" style="white-space:pre-wrap;max-width:300px">${esc(r.reply)}</td><td class="nowrap"><button class="btn small ghost" data-toggle>${r.enabled === false ? "تفعيل" : "تعطيل"}</button><button class="btn small ghost" data-edit>تعديل</button><button class="btn small ghost danger" data-del>حذف</button></td></tr>`).join("")}</tbody></table>` : '<div class="muted small">لا توجد قواعد. أضف ترحيبًا تلقائيًا أو ردًا على كلمات مفتاحية.</div>'}</div></div>
        <div class="card" style="grid-column:1/-1"><div class="card-head"><h3>Webhook لـ Meta Cloud API</h3></div><div class="card-body small muted">Callback URL: <code class="ltr">${location.origin}${esc(s.webhookUrl)}</code> · Verify Token من <code>META_VERIFY_TOKEN</code> · التحقق من التوقيع: ${s.webhookSigned ? "مفعّل ✅" : "غير مفعّل — أضف <code>META_APP_SECRET</code> في متغيرات البيئة"}</div></div>
      </div>`;
      $("[data-general]", view).onsubmit = async (e) => { e.preventDefault(); const f = e.target; try { await api("/settings", { method: "POST", body: { defaultCountryCode: f.defaultCountryCode.value, agentsSeeUnassigned: f.agentsSeeUnassigned.checked } }); toast("تم الحفظ", "ok"); } catch (err) { toastErr(err); } };
      $("[data-alerts]", view).onsubmit = async (e) => { e.preventDefault(); const f = e.target; try { await api("/settings", { method: "POST", body: { alerts: { enabled: f.enabled.checked, notifyEmail: f.notifyEmail.value, keywords: f.keywords.value, whatsapp: f.whatsapp.checked, email: f.email.checked, cooldownMinutes: f.cooldownMinutes.value } } }); toast("تم الحفظ", "ok"); } catch (err) { toastErr(err); } };
      $("[data-test]", view).onclick = async () => { try { await api("/settings/alerts/test", { method: "POST", body: { to: $("[data-alerts] [name=notifyEmail]", view).value } }); toast("تم إرسال إيميل تجريبي ✅", "ok"); } catch (err) { toastErr(err); } };
      $("[data-new-rule]", view).onclick = () => ruleForm();
      $("[data-rules]", view).onclick = async (e) => {
        const tr = e.target.closest("tr[data-id]"); if (!tr) return; const r = s.rules.find((x) => x.id === tr.dataset.id);
        try {
          if (e.target.closest("[data-toggle]")) { await api("/rules", { method: "POST", body: { ...r, enabled: r.enabled === false } }); draw(); }
          if (e.target.closest("[data-edit]")) ruleForm(r);
          if (e.target.closest("[data-del]") && await confirm({ title: "حذف القاعدة", text: "حذف هذه القاعدة؟", danger: true, okText: "حذف" })) { await api(`/rules/${r.id}`, { method: "DELETE" }); draw(); }
        } catch (err) { toastErr(err); }
      };
    } catch (e) { view.innerHTML = empty("تعذر تحميل الإعدادات", e.message, "⚠️"); }
  };
  const ruleForm = (r = {}) => {
    const m = modal({ title: r.id ? "تعديل القاعدة" : "قاعدة رد تلقائي", body: `<div class="form-grid">
      <label>اسم القاعدة<input data-f="name" value="${esc(r.name || "")}" /></label>
      <label>النوع<select data-f="trigger"><option value="keyword" ${r.trigger === "keyword" ? "selected" : ""}>كلمة مفتاحية</option><option value="welcome" ${r.trigger === "welcome" ? "selected" : ""}>ترحيب (أول رسالة)</option><option value="away" ${r.trigger === "away" ? "selected" : ""}>خارج أوقات العمل</option></select></label>
      <label>الرقم<select data-f="accountId"><option value="">كل الأرقام</option>${state.meta.accounts.map((a) => `<option value="${a.id}" ${a.id === r.accountId ? "selected" : ""}>${esc(a.label)}</option>`).join("")}</select></label>
      <label data-kw>الكلمات (افصل بفاصلة)<input data-f="keywords" value="${esc(r.keywords || "")}" /></label>
      <label data-kw>المطابقة<select data-f="match"><option value="contains" ${r.match !== "exact" ? "selected" : ""}>تحتوي</option><option value="exact" ${r.match === "exact" ? "selected" : ""}>مطابقة تامة</option></select></label>
      <label data-away>من الساعة<input data-f="fromHour" type="number" min="0" max="23" value="${r.fromHour ?? 18}" /></label><label data-away>إلى الساعة<input data-f="toHour" type="number" min="0" max="23" value="${r.toHour ?? 8}" /></label>
      <label data-cd>لا يتكرر خلال (ساعات)<input data-f="cooldownHours" type="number" min="1" value="${r.cooldownHours ?? 24}" /></label>
      <label class="full">نص الرد<textarea data-f="reply" rows="3">${esc(r.reply || "")}</textarea><div class="field-hint">{name} لاسم العميل</div></label></div>`, foot: `<button class="btn primary" data-ok>حفظ</button><button class="btn" data-close>إلغاء</button>` });
    const sync = () => { const t = $("[data-f=trigger]", m.body).value; $$("[data-kw]", m.body).forEach((x) => x.classList.toggle("hidden", t !== "keyword")); $$("[data-away]", m.body).forEach((x) => x.classList.toggle("hidden", t !== "away")); $("[data-cd]", m.body).classList.toggle("hidden", t === "keyword"); };
    $("[data-f=trigger]", m.body).onchange = sync; sync();
    $("[data-ok]", m.foot).onclick = async () => { try { await api("/rules", { method: "POST", body: { id: r.id, ...Object.fromEntries($$("[data-f]", m.body).map((x) => [x.dataset.f, x.value])) } }); m.close(); draw(); } catch (e) { toastErr(e); } };
  };
  await draw();
  const onEmail = () => draw();
  bus.addEventListener("email:status", onEmail);
  return { destroy: () => bus.removeEventListener("email:status", onEmail) };
}
