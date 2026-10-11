# AI Team Workflow — Miusic Project (v3.0.0)

> ระบบ AI Team สำหรับพัฒนาโปรเจกต์ Miusic โดยใช้ GitHub + Cloudflare เป็นหลัก
> 🆕 v3.0.0 (T063): ขยายทีม 6 → 10 คน + workflow 8 → 13 ขั้น + กฎเหล็ก 6 → 7 ข้อ
> หัวใจใหม่: **ตรวจ Code ทุกไฟล์ ทุกบรรทัด ก่อนส่ง QA** (กฎเหล็กข้อ 7)
> ⭐ ทุก task = ทำครบทั้ง 13 หมวดหมู่ทุกรอบ — ห้ามข้ามหมวดไหน ไม่ผ่านหมวดไหน = ตีกลับห้ามเดินต่อ

## 🏗️ โครงสร้างระบบ

```
ai-team/                        (อยู่ใน repo MiusicBox/Miusic)
├── team.json              # นิยามทีม + กฎเหล็ก + workflow stages
├── state.json             # สถานะปัจจุบัน (persistent — ทำต่อได้)
├── workflow.md            # เอกสารนี้
├── manager.js             # orchestrator script (CLI)
├── tasks/                 # ไฟล์ task ทั้งหมด (1 task = 1 file)
├── logs/                  # logs ของแต่ละ task (สร้างอัตโนมัติตอน new task)
└── branches/              # branch registry (ถ้ามีการใช้งาน)
```

## 👥 ทีมงาน (10 คน — หน้าที่ชัดเจน ไม่ซ้ำซ้อน)

| # | ID | ตำแหน่ง | ชื่อเรียก | หน้าที่หลัก |
|---|----|----|------|------------|
| 1 | `pm` | Project Manager | พี่ก้อน | รับงาน + จัดคิว + คุมกฎเหล็ก + รายงาน owner + เปิด PR |
| 2 | `ba` | Business Analyst | น้องมิ้ค | วิเคราะห์ + สแกนไฟล์ (ห้ามเดา) + spec + acceptance criteria |
| 3 | `designer` | UI/UX Designer | น้องแพรว | ออกแบบหน้าจอ/flow + ตรวจความ consistent กับเดิม |
| 4 | `lead_dev` | Lead Developer | พี่ต้น | อนุมัติแนวทาง + ตัดสินใจเทคนิค + แจกงาน dev |
| 5 | `fe_dev` | Frontend Developer | น้องเต๋า | แก้ฝั่ง client (HTML/CSS/app-*.js/PWA) |
| 6 | `be_dev` | Backend Developer | น้องเฟิร์น | แก้ worker/, D1, migrations, R2 |
| 7 | `code_reviewer` | Code Reviewer | พี่ภูมิ | ⭐ **ตรวจ Code ทุกไฟล์ ทุกบรรทัด ก่อนส่ง QA** — ไม่ผ่าน = ตีกลับทันที |
| 8 | `qa_engineer` | QA Engineer | น้องนัท | รับงานหลัง Code Review ผ่านเท่านั้น — test + regression + bug report |
| 9 | `security` | Security Engineer | พี่เบนซ์ | ตรวจ security + Free Plan limits + กฎเหล็ก 7 ข้อ |
| 10 | `release_manager` | Release Manager | พี่น๊อต | deploy (หลัง owner approve เท่านั้น) + rollback plan + ตรวจหลัง deploy |

## 🔄 หมวดหมู่บังคับ 13 ขั้น (ทำครบทุก task — ทุกรอบ ห้ามข้าม)

