// المحادثات: قائمة (يمين) + محادثة (وسط) + معلومات العميل (يسار)
import { state, $, $$, api, qs, esc, can, h, toast, toastErr, debounce, fmtTime, fmtDate, fmtDateTime, fmtPhone, avatar, CONV_STATUS, MSG_STATUS, renderMedia, bindMedia, skeleton, empty, confirm, catLabel, userName } from "../core.js";
import { bus, navigate, refreshUnread } from "../app.js";
import { openContact, openContactForm } from "./contacts.js";
import { addNoteDialog, addTaskDialog } from "./tasks.js";

export async function render(view, [ref]) {
  const el = h(`<div class="inbox">
    <section class="conv-list">
      <div class="conv-list-head">
        <input type="search" data-q placeholder="بحث في المحادثات" />
        <div class="filters">
          ${[["all", "الكل"], ["unread", "غير مقروءة"], ["new", "جديدة"], ["waiting", "بانتظار الرد"], ["replied", "تم الرد"], ["closed", "مغلقة"], ["mine", "محادثاتي"]].map(([k, l]) => `<button class="chip ${k === "all" ? "active" : ""}" data-f="${k}">${l}</button>`).join("")}
        </div>
        <div class="selects">
          <select data-account><option value="">كل الأرقام</option>${state.meta.accounts.map((a) => `<option value="${a.id}">${esc(a.label)}</option>`).join("")}</select>
          <select data-assigned><option value="">كل الموظفين</option><option value="none">غير مُسندة</option>${state.meta.users.filter((u) => u.active).map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join("")}</select>
          <select data-tag><option value="">كل الوسوم</option>${state.meta.tags.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join("")}</select>
          <select data-category><option value="">كل التصنيفات</option>${state.meta.categories.map((c) => `<option value="${c}">${esc(catLabel(c))}</option>`).join("")}</select>
        </div>
      </div>
      <div class="conv-items" data-items>${skeleton(8)}</div>
    </section>
    <section class="chat" data-chat><div class="chat-empty"><div><div style="font-size:44px">💬</div>اختر محادثة من القائمة</div></div></section>
    <aside class="ctx" data-ctx></aside>
  </div>`);
  view.appendChild(el);

  const S = { filter: "all", q: "", account: "", assigned: "", tag: "", category: "", page: 1, rows: [], total: 0, current: null, loading: false, oldest: null, noteMode: false };
  const items = $("[data-items]", el);

  // ---------- قائمة المحادثات ----------
  const params = () => {
    const p = { q: S.q, accountId: S.account, assignedTo: S.assigned, tagId: S.tag, category: S.category, page: S.page, limit: 30 };
    if (["unread", "mine"].includes(S.filter)) p.filter = S.filter; else if (S.filter !== "all") p.status = S.filter;
    return p;
  };
  async function loadList(append = false) {
    if (S.loading) return; S.loading = true;
    try {
      const r = await api(`/conversations${qs(params())}`);
      S.rows = append ? [...S.rows, ...r.rows] : r.rows; S.total = r.total;
      renderList();
    } catch (e) { toastErr(e); } finally { S.loading = false; }
  }
  function convItem(c) {
    const st = CONV_STATUS[c.status] || ["", ""];
    return `<div class="conv-item ${c.unread ? "has-unread" : ""} ${S.current?.ref === c.ref ? "active" : ""}" data-ref="${c.ref}">
      ${avatar(c.title)}
      <div class="body">
        <div class="top"><span class="name truncate">${esc(c.title)}</span><span class="time">${fmtTime(c.lastTimestamp)}</span></div>
        <div class="prev truncate">${esc(c.lastMessage || "")}</div>
        <div class="meta"><span class="badge ${st[1]}">${st[0]}</span>${c.assignedName ? `<span class="badge">👤 ${esc(c.assignedName)}</span>` : ""}${state.meta.accounts.length > 1 ? `<span class="small muted truncate">${esc(c.accountLabel || "")}</span>` : ""}</div>
      </div>
      ${c.unread ? `<span class="unread">${c.unread}</span>` : ""}
    </div>`;
  }
  function renderList() {
    items.innerHTML = S.rows.length ? S.rows.map(convItem).join("") + (S.rows.length < S.total ? `<div style="padding:10px;text-align:center"><button class="btn small" data-more>تحميل المزيد (${S.total - S.rows.length})</button></div>` : "") : empty("لا توجد محادثات", "جرّب تغيير الفلاتر", "💬");
  }
  items.addEventListener("click", (e) => {
    if (e.target.closest("[data-more]")) { S.page++; loadList(true); return; }
    const it = e.target.closest("[data-ref]"); if (it) navigate(`#/inbox/${it.dataset.ref}`);
  });
  $("[data-q]", el).addEventListener("input", debounce((e) => { S.q = e.target.value.trim(); S.page = 1; loadList(); }, 350));
  $$(".filters .chip", el).forEach((b) => b.addEventListener("click", () => { $$(".filters .chip", el).forEach((x) => x.classList.toggle("active", x === b)); S.filter = b.dataset.f; S.page = 1; loadList(); }));
  for (const k of ["account", "assigned", "tag", "category"]) $(`[data-${k}]`, el).addEventListener("change", (e) => { S[k] = e.target.value; S.page = 1; loadList(); });

  // ---------- المحادثة ----------
  const chat = $("[data-chat]", el); const ctx = $("[data-ctx]", el);
  bindMedia(chat);
  const UNSUP = { legacy: "رسالة لم يُمكن عرضها (وصلت قبل تحديث النظام)", unknown: "نوع غير معروف" };
  function msgHtml(m) {
    const un = /^\[unsupported:(.+)\]$/.exec(m.text || "");
    if (un && !m.mediaType) return `<div class="msg sys" data-id="${esc(m.id)}" data-ts="${m.timestamp}" title="${esc(un[1])}">⚙️ ${esc(UNSUP[un[1]] || "رسالة من نوع غير مدعوم في العرض")} <span class="small">${fmtTime(m.timestamp)}</span></div>`;
    const st = m.fromMe ? MSG_STATUS[m.status] || ["", ""] : ["", ""];
    const tick = m.fromMe ? `<span class="tick ${m.status === "read" || m.status === "played" ? "read" : m.status === "failed" ? "failed" : ""}" title="${st[1]}">${st[0]}</span>` : "";
    const hideText = m.mediaType && m.media?.url && (/^(📷 صورة|🎬 فيديو|🎤 رسالة صوتية|🎵 مقطع صوتي|🩵 ملصق|🎥 رسالة فيديو|📄 ملف)$/.test(m.text || "") || (m.mediaType === "document" && (m.text === m.media.fileName || m.text === m.media.caption)));
    const caption = hideText ? (m.media?.caption || "") : (m.text || "");
    return `<div class="msg ${m.fromMe ? "out" : ""}" data-id="${esc(m.id)}" data-ts="${m.timestamp}">
      ${m.isGroup && !m.fromMe ? `<span class="sender">${esc(m.sender)}</span>` : ""}${renderMedia(m)}${caption ? `<div class="caption">${esc(caption)}${m.edited ? ' <span class="muted small">(معدّلة)</span>' : ""}</div>` : ""}
      <div class="meta">${fmtTime(m.timestamp)} ${tick}</div>${m.status === "failed" && m.statusReason ? `<div class="fail-reason">${esc(m.statusReason)}</div>` : ""}
    </div>`;
  }
  const noteHtml = (n) => `<div class="msg note"><div class="meta">📝 ملاحظة داخلية · ${esc(n.user_name)} · ${fmtDateTime(n.created_at)}</div>${esc(n.text)}</div>`;
  function dayDivider(ts) { return `<div class="day">${fmtDate(ts)}</div>`; }
  function renderMessages(list, notes) {
    const box = $("[data-msgs]", chat); if (!box) return;
    const merged = [...list.map((m) => ({ t: m.timestamp, html: msgHtml(m) })), ...notes.map((n) => ({ t: n.created_at, html: noteHtml(n) }))].sort((a, b) => a.t - b.t);
    let last = ""; let html = S.hasMore ? '<button class="btn small load-more" data-older>تحميل رسائل أقدم</button>' : "";
    for (const x of merged) { const d = new Date(x.t).toDateString(); if (d !== last) { html += dayDivider(x.t); last = d; } html += x.html; }
    box.innerHTML = html || empty("لا توجد رسائل بعد", "ابدأ المحادثة بإرسال رسالة", "✉️");
  }
  const scrollBottom = () => { const b = $("[data-msgs]", chat); if (b) b.scrollTop = b.scrollHeight; };

  async function openConv(ref) {
    try {
      S.current = null; S.notes = []; S.msgs = [];
      chat.innerHTML = `<div class="chat-head"><div class="skeleton" style="width:200px"></div></div><div class="chat-msgs" data-msgs>${skeleton(5)}</div>`;
      el.classList.add("chat-open");
      const [d, m] = await Promise.all([api(`/conversations/${ref}`), api(`/conversations/${ref}/messages?limit=50`)]);
      S.current = d.conversation; S.contact = d.contact; S.notes = d.notes; S.tasks = d.tasks; S.assignees = d.assignees; S.assignments = d.assignments; S.msgs = m.rows; S.hasMore = m.hasMore;
      const c = S.current; const st = CONV_STATUS[c.status] || ["", ""];
      chat.innerHTML = `
        <div class="chat-head">
          <button class="icon-btn back" data-back>→</button>
          ${avatar(c.title)}
          <div class="grow"><div class="title truncate">${esc(c.title)}</div><div class="sub">${esc(fmtPhone(c.phone))}${state.meta.accounts.length > 1 ? " · عبر " + esc(c.accountLabel) : ""} · <span class="badge ${st[1]}" data-status-badge>${st[0]}</span></div></div>
          ${can("assign_conversation") ? `<select data-assign title="الموظف المسؤول"><option value="">— غير مُسندة —</option>${d.assignees.map((u) => `<option value="${u.id}" ${u.id === c.assignedTo ? "selected" : ""}>${esc(u.name)}${u.id === state.me.id ? " (أنا)" : ""}</option>`).join("")}</select>` : c.assignedName ? `<span class="badge">👤 ${esc(c.assignedName)}</span>` : ""}
          ${can("close_conversation") ? (c.status === "closed" ? `<button class="btn small" data-reopen>إعادة فتح</button>` : `<button class="btn small" data-close-conv>إغلاق</button>`) : ""}
          <button class="icon-btn" data-ctx-toggle title="معلومات العميل">ℹ️</button>
        </div>
        <div class="chat-msgs" data-msgs></div>
        ${can("send_message") ? `<div class="chat-compose" data-compose>
          <div class="quick-pop hidden" data-quick></div>
          <button class="icon-btn" data-note-toggle title="ملاحظة داخلية (لا تُرسل للعميل)">📝</button>
          <button class="icon-btn" data-attach title="إرفاق ملف">📎</button><input type="file" class="hidden" data-file />
          <button class="icon-btn" data-quick-btn title="ردود جاهزة">⚡</button>
          <textarea data-text rows="1" placeholder="اكتب رسالة… (اكتب / للردود الجاهزة، Shift+Enter لسطر جديد)"></textarea>
          <button class="btn primary" data-send>إرسال</button>
        </div>` : ""}`;
      renderMessages(S.msgs, S.notes); scrollBottom();
      api(`/conversations/${ref}/read`, { method: "POST" }).then(() => { const row = S.rows.find((r) => r.ref === ref); if (row) { row.unread = 0; renderList(); } refreshUnread(); }).catch(() => {});
      renderCtx();
      $$(".conv-item", items).forEach((x) => x.classList.toggle("active", x.dataset.ref === ref));
      bindChatEvents(ref);
    } catch (e) { toastErr(e); chat.innerHTML = `<div class="chat-empty"><div>⚠️ ${esc(e.message)}</div></div>`; }
  }

  function bindChatEvents(ref) {
    $("[data-back]", chat)?.addEventListener("click", () => { el.classList.remove("chat-open"); navigate("#/inbox"); });
    $("[data-ctx-toggle]", chat)?.addEventListener("click", () => ctx.classList.toggle("open"));
    $("[data-assign]", chat)?.addEventListener("change", async (e) => { try { await api(`/conversations/${ref}`, { method: "PATCH", body: { assignedTo: e.target.value } }); toast(e.target.value ? "تم إسناد المحادثة" : "تم إلغاء الإسناد", "ok"); } catch (err) { toastErr(err); } });
    $("[data-close-conv]", chat)?.addEventListener("click", async () => { if (await confirm({ title: "إغلاق المحادثة", text: "سيتم وضع المحادثة في حالة مغلقة. أي رسالة جديدة من العميل تعيد فتحها.", okText: "إغلاق" })) { try { await api(`/conversations/${ref}`, { method: "PATCH", body: { status: "closed" } }); openConv(ref); } catch (e) { toastErr(e); } } });
    $("[data-reopen]", chat)?.addEventListener("click", async () => { try { await api(`/conversations/${ref}`, { method: "PATCH", body: { status: "replied" } }); openConv(ref); } catch (e) { toastErr(e); } });
    $("[data-msgs]", chat).addEventListener("click", async (e) => {
      if (e.target.closest("[data-older]")) {
        const b = e.target.closest("[data-older]"); b.disabled = true; b.textContent = "جارٍ التحميل…";
        try {
          const oldest = S.msgs[0]?.timestamp;
          const r = await api(`/conversations/${ref}/messages?limit=50&before=${oldest}`);
          if (!r.rows.length && state.meta.accounts.find((a) => a.id === S.current.accountId)?.type !== "cloud") { await api(`/conversations/${ref}/history`, { method: "POST" }); toast("طُلبت رسائل أقدم من الهاتف، ستظهر خلال ثوانٍ"); S.hasMore = false; }
          const box = $("[data-msgs]", chat); const prevH = box.scrollHeight;
          S.msgs = [...r.rows, ...S.msgs]; S.hasMore = r.hasMore; renderMessages(S.msgs, S.notes); box.scrollTop = box.scrollHeight - prevH;
        } catch (err) { toastErr(err); }
      }
    });
    const compose = $("[data-compose]", chat); if (!compose) return;
    const ta = $("[data-text]", compose); const quick = $("[data-quick]", compose);
    const autosize = () => { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 140) + "px"; };
    ta.addEventListener("input", () => { autosize(); if (ta.value.startsWith("/")) showQuick(ta.value.slice(1)); else quick.classList.add("hidden"); });
    ta.addEventListener("keydown", (e) => {
      if (!quick.classList.contains("hidden")) {
        const items = $$(".t", quick); let i = items.findIndex((x) => x.classList.contains("sel"));
        if (e.key === "ArrowDown") { e.preventDefault(); items[i]?.classList.remove("sel"); items[(i + 1) % items.length]?.classList.add("sel"); return; }
        if (e.key === "ArrowUp") { e.preventDefault(); items[i]?.classList.remove("sel"); items[(i - 1 + items.length) % items.length]?.classList.add("sel"); return; }
        if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); (items[i] || items[0])?.click(); return; }
        if (e.key === "Escape") { quick.classList.add("hidden"); return; }
      }
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
    });
    ta.addEventListener("paste", (e) => { const f = [...(e.clipboardData?.files || [])][0]; if (f) { e.preventDefault(); sendFile(f); } });
    $("[data-send]", compose).addEventListener("click", send);
    $("[data-note-toggle]", compose).addEventListener("click", () => { S.noteMode = !S.noteMode; compose.classList.toggle("note-mode", S.noteMode); ta.placeholder = S.noteMode ? "ملاحظة داخلية — لا تُرسل للعميل" : "اكتب رسالة…"; ta.focus(); });
    $("[data-attach]", compose).addEventListener("click", () => $("[data-file]", compose).click());
    $("[data-file]", compose).addEventListener("change", (e) => { if (e.target.files[0]) sendFile(e.target.files[0]); e.target.value = ""; });
    $("[data-quick-btn]", compose).addEventListener("click", () => (quick.classList.contains("hidden") ? showQuick("") : quick.classList.add("hidden")));
    const box = $("[data-msgs]", chat);
    box.addEventListener("dragover", (e) => { e.preventDefault(); }); box.addEventListener("drop", (e) => { e.preventDefault(); if (e.dataTransfer.files[0]) sendFile(e.dataTransfer.files[0]); });
    let templates = null;
    async function showQuick(f) {
      templates ??= await api("/templates?kind=quick").catch(() => []);
      const q = f.toLowerCase(); const list = templates.filter((t) => !q || t.title.toLowerCase().includes(q) || t.text.toLowerCase().includes(q));
      if (!list.length) return quick.classList.add("hidden");
      quick.innerHTML = list.map((t, i) => `<div class="t ${i === 0 ? "sel" : ""}" data-id="${t.id}"><b>${esc(t.title)}</b><span>${esc(t.text)}</span></div>`).join("");
      quick.classList.remove("hidden");
      $$(".t", quick).forEach((x) => x.addEventListener("click", () => { const t = templates.find((y) => y.id === x.dataset.id); ta.value = t.text.replaceAll("{name}", S.contact?.name || S.current.title).replaceAll("{{name}}", S.contact?.name || S.current.title); quick.classList.add("hidden"); autosize(); ta.focus(); }));
    }
    async function send() {
      const text = ta.value.trim(); if (!text) return;
      ta.value = ""; autosize(); quick.classList.add("hidden");
      try {
        if (S.noteMode) { const n = await api(`/conversations/${ref}/notes`, { method: "POST", body: { text } }); S.notes.unshift(n); renderMessages(S.msgs, S.notes); scrollBottom(); renderCtx(); toast("أُضيفت الملاحظة الداخلية", "ok"); }
        else { const m = await api(`/conversations/${ref}/send`, { method: "POST", body: { text } }); pushMsg(m); }
      } catch (e) { toastErr(e); ta.value = text; }
    }
    async function sendFile(file) {
      if (file.size > 64 * 1024 * 1024) return toast("حجم الملف يتجاوز 64 ميجابايت", "err");
      const caption = ta.value.trim(); ta.value = ""; autosize();
      const tmp = h(`<div class="msg out"><div class="media"><div class="state">⏳ جارٍ إرسال ${esc(file.name)}…</div></div></div>`); box.appendChild(tmp); scrollBottom();
      const fd = new FormData(); fd.append("file", file); fd.append("caption", caption);
      try { const m = await api(`/conversations/${ref}/send-media`, { method: "POST", form: fd }); tmp.remove(); pushMsg(m); } catch (e) { tmp.remove(); toastErr(e); }
    }
  }
  function pushMsg(m) {
    if (S.msgs.some((x) => x.id === m.id)) return;
    S.msgs.push(m); const box = $("[data-msgs]", chat); if (!box) return;
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    box.insertAdjacentHTML("beforeend", msgHtml(m)); if (atBottom || m.fromMe) scrollBottom();
  }

  // ---------- معلومات العميل ----------
  function renderCtx() {
    const c = S.current; if (!c) { ctx.innerHTML = ""; return; }
    const ct = S.contact;
    ctx.innerHTML = `
      <div class="ctx-head">${avatar(c.title, "lg")}<div class="name">${esc(ct?.name || c.title)}</div><div class="phone ltr">${esc(fmtPhone(c.phone))}</div>
        ${can("assign_conversation") && S.assignees ? `<div style="margin-top:8px"><select data-assign2 title="الموظف المسؤول"><option value="">— غير مُسندة —</option>${S.assignees.map((u) => `<option value="${u.id}" ${u.id === c.assignedTo ? "selected" : ""}>${esc(u.name)}</option>`).join("")}</select></div>` : ""}
        <div class="acts">${ct ? `<button class="btn small" data-open-contact>ملف العميل</button>${can("edit_contact") ? `<button class="btn small" data-edit-contact>تعديل</button>` : ""}` : can("create_contact") && !c.isGroup ? `<button class="btn small primary" data-create-contact>حفظ كعميل</button>` : ""}<button class="btn small" data-ctx-close style="display:none">إغلاق</button></div></div>
      ${ct ? `<div class="ctx-sec"><h4>البيانات</h4><dl class="kv">
        <dt>الشركة</dt><dd>${esc(ct.company || "—")}</dd><dt>المصدر</dt><dd>${esc(srcAr(ct.source))}</dd><dt>التصنيف</dt><dd>${esc(catLabel(ct.category))}</dd>
        <dt>الوسوم</dt><dd>${ct.tags.length ? ct.tags.map((t) => `<span class="tag">${esc(t.name)}</span>`).join(" ") : "—"}</dd>
        <dt>المسؤول</dt><dd>${esc(ct.assignedName || "—")}</dd><dt>آخر تواصل</dt><dd>${fmtDateTime(ct.lastContactAt)}</dd><dt>أُضيف</dt><dd>${fmtDate(ct.createdAt)}</dd></dl></div>` : ""}
      <div class="ctx-sec"><h4>ملاحظات داخلية ${can("send_message") ? `<button class="btn small ghost" data-add-note>+ إضافة</button>` : ""}</h4>${S.notes.length ? S.notes.slice(0, 5).map((n) => `<div class="note-item"><div class="by"><span>${esc(n.user_name)}</span><span>${fmtDateTime(n.created_at)}</span></div>${esc(n.text)}</div>`).join("") : '<div class="muted small">لا توجد ملاحظات</div>'}</div>
      ${ct ? `<div class="ctx-sec"><h4>المهام والمتابعات ${can("manage_tasks") ? `<button class="btn small ghost" data-add-task>+ إضافة</button>` : ""}</h4>${S.tasks.length ? S.tasks.map((t) => `<div class="task-item ${t.status}"><span>${t.type === "followup" ? "🔁" : "☑️"}</span><div><div>${esc(t.title)}</div><div class="due ${t.due_at && t.due_at < Date.now() && t.status === "open" ? "late" : ""}">${t.due_at ? fmtDateTime(t.due_at) : "بدون موعد"}${t.assignedName ? " · " + esc(t.assignedName) : ""}</div></div></div>`).join("") : '<div class="muted small">لا توجد مهام</div>'}</div>` : ""}
      ${S.assignments?.length ? `<div class="ctx-sec"><h4>سجل الإسناد</h4><div class="timeline">${S.assignments.slice(0, 5).map((a) => `<div class="ev"><time>${fmtDateTime(a.created_at)}</time><span>${esc(a.by_name || "")}: ${a.from_name ? esc(a.from_name) + " ← " : ""}${esc(a.to_name || "إلغاء الإسناد")}</span></div>`).join("")}</div></div>` : ""}`;
    $("[data-open-contact]", ctx)?.addEventListener("click", () => openContact(ct.id));
    $("[data-assign2]", ctx)?.addEventListener("change", async (e) => { try { await api(`/conversations/${c.ref}`, { method: "PATCH", body: { assignedTo: e.target.value } }); toast(e.target.value ? "تم إسناد المحادثة" : "تم إلغاء الإسناد", "ok"); } catch (err) { toastErr(err); } });
    $("[data-edit-contact]", ctx)?.addEventListener("click", () => openContactForm(ct, () => openConv(c.ref)));
    $("[data-create-contact]", ctx)?.addEventListener("click", () => openContactForm({ phone: c.phone, name: c.name }, () => openConv(c.ref)));
    $("[data-add-note]", ctx)?.addEventListener("click", () => addNoteDialog({ conversationRef: c.ref }, (n) => { S.notes.unshift(n); renderMessages(S.msgs, S.notes); renderCtx(); }));
    $("[data-add-task]", ctx)?.addEventListener("click", () => addTaskDialog({ contactId: ct.id }, (t) => { S.tasks.unshift(t); renderCtx(); }));
  }
  const srcAr = (s) => ({ whatsapp: "واتساب", website: "الموقع", referral: "إحالة", ads: "إعلانات", import: "استيراد", manual: "يدوي", other: "أخرى" })[s] || s || "—";

  // ---------- الأحداث اللحظية ----------
  const onNew = (e) => {
    const { accountId, message } = e.detail;
    if (S.current && S.current.accountId === accountId && message.chatRef === S.current.ref) pushMsg(message);
  };
  const onChat = (e) => {
    const { accountId, chat: c } = e.detail; if (!c) return;
    const title = c.name || (c.phone ? fmtPhone(c.phone) : "مجموعة");
    const row = { ...c, title, accountLabel: state.meta.accounts.find((a) => a.id === accountId)?.label };
    const i = S.rows.findIndex((r) => r.ref === c.ref);
    if (S.current?.ref === c.ref) { row.unread = 0; Object.assign(S.current, row); const b = $("[data-status-badge]", chat); if (b) { const st = CONV_STATUS[c.status] || ["", ""]; b.textContent = st[0]; b.className = `badge ${st[1]}`; } }
    if (i === -1) { if (S.page === 1 && !S.q) S.rows.unshift(row); } else S.rows[i] = { ...S.rows[i], ...row };
    S.rows.sort((a, b) => b.lastTimestamp - a.lastTimestamp); renderList();
  };
  const onStatus = (e) => { const { messageId, status, reason } = e.detail; const m = $(`[data-id="${CSS.escape(messageId)}"] .tick`, chat); if (m) { const st = MSG_STATUS[status] || ["", ""]; m.textContent = st[0]; m.title = st[1]; m.className = `tick ${status === "read" ? "read" : status === "failed" ? "failed" : ""}`; if (status === "failed" && reason) m.closest(".msg").insertAdjacentHTML("beforeend", `<div class="fail-reason">${esc(reason)}</div>`); } };
  const onMedia = (e) => { const { messageId } = e.detail; if (S.current && S.msgs.some((m) => m.id === messageId)) openConv(S.current.ref); };
  const onHistory = () => { loadList(); if (S.current) openConv(S.current.ref); };
  bus.addEventListener("message:new", onNew); bus.addEventListener("chat:update", onChat); bus.addEventListener("message:status", onStatus); bus.addEventListener("message:media", onMedia); bus.addEventListener("history:synced", onHistory);

  await loadList();
  if (ref) openConv(ref);
  return { destroy: () => { bus.removeEventListener("message:new", onNew); bus.removeEventListener("chat:update", onChat); bus.removeEventListener("message:status", onStatus); bus.removeEventListener("message:media", onMedia); bus.removeEventListener("history:synced", onHistory); } };
}
