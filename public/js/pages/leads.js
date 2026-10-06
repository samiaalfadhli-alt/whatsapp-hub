// الاستفسارات (تنبيهات الكلمات المفتاحية) — نافذة جانبية
import { state, $, $$, api, qs, esc, h, toast, toastErr, drawer, fmtDateTime, empty, skeleton } from "../core.js";
import { navigate, updateLeadsBadge } from "../app.js";

export async function openLeads() {
  const d = drawer({ title: "🔔 الاستفسارات", size: "lg", body: `<div class="chips" style="margin-bottom:12px">${[["new", "جديدة"], ["contacted", "تم التواصل"], ["done", "منتهية"], ["all", "الكل"]].map(([k, l]) => `<button class="chip ${k === "new" ? "active" : ""}" data-f="${k}">${l}</button>`).join("")}</div><div data-list>${skeleton()}</div>`, foot: null });
  let f = "new";
  async function load() {
    try {
      const r = await api(`/leads${qs({ status: f, limit: 100 })}`);
      if (f === "new") updateLeadsBadge(r.total);
      $("[data-list]", d.body).innerHTML = r.rows.length ? r.rows.map((l) => `<div class="card" style="margin-bottom:8px"><div class="card-body" style="padding:12px 14px">
        <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap"><b>${esc(l.fromName || l.from)} <span class="badge ${l.channel === "whatsapp" ? "primary" : "accent"}">${l.channel === "whatsapp" ? "واتساب · " + esc(l.accountLabel || "") : "إيميل"}</span></b><span class="muted small">${fmtDateTime(l.timestamp)}</span></div>
        <div class="small muted">الكلمات: ${esc(l.matched.join("، "))} · ${l.notified ? "📧 تم التنبيه" : l.notifyError ? "⚠️ " + esc(l.notifyError) : "بدون إيميل"}</div>
        ${l.subject ? `<div><b>${esc(l.subject)}</b></div>` : ""}<div style="white-space:pre-wrap;margin:6px 0">${esc((l.text || "").slice(0, 300))}</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">${l.contactId ? `<a class="btn small" href="#/contacts/${l.contactId}" data-nav>ملف العميل</a>` : ""}${l.channel === "email" ? `<a class="btn small" href="mailto:${esc(l.from)}">رد بالإيميل</a>` : ""}
          ${l.status !== "contacted" ? `<button class="btn small" data-st="contacted" data-id="${l.id}">تم التواصل</button>` : ""}${l.status !== "done" ? `<button class="btn small" data-st="done" data-id="${l.id}">إنهاء</button>` : `<button class="btn small" data-st="new" data-id="${l.id}">إعادة فتح</button>`}</div></div></div>`).join("") : empty("لا توجد استفسارات", "", "🔔");
    } catch (e) { toastErr(e); }
  }
  d.body.addEventListener("click", async (e) => {
    const c = e.target.closest("[data-f]"); if (c) { $$("[data-f]", d.body).forEach((x) => x.classList.toggle("active", x === c)); f = c.dataset.f; return load(); }
    const b = e.target.closest("[data-st]"); if (b) { try { await api(`/leads/${b.dataset.id}`, { method: "PATCH", body: { status: b.dataset.st } }); load(); } catch (err) { toastErr(err); } }
    if (e.target.closest("[data-nav]")) d.close();
  });
  load();
}
