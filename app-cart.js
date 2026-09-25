// app-cart.js — ระบบตะกร้าสินค้า
// ===================================================
import { db } from "./firebase-init.js?v=20260905-fix1";
import {
  collection, doc, query, where, getDoc, getDocs, setDoc
} from "./db-client.js";
//
// 🔧 แก้บั๊ก (2026-09-12): "ยังไม่ได้ login" ตอนกดสั่งซื้อ
// -----------------------------------------------------------
// อาการ: ลูกค้าเปิดหน้าเว็บ (index.html) ไม่มีหน้า login แต่กดสั่งซื้อแล้วขึ้น
//        error "ยังไม่ได้เข้าสู่ระบบ" (HTTP 401)
//
// สาเหตุหลัก: Worker เดิมฝั่ง server บังคับ login สำหรับทุกการเขียน (write)
//   รวมถึง PUT /api/db/orders/{id} ของลูกค้า — ทำให้ลูกค้าสั่งซื้อไม่ได้
//   แก้แล้วใน worker/index.js โดยยกเว้น "orders" PUT/DELETE ไม่ต้อง login
//   (ดู comment "ข้อยกเว้นสำหรับ orders (แก้บั๊ก 2026-09-11)" ใน worker/index.js)
//
// สาเหตุรอง: ถึงแม้ worker จะอนุญาตแล้ว แต่ถ้าลูกค้าเคยสั่งซื้อครั้งก่อนแล้ว
//   order ID ค้างอยู่ใน sessionStorage (CHECKOUT_ORDER_KEY) — ครั้งถัดไปที่ลูกค้า
//   กรอกชื่อ+เบอร์เดิม ระบบจะ "reuse order ID เดิม" แต่ order นั้นมีอยู่แล้วใน DB
//   → Worker ส่ง 401 "ยังไม่ได้เข้าสู่ระบบ" กันเขียนทับออเดอร์คนอื่น
//
// การแก้ฝั่ง client (ไฟล์นี้):
//   1) ถ้า setDoc เจอ error "ยังไม่ได้เข้าสู่ระบบ" หรือ "login" → เคลียร์ order ID
//      เก่าใน sessionStorage/state แล้ว retry ครั้งเดียวด้วย ID ใหม่
//   2) ลดโอกาสลูกค้าติดสถานะ "order ID ค้าง" จากครั้งก่อน
// ===================================================
// ===== ลดราคา + โปรโมชั่น (ระบบใหม่) — import มาจาก app-promotion.js กลาง (รวมไฟล์เดียว) =====
import {
  fetchActiveDiscounts, fetchActivePromotions, computeCartPricing, clearPricingCache
} from "./app-promotion.js?v=20261101-promo1";

const CART_STORAGE_KEY = "music_store_cart_v1";
const CHECKOUT_ORDER_KEY = "music_store_checkout_order_v1";
// เพิ่มใหม่: จำออเดอร์ล่าสุดของลูกค้าไว้ในเครื่อง เพื่อให้กลับมาดูใบเสร็จ/แจ้งแอดมินซ้ำได้
// แม้จะปิดใบเสร็จไปแล้วโดยยังไม่ได้กดติดต่อแอดมิน
const LAST_ORDER_STORAGE_KEY = "music_store_last_order_v1";
const BANNER_DISMISS_KEY = "music_store_banner_dismissed_v1"; // sessionStorage — ซ่อนแถบเตือนแค่ชั่วคราวต่อ session
// เพิ่มใหม่: จำชื่อ+เบอร์โทร/WhatsApp ของลูกค้าไว้ในเครื่อง เพื่อเติมให้อัตโนมัติตอนสั่งซื้อครั้งถัดไป (ลดการกรอกซ้ำ)
const CUSTOMER_INFO_STORAGE_KEY = "music_store_customer_info_v1";

