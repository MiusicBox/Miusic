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
  collection, doc, getDocs, setDoc, updateDoc, deleteDoc, query, onSnapshot, listenCustomerOrders,
  // 🔧 (2026-09-17): เพิ่ม fetchCustomerOrdersOnce สำหรับ one-shot fetch (ไม่ polling) ลด D1 quota
  //    ↑ ↑ ↑ ฟังก์ชันนี้แหละที่ใช้จริงในไฟล์นี้ (แทน listenCustomerOrders เดิม) ใน PART 4: MY ORDERS VIEW
  fetchCustomerOrdersOnce
// 🔧 (2026-09-17 v2): เพิ่ม ?v=20260917-polling-fix บังคับ browser โหลด db-client.js ใหม่ (กัน cache เก่า)
} from "./db-client.js?v=20260917-polling-fix";

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

// ---------------- ดึง discount ที่ active ทั้งหมด ----------------
export async function fetchActiveDiscounts(forceRefresh) {
  if (_discountsCache && !forceRefresh) return _discountsCache;
  try {
    const snap = await getDocs(collection(db, "discounts"));
    const now = Date.now();
    const items = [];
    snap.forEach(d => {
      const data = d.data();
      if (data && data.active !== false && isWithinDateRange(data.start_at, data.end_at, now)) {
        items.push({ id: d.id, ...data });
      }
    });
    _discountsCache = items;
    return items;
  } catch (err) {
    console.warn("fetchActiveDiscounts error:", err);
    return [];
  }
}

