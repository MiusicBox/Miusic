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

-- 🔧 แก้บั๊ก I3 (2026-09-18): กัน bootstrap race — สร้าง main admin ซ้อน
--   UNIQUE partial index บน role = 'main' → ถ้ามี main admin อยู่แล้ว INSERT ตัวที่ 2 จะ fail
--   Worker ใช้ INSERT...ON CONFLICT DO NOTHING + เช็ค changes() เพื่อ detect race
-- ⚠️ ถ้าในระบบมี main admin 2 ตัวอยู่แล้ว (จาก race ก่อนหน้า) → index creation จะ fail
--   ให้ลบตัวซ้ำออกก่อน (ดู README สำหรับวิธีเช็ค + ลบ)
CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_users_main_unique
  ON admin_users(role) WHERE role = 'main';

-- 🔧 แก้บั๊ก I4 (2026-09-18): เพิ่ม indexes สำหรับ queries ที่ใช้บ่อย
--   ทำให้ D1 ไม่ต้อง scan ทั้งตาราง + sort ใน memory

-- query orders ด้วย status (ใช้ใน _count-pending endpoint — admin dashboard badge)
CREATE INDEX IF NOT EXISTS idx_documents_orders_status
  ON documents(json_extract(data, '$.status'))
  WHERE collection = 'orders';

-- query orders ด้วย receipt_number (ใช้ใน _customer-query endpoint — track order เดียว)
CREATE INDEX IF NOT EXISTS idx_documents_orders_receipt
  ON documents(json_extract(data, '$.receipt_number'))
  WHERE collection = 'orders';

-- query songs ด้วย playlist_id (ใช้ใน _query endpoint — ลูกค้า checkout playlist)
CREATE INDEX IF NOT EXISTS idx_documents_songs_playlist
  ON documents(json_extract(data, '$.playlist_id'))
  WHERE collection = 'songs';

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

-- 🔧 (2026-09-18 v6 perf): indexes สำหรับ queries ใหม่ของ Full System
--   - song_name index: สำหรับ _check-duplicate endpoint (ค้นหาเพลงซ้ำตามชื่อ)
--   - artist index: สำหรับ admin filter by artist (อนาคต)
--   - dj_name index: สำหรับ getSongsForDetail กรณี filter by DJ name
CREATE INDEX IF NOT EXISTS idx_documents_songs_name
  ON documents(json_extract(data, '$.song_name'))
  WHERE collection = 'songs';

CREATE INDEX IF NOT EXISTS idx_documents_songs_dj_name
  ON documents(json_extract(data, '$.dj_name'))
  WHERE collection = 'songs';

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

-- 🔒 แก้บั๊ก #4 (2026-09-18): ตาราง login_attempts สำหรับ rate limiting บน login
--   ใช้ track IP + email ของการ login ที่ล้มเหลว → บล็อกถ้าเกิน 5 ครั้งใน 15 นาที
--   ล้างอัตโนมัติเมื่อ login สำเร็จ (DELETE FROM login_attempts WHERE ip = ?)
CREATE TABLE IF NOT EXISTS login_attempts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ip            TEXT NOT NULL,
  email         TEXT NOT NULL,
  attempted_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_login_attempts_ip ON login_attempts(ip, attempted_at);

-- ===================================================
-- 🔒 (2026-09-23 fix): ตาราง order_creation_attempts สำหรับ rate limiting บนการสร้างออเดอร์
--   ใช้ track IP ของทุกคำขอสร้างออเดอร์จากลูกค้าที่ยังไม่ login → บล็อกถ้าเกิน 10 ครั้งใน 15 นาที
--   ปัญหา: endpoint PUT /api/db/orders/:id แบบไม่ login ไม่มี rate limit → attacker ยิงสแปมสร้าง
--          ออเดอร์ปลอมจำนวนมาก รบกวนแอดมิน + กิน D1 write quota
--   ความแตกต่างจาก login_attempts:
--     - login_attempts: insert เฉพาะตอน login FAIL (กัน brute-force)
--     - order_creation_attempts: insert ทุกครั้งที่เข้า endpoint (ทั้ง success + fail)
--       เพราะการโจมตีคือ "ยิงสร้างออเดอร์ปลอมล้น quota" ไม่ใช่ brute-force
--   ผลกระทบระบบเดิม: 0% — ตารางใหม่ ไม่แตะ documents/admin_users/sessions/login_attempts
--   ถ้าตารางนี้ไม่มี (DB เก่าที่ยังไม่ run schema.sql ล่าสุด) → Worker ข้าม rate limiting (fallback: ไม่บล็อก)
-- ===================================================
CREATE TABLE IF NOT EXISTS order_creation_attempts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ip            TEXT NOT NULL,
  attempted_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_order_creation_attempts_ip ON order_creation_attempts(ip, attempted_at);

