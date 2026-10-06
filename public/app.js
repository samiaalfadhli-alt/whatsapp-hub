const $ = (s) => document.querySelector(s);
const state = {
  accounts: [],
  chats: [], // مع accountId لكل محادثة
  selectedAccount: null, // null = الصندوق الموحّد
  current: null, // { accountId, chatId }
  search: "",
  qrFor: null,
  me: null, // المستخدم الحالي
  chatFilter: "all", // all | mine | unassigned
  assignees: [],
};
const isAdmin = () => state.me?.role === "admin";

const STATUS_AR = {
  connected: "متصل",
  connecting: "جاري الاتصال…",
  reconnecting: "إعادة الاتصال…",
  qr: "بانتظار مسح QR",
  disconnected: "غير متصل",
  logged_out: "تم تسجيل الخروج",
  error: "خطأ",
};
const TICKS = { pending: "🕓", sent: "✓", delivered: "✓✓", read: "✓✓ 🔵", played: "✓✓ 🔵", failed: "⚠️", error: "⚠️", received: "" };

function toast(msg, err = false) {
  const el = $("#toast");
  el.textContent = msg;
  el.className = `toast${err ? " err" : ""}`;
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add("hidden"), 3500);
}

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { "Content-Type": "application/json" },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) return showLogin();
  if (!res.ok) throw new Error(data.error || "حدث خطأ");
  return data;
}

const fmtTime = (ts) => {
  if (!ts) return "";
  const d = new Date(ts);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString("ar", { hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString("ar", { day: "numeric", month: "short" });
};
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const accountOf = (id) => state.accounts.find((a) => a.id === id);

// ---------- تسجيل الدخول ----------
function showLogin() {
  $("#app").classList.add("hidden");
  $("#login").classList.remove("hidden");
}
$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#login-error").textContent = "";
  const res = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: $("#login-username").value, password: $("#login-password").value }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return ($("#login-error").textContent = data.error || "بيانات الدخول غير صحيحة");
  location.reload();
});
$("#setup-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#setup-error").textContent = "";
  const body = Object.fromEntries(new FormData(e.target).entries());
  const res = await fetch("/api/setup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return ($("#setup-error").textContent = data.error || "تعذر الإعداد");
  location.reload();
});
$("#btn-logout").addEventListener("click", async () => { await fetch("/api/logout", { method: "POST" }); location.reload(); });
function applyRole() {
  $("#me-name").textContent = state.me ? `· ${state.me.name}${isAdmin() ? " (مدير)" : ""}` : "";
  document.querySelectorAll(".admin-only").forEach((el) => el.classList.toggle("hidden-role", !isAdmin()));
}

// ---------- الحسابات ----------
function renderAccounts() {
  const list = $("#accounts-list");
  const items = [
    `<li class="account account-all ${state.selectedAccount === null ? "active" : ""}" data-id="">
      <span class="status connected"></span><div class="info"><div class="label">📥 كل الأرقام (الصندوق الموحّد)</div></div></li>`,
    ...state.accounts.map((a) => `
      <li class="account ${state.selectedAccount === a.id ? "active" : ""}" data-id="${a.id}">
        <span class="status ${a.status}"></span>
        <div class="info">
          <div class="label">${esc(a.label)} <span class="muted small-text">${a.type === "cloud" ? "Cloud API" : "QR"}</span></div>
          <div class="sub">${a.phone ? "+" + esc(a.phone) : STATUS_AR[a.status] || a.status}${a.phone ? " · " + (STATUS_AR[a.status] || a.status) : ""}</div>
        </div>
        ${isAdmin() ? `<div class="actions">
          ${a.status === "qr" ? `<button class="btn icon" data-act="qr" title="عرض QR">📱</button>` : ""}
          ${a.status === "connected" ? `<button class="btn icon" data-act="disconnect" title="فصل">⏸</button>` : `<button class="btn icon" data-act="connect" title="اتصال">▶️</button>`}
          <button class="btn icon" data-act="rename" title="إعادة تسمية">✏️</button>
          <button class="btn icon danger" data-act="remove" title="حذف">🗑</button>
        </div>` : ""}
      </li>`),
  ];
  list.innerHTML = items.join("");
  $("#new-account").innerHTML = state.accounts
    .filter((a) => a.status === "connected")
    .map((a) => `<option value="${a.id}">${esc(a.label)} ${a.phone ? "(+" + esc(a.phone) + ")" : ""}</option>`)
    .join("");
}

