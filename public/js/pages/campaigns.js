// الرسائل الجماعية: قائمة + معالج إنشاء + تقرير الحملة
import { state, $, $$, api, qs, esc, can, h, toast, toastErr, modal, drawer, confirm, fmtDateTime, fmtPhone, pager, skeleton, empty, catLabel, srcLabel } from "../core.js";
import { bus, navigate } from "../app.js";

const ST = { draft: ["مسودة", ""], scheduled: ["مجدولة", "accent"], running: ["جارٍ الإرسال", "warn"], paused: ["متوقفة", "warn"], done: ["مكتملة", "good"], cancelled: ["ملغاة", "bad"] };
const RS = { pending: ["في الانتظار", ""], queued: ["قيد الإرسال", ""], sent: ["أُرسلت", "accent"], delivered: ["وصلت", "good"], read: ["قُرئت", "good"], failed: ["فشلت", "bad"], skipped: ["مستبعد", "warn"] };
const REASON = { invalid: "رقم غير صحيح", duplicate: "مكرر", opt_out: "لا يوجد موافقة", blocked: "محظور/مؤرشف" };

export async function render(view, [sub]) {
  if (sub === "new") return wizard(view);
  if (sub) return report(view, sub);
  view.innerHTML = `<div class="page-head"><h1>الرسائل الجماعية</h1><div class="actions">${can("create_campaign") ? `<button class="btn primary" data-new>+ حملة جديدة</button>` : ""}</div></div>
    <div class="card" style="margin-bottom:14px"><div class="card-body small muted">⚠️ الإرسال الجماعي عبر رقم مربوط بـ QR يخضع لسياسات واتساب؛ يُرسل النظام رسالة كل بضع ثوانٍ لتقليل خطر الحظر، ويستبعد تلقائيًا من لا توجد لديه موافقة. مع Cloud API الرسمي يلزم قالب معتمد من Meta للرسائل خارج نافذة 24 ساعة.</div></div>
    <div class="card"><div class="table-wrap" data-table>${skeleton()}</div><div data-pager></div></div>`;
  let page = 1;
  async function load() {
    try {
      const r = await api(`/campaigns${qs({ page, limit: 20 })}`);
      $("[data-table]", view).innerHTML = r.rows.length ? `<table class="table"><thead><tr><th>الحملة</th><th>الرقم</th><th>الحالة</th><th>الجمهور</th><th>أُرسلت</th><th>وصلت</th><th>قُرئت</th><th>فشلت</th><th>أُنشئت</th></tr></thead><tbody>${r.rows.map((c) => `<tr class="row-link" data-id="${c.id}"><td><b>${esc(c.name)}</b></td><td>${esc(c.accountLabel || "")}</td><td><span class="badge ${ST[c.status]?.[1] || ""}">${ST[c.status]?.[0] || c.status}</span></td><td>${c.stats.total}</td><td>${c.stats.sent + c.stats.delivered + c.stats.read}</td><td>${c.stats.delivered + c.stats.read}</td><td>${c.stats.read}</td><td class="${c.stats.failed ? "badge bad" : ""}">${c.stats.failed}</td><td class="nowrap">${fmtDateTime(c.createdAt)}</td></tr>`).join("")}</tbody></table>` : empty("لا توجد حملات بعد", "أنشئ أول حملة من الزر أعلاه", "📣");
      $("[data-pager]", view).replaceChildren(pager(r, (p) => { page = p; load(); }));
    } catch (e) { toastErr(e); }
  }
  $("[data-table]", view).addEventListener("click", (e) => { const tr = e.target.closest("tr[data-id]"); if (tr) navigate(`#/campaigns/${tr.dataset.id}`); });
  $("[data-new]", view)?.addEventListener("click", () => navigate("#/campaigns/new"));
  const onUpd = () => load();
  bus.addEventListener("campaign:update", onUpd);
  await load();
  return { destroy: () => bus.removeEventListener("campaign:update", onUpd) };
}

