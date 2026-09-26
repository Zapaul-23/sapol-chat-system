// ทดสอบอัตโนมัติ PDCA รอบที่ 3 — รันด้วย: npm test
process.env.DB_FILE = ':memory:';               // ใช้ฐานข้อมูลชั่วคราว ไม่ยุ่งกับ data/chat.db
const test = require('node:test');
const assert = require('node:assert/strict');
const { io: connect } = require('socket.io-client');
const { server, io } = require('../src/server');
const { metrics } = require('../src/analytics');

let url;
const clients = [];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ask = (s, ev, data) => new Promise((r) => s.emit(ev, data, r));

/** เปิดการเชื่อมต่อใหม่ + เข้าสู่ระบบ และเก็บ event ที่ได้รับไว้ตรวจ */
async function user(name, { autoDeliver = true } = {}) {
  const s = connect(url, { forceNew: true, transports: ['websocket'] });
  clients.push(s);
  s.got = { message: [], status: [], conv: [], removed: [], typing: [] };
  s.on('message:new', (m) => {
    s.got.message.push(m);
    if (autoDeliver && m.sender !== name) s.emit('message:delivered', { messageIds: [m.id] });
  });
  s.on('message:status', (x) => s.got.status.push(x));
  s.on('conversation:updated', (c) => s.got.conv.push(c));
  s.on('conversation:removed', (x) => s.got.removed.push(x));
  s.on('typing', (x) => s.got.typing.push(x));
  await new Promise((r) => s.on('connect', r));
  const res = await ask(s, 'auth', { username: name });
  assert.equal(res.ok, true, res.error);
  s.user = res.user;
  s.auth = res;
  return s;
}
const send = (s, conversationId, text, clientId = `${Date.now()}-${Math.random()}`) =>
  ask(s, 'message:send', { conversationId, clientId, type: 'text', text });
const lastStatus = (s, id) => s.got.status.filter((x) => x.messageId === id).at(-1)?.status;

test.before(async () => {
  await new Promise((r) => server.listen(0, r));
  url = `http://localhost:${server.address().port}`;
});
test.after(async () => {
  clients.forEach((c) => c.close());
  io.close();
});

let hat, ann, bob, dmId;

test('#13 DM: ส่งถึงเฉพาะคู่สนทนา', async () => {
  hat = await user('HAT'); ann = await user('Ann'); bob = await user('Bob');
  const dm = await ask(hat, 'dm:open', { username: 'ann' });           // ไม่สนตัวพิมพ์เล็ก/ใหญ่
  assert.equal(dm.ok, true);
  dmId = dm.conversation.id;
  assert.equal(dm.conversation.name, 'Ann');
  const r = await send(hat, dmId, 'สวัสดี Ann');
  assert.equal(r.ok, true);
  await wait(150);
  assert.ok(ann.got.message.some((m) => m.text === 'สวัสดี Ann'));
  assert.ok(!bob.got.message.some((m) => m.text === 'สวัสดี Ann'));
});

test('#14 เปิด DM กับคนเดิมซ้ำ ได้ห้องเดิม', async () => {
  const again = await ask(ann, 'dm:open', { username: 'HAT' });
  assert.equal(again.conversation.id, dmId);
  const self = await ask(hat, 'dm:open', { username: 'HAT' });
  assert.equal(self.ok, false);
  const nobody = await ask(hat, 'dm:open', { username: 'ไม่มีคนนี้' });
  assert.equal(nobody.ok, false);
});

test('#16 ผู้รับ online: sent → delivered → read', async () => {
  const r = await send(hat, dmId, 'ข้อความทดสอบสถานะ');
  assert.equal(r.message.receipt.status, 'sent');
  await wait(150);
  assert.equal(lastStatus(hat, r.message.id), 'delivered');
  ann.emit('message:read', { conversationId: dmId, upToMessageId: r.message.id });
  await wait(150);
  assert.equal(lastStatus(hat, r.message.id), 'read');
});

test('#17 ผู้รับ offline: ข้อความรอในคิว แล้วถึงเมื่อกลับมา', async () => {
  ann.close();
  await wait(150);
  const r = await send(hat, dmId, 'ส่งตอน Ann offline');
  await wait(150);
  assert.equal(lastStatus(hat, r.message.id), undefined);            // ยังไม่มีการเปลี่ยนสถานะ (ค้างที่ sent)
  ann = await user('Ann');                                            // กลับมา online
  await wait(200);
  assert.ok(ann.got.message.some((m) => m.id === r.message.id));
  assert.equal(lastStatus(hat, r.message.id), 'delivered');
});

test('#18 เปิด 2 แท็บ: ได้ทั้งคู่ แต่นับ delivered ครั้งเดียว', async () => {
  const ann2 = await user('Ann');
  const r = await send(hat, dmId, 'สองแท็บ');
  await wait(200);
  assert.ok(ann.got.message.some((m) => m.id === r.message.id));
  assert.ok(ann2.got.message.some((m) => m.id === r.message.id));
  const m = metrics({ days: 1 });
  const deliveredEvents = m.q4_deliveryLatency.all.count;
  ann2.emit('message:delivered', { messageIds: [r.message.id] });     // ยืนยันซ้ำ
  await wait(100);
  assert.equal(metrics({ days: 1 }).q4_deliveryLatency.all.count, deliveredEvents);
  ann2.close();
});

