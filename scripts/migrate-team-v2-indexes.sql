-- ============================================================
-- Migration (team-24h-v2): เพิ่ม indexes สำหรับ query ที่ใช้บ่อย
-- ============================================================
-- วัตถุประสงค์: สร้าง indexes 3 ตัวบนตาราง documents (collection='orders')
--   เพื่อเร่ง query ที่ใช้บ่อยใน worker/index.js — สำหรับ DB ที่มีอยู่แล้ว
--   (DB ที่สร้างใหม่จะได้ indexes นี้จาก worker/schema.sql อัตโนมัติ)
--
-- Indexes ที่สร้าง:
--   1. idx_documents_orders_customer_id_created
--        (json_extract(data,'$.customer_id'), created_at) WHERE collection='orders'
--        → ใช้ใน customer order list (worker/index.js:5293)
--          "SELECT id, data, created_at FROM documents
--           WHERE collection='orders' AND json_extract(data,'$.customer_id')=?
--           ORDER BY created_at DESC LIMIT 200"
--
--   2. idx_documents_orders_zip_status
--        (json_extract(data,'$.zip_status')) WHERE collection='orders'
--        → ใช้ใน cron cleanup scan (worker/index.js:6795)
--          filter "json_extract(data,'$.zip_status') = 'ready'"
--
--   3. idx_documents_orders_zip_created_at
--        (json_extract(data,'$.zip_created_at')) WHERE collection='orders'
--        → ใช้ใน cron cleanup range filter (worker/index.js:6796-6798)
--          filter "json_extract(data,'$.zip_created_at') IS NOT NULL
--                  AND json_extract(data,'$.zip_created_at') < ?"
--
-- ผลกระทบระบบเดิม: 0% — เป็น CREATE INDEX IF NOT EXISTS (idempotent)
--   ถ้ารันซ้ำ → no-op (SQLite จะข้ามไป)
--
-- D1 Free Plan considerations:
--   - Indexes ช่วยลด rows_read (ลดค่าใช้จ่าย 5M rows read/day)
--   - Indexes ใช้ storage เพิ่มเล็กน้อย (ยังอยู่ใน limit 5GB)
--   - Write ช้าลงเล็กน้อยตอน INSERT/UPDATE orders (ยังอยู่ใน limit 100k rows written/day)
--
-- ============================================================
-- วิธีรัน (D1 Console):
--   1. เข้า Cloudflare Dashboard → Workers & Pages → เลือก Worker (Miusic)
--   2. แท็บ "D1" → เลือก database → ปุ่ม "Console"
--   3. copy แต่ละ CREATE INDEX statement (ทีละบรรทัด — D1 Console ไม่รองรับหลาย statements)
--   4. วางในช่อง "Execute SQL" → กด "Execute"
--   5. ทำซ้ำจนครบ 3 indexes
--
--   หรือใช้ wrangler CLI:
--     wrangler d1 execute <DB_NAME> --remote --file=scripts/migrate-team-v2-indexes.sql
--
-- Verification หลังรัน:
--   SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_documents_orders_%';
--   → ควรเห็น 3 rows:
--     - idx_documents_orders_customer_id_created
--     - idx_documents_orders_zip_status
--     - idx_documents_orders_zip_created_at
-- ============================================================

-- Index 1: customer_id + created_at — ใช้ใน customer order list (worker/index.js:5293)
CREATE INDEX IF NOT EXISTS idx_documents_orders_customer_id_created
  ON documents (json_extract(data, '$.customer_id'), created_at)
  WHERE collection = 'orders';

-- Index 2: zip_status — ใช้ใน cron cleanup scan (worker/index.js:6795)
CREATE INDEX IF NOT EXISTS idx_documents_orders_zip_status
  ON documents (json_extract(data, '$.zip_status'))
  WHERE collection = 'orders';

-- Index 3: zip_created_at — ใช้ใน cron cleanup range filter (worker/index.js:6796-6798)
CREATE INDEX IF NOT EXISTS idx_documents_orders_zip_created_at
  ON documents (json_extract(data, '$.zip_created_at'))
  WHERE collection = 'orders';

-- Verification query — รันหลังสร้าง indexes ทั้ง 3 เพื่อยืนยันว่าสร้างสำเร็จ
SELECT name FROM sqlite_master
WHERE type = 'index'
  AND name IN (
    'idx_documents_orders_customer_id_created',
    'idx_documents_orders_zip_status',
    'idx_documents_orders_zip_created_at'
  )
ORDER BY name;
