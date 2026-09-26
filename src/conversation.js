// Conversation — แชท 1:1 (direct), กลุ่ม (group) และสมาชิก
const { db, now, plain, transaction } = require('./db');
const identity = require('./identity');
const events = require('./events');

const MAX_GROUP_NAME = 30;

// ---------- อ่านข้อมูล ----------
function get(conversationId) {
  return plain(db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId));
}

function isMember(conversationId, userId) {
  return !!db
    .prepare('SELECT 1 FROM members WHERE conversation_id = ? AND user_id = ? AND left_at IS NULL')
    .get(conversationId, userId);
}

function memberIds(conversationId) {
  return db
    .prepare('SELECT user_id FROM members WHERE conversation_id = ? AND left_at IS NULL')
    .all(conversationId)
    .map((r) => r.user_id);
}

function members(conversationId) {
  return db
    .prepare(
      `SELECT u.id, u.username, m.role FROM members m JOIN users u ON u.id = m.user_id
       WHERE m.conversation_id = ? AND m.left_at IS NULL ORDER BY m.role, u.username COLLATE NOCASE`
    )
    .all(conversationId)
    .map(plain);
}

/** ข้อมูล conversation ในมุมมองของผู้ใช้คนหนึ่ง (ชื่อที่แสดง, สมาชิก, ข้อความล่าสุด, ยังไม่อ่าน) */
function view(conversationId, forUserId) {
  const c = get(conversationId);
  if (!c) return null;
  const list = members(conversationId);
  const other = c.type === 'direct' ? list.find((m) => m.id !== forUserId) : null;
  const last = plain(
    db
      .prepare(
        `SELECT m.id, m.body AS text, m.sent_at AS sentAt, u.username AS sender
         FROM messages m JOIN users u ON u.id = m.sender_id
         WHERE m.conversation_id = ? ORDER BY m.id DESC LIMIT 1`
      )
      .get(conversationId)
  );
  const unread = db
    .prepare(
      `SELECT COUNT(*) AS n FROM receipts r JOIN messages m ON m.id = r.message_id
       WHERE r.recipient_id = ? AND m.conversation_id = ? AND r.read_at IS NULL`
    )
    .get(forUserId, conversationId).n;
  const me = list.find((m) => m.id === forUserId);

  return {
    id: c.id,
    type: c.type,
    name: c.type === 'direct' ? other?.username ?? '(ไม่มีสมาชิก)' : c.name,
    isDefault: !!c.is_default,
    myRole: me?.role ?? null,
    members: list,
    lastMessage: last ?? null,
    unread,
    createdAt: c.created_at,
  };
}

function listFor(userId) {
  const ids = db
    .prepare('SELECT conversation_id FROM members WHERE user_id = ? AND left_at IS NULL')
    .all(userId)
    .map((r) => r.conversation_id);
  return ids
    .map((id) => view(id, userId))
    .sort((a, b) => (b.lastMessage?.sentAt ?? b.createdAt).localeCompare(a.lastMessage?.sentAt ?? a.createdAt));
}

// ---------- ห้อง general (ทุกคนอยู่) ----------
function defaultId() {
  let row = db.prepare('SELECT id FROM conversations WHERE is_default = 1').get();
  if (!row) {
    const r = db
      .prepare("INSERT INTO conversations (type, name, is_default, created_at) VALUES ('group', 'general', 1, ?)")
      .run(now());
    row = { id: Number(r.lastInsertRowid) };
    events.record('ConversationCreated', { conversationId: row.id, kind: 'group', name: 'general', memberIds: [] });
  }
  return row.id;
}

/** ใส่ผู้ใช้เข้าห้อง general คืนค่า id ห้อง ถ้าเพิ่งถูกเพิ่ม (ไม่งั้น null) */
function joinDefault(userId) {
  const id = defaultId();
  const r = db
    .prepare("INSERT OR IGNORE INTO members (conversation_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)")
    .run(id, userId, now());
  if (r.changes === 0) return null;
  events.record('MemberAdded', { conversationId: id, userId, addedBy: null });
  return id;
}

// ---------- แชท 1:1 ----------
function openDirect(user, otherName) {
  const other = identity.findByUsername(otherName);
  if (!other) return { ok: false, error: `ไม่พบผู้ใช้ "${identity.normalize(otherName)}" (ต้องเคยเข้าระบบอย่างน้อย 1 ครั้ง)` };
  if (other.id === user.id) return { ok: false, error: 'เปิดแชทกับตัวเองไม่ได้' };

  const key = [user.id, other.id].sort((a, b) => a - b).join(':');
  const found = db.prepare('SELECT id FROM conversations WHERE direct_key = ?').get(key);
  if (found) return { ok: true, conversationId: found.id, created: false };

  const conversationId = transaction(() => {
    const t = now();
    const r = db
      .prepare("INSERT INTO conversations (type, direct_key, created_by, created_at) VALUES ('direct', ?, ?, ?)")
      .run(key, user.id, t);
    const id = Number(r.lastInsertRowid);
    const add = db.prepare("INSERT INTO members (conversation_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)");
    add.run(id, user.id, t);
    add.run(id, other.id, t);
    return id;
  });
  events.record('ConversationCreated', {
    userId: user.id, conversationId, kind: 'direct', memberIds: [user.id, other.id],
  });
  return { ok: true, conversationId, created: true };
}