$("#accounts-list").addEventListener("click", async (e) => {
  const li = e.target.closest(".account");
  if (!li) return;
  const id = li.dataset.id || null;
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (!act) {
    state.selectedAccount = id;
    renderAccounts();
    await loadChats();
    return;
  }
  const a = accountOf(id);
  try {
    if (act === "qr") openQr(id);
    if (act === "connect") { await api(`/accounts/${id}/connect`, { method: "POST" }); }
    if (act === "disconnect") await api(`/accounts/${id}/disconnect`, { method: "POST" });
    if (act === "rename") {
      const label = prompt("الاسم الجديد:", a.label);
      if (label) await api(`/accounts/${id}`, { method: "PATCH", body: { label } });
    }
    if (act === "remove" && confirm(`حذف "${a.label}" وتسجيل الخروج من الجهاز؟`)) await api(`/accounts/${id}`, { method: "DELETE" });
  } catch (err) { toast(err.message, true); }
});

// ---------- QR ----------
function openQr(id) {
  state.qrFor = id;
  updateQr();
  $("#qr-dialog").showModal();
}
function updateQr() {
  if (!state.qrFor) return;
  const a = accountOf(state.qrFor);
  if (!a) return $("#qr-dialog").close();
  $("#qr-title").textContent = `ربط: ${a.label}`;
  $("#qr-img").src = a.qr || "";
  $("#qr-img").style.visibility = a.qr ? "visible" : "hidden";
  $("#qr-status").textContent = STATUS_AR[a.status] || a.status;
  if (a.status === "connected") {
    toast(`تم ربط ${a.label} بنجاح ✅`);
    setTimeout(() => $("#qr-dialog").close(), 800);
  }
}
$("#qr-close").addEventListener("click", () => $("#qr-dialog").close());
$("#qr-dialog").addEventListener("close", () => (state.qrFor = null));

// ---------- إضافة رقم ----------
$("#btn-add").addEventListener("click", () => {
  $("#webhook-url").textContent = `${location.origin}/webhooks/cloud`;
  $("#add-dialog").showModal();
});
$("#add-cancel").addEventListener("click", () => $("#add-dialog").close());
$("#add-type").addEventListener("change", (e) => $("#cloud-fields").classList.toggle("hidden", e.target.value !== "cloud"));
$("#add-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target).entries());
  try {
    const a = await api("/accounts", { method: "POST", body });
    $("#add-dialog").close();
    e.target.reset();
    $("#cloud-fields").classList.add("hidden");
    if (a.type !== "cloud") openQr(a.id);
    else toast("تمت إضافة الحساب");
  } catch (err) { toast(err.message, true); }
});

// ---------- المحادثات ----------
async function loadChats() {
  if (state.selectedAccount === null) {
    state.chats = await api("/inbox");
    $("#chats-title").textContent = "الصندوق الموحّد";
  } else {
    const a = accountOf(state.selectedAccount);
    state.chats = (await api(`/accounts/${state.selectedAccount}/chats`)).map((c) => ({ ...c, accountId: a.id, accountLabel: a.label }));
    $("#chats-title").textContent = `محادثات: ${a?.label || ""}`;
  }
  renderChats();
}

function renderChats() {
  const q = state.search.trim().toLowerCase();
  const chats = state.chats
    .filter((c) => state.chatFilter === "all" || (state.chatFilter === "mine" ? c.assignedTo === state.me?.id : !c.assignedTo))
    .filter((c) => !q || (c.name || "").toLowerCase().includes(q) || c.id.includes(q) || (c.lastMessage || "").toLowerCase().includes(q));
  $("#chats-list").innerHTML = chats.length
    ? chats.map((c) => `
      <li class="chat ${state.current?.chatId === c.id && state.current?.accountId === c.accountId ? "active" : ""}" data-account="${c.accountId}" data-chat="${esc(c.id)}">
        <div class="avatar">${esc((c.name || c.id)[0] || "?")}</div>
        <div class="body">
          <div class="top"><span class="name">${esc(c.name || c.id.split("@")[0])}</span><span class="time">${fmtTime(c.lastTimestamp)}</span></div>
          <div class="preview">${esc(c.lastMessage || "")}</div>
          <div class="tag">${state.selectedAccount === null ? `عبر: ${esc(c.accountLabel || "")}` : ""}${c.assignedName ? ` <span class="assignee">👤 ${esc(c.assignedName)}</span>` : ""}</div>
        </div>
        ${c.unread ? `<span class="badge">${c.unread}</span>` : ""}
      </li>`).join("")
    : `<li class="muted" style="padding:16px;text-align:center">لا توجد محادثات بعد</li>`;
}
$("#chat-search").addEventListener("input", (e) => { state.search = e.target.value; renderChats(); });
document.querySelectorAll(".cf").forEach((b) => b.addEventListener("click", () => {
  document.querySelectorAll(".cf").forEach((x) => x.classList.toggle("active", x === b));
  state.chatFilter = b.dataset.f; renderChats();
}));
$("#chats-list").addEventListener("click", (e) => {
  const li = e.target.closest(".chat");
  if (li) openChat(li.dataset.account, li.dataset.chat);
});

