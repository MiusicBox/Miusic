// app-admin.js — หน้า Admin: Login (ระบบยืนยันตัวตนของเว็บเองผ่าน Worker) + CRUD (Cloudflare D1) + อัปโหลดไฟล์ (Cloudflare R2)
// ===================================================
import { db, auth, uploadToCloudinary } from "./firebase-init.js?v=20260905-fix1";
import { uploadFullSong, deleteFromStorage } from "./storage-adapter.js?v=20260904-rawzip";
import {
  collection, addDoc, updateDoc, deleteDoc, doc, getDocs, getDoc, setDoc
} from "./db-client.js";
import {
  signInWithEmailAndPassword, onAuthStateChanged, signOut,
  reauthenticateWithCredential, EmailAuthProvider, updatePassword,
  checkHasAdmin, bootstrapFirstAdmin
} from "./auth-client.js";
import { initOrdersView } from "./orders.js?v=20260905-fix1";
import { resolveCurrentAdminRole, initAdminsView } from "./admin-roles.js";
import {
  analyzeSongFile, analyzeSongUrl, recalculateFromManualBar, manualPreviewWindow, BAR_SECONDS
} from "./song-analyzer.js?v=20260908-previewrange1";
// ===== ลดราคา + โปรโมชั่น (ระบบใหม่ — รวมในไฟล์เดียว app-promotion.js) =====
import { initDiscountsView, initPromotionsView } from "./app-promotion.js?v=20261101-promo1";

const CACHE = { songs: [], categories: [], djs: [], playlists: [] };
let currentAdminRole = null; // "main" | "sub" — ของบัญชีที่ล็อกอินอยู่ตอนนี้
let editingSongId = null, editingCatId = null, editingDjId = null, editingPlaylistId = null;
let pendingSongFile = null, pendingCoverFile = null, pendingDjImageFile = null, existingDjImageUrl = "";
let pendingPlaylistCoverFile = null, existingPlaylistCoverUrl = "";
let pendingFullSongFile = null, existingFullFileUrl = "";
// ===== Auto Preview (Dance Section) — ไม่ตัดไฟล์ ไม่อัปโหลดไฟล์ใหม่ เก็บแค่วินาทีเริ่ม/จบ =====
// pendingPreviewData: ผลวิเคราะห์ล่าสุด (จากไฟล์ที่เพิ่งเลือก หรือจากการวิเคราะห์ใหม่/แก้มือ) รอบันทึกตอนกด "บันทึกเพลง"
let pendingPreviewData = null;
let confirmAction = null;
let songUploadSession = 0; // กันไม่ให้ progress ของการอัปโหลดรอบเก่า (ที่ถูกปิด/รีเซ็ตฟอร์มไปแล้ว) มาเขียนทับ UI ของฟอร์มใหม่
let songUploadController = null; // AbortController ของการอัปโหลดเพลงเดี่ยวที่กำลังทำงานอยู่ (ใช้กดยกเลิก)
let bulkUploadController = null; // AbortController ของการอัปโหลดแบบ Bulk ที่กำลังทำงานอยู่ (ใช้กดยกเลิก)

// จำกัดขนาดไฟล์เพลงเต็มสูงสุด (รองรับทั้ง .wav และ .mp3 — ปรับได้ตามแผน Cloudinary — ฟรีแพลนอัปโหลดสูงสุดไฟล์ละ 100MB)
const MAX_FULL_SONG_SIZE_MB = 100;
function formatFileSize(bytes) {
  if (!bytes && bytes !== 0) return "";
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}
function isAbortError(err) {
  return !!(err && err.name === "AbortError");
}

// ---------------- Auto Preview UI helpers (ไม่ตัดไฟล์ — เก็บแค่วินาทีเริ่ม/จบไว้เล่นฝั่ง user) ----------------
function formatSec(sec) {
  if (sec == null || !isFinite(sec)) return "-";
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return m + ":" + (s < 10 ? "0" : "") + s;
}
function showPreviewBox() { document.getElementById("previewAnalysisBox").style.display = "block"; }
function hidePreviewBox() { document.getElementById("previewAnalysisBox").style.display = "none"; }
function setPreviewBadge(text, color) {
  const el = document.getElementById("previewStatusBadge");
  el.textContent = text;
  el.style.background = color + "26"; // ~15% opacity
  el.style.color = color;
}
function renderPreviewData(data) {
  pendingPreviewData = data;
  showPreviewBox();
  const barField = document.getElementById("fDanceStartBar");
  const info = document.getElementById("previewInfoText");
  if (!data) {
    setPreviewBadge("ยังไม่ได้วิเคราะห์", "#9aa0aa");
    info.textContent = "";
    return;
  }
  if (data.status === "analyzing") {
    setPreviewBadge("⏳ กำลังวิเคราะห์...", "#3B9EFF");
    info.textContent = "กำลังวิเคราะห์ Beat/Energy/Onset ของไฟล์เพลง...";
    return;
  }
  if (data.status === "needs_review") {
    setPreviewBadge("⚠️ NEEDS_REVIEW", "#ff9f43");
    info.textContent = "ระบบหาช่วง Dance ที่มั่นใจไม่ได้ — กรุณากรอก Dance Start Bar เองแล้วกด \"แก้ไข / คำนวณ Preview ใหม่\"";
    if (data.dance_start_bar != null) barField.value = data.dance_start_bar;
    return;
  }
  // status === "ok"
  if (data.manual_window) {
    // ค่าที่แอดมินกำหนดช่วง Preview เองตรงๆ — ไม่ได้อิงสูตร Dance เลย
    setPreviewBadge("🎛 กำหนดเอง", "#3B9EFF");
    barField.value = data.dance_start_bar ?? "";
    // ใช้ null-check กันไว้ — ถ้า admin.html รุ่นที่ deploy จริงยังไม่มีช่องนี้ (เช่น deploy หลุดจังหวะ) จะไม่ทำให้สคริปต์ทั้งไฟล์พัง
    const sManualEl1 = document.getElementById("fPreviewStartBarManual");
    const eManualEl1 = document.getElementById("fPreviewEndBarManual");
    if (sManualEl1) sManualEl1.value = data.preview_start_bar;
    if (eManualEl1) eManualEl1.value = data.preview_end_bar;
    info.textContent =
      `Preview (กำหนดเอง): ${formatSec(data.preview_start_sec)} – ${formatSec(data.preview_end_sec)} ` +
      `(ห้อง ${data.preview_start_bar}–${data.preview_end_bar})`;
    return;
  }
  setPreviewBadge("✅ พร้อมใช้งาน", "#28c76f");
  barField.value = data.dance_start_bar;
  // เติมค่าห้องเริ่ม/ห้องหยุดปัจจุบันไว้ในช่อง "กำหนดเอง" ด้วย เผื่อแอดมินอยากปรับต่อจากค่านี้
  const sManualEl2 = document.getElementById("fPreviewStartBarManual");
  const eManualEl2 = document.getElementById("fPreviewEndBarManual");
  if (sManualEl2) sManualEl2.value = data.preview_start_bar ?? "";
  if (eManualEl2) eManualEl2.value = data.preview_end_bar ?? "";
  const confText = data.confidence != null ? ` (ความมั่นใจ ${(data.confidence * 100).toFixed(0)}%)` : " (แก้ไขเอง)";
  info.textContent =
    `Dance: ห้อง ${data.dance_start_bar}–${data.preview_end_bar}${confText} · ` +
    `Preview: ${formatSec(data.preview_start_sec)} – ${formatSec(data.preview_end_sec)} ` +
    `(ห้อง ${data.preview_start_bar}–${data.preview_end_bar})`;
}

// สร้าง/หา label แสดง "X MB / Y MB (Z%)" ต่อท้าย progress bar แบบไดนามิก (ไม่แก้ HTML เดิม)
// จัดชิดซ้าย ตามที่ผู้ใช้ขอ (เดิมชิดขวา)
function ensureProgressLabel(barId) {
  const bar = document.getElementById(barId);
  if (!bar) return null;
  let label = document.getElementById(barId + "Label");
  if (!label) {
    label = document.createElement("div");
    label.id = barId + "Label";
    label.style.cssText = "font-size:12px;color:#9aa0aa;margin-top:6px;text-align:left;";
    const track = bar.parentElement || bar;
    track.insertAdjacentElement("afterend", label);
  }
  return label;
}
// loadedBytes (ไม่บังคับ): ถ้ามีค่าจริงจาก xhr progress event จะใช้ค่านี้แทนการประมาณจาก pct
function updateProgressLabel(label, totalBytes, pct, loadedBytes) {
  if (!label) return;
  const uploaded = (loadedBytes != null) ? loadedBytes : (totalBytes || 0) * (pct || 0) / 100;
  label.textContent = `${formatFileSize(uploaded)} / ${formatFileSize(totalBytes)} (${Math.round(pct)}%)`;
}

// สร้าง/หาปุ่ม "ยกเลิกอัปโหลด" ต่อท้าย progress wrap แบบไดนามิก (ไม่แก้ HTML เดิม)
// onCancel จะถูกผูกใหม่ทุกครั้งที่เรียก เพราะแต่ละรอบอัปโหลดมี AbortController คนละตัว
function ensureCancelButton(wrapId, onCancel) {
  const wrap = document.getElementById(wrapId);
  if (!wrap) return null;
  let btn = document.getElementById(wrapId + "CancelBtn");
  if (!btn) {
    btn = document.createElement("button");
    btn.id = wrapId + "CancelBtn";
    btn.type = "button";
    btn.textContent = "✕ ยกเลิกอัปโหลด";
    btn.style.cssText = "margin-top:6px;padding:6px 14px;font-size:12px;border-radius:8px;border:1px solid #ff5a5a;background:transparent;color:#ff5a5a;cursor:pointer;display:block;text-align:left;";
    wrap.insertAdjacentElement("afterend", btn);
  }
  btn.onclick = onCancel;
  btn.style.display = "inline-block";
  return btn;
}
function hideCancelButton(wrapId) {
  const btn = document.getElementById(wrapId + "CancelBtn");
  if (btn) btn.style.display = "none";
}

function showToast(message, type) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.className = "toast show" + (type ? " " + type : "");
  clearTimeout(showToast._t);
  // 🔧 (2026-09-16): กำหนดเวลา auto-hide ตาม type
  // - "progress"      : ไม่ auto-hide (ใช้ตอนสร้าง ZIP — ต้องการให้ผู้ใช้เห็นความคืบหน้าตลอดจนกว่าจะเสร็จ)
  // - "success_long" : 4 วิ (สำเร็จงานยาว เช่น สร้าง ZIP เสร็จ ให้ผู้ใช้ทันเห็น)
  // - "error_long"    : 6 วิ (ล้มเหลวงานยาว เช่น สร้าง ZIP ล้มเหลว ให้ผู้ใช้อ่าน error ทัน)
  // - อื่นๆ (success/error/info/"") : 2.6 วิ (ค่าเริ่มต้นเดิม — ไม่แตะ behavior เดิม)
  if (type === "progress") {
    return; // ไม่ตั้ง timeout → ค้างจนกว่าจะมี showToast ครั้งถัดไป
  }
  let duration = 2600;
  if (type === "success_long") duration = 4000;
  else if (type === "error_long") duration = 6000;
  showToast._t = setTimeout(() => { el.className = "toast"; }, duration);
}
function escapeHtml(str) {
  return String(str == null ? "" : str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function formatPrice(v) { return Number(v || 0).toLocaleString("en-US") + " LAK"; }
function debounce(fn, wait) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), wait); }; }

// ---------------- ดึงชื่อเพลงจากชื่อไฟล์ ----------------
// ตัดแค่นามสกุลไฟล์ออก (.mp3 / .wav ฯลฯ) ส่วนที่เหลือคงไว้ทุกตัวอักษรเหมือนชื่อไฟล์เดิม
function nameFromFile(fileName) {
  return String(fileName || "").replace(/\.[^/.]+$/, "").trim();
}

function withTimeout(promise, milliseconds, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), milliseconds);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ---------------- Auth ----------------
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    showLogin();
    return;
  }
  try {
    await showAdmin();
  } catch (err) {
    document.getElementById("loginError").textContent =
      "เปิดหน้า Admin ไม่สำเร็จ: " + (err.message || err) + " — ตรวจสอบอินเทอร์เน็ตและการเชื่อมต่อเซิร์ฟเวอร์";
    showLogin();
    await signOut(auth).catch(() => {});
  }
});

// ================= เพิ่มใหม่ (2026-09-11): โหมด "ตั้งค่าแอดมินคนแรก" =================
// แทนที่ขั้นตอนสร้างบัญชีผ่าน Firebase Console เดิม — เช็คตอนโหลดหน้าว่ามีแอดมินในระบบหรือยัง
// ถ้ายังไม่มีเลย จะสลับหน้าจอ Login เป็นฟอร์มตั้งค่าแอดมินหลักคนแรกแทน (ไม่กระทบหน้าตา/พฤติกรรม
// การ login ปกติของระบบเดิมเลยเมื่อมีแอดมินอยู่แล้ว)
let LOGIN_BOOTSTRAP_MODE = false;
(async () => {
  try {
    const hasAdmin = await checkHasAdmin();
    if (!hasAdmin) {
      LOGIN_BOOTSTRAP_MODE = true;
      document.getElementById("loginTitle").textContent = "ตั้งค่าแอดมินคนแรก";
      document.getElementById("loginSubtitle").textContent = "ยังไม่มีแอดมินในระบบ — สร้างบัญชีแอดมินหลักคนแรกที่นี่";
      document.getElementById("loginDisplayNameField").style.display = "block";
      document.getElementById("loginBtn").textContent = "สร้างแอดมินคนแรก";
    }
  } catch (err) {
    console.error("checkHasAdmin error:", err); // เช็คไม่สำเร็จ -> ปล่อยเป็นโหมด login ปกติ (ปลอดภัยกว่า)
  }
})();

document.getElementById("loginBtn").addEventListener("click", async () => {
  const email = document.getElementById("loginEmail").value.trim();
  const password = document.getElementById("loginPassword").value;
  const btn = document.getElementById("loginBtn");
  document.getElementById("loginError").textContent = "";
  btn.disabled = true; btn.textContent = LOGIN_BOOTSTRAP_MODE ? "กำลังสร้างแอดมิน..." : "กำลังเข้าสู่ระบบ...";
  try {
    if (LOGIN_BOOTSTRAP_MODE) {
      const displayName = document.getElementById("loginDisplayName").value.trim();
      await bootstrapFirstAdmin(email, password, displayName);
    } else {
      await withTimeout(
        signInWithEmailAndPassword(auth, email, password),
        15000,
        "เชื่อมต่อระบบยืนยันตัวตนนานเกินไป"
      );
    }
    // onAuthStateChanged จะเรียก showAdmin() ต่อเอง (รวมถึงเช็คสิทธิ์แอดมิน) — รอสักครู่แล้วคืนปุ่มกลับ
  } catch (err) {
    document.getElementById("loginError").textContent =
      err?.code === "auth/invalid-credential"
        ? "อีเมลหรือรหัสผ่านไม่ถูกต้อง"
        : (LOGIN_BOOTSTRAP_MODE ? "สร้างแอดมินไม่สำเร็จ: " : "เข้าสู่ระบบไม่สำเร็จ: ") + (err.message || err);
  }
  btn.disabled = false; btn.textContent = LOGIN_BOOTSTRAP_MODE ? "สร้างแอดมินคนแรก" : "เข้าสู่ระบบ";
});
document.getElementById("logoutBtn").addEventListener("click", () => signOut(auth));

// ================= เปลี่ยนรหัสผ่านของฉัน (ทุกแอดมินทำได้ ไม่จำกัดเฉพาะแอดมินหลัก) =================
function resetChangePasswordForm() {
  document.getElementById("cpCurrentPassword").value = "";
  document.getElementById("cpNewPassword").value = "";
  document.getElementById("cpConfirmPassword").value = "";
  document.getElementById("cpFeedback").textContent = "";
}
document.getElementById("changePasswordBtn").addEventListener("click", () => {
  resetChangePasswordForm();
  document.getElementById("changePasswordBackdrop").classList.add("show");
});
document.getElementById("changePasswordClose").addEventListener("click", () => {
  document.getElementById("changePasswordBackdrop").classList.remove("show");
});
document.getElementById("changePasswordSaveBtn").addEventListener("click", async function () {
  const feedback = document.getElementById("cpFeedback");
  const currentPassword = document.getElementById("cpCurrentPassword").value;
  const newPassword = document.getElementById("cpNewPassword").value;
  const confirmPassword = document.getElementById("cpConfirmPassword").value;
  feedback.style.color = "var(--danger)";

  if (!currentPassword || !newPassword || !confirmPassword) { feedback.textContent = "กรุณากรอกให้ครบทุกช่อง"; return; }
  if (newPassword.length < 6) { feedback.textContent = "รหัสผ่านใหม่ต้องมีอย่างน้อย 6 ตัวอักษร"; return; }
  if (newPassword !== confirmPassword) { feedback.textContent = "ยืนยันรหัสผ่านใหม่ไม่ตรงกัน"; return; }

  const btn = this; btn.disabled = true; btn.textContent = "กำลังบันทึก...";
  feedback.textContent = "";
  try {
    const user = auth.currentUser;
    // Firebase บังคับให้ล็อกอินสดๆ ก่อนเปลี่ยนรหัสผ่าน (sensitive operation) จึงต้อง reauthenticate ด้วยรหัสผ่านเดิมก่อนเสมอ
    const credential = EmailAuthProvider.credential(user.email, currentPassword);
    await reauthenticateWithCredential(user, credential);
    await updatePassword(user, newPassword);
    feedback.style.color = "var(--success)";
    feedback.textContent = "เปลี่ยนรหัสผ่านสำเร็จแล้ว ✓";
    showToast("เปลี่ยนรหัสผ่านสำเร็จ", "success");
    setTimeout(() => { document.getElementById("changePasswordBackdrop").classList.remove("show"); }, 1000);
  } catch (err) {
    if (err && err.code === "auth/wrong-password") feedback.textContent = "รหัสผ่านปัจจุบันไม่ถูกต้อง";
    else if (err && err.code === "auth/too-many-requests") feedback.textContent = "ลองผิดหลายครั้งเกินไป กรุณารอสักครู่แล้วลองใหม่";
    else feedback.textContent = "เปลี่ยนรหัสผ่านไม่สำเร็จ: " + (err.message || err);
  }
  btn.disabled = false; btn.textContent = "บันทึกรหัสผ่านใหม่";
});

