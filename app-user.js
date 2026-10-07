// app-user.js — หน้า User: ดึงข้อมูลจาก Cloudflare D1, เล่นเพลงจาก Cloudflare R2 โดยตรง
// ===================================================
import { db } from "./firebase-init.js?v=20260905-fix1";
// 🔧 (ใหม่) ระบบจัดเรียงหมวดหมู่/DJ/เพลย์ลิสต์ ตามพยัญชนะไทย ก-ฮ + A-Z + ตัวเลข
import { sortByThaiName, sortSongsByThaiName } from "./thai-sort.js?v=20261007-sort-key";
// ────────────────────────────────────────────────────────────────────────────
// ⚠️  สำหรับ Dev ใหม่: อ่านก่อนแก้ import block นี้  ────────────────────────
// ────────────────────────────────────────────────────────────────────────────
// onSnapshot และ listenCustomerOrders ใน import ด้านล่างเป็น "DEAD IMPORTS"
// คือ import เข้ามาแต่ **ไม่มีการเรียกใช้จริง** ในไฟล์ app-user.js ทั้งหมด (ยืนยันด้วย grep)
//
//   ประวัติ:
//     - ก่อน 2026-09-17: เคยใช้ onSnapshot/listenCustomerOrders สำหรับ realtime polling
//       ออเดอร์ของลูกค้า (track order all list + badge)
//     - 2026-09-17: ย้ายไปใช้ fetchCustomerOrdersOnce() แบบ one-shot แทน (ลด D1 quota)
//
//   ที่ไม่ลบ imports ทิ้ง:
//     - กฎของโปรเจกต์: "ห้ามลบโค้ดเพียงเพราะคิดว่าไม่ได้ใช้งาน"
//     - เผื่ออนาคตจะใช้ onSnapshot/listenCustomerOrders จริง ๆ
//
//   ⚠️ ถ้าจะลบ imports ทิ้ง:
//      - ต้องลบ exports ใน db-client.js ด้วย (บรรทัด 204 และ 290 ของ db-client.js)
//      - และลบ imports ใน app-promotion.js บรรทัด 22 ด้วย (มี dead imports เหมือนกัน)
//      - ไม่งั้นไม่พัง (เพราะไม่ได้ใช้) แต่เป็น code smell ถ้าเหลืออยู่ฝั่งเดียว
// ────────────────────────────────────────────────────────────────────────────
import {
  collection, getDocs, doc, getDoc, query, where, deleteDoc, queryCustomerOrder,
  // 🔧 (2026-09-17): เพิ่ม fetchCustomerOrdersOnce สำหรับ one-shot fetch (ไม่ polling) ลด D1 quota
  //    ↑ ↑ ↑ ฟังก์ชันนี้แหละที่ใช้จริงในไฟล์นี้ (แทน listenCustomerOrders เดิม)
  fetchCustomerOrdersOnce,
  // 🆕 (T015): advancedSearchSongs — server-side advanced search (multi-DJ, multi-category, price range, etc.)
  advancedSearchSongs,
  // 🔧 (T-sync-bugs-fix-H5 2026-10-06): import scopedStorageKey เพื่ออ่าน/ลบ last order record ที่ถูกต้อง
  //   เดิม: app-user.js อ่าน key "music_store_last_order_v1" ตรง ๆ แต่ db-client.js migrate ลบไปแล้ว
  //   ผลกระทบเดิม: หลังลบออเดอร์ + reload → banner ยังแสดงออเดอร์ที่ลบไป (เพราะอ่าน legacy key ไม่เจอ)
  //   วิธีแก้: ใช้ scopedStorageKey("music_store_last_order_v1") ที่จะให้ key ที่ถูกต้องตาม scope (guest/login:ID)
  scopedStorageKey
// 🔧 (2026-09-17 v2): เพิ่ม ?v=20260917-polling-fix บังคับ browser โหลด db-client.js ใหม่ (กัน cache เก่า)
} from "./db-client.js?v=20261005-T015-advanced-search";
import { initCart } from "./app-cart.js?v=20261006-T049";
// ===== ลดราคา + โปรโมชั่น + ออเดอร์ของฉัน (ระบบใหม่ — รวมในไฟล์เดียว app-promotion.js) =====
import {
  fetchActiveDiscounts, fetchActivePromotions, applyDiscountToPrice, findActiveDiscountFor,
  initMyOrdersView, cleanupMyOrdersView,
  // 🎁 (2026-09-20) เพิ่มใหม่: formatDateTime ใช้สำหรับแสดงวันที่ในหน้าโปรโมชั่นพรีวิว (เรียกจาก app-promotion.js ที่มีอยู่แล้ว)
  formatDateTime
} from "./app-promotion.js?v=20261003-login-guest-v11";
// 🔧 (T116 2026-10-07 fix): ปรับ version จาก v10 → v11 ให้ตรงกับ app-cart.js + orders.js
//   - Bug: cache-bust version ต่างกัน → ES module ถือว่าเป็น 2 instances คนละตัว
//     app-user.js (v10) init() populate _discountsCache ใน v10 instance
//     app-cart.js (v11) renderCart() อ่าน _discountsCache จาก v11 instance (ว่าง!)
//     → ราคาลดไม่แสดงในตะกร้าทั้วที่มี discount active
//   - Fix: ใช้ v11 ทั้วหมด → module instance เดียวกัน → cache ใช้ร่วมกันได้
//   - ผลกระทบระบบเดิม: 0% — เปลี่ยน cache-bust string เท่านั้น ไม่แตะ logic

const STATE = {
  songs: [], categories: [], djs: [], playlists: [], settings: {},
  discounts: [],  // ← ลดราคาที่ active อยู่ตอนนี้ (โหลดครั้งเดียวตอน init)
  promotions: [], // 🎁 (2026-09-20) เพิ่มใหม่: โปรโมชั่นที่ active อยู่ตอนนี้ (โหลดครั้งเดียวตอน init — เชื่อมกับหน้า admin จัดการโปรโมชั่น)
  currentCategory: "all", currentDj: null, search: "",
  currentView: "home",
  currentPlayingId: null,   // id ของเพลงที่กำลังเล่น/พักอยู่ในเครื่องเล่น
  currentLoadingId: null,   // id ของเพลงที่กำลังโหลดอยู่
  currentPreview: null,     // { start, end } วินาที ของเพลงที่กำลังเล่นอยู่ ถ้ามี Auto Preview (ไม่มี = เล่นเต็มไฟล์แบบเดิม)
  cart: []
};
const AUDIO = new Audio();
let audioUnlocked = false;

// 🆕 (T013-R3): TODO: migrate to shared-utils.js in next refactor round
//   Helpers ที่ซ้ำกับ shared-utils.js (สร้างใหม่ใน T013): showToast, escapeHtml, formatPrice,
//   buildWhatsAppLink, debounce, normalizePhone, normalizeName
//   อย่าลบ helpers เดิมทันที — migrate ทีละไฟล์ + test รอบละไฟล์เพื่อความปลอดภัย
//   ดู /shared-utils.js สำหรับ implementation ที่รวบรวมแล้ว
// 🆕 (T105): showToast แบบสวย — มี icon + progress bar + ปุ่มปิด
//   type: "success" | "error" | "info" | "progress" | undefined (default=info)
//   icon อัตโนมัติตาม type: ✅ ❌ ℹ️ ⏳
//   backward compat: ทุก caller เดิมยังทำงานเหมือนเดิม (message, type)
function showToast(message, type) {
  const el = document.getElementById("toast");
  if (!el) return;
  // 🆕 (T105): icon ตาม type
  const icons = {
    success: "✅",
    error: "❌",
    info: "ℹ️",
    progress: "⏳",
    success_long: "✅",
    error_long: "❌",
  };
  const icon = icons[type] || icons.info;
  // 🆕 (T105): ใช้ toast-text แทน textContent ตรง ๆ (รองรับ icon + close button)
  const textEl = el.querySelector(".toast-text");
  const iconEl = el.querySelector(".toast-icon");
  if (textEl) {
    textEl.textContent = message;
  } else {
    // fallback: ถ้าไม่มี .toast-text (old HTML) → ใช้ textContent ตรง ๆ
    el.textContent = message;
  }
  if (iconEl) iconEl.textContent = icon;
  el.className = "toast show" + (type ? " " + type : "");
  clearTimeout(showToast._t);
  // 🆕 (T105): duration ตาม type — progress/error_long นานกว่า
  const duration = type === "progress" ? 6000 : type === "error_long" ? 6000 : type === "success_long" ? 4000 : 2600;
  showToast._t = setTimeout(() => { el.className = "toast"; }, duration);
}

function escapeHtml(str) {
  return String(str == null ? "" : str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function formatPrice(v) { return Number(v || 0).toLocaleString("en-US") + " LAK"; }

// ===== เพิ่มใหม่: helper สำหรับแสดงราคาลด — ใช้แทน formatPrice ในจุดที่ต้องการแสดงส่วนลด =====
// ทำงานร่วมกับ STATE.discounts (โหลดตอน init) — หา discount ของเพลง/เพลย์ลิสต์ แล้ว render
// ราคาปกติ (ขีดฆ่า) + ราคาลด (เน้นสี) ถ้ามี discount active
// ถ้าไม่มี discount → แสดงราคาปกติเหมือนเดิม (back-compat)
function renderDiscountedPriceForSong(song) {
  if (!song) return `<span class="song-price">${formatPrice(0)}</span>`;
  const original = Number(song.price) || 0;
  const discount = findActiveDiscountFor({ targetType: "song", targetId: song.id, discounts: STATE.discounts });
  if (!discount) return `<span class="song-price">${formatPrice(original)}</span>`;
  const { finalPrice, hasDiscount } = applyDiscountToPrice(original, discount);
  if (!hasDiscount) return `<span class="song-price">${formatPrice(original)}</span>`;
  // 🆕 (T037): ราคา 2 แถว — ขีดข้าบน, หลังลดล่าง
  return `<div class="price-stack"><span class="price-original">${formatPrice(original)}</span><span class="price-discounted">${formatPrice(finalPrice)}</span></div>`;
}

// 🆕 (2026-10-07): เช็คว่าเพลย์ลิสต์มีโปรโมชัน/ส่วนลดที่ใช้งานอยู่จริงไหม
//   ใช้ logic เดียวกับ renderDiscountedPriceForPlaylist (findActiveDiscountFor + applyDiscountToPrice)
//   → เพลย์ลิสต์ที่โชว์ราคาขีดฆ่า = เพลย์ลิสต์ที่ผ่านตัวกรอง "เฉพาะเพลงที่มีโปรโมชัน"
function playlistHasActiveDiscount(playlist) {
  if (!playlist) return false;
  const original = Number(playlist.price) || 0;
  if (original <= 0) return false;
  try {
    const discount = findActiveDiscountFor({ targetType: "playlist", targetId: playlist.id, discounts: STATE.discounts });
    if (!discount) return false;
    return !!applyDiscountToPrice(original, discount).hasDiscount;
  } catch (_) {
    return false;
  }
}

function renderDiscountedPriceForPlaylist(playlist) {
  if (!playlist) return `<span class="song-price">${formatPrice(0)}</span>`;
  const original = Number(playlist.price) || 0;
  const discount = findActiveDiscountFor({ targetType: "playlist", targetId: playlist.id, discounts: STATE.discounts });
  if (!discount) return `<span class="song-price">${formatPrice(original)}</span>`;
  const { finalPrice, hasDiscount } = applyDiscountToPrice(original, discount);
  if (!hasDiscount) return `<span class="song-price">${formatPrice(original)}</span>`;
  // 🆕 (T037): ราคา 2 แถว — ขีดข้าบน, หลังลดล่าง
  return `<div class="price-stack"><span class="price-original">${formatPrice(original)}</span><span class="price-discounted">${formatPrice(finalPrice)}</span></div>`;
}

// สำหรับ label ปุ่ม "เพิ่มเข้าตะกร้า · X LAK" — แสดงแค่ราคาสุดท้าย (เพราะเป็น text ไม่ใช่ HTML)
function getDiscountedPriceForSongLabel(song) {
  if (!song) return formatPrice(0);
  const original = Number(song.price) || 0;
  const discount = findActiveDiscountFor({ targetType: "song", targetId: song.id, discounts: STATE.discounts });
  if (!discount) return formatPrice(original);
  const { finalPrice, hasDiscount } = applyDiscountToPrice(original, discount);
  return formatPrice(hasDiscount ? finalPrice : original);
}

// ส่งออก helper ให้ app-cart.js ใช้ผ่าน initCart options (จะใช้ตอน render ตะกร้า)
// แต่เนื่องจาก initCart ถูกเรียกก่อน STATE.discounts โหลดเสร็จ — cart จะอ่าน STATE.discounts ตอน renderCart
// (ไม่ได้ snapshot ตอน init)

function formatTime(sec) {
  if (!isFinite(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return m + ":" + (s < 10 ? "0" : "") + s;
}

// ---- เพิ่มใหม่: ค่าคงที่สถานะออเดอร์ (ฝั่งลูกค้า) ----
// คัดลอกค่ามาจาก STATUS_CONFIG ใน orders.js เพื่อแสดงผลให้ตรงกับฝั่งแอดมิน
// ทำเป็นชุดแยกต่างหาก (ไม่ import orders.js) เพราะ orders.js มี dependency
// สำหรับงานแอดมินล้วน ๆ (jszip/storage-adapter) ที่ไม่จำเป็นต้องโหลดในหน้าลูกค้า
const TRACK_STATUS_CONFIG = {
  pending_verify: { emoji: "🟡", label: "รอตรวจสอบการโอน", color: "#F5B400", bg: "rgba(245,180,0,.15)" },
  processing:     { emoji: "🔵", label: "ชำระเงินแล้ว - กำลังส่งเพลง", color: "#3B9EFF", bg: "rgba(59,158,255,.15)" },
  completed:      { emoji: "🟢", label: "สำเร็จ", color: "#28c76f", bg: "rgba(41,204,113,.15)" },
  cancelled:      { emoji: "🔴", label: "ยกเลิก", color: "#ff6b6b", bg: "rgba(255,107,107,.15)" },
};

function buildWhatsAppLink(number, text) {
  const clean = String(number || "").replace(/[^0-9]/g, "");
  return "https://wa.me/" + clean + "?text=" + encodeURIComponent(text);
}

// 🆕 (T044-C): formatPhoneForDisplay — แปลงเบอร์ normalized → รูปแบบอ่านง่าย
//   ใช้ใน receipt (app-cart.js) + my-orders (app-promotion.js) + ส่งเข้า initCart
//   TODO (T013-R3): migrate to shared-utils.js — ตอนนี้ inline เหมือน helpers อื่น ๆ
function formatPhoneForDisplay(phone) {
  if (!phone) return "";
  let s = String(phone).replace(/[^0-9]/g, "");
  if (!s) return "";
  if (s.startsWith("856")) {
    const rest = s.slice(3);
    if (rest.startsWith("20") && rest.length === 10) {
      return `+856 20 ${rest.slice(2, 6)} ${rest.slice(6)}`;
    }
    if (rest.length >= 6 && rest.length <= 9) {
      const mid = rest.slice(0, Math.ceil(rest.length / 2));
      const end = rest.slice(Math.ceil(rest.length / 2));
      return `+856 ${mid} ${end}`;
    }
    return `+856 ${rest}`;
  }
  if (s.startsWith("66")) {
    const rest = s.slice(2);
    if (rest.length === 9 && /^[6-9]/.test(rest)) {
      return `+66 ${rest.slice(0, 2)} ${rest.slice(2, 5)} ${rest.slice(5)}`;
    }
    if (rest.length >= 6 && rest.length <= 9) {
      const mid = rest.slice(0, Math.ceil(rest.length / 2));
      const end = rest.slice(Math.ceil(rest.length / 2));
      return `+66 ${mid} ${end}`;
    }
    return `+66 ${rest}`;
  }
  return s;
}
// expose ให้ app-cart.js + app-promotion.js ใช้ผ่าน window (เหมือน showReceipt)
window.formatPhoneForDisplay = formatPhoneForDisplay;

function debounce(fn, wait) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), wait); }; }
const { loadCart, bindCartEvents, addToCart, getLastOrderRecord, showReceipt, updatePendingPaymentInfo, getOrderPaymentState, openPaymentModal } = initCart({
  state: STATE,
  showToast,
  escapeHtml,
  formatPrice,
  buildWhatsAppLink,
  formatPhoneForDisplay,
  // 🔧 (2026-09-26) เพิ่มใหม่: ปุ่ม "ไปชำระเงิน" บนแถบเตือน (app-cart.js) เรียก callback นี้
  //   เพื่อเปิด modal "ติดตามออเดอร์" โหมด "ออเดอร์ทั้งหมดของฉัน" — ฟังก์ชันจริงอยู่ด้านล่างในไฟล์นี้
  //   (function declaration ถูก hoisted จึงอ้างอิงได้แม้นิยามอยู่ถัดไปในไฟล์)
  openTrackOrderAllPicker: () => openPendingPaymentPicker()
});

// 🆕 (2026-10-02 fix): expose showReceipt + openPaymentModal ไป window
//   ให้ app-promotion.js ใช้ในปุ่ม "ชำระเงิน" ในรายละเอียดออเดอร์
//   (showReceipt/openPaymentModal มาจาก initCart return → อยู่ใน module scope ของ app-user.js)
window.showReceipt = showReceipt;
window.openPaymentModal = openPaymentModal;
// 🆕 (2026-10-02 v6 fix): expose addToCart + findSong ไป window
//   ให้ customer-auth.js เรียกได้จากหน้าบัญชี (ปุ่ม 🛒 ในบันทึกซื้อทีหลัง)
//   (addToCart/findSong อยู่ใน module scope ของ app-user.js → ต้อง expose ถึงเรียกได้)
window.addToCart = addToCart;
window.findSong = findSong;

// 💙 (2026-09-20): สไตล์ C2 Vivid Cyan — แยกตัวอักษรชื่อร้านเป็น span.char
// 🎨 (T047): applyStoreNameAnimation — เปลี่ยนจากสีฟ้านีออนกระโดดทีละตัว
//   เป็น gradient accent (ม่วง→ชมพู) สไตล์หนังสือสวยงามเข้ากับธีมเว็บ
//
//   เดิม (C2 Vivid Cyan): แยกตัวอักษรเป็น <span class="char"> + สีฟ้าไล่สว่าง→มืด + animation กระโดด
//     → ดูเด่นเป็น neon sign ไม่เข้ากับธีม (dark theme + accent ม่วง/ชมพู)
//
//   ใหม่ (Elegant Gradient): ใช้ gradient text ม่วง→ชมพู (accent → accent-2) + glow หายใจเบา ๆ
//     → สไตล์หนังสืออ่านง่าย สวยงาม เข้ากับธีมเว็บ
//     → ยังเก็บ animation ไว้ แต่เปลี่ยนจากกระโดดเป็น glow pulse (subtle)
//
//   ผลกระทบระบบเดิม: 0% — แค่เปลี่ยนสี + animation ไม่แตะโครงสร้าง HTML
function applyStoreNameAnimation(el) {
  if (!el) return;
  const text = el.textContent || "Music Store";
  // 🆕 (T047): ใช้ gradient text เข้ากับธีม (accent ม่วง → accent-2 ชมพู)
  //   ไม่แยกตัวอักษรอีกต่อไป — ใช้ CSS background-clip: text ทั้งข้อความ
  //   ลดการกิน CPU จากการ render แต่ละ span + animation ทุกตัวอักษร
  el.innerHTML = text;
  // เก็บ raw text ไว้ใน dataset เผื่อกรณีต้องการ access (debug)
  el.dataset.rawText = text;
}

async function init() {
  loadCart();
  bindCartEvents();
  // 🆕 (T009-F1): แสดง skeleton loader ทันทีก่อนโหลดข้อมูล — กันจอว่าง ๆ ตอนรอ fetch
  //   ใส่ก่อน Promise.all (categories/djs/playlists) เพราะขั้นตอนนี้ใช้เวลาเช่นกัน
  //   skeleton จะถูกแทนที่ด้วยการ์ดเพลงจริงเมื่อ renderSongGrid() ถูกเรียกท้าย init()
  renderSongSkeleton(12);
  const [catSnap, djSnap, playlistSnap, settingsSnap] = await Promise.all([
    getDocs(collection(db, "categories")),
    getDocs(collection(db, "djs")),
    getDocs(collection(db, "playlists")),
    getDoc(doc(db, "settings", "main"))
  ]);
  STATE.categories = sortByThaiName(catSnap.docs.map(d => ({ id: d.id, ...d.data() })), "category_name");
  STATE.djs = sortByThaiName(djSnap.docs.map(d => ({ id: d.id, ...d.data() })), "dj_name");
  STATE.playlists = sortByThaiName(playlistSnap.docs.map(d => ({ id: d.id, ...d.data() })), "playlist_name");
  loadPlaylistCounts(); // 🆕 (Playlist-Scale) เบื้องหลัง ไม่รอ
  STATE.settings = settingsSnap.exists() ? settingsSnap.data() : {};

  // 🔧 (2026-09-18 v6 perf): โหลด songs แบบ pagination + slim (50 songs/page)
  //   เดิม: getDocs(collection(db, "songs")) → โหลดทุกเพลงทีเดียว → ช้ามากเมื่อ 5000+ เพลง
  //   ใหม่: fetch("/api/db/songs?limit=50&offset=0&slim=1") → โหลด 50 เพลง/page
  //   ทยอยโหลด page ถัดไปเมื่อ user scroll ผ่าน IntersectionObserver (ดู setupSongListInfinityScroll)
  //   ลดเวลาโหลดจาก 30s+ → 1s สำหรับ 5000+ เพลง
  STATE.songs = [];
  STATE.songsPage = 0;          // page ปัจจุบัน (0 = ยังไม่โหลด, 1 = page แรก)
  STATE.songsHasMore = true;    // ยังมี page ถัดไปไหม
  STATE.songsLoading = false;   // กำลังโหลดอยู่ไหม (กัน concurrent fetch)
  await loadMoreSongs();        // โหลด page 1 ก่อน render

  // ===== โหลด active discounts ครั้งเดียว (สำหรับแสดงราคาลดบนหน้าเว็บลูกค้า) =====
  // ใช้ forceRefresh=false — ถ้ามี cache ใน pricing.js จะใช้ cache นั้น
  // การ cache ปลอดภัยเพราะระบบ cart จะ re-resolve จาก db อีกครั้งตอน checkout (resolveCartFromDatabase)
  try {
    STATE.discounts = await fetchActiveDiscounts();
  } catch (e) {
    console.warn("โหลด discounts ไม่สำเร็จ — แสดงราคาปกติ", e);
    STATE.discounts = [];
  }

  // ===== เพิ่มใหม่ (แก้บั๊ก 2026-09-10): โหลด active promotions ครั้งเดียวตอน init เช่นเดียวกับ discounts =====
  // เดิมที่นี่มีแต่ fetchActiveDiscounts() — ไม่เคยเรียก fetchActivePromotions() เลยตอนโหลดหน้าเว็บ
  // ทำให้ cache โปรโมชั่นฝั่งแสดงผล (_promotionsCache ใน app-promotion.js) ว่างเปล่าตลอด จนกว่าจะถึง
  // ขั้นตอน checkout จริง (resolveCartFromDatabase ใน app-cart.js เรียก fetchActivePromotions(true) บังคับ
  // ดึงใหม่อยู่แล้วตอนนั้น — ยอดที่คิดเงินจริงจึงถูกต้องเสมอ) แต่ราคา "โดยประมาณ" ที่โชว์ในตะกร้า/หน้าสรุป
  // ก่อนกดยืนยันสั่งซื้อ ไม่เคยรวมส่วนลดจากโปรโมชั่นเลย เพิ่มบรรทัดนี้เพื่อให้ราคาที่แสดงตรงกับราคาจริง
  // ตั้งแต่แรก ไม่กระทบการคำนวณราคาจริงตอน checkout แต่อย่างใด
  try {
    await fetchActivePromotions();
  } catch (e) {
    console.warn("โหลด promotions ไม่สำเร็จ — ตะกร้าจะยังไม่แสดงส่วนลดโปรโมชั่น (ราคาจริงตอนสั่งซื้อยังถูกต้อง)", e);
  }

  // 🎁 (2026-09-20) เพิ่มใหม่: เก็บ active promotions ไว้ใน STATE.promotions เพื่อใช้ในหน้าพรีวิวโปรโมชั่น
  //   - fetchActivePromotions() ด้านบนเก็บผลลัพธ์ใน cache (_promotionsCache ใน app-promotion.js) แล้ว
  //   - ที่นี่ดึง cache นั้นมาเก็บใน STATE.promotions เพื่อใช้ในฝั่ง UI โดยตรง
  //   - ไม่กระทบระบบ cart (cart จะ fetchActivePromotions(true) บังคับ refresh ใหม่ตอน checkout อยู่แล้ว)
  //   - ถ้าไม่มีโปรโมชั่น active → STATE.promotions = [] (empty array) — หน้าพรีวิวจะแสดง empty state
  //   🚀 (2026-09-28 fix H-7): forceRefresh=true เพื่อข้าม cache ที่อาจเก่า → แน่ใจว่าเห็น tiered promo
  try {
    STATE.promotions = await fetchActivePromotions(true);
  } catch (e) {
    console.warn("โหลด promotions สำหรับหน้าพรีวิวไม่สำเร็จ — หน้าโปรโมชั่นจะแสดง empty state", e);
    STATE.promotions = [];
  }

  const siteNameEl = document.getElementById("siteName");
  if (siteNameEl) {
    siteNameEl.textContent = STATE.settings.website_name || "Music Store";
    // 💙 (2026-09-20): สไตล์ C2 Vivid Cyan — แยกตัวอักษรเป็น span.char
    //   แต่ละตัวได้สีฟ้าไล่จากสว่าง→มืด + animation-delay ต่างกัน (กระโดดทีละตัว)
    applyStoreNameAnimation(siteNameEl);
  }
  document.title = STATE.settings.website_name || "Music Store";

  if (STATE.settings.meta_description) {
    const metaTag = document.querySelector('meta[name="description"]');
    if (metaTag) metaTag.setAttribute("content", STATE.settings.meta_description);
  }
  if (STATE.settings.website_logo) {
    const logo = document.getElementById("siteLogo");
    if (logo) {
      logo.src = STATE.settings.website_logo;
      logo.style.display = "block";
    }
  }
  // 🆕 (T019): update Hero Banner ด้วย settings (website_name + meta_description)
  //   - ถ้ามี settings.website_name → เปลี่ยน hero title เป็น "🎵 ยินดีต้อนรับสู่ {website_name}"
  //   - ถ้ามี settings.meta_description → เปลี่ยน hero subtitle
  //   - ถ้าไม่มี → คงค่า default ใน HTML (Miusic + tagline)
  //   - ปุ่ม CTA → scroll ไปที่ #songGrid (เริ่มฟังเพลง)
  //   - ไม่กระทบระบบเดิม — ใช้ optional chaining + guard ทุกจุด
  try {
    const heroTitle = document.getElementById("heroTitle");
    const heroSubtitle = document.getElementById("heroSubtitle");
    if (heroTitle && STATE.settings && STATE.settings.website_name) {
      heroTitle.textContent = `🎵 ยินดีต้อนรับสู่ ${STATE.settings.website_name}`;
    }
    if (heroSubtitle && STATE.settings && STATE.settings.meta_description) {
      heroSubtitle.textContent = STATE.settings.meta_description;
    }
    // hero CTA — scroll ไปที่ songGrid (เริ่มฟังเพลง)
    const heroCtaBtn = document.getElementById("heroCtaBtn");
    if (heroCtaBtn) {
      heroCtaBtn.addEventListener("click", () => {
        const songGrid = document.getElementById("songGrid");
        if (songGrid) songGrid.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    }
  } catch (err) {
    console.warn("[init] T019 hero banner setup failed:", err?.message || err);
  }

  renderCategoryChips();
  renderDjRow();
  renderCategoryGrid(); // 🆕 (T019): วาด category showcase grid (หลัง renderCategoryChips — ใช้ STATE.categories + STATE.songs)
  renderPlaylists();
  renderSongGrid();
  renderPromotionBanner(); // 🎁 (2026-09-20) เพิ่มใหม่: แสดงแบนเนอร์โปรโมชั่นเด่นบนหน้าแรก (ถ้ามีโปร active)
  setView("home");
  togglePlaylistsVisibility();
  // 🆕 (T098): Auto-open song modal จาก URL ?song=<id> (deep link)
  //   เรียกหลัง renderSongGrid (STATE.songs โหลดแล้ว) — ถ้ามี ?song= → openSongModal อัตโนมัติ
  //   ผลกระทบระบบเดิม: 0% — ถ้า URL ไม่มี ?song= → return ทันที ไม่ทำอะไร
  try { openSongModalFromUrl(); } catch (err) { console.warn("[T098] openSongModalFromUrl failed:", err?.message || err); }
  // 🔧 (2026-09-18 v6 perf): ติดตั้ง IntersectionObserver สำหรับ load-more-on-scroll
  //   เมื่อ user scroll ถึง card สุดท้าย → trigger loadMoreSongs() → append page ถัดไป
  setupSongListInfinityScroll();
  // 🎁 (2026-09-20) เพิ่มใหม่: เริ่ม countdown timer สำหรับแบนเนอร์โปรโมชั่น (อัปเดตทุก 1 วินาที)
  //   - ไม่กระทบระบบเดิม — ใช้ interval แยก ปิดได้ผ่าน stopPromoCountdown() ถ้าต้องการ
  //   - ปลอดภัยเพราะเช็ค element ทุกรอบ ถ้า element ไม่อยู่ → ข้ามไปเงียบ ๆ
  startPromoCountdown();

  // 🆕 (2026-10-03 team-fix): เริ่มต้น WhatsApp FAB (ปุ่มลอยที่แทนที่ tab "ติดต่อ" เดิม)
  //   - ปุ่มนี้อยู่ใน HTML แล้ว (#whatsappFab) — ตรงนี้แค่ผูก click handler
  //   - ใช้ STATE.settings.whatsapp_number ที่โหลดจาก settings ด้านบน
  try { initWhatsappFab(); } catch (err) { console.warn("[init] initWhatsappFab failed:", err?.message || err); }

  // 🆕 (T045): PhoneInput country selector — mount บนทุก input ที่เกี่ยวกับเบอร์โทร/WhatsApp
  //   - auto-detect จาก prefix ของเบอร์ที่พิมพ์ (020 → ลาว, 08/09/06 → ไทย)
  //   - จดจำการเลือกใน localStorage (music_store_phone_country)
  //   - mount หลัง DOM ready + หลัง customer-auth.js render เสร็จ (ใช้ setTimeout 0)
  try {
    setTimeout(() => {
      if (window.PhoneInput && window.PhoneInput.mountAll) {
        // mount บน input ที่อยู่ใน HTML ตอนโหลดหน้า
        window.PhoneInput.mountAll('input[id="checkoutCustomerWhatsapp"], input[id="trackOrderPhone"], input[id="trackOrderAllPhone"], input[id="customerAuthWhatsapp"]');
      }
    }, 0);
  } catch (err) { console.warn("[init] PhoneInput mount failed:", err?.message || err); }

  // 🆕 (T011-F6): เริ่มต้น scroll-to-top button — ปุ่มลอยเลื่อนขึ้นบน
  //   - ผูก scroll listener (passive) + click handler
  //   - แสดงปุ่มเมื่อ scroll ผ่าน 400px, ซ่อนเมื่อกลับขึ้นบน
  try { initScrollTopBtn(); } catch (err) { console.warn("[init] initScrollTopBtn failed:", err?.message || err); }

  // 🆕 (T015): เริ่มต้น advanced filter modal — วาด chip DJ/หมวด + ผูก event listeners
  //   - ทำงานครั้งเดียวหลัง STATE.djs + STATE.categories โหลดเสร็จ (Promise.all ด้านบน)
  //   - ไม่กระทบระบบเดิม — ถ้า element ไม่อยู่ → ข้ามเงียบ ๆ (defensive)
  //   - หลังจากนี้ user กดปุ่ม "ขั้นสูง" ใน search-box เพื่อเปิด modal แล้วเลือก filter ได้
  //   - renderAdvFilterChips จะถูกเรียกอีกครั้งทุกครั้งที่เปิด modal (กันกรณี STATE.djs/categories โหลดตอนหลัง)
  try {
    renderAdvFilterChips(); // 🆕 (T015-v2): เปลี่ยนจาก renderFilterCheckboxes → renderAdvFilterChips (ใช้ chip-style แทน checkbox)
    setupAdvancedFilters();
    // 🆕 (Feature #2): setup social share buttons in song modal
    setupShareButtons();
  } catch (err) {
    console.warn("[init] T015 advanced filter setup failed:", err?.message || err);
  }

  // 🆕 (T020): เริ่มต้น song review handlers — ผูก click ดาว + submit + delete + login prompt
  //   - ทำครั้งเดียวหลัง DOM ready (ไม่ต้องรอ STATE เพราะใช้ element id เท่านั้น)
  //   - ไม่กระทบระบบเดิม — ถ้า element ไม่อยู่ → ข้ามเงียบ ๆ (defensive)
  //   - หลังจากนี้ user เปิด song modal → loadSongReviews() จะถูกเรียก → แสดงรีวิว + form
  try {
    setupReviewHandlers();
  } catch (err) {
    console.warn("[init] T020 review handlers setup failed:", err?.message || err);
  }
}

// 🆕 (T011-F6): initScrollTopBtn — ผูก logic ของปุ่ม scroll-to-top
//   - ใช้ passive scroll listener เพื่อไม่บล็อกการ scroll
//   - ใช้ smooth scroll behavior ตอนคลิก
//   - ไม่กระทบ routing/tab logic เดิม — ใช้ window.scroll ตรง ๆ
//   ผลกระทบระบบเดิม: 0% — เพิ่มปุ่มใหม่ ไม่แตะการ scroll เดิม
function initScrollTopBtn() {
  const btn = document.getElementById("scrollTopBtn");
  if (!btn) return;
  let ticking = false;
  function updateVisibility() {
    ticking = false;
    if (window.scrollY > 400) {
      btn.classList.add("is-visible");
    } else {
      btn.classList.remove("is-visible");
    }
  }
  window.addEventListener("scroll", () => {
    if (!ticking) {
      window.requestAnimationFrame(updateVisibility);
      ticking = true;
    }
  }, { passive: true });
  btn.addEventListener("click", () => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
  // เรียกครั้งแรกเผื่อ user refresh กลางหน้า (scrollY > 400 อยู่แล้ว)
  updateVisibility();
}

// 🔧 (2026-09-18 v6 perf): โหลดเพลง page ถัดไป (50 songs/page)
// ใช้ fetch ตรงแทน getDocs เพราะ db-client.js ไม่รองรับ pagination query params
//   - ส่ง ?limit=50&offset=(page*50)&slim=1 → Worker pagination + slim fields
//   - รับ array ของ { id, data } → push เข้า STATE.songs
//   - ถ้าได้น้อยกว่า limit → ตั้ง songsHasMore=false (โหลดครบแล้ว)
//   - กัน concurrent fetches ผ่าน STATE.songsLoading
async function loadMoreSongs() {
  if (STATE.songsLoading || !STATE.songsHasMore) return;
  // 🛡️ (T007 hardening): guard — ถ้า songGrid ซ่อนอยู่ ไม่ต้องโหลด (กัน observer ยิงเปล่า ๆ)
  //   เหตุผล: defense-in-depth — ถึงแม้ observer callback จะมี guard แล้ว แต่ loadMoreSongs
  //   อาจถูกเรียกจากที่อื่น (เช่น loadAllRemainingSongs ที่ trigger จาก category click)
  //   → กันกรณี user อยู่บน tab อื่นแล้ว code เรียก loadMoreSongs โดยตรง
  const songGrid = document.getElementById("songGrid");
  if (songGrid && songGrid.style.display === "none") return;
  STATE.songsLoading = true;
  const nextPage = (STATE.songsPage || 0) + 1;
  const offset = (nextPage - 1) * 50;
  try {
    // 🔒 (Audit Fix M-38): เพิ่ม AbortController timeout 15 วินาที — กัน fetch hang forever
    //   ปัญหาเดิม: ถ้า Worker hang → fetch hang forever → STATE.songsLoading = true ค้าง
    //   → user scroll ลง → กด "load more" ไม่ได้ → UI ค้าง
    //   วิธีแก้: AbortController + setTimeout 15s → ถ้าเกิน → abort + reset state
    //   ผลกระทบระบบเดิม: 0% — ปกติ loadMoreSongs ใช้ 1-2 วินาที → ไม่เกิน 15 วินาที
    const _abortCtrl = new AbortController();
    const _timeoutId = setTimeout(() => _abortCtrl.abort(), 15000);
    // 🆕 (T015): ใช้ advanced filter URL ถ้า SONG_SEARCH_STATE.active
    //   - active=true: ส่ง query string จาก buildSearchQuery() ไปด้วย → backend ใช้ advanced path
    //   - active=false: ใช้ URL เดิม (no q/djs/...) → backend ใช้ standard listDocuments path
    //   ผลกระทบระบบเดิม: 0% — ถ้า SONG_SEARCH_STATE.active=false → URL เหมือนเดิมทุกประการ
    const _filterQs = (typeof SONG_SEARCH_STATE !== "undefined" && SONG_SEARCH_STATE.active)
      ? buildSearchQuery()
      : "";
    // 🚀 (T062): โหมดปกติ (ไม่มี filter) ใช้ keyset cursor แทน offset → ทุกหน้าเร็วเท่ากันแม้ 10,000+ เพลง
    //   cursor ใช้ได้เมื่อตรงกับหน้าปัจจุบันเท่านั้น (ถ้ามีการ reset songsPage ที่อื่น → fallback เป็น offset อัตโนมัติ)
    const _isFilterActive = (typeof SONG_SEARCH_STATE !== "undefined" && SONG_SEARCH_STATE.active);
    const _cur = STATE.songsCursor;
    const _useCursor = !_isFilterActive && _cur && _cur.page === (STATE.songsPage || 0) && _cur.value;
    const _pageQs = _useCursor
      ? `limit=50&cursor=${encodeURIComponent(_cur.value)}&slim=1`
      : `limit=50&offset=${offset}&slim=1`;
    const _url = `/api/db/songs?${_filterQs ? _filterQs + "&" : ""}${_pageQs}`;
    const res = await fetch(_url, {
      credentials: "same-origin",
      signal: _abortCtrl.signal,
    });
    clearTimeout(_timeoutId);
    if (!res.ok) {
      console.warn(`loadMoreSongs: HTTP ${res.status}`);
      STATE.songsHasMore = false;
      // 🆕 (T015): อัปเดต result count ถ้า active และเกิด error → แสดงข้อความ error
      if (typeof SONG_SEARCH_STATE !== "undefined" && SONG_SEARCH_STATE.active) {
        updateResultCount(0);
      }
      return;
    }
    const data = await res.json();
    const newDocs = Array.isArray(data?.docs) ? data.docs : [];
    if (newDocs.length === 0) {
      STATE.songsHasMore = false;
      // 🆕 (T015): อัปเดต result count ถ้า active → แสดง "พบ 0 เพลง" หรือ total จาก server
      if (typeof SONG_SEARCH_STATE !== "undefined" && SONG_SEARCH_STATE.active) {
        updateResultCount(typeof data.total === "number" ? data.total : 0);
      }
      return;
    }
    // filter hidden songs เหมือนเดิม + dedupe (กัน duplicate id)
    const existingIds = new Set(STATE.songs.map(s => s.id));
    const filtered = newDocs
      .map(d => ({ id: d.id, ...d.data }))
      .filter(s => s.status !== "hidden" && !existingIds.has(s.id));
    STATE.songs.push(...filtered);
    STATE.songsPage = nextPage;
    // 🚀 (T062): เก็บ cursor ของหน้าถัดไป (ผูกกับเลขหน้า เพื่อกัน cursor เก่าถูกใช้หลัง reset)
    STATE.songsCursor = (!_isFilterActive && data.next_cursor)
      ? { page: nextPage, value: data.next_cursor }
      : null;
    // 🎨 (2026-09-26): sort เพลงทั้งหมดใหม่หลังโหลดเพิ่ม — เรียง ก-ฮ + A-Z + 0-9 แบบ natural sort
    //   เดิม: push ตามลำดับจาก server (offset-based) → A1, A10, A2, A3 (ผิดลำดับ)
    //   ใหม่: sortSongsByThaiName → A1, A2, A3, A10 (ถูกลำดับ)
    //   ผลกระทบ: O(n log n) ทุกครั้งที่โหลดเพิ่ม — แต่ n ≤ 5000 เพลง → ทำงานภายใน 10ms บนมือถือ
    //   หมายเหตุ: สร้าง array ใหม่ (immutable) กัน re-render ที่ไม่จำเป็น
    //
    // 🆕 (T015): ถ้า SONG_SEARCH_STATE.active → ข้าม client-side sort (server เรียงให้แล้วตาม sort param)
    //   เช่น sort=price_asc → server ส่งเรียงราคาน้อย→มาก → ถ้า re-sort ฝั่ง client จะทับลำดับ server
    //   ผลกระทบ: กรณี active → ใช้ลำดับจาก server ตรง ๆ / กรณีไม่ active → ใช้ sortSongsByThaiName เหมือนเดิม
    if (!(typeof SONG_SEARCH_STATE !== "undefined" && SONG_SEARCH_STATE.active)) {
      STATE.songs = sortSongsByThaiName(STATE.songs);
    }
    if (newDocs.length < 50) {
      STATE.songsHasMore = false;  // ได้น้อยกว่า limit → หมดแล้ว
    }
    // 🆕 (T015): อัปเดต result count ถ้า active → แสดง total จาก server (filtered count)
    if (typeof SONG_SEARCH_STATE !== "undefined" && SONG_SEARCH_STATE.active) {
      updateResultCount(typeof data.total === "number" ? data.total : STATE.songs.length);
    }
  } catch (err) {
    console.warn("loadMoreSongs error:", err?.message || err);
    STATE.songsHasMore = false;
  } finally {
    STATE.songsLoading = false;
  }
}

// 🔧 (2026-09-18 v6 perf): โหลดทุก page ที่เหลือใน background จนกว่าจะครบ
// ใช้ตอน user ค้นหา — จะได้ค้นหาได้ครบทุกเพลง (ไม่ใช่แค่ที่โหลดแล้ว 50 เพลง)
//
// Flow:
//   1. user พิมพ์คำค้น → debounce 250ms → trigger loadAllRemainingSongs()
//   2. วนลูปเรียก loadMoreSongs() จนกว่า songsHasMore=false
//   3. CDN cache hit → แต่ละ page ใช้เวลา ~50-100ms (cache) → รวมเร็ว
//   4. ระหว่างลูป → re-render ทุก 1-2 pages (เพื่อ user เห็นผลค้นหาเพิ่มขึ้นเรื่อยๆ)
//   5. พอโหลดครบ → re-render ครั้งสุดท้าย → เห็นผลค้นหาทั้งหมด
//
// กัน concurrent: loadMoreSongs มี STATE.songsLoading check อยู่แล้ว
// → loadAllRemainingSongs แค่วนลูปเรียกทีละ page จนกว่าจะหมด
async function loadAllRemainingSongs() {
  // 🚀 (T062): เดิมฟังก์ชันนี้โหลด "ทุกเพลง" ทีละ 50 (10,000 เพลง = 200 request + ~1 ล้านแถวที่ D1 ต้องอ่าน
  //   ต่อการค้นหา 1 ครั้ง + sort ชื่อไทยใหม่ทุกหน้า) → ช้า/กินโควตา D1
  //   ใหม่: ถามเซิร์ฟเวอร์เฉพาะเพลงที่ตรงกับ filter ปัจจุบัน (ค้นหา/หมวด/DJ) แล้ว merge เข้า STATE.songs
  //   → ฝั่ง client ยังกรองด้วย getFilteredSongs() ตามเดิม แต่ข้อมูลที่ต้องใช้ครบแล้ว
  //   ชื่อฟังก์ชัน + จุดที่เรียก (search / chip หมวด / DJ / การ์ดหมวด) ไม่เปลี่ยน
  //   ถ้าไม่มี filter อะไรเลย → ไม่ต้องโหลดอะไร (ปล่อยให้ infinite scroll ทำงานปกติ)
  if (!STATE.songsHasMore) return;
  // โหมดตัวกรองขั้นสูง: STATE.songs ถูกกรอง/เรียงโดย server อยู่แล้ว → ให้ infinite scroll โหลดต่อเอง
  if (typeof SONG_SEARCH_STATE !== "undefined" && SONG_SEARCH_STATE.active) return;
  const q = (STATE.search || "").trim();
  const categoryId = (STATE.currentCategory && STATE.currentCategory !== "all") ? STATE.currentCategory : "";
  const djId = STATE.currentDj || "";
  if (!q && !categoryId && !djId) return;

  // ยกเลิกคำค้นก่อนหน้าที่ยังค้างอยู่ (ผู้ใช้พิมพ์ต่อ) — คำค้นล่าสุดชนะเสมอ
  if (STATE._filterLoadAbort) { try { STATE._filterLoadAbort.abort(); } catch (_) {} }
  const ctrl = new AbortController();
  STATE._filterLoadAbort = ctrl;
  STATE.songsLoadingAllRemaining = true;

  const PAGE = 200;
  const MAX_RESULTS = 2000; // กันผลลัพธ์บานปลาย (filter กว้างมาก) — เกินนี้ให้ลูกค้าพิมพ์คำค้นให้เจาะจงขึ้น
  try {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (djId) params.set("djs", djId);
    if (categoryId) params.set("categories", categoryId);
    params.set("limit", String(PAGE));
    params.set("slim", "1");

    const seen = new Set(STATE.songs.map(s => s.id));
    let offset = 0;
    let lastRenderAt = 0;
    while (offset < MAX_RESULTS) {
      params.set("offset", String(offset));
      const timeoutId = setTimeout(() => ctrl.abort(), 15000);
      let res;
      try {
        res = await fetch(`/api/db/songs?${params.toString()}`, { credentials: "same-origin", signal: ctrl.signal });
      } finally {
        clearTimeout(timeoutId);
      }
      if (!res.ok) { console.warn("loadAllRemainingSongs: HTTP", res.status); break; }
      const data = await res.json();
      const docs = Array.isArray(data?.docs) ? data.docs : [];
      for (const d of docs) {
        if (seen.has(d.id)) continue;
        const song = { id: d.id, ...d.data };
        if (song.status === "hidden") continue;
        seen.add(d.id);
        STATE.songs.push(song);
      }
      offset += PAGE;
      const total = typeof data.total === "number" ? data.total : null;
      if (docs.length < PAGE || (total !== null && offset >= total)) break;
      const now = Date.now();
      if (now - lastRenderAt > 300) {
        STATE.songs = sortSongsByThaiName(STATE.songs);
        renderSongGrid();
        renderPlaylists();
        togglePlaylistsVisibility();
        lastRenderAt = now;
      }
    }
    STATE.songs = sortSongsByThaiName(STATE.songs);
    renderSongGrid();
    renderPlaylists();
    togglePlaylistsVisibility();
  } catch (err) {
    // AbortError = ถูกแทนที่ด้วยคำค้นใหม่ → ปกติ ไม่ต้องแจ้งเตือน
    if (err?.name !== "AbortError") console.warn("loadAllRemainingSongs error:", err?.message || err);
  } finally {
    if (STATE._filterLoadAbort === ctrl) {
      STATE._filterLoadAbort = null;
      STATE.songsLoadingAllRemaining = false;
    }
  }
}

// ============================================================
// 🆕 (T015): Advanced song search state — ฝั่ง client
//   เก็บค่าตัวกรองขั้นสูงที่ลูกค้าเลือกใน #advancedFilterPanel
//   ใช้ร่วมกับ STATE.search (existing) เพื่อสร้าง query string ส่งให้ backend
//
//   State fields:
//     - q:           คำค้นหา (sync จาก #searchInput เหมือนเดิม — แค่เก็บใน 2 ที่)
//     - djs:         Set ของ DJ ids ที่เลือก (checkbox)
//     - categories:  Set ของ category ids ที่เลือก (checkbox)
//     - minPrice:    ราคาต่ำสุด (Number | null)
//     - maxPrice:    ราคาสูงสุด (Number | null)
//     - hasPromo:    boolean — เฉพาะเพลงที่มี discount_price > 0
//     - sort:        'newest' | 'price_asc' | 'price_desc' | 'name'
//     - active:      boolean — flag ว่ากำลังใช้ advanced filter อยู่ไหม
//                    (ใช้สั่ง getFilteredSongs + loadMoreSongs ว่าจะ skip client-side filter ไหม)
// ============================================================
const SONG_SEARCH_STATE = {
  q: "",
  djs: new Set(),
  categories: new Set(),
  minPrice: null,
  maxPrice: null,
  favoriteOnly: false, // 🆕 (T015-v2): เปลี่ยนจาก hasPromo → favoriteOnly (เพลงในบันทึกซื้อทีหลังของลูกค้า)
  promoOnly: false,   // 🆕 (T015-v2): เพิ่ม promoOnly (เพลงที่มี discount active)
  sort: "new",        // 🆕 (T015-v2): เปลี่ยน sort values ใหม่: new|old|price_asc|price_desc|name_asc|best_selling
  active: false,
  total: 0,           // 🆕 (T015-v2): จำนวนผลลัพธ์รวมจาก server (สำหรับ pagination)
};

// 🆕 (T015): hasActiveAdvancedFilters — ตรวจว่ามี active filter อย่างน้อย 1 ตัว
//   (sort='newest' ถือว่า default — ไม่นับเป็น active filter)
//   ใช้ใน loadSongsWithFilters เพื่อตัดสินใจว่าจะตั้ง SONG_SEARCH_STATE.active = true ไหม
function hasActiveAdvancedFilters() {
  return !!(
    SONG_SEARCH_STATE.q ||
    SONG_SEARCH_STATE.djs.size > 0 ||
    SONG_SEARCH_STATE.categories.size > 0 ||
    SONG_SEARCH_STATE.minPrice !== null ||
    SONG_SEARCH_STATE.maxPrice !== null ||
    SONG_SEARCH_STATE.favoriteOnly ||
    SONG_SEARCH_STATE.promoOnly ||
    SONG_SEARCH_STATE.sort !== "new"
  );
}

// 🆕 (T015): resetAdvancedFilterState — รีเซ็ต SONG_SEARCH_STATE + UI + (ถ้าระบุ) STATE.songs
//   ใช้ใน:
//     - chip-row click (reloadSongs=true, clearQ=false — อย่าเคลียร์ q เพราะ user อาจต้องการค้นหาต่อ)
//     - DJ-row click (เหมือน chip-row)
//     - Clear button (clearQ=true, reloadSongs=true — เคลียร์ทั้งหมด)
//   ทำงานเฉพาะตอน SONG_SEARCH_STATE.active=true ถ้าไม่ active จะไม่ทำอะไร (กัน redundant work)
//   ผลกระทบระบบเดิม: 0% — ถ้า active=false ตั้งแต่ต้น → return ทันที ไม่แตะอะไร
function resetAdvancedFilterState(options = {}) {
  const { clearQ = false, reloadSongs = false } = options;
  // guard — ถ้าไม่ active อยู่แล้ว → ไม่ต้อง reset (STATE.songs เป็นของเดิมอยู่แล้ว)
  if (!SONG_SEARCH_STATE.active) return;

  SONG_SEARCH_STATE.djs.clear();
  SONG_SEARCH_STATE.categories.clear();
  SONG_SEARCH_STATE.minPrice = null;
  SONG_SEARCH_STATE.maxPrice = null;
  SONG_SEARCH_STATE.favoriteOnly = false;
  SONG_SEARCH_STATE.promoOnly = false;
  SONG_SEARCH_STATE.sort = "new";
  SONG_SEARCH_STATE.active = false;
  SONG_SEARCH_STATE.total = 0;
  if (clearQ) {
    SONG_SEARCH_STATE.q = "";
    STATE.search = "";
    const searchInput = document.getElementById("searchInput");
    if (searchInput) searchInput.value = "";
  }
  // 🆕 (T015-v2): reset UI ของ modal ใหม่ (adv* IDs) แทน IDs เดิม
  document.querySelectorAll("#advDjList .adv-chip.active, #advCategoryList .adv-chip.active").forEach(chip => {
    if (chip) chip.classList.remove("active");
  });
  const minInput = document.getElementById("advPriceMin");
  if (minInput) minInput.value = "";
  const maxInput = document.getElementById("advPriceMax");
  if (maxInput) maxInput.value = "";
  const favToggle = document.getElementById("advFavoriteOnly");
  if (favToggle) favToggle.checked = false;
  const promoToggle = document.getElementById("advPromoOnly");
  if (promoToggle) promoToggle.checked = false;
  const sortSelect = document.getElementById("advSort");
  if (sortSelect) sortSelect.value = "new";
  try { updateActiveFiltersCount(); } catch (_) {}
  // 🆕 (T015-v2): ซ่อน result summary (ใช้ #advResultSummary แทน #searchResultCount)
  const resultEl = document.getElementById("advResultSummary");
  if (resultEl) resultEl.hidden = true;
  // reset STATE.songs (filtered results) ถ้าระบุ → ให้ standard path reload ใหม่
  if (reloadSongs) {
    STATE.songs = [];
    STATE.songsPage = 0;
    STATE.songsHasMore = true;
  }
}

// 🆕 (T015): renderFilterCheckboxes — วาด checkbox list ของ DJ + หมวดใน #advancedFilterPanel
//   ทำงานครั้งเดียวตอน init() (หลัง STATE.djs + STATE.categories โหลดเสร็จ)
//   ใช้ event delegation ที่ container → bind ครั้งเดียว (setupAdvancedFilters ผูกอีกที)
function renderFilterCheckboxes() {
  // DJs
  const djContainer = document.getElementById("djFilterCheckboxes");
  if (djContainer && Array.isArray(STATE.djs)) {
    if (STATE.djs.length === 0) {
      djContainer.innerHTML = `<div class="filter-empty">ยังไม่มี DJ</div>`;
    } else {
      djContainer.innerHTML = STATE.djs.map(dj => `
        <label class="filter-checkbox">
          <input type="checkbox" value="${escapeHtml(dj.id)}" data-filter="dj">
          <span>${escapeHtml(dj.dj_name || "(ไม่มีชื่อ)")}</span>
        </label>
      `).join("");
    }
  }
  // Categories
  const catContainer = document.getElementById("categoryFilterCheckboxes");
  if (catContainer && Array.isArray(STATE.categories)) {
    if (STATE.categories.length === 0) {
      catContainer.innerHTML = `<div class="filter-empty">ยังไม่มีหมวดหมู่</div>`;
    } else {
      catContainer.innerHTML = STATE.categories.map(cat => `
        <label class="filter-checkbox">
          <input type="checkbox" value="${escapeHtml(cat.id)}" data-filter="category">
          <span>${escapeHtml(cat.category_name || "(ไม่มีชื่อ)")}</span>
        </label>
      `).join("");
    }
  }
}

// 🆕 (T015): buildSearchQuery — สร้าง query string จาก SONG_SEARCH_STATE
//   return: URLSearchParams string (ไม่รวม limit/offset/slim — ใส่ทีหลัง)
//   ใช้ใน loadMoreSongs + loadSongsWithFilters
function buildSearchQuery() {
  const params = new URLSearchParams();
  if (SONG_SEARCH_STATE.q) params.set("q", SONG_SEARCH_STATE.q);
  if (SONG_SEARCH_STATE.djs.size > 0) {
    params.set("djs", Array.from(SONG_SEARCH_STATE.djs).join(","));
  }
  if (SONG_SEARCH_STATE.categories.size > 0) {
    params.set("categories", Array.from(SONG_SEARCH_STATE.categories).join(","));
  }
  if (SONG_SEARCH_STATE.minPrice !== null) {
    params.set("min_price", String(SONG_SEARCH_STATE.minPrice));
  }
  if (SONG_SEARCH_STATE.maxPrice !== null) {
    params.set("max_price", String(SONG_SEARCH_STATE.maxPrice));
  }
  if (SONG_SEARCH_STATE.hasPromo) params.set("has_promo", "true");
  if (SONG_SEARCH_STATE.sort !== "newest") params.set("sort", SONG_SEARCH_STATE.sort);
  return params.toString();
}

// 🆕 (T015): updateResultCount — อัปเดตข้อความ "พบ X เพลง" ใน #searchResultCount
//   ทำงานทุกครั้งหลัง loadSongsWithFilters (success/fail)
//   ถ้า total=0 → แสดงข้อความชี้แนะให้ลองปรับเงื่อนไข
function updateResultCount(total) {
  const el = document.getElementById("searchResultCount");
  if (!el) return;
  const safeTotal = Math.max(0, Number(total) || 0);
  if (safeTotal > 0) {
    el.style.display = "block";
    el.textContent = `พบ ${safeTotal.toLocaleString("en-US")} เพลง`;
    el.setAttribute("data-empty", "false");
  } else {
    el.style.display = "block";
    el.textContent = "ไม่พบเพลงที่ตรงกับตัวกรอง — ลองปรับเงื่อนไขหรือกด \"ล้างตัวกรอง\"";
    el.setAttribute("data-empty", "true");
  }
}

// 🆕 (T015): updateActiveFiltersCount — อัปเดต badge จำนวน active filters
//   ในปุ่ม "⚙️ ตัวกรองขั้นสูง" (#activeFiltersCount)
//   นับแบบกลุ่ม: djs + categories + price + hasPromo + sort (max 5)
function updateActiveFiltersCount() {
  let count = 0;
  if (SONG_SEARCH_STATE.djs.size > 0) count++;
  if (SONG_SEARCH_STATE.categories.size > 0) count++;
  if (SONG_SEARCH_STATE.minPrice !== null || SONG_SEARCH_STATE.maxPrice !== null) count++;
  if (SONG_SEARCH_STATE.favoriteOnly) count++;
  if (SONG_SEARCH_STATE.promoOnly) count++;
  if (SONG_SEARCH_STATE.sort !== "new") count++;
  // (ไม่นับ q เพราะ searchInput เป็นตัวกรองหลักที่แยกจาก panel)

  const badge = document.getElementById("advFilterBadge");
  if (badge) {
    if (count > 0) {
      badge.textContent = String(count);
      badge.hidden = false;
    } else {
      // 🔧 (T094 2026-10-06): reset text เป็น "0" ด้วย ไม่ใช่แค่ hide
      //   เดิม: badge.hidden = true อย่างเดียว → textContent ค้างเป็นค่าเดิม (เช่น "2")
      //          → owner เช็คผ่าน DevTools/inspect เห็น text stale
      //   ใหม่: badge.textContent = "0" + hidden = true → text reset จริง ๆ
      //   ผลกระทบระบบเดิม: 0% — UX เดิม (badge ซ่อนตอน count=0) เหมือนเดิม
      badge.textContent = "0";
      badge.hidden = true;
    }
  }
}

// 🆕 (T015-v2): setupAdvancedFilters — bind event listeners สำหรับ Advanced Filter Modal
//   ทำงานครั้งเดียวตอน init() หลัง DOM ready + STATE.djs/categories โหลดเสร็จ
//   ผูก:
//     - ปุ่ม "ขั้นสูง" (#advancedSearchBtn) → เปิด modal
//     - ปุ่มปิด + backdrop → ปิด modal
//     - chip click → toggle active class + อัปเดต SONG_SEARCH_STATE
//     - ปุ่ม "ล้างทั้งหมด" (#advResetBtn) → reset state + UI ใน modal
//     - ปุ่ม "ค้นหา" (#advApplyBtn) → อ่านค่าทั้งหมดจาก UI + ปิด modal + เรียก loadSongsWithAdvancedFilters
//     - ปุ่ม "ล้างตัวกรอง" (#advClearBtn) นอก modal → reset + reload
function setupAdvancedFilters() {
  const openBtn = document.getElementById("advancedSearchBtn");
  const modal = document.getElementById("advancedFilterModal");
  // 🐛 FIX (T064): ให้ modal อยู่ใต้ <body> เสมอ — กัน ancestor ที่มี transform/z-index ทำให้ position:fixed เพี้ยน
  if (modal && modal.parentElement !== document.body) document.body.appendChild(modal);
  if (openBtn && modal) {
    openBtn.addEventListener("click", () => {
      modal.hidden = false;
      modal.setAttribute("aria-hidden", "false");
      try { renderAdvFilterChips(); } catch (_) {}
      try { syncAdvUIFromState(); } catch (_) {}
    });
  }
  if (modal) {
    modal.querySelectorAll("[data-adv-close]").forEach(el => {
      el.addEventListener("click", () => {
        modal.hidden = true;
        modal.setAttribute("aria-hidden", "true");
      });
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !modal.hidden) {
        modal.hidden = true;
        modal.setAttribute("aria-hidden", "true");
      }
    });
  }
  // chip toggle - DJs
  const djList = document.getElementById("advDjList");
  if (djList) {
    djList.addEventListener("click", (e) => {
      const chip = e.target.closest(".adv-chip");
      if (!chip) return;
      const value = chip.getAttribute("data-value");
      if (!value) return;
      chip.classList.toggle("active");
      if (chip.classList.contains("active")) {
        SONG_SEARCH_STATE.djs.add(value);
      } else {
        SONG_SEARCH_STATE.djs.delete(value);
      }
      updateActiveFiltersCount();
      // 🆕 (T111 2026-10-07 fix Bug #1): re-render playlists ทันทีเมื่อ toggle DJ chip
      //   เดิม T110 commit message บอก "chip toggle ส่งผลทันที" แต่จริง ๆ ไม่ได้เรียก renderPlaylists()
      //   → badge ขึ้น "1" แต่ playlist ยังโชว์ครบทุกอัน (ไม่กรอง) — หลอก user
      //   วิธีแก้: เรียก renderPlaylists() เหมือน Apply/Reset handler ที่ T110 ทำไว้
      //   ผลกระทบระบบเดิม: 0% — ถ้าไม่มี DJ chip active → renderPlaylists ใช้ selectedDjName (STATE.currentDj)
      try { renderPlaylists(); } catch (_) {}
    });
  }
  // chip toggle - Categories
  const catList = document.getElementById("advCategoryList");
  if (catList) {
    catList.addEventListener("click", (e) => {
      const chip = e.target.closest(".adv-chip");
      if (!chip) return;
      const value = chip.getAttribute("data-value");
      if (!value) return;
      chip.classList.toggle("active");
      if (chip.classList.contains("active")) {
        SONG_SEARCH_STATE.categories.add(value);
      } else {
        SONG_SEARCH_STATE.categories.delete(value);
      }
      updateActiveFiltersCount();
      // 🆕 (T111 2026-10-07 fix Bug #1): re-render playlists ทันทีเมื่อ toggle Category chip
      //   เหตุผลเดียวกับ DJ chip — ในกรณีที่ category filter กระทบ playlist (แม้ปัจจุบัน renderPlaylists
      //   ใช้แค่ advSearchDjNames ไม่ใช้ categories แต่เรียกไว้กัน race กับ state ในอนาคต)
      //   ผลกระทบระบบเดิม: 0% — renderPlaylists ไม่ได้อ่าน SONG_SEARCH_STATE.categories
      try { renderPlaylists(); } catch (_) {}
    });
  }
  // ปุ่ม "ล้างทั้งหมด" ใน modal — ล้างเฉพาะ UI ใน modal (ยังไม่ reload)
  const resetBtn = document.getElementById("advResetBtn");
  if (resetBtn) {
    resetBtn.addEventListener("click", () => {
      SONG_SEARCH_STATE.djs.clear();
      SONG_SEARCH_STATE.categories.clear();
      SONG_SEARCH_STATE.minPrice = null;
      SONG_SEARCH_STATE.maxPrice = null;
      SONG_SEARCH_STATE.favoriteOnly = false;
      SONG_SEARCH_STATE.promoOnly = false;
      SONG_SEARCH_STATE.sort = "new";
      document.querySelectorAll("#advDjList .adv-chip.active, #advCategoryList .adv-chip.active").forEach(chip => {
        chip.classList.remove("active");
      });
      const minInput = document.getElementById("advPriceMin");
      if (minInput) minInput.value = "";
      const maxInput = document.getElementById("advPriceMax");
      if (maxInput) maxInput.value = "";
      const favToggle = document.getElementById("advFavoriteOnly");
      if (favToggle) favToggle.checked = false;
      const promoToggle = document.getElementById("advPromoOnly");
      if (promoToggle) promoToggle.checked = false;
      const sortSelect = document.getElementById("advSort");
      if (sortSelect) sortSelect.value = "new";
      updateActiveFiltersCount();
      // 🆕 (T111 2026-10-07 fix Bug #3): ซ่อน advResultSummary หลัง Reset + reset text
      //   ปัญหา: หลัง Apply กับ DJ filter → advResultSummary โชว์ "พบ X เพลง" ค้างอยู่
      //   แล้วกด Reset → text ค้างต่อไป เพราะ Reset handler ไม่ได้ซ่อนมัน (แค่เคลียร์ state)
      //   วิธีแก้: ตั้ง SONG_SEARCH_STATE.active = false + ซ่อน advResultSummary + reset text เหมือน resetAdvancedFilterState
      //   ผลกระทบระบบเดิม: 0% — ไม่กระทบ logic อื่น เพราะ active=false อยู่แล้วตามมาจาก djs.size=0
      SONG_SEARCH_STATE.active = false;
      const _summaryEl = document.getElementById("advResultSummary");
      if (_summaryEl) _summaryEl.hidden = true;
      const _textEl = document.getElementById("advResultText");
      if (_textEl) _textEl.textContent = "พบ 0 เพลง";
      // 🆕 (T110): re-render playlists หลัง Reset → แสดงทั้งหมด (djs cleared)
      try { renderPlaylists(); } catch (_) {}
    });
  }
  // ปุ่ม "ค้นหา" — อ่านค่าจาก UI + ปิด modal + trigger server-side search
  const applyBtn = document.getElementById("advApplyBtn");
  if (applyBtn) {
    applyBtn.addEventListener("click", async () => {
      // 🐛 (Bug-Fix #9): เพิ่ม loading state ตอนกด "ค้นหา" — กัน user กดซ้ำ + บอกว่ากำลังโหลด
      const originalText = applyBtn.textContent;
      applyBtn.disabled = true;
      applyBtn.textContent = "กำลังค้นหา...";
      // 🔧 (T093 2026-10-06): ย้าย reset button ไป finally block เพื่อให้ early return
      //   จาก validation fail (price min > max + favorite โดยไม่ล็อกอิน) ก็ reset ปุ่มด้วย
      //   เดิม finally อยู่รอบ await loadSongsWithAdvancedFilters เท่านั้น → early return ข้าม
      //   ผลลัพธ์: ปุ่มค้าง 'กำลังค้นหา...' ตลอดกาล + disabled → user ต้อง refresh page
      //   วิธีแก้: ครอบ try ทั้งหมด (รวม validation + modal close + loadSongs) → finally reset ทุกกรณี
      //   ผลกระทบระบบเดิม: 0% — path สำเร็จยังทำงานเหมือนเดิม; path fail ปุ่ม reset + modal ยังเปิดอยู่ (รอ user แก้)
      try {
        const minInput = document.getElementById("advPriceMin");
        const maxInput = document.getElementById("advPriceMax");
        const favToggle = document.getElementById("advFavoriteOnly");
        const promoToggle = document.getElementById("advPromoOnly");
        const sortSelect = document.getElementById("advSort");
        SONG_SEARCH_STATE.minPrice = (minInput && minInput.value !== "") ? Number(minInput.value) : null;
        SONG_SEARCH_STATE.maxPrice = (maxInput && maxInput.value !== "") ? Number(maxInput.value) : null;
        SONG_SEARCH_STATE.favoriteOnly = !!(favToggle && favToggle.checked);
        SONG_SEARCH_STATE.promoOnly = !!(promoToggle && promoToggle.checked);
        SONG_SEARCH_STATE.sort = sortSelect ? sortSelect.value : "new";
        // validate price range
        if (SONG_SEARCH_STATE.minPrice !== null && SONG_SEARCH_STATE.maxPrice !== null &&
            SONG_SEARCH_STATE.minPrice > SONG_SEARCH_STATE.maxPrice) {
          showToast("ราคาต่ำสุดต้องไม่มากกว่าราคาสูงสุด", "error");
          return;  // ✅ T093: finally จะ reset ปุ่มให้
        }
        if (SONG_SEARCH_STATE.favoriteOnly && !getAdvCustomerId()) {
          showToast("ต้องล็อกอินเพื่อดูบันทึกซื้อทีหลัง", "error");
          return;  // ✅ T093: finally จะ reset ปุ่มให้
        }
        if (modal) {
          modal.hidden = true;
          modal.setAttribute("aria-hidden", "true");
        }
        SONG_SEARCH_STATE.active = hasActiveAdvancedFilters();
        updateActiveFiltersCount();
        // 🆕 (T111 2026-10-07 fix Bug #3): ถ้าไม่มี active filter → ซ่อน advResultSummary + reset text
        //   ปัญหา: หลัง Apply กับ DJ filter (advResultSummary โชว์ "พบ 13 เพลง") → toggle DJ ออก → Apply อีก
        //   → SONG_SEARCH_STATE.active=false → loadSongsWithAdvancedFilters แตะ early return ผ่าน loadSongsWithFilters
        //   → loadSongsWithFilters ไม่ได้เรียก updateAdvResultSummary → text "พบ 13 เพลง" ค้างอยู่ใต้ search bar
        //   วิธีแก้: ถ้า !active → ซ่อน advResultSummary + reset text ก่อนเรียก loadSongsWithAdvancedFilters
        //   ผลกระทบระบบเดิม: 0% — ถ้า active=true → ไม่เข้า if → updateAdvResultSummary จะถูกเรียกตามปกติ
        if (!SONG_SEARCH_STATE.active) {
          const _summaryEl = document.getElementById("advResultSummary");
          if (_summaryEl) _summaryEl.hidden = true;
          const _textEl = document.getElementById("advResultText");
          if (_textEl) _textEl.textContent = "พบ 0 เพลง";
        }
        await loadSongsWithAdvancedFilters(true);
        // 🆕 (T110): re-render playlists หลัง Apply → กรองตาม DJ ที่เลือก
        try { renderPlaylists(); } catch (_) {}
      } finally {
        // ✅ T093: reset ปุ่มทุกกรณี — สำเร็จ, fail (await throw), หรือ early return
        applyBtn.disabled = false;
        applyBtn.textContent = originalText;
      }
    });
  }
  // ปุ่ม "× ล้างตัวกรอง" นอก modal
  const clearBtn = document.getElementById("advClearBtn");
  if (clearBtn) {
    clearBtn.addEventListener("click", async () => {
      // 🔧 (2026-10-07): กด "× ล้างตัวกรอง" นอก popup → คืนค่าทั้งหมดอัตโนมัติ (ไม่ต้องเปิด popup กดล้าง + ค้นหาอีก)
      //   เดิม: reset state แล้วโหลดเพลงใหม่ แต่ไม่ได้ renderPlaylists() → เพลย์ลิสต์ยังค้างตามตัวกรองเก่า
      //         และถ้ามีการโหลดอื่นล็อกอยู่ loadSongsWithFilters จะ return ทิ้งเฉย ๆ
      //   ใหม่: reset → วาดเพลย์ลิสต์ทันที → รอ lock ปล่อย → โหลดเพลงใหม่ → วาดเพลย์ลิสต์อีกรอบ
      //   ผลกระทบระบบเดิม: 0% — ปุ่ม "ล้างทั้งหมด"/"ค้นหา" ใน popup ทำงานเหมือนเดิม
      resetAdvancedFilterState({ clearQ: false, reloadSongs: true });
      const _summaryEl = document.getElementById("advResultSummary");
      if (_summaryEl) _summaryEl.hidden = true;
      try { renderPlaylists(); } catch (_) {}
      try {
        let waited = 0;
        while (typeof _loadSongsWithFiltersLock !== "undefined" && _loadSongsWithFiltersLock && waited < 50) {
          await new Promise(r => setTimeout(r, 100));
          waited++;
        }
        await loadSongsWithFilters(true);
      } catch (_) {}
      try { renderPlaylists(); } catch (_) {}
    });
  }
}

// 🆕 (Feature #2 → T098 2026-10-06): Social Share — แชร์เพลงไป Facebook / Line / WhatsApp / TikTok / Copy link
//   ใช้ Web Share API ถ้า browser รองรับ (มือถือส่วนใหญ่) → แชร์ผ่าน native dialog
//   ถ้าไม่รองรับ → ใช้ URL scheme ของ Facebook/Line โดยตรง
//
// 🆕 (T098): Deep link — เพิ่ม `?song=<id>` ใน URL ที่แชร์ → ลูกค้าที่คลิกลิงก์จะเข้า modal เพลงนั้นอัตโนมัติ
//   - getShareUrl(): ใช้ modalCurrentSongId (set ตอน openSongModal) เป็น deep link
//   - getShareText(): รวม URL ในข้อความด้วย → ลูกค้าสามารถ copy จากข้อความได้โดยไม่ต้องพึ่ง u/url param
//   - init(): ตรวจ URL ตอน page load → ถ้ามี ?song=<id> → เปิด modal อัตโนมัติหลัง STATE.songs โหลดเสร็จ
function getShareUrl() {
  // 🆕 (T098): สร้าง deep link URL พร้อม ?song=<id> ถ้า modal เปิดอยู่
  //   เดิม: ใช้ window.location.href.split('#')[0] → URL เป็นหน้าแรกเฉย ๆ ลูกค้าที่คลิกต้องหาเพลงเอง
  //   ใหม่: ใช้ modalCurrentSongId (module-level var set ตอน openSongModal) สร้าง URL พร้อม ?song=<id>
  //   ผลกระทบระบบเดิม: 0% — ถ้า modal ไม่ได้เปิด (modalCurrentSongId = null) → ใช้ base URL เดิม
  const baseUrl = window.location.href.split('?')[0].split('#')[0];
  if (typeof modalCurrentSongId !== 'undefined' && modalCurrentSongId) {
    return baseUrl + '?song=' + encodeURIComponent(modalCurrentSongId);
  }
  return baseUrl;
}
function getShareText(songName, djName) {
  let text = '🎵 ฟังเพลง: ' + (songName || 'เพลงนี้');
  if (djName) text += ' - DJ ' + djName;
  text += ' บน Miusic Store';
  // 🆕 (T098): เพิ่ม URL ในข้อความด้วย — ลูกค้าเห็น URL ใน preview text + สามารถ copy จากข้อความได้
  //   เดิม: text มีแค่ "🎵 ฟังเพลง: ... บน Miusic Store" → URL ถูกส่งแยกใน u/url param
  //   ใหม่: text มี URL ต่อท้าย → WhatsApp/TikTok ที่ไม่มี URL param แยก จะส่ง URL ไปได้
  //   ผลกระทบระบบเดิม: 0% — Facebook/Line ยังใช้ u/url param แยก (URL ใน text ไม่กระทบ preview)
  text += '\n🔗 ' + getShareUrl();
  return text;
}

// 🆕 (T098): Auto-open song modal จาก URL ?song=<id>
//   เรียกจาก init() หลัง STATE.songs โหลดครั้งแรก
//   รอ STATE.songs โหลดเสร็จ (retry สูงสุด 20 ครั้ง ทุก 500ms = 10s) → ถ้าเจอเพลง → openSongModal
//   ผลกระทบระบบเดิม: 0% — ถ้า URL ไม่มี ?song= → return ทันที ไม่ทำอะไร
function openSongModalFromUrl() {
  try {
    const urlParams = new URLSearchParams(window.location.search);
    const songId = urlParams.get('song');
    if (!songId) return;
    // ล้าง query string ออกจาก URL (history.replaceState) เพื่อกันลูกค้า refresh → modal เปิดซ้ำ
    //   + กัน share URL ปนใน history (back button จะไม่เปิด modal ซ้ำ)
    try {
      const cleanUrl = window.location.href.split('?')[0];
      window.history.replaceState({}, document.title, cleanUrl);
    } catch (_) {}
    // รอ STATE.songs โหลด
    const tryOpen = (attempt) => {
      if (attempt > 20) {
        console.warn('[T098] Song not found after 10s — songId:', songId);
        return;
      }
      const song = findSong(songId);
      if (song) {
        openSongModal(songId);
      } else {
        setTimeout(() => tryOpen(attempt + 1), 500);
      }
    };
    tryOpen(0);
  } catch (err) {
    console.warn('[T098] openSongModalFromUrl failed:', err?.message || err);
  }
}
function setupShareButtons() {
  const fbBtn = document.getElementById('shareFacebookBtn');
  const lineBtn = document.getElementById('shareLineBtn');
  const copyBtn = document.getElementById('shareCopyBtn');
  if (fbBtn) {
    fbBtn.addEventListener('click', () => {
      const songName = document.getElementById('modalName')?.textContent || '';
      const djName = document.getElementById('modalArtist')?.textContent || '';
      const url = encodeURIComponent(getShareUrl());
      const text = encodeURIComponent(getShareText(songName, djName));
      window.open('https://www.facebook.com/sharer/sharer.php?u=' + url + '&quote=' + text, '_blank', 'noopener,noreferrer');
    });
  }
  if (lineBtn) {
    lineBtn.addEventListener('click', () => {
      const songName = document.getElementById('modalName')?.textContent || '';
      const djName = document.getElementById('modalArtist')?.textContent || '';
      const url = encodeURIComponent(getShareUrl());
      // 🔧 (T098): text ไม่ต้อง append URL อีก เพราะ getShareText มี URL ใน text แล้ว
      const text = encodeURIComponent(getShareText(songName, djName));
      window.open('https://social-plugins.line.me/lineit/share?url=' + url + '&text=' + text, '_blank', 'noopener,noreferrer');
    });
  }
  // 🆕 (Feature #2 update → T099 2026-10-06): WhatsApp share — ใช้ Web Share API เป็นหลัก
  //   🔧 (T099): เดิมใช้ wa.me/?text= อย่างเดียว → บนมือถือบางครั้งข้อความหายตอนเข้าแชท
  //      (wa.me/?text= เปิด WhatsApp → user เลือกผู้ติดต่อ → แชทเปิด → แต่ข้อความไม่ถูกใส่ในช่อง input)
  //   ใหม่: ใช้ navigator.share() (Web Share API) เป็น primary → native share sheet
  //      → user เลือก WhatsApp → ข้อความ + URL ถูกส่งเข้าแชทเสมอ (ไม่หาย)
  //      Fallback: wa.me/?text= สำหรับ desktop ที่ไม่รองรับ Web Share API
  //   ผลกระทบระบบเดิม: 0% — ถ้า navigator.share ไม่มี → ใช้ wa.me URL เดิม
  const whatsappBtn = document.getElementById('shareWhatsappBtn');
  if (whatsappBtn) {
    whatsappBtn.addEventListener('click', async () => {
      const songName = document.getElementById('modalName')?.textContent || '';
      const djName = document.getElementById('modalArtist')?.textContent || '';
      const text = getShareText(songName, djName);
      const url = getShareUrl();
      // 🆕 (T099): ใช้ Web Share API ถ้า browser รองรับ (มือถือส่วนใหญ่ + desktop Chrome/Safari รุ่นใหม่)
      if (navigator.share) {
        try {
          await navigator.share({
            title: 'Miusic Store',
            text: text,
            url: url,
          });
          return; // share สำเร็จ → ไม่ต้องทำอะไรต่อ
        } catch (err) {
          // user ยกเลิก (AbortError) → ไม่ทำอะไร
          if (err.name === 'AbortError') return;
          // error อื่น → ใช้ fallback wa.me ด้านล่าง
        }
      }
      // Fallback: ใช้ wa.me URL (กรณี browser ไม่รองรับ Web Share API — ส่วนใหญ่ desktop)
      window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank', 'noopener,noreferrer');
    });
  }
  // 🆕 (Feature #2 update): TikTok share — TikTok ไม่มี share URL แบบ official
  //   วิธี: คัดลอกลิงก์ + เปิด TikTok ให้ user แชร์เอง
  const tiktokBtn = document.getElementById('shareTiktokBtn');
  if (tiktokBtn) {
    tiktokBtn.addEventListener('click', async () => {
      const url = getShareUrl();
      try {
        await navigator.clipboard.writeText(url);
        showToast('คัดลอกลิงก์แล้ว — ไปวางใน TikTok ได้เลย', 'success');
        // เปิด TikTok ในแท็บใหม่
        window.open('https://www.tiktok.com/', '_blank', 'noopener,noreferrer');
      } catch (err) {
        // fallback: execCommand
        const textarea = document.createElement('textarea');
        textarea.value = url;
        document.body.appendChild(textarea);
        textarea.select();
        try {
          document.execCommand('copy');
          showToast('คัดลอกลิงก์แล้ว — ไปวางใน TikTok ได้เลย', 'success');
          window.open('https://www.tiktok.com/', '_blank', 'noopener,noreferrer');
        } catch (_) {
          showToast('คัดลอกไม่สำเร็จ กรุณาคัดลอกเอง', 'error');
        }
        document.body.removeChild(textarea);
      }
    });
  }
  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      const url = getShareUrl();
      try {
        await navigator.clipboard.writeText(url);
        showToast('คัดลอกลิงก์แล้ว', 'success');
      } catch (err) {
        // fallback: ใช้ execCommand
        const textarea = document.createElement('textarea');
        textarea.value = url;
        document.body.appendChild(textarea);
        textarea.select();
        try {
          document.execCommand('copy');
          showToast('คัดลอกลิงก์แล้ว', 'success');
        } catch (_) {
          showToast('คัดลอกไม่สำเร็จ กรุณาคัดลอกเอง', 'error');
        }
        document.body.removeChild(textarea);
      }
    });
  }
}



// 🆕 (T015-v2): renderAdvFilterChips — วาด chip list ของ DJ + หมวดใน #advDjList + #advCategoryList
function renderAdvFilterChips() {
  const djContainer = document.getElementById("advDjList");
  if (djContainer && Array.isArray(STATE.djs)) {
    if (STATE.djs.length === 0) {
      djContainer.innerHTML = `<div class="adv-chip-empty">ยังไม่มี DJ</div>`;
    } else {
      djContainer.innerHTML = STATE.djs.map(dj => `
        <button type="button" class="adv-chip" data-filter="dj" data-value="${escapeHtml(dj.dj_name || "")}">
          ${escapeHtml(dj.dj_name || "(ไม่มีชื่อ)")}
        </button>
      `).join("");
    }
  }
  const catContainer = document.getElementById("advCategoryList");
  if (catContainer && Array.isArray(STATE.categories)) {
    if (STATE.categories.length === 0) {
      catContainer.innerHTML = `<div class="adv-chip-empty">ยังไม่มีหมวดหมู่</div>`;
    } else {
      catContainer.innerHTML = STATE.categories.map(cat => `
        <button type="button" class="adv-chip" data-filter="category" data-value="${escapeHtml(cat.id || "")}">
          ${escapeHtml(cat.category_name || "(ไม่มีชื่อ)")}
        </button>
      `).join("");
    }
  }
}

// 🆕 (T015-v2): syncAdvUIFromState — sync UI ใน modal ให้ตรงกับ SONG_SEARCH_STATE ปัจจุบัน
function syncAdvUIFromState() {
  document.querySelectorAll("#advDjList .adv-chip").forEach(chip => {
    const value = chip.getAttribute("data-value");
    if (value && SONG_SEARCH_STATE.djs.has(value)) {
      chip.classList.add("active");
    } else {
      chip.classList.remove("active");
    }
  });
  document.querySelectorAll("#advCategoryList .adv-chip").forEach(chip => {
    const value = chip.getAttribute("data-value");
    if (value && SONG_SEARCH_STATE.categories.has(value)) {
      chip.classList.add("active");
    } else {
      chip.classList.remove("active");
    }
  });
  const minInput = document.getElementById("advPriceMin");
  if (minInput) minInput.value = SONG_SEARCH_STATE.minPrice !== null ? SONG_SEARCH_STATE.minPrice : "";
  const maxInput = document.getElementById("advPriceMax");
  if (maxInput) maxInput.value = SONG_SEARCH_STATE.maxPrice !== null ? SONG_SEARCH_STATE.maxPrice : "";
  const favToggle = document.getElementById("advFavoriteOnly");
  if (favToggle) favToggle.checked = SONG_SEARCH_STATE.favoriteOnly;
  const promoToggle = document.getElementById("advPromoOnly");
  if (promoToggle) promoToggle.checked = SONG_SEARCH_STATE.promoOnly;
  const sortSelect = document.getElementById("advSort");
  if (sortSelect) sortSelect.value = SONG_SEARCH_STATE.sort;
}

// 🆕 (T015-v2): getAdvCustomerId — ดึง customer_id ของลูกค้า login (สำหรับ favorite filter)
//   🔧 (T-sync-bugs-fix-H4 2026-10-06): แก้ key ผิด — เดิมอ่าน "customer_session" ที่ไม่มีในระบบ
//     จริง ๆ: customer-auth.js เก็บที่ key "miusic_customer_session" + field คือ "id" (ไม่ใช่ customerId)
//     ผลกระทบเดิม: ลูกค้า login แล้วกดกรอง "บันทึกซื้อทีหลัง" เจอ error "ต้องล็อกอิน" ทั้งที่ login อยู่
//   วิธีแก้: อ่าน key จริง "miusic_customer_session" + อ่าน field "id" — sync กับ customer-auth.js
//   ผลกระทบระบบเดิม: 0% — ไม่แตะ customer-auth.js saveCustomerToStorage; ใช้แค่ key ที่มีอยู่แล้ว
function getAdvCustomerId() {
  try {
    const raw = localStorage.getItem("miusic_customer_session");
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed?.id || null;
  } catch {
    return null;
  }
}

// 🆕 (T015-v2): updateAdvResultSummary — อัปเดตข้อความ "พบ X เพลง" ใน #advResultSummary
function updateAdvResultSummary(total) {
  const summaryEl = document.getElementById("advResultSummary");
  if (!summaryEl) return;
  const safeTotal = Math.max(0, Number(total) || 0);
  SONG_SEARCH_STATE.total = safeTotal;
  const textEl = document.getElementById("advResultText");
  if (safeTotal > 0) {
    summaryEl.hidden = false;
    if (textEl) textEl.textContent = `พบ ${safeTotal.toLocaleString("en-US")} เพลง`;
  } else {
    summaryEl.hidden = false;
    if (textEl) textEl.textContent = `ไม่พบเพลงที่ตรงกับตัวกรอง — ลองปรับเงื่อนไขหรือกด "ล้างตัวกรอง"`;
  }
}

// 🆕 (T015-v2): loadSongsWithAdvancedFilters — โหลดเพลงผ่าน /api/db/songs/_advanced-search
//   ใช้เมื่อ SONG_SEARCH_STATE.active = true (มี advanced filter อย่างน้อย 1 ตัว)
//   resetPagination=true → ล้าง STATE.songs + เริ่มจากหน้า 1
//   resetPagination=false → โหลดหน้าถัดไป (load more)
//   ผลกระทบระบบเดิม: 0% — ถ้า SONG_SEARCH_STATE.active=false จะไม่เข้า path นี้
async function loadSongsWithAdvancedFilters(resetPagination = true) {
  if (!SONG_SEARCH_STATE.active) {
    return loadSongsWithFilters(resetPagination);
  }
  if (resetPagination) {
    STATE.songsPage = 0;
    STATE.songsHasMore = true;
    STATE.songs = [];
    STATE.currentCategory = "all";
    STATE.currentDj = null;
    STATE.search = "";
  }
  if (resetPagination) {
    try { renderSongSkeleton(12); } catch (_) {}
  }
  const limit = 50;
  const offset = resetPagination ? 0 : STATE.songs.length;
  try {
    const result = await advancedSearchSongs({
      djs: Array.from(SONG_SEARCH_STATE.djs),
      categories: Array.from(SONG_SEARCH_STATE.categories),
      price_min: SONG_SEARCH_STATE.minPrice,
      price_max: SONG_SEARCH_STATE.maxPrice,
      favorite_only: SONG_SEARCH_STATE.favoriteOnly,
      favorite_customer_id: SONG_SEARCH_STATE.favoriteOnly ? getAdvCustomerId() : null,
      promo_only: SONG_SEARCH_STATE.promoOnly,
      sort: SONG_SEARCH_STATE.sort,
      limit,
      offset,
    });
    const newSongs = (result.docs || []).map(d => ({ id: d.id, ...(d.data() || {}) }));
    if (resetPagination) {
      STATE.songs = newSongs;
    } else {
      const existingIds = new Set(STATE.songs.map(s => s.id));
      for (const s of newSongs) {
        if (!existingIds.has(s.id)) STATE.songs.push(s);
      }
    }
    // 🎨 (Sort-Thai-Fix): ถ้า sort="new" (default) → re-sort ด้วย Thai natural sort ฝั่ง client
    //   เหตุผล: D1 (SQLite) ไม่รองรับ Thai collation ที่ดี → server sort ด้วย LOWER(song_name) COLLATE NOCASE
    //   ไม่ได้เรียง ก-ฮ + A-Z + 1-10 แบบ natural → ต้อง re-sort ฝั่ง client
    //   ถ้า user เลือก sort อื่น (price_asc, best_selling, etc.) → ใช้ลำดับจาก server ตรง ๆ (user เลือกเอง)
    // 🎨 (Bug-Fix #2): ใช้ direction parameter แทน reverse() — กันปัญหา load more
    //   เดิม: sort ascending + reverse() → เมื่อ load more → re-sort + reverse ทั้ง array → ลำดับเพี้ยน
    //   ใหม่: ส่ง direction="desc" โดยตรง → sort ครั้งเดียว → ลำดับถูกต้องเสมอ
    if (SONG_SEARCH_STATE.sort === "new") {
      STATE.songs = sortSongsByThaiName(STATE.songs, "asc");
    } else if (SONG_SEARCH_STATE.sort === "old") {
      STATE.songs = sortSongsByThaiName(STATE.songs, "desc");
    }
    STATE.songsHasMore = STATE.songs.length < result.total;
    STATE.songsPage = Math.floor(STATE.songs.length / limit);
    try { renderSongGrid(); } catch (_) {}
    updateAdvResultSummary(result.total);
  } catch (err) {
    console.error("[T015] loadSongsWithAdvancedFilters failed:", err);
    showToast("ค้นหาเพลงไม่สำเร็จ กรุณาลองใหม่", "error");
    updateAdvResultSummary(0);
  }
}

// 🆕 (T015): loadSongsWithFilters — wrapper สำหรับ reload songs ด้วย advanced filter
//   - resetPagination=true → ล้าง STATE.songs + ตั้งค่า SONG_SEARCH_STATE.active ใหม่
//   - resetPagination=false → ใช้สำหรับ load-more-on-scroll (เรียกจาก loadMoreSongs)
//
//   Flow:
//     1. reset STATE.songsPage + songsHasMore + songs (ถ้า resetPagination)
//     2. ตัดสินใจ SONG_SEARCH_STATE.active จาก hasActiveAdvancedFilters()
//     3. ถ้า active → รีเซ็ต client-side filter state (currentCategory/Dj/search)
//        เพื่อกัน conflict ระหว่าง advanced filter + chip-row/dj-row/search input
//     4. render skeleton (ถ้า resetPagination)
//     5. เรียก loadMoreSongs() — ตัว loadMoreSongs เองจะใช้ buildSearchQuery() ถ้า active
//     6. re-render grid + update result count
//
//   🆕 (T024): รอ STATE.songsLoading ปล่อยก่อน — กันปัญหา loadMoreSongs return ทันที
//     ปัญหาเดิม: ถ้า loadAllRemainingSongs กำลังทำงาน → songsLoading=true → loadMoreSongs return → STATE.songs ว่าง → แสดง empty/เพลงเก่า
//     วิธีแก้: รอสูงสุด 5 วินาทีให้ songsLoading=false → แล้วค่อยเรียก loadMoreSongs
let _loadSongsWithFiltersLock = false;
async function loadSongsWithFilters(resetPagination = true) {
  // 🆕 (T024): กัน concurrent calls — ถ้ามี loadSongsWithFilters อื่นกำลังทำงาน → รอ
  if (_loadSongsWithFiltersLock) {
    return;
  }
  _loadSongsWithFiltersLock = true;

  try {
    if (resetPagination) {
      STATE.songsPage = 0;
      STATE.songsHasMore = true;
      STATE.songs = [];
      // ตัดสินใจ active flag จาก current filter state
      SONG_SEARCH_STATE.active = hasActiveAdvancedFilters();
      // ถ้า active → รีเซ็ต client-side filter state เพื่อกัน conflict
      if (SONG_SEARCH_STATE.active) {
        STATE.currentCategory = "all";
        STATE.currentDj = null;
        STATE.search = "";
        // sync searchInput ให้แสดงค่า q (ถ้ามี) — ไม่ trigger input event (กันลูป)
        const searchInput = document.getElementById("searchInput");
        if (searchInput) searchInput.value = SONG_SEARCH_STATE.q || "";
        // re-render chip-row + dj-row ให้ active state กลับเป็น default
        try { renderCategoryChips(); } catch (e) { /* ignore — chip-row อาจยังไม่พร้อม */ }
        try { renderDjRow(); } catch (e) { /* ignore */ }
      }
      renderSongSkeleton();
    }

    // 🆕 (T024): รอ STATE.songsLoading ปล่อย — สูงสุด 5 วินาที
    //   ปัญหา: ถ้า loadAllRemainingSongs กำลังทำงาน → songsLoading=true → loadMoreSongs return ทันที
    //   วิธีแก้: รอจนกว่า songsLoading=false → แล้วค่อยเรียก loadMoreSongs
    let waitCount = 0;
    while (STATE.songsLoading && waitCount < 50) {
      await new Promise(r => setTimeout(r, 100));
      waitCount++;
    }
    if (STATE.songsLoading) {
      console.warn('[T024] songsLoading still true after 5s — force proceed');
      STATE.songsLoading = false; // force unlock
    }

    await loadMoreSongs();
    renderSongGrid();
  } finally {
    _loadSongsWithFiltersLock = false;
  }
}


// 🔧 (2026-09-18 v6 perf): ติดตั้ง IntersectionObserver ที่ sentinel element ท้าย grid
//   เมื่อ user scroll ถึง sentinel → trigger loadMoreSongs() + re-render
//   ลดการโหลดข้อมูลทั้งหมด → โหลดเฉพาะ page ที่ user สนใจ
function setupSongListInfinityScroll() {
  const grid = document.getElementById("songGrid");
  if (!grid) return;
  // สร้าง sentinel element วางท้าย grid (ถ้ายังไม่มี)
  let sentinel = document.getElementById("songListSentinel");
  if (!sentinel) {
    sentinel = document.createElement("div");
    sentinel.id = "songListSentinel";
    sentinel.style.height = "1px";
    sentinel.style.width = "100%";
    sentinel.style.marginTop = "20px";
    grid.parentElement.insertBefore(sentinel, grid.nextSibling);
  }
  // ถ้า browser ไม่รองรับ IntersectionObserver → fallback: ไม่ทำ auto-load
  // (user ยังใช้เว็บได้ปกติ แค่เห็น 50 เพลงแรก)
  if (!("IntersectionObserver" in window)) return;
  const observer = new IntersectionObserver(async (entries) => {
    // 🛡️ (T007 hardening): guard — ถ้า songGrid ซ่อนอยู่ ไม่ต้องโหลดเพิ่ม
    //   เหตุผล: defense-in-depth — กัน observer ยิง loadMoreSongs ตอนอยู่บน tab อื่น (โปร/ออเดอร์/เพลย์ลิสต์)
    //   แม้จะซ่อน sentinel ไว้แล้ว แต่กันกรณี browser ยัง trigger intersect ด้วยเหตุผลอื่น (resize, etc.)
    const songGrid = document.getElementById("songGrid");
    if (!songGrid || songGrid.style.display === "none") return;
    for (const entry of entries) {
      if (entry.isIntersecting && STATE.songsHasMore && !STATE.songsLoading) {
        // 🚀 (T062): ถ้ากำลังค้นหา/กรองหมวด/DJ อยู่ → ผลที่ตรงถูกโหลดจาก server ครบแล้ว (loadAllRemainingSongs)
        //   ไม่ต้องไล่โหลดหน้าถัดไปที่ไม่เกี่ยวกับ filter (เปลือง request + D1)
        const _hasClientFilter = !!STATE.search || !!STATE.currentDj
          || (STATE.currentCategory && STATE.currentCategory !== "all");
        if (_hasClientFilter && !(typeof SONG_SEARCH_STATE !== "undefined" && SONG_SEARCH_STATE.active)) continue;
        await loadMoreSongs();
        renderSongGrid();
      }
    }
  }, { rootMargin: "200px" });  // trigger เมื่อ sentinel อยู่ใกล้ viewport 200px
  observer.observe(sentinel);
  // 🟢 (Audit Fix L-7): disconnect old observer ก่อนตั้งใหม่ — กัน leak ถ้าเรียกซ้ำ
  if (STATE.songListObserver) {
    try { STATE.songListObserver.disconnect(); } catch (_) {}
  }
  STATE.songListObserver = observer;
}

function renderCategoryChips() {
  const wrap = document.getElementById("categoryChips");
  if (!wrap) return;
  // 🚀 (Sort-Fix): sort categories ทุกครั้งก่อน render — กันกรณีข้อมูลเปลี่ยนทีหลัง
  STATE.categories = sortByThaiName(STATE.categories, "category_name");
  let html = `<div class="chip${STATE.currentCategory === "all" ? " active" : ""}" data-cat="all">ทั้งหมด</div>`;
  STATE.categories.forEach(c => {
    html += `<div class="chip${STATE.currentCategory === c.id ? " active" : ""}" data-cat="${c.id}">${escapeHtml(c.category_name)}</div>`;
  });
  wrap.innerHTML = html;
  wrap.querySelectorAll(".chip").forEach(el => {
    el.addEventListener("click", () => {
      // 🆕 (T015): ถ้าอยู่ใน advanced filter mode → reset ก่อน เพื่อกลับสู่ client-side filter
      //   เหตุผล: STATE.songs ปัจจุบันเป็น server-filtered results → chip-row filter ฝั่ง client จะไม่ครบ
      //   ผลกระทบ: เมื่อ user กด chip ขณะใช้ advanced filter → ระบบกลับสู่ client-side filter mode
      //   ถ้า active=false ตั้งแต่ต้น → resetAdvancedFilterState จะ return ทันที (no-op)
      try { resetAdvancedFilterState({ reloadSongs: true }); } catch (_) {}
      STATE.currentCategory = el.getAttribute("data-cat");
      STATE.currentDj = null;
      // 🔧 (2026-09-18 v6 Full System): เมื่อกดหมวดหมู่ ถ้ายังโหลดเพลงไม่ครบ → trigger auto-load-all
      //   กันกรณีที่เพลงของหมวดนี้อยู่ใน page หลัง → filter ไม่เจอ
      if (STATE.songsHasMore) { // 🚀 (T062): ไม่ต้องรอ — คำค้น/ตัวกรองล่าสุดจะแทนที่ตัวเก่าเอง
        showToast("กำลังโหลดเพลงทั้งหมดเพื่อกรอง...", "progress");
        loadAllRemainingSongs().then(() => {
          renderSongGrid();
          renderPlaylists();
          togglePlaylistsVisibility();
        });
      }
      // หน้า "ทั้งหมด" แสดงส่วน DJ เหมือนเดิม แต่หน้าหมวดหมู่
      // ต้องซ่อนส่วน DJ เพื่อให้เห็นเฉพาะเพลงของหมวดที่เลือก
      setView(STATE.currentView);
      renderCategoryChips();
      renderSongGrid();
      // เมื่อเลือกหมวดหมู่ ให้แสดงเฉพาะรายการเพลงของหมวดนั้น
      // และซ่อนเพลย์ลิสต์ไว้จนกว่าจะกลับไปที่ "ทั้งหมด"
      renderPlaylists();
      togglePlaylistsVisibility();
    });
  });
}

// 🆕 (T019): renderCategoryGrid — วาดการ์ดหมวดหมู่แนะนำแบบ grid (ไม่ใช่ chips)
//   - แสดง icon (emoji) + ชื่อหมวด + จำนวนเพลงในหมวด
//   - กดการ์ด → เลือกหมวด + scroll ไปที่ #songGrid (เริ่มฟังเพลงของหมวดนั้น)
//   - ใช้ STATE.categories + STATE.songs (ที่โหลดแล้วใน init()) → ไม่ต้อง fetch เพิ่ม
//   - ไม่กระทบระบบเดิม — ใช้ chip handler เดิม (renderCategoryChips + renderSongGrid)
//   - lazy: ไม่มีรูป → ใช้ emoji icon → ไม่ต้อง lazy load (performance ดี)
function renderCategoryGrid() {
  const grid = document.getElementById("categoryGrid");
  if (!grid) return;
  // 🚀 (Sort-Fix): sort categories ทุกครั้งก่อน render
  STATE.categories = sortByThaiName(STATE.categories, "category_name");

  // 🆕 (T019): category icon mapping — emoji สำหรับหมวดยอดนิยม
  //   - ถ้า cat.id ตรงกับ key → ใช้ emoji นั้น
  //   - ถ้าไม่ตรง → ใช้ cat.icon (ถ้ามี) หรือ default 🎵
  const catIcons = {
    "dance": "💃",
    "remix": "🎵",
    "luktung": "🎤",
    "party": "🎉",
    "edm": "🎧",
    "slow": "🌙",
    "remix-dj": "🎚️",
  };

  // 🛡️ guard: ถ้าไม่มี categories → แสดง empty state (กัน grid ว่างเปล่า)
  if (!Array.isArray(STATE.categories) || STATE.categories.length === 0) {
    grid.innerHTML = `<div class="category-card" style="grid-column:1/-1;cursor:default;opacity:0.6;">
      <div class="cat-icon">🎵</div>
      <div class="cat-name">กำลังโหลดหมวดหมู่...</div>
    </div>`;
    return;
  }

  // 🆕 (T019): วาดการ์ดหมวดหมู่ทั้งหมด (รวม "ทั้งหมด" ที่จำลองจาก chip "ทั้งหมด")
  let html = "";

  // การ์ดแรก: "ทั้งหมด" (เหมือน chip แรกใน chip-row) — กดแล้ว reset category + scroll ไป songGrid
  //   🎨 (T117 2026-10-07): เพิ่ม class "selected" เมื่อ STATE.currentCategory === "all"
  //     - ทำให้ CSS แสดงตัวบอกว่าหมวด "ทั้งหมด" กำลังถูกเลือกอยู่ (เหมือน .dj-item.selected)
  const totalSongs = (STATE.songs || []).length;
  const isAllSelected = !STATE.currentCategory || STATE.currentCategory === "all";
  html += `<div class="category-card${isAllSelected ? " selected" : ""}" data-category-id="all" role="button" tabindex="0" aria-label="ดูเพลงทั้งหมด">
    <div class="cat-icon">🎵</div>
    <div class="cat-name">ทั้งหมด</div>
    <div class="cat-count">${totalSongs} เพลง</div>
  </div>`;

  // การ์ดหมวดจริง ๆ — ใช้ STATE.categories ที่ sort แล้วใน init()
  html += STATE.categories.map(cat => {
    const icon = catIcons[String(cat.id).toLowerCase()] || cat.icon || "🎵";
    // 🆕 (T019): นับจำนวนเพลงในหมวด — ใช้ songBelongsToCurrentCategory? ไม่ได้ เพราะมันผูกกับ currentCategory
    //   ใช้ getCategoryValues + เทียบค่าแบบเดียวกับ songBelongsToCurrentCategory แต่ส่ง cat.id ตรง ๆ
    const selectedValues = [
      cat.id,
      cat.category_name,
      cat.name
    ].flatMap(getCategoryValues);
    const songCount = (STATE.songs || []).filter(s => {
      const songValues = [
        s.category_id,
        s.categoryId,
        s.category_ids,
        s.categoryIds,
        s.category,
        s.category_name,
        s.categoryName,
        s.categories
      ].flatMap(getCategoryValues);
      return songValues.some(value => selectedValues.includes(value));
    }).length;
    return `<div class="category-card${STATE.currentCategory === cat.id ? " selected" : ""}" data-category-id="${escapeHtml(cat.id)}" role="button" tabindex="0" aria-label="ดูเพลงหมวด ${escapeHtml(cat.category_name || "")}">
      <div class="cat-icon">${icon}</div>
      <div class="cat-name">${escapeHtml(cat.category_name || cat.name || "ไม่มีชื่อ")}</div>
      <div class="cat-count">${songCount} เพลง</div>
    </div>`;
  }).join("");

  grid.innerHTML = html;

  // 🆕 (T019): bind click + keyboard handler — เลือกหมวด + scroll ไป songGrid
  //   - click: เลือกหมวด + scroll ไป songGrid
  //   - keydown (Enter/Space): เทียบเท่า click (accessibility)
  grid.querySelectorAll(".category-card").forEach(card => {
    const handleSelect = async () => {
      const catId = card.getAttribute("data-category-id");
      if (!catId) return;

      // 🆕 (T023/T035): เปลี่ยน view เป็น "category" ก่อน — เพื่อซ่อน hero banner + category showcase
      const targetView = catId === "all" ? "home" : "category";
      STATE.currentView = targetView;

      // 🆕 (T035): ถ้า advanced filter active → reset + reload songs ใหม่ทั้งหมด
      //   ปัญหาเดิม: resetAdvancedFilterState ล้าง STATE.songs แต่ไม่ได้โหลดใหม่ → ใช้ timeout 800ms → บางครั้งยังว่าง
      //   วิธีแก้: ใช้ loadSongsWithFilters(true) ซึ่งรอจนโหลดเสร็จจริง ๆ แล้วค่อย render
      const wasAdvancedActive = (typeof SONG_SEARCH_STATE !== "undefined" && SONG_SEARCH_STATE.active);
      
      STATE.currentCategory = catId;
      STATE.currentDj = null;

      if (wasAdvancedActive) {
        // reset advanced filter + reload ALL songs (ไม่ใช่ filtered results)
        setView(targetView);
        renderCategoryChips();
        renderSongSkeleton(); // แสดง skeleton ทันทีกัน user เห็น "ไม่พบเพลง"
        try {
          // resetAdvancedFilterState ล้าง state แต่ไม่ reload — เราต้อง reload เอง
          resetAdvancedFilterState({ reloadSongs: false });
          // โหลด songs ใหม่ทั้งหมด (ไม่มี filter)
          STATE.songs = [];
          STATE.songsPage = 0;
          STATE.songsHasMore = true;
          await loadSongsWithFilters(true);
        } catch (err) {
          console.warn('[T035] reload after advanced filter reset failed:', err);
        }
        renderCategoryGrid(); // re-render เพื่ออัปเดต song count
        renderSongGrid();
        renderPlaylists();
        togglePlaylistsVisibility();
        const songGrid = document.getElementById("songGrid");
        if (songGrid) songGrid.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }

      // 🔧 (2026-09-18 v6 Full System): เมื่อกดหมวดหมู่ ถ้ายังโหลดเพลงไม่ครบ → trigger auto-load-all
      if (STATE.songsHasMore) { // 🚀 (T062): ไม่ต้องรอ — คำค้น/ตัวกรองล่าสุดจะแทนที่ตัวเก่าเอง
        showToast("กำลังโหลดเพลงทั้งหมดเพื่อกรอง...", "progress");
        setView(targetView);
        renderCategoryChips();
        renderSongSkeleton();
        try {
          await loadAllRemainingSongs();
        } catch (err) {
          console.warn('[T035] loadAllRemainingSongs failed:', err);
        }
        renderCategoryGrid();
        renderSongGrid();
        renderPlaylists();
        togglePlaylistsVisibility();
        const songGrid = document.getElementById("songGrid");
        if (songGrid) songGrid.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }

      // 🆕 (T035): กรณีปกติ — โหลดครบแล้ว + ไม่มี advanced filter
      setView(targetView);
      renderCategoryChips();
      renderCategoryGrid(); // 🎨 (T117 2026-10-07): re-render เพื่ออัปเดต class "selected" ของการ์ดหมวดที่เลือก
      renderSongGrid();
      renderPlaylists();
      togglePlaylistsVisibility();
      const songGrid = document.getElementById("songGrid");
      if (songGrid) songGrid.scrollIntoView({ behavior: "smooth", block: "start" });
    };
    card.addEventListener("click", handleSelect);
    // 🆕 (T019): keyboard handler — Enter/Space = click (accessibility AC#7 implicit)
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
        e.preventDefault();
        handleSelect();
      }
    });
  });
}

function renderDjRow() {
  const wrap = document.getElementById("djRow");
  if (!wrap) return;
  // 🚀 (Sort-Fix): sort DJs ทุกครั้งก่อน render
  STATE.djs = sortByThaiName(STATE.djs, "dj_name");
  // 🎧 (2026-09-20) เพิ่ม class "selected" ให้ DJ ที่กำลังถูกเลือก (STATE.currentDj)
  //   - CSS จะแสดงวงกลมสีแดง + เปลี่ยนสีชื่อ + ขยายขอบ avatar อัตโนมัติ
  //   - ถ้า STATE.currentDj เป็น null → ไม่มี class selected → ไม่มีวงกลมแดง
  wrap.innerHTML = STATE.djs.map(d =>
    `<div class="dj-item${STATE.currentDj === d.id ? " selected" : ""}" data-dj="${d.id}">
      <img class="dj-avatar" src="${d.image_url || ""}" loading="lazy" alt="">
      <div class="dj-name">${escapeHtml(d.dj_name)}</div>
    </div>`
  ).join("");
  wrap.querySelectorAll(".dj-item").forEach(el => {
    el.addEventListener("click", () => {
      const selectedDjId = el.getAttribute("data-dj");
      // 🆕 (T015): ถ้าอยู่ใน advanced filter mode → reset ก่อน เพื่อกลับสู่ client-side filter
      //   เหตุผล: STATE.songs ปัจจุบันเป็น server-filtered results → DJ-row filter ฝั่ง client จะไม่ครบ
      //   ถ้า active=false ตั้งแต่ต้น → resetAdvancedFilterState จะ return ทันที (no-op)
      try { resetAdvancedFilterState({ reloadSongs: true }); } catch (_) {}
      // บันทึกสถานะก่อน toggle เพื่อเช็คว่าเป็นการ "เลือกใหม่" หรือ "ยกเลิก"
      //   🎧 (2026-09-20 fix): ถ้าเป็นการยกเลิก (currentDj เดิม === selectedDjId → หลัง toggle เป็น null)
      //   ห้าม scroll ลงล่าง เพราะทำให้ UX แย่ — ผู้ใช้แค่อยากยกเลิก ไม่ได้อยากดูเพลง
      const isCanceling = STATE.currentDj === selectedDjId;
      // กด DJ คนเดิมซ้ำอีกครั้งเพื่อยกเลิกตัวกรองและแสดงเพลงของ DJ ทุกคน
      STATE.currentDj = STATE.currentDj === selectedDjId ? null : selectedDjId;
      STATE.currentCategory = "all";
      // 🎧 (2026-09-20) re-render DJ row ทันทีเพื่ออัปเดต class "selected" (วงกลมแดง)
      //   - ถ้าไม่ re-render วงกลมแดงจะไม่โผล่/หายไป ทำให้ผู้ใช้สับสน
      renderDjRow();
      // 🔧 (2026-09-18 v6 Full System): เมื่อกด DJ ถ้ายังโหลดเพลงไม่ครบ → trigger auto-load-all
      if (STATE.songsHasMore) { // 🚀 (T062): ไม่ต้องรอ — คำค้น/ตัวกรองล่าสุดจะแทนที่ตัวเก่าเอง
        showToast("กำลังโหลดเพลงทั้งหมดเพื่อกรอง...", "progress");
        loadAllRemainingSongs().then(() => {
          renderCategoryChips();
          renderSongGrid();
          renderPlaylists();
          togglePlaylistsVisibility();
        });
      }
      renderCategoryChips();
      renderSongGrid();
      renderPlaylists();
      togglePlaylistsVisibility();
      // 🎧 (2026-09-20 fix): scroll ไปที่ gridTitle เฉพาะตอน "เลือก DJ ใหม่"
      //   - ถ้าเป็นการยกเลิก (isCanceling=true) → ห้าม scroll ปล่อยให้ผู้ใช้อยู่ที่ตำแหน่งเดิม
      //   - ป้องกันปัญหา "เด้งลงข้างล่าง" ตอนที่ผู้ใช้แค่ต้องการยกเลิกการเลือก
      if (!isCanceling) {
        const gridTitle = document.getElementById("gridTitle");
        if (gridTitle) gridTitle.scrollIntoView({ behavior: "smooth" });
      }
    });
  });
}

function normalizeCategoryValue(value) {
  return String(value == null ? "" : value).trim().toLowerCase();
}

function getCategoryValues(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value.flatMap(getCategoryValues);

  // รองรับกรณีที่เก็บหมวดหมู่เป็น object หรือ DocumentReference
  if (typeof value === "object") {
    return [
      value.id,
      value.category_id,
      value.categoryId,
      value.category_name,
      value.categoryName,
      value.name
    ].flatMap(getCategoryValues);
  }

  const normalized = normalizeCategoryValue(value);
  return normalized ? [normalized] : [];
}

function songBelongsToCurrentCategory(song) {
  if (STATE.currentCategory === "all") return true;

  const category = STATE.categories.find(c => c.id === STATE.currentCategory);
  const selectedValues = [
    STATE.currentCategory,
    category && category.id,
    category && category.category_name,
    category && category.name
  ].flatMap(getCategoryValues);

  // รองรับทั้งข้อมูลใหม่/เก่าที่บันทึกเป็น id, ชื่อหมวดหมู่,
  // array ของหมวดหมู่ หรือ object ของหมวดหมู่
  const songValues = [
    song.category_id,
    song.categoryId,
    song.category_ids,
    song.categoryIds,
    song.category,
    song.category_name,
    song.categoryName,
    song.categories
  ].flatMap(getCategoryValues);

  return songValues.some(value => selectedValues.includes(value));
}

function getFilteredSongs() {
  // 🆕 (T015): ถ้าใช้ advanced server-side filter → STATE.songs ถูกกรองที่ server แล้ว
  //   ส่งคืนทั้งหมดตรง ๆ ไม่ต้อง filter ซ้ำฝั่ง client (จะทับผลลัพธ์ server)
  //   ผลกระทบระบบเดิม: 0% — กรณี SONG_SEARCH_STATE.active=false → ใช้ logic เดิมทุกประการ
  //
  //   🆕 (T027): แม้ advanced filter active ก็ต้องกรองตาม category ฝั่ง client ด้วย
  //     ปัญหาเดิม: active=true → return STATE.songs ทั้งหมด → กดหมวดที่มี 0 เพลงก็ยังแสดงเพลงทั้งหมด
  //     วิธีแก้: ถ้า STATE.currentCategory !== "all" → กรองตาม category เสมอ (แม้ active=true)
  //     ผลกระทบ: 0% — ถ้า currentCategory="all" (ค่า default ตอน advanced filter active) → ไม่กรอง → เหมือนเดิม
  if (typeof SONG_SEARCH_STATE !== "undefined" && SONG_SEARCH_STATE.active) {
    // 🆕 (T027): ถ้าเลือกหมวดเฉพาะ → กรองตาม category ด้วย (กันปัญหาแสดงเพลงทั้งหมด)
    if (STATE.currentCategory && STATE.currentCategory !== "all") {
      return STATE.songs.filter(s => songBelongsToCurrentCategory(s));
    }
    return STATE.songs;
  }
  return STATE.songs.filter(s => {
    if (STATE.currentDj) {
      const dj = STATE.djs.find(d => d.id === STATE.currentDj);
      if (!dj || s.dj_name !== dj.dj_name) return false;
    }
    // 🎧 (2026-09-20) เพิ่มใหม่: ในหน้า DJ (STATE.currentView === "dj") ถ้ายังไม่ได้เลือก DJ
    //   → แสดงเฉพาะเพลงที่มี dj_name (มี DJ) — ซ่อนเพลงที่ไม่ได้แอดเข้า DJ ใด ๆ
    //   - ถ้าเลือก DJ แล้ว → กรองจากด้านบน (s.dj_name === dj.dj_name) อยู่แล้ว
    //   - หน้าอื่น ๆ (home/category/playlist) → ไม่กรอง แสดงเพลงทั้งหมดเหมือนเดิม
    if (!STATE.currentDj && STATE.currentView === "dj") {
      if (!s.dj_name || String(s.dj_name).trim() === "") return false;
    }
    if (!songBelongsToCurrentCategory(s)) return false;
    if (STATE.search) {
      const q = STATE.search.toLowerCase();
      // ค้นหาทั้งจากข้อมูลเพลง และค้นหาชื่อเพลย์ลิสต์ที่เพลงนี้สังกัดอยู่ด้วย
      const pl = STATE.playlists.find(p => p.id === s.playlist_id);
      const playlistName = pl ? pl.playlist_name : "";

      const hay = [s.song_name, s.artist, s.dj_name, s.category_name, playlistName].join(" ").toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

// 🆕 (T009-F1): Skeleton loader สำหรับ song grid — แสดงตอนกำลังโหลดข้อมูล
//   วาด card skeleton แบบ row (เลียนแบบ .song-card-row) จำนวน count ใบ ลงใน #songGrid
//   เมื่อ renderSongGrid() ถูกเรียก จะแทนที่ skeleton ด้วยการ์ดเพลงจริงทันที
//   - ใช้ CSS class .skeleton-row + .skeleton-cover-row + .skeleton-info + .skeleton-line
//   - shimmer animation ทำงานใน CSS (ดู style.css) → ไม่ต้องเขียน JS
function renderSongSkeleton(count = 12) {
  const grid = document.getElementById("songGrid");
  if (!grid) return;
  const safeCount = Math.max(1, Math.min(60, Number(count) || 12));
  // ซ่อน empty state ตอน skeleton แสดง (กัน "ไม่พบเพลง" โผล่ค้างอยู่ใต้ skeleton)
  const empty = document.getElementById("emptyState");
  if (empty) empty.style.display = "none";
  const skeletonHTML = Array.from({ length: safeCount }).map(() => `
    <div class="skeleton-row" aria-hidden="true">
      <div class="skeleton-cover-row"></div>
      <div class="skeleton-info">
        <div class="skeleton-line medium"></div>
        <div class="skeleton-line short"></div>
      </div>
    </div>
  `).join("");
  grid.innerHTML = skeletonHTML;
}

function renderSongGrid() {
  // 🚀 (Sort-Fix): sort STATE.songs ทุกครั้งก่อน render — กันกรณี sort ถูกข้าม
  //   เดิม: sort แค่ใน loadMoreSongs → ถ้าข้ามไป → ไม่เรียง
  //   ใหม่: sort ใน renderSongGrid ด้วย → เรียงเสมอ ไม่สนว่าเพิ่มเพลงตอนไหน
  //   Performance: O(n log n) แต่ n ≤ 10,000 → < 10ms → ไม่กระตุก
  if (!(typeof SONG_SEARCH_STATE !== "undefined" && SONG_SEARCH_STATE.active)) {
    STATE.songs = sortSongsByThaiName(STATE.songs);
  }
  const list = getFilteredSongs();
  const grid = document.getElementById("songGrid");
  const empty = document.getElementById("emptyState");
  if (!grid) return;

  // 🆕 (T111 2026-10-07 fix Bug #2): ถ้าไม่ใช่ view ที่โชว์เพลง (home/category/dj) → ซ่อน emptyState + return early
  //   ปัญหา: เมื่อ user อยู่แท็บ Playlist และกด Apply โดยไม่มี active filter → loadSongsWithFilters
  //     รัน loadMoreSongs() ที่มี guard `if (songGrid.style.display === "none") return` (line 478, T007 hardening)
  //     → STATE.songs ว่าง → renderSongGrid ตั้ง emptyState.style.display = "block" (line 1881 ด้านล่าง)
  //     → ทับ display:none ที่ setView() ตั้งไว้ → "ไม่พบเพลง" + emoji 🎵 โผล่ใน songGrid area
  //     ระหว่าง search bar กับ playlist content ทั้งที่ user อยู่แท็บ Playlist
  //   วิธีแก้: เพิ่ม guard ข้างบน — ถ้า currentView ไม่ใช่ view ที่โชว์เพลง → ซ่อน emptyState เสมอ
  //     + return early ไม่ยอมแตะ emptyState.style.display = "block"
  //   ผลกระทบระบบเดิม: 0% — setView() ก็ตั้ง emptyState แบบเดียวกันอยู่แล้ว (line 2534-2535)
  //     ที่นี่คือ defense-in-depth สำหรับ call site อื่น ๆ ที่อาจ trigger renderSongGrid นอก setView
  const _isSongsView = STATE.currentView === "home"
    || STATE.currentView === "category"
    || STATE.currentView === "dj";
  if (!_isSongsView) {
    if (empty) empty.style.display = "none";
    return;
  }

  // 🆕 (T035b): ล้าง observer เก่า + sentinel เก่าก่อนทุกครั้ง — กันเพลงเก่าปน
  //   ปัญหา: IntersectionObserver เก่ายิง renderNextBatch หลัง grid.innerHTML=""
  //   → เพิ่มเพลงเก่ากลับเข้ามา → ปนกับ empty state
  if (STATE._songGridObserver) {
    STATE._songGridObserver.disconnect();
    STATE._songGridObserver = null;
  }
  const oldSentinel = document.getElementById("songGridSentinel");
  if (oldSentinel) oldSentinel.remove();

  if (list.length === 0) {
    grid.innerHTML = "";
    if (empty) {
      empty.style.display = "block";
      empty.textContent = STATE.currentCategory !== "all"
        ? "หมวดหมู่นี้ยังไม่มีเพลง"
        : (STATE.search ? `ไม่พบเพลงที่ค้นหา "${STATE.search}"` : "ไม่พบเพลง");
    }
    return;
  }
  if (empty) empty.style.display = "none";

  // 🔧 (2026-09-21 fix Bug #4 renderSongGrid DOM pagination): ลด DOM freeze
  //   ปัญหา: เดิมใช้ grid.innerHTML = list.map(...).join("") ทำงานทีเดียวทั้ง list
  //   → ถ้า catalog 5,000 เพลง → สร้าง 5,000 DOM nodes ใน 1 tick → browser freeze
  //
  //   วิธีแก้: DOM pagination — render ทีละ batch (60 เพลง) + ใช้ IntersectionObserver
  //     ตรวจ sentinel element ท้าย grid → เมื่อ user scroll ถึง → append batch ถัดไป
  //     ส่งผลให้ first paint เร็วขึ้นมาก + scroll ลื่น + ไม่ freeze แม้ catalog ใหญ่
  //
  //   ผลกระทบระบบเดิม: 0%
  //     - ผู้ใช้ยังเห็นเพลงเหมือนเดิม แค่ค่อยๆ โหลดเพิ่มตอน scroll
  //     - event listeners ยัง attach ใหม่ทุก batch (เหมือนเดิม)
  //     - ถ้า browser ไม่รองรับ IntersectionObserver → fallback ใช้โหมดเดิม (render ทั้งหมด)
  const RENDER_BATCH_SIZE = 60;  // 60 เพลงต่อ batch — สมดุลระหว่าง first paint + scroll
  const totalSongs = list.length;

  // ล้าง grid เดิม + setup state
  grid.innerHTML = "";
  STATE._renderedSongCount = 0;
  STATE._filteredSongList = list;  // เก็บ list ทั้งหมดไว้ใช้ตอน append batch ถัดไป

  // ฟังก์ชันสร้าง HTML ของ batch (เหมือนเดิม แค่รับ slice ของ list)
  // 🆕 (Feature #8): loadRatingsForVisibleSongs — โหลด rating เฉลี่ยของเพลงที่แสดงอยู่
  //   ใช้ /api/songs/:id/reviews/summary endpoint (ที่มีอยู่แล้ว)
  //   ทำงานเป็น batch — โหลดทีละหลายเพลงพร้อมกัน (ลด HTTP requests)
  //   ถ้ายังไม่มีรีวิว → ซ่อน rating row (display:none)
  const _ratingCache = new Map(); // song_id → {avg, count} | null (null = ไม่มีรีวิว)
  async function loadRatingsForVisibleSongs(songIds) {
    if (!Array.isArray(songIds) || songIds.length === 0) return;
    // filter เฉพาะที่ยังไม่ได้โหลด
    const toLoad = songIds.filter(id => !_ratingCache.has(id));
    if (toLoad.length === 0) return;
    // โหลดทีละเพลง (parallel) — ใช้ Promise.allSettled กัน error รัว
    const promises = toLoad.map(async (songId) => {
      try {
        const res = await fetch('/api/songs/' + encodeURIComponent(songId) + '/reviews/summary', { credentials: 'same-origin' });
        if (!res.ok) { _ratingCache.set(songId, null); return; }
        const data = await res.json();
        if (data && data.count > 0) {
          _ratingCache.set(songId, { avg: data.avg_rating || 0, count: data.count });
        } else {
          _ratingCache.set(songId, null);
        }
      } catch (err) {
        _ratingCache.set(songId, null);
      }
    });
    await Promise.allSettled(promises);
    // render ที่แสดงผล
    for (const songId of toLoad) {
      renderRatingInCard(songId);
    }
  }
  function renderRatingInCard(songId) {
    const rating = _ratingCache.get(songId);
    const rows = document.querySelectorAll('[data-rating-row="' + songId + '"]');
    rows.forEach(row => {
      if (!rating) {
        row.style.display = 'none';
        return;
      }
      row.style.display = 'flex';
      // สร้าง stars (filled = avg rounded, empty = 5 - filled)
      const filledStars = Math.round(rating.avg);
      const starsHtml = Array.from({ length: 5 }, (_, i) => {
        if (i < filledStars) {
          return '<span style="color:#fbbf24;">★</span>';
        }
        return '<span style="color:rgba(255,255,255,0.2);">★</span>';
      }).join('');
      const starsEl = row.querySelector('[data-rating-stars]');
      const textEl = row.querySelector('[data-rating-text]');
      if (starsEl) starsEl.innerHTML = starsHtml;
      if (textEl) textEl.textContent = rating.avg.toFixed(1) + ' (' + rating.count + ')';
    });
  }

  function buildBatchHTML(startIdx) {
    const endIdx = Math.min(startIdx + RENDER_BATCH_SIZE, totalSongs);
    const batch = list.slice(startIdx, endIdx);
    return batch.map((s, i) => {
      const globalIdx = startIdx + i;
      return `
        <div class="song-card song-card-row" data-id="${escapeHtml(s.id)}">
          <div class="song-cover">
            <img src="${escapeHtml(s.cover_url || "default-song-cover.svg")}" loading="lazy" alt="${escapeHtml(s.song_name)}" onerror="this.src='default-song-cover.svg'">
            <button class="play-btn" data-play="${s.id}" aria-label="เล่น ${escapeHtml(s.song_name)}"><svg width="16" height="16" viewBox="0 0 24 24" fill="#fff"><path d="M8 5v14l11-7z"/></svg></button>
          </div>
          <div class="song-info">
            <div class="song-name">${escapeHtml(s.song_name)}</div>
            <div class="song-rating-row" data-rating-row="${s.id}" style="display:none;">
              <span class="song-rating-stars" data-rating-stars></span>
              <span class="song-rating-text" data-rating-text></span>
            </div>
            <div class="song-meta-row">
              ${s.dj_name ? `<span class="song-dj-tag">🎧 ${escapeHtml(s.dj_name)}</span>` : ""}
              ${s.artist ? `<span class="song-meta-text">${escapeHtml(s.artist)}</span>` : ""}
            </div>
            <div class="song-footer">
              <div class="song-price-block">
                ${renderDiscountedPriceForSong(s)}
              </div>
              <div class="song-actions-row" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                <button class="btn-like-tiktok" type="button" data-like-btn="${s.id}" aria-label="ถูกใจเพลงนี้" title="ถูกใจ">
                  <svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>
                  <span class="like-count" data-like-count>0</span>
                </button>
                <button class="btn-icon-mini" type="button" data-favorite-btn="${s.id}" data-song-name="${escapeHtml(s.song_name)}" aria-label="บันทึกซื้อทีหลัง" title="บันทึกซื้อทีหลัง"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg></button>
                <button class="cart-add-btn cart-add-btn-row" type="button" data-add-cart="${s.id}" aria-label="เพิ่ม ${escapeHtml(s.song_name)} ลงตะกร้า">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M9 14v-3.5"/><circle cx="8" cy="14.5" r="1.5"/><path d="M14 13v-3.5"/><circle cx="13" cy="13.5" r="1.5"/></svg>
                  <span>เพิ่มลงตะกร้า</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      `;
    }).join("");
  }

  // ฟังก์ชัน attach event listeners ให้ batch ปัจจุบัน (ใช้กับ elements ที่เพิ่ง add เข้า grid)
  function attachBatchListeners(startIdx) {
    // 🆕 (Feature #8): โหลด ratings สำหรับเพลงใน batch นี้ (lazy, async — ไม่บล็อก render)
    const batchEndIdx = Math.min(startIdx + RENDER_BATCH_SIZE, totalSongs);
    const batchIds = list.slice(startIdx, batchEndIdx).map(s => s.id).filter(Boolean);
    if (batchIds.length > 0) {
      // ใช้ setTimeout 0 เพื่อให้ render เสร็จก่อน แล้วค่อยโหลด ratings
      setTimeout(() => loadRatingsForVisibleSongs(batchIds), 0);
    }
    const endIdx = Math.min(startIdx + RENDER_BATCH_SIZE, totalSongs);
    // ใช้ querySelector กับ elements ที่อยู่ในช่วง index นี้
    // แต่ querySelectorAll ไม่รองรับ range → ใช้วิธี iterate แบบเดิม + filter เฉพาะที่ยังไม่มี listener
    // วิธีง่ายกว่า: querySelectorAll ทั้งหมด + ใช้ dataset เช็คว่า attach แล้วหรือยัง
    grid.querySelectorAll("[data-play]").forEach(el => {
      if (el.dataset._listenerAttached) return;
      el.dataset._listenerAttached = "1";
      el.addEventListener("click", (ev) => { ev.stopPropagation(); unlockAudio(); playSong(el.getAttribute("data-play")); });
    });
    grid.querySelectorAll("[data-add-cart]").forEach(el => {
      if (el.dataset._listenerAttached) return;
      el.dataset._listenerAttached = "1";
      el.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const song = findSong(el.getAttribute("data-add-cart"));
        if (song) {
          addToCart(song);
        }
      });
    });
    // 🆕 (2026-10-02 v7): ปุ่ม ❤️ ถูกใจ (TikTok style) — toggle like + แสดงจำนวน
    grid.querySelectorAll("[data-like-btn]").forEach(el => {
      if (el.dataset._listenerAttached) return;
      el.dataset._listenerAttached = "1";
      el.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        const songId = el.getAttribute("data-like-btn");
        if (typeof window.toggleLike === "function") {
          await window.toggleLike(songId);
        }
      });
      // 🆕 โหลดจำนวน like + สถานะเริ่มต้น
      const songId = el.getAttribute("data-like-btn");
      if (typeof window.loadLikeStatus === "function") {
        window.loadLikeStatus(songId).then(({ like_count, is_liked }) => {
          const countEl = el.querySelector("[data-like-count]");
          if (countEl) countEl.textContent = like_count;
          if (is_liked) el.classList.add("is-liked");
        });
      }
    });
    // 🆕 (2026-10-02 v7): ปุ่ม 📌 บันทึกซื้อทีหลัง (favorites) — เดิมเป็น ❤️ เปลี่ยนเป็น bookmark icon
    grid.querySelectorAll("[data-favorite-btn]").forEach(el => {
      if (el.dataset._listenerAttached) return;
      el.dataset._listenerAttached = "1";
      el.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        const songId = el.getAttribute("data-favorite-btn");
        if (typeof window.toggleFavorite === "function") {
          await window.toggleFavorite(songId);
        }
      });
      // 🆕 โหลดสถานะ favorite เริ่มต้น (ถ้า login แล้ว) → เปลี่ยนเป็น bookmark เต็ม (fill)
      const songId = el.getAttribute("data-favorite-btn");
      if (typeof window.checkFavoriteStatus === "function" && typeof window.isCustomerLoggedIn === "function" && window.isCustomerLoggedIn()) {
        window.checkFavoriteStatus(songId).then(isFav => {
          if (isFav) {
            el.classList.add("is-favorite");
            el.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>';
          }
        });
      }
    });
    grid.querySelectorAll(".song-card").forEach(el => {
      if (el.dataset._cardListenerAttached) return;
      el.dataset._cardListenerAttached = "1";
      el.addEventListener("click", () => openSongModal(el.getAttribute("data-id")));
    });
  }

  // ฟังก์ชัน render batch ถัดไป (เรียกโดย IntersectionObserver)
  function renderNextBatch() {
    if (STATE._renderedSongCount >= totalSongs) return;
    const startIdx = STATE._renderedSongCount;
    // สร้าง HTML + insert เข้า grid ตรง ๆ
    const batchHTML = buildBatchHTML(startIdx);
    // 🔧 (T007 fix): insert เข้า grid ตรง ๆ แทน sentinel.beforebegin
    //   เดิม: sentinel.insertAdjacentHTML("beforebegin", batchHTML) → song cards เป็น siblings ของ #songGrid → ตอนซ่อน #songGrid ด้วย display:none มันซ่อนแค่ตัวว่างเปล่า song cards ยังเห็นอยู่
    //   ใหม่: grid.insertAdjacentHTML("beforeend", batchHTML) → song cards เป็น children ของ #songGrid → ซ่อน #songGrid แล้ว song cards ซ่อนด้วย
    //   ผลกระทบ: แก้ bug ที่กด tab โปร/ออเดอร์ แล้วต้อง scroll ผ่านเพลงทั้งหมด + แก้ duplicate songs bug (grid.innerHTML='' ตอนนี้ clear songs ได้จริง)
    grid.insertAdjacentHTML("beforeend", batchHTML);
    STATE._renderedSongCount = Math.min(startIdx + RENDER_BATCH_SIZE, totalSongs);
    attachBatchListeners(startIdx);
    updatePlayButtonsUI();
    // ถ้ายังเหลือเพลง → ไม่ลบ sentinel (รอ observer trigger batch ถัดไป)
    // ถ้าโหลดครบแล้ว → ลบ sentinel (ไม่ต้อง observer แล้ว)
    if (STATE._renderedSongCount >= totalSongs) {
      const s = document.getElementById("songGridSentinel");
      if (s) s.remove();
    }
  }

  // Setup IntersectionObserver สำหรับ infinite scroll (ถ้า browser รองรับ)
  if ("IntersectionObserver" in window && totalSongs > RENDER_BATCH_SIZE) {
    // สร้าง sentinel element ท้าย grid
    let sentinel = document.getElementById("songGridSentinel");
    if (!sentinel) {
      sentinel = document.createElement("div");
      sentinel.id = "songGridSentinel";
      sentinel.style.height = "1px";
      sentinel.style.width = "100%";
      sentinel.style.marginTop = "20px";
      grid.parentElement.insertBefore(sentinel, grid.nextSibling);
    }
    // ลบ observer เดิมก่อน (กัน leak ถ้ามี)
    if (STATE._songGridObserver) {
      STATE._songGridObserver.disconnect();
    }
    STATE._songGridObserver = new IntersectionObserver((entries) => {
      // 🛡️ (T007 hardening): guard — ถ้า songGrid ซ่อนอยู่ ไม่ต้อง render batch ถัดไป
      //   เหตุผล: defense-in-depth — กัน observer ยิง renderNextBatch ตอนอยู่บน tab อื่น
      //   แม้จะซ่อน sentinel ไว้แล้ว แต่กันกรณี browser ยัง trigger intersect ด้วยเหตุผลอื่น
      const songGrid = document.getElementById("songGrid");
      if (!songGrid || songGrid.style.display === "none") return;
      for (const entry of entries) {
        if (entry.isIntersecting && STATE._renderedSongCount < totalSongs) {
          renderNextBatch();
        }
      }
    }, { rootMargin: "200px" });
    STATE._songGridObserver.observe(sentinel);
  }

  // Render batch แรกทันที (60 เพลงแรก) — เพื่อ first paint
  // ถ้าไม่รองรับ IntersectionObserver → render ทั้งหมดทีเดียว (fallback เดิม)
  if ("IntersectionObserver" in window && totalSongs > RENDER_BATCH_SIZE) {
    renderNextBatch();  // render เฉพาะ batch แรก — batch ถัดไปจะโหลดตอน scroll
  } else {
    // Fallback: render ทั้งหมด (กรณี browser เก่าหรือเพลงน้อยกว่า batch size)
    grid.innerHTML = buildBatchHTML(0);
    STATE._renderedSongCount = totalSongs;
    attachBatchListeners(0);
    updatePlayButtonsUI();
  }
}

const openPlaylists = new Set();

// 🆕 (Playlist-Scale): แท็บ Playlist ไม่ต้องโหลดเพลงทั้งคลัง (รองรับ 10,000+ เพลง)
//   - จำนวนเพลงต่อเพลย์ลิสต์มาจากเซิร์ฟเวอร์ครั้งเดียว (/api/db/songs?counts=playlist) → แสดงครบ ไม่หายไม่โผล่ทีหลัง
//   - เพลงในเพลย์ลิสต์โหลดเมื่อเปิดดู/กดซื้อ (กรองตาม playlist_id ที่เซิร์ฟเวอร์) แล้วเรียง ก-ฮ > A-Z > 0-9
STATE.playlistCounts = STATE.playlistCounts || null;
const _plLoadedOnce = new Set();
const _plLoadingNow = new Map();

async function loadPlaylistCounts() {
  try {
    const res = await fetch("/api/db/songs?counts=playlist", { credentials: "same-origin" });
    if (!res.ok) return;
    const data = await res.json();
    STATE.playlistCounts = (data && data.counts) || {};
    renderPlaylists();
  } catch (err) {
    console.warn("loadPlaylistCounts failed:", err?.message || err);
  }
}

function ensurePlaylistSongsLoaded(playlistId) {
  if (!playlistId) return Promise.resolve();
  if (_plLoadedOnce.has(playlistId)) return Promise.resolve();
  if (_plLoadingNow.has(playlistId)) return _plLoadingNow.get(playlistId);
  const task = (async () => {
    const PAGE = 200;
    let offset = 0;
    const seen = new Set(STATE.songs.map(x => x.id));
    for (let i = 0; i < 100; i++) {
      const params = new URLSearchParams({ playlists: playlistId, limit: String(PAGE), offset: String(offset), slim: "1" });
      const res = await fetch(`/api/db/songs?${params.toString()}`, { credentials: "same-origin" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      const docs = Array.isArray(data?.docs) ? data.docs : [];
      for (const d of docs) {
        if (seen.has(d.id)) continue;
        const song = { id: d.id, ...d.data };
        if (song.status === "hidden") continue;
        seen.add(d.id);
        STATE.songs.push(song);
      }
      offset += PAGE;
      const total = typeof data.total === "number" ? data.total : null;
      if (docs.length < PAGE || (total !== null && offset >= total)) break;
    }
    _plLoadedOnce.add(playlistId);
    STATE.songs = sortSongsByThaiName(STATE.songs);
  })().catch(err => {
    console.warn("ensurePlaylistSongsLoaded failed:", err?.message || err);
    // กันวนลูปโหลดซ้ำตอนเน็ตมีปัญหา — ปล่อยให้ลองใหม่ได้หลัง 30 วินาที
    _plLoadedOnce.add(playlistId);
    setTimeout(() => _plLoadedOnce.delete(playlistId), 30000);
  }).finally(() => {
    _plLoadingNow.delete(playlistId);
    renderPlaylists();
  });
  _plLoadingNow.set(playlistId, task);
  return task;
}

function renderPlaylists() {
  const container = document.getElementById("playlistsContainer");
  if (!container) return;
  // 🚀 (Sort-Fix): sort playlists ทุกครั้งก่อน render
  STATE.playlists = sortByThaiName(STATE.playlists, "playlist_name");
  if (STATE.playlists.length === 0) { container.innerHTML = ""; return; }

  // 🔧 เพิ่ม (2026-09-14): ถ้าเลือก DJ อยู่ → กรองเพลย์ลิสต์/เพลงตาม DJ คนนั้น
  // - ดึง dj_name จาก DJ ที่เลือก (ปลอดภัยเพราะเป็น null ถ้าไม่ได้เลือก)
  // - ไม่กระทบกระบวนการเดิม (ค้นหา/toggle/ราคา/ปุ่มซื้อ)
  const selectedDjName = STATE.currentDj
    ? (STATE.djs.find(d => d.id === STATE.currentDj)?.dj_name || null)
    : null;

  // 🆕 (T109→T110 2026-10-07): ถ้าเลือก DJ ในตัวกรองขั้นสูง → กรองเพลย์ลิสต์ตาม DJ ที่เลือก
  //   Owner: เวลาลูกค้าเลือกชื่อ DJ ในตัวกรองขั้นสูง → หน้า Playlist แสดงเฉพาะเพลย์ลิสต์ของ DJ นั้น
  //   T110 fix: ไม่ต้องรอกด Apply — เช็คแค่ djs.size > 0 (chip toggle ส่งผลทันที)
  //   เมื่อกดล้าง → djs.clear() → size=0 → advSearchDjNames=null → แสดงทั้งหมด
  //   ผลกระทบระบบเดิม: 0% — ถ้าไม่ได้เลือก DJ ในตัวกรองขั้นสูง → ใช้ selectedDjName (STATE.currentDj) เหมือนเดิม
  const advSearchDjNames = (typeof SONG_SEARCH_STATE !== "undefined" && SONG_SEARCH_STATE.djs.size > 0)
    ? Array.from(SONG_SEARCH_STATE.djs)
    : null;

  // 🆕 (2026-10-07): ตัวกรองขั้นสูง "เฉพาะเพลงที่มีโปรโมชัน" → เพลย์ลิสต์แสดงเฉพาะอันที่ลดราคา เหมือนเพลงเดี่ยว
  //   ทำงานเมื่อกด "ค้นหา" แล้ว (active + promoOnly) — กดล้าง → promoOnly=false → แสดงเพลย์ลิสต์ทั้งหมดตามเดิม
  const promoOnlyPlaylists = (typeof SONG_SEARCH_STATE !== "undefined")
    && SONG_SEARCH_STATE.active === true
    && SONG_SEARCH_STATE.promoOnly === true;

  // กรองเพลย์ลิสต์ตามคำค้นหาด้วย (ถ้าช่องค้นหาตรงกับชื่อเพลย์ลิสต์ จะแสดงเพลย์ลิสต์นั้น)
  const filteredPlaylists = STATE.playlists.filter(pl => {
    if (promoOnlyPlaylists && !playlistHasActiveDiscount(pl)) return false;
    // 🔧 เพิ่ม (2026-09-14): ถ้าเลือก DJ แล้ว เพลย์ลิสต์ต้องมีเพลงของ DJ คนนั้นอย่างน้อย 1 เพลง
    if (selectedDjName) {
      const hasDjSong = STATE.songs.some(s =>
        s.playlist_id === pl.id && s.dj_name === selectedDjName
      );
      if (!hasDjSong) return false;
    }
    // 🆕 (T109): ถ้า Advanced Search active + เลือก DJ → กรองเพลย์ลิสต์ตาม DJ ที่เลือก
    if (advSearchDjNames) {
      const hasDjSong = STATE.songs.some(s =>
        s.playlist_id === pl.id && advSearchDjNames.includes(s.dj_name)
      );
      if (!hasDjSong) return false;
    }
    if (!STATE.search) return true;
    const q = STATE.search.toLowerCase();
    const matchPlName = pl.playlist_name.toLowerCase().includes(q);
    const hasMatchingSongs = STATE.songs.some(s => s.playlist_id === pl.id && [s.song_name, s.artist, s.dj_name].join(" ").toLowerCase().includes(q));
    return matchPlName || hasMatchingSongs;
  });

  container.innerHTML = filteredPlaylists.map(pl => {
    const songs = STATE.songs.filter(s => s.playlist_id === pl.id);
    // 🆕 (Playlist-Scale): จำนวนเพลงจริงจากเซิร์ฟเวอร์ — ถ้ามากกว่าที่โหลดแล้ว = ยังมีเพลงที่ยังไม่ถูกโหลด (โหลดตอนเปิดดู)
    const serverCount = STATE.playlistCounts ? (STATE.playlistCounts[pl.id] || 0) : 0;
    const hasPendingSongs = !selectedDjName && serverCount > songs.length;
    if (songs.length === 0 && !hasPendingSongs) return "";
    // 🔧 เพิ่ม (2026-09-14): ถ้าเลือก DJ แล้ว ให้แสดงเฉพาะเพลงของ DJ คนนั้นในเพลย์ลิสต์
    // - ถ้าไม่ได้เลือก DJ จะแสดงเพลงทั้งหมดในเพลย์ลิสต์เหมือนเดิม
    const displaySongs = selectedDjName
      ? songs.filter(s => s.dj_name === selectedDjName)
      : advSearchDjNames
        ? songs.filter(s => advSearchDjNames.includes(s.dj_name))
        : songs;
    if (displaySongs.length === 0 && !hasPendingSongs) return "";
    const isOpen = openPlaylists.has(pl.id) || (STATE.search && STATE.search.length > 0); // เปิดอัตโนมัติเมื่อกำลังค้นหา
    // 🔧 เพิ่ม (2026-09-14): เมื่อเลือก DJ ให้ auto-expand เพลย์ลิสต์ที่มีเพลงของ DJ คนนั้น เพื่อให้เห็นเพลงเลย
    // 🆕 (T109): auto-expand ด้วยเมื่อ Advanced Search active + เลือก DJ
    const isAutoOpenForDj = !!selectedDjName || !!advSearchDjNames;
    const finalIsOpen = isOpen || isAutoOpenForDj;
    const cover = pl.cover_url || songs[0]?.cover_url || "default-playlist-cover.svg";
    if (hasPendingSongs && finalIsOpen) setTimeout(() => ensurePlaylistSongsLoaded(pl.id), 0);
    // 🔧 เพิ่ม (2026-09-14): ป้ายจำนวนเพลงแสดงเฉพาะเพลงของ DJ คนนั้น ถ้าเลือก DJ
    const songCountLabel = selectedDjName
      ? `${displaySongs.length} เพลง`
      : `${Math.max(serverCount, songs.length)} เพลง`;
    return `
      <div class="playlist-block" data-playlist-id="${pl.id}">
        <div class="playlist-folder-btn" data-toggle-playlist="${pl.id}">
          <div class="playlist-folder-cover">
            <img src="${escapeHtml(cover)}" loading="lazy" alt="${escapeHtml(pl.playlist_name)}" onerror="this.style.display='none'">
          </div>
          <div class="playlist-folder-info">
            <div class="playlist-folder-name">${escapeHtml(pl.playlist_name)}</div>
            <div class="playlist-folder-count">${songCountLabel}</div>
            ${pl.price ? `
            <div class="playlist-folder-bottom">
              <div class="playlist-folder-price-block">
                ${renderDiscountedPriceForPlaylist(pl)}
              </div>
              <div class="song-actions-row" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                <button class="btn-like-tiktok" type="button" data-like-btn="${pl.id}" data-like-type="playlist" aria-label="ถูกใจเพลย์ลิสต์นี้" title="ถูกใจ">
                  <svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>
                  <span class="like-count" data-like-count>0</span>
                </button>
                <button class="btn-icon-mini" type="button" data-favorite-btn="${pl.id}" data-favorite-type="playlist" data-song-name="${escapeHtml(pl.playlist_name)}" aria-label="บันทึกซื้อทีหลัง" title="บันทึกซื้อทีหลัง"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg></button>
                <button type="button" class="cart-add-btn playlist-folder-buy-btn" data-add-cart-playlist="${pl.id}" aria-label="ซื้อเพลย์ลิสต์ ${escapeHtml(pl.playlist_name)}">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M9 14v-3.5"/><circle cx="8" cy="14.5" r="1.5"/><path d="M14 13v-3.5"/><circle cx="13" cy="13.5" r="1.5"/></svg>
                  <span>ซื้อทั้งเพลย์ลิสต์</span>
                </button>
              </div>
            </div>
            ` : `
            <div class="playlist-folder-bottom">
              <div class="song-actions-row" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                <button class="btn-like-tiktok" type="button" data-like-btn="${pl.id}" data-like-type="playlist" aria-label="ถูกใจเพลย์ลิสต์นี้" title="ถูกใจ">
                  <svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>
                  <span class="like-count" data-like-count>0</span>
                </button>
                <button class="btn-icon-mini" type="button" data-favorite-btn="${pl.id}" data-favorite-type="playlist" data-song-name="${escapeHtml(pl.playlist_name)}" aria-label="บันทึกซื้อทีหลัง" title="บันทึกซื้อทีหลัง"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg></button>
              </div>
            </div>
            `}
          </div>
          <svg class="playlist-folder-arrow${finalIsOpen ? "" : " is-closed"}" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3c7.2 0 9 1.8 9 9s-1.8 9 -9 9s-9 -1.8 -9 -9s1.8 -9 9 -9z"/><path d="M8 10l4 4l4 -4"/></svg>
        </div>
        <div class="playlist-row-wrap${finalIsOpen ? "" : " is-closed"}">
          <div class="playlist-row">
            ${hasPendingSongs ? `<div class="empty-state" style="padding:12px;opacity:.7;">กำลังโหลดเพลง...</div>` : ""}
            ${displaySongs.map(s => `
              <div class="playlist-song-row song-card-row" data-id="${escapeHtml(s.id)}">
                <div class="playlist-cover song-cover">
                  <img src="${escapeHtml(s.cover_url || pl.cover_url || "default-song-cover.svg")}" loading="lazy" alt="${escapeHtml(s.song_name)}" onerror="this.src='default-song-cover.svg'">
                  <button class="playlist-play-btn play-btn" data-play="${s.id}" aria-label="เล่น ${escapeHtml(s.song_name)}">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="#fff"><path d="M8 5v14l11-7z"/></svg>
                  </button>
                </div>
                <div class="playlist-info song-info">
                  <div class="playlist-item-name song-name">${escapeHtml(s.song_name)}</div>
                  <div class="song-meta-row">
                    ${s.dj_name ? `<span class="song-dj-tag">🎧 ${escapeHtml(s.dj_name)}</span>` : ""}
                    ${s.artist ? `<span class="song-meta-text">${escapeHtml(s.artist)}</span>` : ""}
                  </div>
                  <div class="song-footer">
                    <div class="song-price-block">
                      ${renderDiscountedPriceForSong(s)}
                    </div>
                    <div class="song-actions-row" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                      <button class="btn-like-tiktok" type="button" data-like-btn="${s.id}" aria-label="ถูกใจเพลงนี้" title="ถูกใจ">
                        <svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>
                        <span class="like-count" data-like-count>0</span>
                      </button>
                      <button class="btn-icon-mini" type="button" data-favorite-btn="${s.id}" data-song-name="${escapeHtml(s.song_name)}" aria-label="บันทึกซื้อทีหลัง" title="บันทึกซื้อทีหลัง"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg></button>
                      <button class="cart-add-btn playlist-add-cart cart-add-btn-row" type="button" data-add-cart-song="${s.id}" aria-label="เพิ่ม ${escapeHtml(s.song_name)} ลงตะกร้า">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M9 14v-3.5"/><circle cx="8" cy="14.5" r="1.5"/><path d="M14 13v-3.5"/><circle cx="13" cy="13.5" r="1.5"/></svg>
                        <span>เพิ่มลงตะกร้า</span>
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            `).join("")}
          </div>
        </div>
      </div>
    `;
  }).join("");

  container.querySelectorAll("[data-toggle-playlist]").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-toggle-playlist");
      const block = btn.closest(".playlist-block");
      const wrap = block.querySelector(".playlist-row-wrap");
      const arrow = btn.querySelector(".playlist-folder-arrow");
      const willOpen = wrap.classList.contains("is-closed");
      wrap.classList.toggle("is-closed");
      arrow.classList.toggle("is-closed");
      if (willOpen) { openPlaylists.add(id); ensurePlaylistSongsLoaded(id); } else openPlaylists.delete(id);
    });
  });

  container.querySelectorAll("[data-add-cart-playlist]").forEach(btn => {
    btn.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      const pl = STATE.playlists.find(p => p.id === btn.getAttribute("data-add-cart-playlist"));
      if (!pl) return;
      await ensurePlaylistSongsLoaded(pl.id); // 🆕 (Playlist-Scale) ให้แน่ใจว่าเพลงครบก่อนทำ snapshot ลงตะกร้า
      const plSongs = STATE.songs.filter(s => s.playlist_id === pl.id);
      const firstSong = plSongs[0];
      addToCart({
        id: `playlist:${pl.id}`,
        song_name: `เพลย์ลิสต์: ${pl.playlist_name}`,
        cover_url: pl.cover_url || firstSong?.cover_url || "default-playlist-cover.svg",
        dj_name: `${plSongs.length} เพลง`,
        price: pl.price,
        kind: "playlist",
        // Snapshot รายชื่อ+ไอดีเพลงในเพลย์ลิสต์ ณ ตอนเพิ่มลงตะกร้า
        // ใช้แสดงผล "ดูรายการเพลง" ในตะกร้า/ใบเสร็จ และตรวจเพลงซ้ำกับเพลงเดี่ยวเท่านั้น
        // (ไม่ถูกนำมาคิดราคาแยก ราคายังคงเป็นราคาเหมาเพลย์ลิสต์เท่านั้น)
        song_ids: plSongs.map(s => String(s.id)),
        songs: plSongs.map(s => ({ id: String(s.id), song_name: String(s.song_name || "เพลง") }))
      });
    });
  });

  container.querySelectorAll("[data-add-cart-song]").forEach(btn => {
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const song = findSong(btn.getAttribute("data-add-cart-song"));
      if (song) {
        addToCart(song);
      }
    });
  });

  container.querySelectorAll("[data-play]").forEach(el => {
    el.addEventListener("click", (ev) => { ev.stopPropagation(); unlockAudio(); playSong(el.getAttribute("data-play")); });
  });

  // 🆕 (2026-10-02 v7): ปุ่ม ❤️ ถูกใจ ใน playlist header + song row
  container.querySelectorAll("[data-like-btn]").forEach(el => {
    if (el.dataset._listenerAttached) return;
    el.dataset._listenerAttached = "1";
    el.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      const songId = el.getAttribute("data-like-btn");
      if (typeof window.toggleLike === "function") {
        await window.toggleLike(songId);
      }
    });
    // โหลดจำนวน like + สถานะเริ่มต้น
    const songId = el.getAttribute("data-like-btn");
    if (typeof window.loadLikeStatus === "function") {
      window.loadLikeStatus(songId).then(({ like_count, is_liked }) => {
        const countEl = el.querySelector("[data-like-count]");
        if (countEl) countEl.textContent = like_count;
        if (is_liked) el.classList.add("is-liked");
      });
    }
  });

  // 🆕 (2026-10-02 v7): ปุ่ม 📌 บันทึกซื้อทีหลัง ใน playlist header + song row
  container.querySelectorAll("[data-favorite-btn]").forEach(el => {
    if (el.dataset._listenerAttached) return;
    el.dataset._listenerAttached = "1";
    el.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      const songId = el.getAttribute("data-favorite-btn");
      if (typeof window.toggleFavorite === "function") {
        await window.toggleFavorite(songId);
      }
    });
    // โหลดสถานะ favorite เริ่มต้น (ถ้า login แล้ว) → bookmark fill (ม่วง)
    const songId = el.getAttribute("data-favorite-btn");
    if (typeof window.checkFavoriteStatus === "function" && typeof window.isCustomerLoggedIn === "function" && window.isCustomerLoggedIn()) {
      window.checkFavoriteStatus(songId).then(isFav => {
        if (isFav) {
          el.classList.add("is-favorite");
          el.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>';
        }
      });
    }
  });

  container.querySelectorAll(".playlist-song-row").forEach(el => {
    el.addEventListener("click", () => openSongModal(el.getAttribute("data-id")));
  });
  updatePlayButtonsUI();
}

function togglePlaylistsVisibility() {
  // 🆕 (T031): ลบ playlist-wrapper ออกจากหน้าแรกแล้ว — ย้ายไป #playlistsView
  //   ตอนนี้ playlists แสดงใน #playlistsView (full page) แทน dropdown section
  //   ฟังก์ชันนี้ยังเก็บไว้เพื่อ backward compat (caller เดิมยังเรียกอยู่) — แต่ไม่ทำอะไร
  //   การแสดง/ซ่อน #playlistsView จัดการใน setView() แทน
  return;
}

function setView(view) {
  STATE.currentView = view;
  const showCategory = view === "home" || view === "category";
  // แสดง DJ ในหน้า "ทั้งหมด" หรือหน้า DJ เท่านั้น
  // 🔧 แก้ (2026-09-14): ลบ `view === "category"` ออกจากเงื่อนไข showDj
  // - ตามคำสั่งผู้ใช้: เมื่อกดเข้าแท็บ "หมวดหมู่" ให้ซ่อน DJ ออกด้วย
  // - หน้า "หน้าแรก" + category="all" → ยังแสดง DJ เหมือนเดิม
  // - หน้า "DJ" → ยังแสดง DJ เหมือนเดิม
  // - หน้า "หมวดหมู่" → ซ่อน DJ ไม่ว่าจะเลือก category ไหน
  const showDj =
    view === "dj" ||
    (view === "home" && STATE.currentCategory === "all");
  // แท็บ DJ ต้องแสดงเพลงของ DJ ทุกคน หรือเพลงของ DJ ที่เลือก
  const showSongs = view === "home" || view === "category" || view === "dj";

  // ช่องค้นหาอยู่ใน topbar จึงยังแสดงทุกแท็บ
  const categoryChips = document.getElementById("categoryChips");
  const djSection = document.getElementById("djSection");
  if (categoryChips) categoryChips.style.display = showCategory ? "" : "none";
  if (djSection) djSection.style.display = showDj ? "" : "none";

  // 🆕 (T019): ซ่อน/แสดง Hero Banner + Category Showcase ตาม view
  //   - Hero Banner (#heroBanner): แสดงเฉพาะหน้า "home" (เป็น welcome message ของหน้าแรก)
  //   - Category Showcase (#categoryShowcase): แสดงเมื่อ showDj=true (เหมือน djSection)
  //     เหตุผล: category showcase คือทางเลือกแทน chip-row ในการ browse หมวด → แสดงเมื่อ DJ section แสดง
  //   - ไม่กระทบระบบเดิม — ใช้ guard ทุกจุด (ถ้า element ไม่อยู่ → ข้ามเงียบ ๆ)
  const heroBanner = document.getElementById("heroBanner");
  if (heroBanner) heroBanner.style.display = (view === "home") ? "" : "none";
  const categoryShowcase = document.getElementById("categoryShowcase");
  // 🔧 (T064): แสดงการ์ดหมวดหมู่ (#categoryShowcase) เพิ่มในแท็บ "หมวดหมู่" ด้วย
  //   - เดิม: แสดงเฉพาะเมื่อ showDj (หน้าแรก category=all / หน้า DJ) → แท็บ "หมวด" ไม่เห็นการ์ดหมวดเลย
  //   - ใหม่: เข้าแท็บหมวดหมู่ (view=category และยังไม่เลือกหมวด currentCategory=all) → แสดงการ์ดหมวดทั้งหมด
  //   - กดการ์ดเลือกหมวดแล้ว (currentCategory != all) → ยังซ่อนเหมือนเดิม (T023: โฟกัสเพลงของหมวดนั้น)
  //   - ไม่กระทบหน้าอื่น — เงื่อนไขเดิม showDj ยังอยู่ครบ เพียงเพิ่ม OR เฉพาะ view=category
  //
  //   🎨 (T117 2026-10-07 fix): ปรับเงื่อนไขให้ categoryShowcase ยังโชว์อยู่แม้กดเข้าหมวดเฉพาะ
  //     - Owner request: "เวลากดเข้าหมวดหมู่ ให้มันแสดงรายการชื่อหมวดหมู่ทั้งหมดไว้ห้ามซ่อน"
  //     - เดิม: showDj || (view === "category" && STATE.currentCategory === "all")
  //       → กดเข้าหมวดเฉพาะ → currentCategory != all → categoryShowcase ถูกซ่อน
  //     - ใหม่: showDj || view === "category"
  //       → แสดง categoryShowcase ตลอดเวลาที่อยู่แท็บหมวดหมู่ แม้กดเข้าหมวดเฉพาะ
  //     - ผลกระทบระบบเดิม: 0% — หน้าอื่น ๆ (playlist/myorders/promotions) ยังซ่อนอยู่ เพราะ showDj=false และ view!="category"
  const showCategoryShowcase =
    showDj || view === "category";
  if (categoryShowcase) categoryShowcase.style.display = showCategoryShowcase ? "" : "none";

  // 🆕 (T031): แสดง #playlistsView เฉพาะตอน view="playlist"
  //   - ย้ายจาก dropdown section ในหน้าแรก มาเป็น full page view
  //   - ซ่อนตอนอยู่หน้าอื่น ๆ (home/category/dj/promotions/myorders)
  const playlistsView = document.getElementById("playlistsView");
  if (playlistsView) playlistsView.style.display = (view === "playlist") ? "block" : "none";

  // แท็บเพลย์ลิสต์และ DJ ซ่อนรายการเพลงทั้งหมด ส่วนหมวดหมู่ยังดูเพลงที่กรองได้
  // หมายเหตุ (แก้บั๊ก 2026-09-13): เอา "#emptyState" ออกจาก loop นี้ เพราะเดิมมันไป
  // set display="" ทับค่าที่ renderSongGrid() เพิ่งเซ็ตไว้ถูกต้อง (none ตอนมีเพลง)
  // ทำให้กล่อง "ไม่พบเพลงที่ค้นหา" โผล่ค้างอยู่ใต้รายการเพลงเสมอ ไม่ว่าจะมีผลลัพธ์หรือไม่
  ["#gridTitle", "#songGrid"].forEach(selector => {
    const el = document.querySelector(selector);
    if (el) el.style.display = showSongs ? "" : "none";
  });
  // 🛡️ (T007 hardening): ซ่อน/แสดง songGridSentinel + songListSentinel ตาม showSongs
  //   เหตุผล: sentinel ทั้ง 2 ตัวเป็น siblings ของ #songGrid — เมื่อ #songGrid ถูกซ่อน (playlist tab)
  //   → หน้าสั้นลง → sentinel เข้าใกล้ viewport → observer ยิง loadMoreSongs/renderNextBatch โดยไม่จำเป็น
  //   → ประหยัด API calls + กัน DOM nodes สะสมใน #songGrid ที่ซ่อนอยู่
  //   เมื่อกลับหน้า home/category/dj (showSongs=true) → restore display="" ให้ observer ทำงานได้ปกติ
  ["#songGridSentinel", "#songListSentinel"].forEach(selector => {
    const el = document.querySelector(selector);
    if (el) el.style.display = showSongs ? "" : "none";
  });

  // ให้ renderSongGrid() เป็นคนเดียวที่ตัดสินใจแสดง/ซ่อน emptyState เสมอ
  // (ถ้าไม่ได้อยู่หน้าที่โชว์เพลง ก็ซ่อน emptyState ไปด้วยตรงๆ)
  if (showSongs) {
    renderSongGrid();
  } else {
    const emptyStateEl = document.getElementById("emptyState");
    if (emptyStateEl) emptyStateEl.style.display = "none";
  }

  togglePlaylistsVisibility();

  if (view === "playlist") {
    const container = document.getElementById("playlistsContainer");
    const icon = document.getElementById("dropdownIcon");
    if (container) container.classList.remove("is-closed");
    if (icon) icon.classList.remove("is-closed");
  }
}

function findSong(id) { return STATE.songs.find(s => s.id === id); }

function unlockAudio() {
  if (audioUnlocked) return;
  AUDIO.play().catch(() => {});
  AUDIO.pause();
  audioUnlocked = true;
}

function playIconPath() { return '<path d="M8 5v14l11-7z"/>'; }
function stopIconPath() { return '<rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/>'; }

function setPlayerIcon(playing) {
  const iconEl = document.getElementById("playerIcon");
  if (iconEl) iconEl.innerHTML = playing ? stopIconPath() : playIconPath();
}

function setPlayerLoading(loading) {
  const iconEl = document.getElementById("playerIcon");
  const spinnerEl = document.getElementById("playerSpinner");

  if (iconEl) iconEl.style.display = loading ? "none" : "block";
  if (spinnerEl) spinnerEl.style.display = loading ? "block" : "none";
}

function updatePlayButtonsUI() {
  const playingId = (!AUDIO.paused && !STATE.currentLoadingId) ? STATE.currentPlayingId : null;
  const loadingId = STATE.currentLoadingId;

  document.querySelectorAll(".play-btn[data-play], .playlist-play-btn[data-play]").forEach(btn => {
    const id = btn.getAttribute("data-play");
    let svg = btn.querySelector("svg");
    let spinner = btn.querySelector(".mini-play-spinner");

    if (!spinner) {
      spinner = document.createElement("div");
      spinner.className = "spinner mini-play-spinner";
      btn.appendChild(spinner);
    }

    if (id === loadingId) {
      if (svg) svg.style.display = "none";
      spinner.style.display = "block";
    } else {
      spinner.style.display = "none";
      if (svg) {
        svg.style.display = "block";
        svg.innerHTML = id === playingId ? stopIconPath() : playIconPath();
      }
    }
  });

  const modalBtn = document.getElementById("modalPlayBtn");
  const modalIcon = document.getElementById("modalPlayIcon");
  const modalSpinner = document.getElementById("modalPlaySpinner");
  const modalLabel = document.getElementById("modalPlayLabel");
  if (modalBtn && modalIcon) {
    const modalId = modalBtn.getAttribute("data-play");
    if (modalId && modalId === loadingId) {
      modalIcon.style.display = "none";
      if (modalSpinner) modalSpinner.style.display = "block";
      if (modalLabel) modalLabel.textContent = "กำลังโหลด...";
    } else {
      if (modalSpinner) modalSpinner.style.display = "none";
      modalIcon.style.display = "block";
      const isPlaying = modalId && modalId === playingId;
      modalIcon.innerHTML = isPlaying ? stopIconPath() : playIconPath();
      if (modalLabel) modalLabel.textContent = isPlaying ? "หยุดเพลง" : "ฟังเพลง";
    }
  }

  setPlayerIcon(playingId !== null);
  setPlayerLoading(loadingId !== null);
}

function playSong(songId) {
  const song = findSong(songId);
  if (!song || !song.file_url) { showToast("ไม่พบไฟล์เพลง", "error"); return; }

  if (STATE.currentPlayingId === songId && !STATE.currentLoadingId && AUDIO.src) {
    if (AUDIO.paused) {
      AUDIO.play().then(updatePlayButtonsUI).catch(() => {});
    } else {
      AUDIO.pause();
    }
    updatePlayButtonsUI();
    return;
  }

  AUDIO.pause();
  STATE.currentPlayingId = songId;
  STATE.currentLoadingId = songId;
  // 🔧 (2026-09-21 fix Bug #3 playSong race condition): เพิ่ม playToken guard
  //   ปัญหา: กดเปลี่ยนเพลงระหว่างที่เพลงเดิมกำลังโหลด → AUDIO.src เปลี่ยน →
  //   เพลงเดิมถูก abort → .catch() ทำงาน → showToast ผิด + ล้าง state ของเพลงใหม่
  //   วิธีแก้: ใช้ playToken pattern (เหมือน _seekToken ที่มีอยู้แล้ว)
  //   - สร้าง token ใหม่ทุกครั้งที่เริ่ม playSong
  //   - ใน .then() และ .catch() เช็คว่า token ยังตรงกับปัจจุบันหรือไม่
  //   - ถ้าไม่ตรง → เพลงนี้ถูก abort แล้ว → ไม่ทำอะไร (silent)
  //   ผลกระทบระบบเดิม: 0% — ถ้าไม่มี race → token ตรง → ทำงานเหมือนเดิม
  const _playToken = (STATE._playTokenCounter = (STATE._playTokenCounter || 0) + 1);

  // Auto Preview: ถ้าเพลงนี้วิเคราะห์ไว้แล้ว (preview_status === "ok") ให้เล่น/ล็อกเฉพาะช่วง Preview เท่านั้น
  // ไฟล์ที่ Cloudinary ยังเป็นไฟล์เต็มเหมือนเดิม แค่จำกัดช่วงเล่นตรงนี้ฝั่ง user เท่านั้น
  // เพลงเก่าที่ยังไม่มีข้อมูล Preview จะเล่นเต็มไฟล์แบบเดิมทุกประการ (fallback ปลอดภัย ไม่พังของเดิม)
  STATE.currentPreview =
    song.preview_status === "ok" && song.preview_start_sec != null && song.preview_end_sec != null
      ? { start: Number(song.preview_start_sec), end: Number(song.preview_end_sec) }
      : null;
  updatePlayButtonsUI();

  const coverEl = document.getElementById("playerCover");
  const titleEl = document.getElementById("playerTitle");
  const subEl = document.getElementById("playerSub");
  const barEl = document.getElementById("playerBar");
  const currTimeEl = document.getElementById("playerCurrentTime");
  const durTimeEl = document.getElementById("playerDuration");
  const seekEl = document.getElementById("playerSeek");

  if (coverEl) coverEl.src = song.cover_url || "default-song-cover.svg";
  if (titleEl) titleEl.textContent = song.song_name;
  if (subEl) subEl.textContent = song.dj_name || song.artist || "";
  if (barEl) barEl.classList.add("show");
  if (currTimeEl) currTimeEl.textContent = "0:00";
  if (durTimeEl) durTimeEl.textContent = "0:00";
  if (seekEl) seekEl.value = 0;

  AUDIO.src = song.file_url;
  AUDIO.load();
  AUDIO.play().then(() => {
    // 🔧 (2026-09-21 fix Bug #3): เช็ค playToken — ถ้าไม่ตรง → เพลงนี้ถูก abort แล้ว → ไม่ทำอะไร
    if (_playToken !== STATE._playTokenCounter) return;
    STATE.currentLoadingId = null;
    updatePlayButtonsUI();
  }).catch(() => {
    // 🔧 (2026-09-21 fix Bug #3): เช็ค playToken ก่อน showToast + ล้าง state
    //   ถ้าไม่ตรง → เพลงนี้ถูก abort โดยการกดเปลี่ยนเพลงใหม่ → ไม่แสดง toast (silent)
    //   ถ้าตรง → เป็น play fail จริง → แสดง toast + ล้าง state (เหมือนเดิม)
    if (_playToken !== STATE._playTokenCounter) return;
    showToast("แตะปุ่มเล่นที่แถบด้านล่างอีกครั้ง");
    STATE.currentLoadingId = null;
    // 🔧 แก้บั๊ก (2026-09-17) Bug #8: ล้าง currentPlayingId ด้วยเมื่อ play fail
    // -----------------------------------------------------------
    // ปัญหาก่อนแก้: เมื่อ browser block play (เช่น autoplay policy ของ Chrome/Safari)
    //   โค้ดล้างแค่ currentLoadingId แต่ไม่ล้าง currentPlayingId
    //   → ครั้งถัดไปที่คลิก play ของเพลงเดิม → เข้าเส้นทาง toggle แทนโหลดใหม่
    //   แต่ AUDIO.paused = true (เพราะ play fail) → toggle สั่ง AUDIO.play() ที่อาจ fail อีก
    //   → ลูกค้าเห็นปุ่มเป็น "หยุดเพลง" ทั้งที่จริง ๆ เสียงไม่ได้เล่น
    //
    // วิธีแก้: ล้าง currentPlayingId ด้วย → ปุ่มจะกลับเป็น "ฟังเพลง"
    //   ลูกค้ากดปุ่มอีกครั้ง → จะโหลดเพลงใหม่แทน toggle (ที่ถูกต้อง)
    //
    // ผลกระทบต่อระบบเดิม: 0%
    //   - ถ้า play สำเร็จ → then block ทำงาน (ไม่ถูกแตะ) — ปกติเหมือนเดิม
    //   - ถ้า play fail → ปุ่มจะกลับเป็น "ฟังเพลง" แทน "หยุดเพลง" (ที่ถูกต้อง)
    STATE.currentPlayingId = null;
    updatePlayButtonsUI();
  });
}

const playerToggleBtn = document.getElementById("playerToggle");
if (playerToggleBtn) {
  playerToggleBtn.addEventListener("click", () => {
    unlockAudio();
    if (!AUDIO.src) return;
    if (AUDIO.paused) { AUDIO.play().then(updatePlayButtonsUI).catch(() => {}); } else { AUDIO.pause(); }
    updatePlayButtonsUI();
  });
}

// 🔧 เพิ่มใหม่ (2026-09-12): ปุ่มปิดเครื่องเล่นเพลง (X) — ให้ลูกค้ากดปิด popup player ได้
// ทำงาน: หยุดเล่นเพลง + ซ่อน player bar + รีเซ็ตปุ่ม play ทุกตัวกลับเป็นสถานะ "ไม่ได้เล่น"
const playerCloseBtn = document.getElementById("playerClose");
if (playerCloseBtn) {
  playerCloseBtn.addEventListener("click", () => {
    try { AUDIO.pause(); } catch (_) {}
    try { AUDIO.removeAttribute("src"); } catch (_) {}
    try { AUDIO.load(); } catch (_) {}
    STATE.currentPlayingId = null;
    STATE.currentLoadingId = null;
    const barEl = document.getElementById("playerBar");
    if (barEl) barEl.classList.remove("show");
    updatePlayButtonsUI();
  });
}

// 🆕 (T100 2026-10-06): คลิกที่ปก/ชื่อเพลงใน player bar → เปิด modal รายละเอียดเพลง
//   Owner request: เวลาลูกค้าเปิดฟังเพลง → player bar ข้างล่างขึ้น → กดที่ player bar
//   → แสดง popup รายละเอียดเพลง (เดียวกับตอนกดที่แถวเพลง)
//   วิธี: เพิ่ม click handler ให้ #playerCover + .player-meta → openSongModal(STATE.currentPlayingId)
//   ไม่กระทบ: #playerToggle (play/pause) + #playerClose (close) + #playerSeek (seek) — มี handler ของตัวเอง
//   ผลกระทบระบบเดิม: 0% — เพิ่ม handler ใหม่ ไม่แตะ handler เดิม
{
  const playerCover = document.getElementById("playerCover");
  const playerMeta = document.querySelector(".player-meta");
  const openModalFromPlayer = () => {
    if (STATE.currentPlayingId) {
      openSongModal(STATE.currentPlayingId);
    }
  };
  // ใส่ cursor:pointer ให้รู้ว่าคลิกได้
  if (playerCover) {
    playerCover.style.cursor = "pointer";
    playerCover.addEventListener("click", openModalFromPlayer);
  }
  if (playerMeta) {
    playerMeta.style.cursor = "pointer";
    playerMeta.addEventListener("click", openModalFromPlayer);
  }
}

let isSeeking = false;
const seekEl = document.getElementById("playerSeek");

AUDIO.addEventListener("loadedmetadata", () => {
  const durTimeEl = document.getElementById("playerDuration");
  const preview = STATE.currentPreview;
  if (preview) {
    // จำกัด seek bar ให้อยู่แค่ช่วง Preview เท่านั้น — user ลากไปฟังส่วนอื่นของเพลงไม่ได้
    if (seekEl) { seekEl.min = preview.start; seekEl.max = preview.end; }
    if (durTimeEl) durTimeEl.textContent = formatTime(preview.end - preview.start);
    AUDIO.currentTime = preview.start; // กระโดดไปเริ่มที่ (Dance − 24 ห้อง) ทันที
  } else {
    if (seekEl) { seekEl.min = 0; seekEl.max = AUDIO.duration || 0; }
    if (durTimeEl) durTimeEl.textContent = formatTime(AUDIO.duration);
  }
  // ===== เพิ่มใหม่: sync seek bar ของ popup ด้วย (ถ้า popup เปิดอยู่) =====
  // ไม่กระทบโค้ดเดิมด้านบน — เพียงแค่อัปเดต UI ของ popup เพิ่มเติม
  updateModalSeekUI();
});

AUDIO.addEventListener("timeupdate", () => {
  if (isSeeking) return;
  const preview = STATE.currentPreview;
  const currTimeEl = document.getElementById("playerCurrentTime");

  if (preview && AUDIO.currentTime >= preview.end) {
    // ถึงท้ายห้องที่ 16 ของ Dance แล้ว — หยุดเล่นทันที ไม่ให้เล่นต่อไปยังส่วนอื่นของเพลงเต็ม
    AUDIO.pause();
    AUDIO.currentTime = preview.start;
    if (currTimeEl) currTimeEl.textContent = formatTime(0);
    if (seekEl) seekEl.value = preview.start;
    STATE.currentPlayingId = null;
    updatePlayButtonsUI();
    return;
  }

  if (currTimeEl) currTimeEl.textContent = formatTime(preview ? AUDIO.currentTime - preview.start : AUDIO.currentTime);
  if (seekEl) seekEl.value = AUDIO.currentTime;

  // ===== เพิ่มใหม่: sync seek bar + jump highlight ของ popup ด้วย =====
  // อัปเดตเฉพาะเมื่อ popup เปิดอยู่ (ฟังก์ชันจะ check เองด้านใน)
  updateModalSeekUI();

  // อัปเดต highlight ของปุ่มกระโดดตามตำแหน่งปัจจุบัน — เหมือนฝั่ง admin
  const backdrop = document.getElementById("songModalBackdrop");
  if (backdrop && backdrop.classList.contains("show")) {
    const t = AUDIO.currentTime;
    if (preview) {
      if (t >= preview.start && t < preview.end) setModalJumpActive("preview");
      else if (t < preview.start) setModalJumpActive("intro");
      else setModalJumpActive("outro");
    } else {
      const dur = AUDIO.duration || 0;
      if (t < dur * 0.7) setModalJumpActive("intro");
      else setModalJumpActive("outro");
    }
  }
});

if (seekEl) {
  seekEl.addEventListener("input", () => {
    isSeeking = true;
    const preview = STATE.currentPreview;
    const currTimeEl = document.getElementById("playerCurrentTime");
    const shown = preview ? Number(seekEl.value) - preview.start : Number(seekEl.value);
    if (currTimeEl) currTimeEl.textContent = formatTime(shown);
  });
  seekEl.addEventListener("change", () => {
    const preview = STATE.currentPreview;
    let target = Number(seekEl.value);
    // กันเหนียวอีกชั้น เผื่อ input ช่วง min/max ถูกเลี่ยงมา (เช่น คีย์บอร์ดบางรุ่น) — clamp ให้อยู่ในช่วง Preview เสมอ
    if (preview) target = Math.min(preview.end, Math.max(preview.start, target));
    AUDIO.currentTime = target;
    isSeeking = false;
  });
}

AUDIO.addEventListener("error", () => {
  showToast("เกิดข้อผิดพลาดในการโหลดไฟล์เพลง", "error");
  STATE.currentLoadingId = null;
  STATE.currentPlayingId = null;
  updatePlayButtonsUI();
});

AUDIO.addEventListener("ended", () => { STATE.currentPlayingId = null; updatePlayButtonsUI(); if (seekEl) seekEl.value = 0; });
AUDIO.addEventListener("pause", updatePlayButtonsUI);
AUDIO.addEventListener("play", updatePlayButtonsUI);
AUDIO.addEventListener("waiting", () => { STATE.currentLoadingId = STATE.currentPlayingId; updatePlayButtonsUI(); });
AUDIO.addEventListener("playing", () => { STATE.currentLoadingId = null; updatePlayButtonsUI(); });

// 🆕 (Feature #4 → T097 2026-10-06): renderRecommendSongs — แสดงเพลงแนะนำ
//   Algorithm ใหม่ (ตาม owner request):
//   1. Priority 1: เพลงใน playlist เดียวกัน → แสดงทั้งหมด (ไม่จำกัด 8)
//      - มี 4 → แสดง 4, มี 5 → แสดง 5, มี 10 → แสดง 10 (ไม่ slice)
//   2. Priority 2-4 (max 8): ถ้าไม่มี playlist → ใช้ chain DJ > หมวด > สุ่ม
//      - DJ เดียวกัน → เพิ่มจนครบ 8
//      - หมวดเดียวกัน → เติมถ้ายังไม่ครบ 4
//      - สุ่ม → เติมถ้ายังไม่ครบ 4
//   ถ้าไม่มีเพลงแนะนำเลย → ซ่อน section
function renderRecommendSongs(currentSong) {
  const section = document.getElementById("modalRecommendSection");
  const grid = document.getElementById("modalRecommendGrid");
  if (!section || !grid || !currentSong) {
    if (section) section.style.display = "none";
    return;
  }
  let recommend = [];

  // 🆕 (T097): Priority 1 — เพลงใน playlist เดียวกัน (แสดงทั้งหมด ไม่จำกัด 8)
  //   ถ้าเพลงปัจจุบันมี playlist_id → หาเพลงอื่นใน playlist เดียวกันทั้งหมด
  //   ผลกระทบ: ถ้า playlist มี 10 เพลง → แสดง 10 (ไม่ slice ที่ 8)
  if (currentSong.playlist_id) {
    const playlistSongs = STATE.songs.filter(s =>
      s.id !== currentSong.id &&
      s.playlist_id === currentSong.playlist_id &&
      s.status !== "hidden"
    );
    if (playlistSongs.length > 0) {
      recommend = playlistSongs;  // ✅ ไม่ slice — แสดงทั้งหมดตาม owner request
    }
  }

  // 🆕 (T097): Priority 2-4 (max 8) — ถ้าไม่มี playlist หรือ playlist ไม่มีเพลงอื่น
  //   ใช้ chain เดิม: DJ > หมวด > สุ่ม (max 8)
  if (recommend.length === 0) {
    // Priority 2: DJ เดียวกัน (max 8)
    if (currentSong.dj_name) {
      recommend = STATE.songs.filter(s =>
        s.id !== currentSong.id &&
        s.dj_name === currentSong.dj_name &&
        s.status !== "hidden"
      ).slice(0, 8);
    }
    // Priority 3: หมวดเดียวกัน (เติมถ้ายังไม่ครบ 4)
    if (recommend.length < 4 && currentSong.category_id) {
      const catRecommend = STATE.songs.filter(s =>
        s.id !== currentSong.id &&
        !recommend.find(r => r.id === s.id) &&
        s.category_id === currentSong.category_id &&
        s.status !== "hidden"
      ).slice(0, 8 - recommend.length);
      recommend = recommend.concat(catRecommend);
    }
    // Priority 4: สุ่ม (เติมถ้ายังไม่ครบ 4)
    if (recommend.length < 4) {
      const others = STATE.songs.filter(s =>
        s.id !== currentSong.id &&
        !recommend.find(r => r.id === s.id) &&
        s.status !== "hidden"
      ).slice(0, 8 - recommend.length);
      recommend = recommend.concat(others);
    }
  }

  // ถ้าไม่มีเพลงแนะนำเลย → ซ่อน section
  if (recommend.length === 0) {
    section.style.display = "none";
    return;
  }
  // render
  section.style.display = "block";
  grid.innerHTML = recommend.map(s => `
    <div class="recommend-card" data-recommend-id="${escapeHtml(s.id)}" role="button" tabindex="0" aria-label="เปิดเพลง ${escapeHtml(s.song_name || '')}">
      <img class="recommend-card-cover" src="${escapeHtml(s.cover_url || 'default-song-cover.svg')}" alt="${escapeHtml(s.song_name || 'เพลง')}" loading="lazy">
      <div class="recommend-card-name">${escapeHtml(s.song_name || 'ไม่มีชื่อ')}</div>
      <div class="recommend-card-price">${formatPrice(s.price)}</div>
    </div>
  `).join("");
  // bind click — กดแล้วเปิดเพลงนั้น (เปลี่ยน modal ไปเพลงใหม่)
  grid.querySelectorAll(".recommend-card").forEach(card => {
    card.addEventListener("click", () => {
      const id = card.getAttribute("data-recommend-id");
      if (id) openSongModal(id);
    });
    // keyboard support
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        card.click();
      }
    });
  });
}

function openSongModal(songId) {
  const song = findSong(songId);
  if (!song) return;

  // 🔧 แก้บั๊ก (2026-09-17): Modal seek/jump กระทบเพลงผิด
  //   เก็บ ID ของเพลงที่ modal เปิดอยู่ปัจจุบัน — ใช้ใน updateModalSeekUI และปุ่ม jump
  //   ถ้า modalCurrentSongId !== STATE.currentPlayingId → modal เปิดอยู่ที่เพลงอื่น
  //   ที่ไม่ใช่เพลงที่กำลังเล่น → ห้ามกระทบ AUDIO ของเพลงที่เล่นอยู่
  modalCurrentSongId = songId;

  const coverEl = document.getElementById("modalCover");
  const nameEl = document.getElementById("modalName");
  const artistEl = document.getElementById("modalArtist");
  const djEl = document.getElementById("modalDj");
  const descEl = document.getElementById("modalDesc");
  const priceEl = document.getElementById("modalPrice");
  const badgesEl = document.getElementById("modalBadges");
  const metaLineEl = document.getElementById("modalMetaLine");
  const modalBtn = document.getElementById("modalPlayBtn");
  const buyBtn = document.getElementById("modalBuyBtn");
  const buyLabelEl = document.getElementById("modalBuyLabel");
  const backdropEl = document.getElementById("songModalBackdrop");
  const seekEl = document.getElementById("modalSeek");
  const currTimeEl = document.getElementById("modalCurrTime");
  const durTimeEl = document.getElementById("modalDurTime");

  if (coverEl) coverEl.src = song.cover_url || "default-song-cover.svg";
  if (nameEl) nameEl.textContent = song.song_name;
  if (artistEl) artistEl.textContent = song.artist || "";

  // DJ — เก็บไว้ใน badge ด้วยเหมือนฝั่ง admin (เดิมแสดงบรรทัด DJ: ... คงไว้ตามโครงเดิม)
  if (djEl) djEl.textContent = song.dj_name ? "🎧 DJ: " + song.dj_name : "";

  // badges — เหมือนฝั่ง admin: DJ / หมวดหมู่ / เพลย์ลิสต์ (ถ้ามีข้อมูล)
  if (badgesEl) {
    const badges = [];
    if (song.dj_name) badges.push(`<span class="badge dj">🎧 ${escapeHtml(song.dj_name)}</span>`);
    if (song.category_name) badges.push(`<span class="badge cat">🗂️ ${escapeHtml(song.category_name)}</span>`);
    if (song.playlist_name) badges.push(`<span class="badge pl">🎶 ${escapeHtml(song.playlist_name)}</span>`);
    badgesEl.innerHTML = badges.join("");
  }

  if (descEl) descEl.textContent = song.description || "";
  // แสดงราคาปกติ + ราคาลด (ถ้ามี discount active) — ใช้ innerHTML เพื่อให้แสดง <s> + <strong> ได้
  if (priceEl) {
    const original = Number(song.price) || 0;
    const discount = findActiveDiscountFor({ targetType: "song", targetId: song.id, discounts: STATE.discounts });
    if (discount) {
      const { finalPrice, hasDiscount } = applyDiscountToPrice(original, discount);
      if (hasDiscount) {
        priceEl.innerHTML = `<span class="price-original">${formatPrice(original)}</span> <span class="price-discounted large">${formatPrice(finalPrice)}</span>`;
      } else {
        priceEl.textContent = formatPrice(original);
      }
    } else {
      priceEl.textContent = formatPrice(original);
    }
  }

  // meta line: แสดงข้อมูล preview ถ้ามี (เหมือนฝั่ง admin)
  // ใช้ STATE.currentPreview ของเพลงนี้ — คำนวณตามเงื่อนไขเดียวกับ playSong()
  const songPreview =
    song.preview_status === "ok" && song.preview_start_sec != null && song.preview_end_sec != null
      ? { start: Number(song.preview_start_sec), end: Number(song.preview_end_sec) }
      : null;
  if (metaLineEl) {
    if (songPreview) {
      const bars = (song.preview_start_bar != null && song.preview_end_bar != null)
        ? ` · ห้อง ${song.preview_start_bar}–${song.preview_end_bar}` : "";
      metaLineEl.innerHTML = `🎯 เล่นช่วงตัวอย่าง ${formatTime(songPreview.start)}–${formatTime(songPreview.end)}${bars}`;
    } else {
      metaLineEl.innerHTML = `เล่นเต็มไฟล์ (เพลงนี้ยังไม่ได้วิเคราะห์ช่วง Preview)`;
    }
  }

  // reset seek bar ของ popup — ค่าจริงจะอัปเดตตอน loadedmetadata ของเพลงที่เล่น
  if (seekEl) { seekEl.value = 0; seekEl.min = 0; seekEl.max = 0; }
  if (currTimeEl) currTimeEl.textContent = "0:00";
  if (durTimeEl) durTimeEl.textContent = "0:00";

  // reset ปุ่มกระโดด — ไม่ active จนกว่าจะเริ่มเล่น
  setModalJumpActive(null);

  if (modalBtn) {
    modalBtn.setAttribute("data-play", songId);
    modalBtn.onclick = () => { unlockAudio(); playSong(songId); };
  }

  // ปุ่มเพิ่มเข้าตะกร้า — ใช้ addToCart เดิม ไม่เปลี่ยนระบบ cart
  // เปลี่ยนเฉพาะข้อความ label ให้เป็น "เพิ่มเข้าตะกร้า" + แสดงราคาในวงเล็บ
  if (buyBtn) {
    if (buyLabelEl) buyLabelEl.textContent = `เพิ่มเข้าตะกร้า · ${getDiscountedPriceForSongLabel(song)}`;
    buyBtn.setAttribute("aria-label", `เพิ่ม ${song.song_name} ลงตะกร้า`);
    buyBtn.onclick = () => {
      addToCart(song);
    };
  }
  updatePlayButtonsUI();
  if (backdropEl) backdropEl.classList.add("show");

  // 🆕 (Feature #4): แสดงเพลงแนะนำ — เพลงอื่นของ DJ เดียวกัน + หมวดเดียวกัน
  //   - ทำหลังเปิด modal เพื่อให้ user เห็นเพลงแนะนำทันที
  //   - ไม่กระทบระบบเดิม — ถ้า fail ข้ามไปเงียบ ๆ (defensive)
  try { renderRecommendSongs(song); } catch (err) { console.warn("[Feature #4] renderRecommendSongs failed:", err?.message || err); }

  // 🆕 (T020): โหลดรีวิวของเพลงนี้ (summary + ล่าสุด 5 รายการ + form state)
  //   - ทำหลังเปิด modal เพื่อให้ user เห็นรีวิวทันที
  //   - ไม่กระทบระบบเดิม — ถ้า fail ข้ามไปเงียบ ๆ (defensive)
  try { loadSongReviews(songId); } catch (err) { console.warn("[T020] loadSongReviews failed:", err?.message || err); }
}

// ============================================================
// 🆕 (T020): Song reviews — ลูกค้ารีวิวเพลง (ดาว 1-5 + ความเห็น)
//   - loadSongReviews(songId)        — โหลด summary + ล่าสุด 5 รายการ + เช็ค login state
//   - renderReviewsList(reviews)     — วาดรายการรีวิว (ส่งแค่ display_name + is_mine เพื่อ privacy)
//   - renderReviewSummary(summary)   — วาดคะแนนเฉลี่ย + จำนวนรีวิว
//   - setupReviewHandlers()          — ผูก click handlers (ดาว + submit + delete + login)
//   ผลกระทบระบบเดิม: 0% — เพิ่มใหม่ ไม่แตะ like/favorite/cart/checkout
// ============================================================
let currentReviewRating = 0;        // ดาวที่เลือกในฟอร์มปัจจุบัน (1-5, 0 = ยังไม่เลือก)
let currentSongIdForReview = null;  // song_id ของเพลงที่ modal เปิดอยู่ (ใช้ตอน submit/delete)
let userExistingReviewLoaded = false; // flag กันโหลดซ้ำ — รีเซ็ตทุกครั้งที่เปิด modal

async function loadSongReviews(songId) {
  currentSongIdForReview = songId;
  currentReviewRating = 0; // reset ดาวที่เลือก (รีเซ็ตทุกครั้งที่เปิด modal ใหม่)
  userExistingReviewLoaded = false;

  // โหลด summary + reviews พร้อมกัน (ล่าสุด 5 รายการ)
  const [summaryRes, reviewsRes] = await Promise.all([
    fetch(`/api/songs/${encodeURIComponent(songId)}/reviews/summary`, { credentials: "same-origin" }).catch(() => null),
    fetch(`/api/songs/${encodeURIComponent(songId)}/reviews?limit=5`, { credentials: "same-origin" }).catch(() => null),
  ]);

  // Render summary
  if (summaryRes && summaryRes.ok) {
    try {
      const data = await summaryRes.json();
      renderReviewSummary(data.summary || {});
    } catch (_) { /* ข้ามไปเงียบ ๆ */ }
  } else {
    renderReviewSummary(null);
  }

  // Render reviews list
  let reviews = [];
  if (reviewsRes && reviewsRes.ok) {
    try {
      const data = await reviewsRes.json();
      reviews = data.reviews || [];
    } catch (_) { /* ข้ามไปเงียบ ๆ */ }
  }
  renderReviewsList(reviews);

  // เช็ค login state → แสดง form หรือ login prompt
  const isLoggedIn = window.isCustomerLoggedIn && window.isCustomerLoggedIn();
  const formEl = document.getElementById("modalReviewForm");
  const loginPromptEl = document.getElementById("modalReviewLoginPrompt");
  if (formEl) formEl.style.display = isLoggedIn ? "block" : "none";
  if (loginPromptEl) loginPromptEl.style.display = isLoggedIn ? "none" : "block";

  // ถ้า login → หารีวิวของ user คนนี้ (ถ้ามี) เพื่อ pre-fill form + แสดงปุ่มลบ
  if (isLoggedIn) {
    const myReview = reviews.find(r => r.is_mine === true);
    if (myReview) {
      prefillReviewForm(myReview);
      userExistingReviewLoaded = true;
    } else {
      resetReviewForm();
    }
  } else {
    resetReviewForm();
  }
}

function renderReviewSummary(summary) {
  const summaryEl = document.getElementById("modalReviewSummary");
  if (!summaryEl) return;
  if (!summary || summary.count === 0) {
    summaryEl.innerHTML = '<span class="review-summary-empty">ยังไม่มีรีวิว</span>';
    return;
  }
  // 🆕 (T021): แสดง SVG stars + ตัวเลขเฉลี่ย + จำนวนรีวิว
  const avg = Math.round(summary.avg_rating || 0);
  const starSvg = (filled) => `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" class="${filled ? 'star-filled' : 'star-empty'}"><path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>`;
  const starsHtml = Array.from({length: 5}, (_, i) => starSvg(i < avg)).join("");
  summaryEl.innerHTML = `
    <span class="review-summary-stars">${starsHtml}</span>
    <span class="review-summary-avg">${escapeHtml(String(summary.avg_rating))}</span>
    <span class="review-summary-count">${escapeHtml(String(summary.count))} รีวิว</span>
  `;
}

function renderReviewsList(reviews) {
  const listEl = document.getElementById("modalReviewsList");
  if (!listEl) return;
  if (!reviews || reviews.length === 0) {
    listEl.innerHTML = '<div class="modal-reviews-empty"><svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor" style="opacity:0.4;margin-bottom:8px;"><path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg><div>ยังไม่มีรีวิว</div><div style="font-size:11px;margin-top:4px;">เป็นคนแรกที่รีวิวเพลงนี้!</div></div>';
    return;
  }
  listEl.innerHTML = reviews.map(r => {
    const initial = escapeHtml(String(r.author_initial || "?"));
    const name = escapeHtml(r.author_name || "ลูกค้า");
    const dateStr = r.created_at ? new Date(r.created_at).toLocaleDateString("th-TH", { day: "numeric", month: "short", year: "numeric" }) : "";
    const rating = Number(r.rating) || 0;
    const comment = r.comment ? escapeHtml(r.comment) : "";
    const mineBadge = r.is_mine ? '<span class="review-mine-badge">ของคุณ</span>' : "";
    // 🆕 (T021): SVG stars แทน emoji
    const starSvg = (filled) => `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" class="${filled ? 'star-filled' : 'star-empty'}"><path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>`;
    const starsHtml = Array.from({length: 5}, (_, i) => starSvg(i < rating)).join("");
    return `
      <div class="review-item${r.is_mine ? " review-item-mine" : ""}">
        <div class="review-item-head">
          <div class="review-avatar" aria-hidden="true">${initial}</div>
          <div class="review-meta">
            <div class="review-author">${name}${mineBadge}</div>
            <div class="review-date">${escapeHtml(dateStr)}</div>
          </div>
          <div class="review-stars" aria-label="${rating} ดาว">${starsHtml}</div>
        </div>
        ${comment ? `<div class="review-comment">${comment}</div>` : ""}
      </div>
    `;
  }).join("");
}

function prefillReviewForm(review) {
  // โหลดรีวิวเดิมของ user มา pre-fill ในฟอร์ม (โหมดแก้ไข)
  currentReviewRating = Number(review.rating) || 0;
  const commentEl = document.getElementById("modalReviewComment");
  if (commentEl) commentEl.value = review.comment || "";
  // อัปเดต UI ของปุ่มดาว
  updateStarButtonsUI();
  // เปลี่ยน label + แสดงปุ่มลบ
  const labelEl = document.getElementById("modalReviewFormLabel");
  if (labelEl) labelEl.textContent = "แก้ไขรีวิวของคุณ";
  const submitBtn = document.getElementById("modalSubmitReviewBtn");
  if (submitBtn) submitBtn.textContent = "บันทึกการแก้ไข";
  const delBtn = document.getElementById("modalDeleteReviewBtn");
  if (delBtn) delBtn.style.display = "inline-block";
  // ล้าง feedback
  setReviewFeedback("", "");
}

function resetReviewForm() {
  currentReviewRating = 0;
  const commentEl = document.getElementById("modalReviewComment");
  if (commentEl) commentEl.value = "";
  updateStarButtonsUI();
  const labelEl = document.getElementById("modalReviewFormLabel");
  if (labelEl) labelEl.textContent = "เพิ่มรีวิวของคุณ";
  const submitBtn = document.getElementById("modalSubmitReviewBtn");
  if (submitBtn) submitBtn.textContent = "ส่งรีวิว";
  const delBtn = document.getElementById("modalDeleteReviewBtn");
  if (delBtn) delBtn.style.display = "none";
  setReviewFeedback("", "");
}

function updateStarButtonsUI() {
  document.querySelectorAll("#modalStarInput .star-btn").forEach(b => {
    const r = parseInt(b.dataset.rating, 10);
    b.classList.toggle("active", r <= currentReviewRating);
    b.setAttribute("aria-checked", r === currentReviewRating ? "true" : "false");
  });
  // 🆕 (T021): อัปเดต label ข้างดาว
  const labelEl = document.getElementById("modalStarLabel");
  if (labelEl) {
    const labels = ["เลือกคะแนน", "แย่", "พอใช้", "ดี", "ดีมาก", "ยอดเยี่ยม"];
    labelEl.textContent = labels[currentReviewRating] || labels[0];
    labelEl.style.color = currentReviewRating > 0 ? "var(--accent)" : "var(--text-dim)";
  }
}

function setReviewFeedback(msg, type) {
  const fb = document.getElementById("modalReviewFeedback");
  if (!fb) return;
  fb.textContent = msg || "";
  fb.className = "modal-review-feedback" + (type ? " " + type : "");
}

function setupReviewHandlers() {
  // 1. Star input — คลิกเลือกดาว 1-5
  document.querySelectorAll("#modalStarInput .star-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      currentReviewRating = parseInt(btn.dataset.rating, 10);
      updateStarButtonsUI();
      setReviewFeedback("", "");
    });
    // 🆕 (T021): Hover preview ใช้ CSS class แทน emoji
    btn.addEventListener("mouseenter", () => {
      const hoverRating = parseInt(btn.dataset.rating, 10);
      document.querySelectorAll("#modalStarInput .star-btn").forEach(b => {
        const r = parseInt(b.dataset.rating, 10);
        b.classList.toggle("hover-active", r <= hoverRating);
      });
      // อัปเดต label ชั่วคราว
      const labelEl = document.getElementById("modalStarLabel");
      if (labelEl) {
        const labels = ["เลือกคะนน", "แย่", "พอใช้", "ดี", "ดีมาก", "ยอดเยี่ยม"];
        labelEl.textContent = labels[hoverRating] || labels[0];
      }
    });
  });
  // reset hover preview เมื่อออกจากกลุ่มดาว
  const starInputEl = document.getElementById("modalStarInput");
  if (starInputEl) {
    starInputEl.addEventListener("mouseleave", () => {
      document.querySelectorAll("#modalStarInput .star-btn").forEach(b => b.classList.remove("hover-active"));
      updateStarButtonsUI();
    });
  }

  // 🆕 (T021): Char count สำหรับ textarea
  const commentEl = document.getElementById("modalReviewComment");
  if (commentEl) {
    commentEl.addEventListener("input", () => {
      const countEl = document.getElementById("modalReviewCharCount");
      if (countEl) {
        const len = commentEl.value.length;
        countEl.textContent = len;
        countEl.style.color = len > 450 ? "var(--danger)" : "var(--text-dim)";
      }
    });
  }

  // 2. Submit — ส่งรีวิว (สร้างใหม่ หรือ แก้ไข ผ่าน upsert)
  document.getElementById("modalSubmitReviewBtn")?.addEventListener("click", async () => {
    if (!currentSongIdForReview) return;
    if (currentReviewRating < 1) {
      setReviewFeedback("กรุณาเลือกคะแนน", "error");
      return;
    }
    const comment = document.getElementById("modalReviewComment")?.value?.trim() || "";
    const btn = document.getElementById("modalSubmitReviewBtn");
    if (btn) { btn.disabled = true; btn.textContent = "กำลังส่ง..."; }
    setReviewFeedback("", "");
    try {
      const res = await fetch(`/api/songs/${encodeURIComponent(currentSongIdForReview)}/reviews`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ rating: currentReviewRating, comment }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || "ส่งรีวิวไม่สำเร็จ");
      if (typeof showToast === "function") showToast("✅ ส่งรีวิวแล้ว", "success");
      // reload summary + reviews รีเฟรช
      await loadSongReviews(currentSongIdForReview);
    } catch (err) {
      setReviewFeedback(err.message || "ส่งรีวิวไม่สำเร็จ", "error");
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = userExistingReviewLoaded ? "บันทึกการแก้ไข" : "ส่งรีวิว"; }
    }
  });

  // 3. Delete — ลบรีวิวของตัวเอง
  document.getElementById("modalDeleteReviewBtn")?.addEventListener("click", async () => {
    if (!currentSongIdForReview) return;
    if (!confirm("ต้องการลบรีวิวนี้ใช่ไหม?")) return;
    const btn = document.getElementById("modalDeleteReviewBtn");
    if (btn) { btn.disabled = true; btn.textContent = "กำลังลบ..."; }
    setReviewFeedback("", "");
    try {
      const res = await fetch(`/api/songs/${encodeURIComponent(currentSongIdForReview)}/reviews`, {
        method: "DELETE",
        credentials: "same-origin",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || "ลบรีวิวไม่สำเร็จ");
      if (typeof showToast === "function") showToast("🗑️ ลบรีวิวแล้ว", "success");
      await loadSongReviews(currentSongIdForReview);
    } catch (err) {
      setReviewFeedback(err.message || "ลบรีวิวไม่สำเร็จ", "error");
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "ลบรีวิว"; }
    }
  });

  // 4. Login prompt — ถ้ายังไม่ login → เปิด customer auth modal
  document.getElementById("modalReviewLoginBtn")?.addEventListener("click", () => {
    if (typeof window.openCustomerAuthModal === "function") {
      window.openCustomerAuthModal();
    }
  });

  // 5. Re-sync เมื่อ login state เปลี่ยน (หลัง login สำเร็จ → โหลดรีวิวใหม่เพื่อแสดง form)
  //   ใช้ event จาก customer-auth.js (ถ้ามี) หรือ custom event 'customer-auth-changed'
  window.addEventListener("customer-auth-changed", () => {
    if (currentSongIdForReview) {
      loadSongReviews(currentSongIdForReview);
    }
  });
}

// ===== เพิ่มใหม่: helper สำหรับ popup ใหม่ — เหมือนฝั่ง admin (ไม่แตะระบบเดิม) =====
// state สำหรับ seek bar ภายใน popup
let modalIsSeeking = false;
// 🔧 แก้บั๊ก (2026-09-17): Modal seek/jump กระทบเพลงผิด
// -----------------------------------------------------------
// อาการก่อนแก้: ลูกค้าเปิด modal เพลง B ระหว่างเพลง A กำลังเล่น → seek bar และปุ่ม jump
//   (ต้นเพลง/Dance/ท้ายเพลง) ใน modal B จะกระทบเพลง A ที่กำลังเล่น ไม่ใช่เพลง B ที่ดูอยู่
//
// สาเหตุ: openSongModal() ไม่ได้เก็บ ID ของเพลงที่ modal เปิดอยู่ → updateModalSeekUI()
//   และปุ่ม jump ทั้ง 3 ใช้ STATE.currentPlayingId/STATE.currentPreview ของเพลงที่กำลังเล่น
//   โดยไม่เช็คว่าตรงกับเพลงใน modal ไหม
//
// วิธีแก้: เพิ่ม modalCurrentSongId เก็บ ID ของเพลงที่ modal เปิดอยู่ปัจจุบัน
//   - ใน updateModalSeekUI: ถ้าไม่ตรงกับเพลงที่เล่น → reset seek bar เป็น 0:00/0:00
//   - ในปุ่ม jump ทั้ง 3: ถ้าไม่ตรง → เริ่มเล่นเพลงใน modal แทน + seek ไปจุดที่ต้องการ
//   - ใน modalSeek change: ถ้าไม่ตรง → ไม่ seek (กันกระทบเพลงที่กำลังเล่น)
//
// ผลกระทบต่อระบบเดิม: 0% — เปลี่ยนเฉพาะ modal UI flow ไม่แตะระบบอื่น
let modalCurrentSongId = null;

// ไอคอนเล่น/หยุดของปุ่มใน popup (ใช้ SVG เดียวกับของเดิม)
function modalPlayIconSvg() { return '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"></path></svg>'; }
function modalStopIconSvg() { return '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14"></rect><rect x="14" y="5" width="4" height="14"></rect></svg>'; }

// ตั้ง active ของปุ่มกระโดดช่วง — เหมือน setDetailJumpActive ฝั่ง admin
function setModalJumpActive(section) {
  ["modalJumpToIntro", "modalJumpToPreview", "modalJumpToOutro"].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.toggle("active", id === {
      intro: "modalJumpToIntro",
      preview: "modalJumpToPreview",
      outro: "modalJumpToOutro"
    }[section]);
  });
}

// อัปเดต seek bar ของ popup ตามสถานะ AUDIO ปัจจุบัน (เหมือน updateDetailSeekUI ฝั่ง admin)
function updateModalSeekUI() {
  const seekEl = document.getElementById("modalSeek");
  const currEl = document.getElementById("modalCurrTime");
  const durEl = document.getElementById("modalDurTime");
  if (!seekEl) return;
  // อัปเดตเฉพาะเมื่อ popup เปิดอยู่ (ประหยัด CPU)
  const backdrop = document.getElementById("songModalBackdrop");
  if (!backdrop || !backdrop.classList.contains("show")) return;

  // 🔧 แก้บั๊ก (2026-09-17): ถ้าเพลงใน modal ไม่ใช่เพลงที่กำลังเล่น → reset seek bar
  //   กัน seek bar แสดงเวลาของเพลงอื่นที่กำลังเล่นอยู่ (เช่น เปิด modal B ระหว่างเพลง A เล่น)
  //   แสดง 0:00/0:00 แทน เพื่อบอกผู้ใช้ว่า "เพลงนี้ยังไม่ได้เล่น" อย่างชัดเจน
  if (modalCurrentSongId !== STATE.currentPlayingId) {
    seekEl.min = 0;
    seekEl.max = 0;
    seekEl.value = 0;
    if (currEl) currEl.textContent = "0:00";
    if (durEl) durEl.textContent = "0:00";
    return;
  }

  const preview = STATE.currentPreview;
  if (preview) {
    seekEl.min = preview.start;
    seekEl.max = preview.end;
    if (!modalIsSeeking) seekEl.value = AUDIO.currentTime;
    if (currEl) currEl.textContent = formatTime(Math.max(0, AUDIO.currentTime - preview.start));
    if (durEl) durEl.textContent = formatTime(preview.end - preview.start);
  } else {
    seekEl.min = 0;
    seekEl.max = AUDIO.duration || 0;
    if (!modalIsSeeking) seekEl.value = AUDIO.currentTime;
    if (currEl) currEl.textContent = formatTime(AUDIO.currentTime);
    if (durEl) durEl.textContent = formatTime(AUDIO.duration || 0);
  }
}

// ===== เพิ่มใหม่: event listeners สำหรับ popup ใหม่ — เหมือนฝั่ง admin =====
// ปุ่มกระโดดช่วงเพลง (3 ปุ่ม) — เหมือน jumpToIntro / jumpToPreview / jumpToOutro ฝั่ง admin
// ใช้ AUDIO ตัวเดิมของฝั่ง user — ไม่สร้าง Audio ใหม่

// 🔧 แก้บั๊ก (2026-09-17): helper สำหรับ "เล่นเพลงใน modal + seek ไปจุดที่ต้องการ"
// -----------------------------------------------------------
// ใช้เมื่อผู้ใช้กดปุ่ม jump ใน modal ที่ไม่ใช่เพลงที่กำลังเล่นอยู่
//   เช่น เปิด modal B ระหว่างเพลง A เล่น → กด "Dance" → ต้องเริ่มเล่นเพลง B แล้ว seek ไป Dance
//
// flow:
//   1. playSong(songId) โหลดเพลงใหม่ (AUDIO.src ถูกเปลี่ยน)
//   2. รอ loadedmetadata event (AUDIO.duration พร้อมใช้)
//   3. ตั้ง AUDIO.currentTime = targetSec (seek ไปจุดที่ต้องการ)
//   4. ตั้ง setModalJumpActive(section) เพื่อ highlight ปุ่มที่กด
//
// ⚠️ ถ้า targetSec เป็น null/undefined → ไม่ seek (ใช้ตอน "ต้นเพลง" ที่เริ่มจาก 0 อยู่แล้ว)
//
// 🔧 แก้บั๊ก C4 (2026-09-18): listener leak + stale seek race condition
// -----------------------------------------------------------
// ปัญหาก่อนแก้:
//   1. ถ้า playSong() fail (autoplay block) → loadedmetadata ไม่ fire → listener ติดค้างตลอด
//   2. ถ้า user กด jump 2 ครั้งรวด → เพิ่ม listener 2 ตัว → fire พร้อมกัน → seek ผิดพลาด
//   3. ถ้า user เปิด modal B แล้วรีบเปิด modal C → listener เก่า fire พร้อม pendingSeek ของเพลงเก่า
//
// วิธีแก้: ใช้ seekToken (ตัวนับเพิ่มทีละ 1) เพื่อ track ว่า listener ตัวไหนเป็นปัจจุบัน
//   - ทุกครั้งที่เรียก playSongAndSeekTo → เพิ่ม seekToken + เก็บ token ของ call นี้
//   - ใน listener → เช็คว่า token ยังตรงกับปัจจุบันไหม
//   - ถ้าไม่ตรง → ไม่ seek (เพราะมี call ใหม่กว่า → listener เก่า)
//   - ถ้า playSong fail → ล้าง listener ทันทีเพื่อกัน leak
let _seekToken = 0;
function playSongAndSeekTo(songId, targetSec, section) {
  const song = findSong(songId);
  if (!song || !song.file_url) {
    showToast("ไม่พบไฟล์เพลง", "error");
    return;
  }

  // กรณีเพลงที่จะเล่น = เพลงที่กำลังเล่นอยู่แล้ว → ไม่ต้องโหลดใหม่ แค่ seek
  if (STATE.currentPlayingId === songId && AUDIO.src) {
    if (targetSec != null && isFinite(targetSec) && targetSec >= 0) {
      try { AUDIO.currentTime = targetSec; } catch (e) {}
    }
    if (section) setModalJumpActive(section);
    if (AUDIO.paused) AUDIO.play().then(updatePlayButtonsUI).catch(() => {});
    return;
  }

  // กรณีต้องโหลดเพลงใหม่ → ตั้ง pendingSeek ไว้รอ loadedmetadata
  const pendingSeek = (targetSec != null && isFinite(targetSec) && targetSec >= 0) ? targetSec : null;
  // 🔧 แก้บั๊ก C4: เพิ่ม seekToken ทุกครั้ง → call เก่าที่มี token ต่ำกว่าจะถูก ignore ใน listener
  _seekToken += 1;
  const myToken = _seekToken;

  const onLoadedMetadata = () => {
    // 🔧 แก้บั๊ก C4: เช็ค token ก่อน seek — ถ้าไม่ตรง = call ใหม่กว่ามาแล้ว → ไม่ seek (กัน stale seek)
    if (myToken !== _seekToken) return;
    AUDIO.removeEventListener("loadedmetadata", onLoadedMetadata);
    if (pendingSeek != null) {
      try { AUDIO.currentTime = pendingSeek; } catch (e) {}
    }
    if (section) setModalJumpActive(section);
  };
  AUDIO.addEventListener("loadedmetadata", onLoadedMetadata);

  // 🔧 แก้บั๊ก C4: ถ้า playSong fail (เช่น autoplay block) → ล้าง listener ทันทีเพื่อกัน leak
  //   ใช้ setTimeout(0) เพื่อให้ playSong() ทำงานก่อน → แล้วค่อยเช็คว่า currentPlayingId เปลี่ยนไหม
  //   ถ้า currentPlayingId ไม่ตรงกับ songId → playSong fail → ล้าง listener
  //   ถ้า currentPlayingId === songId → playSong สำเร็จ → listener จะถูกล้างเองตอน loadedmetadata fire
  setTimeout(() => {
    if (myToken !== _seekToken) return; // call ใหม่กว่ามาแล้ว → ไม่ต้องทำอะไร
    if (STATE.currentPlayingId !== songId) {
      // playSong fail → ล้าง listener กัน leak
      AUDIO.removeEventListener("loadedmetadata", onLoadedMetadata);
    }
  }, 0);

  // เริ่มเล่นเพลงใหม่ (playSong จะตั้ง STATE.currentPlayingId/preview)
  playSong(songId);
}

// 🟢 (Audit Fix L-6): null check ก่อน addEventListener — กัน TypeError ถ้า element ไม่มี
const _modalJumpIntro = document.getElementById("modalJumpToIntro");
if (_modalJumpIntro) _modalJumpIntro.addEventListener("click", () => {
  // 🔧 แก้บั๊ก (2026-09-17): ถ้า modal เปิดอยู่ที่เพลงอื่น → เริ่มเล่นเพลงใน modal แทน
  if (modalCurrentSongId !== STATE.currentPlayingId) {
    // 🔧 แก้บั๊ก I1 (2026-09-18): เดิมส่ง null → per-call listener ไม่ seek
    //   → permanent listener (บรรทัด 777) ชนะ → seek ไป preview.start แทน 0:00
    //   แก้: ส่ง 0 แทน null → per-call listener จะ seek ไป 0 ทับ permanent listener
    //   (เพราะ per-call listener ลงทะเบียนหลัง → ทำงานทีหลัง → override ค่าสุดท้าย)
    playSongAndSeekTo(modalCurrentSongId, 0, "intro");
    return;
  }
  // กรณี modal เปิดอยู่ที่เพลงที่กำลังเล่น — โค้ดเดิม
  if (!STATE.currentPlayingId) {
    showToast("กดปุ่ม ฟังเพลง ก่อน เพื่อเริ่มเล่น", "info");
    return;
  }
  setModalJumpActive("intro");
  AUDIO.currentTime = 0; // ต้นเพลง = วินาที 0 เสมอ
  if (AUDIO.paused) {
    AUDIO.play().then(updatePlayButtonsUI).catch(() => {});
  }
});

// 🟢 (Audit Fix L-6): null check
const _modalJumpPreview = document.getElementById("modalJumpToPreview");
if (_modalJumpPreview) _modalJumpPreview.addEventListener("click", () => {
  // 🔧 แก้บั๊ก (2026-09-17): ถ้า modal เปิดอยู่ที่เพลงอื่น → เริ่มเล่นเพลงใน modal แทน + seek
  if (modalCurrentSongId !== STATE.currentPlayingId) {
    const song = findSong(modalCurrentSongId);
    const preview = song && song.preview_status === "ok" && song.preview_start_sec != null && song.preview_end_sec != null
      ? { start: Number(song.preview_start_sec), end: Number(song.preview_end_sec) }
      : null;
    if (!preview) {
      showToast("เพลงนี้ยังไม่ได้วิเคราะห์ช่วง Preview — เริ่มเล่นจากต้นแทน", "info");
      playSongAndSeekTo(modalCurrentSongId, null, "intro");
      return;
    }
    playSongAndSeekTo(modalCurrentSongId, preview.start, "preview");
    return;
  }
  // กรณี modal เปิดอยู่ที่เพลงที่กำลังเล่น — โค้ดเดิม
  const preview = STATE.currentPreview;
  if (!preview) {
    showToast("เพลงนี้ยังไม่ได้วิเคราะห์ช่วง Preview — กระโดดไปช่วงต้นแทน", "info");
    document.getElementById("modalJumpToIntro").click();
    return;
  }
  if (!STATE.currentPlayingId) {
    showToast("กดปุ่ม ฟังเพลง ก่อน เพื่อเริ่มเล่น", "info");
    return;
  }
  setModalJumpActive("preview");
  AUDIO.currentTime = preview.start; // กระโดดไปยังจุดเริ่มช่วง Dance/Preview
  if (AUDIO.paused) {
    AUDIO.play().then(updatePlayButtonsUI).catch(() => {});
  }
});

// 🟢 (Audit Fix L-6): null check
const _modalJumpOutro = document.getElementById("modalJumpToOutro");
if (_modalJumpOutro) _modalJumpOutro.addEventListener("click", () => {
  // 🔧 แก้บั๊ก (2026-09-17): ถ้า modal เปิดอยู่ที่เพลงอื่น → เริ่มเล่นเพลงใน modal แทน + seek
  if (modalCurrentSongId !== STATE.currentPlayingId) {
    const song = findSong(modalCurrentSongId);
    const preview = song && song.preview_status === "ok" && song.preview_start_sec != null && song.preview_end_sec != null
      ? { start: Number(song.preview_start_sec), end: Number(song.preview_end_sec) }
      : null;
    // ท้ายเพลง = (preview.end + 30s) หรือ (dur - 15) ถ้าไม่มี preview — เหมือนฝั่ง admin
    //   แต่ตอนนี้ยังไม่รู้ duration เพราะยังไม่ได้โหลด → ใช้ค่าประมาณ: preview.end + 30 หรือ 0 (รอ loadedmetadata)
    const outroTarget = preview ? preview.end + 30 : 0;
    playSongAndSeekTo(modalCurrentSongId, outroTarget >= 0 ? outroTarget : null, "outro");
    return;
  }
  // กรณี modal เปิดอยู่ที่เพลงที่กำลังเล่น — โค้ดเดิม
  if (!STATE.currentPlayingId) {
    showToast("กดปุ่ม ฟังเพลง ก่อน เพื่อเริ่มเล่น", "info");
    return;
  }
  const preview = STATE.currentPreview;
  const dur = AUDIO.duration || 0;
  // ท้ายเพลง = (preview.end + 30s) หรือ (dur - 15) ถ้าไม่มี preview — เหมือนฝั่ง admin
  const outroTarget = preview
    ? Math.min(dur - 5, preview.end + 30)
    : Math.max(0, dur - 15);
  if (isFinite(outroTarget) && outroTarget >= 0) {
    try { AUDIO.currentTime = outroTarget; } catch (e) {}
  }
  setModalJumpActive("outro");
  if (AUDIO.paused) {
    AUDIO.play().then(updatePlayButtonsUI).catch(() => {});
  }
});

// Seek bar ของ popup — เหมือน detailSeekEl ฝั่ง admin
const modalSeekEl = document.getElementById("modalSeek");
if (modalSeekEl) {
  modalSeekEl.addEventListener("input", () => {
    modalIsSeeking = true;
    const preview = STATE.currentPreview;
    const currEl = document.getElementById("modalCurrTime");
    const shown = preview ? Number(modalSeekEl.value) - preview.start : Number(modalSeekEl.value);
    if (currEl) currEl.textContent = formatTime(shown);
  });
  modalSeekEl.addEventListener("change", () => {
    // 🔧 แก้บั๊ก (2026-09-17): ถ้า modal เปิดอยู่ที่เพลงอื่น → ไม่ seek
    //   กันลาก seek bar ใน modal B แล้วกระทบเพลง A ที่กำลังเล่นอยู่
    //   (seek bar ควรจะถูก reset เป็น 0:00/0:00 โดย updateModalSeekUI อยู่แล้ว)
    if (modalCurrentSongId !== STATE.currentPlayingId) {
      modalIsSeeking = false;
      return;
    }
    const preview = STATE.currentPreview;
    let target = Number(modalSeekEl.value);
    // clamp ให้อยู่ในช่วง preview (เหมือนฝั่ง admin)
    if (preview) target = Math.min(preview.end, Math.max(preview.start, target));
    AUDIO.currentTime = target;
    modalIsSeeking = false;
  });
}

const modalCloseBtn = document.getElementById("songModalClose");
const backdropEl = document.getElementById("songModalBackdrop");
// 🔧 (2026-09-22 Batch 7 fix Bug #12 part 2): Modal scroll lock
//   เดิม: modal เปิด → background ยัง scroll ได้ → iOS modal เด้งตาม scroll → UX แย่
//   ใหม่: เปิด modal → body.modal-open (CSS overflow:hidden) → background ล็อค scroll
//         ปิด modal → ลบ class → กลับมา scroll ได้
if (modalCloseBtn) modalCloseBtn.addEventListener("click", () => {
  if (backdropEl) backdropEl.classList.remove("show");
  document.body.classList.remove("modal-open");
});
if (backdropEl) backdropEl.addEventListener("click", (e) => {
  if (e.target === e.currentTarget) {
    e.currentTarget.classList.remove("show");
    document.body.classList.remove("modal-open");
  }
});

// 🔧 (2026-09-22 Batch 7 fix Bug #12 part 2): hook openSongModal ให้ lock scroll ตอนเปิด
//   ใช้ MutationObserver เพื่อ detect class "show" ของ backdrop → add/remove body.modal-open
//   (วิธีนี้ไม่ต้องแก้ openSongModal โดยตรง → ลด risk ของระบบเดิม)
if (backdropEl && "MutationObserver" in window) {
  const modalObserver = new MutationObserver(() => {
    if (backdropEl.classList.contains("show")) {
      document.body.classList.add("modal-open");
      // 🆕 (T022): เมื่อเปิด song modal → scroll ไปบนสุดของ modal เสมอ
      //   กันปัญหา modal เปิดแล้วอยู่กลาง/ล่าง → บังรายละเอียดเพลง
      setTimeout(() => {
        const modalEl = backdropEl.querySelector(".modal");
        if (modalEl) modalEl.scrollTop = 0;
      }, 50);
    } else {
      document.body.classList.remove("modal-open");
    }
  });
  modalObserver.observe(backdropEl, { attributes: true, attributeFilter: ["class"] });
}

// 🆕 (T022): ทำให้ปุ่ม close กดได้เสมอ — กันถูกบังด้วย z-index อื่น
//   เพิ่ม re-bind click handler (safety net ถ้า handler เดิมถูก override)
if (modalCloseBtn && !modalCloseBtn.__t022CloseBound) {
  modalCloseBtn.__t022CloseBound = true;
  modalCloseBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (backdropEl) backdropEl.classList.remove("show");
    document.body.classList.remove("modal-open");
  });
}

const searchInputEl = document.getElementById("searchInput");
if (searchInputEl) {
  searchInputEl.addEventListener("input", debounce(async (e) => {
    STATE.search = e.target.value.trim();
    // 🔧 (2026-09-18 v6 perf): เมื่อ user ค้นหา ให้ trigger auto-load-all ใน background
    //   เพราะ pagination โหลดแค่ page 1 (50 เพลง) → search จะไม่เจอเพลงที่ยังไม่โหลด
    //   วิธีแก้: เมื่อ user พิมพ์คำค้น → โหลด pages ที่เหลือทั้งหมดใน background (CDN cache hit → เร็วมาก)
    //   แล้วค่อย re-render → เห็นผลค้นหาทุกเพลงทั้งหมด
    if (STATE.search && STATE.songsHasMore) {
      showToast("กำลังค้นหาในทุกเพลง...", "progress");
      // โหลดทุก page ที่เหลือใน background (async — ไม่ block UI)
      loadAllRemainingSongs().then(() => {
        // หลังโหลดเสร็จ → re-render เพื่อแสดงผลค้นหาใหม่
        // showToast จะ auto-hide เองหลังจาก 2-3 วินาที (ไม่ต้อง hideToast manual)
        renderSongGrid();
        renderPlaylists();
        togglePlaylistsVisibility();
      });
    }
    renderSongGrid();
    renderPlaylists(); // อัปเดตการแสดงผลเพลย์ลิสต์ตามคำค้นหาด้วย
    togglePlaylistsVisibility();
  }, 250));

  // ดักจับการกดปุ่ม Enter หรือกดปุ่ม Go บนมือถือเพื่อซ่อนแป้นพิมพ์
  searchInputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      searchInputEl.blur();
    }
  });
}

// 🔧 (2026-09-22): เลื่อนหน้าขึ้นบนสุด — รองรับโหมดล็อกแถบเบราว์เซอร์
//   หน้าร้าน (html.store-page) ให้ <body> เป็นตัวเลื่อน จึงใช้ window.scrollTo ไม่ได้
//   ถ้าไม่ใช่โหมดนี้ → fallback ไปใช้ window.scrollTo เหมือนเดิมทุกประการ
function scrollPageToTop() {
  const useBodyScroll = document.documentElement.classList.contains("store-page")
    && typeof document.body.scrollTo === "function";
  if (useBodyScroll) {
    document.body.scrollTo({ top: 0, behavior: "smooth" });
  } else {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
}

// 🆕 (T009-F2): global click handler สำหรับปุ่ม "ไปเลือกเพลง" ใน empty state
//   - ปิด cart popup / account view / my-orders view / promotions view ที่อาจเปิดอยู่
//   - คลิกปุ่ม home tab เพื่อกลับไปหน้าแรก
//   ลงทะเวชเป็น document-level listener เพื่อให้รองรับปุ่มที่ถูก inject ตอนหลังได้
document.addEventListener("click", (event) => {
  const btn = event.target.closest("[data-empty-goto-home]");
  if (!btn) return;
  // 1. ปิด cart popup ถ้าเปิดอยู่
  const cartBackdrop = document.getElementById("cartBackdrop");
  if (cartBackdrop && cartBackdrop.classList.contains("show")) {
    cartBackdrop.classList.remove("show");
    cartBackdrop.setAttribute("aria-hidden", "true");
  }
  // 2. ปิด account view / my-orders view / promotions view ถ้าเปิดอยู่ (เรียก helper ถ้ามี)
  try {
    if (typeof window.hideCustomerAccountView === "function") window.hideCustomerAccountView();
    if (typeof window.hideMyOrdersView === "function") window.hideMyOrdersView();
    if (typeof hidePromotionsView === "function") hidePromotionsView();
  } catch (_) {}
  // 3. คลิกปุ่ม home tab เพื่อกลับไปหน้าแรก
  const homeBtn = document.querySelector('.bottom-nav button[data-tab="home"]');
  if (homeBtn) homeBtn.click();
});

// 🆕 (T009-F2): upgrade favorites empty state → cute empty state
//   เนื่องจากกฎห้ามแก้ logic ใน customer-auth.js (ซึ่งเป็นที่ที่ loadCustomerFavorites วาด
//   empty state เดิม) → ใช้ MutationObserver ตรวจจับการเปลี่ยนแปลงของ #myAccountFavoritesList
//   แล้วแทนที่ empty state แบบเดิม (ข้อความเปล่า ๆ) ด้วย empty-state-cute (icon + title + desc + CTA)
//   ทำงานทุกครั้งที่ favorites list ถูก re-render — กด tab / หลัง toggleFavorite refresh / หลัง login
function _upgradeFavoritesEmptyState() {
  const wrap = document.getElementById("myAccountFavoritesList");
  if (!wrap) return;
  // ตรวจเฉพาะกรณี "empty" — มี element ลูก 1 ตัว (customer-auth.js เขียน empty state เป็น <div> อันเดียว)
  if (wrap.children.length !== 1) return;
  const first = wrap.firstElementChild;
  if (!first) return;
  // ข้ามาถ้าเป็น empty-state-cute อยู่แล้ว
  if (first.classList && first.classList.contains("empty-state-cute")) return;
  // ตรวจข้อความ — ต้องมีคำว่า "ยังไม่มีเพลงโปรด" (ตรงกับที่ customer-auth.js เขียน)
  const text = (first.textContent || "").trim();
  if (!text.includes("ยังไม่มีเพลงบันทึก")) return;
  first.outerHTML = `
    <div class="empty-state-cute">
      <div class="empty-icon">🔖</div>
      <div class="empty-title">ยังไม่มีบันทึกซื้อทีหลัง</div>
      <div class="empty-desc">กด 🔖 ในเพลงที่ชอบ — จะเก็บไว้ที่นี่</div>
      <button class="btn empty-cta" type="button" data-empty-goto-home>🎵 ไปเลือกเพลง</button>
    </div>`;
}

// ลงทะเวช MutationObserver ทันทีที่ element พร้อม (DOM ถูก parse หมดแล้วเพราะ module load ทีหลัง)
(() => {
  const wrap = document.getElementById("myAccountFavoritesList");
  if (!wrap) return;
  try {
    const observer = new MutationObserver(() => _upgradeFavoritesEmptyState());
    observer.observe(wrap, { childList: true });
    _upgradeFavoritesEmptyState(); // initial check (ถ้า empty state โผล่ก่อน observer ติด)
  } catch (err) {
    console.warn("[T009-F2] favorites MutationObserver setup failed:", err?.message || err);
  }
})();

document.querySelectorAll(".bottom-nav button").forEach(btn => {
  btn.addEventListener("click", () => {
    const tab = btn.getAttribute("data-tab");
    document.querySelectorAll(".bottom-nav button").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    // 🎁 (2026-09-20) เพิ่มใหม่: ซ่อน promotionsView ทุกครั้งที่กดแท็บใด ๆ
    //   เพื่อให้แน่ใจว่า view โปรโมชั่นจะถูกซ่อนเสมอเมื่อเปลี่ยนไปแท็บอื่น
    //   ไม่กระทบ branch เดิม — เพียงเรียกฟังก์ชัน hidePromotionsView() ที่เช็ค element เอง (ปลอดภัย)
    hidePromotionsView();
    hideCustomerAccountView(); // 🔧 (2026-10-02 fix2): กัน overlay บัญชีของฉันค้างทับหน้าอื่น
    hideGuestOrdersLoginBanner(); // 🆕 (2026-10-03 team-fix): ลบแบนเนอร์เชิญ login ออกเมื่อออกจาก tab ออเดอร์
    // 🆕 (T016): stop polling เมื่อออกจาก tab ออเดอร์ — กิน D1 quota น้อย
    //   - เรียกทุกครั้งก่อนเข้า branch ของแต่ละ tab (รวม tab ออเดอร์เอง — startOrdersPolling กัน double-start)
    //   - ใช้ typeof check กัน ReferenceError ถ้า app-promotion.js ยังโหลดไม่เสร็จ
    if (typeof window.stopOrdersPolling === "function") window.stopOrdersPolling();
    if (tab === "home") {
      hideMyOrdersView();
      cleanupMyOrdersView();
      STATE.currentCategory = "all";
      STATE.currentDj = null;
      // 🆕 (T009-F1): ถ้า songs ยังไม่โหลด (edge case — user กด tab ก่อน init เสร็จ)
      //   → แสดง skeleton ก่อน เพื่อกันจอว่าง ๆ พอ loadMoreSongs เสร็จ → renderSongGrid จะแทนที่
      if (!Array.isArray(STATE.songs) || STATE.songs.length === 0) renderSongSkeleton(12);
      setView("home");
      renderCategoryChips();
      renderDjRow(); // 🎧 (2026-09-20) re-render DJ row เพื่อลบ class selected (วงกลมแดง) หลังออกจากหน้า DJ
      renderSongGrid();
      renderPlaylists();
      renderPromotionBanner(); // 🎁 (2026-09-20) เพิ่มใหม่: แสดงแบนเนอร์โปรโมชั่นใหม่ (เผื่อถูกซ่อนตอนอยู่แท็บอื่น)
      scrollPageToTop();
    }
    else if (tab === "playlist") {
      hideMyOrdersView();
      cleanupMyOrdersView();
      setView("playlist");
      renderPlaylists();
      scrollPageToTop();
    }
    else if (tab === "category") {
      hideMyOrdersView();
      cleanupMyOrdersView();
      STATE.currentCategory = "all";
      STATE.currentDj = null;
      // 🆕 (T009-F1): skeleton ตอน songs ยังไม่โหลด (เหมือน branch home ด้านบน)
      if (!Array.isArray(STATE.songs) || STATE.songs.length === 0) renderSongSkeleton(12);
      setView("category");
      renderCategoryGrid(); // 🔧 (T064): วาดการ์ดหมวดหมู่ทุกครั้งที่เข้าแท็บ — อัปเดตจำนวนเพลงล่าสุด (setView แสดง showcase ให้แล้ว)
      renderCategoryChips();
      renderDjRow(); // 🎧 (2026-09-20) re-render DJ row เพื่อลบ class selected (วงกลมแดง) หลังออกจากหน้า DJ
      renderSongGrid();
      renderPlaylists();
      scrollPageToTop();
    }
    else if (tab === "dj") {
      hideMyOrdersView();
      cleanupMyOrdersView();
      STATE.currentCategory = "all";
      STATE.currentDj = null;
      // 🆕 (T009-F1): skeleton ตอน songs ยังไม่โหลด (เหมือน branch home ด้านบน)
      if (!Array.isArray(STATE.songs) || STATE.songs.length === 0) renderSongSkeleton(12);
      setView("dj");
      renderDjRow();
      renderSongGrid();
      scrollPageToTop();
    }
    else if (tab === "myorders") {
      // ===== 🆕 (2026-10-03 team-fix): tab "ออเดอร์ของฉัน" — จุดเข้าเดียวที่ชัดเจน =====
      //   - ถ้า login แล้ว → เปิด #myAccountView (โปรไฟล์ + ออเดอร์ + โปรด + ตั้งค่า)
      //   - ถ้ายังไม่ login → เปิด #myOrdersView (ค้นหาด้วยชื่อ+เบอร์) พร้อมแบนเนอร์เชิญเข้าสู่ระบบ
      //   - ก่อนหน้านี้ไม่มี tab นี้ใน HTML ทำให้ลูกค้าไม่รู้จะไปดูออเดอร์ที่ไหน
      hidePromotionsView();
      let loggedInCustomer = null;
      try { loggedInCustomer = JSON.parse(localStorage.getItem("miusic_customer_session") || "null"); } catch (_) {}
      if (loggedInCustomer) {
        // ซ่อน guest lookup view ถ้าเปิดอยู่
        hideMyOrdersView();
        cleanupMyOrdersView();
        showCustomerAccountView();
        // 🆕 (T016): start polling — หน่วง 1 วิ ให้ showCustomerAccountView ทำงานก่อน
        //   - ใช้ setTimeout เพราะ showCustomerAccountView เป็น async (โหลด orders จาก server)
        //   - ถ้า user ออกจาก tab ก่อน 1 วิ → startOrdersPolling จะไม่ทำงาน (stop ถูกเรียกที่ท็อป)
        //   - แต่ถ้า user ยังอยู่ → polling เริ่ม + แสดงแถบ "อัตโนมัติ · ล่าสุด: HH:MM:SS"
        if (typeof window.startOrdersPolling === "function") {
          setTimeout(() => {
            // re-check ตอน fire — กันกรณี user ออกจาก tab ไปแล้ว
            if (typeof window.startOrdersPolling === "function") {
              try { window.startOrdersPolling(); } catch (e) { console.warn("[T016] start polling failed:", e?.message || e); }
            }
          }, 1000);
        }
      } else {
        // ซ่อน account view ถ้าเปิดอยู่
        hideCustomerAccountView();
        showMyOrdersView();
        initMyOrdersView();
        // 🆕 (2026-10-03 team-fix): แสดงแบนเนอร์เชิญเข้าสู่ระบบ (ลูกค้า guest จะได้รู้ว่ามีทางเลือก)
        showGuestOrdersLoginBanner();
        // 🆕 (T016): start polling ถ้ามี name+phone แล้ว (guest เคยค้นหาแล้ว) — หน่วง 1.5 วิ
        //   - ถ้ายังไม่มี name+phone → รอจนกว่าจะกด "ดูออเดอร์ของฉัน" (handleSearchMyOrders)
        //   - ที่ไม่ start ใน handleSearchMyOrders: กันซับซ้อน — start ที่นี่ + polling interval จะเช็ค name+phone เอง
        //   - polling interval มี guard `if (!customerName || !customerWhatsapp) return` อยู่แล้ว
        if (typeof window.startOrdersPolling === "function") {
          setTimeout(() => {
            if (window.MY_ORDERS_STATE && window.MY_ORDERS_STATE.customerName && window.MY_ORDERS_STATE.customerWhatsapp) {
              try { window.startOrdersPolling(); } catch (e) { console.warn("[T016] start polling failed:", e?.message || e); }
            }
          }, 1500);
        }
        scrollPageToTop();
      }
    }
    else if (tab === "promotions") {
      // 🎁 (2026-09-20) เพิ่มใหม่: tab "โปรโมชั่น" — หน้าพรีวิวโปรโมชั่นทั้งหมดที่ active
      //   - ไม่แตะ branch เดิม ใช้ showPromotionsView()/hidePromotionsView() แยกต่างหาก
      //   - เรียก renderPromotionsView() เพื่อวาดการ์ดโปรโมชั่น + countdown
      //   - ซ่อน view อื่น ๆ ที่อาจเปิดอยู่ (myOrdersView, myAccountView)
      hideMyOrdersView();
      cleanupMyOrdersView();
      hideCustomerAccountView();
      showPromotionsView();
      scrollPageToTop();
    }
    // 🆕 (2026-10-03 team-fix): ลบ branch "contact" ออก — ย้ายไปเป็น WhatsApp FAB แล้ว
    //   ถ้ามีโค้ดเก่าเรียก data-tab=contact จะไม่ match ที่นี่ (ไม่พัง เพียงแค่ no-op)
  });
});

// ===== เพิ่มใหม่: ซ่อน/แสดง view "ออเดอร์ของฉัน" + ซ่อน view อื่นๆ =====
function showMyOrdersView() {
  // ซ่อน view อื่นๆ (gridTitle, songGrid, category chips, dj, playlists, emptyState)
  ["#gridTitle", "#songGrid", "#emptyState"].forEach(selector => {
    const el = document.querySelector(selector);
    if (el) el.style.display = "none";
  });
  // 🛡️ (T007 hardening): ซ่อน songGridSentinel + songListSentinel ตอนอยู่ใน view อื่น
  //   เหตุผล: sentinel ทั้ง 2 ตัวเป็น siblings ของ #songGrid — เมื่อ #songGrid ถูกซ่อน หน้าจะสั้นลง
  //   → sentinel เข้าใกล้ viewport → observer ยิง loadMoreSongs/renderNextBatch โดยไม่จำเป็น
  //   → ประหยัด API calls + กัน DOM nodes สะสมใน #songGrid ที่ซ่อนอยู่
  ["#songGridSentinel", "#songListSentinel"].forEach(selector => {
    const el = document.querySelector(selector);
    if (el) el.style.display = "none";
  });
  const categoryChips = document.getElementById("categoryChips");
  const djSection = document.getElementById("djSection");
  if (categoryChips) categoryChips.style.display = "none";
  if (djSection) djSection.style.display = "none";
  // 🆕 (T046): ซ่อน category showcase + hero banner ในหน้า "ออเดอร์ของฉัน" (เหมือน showPromotionsView)
  //   ผลกระทบระบบเดิม: 0% — เมื่อกลับหน้าแรก setView("home") จะ restore display ให้เอง
  const categoryShowcase = document.getElementById("categoryShowcase");
  if (categoryShowcase) categoryShowcase.style.display = "none";
  const heroBanner = document.getElementById("heroBanner");
  if (heroBanner) heroBanner.style.display = "none";
  // ซ่อน playlists container
  const playlistsContainer = document.getElementById("playlistsContainer");
  if (playlistsContainer) playlistsContainer.classList.add("is-closed");
  // แสดง my orders view
  const myOrdersView = document.getElementById("myOrdersView");
  if (myOrdersView) myOrdersView.style.display = "block";
}
function hideMyOrdersView() {
  const myOrdersView = document.getElementById("myOrdersView");
  if (myOrdersView) myOrdersView.style.display = "none";
}

// ============================================================
// 🆕 (2026-10-01): หน้า "บัญชีของฉัน" สำหรับลูกค้า login แล้ว
//   แสดงข้อมูลบัญชี + ออเดอร์ทั้งหมด (ดึงจาก /api/customer/orders)
//   ไม่แตะระบบเดิม (track order / myOrdersView ด้วย ชื่อ+เบอร์) — ใช้ view ใหม่ #myAccountView
// ============================================================

// 🆕 แสดงหน้าบัญชีของฉัน (ใช้ #myOrdersView เดิม — เหมือนลูกค้าไม่ login)
//   🆕 (2026-10-02): เปลี่ยนจาก myAccountView ใหม่ → ใช้ myOrdersView เดิม
//   - ถ้า login → auto-fill ชื่อ+เบอร์จากบัญชี + ซ่อนฟอร์มกรอก + โหลดออเดอร์ทันที
//   - ใช้ fetchMyOrdersOnce (จาก app-promotion.js) เพื่อดึงออเดอร์
//   - ซ่อนฟอร์มกรอกชื่อ+เบอร์ (เพราะ login แล้วไม่ต้องกรอก)
async function showCustomerAccountView() {
  // ปิด modal อื่น ๆ ก่อน (กันบัง)
  const authBackdrop = document.getElementById("customerAuthBackdrop");
  if (authBackdrop) { authBackdrop.classList.remove("show"); authBackdrop.setAttribute("aria-hidden", "true"); }
  ["songModalBackdrop", "cartBackdrop", "checkoutBackdrop", "trackOrderBackdrop", "receiptBackdrop", "paymentBackdrop", "uploadSlipBackdrop", "confirmBackdrop"].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.classList.remove("show"); el.setAttribute("aria-hidden", "true"); }
  });
  // อ่าน customer จาก localStorage (ไม่พึ่ง customer-auth.js timing)
  let customer = null;
  try {
    const raw = localStorage.getItem("miusic_customer_session");
    if (raw) customer = JSON.parse(raw);
  } catch (_) {}
  if (!customer) {
    // ไม่ login → เปิด track order modal เดิม
    openTrackOrder();
    return;
  }
  // 🔧 (2026-10-02 fix2): เดิมเรียก showMyOrdersView() อย่างเดียว → #myOrdersView เป็น div ว่าง
  //   (เนื้อหาถูกสร้างโดย initMyOrdersView() เท่านั้น) ทำให้หน้าว่าง + grid/chips ถูกซ่อน → ดูเหมือนค้าง
  //   แก้: ใช้ overlay #myAccountView (มี profile + รายการออเดอร์ในตัว) + ดึงจาก /api/customer/orders
  //   ไม่พึ่ง myOrdersView / ชื่อ+เบอร์ → ใช้ได้กับลูกค้าที่สมัครด้วยอีเมลอย่างเดียวด้วย
  const accountView = document.getElementById("myAccountView");
  if (!accountView) { openTrackOrder(); return; }
  accountView.style.display = "block";
  document.body.classList.remove("modal-open");
  accountView.scrollTop = 0;
  try { await loadCustomerAccountData(); } catch (err) { console.error("loadCustomerAccountData error:", err); }
}

// 🆕 ซ่อนหน้าบัญชีของฉัน (ใช้ hideMyOrdersView เดิม + แสดงฟอร์มกลับมา)
function hideCustomerAccountView() {
  const accountView = document.getElementById("myAccountView");
  if (accountView) accountView.style.display = "none";
}

// ============================================================
// 🆕 (2026-10-03 team-fix): showGuestOrdersLoginBanner
//   แสดงแบนเนอร์บน #myOrdersView สำหรับลูกค้าที่ยังไม่ login
//   บอกว่า "ถ้าเข้าสู่ระบบ จะดูออเดอร์ทั้งหมดได้โดยไม่ต้องกรอกชื่อ-เบอร์"
//   + ปุ่ม "เข้าสู่ระบบ" ที่เปิด customer auth modal
//   ผลกระทบระบบเดิม: 0% — เป็นการเพิ่ม element ใหม่ใน #myOrdersView ที่มีอยู่แล้ว
// ============================================================
function showGuestOrdersLoginBanner() {
  const container = document.getElementById("myOrdersView");
  if (!container) return;
  // ถ้าแบนเนอร์มีอยู่แล้ว ไม่ต้องเพิ่มซ้ำ
  if (document.getElementById("guestOrdersLoginBanner")) return;
  const banner = document.createElement("div");
  banner.id = "guestOrdersLoginBanner";
  banner.className = "guest-orders-login-banner";
  banner.innerHTML = `
    <div class="guest-orders-login-banner-icon" aria-hidden="true">👤</div>
    <div class="guest-orders-login-banner-text">
      <strong>เข้าสู่ระบบเพื่อดูออเดอร์ทั้งหมดของคุณ</strong>
      <span>ไม่ต้องกรอกชื่อ-เบอร์ใหม่ทุกครั้ง — login ครั้งเดียว เห็นทุกออเดอร์</span>
    </div>
    <button type="button" class="guest-orders-login-banner-btn" id="guestOrdersLoginBtn">เข้าสู่ระบบ</button>
  `;
  // แทรกแบนเนอร์ไว้ที่ต้น container (ก่อน form)
  container.insertBefore(banner, container.firstChild);
  const loginBtn = document.getElementById("guestOrdersLoginBtn");
  if (loginBtn) {
    loginBtn.addEventListener("click", () => {
      // เปิด customer auth modal (ฟังก์ชันจาก customer-auth.js)
      if (typeof openCustomerAuthModal === "function") {
        openCustomerAuthModal();
      } else {
        // fallback: คลิกปุ่ม login ใน topbar ถ้ามี
        const topbarLoginBtn = document.getElementById("customerLoginBtn");
        if (topbarLoginBtn) topbarLoginBtn.click();
      }
    });
  }
}

// 🆕 (2026-10-03 team-fix): hideGuestOrdersLoginBanner — ลบแบนเนอร์ออกเมื่อ login แล้วหรือเปลี่ยน tab
function hideGuestOrdersLoginBanner() {
  const banner = document.getElementById("guestOrdersLoginBanner");
  if (banner) banner.remove();
}

// ============================================================
// 🆕 (2026-10-03 team-fix): WhatsApp Floating Action Button (FAB)
//   ย้ายจาก tab "ติดต่อ" ใน bottom-nav มาเป็นปุ่มลอยด้านขวาล่าง
//   ทำให้ bottom-nav มีที่ว่างสำหรับ tab "ออเดอร์" ใหม่
//   ผลกระทบระบบเดิม: 0% — เป็นปุ่มใหม่ ไม่แตะ tab "contact" เดิม (ที่ถูกลบออกจาก HTML แล้ว)
// ============================================================
function initWhatsappFab() {
  const fab = document.getElementById("whatsappFab");
  if (!fab) return;
  fab.addEventListener("click", () => {
    const waNumber = STATE?.settings?.whatsapp_number || "";
    if (!waNumber) {
      // ถ้ายังไม่ได้ตั้งค่าเบอร์ WhatsApp → เตือน
      if (typeof showToast === "function") showToast("ยังไม่ได้ตั้งค่าเบอร์ WhatsApp ของร้าน", "error");
      else alert("ยังไม่ได้ตั้งค่าเบอร์ WhatsApp ของร้าน");
      return;
    }
    // 🆕 (T044-D): normalize เบอร์ร้านก่อนสร้าง wa.me URL — กันถ้าแอดมินใส่ "0812345678" โดยไม่มี country code
    //   เดิม: ใช้ raw waNumber → wa.me/0812345678 → WhatsApp ตีความเป็นอเมริกา (+1) → ลูกค้าเปิดแชทผิด
    //   ใหม่: normalize ผ่าน normalizePhoneForStorage-like logic → 85620XXX หรือ 668XXXXXXXXX
    //   sync กับ fallback logic ใน worker/index.js buildAdminNotifyWhatsAppUrl (T044-B)
    let normalizedNum = String(waNumber).replace(/[^0-9]/g, "");
    if (!normalizedNum.startsWith("856") && !normalizedNum.startsWith("66")) {
      if (normalizedNum.startsWith("020")) normalizedNum = "856" + normalizedNum.slice(1);
      else if ((normalizedNum.startsWith("08") || normalizedNum.startsWith("09")) && normalizedNum.length === 10) normalizedNum = "66" + normalizedNum.slice(1);
      else if (normalizedNum.startsWith("20") && normalizedNum.length === 10) normalizedNum = "856" + normalizedNum;
      else if (normalizedNum.startsWith("0") && normalizedNum.length === 10) normalizedNum = "66" + normalizedNum.slice(1);
      else normalizedNum = "856" + normalizedNum; // fallback ลาว (เดิม)
    }
    const url = buildWhatsAppLink(normalizedNum, "สวัสดีครับ/ค่ะ ต้องการสอบถามเกี่ยวกับร้านเพลง");
    window.open(url, "_blank");
  });
}

// ============================================================
// 🆕 (T017): Customer Dashboard — สรุปการซื้อของฉัน
//   - คำนวณทั้งหมดที่ frontend (ประหยัด D1 quota — ไม่ต้องสร้าง backend endpoint ใหม่)
//   - ใช้ข้อมูลจาก customerOrdersPagination.allLoaded (ดึงจาก /api/customer/orders ที่มีอยู่แล้ว)
//   - 4 ส่วน: summary cards + monthly bar chart (6 เดือน) + Top 5 songs + Top 3 DJs
//   - ไม่กระทบระบบเดิม — ถ้า DOM elements ไม่มี (หน้าอื่น) → no-op
// ============================================================

// 🆕 (T017): lookup dj_name จาก STATE.songs โดย song_id (order items ไม่มี dj_name ตอน save)
//   - ใช้ Map เพื่อ performance (O(1) lookup แทน O(n) find ทุกครั้ง)
//   - cache โดยอ้างอิงจาก reference ของ STATE.songs — ถ้า array เปลี่ยน (re-load) → rebuild cache อัตโนมัติ
let _t017_djLookupMap = null;
let _t017_djLookupSongsRef = null;
function _t017_getDjLookupMap() {
  try {
    const songs = (typeof STATE !== "undefined" && Array.isArray(STATE?.songs)) ? STATE.songs : [];
    if (_t017_djLookupMap && _t017_djLookupSongsRef === songs) return _t017_djLookupMap;
    _t017_djLookupMap = new Map();
    _t017_djLookupSongsRef = songs;
    for (const s of songs) {
      const id = String(s?.id || s?.song_id || "");
      const djName = String(s?.dj_name || "").trim();
      if (id && djName) _t017_djLookupMap.set(id, djName);
    }
  } catch (_) {
    _t017_djLookupMap = new Map();
    _t017_djLookupSongsRef = null;
  }
  return _t017_djLookupMap;
}

// 🆕 (Feature #6): loadCustomerDownloads — โหลดเพลงที่ซื้อแล้ว (status=completed) + ลิงก์ดาวน์โหลด
//   ใช้ /api/customer/orders endpoint ที่มีอยู่แล้ว — filter เฉพาะ completed orders
//   แสดงเพลงทุกตัวใน orders ที่ completed + ปุ่มดาวน์โหลด (ถ้ามี zip_download_url)
async function loadCustomerDownloads() {
  const listEl = document.getElementById("downloadsList");
  if (!listEl) return;
  listEl.innerHTML = '<div style="text-align:center;color:var(--text-dim);padding:24px;font-size:13px;">กำลังโหลด...</div>';
  try {
    const res = await fetch('/api/customer/orders?limit=200', { credentials: 'same-origin' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const orders = data.orders || [];
    // filter เฉพาะ completed orders (มีเพลงให้ดาวน์โหลด)
    const completedOrders = orders.filter(o => o.status === 'completed' && Array.isArray(o.items) && o.items.length > 0);
    if (completedOrders.length === 0) {
      listEl.innerHTML = `
        <div style="text-align:center;color:var(--text-dim);padding:32px 16px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:10px;">
          <div style="font-size:36px;margin-bottom:8px;">🎵</div>
          <div style="font-size:14px;font-weight:600;margin-bottom:4px;">ยังไม่มีเพลงที่ซื้อแล้ว</div>
          <div style="font-size:12px;">ซื้อเพลงครั้งแรกเพื่อดาวน์โหลดได้ที่นี่</div>
        </div>
      `;
      return;
    }
    // render list — แต่ละ order แสดงเป็น card พร้อมปุ่มดาวน์โหลด
    listEl.innerHTML = completedOrders.map(o => {
      const orderId = o.id || '';
      const receipt = o.receipt_number || orderId.slice(0, 8);
      const date = o.created_at ? new Date(o.created_at).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
      const songCount = (o.items || []).length;
      const total = Number(o.final_total || o.total || 0);
      const zipUrl = o.zip_download_url || '';
      const zipStatus = o.zip_status || '';
      const canDownload = zipUrl && zipStatus === 'ready';
      // แสดงชื่อเพลง 3 ตัวแรก + "และอีก X เพลง" ถ้าเกิน
      const items = o.items || [];
      const songNames = items.slice(0, 3).map(i => escapeHtml(i.title || i.song_name || 'เพลง')).join(', ');
      const moreText = songCount > 3 ? ' และอีก ' + (songCount - 3) + ' เพลง' : '';
      return `
        <div style="background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:10px;padding:12px;">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:6px;">
            <div>
              <div style="font-size:13px;font-weight:700;color:var(--text);">ใบเสร็จ #${escapeHtml(receipt)}</div>
              <div style="font-size:11px;color:var(--text-dim);">${date} · ${songCount} เพลง · ${formatPrice(total)}</div>
            </div>
            ${canDownload ? `<button type="button" class="btn-download" data-download-url="/api/track-download/${escapeHtml(orderId)}" data-download-id="${escapeHtml(orderId)}" style="background:var(--accent);color:#fff;border:none;padding:6px 12px;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;">⬇️ ดาวน์โหลด ZIP</button>` : `<span style="font-size:11px;color:var(--text-dim);padding:6px 12px;">รอเตรียมไฟล์</span>`}
          </div>
          <div style="font-size:11px;color:var(--text-dim);line-height:1.4;">${songNames}${moreText}</div>
        </div>
      `;
    }).join('');
    // bind download buttons
    listEl.querySelectorAll('[data-download-url]').forEach(btn => {
      btn.addEventListener('click', () => {
        const url = btn.getAttribute('data-download-url');
        if (url) {
          window.open(url, '_blank', 'noopener,noreferrer');
          showToast('กำลังดาวน์โหลด...', 'success');
        }
      });
    });
  } catch (err) {
    console.warn('[Feature #6] loadCustomerDownloads failed:', err?.message || err);
    listEl.innerHTML = '<div style="text-align:center;color:var(--danger);padding:24px;font-size:13px;">โหลดไม่สำเร็จ กรุณาลองใหม่</div>';
  }
}

// 🆕 (T017): ฟังก์ชันหลัก — render dashboard ทั้งหมด
function renderCustomerDashboard(orders) {
  const summaryEl = document.getElementById("dashboardSummary");
  if (!summaryEl) return; // ไม่ได้อยู่ในหน้าบัญชี → no-op
  const chartEl = document.getElementById("dashboardMonthlyChart");
  const emptyChartEl = document.getElementById("dashboardMonthlyEmpty");
  const topSongsEl = document.getElementById("dashboardTopSongs");
  const topDjsEl = document.getElementById("dashboardTopDjs");

  if (!Array.isArray(orders) || orders.length === 0) {
    summaryEl.innerHTML = `
      <div style="grid-column:1/-1;text-align:center;color:var(--text-dim);padding:24px 12px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:10px;">
        <div style="font-size:32px;margin-bottom:6px;">📊</div>
        <div style="font-size:13px;font-weight:600;margin-bottom:2px;">ยังไม่มีข้อมูล</div>
        <div style="font-size:11px;">สั่งซื้อเพลงครั้งแรกเพื่อดูสรุปการซื้อของคุณ</div>
      </div>
    `;
    if (chartEl) chartEl.innerHTML = "";
    if (emptyChartEl) emptyChartEl.style.display = "block";
    if (topSongsEl) topSongsEl.innerHTML = '<div style="color:var(--text-dim);font-size:13px;text-align:center;padding:10px;">ยังไม่มีข้อมูล</div>';
    if (topDjsEl) topDjsEl.innerHTML = '<div style="color:var(--text-dim);font-size:13px;text-align:center;padding:10px;">ยังไม่มีข้อมูล</div>';
    return;
  }

  // 1. Summary cards
  const totalOrders = orders.length;
  const totalSpent = orders.reduce((sum, o) => sum + (Number(o.final_total) || Number(o.total) || 0), 0);
  const completedOrders = orders.filter(o => o.status === "completed").length;
  const pendingOrders = orders.filter(o => ["pending_verify", "processing"].includes(o.status)).length;

  summaryEl.innerHTML = `
    <div class="dashboard-card">
      <div class="dashboard-card-icon">📦</div>
      <div class="dashboard-card-value">${totalOrders}</div>
      <div class="dashboard-card-label">ออเดอร์ทั้งหมด</div>
    </div>
    <div class="dashboard-card">
      <div class="dashboard-card-icon">💰</div>
      <div class="dashboard-card-value">${formatPrice(totalSpent)}</div>
      <div class="dashboard-card-label">ยอดใช้จ่ายรวม</div>
    </div>
    <div class="dashboard-card">
      <div class="dashboard-card-icon">✅</div>
      <div class="dashboard-card-value">${completedOrders}</div>
      <div class="dashboard-card-label">ออเดอร์สำเร็จ</div>
    </div>
    <div class="dashboard-card">
      <div class="dashboard-card-icon">⏳</div>
      <div class="dashboard-card-value">${pendingOrders}</div>
      <div class="dashboard-card-label">รอดำเนินการ</div>
    </div>
  `;

  // 2. Monthly chart (6 เดือนล่าสุด)
  renderDashboardMonthlyChart(orders, chartEl, emptyChartEl);

  // 3. Top 5 songs
  renderDashboardTopSongs(orders, topSongsEl);

  // 4. Top 3 DJs
  renderDashboardTopDjs(orders, topDjsEl);
}

// 🆕 (T017): render bar chart — ยอดซื้อรายเดือน (6 เดือนล่าสุด)
function renderDashboardMonthlyChart(orders, chartEl, emptyChartEl) {
  if (!chartEl) return;
  const now = new Date();
  const months = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({
      key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`,
      label: d.toLocaleDateString("th-TH", { month: "short" }),
      total: 0,
      count: 0,
    });
  }
  orders.forEach(o => {
    if (!o.created_at) return;
    const d = new Date(o.created_at);
    if (isNaN(d.getTime())) return;
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const month = months.find(m => m.key === key);
    if (month) {
      month.total += Number(o.final_total) || Number(o.total) || 0;
      month.count++;
    }
  });
  const hasData = months.some(m => m.count > 0);
  if (!hasData) {
    chartEl.innerHTML = "";
    if (emptyChartEl) emptyChartEl.style.display = "block";
    return;
  }
  if (emptyChartEl) emptyChartEl.style.display = "none";
  const maxTotal = Math.max(...months.map(m => m.total), 1);
  chartEl.innerHTML = months.map(m => {
    const heightPct = (m.total / maxTotal) * 100;
    const safeTotal = formatPrice(m.total);
    return `<div class="bar" style="height:${Math.max(heightPct, 2)}%;" data-value="${escapeHtml(m.label)}: ${safeTotal} · ${m.count} ออเดอร์" title="${escapeHtml(m.label)}: ${safeTotal}"></div>`;
  }).join("") + months.map(m => `<div style="flex:1;min-width:0;text-align:center;font-size:10px;color:var(--text-dim);margin-top:4px;">${escapeHtml(m.label)}</div>`).join("");
}

// 🆕 (T017): render Top 5 เพลงที่ซื้อบ่อย — นับจาก order.items (skip playlist items)
function renderDashboardTopSongs(orders, container) {
  if (!container) return;
  const songCount = new Map();
  orders.forEach(o => {
    (o.items || []).forEach(item => {
      if (!item.song_id) return;
      // skip playlist wrapper (kind=playlist ไม่มี song_id อยู่แล้ว — แต่กันไว้)
      if (item.kind === "playlist") return;
      const key = String(item.song_id);
      if (!songCount.has(key)) {
        songCount.set(key, { title: item.title || "ไม่ทราบชื่อ", count: 0, total: 0 });
      }
      const entry = songCount.get(key);
      entry.count++;
      entry.total += Number(item.price) || 0;
    });
  });
  const top5 = Array.from(songCount.entries())
    .sort((a, b) => b[1].count - a[1].count || b[1].total - a[1].total)
    .slice(0, 5);
  if (top5.length === 0) {
    container.innerHTML = '<div style="color:var(--text-dim);font-size:13px;text-align:center;padding:10px;">ยังไม่มีข้อมูล</div>';
    return;
  }
  container.innerHTML = top5.map(([id, info], idx) => `
    <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid rgba(255,255,255,.05);">
      <div style="width:24px;height:24px;border-radius:50%;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex-shrink:0;">${idx + 1}</div>
      <div style="flex:1;min-width:0;">
        <div style="font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(info.title)}</div>
        <div style="font-size:11px;color:var(--text-dim);">${info.count} ครั้ง · ${formatPrice(info.total)}</div>
      </div>
    </div>
  `).join("");
}

// 🆕 (T017): render Top 3 DJ ที่ซื้อบ่อย — นับจาก order.items + lookup dj_name จาก STATE.songs
function renderDashboardTopDjs(orders, container) {
  if (!container) return;
  const djMap = _t017_getDjLookupMap();
  const djCount = new Map();
  orders.forEach(o => {
    (o.items || []).forEach(item => {
      if (item.kind === "playlist") return;
      // 1) ใช้ dj_name จาก item ถ้ามี
      // 2) lookup จาก STATE.songs โดย song_id
      // 3) fallback 'ไม่ทราบ DJ'
      let djName = item.dj_name || item.dj || "";
      if (!djName && item.song_id) {
        djName = djMap.get(String(item.song_id)) || "";
      }
      if (!djName) djName = "ไม่ทราบ DJ";
      if (!djCount.has(djName)) {
        djCount.set(djName, { count: 0, total: 0 });
      }
      const entry = djCount.get(djName);
      entry.count++;
      entry.total += Number(item.price) || 0;
    });
  });
  const top3 = Array.from(djCount.entries())
    .filter(([name]) => name !== "ไม่ทราบ DJ" || djCount.size === 1)
    .sort((a, b) => b[1].count - a[1].count || b[1].total - a[1].total)
    .slice(0, 3);
  if (top3.length === 0) {
    container.innerHTML = '<div style="color:var(--text-dim);font-size:13px;text-align:center;padding:10px;">ยังไม่มีข้อมูล</div>';
    return;
  }
  container.innerHTML = top3.map(([djName, info], idx) => `
    <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid rgba(255,255,255,.05);">
      <div style="width:24px;height:24px;border-radius:50%;background:var(--accent-2,#f59e0b);color:#fff;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex-shrink:0;">${idx + 1}</div>
      <div style="flex:1;min-width:0;">
        <div style="font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(djName)}</div>
        <div style="font-size:11px;color:var(--text-dim);">${info.count} เพลง · ${formatPrice(info.total)}</div>
      </div>
    </div>
  `).join("");
}

// 🆕 (T017): expose ให้เรียกจากภายนอก (เผื่อต้องการ re-render หลังจากโหลดเพลงใหม่)
window.renderCustomerDashboard = renderCustomerDashboard;

// 🆕 ดึงข้อมูลบัญชี + ออเดอร์จาก /api/customer/me + /api/customer/orders
//   🆕 (T013-F7): refactor ส่วน "ดึงออเดอร์" ออกเป็น loadCustomerOrders(reset) — รองรับ pagination
//     เดิม: ดึงทุกออเดอร์ทีเดียว (default 50 จาก backend) → ถ้าเกิน 50 ลูกค้ามองไม่เห็นออเดอร์เก่า ๆ
//     ใหม่: ดึงทีละ 50 + แสดงปุ่ม "โหลดเพิ่มเติม" → ค่อย ๆ โหลดหน้าถัดไป (lazy pagination)
let customerOrdersPagination = {
  offset: 0,
  limit: 50,
  total: 0,
  has_more: false,
  allLoaded: [],   // cumulative list of orders across all loaded pages
  loading: false,
};

async function loadCustomerAccountData() {
  const profileEl = document.getElementById("myAccountProfile");
  const ordersListEl = document.getElementById("myAccountOrdersList");
  if (!profileEl || !ordersListEl) return;
  profileEl.innerHTML = `<div style="text-align:center;color:var(--text-dim);padding:14px;">⏳ กำลังโหลด...</div>`;
  ordersListEl.innerHTML = "";
  try {
    // ดึงข้อมูล customer (จาก customer-auth.js state)
    // 🆕 (2026-10-02 fix): อ่านจาก localStorage แทน window.getCurrentCustomer (ES module timing)
    let customer = (window.getCurrentCustomer && window.getCurrentCustomer()) ? window.getCurrentCustomer() : null;
    if (!customer) {
      try {
        const raw = localStorage.getItem("miusic_customer_session");
        if (raw) customer = JSON.parse(raw);
      } catch (_) {}
    }
    if (!customer) {
      profileEl.innerHTML = `<div style="color:var(--danger);">⚠️ ยังไม่ได้เข้าสู่ระบบ</div>`;
      return;
    }
    // แสดง profile
    profileEl.innerHTML = `
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:10px;">
        <div style="width:40px;height:40px;border-radius:50%;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:700;">${escapeHtml((customer.display_name || customer.email || "?").charAt(0).toUpperCase())}</div>
        <div style="flex:1;min-width:0;">
          <div style="font-weight:700;font-size:15px;">${escapeHtml(customer.display_name || "ลูกค้า")}</div>
          <div style="font-size:12px;color:var(--text-dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(customer.email || customer.whatsapp || "")}</div>
        </div>
      </div>
      ${customer.email ? `<div style="font-size:12px;color:var(--text-dim);margin-top:4px;">📧 ${escapeHtml(customer.email)}</div>` : ""}
      ${customer.whatsapp ? `<div style="font-size:12px;color:var(--text-dim);margin-top:2px;">📱 ${escapeHtml(customer.whatsapp)}</div>` : ""}
      <div style="font-size:11px;color:var(--text-dim);margin-top:6px;">สมาชิกตั้งแต่: ${customer.created_at ? new Date(customer.created_at).toLocaleDateString("th-TH", { year: "numeric", month: "short", day: "numeric" }) : "-"}</div>
    `;
    // 🆕 (T013-F7): ใช้ loadCustomerOrders(true) แทนการ fetch ตรง ๆ — รองรับ pagination
    //   reset=true → เคลียร์ allLoaded + offset=0 → ดึงหน้าแรก
    await loadCustomerOrders(true);
  } catch (err) {
    profileEl.innerHTML = `<div style="color:var(--danger);">⚠️ โหลดไม่สำเร็จ: ${escapeHtml(err.message || String(err))}</div>`;
    ordersListEl.innerHTML = "";
  }
}

// 🆕 (T013-F7): ดึงออเดอร์ของลูกค้าทีละหน้า (lazy pagination)
//   เดิม: ดึงทุกออเดอร์ทีเดียว → limit 200 (T010-M11) หรือ default 50 → ถ้าเกินนี้ลูกค้ามองไม่เห็นออเดอร์เก่า
//   ใหม่: ดึงทีละ 50 + สะสมใน customerOrdersPagination.allLoaded + แสดงปุ่ม "โหลดเพิ่มเติม"
//   ผลกระทบระบบเดิม: 0% — backend รองรับ ?limit=&offset= ตั้งแต่ T010-M11 แล้ว
//                       client เดิมที่ไม่ส่ง params → backend default 50 → ทำงานเหมือนเดิม
async function loadCustomerOrders(reset = false) {
  const ordersListEl = document.getElementById("myAccountOrdersList");
  if (!ordersListEl) return;
  if (customerOrdersPagination.loading) return;
  if (reset) {
    customerOrdersPagination.offset = 0;
    customerOrdersPagination.allLoaded = [];
    customerOrdersPagination.total = 0;
    customerOrdersPagination.has_more = false;
    ordersListEl.innerHTML = `<div style="text-align:center;color:var(--text-dim);padding:14px;">⏳ กำลังโหลดออเดอร์...</div>`;
  } else {
    // แสดง loading indicator ในปุ่ม "โหลดเพิ่มเติม" (ถ้ามี)
    const loadMoreBtn = document.getElementById("loadMoreOrdersBtn");
    if (loadMoreBtn) {
      loadMoreBtn.disabled = true;
      loadMoreBtn.textContent = "⏳ กำลังโหลด...";
    }
  }
  customerOrdersPagination.loading = true;
  try {
    const url = `/api/customer/orders?limit=${customerOrdersPagination.limit}&offset=${customerOrdersPagination.offset}`;
    const res = await fetch(url, { credentials: "same-origin" });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      // 🆕 (T059): PWA offline fallback — ถ้า fetch fail และมี cache → อ่านจาก IndexedDB
      if (window.IDB && customerOrdersPagination.offset === 0) {
        try {
          const isForMe = await window.IDB.isCacheForCustomer(STATE?.customer?.id || null);
          if (isForMe) {
            const cachedOrders = await window.IDB.getCachedOrders();
            if (cachedOrders.length > 0) {
              customerOrdersPagination.allLoaded = cachedOrders;
              trackOrderAllOrders = cachedOrders;
              const cachedAt = await window.IDB.getCachedAt();
              const cachedAtStr = cachedAt ? new Date(cachedAt).toLocaleString("th-TH", { dateStyle: "short", timeStyle: "short" }) : "-";
              ordersListEl.innerHTML = `
                <div style="background:rgba(245,180,0,0.1);border:1px solid rgba(245,180,0,0.3);border-radius:8px;padding:10px 14px;margin-bottom:12px;font-size:13px;color:#F5B400;">
                  📴 คุณกำลังออฟไลน์ — แสดงออเดอร์ล่าสุด ณ ${escapeHtml(cachedAtStr)} (${cachedOrders.length} รายการ)
                </div>`;
              renderCustomerOrdersList(cachedOrders);
              return;
            }
          }
        } catch (idbErr) {
          console.warn("[T059] offline fallback failed:", idbErr?.message || idbErr);
        }
      }
      ordersListEl.innerHTML = `<div style="color:var(--danger);text-align:center;padding:14px;">โหลดออเดอร์ไม่สำเร็จ: ${escapeHtml(err?.error || res.statusText)}</div>`;
      return;
    }
    const data = await res.json();
    const ordersLogin = Array.isArray(data?.orders_login) ? data.orders_login : [];
    const ordersGuest = []; // 🆕 (v10): หน้าบัญชีแสดงเฉพาะ customer_id ของตัวเอง → orders_guest ไม่ใช้
    // 🆕 (T013-F7): อัปเดต pagination state จาก response
    if (data?.pagination) {
      customerOrdersPagination.total = Number(data.pagination.total) || 0;
      customerOrdersPagination.has_more = !!data.pagination.has_more;
    } else {
      // fallback: backend เดิม (ยังไม่ deploy T010-M11) → estimate จากจำนวนที่ดึงได้
      customerOrdersPagination.total = ordersLogin.length;
      customerOrdersPagination.has_more = false;
    }
    // 🆕 (T013-F7): merge new orders เข้า allLoaded (dedup ด้วย id)
    const existingIds = new Set(customerOrdersPagination.allLoaded.map(o => o._docId || o.id));
    for (const o of ordersLogin) {
      if (!o._docId) o._docId = o.id || "";
      if (!existingIds.has(o._docId)) {
        customerOrdersPagination.allLoaded.push(o);
        existingIds.add(o._docId);
      }
    }
    // เก็บ orders ทั้งหมดไว้ใน trackOrderAllOrders (ใช้โดย openTrackOrderAllDetail)
    trackOrderAllOrders = customerOrdersPagination.allLoaded;

    // 🆕 (T059): cache orders ลง IndexedDB เพื่อ PWA offline mode
    //   - cache เฉพาะ page แรก (offset === 0) เพื่อกัน D1 writes เยอะ
    //   - ใช้ allLoaded (cumulative) เพื่อให้ cache มีข้อมูลครบ
    //   - ถ้า IDB ไม่รองรับ → ข้าม (no-op)
    if (window.IDB && customerOrdersPagination.offset === 0 && customerOrdersPagination.allLoaded.length > 0) {
      try {
        const customerId = STATE?.customer?.id || null;
        if (customerId) {
          // ตรวจก่อนว่า cache เป็นของ customer คนนี้ไหม — ถ้าไม่ใช่ → clear ก่อน cache ใหม่
          const isForMe = await window.IDB.isCacheForCustomer(customerId);
          if (!isForMe) {
            await window.IDB.clearAll();
          }
          await window.IDB.cacheOrders(customerOrdersPagination.allLoaded, customerId);
          await window.IDB.setCurrentCustomerId(customerId);
        }
      } catch (idbErr) {
        console.warn("[T059] cacheOrders failed:", idbErr?.message || idbErr);
      }
    }

    // 🆕 (T017): render customer dashboard สำหรับ empty state ด้วย
    //   - ต้องเรียกก่อน early return ไม่งั้น dashboard จะไม่แสดง "ยังไม่มีข้อมูล" ในกรณีไม่มีออเดอร์
    //   - ที่ท้ายฟังก์ชัน (หลัง loadMore binding) จะเรียกอีกครั้งสำหรับ non-empty case (redundant แต่ปลอดภัย — idempotent)
    try {
      renderCustomerDashboard(customerOrdersPagination.allLoaded);
    } catch (dashErr) {
      console.warn("T017: renderCustomerDashboard error (empty path):", dashErr);
    }

    // empty state
    if (customerOrdersPagination.allLoaded.length === 0) {
      ordersListEl.innerHTML = `
        <div class="empty-state-cute">
          <div class="empty-icon">📦</div>
          <div class="empty-title">ยังไม่มีออเดอร์</div>
          <div class="empty-desc">สั่งซื้อเพลงครั้งแรก — ออเดอร์จะแสดงที่นี่</div>
          <button class="btn empty-cta" type="button" data-empty-goto-home>🎵 ไปเลือกเพลง</button>
        </div>`;
      return;
    }

    // 🆕 (v9 + T013-F7): helper function สร้าง HTML ของ order card
    //   ใช้ data-account-order-source + data-account-order-idx ในการค้น order ที่ถูกต้อง
    //   T013-F7: idx ตอนนี้เป็น index ใน customerOrdersPagination.allLoaded (cumulative)
    function buildOrderCardHtml(order, indexInSource, source) {
      const cfg = TRACK_STATUS_CONFIG[order.status] || TRACK_STATUS_CONFIG.pending_verify;
      const dateStr = order.created_at ? new Date(order.created_at).toLocaleDateString("th-TH", { day: "2-digit", month: "2-digit", year: "numeric" }) : "";
      const pState = getOrderPaymentState(order);
      let paymentBadgeHtml = "";
      if (pState.state === "paid") paymentBadgeHtml = `<span style="font-size:10px;padding:2px 6px;border-radius:8px;background:rgba(41,204,113,.15);color:var(--success);font-weight:600;">✅ ชำระแล้ว</span>`;
      else if (pState.state === "verified_awaiting_zip") paymentBadgeHtml = `<span style="font-size:10px;padding:2px 6px;border-radius:8px;background:rgba(41,204,113,.15);color:var(--success);font-weight:600;">✅ ยืนยันแล้ว</span>`;
      else if (pState.state === "pending_review") paymentBadgeHtml = `<span style="font-size:10px;padding:2px 6px;border-radius:8px;background:rgba(245,180,0,.15);color:#F5B400;font-weight:600;">📸 ส่งสลิปแล้ว</span>`;
      else if (pState.state === "rejected") paymentBadgeHtml = `<span style="font-size:10px;padding:2px 6px;border-radius:8px;background:rgba(239,68,68,.15);color:var(--danger);font-weight:600;">⚠️ สลิปถูกปฏิเสธ</span>`;
      const finalTotal = (order.final_total != null) ? Number(order.final_total) : Number(order.total || 0);
      const canDownload = order.zip_download_url && (order.status === "processing" || order.status === "completed");
      const downloadBtnHtml = canDownload
        ? `<a href="/api/track-download/${escapeHtml(order._docId || order.id || '')}" target="_blank" rel="noopener" data-account-download="${escapeHtml(source)}-${indexInSource}" class="btn list-download-btn">⬇️ ดาวน์โหลดเพลง</a>`
        : "";
      return `
        <div class="track-order-all-card" role="button" tabindex="0" data-account-order-source="${escapeHtml(source)}" data-account-order-idx="${indexInSource}" style="width:100%;text-align:left;">
          <div class="track-order-all-card-top">
            <span class="track-order-all-card-id">${escapeHtml(order.receipt_number || "")}</span>
            <span class="track-order-all-card-status" style="color:${cfg.color};background:${cfg.bg};">${cfg.emoji} ${escapeHtml(cfg.label)}</span>
          </div>
          <div class="track-order-all-card-mid">
            <span>${escapeHtml(dateStr)}</span>
            <span>${formatPrice(finalTotal)}</span>
          </div>
          ${paymentBadgeHtml ? `<div style="margin-top:4px;">${paymentBadgeHtml}</div>` : ""}
          ${downloadBtnHtml}
        </div>`;
    }

    // 🆕 (T013-F7): เรียง allLoaded ตามวันที่ (ล่าสุดก่อน) — re-sort ทุกครั้งเพราะมี order ใหม่เข้ามา
    const allOrdersMerged = customerOrdersPagination.allLoaded.map((order, i) => ({ order, source: "login", idx: i }));
    allOrdersMerged.sort((a, b) => {
      const aTime = a.order.created_at ? new Date(a.order.created_at).getTime() : 0;
      const bTime = b.order.created_at ? new Date(b.order.created_at).getTime() : 0;
      return bTime - aTime;
    });
    // 🆕 (T013-F7): re-map idx หลัง sort (idx เป็น index ใน allLoaded ที่เรียงใหม่)
    //   เพราะ click handler จะใช้ idx ดึง order จาก allLoaded — ต้องตรงกับลำดับใน DOM
    const sortedOrders = allOrdersMerged.map(m => m.order);
    // อัปเดต trackOrderAllOrders ให้เป็นลำดับเดียวกับ DOM (เผื่อเรียกจากที่อื่น)
    trackOrderAllOrders = sortedOrders;

    // แสดง list
    const listHtml = `<div style="display:grid;gap:10px;">
        ${allOrdersMerged.map((item, newIdx) => buildOrderCardHtml(item.order, newIdx, item.source)).join("")}
      </div>`;

    // 🆕 (T013-F7): เพิ่มปุ่ม "โหลดเพิ่มเติม" ถ้ายังมีออเดอร์เหลือ
    const loadMoreHtml = customerOrdersPagination.has_more
      ? `<div style="text-align:center;padding:14px 0 4px;">
          <button class="btn secondary load-more-orders-btn" id="loadMoreOrdersBtn" type="button" aria-label="โหลดออเดอร์เพิ่มเติม" style="width:100%;max-width:300px;">
            โหลดเพิ่มเติม (${customerOrdersPagination.allLoaded.length}/${customerOrdersPagination.total})
          </button>
        </div>`
      : "";

    ordersListEl.innerHTML = listHtml + loadMoreHtml;

    // 🆕 (v8): ปุ่ม "ดาวน์โหลดเพลง" — ใช้ selector เดิม แต่ data-account-download มี source-index
    ordersListEl.querySelectorAll("[data-account-download]").forEach(btn => {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
        const url = btn.getAttribute("href");
        if (url) window.open(url, "_blank", "noopener");
      });
    });

    // 🆕 (v8 + T013-F7): bind click → เปิด detail — ใช้ sortedOrders[idx] (idx ใหม่หลัง re-sort)
    ordersListEl.querySelectorAll("[data-account-order-source]").forEach(btn => {
      btn.addEventListener("click", () => {
        const source = btn.getAttribute("data-account-order-source");
        const idx = Number(btn.getAttribute("data-account-order-idx"));
        // 🆕 (T013-F7): source ตอนนี้มีแค่ "login" (ordersGuest ว่างเสมอ) — ใช้ sortedOrders[idx]
        const order = sortedOrders[idx];
        if (order) {
          const accountView = document.getElementById("myAccountView");
          if (accountView) accountView.style.display = "none";
          openTrackOrderAllDetail(order);
          const trackBackdrop = document.getElementById("trackOrderBackdrop");
          if (trackBackdrop) { trackBackdrop.classList.add("show"); trackBackdrop.setAttribute("aria-hidden", "false"); }
        }
      });
    });

    // 🆕 (T013-F7): bind ปุ่ม "โหลดเพิ่มเติม"
    const loadMoreBtn = document.getElementById("loadMoreOrdersBtn");
    if (loadMoreBtn) {
      loadMoreBtn.addEventListener("click", () => loadMoreCustomerOrders());
    }

    // 🆕 (T017): render customer dashboard หลังโหลด/โหลดเพิ่มเติม — ใช้ allLoaded (cumulative)
    //   - ทำงานทั้งตอน first-load (reset=true) และ load-more (reset=false)
    //   - ถ้า DOM ของ dashboard ไม่มี (หน้าอื่น) → renderCustomerDashboard จะ no-op เอง
    //   - คำนวณที่ frontend ทั้งหมด — ประหยัด D1 quota (ไม่ต้องสร้าง endpoint ใหม่)
    try {
      renderCustomerDashboard(customerOrdersPagination.allLoaded);
    } catch (dashErr) {
      console.warn("T017: renderCustomerDashboard error:", dashErr);
    }
  } catch (err) {
    ordersListEl.innerHTML = `<div style="color:var(--danger);text-align:center;padding:14px;">โหลดออเดอร์ไม่สำเร็จ: ${escapeHtml(err.message || String(err))}</div>`;
  } finally {
    customerOrdersPagination.loading = false;
  }
}

// 🆕 (T013-F7): เพิ่ม offset → โหลดหน้าถัดไป
function loadMoreCustomerOrders() {
  customerOrdersPagination.offset += customerOrdersPagination.limit;
  return loadCustomerOrders(false);
}

// 🆕 expose ให้ customer-auth.js เรียก (ตอนกดปุ่ม "👤 บัญชี")
window.showCustomerAccountView = showCustomerAccountView;
window.loadCustomerAccountData = loadCustomerAccountData;
// 🆕 (T013-F7): expose loadMoreCustomerOrders ให้เรียกจาก onclick ของปุ่ม "โหลดเพิ่มเติม"
window.loadMoreCustomerOrders = loadMoreCustomerOrders;
// 🆕 (2026-10-02 fix): expose showMyOrdersView + hideMyOrdersView ให้ customer-auth.js fallback ใช้ได้
window.showMyOrdersView = showMyOrdersView;
window.hideMyOrdersView = hideMyOrdersView;
// 🆕 (2026-10-03 team-fix): expose showGuestOrdersLoginBanner + hideGuestOrdersLoginBanner
//   ให้ customer-auth.js เรียกตอน login state เปลี่ยน (ลบแบนเนอร์ออกเมื่อ login แล้ว)
window.showGuestOrdersLoginBanner = showGuestOrdersLoginBanner;
window.hideGuestOrdersLoginBanner = hideGuestOrdersLoginBanner;
// 🆕 (2026-10-03 team-fix): expose initWhatsappFab (ใช้ตอน re-init ถ้าต้องการ)
window.initWhatsappFab = initWhatsappFab;

// 🆕 (2026-10-02): bind event listeners สำหรับปุ่มในรายละเอียดออเดอร์ (หน้าบัญชี)
//   ใช้กับ orders ที่ render ผ่าน renderOneOrderCard จาก app-promotion.js
function bindAccountOrderEvents(listEl, orders) {
  if (!listEl || !orders) return;
  // ปุ่มชำระเงิน
  listEl.querySelectorAll("[data-order-pay]").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const orderId = btn.getAttribute("data-order-pay");
      const order = orders.find(o => (o._docId || o.id || "") === orderId);
      if (!order) return;
      const receiptNumber = order.receipt_number || orderId.slice(0, 8);
      if (typeof window.showReceipt === "function") {
        window.showReceipt(order, receiptNumber, order.store_name || "Music Store");
      }
    });
  });
  // ปุ่มลบออเดอร์
  listEl.querySelectorAll("[data-order-delete]").forEach(btn => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const orderId = btn.getAttribute("data-order-delete");
      const order = orders.find(o => (o._docId || o.id || "") === orderId);
      if (!order) return;
      if (typeof window.handleCustomerDeleteOrder === "function") {
        await window.handleCustomerDeleteOrder(order, () => {
          loadCustomerAccountData();
        });
      }
    });
  });
  // ปุ่มฟังเพลง
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

// 🆕 ผูก listeners สำหรับปุ่มใน myAccountView
document.getElementById("myAccountBackBtn")?.addEventListener("click", () => {
  hideCustomerAccountView();
  // กลับหน้าหลัก (แสดง grid + category chips + dj)
  ["#gridTitle", "#songGrid"].forEach(s => { const el = document.querySelector(s); if (el) el.style.display = ""; });
  const categoryChips = document.getElementById("categoryChips");
  const djSection = document.getElementById("djSection");
  if (categoryChips) categoryChips.style.display = "";
  if (djSection) djSection.style.display = "";
  const emptyState = document.getElementById("emptyState");
  if (emptyState) emptyState.style.display = "none";
});
document.getElementById("myAccountRefreshBtn")?.addEventListener("click", () => {
  loadCustomerAccountData();
});

// 🆕 (2026-10-02): tab switching สำหรับหน้าบัญชี — โปรไฟล์ / ออเดอร์ / บันทึกซื้อทีหลัง / ตั้งค่า
// 🆕 (T017): เพิ่ม "dashboard" เป็น tab แรก (default active)
function switchAccountTab(tab) {
  const tabs = { dashboard: "accountTabDashboard", profile: "accountTabProfile", orders: "accountTabOrders", downloads: "accountTabDownloads", favorites: "accountTabFavorites", settings: "accountTabSettings" };
  const sections = { dashboard: "accountSectionDashboard", profile: "accountSectionProfile", orders: "accountSectionOrders", downloads: "accountSectionDownloads", favorites: "accountSectionFavorites", settings: "accountSectionSettings" };
  for (const [key, tabId] of Object.entries(tabs)) {
    const tabBtn = document.getElementById(tabId);
    const section = document.getElementById(sections[key]);
    if (key === tab) {
      if (tabBtn) { tabBtn.style.color = "var(--accent)"; tabBtn.style.borderBottom = "2px solid var(--accent)"; }
      if (section) section.style.display = "block";
    } else {
      if (tabBtn) { tabBtn.style.color = "var(--text-dim)"; tabBtn.style.borderBottom = "2px solid transparent"; }
      if (section) section.style.display = "none";
    }
  }
}
// 🆕 (T017): tab แดชบอร์ด — ใช้ข้อมูล orders ที่โหลดแล้ว (ไม่่ต้อง fetch ใหม่ — ประหยัด D1 quota)
//   - ถ้า allLoaded ว่าง → เรียก loadCustomerAccountData() เพื่อ trigger fetch ครั้งแรก
//   - ถ้ามีข้อมูลอยู่แล้ว → render dashboard จาก allLoaded ทันที (no fetch)
document.getElementById("accountTabDashboard")?.addEventListener("click", () => {
  switchAccountTab("dashboard");
  if (typeof customerOrdersPagination !== "undefined" && customerOrdersPagination.allLoaded.length === 0) {
    loadCustomerAccountData();
  } else if (typeof customerOrdersPagination !== "undefined") {
    try { renderCustomerDashboard(customerOrdersPagination.allLoaded); } catch (_) {}
  }
});
document.getElementById("accountTabProfile")?.addEventListener("click", () => switchAccountTab("profile"));
document.getElementById("accountTabOrders")?.addEventListener("click", () => {
  switchAccountTab("orders");
  loadCustomerAccountData(); // โหลดออเดอร์เมื่อกด tab
});
// 🆕 (Feature #6): tab ดาวน์โหลด → โหลดเพลงที่ซื้อแล้ว
document.getElementById("accountTabDownloads")?.addEventListener("click", () => {
  switchAccountTab("downloads");
  loadCustomerDownloads();
});
// 🆕 (2026-10-02 v6): tab บันทึกซื้อทีหลัง → โหลด favorites
document.getElementById("accountTabFavorites")?.addEventListener("click", () => {
  switchAccountTab("favorites");
  if (typeof loadCustomerFavorites === "function") loadCustomerFavorites();
  // 🆕 (v7): ถ้า expose ผ่าน window (มาจาก customer-auth.js) → เรียกผ่าน window
  else if (typeof window.loadCustomerFavorites === "function") window.loadCustomerFavorites();
});
document.getElementById("accountTabSettings")?.addEventListener("click", () => switchAccountTab("settings"));

// 🆕 (2026-10-02): ปุ่มออกจากระบบในหน้าบัญชี
document.getElementById("myAccountLogoutBtn")?.addEventListener("click", async () => {
  if (!confirm("ต้องการออกจากระบบใช่ไหม?")) return;
  // ซ่อน account view
  const accountView = document.getElementById("myAccountView");
  if (accountView) accountView.style.display = "none";
  // เรียก logout จาก customer-auth.js
  try {
    await fetch("/api/customer/logout", { method: "POST", credentials: "same-origin" });
  } catch (_) {}
  // ล้าง localStorage
  try { localStorage.removeItem("miusic_customer_session"); } catch (_) {}
  // แสดง view หลักกลับมา
  ["#gridTitle", "#songGrid"].forEach(s => { const el = document.querySelector(s); if (el) el.style.display = ""; });
  const categoryChips = document.getElementById("categoryChips");
  const djSection = document.getElementById("djSection");
  if (categoryChips) categoryChips.style.display = "";
  if (djSection) djSection.style.display = "";
  // refresh UI ของ customer-auth.js
  if (typeof window.__refreshCustomerAuthUI === "function") window.__refreshCustomerAuthUI();
  else location.reload();
});

// 🆕 (2026-10-02): เปลี่ยนรหัสผ่าน — เรียก endpoint ใหม่
document.getElementById("customerChangePasswordBtn")?.addEventListener("click", async () => {
  const oldPwd = document.getElementById("customerChangeOldPassword")?.value || "";
  const newPwd = document.getElementById("customerChangeNewPassword")?.value || "";
  const resultEl = document.getElementById("customerChangePasswordResult");
  if (resultEl) resultEl.textContent = "";
  if (oldPwd.length < 1) { if (resultEl) resultEl.textContent = "กรุณากรอกรหัสผ่านเดิม"; return; }
  if (newPwd.length < 6) { if (resultEl) resultEl.textContent = "รหัสผ่านใหม่ต้องมีอย่างน้อย 6 ตัว"; return; }
  try {
    const res = await fetch("/api/customer/change-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ old_password: oldPwd, new_password: newPwd }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      if (resultEl) { resultEl.textContent = "✅ เปลี่ยนรหัสผ่านสำเร็จ"; resultEl.style.color = "var(--success)"; }
      document.getElementById("customerChangeOldPassword").value = "";
      document.getElementById("customerChangeNewPassword").value = "";
    } else {
      if (resultEl) { resultEl.textContent = data?.error || "เปลี่ยนรหัสผ่านไม่สำเร็จ"; resultEl.style.color = "var(--danger)"; }
    }
  } catch (err) {
    if (resultEl) { resultEl.textContent = "เกิดข้อผิดพลาด: " + (err.message || String(err)); resultEl.style.color = "var(--danger)"; }
  }
});

// 🆕 (2026-10-02 v2): ลืมรหัสผ่าน (ในหน้าบัญชี ตั้งค่า) — ส่งคำขาให้แอดมินรีเซ็ต (ไม่ใช้ WhatsApp API)
//   เดิมเรียก /api/customer/reset-password (placeholder 501) → เปลี่ยนเป็น /api/customer/forgot-password (เก็บคำขาจริง)
document.getElementById("customerResetPasswordBtn")?.addEventListener("click", async () => {
  const login = document.getElementById("customerResetLogin")?.value?.trim() || "";
  const resultEl = document.getElementById("customerResetPasswordResult");
  if (resultEl) resultEl.textContent = "";
  if (!login) { if (resultEl) { resultEl.textContent = "กรุณากรอกอีเมลหรือเบอร์ WhatsApp"; resultEl.style.color = "var(--danger)"; } return; }
  const btn = document.getElementById("customerResetPasswordBtn");
  if (btn) { btn.disabled = true; btn.textContent = "กำลังส่ง..."; }
  try {
    const res = await fetch("/api/customer/forgot-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ login }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      if (resultEl) { resultEl.textContent = data?.message || "✅ ส่งคำขารีเซ็ตรหัสผ่านแล้ว — แอดมินจะติดต่อกลับทาง WhatsApp ภายใน 24 ชั่วโมง"; resultEl.style.color = "var(--success)"; }
      if (btn) { btn.textContent = "✅ ส่งคำขอแล้ว"; btn.disabled = true; }
    } else {
      if (resultEl) { resultEl.textContent = data?.error || "ส่งคำขาไม่สำเร็จ"; resultEl.style.color = "var(--danger)"; }
      if (btn) { btn.disabled = false; btn.textContent = "ส่งคำขารีเซ็ตรหัสผ่าน"; }
    }
  } catch (err) {
    if (resultEl) { resultEl.textContent = "เกิดข้อผิดพลาด: " + (err.message || String(err)); resultEl.style.color = "var(--danger)"; }
    if (btn) { btn.disabled = false; btn.textContent = "ส่งคำขารีเซ็ตรหัสผ่าน"; }
  }
});

// ===== เพิ่มใหม่: ติดตามออเดอร์ (ฝั่งลูกค้า ไม่ต้อง Login) — ไม่แตะระบบเดิม =====
// ลูกค้ากรอกเลข Order + ชื่อ + เบอร์โทร เพื่อค้นหาและตรวจสอบสถานะออเดอร์ของตัวเอง
function normalizePhone(v) {
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
  if (rest.length === 9 && /^[6-9]/.test(rest)) {
    return "66" + rest;
  }
  return "856" + rest;
}
function normalizeName(v) { return String(v || "").trim().toLowerCase(); }

// เพิ่มใหม่: แปล error ดิบจากระบบ/เน็ตให้เป็นข้อความที่ลูกค้าอ่านเข้าใจ (แทนที่จะโชว์ err.message ภาษาอังกฤษดิบๆ)
function getFriendlyErrorMessage(err) {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return "ไม่มีสัญญาณอินเทอร์เน็ต กรุณาตรวจสอบการเชื่อมต่อแล้วลองใหม่อีกครั้ง";
  }
  const code = String(err?.code || "");
  if (code.includes("unavailable") || code.includes("deadline-exceeded") || err?.name === "TrackOrderTimeout") {
    return "เชื่อมต่อระบบช้ากว่าปกติ (อินเทอร์เน็ตอาจช้าหรือหลุด) กรุณาลองใหม่อีกครั้ง";
  }
  if (code.includes("permission-denied")) {
    return "ระบบขัดข้อง ไม่สามารถเข้าถึงข้อมูลได้ในขณะนี้ กรุณาลองใหม่ภายหลัง";
  }
  return "ระบบขัดข้องชั่วคราว กรุณาลองใหม่อีกครั้ง";
}

// เพิ่มใหม่: ครอบ promise ด้วย timeout กันปุ่มค้าง "กำลังค้นหา..." ตลอดไปเวลาเน็ตช้า/หลุดกลางทาง
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => {
        const err = new Error("เชื่อมต่อช้ากว่าปกติ");
        err.name = "TrackOrderTimeout";
        reject(err);
      }, ms);
    })
  ]);
}

function openTrackOrder() {
  const backdrop = document.getElementById("trackOrderBackdrop");
  if (backdrop) backdrop.classList.add("show");
  // เพิ่มใหม่: ถ้ามีออเดอร์ล่าสุดที่จำไว้ในเครื่องนี้ ให้เติมข้อมูลให้อัตโนมัติ + เสนอปุ่มดูใบเสร็จอีกครั้งแบบไม่ต้องค้นหา
  const record = getLastOrderRecord ? getLastOrderRecord() : null;
  const quickEl = document.getElementById("trackOrderQuick");
  if (record && quickEl) {
    document.getElementById("trackOrderId").value = record.receiptNumber || "";
    document.getElementById("trackOrderName").value = record.order?.customer_name || "";
    document.getElementById("trackOrderPhone").value = record.order?.whatsapp || "";
    quickEl.hidden = false;
    const quickBtn = document.getElementById("trackOrderQuickBtn");
    if (quickBtn) {
      quickBtn.onclick = () => {
        closeTrackOrder();
        showReceipt(record.order, record.receiptNumber, STATE.settings.whatsapp_number, record.contacted);
      };
    }
  } else if (quickEl) {
    quickEl.hidden = true;
  }
  // 🆕 (2026-10-02 v7): preload ชื่อ+เบอร์ ของ mode "ออเดอร์ทั้งหมดของฉัน" จาก localStorage
  //   เพื่อให้ลูกค้าไม่ต้องกรอกใหม่ทุกครั้ง
  const savedNameAll = localStorage.getItem("miusic_track_all_name");
  const savedPhoneAll = localStorage.getItem("miusic_track_all_phone");
  const allNameInput = document.getElementById("trackOrderAllName");
  const allPhoneInput = document.getElementById("trackOrderAllPhone");
  if (allNameInput && savedNameAll) allNameInput.value = savedNameAll;
  if (allPhoneInput && savedPhoneAll) allPhoneInput.value = savedPhoneAll;
}
function closeTrackOrder() {
  const backdrop = document.getElementById("trackOrderBackdrop");
  if (backdrop) backdrop.classList.remove("show");
  // เพิ่มใหม่: ปิด listener เรียลไทม์ของโหมด "ออเดอร์ทั้งหมด" (ถ้ามี) กัน query ค้างหลังปิดโมดัล
  stopTrackOrderAllListener();
}

function setTrackOrderFeedback(message, type) {
  const el = document.getElementById("trackOrderFeedback");
  if (!el) return;
  el.textContent = message || "";
  el.style.color = type === "success" ? "var(--success)" : "var(--danger)";
}

function buildTrackOrderWhatsAppText(order) {
  const lines = (order.items || []).map((item, index) => `${index + 1}. ${item.title} — ${formatPrice(item.price)}`);
  return [
    `สวัสดีครับ/ค่ะ ต้องการสอบถามเกี่ยวกับ Order ของฉัน`,
    "",
    `🧾 Order: ${order.receipt_number || ""}`,
    `👤 ชื่อ: ${order.customer_name || ""}`,
    `📱 เบอร์: ${order.whatsapp || ""}`,
    "",
    "🛒 รายการ",
    ...lines,
    "",
    `💰 ยอดรวม: ${formatPrice(order.total)}`,
  ].join("\n");
}

// ---- เพิ่มใหม่: ลูกค้าลบออเดอร์ของตัวเองได้ ----
// 🆕 (2026-10-02 v7): เปลี่ยนให้ลูกค้าลบได้ทุกสถานะ (เดิมเฉพาะ pending_verify)
//   - ถ้าเป็น completed/processing → เตือนก่อนว่าไฟล์ ZIP จะไม่สามารถดาวน์โหลดได้อีก
//   - ถ้าเป็น cancelled/pending_verify → ลบได้ปกติ
function canCustomerDeleteOrder(order) {
  // ลบได้ทุกสถานะ (pending_verify, processing, completed, cancelled)
  // เงื่อนไขเดียว: ต้องมี order (null/undefined → false)
  return !!order;
}

async function handleCustomerDeleteOrder(order, onDeleted) {
  if (!order || !order._docId) {
    showToast("ไม่พบข้อมูลออเดอร์นี้ กรุณาลองใหม่", "error");
    return;
  }
  // 🆕 (2026-10-02 v7): ข้อความเตือนตามสถานะออเดอร์
  //   - completed/processing → เตือนว่าไฟล์ ZIP จะไม่สามารถดาวน์โหลดได้อีก
  //   - สถานะอื่น → เตือนปกติ
  const isCompletedOrProcessing = (order.status === "completed" || order.status === "processing");
  const warningText = isCompletedOrProcessing
    ? `ต้องการลบ Order ${order.receipt_number || ""} ใช่หรือไม่?\n\n⚠️ ออเดอร์นี้มีไฟล์เพลงพร้อมดาวน์โหลด — เมื่อลบแล้วจะไม่สามารถดาวน์โหลดไฟล์ ZIP ได้อีก\n\nเมื่อลบแล้วจะไม่สามารถกู้คืนได้`
    : `ต้องการลบ Order ${order.receipt_number || ""} ใช่หรือไม่?\n\nเมื่อลบแล้วจะไม่สามารถกู้คืนได้`;
  // 🎨 (2026-09-26): ใช้ customConfirm แทน window.confirm() — สไตล์เดียวกับเว็บ
  const confirmed = await window.customConfirm(
    warningText,
    { title: "ยืนยันการลบออเดอร์", okText: "ลบ", danger: true }
  );
  if (!confirmed) return;
  try {
    // 🔒 Security (2026-09-11): ส่ง customer_name + whatsapp ไปด้วยใน body ของ DELETE
    // Server จะตรวจว่าเป็นเจ้าของออเดอร์จริงก่อนลบ (กันลูกค้าคนหนึ่งลบออเดอร์ของอีกคนโดยรู้แค่ ID)
    // ใช้ข้อมูลจาก order object ที่ได้จาก query ฝั่ง Server กรองให้แล้ว — ลูกค้าไม่ต้องกรอกซ้ำ
    await deleteDoc(doc(db, "orders", order._docId), {
      body: {
        customer_name: order.customer_name || "",
        whatsapp: order.whatsapp || "",
      },
    });
    showToast("ลบออเดอร์เรียบร้อยแล้ว", "success");
    if (typeof onDeleted === "function") onDeleted();
  } catch (err) {
    console.error("handleCustomerDeleteOrder error:", err);
    showToast(getFriendlyErrorMessage(err), "error");
  }
}

function renderTrackOrderResult(order) {
  const resultEl = document.getElementById("trackOrderResult");
  if (!resultEl) return;

  const cfg = TRACK_STATUS_CONFIG[order.status] || TRACK_STATUS_CONFIG.pending_verify;
  // 🛡️ (added 2026-09-26 prevent double payment): คำนวณสถานะการชำระเงิน
  //   ใช้ helper getOrderPaymentState() จาก app-cart.js (shared กับ showReceipt/openPaymentModal)
  //   เพื่อซ่อนปุ่ม "ชำระเงิน" + แสดง banner สถานะเด่นชัดในหน้า track order
  const paymentState = getOrderPaymentState(order);
  const items = order.items || [];
  const itemsHtml = items.map(item => `
    <div class="track-order-item">
      <span class="track-order-item-name">${escapeHtml(item.title || "เพลง")}</span>
      <span class="track-order-item-price">${formatPrice(item.price)}</span>
    </div>
  `).join("");

  // 🛡️ (added 2026-09-26): banner สถานะการชำระเงิน — แสดงเฉพาะเมื่อมี message หรือ warning
  //   - state 'paid' → แสดง "ชำระเงินแล้ว" (เขียว)
  //   - state 'verified_awaiting_zip' → แสดง "ยืนยันการชำระเงินแล้ว รอเตรียมไฟล์ส่งให้" (เขียว)
  //   - state 'pending_review' → แสดง "ส่งหลักฐานแล้ว รอตรวจสอบ" + "⚠️ ไม่ต้องชำระซ้ำ" (เหลือง)
  //   - state 'rejected' → แสดง "สลิปถูกปฏิเสธ กรุณาส่งใหม่" + เหตุผล (ถ้ามี) (แดง)
  //   - state 'unpaid' → ไม่แสดง banner (ใช้ข้อความเดิม "รอแอดมินตรวจสอบ")
  //   - state 'cancelled' → แสดง "ออเดอร์ถูกยกเลิก" (แดง)
  const paymentBanner = (paymentState.message || paymentState.warning)
    ? `<div style="margin-top:10px;padding:12px;border-radius:8px;border:1px solid ${paymentState.color};background:${paymentState.bg};color:${paymentState.color};">
        <div style="font-weight:700;font-size:14px;">${escapeHtml(paymentState.label)}</div>
        ${paymentState.message ? `<div style="font-size:13px;margin-top:6px;line-height:1.5;">${escapeHtml(paymentState.message)}</div>` : ""}
        ${paymentState.warning ? `<div style="font-size:13px;margin-top:6px;line-height:1.5;font-weight:600;">${escapeHtml(paymentState.warning)}</div>` : ""}
        ${paymentState.customHtml || ""}
      </div>`
    : "";

  resultEl.innerHTML = `
    <div class="track-order-status" style="color:${cfg.color};background:${cfg.bg};">${cfg.emoji} ${escapeHtml(cfg.label)}</div>
    <div class="track-order-row"><span>เลข Order</span><strong>${escapeHtml(order.receipt_number || "")}</strong></div>
    <div class="track-order-row"><span>ชื่อลูกค้า</span><strong>${escapeHtml(order.customer_name || "")}</strong></div>
    <div class="track-order-row"><span>เบอร์โทร</span><strong>${escapeHtml(order.whatsapp || "")}</strong></div>
    <div class="track-order-total"><span>ยอดรวม</span><span>${formatPrice(order.total)}</span></div>
    ${/* 🛡️ (added 2026-09-26): banner สถานะการชำระเงิน */ ""}
    ${paymentBanner}
    ${/* 🔧 (2026-09-16): แสดงกล่องดาวน์โหลด ZIP ถ้าออเดอร์มี zip_download_url และสถานะเป็น processing หรือ completed */ ""}
    ${(order.zip_download_url && (order.status === "processing" || order.status === "completed"))
      ? `<div class="track-order-zip" style="margin-top:10px;padding:10px;background:rgba(16,185,129,.08);border-radius:10px;">
          <div style="font-size:12px;color:var(--success);font-weight:600;margin-bottom:6px;">📦 ไฟล์เพลงพร้อมดาวน์โหลด</div>
          <a href="/api/track-download/${escapeHtml(order._docId || order.id || '')}" target="_blank" rel="noopener" class="btn zip-download-btn"><span class="zip-download-label">⬇️ ดาวน์โหลด ZIP</span><span class="zip-download-name">${escapeHtml(order.zip_file_name || 'Order.zip')}</span></a>
        </div>`
      : (order.status === "processing")
        ? `<div style="margin-top:10px;font-size:12px;color:var(--accent);">⏳ แอดมินกำลังเตรียมไฟล์ ZIP ส่งให้คุณ — รอสักครู่</div>`
        : (order.status === "pending_verify")
          ? `<div style="margin-top:10px;font-size:12px;color:var(--text-dim);">⏳ รอแอดมินตรวจสอบการโอนเงิน — หลังยืนยันแล้วไฟล์จะถูกเตรียมให้</div>`
          : ""}
    <div class="track-order-actions">
      <button class="btn" type="button" id="trackOrderReceiptBtn" style="background:linear-gradient(145deg, #38bdf8 0%, #2563eb 50%, #4338ca 100%);color:#fff;border:1px solid rgba(255,255,255,.25);box-shadow:0 4px 12px rgba(37,99,235,.45),inset 0 1px 0 rgba(255,255,255,.22);text-shadow:0 1px 2px rgba(0,0,0,.30);">📄 ดูใบเสร็จ</button>
      ${/* 🛡️ (added 2026-09-26): ซ่อนปุ่ม "ชำระเงิน" เมื่อ state เป็น paid / pending_review / verified_awaiting_zip */ ""}
      ${/*   ปุ่มยังแสดงเมื่อ state เป็น unpaid / rejected / cancelled (ลูกค้ายังชำระ/ส่งสลิปใหม่ได้) */ ""}
      ${paymentState.showPayButton ? `<button class="btn" type="button" id="trackOrderPayBtn" style="background:var(--accent);color:#fff;">💳 ชำระเงิน</button>` : ""}
      <button class="btn" type="button" id="trackOrderWhatsappBtn">ติดต่อแอดมินผ่าน WhatsApp</button>
      ${canCustomerDeleteOrder(order) ? `<button class="btn danger" type="button" id="trackOrderDeleteBtn">ลบออเดอร์นี้</button>` : ""}
    </div>
  `;
  resultEl.hidden = false;

  // 🆕 (2026-10-02 v7): ปุ่ม "📄 ดูใบเสร็จ" → เปิด receipt modal ผ่าน showReceipt
  const receiptBtn = document.getElementById("trackOrderReceiptBtn");
  if (receiptBtn) {
    receiptBtn.onclick = () => {
      const orderWithId = order._docId ? order : { ...order, _docId: order._docId || order.id };
      // ปิด track order backdrop ก่อน แล้วเปิด receipt modal
      const trackBackdrop = document.getElementById("trackOrderBackdrop");
      if (trackBackdrop) trackBackdrop.classList.remove("show");
      const trackAllBackdrop = document.getElementById("trackOrderAllBackdrop");
      if (trackAllBackdrop) trackAllBackdrop.classList.remove("show");
      showReceipt(orderWithId, order.receipt_number, STATE.settings.whatsapp_number);
    };
  }

  const waBtn = document.getElementById("trackOrderWhatsappBtn");
  if (waBtn) {
    waBtn.onclick = () => {
      const number = STATE.settings.whatsapp_number;
      if (!number) { showToast("ร้านยังไม่ได้ตั้งค่าเบอร์ WhatsApp", "error"); return; }
      window.open(buildWhatsAppLink(number, buildTrackOrderWhatsAppText(order)), "_blank", "noopener");
    };
  }

  // 📸 (added): ปุ่ม "💳 ชำระเงิน" — เปิด receipt modal (ที่มีปุ่ม payment ใหม่อยู่แล้ว)
  //   ใช้ฟังก์ชัน showReceipt ที่ export จาก initCart — ไม่ duplicate logic
  //   แสดงเฉพาะตอน status='pending_verify' หรือ 'cancelled' (เหมือนหน้าออเดอร์ทั้งหมด)
  // 🛡️ (added 2026-09-26): ปุ่มนี้จะถูกซ่อนจากด้านบนถ้า paymentState.showPayButton=false
  //   (paid / pending_review / verified_awaiting_zip)
  //   แต่ถ้าแสดงอยู่ → onclick ยังเปิด receipt modal ซึ่งจะเช็คสถานะซ้ำใน showReceipt/openPaymentModal
  const payBtn = document.getElementById("trackOrderPayBtn");
  if (payBtn) {
    payBtn.onclick = () => {
      const orderWithId = order._docId ? order : { ...order, _docId: order._docId || order.id };
      // ปิด track order backdrop ก่อน แล้วเปิด receipt modal ผ่าน showReceipt
      const trackBackdrop = document.getElementById("trackOrderBackdrop");
      if (trackBackdrop) trackBackdrop.classList.remove("show");
      const trackAllBackdrop = document.getElementById("trackOrderAllBackdrop");
      if (trackAllBackdrop) trackAllBackdrop.classList.remove("show");
      showReceipt(orderWithId, order.receipt_number, STATE.settings.whatsapp_number);
    };
  }

  const deleteBtn = document.getElementById("trackOrderDeleteBtn");
  if (deleteBtn) {
    deleteBtn.onclick = async () => {
      // 🔧 (2026-09-22 fix v3): อัปเดต UI ทุกส่วนทันที — list + badge + banner
      // 🎨 (2026-09-26): ใช้ customConfirm แทน window.confirm()
      const confirmed = await window.customConfirm(
        `ต้องการลบ Order ${order.receipt_number || ""} ใช่หรือไม่?\n\nเมื่อลบแล้วจะไม่สามารถกู้คืนได้`,
        { title: "ยืนยันการลบออเดอร์", okText: "ลบ", danger: true }
      );
      if (!confirmed) return;
      // 1. ลบจากหน้าจอทันที
      resultEl.hidden = true;
      resultEl.innerHTML = "";
      // 2. ลบจาก local state
      trackOrderAllOrders = trackOrderAllOrders.filter(o => o._docId !== order._docId);
      // 3. ลด badge ทันที (ไม่รอ fetch)
      const badgeEl = document.getElementById("trackOrderBadge");
      if (badgeEl && !badgeEl.hidden) {
        const currentCount = Number(badgeEl.textContent || "0");
        const newCount = Math.max(0, currentCount - 1);
        if (newCount > 0) {
          badgeEl.textContent = String(newCount);
        } else {
          badgeEl.hidden = true;
        }
      }
      // 4. ล้าง pending order banner ถ้าเป็นออเดอร์สุดท้าย
      //   🔧 (T-sync-bugs-fix-H5 2026-10-06): เดิมอ่าน key "music_store_last_order_v1" ตรง ๆ แต่ db-client.js
      //     migrate ลบไปแล้ว (ย้ายไป scoped key) → อ่านไม่เจอ → banner ยังแสดงออเดอร์ที่ลบไป
      //   วิธีแก้: ใช้ scopedStorageKey + getLastOrderRecord (sync กับ app-cart.js) แทนอ่านตรง ๆ
      //   ผลกระทบระบบเดิม: 0% — ไม่แตะ saveLastOrderRecord; แค่เปลี่ยนวิธีอ่าน/ลบ
      try {
        const scopedKey = scopedStorageKey("music_store_last_order_v1");
        const raw = localStorage.getItem(scopedKey);
        if (raw) {
          const lastOrder = JSON.parse(raw);
          if (lastOrder && lastOrder.order && lastOrder.order._docId === order._docId) {
            localStorage.removeItem(scopedKey);
          }
        }
      } catch (_) {}
      // 5. ซ่อน banner ทันที (ถ้าแสดงอยู่)
      const bannerEl = document.getElementById("pendingOrderBanner");
      if (bannerEl) bannerEl.hidden = true;
      // 6. ส่ง request ลบจริงใน background
      (async () => {
        try {
          await deleteDoc(doc(db, "orders", order._docId), {
            body: {
              customer_name: order.customer_name || "",
              whatsapp: order.whatsapp || "",
            },
          });
          showToast("ลบออเดอร์เรียบร้อยแล้ว", "success");
        } catch (err) {
          console.error("delete error:", err);
          showToast(getFriendlyErrorMessage(err), "error");
          // ถ้าลบไม่สำเร็จ → re-fetch เพื่อ restore
          if (window.__refreshTrackOrderBadge) window.__refreshTrackOrderBadge();
          fetchTrackOrderAllOnce();
        }
      })();
    };
  }
}

async function handleTrackOrderSubmit() {
  const idInput = document.getElementById("trackOrderId");
  const nameInput = document.getElementById("trackOrderName");
  const phoneInput = document.getElementById("trackOrderPhone");
  const btn = document.getElementById("trackOrderSubmitBtn");
  const resultEl = document.getElementById("trackOrderResult");

  const orderId = idInput.value.trim();
  const name = nameInput.value.trim();
  const phone = phoneInput.value.trim();

  if (resultEl) resultEl.hidden = true;
  setTrackOrderFeedback("");

  if (!orderId || !name || !phone) {
    setTrackOrderFeedback("กรุณากรอกเลข Order, ชื่อ และเบอร์โทรให้ครบ");
    return;
  }

  // เพิ่มใหม่: เช็คเน็ตก่อนยิง request กันลูกค้ารอเปล่าๆ ตอนไม่มีสัญญาณ
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    setTrackOrderFeedback("ไม่มีสัญญาณอินเทอร์เน็ต กรุณาตรวจสอบการเชื่อมต่อแล้วลองใหม่อีกครั้ง");
    return;
  }

  btn.disabled = true;
  btn.textContent = "กำลังค้นหา...";

  try {
    // 🔒 Security (2026-09-11): ใช้ queryCustomerOrder แทน getDocs ธรรมดา
    // Server ตรวจทั้ง receipt_number + customer_name + whatsapp พร้อมกัน คืนออเดอร์เดียวถ้าตรงทั้ง 3 ฟิลด์
    // กัน browser เห็นข้อมูลคนอื่น (เดิมโหลด collection "orders" ทั้งหมดมากรองฝั่ง client)
    const result = await withTimeout(
      queryCustomerOrder({ receiptNumber: orderId, customerName: name, whatsapp: phone }),
      15000
    );
    if (!result.exists) {
      setTrackOrderFeedback("ไม่พบออเดอร์นี้ กรุณาตรวจสอบเลข Order ชื่อ และเบอร์โทรให้ตรงกับตอนสั่งซื้อ");
      return;
    }
    const order = { ...result.data, _docId: result.id };
    setTrackOrderFeedback("");
    renderTrackOrderResult(order);
  } catch (err) {
    console.error("handleTrackOrderSubmit error:", err);
    setTrackOrderFeedback(getFriendlyErrorMessage(err));
  } finally {
    btn.disabled = false;
    btn.textContent = "ค้นหาออเดอร์";
  }
}

// ===== เพิ่มใหม่: ดูออเดอร์ทั้งหมดของฉัน แบบเรียลไทม์ (ฝั่งลูกค้า ไม่ต้อง Login) — ไม่แตะระบบเดิมด้านบน =====
// ใช้เบอร์โทร/WhatsApp ที่ผูกกับทุกออเดอร์อยู่แล้วเป็นตัวระบุ + เทียบชื่อคู่กันเหมือนโหมดค้นหาออเดอร์เดียว
//
// ⚠️ DEAD CODE (NO CALLER): trackOrderAllUnsub ด้านล่างเป็น dead state field
//   - เดิมเคยเก็บฟังก์ชัน unsubscribe ที่ได้จาก listenCustomerOrders() หรือ onSnapshot()
//   - 2026-09-17: ทุก caller ย้ายไปใช้ fetchCustomerOrdersOnce() (one-shot, ไม่มี unsubscribe)
//   - ปัจจุบัน: trackOrderAllUnsub ถูก set เป็น null เสมอ, ไม่เคยถูก assign ฟังก์ชัน unsubscribe จริง
//   - ที่ไม่ลบ: กฎของโปรเจกต์ "ห้ามลบโค้ดเพียงเพราะคิดว่าไม่ได้ใช้งาน"
//   - ถ้าอนาคตจะใช้ polling กลับมา: ต้อง assign ฟังก์ชัน unsubscribe จาก listenCustomerOrders()
//     ให้ trackOrderAllUnsub จริง ๆ ใน startTrackOrderAllListener() ถึงจะทำงาน
let trackOrderAllUnsub = null;      // ← DEAD CODE — ดูคอมเมนต์ด้านบน
let trackOrderAllOrders = [];       // เก็บผลลัพธ์ล่าสุดไว้ใช้ตอนกดดูรายละเอียดในลิสต์
let trackOrderAllSlowTimer = null;  // เพิ่มใหม่: ตัวจับเวลาแจ้งเตือน "เน็ตช้า" ของ listener ปัจจุบัน
// 🛡️ (added 2026-09-26 auto-open rejected): flag สำหรับ auto-open detail ของออเดอร์ที่ถูกปฏิเสธสลิป
//   ใช้ครั้งเดียวหลัง fetchTrackOrderAllOnce → ล้างหลังใช้ (กัน visibility change ทำซ้ำ)
let trackOrderAllAutoOpenRejected = false;
// 🔧 (2026-09-17): เก็บ name+phone ปัจจุบันไว้ใช้ตอน visibility เปลี่ยน (กลับเข้า tab ใหม่)
let trackOrderAllCurrentName = null;
let trackOrderAllCurrentPhone = null;
let trackOrderAllVisibilityHandler = null;  // visibility listener ของ Track Order All

function stopTrackOrderAllListener() {
  // 🔧 (2026-09-17): ไม่มี unsubscribe อีกต่อไป (one-shot fetch) — แต่ล้าง handler เก่าถ้ามี
  //
  // ⚠️ DEAD CODE BLOCK: if (trackOrderAllUnsub) { ... } ด้านล่าง — ไม่มีทางทำงานจริง
  //   - trackOrderAllUnsub ถูก set เป็น null เสมอ, ไม่เคยถูก assign ฟังก์ชัน unsubscribe จริง
  //   - เดิมเคยใช้ตอน listener เป็น polling (listenCustomerOrders/onSnapshot)
  //   - ปัจจุบัน: ทุก caller ใช้ fetchCustomerOrdersOnce() แบบ one-shot, ไม่มี unsubscribe ต้องล้าง
  //   - ที่ไม่ลบ: กฎของโปรเจกต์ "ห้ามลบโค้ดเพียงเพราะคิดว่าไม่ได้ใช้งาน"
  //   - ถ้าจะลบ: ลบได้ทั้ง block (บรรทัด if ถึง } ปิด) และ field declaration ด้านบน (trackOrderAllUnsub)
  //     ไม่กระทบระบบเดิมเพราะไม่มี caller จริง — แต่ต้องลบทั้งคู่พร้อมกัน
  if (trackOrderAllUnsub) {
    try { trackOrderAllUnsub(); } catch (err) { /* เพิกเฉย ถ้ายกเลิกซ้ำ */ }
    trackOrderAllUnsub = null;
  }
  if (trackOrderAllSlowTimer) {
    clearTimeout(trackOrderAllSlowTimer);
    trackOrderAllSlowTimer = null;
  }
  // ล้าง visibility listener ด้วย (ตั้งไว้ใน startTrackOrderAllListener)
  if (trackOrderAllVisibilityHandler) {
    document.removeEventListener("visibilitychange", trackOrderAllVisibilityHandler);
    trackOrderAllVisibilityHandler = null;
  }
  // ล้าง state ปัจจุบันเพื่อกัน refresh โดยไม่ตั้งใจ
  trackOrderAllCurrentName = null;
  trackOrderAllCurrentPhone = null;
}

function setTrackOrderAllFeedback(message, type) {
  const el = document.getElementById("trackOrderAllFeedback");
  if (!el) return;
  el.textContent = message || "";
  el.style.color = type === "success" ? "var(--success)" : "var(--danger)";
}

function switchTrackOrderMode(mode) {
  const singleBtn = document.getElementById("trackOrderModeSingleBtn");
  const allBtn = document.getElementById("trackOrderModeAllBtn");
  const singleView = document.getElementById("trackOrderSingleView");
  const allView = document.getElementById("trackOrderAllView");
  if (!singleBtn || !allBtn || !singleView || !allView) return;

  const isAll = mode === "all";
  singleBtn.classList.toggle("active", !isAll);
  singleBtn.setAttribute("aria-selected", String(!isAll));
  allBtn.classList.toggle("active", isAll);
  allBtn.setAttribute("aria-selected", String(isAll));
  singleView.hidden = isAll;
  allView.hidden = !isAll;

  // ออกจากโหมด "ทั้งหมด" แล้ว ให้ปิด listener เรียลไทม์เพื่อไม่ให้ทำงานเปล่าๆ เบื้องหลัง
  if (!isAll) stopTrackOrderAllListener();
}

// 🔧 (2026-09-26) เพิ่มใหม่: เปิด modal "ติดตามออเดอร์" ตรงไปที่โหมด "ออเดอร์ทั้งหมดของฉัน" ทันที
//   เรียกจากปุ่ม "ไปชำระเงิน" บนแถบเตือน (pendingOrderBanner ใน app-cart.js ผ่าน callback openTrackOrderAllPicker)
//   ใช้ชื่อ+เบอร์ที่จำไว้แล้ว (TRACK_ORDER_BADGE_INFO_KEY เดียวกับที่ badge ใช้) auto-fill + fetch ให้เลย
//   ไม่ต้องให้ลูกค้าพิมพ์ซ้ำ — reuse loadTrackOrderInfoForBadge()/startTrackOrderAllListener() ที่มีอยู่แล้ว
//   (ไม่สร้างระบบดึงข้อมูลใหม่)
function openPendingPaymentPicker() {
  const backdrop = document.getElementById("trackOrderBackdrop");
  if (backdrop) backdrop.classList.add("show");
  switchTrackOrderMode("all");
  const info = loadTrackOrderInfoForBadge();
  if (info && info.name && info.whatsapp) {
    const nameInput = document.getElementById("trackOrderAllName");
    const phoneInput = document.getElementById("trackOrderAllPhone");
    if (nameInput) nameInput.value = info.name;
    if (phoneInput) phoneInput.value = info.whatsapp;
    // 🛡️ (added 2026-09-26 auto-open rejected): หลัง fetch ออเดอร์ทั้งหมด → ถ้ามีออเดอร์ที่ถูกปฏิเสธสลิป
    //   ให้เปิด detail ของออเดอร์นั้นโดยตรง ไม่ต้องให้ลูกค้าเลือกจาก list
    //   ตามคำขอผู้ใช้: "เวลาแอดมินปฏิเสธสลิป กลับมาแสดงว่าการยืนยันสลิปถูกปฏิเสธ เวลากดเข้าให้พาไปออเดอร์ที่ถูกปฏิเสธ"
    //   ถ้ามีหลายออเดอร์ที่ถูกปฏิเสธ → พาไปออเดอร์ล่าสุด (created_at desc)
    //   ถ้าไม่มีออเดอร์ถูกปฏิเสธ → แสดง list ตามปกติ (sort ใหม่ให้ unpaid บนสุด)
    startTrackOrderAllListener(info.name, info.whatsapp, { autoOpenRejected: true });
  }
  // ถ้าไม่มีข้อมูลจำไว้ (กรณีหายาก เพราะต้องมีข้อมูลนี้อยู่แล้วถึงจะคำนวณ banner ได้ตั้งแต่แรก)
  // ก็แค่เปิดโหมด "ทั้งหมด" ให้เปล่าๆ ลูกค้ากรอกเองได้ตามปกติ
}

function renderTrackOrderAllList(orders) {
  const listEl = document.getElementById("trackOrderAllList");
  if (!listEl) return;

  if (!orders.length) {
    listEl.innerHTML = `<div class="track-order-all-empty">ยังไม่พบออเดอร์ของคุณ</div>`;
    listEl.hidden = false;
    return;
  }

  listEl.innerHTML = orders.map((order, index) => {
    const cfg = TRACK_STATUS_CONFIG[order.status] || TRACK_STATUS_CONFIG.pending_verify;
    const dateStr = order.created_at ? new Date(order.created_at).toLocaleDateString("th-TH", { day: "2-digit", month: "2-digit", year: "numeric" }) : "";
    // 🛡️ (added 2026-09-26 prevent double payment): เพิ่ม payment badge ย่อยบน card
    //   ทำให้ลูกค้าเห็นสถานะการชำระเงินทันทีใน list โดยไม่ต้องคลิกเข้าแต่ละออเดอร์
    //   - paid → "✅ ชำระแล้ว" (เขียว)
    //   - verified_awaiting_zip → "✅ ยืนยันแล้ว" (เขียว) — แอดมินยืนยันสลิปแล้ว รอเตรียมไฟล์
    //   - pending_review → "📸 ส่งสลิปแล้ว" (เหลือง) — รอแอดมินตรวจสอบ
    //   - rejected → "⚠️ สลิปถูกปฏิเสธ" (แดง)
    //   - unpaid/cancelled → ไม่แสดง badge เพิ่ม (ใช้ status badge หลักอย่างเดียว)
    const pState = getOrderPaymentState(order);
    let paymentBadgeHtml = "";
    if (pState.state === "paid") {
      paymentBadgeHtml = `<span style="font-size:10px;padding:2px 6px;border-radius:8px;background:rgba(41,204,113,.15);color:var(--success);font-weight:600;">✅ ชำระแล้ว</span>`;
    } else if (pState.state === "verified_awaiting_zip") {
      paymentBadgeHtml = `<span style="font-size:10px;padding:2px 6px;border-radius:8px;background:rgba(41,204,113,.15);color:var(--success);font-weight:600;">✅ ยืนยันแล้ว</span>`;
    } else if (pState.state === "pending_review") {
      paymentBadgeHtml = `<span style="font-size:10px;padding:2px 6px;border-radius:8px;background:rgba(245,180,0,.15);color:#F5B400;font-weight:600;">📸 ส่งสลิปแล้ว</span>`;
    } else if (pState.state === "rejected") {
      paymentBadgeHtml = `<span style="font-size:10px;padding:2px 6px;border-radius:8px;background:rgba(239,68,68,.15);color:var(--danger);font-weight:600;">⚠️ สลิปถูกปฏิเสธ</span>`;
    }
    // 🆕 (2026-10-02 v7): ปุ่ม "⬇️ ดาวน์โหลดเพลง" — แสดงเฉพาะออเดอร์สำเร็จที่มี zip_download_url
    const canDownload = order.zip_download_url && (order.status === "processing" || order.status === "completed");
    const downloadBtnHtml = canDownload
      ? `<a href="/api/track-download/${escapeHtml(order._docId || order.id || '')}" target="_blank" rel="noopener" data-track-download="${index}" class="btn list-download-btn">⬇️ ดาวน์โหลดเพลง</a>`
      : "";
    return `
      <div class="track-order-all-card" role="button" tabindex="0" data-track-all-index="${index}">
        <div class="track-order-all-card-top">
          <span class="track-order-all-card-id">${escapeHtml(order.receipt_number || "")}</span>
          <span class="track-order-all-card-status" style="color:${cfg.color};background:${cfg.bg};">${cfg.emoji} ${escapeHtml(cfg.label)}</span>
        </div>
        ${paymentBadgeHtml ? `<div style="margin-top:4px;">${paymentBadgeHtml}</div>` : ""}
        <div class="track-order-all-card-bottom">
          <span>${escapeHtml(dateStr)}</span>
          <span>${formatPrice(order.total)}</span>
        </div>
        ${downloadBtnHtml}
      </div>
    `;
  }).join("");
  listEl.hidden = false;

  // 🆕 (v7): ปุ่ม "ดาวน์โหลดเพลง" — หยุด event propagation กันเปิด detail พร้อมกัน
  listEl.querySelectorAll("[data-track-download]").forEach(btn => {
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      const url = btn.getAttribute("href");
      if (url) window.open(url, "_blank", "noopener");
    });
  });

  listEl.querySelectorAll("[data-track-all-index]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const order = trackOrderAllOrders[Number(btn.getAttribute("data-track-all-index"))];
      if (order) openTrackOrderAllDetail(order);
    });
  });
}

function openTrackOrderAllDetail(order) {
  const listEl = document.getElementById("trackOrderAllList");
  const detailEl = document.getElementById("trackOrderAllDetail");
  const contentEl = document.getElementById("trackOrderAllDetailContent");
  if (!detailEl || !contentEl) return;

  const cfg = TRACK_STATUS_CONFIG[order.status] || TRACK_STATUS_CONFIG.pending_verify;
  // 🛡️ (added 2026-09-26 prevent double payment): คำนวณสถานะการชำระเงิน (เหมือน renderTrackOrderResult)
  //   ใช้ helper getOrderPaymentState() จาก app-cart.js → ซ่อนปุ่ม "ชำระเงิน" + แสดง banner
  const paymentState = getOrderPaymentState(order);
  const items = order.items || [];
  const itemsHtml = items.map(item => `
    <div class="track-order-item">
      <span class="track-order-item-name">${escapeHtml(item.title || "เพลง")}</span>
      <span class="track-order-item-price">${formatPrice(item.price)}</span>
    </div>
  `).join("");

  // 🛡️ (added 2026-09-26): banner สถานะการชำระเงิน (เหมือน renderTrackOrderResult)
  const paymentBanner = (paymentState.message || paymentState.warning)
    ? `<div style="margin-top:10px;padding:12px;border-radius:8px;border:1px solid ${paymentState.color};background:${paymentState.bg};color:${paymentState.color};">
        <div style="font-weight:700;font-size:14px;">${escapeHtml(paymentState.label)}</div>
        ${paymentState.message ? `<div style="font-size:13px;margin-top:6px;line-height:1.5;">${escapeHtml(paymentState.message)}</div>` : ""}
        ${paymentState.warning ? `<div style="font-size:13px;margin-top:6px;line-height:1.5;font-weight:600;">${escapeHtml(paymentState.warning)}</div>` : ""}
        ${paymentState.customHtml || ""}
      </div>`
    : "";

  contentEl.innerHTML = `
    <div class="track-order-status" style="color:${cfg.color};background:${cfg.bg};">${cfg.emoji} ${escapeHtml(cfg.label)}</div>
    <div class="track-order-row"><span>เลข Order</span><strong>${escapeHtml(order.receipt_number || "")}</strong></div>
    <div class="track-order-row"><span>ชื่อลูกค้า</span><strong>${escapeHtml(order.customer_name || "")}</strong></div>
    <div class="track-order-row"><span>เบอร์โทร</span><strong>${escapeHtml(order.whatsapp || "")}</strong></div>
    <div class="track-order-total"><span>ยอดรวม</span><span>${formatPrice(order.total)}</span></div>
    ${/* 🛡️ (added 2026-09-26): banner สถานะการชำระเงิน */ ""}
    ${paymentBanner}
    ${/* 🔧 (2026-10-02 v7): แสดงกล่องดาวน์โหลด ZIP ใน detail ของ trackOrderAll (เหมือน renderTrackOrderResult) */ ""}
    ${(order.zip_download_url && (order.status === "processing" || order.status === "completed"))
      ? `<div class="track-order-zip" style="margin-top:10px;padding:10px;background:rgba(16,185,129,.08);border-radius:10px;">
          <div style="font-size:12px;color:var(--success);font-weight:600;margin-bottom:6px;">📦 ไฟล์เพลงพร้อมดาวน์โหลด</div>
          <a href="/api/track-download/${escapeHtml(order._docId || order.id || '')}" target="_blank" rel="noopener" class="btn zip-download-btn"><span class="zip-download-label">⬇️ ดาวน์โหลด ZIP</span><span class="zip-download-name">${escapeHtml(order.zip_file_name || 'Order.zip')}</span></a>
        </div>`
      : (order.status === "processing")
        ? `<div style="margin-top:10px;font-size:12px;color:var(--accent);">⏳ แอดมินกำลังเตรียมไฟล์ ZIP ส่งให้คุณ — รอสักครู่</div>`
        : (order.status === "pending_verify")
          ? `<div style="margin-top:10px;font-size:12px;color:var(--text-dim);">⏳ รอแอดมินตรวจสอบการโอนเงิน — หลังยืนยันแล้วไฟล์จะถูกเตรียมให้</div>`
          : ""}
    <div class="track-order-actions">
      <button class="btn" type="button" id="trackOrderAllReceiptBtn" style="background:linear-gradient(145deg, #38bdf8 0%, #2563eb 50%, #4338ca 100%);color:#fff;border:1px solid rgba(255,255,255,.25);box-shadow:0 4px 12px rgba(37,99,235,.45),inset 0 1px 0 rgba(255,255,255,.22);text-shadow:0 1px 2px rgba(0,0,0,.30);">📄 ดูใบเสร็จ</button>
      ${/* 🛡️ (added 2026-09-26): ซ่อนปุ่ม "ชำระเงิน" เมื่อ state เป็น paid/pending_review/verified_awaiting_zip */ ""}
      ${paymentState.showPayButton ? `<button class="btn" type="button" id="trackOrderAllPayBtn" style="background:var(--accent);color:#fff;">💳 ชำระเงิน</button>` : ""}
      <button class="btn" type="button" id="trackOrderAllWhatsappBtn">ติดต่อแอดมินผ่าน WhatsApp</button>
      ${canCustomerDeleteOrder(order) ? `<button class="btn danger" type="button" id="trackOrderAllDeleteBtn">ลบออเดอร์นี้</button>` : ""}
    </div>
  `;

  if (listEl) listEl.hidden = true;
  detailEl.hidden = false;

  // 🆕 (2026-10-02 v7): ปุ่ม "📄 ดูใบเสร็จ" → เปิด receipt modal ผ่าน showReceipt
  const receiptBtn = document.getElementById("trackOrderAllReceiptBtn");
  if (receiptBtn) {
    receiptBtn.onclick = () => {
      const orderWithId = order._docId ? order : { ...order, _docId: order._docId || order.id };
      // ปิด track order backdrop ก่อน แล้วเปิด receipt modal
      const trackBackdrop = document.getElementById("trackOrderBackdrop");
      if (trackBackdrop) trackBackdrop.classList.remove("show");
      const trackAllBackdrop = document.getElementById("trackOrderAllBackdrop");
      if (trackAllBackdrop) trackAllBackdrop.classList.remove("show");
      showReceipt(orderWithId, order.receipt_number, STATE.settings.whatsapp_number);
    };
  }

  const waBtn = document.getElementById("trackOrderAllWhatsappBtn");
  if (waBtn) {
    waBtn.onclick = () => {
      const number = STATE.settings.whatsapp_number;
      if (!number) { showToast("ร้านยังไม่ได้ตั้งค่าเบอร์ WhatsApp", "error"); return; }
      window.open(buildWhatsAppLink(number, buildTrackOrderWhatsAppText(order)), "_blank", "noopener");
    };
  }

  // 📸 (added STEP 2): ปุ่ม "💳 ชำระเงิน" — เปิด receipt modal (ที่มีปุ่ม payment ใหม่อยู่แล้ว)
  //   ใช้ฟังก์ชัน showReceipt ที่ export จาก initCart — ไม่ต้อง duplicate logic
  // 🛡️ (added 2026-09-26): ปุ่มนี้จะถูกซ่อนจากด้านบนถ้า paymentState.showPayButton=false
  //   (paid / pending_review / verified_awaiting_zip)
  //   แต่ถ้าแสดงอยู่ → onclick ยังเปิด receipt modal ซึ่งจะเช็คสถานะซ้ำใน showReceipt/openPaymentModal
  const payBtn = document.getElementById("trackOrderAllPayBtn");
  if (payBtn) {
    payBtn.onclick = () => {
      const orderWithId = order._docId ? order : { ...order, _docId: order._docId || order.id };
      // ปิด track order backdrop ก่อน แล้วเปิด receipt modal ผ่าน showReceipt
      const trackBackdrop = document.getElementById("trackOrderBackdrop");
      if (trackBackdrop) trackBackdrop.classList.remove("show");
      const trackAllBackdrop = document.getElementById("trackOrderAllBackdrop");
      if (trackAllBackdrop) trackAllBackdrop.classList.remove("show");
      showReceipt(orderWithId, order.receipt_number, STATE.settings.whatsapp_number);
    };
  }

  const deleteBtn = document.getElementById("trackOrderAllDeleteBtn");
  if (deleteBtn) {
    deleteBtn.onclick = async () => {
      // 🔧 (2026-09-22 fix v3): อัปเดต UI ทุกส่วนทันที — list + badge + banner
      // 🎨 (2026-09-26): ใช้ customConfirm แทน window.confirm()
      const confirmed = await window.customConfirm(
        `ต้องการลบ Order ${order.receipt_number || ""} ใช่หรือไม่?\n\nเมื่อลบแล้วจะไม่สามารถกู้คืนได้`,
        { title: "ยืนยันการลบออเดอร์", okText: "ลบ", danger: true }
      );
      if (!confirmed) return;
      // 1. ลบจาก local array ทันที
      trackOrderAllOrders = trackOrderAllOrders.filter(o => o._docId !== order._docId);
      // 2. ปิด detail กลับไปลิสต์
      closeTrackOrderAllDetail();
      // 3. re-render ลิสต์ทันที
      renderTrackOrderAllList(trackOrderAllOrders);
      // 4. ลด badge ทันที (ไม่รอ fetch)
      const badgeEl = document.getElementById("trackOrderBadge");
      if (badgeEl && !badgeEl.hidden) {
        const currentCount = Number(badgeEl.textContent || "0");
        const newCount = Math.max(0, currentCount - 1);
        if (newCount > 0) {
          badgeEl.textContent = String(newCount);
        } else {
          badgeEl.hidden = true;
        }
      }
      // 5. ล้าง pending order banner ถ้าเป็นออเดอร์ที่ลบ
      //   🔧 (T-sync-bugs-fix-H5 2026-10-06): เดิมอ่าน key "music_store_last_order_v1" ตรง ๆ แต่ db-client.js
      //     migrate ลบไปแล้ว → อ่านไม่เจอ → banner ยังแสดงออเดอร์ที่ลบ
      //   วิธีแก้: ใช้ scopedStorageKey (sync กับ app-cart.js saveLastOrderRecord) แทนอ่านตรง ๆ
      //   ผลกระทบระบบเดิม: 0% — ไม่แตะ saveLastOrderRecord; แค่เปลี่ยนวิธีอ่าน/ลบ
      try {
        const scopedKey = scopedStorageKey("music_store_last_order_v1");
        const raw = localStorage.getItem(scopedKey);
        if (raw) {
          const lastOrder = JSON.parse(raw);
          if (lastOrder && lastOrder.order && lastOrder.order._docId === order._docId) {
            localStorage.removeItem(scopedKey);
          }
        }
      } catch (_) {}
      // 6. ซ่อน banner ทันที (ถ้าแสดงอยู่)
      const bannerEl = document.getElementById("pendingOrderBanner");
      if (bannerEl) bannerEl.hidden = true;
      // 7. ส่ง request ลบจริงใน background
      (async () => {
        try {
          await deleteDoc(doc(db, "orders", order._docId), {
            body: {
              customer_name: order.customer_name || "",
              whatsapp: order.whatsapp || "",
            },
          });
          showToast("ลบออเดอร์เรียบร้อยแล้ว", "success");
        } catch (err) {
          console.error("delete error:", err);
          showToast(getFriendlyErrorMessage(err), "error");
          // ถ้าลบไม่สำเร็จ → re-fetch + restore badge
          if (window.__refreshTrackOrderBadge) window.__refreshTrackOrderBadge();
          fetchTrackOrderAllOnce();
        }
      })();
    };
  }
}

function closeTrackOrderAllDetail() {
  const listEl = document.getElementById("trackOrderAllList");
  const detailEl = document.getElementById("trackOrderAllDetail");
  if (detailEl) detailEl.hidden = true;
  if (listEl) listEl.hidden = false;
}

function startTrackOrderAllListener(name, phone, options = {}) {
  stopTrackOrderAllListener();
  const listEl = document.getElementById("trackOrderAllList");
  const detailEl = document.getElementById("trackOrderAllDetail");
  if (listEl) listEl.hidden = true;
  if (detailEl) detailEl.hidden = true;

  // 🔧 (2026-09-17): บันทึก name+phone ไว้ใช้ตอน visibility เปลี่ยน (กลับเข้า tab ใหม่)
  trackOrderAllCurrentName = name;
  trackOrderAllCurrentPhone = phone;
  // 🛡️ (added 2026-09-26 auto-open rejected): เก็บ option ไว้ใช้หลัง fetchTrackOrderAllOnce
  //   ถ้า autoOpenRejected=true → หลัง fetch แล้วถ้ามีออเดอร์ state='rejected' ให้เปิด detail ของออเดอร์นั้นโดยตรง
  //   ใช้ครั้งเดียว → ล้างหลังใช้ (กัน visibility change ทำซ้ำ)
  trackOrderAllAutoOpenRejected = !!options.autoOpenRejected;

  // เพิ่มใหม่: ถ้ายังไม่ได้รับข้อมูล snapshot แรกภายในเวลาที่กำหนด แจ้งลูกค้าว่าเน็ตช้า (ยังฟังต่อเบื้องหลัง ไม่ยกเลิก)
  trackOrderAllSlowTimer = setTimeout(() => {
    setTrackOrderAllFeedback("เชื่อมต่อระบบช้ากว่าปกติ กรุณาตรวจสอบอินเทอร์เน็ต (ระบบกำลังลองเชื่อมต่ออยู่)", "error");
  }, 15000);

  // ยิง one-shot fetch ครั้งแรก
  fetchTrackOrderAllOnce();

  // 🔧 (2026-09-17): เพิ่ม visibility listener — เมื่อลูกค้าสลับ tab แล้วกลับมา (ขณะ modal เปิดอยู่) ให้ refresh ทันที
  // กัน listener ซ้ำ: เก็บไว้ใน trackOrderAllVisibilityHandler แล้วลบก่อนผูกใหม่
  if (trackOrderAllVisibilityHandler) {
    document.removeEventListener("visibilitychange", trackOrderAllVisibilityHandler);
  }
  trackOrderAllVisibilityHandler = () => {
    if (document.visibilityState !== "visible") return;
    if (!trackOrderAllCurrentName || !trackOrderAllCurrentPhone) return;
    // ตรวจว่า modal ยังเปิดอยู่ก่อน refresh กัน refresh ที่ไม่จำเป็น
    const backdrop = document.getElementById("trackOrderBackdrop");
    if (!backdrop || !backdrop.classList.contains("show")) return;
    fetchTrackOrderAllOnce();
  };
  document.addEventListener("visibilitychange", trackOrderAllVisibilityHandler);
}

// 🔧 (2026-09-17): แยก fetchTrackOrderAllOnce ออกมาจาก startTrackOrderAllListener เพื่อ reuse
//   (ใช้ทั้งตอนเริ่ม, ตอน visibility เปลี่ยน, และตอนหลังลบออเดอร์)
// ทำงาน: ดึงออเดอร์ทั้งหมดของลูกค้าครั้งเดียว (one-shot) → render ลิสต์
// ไม่มี polling ต่อเนื่อง — ลด D1 quota อย่างมาก
async function fetchTrackOrderAllOnce() {
  if (!trackOrderAllCurrentName || !trackOrderAllCurrentPhone) return;
  try {
    // 🔒 Security (2026-09-11): ใช้ fetchCustomerOrdersOnce แทน listenCustomerOrders polling
    // Server กรองเฉพาะออเดอร์ของลูกค้าคนนี้ส่งกลับมา (เทียบชื่อ+เบอร์แบบ normalize ฝั่ง Server)
    // กัน browser เห็นข้อมูลคนอื่นทั้งหมด (เดิมโหลด collection "orders" มากรองเองฝั่ง client)
    const { snap } = await fetchCustomerOrdersOnce({
      customerName: trackOrderAllCurrentName,
      whatsapp: trackOrderAllCurrentPhone,
    });
    clearTimeout(trackOrderAllSlowTimer);
    trackOrderAllSlowTimer = null;
    const matched = snap.docs
      .map((d) => ({ ...d.data(), _docId: d.id }));
    // 🛡️ (added 2026-09-26 sort rejected first): จัดเรียงให้ออเดอร์ที่ถูกปฏิเสธสลิป (state='rejected')
    //   ขึ้นมาก่อนเสมอ เพื่อให้ลูกค้าเห็นออเดอร์ที่ต้องส่งสลิปใหม่ทันที
    //   ลำดับการ sort:
    //     1. state 'rejected' (สลิปถูกปฏิเสธ) — เรียงตาม created_at desc
    //     2. state 'unpaid' (ยังไม่ได้ชำระ) — เรียงตาม created_at desc
    //     3. state 'cancelled' (ออเดอร์ถูกยกเลิก) — เรียงตาม created_at desc
    //     4. state 'pending_review' (ส่งสลิปแล้วรอตรวจ) — เรียงตาม created_at desc
    //     5. state 'verified_awaiting_zip' (ยืนยันแล้วรอไฟล์) — เรียงตาม created_at desc
    //     6. state 'paid' (ชำระแล้ว) — เรียงตาม created_at desc
    //   ผลกระทบระบบเดิม: 0% — เปลี่ยนแค่ลำดับการ sort ไม่ได้ลบ/เพิ่มฟิลด์
    matched.sort((a, b) => {
      const aState = getOrderPaymentState(a).state;
      const bState = getOrderPaymentState(b).state;
      // กำหนด priority ตามลำดับที่ต้องการให้แสดงบนสุด
      const priority = {
        rejected: 1, unpaid: 2, cancelled: 3,
        pending_review: 4, verified_awaiting_zip: 5, paid: 6,
      };
      const aPriority = priority[aState] || 99;
      const bPriority = priority[bState] || 99;
      if (aPriority !== bPriority) return aPriority - bPriority;
      // ถ้า priority เท่ากัน → เรียงตาม created_at desc (ออเดอร์ใหม่ก่อน)
      return new Date(b.created_at || 0) - new Date(a.created_at || 0);
    });
    trackOrderAllOrders = matched;
    setTrackOrderAllFeedback("");
    renderTrackOrderAllList(matched);
    // 🛡️ (added 2026-09-26 auto-open rejected): ถ้า flag เปิดอยู่ → หาออเดอร์ที่ถูกปฏิเสธสลิป
    //   แล้วเปิด detail โดยตรง ไม่ต้องให้ลูกค้าเลือกจาก list
    //   ใช้ครั้งเดียว → ล้าง flag หลังใช้ (กัน visibility change ทำซ้ำ)
    if (trackOrderAllAutoOpenRejected) {
      trackOrderAllAutoOpenRejected = false; // ล้างก่อนเพื่อกัน double-trigger
      // หาออเดอร์ที่ state='rejected' (สลิปถูกปฏิเสธ) — list ถูก sort ให้ rejected อยู่บนสุดอยู่แล้ว
      // ถ้ามีหลายใบ → เลือกใบแรก (ล่าสุด) ตามที่ sort ไว้
      const rejectedOrder = matched.find((o) => getOrderPaymentState(o).state === "rejected");
      if (rejectedOrder) {
        // ใช้ setTimeout เพื่อให้ renderTrackOrderAllList ทำงานเสร็จก่อน แล้วค่อยเปิด detail
        // (openTrackOrderAllDetail จะซ่อน list + แสดง detail)
        setTimeout(() => openTrackOrderAllDetail(rejectedOrder), 50);
      }
      // ถ้าไม่มีออเดอร์ถูกปฏิเสธ → แสดง list ตามปกติ (sort ใหม่ให้ unpaid บนสุด)
    }
  } catch (err) {
    clearTimeout(trackOrderAllSlowTimer);
    trackOrderAllSlowTimer = null;
    console.error("fetchTrackOrderAllOnce error:", err);
    setTrackOrderAllFeedback(getFriendlyErrorMessage(err));
  }
}

async function handleTrackOrderAllSubmit() {
  const nameInput = document.getElementById("trackOrderAllName");
  const phoneInput = document.getElementById("trackOrderAllPhone");
  const btn = document.getElementById("trackOrderAllSubmitBtn");

  const name = nameInput.value.trim();
  const phoneRaw = phoneInput.value.trim();
  const phone = normalizePhone(phoneRaw);

  setTrackOrderAllFeedback("");
  document.getElementById("trackOrderAllList").hidden = true;
  document.getElementById("trackOrderAllDetail").hidden = true;

  // เพิ่มใหม่: เช็คเน็ตก่อนเริ่มฟัง realtime กันลูกค้ารอเปล่าๆ ตอนไม่มีสัญญาณ
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    setTrackOrderAllFeedback("ไม่มีสัญญาณอินเทอร์เน็ต กรุณาตรวจสอบการเชื่อมต่อแล้วลองใหม่อีกครั้ง");
    return;
  }

  if (!name || !phoneRaw) {
    setTrackOrderAllFeedback("กรุณากรอกชื่อและเบอร์โทรให้ครบ");
    return;
  }

  // 🆕 (2026-10-02 v7): บันทึกชื่อ+เบอร์ลง localStorage เพื่อ preload ครั้งต่อไป (เก็บในเครื่องของลูกค้า)
  try {
    localStorage.setItem("miusic_track_all_name", name);
    localStorage.setItem("miusic_track_all_phone", phoneRaw);
  } catch (_) {} // localStorage อาจถูก block ในบาง browser → ข้ามไป

  btn.disabled = true;
  btn.textContent = "กำลังโหลด...";
  try {
    startTrackOrderAllListener(name, phone);
  } finally {
    btn.disabled = false;
    btn.textContent = "ดูออเดอร์ทั้งหมด";
  }
}

const trackOrderModeSingleBtnEl = document.getElementById("trackOrderModeSingleBtn");
if (trackOrderModeSingleBtnEl) trackOrderModeSingleBtnEl.addEventListener("click", () => switchTrackOrderMode("single"));
const trackOrderModeAllBtnEl = document.getElementById("trackOrderModeAllBtn");
if (trackOrderModeAllBtnEl) trackOrderModeAllBtnEl.addEventListener("click", () => switchTrackOrderMode("all"));
const trackOrderAllSubmitBtnEl = document.getElementById("trackOrderAllSubmitBtn");
if (trackOrderAllSubmitBtnEl) trackOrderAllSubmitBtnEl.addEventListener("click", handleTrackOrderAllSubmit);
const trackOrderAllBackBtnEl = document.getElementById("trackOrderAllBackBtn");
if (trackOrderAllBackBtnEl) trackOrderAllBackBtnEl.addEventListener("click", closeTrackOrderAllDetail);

// 🆕 (T014): ลบ click handler ของปุ่ม #trackOrderBtn ออก — ปุ่มถูกลบจาก topbar แล้วใน index.html
//    ฟีเจอร์ "ค้นหาด้วยเลขใบเสร็จ" ย้ายไปอยู่ใน tab ออเดอร์ (#myOrdersView) แทน — ดู app-promotion.js renderMyOrdersForm()
//    หมายเหตุ: openTrackOrder/closeTrackOrder/trackOrderBackdrop/modal ยังคงไว้ — อาจถูกเรียกจากที่อื่น เช่น pending order banner
//    badge function (updateTrackOrderBadge/initTrackOrderBadgeListener/fetchTrackOrderBadgeOnce) ยังคงไว้ —
//    เพราะยังถูกใช้ผ่าน window.__updateTrackOrderBadge และ window.__refreshTrackOrderBadge (จาก app-promotion.js + app-cart.js)
//    badge element ที่ถูกลบ → updateTrackOrderBadge early-return เมื่อ getElementById("trackOrderBadge") คืน null — ไม่พัง
const trackOrderCloseEl = document.getElementById("trackOrderClose");
if (trackOrderCloseEl) trackOrderCloseEl.addEventListener("click", closeTrackOrder);
const trackOrderBackdropEl = document.getElementById("trackOrderBackdrop");
if (trackOrderBackdropEl) {
  trackOrderBackdropEl.addEventListener("click", (e) => { if (e.target === e.currentTarget) closeTrackOrder(); });
}
const trackOrderSubmitBtnEl = document.getElementById("trackOrderSubmitBtn");
if (trackOrderSubmitBtnEl) trackOrderSubmitBtnEl.addEventListener("click", handleTrackOrderSubmit);

// 🔧 (2026-09-17): Badge บนปุ่ม "ติดตามออเดอร์" (trackOrderBtn) — แสดงจำนวนออเดอร์ที่ "active"
// นับเฉพาะสถานะ: pending_verify (เหลือง - รอตรวจสอบการโอน) + processing (ฟ้า - โอนแล้ว รอส่งเพลง)
// ไม่นับ: completed (เขียว - สำเร็จ) + cancelled (แดง - ยกเลิก)
//
// ⚠️ 2026-09-17 (แก้ Future 4): เดิม polling ทุก 4 วิตลอดเวลา → กิน D1 quota มาก
//   เปลี่ยนเป็น one-shot fetch + visibility listener:
//   - ดึงครั้งเดียวตอนโหลดหน้า
//   - ดึงครั้งเดียวหลัง checkout (ผ่าน window.__refreshTrackOrderBadge)
//   - ดึงครั้งเดียวตอนลูกค้ากลับเข้า tab (visibilitychange)
//   ไม่มี polling ต่อเนื่อง — ลด quota ได้มาก
const TRACK_ORDER_BADGE_INFO_KEY = "music_store_my_orders_info_v1"; // reuse key เดียวกับ app-promotion.js (เก็บ name+whatsapp)

function loadTrackOrderInfoForBadge() {
  try {
    const raw = localStorage.getItem(TRACK_ORDER_BADGE_INFO_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (_) { return null; }
}

// อัปเดต badge element — รับ count ของออเดอร์ที่ active (pending_verify + processing)
// count > 0 → แสดงตัวเลข / count === 0 → ซ่อน badge
function updateTrackOrderBadge(count) {
  const badgeEl = document.getElementById("trackOrderBadge");
  if (!badgeEl) return;
  if (count > 0) {
    badgeEl.textContent = String(count);
    badgeEl.hidden = false;
  } else {
    badgeEl.hidden = true;
  }
}

// 🔧 (2026-09-17): ดึง badge count ครั้งเดียว (one-shot) — ไม่ polling
// ใช้ข้อมูล name+whatsapp จาก localStorage (เดียวกับที่ app-promotion.js ใช้ใน My Orders view)
// ถ้ายังไม่เคยกรอกข้อมูลใน My Orders → ซ่อน badge ไว้
//
// ⚠️ DEAD CODE (NO CALLER): _trackOrderBadgeUnsub ด้านล่างเป็น dead state field
//   - เดิมเคยเก็บฟังก์ชัน unsubscribe ที่ได้จาก listenCustomerOrders() หรือ onSnapshot()
//   - 2026-09-17: ทุก caller ย้ายไปใช้ fetchTrackOrderBadgeOnce() (one-shot, ไม่มี unsubscribe)
//   - ปัจจุบัน: _trackOrderBadgeUnsub ถูก set เป็น null เสมอ, ไม่เคยถูก assign ฟังก์ชัน unsubscribe จริง
//   - ที่ไม่ลบ: กฎของโปรเจกต์ "ห้ามลบโค้ดเพียงเพราะคิดว่าไม่ได้ใช้งาน"
//   - ถ้าอนาคตจะใช้ polling กลับมา: ต้อง assign ฟังก์ชัน unsubscribe จาก listenCustomerOrders()
//     ให้ _trackOrderBadgeUnsub จริง ๆ ใน initTrackOrderBadgeListener() ถึงจะทำงาน
let _trackOrderBadgeUnsub = null;       // ← DEAD CODE — ดูคอมเมนต์ด้านบน
let _trackOrderBadgeVisibilityHandler = null;  // visibility listener ของ badge
function initTrackOrderBadgeListener() {
  // ล้าง visibility handler เดิมถ้ามี (กันซ้ำ)
  if (_trackOrderBadgeVisibilityHandler) {
    document.removeEventListener("visibilitychange", _trackOrderBadgeVisibilityHandler);
    _trackOrderBadgeVisibilityHandler = null;
  }
  // ⚠️ DEAD CODE BLOCK: if (_trackOrderBadgeUnsub) { ... } ด้านล่าง — ไม่มีทางทำงานจริง
  //   - _trackOrderBadgeUnsub ถูก set เป็น null เสมอ, ไม่เคยถูก assign ฟังก์ชัน unsubscribe จริง
  //   - เดิมเคยใช้ตอน listener เป็น polling (listenCustomerOrders/onSnapshot)
  //   - ปัจจุบัน: ใช้ fetchTrackOrderBadgeOnce() แบบ one-shot, ไม่มี unsubscribe ต้องล้าง
  //   - ที่ไม่ลบ: กฎของโปรเจกต์ "ห้ามลบโค้ดเพียงเพราะคิดว่าไม่ได้ใช้งาน"
  //   - ถ้าจะลบ: ลบได้ทั้ง block (บรรทัด if ถึง } ปิด) และ field declaration ด้านบน (_trackOrderBadgeUnsub)
  //     ไม่กระทบระบบเดิมเพราะไม่มี caller จริง — แต่ต้องลบทั้งคู่พร้อมกัน
  if (_trackOrderBadgeUnsub) {
    try { _trackOrderBadgeUnsub(); } catch (_) {}
    _trackOrderBadgeUnsub = null;
  }

  const info = loadTrackOrderInfoForBadge();
  if (!info || !info.name || !info.whatsapp) {
    // ยังไม่มีข้อมูลลูกค้า → ซ่อน badge ไว้
    updateTrackOrderBadge(0);
    return;
  }

  // ยิง one-shot fetch ครั้งแรก
  fetchTrackOrderBadgeOnce();

  // 🔧 (2026-09-17): เพิ่ม visibility listener — เมื่อลูกค้าสลับ tab แล้วกลับมา → refresh ทันที
  _trackOrderBadgeVisibilityHandler = () => {
    if (document.visibilityState !== "visible") return;
    fetchTrackOrderBadgeOnce();
  };
  document.addEventListener("visibilitychange", _trackOrderBadgeVisibilityHandler);
}

// 🔧 (2026-09-17): แยก fetchTrackOrderBadgeOnce ออกมาจาก init เพื่อ reuse
//   (ใช้ทั้งตอน init, ตอน visibility เปลี่ยน, และตอนหลัง checkout ผ่าน __refreshTrackOrderBadge)
async function fetchTrackOrderBadgeOnce() {
  const info = loadTrackOrderInfoForBadge();
  if (!info || !info.name || !info.whatsapp) {
    updateTrackOrderBadge(0);
    // 🔧 (2026-09-26) เพิ่มใหม่: ยังไม่มีข้อมูลลูกค้า → ไม่มีทางรู้ว่ามีออเดอร์ค้างชำระไหม → ซ่อนแถบเตือนไปด้วย
    updatePendingPaymentInfo([]);
    return;
  }
  try {
    const { snap } = await fetchCustomerOrdersOnce({
      customerName: info.name,
      whatsapp: info.whatsapp,
    });
    // นับเฉพาะออเดอร์ที่ active: pending_verify + processing
    let count = 0;
    // 🔧 (2026-09-26) เพิ่มใหม่: เก็บ order data ทั้งชุดไว้ด้วย เพื่อส่งต่อให้แถบเตือน "ยังไม่ได้ชำระเงิน"
    //   ใช้ผลลัพธ์ fetch ชุดเดียวกันนี้ — ไม่ยิง fetchCustomerOrdersOnce ซ้ำรอบสอง
    const orders = [];
    snap.forEach((d) => {
      const data = d.data() || {};
      orders.push({ ...data, _docId: d.id });
      const status = String(data.status || "");
      if (status === "pending_verify" || status === "processing") count += 1;
    });
    updateTrackOrderBadge(count);
    updatePendingPaymentInfo(orders);
  } catch (err) {
    // error — ไม่ทำให้ badge พัง แค่ log
    console.warn("fetchTrackOrderBadgeOnce error:", err?.message || err);
  }
}

// เริ่ม listener หลังโหลดหน้าเว็บเสร็จ — ถ้าเคยใช้ track order จะมี badge แสดงทันที
initTrackOrderBadgeListener();

// Export ให้ app-promotion.js เรียกเพื่อ refresh badge หลัง customer enters/clears My Orders info
window.__updateTrackOrderBadge = updateTrackOrderBadge;
window.__refreshTrackOrderBadge = initTrackOrderBadgeListener;
// 🆕 (2026-10-02): expose ให้ app-promotion.js เรียกจากปุ่มในรายละเอียดออเดอร์
window.playSong = playSong;
window.handleCustomerDeleteOrder = handleCustomerDeleteOrder;

init().catch(err => showToast("โหลดข้อมูลไม่สำเร็จ: " + err.message, "error"));

/* ==========================================================================
   🎁 (2026-09-20) หน้าโปรโมชั่นพรีวิว (ฝั่ง User) — เพิ่มใหม่ทั้งบล็อก
   ==========================================================================
   ระบบนี้ "อ่าน" ข้อมูลจาก collection `promotions` ผ่าน fetchActivePromotions()
   ที่มีอยู่แล้วใน app-promotion.js — เชื่อมกับหน้า admin จัดการโปรโมชั่น (view-promotions)
   โดยตรง ไม่สร้าง query ใหม่ ไม่สร้าง API ใหม่

   ฟังก์ชันทั้งหมดเป็น additive — ไม่แก้ signature ฟังก์ชันเดิมใด ๆ ในไฟล์นี้
   ประกอบด้วย:
   - promo_escapeHtml(str)             : escape HTML ป้องกัน XSS
   - promo_formatDiscountValue(p)      : ฟอร์แมตค่าส่วนลด → ข้อความ (เช่น "10%", "5,000 LAK")
   - promo_getTypeLabel(type)          : แปลง type code → ข้อความไทย
   - promo_getCountdownParts(endIso)   : คำนวณ d/h/m/s ที่เหลือ พร้อมสถานะ urgent/expired
   - promo_formatCountdownCompact(p)   : ฟอร์แมต compact สำหรับแบนเนอร์หน้าแรก
   - promo_pickFeaturedPromotion()     : เลือกโปรเด่น (ใกล้หมดเวลาที่สุด + ยังไม่หมด)
   - renderPromotionBanner()           : วาดแบนเนอร์หน้าแรก (ซ่อนถ้าไม่มีโปร)
   - renderPromotionsView()            : วาดการ์ดโปรโมชั่นทั้งหมดใน #promotionsView
   - showPromotionsView()              : แสดงหน้าโปรโมชั่น (ซ่อน view อื่น ๆ)
   - hidePromotionsView()              : ซ่อนหน้าโปรโมชั่น
   - updatePromoCountdowns()           : อัปเดตตัวเลข countdown ทุก ๆ วินาที
   - startPromoCountdown()             : เริ่ม interval ของ countdown (เรียกครั้งเดียวตอน init)
   ========================================================================== */

function promo_escapeHtml(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// ฟอร์แมตค่าส่วนลด → ข้อความสั้น (เช่น "10%", "5,000 LAK")
function promo_formatDiscountValue(p) {
  if (!p) return "-";
  const v = Number(p.discount_value) || 0;
  const t = p.type || "cart_percent";
  if (t === "cart_percent" || t === "buy_x_get_y_percent") {
    return v + "%";
  }
  if (t === "cart_fixed") {
    return Number(v).toLocaleString("en-US") + " LAK";
  }
  // 🚀 (2026-09-28 fix H-7): รองรับ playlist_tiered_percent
  if (t === "playlist_tiered_percent") {
    // แสดง % สูงสุดใน tiers (เพื่อให้ลูกค้าเห็นส่วนลดสูงสุดที่เป็นไปได้)
    if (Array.isArray(p.tiers) && p.tiers.length > 0) {
      const maxPct = Math.max(...p.tiers.map(tier => Number(tier.discount_percent) || 0));
      return `สูงสุด ${maxPct}%`;
    }
    return "Tiered %";
  }
  return String(v);
}

// ฟอร์แมตค่าส่วนลด → แยก "value" กับ "unit" สำหรับการ์ด (เช่น { value: "10", unit: "% OFF" })
function promo_formatDiscountParts(p) {
  if (!p) return { value: "-", unit: "" };
  const v = Number(p.discount_value) || 0;
  const t = p.type || "cart_percent";
  if (t === "cart_percent" || t === "buy_x_get_y_percent") {
    return { value: String(v), unit: "% OFF" };
  }
  if (t === "cart_fixed") {
    return { value: Number(v).toLocaleString("en-US"), unit: "LAK OFF" };
  }
  // 🚀 (H-7): รองรับ playlist_tiered_percent
  if (t === "playlist_tiered_percent") {
    if (Array.isArray(p.tiers) && p.tiers.length > 0) {
      const maxPct = Math.max(...p.tiers.map(tier => Number(tier.discount_percent) || 0));
      return { value: `สูงสุด ${maxPct}`, unit: "% OFF" };
    }
    return { value: "Tiered", unit: "% OFF" };
  }
  return { value: String(v), unit: "" };
}

// แปลง type code → ข้อความไทยสั้น ๆ สำหรับ tag
function promo_getTypeLabel(type) {
  if (type === "cart_percent") return "ลด % ทั้งยอด";
  if (type === "cart_fixed")   return "ลดจำนวนเงิน";
  if (type === "buy_x_get_y_percent") return "ซื้อ X ลด %";
  // 🚀 (H-7): เพิ่ม label สำหรับ playlist_tiered_percent
  if (type === "playlist_tiered_percent") return "🎵 ยิ่งเลือกเยอะ ยิ่งคุ้ม";
  return "โปรโมชั่น";
}

// คำนวณเวลาที่เหลือ (ms → วัน/ชม./นาที/วินาที) พร้อมสถานะ urgent/expired
//   urgent = เหลือน้อยกว่า 24 ชม.
//   expired = หมดเวลาแล้ว (end <= now)
function promo_getCountdownParts(endIso) {
  const result = { days: 0, hours: 0, minutes: 0, seconds: 0, total: 0, urgent: false, expired: false };
  if (!endIso) return result;
  const end = new Date(endIso).getTime();
  if (isNaN(end)) return result;
  const now = Date.now();
  let diff = end - now;
  if (diff <= 0) {
    result.expired = true;
    return result;
  }
  result.total = diff;
  result.urgent = diff < 24 * 60 * 60 * 1000; // < 24h
  result.days    = Math.floor(diff / (24 * 60 * 60 * 1000)); diff -= result.days * 24 * 60 * 60 * 1000;
  result.hours   = Math.floor(diff / (60 * 60 * 1000));      diff -= result.hours * 60 * 60 * 1000;
  result.minutes = Math.floor(diff / (60 * 1000));            diff -= result.minutes * 60 * 1000;
  result.seconds = Math.floor(diff / 1000);
  return result;
}

// ฟอร์แมต compact สำหรับแบนเนอร์หน้าแรก → ข้อความสั้นภาษาไทย
//   รูปแบบ: "2 วัน 12:34:56" หรือ "หมดเวลาแล้ว"
function promo_formatCountdownCompact(endIso) {
  const p = promo_getCountdownParts(endIso);
  if (p.expired) return "หมดเวลาแล้ว";
  const pad = n => String(n).padStart(2, "0");
  if (p.days > 0) {
    return `${p.days} วัน ${pad(p.hours)}:${pad(p.minutes)}:${pad(p.seconds)}`;
  }
  return `${pad(p.hours)}:${pad(p.minutes)}:${pad(p.seconds)}`;
}

// เลือกโปรเด่นสำหรับแบนเนอร์หน้าแรก
//   หลักเกณฑ์: เลือกโปรที่ใกล้หมดเวลาที่สุด (แต่ยังไม่หมด) เพื่อสร้างความเร่งด่วน
//   ถ้าไม่มีโปรที่ยังไม่หมด → คืน null (แบนเนอร์จะถูกซ่อน)
function promo_pickFeaturedPromotion() {
  if (!Array.isArray(STATE.promotions) || STATE.promotions.length === 0) return null;
  const now = Date.now();
  // เฉพาะโปรที่ยังไม่หมดเวลา
  const upcoming = STATE.promotions.filter(p => {
    if (!p.end_at) return false;
    const end = new Date(p.end_at).getTime();
    return !isNaN(end) && end > now;
  });
  if (upcoming.length === 0) return null;
  // เรียงตาม end_at น้อยไปมาก → อันแรกคือใกล้หมดเวลาที่สุด
  upcoming.sort((a, b) => new Date(a.end_at).getTime() - new Date(b.end_at).getTime());
  return upcoming[0];
}

// วาดแบนเนอร์โปรโมชั่นเด่นบนหน้าแรก
//   🚀 (2026-09-28 fix H-7 v6): ใช้สไตล์เดียวกับหน้าโปรโมชั่น (Cyberpunk promo-card)
//   - สีเดียวกันกับหน้าโปรโมชั่น (--cp-pink, --cp-cyan, --cp-yellow)
//   - countdown ใช้สไตล์เดียวกับ promo-card (กล่อง cyan + urgent pink)
//   - tier rows ใช้สไตล์ tag แบบเดียวกับ promo-card
function renderPromotionBanner() {
  const banner = document.getElementById("promoHomeBanner");
  if (!banner) return;

  const allPromos = (STATE.promotions || []).filter(p => p && p.active !== false);
  if (allPromos.length === 0) {
    banner.hidden = true;
    return;
  }

  const tieredPromos = allPromos.filter(p => p.type === "playlist_tiered_percent");
  const otherPromos = allPromos.filter(p => p.type !== "playlist_tiered_percent");

  if (tieredPromos.length === 0 && otherPromos.length === 0) {
    banner.hidden = true;
    return;
  }

  banner.hidden = false;

  let bannerHtml = '';

  // 🎨 v6: ส่วนที่ 1 — playlist_tiered_percent (สไตล์เดียวกับ promo-card)
  for (const promo of tieredPromos) {
    const tiers = Array.isArray(promo.tiers) ? promo.tiers : [];
    const sortedTiers = [...tiers].sort((a, b) => Number(a.min_quantity) - Number(b.min_quantity));

    let recommendedTier = null;
    if (sortedTiers.length > 1) {
      recommendedTier = sortedTiers[sortedTiers.length - 2];
    } else if (sortedTiers.length === 1) {
      recommendedTier = sortedTiers[0];
    }

    // 🎨 v6: tier rows สไตล์ tag แบบ promo-card
    const tiersHtml = sortedTiers.map(t => {
      const qty = Number(t.min_quantity) || 0;
      const pct = Number(t.discount_percent) || 0;
      const isRecommended = recommendedTier && qty === Number(recommendedTier.min_quantity);
      const recommendedBadge = isRecommended
        ? ' <span style="color:var(--cp-yellow);font-weight:800;font-size:9px;text-shadow:0 0 4px var(--cp-yellow);">⭐ แนะนำ</span>'
        : "";
      // แต่ละ tier ใช้สไตล์ tag แบบ promo-card
      return `<div style="display:inline-block;background:rgba(255,0,255,.1);border:1px solid rgba(255,0,255,.3);color:var(--cp-cyan);font-size:10px;font-weight:700;padding:2px 8px;border-radius:2px;margin:2px 4px 2px 0;text-shadow:0 0 4px rgba(0,255,255,.5);font-family:var(--cp-mono);">
        📁 ${qty} = ${pct}%${recommendedBadge}
      </div>`;
    }).join("");

    // 🎨 v6: countdown สไตล์เดียวกับหน้าโปรโมชั่น (แยก วัน/ชม./นาที/วิ + Cyberpunk)
    // 🚀 (2026-09-28 fix A1): เพิ่ม data-promo-end + data-promo-num → เดินทุกวินาที
    //   ใช้สไตล์ promo-countdown-box แต่เล็กลง (compact) สำหรับ banner
    const countdownP = promo_getCountdownParts(promo.end_at);
    const isUrgent = countdownP.urgent && !countdownP.expired;
    const isExpired = countdownP.expired;
    let countdownHtml = "";
    if (isExpired) {
      countdownHtml = `<div class="promo-countdown-box expired" style="padding:4px 10px;margin-top:5px;border-radius:2px;"><span class="promo-countdown-text-flat" style="font-size:11px;font-family:var(--cp-mono);">⏰ หมดเวลาแล้ว</span></div>`;
    } else {
      const pad = n => String(n).padStart(2, "0");
      const showDays = countdownP.days > 0;
      const daysHtml = showDays ? `
        <span class="promo-countdown-unit" style="min-width:22px;">
          <span class="promo-countdown-num" data-promo-num="d" style="font-size:14px;">${countdownP.days}</span>
          <span class="promo-countdown-text" style="font-size:7px;">วัน</span>
        </span>
        <span class="promo-countdown-sep" style="font-size:12px;">:</span>` : "";
      countdownHtml = `<div class="promo-countdown-box${isUrgent ? " urgent" : ""}" data-promo-end="${promo.end_at || ""}" style="padding:4px 10px;margin-top:5px;border-radius:2px;gap:6px;">
        <span class="promo-countdown-label" style="font-size:9px;letter-spacing:0.5px;">${isUrgent ? "⏰" : "⏳"}</span>
        <span class="promo-countdown-timer" style="gap:2px;">
          ${daysHtml}
          <span class="promo-countdown-unit" style="min-width:22px;">
            <span class="promo-countdown-num" data-promo-num="h" style="font-size:14px;">${pad(countdownP.hours)}</span>
            <span class="promo-countdown-text" style="font-size:7px;">ชม.</span>
          </span>
          <span class="promo-countdown-sep" style="font-size:12px;">:</span>
          <span class="promo-countdown-unit" style="min-width:22px;">
            <span class="promo-countdown-num" data-promo-num="m" style="font-size:14px;">${pad(countdownP.minutes)}</span>
            <span class="promo-countdown-text" style="font-size:7px;">นาที</span>
          </span>
          <span class="promo-countdown-sep" style="font-size:12px;">:</span>
          <span class="promo-countdown-unit" style="min-width:22px;">
            <span class="promo-countdown-num" data-promo-num="s" style="font-size:14px;">${pad(countdownP.seconds)}</span>
            <span class="promo-countdown-text" style="font-size:7px;">วิ</span>
          </span>
        </span>
      </div>`;
    }

    // 🎨 v6: title สไตล์ promo-card (text-shadow pink + cyan)
    bannerHtml += `<div style="margin-bottom:10px;">
      <div style="font-size:14px;font-weight:900;color:#fff;margin-bottom:5px;text-shadow:0 0 8px var(--cp-pink),2px 0 0 rgba(0,255,255,.7),-2px 0 0 rgba(255,0,255,.7);letter-spacing:0.5px;font-family:var(--cp-mono);">${promo_escapeHtml(promo.name || "🎵 ยิ่งเลือกเยอะ ยิ่งคุ้ม")}</div>
      <div style="display:flex;flex-wrap:wrap;gap:2px;">${tiersHtml}</div>
      ${countdownHtml}
    </div>`;
  }

  // 🎨 v6: ส่วนที่ 2 — โปรโมชันอื่น ๆ (สไตล์เดียวกับ promo-card)
  if (otherPromos.length > 0) {
    const now = Date.now();
    const upcoming = otherPromos.filter(p => {
      if (!p.end_at) return false;
      const end = new Date(p.end_at).getTime();
      return !isNaN(end) && end > now;
    });
    upcoming.sort((a, b) => new Date(a.end_at).getTime() - new Date(b.end_at).getTime());

    for (const featured of upcoming) {
      // 🚀 (A1): countdown สไตล์เดียวกับหน้าโปรโมชั่น (compact) — เดินทุกวินาที
      const featuredCP = promo_getCountdownParts(featured.end_at);
      const featuredUrgent = featuredCP.urgent && !featuredCP.expired;
      const featuredExpired = featuredCP.expired;
      let featuredCountdownHtml = "";
      if (featuredExpired) {
        featuredCountdownHtml = `<div class="promo-countdown-box expired" style="padding:4px 10px;margin-top:4px;border-radius:2px;"><span class="promo-countdown-text-flat" style="font-size:11px;font-family:var(--cp-mono);">⏰ หมดเวลาแล้ว</span></div>`;
      } else {
        const fpad = n => String(n).padStart(2, "0");
        const fshowDays = featuredCP.days > 0;
        const fdaysHtml = fshowDays ? `
        <span class="promo-countdown-unit" style="min-width:22px;">
          <span class="promo-countdown-num" data-promo-num="d" style="font-size:14px;">${featuredCP.days}</span>
          <span class="promo-countdown-text" style="font-size:7px;">วัน</span>
        </span>
        <span class="promo-countdown-sep" style="font-size:12px;">:</span>` : "";
        featuredCountdownHtml = `<div class="promo-countdown-box${featuredUrgent ? " urgent" : ""}" data-promo-end="${featured.end_at || ""}" style="padding:4px 10px;margin-top:4px;border-radius:2px;gap:6px;">
          <span class="promo-countdown-label" style="font-size:9px;letter-spacing:0.5px;">${featuredUrgent ? "⏰" : "⏳"}</span>
          <span class="promo-countdown-timer" style="gap:2px;">
            ${fdaysHtml}
            <span class="promo-countdown-unit" style="min-width:22px;">
              <span class="promo-countdown-num" data-promo-num="h" style="font-size:14px;">${fpad(featuredCP.hours)}</span>
              <span class="promo-countdown-text" style="font-size:7px;">ชม.</span>
            </span>
            <span class="promo-countdown-sep" style="font-size:12px;">:</span>
            <span class="promo-countdown-unit" style="min-width:22px;">
              <span class="promo-countdown-num" data-promo-num="m" style="font-size:14px;">${fpad(featuredCP.minutes)}</span>
              <span class="promo-countdown-text" style="font-size:7px;">นาที</span>
            </span>
            <span class="promo-countdown-sep" style="font-size:12px;">:</span>
            <span class="promo-countdown-unit" style="min-width:22px;">
              <span class="promo-countdown-num" data-promo-num="s" style="font-size:14px;">${fpad(featuredCP.seconds)}</span>
              <span class="promo-countdown-text" style="font-size:7px;">วิ</span>
            </span>
          </span>
        </div>`;
      }

      // 🎨 v6: discount สไตล์ promo-card (กล่อง pink + cyan text)
      const discountParts = promo_formatDiscountParts(featured);
      bannerHtml += `<div style="margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,0,255,.15);">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:4px;">
          <div style="flex:1;min-width:0;">
            <div style="font-size:13px;font-weight:900;color:#fff;text-shadow:0 0 6px var(--cp-pink);letter-spacing:0.3px;font-family:var(--cp-mono);">${promo_escapeHtml(featured.name || "โปรโมชั่น")}</div>
          </div>
          <div style="flex-shrink:0;padding:6px 12px;background:rgba(255,0,255,.15);border:1px solid var(--cp-pink);text-align:center;min-width:60px;box-shadow:0 0 8px var(--cp-pink-glow);font-family:var(--cp-mono);">
            <div style="font-size:16px;font-weight:900;color:var(--cp-cyan);text-shadow:0 0 6px var(--cp-cyan);font-variant-numeric:tabular-nums;">${promo_escapeHtml(discountParts.value)}</div>
            <div style="font-size:8px;color:var(--cp-pink);font-weight:700;">${promo_escapeHtml(discountParts.unit)}</div>
          </div>
        </div>
        ${featuredCountdownHtml}
      </div>`;
    }
  }

  const contentEl = document.getElementById("promoHomeBannerContent");
  if (contentEl) contentEl.innerHTML = bannerHtml;

  if (!banner._promoBound) {
    banner.addEventListener("click", () => {
      const tabBtn = document.querySelector('.bottom-nav button[data-tab="promotions"]');
      if (tabBtn) tabBtn.click();
    });
    banner._promoBound = true;
  }
}

// วาดการ์ดโปรโมชั่นทั้งหมดใน #promotionsView
function renderPromotionsView() {
  const list = document.getElementById("promoViewList");
  if (!list) return;

  // กรณีไม่มีโปรโมชั่น active
  if (!Array.isArray(STATE.promotions) || STATE.promotions.length === 0) {
    // 🆕 (T009-F2): empty state สวย ๆ พร้อม icon + title + desc (ใช้คลาส empty-state-cute ร่วมกับ list อื่น)
    list.innerHTML = `
      <div class="empty-state-cute">
        <div class="empty-icon">🎁</div>
        <div class="empty-title">ยังไม่มีโปรโมชั่นในตอนนี้</div>
        <div class="empty-desc">ติดตามโปรโมชั่นพิเศษได้ที่นี่ — เราจะแจ้งเมื่อมีข้อเสนอใหม่!</div>
      </div>`;
    return;
  }

  // กรองเฉพาะโปรที่ active และยังอยู่ในช่วงเวลา (เผื่อ cache เก่า — ด่านความปลอดภัย)
  const now = Date.now();
  const visible = STATE.promotions.filter(p => {
    if (p.active === false) return false;
    const start = p.start_at ? new Date(p.start_at).getTime() : null;
    const end   = p.end_at   ? new Date(p.end_at).getTime()   : null;
    if (start && !isNaN(start) && now < start) return false;
    if (end && !isNaN(end) && now > end) return false;
    return true;
  });

  // เรียงตาม end_at น้อยไปมาก (ใกล้หมดเวลาก่อน) — สร้างความเร่งด่วน
  visible.sort((a, b) => {
    const ea = a.end_at ? new Date(a.end_at).getTime() : Infinity;
    const eb = b.end_at ? new Date(b.end_at).getTime() : Infinity;
    return ea - eb;
  });

  if (visible.length === 0) {
    // 🆕 (T009-F2): empty state สวย ๆ (กรณีกรองแล้วเหลือ 0 — โปรหมดเวลาแล้วทั้งหมด)
    list.innerHTML = `
      <div class="empty-state-cute">
        <div class="empty-icon">🎁</div>
        <div class="empty-title">ยังไม่มีโปรโมชั่นในตอนนี้</div>
        <div class="empty-desc">ติดตามโปรโมชั่นพิเศษได้ที่นี่ — เราจะแจ้งเมื่อมีข้อเสนอใหม่!</div>
      </div>`;
    return;
  }

  // วาดการ์ดทีละใบ
  // 🚀 (2026-09-28 fix): try/catch รายการ์ด — กัน 1 การ์ดพังทำให้ทั้งหน้าว่าง
  list.innerHTML = visible.map(p => {
    try {
    const discountParts = promo_formatDiscountParts(p);
    const cparts = promo_getCountdownParts(p.end_at);
    const isUrgent = cparts.urgent && !cparts.expired;
    const isExpired = cparts.expired;

    // สร้าง countdown HTML — ใช้ข้อความภาษาไทย (สไตล์ Cyberpunk เป็นแค่ภาพ ไม่ใช่ข้อความ)
    let countdownHtml = "";
    if (isExpired) {
      countdownHtml = `
        <div class="promo-countdown-box expired">
          <span class="promo-countdown-label">สถานะ</span>
          <span class="promo-countdown-text-flat">หมดเวลาแล้ว</span>
        </div>`;
    } else {
      const pad = n => String(n).padStart(2, "0");
      const showDays = cparts.days > 0;
      const daysHtml = showDays ? `
        <span class="promo-countdown-unit">
          <span class="promo-countdown-num" data-promo-num="d">${cparts.days}</span>
          <span class="promo-countdown-text">วัน</span>
        </span>
        <span class="promo-countdown-sep">:</span>` : "";
      countdownHtml = `
        <div class="promo-countdown-box${isUrgent ? " urgent" : ""}" data-promo-end="${p.end_at || ""}">
          <span class="promo-countdown-label">${isUrgent ? "⏰ หมดเวลาในอีก" : "⏳ หมดเวลาในอีก"}</span>
          <span class="promo-countdown-timer">
            ${daysHtml}
            <span class="promo-countdown-unit">
              <span class="promo-countdown-num" data-promo-num="h">${pad(cparts.hours)}</span>
              <span class="promo-countdown-text">ชม.</span>
            </span>
            <span class="promo-countdown-sep">:</span>
            <span class="promo-countdown-unit">
              <span class="promo-countdown-num" data-promo-num="m">${pad(cparts.minutes)}</span>
              <span class="promo-countdown-text">นาที</span>
            </span>
            <span class="promo-countdown-sep">:</span>
            <span class="promo-countdown-unit">
              <span class="promo-countdown-num" data-promo-num="s">${pad(cparts.seconds)}</span>
              <span class="promo-countdown-text">วิ</span>
            </span>
          </span>
        </div>`;
    }

    // สร้าง tag ย่อย ๆ
    const tags = [];
    tags.push(`<span class="promo-tag type">${promo_escapeHtml(promo_getTypeLabel(p.type))}</span>`);
    if (p.applies_to === "category" && p.category_name) {
      tags.push(`<span class="promo-tag scope">🎵 ${promo_escapeHtml(p.category_name)}</span>`);
    } else if (p.applies_to === "playlist") {
      tags.push(`<span class="promo-tag scope">📁 เฉพาะออเดอร์ซื้อยกเพลย์ลิสต์</span>`);
    } else {
      tags.push(`<span class="promo-tag scope">🎵 ทุกเพลง</span>`);
    }
    if (p.min_quantity && Number(p.min_quantity) > 0) {
      tags.push(`<span class="promo-tag min">🎯 ซื้อครบ ${Number(p.min_quantity)} เพลง</span>`);
    }
    if (p.min_subtotal && Number(p.min_subtotal) > 0) {
      tags.push(`<span class="promo-tag min">💰 ขั้นต่ำ ${Number(p.min_subtotal).toLocaleString("en-US")} LAK</span>`);
    }
    const tagsHtml = tags.join("");

    // 🚀 (2026-09-28 fix H-7): สร้าง tier table HTML สำหรับ playlist_tiered_percent
    let tierTableHtml = "";
    if (p.type === "playlist_tiered_percent" && Array.isArray(p.tiers) && p.tiers.length > 0) {
      const sortedTiers = [...p.tiers].sort((a, b) => Number(a.min_quantity) - Number(b.min_quantity));
      let recommendedTier = null;
      if (sortedTiers.length > 1) {
        recommendedTier = sortedTiers[sortedTiers.length - 2];
      } else if (sortedTiers.length === 1) {
        recommendedTier = sortedTiers[0];
      }
      const tierRowsHtml = sortedTiers.map(t => {
        const qty = Number(t.min_quantity) || 0;
        const pct = Number(t.discount_percent) || 0;
        const isRec = recommendedTier && qty === Number(recommendedTier.min_quantity);
        const recBadge = isRec
          ? '<span style="color:var(--cp-yellow);font-weight:800;font-size:11px;text-shadow:0 0 4px var(--cp-yellow);margin-left:6px;">⭐ แนะนำ</span>'
          : "";
        return `<div style="display:flex;align-items:center;justify-content:space-between;padding:6px 12px;margin:4px 0;background:rgba(255,0,255,.08);border:1px solid rgba(255,0,255,.25);border-radius:2px;font-family:var(--cp-mono);">
          <span style="font-size:13px;color:var(--cp-cyan);font-weight:700;text-shadow:0 0 4px rgba(0,255,255,.5);">📁 ${qty} เพลย์ลิสต์</span>
          <span style="font-size:14px;color:#fff;font-weight:900;">ลด ${pct}%${recBadge}</span>
        </div>`;
      }).join("");
      tierTableHtml = `<div style="margin:10px 0 12px;">${tierRowsHtml}</div>`;
    }

    // วันที่เริ่มต้น/สิ้นสุด
    const startDate = formatDateTime(p.start_at);
    const endDate   = formatDateTime(p.end_at);

    // 🚀 (H-7): แยกการ์ดสำหรับ playlist_tiered_percent (แสดง tier table แทน discount box)
    if (p.type === "playlist_tiered_percent") {
      // 🚀 (2026-09-28 fix): ใช้ countdown แบบเดียวกับการ์ดอื่น (มี data-promo-num → เดินทุกวินาที)
      let tierCountdownHtml = "";
      if (isExpired) {
        tierCountdownHtml = `
          <div class="promo-countdown-box expired">
            <span class="promo-countdown-label">สถานะ</span>
            <span class="promo-countdown-text-flat">หมดเวลาแล้ว</span>
          </div>`;
      } else {
        const pad = n => String(n).padStart(2, "0");
        const showDays = cparts.days > 0;
        const daysHtml = showDays ? `
          <span class="promo-countdown-unit">
            <span class="promo-countdown-num" data-promo-num="d">${cparts.days}</span>
            <span class="promo-countdown-text">วัน</span>
          </span>
          <span class="promo-countdown-sep">:</span>` : "";
        tierCountdownHtml = `
          <div class="promo-countdown-box${isUrgent ? " urgent" : ""}" data-promo-end="${p.end_at || ""}">
            <span class="promo-countdown-label">${isUrgent ? "⏰ หมดเวลาในอีก" : "⏳ หมดเวลาในอีก"}</span>
            <span class="promo-countdown-timer">
              ${daysHtml}
              <span class="promo-countdown-unit">
                <span class="promo-countdown-num" data-promo-num="h">${pad(cparts.hours)}</span>
                <span class="promo-countdown-text">ชม.</span>
              </span>
              <span class="promo-countdown-sep">:</span>
              <span class="promo-countdown-unit">
                <span class="promo-countdown-num" data-promo-num="m">${pad(cparts.minutes)}</span>
                <span class="promo-countdown-text">นาที</span>
              </span>
              <span class="promo-countdown-sep">:</span>
              <span class="promo-countdown-unit">
                <span class="promo-countdown-num" data-promo-num="s">${pad(cparts.seconds)}</span>
                <span class="promo-countdown-text">วิ</span>
              </span>
            </span>
          </div>`;
      }

      return `
        <div class="promo-card${isUrgent ? " urgent" : ""}" data-promo-id="${promo_escapeHtml(p.id)}">
          <div class="promo-card-body">
            <div class="promo-card-top">
              <div class="promo-card-name-wrap">
                <h3 class="promo-card-name">⚡ ${promo_escapeHtml(p.name || "โปรโมชั่นพิเศษ")}</h3>
                ${p.description ? `<div class="promo-card-desc">${promo_escapeHtml(p.description)}</div>` : ""}
              </div>
            </div>
            <div class="promo-card-tags">${tagsHtml}</div>
            ${tierTableHtml}
            <div class="promo-card-dates">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>
              <span class="promo-date-label">ใช้ได้ตั้งแต่</span>
              <span class="promo-date-value">${promo_escapeHtml(startDate)}</span>
              <span class="promo-date-sep">→</span>
              <span class="promo-date-value">${promo_escapeHtml(endDate)}</span>
            </div>
            ${tierCountdownHtml}
            <button type="button" class="promo-card-cta" data-promo-cta>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="21" r="1"></circle><circle cx="20" cy="21" r="1"></circle><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"></path></svg>
              เลือกเพลย์ลิสต์เพื่อรับส่วนลด
            </button>
          </div>
        </div>`;
    }

    return `
      <div class="promo-card${isUrgent ? " urgent" : ""}" data-promo-id="${promo_escapeHtml(p.id)}">
        <div class="promo-card-body">
          <div class="promo-card-top">
            <div class="promo-card-name-wrap">
              <h3 class="promo-card-name">${promo_escapeHtml(p.name || "(ไม่มีชื่อ)")}</h3>
              ${p.description ? `<div class="promo-card-desc">${promo_escapeHtml(p.description)}</div>` : ""}
            </div>
            <div class="promo-card-discount">
              <div class="promo-card-discount-value">${promo_escapeHtml(discountParts.value)}</div>
              <div class="promo-card-discount-unit">${promo_escapeHtml(discountParts.unit)}</div>
            </div>
          </div>
          <div class="promo-card-tags">${tagsHtml}</div>
          <div class="promo-card-dates">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>
            <span class="promo-date-label">ใช้ได้ตั้งแต่</span>
            <span class="promo-date-value">${promo_escapeHtml(startDate)}</span>
            <span class="promo-date-sep">→</span>
            <span class="promo-date-value">${promo_escapeHtml(endDate)}</span>
          </div>
          ${countdownHtml}
          <button type="button" class="promo-card-cta" data-promo-cta>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="21" r="1"></circle><circle cx="20" cy="21" r="1"></circle><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"></path></svg>
            เพิ่มเพลงลงตะกร้าเพื่อรับส่วนลด
          </button>
        </div>
      </div>`;
    } catch (cardErr) {
      // 🚀 (2026-09-28 fix): ถ้าการ์ดใดพัง → แสดง error card แทน (ไม่ให้ทั้งหน้าว่าง)
      console.error("[promo] Card render failed for", p?.id, cardErr);
      return `<div class="promo-card" data-promo-id="${promo_escapeHtml(p?.id || '')}">
        <div class="promo-card-body">
          <h3 class="promo-card-name">⚠️ โหลดการ์ดไม่สำเร็จ</h3>
          <div class="promo-card-desc">โปรโมชั่น "${promo_escapeHtml(p?.name || '')}" อาจมีข้อมูลผิดปกติ — กรุณาติดต่อร้าน</div>
        </div>
      </div>`;
    }
  }).join("");

  // ผูกปุ่ม CTA — กดแล้วสลับไปแท็บที่เกี่ยวข้อง
  //   🆕 (T062): ถ้าเป็นโปรโมชันเพลย์ลิสต์ (CTA "เลือกเพลย์ลิสต์เพื่อรับส่วนลด") → ไปแท็บ "Playlist"
  //              ถ้าเป็นโปรโมชันเพลง (CTA "เพิ่มเพลงลงตะกร้าเพื่อรับส่วนลด") → ไปแท็บ "หน้าแรก" (เดิม)
  //   ปัญหาเดิม: กดปุ่ม "เลือกเพลย์ลิสต์..." → ไปหน้าแรก → ลูกค้าสับสน (ไม่เจอเพลย์ลิสต์)
  //   ผลกระทบระบบเดิม: 0% — เปลี่ยนเฉพาะ click handler ของ CTA ปุ่ม
  list.querySelectorAll("[data-promo-cta]").forEach(btn => {
    btn.addEventListener("click", () => {
      const ctaText = (btn.textContent || "").trim();
      const isPlaylistCta = ctaText.includes("เพลย์ลิสต์") || ctaText.includes("เลือกเพลย์ลิสต์");
      const targetTab = isPlaylistCta ? "playlist" : "home";
      const tabBtn = document.querySelector(`.bottom-nav button[data-tab="${targetTab}"]`);
      if (tabBtn) tabBtn.click();
    });
  });
}

// แสดงหน้าโปรโมชั่น (ซ่อน view อื่น ๆ ที่อาจเปิดอยู่)
//   รูปแบบเดียวกับ showMyOrdersView() ที่มีอยู่ — ไม่แตะ setView() เดิม
//   🔧 (2026-09-20 fix): เพิ่มการซ่อน .playlist-wrapper ทั้งกล่อง (เดิมซ่อนแค่ #playlistsContainer
//   ทำให้ปุ่มหัวข้อ "เพลย์ลิสต์" ยังโผล่อยู่บนหน้าโปรโมชั่น)
function showPromotionsView() {
  // ซ่อน view อื่น ๆ
  ["#gridTitle", "#songGrid", "#emptyState"].forEach(selector => {
    const el = document.querySelector(selector);
    if (el) el.style.display = "none";
  });
  // 🛡️ (T007 hardening): ซ่อน songGridSentinel + songListSentinel ตอนอยู่ใน view อื่น
  //   เหตุผล: sentinel ทั้ง 2 ตัวเป็น siblings ของ #songGrid — เมื่อ #songGrid ถูกซ่อน หน้าจะสั้นลง
  //   → sentinel เข้าใกล้ viewport → observer ยิง loadMoreSongs/renderNextBatch โดยไม่จำเป็น
  //   → ประหยัด API calls + กัน DOM nodes สะสมใน #songGrid ที่ซ่อนอยู่
  ["#songGridSentinel", "#songListSentinel"].forEach(selector => {
    const el = document.querySelector(selector);
    if (el) el.style.display = "none";
  });
  const categoryChips = document.getElementById("categoryChips");
  const djSection = document.getElementById("djSection");
  if (categoryChips) categoryChips.style.display = "none";
  if (djSection) djSection.style.display = "none";
  // 🆕 (T046): ซ่อน category showcase + hero banner ในหน้าโปรโมชัน
  //   ปัญหา: เดิม showPromotionsView() ซ่อนแค่ #categoryChips + #djSection + .playlist-wrapper
  //   → แต่ #categoryShowcase (หมวดหมู่แนะนำ grid) + #heroBanner ยังโผล่อยู่บนหน้าโปรโมชัน
  //   ผลกระทบระบบเดิม: 0% — เมื่อกลับหน้าแรก setView("home") จะ restore display ให้เอง
  //   sync กับ setView() ที่จัดการ #categoryShowcase + #heroBanner เช่นกัน
  const categoryShowcase = document.getElementById("categoryShowcase");
  if (categoryShowcase) categoryShowcase.style.display = "none";
  const heroBanner = document.getElementById("heroBanner");
  if (heroBanner) heroBanner.style.display = "none";
  // 🔧 (2026-09-20 fix): ซ่อน .playlist-wrapper ทั้งกล่อง (ไม่ใช่แค่ยุบ #playlistsContainer)
  //   เพื่อให้ปุ่มหัวข้อ "เพลย์ลิสต์" หายไปจากหน้าโปรโมชั่นด้วย
  //   เมื่อกลับหน้าแรก → setView("home") → togglePlaylistsVisibility() จะแสดงกลับมาเอง
  const playlistWrapper = document.querySelector(".playlist-wrapper");
  if (playlistWrapper) playlistWrapper.style.display = "none";
  // ซ่อน playlists container (เก็บไว้เผื่อกรณี .playlist-wrapper ถูกเปิดกลับโดย code อื่น)
  const playlistsContainer = document.getElementById("playlistsContainer");
  if (playlistsContainer) playlistsContainer.classList.add("is-closed");
  // ซ่อนแบนเนอร์โปรโมชั่น (ไม่ให้ซ้อนทับกับหน้าเต็ม)
  const promoBanner = document.getElementById("promoHomeBanner");
  if (promoBanner) promoBanner.hidden = true;
  // แสดง promotionsView
  const view = document.getElementById("promotionsView");
  if (view) view.style.display = "block";
  // 🚀 (2026-09-28 fix H-7): refresh promotions ทุกครั้งที่เปิดหน้า (กัน cache เก่า)
  //   ใช้ .then() เพราะ showPromotionsView ไม่ใช่ async function
  fetchActivePromotions(true).then(promos => {
    STATE.promotions = promos;
    renderPromotionsView();
  }).catch(e => {
    console.warn("[promo] Refresh failed, using cache", e);
    renderPromotionsView();
  });
}

// ซ่อนหน้าโปรโมชั่น (เรียกจาก click handler ของ bottom-nav)
function hidePromotionsView() {
  const view = document.getElementById("promotionsView");
  if (view) view.style.display = "none";
  // 🎁 (2026-09-20) ซ่อนแบนเนอร์โปรโมชั่นด้วย — แบนเนอร์ควรอยู่แค่หน้าแรก
  //   - ทุกแท็บอื่น ๆ (playlist/category/dj/myorders) จะไม่เห็นแบนเนอร์
  //   - เมื่อกลับไปแท็บ "หน้าแรก" → branch home จะเรียก renderPromotionBanner() แสดงใหม่
  const promoBanner = document.getElementById("promoHomeBanner");
  if (promoBanner) promoBanner.hidden = true;
}

// อัปเดตตัวเลข countdown ทุก ๆ วินาที
//   - อัปเดตทั้งแบนเนอร์หน้าแรกและการ์ดใน #promotionsView
//   - ถ้า element ไม่อยู่ → ข้ามไปเงียบ ๆ (ปลอดภัย)
function updatePromoCountdowns() {
  // === อัปเดตแบนเนอร์หน้าแรก ===
  // 🚀 (2026-09-28 fix A1): อัปเดต countdown ใน banner ที่มี data-promo-end (เดินทุกวินาที)
  // 🐛 (2026-09-29 fix A2): ห้ามใช้ el.textContent = ... เพราะจะทำลาย <span class="promo-countdown-num">
  //     ที่ทำสี cyberpunk (cyan + glow) ทิ้ง → กลายเป็น text สีขาวธรรมดา
  //     อาการ: แวบเห็นสีฟ้าสวย (ตอน render ครั้งแรก) → 1 วินาทีต่อมากลายสีขาว
  //     แก้โดยอัปเดตเฉพาะ [data-promo-num] spans เหมือน #promotionsView branch
  const banner = document.getElementById("promoHomeBanner");
  if (banner && !banner.hidden) {
    // หาทุก countdown div ใน banner ที่มี data-promo-end
    const bannerCountdowns = banner.querySelectorAll("[data-promo-end]");
    let anyExpired = false;
    let needRerender = false;
    bannerCountdowns.forEach(el => {
      const endIso = el.getAttribute("data-promo-end");
      if (!endIso) return;
      const p = promo_getCountdownParts(endIso);
      if (p.expired) {
        anyExpired = true;
        return;
      }
      // toggle urgent class ถ้าสถานะเปลี่ยน (cyan → pink)
      const wasUrgent = el.classList.contains("urgent");
      if (wasUrgent !== p.urgent) {
        el.classList.toggle("urgent", p.urgent);
      }
      // ถ้าจำนวน "วัน" เปลี่ยน (0→1 หรือ 1→0) → structure เปลี่ยน → re-render
      const hasDaysSpan = !!el.querySelector('[data-promo-num="d"]');
      if (hasDaysSpan !== (p.days > 0)) {
        needRerender = true;
        return;
      }
      // อัปเดตเฉพาะตัวเลขในแต่ละ unit span (ไม่ทำลาย structure สี cyberpunk)
      const pad = n => String(n).padStart(2, "0");
      const dEl = el.querySelector('[data-promo-num="d"]');
      const hEl = el.querySelector('[data-promo-num="h"]');
      const mEl = el.querySelector('[data-promo-num="m"]');
      const sEl = el.querySelector('[data-promo-num="s"]');
      if (dEl) dEl.textContent = p.days;
      if (hEl) hEl.textContent = pad(p.hours);
      if (mEl) mEl.textContent = pad(p.minutes);
      if (sEl) sEl.textContent = pad(p.seconds);
    });
    if (anyExpired || needRerender) {
      // มีโปรหมดเวลา หรือ structure เปลี่ยน (วันเพิ่ม/หาย) → รีเฟรชแบนเนอร์ใหม่
      renderPromotionBanner();
    }
  }

  // === อัปเดตการ์ดใน #promotionsView ===
  const view = document.getElementById("promotionsView");
  if (!view || view.style.display === "none") return;
  const cards = view.querySelectorAll(".promo-card[data-promo-id]");
  let needRerender = false;
  cards.forEach(card => {
    const endIso = card.querySelector("[data-promo-end]")?.getAttribute("data-promo-end");
    if (!endIso) return;
    const p = promo_getCountdownParts(endIso);
    if (p.expired) {
      // การ์ดนี้หมดเวลา → mark ไว้แล้ว rerender ทีเดียวหลังวนจบ
      needRerender = true;
      return;
    }
    // อัปเดต class urgent ถ้าสถานะเปลี่ยน
    const box = card.querySelector(".promo-countdown-box");
    if (box) {
      const wasUrgent = box.classList.contains("urgent");
      if (wasUrgent !== p.urgent) {
        box.classList.toggle("urgent", p.urgent);
        card.classList.toggle("urgent", p.urgent);
      }
    }
    // อัปเดตตัวเลข
    const pad = n => String(n).padStart(2, "0");
    const dEl = card.querySelector('[data-promo-num="d"]');
    const hEl = card.querySelector('[data-promo-num="h"]');
    const mEl = card.querySelector('[data-promo-num="m"]');
    const sEl = card.querySelector('[data-promo-num="s"]');
    if (dEl) dEl.textContent = p.days;
    if (hEl) hEl.textContent = pad(p.hours);
    if (mEl) mEl.textContent = pad(p.minutes);
    if (sEl) sEl.textContent = pad(p.seconds);
  });
  if (needRerender) {
    renderPromotionsView();
  }
}

// เริ่ม interval ของ countdown (เรียกครั้งเดียวตอน init)
//   - ไม่กระทบระบบเดิม ใช้ interval แยก
//   - อัปเดตทุก 1 วินาที (1000ms)
//   🔧 (T-sync-low-fix-L3 2026-10-06): เพิ่ม stopPromoCountdown() + visibilitychange handler
//      เดิม: _promoCountdownInterval ถูก clear แค่ใน beforeunload → ตอน tab hidden ยังรัน (waste CPU)
//      วิธีแก้: เพิ่ม stopPromoCountdown() + visibilitychange — clear ตอน hidden, restart ตอน visible
//      ผลกระทบระบบเดิม: 0% — startPromoCountdown เดิมยังทำงานเหมือนเดิม; เพิ่ม lifecycle management
let _promoCountdownInterval = null;
function startPromoCountdown() {
  if (_promoCountdownInterval) return; // กันเริ่มซ้ำ
  _promoCountdownInterval = setInterval(updatePromoCountdowns, 1000);
}
function stopPromoCountdown() {
  if (_promoCountdownInterval) {
    clearInterval(_promoCountdownInterval);
    _promoCountdownInterval = null;
  }
}
// 🔧 (T-sync-low-fix-L3): clear/restart interval ตาม tab visibility — ประหยัด battery บน mobile
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    stopPromoCountdown();
  } else {
    if (!_promoCountdownInterval && typeof updatePromoCountdowns === "function") {
      updatePromoCountdowns(); // อัปเดตทันทีตอน visible
      startPromoCountdown();
    }
  }
});

// 🆕 (T004-pwa): Register Service Worker
//   - ลงทะเบียน SW หลัง window 'load' เพื่อไม่บล็อก first paint
//   - ถ้า SW ลงทะเบียนไม่สำเร็จ (browser เก่า / ปิดใช้งาน) → log warning เท่านั้น
//     ไม่ throw เพราะ PWA fail ต้องไม่ทำให้เว็บพัง
//   - scope '/' ครอบคลุมทุก path ใต้ origin เดียวกัน
//   - ผลกระทบระบบเดิม: 0% — SW ทำงานฝั่ง client เท่านั้น ไม่แตะ /api/* logic ฝั่ง worker
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js', { scope: '/' })
      .then(reg => console.log('[PWA] SW registered:', reg.scope))
      .catch(err => console.warn('[PWA] SW registration failed:', err?.message || err));
  });
}

// 🆕 (T016): Cleanup polling เมื่อ page unload — กัน setInterval ค้างหลัง reload/close
//   - beforeunload ทำงานทั้ง reload, close tab, navigate ไปหน้าอื่น
//   - ใช้ typeof check กัน ReferenceError ถ้า app-promotion.js ยังโหลดไม่เสร็จ
//   - ผลกระทบระบบเดิม: 0% — แค่ clear interval + removeEventListener
window.addEventListener('beforeunload', () => {
  try {
    if (typeof window.stopOrdersPolling === 'function') window.stopOrdersPolling();
  } catch (_) {}
});

