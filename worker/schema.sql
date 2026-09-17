-- schema.sql
-- ===================================================
-- สคีมา Cloudflare D1 สำหรับแทนที่ Firestore + Firebase Auth
--
-- แนวคิด: ตาราง "documents" เป็นตารางกลางแบบ generic (collection, id, data JSON)
-- เลียนแบบโครงสร้าง Firestore (collection/document แบบไม่บังคับ schema ตายตัว) 1:1
-- เพื่อให้ทุก collection เดิม (songs, categories, djs, playlists, orders, discounts,
-- promotions, settings) ใช้โค้ดฝั่ง Worker ชุดเดียวกันได้ทั้งหมด โดยไม่ต้องออกแบบตาราง
-- แยกทีละ collection (ลดความเสี่ยงตีความฟิลด์ผิดจากของเดิมที่มีอยู่แล้วในแอป)
--
-- ยกเว้น collection "admins" ที่ผูกกับระบบยืนยันตัวตนโดยตรง จึงแยกเป็นตาราง
-- admin_users ต่างหาก (มี password_hash ซึ่งห้ามปนกับ JSON blob ทั่วไป)
-- ===================================================

CREATE TABLE IF NOT EXISTS documents (
  collection  TEXT NOT NULL,
  id          TEXT NOT NULL,
  data        TEXT NOT NULL, -- JSON string ของฟิลด์เอกสาร (เทียบเท่า Firestore document fields)
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (collection, id)
);

-- ใช้เร่งความเร็วตอน getDocs(collection(db, "..")) แบบไม่มีเงื่อนไข (ดึงทั้ง collection)
CREATE INDEX IF NOT EXISTS idx_documents_collection ON documents(collection);

-- 🔧 แก้บั๊ก Bug #9 (2026-09-17): index สำหรับ orderBy("created_at", ...) บน documents column
-- ใช้ตอน endpoint /api/db/orders/_query (ฝั่งแอดมิน) — orders.js เรียก
--   query(collection(db,"orders"), orderBy("created_at","desc"))
--   db-helpers.js ใช้ column ตรง ๆ (documents.created_at) แทน json_extract
--   → index ตัวนี้ทำให้ ORDER BY created_at DESC ใช้ index ได้โดยตรง
-- ก่อนหน้านี้ใช้ json_extract(data, '$.created_at') ทำให้ D1 ไม่สามารถใช้ index ได้
--   → scan ทั้งตาราง + sort ใน memory — 10,000 orders ช้าหลายวินาที
-- index นี้ใช้ได้กับทุก collection (orders, songs, playlists, ...) — ไม่จำกัดเฉพาะ orders
CREATE INDEX IF NOT EXISTS idx_documents_collection_created_at
  ON documents(collection, created_at);

-- 🔧 แก้บั๊ก Bug #6 (2026-09-17): index สำหรับ query orders ด้วย whatsapp
-- ใช้ตอน endpoint /api/db/orders/_customer-list — ลูกค้าดูออเดอร์ของตัวเอง
-- โดยที่ไม่ต้อง scan orders ทั้งหมดมากรองฝั่ง JS
-- D1 รองรับ expression index บน json_extract — ทำให้ query WHERE json_extract(data, '$.whatsapp') = ?
-- สามารถใช้ index ได้โดยตรง
CREATE INDEX IF NOT EXISTS idx_documents_orders_whatsapp
  ON documents(collection, json_extract(data, '$.whatsapp'))
  WHERE collection = 'orders';

-- 🔧 แก้บั๊ก Bug #7 (2026-09-17): index สำหรับ query cover_url ใน songs และ playlists
-- ใช้ตอน endpoint /api/db/_meta/_check-cover-used — ตรวจว่า cover_url ยังถูกใช้อยู่ไหม
-- ทำให้ query json_extract(data, '$.cover_url') = ? ใช้ index ได้โดยตรง
CREATE INDEX IF NOT EXISTS idx_documents_songs_cover
  ON documents(json_extract(data, '$.cover_url'))
  WHERE collection = 'songs';

CREATE INDEX IF NOT EXISTS idx_documents_playlists_cover
  ON documents(json_extract(data, '$.cover_url'))
  WHERE collection = 'playlists';

CREATE TABLE IF NOT EXISTS admin_users (
  id             TEXT PRIMARY KEY, -- เทียบเท่า Firebase Auth UID เดิม
  email          TEXT NOT NULL UNIQUE,
  password_hash  TEXT NOT NULL,    -- รูปแบบ "pbkdf2$<iterations>$<saltBase64>$<hashBase64>"
  display_name   TEXT,
  role           TEXT NOT NULL DEFAULT 'sub', -- 'main' | 'sub' (เหมือนเดิมทุกประการ)
  created_at     TEXT NOT NULL,
  created_by     TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  admin_id    TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_admin ON sessions(admin_id);
