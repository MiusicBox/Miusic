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
  try {
    if (customer) {
      localStorage.setItem(CUSTOMER_STORAGE_KEY, JSON.stringify(customer));
    } else {
      localStorage.removeItem(CUSTOMER_STORAGE_KEY);
    }
  } catch (_) {}
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
    const res = await fetch("/api/customer/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ login, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (errEl) errEl.textContent = data?.error || "เข้าสู่ระบบไม่สำเร็จ";
      return;
    }
    if (data?.ok && data?.customer) {
      currentCustomer = data.customer;
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
  syncCustomerAuthUI();
  if (typeof showToast === "function") showToast("ออกจากระบบแล้ว", "info");
  else alert("ออกจากระบบแล้ว");
}

// 🆕 escape HTML helper (กัน XSS)
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
      // อัปเดต UI ปุ่ม ❤️ ของเพลงนี้ทั้งหมด (อาจมีหลายจุดในหน้า)
      // 🆕 (v6 fix): ใช้ SVG icon แทน emoji + toggle class is-favorite (CSS จะเปลี่ยนสีให้)
      const heartSvg = '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>';
      document.querySelectorAll(`[data-favorite-btn="${songId}"]`).forEach(btn => {
        if (isFav) {
          btn.classList.remove("is-favorite");
          // ใช้ stroke (ว่าง) แทน fill (เต็ม)
          btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>';
        } else {
          btn.classList.add("is-favorite");
          // ใช้ fill (เต็มสีแดง)
          btn.innerHTML = heartSvg;
        }
      });
      if (typeof showToast === "function") showToast(isFav ? "ลบจากรายการโปรดแล้ว" : "❤️ เพิ่มในรายการโปรดแล้ว", isFav ? "info" : "success");
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
          <div style="display:flex;align-items:center;gap:4px;flex-shrink:0;">
            <button class="btn-icon-mini" data-favorite-btn="${escapeHtmlCustomer(f.song_id)}" data-song-name="${songName}" aria-label="ลบจากรายการโปรด" title="ลบจากรายการโปรด"><svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg></button>
            <button class="btn-icon-mini" data-review-btn="${escapeHtmlCustomer(f.song_id)}" data-song-name="${songName}" aria-label="รีวิวเพลง" title="รีวิวเพลง"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg></button>
            <button class="btn-icon-mini" data-fav-buy="${escapeHtmlCustomer(f.song_id)}" aria-label="เพิ่มลงตะกร้า" title="เพิ่มลงตะกร้า" style="background:linear-gradient(145deg, #4ade80 0%, #16a34a 50%, #14532d 100%);color:#fff;"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M9 14v-3.5"/><circle cx="8" cy="14.5" r="1.5"/><path d="M14 13v-3.5"/><circle cx="13" cy="13.5" r="1.5"/></svg></button>
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
    // ผูกปุ่ม ⭐ (เปิด modal รีวิว)
    wrap.querySelectorAll("[data-review-btn]").forEach(btn => {
      btn.addEventListener("click", () => {
        const songId = btn.getAttribute("data-review-btn");
        const songName = btn.getAttribute("data-song-name") || "";
        if (typeof openSongReviewModal === "function") openSongReviewModal(songId, songName);
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
// 🆕 (2026-10-02 v6 — ฟีเจอร์ #12): รีวิว + ให้คะแนนเพลง — frontend helpers
//   - openSongReviewModal(songId, songName) → เปิด modal เขียนรีวิว
//   - submitSongReview() → ส่งรีวิว (POST /api/customer/reviews)
//   - loadCustomerReviews() → โหลดรีวิวของลูกค้าในหน้าบัญชี
//   - deleteCustomerReview(songId) → ลบรีวิว
//   ผลกระทบระบบเดิม: 0% — ฟังก์ชันใหม่
// ============================================================
let currentReviewSongId = null;
let currentReviewSongName = null;

// 🆕 เปิด modal รีวิว
async function openSongReviewModal(songId, songName) {
  if (!isCustomerLoggedIn()) {
    if (typeof showToast === "function") showToast("กรุณาเข้าสู่ระบบเพื่อรีวิว", "info");
    else alert("กรุณาเข้าสู่ระบบเพื่อรีวิว");
    return;
  }
  currentReviewSongId = songId;
  currentReviewSongName = songName || "";
  // แสดง info เพลง
  const infoEl = document.getElementById("songReviewSongInfo");
  if (infoEl) infoEl.textContent = `เพลง: ${songName || songId}`;
  // reset form
  document.getElementById("songReviewRating").value = "0";
  document.getElementById("songReviewText").value = "";
  document.getElementById("songReviewResult").textContent = "";
  // reset ดาว
  document.querySelectorAll("#songReviewStars [data-star]").forEach(s => s.style.color = "rgba(255,255,255,.2)");
  // ตรวจว่าเคยรีวิวแล้ว → preload รีวิวเดิม
  try {
    const res = await fetch("/api/customer/reviews", { credentials: "same-origin" });
    if (res.ok) {
      const data = await res.json();
      const existing = (data.reviews || []).find(r => r.song_id === songId);
      if (existing) {
        document.getElementById("songReviewRating").value = String(existing.rating);
        document.getElementById("songReviewText").value = existing.review || "";
        // แสดงดาวที่เคยให้
        document.querySelectorAll("#songReviewStars [data-star]").forEach(s => {
          const star = Number(s.getAttribute("data-star"));
          s.style.color = star <= existing.rating ? "#F5B400" : "rgba(255,255,255,.2)";
        });
      }
    }
  } catch (_) {}
  // แสดง modal
  document.getElementById("songReviewBackdrop").style.display = "flex";
}

function closeSongReviewModal() {
  document.getElementById("songReviewBackdrop").style.display = "none";
  currentReviewSongId = null;
  currentReviewSongName = null;
}

// 🆕 ส่งรีวิว
async function submitSongReview() {
  if (!currentReviewSongId) return;
  const rating = Number(document.getElementById("songReviewRating").value || 0);
  const review = document.getElementById("songReviewText").value.trim();
  const resultEl = document.getElementById("songReviewResult");
  if (resultEl) resultEl.textContent = "";
  if (rating < 1 || rating > 5) {
    if (resultEl) { resultEl.textContent = "กรุณาเลือกคะแนน 1-5 ดาว"; resultEl.style.color = "var(--danger)"; }
    return;
  }
  const btn = document.getElementById("songReviewSubmitBtn");
  if (btn) { btn.disabled = true; btn.textContent = "กำลังส่ง..."; }
  try {
    const res = await fetch("/api/customer/reviews", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ song_id: currentReviewSongId, rating, review }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      if (resultEl) { resultEl.textContent = "✅ " + (data?.message || "ส่งรีวิวแล้ว"); resultEl.style.color = "var(--success)"; }
      if (typeof showToast === "function") showToast("✅ ส่งรีวิวแล้ว", "success");
      setTimeout(closeSongReviewModal, 1000);
    } else {
      if (resultEl) { resultEl.textContent = data?.error || "ส่งรีวิวไม่สำเร็จ"; resultEl.style.color = "var(--danger)"; }
      if (btn) { btn.disabled = false; btn.textContent = "ส่งรีวิว"; }
    }
  } catch (err) {
    if (resultEl) { resultEl.textContent = "เกิดข้อผิดพลาด: " + (err.message || String(err)); resultEl.style.color = "var(--danger)"; }
    if (btn) { btn.disabled = false; btn.textContent = "ส่งรีวิว"; }
  }
}

// 🆕 โหลดรีวิวของลูกค้า → หน้าบัญชี
async function loadCustomerReviews() {
  const wrap = document.getElementById("myAccountReviewsList");
  if (!wrap) return;
  if (!isCustomerLoggedIn()) {
    wrap.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-dim);font-size:13px;">กรุณาเข้าสู่ระบบ</div>';
    return;
  }
  wrap.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-dim);font-size:13px;">⏳ กำลังโหลด...</div>';
  try {
    const res = await fetch("/api/customer/reviews", { credentials: "same-origin" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      wrap.innerHTML = `<div style="color:var(--danger);font-size:13px;padding:10px;">${escapeHtmlCustomer(data?.error || "โหลดไม่สำเร็จ")}</div>`;
      return;
    }
    const reviews = data.reviews || [];
    if (reviews.length === 0) {
      wrap.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-dim);font-size:13px;">ยังไม่มีรีวิว — ซื้อเพลงแล้วรีวิวได้</div>';
      return;
    }
    // 🆕 (v6 fix): render พร้อมชื่อเพลง + cover (ถ้าเพลงถูกลบ → แสดง song_id แทน)
    wrap.innerHTML = reviews.map(r => {
      const stars = "★".repeat(r.rating) + "☆".repeat(5 - r.rating);
      const date = r.updated_at ? new Date(r.updated_at).toLocaleDateString("th-TH") : "-";
      const s = r.song;
      const songName = s ? escapeHtmlCustomer(s.song_name || "ไม่มีชื่อ") : `เพลง ID: ${escapeHtmlCustomer(r.song_id)}`;
      const coverUrl = s ? escapeHtmlCustomer(s.cover_url || "default-song-cover.svg") : "default-song-cover.svg";
      const djName = s && s.dj_name ? escapeHtmlCustomer(s.dj_name) : "";
      const artist = s && s.artist ? escapeHtmlCustomer(s.artist) : "";
      const deletedBadge = !s ? `<span style="color:var(--danger);font-size:11px;"> (ถูกลบแล้ว)</span>` : "";
      return `
        <div style="background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:8px;padding:10px;display:flex;gap:10px;align-items:flex-start;">
          <div style="width:40px;height:40px;border-radius:6px;overflow:hidden;flex-shrink:0;">
            <img src="${coverUrl}" loading="lazy" alt="${songName}" onerror="this.src='default-song-cover.svg'" style="width:100%;height:100%;object-fit:cover;">
          </div>
          <div style="flex:1;min-width:0;">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:4px;">
              <div style="font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${songName}${deletedBadge}</div>
              <span style="color:#F5B400;font-size:14px;flex-shrink:0;">${stars}</span>
            </div>
            ${(djName || artist) ? `<div style="font-size:11px;color:var(--text-dim);margin-bottom:4px;">${djName ? `🎧 ${djName}` : ""}${djName && artist ? " · " : ""}${artist ? artist : ""}</div>` : ""}
            ${r.review ? `<div style="font-size:12px;color:var(--text);margin-bottom:6px;line-height:1.4;">${escapeHtmlCustomer(r.review)}</div>` : ""}
            <div style="display:flex;justify-content:space-between;align-items:center;">
              <span style="font-size:11px;color:var(--text-dim);">${escapeHtmlCustomer(date)}</span>
              <div style="display:flex;gap:6px;">
                ${s ? `<button class="btn" data-review-edit="${escapeHtmlCustomer(r.song_id)}" data-song-name="${songName}" style="padding:4px 8px;font-size:11px;background:transparent;color:var(--accent);border:1px solid var(--accent);border-radius:4px;cursor:pointer;">✎ แก้ไข</button>` : ""}
                <button class="btn" data-review-delete="${escapeHtmlCustomer(r.song_id)}" style="padding:4px 8px;font-size:11px;background:transparent;color:var(--danger);border:1px solid rgba(239,68,68,.3);border-radius:4px;cursor:pointer;">🗑 ลบ</button>
              </div>
            </div>
          </div>
        </div>`;
    }).join("");
    // ผูกปุ่มแก้ไข
    wrap.querySelectorAll("[data-review-edit]").forEach(btn => {
      btn.addEventListener("click", () => {
        const songId = btn.getAttribute("data-review-edit");
        const songName = btn.getAttribute("data-song-name") || "";
        openSongReviewModal(songId, songName);
      });
    });
    // ผูกปุ่มลบ
    wrap.querySelectorAll("[data-review-delete]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const songId = btn.getAttribute("data-review-delete");
        if (!confirm("ต้องการลบรีวิวนี้ใช่ไหม?")) return;
        await deleteCustomerReview(songId);
        loadCustomerReviews();
      });
    });
  } catch (err) {
    wrap.innerHTML = `<div style="color:var(--danger);font-size:13px;padding:10px;">โหลดไม่สำเร็จ: ${escapeHtmlCustomer(err.message || String(err))}</div>`;
  }
}

