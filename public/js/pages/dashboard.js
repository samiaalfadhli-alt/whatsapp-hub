// الرئيسية: مؤشرات + رسوم مختصرة
import { api, esc, can, lineChart, barList, empty, toastErr, fmtPhone, catLabel, srcLabel, LOCALE } from "../core.js";
import { bus } from "../app.js";

const WA = { connected: ["متصل", "good"], connecting: ["جارٍ الاتصال", "warn"], reconnecting: ["إعادة الاتصال", "warn"], qr: ["بانتظار QR", "warn"], disconnected: ["غير متصل", "bad"], logged_out: ["خرج", "bad"], error: ["خطأ", "bad"] };
const stat = (lbl, val, sub = "", cls = "") => `<div class="stat ${cls}"><div class="lbl">${lbl}</div><div class="val">${val}</div>${sub ? `<div class="sub">${sub}</div>` : ""}</div>`;

export async function render(view) {
  const draw = async () => {
    const [s, ser, br] = await Promise.all([api("/dashboard/summary"), api("/dashboard/series?days=14"), can("view_reports") ? api("/dashboard/breakdowns?days=30") : null]);
    const labels = ser.contacts.map((d) => new Date(d.date).toLocaleDateString(LOCALE, { day: "numeric", month: "numeric" }));
    const wa = s.whatsapp.length ? s.whatsapp.map((a) => `<span class="badge ${WA[a.status]?.[1] || ""}">${esc(a.label)} · ${WA[a.status]?.[0] || a.status}</span>`).join("") : `<span class="muted">لا توجد أرقام مربوطة</span>`;
    view.innerHTML = `
      <div class="page-head"><h1>الرئيسية</h1><div class="wa-status">${wa}</div></div>
      <div class="stats">
        ${stat("إجمالي العملاء", s.contacts.total)}
        ${stat("عملاء جدد اليوم", s.contacts.today, `هذا الأسبوع: ${s.contacts.week}`)}
        ${stat("محادثات نشطة", s.conversations.active, `بانتظار الرد: ${s.conversations.waiting}`)}
        ${stat("رسائل غير مقروءة", s.conversations.unread, "", s.conversations.unread ? "bad" : "")}
        ${stat("مرسلة اليوم", s.messagesToday.sent)}
        ${stat("مستلمة اليوم", s.messagesToday.received)}
        ${stat("فاشلة اليوم", s.messagesToday.failed, "", s.messagesToday.failed ? "bad" : "good")}
        ${stat("موظفون نشطون", s.users.active, `متصلون الآن: ${s.users.online}`)}
        ${stat("مهام مستحقة", s.tasksDue, "خلال 24 ساعة", s.tasksDue ? "bad" : "")}
      </div>
      <div class="grid-2">
        <div class="card"><div class="card-head"><h3>نمو العملاء (14 يومًا)</h3></div><div class="card-body">${lineChart([{ name: "عملاء جدد", color: "var(--series-1)", values: ser.contacts.map((d) => d.count || 0) }], { labels })}</div></div>
        <div class="card"><div class="card-head"><h3>حجم الرسائل (14 يومًا)</h3></div><div class="card-body">${lineChart([{ name: "مرسلة", color: "var(--series-1)", values: ser.messages.map((d) => d.sent || 0) }, { name: "مستلمة", color: "var(--series-2)", values: ser.messages.map((d) => d.received || 0) }], { labels })}</div><div class="legend"><span><i style="background:var(--series-1)"></i>مرسلة</span><span><i style="background:var(--series-2)"></i>مستلمة</span></div></div>
        ${br ? `
        <div class="card"><div class="card-head"><h3>مصادر العملاء</h3></div><div class="card-body">${barList(br.sources.map((r) => ({ ...r, label: srcLabel(r.label) })))}</div></div>
        <div class="card"><div class="card-head"><h3>أداء الموظفين (30 يومًا)</h3><a href="#/reports" class="small">التقرير الكامل</a></div><div class="card-body">${br.agents.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>الموظف</th><th>رسائل مرسلة</th><th>محادثات</th><th>مغلقة</th><th>عملاء</th></tr></thead><tbody>${br.agents.slice(0, 6).map((a) => `<tr><td>${esc(a.label)}</td><td>${a.sent}</td><td>${a.conversations}</td><td>${a.closed}</td><td>${a.contacts}</td></tr>`).join("")}</tbody></table></div>` : empty("لا توجد بيانات بعد", "", "📊")}</div></div>` : ""}
      </div>`;
  };
  try { await draw(); } catch (e) { toastErr(e); view.innerHTML = empty("تعذر تحميل البيانات", e.message, "⚠️"); }
  const onUpd = () => { clearTimeout(onUpd.t); onUpd.t = setTimeout(() => draw().catch(() => {}), 4000); };
  bus.addEventListener("account:update", onUpd); bus.addEventListener("message:new", onUpd);
  return { destroy: () => { bus.removeEventListener("account:update", onUpd); bus.removeEventListener("message:new", onUpd); } };
}
