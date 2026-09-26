// จุดเริ่มโปรแกรม Sapol Support — โค้ดจริงอยู่ใน src/
const { server } = require('./src/server');

const PORT = Number(process.env.PORT) || 3100; // 3000 ใช้กับ Sapol Chat อยู่แล้ว
server.listen(PORT, () => {
  console.log(`Sapol Support running on http://localhost:${PORT}`);
  console.log(`หน้าเจ้าหน้าที่:          http://localhost:${PORT}/agent.html`);
});
