// الإقلاع: المصادقة، البيانات المرجعية، التوجيه، البحث الشامل، الأحداث اللحظية
import { state, $, $$, api, esc, can, toast, toastErr, debounce, h, fmtPhone, avatar } from "./core.js";
import { openContactForm } from "./pages/contacts.js";
import { openLeads } from "./pages/leads.js";

const pages = {
  dashboard: { title: "الرئيسية", ico: "🏠", load: () => import("./pages/dashboard.js") },
  inbox: { title: "المحادثات", ico: "💬", load: () => import("./pages/inbox.js"), full: true, perm: ["view_all_conversations", "view_assigned_conversations"] },
  contacts: { title: "العملاء", ico: "👥", load: () => import("./pages/contacts.js"), perm: ["view_all_contacts", "view_assigned_contacts"] },
  lists: { title: "القوائم والتصنيفات", ico: "🏷️", load: () => import("./pages/lists.js"), perm: ["manage_tags"] },
  campaigns: { title: "الرسائل الجماعية", ico: "📣", load: () => import("./pages/campaigns.js"), perm: ["create_campaign", "send_campaign", "view_campaign_reports"] },
  templates: { title: "القوالب", ico: "📝", load: () => import("./pages/templates.js") },
  tasks: { title: "المهام والمتابعات", ico: "✅", load: () => import("./pages/tasks.js") },
  users: { title: "المستخدمون", ico: "🧑‍💼", load: () => import("./pages/users.js"), perm: ["manage_users"] },
  roles: { title: "الصلاحيات", ico: "🔐", load: () => import("./pages/roles.js"), perm: ["manage_roles"] },
  reports: { title: "التقارير", ico: "📊", load: () => import("./pages/reports.js"), perm: ["view_reports"] },
  settings: { title: "الإعدادات", ico: "⚙️", load: () => import("./pages/settings.js"), perm: ["manage_settings"] },
  whatsapp: { title: "إعدادات WhatsApp", ico: "📱", load: () => import("./pages/whatsapp.js"), perm: ["manage_whatsapp"] },
};
const allowed = (p) => !p.perm || p.perm.some(can);