test('#15 ประวัติข้อความเรียงถูกและแบ่งหน้าได้', async () => {
  const h = await ask(ann, 'history:get', { conversationId: dmId, limit: 2 });
  assert.equal(h.ok, true);
  assert.equal(h.messages.length, 2);
  assert.equal(h.hasMore, true);
  assert.ok(h.messages[0].id < h.messages[1].id);
  const older = await ask(ann, 'history:get', { conversationId: dmId, beforeId: h.messages[0].id, limit: 10 });
  assert.ok(older.messages.every((m) => m.id < h.messages[0].id));
  const denied = await ask(bob, 'history:get', { conversationId: dmId });
  assert.equal(denied.ok, false);                                     // Bob ไม่ใช่สมาชิก
});

let groupId;
test('#19 กลุ่ม: สร้าง, ส่ง, ลบสมาชิกแล้วไม่ได้รับข้อความใหม่', async () => {
  const g = await ask(hat, 'group:create', { name: 'ทีมโปรเจกต์', usernames: ['Ann', 'Bob'] });
  assert.equal(g.ok, true);
  groupId = g.conversation.id;
  assert.equal(g.conversation.members.length, 3);
  assert.equal(g.conversation.myRole, 'admin');

  const r1 = await send(hat, groupId, 'สวัสดีกลุ่ม');
  await wait(150);
  assert.ok(bob.got.message.some((m) => m.id === r1.message.id));
  assert.equal(lastStatus(hat, r1.message.id), 'delivered');         // ถึงครบทั้ง 2 คน

  const rm = await ask(hat, 'group:removeMember', { conversationId: groupId, username: 'Bob' });
  assert.equal(rm.ok, true);
  await wait(100);
  assert.ok(bob.got.removed.some((x) => x.conversationId === groupId));
  const r2 = await send(hat, groupId, 'หลังลบ Bob');
  await wait(150);
  assert.ok(!bob.got.message.some((m) => m.id === r2.message.id));
  assert.equal((await send(bob, groupId, 'ยังส่งได้ไหม')).ok, false);
});

test('#20 สมาชิกที่ไม่ใช่ admin ลบ/เพิ่มคนอื่นไม่ได้ แต่ออกเองได้', async () => {
  const add = await ask(hat, 'group:addMember', { conversationId: groupId, username: 'Bob' });
  assert.equal(add.ok, true);
  assert.equal((await ask(ann, 'group:removeMember', { conversationId: groupId, username: 'Bob' })).ok, false);
  assert.equal((await ask(ann, 'group:addMember', { conversationId: groupId, username: 'HAT' })).ok, false);
  assert.equal((await ask(bob, 'group:removeMember', { conversationId: groupId, username: 'Bob' })).ok, true);
  const general = hat.auth.conversations.find((c) => c.isDefault);
  assert.equal((await ask(hat, 'group:removeMember', { conversationId: general.id, username: 'Ann' })).ok, false);
});

test('#21 ข้อความว่าง / ไม่ใช่สมาชิก → ปฏิเสธและบันทึก MessageSendFailed', async () => {
  const before = metrics({ days: 1 }).q5_sendFailures.failed;
  assert.equal((await send(hat, dmId, '   ')).reason, 'empty');
  assert.equal((await send(bob, dmId, 'แอบส่ง')).reason, 'not_member');
  assert.equal((await send(hat, dmId, 'x'.repeat(1001))).reason, 'too_long');
  assert.equal(metrics({ days: 1 }).q5_sendFailures.failed, before + 3);
});

test('#22 ส่งซ้ำด้วย clientId เดิม ได้ข้อความเดียว', async () => {
  const a = await send(hat, dmId, 'ครั้งเดียวพอ', 'same-id-1');
  const b = await send(hat, dmId, 'ครั้งเดียวพอ', 'same-id-1');
  assert.equal(a.message.id, b.message.id);
  assert.equal(b.ok, true);
});

test('#23 dashboard metrics ตอบ Q1–Q6 ได้', async () => {
  ann.emit('message:read', { conversationId: dmId, upToMessageId: 1e9 });
  await wait(150);
  const res = await fetch(`${url}/api/metrics?days=7`);
  const m = await res.json();
  assert.ok(m.q1_messagesPerDay.total >= 7);
  assert.ok(m.q2_activeUsers.mau >= 2);            // HAT ส่ง + Ann อ่าน (ข้อความของ Bob ถูกปฏิเสธทั้งหมด)
  assert.ok(m.q3_mostActiveConversations.length >= 2);
  assert.ok(m.q4_deliveryLatency.recipientOffline.count >= 1);
  assert.ok(m.q5_sendFailures.failedPct > 0);
  assert.ok(m.q6_timeToRead.count >= 1);
});

test('รอบ 2: กำลังพิมพ์ส่งให้คนอื่นในห้องเท่านั้น', async () => {
  hat.emit('typing', { conversationId: dmId, isTyping: true });
  await wait(100);
  assert.ok(ann.got.typing.some((t) => t.username === 'HAT' && t.conversationId === dmId));
  assert.ok(!bob.got.typing.some((t) => t.conversationId === dmId));
  assert.ok(!hat.got.typing.length);
});
