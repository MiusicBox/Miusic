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
//   ฝั่ง browser จึงเรียกผ่าน db-client.js (หน้าตาเหมือน Firestore SDK เดิมทุกฟังก์ชันที่แอปนี้ใช้
//   คือ collection/doc/getDoc/getDocs/addDoc/setDoc/updateDoc/deleteDoc/query/where/orderBy/onSnapshot)
//   แล้ว db-client.js ค่อยยิง fetch มาที่ endpoint กลุ่มนี้อีกที — ทำให้ app-admin.js/orders.js/ฯลฯ
//   ไม่ต้องแก้ logic เดิมเลย แก้แค่บรรทัด import ให้ชี้มาที่ไฟล์ในเว็บเราแทน CDN ของ Firebase
// ===================================================
import { hashPassword, verifyPassword, getSessionAdmin, createSession, deleteSession, buildSessionCookie, buildClearCookie, getCookie, cleanupExpiredSessions } from "./auth-helpers.js";
import { getDocument, listDocuments, queryDocuments, setDocument, updateDocument, deleteDocument, countDocuments, getDocumentsByIds } from "./db-helpers.js";

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
  // ก่อนหน้านี้ endpoint นี้เปิดให้ใครก็อัปโหลดได้ ทำให้คนนอกสามารถอัปโหลดไฟล์ใดก็ได้เข้า bucket
  // การตรวจนี้ใช้รูปแบบเดียวกับ handleDeleteUpload ที่มีอยู่แล้ว (บรรทัด 112) — ไม่กระทบฝั่งแอป
  // เพราะทุกจุดที่เรียก /api/upload (ผ่าน storage-adapter.js) รันในบริบท admin.html ที่ล็อกอินแล้ว
  const uploadAdmin = await getSessionAdmin(request, env);
  if (!uploadAdmin) return jsonResponse({ error: "ยังไม่ได้เข้าสู่ระบบ" }, 401);

  if (!env.BUCKET) {
    return jsonResponse({ error: "ยังไม่ได้ผูก R2 bucket (binding: BUCKET) ใน wrangler.jsonc" }, 500);
  }
  if (!env.R2_PUBLIC_BASE_URL) {
    return jsonResponse({ error: "ยังไม่ได้ตั้งค่า R2_PUBLIC_BASE_URL ใน wrangler.jsonc" }, 500);
  }

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

  const key = buildObjectKey(folder, file.name);
  const httpMetadata = {
    contentType: file.type || "application/octet-stream",
  };

  // เดิม (Cloudinary): orders.js ใช้ toCloudinaryDownloadUrl() แปะ fl_attachment ต่อท้าย URL
  // ตอนแสดงผลทุกครั้งที่ผู้ใช้กดลิงก์ดาวน์โหลด — ย้ายมาตั้งตอนอัปโหลดครั้งเดียวแทน ผลลัพธ์
  // ปลายทาง (กดแล้วดาวน์โหลดไฟล์ทันที ไม่เปิดเล่นในแท็บใหม่) เหมือนเดิมทุกประการ
  const isForceDownload = FORCE_DOWNLOAD_FOLDERS.has(folder) || resourceType === "raw";
  if (isForceDownload) {
    const downloadName = (file.name || key.split("/").pop() || "download").replace(/"/g, "");
    httpMetadata.contentDisposition = `attachment; filename="${downloadName}"`;
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
    const row = await env.DB.prepare("SELECT COUNT(*) AS c FROM admin_users").first();
    if ((row?.c || 0) > 0) {
      return jsonResponse({ error: "ระบบมีแอดมินอยู่แล้ว ไม่สามารถตั้งค่าแอดมินคนแรกซ้ำได้" }, 409);
    }
    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400); }
    const email = String(body.email || "").trim();
    const password = String(body.password || "");
    const displayName = String(body.displayName || "").trim() || email.split("@")[0];
    if (!email) return jsonResponse({ error: "กรุณากรอกอีเมล" }, 400);
    if (password.length < 6) return jsonResponse({ error: "รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร" }, 400);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const passwordHash = await hashPassword(password);
    await env.DB.prepare(
      "INSERT INTO admin_users (id, email, password_hash, display_name, role, created_at, created_by) VALUES (?, ?, ?, ?, 'main', ?, 'bootstrap')"
    ).bind(id, email, passwordHash, displayName, now).run();
    const token = await createSession(env, id);
    const admin = await env.DB.prepare("SELECT id, email, display_name, role, created_at, created_by FROM admin_users WHERE id = ?").bind(id).first();
    return jsonResponse(adminToClient(admin), 200, { "Set-Cookie": buildSessionCookie(token) });
  }

  if (path === "login" && request.method === "POST") {
    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400); }
    const email = String(body.email || "").trim();
    const password = String(body.password || "");
    // 🔒 Maintenance (2026-09-16): ทำความสะอาด session ที่หมดอายุก่อนสร้าง session ใหม่
    // ลบ session ของคนที่ไม่เคยกลับมา (ปิดเบราว์เซอร์ไปเลย) ออกจากตาราง sessions
    // ไม่ทำให้ login พังถ้า cleanup ล้มเหลว (ฟังก์ชัน try/catch ภายในเอง)
    await cleanupExpiredSessions(env);
    const admin = await env.DB.prepare("SELECT * FROM admin_users WHERE email = ?").bind(email).first();
    if (!admin || !(await verifyPassword(password, admin.password_hash))) {
      return jsonResponse({ error: "อีเมลหรือรหัสผ่านไม่ถูกต้อง", code: "auth/invalid-credential" }, 401);
    }
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
function normalizePhoneServer(v) { return String(v || "").replace(/[^0-9]/g, ""); }
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

  // 🔒 Security (2026-09-11): ดึง admin status เสมอเมื่อเป็น collection "songs" เพื่อตัดสินใจว่าจะ sanitize
  // ฟิลด์ sensitive ออกหรือไม่ — ไม่ใช่แค่ตอน isWrite หรือ non-public collection
  const needsAdminCheck = isWrite || !PUBLIC_READ_COLLECTIONS.has(collection) || collection === "songs" || isOrdersCountPendingEndpoint || isBatchGetEndpoint;

  let admin = null;
  if (needsAdminCheck || isOrdersCustomerEndpoint) {
    admin = await getSessionAdmin(request, env);
  }

  // ปฏิเสธการเข้าถึงถ้าไม่ใช่ admin และไม่ใช่ endpoint ที่อนุญาตให้ public เข้าถึงได้
  // ข้อยกเว้น:
  //   - isOrdersPublicWriteCandidate: ลูกค้า checkout/ยกเลิกออเดอร์ตัวเอง (เช็คเพิ่มเติมในแต่ละ branch)
  //   - isOrdersCustomerEndpoint: ลูกค้าค้นหาออเดอร์ตัวเองผ่าน endpoint ใหม่
  //   - songs GET request: อนุญาตให้ non-admin อ่าน แต่จะ sanitize ฟิลด์ sensitive ออก
  const isSongsPublicGet = collection === "songs" && !isWrite && request.method === "GET";
  if (!admin && !isOrdersPublicWriteCandidate && !isOrdersCustomerEndpoint && !isSongsPublicGet) {
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
      const allDocs = await listDocuments(env, "orders");
      const queryName = normalizeNameServer(customerName);
      const queryPhone = normalizePhoneServer(whatsapp);
      const matched = allDocs.filter((d) => {
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
      let docs = await listDocuments(env, collection);
      // 🔒 sanitize ฟิลด์ sensitive ของ songs ถ้าเป็น non-admin
      if (collection === "songs" && !admin) {
        docs = sanitizeSongsForPublic(docs);
      }
      return jsonResponse({ docs });
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
        const body = await request.json();
        if (!admin && collection === "orders") {
          // ลูกค้าไม่ได้ login — อนุญาตเฉพาะ "สร้างออเดอร์ใหม่" (id ยังไม่มีอยู่ในระบบ) เท่านั้น
          // กันไม่ให้เขียนทับออเดอร์ที่มีอยู่แล้วของคนอื่นโดยไม่ login
          const existing = await getDocument(env, collection, id);
          if (existing) return jsonResponse({ error: "ยังไม่ได้เข้าสู่ระบบ" }, 401);
        }
        const result = await setDocument(env, collection, id, body.data || {}, !!body.merge, admin?.email);
        return jsonResponse(result);
      }
      if (request.method === "PATCH") {
        const body = await request.json();
        const result = await updateDocument(env, collection, id, body.data || {});
        if (result.notFound) return jsonResponse({ error: "ไม่พบเอกสารที่จะอัปเดต" }, 404);
        return jsonResponse(result);
      }
      if (request.method === "DELETE") {
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
