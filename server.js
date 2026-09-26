// จุดเริ่มโปรแกรม — โค้ดจริงย้ายไปอยู่ในโฟลเดอร์ src/ ตั้งแต่ PDCA รอบที่ 3
const { server } = require('./src/server');

const PORT = Number(process.env.PORT) || 3000;
server.listen(PORT, () => {
  console.log(`Sapol Chat running on http://localhost:${PORT}`);
  console.log(`Dashboard:        http://localhost:${PORT}/dashboard.html`);
});
