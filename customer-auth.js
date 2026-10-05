// customer-auth.js
// ===================================================
// 🆕 (2026-10-01): ระบบสมาชิกลูกค้า (Customer Account) — Frontend logic
//   ลูกค้าเลือกสมัคร/เข้าสู่ระบบ (optional — ไม่ login ก็ซื้อได้)
//   รองรับ login ด้วย email หรือ WhatsApp (เลือกอย่างใดอย่างหนึ่ง)
//
//   ผลกระทบระบบเดิม: 0% — ไฟล์ใหม่ ไม่แตะ app-user.js / app-cart.js / app-promotion.js
//   ใช้ pattern เดียวกับระบบแอดมิน (app-admin.js) — fetch + cookie HttpOnly
//
//   State: currentCustomer = null ถ้าไม่ login, หรือ { id, email, whatsapp, display_name, created_at }
// ===================================================

// 🆕 state — เก็บข้อมูลลูกค้าที่ login อยู่ (null = ยังไม่ login)
let currentCustomer = null;

// 🆕 (2026-10-02 fix): เก็บ customer ใน localStorage เพื่อให้ app-cart.js / app-user.js
//   อ่านได้ทันทีโดยไม่ต้องรอ customer-auth.js โหลดเสร็จ (ES module timing issue)
//   - บันทึกตอน login/register สำเร็จ
//   - ลบตอน logout
//   - อ่านตอน initCustomerAuth (page load)
const CUSTOMER_STORAGE_KEY = "miusic_customer_session";

function saveCustomerToStorage(customer) {
  // 🆕 (2026-10-03 v11 — แยก Login / Guest): จำ id ก่อนเขียน เพื่อรู้ว่า "ตัวตน" เปลี่ยนจริงไหม
  //   (guest→login, login→guest, หรือสลับบัญชี) — ถ้าเปลี่ยน ต้องล้าง/โหลด badge + แถบเตือน + modal ติดตามออเดอร์ใหม่
  //   ถ้า id เดิม (แค่รีเฟรชโปรไฟล์) → ไม่ทำอะไรเพิ่ม
  let prevId = "";
  try {
    const prevRaw = localStorage.getItem(CUSTOMER_STORAGE_KEY);
    prevId = prevRaw ? String((JSON.parse(prevRaw) || {}).id || "") : "";
  } catch (_) {}
  try {
    if (customer) {
      localStorage.setItem(CUSTOMER_STORAGE_KEY, JSON.stringify(customer));
    } else {
      localStorage.removeItem(CUSTOMER_STORAGE_KEY);
    }
  } catch (_) {}
  const nextId = customer && customer.id ? String(customer.id) : "";
  if (prevId !== nextId && typeof window.__onOrderScopeChanged === "function") {
    try { window.__onOrderScopeChanged(); } catch (err) { console.warn("[customer-auth] onOrderScopeChanged failed:", err?.message || err); }
  }
}