export function initCart({ state, showToast, escapeHtml, formatPrice, buildWhatsAppLink }) {
  let submitting = false;
  let activeOrderId = null;
  let activeOrderKey = null;

  function loadCart() {
    try {
      const raw = localStorage.getItem(CART_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(parsed)) throw new Error("cart is not an array");
      const uniqueItems = new Map();
      parsed
        .filter(item => item && item.id && item.song_name)
        .forEach(item => {
          const id = String(item.id);
          if (!uniqueItems.has(id)) {
            const kind = item.kind === "playlist" ? "playlist" : "song";
            const entry = {
              id,
              song_name: String(item.song_name),
              cover_url: String(item.cover_url || ""),
              dj_name: String(item.dj_name || ""),
              price: Math.max(0, Number(item.price) || 0),
              kind,
              quantity: 1
            };
            // เก็บ snapshot เพลงภายในเพลย์ลิสต์ไว้ต่อ (ใช้แสดงผล/ตรวจเพลงซ้ำ ไม่ใช่คิดราคา)
            if (kind === "playlist") {
              entry.song_ids = Array.isArray(item.song_ids) ? item.song_ids.map(String) : [];
              entry.songs = Array.isArray(item.songs)
                ? item.songs
                    .filter(s => s && s.id)
                    .map(s => ({ id: String(s.id), song_name: String(s.song_name || "เพลง") }))
                : [];
            }
            uniqueItems.set(id, entry);
          }
        });
      state.cart = Array.from(uniqueItems.values());
    } catch (_) {
      state.cart = [];
      try { localStorage.removeItem(CART_STORAGE_KEY); } catch (__) {}
    }
    renderCart();
    renderPendingOrderBanner(); // เพิ่มใหม่: เช็คตอนโหลดหน้าว่ามีออเดอร์ค้างแจ้งแอดมินไหม
  }

  function saveCart() {
    try {
      localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(state.cart));
    } catch (_) {
      showToast("บันทึกตะกร้าไม่ได้ กรุณาตรวจสอบพื้นที่จัดเก็บของเบราว์เซอร์", "error");
    }
    renderCart();
  }

  function cartQuantity() {
    return state.cart.reduce((total, item) => total + item.quantity, 0);
  }

  function cartTotal() {
    return state.cart.reduce((total, item) => total + item.price * item.quantity, 0);
  }

  // รวม track id (song id) ทุกรายการที่ "มีอยู่แล้ว" ในตะกร้า ไม่ว่าจะเป็นเพลงเดี่ยว
  // หรือเพลงที่ซ่อนอยู่ภายในเพลย์ลิสต์ที่เพิ่มไปแล้ว — ใช้ตรวจเพลงซ้ำข้ามกันทั้งสองแบบ
  function collectCartSongIds() {
    const ids = new Set();
    state.cart.forEach(item => {
      if (item.kind === "playlist") {
        (item.song_ids || []).forEach(id => ids.add(String(id)));
      } else {
        ids.add(String(item.id));
      }
    });
    return ids;
  }

  function addToCart(song) {
    if (!song || !song.id) return;
    const kind = song.kind === "playlist" ? "playlist" : "song";
    // หมายเหตุ: เดิมมีข้อจำกัดห้ามผสมเพลงเดี่ยว/เพลย์ลิสต์ และห้ามเพิ่มเพลย์ลิสต์เกิน 1 รายการ
    // ตอนนี้รองรับตะกร้าที่มีเพลงหลายเพลง + เพลย์ลิสต์หลายรายการรวมกันแล้ว (ดู resolveCartFromDatabase/checkoutCart)
    const existing = state.cart.find(item => item.id === String(song.id));
    if (existing) {
      showToast("รายการนี้อยู่ในตะกร้าแล้ว", "error");
      return;
    }

    const existingSongIds = collectCartSongIds();
    if (kind === "song") {
      // เพลงเดี่ยวที่จะเพิ่ม ซ้ำกับเพลงที่อยู่ในเพลย์ลิสต์ที่เพิ่มไปแล้วหรือไม่ (ตรวจด้วย track id เดิม)
      if (existingSongIds.has(String(song.id))) {
        showToast("เพลงนี้อยู่ในเพลย์ลิสต์ที่คุณเพิ่มไว้แล้ว", "error");
        return;
      }
    } else {
      // เพลย์ลิสต์ที่จะเพิ่ม มีเพลงซ้ำกับเพลงเดี่ยว/เพลย์ลิสต์อื่นที่อยู่ในตะกร้าแล้วหรือไม่
      const incomingIds = Array.isArray(song.song_ids) ? song.song_ids.map(String) : [];
      const hasOverlap = incomingIds.some(id => existingSongIds.has(id));
      if (hasOverlap) {
        showToast("มีเพลงในเพลย์ลิสต์นี้อยู่ในตะกร้าแล้ว กรุณาตรวจสอบตะกร้าก่อนเพิ่ม", "error");
        return;
      }
    }

    activeOrderId = null;
    activeOrderKey = null;
    const entry = {
      id: String(song.id),
      song_name: String(song.song_name || ""),
      cover_url: String(song.cover_url || ""),
      dj_name: String(song.dj_name || ""),
      price: Math.max(0, Number(song.price) || 0),
      kind,
      quantity: 1
    };
    if (kind === "playlist") {
      entry.song_ids = Array.isArray(song.song_ids) ? song.song_ids.map(String) : [];
      entry.songs = Array.isArray(song.songs)
        ? song.songs.filter(s => s && s.id).map(s => ({ id: String(s.id), song_name: String(s.song_name || "เพลง") }))
        : [];
    }
    state.cart.push(entry);
    showToast("เพิ่มลงตะกร้าแล้ว", "success");
    saveCart();
  }

  function removeFromCart(itemId) {
    state.cart = state.cart.filter(item => item.id !== itemId);
    saveCart();
  }

  function renderCart() {
    const itemsEl = document.getElementById("cartItems");
    const summaryEl = document.getElementById("cartSummary");
    const badgeEl = document.getElementById("cartBadge");
    if (!itemsEl) return;

    const quantity = cartQuantity();
    if (badgeEl) {
      badgeEl.textContent = quantity > 99 ? "99+" : String(quantity);
      badgeEl.hidden = quantity === 0;
    }

    if (state.cart.length === 0) {
      itemsEl.innerHTML = `
        <div class="cart-empty">
          <p>ยังไม่มีเพลงในตะกร้า</p>
          <button class="btn secondary" type="button" data-cart-continue>กลับไปเลือกซื้อเพลง</button>
        </div>`;
      if (summaryEl) summaryEl.hidden = true;
      return;
    }

    // ===== เพิ่มใหม่ (แก้บั๊ก 2026-09-10): คำนวณราคาส่วนลด/โปรโมชั่นแบบ approximate มาแสดงในตะกร้า =====
    // เดิม renderCart() แสดงเฉพาะ item.price ดิบและ cartTotal() ดิบ ไม่เคยเรียก computeCartPricing เลย
    // ทำให้ popup ตะกร้าไม่แสดงส่วนลด/โปรโมชั่น ทั้งที่ตอนกดยืนยันสั่งซื้อจริงคำนวณถูกต้องอยู่แล้ว
    // ใช้ computeApproxPricingForDisplay() ตัวเดียวกับที่ renderCheckoutSummary() ใช้อยู่แล้ว (ด้านล่าง)
    // เป็นค่า "โดยประมาณ" สำหรับแสดงผลเท่านั้น ไม่กระทบ resolveCartFromDatabase/checkoutCart ที่คำนวณราคา
    // จริงจากฐานข้อมูลแยกต่างหากตอนกดยืนยันสั่งซื้ออยู่ดี
    const approxPricing = computeApproxPricingForDisplay();
    const pricingItems = approxPricing?.items || null;

    itemsEl.innerHTML = state.cart.map((item, index) => {
      const isPlaylist = item.kind === "playlist";
      const songCount = isPlaylist ? (item.songs || []).length || (item.song_ids || []).length : 0;
      const metaText = isPlaylist
        ? `เพลย์ลิสต์ · ${songCount} เพลง · ${formatPrice(item.price)}`
        : `${escapeHtml(item.dj_name || "เพลง Remix")} · ${formatPrice(item.price)} / เพลง`;
      const viewSongsBtn = (isPlaylist && (item.songs || []).length)
        ? `<button class="cart-item-viewsongs" type="button" data-cart-view-songs="${escapeHtml(item.id)}">ดูรายการเพลงในเพลย์ลิสต์ (${songCount})</button>
           <div class="cart-item-songs" id="cartSongs-${escapeHtml(item.id)}">
             ${item.songs.map(s => `<div class="cart-item-songs-row">🎵 ${escapeHtml(s.song_name)}</div>`).join("")}
           </div>`
        : "";
      // เพิ่มใหม่: ถ้ารายการนี้มี "ราคาลด" (item-level discount) อยู่ ให้โชว์ราคาปกติขีดฆ่า + ราคาหลังลด
      const pricingItem = pricingItems ? pricingItems[index] : null;
      const itemHasDiscount = !!(pricingItem && pricingItem._hadDiscount);
      const itemTotalHtml = itemHasDiscount
        ? `<span style="text-decoration:line-through;color:var(--text-dim);font-size:11px;display:block;">${formatPrice(item.price * item.quantity)}</span>${formatPrice(pricingItem.discount_price * item.quantity)}`
        : formatPrice(item.price * item.quantity);
      return `
      <div class="cart-item" data-cart-item="${escapeHtml(item.id)}">
        <img class="cart-item-cover" src="${escapeHtml(item.cover_url)}" loading="lazy" alt="">
        <div class="cart-item-info">
          <div class="cart-item-name">${escapeHtml(item.song_name)}</div>
          <div class="cart-item-meta">${metaText}</div>
        </div>
        <div class="cart-item-total">${itemTotalHtml}</div>
        <button class="cart-remove" type="button" data-cart-remove="${escapeHtml(item.id)}">ลบ</button>
        ${viewSongsBtn}
      </div>
    `;
    }).join("");

    if (summaryEl) summaryEl.hidden = false;
    const quantityEl = document.getElementById("cartTotalQuantity");
    const priceEl = document.getElementById("cartTotalPrice");
    const discountRowsEl = document.getElementById("cartDiscountRows");
    if (quantityEl) quantityEl.textContent = `${quantity} เพลง`;

    // เพิ่มใหม่: ยอดรวมตอนนี้ใช้ finalTotal (หลังหักส่วนลด/โปรโมชั่น) แทน cartTotal() ดิบ
    const baseTotal = cartTotal();
    const finalTotal = approxPricing?.finalTotal ?? baseTotal;
    const itemDiscount = approxPricing?.itemDiscountAmount || 0;
    const promoDiscount = approxPricing?.promoDiscountAmount || 0;
    const promoApplied = approxPricing?.promotionApplied;
    const totalDiscount = itemDiscount + promoDiscount;

    if (priceEl) priceEl.textContent = formatPrice(finalTotal);

    // เพิ่มใหม่: แสดงแถวสรุปส่วนลด/โปรโมชั่น (โครงเดียวกับ renderCheckoutSummary ด้านล่าง)
    if (discountRowsEl) {
      if (totalDiscount > 0 && finalTotal < baseTotal) {
        let rows = `
          <div class="cart-summary-row">
            <span style="color:var(--text-dim);">ยอดรวมก่อนลด</span>
            <strong style="color:var(--text-dim);text-decoration:line-through;">${formatPrice(baseTotal)}</strong>
          </div>`;
        if (itemDiscount > 0) {
          rows += `
            <div class="cart-summary-row">
              <span style="color:var(--accent-2,#ec4899);">🏷️ ส่วนลดจากราคาปกติ</span>
              <strong style="color:var(--accent-2,#ec4899);">-${formatPrice(itemDiscount)}</strong>
            </div>`;
        }
        if (promoApplied && promoDiscount > 0) {
          rows += `
            <div class="cart-summary-row">
              <span style="color:var(--danger);">🎁 ${escapeHtml(promoApplied.name || 'โปรโมชั่น')}</span>
              <strong style="color:var(--danger);">-${formatPrice(promoDiscount)}</strong>
            </div>`;
        }
        discountRowsEl.innerHTML = rows;
      } else {
        discountRowsEl.innerHTML = "";
      }
    }
  }

  function openCart() {
    const backdrop = document.getElementById("cartBackdrop");
    if (!backdrop) return;
    renderCart();
    backdrop.classList.add("show");
    backdrop.setAttribute("aria-hidden", "false");
  }

  function closeCart() {
    const backdrop = document.getElementById("cartBackdrop");
    if (!backdrop) return;
    backdrop.classList.remove("show");
    backdrop.setAttribute("aria-hidden", "true");
  }

  function renderCheckoutSummary() {
    const el = document.getElementById("checkoutSummary");
    if (!el) return;
    // คำนวณ approximate ส่วนลด/โปรโมชั่นแบบ sync (ใช้ cache ที่โหลดไว้ใน app-user.js)
    // ค่าที่แสดงตรงนี้เป็น "โดยประมาณ" — ระบบจะคำนวณใหม่ทั้งหมดตอนกดยืนยันสั่งซื้อ
    const approxPricing = computeApproxPricingForDisplay();
    const promoApplied = approxPricing?.promotionApplied;
    const itemDiscount = approxPricing?.itemDiscountAmount || 0;
    const promoDiscount = approxPricing?.promoDiscountAmount || 0;
    const totalDiscount = itemDiscount + promoDiscount;
    const baseTotal = cartTotal();
    const finalTotal = approxPricing?.finalTotal ?? baseTotal;

    let rows = `
      <div class="cart-summary-row">
        <span style="color:var(--text-dim);">รายการ</span>
        <strong>${cartQuantity()} เพลง</strong>
      </div>`;

    if (totalDiscount > 0 && finalTotal < baseTotal) {
      rows += `
        <div class="cart-summary-row">
          <span style="color:var(--text-dim);">ยอดรวมก่อนลด</span>
          <strong style="color:var(--text-dim);text-decoration:line-through;">${formatPrice(baseTotal)}</strong>
        </div>`;
      if (itemDiscount > 0) {
        rows += `
          <div class="cart-summary-row">
            <span style="color:var(--accent-2,#ec4899);">🏷️ ส่วนลดจากราคาปกติ</span>
            <strong style="color:var(--accent-2,#ec4899);">-${formatPrice(itemDiscount)}</strong>
          </div>`;
      }
      if (promoApplied && promoDiscount > 0) {
        rows += `
          <div class="cart-summary-row">
            <span style="color:var(--danger);">🎁 ${escapeHtml(promoApplied.name || 'โปรโมชั่น')}</span>
            <strong style="color:var(--danger);">-${formatPrice(promoDiscount)}</strong>
          </div>`;
      }
      rows += `
        <div class="cart-summary-row">
          <span style="color:var(--text-dim);">ยอดชำระ</span>
          <strong style="color:var(--success);">${formatPrice(finalTotal)}</strong>
        </div>`;
    } else {
      rows += `
        <div class="cart-summary-row">
          <span style="color:var(--text-dim);">ยอดรวมโดยประมาณ</span>
          <strong style="color:var(--success);">${formatPrice(baseTotal)}</strong>
        </div>`;
    }
    rows += `
      <div style="font-size:11px;color:var(--text-dim);margin-top:8px;">
        ระบบจะตรวจสอบราคาและรายการล่าสุดจากฐานข้อมูลอีกครั้งก่อนสร้าง Order
      </div>`;
    el.innerHTML = rows;
  }

  // ===== เพิ่มใหม่: คำนวณ approximate ส่วนลด/โปรโมชั่นแบบ sync (อ่าน cache จาก pricing.js) =====
  // ใช้ state.cart (price ที่ snapshot ตอน addToCart) — ไม่ใช่ราคา db ล่าสุด
  // ดังนั้นยอดที่แสดงใน checkout summary อาจไม่ตรงกับยอดสุดท้าย 100% (ถ้า admin เพิ่งเปลี่ยนราคา/ส่วนลด)
  // แต่ระบบจะ re-resolve จาก db ตอนกดยืนยันสั่งซื้อ → ยอดที่เก็บใน order ถูกต้องเสมอ
  function computeApproxPricingForDisplay() {
    // ใช้ cart state ปัจจุบัน — แปลงเป็น cartItems format ที่ computeCartPricing ต้องการ
    try {
      const cartItems = state.cart.map(item => {
        if (item.kind === "playlist") {
          const plId = String(item.id).replace(/^playlist:/, "");
          return { kind: "playlist", playlist_id: plId, price: Number(item.price) || 0 };
        } else {
          return { kind: "song", song_id: String(item.id), price: Number(item.price) || 0 };
        }
      });
      // ไม่ส่ง discounts/promotions → computeCartPricing จะใช้ cache จาก pricing.js
      return computeCartPricing(cartItems);
    } catch (e) {
      console.warn("computeApproxPricingForDisplay error:", e);
      return null;
    }
  }

  // ---- เพิ่มใหม่: จำชื่อ+เบอร์โทร/WhatsApp ของลูกค้าไว้ในเครื่อง (localStorage) เพื่อเติมฟอร์มอัตโนมัติตอนสั่งซื้อครั้งถัดไป ----
  function saveCustomerInfo(customerName, whatsapp) {
    try {
      localStorage.setItem(CUSTOMER_INFO_STORAGE_KEY, JSON.stringify({ customerName, whatsapp }));
    } catch (_) {}
  }
  function loadCustomerInfo() {
    try {
      const raw = localStorage.getItem(CUSTOMER_INFO_STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }

  function openCheckout() {
    if (state.cart.length === 0) {
      showToast("ยังไม่มีเพลงในตะกร้า", "error");
      return;
    }
    renderCheckoutSummary();
    const feedback = document.getElementById("checkoutFeedback");
    if (feedback) feedback.textContent = "";
    // เพิ่มใหม่: ถ้าเคยสั่งซื้อมาก่อนและจำชื่อ/เบอร์ไว้ในเครื่องนี้ ให้เติมให้อัตโนมัติ (เฉพาะช่องที่ลูกค้ายังไม่ได้กรอกเอง)
    const savedInfo = loadCustomerInfo();
    if (savedInfo) {
      const nameInput = document.getElementById("checkoutCustomerName");
      const whatsappInput = document.getElementById("checkoutCustomerWhatsapp");
      if (nameInput && !nameInput.value.trim() && savedInfo.customerName) nameInput.value = savedInfo.customerName;
      if (whatsappInput && !whatsappInput.value.trim() && savedInfo.whatsapp) whatsappInput.value = savedInfo.whatsapp;
    }
    closeCart();
    const backdrop = document.getElementById("checkoutBackdrop");
    if (backdrop) {
      backdrop.classList.add("show");
      backdrop.setAttribute("aria-hidden", "false");
    }
  }

  function closeCheckout() {
    if (submitting) return;
    const backdrop = document.getElementById("checkoutBackdrop");
    if (!backdrop) return;
    backdrop.classList.remove("show");
    backdrop.setAttribute("aria-hidden", "true");
  }

  function setCheckoutFeedback(message, type = "error") {
    const el = document.getElementById("checkoutFeedback");
    if (!el) return;
    el.textContent = message;
    el.style.color = type === "success" ? "var(--success)" : "var(--danger)";
  }

  function getReceiptNumber(orderId, createdAt) {
    const date = new Date(createdAt || Date.now());
    const ymd = Number.isNaN(date.getTime())
      ? "00000000"
      : [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("");
    return `RCPT-${ymd}-${String(orderId || "000000").slice(-6).toUpperCase()}`;
  }

  function hashCheckoutKey(value) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  // 🔧 แก้บั๊ก (2026-09-18): normalize เบอร์ Laos ให้เป็นมาตรฐานเดียวก่อนเก็บลง DB / localStorage
  // -----------------------------------------------------------
  // ปัญหา: ลูกค้ากรอกเบอร์ได้หลายรูปแบบ เช่น "+85620XXXXXXXX" / "85620XXXXXXXX"
  //   / "020XXXXXXXX" / "20XXXXXXXX" → DB เก็บตามที่กรอก → track order ไม่เจอเพราะเทียบกันไม่ตรง
  //
  // วิธีแก้: normalize ทุกรูปแบบให้เป็น "20XXXXXXXX" ตั้งแต่ตอน checkout
  //   - strip country code Laos (+856 / 856) ออก
  //   - strip "0" นำหน้าออก
  //   ทำให้ DB เก็บเบอร์มาตรฐานเดียว → track order ตามเบอร์รูปแบบใดก็เจอ
  //
  // สอดคล้องกับ normalizePhoneServer ใน worker/index.js + normalizePhone ใน app-user.js
  //   ที่แก้ใน Bug C5 (ทำให้ query-time normalization กับ storage-time ตรงกัน)
  //
  // 🔧 (2026-09-22 v2 — รองรับทั้ง ลาว+ไทย): เก็บเบอร์ WITH country code ใน DB
  //   เดิม: เก็บ "20XXXXXXXX" (ไม่มี country code) → ลิงก์ WhatsApp ต้อง prepend 856 เอง
  //         → แต่เบอร์ไทย 812345678 → prepend 856 → กลายเป็น 856812345678 (ลาว) → พัง
  //   ใหม่: เก็บ "85620XXXXXXXX" หรือ "668XXXXXXXX" (WITH country code)
  //         → ลิงก์ WhatsApp ใช้ตรงๆ ไม่ต้อง prepend
  //         → รองรับทั้งลาว + ไทย
  //   ผลกระทบระบบเดิม: 0% — ถ้าเว็บยังไม่เปิด → ไม่มีออเดอร์เก่าใน DB → ไม่มีปัญหา
  //     ถ้ามีออเดอร์เก่า → ต้องรัน migration script เพิ่ม country code 856
  function normalizePhoneForStorage(v) {
    let s = String(v || "").replace(/[^0-9+]/g, "");
    s = s.replace(/^\+/, "");
    // ตรวจ country code ก่อน
    if (s.startsWith("856")) {
      let rest = s.slice(3).replace(/^0+/, "");
      return "856" + rest;
    }
    if (s.startsWith("66")) {
      let rest = s.slice(2).replace(/^0+/, "");
      return "66" + rest;
    }
    // ไม่มี country code → ตรวจรูปแบบเบอร์เพื่อแยกลาว vs ไทย
    // 🔧 (2026-09-22 fix Bug #1): เดิมสันนิษฐานลาวเสมอ → เบอร์ไทย 0812345678 → 856812345678 (ผิด!)
    //   วิธีแก้: ตรวจเบอร์หลัง strip 0 นำหน้า:
    //     - ขึ้นต้นด้วย 2 → ลาว (20XXXXXXXX) → เติม 856
    //     - ขึ้นต้นด้วย 8 หรือ 9 และมี 9 หลัก → ไทย (8XXXXXXXX) → เติม 66
    //     - อื่นๆ → สันนิษฐานลาว (default)
    let rest = s.replace(/^0+/, "");
    if (rest.length === 9 && (rest.startsWith("8") || rest.startsWith("9"))) {
      // ไทย: 8XXXXXXXX หรือ 9XXXXXXXX (9 หลัก) → เติม 66
      return "66" + rest;
    }
    // ลาวหรือไม่แน่ใจ → เติม 856 (default)
    return "856" + rest;
  }

  // 🔧 (2026-09-22 fix Bug #2 v2): ฟังก์ชัน validate เบอร์ รองรับทั้ง ลาว+ไทย
  //   ปัญหาเดิม: ลูกค้าใส่ "abc" ผ่าน checkout → track order ไม่เจอ
  //   วิธีแก้: ใช้ regex แยกสำหรับลาว + ไทย ถ้าตรงอันใดอันหนึ่ง → ผ่าน
  //   รูปแบบที่รองรับ:
  //     ลาว:
  //       - 20XXXXXXXX (8-10 หลัก)
  //       - 020XXXXXXXX (local มี 0)
  //       - +85620XXXXXXXX / 85620XXXXXXXX (international)
  //     ไทย:
  //       - 8XXXXXXXX / 9XXXXXXXX (9 หลัก ไม่มี 0)
  //       - 08XXXXXXXX / 09XXXXXXXX (local มี 0, 10 หลัก)
  //       - +668XXXXXXXX / +669XXXXXXXX / 668XXXXXXXX / 669XXXXXXXX (international)
  function isValidPhone(raw) {
    const s = String(raw || "").trim().replace(/[\s\-()]/g, "");
    // Laos: optional +856/856 + optional 0 + [2-9] + 7-9 digits
    const laosRe = /^(\+?856)?0?[2-9]\d{7,9}$/;
    // Thai: optional +66/66 + optional 0 + [6-9] + 8 digits
    const thaiRe = /^(\+?66)?0?[6-9]\d{8}$/;
    return laosRe.test(s) || thaiRe.test(s);
  }

  function getPhoneValidationError(raw) {
    const s = String(raw || "").trim();
    if (!s) return "กรุณากรอกเบอร์ WhatsApp";
    if (!isValidPhone(s)) {
      return "รูปแบบเบอร์ไม่ถูกต้อง — ตัวอย่างที่ใช้ได้:\n" +
             "• ลาว: 02012345678, 2012345678, +8562012345678\n" +
             "• ไทย: 0812345678, 812345678, +66812345678";
    }
    return null;
  }

  function getCheckoutKey(customerName, whatsapp) {
    return hashCheckoutKey(JSON.stringify({
      customerName,
      whatsapp,
      items: state.cart.map(item => ({ id: item.id, kind: item.kind }))
    }));
  }

  function getStoredOrderId(checkoutKey) {
    try {
      const stored = JSON.parse(sessionStorage.getItem(CHECKOUT_ORDER_KEY) || "null");
      return stored?.key === checkoutKey && stored.id ? String(stored.id) : null;
    } catch (_) {
      return null;
    }
  }

  function storeOrderId(checkoutKey, orderId) {
    try {
      sessionStorage.setItem(CHECKOUT_ORDER_KEY, JSON.stringify({ key: checkoutKey, id: orderId }));
    } catch (_) {}
  }

  function clearStoredOrderId() {
    try { sessionStorage.removeItem(CHECKOUT_ORDER_KEY); } catch (_) {}
  }

  /*
   * ตรวจสอบรายการในตะกร้า + คำนวณราคาจากฐานข้อมูลจริง (ไม่เชื่อราคาที่ cache ไว้ในตะกร้า)
   *
   * หมายเหตุ (แก้บั๊ก 2026-09-05): เดิมฟังก์ชันนี้อ่านข้อมูลผ่าน Firestore Transaction
   * (transaction.get) เพื่อให้อ่าน+เขียน Order อยู่ในธุรกรรมเดียวกัน แต่พบว่า Firestore Web SDK
   * ในบางเบราว์เซอร์/เครือข่าย (โดยเฉพาะ Safari/iPad) โยน TypeError ภายใน SDK เอง
   * ("undefined is not an object (evaluating 'i.path')") เวลาปิด transaction ที่มีทั้ง
   * document read และ query read ปนกัน — จึงเปลี่ยนมาใช้การอ่านแบบธรรมดา (getDoc/getDocs)
   * แทน แล้วค่อยเขียน Order ด้วย setDoc() อีกที (ไม่ใช้ transaction) ผลลัพธ์/ราคาที่คำนวณ
   * ยังคงเหมือนเดิมทุกประการ เพียงแต่ไม่การันตี atomicity ระดับ Firestore transaction
   * (ซึ่งยอมรับได้ เพราะทุก Order ที่สร้างมีสถานะ "รอตรวจสอบการโอน" ให้แอดมินเช็คมืออยู่แล้ว)
   *
   * รองรับ 3 รูปแบบของตะกร้า:
   *  1) มีแต่เพลงเดี่ยว                      -> order_type "single"   (พฤติกรรมเดิมทุกประการ)
   *  2) มีเพลย์ลิสต์เดียว ไม่มีเพลงเดี่ยวปน     -> order_type "playlist" (พฤติกรรมเดิมทุกประการ)
   *  3) เพลงเดี่ยว+เพลย์ลิสต์ผสมกัน หรือมีเพลย์ลิสต์มากกว่า 1 รายการ -> order_type "mixed" (ใหม่)
   *     กรณีนี้ 1 รายการในตะกร้า = 1 Order Item เสมอ (เพลย์ลิสต์ไม่ถูกขยายเป็นหลายเพลง)
   *     เช่น เพลง 3 เพลง + เพลย์ลิสต์ 2 รายการ -> items.length === 5
   */
  async function resolveCartFromDatabase() {
    const songEntries = state.cart.filter(item => item.kind !== "playlist");
    const playlistEntries = state.cart.filter(item => item.kind === "playlist");
    const playlistIds = playlistEntries.map(item => String(item.id).replace(/^playlist:/, ""));

    // ---- เพิ่มใหม่ (แก้บั๊ก 2026-09-09): อ่านข้อมูลทุกอย่างพร้อมกันด้วย Promise.all แทนการวน await ทีละรายการ ----
    // เดิมใช้ for...of + await วนอ่านทีละเพลง/ทีละเพลย์ลิสต์เรียงกันไป ทำให้ตะกร้าที่มีหลายรายการ
    // ยิ่งมีรายการเยอะยิ่งรอนาน (เวลารวม = ผลรวมของทุก request) โดยเฉพาะเน็ตช้า/มือถือ
    // เปลี่ยนมายิง request ทั้งหมดพร้อมกันแทน (เวลารวม = request ที่ช้าที่สุดตัวเดียว) ผลลัพธ์/การตรวจสอบ
    // ราคาและสถานะเพลงยังคงเหมือนเดิมทุกประการ เพียงแค่เปลี่ยนวิธีอ่านข้อมูลให้เร็วขึ้น
    const [songSnaps, playlistSnaps, playlistSongsSnaps, settingsSnap] = await Promise.all([
      Promise.all(songEntries.map(cartItem => getDoc(doc(db, "songs", String(cartItem.id))))),
      Promise.all(playlistIds.map(playlistId => getDoc(doc(db, "playlists", playlistId)))),
      Promise.all(playlistIds.map(playlistId => getDocs(query(collection(db, "songs"), where("playlist_id", "==", playlistId))))),
      getDoc(doc(db, "settings", "main"))
    ]);

    // ---- ตรวจสอบ/ดึงราคาล่าสุดของเพลงเดี่ยวที่เพิ่มเองในตะกร้า ----
    const singleSongItems = songEntries.map((cartItem, index) => {
      const songSnap = songSnaps[index];
      if (!songSnap.exists()) throw new Error(`ไม่พบเพลง "${cartItem.song_name}" ในฐานข้อมูล`);
      const song = songSnap.data();
      if (song.status === "hidden") throw new Error(`เพลง "${song.song_name || cartItem.song_name}" ปิดการขายแล้ว`);
      const price = Number(song.price);
      if (!Number.isFinite(price) || price < 0) throw new Error(`ราคาเพลง "${song.song_name || cartItem.song_name}" ไม่ถูกต้อง`);
      return {
        song_id: songSnap.id,
        title: String(song.song_name || cartItem.song_name || "เพลง"),
        price,
        quantity: 1
      };
    });

    // ---- ตรวจสอบ/ดึงราคาล่าสุดของเพลย์ลิสต์แต่ละรายการในตะกร้า ----
    const playlistResolutions = playlistEntries.map((cartItem, index) => {
      const playlistSnap = playlistSnaps[index];
      if (!playlistSnap.exists()) throw new Error(`ไม่พบเพลย์ลิสต์ "${cartItem.song_name}" ในฐานข้อมูล`);
      const playlist = { id: playlistSnap.id, ...playlistSnap.data() };
      const playlistPrice = Number(playlist.price);
      if (!Number.isFinite(playlistPrice) || playlistPrice <= 0) {
        throw new Error(`เพลย์ลิสต์ "${playlist.playlist_name || cartItem.song_name}" ยังไม่มีราคาขาย`);
      }

      const activeSongs = [];
      playlistSongsSnaps[index].docs.forEach(songDoc => {
        const song = songDoc.data();
        if (song.status === "hidden") return;
        activeSongs.push({
          song_id: songDoc.id,
          title: String(song.song_name || "เพลง"),
          price: Number.isFinite(Number(song.price)) ? Number(song.price) : 0
        });
      });
      if (activeSongs.length === 0) {
        throw new Error(`เพลย์ลิสต์ "${playlist.playlist_name || cartItem.song_name}" ยังไม่มีเพลงที่เปิดขาย`);
      }
      return { playlist, songs: activeSongs };
    });


    const settings = settingsSnap.exists() ? settingsSnap.data() : {};

    // ===== ลดราคา + โปรโมชั่น (ระบบใหม่) — โหลด active discounts/promotions พร้อมกัน =====
    // ใช้ cache ที่โหลดไว้แล้วใน app-user.js init() — ถ้าไม่มี cache จะโหลดใหม่
    // forceRefresh = true เพื่อให้ checkout ได้ข้อมูลล่าสุดเสมอ (กัน admin เพิ่งเปลี่ยนส่วนลดตอนลูกค้ากำลัง checkout)
    let activeDiscounts = [];
    let activePromotions = [];
    try {
      [activeDiscounts, activePromotions] = await Promise.all([
        fetchActiveDiscounts(true),
        fetchActivePromotions(true)
      ]);
    } catch (e) {
      console.warn("โหลด discounts/promotions ไม่สำเร็จ — คำนวณราคาปกติ", e);
    }

    // ===== กรณีเดิม (1): มีเพลย์ลิสต์เดียวล้วนๆ ไม่มีเพลงเดี่ยวปน — คงพฤติกรรมเดิมทุกประการ =====
    if (playlistResolutions.length === 1 && singleSongItems.length === 0) {
      const { playlist, songs } = playlistResolutions[0];
      // คำนวณ discount + promotion (ถ้ามี)
      const cartItems = [{ kind: "playlist", playlist_id: playlist.id, price: Number(playlist.price) }];
      const pricing = computeCartPricing(cartItems, activeDiscounts, activePromotions);
      return {
        items: songs.map(s => ({ song_id: s.song_id, title: s.title, price: s.price, quantity: 1 })),
        total: pricing.finalTotal,  // ← ยอดสุดท้าย (เก็บใน order.total เหมือนเดิม)
        subtotal: pricing.subtotal,
        discountSubtotal: pricing.discountSubtotal,
        discountAmount: pricing.discountAmount,
        promotionApplied: pricing.promotionApplied,
        finalTotal: pricing.finalTotal,
        orderType: "playlist",
        playlist,
        playlistIds: [playlist.id],
        settings
      };
    }

    // ===== กรณีเดิม (2): มีแต่เพลงเดี่ยว ไม่มีเพลย์ลิสต์เลย — คงพฤติกรรมเดิมทุกประการ =====
    if (playlistResolutions.length === 0) {
      const baseTotal = singleSongItems.reduce((sum, item) => sum + item.price, 0);
      if (!Number.isFinite(baseTotal) || baseTotal < 0) throw new Error("คำนวณยอดรวมจากฐานข้อมูลไม่สำเร็จ");
      // คำนวณ discount + promotion โดยใช้ category_id ของแต่ละเพลง (สำหรับ promotion หมวดหมู่)
      const cartItems = singleSongItems.map(item => {
        const songSnap = songSnaps.find((s, idx) => songEntries[idx] && songEntries[idx].id === item.song_id);
        const songData = songSnap?.data() || {};
        return {
          kind: "song",
          song_id: item.song_id,
          price: item.price,
          category_id: songData.category_id || songData.categoryId || null
        };
      });
      const pricing = computeCartPricing(cartItems, activeDiscounts, activePromotions);
      return {
        items: singleSongItems,
        total: pricing.finalTotal,
        subtotal: pricing.subtotal,
        discountSubtotal: pricing.discountSubtotal,
        discountAmount: pricing.discountAmount,
        promotionApplied: pricing.promotionApplied,
        finalTotal: pricing.finalTotal,
        orderType: "single",
        playlist: null,
        playlistIds: [],
        settings
      };
    }

    // ===== กรณีใหม่ (3): เพลย์ลิสต์หลายรายการ และ/หรือ เพลงเดี่ยวปนกับเพลย์ลิสต์ =====
    const playlistLineItems = playlistResolutions.map(({ playlist, songs }) => ({
      kind: "playlist",
      playlist_id: playlist.id,
      title: String(playlist.playlist_name || playlist.name || "เพลย์ลิสต์"),
      price: Number(playlist.price),
      quantity: 1,
      song_ids: songs.map(s => s.song_id), // เก็บ snapshot ไอดีเพลงในเพลย์ลิสต์ไว้ ใช้อ้างอิงฝั่ง Admin (ไม่กระทบระบบเดิม)
      song_titles: songs.map(s => s.title) // เก็บ snapshot ชื่อเพลงคู่กัน ใช้แสดงในใบเสร็จ/ข้อความ WhatsApp เท่านั้น ไม่ใช้คิดราคา
    }));
    const songLineItems = singleSongItems.map((item, idx) => {
      const songSnap = songSnaps[idx];
      const songData = songSnap?.data() || {};
      return {
        kind: "song",
        song_id: item.song_id,
        title: item.title,
        price: item.price,
        quantity: 1,
        category_id: songData.category_id || songData.categoryId || null
      };
    });
    const items = [...songLineItems, ...playlistLineItems];
    const baseTotal = items.reduce((sum, item) => sum + item.price, 0);
    if (!Number.isFinite(baseTotal) || baseTotal < 0) throw new Error("คำนวณยอดรวมจากฐานข้อมูลไม่สำเร็จ");

    // คำนวณ discount + promotion (กรณี mixed)
    const cartItems = items.map(item => ({
      kind: item.kind,
      song_id: item.song_id,
      playlist_id: item.playlist_id,
      price: item.price,
      category_id: item.category_id || null
    }));
    const pricing = computeCartPricing(cartItems, activeDiscounts, activePromotions);

    return {
      items,
      total: pricing.finalTotal,
      subtotal: pricing.subtotal,
      discountSubtotal: pricing.discountSubtotal,
      discountAmount: pricing.discountAmount,
      promotionApplied: pricing.promotionApplied,
      finalTotal: pricing.finalTotal,
      orderType: "mixed",
      playlist: null,
      playlistIds: playlistResolutions.map(r => r.playlist.id),
      settings
    };
  }

  function buildAdminWhatsAppText(order, receiptNumber, storeName) {
    // เพลย์ลิสต์ (ทั้งกรณีสั่งซื้อยกเพลย์ลิสต์ล้วนๆ และกรณีผสมกับเพลงเดี่ยว) แสดงรายชื่อเพลงข้างในไว้ให้
    // ลูกค้าตรวจสอบเท่านั้น — ราคาที่คิดเงินยังคงเป็นราคาเหมาเพลย์ลิสต์ ไม่บวกราคาเพลงย่อยซ้ำ
    const lines = order.order_type === "playlist"
      ? [
          `1. เพลย์ลิสต์: ${order.playlist_name || "ไม่ระบุชื่อ"} — ${formatPrice(order.total)}`,
          ...(order.items || []).map(item => `   • ${item.title}`)
        ]
      : order.items.flatMap((item, index) => {
          if (item.kind === "playlist") {
            const nested = (item.song_titles || []).map(title => `   • ${title}`);
            return [`${index + 1}. 🎶 เพลย์ลิสต์: ${item.title} — ${formatPrice(item.price)}`, ...nested];
          }
          return [`${index + 1}. ${item.title} — ${formatPrice(item.price)}`];
        });
    return [
      `สวัสดีครับ มี Order ใหม่จาก ${storeName || "Music Store"}`,
      "",
      `🧾 Order: ${receiptNumber}`,
      `👤 ลูกค้า: ${order.customer_name}`,
      `📱 WhatsApp ลูกค้า: ${order.whatsapp}`,
      "",
      "🛒 รายการสั่งซื้อ",
      ...lines,
      "",
      `🎵 จำนวนทั้งหมด: ${order.items.length} ${
        order.order_type === "playlist" ? "เพลงในเพลย์ลิสต์"
        : order.order_type === "mixed" ? "รายการ (เพลง/เพลย์ลิสต์)"
        : "เพลง"
      }`,
      `💰 ราคารวม: ${formatPrice(order.total)}`,
      "",
      "สถานะ: รอตรวจสอบการโอน"
    ].join("\n");
  }

  // ===== เพิ่มใหม่: ใบเสร็จหลังสั่งซื้อสำเร็จ (ฝั่งลูกค้า) — โครงหน้าเดียวกับใบเสร็จฝั่งแอดมิน =====
  // ปุ่ม WhatsApp บนใบเสร็จนี้ถูกปรับให้เป็น "ติดต่อแอดมินเพื่อชำระเงิน" (ไม่ใช่ส่งใบเสร็จหาเบอร์ลูกค้าแบบฝั่งแอดมิน)
  // และสร้างข้อความอัตโนมัติด้วย buildAdminWhatsAppText เดิมที่มีอยู่แล้วด้านบน (ใช้ซ้ำ ไม่สร้างข้อความใหม่)
  // ===== เพิ่มใหม่: จำออเดอร์ล่าสุด + แถบเตือน "ยังไม่ได้แจ้งแอดมิน" =====
  let receiptContacted = false; // สถานะของใบเสร็จที่กำลังเปิดอยู่ ณ ขณะนี้ — ใช้เช็คก่อนปิด

  function saveLastOrderRecord(order, receiptNumber) {
    try {
      localStorage.setItem(LAST_ORDER_STORAGE_KEY, JSON.stringify({ order, receiptNumber, contacted: false }));
      // 🔧 (2026-09-22 Batch 7 fix Bug #4): ใช้ localStorage.removeItem แทน sessionStorage.removeItem
      //   เพราะ BANNER_DISMISS_KEY ย้ายไป localStorage แล้ว → ต้องลบจาก localStorage ด้วย
      localStorage.removeItem(BANNER_DISMISS_KEY);
    } catch (_) {}
  }

  function getLastOrderRecord() {
    try {
      const raw = localStorage.getItem(LAST_ORDER_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      if (!parsed || !parsed.order || !parsed.receiptNumber) return null;
      return parsed;
    } catch (_) {
      return null;
    }
  }

  function markLastOrderContacted() {
    const record = getLastOrderRecord();
    if (!record) return;
    try {
      localStorage.setItem(LAST_ORDER_STORAGE_KEY, JSON.stringify({ ...record, contacted: true }));
    } catch (_) {}
    receiptContacted = true;
    renderPendingOrderBanner();
  }

  function renderPendingOrderBanner() {
    const banner = document.getElementById("pendingOrderBanner");
    if (!banner) return;
    const record = getLastOrderRecord();
    // 🔧 (2026-09-22 Batch 7 fix Bug #4): ใช้ localStorage + 24h TTL แทน sessionStorage
    //   เดิม: sessionStorage → หายตอนปิด tab → ลูกค้าเปิด tab ค้างไว้ → banner หายตลอดวัน
    //   ใหม่: localStorage เก็บ timestamp หมดอายุ → ครบ 24h แสดง banner อีกครั้ง
    //   ผลกระทบระบบเดิม: 0% — ถ้าไม่ dismiss → banner แสดงเหมือนเดิม
    const DISMISS_TTL_MS = 24 * 60 * 60 * 1000; // 24 ชั่วโมง
    let dismissed = false;
    try {
      const dismissedUntil = Number(localStorage.getItem(BANNER_DISMISS_KEY) || "0");
      dismissed = dismissedUntil > Date.now();
      if (!dismissed) {
        // หมดอายุแล้ว → ลบค่าเก่าออกจาก localStorage (keep clean)
        localStorage.removeItem(BANNER_DISMISS_KEY);
      }
    } catch (_) {}
    const shouldShow = !!record && !record.contacted && !dismissed;
    banner.hidden = !shouldShow;
  }

  function attemptCloseReceipt() {
    if (!receiptContacted) {
      const confirmed = window.confirm("คุณยังไม่ได้กดแจ้งแอดมินเพื่อชำระเงิน หากปิดตอนนี้ แอดมินจะยังไม่เห็นออเดอร์ของคุณ ต้องการปิดหรือไม่?");
      if (!confirmed) return;
    }
    closeReceipt();
    renderPendingOrderBanner();
  }

  function closeReceipt() {
    const backdrop = document.getElementById("receiptBackdrop");
    if (!backdrop) return;
    backdrop.classList.remove("show");
    backdrop.setAttribute("aria-hidden", "true");
  }

  function buildReceiptItemRows(order) {
    const items = order.items || [];
    if (order.order_type === "playlist") {
      const playlistName = order.playlist_name || "เพลย์ลิสต์";
      const songLines = items.map(item => `
        <div class="receipt-line" style="border-bottom:none;padding:4px 0 4px 14px;">
          <small>• ${escapeHtml(item.title || "เพลง")}</small>
        </div>
      `).join("");
      return `
        <div class="receipt-line" style="flex-direction:column;align-items:stretch;gap:2px;">
          <div style="display:flex;justify-content:space-between;">
            <strong>🎶 ${escapeHtml(playlistName)}</strong>
            <strong>${formatPrice(order.total)}</strong>
          </div>
          <small style="color:#666;">ยกเพลย์ลิสต์ · ${items.length} เพลง</small>
        </div>
        ${songLines}
      `;
    }

    return items.map(item => {
      if (item.kind !== "playlist") {
        return `
          <div class="receipt-line">
            <div><strong>${escapeHtml(item.title || "เพลง")}</strong></div>
            <strong>${formatPrice(item.price)}</strong>
          </div>
        `;
      }
      // เพลย์ลิสต์ในออเดอร์ผสม — ใช้ song_titles ที่ snapshot ไว้ตอนสั่งซื้อ (resolveCartFromDatabase) โดยตรง ไม่ query ซ้ำ
      const songTitles = Array.isArray(item.song_titles) ? item.song_titles : [];
      const songLines = songTitles.map(name => `
        <div class="receipt-line" style="border-bottom:none;padding:4px 0 4px 14px;">
          <small>• ${escapeHtml(name)}</small>
        </div>
      `).join("");
      return `
        <div class="receipt-line" style="flex-direction:column;align-items:stretch;gap:2px;">
          <div style="display:flex;justify-content:space-between;">
            <strong>🎶 ${escapeHtml(item.title || "เพลย์ลิสต์")}</strong>
            <strong>${formatPrice(item.price)}</strong>
          </div>
          <small style="color:#666;">ยกเพลย์ลิสต์ · ${songTitles.length} เพลง</small>
        </div>
        ${songLines}
      `;
    }).join("");
  }

  // แคปเฉพาะส่วนใบเสร็จสีขาว (.receipt-paper) เป็นรูป — โค้ดเดียวกับฝั่งแอดมิน (captureReceiptCanvas/downloadReceiptAsImage ใน orders.js)
  // 🔧 (2026-09-22 Batch 7 fix Bug #1): ใช้ window.html2canvas (จาก script tag ใน HTML) ก่อน
  //   ถ้าโหลดจาก script tag ไม่สำเร็จ → fallback ไป dynamic import (เดิม)
  //   วิธีทำ: สร้าง helper function getHtml2Canvas() ที่ cache module → เรียกครั้งแรก fetch จาก CDN, ครั้งถัดไปใช้ cache
  let _html2canvasCache = null;
  async function getHtml2Canvas() {
    // ลองใช้ window.html2canvas ก่อน (จาก script tag)
    if (typeof window !== "undefined" && window.html2canvas) {
      return window.html2canvas;
    }
    // Fallback: dynamic import (เดิม)
    if (!_html2canvasCache) {
      _html2canvasCache = await import("https://esm.sh/html2canvas@1.4.1");
    }
    return _html2canvasCache.default || _html2canvasCache;
  }

  async function captureReceiptCanvas() {
    const target = document.querySelector("#receiptContent .receipt-paper");
    if (!target) return null;
    const html2canvas = await getHtml2Canvas();
    return html2canvas(target, { backgroundColor: "#ffffff", scale: 2, useCORS: true });
  }

  async function downloadReceiptAsImage(receiptNumber) {
    try {
      const canvas = await captureReceiptCanvas();
      if (!canvas) { showToast("ไม่พบใบเสร็จให้บันทึก", "error"); return; }
      const dataUrl = canvas.toDataURL("image/png");
      const link = document.createElement("a");
      link.href = dataUrl;
      link.download = `receipt-${receiptNumber || "order"}.png`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      showToast("บันทึกรูปใบเสร็จสำเร็จ", "success");
    } catch (err) {
      showToast("บันทึกรูปใบเสร็จไม่สำเร็จ: " + err.message, "error");
    }
  }

  // ===== เพิ่มใหม่: สร้างแถวส่วนลด/โปรโมชั่นสำหรับใบเสร็จ =====
  // อ่านจาก order.subtotal, order.discount_amount, order.promotion_applied (snapshot ตอนสั่ง)
  // ถ้า order เก่าไม่มี field เหล่านี้ → ไม่แสดงแถวพิเศษ (back-compat)
  function buildReceiptDiscountRows(order) {
    const subtotal = order.subtotal;
    const discountAmount = order.discount_amount;
    const promotionApplied = order.promotion_applied;
    const finalTotal = order.final_total ?? order.total;
    // ถ้าไม่มีข้อมูลส่วนลดเลย → ไม่แสดงแถวพิเศษ (order เก่าก่อน deploy ระบบใหม่)
    if (subtotal == null && discountAmount == null && !promotionApplied) return "";
    // ถ้าส่วนลดเป็น 0 และไม่มี promotion → ไม่แสดง
    const hasDiscount = (discountAmount && discountAmount > 0) || (promotionApplied && promotionApplied.discount_amount > 0);
    if (!hasDiscount) return "";

    let rows = "";
    if (subtotal != null && subtotal !== finalTotal) {
      rows += `<div class="receipt-line receipt-discount-row"><span>ยอดรวมก่อนลด</span><span>${formatPrice(subtotal)}</span></div>`;
    }
    if (promotionApplied && promotionApplied.name) {
      const promoAmount = promotionApplied.discount_amount || 0;
      if (promoAmount > 0) {
        rows += `<div class="receipt-line receipt-promo-row"><span>🎁 โปรโมชั่น: ${escapeHtml(promotionApplied.name)}</span><span>-${formatPrice(promoAmount)}</span></div>`;
      }
    }
    if (discountAmount && discountAmount > 0) {
      // ถ้า promotionApplied มี discount_amount แล้ว → discountAmount รวม item-level + promo
      // ถ้ามี promotionApplied อยู่ → แสดงเฉพาะส่วนต่างของ item-level (ถ้ามี)
      const promoAmount = promotionApplied?.discount_amount || 0;
      const itemDiscount = discountAmount - promoAmount;
      if (itemDiscount > 0) {
        rows += `<div class="receipt-line receipt-discount-row"><span>ส่วนลดจากราคาปกติ</span><span>-${formatPrice(itemDiscount)}</span></div>`;
      }
    }
    return rows;
  }

  function showReceipt(order, receiptNumber, adminWhatsappNumber, alreadyContacted) {
    receiptContacted = !!alreadyContacted;
    const date = order.created_at ? new Date(order.created_at) : new Date();
    const dateText = Number.isNaN(date.getTime())
      ? "-"
      : date.toLocaleString("th-TH", { dateStyle: "medium", timeStyle: "short" });

    const content = document.getElementById("receiptContent");
    if (!content) return;
    content.innerHTML = `
      <div class="receipt-paper">
        <div class="receipt-head">
          <h2>${escapeHtml(order.store_name || "Music Store")}</h2>
          <div>ใบเสร็จรับเงิน</div>
          <small>เลขที่ ${escapeHtml(receiptNumber)}</small>
          <small>${escapeHtml(dateText)}</small>
        </div>
        <div class="receipt-customer">
          <div><span>ลูกค้า</span><strong>${escapeHtml(order.customer_name)}</strong></div>
          <div><span>WhatsApp</span><strong>${escapeHtml(order.whatsapp)}</strong></div>
        </div>
        <div class="receipt-items">${buildReceiptItemRows(order) || '<div class="receipt-empty">ไม่มีรายการสินค้า</div>'}</div>
        ${buildReceiptDiscountRows(order)}
        <div class="receipt-total"><span>รวมทั้งสิ้น</span><strong>${formatPrice(order.final_total ?? order.total)}</strong></div>
        <div class="receipt-thanks">ขอบคุณที่ใช้บริการ</div>
      </div>
    `;

    const backdrop = document.getElementById("receiptBackdrop");
    if (backdrop) {
      backdrop.classList.add("show");
      backdrop.setAttribute("aria-hidden", "false");
    }

    const waBtn = document.getElementById("receiptWhatsAppBtn");
    if (waBtn) {
      waBtn.onclick = () => {
        const number = String(adminWhatsappNumber || state.settings?.whatsapp_number || "").replace(/[^0-9]/g, "");
        if (!number) { showToast("ร้านยังไม่ได้ตั้งค่าเบอร์ WhatsApp", "error"); return; }
        const text = buildAdminWhatsAppText(order, receiptNumber, order.store_name);
        window.open(buildWhatsAppLink(number, text), "_blank", "noopener");
        markLastOrderContacted();
      };
    }
    const downloadBtn = document.getElementById("receiptDownloadImgBtn");
    if (downloadBtn) downloadBtn.onclick = () => downloadReceiptAsImage(receiptNumber);

    // 📸 (added STEP 2): ปุ่ม "💳 ชำระเงิน" — เปิด payment modal แสดง QR/บัญชี
    const payBtn = document.getElementById("receiptPayBtn");
    if (payBtn) payBtn.onclick = () => openPaymentModal(order, receiptNumber);

    renderPendingOrderBanner();
  }

  // ================= 📸 PAYMENT FLOW (added STEP 2-6 — additive, no existing function touched) =================
  //   Endpoints (เห็นใน worker/index.js — เพิ่มใหม่ทั้งหมด ไม่แตะของเดิม):
  //     POST /api/orders/:id/payment-proof — ลูกค้าอัปโหลดสลิป (anonymous + ownership verify)
  //
  //   UI:
  //     #paymentBackdrop      — modal แสดง QR/บัญชี + ปุ่ม "อัปโหลดสลิป" + ปุ่ม "คัดลอกเลขบัญชี"
  //     #uploadSlipBackdrop   — modal เลือกไฟล์ + preview + ยืนยัน
  //
  //   Settings ที่ใช้ (จาก settings/main doc):
  //     bank_name, bank_account, bank_account_name, qr_code_url, payment_instructions
  //
  //   WhatsApp: ใช้ buildWhatsAppLink() ของเดิม — เป็น wa.me deep link (notification only)
  //            ระบบหลัก: R2 + D1 — ถ้า WhatsApp เปิดไม่ได้ slip ยังอยู่ในระบบ

  let __currentPaymentOrder = null; // snapshot ของ order ที่กำลังชำระ — ใช้ตอน upload slip

  async function openPaymentModal(order, receiptNumber) {
    __currentPaymentOrder = { order, receiptNumber };
    const backdrop = document.getElementById("paymentBackdrop");
    const content = document.getElementById("paymentContent");
    if (!backdrop || !content) return;
    content.innerHTML = `<div style="text-align:center;color:var(--text-dim);padding:30px 0;">กำลังโหลด...</div>`;
    backdrop.classList.add("show");
    backdrop.setAttribute("aria-hidden", "false");

    // fetch settings
    let settings = {};
    try {
      const snap = await getDoc(doc(db, "settings", "main"));
      settings = snap.exists() ? snap.data() : {};
    } catch (err) {
      content.innerHTML = `<div style="text-align:center;color:var(--danger);padding:30px 0;">โหลดข้อมูลไม่สำเร็จ: ${escapeHtml(err.message || String(err))}</div>`;
      return;
    }

    const amount = order?.final_total ?? order?.total ?? 0;
    const hasBankInfo = settings.bank_name || settings.bank_account || settings.bank_account_name;
    const hasQr = !!settings.qr_code_url;

    if (!hasBankInfo && !hasQr) {
      content.innerHTML = `
        <div style="padding:24px 8px;text-align:center;color:var(--text-dim);">
          <div style="font-size:48px;margin-bottom:8px;">🏦</div>
          <div style="font-weight:800;color:var(--text);margin-bottom:6px;">ร้านยังไม่ได้ตั้งค่าข้อมูลการชำระเงิน</div>
          <div style="font-size:13px;">กรุณาติดต่อแอดมินผ่าน WhatsApp เพื่อสอบถามวิธีโอน</div>
          <button class="btn" id="paymentContactAdminBtn" style="margin-top:14px;width:100%;">💬 ติดต่อแอดมิน</button>
        </div>
      `;
      const contactBtn = document.getElementById("paymentContactAdminBtn");
      if (contactBtn) contactBtn.onclick = () => {
        const num = String(settings.whatsapp_number || "").replace(/[^0-9]/g, "");
        if (!num) { showToast("ร้านยังไม่ได้ตั้งค่าเบอร์ WhatsApp", "error"); return; }
        const text = `สวัสดีครับ/ค่ะ สั่งซื้อ ${escapeHtml(receiptNumber)} แต่ยังไม่เห็นข้อมูลบัญชีโอน รบกวนส่ง QR ด้วยครับ/ค่ะ`;
        window.open(buildWhatsAppLink(num, text), "_blank", "noopener");
      };
      return;
    }

    content.innerHTML = `
      <div style="padding:14px 8px 6px;">
        <div style="text-align:center;margin-bottom:14px;">
          <div style="color:var(--text-dim);font-size:13px;">ยอดที่ต้องชำระ</div>
          <div style="font-size:28px;font-weight:800;color:var(--success);">${formatPrice(amount)}</div>
          <div style="font-size:12px;color:var(--text-dim);margin-top:4px;">เลขที่ ${escapeHtml(receiptNumber)}</div>
        </div>
        ${settings.bank_name ? `<div style="display:flex;justify-content:space-between;padding:8px 0;border-top:1px solid var(--border, #eee);">
          <span style="color:var(--text-dim);">🏦 ธนาคาร</span><strong>${escapeHtml(settings.bank_name)}</strong>
        </div>` : ""}
        ${settings.bank_account_name ? `<div style="display:flex;justify-content:space-between;padding:8px 0;border-top:1px solid var(--border, #eee);">
          <span style="color:var(--text-dim);">👤 ชื่อบัญชี</span><strong>${escapeHtml(settings.bank_account_name)}</strong>
        </div>` : ""}
        ${settings.bank_account ? `<div style="display:flex;justify-content:space-between;padding:8px 0;border-top:1px solid var(--border, #eee);align-items:center;">
          <span style="color:var(--text-dim);">🔢 เลขบัญชี</span>
          <div style="display:flex;align-items:center;gap:6px;">
            <strong id="paymentBankAccountText">${escapeHtml(settings.bank_account)}</strong>
            <button class="btn secondary" id="paymentCopyBtn" type="button" style="padding:4px 10px;font-size:12px;min-width:auto;">📋 คัดลอก</button>
          </div>
        </div>` : ""}
        ${hasQr ? `<div style="text-align:center;margin:16px 0;padding:12px;border:1px dashed var(--border, #ddd);border-radius:10px;">
          <img src="${escapeHtml(settings.qr_code_url)}" alt="QR Code" style="max-width:200px;width:100%;height:auto;border-radius:6px;">
          <div style="font-size:11px;color:var(--text-dim);margin-top:6px;">สแกน QR เพื่อโอนเงิน</div>
        </div>` : ""}
        ${settings.payment_instructions ? `<div style="font-size:12px;color:var(--text-dim);background:var(--bg-soft, #f7f7f7);padding:10px;border-radius:6px;margin:8px 0;line-height:1.5;">
          ${escapeHtml(settings.payment_instructions).replace(/\n/g, "<br>")}
        </div>` : ""}
        <button class="btn" id="paymentUploadSlipBtn" type="button" style="width:100%;margin-top:14px;background:var(--accent);color:#fff;font-size:15px;padding:12px;">
          📸 แจ้งชำระเงิน (อัปโหลดสลิป)
        </button>
        <button class="btn secondary" id="paymentCloseBtn2" type="button" style="width:100%;margin-top:6px;">ปิด</button>
      </div>
    `;

    // bind copy button
    const copyBtn = document.getElementById("paymentCopyBtn");
    if (copyBtn) copyBtn.onclick = async () => {
      const acctText = document.getElementById("paymentBankAccountText");
      const value = acctText?.textContent || settings.bank_account || "";
      try {
        await navigator.clipboard.writeText(value);
        showToast("📋 คัดลอกเลขบัญชีแล้ว", "success");
      } catch {
        // fallback: select + execCommand
        const ta = document.createElement("textarea");
        ta.value = value;
        document.body.appendChild(ta); ta.select();
        try { document.execCommand("copy"); showToast("📋 คัดลอกเลขบัญชีแล้ว", "success"); } catch { showToast("คัดลอกไม่สำเร็จ — กรุณาก๊อปปี้เอง", "error"); }
        document.body.removeChild(ta);
      }
    };

    // bind upload slip button → open upload slip modal
    const uploadSlipBtn = document.getElementById("paymentUploadSlipBtn");
    if (uploadSlipBtn) uploadSlipBtn.onclick = () => {
      const paymentBackdrop = document.getElementById("paymentBackdrop");
      if (paymentBackdrop) paymentBackdrop.classList.remove("show");
      openUploadSlipModal(order, receiptNumber);
    };

    // bind close button
    const closeBtn2 = document.getElementById("paymentCloseBtn2");
    if (closeBtn2) closeBtn2.onclick = closePaymentModal;
  }

  function closePaymentModal() {
    const backdrop = document.getElementById("paymentBackdrop");
    if (backdrop) { backdrop.classList.remove("show"); backdrop.setAttribute("aria-hidden", "true"); }
  }

  async function openUploadSlipModal(order, receiptNumber) {
    const backdrop = document.getElementById("uploadSlipBackdrop");
    const content = document.getElementById("uploadSlipContent");
    if (!backdrop || !content) return;
    const amount = order?.final_total ?? order?.total ?? 0;
    content.innerHTML = `
      <div style="padding:14px 8px 6px;">
        <div style="margin-bottom:12px;">
          <div style="font-size:13px;color:var(--text-dim);">Order</div>
          <div style="font-weight:800;">#${escapeHtml(receiptNumber)}</div>
        </div>
        <div style="margin-bottom:14px;">
          <div style="font-size:13px;color:var(--text-dim);">ยอดที่ต้องชำระ</div>
          <div style="font-size:24px;font-weight:800;color:var(--success);">${formatPrice(amount)}</div>
        </div>
        <div style="margin-bottom:8px;font-size:13px;font-weight:600;">รูปหลักฐานการโอนเงิน</div>
        <input type="file" id="slipFileInput" accept="image/jpeg,image/png,image/webp" style="display:none;">
        <label for="slipFileInput" style="display:block;border:2px dashed var(--border, #ccc);border-radius:10px;padding:24px;text-align:center;cursor:pointer;color:var(--text-dim);">
          <div id="slipPreviewArea" style="margin:0 auto;">
            <div style="font-size:36px;">📷</div>
            <div style="font-size:13px;margin-top:4px;">คลิกเพื่อเลือกรูปสลิป</div>
            <div style="font-size:11px;margin-top:2px;color:var(--text-dim);">JPEG / PNG / WEBP • สูงสุด 5MB</div>
          </div>
        </label>
        <div style="font-size:12px;color:var(--text-dim);margin-top:8px;display:flex;justify-content:space-between;">
          <span>ชื่อลูกค้า</span><strong>${escapeHtml(order?.customer_name || "")}</strong>
        </div>
        <div style="font-size:12px;color:var(--text-dim);margin-top:4px;display:flex;justify-content:space-between;">
          <span>เบอร์ WhatsApp</span><strong>${escapeHtml(order?.whatsapp || "")}</strong>
        </div>
        <button class="btn" id="uploadSlipConfirmBtn" type="button" disabled style="width:100%;margin-top:14px;background:var(--accent);color:#fff;font-size:15px;padding:12px;opacity:0.5;">
          ✅ ยืนยันการชำระเงิน
        </button>
        <button class="btn secondary" id="uploadSlipCancelBtn" type="button" style="width:100%;margin-top:6px;">ยกเลิก</button>
      </div>
    `;
    backdrop.classList.add("show");
    backdrop.setAttribute("aria-hidden", "false");

    let selectedFile = null;
    const fileInput = document.getElementById("slipFileInput");
    const previewArea = document.getElementById("slipPreviewArea");
    const confirmBtn = document.getElementById("uploadSlipConfirmBtn");

    if (fileInput) fileInput.onchange = () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      // size check 5MB
      if (file.size > 5 * 1024 * 1024) {
        showToast("ไฟล์ใหญ่เกิน 5MB — กรุณาลดขนาดรูป", "error");
        fileInput.value = "";
        return;
      }
      // MIME check
      const allowedMimes = ["image/jpeg", "image/png", "image/webp", "image/jpg"];
      if (!allowedMimes.includes((file.type || "").toLowerCase())) {
        showToast("อนุญาตเฉพาะ JPEG, PNG, WEBP", "error");
        fileInput.value = "";
        return;
      }
      selectedFile = file;
      // show preview
      const reader = new FileReader();
      reader.onload = (e) => {
        previewArea.innerHTML = `<img src="${e.target.result}" alt="รูปสลิปตัวอย่าง" style="max-width:100%;max-height:240px;border-radius:6px;border:1px solid var(--border, #eee);">`;
      };
      reader.readAsDataURL(file);
      if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.style.opacity = "1"; }
    };

    if (confirmBtn) confirmBtn.onclick = async () => {
      if (!selectedFile) { showToast("กรุณาเลือกรูปสลิปก่อน", "error"); return; }
      await uploadSlipToServer(order, receiptNumber, selectedFile);
    };

    const cancelBtn = document.getElementById("uploadSlipCancelBtn");
    if (cancelBtn) cancelBtn.onclick = closeUploadSlipModal;
  }

  function closeUploadSlipModal() {
    const backdrop = document.getElementById("uploadSlipBackdrop");
    if (backdrop) { backdrop.classList.remove("show"); backdrop.setAttribute("aria-hidden", "true"); }
  }

  async function uploadSlipToServer(order, receiptNumber, file) {
    const orderId = order?._docId || order?.id;
    if (!orderId) {
      showToast("ไม่พบเลขออเดอร์ — กรุณารีเฟรชหน้าแล้วลองใหม่", "error");
      return;
    }
    const confirmBtn = document.getElementById("uploadSlipConfirmBtn");
    if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = "กำลังอัปโหลด..."; confirmBtn.style.opacity = "0.7"; }
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("customer_name", order.customer_name || "");
      fd.append("whatsapp", order.whatsapp || "");
      const res = await fetch(`/api/orders/${encodeURIComponent(orderId)}/payment-proof`, {
        method: "POST",
        body: fd, // multipart — no Content-Type header (browser sets boundary)
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showToast("อัปโหลดไม่สำเร็จ: " + (data?.error || res.statusText), "error");
        if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = "✅ ยืนยันการชำระเงิน"; confirmBtn.style.opacity = "1"; }
        return;
      }
      showToast("✅ อัปโหลดสลิปสำเร็จ — รอแอดมินตรวจสอบ", "success");
      closeUploadSlipModal();
      closePaymentModal();
      // เปิด WhatsApp แจ้งแอดมิน (notification only — slip บันทึกใน R2+D1 แล้ว)
      openWhatsAppNotifyAdmin(order, receiptNumber, data.file_url);
    } catch (err) {
      showToast("อัปโหลดไม่สำเร็จ: " + (err.message || String(err)), "error");
      if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = "✅ ยืนยันการชำระเงิน"; confirmBtn.style.opacity = "1"; }
    }
  }

  function openWhatsAppNotifyAdmin(order, receiptNumber, slipUrl) {
    // ใช้ settings.whatsapp_number เดียวกับเดิม — notification only ไม่ใช่ระบบหลัก
    const adminNumber = String(state?.settings?.whatsapp_number || "").replace(/[^0-9]/g, "");
    if (!adminNumber) {
      showToast("อัปโหลดสลิปสำเร็จ — แต่ร้านยังไม่ได้ตั้งค่าเบอร์ WhatsApp แอดมินจะเห็นสลิปในหน้าตรวจสอบ", "success");
      return;
    }
    const amount = order?.final_total ?? order?.total ?? 0;
    const customerName = order?.customer_name || "";
    const lines = [
      `📸 แจ้งชำระเงิน Order ${receiptNumber}`,
      `ลูกค้า: ${customerName}`,
      `ยอด: ${formatPrice(amount)}`,
      slipUrl ? `สลิป: ${slipUrl}` : "(สลิปอัปโหลดในระบบแล้ว — ดูในหน้าตรวจสอบสลิป)",
    ];
    const text = lines.join("\n");
    const ok = confirm("อัปโหลดสลิปสำเร็จ!\n\nต้องการเปิด WhatsApp เพื่อแจ้งแอดมินด้วยไหม?\n\n(ระบบบันทึกสลิปแล้ว — WhatsApp เป็นเพียงการแจ้งเตือนเสริม)");
    if (!ok) return;
    window.open(buildWhatsAppLink(adminNumber, text), "_blank", "noopener");
  }

  // bind close buttons for new modals
  document.addEventListener("DOMContentLoaded", () => {
    const paymentClose = document.getElementById("paymentClose");
    if (paymentClose) paymentClose.onclick = closePaymentModal;
    const uploadSlipClose = document.getElementById("uploadSlipClose");
    if (uploadSlipClose) uploadSlipClose.onclick = closeUploadSlipModal;
    // close on backdrop click
    const paymentBackdrop = document.getElementById("paymentBackdrop");
    if (paymentBackdrop) paymentBackdrop.addEventListener("click", (e) => {
      if (e.target === paymentBackdrop) closePaymentModal();
    });
    const uploadSlipBackdrop = document.getElementById("uploadSlipBackdrop");
    if (uploadSlipBackdrop) uploadSlipBackdrop.addEventListener("click", (e) => {
      if (e.target === uploadSlipBackdrop) closeUploadSlipModal();
    });
  });

  async function checkoutCart() {
    if (submitting) return;
    const nameInput = document.getElementById("checkoutCustomerName");
    const whatsappInput = document.getElementById("checkoutCustomerWhatsapp");
    const customerName = nameInput?.value.trim() || "";
    const whatsapp = whatsappInput?.value.trim() || "";
    if (!customerName || !whatsapp) {
      setCheckoutFeedback("กรุณากรอกชื่อลูกค้าและเบอร์ WhatsApp");
      return;
    }
    // 🔧 (2026-09-21 fix Bug #2 Phone validation): ตรวจเบอร์ลาวก่อนส่ง
    //   ป้องกัน: ลูกค้าใส่ "abc" → ผ่าน checkout → แต่ track order ไม่เจอ → โทรด่าแอดมิน
    //   วิธี: ใช้ getPhoneValidationError() (เพิ่มใหม่ด้านบน)
    const phoneError = getPhoneValidationError(whatsapp);
    if (phoneError) {
      setCheckoutFeedback(phoneError);
      // focus input กลับเพื่อให้ลูกค้าแก้ได้ทันที
      if (whatsappInput) { whatsappInput.focus(); whatsappInput.select(); }
      return;
    }
    if (state.cart.length === 0) {
      setCheckoutFeedback("ยังไม่มีเพลงในตะกร้า");
      return;
    }

    submitting = true;
    const btn = document.getElementById("submitCartOrderBtn");
    if (btn) { btn.disabled = true; btn.textContent = "กำลังตรวจสอบและบันทึก..."; }
    setCheckoutFeedback("กำลังตรวจสอบรายการและราคาจากฐานข้อมูล...", "success");

    const createdAt = new Date().toISOString();
    const checkoutKey = getCheckoutKey(customerName, whatsapp);
    const reusableOrderId = activeOrderKey === checkoutKey
      ? activeOrderId
      : getStoredOrderId(checkoutKey);
    // ใช้ doc() สร้าง reference/ID ไว้ล่วงหน้า เพื่อใช้เป็น orderRef ตอนเขียนจริงด้านล่าง
    let orderRef = reusableOrderId
      ? doc(db, "orders", reusableOrderId)
      : doc(collection(db, "orders"));
    let receiptNumber = getReceiptNumber(orderRef.id, createdAt);

    let order = null;
    let resolvedSettings = {};
    try {
      // ---- อ่านราคา/รายการล่าสุดจากฐานข้อมูลก่อน แล้วค่อยเขียน Order (ไม่ใช้ Firestore Transaction) ----
      // หมายเหตุ (แก้บั๊ก 2026-09-05): เดิมใช้ runTransaction() ครอบขั้นตอนนี้ทั้งหมด แต่พบว่า
      // Firestore Web SDK บางเบราว์เซอร์ (โดยเฉพาะ Safari/iPad) โยน TypeError ภายใน SDK เอง
      // ("undefined is not an object (evaluating 'i.path')") ระหว่างปิด transaction แบบนี้
      // จึงเปลี่ยนมาอ่านแบบธรรมดาก่อน แล้วค่อยเขียนทีเดียวด้วย setDoc() แทน ผลลัพธ์ทางธุรกิจเหมือนเดิม
      // ทุกประการ เพียงไม่การันตี atomicity ระดับ transaction (ยอมรับได้ เพราะทุก Order มีสถานะ
      // "รอตรวจสอบการโอน" ให้แอดมินเช็คมืออยู่แล้ว)

      // ---- เพิ่มใหม่ (แก้บั๊ก 2026-09-09): ใส่ timeout กันปุ่มค้าง "กำลังตรวจสอบและบันทึก..." ตลอดไป ----
      // ถ้าเน็ตหลุด/Firestore ไม่ตอบภายในเวลาที่กำหนด ให้แจ้งลูกค้าและปลดล็อกปุ่มให้กดลองใหม่ได้
      // แทนที่จะปล่อยให้ปุ่มค้างเฉยๆ แบบไม่มีข้อความ (งานเดิม resolveCartFromDatabase/setDoc ไม่ถูกยกเลิก
      // อาจยังทำงานต่อในเบื้องหลัง แต่เนื่องจาก orderRef.id คงที่ต่อ checkoutKey เดิม การเขียนซ้ำภายหลัง
      // จะเขียนทับ Order เดิมด้วยข้อมูลเดียวกัน ไม่ทำให้เกิด Order ซ้ำซ้อน)
      const TIMEOUT_MS = 20000;
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error("เชื่อมต่อช้ากว่าปกติ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่อีกครั้ง")), TIMEOUT_MS);
      });

      // 🔧 แก้บั๊ก (2026-09-12): แยก buildOrder + setDoc ออกมาเป็นฟังก์ชัน เพื่อรองรับ retry ครั้งเดียว
      // เมื่อ setDoc เจอ "ยังไม่ได้เข้าสู่ระบบ" (เกิดจาก order ID ค้างใน sessionStorage หรือ worker เก่า
      // ที่ยังไม่ได้แก้ exception สำหรับ orders) → เคลียร์ order ID เก่าแล้วลองใหม่ด้วย ID ใหม่
      const buildAndSaveOrder = async (refToUse) => {
        const resolved = await resolveCartFromDatabase();
        resolvedSettings = resolved.settings || {};

        const builtOrder = {
          customer_name: customerName,
          // 🔧 แก้บั๊ก (2026-09-18): normalize เบอร์ Laos ก่อนเก็บลง DB
          //   เพื่อให้ track order ตามเบอร์รูปแบบใดก็เจอ (020 / 20 / +85620 ฯลฯ)
          whatsapp: normalizePhoneForStorage(whatsapp),
          items: resolved.items, // Order Items ทั้งหมดของตะกร้า ณ ขณะสั่งซื้อ
          total: resolved.total, // ← ยอดสุดท้าย (final_total) — เก็บเหมือนเดิมเพื่อ back-compat กับ orders.js เดิม
          order_type: resolved.orderType, // "single" | "playlist" | "mixed"
          playlist_id: resolved.orderType === "playlist" ? (resolved.playlist?.id || null) : null,
          playlist_name: resolved.orderType === "playlist" ? (resolved.playlist?.playlist_name || null) : null,
          store_name: resolved.settings.website_name || "Music Store",
          status: "pending_verify",
          created_at: createdAt,
          receipt_number: getReceiptNumber(refToUse.id, createdAt),
          // ===== ฟิลด์ใหม่: บันทึก snapshot การคำนวณส่วนลด/โปรโมชั่น ณ เวลาที่สั่ง =====
          // เก็บไว้ให้ order เก่าไม่เปลี่ยนราคาแม้ admin แก้ promotion ภายหลัง (เพราะเป็น snapshot)
          subtotal: resolved.subtotal ?? resolved.total,
          discount_amount: resolved.discountAmount ?? 0,
          promotion_applied: resolved.promotionApplied ?? null,
          final_total: resolved.finalTotal ?? resolved.total
        };
        // playlist_ids เป็นฟิลด์เสริมสำหรับ Order แบบผสม (เพลง+เพลย์ลิสต์ หรือหลายเพลย์ลิสต์) เท่านั้น
        // ระบบเดิม (resolveOrderSongs ใน orders.js) อ่านฟิลด์นี้อยู่แล้วสำหรับสร้าง ZIP ดาวน์โหลด จึงไม่ต้องแก้ไฟล์นั้นเพิ่ม
        if (resolved.orderType === "mixed") {
          builtOrder.playlist_ids = resolved.playlistIds;
        }

        await setDoc(refToUse, builtOrder);
        return builtOrder;
      };

      try {
        // ครั้งที่ 1: ใช้ orderRef ที่อาจเป็น reusableOrderId (ถ้ามี)
        const mainTask = buildAndSaveOrder(orderRef);
        order = await Promise.race([mainTask, timeoutPromise]);
        // 📸 (added STEP 2): เก็บ order_id ไว้ใน order object เพื่อใช้ตอน upload slip
        //   ไม่กระทบ D1 (setDoc ทำงานเสร็จแล้วก่อนบรรทัดนี้) — _docId เป็น client-only field
        if (order && !order._docId && orderRef?.id) order._docId = orderRef.id;
      } catch (firstErr) {
        // 🔧 แก้บั๊ก I9 (2026-09-18): Dead code path หลัง Bug #1 + Bug #5 fixes
        // -----------------------------------------------------------
        // ปัญหา: retry path นี้แทบไม่มีทาง trigger แล้ว เพราะ:
        //   - Bug #1 fix → POST /api/db/songs/_query ผ่านสำหรับ non-admin แล้ว → resolveCartFromDatabase ไม่ล้มเพราะ 401
        //   - Bug #5 fix → storeOrderId ถูก comment ออก → getStoredOrderId คืน null เสมอ → orderRef เป็น UUID ใหม่เสมอ
        //     → setDoc สร้าง order ใหม่ ไม่ชน existing check ของ worker → ไม่มี error "ยังไม่ได้ login"
        //
        // ที่ไม่ลบทิ้ง: กฎของโปรเจกต์ "ห้ามลบโค้ดเพียงเพราะคิดว่าไม่ได้ใช้งาน"
        //   แต่ comment ออกเพื่อให้ Dev ใหม่เห็นชัดว่า "โค้ดนี้ไม่ทำงาน" และลดความสับสน
        //
        // ถ้าอนาคตมี edge case ที่ทำให้ retry path จำเป็นอีก:
        //   1. Uncomment retry block ด้านล่าง
        //   2. ตรวจสอบว่า storeOrderId/clearStoredOrderId ทำงานถูกต้อง (Bug #5 อาจต้อง uncomment ด้วย)
        //
        // โค้ดเดิม (comment ออกแล้ว):
        // // 🔧 ตรวจว่า error จาก server บอกว่า "ยังไม่ได้ login" หรือ "ยังไม่ได้เข้าสู่ระบบ" หรือไม่
        // // ถ้าใช่ → เคลียร์ reusableOrderId ที่ค้างอยู่ใน sessionStorage/state แล้ว retry ด้วย ID ใหม่
        // const msg = (firstErr?.message || "").toLowerCase();
        // const isLoginBlock = msg.includes("ยังไม่ได้เข้าสู่ระบบ") || msg.includes("login") || msg.includes("เข้าสู่ระบบ");
        // if (!isLoginBlock) throw firstErr;
        //
        // console.warn("checkoutCart: พบ error 'ยังไม่ได้ login' — เคลียร์ order ID เก่าแล้ว retry ด้วย ID ใหม่", firstErr);
        // activeOrderId = null;
        // activeOrderKey = null;
        // clearStoredOrderId();
        // // สร้าง orderRef ใหม่ด้วย ID ใหม่ (doc(collection(db,"orders")) จะสุ่ม UUID ใหม่ให้)
        // orderRef = doc(collection(db, "orders"));
        // receiptNumber = getReceiptNumber(orderRef.id, createdAt);
        //
        // // ครั้งที่ 2: ใช้ ID ใหม่
        // const TIMEOUT_MS_RETRY = 20000;
        // const timeoutPromise2 = new Promise((_, reject) => {
        //   setTimeout(() => reject(new Error("เชื่อมต่อช้ากว่าปกติ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่อีกครั้ง")), TIMEOUT_MS_RETRY);
        // });
        // const retryTask = buildAndSaveOrder(orderRef);
        // order = await Promise.race([retryTask, timeoutPromise2]);

        // 🔧 แก้บั๊ก I9: แค่ re-throw error ออกไปให้ catch block ด้านล่างจัดการ (แสดง error ให้ลูกค้าเห็น)
        throw firstErr;
      }
    } catch (err) {
      console.error("checkoutCart error:", err);
      let feedbackMessage;
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        // เพิ่มใหม่: ไม่มีเน็ต
        feedbackMessage = "ไม่มีสัญญาณอินเทอร์เน็ต กรุณาตรวจสอบการเชื่อมต่อแล้วลองใหม่อีกครั้ง";
      } else if (err?.message && err.message.includes("ปิดการขายแล้ว")) {
        // 🔧 (2026-09-22 Batch 7 fix Bug #5): ลูกค้า checkout มีเพลง hidden ในตะกร้า
        //   ปัญหาเดิม: โยน error ทำให้ checkout พัง → ลูกค้างง ไม่รู้ว่าเพลงไหน ต้องทำยังไง
        //   วิธีแก้: auto-remove เพลง hidden ออกจากตะกร้า + บอกชื่อเพลง + แนะนำให้ลอง checkout อีกครั้ง
        //   1. parse ชื่อเพลงจาก error message ("เพลง "X" ปิดการขายแล้ว")
        const songNameMatch = err.message.match(/เพลง\s+"([^"]+)"\s+ปิดการขาย/);
        const hiddenSongName = songNameMatch ? songNameMatch[1] : "";
        // 2. ลบเพลง hidden ออกจาก state.cart (match ด้วย song_name)
        const beforeCount = state.cart.length;
        state.cart = state.cart.filter(item =>
          !(item.song_name === hiddenSongName || item.songName === hiddenSongName)
        );
        const removedCount = beforeCount - state.cart.length;
        // 3. save cart ใหม่ลง localStorage
        try { localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(state.cart)); } catch (_) {}
        // 4. re-render cart + badge
        renderCart();
        // 5. แจ้งเตือนลูกค้าชัดเจน
        if (removedCount > 0) {
          feedbackMessage = `เพลง "${hiddenSongName}" ถูกปิดขายแล้ว — ลบออกจากตะกร้าให้อัตโนมัติ กรุณากด "ยืนยันสั่งซื้อ" อีกครั้ง`;
        } else {
          feedbackMessage = err.message + " — กรุณาลบเพลงนี้ออกจากตะกร้าแล้วลองใหม่";
        }
      } else if (!err?.code && err?.message) {
        // ข้อความที่ระบบโยนเองอยู่แล้ว (เช่น timeout ด้านบน) เป็นภาษาไทยที่เข้าใจง่ายอยู่แล้ว ใช้ตรงๆ ได้เลย
        feedbackMessage = err.message;
      } else {
        // เพิ่มใหม่: error ดิบจาก Firebase (มี err.code) แปลเป็นข้อความที่ลูกค้าอ่านเข้าใจแทน
        feedbackMessage = "บันทึก Order ไม่สำเร็จ ระบบขัดข้องชั่วคราว กรุณาลองใหม่อีกครั้ง";
      }
      setCheckoutFeedback(feedbackMessage);
      submitting = false;
      if (btn) { btn.disabled = false; btn.textContent = "ยืนยันสั่งซื้อ"; }
      return;
    }

    // มาถึงจุดนี้แปลว่า Transaction commit สำเร็จแล้ว — ล้างเฉพาะรายการที่สั่งซื้อสำเร็จออกจากตะกร้า
    //
    // 🔧 แก้บั๊ก (2026-09-17) Bug #5: Dead code — storeOrderId + activeOrderId ถูก set แล้ว clear ทันที
    // -----------------------------------------------------------
    // ปัญหา: บรรทัดด้านล่าง (comment ออกแล้ว) เป็น dead code 100%
    //   - activeOrderId = orderRef.id;     ← set ที่บรรทัด 1067 (comment ออก)
    //   - activeOrderKey = checkoutKey;    ← set ที่บรรทัด 1068 (comment ออก)
    //   - storeOrderId(checkoutKey, orderRef.id);  ← save ลง sessionStorage ที่บรรทัด 1069 (comment ออก)
    //   ...
    //   - activeOrderId = null;            ← clear ที่บรรทัด 1073 (comment ออก)
    //   - activeOrderKey = null;           ← clear ที่บรรทัด 1074 (comment ออก)
    //   - clearStoredOrderId();            ← remove จาก sessionStorage ที่บรรทัด 1075 (comment ออก)
    //
    //   ทั้งหมดนี้ทำงานใน synchronous block เดียวกัน — set แล้ว clear ทันที ไม่มี code อื่นอ่านค่าระหว่างนั้น
    //   → ไม่มีผลใด ๆ ต่อระบบจริง (ยืนยันด้วย grep ทั้งไฟล์ + cross-check ทุก caller)
    //
    // ที่ไม่ลบทิ้ง: กฎของโปรเจกต์ "ห้ามลบโค้ดเพียงเพราะคิดว่าไม่ได้ใช้งาน"
    //   แต่ comment ออกเพื่อให้ Dev ใหม่เห็นชัดว่าโค้ดนี้ "ไม่ทำงาน" และลด overhead (function call + sessionStorage write)
    //
    // ถ้าอนาคตต้องการให้ "reuse order ID ครั้งถัดไป" ทำงานจริง:
    //   1. Uncomment บรรทัด 1067-1069 (SET block)
    //   2. ลบบรรทัด 1073-1075 (CLEAR block) ออก — ไม่ clear จะได้เก็บไว้ใช้ครั้งถัดไป
    //   3. ตรวจสอบ flow ใน addToCart() ที่ set activeOrderId = null อยู่แล้ว อาจต้องปรับ
    //
    // ผลกระทบต่อระบบเดิม: 0%
    //   - ไม่มี code อื่นอ่าน activeOrderId/activeOrderKey/storeOrderId ระหว่างบรรทัด 1067 ถึง 1075
    //   - getStoredOrderId(checkoutKey) ยังคงทำงาน (line 956) — แต่จะคืน null เสมอเพราะไม่มีการ store แล้ว
    //   - ส่งผลให้ลูกค้าที่สั่งซื้อครั้งที่ 2 ด้วยชื่อ+เบอร์เดิมจะได้ order ID ใหม่เสมอ (ซึ่งก็คือ behavior ปัจจุบันอยู่แล้ว)
    // activeOrderId = orderRef.id;
    // activeOrderKey = checkoutKey;
    // storeOrderId(checkoutKey, orderRef.id);

    state.cart = [];
    try { localStorage.removeItem(CART_STORAGE_KEY); } catch (_) {}
    // 🔧 แก้บั๊ก Bug #5: บรรทัดข้างล่างนี้ comment ออกเช่นกัน — เป็นส่วน clear ของ dead code block
    //   อ่านคอมเมนต์ด้านบนสำหรับรายละเอียดเต็ม
    // activeOrderId = null;
    // activeOrderKey = null;
    // clearStoredOrderId();
    renderCart();
    // เพิ่มใหม่: จำชื่อ+เบอร์โทรไว้ในเครื่อง เพื่อเติมฟอร์มอัตโนมัติให้ลูกค้าตอนสั่งซื้อครั้งถัดไป
    saveCustomerInfo(customerName, normalizePhoneForStorage(whatsapp));
    // 🔧 (2026-09-17): บันทึก name+whatsapp ลง MY_ORDERS_INFO_KEY ด้วย (key เดียวกับ app-promotion.js + app-user.js badge)
    // เพื่อให้ badge บนปุ่ม "ติดตามออเดอร์" สามารถ detect ลูกค้าได้ทันทีหลังสั่งซื้อ — ไม่ต้องรอให้ลูกค้าเปิด My Orders ก่อน
    // 🔧 (2026-09-18): เก็บเบอร์แบบ normalized ด้วย เพื่อให้ตรงกับค่าใน DB และ badge ทำงานถูกต้อง
    try { localStorage.setItem("music_store_my_orders_info_v1", JSON.stringify({ name: customerName, whatsapp: normalizePhoneForStorage(whatsapp) })); } catch (_) {}
    // 🔧 (2026-09-17): refresh badge ทันที — listener จะ poll ทันที (delay 0) → แสดง badge "1" ภายใน ~200-500ms
    if (window.__refreshTrackOrderBadge) window.__refreshTrackOrderBadge();
    if (nameInput) nameInput.value = "";
    if (whatsappInput) whatsappInput.value = "";
    setCheckoutFeedback(`บันทึก Order ${receiptNumber} สำเร็จแล้ว`, "success");

    submitting = false;
    if (btn) { btn.disabled = false; btn.textContent = "ยืนยันสั่งซื้อ"; }

    // เดิม: เปิด WhatsApp หาแอดมินอัตโนมัติทันที — เปลี่ยนเป็นแสดงใบเสร็จก่อน แล้วให้ลูกค้ากดปุ่มเองเพื่อติดต่อแอดมิน
    closeCheckout();
    saveLastOrderRecord(order, receiptNumber);
    showReceipt(order, receiptNumber, resolvedSettings.whatsapp_number);
  }

  function bindCartEvents() {
    document.getElementById("cartToggleBtn")?.addEventListener("click", openCart);
    document.getElementById("cartCloseBtn")?.addEventListener("click", closeCart);
    document.getElementById("cartBackdrop")?.addEventListener("click", event => {
      if (event.target === event.currentTarget) closeCart();
    });
    document.getElementById("checkoutCloseBtn")?.addEventListener("click", closeCheckout);
    document.getElementById("checkoutBackdrop")?.addEventListener("click", event => {
      if (event.target === event.currentTarget) closeCheckout();
    });

    // 🔧 (2026-09-22 Batch 7 fix Bug #3): Cart sync between browser tabs
    //   ปัญหา: ลูกค้าเปิด 2 tabs → add ใน tab A → tab B ไม่ update → add ซ้ำ → double-add
    //   วิธีแก้: ฟัง storage event → ถ้า localStorage.cart เปลี่ยน (จาก tab อื่น) → reload cart
    //   ผลกระทบระบบเดิม: 0% — เพิ่ม event listener ไม่แตะฟังก์ชันเดิม
    //   หมายเหตุ: storage event ทำงานเฉพาะเมื่อ ANOTHER tab/document เปลี่ยนค่า
    //   ไม่ trigger ตอน tab ปัจจุบันเปลี่ยน → ไม่มี loop
    window.addEventListener("storage", (event) => {
      if (event.key === CART_STORAGE_KEY) {
        // cart เปลี่ยนจาก tab อื่น → reload ตะกร้า + re-render
        loadCart();
        if (typeof renderCart === "function") renderCart();
        if (typeof renderPendingOrderBanner === "function") renderPendingOrderBanner();
      }
      if (event.key === BANNER_DISMISS_KEY) {
        // banner dismiss เปลี่ยน → re-render banner (sync ระหว่าง tabs)
        if (typeof renderPendingOrderBanner === "function") renderPendingOrderBanner();
      }
      if (event.key === LAST_ORDER_STORAGE_KEY) {
        // last order เปลี่ยน → re-render banner (เผื่อออเดอร์ใหม่จาก tab อื่น)
        if (typeof renderPendingOrderBanner === "function") renderPendingOrderBanner();
      }
    });
    document.getElementById("cartItems")?.addEventListener("click", event => {
      const button = event.target.closest("button");
      if (!button) return;
      if (button.matches("[data-cart-continue]")) { closeCart(); return; }
      if (button.dataset.cartViewSongs) {
        const list = document.getElementById(`cartSongs-${button.dataset.cartViewSongs}`);
        if (list) {
          const willOpen = !list.classList.contains("is-open");
          list.classList.toggle("is-open", willOpen);
          button.textContent = button.textContent.replace(/^(ดู|ซ่อน)/, willOpen ? "ซ่อน" : "ดู");
        }
        return;
      }
      if (button.dataset.cartRemove) {
        activeOrderId = null;
        activeOrderKey = null;
        removeFromCart(button.dataset.cartRemove);
      }
    });
    document.getElementById("clearCartBtn")?.addEventListener("click", () => {
      if (state.cart.length && window.confirm("ต้องการล้างเพลงทั้งหมดออกจากตะกร้าหรือไม่?")) {
        state.cart = [];
        activeOrderId = null;
        activeOrderKey = null;
        saveCart();
        showToast("ล้างตะกร้าแล้ว", "success");
      }
    });
    document.getElementById("checkoutCartBtn")?.addEventListener("click", openCheckout);
    document.getElementById("submitCartOrderBtn")?.addEventListener("click", checkoutCart);
    // เพิ่มใหม่: ปิด popup ใบเสร็จ (เตือนก่อนถ้ายังไม่ได้แจ้งแอดมิน)
    document.getElementById("receiptClose")?.addEventListener("click", attemptCloseReceipt);
    document.getElementById("receiptBackdrop")?.addEventListener("click", event => {
      if (event.target === event.currentTarget) attemptCloseReceipt();
    });
    // เพิ่มใหม่: แถบเตือนออเดอร์ค้างแจ้งแอดมิน
    document.getElementById("pendingOrderBannerBtn")?.addEventListener("click", () => {
      const record = getLastOrderRecord();
      if (!record) { renderPendingOrderBanner(); return; }
      showReceipt(record.order, record.receiptNumber, state.settings?.whatsapp_number, record.contacted);
    });
    document.getElementById("pendingOrderBannerDismiss")?.addEventListener("click", () => {
      // 🔧 (2026-09-22 Batch 7 fix Bug #4): localStorage + 24h TTL แทน sessionStorage "1"
      //   เดิม: sessionStorage → หายตอนปิด tab → ลูกค้าเปิด tab ค้างไว้ → banner หายตลอดวัน
      //   ใหม่: localStorage เก็บ timestamp หมดอายุ (now + 24h) → ครบ 24h แสดง banner อีกครั้ง
      const DISMISS_TTL_MS = 24 * 60 * 60 * 1000; // 24 ชั่วโมง
      try {
        localStorage.setItem(BANNER_DISMISS_KEY, String(Date.now() + DISMISS_TTL_MS));
      } catch (_) {}
      renderPendingOrderBanner();
    });
  }

  return {
    loadCart,
    bindCartEvents,
    addToCart,
    renderCart,
    openCart,
    closeCart,
    checkoutCart,
    getLastOrderRecord,
    showReceipt
  };
}
