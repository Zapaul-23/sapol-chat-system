// Tickets — กฎทางธุรกิจทั้งหมดของ Support: เปิดเรื่อง, ข้อความ, สถานะ, คะแนน
// โมดูลนี้ไม่รู้จัก Socket.IO / Express เลย (Gateway เป็นคนส่งข้อมูลออกไป)
// → ตอนรวมกับ Sapol Chat ย้ายไฟล์นี้ไปเป็น src/support.js ได้เกือบทั้งไฟล์
const crypto = require('crypto');
const { db, now, plain, transaction } = require('./db');
const events = require('./events');

const CATEGORIES = { general: 'สอบถามทั่วไป', technical: 'ปัญหาการใช้งาน', billing: 'การชำระเงิน' };
const STATUSES = { new: 'ใหม่', in_progress: 'กำลังดำเนินการ', resolved: 'แก้ไขแล้ว' };
const LIMITS = { name: 50, email: 100, subject: 100, text: 1000 };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const oneLine = (v) => String(v ?? '').trim().replace(/\s+/g, ' ');
const multiLine = (v) => String(v ?? '').replace(/\r\n/g, '\n').trim();
const fail = (error) => ({ ok: false, error });

// ---------- อ่านข้อมูล ----------
const getRow = (id) => plain(db.prepare('SELECT * FROM tickets WHERE id = ?').get(Number(id)));