```
[1] intake         ─→ PM รับงานจาก owner → สร้าง task file + branch ai-team/T0XX-...
       │
       ▼
[2] scan           ─→ BA สแกนไฟล์ที่เกี่ยวข้องจริงทุกครั้ง (ห้ามเดา — ยืนยันไม่ได้ = UNKNOWN)
       │
       ▼
[3] plan           ─→ BA วางแผน + Lead Dev อนุมัติแนวทาง (+ Designer ถ้าแตะ UI)
       │
       ▼
[4] develop        ─→ fe_dev / be_dev เขียนโค้ดตาม plan
       │
       ▼
[5] self_review    ─→ Dev ตรวจเอง 10 ข้อ (syntax, console.log ตกค้าง, ขอบเขตตรง plan ฯลฯ)
       │
       ▼
[6] ★ code_review  ─→ Code Reviewer ตรวจทุกไฟล์ ทุกบรรทัด ── ไม่ผ่าน ──→ กลับ [4]
       │ ผ่าน
       ▼
[7] qa             ─→ QA ทดสอบ (acceptance criteria + regression) ── fail ──→ [8] fix
       │ ผ่าน
       ▼
[8] fix            ─→ Dev แก้ตาม bug report (แตะไฟล์ใหม่ → ต้องผ่าน code_review ซ้ำ)
       │
       ▼
[9] qa_again       ─→ QA ทดสอบซ้ำให้ผ่าน 100% ── ยัง fail ──→ กลับ [8]
       │ ผ่าน
       ▼
[10] security_final ─→ Security audit + กฎเหล็ก 7 ข้อ + Final Test รวม
       │ ผ่าน
       ▼
[11] pr            ─→ PM สร้าง Pull Request + รายงานฉบับเต็มตามฟอร์แมตที่กำหนด
       │
       ▼
[12] owner_approval ─→ รอ owner approve merge — AI ห้าม merge เองเด็ดขาด
       │ owner merge
       ▼
[13] production    ─→ Release Manager deploy + ตรวจจริง + rollback ถ้าพัง + รายงาน version
```

★ จุดเปลี่ยนสำคัญ v3: **code_review (ขั้น 6) อยู่หน้า qa (ขั้น 7)** — งานที่ยังไม่ถูกตรวจโค้ดครบทุกไฟล์ จะถึงมือ QA ไม่ได้

📌 ความหมายของ "ทุกรอบ": ทุก task ใหม่ ทุก fix ทุก feature ต้องเดินครบทั้ง 13 หมวดหมู่ตั้งแต่ 1 → 13 เสมอ — ไม่มี task ไหนได้รับอนุญาตให้ลัดขั้น แม้งานจะเล็ก

## 🔒 กฎเหล็ก 7 ข้อ (ห้ามละเมิด)

1. **ห้ามแก้ `worker/zip-format.js`** — ระบบ ZIP ต้องคงเดิม
2. **ห้ามแก้ logic ระบบชำระเงิน** — manual admin approval เท่านั้น
3. **ห้ามใช้ Cloudflare paid features** — D1, R2, Workers free tier เท่านั้น
4. **ห้ามแก้ `main` โดยตรง** — ต้องผ่าน PR + owner approve
5. **ห้ามเดา** — ถ้าไม่แน่ใจให้หยุดและถาม owner
6. **ห้ามทำระบบเดิมพัง** — ทุก change ต้องผ่าน regression test
7. **ทุกไฟล์ที่แก้ต้องผ่าน Code Review ครบทุกบรรทัดก่อนส่ง QA** — ไม่มีข้อยกเว้น 🆕 (T063)

## 📋 Self-Review Checklist 10 ข้อ (Dev ต้องทำก่อนส่ง Code Review)

1. `node --check` ผ่านทุกไฟล์ JS ที่แก้
2. ไม่มี console.log / debugger ตกค้าง (นอกจากตั้งใจไว้ตาม pattern เดิม)
3. ขอบเขตงานตรง plan 100% — ไม่แก้เกินที่ BA ระบุ
4. ไม่แตะไฟล์ต้องห้าม (zip-format.js, payment logic)
5. ไม่มี secrets/token/รหัสผ่าน หลุดเข้าโค้ด
6. Input จาก user ผ่าน validation + escape ทุกจุด (XSS/SQLi ปลอดภัย)
7. ข้อความ error ปลอดภัย (ไม่เปิดเผย internals)
8. Mobile viewport (375px) ไม่พัง (ถ้าแตะ UI)
9. CSS braces ครบคู่ (ถ้าแตะ style.css)
10. เขียน commit message ตามหลัก `T0XX: คำอธิบายสั้น`

## 📋 การจัดการ State

### State file: `ai-team/state.json`

```json
{
  "tasks": {
    "active": ["T063"],           // กำลังทำงาน
    "pending_user_approval": [],  // รอ owner ตัดสินใจ
    "completed": ["T001-T062"],   // เสร็จแล้ว
    "blocked": []                 // ติดปัญหา รอ owner
  }
}
```

