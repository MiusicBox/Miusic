// app-promotion.js — ไฟล์รวมระบบ ลดราคา + โปรโมชั่น + ออเดอร์ของฉัน + helper คำนวณราคา
// ===================================================
// ไฟล์นี้รวม 4 ระบบเข้าด้วยกัน:
//   1. PRICING HELPERS (คำนวณส่วนลด/โปรโมชั่น) — ใช้ทั้งฝั่ง customer และ admin
//   2. DISCOUNTS CRUD (admin จัดการลดราคา per-song/per-playlist)
//   3. PROMOTIONS CRUD (admin จัดการโปรโมชั่น cart-wide)
//   4. MY ORDERS VIEW (ลูกค้าติดตามออเดอร์ของตัวเองแบบ realtime)
//
// กฎสำคัญ (สอดคล้องกับที่ผู้ใช้ระบุ):
//   1. เพลงที่มี "ราคาลด" อยู่แล้ว → ห้ามนำมาคิดโปรโมชั่นซ้ำ
//   2. โปรโมชั่นที่ active และอยู่ในช่วงวันเริ่ม/สิ้นสุดเท่านั้นที่ใช้ได้
//   3. ถ้าหมดเวลา discount หรือ promotion → กลับไปใช้ราคาปกติอัตโนมัติ
//   4. Order บันทึกราคาจริง ณ เวลาสั่ง (snapshot) — Admin แก้ promotion ภายหลัง Order เก่าไม่เปลี่ยนราคา
//   5. Best discount wins — ถ้ามีหลายโปรโมชั่นเข้าเงื่อนไข → เลือกอันที่ลดมากที่สุด
//
// หมายเหตุด้าน back-compat:
//   - order.total ยังคงไว้ (ตั้งเท่ากับ final_total) ให้โค้ดเดิมใน orders.js ที่อ่าน order.total ยังทำงานได้
//   - field ใหม่: subtotal, discount_amount, promotion_applied (object หรือ null), final_total
// ===================================================
import { db, auth } from "./firebase-init.js?v=20260905-fix1";
// ────────────────────────────────────────────────────────────────────────────
// ⚠️  สำหรับ Dev ใหม่: อ่านก่อนแก้ import block นี้  ────────────────────────
// ────────────────────────────────────────────────────────────────────────────
// onSnapshot และ listenCustomerOrders ใน import ด้านล่างเป็น "DEAD IMPORTS"
// คือ import เข้ามาแต่ **ไม่มีการเรียกใช้จริง** ในไฟล์ app-promotion.js ทั้งหมด (ยืนยันด้วย grep)
//
//   ประวัติ:
//     - ก่อน 2026-09-17: เคยใช้ listenCustomerOrders ในส่วน PART 4: MY ORDERS VIEW
//       (สำหรับ polling ออเดอร์ของลูกค้าแบบ realtime)
//     - 2026-09-17: ย้ายไปใช้ fetchCustomerOrdersOnce() แบบ one-shot แทน (ลด D1 quota)
//
//   ที่ไม่ลบ imports ทิ้ง:
//     - กฎของโปรเจกต์: "ห้ามลบโค้ดเพียงเพราะคิดว่าไม่ได้ใช้งาน"
//     - เผื่ออนาคตจะใช้ onSnapshot/listenCustomerOrders จริง ๆ
//
//   ⚠️ ถ้าจะลบ imports ทิ้ง:
//      - ต้องลบ exports ใน db-client.js ด้วย (ดูคอมเมนต์ DEAD CODE ใน db-client.js)
//      - และลบ imports ใน app-user.js บรรทัด 5 ด้วย (มี dead imports เหมือนกัน)
//      - ไม่งั้นไม่พัง (เพราะไม่ได้ใช้) แต่เป็น code smell ถ้าเหลืออยู่ฝั่งเดียว
// ────────────────────────────────────────────────────────────────────────────
import {
  collection, doc, getDocs, setDoc, updateDoc, deleteDoc, query,
  // 🔧 (2026-09-17): เพิ่ม fetchCustomerOrdersOnce สำหรับ one-shot fetch (ไม่ polling) ลด D1 quota
  //    ↑ ↑ ↑ ฟังก์ชันนี้แหละที่ใช้จริงในไฟล์นี้ (แทน listenCustomerOrders เดิม) ใน PART 4: MY ORDERS VIEW
  fetchCustomerOrdersOnce,
  // 🆕 (T014): เพิ่ม queryCustomerOrder สำหรับ "ค้นหาด้วยเลขใบเสร็จ" ใน tab ออเดอร์
  //    ย้ายมาจาก modal เดิม (trackOrderBtn → openTrackOrder → handleTrackOrderSubmit) ที่ถูกลบใน T014
  //    ใช้ร่วมกับ window.showReceipt เพื่อแสดงรายละเอียดออเดอร์เดียว (เหมือน renderMyOrdersList ปุ่ม "ดูใบเสร็จ")
  queryCustomerOrder
// 🔧 (2026-09-17 v2): เพิ่ม ?v=20260917-polling-fix บังคับ browser โหลด db-client.js ใหม่ (กัน cache เก่า)
} from "./db-client.js?v=20261003-login-guest-v10";

// ============================================================================
// PART 1: PRICING HELPERS (คำนวณส่วนลด + โปรโมชั่น)
// ============================================================================

// ---------------- ตัวช่วยเช็ควันที่ ----------------
function isWithinDateRange(startIso, endIso, nowMs) {
  const now = (nowMs != null) ? nowMs : Date.now();
  if (startIso) {
    const t = new Date(startIso).getTime();
    if (!isNaN(t) && now < t) return false;
  }
  if (endIso) {
    const t = new Date(endIso).getTime();
    if (!isNaN(t) && now > t) return false;
  }
  return true;
}

// ---------------- เก็บ cache ของ discounts/promotions ----------------
let _discountsCache = null;
let _promotionsCache = null;
let _discountsAllCache = null;
let _promotionsAllCache = null;

// 🔧 (2026-09-17 Phase 1): TTL สำหรับ cache ฝั่ง admin view — ลด D1 reads ตอนเข้า view ซ้ำ ๆ
// TTL 60 วินาที — ถ้า admin เพิ่งเข้า view นี้ไม่ถึง 60 วิ จะใช้ cache ไม่ fetch ใหม่
// ถ้า admin save/delete → clearPricingCache() ล้าง timestamp → fetch ใหม่ทันที
const ADMIN_VIEW_CACHE_TTL_MS = 60 * 1000;
let _discountsAllCacheAt = 0;       // timestamp ของ cache ล่าสุด (fetchAllDiscounts)
let _promotionsAllCacheAt = 0;      // timestamp ของ cache ล่าสุด (fetchAllPromotions)
let _songsAllCacheAt = 0;           // timestamp ของ SONGS_CACHE ล่าสุด (disc_loadData)
let _playlistsAllCacheAt = 0;       // timestamp ของ PLAYLISTS_CACHE ล่าสุด (disc_loadData)
let _categoriesAllCacheAt = 0;      // timestamp ของ CATEGORIES_CACHE ล่าสุด (promo_loadData)

// 🔧 (2026-09-22 Batch 7 fix Bug #2): TTL สำหรับ customer-side cache (_discountsCache, _promotionsCache)
//   ปัญหา: cache ไม่มี TTL → แอดมินเปลี่ยนราคา → ลูกค้ายังเห็นราคาเก่า → checkout จ่ายราคาใหม่ → ลูกค้าโวยวาย
//   วิธีแก้: เพิ่ม timestamp ให้ cache → ครบ 5 นาที → force refresh จาก DB
//   ผลกระทบระบบเดิม: 0% — caller เดิมที่ไม่ส่ง forceRefresh จะได้ behavior เดิม + TTL
//     ถ้าภายใน 5 นาที → ใช้ cache (เหมือนเดิม)
//     ถ้าเกิน 5 นาที → ถือว่า cache หมดอายุ → fetch ใหม่จาก DB
const CUSTOMER_CACHE_TTL_MS = 5 * 60 * 1000; // 5 นาที — สมดุลระหว่าง freshness + D1 reads
let _discountsCacheAt = 0;          // timestamp ของ _discountsCache ล่าสุด
let _promotionsCacheAt = 0;          // timestamp ของ _promotionsCache ล่าสุด

// ---------------- ดึง discount ที่ active ทั้งหมด ----------------
export async function fetchActiveDiscounts(forceRefresh) {
  // 🔧 (2026-09-22 Batch 7 fix Bug #2): ตรวจ TTL ก่อนใช้ cache
  //   เดิม: if (_discountsCache && !forceRefresh) → ใช้ cache ตลอด (ไม่มี TTL)
  //   ใหม่: เพิ่มเช็ค timestamp → ครบ 5 นาที → treat as cache miss → fetch ใหม่
  const now = Date.now();
  const cacheExpired = _discountsCacheAt === 0 || (now - _discountsCacheAt) >= CUSTOMER_CACHE_TTL_MS;
  if (_discountsCache && !forceRefresh && !cacheExpired) return _discountsCache;
  try {
    const snap = await getDocs(collection(db, "discounts"));
    const items = [];
    snap.forEach(d => {
      const data = d.data();
      if (data && data.active !== false && isWithinDateRange(data.start_at, data.end_at, now)) {
        items.push({ id: d.id, ...data });
      }
    });
    _discountsCache = items;
    _discountsCacheAt = Date.now();  // 🔧 (2026-09-22 Batch 7 fix Bug #2): บันทึก timestamp ตอน cache
    return items;
  } catch (err) {
    console.warn("fetchActiveDiscounts error:", err);
    return [];
  }
}

// ---------------- ดึง promotions ที่ active ทั้งหมด ----------------
export async function fetchActivePromotions(forceRefresh) {
  // 🔧 (2026-09-22 Batch 7 fix Bug #2): ตรวจ TTL ก่อนใช้ cache (เหมือน fetchActiveDiscounts)
  const now = Date.now();
  const cacheExpired = _promotionsCacheAt === 0 || (now - _promotionsCacheAt) >= CUSTOMER_CACHE_TTL_MS;
  if (_promotionsCache && !forceRefresh && !cacheExpired) return _promotionsCache;
  try {
    const snap = await getDocs(collection(db, "promotions"));
    const items = [];
    snap.forEach(d => {
      const data = d.data();
      if (data && data.active !== false && isWithinDateRange(data.start_at, data.end_at, now)) {
        items.push({ id: d.id, ...data });
      }
    });
    items.sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
    _promotionsCache = items;
    _promotionsCacheAt = Date.now();  // 🔧 (2026-09-22 Batch 7 fix Bug #2): บันทึก timestamp ตอน cache
    return items;
  } catch (err) {
    console.warn("fetchActivePromotions error:", err);
    return [];
  }
}

// ---------------- ดึง discounts ทั้งหมด (admin view รวม inactive) ----------------
// 🔧 (2026-09-17 Phase 1): เพิ่มพารามิเตอร์ forceRefresh (optional) และ TTL cache
//   - ถ้ามี cache และยังไม่หมดอายุ (ภายใน 60 วิ) และไม่ได้บังคับ refresh → คืน cache ไม่ fetch
//   - ถ้าหมดอายุหรือบังคับ refresh → fetch ใหม่ + อัปเดต timestamp
//   - signature เดิมยังทำงาน (caller เดิมที่ไม่ส่ง forceRefresh จะได้ behavior เหมือนเดิม + TTL)
export async function fetchAllDiscounts(forceRefresh) {
  const now = Date.now();
  if (_discountsAllCache && !forceRefresh && _discountsAllCacheAt && (now - _discountsAllCacheAt) < ADMIN_VIEW_CACHE_TTL_MS) {
    return _discountsAllCache;  // ใช้ cache ไม่ fetch ใหม่
  }
  try {
    const snap = await getDocs(collection(db, "discounts"));
    const items = [];
    snap.forEach(d => items.push({ id: d.id, ...d.data() }));
    items.sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""));
    _discountsAllCache = items;
    _discountsAllCacheAt = now;
    return items;
  } catch (err) {
    console.warn("fetchAllDiscounts error:", err);
    return [];
  }
}

export async function fetchAllPromotions(forceRefresh) {
  const now = Date.now();
  if (_promotionsAllCache && !forceRefresh && _promotionsAllCacheAt && (now - _promotionsAllCacheAt) < ADMIN_VIEW_CACHE_TTL_MS) {
    return _promotionsAllCache;
  }
  try {
    const snap = await getDocs(collection(db, "promotions"));
    const items = [];
    snap.forEach(d => items.push({ id: d.id, ...d.data() }));
    items.sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""));
    _promotionsAllCache = items;
    _promotionsAllCacheAt = now;
    return items;
  } catch (err) {
    console.warn("fetchAllPromotions error:", err);
    return [];
  }
}

// ---------------- ล้าง cache (หลัง admin save/delete) ----------------
// 🔧 (2026-09-17 Phase 1): ล้าง timestamp ด้วย เพื่อให้ fetch ครั้งถัดไป fetch ใหม่จริง
export function clearPricingCache() {
  _discountsCache = null;
  _promotionsCache = null;
  _discountsAllCache = null;
  _promotionsAllCache = null;
  _discountsAllCacheAt = 0;
  _promotionsAllCacheAt = 0;
  _songsAllCacheAt = 0;
  _playlistsAllCacheAt = 0;
  _categoriesAllCacheAt = 0;
  // 🔧 (2026-09-22 Batch 7 fix Bug #2): ล้าง customer-side TTL timestamps ด้วย
  //   ถ้าไม่ล้าง → cache จะถือว่ายัง "ภายใน 5 นาที" → ใช้ค่า null แทน fetch ใหม่ → bug
  _discountsCacheAt = 0;
  _promotionsCacheAt = 0;
}

// ---------------- หา discount ที่ active ของ song/playlist ----------------
export function findActiveDiscountFor({ targetType, targetId, discounts } = {}) {
  if (!targetType || !targetId) return null;
  const list = discounts || _discountsCache || [];
  return list.find(d => d.target_type === targetType && d.target_id === targetId) || null;
}

// ---------------- คำนวณราคาหลัง discount ของ item เดียว ----------------
export function applyDiscountToPrice(originalPrice, discount) {
  if (!discount || typeof originalPrice !== "number" || isNaN(originalPrice)) {
    return { finalPrice: originalPrice, discountAmount: 0, hasDiscount: false };
  }
  const value = Number(discount.discount_value) || 0;
  let finalPrice = originalPrice;
  if (discount.discount_type === "percent") {
    const pct = Math.max(0, Math.min(100, value));
    finalPrice = Math.round(originalPrice * (100 - pct) / 100);
  } else if (discount.discount_type === "fixed") {
    finalPrice = Math.max(0, originalPrice - value);
  }
  finalPrice = Math.round(finalPrice);
  const discountAmount = Math.max(0, originalPrice - finalPrice);
  return { finalPrice, discountAmount, hasDiscount: discountAmount > 0 };
}

// ---------------- ตรวจสอบว่า item อยู่ในโปรโมชั่นหรือไม่ ----------------
export function isItemInPromotionScope(item, promotion) {
  if (!promotion) return false;
  const appliesTo = promotion.applies_to || "all";
  // 🚀 (2026-09-28 fix H-7): เพิ่ม scope "playlist" — สำหรับโปรโมชันซื้อยกเพลย์ลิสต์
  if (appliesTo === "playlist") {
    // ใช้ได้เฉพาะ playlist items เท่านั้น
    return item.kind === "playlist";
  }
  if (appliesTo === "all") return true;
  if (appliesTo === "category") {
    if (item.kind && item.kind !== "song") return false;
    const catId = item.category_id || item.categoryId || null;
    if (!catId || !promotion.category_id) return false;
    return catId === promotion.category_id;
  }
  return false;
}

