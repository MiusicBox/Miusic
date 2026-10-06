// thai-sort.js — ตัวเรียงลำดับกลางของทั้งระบบ (ลูกค้า / แอดมิน / เซิร์ฟเวอร์ใช้ตัวเดียวกัน)
//   ลำดับ: 1) พยัญชนะไทย ก-ฮ  2) อังกฤษ A-Z (ไม่สนตัวพิมพ์เล็ก/ใหญ่)  3) ตัวเลข 0-9 (เทียบตามค่าจริง 2 < 10)
//   - คำที่ขึ้นต้นด้วยสระนำ เ แ โ ใ ไ เรียงตามพยัญชนะตัวถัดไป (เพลงรัก อยู่หมวด พ, ไก่ อยู่หมวด ก)
//   - ช่องว่าง/สัญลักษณ์/อีโมจิหน้าคำถูกข้าม
//
// 🆕 หัวใจ: thaiSortKey(text) คืน "กุญแจเรียง" เป็น string ที่เทียบแบบ binary ธรรมดาได้
//   - ฝั่งเซิร์ฟเวอร์เก็บกุญแจนี้ไว้ในเพลงทุกเพลง (ฟิลด์ sort_key) แล้วให้ฐานข้อมูล ORDER BY + แบ่งหน้าเอง
//     → เพลง 10,000+ เพลงก็เรียงครบทุกหน้าโดยไม่ต้องโหลดทั้งหมดมาเรียงในเครื่อง
//   - ฝั่งเบราว์เซอร์ใช้ฟังก์ชันเดียวกัน → ลำดับตรงกับเซิร์ฟเวอร์ 100%
//   ⚠️ ถ้าแก้อัลกอริทึมในไฟล์นี้ ต้องรัน backfill ใหม่ (แอดมินเปิดหน้าแอดมินแล้วระบบทำให้เอง — ดู worker /api/admin/backfill-sort-keys)
export const SORT_KEY_VERSION = 1;

// ลำดับพยัญชนะไทย ก-ฮ
const THAI_ORDER = "กขฃคฅฆงจฉชซฌญฎฏฐฑฒณดตถทธนบปผฝพฟภมยรลฦวศษสหฬอฮ";
const THAI_RANK = {};
for (let i = 0; i < THAI_ORDER.length; i++) THAI_RANK[THAI_ORDER[i]] = i;

// แปลง 1 ตัวอักษรเป็นอักขระ "ลำดับ" (ช่วงรหัสแยกกลุ่ม: ไทย < อังกฤษ < ตัวเลข < อื่น ๆ)
function charKey(ch) {
  const r = THAI_RANK[ch];
  if (r !== undefined) return String.fromCharCode(0x100 + r);              // พยัญชนะไทย
  const up = ch.toUpperCase();
  if (up >= "A" && up <= "Z") return String.fromCharCode(0x200 + up.charCodeAt(0) - 65); // A-Z
  const cp = ch.codePointAt(0);
  if (cp >= 0x0E00 && cp <= 0x0E7F) return String.fromCharCode(0x400 + (cp - 0x0E00));  // สระ/วรรณยุกต์ไทย
  return String.fromCharCode(0x500 + (cp & 0x7FFF));                       // อื่น ๆ
}

// ตัวเลขทั้งก้อน → มาร์กเกอร์ + ความยาว + ตัวเลข (ทำให้ 2 < 10 < 100 เมื่อเทียบเป็น string)
function numberKey(digits) {
  const d = digits.replace(/^0+(?=\d)/, "");
  return "\u0300" + String(Math.min(d.length, 999)).padStart(3, "0") + d;
}

function encode(str) {
  let out = "";
  const chunks = str.match(/\d+|\D/g) || [];
  for (const c of chunks) out += /^\d+$/.test(c) ? numberKey(c) : charKey(c);
  return out;
}

function prepare(v) {
  const full = String(v == null ? "" : v).normalize("NFC").trim().slice(0, 200)
    .replace(/^[^\u0E00-\u0E7FA-Za-z0-9]+/, "");           // ตัดช่องว่าง/สัญลักษณ์หน้าคำ
  const primary = full
    .replace(/^[เแโใไ]+/, "")                              // ข้ามสระนำ
    .replace(/[\u0E48-\u0E4C]/g, "");                       // ไม้เอก-จัตวา/การันต์ ไม่นับรอบแรก
  return { full, primary };
}

const KEY_CACHE = new Map();

export function thaiSortKey(text) {
  const raw = text == null ? "" : String(text);
  const hit = KEY_CACHE.get(raw);
  if (hit !== undefined) return hit;
  const { full, primary } = prepare(raw);
  const key = encode(primary) + "\u0001" + encode(full);
  if (KEY_CACHE.size > 60000) KEY_CACHE.clear();
  KEY_CACHE.set(raw, key);
  return key;
}

// เปรียบเทียบ 2 ค่า: ก-ฮ > A-Z > 0-9
export function thaiNaturalCompare(a, b) {
  const ka = thaiSortKey(a);
  const kb = thaiSortKey(b);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

// เรียง array ของ object ตามฟิลด์ — คืน array ใหม่เสมอ (ชื่อเหมือนกัน → เรียงตาม id เพื่อให้ตรงกับเซิร์ฟเวอร์)
export function sortByThaiName(list, field) {
  return [...(list || [])].sort((a, b) => {
    const c = thaiNaturalCompare(a && a[field], b && b[field]);
    if (c !== 0) return c;
    const ia = String((a && a.id) ?? "");
    const ib = String((b && b.id) ?? "");
    return ia < ib ? -1 : ia > ib ? 1 : 0;
  });
}

// เรียงเพลงด้วย song_name — direction "asc" | "desc"
export function sortSongsByThaiName(songs, direction = "asc") {
  const sorted = sortByThaiName(songs, "song_name");
  return direction === "desc" ? sorted.reverse() : sorted;
}
