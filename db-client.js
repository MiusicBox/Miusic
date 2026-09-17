// db-client.js
// ===================================================
// เลียนแบบหน้าตา Firestore Web SDK เฉพาะฟังก์ชันที่โปรเจกต์นี้ใช้จริง (ตรวจสอบครบทุกไฟล์แล้ว):
// collection, doc, getDoc, getDocs, addDoc, setDoc, updateDoc, deleteDoc, query, where, orderBy, onSnapshot
// แต่ข้างในยิง fetch() ไปที่ /api/db/* บน Worker (คุย Cloudflare D1) แทน Firestore จริง
//
// เหตุผลที่ทำแบบนี้: ไฟล์ app-admin.js/app-cart.js/app-promotion.js/app-user.js/orders.js/admin-roles.js
// เขียนโค้ดโดยเรียกฟังก์ชันเหล่านี้ตรงๆ กว่า 250 จุด — การทำ compat layer แบบนี้ทำให้ไฟล์เหล่านั้น
// "ไม่ต้องแก้ logic แม้แต่บรรทัดเดียว" แก้แค่บรรทัด import ให้ชี้มาไฟล์นี้แทน CDN ของ Firebase
// (เหมือนแนวทางเดียวกับ storage-adapter.js ตอนย้าย Cloudinary -> R2)
//
// ขอบเขตที่รองรับ (เท่าที่แอปนี้ใช้จริง เท่านั้น — ไม่ใช่ Firestore SDK เต็มรูปแบบ):
//   - where(field, "==", value) เท่านั้น (ไม่มีจุดไหนในแอปใช้ operator อื่น)
//   - orderBy(field, "asc"|"desc")
//   - onSnapshot ใช้กับ query(collection(db,"orders")) แบบไม่มีเงื่อนไขเท่านั้น -> จำลอง realtime
//     ด้วยการ poll ทุก 4 วินาทีแทน (D1/Worker ไม่มี realtime push แบบ Firestore)
// ===================================================

const API_BASE = "/api/db";
const SNAPSHOT_POLL_MS = 4000;

