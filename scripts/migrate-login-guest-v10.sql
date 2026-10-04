-- scripts/migrate-login-guest-v10.sql
-- ===================================================
-- 🆕 (2026-10-03 v10) แยกระบบค้นหา/ประวัติ Order ของ Login กับ Guest
--
-- ต้องรันไหม?  ไม่บังคับ — ระบบทำงานได้แม้ไม่รัน (แค่ query ลูกค้า Login จะช้าลงเมื่อมีออเดอร์เยอะ)
--   แนะนำให้รัน 1 ครั้งใน D1 Console หลัง deploy
--
-- ทำอะไร: สร้าง index สำหรับดึงออเดอร์ด้วย customer_id (ไม่แก้ไข/ลบข้อมูลเดิมใด ๆ — รันซ้ำได้ปลอดภัย)
-- ไม่ต้อง migrate ข้อมูลเก่า:
--   - ออเดอร์ Login เดิมมี customer_id อยู่แล้ว → เห็นในบัญชีเหมือนเดิม
--   - ออเดอร์ Guest เดิม (ไม่มี guest_id) → ยังค้นด้วย ชื่อตรงเป๊ะ + เบอร์ ได้ ตราบที่
--     ALLOW_LEGACY_GUEST_ORDERS = true ใน worker/order-scope.js (ตั้งเป็น false เมื่อพร้อมปิดทางเก่า)
-- ===================================================

CREATE INDEX IF NOT EXISTS idx_documents_orders_customer_id
  ON documents(json_extract(data, '$.customer_id'))
  WHERE collection = 'orders';

-- ตรวจผล (ไม่บังคับ): ดูสัดส่วนออเดอร์ Login / Guest ใหม่ / Guest เก่า
-- SELECT
--   SUM(CASE WHEN json_extract(data,'$.customer_id') IS NOT NULL THEN 1 ELSE 0 END) AS login_orders,
--   SUM(CASE WHEN json_extract(data,'$.customer_id') IS NULL AND json_extract(data,'$.guest_id') IS NOT NULL THEN 1 ELSE 0 END) AS guest_orders_with_guest_id,
--   SUM(CASE WHEN json_extract(data,'$.customer_id') IS NULL AND json_extract(data,'$.guest_id') IS NULL THEN 1 ELSE 0 END) AS legacy_guest_orders
-- FROM documents WHERE collection = 'orders';
