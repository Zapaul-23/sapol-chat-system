// Event Log — บันทึก Domain Event แบบเพิ่มอย่างเดียว (ใช้ตอบ Business Questions)
const { db, now } = require('./db');

const insert = db.prepare(
  'INSERT INTO events (type, occurred_at, user_id, conversation_id, message_id, payload) VALUES (?, ?, ?, ?, ?, ?)'
);

/**
 * record('MessageSent', { userId, conversationId, messageId, ...ข้อมูลเพิ่มเติม })
 */
function record(type, { userId = null, conversationId = null, messageId = null, ...extra } = {}, at = now()) {
  const payload = Object.keys(extra).length ? JSON.stringify(extra) : null;
  insert.run(type, at, userId, conversationId, messageId, payload);
}

module.exports = { record };