// ---------- المعالج ----------
async function wizard(view) {
  const m = state.meta;
  if (!m.accounts.length) { view.innerHTML = `<div class="page-head"><h1>حملة جديدة</h1><a class="btn" href="#/campaigns">رجوع</a></div>${empty("لا يوجد رقم واتساب مربوط", "اربط رقمًا من «إعدادات WhatsApp» أولًا", "📱")}`; return; }
  const preset = JSON.parse(sessionStorage.getItem("campaign:contactIds") || "null"); sessionStorage.removeItem("campaign:contactIds");
  const C = { name: "", accountId: m.accounts[0]?.id || "", audience: { listIds: [], tagIds: [], categories: [], sources: [], assignedTo: [], contactIds: preset || [], excludeTagIds: [] }, messageText: "", templateId: "", media: null, delayMs: 4000, step: 1, id: null };
  const steps = ["الاسم والرقم", "الجمهور", "الأهلية", "الرسالة", "المعاينة", "التأكيد والإرسال"];
  const templates = await api("/templates").catch(() => []);
  const multi = (name, list, lbl) => `<div class="chips" data-multi="${name}">${list.map((x) => `<button type="button" class="chip ${C.audience[name].includes(x.id ?? x) ? "active" : ""}" data-v="${esc(x.id ?? x)}">${esc(lbl(x))}</button>`).join("") || '<span class="muted small">لا يوجد</span>'}</div>`;
  const render = async () => {
    const s = C.step;
    let body = "";
    if (s === 1) body = `<div class="form-grid"><label class="full">اسم الحملة<input data-f="name" value="${esc(C.name)}" placeholder="مثال: إعلان دورة أكتوبر" /></label>
      <label class="full">رقم الإرسال<select data-f="accountId">${m.accounts.map((a) => `<option value="${a.id}" ${a.id === C.accountId ? "selected" : ""}>${esc(a.label)} ${a.status === "connected" ? "✅" : "⚠️ غير متصل"}</option>`).join("")}</select></label>
      <label>التأخير بين الرسائل (ثوانٍ)<input data-f="delaySec" type="number" min="3" value="${C.delayMs / 1000}" /><div class="field-hint">الأعلى أكثر أمانًا من الحظر. يُضاف تفاوت عشوائي تلقائيًا.</div></label></div>`;
    if (s === 2) body = `<p class="muted small">اختر من يستقبل الحملة (يمكن الجمع بين أكثر من معيار):</p>
      ${C.audience.contactIds.length ? `<p><span class="badge primary">عملاء محددون: ${C.audience.contactIds.length}</span> <button class="btn small ghost" data-clear-ids>إلغاء</button></p>` : ""}
      <label>القوائم</label>${multi("listIds", m.lists, (l) => `${l.name} (${l.count})`)}<label style="margin-top:10px">الوسوم</label>${multi("tagIds", m.tags, (t) => `${t.name} (${t.count})`)}
      <label style="margin-top:10px">التصنيفات</label>${multi("categories", m.categories, catLabel)}<label style="margin-top:10px">المصادر</label>${multi("sources", m.sources, srcLabel)}
      <label style="margin-top:10px">الموظف المسؤول</label>${multi("assignedTo", m.users.filter((u) => u.active), (u) => u.name)}
      <label style="margin-top:10px">استبعاد من يحمل الوسم</label>${multi("excludeTagIds", m.tags, (t) => t.name)}`;
    if (s === 3) {
      body = skeleton(3);
      api("/campaigns/audience", { method: "POST", body: { audience: C.audience } }).then((r) => {
        C.summary = r.summary;
        $("[data-body]", view).innerHTML = `<div class="audience-summary">${[["إجمالي", r.summary.total], ["مؤهلون للإرسال", r.summary.eligible, "good"], ["مستبعدون", r.summary.excluded], ["بدون موافقة", r.summary.optOut], ["أرقام غير صحيحة", r.summary.invalid], ["مكررون", r.summary.duplicates], ["محظورون", r.summary.blocked]].map(([l, v, c]) => `<div class="stat ${c || ""}"><div class="lbl">${l}</div><div class="val">${v}</div></div>`).join("")}</div>
          ${r.excluded.length ? `<details style="margin-top:10px"><summary class="small">عرض المستبعدين (${r.excluded.length} الأوائل)</summary><table class="table"><tbody>${r.excluded.map((x) => `<tr><td>${esc(x.name || "—")}</td><td class="ltr">${esc(fmtPhone(x.phone))}</td><td><span class="badge warn">${REASON[x.reason] || x.reason}</span></td></tr>`).join("")}</tbody></table></details>` : ""}
          ${!r.summary.eligible ? '<p class="form-error">لا يوجد مستلمون مؤهلون — عدّل الجمهور.</p>' : ""}`;
      }).catch(toastErr);
    }
    if (s === 4) body = `<div class="form-grid"><label class="full">قالب جاهز (اختياري)<select data-tpl><option value="">— بدون —</option>${templates.map((t) => `<option value="${t.id}" ${t.id === C.templateId ? "selected" : ""}>${esc(t.title)}${t.kind === "campaign" ? " (حملة)" : ""}</option>`).join("")}</select></label>
      <label class="full">نص الرسالة<textarea data-f="messageText" rows="6" placeholder="مرحبًا {{name}}…">${esc(C.messageText)}</textarea><div class="field-hint">المتغيرات: {{name}} الاسم · {{first_name}} الاسم الأول · {{company}} الشركة</div></label>
      <label class="full">مرفق (صورة/فيديو/ملف — اختياري)<input type="file" data-media accept="image/*,video/*,.pdf,.docx,.xlsx" />${C.media ? `<div class="small">📎 ${esc(C.media.fileName)} <button class="btn small ghost" data-rm-media>إزالة</button></div>` : ""}</label></div>`;
    if (s === 5) body = `<p class="muted small">هكذا ستظهر الرسالة للعميل:</p><div class="preview-bubble">${esc(C.messageText.replace(/\{\{\s*(name|first_name)\s*\}\}/g, "أحمد").replace(/\{\{\s*company\s*\}\}/g, "شركة النور").replace(/\{\{\s*phone\s*\}\}/g, "9665xxxxxxxx")) || '<span class="muted">(لا يوجد نص)</span>'}${C.media ? `<div class="small muted" style="margin-top:6px">📎 ${esc(C.media.fileName)}</div>` : ""}</div>`;
    if (s === 6) body = `<div class="audience-summary">${[["إجمالي الجمهور", C.summary?.total ?? "—"], ["سيُرسل إلى", C.summary?.eligible ?? "—", "good"], ["مستبعدون", C.summary?.excluded ?? "—"]].map(([l, v, c]) => `<div class="stat ${c || ""}"><div class="lbl">${l}</div><div class="val">${v}</div></div>`).join("")}</div>
      <div class="form-grid" style="margin-top:14px"><label>الإرسال<select data-when><option value="now">الآن</option><option value="later">جدولة</option></select></label><label>موعد الجدولة<input type="datetime-local" data-at disabled /></label></div>
      <p class="muted small">الوقت التقديري: ~${Math.ceil(((C.summary?.eligible || 0) * C.delayMs) / 60000)} دقيقة.</p>`;
    view.innerHTML = `<div class="page-head"><h1>حملة جديدة</h1><a class="btn" href="#/campaigns">رجوع</a></div>
      <div class="steps">${steps.map((t, i) => `<span class="s ${i + 1 === s ? "cur" : i + 1 < s ? "done" : ""}">${i + 1}. ${t}</span>`).join("")}</div>
      <div class="card"><div class="card-body" data-body>${body}</div><div class="modal-foot">${s > 1 ? `<button class="btn" data-prev>السابق</button>` : ""}${s < 6 ? `<button class="btn primary" data-next>التالي</button>` : can("send_campaign") ? `<button class="btn primary" data-launch>🚀 تأكيد وبدء الإرسال</button>` : '<span class="muted">تحتاج صلاحية إرسال الحملات</span>'}<button class="btn ghost" data-save-draft>حفظ كمسودة</button></div></div>`;
    $$("[data-multi]", view).forEach((g) => g.addEventListener("click", (e) => { const b = e.target.closest("[data-v]"); if (!b) return; b.classList.toggle("active"); C.audience[g.dataset.multi] = $$("[data-v].active", g).map((x) => x.dataset.v); }));
    $("[data-clear-ids]", view)?.addEventListener("click", () => { C.audience.contactIds = []; render(); });
    $("[data-tpl]", view)?.addEventListener("change", (e) => { const t = templates.find((x) => x.id === e.target.value); C.templateId = e.target.value; if (t) { C.messageText = t.text; $("[data-f=messageText]", view).value = t.text; } });
    $("[data-media]", view)?.addEventListener("change", async (e) => { const f = e.target.files[0]; if (!f) return; const fd = new FormData(); fd.append("file", f); try { C.media = await api("/campaigns/media", { method: "POST", form: fd }); render(); } catch (err) { toastErr(err); } });
    $("[data-rm-media]", view)?.addEventListener("click", () => { C.media = null; render(); });
    $("[data-when]", view)?.addEventListener("change", (e) => { $("[data-at]", view).disabled = e.target.value !== "later"; });
    const collect = () => { $$("[data-f]", view).forEach((x) => { if (x.dataset.f === "delaySec") C.delayMs = Math.max(Number(x.value) || 4, 3) * 1000; else C[x.dataset.f] = x.value; }); };
    const saveDraft = async () => { collect(); const r = await api("/campaigns", { method: "POST", body: { ...C, id: C.id || undefined } }); C.id = r.id; return r; };
    $("[data-next]", view)?.addEventListener("click", async () => {
      collect();
      if (s === 1 && !C.name.trim()) return toast("اكتب اسم الحملة", "err");
      if (s === 2 && !Object.values(C.audience).some((a) => a.length)) return toast("اختر جمهورًا واحدًا على الأقل", "err");
      if (s === 3 && !C.summary?.eligible) return toast("لا يوجد مستلمون مؤهلون", "err");
      if (s === 4 && !C.messageText.trim() && !C.media) return toast("اكتب نص الرسالة أو أرفق ملفًا", "err");
      C.step++; render();
    });
    $("[data-prev]", view)?.addEventListener("click", () => { collect(); C.step--; render(); });
    $("[data-save-draft]", view)?.addEventListener("click", async () => { try { await saveDraft(); toast("حُفظت المسودة", "ok"); navigate("#/campaigns"); } catch (e) { toastErr(e); } });
    $("[data-launch]", view)?.addEventListener("click", async () => {
      const later = $("[data-when]", view).value === "later"; const at = later ? new Date($("[data-at]", view).value).getTime() : null;
      if (later && !(at > Date.now())) return toast("حدد موعدًا مستقبليًا", "err");
      if (!await confirm({ title: later ? "جدولة الحملة" : "بدء الإرسال", text: `سيتم الإرسال إلى ${C.summary?.eligible} عميل${later ? " في " + fmtDateTime(at) : " الآن"}. هل أنت متأكد؟`, okText: later ? "جدولة" : "إرسال" })) return;
      try { const r = await saveDraft(); await api(`/campaigns/${r.id}/start`, { method: "POST", body: { scheduledAt: at } }); toast(later ? "تمت الجدولة" : "بدأ الإرسال", "ok"); navigate(`#/campaigns/${r.id}`); } catch (e) { toastErr(e); }
    });
  };
  render();
}

