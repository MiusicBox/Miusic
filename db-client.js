// db-client.js
// ===================================================
// เลียนแบบหน้าตา Firestore Web SDK เฉพาะฟังก์ชันที่โปรเจกต์นี้ใช้จริง (ตรวจสอบครบทุกไฟล์แล้ว):
// collection, doc, getDoc, getDocs, addDoc, setDoc, updateDoc, deleteDoc, query, where, orderBy
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
//
// ────────────────────────────────────────────────────────────────────
// ⚠️  สำหรับ Dev ใหม่: โปรดอ่านส่วนนี้ก่อนแก้ไฟล์นี้  ────────────────
// ────────────────────────────────────────────────────────────────────
// onSnapshot() และ listenCustomerOrders() ยังคง export อยู่ที่ด้านล่างของไฟล์นี้
// แต่ ณ 2026-09-17: **ไม่มี caller จริงในโปรเจกต์แล้ว** (ยืนยันด้วย grep ทั้งโปรเจกต์)
//
//   ประวัติ:
//     - ก่อน 2026-09-17: ใช้ polling ทุก 4 วินาที (SNAPSHOT_POLL_MS) เพื่อจำลอง realtime
//       ตามแบบ Firestore onSnapshot → กิน D1 read quota มาก (1 client = 15 reads/นาที)
//     - 2026-09-17: ทุก caller ย้ายไปใช้ fetchCustomerOrdersOnce() แบบ one-shot แทน
//       (ดึงครั้งเดียวเมื่อ user action: โหลดหน้า / เข้าแท็บ / กดรีเฟรช / checkout)
//
//   ที่ไม่ลบทิ้ง:
//     - กฎของโปรเจกต์: "ห้ามลบโค้ดเพียงเพราะคิดว่าไม่ได้ใช้งาน"
//     - เผื่ออนาคตต้องการ realtime แบบ polling กลับมาใช้ในจุดอื่น
//
//   ⚠️ ถ้าจะใช้ onSnapshot/listenCustomerOrders: ระวัง!
//     - มัน polling ทุก 4 วิ (SNAPSHOT_POLL_MS) ต่อ client ตลอดที่หน้าเปิด
//     - ถ้ามี 100 concurrent clients = 25 req/s → D1 quota หมดเร็ว
//     - แนะนำใช้ fetchCustomerOrdersOnce() แทนถ้าไม่จำเป็นต้อง realtime จริง ๆ
//
//   imports ใน app-user.js (บรรทัด 5) และ app-promotion.js (บรรทัด 22) ยัง import
//   onSnapshot + listenCustomerOrders อยู่ด้วย — เป็น "dead imports" (import แต่ไม่เรียกใช้)
//   ถ้าจะลบ export ออกจากไฟล์นี้ ต้องลบ imports ใน 2 ไฟล์นั้นด้วยพร้อมกัน
//   ไม่งั้น browser โหลด module ไม่ได้ (SyntaxError: missing export)
// ────────────────────────────────────────────────────────────────────

const API_BASE = "/api/db";
// ⚠️ ใช้เฉพาะใน onSnapshot() และ listenCustomerOrders() ด้านล่าง — ทั้งสองฟังก์ชันไม่มี caller จริงแล้ว
//    ถ้าอนาคตจะใช้ polling กลับมา: ลดค่านี้ลง (เช่น 30000 = 30 วิ) เพื่อลด D1 quota
const SNAPSHOT_POLL_MS = 4000;

