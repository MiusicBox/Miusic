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
      // เปิดหน้า "ออเดอร์ของฉัน" (function ใน app-user.js)
      // 🔧 ใช้ window.* เพราะ app-user.js เป็น ES module (ฟังก์ชันอยู่ใน scope ของ module ไม่ใช่ global)
      if (typeof window.showCustomerAccountView === "function") window.showCustomerAccountView();
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

// 🆕 expose ให้ app-user.js / app-cart.js เรียกใช้
window.isCustomerLoggedIn = isCustomerLoggedIn;
window.getCurrentCustomer = getCurrentCustomer;
window.initCustomerAuth = initCustomerAuth;
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
});
