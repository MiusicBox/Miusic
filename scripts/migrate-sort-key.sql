-- 🆕 (Sort-Key): ดัชนีสำหรับเรียงเพลงตาม sort_key (ก-ฮ > A-Z > 0-9) + แบ่งหน้าแบบ keyset
--   รันครั้งเดียวหลัง deploy:
--     wrangler d1 execute miusic-store-db --remote --file=scripts/migrate-sort-key.sql
--   จากนั้นเปิดหน้าแอดมิน 1 ครั้ง — ระบบจะเติม sort_key ให้เพลงเดิมทั้งหมดเอง (POST /api/admin/backfill-sort-keys)
--   เพลงที่เพิ่ม/แก้ไขหลังจากนี้จะมี sort_key อัตโนมัติ
CREATE INDEX IF NOT EXISTS idx_documents_songs_sortkey
  ON documents(json_extract(data, '$.sort_key'), id)
  WHERE collection = 'songs';

-- ให้ SQLite เลือกใช้ดัชนีนี้ตอนเรียง/แบ่งหน้า (ถ้าไม่มีสถิติ บางครั้งมันเลือกสแกนทั้ง collection แล้วเรียงเอง)
PRAGMA optimize;