function loadCustomerFromStorage() {
  try {
    const raw = localStorage.getItem(CUSTOMER_STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (_) { return null; }
}

// 🆕 ตรวจสถานะ login — ใช้ใน app-user.js / app-cart.js ตรวจว่า login แล้วไหม
function isCustomerLoggedIn() {
  return !!currentCustomer;
}

// 🆕 ดึงข้อมูล customer ปัจจุบัน (null ถ้าไม่ login)
function getCurrentCustomer() {
  return currentCustomer;
}

// 🆕 sync UI ตามสถานะ login — แสดง/ซ่อนปุ่ม + ชื่อลูกค้า
//   🆕 (2026-10-01 styling): ใช้ CSS class (จาก style.css) แทน inline style — สวย + เข้ากับธีม
function syncCustomerAuthUI() {
  const btnArea = document.getElementById("customerAuthBtnArea");
  if (!btnArea) return;
  if (currentCustomer) {
    // login แล้ว — แสดงชื่อ + ปุ่มออกจากระบบ + ปุ่มบัญชี
    btnArea.innerHTML = `
      <button class="customer-account-btn" id="customerAccountBtn" type="button" aria-label="บัญชีของฉัน" title="บัญชีของฉัน">
        <span>👤</span>
        <span style="max-width:80px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtmlCustomer(currentCustomer.display_name || currentCustomer.email || currentCustomer.whatsapp || "ลูกค้า")}</span>
      </button>
      <button class="customer-logout-btn" id="customerLogoutBtn" type="button" aria-label="ออกจากระบบ" title="ออกจากระบบ">
        ⎋
      </button>
    `;
    // ผูก listeners
    document.getElementById("customerAccountBtn")?.addEventListener("click", () => {
      // 🆕 (2026-10-02 fix): เรียก window.showCustomerAccountView ถ้ามี
      //   ถ้าไม่มี (ES module timing) → ใช้ fallback เปิด myOrdersView โดยตรง
      if (typeof window.showCustomerAccountView === "function") {
        window.showCustomerAccountView();
      } else {
        // 🔧 (2026-10-02 fix2): Fallback — ให้แท็บ "ออเดอร์ของฉัน" จัดการ (app-user.js จะเปิดหน้าบัญชีให้เอง)
        const tabBtn = document.querySelector('.bottom-nav button[data-tab="myorders"]');
        if (tabBtn) tabBtn.click();
      }
    });
    document.getElementById("customerLogoutBtn")?.addEventListener("click", async () => {
      if (!confirm("ต้องการออกจากระบบใช่ไหม?")) return;
      await customerLogout();
    });
  } else {
    // ยังไม่ login — แสดงปุ่มสมัคร/เข้าสู่ระบบ (gradient ม่วงสวย)
    btnArea.innerHTML = `
      <button class="customer-login-btn" id="customerLoginBtn" type="button" aria-label="เข้าสู่ระบบ" title="เข้าสู่ระบบ / สมัครสมาชิก">
        <span>👤</span>
        <span>เข้าสู่ระบบ</span>
      </button>
    `;
    document.getElementById("customerLoginBtn")?.addEventListener("click", () => {
      openCustomerAuthModal();
    });
  }

  // 🆕 (T020): แจ้ง component อื่น ๆ ว่าสถานะ login เปลี่ยน — ใช้สำหรับ re-render review form ใน song modal
  //   - listener ใน app-user.js setupReviewHandlers จะเรียก loadSongReviews ใหม่เพื่อ sync UI
  //   - ไม่กระทบระบบเดิม — เพิ่ม custom event 'customer-auth-changed' (no-op ถ้าไม่มี listener)
  try {
    window.dispatchEvent(new CustomEvent("customer-auth-changed", { detail: { loggedIn: !!currentCustomer } }));
  } catch (_) { /* ข้ามไปเงียบ ๆ — กัน browser ที่ไม่รองรับ CustomEvent */ }
}

// 🆕 ตรวจ session ตอน page load — เรียก /api/customer/me
//   ถ้ามี session (login แล้ว) → set currentCustomer + sync UI
//   ถ้าไม่มี → currentCustomer = null + sync UI (แสดงปุ่ม login)
async function initCustomerAuth() {
  // 🆕 (2026-10-02): อ่านจาก localStorage ก่อนทันที (ไม่ต้องรอ fetch) → app-cart.js ใช้ได้เลย
  const stored = loadCustomerFromStorage();
  if (stored) currentCustomer = stored;
  // ตรวจ session จาก server (เพื่อยืนยันว่ายัง valid)
  try {
    const res = await fetch("/api/customer/me", { credentials: "same-origin" });
    if (res.ok) {
      const data = await res.json();
      if (data?.ok && data?.customer) {
        currentCustomer = data.customer;
        saveCustomerToStorage(data.customer); // 🆕 บันทึกลง localStorage
      } else {
        // server บอกไม่ login → ลบ localStorage
        currentCustomer = null;
        saveCustomerToStorage(null);
      }
    } else if (res.status === 401) {
      // session หมดอายุ → ลบ localStorage
      currentCustomer = null;
      saveCustomerToStorage(null);
    }
  } catch (err) {
    console.warn("[customer-auth] init failed:", err?.message || err);
    // ถ้า fetch fail → ใช้ localStorage (ถ้ามี) เป็น fallback
  }
  syncCustomerAuthUI();
}

// 🆕 เปิด modal สมัคร/เข้าสู่ระบบ (tab เดียว เลือกได้ว่าจะสมัครหรือ login)
function openCustomerAuthModal() {
  const backdrop = document.getElementById("customerAuthBackdrop");
  if (!backdrop) return;
  // ล้างฟอร์ม
  document.getElementById("customerAuthLogin").value = "";
  document.getElementById("customerAuthPassword").value = "";
  document.getElementById("customerAuthDisplayName").value = "";
  document.getElementById("customerAuthWhatsapp").value = "";
  document.getElementById("customerAuthError").textContent = "";
  // default tab = login
  switchCustomerAuthTab("login");
  backdrop.classList.add("show");
  backdrop.setAttribute("aria-hidden", "false");
}

function closeCustomerAuthModal() {
  const backdrop = document.getElementById("customerAuthBackdrop");
  if (!backdrop) return;
  backdrop.classList.remove("show");
  backdrop.setAttribute("aria-hidden", "true");
}

// 🆕 สลับ tab login/register
function switchCustomerAuthTab(tab) {
  const loginTab = document.getElementById("customerAuthTabLogin");
  const registerTab = document.getElementById("customerAuthTabRegister");
  const loginView = document.getElementById("customerAuthLoginView");
  const registerView = document.getElementById("customerAuthRegisterView");
  if (tab === "login") {
    if (loginTab) loginTab.classList.add("active");
    if (registerTab) registerTab.classList.remove("active");
    if (loginView) loginView.style.display = "block";
    if (registerView) registerView.style.display = "none";
  } else {
    if (registerTab) registerTab.classList.add("active");
    if (loginTab) loginTab.classList.remove("active");
    if (registerView) registerView.style.display = "block";
    if (loginView) loginView.style.display = "none";
  }
  // ล้าง error
  const errEl = document.getElementById("customerAuthError");
  if (errEl) errEl.textContent = "";
}

// 🆕 สมัครสมาชิก — เรียก /api/customer/register
async function customerRegister() {
  const login = document.getElementById("customerAuthLogin")?.value?.trim() || "";
  const password = document.getElementById("customerAuthPassword")?.value || "";
  const displayName = document.getElementById("customerAuthDisplayName")?.value?.trim() || "";
  const whatsapp = document.getElementById("customerAuthWhatsapp")?.value?.trim() || "";
  const errEl = document.getElementById("customerAuthError");
  if (errEl) errEl.textContent = "";
  if (!login) { if (errEl) errEl.textContent = "กรุณากรอกอีเมลหรือเบอร์ WhatsApp"; return; }
  if (password.length < 6) { if (errEl) errEl.textContent = "รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร"; return; }
  if (!displayName) { if (errEl) errEl.textContent = "กรุณากรอกชื่อที่แสดง"; return; }
  // ตรวจว่า login เป็น email หรือ whatsapp
  const isEmail = login.includes("@");
  const body = {
    password,
    display_name: displayName,
    email: isEmail ? login : "",
    whatsapp: isEmail ? "" : (whatsapp || login),
  };
  try {
    const res = await fetch("/api/customer/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // 🆕 (2026-10-02 v2): ถ้า code เป็น EMAIL_EXISTS หรือ WHATSAPP_EXISTS → แสดง modal ยืนยัน "ซ้ำ → login / ลืมรหัส"
      if (data?.code === "EMAIL_EXISTS" || data?.code === "WHATSAPP_EXISTS") {
        const existingField = data.existing_field || (data.code === "EMAIL_EXISTS" ? "email" : "whatsapp");
        showDuplicateAccountModal(login, existingField);
        return;
      }
      if (errEl) errEl.textContent = data?.error || "สมัครสมาชิกไม่สำเร็จ";
      return;
    }
    if (data?.ok && data?.customer) {
      currentCustomer = data.customer;
      saveCustomerToStorage(data.customer); // 🆕 บันทึกลง localStorage
      syncCustomerAuthUI();
      closeCustomerAuthModal();
      if (typeof showToast === "function") showToast("✅ สมัครสมาชิกสำเร็จ", "success");
      else alert("✅ สมัครสมาชิกสำเร็จ");
    }
  } catch (err) {
    if (errEl) errEl.textContent = "เกิดข้อผิดพลาด: " + (err.message || String(err));
  }
}

// 🆕 (2026-10-02 v2): showDuplicateAccountModal — แจ้งว่าบัญชีซ้ำ + ปุ่มไป login / ลืมรหัสผ่าน
//   เรียกเมื่อ register ได้ 409 + code = EMAIL_EXISTS | WHATSAPP_EXISTS
//   ไม่แตะ modal เดิม — ใช้ confirm() + switch tab (UX เรียบง่าย ไม่สร้าง modal ใหม่)
function showDuplicateAccountModal(loginValue, existingField) {
  const fieldLabel = existingField === "whatsapp" ? "เบอร์ WhatsApp" : "อีเมล";
  const msg = `⚠️ ${fieldLabel} "${loginValue}" ถูกใช้สมัครแล้ว\n\nคุณต้อการทำอะไรต่อ?\n• ตกลง = เข้าสู่ระบบด้วยบัญชีนี้\n• ยกเลิก = ปิด (ถ้าลืมรหัสผ่าน → กด "ลืมรหัสผ่าน?" ใต้ช่อง login)`;
  const goLogin = confirm(msg);
  if (goLogin) {
    // switch ไป tab login + กรอก login ให้อัตโนมัติ
    switchCustomerAuthTab("login");
    const loginInput = document.getElementById("customerAuthLogin");
    if (loginInput) loginInput.value = loginValue;
    const errEl = document.getElementById("customerAuthError");
    if (errEl) errEl.textContent = `ℹ️ ${fieldLabel}นี้มีบัญชีแล้ว — กรอกรหัสผ่านเพื่อเข้าสู่ระบบ (หรือกด "ลืมรหัสผ่าน?" ถ้าจำไม่ได้)`;
    // focus ที่ password
    const pwdInput = document.getElementById("customerAuthPassword");
    if (pwdInput) pwdInput.focus();
  }
}

// 🆕 (2026-10-02 v2): openForgotPasswordModal — เปิด modal ลืมรหัสผ่าน (modal ใหม่)
function openForgotPasswordModal() {
  // ดึง login จากช่อง login ปัจจุบัน (ถ้ามี) → กรอกให้อัตโนมัติ
  const currentLogin = document.getElementById("customerAuthLogin")?.value?.trim() || "";
  const input = document.getElementById("forgotPasswordLogin");
  if (input) input.value = currentLogin;
  const resultEl = document.getElementById("forgotPasswordResult");
  if (resultEl) resultEl.textContent = "";
  const backdrop = document.getElementById("forgotPasswordBackdrop");
  if (backdrop) {
    backdrop.style.display = "flex";
    backdrop.setAttribute("aria-hidden", "false");
  }
}

// 🆕 (2026-10-02 v2): closeForgotPasswordModal
function closeForgotPasswordModal() {
  const backdrop = document.getElementById("forgotPasswordBackdrop");
  if (backdrop) {
    backdrop.style.display = "none";
    backdrop.setAttribute("aria-hidden", "true");
  }
}

// 🆕 (2026-10-02 v2): submitForgotPassword — เรียก /api/customer/forgot-password
async function submitForgotPassword() {
  const login = document.getElementById("forgotPasswordLogin")?.value?.trim() || "";
  const resultEl = document.getElementById("forgotPasswordResult");
  if (resultEl) resultEl.textContent = "";
  if (!login) {
    if (resultEl) { resultEl.textContent = "กรุณากรอกอีเมลหรือเบอร์ WhatsApp"; resultEl.style.color = "var(--danger)"; }
    return;
  }
  const btn = document.getElementById("forgotPasswordSubmitBtn");
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
      // ปิดปุ่ม submit ป้องกันกดซ้ำ
      if (btn) { btn.textContent = "✅ ส่งคำขอแล้ว"; btn.disabled = true; }
    } else {
      if (resultEl) { resultEl.textContent = data?.error || "ส่งคำขาไม่สำเร็จ"; resultEl.style.color = "var(--danger)"; }
      if (btn) { btn.disabled = false; btn.textContent = "ส่งคำขารีเซ็ตรหัสผ่าน"; }
    }
  } catch (err) {
    if (resultEl) { resultEl.textContent = "เกิดข้อผิดพลาด: " + (err.message || String(err)); resultEl.style.color = "var(--danger)"; }
    if (btn) { btn.disabled = false; btn.textContent = "ส่งคำขารีเซ็ตรหัสผ่าน"; }
  }
}

