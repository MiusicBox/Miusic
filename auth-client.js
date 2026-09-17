// auth-client.js
// ===================================================
// เลียนแบบหน้าตา Firebase Auth SDK เฉพาะฟังก์ชันที่โปรเจกต์นี้ใช้จริง (ตรวจสอบครบทุกไฟล์แล้ว):
// signInWithEmailAndPassword, onAuthStateChanged, signOut, createUserWithEmailAndPassword,
// reauthenticateWithCredential, EmailAuthProvider.credential, updatePassword, getAuth,
// initializeApp, deleteApp — ข้างในยิง fetch() ไปที่ /api/auth/* บน Worker (คุย D1) แทน Firebase Auth จริง
// ระบบ session ใช้คุกกี้ HttpOnly ฝั่ง Worker (ดู worker/auth-helpers.js) จึงไม่มี token ให้จัดการฝั่ง
// browser เลย — เพราะเหตุนี้ getAuth/initializeApp/deleteApp (ของเดิมใช้ทำ "secondary app" กันไม่ให้
// สร้างแอดมินใหม่แล้วเด้งตัวเองออกจากระบบ) จึงเป็นแค่ stub เฉยๆ ในระบบใหม่ (ปัญหานั้นไม่มีอยู่แล้ว
// เพราะสร้างแอดมินใหม่ผ่าน endpoint /api/auth/create-admin ซึ่งไม่แตะ session ของคนที่ล็อกอินอยู่เลย)
// ===================================================

const listeners = [];

export const auth = {
  currentUser: null,
  app: { options: {} }, // เก็บไว้เพื่อความเข้ากันได้กับ admin-roles.js (auth.app.options)
};

function toUser(body) {
  if (!body || !body.uid) return null;
  return { uid: body.uid, email: body.email, displayName: body.displayName };
}
function notify() {
  for (const cb of listeners.slice()) cb(auth.currentUser);
}
async function safeJson(res) {
  try { return await res.json(); } catch { return {}; }
}
function apiError(body, fallbackMessage, fallbackCode) {
  const err = new Error((body && body.error) || fallbackMessage);
  err.code = (body && body.code) || fallbackCode;
  return err;
}

// ---------------- ตรวจสอบ session ปัจจุบันตอนโหลดหน้าเว็บครั้งแรก (เทียบเท่า Firebase ตรวจ token ที่เก็บไว้) ----------------
let initialCheckDone = false;
const initialCheckPromise = (async () => {
  try {
    const res = await fetch("/api/auth/me", { credentials: "same-origin" });
    auth.currentUser = res.ok ? toUser(await safeJson(res)) : null;
    // เก็บ role ไว้ใน currentUser ด้วย เผื่อโค้ดเดิมบางจุดอยากอ่านตรงๆ (ของเดิม Firebase ไม่มี role
    // ใน user object แต่ resolveCurrentAdminRole() จะ query เพิ่มเองอยู่แล้วเหมือนเดิมทุกจุด)
  } catch {
    auth.currentUser = null;
  }
  initialCheckDone = true;
  notify();
})();

export function onAuthStateChanged(_auth, callback) {
  listeners.push(callback);
  if (initialCheckDone) callback(auth.currentUser);
  else initialCheckPromise.then(() => callback(auth.currentUser));
  return function unsubscribe() {
    const i = listeners.indexOf(callback);
    if (i >= 0) listeners.splice(i, 1);
  };
}

