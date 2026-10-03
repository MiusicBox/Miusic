-- ============================================================
-- 🆕 (T020): Migration — สร้าง song_reviews table
--   รันใน D1 Console หลัง deploy (Cloudflare Dashboard > Workers > D1 > Console)
--   ปลอดภัยต่อระบบเดิม: CREATE TABLE IF NOT EXISTS → รันซ้ำก็ไม่กระทบข้อมูลเดิม
-- ============================================================

CREATE TABLE IF NOT EXISTS song_reviews (
  id          TEXT PRIMARY KEY,
  song_id     TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  rating      INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment     TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE (song_id, customer_id)
);

CREATE INDEX IF NOT EXISTS idx_song_reviews_song_id ON song_reviews (song_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_song_reviews_customer ON song_reviews (customer_id);

-- Verification — ถ้า migration สำเร็จจะเห็น row ที่ name = 'song_reviews'
--   และ index 2 ตัว (idx_song_reviews_song_id + idx_song_reviews_customer)
SELECT name, type FROM sqlite_master
 WHERE type IN ('table', 'index')
   AND name LIKE '%song_reviews%'
 ORDER BY type, name;