// 🆕 เข้าสู่ระบบ — เรียก /api/customer/login
async function customerLogin() {
  const login = document.getElementById("customerAuthLogin")?.value?.trim() || "";
  const password = document.getElementById("customerAuthPassword")?.value || "";
  const errEl = document.getElementById("customerAuthError");
  if (errEl) errEl.textContent = "";
  if (!login || !password) { if (errEl) errEl.textContent = "กรุณากรอกอีเมล/เบอร์ WhatsApp และรหัสผ่าน"; return; }
  try {
    // 🆕 (T053-M4): ส่ง fingerprint ตอน login → server จะได้ migration anon→customer ได้
    //   เดิม: ส่งแค่ { login, password } → server ไม่รู้ว่าลูกค้าเคย like ตอน anon อยู่ → like หาย
    //   ใหม่: ส่ง fingerprint ที่ลูกค้าใช้ตอน anon → server ย้าย like จาก 'anon:<fp>' ไป customer.id
    //   ถ้ายังไม่เคย like ตอน anon → fingerprint ว่าง → server ข้าม migration (ปลอดภัย)
    const fingerprint = await getAnonymousFingerprint().catch(() => "");
    const res = await fetch("/api/customer/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ login, password, fingerprint }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (errEl) errEl.textContent = data?.error || "เข้าสู่ระบบไม่สำเร็จ";
      return;
    }
    if (data?.ok && data?.customer) {
      currentCustomer = data.customer;
      // 🆕 (T059): clear IndexedDB cache ก่อน set new customer — กัน PII รั่วจาก customer ก่อนหน้า
      try { if (window.IDB) await window.IDB.clearAll(); } catch (_) {}
      saveCustomerToStorage(data.customer); // 🆕 บันทึกลง localStorage
      syncCustomerAuthUI();
      closeCustomerAuthModal();
      if (typeof showToast === "function") showToast("✅ เข้าสู่ระบบสำเร็จ", "success");
      else alert("✅ เข้าสู่ระบบสำเร็จ");
    }
  } catch (err) {
    if (errEl) errEl.textContent = "เกิดข้อผิดพลาด: " + (err.message || String(err));
  }
}

// 🆕 ออกจากระบบ — เรียก /api/customer/logout
async function customerLogout() {
  try {
    await fetch("/api/customer/logout", {
      method: "POST",
      credentials: "same-origin",
    });
  } catch (_) {}
  currentCustomer = null;
  saveCustomerToStorage(null); // 🆕 ลบจาก localStorage
  // 🆕 (T004-SEC-01): สั่ง SW ล้าง API cache หลัง logout
  //   กัน PII ของ user A ที่อาจถูก cache อยู่รั่วให้ user B (shared device + offline)
  try {
    if ("serviceWorker" in navigator && navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage("CLEAR_API_CACHE");
    }
  } catch (_) {}
  // 🆕 (T059): ล้าง IndexedDB cache หลัง logout — กัน PII รั่วข้าม customer (shared device)
  //   สำคัญมาก: ถ้าไม่ clear → user A logout → user B login → B อาจเห็น orders ของ A ใน IndexedDB
  try {
    if (window.IDB) await window.IDB.clearAll();
  } catch (_) {}
  syncCustomerAuthUI();
  if (typeof showToast === "function") showToast("ออกจากระบบแล้ว", "info");
  else alert("ออกจากระบบแล้ว");
}

// 🆕 escape HTML helper (กัน XSS)
// 🆕 (T013-R3): TODO: migrate to shared-utils.js in next refactor round
//   Helper ที่ซ้ำกับ shared-utils.js (สร้างใหม่ใน T013): escapeHtmlCustomer
//   (≈ escapeHtml ใน shared-utils.js — logic เดียวกัน ต่างแค่ชื่อ)
//   อย่าลบ helper เดิมทันที — migrate ทีละไฟล์ + test รอบละไฟล์เพื่อความปลอดภัย
//   ดู /shared-utils.js สำหรับ implementation ที่รวบรวมแล้ว
function escapeHtmlCustomer(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ============================================================
// 🆕 (2026-10-02 v6 — ฟีเจอร์ #2): รายการเพลงโปรด (Wishlist) — frontend helpers
//   - toggleFavorite(songId) → toggle ❤️ (เพิ่ม/ลบ)
//   - loadCustomerFavorites() → โหลดรายการโปรดในหน้าบัญชี
//   - checkFavoriteStatus(songId) → ตรวจสถานะ ❤️ ของเพลง (สำหรับแสดงปุ่ม active)
//   ผลกระทบระบบเดิม: 0% — ฟังก์ชันใหม่
// ============================================================

// 🆕 cache สถานะ favorites ของลูกค้าปัจจุบัน (song_id → true) เพื่อลด API calls
let customerFavoritesCache = new Set();

// 🆕 toggle favorite — เพิ่ม/ลบเพลงจากรายการโปรด
async function toggleFavorite(songId) {
  if (!songId) return;
  if (!isCustomerLoggedIn()) {
    if (typeof showToast === "function") showToast("กรุณาเข้าสู่ระบบเพื่อเพิ่มรายการโปรด", "info");
    else alert("กรุณาเข้าสู่ระบบเพื่อเพิ่มรายการโปรด");
    return;
  }
  const isFav = customerFavoritesCache.has(songId);
  try {
    const url = isFav ? `/api/customer/favorites/${encodeURIComponent(songId)}` : "/api/customer/favorites";
    const method = isFav ? "DELETE" : "POST";
    const body = isFav ? null : JSON.stringify({ song_id: songId });
    const res = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      credentials: "same-origin",
      body,
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      // อัปเดต cache
      if (isFav) customerFavoritesCache.delete(songId);
      else customerFavoritesCache.add(songId);
      // 🆕 (v7): favorites ใช้ bookmark icon แทน heart (เพราะ heart สำหรับถูกใจแล้ว)
      //   toggle ระหว่าง bookmark outline (ยังไม่โปรด) ↔ bookmark fill (เป็นโปรด)
      const bookmarkFill = '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>';
      const bookmarkOutline = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>';
      document.querySelectorAll(`[data-favorite-btn="${songId}"]`).forEach(btn => {
        if (isFav) {
          btn.classList.remove("is-favorite");
          btn.innerHTML = bookmarkOutline;
        } else {
          btn.classList.add("is-favorite");
          btn.innerHTML = bookmarkFill;
        }
      });
      if (typeof showToast === "function") showToast(isFav ? "ลบจากรายการโปรดแล้ว" : "📌 เพิ่มในรายการโปรดแล้ว", isFav ? "info" : "success");
    } else {
      if (typeof showToast === "function") showToast(data?.error || "ไม่สำเร็จ", "error");
    }
  } catch (err) {
    if (typeof showToast === "function") showToast("เกิดข้อผิดพลาด: " + (err.message || String(err)), "error");
  }
}

