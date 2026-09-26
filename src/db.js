// ฐานข้อมูล SQLite (ใช้ node:sqlite ที่มากับ Node.js 22.5+ ไม่ต้องติดตั้งเพิ่ม)
const path = require('path');
const fs = require('fs');

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch {
  console.error('❌ ไม่พบ node:sqlite — ต้องใช้ Node.js 22.5 ขึ้นไป (ตรวจด้วย node -v)');
  process.exit(1);
}

const DB_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'chat.db');
if (DB_FILE !== ':memory:') fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

const db = new DatabaseSync(DB_FILE);

db.exec(`
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    username    TEXT NOT NULL UNIQUE COLLATE NOCASE,
    created_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    type        TEXT NOT NULL CHECK (type IN ('direct', 'group')),
    name        TEXT,                        -- เฉพาะ group
    is_default  INTEGER NOT NULL DEFAULT 0,  -- 1 = ห้อง general ที่ทุกคนอยู่
    direct_key  TEXT UNIQUE,                 -- "idน้อย:idมาก" กันสร้าง DM ซ้ำ
    created_by  INTEGER REFERENCES users(id),
    created_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS members (
    conversation_id INTEGER NOT NULL REFERENCES conversations(id),
    user_id         INTEGER NOT NULL REFERENCES users(id),
    role            TEXT NOT NULL DEFAULT 'member',  -- admin | member
    joined_at       TEXT NOT NULL,
    left_at         TEXT,                            -- NULL = ยังเป็นสมาชิก
    PRIMARY KEY (conversation_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id),
    sender_id       INTEGER NOT NULL REFERENCES users(id),
    client_id       TEXT,                            -- กันข้อความซ้ำเมื่อ client ส่งใหม่
    content_type    TEXT NOT NULL DEFAULT 'text',    -- text (image/file เป็น extension)
    body            TEXT NOT NULL,
    sent_at         TEXT NOT NULL,
    UNIQUE (sender_id, client_id)
  );
  CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id);

  CREATE TABLE IF NOT EXISTS receipts (
    message_id    INTEGER NOT NULL REFERENCES messages(id),
    recipient_id  INTEGER NOT NULL REFERENCES users(id),
    queued        INTEGER NOT NULL DEFAULT 0,  -- 1 = ผู้รับ offline ตอนส่ง
    delivered_at  TEXT,
    read_at       TEXT,
    PRIMARY KEY (message_id, recipient_id)
  );
  CREATE INDEX IF NOT EXISTS idx_receipts_pending ON receipts(recipient_id, delivered_at);

  CREATE TABLE IF NOT EXISTS events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    type            TEXT NOT NULL,
    occurred_at     TEXT NOT NULL,
    user_id         INTEGER,
    conversation_id INTEGER,
    message_id      INTEGER,
    payload         TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_events_type_time ON events(type, occurred_at);
`);

const now = () => new Date().toISOString();

// แปลงผลลัพธ์จาก SQLite เป็น object ธรรมดา
const plain = (row) => (row ? { ...row } : undefined);

// รันหลายคำสั่งเป็นก้อนเดียว (สำเร็จทั้งหมด หรือยกเลิกทั้งหมด)
function transaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { db, now, plain, transaction, DB_FILE };
