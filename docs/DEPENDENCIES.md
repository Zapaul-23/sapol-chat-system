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

---

# ภาค 2 — Module Dependency Diagram ของโค้ด BE (PDCA รอบ 3 → 4)

> อัปเดต 26 ก.ย. 2026 · ได้จากการอ่าน `require(...)` ในทุกไฟล์ `src/*.js` จริง
> เส้นทึบ = มีอยู่แล้ว (รอบ 3) · กรอบ/เส้นประสีส้ม = จะเพิ่มในรอบ 4 (`PLAN-R4.md`)

## 4. แผนภาพแบบชั้น (Layer)

ลูกศร `A --> B` = "A เรียกใช้ B" · ทุกลูกศรชี้ **ลงล่าง** เท่านั้น (ไม่มีวงวน) · ลูกศรหนาจากกรอบโมดูลโดเมนไป `db.js` แทนการ require db ของทุกโมดูลในกรอบ

ภาพที่เรนเดอร์แล้ว: `docs/be-dependency-diagram.png`

```mermaid
flowchart TB
  classDef entry fill:#e0e7ff,stroke:#4338ca,color:#1e1b4b
  classDef mod fill:#f1f5f9,stroke:#475569,color:#0f172a
  classDef base fill:#dcfce7,stroke:#15803d,color:#052e16
  classDef ext fill:#fef9c3,stroke:#a16207,color:#422006
  classDef r4 fill:#ffedd5,stroke:#ea580c,color:#431407,stroke-dasharray:6 4

  subgraph L6["ชั้น 6 · จุดเริ่ม + Gateway"]
    MAIN["server.js<br/>(จุดเริ่ม)"]:::entry
    GW["src/server.js<br/>Gateway: HTTP + Socket.IO"]:::entry
  end

  subgraph DOM["โมดูลโดเมน — ทุกตัวในกรอบนี้ใช้ db.js (ยกเว้น presence)"]
  subgraph L5["ชั้น 5 · ฟีเจอร์ที่ประกอบจากหลายโมดูล"]
    HS["history.js<br/>ประวัติแบ่งหน้า"]:::mod
    SP["support.js ⭐ รอบ 4<br/>ticket · agent · สถานะ · ดาว"]:::r4
  end

  subgraph L4["ชั้น 4"]
    MS["messaging.js<br/>ตรวจ + บันทึกข้อความ"]:::mod
  end

  subgraph L3["ชั้น 3"]
    CV["conversation.js<br/>DM · group · support"]:::mod
  end

  subgraph L2["ชั้น 2 · โดเมนพื้นฐาน"]
    ID["identity.js<br/>ผู้ใช้"]:::mod
    DL["delivery.js<br/>✓ ✓✓ อ่านแล้ว"]:::mod
    AN["analytics.js<br/>Q1–Q6 (+Q7–Q10)"]:::mod
  end

  subgraph L1["ชั้น 1"]
    EV["events.js<br/>Event Log"]:::base
  end
  end

  subgraph L0["ชั้น 0 · ฐาน"]
    DB["db.js<br/>SQLite + transaction"]:::base
    PR["presence.js<br/>online (ในหน่วยความจำ)"]:::base
  end

  subgraph EXT["ภายนอก"]
    EX["express"]:::ext
    SIO["socket.io"]:::ext
    NODE["node:http · node:path · node:fs"]:::ext
    SQL["node:sqlite"]:::ext
  end

  MAIN --> GW
  GW --> HS & MS & CV & ID & DL & AN & EV & PR
  GW -.-> SP
  GW --> EX & SIO & NODE

  HS --> MS
  HS --> CV
  SP -.-> MS
  SP -.-> CV
  SP -.-> ID
  SP -.-> EV
  MS -. "hook: onSent(fn) — ลงทะเบียนตอนเริ่ม ไม่ require" .-> SP

  MS --> CV & DL & PR & EV
  CV --> ID & EV
  ID --> EV
  DL --> EV

  DOM ==>|"require('./db')"| DB
  DB --> SQL & NODE

```

> เส้นประ `messaging ⇢ support` ไม่ใช่การ `require` — ถ้า `messaging.js` require `support.js` ตรง ๆ จะเกิด **วงวน** (support → messaging → support) จึงใช้วิธีให้ `support.js` ลงทะเบียน callback ผ่าน `messaging.onSent(fn)` แทน ทิศการพึ่งพาจึงยังชี้ลงล่างทางเดียว

## 5. ตารางการพึ่งพา (ใครเรียกใคร)

| โมดูล | เรียกใช้ (ขาออก) | ถูกเรียกโดย (ขาเข้า) | ชั้น |
|---|---|---|---|
| `db.js` | node:sqlite, fs, path | ทุกโมดูลที่เก็บข้อมูล (8) | 0 |
| `presence.js` | – | server, messaging | 0 |
| `events.js` | db | server, identity, conversation, delivery, messaging, *support* | 1 |
| `identity.js` | db, events | server, conversation, *support* | 2 |
| `delivery.js` | db, events | server, messaging | 2 |
| `analytics.js` | db | server | 2 |
| `conversation.js` | db, identity, events | server, messaging, history, *support* | 3 |
| `messaging.js` | db, conversation, presence, delivery, events | server, history, *support* | 4 |
| `history.js` | db, conversation, messaging | server | 5 |
| *`support.js`* ⭐ | *db, conversation, messaging, identity, events* | *server* | 5 |
| `src/server.js` | ทุกโมดูล + express, socket.io, http, path | server.js, test | 6 |

## 6. ข้อสังเกต

- **ไม่มีวงวน (cycle)** — ชั้นล่างไม่รู้จักชั้นบน จึงทดสอบ `db`, `events`, `identity` แยกได้ง่าย
- **`db.js` ถูกใช้มากที่สุด** (Afferent = 8) → แก้ schema/migration ต้องระวังที่สุด เป็นเหตุผลที่แผนรอบ 4 ให้สำรองฐานข้อมูลก่อน
- **`src/server.js` พึ่งพามากที่สุด** (Efferent = 12) เป็นเรื่องปกติของ Gateway ที่ทำหน้าที่ต่อสายอย่างเดียว ไม่ควรมี business logic
- **`support.js` ต่อยอดโดยไม่ต้องให้ใครพึ่งพามัน** (ยกเว้น Gateway) → ถอดออกได้ทั้งโมดูลโดยแชทยังทำงานปกติ
- `presence.js` เก็บในหน่วยความจำ ไม่แตะฐานข้อมูล → ถ้าวันหนึ่งรันหลาย server ต้องย้ายไปใช้ Redis/adapter
