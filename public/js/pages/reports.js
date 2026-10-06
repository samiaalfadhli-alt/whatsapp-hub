// التقارير
import { $, $$, api, esc, can, lineChart, barList, empty, toastErr, catLabel, srcLabel, CONV_STATUS, MSG_STATUS, fmtDateTime, pager, skeleton, LOCALE } from "../core.js";

export async function render(view) {
  let days = 30;
  const draw = async () => {
    view.innerHTML = `<div class="page-head"><h1>التقارير</h1><div class="chips">${[7, 14, 30, 90].map((d) => `<button class="chip ${d === days ? "active" : ""}" data-d="${d}">${d} يومًا</button>`).join("")}</div></div><div data-body>${skeleton()}</div>`;
    $$("[data-d]", view).forEach((b) => b.onclick = () => { days = Number(b.dataset.d); draw(); });
    try {
      const [ser, br] = await Promise.all([api(`/dashboard/series?days=${days}`), api(`/dashboard/breakdowns?days=${days}`)]);
      const labels = ser.contacts.map((d) => new Date(d.date).toLocaleDateString(LOCALE, { day: "numeric", month: "numeric" }));
      const msgSt = br.messageStatuses.map((r) => ({ label: MSG_STATUS[r.label]?.[1] || r.label, count: r.count }));
      $("[data-body]", view).innerHTML = `<div class="grid-2">
        <div class="card"><div class="card-head"><h3>نمو العملاء</h3></div><div class="card-body">${lineChart([{ name: "عملاء جدد", color: "var(--series-1)", values: ser.contacts.map((d) => d.count || 0) }], { labels })}</div></div>
        <div class="card"><div class="card-head"><h3>عدد المحادثات النشطة يوميًا</h3></div><div class="card-body">${lineChart([{ name: "محادثات", color: "var(--series-3)", values: ser.conversations.map((d) => d.count || 0) }], { labels })}</div></div>
        <div class="card"><div class="card-head"><h3>حجم الرسائل</h3></div><div class="card-body">${lineChart([{ name: "مرسلة", color: "var(--series-1)", values: ser.messages.map((d) => d.sent || 0) }, { name: "مستلمة", color: "var(--series-2)", values: ser.messages.map((d) => d.received || 0) }], { labels })}</div><div class="legend"><span><i style="background:var(--series-1)"></i>مرسلة</span><span><i style="background:var(--series-2)"></i>مستلمة</span></div></div>
        <div class="card"><div class="card-head"><h3>حالات الرسائل المرسلة</h3></div><div class="card-body">${barList(msgSt)}</div></div>
        <div class="card"><div class="card-head"><h3>مصادر العملاء</h3></div><div class="card-body">${barList(br.sources.map((r) => ({ ...r, label: srcLabel(r.label) })))}</div></div>
        <div class="card"><div class="card-head"><h3>تصنيفات العملاء</h3></div><div class="card-body">${barList(br.categories.map((r) => ({ ...r, label: catLabel(r.label) })))}</div></div>
        <div class="card"><div class="card-head"><h3>حالات المحادثات</h3></div><div class="card-body">${barList(br.statuses.map((r) => ({ ...r, label: CONV_STATUS[r.label]?.[0] || r.label })))}</div></div>
        <div class="card" style="grid-column:1/-1"><div class="card-head"><h3>أداء الموظفين</h3></div><div class="table-wrap">${br.agents.length ? `<table class="table"><thead><tr><th>الموظف</th><th>رسائل مرسلة</th><th>محادثات مسندة</th><th>محادثات مغلقة</th><th>عملاء مسندون</th></tr></thead><tbody>${br.agents.map((a) => `<tr><td>${esc(a.label)}</td><td>${a.sent}</td><td>${a.conversations}</td><td>${a.closed}</td><td>${a.contacts}</td></tr>`).join("")}</tbody></table>` : empty("لا توجد بيانات", "", "📊")}</div></div>
        ${can("view_audit_log") ? `<div class="card" style="grid-column:1/-1"><div class="card-head"><h3>سجل النشاط</h3></div><div data-audit>${skeleton(4)}</div></div>` : ""}
      </div>`;
      if (can("view_audit_log")) loadAudit(1);
    } catch (e) { toastErr(e); }
  };
  async function loadAudit(page) {
    try {
      const r = await api(`/audit?page=${page}&limit=25`);
      const box = $("[data-audit]", view);
      box.innerHTML = `<div class="table-wrap"><table class="table"><thead><tr><th>الوقت</th><th>المستخدم</th><th>الإجراء</th><th>الهدف</th><th>تفاصيل</th></tr></thead><tbody>${r.rows.map((a) => `<tr><td class="nowrap small">${fmtDateTime(a.created_at)}</td><td>${esc(a.user_name)}</td><td><code class="ltr">${esc(a.action)}</code></td><td class="small muted">${esc(a.target_type)} ${esc(String(a.target_id).slice(0, 8))}</td><td class="small muted ltr" style="text-align:end;max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(JSON.stringify(a.metadata))}</td></tr>`).join("")}</tbody></table></div>`;
      box.appendChild(pager(r, loadAudit));
    } catch (e) { toastErr(e); }
  }
  await draw();
}