async function apiFetch(path, options = {}) {
  // 🔧 (2026-09-18 v6 Full System): รองรับ cacheBust option สำหรับ admin fetches
  //   เมื่อ cacheBust=true → เพิ่ม ?nocache=timestamp ใน URL → CDN ไม่ cache (URL เปลี่ยนทุกครั้ง)
  //   ใช้ใน getDocsAdmin() ที่ admin เรียก → แน่ใจว่าเห็นข้อมูลใหม่หลัง invalidateAdminCache
  const { cacheBust, ...fetchOptions } = options;
  const url = API_BASE + path + (cacheBust ? `?nocache=${Date.now()}` : "");

  // 🔒 (Audit Fix H-27): Retry with exponential backoff สำหรับ transient failures
  //   ปัญหาเดิม: fetch 1 ครั้ง → ถ้า 5xx หรือ network fail → throw error ทันที
  //   → user เห็น error toast → ต้องกดลองใหม่เอง
  //   วิธีแก้: retry 3 ครั้ง (1s, 2s, 4s backoff) สำหรับ 5xx + network errors
  //   ไม่ retry สำหรับ 4xx (client error — ไม่น่าจะสำเร็จถ้า retry)
  //   ผลกระทบระบบเดิม: 0% — กรณีสำเร็จ → return เหมือนเดิม (no retry)
  //   กรณี 5xx → retry 3 ครั้งก่อน throw (เพิ่มโอกาสสำเร็จ)
  //   กรณี 4xx → throw เหมือนเดิม (retry ไม่ช่วย)
  const MAX_RETRIES = 3;
  const BACKOFF_MS = [1000, 2000, 4000]; // 1s, 2s, 4s
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        ...fetchOptions,
      });
      let body = null;
      try { body = await res.json(); } catch { /* ไม่มี body หรือไม่ใช่ JSON */ }
      if (!res.ok) {
        // 🔒 (Audit Fix M-3 + M-4): Global 401 interceptor — force re-login เมื่อ session หมดอายุ
        //   ปัญหาเดิม: แต่ละ view handle 401 ต่างกัน → admin stuck เมื่อ session หมด
        //   → กดปุ่มได้แต่ทุกครั้ง fail สับสน
        //   วิธีแก้: ถ้า 401 → ล้าง cookie + redirect ไป login page (global)
        //   ผลกระทบระบบเดิม: 0% — ถ้า session valid → ไม่ทำอะไร (เหมือนเดิม)
        //   ถ้า session หมด → redirect ครั้งเดียว (UX ชัดเจน)
        if (res.status === 401 && typeof window !== "undefined" && window.location.pathname.includes("/admin")) {
          // Only redirect on admin pages — customer pages use 401 for order ID conflicts
          document.cookie = "session_token=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0";
          window.location.reload();
        }
        // 🔒 (H-27): retry เฉพาะ 5xx (server error) — ไม่ retry 4xx (client error)
        if (res.status >= 500 && res.status < 600 && attempt < MAX_RETRIES) {
          console.warn(`[H-27] apiFetch retry ${attempt + 1}/${MAX_RETRIES} for ${path} (HTTP ${res.status})`);
          await new Promise(r => setTimeout(r, BACKOFF_MS[attempt]));
          lastErr = new Error((body && body.error) || `HTTP ${res.status}`);
          if (body && body.code) lastErr.code = body.code;
          continue;
        }
        const err = new Error((body && body.error) || `คำขอไปยังฐานข้อมูลไม่สำเร็จ (HTTP ${res.status})`);
        if (body && body.code) err.code = body.code;
        err.status = res.status; // 4xx = don't retry, 5xx = retry
        throw err;
      }
      return body;
    } catch (fetchErr) {
      // Only retry on network errors (TypeError) — not on HTTP errors that were thrown above
      if (attempt < MAX_RETRIES && fetchErr?.name === "TypeError" && !fetchErr?.status) {
        console.warn(`[H-27] apiFetch network retry ${attempt + 1}/${MAX_RETRIES} for ${path}:`, fetchErr?.message || fetchErr);
        await new Promise(r => setTimeout(r, BACKOFF_MS[attempt]));
        lastErr = fetchErr;
        continue;
      }
      throw fetchErr;
    }
  }
  // ครบ retries → throw last error
  throw lastErr || new Error(`apiFetch failed after ${MAX_RETRIES} retries`);
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

async function fetchDocs(refOrQuery, options = {}) {
  if (refOrQuery.__type === "query" && (refOrQuery.wheres.length || refOrQuery.orderBy)) {
    const res = await apiFetch(`/${encodeURIComponent(refOrQuery.path)}/_query`, {
      method: "POST",
      body: JSON.stringify({ wheres: refOrQuery.wheres, orderBy: refOrQuery.orderBy }),
      ...options,
    });
    return res.docs;
  }
  const res = await apiFetch(`/${encodeURIComponent(refOrQuery.path)}`, options);
  return res.docs;
}

export async function getDocs(refOrQuery) {
  const docs = await fetchDocs(refOrQuery);
  return makeQuerySnap(docs);
}

