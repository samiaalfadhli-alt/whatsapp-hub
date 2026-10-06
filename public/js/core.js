// النواة: API، الحالة، المكوّنات المشتركة (Toast/Modal/Drawer/Confirm/Table)، أدوات
export const state = { me: null, meta: null, perms: new Set(), socket: null, leadsNew: 0 };
export const $ = (s, root = document) => root.querySelector(s);
export const $$ = (s, root = document) => [...root.querySelectorAll(s)];
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export const can = (p) => state.me?.isSuper || state.perms.has(p);
export const debounce = (fn, ms = 300) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
export const h = (html) => { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild; };

// ---------- API ----------
export class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }
export async function api(path, { method = "GET", body, form, signal } = {}) {
  const opts = { method, signal, headers: {} };
  if (form) opts.body = form; else if (body !== undefined) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
  let res;
  try { res = await fetch(`/api${path}`, opts); } catch (e) { if (e.name === "AbortError") throw e; throw new ApiError(0, "تعذر الاتصال بالخادم. تحقق من اتصالك بالإنترنت"); }
  if (res.status === 401) { location.reload(); throw new ApiError(401, "انتهت الجلسة"); }
  const ct = res.headers.get("content-type") || "";
  const data = ct.includes("json") ? await res.json().catch(() => ({})) : await res.text();
  if (!res.ok) throw new ApiError(res.status, data?.error || (res.status === 403 ? "لا تملك صلاحية لهذا الإجراء" : res.status === 404 ? "العنصر غير موجود" : "حدث خطأ غير متوقع"));
  return data;
}
export const qs = (o) => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(o || {})) if (v !== undefined && v !== null && v !== "") p.set(k, v); const s = p.toString(); return s ? `?${s}` : ""; };

