// worker/db-helpers.js
// ===================================================
// Generic "document store" ที่ทำตัวเหมือน Firestore collection/document บน D1
// ทุก collection เดิม (songs, categories, djs, playlists, orders, discounts, promotions, settings)
// ใช้ตาราง "documents" ตัวเดียวกันหมด (collection TEXT, id TEXT, data JSON)
//
// ข้อยกเว้น: collection "admins" ผูกกับระบบยืนยันตัวตน (มี password_hash) จึงแยกไปตาราง
// admin_users ต่างหาก — ฟังก์ชันด้านล่างเช็ค collection === "admins" แล้วสลับไปใช้ตารางนั้นแทน
// เพื่อให้ db-client.js ฝั่ง browser เรียกผ่าน interface เดียวกันได้โดยไม่ต้องรู้ความต่างนี้เลย
// ===================================================

const ADMIN_SAFE_COLUMNS = "id, email, display_name, role, created_at, created_by";

function rowToAdminDoc(row) {
  if (!row) return null;
  return {
    id: row.id,
    data: {
      email: row.email,
      display_name: row.display_name,
      role: row.role,
      created_at: row.created_at,
      created_by: row.created_by,
    },
  };
}

export async function getDocument(env, collection, id) {
  if (collection === "admins") {
    const row = await env.DB.prepare(`SELECT ${ADMIN_SAFE_COLUMNS} FROM admin_users WHERE id = ?`)
      .bind(id).first();
    return rowToAdminDoc(row);
  }
  const row = await env.DB.prepare("SELECT data FROM documents WHERE collection = ? AND id = ?")
    .bind(collection, id).first();
  if (!row) return null;
  return { id, data: JSON.parse(row.data) };
}

export async function listDocuments(env, collection) {
  if (collection === "admins") {
    const { results } = await env.DB.prepare(`SELECT ${ADMIN_SAFE_COLUMNS} FROM admin_users`).all();
    return results.map((row) => rowToAdminDoc(row));
  }
  const { results } = await env.DB.prepare("SELECT id, data FROM documents WHERE collection = ?")
    .bind(collection).all();
  return results.map((row) => ({ id: row.id, data: JSON.parse(row.data) }));
}

// รองรับเฉพาะรูปแบบที่แอปนี้ใช้จริง: where("field","==",value) และ orderBy("field","asc"|"desc")
// (ตรวจสอบแล้วจากทุกไฟล์ในโปรเจกต์ ไม่มีจุดไหนใช้ operator อื่นของ Firestore เลย)
//
// 🔒 Security (2026-09-16): whitelist ชื่อ field ที่อนุญาตให้ส่งเข้า queryDocuments ได้
// กัน attacker ส่ง crafted JSON ผ่าน endpoint /api/db/:collection/_query แล้ว
// แทรก SQL เข้าไปใน json_extract(data, '$.<field>') ที่ยัง interpolate ตรงๆ
// ตรวจสอบจากทุกไฟล์แล้วว่ามี where()/orderBy() ใช้ field เหล่านี้เท่านั้น:
//   - playlist_id : app-cart.js, orders.js (สร้าง ZIP / query เพลงในเพลย์ลิสต์)
//   - receipt_number : worker/index.js (endpoint _customer-query ลูกค้าติดตามออเดอร์)
//   - status : เก็บไว้เผื่ออนาคต (เดิมเคยใช้ใน orders.js แต่ปัจจุบันกรองฝั่ง client แทน)
//   - created_at : orders.js (orderBy ตอนโหลดประวัติออเดอร์ฝั่งแอดมิน)
// ถ้าอนาคตต้องการ query field ใหม่ ให้เพิ่มชื่อ field ลงใน Set นี้ก่อน
const ALLOWED_QUERY_FIELDS = new Set([
  "playlist_id",
  "receipt_number",
  "status",
  "created_at",
  // 🔧 แก้บั๊ก Bug #6 (2026-09-17): เพิ่ม whatsapp + customer_name
  //   ใช้สำหรับ endpoint _customer-list ใน worker/index.js — Server กรอง orders ที่ DB level
  //   ด้วย where("whatsapp","==",phone) แทนการโหลด orders ทั้งหมดมากรองฝั่ง JS
  //   ลด D1 reads จาก orders_total → orders_ของเบอร์นั้น (ปกติทำลำดับสิบ)
  "whatsapp",
  "customer_name",
]);

