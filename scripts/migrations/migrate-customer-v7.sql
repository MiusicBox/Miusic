-- ===================================================
-- 🆕 (2026-10-02 v7): migration — เปลี่ยนจาก song_reviews → song_likes
--   รันสคริปต์นี้ใน D1 Console (ออนไลน์) เพื่อ:
--   1. สร้างตาราง song_likes (แทนที่จะใช้ song_reviews)
--   2. (Optional) ลบตาราง song_reviews ที่ไม่ได้ใช้แล้ว
--
--   วิธีรัน:
--     1. Cloudflare Dashboard → Workers & Pages → Miusic → D1 → miusic-store-db → Console
--     2. วางสคริปต์ด้านล่างนี้ทั้งหมด → กด Execute
-- ===================================================

-- ฟีเจอร์ #12 ใหม่: ถูกใจเพลงแบบ TikTok (แทนระบบรีวิวเดิม)
CREATE TABLE IF NOT EXISTS song_likes (
  id          TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  song_id     TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  UNIQUE(customer_id, song_id)
);
CREATE INDEX IF NOT EXISTS idx_song_likes_song ON song_likes(song_id);
CREATE INDEX IF NOT EXISTS idx_song_likes_customer ON song_likes(customer_id);

-- (Optional) ลบตาราง song_reviews ที่ไม่ได้ใช้แล้ว
--   ⚠️ ถ้ายังมีข้อมูลรีวิวเก่าอยู่ จะถูกลบทั้งหมด
--   ถ้าไม่อยากลบ ให้ comment บรรทัดด้านล่างนี้
DROP TABLE IF EXISTS song_reviews;

-- ตรวจสอบว่าสร้างสำเร็จ
-- SELECT name FROM sqlite_master WHERE type='table' AND name IN ('customer_favorites', 'song_likes');
