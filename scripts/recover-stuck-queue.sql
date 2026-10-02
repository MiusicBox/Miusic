-- ============================================================
-- Recovery Script (2026-09-28): Reset stuck queue + zip jobs
-- ============================================================
-- ปัญหา: Worker Free plan ถูก kill ที่ 30s ก่อนสร้าง ZIP เสร็จ
--   → order_zip_queue มี row status='processing' แต่ order_zip_jobs ไม่มี row
--   → ออเดอร์ค้างตลอด → UI แสดง "กำลังสร้าง ZIP..." ตลอด
--
-- วิธีกู้: reset status ให้กลับเป็น 'queued' เพื่อให้ cron รอบถัดไป trigger ใหม่
--
-- รัน statement ทีละบรรทัดใน D1 Console:
-- ============================================================

-- Step 1: ตรวจสถานะก่อน (ดูผลลัพธ์)
SELECT id, order_id, queued_at, status FROM order_zip_queue;

-- Step 2: reset ทุก row ที่ status='processing' กลับเป็น 'queued'
--   เหตุผล: 'processing' แปลว่า Worker trigger แล้ว แต่ไม่มี row ใน order_zip_jobs
--   = Worker ถูก kill ก่อน → reset ให้กลับ 'queued' เพื่อให้ cron trigger ใหม่
UPDATE order_zip_queue SET status = 'queued' WHERE status = 'processing';

-- Step 3: ตรวจผลหลัง reset
SELECT id, order_id, queued_at, status FROM order_zip_queue;

-- Step 4 (optional): ถ้ามี row ใน order_zip_jobs ที่ status='preparing' เก่า ๆ
--   (อาจเกิดจาก Worker ก่อนหน้า) → ลบออก (R2 multipart upload จะ abort เอง)
--   คำเตือน: ถ้ามี ZIP กำลังสร้างจริง การลบจะทำให้ abort
SELECT job_id, order_id, status, updated_at FROM order_zip_jobs WHERE status = 'preparing';

-- Step 5 (optional): ลบ stuck jobs (รันเฉพาะถ้า Step 4 มี rows ที่ updated_at เก่า > 30 นาที)
-- 🔒 (Audit Fix M-41): เพิ่ม threshold จาก 5 นาที → 30 นาที — กันลบ legitimate in-progress jobs
--   ปัญหาเดิม: 5 นาทีอาจไม่พอสำหรับ ZIP ขนาดใหญ่ (30 เพลง × 10MB = 5-10 นาที)
--   → ลบ job ที่กำลังทำอยู่ → R2 multipart orphan + admin เสียงาน
--   วิธีแก้: เพิ่มเป็น 30 นาที — ปลอดภัยกว่า (ถ้า ZIP ใช้เกิน 30 นาที = มีปัญหาจริง)
--   ผลกระทบระบบเดิม: 0% — ถ้า stuck < 30 นาที → ไม่ลบ (เหมือนเดิมแต่ threshold เปลี่ยน)
DELETE FROM order_zip_jobs WHERE status = 'preparing' AND datetime(updated_at) < datetime('now', '-30 minutes');

-- ============================================================
-- หลักรัน Recovery script:
--   - ออเดอร์ที่ค้างจะกลับเป็น 'queued'
--   ⚠️ (2026-09-28 rollback update): Sequential Queue ถูก rollback แล้ว
--     - cron ทุก 1 นาที ถูกลบออก → cron ไม่ trigger queue อีก
--     - cron ทุก 6 ชม. (เดิม) ยังทำ cleanup ZIP/audit_log/tokens/stuck jobs
--   - ถ้ารัน script นี้ → rows ใน order_zip_queue จะค้าง (ไม่มีใคร trigger)
--   - วิธีกู้ถาวร: admin กด "ยืนยันสลิป" ใหม่ในหน้า admin → ไปกดเปลี่ยน status = "processing" เอง
--   - (Sequential Queue + cron trigger ถูกลบออกจาก worker/index.js ใน rollback)
-- ============================================================
