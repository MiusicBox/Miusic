// storage-adapter.js
// ===================================================
// ชั้นกลางสำหรับอัปโหลดไฟล์ (เพลง/รูปภาพ) — ทุกส่วนของแอปเรียกผ่านฟังก์ชันในไฟล์นี้
// แทนที่จะยิงไปหา Cloudinary ตรงๆ เพื่อให้สลับผู้ให้บริการ Storage ในอนาคต (เช่น Cloudflare R2)
// ได้โดยไม่ต้องแก้โค้ดฝั่ง admin/orders เลย
//
// วิธีย้ายไป R2 ในอนาคต:
//   1. Implement เมธอด upload() ใน R2Provider ด้านล่างให้ครบ (ต้องมี backend/Cloud Function
//      สร้าง presigned URL ให้ก่อน เพราะ R2 secret key ห้ามฝังในโค้ดฝั่ง browser)
//   2. เปลี่ยนค่า ACTIVE_PROVIDER เป็น "r2"
//   3. เสร็จ — โค้ดที่เหลือไม่ต้องแก้
// ===================================================
// ค่า Cloudinary — ย้ายมาจาก firebase-init.js (2026-09-10) เพราะมีแค่ไฟล์นี้ไฟล์เดียวที่ใช้
// (ทำให้ firebase-init.js เรียก getStorageProvider() จากไฟล์นี้ได้โดยไม่เกิด import วนกลับไปมา)
const CLOUDINARY_CLOUD_NAME = "g4nmb7ho";
const CLOUDINARY_UPLOAD_PRESET = "music_store_unsigned";

// สร้าง Error สำหรับกรณีอัปโหลดถูกยกเลิก (ให้ผู้เรียกเช็คได้ด้วย err.name === "AbortError")
function makeAbortError() {
  const err = new Error("อัปโหลดถูกยกเลิก");
  err.name = "AbortError";
  return err;
}

// ---------------- Cloudinary Provider (ใช้งานจริงตอนนี้) ----------------
const CloudinaryProvider = {
  name: "cloudinary",

  // folder: โฟลเดอร์ปลายทางใน Cloudinary
  // หมายเหตุ: ถ้า unsigned upload preset ตั้งค่า "Folder" เป็น Fixed/Disabled ไว้ พารามิเตอร์นี้จะถูกเมิน
  // และไฟล์จะถูกเก็บตาม path ที่ preset กำหนดแทน — เข้า Cloudinary Console > Upload presets เพื่อเช็ค/แก้ได้
  // signal (ไม่บังคับ): ส่ง AbortController().signal เข้ามาเพื่อยกเลิกอัปโหลดจริงกลางทางได้ (ยิง xhr.abort())
  async upload(file, { folder = "", resourceType = "auto" } = {}, onProgress, signal) {
    return new Promise((resolve, reject) => {
      const url = `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/${resourceType}/upload`;
      const formData = new FormData();
      formData.append("file", file);
      formData.append("upload_preset", CLOUDINARY_UPLOAD_PRESET);
      if (folder) formData.append("folder", folder);

      const xhr = new XMLHttpRequest();
      xhr.open("POST", url);

      if (signal) {
        if (signal.aborted) { reject(makeAbortError()); return; }
        signal.addEventListener("abort", () => xhr.abort());
      }

      xhr.upload.onprogress = (e) => {
        if (onProgress && e.lengthComputable) {
          // ส่งทั้งเปอร์เซ็นต์และจำนวนไบต์จริง (loaded/total) ให้ผู้เรียกใช้แสดงผลแบบ "2 MB / 6 MB" แบบเรียลไทม์ได้
          onProgress(Math.round((e.loaded / e.total) * 100), e.loaded, e.total);
        }
      };
      xhr.onload = () => {
        try {
          const data = JSON.parse(xhr.responseText);
          if (xhr.status >= 200 && xhr.status < 300 && data.secure_url) {
            resolve({ url: data.secure_url, publicId: data.public_id, provider: "cloudinary" });
          } else {
            // ปฏิเสธจาก Cloudinary เอง (เช่น format/preset ไม่อนุญาต) — ไม่ใช่ปัญหาเครือข่าย
            // จึงไม่ติด retryable=true เพราะลองใหม่ไปก็จะพังซ้ำเหมือนเดิม
            reject(new Error(data.error ? data.error.message : `อัปโหลดไม่สำเร็จ (HTTP ${xhr.status})`));
          }
        } catch (err) {
          reject(err);
        }
      };
      xhr.onerror = () => {
        const err = new Error(
          "เชื่อมต่อ Cloudinary ไม่สำเร็จ — ตรวจสอบ Cloud Name, Upload Preset, CORS หรือการเชื่อมต่ออินเทอร์เน็ต"
        );
        err.retryable = true; // ปัญหาเครือข่าย — ลองใหม่ได้
        reject(err);
      };
      xhr.ontimeout = () => {
        const err = new Error("Cloudinary ใช้เวลาตอบกลับนานเกินไป");
        err.retryable = true; // timeout — ลองใหม่ได้
        reject(err);
      };
      xhr.onabort = () => reject(makeAbortError()); // ผู้ใช้กดยกเลิกเอง — ห้าม retry เด็ดขาด
      xhr.timeout = 10 * 60 * 1000;
      xhr.send(formData);
    });
  },
};