// 🆕 โหลดรายการโปรดทั้งหมด → แสดงในหน้าบัญชี + cache สถานะ
async function loadCustomerFavorites() {
  const wrap = document.getElementById("myAccountFavoritesList");
  if (!wrap) return;
  if (!isCustomerLoggedIn()) {
    wrap.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-dim);font-size:13px;">กรุณาเข้าสู่ระบบ</div>';
    return;
  }
  wrap.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-dim);font-size:13px;">⏳ กำลังโหลด...</div>';
  try {
    const res = await fetch("/api/customer/favorites", { credentials: "same-origin" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      wrap.innerHTML = `<div style="color:var(--danger);font-size:13px;padding:10px;">${escapeHtmlCustomer(data?.error || "โหลดไม่สำเร็จ")}</div>`;
      return;
    }
    const favorites = data.favorites || [];
    // อัปเดต cache
    customerFavoritesCache = new Set(favorites.map(f => f.song_id));
    if (favorites.length === 0) {
      wrap.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-dim);font-size:13px;">ยังไม่มีเพลงโปรด — กด ❤️ ในเพลงเพื่อเพิ่ม</div>';
      return;
    }
    // 🆕 (v6 fix): render เป็น song card สวยๆ เหมือนหน้ารายการเพลง (มี cover, ชื่อ, DJ, ราคา, ปุ่ม ❤️ ⭐ 🛒)
    //   ถ้าเพลงถูกลบ (song = null) → แสดงข้อความว่าเพลงถูกลบแล้ว + ปุ่มลบจากรายการโปรด
    wrap.innerHTML = favorites.map(f => {
      const s = f.song;
      if (!s) {
        // เพลงถูกลบจากระบบ → แสดงกล่องเตือน + ปุ่มลบจากรายการโปรด
        return `
          <div style="background:rgba(239,68,68,.05);border:1px solid rgba(239,68,68,.2);border-radius:8px;padding:10px;display:flex;align-items:center;gap:8px;">
            <div style="flex:1;min-width:0;font-size:13px;color:var(--danger);">⚠️ เพลงนี้ถูกลบจากระบบแล้ว</div>
            <button class="btn" data-fav-remove="${escapeHtmlCustomer(f.song_id)}" style="padding:6px 10px;font-size:12px;background:transparent;color:var(--danger);border:1px solid rgba(239,68,68,.3);border-radius:6px;cursor:pointer;">❌ ลบจากรายการ</button>
          </div>`;
      }
      // ใช้ escapeHtmlCustomer กัน XSS
      const songName = escapeHtmlCustomer(s.song_name || "ไม่มีชื่อ");
      const coverUrl = escapeHtmlCustomer(s.cover_url || "default-song-cover.svg");
      const djName = s.dj_name ? escapeHtmlCustomer(s.dj_name) : "";
      const artist = s.artist ? escapeHtmlCustomer(s.artist) : "";
      // คำนวณราคา (มี discount ใช้ discount)
      const price = Number(s.price || 0);
      const discountPrice = s.discount_price != null ? Number(s.discount_price) : null;
      const finalPrice = discountPrice != null && discountPrice > 0 && discountPrice < price ? discountPrice : price;
      const priceDisplay = finalPrice > 0 ? finalPrice.toLocaleString("th-TH") + " ₭" : "ฟรี";
      const originalPriceDisplay = (discountPrice != null && discountPrice > 0 && discountPrice < price) ? `<span style="text-decoration:line-through;color:var(--text-dim);font-size:11px;margin-right:4px;">${price.toLocaleString("th-TH")}₭</span>` : "";
      return `
        <div class="song-card song-card-row" data-id="${escapeHtmlCustomer(f.song_id)}" style="background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:10px;padding:10px;display:flex;gap:10px;align-items:center;">
          <div style="width:50px;height:50px;border-radius:6px;overflow:hidden;flex-shrink:0;">
            <img src="${coverUrl}" loading="lazy" alt="${songName}" onerror="this.src='default-song-cover.svg'" style="width:100%;height:100%;object-fit:cover;">
          </div>
          <div style="flex:1;min-width:0;">
            <div style="font-weight:600;font-size:13px;margin-bottom:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${songName}</div>
            <div style="font-size:11px;color:var(--text-dim);margin-bottom:4px;">
              ${djName ? `<span>🎧 ${djName}</span>` : ""}
              ${artist ? `${djName ? " · " : ""}<span>${artist}</span>` : ""}
            </div>
            <div style="font-size:12px;font-weight:600;color:var(--accent);">${originalPriceDisplay}${priceDisplay}</div>
          </div>
          <div style="display:flex;align-items:center;gap:6px;flex-shrink:0;">
            <button class="btn-icon-mini is-favorite" data-favorite-btn="${escapeHtmlCustomer(f.song_id)}" data-song-name="${songName}" aria-label="ลบจากรายการโปรด" title="ลบจากรายการโปรด"><svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg></button>
            <button class="btn-icon-mini" data-fav-buy="${escapeHtmlCustomer(f.song_id)}" aria-label="เพิ่มลงตะกร้า" title="เพิ่มลงตะกร้า"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M9 14v-3.5"/><circle cx="8" cy="14.5" r="1.5"/><path d="M14 13v-3.5"/><circle cx="13" cy="13.5" r="1.5"/></svg></button>
          </div>
        </div>`;
    }).join("");
    // ผูกปุ่ม ❤️ (ลบจากโปรด — เพราะในหน้านี้เพลงเป็นโปรดอยู่แล้ว)
    wrap.querySelectorAll("[data-favorite-btn]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const songId = btn.getAttribute("data-favorite-btn");
        await toggleFavorite(songId);
        loadCustomerFavorites(); // refresh
      });
    });
    // ผูกปุ่มลบ (สำหรับเพลงที่ถูกลบ)
    wrap.querySelectorAll("[data-fav-remove]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const songId = btn.getAttribute("data-fav-remove");
        await toggleFavorite(songId);
        loadCustomerFavorites();
      });
    });
    // ผูกปุ่มซื้อ (เรียก addToCart ถ้ามี)
    wrap.querySelectorAll("[data-fav-buy]").forEach(btn => {
      btn.addEventListener("click", () => {
        const songId = btn.getAttribute("data-fav-buy");
        if (typeof window.addToCart === "function") {
          // ดึงข้อมูลเพลงจาก STATE ถ้ามี ไม่งั้นใช้ song_id อย่างเดียว
          const song = (typeof window.findSong === "function") ? window.findSong(songId) : null;
          if (song) {
            window.addToCart(song);
          } else {
            // ไม่พบใน STATE (อาจเป็นเพลงที่ยังไม่ได้โหลด) → สร้าง minimal object
            window.addToCart({ id: songId, song_name: btn.closest("[data-id]")?.querySelector("[data-song-name]")?.getAttribute("data-song-name") || songId });
          }
          if (typeof showToast === "function") showToast("🛒 เพิ่มในตะกร้าแล้ว", "success");
        }
      });
    });
  } catch (err) {
    wrap.innerHTML = `<div style="color:var(--danger);font-size:13px;padding:10px;">โหลดไม่สำเร็จ: ${escapeHtmlCustomer(err.message || String(err))}</div>`;
  }
}

// 🆕 ตรวจสถานะ favorite ของเพลงเดียว (สำหรับแสดงปุ่ม ❤️ active)
async function checkFavoriteStatus(songId) {
  if (!isCustomerLoggedIn() || !songId) return false;
  // ถ้ามีใน cache → ใช้ cache (เร็วกว่า)
  if (customerFavoritesCache.has(songId)) return true;
  try {
    const res = await fetch(`/api/customer/favorites/check/${encodeURIComponent(songId)}`, { credentials: "same-origin" });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data?.is_favorite) {
      customerFavoritesCache.add(songId);
      return true;
    }
  } catch (_) {}
  return false;
}

// ============================================================
// 🆕 (2026-10-02 v7 — ฟีเจอร์ #12 ใหม่): ถูกใจเพลงแบบ TikTok — frontend helpers
//   - getAnonymousFingerprint() → สร้าง/ดึง fingerprint สำหรับ anonymous like
//   - toggleLike(songId) → toggle like (เพิ่ม/ลด) + อัปเดตจำนวน
//   - loadLikeStatus(songId) → ดึงจำนวน like + สถานะของลูกค้า
//   ผลกระทบระบบเดิม: 0% — ฟังก์ชันใหม่ (แทนที่ระบบรีวิวเดิม)
// ============================================================

// 🆕 (T053-M4): สร้าง fingerprint สำหรับ anonymous like แบบ stable ข้ามเครื่อง
//   เดิม: ใช้แค่ localStorage UUID → ลบ localStorage ได้ → like ซ้ำได้ (บวมเทียม)
//   ใหม่: ผสม IP hash (จาก server /api/fingerprint) + localStorage UUID
//     - ถ้าลบ localStorage → ยังมี IP hash อยู่ → like ซ้ำไม่ได้ (กันบวมเทียม)
//     - ถ้าเปลี่ยนเครื่อง/IP → IP hash เปลี่ยน → fingerprint เปลี่ยน → like ใหม่ (acceptable)
//   cache IP hash ใน sessionStorage (รอเฉพาะ tab ปัจจุบัน — กัน D1 reads เยอะ)
//   ผลกระทบระบบเดิม: 0% — ถ้า /api/fingerprint fail → fallback ใช้แค่ localStorage UUID (เหมือนเดิม)
let _cachedIpHash = null;
async function fetchIpHash() {
  if (_cachedIpHash !== null) return _cachedIpHash; // cache hit (อาจเป็น "" ถ้า fail)
  try {
    const res = await fetch("/api/fingerprint", { credentials: "same-origin" });
    const data = await res.json().catch(() => ({}));
    _cachedIpHash = data?.ip_hash || "";
  } catch (_) {
    _cachedIpHash = ""; // fallback: ไม่มี IP hash → ใช้แค่ localStorage UUID
  }
  return _cachedIpHash;
}

async function getAnonymousFingerprint() {
  const key = "miusic_anon_fingerprint";
  let fp = localStorage.getItem(key);
  if (!fp) {
    // สร้าง UUID สำหรับเครื่องนี้ (localStorage)
    fp = crypto.randomUUID() + "-" + Date.now();
    localStorage.setItem(key, fp);
  }
  // 🆕 (T053-M4): ผสม IP hash เข้าไป → กันลบ localStorage แล้ว like ซ้ำ
  const ipHash = await fetchIpHash();
  if (ipHash) {
    return fp + "-" + ipHash;
  }
  // fallback: ใช้แค่ localStorage UUID (เหมือนเดิม)
  return fp;
}

