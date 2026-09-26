// Event Log — บันทึกเหตุการณ์แบบเพิ่มอย่างเดียว (โครงสร้างเดียวกับ Sapol Chat)
const { db, now } = require('./db');

const insert = db.prepare(
  'INSERT INTO events (type, occurred_at, user_id, conversation_id, message_id, payload) VALUES (?, ?, ?, ?, ?, ?)'
);

function record(type, { userId = null, conversationId = null, messageId = null, ...extra } = {}, at = now()) {
  insert.run(type, at, userId, conversationId, messageId, JSON.stringify(extra));
}

module.exports = { record };
