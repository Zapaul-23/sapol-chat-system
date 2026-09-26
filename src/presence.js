// Presence — ใคร online อยู่ (1 คนเปิดได้หลายแท็บ)
const sockets = new Map(); // userId → Set(socket.id)

/** คืนค่า true ถ้าเป็นแท็บแรกของผู้ใช้คนนี้ (เพิ่ง online) */
function connect(userId, socketId) {
  let set = sockets.get(userId);
  const first = !set;
  if (!set) sockets.set(userId, (set = new Set()));
  set.add(socketId);
  return first;
}

/** คืนค่า true ถ้าเป็นแท็บสุดท้าย (เพิ่ง offline) */
function disconnect(userId, socketId) {
  const set = sockets.get(userId);
  if (!set) return false;
  set.delete(socketId);
  if (set.size === 0) {
    sockets.delete(userId);
    return true;
  }
  return false;
}

const isOnline = (userId) => sockets.has(userId);
const onlineUserIds = () => [...sockets.keys()];

module.exports = { connect, disconnect, isOnline, onlineUserIds };
