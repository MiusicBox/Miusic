# 🎵 Miusic — DJ Rmx Music Store

เว็บร้านเพลงออนไลน์ — ฟังเพลง + ซื้อเพลง + ดาวน์โหลดผ่าน WhatsApp

**Production**: https://miusic-store.dj-remix.workers.dev

---

## 📚 Documentation

- [Architecture](docs/ARCHITECTURE.md) — โครงสร้างระบบทั้งหมด (stack + folder + data flow)
- [AI Team](tools/ai-team/README.md) — ทีม AI v3 + workflow (10 roles + 13 stages + 7 iron rules)

## 🚀 Quick Links

| หน้า | URL |
|------|-----|
| 🏠 ลูกค้า | https://miusic-store.dj-remix.workers.dev |
| 🔧 แอดมิน | https://miusic-store.dj-remix.workers.dev/admin.html |
| 🔒 Privacy (PDPA) | https://miusic-store.dj-remix.workers.dev/privacy.html |

## 📁 Folder Structure

```
/                 ← HTML + CSS + runtime JS (Cloudflare Workers Assets)
/worker/          ← Cloudflare Worker backend (API + cron)
/vendor/          ← third-party libs (html2canvas)
/scripts/         ← SQL migrations (run ด้วย wrangler d1 execute)
  /migrations/    ← 13 migration files
  /utils/         ← recovery scripts
/tools/           ← internal tooling (AI team config)
  /ai-team/       ← manager.js CLI + team.json + state.json + tasks/
/dev/             ← prototypes (NOT deployed)
/docs/            ← documentation (NOT deployed)
```

## ⚠️ Iron Rules (ห้ามแตะ)

1. ห้ามแก้ `worker/zip-format.js` (ZIP system frozen)
2. ห้ามแก้ logic ระบบชำระเงิน (manual admin approval only)
3. ห้ามใช้ Cloudflare paid features (free tier only)
4. ห้าม push ตรงไป `main` (ผ่าน PR เท่านั้น)
5. ห้ามเดา — ถ้าไม่แน่ใจ STOP ถาม owner
6. ห้ามทำระบบเดิมพัง — ทุก change ต้องผ่าน regression test
7. ทุกไฟล์ที่แก้ต้องผ่าน Code Review ครบทุกบรรทัดก่อน QA

## 🛠️ Development

```bash
# Install Wrangler
npm install -g wrangler

# Run locally
wrangler dev

# Deploy to production (after PR merge — Cloudflare auto-deploys)
# No manual deploy needed — Cloudflare Workers git integration

# Run SQL migration
wrangler d1 execute miusic-store-db --remote --file=scripts/migrations/<file>.sql

# Clear D1 cache
wrangler d1 execute miusic-store-db --remote --command="DELETE FROM ..."

# Tail logs
wrangler tail
```

## 📦 Tech Stack

- **Cloudflare Worker** (single Worker, ~9,700 lines)
- **D1** (SQLite — 14+ tables, see `worker/schema.sql`)
- **R2** (binary blobs — full songs, cover art, order ZIPs, payment slips)
- **Workers Assets** (static files from repo root)
- **PWA** (service-worker.js — cache-first static, network-first API)
- **No build step** — vanilla JS ES modules, no bundler, no transpiler
