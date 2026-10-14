// song-analyzer.js
// ===================================================
// ระบบ Auto Preview: วิเคราะห์ไฟล์เพลงหา "ช่วง Dance" 16 ห้อง แล้วคำนวณช่วง Preview
//
// [อัปเดตกติกา Preview — เปลี่ยนตามคำสั่งผู้ใช้]
//   เดิม (v1): Preview = 24 ห้องก่อนหน้า Dance + Dance 16 ห้อง (นับถอยหลังจาก Dance)
//   เดิม (v2): ทุกเพลง Preview เริ่มเล่นจาก "ห้องที่ 1" ของเพลงเสมอ แล้วเล่นยาวต่อเนื่อง
//              ไปจนถึง "ห้องที่ 8 ของช่วง Dance" (Dance Start Bar + 8) แล้วหยุด
//   ล่าสุด (v3 — แก้ปัญหาเพลงที่มี 2 ท่อนแดน เช่น ร้อง-แดน-ร้อง-แดน):
//     1) จุดเริ่มเล่น Preview เปลี่ยนจาก "ห้องที่ 1" เป็น "ห้องที่ 6" ของทุกเพลง (คงที่ ไม่ผูกกับ Dance)
//     2) อัลกอริทึมค้นหาช่วง Dance 16 ห้อง (findDanceWindow) ถูกจำกัดขอบเขตให้ค้นหา
//        เฉพาะ "ครึ่งแรกของเพลง" เท่านั้น เพื่อให้จับ "ท่อนแดนแรก" เสมอ ไม่ไปเจอท่อนแดนที่ 2
//        ที่อาจมีพลังงาน/onset สูงกว่าและถูกเลือกผิดช่วงถ้าสแกนทั้งเพลง
//     3) จุดหยุดเล่นยังคงเป็น "ห้องที่ 8 ของช่วง Dance ที่เจอ" (Dance Start Bar + 8) เหมือนเดิม
//     4) ผลลัพธ์: Preview ทุกเพลง = ห้อง 6 → (Dance Start Bar + 8) เท่านั้น ไม่โชว์ส่วนอื่นของเพลง
//        ในหน้า user เว้นแต่แอดมินจะตั้งค่าเองผ่าน manualPreviewWindow()
//   หมายเหตุ: ตัวสูตร/เกณฑ์การให้คะแนนภายใน findDanceWindow (RMS, Spectral Flux, Onset,
//   sustainedBonus, threshold ยอมรับผล) ไม่มีการเปลี่ยนแปลงใดๆ — เปลี่ยนแค่ "ขอบเขตที่สแกน"
//   กับ "จุดเริ่ม Preview" เท่านั้น (ฟังก์ชัน findDanceWindow + computePreviewWindow)
//
//   เพิ่มเติม: เพิ่มฟังก์ชัน manualPreviewWindow() ใหม่ ให้แอดมินกำหนด "ห้องเริ่มเล่น" และ
//   "ห้องหยุดเล่น" ของ Preview ได้เองแบบอิสระ (ไม่ผูกกับสูตร Dance ด้านบนเลย) — ใช้เสริมจากระบบเดิม
//   ระบบเดิม (analyzeSongFile / analyzeSongUrl / recalculateFromManualBar ด้วยสูตรใหม่) ยังใช้งานได้ครบ
//
// ⚠️ สำคัญ: โมดูลนี้ "ไม่ตัดไฟล์" และ "ไม่อัปโหลดไฟล์ใหม่" ใดๆ ทั้งสิ้น
// ไฟล์เพลงตัวอย่างที่เก็บอยู่ใน Cloudinary ยังเป็นไฟล์เต็มเหมือนเดิมทุกประการ
// ระบบนี้แค่คำนวณ "วินาทีเริ่ม-จบ" ของ Preview เก็บไว้ใน Firestore เท่านั้น
// ส่วนการ seek ไปเล่น/หยุดที่วินาทีนั้นทำที่ app-user.js (ฝั่ง user) — โค้ดฝั่ง user ไม่ต้องแก้ไข
// เพราะเล่นตาม preview_start_sec/preview_end_sec ที่บันทึกไว้อยู่แล้วโดยไม่สนใจว่าค่ามาจากสูตรไหน
//
// ทุกเพลงในระบบตายตัวที่ BPM 150, จังหวะ 4/4 → 1 ห้อง = 1.6 วินาที เสมอ
// (ไม่มีการหา BPM จากไฟล์ เพราะเป็นค่าคงที่ตามสเปกของระบบนี้ — ห้าม hardcode "เวลา"
//  แต่ BPM/บาร์คงที่ตามที่กำหนดไว้ล่วงหน้าไม่ถือเป็นการ hardcode จุด Dance)
//
// วิธีวิเคราะห์: ใช้ Web Audio API decode ไฟล์เสียงในเบราว์เซอร์ตรงๆ (ไม่พึ่ง library ภายนอก
// ไม่ต้องโหลดอะไรเพิ่มจาก CDN) คำนวณ RMS (พลังงาน) + Spectral Flux (การเปลี่ยนแปลงของสเปกตรัม
// ใช้เป็นตัวจับ Onset ของกลอง/จังหวะ) ต่อเฟรม แล้วรวมเป็นค่าเฉลี่ยรายห้อง จากนั้นเลื่อนหาช่วง
// 16 ห้องที่ "พลังงานสูงสมำ่เสมอต่อเนื่อง" (ไม่ใช่แค่ห้องที่ดังที่สุดห้องเดียว)
// ===================================================

export const BPM = 150;
export const BEATS_PER_BAR = 4;
export const BAR_SECONDS = (60 / BPM) * BEATS_PER_BAR; // = 1.6 วินาทีต่อห้อง (คงที่ทั้งระบบ)

