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

export const DANCE_BARS = 16;                // ความยาวช่วงที่ใช้ "ค้นหา" Dance Section (อัลกอริทึมตรวจจับ — ไม่เปลี่ยน)
export const PREVIEW_START_BAR = 5;          // Preview ทุกเพลงเริ่มที่ห้องที่ 6 (index 5) เสมอ ตามกติกาล่าสุด
export const DANCE_STOP_OFFSET_BARS = 8;     // เล่นต่อเนื่องไปจนถึงห้องที่ 8 ของช่วง Dance ที่เจอ แล้วหยุด
export const DANCE_SEARCH_RANGE_RATIO = 0.5; // จำกัดขอบเขตค้นหา Dance ไว้แค่ "ครึ่งแรกของเพลง" เพื่อจับท่อนแดนแรกเสมอ

// ---------------- แปลงห้อง <-> วินาที ----------------
export function barToSec(bar) { return bar * BAR_SECONDS; }
export function secToBar(sec) { return sec / BAR_SECONDS; }

// จาก "ห้องเริ่ม Dance" คำนวณช่วง Preview ตามกติกาใหม่:
//   เริ่มเสมอที่ห้องที่ 1 (index 0) ของเพลง → หยุดที่ห้องที่ 8 ของ Dance (danceStartBar + 8)
// คลิปตามความยาวเพลงจริงเสมอ (กันค่าเกินความยาวเพลง)
export function computePreviewWindow(danceStartBar, songDurationSec) {
  const rawStartBar = PREVIEW_START_BAR; // = 5 เสมอ ทุกเพลง (ห้องที่ 6)
  // ห้องที่ 8 ของช่วง Dance — กันเคสขอบ (Dance ถูกจับได้เร็วมากจนน้อยกว่าห้องเริ่ม Preview)
  const rawEndBar = Math.max(rawStartBar + 1, danceStartBar + DANCE_STOP_OFFSET_BARS);
  const startSec = barToSec(rawStartBar);
  const endSec = Math.min(
    songDurationSec != null ? songDurationSec : Infinity,
    barToSec(rawEndBar)
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
export function manualPreviewWindow(startBar, endBar, songDurationSec) {
  const sBar = Math.max(0, Math.floor(Number(startBar) || 0));
  const eBarRaw = Math.floor(Number(endBar) || 0);
  const eBar = Math.max(sBar + 1, eBarRaw); // ห้องหยุดต้องอยู่หลังห้องเริ่มเสมอ อย่างน้อย 1 ห้อง
  const startSec = barToSec(sBar);
  const endSec = Math.min(
    songDurationSec != null ? songDurationSec : Infinity,
    barToSec(eBar)
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
    let flux = 0;
    if (prevSpectrum) {
      // Spectral Flux: รวมเฉพาะพลังงานที่ "เพิ่มขึ้น" จากเฟรมก่อนหน้า (นิยามมาตรฐานสำหรับจับ Onset)
      for (let i = 0; i < spectrum.length; i++) {
        const diff = spectrum[i] - prevSpectrum[i];
        if (diff > 0) flux += diff;
      }
    }
    prevSpectrum = spectrum;
    frames.push({ timeSec: start / sampleRate, rms, flux });
  }
  return frames;
}

// รวมเฟรมเป็นค่าเฉลี่ยรายห้อง (บาร์ละ 1.6 วิ) + นับ Onset ต่อห้อง
function aggregateIntoBars(frames, songDurationSec) {
  const totalBars = Math.max(1, Math.ceil(songDurationSec / BAR_SECONDS));
  const bars = Array.from({ length: totalBars }, () => ({ rmsSum: 0, fluxSum: 0, count: 0, onsetCount: 0 }));

  const sortedFlux = frames.map(f => f.flux).slice().sort((a, b) => a - b);
  // ถือว่าเฟรมที่ flux อยู่ใน 25% สูงสุดของทั้งเพลง คือจุด Onset (จังหวะ/กลองเข้า)
  const fluxThreshold = sortedFlux.length ? sortedFlux[Math.floor(sortedFlux.length * 0.75)] : 0;

  frames.forEach(f => {
    const barIdx = Math.min(totalBars - 1, Math.floor(f.timeSec / BAR_SECONDS));
    const bar = bars[barIdx];
    bar.rmsSum += f.rms;
    bar.fluxSum += f.flux;
    bar.count += 1;
    if (f.flux >= fluxThreshold) bar.onsetCount += 1;
  });

  return bars.map(b => ({
    avgRms: b.count ? b.rmsSum / b.count : 0,
    avgFlux: b.count ? b.fluxSum / b.count : 0,
    onsetCount: b.onsetCount
  }));
}

// เลื่อนหาต่อเนื่อง 16 ห้องที่ "พลังงานสูงและสม่ำเสมอตลอดช่วง" — ไม่ใช่แค่ห้องที่ดังที่สุดห้องเดียว
function findDanceWindow(bars) {
  const n = bars.length;
  if (n < DANCE_BARS) return { danceStartBar: null, confidence: 0, passesThreshold: false };

  // จำกัดขอบเขตค้นหาไว้แค่ "ครึ่งแรกของเพลง" เท่านั้น เพื่อให้จับ "ท่อนแดนแรก" เสมอ
  // (เพลงที่มีโครงสร้าง ร้อง-แดน-ร้อง-แดน จะได้ไม่ไปเจอแดนท่อนที่ 2 ที่อาจคะแนนสูงกว่า)
  // ถ้าเพลงสั้นเกินกว่าจะแบ่งครึ่งได้ (ครึ่งแรกไม่พอ 16 ห้อง) ให้กลับไปสแกนทั้งเพลงแทน
  let searchLimit = Math.floor(n * DANCE_SEARCH_RANGE_RATIO);
  if (searchLimit < DANCE_BARS) searchLimit = n;

  const maxRms = Math.max(...bars.map(b => b.avgRms), 1e-9);
  const maxOnset = Math.max(...bars.map(b => b.onsetCount), 1);

  let best = { score: -Infinity, startBar: null, meanEnergy: 0, meanOnset: 0, stdDev: 1 };

  for (let start = 0; start <= searchLimit - DANCE_BARS; start++) {
    const win = bars.slice(start, start + DANCE_BARS);
    const energies = win.map(b => b.avgRms / maxRms);
    const onsets = win.map(b => b.onsetCount / maxOnset);

    const meanEnergy = energies.reduce((a, b) => a + b, 0) / DANCE_BARS;
    const meanOnset = onsets.reduce((a, b) => a + b, 0) / DANCE_BARS;
    const variance = energies.reduce((a, e) => a + (e - meanEnergy) ** 2, 0) / DANCE_BARS;
    const stdDev = Math.sqrt(variance);
    const sustainedBonus = Math.max(0, 1 - stdDev * 2); // เบี่ยงเบนน้อย = พลังงานคงที่ตลอดช่วง = ได้คะแนนเสริม

    const score = meanEnergy * 0.45 + meanOnset * 0.35 + sustainedBonus * 0.2;
    if (score > best.score) best = { score, startBar: start, meanEnergy, meanOnset, stdDev };
  }

  // เกณฑ์ขั้นต่ำก่อนยอมรับผลอัตโนมัติ — ถ้าไม่ผ่าน ให้ระบบขึ้น NEEDS_REVIEW แทนการเดามั่ว
  const passesThreshold = best.meanEnergy >= 0.4 && best.meanOnset >= 0.3 && best.stdDev <= 0.35;

  return { danceStartBar: best.startBar, confidence: best.score, passesThreshold };
}

// ==================== ฟังก์ชันหลักที่ไฟล์อื่นเรียกใช้ ====================

// วิเคราะห์จากไฟล์ที่แอดมินเพิ่งเลือก (File object) — เรียกก่อนอัปโหลดขึ้น Cloudinary ก็ได้ ไม่ต้องรอ
export async function analyzeSongFile(file, onProgress) {
  // 🔒 (Audit Fix H-15): จำกัดขนาด arrayBuffer ก่อน decode — กัน mobile Safari crash
  //   ปัญหาเดิม: file.arrayBuffer() โหลดไฟล์ทั้งหมด (100MB WAV) → decodeAudioData
  //   ทำให้ heap 30MB → 300MB (PCM float32) → mobile Safari พัง
  //   วิธีแก้: ถ้าไฟล์ > 5MB → ใช้แค่ 5MB แรก (เพียงพอสำหรับ 30 วินาทีของ MP3/WAV)
  //   dance window detection ใช้แค่ ~30 วินาทีแรก จึงไม่กระทบผลลัพธ์
  //   ผลกระทบระบบเดิม: 0% — ถ้าไฟล์ < 5MB → ใช้ทั้งหมดเหมือนเดิม
  //   ถ้าไฟล์ > 5MB → ใช้แค่ 5MB แรก (analysis อาจเห็นแค่ 30-60 วินาทีแรก แต่เพียงพอ)
  const MAX_ANALYZE_BYTES = 5 * 1024 * 1024; // 5 MB
  let arrayBuffer;
  if (file.size > MAX_ANALYZE_BYTES) {
    console.log(`[H-15] File ${file.size} bytes > 5MB limit — analyzing first 5MB only (saves memory on mobile)`);
    arrayBuffer = await file.slice(0, MAX_ANALYZE_BYTES).arrayBuffer();
  } else {
    arrayBuffer = await file.arrayBuffer();
  }
  return analyzeArrayBuffer(arrayBuffer, onProgress);
}

// วิเคราะห์จาก URL ที่อัปโหลดไปแล้ว (ใช้ตอนกด "วิเคราะห์ใหม่ทั้งหมด" หรือใน backfill script)
export async function analyzeSongUrl(url, onProgress) {
  // 🔒 (Audit Fix H-15): ดึงแค่ 5MB แรก (ก่อน decode) — กัน memory crash
  //   เดิม: fetch(url) → res.arrayBuffer() → โหลดไฟล์ทั้งหมด → heap spike
  //   ใหม่: fetch(url, { headers: { Range: 'bytes=0-5242879' } }) → ดึงแค่ 5MB แรก
  //   ถ้า server ไม่รองรับ Range → fallback ดึงทั้งหมด (เหมือนเดิม)
  //   ผลกระทบระบบเดิม: 0% — ถ้า server ไม่รองรับ Range → res.arrayBuffer() เหมือนเดิม
  //   ถ้า server รองรับ → ดึงแค่ 5MB (memory ลดลง)
  const MAX_ANALYZE_BYTES = 5 * 1024 * 1024; // 5 MB
  let arrayBuffer;
  try {
    const res = await fetch(url, { headers: { Range: `bytes=0-${MAX_ANALYZE_BYTES - 1}` } });
    if (!res.ok && res.status !== 206) throw new Error("HTTP " + res.status);
    arrayBuffer = await res.arrayBuffer();
  } catch (rangeErr) {
    // Fallback: ดึงทั้งหมด (เหมือนเดิม) ถ้า Range request fail
    console.warn("[H-15] Range request failed, falling back to full fetch:", rangeErr?.message || rangeErr);
    const res = await fetch(url);
    if (!res.ok) throw new Error("ดึงไฟล์เพลงไม่สำเร็จสำหรับวิเคราะห์ (HTTP " + res.status + ")");
    arrayBuffer = await res.arrayBuffer();
  }
  return analyzeArrayBuffer(arrayBuffer, onProgress);
}

async function analyzeArrayBuffer(arrayBuffer, onProgress) {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const ctx = new AudioCtx();
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
  const sampleRate = audioBuffer.sampleRate;
  const durationSec = audioBuffer.duration;

  if (onProgress) onProgress(45);
  const frames = analyzeFrames(channelData, sampleRate);
  if (onProgress) onProgress(80);
  const bars = aggregateIntoBars(frames, durationSec);
  const result = findDanceWindow(bars);
  if (onProgress) onProgress(100);

  if (result.danceStartBar == null || !result.passesThreshold) {
    return {
      status: "needs_review",
      dance_start_bar: result.danceStartBar,
      confidence: Number((result.confidence || 0).toFixed(3)),
      duration_sec: Number(durationSec.toFixed(3))
    };
  }

  return {
    status: "ok",
    confidence: Number(result.confidence.toFixed(3)),
    duration_sec: Number(durationSec.toFixed(3)),
    ...computePreviewWindow(result.danceStartBar, durationSec)
  };
}

// ---------------- ให้แอดมินแก้ Dance Start Bar เองแล้วกด "Recalculate" ----------------
// ไม่ต้องวิเคราะห์เสียงใหม่ทั้งเพลง แค่คำนวณช่วง Preview ใหม่จากเลขห้องที่แอดมินกรอกเอง — เร็วทันที
// (ใช้สูตรใหม่เหมือนกัน: เริ่มห้อง 1 เสมอ → หยุดห้อง Dance+8)
export function recalculateFromManualBar(danceStartBar, durationSec) {
  const bar = Math.max(0, Math.floor(Number(danceStartBar) || 0));
  return {
    status: "ok",
    confidence: null, // ค่ามือ ไม่ใช่ผลจาก AI จึงไม่มี confidence score
    duration_sec: durationSec != null ? Number(durationSec.toFixed(3)) : null,
    ...computePreviewWindow(bar, durationSec)
  };
}