// ---------- กลุ่ม ----------
function createGroup(user, name, usernames = []) {
  name = String(name ?? '').trim().replace(/\s+/g, ' ').slice(0, MAX_GROUP_NAME);
  if (!name) return { ok: false, error: 'กรุณาตั้งชื่อกลุ่ม' };

  const wanted = [...new Set((Array.isArray(usernames) ? usernames : []).map(identity.normalize).filter(Boolean))];
  const found = [];
  const missing = [];
  for (const n of wanted) {
    const u = identity.findByUsername(n);
    if (!u) missing.push(n);
    else if (u.id !== user.id && !found.some((f) => f.id === u.id)) found.push(u);
  }
  if (missing.length) return { ok: false, error: `ไม่พบผู้ใช้: ${missing.join(', ')}` };

  const conversationId = transaction(() => {
    const t = now();
    const r = db
      .prepare("INSERT INTO conversations (type, name, created_by, created_at) VALUES ('group', ?, ?, ?)")
      .run(name, user.id, t);
    const id = Number(r.lastInsertRowid);
    const add = db.prepare('INSERT INTO members (conversation_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)');
    add.run(id, user.id, 'admin', t);
    for (const u of found) add.run(id, u.id, 'member', t);
    return id;
  });
  events.record('ConversationCreated', {
    userId: user.id, conversationId, kind: 'group', name, memberIds: [user.id, ...found.map((u) => u.id)],
  });
  return { ok: true, conversationId };
}

function checkGroup(conversationId) {
  const c = get(conversationId);
  if (!c) return 'ไม่พบห้องนี้';
  if (c.type !== 'group') return 'แชท 1:1 เพิ่ม/ลบสมาชิกไม่ได้';
  if (c.is_default) return 'ห้อง general เป็นห้องของทุกคน เพิ่ม/ลบสมาชิกไม่ได้';
  return null;
}

function roleOf(conversationId, userId) {
  return db
    .prepare('SELECT role FROM members WHERE conversation_id = ? AND user_id = ? AND left_at IS NULL')
    .get(conversationId, userId)?.role;
}

function addMember(user, conversationId, username) {
  const err = checkGroup(conversationId);
  if (err) return { ok: false, error: err };
  if (roleOf(conversationId, user.id) !== 'admin') return { ok: false, error: 'เฉพาะ admin ของกลุ่มเท่านั้นที่เพิ่มสมาชิกได้' };

  const target = identity.findByUsername(username);
  if (!target) return { ok: false, error: `ไม่พบผู้ใช้ "${identity.normalize(username)}"` };
  if (isMember(conversationId, target.id)) return { ok: false, error: `${target.username} อยู่ในกลุ่มแล้ว` };

  db.prepare(
    `INSERT INTO members (conversation_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)
     ON CONFLICT (conversation_id, user_id) DO UPDATE SET left_at = NULL, role = 'member', joined_at = excluded.joined_at`
  ).run(conversationId, target.id, now());
  events.record('MemberAdded', { conversationId, userId: target.id, addedBy: user.id });
  return { ok: true, target };
}

function removeMember(user, conversationId, username) {
  const err = checkGroup(conversationId);
  if (err) return { ok: false, error: err };

  const target = identity.findByUsername(username);
  if (!target || !isMember(conversationId, target.id)) return { ok: false, error: 'ผู้ใช้นี้ไม่ได้อยู่ในกลุ่ม' };

  const isSelf = target.id === user.id;
  if (!isSelf && roleOf(conversationId, user.id) !== 'admin') {
    return { ok: false, error: 'เฉพาะ admin ของกลุ่มเท่านั้นที่ลบสมาชิกคนอื่นได้' };
  }

  transaction(() => {
    db.prepare('UPDATE members SET left_at = ? WHERE conversation_id = ? AND user_id = ?').run(now(), conversationId, target.id);
    // ข้อความที่ยังไม่ถึงคนที่ถูกลบ ไม่ต้องส่งแล้ว
    db.prepare(
      `DELETE FROM receipts WHERE recipient_id = ? AND delivered_at IS NULL
       AND message_id IN (SELECT id FROM messages WHERE conversation_id = ?)`
    ).run(target.id, conversationId);
  });
  events.record('MemberRemoved', { conversationId, userId: target.id, removedBy: user.id, left: isSelf });
  return { ok: true, target };
}

module.exports = {
  get, view, listFor, isMember, memberIds, members,
  defaultId, joinDefault, openDirect, createGroup, addMember, removeMember,
};
