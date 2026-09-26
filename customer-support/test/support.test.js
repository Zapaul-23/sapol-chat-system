// ทดสอบอัตโนมัติ Sapol Support — รันด้วย: npm test
process.env.DB_FILE = ':memory:'; // ฐานข้อมูลชั่วคราว ไม่ยุ่งกับ data/support.db
process.env.AGENT_KEY = 'test-key';
const test = require('node:test');
const assert = require('node:assert/strict');
const { io: connect } = require('socket.io-client');
const { server, io } = require('../src/server');

let url;
const clients = [];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ask = (s, ev, data) => new Promise((r) => s.emit(ev, data, r));

async function socket() {
  const s = connect(url, { forceNew: true, transports: ['websocket'] });
  clients.push(s);
  s.got = { message: [], ticket: [], new: [], updated: [] };
  s.on('message', (m) => s.got.message.push(m));
  s.on('ticket', (t) => s.got.ticket.push(t));
  s.on('ticket:new', (t) => s.got.new.push(t));
  s.on('ticket:updated', (t) => s.got.updated.push(t));
  await new Promise((r) => s.on('connect', r));
  return s;
}

async function agent(name = 'Ann') {
  const s = await socket();
  const r = await ask(s, 'agent:login', { name, agentKey: 'test-key' });
  assert.equal(r.ok, true, r.error);
  return s;
}

const form = (over = {}) => ({
  name: 'HAT', email: 'hat@mail.com', category: 'technical', subject: 'เข้าเว็บไม่ได้', detail: 'เข้าไม่ได้ตั้งแต่เช้า', ...over,
});

async function openTicket(over) {
  const res = await fetch(`${url}/api/tickets`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form(over)),
  });
  return { status: res.status, body: await res.json() };
}

async function customer(t) {
  const s = await socket();
  const r = await ask(s, 'join', { ticketId: t.id, token: t.token });
  assert.equal(r.ok, true, r.error);
  return s;
}

test.before(async () => {
  await new Promise((r) => server.listen(0, r));
  url = `http://localhost:${server.address().port}`;
});
test.after(async () => {
  clients.forEach((c) => c.close());
  io.close();
});

test('#1 เปิด ticket ได้เลข CS-xxxx และ token', async () => {
  const { status, body } = await openTicket();
  assert.equal(status, 201);
  assert.match(body.code, /^CS-\d{4}$/);
  assert.equal(body.token.length, 32);
});

test('#2 ข้อมูลไม่ครบ / อีเมลผิด / หัวข้อยาวเกิน ถูกปฏิเสธ', async () => {
  for (const bad of [{ subject: '   ' }, { email: 'hat@' }, { subject: 'ก'.repeat(101) }, { category: 'x' }, { detail: '' }]) {
    const { status, body } = await openTicket(bad);
    assert.equal(status, 400, JSON.stringify(bad));
    assert.equal(body.ok, false);
  }
});

test('#3 จนท. เห็น ticket ใหม่ทันที', async () => {
  const a = await agent();
  const { body } = await openTicket({ subject: 'ชำระเงินไม่ผ่าน', category: 'billing' });
  await wait(100);
  const got = a.got.new.find((t) => t.id === body.id);
  assert.ok(got);
  assert.equal(got.status, 'new');
  assert.equal(got.unread, 1);
  assert.equal(got.token, undefined, 'ต้องไม่ส่ง token ให้ จนท.');
});

test('#4 #6 แชทสองฝั่ง + จนท. ตอบครั้งแรกแล้วสถานะเป็นกำลังดำเนินการ', async () => {
  const { body: t } = await openTicket();
  const c = await customer(t);
  const a = await agent();
  assert.equal((await ask(a, 'join', { ticketId: t.id })).ok, true);

  assert.equal((await ask(a, 'message', { ticketId: t.id, text: 'ลองล้างแคชดูครับ' })).ok, true);
  await wait(100);
  assert.deepEqual(c.got.message.map((m) => m.sender), ['system', 'agent']);
  assert.equal(c.got.ticket.at(-1).status, 'in_progress');

  assert.equal((await ask(c, 'message', { ticketId: t.id, text: 'ได้แล้วครับ' })).ok, true);
  await wait(100);
  assert.equal(a.got.message.at(-1).text, 'ได้แล้วครับ');
});