async function apiFetch(path, options = {}) {
  const res = await fetch(API_BASE + path, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  let body = null;
  try { body = await res.json(); } catch { /* ไม่มี body หรือไม่ใช่ JSON */ }
  if (!res.ok) {
    const err = new Error((body && body.error) || `คำขอไปยังฐานข้อมูลไม่สำเร็จ (HTTP ${res.status})`);
    if (body && body.code) err.code = body.code;
    throw err;
  }
  return body;
}

// ---------------- References (เหมือน Firestore: แค่ path ยังไม่ได้อ่าน/เขียนจริง) ----------------
export function collection(_db, path) {
  return { __type: "collection", path };
}

// doc(db, path, id) เหมือน Firestore เดิม, หรือ doc(collectionRef) แบบไม่ระบุ id
// -> สุ่ม id ฝั่ง client ทันที (เหมือน Firestore SDK จริงที่ generate ID ทันทีโดยยังไม่เขียนอะไรลงฐานข้อมูล)
export function doc(dbOrCollRef, pathOrId, maybeId) {
  if (dbOrCollRef && dbOrCollRef.__type === "collection") {
    return { __type: "doc", path: dbOrCollRef.path, id: crypto.randomUUID() };
  }
  if (maybeId !== undefined) {
    return { __type: "doc", path: pathOrId, id: maybeId };
  }
  throw new Error("db-client.js: doc() ถูกเรียกด้วยรูปแบบพารามิเตอร์ที่ไม่รองรับ");
}

// ---------------- Query builders ----------------
export function query(collRef, ...constraints) {
  const q = { __type: "query", path: collRef.path, wheres: [], orderBy: null };
  for (const c of constraints) {
    if (c.__type === "where") q.wheres.push(c);
    else if (c.__type === "orderBy") q.orderBy = c;
  }
  return q;
}
export function where(field, op, value) {
  return { __type: "where", field, op, value };
}
export function orderBy(field, dir = "asc") {
  return { __type: "orderBy", field, dir };
}

// ---------------- Snapshot helpers ----------------
function makeDocSnap(id, data, exists) {
  return { id, exists: () => exists, data: () => (exists ? data : undefined) };
}
function makeQuerySnap(docs) {
  const docSnaps = docs.map((d) => ({ id: d.id, data: () => d.data }));
  return {
    docs: docSnaps,
    empty: docSnaps.length === 0,
    size: docSnaps.length,
    forEach(fn) { docSnaps.forEach(fn); },
  };
}

// ---------------- CRUD ----------------
export async function getDoc(ref) {
  const res = await apiFetch(`/${encodeURIComponent(ref.path)}/${encodeURIComponent(ref.id)}`);
  return makeDocSnap(ref.id, res.data, res.exists);
}

async function fetchDocs(refOrQuery) {
  if (refOrQuery.__type === "query" && (refOrQuery.wheres.length || refOrQuery.orderBy)) {
    const res = await apiFetch(`/${encodeURIComponent(refOrQuery.path)}/_query`, {
      method: "POST",
      body: JSON.stringify({ wheres: refOrQuery.wheres, orderBy: refOrQuery.orderBy }),
    });
    return res.docs;
  }
  const res = await apiFetch(`/${encodeURIComponent(refOrQuery.path)}`);
  return res.docs;
}

export async function getDocs(refOrQuery) {
  const docs = await fetchDocs(refOrQuery);
  return makeQuerySnap(docs);
}

// addDoc: เทียบเท่า setDoc ด้วย id ที่สุ่มขึ้นฝั่ง client (Firestore เองก็ทำแบบนี้ภายในเช่นกัน)
export async function addDoc(collRef, data) {
  const id = crypto.randomUUID();
  await apiFetch(`/${encodeURIComponent(collRef.path)}/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify({ data, merge: false }),
  });
  return { id, path: collRef.path };
}

export async function setDoc(ref, data, options) {
  await apiFetch(`/${encodeURIComponent(ref.path)}/${encodeURIComponent(ref.id)}`, {
    method: "PUT",
    body: JSON.stringify({ data, merge: !!(options && options.merge) }),
  });
}

export async function updateDoc(ref, data) {
  await apiFetch(`/${encodeURIComponent(ref.path)}/${encodeURIComponent(ref.id)}`, {
    method: "PATCH",
    body: JSON.stringify({ data }),
  });
}

export async function deleteDoc(ref, options = {}) {
  // 🔒 Security (2026-09-11): เพิ่มพารามิเตอร์ options (ไม่บังคับ) — ส่ง body ไปกับ DELETE ได้
  // ใช้ตอนลูกค้าลบออเดอร์ของตัวเอง: ส่ง { customer_name, whatsapp } ไปด้วยเพื่อให้ Server ตรวจเจ้าของ
  // โค้ดเดิมที่เรียก deleteDoc(ref) แบบ 1 พารามิเตอร์ยังทำงานเหมือนเดิม (options เป็น {} ค่าว่าง)
  const fetchOpts = { method: "DELETE" };
  if (options.body !== undefined && options.body !== null) {
    fetchOpts.headers = { "Content-Type": "application/json" };
    fetchOpts.body = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
  }
  await apiFetch(`/${encodeURIComponent(ref.path)}/${encodeURIComponent(ref.id)}`, fetchOpts);
}

// ---------------- onSnapshot (จำลอง realtime ด้วย polling — D1/Worker ไม่มี push แบบ Firestore) ----------------
// ใช้เฉพาะกับ query(collection(db,"orders")) แบบไม่มีเงื่อนไขในแอปนี้ (ตรวจสอบแล้วทั้งโปรเจกต์)
export function onSnapshot(refOrQuery, onNext, onError) {
  let stopped = false;
  let lastSerialized = null;

  async function poll() {
    if (stopped) return;
    try {
      const docs = await fetchDocs(refOrQuery);
      const serialized = JSON.stringify(docs);
      if (serialized !== lastSerialized) {
        lastSerialized = serialized;
        onNext(makeQuerySnap(docs));
      }
    } catch (err) {
      if (onError) onError(err);
    } finally {
      if (!stopped) timer = setTimeout(poll, SNAPSHOT_POLL_MS);
    }
  }

  let timer = setTimeout(poll, 0); // ยิงครั้งแรกทันที เหมือน Firestore ที่ callback แรกมาไวมาก
  return function unsubscribe() {
    stopped = true;
    clearTimeout(timer);
  };
}

// ===================================================
// 🔒 Security (2026-09-11): Customer order lookup helpers
// ใช้ endpoint ใหม่ /api/db/orders/_customer-query และ _customer-list ที่ Server กรองเจ้าของให้
// แทนการโหลด collection "orders" ทั้งหมดมากรองฝั่ง browser แบบเดิม
// (เดิมใช้ getDocs/onSnapshot กับ query(collection(db,"orders")) ทำให้ browser เห็นข้อมูลคนอื่นทั้งหมด)
// ใช้เฉพาะฝั่งลูกค้า (app-user.js, app-promotion.js) เท่านั้น — ฝั่งแอดมินยังใช้ getDocs/onSnapshot เดิม
// ===================================================

// ค้นหาออเดอร์เดียวด้วย receipt_number + customer_name + whatsapp
// Server ตรวจทั้ง 3 ฟิลด์ คืน { exists:true, id, data } ถ้าตรงทั้งหมด ไม่งั้น { exists:false }
// ไม่เคยส่งข้อมูลของคนอื่นมาให้ browser
export async function queryCustomerOrder({ receiptNumber, customerName, whatsapp }) {
  const res = await apiFetch(`/orders/_customer-query`, {
    method: "POST",
    body: JSON.stringify({
      receipt_number: receiptNumber,
      customer_name: customerName,
      whatsapp: whatsapp,
    }),
  });
  if (!res || !res.exists) return { exists: false };
  return { exists: true, id: res.id, data: res.data };
}

// ฟังออเดอร์ทั้งหมดของลูกค้าคนหนึ่ง แบบ polling ทุก 4 วิ (เหมือน onSnapshot เดิม)
// Server กรองเฉพาะออเดอร์ที่เป็นของลูกค้าคนนี้ส่งกลับมา ไม่ส่งข้อมูลคนอื่นมาให้ browser
// คืนฟังก์ชัน unsubscribe — โครงสร้างเหมือน onSnapshot ทุกประการ เพื่อให้สลับเข้าแทนได้ง่าย
//
// ⚠️ 2026-09-17: ปัจจุบัน caller ทั้งหมดย้ายไปใช้ fetchCustomerOrdersOnce แทนแล้ว (เพื่อลด D1 quota)
//   แต่ยังคงไว้ในไฟล์นี้้ไม่ลบ (กฎ "ห้ามลบโค้ดเพียงเพราะคิดว่าไม่ได้ใช้งาน") เผื่ออนาคตต้องการ
//   realtime แบบ polling กลับมาใช้ในจุดอื่น
export function listenCustomerOrders({ customerName, whatsapp }, onNext, onError) {
  let stopped = false;
  let lastSerialized = null;
  let timer;

  async function poll() {
    if (stopped) return;
    try {
      const res = await apiFetch(`/orders/_customer-list`, {
        method: "POST",
        body: JSON.stringify({
          customer_name: customerName,
          whatsapp: whatsapp,
        }),
      });
      const docs = (res && res.docs) || [];
      const serialized = JSON.stringify(docs);
      if (serialized !== lastSerialized) {
        lastSerialized = serialized;
        onNext(makeQuerySnap(docs));
      }
    } catch (err) {
      if (onError) onError(err);
    } finally {
      if (!stopped) timer = setTimeout(poll, SNAPSHOT_POLL_MS);
    }
  }

  timer = setTimeout(poll, 0); // ยิงครั้งแรกทันที เหมือน onSnapshot เดิม
  return function unsubscribe() {
    stopped = true;
    clearTimeout(timer);
  };
}

// ===================================================
// 🔧 (2026-09-17): One-shot fetch สำหรับเรียกดูออเดอร์ของลูกค้า — ไม่ polling
// เป้าหมาย: ลด D1 read quota ที่บวมจากการ polling ทุก 4 วิตลอดเวลา
//   เดิม listenCustomerOrders polling ทุก 4 วิตตลอดที่หน้าเว็บเปิด → กิน quota มาก
//   ใหม่: ดึงครั้งเดียวเมื่อ user action (โหลดหน้า / เข้าแท็บ / กดรีเฟรช / checkout / กลับเข้า tab)
//   ไม่มี polling ต่อเนื่อง — ลูกค้าที่รอ WhatsApp บอกอยู่แล้วไม่ต้องเห็นข้อมูล realtime
//
// คืนค่า: { docs: [{ id, data }], snap: QuerySnap } — snap สำหรับความเข้ากันได้กับ caller เดิม
//   ที่ใช้ snap.forEach(...) / snap.docs / snap.empty / snap.size
// throw error ถ้า fetch ไม่สำเร็จ (caller ต้อง try/catch เอง)
// ===================================================
export async function fetchCustomerOrdersOnce({ customerName, whatsapp }) {
  const res = await apiFetch(`/orders/_customer-list`, {
    method: "POST",
    body: JSON.stringify({
      customer_name: customerName,
      whatsapp: whatsapp,
    }),
  });
  const docs = (res && res.docs) || [];
  return { docs, snap: makeQuerySnap(docs) };
}

// ===================================================
// 🔧 (2026-09-17 Phase 2): getDocsByIds — batch fetch documents หลายอันในครั้งเดียว
// ใช้สำหรับ batch fetch songs ตอนสร้าง ZIP — ลดจำนวน HTTP requests จาก browser → Worker
//   เดิม: 30 songs = 30 getDoc calls = 30 HTTP requests = 30 Worker invocations
//   ใหม่: 30 songs = 1 batch call = 1 HTTP request = 1 Worker invocation (query D1 1 ครั้งด้วย IN)
//
// พารามิเตอร์:
//   collection: "songs" | "playlists" | "categories" | "djs" | "orders" | ...
//   ids: array ของ document id (string)
// คืนค่า: Map<id, docSnap> เพื่อให้ caller เข้าถึงแบบ O(1) ด้วย id
//   - ถ้า id ไม่มีอยู่ใน DB → ไม่อยู่ใน Map (caller เช็คเอง)
//   - แต่ละ docSnap คือ { id, data: () => data, exists: () => true } เหมือน getDoc เดิม
// ===================================================
export async function getDocsByIds(collection, ids) {
  if (!Array.isArray(ids) || ids.length === 0) return new Map();
  // dedupe ก่อนส่งไป server
  const uniqueIds = [...new Set(ids.map(id => String(id)).filter(Boolean))];
  if (uniqueIds.length === 0) return new Map();
  const res = await apiFetch(`/${encodeURIComponent(collection)}/_batch-get`, {
    method: "POST",
    body: JSON.stringify({ ids: uniqueIds }),
  });
  const docs = (res && res.docs) || [];
  // สร้าง Map<id, docSnap> เพื่อให้ caller เข้าถึง O(1)
  const map = new Map();
  for (const d of docs) {
    if (!d || !d.id) continue;
    map.set(d.id, {
      id: d.id,
      exists: () => true,
      data: () => d.data,
    });
  }
  return map;
}
