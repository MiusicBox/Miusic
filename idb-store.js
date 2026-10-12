// /home/z/my-project/Miusic/idb-store.js
// 🆕 (T059): IndexedDB wrapper สำหรับ PWA offline mode
// ============================================================
// วัตถุประสงค์: เก็บ customer orders ใน IndexedDB เพื่อให้ลูกค้าดูออเดอร์เก่าได้ตอน offline
//
// ความปลอดภัย (PII protection):
//   - เก็บเฉพาะ customer_id ปัจจุบัน → ถ้า login เป็นคนอื่น → ข้อมูลเก่าถูก clear
//   - clear ทุกครั้งตอน login/logout (กัน shared device leak)
//   - sanitize ข้อมูลก่อนเก็บ (ไม่เก็บ payment_proof_verified_by, assigned_admin_id, etc.)
//   - ไม่เก็บข้อมูล sensitive อื่น เช่น password_hash, session token
//
// โครงสร้าง IndexedDB:
//   - DB name: "miusic-offline-cache"
//   - Object stores:
//     * "meta" — เก็บ customer_id ปัจจุบัน + cached_at timestamp
//     * "orders" — เก็บ orders ที่ sanitize แล้ว (key = order.id)
//
// ผลกระทบระบบเดิม: 0%
//   - ไฟล์ใหม่ ไม่แตะ service-worker.js หรือ worker/*
//   - ถ้า IndexedDB ไม่รองรับ → fallback ไม่ทำงาน (no-op)
// ============================================================

