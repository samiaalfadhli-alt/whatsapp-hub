const $ = (s) => document.querySelector(s);
const state = {
  accounts: [],
  chats: [], // مع accountId لكل محادثة
  selectedAccount: null, // null = الصندوق الموحّد
  current: null, // { accountId, chatId }
  search: "",
  qrFor: null,
};

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
  const res = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: $("#login-password").value }) });
  if (!res.ok) return ($("#login-error").textContent = "كلمة المرور غير صحيحة");
  location.reload();
});

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
        <div class="actions">
          ${a.status === "qr" ? `<button class="btn icon" data-act="qr" title="عرض QR">📱</button>` : ""}
          ${a.status === "connected" ? `<button class="btn icon" data-act="disconnect" title="فصل">⏸</button>` : `<button class="btn icon" data-act="connect" title="اتصال">▶️</button>`}
          <button class="btn icon" data-act="rename" title="إعادة تسمية">✏️</button>
          <button class="btn icon danger" data-act="remove" title="حذف">🗑</button>
        </div>
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
  const chats = state.chats.filter((c) => !q || (c.name || "").toLowerCase().includes(q) || c.id.includes(q) || (c.lastMessage || "").toLowerCase().includes(q));
  $("#chats-list").innerHTML = chats.length
    ? chats.map((c) => `
      <li class="chat ${state.current?.chatId === c.id && state.current?.accountId === c.accountId ? "active" : ""}" data-account="${c.accountId}" data-chat="${esc(c.id)}">
        <div class="avatar">${esc((c.name || c.id)[0] || "?")}</div>
        <div class="body">
          <div class="top"><span class="name">${esc(c.name || c.id.split("@")[0])}</span><span class="time">${fmtTime(c.lastTimestamp)}</span></div>
          <div class="preview">${esc(c.lastMessage || "")}</div>
          ${state.selectedAccount === null ? `<div class="tag">عبر: ${esc(c.accountLabel || "")}</div>` : ""}
        </div>
        ${c.unread ? `<span class="badge">${c.unread}</span>` : ""}
      </li>`).join("")
    : `<li class="muted" style="padding:16px;text-align:center">لا توجد محادثات بعد</li>`;
}
$("#chat-search").addEventListener("input", (e) => { state.search = e.target.value; renderChats(); });
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
  const messages = await api(`/accounts/${accountId}/chats/${encodeURIComponent(chatId)}/messages`);
  if (chat) chat.unread = 0;
  renderChats();
  $("#messages").innerHTML = messages.map(renderMessage).join("");
  scrollBottom();
  $("#send-text").focus();
}
function renderMessage(m) {
  const sender = m.isGroup && !m.fromMe ? `<span class="sender">${esc(m.sender?.split("@")[0] || "")}</span>` : "";
  return `<div class="msg ${m.fromMe ? "out" : ""}" data-id="${esc(m.id)}">${sender}${esc(m.text)}<span class="meta">${fmtTime(m.timestamp)} <span class="tick">${m.fromMe ? TICKS[m.status] ?? "" : ""}</span></span></div>`;
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

// ---------- بدء التشغيل ----------
(async function boot() {
  const auth = await fetch("/api/auth").then((r) => r.json());
  if (auth.required && !auth.authed) return showLogin();
  $("#login").classList.add("hidden");
  $("#app").classList.remove("hidden");
  state.accounts = await api("/accounts");
  renderAccounts();
  await loadChats();
})();