// ---------- المحادثة ----------
async function openChat(accountId, chatId) {
  state.current = { accountId, chatId };
  const a = accountOf(accountId);
  const chat = state.chats.find((c) => c.id === chatId && c.accountId === accountId);
  $("#empty").classList.add("hidden");
  $("#conversation").classList.remove("hidden");
  $("#conv-name").textContent = chat?.name || chatId.split("@")[0];
  $("#conv-meta").textContent = `${chatId.split("@")[0]} · عبر ${a?.label || ""}${a?.phone ? " (+" + a.phone + ")" : ""}`;
  loadAssignees(accountId, chat?.assignedTo || "").catch(() => {});
  const messages = await api(`/accounts/${accountId}/chats/${encodeURIComponent(chatId)}/messages`);
  if (chat) chat.unread = 0;
  renderChats();
  $("#messages").innerHTML = messages.map(renderMessage).join("");
  scrollBottom();
  $("#send-text").focus();
}
async function loadAssignees(accountId, selected) {
  state.assignees = await api(`/assignees?accountId=${accountId}`);
  $("#assign-select").innerHTML = `<option value="">— لا أحد —</option>` + state.assignees.map((u) => `<option value="${u.id}" ${u.id === selected ? "selected" : ""}>${esc(u.name)}${u.id === state.me?.id ? " (أنا)" : ""}</option>`).join("");
}
$("#assign-select").addEventListener("change", async (e) => {
  if (!state.current) return;
  try {
    await api(`/accounts/${state.current.accountId}/chats/${encodeURIComponent(state.current.chatId)}`, { method: "PATCH", body: { assignedTo: e.target.value } });
    toast(e.target.value ? "تم إسناد المحادثة" : "تم إلغاء الإسناد");
  } catch (err) { toast(err.message, true); }
});
function renderMedia(m) {
  if (!m.media?.url) return "";
  const u = esc(m.media.url);
  if (m.mediaType === "image" || m.mediaType === "sticker") return `<a href="${u}" target="_blank"><img src="${u}" alt="" loading="lazy" /></a>`;
  if (m.mediaType === "video") return `<video src="${u}" controls preload="metadata"></video>`;
  if (m.mediaType === "audio") return `<audio src="${u}" controls preload="metadata"></audio>`;
  return `<a class="doc" href="${u}" download="${esc(m.media.fileName || "")}">📄 <span>${esc(m.media.fileName || "ملف")}</span></a>`;
}
function renderMessage(m) {
  const sender = m.isGroup && !m.fromMe ? `<span class="sender">${esc(m.sender?.split("@")[0] || "")}</span>` : "";
  const text = m.media?.url && m.mediaType !== "document" && (m.text === "📷 صورة" || m.text === "🎬 فيديو" || m.text === "🎤 رسالة صوتية" || m.text === "🩵 ملصق") ? "" : m.text;
  return `<div class="msg ${m.fromMe ? "out" : ""}" data-id="${esc(m.id)}">${sender}${renderMedia(m)}${esc(text)}<span class="meta">${fmtTime(m.timestamp)} <span class="tick">${m.fromMe ? TICKS[m.status] ?? "" : ""}</span></span></div>`;
}
const scrollBottom = () => { const el = $("#messages"); el.scrollTop = el.scrollHeight; };

$("#send-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("#send-text").value.trim();
  if (!text || !state.current) return;
  $("#send-text").value = "";
  try { await api(`/accounts/${state.current.accountId}/send`, { method: "POST", body: { chatId: state.current.chatId, text } }); }
  catch (err) { toast(err.message, true); $("#send-text").value = text; }
});
$("#send-text").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#send-form").requestSubmit(); }
});