// 🔧 (2026-09-18 v6 Full System): getDocsAdmin — getDocs ที่ bypass CDN cache
//   ใช้สำหรับ admin fetches หลัง invalidateAdminCache() — แน่ใจว่าเห็นข้อมูลใหม่
//   เพิ่ม ?nocache=timestamp ใน URL → CDN ไม่ cache (URL เปลี่ยนทุกครั้ง)
//   ใช้กับ loadSongs, loadDashboard, openDetailSongs (admin-only flows)
export async function getDocsAdmin(refOrQuery) {
  const docs = await fetchDocs(refOrQuery, { cacheBust: true });
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

// ============================================================================
// 🚀 (2026-09-28 rollback G2): ลบ dead code onSnapshot + listenCustomerOrders
//   ไม่มี caller จริงใน codebase แล้ว (ย้ายไปใช้ fetchCustomerOrdersOnce)
//   ถ้าอนาคตต้องการ realtime: สร้างใหม่จาก fetchCustomerOrdersOnce pattern
// ============================================================================

// 🚀 (2026-09-28 fix): เพิ่ม queryCustomerOrder กลับ — ถูกลบไปพร้อม dead code โดยไม่ตั้งใจ
//   ใช้ใน app-user.js บรรทัด 2113 สำหรับค้นหาออเดอร์เดียว (track order)
//   ถ้าไม่มี export นี้ → SyntaxError → JavaScript ไม่ทำงานทั้งหน้า
// ===================================================
// 🆕 (2026-10-03 v10 — แยก Login / Guest): guest_id ประจำ browser
// -----------------------------------------------------------
// ใช้กับลูกค้าที่ "ไม่ได้ login" เท่านั้น — เป็น UUID v4 ที่สร้างครั้งเดียวแล้วเก็บใน localStorage
//   - ตอน checkout: ส่งไปกับออเดอร์ (Server เก็บเฉพาะเมื่อไม่มี customer session — ถ้า login จะทิ้งค่านี้)
//   - ตอนดูประวัติ: ส่งไปกับ _customer-list คู่กับ WhatsApp → Server คืนเฉพาะ guest order ของ guest_id นี้
// กุญแจนี้ไม่ใช่รหัสผ่าน — ถ้าล้าง browser/เปลี่ยนเครื่อง จะมองไม่เห็นประวัติ guest เดิม
//   (ยังเปิดทีละใบด้วยเลขใบเสร็จ + ชื่อ + เบอร์ ได้เหมือนเดิม)
// ===================================================
// ===================================================
// 🆕 (2026-10-03 v11 — แยกที่เก็บข้อมูลในเครื่อง Login / Guest)
// -----------------------------------------------------------
// ทุกอย่างที่เกี่ยวกับออเดอร์ที่เก็บใน browser (ชื่อ+เบอร์ที่จำไว้, ออเดอร์ล่าสุด, สถานะปิดแถบเตือน,
// id ออเดอร์ที่กำลัง checkout) ต้อง "แยกกัน" ระหว่าง:
//   - Guest (ไม่ได้ login)      → scope = "guest"
//   - สมาชิกที่ login อยู่        → scope = "login:<customer_id>"  (คนละบัญชี = คนละที่เก็บ)
// วิธีทำ: ต่อ scope ท้ายชื่อ key เช่น  music_store_last_order_v1::guest  /  ...::login:abc123
// scope คำนวณ "ทุกครั้งที่เรียก" (ไม่ cache) → login/logout แล้วอ่านคนละ key ทันที
// ใช้ได้กับทั้ง localStorage และ sessionStorage
// หมายเหตุ: ใช้ "miusic_customer_session" (เขียนโดย customer-auth.js) เป็นตัวบอกว่า login อยู่ — แหล่งเดียวกับที่โค้ดเดิมใช้
// ===================================================
const CUSTOMER_SESSION_STORAGE_KEY = "miusic_customer_session";

export function getLoggedInCustomerId() {
  try {
    const raw = localStorage.getItem(CUSTOMER_SESSION_STORAGE_KEY);
    if (!raw) return "";
    const c = JSON.parse(raw);
    return c && c.id ? String(c.id) : "";
  } catch (_) { return ""; }
}

export function getOrderScope() {
  const id = getLoggedInCustomerId();
  return id ? `login:${id}` : "guest";
}

export function scopedStorageKey(baseKey) {
  return `${baseKey}::${getOrderScope()}`;
}

// ย้ายข้อมูลรุ่นเก่า (key ไม่มี scope — ใช้ปนกันทั้ง login/guest) ออกจากเครื่อง ครั้งเดียว
//   - ออเดอร์ล่าสุด (music_store_last_order_v1): ถ้าในออเดอร์มี customer_id → ย้ายไป scope ของบัญชีนั้น,
//     ไม่มี customer_id → ย้ายไป guest (แยกได้ชัดเจนจากข้อมูลในออเดอร์เอง)
//   - ชื่อ/เบอร์ที่จำไว้ + สถานะปิดแถบเตือน: ไม่รู้ว่ามาจาก login หรือ guest → ลบทิ้ง (ลูกค้ากรอกใหม่ครั้งต่อไป)
//   ไม่แตะตะกร้า (music_store_cart_v1) และไม่แตะ miusic_guest_id / miusic_customer_session
const LEGACY_LAST_ORDER_KEY = "music_store_last_order_v1";
const LEGACY_UNSCOPED_KEYS = [
  "music_store_customer_info_v1",
  "music_store_my_orders_info_v1",
  "music_store_banner_dismissed_v1",
  "miusic_track_all_name",
  "miusic_track_all_phone",
];
(function migrateLegacyOrderStorage() {
  try {
    const raw = localStorage.getItem(LEGACY_LAST_ORDER_KEY);
    if (raw) {
      try {
        const rec = JSON.parse(raw);
        const ownerId = rec && rec.order && rec.order.customer_id ? String(rec.order.customer_id) : "";
        const target = `${LEGACY_LAST_ORDER_KEY}::${ownerId ? "login:" + ownerId : "guest"}`;
        if (rec && rec.order && rec.receiptNumber && !localStorage.getItem(target)) {
          localStorage.setItem(target, raw);
        }
      } catch (_) { /* ข้อมูลเสีย → ลบทิ้งด้านล่าง */ }
      localStorage.removeItem(LEGACY_LAST_ORDER_KEY);
    }
    for (const k of LEGACY_UNSCOPED_KEYS) localStorage.removeItem(k);
  } catch (_) { /* localStorage ใช้ไม่ได้ → ข้าม */ }
})();

const GUEST_ID_STORAGE_KEY = "miusic_guest_id";
const GUEST_ID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let _guestIdInMemory = null; // fallback กรณี localStorage ถูกบล็อก (เช่น private mode บางเบราว์เซอร์)

function generateGuestUuidV4() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // fallback สำหรับ browser เก่า — สร้าง UUID v4 จาก crypto.getRandomValues
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}