// 🚀 (2026-09-28 fix H-7): Helper หา tier ที่ใช้ได้จาก array tiers
//   tiers: [{ min_quantity: 2, discount_percent: 10 }, ...]
//   playlistCount: จำนวนเพลย์ลิสต์ในตะกร้า
//   return: tier ที่ min_quantity มากสุดที่ยัง ≤ playlistCount, หรือ null ถ้าไม่มี tier ที่ผ่าน
function findApplicableTier(tiers, playlistCount) {
  if (!Array.isArray(tiers) || tiers.length === 0) return null;
  // sort จาก min_quantity มาก → น้อย เพื่อหา tier ที่ min_quantity สูงสุดที่ยัง ≤ playlistCount
  const sorted = [...tiers]
    .filter(t => t && Number(t.min_quantity) > 0 && Number(t.discount_percent) >= 0)
    .sort((a, b) => Number(b.min_quantity) - Number(a.min_quantity));
  for (const tier of sorted) {
    if (playlistCount >= Number(tier.min_quantity)) {
      return {
        min_quantity: Number(tier.min_quantity),
        discount_percent: Number(tier.discount_percent),
      };
    }
  }
  return null;
}

// ---------------- คำนวณ promotion ที่เข้าเงื่อนไขและเลือกอันที่ลดมากที่สุด ----------------
// 🚀 (2026-09-29 STACK): เปลี่ยนนโยบายจาก "best-wins" → "scope-stack"
//   - แบ่ง promotions ออกเป็น scope "playlist" (applies_to=playlist) และ scope "song" (applies_to=all/category)
//   - ภายในแต่ละ scope ยังเลือกอันเดียวที่ลดมากสุด (best within scope)
//   - แล้ว "บวก" ส่วนลดของทั้งสอง scope เข้าด้วยกัน (stack)
//   - กัน double dip: items ที่มี item-level discount จะถูก exclude ทุกกรณี
//   - กัน over-discount: ผลรวม promo discount ≤ discountSubtotal (cap ที่ subtotal)
export function computeBestPromotion(items, promotions, options) {
  const orderType = options?.orderType || null;
  if (!Array.isArray(items) || items.length === 0 || !Array.isArray(promotions) || promotions.length === 0) {
    const subtotal = (items || []).reduce((s, it) => s + (Number(it.price) || 0), 0);
    return { bestPromotion: null, eligibleCount: 0, discountAmount: 0, subtotal, appliedTier: null };
  }
  const subtotal = items.reduce((s, it) => s + (Number(it.price) || 0), 0);

  // 🚀 (STACK): เก็บผลลัพธ์แยกตาม scope เพื่อจะ stack ที่หลัง
  //   - playlistScope: โปรโมชั่นที่ applies_to="playlist" (ปัจจุบัน = playlist_tiered_percent เท่านั้น)
  //   - songScope: โปรโมชั่นที่ applies_to="all" หรือ "category" (cart_percent, cart_fixed, buy_x_get_y_percent)
  //   - โปรโมชั่นที่ไม่ตรง scope ใด (เช่น playlist_tiered_percent กับ order_type=single) → skip
  let playlistScopeBest = null; // { promo, eligibleItems, discount, tier }
  let songScopeBest = null;

  for (const promo of promotions) {
    // 🚀 (H-7): กรอง playlist_tiered_percent ตาม order_type
    if (promo.type === "playlist_tiered_percent" && orderType && orderType !== "playlist" && orderType !== "mixed") {
      continue;
    }
    const eligibleItems = items.filter(it => {
      if (it._hadDiscount) return false;
      if (it.kind === "playlist") {
        if ((promo.applies_to || "all") === "playlist") return true;
        return false;
      }
      return isItemInPromotionScope(it, promo);
    });
    const eligibleCount = eligibleItems.length;
    if (eligibleCount === 0) continue;
    if (promo.min_quantity && eligibleCount < promo.min_quantity) continue;
    const eligibleSubtotal = eligibleItems.reduce((s, it) => s + (Number(it.price) || 0), 0);
    if (promo.min_subtotal && eligibleSubtotal < promo.min_subtotal) continue;
    let promoDiscount = 0;
    let appliedTier = null;
    if (promo.type === "cart_percent") {
      const pct = Math.max(0, Math.min(100, Number(promo.discount_value) || 0));
      promoDiscount = Math.round(eligibleSubtotal * pct / 100);
    } else if (promo.type === "cart_fixed") {
      promoDiscount = Math.min(eligibleSubtotal, Math.round(Number(promo.discount_value) || 0));
    } else if (promo.type === "buy_x_get_y_percent") {
      const pct = Math.max(0, Math.min(100, Number(promo.discount_value) || 0));
      promoDiscount = Math.round(eligibleSubtotal * pct / 100);
    } else if (promo.type === "playlist_tiered_percent") {
      const playlistCount = eligibleItems.filter(it => it.kind === "playlist").length;
      if (playlistCount === 0) continue;
      const tier = findApplicableTier(promo.tiers, playlistCount);
      if (!tier) continue;
      const pct = Math.max(0, Math.min(100, tier.discount_percent));
      promoDiscount = Math.round(eligibleSubtotal * pct / 100);
      appliedTier = tier;
    } else {
      continue;
    }
    // 🚀 (STACK): แยก scope เพื่อ stack ที่หลัง — best within scope ยังเลือกอันเดียวที่ลดมากสุด
    const scopeBucket = (promo.applies_to === "playlist") ? "playlist" : "song";
    const candidate = { promo, eligibleItems, eligibleCount, discount: promoDiscount, tier: appliedTier };
    if (scopeBucket === "playlist") {
      if (!playlistScopeBest || promoDiscount > playlistScopeBest.discount) {
        playlistScopeBest = candidate;
      }
    } else {
      if (!songScopeBest || promoDiscount > songScopeBest.discount) {
        songScopeBest = candidate;
      }
    }
  }

  // 🚀 (STACK): รวมส่วนลดของทั้งสอง scope แล้ว cap ที่ subtotal (กัน over-discount)
  let totalPromoDiscount = 0;
  let appliedPromosList = []; // array ของ { id, name, type, ... } — เก็บไว้บันทึกใน order
  let totalEligibleCount = 0;

  if (playlistScopeBest && playlistScopeBest.discount > 0) {
    totalPromoDiscount += playlistScopeBest.discount;
    totalEligibleCount += playlistScopeBest.eligibleCount;
    appliedPromosList.push({
      id: playlistScopeBest.promo.id,
      name: playlistScopeBest.promo.name || "",
      type: playlistScopeBest.promo.type || "",
      discount_value: Number(playlistScopeBest.promo.discount_value) || 0,
      applies_to: playlistScopeBest.promo.applies_to || "all",
      category_id: playlistScopeBest.promo.category_id || null,
      scope: "playlist",
      eligible_count: playlistScopeBest.eligibleCount,
      discount_amount: playlistScopeBest.discount,
      tier_applied: playlistScopeBest.tier || null,
    });
  }
  if (songScopeBest && songScopeBest.discount > 0) {
    totalPromoDiscount += songScopeBest.discount;
    totalEligibleCount += songScopeBest.eligibleCount;
    appliedPromosList.push({
      id: songScopeBest.promo.id,
      name: songScopeBest.promo.name || "",
      type: songScopeBest.promo.type || "",
      discount_value: Number(songScopeBest.promo.discount_value) || 0,
      applies_to: songScopeBest.promo.applies_to || "all",
      category_id: songScopeBest.promo.category_id || null,
      scope: "song",
      eligible_count: songScopeBest.eligibleCount,
      discount_amount: songScopeBest.discount,
      tier_applied: null,
    });
  }

  // 🛡️ Cap: ส่วนลดรวมจาก promo ต้องไม่เกิน subtotal
  if (totalPromoDiscount > subtotal) {
    totalPromoDiscount = subtotal;
  }

  // 🚀 (STACK): bestPromotion ยังคงเป็น "อันหลัก" เพื่อ backward-compat กับ caller เดิม
  //   - เลือกอันที่ให้ discount มากสุดเป็น bestPromotion
  //   - appliedTier ตาม bestPromotion
  //   - ค่าใหม่ promotionsApplied (array) ใช้ตอนบันทึก order จริง ๆ
  let bestPromotion = null;
  let bestTier = null;
  let bestDiscount = 0;
  for (const p of appliedPromosList) {
    if (p.discount_amount > bestDiscount) {
      bestDiscount = p.discount_amount;
      bestPromotion = {
        id: p.id, name: p.name, type: p.type,
        discount_value: p.discount_value, applies_to: p.applies_to,
        category_id: p.category_id,
      };
      bestTier = p.tier_applied;
    }
  }

  return {
    bestPromotion,
    eligibleCount: totalEligibleCount,
    discountAmount: totalPromoDiscount,
    subtotal,
    appliedTier: bestTier,
    // 🚀 (STACK): ฟิลด์ใหม่ — array ของทุก promo ที่ apply (อาจมี 0, 1, หรือ 2 ตัว)
    promotionsApplied: appliedPromosList,
  };
}

// ---------------- คำนวณราคาสุดท้ายของตะกร้า ----------------
export function computeCartPricing(cartItems, discounts, promotions, options) {
  // 🚀 (2026-09-28 fix H-7): รับ options.orderType → ส่งให้ computeBestPromotion
  //   (เพื่อ filter โปรโมชัน playlist_tiered_percent เฉพาะ order_type="playlist" / "mixed")
  // 🚀 (2026-09-29 STACK): รองรับการ stack 2 โปร (playlist-scope + song-scope)
  //   - promotionsApplied เป็น array ของทุก promo ที่ apply (0, 1, หรือ 2 ตัว)
  //   - promotionApplied (singular) ยังคงไว้เพื่อ backward-compat กับ caller เดิม
  //     — เลือกอันที่ให้ discount_amount มากสุด
  const orderType = options?.orderType || null;
  const dList = discounts || _discountsCache || [];
  const pList = promotions || _promotionsCache || [];
  if (!Array.isArray(cartItems) || cartItems.length === 0) {
    return { subtotal: 0, discountSubtotal: 0, itemDiscountAmount: 0, promoDiscountAmount: 0, discountAmount: 0, promotionApplied: null, promotionsApplied: [], finalTotal: 0, items: [] };
  }
  const itemsWithDiscount = cartItems.map(it => {
    const originalPrice = Number(it.price) || 0;
    let discount = null;
    if (it.kind === "playlist") {
      discount = findActiveDiscountFor({ targetType: "playlist", targetId: it.playlist_id || it.id, discounts: dList });
    } else {
      discount = findActiveDiscountFor({ targetType: "song", targetId: it.song_id || it.id, discounts: dList });
    }
    const { finalPrice, discountAmount, hasDiscount } = applyDiscountToPrice(originalPrice, discount);
    return {
      ...it,
      original_price: originalPrice,
      discount_price: finalPrice,
      item_discount: discountAmount,
      _hadDiscount: hasDiscount,
      _discountMeta: discount || null
    };
  });
  const subtotal = itemsWithDiscount.reduce((s, it) => s + it.original_price, 0);
  const discountSubtotal = itemsWithDiscount.reduce((s, it) => s + it.discount_price, 0);
  const itemDiscountAmount = subtotal - discountSubtotal;
  const promoInput = itemsWithDiscount.map(it => ({ ...it, price: it.discount_price }));
  // 🚀 (H-7): ส่ง orderType เข้า computeBestPromotion
  // 🚀 (STACK): รับ promotionsApplied (array) และ bestPromotion (object, backward-compat)
  const computeResult = computeBestPromotion(promoInput, pList, { orderType });
  const promoDiscountAmount = computeResult.discountAmount;
  const promotionsApplied = Array.isArray(computeResult.promotionsApplied) ? computeResult.promotionsApplied.map(p => ({
    ...p,
    snapshot_at: new Date().toISOString()
  })) : [];

  // 🛡️ Cap: promo discount ต้องไม่เกิน discountSubtotal (กัน finalTotal เป็นลบ)
  let cappedPromoDiscount = promoDiscountAmount;
  if (cappedPromoDiscount > discountSubtotal) {
    cappedPromoDiscount = discountSubtotal;
  }

  const finalTotal = Math.max(0, discountSubtotal - cappedPromoDiscount);
  const discountAmount = itemDiscountAmount + cappedPromoDiscount;

  // 🚀 (STACK): promotionApplied (singular) — เลือกอันที่ให้ discount_amount มากสุด (backward-compat)
  //   ถ้ามี 2 โปร stack → promotionApplied จะเป็น "อันที่ลดมากสุด"
  //   แต่ promotionsApplied (พหูพจน์) จะเก็บครบทั้งคู่
  let promotionApplied = null;
  let maxDiscountSeen = 0;
  for (const p of promotionsApplied) {
    if (p.discount_amount > maxDiscountSeen) {
      maxDiscountSeen = p.discount_amount;
      promotionApplied = {
        id: p.id,
        name: p.name || "",
        type: p.type || "",
        discount_value: Number(p.discount_value) || 0,
        applies_to: p.applies_to || "all",
        category_id: p.category_id || null,
        eligible_count: p.eligible_count,
        discount_amount: p.discount_amount,
        tier_applied: p.tier_applied || null,
        snapshot_at: p.snapshot_at,
      };
    }
  }

  return {
    subtotal, discountSubtotal, itemDiscountAmount, promoDiscountAmount: cappedPromoDiscount,
    discountAmount, promotionApplied, promotionsApplied, finalTotal, items: itemsWithDiscount
  };
}

// ---------------- ฟอร์แมตวันที่สำหรับแสดงในหน้า admin ----------------
// 🟢 (Audit Fix M-23): timezone display — แสดง label "เวลาท้องถิ่น" เพื่อความชัดเจน
export function formatDateTime(iso) {
  if (!iso) return "-";
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "-";
    // 🟢 (M-23): เพิ่ม label "เวลาท้องถิ่น" เพื่อให้ admin รู้ว่าแสดงตาม timezone เครื่องตัวเอง
    const formatted = d.toLocaleString("th-TH", {
      day: "2-digit", month: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit"
    });
    return formatted + " (เวลาท้องถิ่น)";
  } catch (e) {
    return "-";
  }
}

// ---------------- ตรวจสอบสถานะ discount/promotion ----------------
export function getDiscountStatus(item) {
  if (!item) return { status: "inactive", label: "ปิดใช้งาน", color: "var(--text-dim)" };
  if (item.active === false) return { status: "inactive", label: "ปิดใช้งาน", color: "var(--text-dim)" };
  const now = Date.now();
  const start = item.start_at ? new Date(item.start_at).getTime() : null;
  const end = item.end_at ? new Date(item.end_at).getTime() : null;
  if (start && !isNaN(start) && now < start) return { status: "scheduled", label: "ยังไม่เริ่ม", color: "#F5B400" };
  if (end && !isNaN(end) && now > end) return { status: "expired", label: "หมดเวลา", color: "var(--danger)" };
  return { status: "active", label: "ใช้งานอยู่", color: "var(--success)" };
}

// ============================================================================
// PART 2: DISCOUNTS CRUD (admin จัดการลดราคา per-song/per-playlist)
// ============================================================================

