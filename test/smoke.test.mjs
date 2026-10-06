// اختبار شامل للـ API: يشغّل الخادم على مجلد بيانات مؤقت ويتحقق من المسارات والصلاحيات
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const PORT = 3900 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "wh-test-"));
const APP_SECRET = "test-app-secret";
let server;

// عميل HTTP بسيط مع كوكي جلسة
function client() {
  let cookie = "";
  return async (method, p, body, { form, raw } = {}) => {
    const headers = { cookie };
    if (body && !form) headers["content-type"] = "application/json";
    const res = await fetch(BASE + p, { method, headers, body: form || (body ? JSON.stringify(body) : undefined) });
    const sc = res.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
    const ct = res.headers.get("content-type") || "";
    const data = raw ? await res.text() : ct.includes("json") ? await res.json() : await res.text();
    return { status: res.status, data };
  };
}
const admin = client(), agent = client(), sup = client(), anon = client();

before(async () => {
  server = spawn(process.execPath, ["src/server.js"], { env: { ...process.env, PORT, DATA_DIR: DATA, META_APP_SECRET: APP_SECRET, META_VERIFY_TOKEN: "vt" }, stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((res, rej) => { server.stdout.on("data", (d) => d.toString().includes("يعمل") && res()); server.stderr.on("data", (d) => process.stderr.write(d)); setTimeout(() => rej(new Error("server did not start")), 15000); });
});
after(() => { server.kill(); fs.rmSync(DATA, { recursive: true, force: true }); });

test("الإعداد الأول وتسجيل الدخول", async () => {
  assert.equal((await anon("GET", "/api/auth")).data.setupRequired, true);
  const r = await admin("POST", "/api/setup", { name: "المدير", username: "admin", password: "secret12" });
  assert.equal(r.status, 200); assert.equal(r.data.user.role, "super_admin");
  assert.equal((await anon("POST", "/api/setup", { name: "x", username: "x1", password: "secret12" })).status, 400);
  assert.equal((await anon("POST", "/api/login", { username: "admin", password: "wrong" })).status, 401);
  assert.equal((await anon("GET", "/api/contacts")).status, 401);
  assert.equal((await anon("GET", "/api/nope")).status, 401);
  assert.equal((await admin("GET", "/api/nope")).status, 404);
});

let contactId, agentId, supId, tagId, listId;
test("العملاء: توحيد الأرقام ومنع التكرار والبحث", async () => {
  const a = await admin("POST", "/api/contacts", { phone: "0501234567", name: "أحمد علي", company: "النور", category: "interested", tagNames: ["دورة أ"] });
  assert.equal(a.status, 201); assert.equal(a.data.contact.phone, "966501234567"); contactId = a.data.contact.id;
  const dup = await admin("POST", "/api/contacts", { phone: "+966 50 123 4567", name: "مكرر" });
  assert.equal(dup.status, 200); assert.equal(dup.data.created, false); assert.equal(dup.data.contact.id, contactId);
  assert.equal((await admin("POST", "/api/contacts", { phone: "123", name: "خطأ" })).status, 400);
  assert.equal((await admin("GET", "/api/contacts?q=" + encodeURIComponent("احمد"))).data.total, 1); // تطبيع الهمزة
  assert.equal((await admin("GET", "/api/contacts?q=501234")).data.total, 1);
  assert.equal((await admin("GET", "/api/contacts?category=interested")).data.total, 1);
  tagId = (await admin("GET", "/api/tags")).data[0].id;
  listId = (await admin("POST", "/api/lists", { name: "دفعة أكتوبر" })).data.id;
  assert.equal((await admin("POST", "/api/contacts/bulk", { ids: [contactId], action: "add_to_list", payload: { listId } })).data.affected, 1);
  assert.equal((await admin("GET", `/api/contacts?listId=${listId}`)).data.total, 1);
  const prof = (await admin("GET", `/api/contacts/${contactId}`)).data;
  assert.equal(prof.contact.lists[0].name, "دفعة أكتوبر"); assert.ok(prof.activity.length >= 1);
});

test("الاستيراد: معاينة ثم تنفيذ", async () => {
  const csv = "الاسم,الجوال,الوسوم\nسارة,0555555555,\"a,b\"\nخالد,05-666-66666,\nمكرر,0501234567,\nخطأ,123,\n";
  const form = new FormData(); form.append("file", new Blob([csv], { type: "text/csv" }), "c.csv");
  const prev = await admin("POST", "/api/contacts/import/preview", null, { form });
  assert.equal(prev.status, 200); assert.equal(prev.data.preview.newCount, 2); assert.equal(prev.data.preview.existing, 1); assert.equal(prev.data.preview.invalid, 1);
  const run = await admin("POST", "/api/contacts/import/run", { token: prev.data.token, mapping: { phone: "الجوال", name: "الاسم", tags: "الوسوم" } });
  assert.deepEqual([run.data.created, run.data.skipped, run.data.invalid], [2, 1, 1]);
  assert.equal((await admin("GET", "/api/contacts")).data.total, 3);
  const exp = await admin("GET", "/api/contacts/export", null, { raw: true });
  assert.equal(exp.status, 200); assert.ok(exp.data.includes("+966555555555"));
});

test("المستخدمون والأدوار ونطاق الرؤية وإخفاء الأرقام", async () => {
  supId = (await admin("POST", "/api/users", { name: "مشرف", username: "sup1", password: "secret12", role: "supervisor" })).data.id;
  agentId = (await admin("POST", "/api/users", { name: "موظف", username: "agent1", password: "secret12", role: "agent", supervisorId: supId })).data.id;
  assert.equal((await agent("POST", "/api/login", { username: "agent1", password: "secret12" })).status, 200);
  assert.equal((await sup("POST", "/api/login", { username: "sup1", password: "secret12" })).status, 200);
  assert.equal((await agent("GET", "/api/users")).status, 403);
  assert.equal((await agent("GET", "/api/contacts/export")).status, 403);
  assert.equal((await agent("POST", "/api/campaigns", { name: "x", accountId: "y" })).status, 403);
  assert.equal((await agent("GET", "/api/contacts")).data.total, 0);
  await admin("PATCH", `/api/contacts/${contactId}`, { assignedTo: agentId });
  const mine = (await agent("GET", "/api/contacts")).data;
  assert.equal(mine.total, 1); assert.equal(mine.rows[0].phoneMasked, true); assert.match(mine.rows[0].phone, /^9665\*+567$/);
  assert.equal((await sup("GET", "/api/contacts")).data.total, 1); // المشرف يرى فريقه
  assert.equal((await sup("GET", "/api/contacts")).data.rows[0].phoneMasked, false);
  // مصفوفة الصلاحيات: منح الموظف عرض الأرقام ثم سحبها
  const roles = (await admin("GET", "/api/roles")).data.roles; const ag = roles.find((r) => r.id === "agent");
  await admin("PATCH", "/api/roles/agent", { permissions: [...ag.permissions, "view_phone_numbers"] });
  assert.equal((await agent("GET", "/api/contacts")).data.rows[0].phoneMasked, false);
  await admin("PATCH", "/api/roles/agent", { permissions: ag.permissions });
  assert.equal((await agent("GET", "/api/contacts")).data.rows[0].phoneMasked, true);
  assert.equal((await admin("PATCH", "/api/roles/super_admin", { permissions: [] })).status, 400);
  // تغيير كلمة المرور يُنهي الجلسة
  await admin("PATCH", `/api/users/${agentId}`, { password: "newpass12" });
  assert.equal((await agent("GET", "/api/contacts")).status, 401);
  assert.equal((await agent("POST", "/api/login", { username: "agent1", password: "newpass12" })).status, 200);
});

test("الملاحظات والمهام والسجل", async () => {
  const n = await agent("POST", `/api/contacts/${contactId}/notes`, { text: "ملاحظة داخلية" });
  assert.equal(n.status, 200); assert.equal(n.data.user_name, "موظف");
  const t = await agent("POST", "/api/tasks", { title: "متابعة", contactId, type: "followup", dueAt: Date.now() + 3600e3 });
  assert.equal(t.status, 200); assert.equal(t.data.status, "open");
  assert.equal((await agent("GET", "/api/tasks?status=open")).data.total, 1);
  const audit = (await admin("GET", "/api/audit")).data;
  assert.ok(audit.rows.some((r) => r.action === "contact.import") && audit.rows.some((r) => r.action === "role.update"));
  assert.equal((await agent("GET", "/api/audit")).status, 403);
});

test("القوالب والردود التلقائية والإعدادات", async () => {
  const tpl = await admin("POST", "/api/templates", { title: "ترحيب", text: "أهلًا {{name}}", kind: "quick" });
  assert.equal(tpl.status, 200);
  assert.equal((await agent("POST", "/api/templates", { title: "x", text: "y" })).status, 403);
  assert.equal((await admin("POST", "/api/rules", { trigger: "keyword", keywords: "السعر", reply: "الأسعار..." })).status, 200);
  assert.equal((await admin("POST", "/api/rules", { trigger: "bogus", reply: "x" })).status, 400);
  assert.equal((await admin("POST", "/api/settings", { defaultCountryCode: "971", agentsSeeUnassigned: false })).status, 200);
  assert.equal((await admin("GET", "/api/settings")).data.defaultCountryCode, "971");
  await admin("POST", "/api/settings", { defaultCountryCode: "966", agentsSeeUnassigned: true });
});

test("Webhook: التحقق من التوقيع ومنع التكرار", async () => {
  assert.equal((await fetch(`${BASE}/webhooks/cloud?hub.mode=subscribe&hub.verify_token=vt&hub.challenge=abc`)).status, 200);
  assert.equal((await fetch(`${BASE}/webhooks/cloud?hub.mode=subscribe&hub.verify_token=bad&hub.challenge=abc`)).status, 403);
  const body = JSON.stringify({ entry: [{ changes: [{ value: { metadata: { phone_number_id: "none" }, messages: [{ id: "wamid.1", from: "966500000000", type: "text", text: { body: "hi" }, timestamp: "1" }] } }] }] });
  assert.equal((await fetch(`${BASE}/webhooks/cloud`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=bad" }, body })).status, 401);
  const sig = "sha256=" + crypto.createHmac("sha256", APP_SECRET).update(body).digest("hex");
  assert.equal((await fetch(`${BASE}/webhooks/cloud`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": sig }, body })).status, 200);
});

test("الحملات: الجمهور والأهلية والمسودة وبدء بلا رقم متصل", async () => {
  const acc = await admin("POST", "/api/accounts", { label: "تجربة", type: "qr" });
  assert.equal(acc.status, 200);
  await admin("POST", "/api/contacts/bulk", { ids: [contactId], action: "set_opt_in", payload: { optIn: false } });
  const aud = (await admin("POST", "/api/campaigns/audience", { audience: { listIds: [listId], tagIds: [tagId] } })).data;
  assert.equal(aud.summary.total, 1); assert.equal(aud.summary.optOut, 1); assert.equal(aud.summary.eligible, 0);
  await admin("POST", "/api/contacts/bulk", { ids: [contactId], action: "set_opt_in", payload: { optIn: true } });
  const c = await admin("POST", "/api/campaigns", { name: "حملة", accountId: acc.data.id, audience: { listIds: [listId] }, messageText: "مرحبًا {{name}}", delayMs: 1000 });
  assert.equal(c.status, 200); assert.equal(c.data.status, "draft"); assert.equal(c.data.delayMs, 2500); // الحد الأدنى للتأخير
  const pv = (await admin("POST", `/api/campaigns/${c.data.id}/preview`)).data;
  assert.equal(pv.sample[0].text, "مرحبًا أحمد علي");
  const st = await admin("POST", `/api/campaigns/${c.data.id}/start`);
  assert.equal(st.status, 200);
  await new Promise((r) => setTimeout(r, 1500));
  const rep = (await admin("GET", `/api/campaigns/${c.data.id}`)).data;
  assert.equal(rep.campaign.status, "paused"); // الرقم غير متصل → توقف آمن بدل إفشال الكل
  const recs = (await admin("GET", `/api/campaigns/${c.data.id}/recipients`)).data;
  assert.equal(recs.rows[0].status, "failed"); assert.match(recs.rows[0].reason, /غير متصل/);
  assert.equal((await admin("POST", `/api/campaigns/${c.data.id}/retry`)).data.retried, 1);
  await new Promise((r) => setTimeout(r, 1200));
  await admin("POST", `/api/campaigns/${c.data.id}/pause`);
  assert.equal((await admin("DELETE", `/api/campaigns/${c.data.id}`)).status, 200);
  await admin("DELETE", `/api/accounts/${acc.data.id}`);
});

test("لوحة التحكم والبحث الشامل", async () => {
  const s = (await admin("GET", "/api/dashboard/summary")).data;
  assert.equal(s.contacts.total, 3); assert.equal(s.users.active, 3);
  assert.equal((await admin("GET", "/api/dashboard/series?days=7")).data.contacts.length, 7);
  assert.ok((await admin("GET", "/api/dashboard/breakdowns")).data.agents.length >= 1);
  assert.equal((await admin("GET", "/api/search?q=" + encodeURIComponent("سارة"))).data.contacts.length, 1);
  assert.equal((await agent("GET", "/api/dashboard/breakdowns")).status, 403);
});