export async function signInWithEmailAndPassword(_auth, email, password) {
  const res = await fetch("/api/auth/login", {
    method: "POST", credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const body = await safeJson(res);
  if (!res.ok) throw apiError(body, "เข้าสู่ระบบไม่สำเร็จ", "auth/invalid-credential");
  auth.currentUser = toUser(body);
  notify();
  return { user: auth.currentUser };
}

export async function signOut(_auth) {
  await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" }).catch(() => {});
  auth.currentUser = null;
  notify();
}

// ใช้ตอนแอดมินหลักเพิ่มแอดมินใหม่ (admin-roles.js) — ไม่แตะ session ของบัญชีที่ล็อกอินอยู่เลย
export async function createUserWithEmailAndPassword(_auth, email, password) {
  const res = await fetch("/api/auth/create-admin", {
    method: "POST", credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const body = await safeJson(res);
  if (!res.ok) throw apiError(body, "สร้างบัญชีไม่สำเร็จ", "auth/unknown-error");
  return { user: { uid: body.uid, email: body.email } };
}

// credential เป็นแค่ตัวห่อรหัสผ่านเดิมไว้ส่งไปยืนยันฝั่ง server (ไม่ใช่ token จริงแบบ Firebase)
export const EmailAuthProvider = {
  credential(email, password) {
    return { email, password };
  },
};

export async function reauthenticateWithCredential(_user, credential) {
  const res = await fetch("/api/auth/verify-password", {
    method: "POST", credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: credential.password }),
  });
  const body = await safeJson(res);
  if (!res.ok) throw apiError(body, "รหัสผ่านปัจจุบันไม่ถูกต้อง", "auth/wrong-password");
  return true;
}

// 🔒 Security (2026-09-17 P0): เพิ่มพารามิเตอร์ currentPassword — ส่งไป verify ฝั่ง server ด้วย
//   เดิม: ส่งแค่ newPassword → server ไม่ verify เดิม (ถ้ามีคนขโมย cookie เปลี่ยนได้ทันที)
//   ใหม่: ส่ง currentPassword ไปด้วย → server verify ก่อนเปลี่ยน (กัน session theft)
//   caller (app-admin.js) ต้องส่ง currentPassword มาด้วย — ถ้าไม่ส่ง server จะ reject (400)
export async function updatePassword(_user, newPassword, currentPassword) {
  const res = await fetch("/api/auth/change-password", {
    method: "POST", credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ newPassword, currentPassword }),
  });
  const body = await safeJson(res);
  if (!res.ok) throw apiError(body, "เปลี่ยนรหัสผ่านไม่สำเร็จ", "auth/unknown-error");
}

// ---------------- stub เฉยๆ (ของเดิมใช้ทำ "secondary app" — ระบบใหม่ไม่ต้องใช้แล้ว แต่คงชื่อไว้ให้ import ได้) ----------------
export function initializeApp(options) {
  return { options: options || {}, name: "app-" + Date.now() };
}
export function getAuth(_app) {
  return auth; // ใช้ session/คุกกี้เดียวกันเสมอ ไม่มีแนวคิด "หลาย auth instance" แบบ Firebase แล้ว
}
export async function deleteApp(_app) {
  // no-op — ไม่มีทรัพยากรอะไรต้องเก็บกวาดในระบบใหม่
}

// ---------------- ใหม่: สำหรับหน้าจอ "ตั้งค่าแอดมินคนแรก" (แทนที่ขั้นตอนสร้างบัญชีผ่าน Firebase Console เดิม) ----------------
// 🔒 Security (2026-09-17 P1): เปลี่ยน error fallback จาก return true → return null
//   เดิม: ถ้า fetch error → return true (สมมุติมี admin) → user เข้าโหมด login ปกติ
//   ปัญหา: ถ้า DB ไม่มี admin จริง ๆ และ network พัง → user ติดหน้า login ไม่มีทาง bootstrap
//   ใหม่: ถ้า fetch error → return null (unknown) → app-admin.js แสดงทั้ง login + ปุ่ม bootstrap
//   คืนค่า: true = มี admin, false = ไม่มี, null = ไม่แน่ใจ (error)
export async function checkHasAdmin() {
  try {
    const res = await fetch("/api/auth/has-admin", { credentials: "same-origin" });
    const body = await safeJson(res);
    return body.hasAdmin !== false; // true หรือ false
  } catch {
    return null; // 🔧 (2026-09-17 P1): คืน null แทน true → app-admin.js จะแสดงทั้ง login + bootstrap
  }
}
export async function bootstrapFirstAdmin(email, password, displayName) {
  const res = await fetch("/api/auth/bootstrap", {
    method: "POST", credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, displayName }),
  });
  const body = await safeJson(res);
  if (!res.ok) throw apiError(body, "ตั้งค่าแอดมินคนแรกไม่สำเร็จ", "auth/unknown-error");
  auth.currentUser = toUser(body);
  notify();
  return { user: auth.currentUser };
}
