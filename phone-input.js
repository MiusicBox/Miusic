// /home/z/my-project/Miusic/phone-input.js
// 🆕 (T045): PhoneInput — Country Selector Dropdown 🇱🇦/🇹🇭
// ============================================================
// ปัญหา: T044 ใส่ placeholder "ลาว: 020 1234 5678 · ไทย: 081 234 5678" → ลูกค้ายังสับสน
//   ต้องพิมพ์เอง + ไม่รู้ว่าใส่ +856 หรือ 020 หรือ 20
//
// วิธีแก้: ใส่ country selector dropdown ข้าง input
//   - ปุ่ม flag วางซ้อนด้านซ้ายใน input (absolute position)
//   - Click → dropdown 2 ตัวเลือก 🇱🇦 ลาว / 🇹🇭 ไทย
//   - Auto-detect จาก prefix ของเบอร์ที่พิมพ์ (020 → ลาว, 08/09/06 → ไทย)
//   - จดจำการเลือกใน localStorage (music_store_phone_country)
//   - Default: ลาว (เว็บหลักลาว, timezone Asia/Vientiane)
//
// ผลกระทบระบบเดิม: 0%
//   - ไม่แก้ worker (normalize logic มีอยู่แล้ว)
//   - ไม่แก้ schema (DB ยังเก็บ 85620XXX / 668XXXXXXXXX)
//   - ไม่แก้ logic เดิม (formatPhoneForDisplay, normalizePhoneForStorage, normalizeWhatsapp)
//   - แค่ mount UI บน input ที่มีอยู่แล้ว
//
// วิธีใช้:
//   1. เพิ่ม <script src="/phone-input.js" defer></script> ใน HTML
//   2. เรียก PhoneInput.mount(inputElement) หรือ PhoneInput.mountAll()
//   3. อ่านค่า country: PhoneInput.getCountry(inputElement)
//   4. (optional) อ่านค่า normalized: PhoneInput.getValue(inputElement) → คืน "85620XXX" หรือ "668XXXXXXXXX"
//
// ตัวอย่าง:
//   <input id="checkoutCustomerWhatsapp" type="tel">
//   <script>
//     const input = document.getElementById("checkoutCustomerWhatsapp");
//     PhoneInput.mount(input);
//     // อ่านค่า:
//     const value = PhoneInput.getValue(input); // → "8562012345678" (ลาว) หรือ "66812345678" (ไทย)
//   </script>