-- ===================================================
-- 🔧 (2026-09-18): ตาราง order_zip_jobs
-- เก็บสถานะ R2 Multipart Upload ระหว่างสร้าง ZIP ออเดอร์ฝั่ง Worker
-- (ปัญหา: Worker มี request body limit 100MB → สร้าง ZIP ผ่าน multipart upload ทีละเพลง)
--
-- วงจร:
--   1) POST /api/order-zip/start → insert row ใหม่ status='preparing'
--   2) POST /api/order-zip/append → update parts JSON (push partNumber/etag/songId/offset/crc/size)
--   3) POST /api/order-zip/finalize → update status='ready' หรือ delete row + update order doc
--
-- ถ้าแอดมินกด "สร้าง ZIP ใหม่" ซ้ำ → /api/order-zip/start จะ abort multipart upload เดิม
--   และ delete row เดิมก่อน insert ใหม่ (cleanup)
--
-- ผลกระทบต่อระบบเดิม: 0% — ตารางใหม่ ไม่แตะ documents/admin_users/sessions/login_attempts
-- ===================================================
CREATE TABLE IF NOT EXISTS order_zip_jobs (
  job_id        TEXT PRIMARY KEY,    -- = R2 multipart uploadId (uuid)
  order_id      TEXT NOT NULL,
  bucket_key    TEXT NOT NULL,      -- "order-zips/Order-{orderId}.zip"
  parts         TEXT NOT NULL DEFAULT '[]', -- JSON array [{ partNumber, etag, songId, folderPath, filename, crc32, size, offset }]
  total_songs   INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'preparing', -- 'preparing' | 'ready' | 'failed'
  error         TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_order_zip_jobs_order ON order_zip_jobs(order_id);
CREATE INDEX IF NOT EXISTS idx_order_zip_jobs_status ON order_zip_jobs(status);

-- ===================================================
-- 🔒 (2026-09-21 fix Bug #2 ZIP URL permanent public): download_tokens table
--   เก็บ one-time use tokens สำหรับลูกค้าดาวน์โหลด ZIP ออเดอร์
--   แทนที่การใช้ R2 public URL ถาวร (ที่แชร์ได้ตลอดไป)
--
--   Flow:
--     1) แอดมินกด "ส่ง ZIP ผ่าน WhatsApp" → app ใหม่เรียก
--        POST /api/order-zip/get-customer-url?orderId=xxx
--        → Worker สร้าง token (crypto.randomUUID) + บันทึก row ใหม่
--        → คืน URL: /api/download/<orderId>?token=<token>
--     2) ลูกค้าคลิก URL → GET /api/download/<orderId>?token=<token>
--        → Worker ตรวจ token ใน DB (valid + ยังไม่หมดอายุ + ยังไม่ used)
--        → ทำเครื่องหมาย used_at (one-time)
--        → ดึง ZIP จาก R2 ผ่าน env.BUCKET.get(bucket_key).body → stream ส่งลูกค้า
--        → R2 public URL ไม่เคยเปิดเผย
--
--   ความปลอดภัย:
--     - Token สุ่มด้วย crypto.randomUUID() (122 บิต entropy) → brute-force ไม่ได้
--     - One-time use → ใช้แล้วใช้ซ้ำไม่ได้ (กันแชร์)
--     - หมดอายุใน 24 ชม. → แม้ลิงก์รั่ว ใช้ได้แค่ชั่วคราว
--     - ผูกกับ orderId → ใช้กับออเดอร์อื่นไม่ได้
--
--   ผลกระทบต่อระบบเดิม: 0% — เพิ่มตารางใหม่ ไม่แตะ documents/admin_users/sessions
-- ===================================================
CREATE TABLE IF NOT EXISTS download_tokens (
  token        TEXT PRIMARY KEY,    -- crypto.randomUUID() — 122 บิต entropy
  order_id     TEXT NOT NULL,       -- orderId ที่ token นี้ใช้ดาวน์โหลดได้
  created_at   TEXT NOT NULL,       -- ISO 8601 string
  expires_at   TEXT NOT NULL,       -- ISO 8601 string — ปกติ created_at + 24h
  used_at      TEXT,                -- NULL = ยังไม่ใช้, ISO = ใช้แล้ว (one-time)
  created_by   TEXT                -- admin_id ของคนสร้าง token (audit log)
);

CREATE INDEX IF NOT EXISTS idx_download_tokens_order ON download_tokens(order_id);
CREATE INDEX IF NOT EXISTS idx_download_tokens_expires ON download_tokens(expires_at);

