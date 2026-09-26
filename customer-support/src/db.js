// ฐานข้อมูล SQLite (node:sqlite มากับ Node.js 22.5+ ไม่ต้องติดตั้งเพิ่ม)
// ตั้งชื่อตารางเป็น tickets / ticket_messages และใช้ตาราง events รูปแบบเดียวกับ Sapol Chat
// เพื่อให้ย้ายไปรวมกับฐานข้อมูลของแชทได้โดยชื่อไม่ชนกัน
const path = require('path');
const fs = require('fs');

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch {
  console.error('❌ ไม่พบ node:sqlite — ต้องใช้ Node.js 22.5 ขึ้นไป (ตรวจด้วย node -v)');
  process.exit(1);
}

const DB_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'support.db');
if (DB_FILE !== ':memory:') fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

const db = new DatabaseSync(DB_FILE);

db.exec(`
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS tickets (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    code              TEXT UNIQUE,                     -- CS-0001
    token             TEXT NOT NULL,                   -- ใช้แทนการล็อกอินของลูกค้า
    customer_name     TEXT NOT NULL,
    email             TEXT NOT NULL,
    category          TEXT NOT NULL CHECK (category IN ('general', 'technical', 'billing')),
    subject           TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'in_progress', 'resolved')),
    rating            INTEGER CHECK (rating BETWEEN 1 AND 5),
    agent_name        TEXT,                            -- เจ้าหน้าที่ที่ตอบล่าสุด
    agent_read_id     INTEGER NOT NULL DEFAULT 0,      -- ข้อความล่าสุดที่เจ้าหน้าที่อ่านแล้ว
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL,
    first_response_at TEXT,
    resolved_at       TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status, updated_at);

  CREATE TABLE IF NOT EXISTS ticket_messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id   INTEGER NOT NULL REFERENCES tickets(id),
    sender      TEXT NOT NULL CHECK (sender IN ('customer', 'agent', 'system')),
    sender_name TEXT NOT NULL,
    body        TEXT NOT NULL,
    sent_at     TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ticket_messages ON ticket_messages(ticket_id, id);

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