function showLogin() { document.getElementById("loginScreen").style.display = "flex"; document.getElementById("adminShell").style.display = "none"; }
async function showAdmin() {
  // ตรวจสอบสิทธิ์แอดมินของบัญชีนี้ก่อนปล่อยเข้าใช้งาน (บูตสแตรปแอดมินหลักคนแรกอัตโนมัติถ้ายังไม่เคยตั้งค่าระบบแอดมินเลย)
  let roleInfo;
  try {
    roleInfo = await withTimeout(
      resolveCurrentAdminRole(auth.currentUser),
      15000,
      "ตรวจสอบสิทธิ์ Admin นานเกินไป"
    );
  } catch (err) {
    // ส่วนใหญ่เกิดจากปัญหาการเชื่อมต่อเซิร์ฟเวอร์หรือฐานข้อมูล D1 ยังไม่พร้อม
    document.getElementById("loginError").textContent =
      "ตรวจสอบสิทธิ์แอดมินไม่สำเร็จ: " + (err.message || err) + " — ถ้าเพิ่งเพิ่มระบบจัดการแอดมิน ให้ตรวจสอบว่ามีแอดมินหลักในระบบแล้วและฐานข้อมูลพร้อมใช้งาน";
    await signOut(auth);
    return;
  }
  if (!roleInfo) {
    document.getElementById("loginError").textContent = "บัญชีนี้ไม่มีสิทธิ์เข้าใช้งานระบบ Admin กรุณาติดต่อแอดมินหลักเพื่อเพิ่มบัญชีให้ก่อน";
    await signOut(auth);
    return;
  }
  currentAdminRole = roleInfo.role;
  window.__currentAdminRole = currentAdminRole;

  document.getElementById("loginScreen").style.display = "none";
  document.getElementById("adminShell").style.display = "block";
  document.getElementById("qaManageAdmins").style.display = currentAdminRole === "main" ? "" : "none";
  const s = await withTimeout(
    getDoc(doc(db, "settings", "main")),
    15000,
    "โหลดการตั้งค่าเว็บไซต์นานเกินไป"
  );
  if (s.exists()) document.getElementById("adminSiteName").textContent = s.data().website_name || "Music Store";
  await withTimeout(loadDashboard(), 20000, "โหลดข้อมูล Dashboard นานเกินไป");
  // 🔧 (2026-09-16): อัปเดต badge ออเดอร์ "รอตรวจสอบการโอน" หลัง login (loadDashboard ก็เรียกอยู่แล้ว แต่ใส่ซ้ำเผื่อ clear)
  updateOrdersBadge();
}

// ---------------- View switching ----------------
function showView(id) {
  document.querySelectorAll(".view").forEach(v => v.style.display = "none");
  document.getElementById(id).style.display = "block";
}
document.querySelectorAll(".back-btn").forEach(b => b.addEventListener("click", () => { showView("view-dashboard"); loadDashboard(); }));
document.getElementById("qaAddSong").addEventListener("click", async () => { showView("view-songs"); await loadSongs(); openAddSong(); });
document.getElementById("qaManageSongs").addEventListener("click", () => { showView("view-songs"); loadSongs(); });
document.getElementById("qaManageCats").addEventListener("click", () => { showView("view-categories"); loadCategories(); });
document.getElementById("qaManageDjs").addEventListener("click", () => { showView("view-djs"); loadDjs(); });
document.getElementById("qaManagePlaylists").addEventListener("click", () => { showView("view-playlists"); loadPlaylists(); });
document.getElementById("qaBulkUpload").addEventListener("click", () => { openBulkUpload(); });
document.getElementById("qaOrders").addEventListener("click", () => { showView("view-orders"); initOrdersView(); });
document.getElementById("qaSettings").addEventListener("click", () => { showView("view-settings"); loadSettings(); });
document.getElementById("qaManageAdmins").addEventListener("click", () => {
  if (currentAdminRole !== "main") { showToast("เฉพาะแอดมินหลักเท่านั้นที่เข้าหน้านี้ได้", "error"); return; }
  showView("view-admins"); initAdminsView();
});
// ===== ลดราคา + โปรโมชั่น (ใช้ได้ทั้งแอดมินหลัก + แอดมินย่อย ตามที่ผู้ใช้ระบุ) =====
document.getElementById("qaDiscounts").addEventListener("click", () => {
  showView("view-discounts"); initDiscountsView();
});
document.getElementById("qaPromotions").addEventListener("click", () => {
  showView("view-promotions"); initPromotionsView();
});

async function loadDashboard() {
  const [songsSnap, catSnap, djSnap, playlistSnap] = await Promise.all([
    getDocs(collection(db, "songs")), getDocs(collection(db, "categories")), getDocs(collection(db, "djs")), getDocs(collection(db, "playlists"))
  ]);
  document.getElementById("statSongs").textContent = songsSnap.size;
  document.getElementById("statCats").textContent = catSnap.size;
  document.getElementById("statDjs").textContent = djSnap.size;
  document.getElementById("statPlaylists").textContent = playlistSnap.size;
  // 🔧 (2026-09-16): อัปเดต badge ออเดอร์ "รอตรวจสอบการโอน" ทุกครั้งที่กลับหน้า dashboard
  updateOrdersBadge();
}

// 🔧 (2026-09-16): อัปเดต badge จำนวนออเดอร์ "รอตรวจสอบการโอน" บนปุ่มเมนู "🧾 จัดการออเดอร์"
// นับเฉพาะ status === "pending_verify" → แสดง badge ตามระดับสี:
//   - 1-2 = เหลือง (warn) — ปกติ
//   - 3-5 = ส้ม (alert) — เริ่มเยอะ
//   - 6+ = แดง (critical) — เยอะมาก ต้องรีบดู
//   - 0 = ซ่อน badge
//
// รับ optional `orders` array — ถ้าส่งมา จะใช้ตรงๆ ไม่ query DB ซ้ำ (ประหยัด Cloudflare D1 quota)
// ถ้าไม่ส่ง → จะ query ใหม่ (ใช้ตอน login ครั้งแรก ก่อน state.allOrders จะถูกโหลด)
// ฟังก์ชันนี้ถูก expose ผ่าน window.__updateOrdersBadge ให้ orders.js เรียกได้หลังเปลี่ยนสถานะ/สร้าง/ลบออเดอร์
async function updateOrdersBadge(orders) {
  const badgeEl = document.getElementById("ordersBadge");
  if (!badgeEl) return;
  try {
    let ordersList = orders;
    if (!ordersList) {
      // ไม่ได้ส่ง orders มา → query เอง (กรณี login ครั้งแรก หรือกลับหน้า dashboard)
      const snap = await getDocs(collection(db, "orders"));
      ordersList = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    }
    // นับเฉพาะออเดอร์ที่ status === "pending_verify"
    const count = (ordersList || []).filter(o => String(o?.status || "") === "pending_verify").length;
    // ลบ class ระดับสีเดิมออกก่อน แล้วค่อยตั้งใหม่ตามจำนวน
    badgeEl.classList.remove("warn", "alert", "critical", "show");
    if (count > 0) {
      badgeEl.textContent = String(count);
      if (count <= 2) badgeEl.classList.add("warn");
      else if (count <= 5) badgeEl.classList.add("alert");
      else badgeEl.classList.add("critical");
      badgeEl.classList.add("show");
    }
    // count === 0 → badge ซ่อนไว้ (ไม่มี class "show" → display: none โดย default)
  } catch (err) {
    // ไม่ throw — badge พังไม่ควรทำให้ flow หลักพัง
    console.warn("updateOrdersBadge error:", err?.message || String(err));
  }
}
// Expose ให้ orders.js เรียกได้ (เหมือน window.__showToast pattern ที่มีอยู่แล้ว)
window.__updateOrdersBadge = updateOrdersBadge;

// ================= SONGS =================
let songSelectMode = false;
const selectedSongIds = new Set();
let currentSongListView = [];

async function loadSongs() {
  const [songsSnap, catSnap, djSnap, playlistSnap] = await Promise.all([
    getDocs(collection(db, "songs")), getDocs(collection(db, "categories")), getDocs(collection(db, "djs")), getDocs(collection(db, "playlists"))
  ]);
  CACHE.songs = songsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  CACHE.categories = catSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  CACHE.djs = djSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  CACHE.playlists = playlistSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  populateSelect("fCategory", CACHE.categories, "id", "category_name");
  populateSelect("fDj", CACHE.djs, "id", "dj_name");
  populateSelect("fPlaylist", CACHE.playlists, "id", "playlist_name");
  selectedSongIds.clear();
  updateSongBulkBar();
  renderSongList(CACHE.songs);
}

// 🔧 (2026-09-16): Helper สำหรับตรวจเพลงซ้ำใน CACHE.songs
// ปัญหา: เดิมแอดมินอัปเพลงเดี่ยว/bulk upload ไม่มีการตรวจเพลงซ้ำ → อัปเพลงชื่อเดียวกัน 2 ครั้งได้
// → เพลงซ้ำในระบบ ลูกค้าสับสน, พื้นที่ R2 สิ้นเปลือง, ตะกร้าออเดอร์อาจเพี้ยน
// Helper นี้ค้น CACHE.songs (loaded ตอน loadSongs() แล้ว) หาเพลงที่ชื่อตรงกัน (case-insensitive, trim)
// รับ: songName (ชื่อเพลงที่จะตรวจ), excludeSongId (id ของเพลงที่กำลังแก้ไข เพื่อไม่เช็คตัวเอง)
// คืน: array ของ { id, song_name, dj_name, created_at } ของเพลงที่ซ้ำ
function findDuplicateSongsByName(songName, excludeSongId) {
  const normalized = String(songName || "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!normalized) return [];
  return (CACHE.songs || [])
    .filter(s => s.id !== excludeSongId)
    .filter(s => String(s.song_name || "").trim().toLowerCase().replace(/\s+/g, " ") === normalized);
}
function populateSelect(id, items, valueKey, labelKey) {
  const sel = document.getElementById(id);
  const current = sel.value;
  sel.innerHTML = '<option value="">— ไม่ระบุ —</option>' + items.map(it => `<option value="${it[valueKey]}">${escapeHtml(it[labelKey])}</option>`).join("");
  sel.value = current;
}
function renderSongList(list) {
  currentSongListView = list;
  const wrap = document.getElementById("songList");
  if (list.length === 0) { wrap.innerHTML = '<div class="empty-state">ยังไม่มีเพลง</div>'; return; }
  wrap.innerHTML = list.map(s => `
    <div class="list-row" data-song-row="${s.id}" style="cursor:pointer;">
      ${songSelectMode ? `<input type="checkbox" class="song-select-chk" data-id="${s.id}" ${selectedSongIds.has(s.id) ? "checked" : ""} style="width:20px;height:20px;flex-shrink:0;">` : ""}
      <img src="${s.cover_url || ""}">
      <div class="info"><div class="n1">${escapeHtml(s.song_name)}</div>
      <div class="n2">${escapeHtml(s.dj_name || "-")} · ${escapeHtml(s.category_name || "-")} · ${formatPrice(s.price)}</div>
      ${!s.full_file_url && !s.file_url ? `<div class="n2" style="color:var(--danger);">⚠️ ยังไม่มีไฟล์เต็ม (WAV) บน Cloud</div>` : ""}
      ${!s.full_file_url && s.file_url ? `<div class="n2" style="color:var(--text-dim);">🔗 ใช้ไฟล์ร่วม (file_url = full_file_url)</div>` : ""}</div>
      <div class="row-actions">
        <button class="icon-btn" data-menu="${s.id}" title="เมนู">⋮</button>
      </div>
    </div>`).join("");
  wrap.querySelectorAll("[data-menu]").forEach(b => b.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleSongRowMenu(b, b.getAttribute("data-menu"));
  }));
  // ===== เพิ่มใหม่ (additive): แตะที่ตัวแถวเพลง → เปิด popup รายละเอียด =====
  // ไม่กระทบปุ่ม ⋮ (มี stopPropagation ด้านบน) และไม่กระทบ checkbox ในโหมดเลือกหลายเพลง
  wrap.querySelectorAll("[data-song-row]").forEach(row => {
    row.addEventListener("click", (e) => {
      // ถ้าอยู่ในโหมดเลือกหลายเพลง หรือแตะที่ checkbox / ปุ่มเมนู ไม่เปิด popup
      if (songSelectMode) return;
      if (e.target.closest(".song-select-chk")) return;
      if (e.target.closest("[data-menu]")) return;
      const id = row.getAttribute("data-song-row");
      if (id) openSongDetailPopup(id);
    });
  });
  wrap.querySelectorAll(".song-select-chk").forEach(chk => chk.addEventListener("change", () => {
    const id = chk.getAttribute("data-id");
    if (chk.checked) selectedSongIds.add(id); else selectedSongIds.delete(id);
    updateSongBulkBar();
  }));
}

// เมนูดรอปดาวน์ ⋮ แบบใช้ element ตัวเดียวร่วมกันทุกแถว (ไม่สร้างซ้ำในแต่ละแถว) — แก้ปัญหาปุ่ม 📌✎🗑
// เรียงกัน 3 ปุ่มแล้วบังชื่อเพลงบนจอแคบ โดยยังเรียกฟังก์ชันเดิม (openQuickAssign/openEditSong/confirmDeleteSong) ทุกอย่างเหมือนเดิม
let openSongMenuId = null;
function toggleSongRowMenu(btn, songId) {
  const menu = document.getElementById("songRowMenu");
  if (openSongMenuId === songId && menu.style.display !== "none") {
    hideSongRowMenu();
    return;
  }
  openSongMenuId = songId;
  const rect = btn.getBoundingClientRect();
  menu.style.display = "block";
  // จัดตำแหน่งให้อยู่ใต้ปุ่ม ⋮ ที่กด ชิดขวาจอ กันล้นขอบจอฝั่งขวา และเผื่อกรณีใกล้ขอบล่างจอให้เด้งขึ้นด้านบนแทน
  const menuWidth = menu.offsetWidth || 200;
  let left = rect.right - menuWidth;
  if (left < 8) left = 8;
  menu.style.left = left + "px";
  const menuHeight = menu.offsetHeight || 150;
  let top = rect.bottom + 6;
  if (top + menuHeight > window.innerHeight - 8) top = rect.top - menuHeight - 6;
  menu.style.top = top + "px";
}
function hideSongRowMenu() {
  document.getElementById("songRowMenu").style.display = "none";
  openSongMenuId = null;
}
document.addEventListener("click", (e) => {
  const menu = document.getElementById("songRowMenu");
  if (menu.style.display !== "none" && !menu.contains(e.target)) hideSongRowMenu();
});
window.addEventListener("scroll", hideSongRowMenu, true);
document.getElementById("songRowMenuAssign").addEventListener("click", () => {
  const id = openSongMenuId; hideSongRowMenu();
  if (id) openQuickAssign(id);
});
document.getElementById("songRowMenuEdit").addEventListener("click", () => {
  const id = openSongMenuId; hideSongRowMenu();
  if (id) openEditSong(id);
});
document.getElementById("songRowMenuDelete").addEventListener("click", () => {
  const id = openSongMenuId; hideSongRowMenu();
  if (id) confirmDeleteSong(id);
});

// ================= จัดเพลงเข้าเพลย์ลิสต์ / หมวดหมู่ / DJ แบบเร็ว (ไม่ต้องเปิดฟอร์มแก้ไขเพลงเต็ม) =================
let quickAssignSongId = null;
function openQuickAssign(id) {
  const s = CACHE.songs.find(x => x.id === id);
  if (!s) return;
  quickAssignSongId = id;
  document.getElementById("quickAssignSongName").textContent = s.song_name;
  // ใช้ populateSelect ตัวเดิม (options ชุดเดียวกับฟอร์มแก้ไขเพลง) — คงพฤติกรรม/ชื่อ field เดิมทุกจุด
  populateSelect("qaDj", CACHE.djs, "id", "dj_name");
  populateSelect("qaCategory", CACHE.categories, "id", "category_name");
  populateSelect("qaPlaylist", CACHE.playlists, "id", "playlist_name");
  // DJ ผูกด้วยชื่อในระบบเดิม (song.dj_name ไม่มี dj_id) จึงต้อง match ด้วยชื่อเหมือน openEditSong
  const dj = CACHE.djs.find(d => d.dj_name === s.dj_name);
  document.getElementById("qaDj").value = dj ? dj.id : "";
  document.getElementById("qaCategory").value = s.category_id || "";
  document.getElementById("qaPlaylist").value = s.playlist_id || "";
  document.getElementById("quickAssignBackdrop").classList.add("show");
}
document.getElementById("quickAssignClose").addEventListener("click", () => {
  document.getElementById("quickAssignBackdrop").classList.remove("show");
  quickAssignSongId = null;
});
document.getElementById("quickAssignSaveBtn").addEventListener("click", async function () {
  if (!quickAssignSongId) return;
  const btn = this; btn.disabled = true; btn.textContent = "กำลังบันทึก...";
  try {
    const djSel = document.getElementById("qaDj");
    const catSel = document.getElementById("qaCategory");
    const plSel = document.getElementById("qaPlaylist");
    const payload = {
      dj_name: djSel.value ? djSel.options[djSel.selectedIndex].text : "",
      category_id: catSel.value,
      category_name: catSel.value ? catSel.options[catSel.selectedIndex].text : "",
      playlist_id: plSel.value,
      playlist_name: plSel.value ? plSel.options[plSel.selectedIndex].text : "",
      updated_at: new Date().toISOString()
    };
    await updateDoc(doc(db, "songs", quickAssignSongId), payload);
    const song = CACHE.songs.find(x => x.id === quickAssignSongId);
    if (song) Object.assign(song, payload);
    showToast("จัดเพลงเข้ารายการแล้ว", "success");
    document.getElementById("quickAssignBackdrop").classList.remove("show");
    quickAssignSongId = null;
    renderSongList(currentSongListView);
  } catch (err) {
    showToast("บันทึกไม่สำเร็จ: " + err.message, "error");
  }
  btn.disabled = false; btn.textContent = "บันทึก";
});

function updateSongBulkBar() {
  document.getElementById("songSelectedCount").textContent = `เลือกแล้ว ${selectedSongIds.size} เพลง`;
  document.getElementById("songBulkDeleteBtn").disabled = selectedSongIds.size === 0;
  const allSelected = currentSongListView.length > 0 && currentSongListView.every(s => selectedSongIds.has(s.id));
  document.getElementById("songSelectAllChk").checked = allSelected;
}

document.getElementById("songSelectModeBtn").addEventListener("click", () => {
  songSelectMode = !songSelectMode;
  selectedSongIds.clear();
  document.getElementById("songBulkBar").style.display = songSelectMode ? "flex" : "none";
  document.getElementById("songSelectModeBtn").style.background = songSelectMode ? "var(--accent)" : "";
  document.getElementById("songSelectModeBtn").style.color = songSelectMode ? "#fff" : "";
  updateSongBulkBar();
  renderSongList(currentSongListView);
});
document.getElementById("songSelectAllChk").addEventListener("change", (e) => {
  if (e.target.checked) currentSongListView.forEach(s => selectedSongIds.add(s.id));
  else selectedSongIds.clear();
  updateSongBulkBar();
  renderSongList(currentSongListView);
});
document.getElementById("songBulkDeleteBtn").addEventListener("click", () => {
  const ids = Array.from(selectedSongIds);
  if (ids.length === 0) return;
  openConfirm(`ต้องการลบเพลงที่เลือกไว้ ${ids.length} เพลงหรือไม่? (เพลงที่มี Order เก่าอยู่แล้วจะถูกปิดการขายแทนการลบ เพื่อไม่ให้ไฟล์เต็มหาย)`, async () => {
    let deletedCount = 0, hiddenCount = 0;
    for (const id of ids) {
      const hasOrders = await songHasOrders(id);
      if (hasOrders) {
        await updateDoc(doc(db, "songs", id), { status: "hidden", updated_at: new Date().toISOString() });
        hiddenCount++;
      } else {
        const songSnap = await getDoc(doc(db, "songs", id));
        const songData = songSnap.exists() ? songSnap.data() : null;
        await deleteDoc(doc(db, "songs", id));
        // ลบไฟล์ cloud แบบ background เช่นเดียวกับ confirmDeleteSong (logic เดียวกันทุกประการ)
        deleteSongFilesFromStorage(songData);
        deletedCount++;
      }
    }
    selectedSongIds.clear();
    songSelectMode = false;
    document.getElementById("songBulkBar").style.display = "none";
    document.getElementById("songSelectModeBtn").style.background = "";
    document.getElementById("songSelectModeBtn").style.color = "";
    showToast(`ลบแล้ว ${deletedCount} เพลง${hiddenCount > 0 ? ` · ปิดการขาย ${hiddenCount} เพลง (มี Order เก่า)` : ""}`, "success");
    loadSongs();
    loadDashboard();
  });
});