// ---------------- R2 Provider (ใช้งานจริง — อัปโหลดผ่าน Worker backend ของเว็บเอง) ----------------
// อัปโหลดตรงจาก browser ไป R2 ทำไม่ได้ (ต้องเซ็น request ด้วย Access Key/Secret ซึ่งห้ามฝังฝั่งเว็บ)
// จึงส่งไฟล์มาที่ endpoint "/api/upload" ของเว็บเราเอง (same-origin, ดู worker/index.js) แล้วให้ Worker
// เขียนต่อเข้า R2 ผ่าน binding แทน — โครง progress/timeout/retry/abort เหมือน CloudinaryProvider ทุกจุด
// เพื่อให้ผู้เรียก (app-admin.js/orders.js ผ่าน firebase-init.js) เห็นพฤติกรรมเหมือนเดิมทุกประการ
const R2Provider = {
  name: "r2",

  async upload(file, { folder = "", resourceType = "auto" } = {}, onProgress, signal) {
    return new Promise((resolve, reject) => {
      const formData = new FormData();
      formData.append("file", file);
      if (folder) formData.append("folder", folder);
      if (resourceType) formData.append("resourceType", resourceType);

      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/upload");

      if (signal) {
        if (signal.aborted) { reject(makeAbortError()); return; }
        signal.addEventListener("abort", () => xhr.abort());
      }

      xhr.upload.onprogress = (e) => {
        if (onProgress && e.lengthComputable) {
          onProgress(Math.round((e.loaded / e.total) * 100), e.loaded, e.total);
        }
      };
      xhr.onload = () => {
        try {
          const data = JSON.parse(xhr.responseText);
          if (xhr.status >= 200 && xhr.status < 300 && data.url) {
            resolve({ url: data.url, publicId: data.publicId, provider: "r2" });
          } else {
            // ปฏิเสธจาก backend เอง (เช่น ตั้งค่า bucket ผิด, ไฟล์ไม่ถูกต้อง) — ไม่ใช่ปัญหาเครือข่าย
            // จึงไม่ติด retryable=true เพราะลองใหม่ไปก็จะพังซ้ำเหมือนเดิม (เหมือน CloudinaryProvider)
            reject(new Error(data.error || `อัปโหลดไม่สำเร็จ (HTTP ${xhr.status})`));
          }
        } catch (err) {
          reject(err);
        }
      };
      xhr.onerror = () => {
        const err = new Error("เชื่อมต่อเซิร์ฟเวอร์อัปโหลดไม่สำเร็จ — ตรวจสอบการเชื่อมต่ออินเทอร์เน็ตแล้วลองใหม่");
        err.retryable = true; // ปัญหาเครือข่าย — ลองใหม่ได้
        reject(err);
      };
      xhr.ontimeout = () => {
        // 🔧 (2026-09-22 fix Bug #2 UI v7): ปรับ timeout เป็น 5 นาที (300 วิ)
        //   เหตุผล: 90 วิสั้นเกินสำหรับไฟล์ใหญ่ (WAV 100MB) หรือเน็ตช้า (3G)
        //   5 นาที = สมดุลระหว่าง "ไม่ใช้เวลานานเกินไป" กับ "รองรับไฟล์ใหญ่/เน็ตช้า"
        //   ถ้าเกิน 5 นาที → ถือว่า hang จริง → ให้ user ลองใหม่
        const err = new Error("อัปโหลดใช้เวลานานเกิน 5 นาที — เซิร์ฟเวอร์อาจไม่ตอบ กรุณาลองใหม่อีกครั้ง");
        err.retryable = true;
        reject(err);
      };
      xhr.onabort = () => reject(makeAbortError()); // ผู้ใช้กดยกเลิกเอง — ห้าม retry เด็ดขาด
      // 🔧 (2026-09-22 fix Bug #2 UI v7): 5 นาที (300 วิ) — สมดุลระหว่างไฟล์เล็ก/ใหญ่ + เน็ตเร็ว/ช้า
      //   - ไฟล์ MP3 (5-15 MB) บน WiFi/4G → ใช้ไม่เกิน 30 วิ → ไม่กระทบ
      //   - ไฟล์ WAV (50-100 MB) บน WiFi → ใช้ไม่เกิน 90 วิ → ไม่กระทบ
      //   - ไฟล์ WAV ใหญ่บน 3G → อาจใช้ถึง 5 นาที → ยังไม่ timeout (ดีกว่า 90 วิ)
      //   - ถ้าเซิร์ฟเวอร์ hang จริง → user รอ 5 นาที แล้วเห็น error (ดีกว่ารอ 10 นาที)
      xhr.timeout = 5 * 60 * 1000;
      xhr.send(formData);
    });
  },
};