// ใช้ toast/confirm ตัวเดียวกับหน้า admin หลัก (window.__showToast / window.__openConfirm)
function disc_showToast(msg, type) {
  if (window.__showToast) { window.__showToast(msg, type); return; }
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = msg;
  el.className = "toast show" + (type ? " " + type : "");
  clearTimeout(disc_showToast._t);
  disc_showToast._t = setTimeout(() => { el.className = "toast"; }, 2600);
}
function disc_openConfirm(text, onOk) {
  if (window.__openConfirm) { window.__openConfirm(text, onOk); return; }
  // 🎨 (2026-09-26): ใช้ window.adminConfirm (Promise-based) แทน window.confirm (blocking)
  if (window.adminConfirm) {
    window.adminConfirm(text).then((ok) => { if (ok) onOk(); });
    return;
  }
  // fallback: ถ้าไม่มี adminConfirm ใช้ window.confirm ธรรมดา
  if (window.confirm(text)) onOk();
}
function disc_escapeHtml(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

let DISCOUNTS_CACHE = [];
let SONGS_CACHE = [];
let PLAYLISTS_CACHE = [];
let editingDiscountId = null;
let disc_listenersBound = false;

// 🔧 (2026-09-17 Phase 1): disc_loadData ใช้ TTL cache ลด D1 reads
//   - ถ้า SONGS_CACHE / PLAYLISTS_CACHE / DISCOUNTS_CACHE ยังไม่หมดอายุ (60 วิ) → skip fetch ใช้ cache
//   - ถ้าหมดอายุ → fetch เฉพาะที่ stale
//   - ถ้า admin save/delete → clearPricingCache ล้าง timestamp → ครั้งถัดไป fetch ใหม่
//   ⚠️ Trade-off: admin เพิ่มเพลงใหม่ใน app-admin.js แล้วเข้าหน้า Discounts ภายใน 60 วิ → อาจไม่เห็นเพลงใหม่
//   แต่ถ้ารอเกิน 60 วิ หรือ refresh หน้า → จะเห็นเพลงใหม่ปกติ
async function disc_loadData() {
  try {
    const now = Date.now();
    const isSongsStale = !SONGS_CACHE.length || !_songsAllCacheAt || (now - _songsAllCacheAt) > ADMIN_VIEW_CACHE_TTL_MS;
    const isPlaylistsStale = !PLAYLISTS_CACHE.length || !_playlistsAllCacheAt || (now - _playlistsAllCacheAt) > ADMIN_VIEW_CACHE_TTL_MS;
    const isDiscountsStale = !DISCOUNTS_CACHE.length || !_discountsAllCacheAt || (now - _discountsAllCacheAt) > ADMIN_VIEW_CACHE_TTL_MS;

    // ยิงเฉพาะ fetch ที่ stale แบบ parallel
    const fetches = [];
    const fetchKeys = [];  // ดึง index กลับมาใช้ assign
    if (isSongsStale) { fetches.push(getDocs(collection(db, "songs"))); fetchKeys.push("songs"); }
    if (isPlaylistsStale) { fetches.push(getDocs(collection(db, "playlists"))); fetchKeys.push("playlists"); }
    if (isDiscountsStale) { fetches.push(fetchAllDiscounts()); fetchKeys.push("discounts"); }

    if (fetches.length > 0) {
      const results = await Promise.all(fetches);
      results.forEach((res, i) => {
        const key = fetchKeys[i];
        if (key === "songs") {
          // res คือ QuerySnapshot จาก getDocs
          SONGS_CACHE = res.docs
            .map(d => ({ id: d.id, ...d.data() }))
            .filter(s => s.status !== "hidden");
          _songsAllCacheAt = now;
        } else if (key === "playlists") {
          PLAYLISTS_CACHE = res.docs
            .map(d => ({ id: d.id, ...d.data() }))
            .filter(p => Number(p.price) > 0);
          _playlistsAllCacheAt = now;
        } else if (key === "discounts") {
          // res คือ array จาก fetchAllDiscounts (มี sorting ให้แล้ว)
          DISCOUNTS_CACHE = res;
          // _discountsAllCacheAt ถูกตั้งใน fetchAllDiscounts แล้ว
        }
      });
    }
    // ถ้า fetches.length === 0 → ทุก cache fresh → ไม่ fetch อะไรเลย (ประหยัด quota)
    renderDiscountList();
    populateTargetSelects();
  } catch (err) {
    console.error(err);
    disc_showToast("โหลดข้อมูลไม่สำเร็จ: " + (err.message || err), "error");
  }
}

function renderDiscountList() {
  const wrap = document.getElementById("discountList");
  if (!wrap) return;
  if (DISCOUNTS_CACHE.length === 0) {
    wrap.innerHTML = '<div class="empty-state">ยังไม่มีรายการลดราคา — กด "เพิ่มลดราคา" เพื่อสร้างใหม่</div>';
    return;
  }
  wrap.innerHTML = DISCOUNTS_CACHE.map(d => {
    const status = getDiscountStatus(d);
    const targetLabel = d.target_type === "playlist" ? "🎵 เพลย์ลิสต์" : "🎼 เพลง";
    const targetTypeIcon = d.target_type === "playlist" ? "🎵" : "🎼";
    let valueLabel = "";
    if (d.discount_type === "percent") valueLabel = `ลด ${d.discount_value}%`;
    else if (d.discount_type === "fixed") valueLabel = `ลด ${Number(d.discount_value).toLocaleString()} LAK`;
    return `
      <div class="list-row discount-row" data-id="${disc_escapeHtml(d.id)}">
        <div class="info">
          <div class="n1"><span class="n1-name">${disc_escapeHtml(d.target_name || "(ไม่พบชื่อ)")}</span>
            <span class="discount-status-badge" style="background:${status.color === 'var(--success)' ? 'rgba(16,185,129,.15)' : status.color === 'var(--danger)' ? 'rgba(239,68,68,.15)' : status.color === '#F5B400' ? 'rgba(245,180,0,.15)' : 'rgba(148,163,184,.15)'}; color:${status.color};">${status.label}</span>
          </div>
          <div class="n2">${targetTypeIcon} ${targetLabel} · ${valueLabel}</div>
          <div class="n2" style="font-size:11px;color:var(--text-dim);">เริ่ม: ${formatDateTime(d.start_at)} · สิ้นสุด: ${formatDateTime(d.end_at)}</div>
        </div>
        <!-- เพิ่มใหม่ (แก้บั๊ก 2026-09-10): ปุ่ม ⋮ ตัวเดียว แทนปุ่ม ✎🔒🗑 3 ปุ่มเรียงกัน (ล้นขอบจอ/บังบนมือถือ) -->
        <div class="row-actions">
          <button class="icon-btn" data-disc-menu="${disc_escapeHtml(d.id)}" title="เมนู">⋮</button>
        </div>
      </div>`;
  }).join("");

  // เพิ่มใหม่: ผูกปุ่ม ⋮ เข้ากับเมนูดรอปดาวน์ตัวเดียวที่ใช้ร่วมกันทุกแถว (โครงเดียวกับ toggleSongRowMenu ใน app-admin.js)
  wrap.querySelectorAll("[data-disc-menu]").forEach(b => b.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleDiscountRowMenu(b, b.getAttribute("data-disc-menu"));
  }));
}

// ===== เพิ่มใหม่ (แก้บั๊ก 2026-09-10): เมนูดรอปดาวน์ ⋮ แบบใช้ element ตัวเดียวร่วมกันทุกแถวลดราคา =====
// โครงเดียวกับ toggleSongRowMenu/hideSongRowMenu ใน app-admin.js — เรียกฟังก์ชันเดิม
// (openEditDiscount/toggleDiscountActive/confirmDeleteDiscount) ทุกอย่างเหมือนเดิม ไม่เปลี่ยนพฤติกรรม
let openDiscountMenuId = null;
function toggleDiscountRowMenu(btn, discId) {
  const menu = document.getElementById("discountRowMenu");
  if (!menu) return;
  if (openDiscountMenuId === discId && menu.style.display !== "none") {
    hideDiscountRowMenu();
    return;
  }
  openDiscountMenuId = discId;
  const d = DISCOUNTS_CACHE.find(x => x.id === discId);
  const toggleBtn = document.getElementById("discountRowMenuToggle");
  if (toggleBtn && d) toggleBtn.textContent = d.active === false ? "🔓 เปิดใช้งาน" : "🔒 ปิดใช้งาน";
  const rect = btn.getBoundingClientRect();
  menu.style.display = "block";
  const menuWidth = menu.offsetWidth || 200;
  let left = rect.right - menuWidth;
  if (left < 8) left = 8;
  menu.style.left = left + "px";
  const menuHeight = menu.offsetHeight || 150;
  let top = rect.bottom + 6;
  if (top + menuHeight > window.innerHeight - 8) top = rect.top - menuHeight - 6;
  menu.style.top = top + "px";
}
function hideDiscountRowMenu() {
  const menu = document.getElementById("discountRowMenu");
  if (menu) menu.style.display = "none";
  openDiscountMenuId = null;
}
document.addEventListener("click", (e) => {
  const menu = document.getElementById("discountRowMenu");
  if (menu && menu.style.display !== "none" && !menu.contains(e.target)) hideDiscountRowMenu();
});
window.addEventListener("scroll", hideDiscountRowMenu, true);
document.getElementById("discountRowMenuEdit")?.addEventListener("click", () => {
  const id = openDiscountMenuId; hideDiscountRowMenu();
  if (id) openEditDiscount(id);
});
document.getElementById("discountRowMenuToggle")?.addEventListener("click", () => {
  const id = openDiscountMenuId; hideDiscountRowMenu();
  if (id) toggleDiscountActive(id);
});
document.getElementById("discountRowMenuDelete")?.addEventListener("click", () => {
  const id = openDiscountMenuId; hideDiscountRowMenu();
  if (id) confirmDeleteDiscount(id);
});

// ===== เพิ่มใหม่ (แก้บั๊ก 2026-09-10): รับ searchTerm เพื่อกรองรายชื่อเพลง/เพลย์ลิสต์ในช่อง select =====
// ไม่มี searchTerm (undefined) = แสดงทั้งหมดเหมือนเดิมทุกประการ — ไม่กระทบพฤติกรรมเดิม
function populateTargetSelects(searchTerm) {
  const targetSelect = document.getElementById("fDiscTarget");
  if (!targetSelect) return;
  if (editingDiscountId) return;
  const term = String(searchTerm || "").trim().toLowerCase();
  const filteredSongs = term ? SONGS_CACHE.filter(s => String(s.song_name || "").toLowerCase().includes(term)) : SONGS_CACHE;
  const filteredPlaylists = term ? PLAYLISTS_CACHE.filter(p => String(p.playlist_name || "").toLowerCase().includes(term)) : PLAYLISTS_CACHE;
  let opts = ['<option value="">— เลือกเพลง/เพลย์ลิสต์ —</option>'];
  if (filteredSongs.length > 0) {
    opts.push('<optgroup label="เพลง">');
    filteredSongs.forEach(s => {
      const price = Number(s.price) || 0;
      opts.push(`<option value="song:${disc_escapeHtml(s.id)}" data-name="${disc_escapeHtml(s.song_name || '')}" data-price="${price}">🎼 ${disc_escapeHtml(s.song_name || '(ไม่มีชื่อ)')} — ${price.toLocaleString()} LAK</option>`);
    });
    opts.push('</optgroup>');
  }
  if (filteredPlaylists.length > 0) {
    opts.push('<optgroup label="เพลย์ลิสต์">');
    filteredPlaylists.forEach(p => {
      const price = Number(p.price) || 0;
      opts.push(`<option value="playlist:${disc_escapeHtml(p.id)}" data-name="${disc_escapeHtml(p.playlist_name || '')}" data-price="${price}">🎵 ${disc_escapeHtml(p.playlist_name || '(ไม่มีชื่อ)')} — ${price.toLocaleString()} LAK</option>`);
    });
    opts.push('</optgroup>');
  }
  if (term && filteredSongs.length === 0 && filteredPlaylists.length === 0) {
    opts.push('<option value="" disabled>— ไม่พบรายการที่ตรงกับคำค้นหา —</option>');
  }
  targetSelect.innerHTML = opts.join("");
}