// ฟังก์ชันกรองและแสดงผลรายการเพลง
const handleSongSearch = (e) => {
  const q = e.target.value.trim().toLowerCase();
  renderSongList(CACHE.songs.filter(s => [s.song_name, s.artist, s.dj_name, s.category_name].join(" ").toLowerCase().includes(q)));
};

const searchInputEl = document.getElementById("songSearch");
searchInputEl.addEventListener("input", debounce(handleSongSearch, 200));

// เพิ่มการดักจับปุ่ม Enter และลูกศร เพื่อซ่อนแป้นพิมพ์บนมือถือ
searchInputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === "ArrowDown" || e.key === "ArrowUp") {
    searchInputEl.blur(); // สั่งปิดแป้นพิมพ์
  }
});

function resetSongForm() {
  songUploadSession++; // ยกเลิก progress callback ของรอบอัปโหลดก่อนหน้า (ถ้ายังค้างอยู่เบื้องหลัง)
  editingSongId = null; pendingSongFile = null; pendingCoverFile = null;
  pendingFullSongFile = null; existingFullFileUrl = "";
  pendingPreviewData = null;
  document.getElementById("fDanceStartBar").value = "";
  const sManualElReset = document.getElementById("fPreviewStartBarManual");
  const eManualElReset = document.getElementById("fPreviewEndBarManual");
  if (sManualElReset) sManualElReset.value = "";
  if (eManualElReset) eManualElReset.value = "";
  hidePreviewBox();
  document.getElementById("songFormTitle").textContent = "เพิ่มเพลง";
  ["fSongName", "fArtist", "fPrice", "fDesc"].forEach(id => document.getElementById(id).value = "");
  document.getElementById("fDj").value = ""; document.getElementById("fCategory").value = ""; document.getElementById("fStatus").value = "active";
  document.getElementById("fPlaylist").value = "";
  document.getElementById("songFileInput").value = ""; document.getElementById("coverFileInput").value = "";
  document.getElementById("songFilePicker").textContent = "📁 แตะเพื่อเลือกไฟล์เพลงจาก iPhone/iPad";
  document.getElementById("songFilePicker").className = "file-picker";
  document.getElementById("coverFilePicker").textContent = "🖼️ แตะเพื่อเลือกรูปปก";
  document.getElementById("coverFilePicker").className = "file-picker";
  document.getElementById("fullSongFileInput").value = "";
  // 🔒 ข้อความ placeholder ปรับให้ตรงกับที่รองรับจริง (WAV/MP3) — ไม่กระทบ logic ใดๆ
  document.getElementById("fullSongFilePicker").textContent = "🔒 แตะเพื่อเลือกไฟล์เพลงเต็ม (WAV/MP3)";
  document.getElementById("fullSongFilePicker").className = "file-picker";
  document.getElementById("fullSongFileMeta").style.display = "none";
  document.getElementById("fullSongFileMeta").textContent = "";
  document.getElementById("fullSongUploadProgressWrap").style.display = "none";
  document.getElementById("songUploadProgressWrap").style.display = "none";
  const songLbl = document.getElementById("songUploadProgressLabel");
  if (songLbl) songLbl.textContent = "";
  const fullLbl = document.getElementById("fullSongUploadProgressLabel");
  if (fullLbl) fullLbl.textContent = "";
  hideCancelButton("songUploadProgressWrap");
  hideCancelButton("fullSongUploadProgressWrap");
  if (songUploadController) { songUploadController.abort(); songUploadController = null; } // เผื่อยังมีอัปโหลดค้างจากรอบก่อนหน้า ให้ยกเลิกจริงไปด้วยเลย
}
function openAddSong() { resetSongForm(); document.getElementById("songFormBackdrop").classList.add("show"); }
function openEditSong(id) {
  resetSongForm();
  const s = CACHE.songs.find(x => x.id === id);
  if (!s) return;
  editingSongId = id;
  document.getElementById("songFormTitle").textContent = "แก้ไขเพลง";
  document.getElementById("fSongName").value = s.song_name || "";
  document.getElementById("fArtist").value = s.artist || "";
  document.getElementById("fPrice").value = s.price || 0;
  document.getElementById("fDesc").value = s.description || "";
  document.getElementById("fStatus").value = s.status || "active";
  const dj = CACHE.djs.find(d => d.dj_name === s.dj_name);
  document.getElementById("fDj").value = dj ? dj.id : "";
  document.getElementById("fCategory").value = s.category_id || "";
  document.getElementById("fPlaylist").value = s.playlist_id || "";
  if (s.file_url) { document.getElementById("songFilePicker").textContent = "✔ มีไฟล์เพลงอยู่แล้ว (ไม่บังคับอัปโหลดใหม่)"; document.getElementById("songFilePicker").className = "file-picker filled"; }
  if (s.cover_url) { document.getElementById("coverFilePicker").textContent = "✔ มีรูปปกอยู่แล้ว"; document.getElementById("coverFilePicker").className = "file-picker filled"; }
  existingFullFileUrl = s.full_file_url || "";
  if (existingFullFileUrl) {
    document.getElementById("fullSongFilePicker").textContent = `🔒✔ มีไฟล์เต็มอยู่แล้ว${s.full_file_name ? " (" + s.full_file_name + ")" : ""} — ไม่บังคับอัปโหลดใหม่`;
    document.getElementById("fullSongFilePicker").className = "file-picker filled";
  }
  // Auto Preview: ถ้าเพลงนี้เคยวิเคราะห์ไว้แล้ว (หรือเคยแก้มือไว้) ให้โชว์สถานะเดิม — ยังไม่ต้องวิเคราะห์ซ้ำ
  if (s.file_url) {
    if (s.preview_status) {
      renderPreviewData({
        status: s.preview_status,
        dance_start_bar: s.dance_start_bar,
        preview_start_bar: s.preview_start_bar,
        preview_end_bar: s.preview_end_bar,
        preview_start_sec: s.preview_start_sec,
        preview_end_sec: s.preview_end_sec,
        confidence: s.preview_confidence,
        duration_sec: s.preview_duration_sec
      });
    } else {
      // เพลงเก่าก่อนมีระบบนี้ — ยังไม่เคยวิเคราะห์เลย
      showPreviewBox();
      setPreviewBadge("ยังไม่เคยวิเคราะห์", "#9aa0aa");
      document.getElementById("previewInfoText").textContent = "เพลงนี้อัปโหลดไว้ก่อนมีระบบ Auto Preview — กด \"วิเคราะห์เสียงใหม่ทั้งหมด\" เพื่อสร้าง Preview ให้เพลงนี้";
    }
  }
  document.getElementById("songFormBackdrop").classList.add("show");
}
document.getElementById("addSongBtn").addEventListener("click", openAddSong);
document.getElementById("songFormClose").addEventListener("click", () => {
  if (songUploadController) { songUploadController.abort(); songUploadController = null; } // ปิดฟอร์มระหว่างอัปโหลด ต้องยกเลิกอัปโหลดจริงด้วย ไม่ปล่อยค้างเบื้องหลัง
  document.getElementById("songFormBackdrop").classList.remove("show");
});

document.getElementById("songFileInput").addEventListener("change", (e) => {
  const f = e.target.files[0]; if (!f) return;
  pendingSongFile = f;
  document.getElementById("songFilePicker").textContent = "🎵 " + f.name;
  document.getElementById("songFilePicker").className = "file-picker filled";

  const nameField = document.getElementById("fSongName");
  if (!editingSongId && !nameField.value.trim()) {
    nameField.value = nameFromFile(f.name);
  }

  // Auto Preview: วิเคราะห์ไฟล์ที่เพิ่งเลือกทันที (ทำในเบราว์เซอร์ ไม่ต้องรออัปโหลดขึ้น Cloudinary ก่อน)
  runAnalysisOnFile(f);
});
document.getElementById("coverFileInput").addEventListener("change", (e) => {
  const f = e.target.files[0]; if (!f) return;
  pendingCoverFile = f;
  document.getElementById("coverFilePicker").textContent = "🖼️ " + f.name;
  document.getElementById("coverFilePicker").className = "file-picker filled";
});

// 🔒🔒🔒 ห้าม AI แก้โค้ดส่วนนี้เองโดยไม่มีคำสั่งจากผู้ใช้โดยตรง (ประกาศจากผู้ใช้ 2026-09-06) 🔒🔒🔒
// เงื่อนไขไฟล์เพลงเต็ม (ทีละไฟล์): อนุญาตทั้งนามสกุล .wav และ .mp3 — ห้ามแก้ให้เหลือรองรับแค่ชนิดเดียวโดยไม่มีคำสั่งผู้ใช้
document.getElementById("fullSongFileInput").addEventListener("change", (e) => {
  const f = e.target.files[0]; if (!f) return;
  const picker = document.getElementById("fullSongFilePicker");
  const meta = document.getElementById("fullSongFileMeta");
  const isWav = /\.wav$/i.test(f.name) || f.type === "audio/wav" || f.type === "audio/x-wav";
  const isMp3 = /\.mp3$/i.test(f.name) || f.type === "audio/mpeg" || f.type === "audio/mp3";
  const isAllowed = isWav || isMp3;
  if (!isAllowed) {
    showToast("กรุณาเลือกไฟล์นามสกุล .wav หรือ .mp3 เท่านั้นสำหรับเพลงเต็ม", "error");
    e.target.value = "";
    pendingFullSongFile = null;
    meta.style.display = "none";
    return;
  }
  const sizeMb = f.size / (1024 * 1024);
  if (sizeMb > MAX_FULL_SONG_SIZE_MB) {
    showToast(`ไฟล์ใหญ่เกินไป (${sizeMb.toFixed(1)} MB) — จำกัดไม่เกิน ${MAX_FULL_SONG_SIZE_MB} MB`, "error");
    e.target.value = "";
    pendingFullSongFile = null;
    meta.style.display = "none";
    return;
  }
  pendingFullSongFile = f;
  picker.textContent = "🔒 " + f.name;
  picker.className = "file-picker filled";
  meta.textContent = `ขนาดไฟล์: ${formatFileSize(f.size)}`;
  meta.style.display = "block";
});
// 🔒🔒🔒 จบส่วนที่ห้าม AI แก้เอง (ไฟล์เพลงเต็มทีละไฟล์) 🔒🔒🔒

// ---------------- Auto Preview: วิเคราะห์อัตโนมัติ + ปุ่มให้แอดมินแก้ไขเอง ----------------
// mySession กันไม่ให้ผลวิเคราะห์ของไฟล์/ฟอร์มรอบเก่ามาเขียนทับฟอร์มที่เปิดใหม่ (แพทเทิร์นเดียวกับ songUploadSession)
async function runAnalysisOnFile(file) {
  const mySession = songUploadSession;
  renderPreviewData({ status: "analyzing" });
  try {
    const result = await analyzeSongFile(file);
    if (mySession !== songUploadSession) return; // ฟอร์มถูกรีเซ็ต/ปิดไปแล้วระหว่างวิเคราะห์
    renderPreviewData(result);
    if (result.status === "needs_review") {
      showToast("วิเคราะห์ไม่พบช่วง Dance ที่มั่นใจพอ — กรุณากรอก Dance Start Bar เอง", "error");
    }
  } catch (err) {
    if (mySession !== songUploadSession) return;
    renderPreviewData({ status: "needs_review", dance_start_bar: null });
    showToast("วิเคราะห์เสียงไม่สำเร็จ: " + (err.message || err) + " — กรอก Dance Start Bar เองได้", "error");
  }
}

// ปุ่ม "แก้ไข / คำนวณ Preview ใหม่" — ใช้เลขห้องที่แอดมินกรอกเอง คำนวณช่วง Preview ใหม่ทันที ไม่ต้องวิเคราะห์เสียงซ้ำ
document.getElementById("recalcPreviewBtn").addEventListener("click", () => {
  const barVal = document.getElementById("fDanceStartBar").value;
  if (barVal === "" || barVal == null) { showToast("กรุณากรอก Dance Start Bar ก่อน", "error"); return; }
  // หาความยาวเพลง (วินาที) เท่าที่รู้ได้ ณ ตอนนี้ — จากผลวิเคราะห์ล่าสุด หรือจากข้อมูลเพลงเดิม (ตอนแก้ไขเพลง)
  const existingSong = editingSongId ? CACHE.songs.find(x => x.id === editingSongId) : null;
  const durationSec =
    (pendingPreviewData && pendingPreviewData.duration_sec) ||
    (existingSong && existingSong.preview_duration_sec) ||
    null;
  const result = recalculateFromManualBar(barVal, durationSec);
  renderPreviewData(result);
  showToast("คำนวณ Preview ใหม่จากเลขห้องที่กรอกแล้ว", "success");
});

// ปุ่ม "ใช้ช่วงที่กำหนดเอง" — ระบุห้องเริ่ม/ห้องหยุดของ Preview เองตรงๆ ไม่ผ่านสูตร Dance เลย
// ⚠️ กัน null ไว้ทั้งก้อน: ถ้า admin.html รุ่นที่ deploy จริงยังไม่มีปุ่ม/ช่องนี้ (เช่น deploy หลุดจังหวะ
// ตามที่เจอปัญหาไป) จะแค่ข้ามการผูกปุ่มนี้เฉยๆ ไม่ทำให้โค้ดส่วนอื่นทั้งไฟล์ที่อยู่ถัดจากนี้พังตามไปด้วย
const recalcManualRangeBtnEl = document.getElementById("recalcManualRangeBtn");
if (recalcManualRangeBtnEl) recalcManualRangeBtnEl.addEventListener("click", () => {
  const startEl = document.getElementById("fPreviewStartBarManual");
  const endEl = document.getElementById("fPreviewEndBarManual");
  const startVal = startEl ? startEl.value : "";
  const endVal = endEl ? endEl.value : "";
  if (startVal === "" || startVal == null || endVal === "" || endVal == null) {
    showToast("กรุณากรอกทั้งห้องเริ่มและห้องหยุด", "error");
    return;
  }
  const existingSong = editingSongId ? CACHE.songs.find(x => x.id === editingSongId) : null;
  const durationSec =
    (pendingPreviewData && pendingPreviewData.duration_sec) ||
    (existingSong && existingSong.preview_duration_sec) ||
    null;
  const result = manualPreviewWindow(startVal, endVal, durationSec);
  renderPreviewData(result);
  showToast("ใช้ช่วง Preview ที่กำหนดเองแล้ว", "success");
});

// ปุ่ม "วิเคราะห์เสียงใหม่ทั้งหมด (AI)" — รันตัววิเคราะห์ใหม่ทั้งเพลง (ใช้ไฟล์ที่เพิ่งเลือกถ้ามี ไม่งั้นดึงจาก URL เดิม)
document.getElementById("reanalyzePreviewBtn").addEventListener("click", async () => {
  const btn = document.getElementById("reanalyzePreviewBtn");
  const existingSong = editingSongId ? CACHE.songs.find(x => x.id === editingSongId) : null;
  if (!pendingSongFile && !(existingSong && existingSong.file_url)) {
    showToast("ยังไม่มีไฟล์เพลงให้วิเคราะห์ — กรุณาเลือกไฟล์เพลงก่อน", "error");
    return;
  }
  btn.disabled = true; btn.textContent = "กำลังวิเคราะห์...";
  renderPreviewData({ status: "analyzing" });
  const mySession = songUploadSession;
  try {
    const result = pendingSongFile
      ? await analyzeSongFile(pendingSongFile)
      : await analyzeSongUrl(existingSong.file_url);
    if (mySession !== songUploadSession) return;
    renderPreviewData(result);
    showToast(result.status === "ok" ? "วิเคราะห์ใหม่สำเร็จ" : "วิเคราะห์ไม่พบช่วง Dance ที่มั่นใจพอ — กรอกเองได้", result.status === "ok" ? "success" : "error");
  } catch (err) {
    if (mySession !== songUploadSession) return;
    showToast("วิเคราะห์ไม่สำเร็จ: " + (err.message || err), "error");
  }
  btn.disabled = false; btn.textContent = "🔄 วิเคราะห์เสียงใหม่ทั้งหมด (AI)";
});

