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
-- รันทีละ statement (D1 Console ไม่รองรับหลาย statements)
-- ============================================================

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