// ---------- المرفقات ----------
let pendingFile = null;
$("#btn-attach").addEventListener("click", () => $("#attach-input").click());
$("#attach-input").addEventListener("change", (e) => { if (e.target.files[0]) stageFile(e.target.files[0]); e.target.value = ""; });
$("#attach-cancel").addEventListener("click", () => $("#attach-dialog").close());
function stageFile(file) {
  if (!state.current) return toast("افتح محادثة أولًا", true);
  pendingFile = file;
  const prev = $("#attach-preview");
  if (file.type.startsWith("image/")) prev.innerHTML = `<img src="${URL.createObjectURL(file)}" alt="" />`;
  else prev.innerHTML = `<div>📄 ${esc(file.name)} <span class="muted small-text">(${(file.size / 1024).toFixed(0)} KB)</span></div>`;
  $("#attach-dialog").showModal();
}
$("#attach-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!pendingFile || !state.current) return;
  const fd = new FormData();
  fd.append("file", pendingFile);
  fd.append("chatId", state.current.chatId);
  fd.append("caption", new FormData(e.target).get("caption") || "");
  $("#attach-dialog").close();
  e.target.reset();
  toast("جاري الإرسال…");
  try {
    const res = await fetch(`/api/accounts/${state.current.accountId}/send-media`, { method: "POST", body: fd });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "فشل الإرسال");
  } catch (err) { toast(err.message, true); }
  pendingFile = null;
});
// سحب وإفلات ولصق الصور
const msgsEl = $("#messages");
msgsEl.addEventListener("dragover", (e) => { e.preventDefault(); msgsEl.classList.add("drop-hint"); });
msgsEl.addEventListener("dragleave", () => msgsEl.classList.remove("drop-hint"));
msgsEl.addEventListener("drop", (e) => { e.preventDefault(); msgsEl.classList.remove("drop-hint"); if (e.dataTransfer.files[0]) stageFile(e.dataTransfer.files[0]); });
$("#send-text").addEventListener("paste", (e) => {
  const f = [...(e.clipboardData?.files || [])][0];
  if (f) { e.preventDefault(); stageFile(f); }
});

// ---------- الردود الجاهزة ----------
state.templates = [];
state.tplSel = 0;
async function loadTemplates() { state.templates = await api("/templates"); }
function applyVars(text) {
  const chat = state.chats.find((c) => c.id === state.current?.chatId && c.accountId === state.current?.accountId);
  return text.replaceAll("{name}", chat?.name || state.current?.chatId?.split("@")[0] || "");
}
function showTemplates(filter = "") {
  const pop = $("#templates-pop");
  const q = filter.toLowerCase();
  const list = state.templates.filter((t) => !q || t.title.toLowerCase().includes(q) || t.text.toLowerCase().includes(q));
  if (!list.length) { pop.classList.add("hidden"); return; }
  state.tplSel = Math.min(state.tplSel, list.length - 1);
  pop.innerHTML = list.map((t, i) => `<div class="t ${i === state.tplSel ? "sel" : ""}" data-id="${t.id}"><b>${esc(t.title)}</b><span>${esc(t.text)}</span></div>`).join("");
  pop.classList.remove("hidden");
  pop._list = list;
}
function hideTemplates() { $("#templates-pop").classList.add("hidden"); state.tplSel = 0; }
function pickTemplate(t) {
  $("#send-text").value = applyVars(t.text);
  hideTemplates();
  $("#send-text").focus();
}
$("#btn-templates").addEventListener("click", () => {
  if (!state.templates.length) return toast("لا توجد ردود جاهزة — أضفها من ⚙️", true);
  $("#templates-pop").classList.contains("hidden") ? showTemplates() : hideTemplates();
});
$("#templates-pop").addEventListener("click", (e) => {
  const el = e.target.closest(".t");
  if (el) pickTemplate(state.templates.find((t) => t.id === el.dataset.id));
});
$("#send-text").addEventListener("input", (e) => {
  const v = e.target.value;
  if (v.startsWith("/")) showTemplates(v.slice(1)); else hideTemplates();
});
$("#send-text").addEventListener("keydown", (e) => {
  const pop = $("#templates-pop");
  if (pop.classList.contains("hidden")) return;
  const list = pop._list || [];
  if (e.key === "ArrowDown") { e.preventDefault(); state.tplSel = (state.tplSel + 1) % list.length; showTemplates($("#send-text").value.slice(1)); }
  if (e.key === "ArrowUp") { e.preventDefault(); state.tplSel = (state.tplSel - 1 + list.length) % list.length; showTemplates($("#send-text").value.slice(1)); }
  if (e.key === "Tab" || (e.key === "Enter" && $("#send-text").value.startsWith("/"))) { e.preventDefault(); e.stopImmediatePropagation(); if (list[state.tplSel]) pickTemplate(list[state.tplSel]); }
  if (e.key === "Escape") hideTemplates();
}, true);