### วิธี resume หลังปิดเบราว์เซอร์

เมื่อ owner กลับมา บอก AI:
- **"resume ai-team"** → AI อ่าน state.json + ทำงานต่อ
- **"ai-team status"** → AI แสดงสถานะทุก task
- **"new task: <description>"** → AI สร้าง task ใหม่
- **"approve merge <PR#>"** → owner อนุมัติ merge (ขั้น 12)

## 🌿 การตั้งชื่อ Branch

```
ai-team/<task-id>-<short-slug>

ตัวอย่าง:
  ai-team/T064-fix-login-bug
  ai-team/T065-shared-utils-migration
```

## 📦 การสร้าง Task File

แต่ละ task มีไฟล์ JSON ที่ `ai-team/tasks/T<NNN>-<slug>.json` — template ใน manager.js (`createTaskFile`) สร้าง 13 stages ให้อัตโนมัติ:

```json
{
  "id": "T064",
  "title": "Short title",
  "description": "Detailed description from owner",
  "created_at": "ISO timestamp",
  "status": "intake|scan|plan|develop|self_review|code_review|qa|fix|qa_again|security_final|pr|owner_approval|production|cancelled",
  "current_stage": 1,
  "branch": "ai-team/T064-<slug>",
  "stages": {
    "intake": { "started_at": "...", "completed_at": "...", "result": "..." },
    "scan": { "scanned_files": [], "unknowns": [] },
    "plan": { "plan": "...", "files_to_change": [], "acceptance_criteria": [] },
    "develop": { "commits": [], "files_changed": [] },
    "self_review": { "checklist": "..." },
    "code_review": { "review_result": "...", "files_reviewed": 0 },
    "qa": { "test_results": "...", "bugs_found": [] },
    "fix": { "commits": [], "files_changed": [] },
    "qa_again": { "test_results": "..." },
    "security_final": { "audit_result": "...", "iron_rules_check": "..." },
    "pr": { "pr_number": null, "pr_url": null },
    "owner_approval": { "approved_by": null },
    "production": { "deploy_version": null, "rollback_plan": "..." }
  },
  "blockers": [],
  "decisions": [],
  "log_file": "logs/T064-<slug>.log"
}
```

## 🚦 เงื่อนไขการหยุดถาม owner

AI Manager จะ **หยุดและถาม owner** เมื่อ:
1. ไม่เข้าใจ request ชัดเจน
2. พบ conflict กับกฎเหล็ก
3. ต้องการ deploy ขึ้น production (ต้องผ่าน owner_approval ก่อน)
4. พบ bug ที่ต้องตัดสินใจเชิง business
5. ต้องการข้อมูลที่ไม่มีใน codebase (UNKNOWN จากการ scan)
6. ก่อน merge PR (ต้องรอ owner approve เสมอ — ขั้น 12)
7. ต้องใช้ Cloudflare feature ใด ๆ ที่เสียเงิน

## 🚀 การ Deploy (ขั้น 13)

การ deploy ขึ้น production ต้อง:
1. ผ่าน Code Review (ขั้น 6) + QA ผ่าน 100% (ขั้น 9) + Security ผ่าน (ขั้น 10) ครบก่อน
2. PR ถูก owner merge เข้า main แล้ว (ขั้น 12)
3. Release Manager เตรียม rollback plan ก่อนทุกครั้ง
4. Deploy ด้วย `wrangler deploy` + บันทึก deploy version id
5. หลัง deploy → ตรวจ flow จริงบน production + รายงานผล (ถ้าพัง → rollback ทันที + รายงาน)

## 📊 การรายงาน (ฟอร์แมตบังคับ)

AI Manager รายงานทุก task ครบทุกหัวข้อ:
- งานที่ทำ (task id + title)
- สถานะ: DONE / DONE-NEED FIX / BLOCKED
- ไฟล์ที่แก้ (รายไฟล์ + จำนวนบรรทัด)
- Self Review ผล (10 ข้อ)
- QA ผล (test กี่ข้อ ผ่านกี่ข้อ)
- Code Review ผล (ผู้ตรวจ + ข้อค้นพบ)
- Regression ผล
- Build/Syntax ผล
- Security ผล
- Cloud Cost (Free Plan ยังใช่ไหม)
- ปัญหาที่เหลือ
- ต้องการอนุมัติ: YES / NO
