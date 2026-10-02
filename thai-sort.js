// thai-sort.js — Helper สำหรับจัดเรียงรายการ (หมวดหมู่ / DJ / เพลย์ลิสต์) ตามลำดับ:
//   1) พยัญชนะไทย ก ข ค ... ฮ ก่อน
//   2) ตัวอักษรอังกฤษ A-Z ถัดมา
//   3) ตัวเลขเทียบตามค่าจริง (ก1, ก2, ... ก10 ไม่ใช่ ก1, ก10, ก2)
// ไฟล์นี้เป็นไฟล์ใหม่ที่เพิ่มเข้ามา (additive) ไม่ได้แก้ไฟล์เดิม —
// app-admin.js และ app-user.js import ฟังก์ชันจากที่นี่ไปใช้ตอนโหลดข้อมูล categories/djs/playlists
// ===================================================

// ลำดับพยัญชนะไทย ก-ฮ (ใช้ตำแหน่งใน string นี้เป็นค่าลำดับ)
const THAI_ORDER = "กขฃคฅฆงจฉชซฌญฎฏฐฑฒณดตถทธนบปผฝพฟภมยรลฦวศษสหฬอฮ";
const THAI_RANK = {};
for (let i = 0; i < THAI_ORDER.length; i++) THAI_RANK[THAI_ORDER[i]] = i;

// คืนค่า [กลุ่ม, ลำดับในกลุ่ม] ของตัวอักษร 1 ตัว
//   กลุ่ม 0 = พยัญชนะไทย (ก-ฮ), กลุ่ม 1 = อังกฤษ A-Z, กลุ่ม 2 = อื่น ๆ (สระ/วรรณยุกต์ไทย ฯลฯ)
function charRank(ch) {
  if (THAI_RANK[ch] !== undefined) return [0, THAI_RANK[ch]];
  const upper = ch.toUpperCase();
  if (upper >= "A" && upper <= "Z") return [1, upper.charCodeAt(0) - 65];
  return [2, ch.codePointAt(0)];
}

// เทียบ chunk ที่เป็นตัวอักษรล้วน (ไม่ใช่ตัวเลข) ทีละตัวอักษรตาม charRank
function compareTextChunk(a, b) {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const ca = a[i];
    const cb = b[i];
    if (ca === undefined) return -1;
    if (cb === undefined) return 1;
    const [ga, ra] = charRank(ca);
    const [gb, rb] = charRank(cb);
    if (ga !== gb) return ga - gb;
    if (ra !== rb) return ra - rb;
  }
  return 0;
}

// แยก string เป็น chunk สลับ [ตัวอักษร, ตัวเลข, ตัวอักษร, ตัวเลข, ...]
// เช่น "ก10" -> ["ก", "10"], "ก2ข3" -> ["ก", "2", "ข", "3"]
function splitChunks(str) {
  return String(str == null ? "" : str).match(/\d+|\D+/g) || [];
}

// เปรียบเทียบ 2 ค่า (natural sort): พยัญชนะไทย > อังกฤษ > อื่น ๆ ก่อน แล้วค่อยเทียบตัวเลขตามค่าจริง
export function thaiNaturalCompare(a, b) {
  const chunksA = splitChunks(a);
  const chunksB = splitChunks(b);
  const len = Math.max(chunksA.length, chunksB.length);
  for (let i = 0; i < len; i++) {
    const ca = chunksA[i];
    const cb = chunksB[i];
    if (ca === undefined) return -1;
    if (cb === undefined) return 1;
    const numA = /^\d+$/.test(ca);
    const numB = /^\d+$/.test(cb);
    if (numA && numB) {
      const diff = parseInt(ca, 10) - parseInt(cb, 10);
      if (diff !== 0) return diff;
    } else {
      const diff = compareTextChunk(ca, cb);
      if (diff !== 0) return diff;
    }
  }
  return 0;
}

// เรียง array ของ object ตามค่าฟิลด์ที่กำหนด (ใช้ thaiNaturalCompare) — คืน array ใหม่เสมอ ไม่แก้ array เดิม
export function sortByThaiName(list, field) {
  return [...(list || [])].sort((a, b) => thaiNaturalCompare(a && a[field], b && b[field]));
}

// 🎨 (2026-09-26): เพิ่ม helper สำหรับ sort เพลง — ใช้ song_name เป็น field หลัก
//   ทำให้การเรียงเพลงเหมือนกันทั้งฝั่ง user และฝั่งแอดมิน
//   ลำดับ: พยัญชนะไทย ก-ฮ > A-Z > 0-9 (ตัวเลขเทียบตามค่าจริง: A1, A2, A3, A10 ไม่ใช่ A1, A10, A2)
export function sortSongsByThaiName(songs) {
  return sortByThaiName(songs, "song_name");
}