// 🆕 (T053-M4): sync version — สำหรับกรณีที่ไม่สามารถ await ได้ (เช่น loadLikeStatus เดิม)
//   ใช้ cached IP hash (ถ้ามี) หรือ fallback แค่ localStorage UUID
function getAnonymousFingerprintSync() {
  const key = "miusic_anon_fingerprint";
  let fp = localStorage.getItem(key);
  if (!fp) {
    fp = crypto.randomUUID() + "-" + Date.now();
    localStorage.setItem(key, fp);
  }
  if (_cachedIpHash) {
    return fp + "-" + _cachedIpHash;
  }
  return fp;
}

// 🆕 toggle like — เพิ่ม/ลด like ของเพลง + อัปเดตจำนวนใน UI
async function toggleLike(songId) {
  if (!songId) {
    console.warn("[like] toggleLike called with no songId");
    return;
  }
  // ถ้า login → ใช้ customer.id, ถ้าไม่ login → ใช้ fingerprint (anonymous like)
  // 🆕 (T053-M4): await getAnonymousFingerprint() ตอนนี้เป็น async (ดึง IP hash)
  const fingerprint = isCustomerLoggedIn() ? null : await getAnonymousFingerprint();
  try {
    const res = await fetch(`/api/songs/${encodeURIComponent(songId)}/like`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ fingerprint }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      const newCount = data.like_count || 0;
      const isLiked = data.is_liked;
      // อัปเดต UI ปุ่ม ❤️ ของเพลงนี้ทั้งหมด (อาจมีหลายจุดในหน้า)
      document.querySelectorAll(`[data-like-btn="${songId}"]`).forEach(btn => {
        if (isLiked) {
          btn.classList.add("is-liked");
        } else {
          btn.classList.remove("is-liked");
        }
        // อัปเดตจำนวน (อยู่ใน [data-like-count])
        const countEl = btn.querySelector("[data-like-count]");
        if (countEl) countEl.textContent = newCount;
      });
      if (typeof showToast === "function") showToast(isLiked ? "❤️ ถูกใจแล้ว" : "ยกเลิกถูกใจ", isLiked ? "success" : "info");
    } else {
      console.error("[like] error from server:", data);
      if (typeof showToast === "function") showToast(data?.error || "ไม่สำเร็จ", "error");
    }
  } catch (err) {
    console.error("[like] network/fetch error:", err);
    if (typeof showToast === "function") showToast("เกิดข้อผิดพลาด: " + (err.message || String(err)), "error");
  }
}

// 🆕 โหลดจำนวน like + สถานะของลูกค้า → แสดงในปุ่ม ❤️ ของเพลง
async function loadLikeStatus(songId) {
  if (!songId) return { like_count: 0, is_liked: false };
  // 🆕 (T053-M4): await getAnonymousFingerprint() ตอนนี้เป็น async
  //   แต่ loadLikeStatus อาจถูกเรียกบ่อย → ใช้ sync version + cached IP hash กัน D1 reads เยอะ
  //   ถ้า _cachedIpHash ยังเป็น null (ยังไม่ได้ fetch) → ใช้แค่ localStorage UUID (เหมือนเดิม)
  //   หลัง toggleLike ครั้งแรก → _cachedIpHash ถูก cache → loadLikeStatus จะใช้ IP hash
  const fingerprint = isCustomerLoggedIn() ? null : getAnonymousFingerprintSync();
  const query = fingerprint ? `?fingerprint=${encodeURIComponent(fingerprint)}` : "";
  try {
    const res = await fetch(`/api/songs/${encodeURIComponent(songId)}/likes${query}`, { credentials: "same-origin" });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      return { like_count: data.like_count || 0, is_liked: !!data.is_liked };
    } else {
      console.warn("[like] loadLikeStatus error:", data);
    }
  } catch (err) {
    console.warn("[like] loadLikeStatus fetch failed:", err);
  }
  return { like_count: 0, is_liked: false };
}

// 🆕 expose ให้ app-user.js / app-cart.js เรียกใช้
window.isCustomerLoggedIn = isCustomerLoggedIn;
window.getCurrentCustomer = getCurrentCustomer;
window.initCustomerAuth = initCustomerAuth;
// 🆕 (2026-10-03 team-fix): expose openCustomerAuthModal ให้ app-user.js เรียกจากปุ่ม "เข้าสู่ระบบ" ในแบนเนอร์
window.openCustomerAuthModal = openCustomerAuthModal;
// 🆕 (2026-10-02 v7): favorites + like
window.toggleFavorite = toggleFavorite;
window.loadCustomerFavorites = loadCustomerFavorites;
window.checkFavoriteStatus = checkFavoriteStatus;
window.toggleLike = toggleLike;
window.loadLikeStatus = loadLikeStatus;
window.getAnonymousFingerprint = getAnonymousFingerprint;
// 🔧 FIX: เดิมบรรทัดนี้เซ็ต window.showCustomerAccountView = null ทับค่าที่ app-user.js เซ็งไว้ (customer-auth.js โหลดทีหลัง)
//   ทำให้ปุ่มบัญชี/ดูออเดอร์ตอน login แล้วไม่ทำงาน → ตั้งเป็น null เฉพาะเมื่อยังไม่มีค่าเท่านั้น
if (typeof window.showCustomerAccountView !== "function") window.showCustomerAccountView = null;

// ============================================================
// 🆕 (2026-10-03 team-fix): __onOrderScopeChanged — รับ trigger จาก saveCustomerToStorage()
//   เมื่อ login state เปลี่ยน (guest→login, login→guest, สลับบัญชี):
//     1. ลบแบนเนอร์เชิญ login ออก (hideGuestOrdersLoginBanner)
//     2. ถ้ากำลังอยู่ใน tab "ออเดอร์" → re-route ไปยัง view ที่ถูกต้อง (account หรือ guest lookup)
//   ผลกระทบระบบเดิม: 0% — ฟังก์ชันนี้ถูกเรียกจาก customer-auth.js เอง (saveCustomerToStorage)
//   และเดิมไม่เคยมีการ assign ฟังก์ชันให้ตัวแปรนี้เลย (dead reference) — ตอนนี้เรา assign ให้ถูกต้อง
// ============================================================
window.__onOrderScopeChanged = function onOrderScopeChanged() {
  try {
    // 1. ลบแบนเนอร์เชิญ login ออกเสมอ (login แล้วก็ลบ, logout ก็ลบ — จะแสดงใหม่เฉพาะตอนเปิด tab ออเดอร์ตอนเป็น guest)
    if (typeof window.hideGuestOrdersLoginBanner === "function") window.hideGuestOrdersLoginBanner();
    // 2. ถ้ากำลังอยู่ใน tab "ออเดอร์" → คลิก tab นั้นใหม่เพื่อ re-route ไปยัง view ที่ถูกต้อง
    const activeTabBtn = document.querySelector(".bottom-nav button.active[data-tab='myorders']");
    if (activeTabBtn) {
      // ใช้ click() เพื่อ trigger handler ใน app-user.js ใหม่ — ง่ายและปลอดภัย (ไม่ต้องเรียกฟังก์ชันภายใน app-user.js โดยตรง)
      // ใส่ try/catch เผื่อ click handler พัง → ไม่กระทบ flow อื่น
      try { activeTabBtn.click(); } catch (err) { console.warn("[onOrderScopeChanged] re-click tab failed:", err?.message || err); }
    }
    // 3. refresh customer auth UI (ปุ่ม login / ชื่อลูกค้า ด้านบนขวา)
    syncCustomerAuthUI();
  } catch (err) {
    console.warn("[onOrderScopeChanged] failed:", err?.message || err);
  }
};

// 🆕 เรียก init ตอน page load (หลัง DOM ready)
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => initCustomerAuth());
} else {
  initCustomerAuth();
}

