// Sapol Support — Gateway: รับ HTTP (REST) + Socket.IO แล้วเรียกโมดูล tickets
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const tickets = require('./tickets');

const AGENT_KEY = process.env.AGENT_KEY || 'agent123'; // ค่าเริ่มต้นสำหรับการเรียนเท่านั้น
const MAX_AGENT_NAME = 30;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json({ limit: '20kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------- ตัวช่วย ----------
const room = (ticketId) => `ticket:${ticketId}`;
const AGENTS = 'agents';

function isAgentKey(key) {
  const a = Buffer.from(String(key ?? ''));
  const b = Buffer.from(AGENT_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** ส่งผลการเปลี่ยนแปลงให้ทุกคนที่เกี่ยวข้อง */
function broadcast(result) {
  const id = result.ticket.id;
  for (const m of result.messages) io.to(room(id)).emit('message', m);
  io.to(room(id)).emit('ticket', result.ticket);           // ลูกค้า + จนท. ที่เปิดดูอยู่
  io.to(AGENTS).emit('ticket:updated', tickets.summary(id)); // คิวของ จนท. ทุกคน
}

// ---------- REST: ลูกค้า ----------
app.post('/api/tickets', (req, res) => {
  const r = tickets.create(req.body ?? {});
  if (!r.ok) return res.status(400).json(r);
  io.to(AGENTS).emit('ticket:new', tickets.summary(r.ticket.id));
  res.status(201).json({ ok: true, id: r.ticket.id, code: r.ticket.code, token: r.token });
});

app.get('/api/tickets/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!tickets.checkToken(id, req.query.token)) return res.status(404).json({ ok: false, error: 'ไม่พบ ticket' });
  res.json({ ok: true, ticket: tickets.view(tickets.getRow(id)), messages: tickets.messages(id) });
});

// ---------- REST: เจ้าหน้าที่ (ต้องมี header x-agent-key) ----------
function requireAgent(req, res, next) {
  if (!isAgentKey(req.get('x-agent-key'))) return res.status(401).json({ ok: false, error: 'รหัสเจ้าหน้าที่ไม่ถูกต้อง' });
  next();
}

app.get('/api/agent/tickets', requireAgent, (req, res) => {
  res.json({ ok: true, tickets: tickets.list({ status: req.query.status }) });
});

app.get('/api/agent/tickets/:id', requireAgent, (req, res) => {
  const t = tickets.summary(req.params.id);
  if (!t) return res.status(404).json({ ok: false, error: 'ไม่พบ ticket' });
  res.json({ ok: true, ticket: t, messages: tickets.messages(t.id) });
});

// ---------- Socket.IO ----------
io.on('connection', (socket) => {
  const me = { agent: null, customerTicket: null, viewing: null };
  const sent = []; // เวลาส่งข้อความล่าสุด (กันสแปม: ไม่เกิน 5 ข้อความ / 3 วินาที)

  const on = (event, handler) => {
    socket.on(event, (data, cb) => {
      const reply = typeof cb === 'function' ? cb : () => {};
      try {
        handler(data ?? {}, reply);
      } catch (err) {
        console.error(`[${event}]`, err);
        reply({ ok: false, error: 'เกิดข้อผิดพลาดที่ server' });
      }
    });
  };

  // เจ้าหน้าที่เข้าสู่ระบบด้วยรหัสร่วม
  on('agent:login', ({ agentKey, name }, reply) => {
    const n = String(name ?? '').trim().replace(/\s+/g, ' ');
    if (!n || n.length > MAX_AGENT_NAME) return reply({ ok: false, error: `กรุณาตั้งชื่อ (ไม่เกิน ${MAX_AGENT_NAME} ตัว)` });
    if (!isAgentKey(agentKey)) return reply({ ok: false, error: 'รหัสเจ้าหน้าที่ไม่ถูกต้อง' });
    me.agent = { name: n };
    socket.join(AGENTS);
    reply({ ok: true, name: n, tickets: tickets.list() });
  });

  // เข้าห้อง ticket — ลูกค้าต้องมี token, จนท. ต้อง login แล้ว
  on('join', ({ ticketId, token }, reply) => {
    const id = Number(ticketId);
    if (me.agent) {
      const t = tickets.summary(id);
      if (!t) return reply({ ok: false, error: 'ไม่พบ ticket' });
      if (me.viewing && me.viewing !== id) socket.leave(room(me.viewing));
      me.viewing = id;
      socket.join(room(id));
      return reply({ ok: true, ticket: t, messages: tickets.messages(id) });
    }
    if (!tickets.checkToken(id, token)) return reply({ ok: false, error: 'ไม่พบ ticket' });
    me.customerTicket = id;
    socket.join(room(id));
    reply({ ok: true, ticket: tickets.view(tickets.getRow(id)), messages: tickets.messages(id) });
  });

  on('message', ({ ticketId, text }, reply) => {
    const id = Number(ticketId);
    let role;
    if (me.agent) role = 'agent';
    else if (me.customerTicket === id) role = 'customer';
    else return reply({ ok: false, error: 'ไม่มีสิทธิ์ส่งข้อความใน ticket นี้' });

    const t = Date.now();
    while (sent.length && t - sent[0] > 3000) sent.shift();
    if (sent.length >= 5) return reply({ ok: false, error: 'ส่งเร็วเกินไป รอสักครู่' });
    sent.push(t);

    const name = role === 'agent' ? me.agent.name : tickets.getRow(id)?.customer_name;
    const r = tickets.addMessage(id, role, name, text);
    if (!r.ok) return reply(r);
    if (role === 'agent') tickets.markRead(id); // คนตอบย่อมอ่านแล้ว
    broadcast(r);
    reply({ ok: true });
  });

  on('status', ({ ticketId, status }, reply) => {
    if (!me.agent) return reply({ ok: false, error: 'เฉพาะเจ้าหน้าที่' });
    const r = tickets.setStatus(Number(ticketId), status, me.agent.name);
    if (!r.ok) return reply(r);
    broadcast(r);
    reply({ ok: true });
  });

  on('rate', ({ ticketId, rating }, reply) => {
    const id = Number(ticketId);
    if (me.agent || me.customerTicket !== id) return reply({ ok: false, error: 'เฉพาะลูกค้าเจ้าของ ticket' });
    const r = tickets.rate(id, rating);
    if (!r.ok) return reply(r);
    broadcast(r);
    reply({ ok: true });
  });

  on('read', ({ ticketId }) => {
    if (!me.agent || !tickets.getRow(ticketId)) return;
    tickets.markRead(ticketId);
    io.to(AGENTS).emit('ticket:updated', tickets.summary(ticketId));
  });
});

module.exports = { server, io, app };
