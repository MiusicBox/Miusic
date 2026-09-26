// app-admin.js — หน้า Admin: Login (ระบบยืนยันตัวตนของเว็บเองผ่าน Worker) + CRUD (Cloudflare D1) + อัปโหลดไฟล์ (Cloudflare R2)
// ===================================================
import { db, auth, uploadToCloudinary } from "./firebase-init.js?v=20260905-fix1";
import { uploadFullSong, deleteFromStorage } from "./storage-adapter.js?v=20260904-rawzip";
import {
  collection, addDoc, updateDoc, deleteDoc, doc, getDocs, getDoc, setDoc, getDocsAdmin
} from "./db-client.js";
import {
  signInWithEmailAndPassword, onAuthStateChanged, signOut,
  reauthenticateWithCredential, EmailAuthProvider, updatePassword,
  checkHasAdmin, bootstrapFirstAdmin
} from "./auth-client.js";
import { initOrdersView } from "./orders.js?v=20260922-batch10";
import { resolveCurrentAdminRole, initAdminsView } from "./admin-roles.js";
import {
  analyzeSongFile, analyzeSongUrl, recalculateFromManualBar, manualPreviewWindow, BAR_SECONDS
} from "./song-analyzer.js?v=20260908-previewrange1";
// ===== ลดราคา + โปรโมชั่น (ระบบใหม่ — รวมในไฟล์เดียว app-promotion.js) =====
import { initDiscountsView, initPromotionsView } from "./app-promotion.js?v=20261101-promo1";
// 🔧 (ใหม่) ระบบจัดเรียงหมวดหมู่/DJ/เพลย์ลิสต์ ตามพยัญชนะไทย ก-ฮ + A-Z + ตัวเลข
import { sortByThaiName } from "./thai-sort.js";

const CACHE = { songs: [], categories: [], djs: [], playlists: [] };
// 🔧 (2026-09-17 Phase 1): TTL cache สำหรับ admin views — ลด D1 reads ตอนเข้า view ซ้ำ ๆ
// TTL 60 วินาที — ถ้า admin เพิ่งเข้า view นี้ไม่ถึง 60 วิ จะใช้ cache ไม่ fetch ใหม่
// ถ้า admin save/delete → invalidateAdminCache() ล้าง timestamp → fetch ใหม่ทันที
// แยก timestamp ตาม collection เพื่อ optimize — ถ้าแก้แค่ songs ไม่ต้อง fetch categories ใหม่
const ADMIN_CACHE_TTL_MS = 60 * 1000;
const CACHE_AT = { songs: 0, categories: 0, djs: 0, playlists: 0 };
function invalidateAdminCache(collection) {
  // collection = "songs" | "categories" | "djs" | "playlists" | undefined (undefined = ล้างทั้งหมด)
  if (collection && CACHE_AT.hasOwnProperty(collection)) {
    CACHE_AT[collection] = 0;
  } else {
    CACHE_AT.songs = 0;
    CACHE_AT.categories = 0;
    CACHE_AT.djs = 0;
    CACHE_AT.playlists = 0;
  }
}
// Helper: ตรวจว่า cache ของ collection นี้ยัง fresh หรือไม่ (อายุ < 60 วิ)
function isAdminCacheFresh(collection) {
  if (!CACHE_AT[collection]) return false;
  return (Date.now() - CACHE_AT[collection]) < ADMIN_CACHE_TTL_MS;
}
let currentAdminRole = null; // "main" | "sub" — ของบัญชีที่ล็อกอินอยู่ตอนนี้
let editingSongId = null, editingCatId = null, editingDjId = null, editingPlaylistId = null;
let pendingSongFile = null, pendingCoverFile = null, pendingDjImageFile = null, existingDjImageUrl = "";
let pendingPlaylistCoverFile = null, existingPlaylistCoverUrl = "";
let pendingFullSongFile = null, existingFullFileUrl = "";

// 🔧 (2026-09-24 SEO/perf): ย่อ+บีบอัดรูปภาพในเบราว์เซอร์ก่อนอัปโหลด (ปกเพลง/รูป DJ/ปกเพลย์ลิสต์)
//   เหตุผล: PageSpeed Insights พบรูปที่อัปโหลดจริงมีขนาด 1640x1647 แต่แสดงผลแค่ ~105x151
//   ทำให้เว็บโหลดช้า (คะแนนประสิทธิภาพมือถือ 69) — ฟังก์ชันนี้ย่อรูปเหลือด้านยาวสุด ~900px
//   และแปลงเป็น JPEG คุณภาพ 85% ก่อนส่งเข้า pipeline อัปโหลดเดิม (uploadToCloudinary → R2) ทุกอย่างเหมือนเดิม
//   ไม่กระทบ: endpoint /api/upload, storage-adapter.js, DB, ชื่อฟิลด์ — ส่งแค่ File ที่เล็กลงแทนตัวเดิม
//   ปลอดภัย: ถ้าย่อไม่สำเร็จ (เบราว์เซอร์เก่า/ไฟล์เสีย) จะคืนไฟล์ต้นฉบับกลับไปใช้แทนทันที ไม่ทำให้อัปโหลดพัง
async function compressImageFile(file, maxDim = 900, quality = 0.85) {
  try {
    if (!file || !file.type || !file.type.startsWith("image/")) return file;
    if (file.size < 300 * 1024) return file; // ไฟล์เล็กอยู่แล้ว (<300KB) ไม่ต้องย่อซ้ำ
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
    if (scale >= 1) { bitmap.close && bitmap.close(); return file; } // รูปเล็กอยู่แล้ว ไม่ต้องย่อ
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close && bitmap.close();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    if (!blob) return file; // เผื่อ toBlob คืน null (บางเบราว์เซอร์เก่า)
    const newName = file.name.replace(/\.[^.]+$/, "") + ".jpg";
    return new File([blob], newName, { type: "image/jpeg" });
  } catch (err) {
    console.warn("compressImageFile: ย่อรูปไม่สำเร็จ ใช้ไฟล์ต้นฉบับแทน", err);
    return file; // ผิดพลาดอะไรก็ตาม → ใช้ไฟล์เดิม ไม่ทำให้ผู้ใช้อัปโหลดไม่ได้
  }
}
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
//
// 🔒 Security (2026-09-17 P1): แก้ Bug 4 — ถ้า checkHasAdmin() error → แสดงทั้ง login + ปุ่ม bootstrap
//   เดิม: error → return true → โหมด login ปกติ → ถ้าไม่มี admin → user ติดหน้า login ไม่มีทางออก
//   ใหม่: error → return null → แสดง login form + เพิ่มปุ่ม "ตั้งค่าแอดมินคนแรก" ให้เลือกเอง
let LOGIN_BOOTSTRAP_MODE = false;
(async () => {
  try {
    const hasAdmin = await checkHasAdmin();
    if (hasAdmin === false) {
      // ไม่มี admin แน่นอน → โหมด bootstrap (เหมือนเดิม)
      LOGIN_BOOTSTRAP_MODE = true;
      document.getElementById("loginTitle").textContent = "ตั้งค่าแอดมินคนแรก";
      document.getElementById("loginSubtitle").textContent = "ยังไม่มีแอดมินในระบบ — สร้างบัญชีแอดมินหลักคนแรกที่นี่";
      document.getElementById("loginDisplayNameField").style.display = "block";
      document.getElementById("loginBtn").textContent = "สร้างแอดมินคนแรก";
    } else if (hasAdmin === null) {
      // 🔧 (2026-09-17 P1): checkHasAdmin error → แสดง login + ปุ่ม bootstrap ให้เลือก
      //   ไม่ติดหน้า login ถ้าไม่มี admin จริง ๆ
      const loginError = document.getElementById("loginError");
      if (loginError) {
        loginError.textContent = "⚠️ ไม่สามารถตรวจสอบสถานะระบบได้ — หากยังไม่มีแอดมิน ให้คลิกปุ่มด้านล่าง";
        loginError.style.color = "var(--text-dim)";
      }
      // เพิ่มปุ่ม "ตั้งค่าแอดมินคนแรก" ใต้ปุ่ม login
      const loginBtn = document.getElementById("loginBtn");
      if (loginBtn && !document.getElementById("bootstrapFallbackBtn")) {
        const bootstrapBtn = document.createElement("button");
        bootstrapBtn.id = "bootstrapFallbackBtn";
        bootstrapBtn.type = "button";
        bootstrapBtn.className = "btn secondary";
        bootstrapBtn.style.cssText = "margin-top:10px;width:100%;font-size:13px;";
        bootstrapBtn.textContent = "ตั้งค่าแอดมินคนแรก (ถ้ายังไม่มี)";
        bootstrapBtn.addEventListener("click", () => {
          LOGIN_BOOTSTRAP_MODE = true;
          document.getElementById("loginTitle").textContent = "ตั้งค่าแอดมินคนแรก";
          document.getElementById("loginSubtitle").textContent = "สร้างบัญชีแอดมินหลักคนแรกที่นี่";
          document.getElementById("loginDisplayNameField").style.display = "block";
          document.getElementById("loginBtn").textContent = "สร้างแอดมินคนแรก";
          bootstrapBtn.style.display = "none";
          if (loginError) loginError.textContent = "";
        });
        loginBtn.parentNode.insertBefore(bootstrapBtn, loginBtn.nextSibling);
      }
    }
    // hasAdmin === true → โหมด login ปกติ (ไม่ต้องทำอะไร)
  } catch (err) {
    console.error("checkHasAdmin error:", err);
    // fallback: ปล่อยเป็นโหมด login ปกติ (ถ้ามี admin อยู่แล้ว login ได้ปกติ)
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
document.getElementById("logoutBtn").addEventListener("click", () => {
  // 🔧 (2026-09-22 fix Bug #2 UI v4): เปิด modal ให้เลือกก่อน logout จริง
  //   เดิม: คลิก ⎋ → signOut ทันที → กดผิดง่าย
  //   ใหม่: คลิก ⎋ → เปิด modal ให้เลือก "ดูหน้าร้าน" / "ออกจากระบบ" / "ยกเลิก"
  const bd = document.getElementById("logoutConfirmBackdrop");
  if (bd) bd.style.display = "flex";
});

// ปุ่มปิด modal ยืนยัน logout
document.getElementById("logoutConfirmClose")?.addEventListener("click", () => {
  document.getElementById("logoutConfirmBackdrop").style.display = "none";
});
// ปุ่ม "ดูหน้าร้าน" ใน modal → ปิด modal ก่อน แล้วให้ <a target="_blank"> เปิดแท็บใหม่
//   (session ค้างอยู่ใน cookie → แท็บใหม่ยังคง login อยู่)
document.getElementById("logoutConfirmViewStore")?.addEventListener("click", () => {
  document.getElementById("logoutConfirmBackdrop").style.display = "none";
  // ไม่ preventDefault → ปล่อยให้ browser เปิด href="/" ในแท็บใหม่ (target="_blank")
});
// ปุ่ม "ออกจากระบบ" จริง ๆ ใน modal
document.getElementById("logoutConfirmLogout")?.addEventListener("click", () => {
  document.getElementById("logoutConfirmBackdrop").style.display = "none";
  signOut(auth);
});
// ปิด modal เมื่อคลิกพื้นหลัง
document.getElementById("logoutConfirmBackdrop")?.addEventListener("click", (e) => {
  if (e.target.id === "logoutConfirmBackdrop") {
    e.currentTarget.style.display = "none";
  }
});

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
    // 🔒 Security (2026-09-17 P0): ส่ง currentPassword ไปที่ updatePassword ด้วย
    //   เดิม: ส่งแค่ newPassword → server ไม่ verify เดิม
    //   ใหม่: ส่ง currentPassword ไปด้วย → server verify อีกทีก่อนเปลี่ยน (กัน session theft)
    //   reauthenticateWithCredential ข้างบนเป็นแค่ client-side UX check (early failure เร็ว)
    //   แต่ server-side verification จริง ๆ ทำใน /api/auth/change-password อีกที
    await updatePassword(user, newPassword, currentPassword);
    feedback.style.color = "var(--success)";
    feedback.textContent = "เปลี่ยนรหัสผ่านสำเร็จแล้ว ✓";
    showToast("เปลี่ยนรหัสผ่านสำเร็จ", "success");
    setTimeout(() => { document.getElementById("changePasswordBackdrop").classList.remove("show"); }, 1000);
  } catch (err) {
    if (err && err.code === "auth/wrong-password") feedback.textContent = "รหัสผ่านปัจจุบันไม่ถูกต้อง";
    else if (err && err.code === "auth/current-password-required") feedback.textContent = "กรุณากรอกรหัสผ่านปัจจุบัน";
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
  const el = document.getElementById(id);
  // 🔧 (2026-09-19 mobile fix v7): บังคับ width 100% ทุกครั้งที่ show view
  //   เหตุผล: เดิม set แค่ display: block → บางครั้ง width ไม่เต็มจอ (โดยเฉพาะ iPad)
  //   วิธีแก้: set width: 100% + box-sizing: border-box ด้วย → ทุก view เต็มจอเสมอ
  //   ผลกระทบต่อระบบเดิม: 0% — เป็นการเพิ่ม inline style ที่เหมือน CSS class .view อยู่แล้ว
  el.style.display = "block";
  el.style.width = "100%";
  el.style.boxSizing = "border-box";
  el.style.maxWidth = "none";
}
document.querySelectorAll(".back-btn").forEach(b => b.addEventListener("click", () => { showView("view-dashboard"); loadDashboard(); }));
document.getElementById("qaAddSong").addEventListener("click", async () => { showView("view-songs"); await loadSongs(); openAddSong(); });
document.getElementById("qaManageSongs").addEventListener("click", () => { showView("view-songs"); loadSongs(); });
document.getElementById("qaManageCats").addEventListener("click", () => { showView("view-categories"); loadCategories(); });
document.getElementById("qaManageDjs").addEventListener("click", () => { showView("view-djs"); loadDjs(); });
document.getElementById("qaManagePlaylists").addEventListener("click", () => { showView("view-playlists"); loadPlaylists(); });
document.getElementById("qaBulkUpload").addEventListener("click", () => { openBulkUpload(); });
document.getElementById("qaOrders").addEventListener("click", () => { showView("view-orders"); initOrdersView(); });
// 📸 (added STEP 5) — slip verification queue
document.getElementById("qaPayments")?.addEventListener("click", () => { showView("view-payments"); initPaymentsView(); });
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

// ===== ประวัติร้าน (Audit Log) — Bug #2 UI =====
//   หน้านี้ใช้ดู audit_log table ที่ worker บันทึกไว้
//   ทุกแอดมินที่ login แล้วเข้าดูได้ (ตาม model "เพื่อนๆ ช่วยกันดูแล" ที่ผู้ใช้ระบุ)
const AUDIT_LOG_PAGE_SIZE = 50;
let auditLogState = { offset: 0, total: 0, loading: false };

document.getElementById("qaAuditLog").addEventListener("click", () => {
  showView("view-auditlog");
  // reset filter + โหลดหน้า 1
  auditLogState.offset = 0;
  ["auditFilterAction", "auditFilterCollection", "auditFilterEmail", "auditFilterFromDate", "auditFilterToDate"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
  loadAuditLog();
});

document.getElementById("auditLogRefreshBtn")?.addEventListener("click", () => loadAuditLog());
document.getElementById("auditFilterApplyBtn")?.addEventListener("click", () => {
  auditLogState.offset = 0;
  loadAuditLog();
});

// Enter ในช่อง email หรือ date ก็ trigger filter
["auditFilterEmail", "auditFilterFromDate", "auditFilterToDate"].forEach(id => {
  document.getElementById(id)?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      auditLogState.offset = 0;
      loadAuditLog();
    }
  });
});