export function getGuestId() {
  try {
    const stored = localStorage.getItem(GUEST_ID_STORAGE_KEY);
    if (stored && GUEST_ID_REGEX.test(stored)) return stored.toLowerCase();
  } catch (_) { /* localStorage ใช้ไม่ได้ → ใช้ค่าในหน่วยความจำ */ }
  if (_guestIdInMemory) return _guestIdInMemory;
  const fresh = generateGuestUuidV4().toLowerCase();
  _guestIdInMemory = fresh;
  try { localStorage.setItem(GUEST_ID_STORAGE_KEY, fresh); } catch (_) {}
  return fresh;
}

// ค้นหาออเดอร์เดียวด้วย receipt_number + customer_name + whatsapp
// Server ตรวจทั้ง 3 ฟิลด์ คืน { exists:true, id, data } ถ้าตรงทั้งหมด ไม่งั้น { exists:false }
export async function queryCustomerOrder({ receiptNumber, customerName, whatsapp }) {
  const res = await apiFetch(`/orders/_customer-query`, {
    method: "POST",
    body: JSON.stringify({
      receipt_number: receiptNumber,
      customer_name: customerName,
      whatsapp: whatsapp,
    }),
  });
  if (!res || !res.exists) return { exists: false, scopeMismatch: (res && res.scope_mismatch) || null };
  return { exists: true, id: res.id, data: res.data };
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
//
// 🆕 (2026-10-03 v10 — แยก Login / Guest): ขอบเขตของผลลัพธ์ตัดสินที่ Server จาก session cookie
//   - login อยู่ → ได้เฉพาะออเดอร์ของบัญชีนั้น (ชื่อ/เบอร์ที่ส่งไปไม่ถูกใช้ดึงออเดอร์)
//   - ไม่ได้ login (Guest) → ได้เฉพาะ guest order ที่ guest_id ของ browser นี้ + WhatsApp ตรงกัน
//   ส่ง guest_id ไปทุกครั้ง (Server เมินเองถ้า login) — caller เดิมทุกจุดไม่ต้องแก้
export async function fetchCustomerOrdersOnce({ customerName, whatsapp }) {
  const res = await apiFetch(`/orders/_customer-list`, {
    method: "POST",
    body: JSON.stringify({
      customer_name: customerName,
      whatsapp: whatsapp,
      guest_id: getGuestId(),
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
