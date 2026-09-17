// admin-roles.js — ระบบสิทธิ์แอดมิน: แอดมินหลัก vs แอดมินย่อย
// ===================================================
// เก็บรายชื่อแอดมินไว้ใน collection "admins" (document id = id บัญชีแอดมินของระบบยืนยันตัวตนใหม่ผ่าน Worker)
// - แอดมินหลัก (role: "main")  : เพิ่ม / ลบ / แก้ไข แอดมินคนอื่นได้ทั้งหมด
// - แอดมินย่อย (role: "sub")   : ใช้งานเมนูอื่นได้ปกติ (เพลง/หมวดหมู่/DJ/เพลย์ลิสต์/ออเดอร์/ตั้งค่า)
//                                 แต่จะไม่เห็นเมนู "จัดการแอดมิน" และจัดการแอดมินคนอื่นไม่ได้เลย
//
// บูตสแตรปครั้งแรก: ถ้ายังไม่มีเอกสารใน collection "admins" เลย (เช่น เพิ่งอัปเดตระบบนี้ครั้งแรก)
// บัญชีที่ล็อกอินสำเร็จคนแรกจะถูกตั้งเป็น "แอดมินหลัก" ให้อัตโนมัติ — จากนั้นบัญชีอื่นที่ไม่ได้อยู่ใน
// รายชื่อนี้จะเข้าใช้งานหน้า Admin ไม่ได้ จนกว่าแอดมินหลักจะเพิ่มให้ผ่านเมนู "จัดการแอดมิน"
import { db, auth } from "./firebase-init.js";
import {
  collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc
} from "./db-client.js";
import {
  getAuth, createUserWithEmailAndPassword, signOut
} from "./auth-client.js";
import {
  initializeApp, deleteApp
} from "./auth-client.js";