// ---------- الإعدادات ----------
state.rules = [];
const TRIGGER_AR = { keyword: "كلمة مفتاحية", welcome: "ترحيب", away: "خارج الدوام" };
$("#btn-settings").addEventListener("click", async () => {
  if (isAdmin()) {
    await Promise.all([loadTemplates(), loadRules(), loadAlertSettings(), loadUsers()]);
    renderTemplatesList(); renderRulesList(); fillRuleAccounts(); renderUsersList(); fillUserAccounts();
  } else {
    await loadTemplates(); renderTemplatesList();
    $("#template-form").classList.add("hidden");
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("hidden", t.dataset.tab !== "templates"));
  }
  $("#settings-dialog").showModal();
});

// ---------- المستخدمون (المدير) ----------
state.users = [];
async function loadUsers() { state.users = await api("/users"); }
function fillUserAccounts(selected = []) {
  $("#user-accounts").innerHTML = state.accounts.length
    ? state.accounts.map((a) => `<label><input type="checkbox" name="accountIds" value="${a.id}" ${selected.includes(a.id) ? "checked" : ""} /> ${esc(a.label)}${a.phone ? " (+" + esc(a.phone) + ")" : ""}</label>`).join("")
    : `<span class="muted small-text">أضف أرقامًا أولًا لتخصيصها للموظفين</span>`;
}
function renderUsersList() {
  $("#users-list").innerHTML = state.users.map((u) => `
    <li data-id="${u.id}" class="${u.active === false ? "off" : ""}">
      <div class="body"><b>${esc(u.name)} <span class="role ${u.role}">${u.role === "admin" ? "مدير" : "موظف"}</span>${u.id === state.me.id ? `<span class="role">أنا</span>` : ""}</b>
      <p>@${esc(u.username)} · ${u.role === "admin" ? "كل الأرقام" : (u.accountIds || []).map((id) => accountOf(id)?.label).filter(Boolean).join("، ") || "بدون أرقام"}</p></div>
      <button class="btn icon" data-act="edit" title="تعديل">✏️</button>
      ${u.id !== state.me.id ? `<button class="btn icon" data-act="toggle" title="${u.active === false ? "تفعيل" : "تعطيل"}">${u.active === false ? "▶️" : "⏸"}</button><button class="btn icon danger" data-act="del" title="حذف">🗑</button>` : ""}
    </li>`).join("");
}
$("#user-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const accountIds = [...f.querySelectorAll("[name=accountIds]:checked")].map((x) => x.value);
  const body = { name: f.name.value, username: f.username.value, password: f.password.value, role: f.role.value, accountIds };
  try {
    if (f.id.value) await api(`/users/${f.id.value}`, { method: "PATCH", body: { name: body.name, role: body.role, accountIds, ...(body.password && { password: body.password }) } });
    else await api("/users", { method: "POST", body });
    f.reset(); f.username.disabled = false; fillUserAccounts();
    await loadUsers(); renderUsersList(); toast("تم الحفظ");
  } catch (err) { toast(err.message, true); }
});
$("#user-reset").addEventListener("click", () => { const f = $("#user-form"); f.reset(); f.username.disabled = false; fillUserAccounts(); });
$("#users-list").addEventListener("click", async (e) => {
  const li = e.target.closest("li[data-id]"); const act = e.target.closest("[data-act]")?.dataset.act;
  if (!li || !act) return;
  const u = state.users.find((x) => x.id === li.dataset.id);
  try {
    if (act === "edit") {
      const f = $("#user-form");
      f.id.value = u.id; f.name.value = u.name; f.username.value = u.username; f.username.disabled = true; f.role.value = u.role; f.password.value = ""; f.password.placeholder = "كلمة مرور جديدة (اتركه فارغًا للإبقاء)";
      fillUserAccounts(u.accountIds || []); f.name.focus();
    }
    if (act === "toggle") { await api(`/users/${u.id}`, { method: "PATCH", body: { active: u.active === false } }); await loadUsers(); renderUsersList(); }
    if (act === "del" && confirm(`حذف المستخدم "${u.name}"؟`)) { await api(`/users/${u.id}`, { method: "DELETE" }); await loadUsers(); renderUsersList(); }
  } catch (err) { toast(err.message, true); }
});
$("#settings-close").addEventListener("click", () => $("#settings-dialog").close());
document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => {
  document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === b));
  document.querySelectorAll(".tab-panel").forEach((p) => p.classList.toggle("hidden", p.id !== `tab-${b.dataset.tab}`));
}));

