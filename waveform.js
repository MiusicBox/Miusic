/* waveform.js — กราฟคลื่นเสียงแบบ "Big Bar Counter" สำหรับ iPad
 *
 * 🆕 (Style 4 — Big Bar Counter): ย่อคลื่นเสียงให้เล็กลง ขยายตัวนับห้องด้านล่างให้ใหญ่ขึ้น
 *   เหมาะกับ iPad ที่ต้องการอ่านห้องจากไกล ๆ + มีเลขห้องแบบใหญ่ (ทุก 4 ห้อง + ทุก 8 ห้อง)
 *
 * 🆕 (2 Dance Sections): ตรวจจับ 2 ทอนแดนอัตโนมัติ (24 ห้องต่อทอน) จาก peaks data
 *   - ถ้าไฟล์เดิมส่ง marker/dance มา (1 จุด) → ใช้เป็น D1 และ auto-detect D2
 *   - ถ้าไม่ส่ง → auto-detect ทั้ง D1 และ D2
 *   - แสดงเส้นเหลือง D1, D2 + ป้ายชื่อ
 *
 * ✅ Backward compatible 100% — API เดิมทั้งหมดยังใช้ได้
 *    MiusicWave.draw(canvas, options) รับ options เดิมทั้งหมด + เพิ่ม options ใหม่ (optional)
 *
 * ⚠️ ไม่แก้ไขไฟล์อื่นใดนอกจาก waveform.js นี้ (ตาม Iron Rule #5/#6)
 * ⚠️ ไม่กระทบ zip-format.js / ระบบชำระเงิน / schema / backend
 */
