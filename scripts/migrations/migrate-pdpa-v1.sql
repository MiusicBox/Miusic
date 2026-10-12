-- ============================================================
-- 🆕 (T057): PDPA Compliance — Migration Script
-- ============================================================
-- วัตถุประสงค์: รองรับ 6 สิทธิ์ลูกค้า PDPA (มาตรา 30-37)
--
-- สิ่งที่เพิ่ม:
-- 1. consent_records table — บันทึกการยินยอม (Privacy Policy + marketing)
-- 2. customers.deleted_at column — soft delete (30 วัน grace ก่อน hard delete)
-- 3. customers.marketing_opt_out column — สิทธิ์คัดค้าน (opt-out การรับข่าวสาร)
--
-- วิธีใช้: รันทีละ statement ใน D1 Console (wrangler d1 execute miusic-store-db --command="...")
-- ============================================================

-- Step 1: สร้าง consent_records table
--   เก็บประวัติการยินยอมของลูกค้า — บังคับโดย PDPA มาตรา 19 (accountability)
--   ใช้ insert-only (ไม่มี UPDATE/DELETE ผ่าน API — กันปลอมแปลง)
CREATE TABLE IF NOT EXISTS consent_records (
  id            TEXT PRIMARY KEY,
  customer_id   TEXT,                           -- NULL ได้ (กรณี anon consent)
  session_key   TEXT,                           -- ใช้ตอน anon (IP hash)
  consent_type  TEXT NOT NULL,                  -- 'privacy_policy' | 'marketing' | 'cookie'
  action        TEXT NOT NULL,                  -- 'accept' | 'reject' | 'withdraw'
  ip            TEXT,
  user_agent    TEXT,
  policy_version TEXT,                          -- version ของ policy ตอนที่ยินยอม (เช่น 'v1.0-20261007')
  created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_consent_records_customer ON consent_records(customer_id);
CREATE INDEX IF NOT EXISTS idx_consent_records_type ON consent_records(consent_type);
CREATE INDEX IF NOT EXISTS idx_consent_records_created ON consent_records(created_at);

-- Step 2: เพิ่ม deleted_at column ใน customers (soft delete)
--   สิทธิ์ลบ (มาตรา 33): ลูกค้าลบบัญชีเองได้
--   แต่ใช้ soft delete (deleted_at != NULL) + 30 วัน grace → กัน regret
--   หลัง 30 วัน → cron จะ hard delete จริง (cascade favorites/likes/etc)
--   ระหว่างนี้ → ลูกค้า login ไม่ได้ (เหมือนถูกลบแล้ว)
ALTER TABLE customers ADD COLUMN deleted_at TEXT;

-- Step 3: เพิ่ม marketing_opt_out column (สิทธิ์คัดค้าน — มาตรา 32)
--   ถ้า TRUE → ห้ามส่ง marketing messages ให้ลูกค้า (ถ้ามีในอนาคต)
--   default FALSE (ยินยอม) — ลูกค้าต้อง opt-out เอง
ALTER TABLE customers ADD COLUMN marketing_opt_out INTEGER DEFAULT 0;

-- ============================================================
-- Verification
-- ============================================================
-- ตรวจว่า columns ถูกเพิ่มแล้ว:
-- PRAGMA table_info(customers);
--   → ควรเห็น deleted_at และ marketing_opt_out ในรายการ

-- ตรวจว่า consent_records ถูกสร้าง:
-- SELECT name FROM sqlite_master WHERE type='table' AND name='consent_records';
--   → ควรเห็น 'consent_records'
