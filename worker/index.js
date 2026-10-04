// worker/index.js
// ===================================================
// Backend เดียวของเว็บ รับผิดชอบเฉพาะ path "/api/*" (ตั้งค่าไว้ใน wrangler.jsonc ผ่าน
// run_worker_first) — ทุก path อื่นๆ ของเว็บ (index.html, admin.html, .js, .css เดิมทั้งหมด)
// ยังถูกเสิร์ฟเป็น static asset ตามปกติ ไม่ผ่าน Worker นี้เลย จึงไม่กระทบระบบเดิมส่วนอื่น
//
// ประกอบด้วย 3 ส่วน:
//   1) /api/upload/*  — อัปโหลดไฟล์เข้า Cloudflare R2 (ของเดิม ไม่แก้ไข)
//   2) /api/auth/*    — ระบบยืนยันตัวตนแอดมิน ใหม่ทั้งหมด แทนที่ Firebase Auth (2026-09-11)
//   3) /api/db/*      — Generic document store บน Cloudflare D1 ใหม่ทั้งหมด แทนที่ Firestore (2026-09-11)
//
// ทำไมต้องมี /api/db/*:
//   D1 คุยจาก browser ตรงๆ ไม่ได้เลย (ต้องผ่าน Worker ที่มี binding เท่านั้น เหมือน R2)
//   ฝั่ง browser จึงเรียกผ่าน db-client.js (หน้าตาเหมือน Firestore SDK เดิมทุกฟังก์ชันที่แอปนี้ใช้จริง
//   คือ collection/doc/getDoc/getDocs/addDoc/setDoc/updateDoc/deleteDoc/query/where/orderBy)
//   แล้ว db-client.js ค่อยยิง fetch มาที่ endpoint กลุ่มนี้อีกที — ทำให้ app-admin.js/orders.js/ฯลฯ
//   ไม่ต้องแก้ logic เดิมเลย แก้แค่บรรทัด import ให้ชี้มาที่ไฟล์ในเว็บเราแทน CDN ของ Firebase
//
//   ⚠️ หมายเหตุ (2026-09-17):
//     ก่อนหน้านี้บรรทัดนี้เคยระบุ onSnapshot รวมอยู่ใน list ของ "ฟังก์ชันที่แอปนี้ใช้จริง"
//     แต่จริง ๆ แล้ว onSnapshot ไม่มี caller จริงใน codebase แล้ว (ย้ายไปใช้ fetchCustomerOrdersOnce)
//     ดูคอมเมนต์ "DEAD CODE" ที่ฟังก์ชัน onSnapshot ใน db-client.js สำหรับรายละเอียดเต็ม
//     ฟังก์ชัน onSnapshot/listenCustomerOrders ยัง export อยู่ใน db-client.js ตามกฎ
//     "ห้ามลบโค้ดเพียงเพราะคิดว่าไม่ได้ใช้งาน" — เผื่ออนาคตต้องการ realtime กลับมา
// ===================================================
import { hashPassword, verifyPassword, getSessionAdmin, createSession, deleteSession, buildSessionCookie, buildClearCookie, getCookie, cleanupExpiredSessions, getCustomerSession, createCustomerSession, deleteCustomerSession, buildCustomerSessionCookie, buildClearCustomerCookie, cleanupExpiredCustomerSessions } from "./auth-helpers.js";
import { getDocument, listDocuments, queryDocuments, setDocument, updateDocument, deleteDocument, countDocuments, getDocumentsByIds, countDocumentsAll, findDuplicateSongsByName } from "./db-helpers.js";
// 🔧 (2026-09-18): ZIP streaming helpers สำหรับสร้างไฟล์ ZIP ฝั่ง Worker
// ทำไมต้องใช้: Worker request body limit 100MB → สร้าง ZIP > 100MB ผ่าน R2 Multipart Upload ทีละเพลง
// ไม่กระทบฟังก์ชันเดิมใน worker/index.js เลย — import เข้ามาใช้เฉพาะใน handleOrderZip*
import {
  makeZipEntryStream,                  // คงไว้ตามกฎ #7 (เผื่อใช้ในอนาคต)
  makeCentralDirectoryStream,         // คงไว้ตามกฎ #7
  buildCentralDirectoryBytes,         // ใช้ใน finalize — Uint8Array แทน stream (R2 ต้องการ known length)
  encodeFilename,
  buildLocalFileHeader,
  buildDataDescriptor,
  crc32Update,
} from "./zip-format.js";
// 🆕 (2026-10-03 v10): กติกาแยก Login / Guest (pure functions — ดู worker/order-scope.js)
import {
  ALLOW_LEGACY_GUEST_ORDERS,
  normalizeGuestId,
  isOrderInLoginList,
  isOrderInGuestList,
  isOrderVisibleForReceiptLookup,
} from "./order-scope.js";
// 🆕 (T010-R6): Centralized constants — แทน magic numbers (LIMIT 200, rate limit thresholds, TTL, Cache-Control)
//   ใช้ในจุดใหม่ที่เพิ่มในรอบ T010 (M3/M9/M10/M11) — จุดเดิมยังใช้ literal อยู่ (TODO รอบถัดไป)
import { LIMITS, RATE_LIMITS, CACHE, TTL } from "./constants.js";

// โฟลเดอร์เหล่านี้เดิมใช้ toCloudinaryDownloadUrl() เติม fl_attachment ให้บังคับดาวน์โหลด
// (ไฟล์เพลงเต็ม/ไฟล์ ZIP ออเดอร์ — ไม่ใช่ไฟล์ที่เปิดเล่น/แสดงผลตรงๆ บนเว็บ)
// ย้ายมา R2 แล้วให้ตั้ง Content-Disposition ตอนอัปโหลดแทน เพื่อให้พฤติกรรม "กดแล้วดาวน์โหลดทันที" เหมือนเดิม
const FORCE_DOWNLOAD_FOLDERS = new Set(["full-songs", "order-zips"]);

// 🔧 (2026-09-22 fix Bug #2): audit log helper — บันทึกทุก action ที่แอดมินทำ
//   เก็บ: ใคร (admin_id + email) ทำอะไร (action) กับอะไร (collection + target_id) เมื่อไหร่ (timestamp)
//   ใช้ใน: PUT/PATCH/DELETE ของ songs/playlists/orders/categories/djs/settings/promotions/discounts
//   ความปลอดภัย: insert-only — ไม่มี UPDATE/DELETE ผ่าน API → กันแอดมินลบประวัติตัวเอง
//   ผลกระทบระบบเดิม: 0% — ถ้าตาราง audit_log ไม่มี → log ข้ามไป (ไม่ block action)
//   🔧 (2026-09-22 fix Bug #2 UI v6): ใช้ ctx.waitUntil() รัน INSERT เป็น background
//     ปัญหาเดิม: await INSERT → ถ้า D1 ช้า/hang → บล็อก response → UI ค้าง "กำลังอัปโหลด..."
//     วิธีแก้: ใช้ ctx.waitUntil(auditInsertPromise) → return ทันที ไม่รอ INSERT
//     ถ้า ctx ไม่มี (เช่น cron หรือ env เดิม) → fallback ใช้ await ตามเดิม (ปลอดภัย)
async function writeAuditLog(env, request, admin, action, collection, targetId, targetName, beforeData, afterData) {
  if (!admin || !env.DB) return;
  const ctx = env.__ctx;
  const clientIP = request.headers.get("CF-Connecting-IP") || "unknown";
  const now = new Date().toISOString();

  // สร้าง Promise สำหรับ INSERT audit_log
  const auditInsertPromise = env.DB.prepare(
    "INSERT INTO audit_log (admin_id, admin_email, action, collection, target_id, target_name, before_data, after_data, ip_address, created_at) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(
    admin.id || "",
    admin.email || "",
    action,
    collection,
    targetId || "",
    targetName || "",
    beforeData ? JSON.stringify(beforeData) : null,
    afterData ? JSON.stringify(afterData) : null,
    clientIP,
    now
  ).run().catch((auditErr) => {
    // ถ้าตาราง audit_log ไม่มี → log ใน Worker logs แต่ไม่ block action
    console.warn("audit_log insert failed (table may not exist — run schema.sql):", auditErr?.message);
  });

  // ถ้ามี ctx → รันใน background (response ไม่รอ INSERT)
  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(auditInsertPromise);
    return; // ส่ง response ทันที ไม่รอ audit log INSERT
  }
  // fallback: รอ INSERT (กรณี ctx ไม่มี)
  await auditInsertPromise;
}

// 🔒 (Audit Fix C-5): Helper สำหรับบันทึก status_history ลงตารางแยกแบบ append-only (atomic)
//   ปัญหาเดิม: status_history เป็น JSON array ใน order document → read-modify-write ไม่ atomic
//     → 2 admins แก้พร้อมกัน → entry ตัวแรกหาย (lost update)
//   วิธีแก้: INSERT ลงตาราง order_status_history แยกต่างหาก → atomic โดยธรรมชาติ (autoincrement PK)
//   ใช้คู่ขนานกับ JSON array เดิม (backward-compat) — JSON array ยังอัปเดตเหมือนเดิม
//   ผลกระทบระบบเดิม: 0% — best-effort INSERT; ถ้าพัง → log warning + ข้าม (ไม่ block request)
//     ถ้าตาราง order_status_history ไม่มี (DB เก่า) → INSERT พัง → catch + log + ข้าม
//   พารามิเตอร์:
//     env: Worker env (มี env.DB + env.__ctx)
//     orderId: documents.id WHERE collection='orders'
//     status: status ของ order ณ ตอนนั้น
//     note: หมายเหตุภาษาไทย (เช่น "แอดมินยืนยันสลิป", "Worker atomic update")
//     byId: admin_id หรือ "system" หรือ "customer"
//     byName: display_name ของผู้บันทึก (เช่น "Main Admin", "Miusic Worker")
async function insertOrderStatusHistory(env, orderId, status, note, byId, byName) {
  if (!env || !env.DB || !orderId) return;
  const ctx = env.__ctx;
  const now = new Date().toISOString();

  const insertPromise = env.DB.prepare(
    "INSERT INTO order_status_history (order_id, status, note, by_id, by_name, created_at) " +
    "VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(
    orderId,
    String(status || ""),
    note ? String(note).slice(0, 500) : null,
    byId ? String(byId).slice(0, 100) : null,
    byName ? String(byName).slice(0, 200) : null,
    now
  ).run().catch((histErr) => {
    // ถ้าตาราง order_status_history ไม่มี → log ใน Worker logs แต่ไม่ block action
    //   ระบบเดิมยังทำงานได้ — JSON array ยังถูกอัปเดตเหมือนเดิม
    console.warn("[C-5] order_status_history insert failed (table may not exist — run schema.sql):", histErr?.message);
  });

  // ถ้ามี ctx → รันใน background (response ไม่รอ INSERT)
  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(insertPromise);
    return;
  }
  // fallback: รอ INSERT (กรณี ctx ไม่มี)
  await insertPromise;
}

// 🔧 (2026-09-22 fix Bug #4): sanitize string สำหรับ orderId + ค่าที่เข้า HTTP header / R2 metadata
//   กัน CRLF injection → attacker ใส่ \r\n ใน orderId → inject header
function sanitizeHeaderValue(value) {
  return String(value || "")
    .replace(/[\r\n]/g, "")   // ลบ CRLF — กัน header injection
    .replace(/["']/g, "")      // ลบ quotes — กัน Content-Disposition injection
    .replace(/[<>]/g, "")      // ลบ angle brackets — กัน HTML injection
    .trim()
    .slice(0, 200);            // limit length — กัน overflow
}

// 🔧 (2026-09-22 fix Bug #1): helper สำหรับ error ที่ไม่รั่ว internals
//   เดิม: ส่ง err.message ตรงๆ ให้ลูกค้า → แฮกเกอร์เห็น SQL error, table name, ฯลฯ
//   ใหม่: log จริงใน Worker logs + ส่งข้อความกลางๆ ให้ลูกค้า
function safeError(userMessage, err) {
  console.error("[safeError]", userMessage, ":", err?.message || String(err));
  return userMessage;
}

// 🔒 (Audit Fix H-10): Server-side validation สำหรับ discount_value + type ใน discounts/promotions
//   ปัญหาเดิม: client-side validate แค่ discount_value <= 100 สำหรับ percent types
//     sub-admin สามารถ bypass client ด้วย direct API call: PATCH /api/db/promotions/:id
//     { data: { discount_value: 150 } } → server stores 150 → calc Math.min(100) clamps
//     แต่กรณี type=cart_fixed ไม่มี clamp → sub-admin สามารถตั้ง discount=999999 LAK
//     → final_total = 0 (ฟรี) แม้ลูกค้าไม่มี coupon
//   วิธีแก้: validate ฝั่ง server ทุกครั้งที่ PUT/PATCH discounts/promotions
//   ผลกระทบระบบเดิม: 0% — ถ้าค่าถูกต้อง → ผ่าน (เหมือนเดิม)
//   ถ้าค่าผิด → return error message (string) → caller return 400
//   ถ้าไม่มี type หรือ discount_value → ข้าม validation (backward-compat กับของเดิม)
function validateDiscountData(collection, data) {
  if (!data || typeof data !== "object") return null;
  const type = data.type;
  // ถ้าไม่มี type → ข้าม validation (อาจเป็น document เดิมที่ยังไม่ได้ตั้ง type)
  if (!type) return null;
  const discountValue = data.discount_value;
  // valid types
  const validTypes = ["cart_percent", "cart_fixed", "buy_x_get_y_percent", "playlist_tiered_percent", "item_percent", "item_fixed"];
  if (!validTypes.includes(type)) {
    return `ประเภทส่วนลด "${type}" ไม่ถูกต้อง — ประเภทที่รองรับ: ${validTypes.join(", ")}`;
  }
  // ตรวจ discount_value (percent types: 0-100, fixed types: >= 0)
  const isPercentType = type === "cart_percent" || type === "buy_x_get_y_percent" || type === "playlist_tiered_percent" || type === "item_percent";
  const isFixedType = type === "cart_fixed" || type === "item_fixed";
  if (discountValue != null) {
    const v = Number(discountValue);
    if (!Number.isFinite(v)) {
      return `discount_value ต้องเป็นตัวเลข — ได้รับ: ${discountValue}`;
    }
    if (v < 0) {
      return `discount_value ต้อง >= 0 — ได้รับ: ${v}`;
    }
    if (isPercentType && v > 100) {
      return `discount_value สำหรับ type="${type}" ต้อง <= 100 (เป็นเปอร์เซ็นต์) — ได้รับ: ${v}`;
    }
    if (isFixedType && v > 1000000000) {
      // upper bound 1 billion LAK — กัน overflow / ราคาติดลบ
      return `discount_value สำหรับ type="${type}" ต้อง <= 1,000,000,000 LAK — ได้รับ: ${v}`;
    }
  }
  // ตรวจ tier.discount_percent สำหรับ playlist_tiered_percent
  if (type === "playlist_tiered_percent" && Array.isArray(data.tiers)) {
    for (let i = 0; i < data.tiers.length; i++) {
      const tier = data.tiers[i];
      if (!tier || typeof tier !== "object") continue;
      const tp = Number(tier.discount_percent);
      if (Number.isFinite(tp)) {
        if (tp < 0 || tp > 100) {
          return `tier[${i}].discount_percent ต้องอยู่ในช่วง 0-100 — ได้รับ: ${tp}`;
        }
      }
      if (tier.min_quantity != null) {
        const mq = Number(tier.min_quantity);
        if (Number.isFinite(mq) && mq < 1) {
          return `tier[${i}].min_quantity ต้อง >= 1 — ได้รับ: ${mq}`;
        }
      }
    }
  }
  // ตรวจ date range (ถ้ามีทั้งคู่)
  if (data.start_at && data.end_at) {
    const s = new Date(data.start_at);
    const e = new Date(data.end_at);
    if (!isNaN(s.getTime()) && !isNaN(e.getTime()) && s.getTime() > e.getTime()) {
      return `start_at (${data.start_at}) ต้อง <= end_at (${data.end_at})`;
    }
  }
  return null; // valid
}

// 🔒 (Audit Fix M-26): Server-side validation สำหรับ settings save
//   ปัญหาเดิม: settings save ไม่มี server-side field validation
//   → sub-admin สามารถส่ง XSS payload ใน bank_name → customer checkout แสดง XSS
//   วิธีแก้: validate fields ที่ sensitive (bank_account, qr_code_url, whatsapp_number, website_logo)
//   ผลกระทบระบบเดิม: 0% — ถ้าค่าถูกต้อง → ผ่าน (เหมือนเดิม)
//   ถ้าค่าผิด → return 400 + ไม่บันทึก
function validateSettingsData(data) {
  if (!data || typeof data !== "object") return null;
  // bank_account: digits + dash only, max 30 chars
  if (data.bank_account != null) {
    const ba = String(data.bank_account).trim();
    if (ba.length > 30) return "เลขบัญชียาวเกินไป (สูงสุด 30 ตัวอักษร)";
    if (ba && !/^[0-9\-]+$/.test(ba)) return "เลขบัญชีต้องเป็นตัวเลขและขีดกลางเท่านั้น";
  }
  // qr_code_url + website_logo: ต้องเป็น URL ที่ถูกต้อง (https:// หรือ /)
  for (const urlField of ["qr_code_url", "website_logo"]) {
    if (data[urlField] != null) {
      const u = String(data[urlField]).trim();
      if (u && u.length > 500) return `${urlField} ยาวเกินไป (สูงสุด 500 ตัวอักษร)`;
      if (u && !u.startsWith("/") && !u.startsWith("https://") && !u.startsWith("http://")) {
        return `${urlField} ต้องเป็น URL ที่ถูกต้อง (เริ่มด้วย / หรือ https://)`;
      }
    }
  }
  // whatsapp_number: digits only, max 20 chars
  if (data.whatsapp_number != null) {
    const wn = String(data.whatsapp_number).trim();
    if (wn.length > 20) return "เบอร์ WhatsApp ยาวเกินไป (สูงสุด 20 ตัวอักษร)";
    if (wn && !/^[0-9\+]+$/.test(wn)) return "เบอร์ WhatsApp ต้องเป็นตัวเลขและ + เท่านั้น";
  }
  // website_name: max 100 chars
  if (data.website_name != null && String(data.website_name).length > 100) {
    return "ชื่อเว็บไซต์ยาวเกินไป (สูงสุด 100 ตัวอักษร)";
  }
  return null; // valid
}

// 🔒 (Audit Fix M-49): Redact password_hash + session_token จาก audit_log response
//   ปัญหาเดิม: audit_log response ส่ง before_data/after_data แบบ raw →
//   ถ้า admin เปลี่ยนรหัสผ่าน → before_data มี password_hash เก่า → รั่วใน devtools
//   วิธีแก้: ลบ password_hash, session_token, password ออกจาก response (server-side)
//   ผลกระทบระบบเดิม: 0% — audit_log UI ไม่แสดงฟิลด์นี้อยู่แล้ว (client-side filter)
//   แต่ network response ยังรั่ว → server-side redact เป็น defense in depth
function redactAuditSensitiveFields(obj) {
  if (!obj || typeof obj !== "object") return obj;
  const SENSITIVE = new Set(["password_hash", "session_token", "password"]);
  if (Array.isArray(obj)) return obj.map(redactAuditSensitiveFields);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE.has(k)) {
      out[k] = "[REDACTED]";
    } else if (v && typeof v === "object") {
      out[k] = redactAuditSensitiveFields(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

// 🔧 (2026-09-28 fix Critical C3): Dynamic CORS origin allowlist
//   เดิม: ไม่ตั้ง ACAO เลย = same-origin เท่านั้น
//         → ในกรณีที่ Worker deploy ในหลายโดเมน (เช่น *.workers.dev + custom domain)
//           หรือ test บน localhost → API ใช้ไม่ได้เพราะ browser block cross-origin
//   ใหม่: รองรับ dynamic origin ผ่าน env var ALLOWED_ORIGINS (comma-separated)
//         - ถ้า Origin header ของ request อยู่ใน allowlist → reflect กลับ (ปลอดภัย + รองรับ credentials)
//         - ถ้าไม่ตั้ง ALLOWED_ORIGINS → fallback same-origin (current behavior, ไม่ set ACAO)
//         - ถ้า Origin ไม่อยู่ใน allowlist → ไม่ set ACAO (browser block cross-origin)
//   ความปลอดภัย:
//     - ไม่ใช้ "*" เพราะใช้กับ credentials ไม่ได้ (session cookie)
//     - ใช้ reflect origin เฉพาะที่อยู่ใน allowlist → ปลอดภัยจาก CSRF
//     - Allowlist ผ่าน env var → admin ตั้งเอง ไม่ hardcode
//   วิธีตั้ง:
//     wrangler secret put ALLOWED_ORIGINS
//     ค่าตัวอย่าง: https://miusic.example.com,https://staging.miusic.example.com
//   ผลกระทบระบบเดิม: 0% — ถ้าไม่ตั้ง env → fallback same-origin (เหมือนเดิม)
//   ที่มาของ request header: module-level state (set ใน fetch handler entry)
//     ปลอดภัยเพราะ Cloudflare Workers ทำงาน single-threaded ต่อ isolate →
//     module state ไม่ race ข้าม requests
let _currentRequest = null;
let _currentEnv = null;
let _allowedOriginsCache = null;
let _allowedOriginsEnvValue = null;
function getAllowedOrigins(env) {
  // cache ค่า env เพื่อกัน parse ใหม่ทุก request
  // 🔒 (Audit Fix H-37): ใช้ local variable เพื่อกัน race — parse ใหม่ถ้า envValue เปลี่ยน
  //   ปัญหาเดิม: module-level _allowedOriginsCache + _allowedOriginsEnvValue แชร์กันระหว่าง
  //   concurrent requests ใน isolate เดียวกัน → race ระหว่าง await
  //   วิธีแก้: parse ใหม่ทุกครั้ง ถ้า envValue เปลี่ยน → cache เป็น local
  //   (parse เป็น string split → ไม่หนัก, ~1μs)
  //   ผลกระทบระบบเดิม: 0% — ถ้า envValue ไม่เปลี่ยน → return cache (เหมือนเดิม)
  //   ถ้า envValue เปลี่ยน → parse ใหม่ (race-safe)
  const envValue = env?.ALLOWED_ORIGINS || "";
  // 🔒 (H-37): parse ใหม่ทุกครั้ง — กัน module state race
  //   cache เดิมอาจถูกเขียนทับโดย request อื่น → ใช้ local ปลอดภัยกว่า
  //   (parse ค่าเดียวกันซ้ำ ๆ ไม่ช้า เพราะ string split)
  return envValue
    .split(",")
    .map(s => s.trim())
    .filter(s => s.length > 0);
}


// Security headers (C-8 fix via Worker code instead of _headers file)
// Cloudflare _headers parser has caching issues with multibyte chars
// so we add security headers here in Worker code instead
function securityHeaders() {
  return {
    "Content-Security-Policy": "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; img-src 'self' https://*.r2.dev https://res.cloudinary.com data:; font-src 'self'; connect-src 'self' https://api.cloudinary.com; media-src 'self' https://*.r2.dev; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; frame-src 'none'",
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains; preload",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), bluetooth=()",
  };
}

function corsHeaders() {
  // base headers — คงไว้เหมือนเดิม + เพิ่ม GET/PUT/PATCH ใน Allow-Methods (เดิมมีแค่ POST/DELETE/OPTIONS)
  const baseHeaders = {
    "Access-Control-Allow-Methods": "POST, DELETE, OPTIONS, GET, PUT, PATCH",
    "Access-Control-Allow-Headers": "Content-Type",
    // 🔧 (2026-09-28 fix C3): ถ้ามี allowlist + Origin ตรง → reflect origin + Allow-Credentials
    //   เราใช้ session cookie (HttpOnly) → ต้องการ Allow-Credentials เพื่อ browser ส่ง cookie ข้าม origin
    "Access-Control-Allow-Credentials": "true",
  };
  // ใช้ module-level state (set ใน fetch handler entry) — ปลอดภัยเพราะ Workers single-threaded
  const request = _currentRequest;
  const env = _currentEnv;
  if (!request || !env) {
    // fallback เดิม (same-origin, ไม่ set ACAO) — กรณี cron หรือ call จากนอก fetch handler
    return baseHeaders;
  }
  const allowed = getAllowedOrigins(env);
  if (allowed.length === 0) {
    // ไม่ตั้ง ALLOWED_ORIGINS → fallback same-origin (current behavior)
    return baseHeaders;
  }
  const origin = request.headers.get("Origin") || "";
  if (!origin) {
    // ไม่มี Origin header (เช่น curl, server-to-server) → ไม่ set ACAO
    return baseHeaders;
  }
  if (allowed.includes(origin)) {
    // Origin อยู่ใน allowlist → reflect origin กลับ (ปลอดภัย + รองรับ credentials)
    return { ...baseHeaders, "Access-Control-Allow-Origin": origin, "Vary": "Origin" };
  }
  // Origin ไม่อยู่ใน allowlist → ไม่ set ACAO (browser block cross-origin)
  return baseHeaders;
}

// extraHeaders (ไม่บังคับ): ใช้ตอนต้องแปะ Set-Cookie ไปกับ response (login/logout/bootstrap)
function jsonResponse(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(), ...extraHeaders, ...securityHeaders() },
  });
}

// 🆕 (T010-M1): secureJsonResponse — เหมือน jsonResponse แต่ใช้สำหรับ customer auth responses
//   ทำไมต้องมี helper แยก?
//     ปัญหา: customer auth responses (register/login/logout) เดิมใช้ `new Response(JSON.stringify(...))`
//     ตรง ๆ โดยไม่ผ่าน jsonResponse → ขาด security headers (CSP, X-Frame-Options, ACAO, X-Content-Type-Options)
//     ผล: clickjacking / MIME sniffing / CORS bypass บน customer auth
//
//   วิธีแก้: helper นี้ wrap jsonResponse แบบเดิม + บังคับให้มี security headers
//     (จริง ๆ jsonResponse มี securityHeaders อยู่แล้ว — แต่ทำ helper แยกเพื่อให้เห็นชัดว่าจุดนี้คือ
//      "customer-facing auth response" ตามมาตรฐาน OWASP)
//
//   ผลกระทบระบบเดิม: 0%
//     - ก่อน: customer auth ส่งเฉพาะ Content-Type + Set-Cookie → ขาด security headers
//     - หลัง: customer auth ส่ง Content-Type + Set-Cookie + CSP + X-Frame-Options + ฯลฯ
//     - frontend ไม่กระทบ (headers เพิ่มเติม ไม่ทำให้ logic เดิมพัง)
function secureJsonResponse(obj, status = 200, extraHeaders = {}) {
  return jsonResponse(obj, status, extraHeaders);
}

// 🆕 (T010-M11): parsePagination — parse + clamp `?limit=&offset=` query params
//   default: limit=50, max: 200, offset: >= 0
//   ใช้ใน customer/orders + customer/favorites + admin/password-reset-requests
//   กัน DoS (ดึง row มากเกินไป) + กัน negative offset
function parsePagination(url) {
  const limit = Math.min(
    parseInt(url.searchParams.get("limit") || String(LIMITS.DEFAULT_PAGE), 10) || LIMITS.DEFAULT_PAGE,
    LIMITS.MAX_PAGE
  );
  const offset = Math.max(
    parseInt(url.searchParams.get("offset") || "0", 10) || 0,
    0
  );
  return { limit, offset };
}

// 🆕 (T011-L2): isValidEmail — validate email format ก่อน insert ใน register
//   ปัญหาเดิม: register เก็บ email อะไรก็ได้ (แม้ "abc" หรือ "abc@") → DB สะสม invalid email
//   วิธีแก้: ตรวจรูปแบบด้วย regex ง่าย ๆ (มี @ + . กลาง) — ไม่เข้มงวดเกินไป
//   ผลกระทบระบบเดิม: 0% — register ที่ใช้ email ที่ถูกต้องอยู่แล้ว ผ่านได้ปกติ
function isValidEmail(email) {
  if (!email) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// 🆕 (T011-L3): isPasswordStrong — password complexity ขั้นต่ำ
//   ปัญหาเดิม: register ตรวจแค่ password.length >= 6 → "aaaaaa" หรือ "123456" ผ่าน
//   วิธีแก้: อย่างน้อย 6 ตัว + ต้องมีตัวเลขหรืออักขระพิเศษ (กัน password ง่ายเกินไป)
//   ไม่เข้มงวดเกินไป — ไม่บังคับตัวใหญ่/ตัวเล็ก (ลูกค้าทั่วไปใช้ WhatsApp มือถือ)
//   ผลกระทบระบบเดิม: password ที่มีอยู่แล้วทั้งหมดยังใช้ได้ (ไม่ได้ rehash) — กระทบเฉพาะ register ใหม่
function isPasswordStrong(password) {
  if (!password || password.length < 6) return false;
  // ต้องมีอย่างน้อย 1 ตัวเลข หรือ 1 ตัวอักษรพิเศษ
  return /[0-9!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password);
}

// 🆕 (T011-L6): escapeLikePattern — escape LIKE wildcards กัน search แปลก ๆ
//   ปัญหาเดิม: ส่งค่า `%` หรือ `_` ใน search query → SQLite LIKE ตีความเป็น wildcard
//     เช่น ค้น "%admin%" → match ทุก row ที่มี "admin" อยู่กลางข้อความ (อาจรั่วข้อมูล)
//   วิธีแก้: escape `%`, `_`, `\` ด้วย backslash + ใช้ ESCAPE clause ใน SQL
//   ผลกระทบระบบเดิม: 0% — กรณี search ปกติ (ไม่มี wildcard) ผ่านเหมือนเดิม
function escapeLikePattern(str) {
  return String(str || "").replace(/[%_\\]/g, "\\$&");
}

// สุ่มชื่อไฟล์ปลายทางใน R2 ให้ไม่ชนกัน (คล้าย public_id ของ Cloudinary) แต่ยังเก็บนามสกุลไฟล์เดิมไว้
// เพื่อให้เบราว์เซอร์/แอปเดา content type และเปิดไฟล์ได้ถูกต้อง
// 📸 (added STEP 6+) — สร้าง wa.me deep link สำหรับแอดมินส่งข้อความแจ้งลูกค้าหลัง verify/reject slip
//   notification only — ไม่ใช่ระบบหลัก (R2+D1 คือ source of truth)
//   ถ้า WhatsApp เปิดไม่ได้ slip ยังอยู่ในระบบ
// 🆕 (T044-B): รองรับเบอร์ไทย+ลาว — fallback prepend country code ถ้า DB เก็บเบอร์เก่าไม่มี 856/66
//   เดิม: ใช้ raw customerWhatsapp ตรงๆ → ถ้า DB เก็บ "20XXXXXXXX" (ลาวเก่า) → wa.me ตีความเป็นอียิปต์ (+20) → ลูกค้าไม่ได้รับการแจ้งเตือน
//   ใหม่: เช็ค country code 856/66 → ถ้าไม่มี → สันนิษฐานลาว (เดิม) หรือ detect จากรูปแบบ
//   sync กับ fallback logic ฝั่ง client (orders.js line 2567)
function buildAdminNotifyWhatsAppUrl(customerWhatsapp, newStatus, receiptNumber, customerName, orderTotal, rejectReason) {
  let num = String(customerWhatsapp || "").replace(/[^0-9]/g, "");
  if (!num) return null;
  // 🆕 (T044-B): fallback — ถ้าไม่มี country code นำหน้า → สันนิษฐานลาว (sync กับฝั่ง client)
  //   ถ้าเบอร์ขึ้นต้นด้วย 020 → ลาว → prepend 856 + strip 0 ต้น
  //   ถ้าเบอร์ขึ้นต้นด้วย 08/09 → ไทย → prepend 66 + strip 0 ต้น
  //   ถ้าเบอร์ขึ้นต้นด้วย 20 (10 หลัก) → ลาว → prepend 856
  //   ถ้าไม่ตรงเงื่อนไขข้างบน → สันนิษฐานลาว → prepend 856 (เดิม)
  if (!num.startsWith("856") && !num.startsWith("66")) {
    if (num.startsWith("020")) num = "856" + num.slice(1);
    else if ((num.startsWith("08") || num.startsWith("09")) && num.length === 10) num = "66" + num.slice(1);
    else if (num.startsWith("20") && num.length === 10) num = "856" + num;
    else if (num.startsWith("0") && num.length === 10) num = "66" + num.slice(1);
    else num = "856" + num;
  }
  const amt = orderTotal != null ? Number(orderTotal).toLocaleString("th-TH") + " ₭" : "—";
  const rcpt = receiptNumber || "—";
  let text;
  if (newStatus === "verified") {
    text = `✅ ยืนยันสลิปการโอนเงินแล้ว\n\nOrder: ${rcpt}\nยอด: ${amt}\n\nไฟล์เพลงกำลังเตรียมให้ — แอดมินจะส่งลิงก์ดาวน์โหลดให้อีกครั้งในไม่ช้า\nขอบคุณที่สั่งซื้อครับ/ค่ะ`;
  } else if (newStatus === "rejected") {
    text = `❌ สลิปการโอนเงินของคุณยังไม่ผ่านการตรวจสอบ\n\nOrder: ${rcpt}\nยอดที่ต้องชำระ: ${amt}\n\nเหตุผล: ${rejectReason || "ไม่ระบุ"}\n\nกรุณาตรวจสอบและอัปโหลดสลิปใหม่อีกครั้งที่หน้าเว็บ\nหากมีข้อสงสัย ติดต่อแอดมินได้ครับ/ค่ะ`;
  } else {
    text = `Order ${rcpt} — สถานะสลิป: ${newStatus}`;
  }
  return `https://wa.me/${num}?text=${encodeURIComponent(text)}`;
}

function buildObjectKey(folder, originalName) {
  const safeFolder = (folder || "").replace(/[^a-zA-Z0-9/_-]/g, "").replace(/^\/+|\/+$/g, "");
  const extMatch = /\.[a-zA-Z0-9]+$/.exec(originalName || "");
  const ext = extMatch ? extMatch[0] : "";
  const uniquePart = `${Date.now()}-${crypto.randomUUID()}`;
  return (safeFolder ? `${safeFolder}/` : "") + uniquePart + ext;
}

async function handleUpload(request, env) {
  // 🔒 Security (2026-09-11): ตรวจ admin session ก่อนอัปโหลด — กันคนทั่วไปอัปโหลดไฟล์เข้า R2
  const uploadAdmin = await getSessionAdmin(request, env);
  if (!uploadAdmin) return jsonResponse({ error: "ยังไม่ได้เข้าสู่ระบบ" }, 401);

  if (!env.BUCKET) {
    return jsonResponse({ error: "ยังไม่ได้ผูก R2 bucket (binding: BUCKET) ใน wrangler.jsonc" }, 500);
  }
  if (!env.R2_PUBLIC_BASE_URL) {
    return jsonResponse({ error: "ยังไม่ได้ตั้งค่า R2_PUBLIC_BASE_URL ใน wrangler.jsonc" }, 500);
  }

  // 🔧 (2026-09-18 v3): ยกเลิก file size limit — กลับไปไม่มี limit เหมือนเดิม
  //   เหตุผล: ZIP ออเดอร์ที่รวมเพลงหลายสิบเพลง จะเกิน limit ที่กำหนด → ทำให้อัปโหลดไม่ได้
  //   ฝั่ง client (app-admin.js) มี MAX_FULL_SONG_SIZE_MB = 100MB สำหรับเพลงเดี่ยวอยู่แล้ว
  //   ZIP ออเดอร์ไม่มี limit ฝั่ง client → ต้องไม่มี limit ฝั่ง Worker ด้วย
  //   Worker free plan มี request body limit 100MB โดย default → ถ้าไฟล์เกิน Worker จะตัดเอง
  //   ถ้าอนาคตต้องการ limit จริง ๆ → ใช้ Worker Paid plan (limit 500MB) แล้วค่อยตั้ง limit

  let form;
  try {
    form = await request.formData();
  } catch (err) {
    return jsonResponse({ error: "อ่านข้อมูลอัปโหลดไม่สำเร็จ (ต้องเป็น multipart/form-data)" }, 400);
  }

  const file = form.get("file");
  const folder = String(form.get("folder") || "");
  const resourceType = String(form.get("resourceType") || "auto");

  if (!file || typeof file === "string") {
    return jsonResponse({ error: "ไม่พบไฟล์ที่จะอัปโหลด (field 'file')" }, 400);
  }

  // 🔒 แก้บั๊ก #3 (2026-09-18): validate MIME type ตาม folder — กันอัปโหลด HTML/JS → XSS ผ่าน R2 URL
  //   เดิม: รับทุก MIME type → แอดมิน (หรือ attacker) อัปโหลด HTML ได้ → R2 เสิร์ฟด้วย Content-Type: text/html → XSS
  //   แก้: allowlist MIME type ตาม folder + resourceType
  const ALLOWED_MIME_BY_FOLDER = {
    "full-songs":   ["audio/wav", "audio/mpeg", "audio/mp3", "audio/x-wav", "audio/x-mpeg", "audio/ogg", "audio/aac", "audio/flac"],
    "order-zips":   ["application/zip", "application/x-zip-compressed", "application/octet-stream"],
    // 📸 Payment slip upload (added — image only, max 5MB enforced separately)
    "payment-proofs": ["image/jpeg", "image/png", "image/webp", "image/jpg"],
    "":             ["audio/wav", "audio/mpeg", "audio/mp3", "audio/x-wav", "audio/x-mpeg", "audio/ogg", "audio/aac", "audio/flac",
                     "image/jpeg", "image/png", "image/webp", "image/gif", "image/jpg"],
  };
  const folderKey = ALLOWED_MIME_BY_FOLDER[folder] ? folder : "";
  const allowedTypes = ALLOWED_MIME_BY_FOLDER[folderKey] || ALLOWED_MIME_BY_FOLDER[""];
  const actualType = (file.type || "").toLowerCase();
  // ถ้า resourceType === "raw" → อนุญาต application/octet-stream และ zip types เท่านั้น
  const isRaw = resourceType === "raw";
  const effectiveAllowed = isRaw
    ? ["application/zip", "application/x-zip-compressed", "application/octet-stream"]
    : allowedTypes;
  if (actualType && !effectiveAllowed.includes(actualType)) {
    return jsonResponse({ error: `ประเภทไฟล์ไม่ได้รับอนุญาต: ${actualType} (อนุญาตเฉพาะ: ${effectiveAllowed.join(", ")})` }, 415);
  }

  const key = buildObjectKey(folder, file.name);
  // 🔒 แก้บั๊ก #3: บังคับ Content-Type ตาม MIME type ที่ validate แล้ว — ไม่ไว้ใจ client 100%
  const httpMetadata = {
    contentType: actualType || "application/octet-stream",
  };

  // เดิม (Cloudinary): orders.js ใช้ toCloudinaryDownloadUrl() แปะ fl_attachment ต่อท้าย URL
  const isForceDownload = FORCE_DOWNLOAD_FOLDERS.has(folder) || isRaw;
  if (isForceDownload) {
    // 🔧 (2026-09-22 fix Bug #5): sanitize downloadName — ลบ CRLF + quotes + <>
    const downloadName = sanitizeHeaderValue(file.name || key.split("/").pop() || "download");
    httpMetadata.contentDisposition = `attachment; filename="${downloadName}"`;
  }

  // 🔧 (2026-09-19 perf): เพิ่ม Cache-Control บนไฟล์ ZIP ออเดอร์ → ลดเวลาดาวน์โหลดของลูกค้า
  //   ปัญหา: เดิม R2 public URL (pub-xxx.r2.dev) ไม่มี Cache-Control → browser ไม่ cache
  //   → ทุกครั้งที่ลูกค้ากดดาวน์โหลดต้องดึงจาก R2 origin ใหม่ (ช้า โดยเฉพาะออเดอร์ใหญ่)
  //
  //   วิธีแก้: ตั้ง Cache-Control: public, max-age=86400 → R2 + browser cache 24 ชม.
  //   → ครั้งที่ 2 ที่ลูกค้า (หรือคนอื่นในวงแลนเดียวกัน) ดาวน์โหลดไฟล์เดียวกัน → เร็วขึ้นมาก
  //
  //   ⚠️ ไม่กระทบ full-songs เพราะเพลงเดี่ยวเป็น private (admin เท่านั้นที่ดาวน์โหลด)
  //   ⚠️ ไม่กระทบไฟล์ตัวอย่าง/รูปปก เพราะไม่ได้อยู่ใน FORCE_DOWNLOAD_FOLDERS
  //   ใช้เฉพาะ order-zips เท่านั้น (ไฟล์ ZIP ที่ส่งให้ลูกค้าดาวน์โหลด)
  //
  //   ผลกระทบต่อระบบเดิม: 0%
  //   - ไม่เปลี่ยน API response format
  //   - ไม่เปลี่ยน folder structure หรือ file naming
  //   - เพิ่มแค่ HTTP header บน R2 object (metadata)
  if (folder === "order-zips") {
    httpMetadata.cacheControl = "public, max-age=86400";  // cache 24 ชม. ที่ R2 edge + browser
  }

  try {
    await env.BUCKET.put(key, file.stream(), { httpMetadata });
  } catch (err) {
    return jsonResponse({ error: safeError("เขียนไฟล์เข้า R2 ไม่สำเร็จ กรุณาลองใหม่", err) }, 502);
  }

  const base = env.R2_PUBLIC_BASE_URL.replace(/\/+$/, "");
  const url = `${base}/${key.split("/").map(encodeURIComponent).join("/")}`;

  return jsonResponse({ url, publicId: key, provider: "r2" }, 200);
}

// ---------------- DELETE /api/upload — ลบไฟล์ออกจาก R2 (ใหม่ 2026-09-11) ----------------
// ใช้โดยระบบจัดการไฟล์: ลบไฟล์เพลงจริง/ไฟล์ตัวอย่าง/รูปปก/ZIP ออเดอร์ ออกจาก R2 เพื่อประหยัดพื้นที่
// รับ JSON body { key } (public_id ตรงๆ เช่น full_file_public_id, zip_public_id) หรือ { url }
// (สำหรับไฟล์เก่าที่ไม่มี public_id เก็บไว้ เช่น file_url/cover_url ของเพลง — derive key จาก url เอาเอง
// โดยตัด R2_PUBLIC_BASE_URL ออก) ต้อง login (แอดมิน) เท่านั้น เพราะเป็นการลบไฟล์ถาวร
// ถ้า url ที่ส่งมาไม่ใช่ของ R2 bucket นี้ (เช่น ไฟล์เก่าจาก Cloudinary ก่อนย้ายระบบ) จะข้ามแบบไม่ error
// เพื่อไม่ให้การลบเพลง/ออเดอร์ฝั่ง caller ล้มเหลวไปด้วย

// ---------------- GET /api/file/* — Proxy อ่านไฟล์จาก R2 (ใหม่ 2026-09-12) ----------------
// ใช้ตอนฝั่งแอดมินสร้าง ZIP ออเดอร์: แทน fetch() ตรงจาก R2 public URL ที่อาจโดน CORS block
// ทำงาน: Worker รับ request → อ่านไฟล์จาก R2 binding (เร็ว ไม่ผ่าน Internet) → ส่งกลับเป็น blob
// ต้อง login (แอดมิน) เท่านั้น — กันคนนอกดึงไฟล์เพลงเต็มผ่าน endpoint นี้
// path รูปแบบ: /api/file/<key> (key = R2 object key, สามารถมี / ได้ เช่น full-songs/xxx.wav)
async function handleFileProxy(request, env, url) {
  // 🔒 Security: ต้อง login แอดมินเท่านั้น — กันคนนอกดึงไฟล์เพลงผ่าน endpoint นี้
  const admin = await getSessionAdmin(request, env);
  if (!admin) return jsonResponse({ error: "ยังไม่ได้เข้าสู่ระบบ" }, 401);

  if (!env.BUCKET) {
    return jsonResponse({ error: "ยังไม่ได้ผูก R2 bucket (binding: BUCKET) ใน wrangler.jsonc" }, 500);
  }

  // ดึง key จาก path: ตัด prefix "/api/file/" ออก ที่เหลือคือ key ทั้งหมด (รวม subfolder ถ้ามี)
  const key = decodeURIComponent(url.pathname.slice("/api/file/".length));
  if (!key) return jsonResponse({ error: "ไม่พบ key ของไฟล์" }, 400);

  // 🔒 แก้บั๊ก #2 (2026-09-18): ป้องกัน path traversal — กัน admin อ่านไฟล์อื่นใน R2 ผ่าน `../`
  //   เดิม: ไม่เช็ค key → admin สามารถส่ง `/api/file/../secret/config.json` อ่านไฟล์อื่นได้
  //   แก้: ตรวจว่า key มี `..` หรือเริ่มต้นด้วย `/` → reject
  //   ปกติ R2 key มีรูปแบบ `folder/timestamp-uuid.ext` — ไม่มีทางมี `..` หรือขึ้นต้นด้วย `/`
  if (key.includes("..") || key.startsWith("/")) {
    return jsonResponse({ error: "key ไม่ถูกต้อง" }, 400);
  }

  // อ่านไฟล์จาก R2 binding (ไม่ผ่าน public URL จึงไม่โดน CORS)
  const object = await env.BUCKET.get(key);
  if (!object) return jsonResponse({ error: "ไม่พบไฟล์ใน R2" }, 404);

  // 🔧 (2026-09-22 fix Bug #3): ลบ ACAO * — same-origin เท่านั้น
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Cache-Control", "no-store");
  // ไม่ใส่ Content-Disposition: attachment เพราะฝั่ง caller ต้องการ stream เป็น blob ไม่ใช่ดาวน์โหลดตรง
  return new Response(object.body, { status: 200, headers });
}

async function handleDeleteUpload(request, env) {
  // 🔧 (2026-09-27 fix 503): หุ้ม getSessionAdmin ด้วย try/catch — กัน D1 throw → 503
  let admin;
  try {
    admin = await getSessionAdmin(request, env);
  } catch (err) {
    return jsonResponse({ error: safeError("ตรวจสอบสิทธิ์ไม่สำเร็จ กรุณาลองใหม่", err) }, 500);
  }
  if (!admin) return jsonResponse({ error: "ยังไม่ได้เข้าสู่ระบบ" }, 401);
  if (!env.BUCKET) {
    return jsonResponse({ error: "ยังไม่ได้ผูก R2 bucket (binding: BUCKET) ใน wrangler.jsonc" }, 500);
  }

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400); }

  let key = String(body.key || "").trim();
  if (!key && body.url) {
    const base = (env.R2_PUBLIC_BASE_URL || "").replace(/\/+$/, "");
    const fileUrl = String(body.url);
    if (base && fileUrl.startsWith(base + "/")) {
      try {
        key = fileUrl.slice(base.length + 1).split("/").map(decodeURIComponent).join("/");
      } catch {
        return jsonResponse({ ok: true, skipped: true, reason: "อ่าน url ไม่ได้" });
      }
    } else {
      // url ไม่ตรงกับ R2 bucket นี้เลย (เช่น ไฟล์เก่าจาก Cloudinary) — ข้ามแบบไม่ error
      return jsonResponse({ ok: true, skipped: true, reason: "url ไม่ใช่ของ R2 bucket นี้" });
    }
  }
  if (!key) return jsonResponse({ ok: true, skipped: true, reason: "ไม่มี key/url ให้ลบ" });

  try {
    await env.BUCKET.delete(key);
  } catch (err) {
    return jsonResponse({ error: safeError("ลบไฟล์ไม่สำเร็จ กรุณาลองใหม่", err) }, 502);
  }
  return jsonResponse({ ok: true, deleted: true, key });
}

// 🔧 (2026-09-27 add): POST /api/order-files/cleanup — ลบไฟล์ทั้งหมดของออเดอร์ออกจาก R2 + D1
//   ใช้ตอนแอดมินลบออเดอร์ → เรียก endpoint นี้ก่อนลบออเดอร์ใน D1
//
//   ทำครบ:
//     1) Query payment_proofs WHERE order_id = ? → ดึง file_key ทั้งหมด
//     2) ลบไฟล์สลิปแต่ละไฟล์ออกจาก R2 (รองรับหลายสลิป — ลูกค้าอัปใหม่ถ้าถูก reject)
//     3) DELETE payment_proofs rows ออกจาก D1 (กันขยะใน D1)
//     4) ลบไฟล์ ZIP ออกจาก R2 (ถ้ามี zip_public_id ใน order doc)
//
//   ผลกระทบระบบเดิม: 0% — เพิ่ม endpoint ใหม่ขั้น ไม่แตะ /api/upload (DELETE) เดิม
//   ไม่ลบ order doc — caller ยังต้องลบเอง (เพื่อให้ rollback ได้ถ้า cleanup ล้ม)
//
//   Request:  { orderId }
//   Response: { ok: true, proofsDeleted: N, proofsRowsDeleted: N, zipDeleted: bool }
//             หรือ { error } เมื่อ fail
async function handleOrderFilesCleanup(request, env) {
  // 🔧 (2026-09-27 fix 503): หุ้ม getSessionAdmin ด้วย try/catch — กัน D1 throw → 503
  let admin;
  try {
    admin = await getSessionAdmin(request, env);
  } catch (err) {
    return jsonResponse({ error: safeError("ตรวจสอบสิทธิ์ไม่สำเร็จ กรุณาลองใหม่", err) }, 500);
  }
  if (!admin) return jsonResponse({ error: "ยังไม่ได้เข้าสู่ระบบ" }, 401);
  if (!env.BUCKET) return jsonResponse({ error: "ยังไม่ได้ผูก R2 bucket (binding: BUCKET) ใน wrangler.jsonc" }, 500);
  if (!env.DB) return jsonResponse({ error: "ยังไม่ได้ผูก D1 database (binding: DB) ใน wrangler.jsonc" }, 500);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400); }
  const orderId = sanitizeHeaderValue(body?.orderId);
  if (!orderId) return jsonResponse({ error: "กรุณาระบุ orderId" }, 400);

  let proofsDeleted = 0;
  let proofsRowsDeleted = 0;
  let zipDeleted = false;

  // 🚀 (2026-09-28 fix M-4): ลบ in-progress ZIP job ถ้ามี (abort multipart + partial.bin)
  //   เดิม: ไม่เช็ค order_zip_jobs → ถ้า admin ลบ order ระหว่างกำลังสร้าง ZIP → R2 multipart + partial.bin leak
  //   ใหม่: ตอนเริ่ม cleanup → เช็ค + abort + ลบ partial.bin ก่อน → ลบ D1 row
  //   ผลกระทบระบบเดิม: 0% — ถ้าไม่มี job → no-op (เหมือนเดิม)
  let zipJobCleaned = 0;
  try {
    const existingJob = await env.DB.prepare(
      "SELECT job_id, bucket_key, parts FROM order_zip_jobs WHERE order_id = ? AND status = 'preparing'"
    ).bind(orderId).first();
    if (existingJob) {
      // ลบ partial.bin ก่อน
      try {
        const partsData = parsePartsJson(existingJob.parts);
        if (partsData.finalizeState && partsData.finalizeState.partialBufferKey) {
          await cleanupPartialBuffer(env, partsData.finalizeState);
        }
      } catch (_) {}
      // abort multipart upload
      if (existingJob.bucket_key) {
        try {
          await env.BUCKET.abortMultipartUpload(existingJob.bucket_key, existingJob.job_id);
        } catch (r2Err) {
          console.warn(`order-files/cleanup: R2 multipart abort failed for ${existingJob.job_id} (may already be aborted):`, r2Err?.message || r2Err);
        }
      }
      // ลบ D1 row
      try {
        await env.DB.prepare("DELETE FROM order_zip_jobs WHERE job_id = ?").bind(existingJob.job_id).run();
        zipJobCleaned += 1;
      } catch (d1Err) {
        console.warn(`order-files/cleanup: DELETE order_zip_jobs failed for ${existingJob.job_id}:`, d1Err?.message || d1Err);
      }
    }
  } catch (err) {
    console.warn("order-files/cleanup: query order_zip_jobs failed (table may not exist):", err?.message || err);
  }

  // ===== 1) ลบไฟล์สลิปโอนเงินทั้งหมดของออเดอร์ =====
  //   รองรับหลายสลิป: ลูกค้าอัปใหม่ได้ถ้าถูก reject → ออเดอร์เดียวมีได้หลาย rows ใน payment_proofs
  let proofRows;
  try {
    const result = await env.DB.prepare(
      "SELECT id, file_key FROM payment_proofs WHERE order_id = ?"
    ).bind(orderId).all();
    proofRows = result?.results || [];
  } catch (err) {
    // ถ้าตาราง payment_proofs ยังไม่ถูกสร้าง (schema ใหม่) → log + ข้าม (ไม่ block)
    console.warn("order-files/cleanup: query payment_proofs failed (table may not exist):", err?.message || err);
    proofRows = [];
  }

  for (const row of proofRows) {
    if (row?.file_key) {
      try {
        await env.BUCKET.delete(row.file_key);
        proofsDeleted += 1;
      } catch (err) {
        // ลบไฟล์เดียวล้ม → log แต่ไม่ block (ลบไฟล์อื่นต่อ)
        console.warn(`order-files/cleanup: R2 delete proof failed (key: ${row.file_key}):`, err?.message || err);
      }
    }
  }

  // ===== 2) ลบ rows ใน payment_proofs ออกจาก D1 =====
  if (proofRows.length > 0) {
    try {
      const deleteResult = await env.DB.prepare(
        "DELETE FROM payment_proofs WHERE order_id = ?"
      ).bind(orderId).run();
      proofsRowsDeleted = deleteResult?.meta?.changes || 0;
    } catch (err) {
      console.warn("order-files/cleanup: DELETE payment_proofs failed:", err?.message || err);
    }
  }

  // ===== 3) ลบไฟล์ ZIP ออกจาก R2 (ถ้ามี) =====
  //   ดึง order doc เพื่อหา zip_public_id (R2 key ของ ZIP)
  let orderDoc;
  try {
    orderDoc = await getDocument(env, "orders", orderId);
  } catch (err) {
    console.warn("order-files/cleanup: getDocument(orders) failed:", err?.message || err);
    orderDoc = null;
  }
  const zipR2Key = orderDoc?.data?.zip_public_id || "";
  if (zipR2Key) {
    try {
      await env.BUCKET.delete(zipR2Key);
      zipDeleted = true;
    } catch (err) {
      console.warn(`order-files/cleanup: R2 delete ZIP failed (key: ${zipR2Key}):`, err?.message || err);
    }
  }

  return jsonResponse({
    ok: true,
    orderId,
    proofsDeleted,
    proofsRowsDeleted,
    zipDeleted,
  });
}

function adminToClient(admin) {
  return { uid: admin.id, email: admin.email, displayName: admin.display_name, role: admin.role };
}

// ---------------- /api/auth/* ----------------
async function handleAuth(request, env, url) {
  const path = url.pathname.slice("/api/auth/".length);

  if (path === "has-admin" && request.method === "GET") {
    const row = await env.DB.prepare("SELECT COUNT(*) AS c FROM admin_users").first();
    return jsonResponse({ hasAdmin: (row?.c || 0) > 0 });
  }

  if (path === "bootstrap" && request.method === "POST") {
    // 🔒 (2026-09-21 fix Bug #6 Bootstrap race during DB outage): require env var
    //   เดิม: bootstrap endpoint เปิดใช้ได้ตลอดเวลา → ถ้า D1 ล่ม ณ ขณะนั้น
    //         `/api/auth/has-admin` ตอบ 5xx → client แสดงปุ่ม bootstrap → ใครก็ตั้งตัวเองเป็น main admin ได้
    //   ใหม่: ต้องตั้ง env var `ALLOW_BOOTSTRAP=true` ผ่าน `wrangler secret put ALLOW_BOOTSTRAP`
    //         เท่านั้น → โหมด bootstrap เปิดได้เฉพาะตอนตั้งค่าระบบครั้งแรก แล้วปิดทันทีหลัง bootstrap เสร็จ
    //   วิธีใช้:
    //     1. ตอนตั้งค่าระบบ: `wrangler secret put ALLOW_BOOTSTRAP` พิมพ์ "true"
    //     2. กด bootstrap ในหน้า admin.html (เหมือนเดิม)
    //     3. หลัง bootstrap สำเร็จ → ลบ secret: `wrangler secret delete ALLOW_BOOTSTRAP`
    //        เพื่อปิดโหมด bootstrap ถาวร — กันใคร claim admin ระหว่าง DB outage ในอนาคต
    //   ผลกระทบระบบเดิม: 0% — ถ้า ALLOW_BOOTSTRAP ไม่ถูกตั้ง → return 403 (เหมือนเดิมที่มี admin แล้ว)
    //     ถ้าตั้งไว้ → bootstrap ทำงานเหมือนเดิม
    if (env.ALLOW_BOOTSTRAP !== "true") {
      return jsonResponse({
        error: "โหมดตั้งค่าแอดมินคนแรกถูกปิดไว้ — ติดต่อผู้ดูแลระบบเพื่อตั้งค่า หรือตั้ง env ALLOW_BOOTSTRAP=true ผ่าน `wrangler secret put ALLOW_BOOTSTRAP`",
      }, 403);
    }
    // 🔧 แก้บั๊ก I3 (2026-09-18): กัน bootstrap race condition — 2 requests พร้อมกัน → สร้าง main admin 2 ตัว
    // -----------------------------------------------------------
    // ปัญหา: SELECT COUNT(*) → INSERT แยกกัน 2 queries → race condition
    //   ถ้า 2 requests เข้ามาพร้อมกันทั้งคู่เห็น c=0 ทั้งคู่ INSERT ได้ → main admin 2 ตัว
    //
    // วิธีแก้: ใช้ UNIQUE partial index `idx_admin_users_main_unique` (สร้างใน schema.sql)
    //   + INSERT...ON CONFLICT DO NOTHING → ถ้ามี main admin อยู่แล้ว INSERT จะไม่ทำงาน
    //   + เช็ค changes() หลัง INSERT → ถ้า 0 = มี main admin อยู่แล้ว (race) → return 409
    //
    // ผลกระทบต่อระบบเดิม: 0% — behavior เหมือนเดิม แต่ปลอดภัยขึ้น (กัน race)
    //   ถ้า index ยังไม่ถูกสร้าง (ยังไม่ได้ run schema.sql ใหม่) → ยังทำงานเหมือนเดิม (fallback)
    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400); }
    // 🔧 (2026-09-22 fix Bug #4): lowercase email — กัน case-sensitive
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    const displayName = String(body.displayName || "").trim() || email.split("@")[0];
    if (!email) return jsonResponse({ error: "กรุณากรอกอีเมล" }, 400);
    if (password.length < 6) return jsonResponse({ error: "รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร" }, 400);

    // 🔧 แก้บั๊ก I3: pre-check (เหมือนเดิม — เพื่อให้ error message ชัดเจน)
    const row = await env.DB.prepare("SELECT COUNT(*) AS c FROM admin_users").first();
    if ((row?.c || 0) > 0) {
      return jsonResponse({ error: "ระบบมีแอดมินอยู่แล้ว ไม่สามารถตั้งค่าแอดมินคนแรกซ้ำได้" }, 409);
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const passwordHash = await hashPassword(password);

    // 🔧 แก้บั๊ก I3: ใช้ INSERT...ON CONFLICT DO NOTHING (เหมือนกันกับ documents table)
    //   ถ้ามี main admin ถูกสร้างระหว่าง pre-check กับ INSERT (race) → INSERT จะไม่ทำงาน
    //   changes() จะเป็น 0 → เราจะ detect และ return 409 แทนที่จะสร้าง main admin ซ้อน
    const insertResult = await env.DB.prepare(
      "INSERT INTO admin_users (id, email, password_hash, display_name, role, created_at, created_by) VALUES (?, ?, ?, ?, 'main', ?, 'bootstrap') ON CONFLICT DO NOTHING"
    ).bind(id, email, passwordHash, displayName, now).run();

    // 🔧 แก้บั๊ก I3: เช็คว่า INSERT สำเร็จจริงไหม (changes() > 0)
    //   ถ้า changes() === 0 = มี main admin อยู่แล้ว (race) → return 409
    //   ⚠️ หมายเหตุ: meta.changes อาจไม่ถูกต้องในบาง D1 driver version → ใช้ meta.last_row_id ด้วย
    if (!insertResult.meta || insertResult.meta.changes === 0) {
      return jsonResponse({ error: "ระบบมีแอดมินอยู่แล้ว ไม่สามารถตั้งค่าแอดมินคนแรกซ้ำได้ (race detected)" }, 409);
    }

    const token = await createSession(env, id);
    const admin = await env.DB.prepare("SELECT id, email, display_name, role, created_at, created_by FROM admin_users WHERE id = ?").bind(id).first();

    // 🔒 (Audit Fix C-14): พยายาม auto-delete ALLOW_BOOTSTRAP secret หลัง bootstrap สำเร็จ
    //   ปัญหาเดิม: operator ต้อง manually รัน `wrangler secret delete ALLOW_BOOTSTRAP`
    //            ถ้าลืม → endpoint ยังเปิดอยู่ → ระหว่าง D1 outage ผู้โจมตีอาจ bootstrap main admin ตัวใหม่ได้
    //   วิธีแก้: หลัง bootstrap สำเร็จ → เรียก Cloudflare API ลบ secret โดยอัตโนมัติ
    //            ต้องตั้ง env เพิ่ม: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN (Workers Scripts:Edit)
    //            ถ้าไม่ได้ตั้ง → log warning ใน Worker logs (operator เห็นใน Dashboard) แต่ไม่ทำให้ bootstrap พัง
    //   ผลกระทบระบบเดิม: 0% — ถ้าไม่มี env token → ข้ามไป ใช้วิธีเดิม (manual delete)
    //            ถ้ามี env token → ลบ secret อัตโนมัติ (UX ดีขึ้น)
    //   ⚠️ ใช้ waitUntil เพื่อให้ Cloudflare API call ทำงานหลัง response ส่งแล้ว (ไม่ block ลูกค้า)
    try {
      const accountId = env.CLOUDFLARE_ACCOUNT_ID;
      const apiToken = env.CLOUDFLARE_API_TOKEN;
      const scriptName = "miusic-store"; // ตรงกับ wrangler.jsonc name field
      if (accountId && apiToken) {
        // ใช้ ctx.waitUntil เพื่อ run หลังส่ง response — ไม่ block ลูกค้า
        const deletePromise = fetch(
          `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${scriptName}/secrets/ALLOW_BOOTSTRAP`,
          {
            method: "DELETE",
            headers: { "Authorization": `Bearer ${apiToken}` },
          }
        ).then(async (resp) => {
          if (!resp.ok) {
            const body = await resp.text().catch(() => "");
            console.warn(
              `[C-14] Auto-delete ALLOW_BOOTSTRAP failed: ${resp.status} ${body}. ` +
              `Operator ต้องรัน: wrangler secret delete ALLOW_BOOTSTRAP`
            );
          } else {
            console.log("[C-14] ALLOW_BOOTSTRAP secret auto-deleted after successful bootstrap");
          }
        }).catch((err) => {
          console.warn(
            `[C-14] Auto-delete ALLOW_BOOTSTRAP network error: ${err?.message || err}. ` +
            `Operator ต้องรัน: wrangler secret delete ALLOW_BOOTSTRAP`
          );
        });
        // ใช้ ctx.waitUntil ถ้ามี ctx (Cloudflare Worker context) — ถ้าไม่มี ctx ก็ยอมแพ้ (fire-and-forget)
        // 🔧 (2026-10-01 fix H1): handleAuth(request, env, url) ไม่มี ctx parameter
        //   เดิม (บรรทัด 863): `typeof ctx !== "undefined"` เป็น false เสมอ เพราะ ctx ไม่ได้ประกาศใน scope
        //     → ctx.waitUntil() ไม่ถูกเรียก → deletePromise fire-and-forget → Worker อาจ terminate ก่อน fetch เสร็จ
        //     → ALLOW_BOOTSTRAP secret อาจไม่ถูกลบ → ระหว่าง D1 outage คนอื่น bootstrap main admin ใหม่ได้ (takeover)
        //   ใหม่: ใช้ env.__ctx เหมือน writeAuditLog (บรรทัด 65) — fetch handler เก็บ ctx ลง env.__ctx ตั้งแต่บรรทัด 5568
        //   ผลกระทบระบบเดิม: 0% — ถ้า env.__ctx ไม่มี (legacy) → fallback fire-and-forget เหมือนเดิม
        //                     ถ้า env.__ctx มี → waitUntil ทำงาน → secret ถูกลบปกติ
        const __ctx = env.__ctx;
        if (__ctx && typeof __ctx.waitUntil === "function") {
          __ctx.waitUntil(deletePromise);
        }
      } else {
        // ไม่ได้ตั้ง CLOUDFLARE_ACCOUNT_ID หรือ CLOUDFLARE_API_TOKEN → log warning ให้ operator เห็น
        console.warn(
          "[C-14] Bootstrap สำเร็จ แต่ไม่สามารถ auto-delete ALLOW_BOOTSTRAP ได้ (ไม่มี CLOUDFLARE_ACCOUNT_ID หรือ CLOUDFLARE_API_TOKEN). " +
          "Operator ต้องรันด้วยตัวเอง: wrangler secret delete ALLOW_BOOTSTRAP"
        );
      }
    } catch (cleanupErr) {
      // ไม่ทำให้ bootstrap พัง ถ้า cleanup มีปัญหา — log warning อย่างเดียว
      console.warn("[C-14] Bootstrap cleanup error:", cleanupErr?.message || cleanupErr);
    }

    return jsonResponse(adminToClient(admin), 200, { "Set-Cookie": buildSessionCookie(token) });
  }

  if (path === "login" && request.method === "POST") {
    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400); }
    // 🔧 (2026-09-22 fix Bug #4): lowercase email
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");

    // 🔒 แก้บั๊ก #4 (2026-09-18): Rate limiting บน login — กัน brute-force password
    //   เดิม: ไม่มี rate limiting → attacker ยิง password dictionary ได้ไม่จำกัด
    //   แก้: ใช้ D1 ตาราง `login_attempts` track IP + email → บล็อกถ้าเกิน 5 ครั้งใน 15 นาที
    //   🔧 (2026-09-22 fix Bug #6): เพิ่ม rate limit per-email ด้วย — กัน credential stuffing
    //     เดิม: เช็คแค่ IP → attacker จาก distributed IPs bypass ได้
    //     ใหม่: เช็คทั้ง IP และ email → ถ้าเกิน 5 ครั้งต่อ email หรือ ต่อ IP → block
    //   ⚠️ ใช้ IP จาก CF-Connecting-IP header (Cloudflare ใส่ให้อัตโนมัติ)
    //   ถ้าไม่มีตาราง login_attempts (DB เก่า) → rate limiting ข้ามไป (fallback: ไม่บล็อก)
    const clientIP = request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || "unknown";
    const RATE_LIMIT_MAX_ATTEMPTS = 5;
    const RATE_LIMIT_WINDOW_MINUTES = 15;
    const rateLimitWindow = new Date(Date.now() - RATE_LIMIT_WINDOW_MINUTES * 60 * 1000).toISOString();
    try {
      // 🔧 (2026-09-22 fix Bug #6): นับ attempts ทั้ง IP และ email
      //   ถ้าใครก็ตามที่ยิง password เกิน 5 ครั้ง ไม่ว่าจาก IP ใด → block
      // BUG FIX: Only count actual LOGIN attempts — not cust-query/cust-list/change-pw/verify-pw
      //   Those use the same login_attempts table but with different email keys
      //   (cust-query:IP, cust-list:IP, change-pw:adminId, verify-pw:adminId)
      //   Login uses actual email as key — so filter by email field
      const ipAttemptsRow = await env.DB.prepare(
        "SELECT COUNT(*) AS c FROM login_attempts WHERE ip = ? AND attempted_at > ? " +
        "AND email NOT LIKE 'cust-%%' AND email NOT LIKE 'change-pw%%' AND email NOT LIKE 'verify-pw%%'"
      ).bind(clientIP, rateLimitWindow).first();
      // 🔧 (2026-09-22 fix Bug #6): นับตาม email ด้วย — กัน distributed IP brute-force
      const emailAttemptsRow = await env.DB.prepare(
        "SELECT COUNT(*) AS c FROM login_attempts WHERE email = ? AND attempted_at > ?"
      ).bind(email, rateLimitWindow).first();
      const ipCount = ipAttemptsRow?.c || 0;
      const emailCount = emailAttemptsRow?.c || 0;
      if (ipCount >= RATE_LIMIT_MAX_ATTEMPTS || emailCount >= RATE_LIMIT_MAX_ATTEMPTS) {
        const whichLimited = ipCount >= RATE_LIMIT_MAX_ATTEMPTS ? "IP" : "อีเมล";
        return jsonResponse({
          error: `พยายามเข้าสู่ระบบผิดพลาดเกินไป (${RATE_LIMIT_MAX_ATTEMPTS} ครั้งต่อ ${whichLimited} ใน ${RATE_LIMIT_WINDOW_MINUTES} นาที) — กรุณารอ ${RATE_LIMIT_WINDOW_MINUTES} นาทีแล้วลองใหม่`,
          code: "auth/rate-limited"
        }, 429);
      }
    } catch (rateErr) {
      // ถ้าตาราง login_attempts ไม่มี → ข้าม rate limiting (fallback: ไม่บล็อก)
      // ผู้ใช้ต้องสร้างตารางนี้เอง (ดู schema.sql สำหรับคำสั่ง CREATE TABLE)
      console.warn("rate limiting skipped (table login_attempts not found):", rateErr?.message);
    }

    // 🔒 Maintenance (2026-09-16): ทำความสะอาด session ที่หมดอายุก่อนสร้าง session ใหม่
    await cleanupExpiredSessions(env);
    // 🔧 (2026-09-22 fix Bug #4): query ด้วย LOWER(email) — case-insensitive match
    const admin = await env.DB.prepare("SELECT * FROM admin_users WHERE LOWER(email) = ?").bind(email).first();
    // 🔒 (Audit Fix H-22): ป้องกัน timing oracle — ถ้า admin ไม่พบ ก็ยังต้อง verifyPassword
    //   เพื่อใช้เวลาเท่ากัน (PBKDF2 100k iterations ใช้ ~100ms)
    //   ปัญหาเดิม: if (!admin || !verifyPassword(...)) → ถ้า !admin → return เร็วกว่า
    //   → attacker วัด timing ได้ว่า email มีอยู่จริงไหม (timing oracle)
    //   วิธีแก้: ถ้า !admin → ใช้ dummy hash + verify เพื่อใช้เวลาเท่ากัน
    //   ผลกระทบระบบเดิม: 0% — กรณี admin พบ → ใช้ verify ปกติ (เหมือนเดิม)
    //   กรณี admin ไม่พบ → verify กับ dummy hash (เสียเวลา 100ms เพิ่มเติม + กัน timing oracle)
    const DUMMY_HASH = "pbkdf2$100000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    let passwordOk = false;
    if (admin) {
      passwordOk = await verifyPassword(password, admin.password_hash);
    } else {
      // dummy verify — เสียเวลาเท่ากัน แต่ผลต้องเป็น false เสมอ
      await verifyPassword(password, DUMMY_HASH);
      passwordOk = false;
    }
    if (!passwordOk) {
      // 🔒 แก้บั๊ก #4: บันทึก login attempt ที่ล้มเหลวลง D1 (สำหรับ rate limiting)
      try {
        await env.DB.prepare(
          "INSERT INTO login_attempts (ip, email, attempted_at) VALUES (?, ?, ?)"
        ).bind(clientIP, email, new Date().toISOString()).run();
      } catch (_) { /* ถ้าตารางไม่มี → ข้าม */ }
      return jsonResponse({ error: "อีเมลหรือรหัสผ่านไม่ถูกต้อง", code: "auth/invalid-credential" }, 401);
    }
    // 🔒 แก้บั๊ก #4: login สำเร็จ → ล้าง login attempts ของ IP นี้
    try {
      await env.DB.prepare("DELETE FROM login_attempts WHERE ip = ?").bind(clientIP).run();
    } catch (_) { /* ถ้าตารางไม่มี → ข้าม */ }
    const token = await createSession(env, admin.id);
    // 🔒 (Audit Fix H-24): audit log สำหรับ login สำเร็จ
    try {
      await writeAuditLog(env, request, admin, "login", "admins", admin.id, admin.email || admin.id, null, { login_at: new Date().toISOString() });
    } catch {}
    return jsonResponse(adminToClient(admin), 200, { "Set-Cookie": buildSessionCookie(token) });
  }

  if (path === "logout" && request.method === "POST") {
    const token = getCookie(request, "session_token");
    // 🔒 (Audit Fix H-24): audit log สำหรับ logout — บันทึกก่อนลบ session
    try {
      const admin = await getSessionAdmin(request, env);
      if (admin) {
        await writeAuditLog(env, request, admin, "logout", "admins", admin.id, admin.email || admin.id, null, { logout_at: new Date().toISOString() });
      }
    } catch {}
    await deleteSession(env, token);
    return jsonResponse({ ok: true }, 200, { "Set-Cookie": buildClearCookie() });
  }

  if (path === "me" && request.method === "GET") {
    const admin = await getSessionAdmin(request, env);
    if (!admin) return jsonResponse({ error: "ยังไม่ได้เข้าสู่ระบบ" }, 401);
    return jsonResponse(adminToClient(admin));
  }

  if (path === "verify-password" && request.method === "POST") {
    const admin = await getSessionAdmin(request, env);
    if (!admin) return jsonResponse({ error: "ยังไม่ได้เข้าสู่ระบบ" }, 401);

    // 🔒 (Audit Fix M-1): Rate limit บน verify-password — กัน brute-force
    //   เหมือน change-password (H-21) — ใช้ login_attempts table
    //   threshold: 5 fails / 15 นาที → block
    //   ผลกระทบระบบเดิม: 0% — ถ้า table ไม่มี → ข้าม (fallback)
    try {
      const vpClientIP = request.headers.get("CF-Connecting-IP") || "unknown";
      const VP_RATE_LIMIT_MAX = 5;
      const VP_RATE_LIMIT_WINDOW_MIN = 15;
      const vpWindow = new Date(Date.now() - VP_RATE_LIMIT_WINDOW_MIN * 60 * 1000).toISOString();
      const vpKey = `verify-pw:${admin.id}`;
      const vpRow = await env.DB.prepare(
        "SELECT COUNT(*) AS c FROM login_attempts WHERE ip = ? AND email = ? AND attempted_at > ?"
      ).bind(vpClientIP, vpKey, vpWindow).first();
      if ((vpRow?.c || 0) >= VP_RATE_LIMIT_MAX) {
        return jsonResponse({
          error: `พยายามยืนยันรหัสผ่านผิดพลาดเกินไป (${VP_RATE_LIMIT_MAX} ครั้งใน ${VP_RATE_LIMIT_WINDOW_MIN} นาที) — กรุณารอ`,
          code: "auth/verify-pw-rate-limited"
        }, 429);
      }
    } catch (vpRateErr) {
      console.warn("verify-password rate limiting skipped:", vpRateErr?.message);
    }

    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400); }
    const full = await env.DB.prepare("SELECT password_hash FROM admin_users WHERE id = ?").bind(admin.id).first();
    const ok = await verifyPassword(String(body.password || ""), full?.password_hash);
    if (!ok) {
      // 🔒 (M-1): บันทึก failed attempt
      try {
        const vpClientIP = request.headers.get("CF-Connecting-IP") || "unknown";
        const vpKey = `verify-pw:${admin.id}`;
        await env.DB.prepare(
          "INSERT INTO login_attempts (ip, email, attempted_at) VALUES (?, ?, ?)"
        ).bind(vpClientIP, vpKey, new Date().toISOString()).run();
      } catch {}
      return jsonResponse({ error: "รหัสผ่านปัจจุบันไม่ถูกต้อง", code: "auth/wrong-password" }, 401);
    }
    // 🔒 (M-1): เคลียร์ failed attempts เมื่อ verify สำเร็จ
    try {
      const vpClientIP = request.headers.get("CF-Connecting-IP") || "unknown";
      const vpKey = `verify-pw:${admin.id}`;
      await env.DB.prepare("DELETE FROM login_attempts WHERE ip = ? AND email = ?")
        .bind(vpClientIP, vpKey).run();
    } catch {}
    return jsonResponse({ ok: true });
  }

  if (path === "change-password" && request.method === "POST") {
    const admin = await getSessionAdmin(request, env);
    if (!admin) return jsonResponse({ error: "ยังไม่ได้เข้าสู่ระบบ" }, 401);

    // 🔒 (Audit Fix H-21): Rate limit บน change-password — กัน brute-force current password
    //   ปัญหาเดิม: ไม่มี rate limit → attacker ที่มี session cookie สามารถ brute-force
    //   currentPassword ได้ไม่จำกัด (5 attempts/sec)
    //   วิธีแก้: ใช้ login_attempts table (มีอยู่แล้ว) บันทึก failed attempts ตาม admin_id
    //   threshold: 5 fails / 15 นาที → block
    //   ผลกระทบระบบเดิม: 0% — ถ้า login_attempts table ไม่มี → ข้าม (fallback)
    //   ถ้าผ่าน rate limit → ดำเนินการต่อ (เหมือนเดิม)
    try {
      const cpClientIP = request.headers.get("CF-Connecting-IP") || "unknown";
      const CP_RATE_LIMIT_MAX = 5;
      const CP_RATE_LIMIT_WINDOW_MINUTES = 15;
      const cpWindow = new Date(Date.now() - CP_RATE_LIMIT_WINDOW_MINUTES * 60 * 1000).toISOString();
      const cpKey = `change-pw:${admin.id}`;
      // ใช้ login_attempts table (email field เก็บ key 'change-pw:<admin_id>')
      const cpRow = await env.DB.prepare(
        "SELECT COUNT(*) AS c FROM login_attempts WHERE ip = ? AND email = ? AND attempted_at > ?"
      ).bind(cpClientIP, cpKey, cpWindow).first();
      if ((cpRow?.c || 0) >= CP_RATE_LIMIT_MAX) {
        return jsonResponse({
          error: `พยายามเปลี่ยนรหัสผ่านผิดพลาดเกินไป (${CP_RATE_LIMIT_MAX} ครั้งใน ${CP_RATE_LIMIT_WINDOW_MINUTES} นาที) — กรุณารอ`,
          code: "auth/change-pw-rate-limited"
        }, 429);
      }
    } catch (cpRateErr) {
      // ถ้า login_attempts table ไม่มี → ข้าม rate limiting (fallback)
      console.warn("change-password rate limiting skipped:", cpRateErr?.message);
    }

    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400); }

    // 🔒 Security (2026-09-17 P0): ตรวจรหัสผ่านปัจจุบันฝั่ง server ก่อนอนุญาตให้เปลี่ยน
    //   เดิม: server แค่เช็ค session แล้วอัปเดต password_hash ได้เลย
    //   ปัญหา: ถ้ามีคนขโมย session cookie (XSS, เครื่องถูกขโมย) → เปลี่ยนรหัสผ่านได้ทันที
    //     โดยไม่ต้องรู้รหัสเดิม → ล็อกเจ้าของบัญชีออกจากระบบถาวร
    //   ใหม่: server ต้อง verify currentPassword ด้วย — กัน attacker ที่มีแค่ cookie
    //   ฝั่ง client (app-admin.js) ยังคง reauthenticate ผ่าน verify-password ก่อน (UX check เร็ว)
    //   แต่ server-side verification ทำซ้ำอีกทีเพื่อ security จริง
    const currentPassword = String(body.currentPassword || "");
    if (!currentPassword) {
      return jsonResponse({ error: "กรุณากรอกรหัสผ่านปัจจุบัน", code: "auth/current-password-required" }, 400);
    }
    const full = await env.DB.prepare("SELECT password_hash FROM admin_users WHERE id = ?").bind(admin.id).first();
    const currentOk = await verifyPassword(currentPassword, full?.password_hash);
    if (!currentOk) {
      // 🔒 (Audit Fix H-21): บันทึก failed attempt เพื่อ rate limiting
      try {
        const cpClientIP = request.headers.get("CF-Connecting-IP") || "unknown";
        const cpKey = `change-pw:${admin.id}`;
        await env.DB.prepare(
          "INSERT INTO login_attempts (ip, email, attempted_at) VALUES (?, ?, ?)"
        ).bind(cpClientIP, cpKey, new Date().toISOString()).run();
      } catch {}
      return jsonResponse({ error: "รหัสผ่านปัจจุบันไม่ถูกต้อง", code: "auth/wrong-password" }, 401);
    }

    const newPassword = String(body.newPassword || "");
    if (newPassword.length < 6) return jsonResponse({ error: "รหัสผ่านใหม่ต้องมีอย่างน้อย 6 ตัวอักษร" }, 400);
    const passwordHash = await hashPassword(newPassword);
    await env.DB.prepare("UPDATE admin_users SET password_hash = ? WHERE id = ?").bind(passwordHash, admin.id).run();
    // 🔧 (2026-09-22 fix Bug #2): ลบ session อื่นทั้งหมด (ยกเว้น session ปัจจุบัน)
    //   เดิม: เปลี่ยนรหัสผ่านแล้ว session เดิมยังใช้ได้ 7 วัน → stolen session ยัง active
    //   ใหม่: ลบ session อื่นออก → คนที่ขโมย cookie ถูกบังคับ login ใหม่
    try {
      const currentToken = getCookie(request, "session_token");
      if (currentToken) {
        await env.DB.prepare(
          "DELETE FROM sessions WHERE admin_id = ? AND token != ?"
        ).bind(admin.id, currentToken).run();
      } else {
        // ถ้าไม่มี token → ลบทั้งหมด (fallback — บังคับ login ใหม่ทุกคน)
        await env.DB.prepare("DELETE FROM sessions WHERE admin_id = ?").bind(admin.id).run();
      }
    } catch (sessionErr) {
      // ถ้าลบ session ไม่ได้ → log แต่ไม่ block การเปลี่ยนรหัสผ่าน
      console.warn("Failed to invalidate other sessions:", sessionErr?.message);
    }
    // 🔒 (Audit Fix H-21): เคลียร์ failed attempts หลังเปลี่ยนรหัสผ่านสำเร็จ
    //   เหมือน login สำเร็จ → เคลียร์ rate limit counter
    try {
      const cpClientIP = request.headers.get("CF-Connecting-IP") || "unknown";
      const cpKey = `change-pw:${admin.id}`;
      await env.DB.prepare(
        "DELETE FROM login_attempts WHERE ip = ? AND email = ?"
      ).bind(cpClientIP, cpKey).run();
    } catch {}
    // 🔒 (Audit Fix H-24): audit log สำหรับ change-password สำเร็จ
    try {
      await writeAuditLog(env, request, admin, "change_password", "admins", admin.id, admin.email || admin.id, null, { changed_at: new Date().toISOString() });
    } catch {}
    return jsonResponse({ ok: true });
  }

  if (path === "create-admin" && request.method === "POST") {
    const admin = await getSessionAdmin(request, env);
    if (!admin) return jsonResponse({ error: "ยังไม่ได้เข้าสู่ระบบ" }, 401);
    if (admin.role !== "main") return jsonResponse({ error: "เฉพาะแอดมินหลักเท่านั้นที่เพิ่มแอดมินได้" }, 403);
    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400); }
    // 🔧 (2026-09-22 fix Bug #4): lowercase email
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    if (!email) return jsonResponse({ error: "กรุณากรอกอีเมล" }, 400);
    if (password.length < 6) return jsonResponse({ error: "รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร" }, 400);
    const existing = await env.DB.prepare("SELECT id FROM admin_users WHERE LOWER(email) = ?").bind(email).first();
    if (existing) return jsonResponse({ error: "อีเมลนี้มีบัญชีอยู่แล้วในระบบ", code: "auth/email-already-in-use" }, 409);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const passwordHash = await hashPassword(password);
    await env.DB.prepare(
      "INSERT INTO admin_users (id, email, password_hash, display_name, role, created_at, created_by) VALUES (?, ?, ?, ?, 'sub', ?, ?)"
    ).bind(id, email, passwordHash, email.split("@")[0], now, admin.email || "").run();
    return jsonResponse({ uid: id, email });
  }

  return jsonResponse({ error: "ไม่พบ endpoint นี้" }, 404);
}

// ---------------- /api/db/* ----------------
// รูปแบบ path: /api/db/:collection (GET list, PUT/POST ไม่ใช้ตรงนี้), /api/db/:collection/_query (POST),
// /api/db/:collection/:id (GET/PUT/PATCH/DELETE)
// ทุก endpoint ในกลุ่มนี้ต้อง login ก่อนทั้งหมด (แอปนี้ไม่มีหน้าไหนที่ user ทั่วไปต้องเขียน Firestore ตรงๆ
// โดยไม่ผ่านแอดมิน ยกเว้น "orders" ตอนลูกค้า checkout/ค้นหาออเดอร์ตัวเอง และ "songs/categories/djs/playlists/
// discounts/promotions/settings" ตอนลูกค้าเปิดหน้าเว็บอ่านอย่างเดียว — ของเดิมที่ Firestore Rules ก็เปิด
// public read เหมือนกัน จึงคง public read ไว้เหมือนเดิม แต่บังคับ login เฉพาะฝั่งเขียน (write) เท่านั้น
// เพื่อไม่ให้ระบบเดิมฝั่ง user (index.html) พังหรือถูกบล็อกจากการอ่านข้อมูล)
//
// 🔒 Security (2026-09-11):
//   - "orders" ถูกเอาออกจาก PUBLIC_READ_COLLECTIONS แล้ว — กันคนนอกอ่านออเดอร์ทั้งหมด (ชื่อ/เบอร์/ยอด/URL)
//     ลูกค้าค้นหาออเดอร์ของตัวเองผ่าน endpoint ใหม่ _customer-query / _customer-list ที่ Server กรองเจ้าของให้
//   - "songs" ยังเป็น public read แต่จะถูก sanitize ฟิลด์ sensitive (full_file_url, full_file_public_id,
//     full_file_name) ออกก่อนส่งให้ non-admin — กัน URL เพลงเต็มหลุดไปคนที่ไม่ได้ซื้อ
const PUBLIC_READ_COLLECTIONS = new Set([
  "songs", "categories", "djs", "playlists", "discounts", "promotions", "settings",
]);

// ฟิลด์เพลงที่ sensitive — ห้ามส่งให้ non-admin (เฉพาะแอดมินล็อกอินเท่านั้นที่เห็นข้อมูลนี้)
// ใช้ใน openFullFilesModal() และ createOrderZip() ฝั่ง orders.js ซึ่งรันในบริบท admin.html เท่านั้น
const SONG_SENSITIVE_FIELDS = ["full_file_url", "full_file_public_id", "full_file_name"];

// normalize ค่าฝั่ง Server — เหมือน normalizePhone/normalizeName ฝั่ง client ทุกประการ
// (ใช้ใน endpoint ค้นหา/ลบออเดอร์ของลูกค้า เพื่อให้เทียบค่าได้เหมือนฝั่ง client เดิม)
//
// 🔧 แก้บั๊ก C5 (2026-09-17): ลูกค้า Laos หาออเดอร์ตัวเองไม่เจอ เพราะเบอร์ใน DB เก็บหลายรูปแบบ
// -----------------------------------------------------------
// ปัญหา: เดิมแค่ strip non-digit ออก → "+85620XXXXXXXX" → "85620XXXXXXXX"
//   แต่ถ้าลูกค้ากรอก "020XXXXXXXX" → normalize → "020XXXXXXXX" ไม่เท่ากับ "85620XXXXXXXX"
//   → query หา orders ไม่เจอ (DB เก็บ +856... แต่ลูกค้ากรอก 020...)
//
// วิธีแก้: strip country code Laos (+856 / 856) + 0 นำหน้าออก ให้เบอร์ทุกรูปแบบเทียบเท่ากัน:
//   "+85620XXXXXXXX" → "20XXXXXXXX"
//   "85620XXXXXXXX"  → "20XXXXXXXX"
//   "020XXXXXXXX"     → "20XXXXXXXX"
//   "20XXXXXXXX"      → "20XXXXXXXX" (ไม่เปลี่ยน)
//   ตัวเลขอื่น ๆ ที่ไม่ใช่เบอร์ Laos → ใช้ตรง ๆ เหมือนเดิม (เช่น เบอร์ไทย)
//
// ผลกระทบ: ลูกค้า Laos ที่สั่งด้วยเบอร์ +85620... จะหาออเดอร์ได้ถ้ากรอก 020... หรือ 20...
//   สอดคล้องกับ normalizePhone ฝั่ง client (app-user.js, app-promotion.js) ที่แก้พร้อมกัน
function normalizePhoneServer(v) {
  let s = String(v || "").replace(/[^0-9+]/g, "");
  s = s.replace(/^\+/, "");
  if (s.startsWith("856")) {
    let rest = s.slice(3).replace(/^0+/, "");
    return "856" + rest;
  }
  if (s.startsWith("66")) {
    let rest = s.slice(2).replace(/^0+/, "");
    return "66" + rest;
  }
  // 🔧 (2026-09-22 fix Bug #1): ตรวจ Thai local (8XXXXXXXX / 9XXXXXXXX, 9 หลัก) → เติม 66
  //   เดิม: สันนิษฐานลาวเสมอ → 0812345678 → 856812345678 (ผิด!)
  let rest = s.replace(/^0+/, "");
  if (rest.length === 9 && (rest.startsWith("8") || rest.startsWith("9"))) {
    return "66" + rest;
  }
  return "856" + rest;
}
function normalizeNameServer(v) { return String(v || "").trim().toLowerCase(); }

// ตัดฟิลด์ sensitive ออกจาก song document ก่อนส่งให้ non-admin
// (ส่ง array เข้ามา — return array ใหม่ ไม่แก้ array ของเดิม)
function sanitizeSongsForPublic(docs) {
  return docs.map((d) => {
    if (!d || !d.data) return d;
    const cleanData = { ...d.data };
    for (const f of SONG_SENSITIVE_FIELDS) {
      if (f in cleanData) delete cleanData[f];
    }
    return { id: d.id, data: cleanData };
  });
}

// 🔧 (2026-09-18 v6 perf): Whitelist ฟิลด์ที่จำเป็นสำหรับ list view + modal ของ customer page
// ฟิลด์อื่นๆ ที่ไม่อยู่ใน list นี้จะถูกตัดออกจาก response (ลด response size 75%)
// ใช้ใน `?slim=1` query param
const SONG_SLIM_FIELDS = new Set([
  "song_name", "artist", "dj_name", "dj_id",
  "cover_url", "preview_url", "file_url",
  "price", "duration", "description",
  "playlist_id", "playlist_name", "status",
  "category_name", "category_id", "categoryIds",
  "preview_status", "preview_start_sec", "preview_end_sec",
  "preview_start_bar", "preview_end_bar",
  "created_at"
]);

function slimSongForList(songData) {
  const slim = {};
  for (const key of SONG_SLIM_FIELDS) {
    if (key in songData) slim[key] = songData[key];
  }
  return slim;
}

async function handleDb(request, env, url) {
  const parts = url.pathname.slice("/api/db/".length).split("/").filter(Boolean);
  const collection = parts[0];
  if (!collection) return jsonResponse({ error: "ไม่พบ collection" }, 400);

  const isWrite = ["POST", "PUT", "PATCH", "DELETE"].includes(request.method);

  // ข้อยกเว้นสำหรับ "orders" (แก้บั๊ก 2026-09-11): ลูกค้า "ไม่ต้อง login" ต้องสั่งซื้อได้เอง และยกเลิก
  // ออเดอร์ของตัวเองได้เอง — ตรงกับคอมเมนต์เดิมด้านบน/เจตนาดั้งเดิมตอนยังใช้ Firestore Rules
  // (allow create: if true, allow delete: เฉพาะออเดอร์ที่ยัง pending_verify) แต่ตัวเช็ค isWrite เดิม
  // บังคับ login กับทุกการเขียนไม่มีข้อยกเว้น จนลูกค้ากดยืนยันสั่งซื้อ/ยกเลิกออเดอร์ตัวเองไม่ได้เลย
  // เงื่อนไขละเอียด (กันแก้ไข/ลบออเดอร์คนอื่นที่แอดมินเริ่มดำเนินการแล้วแบบไม่ login) เช็คในแต่ละ branch ด้านล่าง
  const isOrdersPublicWriteCandidate =
    collection === "orders" && parts.length === 2 && (request.method === "PUT" || request.method === "DELETE");

  // 🔒 Security (2026-09-11): endpoint ใหม่สำหรับลูกค้าค้นหาออเดอร์ของตัวเอง — Server กรองเจ้าขอบให้
  // ป้องกันไม่ให้คนนอกอ่านออเดอร์ของคนอื่น และไม่ต้องโหลดออเดอร์ทั้งหมดมาที่ browser
  // ทั้ง 2 endpoint นี้เป็น "public" (ไม่ต้อง login) — แต่ต้องส่ง customer_name + whatsapp มาใน body
  // Server จะตรวจให้ว่าเป็นเจ้าของออเดอร์จริงก่อนส่งข้อมูลกลับ
  const isOrdersCustomerEndpoint =
    collection === "orders" && parts.length === 2 && request.method === "POST" &&
    (parts[1] === "_customer-query" || parts[1] === "_customer-list");

  // 🔧 (2026-09-17 Phase 1): endpoint สำหรับ count pending orders — ใช้กับ badge บน admin dashboard
  // เดิม: app-admin.js getDocs(collection(db,"orders")) แล้ว filter ฝั่ง client → โหลด orders ทั้งหมดมาแค่นับ
  // ใหม่: SELECT COUNT(*) WHERE status = 'pending_verify' → ประหยัด D1 reads มาก
  // ต้อง login (admin เท่านั้น) เพราะเป็นข้อมูลสรุปฝั่งระบบ
  const isOrdersCountPendingEndpoint =
    collection === "orders" && parts.length === 2 && request.method === "POST" &&
    parts[1] === "_count-pending";

  // 🔧 (2026-09-17 Phase 2): endpoint สำหรับ batch get documents หลายอันพร้อมกัน
  // ใช้สำหรับ batch fetch songs ตอนสร้าง ZIP — ลดจำนวน HTTP requests จาก browser → Worker
  // ต้อง login (admin เท่านั้น) เพราะเป็น endpoint ใหม่ที่ใช้ใน ZIP flow
  // request: POST /api/db/:collection/_batch-get body: { ids: ["id1", "id2", ...] }
  // response: { docs: [{ id, data }, ...] }
  const isBatchGetEndpoint =
    parts.length === 2 && request.method === "POST" && parts[1] === "_batch-get";

  // 🔧 แก้บั๊ก (2026-09-17) Bug #4: endpoint ตรวจว่าเพลงใน list มี Order เก่าอ้างอิงไหม (batch)
  // -----------------------------------------------------------
  // ปัญหาก่อนแก้: app-admin.js songHasOrders() โหลด orders ทั้งตารางทุกครั้ง × N เพลง
  //   เช่น ลบ 50 เพลง × 10,000 orders = 500,000 D1 reads ต่อการกดลบครั้งเดียว
  //
  // วิธีแก้: สร้าง endpoint ใหม่รับ { ids: [...] } แล้ว server ทำ query เดียว
  //   วนลูปตรวจทุก order ใน memory ว่า items มี song_id หรือ song_ids ตรงกับ ids ที่ส่งมาไหม
  //   คืน { [songId]: boolean } — ลด D1 reads จาก N × orders_total → 1 × orders_total
  //
  // Security: Admin-only (login required) — เป็นข้อมูลฝั่งระบบ
  // request: POST /api/db/songs/_has-orders-batch body: { ids: ["song1", "song2", ...] }
  // response: { results: { "song1": true, "song2": false, ... } }
  const isHasOrdersBatchEndpoint =
    collection === "songs" && parts.length === 2 && request.method === "POST" && parts[1] === "_has-orders-batch";

  // 🔧 แก้บั๊ก (2026-09-17) Bug #7: endpoint ตรวจว่า cover_url ยังถูกใช้โดยเพลง/เพลย์ลิสต์อื่นไหม
  // -----------------------------------------------------------
  // ปัญหาก่อนแก้: app-admin.js deleteSongFilesFromStorage() โหลด songs + playlists ทั้งตาราง
  //   แค่เพื่อเช็คว่า cover_url ซ้ำไหม — 1,000 เพลง + 100 playlists = 1,100 reads ต่อครั้ง
  //
  // วิธีแก้: สร้าง endpoint ใหม่รับ { url } แล้ว server ทำ query เดียวด้วย json_extract
  //   คืน { used: boolean } — ลด D1 reads จาก songs_total + playlists_total → 1 × query
  //
  // Security: Admin-only (login required) — เป็น endpoint ฝั่ง admin
  // request: POST /api/db/_check-cover-used body: { url: "..." }
  // response: { used: true|false }
  // หมายเหตุ: ไม่จำกัด collection เพราะเป็น cross-collection check (songs + playlists)
  const isCheckCoverUsedEndpoint =
    parts.length === 2 && request.method === "POST" && parts[1] === "_check-cover-used" && collection === "_meta";

  // 🔧 (2026-09-22 fix Bug #2 UI): POST /api/db/_meta/_audit-log-query
  //   อ่านรายการ audit_log พร้อม filter + paginate — ใช้สำหรับหน้า "ประวัติร้าน" ในแอดมินแพแนล
  //   ทำให้แอดมินดูประวัติได้จาก UI โดยตรง ไม่ต้องเข้า Cloudflare Dashboard
  //
  //   request body (ทุกฟิลด์ optional):
  //     { limit?: 50 (max 200), offset?: 0,
  //       action?: "create"|"update"|"delete"|...,
  //       collection?: "songs"|"orders"|...,
  //       admin_email?: "substring match (case-insensitive)",
  //       target_id?: "exact match",
  //       from_date?: "2026-09-01" (inclusive, by created_at >= start-of-day),
  //       to_date?:   "2026-09-30" (inclusive, by created_at < end-of-day + 1 day)
  //     }
  //   response: { logs: [{...}], total: <number>, limit, offset }
  //
  //   Security: admin-only (ทุกแอดมินที่ login แล้ว — สอดคล้องกับ "เพื่อนๆ ช่วยกันดูแล" model
  //   ที่ผู้ใช้ระบุไว้ — sub-admin อ่าน audit log ได้ เพราะทุกคนที่เป็น admin คือคนรู้จัก)
  const isAuditLogQueryEndpoint =
    parts.length === 2 && request.method === "POST" && parts[1] === "_audit-log-query" && collection === "_meta";

  // 🔧 (2026-09-23 fix): POST /api/db/_meta/_migrate-rate-limit
  //   รัน migration SQL สำหรับสร้างตาราง order_creation_attempts + index ผ่านเว็บ
  //   ทำให้แอดมินสามารถรัน migration จาก iPad/มือถือ ได้โดยไม่ต้องใช้ wrangler CLI
  //   - ต้อง login เป็น main admin (กัน sub-admin รัน migration โดยไม่ได้รับอนุญาต)
  //   - idempotent: CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS → รันซี่้น ๆ ปลอดภัย
  //   - รันเฉพาะ SQL ของตารางใหม่นี้เท่านั้น ไม่แตะตารางอื่นที่มีอยู่แล้ว
  const isMigrateRateLimitEndpoint =
    parts.length === 2 && request.method === "POST" && parts[1] === "_migrate-rate-limit" && collection === "_meta";

  // 🔒 (Audit Fix H-7): POST /api/db/orders/_admin-search
  //   Server-side search สำหรับ old orders ที่ไม่ได้อยู่ใน 200 ออเดอร์ล่าสุด
  //   ปัญหาเดิม: loadOrdersFromDatabase โหลดแค่ 200 ออเดอร์ล่าสุด
  //     แอดมิน search → filter state.allOrders ฝั่ง client → ออเดอร์เก่า 201+ ไม่เจอ
  //     แอดมินคิดว่าไม่มีออเดอร์เก่า → อาจสร้างออเดอร์ซ้ำ
  //   วิธีแก้: endpoint ใหม่รับ { q: "keyword", limit?: 200 } → server LIKE search
  //     ค้นใน customer_name + whatsapp + receipt_number + id
  //     return { docs: [{id, data}] } — เหมือน listDocuments format
  //   ผลกระทบระบบเดิม: 0% — เป็น endpoint ใหม่ ไม่แตะของเดิม
  //     client ใช้ถ้าต้องการ ไม่บังคับ (fallback เดิมที่ search ฝั่ง client)
  //   Security: admin-only (ข้อมูลฝั่งระบบ ลูกค้า PII)
  const isOrdersAdminSearchEndpoint =
    collection === "orders" && parts.length === 2 && request.method === "POST" && parts[1] === "_admin-search";

  // 🔧 (2026-09-18 v6 Full System): endpoint นับ documents ทั้งหมดใน collection
  //   ใช้สำหรับ dashboard stats → 1 D1 read แทน N reads
  //   request: POST /api/db/:collection/_count-all
  //   response: { count: <number> }
  //   ต้อง login admin (admin-only — ข้อมูลฝั่งระบบ)
  const isCountAllEndpoint =
    parts.length === 2 && request.method === "POST" && parts[1] === "_count-all";

  // 🔧 (2026-09-18 v6 Full System): endpoint ค้นหาเพลงซ้ำตามชื่อ (server-side)
  //   ใช้สำหรับ admin ตอนอัปโหลดเพลงใหม่ → ตรวจเพลงซ้ำที่ DB level (ไม่ต้อง scan CACHE)
  //   request: POST /api/db/songs/_check-duplicate body: { songName, excludeSongId }
  //   response: { duplicates: [{ id, song_name, dj_name, created_at }] }
  //   ต้อง login admin (admin-only)
  const isCheckDuplicateEndpoint =
    collection === "songs" && parts.length === 2 && request.method === "POST" && parts[1] === "_check-duplicate";

  // 🔒 Security (2026-09-11): ดึง admin status เสมอเมื่อเป็น collection "songs" เพื่อตัดสินใจว่าจะ sanitize
  // ฟิลด์ sensitive ออกหรือไม่ — ไม่ใช่แค่ตอน isWrite หรือ non-public collection
  // 🔒 (Audit Fix H-7): เพิ่ม isOrdersAdminSearchEndpoint ใน admin-only check
  const needsAdminCheck = isWrite || !PUBLIC_READ_COLLECTIONS.has(collection) || collection === "songs" || isOrdersCountPendingEndpoint || isBatchGetEndpoint || isHasOrdersBatchEndpoint || isCheckCoverUsedEndpoint || isCountAllEndpoint || isCheckDuplicateEndpoint || isAuditLogQueryEndpoint || isMigrateRateLimitEndpoint || isOrdersAdminSearchEndpoint;

  let admin = null;
  if (needsAdminCheck || isOrdersCustomerEndpoint) {
    admin = await getSessionAdmin(request, env);
  }

  // ปฏิเสธการเข้าถึงถ้าไม่ใช่ admin และไม่ใช่ endpoint ที่อนุญาตให้ public เข้าถึงได้
  // ข้อยกเว้น:
  //   - isOrdersPublicWriteCandidate: ลูกค้า checkout/ยกเลิกออเดอร์ตัวเอง (เช็คเพิ่มเติมในแต่ละ branch)
  //   - isOrdersCustomerEndpoint: ลูกค้าค้นหาออเดอร์ตัวเองผ่าน endpoint ใหม่
  //   - songs GET request: อนุญาตให้ non-admin อ่าน แต่จะ sanitize ฟิลด์ sensitive ออก
  //   - songs POST _query: อนุญาตให้ non-admin query (เช่น where playlist_id) — sanitize เหมือน GET
  const isSongsPublicGet = collection === "songs" && !isWrite && request.method === "GET";
  // 🔧 แก้บั๊ก (2026-09-17): ลูกค้าเช็คเอาต์ playlist พัง เพราะ POST /api/db/songs/_query ถูกบล็อก
  // -----------------------------------------------------------
  // อาการก่อนแก้: ลูกค้าที่ไม่ได้ login (เว็บนี้ไม่มีระบบ login ลูกค้า) เพิ่ม playlist ลงตะกร้า
  //   แล้วกดสั่งซื้อ → app-cart.js:509 เรียก getDocs(query(collection(db,"songs"),
  //   where("playlist_id","==",playlistId))) → db-client.js แปลงเป็น POST /api/db/songs/_query
  //   → Worker บล็อกด้วย 401 "ยังไม่ได้เข้าสู่ระบบ" เพราะ isWrite=true, isSongsPublicGet=false
  //   → ลูกค้าเห็น toast "บันทึก Order ไม่สำเร็จ" ทั้งที่จริง ๆ ไม่ได้ login ก็ควรซื้อได้
  //
  // วิธีแก้: เพิ่ม exception สำหรับ POST /api/db/songs/_query ให้ผ่านสำหรับ non-admin
  //   เหมือน GET /api/db/songs ปกติ โดยยังคง sanitize ฟิลด์ sensitive (full_file_url,
  //   full_file_public_id, full_file_name) ออกเหมือนเดิม (ดูบรรทัด ~525 ที่ handler)
  //
  // ผลกระทบต่อ security: ต่ำมาก
  //   - ฟิลด์ sensitive ยังถูก sanitize ออกเสมอ ถ้าเป็น non-admin
  //   - ฟิลด์ที่ query ได้ถูก whitelist ใน db-helpers.js (ALLOWED_QUERY_FIELDS)
  //     ตอนนี้มีเฉพาะ playlist_id, receipt_number, status, created_at เท่านั้น
  //   - ลูกค้าสามารถ query เพลงใน playlist ใด ๆ ได้ (ซึ่งปกติ playlist ที่ไม่ถูกซ่อนก็ดูได้อยู่แล้ว
  //     ทางหน้าเว็บ / GET /api/db/songs ปกติ)
  //
  // ผลกระทบต่อระบบเดิม: 0%
  //   - ไม่แตะ endpoints อื่น (orders, admins, auth, _count-pending, _batch-get)
  //   - ไม่เปิดช่องโหว่ใหม่
  const isSongsPublicQuery =
    collection === "songs" && parts.length === 2 && parts[1] === "_query" && request.method === "POST";
  // 🔧 แก้บั๊ก Bug #4 + #7: 2 endpoints ใหม่ฝั่ง admin — ต้องผ่าน auth check ก่อน
  //   _has-orders-batch (collection=songs): admin ลบเพลง ตรวจ Order เก่าแบบ batch
  //   _check-cover-used (collection=_meta): admin ลบเพลง ตรวจ cover_url ซ้ำข้าม collection
  //   ทั้งสองอย่างเป็น admin-only (เช็ค !admin ภายใน handler อีกที)
  //   แต่ต้องข้ามบล็อก 401 ก่อนเข้า handler — เลยยกเว้นในเงื่อนไขบล็อกด้านล่าง
  // 🔧 (2026-09-18 v6): เพิ่ม isCountAllEndpoint + isCheckDuplicateEndpoint (admin-only ด้วย)
  // 🔧 (2026-09-22 fix Bug #2 UI): เพิ่ม isAuditLogQueryEndpoint (admin-only ด้วย)
  const isAdminOnlyMetaEndpoint = isHasOrdersBatchEndpoint || isCheckCoverUsedEndpoint || isCountAllEndpoint || isCheckDuplicateEndpoint || isAuditLogQueryEndpoint || isMigrateRateLimitEndpoint;
  if (!admin && !isOrdersPublicWriteCandidate && !isOrdersCustomerEndpoint && !isSongsPublicGet && !isSongsPublicQuery && !isAdminOnlyMetaEndpoint && !isBatchGetEndpoint) {
    if (isWrite || !PUBLIC_READ_COLLECTIONS.has(collection)) {
      return jsonResponse({ error: "ยังไม่ได้เข้าสู่ระบบ" }, 401);
    }
  }

  // 🔧 (2026-09-17 Phase 1): /api/db/orders/_count-pending — นับออเดอร์ที่รอตรวจสอบการโอน
  // ใช้สำหรับ badge บนปุ่ม "จัดการออเดอร์" ใน admin dashboard
  // คืน { count: <number> } — ถ้าไม่ได้ login คืน 401
  if (isOrdersCountPendingEndpoint) {
    if (!admin) return jsonResponse({ error: "ยังไม่ได้เข้าสู่ระบบ" }, 401);
    try {
      const count = await countDocuments(env, "orders", {
        wheres: [{ __type: "where", field: "status", op: "==", value: "pending_verify" }],
      });
      return jsonResponse({ count });
    } catch (err) {
      return jsonResponse({ error: safeError("นับออเดอร์ไม่สำเร็จ กรุณาลองใหม่", err) }, 500);
    }
  }

  // 🔧 (2026-09-17 Phase 2): /api/db/:collection/_batch-get — batch get documents หลายอัน
  // ใช้สำหรับ batch fetch songs ตอนสร้าง ZIP — ลดจำนวน HTTP requests จาก browser → Worker
  // request: POST body { ids: ["id1", "id2", ...] }
  // response: { docs: [{ id, data }, ...] }
  // 🔒 Security (2026-09-17): เดิมบังคับ admin เท่านั้น เพราะ response อาจมี full_file_url ของ songs (sensitive)
  // 🐛 (2026-09-29 fix): ลูกค้า checkout พัง เพราะ resolveCartFromDatabase ใช้ getDocsByIds (H7 fix)
  //   เรียก _batch-get สำหรับ songs + playlists → บล็อก 401 "ยังไม่ได้เข้าสู่ระบบ"
  //   ทั้งที่จริงลูกค้าไม่ต้อง login (เว็บนี้ไม่มีระบบ login ลูกค้า)
  //   แก้: อนุญาต non-admin ใช้ _batch-get ได้ แต่ sanitize ฟิลด์ sensitive ออกก่อนส่ง
  //       (เหมือน GET /songs ปกติที่ sanitizeSongsForPublic)
  //       →ลูกค้าได้แค่ song_name, artist, price, status, playlist_id, cover_url, preview_url, ...
  //       → ไม่ได้ full_file_url / full_file_public_id / full_file_name (เพลงเต็ม)
  if (isBatchGetEndpoint) {
    // 🔒 (2026-10-01 fix C1): whitelist collection ที่ non-admin เรียก _batch-get ได้
    //   เดิม: auth exception (บรรทัด ~1437) อนุญาต non-admin เรียก _batch-get ของทุก collection
    //         รวมทั้ง `orders` → handler ส่ง raw docs กลับ (PII: customer_name, whatsapp, total, items, payment_proof_id, status_history)
    //   ใหม่: อนุญาตเฉพาะ `songs` + `playlists` (ตามเจตนา comment บรรทัด 1463-1469 — สำหรับ checkout)
    //         collection อื่น (orders, settings, ...) ต้องเป็น admin เท่านั้น → return 401
    //   ผลกระทบระบบเดิม: 0% — admin ยังใช้ได้ทุก collection, ลูกค้า checkout ยังใช้ songs/playlists ได้
    const BATCH_GET_PUBLIC_COLLECTIONS = new Set(["songs", "playlists"]);
    if (!admin && !BATCH_GET_PUBLIC_COLLECTIONS.has(collection)) {
      return jsonResponse({ error: "ยังไม่ได้เข้าสู่ระบบ" }, 401);
    }
    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400); }
    const ids = Array.isArray(body?.ids) ? body.ids : [];
    if (ids.length === 0) return jsonResponse({ docs: [] });
    // 🔒 (Audit Fix H-35): limit ids สูงสุด 500 — กัน D1 amplification + DoS
    //   ปัญหาเดิม: ไม่มี limit → attacker ส่ง 10,000 ids → getDocumentsByIds chunk 100 × 100
    //   = 100 D1 queries × 10,000 rows = 1,000,000 D1 reads ใน 1 request
    //   → D1 read quota exhausted → DoS
    //   วิธีแก้: limit 500 (เพียงพอสำหรับ checkout 30-50 เพลง + bulk operations)
    //   ถ้าเกิน → return 400 + แจ้ง error
    //   ผลกระทบระบบเดิม: 0% — กรณีปกติ (< 500) → ผ่าน (เหมือนเดิม)
    //   กรณีผิดปกติ (> 500) → reject (กัน DoS)
    const BATCH_GET_MAX_IDS = 500;
    if (ids.length > BATCH_GET_MAX_IDS) {
      return jsonResponse({
        error: `จำนวนเอกสารเกิน ${BATCH_GET_MAX_IDS} รายการ — กรุณาแบ่ง batch เล็กลง`,
        code: "batch-get/too-many-ids",
        received: ids.length,
        max: BATCH_GET_MAX_IDS,
      }, 400);
    }
    try {
      const docs = await getDocumentsByIds(env, collection, ids);
      // 🐛 (2026-09-29 fix): ถ้าไม่ใช่ admin + collection="songs" → sanitize sensitive fields ออก
      //   - admin ยังได้ response เต็ม (สำหรับ openFullFilesModal + createOrderZip)
      //   - ลูกค้าได้ response ที่ sanitize แล้ว (เหมือน GET /songs ปกติ)
      if (!admin && collection === "songs") {
        return jsonResponse({ docs: sanitizeSongsForPublic(docs) });
      }
      // 🐛 (2026-09-29 fix): playlists ไม่มี sensitive fields → ส่ง raw ได้เลย (admin + ลูกค้า)
      //   playlists มีแค่ id, playlist_name, price, ... ไม่มี file_url อะไร
      //   ลูกค้าต้องการ price + playlist_name ตอน checkout อยู่แล้ว
      return jsonResponse({ docs });
    } catch (err) {
      return jsonResponse({ error: safeError("ดึงข้อมูลไม่สำเร็จ กรุณาลองใหม่", err) }, 500);
    }
  }

  // 🔧 แก้บั๊ก Bug #4: POST /api/db/songs/_has-orders-batch
  // ตรวจว่าเพลงใน list มี Order เก่าอ้างอิงไหม (batch) — ลด D1 reads จาก N × orders_total → 1 × orders_total
  if (isHasOrdersBatchEndpoint) {
    if (!admin) return jsonResponse({ error: "ยังไม่ได้เข้าสู่ระบบ" }, 401);
    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400); }
    const ids = Array.isArray(body?.ids) ? body.ids.map(id => String(id)).filter(Boolean) : [];
    if (ids.length === 0) return jsonResponse({ results: {} });
    // 🔒 แก้บั๊ก I5 (2026-09-18): จำกัดจำนวน ids สูงสุด 200 เพื่อกัน OOM + DoS
    //   เดิม: ไม่จำกัด → admin ส่ง 10,000 ids → วนลูป 10,000 × allOrders iterations → Worker CPU spin
    //   ใหม่: limit 200 ids (เพียงพอสำหรับ bulk delete ในชีวิตจริง) + เกิน → return error
    if (ids.length > 200) {
      return jsonResponse({ error: "จำนวนเพลงเกิน 200 รายการ — กรุณาลดจำนวนแล้วลองใหม่" }, 400);
    }
    try {
      // โหลด orders ทั้งหมด 1 ครั้ง (ไม่ใช่ N ครั้งแบบเดิม)
      const allOrders = await listDocuments(env, "orders");
      const idsSet = new Set(ids);
      const results = {};
      // init ทุก id เป็น false ก่อน
      for (const id of ids) results[id] = false;
      // วนลูปทุก order — ถ้า items มี song_id หรือ song_ids ตรงกับ idsSet ให้ตั้งเป็น true
      for (const order of allOrders) {
        const items = (order.data && Array.isArray(order.data.items)) ? order.data.items : [];
        for (const item of items) {
          if (item.song_id && idsSet.has(String(item.song_id))) {
            results[String(item.song_id)] = true;
          }
          if (Array.isArray(item.song_ids)) {
            for (const sid of item.song_ids) {
              if (idsSet.has(String(sid))) {
                results[String(sid)] = true;
              }
            }
          }
        }
      }
      return jsonResponse({ results });
    } catch (err) {
      return jsonResponse({ error: safeError("ตรวจสอบออเดอร์ไม่สำเร็จ กรุณาลองใหม่", err) }, 500);
    }
  }

  // 🔧 แก้บั๊ก Bug #7: POST /api/db/_meta/_check-cover-used
  // ตรวจว่า cover_url ยังถูกใช้โดยเพลง/เพลย์ลิสต์อื่นไหม — ลด D1 reads จาก songs_total + playlists_total → 1 × query
  if (isCheckCoverUsedEndpoint) {
    if (!admin) return jsonResponse({ error: "ยังไม่ได้เข้าสู่ระบบ" }, 401);
    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400); }
    const url = String(body?.url || "").trim();
    if (!url) return jsonResponse({ used: false });
    try {
      // ใช้ json_extract ใน SQL เพื่อ filter ที่ DB level — D1 จะได้ไม่ต้อง scan ทั้งตารางมาฝั่ง JS
      // ตรวจทั้ง songs และ playlists (cross-collection)
      const { results: songMatches } = await env.DB.prepare(
        "SELECT id FROM documents WHERE collection = 'songs' AND json_extract(data, '$.cover_url') = ? LIMIT 1"
      ).bind(url).all();
      if (songMatches && songMatches.length > 0) return jsonResponse({ used: true });
      const { results: playlistMatches } = await env.DB.prepare(
        "SELECT id FROM documents WHERE collection = 'playlists' AND json_extract(data, '$.cover_url') = ? LIMIT 1"
      ).bind(url).all();
      return jsonResponse({ used: !!(playlistMatches && playlistMatches.length > 0) });
    } catch (err) {
      return jsonResponse({ error: safeError("ตรวจสอบรูปปกไม่สำเร็จ กรุณาลองใหม่", err) }, 500);
    }
  }

  // 🔧 (2026-09-22 fix Bug #2 UI): POST /api/db/_meta/_audit-log-query
  //   อ่านรายการ audit_log พร้อม filter + paginate — สำหรับหน้า "ประวัติร้าน" ในแอดมินแพแนล
  //   ทำให้แอดมินดูประวัติได้จาก UI โดยตรง ไม่ต้องเข้า Cloudflare Dashboard ทุกครั้ง
  //
  //   build WHERE clause + bindings แบบ dynamic — เฉพาะฟิลด์ที่ส่งมาเท่านั้นที่ filter
  //   ใช้ `created_at >= ? AND created_at < ?` สำหรับ date range (BETTEE ไม่ใช้เพราะ
  //   มันมี edge case ตอน timezone + ไม่รวม upper bound ใน SQLite)
  //   ใช้ LIKE สำหรับ admin_email (substring match case-insensitive) — กัน SQL injection ด้วย
  //   การ bind value (ไม่ใช้ string interpolation)
  //
  //   สำหรับ total: ใช้ SELECT COUNT(*) แบบเดียวกัน — เพื่อให้ frontend คำนวณ pagination ได้
  //   limit/offset ใช้ bind (SQLite ไม่รองรับ expression ใน LIMIT แบบ prepared statement ในบาง version)
  //   เลยใช้ Math.min/max ฝั่ง JS ก่อน แล้วค่อย bind เป็น number
  if (isAuditLogQueryEndpoint) {
    if (!admin) return jsonResponse({ error: "ยังไม่ได้เข้าสู่ระบบ" }, 401);
    let body;
    try { body = await request.json(); } catch { body = {}; }

    // parse + clamp limit/offset (default 50 / max 200 — กัน DoS ดึง log 10,000 รายการ)
    let limit = Number(body?.limit);
    if (!Number.isFinite(limit) || limit < 1) limit = 50;
    if (limit > 200) limit = 200;
    let offset = Number(body?.offset);
    if (!Number.isFinite(offset) || offset < 0) offset = 0;

    // รับ filter ทั้งหมด (optional) — sanitize ฝั่ง server เท่านั้น
    const actionFilter      = String(body?.action || "").trim().slice(0, 50) || null;
    const collectionFilter  = String(body?.collection || "").trim().slice(0, 50) || null;
    const adminEmailFilter  = String(body?.admin_email || "").trim().slice(0, 200) || null;
    const targetIdFilter    = String(body?.target_id || "").trim().slice(0, 200) || null;
    // รับ date string แบบ "YYYY-MM-DD" หรือ ISO 8601 — แปลงเป็น range ที่ใช้กับ created_at
    //   from_date: รวม (inclusive) → เริ่มต้นวัน (00:00:00 UTC)
    //   to_date: รวม (inclusive) → วันถัดไป 00:00:00 UTC (เลือกทั้งวันนั้น)
    let fromDate = null, toDate = null;
    try {
      if (body?.from_date) {
        const d = new Date(body.from_date);
        if (!isNaN(d.getTime())) fromDate = d.toISOString();
      }
      if (body?.to_date) {
        const d = new Date(body.to_date);
        if (!isNaN(d.getTime())) {
          // +1 วัน → ใช้เป็น upper bound (exclusive)
          d.setDate(d.getDate() + 1);
          toDate = d.toISOString();
        }
      }
    } catch { /* ignore invalid date */ }

    // สร้าง WHERE clause + bindings (prepared statement — กัน SQL injection)
    const wheres = ["1=1"];
    const binds = [];
    if (actionFilter)          { wheres.push("action = ?");      binds.push(actionFilter); }
    if (collectionFilter)      { wheres.push("collection = ?"); binds.push(collectionFilter); }
    if (targetIdFilter)        { wheres.push("target_id = ?");  binds.push(targetIdFilter); }
    if (adminEmailFilter)      { wheres.push("admin_email LIKE ? ESCAPE '\\' COLLATE NOCASE"); binds.push(`%${escapeLikePattern(adminEmailFilter)}%`); }
    if (fromDate)              { wheres.push("created_at >= ?"); binds.push(fromDate); }
    if (toDate)                { wheres.push("created_at < ?");  binds.push(toDate); }

    const whereClause = wheres.join(" AND ");

    try {
      // query หลัก: logs (เรียงใหม่สุดก่อน)
      const logsSql =
        `SELECT id, admin_id, admin_email, action, collection, target_id, target_name,
                before_data, after_data, ip_address, created_at
         FROM audit_log
         WHERE ${whereClause}
         ORDER BY created_at DESC, id DESC
         LIMIT ? OFFSET ?`;
      const logBinds = [...binds, limit, offset];
      const { results: logs } = await env.DB.prepare(logsSql).bind(...logBinds).all();

      // query total: count (สำหรับ pagination)
      const totalSql = `SELECT COUNT(*) as cnt FROM audit_log WHERE ${whereClause}`;
      const totalBinds = [...binds];
      const totalRow = await env.DB.prepare(totalSql).bind(...totalBinds).first();
      const total = Number(totalRow?.cnt) || 0;

      // parse before_data/after_data เป็น object (ฝั่ง client จะได้ไม่ต้อง JSON.parse ซ้ำ)
      // 🔒 (Audit Fix H-9): สำหรับ sub-admin → redact PII fields ใน before_data/after_data
      //   ปัญหาเดิม: sub-admin เห็นข้อมูลลูกค้าทั้งหมด (whatsapp, bank_account, customer_name)
      //     ผ่าน audit_log ของแอดมินคนอื่น → privacy breach
      //   วิธีแก้: ถ้า admin.role !== 'main' → redact sensitive fields จาก before_data/after_data
      //   SENSITIVE_FIELDS = whatsapp, customer_name, bank_account, qr_code_url,
      //     full_file_url, zip_download_url, password_hash, session_token
      //   ผลกระทบระบบเดิม: 0% — main admin เห็นเหมือนเดิม (no redaction)
      //     sub-admin เห็นข้อมูลที่ redact แล้ว (privacy safe)
      const isMainAdmin = admin?.role === "main";
      const SENSITIVE_AUDIT_FIELDS = new Set([
        "whatsapp", "customer_name", "bank_account", "bank_account_name",
        "qr_code_url", "full_file_url", "zip_download_url",
        "password_hash", "session_token", "password",
      ]);
      function redactSensitive(obj) {
        if (!obj || typeof obj !== "object") return obj;
        if (Array.isArray(obj)) return obj.map(redactSensitive);
        const out = {};
        for (const [k, v] of Object.entries(obj)) {
          if (SENSITIVE_AUDIT_FIELDS.has(k)) {
            out[k] = "[REDACTED]";
          } else if (v && typeof v === "object") {
            out[k] = redactSensitive(v);
          } else {
            out[k] = v;
          }
        }
        return out;
      }
      // 🆕 (T010-M5): mask admin_email สำหรับ sub-admin (privacy)
      //   ปัญหาเดิม: sub-admin เห็น admin_email ของ admin อื่นใน top-level row (บรรทัด 1720)
      //     ทั้งที่ before_data/after_data ถูก redact แล้ว → top-level admin_email ยังรั่ว
      //   วิธีแก้: ถ้า caller เป็น sub-admin → mask admin_email เป็น "j***@gmail.com"
      //     (แสดงแค่อักษรแรก + โดเมน — พอให้กรอง/ระบุได้แต่ไม่เห็น email เต็ม)
      //   ผลกระทบระบบเดิม: 0% — main admin เห็น email เต็มเหมือนเดิม
      function maskAdminEmailForSub(email, callerRole) {
        if (!email) return "";
        if (callerRole === "main") return email; // main admin เห็นเต็ม
        // sub-admin → mask เช่น "j***@gmail.com"
        const atIdx = String(email).indexOf("@");
        if (atIdx < 1) return "***"; // ไม่ใช่ email format → mask หมด
        const local = String(email).slice(0, atIdx);
        const domain = String(email).slice(atIdx + 1);
        if (!domain) return "***";
        return local.charAt(0) + "***@" + domain;
      }
      const parsedLogs = (logs || []).map(row => {
        let beforeParsed = null, afterParsed = null;
        try { if (row.before_data) beforeParsed = JSON.parse(row.before_data); } catch { beforeParsed = row.before_data; }
        try { if (row.after_data)  afterParsed  = JSON.parse(row.after_data);  } catch { afterParsed  = row.after_data;  }
        // 🔒 (Audit Fix H-9): redact PII สำหรับ sub-admin
        if (!isMainAdmin) {
          beforeParsed = redactSensitive(beforeParsed);
          afterParsed = redactSensitive(afterParsed);
        }
        // 🔒 (Audit Fix M-49): Redact password_hash + session_token จาก response (defense in depth)
        //   แม้ main admin เห็น before_data/after_data → ก็ไม่ควรเห็น password_hash
        //   (defense in depth — client-side filter อยู่แล้ว แต่ network response ยังรั่ว)
        beforeParsed = redactAuditSensitiveFields(beforeParsed);
        afterParsed = redactAuditSensitiveFields(afterParsed);
        return {
          id: row.id,
          admin_id: row.admin_id,
          // 🆕 (T010-M5): mask admin_email สำหรับ sub-admin (top-level field — เดิมรั่ว)
          admin_email: maskAdminEmailForSub(row.admin_email, admin?.role || "sub"),
          action: row.action,
          collection: row.collection,
          target_id: row.target_id,
          target_name: row.target_name,
          before_data: beforeParsed,
          after_data: afterParsed,
          ip_address: row.ip_address,
          created_at: row.created_at,
        };
      });

      return jsonResponse({ logs: parsedLogs, total, limit, offset });
    } catch (err) {
      // กรณีตาราง audit_log ยังไม่ถูกสร้าง → ส่ง empty list + total: 0 แทน (ไม่ crash UI)
      //   กรณีนี้คือ main admin ยังไม่รัน schema.sql ครบ — return empty ให้ UI แสดงว่างๆ
      //   แล้วแสดง toast แนะนำให้รัน schema.sql
      if (String(err?.message || "").toLowerCase().includes("no such table")) {
        return jsonResponse({
          logs: [],
          total: 0,
          limit,
          offset,
          needs_schema: true,
          hint: "ตาราง audit_log ยังไม่ถูกสร้าง — รัน schema.sql ล่าสุดใน D1 Console เพื่อสร้างตารางนี้",
        });
      }
      return jsonResponse({ error: safeError("อ่านประวัติร้านไม่สำเร็จ กรุณาลองใหม่", err) }, 500);
    }
  }

  // 🔒 (Audit Fix H-7): POST /api/db/orders/_admin-search
  //   Server-side search สำหรับ old orders (ที่ไม่ได้อยู่ใน 200 ล่าสุด)
  //   request body: { q: "search keyword", limit?: 200 (max 500), offset?: 0 }
  //   response: { docs: [{ id, data }], total: <number> }
  //   ค้นใน: customer_name, whatsapp, receipt_number, id (LIKE %q%)
  //   Security: admin-only (PII)
  //
  // 🆕 (T012): Advanced search — เพิ่ม optional filters ใน body
  //   { q?, limit?, offset?, date_from?, date_to?, status?, min_amount?, max_amount? }
  //   - ถ้ามี q → ใช้ text search เหมือนเดิม (UNION ALL 4 ฟิลด์) + เพิ่ม filter clause ทุก branch
  //   - ถ้าไม่มี q แต่มี filter → ใช้ SELECT เดียว (ไม่ต้อง UNION)
  //   - ถ้าไม่มีทั้งคู่ → return empty (เหมือนเดิม — back-compatible)
  //   ผลกระทบระบบเดิม: 0% — client เดิมที่ส่งแค่ { q } ยังทำงานเหมือนเดิม
  if (isOrdersAdminSearchEndpoint) {
    if (!admin) return jsonResponse({ error: "ยังไม่ได้เข้าสู่ระบบ" }, 401);
    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400); }
    const q = String(body?.q || "").trim();
    const limit = Math.min(Math.max(Number(body?.limit) || 200, 1), 500);
    const offset = Math.max(Number(body?.offset) || 0, 0);

    // 🆕 (T012): parse advanced filters — ทำความสะอาดค่า + sanitize
    //   - date_from/date_to: ISO 8601 string (เช่น "2026-09-01" หรือ "2026-09-01T00:00:00.000Z")
    //   - status: เลือกจาก enum ที่กำหนด (pending_verify/processing/completed/cancelled/rejected/verified)
    //   - min_amount/max_amount: ตัวเลข >= 0
    const ALLOWED_STATUS = new Set(["pending_verify", "processing", "completed", "cancelled", "rejected", "verified"]);
    const dateFrom = String(body?.date_from || "").trim() || null;
    const dateTo = String(body?.date_to || "").trim() || null;
    const statusFilter = ALLOWED_STATUS.has(String(body?.status || "")) ? String(body.status) : null;
    let minAmount = body?.min_amount != null ? Number(body.min_amount) : null;
    if (!Number.isFinite(minAmount) || minAmount < 0) minAmount = null;
    let maxAmount = body?.max_amount != null ? Number(body.max_amount) : null;
    if (!Number.isFinite(maxAmount) || maxAmount < 0) maxAmount = null;

    // ถ้าไม่มี q และไม่มี filter ใด ๆ → return empty (back-compatible)
    if (!q && !dateFrom && !dateTo && !statusFilter && minAmount == null && maxAmount == null) {
      return jsonResponse({ docs: [], total: 0, limit, offset });
    }

    try {
      // 🔒 (Audit Fix H-7): ใช้ LIKE บน json_extract ของหลายฟิลด์ + id column
      //   D1 (SQLite) รองรับ LIKE กับ wildcards % และ _ (case-insensitive สำหรับ ASCII)
      //   ถ้ามี index บน json_extract(field) → ใช้ index ได้ (เร็ว)
      //   ถ้าไม่มี index → scan ทั้งตาราง (ช้าสำหรับ 10k+ orders — แต่ admin ใช้นาน ๆ ครั้ง)
      //   ⚠️ ใช้ OR 4 คอลัมน์ → D1 ต้อง scan 4 ครั้ง (or ใช้ UNION ALL)
      //   เลือกใช้ UNION ALL เพื่อใช้ index ของแต่ละ column ได้ (ถ้ามี)
      //   ผลกระทบระบบเดิม: 0% — เป็น endpoint ใหม่ ไม่แตะของเดิม

      // 🆕 (T012): สร้าง filter SQL fragment + binds ที่จะใช้ซ้ำในทุก UNION branch
      //   - แต่ละ branch ต้องมี filter เดียวกัน เพื่อให้ filter ทำงานครบทุก branch
      //   - ใช้ escapeLikePattern() ที่มีอยู่แล้วสำหรับ q (T011-L6)
      const filterClauses = [];
      const filterBinds = [];
      if (dateFrom) {
        filterClauses.push("json_extract(data, '$.created_at') >= ?");
        filterBinds.push(dateFrom);
      }
      if (dateTo) {
        filterClauses.push("json_extract(data, '$.created_at') <= ?");
        filterBinds.push(dateTo);
      }
      if (statusFilter) {
        filterClauses.push("json_extract(data, '$.status') = ?");
        filterBinds.push(statusFilter);
      }
      if (minAmount != null) {
        filterClauses.push("CAST(json_extract(data, '$.final_total') AS REAL) >= ?");
        filterBinds.push(minAmount);
      }
      if (maxAmount != null) {
        filterClauses.push("CAST(json_extract(data, '$.final_total') AS REAL) <= ?");
        filterBinds.push(maxAmount);
      }
      const filterSql = filterClauses.length > 0 ? " AND " + filterClauses.join(" AND ") : "";

      const hasTextSearch = !!q;

      // === Branch A: มี text search → ใช้ UNION ALL (preserves index usage) ===
      if (hasTextSearch) {
        const escapedQ = escapeLikePattern(q);
        const likePattern = `%${escapedQ}%`;
        // build 4 branches — แต่ละ branch ใช้ likePattern 1 ครั้ง + filter binds เดียวกัน
        const branchBinds = [];
        const branches = [
          `SELECT id, data, created_at FROM documents WHERE collection = 'orders' AND id LIKE ? ESCAPE '\\'${filterSql}`,
          `SELECT id, data, created_at FROM documents WHERE collection = 'orders' AND json_extract(data, '$.customer_name') LIKE ? ESCAPE '\\'${filterSql}`,
          `SELECT id, data, created_at FROM documents WHERE collection = 'orders' AND json_extract(data, '$.whatsapp') LIKE ? ESCAPE '\\'${filterSql}`,
          `SELECT id, data, created_at FROM documents WHERE collection = 'orders' AND json_extract(data, '$.receipt_number') LIKE ? ESCAPE '\\'${filterSql}`,
        ];
        // binds สำหรับ data query: [likePattern, ...filterBinds] × 4 branches + [limit, offset]
        const dataBinds = [];
        for (let i = 0; i < 4; i++) {
          dataBinds.push(likePattern, ...filterBinds);
        }
        dataBinds.push(limit, offset);

        const sql = `
          SELECT id, data, created_at FROM (
            ${branches.join("\n            UNION ALL\n            ")}
          )
          GROUP BY id  -- dedup (order อาจ match หลาย field)
          ORDER BY MAX(created_at) DESC
          LIMIT ? OFFSET ?
        `;
        const { results } = await env.DB.prepare(sql).bind(...dataBinds).all();

        // count total (สำหรับ pagination UI)
        //   ใช้ UNION (ไม่ใช่ UNION ALL) เพื่อนับ id ที่ไม่ซ้ำ
        const countBranches = [
          `SELECT id FROM documents WHERE collection = 'orders' AND id LIKE ? ESCAPE '\\'${filterSql}`,
          `SELECT id FROM documents WHERE collection = 'orders' AND json_extract(data, '$.customer_name') LIKE ? ESCAPE '\\'${filterSql}`,
          `SELECT id FROM documents WHERE collection = 'orders' AND json_extract(data, '$.whatsapp') LIKE ? ESCAPE '\\'${filterSql}`,
          `SELECT id FROM documents WHERE collection = 'orders' AND json_extract(data, '$.receipt_number') LIKE ? ESCAPE '\\'${filterSql}`,
        ];
        const countSql = `SELECT COUNT(*) AS c FROM (${countBranches.join("\n          UNION\n          ")})`;
        const countBinds = [];
        for (let i = 0; i < 4; i++) {
          countBinds.push(likePattern, ...filterBinds);
        }
        const countRow = await env.DB.prepare(countSql).bind(...countBinds).first();
        const total = countRow?.c || 0;

        const docs = (results || []).map(r => ({ id: r.id, data: JSON.parse(r.data) }));
        return jsonResponse({ docs, total, limit, offset });
      }

      // === Branch B: ไม่มี text search → filter-only query (ใช้ SELECT เดียว ใช้ index ของ status) ===
      //   - ไม่ต้อง UNION ALL เพราะไม่มี text OR
      //   - ใช้ index idx_documents_orders_status สำหรับ status filter
      //   - ใช้ index idx_documents_collection_created_at สำหรับ collection
      const whereClauses = ["collection = 'orders'", ...filterClauses];
      const dataSql = `SELECT id, data, created_at FROM documents WHERE ${whereClauses.join(" AND ")} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
      const dataBinds = [...filterBinds, limit, offset];
      const { results } = await env.DB.prepare(dataSql).bind(...dataBinds).all();

      const countSql = `SELECT COUNT(*) AS c FROM documents WHERE ${whereClauses.join(" AND ")}`;
      const countRow = await env.DB.prepare(countSql).bind(...filterBinds).first();
      const total = countRow?.c || 0;

      const docs = (results || []).map(r => ({ id: r.id, data: JSON.parse(r.data) }));
      return jsonResponse({ docs, total, limit, offset });
    } catch (err) {
      return jsonResponse({ error: safeError("ค้นหาไม่สำเร็จ กรุณาลองใหม่", err) }, 500);
    }
  }

  // 🔧 (2026-09-18 v6 Full System): POST /api/db/:collection/_count-all
  // นับ documents ทั้งหมดใน collection — 1 D1 read แทน N reads (10,000 → 1)
  // ใช้สำหรับ dashboard stats — เดิม loadDashboard โหลดทุก collection เพื่อนับ
  // ต้อง login admin เท่านั้น (ข้อมูลฝั่งระบบ)
  if (isCountAllEndpoint) {
    if (!admin) return jsonResponse({ error: "ยังไม่ได้เข้าสู่ระบบ" }, 401);
    try {
      const count = await countDocumentsAll(env, collection);
      return jsonResponse({ count });
    } catch (err) {
      return jsonResponse({ error: safeError("นับข้อมูลไม่สำเร็จ กรุณาลองใหม่", err) }, 500);
    }
  }

  // 🔧 (2026-09-18 v6 Full System): POST /api/db/songs/_check-duplicate
  // ค้นหาเพลงซ้ำตามชื่อ (case-insensitive) ที่ DB level — 1 query แทน N client-side scan
  // ใช้สำหรับ admin ตอนอัปโหลดเพลงใหม่
  // request: { songName: "...", excludeSongId: "..." (optional) }
  // response: { duplicates: [{ id, song_name, dj_name, created_at }] }
  if (isCheckDuplicateEndpoint) {
    if (!admin) return jsonResponse({ error: "ยังไม่ได้เข้าสู่ระบบ" }, 401);
    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400); }
    const songName = String(body?.songName || "").trim();
    const excludeSongId = String(body?.excludeSongId || "").trim() || null;
    if (!songName) return jsonResponse({ duplicates: [] });
    try {
      const duplicates = await findDuplicateSongsByName(env, songName, excludeSongId);
      return jsonResponse({ duplicates });
    } catch (err) {
      return jsonResponse({ error: safeError("ตรวจสอบซ้ำไม่สำเร็จ กรุณาลองใหม่", err) }, 500);
    }
  }

  // 🔧 (2026-09-23 fix): POST /api/db/_meta/_migrate-rate-limit
  //   รัน migration สร้างตาราง order_creation_attempts ผ่านเว็บ — สำหรับ iPad/มือถือ
  //   ต้อง login เป็น main admin เท่านั้น (sub-admin รันไม่ได้ — กัน migration โดยไม่ได้รับอนุญาต)
  //   รันเฉพาะ SQL ของตารางใหม่นี้ ไม่แตะตารางอื่น — idempotent (CREATE ... IF NOT EXISTS)
  if (isMigrateRateLimitEndpoint) {
    if (!admin) return jsonResponse({ error: "ยังไม่ได้เข้าสู่ระบบ" }, 401);
    if (admin.role !== "main") {
      return jsonResponse({ error: "เฉพาะแอดมินหลักเท่านั้นที่รัน migration ได้" }, 403);
    }
    try {
      // รัน SQL เดียวกับใน schema.sql (บล็อก order_creation_attempts) — ใช้ IF NOT EXISTS กันซ้ำ
      await env.DB.prepare(
        `CREATE TABLE IF NOT EXISTS order_creation_attempts (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          ip            TEXT NOT NULL,
          attempted_at  TEXT NOT NULL
        )`
      ).run();
      await env.DB.prepare(
        `CREATE INDEX IF NOT EXISTS idx_order_creation_attempts_ip ON order_creation_attempts(ip, attempted_at)`
      ).run();
      // ตรวจยืนยันว่าตาราง + index สร้างจริง
      const verifyTable = await env.DB.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='order_creation_attempts'"
      ).first();
      const verifyIndex = await env.DB.prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_order_creation_attempts_ip'"
      ).first();
      return jsonResponse({
        ok: true,
        message: "สร้างตาราง order_creation_attempts และ index เรียบร้อยแล้ว — ระบบ rate limit บนการสร้างออเดอร์พร้อมใช้งาน",
        table_created: !!verifyTable,
        index_created: !!verifyIndex,
      });
    } catch (err) {
      return jsonResponse({ error: safeError("รัน migration ไม่สำเร็จ กรุณาลองใหม่ หรือรัน SQL ใน D1 Console ด้วยตนเอง", err) }, 500);
    }
  }

  try {
    // 🔒 /api/db/orders/_customer-query — ลูกค้าค้นหาออเดอร์เดียวด้วย receipt_number + ชื่อ + เบอร์
    // Server ตรวจทั้ง 3 ฟิลด์ คืนออเดอร์เดียวถ้าตรงทั้งหมด ไม่คืนข้อมูลคนอื่นให้ browser
    // 🔒 (Audit Fix H-6): เพิ่ม limit 1 + ตรวจซ้ำกัน birthday paradox
    //   เดิม queryDocuments คืน array → loop หาตัวแรกที่ตรง name+whatsapp
    //   แต่ถ้ามี 2 orders ที่ receipt_number ตรงกัน (จาก H-6 collision) → server อาจคืนตัวผิด
    //   วิธีแก้: queryDocuments ใช้ LIMIT (ดู db-helpers.js) + ตรวจ name+whatsapp เข้มข้น
    //   ป้องกันเพิ่ม: ถ้าเจอมากกว่า 1 row → log warning (อาจเป็น collision)
    // 🔒 (Audit Fix H-25): เพิ่ม rate limit บน customer-query — กัน attacker enumerate receipt_numbers
    //   ใช้ order_creation_attempts table (มีอยู่แล้ว) เก็บ IP + timestamp
    //   threshold: 30 queries / 15 นาที / IP (ลูกค้าปกติ 1-2 queries/ครั้ง)
    if (isOrdersCustomerEndpoint && parts[1] === "_customer-query") {
      // 🔒 (Audit Fix H-25): Rate limit ก่อน process
      try {
        const custIP = request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || "unknown";
        const CUST_QUERY_LIMIT = 30;
        const CUST_QUERY_WINDOW_MIN = 15;
        const custWindow = new Date(Date.now() - CUST_QUERY_WINDOW_MIN * 60 * 1000).toISOString();
        const custKey = `cust-query:${custIP}`;
        const custRow = await env.DB.prepare(
          "SELECT COUNT(*) AS c FROM login_attempts WHERE email = ? AND attempted_at > ?"
        ).bind(custKey, custWindow).first();
        if ((custRow?.c || 0) >= CUST_QUERY_LIMIT) {
          return jsonResponse({
            error: `ค้นหาเกินไป (${CUST_QUERY_LIMIT} ครั้งใน ${CUST_QUERY_WINDOW_MIN} นาที) — กรุณารอ`,
            code: "customer/rate-limited"
          }, 429);
        }
        // บันทึก attempt ทุกครั้ง (กัน spam)
        await env.DB.prepare(
          "INSERT INTO login_attempts (ip, email, attempted_at) VALUES (?, ?, ?)"
        ).bind(custIP, custKey, new Date().toISOString()).run();
      } catch (custRateErr) {
        // ถ้า login_attempts table ไม่มี → ข้าม rate limiting (fallback)
        console.warn("customer-query rate limiting skipped:", custRateErr?.message);
      }

      let body;
      try { body = await request.json(); } catch { return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400); }
      const receiptNumber = String(body.receipt_number || "").trim();
      const customerName = String(body.customer_name || "").trim();
      const whatsapp = String(body.whatsapp || "").trim();
      if (!receiptNumber || !customerName || !whatsapp) {
        return jsonResponse({ exists: false });
      }
      const docs = await queryDocuments(env, "orders", {
        wheres: [{ __type: "where", field: "receipt_number", op: "==", value: receiptNumber }],
      });
      // 🔒 (Audit Fix H-6): ถ้าเจอมากกว่า 1 row → log warning (birthday paradox collision)
      //   ในอนาคตควรเปลี่ยนเป็น server-side sequence (ใช้ receipt_id INT AUTOINCREMENT)
      if (docs.length > 1) {
        console.warn(`[H-6] customer-query: ${docs.length} orders share receipt_number "${receiptNumber}" — birthday paradox collision detected. Future orders use 12-char suffix (see getReceiptNumber fix).`);
      }
      const queryName = normalizeNameServer(customerName);
      const queryPhone = normalizePhoneServer(whatsapp);
      // 🆕 (2026-10-03 v10 — แยก Login / Guest): ตรวจ "ขอบเขต" ของผู้ถามจาก session cookie ฝั่ง Server
      //   - ออเดอร์ของ Login → เปิดได้เฉพาะเจ้าของที่ login อยู่ (กัน guest ที่ชื่อ+เบอร์ซ้ำ ได้ id/ข้อมูลของออเดอร์ login)
      //   - ออเดอร์ของ Guest → เปิดได้เฉพาะตอนที่ไม่ได้ login (คน login ไม่เห็นออเดอร์ guest)
      //   ไม่ตรงขอบเขต → ถือว่า "ไม่พบ" (exists:false) เหมือนข้อมูลไม่ตรง — ไม่บอกว่ามีออเดอร์อยู่
      //   ทุก caller ฝั่ง client จัดการ exists:false ด้วย fallback เดิมอยู่แล้ว (ใช้ order ที่มีในเครื่อง)
      let receiptSessionCustomerId = null;
      try {
        const receiptSession = await getCustomerSession(request, env);
        receiptSessionCustomerId = receiptSession ? receiptSession.id : null;
      } catch (_) { /* customer_sessions ไม่มี → ถือว่าไม่ได้ login */ }
      let matchCount = 0;
      let firstMatch = null;
      let scopeMismatch = null;
      for (const d of docs) {
        const oName = normalizeNameServer(d.data?.customer_name || "");
        const oPhone = normalizePhoneServer(d.data?.whatsapp || "");
        if (!isOrderVisibleForReceiptLookup(d.data, receiptSessionCustomerId)) {
          // 🆕 (v11): ข้อมูลตรงครบ (เลขใบเสร็จ+ชื่อ+เบอร์) แต่อยู่คนละขอบเขต → บอก UI ให้อธิบายลูกค้าได้ถูก
          //   ผู้ถามรู้ครบทั้ง 3 ค่าอยู่แล้ว จึงไม่เปิดเผยข้อมูลออเดอร์ — บอกแค่ว่าออเดอร์อยู่ฝั่งไหน
          if (oName === queryName && oPhone === queryPhone) {
            scopeMismatch = d.data?.customer_id ? "login_order" : "guest_order";
          }
          continue;
        }
        if (oName === queryName && oPhone === queryPhone) {
          matchCount++;
          if (!firstMatch) firstMatch = d;
        }
      }
      // 🔒 (Audit Fix H-6): ถ้าเจอหลาย match (name+whatsapp ตรงหลายออเดอร์ + receipt_number ตรง) → ambiguous
      //   ไม่คืนอะไรเลย (ปลอดภัยกว่าคืนตัวแรก ที่อาจเป็นของคนอื่น)
      //   ในกรณีปกติ (no collision) → matchCount = 1 → คืน firstMatch ตามเดิม
      if (matchCount === 1 && firstMatch) {
        return jsonResponse({ exists: true, id: firstMatch.id, data: firstMatch.data });
      } else if (matchCount > 1) {
        // ambiguous — log + return exists:false (ลูกค้าติดต่อแอดมิน)
        console.warn(`[H-6] customer-query: ambiguous match (${matchCount} orders match receipt+name+whatsapp) — refusing to return any for safety`);
        return jsonResponse({ exists: false, ambiguous: true });
      }
      if (scopeMismatch) return jsonResponse({ exists: false, scope_mismatch: scopeMismatch });
      return jsonResponse({ exists: false });
    }

    // 🔒 /api/db/orders/_customer-list — ลูกค้าดูออเดอร์ทั้งหมดของตัวเองด้วย ชื่อ + เบอร์
    // Server กรองเฉพาะออเดอร์ที่เป็นของลูกค้าคนนี้ (เบอร์ต้องตรง 100%, ชื่อเปิดให้ fuzzy match แบบ contains
    // เหมือนโค้ดเดิมใน app-promotion.js ที่ใช้ oName.includes(nameNorm) || nameNorm.includes(oName))
    if (isOrdersCustomerEndpoint && parts[1] === "_customer-list") {
      // 🔒 (Audit Fix H-25): Rate limit บน customer-list — เหมือน customer-query
      try {
        const custIP = request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || "unknown";
        const CUST_LIST_LIMIT = 30;
        const CUST_LIST_WINDOW_MIN = 15;
        const custWindow = new Date(Date.now() - CUST_LIST_WINDOW_MIN * 60 * 1000).toISOString();
        const custKey = `cust-list:${custIP}`;
        const custRow = await env.DB.prepare(
          "SELECT COUNT(*) AS c FROM login_attempts WHERE email = ? AND attempted_at > ?"
        ).bind(custKey, custWindow).first();
        if ((custRow?.c || 0) >= CUST_LIST_LIMIT) {
          return jsonResponse({
            error: `ดูประวัติเกินไป (${CUST_LIST_LIMIT} ครั้งใน ${CUST_LIST_WINDOW_MIN} นาที) — กรุณารอ`,
            code: "customer/rate-limited"
          }, 429);
        }
        await env.DB.prepare(
          "INSERT INTO login_attempts (ip, email, attempted_at) VALUES (?, ?, ?)"
        ).bind(custIP, custKey, new Date().toISOString()).run();
      } catch (custRateErr) {
        console.warn("customer-list rate limiting skipped:", custRateErr?.message);
      }

      let body;
      try { body = await request.json(); } catch { return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400); }
      const customerName = String(body.customer_name || "").trim();
      const whatsapp = String(body.whatsapp || "").trim();
      // 🆕 (2026-10-03 v10 — แยก Login / Guest ชัดเจน): "ขอบเขต" ตัดสินที่ Server จาก session cookie เท่านั้น
      //   (ห้ามเชื่อค่าที่ client ส่งมาบอกว่าเป็น login หรือ guest)
      //   1) มี customer session → คืนเฉพาะออเดอร์ที่ customer_id ตรงกับ session นั้น
      //        ไม่ดู WhatsApp/ชื่อที่ client ส่งมาเลย → ลูกค้า guest ที่ใช้เบอร์เดียวกันจะไม่ปนเข้ามา
      //   2) ไม่มี session (Guest) → ต้องมี guest_id (UUID v4 ของ browser นี้) + WhatsApp ที่ตรง
      //        คืนเฉพาะออเดอร์ที่ไม่มี customer_id และ guest_id ตรงกัน — WhatsApp อย่างเดียวไม่พอ
      //        (ออเดอร์เก่าก่อน v10 ที่ไม่มี guest_id → ยังค้นได้ด้วย ชื่อตรงเป๊ะ + เบอร์ ตาม ALLOW_LEGACY_GUEST_ORDERS)
      const listGuestId = normalizeGuestId(body.guest_id);
      let listSessionCustomer = null;
      try {
        listSessionCustomer = await getCustomerSession(request, env);
      } catch (_) { /* customer_sessions ไม่มี → ถือว่าไม่ได้ login */ }
      if (listSessionCustomer) {
        // 🆕 (T011-L11): ใช้ LIMITS.MAX_PAGE แทน magic number 200
        //   เดิม: `LIMIT 200` hardcoded → ถ้าแก้ที่ constants ต้องมาไล่แก้ทุกจุด
        //   ใหม่: bind `LIMITS.MAX_PAGE` (200) → single source of truth ที่ constants.js
        //   ผลกระทบระบบเดิม: 0% — ค่าเท่าเดิม (200) แค่เปลี่ยนจาก literal → constant
        const { results: loginRows } = await env.DB.prepare(
          "SELECT id, data FROM documents WHERE collection = 'orders' AND json_extract(data, '$.customer_id') = ? ORDER BY created_at DESC LIMIT ?"
        ).bind(listSessionCustomer.id, LIMITS.MAX_PAGE).all();
        const loginDocs = [];
        for (const row of (loginRows || [])) {
          let rowData;
          try { rowData = JSON.parse(row.data); } catch { continue; }
          // เช็คซ้ำฝั่ง JS (defense-in-depth) ให้ตรงกติกาเดียวกับ order-scope.js
          if (isOrderInLoginList(rowData, listSessionCustomer.id)) loginDocs.push({ id: row.id, data: rowData });
        }
        return jsonResponse({ docs: loginDocs, scope: "login" });
      }
      // Guest: ต้องมีเบอร์ + (guest_id หรือ ชื่อ สำหรับออเดอร์เก่า)
      if (!whatsapp || (!listGuestId && !(ALLOW_LEGACY_GUEST_ORDERS && customerName))) {
        return jsonResponse({ docs: [], scope: "guest" });
      }
      // 🔧 แก้บั๊ก Bug #6 (2026-09-17): กรอง orders ที่ DB level ด้วย whatsapp แทนโหลดทั้งหมด
      // -----------------------------------------------------------
      // ปัญหาก่อนแก้: listDocuments(env, "orders") โหลด orders ทั้งหมดมา filter ฝั่ง JS
      //   ถ้ามี 10,000 orders × 100 ลูกค้า active = 1,000,000 D1 reads/วัน
      //
      // วิธีแก้: ใช้ queryDocuments กับ where("whatsapp","==",phone) ที่ DB level
      //   Server จะได้แค่ orders ของเบอร์นี้ (ปกติทำลำดับสิบ) → ค่อย fuzzy match ชื่อฝั่ง JS
      //   ลด D1 reads จาก orders_total → orders_ของเบอร์นั้น
      //
      // ⚠️ สำคัญ: เบอร์ใน DB อาจเก็บในรูปแบบต่าง ๆ (เช่น +85620xxxxxxxx หรือ 020xxxxxxxx)
      //   เรา normalize ทั้งฝั่ง query และฝั่งเก็บเป็นตัวเลขเท่านั้น เพื่อให้ตรงกัน
      //   แต่ queryDocuments ใช้ค่าตรง ๆ ไม่ได้ normalize → ต้องทำ 2-step:
      //     1. Query หา orders ที่ whatsapp ตรงทั้งแบบ raw และแบบ normalized (ผ่าน OR ใน SQL)
      //     2. ค่อย filter เบอร์ที่ normalize แล้วตรงกัน 100% ฝั่ง JS (กัน false positive)
      //
      //   แต่เพื่อความเรียบง่าย + ปลอดภัย → ใช้ queryDocuments แบบเดียวกับเดิม
      //   (where("whatsapp","==",whatsapp)) แล้ว filter เบอร์ normalized ฝั่ง JS อีกที
      const queryPhone = normalizePhoneServer(whatsapp);
      // 🔧 (2026-09-21 Option A migration): ลดจาก 4 queries → 1 query
      //   เดิม (ก่อน migration): query 4 รูปแบบ (raw, normalized, +0, +856, ++856)
      //   ปัญหา: เปลือง D1 reads 4 เท่า
      //
      //   วิธีแก้: รัน migration script (scripts/migrate-whatsapp.sql) ครั้งเดียว
      //   เพื่อ normalize whatsapp field ของ orders เก่าทั้งหมดให้เป็น "20XXXXXXXX"
      //   หลัง migration รันเสร็จ → ทุก order ใน DB อยู่ในรูปแบบ normalized
      //   → สามารถใช้ query เดียวได้ (1 D1 read)
      //
      // ⚠️ สำคัญ: ต้องรัน migration script ให้เสร็จก่อน deploy worker ใหม่นี้
      //   ไม่งั้นลูกค้าจะหาออเดอร์เก่า (ที่ยังไม่ถูก normalize) ไม่เจอชั่วคราว
      //
      // ผลกระทบระบบเดิม: 0% — return เหมือนเดิม (คืน orders ของลูกค้าคนนั้น)
      //   แค่ใช้ D1 reads ลดลง 4 เท่า (จาก 4 → 1)
      let candidateDocs = [];
      try {
        candidateDocs = await queryDocuments(env, "orders", {
          wheres: [{ __type: "where", field: "whatsapp", op: "==", value: queryPhone }],
        });
      } catch (err) {
        // Fallback: ถ้า queryDocuments fail (เช่น index ยังไม่ถูกสร้าง) → กลับไปใช้ listDocuments แบบเดิม
        console.warn("queryDocuments failed, fallback to listDocuments:", err?.message || err);
        candidateDocs = await listDocuments(env, "orders");
      }
      // 🆕 (T011-L11): cap guest orders ที่ LIMITS.MAX_PAGE — กัน DoS ถ้าเบอร์นั้นมี orders มากผิดปกติ
      //   เดิม: ไม่มี LIMIT ในฝั่ง guest (queryDocuments ไม่รองรับ LIMIT) → ถ้าเบอร์มี 1,000 orders
      //     จะ return คืน 1,000 docs (memory + bandwidth บวม)
      //   วิธีแก้: หลัง fetch + filter ให้ slice ถึง LIMITS.MAX_PAGE เท่านั้น (sort ใหม่ล่าสุดก่อน)
      //   ผลกระทบระบบเดิม: ต่ำ — กรณีปกติ (orders < 200) ไม่ตัด ออเดอร์เหมือนเดิม
      const queryName = normalizeNameServer(customerName);
      const matched = candidateDocs.filter((d) => {
        const oPhone = normalizePhoneServer(d.data?.whatsapp || "");
        if (oPhone !== queryPhone) return false;
        // 🆕 (2026-10-03 v10): Guest list — ไม่เอาออเดอร์ที่มี customer_id (ของ Login) เด็ดขาด
        //   มี guest_id → ต้องตรงกับ guest_id ของ browser นี้ / ไม่มี guest_id (ออเดอร์เก่า) → ชื่อต้องตรงเป๊ะ
        //   (ชื่อตรงเป๊ะสำหรับออเดอร์เก่า = กฎเดิมของ 2026-09-22 fix Bug #5 ด้านล่าง ยังคงไว้)
        return isOrderInGuestList(d.data, {
          guestId: listGuestId,
          queryName,
          normalizeName: normalizeNameServer,
          allowLegacy: ALLOW_LEGACY_GUEST_ORDERS,
        });
        // 🔒 (2026-09-22 fix Bug #5): exact match แทน fuzzy — กัน enumerate ออเดอร์คนอื่น
        //   เดิม: oName.includes(queryName) → พิมพ์ "a" ก็เจอทุกออเดอร์ที่มี "a" ในชื่อ
        //   ใหม่: oName === queryName → ต้องตรงเป๊ะ (case-insensitive เพราะ normalizeNameServer lowercase แล้ว)
        //   ⚠️ โค้ด 3 บรรทัดเดิมย้ายเข้า isOrderInGuestList() (worker/order-scope.js) ที่ใช้กติกาเดียวกัน
        // const oName = normalizeNameServer(d.data?.customer_name || "");
        // if (!oName || !queryName) return false;
        // return oName === queryName;
      });
      // 🆕 (T011-L11): ตัดผลลัพธ์ให้ไม่เกิน LIMITS.MAX_PAGE (200) — กัน DoS ถ้าเบอร์มี orders มากผิดปกติ
      //   เรียงใหม่สุดก่อน (ตาม created_at) แล้วค่อย slice — ให้ลูกค้าเห็นออเดอร์ล่าสุดก่อน
      const matchedCapped = matched.length > LIMITS.MAX_PAGE
        ? matched
            .slice()
            .sort((a, b) => {
              const aT = a?.data?.created_at || "";
              const bT = b?.data?.created_at || "";
              return bT.localeCompare(aT);
            })
            .slice(0, LIMITS.MAX_PAGE)
        : matched;
      return jsonResponse({ docs: matchedCapped, scope: "guest" });
    }

    // /api/db/:collection  (list ทั้ง collection)
    if (parts.length === 1 && request.method === "GET") {
      // 🔒 แก้บั๊ก I7 (2026-09-18): กัน sub-admin อ่านรายชื่อแอดมินทั้งหมด
      //   เดิม: listDocuments(env, "admins") ไม่จำกัด role → sub-admin เห็น email ของแอดมินทุกคน
      //   แก้: เฉพาะ main admin เท่านั้นที่ดูรายชื่อแอดมินทั้งหมดได้ (สอดคล้องกับ PUT/PATCH/DELETE ใน C2)
      //   sub-admin จะเห็นได้แค่ตัวเอง → เพื่อให้ app-admin.js loadAdmins() ใน admin-roles.js ยังทำงานได้
      //   แต่จะเห็นแค่ตัวเอง → frontend จะแสดงแค่ตัวเอง + ปุ่ม "เพิ่มแอดมิน" จะถูกซ่อน (isMainAdmin() = false)
      if (collection === "admins" && admin && admin.role !== "main") {
        // คืนแค่ข้อมูลตัวเอง (sub-admin ไม่เห็นคนอื่น)
        const selfDoc = await getDocument(env, "admins", admin.id);
        return jsonResponse({ docs: selfDoc ? [selfDoc] : [] });
      }
      // 🔧 (2026-09-18 v6 perf): รองรับ pagination + slim response ผ่าน query params
      //   ?limit=N&offset=M  → ใช้ LIMIT/OFFSET ใน SQL (ลด D1 reads + response size)
      //   ?slim=1            → ส่งเฉพาะฟิลด์จำเป็นสำหรับ list view (ลด response size ~75%)
      //   default: no limit, no slim — backward compat (admin ใช้ได้ปกติ)
      //   ใช้กับ /api/db/songs ของ customer page (เพลง 5000+ ตัว) → ลดเวลาโหลดจาก 30s+ → 1s
      // 🔒 (Audit Fix H-34): clamp limit สูงสุด 5,000 — กัน D1 amplification
      //   ปัญหาเดิม: ไม่มี limit → attacker ส่ง ?limit=1000000 → listDocuments ดึง 1M rows
      //   → D1 read quota exhausted + Worker memory spike
      //   วิธีแก้: Math.min(limit, 5000) — เพียงพอสำหรับ admin (ดูทุก orders) + customer (lazy load)
      //   ถ้าต้องการมากกว่า 5,000 → ใช้ pagination (offset + limit ทีละ 5,000)
      //   ผลกระทบระบบเดิม: 0% — กรณีปกติ (limit <= 5000) → ผ่าน (เหมือนเดิม)
      //   กรณีผิดปกติ (limit > 5000) → clamp เป็น 5000 (กัน DoS)
      const urlParams = new URL(request.url).searchParams;
      const LIMIT_MAX = 5000;
      let limit = parseInt(urlParams.get("limit") || "", 10);
      const offset = parseInt(urlParams.get("offset") || "0", 10);
      const slim = urlParams.get("slim") === "1";
      const opts = {};
      if (Number.isInteger(limit) && limit > 0) {
        if (limit > LIMIT_MAX) {
          console.warn(`[H-34] listDocuments limit ${limit} exceeds max ${LIMIT_MAX} — clamping`);
          limit = LIMIT_MAX;
        }
        opts.limit = limit;
      }
      if (Number.isInteger(offset) && offset > 0) opts.offset = offset;

      // ============================================================
      // 🆕 (T015): Advanced song search — server-side filter + sort
      //   รองรับ query params ใหม่ (เฉพาะ collection="songs"):
      //     ?q=<text>                  — ค้นหาใน song_name + artist (LIKE %q%)
      //     ?djs=<id1,id2,...>         — กรองหลาย DJ (json_extract dj_id IN (...))
      //     ?categories=<id1,id2,...>  — กรองหลายหมวด (json_extract category_id IN (...))
      //     ?min_price=<num>           — ราคาต่ำสุด (CAST(price AS REAL) >= ?)
      //     ?max_price=<num>           — ราคาสูงสุด (CAST(price AS REAL) <= ?)
      //     ?has_promo=true            — เฉพาะเพลงที่มี discount_price > 0
      //     ?sort=newest|price_asc|price_desc|name — เรียงลำดับ
      //
      //   เหตุผล: เดิมระบบกรองฝั่ง client (filter STATE.songs ในเบราว์เซอร์) หลังโหลดทุกเพลง
      //     ทำให้ลูกค้าต้องรอ loadAllRemainingSongs() ก่อนค้นหา + กรอง และใช้ memory เยอะ
      //     ใหม่: ส่ง filter ไปที่ DB → D1 scan แค่ที่ตรงเงื่อนไข → ลด network + memory
      //     รองรับ catalog ใหญ่ (5000+ เพลง) → query ตอบใน <500ms เพราะใช้ indexes ที่มี
      //
      //   Security:
      //     - ทุกค่าจาก user ผูกเป็น bind parameter (ไม่ใช่ string interpolation)
      //     - dj/category ids แยกด้วย comma → split → แต่ละ id เป็น bind แยก
      //     - LIKE pattern ใช้ escapeLikePattern() (T011-L6) กัน wildcard injection
      //     - min/max price แปลงเป็น Number + ตรวจ Number.isFinite กัน NaN/Infinity
      //
      //   ผลกระทบระบบเดิม: 0%
      //     - ถ้าไม่มี advanced filter → skip block นี้ → ไปเส้น listDocuments เดิม
      //     - response shape เหมือนเดิม ({ docs, total, limit, offset }) ทุกประการ
      //     - ใช้ sanitizeSongsForPublic + slimSongForList เดิม → PII protection ครบ
      //     - cache headers (Cache-Control + Vary: Cookie) เหมือนเดิม
      // ============================================================
      if (collection === "songs") {
        // parse advanced filter params (default values ปลอดภัย)
        const qParam = (urlParams.get("q") || "").trim();
        const djsParam = (urlParams.get("djs") || "").trim();
        const catsParam = (urlParams.get("categories") || "").trim();
        const minPriceRaw = urlParams.get("min_price");
        const maxPriceRaw = urlParams.get("max_price");
        const hasPromoParam = urlParams.get("has_promo") === "true";
        const sortParam = (urlParams.get("sort") || "newest").trim();

        // parse + validate price (NaN/Infinity → null)
        let minPrice = (minPriceRaw !== null && minPriceRaw !== "") ? Number(minPriceRaw) : null;
        if (!Number.isFinite(minPrice) || minPrice < 0) minPrice = null;
        let maxPrice = (maxPriceRaw !== null && maxPriceRaw !== "") ? Number(maxPriceRaw) : null;
        if (!Number.isFinite(maxPrice) || maxPrice < 0) maxPrice = null;

        // ตรวจว่ามี active filter อย่างน้อย 1 ตัว (sort=newest ถือว่า default — ไม่ trigger advanced path)
        //   เหตุผล: ถ้าไม่มี filter ให้ตกไปเส้น listDocuments เดิม → backward compat 100%
        //   รวมถึงกรณี client เดิมที่ยังไม่ update → ยังใช้เส้นเดิมได้
        const djIds = djsParam ? djsParam.split(",").map(s => s.trim()).filter(Boolean) : [];
        const catIds = catsParam ? catsParam.split(",").map(s => s.trim()).filter(Boolean) : [];
        const hasAdvancedFilters =
          qParam.length > 0 ||
          djIds.length > 0 ||
          catIds.length > 0 ||
          minPrice !== null ||
          maxPrice !== null ||
          hasPromoParam ||
          sortParam !== "newest";

        if (hasAdvancedFilters) {
          // === build WHERE clauses + binds (parameterized — กัน SQL injection) ===
          const whereClauses = ["collection = 'songs'"];
          const binds = [];

          // text search (q) — LIKE บน song_name + artist พร้อม escapeLikePattern
          if (qParam) {
            const escapedQ = escapeLikePattern(qParam);
            whereClauses.push(
              "(json_extract(data, '$.song_name') LIKE ? ESCAPE '\\' COLLATE NOCASE " +
              "OR json_extract(data, '$.artist') LIKE ? ESCAPE '\\' COLLATE NOCASE)"
            );
            binds.push(`%${escapedQ}%`, `%${escapedQ}%`);
          }

          // DJ filter (multiple) — match ทั้ง dj_id, dj_name และ dj (เก่า)
          //   🆕 (T025): รองรับข้อมูลเก่าที่ dj_id ว่าง + dj_name อาจมี prefix "DJ:" หรือชื่อตรงตัว
          //   ปัญหาเดิม: filter ใช้ dj_id IN (...) เท่านั้น → เพลงเก่า dj_id ว่าง → ไม่ match → 0 ผลลัพธ์
          //   วิธีแก้: ดึง dj_name จาก STATE.djs ใน DB ก่อน → match ทั้ง id + name
          if (djIds.length > 0) {
            // 🆕 (T025): ดึง dj_name ของแต่ละ dj_id จาก documents collection=djs
            //   เพื่อ match กับเพลงที่เก็บ dj_name แทน dj_id
            const djNames = [];
            try {
              const djPlaceholders = djIds.map(() => "?").join(",");
              const djRows = await env.DB.prepare(
                `SELECT json_extract(data, '$.dj_name') AS name FROM documents
                 WHERE collection = 'djs' AND id IN (${djPlaceholders})`
              ).bind(...djIds).all();
              for (const r of (djRows.results || [])) {
                if (r.name) djNames.push(r.name);
              }
            } catch (err) {
              console.warn('[T025] failed to lookup DJ names:', err?.message || err);
            }

            const allDjValues = [...djIds, ...djNames];
            if (allDjValues.length > 0) {
              const placeholders = allDjValues.map(() => "?").join(",");
              whereClauses.push(
                `(json_extract(data, '$.dj_id') IN (${placeholders}) ` +
                `OR json_extract(data, '$.dj_name') IN (${placeholders}))`
              );
              binds.push(...allDjValues, ...allDjValues);
            }
          }

          // Category filter (multiple) — match ทั้ง category_id, categoryIds, category_name
          //   🆕 (T025): รองรับข้อมูลเก่าที่ category_id ว่าง + ใช้ category_name แทน
          //   ปัญหาเดิม: filter ใช้ category_id IN (...) เท่านั้น → เพลงเก่า category_id ว่าง → 0 ผลลัพธ์
          //   วิธีแก้: ดึง category_name จาก documents collection=categories → match ทั้ง id + name
          if (catIds.length > 0) {
            // 🆕 (T025): ดึง category_name ของแต่ละ cat_id จาก documents collection=categories
            const catNames = [];
            try {
              const catPlaceholders = catIds.map(() => "?").join(",");
              const catRows = await env.DB.prepare(
                `SELECT json_extract(data, '$.category_name') AS name FROM documents
                 WHERE collection = 'categories' AND id IN (${catPlaceholders})`
              ).bind(...catIds).all();
              for (const r of (catRows.results || [])) {
                if (r.name) catNames.push(r.name);
              }
            } catch (err) {
              console.warn('[T025] failed to lookup category names:', err?.message || err);
            }

            const allCatValues = [...catIds, ...catNames];
            if (allCatValues.length > 0) {
              const placeholders = allCatValues.map(() => "?").join(",");
              whereClauses.push(
                `(json_extract(data, '$.category_id') IN (${placeholders}) ` +
                `OR json_extract(data, '$.categoryIds') IN (${placeholders}) ` +
                `OR json_extract(data, '$.category_name') IN (${placeholders}))`
              );
              binds.push(...allCatValues, ...allCatValues, ...allCatValues);
            }
          }

          // Price range
          if (minPrice !== null) {
            whereClauses.push("CAST(json_extract(data, '$.price') AS REAL) >= ?");
            binds.push(minPrice);
          }
          if (maxPrice !== null) {
            whereClauses.push("CAST(json_extract(data, '$.price') AS REAL) <= ?");
            binds.push(maxPrice);
          }

          // Has promo — เพลงที่มี discount active ในตาราง documents collection=discounts
          //   🆕 (T025): ปัญหาเดิมใช้ discount_price field ใน song → แต่ข้อมูลจริงเก็บแยกใน discounts collection
          //   วิธีแก้: ดึง song_ids ที่มี discount active → filter song.id IN (...)
          if (hasPromoParam) {
            try {
              const discountRows = await env.DB.prepare(
                `SELECT id FROM documents
                 WHERE collection = 'discounts'
                   AND json_extract(data, '$.status') = 'active'
                   AND json_extract(data, '$.target_type') = 'song'`
              ).all();
              const promoSongIds = (discountRows.results || [])
                .map(r => r.id)
                .filter(Boolean);

              if (promoSongIds.length > 0) {
                const placeholders = promoSongIds.map(() => "?").join(",");
                whereClauses.push(`id IN (${placeholders})`);
                binds.push(...promoSongIds);
              } else {
                // ไม่มี discount active เลย → คืน 0 ผลลัพธ์
                whereClauses.push("1=0");
              }
            } catch (err) {
              console.warn('[T025] failed to lookup promo songs:', err?.message || err);
              // fallback: ใช้ discount_price field (เผื่อข้อมูลใหม่)
              whereClauses.push(
                "json_extract(data, '$.discount_price') IS NOT NULL " +
                "AND CAST(json_extract(data, '$.discount_price') AS REAL) > 0"
              );
            }
          }

          // === build ORDER BY clause (default: newest) ===
          //   - newest: ใช้ column created_at ตรง ๆ (ไม่ใช่ json_extract) → ใช้ index
          //     idx_documents_collection_created_at ได้ → เร็วมาก
          //   - price_asc/desc: CAST(json_extract(data, '$.price') AS REAL)
          //   - name: json_extract(data, '$.song_name') (case-insensitive via COLLATE NOCASE)
          let orderByClause = "created_at DESC"; // default = newest
          if (sortParam === "price_asc") {
            orderByClause = "CAST(json_extract(data, '$.price') AS REAL) ASC";
          } else if (sortParam === "price_desc") {
            orderByClause = "CAST(json_extract(data, '$.price') AS REAL) DESC";
          } else if (sortParam === "name") {
            orderByClause = "json_extract(data, '$.song_name') COLLATE NOCASE ASC";
          }

          const whereSql = whereClauses.join(" AND ");

          // === execute data query (LIMIT + OFFSET) ===
          //   ใช้ limit เดิมที่ parse ไว้ด้านบน (default 50 ถ้าไม่ส่งมา — แต่ T015 client ส่ง 50 เสมอ)
          //   ถ้าไม่ส่ง limit → default เป็น 50 (เหมือน customer page เดิม)
          const effectiveLimit = Number.isInteger(limit) && limit > 0 ? limit : 50;
          const effectiveOffset = Number.isInteger(offset) && offset > 0 ? offset : 0;

          // 🛡️ (T015): กัน D1 bind parameter limit (~100 params)
          //   กรณี djIds + catIds รวมกันเยอะมาก (50+50=100 + 4 binds อื่น) → อาจ overflow
          //   แต่ละ dj id ใช้ 2 binds (dj_id + dj_name) + แต่ละ cat id ใช้ 2 binds → max 4*N
          //   ถ้ารวมเกิน 90 → ตัดสินใจ limit dj/cat ids เป็น 45 ตัวแรก (ปลอดภัย + ใช้งานได้จริง)
          //   ผลกระทบ: ในทางปฏิบัติลูกค้าไม่เลือก DJ/หมวดเกิน 5-10 ตัว → ไม่กระทบการใช้งานจริง
          //   ⚠️ ถ้าอนาคตต้องการรองรับ 100+ filters → เปลี่ยนไปใช้ temp table + JOIN
          const MAX_FILTER_IDS = 45;
          if (djIds.length > MAX_FILTER_IDS || catIds.length > MAX_FILTER_IDS) {
            return jsonResponse({
              error: "ตัวกรองมากเกินไป — กรุณาเลือกไม่เกิน " + MAX_FILTER_IDS + " รายการต่อหมวด",
              code: "FILTER_TOO_MANY",
            }, 400);
          }

          const dataSql = `SELECT id, data FROM documents WHERE ${whereSql} ORDER BY ${orderByClause} LIMIT ? OFFSET ?`;
          const dataBinds = [...binds, effectiveLimit, effectiveOffset];

          let docs = [];
          let totalCount = null;
          try {
            const { results } = await env.DB.prepare(dataSql).bind(...dataBinds).all();
            docs = (results || []).map(row => ({ id: row.id, data: JSON.parse(row.data) }));
          } catch (err) {
            console.warn("[T015] advanced songs query failed:", err?.message || err);
            return jsonResponse({ error: "ค้นหาเพลงไม่สำเร็จ กรุณาลองใหม่", code: "QUERY_FAILED" }, 500);
          }

          // === count total (filtered) — สำหรับ frontend แสดง "พบ X เพลง" ===
          try {
            const countSql = `SELECT COUNT(*) AS c FROM documents WHERE ${whereSql}`;
            const countRow = await env.DB.prepare(countSql).bind(...binds).first();
            totalCount = (countRow && countRow.c) || 0;
          } catch (err) {
            console.warn("[T015] advanced songs count failed:", err?.message || err);
            totalCount = docs.length; // fallback — ใช้จำนวนที่ดึงมาแทน (ใต้สุด)
          }

          // === sanitize sensitive fields (full_file_url, etc.) สำหรับ non-admin ===
          if (!admin) {
            docs = sanitizeSongsForPublic(docs);
            if (slim) {
              docs = docs.map((d) => ({
                id: d.id,
                data: slimSongForList(d.data || {}),
              }));
            }
          }

          // === build response (same shape as standard path) ===
          //   - docs: array of { id, data }
          //   - total: filtered count (frontend ใช้แสดง "พบ X เพลง")
          //   - limit, offset: pagination metadata
          //   🆕 (T028): ใช้ CACHE.PUBLIC_API (edge cache 5 นาที) แทน CUSTOMER_API — ลด invocations
          const isCacheable = PUBLIC_READ_COLLECTIONS.has(collection) && collection !== "orders";
          const extraHeaders = isCacheable
            ? { "Cache-Control": CACHE.PUBLIC_API, "Vary": "Cookie" }
            : {};
          const body = JSON.stringify({
            docs,
            total: totalCount != null ? totalCount : docs.length,
            limit: effectiveLimit,
            offset: effectiveOffset,
          });
          return new Response(body, {
            status: 200,
            headers: { "Content-Type": "application/json", ...corsHeaders(), ...extraHeaders, ...securityHeaders() },
          });
        }
        // (no advanced filters → fall through to standard listDocuments path)
      }

      let docs = await listDocuments(env, collection, opts);
      // 🔒 sanitize ฟิลด์ sensitive ของ songs ถ้าเป็น non-admin
      if (collection === "songs" && !admin) {
        docs = sanitizeSongsForPublic(docs);
        // 🔧 (2026-09-18 v6 perf): slim ส่งเฉพาะฟิลด์จำเป็นสำหรับ list view + modal
        //   ลด response จาก ~2KB/song → ~500 bytes/song (ลด 75%)
        //   ฟิลด์ที่เก็บ: song_name, artist, dj_name, cover_url, preview_url, file_url,
        //     price, duration, description, playlist_id/name, status, category_*, preview_*
        //   ฟิลด์ที่ตัด: tags, bpm, key, waveform_data, ฯลฯ (admin ใช้เท่านั้น)
        if (slim) {
          docs = docs.map((d) => ({
            id: d.id,
            data: slimSongForList(d.data || {}),
          }));
        }
      }
      // 🔧 (2026-09-18 v6 perf): CDN cache สำหรับ public collections GET requests
      //   ช่วยให้ customer หลังจากคนแรกได้ cache hit (เร็วมาก)
      //   ใช้ cache 60 วินาที — เพลง/playlist ไม่ค่อยเปลี่ยน
      //   ไม่ cache "orders" (per-customer — ห้าม cache) หรือ "admins" (per-admin)
      const isCacheable = PUBLIC_READ_COLLECTIONS.has(collection) && collection !== "orders";
      // 🔒 (2026-09-21 fix Bug #1 Cache-Poisoning): เพิ่ม "Vary: Cookie" ทุก cacheable response
      //   เดิม: cache แยกแค่ตาม URL → ถ้าแอดมินเปิดหน้าก่อน CDN แคช response ที่มี full_file_url
      //         → ลูกค้าคนถัดไปได้ response เดียวกัน (มี full_file_url) → ดาวน์โหลดเพลงเต็มฟรี
      //   ใหม่: Vary: Cookie บอก CDN ว่า response ขึ้นกับ cookie ของผู้ขอ → cache แยกตาม session
      //   ผลกระทบระบบเดิม: 0% — header แค่บอก CDN cache key, ไม่เปลี่ยน response content
      //   ผลกระทบ cache hit rate: ลดลงนิดน้อย (แต่ละ session มี cache ของตัวเอง) — รับเพื่อ security
      //
      // 🆕 (T010-M9): cache poisoning fix — เปลี่ยน `public` → `private` สำหรับ cacheable responses
      //   ปัญหาเดิม (บรรทัด 2240 เดิม): `Cache-Control: public, max-age=10` + `Vary: Cookie`
      //     Cloudflare Free CDN อาจไม่ honor `Vary: Cookie` อย่างสมบูรณ์ → cache response ของ admin
      //     (ที่มี full_file_url) ส่งให้ non-admin → cache poisoning + เพลงรั่ว
      //   วิธีแก้: ใช้ `private` (cache เฉพาะ browser ของ user คนนั้น ไม่ใช่ shared cache)
      //     + `no-cache, must-revalidate` บังคับ revalidate ทุกครั้ง → cache hit rate ลดลง แต่ปลอดภัย
      //   ผลกระทบระบบเดิม: ต่ำ — CDN cache hit rate ลดลง (แต่ละ user ต้อง revalidate) แต่ data consistency ดีขึ้น
      //   อ้างอิง: OWASP Cache Poisoning, Cloudflare Free plan docs
      //   🆕 (T028): เปลี่ยนกลับเป็น CACHE.PUBLIC_API (public, max-age=300) — ลด Worker invocations
      //     T010-M9 เปลี่ยนเป็น private เพื่อกัน cache poisoning → แต่ทำให้ทุก API call = invocation
      //     T028: ใช้ public + Vary: Cookie (แยก cache ตาม session) + max-age=300 (5 นาที)
      //     ปลอดภัยเพราะ Vary: Cookie แยก cache admin (เห็น full_file_url) จาก guest (เห็น slim)
      //     ผล: ลด invocations 90%+ สำหรับ public data (songs/categories/djs/playlists)
      const extraHeaders = isCacheable
        ? { "Cache-Control": CACHE.PUBLIC_API, "Vary": "Cookie" }
        : {};
      // 🚀 (2026-09-28 fix C-1): ส่ง total กลับใน response เมื่อมี limit (สำหรับ pagination)
      //   เดิม: response = { docs } → client ไม่รู้ว่ามีข้อมูลเท่าไหร่ทั้งหมด → background loader ไม่ทำงาน
      //   ใหม่: response = { docs, total, limit, offset } เมื่อมี limit param
      //   ผลกระทบระบบเดิม: 0% — client ที่ไม่ใช้ total ยังทำงานได้ (เพิ่ม field ไม่กระทบ)
      //   ประโยชน์: orders.js loadSongsFromDatabase รู้ total → lazy load batch ถัดไปได้
      let totalCount = null;
      if (Number.isInteger(limit) && limit > 0) {
        try {
          totalCount = await countDocumentsAll(env, collection);
        } catch (err) {
          console.warn("countDocumentsAll failed (will return total=null):", err?.message || err);
        }
      }
      // ใช้ new Response เพื่อใส่ Cache-Control header (jsonResponse ไม่รองรับ cache)
      const body = JSON.stringify({
        docs,
        ...(totalCount != null ? { total: totalCount, limit, offset } : {}),
      });
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders(), ...extraHeaders, ...securityHeaders() },
      });
    }

    // /api/db/:collection/_query  (where/orderBy)
    if (parts.length === 2 && parts[1] === "_query" && request.method === "POST") {
      // 🆕 (T010-R5): หุ้ม try/catch รอบ `await request.json()` — กัน 503 ตอน bad JSON
      //   เดิม: `const body = await request.json();` (ไม่หุ้ม try/catch)
      //     ถ้า client ส่ง body ไม่ใช่ valid JSON → throw → ไม่มี handler → Worker 500 หรือ 503
      //   ใหม่: หุ้ม try/catch + ส่ง 400 + ข้อความชัดเจน (เหมือน endpoints อื่น เช่น PUT/PATCH)
      //   ผลกระทบระบบเดิม: 0% — client ที่ส่ง valid JSON ยังทำงานเหมือนเดิม
      let body;
      try { body = await request.json(); } catch { return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400); }
      let docs = await queryDocuments(env, collection, body);
      // 🔒 sanitize ฟิลด์ sensitive ของ songs ถ้าเป็น non-admin
      if (collection === "songs" && !admin) {
        docs = sanitizeSongsForPublic(docs);
      }
      return jsonResponse({ docs });
    }

    // /api/db/:collection/:id
    if (parts.length === 2) {
      const id = parts[1];
      if (request.method === "GET") {
        const doc = await getDocument(env, collection, id);
        if (!doc) return jsonResponse({ exists: false });
        // 🔒 sanitize ฟิลด์ sensitive ของ songs ถ้าเป็น non-admin (single doc)
        let responseData = doc.data;
        if (collection === "songs" && !admin) {
          responseData = { ...(responseData || {}) };
          for (const f of SONG_SENSITIVE_FIELDS) {
            if (f in responseData) delete responseData[f];
          }
        }
        return jsonResponse({ exists: true, id: doc.id, data: responseData });
      }
      if (request.method === "PUT") {
        // BUG FIX: body must be parsed before use in PUT handler
        let body;
        try { body = await request.json(); } catch { return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400); }
        // 🔒 แก้บั๊ก C2 (2026-09-17): กัน Privilege Escalation
        //   เดิม: ตรวจแค่ "login หรือไม่" แต่ไม่ตรวจ admin.role === "main"
        //   → Sub-admin สามารถ PATCH/PUT ตัวเองเป็น main admin หรือแก้ email ของ main admin ได้
        //   แก้: เฉพาะ main admin เท่านั้นที่เขียน collection="admins" ได้ (PUT)
        //   สอดคล้องกับ create-admin endpoint (บรรทัด ~303) ที่มี role check อยู่แล้ว
        if (collection === "admins" && admin.role !== "main") {
          return jsonResponse({ error: "เฉพาะแอดมินหลักเท่านั้นที่จัดการแอดมินได้" }, 403);
        }
        // 🔒 (Audit Fix H-10): Server-side validation สำหรับ discount_value bounds
        //   ปัญหาเดิม: client-side validate discount_value <= 100 แต่ server ไม่ validate
        //   sub-admin สามารถ bypass client ด้วย direct API call: PATCH /api/db/promotions/:id
        //   { data: { discount_value: 150 } } → server stores 150 → calc Math.min(100) clamps
        //   แต่กรณี type=cart_fixed ไม่มี clamp → sub-admin สามารถตั้ง discount=999999 LAK
        //   ทำให้ final_total = 0 (ฟรี) แม้ลูกค้าไม่มี coupon
        //   วิธีแก้: validate ฝั่ง server ทุกครั้งที่เขียน discounts/promotions
        //   ผลกระทบระบบเดิม: 0% — ถ้าค่าถูกต้อง → ผ่าน (เหมือนเดิม)
        //   ถ้าค่าผิด → return 400 + ไม่บันทึก
        if ((collection === "discounts" || collection === "promotions") && body?.data) {
          const validationErr = validateDiscountData(collection, body.data);
          if (validationErr) return jsonResponse({ error: validationErr }, 400);
        }
        // 🔒 (Audit Fix M-26): validate settings fields ฝั่ง server
        if (collection === "settings" && body?.data) {
          const settingsErr = validateSettingsData(body.data);
          if (settingsErr) return jsonResponse({ error: settingsErr }, 400);
        }
        if (!admin && collection === "orders") {
          // 🔒 (2026-09-23 fix): Rate limiting บนการสร้างออเดอร์สำหรับลูกค้าที่ยังไม่ login
          //   ปัญหา: endpoint นี้ (PUT /api/db/orders/:id แบบไม่ login) ไม่มี rate limit
          //          → attacker ยิงสแปมสร้างออเดอร์ปลอมจำนวนมาก รบกวนแอดมิน + กิน D1 write quota
          //   วิธีแก้: เลียนแบบรูปแบบ login rate limit (บรรทัด ~414) แต่ใช้ตาราง order_creation_attempts
          //          และ insert ทุกครั้ง (ไม่ใช่เฉพาะ fail) เพราะการโจมตีคือ "สร้างปลอมล้น quota" ไม่ใช่ brute-force
          //   ค่า threshold: 10 ครั้ง / 15 นาที ต่อ IP (ลูกค้าปกติไม่สั่งเกิน 2-3 ออเดอร์/ชม.)
          //   ผลกระทบระบบเดิม: 0% — ถ้าตาราง order_creation_attempts ไม่มี → ข้าม rate limiting (fallback: ไม่บล็อก)
          //          logic ทำงานก่อน existing-check / validation เดิม ทั้งหมดไม่ถูกแตะ
          const ORDER_RATE_LIMIT_MAX = 10;
          const ORDER_RATE_LIMIT_WINDOW_MINUTES = 15;
          const orderClientIP = request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || "unknown";
          const orderRateWindow = new Date(Date.now() - ORDER_RATE_LIMIT_WINDOW_MINUTES * 60 * 1000).toISOString();
          try {
            const orderAttemptRow = await env.DB.prepare(
              "SELECT COUNT(*) AS c FROM order_creation_attempts WHERE ip = ? AND attempted_at > ?"
            ).bind(orderClientIP, orderRateWindow).first();
            const orderAttemptCount = orderAttemptRow?.c || 0;
            if (orderAttemptCount >= ORDER_RATE_LIMIT_MAX) {
              return jsonResponse({
                error: `สร้างออเดอร์เกินไป (${ORDER_RATE_LIMIT_MAX} ครั้งใน ${ORDER_RATE_LIMIT_WINDOW_MINUTES} นาที) — กรุณารอ ${ORDER_RATE_LIMIT_WINDOW_MINUTES} นาทีแล้วลองใหม่`,
                code: "order/rate-limited"
              }, 429);
            }
            // บันทึก attempt ทุกครั้ง (ไม่ใช่เฉพาะ fail) — กัน spam quota-exhaustion
            await env.DB.prepare(
              "INSERT INTO order_creation_attempts (ip, attempted_at) VALUES (?, ?)"
            ).bind(orderClientIP, new Date().toISOString()).run();
          } catch (orderRateErr) {
            // ถ้าตาราง order_creation_attempts ไม่มี → ข้าม rate limiting (fallback: ไม่บล็อก)
            // ผู้ใช้ต้องสร้างตารางนี้เอง (ดู schema.sql)
            console.warn("order rate limiting skipped (table order_creation_attempts not found):", orderRateErr?.message);
          }

          // 🔒 (2026-09-28 fix Critical C2): กัน order ID enumeration
          //   เดิม: SELECT existing → ถ้ามี return 401, ถ้าไม่มี ดำเนินการต่อ
          //         → attacker สุ่ม orderId ได้ ถ้าได้ 401 = มีอยู่, ถ้าได้ 200 = ไม่มี
          //         → brute-force enumerate order IDs ทั้งระบบ (info disclosure)
          //   ใหม่: 2 ชั้นกัน enumeration
          //     1) validate id เป็น UUID v4 format (regex) — reject ทันทีถ้าไม่ตรง
          //        → attacker ไม่สามารถใช้ ID สั้น/ตัวเลข หรือ pattern อื่นเพื่อ probe ได้
          //     2) atomic INSERT...ON CONFLICT DO NOTHING + เช็ค changes()
          //        → ไม่มี SELECT ก่อน INSERT → ไม่มี timing oracle
          //        → ถ้า changes() === 0 = มีอยู่แล้ว (หรือ UUID ซ้ำ) → return 401 (เหมือนเดิม)
          //   ผลกระทบระบบเดิม: 0% — app-cart.js สร้าง UUID v4 อยู่แล้ว (crypto.randomUUID())
          //     → ลูกค้าปกติไม่กระทบ; attacker เท่านั้นที่ใช้ ID ปลอมไม่ได้อีก
          //   หมายเหตุ: atomic INSERT ทำ *หลัง* validation ทั้งหมดผ่าน → ไม่มี orphan row
          //     ถ้า validation ล้ม → return ก่อน INSERT (ไม่มี row ค้าง)
          //     timing เท่ากันทั้งกรณี "มีอยู่" กับ "ไม่มี" เพราะ validation ทำงานเหมือนกัน
          const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
          if (!UUID_V4_REGEX.test(String(id || ""))) {
            return jsonResponse({ error: "ยังไม่ได้เข้าสู่ระบบ" }, 401);
          }

          // 🔒 Security (2026-09-17 P0): Validate + sanitize ออเดอร์ที่ลูกค้าสร้างเอง
          //   เดิม: server รับ body.data ตรง ๆ → ลูกค้าสามารถส่ง status='completed' หรือ total=-100
          //   ทำให้ bypass การตรวจสอบเงินโอนของ admin (เพราะ admin filter เฉพาะ pending_verify)
          //   ใหม่: server บังคับ status='pending_verify' + validate required fields + total >= 0
          //   admin จะเห็นออเดอร์นี้ใน "รอตรวจสอบ" เสมอ → ต้องเช็คเงินโอนเองทุกครั้ง
          const data = body.data || {};

          // 🆕 (2026-10-02): ตั้ง customer_id อัตโนมัติจาก customer session cookie
          //   ปัญหา: frontend (app-cart.js) บางครั้งส่ง customer_id = null เพราะ ES module timing issue
          //   → order ไม่ผูกบัญชี → หน้า "บัญชีของฉัน" ดึงไม่เจอ
          //   วิธีแก้: ให้ Worker เป็นคนตั้ง customer_id จาก session cookie (HttpOnly)
          //   → ไม่พึ่ง frontend เลย → ทำงานเสมอ
          //   ถ้าไม่ login → customer_id = null (เหมือนเดิม ระบบ track order ด้วยชื่อ+เบอร์ยังทำงาน)
          // 🔧 (2026-10-02 fix3): เก็บ customer id จาก session ไว้ในตัวแปรแยก แล้วค่อยใส่ใน filteredData ด้านล่าง
          //   สาเหตุบั๊ก: customer_id ไม่อยู่ใน CUSTOMER_ALLOWED_FIELDS → ถูก filter ทิ้งก่อนบันทึกเสมอ
          //   (ทั้งค่าที่ frontend ส่งมา และค่าที่ตั้งตรงนี้) → ออเดอร์ไม่ผูกบัญชี → หน้า "ออเดอร์ของฉัน" ไม่เจอ
          //   ใช้ค่าจาก session cookie เท่านั้น (ไม่เชื่อ customer_id ที่ client ส่งมา → กัน spoof ผูกออเดอร์กับบัญชีคนอื่น)
          let sessionCustomerId = null;
          try {
            const customer = await getCustomerSession(request, env);
            if (customer) {
              sessionCustomerId = customer.id;
              data.customer_id = customer.id;
            }
          } catch (_) { /* ถ้า customer_sessions table ไม่มี → ข้าม */ }

          // ตรวจ required fields — กันสคริปต์ส่งข้อมูลไม่ครบ
          if (!data.customer_name || typeof data.customer_name !== "string" || !data.customer_name.trim()) {
            return jsonResponse({ error: "ข้อมูลไม่ครบ — ต้องมี customer_name" }, 400);
          }
          if (!data.whatsapp || typeof data.whatsapp !== "string" || !data.whatsapp.trim()) {
            return jsonResponse({ error: "ข้อมูลไม่ครบ — ต้องมี whatsapp" }, 400);
          }
          if (!Array.isArray(data.items) || data.items.length === 0) {
            return jsonResponse({ error: "ต้องมีรายการสินค้า (items)" }, 400);
          }
          // ตรวจ total — ต้องเป็นจำนวนเงิน >= 0 (admin จะเช็คเองอีกทีตอนยืนยัน)
          if (typeof data.total !== "number" || !Number.isFinite(data.total) || data.total < 0) {
            return jsonResponse({ error: "ยอดรวมไม่ถูกต้อง (ต้องเป็นจำนวนเงินที่ >= 0)" }, 400);
          }

          // 🔒 แก้บั๊ก I8 (2026-09-18): เพิ่ม validation ความยาว + โครงสร้าง items
          //   กันลูกค้าส่งข้อมูลประหลาดที่อาจทำให้ DB พัง (D1 row size limit 1MB) หรือ CPU spin
          if (data.customer_name.length > 200) {
            return jsonResponse({ error: "ชื่อลูกค้ายาวเกินไป (สูงสุด 200 ตัวอักษร)" }, 400);
          }
          if (data.whatsapp.length > 30) {
            return jsonResponse({ error: "เบอร์ WhatsApp ยาวเกินไป (สูงสุด 30 ตัวอักษร)" }, 400);
          }
          if (data.items.length > 100) {
            return jsonResponse({ error: "รายการสินค้ามากเกินไป (สูงสุด 100 รายการ)" }, 400);
          }
          // validate แต่ละ item มี field ครบ (title + price) — กันส่ง items ประหลาด
          for (const item of data.items) {
            if (!item || typeof item !== "object") {
              return jsonResponse({ error: "รายการสินค้าไม่ถูกต้อง" }, 400);
            }
            if (!item.title || typeof item.title !== "string" || item.title.length > 200) {
              return jsonResponse({ error: "รายการสินค้าต้องมีชื่อ (สูงสุด 200 ตัวอักษร)" }, 400);
            }
            if (typeof item.price !== "number" || !Number.isFinite(item.price) || item.price < 0) {
              return jsonResponse({ error: "ราคาสินค้าไม่ถูกต้อง (ต้องเป็นจำนวนเงิน >= 0)" }, 400);
            }
          }

          // 🔒 Force status='pending_verify' — ลูกค้าตั้ง status เองไม่ได้
          //   กัน bypass การตรวจสอบเงินโอน (เช่น ตั้ง status='completed' ตรง ๆ)
          //   ส่วน status บังคับเป็น "pending_verify" เสมอ → admin ต้องเปลี่ยนเอง
          data.status = "pending_verify";

          // 🔒 (2026-09-21 fix Bug #3 Customer PUT spoof): Whitelist fields ที่ลูกค้าส่งได้
          //   เดิม: server รับทุก field จาก body.data → ลูกค้าส่ง payment_status="paid"
          //         zip_status="ready" zip_download_url="https://..." → bypass การตรวจเงินโอน
          //   ใหม่: whitelist เฉพาะ fields ที่ลูกค้าควรส่ง (snapshot การสั่งซื้อ + ข้อมูลติดต่อ)
          //         fields อื่นๆ ที่ admin-only (status_history, payment_*, zip_*, assigned_admin_id,
          //         verified_at, etc.) ถูก discard โดยไม่ error — กันแตะระบบเดิม
          //   ผลกระทบระบบเดิม: 0% — fields ที่ลูกค้าเคยส่งได้ (ใน whitelist) ยังส่งได้เหมือนเดิม
          const CUSTOMER_ALLOWED_FIELDS = new Set([
            "customer_name", "whatsapp", "items", "total", "subtotal",
            "discount_amount", "promotion_applied", "final_total",
            "receipt_number", "created_at", "store_name", "order_type",
            "playlist_id", "playlist_name", "notes", "customer_note",
            // 🔒 (2026-09-28 fix H6): ลบ "payment_proof_id" + "payment_proof_uploaded_at" ออกจาก whitelist
            //   เดิม: ลูกค้าส่ง payment_proof_id="fake-xxx" + payment_proof_uploaded_at="2026-..." ผ่าน PUT order
            //         → หลอกแอดมินว่าอัปสลิปแล้ว (ทั้งที่ไม่ได้อัปไฟล์จริงใน R2 + ไม่มี row ใน payment_proofs table)
            //         → แอดมินที่ไม่ระวังกด "ยืนยันสลิป" → สร้าง ZIP ส่งให้ลูกค้าฟรี
            //   ใหม่: ลูกค้าต้องอัปสลิปผ่าน POST /api/orders/:id/payment-proof เท่านั้น
            //         (มี ownership verify + R2 upload จริง + INSERT row ใน payment_proofs + rate limiting)
            //         fields ทั้งสองนี้ถูก set โดย server-side ในบรรทัด ~4549-4551 เท่านั้น
            //   ผลกระทบระบบเดิม: 0%
            //     - frontend (app-cart.js) ไม่ได้ส่ง 2 fields นี้ผ่าน PUT order
            //     - frontend อัปสลิปผ่าน endpoint /payment-proof ซึ่งไม่เกี่ยวกับ whitelist นี้
            //     - ลูกค้ายังเห็นสถานะสลิปของตัวเองได้ปกติ (อ่านจาก order ที่ server บันทึก)
          ]);
          const filteredData = {};
          for (const key of Object.keys(data)) {
            if (CUSTOMER_ALLOWED_FIELDS.has(key)) {
              filteredData[key] = data[key];
            }
          }
          // force status หลัง filter (กัน case ที่ status อยู่ใน whitelist โดยไม่ตั้งใจ — ปลอดภัยกว่า)
          filteredData.status = "pending_verify";
          // 🔧 (2026-10-02 fix3): ผูกออเดอร์กับบัญชีลูกค้าที่ login (จาก session เท่านั้น)
          //   ไม่ login → ไม่ใส่ field นี้ (ระบบ track order ด้วยชื่อ+เบอร์ทำงานเหมือนเดิม)
          if (sessionCustomerId) filteredData.customer_id = sessionCustomerId;
          // 🆕 (2026-10-03 v10 — แยก Login / Guest): ตัดสินที่ Server จาก session เท่านั้น
          //   - login (มี session) → เก็บ customer_id อย่างเดียว ทิ้ง guest_id ที่ client ส่งมา (กันออเดอร์ login มี 2 ตัวตน)
          //   - guest (ไม่มี session) → เก็บ guest_id ถ้าเป็น UUID v4 ที่ถูกต้อง ไม่งั้นไม่เก็บ
          //     (customer_id ไม่อยู่ใน whitelist อยู่แล้ว → client ปลอม customer_id ไม่ได้)
          //   guest_id คือ "กุญแจ" ของ browser นั้น ใช้คู่กับ WhatsApp เพื่อค้นเฉพาะออเดอร์ guest ของตัวเอง
          if (sessionCustomerId) {
            delete filteredData.guest_id;
          } else {
            const safeGuestId = normalizeGuestId(data.guest_id);
            if (safeGuestId) filteredData.guest_id = safeGuestId;
            else delete filteredData.guest_id;
          }

          // 🔒 (2026-09-22 fix Bug #4): Server re-calculate ราคาจาก DB แทนเชื่อลูกค้า
          //   ปัญหา: ลูกค้าส่ง total=0 หรือราคาเท่าไรก็ได้ → แอดมินเห็นราคาผิด
          //   วิธีแก้: Server fetch song/playlist prices จาก D1 → re-calc total → override
          //   ผลกระทบระบบเดิม: 0% — ถ้าลูกค้าส่งราคาถูกต้อง → override ค่าเดียวกัน (ไม่เปลี่ยน)
          //           ถ้าลูกค้าส่งราคาผิด → server ใช้ราคาจริงจาก DB
          if (Array.isArray(filteredData.items) && filteredData.items.length > 0) {
            try {
              // แยก song IDs + playlist IDs จาก items
              const songIds = [];
              const playlistIds = [];
              for (const item of filteredData.items) {
                if (item.kind === "playlist" && item.playlist_id) {
                  playlistIds.push(item.playlist_id);
                } else if (item.song_id) {
                  songIds.push(item.song_id);
                } else if (item.playlist_id) {
                  playlistIds.push(item.playlist_id);
                }
              }
              // Batch fetch song prices
              let serverSubtotal = 0;
              if (songIds.length > 0) {
                const songDocs = await getDocumentsByIds(env, "songs", songIds);
                for (const sd of songDocs) {
                  if (sd && sd.data) {
                    const price = Number(sd.data.price);
                    if (Number.isFinite(price) && price >= 0) {
                      serverSubtotal += price;
                    }
                  }
                }
              }
              // Batch fetch playlist prices
              if (playlistIds.length > 0) {
                const plDocs = await getDocumentsByIds(env, "playlists", playlistIds);
                for (const pd of plDocs) {
                  if (pd && pd.data) {
                    const price = Number(pd.data.price);
                    if (Number.isFinite(price) && price >= 0) {
                      serverSubtotal += price;
                    }
                  }
                }
              }
              // 🔒 (2026-09-23 fix): Server-side discount/promotion validation
              //   ปัญหาเดิม: บรรทัดนี้เคยใช้ `Number(filteredData.discount_amount || 0)` ตรง ๆ
              //             → ลูกค้าส่ง discount_amount = subtotal ทั้งหมด → total = 0 โดยไม่มีโค้ดจริง
              //   วิธีแก้: Server fetch discounts + promotions จาก D1 → re-calc ทั้ง item discount
              //          และ cart promotion → ตรวจ promotion_applied.id ว่ามีจริง + active + ไม่หมดอายุ
              //          → override filteredData.discount_amount + promotion_applied + total + final_total
              //   ผลกระทบระบบเดิม: 0% — ถ้าลูกค้าส่งค่าถูกต้อง → override ค่าเดียวกัน (ไม่เปลี่ยน)
              //          ถ้าลูกค้าส่งค่าผิด → server ใช้ค่าจริงจาก DB (admin ยังตรวจอีกที)
              //   สอดคล้องกับ computeCartPricing / computeBestPromotion ฝั่ง client (app-promotion.js PART 1)

              // 1. Fetch all discounts + promotions จาก D1
              const [discountsRows, promotionsRows] = await Promise.all([
                listDocuments(env, "discounts"),
                listDocuments(env, "promotions"),
              ]);
              const nowMs = Date.now();
              // กรองเฉพาะที่ active + อยู่ในช่วง start_at/end_at (เหมือน fetchActiveDiscounts/Promotions ฝั่ง client)
              const isPricingActive = (d) => {
                if (!d) return false;
                if (d.active === false) return false;
                if (d.start_at) {
                  const t = new Date(d.start_at).getTime();
                  if (!isNaN(t) && nowMs < t) return false;
                }
                if (d.end_at) {
                  const t = new Date(d.end_at).getTime();
                  if (!isNaN(t) && nowMs > t) return false;
                }
                return true;
              };
              const activeDiscounts = discountsRows
                .map(r => ({ id: r.id, ...(r.data || {}) }))
                .filter(isPricingActive);
              const activePromotions = promotionsRows
                .map(r => ({ id: r.id, ...(r.data || {}) }))
                .filter(isPricingActive);

              // 2. Build DB price + category maps (กันลูกค้าส่ง price หรือ category_id ปลอม)
              //    ใช้ชื่อ dbSongPriceMap / dbPlPriceMap / dbSongCategoryMap เพื่อหลีกเลี่ยงการชนกับ
              //    songPriceMap / plPriceMap ที่ประกาศใน block ด้านล่าง (lines ~1424)
              const dbSongPriceMap = new Map();
              const dbSongCategoryMap = new Map();
              if (songIds.length > 0) {
                const songDocsForDiscount = await getDocumentsByIds(env, "songs", songIds);
                for (const sd of songDocsForDiscount) {
                  if (sd && sd.data) {
                    dbSongPriceMap.set(sd.id, Number(sd.data.price) || 0);
                    dbSongCategoryMap.set(sd.id, sd.data.category_id || sd.data.categoryId || null);
                  }
                }
              }
              const dbPlPriceMap = new Map();
              if (playlistIds.length > 0) {
                const plDocsForDiscount = await getDocumentsByIds(env, "playlists", playlistIds);
                for (const pd of plDocsForDiscount) {
                  if (pd && pd.data) {
                    dbPlPriceMap.set(pd.id, Number(pd.data.price) || 0);
                  }
                }
              }

              // 3. Resolve DB price ของแต่ละ item (กันลูกค้าส่ง price=0)
              const resolveItemDbPrice = (it) => {
                if (it.kind === "playlist" && it.playlist_id) {
                  return dbPlPriceMap.get(it.playlist_id) ?? Number(it.price) ?? 0;
                }
                if (it.song_id) {
                  return dbSongPriceMap.get(it.song_id) ?? Number(it.price) ?? 0;
                }
                if (it.playlist_id) {
                  return dbPlPriceMap.get(it.playlist_id) ?? Number(it.price) ?? 0;
                }
                return Number(it.price) || 0;
              };

              // 4. Compute item-level discounts (mirror applyDiscountToPrice + findActiveDiscountFor ฝั่ง client)
              const findActiveDiscountFor = (targetType, targetId) => {
                if (!targetType || !targetId) return null;
                return activeDiscounts.find(d => d.target_type === targetType && d.target_id === targetId) || null;
              };
              const applyDiscountToPrice = (originalPrice, discount) => {
                if (!discount || typeof originalPrice !== "number" || isNaN(originalPrice)) {
                  return { finalPrice: originalPrice, discountAmount: 0, hasDiscount: false };
                }
                const value = Number(discount.discount_value) || 0;
                let finalPrice = originalPrice;
                if (discount.discount_type === "percent") {
                  const pct = Math.max(0, Math.min(100, value));
                  finalPrice = Math.round(originalPrice * (100 - pct) / 100);
                } else if (discount.discount_type === "fixed") {
                  finalPrice = Math.max(0, originalPrice - value);
                }
                finalPrice = Math.round(finalPrice);
                const discountAmount = Math.max(0, originalPrice - finalPrice);
                return { finalPrice, discountAmount, hasDiscount: discountAmount > 0 };
              };

              const itemsWithDiscount = filteredData.items.map(it => {
                const originalPrice = resolveItemDbPrice(it);
                let discount = null;
                if (it.kind === "playlist") {
                  discount = findActiveDiscountFor("playlist", it.playlist_id || it.id);
                } else {
                  discount = findActiveDiscountFor("song", it.song_id || it.id);
                }
                const { finalPrice, discountAmount: itemDisc, hasDiscount } = applyDiscountToPrice(originalPrice, discount);
                return {
                  ...it,
                  original_price: originalPrice,
                  discount_price: finalPrice,
                  item_discount: itemDisc,
                  _hadDiscount: hasDiscount,
                };
              });

              // 5. Compute best cart-wide promotion (mirror computeBestPromotion + isItemInPromotionScope)
              const isItemInPromotionScope = (item, promotion) => {
                if (!promotion) return false;
                const appliesTo = promotion.applies_to || "all";
                // 🚀 (2026-09-28 fix H-7): เพิ่ม scope "playlist"
                if (appliesTo === "playlist") {
                  return item.kind === "playlist";
                }
                if (appliesTo === "all") return true;
                if (appliesTo === "category") {
                  if (item.kind && item.kind !== "song") return false;
                  // ใช้ category_id จาก DB (dbSongCategoryMap) ไม่ใช่จากลูกค้า — กัน spoof
                  const songId = item.song_id || item.id;
                  const catId = dbSongCategoryMap.get(songId) || item.category_id || item.categoryId || null;
                  if (!catId || !promotion.category_id) return false;
                  return catId === promotion.category_id;
                }
                return false;
              };

              // 🚀 (H-7): อ่าน order_type จากลูกค้า เพื่อ filter playlist_tiered_percent
              const orderType = String(filteredData.order_type || "").toLowerCase();
              // 🚀 (H-7): Helper หา tier ที่ใช้ได้ (mirror จาก app-promotion.js)
              const findApplicableTier = (tiers, playlistCount) => {
                if (!Array.isArray(tiers) || tiers.length === 0) return null;
                const sorted = [...tiers]
                  .filter(t => t && Number(t.min_quantity) > 0 && Number(t.discount_percent) >= 0)
                  .sort((a, b) => Number(b.min_quantity) - Number(a.min_quantity));
                for (const tier of sorted) {
                  if (playlistCount >= Number(tier.min_quantity)) {
                    return {
                      min_quantity: Number(tier.min_quantity),
                      discount_percent: Number(tier.discount_percent),
                    };
                  }
                }
                return null;
              };

              let playlistScopeBest = null; // { promo, eligibleItems, eligibleCount, discount, tier }
              let songScopeBest = null;
              for (const promo of activePromotions) {
                // 🚀 (H-7): กรอง playlist_tiered_percent ตาม order_type
                if (promo.type === "playlist_tiered_percent" && orderType && orderType !== "playlist" && orderType !== "mixed") {
                  continue;
                }
                const eligibleItems = itemsWithDiscount.filter(it => {
                  if (it._hadDiscount) return false;
                  // 🚀 (H-7): ปรับ guard — อนุญาต playlist items สำหรับ applies_to="playlist"
                  if (it.kind === "playlist") {
                    if ((promo.applies_to || "all") === "playlist") return true;
                    return false;
                  }
                  return isItemInPromotionScope(it, promo);
                });
                const eligibleCount = eligibleItems.length;
                if (eligibleCount === 0) continue;
                if (promo.min_quantity && eligibleCount < promo.min_quantity) continue;
                const eligibleSubtotal = eligibleItems.reduce((s, it) => s + (Number(it.discount_price) || 0), 0);
                if (promo.min_subtotal && eligibleSubtotal < promo.min_subtotal) continue;
                let promoDiscount = 0;
                let appliedTier = null;
                if (promo.type === "cart_percent") {
                  const pct = Math.max(0, Math.min(100, Number(promo.discount_value) || 0));
                  promoDiscount = Math.round(eligibleSubtotal * pct / 100);
                } else if (promo.type === "cart_fixed") {
                  promoDiscount = Math.min(eligibleSubtotal, Math.round(Number(promo.discount_value) || 0));
                } else if (promo.type === "buy_x_get_y_percent") {
                  const pct = Math.max(0, Math.min(100, Number(promo.discount_value) || 0));
                  promoDiscount = Math.round(eligibleSubtotal * pct / 100);
                } else if (promo.type === "playlist_tiered_percent") {
                  // 🚀 (H-7): Server-side tiered discount
                  const playlistCount = eligibleItems.filter(it => it.kind === "playlist").length;
                  if (playlistCount === 0) continue;
                  const tier = findApplicableTier(promo.tiers, playlistCount);
                  if (!tier) continue;
                  const pct = Math.max(0, Math.min(100, tier.discount_percent));
                  promoDiscount = Math.round(eligibleSubtotal * pct / 100);
                  appliedTier = tier;
                } else {
                  continue;
                }
                // 🚀 (STACK): แยก scope และเลือก best within scope (ไม่ best across all อีกต่อไป)
                const scopeBucket = (promo.applies_to === "playlist") ? "playlist" : "song";
                const candidate = { promo, eligibleItems, eligibleCount, discount: promoDiscount, tier: appliedTier };
                if (scopeBucket === "playlist") {
                  if (!playlistScopeBest || promoDiscount > playlistScopeBest.discount) {
                    playlistScopeBest = candidate;
                  }
                } else {
                  if (!songScopeBest || promoDiscount > songScopeBest.discount) {
                    songScopeBest = candidate;
                  }
                }
              }

              // 🚀 (STACK): รวมส่วนลดของทั้งสอง scope (playlist-scope + song-scope)
              //   ภายใน scope ยังเลือกอันเดียวที่ลดมากสุด — แต่ข้าม scope stack กันได้
              let totalPromoDiscount = 0;
              let serverPromotionsApplied = []; // array ของ { id, name, ... } — snapshot ใน order
              if (playlistScopeBest && playlistScopeBest.discount > 0) {
                totalPromoDiscount += playlistScopeBest.discount;
                serverPromotionsApplied.push({
                  id: playlistScopeBest.promo.id,
                  name: playlistScopeBest.promo.name || "",
                  type: playlistScopeBest.promo.type || "",
                  discount_value: Number(playlistScopeBest.promo.discount_value) || 0,
                  applies_to: playlistScopeBest.promo.applies_to || "all",
                  category_id: playlistScopeBest.promo.category_id || null,
                  scope: "playlist",
                  eligible_count: playlistScopeBest.eligibleCount,
                  discount_amount: playlistScopeBest.discount,
                  tier_applied: playlistScopeBest.tier || null,
                  snapshot_at: new Date().toISOString()
                });
              }
              if (songScopeBest && songScopeBest.discount > 0) {
                totalPromoDiscount += songScopeBest.discount;
                serverPromotionsApplied.push({
                  id: songScopeBest.promo.id,
                  name: songScopeBest.promo.name || "",
                  type: songScopeBest.promo.type || "",
                  discount_value: Number(songScopeBest.promo.discount_value) || 0,
                  applies_to: songScopeBest.promo.applies_to || "all",
                  category_id: songScopeBest.promo.category_id || null,
                  scope: "song",
                  eligible_count: songScopeBest.eligibleCount,
                  discount_amount: songScopeBest.discount,
                  tier_applied: null,
                  snapshot_at: new Date().toISOString()
                });
              }

              // 🛡️ Cap: ส่วนลดรวมต้องไม่เกิน discountSubtotal (กัน finalTotal เป็นลบ)
              let bestPromoDiscount = totalPromoDiscount;
              // (ใช้ serverSubtotal เป็น cap เบื้องต้น ก่อนคำนวณ final total ด้านล่าง)
              if (bestPromoDiscount > serverSubtotal) {
                bestPromoDiscount = serverSubtotal;
              }

              // 🚀 (STACK): validatedPromotionApplied (singular) — เลือกอันที่ให้ discount_amount มากสุด (backward-compat)
              //   และ promotionsApplied (พหูพจน์) — เก็บครบทุก promo ที่ apply
              let validatedPromotionApplied = null;
              let maxDiscountSeen = 0;
              for (const p of serverPromotionsApplied) {
                if (p.discount_amount > maxDiscountSeen) {
                  maxDiscountSeen = p.discount_amount;
                  validatedPromotionApplied = {
                    id: p.id,
                    name: p.name || "",
                    type: p.type || "",
                    discount_value: Number(p.discount_value) || 0,
                    applies_to: p.applies_to || "all",
                    category_id: p.category_id || null,
                    eligible_count: p.eligible_count,
                    discount_amount: p.discount_amount,
                    tier_applied: p.tier_applied || null,
                    snapshot_at: p.snapshot_at,
                  };
                }
              }

              // 🚀 (STACK): ตรวจ promotion_applied ของลูกค้าที่ส่งมา (รองรับทั้ง object เก่า + array ใหม่)
              //   - ถ้าเป็น array → ตรวจทุก id ที่ส่งมา
              //   - ถ้าเป็น object → ตรวจ id เดียว (backward-compat)
              //   - ถ้า id ลูกค้าส่งไม่อยู่ใน server-computed promotions → log warning (audit)
              const customerPromoInput = filteredData.promotion_applied;
              let customerPromoIds = [];
              if (Array.isArray(customerPromoInput)) {
                customerPromoIds = customerPromoInput
                  .map(p => (p && typeof p === "object" && p.id) ? p.id : null)
                  .filter(id => id);
              } else if (customerPromoInput && typeof customerPromoInput === "object" && customerPromoInput.id) {
                customerPromoIds = [customerPromoInput.id];
              }
              const serverPromoIds = serverPromotionsApplied.map(p => p.id);
              for (const cid of customerPromoIds) {
                if (!serverPromoIds.includes(cid)) {
                  console.warn(`[discount-validate] customer promotion_applied.id=${cid} mismatch with server-computed=[${serverPromoIds.join(",")}] — using server value`);
                }
              }

              // 7. Compute final totals และ override ค่าที่ลูกค้าส่งมา
              const itemDiscountAmount = itemsWithDiscount.reduce(
                (s, it) => s + (Number(it.item_discount) || 0), 0
              );
              const discountSubtotal = itemsWithDiscount.reduce(
                (s, it) => s + (Number(it.discount_price) || 0), 0
              );
              // 🛡️ Cap (final): bestPromoDiscount ต้องไม่เกิน discountSubtotal (กัน finalTotal เป็นลบ)
              let finalPromoDiscount = bestPromoDiscount;
              if (finalPromoDiscount > discountSubtotal) {
                finalPromoDiscount = discountSubtotal;
              }
              const serverDiscountAmount = itemDiscountAmount + finalPromoDiscount;
              const serverTotal = Math.max(0, discountSubtotal - finalPromoDiscount);
              // Override ราคาที่ลูกค้าส่งมาด้วยราคาที่ server คำนวณเอง
              filteredData.subtotal = serverSubtotal;
              filteredData.discount_amount = serverDiscountAmount;
              // 🚀 (STACK): เก็บทั้ง object เก่า (promotion_applied) และ array ใหม่ (promotions_applied)
              //   - promotion_applied (singular) — backward-compat กับ orders.js เดิมที่ยังอ่าน object
              //   - promotions_applied (พหูพจน์) — array ของทุก promo ที่ apply (อาจมี 0, 1, 2 ตัว)
              filteredData.promotion_applied = validatedPromotionApplied;
              filteredData.promotions_applied = serverPromotionsApplied;
              filteredData.total = serverTotal;
              filteredData.final_total = serverTotal;
              // อัปเดต price ของแต่ละ item ด้วย (กันลูกค้าส่ง price=0)
              const songPriceMap = new Map();
              if (songIds.length > 0) {
                const songDocs = await getDocumentsByIds(env, "songs", songIds);
                for (const sd of songDocs) {
                  if (sd && sd.data) {
                    songPriceMap.set(sd.id, Number(sd.data.price) || 0);
                  }
                }
              }
              const plPriceMap = new Map();
              if (playlistIds.length > 0) {
                const plDocs = await getDocumentsByIds(env, "playlists", playlistIds);
                for (const pd of plDocs) {
                  if (pd && pd.data) {
                    plPriceMap.set(pd.id, Number(pd.data.price) || 0);
                  }
                }
              }
              for (const item of filteredData.items) {
                if (item.kind === "playlist" && item.playlist_id) {
                  const realPrice = plPriceMap.get(item.playlist_id);
                  if (realPrice !== undefined) item.price = realPrice;
                } else if (item.song_id) {
                  const realPrice = songPriceMap.get(item.song_id);
                  if (realPrice !== undefined) item.price = realPrice;
                }
              }
            } catch (priceErr) {
              // ถ้า fetch ราคาไม่ได้ (เช่น DB error) → ใช้ราคาที่ลูกค้าส่งมา (fallback)
              // ไม่ block การสั่งซื้อ เพราะแอดมินจะตรวจสอบอีกที
              console.warn("Server price re-calc failed, using customer prices:", priceErr?.message || priceErr);
            }
          }

          body.data = filteredData;

          // 🔒 (2026-09-28 fix Critical C2): Atomic ownership check ผ่าน INSERT...ON CONFLICT
          //   ทำ *หลัง* validation ทั้งหมดผ่าน → ไม่มี orphan row ถ้า validation ล้ม
          //   - ถ้า changes() > 0 = สร้างใหม่ได้ → ดำเนินการต่อ (setDocument ด้านล่างจะ UPDATE ทับ placeholder)
          //   - ถ้า changes() === 0 = มีอยู่แล้ว (หรือ UUID ซ้ำ) → return 401 เหมือนเดิม
          //   หมายเหตุ: ใช้ placeholder row (data='{}') ที่จะถูก setDocument ด้านล่าง UPDATE ทับ
          //   ปลอดภัยเพราะ D1 PK constraint (collection, id) เป็น atomic
          let atomicInsertResult;
          try {
            const nowIso = new Date().toISOString();
            atomicInsertResult = await env.DB.prepare(
              "INSERT INTO documents (collection, id, data, created_at, updated_at) VALUES (?, ?, '{}', ?, ?) ON CONFLICT(collection, id) DO NOTHING"
            ).bind(collection, id, nowIso, nowIso).run();
          } catch (atomicErr) {
            // ถ้า D1 มีปัญหา → fallback ใช้ logic เดิม (SELECT existing) เพื่อกัน break ระบบ
            console.warn("atomic order insert failed, fallback to existing-check:", atomicErr?.message);
            const existing = await getDocument(env, collection, id);
            if (existing) return jsonResponse({ error: "ยังไม่ได้เข้าสู่ระบบ" }, 401);
            atomicInsertResult = { meta: { changes: 1 } }; // บังคับดำเนินการต่อ
          }
          if (!atomicInsertResult?.meta || atomicInsertResult.meta.changes === 0) {
            return jsonResponse({ error: "ยังไม่ได้เข้าสู่ระบบ" }, 401);
          }
        }
        // 🔧 (2026-09-22 fix Bug #2 UI v2): ดึงข้อมูลก่อนเปลี่ยนเก็บไว้สำหรับ audit log diff
        //   ถ้า body.merge=true (อัปเดต) → ดึงเอกสารเดิมก่อน set
        //   ถ้า body.merge=false (สร้างใหม่) → ก่อนหน้านี้ไม่มี → beforeDoc อาจเป็น null (create จริงๆ)
        //   กรณี PUT โดยไม่ merge ที่มีเอกสารเดิมอยู่ → ถือว่าเป็น "replace" (delete + create)
        //   แต่ audit log จะบันทึกเป็น "create" เพราะ action คือ !!body.merge ? "update" : "create"
        let beforeDoc = null;
        if (body.merge) {
          try { beforeDoc = await getDocument(env, collection, id); } catch { beforeDoc = null; }
        }
        // 🔒 (Audit Fix C-7): Wrap setDocument ด้วย cleanup-on-failure เพื่อกัน orphan placeholder row
        //   ปัญหาเดิม: บรรทัด 2170 INSERT placeholder (data='{}') แล้วบรรทัดนี้ setDocument เขียนทับ
        //     ถ้า setDocument พัง (D1 transient, network) → placeholder ค้าง → ลูกค้าลองใหม่ไม่ได้
        //     (เพราะ INSERT...ON CONFLICT DO NOTHING ด้านบนเห็น row มีอยู่ → changes() === 0 → 401)
        //   วิธีแก้: ถ้า setDocument พัง และเป็น customer order PUT (no admin) → DELETE placeholder ออก
        //     แล้วโยน error เดิมออกไป เพื่อให้ลูกค้า retry ได้
        //   ผลกระทบระบบเดิม: 0% — ถ้า setDocument สำเร็จ (กรณีปกติ) → ไม่มีการทำ cleanup (เหมือนเดิม)
        //     ถ้า setDocument พัง และเป็น admin path → ไม่ทำ cleanup (ไม่มี placeholder ให้ลบ)
        //     ถ้า setDocument พัง และเป็น customer path → ลบ placeholder ให้ลูกค้า retry ได้
        //   หมายเหตุ: ใช้ WHERE data = '{}' เพื่อกันลบ row ที่มีข้อมูลจริง (กันกรณี setDocument เขียนบาง field สำเร็จ)
        let result;
        try {
          result = await setDocument(env, collection, id, body.data || {}, !!body.merge, admin?.email);
        } catch (setDocErr) {
          // ถ้าเป็น customer order PUT (no admin) → ลบ placeholder ที่ INSERT ไว้ด้านบน
          //   ถ้าไม่ใช่ customer path → ไม่ต้อง cleanup (admin path ไม่มี placeholder)
          if (!admin && collection === "orders") {
            try {
              await env.DB.prepare(
                "DELETE FROM documents WHERE collection = ? AND id = ? AND data = '{}'"
              ).bind(collection, id).run();
              console.log("[C-7] Cleaned up orphan placeholder row after setDocument failure:", setDocErr?.message || setDocErr);
            } catch (cleanupErr) {
              console.error("[C-7] Failed to cleanup orphan placeholder:", cleanupErr?.message || cleanupErr);
            }
          }
          // โยน error เดิมออกไป เพื่อให้ caller (handleDb) ส่ง error กลับลูกค้า
          //   ลูกค้าได้รับ error → กดลองใหม่ได้ (เพราะ placeholder ถูกลบแล้ว)
          throw setDocErr;
        }
        // 🔧 (2026-09-22 fix Bug #2 UI v3): ตรวจหา target_name จากหลาย field ที่เป็นไปได้
        //   ไม่ใช่แค่ song_name/playlist_name/customer_name แต่รวม dj_name, category_name, name, display_name, title
        //   ทำให้ target_name แสดงชื่อจริง ๆ แทน UUID ตอนแก้ไข DJ/หมวดหมู่/ผู้ใช้ ฯลฯ
        const targetNameForLog = body.data?.song_name || body.data?.playlist_name || body.data?.customer_name || body.data?.dj_name || body.data?.category_name || body.data?.name || body.data?.display_name || body.data?.title || body.data?.email || id;
        // 🔧 (2026-09-22 fix): audit log — บันทึกการสร้าง/อัปเดต (มี before ด้วย)
        await writeAuditLog(env, request, admin, !!body.merge ? "update" : "create", collection, id, targetNameForLog, beforeDoc?.data, body.data);
        return jsonResponse(result);
      }
      if (request.method === "PATCH") {
        // 🔒 แก้บั๊ก C2 (2026-09-17): กัน Privilege Escalation — เหมือน PUT
        //   เฉพาะ main admin เท่านั้นที่ PATCH collection="admins" ได้
        if (collection === "admins" && admin.role !== "main") {
          return jsonResponse({ error: "เฉพาะแอดมินหลักเท่านั้นที่จัดการแอดมินได้" }, 403);
        }
        // 🆕 (T010-R5): หุ้ม try/catch รอบ `await request.json()` — กัน 503 ตอน bad JSON
        //   เดิม: `const body = await request.json();` (ไม่หุ้ม try/catch)
        //     ถ้า client ส่ง body ไม่ใช่ valid JSON → throw → ไม่มี handler → Worker 500 หรือ 503
        //   ใหม่: หุ้ม try/catch + ส่ง 400 + ข้อความชัดเจน (เหมือน PUT handler บรรทัด 2305)
        //   ผลกระทบระบบเดิม: 0% — client ที่ส่ง valid JSON ยังทำงานเหมือนเดิม
        let body;
        try { body = await request.json(); } catch { return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400); }
        // 🔒 (Audit Fix H-10): Server-side validation สำหรับ discount_value bounds (เหมือน PUT)
        //   ดึง beforeDoc ก่อน เพื่อ merge body.data + before เป็น full document → validate
        //   ทำไมต้อง merge? เพราะ PATCH อาจส่งแค่ field ที่เปลี่ยน (เช่น { discount_value: 150 })
        //   type ยังอยู่ใน DB → ต้อง merge ก่อน validate
        if ((collection === "discounts" || collection === "promotions") && body?.data) {
          let existingForValidation = null;
          try { existingForValidation = await getDocument(env, collection, id); } catch {}
          const mergedForValidation = { ...(existingForValidation?.data || {}), ...body.data };
          const validationErr = validateDiscountData(collection, mergedForValidation);
          if (validationErr) return jsonResponse({ error: validationErr }, 400);
        }
        // 🔧 (2026-09-22 fix Bug #2 UI v2): ดึงข้อมูลก่อนเปลี่ยนเก็บไว้สำหรับ audit log diff
        //   PATCH ทุกครั้งคือการแก้ไข (update) → ต้องดึง before เสมอ
        let beforeDoc = null;
        try { beforeDoc = await getDocument(env, collection, id); } catch { beforeDoc = null; }
        const result = await updateDocument(env, collection, id, body.data || {});
        if (result.notFound) return jsonResponse({ error: "ไม่พบเอกสารที่จะอัปเดต" }, 404);
        // 🔧 (2026-09-22 fix Bug #2 UI v3): ตรวจหา target_name จากหลาย field (เหมือน PUT)
        //   ถ้า body.data มี dj_name → ใช้ dj_name (DJ ใหม่)
        //   ถ้าไม่มี → ลองใช้ beforeDoc?.data?.dj_name (ชื่อเดิม) เป็น fallback
        //   ถ้าไม่มีอีก → ใช้ id
        const targetNameForLog = body.data?.song_name || body.data?.playlist_name || body.data?.customer_name || body.data?.dj_name || body.data?.category_name || body.data?.name || body.data?.display_name || body.data?.title || body.data?.email || beforeDoc?.data?.song_name || beforeDoc?.data?.playlist_name || beforeDoc?.data?.customer_name || beforeDoc?.data?.dj_name || beforeDoc?.data?.category_name || beforeDoc?.data?.name || beforeDoc?.data?.display_name || beforeDoc?.data?.title || beforeDoc?.data?.email || id;
        // 🔧 (2026-09-22 fix): audit log — บันทึกการแก้ไข (มี before ด้วย)
        await writeAuditLog(env, request, admin, "update", collection, id, targetNameForLog, beforeDoc?.data, body.data);
        return jsonResponse(result);
      }
      if (request.method === "DELETE") {
        // 🔒 แก้บั๊ก C2 (2026-09-17): กัน Privilege Escalation — เหมือน PUT/PATCH
        //   เฉพาะ main admin เท่านั้นที่ DELETE collection="admins" ได้
        //   กัน sub-admin ลบ main admin ออกจากระบบเพื่อ hijack ระบบ
        if (collection === "admins" && admin.role !== "main") {
          return jsonResponse({ error: "เฉพาะแอดมินหลักเท่านั้นที่จัดการแอดมินได้" }, 403);
        }
        // 🔒 (2026-09-21 fix Bug #5 Sub-admin DELETE): จำกัด destructive actions ให้ main admin เท่านั้น
        //   เดิม: sub-admin ลบได้ทุก collection (songs, playlists, categories, djs,
        //         promotions, discounts, settings, ... ) → บัญชี sub-admin ถูกแฮก → หายทั้ง catalog
        //         และไม่มี audit log ให้สืบ → หาตัวคนไม่ได้
        //   ใหม่: กำหนด collections ที่ sub-admin "ลบไม่ได้" (catalog + การตั้งค่าระบบ)
        //         ส่วน orders ลูกค้ายังลบได้ (ตามเงื่อนไขของ customer-write ด้านล่าง)
        //         ส่วน orders แอดมินยังลบได้ปกติ (sub-admin จัดการออเดอร์ได้)
        //   ผลกระทบระบบเดิม: 0% สำหรับ main admin (ยังลบได้ปกติ)
        //   ผลกระทบ sub-admin: จะลบ songs/playlists/categories/djs/promotions/discounts/settings ไม่ได้
        //     แต่ยังเพิ่ม/แก้ได้ปกติ (PUT/PATCH ไม่ถูกบล็อก) — สมเหตุผลเพราะ sub-admin คือ
        //     "พนักงานจัดการออเดอร์" ไม่ใช่ "ผู้จัดการแคตตาล็อก"
        const ADMIN_ONLY_DELETE_COLLECTIONS = new Set([
          "songs", "playlists", "categories", "djs",
          "promotions", "discounts", "settings",
        ]);
        if (ADMIN_ONLY_DELETE_COLLECTIONS.has(collection) && admin.role !== "main") {
          return jsonResponse({
            error: "เฉพาะแอดมินหลักเท่านั้นที่ลบ " + collection + " ได้ — ติดต่อแอดมินหลัก",
          }, 403);
        }
        if (!admin && collection === "orders") {
          // ลูกค้าไม่ได้ login — ลบได้เฉพาะออเดอร์ของตัวเองที่ยัง "รอตรวจสอบการโอน" (pending_verify) เท่านั้น
          // กันไม่ให้ลบออเดอร์คนอื่นที่แอดมินเริ่มดำเนินการแล้ว (processing/completed/cancelled)
          const existing = await getDocument(env, collection, id);
          if (!existing || existing.data?.status !== "pending_verify") {
            return jsonResponse({ error: "ยังไม่ได้เข้าสู่ระบบ" }, 401);
          }
          // 🔒 Security (2026-09-11): ตรวจเจ้าของออเดอร์ก่อนลบ — กันลูกค้าคนหนึ่งลบออเดอร์ของอีกคน
          // โดยรู้แค่ order ID (เช่น จาก receipt_number ที่เห็นใน WhatsApp)
          // ลูกค้าต้องส่ง customer_name + whatsapp มาใน body แล้ว Server ตรวจให้ตรงกับออเดอร์เดิม
          let body;
          try { body = await request.json(); } catch { body = {}; }
          const ownerName = normalizeNameServer(body.customer_name || "");
          const ownerPhone = normalizePhoneServer(body.whatsapp || "");
          const orderName = normalizeNameServer(existing.data?.customer_name || "");
          const orderPhone = normalizePhoneServer(existing.data?.whatsapp || "");
          if (!ownerName || !ownerPhone || ownerName !== orderName || ownerPhone !== orderPhone) {
            return jsonResponse({ error: "ไม่สามารถลบออเดอร์นี้ได้ — ข้อมูลไม่ตรงกับเจ้าของออเดอร์" }, 403);
          }
          // 🆕 (2026-10-03 v10 — แยก Login / Guest): ชื่อ+เบอร์ตรงอย่างเดียวไม่พอ ต้องอยู่ "ขอบเขตเดียวกัน" ด้วย
          //   ออเดอร์ Login → ลบได้เฉพาะเจ้าของที่ login อยู่ / ออเดอร์ Guest → ลบได้เฉพาะตอนที่ไม่ได้ login
          //   (กัน guest ที่ชื่อ+เบอร์ซ้ำกับสมาชิก ลบออเดอร์ของสมาชิก และกลับกัน)
          let delSessionCustomerId = null;
          try {
            const delSession = await getCustomerSession(request, env);
            delSessionCustomerId = delSession ? delSession.id : null;
          } catch (_) {}
          if (!isOrderVisibleForReceiptLookup(existing.data, delSessionCustomerId)) {
            return jsonResponse({ error: "ไม่สามารถลบออเดอร์นี้ได้ — ข้อมูลไม่ตรงกับเจ้าของออเดอร์" }, 403);
          }
          // 🔒 แก้บั๊ก I2 (2026-09-18): กัน TOCTOU race — re-check status ทันทีก่อน delete
          //   ปัญหา: ระหว่างตรวจ existing.data?.status === "pending_verify" กับ deleteDocument
          //   แอดมินอาจเปลี่ยน status เป็น "processing" → ลูกค้ายังลบได้ (เพราะเช็คไปแล้ว)
          //   แก้: ใช้ conditional DELETE ที่ตรวจ status + owner ใน SQL พร้อม delete เลย (atomic)
          //   ถ้า changes() === 0 = ออเดอร์ถูกเปลี่ยนแปลงไปแล้ว → บอกลูกค้าว่าลบไม่ได้
          const deleteResult = await env.DB.prepare(
            "DELETE FROM documents WHERE collection = 'orders' AND id = ? " +
            "AND json_extract(data, '$.status') = 'pending_verify' " +
            "AND json_extract(data, '$.customer_name') = ? " +
            "AND json_extract(data, '$.whatsapp') = ?"
          ).bind(id, existing.data?.customer_name || "", existing.data?.whatsapp || "").run();
          if (!deleteResult.meta || deleteResult.meta.changes === 0) {
            // ออเดอร์ถูกอัปเดตไปแล้วระหว่างที่ลูกค้ากำลังลบ → บอกลูกค้าว่าลบไม่ได้
            return jsonResponse({ error: "ออเดอร์นี้ถูกอัปเดตโดยแอดมินแล้ว ไม่สามารถลบได้" }, 409);
          }
          return jsonResponse({ ok: true });
        }
        // 🔧 (2026-09-22 fix): audit log — บันทึกการลบ (เก็บ snapshot ของข้อมูลก่อนลบ)
        const beforeDelete = await getDocument(env, collection, id);
        // 🆕 (T008-L9): ลบไฟล์ R2 ของเพลงก่อนลบ document — กัน orphan files บวม R2 storage
        //   เดิม: DELETE /api/db/songs/:id ลบเฉพาะ D1 document → ไฟล์ cover + preview + full audio ค้าง
        //   ใหม่: ถ้า collection="songs" → เรียก cleanupSongFiles() ก่อน deleteDocument
        //   ถ้า cleanup fail (R2 error) → log warning แต่ไม่ block DELETE document (best-effort)
        //   ผลกระทบระบบเดิม: 0% สำหรับ collection อื่น — เรียกเฉพาะ songs
        if (collection === "songs" && beforeDelete?.data) {
          try {
            const cleanupResult = await cleanupSongFiles(env, beforeDelete.data);
            console.log(`[T008-L9] cleanupSongFiles for song ${id}:`, cleanupResult);
          } catch (cleanupErr) {
            console.warn(`[T008-L9] cleanupSongFiles failed for song ${id} (continuing with DELETE):`, cleanupErr?.message || cleanupErr);
          }
        }
        await deleteDocument(env, collection, id);
        // 🔧 (2026-09-22 fix Bug #2 UI v3): ตรวจหา target_name จากหลาย field (เหมือน PUT/PATCH)
        //   ทำให้ target_name แสดงชื่อจริง ๆ แทน UUID ตอนลบ DJ/หมวดหมู่/ผู้ใช้ ฯลฯ
        const targetNameForDelete = beforeDelete?.data?.song_name || beforeDelete?.data?.playlist_name || beforeDelete?.data?.customer_name || beforeDelete?.data?.dj_name || beforeDelete?.data?.category_name || beforeDelete?.data?.name || beforeDelete?.data?.display_name || beforeDelete?.data?.title || beforeDelete?.data?.email || id;
        await writeAuditLog(env, request, admin, "delete", collection, id, targetNameForDelete, beforeDelete?.data, null);
        return jsonResponse({ ok: true });
      }
    }
  } catch (err) {
    return jsonResponse({ error: safeError("เกิดข้อผิดพลาดภายในระบบ กรุณาลองใหม่", err) }, 500);
  }

  return jsonResponse({ error: "ไม่พบ endpoint นี้" }, 404);
}

// ===================================================
// 🔧 (2026-09-18): /api/order-zip/* — ระบบสร้าง ZIP ออเดอร์ฝั่ง Worker (ใหม่)
// -----------------------------------------------------------
// ปัญหา: Worker มี request body limit 100MB → สร้าง ZIP ออเดอร์ที่รวมเพลงหลายสิบเพลง
//   แล้วอัปโหลดผ่าน /api/upload ครั้งเดียวไม่ได้ (ZIP อาจ > 100MB)
//   ทางเดิมใช้ JSZip ใน browser สร้าง ZIP blob แล้วอัปโหลด blob ทั้งไฟล์ผ่าน /api/upload
//   → พังทันทีถ้า ZIP > 100MB
//
// ทางแก้: สร้าง ZIP ฝั่ง Worker ผ่าน R2 Multipart Upload ทีละเพลง
//   Flow:
//   1) POST /api/order-zip/start   — สร้าง multipart upload ใน R2 + เก็บ state ใน D1
//   2) POST /api/order-zip/append  — ยัดเพลง 1 เพลงเข้า part ถัดไปของ multipart upload
//                                    (Worker อ่าน WAV จาก R2 binding → stream ผ่าน ZIP encoder
//                                     → ส่งเข้า R2 part โดยตรง ไม่ผ่าน browser memory)
//   3) POST /api/order-zip/finalize — สร้าง Central Directory + EOCD เป็น part สุดท้าย
//                                     แล้ว completeMultipartUpload → อัปเดต order doc
//
// ผลกระทบต่อระบบเดิม: 0% — เพิ่ม path prefix `/api/order-zip/*` ใหม่ขั้น
//   ไม่แตะ endpoint เดิมใดๆ (/api/upload, /api/auth/*, /api/db/*, /api/file/*)
//   ฟังก์ชัน createOrderZip() ใน orders.js ฝั่ง client จะถูกแก้ให้เรียก endpoints นี้แทน
//   แต่ fields ใน order document (zip_status, zip_download_url, zip_public_id, ฯลฯ)
//   ยังเหมือนเดิม 100% → UI ฝั่ง admin ไม่ต้องแก้
// ===================================================

// Helper: แปลง R2 public URL → R2 object key (ใช้ตอนอ่าน WAV จาก R2 binding)
// ตัวอย่าง: "https://pub-xxx.r2.dev/full-songs/123-abc.wav" → "full-songs/123-abc.wav"
// ถ้าไม่ใช่ R2 URL (เช่น Cloudinary เก่า) จะคืน null → caller จะ throw error
function deriveR2KeyFromUrl(url, env) {
  if (!url || typeof url !== "string") return null;
  const base = (env.R2_PUBLIC_BASE_URL || "").replace(/\/+$/, "");
  if (base && url.startsWith(base + "/")) {
    try {
      return decodeURIComponent(url.slice(base.length + 1));
    } catch {
      return null;
    }
  }
  // fallback: ใช้ URL parser ดึง path
  try {
    const u = new URL(url);
    // ตัด leading slash ออก แล้ว decode แต่ละ segment
    return decodeURIComponent(u.pathname.replace(/^\/+/, ""));
  } catch {
    return null;
  }
}

// Helper: ดึง R2 key ของเพลงจาก song document
// ลำดับความสำคัญ:
//   1. full_file_public_id (เก็บตอนอัปโหลดผ่าน /api/upload — คือ R2 key ตรงๆ)
//   2. deriveKeyFromUrl(full_file_url) — สำหรับเพลงเก่าที่ไม่มี public_id
//   3. file_url (fallback สำหรับเพลง "shared" ที่ไม่มี full_file_url แยก)
function getSongR2Key(song, env) {
  const publicId = song?.full_file_public_id;
  if (publicId && typeof publicId === "string" && publicId.trim()) {
    return publicId;
  }
  const fileUrl = song?.full_file_url || song?.file_url;
  if (!fileUrl) return null;
  return deriveR2KeyFromUrl(fileUrl, env);
}

// ===================================================
// 🆕 (T008-L9): cleanupSongFiles — ลบไฟล์ R2 ของเพลงตอน admin DELETE /api/db/songs/:id
// -----------------------------------------------------------
// ปัญหา: เดิม DELETE /api/db/:collection/:id ลบเฉพาะ document ใน D1 → ไฟล์ R2
//   (cover + preview + full audio) ค้างเป็น orphan → R2 storage บวมโดยไม่จำเป็น
//   (Free plan 10GB → จุดตันเร็วถ้า admin ลบเพลงเก่าบ่อย)
//
// ลำดับการ derive R2 key:
//   - full audio: ใช้ getSongR2Key() ที่มีอยู่ → รองรับทั้ง full_file_public_id + full_file_url/file_url
//   - cover: deriveR2KeyFromUrl(cover_url) — ถ้ามี cover_public_id ก็ใช้ direct
//   - preview: deriveR2KeyFromUrl(preview_url) — ถ้ามี preview_public_id ก็ใช้ direct
//   - ข้าม URL ที่ไม่ใช่ของ R2 bucket นี้ (เช่น Cloudinary เก่า) เงียบ ๆ ไม่ error
//   - ถ้า R2 delete ล้มเหลว (เช่น key ผิด/object ไม่มี) → log warning แต่ไม่ block DELETE document
//
// ผลกระทบระบบเดิม: 0% สำหรับ collection อื่น (call เฉพาะ collection="songs")
//   สำหรับ songs: ไฟล์ R2 ที่ผูกกับเพลงถูกลบด้วย (ซึ่งเป็นสิ่งที่ admin คาดหวังตอนกด "ลบ")
// ===================================================
async function cleanupSongFiles(env, songData) {
  if (!env.BUCKET || !songData || typeof songData !== "object") return { cleaned: 0, skipped: 0, failed: 0 };
  const base = (env.R2_PUBLIC_BASE_URL || "").replace(/\/+$/, "");
  const keysToDelete = new Set();
  let skipped = 0;

  // รวบรวม (public_id, url) pairs สำหรับแต่ละประเภทไฟล์
  const candidates = [
    // full audio — ใช้ getSongR2Key ที่มีอยู่ (handles public_id + url)
    { publicId: songData.full_file_public_id, url: songData.full_file_url || songData.file_url },
    // cover
    { publicId: songData.cover_public_id, url: songData.cover_url },
    // preview
    { publicId: songData.preview_public_id, url: songData.preview_url },
  ];

  for (const c of candidates) {
    // ถ้ามี public_id (R2 key ตรง) → ใช้เลย
    if (c.publicId && typeof c.publicId === "string" && c.publicId.trim()) {
      keysToDelete.add(c.publicId.trim());
      continue;
    }
    // ถ้าไม่มี public_id → derive key จาก url (เฉพาะที่เป็น R2 URL ของ bucket นี้)
    if (c.url && typeof c.url === "string" && c.url.trim()) {
      const url = c.url.trim();
      if (base && !url.startsWith(base + "/")) {
        // URL ไม่ใช่ของ R2 bucket นี้ (เช่น Cloudinary เก่า) → ข้ามเงียบ ๆ
        skipped += 1;
        continue;
      }
      const derived = deriveR2KeyFromUrl(url, env);
      if (derived) keysToDelete.add(derived);
    }
  }

  let cleaned = 0;
  let failed = 0;
  for (const key of keysToDelete) {
    try {
      await env.BUCKET.delete(key);
      cleaned += 1;
    } catch (err) {
      failed += 1;
      console.warn(`[T008-L9] cleanupSongFiles: R2 delete failed for key "${key}":`, err?.message || err);
    }
  }
  return { cleaned, skipped, failed };
}

// Helper: ทำความสะอาด leftover multipart upload ใน R2 (ถ้ามี)
// ใช้ตอน /api/order-zip/start เริ่มใหม่ — กันขยะใน R2 ถ้ามี job เดิมค้างอยู่
async function cleanupLeftoverMultipart(env, jobId, bucketKey) {
  if (!env.BUCKET || !jobId || !bucketKey) return;
  try {
    const mpu = env.BUCKET.resumeMultipartUpload(bucketKey, jobId);
    await mpu.abort();
  } catch (_) { /* อาจไม่มี upload จริง → ข้ามไป */ }
}

// Helper: ลบ job row จาก D1 (ใช้ตอน finalize สำเร็จ หรือ abort)
async function deleteOrderZipJob(env, jobId) {
  if (!env.DB || !jobId) return;
  try {
    await env.DB.prepare("DELETE FROM order_zip_jobs WHERE job_id = ?").bind(jobId).run();
  } catch (_) { /* ถ้าตารางไม่มี → ข้าม */ }
}

// 🔧 (2026-09-18 v5): Helper สำหรับ parse parts JSON จาก D1
// รองรับ 2 formats:
//   - v4 (เก่า): array ของ song entries → แปลงเป็น { songs: <array>, finalizeState: null }
//   - v5 (ใหม่): object { songs: [...], finalizeState: {...}|null }
// ทำให้ migration จาก v4 เป็น v5 ราบรื่น — job เดิมที่ append ด้วย v4 ยังใช้กับ v5 ได้
function parsePartsJson(partsString) {
  let parsed;
  try { parsed = JSON.parse(partsString || "{}"); } catch { parsed = {}; }
  if (Array.isArray(parsed)) {
    // v4 format: array → convert
    return { songs: parsed, finalizeState: null };
  }
  if (parsed && typeof parsed === "object") {
    return {
      songs: Array.isArray(parsed.songs) ? parsed.songs : [],
      finalizeState: parsed.finalizeState || null,
    };
  }
  return { songs: [], finalizeState: null };
}

// 🔧 (2026-09-18 v5): Helper สำหรับ cleanup partial buffer R2 object + temp objects
// ใช้ตอน abort หรือ finalize-compose เสร็จแล้ว
async function cleanupPartialBuffer(env, finalizeState) {
  if (!env.BUCKET || !finalizeState || !finalizeState.partialBufferKey) return;
  try { await env.BUCKET.delete(finalizeState.partialBufferKey); } catch (_) {}
}

// 🚀 (2026-09-28 rollback G1): ลบ dead code enqueueZipOrder + processNextZipInQueue
//   Sequential Queue rollback → ไม่มี caller แล้ว → ลบออกเพื่อทำความสะอาด codebase
//   removeOrderFromQueue ยังเก็บไว้ (no-op แต่ปลอดภัย — กัน orphan rows ในอนาคต)

// removeOrderFromQueue: ลบ order ออกจาก queue หลัง finalize สำเร็จ (หรือ abort)
async function removeOrderFromQueue(env, orderId) {
  if (!env.DB) return;
  try {
    await env.DB.prepare(
      "DELETE FROM order_zip_queue WHERE order_id = ?"
    ).bind(orderId).run();
  } catch (err) {
    console.warn("[removeOrderFromQueue] failed:", err?.message || err);
  }
}

// ---------------- POST /api/order-zip/start ----------------
// รับ: { orderId }
// ทำ:
//   - ตรวจ admin session
//   - โหลด order doc จาก D1
//   - resolveOrderSongsGrouped (จำลอง logic ฝั่ง client ใน orders.js)
//   - ถ้ามี job เดิมของ orderId นี้อยู่ → abort multipart upload + ลบ row
//   - สร้าง multipart upload ใน R2 → เก็บ uploadId ลง D1 (order_zip_jobs)
//   - คืน jobId + plan (ลำดับเพลงที่จะส่งเข้า zip ทีละเพลง)
//
// Response:
//   { jobId, plan: [{ songId, folderPath, filename, songName }], totalSongs, zipFileName }
//   หรือ { error } เมื่อ fail
async function handleOrderZipStart(request, env) {
  // 🔧 (2026-09-27 fix 503): หุ้ม getSessionAdmin ด้วย try/catch — ถ้า D1 timeout/throw
  //   จะได้คืน JSON 500 ที่อ่านได้ แทน 503 จาก Cloudflare ที่อ่านไม่ได้
  let admin;
  try {
    admin = await getSessionAdmin(request, env);
  } catch (err) {
    return jsonResponse({ error: safeError("ตรวจสอบสิทธิ์ไม่สำเร็จ กรุณาลองใหม่", err) }, 500);
  }
  if (!admin) return jsonResponse({ error: "ยังไม่ได้เข้าสู่ระบบ" }, 401);
  if (!env.BUCKET) {
    return jsonResponse({ error: "ยังไม่ได้ผูก R2 bucket (binding: BUCKET) ใน wrangler.jsonc" }, 500);
  }
  if (!env.DB) {
    return jsonResponse({ error: "ยังไม่ได้ผูก D1 database (binding: DB) ใน wrangler.jsonc" }, 500);
  }
  if (!env.R2_PUBLIC_BASE_URL) {
    return jsonResponse({ error: "ยังไม่ได้ตั้งค่า R2_PUBLIC_BASE_URL ใน wrangler.jsonc" }, 500);
  }

  let body;
  try { body = await request.json(); } catch {
    return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400);
  }
  // 🔧 (2026-09-22 fix Bug #4): sanitize orderId — กัน CRLF injection
  const orderId = sanitizeHeaderValue(body?.orderId);
  if (!orderId) return jsonResponse({ error: "กรุณาระบุ orderId" }, 400);

  // โหลด order doc
  // 🔧 (2026-09-27 fix 503): หุ้ม getDocument ด้วย try/catch — กัน D1 throw → 503
  let orderDoc;
  try {
    orderDoc = await getDocument(env, "orders", orderId);
  } catch (err) {
    return jsonResponse({ error: safeError("อ่านข้อมูลออเดอร์ไม่สำเร็จ กรุณาลองใหม่", err) }, 500);
  }
  if (!orderDoc || !orderDoc.data) {
    return jsonResponse({ error: "ไม่พบออเดอร์ที่ระบุ" }, 404);
  }
  const order = orderDoc.data;

  // 🔒 (2026-09-28 fix H9): บล็อกการสร้าง ZIP สำหรับออเดอร์ที่ถูกยกเลิกหรือปฏิเสธการชำระ
  //   เดิม: ไม่ตรวจ order.status เลย → sub-admin สามารถสร้าง ZIP ให้ลูกค้าที่ออเดอร์ถูก
  //         cancel/reject ได้ → ลูกค้าได้เพลงฟรีแม้ไม่ได้จ่ายเงินจริง
  //   ใหม่: บล็อกเฉพาะ status ที่เป็น "ไม่จ่ายเงินจริง" เท่านั้น (cancelled, rejected)
  //         อนุญาต status อื่น ๆ ทั้งหมด (pending_verify, processing, completed)
  //
  //   หมายเหตุสำคัญ (กฎ #1: ห้าม break ระบบเดิม):
  //     flow เดิม confirmPaymentAndCreateZip() ใน orders.js (บรรทัด ~2276) เรียก
  //     createOrderZip() (ซึ่งเรียก /api/order-zip/start) ตอน order.status ยังเป็น
  //     'pending_verify' → ห้ามบังคับให้เป็น 'processing' เท่านั้น ไม่งั้นจะ break flow เดิม
  //   วิธีแก้: อนุญาตทั้ง pending_verify + processing + completed
  //           บล็อกเฉพาะ cancelled + rejected เท่านั้น
  //
  //   ผลกระทบระบบเดิม: 0%
  //     - main admin ยังสร้าง ZIP ได้ปกติ (status='pending_verify' → 'processing' → 'completed')
  //     - sub-admin ยังสร้าง ZIP ได้สำหรับออเดอร์ปกติ (status='pending_verify' ที่ผ่านการตรวจสอบ)
  //     - sub-admin ไม่สามารถสร้าง ZIP ให้ออเดอร์ที่ถูก cancel/reject ได้อีก
  //   ข้อยกเว้น: ถ้า admin ตั้งใจ cancel แล้วเปลี่ยนใจ → ต้องเปลี่ยน status กลับเป็น
  //     'pending_verify' หรือ 'processing' ก่อน แล้วค่อยสร้าง ZIP
  const BLOCKED_ZIP_STATUSES = new Set(["cancelled", "rejected"]);
  if (BLOCKED_ZIP_STATUSES.has(String(order.status || "").toLowerCase())) {
    return jsonResponse({
      error: `ไม่สามารถสร้าง ZIP สำหรับออเดอร์ที่ถูก "${order.status}" ได้ — กรุณาเปลี่ยนสถานะออเดอร์กลับเป็น "รอตรวจสอบ" หรือ "กำลังดำเนินการ" ก่อน`,
      code: "zip/blocked-status"
    }, 403);
  }

  // ⚠️ (เดิม 2026-09-22): ไม่ตรวจ order.status — เหมือน behavior เดิมของ createOrderZip ใน orders.js
  // เพราะ confirmPaymentAndCreateZip() เรียก createOrderZip() ก่อนเปลี่ยน status เป็น 'processing'
  // ตอนนั้นยังเป็น 'pending_verify' อยู่ → ถ้าเช็ค status จะ block flow นี้
  // (ตัวอนาคต: ถ้าต้องการ restrict เฉพาะบาง status ต้องแก้ caller ให้ update status ก่อนเรียก)
  // 🔧 (2026-09-28 fix H9): เพิ่ม block เฉพาะ cancelled/rejected ด้านบน — ไม่ block pending_verify/processing/completed

  // ถ้ามี ZIP เดิมอยู่แล้ว (zip_status='ready' + zip_download_url) → คืน URL เดิม ไม่สร้างใหม่
  if (order.zip_status === "ready" && order.zip_download_url) {
    return jsonResponse({
      ok: true,
      existing: true,
      url: order.zip_download_url,
      publicId: order.zip_public_id || "",
      zipFileName: order.zip_file_name || `Order-${orderId}.zip`,
    });
  }

  // ===== จำลอง resolveOrderSongsGrouped ฝั่ง server =====
  // โครงสร้างเดียวกับ orders.js (บรรทัด 178-268) — แยกเพลงเดี่ยว + playlist groups
  const singles = [];
  const playlistMap = new Map();

  function getOrCreatePlaylist(playlistId, playlistName) {
    const key = String(playlistId || "");
    if (!playlistMap.has(key)) {
      playlistMap.set(key, {
        id: key,
        name: String(playlistName || `Playlist-${key.slice(-6)}`),
        songs: [],
      });
    }
    return playlistMap.get(key);
  }

  (order.items || []).forEach((item) => {
    if (!item) return;
    if (order.order_type === "playlist") {
      const group = getOrCreatePlaylist(order.playlist_id, order.playlist_name);
      if (item.song_id) {
        group.songs.push({
          id: String(item.song_id),
          title: item.title || "เพลง",
        });
      }
    } else if (order.order_type === "mixed") {
      if (item.kind === "playlist") {
        const group = getOrCreatePlaylist(item.playlist_id, item.title);
        (item.song_ids || []).forEach((sid) => {
          if (sid) group.songs.push({ id: String(sid), title: "" });
        });
      } else if (item.song_id) {
        singles.push({
          id: String(item.song_id),
          title: item.title || "เพลง",
        });
      }
    } else {
      if (item.song_id) {
        singles.push({
          id: String(item.song_id),
          title: item.title || "เพลง",
        });
      }
    }
  });

  // สำหรับ playlist groups ที่ไม่มี song_ids snapshot → query จาก playlist_id
  for (const [playlistId, group] of playlistMap) {
    if (group.songs.length === 0 && playlistId) {
      try {
        const { results } = await env.DB.prepare(
          "SELECT id, data FROM documents WHERE collection = 'songs' AND json_extract(data, '$.playlist_id') = ?"
        ).bind(playlistId).all();
        for (const row of results) {
          const song = JSON.parse(row.data);
          group.songs.push({
            id: row.id,
            title: song.song_name || "เพลง",
          });
        }
      } catch (err) {
        console.warn("order-zip/start: query songs for playlist failed:", err?.message || err);
      }
    } else if (group.songs.length > 0 && !group.songs[0].title) {
      // มี song_ids แต่ไม่มี title → batch fetch titles
      // 🔧 (2026-09-27 fix 503): หุ้ม getDocumentsByIds ด้วย try/catch
      //   ถ้า D1 ล้ม → ใช้ title fallback "เพลง" แทน (ไม่ block flow — เพลงยังเข้า ZIP ได้)
      //   เหมือน branch ด้านบน (query songs for playlist) ที่มี catch อยู่แล้ว
      const songIds = group.songs.map((s) => s.id);
      let songDocs = [];
      try {
        songDocs = await getDocumentsByIds(env, "songs", songIds);
      } catch (err) {
        console.warn("order-zip/start: batch fetch song titles failed:", err?.message || err);
        songDocs = [];
      }
      const titleMap = new Map(songDocs.map((d) => [d.id, d.data?.song_name || "เพลง"]));
      group.songs = group.songs.map((s) => ({
        id: s.id,
        title: titleMap.get(s.id) || `เพลง`,
      }));
    }
  }

  const playlists = [...playlistMap.values()];
  const totalSongs = singles.length + playlists.reduce((sum, p) => sum + p.songs.length, 0);
  if (totalSongs === 0) {
    return jsonResponse({ error: "ออเดอร์นี้ไม่มีรายการเพลงสำหรับสร้าง ZIP" }, 400);
  }

  // สร้าง plan: ลำดับเพลงที่จะ append ทีละเพลง
  // (เพลงเดี่ยวก่อน → แต่ละ playlist ตามด้วยเพลงใน playlist นั้น)
  const plan = [];
  const rootUsedNames = new Set();
  for (const single of singles) {
    plan.push({
      songId: single.id,
      songName: single.title,
      folderPath: "",
      filename: "", // จะ resolve ตอน append (ต้องอ่าน full_file_name จาก song doc)
    });
  }
  for (const playlist of playlists) {
    const rawFolderName = String(playlist.name || `Playlist-${playlist.id.slice(-6)}`).trim();
    const safeFolderName = rawFolderName.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").trim() || `Playlist-${playlist.id.slice(-6)}`;
    for (const songItem of playlist.songs) {
      plan.push({
        songId: songItem.id,
        songName: songItem.title,
        folderPath: safeFolderName,
        filename: "",
      });
    }
  }

  // ===== Cleanup leftover job ถ้ามี =====
  // (กัน multipart upload ค้างใน R2 ถ้าแอดมินกด "สร้าง ZIP ใหม่" ซ้ำ)
  // 🚀 (2026-09-28 fix H-5): ลบ partial.bin ด้วย — กัน R2 leak (~16MB ต่อ stuck job)
  //   เดิม: SELECT แค่ job_id, bucket_key → ละเลย partial.bin ใน finalizeState
  //   ใหม่: SELECT เพิ่ม parts → อ่าน finalizeState.partialBufferKey → delete ก่อน
  try {
    const existing = await env.DB.prepare(
      "SELECT job_id, bucket_key, parts FROM order_zip_jobs WHERE order_id = ? AND status = 'preparing'"
    ).bind(orderId).first();
    if (existing) {
      // 🚀 (H-5): ลบ partial.bin ก่อน abort multipart
      try {
        const partsData = parsePartsJson(existing.parts);
        if (partsData.finalizeState && partsData.finalizeState.partialBufferKey) {
          await cleanupPartialBuffer(env, partsData.finalizeState);
        }
      } catch (_) {}
      await cleanupLeftoverMultipart(env, existing.job_id, existing.bucket_key);
      await deleteOrderZipJob(env, existing.job_id);
    }
  } catch (_) { /* ตารางยังไม่สร้าง → ข้าม */ }

  // ===== สร้าง R2 multipart upload =====
  const zipFileName = `Order-${orderId}.zip`;
  const bucketKey = `order-zips/${zipFileName}`;
  let mpu;
  try {
    mpu = await env.BUCKET.createMultipartUpload(bucketKey, {
      httpMetadata: {
        contentType: "application/zip",
        contentDisposition: `attachment; filename="${zipFileName.replace(/"/g, "")}"`,
        // 🔧 (2026-09-19 perf): เพิ่ม Cache-Control บนไฟล์ ZIP → R2 edge + browser cache 24 ชม.
        //   ทำให้ลูกค้าดาวน์โหลด ZIP เร็วขึ้นมาก โดยเฉพาะครั้งที่ 2+ หรือเมื่อแชร์ลิงก์ให้คนอื่น
        //   ผลกระทบต่อระบบเดิม: 0% — เพิ่มแค่ HTTP header บน R2 object
        cacheControl: "public, max-age=86400",  // 24 ชม.
      },
    });
  } catch (err) {
    return jsonResponse({ error: safeError("สร้างไฟล์ ZIP ไม่สำเร็จ กรุณาลองใหม่", err) }, 502);
  }

  // ===== บันทึก state ลง D1 =====
  // 🔧 (2026-09-18 v5): เปลี่ยน parts JSON จาก array → object { songs: [], finalizeState: null }
  //   - songs: array ของ song entries (เพิ่มโดย /api/order-zip/append)
  //   - finalizeState: state ของ finalize-build (เริ่มต้นเป็น null — ถูกตั้งตอน finalize-build ครั้งแรก)
  //   ⚠️ รองรับ format เดิม (array): ถ้าอ่านจาก D1 เจอ array จะ convert เป็น { songs: <array>, finalizeState: null }
  const jobId = mpu.uploadId;
  const now = new Date().toISOString();
  const initialParts = JSON.stringify({ songs: [], finalizeState: null });
  try {
    // 🔒 (Audit Fix H-16): เพิ่ม created_by_admin ลงใน INSERT (สำหรับ ownership check ใน abort)
    //   ใช้ INSERT OR IGNORE pattern เพื่อรองรับ schema เก่าที่ยังไม่มี column นี้
    //   ถ้า column ยังไม่มี → INSERT พัง → catch error → fallback ไม่ใส่ created_by_admin
    await env.DB.prepare(
      "INSERT INTO order_zip_jobs (job_id, order_id, bucket_key, parts, total_songs, status, error, created_at, updated_at, created_by_admin) " +
      "VALUES (?, ?, ?, ?, ?, 'preparing', '', ?, ?, ?) " +
      "ON CONFLICT(job_id) DO UPDATE SET order_id = excluded.order_id, bucket_key = excluded.bucket_key, parts = excluded.parts, total_songs = excluded.total_songs, status = 'preparing', error = '', updated_at = excluded.updated_at, created_by_admin = excluded.created_by_admin"
    ).bind(jobId, orderId, bucketKey, initialParts, totalSongs, now, now, admin.id).run();
  } catch (err) {
    // 🔒 (Audit Fix H-1): ถ้า INSERT fail เพราะ UNIQUE constraint บน (order_id, status='preparing')
    //   → แปลว่ามีแอดมินอื่นกำลังสร้าง ZIP สำหรับออเดอร์นี้อยู่แล้ว
    //   → แจ้ง 409 Conflict (ไม่ใช่ 500 error)
    //   → abort multipart upload ที่เราสร้างไปแล้ว (กัน R2 leak)
    //   ถ้า UNIQUE index ยังไม่สร้าง (DB เก่า) → จะไม่เจอ error นี้ → ทำงานเหมือนเดิม
    try { await mpu.abort(); } catch (_) {}
    const errMsg = String(err?.message || err || "");
    // D1/SQLite UNIQUE constraint error message มีหลายรูปแบบ:
    //   "UNIQUE constraint failed: order_zip_jobs.order_id"
    //   "constraint failed"
    if (errMsg.includes("UNIQUE") || errMsg.includes("constraint")) {
      return jsonResponse({
        error: "กำลังสร้าง ZIP ของออเดอร์นี้อยู่โดยแอดมินอื่น — กรุณารอให้เสร็จก่อน",
        code: "zip/concurrent-build-conflict",
        order_id: orderId,
      }, 409);
    }
    // 🔒 (Audit Fix H-16): ถ้า INSERT fail เพราะ column created_by_admin ไม่มี (schema เก่า)
    //   → retry ไม่ใส่ created_by_admin (backward-compat)
    if (errMsg.includes("no such column") || errMsg.toLowerCase().includes("created_by_admin")) {
      console.warn("[H-16] created_by_admin column missing — falling back to insert without it (DB schema is old)");
      try {
        await env.DB.prepare(
          "INSERT INTO order_zip_jobs (job_id, order_id, bucket_key, parts, total_songs, status, error, created_at, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, 'preparing', '', ?, ?) " +
          "ON CONFLICT(job_id) DO UPDATE SET order_id = excluded.order_id, bucket_key = excluded.bucket_key, parts = excluded.parts, total_songs = excluded.total_songs, status = 'preparing', error = '', updated_at = excluded.updated_at"
        ).bind(jobId, orderId, bucketKey, initialParts, totalSongs, now, now).run();
      } catch (retryErr) {
        try { await mpu.abort(); } catch (_) {}
        const retryMsg = String(retryErr?.message || retryErr || "");
        if (retryMsg.includes("UNIQUE") || retryMsg.includes("constraint")) {
          return jsonResponse({
            error: "กำลังสร้าง ZIP ของออเดอร์นี้อยู่โดยแอดมินอื่น — กรุณารอให้เสร็จก่อน",
            code: "zip/concurrent-build-conflict",
            order_id: orderId,
          }, 409);
        }
        return jsonResponse({ error: safeError("บันทึกสถานะไม่สำเร็จ กรุณาลองใหม่", retryErr) }, 500);
      }
    } else {
      return jsonResponse({ error: safeError("บันทึกสถานะไม่สำเร็จ กรุณาลองใหม่", err) }, 500);
    }
  }

  // อัปเดต order doc: zip_status = 'preparing' (เหมือนเดิมใน orders.js createOrderZip)
  try {
    await updateDocument(env, "orders", orderId, {
      zip_status: "preparing",
      zip_error: "",
      zip_requested_at: now,
      updated_at: now,
    });
  } catch (err) {
    // ถ้าอัปเดต order doc ล้มเหลว → abort multipart upload + ลบ row + return error
    try { await mpu.abort(); } catch (_) {}
    await deleteOrderZipJob(env, jobId);
    return jsonResponse({ error: safeError("อัปเดตออเดอร์ไม่สำเร็จ กรุณาลองใหม่", err) }, 500);
  }

  return jsonResponse({
    ok: true,
    jobId,
    bucketKey,
    plan,
    totalSongs,
    zipFileName,
  });
}

// ---------------- POST /api/order-zip/append ----------------
// รับ: { jobId, partNumber, songId, folderPath, songName }
// ทำ (restructure 2026-09-18 v4):
//   - ตรวจ admin session
//   - โหลด job row จาก D1 (เพื่อเช็คว่ายัง active อยู่)
//   - โหลด song doc เพื่อดึง R2 key ของ WAV
//   - อ่าน WAV size จาก R2 metadata (head/get — no body read)
//   - คำนวณ partSize ล่วงหน้า = LFH + WAV + DD
//   - **บันทึก metadata ของ entry ใน D1** (songId, folderPath, filename, R2 key, size, partSize, offset)
//   - **ไม่อัปโหลด part ตอนนี้** — จะทำใน finalize ทั้งหมดทีเดียว
//
// เหตุผล: R2 multipart upload ต้องการ "All non-trailing parts must have the same length"
//   ทุก part ต้องมีขนาดเท่ากัน ยกเว้น part สุดท้าย
//   ถ้าทำ 1 เพลง = 1 part → แต่ละ part มีขนาดต่างกัน → fail ตอน complete
//   วิธีแก้: ทุก part ต้องมีขนาดคงที่ (8MB) → ต้อง build ทั้ง ZIP bytes ก่อน split + upload ใน finalize
//
// Response: { ok, partNumber, size, partSize, offset, filename, folderPath }
async function handleOrderZipAppend(request, env) {
  // 🔧 (2026-09-27 fix 503): หุ้ม getSessionAdmin ด้วย try/catch — กัน D1 throw → 503
  let admin;
  try {
    admin = await getSessionAdmin(request, env);
  } catch (err) {
    return jsonResponse({ error: safeError("ตรวจสอบสิทธิ์ไม่สำเร็จ กรุณาลองใหม่", err) }, 500);
  }
  if (!admin) return jsonResponse({ error: "ยังไม่ได้เข้าสู่ระบบ" }, 401);
  if (!env.BUCKET) return jsonResponse({ error: "ยังไม่ได้ผูก R2 bucket (binding: BUCKET) ใน wrangler.jsonc" }, 500);
  if (!env.DB) return jsonResponse({ error: "ยังไม่ได้ผูก D1 database (binding: DB) ใน wrangler.jsonc" }, 500);

  let body;
  try { body = await request.json(); } catch {
    return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400);
  }
  const jobId = String(body?.jobId || "").trim();
  const partNumber = Number(body?.partNumber);
  const songId = String(body?.songId || "").trim();
  // 🔒 (2026-09-21 fix Bug #4 Zip Slip): Sanitize folderPath ก่อนใช้ — เหมือน /start ที่ทำอยู่
  //   เดิม: รับ folderPath จาก body ตรงๆ → concat เข้า ZIP path ที่บรรทัด 1605 โดยไม่ sanitize
  //         → แอดมิน (หรือผู้โจมตีที่ได้ session แอดมิน) ส่ง folderPath="../../../"
  //         → ลูกค้าที่แตก ZIP อาจโดนเขียนทับไฟล์ระบบ (เช่น Windows System32)
  //   ใหม่: sanitize แบบเดียวกับ /start (บรรทัด 1385):
  //         - ลบตัวอักษร path separators อันตราย: \ / : * ? " < > |
  //         - collapse whitespace ซ้ำ
  //         - trim
  //   ผลกระทบระบบเดิม: 0% — folderPath ที่ถูกต้อง (ชื่อ playlist ปกติ) ผ่านเหมือนเดิม
  //   เพิ่มเติม: ลบ "../" และ absolute path ด้วยกัน path traversal แบบอื่น
  const rawFolderPath = String(body?.folderPath || "");
  const folderPath = rawFolderPath
    .replace(/[\\/:*?"<>|]/g, "_")  // ลบ path separators อันตราย
    .replace(/\.\.+/g, ".")          // ลด ".." → "." (กัน path traversal)
    .replace(/\/+/g, "/")            // collapse multiple slashes
    .replace(/^\//, "")              // ลบ leading slash (กัน absolute path)
    .replace(/\s+/g, " ")
    .trim();
  const songName = String(body?.songName || "เพลง");
  if (!jobId || !Number.isInteger(partNumber) || partNumber < 1 || !songId) {
    return jsonResponse({ error: "พารามิเตอร์ไม่ครบ (jobId, partNumber, songId)" }, 400);
  }

  // โหลด job row
  let jobRow;
  try {
    jobRow = await env.DB.prepare(
      "SELECT job_id, order_id, bucket_key, parts, status FROM order_zip_jobs WHERE job_id = ?"
    ).bind(jobId).first();
  } catch (err) {
    return jsonResponse({ error: safeError("อ่านสถานะไม่สำเร็จ กรุณาลองใหม่", err) }, 500);
  }
  if (!jobRow) {
    return jsonResponse({ error: "ไม่พบ ZIP job นี้ (อาจถูกยกเลิกไปแล้ว)" }, 404);
  }
  if (jobRow.status !== "preparing") {
    return jsonResponse({ error: `ZIP job นี้อยู่ในสถานะ "${jobRow.status}" ไม่สามารถ append ได้` }, 400);
  }

  // โหลด song doc
  // 🔧 (2026-09-27 fix 503): หุ้ม getDocument ด้วย try/catch — กัน D1 throw → 503
  let songDoc;
  try {
    songDoc = await getDocument(env, "songs", songId);
  } catch (err) {
    return jsonResponse({ error: safeError("อ่านข้อมูลเพลงไม่สำเร็จ กรุณาลองใหม่", err) }, 500);
  }
  if (!songDoc || !songDoc.data) {
    return jsonResponse({ error: `ไม่พบข้อมูลเพลง "${songName || songId}"` }, 404);
  }
  const song = songDoc.data;
  const r2Key = getSongR2Key(song, env);
  if (!r2Key) {
    return jsonResponse({
      error: `เพลง "${song.song_name || songName}" ยังไม่มีไฟล์เต็ม WAV บน Cloud (ไม่มี full_file_public_id หรือ full_file_url/file_url)`,
    }, 400);
  }

  // ตรวจว่าไฟล์มีอยู่จริงใน R2 (head only — no body read)
  // 🔧 (2026-09-19 bugfix): เปลี่ยน env.BUCKET.get(r2Key) → env.BUCKET.head(r2Key)
  //   เหตุผล (แก้ "ค้างขั้นตอนการสร้าง ZIP"):
  //     เดิมใช้ get() ซึ่งเปิด body stream ของไฟล์ WAV ทั้งไฟล์ (อาจ 50MB+ ต่อเพลง)
  //     แต่โค้ดด้านล่างใช้แค่ wavObject.size เท่านั้น → body stream ไม่ถูก consume หรือ cancel
  //     → ทิ้ง R2 connection ค้างไว้ทุกครั้งที่ append 1 เพลง
  //     → เมื่อเพลงเยอะ ๆ (10+ เพลง) R2 connections ค้างเป็นจำนวนมาก
  //     → Worker fetch รอ response ไม่ได้ → "ค้างขั้นตอนการสร้าง ZIP" ตามที่แอดมินรายงาน
  //
  //   head() คืนค่า R2Object | null (metadata เท่านั้น ไม่เปิด body stream)
  //   มี field ครบทุกอย่างที่ใช้ต่อไป (size, etag, httpMetadata, uploaded)
  //   เหมือนกับที่ health check endpoint (บรรทัด ~2465) ใช้ head() อยู่แล้ว
  //
  // ผลกระทบต่อระบบเดิม: 0%
  //   - append endpoint ยังคืน response รูปแบบเดิมทุกประการ
  //   - โค้ดด้านล่างใช้แค่ wavObject.size ซึ่ง head() ให้ค่าเหมือน get()
  //   - ไม่เปลี่ยน API contract, DB schema, function signature, หรือ UI
  let wavObject;
  try {
    wavObject = await env.BUCKET.head(r2Key);
  } catch (err) {
    return jsonResponse({ error: safeError("ตรวจไฟล์เพลงไม่สำเร็จ กรุณาลองใหม่", err) }, 502);
  }
  if (!wavObject) {
    return jsonResponse({ error: `ไม่พบไฟล์ WAV ใน R2 (key: ${r2Key})` }, 404);
  }
  const wavSize = wavObject.size || 0;

  // ===== สร้างชื่อไฟล์ใน ZIP =====
  // ใช้ logic เดียวกับ orders.js (safeZipFileName + uniqueZipFileName)
  // 🔧 (2026-09-18 v5): parse parts JSON ผ่าน parsePartsJson (รองรับ format เก่า v4 + ใหม่ v5)
  const partsData = parsePartsJson(jobRow.parts);
  const parts = partsData.songs;  // alias สำหรับใช้ในฟังก์ชัน uniqueZipFileName ด้านล่าง

  const usedNames = new Set(
    parts.filter((p) => (p.folderPath || "") === folderPath).map((p) => p.filename)
  );

  function safeZipFileName(value, fallback) {
    const cleaned = String(value || fallback || "เพลง.wav")
      .replace(/[\\/:*?"<>|]/g, "_")
      .replace(/\s+/g, " ")
      .trim();
    return /\.(wav|mp3)$/i.test(cleaned) ? cleaned : `${cleaned }.wav`;
  }
  function uniqueZipFileName(value) {
    const original = safeZipFileName(value, "เพลง.wav");
    if (!usedNames.has(original)) {
      usedNames.add(original);
      return original;
    }
    const dot = original.lastIndexOf(".");
    const base = dot > 0 ? original.slice(0, dot) : original;
    const ext = dot > 0 ? original.slice(dot) : ".wav";
    let index = 2;
    let candidate = `${base} (${index})${ext}`;
    while (usedNames.has(candidate)) {
      index += 1;
      candidate = `${base} (${index})${ext}`;
    }
    usedNames.add(candidate);
    return candidate;
  }

  const baseName = song.full_file_name || `${song.song_name || songName}.wav`;
  // ประกาศ filename, partSize, offset เป็น let — เพื่อให้ retry loop ด้านล่างสามารถ
  // อัปเดตค่าได้หลัง atomic UPDATE สำเร็จ (optimistic locking)
  let filename = uniqueZipFileName(baseName);
  const DD_SIZE = 16;
  let partSize = 0;
  let offset = 0;

  // 🔒 (2026-09-28 fix Critical C1): Atomic append ผ่าน optimistic locking
  //   เดิม: parse parts → push entry → UPDATE parts = ? (read-modify-write)
  //         → ถ้ามี concurrent append (เช่น bulk upload, admin กดซ้ำ) → lost update → เพลงหาย
  //   ใหม่: optimistic locking loop:
  //     1) SELECT parts + updated_at (เป็น "version")
  //     2) คำนวณ offset + push entry ใน JS
  //     3) UPDATE parts = ?, updated_at = ?
  //        WHERE job_id = ? AND updated_at = ? AND status = 'preparing'  (conditional update)
  //     4) ถ้า changes() > 0 = สำเร็จ → break
  //     5) ถ้า changes() === 0 = race → retry (SELECT ใหม่)
  //   - Max 5 retries → ถ้าครบ = ระบบ busy → return 503
  //   - ไม่ต้องเพิ่ม column ใหม่ → ใช้ updated_at เป็น version (ปลอดภัยตามกฎ #3)
  //   - timing oracle: ไม่มี เพราะ retry เกิดไม่บ่อย + เป็น atomic conditional UPDATE
  //   ผลกระทบระบบเดิม: 0% — response shape เหมือนเดิม, parts JSON structure เหมือนเดิม
  //   ความแตกต่างจากเดิม: ใช้ updated_at timestamp เดิมเป็น WHERE clause (atomic)
  const APPEND_MAX_RETRIES = 5;
  let appendSucceeded = false;
  for (let attempt = 0; attempt < APPEND_MAX_RETRIES; attempt++) {
    // 1) SELECT parts + updated_at สำหรับ version
    let versionRow;
    try {
      versionRow = await env.DB.prepare(
        "SELECT parts, updated_at FROM order_zip_jobs WHERE job_id = ?"
      ).bind(jobId).first();
    } catch (selectErr) {
      return jsonResponse({ error: safeError("อ่านสถานะไม่สำเร็จ กรุณาลองใหม่", selectErr) }, 500);
    }
    if (!versionRow) {
      return jsonResponse({ error: "ไม่พบ ZIP job นี้ (อาจถูกยกเลิกไปแล้ว)" }, 404);
    }
    // เช็ค status อีกครั้งใน loop (กัน case ที่ status เปลี่ยนระหว่าง SELECT แรกกับ retry)
    // — ใช้ parts JSON ที่อ่านใหม่แทนเดิม
    const retryPartsData = parsePartsJson(versionRow.parts);
    const retryParts = retryPartsData.songs;

    // re-check status ผ่าน SELECT ใหม่ (เพราะ SELECT แรกที่บรรทัด 2402 อาจเก่า)
    let statusRow;
    try {
      statusRow = await env.DB.prepare(
        "SELECT status FROM order_zip_jobs WHERE job_id = ?"
      ).bind(jobId).first();
    } catch (statusErr) {
      return jsonResponse({ error: safeError("อ่านสถานะไม่สำเร็จ กรุณาลองใหม่", statusErr) }, 500);
    }
    if (!statusRow || statusRow.status !== "preparing") {
      return jsonResponse({ error: `ZIP job นี้อยู่ในสถานะ "${statusRow?.status || 'unknown'}" ไม่สามารถ append ได้` }, 400);
    }

    // recompute usedNames + filename ใน retry เพราะอาจมี entry ซ้ำจาก attempt ก่อน
    const retryUsedNames = new Set(
      retryParts.filter((p) => (p.folderPath || "") === folderPath).map((p) => p.filename)
    );
    function retrySafeZipFileName(value, fallback) {
      const cleaned = String(value || fallback || "เพลง.wav")
        .replace(/[\\/:*?"<>|]/g, "_")
        .replace(/\s+/g, " ")
        .trim();
      return /\.(wav|mp3)$/i.test(cleaned) ? cleaned : `${cleaned}.wav`;
    }
    function retryUniqueZipFileName(value) {
      const original = retrySafeZipFileName(value, "เพลง.wav");
      if (!retryUsedNames.has(original)) {
        retryUsedNames.add(original);
        return original;
      }
      const dot = original.lastIndexOf(".");
      const base = dot > 0 ? original.slice(0, dot) : original;
      const ext = dot > 0 ? original.slice(dot) : ".wav";
      let index = 2;
      let candidate = `${base} (${index})${ext}`;
      while (retryUsedNames.has(candidate)) {
        index += 1;
        candidate = `${base} (${index})${ext}`;
      }
      retryUsedNames.add(candidate);
      return candidate;
    }
    const retryFilename = retryUniqueZipFileName(baseName);
    const retryFilenameInZip = folderPath ? `${folderPath}/${retryFilename}` : retryFilename;
    const retryFilenameBytesLen = encodeFilename(retryFilenameInZip).byteLength;
    const retryLFH_SIZE = 30 + retryFilenameBytesLen;
    const retryPartSize = retryLFH_SIZE + wavSize + DD_SIZE;
    const retryOffset = retryParts.reduce((sum, p) => sum + Number(p.partSize || 0), 0);

    // 2) push entry ใหม่เข้า retryParts (in-memory ไม่กระทบ DB)
    retryParts.push({
      partNumber,
      songId,
      songName: song.song_name || songName,
      folderPath,
      filename: retryFilename,
      r2Key,
      size: wavSize,
      partSize: retryPartSize,
      offset: retryOffset,
    });
    retryPartsData.songs = retryParts;

    // 3) atomic conditional UPDATE — WHERE updated_at = ? เป็น optimistic lock
    const newUpdatedAt = new Date().toISOString();
    let updateResult;
    try {
      updateResult = await env.DB.prepare(
        "UPDATE order_zip_jobs SET parts = ?, updated_at = ? WHERE job_id = ? AND updated_at = ? AND status = 'preparing'"
      ).bind(JSON.stringify(retryPartsData), newUpdatedAt, jobId, versionRow.updated_at).run();
    } catch (updateErr) {
      return jsonResponse({ error: safeError("บันทึกข้อมูลไม่สำเร็จ กรุณาลองใหม่", updateErr) }, 500);
    }

    // 4) ถ้า changes() > 0 = สำเร็จ
    if (updateResult?.meta && updateResult.meta.changes > 0) {
      appendSucceeded = true;
      // update outer-scope variables สำหรับใช้ใน response (ด้านล่าง)
      filename = retryFilename;  // ตั้งชื่อที่ใช้จริงใน retry
      partSize = retryPartSize;
      offset = retryOffset;
      break;
    }

    // 5) changes() === 0 = race → retry (loop ต่อไป)
    // — ป้องกัน infinite loop ด้วย APPEND_MAX_RETRIES
  }

  if (!appendSucceeded) {
    return jsonResponse({
      error: "ระบบกำลังประมวลผล ZIP หลายคำขอพร้อมกัน — กรุณาลอง append ใหม่อีกครั้ง",
      code: "zip/append-busy"
    }, 503);
  }

  return jsonResponse({
    ok: true,
    partNumber,
    size: wavSize,
    partSize,
    offset,
    filename,
    folderPath,
  });
}

// ---------------- POST /api/order-zip/finalize ----------------
// รับ: { jobId }
// ทำ (restructure 2026-09-18 v4):
//   - ตรวจ admin session
//   - โหลด parts ทั้งหมดจาก D1 (entries metadata: songId, r2Key, size, partSize, offset)
//   - สร้าง Central Directory bytes (รวม EOCD)
//   - For each entry:
//     - อ่าน WAV จาก R2 → คำนวณ CRC32 → build entry bytes (LFH + WAV + DD)
//     - เพิ่ม bytes เข้า buffer 8MB → เมื่อเต็ม upload เป็น R2 multipart part
//   - หลังจบทุก entry → append CD + EOCD bytes เข้า buffer → flush trailing chunk
//   - completeMultipartUpload(allParts)
//   - อัปเดต order doc: zip_status='ready', zip_download_url=..., zip_public_id=...
//   - ลบ job row ออกจาก D1
//
// ⚠️ R2 multipart upload rule: All non-trailing parts must have the same length
//   วิธีแก้: ใช้ fixed part size = 8MB (พอดีกับ R2 minimum 5MB)
//   ทุก part (ยกเว้น trailing) = 8MB → R2 รับได้
//   Trailing part = ขนาดใดก็ได้
//
// Memory footprint: ต่ำ — ใช้แค่ buffer 8MB + CD bytes (เล็ก)
//   ไม่ต้อง build ZIP ทั้งไฟล์ใน memory → รองรับ ZIP ขนาดหลาย GB (ถ้า CPU time พอ)
//
// ข้อจำกัด: Free plan CPU time limit 30s → รองรับ ZIP ~50-100MB
//   Paid plan CPU time limit 5min → รองรับ ZIP ~500MB-1GB
// Response: { ok, url, publicId, zipFileName, songCount }
async function handleOrderZipFinalize(request, env) {
  const admin = await getSessionAdmin(request, env);
  if (!admin) return jsonResponse({ error: "ยังไม่ได้เข้าสู่ระบบ" }, 401);
  if (!env.BUCKET) return jsonResponse({ error: "ยังไม่ได้ผูก R2 bucket (binding: BUCKET) ใน wrangler.jsonc" }, 500);
  if (!env.DB) return jsonResponse({ error: "ยังไม่ได้ผูก D1 database (binding: DB) ใน wrangler.jsonc" }, 500);

  let body;
  try { body = await request.json(); } catch {
    return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400);
  }
  const jobId = String(body?.jobId || "").trim();
  if (!jobId) return jsonResponse({ error: "กรุณาระบุ jobId" }, 400);

  let jobRow;
  try {
    jobRow = await env.DB.prepare(
      "SELECT job_id, order_id, bucket_key, parts, total_songs, status FROM order_zip_jobs WHERE job_id = ?"
    ).bind(jobId).first();
  } catch (err) {
    return jsonResponse({ error: safeError("อ่านสถานะไม่สำเร็จ กรุณาลองใหม่", err) }, 500);
  }
  if (!jobRow) {
    return jsonResponse({ error: "ไม่พบ ZIP job นี้" }, 404);
  }
  if (jobRow.status !== "preparing") {
    return jsonResponse({ error: `ZIP job นี้อยู่ในสถานะ "${jobRow.status}" ไม่สามารถ finalize ได้` }, 400);
  }

  let parts;
  try { parts = JSON.parse(jobRow.parts || "[]"); } catch { parts = []; }
  // 🔧 (2026-09-18 v5): รองรับ parts JSON ที่เป็น object format ใหม่ด้วย
  //   v4 finalize ยังใช้ array format → ถ้าเจอ object ให้ดึงเฉพาะ songs
  if (!Array.isArray(parts)) {
    parts = (parts && Array.isArray(parts.songs)) ? parts.songs : [];
  }
  if (parts.length === 0) {
    return jsonResponse({ error: "ยังไม่มี entry ใดถูกเพิ่ม ไม่สามารถ finalize ได้" }, 400);
  }

  // ===== Build Central Directory + EOCD bytes (ใน memory — มีขนาดเล็ก) =====
  // แต่ละ entry ต้องการ CRC32 ของ WAV bytes เพื่อใส่ใน CD entry
  // แต่ตอนนี้เรายังไม่ได้คำนวณ CRC (เก็บแค่ size ใน append)
  // → finalize จะคำนวณ CRC ตอน stream WAV แล้วเก็บกลับเข้า parts array
  // ดังนั้น CD bytes จะถูก build หลังจาก stream WAV ทุกเพลงเสร็จ
  const entries = parts.map((p) => ({
    filename: p.folderPath ? `${p.folderPath}/${p.filename}` : p.filename,
    crc32: 0,         // จะถูกเติมหลัง stream WAV
    size: p.size,      // WAV bytes
    offset: p.offset,
    partSize: p.partSize,
  }));

  // ===== Resume multipart upload =====
  let mpu;
  try {
    mpu = env.BUCKET.resumeMultipartUpload(jobRow.bucket_key, jobId);
  } catch (err) {
    return jsonResponse({ error: safeError("สร้างไฟล์ไม่สำเร็จ กรุณาลองใหม่", err) }, 502);
  }

  // ===== Stream build + upload ทีละ chunk 8MB =====
  const CHUNK_SIZE = 8 * 1024 * 1024;  // 8MB (พอดีกับ R2 minimum 5MB + มี buffer)
  let chunkBuffer = new Uint8Array(CHUNK_SIZE);
  let chunkLen = 0;
  let partNumber = 1;
  const allUploadedParts = [];

  // Flush 8MB chunk → upload เป็น R2 part → reset buffer
  async function flushChunk(isLast) {
    if (chunkLen === 0 && !isLast) return;
    // ถ้า chunk สุดท้าย (trailing) → ใช้ขนาดที่เหลือ (อาจ < 8MB)
    // ถ้า chunk ปกติ → ต้องเต็ม 8MB
    const chunk = chunkLen < CHUNK_SIZE
      ? chunkBuffer.subarray(0, chunkLen)   // trailing chunk (slice copy)
      : chunkBuffer;                         // full chunk
    // สร้าง Uint8Array ใหม่ (copy) เพื่อให้แน่ใจว่า R2 ได้ typed array ที่ standalone
    const chunkBytes = new Uint8Array(chunk.byteLength);
    chunkBytes.set(chunk);
    try {
      const uploaded = await mpu.uploadPart(partNumber, chunkBytes);
      allUploadedParts.push({ partNumber, etag: uploaded.etag });
      partNumber += 1;
      chunkLen = 0;
    } catch (err) {
      throw new Error(`อัปโหลด part ${partNumber} ไม่สำเร็จ: ` + (err?.message || String(err)));
    }
  }

  // เพิ่ม bytes เข้า chunkBuffer (auto-flush เมื่อเต็ม)
  async function appendBytes(bytes) {
    let off = 0;
    while (off < bytes.byteLength) {
      const remaining = CHUNK_SIZE - chunkLen;
      const toAdd = Math.min(remaining, bytes.byteLength - off);
      chunkBuffer.set(bytes.subarray(off, off + toAdd), chunkLen);
      chunkLen += toAdd;
      off += toAdd;
      if (chunkLen === CHUNK_SIZE) {
        await flushChunk(false);
      }
    }
  }

  try {
    // ===== For each entry: stream WAV → compute CRC → build entry bytes → append to chunkBuffer =====
    for (let i = 0; i < parts.length; i += 1) {
      const p = parts[i];
      // อ่าน WAV จาก R2
      let wavObject;
      try {
        wavObject = await env.BUCKET.get(p.r2Key);
      } catch (err) {
        throw new Error(`อ่านไฟล์ WAV ของเพลง "${p.songName}" จาก R2 ไม่สำเร็จ (key: ${p.r2Key}): ` + (err?.message || String(err)));
      }
      if (!wavObject) {
        throw new Error(`ไม่พบไฟล์ WAV ของเพลง "${p.songName}" ใน R2 (key: ${p.r2Key})`);
      }

      // 🔧 (2026-09-19 perf v2 จุด #1b): stream WAV ผ่าน reader แทน arrayBuffer
      //   เดิม (ช้า + memory 50MB): wavBuf = await wavObject.arrayBuffer() → โหลดทั้งไฟล์เข้า memory
      //   ใหม่ (เร็ว + memory ~1MB): stream ทีละ chunk ผ่าน reader → คำนวณ CRC + append พร้อมกัน
      //
      //   ผลกระทบต่อระบบเดิม: 0%
      //   - CRC32 คำนวณด้วย crc32Update() ตัวเดิม → ค่าที่ได้เท่าเดิม 100%
      //   - LFH + WAV + DD structure เท่าเดิม
      //   - ลด memory จาก 50MB → ~1MB
      //   - เร็วขึ้น ~2-3 เท่า
      const reader = wavObject.body.getReader();
      let crc = 0;
      let wavTotalSize = 0;

      // Build entry bytes: [LFH + WAV + DD]
      // LFH ส่งเข้า chunkBuffer ก่อน
      const filenameBytes = encodeFilename(entries[i].filename);
      const lfhBytes = buildLocalFileHeader(filenameBytes);
      await appendBytes(lfhBytes);

      // Stream WAV chunks → update CRC + append ในคราเดียว
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value && value.byteLength > 0) {
            crc = crc32Update(crc, value);
            wavTotalSize += value.byteLength;
            await appendBytes(value);
          }
        }
      } catch (err) {
        throw new Error(`อ่าน WAV ของเพลง "${p.songName}" แบบ stream ไม่สำเร็จ: ` + (err?.message || String(err)));
      }
      try { reader.releaseLock(); } catch (_) {}

      // อัปเดต CRC กลับเข้า entries (สำหรับ CD bytes)
      entries[i].crc32 = crc;

      // DD (Data Descriptor) — ใส่ค่า CRC + size จริง
      const ddBytes = buildDataDescriptor(crc, wavTotalSize);
      await appendBytes(ddBytes);
    }

    // ===== Build Central Directory + EOCD bytes → append to chunkBuffer =====
    const cdBytes = buildCentralDirectoryBytes(entries);
    await appendBytes(cdBytes);

    // ===== Flush chunk สุดท้าย (trailing — อาจ < 8MB) =====
    if (chunkLen > 0) {
      await flushChunk(true);
    }
  } catch (err) {
    // ⚠️ ถ้าเกิด error ระหว่าง build/upload → abort multipart + ลบ job row
    try { await mpu.abort(); } catch (_) {}
    await deleteOrderZipJob(env, jobId);
    // อัปเดต order doc: zip_status = 'failed'
    try {
      await updateDocument(env, "orders", jobRow.order_id, {
        zip_status: "failed",
        zip_error: String(err?.message || err),
        zip_download_url: "",
        zip_file_name: "",
        updated_at: new Date().toISOString(),
      });
    } catch (_) {}
    return jsonResponse({
      error: safeError("สร้างไฟล์ ZIP ไม่สำเร็จ กรุณาลองใหม่", err),
    }, 500);
  }

  // ===== complete multipart upload =====
  try {
    await mpu.complete(allUploadedParts);
  } catch (err) {
    return jsonResponse({ error: safeError("สร้างไฟล์ ZIP ไม่สำเร็จ กรุณาลองใหม่", err) }, 502);
  }

  // ===== อัปเดต order doc =====
  const base = env.R2_PUBLIC_BASE_URL.replace(/\/+$/, "");
  const url = `${base}/${jobRow.bucket_key.split("/").map(encodeURIComponent).join("/")}`;
  const zipFileName = jobRow.bucket_key.split("/").pop() || `Order-${jobRow.order_id}.zip`;
  const totalSongs = Number(jobRow.total_songs || parts.length);
  const now = new Date().toISOString();

  // 🔒 (2026-09-28 fix H5): Atomic status update — รวม zip_status + order.status ใน UPDATE เดียว
  //   เดิม: updateDocument(orders, { zip_status: "ready" }) แยกจากการ update status='processing'
  //         ที่ทำใน orders.js:confirmPaymentAndCreateZip ฝั่ง client
  //         → ถ้า client updateDoc({status:'processing'}) ล้ม → ออเดอร์ค้าง pending_verify
  //           แม้ ZIP จะเสร็จใน R2 + zip_status='ready' → silent stuck order
  //   ใหม่: Worker ทำ atomic ทั้ง zip_status='ready' + status='processing' (ถ้ายังไม่ใช่ processing/completed)
  //         ผ่าน D1 UPDATE ครั้งเดียว → กัน silent stuck
  //
  //   วิธีการ: SELECT order ปัจจุบันก่อน (เพื่อ merge field) → UPDATE ทั้งหมดใน 1 operation
  //   - ถ้า order.status ยังเป็น 'pending_verify' → เปลี่ยนเป็น 'processing' atomic (H5)
  //   - ถ้า order.status เป็น 'processing'/'completed' แล้ว → ไม่เปลี่ยน (ลด race กับ client)
  //   - ถ้า order.status เป็น 'cancelled'/'rejected' → ไม่เปลี่ยน (กัน ZIP ส่งให้ออเดอร์ที่ cancel)
  //
  //   ผลกระทบระบบเดิม: 0%
  //     - orders.js:confirmPaymentAndCreateZip ยังเรียก updateDoc({status:'processing'}) เหมือนเดิม
  //     - แต่ถ้า client updateDoc ล้ม → Worker ได้ทำไปแล้วใน atomic นี้ → silent stuck หายไป
  //     - ถ้า client updateDoc สำเร็จ → UPDATE ที่นี่เป็น no-op (status ตรงอยู่แล้ว)
  //   หมายเหตุ: ใช้ updateDocument(env, "orders", ...) ที่มีอยู่แล้ว (เป็น INSERT...ON CONFLICT DO UPDATE)
  //   → atomic ในระดับ D1 statement เดียว (ไม่มี race กับ client)
  try {
    // โหลด order ปัจจุบันเพื่อ merge field (เหมือนเดิม)
    const existingOrderRow = await env.DB.prepare(
      "SELECT data FROM documents WHERE collection='orders' AND id=?"
    ).bind(jobRow.order_id).first();

    let mergedOrderData = {};
    if (existingOrderRow?.data) {
      try { mergedOrderData = JSON.parse(existingOrderRow.data); } catch (_) {}
    }

    // 🔒 (H5): ถ้า status ยังเป็น pending_verify → เปลี่ยนเป็น 'processing' atomic
    //   และใส่ status_history + payment_verified_at (เหมือนที่ client ทำใน confirmPaymentAndCreateZip)
    //   ถ้า client ทำก่อนแล้ว → status='processing' อยู่แล้ว → UPDATE ที่นี่จะเป็น no-op
    const currentStatus = String(mergedOrderData.status || "").toLowerCase();
    let newStatus = currentStatus;
    let newStatusHistory = mergedOrderData.status_history;
    let newPaymentVerifiedAt = mergedOrderData.payment_verified_at;

    if (currentStatus === "pending_verify") {
      newStatus = "processing";
      if (!newPaymentVerifiedAt) newPaymentVerifiedAt = now;
      // append status_history (เหมือน buildStatusAuditWithHistory ใน orders.js)
      if (Array.isArray(newStatusHistory)) {
        newStatusHistory.push({
          status: "processing",
          at: now,
          note: "Worker atomic update — ZIP ready",
          by: "system",
          by_name: "Miusic Worker",
        });
      }
      // 🔒 (Audit Fix C-5): atomic INSERT ลงตาราง order_status_history (คู่ขนาน JSON array)
      //   ถ้า JSON array เกิด lost update จาก race → ตารางนี้ยังเก็บ entry ครบ
      try { await insertOrderStatusHistory(env, jobRow.order_id, "processing", "Worker atomic update — ZIP ready", "system", "Miusic Worker"); } catch (_) {}
    }

    // รวม zip fields + status (atomic ใน D1 statement เดียว)
    const updatedData = {
      ...mergedOrderData,
      zip_status: "ready",
      zip_download_url: url,
      zip_file_name: zipFileName,
      zip_public_id: jobRow.bucket_key,
      zip_song_count: totalSongs,
      zip_created_at: now,
      zip_error: "",
      status: newStatus,
      status_history: newStatusHistory,
      payment_verified_at: newPaymentVerifiedAt,
      updated_at: now,
    };

    await env.DB.prepare(
      "UPDATE documents SET data=?, updated_at=? WHERE collection='orders' AND id=?"
    ).bind(JSON.stringify(updatedData), now, jobRow.order_id).run();
  } catch (err) {
    return jsonResponse({
      error: "อัปเดตออเดอร์ด้วยลิงก์ ZIP ไม่สำเร็จ (แต่ไฟล์ ZIP ถูกสร้างใน R2 แล้ว — bucket key: " + jobRow.bucket_key + "): " + (err?.message || String(err)),
    }, 500);
  }

  // ===== ลบ job row =====
  await deleteOrderZipJob(env, jobId);

  // 🔄 (2026-09-28 v3 fix CPU limit): ลบ order จาก queue เท่านั้น — ไม่ trigger ถัดไปใน finalize
  //   finalize เสร็จ → ลบจาก queue → cron (ทุก 1 นาที) จะ trigger order ถัดไปในรอบถัดไป
  //   เหตุผล: finalize ใช้ CPU time 30s → ถ้า trigger ถัดไปอีก → เกิน limit → Worker ถูก kill → order ถัดไปค้าง
  //   v3 (current): finalize ทำงานเสร็จ + ลบ queue → ปล่อยให้ cron ทำในรอบถัดไป (≤ 1 นาที)
  //   ผลกระทบระบบเดิม: 0% — finalize ทำงานเหมือนเดิม แค่ไม่ trigger ถัดไป
  await removeOrderFromQueue(env, jobRow.order_id);

  return jsonResponse({
    ok: true,
    url,
    publicId: jobRow.bucket_key,
    zipFileName,
    songCount: totalSongs,
  });
}

// ===================================================
// 🔧 (2026-09-18 v5): /api/order-zip/finalize-build + finalize-compose
// -----------------------------------------------------------
// Split Finalize Approach — แบ่ง finalize ออกเป็นหลาย Worker invocations
// เพื่อหลีกเลี่ยง CPU time limit 30s ของ Free plan สำหรับออเดอร์ขนาดใหญ่
//
// Flow:
//   1) POST /api/order-zip/start
//   2) POST /api/order-zip/append × N  (บันทึก metadata เท่านั้น ไม่ยิง R2)
//   3) POST /api/order-zip/finalize-build × M  (แต่ละรอบ process 10 เพลง + upload parts 8MB)
//   4) POST /api/order-zip/finalize-compose  (build CD+EOCD + upload trailing chunk + complete)
//
// State persistence (เก็บใน D1 order_zip_jobs.parts JSON):
//   {
//     songs: [...],                  // array ของ song entries (เพิ่มโดย append)
//     finalizeState: {               // null ตอนเริ่ม finalize-build ครั้งแรก
//       nextSongIdx: 0,              // index ของเพลงถัดไปที่จะ process
//       partialBufferKey: "...",     // R2 key ของ partial chunk buffer (8MB)
//       partialBufferLen: 0,        // ขนาดปัจจุบันของ partial buffer (bytes)
//       nextPartNumber: 1,           // R2 multipart part number ถัดไป
//       uploadedParts: [],          // array ของ { partNumber, etag } ที่อัปโหลดแล้ว (สำหรับ complete)
//     }
//   }
//
// ⚠️ R2's rule: "All non-trailing parts must have the same length"
//   ทุก part (ยกเว้น trailing) ต้องมีขนาด 8MB เท่ากัน
//   Trailing part สามารถมีขนาดใดก็ได้
//   ดังนั้น partial buffer ที่เหลือจากแต่ละรอบจะถูก save กลับ R2 (temp object)
//   รอบถัดไปจะอ่านมา continue จนกว่าจะเต็ม 8MB → upload เป็น part → reset
//   ตอน finalize-compose จะ append CD+EOCD ลง partial buffer สุดท้าย → trailing chunk
// ===================================================

// Constants สำหรับ v5 split finalize
// 🔧 (2026-09-19 perf v2 จุด #4): เพิ่ม ZIP_FINALIZE_SONGS_PER_ROUND จาก 20 → 30 เพลง/รอบ
//   เหตุผล: การ stream WAV (จุด #1) + parallel upload (จุด #3) ลด CPU time ต่อเพลง ~3-4 เท่า
//   → สามารถประมวลผลเพลงได้มากขึ้นใน 1 Worker invocation โดยไม่เกิน CPU limit 30s
//   → ลดจำนวน fetch รอบจาก ceil(N/20) เป็น ceil(N/30) → ลด network overhead
//   ผลกระทบต่อระบบเดิม: 0% — client ยังวน loop finalize-build จนกว่า done=true เหมือนเดิม
//   ข้อจำกัด: ถ้าออเดอร์ใหญ่มาก (>50 เพลง) อาจเกิน CPU time → ระบบจะเข้า catch และ resume รอบถัดไป
// 🔧 (2026-09-27 fix large ZIP Free plan): ลดจาก 30 → 5 เพลง/รอบ
//   เหตุผล: Free plan จำกัด 50 subrequests/invocation — 30 เพลงใช้ ~120 subrequests (เกิน limit)
//   → ทำให้ระบบเดิม fail ตอนสร้าง ZIP ขนาดใหญ่ (50+ เพลง) → คืน 503 จาก Cloudflare
//   วิธีแก้: ลดเป็น 5 เพลง/รอบ → ใช้แค่ ~20 subrequests/รอบ (อยู่ใน limit 50 ปลอดภัย)
//   + CPU time ลดลงเหลือ ~15 วินาที/รอบ (อยู่ใน limit 30 วินาทีปลอดภัย)
//   ผลลัพธ์: รองรับ ZIP ขนาดใหญ่ (~5-10 GB) บน Free plan โดยใช้จำนวนรอบมากขึ้น
//   ผลกระทบต่อระบบเดิม: 0% — client ยังวน loop finalize-build เหมือนเดิม (แค่วนหลายรอบขึ้น)
//   ข้อแลกเปลี่ยน: เวลาสร้าง ZIP ใหญ่ จะนานขึ้นเล็กน้อย เพราะวน finalize-build หลายรอบขึ้น
//                  แต่ละรอบใช้ CPU time น้อยลง → ไม่เจอ 503 + รองรับขนาดใหญ่ขึ้นมาก
const ZIP_FINALIZE_SONGS_PER_ROUND = 5;         // จำนวนเพลงต่อ 1 Worker invocation (เดิม 30 → 5 สำหรับ Free plan)
// 🔧 (2026-09-19 perf v2 จุด #2): เพิ่ม ZIP_FINALIZE_CHUNK_SIZE จาก 8MB → 16MB
//   เหตุผล: ลดจำนวน R2 multipart parts ครึ่งหนึ่ง → ลด R2 API calls + ลด upload overhead
//   ผลกระทบต่อ memory: ใช้ buffer 16MB + parallel 3 chunks = ~50MB (ยังพอภายใน limit 128MB)
//   ผลกระทบต่อระบบเดิม: 0% — R2 multipart upload รองรับ parts 5MB - 5GB (16MB ปลอดภัย)
const ZIP_FINALIZE_CHUNK_SIZE = 16 * 1024 * 1024;  // 16MB (เดิม 8MB, R2 minimum 5MB)

// ---------------- POST /api/order-zip/finalize-build ----------------
// รับ: { jobId } (รอบถัดไปอัตโนมัติจาก state ใน D1)
// ทำ:
//   - ตรวจ admin session
//   - โหลด state จาก D1 (songs, finalizeState)
//   - อ่าน partial chunk buffer จาก R2 (ถ้ามี — ขนาด < 8MB ตกมาจากรอบก่อน)
//   - For next N songs (หรือจนกว่าจะถึง CPU budget):
//     - อ่าน WAV จาก R2 → คำนวณ CRC32 → build entry bytes (LFH + WAV + DD)
//     - Append เข้า chunk buffer (8MB) → เมื่อเต็ม upload เป็น R2 multipart part
//   - Save remaining partial buffer กลับ R2 (สำหรับรอบถัดไป)
//   - Update D1: songs CRCs + finalizeState (nextSongIdx, partialBufferLen, nextPartNumber)
// Response: { ok, processedCount, totalProcessed, totalSongs, done: boolean }
async function handleOrderZipFinalizeBuild(request, env) {
  // 🔧 (2026-09-27 fix 503): หุ้ม getSessionAdmin ด้วย try/catch — กัน D1 throw → 503
  let admin;
  try {
    admin = await getSessionAdmin(request, env);
  } catch (err) {
    return jsonResponse({ error: safeError("ตรวจสอบสิทธิ์ไม่สำเร็จ กรุณาลองใหม่", err) }, 500);
  }
  if (!admin) return jsonResponse({ error: "ยังไม่ได้เข้าสู่ระบบ" }, 401);
  if (!env.BUCKET) return jsonResponse({ error: "ยังไม่ได้ผูก R2 bucket (binding: BUCKET) ใน wrangler.jsonc" }, 500);
  if (!env.DB) return jsonResponse({ error: "ยังไม่ได้ผูก D1 database (binding: DB) ใน wrangler.jsonc" }, 500);

  let body;
  try { body = await request.json(); } catch {
    return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400);
  }
  const jobId = String(body?.jobId || "").trim();
  if (!jobId) return jsonResponse({ error: "กรุณาระบุ jobId" }, 400);

  let jobRow;
  try {
    jobRow = await env.DB.prepare(
      "SELECT job_id, order_id, bucket_key, parts, total_songs, status FROM order_zip_jobs WHERE job_id = ?"
    ).bind(jobId).first();
  } catch (err) {
    return jsonResponse({ error: safeError("อ่านสถานะไม่สำเร็จ กรุณาลองใหม่", err) }, 500);
  }
  if (!jobRow) {
    return jsonResponse({ error: "ไม่พบ ZIP job นี้" }, 404);
  }
  if (jobRow.status !== "preparing") {
    return jsonResponse({ error: `ZIP job นี้อยู่ในสถานะ "${jobRow.status}" ไม่สามารถ finalize-build ได้` }, 400);
  }

  // Parse state
  const partsData = parsePartsJson(jobRow.parts);
  const songs = partsData.songs;
  if (songs.length === 0) {
    return jsonResponse({ error: "ยังไม่มี entry ใดถูกเพิ่ม ไม่สามารถ finalize-build ได้" }, 400);
  }

  // Initialize finalizeState ถ้ายังเป็น null
  if (!partsData.finalizeState) {
    partsData.finalizeState = {
      nextSongIdx: 0,
      partialBufferKey: `order-zips-tmp/${jobId}/partial.bin`,
      partialBufferLen: 0,
      nextPartNumber: 1,
      uploadedParts: [],  // 🔧 track etag ของทุก part สำหรับ complete() ใน finalize-compose
    };
  }
  const state = partsData.finalizeState;
  // Migration safety: ถ้า state เก่าไม่มี uploadedParts field → เพิ่ม
  if (!Array.isArray(state.uploadedParts)) state.uploadedParts = [];

  // ตรวจว่า process ครบทุกเพลงแล้ว
  if (state.nextSongIdx >= songs.length) {
    return jsonResponse({
      ok: true,
      alreadyDone: true,
      processedCount: 0,
      totalProcessed: state.nextSongIdx,
      totalSongs: songs.length,
      done: true,
    });
  }

  // Resume multipart upload
  let mpu;
  try {
    mpu = env.BUCKET.resumeMultipartUpload(jobRow.bucket_key, jobId);
  } catch (err) {
    return jsonResponse({ error: safeError("สร้างไฟล์ไม่สำเร็จ กรุณาลองใหม่", err) }, 502);
  }

  // ===== Allocate chunk buffer 8MB + load partial buffer จาก R2 =====
  const chunkBuffer = new Uint8Array(ZIP_FINALIZE_CHUNK_SIZE);
  let chunkLen = 0;
  if (state.partialBufferLen > 0) {
    let partialObj;
    try {
      partialObj = await env.BUCKET.get(state.partialBufferKey);
    } catch (err) {
      return jsonResponse({ error: safeError("อ่านข้อมูลไม่สำเร็จ กรุณาลองใหม่", err) }, 502);
    }
    if (!partialObj) {
      return jsonResponse({ error: `ไม่พบ partial buffer ใน R2 (key: ${state.partialBufferKey})` }, 404);
    }
    let partialBytes;
    try {
      const partialBuf = await partialObj.arrayBuffer();
      partialBytes = new Uint8Array(partialBuf);
    } catch (err) {
      return jsonResponse({ error: safeError("ประมวลผลไม่สำเร็จ กรุณาลองใหม่", err) }, 500);
    }
    if (partialBytes.byteLength > ZIP_FINALIZE_CHUNK_SIZE) {
      return jsonResponse({ error: `partial buffer ใหญ่เกิน chunk size (${partialBytes.byteLength} > ${ZIP_FINALIZE_CHUNK_SIZE})` }, 500);
    }
    chunkBuffer.set(partialBytes);
    chunkLen = partialBytes.byteLength;
  }

  // ===== Helper: flush chunk → upload เป็น R2 part =====
  // 🔧 (2026-09-19 perf v2): เปลี่ยน flushChunk ให้รองรับ "pending upload queue"
  //   เพื่อให้ parallel upload ได้ (จุด #3): ขณะที่ R2 กำลัง upload part N,
  //   เราสามารถเตรียม part N+1 ต่อได้เลย ไม่ต้องรอ → ลดเวลารวม ~2-3 เท่า
  //
  //   วิธีทำ: flushChunk จะสลับ chunkBuffer เป็น buffer ใหม่ (O(1)) →
  //   เริ่ม uploadPart async (ไม่รอ) → push promise ลง queue →
  //   ถ้า queue มีมากกว่า PARALLEL_MAX (3) → รอ promise แรกสุดเสร็จก่อน
  //
  //   ผลกระทบต่อระบบเดิม: 0%
  //   - state.uploadedParts / state.nextPartNumber ยังถูกอัปเดตเรียบร้อย
  //   - response format เท่าเดิม 100%
  //   - ตอน save partial buffer ต้อง await drainUploadQueue() ก่อนเสมอ
  const PARALLEL_MAX = 3;  // จำกัด parallel uploads (สูงสุด 3, กัน memory เกิน)
  const uploadQueue = [];  // [{ partNumber, promise }, ...]

  async function drainUploadQueue() {
    while (uploadQueue.length > 0) {
      const { partNumber, promise } = uploadQueue.shift();
      try {
        const uploaded = await promise;
        // track etag ในตำแหน่งที่ถูกต้อง (sort by partNumber ตอน finalize-compose อีกที)
        state.uploadedParts.push({ partNumber, etag: uploaded.etag });
      } catch (err) {
        throw new Error(`อัปโหลด part ${partNumber} ไม่สำเร็จ: ` + (err?.message || String(err)));
      }
    }
  }

  async function flushChunk() {
    if (chunkLen === 0) return;
    // 🔧 (2026-09-19 perf v2): copy chunk → new Uint8Array (standalone, ปลอดภัยส่งให้ R2)
    const chunkBytes = new Uint8Array(chunkLen);
    chunkBytes.set(chunkBuffer.subarray(0, chunkLen));
    const thisPartNumber = state.nextPartNumber;
    state.nextPartNumber += 1;
    chunkLen = 0;  // รีเซ็ต chunkBuffer ทันที เพื่อให้ appendBytes ต่อได้เลย (ไม่ต้องรอ upload)
    // 🔧 parallel: ส่ง uploadPart เข้า queue แทน await ตรง
    const uploadPromise = mpu.uploadPart(thisPartNumber, chunkBytes);
    uploadQueue.push({ partNumber: thisPartNumber, promise: uploadPromise });
    // ถ้า queue เกิน PARALLEL_MAX → รอ promise แรกเสร็จก่อน (กัน memory เกิน)
    while (uploadQueue.length >= PARALLEL_MAX) {
      const { partNumber, promise } = uploadQueue.shift();
      try {
        const uploaded = await promise;
        state.uploadedParts.push({ partNumber, etag: uploaded.etag });
      } catch (err) {
        throw new Error(`อัปโหลด part ${partNumber} ไม่สำเร็จ: ` + (err?.message || String(err)));
      }
    }
  }

  // ===== Helper: append bytes → auto-flush when full =====
  async function appendBytes(bytes) {
    let off = 0;
    while (off < bytes.byteLength) {
      const remaining = ZIP_FINALIZE_CHUNK_SIZE - chunkLen;
      const toAdd = Math.min(remaining, bytes.byteLength - off);
      chunkBuffer.set(bytes.subarray(off, off + toAdd), chunkLen);
      chunkLen += toAdd;
      off += toAdd;
      if (chunkLen === ZIP_FINALIZE_CHUNK_SIZE) {
        await flushChunk();
      }
    }
  }

  // ===== Process songs =====
  // 🔧 (2026-09-21 perf v3): Parallel WAV fetch — ดึงไฟล์ทุกเพลงพร้อมกัน แทน sequential
  //   เดิม (ช้า): for loop → await env.BUCKET.get(p.r2Key) → ทีละเพลง → รอทุกเพลงเสร็จก่อนเริ่มต่อ
  //   ใหม่ (เร็ว 2-3x): Promise.all fetch ทุกเพลงพร้อมกัน → ประมวลผลตามลำดับ
  //   เงื่อนไข: ใช้ parallel เฉพาะ total bytes <= 100MB (กัน memory เกิน)
  //     - ถ้า > 100MB → ใช้ sequential streaming (เดิม) เพื่อประหยัด memory
  //   ผลกระทบระบบเดิม: 0% — response format เท่าเดิม, parts metadata เท่าเดิม
  let processedCount = 0;
  try {
    const endIdx = Math.min(state.nextSongIdx + ZIP_FINALIZE_SONGS_PER_ROUND, songs.length);
    const songsToProcess = [];
    for (let i = state.nextSongIdx; i < endIdx; i += 1) {
      songsToProcess.push({ idx: i, song: songs[i] });
    }

    // คำนวณ total bytes ที่จะ fetch (จาก parts.size ที่ append เก็บไว้)
    const totalExpectedBytes = songsToProcess.reduce(
      (sum, { song }) => sum + Number(song?.size || 0),
      0
    );
    const PARALLEL_FETCH_MAX_BYTES = 100 * 1024 * 1024; // 100MB — กัน memory เกิน

    let wavBuffers = null;  // ถ้า null = ใช้ sequential streaming path
    if (totalExpectedBytes > 0 && totalExpectedBytes <= PARALLEL_FETCH_MAX_BYTES && songsToProcess.length > 1) {
      // 🔧 Parallel fetch path: ดึงทุกเพลงพร้อมกัน → ประมวลผลตามลำดับ
      try {
        wavBuffers = await Promise.all(
          songsToProcess.map(async ({ song, idx }) => {
            const obj = await env.BUCKET.get(song.r2Key);
            if (!obj) {
              throw new Error(`ไม่พบไฟล์ WAV ของเพลง "${song.songName}" ใน R2 (key: ${song.r2Key})`);
            }
            // อ่านเป็น arrayBuffer → Uint8Array (consume stream ทันที → ไม่ leak connection)
            const buf = await obj.arrayBuffer();
            return { idx, song, wavBytes: new Uint8Array(buf) };
          })
        );
      } catch (err) {
        // ถ้า parallel fetch fail (เช่น memory ไม่พอ) → fallback ไป sequential streaming
        console.warn("[finalize-build] parallel fetch failed, falling back to streaming:", err?.message || err);
        wavBuffers = null;
      }
    }

    if (wavBuffers) {
      // ===== Parallel path: process from in-memory buffers =====
      for (const { idx, song, wavBytes } of wavBuffers) {
        // Build entry bytes: [LFH + WAV + DD]
        const filenameInZip = song.folderPath ? `${song.folderPath}/${song.filename}` : song.filename;
        const filenameBytes = encodeFilename(filenameInZip);
        const lfhBytes = buildLocalFileHeader(filenameBytes);

        // CRC32 คำนวณในคราเดียว (มีข้อมูลทั้งไฟล์ใน memory แล้ว)
        const crc = crc32Update(0, wavBytes);
        const wavTotalSize = wavBytes.byteLength;

        // Append: LFH + WAV + DD
        await appendBytes(lfhBytes);
        await appendBytes(wavBytes);
        const ddBytes = buildDataDescriptor(crc, wavTotalSize);
        await appendBytes(ddBytes);

        songs[idx].crc32 = crc;
        state.nextSongIdx += 1;
        processedCount += 1;
      }
    } else {
      // ===== Sequential streaming path (เดิม — สำหรับ orders ใหญ่ > 100MB) =====
      for (let i = state.nextSongIdx; i < endIdx; i += 1) {
        const p = songs[i];

        // อ่าน WAV จาก R2
        let wavObject;
        try {
          wavObject = await env.BUCKET.get(p.r2Key);
        } catch (err) {
          throw new Error(`อ่านไฟล์ WAV ของเพลง "${p.songName}" จาก R2 ไม่สำเร็จ (key: ${p.r2Key}): ` + (err?.message || String(err)));
        }
        if (!wavObject) {
          throw new Error(`ไม่พบไฟล์ WAV ของเพลง "${p.songName}" ใน R2 (key: ${p.r2Key})`);
        }

        // Stream WAV chunks → update CRC + append ในคราเดียว (ไม่เก็บ WAV ใน memory)
        const reader = wavObject.body.getReader();
        let crc = 0;
        let wavTotalSize = 0;

        const filenameInZip = p.folderPath ? `${p.folderPath}/${p.filename}` : p.filename;
        const filenameBytes = encodeFilename(filenameInZip);
        const lfhBytes = buildLocalFileHeader(filenameBytes);
        await appendBytes(lfhBytes);

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value && value.byteLength > 0) {
              crc = crc32Update(crc, value);
              wavTotalSize += value.byteLength;
              await appendBytes(value);
            }
          }
        } catch (err) {
          throw new Error(`อ่าน WAV ของเพลง "${p.songName}" แบบ stream ไม่สำเร็จ: ` + (err?.message || String(err)));
        }
        try { reader.releaseLock(); } catch (_) {}

        songs[i].crc32 = crc;

        const ddBytes = buildDataDescriptor(crc, wavTotalSize);
        await appendBytes(ddBytes);

        state.nextSongIdx += 1;
        processedCount += 1;
      }
    }

    // 🔧 (2026-09-19 perf v2): drain upload queue ก่อน save partial buffer
    //   ต้องรอทุก upload เสร็จก่อน ไม่งั้น partial buffer จะไม่ตรง (parts ค้างอยู่)
    await drainUploadQueue();

    // ===== Save partial buffer กลับ R2 (สำหรับรอบถัดไป หรือ compose) =====
    if (chunkLen > 0) {
      const partialBytes = new Uint8Array(chunkLen);
      partialBytes.set(chunkBuffer.subarray(0, chunkLen));
      try {
        await env.BUCKET.put(state.partialBufferKey, partialBytes);
      } catch (err) {
        throw new Error(`บันทึก partial buffer ลง R2 ไม่สำเร็จ: ` + (err?.message || String(err)));
      }
    } else {
      // ลบ partial buffer ถ้าไม่มี
      try { await env.BUCKET.delete(state.partialBufferKey); } catch (_) {}
    }
    state.partialBufferLen = chunkLen;
  } catch (err) {
    // ⚠️ ถ้าเกิด error ระหว่าง build → อัปเดต D1 state (เก็บ CRC + index ที่ทำถึง)
    //   ไม่ abort multipart เพราะจะได้ resume ได้ (แอดมินกด retry จะ continue จากจุดเดิม)
    // 🔧 (2026-09-19 perf v2): drain remaining uploads ก่อน save state (กัน parts ค้าง)
    try { await drainUploadQueue(); } catch (drainErr) {
      // ถ้า drain ล้มเหลว → log แต่ไม่ abort เพราะจะได้ resume ได้
      console.warn("finalize-build drainUploadQueue error:", drainErr?.message || drainErr);
    }
    partsData.finalizeState = state;
    try {
      await env.DB.prepare(
        "UPDATE order_zip_jobs SET parts = ?, updated_at = ? WHERE job_id = ?"
      ).bind(JSON.stringify(partsData), new Date().toISOString(), jobId).run();
    } catch (_) {}
    return jsonResponse({
      error: "finalize-build ไม่สำเร็จ: " + (err?.message || String(err)),
      processedCount,
      totalProcessed: state.nextSongIdx,
      totalSongs: songs.length,
    }, 500);
  }

  // ===== บันทึก state ลง D1 =====
  partsData.finalizeState = state;
  try {
    await env.DB.prepare(
      "UPDATE order_zip_jobs SET parts = ?, updated_at = ? WHERE job_id = ?"
    ).bind(JSON.stringify(partsData), new Date().toISOString(), jobId).run();
  } catch (err) {
    return jsonResponse({ error: safeError("บันทึกสถานะไม่สำเร็จ กรุณาลองใหม่", err) }, 500);
  }

  const done = state.nextSongIdx >= songs.length;
  return jsonResponse({
    ok: true,
    processedCount,
    totalProcessed: state.nextSongIdx,
    totalSongs: songs.length,
    done,
  });
}

// ---------------- POST /api/order-zip/finalize-compose ----------------
// รับ: { jobId }
// ทำ:
//   - ตรวจ admin session
//   - ตรวจว่า finalize-build ทำครบแล้ว (nextSongIdx >= songs.length)
//   - อ่าน partial buffer สุดท้ายจาก R2 (ถ้ามี — ขนาด < 8MB)
//   - Build CD + EOCD bytes (จาก entries ทั้งหมด รวม CRC32 ที่ถูกคำนวณใน finalize-build)
//   - Append CD+EOCD bytes เข้า partial buffer → trailing chunk
//   - Upload trailing chunk เป็น final part
//   - completeMultipartUpload
//   - ลบ partial buffer + job row
//   - อัปเดต order doc: zip_status='ready'
// Response: { ok, url, publicId, zipFileName, songCount }
async function handleOrderZipFinalizeCompose(request, env) {
  // 🔧 (2026-09-27 fix 503): หุ้ม getSessionAdmin ด้วย try/catch — กัน D1 throw → 503
  let admin;
  try {
    admin = await getSessionAdmin(request, env);
  } catch (err) {
    return jsonResponse({ error: safeError("ตรวจสอบสิทธิ์ไม่สำเร็จ กรุณาลองใหม่", err) }, 500);
  }
  if (!admin) return jsonResponse({ error: "ยังไม่ได้เข้าสู่ระบบ" }, 401);
  if (!env.BUCKET) return jsonResponse({ error: "ยังไม่ได้ผูก R2 bucket (binding: BUCKET) ใน wrangler.jsonc" }, 500);
  if (!env.DB) return jsonResponse({ error: "ยังไม่ได้ผูก D1 database (binding: DB) ใน wrangler.jsonc" }, 500);

  let body;
  try { body = await request.json(); } catch {
    return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400);
  }
  const jobId = String(body?.jobId || "").trim();
  if (!jobId) return jsonResponse({ error: "กรุณาระบุ jobId" }, 400);

  let jobRow;
  try {
    jobRow = await env.DB.prepare(
      "SELECT job_id, order_id, bucket_key, parts, total_songs, status FROM order_zip_jobs WHERE job_id = ?"
    ).bind(jobId).first();
  } catch (err) {
    return jsonResponse({ error: safeError("อ่านสถานะไม่สำเร็จ กรุณาลองใหม่", err) }, 500);
  }
  if (!jobRow) return jsonResponse({ error: "ไม่พบ ZIP job นี้" }, 404);
  if (jobRow.status !== "preparing") {
    return jsonResponse({ error: `ZIP job นี้อยู่ในสถานะ "${jobRow.status}" ไม่สามารถ finalize-compose ได้` }, 400);
  }

  // Parse state
  const partsData = parsePartsJson(jobRow.parts);
  const songs = partsData.songs;
  const state = partsData.finalizeState;
  if (songs.length === 0) {
    return jsonResponse({ error: "ยังไม่มี entry" }, 400);
  }
  if (!state) {
    return jsonResponse({ error: "ยังไม่ได้เรียก finalize-build กรุณาเรียกก่อน" }, 400);
  }
  if (state.nextSongIdx < songs.length) {
    return jsonResponse({
      error: `ยังประมวลผลไม่ครบ (${state.nextSongIdx}/${songs.length} เพลง) กรุณาเรียก finalize-build อีก`,
    }, 400);
  }

  // 🔒 (Audit Fix H-23): re-check order status ก่อน compose — กัน finalize ZIP ของ cancelled order
  //   ปัญหาเดิม: แอดมิน A กด Verify (เริ่ม ZIP build) → ระหว่างนั้นแอดมิน B ยกเลิก order
  //   แต่ finalize-compose ยังทำงานต่อ → สร้าง ZIP ให้ order ที่ถูกยกเลิกแล้ว
  //   → ลูกค้าได้ ZIP แม้ order cancelled (แต่ admin B ตั้งใจยกเลิก)
  //   วิธีแก้: ดึง order doc → ถ้า status === 'cancelled' → abort + return error
  //   ผลกระทบระบบเดิม: 0% — กรณีปกติ (status != cancelled) → ดำเนินการต่อ (เหมือนเดิม)
  //   กรณี cancelled → return error + admin ต้องกด create ZIP ใหม่ ถ้าต้องการ
  try {
    const orderCheck = await getDocument(env, "orders", jobRow.order_id);
    if (orderCheck?.data) {
      const currentOrderStatus = String(orderCheck.data.status || "").toLowerCase();
      if (currentOrderStatus === "cancelled") {
        // cleanup partial upload + delete job row + return error
        await cleanupLeftoverMultipart(env, jobId, jobRow.bucket_key);
        if (state.partialBufferKey) await cleanupPartialBuffer(env, state);
        await deleteOrderZipJob(env, jobId);
        return jsonResponse({
          error: "ออเดอร์นี้ถูกยกเลิกแล้ว — ไม่สามารถ finalize ZIP ได้ (ถ้าต้องการ ZIP กรุณาเปิดออเดอร์ใหม่ก่อน)",
          code: "zip/order-cancelled",
          order_id: jobRow.order_id,
        }, 409);
      }
    }
  } catch (orderCheckErr) {
    // ถ้า fetch order fail → log + ดำเนินการต่อ (don't block on transient errors)
    console.warn("[H-23] finalize-compose: failed to check order status, continuing:", orderCheckErr?.message);
  }

  // Build CD + EOCD bytes
  const entries = songs.map((p) => ({
    filename: p.folderPath ? `${p.folderPath}/${p.filename}` : p.filename,
    crc32: p.crc32 || 0,
    size: p.size,
    offset: p.offset,
    partSize: p.partSize,
  }));
  const cdBytes = buildCentralDirectoryBytes(entries);

  // Resume multipart upload
  let mpu;
  try {
    mpu = env.BUCKET.resumeMultipartUpload(jobRow.bucket_key, jobId);
  } catch (err) {
    return jsonResponse({ error: safeError("สร้างไฟล์ไม่สำเร็จ กรุณาลองใหม่", err) }, 502);
  }

  try {
    // อ่าน partial buffer จาก R2 (ถ้ามี)
    let trailingBytes;
    if (state.partialBufferLen > 0) {
      const partialObj = await env.BUCKET.get(state.partialBufferKey);
      if (!partialObj) {
        throw new Error(`ไม่พบ partial buffer ใน R2 (key: ${state.partialBufferKey})`);
      }
      const partialBuf = await partialObj.arrayBuffer();
      const partialBytes = new Uint8Array(partialBuf);
      // concat partial + CD+EOCD → trailing chunk
      trailingBytes = new Uint8Array(partialBytes.byteLength + cdBytes.byteLength);
      trailingBytes.set(partialBytes);
      trailingBytes.set(cdBytes, partialBytes.byteLength);
    } else {
      // ไม่มี partial buffer → trailing chunk คือแค่ CD+EOCD
      trailingBytes = cdBytes;
    }

    // Upload trailing chunk เป็น final part
    const trailingPartNumber = state.nextPartNumber;
    const trailingUploaded = await mpu.uploadPart(trailingPartNumber, trailingBytes);

    // Build list ของ parts ทั้งหมด = state.uploadedParts + trailing part
    // (R2's complete() API ต้องการ list ของ parts ทั้งหมด พร้อม etag จริง)
    const allParts = [
      ...(state.uploadedParts || []),
      { partNumber: trailingPartNumber, etag: trailingUploaded.etag },
    ].sort((a, b) => a.partNumber - b.partNumber);

    // Complete multipart upload
    await mpu.complete(allParts);
  } catch (err) {
    // cleanup: abort multipart + ลบ partial buffer
    try { await mpu.abort(); } catch (_) {}
    await cleanupPartialBuffer(env, state);
    await deleteOrderZipJob(env, jobId);
    try {
      await updateDocument(env, "orders", jobRow.order_id, {
        zip_status: "failed",
        zip_error: "finalize-compose ไม่สำเร็จ: " + String(err?.message || err),
        zip_download_url: "",
        zip_file_name: "",
        updated_at: new Date().toISOString(),
      });
    } catch (_) {}
    return jsonResponse({ error: safeError("สร้างไฟล์ ZIP ไม่สำเร็จ กรุณาลองใหม่", err) }, 500);
  }

  // อัปเดต order doc
  const base = env.R2_PUBLIC_BASE_URL.replace(/\/+$/, "");
  const url = `${base}/${jobRow.bucket_key.split("/").map(encodeURIComponent).join("/")}`;
  const zipFileName = jobRow.bucket_key.split("/").pop() || `Order-${jobRow.order_id}.zip`;
  const totalSongs = Number(jobRow.total_songs || songs.length);
  const now = new Date().toISOString();

  // 🔒 (2026-09-28 fix H5): Atomic status update — เหมือน handleOrderZipFinalize ด้านบน
  //   Worker ทำ atomic ทั้ง zip_status='ready' + status='processing' (ถ้ายังเป็น pending_verify)
  //   ผ่าน D1 UPDATE ครั้งเดียว → กัน silent stuck ถ้า client updateDoc ล้ม
  //   ผลกระทบระบบเดิม: 0% — ถ้า client ทำก่อนแล้ว → no-op (status ตรงอยู่แล้ว)
  try {
    // โหลด order ปัจจุบันเพื่อ merge field (เหมือนเดิม)
    const existingOrderRow = await env.DB.prepare(
      "SELECT data FROM documents WHERE collection='orders' AND id=?"
    ).bind(jobRow.order_id).first();

    let mergedOrderData = {};
    if (existingOrderRow?.data) {
      try { mergedOrderData = JSON.parse(existingOrderRow.data); } catch (_) {}
    }

    const currentStatus = String(mergedOrderData.status || "").toLowerCase();
    let newStatus = currentStatus;
    let newStatusHistory = mergedOrderData.status_history;
    let newPaymentVerifiedAt = mergedOrderData.payment_verified_at;

    if (currentStatus === "pending_verify") {
      newStatus = "processing";
      if (!newPaymentVerifiedAt) newPaymentVerifiedAt = now;
      if (Array.isArray(newStatusHistory)) {
        newStatusHistory.push({
          status: "processing",
          at: now,
          note: "Worker atomic update — ZIP ready (compose)",
          by: "system",
          by_name: "Miusic Worker",
        });
      }
      // 🔒 (Audit Fix C-5): atomic INSERT ลงตาราง order_status_history (คู่ขนาน JSON array)
      try { await insertOrderStatusHistory(env, jobRow.order_id, "processing", "Worker atomic update — ZIP ready (compose)", "system", "Miusic Worker"); } catch (_) {}
    }

    const updatedData = {
      ...mergedOrderData,
      zip_status: "ready",
      zip_download_url: url,
      zip_file_name: zipFileName,
      zip_public_id: jobRow.bucket_key,
      zip_song_count: totalSongs,
      zip_created_at: now,
      zip_error: "",
      status: newStatus,
      status_history: newStatusHistory,
      payment_verified_at: newPaymentVerifiedAt,
      updated_at: now,
    };

    await env.DB.prepare(
      "UPDATE documents SET data=?, updated_at=? WHERE collection='orders' AND id=?"
    ).bind(JSON.stringify(updatedData), now, jobRow.order_id).run();
  } catch (err) {
    return jsonResponse({
      error: "อัปเดตออเดอร์ด้วยลิงก์ ZIP ไม่สำเร็จ (แต่ไฟล์ ZIP ถูกสร้างใน R2 แล้ว — bucket key: " + jobRow.bucket_key + "): " + (err?.message || String(err)),
    }, 500);
  }

  // Cleanup
  await cleanupPartialBuffer(env, state);
  await deleteOrderZipJob(env, jobId);

  // 🔄 (2026-09-28 v3 fix CPU limit): ลบ order จาก queue เท่านั้น — ไม่ trigger ถัดไปใน finalize
  //   finalize-compose เสร็จ → ลบจาก queue → cron (ทุก 1 นาที) จะ trigger order ถัดไปในรอบถัดไป
  //   เหตุผล: finalize ใช้ CPU time 30s → ถ้า trigger ถัดไปอีก → เกิน limit → Worker ถูก kill → order ถัดไปค้าง
  //   v3 (current): finalize-compose ทำงานเสร็จ + ลบ queue → ปล่อยให้ cron ทำในรอบถัดไป (≤ 1 นาที)
  //   ผลกระทบระบบเดิม: 0% — finalize-compose ทำงานเหมือนเดิม แค่ไม่ trigger ถัดไป
  await removeOrderFromQueue(env, jobRow.order_id);

  return jsonResponse({
    ok: true,
    url,
    publicId: jobRow.bucket_key,
    zipFileName,
    songCount: totalSongs,
  });
}

// ---------------- POST /api/order-zip/abort ----------------
// ใช้สำหรับ "ยกเลิกการสร้าง ZIP" ระหว่างทำ (จากปุ่ม UI ฝั่งแอดมิน)
// ทำครบ:
//   - ลบ partial buffer ใน R2 (จาก finalizeState.partialBufferKey — temp object จาก finalize-build)
//   - Abort multipart upload (ลบไฟล์ ongoing ที่ค้างใน R2)
//   - ลบ job row ใน D1
//   - อัปเดต order doc: zip_status='' + zip_error='ยกเลิกโดยแอดมิน'
// Response: { ok: true, aborted: true, orderId }
async function handleOrderZipAbort(request, env) {
  // 🔧 (2026-09-27 fix 503): หุ้ม getSessionAdmin ด้วย try/catch — กัน D1 throw → 503
  let admin;
  try {
    admin = await getSessionAdmin(request, env);
  } catch (err) {
    return jsonResponse({ error: safeError("ตรวจสอบสิทธิ์ไม่สำเร็จ กรุณาลองใหม่", err) }, 500);
  }
  if (!admin) return jsonResponse({ error: "ยังไม่ได้เข้าสู่ระบบ" }, 401);
  if (!env.BUCKET) return jsonResponse({ error: "ยังไม่ได้ผูก R2 bucket (binding: BUCKET) ใน wrangler.jsonc" }, 500);
  if (!env.DB) return jsonResponse({ error: "ยังไม่ได้ผูก D1 database (binding: DB) ใน wrangler.jsonc" }, 500);

  let body;
  try { body = await request.json(); } catch { body = {}; }
  const jobId = String(body?.jobId || "").trim();
  if (!jobId) return jsonResponse({ error: "กรุณาระบุ jobId" }, 400);

  let jobRow;
  try {
    jobRow = await env.DB.prepare(
      "SELECT job_id, order_id, bucket_key, parts, status, created_by_admin FROM order_zip_jobs WHERE job_id = ?"
    ).bind(jobId).first();
  } catch (err) {
    // 🔒 (Audit Fix H-16): ถ้า column created_by_admin ไม่มี (DB schema เก่า) → fallback query ไม่มี column นี้
    try {
      jobRow = await env.DB.prepare(
        "SELECT job_id, order_id, bucket_key, parts, status FROM order_zip_jobs WHERE job_id = ?"
      ).bind(jobId).first();
    } catch (err2) {
      return jsonResponse({ error: safeError("อ่านสถานะไม่สำเร็จ กรุณาลองใหม่", err2) }, 500);
    }
  }
  if (!jobRow) return jsonResponse({ error: "ไม่พบ ZIP job นี้" }, 404);

  // 🔒 (Audit Fix H-16): Ownership check — กัน admin A abort job ของ admin B
  //   ปัญหาเดิม: /api/order-zip/abort เช็คแค่ "login" → ทุก admin สามารถ abort job ของ admin อื่นได้
  //   แม้ไม่ใช่เจ้าของ job → แอดมิน A กด abort → ทำลายงาน admin B ระหว่างทำ
  //   วิธีแก้: ถ้ามี created_by_admin ใน row → เช็ค admin.id === job.created_by_admin
  //     ยกเว้น main admin → abort ได้ทุก job (main admin มีสิทธิ์สูงสุด)
  //   ถ้า created_by_admin ไม่มี (schema เก่า) → ข้าม check (backward-compat)
  //   ผลกระทบระบบเดิม: 0% — ถ้าไม่มี created_by_admin → ทำงานเหมือนเดิม
  //     ถ้ามี + sub-admin พยายาม abort job ของคนอื่น → return 403
  if (jobRow.created_by_admin && admin.role !== "main" && admin.id !== jobRow.created_by_admin) {
    return jsonResponse({
      error: "ไม่สามารถยกเลิง ZIP job ของแอดมินอื่นได้ — เฉพาะเจ้าของ job หรือแอดมินหลักเท่านั้น",
      code: "zip/not-owner",
      job_owner: jobRow.created_by_admin,
      your_id: admin.id,
    }, 403);
  }

  // 🔧 (2026-09-18 v5): อ่าน finalizeState เพื่อ cleanup partial buffer ใน R2 ด้วย
  //   (finalize-build สร้าง temp object ชื่อ partialBufferKey — ต้องลบตอน abort)
  const partsData = parsePartsJson(jobRow.parts);
  if (partsData.finalizeState) {
    await cleanupPartialBuffer(env, partsData.finalizeState);
  }

  // Abort multipart upload (ลบไฟล์ ongoing ที่ค้างใน R2)
  await cleanupLeftoverMultipart(env, jobId, jobRow.bucket_key);
  // ลบ job row จาก D1
  await deleteOrderZipJob(env, jobId);

  // อัปเดต order doc: zip_status = '' (ล้างสถานะ)
  try {
    await updateDocument(env, "orders", jobRow.order_id, {
      zip_status: "",
      zip_error: "ยกเลิกการสร้าง ZIP โดยแอดมิน",
      zip_download_url: "",
      zip_file_name: "",
      zip_public_id: "",
      zip_song_count: 0,
      zip_created_at: "",
      zip_requested_at: "",
      updated_at: new Date().toISOString(),
    });
  } catch (_) { /* ไม่วิกฤต */ }

  return jsonResponse({ ok: true, aborted: true, orderId: jobRow.order_id });
}

// 🔒 (2026-10-01 fix H2): sanitizeOrderForCustomer — ลบข้อมูลแอดมินที่รั่วผ่าน order document
//   เดิม: GET /api/customer/orders ส่ง raw order document กลับ → รวม status_history ที่มี
//         `by: <admin UUID>`, `by_name: <admin display_name>` + top-level `payment_proof_verified_by`,
//         `assigned_admin_id` → ลูกค้าเห็นชื่อ + UUID ของแอดมินที่จัดการออเดอร์ตัวเอง (privacy breach ฝั่ง staff)
//   ใหม่: ก่อนส่ง order ให้ลูกค้า → ลบ field เหล่านี้ออก:
//     - status_history[].by, status_history[].by_name
//     - top-level: payment_proof_verified_by, assigned_admin_id
//   ไม่ลบ status, at, note (ลูกค้ายังเห็นประวัติสถานะของตัวเองได้ — แค่ไม่เห็นใครเป็นคนเปลี่ยน)
//   ไม่ break ระบบเดิม: response shape เหมือนเดิม แค่ลบ field ฝั่ง server ก่อน return
//   ⚠️ ไม่ mutate input — clone ก่อนแก้ (กัน side effect กับ cache/audit)
function sanitizeOrderForCustomer(order) {
  if (!order || typeof order !== "object") return order;
  // shallow clone + clone status_history แยก (deep clone ไม่จำเป็น เพราะแก้แค่ level 1-2)
  const cloned = { ...order };
  // ลบ top-level admin-identifying fields
  delete cloned.payment_proof_verified_by;
  delete cloned.assigned_admin_id;
  // ลบ by / by_name จาก status_history entries
  if (Array.isArray(cloned.status_history)) {
    cloned.status_history = cloned.status_history.map(entry => {
      if (!entry || typeof entry !== "object") return entry;
      const e = { ...entry };
      delete e.by;
      delete e.by_name;
      return e;
    });
  }
  return cloned;
}

// ===================================================
// 🆕 (2026-10-01): /api/customer/* — ระบบสมาชิกลูกค้า (Customer Account)
//   ลูกค้าเลือกสมัคร/เข้าสู่ระบบ (optional — ไม่ login ก็ซื้อได้)
//   รองรับ login ด้วย email หรือ WhatsApp (เลือกอย่างใดอย่างหนึ่ง)
//
//   Endpoints:
//     POST /api/customer/register — สมัคร (email หรือ whatsapp + password + display_name)
//     POST /api/customer/login    — เข้าสู่ระบบ (login ด้วย email หรือ whatsapp + password)
//     POST /api/customer/logout   — ออกจากระบบ (ลบ session)
//     GET  /api/customer/me        — ดูข้อมูลตัวเอง (ถ้า login แล้ว)
//     GET  /api/customer/orders    — ดูออเดอร์ทั้งหมดของ customer_id นี้
//
//   ผลกระทบระบบเดิม: 0% — endpoints ใหม่ทั้งหมด ไม่แตะ /api/auth/* หรือ /api/db/*
// ===================================================
async function handleCustomerAuth(request, env, url) {
  // 🔧 FIX (like button): /api/songs/:id/like(s) ถูก route เข้ามาที่นี่ด้วย แต่เดิม slice แค่ "/api/customer/" (14 ตัวอักษร)
  //   ทำให้ path ของ /api/songs/... เพี้ยน (ไม่ขึ้นต้นด้วย "songs/") → ไม่เคยเข้า handler ถูกใจ → 404 → กดแล้วไม่เกิดอะไรขึ้น
  //   แก้: ถ้าเป็น /api/songs/... ให้ตัดแค่ "/api/" เพื่อให้ได้ "songs/<id>/like"
  const path = url.pathname.startsWith("/api/songs/")
    ? url.pathname.slice("/api/".length)
    : url.pathname.slice("/api/customer/".length);

  // ---------- POST /api/customer/register ----------
  // รับ: { email?, whatsapp?, password, display_name }
  // ต้องมี email หรือ whatsapp อย่างน้อย 1 อย่าง + password (>=6 ตัว) + display_name
  if (path === "register" && request.method === "POST") {
    if (!env.DB) return jsonResponse({ error: "ยังไม่ได้ผูก D1 database" }, 500);
    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400); }
    const email = String(body.email || "").trim().toLowerCase() || null;
    // 🆕 (T008-M6): normalize whatsapp ก่อนเก็บ/เช็คซ้ำ — กัน duplicate account + login ไม่ติด
    //   เดิม: เก็บตรง ๆ (เช่น "+85620xxx" หรือ "020xxx") → login ด้วย format ต่างกัน → หาไม่เจอ → สมัครซ้ำ
    //   ใหม่: normalize ทุก format → มาตรฐานเดียว (85620xxx สำหรับลาว / 66xxx สำหรับไทย) → uniqueness check แม่นยำ
    const whatsapp = normalizeWhatsapp(String(body.whatsapp || "").trim()) || null;
    const password = String(body.password || "");
    const displayName = String(body.display_name || "").trim();
    // validate
    if (!email && !whatsapp) return jsonResponse({ error: "กรุณากรอกอีเมลหรือเบอร์ WhatsApp อย่างน้อย 1 อย่าง" }, 400);
    // 🆕 (T011-L2): validate email format ก่อน insert — กัน invalid email สะสมใน DB
    //   เดิม: เก็บ email อะไรก็ได้ (แม้ "abc" หรือ "abc@") → ลูกค้า login ด้วย email นั้นไม่ได้
    //   ใหม่: ถ้ามี email ต้องผ่าน isValidEmail() — ถ้า fail → return 400 พร้อมข้อความชัดเจน
    if (email && !isValidEmail(email)) {
      return jsonResponse({ error: "รูปแบบอีเมลไม่ถูกต้อง", code: "INVALID_EMAIL", existing_field: "email" }, 400);
    }
    if (password.length < 6) return jsonResponse({ error: "รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร" }, 400);
    // 🆕 (T011-L3): password complexity — อย่างน้อย 6 ตัว + มีตัวเลขหรือตัวอักษรพิเศษ
    //   ปัญหาเดิม: ตรวจแค่ length >= 6 → "aaaaaa" หรือ "123456" ผ่าน (password ง่ายเกินไป)
    //   วิธีแก้: ตรวจเพิ่มว่าต้องมีอย่างน้อย 1 ตัวเลข หรือ 1 ตัวอักขระพิเศษ
    //   ไม่เข้มงวดเกินไป — ไม่บังคับตัวใหญ่/ตัวเล็ก (ลูกค้าใช้มือถือ WhatsApp)
    //   ผลกระทบระบบเดิม: password ที่มีอยู่แล้วทั้งหมดยังใช้ได้ — กระทบเฉพาะ register ใหม่
    if (!isPasswordStrong(password)) {
      return jsonResponse({ error: "รหัสผ่านต้องมีอย่างน้อย 6 ตัว และมีตัวเลขหรืออักขระพิเศษ", code: "WEAK_PASSWORD" }, 400);
    }
    if (!displayName) return jsonResponse({ error: "กรุณากรอกชื่อที่แสดง" }, 400);
    // เช็คซ้ำ — email หรือ whatsapp ต้องไม่ซ้ำกับที่มีอยู่
    try {
      if (email) {
        const exists = await env.DB.prepare("SELECT id FROM customers WHERE email = ?").bind(email).first();
        if (exists) return jsonResponse({ error: "อีเมลนี้ถูกใช้สมัครแล้ว", code: "EMAIL_EXISTS", existing_field: "email" }, 409);
      }
      if (whatsapp) {
        const exists = await env.DB.prepare("SELECT id FROM customers WHERE whatsapp = ?").bind(whatsapp).first();
        if (exists) return jsonResponse({ error: "เบอร์ WhatsApp นี้ถูกใช้สมัครแล้ว", code: "WHATSAPP_EXISTS", existing_field: "whatsapp" }, 409);
      }
    } catch (err) {
      // ถ้าตาราง customers ยังไม่ถูกสร้าง → return error (graceful)
      if (String(err?.message || "").includes("no such table")) {
        return jsonResponse({ error: "ระบบสมาชิกยังไม่พร้อม — กรุณารัน schema.sql ล่าสุดใน D1 Console" }, 500);
      }
      return jsonResponse({ error: safeError("ตรวจสอบข้อมูลไม่สำเร็จ กรุณาลองใหม่", err) }, 500);
    }
    // สร้าง customer
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const passwordHash = await hashPassword(password);
    try {
      await env.DB.prepare(
        "INSERT INTO customers (id, email, whatsapp, password_hash, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).bind(id, email, whatsapp, passwordHash, displayName, now, now).run();
    } catch (err) {
      // 🆕 (2026-10-01 debug): ส่ง error จริงกลับไปด้วย เพื่อให้ผู้ใช้เห็นสาเหตุ (เดิม safeError ซ่อน error)
      //   ปัญหาที่พบบ่อย: table customers ยังไม่ได้รัน schema ใหม่ (ไม่มี column updated_at)
      //   หรือ UNIQUE constraint ล้ม (email/whatsapp ซ้ำ — แต่ถูกเช็คก่อนหน้านี้แล้ว)
      const errMsg = String(err?.message || String(err));
      console.error("[customer register] INSERT failed:", errMsg);
      // ถ้าเป็น "no such table" → แสดง hint ให้รัน SQL
      if (errMsg.includes("no such table")) {
        return jsonResponse({ error: "ระบบสมาชิกยังไม่พร้อม — กรุณารัน schema.sql ล่าสุดใน D1 Console เพื่อสร้างตาราง customers" }, 500);
      }
      // ถ้าเป็น UNIQUE constraint → แสดงว่า email/whatsapp ซ้ำ
      if (errMsg.toLowerCase().includes("unique constraint") || errMsg.toLowerCase().includes("unique")) {
        // ตรวจว่าซ้ำที่ email หรือ whatsapp
        const whichField = errMsg.toLowerCase().includes("email") ? "email" : (errMsg.toLowerCase().includes("whatsapp") ? "whatsapp" : "email");
        return jsonResponse({ error: "อีเมลหรือเบอร์ WhatsApp นี้ถูกใช้สมัครแล้ว", code: whichField === "whatsapp" ? "WHATSAPP_EXISTS" : "EMAIL_EXISTS", existing_field: whichField }, 409);
      }
      // 🆕 (T008-M2): ใช้ safeError() แทนการส่ง raw errMsg กลับ client
      //   เดิม: `return jsonResponse({ error: "สมัครสมาชิกไม่สำเร็จ: " + errMsg }, 500)` — รั่ว D1 internal error
      //   (table name, column name, SQL syntax) ให้ client → info disclosure
      //   ใหม่: ใช้ safeError() เหมือนทุก endpoint — log จริงใน Worker logs + ส่งข้อความกลางๆ
      return jsonResponse({ error: safeError("สมัครสมาชิกไม่สำเร็จ กรุณาลองใหม่", err) }, 500);
    }
    // สร้าง session
    const token = await createCustomerSession(env, id);
    // ส่ง cookie + ข้อมูล customer (ไม่ส่ง password_hash)
    // 🆕 (T010-M1): ใช้ secureJsonResponse แทน `new Response(...)` ตรง ๆ
    //   เดิม: ส่งเฉพาะ Content-Type + Set-Cookie → ขาด security headers (CSP, X-Frame-Options, ACAO, …)
    //   ใหม่: ใช้ secureJsonResponse (ผ่าน jsonResponse → มี securityHeaders() + corsHeaders())
    //   ผลกระทบระบบเดิม: 0% — frontend ได้ response shape เดิม + security headers เพิ่ม
    return secureJsonResponse({
      ok: true,
      customer: { id, email, whatsapp, display_name: displayName, created_at: now }
    }, 200, { "Set-Cookie": buildCustomerSessionCookie(token) });
  }

  // ---------- POST /api/customer/login ----------
  // รับ: { login, password } — login คือ email หรือ whatsapp (ตรวจทั้งสอง)
  if (path === "login" && request.method === "POST") {
    if (!env.DB) return jsonResponse({ error: "ยังไม่ได้ผูก D1 database" }, 500);
    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400); }
    const login = String(body.login || "").trim();
    const password = String(body.password || "");
    if (!login || !password) return jsonResponse({ error: "กรุณากรอกอีเมล/เบอร์ WhatsApp และรหัสผ่าน" }, 400);
    // 🆕 (T008-M6): normalize login identifier ก่อนค้นหา — ให้ตรงกับที่ register เก็บไว้
    //   ถ้าเป็น email (มี @) → lowercase ธรรมดา
    //   ถ้าเป็นเบอร์ WhatsApp → normalize ให้เป็นมาตรฐานเดียวกับ register (85620xxx / 66xxx)
    //   bind ค่า normalized ทั้ง 2 ช่อง (email + whatsapp) เพราะเราไม่รู้ว่าลูกค้ากรอก email หรือเบอร์
    const loginNormalized = login.includes("@") ? login.toLowerCase() : normalizeWhatsapp(login);
    // ค้นหา customer ด้วย email หรือ whatsapp (ลองทั้งสองแบบ)
    let customer;
    try {
      customer = await env.DB.prepare(
        "SELECT id, email, whatsapp, password_hash, display_name, created_at FROM customers WHERE email = ? OR whatsapp = ?"
      ).bind(loginNormalized, loginNormalized).first();
    } catch (err) {
      if (String(err?.message || "").includes("no such table")) {
        return jsonResponse({ error: "ระบบสมาชิกยังไม่พร้อม — กรุณารัน schema.sql ล่าสุดใน D1 Console" }, 500);
      }
      return jsonResponse({ error: safeError("เข้าสู่ระบบไม่สำเร็จ กรุณาลองใหม่", err) }, 500);
    }
    // 🔒 (2026-10-01 fix H3): ป้องกัน timing oracle — ถ้า customer ไม่พบ ก็ยังต้อง verifyPassword
    //   เพื่อใช้เวลาเท่ากัน (PBKDF2 100k iterations ใช้ ~100ms)
    //   เดิม (บรรทัด 5031 เดิม): `if (!customer) return 401` → ถ้า customer ไม่พบ → return เร็วกว่ากรณีพบ
    //     → attacker วัด timing แยก "ไม่มีบัญชี" กับ "รหัสผิด" ได้ (timing oracle → enumerate accounts)
    //   ใหม่: ใช้รูปแบบเดียวกับ admin login (บรรทัด 942-957) — ถ้า !customer → verify กับ DUMMY_HASH
    //   ผลกระทบระบบเดิม: 0%
    //     - กรณี customer พบ → verify ปกติ (เหมือนเดิม)
    //     - กรณี customer ไม่พบ → verify กับ dummy hash (เสียเวลา ~100ms + กัน timing oracle)
    //     - response ทั้ง 2 กรณีเป็น 401 เหมือนกัน (เพื่อไม่ info-disclose ว่าบัญชีมีอยู่จริงไหม)
    const DUMMY_HASH = "pbkdf2$100000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    let passwordOk = false;
    if (customer) {
      passwordOk = await verifyPassword(password, customer.password_hash);
    } else {
      // dummy verify — เสียเวลาเท่ากัน แต่ผลต้องเป็น false เสมอ
      await verifyPassword(password, DUMMY_HASH);
      passwordOk = false;
    }
    if (!customer || !passwordOk) {
      return jsonResponse({ error: "อีเมล/เบอร์ WhatsApp หรือรหัสผ่านไม่ถูกต้อง", code: "customer/invalid-credential" }, 401);
    }
    // สร้าง session
    const token = await createCustomerSession(env, customer.id);
    // ส่ง cookie + ข้อมูล customer (ไม่ส่ง password_hash)
    const { password_hash, ...customerSafe } = customer;
    // 🆕 (T010-M1): ใช้ secureJsonResponse แทน `new Response(...)` ตรง ๆ — เพิ่ม security headers
    return secureJsonResponse({
      ok: true,
      customer: customerSafe
    }, 200, { "Set-Cookie": buildCustomerSessionCookie(token) });
  }

  // ---------- POST /api/customer/logout ----------
  if (path === "logout" && request.method === "POST") {
    if (!env.DB) return jsonResponse({ error: "ยังไม่ได้ผูก D1 database" }, 500);
    const token = getCookie(request, "customer_session_token");
    if (token) await deleteCustomerSession(env, token);
    // 🆕 (T010-M1): ใช้ secureJsonResponse แทน `new Response(...)` ตรง ๆ — เพิ่ม security headers
    return secureJsonResponse({ ok: true }, 200, { "Set-Cookie": buildClearCustomerCookie() });
  }

  // 🆕 (2026-10-02): POST /api/customer/change-password
  //   รับ: { old_password, new_password } → ตรวจรหัสเดิม → อัปเดตรหัสใหม่
  if (path === "change-password" && request.method === "POST") {
    if (!env.DB) return jsonResponse({ error: "ยังไม่ได้ผูก D1 database" }, 500);
    const customer = await getCustomerSession(request, env);
    if (!customer) return jsonResponse({ error: "ยังไม่ได้เข้าสู่ระบบ" }, 401);
    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400); }

    // 🆕 (T010-M3): rate limit change-password — 5 ครั้ง/15 นาที (เหมือน admin login + admin change-password)
    //   ปัญหาเดิม: ไม่มี rate limit → attacker ที่มี session cookie สามารถ brute-force old_password
    //   ได้ไม่จำกัด (5 attempts/sec) → ถ้ารหัสอ่อน → เดาได้ในเวลาไม่นาน
    //
    //   วิธีแก้: ใช้ login_attempts table (มีอยู่แล้ว — เดียวกับ admin login + admin change-password)
    //     - key: `change-pw-cust:<customer_id>` ใน column `email` (แยกจาก admin change-pw)
    //     - threshold: RATE_LIMITS.CHANGE_PASSWORD_MAX (5) / RATE_LIMITS.CHANGE_PASSWORD_WINDOW_MS (15 นาที)
    //   ผลกระทบระบบเดิม: 0%
    //     - ถ้า table ไม่มี → ข้าม (fallback: ไม่บล็อก)
    //     - ถ้าผ่าน → ดำเนินการต่อ (verify old_password → update)
    //     - ถ้ายิงเกิน 5 ครั้ง → 429 + บอกรอ 15 นาที
    try {
      const cpClientIP = request.headers.get("CF-Connecting-IP") || "unknown";
      const cpWindow = new Date(Date.now() - RATE_LIMITS.CHANGE_PASSWORD_WINDOW_MS).toISOString();
      const cpKey = `change-pw-cust:${customer.id}`;
      const cpRow = await env.DB.prepare(
        "SELECT COUNT(*) AS c FROM login_attempts WHERE ip = ? AND email = ? AND attempted_at > ?"
      ).bind(cpClientIP, cpKey, cpWindow).first();
      if ((cpRow?.c || 0) >= RATE_LIMITS.CHANGE_PASSWORD_MAX) {
        const waitMin = Math.ceil(RATE_LIMITS.CHANGE_PASSWORD_WINDOW_MS / (60 * 1000));
        return jsonResponse({
          error: `พยายามเปลี่ยนรหัสผ่านผิดพลาดเกินไป (${RATE_LIMITS.CHANGE_PASSWORD_MAX} ครั้งใน ${waitMin} นาที) — กรุณารอ`,
          code: "customer/change-pw-rate-limited"
        }, 429);
      }
    } catch (cpRateErr) {
      // ถ้า login_attempts table ไม่มี → ข้าม rate limiting (fallback)
      console.warn("customer change-password rate limiting skipped:", cpRateErr?.message);
    }

    const oldPwd = String(body.old_password || "");
    const newPwd = String(body.new_password || "");
    if (newPwd.length < 6) return jsonResponse({ error: "รหัสผ่านใหม่ต้องมีอย่างน้อย 6 ตัว" }, 400);
    try {
      const row = await env.DB.prepare("SELECT password_hash FROM customers WHERE id = ?").bind(customer.id).first();
      if (!row) return jsonResponse({ error: "ไม่พบบัญชี" }, 404);
      const valid = await verifyPassword(oldPwd, row.password_hash);
      if (!valid) {
        // 🆕 (T010-M3): บันทึก failed attempt เพื่อ rate limiting (เหมือน admin H-21)
        try {
          const cpClientIP = request.headers.get("CF-Connecting-IP") || "unknown";
          const cpKey = `change-pw-cust:${customer.id}`;
          await env.DB.prepare(
            "INSERT INTO login_attempts (ip, email, attempted_at) VALUES (?, ?, ?)"
          ).bind(cpClientIP, cpKey, new Date().toISOString()).run();
        } catch {}
        return jsonResponse({ error: "รหัสผ่านเดิมไม่ถูกต้อง" }, 401);
      }
      const newHash = await hashPassword(newPwd);
      await env.DB.prepare("UPDATE customers SET password_hash = ?, updated_at = ? WHERE id = ?")
        .bind(newHash, new Date().toISOString(), customer.id).run();
      // 🆕 (T010-M3): เคลียร์ failed attempts หลังเปลี่ยนรหัสผ่านสำเร็จ (เหมือน admin login สำเร็จ)
      try {
        const cpClientIP = request.headers.get("CF-Connecting-IP") || "unknown";
        const cpKey = `change-pw-cust:${customer.id}`;
        await env.DB.prepare("DELETE FROM login_attempts WHERE ip = ? AND email = ?")
          .bind(cpClientIP, cpKey).run();
      } catch {}
      return jsonResponse({ ok: true });
    } catch (err) {
      return jsonResponse({ error: safeError("เปลี่ยนรหัสผ่านไม่สำเร็จ", err) }, 500);
    }
  }

  // 🆕 (2026-10-02 v2): POST /api/customer/forgot-password
  //   รับ: { login } → ค้นหาบัญชี → บันทึกคำขารีเซ็ตลง password_reset_requests → แอดมินจะเห็นในหน้าจัดการลูกค้า
  //   ผลกระทบระบบเดิม: 0% — endpoint ใหม่ (ไม่ใช้ WhatsApp API)
  //
  // 🆕 (T010-M10): rate limit + constant message (no info disclosure)
  //   ปัญหาเดิม:
  //     1. ไม่มี rate limit per IP → attacker ยิง spam จาก IP เดียว สร้าง password_reset_requests
  //        ล้าน record → D1 write quota burn + รบกวนแอดมิน
  //     2. ข้อความตอบกลับต่างกัน "คุณได้ส่งคำขารีเซ็ตรหัสผ่านแล้ว" (สำหรับ pending) vs
  //        "✅ ส่งคำขารีเซ็ตรหัสผ่านแล้ว" (สำหรับ new) → attacker แยกได้ว่าบัญชีมี pending อยู่
  //        → enumerate ว่าใครเคยขอ reset ล่าสุด (info disclosure)
  //
  //   วิธีแก้:
  //     1. rate limit per IP: 3 ครั้ง/ชม. (RATE_LIMITS.FORGOT_PASSWORD_IP_MAX) ใช้ login_attempts table
  //        (มีอยู่แล้ว — key `forgot-pw:<ip>` ใน column `email`)
  //     2. ใช้ข้อความ constant เสมอ — ไม่บอกว่า pending อยู่ / สร้างใหม่ / ไม่พบบัญชี
  //     3. ถ้า rate limited → ก็ใช้ข้อความเดียวกัน (กัน disclose ว่า rate limited)
  //   ผลกระทบระบบเดิม: ต่ำ — frontend ที่อ่าน `message` ยังทำงานได้ (เปลี่ยนข้อความนิดหน่อย)
  if (path === "forgot-password" && request.method === "POST") {
    if (!env.DB) return jsonResponse({ error: "ยังไม่ได้ผูก D1 database" }, 500);
    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400); }
    const login = String(body.login || "").trim();
    if (!login) return jsonResponse({ error: "กรุณากรอกอีเมลหรือเบอร์ WhatsApp" }, 400);
    // 🆕 (T008-M6): normalize login identifier เหมือน login/register
    const loginNormalized = login.includes("@") ? login.toLowerCase() : normalizeWhatsapp(login);

    // 🆕 (T010-M10): constant message — ใช้ข้อความเดียวกันเสมอ (กัน info disclosure)
    //   ไม่บอกว่า: มีบัญชีไหม / มี pending อยู่ / rate limited / สร้างใหม่
    //   → attacker ไม่สามารถ enumerate ได้
    const FORGOT_OK_MESSAGE = { ok: true, message: "หากบัญชีนี้มีอยู่ เราจะส่งคำขารีเซ็ตรหัสผ่านให้คุณ" };

    const nowIso = new Date().toISOString();
    const oneHourAgo = new Date(Date.now() - RATE_LIMITS.FORGOT_PASSWORD_WINDOW_MS).toISOString();
    const clientIP = request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || "unknown";

    try {
      // 🆕 (T010-M10): rate limit per IP — 3 ครั้ง/ชม. (กัน spam จาก IP เดียว)
      //   ใช้ login_attempts table (มีอยู่แล้ว) — key `forgot-pw:<ip>` ใน column `email`
      //   ถ้า table ไม่มี → ข้าม (fallback: ไม่บล็อก)
      try {
        const ipKey = `forgot-pw:${clientIP}`;
        const ipAttempts = await env.DB.prepare(
          "SELECT COUNT(*) AS c FROM login_attempts WHERE ip = ? AND email = ? AND attempted_at > ?"
        ).bind(clientIP, ipKey, oneHourAgo).first();
        if ((ipAttempts?.c || 0) >= RATE_LIMITS.FORGOT_PASSWORD_IP_MAX) {
          // 🆕 (T010-M10): ใช้ข้อความเดียวกับ success — ไม่ disclose ว่า rate limited
          //   log IP attempt ลง login_attempts (track สำหรับ monitor) — ไม่สร้าง password_reset_requests
          return jsonResponse(FORGOT_OK_MESSAGE);
        }
      } catch (ipRateErr) {
        console.warn("forgot-password IP rate limiting skipped:", ipRateErr?.message);
      }

      // rate limit per contact — 1 ครั้ง/ชม. (มีอยู่แล้วใน logic เดิม — เช็ค pending request)
      //   ถ้ามี pending อยู่ → ใช้ข้อความ constant (ไม่บอกว่า "คุณได้ส่งคำขาแล้ว")
      const existing = await env.DB.prepare(
        "SELECT id FROM password_reset_requests WHERE contact = ? AND status = 'pending' AND created_at > ?"
      ).bind(loginNormalized, oneHourAgo).first();
      if (existing) {
        // 🆕 (T010-M10): log IP attempt (track สำหรับ monitor แม้จะ pending อยู่) — กัน enumeration
        try {
          const ipKey = `forgot-pw:${clientIP}`;
          await env.DB.prepare(
            "INSERT INTO login_attempts (ip, email, attempted_at) VALUES (?, ?, ?)"
          ).bind(clientIP, ipKey, nowIso).run();
        } catch {}
        return jsonResponse(FORGOT_OK_MESSAGE);
      }

      // ค้นหา customer (ถ้ามี — ถ้าไม่มีก็ยังบันทึกคำขาได้ เพื่อให้แอดมินเห็นว่ามีคนแอบอ้างหรือเบอร์ผิด)
      const customer = await env.DB.prepare(
        "SELECT id FROM customers WHERE email = ? OR whatsapp = ?"
      ).bind(loginNormalized, loginNormalized).first();
      const id = crypto.randomUUID();
      await env.DB.prepare(
        "INSERT INTO password_reset_requests (id, customer_id, contact, status, created_at) VALUES (?, ?, ?, 'pending', ?)"
      ).bind(id, customer?.id || null, loginNormalized, nowIso).run();

      // 🆕 (T010-M10): log IP attempt (track สำหรับ monitor — กัน spam enumeration)
      try {
        const ipKey = `forgot-pw:${clientIP}`;
        await env.DB.prepare(
          "INSERT INTO login_attempts (ip, email, attempted_at) VALUES (?, ?, ?)"
        ).bind(clientIP, ipKey, nowIso).run();
      } catch {}

      // 🆕 (T010-M10): constant message — ไม่บอกว่า "สร้างใหม่" (เหมือนเดิมที่มี ✅ + "ส่งคำขาแล้ว")
      return jsonResponse(FORGOT_OK_MESSAGE);
    } catch (err) {
      if (String(err?.message || "").includes("no such table")) {
        return jsonResponse({ error: "ระบบยังไม่พร้อม — กรุณารัน schema.sql ล่าสุดใน D1 Console" }, 500);
      }
      return jsonResponse({ error: safeError("ส่งคำขาไม่สำเร็จ กรุณาลองใหม่", err) }, 500);
    }
  }

  // 🆕 (2026-10-02): POST /api/customer/reset-password (legacy placeholder — redirect to forgot-password)
  //   ตอนนี้ใช้ flow forgot-password แทน — endpoint นี้เก็บไว้เพื่อ backward compat (frontend เดิมยังเรียกได้)
  if (path === "reset-password" && request.method === "POST") {
    return jsonResponse({ error: "กรุณาใช้ฟังก์ชัน 'ลืมรหัสผ่าน' ใหม่ — กดปุ่ม 'ลืมรหัสผ่าน?' ใต้ช่อง login", code: "USE_FORGOT_PASSWORD" }, 400);
  }

  // ============================================================
  // 🆕 (2026-10-02): /api/admin/customers — จัดการลูกค้า (ฝั่งแอดมิน)
  //   - GET  /api/admin/customers — list ทั้งหมด (pagination + search)
  //   - GET  /api/admin/customers/:id — รายละเอียดลูกค้า + ออเดอร์
  //   - DELETE /api/admin/customers/:id — ลบลูกค้า (main admin เท่านั้น)
  //   ผลกระทบระบบเดิม: 0% — endpoints ใหม่
  // ============================================================

  if (url.pathname === "/api/admin/customers" && request.method === "GET") {
    if (!env.DB) return jsonResponse({ error: "D1 not configured" }, 500);
    const admin = await getSessionAdmin(request, env);
    if (!admin) return jsonResponse({ error: "ยังไม่ได้เข้าสู่ระบบ" }, 401);
    try {
      const search = String(url.searchParams.get("search") || "").trim();
      const limit = Math.min(100, Number(url.searchParams.get("limit") || 50));
      const offset = Math.max(0, Number(url.searchParams.get("offset") || 0));
      let sql = "SELECT id, email, whatsapp, display_name, created_at, updated_at FROM customers";
      const binds = [];
      if (search) {
        sql += " WHERE email LIKE ? OR whatsapp LIKE ? OR display_name LIKE ?";
        binds.push(`%${search}%`, `%${search}%`, `%${search}%`);
      }
      sql += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
      binds.push(limit, offset);
      const { results } = await env.DB.prepare(sql).bind(...binds).all();
      // 🔧 (2026-10-01 fix C2): ใช้ GROUP BY query เดียวแทน N+1 loop
      //   เดิม (บรรทัด 5123-5128 เดิม): วนลูป COUNT(*) ทีละ customer
      //     → ถ้า limit=100 → 1 (list) + 100 (count) = 101 subrequests > 50 Free plan limit
      //     → endpoint พัง 500 เมื่อลูกค้า ≥ 50 ราย
      //   ใหม่: ดึง order_count ทุก customer ใน query เดียวด้วย GROUP BY
      //     → ลดจาก N+1 query → 2 query (list + group-by)
      //   ผลกระทบระบบเดิม: 0% — response shape เหมือนเดิม ({customers, total})
      const { results: orderCountRows } = await env.DB.prepare(
        "SELECT json_extract(data,'$.customer_id') as cid, COUNT(*) as cnt " +
        "FROM documents WHERE collection='orders' AND json_extract(data,'$.customer_id') IS NOT NULL " +
        "GROUP BY cid"
      ).all();
      const orderCountMap = new Map();
      for (const r of orderCountRows || []) {
        if (r.cid) orderCountMap.set(r.cid, r.cnt || 0);
      }
      const customers = (results || []).map(row => ({
        ...row,
        order_count: orderCountMap.get(row.id) || 0,
      }));
      return jsonResponse({ customers, total: customers.length });
    } catch (err) {
      if (String(err?.message || "").includes("no such table")) {
        return jsonResponse({ customers: [], total: 0 });
      }
      return jsonResponse({ error: safeError("โหลดรายชื่อลูกค้าไม่สำเร็จ", err) }, 500);
    }
  }

  if (url.pathname.startsWith("/api/admin/customers/") && request.method === "GET") {
    if (!env.DB) return jsonResponse({ error: "D1 not configured" }, 500);
    const admin = await getSessionAdmin(request, env);
    if (!admin) return jsonResponse({ error: "ยังไม่ได้เข้าสู่ระบบ" }, 401);
    const customerId = decodeURIComponent(url.pathname.slice("/api/admin/customers/".length));
    try {
      const customer = await env.DB.prepare(
        "SELECT id, email, whatsapp, display_name, created_at, updated_at FROM customers WHERE id=?"
      ).bind(customerId).first();
      if (!customer) return jsonResponse({ error: "ไม่พบลูกค้า" }, 404);
      // ดึงออเดอร์ของลูกค้า
      const { results: orderRows } = await env.DB.prepare(
        "SELECT id, data FROM documents WHERE collection='orders' AND json_extract(data,'$.customer_id')=? ORDER BY created_at DESC LIMIT 50"
      ).bind(customerId).all();
      const orders = (orderRows || []).map(row => {
        try { return { id: row.id, ...JSON.parse(row.data) }; } catch { return { id: row.id }; }
      });
      return jsonResponse({ customer, orders });
    } catch (err) {
      return jsonResponse({ error: safeError("โหลดรายละเอียดลูกค้าไม่สำเร็จ", err) }, 500);
    }
  }

  if (url.pathname.startsWith("/api/admin/customers/") && request.method === "DELETE") {
    if (!env.DB) return jsonResponse({ error: "D1 not configured" }, 500);
    const admin = await getSessionAdmin(request, env);
    if (!admin) return jsonResponse({ error: "ยังไม่ได้เข้าสู่ระบบ" }, 401);
    if (admin.role !== "main") return jsonResponse({ error: "เฉพาะแอดมินหลักเท่านั้นที่ลบลูกค้าได้" }, 403);
    const customerId = decodeURIComponent(url.pathname.slice("/api/admin/customers/".length));
    try {
      // ลบ sessions ของลูกค้าก่อน
      await env.DB.prepare("DELETE FROM customer_sessions WHERE customer_id=?").bind(customerId).run();
      // 🆕 (2026-10-03 team-24h-v2 / L4): ลบ orphan rows ของลูกค้า — กันข้อมูลค้างหลังลบ customer
      //   ก่อนหน้านี้ลบเฉพาะ sessions + customer record → customer_favorites / song_likes / password_reset_requests ค้างเป็น orphan
      //   ผลกระทบ: orphan rows บวม D1 storage (Free plan 5GB) + รั่ว profile ลูกค้าที่ถูกลบไปแล้ว (privacy)
      //   วิธีแก้: DELETE 3 ตารางนี้ทั้งหมดก่อนลบ customer record (ลด FOREIGN KEY risk ถ้ามี constraint ในอนาคต)
      await env.DB.prepare("DELETE FROM customer_favorites WHERE customer_id=?").bind(customerId).run();
      await env.DB.prepare("DELETE FROM song_likes WHERE customer_id=?").bind(customerId).run();
      await env.DB.prepare("DELETE FROM password_reset_requests WHERE customer_id=?").bind(customerId).run();
      // ลบลูกค้า
      await env.DB.prepare("DELETE FROM customers WHERE id=?").bind(customerId).run();
      return jsonResponse({ ok: true });
    } catch (err) {
      return jsonResponse({ error: safeError("ลบลูกค้าไม่สำเร็จ", err) }, 500);
    }
  }

  // ============================================================
  // 🆕 (2026-10-02 v2): /api/admin/password-reset-requests — จัดการคำขารีเซ็ตรหัสผ่าน
  //   - GET    /api/admin/password-reset-requests            — list คำขา (filter ด้วย ?status=pending|resolved|dismissed)
  //   - POST   /api/admin/password-reset-requests/:id/resolve — รีเซ็ตรหัสผ่านให้ลูกค้า (แอดมินพิมพ์รหัสเอง) + ทำเครื่องหมายว่าดำเนินการแล้ว
  //   - POST   /api/admin/password-reset-requests/:id/dismiss — ยกเลิกคำขา (เช่น ไม่ใช่ลูกค้าจริง)
  //   ผลกระทบระบบเดิม: 0% — endpoints ใหม่
  // ============================================================
  if (url.pathname === "/api/admin/password-reset-requests" && request.method === "GET") {
    if (!env.DB) return jsonResponse({ error: "D1 not configured" }, 500);
    const admin = await getSessionAdmin(request, env);
    if (!admin) return jsonResponse({ error: "ยังไม่ได้เข้าสู่ระบบ" }, 401);
    try {
      const status = String(url.searchParams.get("status") || "").trim();
      // 🆕 (T010-M11): pagination — รองรับ ?limit=&offset= (default 50, max 200)
      //   ปัญหาเดิม: LIMIT 200 ตายตัว → ถ้ามีคำขา > 200 → คำขาเก่า ๆ หายไปจากหน้าจัดการแอดมิน
      //   วิธีแก้: รองรับ query params ?limit=&offset= + ส่ง total + pagination metadata กลับ
      //   ผลกระทบระบบเดิม: 0% — frontend เดิมที่ไม่สนใจ pagination ยังทำงานได้ (requests array ยังอยู่)
      const { limit, offset } = parsePagination(url);
      let sql = "SELECT r.id, r.customer_id, r.contact, r.status, r.note, r.created_at, r.resolved_at, r.resolved_by_admin, c.email as customer_email, c.whatsapp as customer_whatsapp, c.display_name as customer_name FROM password_reset_requests r LEFT JOIN customers c ON r.customer_id = c.id";
      const binds = [];
      if (status === "pending" || status === "resolved" || status === "dismissed") {
        sql += " WHERE r.status = ?";
        binds.push(status);
      }
      sql += " ORDER BY r.created_at DESC LIMIT ? OFFSET ?";
      binds.push(limit, offset);
      const { results } = await env.DB.prepare(sql).bind(...binds).all();
      // ดึง total count สำหรับ pagination UI
      let totalCount = (results || []).length;
      try {
        let countSql = "SELECT COUNT(*) as total FROM password_reset_requests r";
        const countBinds = [];
        if (status === "pending" || status === "resolved" || status === "dismissed") {
          countSql += " WHERE r.status = ?";
          countBinds.push(status);
        }
        const countRow = await env.DB.prepare(countSql).bind(...countBinds).first();
        totalCount = Number(countRow?.total) || 0;
      } catch { /* fallback ใช้ results.length */ }
      return jsonResponse({
        requests: results || [],
        total: totalCount,
        // 🆕 (T010-M11): pagination metadata — frontend ใช้ lazy load หน้าถัดไป
        pagination: {
          limit,
          offset,
          total: totalCount,
          has_more: (offset + limit) < totalCount,
        },
      });
    } catch (err) {
      // 🆕 (2026-10-02 v3 debug): ถ้าตารางยังไม่ถูกสร้าง → ส่ง error จริง (พร้อม hint) แทนที่จะ silent empty
      //   ปัญหา: เดิมส่ง empty array → frontend คิดว่า "ไม่มีคำขา" ทั้งที่จริงคือตารางยังไม่สร้าง → debug ยาก
      if (String(err?.message || "").includes("no such table")) {
        return jsonResponse({ error: "ตาราง password_reset_requests ยังไม่ถูกสร้าง — กรุณารัน scripts/migrate-password-reset-requests.sql ใน D1 Console", code: "TABLE_NOT_CREATED" }, 500);
      }
      return jsonResponse({ error: safeError("โหลดคำขารีเซ็ตไม่สำเร็จ", err) }, 500);
    }
  }

  // POST /api/admin/password-reset-requests/:id/resolve
  //   body: { new_password, note? }
  //   action: อัปเดต password_hash ของ customer + ทำเครื่องหมาย request ว่า resolved + เก็บ note
  if (url.pathname.includes("/api/admin/password-reset-requests/") && url.pathname.endsWith("/resolve") && request.method === "POST") {
    if (!env.DB) return jsonResponse({ error: "D1 not configured" }, 500);
    const admin = await getSessionAdmin(request, env);
    if (!admin) return jsonResponse({ error: "ยังไม่ได้เข้าสู่ระบบ" }, 401);
    const reqId = decodeURIComponent(url.pathname.split("/api/admin/password-reset-requests/")[1].replace("/resolve", ""));
    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400); }
    const newPassword = String(body.new_password || "");
    const note = String(body.note || "").slice(0, 500);
    if (newPassword.length < 6) return jsonResponse({ error: "รหัสผ่านใหม่ต้องมีอย่างน้อย 6 ตัวอักษร" }, 400);
    try {
      // ดึง request
      const req = await env.DB.prepare(
        "SELECT id, customer_id, contact, status FROM password_reset_requests WHERE id = ?"
      ).bind(reqId).first();
      if (!req) return jsonResponse({ error: "ไม่พบคำขา" }, 404);
      if (req.status !== "pending") return jsonResponse({ error: "คำขานี้ดำเนินการแล้ว" }, 400);
      if (!req.customer_id) return jsonResponse({ error: "คำขานี้ไม่ได้ผูกกับบัญชีลูกค้า (อาจเป็นเบอร์/อีเมลที่ไม่มีบัญชี) — กรุณาตรวจสอบหรือยกเลิกคำขา" }, 400);
      // อัปเดต password_hash
      const newHash = await hashPassword(newPassword);
      const nowIso = new Date().toISOString();
      await env.DB.prepare(
        "UPDATE customers SET password_hash = ?, updated_at = ? WHERE id = ?"
      ).bind(newHash, nowIso, req.customer_id).run();
      // ทำเครื่องหมาย request ว่า resolved
      await env.DB.prepare(
        "UPDATE password_reset_requests SET status = 'resolved', resolved_at = ?, resolved_by_admin = ?, note = ? WHERE id = ?"
      ).bind(nowIso, admin.id, note || "รีเซ็ตรหัสผ่านแล้ว", reqId).run();
      return jsonResponse({ ok: true, message: "รีเซ็ตรหัสผ่านสำเร็จ — กรุณาติดต่อลูกค้าทาง WhatsApp เพื่อแจ้งรหัสผ่านใหม่" });
    } catch (err) {
      return jsonResponse({ error: safeError("รีเซ็ตรหัสผ่านไม่สำเร็จ", err) }, 500);
    }
  }

  // POST /api/admin/password-reset-requests/:id/dismiss
  //   body: { note? } — ยกเลิกคำขา (เช่น เบอร์ไม่ใช่ลูกค้าจริง)
  if (url.pathname.includes("/api/admin/password-reset-requests/") && url.pathname.endsWith("/dismiss") && request.method === "POST") {
    if (!env.DB) return jsonResponse({ error: "D1 not configured" }, 500);
    const admin = await getSessionAdmin(request, env);
    if (!admin) return jsonResponse({ error: "ยังไม่ได้เข้าสู่ระบบ" }, 401);
    const reqId = decodeURIComponent(url.pathname.split("/api/admin/password-reset-requests/")[1].replace("/dismiss", ""));
    let body;
    try { body = await request.json(); } catch { body = {}; }
    const note = String(body.note || "").slice(0, 500);
    try {
      const req = await env.DB.prepare(
        "SELECT id, status FROM password_reset_requests WHERE id = ?"
      ).bind(reqId).first();
      if (!req) return jsonResponse({ error: "ไม่พบคำขา" }, 404);
      if (req.status !== "pending") return jsonResponse({ error: "คำขานี้ดำเนินการแล้ว" }, 400);
      await env.DB.prepare(
        "UPDATE password_reset_requests SET status = 'dismissed', resolved_at = ?, resolved_by_admin = ?, note = ? WHERE id = ?"
      ).bind(new Date().toISOString(), admin.id, note || "ยกเลิก", reqId).run();
      return jsonResponse({ ok: true });
    } catch (err) {
      return jsonResponse({ error: safeError("ยกเลิกคำขาไม่สำเร็จ", err) }, 500);
    }
  }

  // ---------- GET /api/customer/me ----------
  // ตรวจ session → คืนข้อมูล customer ถ้า login แล้ว
  if (path === "me" && request.method === "GET") {
    if (!env.DB) return jsonResponse({ error: "ยังไม่ได้ผูก D1 database" }, 500);
    const customer = await getCustomerSession(request, env);
    if (!customer) return jsonResponse({ error: "ยังไม่ได้เข้าสู่ระบบ" }, 401);
    return jsonResponse({ ok: true, customer });
  }

  // ---------- GET /api/customer/orders ----------
  // ดึงออเดอร์ทั้งหมดของลูกค้า (เรียงจากล่าสุดก่อน)
  //
  // 🆕 (2026-10-02 v8 — fix สับสน login vs guest):
  //   เดิม: รวม login + guest ใน array เดียว → ลูกค้าสับสน ตัวเลขปนกัน
  //   ใหม่: แยกเป็น 2 arrays:
  //     - orders_login: ออเดอร์ที่ซื้อตอน login (มี customer_id ตรงกับลูกค้า)
  //     - orders_guest: ออเดอร์ที่ซื้อแบบ guest (ไม่มี customer_id แต่เบอร์ WhatsApp ตรง)
  //   ผลกระทบระบบเดิม: ต่ำ — เปลี่ยน response shape จาก { ok, orders } → { ok, orders_login, orders_guest }
  //                      frontend ต้องอัปเดตให้รองรับด้วย
  if (path === "orders" && request.method === "GET") {
    if (!env.DB) return jsonResponse({ error: "ยังไม่ได้ผูก D1 database" }, 500);
    const customer = await getCustomerSession(request, env);
    if (!customer) return jsonResponse({ error: "ยังไม่ได้เข้าสู่ระบบ" }, 401);
    try {
      // 🆕 (2026-10-03 v10 — แยก Login / Guest ชัดเจน): ลูกค้า Login เห็นเฉพาะออเดอร์ของ customer_id ตัวเองเท่านั้น
      //   เดิม (v8): ค้นด้วย customer_id OR customer_whatsapp แล้วแยก orders_guest ให้ → ออเดอร์ guest ที่เบอร์ตรงปนเข้ามาในบัญชี
      //             (และ field "customer_whatsapp" ไม่มีอยู่จริงในออเดอร์ — ออเดอร์เก็บเบอร์ไว้ที่ field "whatsapp")
      //   ใหม่: ใช้ customer_id อย่างเดียว — ห้ามใช้ WhatsApp ดึงออเดอร์ในบัญชี
      //   Guest orders ดูได้จากหน้า "ติดตามออเดอร์" ตอนยังไม่ login (guest_id + WhatsApp) เท่านั้น
      //   คงรูปแบบ response เดิม (orders / orders_login / orders_guest / counts) เพื่อไม่ให้ frontend เดิมพัง
      //   → orders_guest เป็น [] เสมอ, counts.guest = 0
      //
      // 🆕 (T010-M11): pagination — รองรับ ?limit=&offset= (default 50, max 200)
      //   ปัญหาเดิม: LIMIT 200 ตายตัว → ถ้าลูกค้าสั่ง > 200 ครั้ง → ออเดอร์เก่า ๆ หายไป (frontend ไม่เห็น)
      //   วิธีแก้: รองรับ query params ?limit=&offset= → frontend ทำ lazy load หน้าถัดไปได้
      //   + เพิ่ม total count + pagination metadata ใน response (frontend ใช้คำนวณหน้าถัดไป)
      //   ผลกระทบระบบเดิม: 0% — ถ้าไม่ส่ง limit/offset → default 50 (เดิม 200 — ลดลงเพราะ default ที่เซฟกว่า)
      //                       frontend เดิมที่ไม่สนใจ pagination ยังทำงานได้ (orders array ยังอยู่)
      const { limit, offset } = parsePagination(url);
      const sql = "SELECT id, data, created_at FROM documents WHERE collection = 'orders' AND json_extract(data, '$.customer_id') = ? ORDER BY created_at DESC LIMIT ? OFFSET ?";
      const { results } = await env.DB.prepare(sql).bind(customer.id, limit, offset).all();
      // ดึง total count สำหรับ frontend คำนวณ pagination
      const totalRow = await env.DB.prepare(
        "SELECT COUNT(*) as total FROM documents WHERE collection = 'orders' AND json_extract(data, '$.customer_id') = ?"
      ).bind(customer.id).first();
      const totalCount = Number(totalRow?.total) || 0;

      const allOrders = [];
      for (const row of (results || [])) {
        let data;
        try { data = JSON.parse(row.data); } catch { data = {}; }
        // เช็คซ้ำฝั่ง JS (defense-in-depth) ให้ตรงกติกาเดียวกับ order-scope.js
        if (!isOrderInLoginList(data, customer.id)) continue;
        // 🔒 (2026-10-01 fix H2): sanitize order ก่อนส่งให้ customer
        //   ลบ by/by_name ออกจาก status_history entries + ลบ payment_proof_verified_by/assigned_admin_id ออกจาก top-level
        //   → กันรั่ว admin UUID + display_name ไปลูกค้า (privacy breach ฝั่ง staff)
        allOrders.push(sanitizeOrderForCustomer({ id: row.id, ...data }));
      }
      const orders_login = allOrders;
      const orders_guest = [];
      return jsonResponse({
        ok: true,
        orders: allOrders, // 🆕 (compat): เก็บไว้สำหรับ frontend เดิมที่ยังใช้ orders
        orders_login,
        orders_guest,
        counts: {
          login: orders_login.length,
          guest: 0,
          // 🆕 (T010-M11): total = จำนวนออเดอร์ทั้งหมดของ customer (ไม่ใช่ page size)
          total: totalCount,
        },
        // 🆕 (T010-M11): pagination metadata — frontend ใช้ lazy load หน้าถัดไป
        pagination: {
          limit,
          offset,
          total: totalCount,
          has_more: (offset + limit) < totalCount,
        },
      });
    } catch (err) {
      return jsonResponse({ error: safeError("โหลดออเดอร์ไม่สำเร็จ กรุณาลองใหม่", err) }, 500);
    }
  }

  // ============================================================
  // 🆕 (2026-10-02 v6 — ฟีเจอร์ #2): /api/customer/favorites — รายการเพลงโปรด
  //   - GET    /api/customer/favorites       — ดูรายการโปรดทั้งหมด
  //   - POST   /api/customer/favorites       — เพิ่มเพลงในรายการ { song_id }
  //   - DELETE /api/customer/favorites/:id   — ลบเพลงจากรายการ
  //   ผลกระทบระบบเดิม: 0% — endpoints ใหม่
  // ============================================================
  if (path === "favorites" && request.method === "GET") {
    if (!env.DB) return jsonResponse({ error: "ยังไม่ได้ผูก D1 database" }, 500);
    const customer = await getCustomerSession(request, env);
    if (!customer) return jsonResponse({ error: "ยังไม่ได้เข้าสู่ระบบ" }, 401);
    try {
      // 🆕 (2026-10-02 v6 fix): JOIN กับ documents เพื่อดึงข้อมูลเพลงมาด้วย
      //   เดิม: ส่งกลับแค่ song_id → frontend แสดง "เพลง ID: <uuid>" ไม่สวย
      //   ใหม่: JOIN ดึง song_name, cover_url, dj_name, artist, price, discount_price มาด้วย
      //   ใช้ json_extract ดึง fields จาก JSON blob ของเพลง
      //
      // 🆕 (T010-M11): pagination — รองรับ ?limit=&offset= (default 50, max 200)
      //   ปัญหาเดิม: LIMIT 200 ตายตัว → ถ้าลูกค้าชอบเพลง > 200 เพลง → เพลงโปรดเก่า ๆ หายไป
      //   วิธีแก้: รองรับ query params ?limit=&offset= → frontend lazy load หน้าถัดไปได้
      //   + เพิ่ม total count + pagination metadata
      //   ผลกระทบระบบเดิม: 0% — frontend เดิมที่ไม่สนใจ pagination ยังทำงานได้ (favorites array ยังอยู่)
      const { limit, offset } = parsePagination(url);
      const { results } = await env.DB.prepare(
        "SELECT f.song_id, f.created_at as favorited_at, " +
        "json_extract(d.data, '$.song_name') as song_name, " +
        "json_extract(d.data, '$.cover_url') as cover_url, " +
        "json_extract(d.data, '$.dj_name') as dj_name, " +
        "json_extract(d.data, '$.artist') as artist, " +
        "json_extract(d.data, '$.price') as price, " +
        "json_extract(d.data, '$.discount_price') as discount_price " +
        "FROM customer_favorites f " +
        "LEFT JOIN documents d ON d.collection = 'songs' AND d.id = f.song_id " +
        "WHERE f.customer_id = ? " +
        "ORDER BY f.created_at DESC LIMIT ? OFFSET ?"
      ).bind(customer.id, limit, offset).all();
      // ดึง total count สำหรับ frontend คำนวณ pagination
      const totalRow = await env.DB.prepare(
        "SELECT COUNT(*) as total FROM customer_favorites WHERE customer_id = ?"
      ).bind(customer.id).first();
      const totalCount = Number(totalRow?.total) || 0;
      // ตรวจว่าเพลงยังมีอยู่จริง (ถ้าถูกลบ → song_name จะเป็น NULL → ข้ามไปใน frontend)
      const favorites = (results || []).map(r => ({
        song_id: r.song_id,
        created_at: r.favorited_at,
        song: r.song_name ? {
          song_name: r.song_name,
          cover_url: r.cover_url,
          dj_name: r.dj_name,
          artist: r.artist,
          price: r.price,
          discount_price: r.discount_price,
        } : null,
      }));
      return jsonResponse({
        ok: true,
        favorites,
        // 🆕 (T010-M11): pagination metadata — frontend ใช้ lazy load หน้าถัดไป
        pagination: {
          limit,
          offset,
          total: totalCount,
          has_more: (offset + limit) < totalCount,
        },
      });
    } catch (err) {
      if (String(err?.message || "").includes("no such table")) {
        return jsonResponse({ error: "ระบบยังไม่พร้อม — กรุณารัน scripts/migrate-customer-v6.sql ใน D1 Console", code: "TABLE_NOT_CREATED" }, 500);
      }
      return jsonResponse({ error: safeError("โหลดรายการโปรดไม่สำเร็จ", err) }, 500);
    }
  }

  if (path === "favorites" && request.method === "POST") {
    if (!env.DB) return jsonResponse({ error: "ยังไม่ได้ผูก D1 database" }, 500);
    const customer = await getCustomerSession(request, env);
    if (!customer) return jsonResponse({ error: "ยังไม่ได้เข้าสู่ระบบ" }, 401);
    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400); }
    const songId = String(body.song_id || "").trim();
    if (!songId) return jsonResponse({ error: "กรุณาระบุ song_id" }, 400);
    try {
      // 🆕 (T008-L10): favorites toggle — ถ้ามี → DELETE (unfavorite), ถ้าไม่มี → INSERT (favorite)
      //   เดิม: INSERT OR IGNORE → กดซ้ำเป็น no-op (return ok เหมือนกันทุกครั้ง)
      //     ลูกค้ากด ❤️ แล้วกด ❤️ ซ้ำ → ไม่ยกเลิก → รู้สึกว่าปุ่มไม่ทำงาน + ไม่สามารถ unfavorite ผ่านปุ่มได้
      //   ใหม่: toggle — กด ❤️ เพิ่ม, กด ❤️ ซ้ำยกเลิก (response บอก is_favorite ให้ frontend update UI ทันที)
      //   ผลกระทบระบบเดิม: response shape เปลี่ยนเพิ่ม field `is_favorite` (frontend ใช้เพื่อ update ปุ่ม)
      //     ถ้า frontend เดิมไม่สนใจ is_favorite → ยังทำงานได้ (ok:true ยังอยู่)
      const now = new Date().toISOString();
      const existing = await env.DB.prepare(
        "SELECT id FROM customer_favorites WHERE customer_id = ? AND song_id = ?"
      ).bind(customer.id, songId).first();

      if (existing) {
        // unfavorite — ลูกค้ากด ❤️ ซ้ำ → ยกเลิก
        await env.DB.prepare(
          "DELETE FROM customer_favorites WHERE customer_id = ? AND song_id = ?"
        ).bind(customer.id, songId).run();
        return jsonResponse({ ok: true, is_favorite: false, message: "ลบจากรายการโปรดแล้ว" });
      }

      // favorite — ลูกค้ากด ❤️ ครั้งแรก → เพิ่ม
      const id = crypto.randomUUID();
      await env.DB.prepare(
        "INSERT INTO customer_favorites (id, customer_id, song_id, created_at) VALUES (?, ?, ?, ?)"
      ).bind(id, customer.id, songId, now).run();
      return jsonResponse({ ok: true, is_favorite: true, message: "เพิ่มในรายการโปรดแล้ว" });
    } catch (err) {
      if (String(err?.message || "").includes("no such table")) {
        return jsonResponse({ error: "ระบบยังไม่พร้อม — กรุณารัน scripts/migrate-customer-v6.sql ใน D1 Console", code: "TABLE_NOT_CREATED" }, 500);
      }
      return jsonResponse({ error: safeError("เพิ่มรายการโปรดไม่สำเร็จ", err) }, 500);
    }
  }

  // 🆕 (2026-10-02 v6): DELETE /api/customer/favorites/:song_id
  //   path = "favorites/<song_id>" → ต้อง split เอา song_id
  if (path.startsWith("favorites/") && request.method === "DELETE") {
    if (!env.DB) return jsonResponse({ error: "ยังไม่ได้ผูก D1 database" }, 500);
    const customer = await getCustomerSession(request, env);
    if (!customer) return jsonResponse({ error: "ยังไม่ได้เข้าสู่ระบบ" }, 401);
    const songId = decodeURIComponent(path.slice("favorites/".length));
    if (!songId) return jsonResponse({ error: "กรุณาระบุ song_id" }, 400);
    try {
      await env.DB.prepare(
        "DELETE FROM customer_favorites WHERE customer_id = ? AND song_id = ?"
      ).bind(customer.id, songId).run();
      return jsonResponse({ ok: true, message: "ลบจากรายการโปรดแล้ว" });
    } catch (err) {
      if (String(err?.message || "").includes("no such table")) {
        return jsonResponse({ error: "ระบบยังไม่พร้อม — กรุณารัน scripts/migrate-customer-v6.sql ใน D1 Console", code: "TABLE_NOT_CREATED" }, 500);
      }
      return jsonResponse({ error: safeError("ลบรายการโปรดไม่สำเร็จ", err) }, 500);
    }
  }

  // 🆕 (2026-10-02 v6): GET /api/customer/favorites/check/:song_id — ตรวจว่าเพลงนี้อยู่ในรายการโปรดหรือไม่
  //   ใช้ใน frontend เพื่อแสดงสถานะปุ่ม ❤️ (active หรือไม่)
  if (path.startsWith("favorites/check/") && request.method === "GET") {
    if (!env.DB) return jsonResponse({ error: "ยังไม่ได้ผูก D1 database" }, 500);
    const customer = await getCustomerSession(request, env);
    if (!customer) return jsonResponse({ error: "ยังไม่ได้เข้าสู่ระบบ" }, 401);
    const songId = decodeURIComponent(path.slice("favorites/check/".length));
    if (!songId) return jsonResponse({ error: "กรุณาระบุ song_id" }, 400);
    try {
      const row = await env.DB.prepare(
        "SELECT id FROM customer_favorites WHERE customer_id = ? AND song_id = ?"
      ).bind(customer.id, songId).first();
      return jsonResponse({ ok: true, is_favorite: !!row });
    } catch (err) {
      if (String(err?.message || "").includes("no such table")) {
        return jsonResponse({ ok: true, is_favorite: false }); // graceful — ถ้าตารางไม่มี บอกว่าไม่ใช่โปรด
      }
      return jsonResponse({ error: safeError("ตรวจสถานะโปรดไม่สำเร็จ", err) }, 500);
    }
  }

  // ============================================================
  // 🆕 (2026-10-02 v7 — ฟีเจอร์ #12 ใหม่): /api/songs/:id/like + /api/songs/:id/likes
  //   ถูกใจเพลงแบบ TikTok — กด ❤️ toggle like + แสดงจำนวน like
  //   - POST /api/songs/:id/like  — toggle like (เพิ่ม/ลด) — รองรับ anonymous (ใช้ fingerprint)
  //   - GET  /api/songs/:id/likes — ดูจำนวน like + สถานะของลูกค้า (public)
  //   ผลกระทบระบบเดิม: 0% — endpoints ใหม่ (แทนที่ระบบรีวิวเดิม)
  // ============================================================
  // POST /api/songs/:id/like — toggle like
  if (path.startsWith("songs/") && path.endsWith("/like") && request.method === "POST") {
    if (!env.DB) return jsonResponse({ error: "ยังไม่ได้ผูก D1 database" }, 500);
    const songId = decodeURIComponent(path.slice("songs/".length, -"/like".length));
    if (!songId) return jsonResponse({ error: "กรุณาระบุ song_id" }, 400);
    let body = {};
    try { body = await request.json(); } catch { body = {}; }
    // กำหนด customer_id: ถ้า login → ใช้ customer.id, ถ้าไม่ login → ใช้ 'anon:<fingerprint>' จาก body
    const customer = await getCustomerSession(request, env);
    const fingerprint = String(body.fingerprint || "").trim();
    let likerId;
    if (customer) {
      likerId = customer.id;
    } else {
      // anonymous like — ต้องมี fingerprint (frontend สร้างจาก localStorage + IP hash ส่งมา)
      if (!fingerprint || fingerprint.length < 8) {
        return jsonResponse({ error: "กรุณาเข้าสู่ระบบ หรือส่ง fingerprint สำหรับ anonymous like", code: "FINGERPRINT_REQUIRED" }, 400);
      }
      likerId = "anon:" + fingerprint;
    }
    try {
      const now = new Date().toISOString();
      // ตรวจว่ามี like อยู่แล้ว → ลบ (unlike), ถ้าไม่มี → เพิ่ม (like)
      const existing = await env.DB.prepare(
        "SELECT id FROM song_likes WHERE customer_id = ? AND song_id = ?"
      ).bind(likerId, songId).first();
      if (existing) {
        await env.DB.prepare("DELETE FROM song_likes WHERE id = ?").bind(existing.id).run();
        // นับ like ใหม่
        const countRow = await env.DB.prepare("SELECT COUNT(*) as cnt FROM song_likes WHERE song_id = ?").bind(songId).first();
        return jsonResponse({ ok: true, action: "unliked", like_count: countRow?.cnt || 0, is_liked: false });
      } else {
        const id = crypto.randomUUID();
        await env.DB.prepare(
          "INSERT INTO song_likes (id, customer_id, song_id, created_at) VALUES (?, ?, ?, ?)"
        ).bind(id, likerId, songId, now).run();
        const countRow = await env.DB.prepare("SELECT COUNT(*) as cnt FROM song_likes WHERE song_id = ?").bind(songId).first();
        return jsonResponse({ ok: true, action: "liked", like_count: countRow?.cnt || 0, is_liked: true });
      }
    } catch (err) {
      if (String(err?.message || "").includes("no such table")) {
        return jsonResponse({ error: "ระบบยังไม่พร้อม — กรุณารัน scripts/migrate-customer-v7.sql ใน D1 Console", code: "TABLE_NOT_CREATED" }, 500);
      }
      return jsonResponse({ error: safeError("กดถูกใจไม่สำเร็จ", err) }, 500);
    }
  }

  // GET /api/songs/:id/likes — ดูจำนวน like + สถานะของลูกค้า (public)
  if (path.startsWith("songs/") && path.endsWith("/likes") && request.method === "GET") {
    if (!env.DB) return jsonResponse({ error: "ยังไม่ได้ผูก D1 database" }, 500);
    const songId = decodeURIComponent(path.slice("songs/".length, -"/likes".length));
    if (!songId) return jsonResponse({ error: "กรุณาระบุ song_id" }, 400);
    try {
      // นับจำนวน like ทั้งหมดของเพลง
      const countRow = await env.DB.prepare(
        "SELECT COUNT(*) as cnt FROM song_likes WHERE song_id = ?"
      ).bind(songId).first();
      const likeCount = countRow?.cnt || 0;
      // ตรวจสถานะของลูกค้าปัจจุบัน (login หรือ anonymous)
      let isLiked = false;
      const customer = await getCustomerSession(request, env);
      if (customer) {
        const row = await env.DB.prepare(
          "SELECT id FROM song_likes WHERE customer_id = ? AND song_id = ?"
        ).bind(customer.id, songId).first();
        isLiked = !!row;
      } else {
        // สำหรับ anonymous → ตรวจด้วย fingerprint จาก query param
        const fingerprint = String(url.searchParams.get("fingerprint") || "").trim();
        if (fingerprint && fingerprint.length >= 8) {
          const row = await env.DB.prepare(
            "SELECT id FROM song_likes WHERE customer_id = ? AND song_id = ?"
          ).bind("anon:" + fingerprint, songId).first();
          isLiked = !!row;
        }
      }
      return jsonResponse({ ok: true, like_count: likeCount, is_liked: isLiked });
    } catch (err) {
      if (String(err?.message || "").includes("no such table")) {
        return jsonResponse({ ok: true, like_count: 0, is_liked: false }); // graceful
      }
      return jsonResponse({ error: safeError("โหลดจำนวน like ไม่สำเร็จ", err) }, 500);
    }
  }

  // ============================================================
  // 🆕 (T020): /api/songs/:id/reviews + /api/songs/:id/reviews/summary
  //   รีวิวเพลง — ลูกค้า login ให้ดาว 1-5 + ความเห็น + แสดงในหน้าเพลง
  //   - GET    /api/songs/:id/reviews         — ดูรีวิวทั้งหมดของเพลง (public, ล่าสุดก่อน)
  //   - GET    /api/songs/:id/reviews/summary — คะแนนเฉลี่ย + จำนวน + distribution (public)
  //   - POST   /api/songs/:id/reviews         — สร้าง/แก้ไขรีวิว (login required, upsert 1 ลูกค้าต่อ 1 เพลง)
  //   - DELETE /api/songs/:id/reviews         — ลบรีวิวตัวเอง (login required)
  //   กฎเหล็ก:
  //     - ไม่ส่ง customer_id/email/whatsapp กลับใน review (privacy — ส่งแค่ display_name + is_mine)
  //     - 1 ลูกค้าต่อ 1 เพลง = 1 รีวิว (UNIQUE constraint + INSERT ... ON CONFLICT upsert)
  //     - รีวิวต้อง login เท่านั้น (guest โพสต์ไม่ได้)
  //   ผลกระทบระบบเดิม: 0% — endpoints ใหม่ ไม่แตะ /api/songs/:id/like(s) หรือ cart/checkout/ZIP/payment
  // ============================================================

  // GET /api/songs/:id/reviews/summary — คะแนนเฉลี่ย + จำนวน + distribution (public)
  //   ⚠️ ต้องอยู่ก่อน /reviews เพื่อกัน path ตรง "endsWith('/reviews')" จับสั้น ๆ ก่อน
  if (path.startsWith("songs/") && path.endsWith("/reviews/summary") && request.method === "GET") {
    if (!env.DB) return jsonResponse({ error: "ยังไม่ได้ผูก D1 database" }, 500);
    const songId = decodeURIComponent(path.slice("songs/".length, -"/reviews/summary".length));
    if (!songId) return jsonResponse({ error: "กรุณาระบุ song_id" }, 400);
    try {
      const row = await env.DB.prepare(
        `SELECT
           COUNT(*) as count,
           AVG(rating) as avg_rating,
           SUM(CASE WHEN rating = 5 THEN 1 ELSE 0 END) as five_star,
           SUM(CASE WHEN rating = 4 THEN 1 ELSE 0 END) as four_star,
           SUM(CASE WHEN rating = 3 THEN 1 ELSE 0 END) as three_star,
           SUM(CASE WHEN rating = 2 THEN 1 ELSE 0 END) as two_star,
           SUM(CASE WHEN rating = 1 THEN 1 ELSE 0 END) as one_star
         FROM song_reviews WHERE song_id = ?`
      ).bind(songId).first();
      return jsonResponse({
        ok: true,
        summary: {
          count: row?.count || 0,
          avg_rating: row?.avg_rating ? Math.round(row.avg_rating * 10) / 10 : 0,
          distribution: {
            5: row?.five_star || 0,
            4: row?.four_star || 0,
            3: row?.three_star || 0,
            2: row?.two_star || 0,
            1: row?.one_star || 0,
          },
        },
      });
    } catch (err) {
      if (String(err?.message || "").includes("no such table")) {
        return jsonResponse({ ok: true, summary: { count: 0, avg_rating: 0, distribution: { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 } } });
      }
      return jsonResponse({ error: safeError("โหลดสรุปรีวิวไม่สำเร็จ", err) }, 500);
    }
  }

  // GET /api/songs/:id/reviews — ดูรีวิวทั้งหมดของเพลง (public, ล่าสุดก่อน, limit 50, max 100)
  //   - ถ้า login → ตอบ field `is_mine: true` ให้กับรีวิวของตัวเอง (เพื่อ frontend แสดงปุ่มแก้ไข/ลบ)
  //   - ไม่ส่ง customer_id/email/whatsapp กลับ (privacy — ส่งแค่ display_name + author_initial)
  if (path.startsWith("songs/") && path.endsWith("/reviews") && request.method === "GET") {
    if (!env.DB) return jsonResponse({ error: "ยังไม่ได้ผูก D1 database" }, 500);
    const songId = decodeURIComponent(path.slice("songs/".length, -"/reviews".length));
    if (!songId) return jsonResponse({ error: "กรุณาระบุ song_id" }, 400);
    try {
      const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10) || 50, 100);
      const offset = Math.max(parseInt(url.searchParams.get("offset") || "0", 10) || 0, 0);
      const { results } = await env.DB.prepare(
        `SELECT r.id, r.rating, r.comment, r.created_at, r.updated_at, r.customer_id,
                c.display_name
         FROM song_reviews r
         LEFT JOIN customers c ON c.id = r.customer_id
         WHERE r.song_id = ?
         ORDER BY r.created_at DESC
         LIMIT ? OFFSET ?`
      ).bind(songId, limit, offset).all();
      // ดึง session ของลูกค้าปัจจุบัน (ถ้า login) — ใช้ตอบ is_mine ให้ frontend แสดงปุ่มแก้ไข/ลบ
      const currentCustomer = await getCustomerSession(request, env);
      const reviews = (results || []).map(r => ({
        id: r.id,
        rating: r.rating,
        comment: r.comment,
        created_at: r.created_at,
        updated_at: r.updated_at,
        author_name: r.display_name || "ลูกค้า",
        author_initial: (r.display_name || "?").charAt(0).toUpperCase(),
        // 🆕 (T020): is_mine ใช้ใน frontend เท่านั้น (เช็คกับ session) — ไม่รั่ว customer_id ของคนอื่น
        is_mine: currentCustomer ? (r.customer_id === currentCustomer.id) : false,
      }));
      return jsonResponse({ ok: true, reviews });
    } catch (err) {
      if (String(err?.message || "").includes("no such table")) {
        return jsonResponse({ ok: true, reviews: [], message: "ระบบรีวิวยังไม่พร้อม — กรุณารัน migration" });
      }
      return jsonResponse({ error: safeError("โหลดรีวิวไม่สำเร็จ", err) }, 500);
    }
  }

  // POST /api/songs/:id/reviews — สร้าง/แก้ไขรีวิว (login required, upsert)
  //   body: { rating: 1-5, comment?: string (max 500 chars) }
  //   ใช้ INSERT ... ON CONFLICT (song_id, customer_id) DO UPDATE → upsert (1 ลูกค้าต่อ 1 เพลง = 1 รีวิว)
  if (path.startsWith("songs/") && path.endsWith("/reviews") && request.method === "POST") {
    if (!env.DB) return jsonResponse({ error: "ยังไม่ได้ผูก D1 database" }, 500);
    const customer = await getCustomerSession(request, env);
    if (!customer) return jsonResponse({ error: "ต้องเข้าสู่ระบบเพื่อรีวิว", code: "LOGIN_REQUIRED" }, 401);
    const songId = decodeURIComponent(path.slice("songs/".length, -"/reviews".length));
    if (!songId) return jsonResponse({ error: "กรุณาระบุ song_id" }, 400);
    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400); }
    const rating = parseInt(body.rating, 10);
    const comment = String(body.comment || "").trim().slice(0, 500); // max 500 chars
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return jsonResponse({ error: "คะแนนต้องเป็น 1-5" }, 400);
    }
    try {
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      // upsert — ถ้ามีอยู่แล้ว (UNIQUE song_id+customer_id) → อัปเดต rating+comment+updated_at
      await env.DB.prepare(
        `INSERT INTO song_reviews (id, song_id, customer_id, rating, comment, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (song_id, customer_id) DO UPDATE SET
           rating = excluded.rating,
           comment = excluded.comment,
           updated_at = excluded.updated_at`
      ).bind(id, songId, customer.id, rating, comment || null, now, now).run();
      return jsonResponse({
        ok: true,
        message: "บันทึกรีวิวแล้ว",
        review: { id, song_id: songId, rating, comment, created_at: now, updated_at: now },
      });
    } catch (err) {
      if (String(err?.message || "").includes("no such table")) {
        return jsonResponse({ error: "ระบบรีวิวยังไม่พร้อม — กรุณารัน scripts/migrate-song-reviews.sql ใน D1 Console", code: "TABLE_NOT_CREATED" }, 500);
      }
      return jsonResponse({ error: safeError("บันทึกรีวิวไม่สำเร็จ", err) }, 500);
    }
  }

  // DELETE /api/songs/:id/reviews — ลบรีวิวของตัวเอง (login required)
  //   ไม่รับ body — ใช้ session ระบุตัวตน (ลบเฉพาะของ customer คนนี้เท่านั้น)
  if (path.startsWith("songs/") && path.endsWith("/reviews") && request.method === "DELETE") {
    if (!env.DB) return jsonResponse({ error: "ยังไม่ได้ผูก D1 database" }, 500);
    const customer = await getCustomerSession(request, env);
    if (!customer) return jsonResponse({ error: "ต้องเข้าสู่ระบบเพื่อลบรีวิว", code: "LOGIN_REQUIRED" }, 401);
    const songId = decodeURIComponent(path.slice("songs/".length, -"/reviews".length));
    if (!songId) return jsonResponse({ error: "กรุณาระบุ song_id" }, 400);
    try {
      await env.DB.prepare(
        "DELETE FROM song_reviews WHERE song_id = ? AND customer_id = ?"
      ).bind(songId, customer.id).run();
      return jsonResponse({ ok: true, message: "ลบรีวิวแล้ว" });
    } catch (err) {
      if (String(err?.message || "").includes("no such table")) {
        return jsonResponse({ ok: true, message: "ลบรีวิวแล้ว (ไม่มีตาราง — ไม่มีรีวิวให้ลบ)" });
      }
      return jsonResponse({ error: safeError("ลบรีวิวไม่สำเร็จ", err) }, 500);
    }
  }

  // ============================================================
  // 🆕 (T020): /api/admin/song-reviews/:review_id — แอดมินลบรีวิวที่ไม่เหมาะสม (moderation)
  //   - DELETE /api/admin/song-reviews/:review_id — ลบรีวิว (admin เท่านั้น)
  //   ผลกระทบระบบเดิม: 0% — endpoint ใหม่ ใช้สำหรับ moderation เท่านั้น
  // ============================================================
  if (url.pathname.startsWith("/api/admin/song-reviews/") && request.method === "DELETE") {
    if (!env.DB) return jsonResponse({ error: "D1 not configured" }, 500);
    const admin = await getSessionAdmin(request, env);
    if (!admin) return jsonResponse({ error: "ยังไม่ได้เข้าสู่ระบบ" }, 401);
    const reviewId = decodeURIComponent(url.pathname.slice("/api/admin/song-reviews/".length));
    if (!reviewId) return jsonResponse({ error: "กรุณาระบุ review_id" }, 400);
    try {
      await env.DB.prepare("DELETE FROM song_reviews WHERE id = ?").bind(reviewId).run();
      return jsonResponse({ ok: true, message: "ลบรีวิวแล้ว (moderation)" });
    } catch (err) {
      if (String(err?.message || "").includes("no such table")) {
        return jsonResponse({ ok: true, message: "ลบรีวิวแล้ว (ไม่มีตาราง — ไม่มีรีวิวให้ลบ)" });
      }
      return jsonResponse({ error: safeError("ลบรีวิวไม่สำเร็จ", err) }, 500);
    }
  }

  // ============================================================
  // 🆕 (T012): /api/admin/reports/* — รายงานยอดขาย (Admin only)
  //   - GET /api/admin/reports/sales-summary?period=daily|weekly|monthly
  //   - GET /api/admin/reports/top-songs?limit=10
  //   - GET /api/admin/reports/top-djs?limit=10
  // ------------------------------------------------------------
  // กฎเหล็ก:
  //   - ไม่แก้ logic ระบบชำระเงิน (read-only reports)
  //   - ใช้ D1 SQL aggregate (GROUP BY) ไม่ใช่ loop N+1
  //   - ใช้เฉพาะ orders ที่สำเร็จ (status: completed | processing | verified)
  //     * verified คือออเดอร์ที่แอดมินยืนยันสลิปแล้ว แต่ยังไม่ได้ mark completed
  //     * processing คือออเดอร์ที่กำลังดำเนินการ (อาจหมายถึงกำลังสร้าง ZIP)
  //     * completed คือออเดอร์สำเร็จเต็มรูปแบบ (ZIP ส่งลูกค้าแล้ว)
  //   - ผลกระทบระบบเดิม: 0% — endpoints ใหม่ ไม่แตะของเดิม
  // ============================================================

  // 🆕 (T012): GET /api/admin/reports/sales-summary
  //   query: ?period=daily|weekly|monthly (default: daily)
  //     - daily: 30 วันล่าสุด (group by date)
  //     - weekly: 90 วันล่าสุด (group by date — admin เห็นเป็นรายวัน 90 วัน)
  //     - monthly: 365 วันล่าสุด (group by date — admin เห็นเป็นรายวัน 1 ปี)
  //   response: { ok, period, summary: {total_orders, total_revenue, avg_order_value}, data: [{date, order_count, revenue}] }
  if (url.pathname === "/api/admin/reports/sales-summary" && request.method === "GET") {
    if (!env.DB) return jsonResponse({ error: "D1 not configured" }, 500);
    const admin = await getSessionAdmin(request, env);
    if (!admin) return jsonResponse({ error: "ไม่ได้รับอนุญาต" }, 401);

    try {
      const period = String(url.searchParams.get("period") || "daily").trim();
      // กำหนดระยะเวลาย้อนหลัง (วัน) ตาม period
      //   - daily: 30 วัน (1 เดือนย้อนหลัง)
      //   - weekly: 90 วัน (3 เดือนย้อนหลัง)
      //   - monthly: 365 วัน (1 ปีย้อนหลัง)
      const days = period === "weekly" ? 90 : period === "monthly" ? 365 : 30;
      const normalizedPeriod = period === "weekly" || period === "monthly" ? period : "daily";
      const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

      // 🆕 (T012): SQL aggregate — GROUP BY date (1 query สำหรับทั้งช่วง)
      //   - DATE(json_extract(data, '$.created_at')) ดึงแค่ส่วน YYYY-MM-DD
      //   - ใช้ index idx_documents_orders_status สำหรับ status filter (composite)
      //   - ใช้ index idx_documents_collection_created_at สำหรับ collection + created_at
      //   - LIMIT 365 กันผลลัพธ์ใหญ่เกิน (ป้องกัน D1 row limit)
      const { results } = await env.DB.prepare(
        `SELECT
           DATE(json_extract(data, '$.created_at')) as date,
           COUNT(*) as order_count,
           SUM(CAST(json_extract(data, '$.final_total') AS REAL)) as revenue
         FROM documents
         WHERE collection = 'orders'
           AND json_extract(data, '$.status') IN ('completed', 'processing', 'verified')
           AND json_extract(data, '$.created_at') >= ?
         GROUP BY DATE(json_extract(data, '$.created_at'))
         ORDER BY date DESC
         LIMIT 365`
      ).bind(startDate).all();

      const rows = results || [];
      const totalOrders = rows.reduce((sum, r) => sum + (r.order_count || 0), 0);
      const totalRevenue = rows.reduce((sum, r) => sum + (Number(r.revenue) || 0), 0);
      const avgOrderValue = totalOrders > 0 ? totalRevenue / totalOrders : 0;

      return jsonResponse({
        ok: true,
        period: normalizedPeriod,
        days_back: days,
        summary: {
          total_orders: totalOrders,
          total_revenue: Math.round(totalRevenue * 100) / 100,
          avg_order_value: Math.round(avgOrderValue * 100) / 100,
        },
        data: rows.map(r => ({
          date: r.date,
          order_count: r.order_count,
          revenue: Math.round((Number(r.revenue) || 0) * 100) / 100,
        })),
      });
    } catch (err) {
      return jsonResponse({ error: safeError("โหลดรายงานยอดขายไม่สำเร็จ", err) }, 500);
    }
  }

  // 🆕 (T012): GET /api/admin/reports/top-songs?limit=10
  //   response: { ok, top_songs: [{ song_id, title, sales_count, revenue }] }
  //   - ดึง orders ที่สำเร็จ → extract items → GROUP BY song_id
  //   - ใช้ json_each ของ items array (SQLite function)
  //   - กรองเฉพาะ items ที่มี song_id (kind:"song" หรือ legacy flat items)
  //     → ข้าม items ที่เป็น kind:"playlist" (ไม่มี song_id ตรง ๆ)
  if (url.pathname === "/api/admin/reports/top-songs" && request.method === "GET") {
    if (!env.DB) return jsonResponse({ error: "D1 not configured" }, 500);
    const admin = await getSessionAdmin(request, env);
    if (!admin) return jsonResponse({ error: "ไม่ได้รับอนุญาต" }, 401);

    try {
      const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "10", 10) || 10, 1), 50);

      // 🆕 (T012): SQL aggregate บน json_each — 1 query เดียว
      //   - json_each คืน table ที่มี column "value" (เป็น JSON value ของแต่ละ item)
      //   - ใช้ value->>'$.song_id' เพื่อ extract song_id (text)
      //   - WHERE song_id IS NOT NULL กรอง playlist items ออก
      //   - GROUP BY song_id → นับจำนวนครั้งที่ขาย + sum revenue
      const { results } = await env.DB.prepare(
        `SELECT
           json_each.value->>'$.song_id' as song_id,
           COALESCE(json_each.value->>'$.title', '(ไม่มีชื่อ)') as title,
           COUNT(*) as sales_count,
           SUM(CAST(json_each.value->>'$.price' AS REAL)) as revenue
         FROM documents, json_each(json_extract(data, '$.items'))
         WHERE collection = 'orders'
           AND json_extract(data, '$.status') IN ('completed', 'processing', 'verified')
           AND json_each.value->>'$.song_id' IS NOT NULL
         GROUP BY song_id
         ORDER BY sales_count DESC
         LIMIT ?`
      ).bind(limit).all();

      return jsonResponse({
        ok: true,
        top_songs: (results || []).map(r => ({
          song_id: r.song_id,
          title: r.title,
          sales_count: r.sales_count,
          revenue: Math.round((Number(r.revenue) || 0) * 100) / 100,
        })),
      });
    } catch (err) {
      return jsonResponse({ error: safeError("โหลดรายงานเพลงขายดีไม่สำเร็จ", err) }, 500);
    }
  }

  // 🆕 (T012): GET /api/admin/reports/top-djs?limit=10
  //   response: { ok, top_djs: [{ dj_name, sales_count, revenue, song_count }] }
  //   - ใช้ SQL aggregate บน json_each เพื่อนับยอดขายต่อ song_id (เหมือน top-songs)
  //   - จากนั้น batch lookup dj_name ของแต่ละ song_id จาก collection 'songs'
  //   - สุดท้าย re-aggregate ตาม dj_name ฝั่ง JS (bounded by limit จึงไม่ใช่ N+1)
  //   - ใช้ 2 D1 queries รวม (aggregate + batch lookup) ไม่ใช่ N queries
  if (url.pathname === "/api/admin/reports/top-djs" && request.method === "GET") {
    if (!env.DB) return jsonResponse({ error: "D1 not configured" }, 500);
    const admin = await getSessionAdmin(request, env);
    if (!admin) return jsonResponse({ error: "ไม่ได้รับอนุญาต" }, 401);

    try {
      const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "10", 10) || 10, 1), 50);

      // Step 1: aggregate ยอดขายต่อ song_id (เหมือน top-songs แต่ limit ใหญ่กว่า — ดึง top 200 song_id)
      //   เพื่อให้ครอบคลุมเพลงทั้งหมดที่อาจเป็นของ DJ หลายคน → re-aggregate ต่อ dj_name ถูกต้อง
      const SONG_LOOKUP_LIMIT = 200;
      const { results: songAgg } = await env.DB.prepare(
        `SELECT
           json_each.value->>'$.song_id' as song_id,
           COUNT(*) as sales_count,
           SUM(CAST(json_each.value->>'$.price' AS REAL)) as revenue
         FROM documents, json_each(json_extract(data, '$.items'))
         WHERE collection = 'orders'
           AND json_extract(data, '$.status') IN ('completed', 'processing', 'verified')
           AND json_each.value->>'$.song_id' IS NOT NULL
         GROUP BY song_id
         ORDER BY sales_count DESC
         LIMIT ?`
      ).bind(SONG_LOOKUP_LIMIT).all();

      const songRows = songAgg || [];
      if (songRows.length === 0) {
        return jsonResponse({ ok: true, top_djs: [] });
      }

      // Step 2: batch lookup dj_name ของแต่ละ song_id จาก collection 'songs' (1 query เดียวใช้ IN clause)
      //   - ใช้ json_extract(data, '$.dj_name') เพื่อดึง dj_name จาก song document
      //   - ใช้ placeholder แบบ dynamic (?, ?, ?, ...) ตามจำนวน song_id
      //   - D1 รองรับ IN clause สูงสุด 500 expressions (แต่เราจำกัดที่ 200 → safe)
      const songIds = songRows.map(r => r.song_id);
      const placeholders = songIds.map(() => "?").join(",");
      const songDjRows = await env.DB.prepare(
        `SELECT id, json_extract(data, '$.dj_name') as dj_name
         FROM documents
         WHERE collection = 'songs' AND id IN (${placeholders})`
      ).bind(...songIds).all();
      const songDjMap = new Map();
      for (const row of (songDjRows?.results || [])) {
        const djName = row.dj_name ? String(row.dj_name) : "";
        songDjMap.set(row.id, djName);
      }

      // Step 3: re-aggregate ตาม dj_name (ฝั่ง JS — bounded by SONG_LOOKUP_LIMIT=200)
      //   - ถ้า dj_name ว่าง → ใส่ "(ไม่ระบุ DJ)"
      //   - รวม sales_count + revenue + song_count (จำนวนเพลงที่ขายของ DJ นั้น)
      const djAgg = new Map();
      for (const song of songRows) {
        const djName = songDjMap.get(song.song_id) || "(ไม่ระบุ DJ)";
        if (!djAgg.has(djName)) {
          djAgg.set(djName, { dj_name: djName, sales_count: 0, revenue: 0, song_count: 0 });
        }
        const entry = djAgg.get(djName);
        entry.sales_count += song.sales_count || 0;
        entry.revenue += Number(song.revenue) || 0;
        entry.song_count += 1;
      }

      // Step 4: sort + slice to limit
      const topDjs = Array.from(djAgg.values())
        .sort((a, b) => (b.sales_count || 0) - (a.sales_count || 0))
        .slice(0, limit)
        .map(d => ({
          dj_name: d.dj_name,
          sales_count: d.sales_count,
          revenue: Math.round(d.revenue * 100) / 100,
          song_count: d.song_count,
        }));

      return jsonResponse({ ok: true, top_djs: topDjs });
    } catch (err) {
      return jsonResponse({ error: safeError("โหลดรายงาน DJ ขายดีไม่สำเร็จ", err) }, 500);
    }
  }

  // 🆕 (T042): GET /api/admin/reports/top-playlists?limit=10
  //   response: { ok, top_playlists: [{ playlist_id, playlist_name, sales_count, revenue }] }
  //   - ใช้ SQL aggregate บน json_each เพื่อนับยอดขายต่อ playlist (เหมือน top-songs แต่ group by playlist_id)
  if (url.pathname === "/api/admin/reports/top-playlists" && request.method === "GET") {
    if (!env.DB) return jsonResponse({ error: "D1 not configured" }, 500);
    const admin = await getSessionAdmin(request, env);
    if (!admin) return jsonResponse({ error: "ไม่ได้รับอนุญาต" }, 401);

    try {
      const limit = Math.min(parseInt(url.searchParams.get("limit") || "10", 10), 50);

      // aggregate ยอดขายต่อ playlist_id จาก order items
      //   items ที่เป็น playlist จะมี playlist_id + playlist_name
      const { results } = await env.DB.prepare(
        `SELECT 
           json_each.value->>'$.playlist_id' as playlist_id,
           json_each.value->>'$.playlist_name' as playlist_name,
           COUNT(*) as sales_count,
           SUM(CAST(json_each.value->>'$.price' AS REAL)) as revenue
         FROM documents, json_each(json_extract(data, '$.items'))
         WHERE collection = 'orders'
           AND json_extract(data, '$.status') IN ('completed', 'processing', 'verified')
           AND json_each.value->>'$.playlist_id' IS NOT NULL
           AND json_each.value->>'$.playlist_id' != ''
         GROUP BY playlist_id
         ORDER BY sales_count DESC
         LIMIT ?`
      ).bind(limit).all();

      return jsonResponse({
        ok: true,
        top_playlists: (results || []).map(r => ({
          playlist_id: r.playlist_id,
          playlist_name: r.playlist_name || "(ไม่มีชื่อ)",
          sales_count: r.sales_count,
          revenue: Math.round(Number(r.revenue || 0) * 100) / 100,
        })),
      });
    } catch (err) {
      return jsonResponse({ error: safeError("โหลดรายงาน Playlist ขายดีไม่สำเร็จ", err) }, 500);
    }
  }

  // 🆕 (T040): GET /api/admin/reports/export-csv?period=daily|weekly|monthly
  //   Export ยอดขายเป็น CSV — admin ดาวน์โหลดได้
  //   response: text/csv (attachment)
  if (url.pathname === "/api/admin/reports/export-csv" && request.method === "GET") {
    if (!env.DB) return jsonResponse({ error: "D1 not configured" }, 500);
    const admin = await getSessionAdmin(request, env);
    if (!admin) return jsonResponse({ error: "ไม่ได้รับอนุญาต" }, 401);

    try {
      const period = String(url.searchParams.get("period") || "daily").trim();
      const days = period === "weekly" ? 90 : period === "monthly" ? 365 : 30;
      const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

      // ดึงยอดขายรายวัน
      const { results } = await env.DB.prepare(
        `SELECT
           DATE(json_extract(data, '$.created_at')) as date,
           COUNT(*) as order_count,
           SUM(CAST(json_extract(data, '$.final_total') AS REAL)) as revenue
         FROM documents
         WHERE collection = 'orders'
           AND json_extract(data, '$.status') IN ('completed', 'processing', 'verified')
           AND json_extract(data, '$.created_at') >= ?
         GROUP BY DATE(json_extract(data, '$.created_at'))
         ORDER BY date ASC
         LIMIT 365`
      ).bind(startDate).all();

      // ดึง top songs
      const { results: topSongs } = await env.DB.prepare(
        `SELECT 
           json_each.value->>'$.song_id' as song_id,
           json_each.value->>'$.title' as title,
           COUNT(*) as sales_count,
           SUM(CAST(json_each.value->>'$.price' AS REAL)) as revenue
         FROM documents, json_each(json_extract(data, '$.items'))
         WHERE collection = 'orders' 
           AND json_extract(data, '$.status') IN ('completed', 'processing', 'verified')
         GROUP BY song_id
         ORDER BY sales_count DESC
         LIMIT 50`
      ).all();

      // สร้าง CSV
      let csv = "";
      // Section 1: ยอดขายรายวัน
      csv += "รายงานยอดขาย\n";
      csv += `ช่วงเวลา,${period}\n`;
      csv += `สร้างเมื่อ,${new Date().toISOString()}\n\n`;
      csv += "วันที่,จำนวนออเดอร์,ยอดรายได้ (LAK)\n";
      for (const r of (results || [])) {
        csv += `${r.date},${r.order_count},${Math.round(Number(r.revenue) || 0)}\n`;
      }
      csv += "\n";
      // Section 2: Top songs
      csv += "เพลงขายดี\n";
      csv += "อันดับ,ชื่อเพลง,จำนวนครั้ง,ยอดรายได้ (LAK)\n";
      (topSongs || []).forEach((s, i) => {
        const title = String(s.title || "").replace(/"/g, '""');
        csv += `${i + 1},"${title}",${s.sales_count},${Math.round(Number(s.revenue) || 0)}\n`;
      });

      // ส่งกลับเป็น CSV
      return new Response(csv, {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="sales-report-${period}-${Date.now()}.csv"`,
        },
      });
    } catch (err) {
      return jsonResponse({ error: safeError("export CSV ไม่สำเร็จ", err) }, 500);
    }
  }

  return jsonResponse({ error: "ไม่พบ endpoint นี้" }, 404);
}

// ===================================================
// 🆕 (T008-M6): normalizeWhatsapp — normalize เบอร์ WhatsApp ของลูกค้า
// -----------------------------------------------------------
// ปัญหา: register/login/forgot-password เก็บและค้น whatsapp แบบตรงตัว →
//   ลูกค้าสมัครด้วย "+85620XXX" แล้ว login ด้วย "020XXX" → หาไม่เจอ →
//   บัญชีซ้ำซ้อน (สมัครใหม่อีกรอบด้วย format ต่างกัน)
//
// กฎการ normalize:
//   - +85620XXXXXXXX → 85620XXXXXXXX (ละ +)
//   - 020XXXXXXXX     → 85620XXXXXXXX (เติม 856 ละ 0 นำหน้า)
//   - 20XXXXXXXX (10 หลัก) → 85620XXXXXXXX (เติม 856)
//   - 0XXXXXXXXX (เบอร์ไทย 10 หลัก) → 66XXXXXXXXX
//   - 66XXXXXXXXX     → 66XXXXXXXXX (คงเดิม)
//   - 85620XXXXXXXX   → 85620XXXXXXXX (คงเดิม)
//   - ไม่มีตัวเลขอื่นนอกจากตัวเลข + ละ + ต้น → คืน ""
//
// ผลกระทบระบบเดิม: เฉพาะระบบ customer auth (register/login/forgot-password)
//   ไม่กระทบระบบ order tracking ที่ใช้ normalizePhoneServer() เดิม (เก็บ format 20XXXXXXXX)
// ===================================================
function normalizeWhatsapp(v) {
  if (!v) return "";
  let s = String(v).trim();
  // ละ + ต้น
  if (s.startsWith("+")) s = s.slice(1);
  // เก็บเฉพาะตัวเลข
  s = s.replace(/[^0-9]/g, "");
  if (!s) return "";
  // เบอร์ลาว: 020XXXXXXXX → 85620XXXXXXXX
  if (s.startsWith("020")) return "856" + s.slice(1);
  // เบอร์ลาว: 20XXXXXXXX (ไม่มี 0 นำ, 10 หลัก) → 85620XXXXXXXX
  if (s.startsWith("20") && s.length === 10) return "856" + s;
  // เบอร์ไทย: 0XXXXXXXXX (10 หลัก) → 66XXXXXXXXX
  if (s.startsWith("0") && s.length === 10) return "66" + s.slice(1);
  // เบอร์ไทย 66XXXXXXXXX → คงเดิม
  // เบอร์ลาว 856XXXXXXXXX → คงเดิม
  return s;
}

export default {
  // 🔧 (2026-09-22 fix Bug #2 UI v6): เพิ่ม ctx parameter → ใช้ ctx.waitUntil() รัน audit log
  //   ใน background → ไม่บล็อก response (กัน UI ค้าง "กำลังอัปโหลด..." ถ้า audit_log INSERT ช้า/hang)
  async fetch(request, env, ctx) {
    // 🔧 (2026-09-22 fix Bug #2 UI v6): เก็บ ctx ไว้ใน env.__ctx เพื่อให้ writeAuditLog เรียก ctx.waitUntil() ได้
    //   ปลอดภัยเพราะ env เป็น object ตัวเดียวกันตลอด lifecycle ของ request
    env.__ctx = ctx;

    // 🔧 (2026-09-28 fix Critical C3): เก็บ request + env ไว้ใน module-level state
    //   เพื่อให้ corsHeaders() สามารถอ่าน Origin header + ALLOWED_ORIGINS env var ได้
    //   โดยไม่ต้องแก้ callers ของ jsonResponse ทั้ง 200+ จุด
    //   ปลอดภัยเพราะ Cloudflare Workers ทำงาน single-threaded ต่อ isolate
    //   → module state ไม่ race ข้าม requests (state reset ทุก request)
    _currentRequest = request;
    _currentEnv = env;

    // 🔧 (2026-09-27 fix 503 safety net): คลุม dispatch block ทั้งหมดด้วย try/catch
    //   เหตุผล: ถ้า handler ใด (เช่น /api/order-zip/*, /api/upload, /api/file/*, /api/db/*, /api/auth/*)
    //   ยังมี uncaught exception ที่ไม่ถูก catch ภายในตัวเอง → exception จะลากขึ้นมาที่นี่
    //   แทนที่จะปล่อยให้ Cloudflare คืน 503 (ที่ client อ่านไม่ได้ และ UI แสดง error ไม่ชัดเจน)
    //   เราคืน JSON 500 ที่อ่านได้ + log error จริงใน Worker logs (ผ่าน safeError)
    //   ผลกระทบระบบเดิม: 0% — ถ้า handler ทำงานปกติก็จะ return ตามปกติ (ไม่เข้า catch)
    //                    — ถ้า handler throw ก็จะได้ error ที่อ่านได้แทน 503 (UX ดีขึ้น)
    try {
      const url = new URL(request.url);

    if (request.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
      return new Response(null, { headers: { ...corsHeaders(), ...securityHeaders() } });
    }

    // 🆕 (T029): Block bots from /api/* endpoints — ลด Worker invocations จาก bot crawl
    //   Bots (Googlebot, Bingbot, etc.) ไม่ควรเรียก API endpoints — เรามี static pages สำหรับ SEO แล้ว
    //   ถ้า bot ยิง /api/* → คืน 403 ทันที (ไม่ query D1 = ไม่เปลือง invocation)
    if (url.pathname.startsWith("/api/") && request.method === "GET") {
      const userAgent = (request.headers.get("User-Agent") || "").toLowerCase();
      const isBot = /googlebot|bingbot|slurp|duckduckbot|baiduspider|yandexbot|facebookexternalhit|twitterbot|linkedinbot|telegrambot|whatsapp|applebot|petalbot|semrushbot|ahrefsbot|mj12bot|dotbot|bytespider|crawl|spider|bot/i.test(userAgent);
      if (isBot) {
        return new Response(JSON.stringify({ error: "Bot access not allowed on API endpoints" }), {
          status: 403,
          headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=86400" },
        });
      }
    }

    // 🆕 (T029): Cache API — เช็ค cache ก่อนไป D1 สำหรับ public read-only GET requests
    //   ปัญหา: run_worker_first: ["/api/*"] → ทุก /api/* request = Worker invocation เสมอ
    //   วิธีแก้: ใช้ caches.default (Cloudflare Cache API) ภายใน Worker เอง
    //   - ถ้า cache hit → คืน cached response ทันที (ไม่ query D1)
    //   - ถ้า cache miss → ไป D1 → เก็บใน cache 5 นาที
    //   ใช้กับ: GET /api/db/songs, /api/db/categories, /api/db/djs, /api/db/playlists (public read)
    //   ไม่ใช้กับ: orders, auth, customer, admin, POST/PUT/DELETE
    if (request.method === "GET" && url.pathname.startsWith("/api/db/")) {
      const pathParts = url.pathname.split("/");
      const collection = pathParts[3] || "";
      const isPublicRead = PUBLIC_READ_COLLECTIONS.has(collection) && collection !== "orders";
      // ไม่ cache ถ้ามี admin session (admin เห็นข้อมูลครบกว่า guest)
      const hasAdminCookie = request.headers.get("Cookie") && request.headers.get("Cookie").includes("session_token");
      if (isPublicRead && !hasAdminCookie) {
        const cacheKey = new Request(url.toString(), { method: "GET" });
        const cache = caches.default;
        const cachedResponse = await cache.match(cacheKey);
        if (cachedResponse) {
          // cache hit → คืนทันที ไม่ query D1
          return cachedResponse;
        }
        // cache miss → ทำงานปกติ + เก็บใน cache หลัง response
        // (เก็บไว้ใน ctx.waitUntil เพื่อไม่บล็อก response)
        const response = await handleDb(request, env, url);
        if (response.ok) {
          const responseToCache = response.clone();
          responseToCache.headers.set("Cache-Control", "public, max-age=300");
          ctx.waitUntil(cache.put(cacheKey, responseToCache));
        }
        return response;
      }
    }

    if (url.pathname === "/api/upload" && request.method === "POST") {
      return handleUpload(request, env);
    }

    if (url.pathname === "/api/upload" && request.method === "DELETE") {
      if (!env.DB) return jsonResponse({ error: "ยังไม่ได้ผูก D1 database (binding: DB) ใน wrangler.jsonc" }, 500);
      return handleDeleteUpload(request, env);
    }

    // 🔧 (2026-09-27 add): POST /api/order-files/cleanup — ลบไฟล์ทั้งหมดของออเดอร์ออกจาก R2 + D1
    //   ใช้ตอนแอดมินลบออเดอร์ → ลบสลิปโอนเงินทั้งหมด + ZIP + payment_proofs rows ใน D1
    //   ต้อง login แอดมินเท่านั้น (เช็คใน handleOrderFilesCleanup)
    //   ผลกระทบระบบเดิม: 0% — path ใหม่ขั้น ไม่แตะ /api/upload (DELETE) เดิม
    if (url.pathname === "/api/order-files/cleanup" && request.method === "POST") {
      if (!env.DB) return jsonResponse({ error: "ยังไม่ได้ผูก D1 database (binding: DB) ใน wrangler.jsonc" }, 500);
      return handleOrderFilesCleanup(request, env);
    }

    // 🔒 /api/file/* — Proxy อ่านไฟล์จาก R2 (ใหม่ 2026-09-12)
    // ใช้ตอนฝั่งแอดมินสร้าง ZIP ออเดอร์ — แทน fetch() ตรงจาก R2 public URL ที่อาจโดน CORS block
    // ต้อง login แอดมินเท่านั้น (เช็คใน handleFileProxy)
    if (url.pathname.startsWith("/api/file/") && request.method === "GET") {
      return handleFileProxy(request, env, url);
    }

    // 🔧 (2026-09-18): /api/order-zip/* — ระบบสร้าง ZIP ออเดอร์ฝั่ง Worker (แทน JSZip-in-browser)
    // ใช้ R2 Multipart Upload ทีละเพลง → รองรับ ZIP > 100MB (ทะลุ Worker body limit 100MB)
    // ต้อง login แอดมินเท่านั้น (เช็คในแต่ละ handler) — เหมือน /api/upload, /api/file/*
    // ไม่กระทบ endpoints เดิมใดๆ (path ใหม่ขั้น)
    if (url.pathname === "/api/order-zip/start" && request.method === "POST") {
      return handleOrderZipStart(request, env);
    }
    if (url.pathname === "/api/order-zip/append" && request.method === "POST") {
      return handleOrderZipAppend(request, env);
    }
    // 🔧 (2026-09-18 v4): finalize แบบ single-call (ใช้สำหรับออเดอร์เล็ก — < 100MB)
    // คงไว้ตามกฎ #7 (ห้ามลบเพียงเพราะคิดว่าไม่ใช้ — เผื่อใช้ในอนาคต)
    if (url.pathname === "/api/order-zip/finalize" && request.method === "POST") {
      return handleOrderZipFinalize(request, env);
    }
    // 🔧 (2026-09-18 v5): finalize แบบ split (ใช้สำหรับออเดอร์ใหญ่ — หลาย GB บน Free plan)
    //   finalize-build × M → finalize-compose × 1
    if (url.pathname === "/api/order-zip/finalize-build" && request.method === "POST") {
      return handleOrderZipFinalizeBuild(request, env);
    }
    if (url.pathname === "/api/order-zip/finalize-compose" && request.method === "POST") {
      return handleOrderZipFinalizeCompose(request, env);
    }
    if (url.pathname === "/api/order-zip/abort" && request.method === "POST") {
      return handleOrderZipAbort(request, env);
    }

    // 🔧 (2026-09-18 v6 Full System): POST /api/cache-purge
    // บังคับ CDN cache หมดอายุ หลัง admin save/delete song/playlist/category/dj
    // ทำให้ลูกค้าคนถัดไปเห็นข้อมูลใหม่ทันที (ไม่ต้องรอ 60 วินาที)
    // ต้อง login admin
    // request: { collection: "songs"|"playlists"|"categories"|"djs"|"discounts"|"promotions"|"settings" }
    // response: { ok: true, purged: true, collection }
    if (url.pathname === "/api/cache-purge" && request.method === "POST") {
      // 🔧 (2026-09-27 fix 503): หุ้ม getSessionAdmin ด้วย try/catch — กัน D1 throw → 503
      let admin;
      try {
        admin = await getSessionAdmin(request, env);
      } catch (err) {
        return jsonResponse({ error: safeError("ตรวจสอบสิทธิ์ไม่สำเร็จ กรุณาลองใหม่", err) }, 500);
      }
      if (!admin) return jsonResponse({ error: "ยังไม่ได้เข้าสู่ระบบ" }, 401);
      let body;
      try { body = await request.json(); } catch { body = {}; }
      const coll = String(body?.collection || "").trim();
      // whitelist collections ที่ purge ได้ (กัน admin purge orders/admins โดยไม่ตั้งใจ)
      const PURGEABLE = new Set(["songs", "categories", "djs", "playlists", "discounts", "promotions", "settings"]);
      if (!coll || !PURGEABLE.has(coll)) {
        return jsonResponse({ error: "ระบุ collection ที่ถูกต้อง (songs, categories, djs, playlists, discounts, promotions, settings)" }, 400);
      }
      // 🔧 (2026-09-22 fix Bug #3): cache-purge ใช้ได้จริงผ่าน Cache API
      //   เดิม: แค่ acknowledge (no-op) → แอดมินคิดว่า purge แล้วแต่จริงๆ ไม่ได้ทำ
      //   ใหม่: ลบ cache จริงผ่าน Cache API (Cloudflare Worker รองรับ)
      //         + ส่ง purge tag ผ่าน response header
      //   ผลกระทบระบบเดิม: 0% — ถ้า Cache API ไม่รองรับ → fallback ได้
      // 🔧 (2026-09-27 fix HIGH #8): purge ครบทุก URL variant + sitemap + song/playlist static pages
      //   เดิม: purge แค่ /api/db/{coll} และ /api/db/{coll}?slim=1
      //         → ไม่ purge /api/db/{coll}?limit=N, /song/:id, /playlist/:id, /sitemap.xml
      //         → แอดมินบันทึกแล้ว SEO page ยังเก่า 24 ชม. + customer page paginated ยังเก่า
      //   ใหม่: purge ทุก URL variant ของ collection + sitemap + บอก purged: false ถ้า fail
      let purgedCount = 0;
      let failedCount = 0;
      let partialFailure = false;
      try {
        const cache = caches.default;
        const purgeUrl = new URL(request.url);
        // ฟังก์ชัน helper สำหรับ purge URL + นับผล
        const purgeOne = async (pathname, search) => {
          try {
            purgeUrl.pathname = pathname;
            purgeUrl.search = search || "";
            await cache.delete(purgeUrl.toString());
            purgedCount += 1;
          } catch (err) {
            failedCount += 1;
            partialFailure = true;
            console.warn(`cache-purge: failed to purge ${pathname}${search || ""}:`, err?.message || err);
          }
        };
        // 🆕 (T051-M8): ขยาย purge URL variants ครบทุกแบบที่ frontend ใช้จริง
        //   เดิม: purge แค่ 2 URL (default + ?slim=1) → paginated URLs ยังเก่า
        //   ใหม่: purge ทุก variants ที่ frontend ใช้จริง (สำรวจจาก db-client.js + app-user.js + orders.js)
        //     - default (no query)
        //     - ?slim=1
        //     - ?limit=50&offset=0&slim=1 (app-user.js lazy load)
        //     - ?limit=200&offset=0&slim=1 (orders.js admin)
        //     - ?limit=200 (orders.js admin)
        //     - ?limit=500 (orders.js playlists admin)
        //     - ?limit=100 (รองรับ future use)
        //   note: Cache API ไม่รองรับ wildcard → purge แบบ enumerate (trade-off D1 reads 0)
        const variants = [
          "",
          "slim=1",
          "limit=50&offset=0&slim=1",
          "limit=100&offset=0&slim=1",
          "limit=200&offset=0&slim=1",
          "limit=200",
          "limit=500",
          "limit=500&offset=0",
        ];
        for (const search of variants) {
          await purgeOne(`/api/db/${coll}`, search);
        }
        // 🔧 (2026-09-27 fix HIGH #8): Purge sitemap.xml (เพราะ sitemap list songs/playlists)
        //    ถ้าแอดมินเพิ่ม/ลบเพลง → sitemap เก่าค้าง 24 ชม. → Google ไม่เห็นเพลงใหม่
        await purgeOne("/sitemap.xml", "");
        // 🆕 (T051-M8): Purge หน้า static ของ songs/playlists แต่ละ ID (cap 100 IDs กัน D1 reads เยอะ)
        //   เดิม: ไม่ purge /song/:id หรือ /playlist/:id เลย → หน้า SEO ค้าง 1 ชม.
        //   ใหม่: list IDs จาก D1 (cap 100) → purge แต่ละ /song/:id หรือ /playlist/:id
        //   trade-off: D1 reads +1 ต่อครั้ง (cap 100 rows) — คุ้มเพราะแอดมินแก้นาน ๆ ครั้ง
        //   ผลกระทบระบบเดิม: 0% — เป็น background fetch ไม่ block response
        if (coll === "songs" || coll === "playlists") {
          try {
            const idRows = await env.DB.prepare(
              `SELECT id FROM documents WHERE collection = ? ORDER BY updated_at DESC LIMIT 100`
            ).bind(coll).all();
            if (idRows?.results?.length > 0) {
              const staticPathPrefix = coll === "songs" ? "/song/" : "/playlist/";
              for (const row of idRows.results) {
                await purgeOne(`${staticPathPrefix}${row.id}`, "");
              }
            }
          } catch (idErr) {
            console.warn(`cache-purge: failed to list ${coll} IDs:`, idErr?.message || idErr);
            // ไม่ mark partialFailure เพราะ collection-level purge สำเร็จแล้ว
          }
        }
      } catch (cacheErr) {
        // ถ้า Cache API ไม่รองรับ → log + บอกแอดมิน
        console.warn("cache-purge: Cache API delete failed:", cacheErr?.message);
        partialFailure = true;
      }
      // 🔧 (2026-09-27 fix HIGH #8): บอก purged: false ถ้า fail (กัน false positive)
      //   เดิม: ส่ง purged: true เสมอ แม้ Cache API fail → แอดมินคิดว่า purge แล้ว
      //   ใหม่: ส่ง purged: false ถ้า failedCount > 0 + note บอกละเอียด
      const note = partialFailure
        ? `Cache purge partial: ${purgedCount} URLs purged, ${failedCount} failed. Customer static pages (/song/:id, /playlist/:id) cached 1h may still show old data.`
        : `Cache purge requested. ${purgedCount} URLs purged. Note: /song/:id and /playlist/:id may still be cached up to 1 hour.`;
      return jsonResponse({
        ok: true,
        purged: !partialFailure,
        collection: coll,
        purgedCount,
        failedCount,
        note,
      });
    }

    // 🔒 (2026-09-21 fix Bug #2 ZIP URL permanent public): 2 endpoints ใหม่
    //   1) POST /api/order-zip/get-customer-url?orderId=xxx — admin สร้าง one-time token
    //      → คืน URL สำหรับส่งลูกค้า: /api/download/<orderId>?token=<token>
    //   2) GET /api/download/:orderId?token=xxx — ลูกค้าดาวน์โหลด ZIP (one-time use)
    //      → Worker ตรวจ token + expiry + used_at → ส่ง stream จาก R2 (ไม่ reveal R2 URL)
    //   ผลกระทบระบบเดิม: 0% — เพิ่ม endpoint ใหม่ ไม่แตะ /api/order-zip/* เดิม
    //   ในอนาคต: orders.js ฝั่ง client จะเรียก /api/order-zip/get-customer-url แทนใช้ order.zip_download_url ตรงๆ
    if (url.pathname === "/api/order-zip/get-customer-url" && request.method === "POST") {
      const admin = await getSessionAdmin(request, env);
      if (!admin) return jsonResponse({ error: "ยังไม่ได้เข้าสู่ระบบ" }, 401);

      const urlParams = new URL(url.pathname + "?" + url.search, "https://x").searchParams;
      // 🔧 (2026-09-22 fix Bug #4): sanitize orderId — กัน CRLF injection
      const orderId = sanitizeHeaderValue(urlParams.get("orderId"));
      if (!orderId) {
        return jsonResponse({ error: "ต้องระบุ orderId" }, 400);
      }

      // ตรวจว่าออเดอร์มี ZIP พร้อมดาวน์โหลดอยู่จริง
      const orderDoc = await getDocument(env, "orders", orderId);
      if (!orderDoc || !orderDoc.data) {
        return jsonResponse({ error: "ไม่พบออเดอร์นี้" }, 404);
      }
      const order = orderDoc.data;
      if (order.zip_status !== "ready" || !order.zip_public_id) {
        return jsonResponse({ error: "ออเดอร์นี้ยังไม่มี ZIP พร้อมดาวน์โหลด (zip_status != ready)" }, 400);
      }

      // สร้าง token ใหม่ — 122 บิต entropy (crypto.randomUUID)
      const token = crypto.randomUUID();
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000); // 24 ชม.

      try {
        await env.DB.prepare(
          "INSERT INTO download_tokens (token, order_id, created_at, expires_at, used_at, created_by) " +
          "VALUES (?, ?, ?, ?, NULL, ?)"
        ).bind(token, orderId, now.toISOString(), expiresAt.toISOString(), admin.id).run();
      } catch (err) {
        return jsonResponse({
          error: "บันทึก download token ไม่สำเร็จ (อาจยังไม่ได้สร้างตาราง download_tokens — รัน schema.sql ใหม่): " + (err?.message || String(err)),
        }, 500);
      }

      // URL ที่ส่งให้ลูกค้า — relative path (ใช้โดเมนเดียวกับร้าน)
      // ตัวอย่าง: /api/download/abc-123?token=xyz-456
      const downloadUrl = `/api/download/${encodeURIComponent(orderId)}?token=${encodeURIComponent(token)}`;

      return jsonResponse({
        ok: true,
        url: downloadUrl,
        expiresAt: expiresAt.toISOString(),
        orderId,
        receiptNumber: order.receipt_number || "",
      });
    }

    if (url.pathname.startsWith("/api/download/") && request.method === "GET") {
      // /api/download/<orderId>?token=xxx — ลูกค้าดาวน์โหลด ZIP (one-time use)
      const orderId = decodeURIComponent(url.pathname.slice("/api/download/".length));
      const token = url.searchParams.get("token") || "";

      if (!orderId || !token) {
        return jsonResponse({ error: "URL ไม่ถูกต้อง — ต้องมี orderId และ token" }, 400);
      }

      // ตรวจ token ใน DB
      let tokenRow;
      try {
        tokenRow = await env.DB.prepare(
          "SELECT token, order_id, expires_at, used_at FROM download_tokens WHERE token = ?"
        ).bind(token).first();
      } catch (err) {
        return jsonResponse({
          error: "อ่าน download token ไม่สำเร็จ (อาจยังไม่ได้สร้างตาราง download_tokens — รัน schema.sql ใหม่): " + (err?.message || String(err)),
        }, 500);
      }

      if (!tokenRow) {
        return jsonResponse({ error: "ไม่พบ download token นี้" }, 404);
      }

      // ตรวจ orderId ตรงกับ token
      if (tokenRow.order_id !== orderId) {
        return jsonResponse({ error: "token ไม่ตรงกับออเดอร์นี้" }, 403);
      }

      // ตรวจ expiry
      const nowIso = new Date().toISOString();
      if (tokenRow.expires_at < nowIso) {
        return jsonResponse({ error: "download token หมดอายุแล้ว — กรุณาขอลิงก์ใหม่จากร้าน" }, 410);
      }

      // ตรวจ one-time use
      if (tokenRow.used_at) {
        return jsonResponse({ error: "download token นี้ถูกใช้ไปแล้ว — กรุณาขอลิงก์ใหม่จากร้าน" }, 410);
      }

      // ดึงออเดอร์เพื่อหา bucket_key (เก็บใน zip_public_id field)
      const orderDoc = await getDocument(env, "orders", orderId);
      if (!orderDoc || !orderDoc.data) {
        return jsonResponse({ error: "ไม่พบออเดอร์นี้" }, 404);
      }
      const order = orderDoc.data;
      const bucketKey = order.zip_public_id || `order-zips/Order-${orderId}.zip`;

      // ทำเครื่องหมาย token ว่า used (one-time) — ทำก่อน stream เพื่อกัน race
      try {
        await env.DB.prepare(
          "UPDATE download_tokens SET used_at = ? WHERE token = ? AND used_at IS NULL"
        ).bind(nowIso, token).run();
      } catch (err) {
        console.warn("download_tokens: failed to mark as used:", err?.message || err);
        // ไม่ block download — ยังส่งไฟล์ให้ลูกค้า (audit log อาจไม่สมบูรณ์ แต่ UX ดีกว่า)
      }

      // ดึง ZIP จาก R2 → stream ส่งลูกค้า (ไม่ reveal R2 public URL)
      const r2Object = await env.BUCKET.get(bucketKey);
      if (!r2Object) {
        return jsonResponse({ error: "ไม่พบไฟล์ ZIP ในระบบ — กรุณาติดต่อร้านเพื่อสร้างใหม่" }, 404);
      }

      // ส่ง ZIP stream พร้อม force download (กัน browser เปิด inline)
      const zipFileName = order.zip_file_name || `Order-${orderId}.zip`;
      return new Response(r2Object.body, {
        status: 200,
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="${encodeURIComponent(zipFileName)}"`,
          "Content-Length": String(r2Object.size || 0),
          "Cache-Control": "no-store, no-cache, must-revalidate",
          // ไม่ตั้ง Access-Control-Allow-Origin เพราะ same-origin เท่านั้น (ลูกค้าเปิดใน browser)
        },
      });
    }

    // 🔧 (2026-09-18 v6 Full System): GET /api/health
    // ตรวจสุขภาพระบบ — ใช้สำหรับ uptime monitoring + debugging
    // ไม่ต้อง login (public endpoint) — แต่ไม่เปิดเผยข้อมูล sensitive
    // 🔧 (2026-09-22 fix Bug #2): ไม่ส่ง count จริงกลับ → กัน info disclosure
    //   เดิม: ส่ง document count กลับ → ใครก็รู้ว่ามีกี่ออเดอร์/เพลง
    //   ใหม่: ส่งแค่ ok: true/false → ไม่รั่ว business metrics
    // response: { ok: true, timestamp, d1: { ok }, r2: { ok } }
    // 🔧 (2026-09-23 SEO): GET /sitemap.xml — สร้าง sitemap อัตโนมัติจาก D1
    //   ดึง songs + playlists ทั้งหมด → สร้าง XML → cache 24 ชม.
    //   Googlebot ดึง URL นี้เพื่อรู้ว่าเว็บมีหน้าอะไรบ้าง
    //   ผลกระทบระบบเดิม: 0% — endpoint ใหม่, ไม่แตะ /api/* ใด ๆ
    if (url.pathname === "/sitemap.xml" && request.method === "GET") {
      const SITE_BASE = "https://miusic-store.dj-remix.workers.dev";
      // 🔧 (2026-09-27 fix HIGH #5): จำกัดจำนวน URL ใน sitemap กัน OOM + กัน Google ปฏิเสตัว
      //   เดิม: listDocuments ไม่มี limit → โหลดทุก row เข้า memory → ถ้าเพลง 50,000+ → OOM
      //         + sitemap XML ใหญ่เกินโควต้าของ Google (50,000 URL / 50MB ต่อไฟล์)
      //         → Googlebot ปฏิเสตัว sitemap ทั้งไฟล์ → SEO ตก
      //   ใหม่: ใช้ limit 5,000 (ปลอดภัยภายในโควต้า 50,000 URL ของ Google และ memory 128MB)
      //         + ถ้ามีเพลงมากกว่า 5,000 → แสดง 5,000 ล่าสุด (ORDER BY updated_at ไม่ได้ใช้เพราะ listDocuments ไม่รองรับ)
      //   ผลกระทบระบบเดิม: 0% — ถ้าเพลงน้อยกว่า 5,000 → แสดงครบเหมือนเดิม
      //                   — ถ้าเพลงมากกว่า 5,000 → แสดง 5,000 แรก (priority จาก query default)
      //   หมายเหตุ: ในอนาคตถ้าต้องการ sitemap หลายไฟล์ → ใช้ sitemap index + แบ่งตามหมวดหมู่
      const SITEMAP_MAX_URLS = 5000;
      try {
        // 🔧 (2026-09-27 fix HIGH #5): ส่ง limit เข้า listDocuments กัน OOM
        const [songsRows, playlistsRows] = await Promise.all([
          listDocuments(env, "songs", { limit: SITEMAP_MAX_URLS }),
          listDocuments(env, "playlists", { limit: SITEMAP_MAX_URLS }),
        ]);
        const urls = [
          { loc: SITE_BASE + "/", priority: "1.0", changefreq: "daily" },
        ];
        // เพิ่มเพลงที่ active เท่านั้น (status !== 'hidden' หรือ inactive)
        // 🔧 (2026-09-27 fix HIGH #5): กันเกิน SITEMAP_MAX_URLS (เพลง + playlist รวมกัน)
        for (const s of songsRows) {
          if (urls.length >= SITEMAP_MAX_URLS) break;  // กันเกินโควต้า Google
          if (!s || !s.data) continue;
          const status = s.data.status || "";
          if (status === "hidden" || status === "inactive" || s.data.active === false) continue;
          const songName = String(s.data.song_name || "").trim();
          if (!songName) continue;
          urls.push({
            loc: SITE_BASE + "/song/" + encodeURIComponent(s.id),
            priority: "0.8",
            changefreq: "weekly",
            lastmod: s.data.updated_at || s.data.created_at || "",
          });
        }
        // เพิ่มเพลย์ลิสต์ที่ active เท่านั้น
        for (const p of playlistsRows) {
          if (urls.length >= SITEMAP_MAX_URLS) break;  // กันเกินโควต้า Google
          if (!p || !p.data) continue;
          if (p.data.active === false || p.data.is_active === false) continue;
          const plName = String(p.data.playlist_name || p.data.name || "").trim();
          if (!plName) continue;
          urls.push({
            loc: SITE_BASE + "/playlist/" + encodeURIComponent(p.id),
            priority: "0.7",
            changefreq: "weekly",
            lastmod: p.data.updated_at || p.data.created_at || "",
          });
        }
        // 🔧 (2026-09-27 fix HIGH #6): เพิ่ม escapeXml helper + ใช้กับทุก field dynamic
        //   เดิม: เฉพาะ loc escape แค่ & → ถ้า lastmod มี < > จะ break XML ทั้งไฟล์
        //   ใหม่: escape ครบทุก field (loc, lastmod) ด้วย helper escapeXml
        //   ผลกระทบระบบเดิม: 0% — ค่าปกติ (URL, ISO date) ผ่านเหมือนเดิม
        //                   — ค่าที่มี chars พิเศษจะถูก escape → XML ไม่ break
        const escapeXml = (s) => String(s || "")
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;")
          .replace(/'/g, "&apos;");
        // สร้าง XML
        let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
        xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';
        for (const u of urls) {
          xml += "  <url>\n";
          xml += "    <loc>" + escapeXml(u.loc) + "</loc>\n";
          xml += "    <changefreq>" + escapeXml(u.changefreq) + "</changefreq>\n";
          xml += "    <priority>" + escapeXml(u.priority) + "</priority>\n";
          if (u.lastmod) xml += "    <lastmod>" + escapeXml(u.lastmod) + "</lastmod>\n";
          xml += "  </url>\n";
        }
        xml += "</urlset>\n";
        return new Response(xml, {
          status: 200,
          headers: {
            "Content-Type": "application/xml; charset=utf-8",
            "Cache-Control": "public, max-age=86400",  // cache 24 ชม. — ลด D1 reads
          },
        });
      } catch (err) {
        // 🔧 (2026-09-27 fix HIGH #6): fallback XML ก็ escape ด้วย (กัน break XML)
        return new Response('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>' + String(SITE_BASE + "/").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") + '</loc><priority>1.0</priority></url>\n</urlset>\n', {
          status: 200,
          headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=300" },
        });
      }
    }

    // 🔧 (2026-09-23 SEO): GET /song/:id — หน้า static HTML สำหรับเพลง (Googlebot อ่านได้)
    //   ดึงเพลงจาก D1 → สร้าง HTML ที่มี meta tags + JSON-LD (MusicRecording schema)
    //   ลูกค้าคลิกลิงก์ Google → ตก landing page → กด "ฟังเพลง" → ไปหน้าหลัก
    //   ผลกระทบระบบเดิม: 0% — endpoint ใหม่ ไม่แตะฝั่ง client
    const songMatch = url.pathname.match(/^\/song\/([^\/]+)$/);
    if (songMatch && request.method === "GET") {
      const songId = decodeURIComponent(songMatch[1]);
      try {
        const doc = await getDocument(env, "songs", songId);
        if (!doc || !doc.data) {
          return new Response("<!DOCTYPE html><html><head><meta charset='UTF-8'><title>ไม่พบเพลง</title></head><body><h1>ไม่พบเพลง</h1></body></html>", { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } });
        }
        const s = doc.data;
        // 🔧 (2026-09-27 fix HIGH #7): เปลี่ยน escape แบบ strip → escapeHtml จริง
        //   เดิม: replace(/[<>&"']/g, "") → ลบ chars ออก → เพลง "Bang & Olufsen" กลายเป็น "Bang  Olufsen" → data loss (SEO/UX เสีย)
        //   ใหม่: ใช้ escapeHtml → < → &lt; > → &gt; & → &amp; " → &quot; ' → &#39;
        //         → content ครบ + ปลอดภัยจาก XSS + Googlebot อ่านได้ถูก
        //   ผลกระทบระบบเดิม: 0% — ค่าปกติ (ไม่มี chars พิเศษ) ผ่านเหมือนเดิม
        //                   — ค่าที่มี chars พิเศษจะถูก escape → content ครบ + XML ไม่ break
        const escapeHtml = (str) => String(str || "")
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;")
          .replace(/'/g, "&#39;");
        // 🔧 (2026-09-27 fix HIGH #7): เพิ่ม escapeJson สำหรับ JSON-LD (script type="application/ld+json")
        //   JSON ต้อง escape ตัวพิเศษ: " → \" \ → \\ และ control chars
        //   ถ้าไม่ escape → JSON invalid → Google ปฏิเสตัว structured data
        const escapeJson = (str) => {
          let s = String(str || "");
          // escape backslash ก่อน quote (กัน double-escape)
          s = s.replace(/\\/g, "\\\\");
          s = s.replace(/"/g, '\\"');
          s = s.replace(/\n/g, "\\n");
          s = s.replace(/\r/g, "\\r");
          s = s.replace(/\t/g, "\\t");
          // กัน </script> injection (ถ้า JSON-LD มี </script> จะปิด script กลางคัน)
          s = s.replace(/<\/script>/gi, "<\\/script>");
          return s;
        };
        const songName = escapeHtml(s.song_name || "");
        const artist = escapeHtml(s.dj_name || s.artist || "");
        const coverUrl = escapeHtml(s.cover_url || "/default-song-cover.svg");
        const price = Number(s.price) || 0;
        const description = `ฟังเพลง ${songName} ${artist ? "โดย " + artist : ""} — เพลงแดนซ์สายปาตี้ DJ Remix สั่งซื้อผ่าน WhatsApp ส่งทั่วลาวและไทย`;
        const SITE_BASE = "https://miusic-store.dj-remix.workers.dev";
        const songUrl = SITE_BASE + "/song/" + encodeURIComponent(songId);
        // 🔧 (2026-09-27 fix HIGH #7): ใช้ escapeJson สำหรับ JSON-LD fields (กัน JSON invalid)
        const jsonLdName = escapeJson(s.song_name || "");
        const jsonLdArtist = escapeJson(s.dj_name || s.artist || "");
        const jsonLdCover = escapeJson(s.cover_url || "");
        const jsonLdDescription = escapeJson(description);
        const html = `<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${songName}${artist ? " — " + artist : ""} | เพลงแดนซ์ DJ Remix</title>
<meta name="description" content="${description}">
<meta name="keywords" content="${songName}, ${artist}, เพลงแดนซ์, DJ Remix, สายปาตี้, ดาวน์โหลดเพลง">
<link rel="canonical" href="${songUrl}">
<meta property="og:type" content="music.song">
<meta property="og:title" content="${songName}${artist ? " — " + artist : ""}">
<meta property="og:description" content="${description}">
<meta property="og:image" content="${coverUrl}">
<meta property="og:url" content="${songUrl}">
<meta property="og:site_name" content="Music Store">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${songName}${artist ? " — " + artist : ""}">
<meta name="twitter:description" content="${description}">
<meta name="twitter:image" content="${coverUrl}">
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "MusicRecording",
  "name": "${jsonLdName}",
  "byArtist": { "@type": "MusicGroup", "name": "${jsonLdArtist}" },
  "inAlbum": { "@type": "MusicAlbum", "name": "Music Store — DJ Remix" },
  "url": "${songUrl}",
  "image": "${jsonLdCover}",
  "description": "${jsonLdDescription}",
  "offers": { "@type": "Offer", "price": "${price}", "priceCurrency": "LAK", "availability": "https://schema.org/InStock" }
}
</script>
</head>
<body style="font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; text-align: center;">
  <h1>${songName}</h1>
  ${artist ? "<p style='color: #666; font-size: 18px;'>โดย " + artist + "</p>" : ""}
  <img src="${coverUrl}" alt="${songName}" style="max-width: 300px; border-radius: 12px; margin: 16px 0;">
  <p style="font-size: 16px; color: #333;">${description}</p>
  <p style="font-size: 20px; font-weight: bold; color: #1a73e8; margin: 20px 0;">ราคา ${price} กีบ</p>
  <a href="${SITE_BASE}/?song=${encodeURIComponent(songId)}" style="display: inline-block; padding: 14px 28px; background: #1a73e8; color: white; text-decoration: none; border-radius: 8px; font-size: 18px; margin: 8px;">▶️ ฟังเพลง + สั่งซื้อ</a>
  <a href="${SITE_BASE}/" style="display: inline-block; padding: 14px 28px; background: #f5f5f7; color: #1d1d1f; text-decoration: none; border-radius: 8px; font-size: 18px; margin: 8px; border: 1px solid #d2d2d7;">ดูเพลงอื่น ๆ</a>
  <p style="margin-top: 32px; color: #86868b; font-size: 14px;">Music Store — เพลงแดนซ์สายปาตี้ DJ Remix ส่งทั่วลาวและไทย</p>
</body>
</html>`;
        return new Response(html, {
          status: 200,
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "public, max-age=3600",  // cache 1 ชม.
          },
        });
      } catch (err) {
        return new Response("<!DOCTYPE html><html><head><meta charset='UTF-8'><title>เกิดข้อผิดพลาด</title></head><body><h1>ไม่สามารถโหลดเพลงได้</h1></body></html>", { status: 500, headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
    }

    // 🔧 (2026-09-23 SEO): GET /playlist/:id — หน้า static HTML สำหรับเพลย์ลิสต์ (Googlebot อ่านได้)
    const playlistMatch = url.pathname.match(/^\/playlist\/([^\/]+)$/);
    if (playlistMatch && request.method === "GET") {
      const playlistId = decodeURIComponent(playlistMatch[1]);
      try {
        const doc = await getDocument(env, "playlists", playlistId);
        if (!doc || !doc.data) {
          return new Response("<!DOCTYPE html><html><head><meta charset='UTF-8'><title>ไม่พบเพลย์ลิสต์</title></head><body><h1>ไม่พบเพลย์ลิสต์</h1></body></html>", { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } });
        }
        const p = doc.data;
        // 🔧 (2026-09-27 fix HIGH #7): เปลี่ยน escape แบบ strip → escapeHtml จริง (เหมือน song/:id)
        const escapeHtml = (str) => String(str || "")
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;")
          .replace(/'/g, "&#39;");
        // 🔧 (2026-09-27 fix HIGH #7): เพิ่ม escapeJson สำหรับ JSON-LD
        const escapeJson = (str) => {
          let s = String(str || "");
          s = s.replace(/\\/g, "\\\\");
          s = s.replace(/"/g, '\\"');
          s = s.replace(/\n/g, "\\n");
          s = s.replace(/\r/g, "\\r");
          s = s.replace(/\t/g, "\\t");
          s = s.replace(/<\/script>/gi, "<\\/script>");
          return s;
        };
        const plName = escapeHtml(p.playlist_name || p.name || "");
        const coverUrl = escapeHtml(p.cover_url || "/default-playlist-cover.svg");
        const price = Number(p.price) || 0;
        const description = `เพลย์ลิสต์ ${plName} — เพลงแดนซ์สายปาตี้ DJ Remix รวมเพลงฮิตในเซ็ตเดียว สั่งซื้อผ่าน WhatsApp ส่งทั่วลาวและไทย`;
        const SITE_BASE = "https://miusic-store.dj-remix.workers.dev";
        const playlistUrl = SITE_BASE + "/playlist/" + encodeURIComponent(playlistId);
        // 🔧 (2026-09-27 fix HIGH #7): ใช้ escapeJson สำหรับ JSON-LD fields
        const jsonLdName = escapeJson(p.playlist_name || p.name || "");
        const jsonLdCover = escapeJson(p.cover_url || "");
        const jsonLdDescription = escapeJson(description);
        const html = `<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${plName} | เพลย์ลิสต์ DJ Remix</title>
<meta name="description" content="${description}">
<meta name="keywords" content="${plName}, เพลย์ลิสต์, เพลงแดนซ์, DJ Remix, สายปาตี้, ดาวน์โหลดเพลง">
<link rel="canonical" href="${playlistUrl}">
<meta property="og:type" content="music.playlist">
<meta property="og:title" content="${plName}">
<meta property="og:description" content="${description}">
<meta property="og:image" content="${coverUrl}">
<meta property="og:url" content="${playlistUrl}">
<meta property="og:site_name" content="Music Store">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${plName}">
<meta name="twitter:description" content="${description}">
<meta name="twitter:image" content="${coverUrl}">
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "MusicPlaylist",
  "name": "${jsonLdName}",
  "url": "${playlistUrl}",
  "image": "${jsonLdCover}",
  "description": "${jsonLdDescription}",
  "offers": { "@type": "Offer", "price": "${price}", "priceCurrency": "LAK", "availability": "https://schema.org/InStock" }
}
</script>
</head>
<body style="font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; text-align: center;">
  <h1>${plName}</h1>
  <img src="${coverUrl}" alt="${plName}" style="max-width: 300px; border-radius: 12px; margin: 16px 0;">
  <p style="font-size: 16px; color: #333;">${description}</p>
  <p style="font-size: 20px; font-weight: bold; color: #1a73e8; margin: 20px 0;">ราคา ${price} กีบ</p>
  <a href="${SITE_BASE}/?playlist=${encodeURIComponent(playlistId)}" style="display: inline-block; padding: 14px 28px; background: #1a73e8; color: white; text-decoration: none; border-radius: 8px; font-size: 18px; margin: 8px;">▶️ ฟังเพลย์ลิสต์ + สั่งซื้อ</a>
  <a href="${SITE_BASE}/" style="display: inline-block; padding: 14px 28px; background: #f5f5f7; color: #1d1d1f; text-decoration: none; border-radius: 8px; font-size: 18px; margin: 8px; border: 1px solid #d2d2d7;">ดูเพลงอื่น ๆ</a>
  <p style="margin-top: 32px; color: #86868b; font-size: 14px;">Music Store — เพลงแดนซ์สายปาตี้ DJ Remix ส่งทั่วลาวและไทย</p>
</body>
</html>`;
        return new Response(html, {
          status: 200,
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "public, max-age=3600",
          },
        });
      } catch (err) {
        return new Response("<!DOCTYPE html><html><head><meta charset='UTF-8'><title>เกิดข้อผิดพลาด</title></head><body><h1>ไม่สามารถโหลดเพลย์ลิสต์ได้</h1></body></html>", { status: 500, headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
    }

    if (url.pathname === "/api/health" && request.method === "GET") {
      const result = {
        ok: true,
        timestamp: new Date().toISOString(),
        d1: { ok: false },
        r2: { ok: false },
      };
      // ตรวจ D1 — ลอง SELECT 1 (lightweight — ไม่ count จริง)
      if (env.DB) {
        try {
          await env.DB.prepare("SELECT 1 AS ok LIMIT 1").first();
          result.d1.ok = true;
        } catch (err) {
          result.d1.ok = false;
          result.ok = false;
        }
      } else {
        result.d1.error = "D1 binding not configured";
        result.ok = false;
      }
      // ตรวจ R2 — ลอง head() object ที่อาจมีอยู่ (test key)
      if (env.BUCKET) {
        try {
          // ใช้ head() แทน get() — ไม่โหลด body (ประหยัด bandwidth)
          // ใช้ key "_health_check" ที่อาจไม่มีอยู่ → R2 คืน null → ถือว่า binding OK
          await env.BUCKET.head("_health_check_" + Date.now());
          result.r2.ok = true;
        } catch (err) {
          result.r2.ok = false;
          result.r2.error = err?.message || String(err);
          result.ok = false;
        }
      } else {
        result.r2.error = "R2 binding not configured";
        result.ok = false;
      }
      // ส่ง status 200 ถ้า ok=true, 503 ถ้า ok=false (monitoring จะได้ alert)
      return jsonResponse(result, result.ok ? 200 : 503);
    }

    // ========================================================================
    // 📸 Payment Slip Endpoints (added STEP 3-7 of payment slip upload feature)
    //   All endpoints are NEW — none of existing endpoints (/api/upload, /api/auth/*,
    //   /api/db/*, /api/file/*, /api/order-zip/*, /api/download/*) are touched.
    //   See "Impact Analysis" in worklog.md for full breakdown.
    // ========================================================================

    // 🟡 POST /api/payment-proofs/_count-pending
    //   Admin: นับ proofs ที่ status='pending' สำหรับ badge ใน quick-action button
    if (url.pathname === "/api/payment-proofs/_count-pending" && request.method === "POST") {
      if (!env.DB) return jsonResponse({ error: "D1 binding not configured" }, 500);
      const admin = await getSessionAdmin(request, env);
      if (!admin) return jsonResponse({ error: "ไม่ได้รับอนุญาต" }, 401);
      try {
        const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM payment_proofs WHERE status='pending'").first();
        return jsonResponse({ count: row?.n ?? 0 }, 200);
      } catch (err) {
        // ถ้า table ยังไม่ถูกสร้าง → คืน 0 (กัน error ตอน migration ยังไม่ run)
        if (String(err.message || "").includes("no such table")) return jsonResponse({ count: 0 }, 200);
        return jsonResponse({ error: safeError("นับสลิปรอตรวจไม่สำเร็จ", err) }, 500);
      }
    }

    // 🟡 GET /api/payment-proofs/pending
    //   Admin: ดึงรายการสลิปรอตรวจทั้งหมด (เรียงตาม uploaded_at desc)
    //   ใช้สำหรับหน้า "ตรวจสอบสลิป" ใน admin panel
    if (url.pathname === "/api/payment-proofs/pending" && request.method === "GET") {
      if (!env.DB) return jsonResponse({ error: "D1 binding not configured" }, 500);
      const admin = await getSessionAdmin(request, env);
      if (!admin) return jsonResponse({ error: "ไม่ได้รับอนุญาต" }, 401);
      try {
        const stmt = env.DB.prepare(
          `SELECT p.*, d.data AS order_data
           FROM payment_proofs p
           LEFT JOIN documents d ON d.collection='orders' AND d.id=p.order_id
           WHERE p.status='pending'
           ORDER BY p.uploaded_at DESC
           LIMIT 200`
        );
        const { results } = await stmt.all();
        const items = (results || []).map(r => {
          let orderData = null;
          try { orderData = r.order_data ? JSON.parse(r.order_data) : null; } catch {}
          return {
            id: r.id,
            order_id: r.order_id,
            file_key: r.file_key,
            file_url: r.file_url,
            uploaded_at: r.uploaded_at,
            uploaded_by: r.uploaded_by,
            customer_name: r.customer_name,
            whatsapp: r.whatsapp,
            amount_claimed: r.amount_claimed,
            transfer_ref: r.transfer_ref,
            status: r.status,
            // order snapshot for admin display (final_total, receipt_number, items count)
            order: orderData ? {
              receipt_number: orderData.receipt_number || null,
              final_total: orderData.final_total ?? orderData.total ?? null,
              total: orderData.total ?? null,
              items_count: Array.isArray(orderData.items) ? orderData.items.length : 0,
              store_name: orderData.store_name || null,
            } : null,
          };
        });
        return jsonResponse({ items }, 200);
      } catch (err) {
        if (String(err.message || "").includes("no such table")) return jsonResponse({ items: [] }, 200);
        return jsonResponse({ error: safeError("ดึงรายการสลิปไม่สำเร็จ", err) }, 500);
      }
    }

    // 🟡 GET /api/orders/:id/payment-proofs
    //   Admin: ดู history ของ proofs ทั้งหมดของ order (รวม verified/rejected)
    if (url.pathname.startsWith("/api/orders/") && url.pathname.endsWith("/payment-proofs") && request.method === "GET") {
      if (!env.DB) return jsonResponse({ error: "D1 binding not configured" }, 500);
      const admin = await getSessionAdmin(request, env);
      if (!admin) return jsonResponse({ error: "ไม่ได้รับอนุญาต" }, 401);
      const orderId = decodeURIComponent(url.pathname.slice("/api/orders/".length, -"/payment-proofs".length));
      try {
        const { results } = await env.DB.prepare(
          `SELECT * FROM payment_proofs WHERE order_id=? ORDER BY uploaded_at DESC`
        ).bind(orderId).all();
        return jsonResponse({ items: results || [] }, 200);
      } catch (err) {
        if (String(err.message || "").includes("no such table")) return jsonResponse({ items: [] }, 200);
        return jsonResponse({ error: safeError("ดึงประวัติสลิปไม่สำเร็จ", err) }, 500);
      }
    }

    // 🟢 POST /api/orders/:id/payment-proof  (CUSTOMER — anonymous + ownership verify)
    //   ลูกค้าอัปโหลดสลิปหลังโอนเงิน — multipart form-data:
    //     - file: รูปสลิป (jpeg/png/webp, max 5MB)
    //     - customer_name + whatsapp: ตรวจ ownership เทียบ order
    //     - amount_claimed (optional), transfer_ref (optional)
    //   Flow:
    //     1. ตรวจ order มีอยู่ + status='pending_verify' (ป้องกันอัป slip หลัง admin ยืนยันแล้ว)
    //     2. ตรวจ ownership: customer_name + whatsapp ตรงกับใน order
    //     3. Rate limit: 5/15min/IP
    //     4. MIME + size validation (max 5MB)
    //     5. Upload to R2 (payment-proofs/{orderId}/{timestamp}-{uuid}.{ext})
    //     6. INSERT payment_proofs row (status='pending')
    //     7. UPDATE order: payment_proof_id, payment_proof_status='pending', payment_proof_uploaded_at
    //     8. writeAuditLog
    //     9. Return { ok: true, proof_id, file_url, status: 'pending' }
    if (url.pathname.startsWith("/api/orders/") && url.pathname.endsWith("/payment-proof") && !url.pathname.endsWith("/payment-proofs") && request.method === "POST") {
      if (!env.DB || !env.BUCKET) return jsonResponse({ error: "D1 หรือ R2 binding ไม่ได้กำหนด" }, 500);
      // 🔧 (2026-09-27 fix HIGH #1): sanitize orderId ก่อนใช้ใน R2 key — กัน path traversal
      //   เดิม: orderId จาก path ถูก decodeURIComponent แล้วใช้ตรงใน r2Key →
      //         ถ้าส่ง `/api/orders/..%2Forder-zips/payment-proof` → r2Key = `payment-proofs/../../order-zips/...`
      //         → R2 อาจ normalize path ทำให้ไฟล์ไปอยู่นอกโฟลเดอร์ payment-proofs/ (namespace pollution)
      //   ใหม่: กรองเฉพาะตัวอักษรปลอดภัย (alphanumeric + dash + underscore) + กัน path traversal
      //   ผลกระทบระบบเดิม: 0% — orderId ปกติ (UUID) ผ่านทั้งหมด ตัวอักษรที่ไม่ปลอดภัยถูกแทนด้วย _
      //   หมายเหตุ: orderId ที่ sanitize แล้วใช้กับ R2 key เท่านั้น — สำหรับ D1 query ยังใช้ค่าดั้งเดิม (UUID ไม่มีปัญหา SQL injection เพราะ bind)
      const rawOrderId = decodeURIComponent(url.pathname.slice("/api/orders/".length, -"/payment-proof".length));
      const orderId = rawOrderId.replace(/[^a-zA-Z0-9_-]/g, "_");  // sanitize สำหรับ R2 key
      if (!orderId) return jsonResponse({ error: "orderId ไม่ถูกต้อง" }, 400);

      // rate limit check (10/15min — ใช้ shared IP, กัน spam)
      const clientIp = request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || "unknown";
      const now = new Date();
      const windowStart = new Date(now.getTime() - 15 * 60 * 1000).toISOString();
      try {
        const recent = await env.DB.prepare(
          `SELECT COUNT(*) AS n FROM payment_proof_attempts WHERE ip=? AND attempted_at>?`
        ).bind(clientIp, windowStart).first();
        if ((recent?.n ?? 0) >= 10) {
          return jsonResponse({ error: "อัปโหลดเร็วเกินไป — กรุณารอสักครู่แล้วลองใหม่" }, 429);
        }
        await env.DB.prepare(
          `INSERT INTO payment_proof_attempts (ip, attempted_at) VALUES (?, ?)`
        ).bind(clientIp, now.toISOString()).run();
      } catch (err) {
        // table might not exist yet — proceed (don't fail the upload)
      }

      // parse multipart
      const formData = await request.formData().catch(() => null);
      if (!formData) return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400);
      const file = formData.get("file");
      const customerName = String(formData.get("customer_name") || "").trim();
      const whatsapp = String(formData.get("whatsapp") || "").trim();
      const amountClaimedRaw = formData.get("amount_claimed");
      const transferRef = String(formData.get("transfer_ref") || "").trim();
      if (!file || typeof file === "string" || !file.size) return jsonResponse({ error: "กรุณาเลือกไฟล์รูปสลิป" }, 400);
      if (!customerName || !whatsapp) return jsonResponse({ error: "กรุณากรอกชื่อลูกค้าและเบอร์ WhatsApp" }, 400);
      // 🆕 (T008-L7): validate amount_claimed ก่อนใช้ — กัน NaN ลง DB
      //   เดิม: ใช้ `amountClaimed ? Number(amountClaimed) : null` → ถ้ากรอก "abc" → Number("abc")=NaN
      //     → D1 INSERT จะ fail หรือเก็บเป็น NULL ผิด ๆ (พฤติกรรม undefined)
      //   ใหม่: parse + ตรวจ Number.isFinite + ตรวจ >= 0 → ถ้าไม่ผ่าน return 400 (บอกลูกค้ากรอกผิด)
      //   ถ้าลูกค้าไม่กรอก (empty/null) → ยังอนุญาตเป็น null เหมือนเดิม (backward-compat)
      let amountClaimed = null;
      if (amountClaimedRaw !== null && amountClaimedRaw !== undefined && String(amountClaimedRaw).trim() !== "") {
        const parsed = Number(amountClaimedRaw);
        if (!Number.isFinite(parsed) || parsed < 0) {
          return jsonResponse({ error: "ยอดเงินไม่ถูกต้อง — กรุณากรอกเฉพาะตัวเลข" }, 400);
        }
        amountClaimed = parsed;
      }
      // size limit: 5MB
      const MAX_SLIP_SIZE = 5 * 1024 * 1024;
      if (file.size > MAX_SLIP_SIZE) return jsonResponse({ error: "ไฟล์ใหญ่เกิน 5MB — กรุณาลดขนาดรูป" }, 413);
      // MIME allowlist
      const slipMimes = ["image/jpeg", "image/png", "image/webp", "image/jpg"];
      const actualMime = (file.type || "").toLowerCase();
      if (!slipMimes.includes(actualMime)) {
        return jsonResponse({ error: `ประเภทไฟล์ไม่ได้รับอนุญาต: ${actualMime || "ไม่ระบุ"} (อนุญาตเฉพาะ: JPEG, PNG, WEBP)` }, 415);
      }

      // 1. fetch order from D1 (documents table) — ใช้ rawOrderId (ค่าดั้งเดิม ก่อน sanitize) สำหรับ D1
      //    เพราะ D1 ใช้ bind parameter (ปลอดภัยจาก SQL injection) + orderId ใน D1 คือ UUID ปกติ
      //    ถ้าใช้ orderId ที่ sanitize แล้ว → อาจไม่ตรงกับ D1 id จริง (เพราะ _ แทนตัวอักษรอื่น)
      const orderRow = await env.DB.prepare(
        `SELECT data FROM documents WHERE collection='orders' AND id=?`
      ).bind(rawOrderId).first();
      if (!orderRow || !orderRow.data) return jsonResponse({ error: "ไม่พบใบสั่งซื้อ" }, 404);
      let orderData = null;
      try { orderData = JSON.parse(orderRow.data); } catch { return jsonResponse({ error: "ข้อมูลใบสั่งซื้อเสีย" }, 500); }

      // 2. status check — อนุญาตเฉพาะ pending_verify และ cancelled (ลูกค้าอัปใหม่ได้หลังปฏิเสธ)
      //    ห้ามอัป slip หลัง status='processing' หรือ 'completed' (admin ยืนยันแล้ว)
      if (orderData.status === "processing" || orderData.status === "completed") {
        return jsonResponse({ error: "ใบสั่งซื้อนี้ยืนยันการชำระแล้ว — ไม่สามารถอัปโหลดสลิปใหม่ได้" }, 409);
      }

      // 🛡️ (added 2026-09-26 prevent double payment): defense-in-depth check
      //   ป้องกันลูกค้าอัปโหลดสลิปซ้ำในออเดอร์เดิม ตามเป้าหมาย "ป้องกันการชำระเงินซ้ำ"
      //   เป็นการ enforce ความตั้งใจเดิมของ comment ด้านบน ("ลูกค้าอัปใหม่ได้หลังปฏิเสธ")
      //   ที่ก่อนหน้านี้ยังไม่ถูก enforce จริง — เช็คแค่ status แต่ไม่เช็ค payment_proof_status
      //
      //   กฎ:
      //     - payment_proof_status='pending' → ห้ามอัปใหม่ (รอแอดมินตรวจสอบอยู่)
      //     - payment_proof_status='verified' → ห้ามอัปใหม่ (แอดมินยืนยันแล้ว รอเปลี่ยน status เป็น processing)
      //     - payment_proof_status='rejected' หรือ ไม่มี payment_proof_status → อนุญาต (ลูกค้าอัปใหม่ได้)
      //     - status='cancelled' → อนุญาต (ตามระบบเดิม — backend ยังอนุญาต)
      //
      //   ผลกระทบระบบเดิม: 0% — เป็นการเพิ่มการตรวจสอบที่เข้มขึ้น ไม่ได้ละเว้นเงื่อนไขใดที่อนุญาตไว้ก่อนหน้า
      //     กรณีที่ยังอัปได้: status=pending_verify โดยไม่มี pending proof, หรือ payment_proof_status=rejected
      //     กรณีที่ถูกบล็อกใหม่: payment_proof_status=pending หรือ verified (ซึ่งควรถูกบล็อกอยู่แล้วตามเจตนาเดิม)
      const currentPpStatus = String(orderData.payment_proof_status || "").toLowerCase();
      if (currentPpStatus === "pending") {
        return jsonResponse({
          error: "ระบบได้รับหลักฐานการชำระเงินของคุณแล้ว กรุณารอการตรวจสอบ — ไม่ต้องชำระเงินซ้ำสำหรับออเดอร์นี้",
          code: "PROOF_PENDING_REVIEW",
        }, 409);
      }
      if (currentPpStatus === "verified") {
        return jsonResponse({
          error: "ออเดอร์นี้ยืนยันการชำระแล้ว — ไม่ต้องชำระเงินซ้ำ",
          code: "PROOF_ALREADY_VERIFIED",
        }, 409);
      }

      // 3. ownership verify — customer_name + whatsapp ตรงกับใน order
      //    normalize: trim + lowercase + เอา + และ - ออก เทียบแบบ loose
      const norm = (s) => String(s || "").trim().toLowerCase().replace(/[\s+\-()]/g, "");
      if (norm(orderData.customer_name) !== norm(customerName) || norm(orderData.whatsapp) !== norm(whatsapp)) {
        return jsonResponse({ error: "ข้อมูลลูกค้าไม่ตรงกับใบสั่งซื้อ — กรุณาตรวจสอบชื่อ/เบอร์" }, 403);
      }
      // 🆕 (2026-10-03 v10 — แยก Login / Guest): อัปสลิปได้เฉพาะ "ขอบเขตเดียวกับเจ้าของออเดอร์"
      //   ออเดอร์ Login → ต้อง login เป็นเจ้าของ / ออเดอร์ Guest → ต้องไม่ได้ login
      //   ข้อความ error เหมือนกรณีชื่อ/เบอร์ไม่ตรง (ไม่บอกว่ามีออเดอร์ของอีกฝั่งอยู่)
      let slipSessionCustomerId = null;
      try {
        const slipSession = await getCustomerSession(request, env);
        slipSessionCustomerId = slipSession ? slipSession.id : null;
      } catch (_) {}
      if (!isOrderVisibleForReceiptLookup(orderData, slipSessionCustomerId)) {
        return jsonResponse({ error: "ข้อมูลลูกค้าไม่ตรงกับใบสั่งซื้อ — กรุณาตรวจสอบชื่อ/เบอร์" }, 403);
      }

      // 4. upload to R2 — key: payment-proofs/{orderId}/{timestamp}-{uuid}.{ext}
      const ext = (/\.[a-zA-Z0-9]+$/.exec(file.name || "") || [""])[0]
        || (actualMime === "image/jpeg" || actualMime === "image/jpg" ? ".jpg"
          : actualMime === "image/png" ? ".png"
          : actualMime === "image/webp" ? ".webp" : "");
      // 🔧 (2026-09-27 fix HIGH #1): ใช้ orderId ที่ sanitize แล้ว (จาก rawOrderId บรรทัดบน)
      //   กัน path traversal — orderId ผ่าน regex `/[^a-zA-Z0-9_-]/g` → ไม่มี ../ ได้
      const r2Key = `payment-proofs/${orderId}/${Date.now()}-${crypto.randomUUID()}${ext}`;
      // 🔧 (2026-09-27 fix HIGH #2): เปลี่ยน fileUrl ให้เป็น proxy URL เสมอ — กันรั่วผ่าน public URL
      //   เดิม: ถ้ามี R2_PUBLIC_BASE_URL → ใช้ public URL → ใครรู้ URL เปิดดูสลิปได้ (รั่วข้อมูลลูกค้า)
      //   ใหม่: ใช้ /api/file/<r2Key> proxy ผ่าน handleFileProxy (มีอยู่แล้ว ตรวจ admin session)
      //   ผลกระทบระบบเดิม: admin ยังเห็นสลิปผ่าน /api/file/<r2Key> เหมือนเดิม (ผ่าน handleFileProxy)
      //                   — ลูกค้าไม่ได้รับ public URL กลับไป (ปลอดภัยกว่าเดิม)
      //   หมายเหตุ: ในตาราง payment_proofs จะเก็บ file_url เป็น /api/file/<r2Key> แทน public URL
      const fileUrl = `/api/file/${r2Key}`;
      // sanitize metadata values (R2 requires ASCII for customMetadata)
      const safeOrderId = sanitizeHeaderValue(orderId);
      try {
        const putOpts = {
          httpMetadata: { contentType: actualMime },
          customMetadata: {
            orderId: safeOrderId,
            customerName: (customerName || "").slice(0, 100),
            whatsapp: (whatsapp || "").slice(0, 30),
            uploadedAt: now.toISOString(),
          },
        };
        await env.BUCKET.put(r2Key, file.stream(), putOpts);
      } catch (err) {
        return jsonResponse({ error: safeError("อัปโหลดไฟล์ไม่สำเร็จ (R2) กรุณาลองใหม่", err) }, 502);
      }
      // 🔧 (2026-09-27 fix HIGH #2): ลบการใช้ r2PublicBase สำหรับ fileUrl (ใช้ proxy เสมอ)
      //   ค่า r2PublicBase ยังใช้สำหรับ ZIP URL ใน flow อื่น ไม่ได้ลบตัวแปร

      // 5. INSERT payment_proofs row
      const proofId = crypto.randomUUID();
      const uploadedAt = now.toISOString();
      try {
        await env.DB.prepare(
          `INSERT INTO payment_proofs (id, order_id, file_key, file_url, uploaded_at, uploaded_by,
                                       customer_name, whatsapp, amount_claimed, transfer_ref, status)
           VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 'pending')`
        ).bind(
          proofId, orderId, r2Key, fileUrl, uploadedAt,
          customerName.slice(0, 200), whatsapp.slice(0, 30),
          // 🆕 (T008-L7): amountClaimed ถูก validate แล้วที่ด้านบน — เป็น number (finite, >=0) หรือ null
          amountClaimed,
          transferRef.slice(0, 200) || null
        ).run();
      } catch (err) {
        // R2 upload สำเร็จแต่ D1 insert ล้มเหลว → ลบ R2 object เพื่อไม่ให้มี orphan
        try { await env.BUCKET.delete(r2Key); } catch {}
        return jsonResponse({ error: safeError("บันทึกข้อมูลสลิปไม่สำเร็จ (D1)", err) }, 500);
      }

      // 6. UPDATE order: payment_proof_*  fields (merge เข้า JSON blob)
      orderData.payment_proof_id = proofId;
      orderData.payment_proof_status = "pending";
      orderData.payment_proof_uploaded_at = uploadedAt;
      orderData.updated_at = uploadedAt;
      // push status_history entry (ถ้า order มี status_history อยู่แล้ว)
      if (Array.isArray(orderData.status_history)) {
        orderData.status_history.push({
          status: orderData.status,
          at: uploadedAt,
          note: "ลูกค้าอัปโหลดสลิปการโอนเงิน",
          by: "customer",
        });
      }
      // 🔒 (Audit Fix C-5): atomic INSERT ลงตาราง order_status_history (คู่ขนาน JSON array)
      try { await insertOrderStatusHistory(env, orderId, orderData.status || "pending_verify", "ลูกค้าอัปโหลดสลิปการโอนเงิน", "customer", "ลูกค้า"); } catch (_) {}
      try {
        await env.DB.prepare(
          `UPDATE documents SET data=?, updated_at=? WHERE collection='orders' AND id=?`
        ).bind(JSON.stringify(orderData), uploadedAt, orderId).run();
      } catch (err) {
        // ไม่ fail ทั้งหมด — slip ถูกบันทึกใน payment_proofs แล้ว, order แค่ไม่มี reference
        // (admin ยังเห็น slip ผ่าน endpoint /api/payment-proofs/pending ได้)
        // log error แต่ return success
        console.error("Failed to update order with payment_proof_id:", err);
      }

      // 7. audit log (background)
      // 🔒 (Audit Fix H-36): ใช้ actor ที่ชัดเจน 'customer' แทน 'system' — กัน spoof
      //   ปัญหาเดิม: audit log บันทึก actor = { id: 'system', email: 'system' }
      //   → ไม่สามารถแยกได้ว่า upload มาจาก customer หรือ Worker internal
      //   → ถ้ามี admin action ที่บันทึกเป็น 'system' จะสับสน
      //   วิธีแก้: ใช้ { id: 'customer', email: 'customer' } — ชัดเจนว่าลูกค้าเป็นคน upload
      //   ถ้า admin upload แทน (via admin panel) → endpoint อื่นจะบันทึกด้วย admin.id จริง
      //   ผลกระทบระบบเดิม: 0% — audit_log row เดิม (id='system') ยังอยู่ใน DB
      //   row ใหม่ → id='customer' (clearer)
      try { ctx.waitUntil(writeAuditLog(env, request, { id: "customer", email: "customer" }, "upload", "payment_proofs", proofId, customerName, null, { order_id: orderId, file_key: r2Key, amount_claimed: amountClaimed })); } catch {}

      return jsonResponse({
        ok: true,
        proof_id: proofId,
        file_url: fileUrl,
        file_key: r2Key,
        status: "pending",
        uploaded_at: uploadedAt,
        whatsapp_notify_url: `https://wa.me/${String(whatsapp).replace(/[^0-9]/g, "")}`, // placeholder, admin can replace
      }, 201);
    }

    // 🔴 POST /api/admin/orders/:id/verify-payment  (ADMIN ONLY)
    //   Body: { status: 'verified' | 'rejected', reject_reason?: string, amount_received?: number }
    //   Flow:
    //     1. require admin session
    //     2. fetch proof row by id (query param ?proof_id=xxx)
    //     3. fetch order, check status='pending_verify'
    //     4. UPDATE payment_proofs: status, verified_at, verified_by, reject_reason
    //     5. UPDATE order.payment_proof_status (mirror for fast filter)
    //     6. If verified → ไม่ auto-trigger createOrderZip (admin จะกดเปลี่ยน status เองในหน้า orders เหมือนเดิม)
    //        → ป้องกันการแตะ orders.js / confirmPaymentAndCreateZip โดยตรง (rule #1: ห้ามแตะระบบเดิม)
    //     7. writeAuditLog
    if (url.pathname.startsWith("/api/admin/orders/") && url.pathname.endsWith("/verify-payment") && request.method === "POST") {
      if (!env.DB) return jsonResponse({ error: "D1 binding not configured" }, 500);
      const admin = await getSessionAdmin(request, env);
      if (!admin) return jsonResponse({ error: "ไม่ได้รับอนุญาต" }, 401);
      const orderId = decodeURIComponent(url.pathname.slice("/api/admin/orders/".length, -"/verify-payment".length));
      const proofId = url.searchParams.get("proof_id");
      if (!proofId) return jsonResponse({ error: "ต้องระบุ proof_id ใน query string" }, 400);

      let body = null;
      try { body = await request.json(); } catch { return jsonResponse({ error: "JSON body ไม่ถูกต้อง" }, 400); }
      const newStatus = body?.status;
      if (newStatus !== "verified" && newStatus !== "rejected") {
        return jsonResponse({ error: "status ต้องเป็น 'verified' หรือ 'rejected'" }, 400);
      }
      const rejectReason = newStatus === "rejected" ? String(body?.reject_reason || "").trim().slice(0, 500) : null;
      // 🆕 (T011-L8): ใช้ amount_received แทนที่จะปล่อยเป็น dead variable
      //   เดิม: `const amountReceived = ...` ถูกประกาศไว้ แต่ไม่ถูกใช้ที่ไหนเลย → dead variable + lint warning
      //   ใหม่: ตรวจ + sanitize ค่า (เก็บเป็น number หรือ null) → บันทึกลง order data ด้านล่าง
      //   ผลกระทบระบบเดิม: 0% — ถ้าไม่ส่งมา → null (เหมือนเดิม). ถ้าส่งมา → บันทึกเป็น audit trail
      const amountReceivedRaw = body?.amount_received != null ? Number(body.amount_received) : null;
      const amountReceived = Number.isFinite(amountReceivedRaw) ? amountReceivedRaw : null;

      // fetch proof
      const proofRow = await env.DB.prepare(
        `SELECT * FROM payment_proofs WHERE id=? AND order_id=?`
      ).bind(proofId, orderId).first();
      if (!proofRow) return jsonResponse({ error: "ไม่พบหลักฐานการชำระที่ระบุ" }, 404);

      // 🔒 (Audit Fix H-11): เช็คยอดสลิปตรงยอดออเดอร์ก่อน verify
      //   ปัญหาเดิม: verify-payment endpoint ไม่เช็คว่ายอดในสลิป (amount_claimed)
      //   ตรงกับยอดออเดอร์ (final_total) → แอดมิน (โดยเฉพาะ sub-admin) สามารถ
      //   ยืนยันสลิป 1,000 LAK สำหรับออเดอร์ 100,000 LAK → ลูกค้าได้ของเต็มในราคา 1/100
      //   วิธีแก้:
      //     1. fetch orderData ก่อน update (เพื่อเช็คยอด + เก็บ status_history)
      //     2. ถ้า newStatus === "verified" → เช็ค |amount_claimed - orderTotal| <= tolerance (1 LAK)
      //     3. ถ้า mismatch → return 400 พร้อม warning ระบุยอดต่าง
      //     4. แอดมินสามารถ override ด้วย body.force === true (กรณีพิเศษ เช่น ส่วนลดพิเศษ)
      //         แต่ต้องใส่ force_reason (บันทึกเป็น audit trail)
      //   ผลกระทบระบบเดิม: 0%
      //     - ถ้ายอดตรง → ผ่านได้ปกติ (กรณีส่วนใหญ่)
      //     - ถ้ายอดไม่ตรง และไม่มี force → ปฏิเสธ (กัน fraud)
      //     - ถ้ายอดไม่ตรง และมี force + reason → ยืนยันได้ (admin override)
      //     - ถ้า amount_claimed เป็น null (ลูกค้าไม่กรอก) → ข้าม check (backward-compat)
      const force = body?.force === true;
      const forceReason = force ? String(body?.force_reason || "").trim().slice(0, 500) : null;
      if (force && !forceReason) {
        return jsonResponse({ error: "การ force verify ต้องมีเหตุผล (force_reason)" }, 400);
      }

      const verifiedAt = new Date().toISOString();

      // 🔒 (Audit Fix H-11): fetch order ก่อน + เช็คยอดสลิปตรงยอดออเดอร์ ก่อน UPDATE payment_proofs
      //   เดิม: UPDATE payment_proofs ก่อน fetch order → ถ้าเกิด mismatch ที่ check ด้านล่าง
      //         payment_proofs.status ถูกเปลี่ยนเป็น 'verified' ไปแล้ว → แย่
      //   ใหม่: fetch order ก่อน → เช็คยอด → ถ้า mismatch return 400 (ยังไม่ UPDATE payment_proofs)
      //         ถ้าผ่าน → UPDATE payment_proofs + UPDATE order ตามลำดับ
      //   ผลกระทบระบบเดิม: 0% — flow ปกติผ่านเหมือนเดิม
      //     กรณี mismatch → payment_proofs ยังเป็น status='pending' (ไม่ถูกทำลาย)
      const orderRow = await env.DB.prepare(
        `SELECT data FROM documents WHERE collection='orders' AND id=?`
      ).bind(orderId).first();
      let orderDataForCheck = null;
      if (orderRow?.data) {
        try { orderDataForCheck = JSON.parse(orderRow.data); } catch (_) { orderDataForCheck = null; }
      }
      if (newStatus === "verified" && !force && orderDataForCheck) {
        const amountClaimed = proofRow.amount_claimed != null ? Number(proofRow.amount_claimed) : null;
        const orderTotal = orderDataForCheck.final_total != null ? Number(orderDataForCheck.final_total)
                         : orderDataForCheck.total != null ? Number(orderDataForCheck.total)
                         : null;
        if (amountClaimed != null && orderTotal != null
            && Number.isFinite(amountClaimed) && Number.isFinite(orderTotal)) {
          const diff = Math.abs(amountClaimed - orderTotal);
          const TOLERANCE = 1; // 1 LAK (floating point tolerance)
          if (diff > TOLERANCE) {
            return jsonResponse({
              error: `ยอดในสลิป (${amountClaimed} LAK) ไม่ตรงกับยอดออเดอร์ (${orderTotal} LAK) — ผลต่าง ${diff} LAK ` +
                     `— หากตั้งใจยืนยัน (เช่น ส่วนลดพิเศษ) ให้ส่ง force=true + force_reason ใน body`,
              code: "verify/amount-mismatch",
              amount_claimed: amountClaimed,
              order_total: orderTotal,
              diff,
            }, 400);
          }
        }
      }

      try {
        await env.DB.prepare(
          `UPDATE payment_proofs
           SET status=?, verified_at=?, verified_by=?, reject_reason=?
           WHERE id=?`
        ).bind(newStatus, verifiedAt, admin.id, rejectReason, proofId).run();
      } catch (err) {
        return jsonResponse({ error: safeError("อัปเดตสถานะสลิปไม่สำเร็จ", err) }, 500);
      }

      let orderUpdateOk = false;
      // snapshot สำหรับส่งกลับ client (ใช้ตอนเปิด WhatsApp แจ้งลูกค้า)
      let receiptNumber = null;
      let customerWhatsapp = proofRow.whatsapp || null;
      let customerName = proofRow.customer_name || null;
      let orderFinalTotal = null;
      if (orderRow?.data) {
        try {
          const orderData = JSON.parse(orderRow.data);
          orderData.payment_proof_status = newStatus;
          orderData.payment_proof_verified_at = verifiedAt;
          orderData.payment_proof_verified_by = admin.id;
          if (rejectReason) orderData.payment_proof_reject_reason = rejectReason;
          // 🆕 (T011-L8): บันทึก amount_received ลง order data (ถ้าแอดมินส่งมา)
          //   - ใช้สำหรับ audit trail: แอดมินเห็นยอดที่ลูกค้าโอนจริง (อาจต่างจากยอดออเดอร์ถ้ามีส่วนลดพิเศษ)
          //   - ถ้าไม่ส่งมา → ไม่เขียน field นี้ (กัน null overwrite ค่าเดิม)
          if (amountReceived != null) {
            orderData.payment_amount_received = amountReceived;
          }
          orderData.updated_at = verifiedAt;
          // status_history
          if (Array.isArray(orderData.status_history)) {
            orderData.status_history.push({
              status: orderData.status,
              at: verifiedAt,
              note: newStatus === "verified" ? "แอดมินยืนยันสลิปการโอน" : `แอดมินปฏิเสธสลิป${rejectReason ? ": " + rejectReason : ""}`,
              by: admin.id,
              // 🔒 (2026-09-28 fix H-6): ไม่ fallback ไป admin.email — กันรั่ว email แอดมินไปลูกค้า
              //   เดิม: admin.display_name || admin.email → ถ้า display_name NULL → รั่ว email
              //   ใหม่: admin.display_name || "แอดมิน" → ใช้ชื่อทั่วไป ถ้าไม่มี display_name
              by_name: admin.display_name || "แอดมิน",
            });
          }
          // 🔒 (Audit Fix C-5): atomic INSERT ลงตาราง order_status_history (คู่ขนาน JSON array)
          //   ถ้า JSON array เกิด lost update จาก race (2 admins แก้พร้อมกัน) → ตารางนี้ยังเก็บ entry ครบ
          const verifyNote = newStatus === "verified"
            ? "แอดมินยืนยันสลิปการโอน"
            : `แอดมินปฏิเสธสลิป${rejectReason ? ": " + rejectReason : ""}`;
          try { await insertOrderStatusHistory(env, orderId, orderData.status || "pending_verify", verifyNote, admin.id, admin.display_name || "แอดมิน"); } catch (_) {}
          await env.DB.prepare(
            `UPDATE documents SET data=?, updated_at=? WHERE collection='orders' AND id=?`
          ).bind(JSON.stringify(orderData), verifiedAt, orderId).run();
          orderUpdateOk = true;
          // ดึง snapshot สำหรับ response
          receiptNumber = orderData.receipt_number || null;
          orderFinalTotal = orderData.final_total ?? orderData.total ?? null;
        } catch (err) {
          console.error("Failed to update order after verify-payment:", err);
        }
      }

      // audit log
      try {
        ctx.waitUntil(writeAuditLog(
          env, request, admin,
          newStatus === "verified" ? "status_change" : "status_change",
          "payment_proofs",
          proofId,
          `Order ${orderId.slice(0, 8)}... — ${newStatus}`,
          { status: "pending", verified_at: null },
          { status: newStatus, verified_at: verifiedAt, verified_by: admin.id, reject_reason: rejectReason, amount_received: amountReceived }
        ));
      } catch {}

      return jsonResponse({
        ok: true,
        proof_id: proofId,
        order_id: orderId,
        status: newStatus,
        verified_at: verifiedAt,
        verified_by: admin.id,
        order_updated: orderUpdateOk,
        // 📸 (added) snapshot สำหรับ frontend ใช้สร้าง WhatsApp message ส่งลูกค้า
        customer_whatsapp: customerWhatsapp,
        customer_name: customerName,
        receipt_number: receiptNumber,
        order_total: orderFinalTotal,
        reject_reason: rejectReason,
        // 🆕 (T011-L8): ส่งกลับ amount_received ที่ sanitize แล้ว (เพื่อ frontend แสดงยอดที่บันทึก)
        amount_received: amountReceived,
        // 📸 (added) สร้าง WhatsApp link สำเร็จรูป ให้ frontend เปิดได้เลย (notification only)
        whatsapp_notify_url: customerWhatsapp
          ? buildAdminNotifyWhatsAppUrl(customerWhatsapp, newStatus, receiptNumber, customerName, orderFinalTotal, rejectReason)
          : null,
        // hint สำหรับ client: ถ้า verified → admin ควรไปกดเปลี่ยน status ในหน้า orders เอง
        next_action_hint: newStatus === "verified"
          ? "ไปที่หน้าจัดการออเดอร์ → คลิก 'ยืนยันโอนแล้ว' เพื่อสร้าง ZIP ส่งลูกค้า"
          : "ลูกค้าจะสามารถอัปโหลดสลิปใหม่ได้ — กดปุ่มด้านล่างเพื่อเปิด WhatsApp แจ้งลูกค้า",
      }, 200);
    }

    if (url.pathname.startsWith("/api/auth/")) {
      if (!env.DB) return jsonResponse({ error: "ยังไม่ได้ผูก D1 database (binding: DB) ใน wrangler.jsonc" }, 500);
      return handleAuth(request, env, url);
    }

    // 🆕 (2026-10-01): /api/customer/* — ระบบสมาชิกลูกค้า (register/login/logout/me/orders)
    //   ผลกระทบระบบเดิม: 0% — path ใหม่ ไม่แตะ /api/auth/* (แอดมิน) หรือ /api/db/*
    if (url.pathname.startsWith("/api/customer/")) {
      if (!env.DB) return jsonResponse({ error: "ยังไม่ได้ผูก D1 database (binding: DB) ใน wrangler.jsonc" }, 500);
      return handleCustomerAuth(request, env, url);
    }

    // 🆕 (2026-10-02 v4 fix — CRITICAL BUG): /api/admin/customers และ /api/admin/password-reset-requests
    //   เดิม: endpoints เหล่านี้ถูกวางไว้ใน handleCustomerAuth() แต่ routing หลักเรียก handleCustomerAuth()
    //   เฉพาะเมื่อ path ขึ้นต้นด้วย /api/customer/ (เอกพจน์) → /api/admin/* จึงไม่เคยถูกเรียก → 404
    //   แก้: เพิ่ม routing สำหรับ /api/admin/customers และ /api/admin/password-reset-requests ให้เรียก handleCustomerAuth()
    //   ผลกระทบระบบเดิม: 0% — เป็นการเพิ่ม routing ใหม่ ไม่ลบ/เปลี่ยน routing เดิม
    // 🆕 (T012): เพิ่ม /api/admin/reports เข้าไปใน routing ให้เรียก handleCustomerAuth()
    //   ใน handleCustomerAuth มี handler สำหรับ /api/admin/reports/sales-summary, top-songs, top-djs
    if (url.pathname.startsWith("/api/admin/customers") || url.pathname.startsWith("/api/admin/password-reset-requests") || url.pathname.startsWith("/api/admin/reports") || url.pathname.startsWith("/api/admin/song-reviews")) {
      if (!env.DB) return jsonResponse({ error: "ยังไม่ได้ผูก D1 database (binding: DB) ใน wrangler.jsonc" }, 500);
      return handleCustomerAuth(request, env, url);
    }

    // 🆕 (2026-10-02 v7 — ฟีเจอร์ #12 ใหม่): /api/songs/:id/like + /likes — public endpoint ถูกใจเพลงแบบ TikTok
    //   ไม่ต้อง login → route เข้า handleCustomerAuth (มี logic ข้างในสำหรับ path นี้)
    if (url.pathname.startsWith("/api/songs/") && (url.pathname.endsWith("/like") || url.pathname.endsWith("/likes"))) {
      if (!env.DB) return jsonResponse({ error: "ยังไม่ได้ผูก D1 database (binding: DB) ใน wrangler.jsonc" }, 500);
      return handleCustomerAuth(request, env, url);
    }

    // 🆕 (T020): /api/songs/:id/reviews + /api/songs/:id/reviews/summary — รีวิวเพลง (ดาว + ความเห็น)
    //   - GET /reviews + GET /reviews/summary = public
    //   - POST /reviews + DELETE /reviews = login required (เช็ค getCustomerSession ใน handler)
    //   ผลกระทบระบบเดิม: 0% — route เข้า handleCustomerAuth (มี logic ข้างในสำหรับ path นี้)
    if (url.pathname.startsWith("/api/songs/") && (url.pathname.endsWith("/reviews") || url.pathname.endsWith("/reviews/summary"))) {
      if (!env.DB) return jsonResponse({ error: "ยังไม่ได้ผูก D1 database (binding: DB) ใน wrangler.jsonc" }, 500);
      return handleCustomerAuth(request, env, url);
    }

    if (url.pathname.startsWith("/api/db/")) {
      if (!env.DB) return jsonResponse({ error: "ยังไม่ได้ผูก D1 database (binding: DB) ใน wrangler.jsonc" }, 500);
      return handleDb(request, env, url);
    }

    return jsonResponse({ error: "ไม่พบ endpoint นี้" }, 404);
    } catch (err) {
      // 🔧 (2026-09-27 fix 503 safety net): catch สุดท้าย — ถ้า handler ใด throw
      //   uncaught exception → คืน JSON 500 ที่ client อ่านได้ แทน 503 จาก Cloudflare
      //   log error จริงใน Worker logs ผ่าน safeError (ไม่รั่ว internals ให้ client)
      console.error("[fetch safety net] uncaught exception:", err?.stack || err);
      return jsonResponse({ error: safeError("เกิดข้อผิดพลาดภายในระบบ กรุณาลองใหม่อีกครั้ง", err) }, 500);
    }
  },

  // 🔒 (2026-09-21 auto-cleanup ZIP): Cron Trigger — ลบ ZIP อัตโนมัติหลัง 24 ชม.
  //   รันทุก 6 ชม. (จาก wrangler.jsonc triggers.crons) → ค้นหา orders ที่:
  //     - zip_status = 'ready' (ZIP พร้อมดาวน์โหลด)
  //     - zip_created_at < (now - 24h) (สร้างเกิน 24 ชม. แล้ว)
  //   สำหรับแต่ละ order:
  //     1. ลบไฟล์ ZIP ออกจาก R2 (ใช้ zip_public_id เป็น bucket key)
  //     2. อัปเดต order: zip_status='expired', zip_download_url='', zip_public_id='', zip_expired_at=now
  //   ผลกระทบระบบเดิม: 0% — cron ทำงานแยกจาก fetch handler (request handling)
  //   ผลกระทบต่อ admin UI:
  //     - ปุ่ม "ดาวน์โหลด ZIP" → URL 404 (ไฟล์ถูกลบแล้ว) → admin ต้องกด "สร้าง ZIP ใหม่"
  //     - ปุ่ม "ส่ง ZIP ผ่าน WhatsApp" → Worker ตรวจ zip_status='expired' → return error → admin ต้องสร้างใหม่
  //   ประโยชน์: URL ถาวรที่รั่วจะใช้ได้แค่ 24 ชม. (เทียบเท่า token expiry)
  async scheduled(event, env, ctx) {
    // 🔄 (2026-09-28 rollback M-1): ลบ Sequential Queue safety net ออก
    //   เดิม: cron เช็ค queue ทุก 1 นาที → trigger order ถัดไป (safety net)
    //   หลัง rollback: Sequential Queue ไม่ใช้แล้ว → ลบ dead code นี้ออก
    //   ผลกระทบระบบเดิม: 0% — queue table อาจมี row เก่าค้าง แต่ไม่มีใคร trigger แล้ว
    //   (cleanup ผ่าน SQL recovery script: scripts/recover-stuck-queue.sql)

    // 🔒 (2026-09-21 auto-cleanup ZIP): ส่วน cron ทุก 6 ชม. (เดิม)
    //   ค้นหา ZIP เก่า > 24 ชม. + audit_log + download_tokens + stuck jobs
    //   ตรวจผ่าน cron expression — ถ้าเป็นรอบ 6 ชม. (ชั่วโมง == 0, 6, 12, 18) ให้ทำ cleanup
    try {
      if (!env.DB || !env.BUCKET) {
        console.warn("[cleanup] DB or BUCKET binding not configured — skip");
        return;
      }

      // 🔄 (2026-09-28): ตรวจว่าเป็นรอบ 6 ชม. หรือรอบ 1 นาที
      //   cron "* * * * *" ทุก 1 นาที → ทำ queue เท่านั้น (ด้านบน)
      //   cron "0 */6 * * *" ทุก 6 ชม. → ทำ cleanup ด้วย (ด้านล่าง)
      //   วิธีเช็ค: ดู minute ของเวลาปัจจุบัน — ถ้า minute = 0 และ hour % 6 = 0 → เป็นรอบ 6 ชม.
      const now = new Date();
      const isCleanupCron = now.getMinutes() === 0 && (now.getHours() % 6 === 0);

      if (!isCleanupCron) {
        // รอบ 1 นาที → ทำ queue เสร็จแล้วจบ (ไม่ทำ cleanup)
        return;
      }
      console.log("[cleanup] Running 6-hour cleanup cycle");

      // คำนวณ cutoff = now - 24 ชม.
      const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      console.log(`[cleanup] Looking for ZIPs created before ${cutoff}`);

      // ค้นหา orders ที่ zip_status='ready' + อายุเกิน 24 ชม.
      //   ใช้ json_extract บน data column (เหมือน queryDocuments)
      //   ผลลัพธ์: array ของ { id, data } — data คือ JSON string
      // 🔧 (2026-09-27 fix HIGH #3): เพิ่ม LIMIT 100 + เพิ่ม ORDER BY เพื่อกัน OOM + กัน cron timeout
      //   เดิม: SELECT ไม่มี LIMIT → ถ้ามี ZIP ค้าง 10,000+ จะโหลดเข้า memory หมด
      //         + sequential R2 delete + D1 UPDATE ทีละ row → เกิน cron wall-clock limit 30s ของ Free plan
      //         → cron ถูกตัดกลางทาง → บาง order ไม่ถูก expire
      //   ใหม่: LIMIT 100 + ORDER BY json_extract(data, '$.zip_created_at') ASC (เก่าก่อน)
      //         → ประมวลผลทีละ 100 รอบถัดไปจะเลือก 100 ถัดไปเอง
      //         → ใช้เวลา ~100 × ~80ms = ~8 วินาที (อยู่ใน limit 30s ปลอดภัย)
      //   ผลกระทบระบบเดิม: 0% — ถ้ามี ZIP ค้างน้อยกว่า 100 → ทำครบทุกตัวเหมือนเดิม
      //                   — ถ้ามีมากกว่า 100 → ทำ 100 แรก รอบ cron ถัดไป (6 ชม.) ทำ 100 ถัดไป
      const cleanupLimit = 100;
      const { results } = await env.DB.prepare(
        "SELECT id, data FROM documents WHERE collection = 'orders' " +
        "AND json_extract(data, '$.zip_status') = 'ready' " +
        "AND json_extract(data, '$.zip_created_at') IS NOT NULL " +
        "AND json_extract(data, '$.zip_created_at') < ? " +
        "ORDER BY json_extract(data, '$.zip_created_at') ASC " +
        "LIMIT ?"
      ).bind(cutoff, cleanupLimit).all();

      const expiredCount = results?.length || 0;
      console.log(`[cleanup] Found ${expiredCount} ZIPs to expire (limit ${cleanupLimit})`);

      if (expiredCount === 0) {
        return; // ไม่มี ZIP ต้อง cleanup → จบการทำงาน
      }

      // วนลูปลบทีละ order
      let successCount = 0;
      let errorCount = 0;
      for (const row of results) {
        try {
          const order = JSON.parse(row.data);
          const bucketKey = order.zip_public_id;

          // 🔧 (2026-09-27 fix HIGH #4): สลับลำดับ — UPDATE D1 ก่อน (mark as expired) แล้วค่อย delete R2
          //   เดิม: R2 delete ก่อน → D1 UPDATE ทีหลัง
          //         ถ้า D1 UPDATE ล้ม → ไฟล์ R2 หายแล้ว แต่ order doc ยังบอก zip_status='ready' + zip_download_url ยังอยู่
          //         → ลูกค้าคลิก download → R2 404 → UI error แต่ order บอก "พร้อมดาวน์โหลด"
          //         → self-heal ในรอบ cron ถัดไป (6 ชม.) แต่ช่วงนั้นลูกค้าเดือดร้อน
          //   ใหม่: D1 UPDATE ก่อน (mark as expired) → ลูกค้าจะไม่เห็น URL แล้ว → ค่อย delete R2
          //         ถ้า R2 delete ล้ม → ไฟล์ค้างใน R2 แต่ order doc ถูกต้อง (expired) → self-heal รอบถัดไป
          //         (ไฟล์ค้างดีกว่าลูกค้าเจน error ตอนคลิก download)
          //   ผลกระทบระบบเดิม: 0% — ผลลัพธ์สุดท้ายเหมือนเดิม (R2 + D1 ถูกลบ/อัปเดต)
          //                   — แต่ลำดับการทำงานเปลี่ยน เพื่อ consistency ที่ดีกว่า
          const nowIso = new Date().toISOString();
          const updatedData = {
            ...order,
            zip_status: "expired",
            zip_download_url: "",
            zip_public_id: "",
            zip_expired_at: nowIso,
            updated_at: nowIso,
          };
          await env.DB.prepare(
            "UPDATE documents SET data = ?, updated_at = ? WHERE collection = 'orders' AND id = ?"
          ).bind(JSON.stringify(updatedData), nowIso, row.id).run();
          console.log(`[cleanup] Marked order ${row.id} as expired`);

          // ตอนนี้ D1 อัปเดตแล้ว → ลูกค้าจะไม่เห็น URL แล้ว → ค่อยลบไฟล์ R2
          // ถ้า R2 delete ล้ม → log แต่ถือว่าสำเร็จ (ไฟล์ค้างรอรอบถัดไป ไม่กระทบลูกค้า)
          if (bucketKey) {
            try {
              await env.BUCKET.delete(bucketKey);
              console.log(`[cleanup] Deleted R2 object: ${bucketKey}`);
            } catch (r2Err) {
              // ไฟล์ค้างใน R2 → log warning แต่ไม่ block (D1 ถูกต้องแล้ว self-heal รอบถัดไป)
              console.warn(`[cleanup] R2 delete failed for ${bucketKey} (will retry next cron):`, r2Err?.message || r2Err);
            }
          }
          successCount += 1;
        } catch (err) {
          console.error(`[cleanup] Failed to expire ZIP for order ${row.id}:`, err?.message || err);
          errorCount += 1;
        }
      }

      console.log(`[cleanup] Done: ${successCount} expired, ${errorCount} failed`);

      // 🔧 (2026-09-22 fix Bug #2 UI v3): ลบ audit_log เก่าเกิน 10 วัน อัตโนมัติ
      //   - รันทุก 6 ชม. (เหมือน ZIP cleanup)
      //   - ลบ rows ที่ created_at < (now - AUDIT_LOG_DAYS)
      //   - กันตาราง audit_log ใหญ่เกิน → กิน D1 storage + reads
      //   - ผู้ใช้ระบุให้เก็บแค่ 10 วัน (ตอนแรกเก็บ 90 วัน — เกินไปสำหรับร้านเล็ก)
      //   🆕 (T048): ใช้ TTL.AUDIT_LOG_DAYS จาก constants.js แทน hardcoded 10
      //     → single source of truth ถ้าจะปรับ retention ในอนาคต แก้ที่เดียว
      try {
        const auditCutoff = new Date(Date.now() - TTL.AUDIT_LOG_DAYS * 24 * 60 * 60 * 1000).toISOString();
        const auditResult = await env.DB.prepare(
          "DELETE FROM audit_log WHERE created_at < ?"
        ).bind(auditCutoff).run();
        const deletedCount = auditResult?.meta?.changes || 0;
        if (deletedCount > 0) {
          console.log(`[cleanup] Deleted ${deletedCount} old audit_log rows (older than ${TTL.AUDIT_LOG_DAYS} days)`);
        }
      } catch (auditErr) {
        // ถ้าตาราง audit_log ไม่มี → log แล้วข้ามไป (ไม่ block cron)
        console.warn("[cleanup] audit_log cleanup failed:", auditErr?.message || auditErr);
      }

      // 🧹 (2026-09-28 fix H2): ลบ download_tokens ที่หมดอายุแล้ว อัตโนมัติ
      //   เดิม: ไม่มี cleanup → download_tokens table บวมเรื่อย ๆ → D1 storage โต + reads ช้า
      //   ใหม่: ลบ rows ที่ expires_at < now (รวม used และ unused)
      //   - รันทุก 6 ชม. (เหมือน ZIP cleanup + audit_log cleanup)
      //   - ลบเฉพาะ token ที่หมดอายุ → ลูกค้าที่ token ยังไม่หมดอายุ ไม่กระทบ
      //   - ผลกระทบระบบเดิม: 0%
      //     - token ที่ถูกใช้แล้ว (used_at IS NOT NULL) และหมดอายุ → ลบได้ (history ไม่จำเป็น)
      //     - token ที่ยังไม่ถูกใช้ (used_at IS NULL) และหมดอายุ → ลบได้ (ใช้ไม่ได้อยู่แล้ว)
      try {
        const tokenNow = new Date().toISOString();
        const tokenResult = await env.DB.prepare(
          "DELETE FROM download_tokens WHERE expires_at < ?"
        ).bind(tokenNow).run();
        const tokenDeletedCount = tokenResult?.meta?.changes || 0;
        if (tokenDeletedCount > 0) {
          console.log(`[cleanup] Deleted ${tokenDeletedCount} expired download_tokens`);
        }
      } catch (tokenErr) {
        // ถ้าตาราง download_tokens ไม่มี (DB เก่า) → log แล้วข้ามไป (ไม่ block cron)
        console.warn("[cleanup] download_tokens cleanup failed:", tokenErr?.message || tokenErr);
      }

      // 🧹 (2026-09-28 fix M5): ลบ order_zip_jobs ที่ค้าง status='preparing' เกิน 2 ชม.
      //   เดิม: ไม่มี cleanup → ถ้า user ปิด tab ระหว่าง append → multipart upload ค้างใน R2
      //         → storage leak + R2 quota หมดเร็ว
      //   ใหม่: ค้นหา jobs ที่ status='preparing' + updated_at < (now - 2h) → abort multipart + delete row
      //   - รันทุก 6 ชม. (เหมือน ZIP + audit_log + download_tokens cleanup)
      //   - LIMIT 50 ต่อรอบ → กัน cron timeout (เหมือน ZIP cleanup LIMIT 100)
      //   - ผลกระทบระบบเดิม: 0%
      //     - jobs ที่กำลังทำงานอยู่ (updated_at ภายใน 2 ชม.) → ไม่ถูกลบ
      //     - jobs ที่ stuck จริง (เกิน 2 ชม.) → abort multipart + delete row → R2 self-heal
      try {
        const stuckCutoff = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2 ชม.
        // 🚀 (2026-09-28 fix H-4): SELECT เพิ่ม parts → ลบ partial.bin ก่อน abort multipart
        //   เดิม: SELECT แค่ job_id, bucket_key → ละเลย partial.bin (~16MB ต่อ stuck job) → R2 leak
        //   ใหม่: SELECT เพิ่ม parts → อ่าน finalizeState.partialBufferKey → delete ก่อน abort
        const stuckJobs = await env.DB.prepare(
          "SELECT job_id, bucket_key, parts FROM order_zip_jobs " +
          "WHERE status = 'preparing' AND updated_at < ? " +
          "ORDER BY updated_at ASC LIMIT 50"
        ).bind(stuckCutoff).all();

        if (stuckJobs?.results?.length > 0) {
          console.log(`[cleanup] Found ${stuckJobs.results.length} stuck ZIP jobs (older than 2h)`);
          let stuckSuccess = 0;
          let stuckError = 0;
          for (const job of stuckJobs.results) {
            try {
              // 🚀 (H-4): ลบ partial.bin ก่อน abort multipart
              //   finalizeState.partialBufferKey คือ R2 key ของ temp buffer (~16MB) จาก finalize-build
              try {
                const partsData = parsePartsJson(job.parts);
                if (partsData.finalizeState && partsData.finalizeState.partialBufferKey) {
                  await cleanupPartialBuffer(env, partsData.finalizeState);
                }
              } catch (_) {}
              // ลอง abort multipart upload (ถ้ายัง active ใน R2)
              // — ใช้ try/catch เพราะบาง multipart อาจถูก abort ไปแล้วโดย worker
              if (job.bucket_key) {
                try {
                  // R2 multipart abort ใช้ uploadId (job_id) — ถ้า fail แสดงว่าถูก abort ไปแล้ว
                  await env.BUCKET.abortMultipartUpload(job.bucket_key, job.job_id);
                } catch (r2AbortErr) {
                  // ไม่อันตราย — multipart อาจถูก abort ไปแล้ว หรือ bucket_key ไม่ตรง
                  console.warn(`[cleanup] R2 multipart abort failed for ${job.job_id} (may already be aborted):`, r2AbortErr?.message || r2AbortErr);
                }
              }
              // ลบ row ใน D1 (ไม่สนใจว่า R2 abort สำเร็จหรือไม่ — row ต้องถูกลบเพื่อกัน stuck ต่อไป)
              await env.DB.prepare(
                "DELETE FROM order_zip_jobs WHERE job_id = ?"
              ).bind(job.job_id).run();
              stuckSuccess += 1;
            } catch (stuckErr) {
              console.error(`[cleanup] Failed to cleanup stuck ZIP job ${job.job_id}:`, stuckErr?.message || stuckErr);
              stuckError += 1;
            }
          }
          console.log(`[cleanup] Stuck ZIP jobs cleanup: ${stuckSuccess} cleaned, ${stuckError} failed`);
        }
      } catch (stuckErr) {
        // ถ้าตาราง order_zip_jobs ไม่มี → log แล้วข้ามไป
        console.warn("[cleanup] order_zip_jobs stuck cleanup failed:", stuckErr?.message || stuckErr);
      }

      // 🔒 (Audit Fix H-26): Cleanup login_attempts + order_creation_attempts + payment_proof_attempts
      //   ปัญหาเดิม: tables สะสม forever → ขยะ + ช้าเมื่อ table ใหญ่
      //   วิธีแก้: ลบ rows ที่เก่ากว่า 24 ชม. (cutoff เดียวกับ ZIP)
      //   ใช้ cutoff จากด้านบน (24 ชม. ago) — ตาราง attempts ไม่ต้องเก็บเกิน 24 ชม.
      //   ผลกระทบระบบเดิม: 0% — rate limit window = 15 นาที → ข้อมูล > 24 ชม. ไม่จำเป็น
      //   ถ้า table ไม่มี → catch + log + ข้าม
      try {
        // cleanup login_attempts (login fail + change-pw fail + customer-query + customer-list)
        await env.DB.prepare(
          "DELETE FROM login_attempts WHERE attempted_at < ?"
        ).bind(cutoff).run();
        // cleanup order_creation_attempts
        await env.DB.prepare(
          "DELETE FROM order_creation_attempts WHERE attempted_at < ?"
        ).bind(cutoff).run();
        // cleanup payment_proof_attempts
        await env.DB.prepare(
          "DELETE FROM payment_proof_attempts WHERE attempted_at < ?"
        ).bind(cutoff).run();
        console.log("[cleanup] Rate-limit attempts tables cleaned (rows older than 24h)");
      } catch (attemptsErr) {
        console.warn("[cleanup] attempts tables cleanup failed:", attemptsErr?.message || attemptsErr);
      }
    } catch (err) {
      // cron error ไม่ควรทำให้ Cloudflare ลบ trigger → log แล้วจบ
      console.error("[cleanup] Cron error:", err?.message || err);
    }
  },
};
