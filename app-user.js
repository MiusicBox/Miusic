// app-user.js — หน้า User: ดึงข้อมูลจาก Cloudflare D1, เล่นเพลงจาก Cloudflare R2 โดยตรง
// ===================================================
import { db } from "./firebase-init.js?v=20260905-fix1";
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
  collection, getDocs, doc, getDoc, query, where, onSnapshot, deleteDoc, queryCustomerOrder, listenCustomerOrders,
  // 🔧 (2026-09-17): เพิ่ม fetchCustomerOrdersOnce สำหรับ one-shot fetch (ไม่ polling) ลด D1 quota
  //    ↑ ↑ ↑ ฟังก์ชันนี้แหละที่ใช้จริงในไฟล์นี้ (แทน listenCustomerOrders เดิม)
  fetchCustomerOrdersOnce
// 🔧 (2026-09-17 v2): เพิ่ม ?v=20260917-polling-fix บังคับ browser โหลด db-client.js ใหม่ (กัน cache เก่า)
} from "./db-client.js?v=20260917-polling-fix";
import { initCart } from "./app-cart.js?v=20260921-total-green";
// ===== ลดราคา + โปรโมชั่น + ออเดอร์ของฉัน (ระบบใหม่ — รวมในไฟล์เดียว app-promotion.js) =====
import {
  fetchActiveDiscounts, fetchActivePromotions, applyDiscountToPrice, findActiveDiscountFor,
  initMyOrdersView, cleanupMyOrdersView,
  // 🎁 (2026-09-20) เพิ่มใหม่: formatDateTime ใช้สำหรับแสดงวันที่ในหน้าโปรโมชั่นพรีวิว (เรียกจาก app-promotion.js ที่มีอยู่แล้ว)
  formatDateTime
} from "./app-promotion.js?v=20261101-promo1";

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

function showToast(message, type) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = message;
  el.className = "toast show" + (type ? " " + type : "");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => { el.className = "toast"; }, 2600);
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
  // แก้บั๊ก (2026-09-13): เดิมกรณีไม่มีส่วนลด return ตัวเลขราคาเปล่าๆ ไม่มี class ครอบ
  // ทำให้ .song-price ใน style.css ไม่เคยถูกใช้จริง ปรับ font-size เท่าไหร่ก็ไม่มีผล
  // ครอบด้วย <span class="song-price"> เพื่อให้ควบคุมขนาด/สไตล์ผ่าน CSS ได้ตรงจุด
  if (!song) return `<span class="song-price">${formatPrice(0)}</span>`;
  const original = Number(song.price) || 0;
  const discount = findActiveDiscountFor({ targetType: "song", targetId: song.id, discounts: STATE.discounts });
  if (!discount) return `<span class="song-price">${formatPrice(original)}</span>`;
  const { finalPrice, hasDiscount } = applyDiscountToPrice(original, discount);
  if (!hasDiscount) return `<span class="song-price">${formatPrice(original)}</span>`;
  return `<span class="price-original">${formatPrice(original)}</span> <span class="price-discounted">${formatPrice(finalPrice)}</span>`;
}

function renderDiscountedPriceForPlaylist(playlist) {
  if (!playlist) return `<span class="song-price">${formatPrice(0)}</span>`;
  const original = Number(playlist.price) || 0;
  const discount = findActiveDiscountFor({ targetType: "playlist", targetId: playlist.id, discounts: STATE.discounts });
  // 🔧 (2026-09-19): ครอบด้วย <span class="song-price"> เหมือน renderDiscountedPriceForSong
  //   เพื่อให้ CSS .song-price { color: #ec4899 } มีผล → ราคาเพลย์ลิสต์เป็นสีชมพูเหมือนราคาเพลงเดี่ยว
  if (!discount) return `<span class="song-price">${formatPrice(original)}</span>`;
  const { finalPrice, hasDiscount } = applyDiscountToPrice(original, discount);
  if (!hasDiscount) return `<span class="song-price">${formatPrice(original)}</span>`;
  return `<span class="price-original">${formatPrice(original)}</span> <span class="price-discounted">${formatPrice(finalPrice)}</span>`;
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

function debounce(fn, wait) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), wait); }; }
const { loadCart, bindCartEvents, addToCart, getLastOrderRecord, showReceipt } = initCart({
  state: STATE,
  showToast,
  escapeHtml,
  formatPrice,
  buildWhatsAppLink
});

