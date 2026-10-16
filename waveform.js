/* waveform.js — กราฟคลื่นเสียงแบบเบา (ใช้ร่วมกันทั้งหน้าลูกค้า index.html และหน้าแอดมิน admin.html)
 *
 * แนวคิด: ตอนแอดมินอัปโหลด ระบบคำนวณความดังของเพลงเป็นตัวเลขชุดสั้น (waveform: 160 ค่า, 0-100) เก็บไว้ในข้อมูลเพลง
 *         หน้าเว็บแค่วาดแท่งจากตัวเลขนั้นด้วย <canvas> → ไม่ต้องโหลด/ถอดเสียงไฟล์เพลงเพิ่ม เบามือถือ เบาเน็ต
 *         และคำนวณจากไฟล์ตัวอย่าง (file_url) เท่านั้น ไม่เกี่ยวกับไฟล์เต็ม
 * ผลกระทบระบบเดิม: 0% — ไฟล์ใหม่ ไม่มีผลถ้าเพลงไม่มีข้อมูล waveform (เพลงเก่าจะไม่แสดงกราฟ ทุกอย่างเหมือนเดิม)
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

  // วินาทีที่ตรงกับตำแหน่งนิ้ว/เมาส์บน canvas
  function timeAt(canvas, clientX, duration) {
    const r = canvas.getBoundingClientRect();
    if (!r.width || !(duration > 0)) return 0;
    return Math.max(0, Math.min(duration, ((clientX - r.left) / r.width) * duration));
  }

  /* o = {
   *   peaks: number[], duration: วินาทีทั้งเพลง,
   *   region: {start,end}|null   ช่วงที่ไฮไลต์ (ช่วง Preview) — นอกช่วงจะจาง
   *   time: number|null          ตำแหน่งเล่นปัจจุบัน (วินาที) → เส้น playhead + แท่งที่เล่นแล้วเป็นสีชมพู
   *   tint: bool                 พื้นหลังอ่อนในช่วง region
   *   bpm, grid, gridLabels      เส้นห้อง (ทุก 8 ห้อง) + ตัวเลขห้อง
   *   marker: {time,label}|null  เส้นประสีเหลือง (จุดเริ่ม Dance)
   *   outside: สีแท่งนอกช่วง
   * } */
  function draw(canvas, o) {
    if (!canvas || !o) return false;
    const peaks = sanitize(o.peaks);
    if (!peaks) return false;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return false; // ยังซ่อนอยู่ (เช่น popup ยังไม่เปิด) — วาดทีหลัง
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

    if (region && o.tint) {
      g.fillStyle = withAlpha(accent, 0.14);
      g.fillRect((region.start / dur) * w, 0, ((region.end - region.start) / dur) * w, h);
    }
    for (let i = 0; i < n; i++) {
      const t = dur ? ((i + 0.5) / n) * dur : 0;
      const inR = !region || (t >= region.start && t <= region.end);
      const amp = Math.max(1.5, (peaks[i] / 100) * h * 0.44);
      g.fillStyle = !inR ? (o.outside || "rgba(148,163,184,.25)")
        : (time != null && t <= time ? accent2 : accent);
      g.fillRect(i * bw + gap / 2, h / 2 - amp, Math.max(1, bw - gap), amp * 2);
    }

    if (o.grid && o.bpm && dur) { // เส้นห้อง ทุก 8 ห้อง
      const barSec = 240 / o.bpm;
      g.strokeStyle = "rgba(255,255,255,.16)"; g.fillStyle = "rgba(255,255,255,.6)";
      g.font = "10px sans-serif"; g.lineWidth = 1;
      for (let b = 0; b * barSec < dur; b += 8) {
        const x = Math.round(((b * barSec) / dur) * w) + 0.5;
        g.beginPath(); g.moveTo(x, h - 11); g.lineTo(x, h); g.stroke();
        if (o.gridLabels) g.fillText(String(b), x + 3, h - 2);
      }
    }
    if (o.marker && dur && o.marker.time >= 0 && o.marker.time <= dur) { // เส้นประเหลือง = จุดเริ่ม Dance
      const x = Math.round((o.marker.time / dur) * w) + 0.5;
      g.save(); g.strokeStyle = "#fbbf24"; g.fillStyle = "#fbbf24"; g.lineWidth = 2; g.setLineDash([4, 3]);
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); g.restore();
      if (o.marker.label) { g.font = "bold 10px sans-serif"; g.fillText(o.marker.label, Math.min(w - 40, x + 4), 11); }
    }
    if (time != null) { // playhead
      const x = Math.max(1, Math.min(w - 1, (time / dur) * w));
      g.fillStyle = "#fff"; g.fillRect(x - 1, 0, 2, h);
    }
    return true;
  }

  global.MiusicWave = { draw: draw, timeAt: timeAt, sanitize: sanitize };
})(window);