function disc_toLocalDatetimeInput(d) {
  if (!(d instanceof Date) || isNaN(d.getTime())) return "";
  const pad = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function disc_fromLocalDatetimeInput(value) {
  if (!value) return null;
  const d = new Date(value);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

function resetDiscountForm() {
  editingDiscountId = null;
  document.getElementById("discountFormTitle").textContent = "เพิ่มลดราคา";
  document.getElementById("fDiscTarget").disabled = false;
  document.getElementById("fDiscTarget").value = "";
  // เพิ่มใหม่: เปิดช่องค้นหาอีกครั้งเวลาเปิดฟอร์ม "เพิ่มลดราคา" ใหม่ (กรณีปิดไว้ตอนแก้ไขรายการก่อนหน้า)
  const searchInputReset = document.getElementById("fDiscTargetSearch");
  if (searchInputReset) searchInputReset.disabled = false;
  document.getElementById("fDiscType").value = "percent";
  document.getElementById("fDiscValue").value = "";
  const now = new Date();
  const end = new Date(); end.setDate(end.getDate() + 7);
  document.getElementById("fDiscStartAt").value = disc_toLocalDatetimeInput(now);
  document.getElementById("fDiscEndAt").value = disc_toLocalDatetimeInput(end);
  document.getElementById("fDiscActive").checked = true;
  document.getElementById("discountFormNote").textContent = "";
  document.getElementById("discountPriceHint").textContent = "";
  // เพิ่มใหม่: ล้างช่องค้นหาทุกครั้งที่เปิดฟอร์มใหม่ ไม่ให้ค่าค้นหาเก่าค้าง
  const searchInput = document.getElementById("fDiscTargetSearch");
  if (searchInput) searchInput.value = "";
  populateTargetSelects();
}

function openAddDiscount() {
  resetDiscountForm();
  document.getElementById("discountFormBackdrop").classList.add("show");
}

function openEditDiscount(id) {
  const d = DISCOUNTS_CACHE.find(x => x.id === id);
  if (!d) return;
  resetDiscountForm();
  editingDiscountId = id;
  document.getElementById("discountFormTitle").textContent = "แก้ไขลดราคา";
  document.getElementById("fDiscType").value = d.discount_type || "percent";
  document.getElementById("fDiscValue").value = d.discount_value || "";
  if (d.start_at) document.getElementById("fDiscStartAt").value = disc_toLocalDatetimeInput(new Date(d.start_at));
  if (d.end_at) document.getElementById("fDiscEndAt").value = disc_toLocalDatetimeInput(new Date(d.end_at));
  document.getElementById("fDiscActive").checked = d.active !== false;

  populateTargetSelects();
  const targetValue = d.target_type + ":" + d.target_id;
  const exists = Array.from(document.getElementById("fDiscTarget").options).some(o => o.value === targetValue);
  if (!exists) {
    const opt = document.createElement("option");
    opt.value = targetValue;
    opt.textContent = (d.target_type === "playlist" ? "🎵 " : "🎼 ") + (d.target_name || "(เพลงที่ถูกลบไปแล้ว)");
    opt.dataset.name = d.target_name || "(เพลงที่ถูกลบไปแล้ว)";
    opt.dataset.price = "0";
    document.getElementById("fDiscTarget").appendChild(opt);
  }
  document.getElementById("fDiscTarget").value = targetValue;
  document.getElementById("fDiscTarget").disabled = true;
  // เพิ่มใหม่: ปิดช่องค้นหาตอนแก้ไข (เป้าหมายแก้ไม่ได้อยู่แล้วตามโค้ดเดิม)
  const searchInputEdit = document.getElementById("fDiscTargetSearch");
  if (searchInputEdit) searchInputEdit.disabled = true;
  document.getElementById("discountFormNote").textContent = "หากต้องการเปลี่ยนเป้าหมาย กรุณาลบรายการนี้และสร้างใหม่";
  updatePriceHint();
  document.getElementById("discountFormBackdrop").classList.add("show");
}

function updatePriceHint() {
  const targetSel = document.getElementById("fDiscTarget");
  const typeSel = document.getElementById("fDiscType");
  const valueInput = document.getElementById("fDiscValue");
  const hintEl = document.getElementById("discountPriceHint");
  if (!hintEl) return;
  const opt = targetSel.options[targetSel.selectedIndex];
  if (!opt || !opt.dataset.price) { hintEl.textContent = ""; return; }
  const original = Number(opt.dataset.price) || 0;
  const dtype = typeSel.value;
  const dval = Number(valueInput.value) || 0;
  if (original <= 0 || dval <= 0) { hintEl.textContent = ""; return; }
  let final = original;
  if (dtype === "percent") {
    const pct = Math.max(0, Math.min(100, dval));
    final = Math.round(original * (100 - pct) / 100);
  } else if (dtype === "fixed") {
    final = Math.max(0, original - dval);
  }
  const discAmount = original - final;
  hintEl.textContent = `ราคาปกติ ${original.toLocaleString()} LAK → หลังลด ${final.toLocaleString()} LAK (ลด ${discAmount.toLocaleString()} LAK)`;
  hintEl.style.color = discAmount > 0 ? "var(--accent-2)" : "var(--text-dim)";
}

async function handleSaveDiscount() {
  const btn = document.getElementById("discountSaveBtn");
  const targetSel = document.getElementById("fDiscTarget");

  const targetValue = targetSel.value;
  if (!targetValue) { disc_showToast("กรุณาเลือกเพลงหรือเพลย์ลิสต์", "error"); return; }
  const [targetType, targetId] = targetValue.split(":");
  if (!targetType || !targetId) { disc_showToast("ค่าเป้าหมายไม่ถูกต้อง", "error"); return; }

  const opt = targetSel.options[targetSel.selectedIndex];
  const targetName = opt?.dataset?.name || "(unknown)";
  const originalPrice = Number(opt?.dataset?.price) || 0;

  const discountType = document.getElementById("fDiscType").value;
  const discountValue = Number(document.getElementById("fDiscValue").value) || 0;
  if (discountValue <= 0) { disc_showToast("กรุณากรอกค่าส่วนลด (ต้องมากกว่า 0)", "error"); return; }
  if (discountType === "percent" && discountValue > 100) { disc_showToast("เปอร์เซ็นต์ส่วนลดต้องไม่เกิน 100", "error"); return; }
  if (discountType === "fixed" && originalPrice > 0 && discountValue > originalPrice) {
    disc_showToast("ส่วนลดเป็นจำนวนเงินมากกว่าราคาเพลง — ระบบจะตั้งราคาสุดท้ายเป็น 0 LAK แต่แนะนำให้ลดค่าส่วนลด", "error"); return;
  }

  const startAt = disc_fromLocalDatetimeInput(document.getElementById("fDiscStartAt").value);
  const endAt = disc_fromLocalDatetimeInput(document.getElementById("fDiscEndAt").value);
  if (!startAt) { disc_showToast("กรุณาตั้งวันเริ่มต้น", "error"); return; }
  if (!endAt) { disc_showToast("กรุณาตั้งวันสิ้นสุด", "error"); return; }
  if (new Date(endAt) <= new Date(startAt)) { disc_showToast("วันสิ้นสุดต้องหลังวันเริ่มต้น", "error"); return; }

  const active = document.getElementById("fDiscActive").checked;

  btn.disabled = true; btn.textContent = "กำลังบันทึก...";
  try {
    const now = new Date().toISOString();
    const currentUser = auth.currentUser;
    const payload = {
      target_type: targetType,
      target_id: targetId,
      target_name: targetName,
      discount_type: discountType,
      discount_value: discountValue,
      start_at: startAt,
      end_at: endAt,
      active: active,
      updated_at: now,
      updated_by: currentUser ? currentUser.email : ""
    };

    if (!editingDiscountId) {
      const dup = DISCOUNTS_CACHE.find(d => d.target_type === targetType && d.target_id === targetId && d.active !== false);
      if (dup) {
        disc_showToast(`มีลดราคาของ "${targetName}" อยู่แล้ว — แนะนำให้แก้ไขของเดิมแทนสร้างใหม่`, "error");
        btn.disabled = false; btn.textContent = "บันทึก";
        return;
      }
    }

    if (editingDiscountId) {
      const existing = DISCOUNTS_CACHE.find(d => d.id === editingDiscountId);
      if (existing) payload.created_by = existing.created_by || payload.updated_by;
      await updateDoc(doc(db, "discounts", editingDiscountId), payload);
      disc_showToast("บันทึกแล้ว", "success");
    } else {
      payload.created_at = now;
      payload.created_by = currentUser ? currentUser.email : "";
      await setDoc(doc(collection(db, "discounts")), payload);
      disc_showToast("สร้างลดราคาใหม่แล้ว", "success");
    }
    document.getElementById("discountFormBackdrop").classList.remove("show");
    clearPricingCache();
    await disc_loadData();
  } catch (err) {
    disc_showToast("บันทึกไม่สำเร็จ: " + (err.message || err), "error");
  }
  btn.disabled = false; btn.textContent = "บันทึก";
}

function confirmDeleteDiscount(id) {
  const d = DISCOUNTS_CACHE.find(x => x.id === id);
  if (!d) return;
  disc_openConfirm(
    `ต้องการลบรายการลดราคาของ "${d.target_name || ''}" หรือไม่? ลูกค้าที่เพิ่งสั่งซื้อไปจะยังเห็นราคาเดิมใน order ของตัวเอง (เพราะ order เก็บ snapshot ไว้)`,
    async () => {
      try {
        await deleteDoc(doc(db, "discounts", id));
        disc_showToast("ลบแล้ว", "success");
        clearPricingCache();
        await disc_loadData();
      } catch (err) {
        disc_showToast("ลบไม่สำเร็จ: " + (err.message || err), "error");
      }
    }
  );
}

async function toggleDiscountActive(id) {
  const d = DISCOUNTS_CACHE.find(x => x.id === id);
  if (!d) return;
  try {
    await updateDoc(doc(db, "discounts", id), {
      active: d.active === false ? true : false,
      updated_at: new Date().toISOString()
    });
    disc_showToast(d.active === false ? "เปิดใช้งานแล้ว" : "ปิดใช้งานแล้ว", "success");
    clearPricingCache();
    await disc_loadData();
  } catch (err) {
    disc_showToast("เปลี่ยนสถานะไม่สำเร็จ: " + (err.message || err), "error");
  }
}

export function initDiscountsView() {
  document.getElementById("addDiscountBtn").addEventListener("click", openAddDiscount);
  if (!disc_listenersBound) {
    document.getElementById("discountFormClose").addEventListener("click", () => document.getElementById("discountFormBackdrop").classList.remove("show"));
    document.getElementById("discountSaveBtn").addEventListener("click", handleSaveDiscount);
    document.getElementById("fDiscTarget").addEventListener("change", updatePriceHint);
    document.getElementById("fDiscType").addEventListener("change", updatePriceHint);
    document.getElementById("fDiscValue").addEventListener("input", updatePriceHint);
    // เพิ่มใหม่ (แก้บั๊ก 2026-09-10): พิมพ์ค้นหาแล้วกรอง option ใน select เป้าหมายทันที
    document.getElementById("fDiscTargetSearch")?.addEventListener("input", (e) => populateTargetSelects(e.target.value));
    disc_listenersBound = true;
  }
  disc_loadData();
}

// ============================================================================
// PART 3: PROMOTIONS CRUD (admin จัดการโปรโมชั่น cart-wide)
// ============================================================================

function promo_showToast(msg, type) {
  if (window.__showToast) { window.__showToast(msg, type); return; }
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = msg;
  el.className = "toast show" + (type ? " " + type : "");
  clearTimeout(promo_showToast._t);
  promo_showToast._t = setTimeout(() => { el.className = "toast"; }, 2600);
}
function promo_openConfirm(text, onOk) {
  if (window.__openConfirm) { window.__openConfirm(text, onOk); return; }
  // 🎨 (2026-09-26): ใช้ window.adminConfirm (Promise-based) แทน window.confirm (blocking)
  if (window.adminConfirm) {
    window.adminConfirm(text).then((ok) => { if (ok) onOk(); });
    return;
  }
  // fallback: ถ้าไม่มี adminConfirm ใช้ window.confirm ธรรมดา
  if (window.confirm(text)) onOk();
}
function promo_escapeHtml(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

let PROMOTIONS_CACHE = [];
let CATEGORIES_CACHE = [];
let editingPromoId = null;
let promo_listenersBound = false;

// 🔧 (2026-09-17 Phase 1): promo_loadData ใช้ TTL cache ลด D1 reads (เหมือน disc_loadData)
//   - ถ้า PROMOTIONS_CACHE / CATEGORIES_CACHE ยังไม่หมดอายุ (60 วิ) → skip fetch ใช้ cache
//   - ถ้า admin save/delete → clearPricingCache ล้าง timestamp → ครั้งถัดไป fetch ใหม่
async function promo_loadData() {
  try {
    const now = Date.now();
    const isPromosStale = !PROMOTIONS_CACHE.length || !_promotionsAllCacheAt || (now - _promotionsAllCacheAt) > ADMIN_VIEW_CACHE_TTL_MS;
    const isCatsStale = !CATEGORIES_CACHE.length || !_categoriesAllCacheAt || (now - _categoriesAllCacheAt) > ADMIN_VIEW_CACHE_TTL_MS;

    const fetches = [];
    const fetchKeys = [];
    if (isPromosStale) { fetches.push(fetchAllPromotions()); fetchKeys.push("promotions"); }
    if (isCatsStale) { fetches.push(getDocs(collection(db, "categories"))); fetchKeys.push("categories"); }

    if (fetches.length > 0) {
      const results = await Promise.all(fetches);
      results.forEach((res, i) => {
        const key = fetchKeys[i];
        if (key === "promotions") {
          // res คือ array จาก fetchAllPromotions (มี sorting ให้แล้ว)
          PROMOTIONS_CACHE = res;
          // _promotionsAllCacheAt ถูกตั้งใน fetchAllPromotions แล้ว
        } else if (key === "categories") {
          // res คือ QuerySnapshot จาก getDocs
          CATEGORIES_CACHE = res.docs.map(d => ({ id: d.id, ...d.data() }));
          _categoriesAllCacheAt = now;
        }
      });
    }
    renderPromotionList();
    populateCategorySelect();
  } catch (err) {
    console.error(err);
    promo_showToast("โหลดข้อมูลไม่สำเร็จ: " + (err.message || err), "error");
  }
}

function renderPromotionList() {
  const wrap = document.getElementById("promotionList");
  if (!wrap) return;
  if (PROMOTIONS_CACHE.length === 0) {
    wrap.innerHTML = '<div class="empty-state">ยังไม่มีโปรโมชั่น — กด "สร้างโปรโมชั่น" เพื่อสร้างใหม่</div>';
    return;
  }
  // 🟢 (Audit Fix M-20): Sort promotions — active ก่อน expired (archive expired ไปด้านล่าง)
  //   ปัญหาเดิม: expired promotions ค้างใน list ปนกับ active → admin สับสน
  //   วิธีแก้: sort โดย status (active/scheduled ก่อน, expired หลัง) + end_at DESC
  //   ผลกระทบระบบเดิม: 0% — แค่เปลี่ยนลำดับแสดงผล (ข้อมูลเหมือนเดิม)
  const sortedPromos = [...PROMOTIONS_CACHE].sort((a, b) => {
    const sa = getDiscountStatus(a).status;
    const sb = getDiscountStatus(b).status;
    // expired ไปด้านล่าง
    if (sa === "expired" && sb !== "expired") return 1;
    if (sb === "expired" && sa !== "expired") return -1;
    // ถ้าทั้งคู่ expired → end_at DESC (ใหม่ก่อน)
    if (sa === "expired" && sb === "expired") {
      return new Date(b.end_at || 0).getTime() - new Date(a.end_at || 0).getTime();
    }
    // ถ้าทั้งคู่ active/scheduled → start_at ASC (เก่าก่อน)
    return new Date(a.start_at || 0).getTime() - new Date(b.start_at || 0).getTime();
  });
  wrap.innerHTML = sortedPromos.map(p => {
    const status = getDiscountStatus(p);
    // 🚀 (H-7): เพิ่ม label สำหรับ playlist_tiered_percent + applies_to="playlist"
    let appliesToLabel;
    if (p.applies_to === "playlist") {
      appliesToLabel = "🎵 เฉพาะออเดอร์ซื้อยกเพลย์ลิสต์";
    } else if (p.applies_to === "category") {
      appliesToLabel = `เฉพาะหมวด: ${promo_escapeHtml(p.category_name || '-')}`;
    } else {
      appliesToLabel = "ทุกเพลง";
    }
    let typeLabel, valueLabel, minQtyLabel;
    if (p.type === "playlist_tiered_percent") {
      typeLabel = "🎵 ยิ่งเลือกเยอะ ยิ่งคุ้ม";
      const tiersText = Array.isArray(p.tiers) && p.tiers.length > 0
        ? p.tiers.map(t => `${t.min_quantity}=${t.discount_percent}%`).join(", ")
        : "(ไม่ได้ตั้ง tier)";
      valueLabel = `Tiers: ${tiersText}`;
      minQtyLabel = `เริ่มต้น ${p.tiers?.[0]?.min_quantity || 1} เพลย์ลิสต์`;
    } else {
      minQtyLabel = p.min_quantity ? `ซื้อครบ ${p.min_quantity} เพลง` : "ไม่มีขั้นต่ำ";
      valueLabel = p.type === "cart_percent" || p.type === "buy_x_get_y_percent" ? `ลด ${p.discount_value}%` : `ลด ${Number(p.discount_value).toLocaleString()} LAK`;
      typeLabel = p.type === "buy_x_get_y_percent" ? "ซื้อ X ลด %" : (p.type === "cart_percent" ? "ลด % ทั้งยอด" : "ลดจำนวนเงิน");
    }
    return `
      <div class="list-row promotion-row" data-id="${promo_escapeHtml(p.id)}">
        <div class="info">
          <div class="n1"><span class="n1-name">${promo_escapeHtml(p.name || '(ไม่มีชื่อ)')}</span>
            <span class="discount-status-badge" style="background:${status.color === 'var(--success)' ? 'rgba(16,185,129,.15)' : status.color === 'var(--danger)' ? 'rgba(239,68,68,.15)' : status.color === '#F5B400' ? 'rgba(245,180,0,.15)' : 'rgba(148,163,184,.15)'}; color:${status.color};">${status.label}</span>
          </div>
          <div class="n2">${typeLabel} · ${valueLabel} · ${minQtyLabel} · ${appliesToLabel}</div>
          <div class="n2" style="font-size:11px;color:var(--text-dim);">เริ่ม: ${formatDateTime(p.start_at)} · สิ้นสุด: ${formatDateTime(p.end_at)}${p.description ? ' · ' + promo_escapeHtml(p.description) : ''}</div>
        </div>
        <!-- เพิ่มใหม่ (แก้บั๊ก 2026-09-10): ปุ่ม ⋮ ตัวเดียว แทนปุ่ม ✎🔒🗑 3 ปุ่มเรียงกัน (ล้นขอบจอ/บังบนมือถือ) -->
        <div class="row-actions">
          <button class="icon-btn" data-promo-menu="${promo_escapeHtml(p.id)}" title="เมนู">⋮</button>
        </div>
      </div>`;
  }).join("");

  // เพิ่มใหม่: ผูกปุ่ม ⋮ เข้ากับเมนูดรอปดาวน์ตัวเดียวที่ใช้ร่วมกันทุกแถว (โครงเดียวกับ discountRowMenu ด้านบน)
  wrap.querySelectorAll("[data-promo-menu]").forEach(b => b.addEventListener("click", (e) => {
    e.stopPropagation();
    togglePromotionRowMenu(b, b.getAttribute("data-promo-menu"));
  }));
}

// ===== เพิ่มใหม่ (แก้บั๊ก 2026-09-10): เมนูดรอปดาวน์ ⋮ แบบใช้ element ตัวเดียวร่วมกันทุกแถวโปรโมชั่น =====
// โครงเดียวกับ toggleDiscountRowMenu ด้านบน — เรียกฟังก์ชันเดิม (openEditPromotion/togglePromotionActive/
// confirmDeletePromotion) ทุกอย่างเหมือนเดิม ไม่เปลี่ยนพฤติกรรม
let openPromotionMenuId = null;
function togglePromotionRowMenu(btn, promoId) {
  const menu = document.getElementById("promotionRowMenu");
  if (!menu) return;
  if (openPromotionMenuId === promoId && menu.style.display !== "none") {
    hidePromotionRowMenu();
    return;
  }
  openPromotionMenuId = promoId;
  const p = PROMOTIONS_CACHE.find(x => x.id === promoId);
  const toggleBtn = document.getElementById("promotionRowMenuToggle");
  if (toggleBtn && p) toggleBtn.textContent = p.active === false ? "🔓 เปิดใช้งาน" : "🔒 ปิดใช้งาน";
  const rect = btn.getBoundingClientRect();
  menu.style.display = "block";
  const menuWidth = menu.offsetWidth || 200;
  let left = rect.right - menuWidth;
  if (left < 8) left = 8;
  menu.style.left = left + "px";
  const menuHeight = menu.offsetHeight || 150;
  let top = rect.bottom + 6;
  if (top + menuHeight > window.innerHeight - 8) top = rect.top - menuHeight - 6;
  menu.style.top = top + "px";
}
function hidePromotionRowMenu() {
  const menu = document.getElementById("promotionRowMenu");
  if (menu) menu.style.display = "none";
  openPromotionMenuId = null;
}
document.addEventListener("click", (e) => {
  const menu = document.getElementById("promotionRowMenu");
  if (menu && menu.style.display !== "none" && !menu.contains(e.target)) hidePromotionRowMenu();
});
window.addEventListener("scroll", hidePromotionRowMenu, true);
document.getElementById("promotionRowMenuEdit")?.addEventListener("click", () => {
  const id = openPromotionMenuId; hidePromotionRowMenu();
  if (id) openEditPromotion(id);
});
document.getElementById("promotionRowMenuToggle")?.addEventListener("click", () => {
  const id = openPromotionMenuId; hidePromotionRowMenu();
  if (id) togglePromotionActive(id);
});
document.getElementById("promotionRowMenuDelete")?.addEventListener("click", () => {
  const id = openPromotionMenuId; hidePromotionRowMenu();
  if (id) confirmDeletePromotion(id);
});

function populateCategorySelect() {
  const sel = document.getElementById("fPromoCategory");
  if (!sel) return;
  let opts = ['<option value="">— เลือกหมวดหมู่ —</option>'];
  CATEGORIES_CACHE.forEach(c => {
    opts.push(`<option value="${promo_escapeHtml(c.id)}" data-name="${promo_escapeHtml(c.category_name || '')}">${promo_escapeHtml(c.category_name || '(ไม่มีชื่อ)')}</option>`);
  });
  sel.innerHTML = opts.join("");
}

function promo_toLocalDatetimeInput(d) {
  if (!(d instanceof Date) || isNaN(d.getTime())) return "";
  const pad = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function promo_fromLocalDatetimeInput(value) {
  if (!value) return null;
  const d = new Date(value);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

function resetPromotionForm() {
  editingPromoId = null;
  document.getElementById("promotionFormTitle").textContent = "สร้างโปรโมชั่น";
  document.getElementById("fPromoName").value = "";
  document.getElementById("fPromoDesc").value = "";
  document.getElementById("fPromoType").value = "cart_percent";
  document.getElementById("fPromoMinQty").value = "";
  document.getElementById("fPromoMinSubtotal").value = "";
  document.getElementById("fPromoValue").value = "";
  document.getElementById("fPromoAppliesTo").value = "all";
  document.getElementById("fPromoAppliesTo").disabled = false;
  document.getElementById("fPromoCategoryRow").style.display = "none";
  document.getElementById("fPromoCategory").value = "";
  // 🚀 (H-7): ล้าง tiers
  promo_clearTiers();
  const now = new Date();
  const end = new Date(); end.setDate(end.getDate() + 7);
  document.getElementById("fPromoStartAt").value = promo_toLocalDatetimeInput(now);
  document.getElementById("fPromoEndAt").value = promo_toLocalDatetimeInput(end);
  document.getElementById("fPromoActive").checked = true;
  document.getElementById("fPromoPriority").value = "100";
  document.getElementById("promotionFormNote").textContent = "";
  updatePromoTypeHint();
  updateAppliesToRow();
}

function openAddPromotion() {
  resetPromotionForm();
  document.getElementById("promotionFormBackdrop").classList.add("show");
}

function openEditPromotion(id) {
  const p = PROMOTIONS_CACHE.find(x => x.id === id);
  if (!p) return;
  resetPromotionForm();
  editingPromoId = id;
  document.getElementById("promotionFormTitle").textContent = "แก้ไขโปรโมชั่น";
  document.getElementById("fPromoName").value = p.name || "";
  document.getElementById("fPromoDesc").value = p.description || "";
  document.getElementById("fPromoType").value = p.type || "cart_percent";
  document.getElementById("fPromoMinQty").value = p.min_quantity || "";
  document.getElementById("fPromoMinSubtotal").value = p.min_subtotal || "";
  document.getElementById("fPromoValue").value = p.discount_value || "";
  document.getElementById("fPromoAppliesTo").value = p.applies_to || "all";
  if (p.applies_to === "category" && p.category_id) {
    document.getElementById("fPromoCategoryRow").style.display = "block";
    document.getElementById("fPromoCategory").value = p.category_id;
  }
  // 🚀 (H-7): populate tiers ถ้าเป็น playlist_tiered_percent
  if (p.type === "playlist_tiered_percent" && Array.isArray(p.tiers)) {
    promo_populateTiers(p.tiers);
  }
  if (p.start_at) document.getElementById("fPromoStartAt").value = promo_toLocalDatetimeInput(new Date(p.start_at));
  if (p.end_at) document.getElementById("fPromoEndAt").value = promo_toLocalDatetimeInput(new Date(p.end_at));
  document.getElementById("fPromoActive").checked = p.active !== false;
  document.getElementById("fPromoPriority").value = p.priority || 100;
  updatePromoTypeHint();
  updateAppliesToRow();
  document.getElementById("promotionFormBackdrop").classList.add("show");
}

function updateAppliesToRow() {
  const appliesTo = document.getElementById("fPromoAppliesTo").value;
  document.getElementById("fPromoCategoryRow").style.display = (appliesTo === "category") ? "block" : "none";
}

function updatePromoTypeHint() {
  const type = document.getElementById("fPromoType").value;
  const hintEl = document.getElementById("fPromoTypeHint");
  if (!hintEl) return;
  const hints = {
    cart_percent: "ลด % ของยอดรวมเพลงที่เข้าโปร (เช่น ลด 10% = ทุกเพลงที่เข้าโปรหัก 10%)",
    cart_fixed: "ลดจำนวนเงินตายตัว (เช่น ลด 5,000 LAK จากยอดรวมที่เข้าโปร)",
    buy_x_get_y_percent: "ซื้อครบ X เพลง → ลด Y% ของยอดเพลงที่เข้าโปร (ตั้งค่า min_quantity = X, discount_value = Y%)",
    // 🚀 (2026-09-28 fix H-7): เพิ่ม hint สำหรับโปรโมชัน tiered
    playlist_tiered_percent: "🎵 ยิ่งเลือกเยอะ ยิ่งคุ้ม — ตั้งหลาย tier ตามจำนวนเพลย์ลิสต์ (เช่น ซื้อ 2 ลด 10%, ซื้อ 3 ลด 15%)\nใช้ได้เฉพาะออเดอร์ 'ซื้อยกเพลย์ลิสต์' (order_type=playlist หรือ mixed)"
  };
  hintEl.textContent = hints[type] || "";
  hintEl.style.color = "var(--text-dim)";
  // 🚀 (H-7): แสดง/ซ่อน tier table ตาม type
  const tierTableEl = document.getElementById("fPromoTiers");
  if (tierTableEl) {
    const tierContainer = tierTableEl.closest(".promo-tier-container");
    if (tierContainer) {
      tierContainer.style.display = (type === "playlist_tiered_percent") ? "block" : "none";
    }
  }
  // 🚀 (H-7): ซ่อน min_quantity/min_subtotal/discount_value fields เมื่อเป็น playlist_tiered_percent
  //   (ใช้ tier table แทน)
  const singleFields = ["fPromoMinQty", "fPromoMinSubtotal", "fPromoValue"];
  for (const fieldId of singleFields) {
    const field = document.getElementById(fieldId);
    if (field) {
      const row = field.closest(".promo-field-row") || field.closest("label") || field.parentElement;
      if (row && row.tagName !== "FORM") {
        row.style.display = (type === "playlist_tiered_percent") ? "none" : "";
      }
    }
  }
  // 🚀 (H-7): บังคับ applies_to = "playlist" สำหรับ playlist_tiered_percent
  const appliesToSelect = document.getElementById("fPromoAppliesTo");
  if (appliesToSelect) {
    if (type === "playlist_tiered_percent") {
      appliesToSelect.value = "playlist";
      appliesToSelect.disabled = true;
    } else {
      appliesToSelect.disabled = false;
    }
    // trigger updateAppliesToRow
    if (typeof updateAppliesToRow === "function") updateAppliesToRow();
  }
}

async function handleSavePromotion() {
  const btn = document.getElementById("promotionSaveBtn");
  const name = document.getElementById("fPromoName").value.trim();
  const description = document.getElementById("fPromoDesc").value.trim();
  const type = document.getElementById("fPromoType").value;
  const minQty = Number(document.getElementById("fPromoMinQty").value) || 0;
  const minSubtotal = Number(document.getElementById("fPromoMinSubtotal").value) || 0;
  const value = Number(document.getElementById("fPromoValue").value) || 0;
  let appliesTo = document.getElementById("fPromoAppliesTo").value;
  const categorySel = document.getElementById("fPromoCategory");
  const categoryId = categorySel.value;
  const categoryName = categorySel.options[categorySel.selectedIndex]?.dataset?.name || "";
  const startAt = promo_fromLocalDatetimeInput(document.getElementById("fPromoStartAt").value);
  const endAt = promo_fromLocalDatetimeInput(document.getElementById("fPromoEndAt").value);
  const active = document.getElementById("fPromoActive").checked;
  const priority = Number(document.getElementById("fPromoPriority").value) || 100;

  if (!name) { promo_showToast("กรุณาตั้งชื่อโปรโมชั่น", "error"); return; }
  if (!startAt) { promo_showToast("กรุณาตั้งวันเริ่มต้น", "error"); return; }
  if (!endAt) { promo_showToast("กรุณาตั้งวันสิ้นสุด", "error"); return; }
  if (new Date(endAt) <= new Date(startAt)) { promo_showToast("วันสิ้นสุดต้องหลังวันเริ่มต้น", "error"); return; }
  if (appliesTo === "category" && !categoryId) { promo_showToast("กรุณาเลือกหมวดหมู่", "error"); return; }
  if (type === "buy_x_get_y_percent" && minQty <= 0) { promo_showToast("ประเภท 'ซื้อ X ลด %' ต้องตั้ง min_quantity มากกว่า 0", "error"); return; }

  // 🚀 (2026-09-28 fix H-7): ตรวจสำหรับ playlist_tiered_percent
  let tiers = null;
  if (type === "playlist_tiered_percent") {
    // อ่าน tiers จาก table
    tiers = promo_readTiersFromForm();
    if (!tiers || tiers.length === 0) {
      promo_showToast("กรุณาเพิ่มอย่างน้อย 1 tier (เช่น ซื้อครบ 2 ลด 10%)", "error");
      return;
    }
    // ตรวค่า % ต้อง 0-100
    for (const t of tiers) {
      if (t.discount_percent < 0 || t.discount_percent > 100) {
        promo_showToast(`ส่วนลดของ tier "${t.min_quantity} เพลย์ลิสต์" ต้องอยู่ระหว่าง 0-100%`, "error");
        return;
      }
      if (t.min_quantity < 1) {
        promo_showToast("จำนวนเพลย์ลิสต์ขั้นต่ำต้องมากกว่า 0", "error");
        return;
      }
    }
    // บังคับ applies_to = "playlist"
    appliesTo = "playlist";
  } else {
    // ตรวค่าสำหรับ type อื่น ๆ (เดิม)
    if (value <= 0) { promo_showToast("กรุณากรอกค่าส่วนลด (ต้องมากกว่า 0)", "error"); return; }
    if ((type === "cart_percent" || type === "buy_x_get_y_percent") && value > 100) { promo_showToast("เปอร์เซ็นต์ต้องไม่เกิน 100", "error"); return; }
  }

  btn.disabled = true; btn.textContent = "กำลังบันทึก...";
  try {
    const now = new Date().toISOString();
    const currentUser = auth.currentUser;
    const payload = {
      name, description, type,
      min_quantity: minQty, min_subtotal: minSubtotal,
      discount_value: value, applies_to: appliesTo,
      category_id: appliesTo === "category" ? categoryId : null,
      category_name: appliesTo === "category" ? categoryName : "",
      start_at: startAt, end_at: endAt, active, priority,
      updated_at: now, updated_by: currentUser ? currentUser.email : ""
    };
    // 🚀 (H-7): เพิ่ม tiers field สำหรับ playlist_tiered_percent
    if (type === "playlist_tiered_percent") {
      payload.tiers = tiers;
      // ล้าง fields ที่ไม่ใช้
      payload.min_quantity = 0;
      payload.min_subtotal = 0;
      payload.discount_value = 0;
    } else {
      // ล้าง tiers field ถ้าไม่ใช่ playlist_tiered_percent (กัน leftover จาก edit)
      payload.tiers = null;
    }
    if (editingPromoId) {
      const existing = PROMOTIONS_CACHE.find(p => p.id === editingPromoId);
      if (existing) payload.created_by = existing.created_by || payload.updated_by;
      await updateDoc(doc(db, "promotions", editingPromoId), payload);
      promo_showToast("บันทึกแล้ว", "success");
    } else {
      payload.created_at = now;
      payload.created_by = currentUser ? currentUser.email : "";
      await setDoc(doc(collection(db, "promotions")), payload);
      promo_showToast("สร้างโปรโมชั่นใหม่แล้ว", "success");
    }
    document.getElementById("promotionFormBackdrop").classList.remove("show");
    clearPricingCache();
    await promo_loadData();
  } catch (err) {
    promo_showToast("บันทึกไม่สำเร็จ: " + (err.message || err), "error");
  }
  btn.disabled = false; btn.textContent = "บันทึก";
}

// 🚀 (2026-09-28 fix H-7): Helper อ่าน tiers จาก form
function promo_readTiersFromForm() {
  const tiers = [];
  const tierRows = document.querySelectorAll("#fPromoTiers .promo-tier-row");
  for (const row of tierRows) {
    const qtyInput = row.querySelector(".tier-qty");
    const pctInput = row.querySelector(".tier-pct");
    if (qtyInput && pctInput) {
      const qty = Number(qtyInput.value) || 0;
      const pct = Number(pctInput.value) || 0;
      if (qty > 0 && pct >= 0) {
        tiers.push({ min_quantity: qty, discount_percent: pct });
      }
    }
  }
  // sort จากน้อยไปมาก
  return tiers.sort((a, b) => a.min_quantity - b.min_quantity);
}

// 🚀 (H-7): Helper เพิ่ม row tier ใน form
function promo_addTierRow(minQty = "", pct = "") {
  const tiersEl = document.getElementById("fPromoTiers");
  if (!tiersEl) return;
  const row = document.createElement("div");
  row.className = "promo-tier-row";
  row.style.cssText = "display:flex;gap:8px;align-items:center;margin:4px 0;";
  row.innerHTML = `
    <input type="number" class="tier-qty" value="${minQty}" min="1" placeholder="จำนวนเพลย์ลิสต์" style="width:140px;">
    <span style="color:var(--text-dim);">เพลย์ลิสต์ → ลด</span>
    <input type="number" class="tier-pct" value="${pct}" min="0" max="100" placeholder="%" style="width:80px;">
    <span style="color:var(--text-dim);">%</span>
    <button type="button" class="promo-tier-remove" style="background:var(--danger);color:white;border:none;border-radius:4px;padding:4px 8px;cursor:pointer;">✕</button>
  `;
  row.querySelector(".promo-tier-remove").addEventListener("click", () => row.remove());
  tiersEl.appendChild(row);
}

// 🚀 (H-7): Helper ล้าง tiers ทั้งหมด
function promo_clearTiers() {
  const tiersEl = document.getElementById("fPromoTiers");
  if (tiersEl) tiersEl.innerHTML = "";
}

// 🚀 (H-7): Helper populate tiers จาก existing promotion (ตอน edit)
function promo_populateTiers(tiers) {
  promo_clearTiers();
  if (!Array.isArray(tiers) || tiers.length === 0) return;
  for (const t of tiers) {
    promo_addTierRow(t.min_quantity, t.discount_percent);
  }
}

function confirmDeletePromotion(id) {
  const p = PROMOTIONS_CACHE.find(x => x.id === id);
  if (!p) return;
  promo_openConfirm(
    `ต้องการลบโปรโมชั่น "${p.name || ''}" หรือไม่? ออเดอร์เก่าจะยังเห็นส่วนลดเดิม (เพราะ order เก็บ snapshot ไว้)`,
    async () => {
      try {
        await deleteDoc(doc(db, "promotions", id));
        promo_showToast("ลบแล้ว", "success");
        clearPricingCache();
        await promo_loadData();
      } catch (err) {
        promo_showToast("ลบไม่สำเร็จ: " + (err.message || err), "error");
      }
    }
  );
}

async function togglePromotionActive(id) {
  const p = PROMOTIONS_CACHE.find(x => x.id === id);
  if (!p) return;
  try {
    await updateDoc(doc(db, "promotions", id), {
      active: p.active === false ? true : false,
      updated_at: new Date().toISOString()
    });
    promo_showToast(p.active === false ? "เปิดใช้งานแล้ว" : "ปิดใช้งานแล้ว", "success");
    clearPricingCache();
    await promo_loadData();
  } catch (err) {
    promo_showToast("เปลี่ยนสถานะไม่สำเร็จ: " + (err.message || err), "error");
  }
}

export function initPromotionsView() {
  document.getElementById("addPromotionBtn").addEventListener("click", openAddPromotion);
  if (!promo_listenersBound) {
    document.getElementById("promotionFormClose").addEventListener("click", () => document.getElementById("promotionFormBackdrop").classList.remove("show"));
    document.getElementById("promotionSaveBtn").addEventListener("click", handleSavePromotion);
    document.getElementById("fPromoType").addEventListener("change", updatePromoTypeHint);
    document.getElementById("fPromoAppliesTo").addEventListener("change", updateAppliesToRow);
    // 🚀 (H-7): wire up Add Tier button
    const addTierBtn = document.getElementById("fPromoAddTier");
    if (addTierBtn) {
      addTierBtn.addEventListener("click", () => promo_addTierRow());
    }
    promo_listenersBound = true;
  }
  promo_loadData();
}

// ============================================================================
// PART 4: MY ORDERS VIEW (ลูกค้าติดตามออเดอร์ของตัวเองแบบ realtime)
// ============================================================================
//
// ⚠️ DEAD CODE: MY_ORDERS_STATE.unsubscribe (field ด้านล่าง) — ไม่มีทางทำงานจริง
//   - เดิมเคยเก็บฟังก์ชัน unsubscribe ที่ได้จาก listenCustomerOrders() หรือ onSnapshot()
//     (ตอนที่ PART 4 ใช้ polling ทุก 4 วิ)
//   - 2026-09-17: ย้ายไปใช้ fetchMyOrdersOnce() แบบ one-shot แทน (ลด D1 quota)
//   - ปัจจุบัน: unsubscribe ถูก set เป็น null เสมอ, ไม่เคยถูก assign ฟังก์ชัน unsubscribe จริง
//   - ที่ไม่ลบ: กฎของโปรเจกต์ "ห้ามลบโค้ดเพียงเพราะคิดว่าไม่ได้ใช้งาน"
//   - ถ้าอนาคตจะใช้ polling กลับมา: ต้อง assign ฟังก์ชัน unsubscribe จาก listenCustomerOrders()
//     ให้ MY_ORDERS_STATE.unsubscribe จริง ๆ ใน handleSearchMyOrders() ถึงจะทำงาน
//   - ถ้าจะลบ: ลบได้ทั้ง field + cleanup blocks ใน 3 ฟังก์ชันด้านล่าง
//     (handleSearchMyOrders บรรทัด 1314-1316, handleClearMyOrders บรรทัด 1329-1331, cleanupMyOrdersView บรรทัด 1495-1497)
//     ไม่กระทบระบบเดิมเพราะไม่มี caller จริง — แต่ต้องลบทั้ง 4 จุดพร้อมกัน (field + 3 cleanup blocks)

let MY_ORDERS_STATE = {
  initialized: false,
  unsubscribe: null,    // ← DEAD CODE — ดูคอมเมนต์ด้านบน
  customerName: "",
  customerWhatsapp: "",
  allOrders: [],
  myOrders: [],
  expandedOrderIds: new Set()
};

const MY_ORDER_STATUS_CONFIG = {
  pending_verify: { emoji: "🟡", label: "รอตรวจสอบการโอน", color: "#F5B400", bg: "rgba(245,180,0,.15)" },
  processing:     { emoji: "🔵", label: "ชำระเงินแล้ว - กำลังส่งเพลง", color: "#3B9EFF", bg: "rgba(59,158,255,.15)" },
  completed:      { emoji: "🟢", label: "สำเร็จ", color: "#28c76f", bg: "rgba(41,204,113,.15)" },
  cancelled:      { emoji: "🔴", label: "ยกเลิก", color: "#ff6b6b", bg: "rgba(255,107,107,.15)" },
};

function myOrders_escapeHtml(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function myOrders_formatPrice(v) { return Number(v || 0).toLocaleString("en-US") + " LAK"; }
function myOrders_normalizePhone(v) {
  let s = String(v || "").replace(/[^0-9+]/g, "");
  s = s.replace(/^\+/, "");
  if (s.startsWith("856")) {
    let rest = s.slice(3).replace(/^0+/, "");
    return "856" + rest;
  }
  if (s.startsWith("66")) {
    let rest = s.slice(2).replace(/^0+/, "");
    return "66" + rest;
  }
  // 🔧 (2026-09-22 fix Bug #1): ตรวจ Thai local (8/9 + 8 หลัก = 9 หลัก) → เติม 66
  let rest = s.replace(/^0+/, "");
  if (rest.length === 9 && (rest.startsWith("8") || rest.startsWith("9"))) {
    return "66" + rest;
  }
  return "856" + rest;
}
function myOrders_normalizeName(v) { return String(v || "").trim().toLowerCase(); }

function myOrders_showToast(message, type) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = message;
  el.className = "toast show" + (type ? " " + type : "");
  clearTimeout(myOrders_showToast._t);
  myOrders_showToast._t = setTimeout(() => { el.className = "toast"; }, 2600);
}

const MY_ORDERS_INFO_KEY = "music_store_my_orders_info_v1";

function saveMyOrdersInfo(name, whatsapp) {
  try { localStorage.setItem(MY_ORDERS_INFO_KEY, JSON.stringify({ name, whatsapp })); } catch (_) {}
}
function loadMyOrdersInfo() {
  try {
    const raw = localStorage.getItem(MY_ORDERS_INFO_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (_) { return null; }
}

function renderMyOrdersForm() {
  const container = document.getElementById("myOrdersView");
  if (!container) return;
  const saved = loadMyOrdersInfo();
  const savedName = saved?.name || "";
  const savedWhatsapp = saved?.whatsapp || "";

  container.innerHTML = `
    <div class="my-orders-header">
      <h2>📦 ออเดอร์ของฉัน</h2>
      <p>กรอกชื่อและเบอร์ WhatsApp ที่ใช้สั่งซื้อ — กด "รีเฟรช" เพื่อดูข้อมูลล่าสุด (ระบบจะอัปเดตอัตโนมัติเมื่อคุณกลับเข้าหน้านี้ใหม่)</p>
      <p style="font-size:12px;color:var(--text-dim);margin-top:4px;">หน้านี้แสดงเฉพาะออเดอร์ที่สั่งโดยไม่เข้าสู่ระบบ จากเบราว์เซอร์/อุปกรณ์นี้ — ออเดอร์ของสมาชิกดูได้ที่หน้า "บัญชี" หลังเข้าสู่ระบบ</p>
    </div>
    <!-- 🆕 (T014): ค้นหาด้วยเลขใบเสร็จ — ย้ายจาก topbar modal เดิม (trackOrderBtn) มาไว้ที่นี่
         ใช้ queryCustomerOrder (db-client.js) ที่เดียวกับ handleTrackOrderSubmit เดิม
         ผลลัพธ์แสดงผ่าน window.showReceipt เหมือนปุ่ม "ดูใบเสร็จ" ในลิสต์ออเดอร์ -->
    <div class="my-orders-receipt-search">
      <h3>🔍 ค้นหาด้วยเลขใบเสร็จ</h3>
      <p style="font-size:12px;color:var(--text-dim);margin:4px 0 10px;">
        มีเลขใบเสร็จอยู่แล้ว? กรอกเพื่อดูสถานะออเดอร์ได้เลย
      </p>
      <div class="field">
        <label>เลขใบเสร็จ *</label>
        <input id="myOrdersReceiptInput" type="text" placeholder="เช่น RCPT-20260909-ABC123" autocomplete="off">
      </div>
      <div class="field">
        <label>ชื่อลูกค้า *</label>
        <input id="myOrdersReceiptName" type="text" placeholder="ชื่อที่ใช้ตอนสั่งซื้อ" autocomplete="name">
      </div>
      <div class="field">
        <label>เบอร์โทร/WhatsApp *</label>
        <input id="myOrdersReceiptPhone" type="tel" inputmode="numeric" placeholder="20XXXXXXXX" autocomplete="tel">
      </div>
      <button class="btn" id="myOrdersReceiptSearchBtn" type="button">📄 ค้นหาออเดอร์</button>
      <div id="myOrdersReceiptFeedback" class="my-orders-feedback" style="display:none;" aria-live="polite" role="status"></div>
    </div>
    <hr style="border:none;border-top:1px solid var(--border);margin:16px 0;">
    <!-- existing form: ชื่อ+เบอร์ (เดิม) — ดูรายการออเดอร์ทั้งหมดของลูกค้า -->
    <div class="my-orders-form">
      <div class="field">
        <label>ชื่อที่ใช้สั่งซื้อ *</label>
        <input id="myOrdersName" type="text" placeholder="ชื่อ-นามสกุล" value="${myOrders_escapeHtml(savedName)}" autocomplete="off">
      </div>
      <div class="field">
        <label>เบอร์ WhatsApp ที่ใช้สั่งซื้อ *</label>
        <input id="myOrdersWhatsapp" type="tel" inputmode="numeric" placeholder="20XXXXXXXX" value="${myOrders_escapeHtml(savedWhatsapp)}" autocomplete="off">
      </div>
      <button class="btn" id="myOrdersSearchBtn" type="button">🔍 ดูออเดอร์ของฉัน</button>
      <!-- 🛡️ (r2-fern-mick-critical C7 fix): เพิ่ม aria-live="polite" role="status"
           ให้ screen reader announce feedback ให้ผู้ใช้ตาบอดได้ยิน -->
      <div id="myOrdersFeedback" class="my-orders-feedback" style="display:none;" aria-live="polite" role="status"></div>
    </div>
    <div id="myOrdersListContainer" style="display:none;">
      <div class="my-orders-list-header">
        <span id="myOrdersCountText" style="color:var(--text-dim);font-size:13px;"></span>
        <button class="btn secondary" id="myOrdersRefreshBtn" type="button" style="padding:6px 12px;font-size:13px;">🔄 รีเฟรช</button>
        <button class="btn secondary" id="myOrdersClearBtn" type="button" style="padding:6px 12px;font-size:13px;">↺ เปลี่ยนชื่อ/เบอร์</button>
      </div>
      <div id="myOrdersList"></div>
    </div>
  `;

  // 🆕 (T014): ผูกปุ่ม "ค้นหาด้วยเลขใบเสร็จ" — ใช้ queryCustomerOrder (db-client.js)
  //    reuse logic เดียวกับ handleTrackOrderSubmit เดิมใน app-user.js (ก่อน T014 ลบ)
  //    success → window.showReceipt (expose จาก app-cart.js/initCart ใน app-user.js)
  //    ไม่ duplicate logic — ใช้ server-side validation เดิม (_customer-query endpoint)
  const receiptSearchBtn = document.getElementById("myOrdersReceiptSearchBtn");
  if (receiptSearchBtn) {
    receiptSearchBtn.addEventListener("click", async () => {
      const receipt = document.getElementById("myOrdersReceiptInput")?.value?.trim() || "";
      const name = document.getElementById("myOrdersReceiptName")?.value?.trim() || "";
      const phone = document.getElementById("myOrdersReceiptPhone")?.value?.trim() || "";
      const feedback = document.getElementById("myOrdersReceiptFeedback");

      if (feedback) {
        feedback.style.display = "block";
        feedback.textContent = "";
      }

      // validate — ต้องกรอกครบทั้ง 3 ฟิลด์ (เหมือน handleTrackOrderSubmit เดิม)
      if (!receipt || !name || !phone) {
        if (feedback) {
          feedback.textContent = "กรุณากรอกเลขใบเสร็จ ชื่อ และเบอร์โทรให้ครบ";
          feedback.style.color = "var(--danger)";
        }
        return;
      }

      // เช็คเน็ตก่อนยิง request กันลูกค้ารอเปล่า ๆ ตอนออฟไลน์
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        if (feedback) {
          feedback.textContent = "ไม่มีสัญญาณอินเทอร์เน็ต กรุณาตรวจสอบการเชื่อมต่อแล้วลองใหม่อีกครั้ง";
          feedback.style.color = "var(--danger)";
        }
        return;
      }

      // ปุ่มขณะกำลังค้นหา
      const btn = receiptSearchBtn;
      const originalText = btn.textContent;
      btn.disabled = true;
      btn.textContent = "กำลังค้นหา...";

      if (feedback) {
        feedback.textContent = "⏳ กำลังค้นหา...";
        feedback.style.color = "var(--text-dim)";
      }

      try {
        // 🔒 Security: ใช้ queryCustomerOrder (server-side ตรวจ receipt+name+whatsapp พร้อมกัน)
        //    กัน browser เห็นข้อมูลคนอื่น (เดิมโหลด collection "orders" มากรองเองฝั่ง client)
        //    ใช้ timeout 15 วิ (เท่า handleTrackOrderSubmit เดิม) — กันค้างตลอด
        const result = await Promise.race([
          queryCustomerOrder({
            receiptNumber: receipt,
            customerName: name,
            whatsapp: phone,
          }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("ค้นหาใช้เวลานานเกินไป ลองอีกครั้ง")), 15000)
          ),
        ]);

        if (!result || !result.exists) {
          if (feedback) {
            feedback.textContent = "❌ ไม่พบออเดอร์ — ตรวจสอบเลขใบเสร็จ/ชื่อ/เบอร์ แล้วลองใหม่";
            feedback.style.color = "var(--danger)";
          }
          return;
        }

        // พบออเดอร์ — แสดง feedback สำเร็จ แล้วเปิด receipt modal
        if (feedback) {
          feedback.textContent = "✅ พบออเดอร์ — กำลังแสดงรายละเอียด...";
          feedback.style.color = "var(--success)";
        }

        // โครงสร้างเดียวกับที่ renderMyOrdersList ใช้ตอนกดปุ่ม "ดูใบเสร็จ"
        //    ดู app-promotion.js บริเวณ [data-order-pay] handler
        const order = { ...result.data, _docId: result.id };
        const receiptNumber = order.receipt_number || receipt;
        if (typeof window.showReceipt === "function") {
          window.showReceipt(order, receiptNumber, order.store_name || "Music Store");
        } else if (typeof window.openPaymentModal === "function") {
          // fallback — ถ้า showReceipt ยังไม่ถูก expose (กัน regression)
          window.openPaymentModal(order, receiptNumber);
        } else {
          if (feedback) {
            feedback.textContent = "✅ พบออเดอร์ แต่ไม่สามารถเปิดหน้ารายละเอียดได้ — ลองรีเฟรชหน้าแล้วกดอีกครั้ง";
            feedback.style.color = "var(--danger)";
          }
        }
      } catch (err) {
        console.error("myOrdersReceiptSearch error:", err);
        if (feedback) {
          const msg = (err && err.message) ? err.message : String(err);
          feedback.textContent = "❌ เกิดข้อผิดพลาด: " + msg;
          feedback.style.color = "var(--danger)";
        }
      } finally {
        btn.disabled = false;
        btn.textContent = originalText;
      }
    });
  }

  const searchBtn = document.getElementById("myOrdersSearchBtn");
  if (searchBtn) searchBtn.addEventListener("click", handleSearchMyOrders);
  const refreshBtn = document.getElementById("myOrdersRefreshBtn");
  // 🔧 (2026-09-17): เปลี่ยนจากแค่โชว์ toast → ยิง fetch จริง (ลด D1 quota ไม่มี polling ต่อเนื่อง)
  if (refreshBtn) refreshBtn.addEventListener("click", () => {
    if (MY_ORDERS_STATE.customerName && MY_ORDERS_STATE.customerWhatsapp) {
      myOrders_showToast("กำลังรีเฟรช...", "info");
      fetchMyOrdersOnce();
    } else {
      myOrders_showToast("กรอกชื่อและเบอร์ WhatsApp ก่อน", "error");
    }
  });
  const clearBtn = document.getElementById("myOrdersClearBtn");
  if (clearBtn) clearBtn.addEventListener("click", handleClearMyOrders);

  if (savedName && savedWhatsapp) {
    setTimeout(() => handleSearchMyOrders(), 100);
  }

  // 🔧 (2026-09-17): เพิ่ม visibility listener — เมื่อลูกค้าสลับ tab ไปอื่นแล้วกลับมา ให้ refresh ทันที
  // ทำงานคู่กับ fetchMyOrdersOnce (one-shot) ไม่ใช่ polling
  // กัน listener ซ้ำ: เก็บไว้ใน MY_ORDERS_STATE._visibilityHandler แล้วลบก่อนผูกใหม่
  if (MY_ORDERS_STATE._visibilityHandler) {
    document.removeEventListener("visibilitychange", MY_ORDERS_STATE._visibilityHandler);
  }
  MY_ORDERS_STATE._visibilityHandler = () => {
    // ถ้า tab กลับมา visible + ลูกค้าเคยกรอกข้อมูล + ยังอยู่ใน My Orders view → refresh ทันที
    if (document.visibilityState !== "visible") return;
    if (!MY_ORDERS_STATE.customerName || !MY_ORDERS_STATE.customerWhatsapp) return;
    // ตรวจว่ายังอยู่ใน My Orders view (container ยังโชว์อยู่) ก่อน refresh กัน refresh ที่ไม่จำเป็น
    const container = document.getElementById("myOrdersView");
    if (!container || container.style.display === "none") return;
    const listContainer = document.getElementById("myOrdersListContainer");
    if (!listContainer || listContainer.style.display === "none") return;
    fetchMyOrdersOnce();
  };
  document.addEventListener("visibilitychange", MY_ORDERS_STATE._visibilityHandler);
}

// 🔧 (2026-09-17): แยก fetchMyOrdersOnce ออกมาจาก handleSearchMyOrders เพื่อ reuse
//   (ใช้ทั้งตอน search ครั้งแรก, ตอนกดปุ่ม refresh, และตอน visibility เปลี่ยน)
// ทำงาน: ดึงออเดอร์ทั้งหมดของลูกค้าครั้งเดียว (one-shot) → render ลิสต์ + อัปเดต badge
// ไม่มี polling ต่อเนื่อง — ลด D1 quota อย่างมาก
async function fetchMyOrdersOnce() {
  const listEl = document.getElementById("myOrdersList");
  // โชว์ loading state เฉพาะถ้าลิสต์ว่างอยู่ (กันกระพริบตอน refresh ซ้ำ)
  if (listEl && (!MY_ORDERS_STATE.myOrders || MY_ORDERS_STATE.myOrders.length === 0)) {
    listEl.innerHTML = '<div class="empty-state">⏳ กำลังค้นหาออเดอร์ของคุณ...</div>';
  }
  try {
    // 🔒 Security (2026-09-11): ใช้ fetchCustomerOrdersOnce แทน listenCustomerOrders polling
    // Server กรองเฉพาะออเดอร์ของลูกค้าคนนี้ส่งกลับมา (เบอร์ต้องตรง 100%, ชื่อเปิดให้ fuzzy match)
    // กัน browser เห็นข้อมูลคนอื่นทั้งหมด (เดิมโหลด collection "orders" มากรองเองฝั่ง client)
    const { snap } = await fetchCustomerOrdersOnce({
      customerName: MY_ORDERS_STATE.customerName,
      whatsapp: MY_ORDERS_STATE.customerWhatsapp,
    });
    const myOrders = [];
    snap.forEach(d => myOrders.push({ _docId: d.id, ...d.data() }));
    myOrders.sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
    MY_ORDERS_STATE.myOrders = myOrders;
    renderMyOrdersList(myOrders);
    // 🔧 (2026-09-17): อัปเดต badge บนปุ่ม "ติดตามออเดอร์" ด้วย — ใช้ข้อมูลเดียวกับที่โหลดมาแล้ว
    // นับเฉพาะ active: pending_verify + processing
    if (window.__updateTrackOrderBadge) {
      const activeCount = myOrders.filter(o =>
        String(o?.status || "") === "pending_verify" || String(o?.status || "") === "processing"
      ).length;
      window.__updateTrackOrderBadge(activeCount);
    }
  } catch (err) {
    console.error("fetchMyOrdersOnce error:", err);
    if (listEl) listEl.innerHTML = `<div class="empty-state">⚠️ โหลดออเดอร์ไม่สำเร็จ: ${myOrders_escapeHtml(err.message || "")}</div>`;
  }
}

async function handleSearchMyOrders() {
  const nameInput = document.getElementById("myOrdersName");
  const whatsappInput = document.getElementById("myOrdersWhatsapp");
  const feedback = document.getElementById("myOrdersFeedback");
  if (!nameInput || !whatsappInput) return;

  const name = nameInput.value.trim();
  const whatsapp = whatsappInput.value.trim();
  const phone = myOrders_normalizePhone(whatsapp);
  const nameNorm = myOrders_normalizeName(name);

  if (!name || !phone) {
    if (feedback) {
      feedback.textContent = "กรุณากรอกชื่อและเบอร์ WhatsApp ให้ครบ";
      feedback.style.color = "var(--danger)";
      feedback.style.display = "block";
    }
    return;
  }
  if (phone.length < 8) {
    if (feedback) {
      // 🔧 (2026-09-21 fix Bug #2 Phone validation): เปลี่ยนข้อความ error ให้ชัดเจนขึ้น
      //   เดิม: "เบอร์ WhatsApp ไม่ถูกต้อง (ต้องมีอย่างน้อย 8 หลัก)"
      //   ใหม่: บอกตัวอย่างรูปแบบที่รองรับ → ลูกค้ารู้จะแก้ยังไง
      feedback.textContent = "เบอร์ WhatsApp ไม่ถูกต้อง — ตัวอย่างที่ใช้ได้: 02012345678, 2012345678, +8562012345678";
      feedback.style.color = "var(--danger)";
      feedback.style.display = "block";
    }
    return;
  }

  if (feedback) feedback.style.display = "none";

  saveMyOrdersInfo(name, whatsapp);
  MY_ORDERS_STATE.customerName = name;
  MY_ORDERS_STATE.customerWhatsapp = phone;

  // 🔧 (2026-09-17): ไม่มี unsubscribe อีกต่อไป (one-shot fetch) — แต่เก็บไว้สำหรับ back-compat
  // ถ้ามี handler เก่า (visibilitychange) ค้างอยู่ก็ลบก่อน
  //
  // ⚠️ DEAD CODE BLOCK: if (MY_ORDERS_STATE.unsubscribe) { ... } ด้านล่าง — ไม่มีทางทำงานจริง
  //   - MY_ORDERS_STATE.unsubscribe ถูก set เป็น null เสมอ, ไม่เคยถูก assign ฟังก์ชัน unsubscribe จริง
  //   - เดิมเคยใช้ตอน listener เป็น polling (listenCustomerOrders/onSnapshot)
  //   - ปัจจุบัน: ใช้ fetchMyOrdersOnce() แบบ one-shot, ไม่มี unsubscribe ต้องล้าง
  //   - ที่ไม่ลบ: กฎของโปรเจกต์ "ห้ามลบโค้ดเพียงเพราะคิดว่าไม่ได้ใช้งาน"
  //   - ดูคอมเมนต์ DEAD CODE ที่ MY_ORDERS_STATE declaration ด้านบนสำหรับรายละเอียดเต็ม
  //     (รวมวิธีลบแบบปลอดภัยถ้าอนาคตต้องการ)
  if (MY_ORDERS_STATE.unsubscribe) {
    try { MY_ORDERS_STATE.unsubscribe(); } catch (_) {}
    MY_ORDERS_STATE.unsubscribe = null;
  }

  const listContainer = document.getElementById("myOrdersListContainer");
  if (listContainer) listContainer.style.display = "block";

  // รีเซ็ต myOrders เพื่อให้ fetchMyOrdersOnce โชว์ loading state
  MY_ORDERS_STATE.myOrders = [];
  await fetchMyOrdersOnce();
}

function handleClearMyOrders() {
  // 🔧 (2026-09-17): ไม่มี unsubscribe อีกต่อไป (one-shot fetch) — แต่ล้าง handler เก่าถ้ามี
  //
  // ⚠️ DEAD CODE BLOCK: if (MY_ORDERS_STATE.unsubscribe) { ... } ด้านล่าง — ไม่มีทางทำงานจริง
  //   - MY_ORDERS_STATE.unsubscribe ถูก set เป็น null เสมอ, ไม่เคยถูก assign ฟังก์ชัน unsubscribe จริง
  //   - เดิมเคยใช้ตอน listener เป็น polling (listenCustomerOrders/onSnapshot)
  //   - ปัจจุบัน: ใช้ fetchMyOrdersOnce() แบบ one-shot, ไม่มี unsubscribe ต้องล้าง
  //   - ที่ไม่ลบ: กฎของโปรเจกต์ "ห้ามลบโค้ดเพียงเพราะคิดว่าไม่ได้ใช้งาน"
  //   - ดูคอมเมนต์ DEAD CODE ที่ MY_ORDERS_STATE declaration ด้านบนสำหรับรายละเอียดเต็ม
  if (MY_ORDERS_STATE.unsubscribe) {
    try { MY_ORDERS_STATE.unsubscribe(); } catch (_) {}
    MY_ORDERS_STATE.unsubscribe = null;
  }
  MY_ORDERS_STATE.myOrders = [];
  MY_ORDERS_STATE.expandedOrderIds = new Set();
  try { localStorage.removeItem(MY_ORDERS_INFO_KEY); } catch (_) {}
  renderMyOrdersForm();
  // 🔧 (2026-09-17): รีเฟรช badge บนปุ่ม "ติดตามออเดอร์" — ลูกค้าล้างข้อมูล → ไม่รู้จักลูกค้าคนนี้แล้ว → ซ่อน badge
  if (window.__refreshTrackOrderBadge) window.__refreshTrackOrderBadge();
}

function renderMyOrdersList(orders) {
  const listEl = document.getElementById("myOrdersList");
  const countEl = document.getElementById("myOrdersCountText");
  if (!listEl) return;
  if (countEl) {
    // 🔧 (2026-09-17): เปลี่ยนข้อความเพราะไม่ใช่ realtime อีกต่อไป — กดรีเฟรชเอง หรือกลับเข้า tab ใหม่
    countEl.textContent = `พบ ${orders.length} ออเดอร์ · กด "รีเฟรช" เพื่อดูข้อมูลล่าสุด`;
  }
  if (orders.length === 0) {
    listEl.innerHTML = `
      <div class="empty-state">
        ยังไม่พบออเดอร์ของคุณ<br>
        <small style="color:var(--text-dim);">ตรวจสอบชื่อและเบอร์ WhatsApp ว่าถูกต้องตรงกับที่ใช้สั่งซื้อ</small>
      </div>`;
    return;
  }
  listEl.innerHTML = orders.map(o => renderOneOrderCard(o)).join("");

  listEl.querySelectorAll("[data-toggle-order]").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-toggle-order");
      if (MY_ORDERS_STATE.expandedOrderIds.has(id)) {
        MY_ORDERS_STATE.expandedOrderIds.delete(id);
      } else {
        MY_ORDERS_STATE.expandedOrderIds.add(id);
      }
      renderMyOrdersList(MY_ORDERS_STATE.myOrders);
    });
  });

  // 🆕 (2026-10-02): ปุ่มชำระเงิน — เรียก openPaymentModal (จาก app-cart.js)
  listEl.querySelectorAll("[data-order-pay]").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const orderId = btn.getAttribute("data-order-pay");
      const order = MY_ORDERS_STATE.myOrders.find(o => (o._docId || "") === orderId);
      if (!order) return;
      const receiptNumber = order.receipt_number || orderId.slice(0, 8);
      // เรียก window.openPaymentModal (expose จาก app-cart.js) หรือ showReceipt
      if (typeof window.showReceipt === "function") {
        window.showReceipt(order, receiptNumber, order.store_name || "Music Store");
      } else if (typeof window.openPaymentModal === "function") {
        window.openPaymentModal(order, receiptNumber);
      }
    });
  });

  // 🆕 (2026-10-02): ปุ่มลบออเดอร์ — เรียก handleCustomerDeleteOrder (จาก app-user.js)
  listEl.querySelectorAll("[data-order-delete]").forEach(btn => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const orderId = btn.getAttribute("data-order-delete");
      const order = MY_ORDERS_STATE.myOrders.find(o => (o._docId || "") === orderId);
      if (!order) return;
      if (typeof window.handleCustomerDeleteOrder === "function") {
        await window.handleCustomerDeleteOrder(order, () => {
          // หลังลบ → รีเฟรช list
          MY_ORDERS_STATE.myOrders = MY_ORDERS_STATE.myOrders.filter(o => (o._docId || "") !== orderId);
          renderMyOrdersList(MY_ORDERS_STATE.myOrders);
        });
      }
    });
  });

  // 🆕 (2026-10-02): ปุ่มฟังเพลง — เรียก playSong (จาก app-user.js)
  listEl.querySelectorAll("[data-order-play]").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const songId = btn.getAttribute("data-order-play");
      if (typeof window.playSong === "function") {
        window.playSong(songId);
      }
    });
  });
}