// ---------- التوجيه ----------
let current = null;
export function navigate(hash) { location.hash = hash; }
async function route() {
  const [name, ...rest] = location.hash.replace(/^#\/?/, "").split("/");
  const page = pages[name] && allowed(pages[name]) ? name : "dashboard";
  const view = $("#view");
  $$("#nav a").forEach((a) => a.classList.toggle("active", a.dataset.page === page));
  document.title = `${pages[page].title} · WhatsApp Hub`;
  document.body.classList.remove("nav-open");
  if (current?.destroy) current.destroy();
  view.className = `view ${pages[page].full ? "full" : ""}`;
  view.innerHTML = pages[page].full ? "" : '<div class="sk-rows"><div><div class="skeleton"></div></div><div><div class="skeleton"></div></div></div>';
  try {
    const mod = await pages[page].load();
    current = await mod.render(view, rest.map(decodeURIComponent));
  } catch (e) { console.error(e); view.innerHTML = `<div class="empty"><div class="ico">⚠️</div><h4>تعذر تحميل الصفحة</h4><div>${esc(e.message)}</div></div>`; }
}
window.addEventListener("hashchange", route);

function renderNav() {
  const groups = [["", ["dashboard", "inbox", "contacts", "lists", "campaigns", "templates", "tasks"]], ["الإدارة", ["users", "roles", "reports", "settings", "whatsapp"]]];
  $("#nav").innerHTML = groups.map(([g, keys]) => {
    const items = keys.filter((k) => allowed(pages[k])).map((k) => `<a href="#/${k}" data-page="${k}"><span class="ico">${pages[k].ico}</span><span>${pages[k].title}</span>${k === "inbox" ? '<span class="count hidden" id="nav-unread"></span>' : ""}</a>`).join("");
    return items ? `${g ? `<div class="nav-group">${g}</div>` : ""}${items}` : "";
  }).join("");
  $("#me").innerHTML = `<b>${esc(state.me.name)}</b><span>${esc(state.me.roleName)}</span>`;
  $("#btn-add-contact").classList.toggle("hidden", !can("create_contact"));
}

// ---------- البيانات المرجعية ----------
export async function loadMeta() {
  state.meta = await api("/meta");
  state.me = state.meta.me; state.perms = new Set(state.meta.permissions);
  return state.meta;
}

// ---------- البحث الشامل ----------
const sr = $("#search-results");
const doSearch = debounce(async (q) => {
  if (q.length < 2) return sr.classList.add("hidden");
  try {
    const r = await api(`/search?q=${encodeURIComponent(q)}`);
    const items = [
      ...(r.contacts.length ? ['<div class="grp">العملاء</div>', ...r.contacts.map((c) => `<div class="it" data-go="#/contacts/${c.id}">${avatar(c.name || c.phone, "sm")}<div><div>${esc(c.name || "بدون اسم")}</div><div class="sub ltr">${esc(fmtPhone(c.phone))}${c.company ? " · " + esc(c.company) : ""}</div></div></div>`)] : []),
      ...(r.conversations.length ? ['<div class="grp">المحادثات</div>', ...r.conversations.map((c) => `<div class="it" data-go="#/inbox/${c.ref}">${avatar(c.title, "sm")}<div><div>${esc(c.title)}</div><div class="sub truncate">${esc(c.lastMessage || "")}</div></div></div>`)] : []),
    ];
    sr.innerHTML = items.length ? items.join("") : '<div class="grp">لا توجد نتائج</div>';
    sr.classList.remove("hidden");
  } catch (e) { toastErr(e); }
}, 350);
$("#global-search").addEventListener("input", (e) => doSearch(e.target.value.trim()));
$("#global-search").addEventListener("focus", (e) => e.target.value.trim().length >= 2 && sr.classList.remove("hidden"));
document.addEventListener("click", (e) => { if (!e.target.closest(".search-wrap")) sr.classList.add("hidden"); const it = e.target.closest("[data-go]"); if (it) { navigate(it.dataset.go); sr.classList.add("hidden"); $("#global-search").value = ""; } });
document.addEventListener("keydown", (e) => { if (e.key === "/" && !/input|textarea/i.test(e.target.tagName)) { e.preventDefault(); $("#global-search").focus(); } });

// ---------- الأحداث اللحظية ----------
export const bus = new EventTarget();
function connectSocket() {
  const s = io({ transports: ["websocket", "polling"] });
  state.socket = s;
  for (const ev of ["account:update", "account:removed", "chat:update", "message:new", "message:status", "message:media", "history:synced", "chat:assigned", "lead:new", "campaign:update", "email:status"]) {
    s.on(ev, (data) => bus.dispatchEvent(new CustomEvent(ev, { detail: data })));
  }
  s.on("chat:assigned", ({ chat, by }) => toast(`👤 ${by} أسند إليك محادثة: ${chat.name || chat.phone}`));
  s.on("lead:new", (lead) => { state.leadsNew++; updateLeadsBadge(); toast(`🔔 استفسار جديد من ${lead.fromName || lead.from}`); });
  s.on("connect_error", (e) => { if (e.message === "unauthorized") location.reload(); });
}
export function updateLeadsBadge(n) {
  if (n !== undefined) state.leadsNew = n;
  const b = $("#leads-badge"); b.textContent = state.leadsNew; b.classList.toggle("hidden", !state.leadsNew);
}
export async function refreshUnread() {
  try { const d = await api("/dashboard/summary"); const el = $("#nav-unread"); if (el) { el.textContent = d.conversations.unread; el.classList.toggle("hidden", !d.conversations.unread); } } catch {}
}
bus.addEventListener("message:new", (e) => { if (!e.detail.message.fromMe) refreshUnread(); });
bus.addEventListener("chat:update", () => refreshUnread());

// ---------- المصادقة ----------
async function authForm(form, path) {
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("[data-error]", form); err.textContent = "";
    const btn = $("button", form); btn.disabled = true;
    try { await api(path, { method: "POST", body: Object.fromEntries(new FormData(form).entries()) }); location.reload(); }
    catch (ex) { err.textContent = ex.message; btn.disabled = false; }
  });
}
authForm($("#login-form"), "/login"); authForm($("#setup-form"), "/setup");
$("#btn-logout").addEventListener("click", async () => { await fetch("/api/logout", { method: "POST" }); location.href = "/"; });
$("#btn-nav").addEventListener("click", () => document.body.classList.add("nav-open"));
$$("[data-close-nav]").forEach((el) => el.addEventListener("click", () => document.body.classList.remove("nav-open")));
$("#btn-add-contact").addEventListener("click", () => openContactForm());
$("#btn-leads").addEventListener("click", () => openLeads());

(async function boot() {
  const auth = await fetch("/api/auth").then((r) => r.json()).catch(() => null);
  if (!auth) return toast("تعذر الاتصال بالخادم", "err");
  if (auth.setupRequired) { $("#auth-screen").classList.remove("hidden"); $("#login-form").classList.add("hidden"); $("#setup-form").classList.remove("hidden"); return; }
  if (!auth.user) { $("#auth-screen").classList.remove("hidden"); return; }
  await loadMeta();
  renderNav();
  $("#app").classList.remove("hidden");
  connectSocket();
  refreshUnread();
  try { const l = await api("/leads?status=new&limit=1"); updateLeadsBadge(l.total); } catch {}
  route();
})();
