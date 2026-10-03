// worker/order-scope.js
// ===================================================
// 🆕 (2026-10-03 v10 — แยก Login / Guest อย่างชัดเจน)
//
// กติกา (ตัดสินที่ Server เท่านั้น — ไม่เชื่อค่า "ฉันคือ login/guest" ที่ client ส่งมา):
//   - ออเดอร์ของลูกค้า Login → มี customer_id (Worker ตั้งจาก session cookie ตอนสร้างออเดอร์)
//   - ออเดอร์ของ Guest       → ไม่มี customer_id แต่มี guest_id (UUID v4 ที่ browser สร้างเอง)
//   - ออเดอร์เก่าก่อน v10     → ไม่มี customer_id และไม่มี guest_id ("legacy guest")
//
//   Login list : เจอเฉพาะออเดอร์ที่ customer_id === session.customer.id (ไม่ดู WhatsApp เลย)
//   Guest list : ต้องไม่มี customer_id + guest_id ตรงกับของ browser นี้ (+ WhatsApp ตรง ซึ่งเช็คที่ caller)
//   WhatsApp อย่างเดียว ไม่เคยเพียงพอที่จะดึงออเดอร์
//
// ไฟล์นี้เป็น pure function (ไม่มี dependency) เพื่อให้เทสด้วย Node ได้โดยไม่ต้องมี D1
// ===================================================

// ออเดอร์เก่า (ไม่มี guest_id) ยังให้ Guest ค้นด้วย ชื่อ(ตรงเป๊ะ)+เบอร์ ได้เหมือนเดิมหรือไม่
//   true  = ไม่ทำให้ลูกค้า Guest เดิมมองไม่เห็นประวัติเก่า (ค่าเริ่มต้น — ไม่ทำระบบเดิมพัง)
//   false = ออเดอร์เก่าที่ไม่มี guest_id จะค้นผ่านรายการไม่ได้อีก (เข้มสุด) — ยังเปิดทีละใบด้วยเลขใบเสร็จได้
// ⚠️ ไม่กระทบออเดอร์ที่มี customer_id เลย (ออเดอร์ Login ไม่มีวันหลุดเข้า Guest list)
export const ALLOW_LEGACY_GUEST_ORDERS = true;

const GUEST_ID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// คืน guest_id (lowercase) ถ้ารูปแบบเป็น UUID v4 ที่ถูกต้อง ไม่งั้นคืน "" (ถือว่าไม่มี)
export function normalizeGuestId(v) {
  const s = String(v == null ? "" : v).trim().toLowerCase();
  return GUEST_ID_REGEX.test(s) ? s : "";
}

// ออเดอร์นี้เป็นของลูกค้า Login หรือไม่ (ดูจาก customer_id ที่ Server ตั้งเท่านั้น)
export function isLoginOrder(orderData) {
  return !!(orderData && orderData.customer_id);
}

// Login list: เฉพาะออเดอร์ที่ผูกกับ customer_id นี้เท่านั้น
export function isOrderInLoginList(orderData, customerId) {
  if (!customerId) return false;
  return !!orderData && orderData.customer_id === customerId;
}

// Guest list: (เบอร์ WhatsApp ให้ caller เช็คเอง) — ตรงนี้เช็คเฉพาะ "เป็นของ guest คนนี้ไหม"
//   - มี customer_id → ไม่ใช่ของ Guest เด็ดขาด
//   - มี guest_id    → ต้องตรงกับ guest_id ของ browser ที่ถามมา
//   - ไม่มี guest_id → ออเดอร์เก่า: อนุญาตเฉพาะเมื่อ ALLOW_LEGACY_GUEST_ORDERS และชื่อตรงเป๊ะ
export function isOrderInGuestList(orderData, { guestId, queryName, normalizeName, allowLegacy = ALLOW_LEGACY_GUEST_ORDERS } = {}) {
  if (!orderData) return false;
  if (isLoginOrder(orderData)) return false;
  const orderGuestId = normalizeGuestId(orderData.guest_id);
  if (orderGuestId) {
    return !!guestId && orderGuestId === normalizeGuestId(guestId);
  }
  if (!allowLegacy) return false;
  const oName = typeof normalizeName === "function" ? normalizeName(orderData.customer_name || "") : "";
  if (!oName || !queryName) return false;
  return oName === queryName;
}

// เปิดออเดอร์ทีละใบด้วย receipt_number + ชื่อ + เบอร์ (_customer-query)
//   - ออเดอร์ Login → เห็นได้เฉพาะเจ้าของที่ login อยู่ (session ตรง customer_id)
//   - ออเดอร์ Guest → เห็นได้เฉพาะตอนที่ "ไม่ได้ login" (คน login ต้องไม่เห็นออเดอร์ guest)
//   (guest ไม่ต้องมี guest_id ตรงกัน เพื่อให้เปิดใบเสร็จข้ามเครื่องด้วยเลขใบเสร็จได้เหมือนเดิม)
export function isOrderVisibleForReceiptLookup(orderData, sessionCustomerId) {
  if (!orderData) return false;
  if (isLoginOrder(orderData)) {
    return !!sessionCustomerId && orderData.customer_id === sessionCustomerId;
  }
  return !sessionCustomerId;
}