export async function queryDocuments(env, collection, { wheres = [], orderBy = null } = {}) {
  if (collection === "admins") {
    // ไม่มีจุดไหนในโปรเจกต์ query collection "admins" แบบมีเงื่อนไข — กันไว้เผื่ออนาคตเรียกผิด
    throw new Error("collection admins ไม่รองรับการ query แบบมีเงื่อนไข");
  }
  let sql = "SELECT id, data FROM documents WHERE collection = ?";
  const binds = [collection];
  for (const w of wheres) {
    if (w.op !== "==") throw new Error(`ไม่รองรับ where operator: ${w.op}`);
    if (!ALLOWED_QUERY_FIELDS.has(w.field)) {
      // กัน SQL injection ผ่าน field name ที่ attacker ควบคุมได้ — field ต้องอยู่ใน whitelist เท่านั้น
      throw new Error(`field ไม่ได้รับอนุญาตใน query: ${w.field}`);
    }
    sql += ` AND json_extract(data, '$.${w.field}') = ?`;
    binds.push(w.value);
  }
  if (orderBy && orderBy.field) {
    if (!ALLOWED_QUERY_FIELDS.has(orderBy.field)) {
      throw new Error(`field ไม่ได้รับอนุญาตใน orderBy: ${orderBy.field}`);
    }
    const dir = orderBy.dir === "desc" ? "DESC" : "ASC";
    sql += ` ORDER BY json_extract(data, '$.${orderBy.field}') ${dir}`;
  }
  const { results } = await env.DB.prepare(sql).bind(...binds).all();
  return results.map((row) => ({ id: row.id, data: JSON.parse(row.data) }));
}

// ===================================================
// 🔧 (2026-09-17 Phase 1): countDocuments — นับ documents ตาม where clause
// ใช้สำหรับ count pending orders badge — ประหยัด D1 reads มาก (1 read แทน 10,000+)
//   เดิม: getDocs(collection(db,"orders")) → load ทุก row มาที่ browser แล้ว filter
//   ใหม่: SELECT COUNT(*) → D1 คืนแค่ตัวเลข 1 row
// ใช้ same field whitelist + same where format เหมือน queryDocuments
// ===================================================
export async function countDocuments(env, collection, { wheres = [] } = {}) {
  if (collection === "admins") {
    throw new Error("collection admins ไม่รองรับการ count แบบมีเงื่อนไข");
  }
  let sql = "SELECT COUNT(*) AS c FROM documents WHERE collection = ?";
  const binds = [collection];
  for (const w of wheres) {
    if (w.op !== "==") throw new Error(`ไม่รองรับ where operator: ${w.op}`);
    if (!ALLOWED_QUERY_FIELDS.has(w.field)) {
      throw new Error(`field ไม่ได้รับอนุญาตใน count: ${w.field}`);
    }
    sql += ` AND json_extract(data, '$.${w.field}') = ?`;
    binds.push(w.value);
  }
  const row = await env.DB.prepare(sql).bind(...binds).first();
  return (row && row.c) || 0;
}

// ===================================================
// 🔧 (2026-09-17 Phase 2): getDocumentsByIds — batch fetch documents หลายอันในครั้งเดียว
// ใช้สำหรับ batch fetch songs ตอนสร้าง ZIP — ลดจำนวน HTTP requests จาก browser → Worker
//   เดิม: 30 songs = 30 HTTP requests (Worker invocations) = 30 D1 reads
//   ใหม่: 30 songs = 1 HTTP request = 1 D1 query (ยังอ่าน 30 rows แต่ใน query เดียว)
//   จริง ๆ D1 rows read เท่าเดิม แต่ Worker invocations ลดลงมาก + latency ต่ำกว่า
//
// ⚠️ ข้อจำกัด: D1 จำกัด bind parameters ต่อ query ประมาณ 100 ตัว
//   ถ้า ids ยาวเกิน 100 → แบ่ง batch อัตโนมัติ (chunk by 100)
//
// ⚠️ Security: ไม่จำเป็นต้อง whitelist field เพราะ query ใช้ id column (ไม่ใช่ json_extract)
//   ids ผูกเป็น bind parameter → กัน SQL injection
//   แต่ collection ผูกเป็น bind parameter เหมือนกัน → ปลอดภัย
// ===================================================
export async function getDocumentsByIds(env, collection, ids) {
  if (!Array.isArray(ids) || ids.length === 0) return [];
  if (collection === "admins") {
    throw new Error("collection admins ไม่รองรับการ batch get");
  }
  // กรอง id ที่ไม่ใช่ string ออก + dedupe
  const uniqueIds = [...new Set(ids.map(id => String(id)).filter(Boolean))];
  if (uniqueIds.length === 0) return [];

  // แบ่ง batch ทีละ 100 (D1 bind parameter limit)
  const BATCH_SIZE = 100;
  const results = [];
  for (let i = 0; i < uniqueIds.length; i += BATCH_SIZE) {
    const chunk = uniqueIds.slice(i, i + BATCH_SIZE);
    const placeholders = chunk.map(() => "?").join(", ");
    const sql = `SELECT id, data FROM documents WHERE collection = ? AND id IN (${placeholders})`;
    const { results: chunkResults } = await env.DB.prepare(sql).bind(collection, ...chunk).all();
    for (const row of chunkResults) {
      results.push({ id: row.id, data: JSON.parse(row.data) });
    }
  }
  return results;
}