// 🆕 (T136 2026-10-13): barSecondsFor(bpm) — คำนวณ BAR_SECONDS ตาม BPM จริงของแต่ละเพลง
//   สูตร: 4 × (60 / BPM) = 240 / BPM วินาทีต่อห้อง
//   ตาราง ms/beat ที่ระบบใช้ (ตรงกับแอป DJ 100%):
//     BPM 150 → 400.00 ms/beat → BAR_SECONDS 1.60000
//     BPM 155 → 387.10 ms/beat → BAR_SECONDS 1.54839
//     BPM 160 → 375.00 ms/beat → BAR_SECONDS 1.50000
//     BPM 165 → 363.64 ms/beat → BAR_SECONDS 1.45455
//   ถ้า bpm ผิด/ว่าง/เกิน range → fallback 150 (BAR_SECONDS = 1.6)
export function barSecondsFor(bpm) {
  const raw = Number(bpm);
  if (!Number.isFinite(raw) || raw < 30 || raw > 300) return BAR_SECONDS; // default 1.6
  return (60 / raw) * BEATS_PER_BAR;
}

// 🆕 (T136): clampBpm(bpm) — clamp ค่า BPM เข้า range 150-165 (ตามสเปกระบบ)
//   ถ้า bpm ผิด → 150
//   ถ้า < 150 → 150
//   ถ้า > 165 → 165
export function clampBpm(bpm) {
  const raw = Number(bpm);
  if (!Number.isFinite(raw) || raw < 150) return 150;
  if (raw > 165) return 165;
  return Math.round(raw);
}

// 🆕 (BPM-sync): ค่าเวลา/ความไวของ BPM ให้ตรงกับตารางแอป DJ (djay / rekordbox ฯลฯ บน MacBook + iPhone)
//   beatMsFor(bpm)          → มิลลิวินาทีต่อ 1 จังหวะ = 60000 / BPM  (150 → 400.00, 151 → 397.35, 165 → 363.64)
//   bpmStepPct(bpm)         → % ที่เร็วขึ้นจาก BPM ก่อนหน้า (−1)     = (BPM / (BPM−1) − 1) × 100  (151 → 0.67)
//   bpmVsBasePct(bpm, base) → % ที่เร็วขึ้นจาก BPM ฐาน (default 150)  = (BPM / base − 1) × 100     (155 → 3.33, 165 → 10.00)
export function beatMsFor(bpm) {
  const raw = Number(bpm);
  if (!Number.isFinite(raw) || raw < 30 || raw > 300) return 60000 / BPM;
  return 60000 / raw;
}
export function bpmStepPct(bpm) {
  const raw = Number(bpm);
  if (!Number.isFinite(raw) || raw <= 31 || raw > 300) return null;
  return (raw / (raw - 1) - 1) * 100;
}
export function bpmVsBasePct(bpm, base = BPM) {
  const raw = Number(bpm);
  if (!Number.isFinite(raw) || raw < 30 || raw > 300) return null;
  return (raw / base - 1) * 100;
}

export const DANCE_BARS = 24;                // ความยาวช่วงที่ใช้ "ค้นหา" Dance Section (อัลกอริทึมตรวจจับ — ไม่เปลี่ยน)
export const PREVIEW_START_BAR = 5;          // Preview ทุกเพลงเริ่มที่ห้องที่ 6 (index 5) เสมอ ตามกติกาล่าสุด
export const DANCE_STOP_OFFSET_BARS = 16;    // 🔧 (T135) เล่นต่อเนื่องไปจนจบห้องที่ 16 ของท่อนแดนแรก (Dance Start Bar + 16) แล้วหยุด (เดิม +8)
export const DANCE_SEARCH_RANGE_RATIO = 0.5; // จำกัดขอบเขตค้นหา Dance ไว้แค่ "ครึ่งแรกของเพลง" เพื่อจับท่อนแดนแรกเสมอ

// ---------------- แปลงห้อง <-> วินาที ----------------
// 🆕 (T136): รับ optional bpm parameter — ถ้าไม่ส่ง ใช้ default 150 (BAR_SECONDS = 1.6)
//   ถ้าส่ง bpm เข้ามา จะใช้ barSecondsFor(bpm) แทน BAR_SECONDS คงที่
export function barToSec(bar, bpm) {
  const bs = (bpm != null) ? barSecondsFor(bpm) : BAR_SECONDS;
  return bar * bs;
}
export function secToBar(sec, bpm) {
  const bs = (bpm != null) ? barSecondsFor(bpm) : BAR_SECONDS;
  return sec / bs;
}

// จาก "ห้องเริ่ม Dance" คำนวณช่วง Preview ตามกติกาใหม่:
//   เริ่มที่ห้องที่ 6 (index 5) → หยุดที่จบห้องที่ 16 ของท่อนแดนแรก (danceStartBar + 16)  [T135]
// คลิปตามความยาวเพลงจริงเสมอ (กันค่าเกินความยาวเพลง)
// 🆕 (T136): รับ optional bpm parameter — ใช้คำนวณ BAR_SECONDS ตาม BPM จริงของเพลง
//   ถ้าไม่ส่ง bpm → ใช้ default 150 (BAR_SECONDS = 1.6) — backward compatible
export function computePreviewWindow(danceStartBar, songDurationSec, gridOffsetSec = 0, bpm = null) {
  // 🆕 (T132): gridOffsetSec = เวลาที่ "ห้อง 0" เริ่มจริงในไฟล์ (เพลงที่มีช่วงเงียบ/lead-in ก่อนจังหวะแรก)
  //   ค่าเริ่มต้น 0 → ทำงานเหมือนเดิมทุกประการ
  const off = Number(gridOffsetSec) || 0;
  const rawStartBar = PREVIEW_START_BAR; // = 5 เสมอ ทุกเพลง (ห้องที่ 6)
  // จบห้องที่ 16 ของช่วง Dance (T135: เดิมห้องที่ 8) — กันเคสขอบ (Dance ถูกจับได้เร็วมากจนน้อยกว่าห้องเริ่ม Preview)
  const rawEndBar = Math.max(rawStartBar + 1, danceStartBar + DANCE_STOP_OFFSET_BARS);
  const startSec = off + barToSec(rawStartBar, bpm);
  const endSec = Math.min(
    songDurationSec != null ? songDurationSec : Infinity,
    off + barToSec(rawEndBar, bpm)
  );
  return {
    dance_start_bar: danceStartBar,
    preview_start_bar: rawStartBar,
    preview_end_bar: rawEndBar,
    preview_start_sec: Number(startSec.toFixed(3)),
    preview_end_sec: Number(endSec.toFixed(3))
  };
}

