-- ===================================================
-- 🆕 (2026-10-02 v2): migration — สร้างตาราง password_reset_requests
--   รันสคริปต์นี้ใน D1 Console (ออนไลน์) เพื่อเปิดใช้งานฟีเจอร์ลืมรหัสผ่าน (ฝั่งลูกค้า)
--   ผลกระทบระบบเดิม: 0% — เป็นตารางใหม่ ไม่แตะตารางเดิม
--
--   วิธีรัน:
--     1. Cloudflare Dashboard → Workers & Pages → Miusic → D1 → miusic-store-db → Console
--     2. วางสคริปต์ด้านล่างนี้ทั้งหมด → กด Execute
-- ===================================================

CREATE TABLE IF NOT EXISTS password_reset_requests (
  id                 TEXT PRIMARY KEY,           -- crypto.randomUUID()
  customer_id        TEXT,                        -- nullable: ลูกค้าอาจกรอกเบอร์ที่ยังไม่มีบัญชี (guest)
  contact            TEXT NOT NULL,               -- email หรือ whatsapp ที่ลูกค้ากรอก
  status             TEXT NOT NULL DEFAULT 'pending',  -- pending | resolved | dismissed
  note               TEXT,                         -- หมายเหตุแอดมิน (เช่น "รีเซ็ตแล้ว ส่งทาง WhatsApp")
  new_password_hint  TEXT,                         -- (optional) เก็บรหัสผ่านใหม่ที่แอดมินตั้ง (PLAIN TEXT เพื่อส่งต่อ — ลบหลังส่งแล้ว)
  created_at         TEXT NOT NULL,
  resolved_at        TEXT,
  resolved_by_admin  TEXT                          -- admin id ที่ดำเนินการ
);

CREATE INDEX IF NOT EXISTS idx_password_reset_requests_status ON password_reset_requests(status);
CREATE INDEX IF NOT EXISTS idx_password_reset_requests_created ON password_reset_requests(created_at);

-- ตรวจสอบว่าสร้างสำเร็จ
-- SELECT name FROM sqlite_master WHERE type='table' AND name='password_reset_requests';