function renderOneOrderCard(order) {
  const orderId = order._docId || "";
  const cfg = MY_ORDER_STATUS_CONFIG[order.status] || MY_ORDER_STATUS_CONFIG.pending_verify;
  const date = order.created_at ? new Date(order.created_at) : null;
  const dateStr = date ? date.toLocaleString("th-TH", { dateStyle: "medium", timeStyle: "short" }) : "-";
  const receiptNumber = order.receipt_number || "-";
  const items = order.items || [];

  const finalTotal = (order.final_total != null) ? Number(order.final_total) : Number(order.total || 0);
  const subtotal = (order.subtotal != null) ? Number(order.subtotal) : finalTotal;
  const discountAmount = Number(order.discount_amount || 0);
  // 🚀 (2026-09-29 STACK): รองรับหลาย promo — อ่านจาก promotions_applied ก่อน ถ้าไม่มีใช้ promotion_applied
  const promosAppliedList = (() => {
    if (Array.isArray(order.promotions_applied)) {
      return order.promotions_applied.filter(p => p && p.id && Number(p.discount_amount) > 0);
    }
    if (order.promotion_applied && typeof order.promotion_applied === "object" && order.promotion_applied.id) {
      const p = order.promotion_applied;
      if (Number(p.discount_amount) > 0) {
        return [{
          id: p.id,
          name: p.name || "",
          type: p.type || "",
          discount_value: Number(p.discount_value) || 0,
          applies_to: p.applies_to || "all",
          category_id: p.category_id || null,
          scope: (p.applies_to === "playlist") ? "playlist" : "song",
          eligible_count: p.eligible_count || 0,
          discount_amount: Number(p.discount_amount) || 0,
          tier_applied: p.tier_applied || null,
          snapshot_at: p.snapshot_at || null,
        }];
      }
    }
    return [];
  })();
  const totalPromoDiscount = promosAppliedList.reduce((s, p) => s + (Number(p.discount_amount) || 0), 0);

  const isExpanded = MY_ORDERS_STATE.expandedOrderIds.has(orderId);

  const itemSummary = items.length > 0
    ? items.slice(0, 3).map(i => myOrders_escapeHtml(i.title || "เพลง")).join(", ") + (items.length > 3 ? ` +${items.length - 3}` : "")
    : "-";

  let discountBadge = "";
  if (discountAmount > 0) {
    const parts = [];
    // 🚀 (STACK): แสดงทุกชื่อ promo คั่นด้วย " + "
    if (promosAppliedList.length > 0) {
      const promoLabels = promosAppliedList.map(p => `🎁 ${myOrders_escapeHtml(p.name)}`);
      parts.push(promoLabels.join(" + "));
    }
    const itemDiscount = discountAmount - totalPromoDiscount;
    if (itemDiscount > 0) parts.push(`🏷️ ลดราคาปกติ`);
    discountBadge = `<div class="my-order-discount-badge" style="color:var(--accent-2,#ec4899);font-size:12px;margin-top:4px;">⚡ ${parts.join(" + ")} · ลด ${myOrders_formatPrice(discountAmount)}</div>`;
  }

  let expandedHtml = "";
  if (isExpanded) {
    const itemRows = items.map(item => {
      if (item.kind === "playlist") {
        const songTitles = Array.isArray(item.song_titles) ? item.song_titles : [];
        const songLines = songTitles.map(t => `<div style="padding:2px 0 2px 14px;font-size:11px;color:var(--text-dim);">• ${myOrders_escapeHtml(t)}</div>`).join("");
        return `
          <div class="my-order-item-row" style="border-bottom:none;flex-direction:column;align-items:stretch;gap:2px;">
            <div style="display:flex;justify-content:space-between;">
              <strong>🎶 ${myOrders_escapeHtml(item.title || "เพลย์ลิสต์")}</strong>
              <strong>${myOrders_formatPrice(item.price)}</strong>
            </div>
            ${songLines}
          </div>`;
      }
      return `
        <div class="my-order-item-row">
          <div>${myOrders_escapeHtml(item.title || "เพลง")}</div>
          <strong>${myOrders_formatPrice(item.price)}</strong>
        </div>`;
    }).join("");

    let discountRows = "";
    if (subtotal !== finalTotal && subtotal > 0) {
      discountRows += `<div class="my-order-item-row" style="border-top:1px dashed var(--border);margin-top:6px;padding-top:6px;"><span style="color:var(--text-dim);">ยอดรวมก่อนลด</span><span>${myOrders_formatPrice(subtotal)}</span></div>`;
    }
    // 🚀 (STACK): แสดงแต่ละ promo แยกบรรทัด (ถ้ามี 2 โปร → 2 บรรทัด)
    for (const p of promosAppliedList) {
      const promoAmount = Number(p.discount_amount) || 0;
      if (promoAmount > 0 && p.name) {
        discountRows += `<div class="my-order-item-row" style="color:var(--success);"><span>🎁 ${myOrders_escapeHtml(p.name)}</span><span>-${myOrders_formatPrice(promoAmount)}</span></div>`;
      }
    }
    if (discountAmount > 0) {
      const itemDiscount = discountAmount - totalPromoDiscount;
      if (itemDiscount > 0) {
        discountRows += `<div class="my-order-item-row" style="color:var(--accent-2,#ec4899);"><span>🏷️ ส่วนลดจากราคาปกติ</span><span>-${myOrders_formatPrice(itemDiscount)}</span></div>`;
      }
    }

    let zipInfo = "";
    if (order.zip_download_url && (order.status === "processing" || order.status === "completed")) {
      zipInfo = `
        <div class="my-order-zip-info" style="margin-top:10px;padding:10px;background:rgba(16,185,129,.08);border-radius:10px;">
          <div style="font-size:12px;color:var(--success);font-weight:600;margin-bottom:6px;">📦 ไฟล์เพลงพร้อมดาวน์โหลด</div>
          <a href="${myOrders_escapeHtml(order.zip_download_url)}" target="_blank" rel="noopener" class="btn" style="display:inline-block;padding:8px 16px;font-size:13px;">⬇️ ดาวน์โหลด ZIP (${myOrders_escapeHtml(order.zip_file_name || 'Order.zip')})</a>
        </div>`;
    } else if (order.status === "processing") {
      zipInfo = `<div style="margin-top:10px;font-size:12px;color:var(--accent);">⏳ แอดมินกำลังเตรียมไฟล์ ZIP ส่งให้คุณ — รอสักครู่</div>`;
    } else if (order.status === "pending_verify") {
      zipInfo = `<div style="margin-top:10px;font-size:12px;color:var(--text-dim);">⏳ รอแอดมินตรวจสอบการโอนเงิน — หลังยืนยันแล้วไฟล์จะถูกเตรียมให้</div>`;
    }

    // 🆕 (2026-10-02): ปุ่มต่าง ๆ ในรายละเอียดออเดอร์
    //   - ปุ่มชำระเงิน (ถ้ายังไม่ชำระ: pending_verify)
    //   - ปุ่มลบออเดอร์ (ถ้ายังไม่ยืนยัน: pending_verify)
    //   - ปุ่มฟังเพลง (preview เพลงในออเดอร์)
    let actionButtons = "";
    // ปุ่มชำระเงิน — แสดงถ้ายังไม่ชำระ (pending_verify และยังไม่มี payment_proof_status='pending')
    const showPayBtn = (order.status === "pending_verify" && (!order.payment_proof_status || order.payment_proof_status === "rejected"));
    if (showPayBtn) {
      actionButtons += `<button type="button" class="btn" data-order-pay="${myOrders_escapeHtml(orderId)}" style="display:inline-block;padding:8px 14px;font-size:13px;background:var(--accent);color:#fff;border:none;border-radius:8px;cursor:pointer;margin-top:8px;margin-right:6px;">💳 ชำระเงิน</button>`;
    }
    // ปุ่มลบออเดอร์ — แสดงถ้ายังไม่ยืนยัน (pending_verify)
    if (order.status === "pending_verify") {
      actionButtons += `<button type="button" class="btn" data-order-delete="${myOrders_escapeHtml(orderId)}" style="display:inline-block;padding:8px 14px;font-size:13px;background:rgba(239,68,68,.12);color:var(--danger);border:1px solid rgba(239,68,68,.25);border-radius:8px;cursor:pointer;margin-top:8px;">🗑 ลบออเดอร์</button>`;
    }
    // ปุ่มฟังเพลง — แสดงเสมอสำหรับเพลงในออเดอร์ (ฟัง preview ได้)
    if (items.length > 0) {
      // ดึง song_id จาก items (item.song_id หรือ item.song_ids)
      const songIds = [];
      for (const item of items) {
        if (item.song_id) songIds.push(item.song_id);
        if (Array.isArray(item.song_ids)) songIds.push(...item.song_ids);
      }
      if (songIds.length > 0) {
        const firstSongId = songIds[0];
        actionButtons += `<button type="button" class="btn" data-order-play="${myOrders_escapeHtml(firstSongId)}" style="display:inline-block;padding:8px 14px;font-size:13px;background:rgba(139,92,246,.12);color:var(--accent);border:1px solid var(--accent);border-radius:8px;cursor:pointer;margin-top:8px;margin-left:6px;">🎵 ฟังเพลง</button>`;
      }
    }

    expandedHtml = `
      <div class="my-order-detail" style="margin-top:10px;padding-top:10px;border-top:1px solid var(--border);">
        <div style="font-size:12px;color:var(--text-dim);margin-bottom:6px;">รายการสินค้า (${items.length})</div>
        ${itemRows || '<div class="empty-state" style="padding:6px 0;">ไม่มีรายการ</div>'}
        ${discountRows}
        <div class="my-order-item-row" style="border-top:1px solid var(--border);margin-top:6px;padding-top:6px;font-weight:800;">
          <span>ยอดชำระ</span>
          <strong style="color:var(--success);">${myOrders_formatPrice(finalTotal)}</strong>
        </div>
        ${zipInfo}
        ${actionButtons ? `<div style="margin-top:10px;display:flex;flex-wrap:wrap;gap:6px;">${actionButtons}</div>` : ""}
      </div>`;
  }

  return `
    <div class="my-order-card${isExpanded ? ' expanded' : ''}" data-order-id="${myOrders_escapeHtml(orderId)}">
      <div class="my-order-card-header" data-toggle-order="${myOrders_escapeHtml(orderId)}" style="cursor:pointer;">
        <div style="flex:1;min-width:0;">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;flex-wrap:wrap;">
            <span class="my-order-status-badge" style="background:${cfg.bg};color:${cfg.color};">${cfg.emoji} ${cfg.label}</span>
            <span style="font-size:11px;color:var(--text-dim);">#${myOrders_escapeHtml(receiptNumber)}</span>
          </div>
          <div style="font-size:14px;font-weight:600;margin-bottom:2px;">${itemSummary}</div>
          <div style="font-size:11px;color:var(--text-dim);">${dateStr}</div>
          ${discountBadge}
        </div>
        <div style="text-align:right;">
          <div style="font-size:16px;font-weight:800;color:var(--success);">${myOrders_formatPrice(finalTotal)}</div>
          <div style="font-size:11px;color:var(--text-dim);">${isExpanded ? '▲ ซ่อน' : '▼ ดู'}รายละเอียด</div>
        </div>
      </div>
      ${expandedHtml}
    </div>
  `;
}