document.getElementById("songSaveBtn").addEventListener("click", async function () {
  const name = document.getElementById("fSongName").value.trim();
  if (!name) { showToast("กรุณากรอกชื่อเพลง", "error"); return; }

  // 🔧 (2026-09-16): ตรวจเพลงซ้ำก่อนอัปโหลด — กันอัปเพลงชื่อเดียวกัน 2 ครั้ง (ฝั่ง single upload ห้ามซ้ำเด็ดขาด)
  // ถ้าเป็นการแก้ไขเพลงเดิม (editingSongId ไม่เป็น null) → ไม่เช็คตัวเอง
  const duplicates = findDuplicateSongsByName(name, editingSongId);
  if (duplicates.length > 0) {
    const dupNames = duplicates.slice(0, 3).map(d => `"${d.song_name}"`).join(", ");
    const more = duplicates.length > 3 ? ` และอีก ${duplicates.length - 3} เพลง` : "";
    showToast(`❌ มีเพลงชื่อนี้อยู่ในระบบแล้ว ${duplicates.length} เพลง: ${dupNames}${more} — ห้ามอัปซ้ำ (เปลี่ยนชื่อหรือแก้ไขเพลงเดิมแทน)`, "error");
    return;
  }

  // 🔒 Shared-file (Lazy-shared): ถ้าเพลงนี้ไม่มี full_file_url (ไม่ได้อัปโหลดไฟล์เต็มแยก)
  // ระบบจะใช้ file_url (เพลงตัวอย่าง) แทนเป็นเพลงเต็มด้วย — ประหยัดพื้นที่ R2
  // แต่ต้อง "บังคับ" ตั้ง Auto Preview ไว้ ไม่งั้นลูกค้าจะเห็น/ดาวน์โหลดเพลงเต็มผ่าน file_url ตรงๆ
  // ถ้าไม่มี Auto Preview จะแจ้งเตือน + ถามยืนยันก่อนบันทึก (admin ยังบันทึกได้ แต่ต้องกดยืนยัน)
  const willShareFile = !pendingFullSongFile && !existingFullFileUrl;
  const hasValidPreview = pendingPreviewData
    && pendingPreviewData.status === "ok"
    && pendingPreviewData.preview_start_sec != null
    && pendingPreviewData.preview_end_sec != null;
  // กรณีแก้ไขเพลงเก่าที่เคยวิเคราะห์ preview ไว้แล้ว — ถ้า admin ไม่ได้ re-analyze ใหม่ pendingPreviewData อาจเป็น null
  // แต่ข้อมูลเดิมยังอยู่ใน CACHE.songs → ถ้า preview_status === "ok" ถือว่าพร้อม
  const existingSong = editingSongId ? CACHE.songs.find(x => x.id === editingSongId) : null;
  const existingHasValidPreview = existingSong
    && existingSong.preview_status === "ok"
    && existingSong.preview_start_sec != null
    && existingSong.preview_end_sec != null;
  if (willShareFile && !hasValidPreview && !existingHasValidPreview) {
    const proceed = window.confirm(
      "⚠️ คุณไม่ได้อัปโหลดไฟล์เต็มแยกต่างหาก และยังไม่ได้ตั้ง Auto Preview\n\n" +
      "ระบบจะใช้ไฟล์เพลงตัวอย่าง (file_url) เป็นเพลงเต็มด้วยเพื่อประหยัดพื้นที่ R2\n" +
      "แต่ถ้าไม่มี Auto Preview ลูกค้าจะเห็นเพลงเต็มผ่าน file_url ตั้งแต่ก่อนชำระเงิน\n\n" +
      "แนะนำให้กด \"ยกเลิก\" แล้วกด \"วิเคราะห์เสียงใหม่ทั้งหมด (AI)\" เพื่อตั้ง Auto Preview ก่อน\n\n" +
      "ต้องการบันทึกเพลงนี้ต่อโดยไม่มี Auto Preview ใช่หรือไม่?"
    );
    if (!proceed) return;
  }

  const btn = this; btn.disabled = true; btn.textContent = "กำลังบันทึก...";
  const mySession = songUploadSession; // จำ session ปัจจุบัน กันไม่ให้ callback ไปเขียนทับฟอร์มที่ถูกรีเซ็ต/เปิดใหม่ระหว่างอัปโหลด
  const controller = new AbortController(); // ใช้กดยกเลิกอัปโหลดจริง (xhr.abort())
  songUploadController = controller;
  try {
    let fileUrl = null, coverUrl = null, fullFileUrl = null, fullFilePublicId = null, fullFileName = null;
    if (pendingSongFile) {
      document.getElementById("songUploadProgressWrap").style.display = "block";
      const prog = document.getElementById("songUploadProgress");
      const songProgLabel = ensureProgressLabel("songUploadProgress");
      ensureCancelButton("songUploadProgressWrap", () => controller.abort());
      const songTotalBytes = pendingSongFile.size;
      const res = await uploadToCloudinary(pendingSongFile, (pct, loaded, total) => {
        if (mySession !== songUploadSession) return; // ฟอร์มถูกรีเซ็ต/เปิดใหม่ไปแล้ว ไม่ต้องอัปเดต UI ต่อ
        prog.style.width = pct + "%";
        updateProgressLabel(songProgLabel, total || songTotalBytes, pct, loaded);
      }, controller.signal);
      fileUrl = res.url;
    }
    if (pendingCoverFile) {
      const res = await uploadToCloudinary(pendingCoverFile, null, controller.signal);
      coverUrl = res.url;
    }
    if (pendingFullSongFile) {
      document.getElementById("fullSongUploadProgressWrap").style.display = "block";
      const prog = document.getElementById("fullSongUploadProgress");
      const fullProgLabel = ensureProgressLabel("fullSongUploadProgress");
      ensureCancelButton("fullSongUploadProgressWrap", () => controller.abort());
      const fullTotalBytes = pendingFullSongFile.size;
      btn.textContent = "กำลังอัปโหลดไฟล์เต็ม...";
      const res = await uploadFullSong(pendingFullSongFile, (pct, loaded, total) => {
        if (mySession !== songUploadSession) return; // เช่นเดียวกับด้านบน
        prog.style.width = pct + "%";
        updateProgressLabel(fullProgLabel, total || fullTotalBytes, pct, loaded);
      }, controller.signal, (attempt, maxRetries) => {
        // อัปโหลดหลุด/timeout — ระบบกำลังลองใหม่อัตโนมัติ (สูงสุด 2 ครั้ง) ไม่ต้องให้ผู้ใช้กดเอง
        if (mySession !== songUploadSession) return;
        btn.textContent = `เชื่อมต่อหลุด กำลังลองใหม่ (${attempt}/${maxRetries})...`;
        showToast(`อัปโหลดไฟล์เต็มมีปัญหา กำลังลองใหม่ (${attempt}/${maxRetries})...`, "error");
      });
      fullFileUrl = res.url;
      fullFilePublicId = res.publicId;
      fullFileName = pendingFullSongFile.name;
      btn.textContent = "กำลังบันทึก...";
    }
    const djSel = document.getElementById("fDj");
    const catSel = document.getElementById("fCategory");
    const plSel = document.getElementById("fPlaylist");
    const payload = {
      song_name: name,
      artist: document.getElementById("fArtist").value.trim(),
      dj_name: djSel.value ? djSel.options[djSel.selectedIndex].text : "",
      category_id: catSel.value,
      category_name: catSel.value ? catSel.options[catSel.selectedIndex].text : "",
      playlist_id: plSel.value,
      playlist_name: plSel.value ? plSel.options[plSel.selectedIndex].text : "",
      price: Number(document.getElementById("fPrice").value || 0),
      description: document.getElementById("fDesc").value.trim(),
      status: document.getElementById("fStatus").value,
      updated_at: new Date().toISOString()
    };
    if (fileUrl) payload.file_url = fileUrl;
    if (coverUrl) payload.cover_url = coverUrl;
    if (fullFileUrl) {
      payload.full_file_url = fullFileUrl;
      payload.full_file_public_id = fullFilePublicId;
      payload.full_file_name = fullFileName;
    }
    // Auto Preview: บันทึกแค่วินาทีเริ่ม/จบ + สถานะ — ไม่มีการอัปโหลดไฟล์ preview แยกใดๆ ทั้งสิ้น
    if (pendingPreviewData && pendingPreviewData.status !== "analyzing") {
      payload.preview_status = pendingPreviewData.status;
      payload.dance_start_bar = pendingPreviewData.dance_start_bar ?? null;
      payload.preview_start_bar = pendingPreviewData.preview_start_bar ?? null;
      payload.preview_end_bar = pendingPreviewData.preview_end_bar ?? null;
      payload.preview_start_sec = pendingPreviewData.preview_start_sec ?? null;
      payload.preview_end_sec = pendingPreviewData.preview_end_sec ?? null;
      payload.preview_confidence = pendingPreviewData.confidence ?? null;
      payload.preview_duration_sec = pendingPreviewData.duration_sec ?? null;
    }

    if (editingSongId) {
      await updateDoc(doc(db, "songs", editingSongId), payload);
    } else {
      payload.created_at = new Date().toISOString();
      await addDoc(collection(db, "songs"), payload);
    }
    hideCancelButton("songUploadProgressWrap");
    hideCancelButton("fullSongUploadProgressWrap");
    showToast("บันทึกเพลงสำเร็จ", "success");
    document.getElementById("songFormBackdrop").classList.remove("show");
    loadSongs();
    loadDashboard();
  } catch (err) {
    if (isAbortError(err)) {
      // ผู้ใช้กดยกเลิกอัปโหลดเอง — ซ่อนแถบ progress/ปุ่มยกเลิก แต่คงฟอร์มไว้ให้แก้ไข/อัปโหลดใหม่ได้ตามที่สั่ง
      document.getElementById("songUploadProgressWrap").style.display = "none";
      document.getElementById("fullSongUploadProgressWrap").style.display = "none";
      hideCancelButton("songUploadProgressWrap");
      hideCancelButton("fullSongUploadProgressWrap");
      showToast("ยกเลิกการอัปโหลดแล้ว");
    } else {
      showToast("บันทึกไม่สำเร็จ: " + err.message, "error");
    }
  }
  songUploadController = null;
  btn.disabled = false; btn.textContent = "บันทึกเพลง";
});

// เช็คว่าเพลงนี้เคยถูกสั่งซื้อ (มีอยู่ใน Order เก่า) หรือไม่ — ใช้ก่อนลบเพลงจริง
async function songHasOrders(songId) {
  const snap = await getDocs(collection(db, "orders"));
  return snap.docs.some(d => (d.data().items || []).some(item =>
    item.song_id === songId || (Array.isArray(item.song_ids) && item.song_ids.includes(songId))
  ));
}

// ลบไฟล์ของเพลงนี้ออกจาก Cloud (R2) — เรียกหลังลบ doc เพลงสำเร็จแล้วเท่านั้น
// - ไฟล์เพลงเต็ม (full_file_*) และไฟล์ตัวอย่าง (file_url): ลบเสมอ เพราะผูกกับเพลงนี้เพลงเดียว
// - รูปปก (cover_url): ลบเฉพาะกรณีไม่มีเพลง/เพลย์ลิสต์อื่นใช้รูปเดียวกันอยู่ (เช็คสดทุกครั้ง ไม่พึ่ง CACHE
//   เพราะ CACHE อาจไม่ตรงกับข้อมูลจริง ณ ขณะนี้)
// ทำงานแบบ "ไม่ throw" — ลบไฟล์ cloud ไม่สำเร็จก็แค่ log ไว้ ไม่กระทบว่า doc เพลงถูกลบไปแล้ว
async function deleteSongFilesFromStorage(song) {
  if (!song) return;
  const jobs = [];
  // 🔒 Shared-file (Lazy-shared): ถ้า full_file_url กับ file_url เป็น URL เดียวกัน (เพลงที่ใช้ไฟล์ร่วมกัน)
  // ให้ลบแค่ครั้งเดียว — กันลบซ้ำซึ่งไม่มีปัญหาใหญ่ แต่เปลือง API call และอาจทำให้ log สับสน
  const isSharedFile = song.full_file_url && song.file_url && song.full_file_url === song.file_url;
  if (song.full_file_public_id) {
    jobs.push(deleteFromStorage({ key: song.full_file_public_id }));
    // ถ้าเป็น shared file และ full_file_public_id ตรงกับ file_url — ลบ file_url ด้วย key นี้ได้เลย ไม่ต้องเรียกซ้ำ
    if (isSharedFile) {
      // ลบไฟล์ไปแล้ว (ผ่าน public_id ด้านบน) ไม่ต้อง push job ซ้ำ
    } else if (song.full_file_url) {
      // ไม่ใช่ shared file — มี full_file_url แยก ลบเพิ่มอีกครั้ง (กรณีเก่าที่มี 2 ไฟล์)
    }
  } else if (song.full_file_url) {
    // ไม่มี public_id แต่มี url — derive key จาก url ฝั่ง backend
    jobs.push(deleteFromStorage({ url: song.full_file_url }));
  }
  if (song.file_url && !isSharedFile) {
    // ลบ file_url เฉพาะถ้าไม่ใช่ shared file (เพราะ shared file ถูกลบไปแล้วด้านบน)
    jobs.push(deleteFromStorage({ url: song.file_url }));
  }
  if (song.cover_url) {
    try {
      const [songsSnap, playlistsSnap] = await Promise.all([
        getDocs(collection(db, "songs")),
        getDocs(collection(db, "playlists")),
      ]);
      const stillUsed =
        songsSnap.docs.some((d) => d.data().cover_url === song.cover_url) ||
        playlistsSnap.docs.some((d) => d.data().cover_url === song.cover_url);
      if (!stillUsed) jobs.push(deleteFromStorage({ url: song.cover_url }));
    } catch (err) {
      console.error("ตรวจสอบการใช้งานรูปปกร่วมไม่สำเร็จ ข้ามการลบรูปปกเพื่อความปลอดภัย:", err);
    }
  }
  const results = await Promise.allSettled(jobs);
  results.forEach((r) => {
    if (r.status === "rejected" || (r.value && r.value.ok === false && !r.value.skipped)) {
      console.error("ลบไฟล์เพลงออกจาก Cloud บางส่วนไม่สำเร็จ:", r.status === "rejected" ? r.reason : r.value.error);
    }
  });
}

async function confirmDeleteSong(id) {
  const hasOrders = await songHasOrders(id);
  if (hasOrders) {
    openConfirm(
      "เพลงนี้มี Order เก่าอ้างอิงอยู่ — ไม่แนะนำให้ลบเพราะจะทำให้ไฟล์เพลงเต็มหาย ระบบจะเปลี่ยนสถานะเป็น 'ปิดการขาย (hidden)' แทนการลบจริง ต้องการดำเนินการต่อหรือไม่?",
      async () => {
        await updateDoc(doc(db, "songs", id), { status: "hidden", updated_at: new Date().toISOString() });
        showToast("ปิดการขายเพลงนี้แล้ว (ไม่ได้ลบไฟล์)", "success");
        loadSongs();
        loadDashboard();
      }
    );
    return;
  }
  openConfirm("คุณต้องการลบเพลงนี้หรือไม่?", async () => {
    const songSnap = await getDoc(doc(db, "songs", id));
    const songData = songSnap.exists() ? songSnap.data() : null;
    await deleteDoc(doc(db, "songs", id));
    // ลบไฟล์ cloud แบบ background — ไม่รอ/ไม่ block UI และไม่ทำให้การลบเพลงล้มเหลวถ้าไฟล์ cloud ลบไม่สำเร็จ
    deleteSongFilesFromStorage(songData);
    showToast("ลบเพลงแล้ว", "success");
    loadSongs();
    loadDashboard();
  });
}

// ================= CATEGORIES =================
async function loadCategories() {
  const snap = await getDocs(collection(db, "categories"));
  CACHE.categories = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  const wrap = document.getElementById("catList");
  if (CACHE.categories.length === 0) { wrap.innerHTML = '<div class="empty-state">ยังไม่มีหมวดหมู่</div>'; return; }
  wrap.innerHTML = CACHE.categories.map(c => `
    <div class="list-row" data-open="${c.id}" style="cursor:pointer;"><div class="info"><div class="n1">${escapeHtml(c.category_name)}</div>
    <div class="n2">${escapeHtml(c.description || "")}</div></div>
    <div class="row-actions"><button class="icon-btn" data-edit="${c.id}">✎</button>
    <button class="icon-btn danger" data-del="${c.id}">🗑</button></div></div>`).join("");
  // กดที่ตัวแถว (ไม่ใช่ปุ่มแก้ไข/ลบ) เพื่อดูเพลงที่อยู่จริงในหมวดหมู่นี้
  wrap.querySelectorAll("[data-open]").forEach(row => row.addEventListener("click", (e) => {
    if (e.target.closest(".row-actions")) return;
    const c = CACHE.categories.find(x => x.id === row.getAttribute("data-open"));
    if (c) openDetailSongs("category", c.id, c.category_name);
  }));
  wrap.querySelectorAll("[data-edit]").forEach(b => b.addEventListener("click", () => openEditCat(b.getAttribute("data-edit"))));
  wrap.querySelectorAll("[data-del]").forEach(b => b.addEventListener("click", () => {
    openConfirm("ลบหมวดหมู่นี้หรือไม่?", async () => {
      await deleteDoc(doc(db, "categories", b.getAttribute("data-del")));
      showToast("ลบแล้ว", "success"); loadCategories(); loadDashboard();
    });
  }));
}
function openAddCat() { editingCatId = null; document.getElementById("catFormTitle").textContent = "เพิ่มหมวดหมู่"; document.getElementById("fCatName").value = ""; document.getElementById("fCatDesc").value = ""; document.getElementById("catFormBackdrop").classList.add("show"); }
function openEditCat(id) {
  const c = CACHE.categories.find(x => x.id === id); if (!c) return;
  editingCatId = id; document.getElementById("catFormTitle").textContent = "แก้ไขหมวดหมู่";
  document.getElementById("fCatName").value = c.category_name; document.getElementById("fCatDesc").value = c.description || "";
  document.getElementById("catFormBackdrop").classList.add("show");
}
document.getElementById("addCatBtn").addEventListener("click", openAddCat);
document.getElementById("catFormClose").addEventListener("click", () => document.getElementById("catFormBackdrop").classList.remove("show"));
document.getElementById("catSaveBtn").addEventListener("click", async () => {
  const name = document.getElementById("fCatName").value.trim();
  if (!name) { showToast("กรุณากรอกชื่อหมวดหมู่", "error"); return; }
  const payload = { category_name: name, description: document.getElementById("fCatDesc").value.trim() };
  try {
    if (editingCatId) await updateDoc(doc(db, "categories", editingCatId), payload);
    else { payload.created_at = new Date().toISOString(); await addDoc(collection(db, "categories"), payload); }
    showToast("บันทึกแล้ว", "success"); document.getElementById("catFormBackdrop").classList.remove("show"); loadCategories(); loadDashboard();
  } catch (err) { showToast("บันทึกไม่สำเร็จ: " + err.message, "error"); }
});

// ================= DJs =================
async function loadDjs() {
  const snap = await getDocs(collection(db, "djs"));
  CACHE.djs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  const wrap = document.getElementById("djList");
  if (CACHE.djs.length === 0) { wrap.innerHTML = '<div class="empty-state">ยังไม่มี DJ</div>'; return; }
  wrap.innerHTML = CACHE.djs.map(d => `
    <div class="list-row" data-open="${d.id}" style="cursor:pointer;"><img src="${d.image_url || ""}">
    <div class="info"><div class="n1">${escapeHtml(d.dj_name)}</div><div class="n2">${escapeHtml(d.description || "")}</div></div>
    <div class="row-actions"><button class="icon-btn" data-edit="${d.id}">✎</button>
    <button class="icon-btn danger" data-del="${d.id}">🗑</button></div></div>`).join("");
  // กดที่ตัวแถว (ไม่ใช่ปุ่มแก้ไข/ลบ) เพื่อดูเพลงที่อยู่จริงในสังกัด DJ นี้
  wrap.querySelectorAll("[data-open]").forEach(row => row.addEventListener("click", (e) => {
    if (e.target.closest(".row-actions")) return;
    const d = CACHE.djs.find(x => x.id === row.getAttribute("data-open"));
    if (d) openDetailSongs("dj", d.id, d.dj_name);
  }));
  wrap.querySelectorAll("[data-edit]").forEach(b => b.addEventListener("click", () => openEditDj(b.getAttribute("data-edit"))));
  wrap.querySelectorAll("[data-del]").forEach(b => b.addEventListener("click", () => {
    openConfirm("ลบ DJ นี้หรือไม่?", async () => {
      await deleteDoc(doc(db, "djs", b.getAttribute("data-del")));
      showToast("ลบแล้ว", "success"); loadDjs(); loadDashboard();
    });
  }));
}
function resetDjForm() {
  editingDjId = null; pendingDjImageFile = null; existingDjImageUrl = "";
  document.getElementById("fDjName").value = ""; document.getElementById("fDjDesc").value = "";
  document.getElementById("djImageInput").value = "";
  document.getElementById("djImagePicker").textContent = "🖼️ แตะเพื่อเลือกรูปจาก iPhone/iPad";
  document.getElementById("djImagePicker").className = "file-picker";
}
function openAddDj() { resetDjForm(); document.getElementById("djFormTitle").textContent = "เพิ่ม DJ"; document.getElementById("djFormBackdrop").classList.add("show"); }
function openEditDj(id) {
  const d = CACHE.djs.find(x => x.id === id); if (!d) return;
  resetDjForm();
  editingDjId = id; existingDjImageUrl = d.image_url || "";
  document.getElementById("djFormTitle").textContent = "แก้ไข DJ";
  document.getElementById("fDjName").value = d.dj_name; document.getElementById("fDjDesc").value = d.description || "";
  if (existingDjImageUrl) { document.getElementById("djImagePicker").textContent = "✔ มีรูปอยู่แล้ว (แตะเพื่อเปลี่ยนรูปใหม่)"; document.getElementById("djImagePicker").className = "file-picker filled"; }
  document.getElementById("djFormBackdrop").classList.add("show");
}
document.getElementById("addDjBtn").addEventListener("click", openAddDj);
document.getElementById("djFormClose").addEventListener("click", () => document.getElementById("djFormBackdrop").classList.remove("show"));
document.getElementById("djImageInput").addEventListener("change", (e) => {
  const f = e.target.files[0]; if (!f) return;
  pendingDjImageFile = f;
  document.getElementById("djImagePicker").textContent = "🖼️ " + f.name;
  document.getElementById("djImagePicker").className = "file-picker filled";
});
document.getElementById("djSaveBtn").addEventListener("click", async function () {
  const name = document.getElementById("fDjName").value.trim();
  if (!name) { showToast("กรุณากรอกชื่อ DJ", "error"); return; }
  const btn = this; btn.disabled = true; btn.textContent = "กำลังบันทึก...";
  try {
    let imageUrl = existingDjImageUrl;
    if (pendingDjImageFile) {
      const res = await uploadToCloudinary(pendingDjImageFile);
      imageUrl = res.url;
    }
    const payload = { dj_name: name, description: document.getElementById("fDjDesc").value.trim(), image_url: imageUrl };
    if (editingDjId) await updateDoc(doc(db, "djs", editingDjId), payload);
    else { payload.created_at = new Date().toISOString(); await addDoc(collection(db, "djs"), payload); }
    showToast("บันทึกแล้ว", "success"); document.getElementById("djFormBackdrop").classList.remove("show"); loadDjs(); loadDashboard();
  } catch (err) {
    showToast("บันทึกไม่สำเร็จ: " + err.message, "error");
  }
  btn.disabled = false; btn.textContent = "บันทึก";
});