-- ===================================================
-- 🔒 (2026-09-22 fix): audit_log table — บันทึกทุก action ที่แอดมินทำ
--   เก็บประวัติ: ใคร (admin_id) ทำอะไร (action) กับอะไร (target) เมื่อไหร่ (timestamp)
--   ใช้สำหรับ: สืบสวน insider threat, ตรวจสอบการลบเพลง/แก้ราคา/เปลี่ยนสถานะออเดอร์
--
--   Flow:
--     1) แอดมินลบเพลง/แก้ราคา/เปลี่ยนสถานะออเดอร์ → Worker insert row ใหม่
--     2) แอดมินหลักดูหน้า "ประวัติการกระทำ" → SELECT * FROM audit_log ORDER BY created_at DESC
--     3) ถ้ามีเรื่องผิดปกติ → สืบได้ว่าใครทำตอนไหน
--
--   ความปลอดภัย:
--     - ตารางนี้ insert-only (ไม่มี UPDATE/DELETE ผ่าน API — กันแอดมินลบประวัติตัวเอง)
--     - ถ้าต้องล้าง → รัน SQL โดยตรงใน D1 Console (main admin เท่านั้น)
--     - auto-cleanup: ล้าง rows ที่เกิน 90 วัน อัตโนมัติ (ผ่าน cron หรือ manual SQL)
-- ===================================================
CREATE TABLE IF NOT EXISTS audit_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id      TEXT NOT NULL,           -- UID ของแอดมินที่ทำ action
  admin_email   TEXT NOT NULL,           -- email ของแอดมิน (snapshot — กันกรณี admin ถูกลบ)
  action        TEXT NOT NULL,            -- 'create' | 'update' | 'delete' | 'status_change' | 'zip_create' | 'zip_delete' | 'upload'
  collection    TEXT NOT NULL,            -- 'songs' | 'playlists' | 'orders' | 'categories' | 'djs' | 'settings' | 'promotions' | 'discounts' | 'admins'
  target_id     TEXT,                     -- ID ของ document ที่ถูกกระทำ
  target_name   TEXT,                     -- ชื่อ/label ของ target (snapshot — กันกรณี target ถูกลบ)
  before_data   TEXT,                     -- JSON snapshot ของข้อมูลก่อนเปลี่ยน (ถ้ามี — สำหรับ update/delete)
  after_data    TEXT,                     -- JSON snapshot ของข้อมูลหลังเปลี่ยน (ถ้ามี — สำหรับ create/update)
  ip_address    TEXT,                     -- IP ของผู้ทำ action (จาก CF-Connecting-IP)
  created_at    TEXT NOT NULL             -- ISO 8601 timestamp
);

CREATE INDEX IF NOT EXISTS idx_audit_log_admin ON audit_log(admin_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_collection ON audit_log(collection, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at);

-- ========================================================================
-- 📸 Payment Proofs (เพิ่มใหม่ — STEP 3+4 of payment slip upload feature)
--   - 1 order อาจมีหลาย proof (ลูกค้าอัปโหลดซ้ำได้)
--   - status: pending → verified | rejected
--   - safe migration: CREATE TABLE IF NOT EXISTS → รันซ้ำปลอดภัย, ไม่กระทบข้อมูลเดิม
--   - order_id เป็น logical FK → documents.id WHERE collection='orders' (D1 ไม่ enforce FK)
-- ========================================================================
CREATE TABLE IF NOT EXISTS payment_proofs (
  id              TEXT PRIMARY KEY,           -- crypto.randomUUID()
  order_id        TEXT NOT NULL,              -- → documents.id WHERE collection='orders'
  file_key        TEXT NOT NULL,              -- R2 object key "payment-proofs/{orderId}/{uuid}.{ext}"
  file_url        TEXT NOT NULL,              -- R2 public URL (admin view via /api/file/<key>)
  uploaded_at     TEXT NOT NULL,              -- ISO 8601
  uploaded_by     TEXT,                       -- NULL = ลูกค้าอัปเอง; admin_id = admin อัปแทน
  customer_name   TEXT NOT NULL,              -- snapshot from order (ownership verify)
  whatsapp        TEXT NOT NULL,              -- snapshot from order (ownership verify)
  amount_claimed  REAL,                       -- ยอดที่ลูกค้าบอกว่าโอน (optional, for admin check)
  transfer_ref    TEXT,                       -- เลขอ้างอิงการโอน (optional)
  status          TEXT NOT NULL DEFAULT 'pending',  -- pending | verified | rejected
  verified_at     TEXT,                       -- ISO ตอน admin ตรวจ
  verified_by     TEXT,                       -- admin_id ที่ตรวจ
  reject_reason   TEXT                        -- ถ้า rejected
);
CREATE INDEX IF NOT EXISTS idx_payment_proofs_order ON payment_proofs(order_id);
CREATE INDEX IF NOT EXISTS idx_payment_proofs_status ON payment_proofs(status);
CREATE INDEX IF NOT EXISTS idx_payment_proofs_uploaded ON payment_proofs(uploaded_at);

-- Rate limit การอัปโหลด slip (กัน spam — pattern เดียวกับ order_creation_attempts)
-- 5 uploads / 15 นาที / IP (config ใน worker/index.js)
CREATE TABLE IF NOT EXISTS payment_proof_attempts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ip            TEXT NOT NULL,
  attempted_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payment_proof_attempts_ip ON payment_proof_attempts(ip, attempted_at);