function renderTemplatesList() {
  $("#templates-list").innerHTML = state.templates.length
    ? state.templates.map((t) => `<li data-id="${t.id}"><div class="body"><b>${esc(t.title)}</b><p>${esc(t.text)}</p></div><button class="btn icon" data-act="edit">✏️</button><button class="btn icon danger" data-act="del">🗑</button></li>`).join("")
    : `<li class="muted">لا توجد ردود جاهزة بعد</li>`;
}
$("#template-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target).entries());
  try { await api("/templates", { method: "POST", body }); e.target.reset(); await loadTemplates(); renderTemplatesList(); toast("تم الحفظ"); }
  catch (err) { toast(err.message, true); }
});
$("#template-reset").addEventListener("click", () => $("#template-form").reset());
$("#templates-list").addEventListener("click", async (e) => {
  const li = e.target.closest("li[data-id]"); const act = e.target.closest("[data-act]")?.dataset.act;
  if (!li || !act) return;
  const t = state.templates.find((x) => x.id === li.dataset.id);
  if (act === "edit") { const f = $("#template-form"); f.id.value = t.id; f.title.value = t.title; f.text.value = t.text; f.title.focus(); }
  if (act === "del" && confirm(`حذف "${t.title}"؟`)) { await api(`/templates/${t.id}`, { method: "DELETE" }); await loadTemplates(); renderTemplatesList(); }
});

async function loadRules() { state.rules = await api("/rules"); }
function fillRuleAccounts() {
  $("#rule-account").innerHTML = `<option value="">كل الأرقام</option>` + state.accounts.map((a) => `<option value="${a.id}">${esc(a.label)}</option>`).join("");
}
function renderRulesList() {
  $("#rules-list").innerHTML = state.rules.length
    ? state.rules.map((r) => {
      const acc = r.accountId ? accountOf(r.accountId)?.label || "؟" : "كل الأرقام";
      const detail = r.trigger === "keyword" ? `الكلمات: ${esc(r.keywords)}` : r.trigger === "away" ? `من ${r.fromHour ?? 18}:00 إلى ${r.toHour ?? 8}:00` : `مرة كل ${r.cooldownHours || 24} ساعة`;
      return `<li data-id="${r.id}" class="${r.enabled === false ? "off" : ""}"><div class="body"><b>${esc(r.name || TRIGGER_AR[r.trigger])}<span class="pill">${TRIGGER_AR[r.trigger]}</span><span class="pill">${esc(acc)}</span></b><p>${detail}\n↩ ${esc(r.reply)}</p></div>
        <button class="btn icon" data-act="toggle" title="${r.enabled === false ? "تفعيل" : "تعطيل"}">${r.enabled === false ? "▶️" : "⏸"}</button><button class="btn icon" data-act="edit">✏️</button><button class="btn icon danger" data-act="del">🗑</button></li>`;
    }).join("")
    : `<li class="muted">لا توجد قواعد بعد</li>`;
}
function syncRuleFields() {
  const t = $("#rule-trigger").value;
  $(".rule-keyword").classList.toggle("hidden", t !== "keyword");
  $(".rule-away").classList.toggle("hidden", t !== "away");
  $(".rule-cooldown").classList.toggle("hidden", t === "keyword");
}
$("#rule-trigger").addEventListener("change", syncRuleFields);
$("#rule-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target).entries());
  try { await api("/rules", { method: "POST", body }); e.target.reset(); syncRuleFields(); await loadRules(); renderRulesList(); toast("تم الحفظ"); }
  catch (err) { toast(err.message, true); }
});
$("#rule-reset").addEventListener("click", () => { $("#rule-form").reset(); syncRuleFields(); });
$("#rules-list").addEventListener("click", async (e) => {
  const li = e.target.closest("li[data-id]"); const act = e.target.closest("[data-act]")?.dataset.act;
  if (!li || !act) return;
  const r = state.rules.find((x) => x.id === li.dataset.id);
  if (act === "edit") {
    const f = $("#rule-form");
    for (const k of ["id", "name", "trigger", "accountId", "keywords", "match", "reply", "cooldownHours", "fromHour", "toHour"]) if (f[k] && r[k] !== undefined) f[k].value = r[k];
    syncRuleFields(); f.reply.focus();
  }
  if (act === "toggle") { await api("/rules", { method: "POST", body: { ...r, enabled: r.enabled === false } }); await loadRules(); renderRulesList(); }
  if (act === "del" && confirm("حذف القاعدة؟")) { await api(`/rules/${r.id}`, { method: "DELETE" }); await loadRules(); renderRulesList(); }
});