// ================= PLAYLISTS =================
async function loadPlaylists() {
  const snap = await getDocs(collection(db, "playlists"));
  CACHE.playlists = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  const wrap = document.getElementById("playlistList");
  if (CACHE.playlists.length === 0) { wrap.innerHTML = '<div class="empty-state">ยังไม่มีเพลย์ลิสต์</div>'; return; }
  wrap.innerHTML = CACHE.playlists.map(p => `
    <div class="list-row" data-open="${p.id}" style="cursor:pointer;"><img src="${p.cover_url || ""}">
    <div class="info"><div class="n1">${escapeHtml(p.playlist_name)}</div><div class="n2">${escapeHtml(p.description || "")}${p.price ? ` · ${formatPrice(p.price)}` : ""}</div></div>
    <div class="row-actions"><button class="icon-btn" data-edit="${p.id}">✎</button>
    <button class="icon-btn danger" data-del="${p.id}">🗑</button></div></div>`).join("");
  // กดที่ตัวแถว (ไม่ใช่ปุ่มแก้ไข/ลบ) เพื่อดูเพลงที่อยู่จริงในเพลย์ลิสต์นี้
  wrap.querySelectorAll("[data-open]").forEach(row => row.addEventListener("click", (e) => {
    if (e.target.closest(".row-actions")) return;
    const p = CACHE.playlists.find(x => x.id === row.getAttribute("data-open"));
    if (p) openDetailSongs("playlist", p.id, p.playlist_name);
  }));
  wrap.querySelectorAll("[data-edit]").forEach(b => b.addEventListener("click", () => openEditPlaylist(b.getAttribute("data-edit"))));
  wrap.querySelectorAll("[data-del]").forEach(b => b.addEventListener("click", () => {
    openConfirm("ลบเพลย์ลิสต์นี้หรือไม่? (เพลงในเพลย์ลิสต์จะไม่ถูกลบ แค่ไม่ได้อยู่ในเพลย์ลิสต์นี้อีก)", async () => {
      await deleteDoc(doc(db, "playlists", b.getAttribute("data-del")));
      showToast("ลบแล้ว", "success"); loadPlaylists(); loadDashboard();
    });
  }));
}

// ================= DETAIL: เพลงที่อยู่จริงในหมวดหมู่ / DJ / เพลย์ลิสต์ที่กดเข้าไปดู =================
// หมายเหตุ: ความสัมพันธ์เพลง-DJ ในระบบเดิมผูกด้วยชื่อ (song.dj_name) ไม่มี dj_id เก็บไว้ที่เพลง
// (เห็นได้จาก openEditSong ที่ match ด้วยชื่อเช่นกัน) จึงต้อง match ด้วยชื่อให้ตรงกับของเดิมทุกจุด
let currentDetailContext = null; // { type: 'category'|'dj'|'playlist', id, name }

function getSongsForDetail(type, id) {
  if (type === "category") return CACHE.songs.filter(s => s.category_id === id);
  if (type === "playlist") return CACHE.songs.filter(s => s.playlist_id === id);
  if (type === "dj") {
    const dj = CACHE.djs.find(x => x.id === id);
    if (!dj) return [];
    return CACHE.songs.filter(s => s.dj_name === dj.dj_name);
  }
  return [];
}

async function openDetailSongs(type, id, name) {
  currentDetailContext = { type, id, name };
  document.getElementById("listSongsTitle").textContent = `เพลงใน "${name}"`;
  document.getElementById("listSongsMeta").textContent = "";
  document.getElementById("listSongsContainer").innerHTML = '<div class="empty-state">กำลังโหลด...</div>';
  document.getElementById("listSongsBackdrop").classList.add("show");
  // โหลดรายชื่อเพลงล่าสุดเสมอตอนเปิดหน้านี้ (กันกรณีเข้าหน้าหมวดหมู่/DJ/เพลย์ลิสต์โดยยังไม่เคยโหลดเพลงมาก่อน)
  const snap = await getDocs(collection(db, "songs"));
  CACHE.songs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  if (currentDetailContext && currentDetailContext.type === type && currentDetailContext.id === id) {
    renderDetailSongsList();
  }
}

function renderDetailSongsList() {
  if (!currentDetailContext) return;
  const { type, id } = currentDetailContext;
  const songs = getSongsForDetail(type, id);
  document.getElementById("listSongsMeta").textContent = `ทั้งหมด ${songs.length} เพลง`;
  const wrap = document.getElementById("listSongsContainer");
  if (songs.length === 0) { wrap.innerHTML = '<div class="empty-state">ยังไม่มีเพลงในรายการนี้</div>'; return; }
  const removeLabel = { category: "นำออกจากหมวดหมู่นี้ (ไม่ลบเพลง)", playlist: "นำออกจากเพลย์ลิสต์นี้ (ไม่ลบเพลง)", dj: "นำออกจาก DJ นี้ (ไม่ลบเพลง)" }[type];
  wrap.innerHTML = songs.map(s => `
    <div class="list-row" data-detail-song-row="${s.id}" style="cursor:pointer;">
      <img src="${s.cover_url || ""}">
      <div class="info"><div class="n1">${escapeHtml(s.song_name)}</div>
      <div class="n2">${escapeHtml(s.dj_name || "-")} · ${escapeHtml(s.category_name || "-")} · ${formatPrice(s.price)}</div></div>
      <div class="row-actions">
        <button class="icon-btn" data-detail-menu="${s.id}" title="เมนู">⋮</button>
      </div>
    </div>`).join("");
  wrap.querySelectorAll("[data-detail-menu]").forEach(b => b.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleDetailRowMenu(b, b.getAttribute("data-detail-menu"));
  }));
  // ===== เพิ่มใหม่ (additive): แตะที่ตัวแถวเพลง → เปิด popup รายละเอียด =====
  // ไม่กระทบปุ่ม ⋮ ในหน้านี้ (มี stopPropagation ด้านบน)
  wrap.querySelectorAll("[data-detail-song-row]").forEach(row => {
    row.addEventListener("click", (e) => {
      if (e.target.closest("[data-detail-menu]")) return;
      const sid = row.getAttribute("data-detail-song-row");
      if (sid) openSongDetailPopup(sid);
    });
  });
}

