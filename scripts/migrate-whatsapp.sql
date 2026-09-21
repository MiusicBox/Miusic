-- ============================================================
-- Migration: Normalize whatsapp field in orders collection
-- ============================================================
-- วัตถุประสงค์: แปลง whatsapp field ของทุก order ให้อยู่ในรูปแบบ normalized
--   "20XXXXXXXX" (ลบ +, ลด 856 country code, ลด leading 0 ออก)
--
-- หลังรันเสร็จ: ทุก order ใน DB จะมี whatsapp field เป็น "20XXXXXXXX"
--   → worker/index.js _customer-list สามารถใช้ query เดียว (1 D1 read)
--   แทนการ query 4 รูปแบบ (4 D1 reads) → ประหยัด D1 quota 4 เท่า
--
-- ============================================================
-- ⚠️ คำเตือนสำคัญ:
-- ============================================================
-- 1. ทำ BACKUP ก่อนรัน! ใช้คำสั่ง:
--      wrangler d1 export miusic-store-db --output=backup-before-migrate.sql
--    หรือ Cloudflare Dashboard → D1 → เลือก DB → Backup
--
-- 2. รันใน staging ก่อน (ถ้ามี) เพื่อทดสอบ
--
-- 3. รันครั้งเดียวเท่านั้น — รันซ้ำไม่มีผลเสีย (idempotent) แต่เปลืองเวลา
--
-- 4. ตรวจสอบผลลัพธ์ด้วย verification query ท้ายไฟล์ก่อนปิด session
--
-- 5. หลัง migration เสร็จ + verify ผ่าน → จึง deploy worker ใหม่ที่ใช้ 1 query
--    (ไฟล์ worker/index.js ที่แก้แล้ว)
--
-- วิธีรัน:
--   wrangler d1 execute miusic-store-db --file=/home/z/my-project/scripts/migrate-whatsapp.sql
--
-- หรือถ้ารันบน Windows ใช้ path:
--   wrangler d1 execute miusic-store-db --file=scripts\migrate-whatsapp.sql
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- Step 1: ลบตัว "+" ออกจาก whatsapp field (ถ้ามี)
-- ────────────────────────────────────────────────────────────
-- ตัวอย่าง: "+8562012345678" → "8562012345678"
UPDATE documents
SET data = json_set(data, '$.whatsapp',
  REPLACE(json_extract(data, '$.whatsapp'), '+', '')
)
WHERE collection = 'orders'
  AND json_extract(data, '$.whatsapp') IS NOT NULL
  AND json_extract(data, '$.whatsapp') LIKE '%+%';

-- ────────────────────────────────────────────────────────────
-- Step 2: ลด "856" prefix ออก (Laos country code)
-- ────────────────────────────────────────────────────────────
-- ตัวอย่าง: "8562012345678" → "2012345678"
-- ⚠️ รันหลัง Step 1 เสร็จ — ไม่งั้ "+" ยังอยู่ ทำให้ LIKE '856%' ไม่ match
UPDATE documents
SET data = json_set(data, '$.whatsapp',
  substr(json_extract(data, '$.whatsapp'), 4)
)
WHERE collection = 'orders'
  AND json_extract(data, '$.whatsapp') IS NOT NULL
  AND json_extract(data, '$.whatsapp') LIKE '856%';

-- ────────────────────────────────────────────────────────────
-- Step 3: ลด leading "0" ออก (เบอร์ local format)
-- ────────────────────────────────────────────────────────────
-- ตัวอย่าง: "02012345678" → "2012345678"
-- ⚠️ รันหลัง Step 2 เสร็จ — ไม่งั้ "0856..." จะถูกลด 0 ออกกลายเป็น "856..."
--    แล้ว Step 2 จะไม่ได้รันซ้ำ (idempotent แต่ลำดับสำคัญ)
UPDATE documents
SET data = json_set(data, '$.whatsapp',
  substr(json_extract(data, '$.whatsapp'), 2)
)
WHERE collection = 'orders'
  AND json_extract(data, '$.whatsapp') IS NOT NULL
  AND json_extract(data, '$.whatsapp') LIKE '0%'
  AND length(json_extract(data, '$.whatsapp')) > 1;

-- ============================================================
-- Verification: ตรวจสอบผลลัพธ์หลังรัน migration
-- ============================================================
-- ควรเห็น: ทุก whatsapp field เริ่มต้นด้วยตัวเลข 2-9 (ไม่ใช่ 0, 856, หรือ +)
-- ถ้ามี whatsapp ที่ขึ้นต้นด้วย 0, 856, หรือ + แปลว่า migration ยังไม่สมบูรณ์
SELECT
  CASE
    WHEN json_extract(data, '$.whatsapp') IS NULL THEN 'NULL'
    WHEN json_extract(data, '$.whatsapp') LIKE '+%' THEN '❌ ยังมี + อยู่'
    WHEN json_extract(data, '$.whatsapp') LIKE '856%' THEN '❌ ยังมี 856 อยู่'
    WHEN json_extract(data, '$.whatsapp') LIKE '0%' THEN '❌ ยังมี 0 นำหน้า'
    ELSE '✅ normalized ถูกต้อง'
  END AS status,
  COUNT(*) AS count
FROM documents
WHERE collection = 'orders'
GROUP BY status
ORDER BY count DESC;

-- ============================================================
-- ตัวอย่างผลลัพธ์ที่คาดหวัง:
-- ============================================================
-- ✅ normalized ถูกต้อง | 1234
-- (ถ้ามีแค่บรรทัดนี้ = migration สำเร็จ)
-- ============================================================

-- ============================================================
-- (Optional) ดูตัวอย่าง 5 orders แรกเพื่อยืนยันด้วยตา
-- ============================================================
SELECT
  id,
  json_extract(data, '$.customer_name') AS customer_name,
  json_extract(data, '$.whatsapp') AS whatsapp_normalized,
  json_extract(data, '$.receipt_number') AS receipt_number,
  json_extract(data, '$.created_at') AS created_at
FROM documents
WHERE collection = 'orders'
ORDER BY json_extract(data, '$.created_at') DESC
LIMIT 5;