// 🆕 ผูก listeners ตอน page load
document.addEventListener("DOMContentLoaded", () => {
  // tab switching
  document.getElementById("customerAuthTabLogin")?.addEventListener("click", () => switchCustomerAuthTab("login"));
  document.getElementById("customerAuthTabRegister")?.addEventListener("click", () => switchCustomerAuthTab("register"));
  // ปุ่ม submit
  document.getElementById("customerAuthLoginBtn")?.addEventListener("click", customerLogin);
  document.getElementById("customerAuthRegisterBtn")?.addEventListener("click", customerRegister);
  // ปุ่มปิด modal
  document.getElementById("customerAuthClose")?.addEventListener("click", closeCustomerAuthModal);
  // กดพื้นหลัง modal → ปิด
  document.getElementById("customerAuthBackdrop")?.addEventListener("click", (e) => {
    if (e.target.id === "customerAuthBackdrop") closeCustomerAuthModal();
  });
  // Enter ในฟอร์ม login → submit
  document.getElementById("customerAuthPassword")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const activeTab = document.getElementById("customerAuthTabLogin")?.classList.contains("active") ? "login" : "register";
      if (activeTab === "login") customerLogin();
      else customerRegister();
    }
  });

  // 🆕 (2026-10-02 v2): ปุ่ม "ลืมรหัสผ่าน?" ใต้ช่อง login → เปิด modal ลืมรหัส
  document.getElementById("customerForgotPasswordLink")?.addEventListener("click", (e) => {
    e.preventDefault();
    openForgotPasswordModal();
  });
  // ปุ่มปิด modal ลืมรหัสผ่าน
  document.getElementById("forgotPasswordClose")?.addEventListener("click", closeForgotPasswordModal);
  // กดพื้นหลัง modal ลืมรหัส → ปิด
  document.getElementById("forgotPasswordBackdrop")?.addEventListener("click", (e) => {
    if (e.target.id === "forgotPasswordBackdrop") closeForgotPasswordModal();
  });
  // ปุ่ม submit ใน modal ลืมรหัส
  document.getElementById("forgotPasswordSubmitBtn")?.addEventListener("click", submitForgotPassword);
  // Enter ในช่อง forgot password → submit
  document.getElementById("forgotPasswordLogin")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitForgotPassword();
  });

  // 🆕 (T011-F4): password show/hide toggle — ปุ่ม 👁 ในช่อง password
  //   - ทำงานกับทั้ง 2 ช่อง (login: #customerAuthPassword + register: #customerAuthPasswordReg)
  //   - เนื่องจาก 2 ช่อง sync ค่าผ่าน oninput → toggle ต้อง sync type ด้วย
  //   - ปุ่มเปลี่ยน icon 👁 → 🙈 ตามสถานะ
  //   ผลกระทบระบบเดิม: 0% — เพิ่มปุ่มใหม่ ไม่แตะ input logic เดิม
  function togglePasswordVisibility(btnEl, inputEl) {
    if (!btnEl || !inputEl) return;
    if (inputEl.type === "password") {
      inputEl.type = "text";
      btnEl.textContent = "🙈";
      btnEl.setAttribute("aria-label", "ซ่อนรหัสผ่าน");
    } else {
      inputEl.type = "password";
      btnEl.textContent = "👁";
      btnEl.setAttribute("aria-label", "แสดงรหัสผ่าน");
    }
  }

  const passwordToggleBtn = document.getElementById("passwordToggleBtn");
  const passwordToggleBtnReg = document.getElementById("passwordToggleBtnReg");
  const passwordInputLogin = document.getElementById("customerAuthPassword");
  const passwordInputReg = document.getElementById("customerAuthPasswordReg");

  // toggle ในหน้า login — sync type ไปยัง register ด้วย (เพราะค่า sync ผ่าน oninput)
  passwordToggleBtn?.addEventListener("click", function () {
    togglePasswordVisibility(this, passwordInputLogin);
    if (passwordInputReg) passwordInputReg.type = passwordInputLogin.type;
    if (passwordToggleBtnReg) {
      passwordToggleBtnReg.textContent = this.textContent;
      passwordToggleBtnReg.setAttribute("aria-label", this.getAttribute("aria-label"));
    }
  });
  // toggle ในหน้า register — sync type ไปยัง login ด้วย
  passwordToggleBtnReg?.addEventListener("click", function () {
    togglePasswordVisibility(this, passwordInputReg);
    if (passwordInputLogin) passwordInputLogin.type = passwordInputReg.type;
    if (passwordToggleBtn) {
      passwordToggleBtn.textContent = this.textContent;
      passwordToggleBtn.setAttribute("aria-label", this.getAttribute("aria-label"));
    }
  });

  // 🆕 (T011-F4): complexity meter — แสดงความแข็งแรงของรหัสผ่านแบบ real-time
  //   - คำนวณ score จาก: ความยาว + มีตัวเลข + มีอักขระพิเศษ + มีตัวใหญ่/เล็กผสม
  //   - แสดง 3 ระดับ: weak (แดง) / medium (เหลือง) / strong (เขียว)
  //   - ซ่อนตอนเริ่มต้น แสดงเมื่อเริ่มพิมพ์
  //   ผลกระทบระบบเดิม: 0% — UI เสริม ไม่บล็อกการ register
  function calcPasswordStrength(password) {
    if (!password) return { level: "none", label: "กรอกรหัสผ่าน", score: 0 };
    let score = 0;
    if (password.length >= 6) score += 1;
    if (password.length >= 10) score += 1;
    if (/[0-9]/.test(password)) score += 1;
    if (/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)) score += 1;
    if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score += 1;
    if (score <= 1) return { level: "weak", label: "อ่อนแอ — ควรเพิ่มตัวเลข/อักขระพิเศษ", score };
    if (score <= 3) return { level: "medium", label: "ปานกลาง — พอใช้ได้", score };
    return { level: "strong", label: "แข็งแรง 👍", score };
  }

  function updateComplexityMeter(password) {
    const meter = document.getElementById("passwordComplexityMeter");
    const barFill = document.getElementById("complexityBarFill");
    const label = document.getElementById("complexityLabel");
    if (!meter || !label) return;
    if (!password) {
      meter.style.display = "none";
      meter.className = "password-complexity";
      return;
    }
    meter.style.display = "block";
    const { level, label: text } = calcPasswordStrength(password);
    meter.className = "password-complexity level-" + level;
    label.textContent = text;
    // barFill ไม่ต้อง set width ตรงนี่้ — CSS ของ level-* กำหนด width ให้
  }

  passwordInputReg?.addEventListener("input", function () {
    updateComplexityMeter(this.value);
  });
  // ซ่อน meter ตอนเริ่มต้น
  updateComplexityMeter("");
});

// ============================================================
// 🆕 (T057-PDPA): Account Settings Modal
//   - modal "ตั้งค่าบัญชี" สำหรับใช้สิทธิ์ PDPA 6 ข้อ
//   ผลกระทบระบบเดิม: 0% — UI ใหม่ ไม่แตะ login/register/favorites เดิม
// ============================================================

// 🆕 (T060-T061): เอา cookie consent banner ออกจากโค้ดเลย
//   - T057: เดิมแสดง banner ข้างล่างจอให้ลูกค้ากด "ยอมรับ" → ลูกค้าคิดว่าเว็บไม่น่าเชื่อถือ
//   - T060: เปลี่ยน function เป็น no-op
//   - T061: ลบ function + callers + window exposure ออกจากโค้ดเลย
//   - PDPA ยังครบ: ยังมี privacy.html + ลูกค้าใช้สิทธิ์ PDPA ได้ผ่าน modal "ตั้งค่าบัญชี" (ปุ่ม ⚙️)
//   - ถ้าจะเปิด banner ใหม่ในอนาคต → คืน code จาก git history (commit ก่อน T061)