const PROVIDERS = { cloudinary: CloudinaryProvider, r2: R2Provider };

// ย้ายมาใช้ R2 แล้ว (2026-09-10) — เก็บ "cloudinary" ไว้ใน PROVIDERS ด้านบนเผื่อต้องสลับกลับฉุกเฉิน
// แค่เปลี่ยนค่านี้กลับเป็น "cloudinary" ก็พอ ไม่ต้องแก้ไฟล์อื่น
const ACTIVE_PROVIDER = "r2";

export function getStorageProvider() {
  return PROVIDERS[ACTIVE_PROVIDER];
}

// อัปโหลดไฟล์เพลงตัวอย่าง/รูปภาพ (ใช้ folder เดิม หรือไม่ระบุก็ได้) — คงพฤติกรรมเดิมไว้ทุกประการ
// signal (ไม่บังคับ): ส่งเข้ามาเพื่อยกเลิกอัปโหลดจริงกลางทางได้
export async function uploadToStorage(file, onProgress, folder = "", signal) {
  return getStorageProvider().upload(file, { folder }, onProgress, signal);
}

// ⚠️ retry เฉพาะจุดนี้ (เพลงเต็ม) ตามที่ผู้ใช้สั่งไว้เท่านั้น — ห้ามลาม/ย้ายไป apply กับ
// uploadToStorage หรือ uploadOrderZip โดยไม่มีคำสั่งผู้ใช้เพิ่ม
// จะ retry เฉพาะกรณี err.retryable === true (ปัญหาเครือข่าย/timeout เท่านั้น) — ไม่ retry
// เมื่อผู้ใช้กดยกเลิก (AbortError) และไม่ retry เมื่อ Cloudinary ปฏิเสธไฟล์ (format ไม่ถูกต้อง ฯลฯ)
// เพราะกรณีหลังลองใหม่ไปก็ไม่มีทางสำเร็จ มีแต่จะเสียเวลาผู้ใช้เปล่าๆ
async function withUploadRetry(uploadFn, { maxRetries = 2, delayMs = 3000, onRetry } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await uploadFn();
    } catch (err) {
      lastErr = err;
      const isAbort = err?.name === "AbortError";
      const canRetry = !isAbort && err?.retryable === true && attempt < maxRetries;
      if (!canRetry) throw err;
      if (onRetry) onRetry(attempt + 1, maxRetries, err);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastErr;
}