// เมนูดรอปดาวน์ ⋮ สำหรับแถวเพลงในหน้ารายละเอียด หมวดหมู่ / DJ / เพลย์ลิสต์ (เดิมเป็นปุ่ม ✎➖🗑 เรียงกันจนบังชื่อเพลงบนจอแคบ)
// ทำงานแบบเดียวกับ songRowMenu ในหน้าจัดการเพลงหลัก แต่ใช้ element และตัวแปร state แยกกันคนละชุด ไม่ปนกัน
// ยังเรียกฟังก์ชันเดิมทุกตัว (openEditSong / นำออกจากรายการ / deleteSongFromDetailView) เหมือนเดิมทุกประการ
let openDetailMenuId = null;
function toggleDetailRowMenu(btn, songId) {
  const menu = document.getElementById("detailSongRowMenu");
  if (openDetailMenuId === songId && menu.style.display !== "none") {
    hideDetailRowMenu();
    return;
  }
  openDetailMenuId = songId;
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
function hideDetailRowMenu() {
  document.getElementById("detailSongRowMenu").style.display = "none";
  openDetailMenuId = null;
}
document.addEventListener("click", (e) => {
  const menu = document.getElementById("detailSongRowMenu");
  if (menu.style.display !== "none" && !menu.contains(e.target)) hideDetailRowMenu();
});
window.addEventListener("scroll", hideDetailRowMenu, true);
document.getElementById("detailRowMenuEdit").addEventListener("click", async () => {
  const songId = openDetailMenuId; hideDetailRowMenu();
  if (!songId) return;
  document.getElementById("listSongsBackdrop").classList.remove("show");
  await loadSongs(); // โหลดใหม่เพื่อให้ dropdown DJ/หมวดหมู่/เพลย์ลิสต์ในฟอร์มแก้ไขเพลงมีข้อมูลครบ เหมือนเข้าจากหน้าจัดการเพลงปกติ
  openEditSong(songId);
});
document.getElementById("detailRowMenuRemove").addEventListener("click", () => {
  const songId = openDetailMenuId; hideDetailRowMenu();
  if (!songId) return;
  const ctx = currentDetailContext;
  if (!ctx) return;
  const removeLabel = { category: "นำออกจากหมวดหมู่นี้ (ไม่ลบเพลง)", playlist: "นำออกจากเพลย์ลิสต์นี้ (ไม่ลบเพลง)", dj: "นำออกจาก DJ นี้ (ไม่ลบเพลง)" }[ctx.type];
  openConfirm(`ต้องการ${removeLabel}นี้ใช่หรือไม่? เพลงจะยังอยู่ในระบบเหมือนเดิม แค่ไม่ได้อยู่ใน "${ctx.name}" อีกต่อไป`, async () => {
    const payload = { updated_at: new Date().toISOString() };
    if (ctx.type === "category") { payload.category_id = ""; payload.category_name = ""; }
    else if (ctx.type === "playlist") { payload.playlist_id = ""; payload.playlist_name = ""; }
    else if (ctx.type === "dj") { payload.dj_name = ""; }
    await updateDoc(doc(db, "songs", songId), payload);
    const song = CACHE.songs.find(x => x.id === songId);
    if (song) Object.assign(song, payload);
    showToast("นำเพลงออกจากรายการแล้ว (เพลงยังอยู่ในระบบ ไม่ได้ถูกลบ)", "success");
    renderDetailSongsList();
  });
});
document.getElementById("detailRowMenuDelete").addEventListener("click", () => {
  const songId = openDetailMenuId; hideDetailRowMenu();
  if (songId) deleteSongFromDetailView(songId);
});

// ลบเพลงออกจากระบบจริง จากหน้าดูรายละเอียดหมวดหมู่/DJ/เพลย์ลิสต์
// ใช้ logic เดียวกับปุ่มลบเพลงในหน้าจัดการเพลง (confirmDeleteSong) ทุกประการ — เช็ค Order เก่าก่อน
// ถ้ามี Order อ้างอิงอยู่จะปิดการขาย (hidden) แทนการลบจริง กันไฟล์เต็มหาย ต่างจาก confirmDeleteSong
// แค่ตรงที่ต้อง re-render รายการเพลงในหน้านี้ด้วยหลังลบ แทนที่จะ loadSongs() ทั้งหน้าจัดการเพลง
async function deleteSongFromDetailView(id) {
  const hasOrders = await songHasOrders(id);
  if (hasOrders) {
    openConfirm(
      "เพลงนี้มี Order เก่าอ้างอิงอยู่ — ไม่แนะนำให้ลบเพราะจะทำให้ไฟล์เพลงเต็มหาย ระบบจะเปลี่ยนสถานะเป็น 'ปิดการขาย (hidden)' แทนการลบจริง ต้องการดำเนินการต่อหรือไม่?",
      async () => {
        await updateDoc(doc(db, "songs", id), { status: "hidden", updated_at: new Date().toISOString() });
        showToast("ปิดการขายเพลงนี้แล้ว (ไม่ได้ลบไฟล์)", "success");
        const song = CACHE.songs.find(x => x.id === id);
        if (song) song.status = "hidden";
        renderDetailSongsList();
        loadDashboard();
      }
    );
    return;
  }
  openConfirm("ต้องการลบเพลงนี้ออกจากระบบจริงหรือไม่? (ลบถาวร — ต่างจากปุ่ม ➖ ที่แค่ถอดออกจากรายการนี้)", async () => {
    const songSnap = await getDoc(doc(db, "songs", id));
    const songData = songSnap.exists() ? songSnap.data() : null;
    await deleteDoc(doc(db, "songs", id));
    // ลบไฟล์ cloud แบบ background เช่นเดียวกับ confirmDeleteSong (logic เดียวกันทุกประการ)
    deleteSongFilesFromStorage(songData);
    showToast("ลบเพลงออกจากระบบแล้ว", "success");
    CACHE.songs = CACHE.songs.filter(x => x.id !== id);
    renderDetailSongsList();
    loadDashboard();
  });
}
document.getElementById("listSongsClose").addEventListener("click", () => {
  document.getElementById("listSongsBackdrop").classList.remove("show");
  currentDetailContext = null;
});
function resetPlaylistForm() {
  editingPlaylistId = null; pendingPlaylistCoverFile = null; existingPlaylistCoverUrl = "";
  document.getElementById("fPlaylistName").value = ""; document.getElementById("fPlaylistDesc").value = "";
  document.getElementById("fPlaylistPrice").value = "";
  document.getElementById("playlistCoverInput").value = "";
  document.getElementById("playlistCoverPicker").textContent = "🖼️ แตะเพื่อเลือกรูปปก";
  document.getElementById("playlistCoverPicker").className = "file-picker";
}
function openAddPlaylist() { resetPlaylistForm(); document.getElementById("playlistFormTitle").textContent = "เพิ่มเพลย์ลิสต์"; document.getElementById("playlistFormBackdrop").classList.add("show"); }
function openEditPlaylist(id) {
  const p = CACHE.playlists.find(x => x.id === id); if (!p) return;
  resetPlaylistForm();
  editingPlaylistId = id; existingPlaylistCoverUrl = p.cover_url || "";
  document.getElementById("playlistFormTitle").textContent = "แก้ไขเพลย์ลิสต์";
  document.getElementById("fPlaylistName").value = p.playlist_name; document.getElementById("fPlaylistDesc").value = p.description || "";
  document.getElementById("fPlaylistPrice").value = p.price || 0;
  if (existingPlaylistCoverUrl) { document.getElementById("playlistCoverPicker").textContent = "✔ มีรูปปกอยู่แล้ว (แตะเพื่อเปลี่ยนรูปใหม่)"; document.getElementById("playlistCoverPicker").className = "file-picker filled"; }
  document.getElementById("playlistFormBackdrop").classList.add("show");
}
document.getElementById("addPlaylistBtn").addEventListener("click", openAddPlaylist);
document.getElementById("playlistFormClose").addEventListener("click", () => document.getElementById("playlistFormBackdrop").classList.remove("show"));
document.getElementById("playlistCoverInput").addEventListener("change", (e) => {
  const f = e.target.files[0]; if (!f) return;
  pendingPlaylistCoverFile = f;
  document.getElementById("playlistCoverPicker").textContent = "🖼️ " + f.name;
  document.getElementById("playlistCoverPicker").className = "file-picker filled";
});
document.getElementById("playlistSaveBtn").addEventListener("click", async function () {
  const name = document.getElementById("fPlaylistName").value.trim();
  if (!name) { showToast("กรุณากรอกชื่อเพลย์ลิสต์", "error"); return; }
  const btn = this; btn.disabled = true; btn.textContent = "กำลังบันทึก...";
  try {
    let coverUrl = existingPlaylistCoverUrl;
    if (pendingPlaylistCoverFile) {
      const res = await uploadToCloudinary(pendingPlaylistCoverFile);
      coverUrl = res.url;
    }
    const payload = {
      playlist_name: name,
      description: document.getElementById("fPlaylistDesc").value.trim(),
      price: Number(document.getElementById("fPlaylistPrice").value || 0),
      cover_url: coverUrl
    };
    if (editingPlaylistId) await updateDoc(doc(db, "playlists", editingPlaylistId), payload);
    else { payload.created_at = new Date().toISOString(); await addDoc(collection(db, "playlists"), payload); }
    showToast("บันทึกแล้ว", "success"); document.getElementById("playlistFormBackdrop").classList.remove("show"); loadPlaylists(); loadDashboard();
  } catch (err) {
    showToast("บันทึกไม่สำเร็จ: " + err.message, "error");
  }
  btn.disabled = false; btn.textContent = "บันทึก";
});

// ================= BULK UPLOAD (เพิ่มเพลงหลายไฟล์พร้อมกันเป็นเพลย์ลิสต์เดียว) =================
let bulkFiles = [];
let bulkFullFiles = [];
let pendingBulkCoverFile = null;

async function openBulkUpload() {
  bulkFiles = []; bulkFullFiles = []; pendingBulkCoverFile = null;
  document.getElementById("bulkNewPlaylistName").value = "";
  document.getElementById("bulkPrice").value = "";
  document.getElementById("bulkFilesInput").value = "";
  document.getElementById("bulkCoverInput").value = "";
  document.getElementById("bulkFilesPicker").textContent = "📁 แตะเพื่อเลือกไฟล์เพลงหลายไฟล์";
  document.getElementById("bulkFilesPicker").className = "file-picker";
  document.getElementById("bulkFullFilesInput").value = "";
  // 🔒 ข้อความ placeholder ปรับให้ตรงกับที่รองรับจริง (WAV/MP3) — ไม่กระทบ logic ใดๆ
  document.getElementById("bulkFullFilesPicker").textContent = "🔒 แตะเพื่อเลือกไฟล์เพลงเต็มหลายไฟล์ (WAV/MP3)";
  document.getElementById("bulkFullFilesPicker").className = "file-picker";
  document.getElementById("bulkFullFilesMeta").style.display = "none";
  document.getElementById("bulkFullFilesMeta").textContent = "";
  document.getElementById("bulkCoverPicker").textContent = "🖼️ แตะเพื่อเลือกรูปปก (ใช้ร่วมกันทั้งชุด)";
  document.getElementById("bulkCoverPicker").className = "file-picker";
  document.getElementById("bulkProgressWrap").style.display = "none";
  document.getElementById("bulkStatusText").textContent = "";
  const bulkLbl = document.getElementById("bulkProgressLabel");
  if (bulkLbl) bulkLbl.textContent = "";
  hideCancelButton("bulkProgressWrap");
  if (bulkUploadController) { bulkUploadController.abort(); bulkUploadController = null; } // เผื่อยังมีอัปโหลดค้างจากรอบก่อนหน้า ให้ยกเลิกจริงไปด้วยเลย

  document.getElementById("bulkCategory").innerHTML = '<option value="">กำลังโหลด...</option>';
  document.getElementById("bulkDj").innerHTML = '<option value="">กำลังโหลด...</option>';
  document.getElementById("bulkPlaylist").innerHTML = '<option value="">กำลังโหลด...</option>';

  document.getElementById("bulkUploadBackdrop").classList.add("show");

  const [catSnap, djSnap, playlistSnap] = await Promise.all([
    getDocs(collection(db, "categories")), getDocs(collection(db, "djs")), getDocs(collection(db, "playlists"))
  ]);
  CACHE.categories = catSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  CACHE.djs = djSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  CACHE.playlists = playlistSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  populateSelect("bulkCategory", CACHE.categories, "id", "category_name");
  populateSelect("bulkDj", CACHE.djs, "id", "dj_name");
  populateSelect("bulkPlaylist", CACHE.playlists, "id", "playlist_name");
}
document.getElementById("bulkUploadClose").addEventListener("click", () => {
  if (bulkUploadController) { bulkUploadController.abort(); bulkUploadController = null; } // ปิดหน้าต่างระหว่างอัปโหลด ต้องยกเลิกอัปโหลดจริงด้วย ไม่ปล่อยค้างเบื้องหลัง
  document.getElementById("bulkUploadBackdrop").classList.remove("show");
});

document.getElementById("bulkFilesInput").addEventListener("change", (e) => {
  bulkFiles = Array.from(e.target.files || []);
  if (bulkFiles.length === 0) return;
  document.getElementById("bulkFilesPicker").textContent = `🎵 เลือกแล้ว ${bulkFiles.length} ไฟล์`;
  document.getElementById("bulkFilesPicker").className = "file-picker filled";
});

// 🔒🔒🔒 ห้าม AI แก้โค้ดส่วนนี้เองโดยไม่มีคำสั่งจากผู้ใช้โดยตรง (ประกาศจากผู้ใช้ 2026-09-06) 🔒🔒🔒
// เงื่อนไขไฟล์เพลงเต็ม (แบบ Bulk หลายไฟล์): อนุญาตทั้งนามสกุล .wav และ .mp3 — ห้ามแก้ให้เหลือรองรับแค่ชนิดเดียวโดยไม่มีคำสั่งผู้ใช้
document.getElementById("bulkFullFilesInput").addEventListener("change", (e) => {
  const files = Array.from(e.target.files || []);
  const meta = document.getElementById("bulkFullFilesMeta");
  const isAllowedFile = (f) => /\.(wav|mp3)$/i.test(f.name);
  const notAllowed = files.filter(f => !isAllowedFile(f));
  if (notAllowed.length > 0) {
    showToast("ไฟล์เพลงเต็มต้องเป็นนามสกุล .wav หรือ .mp3 เท่านั้น — ตัดไฟล์ที่ไม่รองรับออกแล้ว: " + notAllowed.map(f => f.name).join(", "), "error");
  }
  bulkFullFiles = files.filter(isAllowedFile);
  if (bulkFullFiles.length === 0) { meta.style.display = "none"; return; }
  document.getElementById("bulkFullFilesPicker").textContent = `🔒 เลือกแล้ว ${bulkFullFiles.length} ไฟล์`;
  document.getElementById("bulkFullFilesPicker").className = "file-picker filled";
  meta.textContent = "จะจับคู่กับไฟล์ตัวอย่างโดยเทียบชื่อไฟล์ (ไม่รวมนามสกุล) — เพลงที่จับคู่ไม่ได้จะยังไม่มีไฟล์เต็ม เพิ่มทีหลังได้ที่หน้าแก้ไขเพลง";
  meta.style.display = "block";
});
// 🔒🔒🔒 จบส่วนที่ห้าม AI แก้เอง (ไฟล์เพลงเต็มแบบ Bulk) 🔒🔒🔒

document.getElementById("bulkCoverInput").addEventListener("change", (e) => {
  const f = e.target.files[0]; if (!f) return;
  pendingBulkCoverFile = f;
  document.getElementById("bulkCoverPicker").textContent = "🖼️ " + f.name;
  document.getElementById("bulkCoverPicker").className = "file-picker filled";
});

function cleanFileNameToSongName(fileName) {
  return nameFromFile(fileName);
}

// ปรับชื่อไฟล์ให้เทียบกันง่ายขึ้น: ตัดนามสกุล, ไม่สนตัวพิมพ์เล็ก-ใหญ่, ไม่สนช่องว่าง/ขีดกลาง/underscore ที่เกินมาหรือขาดไป
// (กันปัญหาไฟล์ตัวอย่างชื่อ "เพลง A.mp3" กับไฟล์เต็มชื่อ "เพลง_A .wav" ไม่จับคู่กันทั้งที่จริงๆ เป็นเพลงเดียวกัน)
function normalizeForMatch(fileName) {
  return nameFromFile(fileName)
    .trim()
    .toLowerCase()
    .replace(/[_\-]+/g, " ")   // underscore/ขีดกลาง ถือเป็นช่องว่าง
    .replace(/\s+/g, " ");     // ยุบช่องว่างซ้ำให้เหลือช่องเดียว
}

// จับคู่ไฟล์เต็ม WAV กับไฟล์ตัวอย่าง โดยเทียบชื่อไฟล์แบบยืดหยุ่น (ดู normalizeForMatch)
function matchFullFile(previewFileName, fullFilesList) {
  const key = normalizeForMatch(previewFileName);
  return fullFilesList.find(f => normalizeForMatch(f.name) === key) || null;
}

// คำนวณคู่ไฟล์ตัวอย่าง<->ไฟล์เต็มล่วงหน้า (ใช้ตรรกะเดียวกับตอนอัปโหลดจริงเป๊ะๆ เพื่อให้ตารางที่โชว์
// ตรงกับสิ่งที่จะเกิดขึ้นจริง 100% — ถ้าแก้ logic การจับคู่ ต้องแก้ทั้ง 2 จุดนี้ให้ตรงกันเสมอ)
function computeBulkMatches() {
  return bulkFiles.map((file) => {
    const matchedFull = matchFullFile(file.name, bulkFullFiles)
      || (bulkFiles.length === 1 && bulkFullFiles.length === 1 ? bulkFullFiles[0] : null);
    return {
      previewName: file.name,
      songName: cleanFileNameToSongName(file.name),
      fullName: matchedFull ? matchedFull.name : null,
    };
  });
}

// โชว์ตารางคู่ไฟล์ที่จับได้ให้แอดมินเช็คก่อนกดยืนยันครั้งเดียว (ตามที่ผู้ใช้เลือกไว้)
// คืนค่าเป็น Promise<boolean> — true = กดยืนยันอัปโหลด, false = กดย้อนกลับไปแก้ไข
function showBulkMatchConfirm(matches) {
  return new Promise((resolve) => {
    const content = document.getElementById("bulkMatchConfirmContent");
    const backdrop = document.getElementById("bulkMatchConfirmBackdrop");
    const matchedCount = matches.filter((m) => m.fullName).length;
    const rows = matches.map((m) => {
      const fullLabel = m.fullName
        ? `✅ ${escapeHtml(m.fullName)}`
        : `<span style="color:var(--text-dim);">— ไม่มีไฟล์เต็ม —</span>`;
      return `
        <div style="display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:1px solid rgba(255,255,255,.08);">
          <div><strong>${escapeHtml(m.songName)}</strong><small style="display:block;color:var(--text-dim);margin-top:3px;">${escapeHtml(m.previewName)}</small></div>
          <div style="text-align:right;font-size:13px;white-space:nowrap;">${fullLabel}</div>
        </div>`;
    }).join("");
    content.innerHTML =
      `<p style="color:var(--text-dim);font-size:13px;margin-top:0;">พบไฟล์เต็มจับคู่ได้ ${matchedCount}/${matches.length} เพลง — ตรวจสอบให้ตรงก่อนอัปโหลดจริง ถ้าคู่ไหนผิดให้กด "ย้อนกลับไปแก้ไข" แล้วเลือกไฟล์ใหม่</p>` +
      rows;
    backdrop.classList.add("show");

    const cancelBtn = document.getElementById("bulkMatchConfirmCancel");
    const okBtn = document.getElementById("bulkMatchConfirmOk");
    const cleanup = () => {
      backdrop.classList.remove("show");
      cancelBtn.removeEventListener("click", onCancel);
      okBtn.removeEventListener("click", onOk);
    };
    const onCancel = () => { cleanup(); resolve(false); };
    const onOk = () => { cleanup(); resolve(true); };
    cancelBtn.addEventListener("click", onCancel);
    okBtn.addEventListener("click", onOk);
  });
}

document.getElementById("bulkUploadBtn").addEventListener("click", async function () {
  const btn = this;
  if (bulkFiles.length === 0) { showToast("กรุณาเลือกไฟล์เพลงก่อน", "error"); return; }

  // 🔧 (2026-09-16): ตรวจเพลงซ้ำก่อนเริ่มอัปโหลด (ฝั่ง bulk upload — ใช้ option "ถาม confirm ก่อน")
  // ตรวจ 2 แบบ: (1) ซ้ำกับเพลงที่มีอยู่ใน DB (CACHE.songs)  (2) ซ้ำกันในชุดไฟล์ที่เลือก
  // ถ้ามีเพลงซ้ำ → ถามผู้ใช้ว่าจะ "skip เพลงซ้ำและอัปเฉพาะเพลงใหม่" หรือ "ยกเลิกทั้งหมด"
  // ถ้าทุกเพลงในชุดซ้ำ → ไม่ต้องถาม บอกยกเลิกเลย
  {
    const bulkSongNames = bulkFiles.map(f => cleanFileNameToSongName(f.name));
    const duplicatesInDb = [];
    const duplicatesInBatch = [];
    const seenNames = new Map(); // normalized name → first file index

    bulkSongNames.forEach((songName, i) => {
      // (1) ตรวจซ้ำกับ DB
      const dbDups = findDuplicateSongsByName(songName, null);
      if (dbDups.length > 0) {
        duplicatesInDb.push({ fileName: bulkFiles[i].name, songName, existingCount: dbDups.length });
      }
      // (2) ตรวจซ้ำในชุด (normalized)
      const norm = String(songName || "").trim().toLowerCase().replace(/\s+/g, " ");
      if (seenNames.has(norm)) {
        duplicatesInBatch.push({
          fileName: bulkFiles[i].name,
          songName,
          firstFileName: bulkFiles[seenNames.get(norm)].name,
        });
      } else {
        seenNames.set(norm, i);
      }
    });

    if (duplicatesInDb.length > 0 || duplicatesInBatch.length > 0) {
      const totalDup = duplicatesInDb.length + duplicatesInBatch.length;
      const totalNew = bulkFiles.length - totalDup;

      // สร้างข้อความสรุปรายชื่อเพลงซ้ำ
      let msg = `❌ พบเพลงซ้ำ ${totalDup} เพลง:\n\n`;
      if (duplicatesInDb.length > 0) {
        msg += `• ซ้ำกับที่มีในระบบ ${duplicatesInDb.length} เพลง:\n`;
        duplicatesInDb.slice(0, 5).forEach(d => { msg += `  - "${d.songName}" (จากไฟล์ ${d.fileName})\n`; });
        if (duplicatesInDb.length > 5) msg += `  - และอีก ${duplicatesInDb.length - 5} เพลง\n`;
      }
      if (duplicatesInBatch.length > 0) {
        msg += `\n• ซ้ำกันในชุด ${duplicatesInBatch.length} ไฟล์:\n`;
        duplicatesInBatch.slice(0, 5).forEach(d => { msg += `  - "${d.songName}" (ไฟล์ ${d.fileName} ซ้ำกับ ${d.firstFileName})\n`; });
        if (duplicatesInBatch.length > 5) msg += `  - และอีก ${duplicatesInBatch.length - 5} เพลง\n`;
      }

      if (totalNew > 0) {
        // มีเพลงใหม่ที่ไม่ซ้ำ → ถาม confirm ว่าจะ skip และอัปเฉพาะเพลงใหม่ หรือยกเลิก
        msg += `\nต้องการ skip เพลงซ้ำ ${totalDup} เพลง และอัปเฉพาะเพลงใหม่ ${totalNew} เพลง หรือยกเลิกทั้งหมด?`;
        const proceed = window.confirm(msg);
        if (!proceed) {
          showToast("ยกเลิกการอัปโหลดทั้งชุด", "info");
          return;
        }
        // กรองไฟล์ที่ไม่ซ้ำออกมาอัปโหลดต่อ — ใช้ชื่อไฟล์เป็น key เพราะไม่ซ้ำกันใน OS
        const duplicateFileNames = new Set([
          ...duplicatesInDb.map(d => d.fileName),
          ...duplicatesInBatch.map(d => d.fileName),
        ]);
        bulkFiles = bulkFiles.filter(f => !duplicateFileNames.has(f.name));
        showToast(`ข้ามเพลงซ้ำ ${totalDup} เพลง — กำลังอัปโหลด ${bulkFiles.length} เพลงใหม่`, "info");
      } else {
        // ทุกเพลงในชุดซ้ำ → ไม่ต้องถาม บอกยกเลิกเลย
        msg += `\nทุกเพลงในชุดซ้ำ — ไม่สามารถอัปโหลดได้ กรุณาเปลี่ยนชื่อหรือลบไฟล์ซ้ำออก`;
        showToast(msg, "error");
        return;
      }
    }
  }

  // ถ้ามีไฟล์เต็มที่เลือกไว้ ให้โชว์ตารางคู่ที่จับได้ให้เช็คก่อนเริ่มอัปโหลดจริง (กันจับคู่ผิดเพลง)
  // ถ้าไม่ได้เลือกไฟล์เต็มเลย ก็ไม่มีอะไรต้องเช็ค ข้ามไปอัปโหลดตามปกติ
  if (bulkFullFiles.length > 0) {
    const matches = computeBulkMatches();
    const proceed = await showBulkMatchConfirm(matches);
    if (!proceed) return; // ผู้ใช้กดย้อนกลับไปแก้ไข — ยังไม่อัปโหลดอะไรทั้งสิ้น
  }

  const plSel = document.getElementById("bulkPlaylist");
  const newPlaylistName = document.getElementById("bulkNewPlaylistName").value.trim();

  btn.disabled = true; btn.textContent = "กำลังอัปโหลด...";
  document.getElementById("bulkProgressWrap").style.display = "block";
  const bulkProgLabel = ensureProgressLabel("bulkProgress");
  const controller = new AbortController(); // ใช้กดยกเลิกอัปโหลดจริงทั้งคิว (xhr.abort())
  bulkUploadController = controller;
  ensureCancelButton("bulkProgressWrap", () => controller.abort());

  try {
    let playlistId = plSel.value;
    let playlistName = plSel.value ? plSel.options[plSel.selectedIndex].text : "";
    if (!playlistId && newPlaylistName) {
      const newDoc = await addDoc(collection(db, "playlists"), { playlist_name: newPlaylistName, description: "", price: 0, cover_url: "", created_at: new Date().toISOString() });
      playlistId = newDoc.id;
      playlistName = newPlaylistName;
    }

    let sharedCoverUrl = "";
    if (pendingBulkCoverFile) {
      const coverRes = await uploadToCloudinary(pendingBulkCoverFile, null, controller.signal);
      sharedCoverUrl = coverRes.url;
      if (playlistId) await updateDoc(doc(db, "playlists", playlistId), { cover_url: sharedCoverUrl }).catch(() => {});
    }

    const djSel = document.getElementById("bulkDj");
    const catSel = document.getElementById("bulkCategory");
    const price = Number(document.getElementById("bulkPrice").value || 0);
    const djName = djSel.value ? djSel.options[djSel.selectedIndex].text : "";
    const catId = catSel.value;
    const catName = catSel.value ? catSel.options[catSel.selectedIndex].text : "";

    let matchedCount = 0;
    const unmatchedNames = []; // เก็บชื่อเพลงที่มีไฟล์เต็มให้เลือก แต่จับคู่ไม่ได้ — จะได้รู้ทันทีว่าต้องไปแก้ไขเพลงไหนเพิ่ม
    const previewFailedNames = []; // 🔒 Auto Preview: เก็บชื่อเพลงที่วิเคราะห์ไม่สำเร็จ — จะได้รู้ว่าต้องมาแก้ทีหลัง
    // 🔒 อ่านค่า checkbox "วิเคราะห์ Auto Preview อัตโนมัติ" — default เลือกไว้ (checked)
    // ถ้า element ไม่มี (เช่น admin.html รุ่นเก่า) fallback เป็น true (วิเคราะห์) เพื่อความปลอดภัย
    const bulkAutoPreviewEl = document.getElementById("bulkAutoPreviewChk");
    const shouldAnalyzePreview = bulkAutoPreviewEl ? bulkAutoPreviewEl.checked : true;

    for (let i = 0; i < bulkFiles.length; i++) {
      const file = bulkFiles[i];
      document.getElementById("bulkStatusText").textContent = `กำลังอัปโหลด ${i + 1}/${bulkFiles.length}: ${file.name}`;
      const res = await uploadToCloudinary(file, (pct, loaded, total) => {
        const overall = Math.round(((i + pct / 100) / bulkFiles.length) * 100);
        document.getElementById("bulkProgress").style.width = overall + "%";
        updateProgressLabel(bulkProgLabel, total || file.size, pct, loaded);
      }, controller.signal);

      const songPayload = {
        song_name: cleanFileNameToSongName(file.name),
        artist: "",
        dj_name: djName,
        category_id: catId,
        category_name: catName,
        playlist_id: playlistId,
        playlist_name: playlistName,
        file_url: res.url,
        cover_url: sharedCoverUrl,
        price: price,
        description: "",
        status: "active",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };

      // 🔒 Auto Preview (2026-09-12): วิเคราะห์เสียงหาช่วง Dance ของไฟล์ตัวอย่าง
      // ทำหลังอัปโหลดไฟล์ตัวอย่างเสร็จ ก่อนอัปโหลดไฟล์เต็ม (เผื่อใช้ร่วมกันในกรณี shared file)
      // ถ้าล้มเหลว → ข้ามไป ไม่ block การอัปโหลด — บันทึกชื่อเพลงไว้แจ้งเตือนท้าย
      if (shouldAnalyzePreview) {
        document.getElementById("bulkStatusText").textContent = `กำลังวิเคราะห์เสียง ${i + 1}/${bulkFiles.length}: ${file.name}`;
        try {
          const previewResult = await analyzeSongFile(file);
          if (previewResult && previewResult.status === "ok") {
            songPayload.preview_status = previewResult.status;
            songPayload.dance_start_bar = previewResult.dance_start_bar ?? null;
            songPayload.preview_start_bar = previewResult.preview_start_bar ?? null;
            songPayload.preview_end_bar = previewResult.preview_end_bar ?? null;
            songPayload.preview_start_sec = previewResult.preview_start_sec ?? null;
            songPayload.preview_end_sec = previewResult.preview_end_sec ?? null;
            songPayload.preview_confidence = previewResult.confidence ?? null;
            songPayload.preview_duration_sec = previewResult.duration_sec ?? null;
          } else if (previewResult && previewResult.status === "needs_review") {
            // วิเคราะห์ไม่พบช่วง Dance ที่มั่นใจ — บันทึกสถานะไว้ ให้แอดมินมาแก้ทีหลัง
            songPayload.preview_status = previewResult.status;
            songPayload.dance_start_bar = previewResult.dance_start_bar ?? null;
            previewFailedNames.push(songPayload.song_name);
          } else {
            previewFailedNames.push(songPayload.song_name);
          }
        } catch (previewErr) {
          // วิเคราะห์ล้มเหลว (ไฟล์เสียงเสีย/format ไม่รองรับ) — ข้ามไป ไม่ block การอัปโหลด
          console.warn(`Bulk upload: วิเคราะห์ Auto Preview ล้มเหลวสำหรับ "${file.name}":`, previewErr?.message || previewErr);
          previewFailedNames.push(songPayload.song_name);
        }
      }

      // ถ้าจับคู่ด้วยชื่อไฟล์ไม่ได้ แต่เลือกไฟล์ตัวอย่าง 1 ไฟล์ + ไฟล์เต็ม 1 ไฟล์พอดี — ไม่มีทางกำกวมว่าเป็นคู่ไหน จับคู่กันตรงๆ ได้เลย ไม่ต้องพึ่งชื่อไฟล์
      const matchedFull = matchFullFile(file.name, bulkFullFiles)
        || (bulkFiles.length === 1 && bulkFullFiles.length === 1 ? bulkFullFiles[0] : null);
      if (matchedFull) {
        document.getElementById("bulkStatusText").textContent = `กำลังอัปโหลดไฟล์เต็ม ${i + 1}/${bulkFiles.length}: ${matchedFull.name}`;
        const fullRes = await uploadFullSong(matchedFull, (pct, loaded, total) => {
          const overall = Math.round(((i + pct / 100) / bulkFiles.length) * 100);
          document.getElementById("bulkProgress").style.width = overall + "%";
          updateProgressLabel(bulkProgLabel, total || matchedFull.size, pct, loaded);
        }, controller.signal, (attempt, maxRetries) => {
          // อัปโหลดหลุด/timeout — ระบบกำลังลองใหม่อัตโนมัติ (สูงสุด 2 ครั้ง)
          document.getElementById("bulkStatusText").textContent =
            `ไฟล์เต็ม "${matchedFull.name}" เชื่อมต่อหลุด กำลังลองใหม่ (${attempt}/${maxRetries})...`;
        });
        songPayload.full_file_url = fullRes.url;
        songPayload.full_file_public_id = fullRes.publicId;
        songPayload.full_file_name = matchedFull.name;
        matchedCount++;
      } else if (bulkFullFiles.length > 0) {
        unmatchedNames.push(songPayload.song_name);
      }

      await addDoc(collection(db, "songs"), songPayload);
    }

    hideCancelButton("bulkProgressWrap");
    document.getElementById("bulkProgress").style.width = "100%";
    const hasUnmatched = unmatchedNames.length > 0;
    const hasPreviewFailed = previewFailedNames.length > 0;
    // สรุปผล: รวมรายชื่อเพลงที่ต้องแก้ไขทีหลัง (ทั้งไฟล์เต็มไม่ตรง + Auto Preview ล้มเหลว)
    const unmatchedNote = hasUnmatched
      ? ` (มีไฟล์เต็ม ${matchedCount}/${bulkFiles.length} เพลง — ยังไม่มีไฟล์เต็ม: ${unmatchedNames.join(", ")} ไปเพิ่มทีหลังได้ที่หน้าแก้ไขเพลง)`
      : "";
    const previewFailedNote = hasPreviewFailed
      ? ` | Auto Preview ล้มเหลว ${previewFailedNames.length}/${bulkFiles.length} เพลง: ${previewFailedNames.join(", ")} — ไปตั้ง Auto Preview เองได้ที่หน้าแก้ไขเพลง`
      : "";
    const destinationNote = playlistName ? ` เข้าเพลย์ลิสต์ "${playlistName}"` : "";
    document.getElementById("bulkStatusText").textContent = `เสร็จแล้ว! เพิ่มเพลงสำเร็จ ${bulkFiles.length} เพลง${unmatchedNote}${previewFailedNote}`;
    const hasIssue = hasUnmatched || hasPreviewFailed;
    showToast(`เพิ่มเพลง ${bulkFiles.length} เพลง${destinationNote} สำเร็จ${hasIssue ? ` — มีบางเพลงต้องแก้ไขเพิ่ม (ดูรายละเอียดด้านล่าง)` : ""}`, hasIssue ? "error" : "success");
    loadDashboard();
    // ถ้ามีเพลงจับคู่ไฟล์เต็มไม่ได้ หรือ Auto Preview ล้มเหลว ให้ค้างหน้าต่างไว้จนกว่าจะปิดเอง จะได้เห็นรายชื่อที่ต้องไปแก้ไขเพิ่ม
    if (!hasIssue) {
      setTimeout(() => { document.getElementById("bulkUploadBackdrop").classList.remove("show"); }, 1200);
    }
  } catch (err) {
    if (isAbortError(err)) {
      // ผู้ใช้กดยกเลิก — หยุดทั้งคิวที่เหลือทันที (เพลงที่บันทึกไปแล้วก่อนหน้ายังอยู่ตามเดิม)
      // ซ่อนแถบ progress/ปุ่มยกเลิก แต่คงหน้าต่าง Bulk Upload ไว้ให้แก้ไข/กดอัปโหลดใหม่ได้ตามที่สั่ง
      document.getElementById("bulkProgressWrap").style.display = "none";
      hideCancelButton("bulkProgressWrap");
      document.getElementById("bulkStatusText").textContent = "ยกเลิกการอัปโหลดแล้ว";
      showToast("ยกเลิกการอัปโหลดแล้ว");
    } else {
      showToast("อัปโหลดไม่สำเร็จ: " + err.message, "error");
    }
  }
  bulkUploadController = null;
  btn.disabled = false; btn.textContent = "เริ่มอัปโหลดทั้งหมด";
});

// ================= SETTINGS =================
async function loadSettings() {
  const snap = await getDoc(doc(db, "settings", "main"));
  const s = snap.exists() ? snap.data() : {};
  document.getElementById("setWebsiteName").value = s.website_name || "";
  document.getElementById("setMetaDesc").value = s.meta_description || "";
  document.getElementById("setAdminName").value = s.admin_name || "";
  document.getElementById("setWhatsapp").value = s.whatsapp_number || "";
  document.getElementById("setLogo").value = s.website_logo || "";
}
document.getElementById("saveSettingsBtn").addEventListener("click", async () => {
  const payload = {
    website_name: document.getElementById("setWebsiteName").value.trim(),
    meta_description: document.getElementById("setMetaDesc").value.trim(),
    admin_name: document.getElementById("setAdminName").value.trim(),
    whatsapp_number: document.getElementById("setWhatsapp").value.trim(),
    website_logo: document.getElementById("setLogo").value.trim()
  };
  try {
    await setDoc(doc(db, "settings", "main"), payload, { merge: true });
    showToast("บันทึกการตั้งค่าแล้ว", "success");
  } catch (err) {
    showToast("บันทึกไม่สำเร็จ: " + err.message, "error");
  }
});

// ================= Confirm modal =================
function openConfirm(text, onOk) {
  document.getElementById("confirmText").textContent = text;
  confirmAction = onOk;
  document.getElementById("confirmBackdrop").classList.add("show");
}
document.getElementById("confirmCancel").addEventListener("click", () => document.getElementById("confirmBackdrop").classList.remove("show"));
document.getElementById("confirmOk").addEventListener("click", async () => {
  document.getElementById("confirmBackdrop").classList.remove("show");
  if (confirmAction) await confirmAction();
});

// ให้ admin-roles.js เรียกใช้ toast/confirm modal ตัวเดียวกับหน้านี้ได้ (ไม่ต้องสร้างซ้ำ)
window.__showToast = showToast;
window.__openConfirm = openConfirm;

// ====================================================================
// ===== Popup รายละเอียดเพลง (เพิ่มใหม่ — additive, ไม่กระทบระบบเดิม) =====
// ====================================================================
// ทำงานเหมือนฝั่ง user (openSongModal) — แต่ใช้ Audio ของตัวเอง ไม่ปนกับ user
// มีปุ่มกระโดดช่วงเพลง: ต้นเพลง / Dance-Preview / ท้ายเพลง
// ปิด popup → เสียงหยุดทันที (กำหนดตามข้อตกลง)

const DETAIL_AUDIO = new Audio();
DETAIL_AUDIO.preload = "metadata";

// state ของ popup ปัจจุบัน — เก็บ song ที่กำลังเปิดอยู่ + ช่วง preview ถ้ามี
let detailPopupSong = null;
let detailPopupPreview = null; // { start, end } วินาที ถ้ามี Auto Preview
let detailAudioUnlocked = false;
let detailIsSeeking = false;
let detailCurrentSection = null; // "intro" | "preview" | "outro" — track ว่ากำลังอยู่ช่วงไหน (เพื่อ highlight ปุ่ม)

// ===== เพิ่มใหม่: pending seek pattern =====
// ปัญหา: ตอนกดปุ่มกระโดดก่อน metadata โหลดเสร็จ → browser จะ ignore currentTime = X
//   ทำให้เสียงเล่นจาก 0 เสมอ ไม่ว่าจะกดปุ่มไหน
// แก้: เก็บตำแหน่งที่ต้องการ seek ไว้ใน detailPendingSeek แล้ว apply ตอน loadedmetadata ฟื้นขึ้น
//   ค่าพิเศษ: -1 = "ไปท้ายเพลง" (ยังไม่รู้ duration ตอนกด เลยใช้ sentinel)
let detailPendingSeek = null;

// helper: seek ทันทีถ้า metadata พร้อม หรือเก็บไว้รอถ้ายังไม่พร้อม
function detailSeekOrQueue(target) {
  // readyState >= 1 (HAVE_METADATA) → seek ได้เลย
  if (DETAIL_AUDIO.readyState >= 1 && isFinite(target) && target >= 0) {
    try { DETAIL_AUDIO.currentTime = target; } catch (e) {}
    detailPendingSeek = null;
  } else {
    // metadata ยังไม่โหลด → เก็บ pending seek ไว้รอ loadedmetadata
    detailPendingSeek = target;
  }
}

// format เวลาเหมือนฝั่ง user
function detailFormatTime(sec) {
  if (!isFinite(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return m + ":" + (s < 10 ? "0" : "") + s;
}

// ไอคอนเล่น/หยุด (เหมือนฝั่ง user)
function detailPlayIconSvg() { return '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"></path></svg>'; }
function detailStopIconSvg() { return '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14"></rect><rect x="14" y="5" width="4" height="14"></rect></svg>'; }

function setDetailPlayBtnUI(state) {
  // state: "play" | "pause" | "loading"
  const btn = document.getElementById("songDetailPlayBtn");
  if (!btn) return;
  const ico = btn.querySelector(".play-ico");
  const label = btn.querySelector(".play-label");
  btn.classList.remove("loading");
  if (state === "loading") {
    btn.classList.add("loading");
    return;
  }
  if (state === "pause") {
    if (ico) ico.innerHTML = detailStopIconSvg();
    if (label) label.textContent = "หยุดเพลง";
  } else {
    if (ico) ico.innerHTML = detailPlayIconSvg();
    if (label) label.textContent = "ฟังเพลง";
  }
}

function setDetailJumpActive(section) {
  detailCurrentSection = section;
  ["jumpToIntro", "jumpToPreview", "jumpToOutro"].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.toggle("active", id === {
      intro: "jumpToIntro",
      preview: "jumpToPreview",
      outro: "jumpToOutro"
    }[section]);
  });
}

function updateDetailSeekUI() {
  const seekEl = document.getElementById("songDetailSeek");
  const currEl = document.getElementById("songDetailCurrTime");
  const durEl = document.getElementById("songDetailDurTime");
  if (!seekEl) return;
  // ถ้ามี preview: แสดงความคืบหน้าเป็น "เวลาสัมพัทธ์" เหมือนฝั่ง user (0:00 → preview length)
  // ถ้าไม่มี preview: แสดงเวลาจริงของเพลงเต็ม
  if (detailPopupPreview) {
    seekEl.min = detailPopupPreview.start;
    seekEl.max = detailPopupPreview.end;
    if (!detailIsSeeking) seekEl.value = DETAIL_AUDIO.currentTime;
    if (currEl) currEl.textContent = detailFormatTime(Math.max(0, DETAIL_AUDIO.currentTime - detailPopupPreview.start));
    if (durEl) durEl.textContent = detailFormatTime(detailPopupPreview.end - detailPopupPreview.start);
  } else {
    seekEl.min = 0;
    seekEl.max = DETAIL_AUDIO.duration || 0;
    if (!detailIsSeeking) seekEl.value = DETAIL_AUDIO.currentTime;
    if (currEl) currEl.textContent = detailFormatTime(DETAIL_AUDIO.currentTime);
    if (durEl) durEl.textContent = detailFormatTime(DETAIL_AUDIO.duration || 0);
  }
}

// เปิด popup รายละเอียดเพลง
function openSongDetailPopup(songId) {
  const s = CACHE.songs.find(x => x.id === songId);
  if (!s) { showToast("ไม่พบข้อมูลเพลงนี้", "error"); return; }

  detailPopupSong = s;
  // เตรียมช่วง preview ถ้ามี — เหมือนฝั่ง user
  detailPopupPreview =
    s.preview_status === "ok" && s.preview_start_sec != null && s.preview_end_sec != null
      ? { start: Number(s.preview_start_sec), end: Number(s.preview_end_sec) }
      : null;

  // แสดงข้อมูลเพลง
  const coverEl = document.getElementById("songDetailCover");
  if (coverEl) coverEl.src = s.cover_url || "";
  document.getElementById("songDetailName").textContent = s.song_name || "(ไม่มีชื่อ)";
  document.getElementById("songDetailArtist").textContent = s.artist || "";

  // badges: DJ / หมวดหมู่ / เพลย์ลิสต์
  const badges = [];
  if (s.dj_name) badges.push(`<span class="badge dj">🎧 ${escapeHtml(s.dj_name)}</span>`);
  if (s.category_name) badges.push(`<span class="badge cat">🗂️ ${escapeHtml(s.category_name)}</span>`);
  if (s.playlist_name) badges.push(`<span class="badge pl">🎶 ${escapeHtml(s.playlist_name)}</span>`);
  document.getElementById("songDetailBadges").innerHTML = badges.join("") || '<span style="font-size:12px;color:var(--text-dim);">— ไม่ได้จัดเข้ารายการใด —</span>';

  document.getElementById("songDetailDesc").textContent = s.description || "";
  document.getElementById("songDetailPrice").textContent = formatPrice(s.price);

  // meta line: แสดงข้อมูล preview ถ้ามี
  const metaLine = document.getElementById("songDetailMetaLine");
  if (detailPopupPreview) {
    const bars = (s.preview_start_bar != null && s.preview_end_bar != null)
      ? ` · ห้อง ${s.preview_start_bar}–${s.preview_end_bar}` : "";
    metaLine.innerHTML = `🎯 เล่นช่วงตัวอย่าง ${detailFormatTime(detailPopupPreview.start)}–${detailFormatTime(detailPopupPreview.end)}${bars}<br>ใช้ปุ่มด้านบนเพื่อข้ามไปฟังส่วนต่าง ๆ ของเพลง`;
  } else {
    metaLine.innerHTML = `เล่นเต็มไฟล์ (เพลงนี้ยังไม่ได้วิเคราะห์ช่วง Preview) · ใช้ปุ่มด้านบนเพื่อข้ามไปฟังส่วนต่าง ๆ ของเพลง`;
  }

  // reset UI
  setDetailPlayBtnUI("play");
  setDetailJumpActive(null);
  const seekEl = document.getElementById("songDetailSeek");
  if (seekEl) { seekEl.value = 0; seekEl.min = 0; seekEl.max = 0; }
  document.getElementById("songDetailCurrTime").textContent = "0:00";
  document.getElementById("songDetailDurTime").textContent = "0:00";

  // reset pending seek (กันค้างจากเพลงก่อนหน้า)
  detailPendingSeek = null;

  // ปิดเมนูดรอปดาวน์ ⋮ ที่อาจเปิดอยู่ (กันบัง popup)
  hideSongRowMenu();
  hideDetailRowMenu();

  // โหลดไฟล์เพลง (ยังไม่เล่น — ตามกฎ: ไม่กดฟัง ไม่เด้งอะไรขึ้นมา สั้น ๆ คือโหลดไว้เฉย ๆ)
  if (s.file_url) {
    DETAIL_AUDIO.src = s.file_url;
    DETAIL_AUDIO.load();
  } else {
    DETAIL_AUDIO.src = "";
  }

  // แสดง popup
  document.getElementById("songDetailBackdrop").classList.add("show");
}

// ปิด popup และหยุดเสียงทันที
function closeSongDetailPopup() {
  document.getElementById("songDetailBackdrop").classList.remove("show");
  // หยุด + คืน memory ทันที (ตามข้อตกลง: ปิด popup → เสียงหยุด)
  DETAIL_AUDIO.pause();
  DETAIL_AUDIO.removeAttribute("src");
  DETAIL_AUDIO.load();
  detailPopupSong = null;
  detailPopupPreview = null;
  detailCurrentSection = null;
  detailPendingSeek = null; // เคลียร์ pending seek ด้วย
  setDetailJumpActive(null);
  setDetailPlayBtnUI("play");
  // ===== เพิ่มใหม่: reset Auto Preview Editor state =====
  detailPendingPreviewData = null;
  detailPreviewEditorOpen = false;
  const editorBody = document.getElementById("songDetailPreviewBody");
  if (editorBody) editorBody.style.display = "none";
  const chevron = document.getElementById("songDetailPreviewChevron");
  if (chevron) chevron.style.transform = "rotate(0deg)";
  // เคลียร์ช่องกรอก
  const danceField = document.getElementById("songDetailDanceStartBar");
  if (danceField) danceField.value = "";
  const manualStart = document.getElementById("songDetailManualStart");
  if (manualStart) manualStart.value = "";
  const manualEnd = document.getElementById("songDetailManualEnd");
  if (manualEnd) manualEnd.value = "";
}

// ปุ่มปิด popup
document.getElementById("songDetailClose").addEventListener("click", closeSongDetailPopup);
// แตะพื้นหลังนอก popup → ปิด
document.getElementById("songDetailBackdrop").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) closeSongDetailPopup();
});

