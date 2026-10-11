# Miusic — Architecture Overview

## Stack
- **Cloudflare Worker** (single Worker, `worker/index.js` — ~9,700 lines)
- **D1** (SQLite — `miusic-store-db`, 14+ tables)
- **R2** (binary blobs — `musicbox-store-media`)
- **Workers Assets** (static files served from repo root, `assets.directory: "."`)

## Folder Structure

```
/                         ← Cloudflare config + HTML + runtime JS (MUST stay in root)
  index.html              ← customer page
  admin.html              ← admin page
  privacy.html            ← PDPA policy
  style.css               ← shared CSS (customer + admin)
  manifest.json           ← PWA manifest
  service-worker.js       ← PWA (cache-first static, network-first API, stale-while-revalidate fonts)
  _headers                ← Cloudflare cache rules
  wrangler.jsonc          ← Worker config (D1 + R2 + cron + assets)
  robots.txt, sitemap.xml ← SEO
  icon-*.png, default-*-cover.svg ← assets
  app-*.js                ← browser JS cluster (16 modules, import each other via ./)
  customer-auth.js        ← customer login/PDPA
  orders.js               ← admin orders + ZIP orchestration
  db-client.js            ← Firestore-shape client over /api/db/*
  firebase-init.js        ← legacy shim (re-exports auth-client.js + storage-adapter.js)
  auth-client.js          ← admin auth shim over /api/auth/*
  storage-adapter.js      ← Cloudinary→R2 migration shim
  thai-sort.js            ← Thai collation (shared: browser ./ + worker ../)
  song-analyzer.js        ← Web Audio API preview-window analysis
  phone-input.js          ← country selector 🇱🇦/🇹🇭
  idb-store.js            ← IndexedDB offline cache (T059)
  shared-utils.js         ← helpers (TODO: migrate from 7 files)
  notify.js, notify.css   ← notification system

/worker/                  ← Cloudflare Worker (NOT deployed as assets)
  index.js                ← all /api/* handlers + cron
  auth-helpers.js         ← PBKDF2 + sessions + HttpOnly cookies
  db-helpers.js           ← generic document store (getDocument/listDocuments/...)
  constants.js            ← LIMITS / RATE_LIMITS / TTL / CACHE
  order-scope.js          ← login-vs-guest order visibility
  zip-format.js           ← ZIP32 streaming (Iron Rule #1: DO NOT EDIT)
  schema.sql              ← D1 schema (14+ tables)

/vendor/                  ← third-party libs
  html2canvas.min.js      ← receipt image download

/scripts/                 ← SQL migrations (run manually via wrangler d1 execute)
  migrations/             ← 13 migration files
  utils/                  ← recovery scripts

/tools/                   ← internal tooling (NOT deployed)
  ai-team/                ← AI team config (manager.js CLI + team.json + state.json + tasks/)

/dev/                     ← prototypes (NOT deployed)
  banner-preview-v2.html

/docs/                    ← documentation (NOT deployed)
  ARCHITECTURE.md         ← this file
```

## Key Concepts

### Document Store
- `documents(collection, id, data JSON, created_at, updated_at)` — single table holds songs/playlists/categories/djs/orders/discounts/promotions/settings
- All app code uses Firestore-shape API (`collection(db, "songs")`, `getDoc`, `addDoc`, etc.) reimplemented in `db-client.js` over HTTP `/api/db/*`

### Auth
- **Admin**: PBKDF2-SHA256 (100k iterations) + session cookie (30d, HttpOnly, sliding renewal)
- **Customer**: same PBKDF2 + separate `customer_sessions` table + soft-delete with 30-day grace + PDPA rights (access/edit/delete/export/consent)
- **Guest**: `miusic_guest_id` UUID in localStorage — guest orders searchable by name+WhatsApp

### Payment Flow
```
pending_payment → verifying → ready → completed
```
- Admin manually verifies slip → `POST /api/admin/orders/:id/verify-payment` (atomic, race-guarded by UNIQUE partial index)
- Worker creates ZIP via R2 Multipart Upload (4-call protocol: start → append × N → finalize-build × M → finalize-compose)
- Customer downloads via one-time token (`GET /api/download/:orderId?token=`) or direct redirect (`/api/track-download/:orderId`)

### Pricing Engine (`app-promotion.js`)
1. Per-item discount: `findActiveDiscountFor` + `applyDiscountToPrice` (percent/fixed/cart_fixed)
2. Cart-level promotion: `computeBestPromotion` (tries all active promos, takes max discount)
3. Final: `subtotal - itemDiscounts - promoDiscount = finalTotal`

### Iron Rules (7)
1. ห้ามแก้ `worker/zip-format.js`
2. ห้ามแก้ logic ระบบชำระเงิน (manual admin approval)
3. ห้ามใช้ Cloudflare paid features
4. ห้าม push ตรงไป main (ผ่าน PR)
5. ห้ามเดา — ถาม owner
6. ห้ามทำระบบเดิมพัง
7. ทุกไฟล์ต้องผ่าน Code Review ก่อน QA

## Quick Links
- Production: https://miusic-store.dj-remix.workers.dev
- Admin: https://miusic-store.dj-remix.workers.dev/admin.html
- Privacy: https://miusic-store.dj-remix.workers.dev/privacy.html
