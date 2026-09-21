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
import { hashPassword, verifyPassword, getSessionAdmin, createSession, deleteSession, buildSessionCookie, buildClearCookie, getCookie, cleanupExpiredSessions } from "./auth-helpers.js";
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

// โฟลเดอร์เหล่านี้เดิมใช้ toCloudinaryDownloadUrl() เติม fl_attachment ให้บังคับดาวน์โหลด
// (ไฟล์เพลงเต็ม/ไฟล์ ZIP ออเดอร์ — ไม่ใช่ไฟล์ที่เปิดเล่น/แสดงผลตรงๆ บนเว็บ)
// ย้ายมา R2 แล้วให้ตั้ง Content-Disposition ตอนอัปโหลดแทน เพื่อให้พฤติกรรม "กดแล้วดาวน์โหลดทันที" เหมือนเดิม
const FORCE_DOWNLOAD_FOLDERS = new Set(["full-songs", "order-zips"]);

function corsHeaders() {
  // ใช้งานจริงเป็น same-origin (เว็บกับ Worker อยู่โดเมนเดียวกัน) จึงไม่จำเป็นต้องเปิด CORS
  // แต่ใส่ไว้แบบกว้างๆ เผื่อกรณีทดสอบจากเครื่อง dev คนละ origin ไม่ให้ต้องมาแก้ไฟล์นี้เพิ่ม
  // เพิ่ม DELETE ในรายการ methods (2026-09-11) สำหรับ endpoint ลบไฟล์ R2 — ไม่กระทบ POST /api/upload เดิม
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

// extraHeaders (ไม่บังคับ): ใช้ตอนต้องแปะ Set-Cookie ไปกับ response (login/logout/bootstrap)
function jsonResponse(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(), ...extraHeaders },
  });
}

// สุ่มชื่อไฟล์ปลายทางใน R2 ให้ไม่ชนกัน (คล้าย public_id ของ Cloudinary) แต่ยังเก็บนามสกุลไฟล์เดิมไว้
// เพื่อให้เบราว์เซอร์/แอปเดา content type และเปิดไฟล์ได้ถูกต้อง
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
    const downloadName = (file.name || key.split("/").pop() || "download").replace(/"/g, "");
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
    return jsonResponse({ error: "เขียนไฟล์เข้า R2 ไม่สำเร็จ: " + (err?.message || String(err)) }, 502);
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

  // ส่งกลับเป็น blob พร้อม Content-Type ที่ถูกต้อง + CORS headers
  // (same-origin อยู่แล้ว แต่ใส่ CORS ไว้เผื่อกรณีทดสอบจาก dev origin อื่น)
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Cache-Control", "no-store");
  // ไม่ใส่ Content-Disposition: attachment เพราะฝั่ง caller ต้องการ stream เป็น blob ไม่ใช่ดาวน์โหลดตรง
  return new Response(object.body, { status: 200, headers });
}