// ---------------- ดึง promotions ที่ active ทั้งหมด ----------------
export async function fetchActivePromotions(forceRefresh) {
  if (_promotionsCache && !forceRefresh) return _promotionsCache;
  try {
    const snap = await getDocs(collection(db, "promotions"));
    const now = Date.now();
    const items = [];
    snap.forEach(d => {
      const data = d.data();
      if (data && data.active !== false && isWithinDateRange(data.start_at, data.end_at, now)) {
        items.push({ id: d.id, ...data });
      }
    });
    items.sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
    _promotionsCache = items;
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
  if (appliesTo === "all") return true;
  if (appliesTo === "category") {
    if (item.kind && item.kind !== "song") return false;
    const catId = item.category_id || item.categoryId || null;
    if (!catId || !promotion.category_id) return false;
    return catId === promotion.category_id;
  }
  return false;
}

// ---------------- คำนวณ promotion ที่เข้าเงื่อนไขและเลือกอันที่ลดมากที่สุด ----------------
export function computeBestPromotion(items, promotions) {
  if (!Array.isArray(items) || items.length === 0 || !Array.isArray(promotions) || promotions.length === 0) {
    const subtotal = (items || []).reduce((s, it) => s + (Number(it.price) || 0), 0);
    return { bestPromotion: null, eligibleCount: 0, discountAmount: 0, subtotal };
  }
  const subtotal = items.reduce((s, it) => s + (Number(it.price) || 0), 0);
  let bestDiscount = 0;
  let bestEligibleCount = 0;
  let bestPromoObj = null;
  for (const promo of promotions) {
    const eligibleItems = items.filter(it => {
      if (it._hadDiscount) return false;
      if (it.kind === "playlist") return false;
      return isItemInPromotionScope(it, promo);
    });
    const eligibleCount = eligibleItems.length;
    if (eligibleCount === 0) continue;
    if (promo.min_quantity && eligibleCount < promo.min_quantity) continue;
    const eligibleSubtotal = eligibleItems.reduce((s, it) => s + (Number(it.price) || 0), 0);
    if (promo.min_subtotal && eligibleSubtotal < promo.min_subtotal) continue;
    let promoDiscount = 0;
    if (promo.type === "cart_percent") {
      const pct = Math.max(0, Math.min(100, Number(promo.discount_value) || 0));
      promoDiscount = Math.round(eligibleSubtotal * pct / 100);
    } else if (promo.type === "cart_fixed") {
      promoDiscount = Math.min(eligibleSubtotal, Math.round(Number(promo.discount_value) || 0));
    } else if (promo.type === "buy_x_get_y_percent") {
      const pct = Math.max(0, Math.min(100, Number(promo.discount_value) || 0));
      promoDiscount = Math.round(eligibleSubtotal * pct / 100);
    } else {
      continue;
    }
    if (promoDiscount > bestDiscount) {
      bestDiscount = promoDiscount;
      bestEligibleCount = eligibleCount;
      bestPromoObj = promo;
    }
  }
  return {
    bestPromotion: bestPromoObj,
    eligibleCount: bestEligibleCount,
    discountAmount: bestDiscount,
    subtotal
  };
}

// ---------------- คำนวณราคาสุดท้ายของตะกร้า ----------------
export function computeCartPricing(cartItems, discounts, promotions) {
  const dList = discounts || _discountsCache || [];
  const pList = promotions || _promotionsCache || [];
  if (!Array.isArray(cartItems) || cartItems.length === 0) {
    return { subtotal: 0, discountSubtotal: 0, itemDiscountAmount: 0, promoDiscountAmount: 0, discountAmount: 0, promotionApplied: null, finalTotal: 0, items: [] };
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
  const { bestPromotion, eligibleCount, discountAmount: promoDiscountAmount } = computeBestPromotion(promoInput, pList);
  const finalTotal = Math.max(0, discountSubtotal - promoDiscountAmount);
  const discountAmount = itemDiscountAmount + promoDiscountAmount;
  let promotionApplied = null;
  if (bestPromotion) {
    promotionApplied = {
      id: bestPromotion.id,
      name: bestPromotion.name || "",
      type: bestPromotion.type || "",
      discount_value: Number(bestPromotion.discount_value) || 0,
      applies_to: bestPromotion.applies_to || "all",
      category_id: bestPromotion.category_id || null,
      eligible_count: eligibleCount,
      discount_amount: promoDiscountAmount,
      snapshot_at: new Date().toISOString()
    };
  }
  return {
    subtotal, discountSubtotal, itemDiscountAmount, promoDiscountAmount,
    discountAmount, promotionApplied, finalTotal, items: itemsWithDiscount
  };
}

// ---------------- ฟอร์แมตวันที่สำหรับแสดงในหน้า admin ----------------
export function formatDateTime(iso) {
  if (!iso) return "-";
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "-";
    return d.toLocaleString("th-TH", {
      day: "2-digit", month: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit"
    });
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
  wrap.innerHTML = PROMOTIONS_CACHE.map(p => {
    const status = getDiscountStatus(p);
    const appliesToLabel = p.applies_to === "category" ? `เฉพาะหมวด: ${promo_escapeHtml(p.category_name || '-')}` : "ทุกเพลง";
    const minQtyLabel = p.min_quantity ? `ซื้อครบ ${p.min_quantity} เพลง` : "ไม่มีขั้นต่ำ";
    const valueLabel = p.type === "cart_percent" || p.type === "buy_x_get_y_percent" ? `ลด ${p.discount_value}%` : `ลด ${Number(p.discount_value).toLocaleString()} LAK`;
    const typeLabel = p.type === "buy_x_get_y_percent" ? "ซื้อ X ลด %" : (p.type === "cart_percent" ? "ลด % ทั้งยอด" : "ลดจำนวนเงิน");
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
  document.getElementById("fPromoCategoryRow").style.display = "none";
  document.getElementById("fPromoCategory").value = "";
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
    buy_x_get_y_percent: "ซื้อครบ X เพลง → ลด Y% ของยอดเพลงที่เข้าโปร (ตั้งค่า min_quantity = X, discount_value = Y%)"
  };
  hintEl.textContent = hints[type] || "";
  hintEl.style.color = "var(--text-dim)";
}

async function handleSavePromotion() {
  const btn = document.getElementById("promotionSaveBtn");
  const name = document.getElementById("fPromoName").value.trim();
  const description = document.getElementById("fPromoDesc").value.trim();
  const type = document.getElementById("fPromoType").value;
  const minQty = Number(document.getElementById("fPromoMinQty").value) || 0;
  const minSubtotal = Number(document.getElementById("fPromoMinSubtotal").value) || 0;
  const value = Number(document.getElementById("fPromoValue").value) || 0;
  const appliesTo = document.getElementById("fPromoAppliesTo").value;
  const categorySel = document.getElementById("fPromoCategory");
  const categoryId = categorySel.value;
  const categoryName = categorySel.options[categorySel.selectedIndex]?.dataset?.name || "";
  const startAt = promo_fromLocalDatetimeInput(document.getElementById("fPromoStartAt").value);
  const endAt = promo_fromLocalDatetimeInput(document.getElementById("fPromoEndAt").value);
  const active = document.getElementById("fPromoActive").checked;
  const priority = Number(document.getElementById("fPromoPriority").value) || 100;

  if (!name) { promo_showToast("กรุณาตั้งชื่อโปรโมชั่น", "error"); return; }
  if (value <= 0) { promo_showToast("กรุณากรอกค่าส่วนลด (ต้องมากกว่า 0)", "error"); return; }
  if ((type === "cart_percent" || type === "buy_x_get_y_percent") && value > 100) { promo_showToast("เปอร์เซ็นต์ต้องไม่เกิน 100", "error"); return; }
  if (!startAt) { promo_showToast("กรุณาตั้งวันเริ่มต้น", "error"); return; }
  if (!endAt) { promo_showToast("กรุณาตั้งวันสิ้นสุด", "error"); return; }
  if (new Date(endAt) <= new Date(startAt)) { promo_showToast("วันสิ้นสุดต้องหลังวันเริ่มต้น", "error"); return; }
  if (appliesTo === "category" && !categoryId) { promo_showToast("กรุณาเลือกหมวดหมู่", "error"); return; }
  if (type === "buy_x_get_y_percent" && minQty <= 0) { promo_showToast("ประเภท 'ซื้อ X ลด %' ต้องตั้ง min_quantity มากกว่า 0", "error"); return; }

  btn.disabled = true; btn.textContent = "กำลังบันทึก...";
  try {
    const now = new Date().toISOString();
    const currentUser = auth.currentUser;
    const payload = {
      name, description, type, min_quantity: minQty, min_subtotal: minSubtotal,
      discount_value: value, applies_to: appliesTo,
      category_id: appliesTo === "category" ? categoryId : null,
      category_name: appliesTo === "category" ? categoryName : "",
      start_at: startAt, end_at: endAt, active, priority,
      updated_at: now, updated_by: currentUser ? currentUser.email : ""
    };
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
  // 🔧 (2026-09-22 v2 — รองรับทั้ัง ลาว+ไทย): เก็บเบอร์ WITH country code ใน DB
  //   สอดคล้องกับ normalizePhoneForStorage ใน app-cart.js (ที่แก้พร้อมกัน)
  //   + normalizePhoneServer ใน worker/index.js + normalizePhone ใน app-user.js
  //   รูปแบบที่เก็บ:
  //     ลาว: "85620XXXXXXXX" (มี country code 856)
  //     ไทย: "668XXXXXXXX" (มี country code 66)
  //   ทำให้ลูกค้าค้นหาออเดอร์ได้โดยใส่เบอร์รูปแบบใดก็ได้ (local/international/with or without +)
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
  // ไม่มี country code → สันนิษฐานว่าเป็นลาว
  let rest = s.replace(/^0+/, "");
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
    </div>
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
      <div id="myOrdersFeedback" class="my-orders-feedback" style="display:none;"></div>
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
  const promotionApplied = order.promotion_applied;

  const isExpanded = MY_ORDERS_STATE.expandedOrderIds.has(orderId);

  const itemSummary = items.length > 0
    ? items.slice(0, 3).map(i => myOrders_escapeHtml(i.title || "เพลง")).join(", ") + (items.length > 3 ? ` +${items.length - 3}` : "")
    : "-";

  let discountBadge = "";
  if (discountAmount > 0) {
    const parts = [];
    if (promotionApplied && promotionApplied.name) parts.push(`🎁 ${myOrders_escapeHtml(promotionApplied.name)}`);
    const promoAmount = promotionApplied?.discount_amount || 0;
    const itemDiscount = discountAmount - promoAmount;
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
    if (promotionApplied && promotionApplied.name) {
      const promoAmount = promotionApplied.discount_amount || 0;
      if (promoAmount > 0) {
        discountRows += `<div class="my-order-item-row" style="color:var(--success);"><span>🎁 ${myOrders_escapeHtml(promotionApplied.name)}</span><span>-${myOrders_formatPrice(promoAmount)}</span></div>`;
      }
    }
    if (discountAmount > 0) {
      const promoAmount = promotionApplied?.discount_amount || 0;
      const itemDiscount = discountAmount - promoAmount;
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