// ---------- Account Settings Modal ----------
function openAccountSettingsModal() {
  // ลบ modal เดิมถ้ามี
  const existing = document.getElementById("accountSettingsBackdrop");
  if (existing) existing.remove();

  const backdrop = document.createElement("div");
  backdrop.id = "accountSettingsBackdrop";
  backdrop.className = "modal-backdrop";
  backdrop.style.cssText = "display:flex;align-items:center;justify-content:center;z-index:200;";
  backdrop.innerHTML = `
    <div class="modal" style="max-width:480px;max-height:90vh;overflow-y:auto;">
      <div class="modal-header">
        <h3>⚙️ ตั้งค่าบัญชี</h3>
        <button class="modal-close" id="accountSettingsClose" type="button" aria-label="ปิด">✕</button>
      </div>
      <div style="padding:16px;">

        <!-- Section: ข้อมูลบัญชี -->
        <div style="margin-bottom:20px;">
          <h4 style="margin:0 0 8px;font-size:14px;color:var(--accent,#8b5cf6);">ข้อมูลบัญชี</h4>
          <div style="background:var(--surface,#131722);border-radius:8px;padding:12px;font-size:13px;">
            <div style="margin-bottom:6px;">
              <strong style="color:var(--text-dim,#94a3b8);">ชื่อที่แสดง:</strong>
              <span id="accountSettingsDisplayName">${escapeHtmlCustomer(currentCustomer?.display_name || "-")}</span>
            </div>
            <div style="margin-bottom:6px;">
              <strong style="color:var(--text-dim,#94a3b8);">อีเมล:</strong>
              <span>${escapeHtmlCustomer(currentCustomer?.email || "-")}</span>
            </div>
            <div>
              <strong style="color:var(--text-dim,#94a3b8);">WhatsApp:</strong>
              <span>${escapeHtmlCustomer(currentCustomer?.whatsapp || "-")}</span>
            </div>
          </div>
        </div>

        <!-- Section: แก้ไขข้อมูล (สิทธิ์แก้ไข) -->
        <div style="margin-bottom:20px;">
          <h4 style="margin:0 0 8px;font-size:14px;color:var(--accent,#8b5cf6);">✏️ แก้ไขข้อมูล (สิทธิ์ PDPA มาตรา 35)</h4>
          <div class="field" style="margin-bottom:8px;">
            <label style="font-size:12px;color:var(--text-dim,#94a3b8);">ชื่อที่แสดง</label>
            <input id="accountSettingsEditName" type="text" placeholder="ชื่อใหม่"
              value="${escapeHtmlCustomer(currentCustomer?.display_name || "")}"
              style="width:100%;padding:8px 10px;border-radius:6px;border:1px solid var(--border,rgba(255,255,255,0.1));background:var(--surface,#131722);color:var(--text,#f8fafc);font-size:13px;">
          </div>
          <div class="field" style="margin-bottom:8px;">
            <label style="font-size:12px;color:var(--text-dim,#94a3b8);">เบอร์ WhatsApp</label>
            <input id="accountSettingsEditWhatsapp" type="tel" placeholder="เบอร์ใหม่"
              value="${escapeHtmlCustomer(currentCustomer?.whatsapp || "")}"
              style="width:100%;padding:8px 10px;border-radius:6px;border:1px solid var(--border,rgba(255,255,255,0.1));background:var(--surface,#131722);color:var(--text,#f8fafc);font-size:13px;">
          </div>
          <button type="button" id="accountSettingsSaveBtn" style="
            background: linear-gradient(135deg, var(--accent) 0%, var(--accent-2) 100%);
            color: white; border: none; padding: 8px 16px; border-radius: 9999px;
            font-weight: 600; font-size: 13px; cursor: pointer; width: 100%;
          ">บันทึกการแก้ไข</button>
          <div id="accountSettingsEditFeedback" style="font-size:12px;margin-top:6px;display:none;"></div>
        </div>

        <!-- Section: สิทธิ์ PDPA -->
        <div style="margin-bottom:20px;">
          <h4 style="margin:0 0 8px;font-size:14px;color:var(--accent,#8b5cf6);">📋 สิทธิ์ของคุณตาม PDPA</h4>

          <button type="button" id="accountSettingsExportBtn" style="
            display:flex;align-items:center;gap:8px;width:100%;
            background: var(--surface,#131722); color: var(--text,#f8fafc);
            border: 1px solid var(--border,rgba(255,255,255,0.1));
            padding: 10px 12px; border-radius: 8px;
            font-size: 13px; cursor: pointer; margin-bottom: 8px;
          ">
            <span>⬇️</span>
            <div style="flex:1;text-align:left;">
              <div style="font-weight:600;">Export ข้อมูลของฉัน</div>
              <div style="font-size:11px;color:var(--text-dim,#94a3b8);">ดาวน์โหลด JSON (สิทธิ์เข้าถึง + เคลื่อนย้าย)</div>
            </div>
          </button>

          <button type="button" id="accountSettingsConsentBtn" style="
            display:flex;align-items:center;gap:8px;width:100%;
            background: var(--surface,#131722); color: var(--text,#f8fafc);
            border: 1px solid var(--border,rgba(255,255,255,0.1));
            padding: 10px 12px; border-radius: 8px;
            font-size: 13px; cursor: pointer; margin-bottom: 8px;
          ">
            <span>✋</span>
            <div style="flex:1;text-align:left;">
              <div style="font-weight:600;">จัดการการยินยอม</div>
              <div style="font-size:11px;color:var(--text-dim,#94a3b8);">opt-out การรับข่าวสาร marketing</div>
            </div>
          </button>

          <button type="button" id="accountSettingsDeleteBtn" style="
            display:flex;align-items:center;gap:8px;width:100%;
            background: rgba(239, 68, 68, 0.08); color: var(--danger, #ef4444);
            border: 1px solid rgba(239, 68, 68, 0.3);
            padding: 10px 12px; border-radius: 8px;
            font-size: 13px; cursor: pointer;
          ">
            <span>🗑️</span>
            <div style="flex:1;text-align:left;">
              <div style="font-weight:600;">ลบบัญชี</div>
              <div style="font-size:11px;opacity:0.8;">soft delete + 30 วัน grace (สิทธิ์ลบ PDPA)</div>
            </div>
          </button>
          <div id="accountSettingsDeleteFeedback" style="font-size:12px;margin-top:6px;display:none;"></div>
        </div>

        <!-- Privacy Policy link -->
        <div style="text-align:center;font-size:12px;color:var(--text-dim,#94a3b8);">
          📜 <a href="/privacy.html" target="_blank" style="color:var(--accent,#8b5cf6);text-decoration:underline;">นโยบายความเป็นส่วนตัว</a>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(backdrop);

  // ปิด modal
  document.getElementById("accountSettingsClose")?.addEventListener("click", () => backdrop.remove());
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) backdrop.remove();
  });

  // บันทึกการแก้ไข
  document.getElementById("accountSettingsSaveBtn")?.addEventListener("click", async () => {
    const displayName = document.getElementById("accountSettingsEditName")?.value?.trim() || "";
    const whatsapp = document.getElementById("accountSettingsEditWhatsapp")?.value?.trim() || "";
    const feedback = document.getElementById("accountSettingsEditFeedback");
    const btn = document.getElementById("accountSettingsSaveBtn");
    if (feedback) { feedback.style.display = "block"; feedback.textContent = "กำลังบันทึก..."; feedback.style.color = "var(--text-dim,#94a3b8)"; }
    if (btn) { btn.disabled = true; btn.textContent = "กำลังบันทึก..."; }
    try {
      const res = await fetch("/api/customer/me", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ display_name: displayName, whatsapp }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data?.ok) {
        currentCustomer = data.customer;
        saveCustomerToStorage(data.customer);
        syncCustomerAuthUI();
        if (feedback) { feedback.textContent = "✅ บันทึกสำเร็จ"; feedback.style.color = "var(--success,#10b981)"; }
        // อัปเดตค่าใน modal
        document.getElementById("accountSettingsDisplayName").textContent = data.customer.display_name || "-";
        setTimeout(() => { if (feedback) feedback.style.display = "none"; }, 3000);
      } else {
        if (feedback) { feedback.textContent = "❌ " + (data?.error || "บันทึกไม่สำเร็จ"); feedback.style.color = "var(--danger,#ef4444)"; }
      }
    } catch (err) {
      if (feedback) { feedback.textContent = "❌ " + (err?.message || err); feedback.style.color = "var(--danger,#ef4444)"; }
    }
    if (btn) { btn.disabled = false; btn.textContent = "บันทึกการแก้ไข"; }
  });

  // Export ข้อมูล
  document.getElementById("accountSettingsExportBtn")?.addEventListener("click", async () => {
    try {
      const res = await fetch("/api/customer/me/export", { credentials: "same-origin" });
      if (!res.ok) throw new Error("export ไม่สำเร็จ");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `my-data-${(currentCustomer?.id || "export").slice(0, 8)}-${Date.now()}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      alert("✅ ดาวน์โหลดข้อมูลของคุณแล้ว (ไฟล์ JSON)");
    } catch (err) {
      alert("❌ export ไม่สำเร็จ: " + (err?.message || err));
    }
  });

  // จัดการ consent (marketing opt-out)
  document.getElementById("accountSettingsConsentBtn")?.addEventListener("click", async () => {
    // ดึงสถานะปัจจุบัน
    let currentOptOut = false;
    try {
      const res = await fetch("/api/customer/consent", { credentials: "same-origin" });
      const data = await res.json().catch(() => ({}));
      currentOptOut = !!data?.marketing_opt_out;
    } catch (_) {}
    const action = currentOptOut ? "accept" : "reject";
    const msg = currentOptOut
      ? "คุณเลือกปฏิเสธการรับข่าวสารอยู่แล้ว\n\nต้องการยินยอมรับข่าวสารอีกครั้งไหม?"
      : "คุณกำลังจะปฏิเสธการรับข่าวสาร marketing\n\n(คุณจะไม่ได้รับข้อความโปรโมชั่น แต่ยังได้รับการแจ้งเรื่องออเดอร์)\n\nยืนยัน?";
    if (!confirm(msg)) return;
    try {
      const res = await fetch("/api/customer/consent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ consent_type: "marketing", action }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data?.ok) {
        alert("✅ " + (data.message || "บันทึกแล้ว"));
      } else {
        alert("❌ " + (data?.error || "บันทึกไม่สำเร็จ"));
      }
    } catch (err) {
      alert("❌ " + (err?.message || err));
    }
  });

  // ลบบัญชี
  document.getElementById("accountSettingsDeleteBtn")?.addEventListener("click", async () => {
    const feedback = document.getElementById("accountSettingsDeleteFeedback");
    const confirmed1 = confirm("⚠️ คุณกำลังจะลบบัญชี\n\n• บัญชีจะถูกปิดทันที (login ไม่ได้)\n• ข้อมูลจะถูกลบถาวรหลัง 30 วัน\n• ระหว่าง 30 วัน สามารถติดต่อแอดมินขอกู้คืนได้\n\nต้องการดำเนินการต่อไหม?");
    if (!confirmed1) return;
    const password = prompt("กรุณาใส่รหัสผ่านเพื่อยืนยันการลบบัญชี:");
    if (!password) return;
    try {
      const res = await fetch("/api/customer/me", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ password }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data?.ok) {
        alert("✅ " + (data.message || "ลบบัญชีเรียบร้อย"));
        backdrop.remove();
        currentCustomer = null;
        saveCustomerToStorage(null);
        syncCustomerAuthUI();
        setTimeout(() => location.reload(), 1500);
      } else {
        if (feedback) { feedback.style.display = "block"; feedback.textContent = "❌ " + (data?.error || "ลบไม่สำเร็จ"); feedback.style.color = "var(--danger,#ef4444)"; }
        else alert("❌ " + (data?.error || "ลบไม่สำเร็จ"));
      }
    } catch (err) {
      if (feedback) { feedback.style.display = "block"; feedback.textContent = "❌ " + (err?.message || err); feedback.style.color = "var(--danger,#ef4444)"; }
      else alert("❌ " + (err?.message || err));
    }
  });
}