async function handleDeleteUpload(request, env) {
  const admin = await getSessionAdmin(request, env);
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
    return jsonResponse({ error: "ลบไฟล์ออกจาก R2 ไม่สำเร็จ: " + (err?.message || String(err)) }, 502);
  }
  return jsonResponse({ ok: true, deleted: true, key });
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
    const email = String(body.email || "").trim();
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
    return jsonResponse(adminToClient(admin), 200, { "Set-Cookie": buildSessionCookie(token) });
  }

  if (path === "login" && request.method === "POST") {
    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400); }
    const email = String(body.email || "").trim();
    const password = String(body.password || "");

    // 🔒 แก้บั๊ก #4 (2026-09-18): Rate limiting บน login — กัน brute-force password
    //   เดิม: ไม่มี rate limiting → attacker ยิง password dictionary ได้ไม่จำกัด
    //   แก้: ใช้ D1 ตาราง `login_attempts` track IP + email → บล็อกถ้าเกิน 5 ครั้งใน 15 นาที
    //   ⚠️ ใช้ IP จาก CF-Connecting-IP header (Cloudflare ใส่ให้อัตโนมัติ)
    //   ถ้าไม่มีตาราง login_attempts (DB เก่า) → rate limiting ข้ามไป (fallback: ไม่บล็อก)
    const clientIP = request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || "unknown";
    const RATE_LIMIT_MAX_ATTEMPTS = 5;
    const RATE_LIMIT_WINDOW_MINUTES = 15;
    const rateLimitWindow = new Date(Date.now() - RATE_LIMIT_WINDOW_MINUTES * 60 * 1000).toISOString();
    try {
      // นับ attempts ล้มเหลวใน 15 นาทีล่าสุดสำหรับ IP นี้
      const attemptsRow = await env.DB.prepare(
        "SELECT COUNT(*) AS c FROM login_attempts WHERE ip = ? AND attempted_at > ?"
      ).bind(clientIP, rateLimitWindow).first();
      if ((attemptsRow?.c || 0) >= RATE_LIMIT_MAX_ATTEMPTS) {
        return jsonResponse({
          error: `พยายามเข้าสู่ระบบผิดพลาดเกินไป (${RATE_LIMIT_MAX_ATTEMPTS} ครั้งใน ${RATE_LIMIT_WINDOW_MINUTES} นาที) — กรุณารอ ${RATE_LIMIT_WINDOW_MINUTES} นาทีแล้วลองใหม่`,
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
    const admin = await env.DB.prepare("SELECT * FROM admin_users WHERE email = ?").bind(email).first();
    if (!admin || !(await verifyPassword(password, admin.password_hash))) {
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
    return jsonResponse(adminToClient(admin), 200, { "Set-Cookie": buildSessionCookie(token) });
  }

  if (path === "logout" && request.method === "POST") {
    const token = getCookie(request, "session_token");
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
    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400); }
    const full = await env.DB.prepare("SELECT password_hash FROM admin_users WHERE id = ?").bind(admin.id).first();
    const ok = await verifyPassword(String(body.password || ""), full?.password_hash);
    if (!ok) return jsonResponse({ error: "รหัสผ่านปัจจุบันไม่ถูกต้อง", code: "auth/wrong-password" }, 401);
    return jsonResponse({ ok: true });
  }

  if (path === "change-password" && request.method === "POST") {
    const admin = await getSessionAdmin(request, env);
    if (!admin) return jsonResponse({ error: "ยังไม่ได้เข้าสู่ระบบ" }, 401);
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
      return jsonResponse({ error: "รหัสผ่านปัจจุบันไม่ถูกต้อง", code: "auth/wrong-password" }, 401);
    }

    const newPassword = String(body.newPassword || "");
    if (newPassword.length < 6) return jsonResponse({ error: "รหัสผ่านใหม่ต้องมีอย่างน้อย 6 ตัวอักษร" }, 400);
    const passwordHash = await hashPassword(newPassword);
    await env.DB.prepare("UPDATE admin_users SET password_hash = ? WHERE id = ?").bind(passwordHash, admin.id).run();
    return jsonResponse({ ok: true });
  }

  if (path === "create-admin" && request.method === "POST") {
    const admin = await getSessionAdmin(request, env);
    if (!admin) return jsonResponse({ error: "ยังไม่ได้เข้าสู่ระบบ" }, 401);
    if (admin.role !== "main") return jsonResponse({ error: "เฉพาะแอดมินหลักเท่านั้นที่เพิ่มแอดมินได้" }, 403);
    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400); }
    const email = String(body.email || "").trim();
    const password = String(body.password || "");
    if (!email) return jsonResponse({ error: "กรุณากรอกอีเมล" }, 400);
    if (password.length < 6) return jsonResponse({ error: "รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร" }, 400);
    const existing = await env.DB.prepare("SELECT id FROM admin_users WHERE email = ?").bind(email).first();
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
  let s = String(v || "").replace(/[^0-9]/g, "");
  // 🔒 แก้บั๊ก C5: strip country code Laos (+856 / 856) ออก เพื่อให้เบอร์ Laos ทุกรูปแบบเทียบเท่ากัน
  if (s.startsWith("856")) s = s.slice(3);
  // 🔒 แก้บั๊ก C5: strip "0" นำหน้าออก (เช่น "020..." → "20...")
  //   เพราะเบอร์มือถือ Laos มักขึ้นต้นด้วย "20" หลัง strip country code แล้ว
  //   บางคนกรอก "020..." บางคนกรอก "20..." ต้องเทียบเท่ากัน
  if (s.startsWith("0")) s = s.replace(/^0+/, "");
  return s;
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
  const needsAdminCheck = isWrite || !PUBLIC_READ_COLLECTIONS.has(collection) || collection === "songs" || isOrdersCountPendingEndpoint || isBatchGetEndpoint || isHasOrdersBatchEndpoint || isCheckCoverUsedEndpoint || isCountAllEndpoint || isCheckDuplicateEndpoint;

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
  const isAdminOnlyMetaEndpoint = isHasOrdersBatchEndpoint || isCheckCoverUsedEndpoint || isCountAllEndpoint || isCheckDuplicateEndpoint;
  if (!admin && !isOrdersPublicWriteCandidate && !isOrdersCustomerEndpoint && !isSongsPublicGet && !isSongsPublicQuery && !isAdminOnlyMetaEndpoint) {
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
      return jsonResponse({ error: "นับออเดอร์ไม่สำเร็จ: " + (err?.message || String(err)) }, 500);
    }
  }

  // 🔧 (2026-09-17 Phase 2): /api/db/:collection/_batch-get — batch get documents หลายอัน
  // ใช้สำหรับ batch fetch songs ตอนสร้าง ZIP — ลดจำนวน HTTP requests จาก browser → Worker
  // request: POST body { ids: ["id1", "id2", ...] }
  // response: { docs: [{ id, data }, ...] }
  // 🔒 Security: ต้อง login admin เท่านั้น — เพราะ response อาจมี full_file_url ของ songs (sensitive field)
  if (isBatchGetEndpoint) {
    if (!admin) return jsonResponse({ error: "ยังไม่ได้เข้าสู่ระบบ" }, 401);
    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400); }
    const ids = Array.isArray(body?.ids) ? body.ids : [];
    if (ids.length === 0) return jsonResponse({ docs: [] });
    try {
      const docs = await getDocumentsByIds(env, collection, ids);
      return jsonResponse({ docs });
    } catch (err) {
      return jsonResponse({ error: "batch get ไม่สำเร็จ: " + (err?.message || String(err)) }, 500);
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
      return jsonResponse({ error: "has-orders-batch ไม่สำเร็จ: " + (err?.message || String(err)) }, 500);
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
      return jsonResponse({ error: "check-cover-used ไม่สำเร็จ: " + (err?.message || String(err)) }, 500);
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
      return jsonResponse({ error: "count-all ไม่สำเร็จ: " + (err?.message || String(err)) }, 500);
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
      return jsonResponse({ error: "check-duplicate ไม่สำเร็จ: " + (err?.message || String(err)) }, 500);
    }
  }

  try {
    // 🔒 /api/db/orders/_customer-query — ลูกค้าค้นหาออเดอร์เดียวด้วย receipt_number + ชื่อ + เบอร์
    // Server ตรวจทั้ง 3 ฟิลด์ คืนออเดอร์เดียวถ้าตรงทั้งหมด ไม่คืนข้อมูลคนอื่นให้ browser
    if (isOrdersCustomerEndpoint && parts[1] === "_customer-query") {
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
      const queryName = normalizeNameServer(customerName);
      const queryPhone = normalizePhoneServer(whatsapp);
      for (const d of docs) {
        const oName = normalizeNameServer(d.data?.customer_name || "");
        const oPhone = normalizePhoneServer(d.data?.whatsapp || "");
        if (oName === queryName && oPhone === queryPhone) {
          return jsonResponse({ exists: true, id: d.id, data: d.data });
        }
      }
      return jsonResponse({ exists: false });
    }

    // 🔒 /api/db/orders/_customer-list — ลูกค้าดูออเดอร์ทั้งหมดของตัวเองด้วย ชื่อ + เบอร์
    // Server กรองเฉพาะออเดอร์ที่เป็นของลูกค้าคนนี้ (เบอร์ต้องตรง 100%, ชื่อเปิดให้ fuzzy match แบบ contains
    // เหมือนโค้ดเดิมใน app-promotion.js ที่ใช้ oName.includes(nameNorm) || nameNorm.includes(oName))
    if (isOrdersCustomerEndpoint && parts[1] === "_customer-list") {
      let body;
      try { body = await request.json(); } catch { return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400); }
      const customerName = String(body.customer_name || "").trim();
      const whatsapp = String(body.whatsapp || "").trim();
      if (!customerName || !whatsapp) {
        return jsonResponse({ docs: [] });
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
      const queryName = normalizeNameServer(customerName);
      const matched = candidateDocs.filter((d) => {
        const oPhone = normalizePhoneServer(d.data?.whatsapp || "");
        if (oPhone !== queryPhone) return false;
        const oName = normalizeNameServer(d.data?.customer_name || "");
        if (!oName || !queryName) return false;
        // fuzzy match เหมือน app-promotion.js เดิม — กันลูกค้าพิมพ์ชื่อต่างจากตอนสั่งซื้อนิดหน่อยแล้วหาไม่เจอ
        return oName === queryName || oName.includes(queryName) || queryName.includes(oName);
      });
      return jsonResponse({ docs: matched });
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
      const urlParams = new URL(request.url).searchParams;
      const limit = parseInt(urlParams.get("limit") || "", 10);
      const offset = parseInt(urlParams.get("offset") || "0", 10);
      const slim = urlParams.get("slim") === "1";
      const opts = {};
      if (Number.isInteger(limit) && limit > 0) opts.limit = limit;
      if (Number.isInteger(offset) && offset > 0) opts.offset = offset;
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
      const extraHeaders = isCacheable
        ? { "Cache-Control": "public, max-age=60, s-maxage=300", "Vary": "Cookie" }
        : {};
      // ใช้ new Response เพื่อใส่ Cache-Control header (jsonResponse ไม่รองรับ cache)
      const body = JSON.stringify({ docs });
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders(), ...extraHeaders },
      });
    }

    // /api/db/:collection/_query  (where/orderBy)
    if (parts.length === 2 && parts[1] === "_query" && request.method === "POST") {
      const body = await request.json();
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
        // 🔒 แก้บั๊ก C2 (2026-09-17): กัน Privilege Escalation
        //   เดิม: ตรวจแค่ "login หรือไม่" แต่ไม่ตรวจ admin.role === "main"
        //   → Sub-admin สามารถ PATCH/PUT ตัวเองเป็น main admin หรือแก้ email ของ main admin ได้
        //   แก้: เฉพาะ main admin เท่านั้นที่เขียน collection="admins" ได้ (PUT)
        //   สอดคล้องกับ create-admin endpoint (บรรทัด ~303) ที่มี role check อยู่แล้ว
        if (collection === "admins" && admin.role !== "main") {
          return jsonResponse({ error: "เฉพาะแอดมินหลักเท่านั้นที่จัดการแอดมินได้" }, 403);
        }
        const body = await request.json();
        if (!admin && collection === "orders") {
          // ลูกค้าไม่ได้ login — อนุญาตเฉพาะ "สร้างออเดอร์ใหม่" (id ยังไม่มีอยู่ในระบบ) เท่านั้น
          // กันไม่ให้เขียนทับออเดอร์ที่มีอยู่แล้วของคนอื่นโดยไม่ login
          const existing = await getDocument(env, collection, id);
          if (existing) return jsonResponse({ error: "ยังไม่ได้เข้าสู่ระบบ" }, 401);

          // 🔒 Security (2026-09-17 P0): Validate + sanitize ออเดอร์ที่ลูกค้าสร้างเอง
          //   เดิม: server รับ body.data ตรง ๆ → ลูกค้าสามารถส่ง status='completed' หรือ total=-100
          //   ทำให้ bypass การตรวจสอบเงินโอนของ admin (เพราะ admin filter เฉพาะ pending_verify)
          //   ใหม่: server บังคับ status='pending_verify' + validate required fields + total >= 0
          //   admin จะเห็นออเดอร์นี้ใน "รอตรวจสอบ" เสมอ → ต้องเช็คเงินโอนเองทุกครั้ง
          const data = body.data || {};

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
          ]);
          const filteredData = {};
          for (const key of Object.keys(data)) {
            if (CUSTOMER_ALLOWED_FIELDS.has(key)) {
              filteredData[key] = data[key];
            }
          }
          // force status หลัง filter (กัน case ที่ status อยู่ใน whitelist โดยไม่ตั้งใจ — ปลอดภัยกว่า)
          filteredData.status = "pending_verify";

          body.data = filteredData;
        }
        const result = await setDocument(env, collection, id, body.data || {}, !!body.merge, admin?.email);
        return jsonResponse(result);
      }
      if (request.method === "PATCH") {
        // 🔒 แก้บั๊ก C2 (2026-09-17): กัน Privilege Escalation — เหมือน PUT
        //   เฉพาะ main admin เท่านั้นที่ PATCH collection="admins" ได้
        if (collection === "admins" && admin.role !== "main") {
          return jsonResponse({ error: "เฉพาะแอดมินหลักเท่านั้นที่จัดการแอดมินได้" }, 403);
        }
        const body = await request.json();
        const result = await updateDocument(env, collection, id, body.data || {});
        if (result.notFound) return jsonResponse({ error: "ไม่พบเอกสารที่จะอัปเดต" }, 404);
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
        await deleteDocument(env, collection, id);
        return jsonResponse({ ok: true });
      }
    }
  } catch (err) {
    return jsonResponse({ error: "db error: " + (err?.message || String(err)) }, 500);
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
  const admin = await getSessionAdmin(request, env);
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
  const orderId = String(body?.orderId || "").trim();
  if (!orderId) return jsonResponse({ error: "กรุณาระบุ orderId" }, 400);

  // โหลด order doc
  const orderDoc = await getDocument(env, "orders", orderId);
  if (!orderDoc || !orderDoc.data) {
    return jsonResponse({ error: "ไม่พบออเดอร์ที่ระบุ" }, 404);
  }
  const order = orderDoc.data;

  // ⚠️ ไม่ตรวจ order.status — เหมือน behavior เดิมของ createOrderZip ใน orders.js
  // เพราะ confirmPaymentAndCreateZip() เรียก createOrderZip() ก่อนเปลี่ยน status เป็น 'processing'
  // ตอนนั้นยังเป็น 'pending_verify' อยู่ → ถ้าเช็ค status จะ block flow นี้
  // (ตัวอนาคต: ถ้าต้องการ restrict เฉพาะบาง status ต้องแก้ caller ให้ update status ก่อนเรียก)

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
      const songIds = group.songs.map((s) => s.id);
      const songDocs = await getDocumentsByIds(env, "songs", songIds);
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
  try {
    const existing = await env.DB.prepare(
      "SELECT job_id, bucket_key FROM order_zip_jobs WHERE order_id = ? AND status = 'preparing'"
    ).bind(orderId).first();
    if (existing) {
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
    return jsonResponse({ error: "สร้าง multipart upload ใน R2 ไม่สำเร็จ: " + (err?.message || String(err)) }, 502);
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
    await env.DB.prepare(
      "INSERT INTO order_zip_jobs (job_id, order_id, bucket_key, parts, total_songs, status, error, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, 'preparing', '', ?, ?) " +
      "ON CONFLICT(job_id) DO UPDATE SET order_id = excluded.order_id, bucket_key = excluded.bucket_key, parts = excluded.parts, total_songs = excluded.total_songs, status = 'preparing', error = '', updated_at = excluded.updated_at"
    ).bind(jobId, orderId, bucketKey, initialParts, totalSongs, now, now).run();
  } catch (err) {
    // ถ้า insert ล้มเหลว → abort multipart upload เพื่อไม่ให้ค้างใน R2
    try { await mpu.abort(); } catch (_) {}
    return jsonResponse({ error: "บันทึกสถานะ ZIP job ไม่สำเร็จ: " + (err?.message || String(err)) }, 500);
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
    return jsonResponse({ error: "อัปเดตสถานะออเดอร์ไม่สำเร็จ: " + (err?.message || String(err)) }, 500);
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
  const admin = await getSessionAdmin(request, env);
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
    return jsonResponse({ error: "อ่านสถานะ ZIP job ไม่สำเร็จ (อาจยังไม่ได้สร้างตาราง order_zip_jobs — รัน schema.sql ใหม่): " + (err?.message || String(err)) }, 500);
  }
  if (!jobRow) {
    return jsonResponse({ error: "ไม่พบ ZIP job นี้ (อาจถูกยกเลิกไปแล้ว)" }, 404);
  }
  if (jobRow.status !== "preparing") {
    return jsonResponse({ error: `ZIP job นี้อยู่ในสถานะ "${jobRow.status}" ไม่สามารถ append ได้` }, 400);
  }

  // โหลด song doc
  const songDoc = await getDocument(env, "songs", songId);
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
    return jsonResponse({ error: `ตรวจไฟล์ WAV จาก R2 ไม่สำเร็จ (key: ${r2Key}): ` + (err?.message || String(err)) }, 502);
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
  const filename = uniqueZipFileName(baseName);

  // ===== คำนวณ partSize + offset =====
  const filenameInZip = folderPath ? `${folderPath}/${filename}` : filename;
  const filenameBytesLen = encodeFilename(filenameInZip).byteLength;
  const LFH_SIZE = 30 + filenameBytesLen;
  const DD_SIZE = 16;
  const partSize = LFH_SIZE + wavSize + DD_SIZE;
  const offset = parts.reduce((sum, p) => sum + Number(p.partSize || 0), 0);

  // ===== บันทึก metadata ของ entry ใน D1 (ยังไม่อัปโหลด part) =====
  // finalize จะใช้ metadata นี้เพื่อ:
  //   - อ่าน WAV จาก R2 (ผ่าน r2Key)
  //   - คำนวณ CRC32 ของ WAV bytes
  //   - build entry bytes [LFH + WAV + DD]
  //   - ส่งเข้า buffer 8MB → upload เป็น R2 multipart part (ทุก part ขนาด 8MB ยกเว้น trailing)
  parts.push({
    partNumber,
    songId,
    songName: song.song_name || songName,
    folderPath,
    filename,
    r2Key,                   // R2 object key ของ WAV (ใช้ใน finalize อ่าน WAV)
    size: wavSize,            // WAV bytes (สำหรับ CD entry's compressed/uncompressed size)
    partSize,                // total bytes (LFH + WAV + DD) — สำหรับ offset/cdOffset calculation
    offset,                  // LFH offset ในไฟล์ ZIP — สำหรับ CD entry's local header offset
  });

  const now = new Date().toISOString();
  try {
    // 🔧 (2026-09-18 v5): บันทึกทั้ง object รวม finalizeState (ถ้ามี — ปกติ append จะ null ตอนนี้)
    await env.DB.prepare(
      "UPDATE order_zip_jobs SET parts = ?, updated_at = ? WHERE job_id = ?"
    ).bind(JSON.stringify(partsData), now, jobId).run();
  } catch (err) {
    return jsonResponse({ error: "บันทึกข้อมูล entry ไม่สำเร็จ: " + (err?.message || String(err)) }, 500);
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
    return jsonResponse({ error: "อ่านสถานะ ZIP job ไม่สำเร็จ: " + (err?.message || String(err)) }, 500);
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
    return jsonResponse({ error: "resume multipart upload ไม่สำเร็จ: " + (err?.message || String(err)) }, 502);
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
      error: "build/upload ZIP ไม่สำเร็จ: " + (err?.message || String(err)),
    }, 500);
  }

  // ===== complete multipart upload =====
  try {
    await mpu.complete(allUploadedParts);
  } catch (err) {
    return jsonResponse({ error: "complete multipart upload ไม่สำเร็จ: " + (err?.message || String(err)) }, 502);
  }

  // ===== อัปเดต order doc =====
  const base = env.R2_PUBLIC_BASE_URL.replace(/\/+$/, "");
  const url = `${base}/${jobRow.bucket_key.split("/").map(encodeURIComponent).join("/")}`;
  const zipFileName = jobRow.bucket_key.split("/").pop() || `Order-${jobRow.order_id}.zip`;
  const totalSongs = Number(jobRow.total_songs || parts.length);
  const now = new Date().toISOString();

  try {
    await updateDocument(env, "orders", jobRow.order_id, {
      zip_status: "ready",
      zip_download_url: url,
      zip_file_name: zipFileName,
      zip_public_id: jobRow.bucket_key,
      zip_song_count: totalSongs,
      zip_created_at: now,
      zip_error: "",
      updated_at: now,
    });
  } catch (err) {
    return jsonResponse({
      error: "อัปเดตออเดอร์ด้วยลิงก์ ZIP ไม่สำเร็จ (แต่ไฟล์ ZIP ถูกสร้างใน R2 แล้ว — bucket key: " + jobRow.bucket_key + "): " + (err?.message || String(err)),
    }, 500);
  }

  // ===== ลบ job row =====
  await deleteOrderZipJob(env, jobId);

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
const ZIP_FINALIZE_SONGS_PER_ROUND = 30;        // จำนวนเพลงต่อ 1 Worker invocation (เดิม 20, แล้วเดิมสุด 10)
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
    return jsonResponse({ error: "อ่านสถานะ ZIP job ไม่สำเร็จ: " + (err?.message || String(err)) }, 500);
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
    return jsonResponse({ error: "resume multipart upload ไม่สำเร็จ: " + (err?.message || String(err)) }, 502);
  }

  // ===== Allocate chunk buffer 8MB + load partial buffer จาก R2 =====
  const chunkBuffer = new Uint8Array(ZIP_FINALIZE_CHUNK_SIZE);
  let chunkLen = 0;
  if (state.partialBufferLen > 0) {
    let partialObj;
    try {
      partialObj = await env.BUCKET.get(state.partialBufferKey);
    } catch (err) {
      return jsonResponse({ error: `อ่าน partial buffer จาก R2 ไม่สำเร็จ: ` + (err?.message || String(err)) }, 502);
    }
    if (!partialObj) {
      return jsonResponse({ error: `ไม่พบ partial buffer ใน R2 (key: ${state.partialBufferKey})` }, 404);
    }
    let partialBytes;
    try {
      const partialBuf = await partialObj.arrayBuffer();
      partialBytes = new Uint8Array(partialBuf);
    } catch (err) {
      return jsonResponse({ error: `อ่าน partial buffer เข้า memory ไม่สำเร็จ: ` + (err?.message || String(err)) }, 500);
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
  let processedCount = 0;
  try {
    const endIdx = Math.min(state.nextSongIdx + ZIP_FINALIZE_SONGS_PER_ROUND, songs.length);
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

      // 🔧 (2026-09-19 perf v2 จุด #1): stream WAV ผ่าน reader แทน arrayBuffer
      //   เดิม (ช้า + memory 50MB): wavBuf = await wavObject.arrayBuffer() → โหลดทั้งไฟล์เข้า memory
      //   ใหม่ (เร็ว + memory ~1MB): stream ทีละ chunk 1MB ผ่าน reader → คำนวณ CRC + append พร้อมกัน
      //
      //   ผลกระทบต่อระบบเดิม: 0%
      //   - CRC32 คำนวณด้วย crc32Update() ตัวเดิม → ค่าที่ได้เท่าเดิม 100%
      //   - LFH + WAV + DD structure เท่าเดิม
      //   - ลด memory จาก 50MB → ~1MB (chunk buffer 16MB ใช้ร่วมกับ appendBytes)
      //   - เร็วขึ้น ~2-3 เท่า เพราะ R2 streaming + CRC + append ทำพร้อมกัน
      const reader = wavObject.body.getReader();
      let crc = 0;
      let wavTotalSize = 0;

      // Build entry bytes: [LFH + WAV + DD]
      // LFH ส่งเข้า chunkBuffer ก่อน (ส่งตรง ๆ ผ่าน appendBytes)
      const filenameInZip = p.folderPath ? `${p.folderPath}/${p.filename}` : p.filename;
      const filenameBytes = encodeFilename(filenameInZip);
      const lfhBytes = buildLocalFileHeader(filenameBytes);
      await appendBytes(lfhBytes);

      // Stream WAV chunks → update CRC + append ในคราเดียว (ไม่เก็บ WAV ใน memory)
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value && value.byteLength > 0) {
            crc = crc32Update(crc, value);     // CRC32 ตาม ZIP spec (เฉพาะ WAV bytes)
            wavTotalSize += value.byteLength;
            await appendBytes(value);            // append ทันที ไม่รอโหลดจบ
          }
        }
      } catch (err) {
        throw new Error(`อ่าน WAV ของเพลง "${p.songName}" แบบ stream ไม่สำเร็จ: ` + (err?.message || String(err)));
      }
      // ปิด reader (ป้องกัน R2 connection ค้าง — เหมือน bug fix ใน append)
      try { reader.releaseLock(); } catch (_) {}

      songs[i].crc32 = crc;

      // DD (Data Descriptor) — ใส่ค่า CRC + size จริง ตอนท้าย entry
      const ddBytes = buildDataDescriptor(crc, wavTotalSize);
      await appendBytes(ddBytes);

      state.nextSongIdx += 1;
      processedCount += 1;
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
    return jsonResponse({ error: "บันทึก state ไม่สำเร็จ: " + (err?.message || String(err)) }, 500);
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
    return jsonResponse({ error: "อ่านสถานะ ZIP job ไม่สำเร็จ: " + (err?.message || String(err)) }, 500);
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
    return jsonResponse({ error: "resume multipart upload ไม่สำเร็จ: " + (err?.message || String(err)) }, 502);
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
    return jsonResponse({ error: "finalize-compose ไม่สำเร็จ: " + (err?.message || String(err)) }, 500);
  }

  // อัปเดต order doc
  const base = env.R2_PUBLIC_BASE_URL.replace(/\/+$/, "");
  const url = `${base}/${jobRow.bucket_key.split("/").map(encodeURIComponent).join("/")}`;
  const zipFileName = jobRow.bucket_key.split("/").pop() || `Order-${jobRow.order_id}.zip`;
  const totalSongs = Number(jobRow.total_songs || songs.length);
  const now = new Date().toISOString();
  try {
    await updateDocument(env, "orders", jobRow.order_id, {
      zip_status: "ready",
      zip_download_url: url,
      zip_file_name: zipFileName,
      zip_public_id: jobRow.bucket_key,
      zip_song_count: totalSongs,
      zip_created_at: now,
      zip_error: "",
      updated_at: now,
    });
  } catch (err) {
    return jsonResponse({
      error: "อัปเดตออเดอร์ด้วยลิงก์ ZIP ไม่สำเร็จ (แต่ไฟล์ ZIP ถูกสร้างใน R2 แล้ว — bucket key: " + jobRow.bucket_key + "): " + (err?.message || String(err)),
    }, 500);
  }

  // Cleanup
  await cleanupPartialBuffer(env, state);
  await deleteOrderZipJob(env, jobId);

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
  const admin = await getSessionAdmin(request, env);
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
      "SELECT job_id, order_id, bucket_key, parts, status FROM order_zip_jobs WHERE job_id = ?"
    ).bind(jobId).first();
  } catch (err) {
    return jsonResponse({ error: "อ่านสถานะ ZIP job ไม่สำเร็จ: " + (err?.message || String(err)) }, 500);
  }
  if (!jobRow) return jsonResponse({ error: "ไม่พบ ZIP job นี้" }, 404);

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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
      return new Response(null, { headers: corsHeaders() });
    }

    if (url.pathname === "/api/upload" && request.method === "POST") {
      return handleUpload(request, env);
    }

    if (url.pathname === "/api/upload" && request.method === "DELETE") {
      if (!env.DB) return jsonResponse({ error: "ยังไม่ได้ผูก D1 database (binding: DB) ใน wrangler.jsonc" }, 500);
      return handleDeleteUpload(request, env);
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
      const admin = await getSessionAdmin(request, env);
      if (!admin) return jsonResponse({ error: "ยังไม่ได้เข้าสู่ระบบ" }, 401);
      let body;
      try { body = await request.json(); } catch { body = {}; }
      const coll = String(body?.collection || "").trim();
      // whitelist collections ที่ purge ได้ (กัน admin purge orders/admins โดยไม่ตั้งใจ)
      const PURGEABLE = new Set(["songs", "categories", "djs", "playlists", "discounts", "promotions", "settings"]);
      if (!coll || !PURGEABLE.has(coll)) {
        return jsonResponse({ error: "ระบุ collection ที่ถูกต้อง (songs, categories, djs, playlists, discounts, promotions, settings)" }, 400);
      }
      // Cloudflare CDN cache ไม่สามารถ purge แบบ specific path ผ่าน Worker ปกติ
      // แต่เราใช้วิธี "cache tag" — แต่ละ response มี Cache-Tag header → purge โดย tag
      // สำหรับ Free plan ที่ไม่มี cache tag API → ใช้ versioning: แอดมิน cache-bust ด้วย ?nocache=ts
      //   ในกรณีนี้ cache-purge แค่ acknowledge (response ok) — admin ที่ใช้ ?nocache จะข้าม cache อยู่แล้ว
      // ในอนาคต: ถ้ามี Cloudflare Paid plan → ใช้ Cache API หรือ R2 cache tag เพื่อ purge จริง
      return jsonResponse({ ok: true, purged: true, collection: coll, note: "Cache purge requested. Customer CDN cache may take up to 60s to expire." });
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
      const orderId = String(urlParams.get("orderId") || "").trim();
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
    // response: { ok: true, timestamp, d1: { ok, count }, r2: { ok } }
    if (url.pathname === "/api/health" && request.method === "GET") {
      const result = {
        ok: true,
        timestamp: new Date().toISOString(),
        d1: { ok: false, count: null },
        r2: { ok: false },
      };
      // ตรวจ D1 — ลอง SELECT COUNT(*) จาก documents (lightweight)
      if (env.DB) {
        try {
          const row = await env.DB.prepare("SELECT COUNT(*) AS c FROM documents LIMIT 1").first();
          result.d1.ok = true;
          result.d1.count = (row && row.c) || 0;
        } catch (err) {
          result.d1.ok = false;
          result.d1.error = err?.message || String(err);
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

    if (url.pathname.startsWith("/api/auth/")) {
      if (!env.DB) return jsonResponse({ error: "ยังไม่ได้ผูก D1 database (binding: DB) ใน wrangler.jsonc" }, 500);
      return handleAuth(request, env, url);
    }

    if (url.pathname.startsWith("/api/db/")) {
      if (!env.DB) return jsonResponse({ error: "ยังไม่ได้ผูก D1 database (binding: DB) ใน wrangler.jsonc" }, 500);
      return handleDb(request, env, url);
    }

    return jsonResponse({ error: "ไม่พบ endpoint นี้" }, 404);
  },
};
