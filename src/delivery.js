// Delivery & Receipts — สถานะ sent / delivered / read ต่อผู้รับ และคิวข้อความตอน offline
const { db, now } = require('./db');
const events = require('./events');

/** สรุปสถานะของข้อความ (รวมทุกผู้รับ) */
function status(messageId) {
  const r = db
    .prepare('SELECT COUNT(*) AS total, COUNT(delivered_at) AS delivered, COUNT(read_at) AS read FROM receipts WHERE message_id = ?')
    .get(messageId);
  const total = r.total;
  let s = 'sent';
  if (total > 0 && r.read === total) s = 'read';
  else if (total > 0 && r.delivered === total) s = 'delivered';
  return { messageId, status: s, total, deliveredCount: r.delivered, readCount: r.read };
}

const findReceipt = db.prepare(
  `SELECT r.message_id, r.queued, r.delivered_at, m.sent_at, m.sender_id, m.conversation_id
   FROM receipts r JOIN messages m ON m.id = r.message_id
   WHERE r.message_id = ? AND r.recipient_id = ?`
);
const setDelivered = db.prepare(
  'UPDATE receipts SET delivered_at = ? WHERE message_id = ? AND recipient_id = ? AND delivered_at IS NULL'
);

function deliver(userId, row, at) {
  if (setDelivered.run(at, row.message_id, userId).changes === 0) return false; // นับครั้งเดียว (กันหลายแท็บ)
  events.record('MessageDelivered', {
    userId,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    wasOffline: !!row.queued,
    latencyMs: Date.parse(at) - Date.parse(row.sent_at),
  }, at);
  return true;
}

/** เครื่องผู้รับยืนยันว่าได้รับข้อความแล้ว → คืนรายการที่สถานะเปลี่ยน */
function markDelivered(userId, messageIds) {
  const changed = [];
  const ids = [...new Set((Array.isArray(messageIds) ? messageIds : []).map(Number).filter(Number.isInteger))].slice(0, 500);
  for (const id of ids) {
    const row = findReceipt.get(id, userId);
    if (row && !row.delivered_at && deliver(userId, row, now())) {
      changed.push({ messageId: id, senderId: row.sender_id });
    }
  }
  return changed;
}

/** ผู้รับเปิดอ่าน conversation ถึงข้อความ upToMessageId → คืนรายการที่สถานะเปลี่ยน */
function markRead(userId, conversationId, upToMessageId) {
  const rows = db
    .prepare(
      `SELECT r.message_id, r.queued, r.delivered_at, m.sent_at, m.sender_id, m.conversation_id
       FROM receipts r JOIN messages m ON m.id = r.message_id
       WHERE r.recipient_id = ? AND m.conversation_id = ? AND m.id <= ? AND r.read_at IS NULL`
    )
    .all(userId, conversationId, upToMessageId);

  const changed = [];
  const setRead = db.prepare('UPDATE receipts SET read_at = ? WHERE message_id = ? AND recipient_id = ? AND read_at IS NULL');
  for (const row of rows) {
    const at = now();
    let deliveredAt = row.delivered_at;
    if (!deliveredAt) {                   // อ่านก่อนยืนยันได้รับ → บันทึก delivered ด้วย
      deliver(userId, row, at);
      deliveredAt = at;
    }
    if (setRead.run(at, row.message_id, userId).changes === 0) continue;
    events.record('MessageRead', {
      userId,
      conversationId: row.conversation_id,
      messageId: row.message_id,
      readDelayMs: Date.parse(at) - Date.parse(deliveredAt),
    }, at);
    changed.push({ messageId: row.message_id, senderId: row.sender_id });
  }
  return changed;
}

/** id ข้อความที่ค้างส่งถึงผู้ใช้คนนี้ (ตอนเขา offline) */
function pendingIds(userId) {
  return db
    .prepare('SELECT message_id FROM receipts WHERE recipient_id = ? AND delivered_at IS NULL ORDER BY message_id')
    .all(userId)
    .map((r) => r.message_id);
}

module.exports = { status, markDelivered, markRead, pendingIds };