/** ข้อมูล ticket ที่ส่งออกไปหน้าเว็บได้ (ไม่มี token) */
function view(row) {
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    customerName: row.customer_name,
    email: row.email,
    category: row.category,
    subject: row.subject,
    status: row.status,
    rating: row.rating,
    agentName: row.agent_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const toMessage = (m) => ({
  id: m.id, ticketId: m.ticket_id, sender: m.sender, senderName: m.sender_name, text: m.body, sentAt: m.sent_at,
});

function messages(ticketId) {
  return db.prepare('SELECT * FROM ticket_messages WHERE ticket_id = ? ORDER BY id').all(Number(ticketId)).map(toMessage);
}

/** ข้อมูลย่อสำหรับคิวของเจ้าหน้าที่: + ข้อความล่าสุด + จำนวนที่ยังไม่อ่าน */
function summary(ticketId) {
  const row = getRow(ticketId);
  if (!row) return null;
  const last = db.prepare('SELECT * FROM ticket_messages WHERE ticket_id = ? ORDER BY id DESC LIMIT 1').get(row.id);
  const unread = db
    .prepare("SELECT COUNT(*) AS n FROM ticket_messages WHERE ticket_id = ? AND sender = 'customer' AND id > ?")
    .get(row.id, row.agent_read_id).n;
  return { ...view(row), lastMessage: last ? toMessage(last) : null, unread };
}

function list({ status } = {}) {
  const ids = STATUSES[status]
    ? db.prepare('SELECT id FROM tickets WHERE status = ? ORDER BY updated_at DESC').all(status)
    : db.prepare('SELECT id FROM tickets ORDER BY updated_at DESC').all();
  return ids.map((r) => summary(r.id));
}

/** ตรวจ token ของลูกค้า (เทียบแบบเวลาคงที่ กันการเดาทีละตัวอักษร) */
function checkToken(ticketId, token) {
  const row = getRow(ticketId);
  if (!row || typeof token !== 'string') return false;
  const a = Buffer.from(row.token);
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- เขียนข้อมูล ----------
function insertMessage(ticketId, sender, senderName, text, at = now()) {
  const r = db
    .prepare('INSERT INTO ticket_messages (ticket_id, sender, sender_name, body, sent_at) VALUES (?, ?, ?, ?, ?)')
    .run(ticketId, sender, senderName, text, at);
  return toMessage({ id: Number(r.lastInsertRowid), ticket_id: ticketId, sender, sender_name: senderName, body: text, sent_at: at });
}

/** F1 — ลูกค้าเปิด ticket */
function create(input = {}) {
  const name = oneLine(input.name);
  const email = oneLine(input.email).toLowerCase();
  const category = String(input.category ?? '');
  const subject = oneLine(input.subject);
  const detail = multiLine(input.detail);

  if (!name) return fail('กรุณากรอกชื่อ');
  if (name.length > LIMITS.name) return fail(`ชื่อยาวเกิน ${LIMITS.name} ตัวอักษร`);
  if (!EMAIL_RE.test(email) || email.length > LIMITS.email) return fail('รูปแบบอีเมลไม่ถูกต้อง');
  if (!CATEGORIES[category]) return fail('กรุณาเลือกหมวดของปัญหา');
  if (!subject) return fail('กรุณากรอกหัวข้อ');
  if (subject.length > LIMITS.subject) return fail(`หัวข้อยาวเกิน ${LIMITS.subject} ตัวอักษร`);
  if (!detail) return fail('กรุณาอธิบายรายละเอียด');
  if (detail.length > LIMITS.text) return fail(`รายละเอียดยาวเกิน ${LIMITS.text.toLocaleString()} ตัวอักษร`);

  const token = crypto.randomBytes(16).toString('hex'); // 32 ตัว
  const at = now();
  const id = transaction(() => {
    const r = db
      .prepare(
        `INSERT INTO tickets (token, customer_name, email, category, subject, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(token, name, email, category, subject, at, at);
    const newId = Number(r.lastInsertRowid);
    db.prepare('UPDATE tickets SET code = ? WHERE id = ?').run(`CS-${String(newId).padStart(4, '0')}`, newId);
    insertMessage(newId, 'customer', name, detail, at);
    return newId;
  });

  events.record('TicketOpened', { ticketId: id, category }, at);
  return { ok: true, ticket: view(getRow(id)), token };
}

/** เปลี่ยนสถานะ + ข้อความระบบ (ใช้ภายใน transaction) */
function changeStatus(row, status, byName) {
  const at = now();
  const reopen = row.status === 'resolved' && status !== 'resolved';
  db.prepare(
    `UPDATE tickets SET status = ?, updated_at = ?,
       resolved_at = CASE WHEN ? = 'resolved' THEN ? ELSE resolved_at END,
       rating = CASE WHEN ? THEN NULL ELSE rating END
     WHERE id = ?`
  ).run(status, at, status, at, reopen ? 1 : 0, row.id);
  events.record('TicketStatusChanged', { ticketId: row.id, from: row.status, to: status, by: byName }, at);
  return insertMessage(row.id, 'system', 'ระบบ', `สถานะ: ${STATUSES[status]}${byName ? ` (โดย ${byName})` : ''}`, at);
}

/** F2 + กฎสถานะอัตโนมัติ — ส่งข้อความใน ticket (sender = 'customer' | 'agent') */
function addMessage(ticketId, sender, senderName, rawText) {
  const row = getRow(ticketId);
  if (!row) return fail('ไม่พบ ticket');
  const text = multiLine(rawText);
  if (!text) return fail('ข้อความว่าง');
  if (text.length > LIMITS.text) return fail(`ข้อความยาวเกิน ${LIMITS.text.toLocaleString()} ตัวอักษร`);

  const out = transaction(() => {
    const list = [];
    // จนท. ตอบ ticket ใหม่ → กำลังดำเนินการ (ข้อความระบบขึ้นก่อนคำตอบ)
    if (sender === 'agent' && row.status === 'new') list.push(changeStatus(row, 'in_progress', senderName));
    // ลูกค้าพิมพ์ต่อหลังแก้ไขแล้ว → เปิดเรื่องใหม่
    if (sender === 'customer' && row.status === 'resolved') list.push(changeStatus(row, 'in_progress', null));

    const msg = insertMessage(row.id, sender, senderName, text);
    list.push(msg);
    if (sender === 'agent') {
      db.prepare(
        `UPDATE tickets SET agent_name = ?, first_response_at = COALESCE(first_response_at, ?), updated_at = ? WHERE id = ?`
      ).run(senderName, msg.sentAt, msg.sentAt, row.id);
    } else {
      db.prepare('UPDATE tickets SET updated_at = ? WHERE id = ?').run(msg.sentAt, row.id);
    }
    return list;
  });

  events.record('MessageSent', { ticketId: row.id, sender, length: text.length });
  return { ok: true, messages: out, ticket: view(getRow(row.id)) };
}

/** F4 — เจ้าหน้าที่เปลี่ยนสถานะ */
function setStatus(ticketId, status, agentName) {
  const row = getRow(ticketId);
  if (!row) return fail('ไม่พบ ticket');
  if (!STATUSES[status]) return fail('สถานะไม่ถูกต้อง');
  if (row.status === status) return { ok: true, messages: [], ticket: view(row) };
  const msg = transaction(() => changeStatus(row, status, agentName));
  return { ok: true, messages: [msg], ticket: view(getRow(row.id)) };
}

/** F5 — ลูกค้าให้คะแนน (เฉพาะเรื่องที่แก้ไขแล้ว) */
function rate(ticketId, rating) {
  const row = getRow(ticketId);
  if (!row) return fail('ไม่พบ ticket');
  if (row.status !== 'resolved') return fail('ให้คะแนนได้เมื่อเรื่องได้รับการแก้ไขแล้ว');
  const n = Number(rating);
  if (!Number.isInteger(n) || n < 1 || n > 5) return fail('คะแนนต้องเป็น 1–5');
  const at = now();
  db.prepare('UPDATE tickets SET rating = ?, updated_at = ? WHERE id = ?').run(n, at, row.id);
  events.record('TicketRated', { ticketId: row.id, rating: n }, at);
  return { ok: true, messages: [], ticket: view(getRow(row.id)) };
}

/** เจ้าหน้าที่เปิดอ่าน ticket แล้ว → ล้างตัวนับยังไม่อ่าน */
function markRead(ticketId) {
  const last = db.prepare('SELECT MAX(id) AS id FROM ticket_messages WHERE ticket_id = ?').get(Number(ticketId)).id ?? 0;
  db.prepare('UPDATE tickets SET agent_read_id = ? WHERE id = ?').run(last, Number(ticketId));
}

module.exports = {
  CATEGORIES, STATUSES, LIMITS,
  create, addMessage, setStatus, rate, markRead,
  getRow, view, summary, list, messages, checkToken,
};
