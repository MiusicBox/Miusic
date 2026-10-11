-- ============================================================
-- Migration v2: Normalize whatsapp field — SAFE version
-- ============================================================
-- ปัญหา: migration เดิม (migrate-whatsapp.sql) strip 856 จากทุกออเดอร์
--   → ทำลายออเดอร์ใหม่ที่เก็บ WITH country code แล้ว
--
-- Migration ใหม่นี้ SAFE:
--   1. ข้ามออเดอร์ที่มี country code แล้ว (856* หรือ 66*) → ไม่แตะ
--   2. ตรวจเบอร์ที่ไม่มี country code → เพิ่ม 856 หรือ 66 ตามรูปแบบ
--   3. มี verification query ท้ายไฟล์
--
-- 🔒 (Audit Fix H-38): PRE-MIGRATION BACKUP — กัน data loss
--   ปัญหาเดิม: migration เขียนทับ whatsapp field โดยไม่มี backup
--   → ถ้า migration พัง (syntax error, ลำดับผิด, edge case) → whatsapp ผิด → ลูกค้า track order ไม่เจอ
--   → ไม่สามารถ rollback ได้ (ไม่มีค่าเดิม)
--   วิธีแก้: สร้าง backup table ก่อน migration → ถ้าพัง → restore จาก backup
--   ผลกระทบระบบเดิม: 0% — เป็น SQL statements เพิ่มเติมที่จุดเริ่มต้น
--
-- วิธีใช้:
--   1. รัน Step 0 (backup) ก่อน
--   2. ตรวจดู backup row count: SELECT COUNT(*) FROM documents_backup_whatsapp_v2;
--      ต้องเท่ากับ SELECT COUNT(*) FROM documents WHERE collection='orders';
--   3. รัน Step 1-4 (migration)
--   4. รัน Step 5 (verification)
--   5. ถ้า verification ผ่าน → รัน Step 6 (drop backup)
--   6. ถ้า verification ไม่ผ่าน → รัน Step 7 (rollback) + รายงานปัญหา
--
-- รันทีละ statement (D1 Console ไม่รองรับหลาย statements)
-- ============================================================

-- Step 0 (NEW): สร้าง backup table ก่อน migration
--   เก็บ snapshot ของ orders documents ทั้งหมดก่อนแก้ whatsapp
--   ถ้า migration พัง → restore จากตารางนี้
CREATE TABLE IF NOT EXISTS documents_backup_whatsapp_v2 AS
SELECT collection, id, data, created_at, updated_at
FROM documents
WHERE collection = 'orders';

-- ตรวจสอบ row count หลังสร้าง backup
--   ควรเท่ากับจำนวน orders ทั้งหมด
--   ถ้าไม่เท่า → หยุด + รายงาน (backup ไม่สมบูรณ์)
SELECT
  (SELECT COUNT(*) FROM documents_backup_whatsapp_v2) AS backup_count,
  (SELECT COUNT(*) FROM documents WHERE collection='orders') AS orders_count,
  CASE
    WHEN (SELECT COUNT(*) FROM documents_backup_whatsapp_v2) = (SELECT COUNT(*) FROM documents WHERE collection='orders')
    THEN '✅ Backup OK — proceed with migration'
    ELSE '❌ Backup count mismatch — DO NOT proceed'
  END AS status;

-- Step 1: เพิ่ม country code 856 ให้ออเดอร์ลาวที่ยังไม่มี country code
--   เงื่อนไข: whatsapp ไม่ขึ้นต้นด้วย 856 และ 66 และขึ้นต้นด้วย 2 (Laos local)
UPDATE documents
SET data = json_set(data, '$.whatsapp', '856' || json_extract(data, '$.whatsapp'))
WHERE collection = 'orders'
  AND json_extract(data, '$.whatsapp') IS NOT NULL
  AND json_extract(data, '$.whatsapp') NOT LIKE '856%'
  AND json_extract(data, '$.whatsapp') NOT LIKE '66%'
  AND json_extract(data, '$.whatsapp') LIKE '2%';

