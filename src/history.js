// History — ดึงข้อความย้อนหลังของ conversation แบบแบ่งหน้า
const { db } = require('./db');
const conversation = require('./conversation');
const { getMessage } = require('./messaging');

function get(userId, conversationId, beforeId, limit = 30) {
  conversationId = Number(conversationId);
  if (!conversation.isMember(conversationId, userId)) return { ok: false, error: 'คุณไม่ได้เป็นสมาชิกของห้องนี้' };

  limit = Math.min(Math.max(Number(limit) || 30, 1), 100);
  const before = Number(beforeId) || Number.MAX_SAFE_INTEGER;
  const ids = db
    .prepare('SELECT id FROM messages WHERE conversation_id = ? AND id < ? ORDER BY id DESC LIMIT ?')
    .all(conversationId, before, limit + 1)
    .map((r) => r.id);

  const hasMore = ids.length > limit;
  const messages = ids.slice(0, limit).reverse().map(getMessage);
  return { ok: true, messages, hasMore };
}

module.exports = { get };
