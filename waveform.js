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

  // ===== สไตล์กราฟ (ให้ผู้ใช้เลือก) =====
  //   section = สีตามส่วนของเพลง (แบบแถบ phrase บนเครื่อง DJ): อินโทร=เขียว · ปกติ=ม่วงน้ำเงิน · Dance=แดง-ส้ม
  //   rgb     = DJ Pro (แบบ djay Pro / Rekordbox RGB): สีผสมตามย่านเสียง ต่ำ=แดง · กลาง=เขียว · สูง=น้ำเงิน · เนียนต่อเนื่อง
  //   mono    = สีเดียวแบบเดิม
  const SEC = {
    intro:  { c0: "#15803d", c1: "#22c55e", tag: "INTRO", dot: "#22c55e", name: "อินโทร" },
    normal: { c0: "#3730a3", c1: "#818cf8", tag: "",      dot: "#818cf8", name: "ปกติ" },
    dance:  { c0: "#b91c1c", c1: "#f97316", tag: "DANCE", dot: "#f97316", name: "Dance" }
  };
  const BAND_DOT = { low: "#ef4444", mid: "#22c55e", high: "#3b82f6" }; // สีจุดอธิบายย่านเสียงในปุ่ม legend
  const STYLES = [["section", "ส่วนเพลง"], ["rgb", "DJ Pro"], ["mono", "สีเดียว"]];
  const DANCE_BARS = 24; // ความยาว Dance ที่ระบบวิเคราะห์ใช้ (ห้อง)

  // แบ่งเพลงเป็นส่วน: อินโทร (ช่วงต้นที่เบากว่า) · Dance (เริ่มที่ห้อง Dance ยาว 24 ห้อง) · ปกติ (ที่เหลือ)
  //   คำนวณจากกราฟความดังที่มีอยู่แล้ว + ตำแหน่ง Dance — ไม่ต้องเก็บข้อมูลเพิ่ม เพลงเก่าใช้ได้ทันที
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
    while (k < n && sm[k] < loud * 0.55) k++;       // อินโทร = ช่วงต้นเพลงจนกว่าความดังจะถึง ~55% ของระดับเต็ม
    let iE = k * binSec;
    const limit = dS != null ? dS : dur * 0.4;      // ต้องจบก่อน Dance (ไม่มี Dance → ไม่เกิน 40% ของเพลง)
    if (iE > limit) iE = limit;
    if (iE < 3) iE = 0;                              // สั้นกว่า 3 วิ ไม่ถือเป็นอินโทร (เช่น เพลงที่เริ่มดังเต็มตั้งแต่ต้น)
    const segs = [];
    const add = (type, s, e) => { if (e - s > 0.001) segs.push({ type: type, start: s, end: e }); };
    if (iE > 0) add("intro", 0, iE);
    if (dS != null) { add("normal", iE, dS); add("dance", dS, dE); add("normal", dE, dur); }
    else add("normal", iE, dur);
    return segs;
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
  //   ช่วงเบาสีเข้มลง ช่วงดังสว่างขึ้น (ตามความสูงแท่ง) · คืน [r,g,b] 0-255
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
   *   region: {start,end}|null   ช่วงที่ไฮไลต์ (ช่วง Preview) — นอกช่วงจะจาง
   *   time: number|null          ตำแหน่งเล่นปัจจุบัน (วินาที) → เส้น playhead + แท่งที่ยังไม่เล่นจางลงเล็กน้อย
   *   tint: bool                 พื้นหลังอ่อนในช่วง region
   *   bpm, grid, gridLabels      เส้นห้อง (ทุก 8 ห้อง) + ตัวเลขห้อง
   *   marker: {time,label}|null  เส้นประสีเหลือง (จุดเริ่ม Dance)
   *   dance: {time}|null         จุดเริ่ม Dance สำหรับสไตล์ "ส่วนเพลง" (ถ้าไม่ส่งจะใช้ marker)
   *   style: "section"|"rgb"|"mono"   สไตล์กราฟ (ไม่ส่ง = rgb ถ้ามีข้อมูลสี ไม่งั้น mono)
   *   bands: number[3n]|null     ข้อมูลสี 3 ย่านความถี่ (waveform_rgb) — ไม่มี/ไม่ตรงรูปแบบ → rgb จะวาดเป็นสีเดียว
   *   outside: สีแท่งนอกช่วง (สไตล์สีเดียว)
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
    const bands = sanitizeBands(o.bands, n);
    let style = o.style === "section" || o.style === "rgb" || o.style === "mono" ? o.style : (bands ? "rgb" : "mono");
    if (style === "rgb" && !bands) style = "mono"; // ไม่มีข้อมูลสี → วาดสีเดียวเหมือนเดิม
    const barSec = Number(o.bpm) > 0 ? 240 / Number(o.bpm) : 1.6;
    const danceT = o.dance && o.dance.time != null ? Number(o.dance.time)
      : (o.marker && o.marker.time != null ? Number(o.marker.time) : null);
    const segs = style === "section" && dur ? computeSections(peaks, dur, danceT, barSec) : null;
    // พื้นที่วาดแท่ง: สไตล์ section เว้นแถบส่วนเพลงไว้ด้านบน 14px · เว้นด้านล่างให้เลขห้อง 11px
    const top0 = segs ? 14 : 0, gridPad = (o.grid && o.bpm && dur) ? 11 : 0;
    const halfH = Math.max(4, (h - top0 - gridPad) / 2), cy = top0 + halfH;

    if (region && o.tint && style !== "rgb") {
      g.fillStyle = withAlpha(accent, 0.14);
      g.fillRect((region.start / dur) * w, 0, ((region.end - region.start) / dur) * w, h);
    }
    // ----- DJ Pro: วาดกราฟทั้งเส้นลง canvas สำรองครั้งเดียว (แคช) แล้วทุกเฟรมแค่แปะภาพ → เบาเครื่องแม้เล่นต่อเนื่อง -----
    if (style === "rgb") {
      const paintDj = function (ctx) {
        const cols = Math.max(24, Math.min(Math.floor(w / 1.5), 420)); // ไม่เกิน 420 คอลัมน์ → เบา
        const cw = w / cols;
        for (let c = 0; c < cols; c++) {
          // ต่อเนื่องเนียน: สอดแทรกค่าจาก 160 ช่วงให้ครบทุกคอลัมน์ (ไม่ต้องเก็บข้อมูลเพิ่ม)
          const u = ((c + 0.5) / cols) * n - 0.5;
          const i0 = Math.max(0, Math.min(n - 1, Math.floor(u))), i1 = Math.min(n - 1, i0 + 1);
          const f = Math.max(0, Math.min(1, u - i0));
          const lp = function (arr) { return arr[i0] + (arr[i1] - arr[i0]) * f; };
          const v = lp(peaks) / 100;
          const col = djColor(lp(bands[0]) / 100, lp(bands[1]) / 100, lp(bands[2]) / 100, v);
          const amp = Math.max(1.2, v * halfH * 0.94), amp2 = amp * 0.6;
          const x = c * cw, bwid = cw + 0.6; // ซ้อนกันเล็กน้อยกันเส้นรอยต่อ
          ctx.fillStyle = "rgb(" + Math.round(col[0] * 0.55) + "," + Math.round(col[1] * 0.55) + "," + Math.round(col[2] * 0.55) + ")";
          ctx.fillRect(x, cy - amp, bwid, amp * 2);                         // ชั้นนอก: ขอบนุ่มสีเข้ม
          ctx.fillStyle = "rgb(" + Math.min(255, col[0] + 28) + "," + Math.min(255, col[1] + 28) + "," + Math.min(255, col[2] + 28) + ")";
          ctx.fillRect(x, cy - amp2, bwid, amp2 * 2);                       // แกนใน: สว่าง
        }
        if (region) { // นอกช่วง Preview: ทับด้วยสีพื้นหลังโปร่งแสง ให้ช่วงที่ฟังได้เด่นขึ้น
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
      if (time != null && dur) { // ส่วนที่เล่นผ่านแล้วหรี่ลงเล็กน้อย (แบบ djay)
        g.fillStyle = "rgba(6,8,18,.38)";
        g.fillRect(0, 0, Math.max(0, Math.min(w, (time / dur) * w)), h);
      }
    }
    let grads = null;
    const segOf = function (t) {
      if (segs) for (let s = 0; s < segs.length; s++) if (t >= segs[s].start && t < segs[s].end) return segs[s].type;
      return "normal";
    };
    if (segs) { // ไล่สีแนวตั้ง: ขอบเข้ม → กลางสว่าง (ให้ดูมีมิติแบบเครื่อง DJ)
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
      // นอกช่วง Preview จางมาก · ในช่วงที่ยังไม่เล่นถึงจางลงเล็กน้อย · เล่นผ่านแล้วสีเต็ม
      const al = !inR ? 0.4 : (time != null && t > time ? 0.66 : 1);
      const amp = Math.max(1.5, v * halfH * 0.94);
      g.globalAlpha = al;
      if (style === "section") {
        g.fillStyle = grads[segOf(t)];
        g.fillRect(x, cy - amp, bwid, amp * 2);
        const core = amp * (bands ? 0.3 + 0.5 * bands[0][i] / 100 : 0.5); // แกนสว่างตรงกลาง: หนาตามพลังเสียงต่ำ (จังหวะกระเดื่อง)
        g.fillStyle = "rgba(255,255,255,.2)";
        g.fillRect(x, cy - core, bwid, core * 2);
      }
      g.globalAlpha = 1;
    }

    if (segs) { // แถบส่วนเพลงด้านบน (เหมือนแถบ phrase บน Rekordbox): อินโทร / ปกติ / Dance
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
    if (o.grid && o.bpm && dur) { // เส้นห้อง ทุก 8 ห้อง
      const bs = 240 / o.bpm;
      g.strokeStyle = "rgba(255,255,255,.16)"; g.fillStyle = "rgba(255,255,255,.6)";
      g.font = "10px sans-serif"; g.lineWidth = 1;
      for (let b = 0; b * bs < dur; b += 8) {
        const x = Math.round(((b * bs) / dur) * w) + 0.5;
        g.beginPath(); g.moveTo(x, h - 11); g.lineTo(x, h); g.stroke();
        if (o.gridLabels) g.fillText(String(b), x + 3, h - 2);
      }
    }
    if (o.marker && dur && o.marker.time >= 0 && o.marker.time <= dur) { // เส้นประเหลือง = จุดเริ่ม Dance
      const x = Math.round((o.marker.time / dur) * w) + 0.5;
      g.save(); g.strokeStyle = "#fbbf24"; g.fillStyle = "#fbbf24"; g.lineWidth = 2; g.setLineDash([4, 3]);
      g.beginPath(); g.moveTo(x, segs ? 11 : 0); g.lineTo(x, h); g.stroke(); g.restore();
      if (o.marker.label && !segs) { g.font = "bold 10px sans-serif"; g.fillText(o.marker.label, Math.min(w - 40, x + 4), 11); }
    }
    if (time != null) { // playhead
      const x = Math.max(1, Math.min(w - 1, (time / dur) * w));
      g.fillStyle = style === "rgb" ? "#ef4444" : "#fff"; g.fillRect(x - 1, 0, 2, h);
    }
    return true;
  }

  global.MiusicWave = { draw: draw, timeAt: timeAt, sanitize: sanitize, sanitizeBands: sanitizeBands, computeSections: computeSections, mountSwitch: mountSwitch, getStyle: getStyle };
})(window);