// ---------- تنبيهات الاستفسارات ----------
async function loadAlertSettings() {
  const st = await api("/alerts/settings");
  const f = $("#alerts-form");
  f.enabled.checked = st.enabled; f.whatsapp.checked = st.whatsapp; f.email.checked = st.email;
  f.notifyEmail.value = st.notifyEmail || ""; f.keywords.value = st.keywords || ""; f.cooldownMinutes.value = st.cooldownMinutes ?? 60;
  const EMAIL_ST = { connected: "متصل ✅", connecting: "جاري الاتصال…", reconnecting: "إعادة الاتصال…", error: "خطأ ❌", not_configured: "غير مُعدّ", disconnected: "غير متصل" };
  $("#alerts-status").innerHTML =
    `إرسال الإيميل (SMTP): ${st.smtpConfigured ? "مُعدّ ✅" : "غير مُعدّ ❌ — أضف SMTP_HOST/USER/PASS في .env"}<br>` +
    `مراقبة الإيميل (IMAP): ${st.imapConfigured ? `${esc(st.imapUser)} — ${EMAIL_ST[st.emailStatus] || st.emailStatus}${st.emailError ? " (" + esc(st.emailError) + ")" : ""}` : "غير مُعدّ — أضف IMAP_HOST/USER/PASS في .env"}`;
}
$("#alerts-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await api("/alerts/settings", { method: "POST", body: { enabled: f.enabled.checked, whatsapp: f.whatsapp.checked, email: f.email.checked, notifyEmail: f.notifyEmail.value, keywords: f.keywords.value, cooldownMinutes: f.cooldownMinutes.value } });
    toast("تم حفظ إعدادات التنبيهات");
  } catch (err) { toast(err.message, true); }
});
$("#alerts-test").addEventListener("click", async () => {
  try { await api("/alerts/test", { method: "POST", body: { to: $("#alerts-form").notifyEmail.value } }); toast("تم إرسال إيميل تجريبي ✅"); }
  catch (err) { toast(err.message, true); }
});

state.leads = []; state.leadFilter = "new";
async function loadLeads() { state.leads = await api("/leads"); updateLeadsBadge(); }
function updateLeadsBadge() {
  const n = state.leads.filter((l) => l.status === "new").length;
  const b = $("#leads-count"); b.textContent = n; b.classList.toggle("hidden", !n);
}
function renderLeads() {
  const list = state.leads.filter((l) => state.leadFilter === "all" || l.status === state.leadFilter);
  $("#leads-list").innerHTML = list.length ? list.map((l) => `
    <li class="lead" data-id="${l.id}">
      <div class="body">
        <b>${esc(l.fromName || l.from)} <span class="chan ${l.channel}">${l.channel === "whatsapp" ? "واتساب · " + esc(l.accountLabel || "") : "إيميل"}</span></b>
        <div class="when">${new Date(l.timestamp).toLocaleString("ar")} · <span class="kw">${esc(l.matched.join("، "))}</span> · <span class="notified">${l.notified ? "📧 تم التنبيه" : l.notifyError ? "⚠️ " + esc(l.notifyError) : "بدون إيميل"}</span></div>
        ${l.subject ? `<p><b>${esc(l.subject)}</b></p>` : ""}<p>${esc((l.text || "").slice(0, 300))}</p>
      </div>
      ${l.channel === "whatsapp" && l.accountId ? `<button class="btn icon" data-act="open" title="فتح المحادثة">💬</button>` : `<a class="btn icon" href="mailto:${esc(l.from)}" title="رد بالإيميل">✉️</a>`}
      ${l.status !== "contacted" ? `<button class="btn icon" data-act="contacted" title="تم التواصل">☎️</button>` : ""}
      ${l.status !== "done" ? `<button class="btn icon" data-act="done" title="إنهاء">✅</button>` : `<button class="btn icon" data-act="new" title="إعادة فتح">↩️</button>`}
    </li>`).join("") : `<li class="muted">لا توجد استفسارات</li>`;
}
$("#btn-leads").addEventListener("click", async () => { await loadLeads(); renderLeads(); $("#leads-dialog").showModal(); });
$("#leads-close").addEventListener("click", () => $("#leads-dialog").close());
document.querySelectorAll(".ltab").forEach((b) => b.addEventListener("click", () => {
  document.querySelectorAll(".ltab").forEach((x) => x.classList.toggle("active", x === b));
  state.leadFilter = b.dataset.f; renderLeads();
}));
$("#leads-list").addEventListener("click", async (e) => {
  const li = e.target.closest("li[data-id]"); const act = e.target.closest("[data-act]")?.dataset.act;
  if (!li || !act) return;
  const l = state.leads.find((x) => x.id === li.dataset.id);
  if (act === "open") { $("#leads-dialog").close(); state.selectedAccount = null; renderAccounts(); await loadChats(); openChat(l.accountId, l.chatId); return; }
  await api(`/leads/${l.id}`, { method: "PATCH", body: { status: act } });
  await loadLeads(); renderLeads();
});
// ---------- رسالة جديدة ----------
$("#btn-new-msg").addEventListener("click", () => {
  if (!state.accounts.some((a) => a.status === "connected")) return toast("لا يوجد رقم متصل حاليًا", true);
  $("#new-dialog").showModal();
});
$("#new-cancel").addEventListener("click", () => $("#new-dialog").close());
$("#new-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const { accountId, to, text } = Object.fromEntries(new FormData(e.target).entries());
  try {
    const m = await api(`/accounts/${accountId}/send`, { method: "POST", body: { chatId: to, text } });
    $("#new-dialog").close();
    e.target.reset();
    state.selectedAccount = null;
    renderAccounts();
    await loadChats();
    openChat(accountId, m.chatId);
  } catch (err) { toast(err.message, true); }
});