-- Step 2: เพิ่ม country code 66 ให้ออเดอร์ไทยที่ยังไม่มี country code
--   เงื่อนไข: whatsapp ไม่ขึ้นต้นด้วย 856 และ 66 และขึ้นต้นด้วย 8 หรือ 9 (Thai local, 9 หลัก)
UPDATE documents
SET data = json_set(data, '$.whatsapp', '66' || json_extract(data, '$.whatsapp'))
WHERE collection = 'orders'
  AND json_extract(data, '$.whatsapp') IS NOT NULL
  AND json_extract(data, '$.whatsapp') NOT LIKE '856%'
  AND json_extract(data, '$.whatsapp') NOT LIKE '66%'
  AND (json_extract(data, '$.whatsapp') LIKE '8%' OR json_extract(data, '$.whatsapp') LIKE '9%')
  AND length(json_extract(data, '$.whatsapp')) = 9;

-- Step 3: เพิ่ม country code 856 ให้เบอร์ที่ขึ้นต้นด้วย 0 (strip 0 ก่อนแล้วเติม 856)
--   เงื่อนไข: whatsapp ขึ้นต้นด้วย 0 และไม่ขึ้นต้นด้วย 08 หรือ 09 (เพราะ 08/09 = ไทย)
UPDATE documents
SET data = json_set(data, '$.whatsapp', '856' || substr(json_extract(data, '$.whatsapp'), 2))
WHERE collection = 'orders'
  AND json_extract(data, '$.whatsapp') IS NOT NULL
  AND json_extract(data, '$.whatsapp') NOT LIKE '856%'
  AND json_extract(data, '$.whatsapp') NOT LIKE '66%'
  AND json_extract(data, '$.whatsapp') LIKE '0%'
  AND json_extract(data, '$.whatsapp') NOT LIKE '08%'
  AND json_extract(data, '$.whatsapp') NOT LIKE '09%';

-- Step 4: เพิ่ม country code 66 ให้เบอร์ไทยที่ขึ้นต้นด้วย 08 หรือ 09 (strip 0 ก่อนแล้วเติม 66)
UPDATE documents
SET data = json_set(data, '$.whatsapp', '66' || substr(json_extract(data, '$.whatsapp'), 2))
WHERE collection = 'orders'
  AND json_extract(data, '$.whatsapp') IS NOT NULL
  AND json_extract(data, '$.whatsapp') NOT LIKE '856%'
  AND json_extract(data, '$.whatsapp') NOT LIKE '66%'
  AND (json_extract(data, '$.whatsapp') LIKE '08%' OR json_extract(data, '$.whatsapp') LIKE '09%');

-- ============================================================
-- Verification: ตรวจสอบผลลัพธ์หลังรัน migration
-- ============================================================
-- ควรเห็น: ทุก whatsapp field ขึ้นต้นด้วย 856 หรือ 66
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
-- 🔒 (Audit Fix H-38): Step 6 — DROP backup (รันหลัง verification ผ่านเท่านั้น)
-- ============================================================
-- ⚠️ รัน Step 6 นี้ก็ต่อเมื่อ verification ผ่านทั้งหมดเท่านั้น
--   ถ้ามี '❌ MISSING_COUNTRY_CODE' → หยุด + รัน Step 7 (rollback)
-- DROP TABLE IF EXISTS documents_backup_whatsapp_v2;

-- ============================================================
-- 🔒 (Audit Fix H-38): Step 7 — ROLLBACK (รันถ้า migration พัง)
-- ============================================================
-- ⚠️ รัน Step 7 นี้ถ้า verification ไม่ผ่าน (พบ '❌ MISSING_COUNTRY_CODE' หรือ error อื่น)
--   restore orders documents จาก backup → กลับไปใช้ค่าเดิม
--   หลัง rollback → ตรวจสอบอีกครั้ง + รายงานปัญหา + อย่าลบ backup
-- UPDATE documents
-- SET data = (SELECT data FROM documents_backup_whatsapp_v2 b WHERE b.collection = documents.collection AND b.id = documents.id)
-- WHERE collection = 'orders'
--   AND EXISTS (SELECT 1 FROM documents_backup_whatsapp_v2 b WHERE b.collection = documents.collection AND b.id = documents.id);

