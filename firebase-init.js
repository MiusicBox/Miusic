// ===================================================
// firebase-init.js — ตั้งค่ากลาง ใช้ร่วมกันทั้ง index.html และ admin.html
//
// ⚠️ 2026-09-11: ย้ายฐานข้อมูลจาก Firestore -> Cloudflare D1 และ Auth จาก Firebase Auth -> ระบบ
// ยืนยันตัวตนของเว็บเอง (ผ่าน Worker + คุกกี้ session) ทั้งหมดแล้ว "ไม่มีการเชื่อมต่อ Firebase เหลืออยู่
// ในระบบนี้อีกต่อไป" — คงชื่อไฟล์นี้ไว้เหมือนเดิมโดยตั้งใจ (แม้ชื่อจะฟังดูเหมือนยังผูก Firebase) เพราะ
// app-admin.js / app-cart.js / app-promotion.js / app-user.js / orders.js / admin-roles.js ทั้งหมด
// import { db, auth, uploadToCloudinary } from "./firebase-init.js" อยู่หลายจุด การคงชื่อไฟล์+ชื่อตัวแปร
// ที่ export ไว้เดิมทำให้ไม่ต้องแก้ไฟล์เหล่านั้นเลยแม้แต่บรรทัดเดียวในส่วนนี้
//
// db   -> ตอนนี้คือ object เปล่า (db-client.js ไม่ได้ใช้ค่า db เลย แค่ต้องมีให้ collection(db,"..") เรียกได้)
// auth -> ตอนนี้คือ auth-client.js (คุยระบบยืนยันตัวตนของเว็บเองผ่าน Worker แทน Firebase Auth)
// ===================================================
export const db = {};
export { auth } from "./auth-client.js";

// เดิม (2026-09-10): ย้าย logic อัปโหลดไฟล์ทั้งหมดไปที่ storage-adapter.js แล้ว ค่านี้ยังคงเหมือนเดิมทุกประการ
// (ไม่เกี่ยวกับการย้ายฐานข้อมูล/auth รอบนี้เลย)
import { getStorageProvider } from "./storage-adapter.js";

export async function uploadToCloudinary(file, onProgress, signal) {
  return getStorageProvider().upload(file, {}, onProgress, signal);
}