// ปุ่มเล่น/หยุดหลัก
document.getElementById("songDetailPlayBtn").addEventListener("click", () => {
  if (!detailPopupSong || !detailPopupSong.file_url) { showToast("ไม่พบไฟล์เพลง", "error"); return; }
  // unlock audio สำหรับ mobile (เหมือนฝั่ง user — sync pattern: play แล้ว pause ทันที ไม่ใช้ .finally)
  if (!detailAudioUnlocked) {
    DETAIL_AUDIO.play().catch(() => {});
    DETAIL_AUDIO.pause();
    detailAudioUnlocked = true;
  }
  // ถ้ากำลังเล่นอยู่ → กดหยุด
  if (!DETAIL_AUDIO.paused) {
    DETAIL_AUDIO.pause();
    return;
  }
  // ถ้าหยุดอยู่และยังไม่เคยข้ามช่วง → เริ่มที่ preview (ถ้ามี) หรือที่ 0
  // ใช้ detailSeekOrQueue เพื่อรองรับกรณี metadata ยังไม่โหลด
  if (detailPopupPreview && (DETAIL_AUDIO.currentTime < detailPopupPreview.start || DETAIL_AUDIO.currentTime >= detailPopupPreview.end)) {
    detailSeekOrQueue(detailPopupPreview.start);
    setDetailJumpActive("preview");
  } else if (!detailPopupPreview && detailCurrentSection === null) {
    detailSeekOrQueue(0);
    setDetailJumpActive("intro");
  }
  setDetailPlayBtnUI("loading");
  DETAIL_AUDIO.play().then(() => {
    setDetailPlayBtnUI("pause");
  }).catch(() => {
    setDetailPlayBtnUI("play");
    showToast("ไม่สามารถเล่นเพลงได้ ลองแตะปุ่มอีกครั้ง", "error");
  });
});