// ---------------- กำหนดห้องเริ่ม/หยุดของ Preview เองแบบอิสระ (ใหม่) ----------------
// ไม่อิงสูตร Dance ด้านบนเลย — แอดมินระบุ "ห้องเริ่มเล่น" และ "ห้องหยุดเล่น" เองได้ตามต้องการ
// ใช้เมื่อกติกาอัตโนมัติ (เริ่มห้อง 1 → หยุดห้อง Dance+8) ไม่ตรงกับที่ต้องการสำหรับเพลงนั้นๆ
// 🆕 (T136): รับ optional bpm parameter — ใช้คำนวณ BAR_SECONDS ตาม BPM จริงของเพลง
export function manualPreviewWindow(startBar, endBar, songDurationSec, bpm = null) {
  const sBar = Math.max(0, Math.floor(Number(startBar) || 0));
  const eBarRaw = Math.floor(Number(endBar) || 0);
  const eBar = Math.max(sBar + 1, eBarRaw); // ห้องหยุดต้องอยู่หลังห้องเริ่มเสมอ อย่างน้อย 1 ห้อง
  const startSec = barToSec(sBar, bpm);
  const endSec = Math.min(
    songDurationSec != null ? songDurationSec : Infinity,
    barToSec(eBar, bpm)
  );
  return {
    status: "ok",
    manual_window: true,       // ใช้แยกแยะฝั่ง UI ว่าเป็นค่าที่กำหนดเอง ไม่ใช่ผลจาก AI
    dance_start_bar: null,     // ไม่ได้อิงตำแหน่ง Dance ที่ตรวจพบ
    confidence: null,
    duration_sec: songDurationSec != null ? Number(songDurationSec.toFixed(3)) : null,
    preview_start_bar: sBar,
    preview_end_bar: eBar,
    preview_start_sec: Number(startSec.toFixed(3)),
    preview_end_sec: Number(endSec.toFixed(3))
  };
}

// ==================== DSP ภายใน (ไม่ export) — ไม่มีการแก้ไขส่วนนี้เลย ====================

const WINDOW_CACHE = {};
function getHannWindow(size) {
  if (!WINDOW_CACHE[size]) {
    const w = new Float32Array(size);
    for (let i = 0; i < size; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
    WINDOW_CACHE[size] = w;
  }
  return WINDOW_CACHE[size];
}

// FFT แบบ radix-2 iterative (in-place) — frameSize ต้องเป็นเลขยกกำลัง 2 เท่านั้น
function fftInPlace(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang), wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0;
      const half = len / 2;
      for (let k = 0; k < half; k++) {
        const aRe = re[i + k], aIm = im[i + k];
        const bRe = re[i + k + half] * curRe - im[i + k + half] * curIm;
        const bIm = re[i + k + half] * curIm + im[i + k + half] * curRe;
        re[i + k] = aRe + bRe; im[i + k] = aIm + bIm;
        re[i + k + half] = aRe - bRe; im[i + k + half] = aIm - bIm;
        const nextRe = curRe * wRe - curIm * wIm;
        const nextIm = curRe * wIm + curIm * wRe;
        curRe = nextRe; curIm = nextIm;
      }
    }
  }
}

