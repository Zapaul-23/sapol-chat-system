// Sapol Chat — Gateway: รับการเชื่อมต่อ Socket.IO แล้วส่งต่อให้แต่ละโมดูล (PDCA รอบที่ 3)
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const identity = require('./identity');
const presence = require('./presence');
const conversation = require('./conversation');
const messaging = require('./messaging');
const delivery = require('./delivery');
const history = require('./history');
const analytics = require('./analytics');
const events = require('./events');

const PORT = Number(process.env.PORT) || 3000;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, '..', 'public')));

// HTTP: ตัวเลขสำหรับหน้า dashboard (ตอบ Q1–Q6)
app.get('/api/metrics', (req, res) => {
  res.json(analytics.metrics({ days: req.query.days }));
});

// ---------- ตัวช่วยส่งข้อมูล ----------
const room = (userId) => `user:${userId}`;              // ทุกแท็บของผู้ใช้ 1 คนอยู่ห้องเดียวกัน
const onlineUsernames = () => presence.onlineUserIds().map((id) => identity.getById(id)?.username).filter(Boolean);

function pushConversation(conversationId, userIds = conversation.memberIds(conversationId)) {
  for (const uid of userIds) io.to(room(uid)).emit('conversation:updated', conversation.view(conversationId, uid));
}

function pushStatus(changed) {
  const seen = new Set();
  for (const { messageId, senderId } of changed) {
    if (seen.has(messageId)) continue;
    seen.add(messageId);
    io.to(room(senderId)).emit('message:status', delivery.status(messageId));
  }
}

// ---------- Socket.IO ----------
io.on('connection', (socket) => {
  let me = null; // ผู้ใช้ของ socket นี้ (หลัง auth)

  // ห่อ handler: ต้อง auth ก่อน + กัน error ทำ server ล่ม
  const on = (event, handler, { needAuth = true } = {}) => {
    socket.on(event, (data, cb) => {
      const reply = typeof cb === 'function' ? cb : () => {};
      if (needAuth && !me) return reply({ ok: false, error: 'กรุณาเข้าสู่ระบบก่อน' });
      try {
        handler(data ?? {}, reply);
      } catch (err) {
        console.error(`[${event}]`, err);
        reply({ ok: false, error: 'เกิดข้อผิดพลาดที่ server' });
      }
    });
  };

  // 1) เข้าสู่ระบบด้วย username
  on('auth', ({ username }, reply) => {
    if (me) return reply({ ok: false, error: 'เข้าสู่ระบบแล้ว' });
    const r = identity.login(username);
    if (!r.ok) return reply(r);

    me = r.user;
    socket.join(room(me.id));
    const addedTo = conversation.joinDefault(me.id);

    if (presence.connect(me.id, socket.id)) {
      events.record('UserConnected', { userId: me.id });
      io.emit('presence', { username: me.username, online: true });
    }
    if (addedTo) pushConversation(addedTo, conversation.memberIds(addedTo).filter((id) => id !== me.id));

    reply({ ok: true, user: me, conversations: conversation.listFor(me.id), online: onlineUsernames() });

    // ส่งข้อความที่ค้างไว้ตอน offline (client จะตอบ message:delivered กลับมา)
    for (const id of delivery.pendingIds(me.id)) socket.emit('message:new', messaging.getMessage(id));
  }, { needAuth: false });

  on('conversation:list', (_, reply) => reply({ ok: true, conversations: conversation.listFor(me.id) }));

  // 2) แชท 1:1
  on('dm:open', ({ username }, reply) => {
    const r = conversation.openDirect(me, username);
    if (!r.ok) return reply(r);
    if (r.created) pushConversation(r.conversationId);
    reply({ ok: true, conversation: conversation.view(r.conversationId, me.id) });
  });

  // 3) กลุ่ม
  on('group:create', ({ name, usernames }, reply) => {
    const r = conversation.createGroup(me, name, usernames);
    if (!r.ok) return reply(r);
    pushConversation(r.conversationId);
    reply({ ok: true, conversation: conversation.view(r.conversationId, me.id) });
  });

  on('group:addMember', ({ conversationId, username }, reply) => {
    const r = conversation.addMember(me, Number(conversationId), username);
    if (!r.ok) return reply(r);
    pushConversation(Number(conversationId));
    reply({ ok: true });
  });

  on('group:removeMember', ({ conversationId, username }, reply) => {
    const id = Number(conversationId);
    const r = conversation.removeMember(me, id, username);
    if (!r.ok) return reply(r);
    io.to(room(r.target.id)).emit('conversation:removed', { conversationId: id });
    pushConversation(id);
    reply({ ok: true });
  });

  // 4) ประวัติข้อความ
  on('history:get', ({ conversationId, beforeId, limit }, reply) => {
    reply(history.get(me.id, conversationId, beforeId, limit));
  });

  // 5) ส่งข้อความ
  on('message:send', (data, reply) => {
    const r = messaging.send(me, data);
    if (!r.ok) return reply(r);
    reply({ ok: true, message: r.message });
    if (r.duplicate) return;
    // ส่งให้สมาชิกทุกคน (รวมแท็บอื่นของคนส่ง) — client ตัดตัวซ้ำด้วย id
    for (const uid of conversation.memberIds(r.message.conversationId)) {
      io.to(room(uid)).emit('message:new', r.message);
    }
  });

  // 6) ใบตอบรับ
  on('message:delivered', ({ messageIds }) => pushStatus(delivery.markDelivered(me.id, messageIds)));

  on('message:read', ({ conversationId, upToMessageId }) => {
    const id = Number(conversationId);
    if (!conversation.isMember(id, me.id)) return;
    pushStatus(delivery.markRead(me.id, id, Number(upToMessageId) || 0));
  });

  // 7) กำลังพิมพ์ — ส่งให้สมาชิกคนอื่นในห้อง
  on('typing', ({ conversationId, isTyping }) => {
    const id = Number(conversationId);
    if (!conversation.isMember(id, me.id)) return;
    for (const uid of conversation.memberIds(id)) {
      if (uid !== me.id) io.to(room(uid)).emit('typing', { conversationId: id, username: me.username, isTyping: !!isTyping });
    }
  });

  // 8) ปิดแท็บ / หลุด
  socket.on('disconnect', () => {
    if (!me) return;
    if (presence.disconnect(me.id, socket.id)) {
      events.record('UserDisconnected', { userId: me.id });
      io.emit('presence', { username: me.username, online: false });
    }
  });
});

conversation.defaultId(); // สร้างห้อง general ตั้งแต่เริ่ม

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Sapol Chat running on http://localhost:${PORT}`);
    console.log(`Dashboard:        http://localhost:${PORT}/dashboard.html`);
  });
}

module.exports = { server, io };