// ---------- التقرير ----------
async function report(view, id) {
  let rp = 1, rs = "";
  const draw = async () => {
    try {
      const { campaign: c, stats: s } = await api(`/campaigns/${id}`);
      const sentAll = s.sent + s.delivered + s.read; const pct = (n) => (s.total ? Math.round((n / s.total) * 100) : 0);
      view.innerHTML = `<div class="page-head"><div><h1>${esc(c.name)} <span class="badge ${ST[c.status]?.[1] || ""}">${ST[c.status]?.[0] || c.status}</span></h1><div class="muted small">عبر ${esc(c.accountLabel || "")} · أنشأها ${esc(c.createdByName || "")} · ${fmtDateTime(c.createdAt)}${c.scheduledAt ? " · مجدولة: " + fmtDateTime(c.scheduledAt) : ""}</div></div>
        <div class="actions"><a class="btn" href="#/campaigns">رجوع</a>
          ${can("send_campaign") && (c.status === "running" || c.status === "scheduled") ? `<button class="btn" data-pause>⏸ إيقاف</button>` : ""}
          ${can("send_campaign") && c.status === "paused" ? `<button class="btn primary" data-resume>▶ استئناف</button>` : ""}
          ${can("send_campaign") && s.failed && ["done", "paused"].includes(c.status) ? `<button class="btn" data-retry>🔁 إعادة محاولة الفاشل (${s.failed})</button>` : ""}
          ${can("create_campaign") && c.status !== "running" ? `<button class="btn danger" data-del>حذف</button>` : ""}</div></div>
        <div class="stats">${[["إجمالي الجمهور", s.total], ["في الانتظار", s.pending + s.queued], ["أُرسلت", sentAll], ["وصلت", s.delivered + s.read], ["قُرئت", s.read], ["فشلت", s.failed, s.failed ? "bad" : ""], ["مستبعدون", s.skipped]].map(([l, v, cls]) => `<div class="stat ${cls || ""}"><div class="lbl">${l}</div><div class="val">${v}</div></div>`).join("")}</div>
        <div class="card" style="margin-bottom:14px"><div class="card-body"><div class="progress"><i style="width:${pct(s.read)}%;background:var(--good)"></i><i style="width:${pct(s.delivered)}%;background:var(--series-3)"></i><i style="width:${pct(s.sent)}%;background:var(--series-1)"></i><i style="width:${pct(s.failed)}%;background:var(--bad)"></i></div>
          <div class="legend" style="padding:8px 0 0"><span><i style="background:var(--good)"></i>قُرئت</span><span><i style="background:var(--series-3)"></i>وصلت</span><span><i style="background:var(--series-1)"></i>أُرسلت</span><span><i style="background:var(--bad)"></i>فشلت</span></div>
          <div class="preview-bubble" style="margin-top:10px">${esc(c.messageText)}</div></div></div>
        <div class="card"><div class="card-head"><h3>المستلمون</h3><select data-rs style="width:auto"><option value="">الكل</option>${Object.entries(RS).map(([k, [l]]) => `<option value="${k}" ${k === rs ? "selected" : ""}>${l}</option>`).join("")}</select></div><div class="table-wrap" data-rtable>${skeleton(4)}</div><div data-rpager></div></div>`;
      $("[data-rs]", view).onchange = (e) => { rs = e.target.value; rp = 1; loadRecipients(); };
      $("[data-pause]", view)?.addEventListener("click", async () => { try { await api(`/campaigns/${id}/pause`, { method: "POST" }); draw(); } catch (e) { toastErr(e); } });
      $("[data-resume]", view)?.addEventListener("click", async () => { try { await api(`/campaigns/${id}/start`, { method: "POST" }); draw(); } catch (e) { toastErr(e); } });
      $("[data-retry]", view)?.addEventListener("click", async () => { if (await confirm({ title: "إعادة المحاولة", text: "ستُعاد محاولة الإرسال للفاشلين الذين لم تُسجَّل لهم رسالة مُرسلة فقط (بدون تكرار).", okText: "إعادة" })) { try { const r = await api(`/campaigns/${id}/retry`, { method: "POST" }); toast(`أُعيد ${r.retried} إلى الطابور`, "ok"); draw(); } catch (e) { toastErr(e); } } });
      $("[data-del]", view)?.addEventListener("click", async () => { if (await confirm({ title: "حذف الحملة", text: "حذف الحملة وتقريرها نهائيًا؟", danger: true, okText: "حذف" })) { try { await api(`/campaigns/${id}`, { method: "DELETE" }); navigate("#/campaigns"); } catch (e) { toastErr(e); } } });
      loadRecipients();
    } catch (e) { view.innerHTML = empty("تعذر فتح الحملة", e.message, "⚠️"); }
  };
  async function loadRecipients() {
    if (!can("view_campaign_reports")) { $("[data-rtable]", view).innerHTML = empty("تحتاج صلاحية عرض تقارير الحملات", "", "🔒"); return; }
    try {
      const r = await api(`/campaigns/${id}/recipients${qs({ page: rp, limit: 50, status: rs })}`);
      $("[data-rtable]", view).innerHTML = r.rows.length ? `<table class="table"><thead><tr><th>الاسم</th><th>الجوال</th><th>الحالة</th><th>السبب</th><th>وقت الإرسال</th></tr></thead><tbody>${r.rows.map((x) => `<tr><td>${x.contact_id ? `<a href="#/contacts/${x.contact_id}">${esc(x.name || "—")}</a>` : esc(x.name || "—")}</td><td class="ltr">${esc(fmtPhone(x.phone))}</td><td><span class="badge ${RS[x.status]?.[1] || ""}">${RS[x.status]?.[0] || x.status}</span></td><td class="small muted">${esc(REASON[x.reason] || x.reason || "")}</td><td class="nowrap">${fmtDateTime(x.sent_at)}</td></tr>`).join("")}</tbody></table>` : empty("لا يوجد مستلمون", "", "📭");
      $("[data-rpager]", view).replaceChildren(pager(r, (p) => { rp = p; loadRecipients(); }));
    } catch (e) { toastErr(e); }
  }
  const onUpd = (e) => { if (e.detail.campaign?.id === id) { clearTimeout(onUpd.t); onUpd.t = setTimeout(draw, 1500); } };
  bus.addEventListener("campaign:update", onUpd);
  await draw();
  return { destroy: () => bus.removeEventListener("campaign:update", onUpd) };
}
