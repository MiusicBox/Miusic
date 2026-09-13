// app-user.js — หน้า User: ดึงข้อมูลจาก Firestore, เล่นเพลงจาก Cloudinary โดยตรง
// ===================================================
import { db } from "./firebase-init.js?v=20260905-fix1";
import { collection, getDocs, doc, getDoc, query, where, onSnapshot, deleteDoc, queryCustomerOrder, listenCustomerOrders } from "./db-client.js";
import { initCart } from "./app-cart.js?v=20260912-login-fix";
// ===== ลดราคา + โปรโมชั่น + ออเดอร์ของฉัน (ระบบใหม่ — รวมในไฟล์เดียว app-promotion.js) =====
import {
  fetchActiveDiscounts, fetchActivePromotions, applyDiscountToPrice, findActiveDiscountFor,
  initMyOrdersView, cleanupMyOrdersView
} from "./app-promotion.js?v=20261101-promo1";

const STATE = {
  songs: [], categories: [], djs: [], playlists: [], settings: {},
  discounts: [],  // ← ลดราคาที่ active อยู่ตอนนี้ (โหลดครั้งเดียวตอน init)
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
  if (!playlist) return formatPrice(0);
  const original = Number(playlist.price) || 0;
  const discount = findActiveDiscountFor({ targetType: "playlist", targetId: playlist.id, discounts: STATE.discounts });
  if (!discount) return formatPrice(original);
  const { finalPrice, hasDiscount } = applyDiscountToPrice(original, discount);
  if (!hasDiscount) return formatPrice(original);
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

async function init() {
  loadCart();
  bindCartEvents();
  const [songsSnap, catSnap, djSnap, playlistSnap, settingsSnap] = await Promise.all([
    getDocs(collection(db, "songs")),
    getDocs(collection(db, "categories")),
    getDocs(collection(db, "djs")),
    getDocs(collection(db, "playlists")),
    getDoc(doc(db, "settings", "main"))
  ]);
  STATE.songs = songsSnap.docs.map(d => ({ id: d.id, ...d.data() })).filter(s => s.status !== "hidden");
  STATE.categories = catSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  STATE.djs = djSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  STATE.playlists = playlistSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  STATE.settings = settingsSnap.exists() ? settingsSnap.data() : {};

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

  const siteNameEl = document.getElementById("siteName");
  if (siteNameEl) siteNameEl.textContent = STATE.settings.website_name || "Music Store";
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
  setView("home");
  togglePlaylistsVisibility();
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
  wrap.innerHTML = STATE.djs.map(d =>
    `<div class="dj-item" data-dj="${d.id}">
      <img class="dj-avatar" src="${d.image_url || ""}">
      <div class="dj-name">${escapeHtml(d.dj_name)}</div>
    </div>`
  ).join("");
  wrap.querySelectorAll(".dj-item").forEach(el => {
    el.addEventListener("click", () => {
      const selectedDjId = el.getAttribute("data-dj");
      // กด DJ คนเดิมซ้ำอีกครั้งเพื่อยกเลิกตัวกรองและแสดงเพลงของ DJ ทุกคน
      STATE.currentDj = STATE.currentDj === selectedDjId ? null : selectedDjId;
      STATE.currentCategory = "all";
      renderCategoryChips();
      renderSongGrid();
      renderPlaylists();
      togglePlaylistsVisibility();
      const gridTitle = document.getElementById("gridTitle");
      if (gridTitle) gridTitle.scrollIntoView({ behavior: "smooth" });
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
    <div class="song-card" data-id="${s.id}">
      <div class="song-cover">
        <img src="${s.cover_url || ""}">
        <button class="play-btn" data-play="${s.id}"><svg width="16" height="16" viewBox="0 0 24 24" fill="#fff"><path d="M8 5v14l11-7z"/></svg></button>
      </div>
      <div class="song-info">
        <div class="song-name">${escapeHtml(s.song_name)}</div>
        <div class="song-artist">${escapeHtml(s.artist || "")}</div>
        ${s.dj_name ? `<div class="song-dj">DJ: ${escapeHtml(s.dj_name)}</div>` : ""}
        <div class="song-footer" style="display: flex; justify-content: flex-end; align-items: center; margin-top: auto;">
          <button class="cart-add-btn" type="button" data-add-cart="${s.id}" aria-label="เพิ่ม ${escapeHtml(s.song_name)} ลงตะกร้า">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg>
            ${renderDiscountedPriceForSong(s)}
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

  // กรองเพลย์ลิสต์ตามคำค้นหาด้วย (ถ้าช่องค้นหาตรงกับชื่อเพลย์ลิสต์ จะแสดงเพลย์ลิสต์นั้น)
  const filteredPlaylists = STATE.playlists.filter(pl => {
    if (!STATE.search) return true;
    const q = STATE.search.toLowerCase();
    const matchPlName = pl.playlist_name.toLowerCase().includes(q);
    const hasMatchingSongs = STATE.songs.some(s => s.playlist_id === pl.id && [s.song_name, s.artist, s.dj_name].join(" ").toLowerCase().includes(q));
    return matchPlName || hasMatchingSongs;
  });

  container.innerHTML = filteredPlaylists.map(pl => {
    const songs = STATE.songs.filter(s => s.playlist_id === pl.id);
    if (songs.length === 0) return "";
    const isOpen = openPlaylists.has(pl.id) || (STATE.search && STATE.search.length > 0); // เปิดอัตโนมัติเมื่อกำลังค้นหา
    const cover = pl.cover_url || songs[0].cover_url || "";
    return `
      <div class="playlist-block" data-playlist-id="${pl.id}">
        <div class="playlist-folder-btn" data-toggle-playlist="${pl.id}">
          <div class="playlist-folder-cover">
            <img src="${cover}">
          </div>
          <div class="playlist-folder-info">
            <div class="playlist-folder-name">${escapeHtml(pl.playlist_name)}</div>
            <div class="playlist-folder-count">${songs.length} เพลง</div>
          </div>
          <!-- แก้ไข (2026-09-10 รอบ 2): ลดขนาดไอคอน + ชิดมุมขวาล่างของแถวมากขึ้น (right:12px ชิดขอบเดียวกับลูกศร) -->
          <div style="position: absolute; right: 12px; bottom: 5px; display: flex; flex-direction: column; align-items: flex-end; justify-content: flex-end; z-index: 1;">
            ${pl.price ? `<button type="button" class="cart-add-btn playlist-folder-price" data-add-cart-playlist="${pl.id}" aria-label="เพิ่มเพลย์ลิสต์ ${escapeHtml(pl.playlist_name)} ลงตะกร้า">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg>
              ${renderDiscountedPriceForPlaylist(pl)}
            </button>` : ""}
          </div>
          <svg class="playlist-folder-arrow${isOpen ? "" : " is-closed"}" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 9l6 6 6-6"/></svg>
        </div>
        <div class="playlist-row-wrap${isOpen ? "" : " is-closed"}">
          <div class="playlist-row">
            ${songs.map(s => `
              <div class="playlist-song-row" data-id="${s.id}">
                <div class="playlist-cover">
                  <img src="${s.cover_url || pl.cover_url || ""}">
                  <button class="playlist-play-btn" data-play="${s.id}">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="#fff"><path d="M8 5v14l11-7z"/></svg>
                  </button>
                </div>
                <div class="playlist-info">
                  <div class="playlist-item-name">${escapeHtml(s.song_name)}</div>
                  <div class="playlist-item-sub">${escapeHtml(s.dj_name || s.artist || "")}</div>
                </div>
                <div class="playlist-item-price" style="display: flex; flex-direction: column; align-items: flex-end; justify-content: flex-end; position: absolute; right: 0; bottom: 0;">
                  <div style="display: inline-flex; align-items: center; gap: 4px;">
                    <button class="cart-add-btn playlist-add-cart" type="button" data-add-cart-song="${s.id}" aria-label="เพิ่ม ${escapeHtml(s.song_name)} ลงตะกร้า">
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg>
                      ${renderDiscountedPriceForSong(s)}
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
        cover_url: pl.cover_url || firstSong?.cover_url || "",
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
  wrapper.style.display =
    STATE.currentView === "playlist" ||
    (STATE.currentView === "home" && STATE.currentCategory === "all")
      ? ""
      : "none";
}

function setView(view) {
  STATE.currentView = view;
  const showCategory = view === "home" || view === "category";
  // แสดง DJ ในหน้า "ทั้งหมด" หรือหน้า DJ เท่านั้น
  // เมื่อเลือกหมวดหมู่เฉพาะ ให้ซ่อนส่วน DJ ออกจากหน้านั้น
  const showDj =
    view === "dj" ||
    ((view === "home" || view === "category") && STATE.currentCategory === "all");
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

  if (coverEl) coverEl.src = song.cover_url || "";
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

  if (coverEl) coverEl.src = song.cover_url || "";
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
document.getElementById("modalJumpToIntro").addEventListener("click", () => {
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
  searchInputEl.addEventListener("input", debounce((e) => {
    STATE.search = e.target.value.trim();
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
    if (tab === "home") {
      hideMyOrdersView();
      cleanupMyOrdersView();
      STATE.currentCategory = "all";
      STATE.currentDj = null;
      setView("home");
      renderCategoryChips();
      renderSongGrid();
      renderPlaylists();
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
function normalizePhone(v) { return String(v || "").replace(/[^0-9]/g, ""); }
function normalizeName(v) { return String(v || "").trim().toLowerCase(); }

// เพิ่มใหม่: แปล error ดิบจาก Firebase/เน็ตให้เป็นข้อความที่ลูกค้าอ่านเข้าใจ (แทนที่จะโชว์ err.message ภาษาอังกฤษดิบๆ)
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
let trackOrderAllUnsub = null;      // เก็บฟังก์ชันยกเลิก onSnapshot listener ปัจจุบัน
let trackOrderAllOrders = [];       // เก็บผลลัพธ์ล่าสุดไว้ใช้ตอนกดดูรายละเอียดในลิสต์
let trackOrderAllSlowTimer = null;  // เพิ่มใหม่: ตัวจับเวลาแจ้งเตือน "เน็ตช้า" ของ listener ปัจจุบัน

function stopTrackOrderAllListener() {
  if (trackOrderAllUnsub) {
    try { trackOrderAllUnsub(); } catch (err) { /* เพิกเฉย ถ้ายกเลิกซ้ำ */ }
    trackOrderAllUnsub = null;
  }
  if (trackOrderAllSlowTimer) {
    clearTimeout(trackOrderAllSlowTimer);
    trackOrderAllSlowTimer = null;
  }
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
      // เพิ่มใหม่: ลบแล้วปิดหน้า detail กลับไปที่ลิสต์ — listener เรียลไทม์ (onSnapshot) จะอัปเดตลิสต์ให้เองอัตโนมัติ
      handleCustomerDeleteOrder(order, () => {
        closeTrackOrderAllDetail();
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

  // เพิ่มใหม่: ถ้ายังไม่ได้รับข้อมูล snapshot แรกภายในเวลาที่กำหนด แจ้งลูกค้าว่าเน็ตช้า (ยังฟังต่อเบื้องหลัง ไม่ยกเลิก)
  let firstSnapshotReceived = false;
  trackOrderAllSlowTimer = setTimeout(() => {
    if (!firstSnapshotReceived) {
      setTrackOrderAllFeedback("เชื่อมต่อระบบช้ากว่าปกติ กรุณาตรวจสอบอินเทอร์เน็ต (ระบบกำลังลองเชื่อมต่ออยู่)", "error");
    }
  }, 15000);

  // 🔒 Security (2026-09-11): ใช้ listenCustomerOrders แทน onSnapshot บน collection "orders" ทั้งหมด
  // Server กรองเฉพาะออเดอร์ของลูกค้าคนนี้ส่งกลับมา (เทียบชื่อ+เบอร์แบบ normalize ฝั่ง Server)
  // กัน browser เห็นข้อมูลคนอื่นทั้งหมด (เดิมโหลด collection "orders" มากรองเองฝั่ง client)
  // พารามิเตอร์ `phone` ที่ส่งเข้ามาเป็นค่าที่ normalize แล้ว (จาก handleTrackOrderAllSubmit)
  // Server จะ normalize ซ้ำอีกครั้ง (idempotent — ไม่เปลี่ยนค่า) แล้วเทียบกับ order.whatsapp ที่ normalize แล้วเหมือนเดิม
  trackOrderAllUnsub = listenCustomerOrders(
    { customerName: name, whatsapp: phone },
    (snap) => {
      firstSnapshotReceived = true;
      clearTimeout(trackOrderAllSlowTimer);
      trackOrderAllSlowTimer = null;
      const matched = snap.docs
        .map((d) => ({ ...d.data(), _docId: d.id }));
      matched.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
      trackOrderAllOrders = matched;
      setTrackOrderAllFeedback("");
      renderTrackOrderAllList(matched);
    },
    (err) => {
      firstSnapshotReceived = true;
      clearTimeout(trackOrderAllSlowTimer);
      trackOrderAllSlowTimer = null;
      console.error("startTrackOrderAllListener error:", err);
      setTrackOrderAllFeedback(getFriendlyErrorMessage(err));
    }
  );
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

init().catch(err => showToast("โหลดข้อมูลไม่สำเร็จ: " + err.message, "error"));