// ---------- تنسيق ----------
export const LOCALE = "ar-SA-u-ca-gregory-nu-latn"; // تقويم ميلادي وأرقام لاتينية
const rtf = new Intl.RelativeTimeFormat("ar", { numeric: "auto" });
export function fmtTime(ts) {
  if (!ts) return "";
  const d = new Date(ts); const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString(LOCALE, { day: "numeric", month: "short" });
}
export const fmtDate = (ts) => (ts ? new Date(ts).toLocaleDateString(LOCALE, { year: "numeric", month: "short", day: "numeric" }) : "—");
export const fmtDateTime = (ts) => (ts ? new Date(ts).toLocaleString(LOCALE, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
export function fmtAgo(ts) { if (!ts) return "—"; const m = Math.round((ts - Date.now()) / 60000); if (Math.abs(m) < 60) return rtf.format(m, "minute"); const hh = Math.round(m / 60); if (Math.abs(hh) < 24) return rtf.format(hh, "hour"); return rtf.format(Math.round(hh / 24), "day"); }
export const fmtSize = (b) => (!b ? "" : b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(0)} KB` : `${(b / 1048576).toFixed(1)} MB`);
export const fmtPhone = (p) => (p ? (p.includes("*") ? p : `+${p}`) : "");
export const initials = (name) => (name || "?").trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";
export const avatar = (name, cls = "") => `<span class="avatar ${cls}">${esc(initials(name))}</span>`;
export const CONV_STATUS = { new: ["جديدة", "accent"], waiting: ["بانتظار الرد", "warn"], replied: ["تم الرد", "good"], closed: ["مغلقة", ""] };
export const MSG_STATUS = { pending: ["🕓", "في الانتظار"], queued: ["🕓", "في الانتظار"], sent: ["✓", "أُرسلت"], delivered: ["✓✓", "وصلت"], read: ["✓✓", "قُرئت"], played: ["✓✓", "قُرئت"], failed: ["⚠", "فشلت"], error: ["⚠", "فشلت"], received: ["", ""] };
export const userName = (id) => state.meta?.users.find((u) => u.id === id)?.name || "";
export const catLabel = (c) => state.meta?.categoryLabels?.[c] || c || "—";
export const SOURCE_AR = { whatsapp: "واتساب", website: "الموقع", referral: "إحالة", ads: "إعلانات", import: "استيراد", manual: "يدوي", other: "أخرى" };
export const srcLabel = (s) => SOURCE_AR[s] || s || "—";

// ---------- Toast ----------
export function toast(msg, type = "") {
  const el = h(`<div class="toast ${type}">${esc(msg)}</div>`);
  $("#toast-root").appendChild(el);
  setTimeout(() => el.remove(), type === "err" ? 5000 : 3200);
}
export const toastErr = (e) => toast(e?.message || String(e), "err");

// ---------- Modal / Drawer ----------
function layer(root, { title, body, foot, size = "", drawer = false, onClose }) {
  const el = h(`<div class="${drawer ? "drawer-wrap" : ""}"><div class="overlay"><div class="${drawer ? "drawer" : "modal"} ${size}" role="dialog" aria-modal="true">
    <div class="modal-head"><h3>${esc(title)}</h3><button class="icon-btn" data-close aria-label="إغلاق">✕</button></div>
    <div class="modal-body"></div>${foot !== null ? '<div class="modal-foot"></div>' : ""}</div></div></div>`);
  const bodyEl = $(".modal-body", el); const footEl = $(".modal-foot", el);
  if (typeof body === "string") bodyEl.innerHTML = body; else if (body) bodyEl.appendChild(body);
  if (footEl && foot) { if (typeof foot === "string") footEl.innerHTML = foot; else footEl.appendChild(foot); }
  const close = () => { el.remove(); document.removeEventListener("keydown", onKey); onClose?.(); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  el.addEventListener("click", (e) => { if (e.target.matches("[data-close]") || e.target.classList.contains("overlay")) close(); });
  root.appendChild(el);
  setTimeout(() => $("input, textarea, select", bodyEl)?.focus(), 30);
  return { el, body: bodyEl, foot: footEl, close };
}
export const modal = (o) => layer($("#modal-root"), o);
export const drawer = (o) => layer($("#drawer-root"), { ...o, drawer: true });
export function confirm({ title = "تأكيد", text, okText = "تأكيد", danger = false }) {
  return new Promise((resolve) => {
    const m = modal({ title, body: `<p class="confirm-text">${esc(text)}</p>`, foot: `<button class="btn ${danger ? "danger" : "primary"}" data-ok>${esc(okText)}</button><button class="btn" data-close>إلغاء</button>`, onClose: () => resolve(false) });
    $("[data-ok]", m.foot).onclick = () => { resolve(true); m.el.remove(); };
  });
}
export function prompt({ title, label, value = "", okText = "حفظ" }) {
  return new Promise((resolve) => {
    const m = modal({ title, body: `<label>${esc(label)}<input data-v value="${esc(value)}" /></label>`, foot: `<button class="btn primary" data-ok>${esc(okText)}</button><button class="btn" data-close>إلغاء</button>`, onClose: () => resolve(null) });
    const ok = () => { resolve($("[data-v]", m.body).value); m.el.remove(); };
    $("[data-ok]", m.foot).onclick = ok; $("[data-v]", m.body).onkeydown = (e) => e.key === "Enter" && ok();
  });
}
export function openViewer(src) { const v = $("#viewer"); $("img", v).src = src; v.classList.remove("hidden"); }
$("#viewer")?.addEventListener("click", () => $("#viewer").classList.add("hidden"));

// ---------- حالات العرض ----------
export const skeleton = (n = 6) => `<div class="sk-rows">${Array.from({ length: n }, () => '<div><div class="skeleton"></div></div>').join("")}</div>`;
export const empty = (title, sub = "", ico = "📭", action = "") => `<div class="empty"><div class="ico">${ico}</div><h4>${esc(title)}</h4><div>${esc(sub)}</div>${action}</div>`;

// ---------- الترقيم ----------
export function pager({ page, limit, total }, onPage) {
  const pages = Math.max(Math.ceil(total / limit), 1);
  const from = total ? (page - 1) * limit + 1 : 0; const to = Math.min(page * limit, total);
  const btns = []; const push = (p, lbl = p) => btns.push(`<button class="btn small ${p === page ? "primary" : ""}" data-p="${p}" ${p === page ? "disabled" : ""}>${lbl}</button>`);
  if (pages <= 7) for (let p = 1; p <= pages; p++) push(p);
  else { push(1); if (page > 3) btns.push("<span>…</span>"); for (let p = Math.max(2, page - 1); p <= Math.min(pages - 1, page + 1); p++) push(p); if (page < pages - 2) btns.push("<span>…</span>"); push(pages); }
  const el = h(`<div class="pagination"><span>${from}–${to} من ${total}</span><div class="pages"><button class="btn small" data-p="${page - 1}" ${page <= 1 ? "disabled" : ""}>‹</button>${btns.join("")}<button class="btn small" data-p="${page + 1}" ${page >= pages ? "disabled" : ""}>›</button></div></div>`);
  el.addEventListener("click", (e) => { const b = e.target.closest("[data-p]"); if (b && !b.disabled) onPage(Number(b.dataset.p)); });
  return el;
}

// ---------- الوسائط (مكوّن موحّد) ----------
const DOC_ICON = (mime = "", name = "") => (/pdf/.test(mime) || /\.pdf$/i.test(name) ? "📕" : /sheet|excel|csv/.test(mime) || /\.(xlsx?|csv)$/i.test(name) ? "📗" : /word|document/.test(mime) || /\.docx?$/i.test(name) ? "📘" : /zip|rar|7z/.test(mime) ? "🗜️" : "📄");
export function renderMedia(m) {
  const md = m.media; const type = m.mediaType;
  if (!type) return "";
  const stateMsg = { unavailable: "الوسائط غير متوفرة (لم تُنزَّل من السجل)", failed: "تعذر تحميل الوسائط", expired: "انتهت صلاحية الوسائط لدى واتساب", deleted: "حُذفت الوسائط" };
  if (!md?.url || md.state !== "ready") {
    const st = md?.state || "unavailable";
    return `<div class="media"><div class="state ${st === "failed" || st === "expired" ? "bad" : ""}">${st === "loading" ? "⏳ جارٍ التحميل…" : "ℹ️ " + stateMsg[st] || stateMsg.unavailable}</div></div>`;
  }
  const u = esc(md.url); const name = esc(md.fileName || "ملف");
  if (type === "image" || type === "sticker") return `<div class="media"><img src="${u}" alt="" loading="lazy" data-view="${u}" onerror="this.closest('.media').innerHTML='<div class=&quot;state bad&quot;>⚠ تعذر عرض الصورة</div>'" /></div>`;
  if (type === "video") return `<div class="media"><div class="thumb" data-video="${u}">${md.thumbnail ? `<img src="${esc(md.thumbnail)}" alt="" />` : `<video src="${u}#t=0.1" preload="metadata" muted></video>`}<div class="play">▶</div></div></div>`;
  if (type === "audio") return `<div class="media"><audio src="${u}" controls preload="none"></audio></div>`;
  return `<div class="media"><a class="doc" href="${u}?download=${encodeURIComponent(md.fileName || "")}" target="_blank" rel="noopener"><span class="ico">${DOC_ICON(md.mimetype, md.fileName)}</span><span class="info"><span class="name truncate" dir="auto">${name}</span><span class="sub">${esc((md.mimetype || "").split("/")[1]?.toUpperCase().slice(0, 12) || "ملف")} ${md.size ? "· " + fmtSize(md.size) : ""}</span></span><span class="btn small">فتح</span></a></div>`;
}
// تفاعل الوسائط داخل أي حاوية
export function bindMedia(container) {
  container.addEventListener("click", (e) => {
    const img = e.target.closest("[data-view]"); if (img) return openViewer(img.dataset.view);
    const v = e.target.closest("[data-video]"); if (v) { v.outerHTML = `<video src="${v.dataset.video}" controls autoplay playsinline></video>`; }
  });
}

// ---------- تقارير بسيطة (SVG) ----------
export function lineChart(series, { height = 200, labels = [] } = {}) {
  // series: [{name, color, values:[]}]
  const w = 600, hgt = height, padL = 32, padB = 22, padT = 10;
  const max = Math.max(1, ...series.flatMap((s) => s.values));
  const n = Math.max(...series.map((s) => s.values.length), 2);
  const x = (i) => padL + (i * (w - padL - 8)) / (n - 1); const y = (v) => padT + (hgt - padT - padB) * (1 - v / max);
  const ticks = [...new Set([0, Math.round(max / 2), max])];
  const grid = ticks.map((v) => `<line x1="${padL}" x2="${w - 8}" y1="${y(v)}" y2="${y(v)}" stroke="#e3e8ee" stroke-dasharray="3 3"/><text x="${padL - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`).join("");
  const step = Math.ceil(n / 7);
  const xl = labels.map((l, i) => (i % step === 0 || i === n - 1 ? `<text x="${x(i)}" y="${hgt - 4}" text-anchor="middle">${esc(l)}</text>` : "")).join("");
  const paths = series.map((s) => `<path d="${s.values.map((v, i) => `${i ? "L" : "M"}${x(i)},${y(v)}`).join(" ")}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round"/>` +
    s.values.map((v, i) => `<circle cx="${x(i)}" cy="${y(v)}" r="8" fill="transparent" data-tip="${esc(labels[i] || "")} — ${esc(s.name)}: ${v}"/><circle cx="${x(i)}" cy="${y(v)}" r="2.5" fill="${s.color}" pointer-events="none"/>`).join("")).join("");
  return `<div class="chart"><svg viewBox="0 0 ${w} ${hgt}" preserveAspectRatio="none">${grid}${xl}${paths}</svg></div>`;
}
export function barList(rows, { label = "label", value = "count", color = "var(--series-1)" } = {}) {
  const max = Math.max(1, ...rows.map((r) => r[value] || 0));
  if (!rows.length) return empty("لا توجد بيانات بعد", "", "📊");
  return `<div class="bars">${rows.map((r) => `<div class="row"><span class="truncate" title="${esc(r[label])}">${esc(r[label])}</span><div class="bar"><i style="width:${Math.round(((r[value] || 0) / max) * 100)}%;background:${color}"></i></div><span class="n">${r[value] || 0}</span></div>`).join("")}</div>`;
}
let tipEl;
document.addEventListener("mousemove", (e) => {
  const t = e.target.closest?.("[data-tip]");
  if (!t) { tipEl?.remove(); tipEl = null; return; }
  if (!tipEl) { tipEl = h('<div class="tip"></div>'); document.body.appendChild(tipEl); }
  tipEl.textContent = t.dataset.tip; tipEl.style.left = e.clientX + "px"; tipEl.style.top = e.clientY - 8 + "px";
});