// 🆕 (T057): เพิ่มปุ่ม "ตั้งค่าบัญชี" ใน syncCustomerAuthUI (เข้าถึงผ่านปุ่ม👤 → เปลี่ยนเป็น modal ตั้งค่า)
//   แทนที่จะเปิดหน้า myOrdersView ให้เปิด modal ตั้งค่าบัญชีที่มี PDPA options
const _originalSyncCustomerAuthUI = syncCustomerAuthUI;
window.syncCustomerAuthUI = function() {
  _originalSyncCustomerAuthUI();
  // เพิ่มปุ่ม "ตั้งค่าบัญชี" ใต้ปุ่ม👤 (ถ้า login แล้ว)
  if (currentCustomer) {
    const btnArea = document.getElementById("customerAuthBtnArea");
    if (btnArea && !document.getElementById("accountSettingsBtn")) {
      const settingsBtn = document.createElement("button");
      settingsBtn.id = "accountSettingsBtn";
      settingsBtn.type = "button";
      settingsBtn.title = "ตั้งค่าบัญชี + PDPA";
      settingsBtn.setAttribute("aria-label", "ตั้งค่าบัญชี");
      settingsBtn.style.cssText = `
        background: transparent; border: 1px solid var(--border,rgba(255,255,255,0.1));
        color: var(--text-dim,#94a3b8); padding: 6px 8px; border-radius: 6px;
        cursor: pointer; font-size: 14px;
      `;
      settingsBtn.textContent = "⚙️";
      settingsBtn.addEventListener("click", () => openAccountSettingsModal());
      btnArea.appendChild(settingsBtn);
    }
  }
};

// 🆕 (T057): expose สำหรับเรียกจากภายนอก
window.openAccountSettingsModal = openAccountSettingsModal;

// ============================================================
// 🆕 (T058-PDPA-Phase2): Recover Account UI + Customer Login Flow
//   - เมื่อ customer login บัญชีที่ถูก soft delete → แสดง modal ยืนยันกู้คืน
//   - ปุ่ม "กู้คืนบัญชี" ที่หน้า login → เปิดหน้า recover โดยตรง
//   ผลกระทบระบบเดิม: 0% — UI ใหม่ ไม่แตะ login/register เดิม
// ============================================================

// ตรวจ customerLogin ที่มีอยู่ → ถ้า error เป็น "บัญชีถูกลบ" → เปิด modal recover
const _originalCustomerLogin = customerLogin;
window.customerLogin = async function() {
  const login = document.getElementById("customerAuthLogin")?.value?.trim() || "";
  const password = document.getElementById("customerAuthPassword")?.value || "";
  const errEl = document.getElementById("customerAuthError");
  if (errEl) errEl.textContent = "";
  if (!login || !password) {
    if (errEl) errEl.textContent = "กรุณากรอกอีเมล/เบอร์ WhatsApp และรหัสผ่าน";
    return;
  }
  try {
    const fingerprint = await getAnonymousFingerprint().catch(() => "");
    const res = await fetch("/api/customer/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ login, password, fingerprint }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data?.ok && data?.customer) {
      // login สำเร็จปกติ
      currentCustomer = data.customer;
      saveCustomerToStorage(data.customer);
      syncCustomerAuthUI();
      closeCustomerAuthModal();
      if (typeof showToast === "function") showToast("✅ เข้าสู่ระบบสำเร็จ", "success");
      else alert("✅ เข้าสู่ระบบสำเร็จ");
      return;
    }
    if (res.status === 401) {
      // 🆕 (T058): ลอง recover — อาจเป็นบัญชีที่ถูก soft delete
      const recovered = await tryRecoverAccount(login, password);
      if (recovered) return;
      if (errEl) errEl.textContent = data?.error || "อีเมล/เบอร์ WhatsApp หรือรหัสผ่านไม่ถูกต้อง";
      return;
    }
    if (errEl) errEl.textContent = data?.error || "เข้าสู่ระบบไม่สำเร็จ";
  } catch (err) {
    if (errEl) errEl.textContent = err?.message || "เข้าสู่ระบบไม่สำเร็จ";
  }
};

// 🆕 (T058): ลอง recover account — เรียก /api/customer/recover
async function tryRecoverAccount(login, password) {
  try {
    // step 1: ตรวจว่าบัญชีถูกลบไหม (ส่ง recover: false ก่อน)
    const checkRes = await fetch("/api/customer/recover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ login, password, recover: false }),
    });
    const checkData = await checkRes.json().catch(() => ({}));
    if (!checkRes.ok) return false; // ไม่ใช่บัญชีที่ถูกลบ → ล้มเหลวปกติ

    if (checkData.code !== "customer/recover-confirm-required") return false;

    // บัญชีถูกลบ + ยังอยู่ใน 30 วัน grace → แสดง modal ยืนยัน
    const confirmed = confirm(
      `⚠️ บัญชีนี้ถูกลบเมื่อ ${new Date(checkData.deleted_at).toLocaleDateString("th-TH")}\n\n` +
      `ชื่อ: ${checkData.customer?.display_name || "-"}\n` +
      `อีเมล: ${checkData.customer?.email || "-"}\n\n` +
      `เหลือเวลากู้คืนอีก ${checkData.days_remaining} วัน\n` +
      `หลังจากนั้นบัญชีจะถูกลบถาวร\n\n` +
      `ต้องการกู้คืนบัญชีนี้ไหม?`
    );
    if (!confirmed) return true; // ไม่กู้คืน → ไม่ throw error แค่ return (ไม่ show error)

    // step 2: ยืนยัน recover
    const recoverRes = await fetch("/api/customer/recover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ login, password, recover: true }),
    });
    const recoverData = await recoverRes.json().catch(() => ({}));
    if (recoverRes.ok && recoverData?.ok && recoverData?.customer) {
      currentCustomer = recoverData.customer;
      saveCustomerToStorage(recoverData.customer);
      syncCustomerAuthUI();
      closeCustomerAuthModal();
      if (typeof showToast === "function") showToast("✅ " + (recoverData.message || "กู้คืนบัญชีเรียบร้อย"), "success");
      else alert("✅ " + (recoverData.message || "กู้คืนบัญชีเรียบร้อย"));
      return true;
    }
    if (recoverData?.code === "customer/grace-expired") {
      alert("❌ บัญชีนี้หมดระยะเวลากู้คืนแล้ว (เกิน 30 วัน) — กรุณาติดต่อแอดมิน");
      return true;
    }
    alert("❌ " + (recoverData?.error || "กู้คืนไม่สำเร็จ"));
    return true;
  } catch (err) {
    console.warn("[recover] failed:", err?.message || err);
    return false;
  }
}

// 🆕 (T058): expose สำหรับเรียกจากภายนอก
window.tryRecoverAccount = tryRecoverAccount;