// 🆕 ลบรีวิว
async function deleteCustomerReview(songId) {
  try {
    const res = await fetch(`/api/customer/reviews/${encodeURIComponent(songId)}`, {
      method: "DELETE",
      credentials: "same-origin",
    });
    if (res.ok) {
      if (typeof showToast === "function") showToast("ลบรีวิวแล้ว", "info");
    } else {
      const data = await res.json().catch(() => ({}));
      if (typeof showToast === "function") showToast(data?.error || "ลบไม่สำเร็จ", "error");
    }
  } catch (err) {
    if (typeof showToast === "function") showToast("ลบไม่สำเร็จ: " + (err.message || String(err)), "error");
  }
}

// 🆕 expose ให้ app-user.js / app-cart.js เรียกใช้
window.isCustomerLoggedIn = isCustomerLoggedIn;
window.getCurrentCustomer = getCurrentCustomer;
window.initCustomerAuth = initCustomerAuth;
// 🆕 (2026-10-02 v6): favorites + reviews
window.toggleFavorite = toggleFavorite;
window.loadCustomerFavorites = loadCustomerFavorites;
window.checkFavoriteStatus = checkFavoriteStatus;
window.openSongReviewModal = openSongReviewModal;
window.closeSongReviewModal = closeSongReviewModal;
window.submitSongReview = submitSongReview;
window.loadCustomerReviews = loadCustomerReviews;
window.deleteCustomerReview = deleteCustomerReview;
// 🔧 FIX: เดิมบรรทัดนี้เซ็ต window.showCustomerAccountView = null ทับค่าที่ app-user.js เซ็งไว้ (customer-auth.js โหลดทีหลัง)
//   ทำให้ปุ่มบัญชี/ดูออเดอร์ตอน login แล้วไม่ทำงาน → ตั้งเป็น null เฉพาะเมื่อยังไม่มีค่าเท่านั้น
if (typeof window.showCustomerAccountView !== "function") window.showCustomerAccountView = null;

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

  // 🆕 (2026-10-02 v6 — ฟีเจอร์ #12): listeners สำหรับ modal รีวิว
  // ปุ่มปิด modal รีวิว
  document.getElementById("songReviewClose")?.addEventListener("click", closeSongReviewModal);
  // กดพื้นหลัง modal รีวิว → ปิด
  document.getElementById("songReviewBackdrop")?.addEventListener("click", (e) => {
    if (e.target.id === "songReviewBackdrop") closeSongReviewModal();
  });
  // ปุ่ม submit รีวิว
  document.getElementById("songReviewSubmitBtn")?.addEventListener("click", submitSongReview);
  // คลิกดาว → เลือกคะแนน
  document.querySelectorAll("#songReviewStars [data-star]").forEach(star => {
    star.addEventListener("click", () => {
      const rating = Number(star.getAttribute("data-star"));
      document.getElementById("songReviewRating").value = String(rating);
      // อัปเดตสีดาว
      document.querySelectorAll("#songReviewStars [data-star]").forEach(s => {
        const sStar = Number(s.getAttribute("data-star"));
        s.style.color = sStar <= rating ? "#F5B400" : "rgba(255,255,255,.2)";
      });
    });
    // hover effect
    star.addEventListener("mouseenter", () => {
      const rating = Number(star.getAttribute("data-star"));
      document.querySelectorAll("#songReviewStars [data-star]").forEach(s => {
        const sStar = Number(s.getAttribute("data-star"));
        s.style.color = sStar <= rating ? "#F5B400" : "rgba(255,255,255,.2)";
      });
    });
  });
  document.getElementById("songReviewStars")?.addEventListener("mouseleave", () => {
    const rating = Number(document.getElementById("songReviewRating").value || 0);
    document.querySelectorAll("#songReviewStars [data-star]").forEach(s => {
      const sStar = Number(s.getAttribute("data-star"));
      s.style.color = sStar <= rating ? "#F5B400" : "rgba(255,255,255,.2)";
    });
  });
});
