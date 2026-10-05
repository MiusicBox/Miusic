-- ===================================================
-- 🆕 (T015): Migration — Indexes สำหรับ advanced song search
--   วัตถุประสงค์: รองรับ /api/db/songs/_advanced-search ที่จะใช้กับ 10,000+ เพลง
--   สร้าง indexes ใหม่ 2 ตัว:
--     1. idx_documents_songs_price — สำหรับ filter ช่วงราคา + sort ตามราคา
--     2. idx_documents_songs_created_at — สำหรับ sort ใหม่ล่าสุด/เก่าสุด
--
--   ผลกระทบระบบเดิม: 0%
--     - ทุก index ใช้ IF NOT EXISTS → รันซ้ำได้
--     - ไม่ลบข้อมูล ไม่เปลี่ยน schema
--     - ใช้ expression index บน json_extract (รองรับโดย D1/SQLite)
--
--   วิธีรัน:
--     wrangler d1 execute miusic-store-db --remote --file=scripts/migrate-t015-indexes.sql
--     (หรือ --local สำหรับ local testing)
-- ===================================================

-- Index 1: สำหรับ filter ช่วงราคา (price_min / price_max)
--   ใช้ใน WHERE CAST(json_extract(data, '$.price') AS REAL) >= ? AND ... <= ?
--   Expression index ใช้ CAST ให้ตรงกับ query เพื่อให้ D1 ใช้ index ได้
CREATE INDEX IF NOT EXISTS idx_documents_songs_price
  ON documents(CAST(json_extract(data, '$.price') AS REAL))
  WHERE collection = 'songs';

-- Index 2: สำหรับ sort ใหม่ล่าสุด / เก่าสุด
--   ใช้ใน ORDER BY CAST(json_extract(data, '$.created_at') AS TEXT) DESC|ASC
--   Note: ใช้ TEXT แทน REAL เพราะ created_at เป็น ISO 8601 string (lexicographic sort = chronological)
CREATE INDEX IF NOT EXISTS idx_documents_songs_created_at
  ON documents(json_extract(data, '$.created_at'))
  WHERE collection = 'songs';

-- ตรวจสอบว่าสร้าง index สำเร็จ
-- (run ด้วย wrangler d1 execute ... --command "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_documents_songs_%';")
