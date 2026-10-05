# 🤖 AI Team System — Miusic Project (v4.0.0)

ระบบ AI Team สำหรับพัฒนาโปรเจกต์ Miusic โดยใช้ GitHub + Cloudflare เป็นหลัก

## 🎯 วัตถุประสงค์

สร้างระบบที่ AI ทำงานได้อัตโนมัติ โดย:
- **แบ่งบทบาท** 10 คน หน้าที่ชัดเจน ไม่ซ้ำซ้อน
- **ห้ามลวมหน้าที่** — แต่ละคนทำเฉพาะหน้าที่ตัวเอง ใช้คนเก่งสายนั้น (กฎเหล็กข้อ 8) 🆕
- **ตรวจ Code ทุกไฟล์ ทุกบรรทัด ก่อนส่ง QA** (กฎเหล็กข้อ 7)
- **ห้ามข้ามขั้น workflow** — ทุกงานต้องผ่านครบ 13 ขั้น แม้งานเล็ก
- **ทำผ่าน Branch แยก** ไม่แก้ main โดยตรง
- **Test + Review** ก่อนสร้าง PR
- **ถ้าไม่ผ่าน** ให้แก้และทดสอบใหม่
- **รอ owner approve** ก่อน merge — AI ห้าม merge เอง
- **เก็บ state** ทำต่อได้แม้ปิดเบราว์เซอร์

## 📁 โครงสร้างไฟล์

```
ai-team/                        (อยู่ใน repo MiusicBox/Miusic)
├── README.md             # ไฟล์นี้
├── team.json             # นิยามทีม + กฎเหล็ก + workflow stages
├── state.json            # สถานะปัจจุบัน (persistent)
├── workflow.md           # เอกสาร workflow ฉบับเต็ม
├── manager.js            # orchestrator script (CLI)
├── tasks/                # ไฟล์ task ทั้งหมด (1 task = 1 file)
├── logs/                 # logs ของแต่ละ task
└── branches/             # branch registry
```

## 👥 ทีมงาน (10 คน)

| ID | ตำแหน่ง | ชื่อเรียก | หน้าที่ |
|----|---------|----------|--------|
| `pm` | Project Manager | พี่ก้อน | ประสานงาน + จัดคิว + คุมกฎเหล็ก + เปิด PR รอ owner |
| `ba` | Business Analyst | น้องมิ้ค | วิเคราะห์ + สแกนไฟล์ (ห้ามเดา) + spec + criteria |
| `designer` | UI/UX Designer | น้องแพรว | ออกแบบหน้าจอ/flow + ตรวจ consistency |
| `lead_dev` | Lead Developer | พี่ต้น | อนุมัติแนวทาง + ตัดสินใจเทคนิค + แจกงาน |
| `fe_dev` | Frontend Developer | น้องเต๋า | เขียน/แก้ฝั่ง client (HTML/CSS/JS) |
| `be_dev` | Backend Developer | น้องเฟิร์น | เขียน/แก้ worker + D1 + R2 |
| `code_reviewer` | Code Reviewer | พี่ภูมิ | ⭐ ตรวจ Code ทุกไฟล์ก่อนส่ง QA — ไม่ผ่าน = ตีกลับ |
| `qa_engineer` | QA Engineer | น้องนัท | ทดสอบ + regression + bug report (หลัง CR ผ่าน) |
| `security` | Security Engineer | พี่เบนซ์ | ตรวจ security + Free Plan + กฎเหล็ก |
| `release_manager` | Release Manager | พี่น๊อต | deploy + rollback + ตรวจหลัง deploy (หลัง owner approve) |

## 🔄 Workflow (13 ขั้น)

```
intake → scan → plan → develop → self_review → ★code_review
  → qa → (fix → qa_again) → security_final → pr
  → owner_approval → production
```

★ **code_review อยู่หน้า qa** — ตรวจโค้ดครบทุกไฟล์ก่อนส่ง QA เสมอ
ไม่ผ่านขั้นไหน = ตีกลับขั้น develop ทันที พร้อมเหตุผลละเอียด

## 🔒 กฎเหล็ก 7 ข้อ

1. ห้ามแก้ `worker/zip-format.js`
2. ห้ามแก้ logic ระบบชำระเงิน (manual admin approval)
3. ห้ามใช้ Cloudflare paid features
4. ห้ามแก้ `main` โดยตรง — ต้องผ่าน PR
5. ห้ามเดา — ถ้าไม่แน่ใจให้ถาม owner
6. ห้ามทำระบบเดิมพัง — ต้องผ่าน regression test
7. ทุกไฟล์ที่แก้ต้องผ่าน Code Review ครบทุกบรรทัดก่อนส่ง QA 🆕

## 🚀 วิธีใช้งาน

### คำสั่งที่ owner พิมพ์ได้กับ AI:

| คำสั่ง | ความหมาย |
|--------|---------|
| `ai-team status` | ดูสถานะทุก task |
| `resume ai-team` | ทำงานต่อจากที่ค้างไว้ |
| `new task: <description>` | สร้าง task ใหม่ |
| `show task <T00X>` | ดูรายละเอียด task |
| `approve merge <PR#>` | อนุมัติ merge PR (ขั้น 12) |
| `cancel task <T00X>` | ยกเลิก task |

### ตัวอย่างการใช้งาน

```
User: "new task: แก้บั๊ก login ลูกค้าไม่ได้"
AI: [สร้าง T064 + branch ai-team/T064-fix-login-bug]
    [BA scan+plan → Lead อนุมัติ → Dev แก้ → Self Review
     → Code Reviewer ตรวจทุกไฟล์ → QA ทดสอบ → Security ตรวจ]
    [สร้าง PR + รายงานเต็ม → รอ owner approve]

User: "approve merge <PR#>"
AI: [merge PR → Release Manager deploy → ตรวจ production จริง → รายงานผล]
```

## 💾 การ Resume หลังปิดเบราว์เซอร์

state.json เก็บสถานะทุกอย่าง:
- tasks.active — งานที่กำลังทำ
- tasks.pending_user_approval — รอ owner ตัดสินใจ
- tasks.completed — เสร็จแล้ว
- github.open_prs — PR ที่เปิดอยู่
- decisions_log — การตัดสินใจทั้งหมด

เมื่อกลับมา บอก AI: **"resume ai-team"** — AI จะอ่าน state และทำต่อ

## 🔐 Credentials

- **GitHub token**: stored as env `GH_TOKEN` (repo access — Contents + Pull requests)
- **Cloudflare token**: stored as env `CF_API_TOKEN` (Workers edit — ใช้เฉพาะตอน deploy หลัง owner approve)
- **Cloudflare account**: `01b48fd0746fb6fff50a18d02c4ceeb4`
- **Worker name**: `miusic-store`
- **Production URL**: `https://miusic-store.dj-remix.workers.dev`

## 📊 สถานะปัจจุบัน (T063 — 2026-10-04)

- ✅ ทีม v3.0.0 (10 คน) + workflow 13 ขั้น + กฎเหล็ก 7 ข้อ ประกาศใช้
- 📋 พร้อมรับ task ใหม่