// ปุ่มกระโดดช่วงเพลง — ทั้ง 3 ปุ่มใช้ detailSeekOrQueue เพื่อให้ seek ได้ถูกต้อง
// แม้ว่าจะกดตอน metadata ยังไม่โหลดเสร็จ (สาเหตุที่กดปุ่มแล้วกลับไปต้นเพลงเสมอ)
document.getElementById("jumpToIntro").addEventListener("click", () => {
  if (!detailPopupSong || !detailPopupSong.file_url) return;
  setDetailJumpActive("intro");
  detailSeekOrQueue(0); // ต้นเพลง = วินาที 0 เสมอ
  // ถ้าหยุดอยู่ → เล่นทันที
  if (DETAIL_AUDIO.paused) {
    setDetailPlayBtnUI("loading");
    DETAIL_AUDIO.play().then(() => setDetailPlayBtnUI("pause")).catch(() => setDetailPlayBtnUI("play"));
  }
});
document.getElementById("jumpToPreview").addEventListener("click", () => {
  if (!detailPopupSong || !detailPopupSong.file_url) return;
  if (!detailPopupPreview) {
    showToast("เพลงนี้ยังไม่ได้วิเคราะห์ช่วง Preview — กระโดดไปช่วงต้นแทน", "info");
    document.getElementById("jumpToIntro").click();
    return;
  }
  setDetailJumpActive("preview");
  detailSeekOrQueue(detailPopupPreview.start); // กระโดดไปยังจุดเริ่มช่วง Dance/Preview
  if (DETAIL_AUDIO.paused) {
    setDetailPlayBtnUI("loading");
    DETAIL_AUDIO.play().then(() => setDetailPlayBtnUI("pause")).catch(() => setDetailPlayBtnUI("play"));
  }
});
document.getElementById("jumpToOutro").addEventListener("click", () => {
  if (!detailPopupSong || !detailPopupSong.file_url) return;
  // ท้ายเพลง = (preview.end + 30s) หรือ (dur - 15) ถ้าไม่มี preview
  const dur = DETAIL_AUDIO.duration || 0;
  if (!dur) {
    // metadata ยังไม่โหลด → ใช้ sentinel -1 = "ไปท้ายเพลง" รอคำนวณตอน loadedmetadata
    setDetailJumpActive("outro");
    detailSeekOrQueue(-1);
    if (DETAIL_AUDIO.paused) {
      setDetailPlayBtnUI("loading");
      DETAIL_AUDIO.play().then(() => setDetailPlayBtnUI("pause")).catch(() => setDetailPlayBtnUI("play"));
    }
    return;
  }
  const outroTarget = detailPopupPreview
    ? Math.min(dur - 5, detailPopupPreview.end + 30)
    : Math.max(0, dur - 15);
  setDetailJumpActive("outro");
  detailSeekOrQueue(outroTarget);
  if (DETAIL_AUDIO.paused) {
    setDetailPlayBtnUI("loading");
    DETAIL_AUDIO.play().then(() => setDetailPlayBtnUI("pause")).catch(() => setDetailPlayBtnUI("play"));
  }
});

// Audio events
DETAIL_AUDIO.addEventListener("loadedmetadata", () => {
  // ===== เพิ่มใหม่: apply pending seek ถ้ามี =====
  // กรณี sentinel -1 (ไปท้ายเพลง) → คำนวณตำแหน่งจริงจาก duration ที่โหลดเสร็จแล้ว
  if (detailPendingSeek !== null) {
    let target = detailPendingSeek;
    if (target === -1) {
      const dur = DETAIL_AUDIO.duration || 0;
      target = detailPopupPreview
        ? Math.min(dur - 5, detailPopupPreview.end + 30)
        : Math.max(0, dur - 15);
    }
    if (isFinite(target) && target >= 0) {
      try { DETAIL_AUDIO.currentTime = target; } catch (e) {}
    }
    detailPendingSeek = null;
  }
  updateDetailSeekUI();
});
DETAIL_AUDIO.addEventListener("timeupdate", () => {
  // ถ้าอยู่ในโหมด preview และถึงท้ายช่วง preview → หยุด (เหมือนฝั่ง user)
  if (detailPopupPreview && DETAIL_AUDIO.currentTime >= detailPopupPreview.end) {
    DETAIL_AUDIO.pause();
    try { DETAIL_AUDIO.currentTime = detailPopupPreview.start; } catch (e) {}
    setDetailPlayBtnUI("play");
    updateDetailSeekUI();
    return;
  }
  // อัปเดต highlight ของปุ่มกระโดดช่วง ตามตำแหน่งปัจจุบัน
  if (!detailIsSeeking) {
    const t = DETAIL_AUDIO.currentTime;
    if (detailPopupPreview) {
      if (t >= detailPopupPreview.start && t < detailPopupPreview.end) setDetailJumpActive("preview");
      else if (t < detailPopupPreview.start) setDetailJumpActive("intro");
      else setDetailJumpActive("outro");
    } else {
      const dur = DETAIL_AUDIO.duration || 0;
      if (t < dur * 0.7) setDetailJumpActive("intro");
      else setDetailJumpActive("outro");
    }
  }
  updateDetailSeekUI();
});
DETAIL_AUDIO.addEventListener("play", () => setDetailPlayBtnUI("pause"));
DETAIL_AUDIO.addEventListener("pause", () => setDetailPlayBtnUI("play"));
DETAIL_AUDIO.addEventListener("waiting", () => setDetailPlayBtnUI("loading"));
DETAIL_AUDIO.addEventListener("playing", () => setDetailPlayBtnUI("pause"));
DETAIL_AUDIO.addEventListener("ended", () => {
  setDetailPlayBtnUI("play");
  setDetailJumpActive(null);
});
DETAIL_AUDIO.addEventListener("error", () => {
  setDetailPlayBtnUI("play");
  showToast("เกิดข้อผิดพลาดในการโหลดไฟล์เพลง", "error");
});

// Seek bar
const detailSeekEl = document.getElementById("songDetailSeek");
if (detailSeekEl) {
  detailSeekEl.addEventListener("input", () => {
    detailIsSeeking = true;
    const currEl = document.getElementById("songDetailCurrTime");
    if (detailPopupPreview) {
      if (currEl) currEl.textContent = detailFormatTime(Math.max(0, Number(detailSeekEl.value) - detailPopupPreview.start));
    } else {
      if (currEl) currEl.textContent = detailFormatTime(Number(detailSeekEl.value));
    }
  });
  detailSeekEl.addEventListener("change", () => {
    let target = Number(detailSeekEl.value);
    if (detailPopupPreview) {
      // clamp ให้อยู่ในช่วง preview (เหมือนฝั่ง user)
      target = Math.min(detailPopupPreview.end, Math.max(detailPopupPreview.start, target));
    }
    DETAIL_AUDIO.currentTime = target;
    detailIsSeeking = false;
  });
}

// ปิด popup ถ้ากด Esc
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.getElementById("songDetailBackdrop").classList.contains("show")) {
    closeSongDetailPopup();
  }
});

// หยุดเสียงทันทีถ้าผู้ใช้ logout หรือออกจากหน้า
window.addEventListener("beforeunload", () => {
  try { DETAIL_AUDIO.pause(); } catch (_) {}
});

// ====================================================================
// ===== Auto Preview Editor ภายใน popup รายละเอียดเพลง =====
// ====================================================================
// เพิ่มใหม่: ให้แอดมินแก้ Dance Start Bar / กำหนดช่วง Preview เอง / วิเคราะห์ใหม่
// บันทึกลง Firestore ได้ทันที โดยไม่ต้องเปิดฟอร์มแก้ไขเพลงเต็ม
// ไม่แตะระบบเดิม (ฟังก์ชัน renderPreviewData, recalculateFromManualBar, manualPreviewWindow
// analyzeSongUrl เดิมใช้ต่อได้ตามปกติ — เพียงแต่เราทำซ้ำใน popup โดยใช้ element id ต่างออกไป)

// state สำหรับ Auto Preview Editor ใน popup (แยกจาก pendingPreviewData ของฟอร์มเพลง)
let detailPendingPreviewData = null;
let detailPreviewEditorOpen = false;

function setDetailPreviewBadge(text, color) {
  const el = document.getElementById("songDetailPreviewBadge");
  if (!el) return;
  el.textContent = text;
  el.style.background = color + "26"; // ~15% opacity
  el.style.color = color;
}

function renderDetailPreviewData(data) {
  detailPendingPreviewData = data;
  const info = document.getElementById("songDetailPreviewInfo");
  const danceField = document.getElementById("songDetailDanceStartBar");
  const manualStart = document.getElementById("songDetailManualStart");
  const manualEnd = document.getElementById("songDetailManualEnd");

  if (!data) {
    setDetailPreviewBadge("ยังไม่ได้วิเคราะห์", "#9aa0aa");
    if (info) info.textContent = "";
    return;
  }
  if (data.status === "analyzing") {
    setDetailPreviewBadge("⏳ กำลังวิเคราะห์...", "#3B9EFF");
    if (info) info.textContent = "กำลังวิเคราะห์ Beat/Energy/Onset ของไฟล์เพลง...";
    return;
  }
  if (data.status === "needs_review") {
    setDetailPreviewBadge("⚠️ NEEDS_REVIEW", "#ff9f43");
    if (info) info.textContent = "ระบบหาช่วง Dance ที่มั่นใจไม่ได้ — กรุณากรอก Dance Start Bar เองแล้วกด \"คำนวณ\"";
    if (data.dance_start_bar != null && danceField) danceField.value = data.dance_start_bar;
    return;
  }
  // status === "ok"
  if (data.manual_window) {
    setDetailPreviewBadge("🎛 กำหนดเอง", "#3B9EFF");
    if (danceField) danceField.value = data.dance_start_bar ?? "";
    if (manualStart) manualStart.value = data.preview_start_bar;
    if (manualEnd) manualEnd.value = data.preview_end_bar;
    if (info) info.textContent =
      `Preview (กำหนดเอง): ${detailFormatTime(data.preview_start_sec)} – ${detailFormatTime(data.preview_end_sec)} ` +
      `(ห้อง ${data.preview_start_bar}–${data.preview_end_bar})`;
    return;
  }
  setDetailPreviewBadge("✅ พร้อมใช้งาน", "#28c76f");
  if (danceField) danceField.value = data.dance_start_bar;
  if (manualStart) manualStart.value = data.preview_start_bar ?? "";
  if (manualEnd) manualEnd.value = data.preview_end_bar ?? "";
  const confText = data.confidence != null ? ` (ความมั่นใจ ${(data.confidence * 100).toFixed(0)}%)` : " (แก้ไขเอง)";
  if (info) info.textContent =
    `Dance: ห้อง ${data.dance_start_bar}–${data.preview_end_bar}${confText} · ` +
    `Preview: ${detailFormatTime(data.preview_start_sec)} – ${detailFormatTime(data.preview_end_sec)} ` +
    `(ห้อง ${data.preview_start_bar}–${data.preview_end_bar})`;
}

// โหลดข้อมูล preview ปัจจุบันจากเพลงที่เปิดอยู่ ลงใน Auto Preview Editor
function loadDetailPreviewFromSong() {
  if (!detailPopupSong) return;
  const s = detailPopupSong;
  if (s.preview_status) {
    renderDetailPreviewData({
      status: s.preview_status,
      dance_start_bar: s.dance_start_bar,
      preview_start_bar: s.preview_start_bar,
      preview_end_bar: s.preview_end_bar,
      preview_start_sec: s.preview_start_sec,
      preview_end_sec: s.preview_end_sec,
      confidence: s.preview_confidence,
      duration_sec: s.preview_duration_sec,
      manual_window: s.preview_manual_window === true || (s.preview_status === "ok" && s.dance_start_bar == null)
    });
  } else {
    // เพลงเก่าก่อนมีระบบ — ยังไม่เคยวิเคราะห์
    renderDetailPreviewData(null);
    if (s.file_url) {
      setDetailPreviewBadge("ยังไม่เคยวิเคราะห์", "#9aa0aa");
      const info = document.getElementById("songDetailPreviewInfo");
      if (info) info.textContent = "เพลงนี้อัปโหลดไว้ก่อนมีระบบ Auto Preview — กด \"วิเคราะห์เสียงใหม่ทั้งหมด\" เพื่อสร้าง Preview";
    } else {
      setDetailPreviewBadge("ไม่มีไฟล์เพลง", "#9aa0aa");
      const info = document.getElementById("songDetailPreviewInfo");
      if (info) info.textContent = "เพลงนี้ยังไม่มีไฟล์เพลงอัปโหลด — ไม่สามารถวิเคราะห์ Preview ได้";
    }
  }
}

// ปุ่ม toggle เปิด/ปิด Auto Preview Editor
document.getElementById("songDetailPreviewToggle").addEventListener("click", () => {
  detailPreviewEditorOpen = !detailPreviewEditorOpen;
  const body = document.getElementById("songDetailPreviewBody");
  const chevron = document.getElementById("songDetailPreviewChevron");
  if (body) body.style.display = detailPreviewEditorOpen ? "block" : "none";
  if (chevron) chevron.style.transform = detailPreviewEditorOpen ? "rotate(180deg)" : "rotate(0deg)";
  // โหลดข้อมูล preview ทุกครั้งที่เปิด
  if (detailPreviewEditorOpen) loadDetailPreviewFromSong();
});

// ปุ่ม "วิเคราะห์เสียงใหม่ทั้งหมด (AI)"
document.getElementById("songDetailReanalyzeBtn").addEventListener("click", async () => {
  if (!detailPopupSong || !detailPopupSong.file_url) {
    showToast("ยังไม่มีไฟล์เพลงให้วิเคราะห์", "error");
    return;
  }
  const btn = document.getElementById("songDetailReanalyzeBtn");
  btn.disabled = true; btn.textContent = "กำลังวิเคราะห์...";
  renderDetailPreviewData({ status: "analyzing" });
  try {
    const result = await analyzeSongUrl(detailPopupSong.file_url);
    renderDetailPreviewData(result);
    showToast(result.status === "ok" ? "วิเคราะห์ใหม่สำเร็จ" : "วิเคราะห์ไม่พบช่วง Dance ที่มั่นใจพอ — กรอกเองได้", result.status === "ok" ? "success" : "error");
  } catch (err) {
    renderDetailPreviewData({ status: "needs_review", dance_start_bar: null });
    showToast("วิเคราะห์ไม่สำเร็จ: " + (err.message || err), "error");
  }
  btn.disabled = false; btn.textContent = "🔄 วิเคราะห์เสียงใหม่ทั้งหมด (AI)";
});

// ปุ่ม "คำนวณ" — ใช้เลขห้อง Dance Start Bar ที่แอดมินกรอก คำนวณช่วง Preview ใหม่ทันที
document.getElementById("songDetailRecalcBtn").addEventListener("click", () => {
  const barVal = document.getElementById("songDetailDanceStartBar").value;
  if (barVal === "" || barVal == null) {
    showToast("กรุณากรอก Dance Start Bar ก่อน", "error");
    return;
  }
  // หาความยาวเพลงจากข้อมูลเดิมหรือจากผลวิเคราะห์ล่าสุด
  const existingSong = detailPopupSong;
  const durationSec =
    (detailPendingPreviewData && detailPendingPreviewData.duration_sec) ||
    (existingSong && existingSong.preview_duration_sec) ||
    null;
  const result = recalculateFromManualBar(barVal, durationSec);
  renderDetailPreviewData(result);
  showToast("คำนวณ Preview ใหม่จากเลขห้องที่กรอกแล้ว — กด \"บันทึก Preview\" เพื่อใช้", "success");
});

// ปุ่ม "ใช้ช่วงที่กำหนดเอง"
document.getElementById("songDetailManualBtn").addEventListener("click", () => {
  const startVal = document.getElementById("songDetailManualStart").value;
  const endVal = document.getElementById("songDetailManualEnd").value;
  if (startVal === "" || startVal == null || endVal === "" || endVal == null) {
    showToast("กรุณากรอกทั้งห้องเริ่มและห้องหยุด", "error");
    return;
  }
  const existingSong = detailPopupSong;
  const durationSec =
    (detailPendingPreviewData && detailPendingPreviewData.duration_sec) ||
    (existingSong && existingSong.preview_duration_sec) ||
    null;
  const result = manualPreviewWindow(startVal, endVal, durationSec);
  renderDetailPreviewData(result);
  showToast("ใช้ช่วง Preview ที่กำหนดเองแล้ว — กด \"บันทึก Preview\" เพื่อใช้", "success");
});

// ปุ่ม "บันทึก Preview ลงเพลงนี้" — บันทึกเฉพาะฟิลด์ preview_* ลง Firestore (ไม่แต้ฟิลด์อื่น)
document.getElementById("songDetailSavePreviewBtn").addEventListener("click", async function () {
  if (!detailPopupSong) { showToast("ไม่พบเพลงที่จะบันทึก", "error"); return; }
  if (!detailPendingPreviewData || detailPendingPreviewData.status === "analyzing") {
    showToast("ยังไม่มีข้อมูล Preview ที่จะบันทึก — วิเคราะห์หรือกรอกก่อน", "error");
    return;
  }
  const btn = this;
  btn.disabled = true; btn.textContent = "กำลังบันทึก...";
  try {
    const payload = {
      preview_status: detailPendingPreviewData.status,
      dance_start_bar: detailPendingPreviewData.dance_start_bar ?? null,
      preview_start_bar: detailPendingPreviewData.preview_start_bar ?? null,
      preview_end_bar: detailPendingPreviewData.preview_end_bar ?? null,
      preview_start_sec: detailPendingPreviewData.preview_start_sec ?? null,
      preview_end_sec: detailPendingPreviewData.preview_end_sec ?? null,
      preview_confidence: detailPendingPreviewData.confidence ?? null,
      preview_duration_sec: detailPendingPreviewData.duration_sec ?? null,
      preview_manual_window: detailPendingPreviewData.manual_window === true,
      updated_at: new Date().toISOString()
    };
    await updateDoc(doc(db, "songs", detailPopupSong.id), payload);
    // อัปเดต CACHE ด้วย เพื่อให้ list แสดงผลลัพธ์ใหม่ถูกต้อง
    Object.assign(detailPopupSong, payload);
    // sync กลับ CACHE.songs ด้วย
    const cachedSong = CACHE.songs.find(x => x.id === detailPopupSong.id);
    if (cachedSong) Object.assign(cachedSong, payload);

    // อัปเดต popup state ใหม่ — preview ช่วงใหม่
    detailPopupPreview =
      payload.preview_status === "ok" && payload.preview_start_sec != null && payload.preview_end_sec != null
        ? { start: Number(payload.preview_start_sec), end: Number(payload.preview_end_sec) }
        : null;

    // อัปเดต meta line + jump button state
    const metaLine = document.getElementById("songDetailMetaLine");
    if (detailPopupPreview) {
      const bars = (payload.preview_start_bar != null && payload.preview_end_bar != null)
        ? ` · ห้อง ${payload.preview_start_bar}–${payload.preview_end_bar}` : "";
      metaLine.innerHTML = `🎯 เล่นช่วงตัวอย่าง ${detailFormatTime(detailPopupPreview.start)}–${detailFormatTime(detailPopupPreview.end)}${bars}<br>ใช้ปุ่มด้านบนเพื่อข้ามไปฟังส่วนต่าง ๆ ของเพลง`;
      // ถ้ากำลังเล่นอยู่ → หยุดก่อน แล้วกระโดดไปยังจุด preview ใหม่
      DETAIL_AUDIO.pause();
      detailSeekOrQueue(detailPopupPreview.start);
      setDetailJumpActive("preview");
    } else {
      metaLine.innerHTML = `เล่นเต็มไฟล์ (เพลงนี้ยังไม่ได้วิเคราะห์ช่วง Preview) · ใช้ปุ่มด้านบนเพื่อข้ามไปฟังส่วนต่าง ๆ ของเพลง`;
    }

    showToast("บันทึก Preview ลงเพลงนี้แล้ว ✅", "success");
    // โหลดข้อมูล preview ใหม่ใน editor ด้วย เพื่อ sync badge/info
    loadDetailPreviewFromSong();
    // รีเฟรช list ในหน้าจัดการเพลง (เผื่อมีการแสดงผลที่ต้องอัปเดต)
    if (typeof currentSongListView !== "undefined" && currentSongListView.length > 0) {
      renderSongList(currentSongListView);
    }
    // ถ้า popup รายละเอียดหมวด/DJ/เพลย์ลิสต์เปิดอยู่ ก็ refresh ด้วย
    if (currentDetailContext && document.getElementById("listSongsBackdrop").classList.contains("show")) {
      renderDetailSongsList();
    }
  } catch (err) {
    showToast("บันทึกไม่สำเร็จ: " + (err.message || err), "error");
  }
  btn.disabled = false; btn.textContent = "💾 บันทึก Preview ลงเพลงนี้";
});