export function initMyOrdersView() {
  renderMyOrdersForm();
}

export function cleanupMyOrdersView() {
  // 🔧 (2026-09-17): ไม่มี unsubscribe อีกต่อไป (one-shot fetch) — แต่ล้าง handler เก่าถ้ามี
  //
  // ⚠️ DEAD CODE BLOCK: if (MY_ORDERS_STATE.unsubscribe) { ... } ด้านล่าง — ไม่มีทางทำงานจริง
  //   - MY_ORDERS_STATE.unsubscribe ถูก set เป็น null เสมอ, ไม่เคยถูก assign ฟังก์ชัน unsubscribe จริง
  //   - เดิมเคยใช้ตอน listener เป็น polling (listenCustomerOrders/onSnapshot)
  //   - ปัจจุบัน: ใช้ fetchMyOrdersOnce() แบบ one-shot, ไม่มี unsubscribe ต้องล้าง
  //   - ที่ไม่ลบ: กฎของโปรเจกต์ "ห้ามลบโค้ดเพียงเพราะคิดว่าไม่ได้ใช้งาน"
  //   - ดูคอมเมนต์ DEAD CODE ที่ MY_ORDERS_STATE declaration ด้านบนสำหรับรายละเอียดเต็ม
  //   - ⚠️ ข้อควรระวัง: cleanupMyOrdersView ถูกเรียกจาก app-user.js (บรรทัด 1072, 1083, 1090, 1101)
  //     ในตอน switch tab — ถ้าจะลบ block นี้ต้องเก็บฟังก์ชัน cleanupMyOrdersView ไว้
  //     ลบได้แค่ block ของ unsubscribe ด้านใน อย่าลบทั้งฟังก์ชัน
  if (MY_ORDERS_STATE.unsubscribe) {
    try { MY_ORDERS_STATE.unsubscribe(); } catch (_) {}
    MY_ORDERS_STATE.unsubscribe = null;
  }
  // ล้าง visibility listener ด้วย (ตั้งไว้ใน renderMyOrdersForm)
  if (MY_ORDERS_STATE._visibilityHandler) {
    document.removeEventListener("visibilitychange", MY_ORDERS_STATE._visibilityHandler);
    MY_ORDERS_STATE._visibilityHandler = null;
  }
}

// 🆕 (2026-10-02 fix): expose fetchMyOrdersOnce + MY_ORDERS_STATE ให้ customer-auth.js ใช้ได้
window.fetchMyOrdersOnce = fetchMyOrdersOnce;
window.MY_ORDERS_STATE = MY_ORDERS_STATE;

// 🆕 (2026-10-02): expose renderOneOrderCard + renderMyOrdersList ให้ app-user.js ใช้
window.renderOneOrderCard = renderOneOrderCard;
window.renderMyOrdersList = renderMyOrdersList;
