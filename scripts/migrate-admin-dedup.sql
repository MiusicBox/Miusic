-- ============================================================
-- Migration (2026-09-28 fix Critical C4): ลบ main admin ซ้อน
-- ============================================================
-- ปัญหา: schema.sql สร้าง UNIQUE partial index `idx_admin_users_main_unique`
--        บน admin_users(role) WHERE role = 'main'
--        แต่ถ้าในระบบมี main admin 2 ตัวอยู่ก่อน (จาก race condition ในอดีต)
--        → CREATE UNIQUE INDEX จะ fail
--        → unique constraint ไม่มี → ใครก็แอบอ้างเป็น main admin ได้ผ่าน
--          /api/auth/bootstrap (ถ้า ALLOW_BOOTSTRAP=true ค้างไว้)
--
-- วิธีแก้: migration script นี้ทำ 3 ขั้นตอน (รันทีละ statement):
--   1) ตรวจ main admin ซ้อน (จำนวน > 1)
--   2) demote main admin ตัวที่ 2 เป็น 'sub' (เก็บตัวแรกตาม created_at)
--   3) รัน CREATE UNIQUE INDEX อีกครั้ง → จะสำเร็จ
--
-- ความปลอดภัย:
--   - ไม่ลบ admin (เก็บประวัติ + login)
--   - demote เป็น sub → admin ยัง login ได้ แต่ไม่มีสิทธิ์ main (จัดการ admins ไม่ได้)
--   - แต่งานให้เจ้าของระบบตรวจสอบอีกทีว่าควรลบ sub ที่ซ้อนจริงหรือไม่
--
-- ผลกระทบระบบเดิม: 0% ถ้าไม่มี main admin ซ้อน (script ไม่ทำอะไร)
--                  demote admin ที่ซ้อน (กรณีเสียหายจริง) → admin นั้นยัง login ได้
--
-- วิธีรัน:
--   - Cloudflare Dashboard → D1 → เลือก database → Console
--   - คัดลอก statement ทีละบรรทัดไปรัน (D1 Console ไม่รองรับหลาย statements)
--   - ตรวจผลลัพธ์ทุก step ก่อน step ถัดไป
-- ============================================================

-- ============================================================
-- Step 1: ตรวจสอบ main admin ซ้อน — รันเพื่อดูผลลัพธ์ก่อน
-- ============================================================
-- ถ้า COUNT > 1 = มี main admin ซ้อน → ทำ Step 2
-- ถ้า COUNT = 1 = ไม่มีซ้อน → ข้ามไป Step 3
-- ถ้า COUNT = 0 = ยังไม่มี main admin → ข้ามไป Step 3 (หรือตั้งค่า admin คนแรกผ่าน /api/auth/bootstrap)
SELECT COUNT(*) AS main_admin_count FROM admin_users WHERE role = 'main';

-- ============================================================
-- Step 1.5: ดูรายชื่อ main admin ทั้งหมด (เพื่อตรวจสอบก่อน demote)
-- ============================================================
-- แสดง id, email, created_at ของ main admin ทั้งหมด เรียงตาม created_at
-- → ตัวแรก (created_at น้อยสุด) = main admin ตัวจริง → คงไว้
-- → ตัวที่เหลือ = ซ้อน → จะถูก demote ใน Step 2
SELECT id, email, display_name, created_at, created_by
FROM admin_users
WHERE role = 'main'
ORDER BY created_at ASC;

