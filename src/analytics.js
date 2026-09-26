// Analytics — ตอบ Business Questions Q1–Q6 จากตาราง events
const { db, now } = require('./db');

const TZ = '+7 hours'; // แสดงผลเป็นวันตามเวลาไทย

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}
const avg = (v) => (v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null);
const summary = (v) => ({ count: v.length, avgMs: avg(v), p50Ms: percentile(v, 50), p95Ms: percentile(v, 95) });

function metrics({ days = 30 } = {}) {
  days = Math.min(Math.max(parseInt(days, 10) || 30, 1), 365);
  const to = now();
  const from = new Date(Date.now() - days * 864e5).toISOString();
  const range = [from, to];
  const inRange = 'occurred_at >= ? AND occurred_at <= ?';

  // Q1 ข้อความต่อวัน
  const perDay = db
    .prepare(`SELECT date(occurred_at, '${TZ}') AS day, COUNT(*) AS messages FROM events
              WHERE type = 'MessageSent' AND ${inRange} GROUP BY day ORDER BY day`)
    .all(...range).map((r) => ({ ...r }));
  const totalMessages = perDay.reduce((s, r) => s + r.messages, 0);

  // Q2 DAU / MAU (นับคนที่ส่งหรืออ่านข้อความ)
  const dauPerDay = db
    .prepare(`SELECT date(occurred_at, '${TZ}') AS day, COUNT(DISTINCT user_id) AS dau FROM events
              WHERE type IN ('MessageSent', 'MessageRead') AND ${inRange} GROUP BY day ORDER BY day`)
    .all(...range).map((r) => ({ ...r }));
  const today = db.prepare(`SELECT date('now', '${TZ}') AS d`).get().d;
  const dauToday = dauPerDay.find((r) => r.day === today)?.dau ?? 0;
  const mau = db
    .prepare(`SELECT COUNT(DISTINCT user_id) AS n FROM events
              WHERE type IN ('MessageSent', 'MessageRead') AND occurred_at >= ?`)
    .get(new Date(Date.now() - 30 * 864e5).toISOString()).n;
  const avgDau = dauPerDay.length ? +(dauPerDay.reduce((s, r) => s + r.dau, 0) / dauPerDay.length).toFixed(1) : 0;

  // Q3 ห้องที่ active ที่สุด
  const topConversations = db
    .prepare(
      `SELECT e.conversation_id AS id, c.type, c.name, COUNT(*) AS messages, COUNT(DISTINCT e.user_id) AS senders,
              (SELECT GROUP_CONCAT(u.username, ' ↔ ') FROM members m JOIN users u ON u.id = m.user_id
               WHERE m.conversation_id = c.id) AS memberNames
       FROM events e JOIN conversations c ON c.id = e.conversation_id
       WHERE e.type = 'MessageSent' AND ${inRange.replaceAll('occurred_at', 'e.occurred_at')}
       GROUP BY e.conversation_id ORDER BY messages DESC LIMIT 5`
    )
    .all(...range)
    .map((r) => ({ id: r.id, type: r.type, name: r.type === 'direct' ? r.memberNames : r.name, messages: r.messages, senders: r.senders }));

  // Q4 delivery latency (แยกผู้รับ online / offline ตอนส่ง)
  const deliveries = db
    .prepare(`SELECT json_extract(payload, '$.latencyMs') AS ms, json_extract(payload, '$.wasOffline') AS offline
              FROM events WHERE type = 'MessageDelivered' AND ${inRange}`)
    .all(...range);
  const lat = (filter) => summary(deliveries.filter(filter).map((r) => r.ms));

  // Q5 % ส่งไม่สำเร็จ
  const sentCount = totalMessages;
  const failed = db
    .prepare(`SELECT json_extract(payload, '$.reason') AS reason, COUNT(*) AS n FROM events
              WHERE type = 'MessageSendFailed' AND ${inRange} GROUP BY reason ORDER BY n DESC`)
    .all(...range).map((r) => ({ ...r }));
  const failedCount = failed.reduce((s, r) => s + r.n, 0);
  const stuckOver24h = db
    .prepare(`SELECT COUNT(*) AS n FROM receipts r JOIN messages m ON m.id = r.message_id
              WHERE r.delivered_at IS NULL AND m.sent_at < ?`)
    .get(new Date(Date.now() - 864e5).toISOString()).n;

  // Q6 เวลาจากได้รับถึงอ่าน
  const readDelays = db
    .prepare(`SELECT json_extract(payload, '$.readDelayMs') AS ms FROM events WHERE type = 'MessageRead' AND ${inRange}`)
    .all(...range).map((r) => r.ms);

  return {
    generatedAt: to,
    range: { from, to, days },
    q1_messagesPerDay: { total: totalMessages, perDay },
    q2_activeUsers: {
      dauToday, avgDau, mau,
      stickiness: mau ? +(avgDau / mau).toFixed(2) : null,
      perDay: dauPerDay,
    },
    q3_mostActiveConversations: topConversations,
    q4_deliveryLatency: {
      all: lat(() => true),
      recipientOnline: lat((r) => !r.offline),
      recipientOffline: lat((r) => !!r.offline),
    },
    q5_sendFailures: {
      attempted: sentCount + failedCount,
      failed: failedCount,
      failedPct: sentCount + failedCount ? +((100 * failedCount) / (sentCount + failedCount)).toFixed(2) : 0,
      byReason: failed,
      undeliveredOver24h: stuckOver24h,
    },
    q6_timeToRead: summary(readDelays),
  };
}

module.exports = { metrics };