const PhoneInput = (function () {
  "use strict";

  const STORAGE_KEY = "music_store_phone_country";
  const COUNTRIES = [
    {
      code: "LA",
      flag: "🇱🇦",
      label: "ลาว",
      dialCode: "+856",
      // prefix ที่ใช้ auto-detect ลาว (เรียงจาก specific → generic)
      detectPrefixes: ["856", "020", "20"],
      // รูปแบบเบอร์ local (ไม่มี country code)
      localPrefixes: ["020", "20"],
      // format display ใน placeholder
      placeholder: "20 1234 5678",
      // normalize เบอร์ local → international
      normalize: function (s) {
        // 020XXXXXXXX → 85620XXXXXXXX
        if (s.startsWith("020")) return "856" + s.slice(1);
        // 20XXXXXXXX (10 หลัก) → 85620XXXXXXXX
        if (s.startsWith("20") && s.length === 10) return "856" + s;
        // มี country code แล้ว
        if (s.startsWith("856")) return s;
        // ไม่ตรงรูปแบบ → prepend 856
        return "856" + s;
      },
    },
    {
      code: "TH",
      flag: "🇹🇭",
      label: "ไทย",
      dialCode: "+66",
      detectPrefixes: ["66", "08", "09", "06"],
      localPrefixes: ["08", "09", "06"],
      placeholder: "81 234 5678",
      normalize: function (s) {
        // 0XXXXXXXXX (10 หลัก) → 66XXXXXXXXX
        if (s.startsWith("0") && s.length === 10) return "66" + s.slice(1);
        // มี country code แล้ว
        if (s.startsWith("66")) return s;
        // ไม่ตรงรูปแบบ → prepend 66
        return "66" + s;
      },
    },
  ];

  function getDefaultCountry() {
    // Default: ลาว (เว็บหลักลาว)
    // ตรวจ localStorage ก่อน — ถ้า user เคยเลือกไทย → ใช้ไทย
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved === "TH" || saved === "LA") {
        return COUNTRIES.find((c) => c.code === saved);
      }
    } catch (_) {}
    return COUNTRIES[0]; // LA
  }

  function saveCountry(countryCode) {
    try {
      localStorage.setItem(STORAGE_KEY, countryCode);
    } catch (_) {}
  }

  function findCountryByCode(code) {
    return COUNTRIES.find((c) => c.code === code) || COUNTRIES[0];
  }

  // Auto-detect country จากเบอร์ที่พิมพ์
  function detectCountry(phoneStr) {
    if (!phoneStr) return null;
    let s = String(phoneStr).replace(/[^0-9+]/g, "").replace(/^\+/, "");
    if (!s) return null;
    // เช็คลาวก่อน (856/020/20)
    //   856 → ลาว (country code)
    //   020 → ลาว (local)
    //   20XXXXXXXX (10 หลัก) → ลาว
    if (s.startsWith("856")) return COUNTRIES[0]; // LA
    if (s.startsWith("020")) return COUNTRIES[0]; // LA
    if (s.startsWith("20") && s.length === 10) return COUNTRIES[0]; // LA
    // เช็คไทย (66/08/09/06)
    if (s.startsWith("66")) return COUNTRIES[1]; // TH
    if (s.startsWith("08") || s.startsWith("09") || s.startsWith("06")) {
      // ต้องเป็น 10 หลัก (08XXXXXXXX, 09XXXXXXXX, 06XXXXXXXX)
      if (s.length === 10) return COUNTRIES[1]; // TH
    }
    return null;
  }

  // Mount country selector บน input
  function mount(input, options) {
    if (!input) return null;
    if (input.dataset.phoneInputMounted === "1") return null; // mount แล้ว
    input.dataset.phoneInputMounted = "1";

    const opts = options || {};
    const initialCountry = opts.country || getDefaultCountry();

    // wrap input ใน container ถ้ายังไม่ได้ wrap
    let wrapper = input.parentElement;
    if (!wrapper || !wrapper.classList.contains("phone-input-wrapper")) {
      wrapper = document.createElement("div");
      wrapper.className = "phone-input-wrapper";
      input.parentNode.insertBefore(wrapper, input);
      wrapper.appendChild(input);
    }

    // สร้าง flag button
    const flagBtn = document.createElement("button");
    flagBtn.type = "button";
    flagBtn.className = "phone-input-flag-btn";
    flagBtn.setAttribute("aria-label", "เลือกประเทศ");
    flagBtn.setAttribute("aria-haspopup", "listbox");
    flagBtn.setAttribute("aria-expanded", "false");

    // สร้าง dropdown
    const dropdown = document.createElement("div");
    dropdown.className = "phone-input-dropdown";
    dropdown.setAttribute("role", "listbox");
    dropdown.hidden = true;

    COUNTRIES.forEach((c) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "phone-input-dropdown-item";
      item.setAttribute("role", "option");
      item.dataset.countryCode = c.code;
      item.innerHTML = `<span class="phone-input-flag">${c.flag}</span> <span class="phone-input-label">${c.label}</span> <span class="phone-input-dial">${c.dialCode}</span>`;
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        setCountry(c.code);
        closeDropdown();
        // focus กลับไปที่ input
        input.focus();
        // trigger input event เพื่อให้ auto-detect logic ทำงาน
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      dropdown.appendChild(item);
    });

    // ฟังก์ชันเปิด/ปิด dropdown
    function openDropdown() {
      dropdown.hidden = false;
      flagBtn.setAttribute("aria-expanded", "true");
      // mark selected
      const currentCode = flagBtn.dataset.countryCode || initialCountry.code;
      dropdown.querySelectorAll(".phone-input-dropdown-item").forEach((it) => {
        if (it.dataset.countryCode === currentCode) {
          it.classList.add("selected");
          it.setAttribute("aria-selected", "true");
        } else {
          it.classList.remove("selected");
          it.setAttribute("aria-selected", "false");
        }
      });
    }
    function closeDropdown() {
      dropdown.hidden = true;
      flagBtn.setAttribute("aria-expanded", "false");
    }
    function toggleDropdown() {
      if (dropdown.hidden) openDropdown(); else closeDropdown();
    }

    // ฟังก์ชันเปลี่ยน country
    function setCountry(countryCode) {
      const c = findCountryByCode(countryCode);
      flagBtn.dataset.countryCode = c.code;
      flagBtn.innerHTML = `<span class="phone-input-flag">${c.flag}</span> <span class="phone-input-dial">${c.dialCode}</span>`;
      // อัปเดต placeholder ให้ตรง country
      input.placeholder = c.placeholder;
      // จดจำการเลือก
      saveCountry(c.code);
      // dispatch event ให้ caller รู้
      input.dispatchEvent(new CustomEvent("phoneinput:countrychange", {
        bubbles: true,
        detail: { country: c.code, dialCode: c.dialCode },
      }));
    }

    // event listeners
    flagBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleDropdown();
    });
    // ปิด dropdown เมื่อคลิกข้างนอก
    document.addEventListener("click", (e) => {
      if (!wrapper.contains(e.target)) closeDropdown();
    });
    // ปิด dropdown เมื่อกด Escape
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeDropdown();
    });

    // Auto-detect ตอนพิมพ์ — ถ้าเบอร์ตรง prefix ของ country อื่น → auto-switch
    //   แต่ถ้า user เลือก manually แล้ว → ไม่ override (เว้นแต่ prefix ขนาดแรก ๆ ตรง country อื่นชัดเจน)
    //   🔧 (T-sync-bugs-fix-M13 2026-10-06): เดิม userOverride ประกาศ + set แต่ไม่มีที่อ่าน → dead code
    //      → auto-detect ไม่เคารพ manual select (user เลือกไทยแล้วพิมพ์ +856 → กลับเป็นลาว)
    //   วิธีแก้: เช็ค userOverride ใน input handler — ถ้า true แล้วไม่ auto-switch; reset เมื่อ input ว่าง
    //   ผลกระทบระบบเดิม: 0% — เพิ่ม guard ใน auto-detect; manual select path ยังเหมือนเดิม
    let userOverride = false;
    flagBtn.addEventListener("click", () => { userOverride = true; });
    // ใช้ capture phase เพื่อจับ user click ก่อน
    input.addEventListener("input", (e) => {
      // reset userOverride ถ้า user clear input หมด → ให้ auto-detect ทำงานอีกครั้ง
      if (!input.value || !input.value.trim()) {
        userOverride = false;
      }
      // ถ้า user เคยเลือก country เอง → ไม่ auto-switch (เคารพ manual select)
      if (userOverride) return;
      const detected = detectCountry(input.value);
      if (detected && detected.code !== flagBtn.dataset.countryCode) {
        // auto-switch country
        setCountry(detected.code);
      }
    });

    // insert flag button + dropdown ใน wrapper (ก่อน input)
    wrapper.insertBefore(flagBtn, input);
    wrapper.appendChild(dropdown);

    // init display
    setCountry(initialCountry.code);

    // expose ข้อมูลให้ caller
    input._phoneInput = {
      getCountry: () => findCountryByCode(flagBtn.dataset.countryCode),
      getValue: () => {
        const c = findCountryByCode(flagBtn.dataset.countryCode);
        const raw = String(input.value || "").replace(/[^0-9+]/g, "").replace(/^\+/, "");
        if (!raw) return "";
        return c.normalize(raw);
      },
      setCountry,
      focus: () => input.focus(),
    };

    return input._phoneInput;
  }

  // Mount บน selector ทั้งหมด
  function mountAll(selector, options) {
    const sel = selector || "[data-phone-input], input[id$='Whatsapp'], input[id$='whatsapp'], input[id*='CustomerWhatsapp'], input[id*='TrackOrderPhone'], input[id='setWhatsapp']";
    const inputs = document.querySelectorAll(sel);
    const results = [];
    inputs.forEach((input) => {
      const result = mount(input, options);
      if (result) results.push({ input, ...result });
    });
    return results;
  }

  // อ่านค่า normalized จาก input ที่ mount แล้ว
  function getValue(input) {
    if (input && input._phoneInput) return input._phoneInput.getValue();
    // fallback: ถ้าไม่ได้ mount ใช้ normalize แบบเดิม
    const raw = String(input?.value || "").replace(/[^0-9+]/g, "").replace(/^\+/, "");
    if (!raw) return "";
    const detected = detectCountry(raw);
    if (detected) return detected.normalize(raw);
    // fallback ลาว
    return COUNTRIES[0].normalize(raw);
  }

  // อ่าน country ปัจจุบันของ input
  function getCountry(input) {
    if (input && input._phoneInput) return input._phoneInput.getCountry();
    return getDefaultCountry();
  }

  return {
    mount,
    mountAll,
    getValue,
    getCountry,
    detectCountry,
    COUNTRIES,
    getDefaultCountry,
  };
})();

// expose ใน window สำหรับใช้ทั่วไป
if (typeof window !== "undefined") {
  window.PhoneInput = PhoneInput;
}