// อัปโหลดไฟล์เพลงเต็ม WAV/MP3 — เก็บแยกโฟลเดอร์ "full-songs" ไม่ปนกับไฟล์ตัวอย่างที่โชว์บนเว็บ user
// (โฟลเดอร์นี้ไม่ถูก reference จากหน้าเว็บ user เลย ใช้เฉพาะฝั่ง Admin เท่านั้น)
// onRetry (ไม่บังคับ): callback(attemptNumber, maxRetries, err) — ให้ฝั่ง UI (app-admin.js) โชว์สถานะ
// "กำลังลองใหม่..." ให้ผู้ใช้เห็นตอนอัปโหลดหลุด/timeout แล้วระบบกำลังลองซ้ำอัตโนมัติ
export async function uploadFullSong(file, onProgress, signal, onRetry) {
  return withUploadRetry(
    () => getStorageProvider().upload(file, { folder: "full-songs" }, onProgress, signal),
    { maxRetries: 2, delayMs: 3000, onRetry }
  );
}

// อัปโหลด ZIP ที่ระบบสร้างจากไฟล์เต็มของออเดอร์
// แยกโฟลเดอร์จากไฟล์เพลงเดิม เพื่อไม่กระทบลิงก์/ข้อมูลเพลงที่มีอยู่แล้ว
export async function uploadOrderZip(file, onProgress, signal) {
  // ZIP เป็นไฟล์ archive ไม่ใช่รูป/วิดีโอ จึงส่งผ่าน raw/upload โดยเฉพาะ
  return getStorageProvider().upload(
    file,
    { folder: "order-zips", resourceType: "raw" },
    onProgress,
    signal
  );
}

// ---------------- ลบไฟล์ออกจาก Storage (ใหม่ 2026-09-11 — ระบบจัดการไฟล์ cloud) ----------------
// ใช้ตอนลบเพลง (ไฟล์เต็ม/ไฟล์ตัวอย่าง/รูปปกที่ไม่มีใครใช้แล้ว) และลบ ZIP ออเดอร์เพื่อประหยัดพื้นที่
// ทำงานเฉพาะ provider "r2" เท่านั้น (มี endpoint /api/upload DELETE รองรับ) — ถ้า ACTIVE_PROVIDER
// เป็น cloudinary (เผื่อสลับกลับฉุกเฉิน) จะข้ามแบบไม่ error เพราะ Cloudinary ไม่มี endpoint ลบให้ฝั่งนี้เรียก
// ส่ง { key } (public_id ตรงๆ) หรือ { url } (ให้ backend derive key เอง) อย่างใดอย่างหนึ่ง
// ไม่ throw เมื่อลบไม่สำเร็จ — คืนค่า { ok:false, error } แทน เพื่อไม่ให้ผู้เรียก (ลบเพลง/ลบ ZIP) พังทั้งกระบวนการ
// แค่เพราะไฟล์ cloud ลบไม่สำเร็จ (เช่น ไฟล์ถูกลบไปแล้วก่อนหน้า, เครือข่ายมีปัญหาชั่วคราว)
export async function deleteFromStorage({ key, url } = {}) {
  if (!key && !url) return { ok: false, skipped: true };
  if (getStorageProvider().name !== "r2") return { ok: false, skipped: true };
  try {
    const res = await fetch("/api/upload", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, url }),
    });
    let data = null;
    try { data = await res.json(); } catch { /* ไม่มี body หรือไม่ใช่ JSON */ }
    if (!res.ok) {
      return { ok: false, error: (data && data.error) || `ลบไฟล์ไม่สำเร็จ (HTTP ${res.status})` };
    }
    return data || { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}
