// Sapol Chat — เซิร์ฟเวอร์แชทห้องเดียว (รอบที่ 2: รายชื่อออนไลน์ + กันชื่อซ้ำ + กำลังพิมพ์)
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = 3000;
const history = [];        // ข้อความล่าสุด 50 ข้อความ (ปิด server แล้วหาย)
const users = new Map();   // socket.id → ชื่อ ของคนที่ออนไลน์อยู่

app.use(express.static('public')); // เสิร์ฟไฟล์หน้าเว็บในโฟลเดอร์ public

// ส่งรายชื่อคนออนไลน์ให้ทุกคน
function sendUsers() {
  io.emit('users', [...users.values()]);
}

io.on('connection', (socket) => {
  // 1) ผู้ใช้เข้าแชทพร้อมชื่อ — ตอบกลับผ่าน reply() ว่าเข้าได้หรือไม่
  socket.on('join', (name, reply) => {
    if (typeof reply !== 'function') return;
    if (users.has(socket.id)) return reply({ ok: false, error: 'คุณอยู่ในแชทแล้ว' });

    name = String(name || '').trim().slice(0, 20);
    if (!name) return reply({ ok: false, error: 'กรุณาตั้งชื่อ' });

    // กันชื่อซ้ำ (ไม่สนตัวพิมพ์เล็ก/ใหญ่)
    const taken = [...users.values()].some((n) => n.toLowerCase() === name.toLowerCase());
    if (taken) return reply({ ok: false, error: `ชื่อ "${name}" มีคนใช้อยู่แล้ว ลองชื่ออื่น` });

    users.set(socket.id, name);
    reply({ ok: true, name, history });                 // ส่งข้อความเก่ากลับไปพร้อมคำตอบ
    io.emit('system', `${name} เข้าห้อง`);
    sendUsers();
  });

  // 2) ผู้ใช้ส่งข้อความ
  socket.on('chat', (text) => {
    const name = users.get(socket.id);
    if (!name) return;                                  // ยังไม่ได้ join
    text = String(text || '').trim().slice(0, 500);
    if (!text) return;                                  // ตัดข้อความว่างทิ้ง

    const msg = { name, text, time: new Date().toISOString() };
    history.push(msg);
    if (history.length > 50) history.shift();           // เก็บแค่ 50 ข้อความล่าสุด
    io.emit('chat', msg);                               // ส่งหาทุกคน (รวมคนส่ง)
  });

  // 3) กำลังพิมพ์ — ส่งให้ทุกคน "ยกเว้น" คนที่พิมพ์
  socket.on('typing', (isTyping) => {
    const name = users.get(socket.id);
    if (!name) return;
    socket.broadcast.emit('typing', { name, isTyping: Boolean(isTyping) });
  });

  // 4) ผู้ใช้ปิดแท็บ / หลุด
  socket.on('disconnect', () => {
    const name = users.get(socket.id);
    if (!name) return;
    users.delete(socket.id);
    socket.broadcast.emit('typing', { name, isTyping: false }); // กันค้าง "กำลังพิมพ์…"
    io.emit('system', `${name} ออกจากห้อง`);
    sendUsers();
  });
});

server.listen(PORT, () => {
  console.log(`Sapol Chat running on http://localhost:${PORT}`);
});
