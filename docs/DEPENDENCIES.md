# Sapol Chat — Package Dependency Diagram (Backend)

> โค้ด BE = `server.js` · เวอร์ชันจาก `node_modules` ที่ติดตั้งจริง (26 ก.ย. 2026)
> ติดตั้งตรง 2 package → ดึงแพ็กเกจย่อยมาทั้งหมด 78 ตัวใน `node_modules`

## 1. ภาพรวม (ระดับที่เราเรียกใช้เอง)

```mermaid
flowchart LR
  subgraph APP["📄 โค้ดของเรา"]
    S["server.js"]
  end

  subgraph CORE["⚙️ Node.js built-in (ไม่ต้องติดตั้ง)"]
    HTTP["http"]
  end

  subgraph DIRECT["📦 dependencies ใน package.json"]
    EX["express 4.22"]
    SIO["socket.io 4.8"]
  end

  S -->|"express() · express.static('public')"| EX
  S -->|"http.createServer(app)"| HTTP
  S -->|"new Server(server)"| SIO
  SIO -. "ผูกกับ http server ตัวเดียวกัน" .-> HTTP
  EX -. "app เป็น request handler ของ" .-> HTTP
```

## 2. แบบละเอียด (แพ็กเกจย่อยที่สำคัญ)

```mermaid
flowchart TB
  S["server.js"]

  S --> EX["express 4.22.3"]
  S --> SIO["socket.io 4.8.4"]
  S --> HTTP["node:http (built-in)"]

  %% ---- express ----
  subgraph EXG["express — เว็บเซิร์ฟเวอร์"]
    direction TB
    SS["serve-static<br/>(express.static)"] --> SEND["send<br/>ส่งไฟล์ + MIME"]
    BP["body-parser"]
    FH["finalhandler<br/>ตอบ 404/500"]
    PTR["path-to-regexp<br/>จับคู่ route"]
    ACC1["accepts · type-is<br/>content-type"]
  end
  EX --> SS
  EX --> BP
  EX --> FH
  EX --> PTR
  EX --> ACC1

  %% ---- socket.io ----
  subgraph SIOG["socket.io — เรียลไทม์"]
    direction TB
    EIO["engine.io 6.6.11<br/>polling ↔ WebSocket"]
    ADP["socket.io-adapter 2.5.8<br/>broadcast / rooms"]
    PAR["socket.io-parser 4.2.7<br/>เข้ารหัส event"]
    EIOP["engine.io-parser"]
    WS["ws 8.21.3<br/>WebSocket"]
    CORS["cors"]
    CLI[/"client-dist/<br/>socket.io.js (ไฟล์ฝั่งเบราว์เซอร์)"/]
  end
  SIO --> EIO
  SIO --> ADP
  SIO --> PAR
  SIO --> CORS
  SIO --- CLI
  EIO --> EIOP
  EIO --> WS
  EIO --> CORS
  ADP --> WS

  %% ---- ใช้ร่วมกัน ----
  DBG(["debug · accepts · cookie<br/>(ใช้ร่วมกันหลายตัว)"])
  EX -.-> DBG
  SIO -.-> DBG
  EIO -.-> DBG

  EIO -. "ฟัง upgrade request" .-> HTTP

  classDef app fill:#0E7C73,color:#fff,stroke:#0E7C73
  classDef direct fill:#DDE8FA,stroke:#2E68C9,color:#122A31
  classDef core fill:#F6EACB,stroke:#B7800F,color:#122A31
  class S app
  class EX,SIO direct
  class HTTP core
```

## 3. อธิบาย

| Package | ประเภท | ใช้ทำอะไรในโปรเจกต์นี้ |
|---|---|---|
| `http` | built-in ของ Node.js | สร้างเซิร์ฟเวอร์ที่ทั้ง Express และ Socket.IO ใช้ร่วมกันบนพอร์ต 3000 |
| `express` | direct | `express.static('public')` เสิร์ฟ `index.html` (ผ่าน `serve-static` → `send`) |
| `socket.io` | direct | จัดการ event `join`, `chat`, `typing` และส่งไฟล์ `/socket.io/socket.io.js` ให้เบราว์เซอร์ |
| `engine.io` | transitive | ชั้นขนส่งข้อมูลจริง เริ่มด้วย HTTP polling แล้วอัปเกรดเป็น WebSocket |
| `ws` | transitive | ไลบรารี WebSocket ระดับล่าง |
| `socket.io-adapter` | transitive | ทำ `io.emit` และ `socket.broadcast.emit` (ส่งหาทุกคน / ทุกคนยกเว้นตัวเอง) |
| `socket.io-parser` | transitive | แปลง event + ข้อมูลเป็นแพ็กเก็ตและกลับคืน รวมถึง callback ของ `join` |

**ข้อสังเกต**

- เราเรียกใช้ตรงแค่ 3 ตัว (`express`, `socket.io`, `http`) ที่เหลือเป็น transitive dependency ที่ npm ติดตั้งให้อัตโนมัติ
- Express ติดตั้งแพ็กเกจย่อยมาหลายตัว (เช่น `body-parser`, `qs`, `cookie`) แต่โปรเจกต์นี้ใช้จริงแค่ส่วนเสิร์ฟไฟล์ static
- ถ้าวันหนึ่งไม่อยากใช้ Express ก็เสิร์ฟ `index.html` ด้วย `http` + `fs` เองได้ แต่ Socket.IO ยังจำเป็นสำหรับแชท

**ตรวจเองได้ด้วยคำสั่ง**

```bash
npm ls              # เฉพาะ dependency ตรง
npm ls --all        # ทั้งต้นไม้
npm explain ws      # ใครดึง ws เข้ามา
```
