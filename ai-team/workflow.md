# AI Team Workflow — Miusic Project

> ระบบ AI Team สำหรับพัฒนาโปรเจกต์ Miusic โดยใช้ GitHub + Cloudflare เป็นหลัก

## 🏗️ โครงสร้างระบบ

```
/home/z/my-project/ai-team/
├── team.json              # นิยามทีม + กฎเหล็ก + workflow stages
├── state.json             # สถานะปัจจุบัน (persistent — ทำต่อได้)
├── workflow.md            # เอกสารนี้
├── manager.js             # orchestrator script
├── tasks/                 # ไฟล์ task ทั้งหมด (1 task = 1 file)
│   ├── T001-<slug>.json
│   ├── T002-<slug>.json
│   └── ...
├── logs/                  # logs ของแต่ละ task
│   ├── T001-<slug>.log
│   └── ...
├── state/                 # state snapshots สำหรับ resume
│   └── session-<id>.json
└── branches/              # branch registry
    └── branches.json
```

## 👥 ทีมงาน (6 roles)

| ID | ชื่อ | หน้าที่หลัก |
|----|------|------------|
| `manager` | AI Manager (พี่ก้อน) | ประสานงาน + ตัดสินใจ + ถาม user เมื่อไม่แน่ใจ |
| `analyst` | Analyst (น้องมิ้ค) | วิเคราะห์ + วางแผน + สร้าง branch |
| `coder` | Coder (น้องเต๋า + น้องเฟิร์น) | เขียน/แก้โค้ด |
| `tester` | Tester (น้องนัท) | ทดสอบ + หา bug |
| `security` | Security (พี่เบนซ์) | ตรวจ security + กฎเหล็ก |
| `reviewer` | Reviewer (พี่ก้อน) | review + impact analysis + approve PR |

## 🔄 Workflow Stages

```
[1] intake      ─→  Manager รับ request จาก user สร้าง task file
       │
       ▼
[2] analysis    ─→  Analyst วิเคราะห์ + สร้าง plan + สร้าง branch
       │
       ▼
[3] implementation ─→ Coder เขียน/แก้โค้ด + self-review
       │
       ▼
[4] testing     ─→  Tester รัน test ── ไม่ผ่าน ──→ กลับไป [3]
       │ ผ่าน
       ▼
[5] security    ─→  Security audit ── ไม่ผ่าน ──→ กลับไป [3]
       │ ผ่าน
       ▼
[6] review      ─→  Reviewer review ── ไม่ผ่าน ──→ กลับไป [3]
       │ ผ่าน
       ▼
[7] pr          ─→  Manager สร้าง PR + รอ user approve merge
       │ user merge
       ▼
[8] merged      ─→  ปิด task + archive
```

## 🔒 กฎเหล็ก 6 ข้อ (ห้ามละเมิด)

1. **ห้ามแก้ `worker/zip-format.js`** — ระบบ ZIP ต้องคงเดิม
2. **ห้ามแก้ logic ระบบชำระเงิน** — manual admin approval เท่านั้น
3. **ห้ามใช้ Cloudflare paid features** — D1, R2, Workers free tier เท่านั้น
4. **ห้ามแก้ `main` โดยตรง** — ต้องผ่าน PR + user approve
5. **ห้ามเดา** — ถ้าไม่แน่ใจให้หยุดและถาม user
6. **ห้ามทำระบบเดิมพัง** — ทุก change ต้องผ่าน regression test

## 📋 การจัดการ State

### State file: `/home/z/my-project/ai-team/state.json`

```json
{
  "tasks": {
    "active": ["T002"],           // กำลังทำงาน
    "pending_user_approval": [],  // รอ user ตัดสินใจ
    "completed": ["T001"],        // เสร็จแล้ว
    "blocked": []                 // ติดปัญหา รอ user
  }
}
```

### วิธี resume หลังปิด iPad/webpage

เมื่อ user กลับมา บอก AI:
- **"resume ai-team"** → AI อ่าน state.json + ทำงานต่อ
- **"ai-team status"** → AI แสดงสถานะทุก task
- **"new task: <description>"** → AI สร้าง task ใหม่

## 🌿 การตั้งชื่อ Branch

```
ai-team/<task-id>-<short-slug>

ตัวอย่าง:
  ai-team/T003-fix-payment-bug
  ai-team/T004-add-sales-report
  ai-team/T005-improve-mobile-ui
```

## 📦 การสร้าง Task File

แต่ละ task มีไฟล์ JSON ที่ `/home/z/my-project/ai-team/tasks/T<NNN>-<slug>.json`:

```json
{
  "id": "T001",
  "title": "Short title",
  "description": "Detailed description from user",
  "created_at": "ISO timestamp",
  "status": "intake|analysis|implementation|testing|security|review|pr|merged|cancelled",
  "current_stage": 1,
  "branch": "ai-team/T001-<slug>",
  "stages": {
    "intake": { "started_at": "...", "completed_at": "...", "result": "..." },
    "analysis": { "started_at": "...", "completed_at": "...", "plan": "..." },
    "implementation": { "started_at": "...", "completed_at": "...", "files_changed": [] },
    "testing": { "started_at": "...", "completed_at": "...", "test_results": {} },
    "security": { "started_at": "...", "completed_at": "...", "audit_result": {} },
    "review": { "started_at": "...", "completed_at": "...", "review_result": {} },
    "pr": { "started_at": "...", "pr_number": null, "pr_url": null }
  },
  " blockers": [],
  "decisions": []
}
```

## 🚦 เงื่อนไขการหยุดถาม user

AI Manager จะ **หยุดและถาม user** เมื่อ:
1. ไม่เข้าใจ request ชัดเจน
2. พบ conflict กับกฎเหล็ก
3. ต้องการ deploy ขึ้น production
4. พบ bug ที่ต้องตัดสินใจเชิง business
5. ต้องการข้อมูลที่ไม่มีใน codebase
6. ก่อน merge PR (ต้องรอ user approve เสมอ)

## 🚀 การ Deploy

การ deploy ขึ้น production ต้อง:
1. PR ถูก merge เข้า main แล้ว
2. AI Manager ถาม user ก่อน deploy
3. User ยืนยัน → AI deploy ด้วย `wrangler deploy`
4. หลัง deploy → AI ทดสอบ flow จริง + รายงานผล

## 📊 การรายงาน

AI Manager รายงานทุก task:
- สถานะปัจจุบัน (stage ไหน)
- ไฟล์ที่เปลี่ยน
- ผล test
- ความเสี่ยงที่เห็น
- สิ่งที่ต้องการจาก user (ถ้ามี)