const IDB = (function () {
  "use strict";

  const DB_NAME = "miusic-offline-cache";
  const DB_VERSION = 1;
  const META_STORE = "meta";
  const ORDERS_STORE = "orders";
  const META_KEY = "current_customer";

  let _dbPromise = null;

  // เปิด IndexedDB (lazy + cache promise)
  function openDB() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") {
        reject(new Error("IndexedDB not supported"));
        return;
      }
      try {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onerror = () => reject(req.error || new Error("openDB failed"));
        req.onupgradeneeded = (event) => {
          const db = event.target.result;
          // meta store — เก็บค่าเดียว (current_customer)
          if (!db.objectStoreNames.contains(META_STORE)) {
            db.createObjectStore(META_STORE, { keyPath: "key" });
          }
          // orders store — keyPath = "id" (order.id)
          if (!db.objectStoreNames.contains(ORDERS_STORE)) {
            const store = db.createObjectStore(ORDERS_STORE, { keyPath: "id" });
            store.createIndex("customer_id", "customer_id", { unique: false });
            store.createIndex("created_at", "created_at", { unique: false });
          }
        };
        req.onsuccess = () => resolve(req.result);
      } catch (err) {
        reject(err);
      }
    }).catch((err) => {
      console.warn("[IDB] openDB failed:", err?.message || err);
      _dbPromise = null; // ล้าง cache เพื่อลองใหม่ครั้งถัดไป
      throw err;
    });
    return _dbPromise;
  }

  // helper: ทำ transaction + request เป็น promise
  function txPromise(storeName, mode, fn) {
    return openDB().then((db) => new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(storeName, mode);
        const store = tx.objectStore(storeName);
        const request = fn(store);
        tx.oncomplete = () => resolve(request?.result);
        tx.onerror = () => reject(tx.error || new Error("tx failed"));
        tx.onabort = () => reject(tx.error || new Error("tx aborted"));
      } catch (err) {
        reject(err);
      }
    }));
  }

  // ============================================================
  // Meta store — เก็บ current_customer_id + cached_at
  // ============================================================

  // บันทึก customer_id ปัจจุบัน → ใช้ตอนตรวจว่า cache เป็นของ customer คนนี้ไหม
  function setCurrentCustomerId(customerId) {
    return txPromise(META_STORE, "readwrite", (store) => {
      return store.put({
        key: META_KEY,
        customer_id: customerId,
        cached_at: new Date().toISOString(),
      });
    }).catch((err) => {
      console.warn("[IDB] setCurrentCustomerId failed:", err?.message || err);
    });
  }

  // อ่าน customer_id ปัจจุบันจาก cache → ใช้ตรวจว่า cache เป็นของ customer คนนี้ไหม
  function getCurrentCustomerId() {
    return txPromise(META_STORE, "readonly", (store) => {
      return store.get(META_KEY);
    }).then((row) => row?.customer_id || null).catch((err) => {
      console.warn("[IDB] getCurrentCustomerId failed:", err?.message || err);
      return null;
    });
  }

  // ============================================================
  // Orders store — cache orders ของ customer ปัจจุบัน
  // ============================================================

  // Sanitize order ก่อนเก็บ — ลบ fields ที่มี PII ฝั่ง staff
  //   (defense-in-depth: server ก็ sanitize ก่อนส่งให้ customer อยู่แล้ว
  //    แต่เราเช็คอีกทีเผื่อ cache มาจาก source อื่น)
  function sanitizeOrderForCache(order) {
    if (!order || typeof order !== "object") return null;
    const safe = { ...order };
    // ลบ sensitive fields (ถ้ามี)
    delete safe.payment_proof_verified_by;
    delete safe.assigned_admin_id;
    delete safe.payment_proof_id;
    // ลบ status_history.by/by_name (PII ของ admin)
    if (Array.isArray(safe.status_history)) {
      safe.status_history = safe.status_history.map(h => ({
        status: h.status,
        at: h.at,
        note: h.note,
        // ไม่เก็บ by / by_name (admin UUID + display name)
      }));
    }
    // เพิ่ม _cached_at เพื่อบอกว่าข้อมูลนี้เก่าแค่ไหน
    safe._cached_at = new Date().toISOString();
    return safe;
  }

  // บันทึก orders ลง cache (bulk) — แทนที่ทั้งหมดก่อน
  function cacheOrders(orders, customerId) {
    if (!Array.isArray(orders)) return Promise.resolve();
    return openDB().then((db) => new Promise((resolve, reject) => {
      try {
        const tx = db.transaction([META_STORE, ORDERS_STORE], "readwrite");
        // 1. clear orders store (ล้างของเก่า)
        tx.objectStore(ORDERS_STORE).clear();
        // 2. insert orders ใหม่ (sanitize ก่อน)
        const ordersStore = tx.objectStore(ORDERS_STORE);
        for (const order of orders) {
          const safe = sanitizeOrderForCache(order);
          if (safe) {
            // ใส่ customer_id ลงในแต่ละ order (เพื่อ index)
            if (!safe.customer_id && customerId) safe.customer_id = customerId;
            ordersStore.put(safe);
          }
        }
        // 3. update meta — customer_id + cached_at
        tx.objectStore(META_STORE).put({
          key: META_KEY,
          customer_id: customerId,
          cached_at: new Date().toISOString(),
          orders_count: orders.length,
        });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error("cacheOrders tx failed"));
        tx.onabort = () => reject(tx.error || new Error("cacheOrders tx aborted"));
      } catch (err) {
        reject(err);
      }
    })).catch((err) => {
      console.warn("[IDB] cacheOrders failed:", err?.message || err);
    });
  }

  // อ่าน orders ทั้งหมดจาก cache (สำหรับ offline mode)
  function getCachedOrders() {
    return txPromise(ORDERS_STORE, "readonly", (store) => {
      return store.getAll();
    }).then((orders) => {
      // re-sort by created_at DESC (เหมือน server response)
      return (orders || []).sort((a, b) => {
        const aTime = a?.created_at ? new Date(a.created_at).getTime() : 0;
        const bTime = b?.created_at ? new Date(b.created_at).getTime() : 0;
        return bTime - aTime;
      });
    }).catch((err) => {
      console.warn("[IDB] getCachedOrders failed:", err?.message || err);
      return [];
    });
  }

  // อ่าน cached_at timestamp (บอกว่าข้อมูลเก่าแค่ไหน)
  function getCachedAt() {
    return txPromise(META_STORE, "readonly", (store) => {
      return store.get(META_KEY);
    }).then((row) => row?.cached_at || null).catch(() => null);
  }

  // ============================================================
  // Clear — ใช้ตอน logout / login เป็น customer คนอื่น
  // ============================================================

  // ล้าง cache ทั้งหมด (meta + orders)
  function clearAll() {
    return openDB().then((db) => new Promise((resolve, reject) => {
      try {
        const tx = db.transaction([META_STORE, ORDERS_STORE], "readwrite");
        tx.objectStore(META_STORE).clear();
        tx.objectStore(ORDERS_STORE).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error("clearAll tx failed"));
        tx.onabort = () => reject(tx.error || new Error("clearAll tx aborted"));
      } catch (err) {
        reject(err);
      }
    })).catch((err) => {
      console.warn("[IDB] clearAll failed:", err?.message || err);
    });
  }

  // ตรวจว่า cache ปัจจุบันเป็นของ customer_id นี้ไหม
  //   ถ้าไม่ใช่ → return false (caller ควร clear + ใช้ cache ใหม่)
  function isCacheForCustomer(customerId) {
    return getCurrentCustomerId().then((cached) => {
      if (!cached || !customerId) return false;
      return cached === customerId;
    }).catch(() => false);
  }

  return {
    setCurrentCustomerId,
    getCurrentCustomerId,
    cacheOrders,
    getCachedOrders,
    getCachedAt,
    clearAll,
    isCacheForCustomer,
    sanitizeOrderForCache,
  };
})();

// expose ใน window สำหรับใช้ทั่วไป
if (typeof window !== "undefined") {
  window.IDB = IDB;
}