test('#5 ประวัติข้อความโหลดกลับมาได้ครบ', async () => {
  const { body: t } = await openTicket();
  const c = await customer(t);
  await ask(c, 'message', { ticketId: t.id, text: 'ข้อความที่ 2' });
  const res = await (await fetch(`${url}/api/tickets/${t.id}?token=${t.token}`)).json();
  assert.deepEqual(res.messages.map((m) => m.text), ['เข้าไม่ได้ตั้งแต่เช้า', 'ข้อความที่ 2']);
});

test('#7 แก้ไขแล้ว → ลูกค้าให้ดาว → จนท. เห็น', async () => {
  const { body: t } = await openTicket();
  const c = await customer(t);
  const a = await agent();
  assert.equal((await ask(c, 'rate', { ticketId: t.id, rating: 5 })).ok, false, 'ยังไม่ resolved ห้ามให้ดาว');
  assert.equal((await ask(a, 'status', { ticketId: t.id, status: 'resolved' })).ok, true);
  assert.equal((await ask(c, 'rate', { ticketId: t.id, rating: 9 })).ok, false);
  assert.equal((await ask(c, 'rate', { ticketId: t.id, rating: 4 })).ok, true);
  await wait(100);
  assert.equal(a.got.updated.filter((x) => x.id === t.id).at(-1).rating, 4);
});

test('#8 ลูกค้าพิมพ์ต่อหลังแก้ไขแล้ว → เปิดเรื่องใหม่และล้างดาว', async () => {
  const { body: t } = await openTicket();
  const c = await customer(t);
  const a = await agent();
  await ask(a, 'status', { ticketId: t.id, status: 'resolved' });
  await ask(c, 'rate', { ticketId: t.id, rating: 3 });
  await ask(c, 'message', { ticketId: t.id, text: 'กลับมาเป็นอีกแล้ว' });
  await wait(100);
  const last = c.got.ticket.at(-1);
  assert.equal(last.status, 'in_progress');
  assert.equal(last.rating, null);
});

test('#9 token ผิด / เดาเลข ticket ดูของคนอื่นไม่ได้', async () => {
  const { body: t } = await openTicket();
  const res = await fetch(`${url}/api/tickets/${t.id}?token=${'0'.repeat(32)}`);
  assert.equal(res.status, 404);
  const s = await socket();
  assert.equal((await ask(s, 'join', { ticketId: t.id, token: 'wrong' })).ok, false);
  assert.equal((await ask(s, 'message', { ticketId: t.id, text: 'แอบส่ง' })).ok, false);

  const { body: other } = await openTicket();
  const c = await customer(t);
  assert.equal((await ask(c, 'message', { ticketId: other.id, text: 'ข้าม ticket' })).ok, false);
  assert.equal((await ask(c, 'status', { ticketId: t.id, status: 'resolved' })).ok, false, 'ลูกค้าเปลี่ยนสถานะเองไม่ได้');
});

test('#10 รหัส จนท. ผิดเข้าไม่ได้ (Socket และ REST)', async () => {
  const s = await socket();
  assert.equal((await ask(s, 'agent:login', { name: 'X', agentKey: 'nope' })).ok, false);
  assert.equal((await fetch(`${url}/api/agent/tickets`)).status, 401);
  const ok = await fetch(`${url}/api/agent/tickets`, { headers: { 'x-agent-key': 'test-key' } });
  assert.equal(ok.status, 200);
});

test('#11 ข้อความ HTML ถูกเก็บเป็นตัวอักษรตามเดิม (หน้าเว็บแสดงด้วย textContent)', async () => {
  const evil = '<img src=x onerror=alert(1)>';
  const { body: t } = await openTicket({ subject: evil });
  const res = await (await fetch(`${url}/api/tickets/${t.id}?token=${t.token}`)).json();
  assert.equal(res.ticket.subject, evil);
});

test('#12 ส่งเร็วเกินไปถูกจำกัด', async () => {
  const { body: t } = await openTicket();
  const c = await customer(t);
  const results = [];
  for (let i = 0; i < 7; i++) results.push(await ask(c, 'message', { ticketId: t.id, text: `m${i}` }));
  assert.ok(results.some((r) => !r.ok));
});