function magnitudeSpectrum(frame) {
  const n = frame.length; // ใช้ frameSize = 2048 เสมอ (ยกกำลัง 2)
  const win = getHannWindow(n);
  const re = new Float32Array(n);
  const im = new Float32Array(n);
  for (let i = 0; i < n; i++) re[i] = frame[i] * win[i];
  fftInPlace(re, im);
  const half = n / 2;
  const mag = new Float32Array(half);
  for (let i = 0; i < half; i++) mag[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
  return mag;
}

function mixToMono(audioBuffer) {
  const len = audioBuffer.length;
  const channels = audioBuffer.numberOfChannels;
  if (channels === 1) return audioBuffer.getChannelData(0);
  const mono = new Float32Array(len);
  for (let c = 0; c < channels; c++) {
    const data = audioBuffer.getChannelData(c);
    for (let i = 0; i < len; i++) mono[i] += data[i] / channels;
  }
  return mono;
}

// คำนวณ RMS (พลังงาน) + Spectral Flux ต่อเฟรม ทีละเฟรมตลอดทั้งเพลง
function analyzeFrames(channelData, sampleRate) {
  const frameSize = 2048;
  const hopSize = 1024; // overlap 50%
  const frames = [];
  let prevSpectrum = null;

  for (let start = 0; start + frameSize <= channelData.length; start += hopSize) {
    const frame = channelData.subarray(start, start + frameSize);

    let sumSq = 0;
    for (let i = 0; i < frame.length; i++) sumSq += frame[i] * frame[i];
    const rms = Math.sqrt(sumSq / frame.length);

    const spectrum = magnitudeSpectrum(frame);
    // 🆕 (T132): พลังงานย่านต่ำ (~20-200Hz = กระเดื่อง/เบส) — ตัวบอกว่า "แดนเริ่ม" แม่นกว่าความดังรวม
    const lowBins = Math.max(2, Math.min(spectrum.length - 1, Math.round(200 / (sampleRate / frameSize))));
    let low = 0;
    for (let i = 1; i <= lowBins; i++) low += spectrum[i];
    let lowFlux = 0;
    let flux = 0;
    if (prevSpectrum) {
      for (let i = 1; i <= lowBins; i++) { const d = spectrum[i] - prevSpectrum[i]; if (d > 0) lowFlux += d; }
      // Spectral Flux: รวมเฉพาะพลังงานที่ "เพิ่มขึ้น" จากเฟรมก่อนหน้า (นิยามมาตรฐานสำหรับจับ Onset)
      for (let i = 0; i < spectrum.length; i++) {
        const diff = spectrum[i] - prevSpectrum[i];
        if (diff > 0) flux += diff;
      }
    }
    prevSpectrum = spectrum;
    frames.push({ timeSec: start / sampleRate, rms, flux, low, lowFlux });
  }
  return frames;
}

// รวมเฟรมเป็นค่าเฉลี่ยรายห้อง (บาร์ละ 1.6 วิ) + นับ Onset ต่อห้อง
// 🆕 (T136): รับ optional bpm parameter — ใช้ barSecondsFor(bpm) แทน BAR_SECONDS คงที่
//   ทำให้แต่ละเพลงมีความยาวห้องต่างกันตาม BPM จริง (150 = 1.6s, 165 = 1.4545s, ฯลฯ)
function aggregateIntoBars(frames, songDurationSec, gridOffsetSec = 0, bpm = null) {
  const bs = (bpm != null) ? barSecondsFor(bpm) : BAR_SECONDS;
  const totalBars = Math.max(1, Math.ceil((songDurationSec - gridOffsetSec) / bs));
  const bars = Array.from({ length: totalBars }, () => ({ rmsSum: 0, fluxSum: 0, lowSum: 0, count: 0, onsetCount: 0 }));

  const sortedFlux = frames.map(f => f.flux).slice().sort((a, b) => a - b);
  // ถือว่าเฟรมที่ flux อยู่ใน 25% สูงสุดของทั้งเพลง คือจุด Onset (จังหวะ/กลองเข้า)
  const fluxThreshold = sortedFlux.length ? sortedFlux[Math.floor(sortedFlux.length * 0.75)] : 0;

  frames.forEach(f => {
    const rel = f.timeSec - gridOffsetSec;
    if (rel < 0) return; // ก่อนห้องแรกของ grid
    const barIdx = Math.min(totalBars - 1, Math.floor(rel / bs));
    const bar = bars[barIdx];
    bar.lowSum += f.low || 0;
    bar.rmsSum += f.rms;
    bar.fluxSum += f.flux;
    bar.count += 1;
    if (f.flux >= fluxThreshold) bar.onsetCount += 1;
  });

  return bars.map(b => ({
    avgRms: b.count ? b.rmsSum / b.count : 0,
    avgFlux: b.count ? b.fluxSum / b.count : 0,
    avgLow: b.count ? b.lowSum / b.count : 0,
    onsetCount: b.onsetCount
  }));
}

const LOUD_RUN_MIN_BARS = 12;     // ท่อนแดนต้องต่อเนื่องอย่างน้อยกี่ห้องถึงนับ (แดนจริง 24 ห้อง)
const LOUD_LEVEL_RATIO = 0.8;     // ถือว่า "ดังระดับแดน" เมื่อ ≥ 80% ของระดับดังสุดของเพลง
function median3(arr) {
  return arr.map((_, i) => {
    const a = arr[Math.max(0, i - 1)], b = arr[i], c = arr[Math.min(arr.length - 1, i + 1)];
    return Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
  });
}
function findFirstLoudRun(E, O) {
  const n = E.length;
  if (n < LOUD_RUN_MIN_BARS + 2) return null;
  const sm = median3(E);
  const sorted = sm.slice().sort((x, y) => x - y);
  const loud = sorted[Math.floor(sorted.length * 0.9)];
  if (!(loud > 0.3)) return null;
  const thr = loud * LOUD_LEVEL_RATIO;
  let i = 0, runStart = -1, runEnd = -1;
  while (i < n) {
    if (sm[i] >= thr) {
      let j = i;
      while (j < n && sm[j] >= thr) j++;
      if (j - i >= LOUD_RUN_MIN_BARS) { runStart = i; runEnd = j; break; }
      i = j;
    } else i++;
  }
  if (runStart < 0) return null;
  // จุดเริ่มแดน = ห้องแรกของช่วงที่ดังต่อเนื่อง (ใช้ค่าที่ผ่าน median แล้ว จึงไม่ถูกหลอกด้วยห้องกลองฟิลล์/เสียงเด้งเดี่ยวๆ ก่อนดรอป)
  let start = runStart;
  // median อาจดึงขอบเข้ามา 1 ห้องเมื่อมีห้องเด้งก่อนดรอป → ขยับไปห้องแรกที่ค่าจริง (ก่อนทำเรียบ) ดังระดับแดน 2 ห้องติดกัน
  while (start < runEnd - 2 && !(E[start] >= thr && E[start + 1] >= thr)) start++;
  const len = Math.min(DANCE_BARS, runEnd - start);
  const seg = E.slice(start, start + len);
  const meanEnergy = seg.reduce((a, b) => a + b, 0) / len;
  const meanOnset = O.slice(start, start + len).reduce((a, b) => a + b, 0) / len;
  const stdDev = Math.sqrt(seg.reduce((a, e) => a + (e - meanEnergy) ** 2, 0) / len);
  const passesThreshold = meanEnergy >= 0.4 && meanOnset >= 0.3 && stdDev <= 0.35;
  return {
    danceStartBar: start,
    confidence: Math.min(1, meanEnergy / Math.max(loud, 1e-9)) * 0.6 + Math.min(1, (runEnd - runStart) / DANCE_BARS) * 0.4,
    passesThreshold,
    reason: passesThreshold ? "" : `ท่อนที่เจอไม่ชัดพอ (พลังงาน ${meanEnergy.toFixed(2)}, จังหวะ ${meanOnset.toFixed(2)})`
  };
}

// เลื่อนหาต่อเนื่อง 16 ห้องที่ "พลังงานสูงและสม่ำเสมอตลอดช่วง" — ไม่ใช่แค่ห้องที่ดังที่สุดห้องเดียว
// 🔧 (T132) ปรับปรุงความแม่นยำ (สูตรหลัก RMS/Onset/sustained ยังอยู่ครบ):
//   1) แก้บั๊กขอบเขตค้นหา: เดิมบังคับให้ "ทั้งหน้าต่าง 16 ห้อง" อยู่ในครึ่งแรกของเพลง ทำให้เพลงที่แดนเริ่มช้ากว่า
//      ~ครึ่งหนึ่งของครึ่งแรก (เช่น ห้อง 20+ ในเพลง 70 ห้อง) ถูกตัดทิ้งเลย → ตอนนี้จำกัดแค่ "จุดเริ่ม" ต้องอยู่ในครึ่งแรก
//   2) เพิ่มคะแนน "Drop Contrast": ท่อนแดนจริงต้องดัง/มีกลองกว่าห้องก่อนหน้า (เบรก/ร้อง → ดรอป)
//   3) ใช้พลังงานย่านต่ำ (กลอง/เบส) ร่วมกับความดังรวม
//   4) ถ้าคะแนนสูสี (ต่างกัน <3%) เลือกตำแหน่ง "แรกสุด" (ท่อนแดนแรก) แทนการเลือกกลางๆ ของพื้นที่ราบ
//   5) ขยับจุดเริ่ม ±3 ห้อง ไปที่ "ขอบขาขึ้น" ที่ชันที่สุด (จุดที่ดรอปเข้าจริง)
function findDanceWindow(bars) {
  const n = bars.length;
  if (n < DANCE_BARS) return { danceStartBar: null, confidence: 0, passesThreshold: false, reason: `เพลงสั้นเกินไป (${n} ห้อง < ${DANCE_BARS})` };

  // 🔧 (T135): สแกนทั้งเพลง (เดิมจำกัดจุดเริ่มไว้ครึ่งแรก → เพลงที่แดนแรกอยู่ห้อง ~70 ของเพลง ~130 ห้องหาไม่เจอ)
  //   กันไปเจอแดนท่อนที่ 2 ด้วยกฎ "เลือกท่อนแรกสุดที่คะแนนไม่ต่ำกว่า 90% ของท่อนที่ดีที่สุด" แทน
  const searchEnd = n - DANCE_BARS;

  const maxRms = Math.max(...bars.map(b => b.avgRms), 1e-9);
  const maxLow = Math.max(...bars.map(b => b.avgLow || 0), 1e-9);
  const maxOnset = Math.max(...bars.map(b => b.onsetCount), 1);
  // พลังงานรวมต่อห้อง = ความดังรวม 60% + ย่านกลอง/เบส 40%
  const E = bars.map(b => (b.avgRms / maxRms) * 0.6 + ((b.avgLow || 0) / maxLow) * 0.4);
  const O = bars.map(b => b.onsetCount / maxOnset);

  const mean = (arr, from, to) => { let t = 0, c = 0; for (let i = Math.max(0, from); i < Math.min(arr.length, to); i++) { t += arr[i]; c++; } return c ? t / c : 0; };

  // 🆕 (T136) วิธีหลัก "หาท่อนดังสุดท่อนแรกแบบเป็นช่วง": เพลงชุดนี้มีโครงสร้างคงที่ — ร้อง/บิลด์ (พลังงานกลาง) → แดน 24 ห้อง (พลังงานสูงสุด)
  //   → เบรก → วนซ้ำ จบด้วยแดน 24 ห้องอีกท่อน  (ดูจากไฟล์จริง: แดนแรกกระโดดจาก E~0.6 เป็น ~0.85 ทันที)
  //   วิธี: ทำให้เรียบด้วย median 3 ห้อง (ตัดห้องเด้ง/ห้องเบรกสั้นๆ) → ระดับ "ดังสุด" = เปอร์เซ็นไทล์ 90 → หาช่วงแรกสุดที่ต่อเนื่อง
  //   ≥ 12 ห้องและอยู่ใกล้ระดับดังสุด (≥ 80%) → ห้องแรกของช่วงนั้นคือ Dance Start (ขยับ ±2 ห้องไปที่ขอบขาขึ้นที่ชันสุด)
  //   ถ้าหาไม่เจอ → ใช้การให้คะแนนหน้าต่างแบบเดิมด้านล่างต่อ
  const runResult = findFirstLoudRun(E, O);
  if (runResult) return runResult;

  const cands = [];
  for (let start = 0; start <= searchEnd; start++) {
    const energies = E.slice(start, start + DANCE_BARS);
    const meanEnergy = mean(E, start, start + DANCE_BARS);
    const meanOnset = mean(O, start, start + DANCE_BARS);
    const variance = energies.reduce((a, e) => a + (e - meanEnergy) ** 2, 0) / DANCE_BARS;
    const stdDev = Math.sqrt(variance);
    const sustainedBonus = Math.max(0, 1 - stdDev * 2);
    const prevMean = start >= 2 ? mean(E, start - 8, start) : meanEnergy; // 8 ห้องก่อนหน้า
    const contrast = Math.max(0, Math.min(1, (meanEnergy - prevMean) * 2));
    const score = meanEnergy * 0.35 + meanOnset * 0.30 + sustainedBonus * 0.15 + contrast * 0.20;
    cands.push({ start, score, meanEnergy, meanOnset, stdDev });
  }
  if (!cands.length) return { danceStartBar: null, confidence: 0, passesThreshold: false, reason: "ไม่พบช่วงที่ค้นหาได้" };

  const topScore = Math.max(...cands.map(c => c.score));
  // (4) ถ้าสูสี เลือกตำแหน่งแรกสุด
  let best = cands.find(c => c.score >= topScore * 0.90);

  // (5) ขยับไปที่ขอบขาขึ้นที่ชันที่สุดภายใน ±3 ห้อง (เฉพาะที่คะแนนไม่ตกจากเดิมมาก)
  let bestRise = -Infinity, refined = best;
  for (let d = -3; d <= 3; d++) {
    const c = cands[best.start + d];
    if (!c || c.score < topScore * 0.90) continue;
    const rise = mean(E, c.start, c.start + 2) - mean(E, c.start - 2, c.start);
    if (rise > bestRise + 1e-9) { bestRise = rise; refined = c; }
  }
  if (bestRise > 0.08) best = refined;

  const passesThreshold = best.meanEnergy >= 0.4 && best.meanOnset >= 0.3 && best.stdDev <= 0.35;
  const reasons = [];
  if (best.meanEnergy < 0.4) reasons.push(`พลังงานเฉลี่ยต่ำ (${best.meanEnergy.toFixed(2)} < 0.40)`);
  if (best.meanOnset < 0.3) reasons.push(`จังหวะกลองไม่ชัด (${best.meanOnset.toFixed(2)} < 0.30)`);
  if (best.stdDev > 0.35) reasons.push(`พลังงานไม่สม่ำเสมอ (${best.stdDev.toFixed(2)} > 0.35)`);
  return { danceStartBar: best.start, confidence: best.score, passesThreshold, reason: reasons.join(", ") };
}

// 🆕 (T132): เพดานขนาดไฟล์ที่ใช้วิเคราะห์ แยกตามชนิดไฟล์
//   เดิมตัดที่ 5MB เสมอ → ไฟล์ WAV (ไม่บีบอัด) 5MB = แค่ ~30 วินาทีแรก ทำให้หาแดนที่อยู่หลังจากนั้นไม่เจอเลย
//   🔧 (T137): ขนาดไฟล์แต่ละเพลงไม่เท่ากัน (6MB-20MB+) ห้ามตัดไฟล์กลางเพลง ไม่งั้นผลของแต่ละเพลงเพี้ยนต่างกัน
//   ใหม่: อ่านเพลงให้ครบทั้งเพลง (WAV ≤ 80MB / MP3,M4A ≤ 40MB — เกินกว่านี้คือยาวผิดปกติเกือบ 10 นาทีขึ้นไป)
//   กันแรมเต็มด้วยการลดความถี่ตัวอย่างตอนถอดรหัสแทนการตัดไฟล์ (ดู analyzeArrayBuffer)
function maxAnalyzeBytesFor(nameOrUrl, mimeType) {
  const n = String(nameOrUrl || "").split("?")[0].toLowerCase();
  const isWav = /\.(wav|wave)$/.test(n) || /wav/.test(String(mimeType || "").toLowerCase());
  return isWav ? 80 * 1024 * 1024 : 40 * 1024 * 1024;
}

// ==================== ฟังก์ชันหลักที่ไฟล์อื่นเรียกใช้ ====================

// วิเคราะห์จากไฟล์ที่แอดมินเพิ่งเลือก (File object) — เรียกก่อนอัปโหลดขึ้น Cloudinary ก็ได้ ไม่ต้องรอ
export async function analyzeSongFile(file, onProgress, bpm = null) {
  // 🔒 (Audit Fix H-15 → T137): เดิมตัดไฟล์ที่ 5MB (ได้แค่ต้นเพลง) ตอนนี้อ่านครบทั้งเพลงตามเพดานใน maxAnalyzeBytesFor แล้วลดความถี่ตอน decode แทน
  const MAX_ANALYZE_BYTES = maxAnalyzeBytesFor(file.name, file.type);
  let arrayBuffer;
  if (file.size > MAX_ANALYZE_BYTES) {
    console.warn(`[T137] File ${file.size} bytes เกินเพดาน ${MAX_ANALYZE_BYTES} — วิเคราะห์เฉพาะส่วนต้นของไฟล์`);
    arrayBuffer = await file.slice(0, MAX_ANALYZE_BYTES).arrayBuffer();
  } else {
    arrayBuffer = await file.arrayBuffer();
  }
  return analyzeArrayBuffer(arrayBuffer, onProgress, bpm);
}

// วิเคราะห์จาก URL ที่อัปโหลดไปแล้ว (ใช้ตอนกด "วิเคราะห์ใหม่ทั้งหมด" หรือใน backfill script)
// 🆕 (T136): รับ optional bpm parameter — ใช้ BPM จริงของเพลงในการคำนวณ BAR_SECONDS
export async function analyzeSongUrl(url, onProgress, bpm = null) {
  // 🔧 (T134 2026-10-13): แก้ "Load failed" — เดิม fetch ตรงจาก R2 public URL (pub-xxx.r2.dev) ซึ่งคนละ origin กับหน้าแอดมิน
  //   Safari บล็อกเพราะ bucket ไม่ได้ตั้ง CORS (และ header Range ทำให้เกิด preflight ที่ถูกปฏิเสธ) → fetch ล้มทั้งสองรอบ
  //   ใหม่: ไฟล์คนละ origin → ดึงผ่าน proxy ของระบบเอง /api/file/<key> (same-origin, ใช้ session แอดมิน, ไม่โดน CORS)
  //         ถ้า proxy ใช้ไม่ได้ (เช่น ไฟล์เก่าไม่ได้อยู่ใน R2 bucket นี้) → ลองดึงตรงเหมือนเดิม
  //   อ่านเฉพาะ N ไบต์แรกด้วย stream (กันแรมเต็มบนมือถือ) โดยไม่ต้องพึ่ง Range header
  const MAX_ANALYZE_BYTES = maxAnalyzeBytesFor(url);
  const errors = [];
  const tryFetch = async (target, init) => {
    const res = await fetch(target, init);
    if (!res.ok && res.status !== 206) throw new Error("HTTP " + res.status);
    return readLimited(res, MAX_ANALYZE_BYTES);
  };

  let arrayBuffer = null;
  const proxyUrl = buildSameOriginProxyUrl(url);
  if (proxyUrl) {
    try { arrayBuffer = await tryFetch(proxyUrl, { credentials: "same-origin" }); }
    catch (e) { errors.push("proxy: " + (e?.message || e)); }
  }
  if (!arrayBuffer) {
    try { arrayBuffer = await tryFetch(url); }
    catch (e) { errors.push("direct: " + (e?.message || e)); }
  }
  if (!arrayBuffer) {
    throw new Error("ดึงไฟล์เพลงมาวิเคราะห์ไม่ได้ (" + errors.join(" | ") + ")");
  }
  return analyzeArrayBuffer(arrayBuffer, onProgress, bpm);
}

// อ่าน body ไม่เกิน maxBytes แล้วหยุด (ตัดการดาวน์โหลดที่เหลือทิ้ง)
async function readLimited(res, maxBytes) {
  if (!res.body || !res.body.getReader) {
    const buf = await res.arrayBuffer();
    return buf.byteLength > maxBytes ? buf.slice(0, maxBytes) : buf;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  try { await reader.cancel(); } catch (_) { /* ignore */ }
  const out = new Uint8Array(Math.min(total, maxBytes));
  let off = 0;
  for (const c of chunks) {
    const take = Math.min(c.byteLength, out.length - off);
    if (take <= 0) break;
    out.set(c.subarray(0, take), off);
    off += take;
  }
  return out.buffer;
}

// URL ของไฟล์คนละ origin → แปลงเป็น /api/file/<key> (same-origin) ; ถ้าเป็น origin เดียวกันอยู่แล้วคืน null
export function buildSameOriginProxyUrl(url) {
  try {
    const u = new URL(url, typeof location !== "undefined" ? location.href : undefined);
    if (typeof location !== "undefined" && u.origin === location.origin) return null;
    const key = u.pathname.replace(/^\/+/, "").split("/").map(decodeURIComponent).map(encodeURIComponent).join("/");
    return key ? "/api/file/" + key : null;
  } catch (_) {
    return null;
  }
}

// 🆕 (T133): อ่านไฟล์ WAV (PCM 8/16/24/32-bit, float32) ตรงๆ โดยไม่ผ่าน decodeAudioData
//   เหตุผล: decodeAudioData บน Safari/iPad พังหรือกินแรมมากกับ WAV ใหญ่/ไฟล์ที่ถูกตัดท้าย (Range 24MB)
//   ผล: ผสมเป็น mono + ลดความถี่ตัวอย่างลง 2 เท่า (เหลือ ~22kHz เพียงพอสำหรับวิเคราะห์) → กินแรมน้อยลง ~8 เท่า
//   คืน null ถ้าไม่ใช่ WAV ที่รองรับ → ไปใช้ decodeAudioData ตามเดิม
export function parseWavToMono(arrayBuffer) {
  const dv = new DataView(arrayBuffer);
  if (dv.byteLength < 44) return null;
  const tag = (o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;
  let pos = 12, fmt = null, dataStart = -1, dataLen = 0;
  while (pos + 8 <= dv.byteLength) {
    const id = tag(pos);
    const size = dv.getUint32(pos + 4, true);
    if (id === "fmt ") {
      fmt = { format: dv.getUint16(pos + 8, true), channels: dv.getUint16(pos + 10, true), sampleRate: dv.getUint32(pos + 12, true), bits: dv.getUint16(pos + 22, true) };
      if (fmt.format === 0xFFFE && size >= 26) fmt.format = dv.getUint16(pos + 8 + 24, true); // WAVE_FORMAT_EXTENSIBLE
    } else if (id === "data") {
      dataStart = pos + 8;
      // ไฟล์ที่ถูกตัดท้าย/ขนาดใน header เกินจริง → ใช้เท่าที่มี
      dataLen = Math.min(size === 0 || size === 0xFFFFFFFF ? Infinity : size, dv.byteLength - dataStart);
      break;
    }
    pos += 8 + size + (size % 2);
  }
  if (!fmt || dataStart < 0 || !fmt.channels) return null;
  const isInt = fmt.format === 1, isFloat = fmt.format === 3;
  if (!(isInt && [8, 16, 24, 32].includes(fmt.bits)) && !(isFloat && fmt.bits === 32)) return null;
  const bytesPer = fmt.bits / 8, frameBytes = bytesPer * fmt.channels;
  const totalFrames = Math.floor(dataLen / frameBytes);
  const DECIM = fmt.sampleRate >= 32000 ? 2 : 1;
  const outLen = Math.floor(totalFrames / DECIM);
  const out = new Float32Array(outLen);
  const readSample = (off) => {
    if (isFloat) return dv.getFloat32(off, true);
    if (fmt.bits === 16) return dv.getInt16(off, true) / 32768;
    if (fmt.bits === 8) return (dv.getUint8(off) - 128) / 128;
    if (fmt.bits === 24) { let v = dv.getUint8(off) | (dv.getUint8(off + 1) << 8) | (dv.getUint8(off + 2) << 16); if (v & 0x800000) v |= ~0xFFFFFF; return v / 8388608; }
    return dv.getInt32(off, true) / 2147483648;
  };
  for (let i = 0; i < outLen; i++) {
    let acc = 0;
    for (let d = 0; d < DECIM; d++) {
      const base = dataStart + (i * DECIM + d) * frameBytes;
      for (let c = 0; c < fmt.channels; c++) acc += readSample(base + c * bytesPer);
    }
    out[i] = acc / (DECIM * fmt.channels);
  }
  return { channelData: out, sampleRate: fmt.sampleRate / DECIM, durationSec: totalFrames / fmt.sampleRate };
}

async function analyzeArrayBuffer(arrayBuffer, onProgress, bpm = null) {
  // 🆕 (T133): WAV อ่านตรงๆ ก่อน (เร็ว/กินแรมน้อย/ไม่พังกับไฟล์ถูกตัด) — ถ้าอ่านไม่ได้ค่อยใช้ decodeAudioData
  try {
    const wav = parseWavToMono(arrayBuffer);
    if (wav && wav.durationSec > 1) {
      if (onProgress) onProgress(20);
      return analyzeChannelData(wav.channelData, wav.sampleRate, wav.durationSec, onProgress, bpm);
    }
  } catch (wavErr) {
    console.warn("[T133] อ่าน WAV ตรงๆ ไม่สำเร็จ ใช้ decodeAudioData แทน:", wavErr?.message || wavErr);
  }
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  // 🔧 (T137): ถอดรหัสที่ความถี่ต่ำลงเพื่อประหยัดแรม (เบราว์เซอร์ resample ให้เองตอน decode)
  //   ไฟล์ ≤ 12MB → 22,050Hz | ไฟล์ใหญ่กว่า → 11,025Hz  (ยังพอสำหรับ RMS/กลอง-เบส/จังหวะ — ทดสอบแล้วผลเท่าเดิมทุกขนาดไฟล์)
  //   ถ้าเบราว์เซอร์ไม่รองรับตั้ง sampleRate ใน AudioContext → ใช้ค่าปกติของเครื่อง
  const targetRate = arrayBuffer.byteLength > 12 * 1024 * 1024 ? 11025 : 22050;
  let ctx;
  try { ctx = new AudioCtx({ sampleRate: targetRate }); } catch (_) { ctx = new AudioCtx(); }
  let audioBuffer;
  try {
    // decodeAudioData ใน Safari รุ่นเก่าบางตัวไม่รองรับ Promise-based โดยตรง — ครอบด้วย Promise เผื่อไว้
    audioBuffer = await new Promise((resolve, reject) => {
      const maybePromise = ctx.decodeAudioData(arrayBuffer.slice(0), resolve, reject);
      if (maybePromise && typeof maybePromise.then === "function") maybePromise.then(resolve, reject);
    });
  } finally {
    ctx.close().catch(() => {});
  }

  if (onProgress) onProgress(20);
  const channelData = mixToMono(audioBuffer);
  return analyzeChannelData(channelData, audioBuffer.sampleRate, audioBuffer.duration, onProgress, bpm);
}

// 🆕 (T132): แยกส่วน DSP ออกมาเป็นฟังก์ชันที่ไม่พึ่ง Web Audio — ใช้ทดสอบอัตโนมัติได้
// 🆕 (T136): รับ optional bpm parameter — ใช้ barSecondsFor(bpm) ใน aggregateIntoBars + computePreviewWindow
export function analyzeChannelData(channelData, sampleRate, durationSec, onProgress, bpm = null) {
  if (onProgress) onProgress(45);
  const frames = analyzeFrames(channelData, sampleRate);
  if (onProgress) onProgress(70);
  // หมายเหตุ (T132): เคยทดลองหา beat-grid offset อัตโนมัติ แต่ "จังหวะที่ 1 ของห้อง" แยกจากเสียงอย่างเดียวไม่นิ่งพอ
  //   (เพลงแดนกระเดื่องทุกจังหวะ) จึงไม่เปิดใช้ — ยึด grid เริ่มที่ 0 ตามสเปกระบบเดิม
  // 🆕 (T136): ส่ง bpm เข้า aggregateIntoBars + computePreviewWindow เพื่อใช้ BAR_SECONDS ตาม BPM จริงของเพลง
  const result = findDanceWindow(aggregateIntoBars(frames, durationSec, 0, bpm));
  if (onProgress) onProgress(100);

  if (result.danceStartBar == null || !result.passesThreshold) {
    return {
      status: "needs_review",
      dance_start_bar: result.danceStartBar,
      reason: result.reason || "",
      confidence: Number((result.confidence || 0).toFixed(3)),
      duration_sec: Number(durationSec.toFixed(3))
    };
  }

  return {
    status: "ok",
    confidence: Number(result.confidence.toFixed(3)),
    duration_sec: Number(durationSec.toFixed(3)),
    ...computePreviewWindow(result.danceStartBar, durationSec, 0, bpm)
  };
}

// ---------------- ให้แอดมินแก้ Dance Start Bar เองแล้วกด "Recalculate" ----------------
// ไม่ต้องวิเคราะห์เสียงใหม่ทั้งเพลง แค่คำนวณช่วง Preview ใหม่จากเลขห้องที่แอดมินกรอกเอง — เร็วทันที
// (ใช้สูตรใหม่เหมือนกัน: เริ่มห้อง 1 เสมอ → หยุดห้อง Dance+8)
// 🆕 (T136): รับ optional bpm parameter — ใช้ BAR_SECONDS ตาม BPM จริงของเพลง
export function recalculateFromManualBar(danceStartBar, durationSec, bpm = null) {
  const bar = Math.max(0, Math.floor(Number(danceStartBar) || 0));
  return {
    status: "ok",
    confidence: null, // ค่ามือ ไม่ใช่ผลจาก AI จึงไม่มี confidence score
    duration_sec: durationSec != null ? Number(durationSec.toFixed(3)) : null,
    ...computePreviewWindow(bar, durationSec, 0, bpm)
  };
}
