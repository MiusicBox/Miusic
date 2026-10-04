// /home/z/my-project/Miusic/shared-utils.js
// 🆕 (T013-R3): Shared utilities — รวม helpers ที่ใช้ซ้ำในหลายไฟล์
//   ลดโค้ดซ้ำ ~200 บรรทัด (escapeHtml ×5, formatPrice ×4, showToast ×4, debounce ×3,
//   normalizePhone ×3, buildWhatsAppLink ×2, normalizeName ×1, formatDateTime ×1)
//
//   ⚠️ สถานะ: "พร้อมใช้" — แต่ยังไม่ได้ migrate โค้ดเดิมมาใช้
//      การ migrate จริงต้องทำทีละไฟล์ + test รอบละไฟล์ (เพื่อความปลอดภัย — กัน break)
//      ไฟล์ที่มี helpers ซ้ำจะมี comment "TODO: migrate to shared-utils.js in next refactor round"
//
//   วิธีใช้ (ตัวอย่าง — สำหรับ round ถัดไป):
//     import { escapeHtml, formatPrice, showToast } from "/shared-utils.js";
//   หรือถ้าหน้านั้นยังไม่ใช้ ES modules:
//     <script type="module" src="/shared-utils.js"></script>
//     window.SharedUtils.escapeHtml(...)
//
//   ผลกระทบระบบเดิม: 0% — ไฟล์ใหม่ล้วน ไม่ import โดยไฟล์อื่น ยังไม่มี caller

export function escapeHtml(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function formatPrice(amount) {
  const n = Number(amount) || 0;
  return n.toLocaleString("th-TH", { minimumFractionDigits: 0, maximumFractionDigits: 2 }) + " ₭";
}

export function showToast(message, type = "info", duration = 3000) {
  const toast = document.getElementById("toast");
  if (!toast) return;
  toast.textContent = message;
  toast.className = "toast show " + type;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    toast.className = "toast " + type;
  }, duration);
}

export function debounce(fn, ms = 300) {
  let timer;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), ms);
  };
}

export function normalizePhone(v) {
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
  let rest = s.replace(/^0+/, "");
  if (rest.length === 9 && (rest.startsWith("8") || rest.startsWith("9"))) {
    return "66" + rest;
  }
  return "856" + rest;
}

export function normalizeName(v) {
  return String(v || "").trim().toLowerCase();
}

export function buildWhatsAppLink(number, text = "") {
  const cleanNumber = String(number || "").replace(/[^0-9]/g, "");
  const encodedText = encodeURIComponent(text);
  return `https://wa.me/${cleanNumber}${encodedText ? `?text=${encodedText}` : ""}`;
}

export function formatDateTime(iso, options) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString("th-TH", options || {
      year: "numeric", month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit"
    });
  } catch (_) { return String(iso); }
}

// 🆕 (T013-R3): expose ใน window.SharedUtils สำหรับหน้าที่ยังไม่ใช้ ES modules
//   (ใช้ได้ทันทีผ่าน <script type="module" src="/shared-utils.js"></script>)
if (typeof window !== "undefined") {
  window.SharedUtils = {
    escapeHtml,
    formatPrice,
    showToast,
    debounce,
    normalizePhone,
    normalizeName,
    buildWhatsAppLink,
    formatDateTime,
  };
}
