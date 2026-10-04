// worker/constants.js
// ===================================================
// 🆕 (T010-R6): Centralized constants — แทน magic numbers ที่กระจายอยู่ใน worker/index.js
//
//   ปัญหาเดิม: magic numbers (LIMIT 200, batch sizes, TTL) กระจายอยู่ทั่ว worker/index.js
//     → แก้ที่เดียวต้องไล่แก้ทุกจุด + ไม่มี single source of truth
//     → ตั้งค่าผิดจุด → inconsistency (บาง endpoint LIMIT 50, บางจุด LIMIT 200)
//
//   วิธีแก้: รวม constants ทุกหมวดไว้ที่นี่
//     - LIMITS: pagination / batch sizes
//     - RATE_LIMITS: threshold + window สำหรับ login / change-password / forgot-password / order-create
//     - TTL: อายุ session / token / cache
//     - FILE_LIMITS: ขนาดไฟล์สูงสุด (payment slip / song audio)
//     - CACHE: Cache-Control directives
//
//   การใช้งาน:
//     import { LIMITS, RATE_LIMITS, TTL, FILE_LIMITS, CACHE } from "./constants.js";
//
//   ⚠️ หมายเหตุ (T010 Stage 3):
//     - ไฟล์นี้ถูกสร้าง + import ในจุดที่ง่าย ๆ ก่อน (เช่น pagination, rate limit ที่เพิ่มใหม่)
//     - จุดเดิมที่ใช้ magic numbers (LIMIT 200, LIMIT 50, …) ยังไม่ได้ refactor ทั้งหมด
//     - TODO: ในรอบถัดไป → ไล่แทนที่ magic numbers ทุกจุดด้วย constants จากไฟล์นี้
//       (ดู "T010-R6 TODO" comments ใน worker/index.js สำหรับจุดที่ยังไม่ได้แทน)
//
//   ผลกระทบระบบเดิม: 0% — ไฟล์ใหม่, ไม่แตะ logic เดิม (เดิมใช้ literal อยู่ — ยังทำงานเหมือนเดิม)
// ===================================================

// ขนาด batch / pagination — default + max
export const LIMITS = {
  DEFAULT_PAGE: 50,            // default limit สำหรับ list endpoints ที่รองรับ ?limit=
  MAX_PAGE: 200,               // ห้ามเกิน 200 (กัน DoS — ดึง row มากเกินไป)
  SONGS_BATCH: 50,             // batch size สำหรับ lazy-load เพลงในหน้าแรก
  ORDERS_BATCH: 200,           // batch size สำหรับ orders list (legacy fallback)
  BATCH_GET_MAX: 100,          // max ids ต่อ _batch-get request
};

// Rate limit thresholds + windows
//   pattern: threshold (max attempts) + window_ms (เวลาในหน่วย ms)
//   ใช้ login_attempts table (มีอยู่แล้ว) — key ใน column `email` (synthetic เช่น "change-pw:<id>")
export const RATE_LIMITS = {
  // Admin login (worker/index.js:905-907 — H3 fix)
  LOGIN_MAX_ATTEMPTS: 5,
  LOGIN_WINDOW_MS: 15 * 60 * 1000, // 15 นาที

  // Customer change-password (T010-M3) — เหมือน admin change-password (H-21)
  CHANGE_PASSWORD_MAX: 5,
  CHANGE_PASSWORD_WINDOW_MS: 15 * 60 * 1000, // 15 นาที

  // Customer forgot-password (T010-M10)
  //   - per IP: 3 ครั้ง/ชม. (กัน spam จาก IP เดียว)
  //   - per contact: 1 ครั้ง/ชม. (กัน spam ต่อ email/whatsapp — มีอยู่แล้วใน forgot-password handler)
  FORGOT_PASSWORD_IP_MAX: 3,
  FORGOT_PASSWORD_CONTACT_MAX: 1,
  FORGOT_PASSWORD_WINDOW_MS: 60 * 60 * 1000, // 1 ชม.

  // Guest order creation (worker/index.js — order_creation_attempts table)
  ORDER_CREATE_MAX: 10,
  ORDER_CREATE_WINDOW_MS: 60 * 60 * 1000, // 1 ชม.
};

// TTL (Time-To-Live) — อายุ session / token / file
export const TTL = {
  SESSION_TOKEN_DAYS: 30,          // admin session (auth-helpers.js)
  CUSTOMER_SESSION_DAYS: 30,       // customer session (auth-helpers.js)
  DOWNLOAD_TOKEN_HOURS: 24,        // one-time download token (download_tokens table)
  ZIP_FILE_HOURS: 24,              // cache ไฟล์ ZIP ใน R2 browser
  AUDIT_LOG_DAYS: 90,              // retention policy (TODO: cron cleanup)
  LOGIN_ATTEMPTS_DAYS: 1,          // retention policy (TODO: cron cleanup)
};

// File size limits — กันอัปโหลดไฟล์ใหญ่เกินไป (Worker มี body limit 100MB)
export const FILE_LIMITS = {
  PAYMENT_SLIP_MAX_BYTES: 10 * 1024 * 1024,   // 10MB — สลิปการโอนเงิน
  SONG_AUDIO_MAX_BYTES: 100 * 1024 * 1024,    // 100MB — ไฟล์เพลง (Worker body limit)
};

// Cache-Control directives
//   - STATIC_ASSETS_MAX_AGE: cache 1 ปี สำหรับไฟล์ static (JS/CSS/icon)
//   - SW_NO_CACHE: service worker ต้องไม่ cache (กันลูกค้าติด SW version เก่า)
//   - CUSTOMER_API: customer-facing API ต้องใช้ `private` (กัน shared cache poisoning — T010-M9)
//   - PUBLIC_API: 🆕 (T028) public read-only data (songs/categories/djs/playlists) — edge cache 5 นาที
//     ลด Worker invocations 90%+ จาก bot crawl + user page load
export const CACHE = {
  STATIC_ASSETS_MAX_AGE: 31536000,                  // 1 ปี (60*60*24*365)
  SW_NO_CACHE: 'no-cache',
  CUSTOMER_API: 'private, no-cache, must-revalidate',
  PUBLIC_API: 'public, max-age=300',                 // 🆕 (T028): edge cache 5 นาที สำหรับ public data
};