// ส่ง query ไป worker — รับ filter จาก input + paginate ผ่าน offset
async function loadAuditLog() {
  if (auditLogState.loading) return;
  auditLogState.loading = true;

  const listEl = document.getElementById("auditLogList");
  const statsEl = document.getElementById("auditLogStats");
  const pagerEl = document.getElementById("auditLogPager");

  // Loading state
  listEl.innerHTML = `<div style="text-align:center;padding:30px 0;color:var(--text-dim);font-size:13px;">⏳ กำลังโหลด...</div>`;
  statsEl.textContent = "";
  pagerEl.innerHTML = "";

  // รวบรวม filter
  const body = {
    limit: AUDIT_LOG_PAGE_SIZE,
    offset: auditLogState.offset,
    action:     document.getElementById("auditFilterAction")?.value || "",
    collection: document.getElementById("auditFilterCollection")?.value || "",
    admin_email:document.getElementById("auditFilterEmail")?.value.trim() || "",
    from_date: document.getElementById("auditFilterFromDate")?.value || "",
    to_date:   document.getElementById("auditFilterToDate")?.value || "",
  };

  try {
    const res = await fetch("/api/db/_meta/_audit-log-query", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status === 401) {
      listEl.innerHTML = `<div style="text-align:center;padding:30px 16px;color:var(--text-dim);font-size:13px;">กรุณาเข้าสู่ระบบใหม่</div>`;
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    // กรณี table ยังไม่ถูกสร้าง → แสดง hint
    if (data.needs_schema) {
      listEl.innerHTML = `<div style="text-align:center;padding:30px 16px;color:var(--text-dim);font-size:13px;">
        ⚠️ ตาราง audit_log ยังไม่ถูกสร้าง<br>
        <span style="font-size:12px;">รัน schema.sql ล่าสุดใน D1 Console → แล้วกด 🔄 โหลดใหม่</span>
      </div>`;
      return;
    }

    auditLogState.total = Number(data.total) || 0;
    renderAuditLog(data.logs || []);
    renderAuditPager();
  } catch (err) {
    console.error("[auditLog] load failed:", err);
    listEl.innerHTML = `<div style="text-align:center;padding:30px 16px;color:#ff6b6b;font-size:13px;">โหลดประวัติไม่สำเร็จ — ลองอีกครั้ง</div>`;
    showToast("โหลดประวัติร้านไม่สำเร็จ", "error");
  } finally {
    auditLogState.loading = false;
  }
}

function renderAuditLog(logs) {
  const listEl = document.getElementById("auditLogList");
  const statsEl = document.getElementById("auditLogStats");

  if (!logs.length) {
    listEl.innerHTML = `<div style="text-align:center;padding:40px 16px;color:var(--text-dim);font-size:13px;">ไม่มีรายการตามตัวกรองที่เลือก</div>`;
    statsEl.textContent = "";
    return;
  }

  // Stats summary
  const fromIdx = auditLogState.offset + 1;
  const toIdx = Math.min(auditLogState.offset + logs.length, auditLogState.total);
  statsEl.textContent = `แสดง ${fromIdx}-${toIdx} จาก ${auditLogState.total} รายการ`;

  // Render rows — ใช้ DocumentFragment + event delegation เพื่อ performance (เหมือน Bug #7 pattern)
  const frag = document.createDocumentFragment();
  for (const log of logs) {
    const row = document.createElement("div");
    row.className = "audit-log-row";
    row.dataset.id = String(log.id);

    const actionLabel = AUDIT_ACTION_LABELS[log.action] || log.action;
    const actionClass = `audit-action-${log.action || "other"}`;
    const time = formatAuditTime(log.created_at);

    // 🔧 (2026-09-22 fix Bug #2 UI v2): สร้างคำอธิบายแบบภาษาคน ๆ แทน target_name + JSON ดิบ
    //   - ลบ: "ลบเพลง: เพลง A"
    //   - แก้ไข: "แก้ไขเพลง: เพลง A — เปลี่ยนชื่อเพลงจาก A เป็น B"
    //   - สร้าง: "สร้างเพลงใหม่: เพลง A"
    const summaryHtml = generateHumanReadableSummary(log);

    row.innerHTML = `
      <div class="audit-row-main" style="display:flex;align-items:flex-start;gap:10px;padding:12px 14px;cursor:pointer;">
        <span class="audit-action-pill ${actionClass}" style="margin-top:1px;">${escapeHtml(actionLabel)}</span>
        <div style="flex:1;min-width:0;">
          <div style="font-size:14px;line-height:1.5;color:var(--text);">
            ${summaryHtml}
          </div>
          <div style="font-size:12px;color:var(--text-dim);margin-top:5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
            ${escapeHtml(log.admin_email || "unknown")} · ${escapeHtml(log.ip_address || "—")} · ${escapeHtml(time)}
          </div>
        </div>
        <span class="audit-expand-icon" style="color:var(--text-dim);font-size:18px;flex-shrink:0;">▸</span>
      </div>
      <div class="audit-row-detail" style="display:none;padding:12px 14px 14px;border-top:1px dashed rgba(255,255,255,.08);">
        <details style="margin-top:8px;">
          <summary style="font-size:12px;font-weight:700;color:var(--text-dim);cursor:pointer;user-select:none;padding:4px 0;">📋 ดูข้อมูลดิบ (JSON)</summary>
          <div style="font-size:11px;color:var(--text-dim);margin-top:8px;margin-bottom:8px;">
            <div>📌 ID: <code style="background:rgba(255,255,255,.06);padding:1px 6px;border-radius:4px;">${escapeHtml(String(log.target_id || "—").slice(0, 50))}</code></div>
            <div style="margin-top:4px;">👤 admin_id: <code style="background:rgba(255,255,255,.06);padding:1px 6px;border-radius:4px;">${escapeHtml(log.admin_id || "—")}</code></div>
            <div style="margin-top:4px;">🔢 log_id: <code style="background:rgba(255,255,255,.06);padding:1px 6px;border-radius:4px;">${escapeHtml(String(log.id))}</code></div>
          </div>
          <div style="display:flex;gap:10px;margin-top:8px;flex-wrap:wrap;">
            <div style="flex:1;min-width:240px;">
              <div style="font-size:11px;color:var(--text-dim);margin-bottom:4px;">ก่อนเปลี่ยน (before)</div>
              <pre style="background:rgba(0,0,0,.3);border-radius:6px;padding:10px;font-size:11px;overflow-x:auto;max-height:240px;color:#f1f1f1;margin:0;">${escapeHtml(formatJsonForDisplay(log.before_data))}</pre>
            </div>
            <div style="flex:1;min-width:240px;">
              <div style="font-size:11px;color:var(--text-dim);margin-bottom:4px;">หลังเปลี่ยน (after)</div>
              <pre style="background:rgba(0,0,0,.3);border-radius:6px;padding:10px;font-size:11px;overflow-x:auto;max-height:240px;color:#f1f1f1;margin:0;">${escapeHtml(formatJsonForDisplay(log.after_data))}</pre>
            </div>
          </div>
        </details>
      </div>
    `;

    // toggle expand on click
    row.querySelector(".audit-row-main").addEventListener("click", () => {
      const detail = row.querySelector(".audit-row-detail");
      const icon = row.querySelector(".audit-expand-icon");
      const isOpen = detail.style.display !== "none";
      detail.style.display = isOpen ? "none" : "block";
      icon.textContent = isOpen ? "▸" : "▾";
    });

    frag.appendChild(row);
  }
  listEl.innerHTML = "";
  listEl.appendChild(frag);
}

// pagination controls — prev/next + page indicator
function renderAuditPager() {
  const pagerEl = document.getElementById("auditLogPager");
  const total = auditLogState.total;
  const offset = auditLogState.offset;
  const pageSize = AUDIT_LOG_PAGE_SIZE;

  pagerEl.innerHTML = "";

  if (total === 0) return;

  const hasPrev = offset > 0;
  const hasNext = offset + pageSize < total;

  const prevBtn = document.createElement("button");
  prevBtn.className = "btn secondary";
  prevBtn.style.cssText = "padding:8px 14px;font-size:13px;";
  prevBtn.textContent = "← ก่อนหน้า";
  prevBtn.disabled = !hasPrev;
  if (!hasPrev) prevBtn.style.opacity = "0.4";
  prevBtn.addEventListener("click", () => {
    if (hasPrev && !auditLogState.loading) {
      auditLogState.offset = Math.max(0, offset - pageSize);
      loadAuditLog();
      //  scroll to top of list
      document.getElementById("view-auditlog")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  });

  const pageInfo = document.createElement("span");
  pageInfo.style.cssText = "font-size:12px;color:var(--text-dim);";
  const curPage = Math.floor(offset / pageSize) + 1;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  pageInfo.textContent = `หน้า ${curPage} / ${totalPages}`;

  const nextBtn = document.createElement("button");
  nextBtn.className = "btn secondary";
  nextBtn.style.cssText = "padding:8px 14px;font-size:13px;";
  nextBtn.textContent = "ถัดไป →";
  nextBtn.disabled = !hasNext;
  if (!hasNext) nextBtn.style.opacity = "0.4";
  nextBtn.addEventListener("click", () => {
    if (hasNext && !auditLogState.loading) {
      auditLogState.offset = offset + pageSize;
      loadAuditLog();
      document.getElementById("view-auditlog")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  });

  pagerEl.appendChild(prevBtn);
  pagerEl.appendChild(pageInfo);
  pagerEl.appendChild(nextBtn);
}

function formatAuditTime(isoStr) {
  if (!isoStr) return "—";
  try {
    const d = new Date(isoStr);
    if (isNaN(d.getTime())) return isoStr;
    // ใช้ locale th-TH + เวลาท้องถิ่น (Asia/Vientiane)
    //   format: 22 ก.ย. 2026, 14:30
    const datePart = d.toLocaleDateString("th-TH", { day: "2-digit", month: "short", year: "numeric" });
    const timePart = d.toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit", hour12: false });
    return `${datePart} ${timePart}`;
  } catch { return isoStr; }
}

function formatJsonForDisplay(obj) {
  if (obj == null) return "(ไม่มีข้อมูล)";
  if (typeof obj === "string") return obj;
  try {
    return JSON.stringify(obj, null, 2);
  } catch {
    return String(obj);
  }
}

const AUDIT_ACTION_LABELS = {
  create:        "➕ สร้าง",
  update:        "✎ แก้ไข",
  delete:        "🗑 ลบ",
  status_change: "🔄 เปลี่ยนสถานะ",
  zip_create:    "📦 สร้าง ZIP",
  zip_delete:    "📦 ลบ ZIP",
  upload:        "📤 อัปโหลด",
};

const AUDIT_COLLECTION_LABELS = {
  songs:       "เพลง",
  playlists:   "เพลย์ลิสต์",
  orders:      "ออเดอร์",
  categories:  "หมวดหมู่",
  djs:         "DJ",
  settings:    "ตั้งค่าเว็บ",
  promotions:  "โปรโมชั่น",
  discounts:   "ลดราคา",
  admins:      "แอดมิน",
  // 📸 (added STEP 5) — slip verification audit log
  payment_proofs: "หลักฐานการชำระ",
};

// 🔧 (2026-09-22 fix Bug #2 UI v2): map field name → ป้ายภาษาไทย
//   ใช้ใน generateHumanReadableSummary เพื่อแสดง diff ของการแก้ไขเป็นภาษาคนอ่านได้
//   ฟิลด์ที่ไม่อยู่ใน map → แสดงชื่อเดิม (ภาษาอังกฤษ) ได้เลย
const AUDIT_FIELD_LABELS = {
  // common fields
  song_name:         "ชื่อเพลง",
  playlist_name:     "ชื่อเพลย์ลิสต์",
  customer_name:     "ชื่อลูกค้า",
  dj_name:           "ชื่อ DJ",
  dj_id:             "DJ",
  category_id:       "หมวดหมู่",
  category_name:     "หมวดหมู่",
  name:              "ชื่อ",
  title:             "ชื่อเรื่อง",
  description:       "คำอธิบาย",
  price:             "ราคา",
  total_price:       "ยอดรวม",
  unit_price:        "ราคา/หน่วย",
  quantity:          "จำนวน",
  whatsapp:          "เบอร์ WhatsApp",
  phone:             "เบอร์โทร",
  email:             "อีเมล",
  role:              "บทบาท",
  status:            "สถานะ",
  receipt_number:    "เลขใบเสร็จ",
  cover_url:         "รูปปก",
  preview_url:       "ไฟล์พรีวิว",
  preview_start:     "จุดเริ่มพรีวิว",
  preview_end:       "จุดจบพรีวิว",
  full_file_url:     "ไฟล์เต็ม (WAV)",
  file_url:          "ไฟล์",
  notes:             "หมายเหตุ",
  payment_method:    "วิธีชำระเงิน",
  payment_slip_url:  "หลักฐานการโอน",
  transferred_at:    "วันที่โอน",
  confirmed_at:      "วันที่ยืนยัน",
  rejected_at:       "วันที่ปฏิเสธ",
  completed_at:      "วันที่เสร็จสิ้น",
  cancelled_at:      "วันที่ยกเลิก",
  created_at:        "วันที่สร้าง",
  updated_at:        "วันที่อัปเดต",
  zip_status:        "สถานะ ZIP",
  zip_download_url:  "URL ดาวน์โหลด ZIP",
  zip_created_at:    "วันที่สร้าง ZIP",
  zip_expired_at:    "วันที่ ZIP หมดอายุ",
  zip_file_name:     "ชื่อไฟล์ ZIP",
  zip_public_id:     "ID ไฟล์ ZIP",
  website_name:      "ชื่อเว็บไซต์",
  website_logo:      "โลโก้เว็บ",
  meta_description:  "คำอธิบายเว็บ (SEO)",
  whatsapp_number:   "เบอร์ WhatsApp ร้าน",
  bank_name:         "ชื่อธนาคาร",
  bank_account:      "เลขบัญชี",
  bank_account_name: "ชื่อบัญชี",
  active:            "เปิดใช้งาน",
  is_active:         "เปิดใช้งาน",
  start_date:        "วันเริ่มต้น",
  end_date:          "วันสิ้นสุด",
  discount_percent:  "เปอร์เซ็นต์ลด",
  discount_amount:   "ยอดลด",
  min_songs:        "ขั้นต่ำจำนวนเพลง",
  priority:          "ลำดับความสำคัญ",
  display_name:      "ชื่อที่แสดง",
  password_changed_at: "วันที่เปลี่ยนรหัสผ่าน",
};

// map ค่า status ของออเดอร์ → ภาษาไทย (ใช้ใน diff summary)
const AUDIT_STATUS_LABELS = {
  pending_verify: "รอตรวจสอบการโอน",
  confirmed:      "ยืนยันแล้ว",
  rejected:       "ปฏิเสธ",
  completed:      "เสร็จสิ้น",
  cancelled:      "ยกเลิก",
  ready:          "พร้อมดาวน์โหลด",
  expired:        "หมดอายุ",
  failed:         "ล้มเหลว",
};

// ตัดสินใจว่าฟิลด์นี้ควรข้ามใน diff หรือไม่ (ฟิลด์ที่เปลี่ยนเองโดยระบบ/ไม่สำคัญต่อ audit)
// 🔧 (2026-09-22 fix Bug #2 UI v3): เพิ่ม created_at, id และ field ระบบอื่น ๆ กัน diff แสดง "ลบวันที่สร้างออก"
//   หรือ "เพิ่ม id: xxx" ที่คนทั่วไปไม่สนใจ
const AUDIT_IGNORED_FIELDS = new Set([
  "updated_at",      // อัปเดตอัตโนมัติทุกครั้ง → ไม่สำคัญ
  "created_at",      // ตั้งตอนสร้าง → ไม่ควรเปลี่ยน → ถ้าเปลี่ยนแปลว่าระบบ auto-set ไม่ใช่ action ของแอดมิน
  "id",              // primary key → ไม่ใช่ field ที่ user แก้เอง
  "password",        // รหัสผ่าน (sensitive — ไม่ควรโชว์ใน diff แม้จะ hash แล้ว)
  "password_hash",   // hash รหัสผ่าน (เหมือนกัน)
  "session_token",   // session token (sensitive)
  "zip_created_at",  // ตั้งโดย cron/ZIP flow → ไม่ใช่ action ของแอดมิน
  "zip_expired_at",
  "zip_public_id",
  "zip_status",      // จะแสดงเป็น "สถานะ ZIP" อยู่แล้ว ถ้าเปลี่ยนจริงๆ
  "uid",             // Firebase legacy UID (ย้ายไป D1 แล้ว แต่ field ยังอยู่)
]);

// สร้างคำอธิบายแบบภาษาคน ๆ สำหรับ log 1 รายการ
//   - สร้าง: "สร้างเพลงใหม่: เพลง A"
//   - ลบ:    "ลบเพลง: เพลง A"
//   - แก้ไข: "แก้ไขเพลง: เพลง A — เปลี่ยนชื่อเพลงจาก A เป็น B, เปลี่ยนราคาจาก 100 เป็น 200"
//   - เปลี่ยนสถานะ: "เปลี่ยนสถานะออเดอร์: RCPT-xxx — จากรอตรวจสอบการโอน เป็น ยืนยันแล้ว"
// ส่งกลับ HTML string (มี <strong> ครอบชื่อ target)
function generateHumanReadableSummary(log) {
  const collectionLabel = AUDIT_COLLECTION_LABELS[log.collection] || log.collection;
  const targetName = log.target_name || log.target_id || "—";
  const targetHtml = `<strong style="color:var(--text);">${escapeHtml(String(targetName).slice(0, 100))}</strong>`;

  // กระทำ "สร้าง"
  if (log.action === "create") {
    return `สร้าง${collectionLabel}ใหม่: ${targetHtml}`;
  }

  // กระทำ "ลบ"
  if (log.action === "delete") {
    return `ลบ${collectionLabel}: ${targetHtml}`;
  }

  // กระทำ "แก้ไข" — แสดง diff ของฟิลด์ที่เปลี่ยน (ไม่ใช้ JSON ดิบ)
  if (log.action === "update") {
    const changes = computeDiff(log.before_data, log.after_data);
    if (changes.length === 0) {
      return `แก้ไข${collectionLabel}: ${targetHtml} <span style="color:var(--text-dim);">(ไม่มีการเปลี่ยนแปลงที่สำคัญ)</span>`;
    }
    // limit 5 changes แรก — กัน case ที่แก้ทุกฟิลด์จนประโยคยาวเกิน
    const visible = changes.slice(0, 5);
    const extra = changes.length > 5 ? ` และอีก ${changes.length - 5} รายการ` : "";
    const changeSummary = visible.map(formatChange).join(" · ") + extra;
    return `แก้ไข${collectionLabel}: ${targetHtml} — ${changeSummary}`;
  }

  // กระทำ "เปลี่ยนสถานะ" — ใช้ status labels
  if (log.action === "status_change") {
    const beforeStatus = log.before_data?.status;
    const afterStatus = log.after_data?.status;
    const beforeLabel = AUDIT_STATUS_LABELS[beforeStatus] || beforeStatus || "—";
    const afterLabel = AUDIT_STATUS_LABELS[afterStatus] || afterStatus || "—";
    return `เปลี่ยนสถานะ${collectionLabel}: ${targetHtml} — จาก <strong>${escapeHtml(beforeLabel)}</strong> เป็น <strong>${escapeHtml(afterLabel)}</strong>`;
  }

  // กระทำอื่นๆ (zip_create, zip_delete, upload)
  const actionLabel = AUDIT_ACTION_LABELS[log.action] || log.action;
  return `${actionLabel} ${collectionLabel}: ${targetHtml}`;
}

// คำนวณ diff ระหว่าง before กับ after — return array ของ { type, field, label, before, after }
//   type: "changed" | "added" | "removed"
//   ข้ามฟิลด์ที่อยู่ใน AUDIT_IGNORED_FIELDS + ฟิลด์ที่เป็น object/array ซ้อน (ยกเว้น items ที่จะแสดงสรุป)
function computeDiff(before, after) {
  if (!before || typeof before !== "object") return [];
  if (!after || typeof after !== "object") return [];

  const changes = [];
  const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);

  for (const key of allKeys) {
    // ข้ามฟิลด์ที่ระบบอัปเดตเอง
    if (AUDIT_IGNORED_FIELDS.has(key)) continue;

    const beforeVal = before[key];
    const afterVal = after[key];
    const label = AUDIT_FIELD_LABELS[key] || key;

    // กรณีเป็น array หรือ object ซ้อน → ข้าม (ยกเว้น items ของ order)
    //   จริง ๆ ควรแสดง "จำนวนเพลงในออเดอร์เปลี่ยนจาก X เป็น Y"
    if (key === "items" && Array.isArray(beforeVal) && Array.isArray(afterVal)) {
      const beforeCount = beforeVal.length;
      const afterCount = afterVal.length;
      if (beforeCount !== afterCount) {
        changes.push({ type: "changed", field: key, label: "จำนวนเพลงในออเดอร์", before: `${beforeCount} เพลง`, after: `${afterCount} เพลง` });
      }
      continue;
    }

    // ข้ามฟิลด์ที่เป็น object/array ซ้อน (ยากต่อการแสดงใน 1 บรรทัด)
    if ((beforeVal && typeof beforeVal === "object") || (afterVal && typeof afterVal === "object")) {
      continue;
    }

    if (beforeVal === undefined && afterVal !== undefined) {
      changes.push({ type: "added", field: key, label, before: null, after: afterVal });
    } else if (beforeVal !== undefined && afterVal === undefined) {
      changes.push({ type: "removed", field: key, label, before: beforeVal, after: null });
    } else if (String(beforeVal) !== String(afterVal)) {
      // กรณีเป็น status → แปลเป็นภาษาไทย
      const beforeDisplay = (key === "status" && AUDIT_STATUS_LABELS[beforeVal]) ? AUDIT_STATUS_LABELS[beforeVal] : beforeVal;
      const afterDisplay = (key === "status" && AUDIT_STATUS_LABELS[afterVal]) ? AUDIT_STATUS_LABELS[afterVal] : afterVal;
      changes.push({ type: "changed", field: key, label, before: beforeDisplay, after: afterDisplay });
    }
  }

  return changes;
}

// จัดรูปแบบ change 1 รายการเป็นประโยคไทย — ซ่อน URL/path/timestamp ที่คนทั่วไปอ่านไม่รู้เรื่อง
//   - changed: "เปลี่ยนชื่อเพลงจาก A เป็น B" หรือ "เปลี่ยนรูปปก" (ถ้าค่าเป็น URL)
//   - added:   "เพิ่มราคา: 200" หรือ "อัปโหลดรูปปกใหม่" (ถ้าค่าเป็น URL)
//   - removed: "ลบหมายเหตุ (เดิม: xxx)"
function formatChange(change) {
  const label = change.label;
  const beforeStr = change.before == null ? "" : String(change.before);
  const afterStr = change.after == null ? "" : String(change.after);

  // 🔧 (2026-09-22 fix Bug #2 UI v3): ซ่อนค่าที่คนทั่วไปอ่านไม่รู้เรื่อง
  //   - URL ยาว (https://...) → แสดงแค่ "เปลี่ยน[label]" ไม่โชว์ URL
  //   - file path (.svg, .png, .mp3, ...) → แสดงแค่ "เปลี่ยน[label]"
  //   - ISO timestamp → แสดงแค่ "เปลี่ยน[label]" ไม่โชว์ raw date
  //   ทั้งนี้เพื่อให้ประโยคสั้น และคนอ่านได้เข้าใจความหมายโดยไม่ต้องดู code
  const isUrlOrPath = (val) => {
    if (val == null) return false;
    const s = String(val).toLowerCase();
    // URL เต็ม (http/https)
    if (s.startsWith("http://") || s.startsWith("https://")) return true;
    // absolute path
    if (s.startsWith("/api/") || s.startsWith("/uploads/")) return true;
    // มี file extension (.svg, .png, .jpg, .mp3, .wav, .zip, ...)
    if (/\.[a-z0-9]{2,4}($|\?)/.test(s)) return true;
    // เป็น UUID หรือ hash ยาว ๆ (เช่น r2 object key)
    if (s.length > 40 && /^[a-z0-9\-_]+$/i.test(s)) return true;
    return false;
  };
  const isTimestamp = (val) => {
    if (val == null) return false;
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(String(val));
  };

  const beforeIsTechnical = isUrlOrPath(beforeStr) || isTimestamp(beforeStr);
  const afterIsTechnical  = isUrlOrPath(afterStr)  || isTimestamp(afterStr);

  // กรณีค่าเป็น URL/path/timestamp → ซ่อนค่าทิ้ง แสดงแค่คำอธิบายสั้น ๆ
  if (beforeIsTechnical || afterIsTechnical) {
    if (change.type === "changed") {
      // ใช้คำว่า "อัปโหลดใหม่" สำหรับ field ที่เป็นไฟล์ (cover_url, preview_url, ...)
      if (afterIsTechnical && !beforeIsTechnical) {
        return `อัปโหลด<em style="color:var(--text-dim);font-style:normal;">${escapeHtml(label)}</em>ใหม่`;
      }
      return `เปลี่ยน<em style="color:var(--text-dim);font-style:normal;">${escapeHtml(label)}</em>`;
    }
    if (change.type === "added") {
      return `อัปโหลด<em style="color:var(--text-dim);font-style:normal;">${escapeHtml(label)}</em>ใหม่`;
    }
    if (change.type === "removed") {
      return `ลบ<em style="color:var(--text-dim);font-style:normal;">${escapeHtml(label)}</em>ออก`;
    }
  }

  // กรณีทั่วไป — แสดงค่าจริง แต่ตัดถ้ายาวเกิน 50 ตัวอักษร (กันประโยคยาวเกิน)
  const trimVal = (v) => v.length > 50 ? v.slice(0, 50) + "..." : v;

  if (change.type === "changed") {
    return `เปลี่ยน<em style="color:var(--text-dim);font-style:normal;">${escapeHtml(label)}</em>จาก "${escapeHtml(trimVal(beforeStr))}" เป็น "${escapeHtml(trimVal(afterStr))}"`;
  }
  if (change.type === "added") {
    return `เพิ่ม<em style="color:var(--text-dim);font-style:normal;">${escapeHtml(label)}</em>: "${escapeHtml(trimVal(afterStr))}"`;
  }
  if (change.type === "removed") {
    return `ลบ<em style="color:var(--text-dim);font-style:normal;">${escapeHtml(label)}</em> (เดิม: "${escapeHtml(trimVal(beforeStr))}")`;
  }
  return "";
}


// 🔧 (2026-09-17 Phase 1): loadDashboard ใช้ TTL cache ลด D1 reads
//   - ถ้า CACHE ของ collection ยัง fresh (60 วิ) → skip fetch ใช้ cache
//   - ถ้า stale → fetch เฉพาะที่ stale แบบ parallel
//   - ถ้า admin save/delete → invalidateAdminCache ล้าง timestamp → ครั้งถัดไป fetch ใหม่
async function loadDashboard() {
  // 🔧 (2026-09-18 v6 Full System): ใช้ _count-all endpoint แทนการโหลด collection ทั้งหมด
  //   เดิม: loadDashboard โหลด songs/categories/djs/playlists ทั้งหมดเพื่อนับ → 10,000+ D1 reads
  //   ใหม่: ยิง _count-all endpoint → 1 D1 read per collection (4 total) → ลด 99.96%
  //   ลดเวลาจาก 5-10s → 50ms สำหรับ 10,000 เพลง
  //   CACHE.songs จะถูกโหลดทีหลังเมื่อ admin เข้าหน้า "จัดการเพลง" (loadSongs ทำงานอยู่แล้ว)
  try {
    const [songsCount, catsCount, djsCount, playlistsCount] = await Promise.all([
      fetchCountAll("songs"),
      fetchCountAll("categories"),
      fetchCountAll("djs"),
      fetchCountAll("playlists"),
    ]);
    document.getElementById("statSongs").textContent = songsCount;
    document.getElementById("statCats").textContent = catsCount;
    document.getElementById("statDjs").textContent = djsCount;
    document.getElementById("statPlaylists").textContent = playlistsCount;
  } catch (err) {
    // fallback: ถ้า _count-all endpoint fail → แสดง "?" (ไม่โหลด collection ทั้งหมด)
    console.warn("loadDashboard: count-all failed:", err?.message);
    document.getElementById("statSongs").textContent = "?";
    document.getElementById("statCats").textContent = "?";
    document.getElementById("statDjs").textContent = "?";
    document.getElementById("statPlaylists").textContent = "?";
  }
  // 🔧 (2026-09-16): อัปเดต badge ออเดอร์ "รอตรวจสอบการโอน" ทุกครั้งที่กลับหน้า dashboard
  updateOrdersBadge();
}

// 🔧 (2026-09-18 v6 Full System): Helper สำหรับยิง _count-all endpoint
//   ใช้ใน loadDashboard → ลด D1 reads จาก 10,000+ → 1 per collection
async function fetchCountAll(coll) {
  const res = await fetch(`/api/db/${encodeURIComponent(coll)}/_count-all`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  return Number(body?.count) || 0;
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
//
// 🔧 (2026-09-17 Phase 1): เปลี่ยนจาก getDocs(collection(db,"orders")) → ยิง endpoint ใหม่ _count-pending
//   เดิม: load orders ทั้งหมดมา browser แล้ว filter ฝั่ง client → กิน D1 reads มาก (10,000 orders = 10,000 reads)
//   ใหม่: SELECT COUNT(*) WHERE status='pending_verify' → D1 คืนแค่ 1 row
//   fallback: ถ้า endpoint ใหม่ error → ใช้วิธีเดิม (getDocs + filter) ไม่ทำให้ badge พัง
// ฟังก์ชันนี้ถูก expose ผ่าน window.__updateOrdersBadge ให้ orders.js เรียกได้หลังเปลี่ยนสถานะ/สร้าง/ลบออเดอร์
async function updateOrdersBadge(orders) {
  const badgeEl = document.getElementById("ordersBadge");
  if (!badgeEl) return;
  try {
    let count;
    if (Array.isArray(orders)) {
      // กรณี orders.js ส่ง orders มาให้ → ใช้ตรงๆ ไม่ query DB (ประหยัด quota สุด)
      count = orders.filter(o => String(o?.status || "") === "pending_verify").length;
    } else {
      // กรณีไม่ได้ส่ง orders มา → ยิง count endpoint ใหม่ (ใช้ตอน login ครั้งแรก)
      try {
        const res = await fetch("/api/db/orders/_count-pending", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
        });
        if (res.ok) {
          const body = await res.json();
          count = Number(body?.count) || 0;
        } else {
          // 🔧 (2026-09-18 v6 Full System): ลบ fallback ที่โหลด orders ทั้งหมด
          //   เดิม: ถ้า endpoint fail → fallback getDocs(collection(db,"orders")) → โหลดทุก orders (10,000+ reads)
          //   ใหม่: ถ้า endpoint fail → แสดง "?" แทน (ไม่โหลด orders ทั้งหมด → ประหยัด D1 quota)
          console.warn("updateOrdersBadge: _count-pending endpoint failed (HTTP " + res.status + ")");
          count = null;  // null = ไม่รู้จำนวน → แสดง "?"
        }
      } catch (fetchErr) {
        // 🔧 (2026-09-18 v6): ลบ fallback → แสดง "?" แทน
        console.warn("updateOrdersBadge: _count-pending fetch error:", fetchErr?.message);
        count = null;
      }
    }
    // ลบ class ระดับสีเดิมออกก่อน แล้วค่อยตั้งใหม่ตามจำนวน
    badgeEl.classList.remove("warn", "alert", "critical", "show");
    if (count === null) {
      // 🔧 (2026-09-18 v6): ถ้า endpoint fail → แสดง "?" แทน (ไม่โหลด orders ทั้งหมด)
      badgeEl.textContent = "?";
      badgeEl.classList.add("warn");
      badgeEl.classList.add("show");
    } else if (count > 0) {
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

// 🔧 (2026-09-17 Phase 1): loadSongs ใช้ TTL cache ลด D1 reads (เหมือน loadDashboard)
// ถ้า admin เข้าหน้า "จัดการเพลง" หลายครั้งภายใน 60 วิ → skip fetch ใช้ cache
async function loadSongs() {
  const needSongs = !isAdminCacheFresh("songs");
  const needCats = !isAdminCacheFresh("categories");
  const needDjs = !isAdminCacheFresh("djs");
  const needPlaylists = !isAdminCacheFresh("playlists");

  const fetches = [];
  const fetchKeys = [];
  // 🔧 (2026-09-18 v6): ใช้ getDocsAdmin สำหรับ songs → bypass CDN cache
  //   ส่วน categories/djs/playlists ใช้ getDocs ปกติ (CDN cache ได้ — ไม่ค่อยเปลี่ยน)
  if (needSongs) { fetches.push(getDocsAdmin(collection(db, "songs"))); fetchKeys.push("songs"); }
  if (needCats) { fetches.push(getDocs(collection(db, "categories"))); fetchKeys.push("categories"); }
  if (needDjs) { fetches.push(getDocs(collection(db, "djs"))); fetchKeys.push("djs"); }
  if (needPlaylists) { fetches.push(getDocs(collection(db, "playlists"))); fetchKeys.push("playlists"); }

  if (fetches.length > 0) {
    const now = Date.now();
    const results = await Promise.all(fetches);
    results.forEach((snap, i) => {
      const key = fetchKeys[i];
      const mapped = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      // 🔧 (ใหม่) เรียง categories/djs/playlists ตามพยัญชนะไทย ก-ฮ + A-Z + ตัวเลข (songs ไม่แตะ — คงพฤติกรรมเดิม)
      const sortField = key === "categories" ? "category_name" : key === "djs" ? "dj_name" : key === "playlists" ? "playlist_name" : null;
      CACHE[key] = sortField ? sortByThaiName(mapped, sortField) : mapped;
      CACHE_AT[key] = now;
    });
  }
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
// 🔧 (2026-09-18 v6 Full System): incremental render — แสดง 100 แรก + "โหลดเพิ่ม" button
//   ป้องกัน browser freeze เมื่อมี 5000+ เพลง
//   state: songListVisibleCount (default 100, เพิ่ม 100 ตอนกด "โหลดเพิ่ม")
const SONG_LIST_PAGE_SIZE = 100;
let songListVisibleCount = SONG_LIST_PAGE_SIZE;

function renderSongList(list) {
  currentSongListView = list;
  const wrap = document.getElementById("songList");
  if (list.length === 0) { wrap.innerHTML = '<div class="empty-state">ยังไม่มีเพลง</div>'; return; }
  // 🔧 (2026-09-18 v6): แสดงแค่ songListVisibleCount แรก — กัน browser freeze ตอน render 5000+ cards
  const visibleList = list.slice(0, songListVisibleCount);
  const hasMore = list.length > visibleList.length;
  wrap.innerHTML = visibleList.map(s => `
    <div class="list-row" data-song-row="${s.id}" style="cursor:pointer;">
      ${songSelectMode ? `<input type="checkbox" class="song-select-chk" data-id="${s.id}" ${selectedSongIds.has(s.id) ? "checked" : ""} style="width:20px;height:20px;flex-shrink:0;">` : ""}
      <img src="${s.cover_url || ""}" loading="lazy" alt="">
      <div class="info"><div class="n1">${escapeHtml(s.song_name)}</div>
      <div class="n2">${escapeHtml(s.dj_name || "-")} · ${escapeHtml(s.category_name || "-")} · ${formatPrice(s.price)}</div>
      ${!s.full_file_url && !s.file_url ? `<div class="n2" style="color:var(--danger);">⚠️ ยังไม่มีไฟล์เต็ม (WAV) บน Cloud</div>` : ""}
      ${!s.full_file_url && s.file_url ? `<div class="n2" style="color:var(--text-dim);">🔗 ใช้ไฟล์ร่วม (file_url = full_file_url)</div>` : ""}</div>
      <div class="row-actions">
        <button class="icon-btn" data-menu="${s.id}" title="เมนู">⋮</button>
      </div>
    </div>`).join("") + (hasMore ? `<div class="load-more-row" style="padding:16px;text-align:center;background:var(--bg-card);border-radius:8px;margin-top:8px;cursor:pointer;color:var(--accent);font-weight:600;" id="loadMoreSongsBtn">⬇️ โหลดเพิ่มอีน (แสดง ${visibleList.length} จาก ${list.length} เพลง)</div>` : "");
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
  // 🔧 (2026-09-18 v6): listener สำหรับปุ่ม "โหลดเพิ่ม" → เพิ่ม songListVisibleCount อีก 100
  const loadMoreBtn = document.getElementById("loadMoreSongsBtn");
  if (loadMoreBtn) {
    loadMoreBtn.addEventListener("click", () => {
      songListVisibleCount += SONG_LIST_PAGE_SIZE;
      renderSongList(currentSongListView);
    });
  }
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
// 🔧 (2026-09-19 perf): เปลี่ยน scroll listener จาก capture phase → passive listener
//   เดิม: addEventListener("scroll", fn, true) → capture phase ทำให้ทุก scroll event ถูก intercept ก่อน → scroll หน่วง
//   ใหม่: { passive: true, capture: true } → browser รู้ล่วงหน้าว่า fn จะไม่ preventDefault() → สามารถ scroll ได้ลื่น
//   ผลกระทบต่อระบบเดิม: 0% — hideSongRowMenu ไม่ได้เรียก preventDefault อยู่แล้ว → behavior เหมือนเดิม 100%
window.addEventListener("scroll", hideSongRowMenu, { passive: true, capture: true });
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
    // 🔧 แก้บั๊ก (2026-09-17) Bug #4: ใช้ batch endpoint แทนการลูป songHasOrders() N ครั้ง
    //   เดิม: for (const id of ids) { const hasOrders = await songHasOrders(id); ... }
    //   → 50 เพลง × 10,000 orders = 500,000 D1 reads
    //   ใหม่: เรียก songsHaveOrdersBatch(ids) ครั้งเดียว → 1 × orders_total + 1 HTTP request
    const hasOrdersMap = await songsHaveOrdersBatch(ids);
    for (const id of ids) {
      const hasOrders = !!hasOrdersMap[id];
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
    invalidateAdminCache("songs");  // 🔧 (2026-09-17 Phase 1) ล้าง cache เพื่อบังคับ fetch ใหม่
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
document.getElementById("coverFileInput").addEventListener("change", async (e) => {
  const f = e.target.files[0]; if (!f) return;
  pendingCoverFile = await compressImageFile(f); // 🔧 (2026-09-24 SEO/perf) ย่อรูปก่อนเก็บ
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
    // 🔧 (2026-09-18 v6 P3.2): ใช้ adminConfirm (modal) แทน window.confirm (blocking)
    const proceed = await adminConfirm(
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
    // 🖼️ (2026-09-20): ถ้าแอดมินไม่ได้อัปโหลดรูปปกเพลง → ใช้ default-song-cover.svg อัตโนมัติ
    //   - ใช้ relative path เพื่อให้ทำงานได้ทุกที่ (admin/user โหลดจาก root เดียวกัน)
    //   - ถ้าแอดมินอัปโหลดภายหลัง → payload.cover_url จะถูก overwrite เป็น URL ของ Cloudinary
    if (!coverUrl) {
      coverUrl = "default-song-cover.svg";
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
      // 🔧 (2026-09-22 Batch 7 fix Bug #10): validate price ≥ 0 + finite number
      //   ปัญหาเดิม: Number(...|| 0) → รับค่า -100, "abc", Infinity
      //   วิธีแก้: ใช้ Number.isFinite() + ตรวจ >= 0 → fallback เป็น 0 ถ้าผิด
      price: (() => {
        const rawPrice = Number(document.getElementById("fPrice").value);
        if (!Number.isFinite(rawPrice) || rawPrice < 0) {
          console.warn(`ราคา "${document.getElementById("fPrice").value}" ไม่ถูกต้อง → ใช้ 0`);
          return 0;
        }
        return rawPrice;
      })(),
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
    invalidateAdminCache("songs");  // 🔧 (2026-09-17 Phase 1) ล้าง cache เพื่อบังคับ fetch ใหม่
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
// 🔧 แก้บั๊ก (2026-09-17) Bug #4: เดิมใช้ getDocs(collection(db,"orders")) โหลด orders ทั้งตาราง
//   ทุกครั้ง × N เพลงใน bulk delete → D1 quota bomb
//   ตอนนี้เปลี่ยนไปใช้ endpoint ใหม่ POST /api/db/songs/_has-orders-batch
//   server โหลด orders ครั้งเดียวแล้ววนลูปใน memory → ลด D1 reads จาก N × orders_total → 1 × orders_total
//
//   ฟังก์ชันนี้ยังคงรักษา interface เดิม (รับ songId เดียว → คืน boolean) เพื่อไม่ให้ caller เดิมพัง
//   แต่ภายในเรียกผ่าน endpoint batch ที่รองรับการส่ง ids หลายตัวพร้อมกัน
//   (caller ฝั่ง bulk delete ใช้ songsHaveOrdersBatch ตรง ๆ เพื่อประหยัด HTTP requests อีก)
async function songHasOrders(songId) {
  try {
    const res = await fetch("/api/db/songs/_has-orders-batch", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [String(songId)] }),
    });
    if (!res.ok) {
      // Fallback: ถ้า endpoint ใหม่ยังไม่ deploy หรือ fail → กลับไปใช้วิธีเดิม (โหลดทั้งตาราง)
      //   เพื่อความเข้ากันได้กับ worker เวอร์ชันเก่า — กัน admin เห็น error หากยังไม่ได้ deploy
      console.warn("songHasOrders: _has-orders-batch endpoint failed, fallback to legacy method", res.status);
      const snap = await getDocs(collection(db, "orders"));
      return snap.docs.some(d => (d.data().items || []).some(item =>
        item.song_id === songId || (Array.isArray(item.song_ids) && item.song_ids.includes(songId))
      ));
    }
    const data = await res.json();
    return !!(data && data.results && data.results[String(songId)]);
  } catch (err) {
    // Fallback เดียวกัน — ถ้า fetch fail ทั้งหมด (เช่น network) กลับไปวิธีเดิม
    console.warn("songHasOrders: fetch error, fallback to legacy method", err?.message || err);
    const snap = await getDocs(collection(db, "orders"));
    return snap.docs.some(d => (d.data().items || []).some(item =>
      item.song_id === songId || (Array.isArray(item.song_ids) && item.song_ids.includes(songId))
    ));
  }
}

// 🔧 แก้บั๊ก Bug #4: batch check สำหรับ bulk delete — ลด HTTP requests จาก N → 1
//   คืน { [songId]: boolean } เหมือนกับ endpoint server
async function songsHaveOrdersBatch(songIds) {
  const ids = songIds.map(String).filter(Boolean);
  if (ids.length === 0) return {};
  try {
    const res = await fetch("/api/db/songs/_has-orders-batch", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return (data && data.results) || {};
  } catch (err) {
    // Fallback: ถ้า endpoint fail → ใช้ songHasOrders ทีละตัว (ยังช้ากว่าแต่ก็ยังทำงานได้)
    console.warn("songsHaveOrdersBatch: batch endpoint failed, fallback to per-song method", err?.message || err);
    const results = {};
    for (const id of ids) {
      results[id] = await songHasOrders(id);
    }
    return results;
  }
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
      // 🔧 แก้บั๊ก (2026-09-17) Bug #7: ใช้ endpoint ใหม่ _check-cover-used แทนโหลดทั้งตาราง
      //   เดิม: getDocs(collection(db,"songs")) + getDocs(collection(db,"playlists"))
      //   → 1,000 เพลง + 100 playlists = 1,100 D1 reads ต่อครั้ง
      //   ใหม่: POST /api/db/_meta/_check-cover-used { url } → 1 query × 2 (songs + playlists)
      //   server ทำ query ด้วย json_extract ที่ DB level ใช้ index ได้
      let stillUsed = false;
      try {
        const res = await fetch("/api/db/_meta/_check-cover-used", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: song.cover_url }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        stillUsed = !!(data && data.used);
      } catch (err) {
        // Fallback: ถ้า endpoint ใหม่ยังไม่ deploy → กลับไปใช้วิธีเดิม (โหลดทั้งตาราง)
        //   เพื่อความเข้ากันได้กับ worker เวอร์ชันเก่า — กัน admin เห็น error หากยังไม่ได้ deploy
        console.warn("deleteSongFilesFromStorage: _check-cover-used endpoint failed, fallback to legacy method", err?.message || err);
        const [songsSnap, playlistsSnap] = await Promise.all([
          getDocsAdmin(collection(db, "songs")),
          getDocs(collection(db, "playlists")),
        ]);
        stillUsed =
          songsSnap.docs.some((d) => d.data().cover_url === song.cover_url) ||
          playlistsSnap.docs.some((d) => d.data().cover_url === song.cover_url);
      }
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
        invalidateAdminCache("songs");  // 🔧 (2026-09-17 Phase 1) ล้าง cache เพื่อบังคับ fetch ใหม่
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
    invalidateAdminCache("songs");  // 🔧 (2026-09-17 Phase 1) ล้าง cache เพื่อบังคับ fetch ใหม่
    loadSongs();
    loadDashboard();
  });
}

// ================= CATEGORIES =================
// 🔧 (2026-09-17 Phase 1): loadCategories ใช้ TTL cache (60 วิ) ลด D1 reads
async function loadCategories() {
  if (isAdminCacheFresh("categories")) {
    // ใช้ cache — skip fetch
  } else {
    const snap = await getDocs(collection(db, "categories"));
    CACHE.categories = sortByThaiName(snap.docs.map(d => ({ id: d.id, ...d.data() })), "category_name");
    CACHE_AT.categories = Date.now();
  }
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
      showToast("ลบแล้ว", "success");
      invalidateAdminCache("categories");  // 🔧 (2026-09-17 Phase 1) ล้าง cache เพื่อบังคับ fetch ใหม่
      loadCategories(); loadDashboard();
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
    showToast("บันทึกแล้ว", "success"); document.getElementById("catFormBackdrop").classList.remove("show");
    invalidateAdminCache("categories");  // 🔧 (2026-09-17 Phase 1) ล้าง cache เพื่อบังคับ fetch ใหม่
    loadCategories(); loadDashboard();
  } catch (err) { showToast("บันทึกไม่สำเร็จ: " + err.message, "error"); }
});

// ================= DJs =================
// 🔧 (2026-09-17 Phase 1): loadDjs ใช้ TTL cache (60 วิ) ลด D1 reads
async function loadDjs() {
  if (!isAdminCacheFresh("djs")) {
    const snap = await getDocs(collection(db, "djs"));
    CACHE.djs = sortByThaiName(snap.docs.map(d => ({ id: d.id, ...d.data() })), "dj_name");
    CACHE_AT.djs = Date.now();
  }
  const wrap = document.getElementById("djList");
  if (CACHE.djs.length === 0) { wrap.innerHTML = '<div class="empty-state">ยังไม่มี DJ</div>'; return; }
  wrap.innerHTML = CACHE.djs.map(d => `
    <div class="list-row" data-open="${d.id}" style="cursor:pointer;"><img src="${d.image_url || ""}" loading="lazy" alt="">
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
      showToast("ลบแล้ว", "success");
      invalidateAdminCache("djs");  // 🔧 (2026-09-17 Phase 1) ล้าง cache เพื่อบังคับ fetch ใหม่
      loadDjs(); loadDashboard();
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
document.getElementById("djImageInput").addEventListener("change", async (e) => {
  const f = e.target.files[0]; if (!f) return;
  pendingDjImageFile = await compressImageFile(f); // 🔧 (2026-09-24 SEO/perf) ย่อรูปก่อนเก็บ
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
    // 🖼️ (2026-09-21): เฉพาะการ "เพิ่ม DJ ใหม่" ถ้าแอดมินไม่ได้อัปโหลดรูป → ใช้ default-dj-cover.svg อัตโนมัติ
    //   - กรณี "แก้ไข DJ เดิม" ที่ไม่มีรูป → ปล่อยให้ image_url ว่างอยู่เหมือนเดิม (ไม่บังคับตั้ง default)
    //   - ทำแบบเดียวกับ default-song-cover.svg (บรรทัด 1131) และ default-playlist-cover.svg (บรรทัด 1763)
    //   - ใช้ relative path เพื่อให้ทำงานได้ทุกที่ (admin/user โหลดจาก root เดียวกัน)
    //   - ถ้าแอดมินอัปโหลดภายหลัง → payload.image_url จะถูก overwrite เป็น URL ของ Cloudinary
    if (!imageUrl && !editingDjId) {
      imageUrl = "default-dj-cover.svg";
    }
    const payload = { dj_name: name, description: document.getElementById("fDjDesc").value.trim(), image_url: imageUrl };
    if (editingDjId) await updateDoc(doc(db, "djs", editingDjId), payload);
    else { payload.created_at = new Date().toISOString(); await addDoc(collection(db, "djs"), payload); }
    showToast("บันทึกแล้ว", "success"); document.getElementById("djFormBackdrop").classList.remove("show");
    invalidateAdminCache("djs");  // 🔧 (2026-09-17 Phase 1) ล้าง cache เพื่อบังคับ fetch ใหม่
    loadDjs(); loadDashboard();
  } catch (err) {
    showToast("บันทึกไม่สำเร็จ: " + err.message, "error");
  }
  btn.disabled = false; btn.textContent = "บันทึก";
});

// ================= PLAYLISTS =================
// 🔧 (2026-09-17 Phase 1): loadPlaylists ใช้ TTL cache (60 วิ) ลด D1 reads
async function loadPlaylists() {
  if (!isAdminCacheFresh("playlists")) {
    const snap = await getDocs(collection(db, "playlists"));
    CACHE.playlists = sortByThaiName(snap.docs.map(d => ({ id: d.id, ...d.data() })), "playlist_name");
    CACHE_AT.playlists = Date.now();
  }
  const wrap = document.getElementById("playlistList");
  if (CACHE.playlists.length === 0) { wrap.innerHTML = '<div class="empty-state">ยังไม่มีเพลย์ลิสต์</div>'; return; }
  wrap.innerHTML = CACHE.playlists.map(p => `
    <div class="list-row" data-open="${p.id}" style="cursor:pointer;"><img src="${p.cover_url || ""}" loading="lazy" alt="">
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
      showToast("ลบแล้ว", "success");
      invalidateAdminCache("playlists");  // 🔧 (2026-09-17 Phase 1) ล้าง cache เพื่อบังคับ fetch ใหม่
      loadPlaylists(); loadDashboard();
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
  // 🔧 (2026-09-18 v6): ใช้ getDocsAdmin → bypass CDN cache (ดูข้อมูลล่าสุด)
  const snap = await getDocsAdmin(collection(db, "songs"));
  CACHE.songs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  if (currentDetailContext && currentDetailContext.type === type && currentDetailContext.id === id) {
    renderDetailSongsList();
  }
}

// 🔧 (2026-09-18 v6 Full System): incremental render สำหรับ detail popup (เหมือน renderSongList)
//   กัน browser freeze ตอนเปิด popup "เพลงในหมวด/DJ/playlist" ที่มี 5000+ เพลง
const DETAIL_LIST_PAGE_SIZE = 100;
let detailListVisibleCount = DETAIL_LIST_PAGE_SIZE;

function renderDetailSongsList() {
  if (!currentDetailContext) return;
  const { type, id } = currentDetailContext;
  const songs = getSongsForDetail(type, id);
  document.getElementById("listSongsMeta").textContent = `ทั้งหมด ${songs.length} เพลง`;
  const wrap = document.getElementById("listSongsContainer");
  if (songs.length === 0) { wrap.innerHTML = '<div class="empty-state">ยังไม่มีเพลงในรายการนี้</div>'; return; }
  // 🔧 (2026-09-18 v6): แสดงแค่ detailListVisibleCount แรก — กัน freeze
  const visibleSongs = songs.slice(0, detailListVisibleCount);
  const hasMore = songs.length > visibleSongs.length;
  const removeLabel = { category: "นำออกจากหมวดหมู่นี้ (ไม่ลบเพลง)", playlist: "นำออกจากเพลย์ลิสต์นี้ (ไม่ลบเพลง)", dj: "นำออกจาก DJ นี้ (ไม่ลบเพลง)" }[type];
  wrap.innerHTML = visibleSongs.map(s => `
    <div class="list-row" data-detail-song-row="${s.id}" style="cursor:pointer;">
      <img src="${s.cover_url || ""}" loading="lazy" alt="">
      <div class="info"><div class="n1">${escapeHtml(s.song_name)}</div>
      <div class="n2">${escapeHtml(s.dj_name || "-")} · ${escapeHtml(s.category_name || "-")} · ${formatPrice(s.price)}</div></div>
      <div class="row-actions">
        <button class="icon-btn" data-detail-menu="${s.id}" title="เมนู">⋮</button>
      </div>
    </div>`).join("") + (hasMore ? `<div class="load-more-row" style="padding:16px;text-align:center;background:var(--bg-card);border-radius:8px;margin-top:8px;cursor:pointer;color:var(--accent);font-weight:600;" id="loadMoreDetailSongsBtn">⬇️ โหลดเพิ่มอีน (แสดง ${visibleSongs.length} จาก ${songs.length} เพลง)</div>` : "");
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
  // 🔧 (2026-09-18 v6): listener สำหรับปุ่ม "โหลดเพิ่ม" ใน detail popup
  const loadMoreBtn = document.getElementById("loadMoreDetailSongsBtn");
  if (loadMoreBtn) {
    loadMoreBtn.addEventListener("click", () => {
      detailListVisibleCount += DETAIL_LIST_PAGE_SIZE;
      renderDetailSongsList();
    });
  }
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
window.addEventListener("scroll", hideDetailRowMenu, { passive: true, capture: true });
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
document.getElementById("playlistCoverInput").addEventListener("change", async (e) => {
  const f = e.target.files[0]; if (!f) return;
  pendingPlaylistCoverFile = await compressImageFile(f); // 🔧 (2026-09-24 SEO/perf) ย่อรูปก่อนเก็บ
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
    // 🖼️ (2026-09-20): ถ้าแอดมินไม่ได้อัปโหลดรูปปกเพลย์ลิสต์ → ใช้ default-playlist-cover.svg อัตโนมัติ
    //   - ใช้ relative path เพื่อให้ทำงานได้ทุกที่
    //   - ถ้าแอดมินอัปโหลดภายหลัง → payload.cover_url จะถูก overwrite เป็น URL ของ Cloudinary
    if (!coverUrl) {
      coverUrl = "default-playlist-cover.svg";
    }
    const payload = {
      playlist_name: name,
      description: document.getElementById("fPlaylistDesc").value.trim(),
      price: Number(document.getElementById("fPlaylistPrice").value || 0),
      cover_url: coverUrl
    };
    if (editingPlaylistId) await updateDoc(doc(db, "playlists", editingPlaylistId), payload);
    else { payload.created_at = new Date().toISOString(); await addDoc(collection(db, "playlists"), payload); }
    showToast("บันทึกแล้ว", "success"); document.getElementById("playlistFormBackdrop").classList.remove("show");
    invalidateAdminCache("playlists");  // 🔧 (2026-09-17 Phase 1) ล้าง cache เพื่อบังคับ fetch ใหม่
    loadPlaylists(); loadDashboard();
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
  // 🔧 (2026-09-19): ล้าง song list preview ด้วย
  const bulkPreview = document.getElementById("bulkSongListPreview");
  if (bulkPreview) bulkPreview.innerHTML = "";
  document.getElementById("bulkNewPlaylistName").value = "";
  document.getElementById("bulkPrice").value = "";
  document.getElementById("bulkFilesInput").value = "";
  document.getElementById("bulkCoverInput").value = "";
  // 🔧 (2026-09-19): เพิ่มช่อง "ราคาเพลย์ลิสต์" สำหรับตอนสร้างเพลย์ลิสต์ใหม่ใน Bulk Upload
  //   เดิม: สร้าง playlist ใหม่ใน bulk upload → price=0 (hardcoded) → ต้องไปตั้งที่ Playlist Manager ทีหลัง
  //   ใหม่: มีช่องราคา → ตั้งได้ตอนสร้างเลย → ลูกค้าเห็นปุ่ม "ซื้อทั้งเพลย์ลิสต์" ได้ทันที
  ensureBulkPlaylistPriceField();
  document.getElementById("bulkPlaylistPrice").value = "";
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
  CACHE.categories = sortByThaiName(catSnap.docs.map(d => ({ id: d.id, ...d.data() })), "category_name");
  CACHE.djs = sortByThaiName(djSnap.docs.map(d => ({ id: d.id, ...d.data() })), "dj_name");
  CACHE.playlists = sortByThaiName(playlistSnap.docs.map(d => ({ id: d.id, ...d.data() })), "playlist_name");
  populateSelect("bulkCategory", CACHE.categories, "id", "category_name");
  populateSelect("bulkDj", CACHE.djs, "id", "dj_name");
  populateSelect("bulkPlaylist", CACHE.playlists, "id", "playlist_name");
}
document.getElementById("bulkUploadClose").addEventListener("click", () => {
  if (bulkUploadController) { bulkUploadController.abort(); bulkUploadController = null; } // ปิดหน้าต่างระหว่างอัปโหลด ต้องยกเลิกอัปโหลดจริงด้วย ไม่ปล่อยค้างเบื้องหลัง
  document.getElementById("bulkUploadBackdrop").classList.remove("show");
});

// 🔧 (2026-09-19): เพิ่มช่อง "ราคาเพลย์ลิสต์" ใน Bulk Upload (dynamically — ไม่ต้องแก้ admin.html)
//   แทรกหลังช่อง "ชื่อเพลย์ลิสต์ใหม่" → admin ตั้งราคาเพลย์ลิสต์ได้ตอนสร้างใหม่เลย
function ensureBulkPlaylistPriceField() {
  if (document.getElementById("bulkPlaylistPrice")) return; // มีอยู่แล้ว → ไม่สร้างซ้ำ
  const newNameField = document.getElementById("bulkNewPlaylistName");
  if (!newNameField) return;
  // สร้าง div.field ใหม่คล้ายของเดิม
  const priceField = document.createElement("div");
  priceField.className = "field";
  priceField.innerHTML = `
    <label>ราคาเพลย์ลิสต์ (LAK — สำหรับลูกค้าซื้อทั้งเพลย์ลิสต์)</label>
    <input id="bulkPlaylistPrice" type="number" min="0" placeholder="0 (ไม่ระบุ = ไม่ขายทั้งเพลย์ลิสต์)">
  `;
  // แทรกหลัง field ของ bulkNewPlaylistName
  newNameField.parentElement.parentElement.insertBefore(priceField, newNameField.parentElement.nextSibling);
}

// 🔧 (2026-09-19): แสดงราคาเพลย์ลิสต์เดิมในช่องเมื่อเลือก playlist ที่มีอยู่
//   ถ้าเลือก playlist จาก dropdown → แสดงราคาปัจจุบันในช่อง bulkPlaylistPrice (เพื่ออ้างอิง)
//   ถ้าเลือก "ไม่ระบุ" → ล้างช่อง
document.getElementById("bulkPlaylist").addEventListener("change", (e) => {
  const plId = e.target.value;
  const priceInput = document.getElementById("bulkPlaylistPrice");
  if (!priceInput) return;
  if (plId) {
    const pl = (CACHE.playlists || []).find(p => p.id === plId);
    if (pl) priceInput.value = pl.price || 0;
  } else {
    priceInput.value = "";
  }
});

document.getElementById("bulkFilesInput").addEventListener("change", (e) => {
  bulkFiles = Array.from(e.target.files || []);
  if (bulkFiles.length === 0) return;
  document.getElementById("bulkFilesPicker").textContent = `🎵 เลือกแล้ว ${bulkFiles.length} ไฟล์`;
  document.getElementById("bulkFilesPicker").className = "file-picker filled";
  // 🔧 (2026-09-19): แสดงรายการเพลงพร้อมช่องตั้งราคาแต่ละเพลง
  renderBulkSongListPreview();
});

// 🔧 (2026-09-19): แสดงรายการเพลงใน Bulk Upload พร้อมช่องตั้งราคาแต่ละเพลง
//   - หลังเลือกไฟล์ → สร้าง list ของเพลงพร้อมชื่อ (auto-derive จากชื่อไฟล์) + ช่องราคา
//   - ช่อง bulkPrice (ราคารวม) → เป็น default ให้ทุกเพลง
//   - admin สามารถแก้ราคาแต่ละเพลงได้ใน list นี้โดยตรง → ไม่ต้องไปตั้งทีหลัง
function renderBulkSongListPreview() {
  let container = document.getElementById("bulkSongListPreview");
  if (!container) {
    // สร้าง container ใหม่ → แทรกหลัง field ของ bulkFilesInput
    container = document.createElement("div");
    container.id = "bulkSongListPreview";
    const filesField = document.getElementById("bulkFilesInput").parentElement;
    filesField.parentElement.insertBefore(container, filesField.nextSibling);
  }
  if (bulkFiles.length === 0) { container.innerHTML = ""; return; }
  const defaultPrice = Number(document.getElementById("bulkPrice").value || 0);
  container.innerHTML = `
    <div style="font-size:13px;font-weight:600;margin-bottom:8px;color:var(--text);">📋 รายการเพลง (${bulkFiles.length} เพลง) — ตั้งราคาแต่ละเพลงได้ด้านล่าง</div>
    <div style="max-height:300px;overflow-y:auto;border:1px solid var(--border);border-radius:8px;padding:4px;">
      ${bulkFiles.map((file, i) => {
        const songName = cleanFileNameToSongName(file.name);
        return `
          <div style="display:flex;align-items:center;gap:8px;padding:8px 6px;border-bottom:1px solid var(--border);">
            <span style="flex:1;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(songName)}">${i + 1}. ${escapeHtml(songName)}</span>
            <input type="number" min="0" value="${defaultPrice}" data-bulk-song-price="${i}"
                   style="width:100px;padding:4px 8px;font-size:13px;text-align:right;border:1px solid var(--border);border-radius:4px;"
                   placeholder="0">
            <span style="font-size:11px;color:var(--text-dim);white-space:nowrap;">LAK</span>
          </div>
        `;
      }).join("")}
    </div>
  `;
}

// 🔧 (2026-09-19): เมื่อ bulkPrice เปลี่ยน → อัปเดตราคาทุกเพลงใน list (เป็น default)
document.getElementById("bulkPrice").addEventListener("input", (e) => {
  const price = e.target.value;
  document.querySelectorAll("[data-bulk-song-price]").forEach(input => {
    input.value = price;
  });
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

document.getElementById("bulkCoverInput").addEventListener("change", async (e) => {
  const f = e.target.files[0]; if (!f) return;
  pendingBulkCoverFile = await compressImageFile(f); // 🔧 (2026-09-24 SEO/perf) ย่อรูปก่อนเก็บ
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
        // 🔧 (2026-09-18 v6 P3.2): ใช้ adminConfirm (modal) แทน window.confirm
        const proceed = await adminConfirm(msg);
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
      // 🔧 (2026-09-19): อ่านราคาเพลย์ลิสต์จากช่องใหม่ (bulkPlaylistPrice)
      //   เดิม: price=0 (hardcoded) → ต้องไปตั้งที่ Playlist Manager ทีหลัง
      //   ใหม่: ใช้ราคาจากช่อง → ลูกค้าเห็นปุ่ม "ซื้อทั้งเพลย์ลิสต์" ได้ทันที
      const plPriceInput = document.getElementById("bulkPlaylistPrice");
      const plPrice = plPriceInput ? Number(plPriceInput.value || 0) : 0;
      const newDoc = await addDoc(collection(db, "playlists"), { playlist_name: newPlaylistName, description: "", price: plPrice, cover_url: "", created_at: new Date().toISOString() });
      playlistId = newDoc.id;
      playlistName = newPlaylistName;
    }

    let sharedCoverUrl = "";
    if (pendingBulkCoverFile) {
      const coverRes = await uploadToCloudinary(pendingBulkCoverFile, null, controller.signal);
      sharedCoverUrl = coverRes.url;
      if (playlistId) await updateDoc(doc(db, "playlists", playlistId), { cover_url: sharedCoverUrl }).catch(() => {});
    }
    // 🖼️ (2026-09-20): ถ้าแอดมินไม่ได้อัปโหลดรูปปก bulk → ใช้ default-playlist-cover.svg อัตโนมัติ
    //   - ใช้ร่วมกันทั้งเพลย์ลิสต์และเพลงทุกเพลงในชุด
    if (!sharedCoverUrl) {
      sharedCoverUrl = "default-playlist-cover.svg";
      if (playlistId) await updateDoc(doc(db, "playlists", playlistId), { cover_url: sharedCoverUrl }).catch(() => {});
    }

    const djSel = document.getElementById("bulkDj");
    const catSel = document.getElementById("bulkCategory");
    // 🔧 (2026-09-19): อ่านราคาแต่ละเพลงจากช่องใน list — ถ้าไม่มีช่อง (เช่น list ไม่ render) → fallback ใช้ bulkPrice
    const defaultPrice = Number(document.getElementById("bulkPrice").value || 0);
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

      // 🔧 (2026-09-22 Batch 7 fix Bug #8): อัปโหลด preview + full พร้อมกัน (parallel) แทน sequential
      //   เดิม: อัปโหลด preview (await) → analyze → อัปโหลด full (await) → save
      //          = 2 sequential uploads × ~30 วิ = 60 วิ/เพลง → 50 เพลง = 50 นาที
      //   ใหม่: อัปโหลด preview + full พร้อมกัน → analyze → save
      //          = 1 parallel upload × ~30 วิ = 30 วิ/เพลง → 50 เพลง = 25 นาที (เร็ว 2x)
      //   ผลกระทบระบบเดิม: 0% — songPayload ยังถูก populate แบบเดิม แค่เปลี่ยนลำดับ timing
      //   ความปลอดภัย: ใช้ Promise.all ในระดับเดียวกัน (preview + full) → ถ้าอันใดอันหนึ่ง fail → throw → หยุด
      //
      //   หมายเหตุ: matchFullFile() ใช้ file.name (มีอยู่แล้ว) → ไม่ต้องรอ preview upload เสร็จ
      //            จึงสามารถเริ่มอัปโหลด full ไปพร้อมกันได้เลย
      const matchedFull = matchFullFile(file.name, bulkFullFiles)
        || (bulkFiles.length === 1 && bulkFullFiles.length === 1 ? bulkFullFiles[0] : null);

      // เริ่มทั้งสอง uploads พร้อมกัน
      const [previewUploadResult, fullUploadResult] = await Promise.all([
        // Upload preview (MP3 — ไฟล์ตัวอย่าง)
        uploadToCloudinary(file, (pct, loaded, total) => {
          const overall = Math.round(((i + pct / 100) / bulkFiles.length) * 100);
          document.getElementById("bulkProgress").style.width = overall + "%";
          updateProgressLabel(bulkProgLabel, total || file.size, pct, loaded);
        }, controller.signal),
        // Upload full (WAV — ถ้ามี matchedFull)
        matchedFull
          ? uploadFullSong(matchedFull, (pct, loaded, total) => {
              const overall = Math.round(((i + pct / 100) / bulkFiles.length) * 100);
              document.getElementById("bulkProgress").style.width = overall + "%";
              updateProgressLabel(bulkProgLabel, total || matchedFull.size, pct, loaded);
            }, controller.signal, (attempt, maxRetries) => {
              document.getElementById("bulkStatusText").textContent =
                `ไฟล์เต็ม "${matchedFull.name}" เชื่อมต่อหลุด กำลังลองใหม่ (${attempt}/${maxRetries})...`;
            })
          : Promise.resolve(null)  // ไม่มีไฟล์เต็ม → ไม่ upload
      ]);

      const res = previewUploadResult;
      // fullRes เป็น null ถ้าไม่มี matchedFull — ไม่ใช่ error
      const fullRes = fullUploadResult;

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
        // 🔧 (2026-09-19): อ่านราคาเฉพาะของเพลงนี้จากช่องใน list — ถ้าไม่มี → fallback ใช้ defaultPrice
        // 🔧 (2026-09-22 Batch 7 fix Bug #10): validate price ≥ 0 + must be finite number
        //   ปัญหาเดิม: Number(priceInput.value || 0) → รับค่า -100, "abc", Infinity
        //   วิธีแก้: ใช้ helper validatePrice() ที่ตรวจ + ใช้ fallback เป็น defaultPrice ถ้าผิด
        price: (() => {
          const priceInput = document.querySelector(`[data-bulk-song-price="${i}"]`);
          const rawValue = priceInput ? priceInput.value : "";
          const numPrice = Number(rawValue);
          // validate: ต้องเป็นจำนวนจริงที่ >= 0 (รับ 0 ได้ = ฟรี, แต่ห้ามติดลบ/NaN/Infinity)
          if (!Number.isFinite(numPrice) || numPrice < 0) {
            console.warn(`Bulk upload: ราคา "${rawValue}" ไม่ถูกต้องสำหรับเพลง ${file.name} → ใช้ default ${defaultPrice}`);
            return defaultPrice;
          }
          return numPrice;
        })(),
        description: "",
        status: "active",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };

      // ถ้ามี fullRes → populate full_file fields
      if (fullRes) {
        songPayload.full_file_url = fullRes.url;
        songPayload.full_file_public_id = fullRes.publicId;
        songPayload.full_file_name = matchedFull.name;
        matchedCount++;
      } else if (bulkFullFiles.length > 0) {
        unmatchedNames.push(songPayload.song_name);
      }

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
  // Payment settings (added in STEP 1 — backward compat: fields optional, fall back to "")
  document.getElementById("setBankName").value = s.bank_name || "";
  document.getElementById("setBankAccountName").value = s.bank_account_name || "";
  document.getElementById("setBankAccount").value = s.bank_account || "";
  document.getElementById("setQrCodeUrl").value = s.qr_code_url || "";
  document.getElementById("setPaymentInstructions").value = s.payment_instructions || "";
  // 🎨 (2026-09-26): แสดง preview รูป QR ถ้ามี — ใช้ qr_code_url ที่โหลดจาก settings
  updateQrPreview(s.qr_code_url || "");
}

// 🎨 (2026-09-26) QR Upload — อัปโหลดรูป QR Code จาก iPhone/iPad/PC/Mac ได้โดยตรง
//   ใช้ uploadToCloudinary (ผ่าน R2 storage) แบบเดียวกับอัปโหลดรูปปกเพลง
//   + ย่อรูปใหญ่ด้วย compressImageFile ก่อนอัปโหลด (เร็วขึ้น + ประหยัด bandwidth)
//   + แสดง preview + ปุ่มเปลี่ยน/ลบ
//   ไม่กระทบ: ระบบเดิม qr_code_url ยังใช้ URL text ได้ (ถ้าไม่อัปโหลดรูปใหม่)
let pendingQrFile = null;       // เก็บ File ที่เลือก (ถ้ามี) → อัปโหลดตอนกด "บันทึกการตั้งค่า"
let currentQrUrl = "";          // URL ของรูป QR ปัจจุบัน (จาก settings หรือที่อัปโหลดใหม่)
let pendingQrDelete = false;   // flag ว่าผู้ใช้กดลบรูป QR (จะ clear qr_code_url ตอนบันทึก)

// อัปเดต preview รูป QR ในหน้าตั้งค่า — แสดง/ซ่อนตามมีรูปหรือไม่
function updateQrPreview(url) {
  currentQrUrl = url || "";
  const previewWrap = document.getElementById("qrPreviewWrap");
  const previewImg = document.getElementById("qrPreviewImg");
  const filePickerLabel = document.getElementById("qrFilePickerLabel");
  if (url) {
    if (previewImg) previewImg.src = url;
    // 🛡️ (2026-09-26 fix iOS): force show ด้วย style.display = "block" (กัน inline style display:none ค้าง)
    if (previewWrap) {
      previewWrap.style.display = "block";
      previewWrap.style.setProperty("display", "block", "important");
    }
    if (filePickerLabel) filePickerLabel.style.display = "none";
    // sync ช่อง URL ด้วย (ถ้าผู้ใช้กรอก URL เอง → แสดง preview ทันที)
    const urlInput = document.getElementById("setQrCodeUrl");
    if (urlInput && urlInput.value !== url) urlInput.value = url;
  } else {
    if (previewWrap) previewWrap.style.display = "none";
    if (filePickerLabel) {
      filePickerLabel.style.display = "block";
      filePickerLabel.style.setProperty("display", "block", "important");
    }
    if (previewImg) previewImg.src = "";
    // ล้างช่อง URL ด้วย
    const urlInput = document.getElementById("setQrCodeUrl");
    if (urlInput) urlInput.value = "";
  }
}

// ผูก event listeners สำหรับ QR upload
(function setupQrUpload() {
  const fileInput = document.getElementById("qrFileInput");
  const changeBtn = document.getElementById("qrChangeBtn");
  const deleteBtn = document.getElementById("qrDeleteBtn");

  if (fileInput) {
    fileInput.addEventListener("change", async (e) => {
      const file = e.target.files?.[0];
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
      // 🎨 (2026-09-26 fix iOS preview): แสดง preview ทันทีด้วย FileReader.readAsDataURL (base64)
      //   เพราะ URL.createObjectURL บน iOS Safari บางครั้งโหลด blob ไม่เสร็จ → รูปไม่แสดง
      //   base64 data URL แสดงได้แน่นอนทุกเบราว์เซอร์ (iOS, Android, PC, Mac)
      //   แสดง preview ก่อนย่อรูป → ผู้ใช้เห็นรูปทันทีที่เลือก
      const previewWrap = document.getElementById("qrPreviewWrap");
      const previewImg = document.getElementById("qrPreviewImg");
      const filePickerLabel = document.getElementById("qrFilePickerLabel");
      // อ่านไฟล์เป็น base64 data URL แล้ว set เป็น src ของ <img>
      try {
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(new Error("อ่านไฟล์รูปไม่สำเร็จ"));
          reader.readAsDataURL(file);
        });
        if (previewImg) {
          previewImg.src = dataUrl;
          // 🛡️ รอโหลดเสร็จก่อน (บางครั้ง iOS Safari ต้องการ trigger)
          previewImg.onload = () => {
            if (previewWrap) previewWrap.style.display = "block";
            if (filePickerLabel) filePickerLabel.style.display = "none";
          };
          previewImg.onerror = () => {
            showToast("ไม่สามารถแสดงรูปพรีวิวได้ — แต่ไฟล์ถูกเลือกแล้ว กดบันทึกเพื่ออัปโหลด", "info");
            if (previewWrap) previewWrap.style.display = "block";
            if (filePickerLabel) filePickerLabel.style.display = "none";
          };
          // 🛡️ fallback ถ้า onload ไม่ทำงาน (iOS เก่า) → force show หลัง 100ms
          setTimeout(() => {
            if (previewWrap) previewWrap.style.display = "block";
            if (filePickerLabel) filePickerLabel.style.display = "none";
          }, 100);
        } else {
          if (previewWrap) previewWrap.style.display = "block";
          if (filePickerLabel) filePickerLabel.style.display = "none";
        }
      } catch (err) {
        console.warn("QR preview failed, but will still upload:", err);
        // fallback: ใช้ object URL (อาจไม่แสดงบน iOS แต่ก็ดีกว่าไม่มี)
        try {
          const objectUrl = URL.createObjectURL(file);
          if (previewImg) previewImg.src = objectUrl;
          if (previewWrap) previewWrap.style.display = "block";
          if (filePickerLabel) filePickerLabel.style.display = "none";
        } catch (err2) {
          showToast("ไม่สามารถแสดง preview ได้ แต่ไฟล์ถูกเลือกแล้ว — กดบันทึกเพื่ออัปโหลด", "info");
        }
      }
      // ย่อรูปใหญ่ก่อน (เร็วขึ้น + ประหยัด bandwidth — ใช้ compressImageFile ที่มีอยู่แล้ว)
      //   ทำหลังแสดง preview แล้ว → ผู้ใช้ไม่ต้องรอ
      let processedFile = file;
      try {
        processedFile = await compressImageFile(file, 900, 0.85);
      } catch (err) {
        // ถ้าย่อไม่ได้ → ใช้ไฟล์เดิม
        console.warn("QR compress failed, using original:", err);
      }
      pendingQrFile = processedFile;
      pendingQrDelete = false; // ล้าง flag ลบถ้ามี
      // แจ้งผู้ใช้ว่าต้องกด "บันทึกการตั้งค่า" เพื่ออัปโหลดจริง
      showToast("เลือกรูปแล้ว — กด \"บันทึกการตั้งค่า\" เพื่ออัปโหลด", "info");
    });
  }

  // ปุ่ม "เปลี่ยนรูป" → เปิด file picker อีกครั้ง
  if (changeBtn) {
    changeBtn.addEventListener("click", () => {
      if (fileInput) {
        fileInput.value = ""; // ล้างค่าเดิมก่อน → เลือกรูปเดิมได้อีก
        fileInput.click();
      }
    });
  }

  // ปุ่ม "ลบรูป" → ล้าง pendingQrFile + ตั้ง pendingQrDelete = true
  if (deleteBtn) {
    deleteBtn.addEventListener("click", async () => {
      // 🎨 (2026-09-26): ใช้ adminConfirm แทน confirm() — สไตล์เดียวกับเว็บ
      const ok = await adminConfirm(
        "ต้องการลบรูป QR Code นี้ใช่หรือไม่?\n\nลูกค้าจะไม่เห็น QR Code ในหน้าชำระเงินจนกว่าจะอัปโหลดรูปใหม่",
        { title: "ลบรูป QR Code", okText: "ลบ", danger: true }
      );
      if (!ok) return;
      pendingQrFile = null;
      pendingQrDelete = true;
      // ซ่อน preview + แสดง file picker กลับ
      const previewWrap = document.getElementById("qrPreviewWrap");
      const filePickerLabel = document.getElementById("qrFilePickerLabel");
      if (previewWrap) previewWrap.style.display = "none";
      if (filePickerLabel) filePickerLabel.style.display = "block";
      // ล้างช่อง URL
      const urlInput = document.getElementById("setQrCodeUrl");
      if (urlInput) urlInput.value = "";
      showToast("รูป QR Code จะถูกลบเมื่อกด \"บันทึกการตั้งค่า\"", "info");
    });
  }
})();

// 🎨 (2026-09-26): sync URL input → preview (ถ้าผู้ใช้กรอก URL เองแทนการอัปโหลดรูป)
document.getElementById("setQrCodeUrl")?.addEventListener("input", (e) => {
  const url = e.target.value.trim();
  if (url && url !== currentQrUrl) {
    // ผู้ใช้กรอก URL ใหม่ → แสดง preview ทันที (ถ้า URL valid)
    updateQrPreview(url);
    pendingQrFile = null; // ล้าง pending file (ถ้ามี) → ใช้ URL แทน
    pendingQrDelete = false;
  } else if (!url && currentQrUrl && !pendingQrFile) {
    // ผู้ใช้ล้างช่อง URL → ซ่อน preview
    updateQrPreview("");
  }
});

document.getElementById("saveSettingsBtn").addEventListener("click", async () => {
  const btn = document.getElementById("saveSettingsBtn");
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = "กำลังบันทึก...";

  try {
    // 🎨 (2026-09-26): อัปโหลดรูป QR ก่อน (ถ้าผู้ใช้เลือกรูปใหม่)
    let finalQrUrl = document.getElementById("setQrCodeUrl").value.trim();
    if (pendingQrFile) {
      // แสดง progress bar อัปโหลด
      const progressEl = document.getElementById("qrUploadProgress");
      const percentEl = document.getElementById("qrUploadPercent");
      if (progressEl) progressEl.style.display = "block";
      try {
        btn.textContent = "กำลังอัปโหลดรูป QR...";
        const res = await uploadToCloudinary(pendingQrFile, (pct) => {
          if (percentEl) percentEl.textContent = pct + "%";
        });
        finalQrUrl = res.url;
        pendingQrFile = null; // ล้าง pending หลังอัปโหลดสำเร็จ
        showToast("✅ อัปโหลดรูป QR สำเร็จ", "success");
      } catch (err) {
        if (progressEl) progressEl.style.display = "none";
        showToast("อัปโหลดรูป QR ไม่สำเร็จ: " + (err.message || String(err)), "error");
        btn.disabled = false;
        btn.textContent = originalText;
        return; // หยุดบันทึก ถ้าอัปโหลดไม่สำเร็จ
      }
      if (progressEl) progressEl.style.display = "none";
    } else if (pendingQrDelete) {
      // ผู้ใช้กดลบรูป → ล้าง URL
      finalQrUrl = "";
      pendingQrDelete = false;
    }

    const payload = {
      website_name: document.getElementById("setWebsiteName").value.trim(),
      meta_description: document.getElementById("setMetaDesc").value.trim(),
      admin_name: document.getElementById("setAdminName").value.trim(),
      whatsapp_number: document.getElementById("setWhatsapp").value.trim(),
      website_logo: document.getElementById("setLogo").value.trim(),
      // Payment settings (added in STEP 1 — merge:true keeps everything backward compatible)
      bank_name: document.getElementById("setBankName").value.trim(),
      bank_account_name: document.getElementById("setBankAccountName").value.trim(),
      bank_account: document.getElementById("setBankAccount").value.trim(),
      qr_code_url: finalQrUrl,
      payment_instructions: document.getElementById("setPaymentInstructions").value.trim()
    };
    await setDoc(doc(db, "settings", "main"), payload, { merge: true });
    // 🎨 (2026-09-26): อัปเดต preview + state หลังบันทึกสำเร็จ
    currentQrUrl = finalQrUrl;
    updateQrPreview(finalQrUrl);
    showToast("บันทึกการตั้งค่าแล้ว", "success");
  } catch (err) {
    showToast("บันทึกไม่สำเร็จ: " + err.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
});

// ================= 📸 PAYMENT VERIFICATION (added STEP 5) =================
//   ไม่ขึ้นกับระบบเดิมใด ๆ — ใช้ apiFetch() ของ db-client เพื่อเรียก endpoints ใหม่ที่ worker ของเรา
//   Endpoints ใหม่ (เห็นใน worker/index.js):
//     POST /api/payment-proofs/_count-pending  — badge count
//     GET  /api/payment-proofs/pending         — list pending slips (with order snapshot)
//     POST /api/admin/orders/:id/verify-payment?proof_id=xxx — verify/reject

async function fetchPendingPaymentsCount() {
  try {
    const res = await fetch("/api/payment-proofs/_count-pending", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
    });
    if (!res.ok) return 0;
    const data = await res.json();
    return Number(data?.count ?? 0);
  } catch { return 0; }
}

async function refreshPaymentsBadge() {
  const n = await fetchPendingPaymentsCount();
  const badge = document.getElementById("paymentsBadge");
  if (badge) {
    badge.textContent = String(n);
    badge.style.display = n > 0 ? "" : "none";
  }
}

async function initPaymentsView() {
  await renderPaymentsList();
  await refreshPaymentsBadge();
}

async function renderPaymentsList() {
  const container = document.getElementById("paymentsList");
  if (!container) return;
  container.innerHTML = `<div style="text-align:center;color:var(--text-dim);padding:30px 0;">กำลังโหลดรายการสลิป...</div>`;
  try {
    const res = await fetch("/api/payment-proofs/pending", {
      method: "GET",
      credentials: "include",
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      container.innerHTML = `<div style="text-align:center;color:var(--danger);padding:30px 0;">โหลดไม่สำเร็จ: ${escapeHtml(err?.error || res.statusText)}</div>`;
      return;
    }
    const data = await res.json();
    const items = Array.isArray(data?.items) ? data.items : [];
    if (items.length === 0) {
      container.innerHTML = `<div style="text-align:center;color:var(--text-dim);padding:40px 0;">🎉 ไม่มีสลิปรอตรวจสอบ</div>`;
      return;
    }
    container.innerHTML = items.map(p => {
      const amt = p.order?.final_total ?? p.order?.total ?? null;
      const amtText = amt != null ? formatPrice(amt) : "—";
      const claimed = p.amount_claimed != null ? formatPrice(p.amount_claimed) : null;
      const uploaded = p.uploaded_at ? new Date(p.uploaded_at).toLocaleString("th-TH", { dateStyle: "short", timeStyle: "short" }) : "—";
      const slipImgUrl = p.file_url || "";
      return `
        <div class="card" style="margin-bottom:12px;padding:14px;border:1px solid var(--border);border-radius:10px;">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap;">
            <div style="flex:1;min-width:0;">
              <div style="font-weight:800;font-size:14px;">${escapeHtml(p.order?.receipt_number || p.order_id.slice(0,8))}</div>
              <div style="color:var(--text-dim);font-size:12px;margin-top:2px;">${escapeHtml(p.customer_name)} • ${escapeHtml(p.whatsapp)}</div>
              <div style="font-size:12px;margin-top:4px;">ยอดในออเดอร์: <strong>${amtText}</strong>${claimed ? ` • ยอดที่บอกโอน: <strong>${claimed}</strong>` : ""}</div>
              <div style="font-size:11px;color:var(--text-dim);margin-top:4px;">อัปโหลด: ${uploaded}</div>
              ${p.transfer_ref ? `<div style="font-size:11px;color:var(--text-dim);margin-top:2px;">อ้างอิง: ${escapeHtml(p.transfer_ref)}</div>` : ""}
            </div>
            <a href="${escapeHtml(slipImgUrl)}" target="_blank" rel="noopener" style="display:block;flex-shrink:0;">
              <img src="${escapeHtml(slipImgUrl)}" alt="สลิป" style="max-width:120px;max-height:120px;border-radius:6px;border:1px solid var(--border);object-fit:cover;">
            </a>
          </div>
          <div style="display:flex;gap:8px;margin-top:10px;">
            <button class="btn" data-verify="${escapeHtml(p.id)}" data-order="${escapeHtml(p.order_id)}" style="flex:1;background:var(--success);color:#fff;">✓ ยืนยันสลิปถูกต้อง</button>
            <button class="btn" data-reject="${escapeHtml(p.id)}" data-order="${escapeHtml(p.order_id)}" style="flex:1;background:var(--danger);color:#fff;">✗ ปฏิเสธ</button>
          </div>
        </div>
      `;
    }).join("");
    // bind buttons
    container.querySelectorAll("[data-verify]").forEach(btn => {
      btn.addEventListener("click", () => verifyPayment(btn.dataset.verify, btn.dataset.order));
    });
    container.querySelectorAll("[data-reject]").forEach(btn => {
      btn.addEventListener("click", () => rejectPayment(btn.dataset.reject, btn.dataset.order));
    });
  } catch (err) {
    container.innerHTML = `<div style="text-align:center;color:var(--danger);padding:30px 0;">โหลดไม่สำเร็จ: ${escapeHtml(err.message || String(err))}</div>`;
  }
}

async function verifyPayment(proofId, orderId) {
  // 🎨 (2026-09-26): ใช้ adminConfirm แทน confirm() — สไตล์เดียวกับเว็บ
  const ok = await adminConfirm(
    "ยืนยันว่าสลิปนี้ถูกต้อง?\n\nหลังยืนยัน: ลูกค้าจะยังไม่ได้รับไฟล์ — แอดมินต้องไปกดเปลี่ยนสถานะออเดอร์เป็น 'processing' เพื่อสร้าง ZIP ส่งลูกค้าเองในหน้าจัดการออเดอร์ (เหมือนเดิม)\n\nหลังกดยืนยัน → ระบบจะเปิดหน้าต่างให้คุณตรวจสอบข้อความ + กดเปิด WhatsApp ส่งลูกค้าเอง",
    { title: "ยืนยันสลิปการโอนเงิน", okText: "ยืนยันสลิป", success: true }
  );
  if (!ok) return;
  try {
    const res = await fetch(`/api/admin/orders/${encodeURIComponent(orderId)}/verify-payment?proof_id=${encodeURIComponent(proofId)}`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "verified" }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      showToast("ยืนยันไม่สำเร็จ: " + (data?.error || res.statusText), "error");
      return;
    }
    showToast("✓ ยืนยันสลิปแล้ว — ไปหน้าออเดอร์เพื่อเปลี่ยนสถานะเป็น processing", "success");
    await renderPaymentsList();
    await refreshPaymentsBadge();
    // 📸 (replaced auto-open with manual modal) — แสดง modal ให้ admin ตรวจสอบข้อความก่อนคลิกเปิด WhatsApp เอง
    //   เหตุผล: popup blocker จะบล็อก window.open() ที่เรียกหลัง await (นอก user gesture context)
    //   การใช้ modal + ปุ่ม click → admin click เปิด WhatsApp เอง → ไม่ถูกบล็อก + ตรวจสอบข้อความก่อนส่ง
    if (data?.whatsapp_notify_url || data?.customer_whatsapp) {
      openWhatsAppNotifyModal({
        title: "✅ ยืนยันสลิปแล้ว — ส่งข้อความแจ้งลูกค้า",
        customerName: data.customer_name || "",
        customerWhatsapp: data.customer_whatsapp || "",
        receiptNumber: data.receipt_number || "",
        orderTotal: data.order_total ?? null,
        rejectReason: null,
        action: "verified",
      });
    } else {
      showToast("ยืนยันสำเร็จ แต่ไม่พบเบอร์ลูกค้า → ไม่สามารถส่ง WhatsApp ได้", "info");
    }
  } catch (err) {
    showToast("ยืนยันไม่สำเร็จ: " + (err.message || String(err)), "error");
  }
}

async function rejectPayment(proofId, orderId) {
  const reason = prompt("กรุณาระบุเหตุผลที่ปฏิเสธ (ลูกค้าจะเห็นข้อความนี้ใน WhatsApp):\n\nตัวอย่าง: ยอดเงินไม่ตรง / สลิปไม่ชัด / โอนผิดบัญชี", "ยอดเงินไม่ตรง / สลิปไม่ชัด");
  if (reason === null) return;
  try {
    const res = await fetch(`/api/admin/orders/${encodeURIComponent(orderId)}/verify-payment?proof_id=${encodeURIComponent(proofId)}`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "rejected", reject_reason: reason || "" }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      showToast("ปฏิเสธไม่สำเร็จ: " + (data?.error || res.statusText), "error");
      return;
    }
    showToast("ปฏิเสธสลิปแล้ว — กรุณาเปิด WhatsApp ส่งข้อความแจ้งลูกค้า", "success");
    await renderPaymentsList();
    await refreshPaymentsBadge();
    // 📸 (replaced auto-open with manual modal) — แสดง modal พร้อมเหตุผล + ข้อความ auto-fill
    //   admin ตรวจสอบข้อความ + กดเปิด WhatsApp เอง (ไม่ถูก popup blocker)
    if (data?.whatsapp_notify_url || data?.customer_whatsapp) {
      openWhatsAppNotifyModal({
        title: "❌ ปฏิเสธสลิปแล้ว — ส่งเหตุผลให้ลูกค้า",
        customerName: data.customer_name || "",
        customerWhatsapp: data.customer_whatsapp || "",
        receiptNumber: data.receipt_number || "",
        orderTotal: data.order_total ?? null,
        rejectReason: data.reject_reason || reason || "",
        action: "rejected",
      });
    } else {
      // fallback: ถ้าไม่มีเบอร์ลูกค้า → แจ้งให้ admin ติดต่อเอง
      // 🎨 (2026-09-26): ใช้ adminAlert แทน alert()
      await adminAlert(
        `ปฏิเสธสลิปสำเร็จ แต่ไม่พบเบอร์ลูกค้า\n\nเหตุผลที่ระบุ: ${reason || "ไม่ระบุ"}\n\nกรุณาติดต่อลูกค้าด้วยตนเอง`,
        { title: "ปฏิเสธสลิปแล้ว" }
      );
    }
  } catch (err) {
    showToast("ปฏิเสธไม่สำเร็จ: " + (err.message || String(err)), "error");
  }
}

// 📸 (added) Modal สำหรับ admin ตรวจสอบข้อความ WhatsApp ก่อนส่ง
//   - แสดงเบอร์ลูกค้า + receipt + ยอด (กันส่งผิดคน)
//   - textarea แสดงข้อความที่จะส่ง — admin แก้ไขก่อนส่งได้
//   - ปุ่ม "💬 เปิด WhatsApp ส่ง" → window.open() ใน click handler → ไม่ถูก popup blocker
//   - ปุ่ม "📋 คัดลอกข้อความ" → สำรองกรณี WhatsApp เปิดไม่ได้
function openWhatsAppNotifyModal({ title, customerName, customerWhatsapp, receiptNumber, orderTotal, rejectReason, action }) {
  const backdrop = document.getElementById("whatsappNotifyBackdrop");
  const titleEl = document.getElementById("whatsappNotifyTitle");
  const customerInfoEl = document.getElementById("whatsappNotifyCustomerInfo");
  const messageEl = document.getElementById("whatsappNotifyMessage");
  const openBtn = document.getElementById("whatsappNotifyOpenBtn");
  const copyBtn = document.getElementById("whatsappNotifyCopyBtn");
  const cancelBtn = document.getElementById("whatsappNotifyCancelBtn");
  const closeBtn = document.getElementById("whatsappNotifyClose");
  const errorHint = document.getElementById("whatsappNotifyErrorHint");
  if (!backdrop || !messageEl || !openBtn) return;

  if (titleEl) titleEl.textContent = title || "💬 ส่งข้อความ WhatsApp";

  // format customer info
  const amt = (orderTotal != null && !isNaN(Number(orderTotal)))
    ? Number(orderTotal).toLocaleString("th-TH") + " ₭"
    : "—";
  if (customerInfoEl) {
    customerInfoEl.innerHTML = `
      <div style="display:flex;justify-content:space-between;margin:2px 0;">
        <span style="color:var(--text-dim);">ลูกค้า</span>
        <strong>${escapeHtml(customerName || "—")}</strong>
      </div>
      <div style="display:flex;justify-content:space-between;margin:2px 0;">
        <span style="color:var(--text-dim);">WhatsApp</span>
        <strong>${escapeHtml(customerWhatsapp || "—")}</strong>
      </div>
      <div style="display:flex;justify-content:space-between;margin:2px 0;">
        <span style="color:var(--text-dim);">Order</span>
        <strong>${escapeHtml(receiptNumber || "—")}</strong>
      </div>
      <div style="display:flex;justify-content:space-between;margin:2px 0;">
        <span style="color:var(--text-dim);">ยอด</span>
        <strong>${amt}</strong>
      </div>
      ${rejectReason ? `<div style="margin-top:6px;padding-top:6px;border-top:1px dashed var(--border,#ddd);"><span style="color:var(--text-dim);">เหตุผล:</span> <strong style="color:var(--danger);">${escapeHtml(rejectReason)}</strong></div>` : ""}
    `;
  }

  // build prefilled message
  const message = buildWhatsAppNotifyMessage({ action, customerName, receiptNumber, orderTotal, rejectReason });
  messageEl.value = message;

  // show modal
  backdrop.classList.add("show");
  backdrop.setAttribute("aria-hidden", "false");
  if (errorHint) errorHint.style.display = "none";

  // bind open button (in click handler → not blocked by popup blocker)
  openBtn.onclick = () => {
    const num = String(customerWhatsapp || "").replace(/[^0-9]/g, "");
    if (!num) {
      if (errorHint) {
        errorHint.textContent = "ไม่พบเบอร์ลูกค้า — ไม่สามารถเปิด WhatsApp ได้";
        errorHint.style.display = "block";
      }
      return;
    }
    const editedText = messageEl.value.trim();
    if (!editedText) {
      if (errorHint) {
        errorHint.textContent = "กรุณากรอกข้อความก่อนส่ง";
        errorHint.style.display = "block";
      }
      return;
    }
    const waUrl = `https://wa.me/${num}?text=${encodeURIComponent(editedText)}`;
    window.open(waUrl, "_blank", "noopener");
    // ปิด modal หลังคลิก (optional — ปล่อยให้ admin ส่งซ้ำได้ถ้าต้องการ)
    // closeWhatsAppNotifyModal();
  };

  // bind copy button
  if (copyBtn) copyBtn.onclick = async () => {
    try {
      await navigator.clipboard.writeText(messageEl.value);
      showToast("📋 คัดลอกข้อความแล้ว", "success");
    } catch {
      messageEl.select();
      try { document.execCommand("copy"); showToast("📋 คัดลอกข้อความแล้ว", "success"); }
      catch { showToast("คัดลอกไม่สำเร็จ", "error"); }
    }
  };

  // bind close/cancel
  if (cancelBtn) cancelBtn.onclick = closeWhatsAppNotifyModal;
  if (closeBtn) closeBtn.onclick = closeWhatsAppNotifyModal;
}

function closeWhatsAppNotifyModal() {
  const backdrop = document.getElementById("whatsappNotifyBackdrop");
  if (backdrop) { backdrop.classList.remove("show"); backdrop.setAttribute("aria-hidden", "true"); }
}

// 📸 (added) Build WhatsApp message based on action (verified/rejected)
function buildWhatsAppNotifyMessage({ action, customerName, receiptNumber, orderTotal, rejectReason }) {
  const amt = (orderTotal != null && !isNaN(Number(orderTotal)))
    ? Number(orderTotal).toLocaleString("th-TH") + " ₭"
    : "—";
  const rcpt = receiptNumber || "—";
  if (action === "verified") {
    return `สวัสดีครับ/ค่ะ ${customerName || ""}

✅ ยืนยันสลิปการโอนเงินแล้ว

Order: ${rcpt}
ยอด: ${amt}

ไฟล์เพลงกำลังเตรียมให้ — แอดมินจะส่งลิงก์ดาวน์โหลดให้อีกครั้งในไม่ช้า
ขอบคุณที่สั่งซื้อครับ/ค่ะ 🙏`;
  }
  if (action === "rejected") {
    return `สวัสดีครับ/ค่ะ ${customerName || ""}

❌ สลิปการโอนเงินของคุณยังไม่ผ่านการตรวจสอบ

Order: ${rcpt}
ยอดที่ต้องชำระ: ${amt}

เหตุผล: ${rejectReason || "ไม่ระบุ"}

กรุณาตรวจสอบและอัปโหลดสลิปใหม่อีกครั้งที่หน้าเว็บ
หากมีข้อสงสัย ติดต่อแอดมินได้ครับ/ค่ะ 🙏`;
  }
  return `Order ${rcpt}`;
}

// bind modal backdrop click to close
document.addEventListener("DOMContentLoaded", () => {
  const backdrop = document.getElementById("whatsappNotifyBackdrop");
  if (backdrop) backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) closeWhatsAppNotifyModal();
  });
});

// bind refresh button
document.getElementById("refreshPaymentsBtn")?.addEventListener("click", () => {
  const btn = document.getElementById("refreshPaymentsBtn");
  if (btn) { btn.style.transform = "rotate(360deg)"; btn.style.transition = "transform 0.6s"; setTimeout(() => { btn.style.transform = ""; }, 600); }
  initPaymentsView();
});

// poll payments badge every 60s (same pattern as orders badge)
setInterval(refreshPaymentsBadge, 60_000);
refreshPaymentsBadge();

// ================= Confirm modal =================
// 🎨 (2026-09-26): อัปเกรดให้รองรับ options (title, okText, cancelText, danger, success)
//   - เดิม: openConfirm(text, onOk) — ใช้ได้แค่ข้อความเดียว + หัวข้อ "ยืนยันการลบ" ตายตัว
//   - ใหม่: openConfirm(text, onOk, options) — รองรับ options เหมือน customConfirm ฝั่งลูกค้า
//   - ยังรองรับ caller เดิมที่เรียกแบบ (text, onOk) → options จะเป็น undefined → ใช้ค่า default
//   หมายเหตุ: confirmAction ประกาศที่บรรทัด 84 (module-level) — ไม่ต้องประกาศซ้ำ
function openConfirm(text, onOk, options) {
  options = options || {};
  const titleEl = document.getElementById("confirmTitle");
  const textEl = document.getElementById("confirmText");
  const okBtn = document.getElementById("confirmOk");
  const cancelBtn = document.getElementById("confirmCancel");
  if (titleEl) titleEl.textContent = options.title || "กรุณายืนยัน";
  if (textEl) textEl.textContent = text;
  if (okBtn) {
    okBtn.textContent = options.okText || "ยืนยัน";
    // เปลี่ยน style ตามประเภท (danger/success/default)
    // 🛡️ ไม่ลบ class "danger" เดิม (เพราะ HTML ตั้งไว้) แค่เพิ่ม class ใหม่ถ้ามี
    okBtn.classList.remove("success-confirm");
    if (options.success) {
      okBtn.classList.remove("danger");
      okBtn.classList.add("success-confirm");
    } else if (options.danger === false) {
      // ถ้าระบุ danger:false ชัด ๆ → ใช้สีม่วง (default .btn)
      okBtn.classList.remove("danger");
    }
    // default: ถ้าไม่ระบุ danger หรือ success → ใช้ class "danger" ที่ตั้งไว้ใน HTML (ยืนยันการลบ)
  }
  if (cancelBtn) cancelBtn.textContent = options.cancelText || "ยกเลิก";
  confirmAction = onOk;
  document.getElementById("confirmBackdrop").classList.add("show");
  // 🆕 (2026-09-26): focus ที่ปุ่มยืนยันเพื่อ accessibility
  if (okBtn) okBtn.focus();
}
document.getElementById("confirmCancel").addEventListener("click", () => {
  document.getElementById("confirmBackdrop").classList.remove("show");
  // 🛡️ (2026-09-26): ล้าง confirmAction เมื่อ cancel (กัน leak ไปยัง modal ถัดไป)
  confirmAction = null;
});
// 🆕 (2026-09-26): ปุ่ม close (✕) และคลิกพื้นหลัง = ยกเลิก
document.getElementById("confirmCloseBtn")?.addEventListener("click", () => {
  document.getElementById("confirmBackdrop").classList.remove("show");
  confirmAction = null;
});
document.getElementById("confirmBackdrop")?.addEventListener("click", (e) => {
  if (e.target === e.currentTarget) {
    document.getElementById("confirmBackdrop").classList.remove("show");
    confirmAction = null;
  }
});
document.getElementById("confirmOk").addEventListener("click", async () => {
  // 🔧 (2026-09-22 Batch 7 fix Bug #9): รอ confirmAction เสร็จก่อนค่อยปิด modal
  //   เดิม: ปิด modal ก่อน → แล้วเรียก confirmAction → แต่ adminConfirm's setInterval detect modal ปิด → resolve(false) ก่อน
  //   ใหม่: เรียก confirmAction ก่อน → รอเสร็จ → ปิด modal ทีหลัง
  //   ผลกระทบ: ปุ่ม "ยืนยัน" อาจค้างสักครู่รอ confirmAction (เช่น save song) → เปิดปุ่มกลับหลังเสร็จ
  if (confirmAction) {
    try { await confirmAction(); } catch (err) { console.error("confirmAction error:", err); }
  }
  document.getElementById("confirmBackdrop").classList.remove("show");
});

// 🔧 (2026-09-22 Batch 7 fix Bug #9): Promise-based confirm modal — แก้ race condition
//   ปัญหาเดิม: setInterval(100ms) เช็ค class "show" ถูกลบ → resolve(false) ก่อน resolve(true)
//              → adminConfirm คืน false เสมอ แม้ user กด "ยืนยัน" → bugs หลายตัวที่ใช้ adminConfirm
//   วิธีแก้: ใช้ state flag แยก "okClicked" vs "cancelClicked" → resolve ครั้งเดียวจากทางที่ถูกต้อง
//   ผลกระทบระบบเดิม: 0% — adminConfirm ยังคืน Promise<boolean> เหมือนเดิม แค่ค่าที่ได้ถูกต้อง
//
// 🎨 (2026-09-26): อัปเกรดให้รองรับ options (เหมือน customConfirm ฝั่งลูกค้า)
//   - adminConfirm(message)                       → ใช้ default (เหมือนเดิม — backward compat)
//   - adminConfirm(message, { title, okText, danger, success, cancelText })
//   ยังรองรับ caller เดิมที่เรียกแบบ adminConfirm(message) → ใช้ค่า default ของ HTML (danger)
function adminConfirm(message, options) {
  return new Promise((resolve) => {
    let resolved = false;
    // Helper: resolve ครั้งเดียว (กันซ้ำ)
    const safeResolve = (val) => {
      if (resolved) return;
      resolved = true;
      // ล้าง confirmAction เพื่อกัน leak ไปยัง modal ถัดไป
      confirmAction = null;
      resolve(val);
    };
    // ตั้งค่า confirmAction เป็น wrapper ที่ resolve(true) แทน resolve(true) ตรงๆ
    // เพื่อกันซ้ำ + ล้าง state หลัง resolve
    openConfirm(message, () => safeResolve(true), options);
    // ฟังการปิด modal (ยกเลิก / กดพื้นหลัง / ESC) — แทน setInterval
    //   ใช้ MutationObserver (efficient กว่า setInterval มาก)
    const backdrop = document.getElementById("confirmBackdrop");
    const observer = new MutationObserver(() => {
      if (!backdrop.classList.contains("show")) {
        observer.disconnect();
        // ถ้ายังไม่ได้ resolve (เช่น กด cancel หรือ กดพื้นหลัง) → resolve(false)
        safeResolve(false);
      }
    });
    observer.observe(backdrop, { attributes: true, attributeFilter: ["class"] });
    // Safety: ล้าง observer หลัง 30 วินาที (กัน leak)
    setTimeout(() => {
      observer.disconnect();
      safeResolve(false);
    }, 30000);
    // 🆕 (2026-09-26): ESC = ยกเลิก (เหมือน customConfirm ฝั่งลูกค้า)
    const escHandler = (e) => {
      if (e.key === 'Escape' && backdrop.classList.contains('show')) {
        document.removeEventListener('keydown', escHandler);
        document.getElementById("confirmBackdrop").classList.remove("show");
        // safeResolve(false) จะถูกเรียกโดย MutationObserver
      }
    };
    document.addEventListener('keydown', escHandler);
  });
}

// 🆕 (2026-09-26): adminAlert — สำหรับแทน alert() แบบเดิม
//   ใช้ผ่าน adminAlert(message, options) → Promise<void>
//   options: { title, okText }
//   ตัวอย่าง:
//     await adminAlert("บันทึกสำเร็จ", { title: "สำเร็จ", okText: "ตกลง" });
function adminAlert(message, options) {
  return new Promise((resolve) => {
    options = options || {};
    const backdrop = document.getElementById("alertBackdrop");
    const titleEl = document.getElementById("alertTitle");
    const messageEl = document.getElementById("alertMessage");
    const okBtn = document.getElementById("alertOkBtn");
    const closeBtn = document.getElementById("alertCloseBtn");
    if (!backdrop || !messageEl || !okBtn) {
      // fallback: ถ้า element ไม่มี → ใช้ alert() แบบเดิม (กันพัง)
      alert(message);
      resolve();
      return;
    }
    if (titleEl) titleEl.textContent = options.title || "แจ้งเตือน";
    messageEl.textContent = message;
    okBtn.textContent = options.okText || "ตกลง";
    backdrop.classList.add("show");
    backdrop.setAttribute("aria-hidden", "false");
    // ล็อก body scroll
    document.body.classList.add("modal-open");
    let done = false;
    const cleanup = () => {
      if (done) return;
      done = true;
      backdrop.classList.remove("show");
      backdrop.setAttribute("aria-hidden", "true");
      document.body.classList.remove("modal-open");
      okBtn.removeEventListener("click", onOk);
      closeBtn?.removeEventListener("click", onClose);
      backdrop.removeEventListener("click", onBackdrop);
      document.removeEventListener("keydown", onEsc);
      resolve();
    };
    const onOk = () => cleanup();
    const onClose = () => cleanup();
    const onBackdrop = (e) => { if (e.target === backdrop) cleanup(); };
    const onEsc = (e) => { if (e.key === 'Escape') cleanup(); };
    okBtn.addEventListener("click", onOk);
    closeBtn?.addEventListener("click", onClose);
    backdrop.addEventListener("click", onBackdrop);
    document.addEventListener("keydown", onEsc);
    // focus ที่ปุ่มตกลงเพื่อ accessibility
    okBtn.focus();
    // Safety: ปิดอัตโนมัติหลัง 30 วินาที
    setTimeout(cleanup, 30000);
  });
}

// ให้ admin-roles.js เรียกใช้ toast/confirm/alert modal ตัวเดียวกับหน้านี้ได้ (ไม่ต้องสร้างซ้ำ)
window.__showToast = showToast;
window.__openConfirm = openConfirm;
// 🆕 (2026-09-26): expose adminConfirm/adminAlert ให้ใช้ได้ทั้งจาก app-admin.js และไฟล์อื่น (orders.js, app-promotion.js, admin-roles.js)
window.adminConfirm = adminConfirm;
window.adminAlert = adminAlert;

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
      ? ` · ห้อง ${escapeHtml(String(s.preview_start_bar))}–${escapeHtml(String(s.preview_end_bar))}` : "";
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
        ? ` · ห้อง ${escapeHtml(String(payload.preview_start_bar))}–${escapeHtml(String(payload.preview_end_bar))}` : "";
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
