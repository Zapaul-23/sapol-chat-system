// Messaging — ตรวจ, บันทึก และเตรียมข้อความสำหรับกระจายให้สมาชิก
const { db, now, plain, transaction } = require('./db');
const conversation = require('./conversation');
const presence = require('./presence');
const delivery = require('./delivery');
const events = require('./events');

const MAX_TEXT = 1000;
const RATE_LIMIT = 5;          // ข้อความ
const RATE_WINDOW_MS = 1000;   // ต่อ 1 วินาที
const recent = new Map();      // userId → [เวลาที่ส่ง]

/** อ่านข้อความ 1 ข้อความในรูปแบบที่ส่งให้ client */
function getMessage(id) {
  const m = plain(
    db
      .prepare(
        `SELECT m.id, m.conversation_id AS conversationId, m.sender_id AS senderId, u.username AS sender,
                m.client_id AS clientId, m.content_type AS type, m.body AS text, m.sent_at AS sentAt
         FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.id = ?`
      )
      .get(id)
  );
  if (m) m.receipt = delivery.status(id);
  return m;
}

function rateLimited(userId) {
  const t = Date.now();
  const list = (recent.get(userId) ?? []).filter((x) => t - x < RATE_WINDOW_MS);
  const limited = list.length >= RATE_LIMIT;
  if (!limited) list.push(t);
  recent.set(userId, list);
  return limited;
}

/**
 * send(user, { conversationId, clientId, type, text })
 * คืน { ok: true, message, duplicate? } หรือ { ok: false, error, reason }
 */
function send(user, data = {}) {
  const conversationId = Number(data.conversationId);
  const clientId = data.clientId ? String(data.clientId).slice(0, 64) : null;
  const type = data.type ?? 'text';
  const text = String(data.text ?? '').trim();

  const fail = (reason, error) => {
    events.record('MessageSendFailed', {
      userId: user.id,
      conversationId: Number.isInteger(conversationId) ? conversationId : null,
      reason,
    });
    return { ok: false, reason, error };
  };

  if (type !== 'text') return fail('unsupported_type', 'ตอนนี้รองรับเฉพาะข้อความตัวอักษร');
  if (!Number.isInteger(conversationId) || !conversation.isMember(conversationId, user.id)) {
    return fail('not_member', 'คุณไม่ได้เป็นสมาชิกของห้องนี้');
  }
  if (!text) return fail('empty', 'ข้อความว่าง');
  if (text.length > MAX_TEXT) return fail('too_long', `ข้อความยาวเกิน ${MAX_TEXT.toLocaleString()} ตัวอักษร`);

  // ส่งซ้ำด้วย clientId เดิม (เช่น เน็ตหลุดแล้วส่งใหม่) → คืนข้อความเดิม ไม่สร้างใหม่
  if (clientId) {
    const dup = db.prepare('SELECT id FROM messages WHERE sender_id = ? AND client_id = ?').get(user.id, clientId);
    if (dup) return { ok: true, duplicate: true, message: getMessage(dup.id) };
  }
  if (rateLimited(user.id)) return fail('rate_limited', 'ส่งเร็วเกินไป รอสักครู่แล้วลองใหม่');

  let messageId;
  let recipients;
  try {
    ({ messageId, recipients } = transaction(() => {
      const r = db
        .prepare('INSERT INTO messages (conversation_id, sender_id, client_id, content_type, body, sent_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(conversationId, user.id, clientId, type, text, now());
      const id = Number(r.lastInsertRowid);
      const to = conversation.memberIds(conversationId).filter((uid) => uid !== user.id);
      const addReceipt = db.prepare('INSERT INTO receipts (message_id, recipient_id, queued) VALUES (?, ?, ?)');
      for (const uid of to) addReceipt.run(id, uid, presence.isOnline(uid) ? 0 : 1);
      return { messageId: id, recipients: to };
    }));
  } catch (err) {
    console.error('บันทึกข้อความไม่สำเร็จ:', err.message);
    return fail('db_error', 'บันทึกข้อความไม่สำเร็จ ลองใหม่อีกครั้ง');
  }

  events.record('MessageSent', {
    userId: user.id, conversationId, messageId, contentType: type, length: text.length, recipients: recipients.length,
  });
  return { ok: true, message: getMessage(messageId) };
}

module.exports = { send, getMessage, MAX_TEXT };
