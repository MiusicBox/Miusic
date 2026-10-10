/* ==========================================================================
   notify.js — ระบบแจ้งเตือนกลางของ Miusic (ไฟล์คลาสสิก ไม่ใช่ module)
   โหลดก่อน app-*.js ทุกไฟล์ เพื่อให้ทุกไฟล์เรียกใช้ได้จาก window

   API
     __notify.toast(message, type?)          type: success | error | warning | info | progress
                                             (รองรับ success_long / error_long แบบเดิม)
     __notify.alert(message, opts?)          → Promise<void>
     __notify.confirm(message, opts?)        → Promise<boolean>
     __notify.prompt(message, opts?)         → Promise<string|null>
     opts: { title, okText, cancelText, type, danger, success, href, placeholder, inputType }

   ตัวช่วยที่ผูกกับ window เพื่อให้โค้ดเดิมทำงานต่อได้:
     showToast, customAlert, customConfirm, customPrompt, และ alert() ที่ไม่บล็อกหน้าจอ
   ========================================================================== */
(function () {
  "use strict";
  if (window.__notify) return;

  var ICONS = {
    success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    warning: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8v5M12 16.5v.01"/><path d="M10.3 3.9L2.6 17.2A2 2 0 0 0 4.3 20h15.4a2 2 0 0 0 1.7-2.8L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.5v.01"/></svg>',
    progress: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 3a9 9 0 1 0 9 9" /></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>'
  };
  ICONS.danger = ICONS.warning;

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // ---------- จัดการข้อความ: ตัดอีโมจิหน้าข้อความ (ไอคอนใหม่แทนให้แล้ว) + เดาประเภท ----------
  var LEAD_EMOJI = /^[\s\u200d\ufe0f]*([\u2705\u2714\u274c\u26a0\u2139\u23f3\u2757\u2753]|\p{Extended_Pictographic})[\u200d\ufe0f\s]*/u;
  function parseMessage(raw, type) {
    var text = String(raw == null ? "" : raw).trim();
    var m = text.match(LEAD_EMOJI);
    if (m) {
      var e = m[1];
      if (!type) {
        if (e === "\u2705" || e === "\u2714" || e === "\ud83c\udf89") type = "success";
        else if (e === "\u274c") type = "error";
        else if (e === "\u26a0" || e === "\u2757") type = "warning";
        else if (e === "\u23f3") type = "progress";
      }
      text = text.slice(m[0].length) || text;
    }
    return { text: text, type: type };
  }
  function normType(t) {
    t = String(t || "").replace(/_long$/, "");
    return ICONS[t] && t !== "close" && t !== "danger" ? t : "info";
  }

  // ===================== TOAST =====================
  var stack = null, toasts = [], MAX = 3;
  function ensureStack() {
    if (stack && document.body && document.body.contains(stack)) return stack;
    stack = document.createElement("div");
    stack.className = "nf-stack";
    stack.setAttribute("role", "region");
    stack.setAttribute("aria-label", "การแจ้งเตือน");
    (document.body || document.documentElement).appendChild(stack);
    return stack;
  }
  function dismiss(t) {
    if (!t || t.gone) return;
    t.gone = true;
    clearTimeout(t.safety);
    toasts = toasts.filter(function (x) { return x !== t; });
    t.el.classList.add("leaving");
    var done = function () { if (t.el.parentNode) t.el.parentNode.removeChild(t.el); };
    t.el.addEventListener("animationend", done, { once: true });
    setTimeout(done, 400);
  }
  function duration(rawType, base, text) {
    var long_ = /_long$/.test(String(rawType || ""));
    var ms = base === "error" ? 4600 : base === "warning" ? 4000 : 2600;
    if (long_) ms = base === "error" ? 6500 : 4200;
    // ข้อความยาว → ให้เวลาอ่านเพิ่ม (สูงสุด 9 วิ)
    ms += Math.min(5000, Math.max(0, text.length - 40) * 55);
    return Math.min(ms, 9000);
  }
  function toast(message, rawType) {
    if (!document.body) { document.addEventListener("DOMContentLoaded", function () { toast(message, rawType); }); return; }
    var p = parseMessage(message, rawType ? String(rawType) : "");
    var type = normType(p.type);
    var text = p.text;
    if (!text) return;
    var host = ensureStack();

    // ข้อความ progress (เช่น สร้าง ZIP) อัปเดตที่เดิม ไม่ซ้อนหลายอัน
    if (type === "progress") {
      var cur = toasts.filter(function (x) { return x.type === "progress"; })[0];
      if (cur) {
        cur.msg.textContent = text;
        clearTimeout(cur.safety);
        cur.safety = setTimeout(function () { dismiss(cur); }, 12000);
        return cur;
      }
    } else {
      toasts.filter(function (x) { return x.type === "progress"; }).forEach(dismiss);
    }
    // ข้อความซ้ำ → รีเซ็ตเวลา + แสดงตัวเลขนับ แทนการเพิ่มการ์ดใหม่
    var dup = toasts.filter(function (x) { return x.type === type && x.text === text; })[0];
    if (dup) {
      dup.n++;
      if (!dup.cnt) {
        dup.cnt = document.createElement("span");
        dup.cnt.className = "nf-count";
        dup.el.insertBefore(dup.cnt, dup.x);
      }
      dup.cnt.textContent = "\u00d7" + dup.n;
      var oldBar = dup.bar, nb = oldBar.cloneNode();
      oldBar.parentNode.replaceChild(nb, oldBar);
      dup.bar = nb;
      nb.addEventListener("animationend", function () { dismiss(dup); });
      return dup;
    }

    var el = document.createElement("div");
    el.className = "nf-toast " + type;
    el.setAttribute("role", type === "error" ? "alert" : "status");
    var ms = duration(rawType, type, text);
    el.innerHTML =
      '<span class="nf-ico">' + ICONS[type] + "</span>" +
      '<span class="nf-msg"></span>' +
      '<button class="nf-x" type="button" aria-label="ปิดการแจ้งเตือน">' + ICONS.close + "</button>" +
      '<span class="nf-bar" style="--d:' + ms + 'ms"></span>';
    var t = { el: el, type: type, text: text, n: 1,
      msg: el.querySelector(".nf-msg"), x: el.querySelector(".nf-x"), bar: el.querySelector(".nf-bar") };
    t.msg.textContent = text;
    t.x.addEventListener("click", function () { dismiss(t); });
    if (type === "progress") t.safety = setTimeout(function () { dismiss(t); }, 12000);
    else t.bar.addEventListener("animationend", function () { dismiss(t); });

    host.appendChild(el);
    toasts.push(t);
    while (toasts.length > MAX) dismiss(toasts[0]);
    return t;
  }

  // ===================== DIALOG =====================
  var queue = Promise.resolve();
  function dialog(o) {
    var run = function () { return openDialog(o || {}); };
    var p = queue.then(run, run);
    queue = p.catch(function () {});
    return p;
  }
  function openDialog(o) {
    return new Promise(function (resolve) {
      var type = o.type || (o.danger ? "danger" : o.success ? "success" : "info");
      if (type === "error" && o.showCancel) type = "danger";
      var iconKey = type === "danger" ? "warning" : normType(type);
      var titleDefault = { success: "สำเร็จ", error: "เกิดข้อผิดพลาด", warning: "โปรดตรวจสอบ", danger: "ยืนยันการทำรายการ", info: o.showCancel || o.input ? "ยืนยันการทำรายการ" : "แจ้งเตือน" };
      var prev = document.activeElement;
      var bd = document.createElement("div");
      bd.className = "nf-backdrop";
      var id = "nf" + Math.random().toString(36).slice(2, 8);
      var okTag = o.href ? "a" : "button";
      bd.innerHTML =
        '<div class="nf-dialog ' + type + '" role="' + (type === "error" ? "alertdialog" : "dialog") + '" aria-modal="true" aria-labelledby="' + id + 't" aria-describedby="' + id + 'b">' +
        '<div class="nf-halo">' + ICONS[iconKey] + "</div>" +
        '<h3 class="nf-title" id="' + id + 't">' + esc(o.title || titleDefault[type] || "แจ้งเตือน") + "</h3>" +
        '<p class="nf-body" id="' + id + 'b"></p>' +
        (o.input ? '<input class="nf-input" type="' + esc(o.inputType || "text") + '" placeholder="' + esc(o.placeholder || "") + '" autocomplete="off">' : "") +
        '<div class="nf-actions">' +
        (o.showCancel ? '<button class="nf-btn" type="button" data-r="cancel">' + esc(o.cancelText || "ยกเลิก") + "</button>" : "") +
        "<" + okTag + ' class="nf-btn primary" data-r="ok"' + (o.href ? ' href="' + esc(o.href) + '" target="_blank" rel="noopener"' : ' type="button"') + ">" + esc(o.okText || "ตกลง") + "</" + okTag + ">" +
        "</div></div>";
      bd.querySelector(".nf-body").textContent = String(o.message == null ? "" : o.message);
      if (!bd.querySelector(".nf-body").textContent) bd.querySelector(".nf-body").style.display = "none";
      var input = bd.querySelector(".nf-input");
      if (input && o.value) input.value = o.value;
      var okBtn = bd.querySelector('[data-r="ok"]');

      var closed = false;
      function finish(ok) {
        if (closed) return;
        closed = true;
        document.removeEventListener("keydown", onKey, true);
        bd.classList.remove("show");
        setTimeout(function () {
          if (bd.parentNode) bd.parentNode.removeChild(bd);
          if (!document.querySelector(".nf-backdrop")) document.body.classList.remove("nf-lock");
          try { if (prev && prev.focus) prev.focus(); } catch (_) {}
        }, 220);
        if (o.input) resolve(ok ? input.value : null);
        else resolve(o.showCancel ? !!ok : undefined);
      }
      function onKey(e) {
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false); }
        else if (e.key === "Enter" && !(e.target && e.target.dataset && e.target.dataset.r === "cancel")) { e.preventDefault(); if (o.href) okBtn.click(); finish(true); }
        else if (e.key === "Tab") {
          var f = bd.querySelectorAll("button, a[href], input");
          if (!f.length) return;
          var first = f[0], last = f[f.length - 1];
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
      }
      bd.addEventListener("click", function (e) {
        if (e.target === bd) finish(false);
        var b = e.target.closest && e.target.closest("[data-r]");
        if (b) finish(b.dataset.r === "ok");
      });
      document.addEventListener("keydown", onKey, true);
      document.body.appendChild(bd);
      document.body.classList.add("nf-lock");
      requestAnimationFrame(function () {
        bd.classList.add("show");
        (input || okBtn).focus();
      });
    });
  }
  function alertDlg(message, o) { o = o || {}; var p = parseMessage(message, o.type); return dialog(Object.assign({}, o, { message: p.text, type: p.type || o.type || "info" })); }
  function confirmDlg(message, o) { o = o || {}; var p = parseMessage(message, o.type); return dialog(Object.assign({ okText: "ยืนยัน" }, o, { message: p.text, type: p.type || o.type, showCancel: true })); }
  function promptDlg(message, o) { o = o || {}; return dialog(Object.assign({ okText: "ยืนยัน" }, o, { message: message, input: true, showCancel: true })); }

  // alert() แบบไม่บล็อก — ข้อความสั้นขึ้นเป็น toast, ข้อความยาว/หลายบรรทัดขึ้นเป็น dialog
  function patchedAlert(message) {
    var s = String(message == null ? "" : message);
    if (s.length <= 80 && s.indexOf("\n") === -1) toast(s);
    else alertDlg(s);
  }

  var api = { toast: toast, alert: alertDlg, confirm: confirmDlg, prompt: promptDlg, dialog: dialog, dismissAll: function () { toasts.slice().forEach(dismiss); } };
  window.__notify = api;
  window.__nativeAlert = window.alert;
  window.alert = patchedAlert;
  window.showToast = toast;
  window.customAlert = alertDlg;
  window.customPrompt = promptDlg;
  // adminPrompt(message, defaultValue, options) → Promise<string|null> (app-admin.js เรียกใช้ตอนปฏิเสธสลิป)
  window.adminPrompt = function (message, defaultValue, o) { return promptDlg(message, Object.assign({}, o || {}, { value: defaultValue || "" })); };
  // customConfirm ถูก (re)define ใหม่โดยสคริปต์เดิมใน index.html — ผูกอีกครั้งตอน DOM พร้อมเพื่อให้ตัวใหม่ชนะ
  window.customConfirm = confirmDlg;
  document.addEventListener("DOMContentLoaded", function () { window.customConfirm = confirmDlg; });
  window.addEventListener("load", function () { window.customConfirm = confirmDlg; });

  // modal ยืนยัน/แจ้งเตือนเดิมฝั่งแอดมิน: เติมไอคอนสถานะให้หน้าตาเหมือน dialog ใหม่
  document.addEventListener("DOMContentLoaded", function () {
    ["confirmBackdrop", "alertBackdrop"].forEach(function (id) {
      var m = document.querySelector("#" + id + " .modal");
      if (!m || m.querySelector(".nf-modal-icon")) return;
      // ฝั่งลูกค้าไม่ใช้ modal เดิมนี้แล้ว (ใช้ dialog ใหม่) — เติมไอคอนเฉพาะที่ยังใช้งาน
      var d = document.createElement("div");
      d.className = "nf-modal-icon";
      d.innerHTML =
        '<span class="i-info">' + ICONS.info + "</span>" +
        '<span class="i-warn">' + ICONS.warning + "</span>" +
        '<span class="i-ok">' + ICONS.success + "</span>";
      m.insertBefore(d, m.firstChild);
    });
  });
})();
