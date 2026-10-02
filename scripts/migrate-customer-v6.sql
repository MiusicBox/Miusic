-- ===================================================
-- 🆕 (2026-10-02 v6): migration — สร้างตาราง customer_favorites + song_reviews
--   รันสคริปต์นี้ใน D1 Console (ออนไลน์) เพื่อเปิดใช้งานฟีเจอร์รายการโปรด + รีวิว
--   ผลกระทบระบบเดิม: 0% — เป็นตารางใหม่ ไม่แตะตารางเดิม
--
--   วิธีรัน:
--     1. Cloudflare Dashboard → Workers & Pages → Miusic → D1 → miusic-store-db → Console
--     2. วางสคริปต์ด้านล่างนี้ทั้งหมด → กด Execute
-- ===================================================

-- ฟีเจอร์ #2: รายการเพลงโปรดของลูกค้า (Wishlist)
CREATE TABLE IF NOT EXISTS customer_favorites (
  id          TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  song_id     TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  UNIQUE(customer_id, song_id)
);
CREATE INDEX IF NOT EXISTS idx_customer_favorites_customer ON customer_favorites(customer_id);
CREATE INDEX IF NOT EXISTS idx_customer_favorites_song ON customer_favorites(song_id);

-- ฟีเจอร์ #12: รีวิว + ให้คะแนนเพลง
CREATE TABLE IF NOT EXISTS song_reviews (
  id          TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  song_id     TEXT NOT NULL,
  rating      INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
  review      TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE(customer_id, song_id)
);
CREATE INDEX IF NOT EXISTS idx_song_reviews_song ON song_reviews(song_id);
CREATE INDEX IF NOT EXISTS idx_song_reviews_customer ON song_reviews(customer_id);

-- ตรวจสอบว่าสร้างสำเร็จ
-- SELECT name FROM sqlite_master WHERE type='table' AND name IN ('customer_favorites', 'song_reviews');