// 💙 (2026-09-20): สไตล์ C2 Vivid Cyan — แยกตัวอักษรชื่อร้านเป็น span.char
//   แต่ละตัวได้สีฟ้าไล่จากสว่าง→มืด + animation-delay ต่างกัน → กระโดดทีละตัว
//   สี: #67e8f9 (นีออนสว่าง) → #22d3ee → #06b6d4 → #0891b2 → ... → #083344 (มืด)
//   รองรับชื่อร้านความยาวเท่าไหร่ก็ได้ — คำนวณสีตามตำแหน่ง % ของตัวอักษร
function applyStoreNameAnimation(el) {
  if (!el) return;
  const text = el.textContent || "Music Store";
  // สีฟ้าไล่จากสว่าง→มืด (C2 Vivid Cyan palette)
  const colors = [
    { c: "#67e8f9", g: "rgba(103, 232, 249, 0.8)" },
    { c: "#22d3ee", g: "rgba(34, 211, 238, 0.9)" },
    { c: "#06b6d4", g: "rgba(6, 182, 212, 1)" },
    { c: "#0891b2", g: "rgba(8, 145, 178, 1)" },
    { c: "#0e7490", g: "rgba(14, 116, 144, 1)" },
    { c: "#155e75", g: "rgba(21, 94, 117, 1)" },
    { c: "#164e63", g: "rgba(22, 78, 99, 1)" },
    { c: "#083344", g: "rgba(8, 51, 68, 1)" }
  ];
  const chars = text.split("");
  const half = Math.floor(chars.length / 2);
  el.innerHTML = chars.map((ch, i) => {
    if (ch === " ") return '<span class="char">&nbsp;</span>';
    // ไล่สีจากสว่าง→มืด โดยใช้ตำแหน่ง % ของตัวอักษร
    // ครึ่งแรก: สว่าง→มืด, ครึ่งหลัง: มืด→สว่าง (วนกลับ เหมือนคลื่น)
    let pos;
    if (i <= half) {
      pos = i / Math.max(half, 1);
    } else {
      pos = (chars.length - 1 - i) / Math.max(half, 1);
    }
    const colorIdx = Math.min(Math.floor(pos * (colors.length - 1)), colors.length - 1);
    const color = colors[colorIdx];
    const delay = (i * 0.06).toFixed(2);
    const glow1 = `0 0 9px ${color.g}`;
    const glow2 = `0 0 18px ${color.g.replace(/[\d.]+\)$/, "0.5)")}`;
    return `<span class="char" style="color:${color.c};text-shadow:${glow1},${glow2};animation-delay:${delay}s;">${ch}</span>`;
  }).join("");
}