-- ============================================================
-- Step 2: Demote main admin ที่ซ้อน (ตัวที่ 2 เป็นต้นไป) เป็น 'sub'
-- ============================================================
-- Logic: เก็บ main admin ที่ created_at น้อยสุด (ตัวแรก)
--        ตัวที่เหลือ → UPDATE role = 'sub'
--
-- วิธีการ (ใช้ subquery หา created_at น้อยสุด):
--   1) หา created_at น้อยสุดของ main admin → เก็บเป็นเกณฑ์
--   2) UPDATE admin_users SET role = 'sub'
--      WHERE role = 'main' AND created_at != (created_at น้อยสุด)
--
-- หมายเหตุ:
--   - ถ้ามี main admin 2 ตัวที่ created_at เท่ากัน (race condition สุดขีด)
--     → step นี้จะ demote ทั้งคู่ (เพราะ != ไม่ match ทั้งคู่)
--     → step 3 จะสำเร็จเพราะไม่มี main เหลือ
--     → ผู้ดูแลระบบต้องตั้ง main admin ใหม่ผ่าน /api/auth/bootstrap
--     (กรณีนี้เกิดน้อยมาก แต่เผื่อไว้)
--
-- 🔒 (Audit Fix M-40): เพิ่ม guard กัน demote ทั้งหมด (กรณี created_at เท่ากัน)
--   ปัญหาเดิม: ถ้า main admin ทั้งหมดมี created_at เท่ากัน → demote ทั้งหมด
--   → ไม่มี main admin → ระบบพัง (ต้อง bootstrap ใหม่)
--   วิธีแก้: เก็บ main admin 1 ตัวเสมอ (ใช้ ROW_NUMBER หรือ MIN(id) เป็น tiebreaker)
--   ผลกระทบระบบเดิม: 0% — ถ้า created_at ต่างกัน → เหมือนเดิม
--   ถ้า created_at เท่ากัน → เก็บ 1 ตัว (ไม่ demote ทั้งหมด)
--
--   - ถ้ามี main admin 2 ตัวที่ created_at ต่างกัน → demote ตัวที่ created_at มากกว่า
--     → main admin ตัวแรกยังเป็น main → step 3 จะสำเร็จ
--
-- รัน statement นี้ครั้งเดียว:
-- 🔒 (M-40): ใช้ id เป็น tiebreaker ถ้า created_at เท่ากัน (กัน demote ทั้งหมด)
UPDATE admin_users
SET role = 'sub'
WHERE role = 'main'
  AND id NOT IN (
    SELECT id FROM admin_users
    WHERE role = 'main'
    ORDER BY created_at ASC, id ASC
    LIMIT 1
  );

-- ============================================================
-- Step 2.5: ตรวจสอบผลหลัง demote
-- ============================================================
-- ควรเห็น main_admin_count = 1 (หรือ 0 ในกรณี race condition สุดขีด)
SELECT COUNT(*) AS main_admin_count_after_demote FROM admin_users WHERE role = 'main';

-- ดูรายการ main admin ที่เหลือ (ควรมี 1 ตัว)
SELECT id, email, display_name, created_at, created_by
FROM admin_users
WHERE role = 'main'
ORDER BY created_at ASC;

-- ดูรายการ sub admin ที่ถูก demote (ถ้ามี)
-- ใช้สำหรับตรวจสอบว่าใครถูก demote และตัดสินใจว่าจะลบหรือคงไว้
SELECT id, email, display_name, created_at, created_by
FROM admin_users
WHERE role = 'sub'
ORDER BY created_at ASC;

-- ============================================================
-- Step 3: สร้าง UNIQUE partial index ใหม่ (หลังลบซ้อนแล้ว)
-- ============================================================
-- ตอนนี้ main admin ไม่ซ้อนแล้ว → CREATE UNIQUE INDEX จะสำเร็จ
-- (ถ้ายัง fail = ยังมี main admin ซ้อน → กลับไป Step 1)
CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_users_main_unique
  ON admin_users(role) WHERE role = 'main';

-- ============================================================
-- Step 4 (optional): ลบ admin ที่ถูก demote ถ้าไม่ต้องการ
-- ============================================================
-- ⚠️ อันตราย: ลบ admin ทิ้ง → login ไม่ได้อีก
-- รันเฉพาะถ้าแน่ใจว่า admin นั้นไม่จำเป็นแล้ว
-- (เช่น เป็น admin ที่สร้างจาก race ไม่ใช่ admin จริง)
--
-- แทนที่ <ADMIN_ID> ด้วย id ของ admin ที่ต้องการลบ
-- DELETE FROM admin_users WHERE id = '<ADMIN_ID>';
-- DELETE FROM sessions WHERE admin_id = '<ADMIN_ID>';

-- ============================================================
-- เสร็จสิ้น migration
-- ============================================================
-- หลังรัน migration นี้:
--   1. UNIQUE partial index `idx_admin_users_main_unique` ทำงานปกติ
--   2. /api/auth/bootstrap จะ detect race ผ่าน INSERT...ON CONFLICT DO NOTHING
--      + เช็ค changes() (ดู worker/index.js บรรทัด ~512)
--   3. ถ้ามีใครพยายามสร้าง main admin ซ้อน → INSERT จะ fail ทันที (atomic)
--      ไม่ต้องพึ่งพา logic ใน Worker
-- ============================================================