// setDoc: สร้างใหม่หรือเขียนทับทั้งเอกสาร (merge=false) หรือ shallow-merge ฟิลด์ที่ส่งมาเข้ากับของเดิม (merge=true)
// — พฤติกรรมเหมือน Firestore setDoc(ref, data, {merge:true}) ทุกประการ (shallow merge ระดับ field บนสุด)
export async function setDocument(env, collection, id, data, merge, actorEmail) {
  if (collection === "admins") {
    return setAdminDocument(env, id, data);
  }
  const now = new Date().toISOString();
  let finalData = data;
  if (merge) {
    const existing = await env.DB.prepare("SELECT data FROM documents WHERE collection = ? AND id = ?")
      .bind(collection, id).first();
    if (existing) finalData = { ...JSON.parse(existing.data), ...data };
  }
  await env.DB.prepare(
    `INSERT INTO documents (collection, id, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(collection, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
  ).bind(collection, id, JSON.stringify(finalData), now, now).run();
  return { id };
}

// updateDoc: merge เหมือน setDoc(merge:true) แต่ต้องมีเอกสารอยู่ก่อนแล้วเท่านั้น (เหมือน Firestore updateDoc)
export async function updateDocument(env, collection, id, data) {
  if (collection === "admins") {
    const existing = await env.DB.prepare("SELECT id FROM admin_users WHERE id = ?").bind(id).first();
    if (!existing) return { notFound: true };
    return setAdminDocument(env, id, data);
  }
  const existing = await env.DB.prepare("SELECT data FROM documents WHERE collection = ? AND id = ?")
    .bind(collection, id).first();
  if (!existing) return { notFound: true };
  const merged = { ...JSON.parse(existing.data), ...data };
  const now = new Date().toISOString();
  await env.DB.prepare("UPDATE documents SET data = ?, updated_at = ? WHERE collection = ? AND id = ?")
    .bind(JSON.stringify(merged), now, collection, id).run();
  return { id };
}

export async function deleteDocument(env, collection, id) {
  if (collection === "admins") {
    await env.DB.prepare("DELETE FROM admin_users WHERE id = ?").bind(id).run();
    return;
  }
  await env.DB.prepare("DELETE FROM documents WHERE collection = ? AND id = ?").bind(collection, id).run();
}

// ใช้เฉพาะตอน setDoc/updateDoc ของ collection "admins" — เขียนเฉพาะคอลัมน์ที่อนุญาต (ห้ามแตะ password_hash ทางนี้เด็ดขาด
// ต้องเปลี่ยนรหัสผ่านผ่าน /api/auth/change-password เท่านั้น)
async function setAdminDocument(env, id, data) {
  const existing = await env.DB.prepare("SELECT * FROM admin_users WHERE id = ?").bind(id).first();
  if (!existing) return { notFound: true };
  const merged = {
    email: data.email !== undefined ? data.email : existing.email,
    display_name: data.display_name !== undefined ? data.display_name : existing.display_name,
    role: data.role !== undefined ? data.role : existing.role,
    created_at: data.created_at !== undefined ? data.created_at : existing.created_at,
    created_by: data.created_by !== undefined ? data.created_by : existing.created_by,
  };
  await env.DB.prepare(
    "UPDATE admin_users SET email = ?, display_name = ?, role = ?, created_at = ?, created_by = ? WHERE id = ?"
  ).bind(merged.email, merged.display_name, merged.role, merged.created_at, merged.created_by, id).run();
  return { id };
}