// ---------- الأحداث اللحظية ----------
const socket = io();
socket.on("account:update", (a) => {
  const i = state.accounts.findIndex((x) => x.id === a.id);
  if (i === -1) state.accounts.push(a); else state.accounts[i] = a;
  renderAccounts();
  updateQr();
});
socket.on("account:removed", ({ accountId }) => {
  state.accounts = state.accounts.filter((a) => a.id !== accountId);
  if (state.selectedAccount === accountId) state.selectedAccount = null;
  renderAccounts();
  loadChats();
});
socket.on("chat:update", ({ accountId, chat }) => {
  if (!chat || (state.selectedAccount !== null && state.selectedAccount !== accountId)) return;
  const a = accountOf(accountId);
  const entry = { ...chat, accountId, accountLabel: a?.label, accountPhone: a?.phone };
  if (state.current?.chatId === chat.id && state.current?.accountId === accountId) entry.unread = 0;
  const i = state.chats.findIndex((c) => c.id === chat.id && c.accountId === accountId);
  if (i === -1) state.chats.unshift(entry); else state.chats[i] = entry;
  state.chats.sort((x, y) => (y.lastTimestamp || 0) - (x.lastTimestamp || 0));
  renderChats();
});
socket.on("message:new", ({ accountId, message }) => {
  if (state.current?.accountId === accountId && state.current?.chatId === message.chatId) {
    if (!$(`#messages [data-id="${CSS.escape(message.id)}"]`)) {
      $("#messages").insertAdjacentHTML("beforeend", renderMessage(message));
      scrollBottom();
    }
  } else if (!message.fromMe) {
    const a = accountOf(accountId);
    toast(`📩 ${message.chatName || message.chatId.split("@")[0]} عبر ${a?.label || ""}: ${message.text.slice(0, 60)}`);
  }
});
socket.on("message:status", ({ accountId, chatId, messageId, status }) => {
  if (state.current?.accountId !== accountId || state.current?.chatId !== chatId) return;
  const tick = $(`#messages [data-id="${CSS.escape(messageId)}"] .tick`);
  if (tick) tick.textContent = TICKS[status] ?? "";
});
socket.on("connect_error", () => showLogin());
socket.on("lead:new", (lead) => {
  state.leads.unshift(lead); updateLeadsBadge();
  if ($("#leads-dialog").open) renderLeads();
  toast(`🔔 استفسار جديد عن ${lead.matched[0]} من ${lead.fromName || lead.from} (${lead.channel === "whatsapp" ? "واتساب" : "إيميل"})`);
});
socket.on("chat:assigned", ({ chat, by }) => toast(`👤 ${by} أسند إليك محادثة: ${chat.name || chat.id.split("@")[0]}`));
socket.on("email:status", () => { if ($("#settings-dialog").open) loadAlertSettings().catch(() => {}); });


// ---------- بدء التشغيل ----------
(async function boot() {
  const auth = await fetch("/api/auth").then((r) => r.json());
  if (auth.setupRequired) { $("#setup").classList.remove("hidden"); return; }
  if (!auth.user) return showLogin();
  state.me = auth.user;
  $("#login").classList.add("hidden");
  $("#app").classList.remove("hidden");
  applyRole();
  state.accounts = await api("/accounts");
  renderAccounts();
  await Promise.all([loadChats(), loadTemplates(), loadLeads()]);
})();