(function (global) {
"use strict";
function cssVar(name, fallback) {
try {
const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
return v || fallback;
} catch (_) { return fallback; }
}
function withAlpha(hex, a) {
const m = /^#([0-9a-f]{6})$/i.exec(hex || "");
if (!m) return hex;
const n = parseInt(m[1], 16);
return "rgba(" + ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," + (n & 255) + "," + a + ")";
}
// ตรวจข้อมูลจากฐานข้อมูล: ต้องเป็น array ตัวเลข 16-1000 ค่า → คืน array 0-100 ; ไม่ผ่าน → null (ไม่แสดงกราฟ)
function sanitize(peaks) {
if (!Array.isArray(peaks) || peaks.length < 16 || peaks.length > 1000) return null;
const out = new Array(peaks.length);
for (let i = 0; i < peaks.length; i++) {
const v = Number(peaks[i]);
out[i] = isFinite(v) ? Math.max(0, Math.min(100, v)) : 0;
}
return out;
}
// ===== ข้อมูลสี 3 ย่านความถี่ (waveform_rgb): array ยาว 3×n = [ต่ำ×n, กลาง×n, สูง×n] ค่า 0-100 · ไม่ตรงรูปแบบ → null =====
function sanitizeBands(bands, n) {
if (!Array.isArray(bands) || !n || bands.length !== n * 3) return null;
const out = [new Array(n), new Array(n), new Array(n)];
for (let k = 0; k < 3; k++) {
for (let i = 0; i < n; i++) {
const v = Number(bands[k * n + i]);
out[k][i] = isFinite(v) ? Math.max(0, Math.min(100, v)) : 0;
}
}
return out;
}
// ===== สไตล์กราฟ (ให้ผู้ใช้เลือก — ยังคงไว้เหมือนเดิม) =====
//   section = สีตามส่วนของเพลง (แบบแถบ phrase บนเครื่อง DJ)
//   rgb     = DJ Pro (แบบ djay Pro / Rekordbox RGB)
//   mono    = สีเดียวแบบเดิม
const SEC = {
intro:  { c0: "#15803d", c1: "#22c55e", tag: "INTRO", dot: "#22c55e", name: "อินโทร" },
normal: { c0: "#3730a3", c1: "#818cf8", tag: "",      dot: "#818cf8", name: "ปกติ" },
dance:  { c0: "#b91c1c", c1: "#f97316", tag: "DANCE", dot: "#f97316", name: "Dance" }
};
const BAND_DOT = { low: "#ef4444", mid: "#22c55e", high: "#3b82f6" };
const STYLES = [["section", "ส่วนเพลง"], ["rgb", "DJ Pro"], ["mono", "สีเดียว"]];
const DANCE_BARS = 24; // ความยาว Dance ที่ระบบวิเคราะห์ใช้ (ห้อง)

// 🆕 (Style 4): ความสูงของตัวนับห้องใหญ่ — เพิ่มจาก 11px (เดิม) เป็น 32px
const BIG_BAR_PAD = 36; // 🆕 (2026-10-17): 32 → 36 ให้เลขห้องใหญ่ขึ้นและไม่ทับกับตัวนับ BAR
// แบ่งเพลงเป็นส่วน: อินโทร · Dance · ปกติ — ใช้สำหรับ style "section" (เดิม ไม่เปลี่ยน)
function computeSections(peaks, dur, danceStartSec, barSec) {
const n = peaks.length, binSec = dur / n;
const sm = peaks.map((v, i) => (peaks[Math.max(0, i - 1)] + v + peaks[Math.min(n - 1, i + 1)]) / 3);
const sorted = sm.slice().sort((a, b) => a - b);
const loud = sorted[Math.floor(n * 0.9)] || 1;
let dS = null, dE = null;
if (danceStartSec != null && isFinite(danceStartSec) && danceStartSec >= 0 && danceStartSec < dur) {
dS = danceStartSec;
dE = Math.min(dur, dS + DANCE_BARS * barSec);
}
let k = 0;
while (k < n && sm[k] < loud * 0.55) k++;
let iE = k * binSec;
const limit = dS != null ? dS : dur * 0.4;
if (iE > limit) iE = limit;
if (iE < 3) iE = 0;
const segs = [];
const add = (type, s, e) => { if (e - s > 0.001) segs.push({ type: type, start: s, end: e }); };
if (iE > 0) add("intro", 0, iE);
if (dS != null) { add("normal", iE, dS); add("dance", dS, dE); add("normal", dE, dur); }
else add("normal", iE, dur);
return segs;
}

// 🆕 (2 Dance Sections): ตรวจจับ 2 ทอนแดนจาก peaks (24 ห้องต่อทอน) — ทำงานบน client ไม่ต้องเปลี่ยน schema
//   คืน { d1: {start, end, bar}, d2: {start, end, bar}, totalBars } — เวลาเป็นวินาที
//   ถ้าหาไม่ได้ → d1/d2 เป็น null
function findTwoDanceSections(peaks, dur, bpm, knownDanceSec) {
const n = peaks.length;
if (!n || !dur) return { d1: null, d2: null, totalBars: 0 };
const barSec = Number(bpm) > 0 ? 240 / Number(bpm) : 1.6;
const totalBars = Math.max(1, Math.floor(dur / barSec));
if (totalBars < DANCE_BARS * 2) return { d1: null, d2: null, totalBars };

// พลังงานรายห้อง (interpolate จาก peaks 160 ค่า)
const binSec = dur / n;
const barEnergy = new Array(totalBars).fill(0);
for (let b = 0; b < totalBars; b++) {
const t0 = b * barSec, t1 = (b + 1) * barSec;
const i0 = Math.max(0, Math.floor(t0 / binSec));
const i1 = Math.min(n - 1, Math.floor(t1 / binSec));
let s = 0, c = 0;
for (let i = i0; i <= i1; i++) { s += peaks[i]; c++; }
barEnergy[b] = c ? s / c : 0;
}
// smooth with median 3
const sm = barEnergy.map((_, i) => {
const a = barEnergy[Math.max(0, i - 1)], b = barEnergy[i], c = barEnergy[Math.min(totalBars - 1, i + 1)];
return Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
});
// score each 24-bar window
const cands = [];
for (let s = 0; s <= totalBars - DANCE_BARS; s++) {
let sum = 0;
for (let i = s; i < s + DANCE_BARS; i++) sum += sm[i];
cands.push({ start: s, end: s + DANCE_BARS, score: sum });
}
cands.sort((a, b) => b.score - a.score);

const chosen = [];
// ถ้ามี knownDanceSec (จาก marker/dance ของระบบเดิม) → ใช้เป็น D1 ก่อน
if (knownDanceSec != null && isFinite(knownDanceSec) && knownDanceSec >= 0 && knownDanceSec < dur) {
const startBar = Math.max(0, Math.min(totalBars - DANCE_BARS, Math.floor(knownDanceSec / barSec)));
chosen.push({ start: startBar, end: startBar + DANCE_BARS, score: 0 });
}
// เลือก D2 (หรือ D1 ถ้ายังไม่มี) — ต้องไม่ทับซ้อนกับที่เลือกแล้ว
for (const c of cands) {
if (chosen.length >= 2) break;
const overlap = chosen.some(x => !(c.end <= x.start || c.start >= x.end));
if (!overlap) chosen.push(c);
}
chosen.sort((a, b) => a.start - b.start);
const mk = (x) => x ? { start: x.start * barSec, end: x.end * barSec, bar: x.start } : null;
return { d1: mk(chosen[0]), d2: mk(chosen[1]), totalBars };
}

function getStyle(storageKey, def) {
try {
const v = global.localStorage.getItem(storageKey);
if (v === "section" || v === "rgb" || v === "mono") return v;
} catch (_) { /* ignore */ }
return def;
}
function legendFill(el, style) {
el.textContent = "";
const items = style === "section"
? [[SEC.intro.dot, SEC.intro.name], [SEC.normal.dot, SEC.normal.name], [SEC.dance.dot, SEC.dance.name]]
: style === "rgb"
? [[BAND_DOT.low, "ต่ำ"], [BAND_DOT.mid, "กลาง"], [BAND_DOT.high, "สูง"]]
: [];
items.forEach(function (it) {
const s = document.createElement("span");
s.style.cssText = "display:inline-flex;align-items:center;gap:4px;margin-left:8px;font-size:11px;opacity:.85;white-space:nowrap;";
const d = document.createElement("i");
d.style.cssText = "width:9px;height:9px;border-radius:50%;display:inline-block;background:" + it[0] + ";";
s.appendChild(d); s.appendChild(document.createTextNode(it[1]));
el.appendChild(s);
});
}
// วางปุ่มเลือกสไตล์ไว้เหนือ canvas (ทำครั้งเดียวต่อ canvas) · คืนสไตล์ปัจจุบัน · จำค่าที่เลือกไว้ในเครื่องนี้ (localStorage)
function mountSwitch(canvas, storageKey, def, onChange) {
if (!canvas || !canvas.parentNode) return def;
if (canvas.__waveSwitch) return getStyle(storageKey, def);
const box = document.createElement("div");
box.className = "wave-style-switch";
box.style.cssText = "display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin:0 0 6px;";
const accent = cssVar("--accent", "#8b5cf6");
const btns = [];
const legend = document.createElement("span");
legend.style.cssText = "margin-left:auto;display:inline-flex;flex-wrap:wrap;";
const paintActive = function () {
const cur = getStyle(storageKey, def);
btns.forEach(function (b) {
const on = b.dataset.waveStyle === cur;
b.style.background = on ? withAlpha(accent, 0.28) : "transparent";
b.style.borderColor = on ? accent : "rgba(255,255,255,.16)";
b.style.color = on ? "#fff" : "inherit";
});
legendFill(legend, cur);
};
STYLES.forEach(function (st) {
const b = document.createElement("button");
b.type = "button"; b.dataset.waveStyle = st[0]; b.textContent = st[1];
b.style.cssText = "font:inherit;font-size:11px;padding:4px 10px;border-radius:999px;border:1px solid rgba(255,255,255,.16);background:transparent;cursor:pointer;line-height:1.3;";
b.addEventListener("click", function () {
try { global.localStorage.setItem(storageKey, st[0]); } catch (_) { /* ignore */ }
document.querySelectorAll(".wave-style-switch").forEach(function (el) { if (el.__paintActive) el.__paintActive(); });
if (onChange) onChange(st[0]);
});
btns.push(b); box.appendChild(b);
});
box.appendChild(legend);
box.__paintActive = paintActive;
canvas.parentNode.insertBefore(box, canvas);
canvas.__waveSwitch = box;
paintActive();
return getStyle(storageKey, def);
}
// สีแท่งแบบ djay Pro: ผสม R=ต่ำ G=กลาง B=สูง แล้ว "ดันความอิ่มตัว" (ลากแต่ละช่องออกจากค่าเฉลี่ย) ไม่ให้ออกมาซีดเป็นสีขาว
function djColor(lo, mi, hi, v) {
const m = (lo + mi + hi) / 3, S = 1.6;
const cl = function (x) { return Math.max(0, Math.min(0.92, x)); };
const k = 0.4 + 0.55 * v;
return [
Math.round(20 + 235 * cl(m + (lo - m) * S) * k),
Math.round(20 + 235 * cl(m + (mi - m) * S) * k),
Math.round(20 + 235 * cl(m + (hi - m) * S) * k)
];
}
// วินาทีที่ตรงกับตำแหน่งนิ้ว/เมาส์บน canvas
function timeAt(canvas, clientX, duration) {
const r = canvas.getBoundingClientRect();
if (!r.width || !(duration > 0)) return 0;
return Math.max(0, Math.min(duration, ((clientX - r.left) / r.width) * duration));
}
/* o = {
*   peaks: number[], duration: วินาทีทั้งเพลง,
*   region: {start,end}|null   ช่วงที่ไฮไลต์ (ช่วง Preview)
*   time: number|null          ตำแหน่งเล่นปัจจุบัน (วินาที) → เส้น playhead
*   tint: bool                 พื้นหลังอ่อนในช่วง region
*   bpm, grid, gridLabels      เส้นห้อง (ทุก 8 ห้อง) + ตัวเลขห้อง
*   marker: {time,label}|null  เส้นประสีเหลือง (จุดเริ่ม Dance D1 — จากระบบเดิม)
*   dance: {time}|null         จุดเริ่ม Dance สำหรับสไตล์ "ส่วนเพลง"
*   style: "section"|"rgb"|"mono"   สไตล์กราฟ (ไม่ส่ง = rgb ถ้ามีข้อมูลสี ไม่งั้น mono)
*   bands: number[3n]|null     ข้อมูลสี 3 ย่านความถี่ (waveform_rgb)
*   outside: สีแท่งนอกช่วง (สไตล์สีเดียว)
*
* 🆕 (Style 4): bigBar = true|false (default true) → ใช้ตัวนับห้องใหญ่ (32px แทน 11px)
* 🆕 (2 Dance): ระบบจะตรวจจับ D1/D2 อัตโนมัติ — ถ้าส่ง marker มา ใช้เป็น D1, auto-detect D2
*                       ถ้าไม่ส่ง marker เลย → auto-detect ทั้งคู่
*                       ตั้ง o.twoDance = false เพื่อปิดการแสดง D2 (ใช้แค่ D1 แบบเดิม)
* }
*/
function draw(canvas, o) {
if (!canvas || !o) return false;
const peaks = sanitize(o.peaks);
if (!peaks) return false;
const w = canvas.clientWidth, h = canvas.clientHeight;
if (!w || !h) return false; // ยังซ่อนอยู่ — วาดทีหลัง
const dpr = Math.min(global.devicePixelRatio || 1, 3);
const pw = Math.round(w * dpr), ph = Math.round(h * dpr);
if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
const g = canvas.getContext("2d");
g.setTransform(dpr, 0, 0, dpr, 0, 0);
g.clearRect(0, 0, w, h);
const dur = Number(o.duration) > 0 ? Number(o.duration) : 0;
const accent = cssVar("--accent", "#8b5cf6");
const accent2 = cssVar("--accent-2", "#ec4899");
const region = o.region && dur && o.region.end > o.region.start ? o.region : null;
const time = o.time != null && dur ? Number(o.time) : null;
const n = peaks.length, bw = w / n, gap = bw > 3 ? 1.5 : 0.6;
const bands = sanitizeBands(o.bands, n);
let style = o.style === "section" || o.style === "rgb" || o.style === "mono" ? o.style : (bands ? "rgb" : "mono");
if (style === "rgb" && !bands) style = "mono";
const barSec = Number(o.bpm) > 0 ? 240 / Number(o.bpm) : 1.6;

// 🆕 (Style 4): ตรวจจับ 2 ทอนแดนอัตโนมัติ — ใช้ค่า knownDance จาก marker/dance เดิมเป็น D1 ถ้ามี
const knownDanceSec = (o.marker && o.marker.time != null) ? Number(o.marker.time)
: (o.dance && o.dance.time != null ? Number(o.dance.time) : null);
const twoDanceEnabled = o.twoDance !== false; // default true
const twoDance = (twoDanceEnabled && dur) ? findTwoDanceSections(peaks, dur, o.bpm, knownDanceSec) : null;
const d1 = twoDance ? twoDance.d1 : null;
const d2 = twoDance ? twoDance.d2 : null;
const totalBars = twoDance ? twoDance.totalBars : Math.floor(dur / barSec);

// 🆕 (Style 4): ใช้ knownDanceSec สำหรับ computeSections (style "section") เหมือนเดิม
const danceT = o.dance && o.dance.time != null ? Number(o.dance.time)
: (o.marker && o.marker.time != null ? Number(o.marker.time) : null);
const segs = style === "section" && dur ? computeSections(peaks, dur, danceT, barSec) : null;

// 🆕 (Style 4): ใช้ bigBarPad ขนาดใหญ่ขึ้น (32px แทน 11px) เมื่อ grid/bpm มีอยู่
const useBigBar = o.bigBar !== false && o.grid && o.bpm && dur;
const gridPad = useBigBar ? BIG_BAR_PAD : ((o.grid && o.bpm && dur) ? 11 : 0);
const top0 = segs ? 14 : 0;
const halfH = Math.max(4, (h - top0 - gridPad) / 2), cy = top0 + halfH;
if (region && o.tint && style !== "rgb") {
g.fillStyle = withAlpha(accent, 0.14);
g.fillRect((region.start / dur) * w, 0, ((region.end - region.start) / dur) * w, h);
}
// ----- DJ Pro: วาดกราฟทั้งเส้นลง canvas สำรองครั้งเดียว (แคช) -----
if (style === "rgb") {
const paintDj = function (ctx) {
const cols = Math.max(24, Math.min(Math.floor(w / 1.5), 420));
const cw = w / cols;
for (let c = 0; c < cols; c++) {
const u = ((c + 0.5) / cols) * n - 0.5;
const i0 = Math.max(0, Math.min(n - 1, Math.floor(u))), i1 = Math.min(n - 1, i0 + 1);
const f = Math.max(0, Math.min(1, u - i0));
const lp = function (arr) { return arr[i0] + (arr[i1] - arr[i0]) * f; };
const v = lp(peaks) / 100;
const col = djColor(lp(bands[0]) / 100, lp(bands[1]) / 100, lp(bands[2]) / 100, v);
const amp = Math.max(1.2, v * halfH * 0.94), amp2 = amp * 0.6;
const x = c * cw, bwid = cw + 0.6;
ctx.fillStyle = "rgb(" + Math.round(col[0] * 0.55) + "," + Math.round(col[1] * 0.55) + "," + Math.round(col[2] * 0.55) + ")";
ctx.fillRect(x, cy - amp, bwid, amp * 2);
ctx.fillStyle = "rgb(" + Math.min(255, col[0] + 28) + "," + Math.min(255, col[1] + 28) + "," + Math.min(255, col[2] + 28) + ")";
ctx.fillRect(x, cy - amp2, bwid, amp2 * 2);
}
if (region) {
ctx.fillStyle = "rgba(10,12,24,.66)";
const rx0 = Math.max(0, (region.start / dur) * w), rx1 = Math.min(w, (region.end / dur) * w);
if (rx0 > 0) ctx.fillRect(0, 0, rx0, h);
if (rx1 < w) ctx.fillRect(rx1, 0, w - rx1, h);
}
};
const sig = w + "|" + h + "|" + dpr + "|" + (region ? region.start + "," + region.end : "-") + "|" + gridPad;
let layer = canvas.__djLayer;
if (!layer || layer.sig !== sig || layer.pr !== o.peaks || layer.br !== o.bands) {
let off = null, og = null;
try { off = document.createElement("canvas"); off.width = pw; off.height = ph; og = off.getContext("2d"); } catch (_) { og = null; }
if (og) { og.setTransform(dpr, 0, 0, dpr, 0, 0); paintDj(og); layer = { sig: sig, pr: o.peaks, br: o.bands, cv: off }; canvas.__djLayer = layer; }
else { layer = null; canvas.__djLayer = null; }
}
if (layer) g.drawImage(layer.cv, 0, 0, w, h); else paintDj(g);
if (time != null && dur) {
g.fillStyle = "rgba(6,8,18,.38)";
g.fillRect(0, 0, Math.max(0, Math.min(w, (time / dur) * w)), h);
}
}
let grads = null;
const segOf = function (t) {
if (segs) for (let s = 0; s < segs.length; s++) if (t >= segs[s].start && t < segs[s].end) return segs[s].type;
return "normal";
};
if (segs) {
grads = {};
["intro", "normal", "dance"].forEach(function (k) {
const gr = g.createLinearGradient(0, cy - halfH, 0, cy + halfH);
gr.addColorStop(0, SEC[k].c0); gr.addColorStop(0.5, SEC[k].c1); gr.addColorStop(1, SEC[k].c0);
grads[k] = gr;
});
}
for (let i = 0; style !== "rgb" && i < n; i++) {
const t = dur ? ((i + 0.5) / n) * dur : 0;
const inR = !region || (t >= region.start && t <= region.end);
const v = peaks[i] / 100;
const x = i * bw + gap / 2, bwid = Math.max(1, bw - gap);
if (style === "mono") {
const amp = Math.max(1.5, v * h * 0.44);
g.fillStyle = !inR ? (o.outside || "rgba(148,163,184,.25)")
: (time != null && t <= time ? accent2 : accent);
g.fillRect(x, h / 2 - amp, bwid, amp * 2);
continue;
}
const al = !inR ? 0.4 : (time != null && t > time ? 0.66 : 1);
const amp = Math.max(1.5, v * halfH * 0.94);
g.globalAlpha = al;
if (style === "section") {
g.fillStyle = grads[segOf(t)];
g.fillRect(x, cy - amp, bwid, amp * 2);
const core = amp * (bands ? 0.3 + 0.5 * bands[0][i] / 100 : 0.5);
g.fillStyle = "rgba(255,255,255,.2)";
g.fillRect(x, cy - core, bwid, core * 2);
}
g.globalAlpha = 1;
}
if (segs) {
g.save();
segs.forEach(function (s) {
const x0 = (s.start / dur) * w, bwid = ((s.end - s.start) / dur) * w;
if (bwid <= 0) return;
g.fillStyle = SEC[s.type].c0;
g.fillRect(x0 + 0.5, 1, Math.max(1, bwid - 1), 10);
if (SEC[s.type].tag && bwid > 40) {
g.fillStyle = "#fff"; g.font = "bold 8px sans-serif";
g.fillText(SEC[s.type].tag, x0 + 4, 9);
}
});
g.restore();
}

// 🆕 (Style 4): Big Bar Counter — ตัวนับห้องใหญ่ที่ด้านล่างของ canvas
if (useBigBar) {
const stripTop = h - gridPad;
const stripH = gridPad;
// พื้นหลัง strip
g.fillStyle = "rgba(5,7,16,.85)";
g.fillRect(0, stripTop, w, stripH);
// ไฮไลต์ทอนแดน 2 ทอน (สีแดงโปร่งแสง — เหมือน D1/D2 marker)
if (d1) {
g.fillStyle = "rgba(239,68,68,.16)";
g.fillRect((d1.start / dur) * w, stripTop, ((d1.end - d1.start) / dur) * w, stripH);
}
if (d2) {
g.fillStyle = "rgba(239,68,68,.16)";
g.fillRect((d2.start / dur) * w, stripTop, ((d2.end - d2.start) / dur) * w, stripH);
}
// เส้นห้อง + ตัวเลขห้อง — ใหญ่ขึ้นสำหรับ iPad
const pxPerBar = w / totalBars;
// 🆕 (2026-10-17): เลือกระยะเลขหลักอัตโนมัติ (8/16/32 ห้อง) ให้เลขไม่ซ้อนกันในเพลงยาว/จอแคบ
let majorStep = 8;
while (majorStep < 64 && pxPerBar * majorStep < 32) majorStep *= 2;
const showMinor = majorStep === 8 && pxPerBar * 4 >= 22; // เลขรอง (ทุก 4 ห้อง) แสดงเมื่อมีที่พอ
const labelY = stripTop + stripH - 7;
for (let b = 0; b <= totalBars; b++) {
const x = Math.round(b * pxPerBar) + 0.5;
if (b % majorStep === 0) {
// เส้นเข้ม + เลขใหญ่ สว่างชัด
g.strokeStyle = "rgba(255,255,255,.45)";
g.lineWidth = 1;
g.beginPath(); g.moveTo(x, stripTop); g.lineTo(x, stripTop + stripH); g.stroke();
g.fillStyle = "#ffffff";
g.font = "bold 15px sans-serif";
g.fillText(String(b), x + 3, labelY);
} else if (b % 4 === 0) {
// เส้นกลาง + เลขกลาง (แสดงเลขเมื่อมีที่พอ)
g.strokeStyle = "rgba(255,255,255,.2)";
g.lineWidth = 1;
g.beginPath(); g.moveTo(x, stripTop + (showMinor ? 0 : stripH * 0.5)); g.lineTo(x, stripTop + stripH); g.stroke();
if (showMinor) {
g.fillStyle = "#a5b4c8";
g.font = "bold 12px sans-serif";
g.fillText(String(b), x + 2, labelY);
}
} else if (pxPerBar >= 4) {
// เส้นบางด้านล่าง
g.strokeStyle = "rgba(255,255,255,.08)";
g.lineWidth = 1;
g.beginPath(); g.moveTo(x, stripTop + stripH - 6); g.lineTo(x, stripTop + stripH); g.stroke();
}
}
} else if (o.grid && o.bpm && dur) {
// 🆕 (Style 4): ถ้า bigBar=false → ใช้ grid แบบเดิม 11px (backward compatible)
const bs = 240 / o.bpm;
g.strokeStyle = "rgba(255,255,255,.16)"; g.fillStyle = "rgba(255,255,255,.6)";
g.font = "10px sans-serif"; g.lineWidth = 1;
for (let b = 0; b * bs < dur; b += 8) {
const x = Math.round(((b * bs) / dur) * w) + 0.5;
g.beginPath(); g.moveTo(x, h - 11); g.lineTo(x, h); g.stroke();
if (o.gridLabels) g.fillText(String(b), x + 3, h - 2);
}
}

// 🆕 (2 Dance): เส้นแดง D1, D2 + ป้ายชื่อ (สีแดงเหมือนกันทั้งคู่ — เหมือนจุดเริ่มเล่นใน djay Pro)
const drawDanceMarker = function (t, label) {
if (t == null || !dur || t < 0 || t > dur) return;
const x = Math.round((t / dur) * w) + 0.5;
g.save();
g.strokeStyle = "#ef4444"; g.lineWidth = 2; g.setLineDash([4, 3]);
g.beginPath(); g.moveTo(x, segs ? 11 : 0); g.lineTo(x, h); g.stroke();
g.restore();
// ป้ายชื่อ D1/D2 ด้านบน (สีแดง + ขอบขาว ให้อ่านง่ายบนพื้นเข้ม)
g.fillStyle = "#ef4444";
g.font = "bold 10px sans-serif";
g.fillText(label, Math.min(w - 24, x + 4), segs ? 22 : 12);
// ลูกศรด้านล่าง strip (ถ้ามี big bar)
if (useBigBar) {
const stripTop = h - gridPad;
g.fillStyle = "#ef4444";
g.beginPath();
g.moveTo(x, stripTop); g.lineTo(x - 4, stripTop + 6); g.lineTo(x + 4, stripTop + 6); g.closePath();
g.fill();
}
};

// 🆕 (2 Dance): วาด D1, D2 — ถ้ามี twoDance ใช้ค่าจาก detection; ไม่งั้น fallback ใช้ marker เดิม
if (twoDanceEnabled && (d1 || d2)) {
if (d1) drawDanceMarker(d1.start, "D1");
if (d2) drawDanceMarker(d2.start, "D2");
} else if (o.marker && dur && o.marker.time >= 0 && o.marker.time <= dur) {
// Fallback: แสดง marker เดียวแบบเดิม (ถ้า twoDance ถูกปิด) — สีแดงเหมือน D1/D2
const x = Math.round((o.marker.time / dur) * w) + 0.5;
g.save(); g.strokeStyle = "#ef4444"; g.fillStyle = "#ef4444"; g.lineWidth = 2; g.setLineDash([4, 3]);
g.beginPath(); g.moveTo(x, segs ? 11 : 0); g.lineTo(x, h); g.stroke(); g.restore();
if (o.marker.label && !segs) { g.font = "bold 10px sans-serif"; g.fillText(o.marker.label, Math.min(w - 40, x + 4), 11); }
}

// 🆕 (Style 4): ตัวนับห้องปัจจุบัน (BAR X/Y) — มุมขวาบนของ strip
if (useBigBar && time != null) {
const stripTop = h - gridPad;
const curBar = Math.min(totalBars, Math.floor(time / barSec) + 1);
g.fillStyle = "#fff";
g.font = "bold 12px sans-serif";
g.textAlign = "right";
g.fillText("BAR " + curBar + "/" + totalBars, w - 4, stripTop + 13);
g.textAlign = "left";
}

if (time != null) { // playhead (red — เหมือน djay Pro)
const x = Math.max(1, Math.min(w - 1, (time / dur) * w));
g.fillStyle = style === "rgb" ? "#ef4444" : "#fff"; g.fillRect(x - 1, 0, 2, h);
}
return true;
}
global.MiusicWave = {
draw: draw,
timeAt: timeAt,
sanitize: sanitize,
sanitizeBands: sanitizeBands,
computeSections: computeSections,
mountSwitch: mountSwitch,
getStyle: getStyle,
// 🆕 (2 Dance): export ฟังก์ชันใหม่ให้เรียกใช้ได้ (optional — ไม่บังคับ)
findTwoDanceSections: findTwoDanceSections
};
})(window);
