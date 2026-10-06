-- 🐛 (DJ-Fix): normalize dj_name ใน songs
--   ปัญหา: มี DJ name หลายรูปแบบผิด ๆ:
--     - "ท้ายดอกแก้ว" (พิมพ์ผิด — ควรเป็น "ท้ายดอนแก้ว")
--     - "DJ:ท้ายดอกแก้ว" (มี prefix + พิมพ์ผิด)
--     - "" (ว่าง)
--   วิธีแก้: update dj_name ใน documents ที่ collection='songs'
--   ผลกระทบ: เฉพาะ songs — ไม่แตะ orders/categories/djs/playlists
--   วิธีรัน: wrangler d1 execute miusic-store-db --remote --file=scripts/migrate-dj-name-normalize.sql

-- 1. แก้ "ท้ายดอกแก้ว" → "ท้ายดอนแก้ว" (พิมพ์ผิด ก → น)
UPDATE documents
SET data = json_set(data, '$.dj_name', 'ท้ายดอนแก้ว'),
    updated_at = datetime('now')
WHERE collection = 'songs'
  AND json_extract(data, '$.dj_name') = 'ท้ายดอกแก้ว';

-- 2. แก้ "DJ:ท้ายดอกแก้ว" → "ท้ายดอนแก้ว" (ลบ prefix + พิมพ์ผิด)
UPDATE documents
SET data = json_set(data, '$.dj_name', 'ท้ายดอนแก้ว'),
    updated_at = datetime('now')
WHERE collection = 'songs'
  AND json_extract(data, '$.dj_name') = 'DJ:ท้ายดอกแก้ว';

-- 3. แก้ "DJ:ท้ายดอนแก้ว" → "ท้ายดอนแก้ว" (ลบ prefix เฉพาะ)
UPDATE documents
SET data = json_set(data, '$.dj_name', 'ท้ายดอนแก้ว'),
    updated_at = datetime('now')
WHERE collection = 'songs'
  AND json_extract(data, '$.dj_name') = 'DJ:ท้ายดอนแก้ว';

-- 4. ตรวจสอบผล
SELECT json_extract(data, '$.dj_name') AS dj_name, COUNT(*) AS count
FROM documents
WHERE collection = 'songs'
GROUP BY dj_name
ORDER BY count DESC;


-- 5. แก้เพลงที่ไม่มี dj_name — extract จาก song_name ถ้ามี "ท้ายดอนแก้ว" หรือ "ท้ายดอกแก้ว"
UPDATE documents
SET data = json_set(data, '$.dj_name', 'ท้ายดอนแก้ว'),
    updated_at = datetime('now')
WHERE collection = 'songs'
  AND (json_extract(data, '$.dj_name') IS NULL OR json_extract(data, '$.dj_name') = '')
  AND (json_extract(data, '$.song_name') LIKE '%ท้ายดอนแก้ว%' OR json_extract(data, '$.song_name') LIKE '%ท้ายดอกแก้ว%');

-- 6. ตรวจสอบผลอีกครั้ง
SELECT json_extract(data, '$.dj_name') AS dj_name, COUNT(*) AS count
FROM documents
WHERE collection = 'songs'
GROUP BY dj_name
ORDER BY count DESC;
