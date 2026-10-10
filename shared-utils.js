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
  if (window.__notify) { window.__notify.toast(message, type); return; } // 🎨 ระบบแจ้งเตือนใหม่
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
  if (rest.length === 9 && /^[6-9]/.test(rest)) {
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

// 🆕 (T044-C): formatPhoneForDisplay — แปลงเบอร์ normalized (85620XXXXXXXX / 668XXXXXXXXX)
//   ให้เป็นรูปแบบที่อ่านง่าย: "+856 20 1234 5678" หรือ "+66 81 234 5678"
//   ใช้ใน receipt, order list, WhatsApp FAB, customer info ฯลฯ
//   ถ้าเบอร์ไม่ตรงรูปแบบลาว/ไทย → คืน raw + เครื่องหมาย + นำหน้า (best effort)
export function formatPhoneForDisplay(phone) {
  if (!phone) return "";
  let s = String(phone).replace(/[^0-9]/g, "");
  if (!s) return "";
  // ลาว: 856 + 20 + 4 + 4 = 13 หลัก → "+856 20 1234 5678"
  //       856 + 2X + ... = 10-12 หลัก
  if (s.startsWith("856")) {
    const rest = s.slice(3);
    // รูปแบบทั่วไป: 20XXXXXXXX (10 หลักหลัง 856)
    if (rest.startsWith("20") && rest.length === 10) {
      return `+856 20 ${rest.slice(2, 6)} ${rest.slice(6)}`;
    }
    // รูปแบบอื่น ๆ ของลาว (เบอร์เครื่องบ้าน ฯลฯ) — แยกหลัก 3-4-4
    if (rest.length >= 6 && rest.length <= 9) {
      const mid = rest.slice(0, Math.ceil(rest.length / 2));
      const end = rest.slice(Math.ceil(rest.length / 2));
      return `+856 ${mid} ${end}`;
    }
    return `+856 ${rest}`;
  }
  // ไทย: 66 + 8/9 + 8 หลัก = 11 หลัก → "+66 81 234 5678"
  if (s.startsWith("66")) {
    const rest = s.slice(2);
    // มือถือไทย: 8XXXXXXXX หรือ 9XXXXXXXX (9 หลักหลัง 66)
    if (rest.length === 9 && /^[6-9]/.test(rest)) {
      return `+66 ${rest.slice(0, 2)} ${rest.slice(2, 5)} ${rest.slice(5)}`;
    }
    // รูปแบบอื่น ๆ ของไทย (เบอร์เครื่องบ้าน ฯลฯ)
    if (rest.length >= 6 && rest.length <= 9) {
      const mid = rest.slice(0, Math.ceil(rest.length / 2));
      const end = rest.slice(Math.ceil(rest.length / 2));
      return `+66 ${mid} ${end}`;
    }
    return `+66 ${rest}`;
  }
  // fallback — เบอร์ไม่มี country code → คืน raw
  return s;
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
    formatPhoneForDisplay,
  };
}
