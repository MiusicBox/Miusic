# 🤖 AI Team System — Miusic Project

ระบบ AI Team สำหรับพัฒนาโปรเจกต์ Miusic โดยใช้ GitHub + Cloudflare เป็นหลัก

## 🎯 วัตถุประสงค์

สร้างระบบที่ AI ทำงานได้อัตโนมัติ โดย:
- **แบ่งบทบาท** 5 ตัว: Analyst, Coder, Tester, Security, Reviewer + AI Manager
- **ทำผ่าน Branch แยก** ไม่แก้ main โดยตรง
- **Test + Review** ก่อนสร้าง PR
- **ถ้าไม่ผ่าน** ให้แก้และทดสอบใหม่
- **รอ user approve** ก่อน merge
- **เก็บ state** ทำต่อได้แม้ปิด iPad/หน้าเว็บ

## 📁 โครงสร้างไฟล์

```
/home/z/my-project/ai-team/
├── README.md             # ไฟล์นี้
├── team.json             # นิยามทีม + กฎเหล็ก + workflow stages
├── state.json            # สถานะปัจจุบัน (persistent)
├── workflow.md           # เอกสาร workflow
├── manager.js            # orchestrator script (CLI)
├── tasks/                # ไฟล์ task ทั้งหมด (1 task = 1 file)
├── logs/                 # logs ของแต่ละ task
├── state/                # state snapshots
└── branches/             # branch registry
```

## 👥 ทีมงาน

| ID | ชื่อ | หน้าที่ |
|----|------|--------|
| `manager` | AI Manager (พี่ก้อน) | ประสานงาน + ตัดสินใจ + ถาม user |
| `analyst` | Analyst (น้องมิ้ค) | วิเคราะห์ + วางแผน + สร้าง branch |
| `coder` | Coder (น้องเต๋า + น้องเฟิร์น) | เขียน/แก้โค้ด |
| `tester` | Tester (น้องนัท) | ทดสอบ + หา bug |
| `security` | Security (พี่เบนซ์) | ตรวจ security + กฎเหล็ก |
| `reviewer` | Reviewer (พี่ก้อน) | review + impact analysis |

## 🔄 Workflow

```
intake → analysis → implementation → testing → security → review → pr → merged
                                                       ↓ fail
                                                  back to implementation
```

## 🔒 กฎเหล็ก 6 ข้อ

1. ห้ามแก้ `worker/zip-format.js`
2. ห้ามแก้ logic ระบบชำระเงิน (manual admin approval)
3. ห้ามใช้ Cloudflare paid features
4. ห้ามแก้ `main` โดยตรง — ต้องผ่าน PR
5. ห้ามเดา — ถ้าไม่แน่ใจให้ถาม user
6. ห้ามทำระบบเดิมพัง — ต้องผ่าน regression test

## 🚀 วิธีใช้งาน

### คำสั่งที่ user พิมพ์ได้กับ AI:

| คำสั่ง | ความหมาย |
|--------|---------|
| `ai-team status` | ดูสถานะทุก task |
| `resume ai-team` | ทำงานต่อจากที่ค้างไว้ |
| `new task: <description>` | สร้าง task ใหม่ |
| `show task <T00X>` | ดูรายละเอียด task |
| `approve merge <PR#>` | อนุมัติ merge PR |
| `cancel task <T00X>` | ยกเลิก task |

### ตัวอย่างการใช้งาน

```
User: "new task: แก้บั๊ก login ลูกค้าไม่ได้"
AI: [สร้าง T002 + branch ai-team/T002-fix-customer-login]
    [Analyst วิเคราะห์ → Coder แก้ → Tester ทดสอบ → Security audit → Reviewer review]
    [สร้าง PR #2 → รอ user approve]

User: "approve merge 2"
AI: [merge PR #2 → deploy ขึ้น production → ทดสอบ flow จริง → รายงานผล]
```

## 💾 การ Resume หลังปิดเบราว์เซอร์

state.json เก็บสถานะทุกอย่าง:
- tasks.active — งานที่กำลังทำ
- tasks.pending_user_approval — รอ user ตัดสินใจ
- tasks.completed — เสร็จแล้ว
- github.open_prs — PR ที่เปิดอยู่
- decisions_log — การตัดสินใจทั้งหมด

เมื่อกลับมา บอก AI: **"resume ai-team"** — AI จะอ่าน state และทำต่อ

## 🔐 Credentials

- **GitHub token**: stored as env `GH_TOKEN` (full repo admin)
- **Cloudflare token**: stored as env `CF_API_TOKEN` (Workers edit)
- **Cloudflare account**: `01b48fd0746fb6fff50a18d02c4ceeb4`
- **Worker name**: `miusic-store`
- **Production URL**: `https://miusic-store.dj-remix.workers.dev`

## 📊 สถานะปัจจุบัน (สร้างระบบ: 2026-10-03)

- ✅ ระบบ AI Team สร้างเสร็จ
- ⏸️ PR #1 รอ user merge: https://github.com/MiusicBox/Miusic/pull/1
- 📋 พร้อมรับ task ใหม่