async function init() {
  loadCart();
  bindCartEvents();
  const [catSnap, djSnap, playlistSnap, settingsSnap] = await Promise.all([
    getDocs(collection(db, "categories")),
    getDocs(collection(db, "djs")),
    getDocs(collection(db, "playlists")),
    getDoc(doc(db, "settings", "main"))
  ]);
  STATE.categories = catSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  STATE.djs = djSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  STATE.playlists = playlistSnap.docs.map(d => ({ id: d.id, ...d.data() }));
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
  try {
    STATE.promotions = await fetchActivePromotions();
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
  renderCategoryChips();
  renderDjRow();
  renderPlaylists();
  renderSongGrid();
  renderPromotionBanner(); // 🎁 (2026-09-20) เพิ่มใหม่: แสดงแบนเนอร์โปรโมชั่นเด่นบนหน้าแรก (ถ้ามีโปร active)
  setView("home");
  togglePlaylistsVisibility();
  // 🔧 (2026-09-18 v6 perf): ติดตั้ง IntersectionObserver สำหรับ load-more-on-scroll
  //   เมื่อ user scroll ถึง card สุดท้าย → trigger loadMoreSongs() → append page ถัดไป
  setupSongListInfinityScroll();
  // 🎁 (2026-09-20) เพิ่มใหม่: เริ่ม countdown timer สำหรับแบนเนอร์โปรโมชั่น (อัปเดตทุก 1 วินาที)
  //   - ไม่กระทบระบบเดิม — ใช้ interval แยก ปิดได้ผ่าน stopPromoCountdown() ถ้าต้องการ
  //   - ปลอดภัยเพราะเช็ค element ทุกรอบ ถ้า element ไม่อยู่ → ข้ามไปเงียบ ๆ
  startPromoCountdown();
}

// 🔧 (2026-09-18 v6 perf): โหลดเพลง page ถัดไป (50 songs/page)
// ใช้ fetch ตรงแทน getDocs เพราะ db-client.js ไม่รองรับ pagination query params
//   - ส่ง ?limit=50&offset=(page*50)&slim=1 → Worker pagination + slim fields
//   - รับ array ของ { id, data } → push เข้า STATE.songs
//   - ถ้าได้น้อยกว่า limit → ตั้ง songsHasMore=false (โหลดครบแล้ว)
//   - กัน concurrent fetches ผ่าน STATE.songsLoading
async function loadMoreSongs() {
  if (STATE.songsLoading || !STATE.songsHasMore) return;
  STATE.songsLoading = true;
  const nextPage = (STATE.songsPage || 0) + 1;
  const offset = (nextPage - 1) * 50;
  try {
    const res = await fetch(`/api/db/songs?limit=50&offset=${offset}&slim=1`, {
      credentials: "same-origin",
    });
    if (!res.ok) {
      console.warn(`loadMoreSongs: HTTP ${res.status}`);
      STATE.songsHasMore = false;
      return;
    }
    const data = await res.json();
    const newDocs = Array.isArray(data?.docs) ? data.docs : [];
    if (newDocs.length === 0) {
      STATE.songsHasMore = false;
      return;
    }
    // filter hidden songs เหมือนเดิม + dedupe (กัน duplicate id)
    const existingIds = new Set(STATE.songs.map(s => s.id));
    const filtered = newDocs
      .map(d => ({ id: d.id, ...d.data }))
      .filter(s => s.status !== "hidden" && !existingIds.has(s.id));
    STATE.songs.push(...filtered);
    STATE.songsPage = nextPage;
    if (newDocs.length < 50) {
      STATE.songsHasMore = false;  // ได้น้อยกว่า limit → หมดแล้ว
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
  // กัน concurrent calls (เช่น user พิมพ์เร็วๆ กดซ้ำหลายครั้ง)
  if (STATE.songsLoadingAllRemaining) return;
  STATE.songsLoadingAllRemaining = true;
  try {
    let pagesLoaded = 0;
    let lastRenderAt = 0;
    // 🔧 (2026-09-19 perf): ใช้ requestIdleCallback ถ้ามี (เบราว์เซอร์ใหม่) หรือ setTimeout(0) ถ้าไม่มี
    //   เหตุผล: แต่ละ iteration ของ loop จะ yield ให้ browser ทำงานอื่น (เช่น scroll, paint) ก่อน
    //   → กัน loadAllRemainingSongs แย่ง CPU จาก scroll → หน้าเว็บไม่กระตุกระหว่างโหลด background
    //   ผลกระทบต่อระบบเดิม: 0% — ผลลัพธ์เหมือนเดิม แค่ช้าลงเล็กน้อยเพื่อให้ scroll ลื่น
    const yieldToBrowser = () => new Promise((resolve) => {
      if (typeof requestIdleCallback === "function") {
        requestIdleCallback(() => resolve(), { timeout: 50 });  // รอไม่เกิน 50ms
      } else {
        setTimeout(resolve, 0);  // fallback สำหรับเบราว์เซอร์เก่า
      }
    });

    // วนลูปโหลดทุก page จนกว่า songsHasMore=false
    // (สำหรับ 10,000 เพลง = 200 pages × ~50ms = ~10s — แต่ CDN cache ทำให้เร็วกว่า)
    while (STATE.songsHasMore) {
      await loadMoreSongs();
      pagesLoaded += 1;
      // re-render ทุก 3 pages (เพื่อ user เห็นผลค้นหาเพิ่มขึ้นเรื่อยๆ โดยไม่กระตุก)
      const now = Date.now();
      if (now - lastRenderAt > 200) {
        renderSongGrid();
        renderPlaylists();
        togglePlaylistsVisibility();
        lastRenderAt = now;
      }
      // 🔧 yield ให้ browser ระหว่าง loop → กันกระตุก scroll/paint
      await yieldToBrowser();
      // Safety: กันลูปไม่รู้จบ (สูงสุด 500 pages = 25,000 เพลง)
      if (pagesLoaded > 500) break;
    }
    // re-render ครั้งสุดท้ายเพื่อแสดงผลค้นหาทั้งหมด
    renderSongGrid();
    renderPlaylists();
    togglePlaylistsVisibility();
  } finally {
    STATE.songsLoadingAllRemaining = false;
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
    for (const entry of entries) {
      if (entry.isIntersecting && STATE.songsHasMore && !STATE.songsLoading) {
        await loadMoreSongs();
        renderSongGrid();
      }
    }
  }, { rootMargin: "200px" });  // trigger เมื่อ sentinel อยู่ใกล้ viewport 200px
  observer.observe(sentinel);
  // เก็บ observer ไว้ใน STATE เพื่อ disconnect ภายหลัง (ถ้าต้องการ)
  STATE.songListObserver = observer;
}

function renderCategoryChips() {
  const wrap = document.getElementById("categoryChips");
  if (!wrap) return;
  let html = `<div class="chip${STATE.currentCategory === "all" ? " active" : ""}" data-cat="all">ทั้งหมด</div>`;
  STATE.categories.forEach(c => {
    html += `<div class="chip${STATE.currentCategory === c.id ? " active" : ""}" data-cat="${c.id}">${escapeHtml(c.category_name)}</div>`;
  });
  wrap.innerHTML = html;
  wrap.querySelectorAll(".chip").forEach(el => {
    el.addEventListener("click", () => {
      STATE.currentCategory = el.getAttribute("data-cat");
      STATE.currentDj = null;
      // 🔧 (2026-09-18 v6 Full System): เมื่อกดหมวดหมู่ ถ้ายังโหลดเพลงไม่ครบ → trigger auto-load-all
      //   กันกรณีที่เพลงของหมวดนี้อยู่ใน page หลัง → filter ไม่เจอ
      if (STATE.songsHasMore && !STATE.songsLoadingAllRemaining) {
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

function renderDjRow() {
  const wrap = document.getElementById("djRow");
  if (!wrap) return;
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
      if (STATE.songsHasMore && !STATE.songsLoadingAllRemaining) {
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

function renderSongGrid() {
  const list = getFilteredSongs();
  const grid = document.getElementById("songGrid");
  const empty = document.getElementById("emptyState");
  if (!grid) return;
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
  grid.innerHTML = list.map(s => `
    <div class="song-card song-card-row" data-id="${s.id}">
      <div class="song-cover">
        <img src="${s.cover_url || "default-song-cover.svg"}" loading="lazy" alt="${escapeHtml(s.song_name)}" onerror="this.src='default-song-cover.svg'">
        <button class="play-btn" data-play="${s.id}" aria-label="เล่น ${escapeHtml(s.song_name)}"><svg width="16" height="16" viewBox="0 0 24 24" fill="#fff"><path d="M8 5v14l11-7z"/></svg></button>
      </div>
      <div class="song-info">
        <div class="song-name">${escapeHtml(s.song_name)}</div>
        <div class="song-meta-row">
          ${s.dj_name ? `<span class="song-dj-tag">🎧 ${escapeHtml(s.dj_name)}</span>` : ""}
          ${s.artist ? `<span class="song-meta-text">${escapeHtml(s.artist)}</span>` : ""}
        </div>
        <div class="song-footer">
          <div class="song-price-block">
            ${renderDiscountedPriceForSong(s)}
          </div>
          <button class="cart-add-btn cart-add-btn-row" type="button" data-add-cart="${s.id}" aria-label="เพิ่ม ${escapeHtml(s.song_name)} ลงตะกร้า">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M9 14v-3.5"/><circle cx="8" cy="14.5" r="1.5"/><path d="M14 13v-3.5"/><circle cx="13" cy="13.5" r="1.5"/></svg>
            <span>เพิ่มลงตะกร้า</span>
          </button>
        </div>
      </div>
    </div>
  `).join("");

  grid.querySelectorAll("[data-play]").forEach(el => {
    el.addEventListener("click", (ev) => { ev.stopPropagation(); unlockAudio(); playSong(el.getAttribute("data-play")); });
  });

  grid.querySelectorAll("[data-add-cart]").forEach(el => {
    el.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const song = findSong(el.getAttribute("data-add-cart"));
      if (song) {
        addToCart(song);
      }
    });
  });

  grid.querySelectorAll(".song-card").forEach(el => {
    el.addEventListener("click", () => openSongModal(el.getAttribute("data-id")));
  });
  updatePlayButtonsUI();
}

const openPlaylists = new Set();

function renderPlaylists() {
  const container = document.getElementById("playlistsContainer");
  if (!container) return;
  if (STATE.playlists.length === 0) { container.innerHTML = ""; return; }

  // 🔧 เพิ่ม (2026-09-14): ถ้าเลือก DJ อยู่ → กรองเพลย์ลิสต์/เพลงตาม DJ คนนั้น
  // - ดึง dj_name จาก DJ ที่เลือก (ปลอดภัยเพราะเป็น null ถ้าไม่ได้เลือก)
  // - ไม่กระทบกระบวนการเดิม (ค้นหา/toggle/ราคา/ปุ่มซื้อ)
  const selectedDjName = STATE.currentDj
    ? (STATE.djs.find(d => d.id === STATE.currentDj)?.dj_name || null)
    : null;

  // กรองเพลย์ลิสต์ตามคำค้นหาด้วย (ถ้าช่องค้นหาตรงกับชื่อเพลย์ลิสต์ จะแสดงเพลย์ลิสต์นั้น)
  const filteredPlaylists = STATE.playlists.filter(pl => {
    // 🔧 เพิ่ม (2026-09-14): ถ้าเลือก DJ แล้ว เพลย์ลิสต์ต้องมีเพลงของ DJ คนนั้นอย่างน้อย 1 เพลง
    if (selectedDjName) {
      const hasDjSong = STATE.songs.some(s =>
        s.playlist_id === pl.id && s.dj_name === selectedDjName
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
    if (songs.length === 0) return "";
    // 🔧 เพิ่ม (2026-09-14): ถ้าเลือก DJ แล้ว ให้แสดงเฉพาะเพลงของ DJ คนนั้นในเพลย์ลิสต์
    // - ถ้าไม่ได้เลือก DJ จะแสดงเพลงทั้งหมดในเพลย์ลิสต์เหมือนเดิม
    const displaySongs = selectedDjName
      ? songs.filter(s => s.dj_name === selectedDjName)
      : songs;
    if (displaySongs.length === 0) return "";
    const isOpen = openPlaylists.has(pl.id) || (STATE.search && STATE.search.length > 0); // เปิดอัตโนมัติเมื่อกำลังค้นหา
    // 🔧 เพิ่ม (2026-09-14): เมื่อเลือก DJ ให้ auto-expand เพลย์ลิสต์ที่มีเพลงของ DJ คนนั้น เพื่อให้เห็นเพลงเลย
    const isAutoOpenForDj = !!selectedDjName;
    const finalIsOpen = isOpen || isAutoOpenForDj;
    const cover = pl.cover_url || songs[0]?.cover_url || "default-playlist-cover.svg";
    // 🔧 เพิ่ม (2026-09-14): ป้ายจำนวนเพลงแสดงเฉพาะเพลงของ DJ คนนั้น ถ้าเลือก DJ
    const songCountLabel = selectedDjName
      ? `${displaySongs.length} เพลง`
      : `${songs.length} เพลง`;
    return `
      <div class="playlist-block" data-playlist-id="${pl.id}">
        <div class="playlist-folder-btn" data-toggle-playlist="${pl.id}">
          <div class="playlist-folder-cover">
            <img src="${cover}" loading="lazy" alt="${escapeHtml(pl.playlist_name)}" onerror="this.style.display='none'">
          </div>
          <div class="playlist-folder-info">
            <div class="playlist-folder-name">${escapeHtml(pl.playlist_name)}</div>
            <div class="playlist-folder-count">${songCountLabel}</div>
            ${pl.price ? `
            <div class="playlist-folder-bottom">
              <div class="playlist-folder-price-block">
                ${renderDiscountedPriceForPlaylist(pl)}
              </div>
              <button type="button" class="cart-add-btn playlist-folder-buy-btn" data-add-cart-playlist="${pl.id}" aria-label="ซื้อเพลย์ลิสต์ ${escapeHtml(pl.playlist_name)}">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M9 14v-3.5"/><circle cx="8" cy="14.5" r="1.5"/><path d="M14 13v-3.5"/><circle cx="13" cy="13.5" r="1.5"/></svg>
                <span>ซื้อทั้งเพลย์ลิสต์</span>
              </button>
            </div>
            ` : ""}
          </div>
          <svg class="playlist-folder-arrow${finalIsOpen ? "" : " is-closed"}" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3c7.2 0 9 1.8 9 9s-1.8 9 -9 9s-9 -1.8 -9 -9s1.8 -9 9 -9z"/><path d="M8 10l4 4l4 -4"/></svg>
        </div>
        <div class="playlist-row-wrap${finalIsOpen ? "" : " is-closed"}">
          <div class="playlist-row">
            ${displaySongs.map(s => `
              <div class="playlist-song-row song-card-row" data-id="${s.id}">
                <div class="playlist-cover song-cover">
                  <img src="${s.cover_url || pl.cover_url || "default-song-cover.svg"}" loading="lazy" alt="${escapeHtml(s.song_name)}" onerror="this.src='default-song-cover.svg'">
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
                    <button class="cart-add-btn playlist-add-cart cart-add-btn-row" type="button" data-add-cart-song="${s.id}" aria-label="เพิ่ม ${escapeHtml(s.song_name)} ลงตะกร้า">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M9 14v-3.5"/><circle cx="8" cy="14.5" r="1.5"/><path d="M14 13v-3.5"/><circle cx="13" cy="13.5" r="1.5"/></svg>
                      <span>เพิ่มลงตะกร้า</span>
                    </button>
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
      if (willOpen) openPlaylists.add(id); else openPlaylists.delete(id);
    });
  });

  container.querySelectorAll("[data-add-cart-playlist]").forEach(btn => {
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const pl = STATE.playlists.find(p => p.id === btn.getAttribute("data-add-cart-playlist"));
      if (!pl) return;
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
  container.querySelectorAll(".playlist-song-row").forEach(el => {
    el.addEventListener("click", () => openSongModal(el.getAttribute("data-id")));
  });
  updatePlayButtonsUI();
}

function togglePlaylistsVisibility() {
  const wrapper = document.querySelector(".playlist-wrapper");
  if (!wrapper) return;
  // แสดงเพลย์ลิสต์เฉพาะหน้าแรกที่เลือก "ทั้งหมด" หรือแท็บเพลย์ลิสต์
  // 🔧 เพิ่ม (2026-09-14): ถ้าเลือก DJ อยู่ ให้ซ่อนเพลย์ลิสต์ทั้งหมด (รวมหัวข้อ "เพลย์ลิสต์")
  // - เนื่องจากเพลงของ DJ จะแสดงอยู่ในรายการเพลงหลักอยู่แล้ว ไม่ต้องแสดงเพลย์ลิสต์ซ้ำ
  wrapper.style.display =
    (STATE.currentView === "playlist" ||
    (STATE.currentView === "home" && STATE.currentCategory === "all")) && !STATE.currentDj
      ? ""
      : "none";
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

  // แท็บเพลย์ลิสต์และ DJ ซ่อนรายการเพลงทั้งหมด ส่วนหมวดหมู่ยังดูเพลงที่กรองได้
  // หมายเหตุ (แก้บั๊ก 2026-09-13): เอา "#emptyState" ออกจาก loop นี้ เพราะเดิมมันไป
  // set display="" ทับค่าที่ renderSongGrid() เพิ่งเซ็ตไว้ถูกต้อง (none ตอนมีเพลง)
  // ทำให้กล่อง "ไม่พบเพลงที่ค้นหา" โผล่ค้างอยู่ใต้รายการเพลงเสมอ ไม่ว่าจะมีผลลัพธ์หรือไม่
  ["#gridTitle", "#songGrid"].forEach(selector => {
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
    STATE.currentLoadingId = null;
    updatePlayButtonsUI();
  }).catch(() => {
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

document.getElementById("modalJumpToIntro").addEventListener("click", () => {
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

document.getElementById("modalJumpToPreview").addEventListener("click", () => {
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

document.getElementById("modalJumpToOutro").addEventListener("click", () => {
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
if (modalCloseBtn) modalCloseBtn.addEventListener("click", () => backdropEl && backdropEl.classList.remove("show"));
if (backdropEl) backdropEl.addEventListener("click", (e) => { if (e.target === e.currentTarget) e.currentTarget.classList.remove("show"); });

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

document.querySelectorAll(".bottom-nav button").forEach(btn => {
  btn.addEventListener("click", () => {
    const tab = btn.getAttribute("data-tab");
    document.querySelectorAll(".bottom-nav button").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    // 🎁 (2026-09-20) เพิ่มใหม่: ซ่อน promotionsView ทุกครั้งที่กดแท็บใด ๆ
    //   เพื่อให้แน่ใจว่า view โปรโมชั่นจะถูกซ่อนเสมอเมื่อเปลี่ยนไปแท็บอื่น
    //   ไม่กระทบ branch เดิม — เพียงเรียกฟังก์ชัน hidePromotionsView() ที่เช็ค element เอง (ปลอดภัย)
    hidePromotionsView();
    if (tab === "home") {
      hideMyOrdersView();
      cleanupMyOrdersView();
      STATE.currentCategory = "all";
      STATE.currentDj = null;
      setView("home");
      renderCategoryChips();
      renderDjRow(); // 🎧 (2026-09-20) re-render DJ row เพื่อลบ class selected (วงกลมแดง) หลังออกจากหน้า DJ
      renderSongGrid();
      renderPlaylists();
      renderPromotionBanner(); // 🎁 (2026-09-20) เพิ่มใหม่: แสดงแบนเนอร์โปรโมชั่นใหม่ (เผื่อถูกซ่อนตอนอยู่แท็บอื่น)
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
    else if (tab === "playlist") {
      hideMyOrdersView();
      cleanupMyOrdersView();
      setView("playlist");
      renderPlaylists();
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
    else if (tab === "category") {
      hideMyOrdersView();
      cleanupMyOrdersView();
      STATE.currentCategory = "all";
      STATE.currentDj = null;
      setView("category");
      renderCategoryChips();
      renderDjRow(); // 🎧 (2026-09-20) re-render DJ row เพื่อลบ class selected (วงกลมแดง) หลังออกจากหน้า DJ
      renderSongGrid();
      renderPlaylists();
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
    else if (tab === "dj") {
      hideMyOrdersView();
      cleanupMyOrdersView();
      STATE.currentCategory = "all";
      STATE.currentDj = null;
      setView("dj");
      renderDjRow();
      renderSongGrid();
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
    else if (tab === "myorders") {
      // ===== เพิ่มใหม่: tab "ออเดอร์ของฉัน" =====
      showMyOrdersView();
      initMyOrdersView();
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
    else if (tab === "promotions") {
      // 🎁 (2026-09-20) เพิ่มใหม่: tab "โปรโมชั่น" — หน้าพรีวิวโปรโมชั่นทั้งหมดที่ active
      //   - ไม่แตะ branch เดิม ใช้ showPromotionsView()/hidePromotionsView() แยกต่างหาก
      //   - เรียก renderPromotionsView() เพื่อวาดการ์ดโปรโมชั่น + countdown
      //   - ซ่อน view อื่น ๆ ที่อาจเปิดอยู่ (myOrdersView)
      hideMyOrdersView();
      cleanupMyOrdersView();
      showPromotionsView();
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
    else if (tab === "contact") {
      window.open(buildWhatsAppLink(STATE.settings.whatsapp_number, "สวัสดีครับ/ค่ะ ต้องการสอบถามเกี่ยวกับร้านเพลง"), "_blank");
    }
  });
});

// ===== เพิ่มใหม่: ซ่อน/แสดง view "ออเดอร์ของฉัน" + ซ่อน view อื่นๆ =====
function showMyOrdersView() {
  // ซ่อน view อื่นๆ (gridTitle, songGrid, category chips, dj, playlists, emptyState)
  ["#gridTitle", "#songGrid", "#emptyState"].forEach(selector => {
    const el = document.querySelector(selector);
    if (el) el.style.display = "none";
  });
  const categoryChips = document.getElementById("categoryChips");
  const djSection = document.getElementById("djSection");
  if (categoryChips) categoryChips.style.display = "none";
  if (djSection) djSection.style.display = "none";
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

// ===== เพิ่มใหม่: ติดตามออเดอร์ (ฝั่งลูกค้า ไม่ต้อง Login) — ไม่แตะระบบเดิม =====
// ลูกค้ากรอกเลข Order + ชื่อ + เบอร์โทร เพื่อค้นหาและตรวจสอบสถานะออเดอร์ของตัวเอง
function normalizePhone(v) {
  let s = String(v || "").replace(/[^0-9]/g, "");
  // 🔧 แก้บั๊ก C5 (2026-09-17): strip country code Laos + 0 นำหน้าออก ให้เบอร์ Laos ทุกรูปแบบเทียบเท่ากัน
  //   "+85620XXXXXXXX" → "20XXXXXXXX"
  //   "85620XXXXXXXX"  → "20XXXXXXXX"
  //   "020XXXXXXXX"     → "20XXXXXXXX"
  //   "20XXXXXXXX"      → "20XXXXXXXX" (ไม่เปลี่ยน)
  //   สอดคล้องกับ normalizePhoneServer ฝั่ง worker/index.js (ที่แก้พร้อมกัน)
  //   ทำให้ลูกค้า Laos ที่สั่งด้วยเบอร์ +85620... จะหาออเดอร์ได้ถ้ากรอก 020... หรือ 20...
  if (s.startsWith("856")) s = s.slice(3);
  if (s.startsWith("0")) s = s.replace(/^0+/, "");
  return s;
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

// ---- เพิ่มใหม่: ลูกค้าลบออเดอร์ของตัวเองได้ (เฉพาะสถานะ "รอตรวจสอบการโอน" กันลบออเดอร์ที่แอดมินเริ่มดำเนินการแล้ว) ----
function canCustomerDeleteOrder(order) {
  return !!order && order.status === "pending_verify";
}

async function handleCustomerDeleteOrder(order, onDeleted) {
  if (!order || !order._docId) {
    showToast("ไม่พบข้อมูลออเดอร์นี้ กรุณาลองใหม่", "error");
    return;
  }
  const confirmed = window.confirm(`ต้องการลบ Order ${order.receipt_number || ""} ใช่หรือไม่? เมื่อลบแล้วจะไม่สามารถกู้คืนได้`);
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
  const items = order.items || [];
  const itemsHtml = items.map(item => `
    <div class="track-order-item">
      <span class="track-order-item-name">${escapeHtml(item.title || "เพลง")}</span>
      <span class="track-order-item-price">${formatPrice(item.price)}</span>
    </div>
  `).join("");

  resultEl.innerHTML = `
    <div class="track-order-status" style="color:${cfg.color};background:${cfg.bg};">${cfg.emoji} ${escapeHtml(cfg.label)}</div>
    <div class="track-order-row"><span>เลข Order</span><strong>${escapeHtml(order.receipt_number || "")}</strong></div>
    <div class="track-order-row"><span>ชื่อลูกค้า</span><strong>${escapeHtml(order.customer_name || "")}</strong></div>
    <div class="track-order-row"><span>เบอร์โทร</span><strong>${escapeHtml(order.whatsapp || "")}</strong></div>
    <div class="track-order-items">${itemsHtml}</div>
    <div class="track-order-total"><span>ยอดรวม</span><span>${formatPrice(order.total)}</span></div>
    ${/* 🔧 (2026-09-16): แสดงกล่องดาวน์โหลด ZIP ถ้าออเดอร์มี zip_download_url และสถานะเป็น processing หรือ completed */ ""}
    ${(order.zip_download_url && (order.status === "processing" || order.status === "completed"))
      ? `<div class="track-order-zip" style="margin-top:10px;padding:10px;background:rgba(16,185,129,.08);border-radius:10px;">
          <div style="font-size:12px;color:var(--success);font-weight:600;margin-bottom:6px;">📦 ไฟล์เพลงพร้อมดาวน์โหลด</div>
          <a href="${escapeHtml(order.zip_download_url)}" target="_blank" rel="noopener" class="btn" style="display:inline-block;padding:8px 16px;font-size:13px;text-decoration:none;">⬇️ ดาวน์โหลด ZIP (${escapeHtml(order.zip_file_name || 'Order.zip')})</a>
        </div>`
      : (order.status === "processing")
        ? `<div style="margin-top:10px;font-size:12px;color:var(--accent);">⏳ แอดมินกำลังเตรียมไฟล์ ZIP ส่งให้คุณ — รอสักครู่</div>`
        : (order.status === "pending_verify")
          ? `<div style="margin-top:10px;font-size:12px;color:var(--text-dim);">⏳ รอแอดมินตรวจสอบการโอนเงิน — หลังยืนยันแล้วไฟล์จะถูกเตรียมให้</div>`
          : ""}
    <div class="track-order-actions">
      <button class="btn" type="button" id="trackOrderWhatsappBtn">ติดต่อแอดมินผ่าน WhatsApp</button>
      ${canCustomerDeleteOrder(order) ? `<button class="btn danger" type="button" id="trackOrderDeleteBtn">ลบออเดอร์นี้</button>` : ""}
    </div>
  `;
  resultEl.hidden = false;

  const waBtn = document.getElementById("trackOrderWhatsappBtn");
  if (waBtn) {
    waBtn.onclick = () => {
      const number = STATE.settings.whatsapp_number;
      if (!number) { showToast("ร้านยังไม่ได้ตั้งค่าเบอร์ WhatsApp", "error"); return; }
      window.open(buildWhatsAppLink(number, buildTrackOrderWhatsAppText(order)), "_blank", "noopener");
    };
  }

  const deleteBtn = document.getElementById("trackOrderDeleteBtn");
  if (deleteBtn) {
    deleteBtn.onclick = () => {
      handleCustomerDeleteOrder(order, () => {
        resultEl.hidden = true;
        resultEl.innerHTML = "";
      });
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
    return `
      <button class="track-order-all-card" type="button" data-track-all-index="${index}">
        <div class="track-order-all-card-top">
          <span class="track-order-all-card-id">${escapeHtml(order.receipt_number || "")}</span>
          <span class="track-order-all-card-status" style="color:${cfg.color};background:${cfg.bg};">${cfg.emoji} ${escapeHtml(cfg.label)}</span>
        </div>
        <div class="track-order-all-card-bottom">
          <span>${escapeHtml(dateStr)}</span>
          <span>${formatPrice(order.total)}</span>
        </div>
      </button>
    `;
  }).join("");
  listEl.hidden = false;

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
  const items = order.items || [];
  const itemsHtml = items.map(item => `
    <div class="track-order-item">
      <span class="track-order-item-name">${escapeHtml(item.title || "เพลง")}</span>
      <span class="track-order-item-price">${formatPrice(item.price)}</span>
    </div>
  `).join("");

  contentEl.innerHTML = `
    <div class="track-order-status" style="color:${cfg.color};background:${cfg.bg};">${cfg.emoji} ${escapeHtml(cfg.label)}</div>
    <div class="track-order-row"><span>เลข Order</span><strong>${escapeHtml(order.receipt_number || "")}</strong></div>
    <div class="track-order-row"><span>ชื่อลูกค้า</span><strong>${escapeHtml(order.customer_name || "")}</strong></div>
    <div class="track-order-row"><span>เบอร์โทร</span><strong>${escapeHtml(order.whatsapp || "")}</strong></div>
    <div class="track-order-items">${itemsHtml}</div>
    <div class="track-order-total"><span>ยอดรวม</span><span>${formatPrice(order.total)}</span></div>
    <div class="track-order-actions">
      <button class="btn" type="button" id="trackOrderAllWhatsappBtn">ติดต่อแอดมินผ่าน WhatsApp</button>
      ${canCustomerDeleteOrder(order) ? `<button class="btn danger" type="button" id="trackOrderAllDeleteBtn">ลบออเดอร์นี้</button>` : ""}
    </div>
  `;

  if (listEl) listEl.hidden = true;
  detailEl.hidden = false;

  const waBtn = document.getElementById("trackOrderAllWhatsappBtn");
  if (waBtn) {
    waBtn.onclick = () => {
      const number = STATE.settings.whatsapp_number;
      if (!number) { showToast("ร้านยังไม่ได้ตั้งค่าเบอร์ WhatsApp", "error"); return; }
      window.open(buildWhatsAppLink(number, buildTrackOrderWhatsAppText(order)), "_blank", "noopener");
    };
  }

  const deleteBtn = document.getElementById("trackOrderAllDeleteBtn");
  if (deleteBtn) {
    deleteBtn.onclick = () => {
      // 🔧 (2026-09-17): ลบแล้วปิดหน้า detail กลับไปที่ลิสต์ + ยิง refresh ทันที (เดิมใช้ polling อัปเดตเอง)
      handleCustomerDeleteOrder(order, () => {
        closeTrackOrderAllDetail();
        fetchTrackOrderAllOnce();  // one-shot refresh ลิสต์หลังลบ
      });
    };
  }
}

function closeTrackOrderAllDetail() {
  const listEl = document.getElementById("trackOrderAllList");
  const detailEl = document.getElementById("trackOrderAllDetail");
  if (detailEl) detailEl.hidden = true;
  if (listEl) listEl.hidden = false;
}

function startTrackOrderAllListener(name, phone) {
  stopTrackOrderAllListener();
  const listEl = document.getElementById("trackOrderAllList");
  const detailEl = document.getElementById("trackOrderAllDetail");
  if (listEl) listEl.hidden = true;
  if (detailEl) detailEl.hidden = true;

  // 🔧 (2026-09-17): บันทึก name+phone ไว้ใช้ตอน visibility เปลี่ยน (กลับเข้า tab ใหม่)
  trackOrderAllCurrentName = name;
  trackOrderAllCurrentPhone = phone;

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
    matched.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
    trackOrderAllOrders = matched;
    setTrackOrderAllFeedback("");
    renderTrackOrderAllList(matched);
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

const trackOrderBtnEl = document.getElementById("trackOrderBtn");
if (trackOrderBtnEl) trackOrderBtnEl.addEventListener("click", openTrackOrder);
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
    return;
  }
  try {
    const { snap } = await fetchCustomerOrdersOnce({
      customerName: info.name,
      whatsapp: info.whatsapp,
    });
    // นับเฉพาะออเดอร์ที่ active: pending_verify + processing
    let count = 0;
    snap.forEach((d) => {
      const status = String(d.data()?.status || "");
      if (status === "pending_verify" || status === "processing") count += 1;
    });
    updateTrackOrderBadge(count);
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
  return { value: String(v), unit: "" };
}

// แปลง type code → ข้อความไทยสั้น ๆ สำหรับ tag
function promo_getTypeLabel(type) {
  if (type === "cart_percent") return "ลด % ทั้งยอด";
  if (type === "cart_fixed")   return "ลดจำนวนเงิน";
  if (type === "buy_x_get_y_percent") return "ซื้อ X ลด %";
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
//   - ถ้าไม่มีโปร active → ซ่อนแบนเนอร์ (hidden)
//   - ถ้ามี → แสดงชื่อ + ส่วนลด + countdown compact
//   - กดที่แบนเนอร์ → สลับไปแท็บ "โปรโมชั่น"
function renderPromotionBanner() {
  const banner = document.getElementById("promoHomeBanner");
  if (!banner) return;
  const featured = promo_pickFeaturedPromotion();
  if (!featured) {
    banner.hidden = true;
    return;
  }
  banner.hidden = false;
  const titleEl = document.getElementById("promoHomeBannerTitle");
  const discountEl = document.getElementById("promoHomeBannerDiscount");
  const countdownEl = document.getElementById("promoHomeBannerCountdown");
  if (titleEl) titleEl.textContent = featured.name || "โปรโมชั่นพิเศษ";
  if (discountEl) discountEl.textContent = "ลด " + promo_formatDiscountValue(featured);
  if (countdownEl) {
    const p = promo_getCountdownParts(featured.end_at);
    countdownEl.textContent = promo_formatCountdownCompact(featured.end_at);
    countdownEl.classList.toggle("urgent", p.urgent);
  }
  // ผูก click (ครั้งเดียว — กันซ้ำ)
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
    list.innerHTML = `
      <div class="promo-view-empty">
        <div class="promo-view-empty-icon">🎁</div>
        <div class="promo-view-empty-text">ยังไม่มีโปรโมชั่นในขณะนี้</div>
        <div class="promo-view-empty-sub">กดแท็บ "ติดต่อ" เพื่อสอบถามโปรพิเศษจากร้านได้</div>
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
    list.innerHTML = `
      <div class="promo-view-empty">
        <div class="promo-view-empty-icon">🎁</div>
        <div class="promo-view-empty-text">ยังไม่มีโปรโมชั่นในขณะนี้</div>
        <div class="promo-view-empty-sub">กดแท็บ "ติดต่อ" เพื่อสอบถามโปรพิเศษจากร้านได้</div>
      </div>`;
    return;
  }

  // วาดการ์ดทีละใบ
  list.innerHTML = visible.map(p => {
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

    // วันที่เริ่มต้น/สิ้นสุด
    const startDate = formatDateTime(p.start_at);
    const endDate   = formatDateTime(p.end_at);

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
  }).join("");

  // ผูกปุ่ม CTA — กดแล้วสลับไปแท็บ "หน้าแรก" เพื่อให้ลูกค้าเลือกเพลง
  list.querySelectorAll("[data-promo-cta]").forEach(btn => {
    btn.addEventListener("click", () => {
      const homeBtn = document.querySelector('.bottom-nav button[data-tab="home"]');
      if (homeBtn) homeBtn.click();
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
  const categoryChips = document.getElementById("categoryChips");
  const djSection = document.getElementById("djSection");
  if (categoryChips) categoryChips.style.display = "none";
  if (djSection) djSection.style.display = "none";
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
  // วาดการ์ดใหม่ทุกครั้งที่เปิด (เผื่อ cache หมดอายุ)
  renderPromotionsView();
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
  const banner = document.getElementById("promoHomeBanner");
  if (banner && !banner.hidden) {
    const featured = promo_pickFeaturedPromotion();
    const countdownEl = document.getElementById("promoHomeBannerCountdown");
    if (featured && countdownEl) {
      const p = promo_getCountdownParts(featured.end_at);
      if (p.expired) {
        // โปรหมดเวลา → รีเฟรชแบนเนอร์ใหม่ (อาจเลือกโปรอื่นแทน)
        renderPromotionBanner();
      } else {
        countdownEl.textContent = promo_formatCountdownCompact(featured.end_at);
        countdownEl.classList.toggle("urgent", p.urgent);
      }
    } else if (!featured) {
      // ไม่มีโปรแล้ว → ซ่อนแบนเนอร์
      banner.hidden = true;
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
let _promoCountdownInterval = null;
function startPromoCountdown() {
  if (_promoCountdownInterval) return; // กันเริ่มซ้ำ
  _promoCountdownInterval = setInterval(updatePromoCountdowns, 1000);
}

