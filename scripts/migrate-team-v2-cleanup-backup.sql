-- ============================================================
-- Migration (team-24h-v2): Cleanup backup table — คืนพื้นที่ D1
-- ============================================================
-- วัตถุประสงค์: DROP table documents_backup_whatsapp_v2 (ที่สร้างโดย migrate-whatsapp-v2-safe.sql Step 0)
--   เพื่อคืนพื้นที่ D1 storage (Free plan จำกัด 5GB)
--
-- ที่มา:
--   scripts/migrate-whatsapp-v2-safe.sql Step 0 สร้าง backup table ก่อน migration normalize whatsapp
--   หลัง migration ผ่าน verification แล้ว → backup table ไม่จำเป็น → ควร DROP เพื่อคืนพื้นที่
--   (ใน migrate-whatsapp-v2-safe.sql Step 6 มี DROP แบบ comment ไว้ — script นี้เป็น standalone
--    เพื่อให้ run แยกต่างหากได้ และเก็บประวัติการ cleanup ชัดเจน)
--
-- ⚠️ ข้อควรระวัง:
--   - รัน script นี้ก็ต่อเมื่อ migration whatsapp verification (Step 5 ใน migrate-whatsapp-v2-safe.sql) ผ่านเท่านั้น
--   - หลัง DROP แล้วจะ rollback migration whatsapp ไม่ได้อีก (Step 7 ใช้ backup ไม่ได้)
--   - ถ้ายังไม่มั่นใจ → ห้ามรัน script นี้ → เก็บ backup ไว้สักพัก
--
-- ผลกระทบระบบเดิม: 0% — เป็น DROP TABLE IF EXISTS (idempotent)
--   ถ้ารันซ้ำ → no-op (SQLite จะข้ามไปเพราะ IF EXISTS)
--
-- D1 Free Plan benefit:
--   - คืนพื้นที่ storage ≈ ขนาดของ documents WHERE collection='orders' ทั้งหมด
--   - ลด rows_read เวลา SELECT * FROM documents (ไม่มี backup rows ปนเข้ามา)
--
-- ============================================================
-- วิธีรัน (D1 Console):
--   1. เข้า Cloudflare Dashboard → Workers & Pages → เลือก Worker (Miusic)
--   2. แท็บ "D1" → เลือก database → ปุ่ม "Console"
--   3. รัน verification query ก่อน (ด้านล่าง) เพื่อยืนยันว่า migration whatsapp ผ่านแล้ว
--   4. ถ้า verification ผ่าน → copy DROP TABLE statement (ทีละบรรทัด — D1 Console ไม่รองรับหลาย statements)
--   5. วางในช่อง "Execute SQL" → กด "Execute"
--
--   หรือใช้ wrangler CLI:
--     wrangler d1 execute <DB_NAME> --remote --file=scripts/migrate-team-v2-cleanup-backup.sql
-- ============================================================

-- ============================================================
-- Pre-check: ตรวจสอบว่า migration whatsapp verification ผ่านหรือไม่
-- ============================================================
-- ควรเห็น: ทุก whatsapp field ขึ้นต้นด้วย 856 หรือ 66 (ไม่มี '❌ MISSING_COUNTRY_CODE')
--   ถ้ามี '❌ MISSING_COUNTRY_CODE' → หยุด + รัน rollback (Step 7 ใน migrate-whatsapp-v2-safe.sql) ก่อน
SELECT
  CASE
    WHEN json_extract(data, '$.whatsapp') IS NULL THEN 'NULL'
    WHEN json_extract(data, '$.whatsapp') LIKE '856%' THEN '✅ Laos (856)'
    WHEN json_extract(data, '$.whatsapp') LIKE '66%' THEN '✅ Thai (66)'
    ELSE '❌ MISSING_COUNTRY_CODE'
  END AS status,
  COUNT(*) AS count
FROM documents
WHERE collection = 'orders'
GROUP BY status
ORDER BY count DESC;

-- ============================================================
-- ขนาด backup table ก่อน DROP (เพื่อประเมินพื้นที่ที่จะคืน)
-- ============================================================
SELECT
  (SELECT COUNT(*) FROM documents_backup_whatsapp_v2) AS backup_row_count,
  (SELECT COUNT(*) FROM documents WHERE collection='orders') AS current_orders_count;

-- ============================================================
-- DROP backup table — รันหลังจาก migration whatsapp verification ผ่านเท่านั้น!
-- ============================================================
-- ⚠️ หลัง DROP นี้ → ไม่สามารถ rollback migration whatsapp ได้อีก (Step 7 ใช้ backup ไม่ได้)
DROP TABLE IF EXISTS documents_backup_whatsapp_v2;

-- Verification หลัง DROP — ควร return 0 rows (table ไม่มีแล้ว)
SELECT name FROM sqlite_master
WHERE type = 'table'
  AND name = 'documents_backup_whatsapp_v2';
