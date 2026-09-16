// worker/auth-helpers.js
// ===================================================
// ฟังก์ชันช่วยสำหรับระบบยืนยันตัวตนใหม่ (แทน Firebase Auth) — รัน server-side ใน Worker เท่านั้น
// - Hash รหัสผ่านด้วย PBKDF2-SHA256 (Web Crypto ที่ Workers runtime รองรับในตัว ไม่ต้องพึ่ง library ภายนอก)
// - จัดการ session token (สุ่ม 32 ไบต์) เก็บใน D1 ตาราง sessions + คุกกี้ HttpOnly
// ===================================================

const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 วัน
const PBKDF2_ITERATIONS = 100000;

function bytesToBase64(bytes) {
  let binary = "";
  bytes.forEach((b) => { binary += String.fromCharCode(b); });
  return btoa(binary);
}
function base64ToBytes(b64) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial, 256
  );
  return `pbkdf2$${PBKDF2_ITERATIONS}$${bytesToBase64(salt)}$${bytesToBase64(new Uint8Array(bits))}`;
}

export async function verifyPassword(password, stored) {
  if (!stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = parseInt(parts[1], 10);
  const salt = base64ToBytes(parts[2]);
  const expectedHashB64 = parts[3];
  const keyMaterial = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    keyMaterial, 256
  );
  const gotHashB64 = bytesToBase64(new Uint8Array(bits));
  // เทียบความยาวเท่ากันก่อนเพื่อลด timing side-channel เบื้องต้น (ไม่ใช่ constant-time เต็มรูปแบบ
  // แต่เพียงพอสำหรับ use case นี้ ซึ่งเดิม Firebase Auth ก็ไม่ได้เปิดเผยรายละเอียดการเทียบนี้ให้ client อยู่แล้ว)
  return gotHashB64.length === expectedHashB64.length && gotHashB64 === expectedHashB64;
}

export function getCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    if (key === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

export function buildSessionCookie(token) {
  return `session_token=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`;
}
export function buildClearCookie() {
  return `session_token=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export async function createSession(env, adminId) {
  const token = bytesToBase64(crypto.getRandomValues(new Uint8Array(32))).replace(/[+/=]/g, "");
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000);
  await env.DB.prepare(
    "INSERT INTO sessions (token, admin_id, created_at, expires_at) VALUES (?, ?, ?, ?)"
  ).bind(token, adminId, now.toISOString(), expires.toISOString()).run();
  return token;
}

export async function deleteSession(env, token) {
  if (!token) return;
  await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run();
}

// คืนค่า admin_users row (ไม่รวม password_hash) ของ session ปัจจุบัน หรือ null ถ้าไม่ได้ login/session หมดอายุ
export async function getSessionAdmin(request, env) {
  const token = getCookie(request, "session_token");
  if (!token) return null;
  const session = await env.DB.prepare(
    "SELECT admin_id, expires_at FROM sessions WHERE token = ?"
  ).bind(token).first();
  if (!session) return null;
  if (new Date(session.expires_at).getTime() < Date.now()) {
    await deleteSession(env, token);
    return null;
  }
  const admin = await env.DB.prepare(
    "SELECT id, email, display_name, role, created_at, created_by FROM admin_users WHERE id = ?"
  ).bind(session.admin_id).first();
  return admin || null;
}

// 🔒 Maintenance (2026-09-16): ทำความสะอาด session ที่หมดอายุทั้งหมดออกจากตาราง sessions
// เหตุผล: getSessionAdmin() ด้านบนลบเฉพาะ session ของคนที่กลับมาใช้เท่านั้น — session ของคนที่
// ไม่เคยกลับมา (เช่น ปิดเบราว์เซอร์ไปเลย) จะค้างใน DB ตลอด สะสมเป็นขยะ
// ฟังก์ชันนี้ลบทั้งหมดที่ expires_at < ตอนนี้ กันตาราง sessions บวมโดยไม่จำเป็น
//
// ความปลอดภัย: try/catch ภายใน — ถ้า cleanup พัง (เช่น DB ชั่วคราว) จะไม่ throw ออกไป
// ทำให้ caller (login handler ใน worker/index.js) ไม่พังไปด้วย — คนยัง login ได้ปกติ
// เรียกครั้งเดียวตอน login (ดู worker/index.js: handleAuth "login") พอ — ไม่ต้องเรียกทุก request
export async function cleanupExpiredSessions(env) {
  try {
    await env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?")
      .bind(new Date().toISOString()).run();
  } catch (err) {
    // ไม่ throw — cleanup ไม่สำเร็จไม่ควรทำให้ login พัง (เป็น background maintenance)
    // Worker ไม่มี console ที่ user เห็น แต่ค่า console.* ยังถูกเก็บใน Worker logs ของ Cloudflare
    console.error("cleanupExpiredSessions error:", err?.message || String(err));
  }
}