function escapeHtml(str) {
  return String(str == null ? "" : str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
// ใช้ toast/confirm modal ตัวเดียวกับหน้า admin หลัก (ผูกไว้ที่ window โดย app-admin.js)
// กันพังไว้ด้วย fallback เผื่อกรณีสคริปต์หลักยังโหลดไม่เสร็จ
function showToast(message, type) {
  if (window.__showToast) { window.__showToast(message, type); return; }
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = message;
  el.className = "toast show" + (type ? " " + type : "");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => { el.className = "toast"; }, 2600);
}
function openConfirm(text, onOk) {
  if (window.__openConfirm) { window.__openConfirm(text, onOk); return; }
  if (window.confirm(text)) onOk();
}
function isMainAdmin() { return window.__currentAdminRole === "main"; }

// ---------------- ตรวจสอบสิทธิ์ของบัญชีที่ล็อกอินอยู่ ----------------
// return { role: "main" | "sub" } ถ้าอนุญาตให้เข้าใช้งาน, หรือ null ถ้าไม่อนุญาต
//
// 🔒 Security (2026-09-17 P1): ลบ dead code ที่ auto-promote เป็น "main" admin
//   เดิม: ถ้า getDocs(collection(db,"admins")) คืน empty → auto-promote เป็น main admin
//   ปัญหา: ในระบบใหม่ (Worker + D1) login สำเร็จ = มี row ใน admin_users → snap.exists() จะ true เสมอ
//   แต่ถ้า D1 มีปัญหาชั่วคราว → getDocs อาจคืน empty → ทำให้ auto-promote ทำงาน → privilege escalation
//   แก้: ลบ auto-bootstrap path ออก → bootstrap ทำที่ Worker /api/auth/bootstrap เท่านั้น
export async function resolveCurrentAdminRole(user) {
  if (!user) return null;
  const ref = doc(db, "admins", user.uid);
  const snap = await getDoc(ref);
  if (snap.exists()) {
    const role = snap.data().role === "main" ? "main" : "sub";
    return { role };
  }
  // ไม่พบ role ของบัญชีนี้ → ไม่อนุญาต (null)
  // bootstrap admin คนแรกทำที่หน้า login → ปุ่ม "ตั้งค่าแอดมินคนแรก" → Worker /api/auth/bootstrap
  return null;
}

// ---------------- Manage Admins view ----------------
let ADMIN_CACHE = [];
let editingAdminId = null;
let listenersBound = false;

function roleBadge(role) {
  const isMain = role === "main";
  const bg = isMain ? "rgba(122,92,255,.15)" : "rgba(59,158,255,.15)";
  const color = isMain ? "var(--accent)" : "#3B9EFF";
  const label = isMain ? "👑 แอดมินหลัก" : "🙋 แอดมินย่อย";
  return `<span style="display:inline-flex;align-items:center;gap:4px;border-radius:999px;padding:3px 10px;font-size:12px;font-weight:700;width:fit-content;background:${bg};color:${color};">${label}</span>`;
}

async function loadAdmins() {
  const wrap = document.getElementById("adminList");
  if (wrap) wrap.innerHTML = '<div class="empty-state">กำลังโหลด...</div>';
  const snap = await getDocs(collection(db, "admins"));
  ADMIN_CACHE = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  renderAdminList();
}

function renderAdminList() {
  const wrap = document.getElementById("adminList");
  if (!wrap) return;
  const canManage = isMainAdmin();
  if (ADMIN_CACHE.length === 0) { wrap.innerHTML = '<div class="empty-state">ยังไม่มีแอดมิน</div>'; return; }
  const myUid = auth.currentUser ? auth.currentUser.uid : null;
  wrap.innerHTML = ADMIN_CACHE.map(a => `
    <div class="list-row">
      <div class="info">
        <div class="n1">${escapeHtml(a.display_name || a.email || "-")}${a.id === myUid ? ' <span style="color:var(--text-dim);font-size:12px;">(คุณ)</span>' : ""}</div>
        <div class="n2">${escapeHtml(a.email || "-")}</div>
        <div style="margin-top:4px;">${roleBadge(a.role)}</div>
      </div>
      ${canManage ? `<div class="row-actions">
        <button class="icon-btn" data-edit-admin="${a.id}">✎</button>
        <button class="icon-btn danger" data-del-admin="${a.id}">🗑</button>
      </div>` : ""}
    </div>`).join("");
  if (!canManage) return;
  wrap.querySelectorAll("[data-edit-admin]").forEach(b => b.addEventListener("click", () => openEditAdmin(b.getAttribute("data-edit-admin"))));
  wrap.querySelectorAll("[data-del-admin]").forEach(b => b.addEventListener("click", () => confirmDeleteAdmin(b.getAttribute("data-del-admin"))));
}

function resetAdminForm() {
  editingAdminId = null;
  document.getElementById("adminFormTitle").textContent = "เพิ่มแอดมิน";
  document.getElementById("fAdminEmail").value = "";
  document.getElementById("fAdminEmail").disabled = false;
  document.getElementById("fAdminPassword").value = "";
  document.getElementById("adminPasswordField").style.display = "block";
  document.getElementById("fAdminDisplayName").value = "";
  document.getElementById("fAdminRole").value = "sub";
  document.getElementById("adminFormNote").textContent = "";
}
function openAddAdmin() {
  if (!isMainAdmin()) { showToast("เฉพาะแอดมินหลักเท่านั้นที่เพิ่มแอดมินได้", "error"); return; }
  resetAdminForm();
  document.getElementById("adminFormBackdrop").classList.add("show");
}
function openEditAdmin(id) {
  if (!isMainAdmin()) return;
  const a = ADMIN_CACHE.find(x => x.id === id); if (!a) return;
  resetAdminForm();
  editingAdminId = id;
  document.getElementById("adminFormTitle").textContent = "แก้ไขแอดมิน";
  document.getElementById("fAdminEmail").value = a.email || "";
  document.getElementById("fAdminEmail").disabled = true; // เปลี่ยนอีเมลของบัญชีคนอื่นจากตรงนี้ไม่ได้ (ต้องให้แอดมินหลักลบบัญชีเดิมและสร้างใหม่)
  document.getElementById("adminPasswordField").style.display = "none"; // ตั้งรหัสผ่านให้คนอื่นจากตรงนี้ไม่ได้เช่นกัน
  document.getElementById("fAdminDisplayName").value = a.display_name || "";
  document.getElementById("fAdminRole").value = a.role === "main" ? "main" : "sub";
  document.getElementById("adminFormNote").textContent = "แก้ไขได้เฉพาะชื่อที่แสดงและระดับสิทธิ์ — เปลี่ยนอีเมล/รหัสผ่านของบัญชีคนอื่นไม่ได้จากตรงนี้ (ให้ลบบัญชีเดิมแล้วสร้างใหม่แทน)";
  document.getElementById("adminFormBackdrop").classList.add("show");
}

async function handleSaveAdmin() {
  if (!isMainAdmin()) { showToast("เฉพาะแอดมินหลักเท่านั้นที่จัดการแอดมินได้", "error"); return; }
  const email = document.getElementById("fAdminEmail").value.trim();
  const displayName = document.getElementById("fAdminDisplayName").value.trim();
  const role = document.getElementById("fAdminRole").value === "main" ? "main" : "sub";
  const btn = document.getElementById("adminSaveBtn");
  if (!email) { showToast("กรุณากรอกอีเมล", "error"); return; }

  btn.disabled = true; btn.textContent = "กำลังบันทึก...";
  try {
    if (editingAdminId) {
      // กันไม่ให้ลดสิทธิ์แอดมินหลักคนสุดท้ายจนไม่เหลือแอดมินหลักเลยในระบบ
      const target = ADMIN_CACHE.find(a => a.id === editingAdminId);
      const mainCount = ADMIN_CACHE.filter(a => a.role === "main").length;
      if (target && target.role === "main" && role !== "main" && mainCount <= 1) {
        showToast("ต้องมีแอดมินหลักอย่างน้อย 1 คนเสมอ — ตั้งแอดมินหลักคนอื่นก่อนถึงจะลดสิทธิ์คนนี้ได้", "error");
        btn.disabled = false; btn.textContent = "บันทึก";
        return;
      }
      await updateDoc(doc(db, "admins", editingAdminId), { display_name: displayName, role });
      showToast("บันทึกแล้ว", "success");
    } else {
      const password = document.getElementById("fAdminPassword").value;
      if (!password || password.length < 6) {
        showToast("รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร", "error");
        btn.disabled = false; btn.textContent = "บันทึก";
        return;
      }
      // 🔧 แก้บั๊ก (2026-09-17): เด้งออกหลังสร้างแอดมินใหม่
      // -----------------------------------------------------------
      // อาการก่อนแก้: กดบันทึกสร้างแอดมินใหม่ → สำเร็จ แต่ระบบเด้งออก (logout)
      //   แล้วโชว์ toast "บันทึกไม่สำเร็จ" ทั้งที่จริง ๆ บันทึกสำเร็จ
      //
      // สาเหตุ: โค้ดเดิมใช้รูปแบบ "secondary Firebase App" เพื่อสร้างบัญชีใหม่โดยไม่
      //   กระทบ session ปัจจุบัน — เป็น pattern ที่ใช้ตอนยังเป็น Firebase Auth จริง
      //   แต่หลังย้ายไประบบ Worker + cookie แล้ว:
      //     - getAuth() return singleton (auth-client.js:128-130) → ไม่มี "secondary auth" จริง
      //     - signOut() ใน auth-client.js:74-78 ไม่สนพารามิเตอร์ _auth → ยิง /api/auth/logout
      //       เสมอ → ลบ cookie ปัจจุบันทิ้ง → ทำให้แอดมินหลักถูก logout ทันที
      //     - พอ logout แล้ว loadAdmins() ที่ตามมาใช้ cookie ที่หายไป → 401 → catch
      //       → โชว์ toast "บันทึกไม่สำเร็จ" ทั้งที่จริง ๆ บันทึกสำเร็จแล้ว
      //
      // วิธีแก้: ลบ secondaryApp/secondaryAuth/signOut/deleteApp ออกทั้ง block
      //   เพราะ createUserWithEmailAndPassword() ในระบบใหม่ยิง endpoint /api/auth/create-admin
      //   ซึ่ง server ทำงานแยก session โดยสมบูรณ์ — ไม่แตะ cookie ปัจจุบันเลย
      //   (ดู auth-client.js:80-90 และ worker/index.js handleAuth "create-admin")
      //
      // ผลกระทบต่อระบบเดิม:
      //   ✅ สร้างแอดมินใหม่ได้ปกติ และไม่เด้งออก
      //   ✅ ไม่แตะ auth-client.js / worker / ระบบอื่น
      //   ⚠️ imports ของ initializeApp/getAuth/deleteApp/signOut ยังคงไว้ตามกฎ
      //      "ห้ามลบโค้ดเพียงเพราะคิดว่าไม่ได้ใช้งาน" — เผื่ออนาคตมี caller อื่น
      const cred = await createUserWithEmailAndPassword(auth, email, password);
      await setDoc(doc(db, "admins", cred.user.uid), {
        email,
        display_name: displayName || email.split("@")[0],
        role,
        created_at: new Date().toISOString(),
        created_by: auth.currentUser ? (auth.currentUser.email || "") : ""
      });
      showToast("สร้างแอดมินใหม่แล้ว", "success");
    }
    document.getElementById("adminFormBackdrop").classList.remove("show");
    await loadAdmins();
  } catch (err) {
    let msg = err && err.message ? err.message : String(err);
    if (err && err.code === "auth/email-already-in-use") msg = "อีเมลนี้มีบัญชีอยู่แล้วในระบบ";
    showToast("บันทึกไม่สำเร็จ: " + msg, "error");
  }
  btn.disabled = false; btn.textContent = "บันทึก";
}

function confirmDeleteAdmin(id) {
  if (!isMainAdmin()) return;
  const target = ADMIN_CACHE.find(a => a.id === id);
  if (!target) return;
  if (auth.currentUser && id === auth.currentUser.uid) {
    showToast("ไม่สามารถลบสิทธิ์ของบัญชีที่ล็อกอินอยู่ขณะนี้ได้", "error");
    return;
  }
  const mainCount = ADMIN_CACHE.filter(a => a.role === "main").length;
  if (target.role === "main" && mainCount <= 1) {
    showToast("ต้องมีแอดมินหลักอย่างน้อย 1 คนเสมอในระบบ", "error");
    return;
  }
  openConfirm(
    `ต้องการลบสิทธิ์แอดมินของ "${target.email || target.display_name}" หรือไม่? (จะลบสิทธิ์เข้าใช้งานหน้า Admin ทันที — บัญชีนี้จะถูกลบออกจากระบบทั้งหมด ไม่สามารถเข้าสู่ระบบได้อีก)`,
    async () => {
      await deleteDoc(doc(db, "admins", id));
      showToast("ลบสิทธิ์แอดมินแล้ว", "success");
      loadAdmins();
    }
  );
}

export function initAdminsView() {
  const addBtn = document.getElementById("addAdminBtn");
  if (addBtn) addBtn.style.display = isMainAdmin() ? "" : "none";
  loadAdmins();

  if (listenersBound) return;
  document.getElementById("addAdminBtn").addEventListener("click", openAddAdmin);
  document.getElementById("adminFormClose").addEventListener("click", () => document.getElementById("adminFormBackdrop").classList.remove("show"));
  document.getElementById("adminSaveBtn").addEventListener("click", handleSaveAdmin);
  listenersBound = true;
}
