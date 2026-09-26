// Identity — ผู้ใช้ระบุตัวตนด้วย username (ยังไม่มีรหัสผ่าน: ชื่อเดิม = คนเดิม)
const { db, now, plain } = require('./db');
const events = require('./events');

const MAX_NAME = 20;

function normalize(name) {
  return String(name ?? '').trim().replace(/\s+/g, ' ').slice(0, MAX_NAME);
}

function findByUsername(name) {
  return plain(db.prepare('SELECT id, username FROM users WHERE username = ? COLLATE NOCASE').get(normalize(name)));
}

function getById(id) {
  return plain(db.prepare('SELECT id, username FROM users WHERE id = ?').get(id));
}

function login(name) {
  const username = normalize(name);
  if (!username) return { ok: false, error: 'กรุณาตั้งชื่อ' };

  let user = findByUsername(username);
  if (!user) {
    const r = db.prepare('INSERT INTO users (username, created_at) VALUES (?, ?)').run(username, now());
    user = { id: Number(r.lastInsertRowid), username };
    events.record('UserRegistered', { userId: user.id, username });
  }
  return { ok: true, user };
}

module.exports = { login, findByUsername, getById, normalize };
