/* =====================================================================
 * Miusic Service Worker — PWA (T004-pwa)
 * ---------------------------------------------------------------------
 * Cache version: miusic-pwa-v1.0.2-T048
 *
 * Strategies:
 *   - Static assets (CSS/JS/PNG/SVG/HTML, non-/api/*): cache-first → network
 *   - /api/* (GET only):                network-first → cache fallback (offline)
 *   - Google Fonts:                     stale-while-revalidate
 *   - POST / PUT / DELETE:              never cache (always network)
 *
 *   - 🆕 (T004-SEC-01): authenticated /api/* endpoints (customer/admin/auth/
 *     orders/payment-proofs/audit-log) are NEVER cached (PII leak prevention
 *     on shared devices); logout also broadcasts CLEAR_API_CACHE to SW.
 *
 *   - 🆕 (T049): cache-bust หลัง T044-T048 — อัปเดต version + เพิ่มไฟล์ใหม่ใน precache
 *
 * Iron rules honored:
 *   - worker/* is NEVER cached (server-side code, not for client)
 *   - /api/* responses are NEVER cache-first (prevents PII leak / stale order)
 *   - POST/PUT/DELETE are NEVER intercepted (payment + order mutations safe)
 * ===================================================================== */

// 🆕 (T049-A): อัปเดต CACHE_VERSION หลัง T044-T048 → ลูกค้าเก่าจะได้ cache ใหม่
//   เดิม: 'miusic-pwa-v1.0.1' (ก่อน T044) → ลูกค้าเก่ายังใช้ JS/CSS เก่า → ไม่เห็นการแก้ T044-T048
//   ใหม่: 'miusic-pwa-v1.0.2-T048' → install event จะ activate SW ใหม่ + ล้าง cache เก่า
// 🆕 (T057): อัปเดต CACHE_VERSION หลัง T057 (PDPA + cookie consent + privacy.html)
//   → ลูกค้าเก่าจะได้เห็น cookie banner + modal ตั้งค่าบัญชี
// 🆕 (T058): อัปเดต CACHE_VERSION หลัง T058 (PDPA Phase 2 — admin dashboard + recover account)
// 🆕 (T059): อัปเดต CACHE_VERSION หลัง T059 (PWA offline mode — IndexedDB)
// 🆕 (T060): อัปเดต CACHE_VERSION หลัง T060 (เอา cookie consent banner ออก)
// 🐛 (T061): แก้ตัวกรองขั้นสูงสูงเกินจอบนมือถือ
// 🚀 (T062): ค้นหา/กรองฝั่ง server + keyset paging รองรับ 10,000+ เพลง
// 🚀 (T063): หน้าแอดมินโหลดเพลงแบบแบ่งหน้า (cursor) แทนโหลดทั้งหมดครั้งเดียว
// 🐛 (T064): แก้ popup ตัวกรองขั้นสูง (ย้ายออกจาก topbar) ให้เห็นครบทั้งมือถือและจอใหญ่
const CACHE_VERSION = 'miusic-pwa-v1.0.6-notify';
const STATIC_CACHE  = `${CACHE_VERSION}-static`;
const API_CACHE     = `${CACHE_VERSION}-api`;
const FONT_CACHE    = `${CACHE_VERSION}-fonts`;

/* 🆕 (T004-SEC-01): endpoints เหล่านี้มี PII — ห้าม cache เด็ดขาด
 *   ถ้า cache → shared device อาจรั่วข้อมูล user A ให้ user B
 *   (offline scenario: user A login → cache /api/customer/me body
 *    → user B เปิด browser offline → SW serve A's cached PII)
 *   รายการนี้ cover customer/admin/auth + order/payment/audit endpoints.
 */
const NEVER_CACHE_PATTERNS = [
  /^\/api\/customer\//,      // customer/me, customer/orders, customer/favorites, customer/change-password
  /^\/api\/admin\//,        // admin/customers, admin/orders, admin/password-reset-requests
  /^\/api\/auth\//,         // auth/me, auth/has-admin, auth/login, auth/logout
  /^\/api\/db\/orders\//,   // _customer-query, _customer-list, _batch-get (orders)
  /^\/api\/db\/payment-proofs/,
  /^\/api\/db\/audit-log/,
];

/* 🆕 (T004-SEC-01): ตรวจว่า URL อยู่ใน never-cache list ไหม
 *   - parse URL → ใช้ pathname match กับ NEVER_CACHE_PATTERNS
 *   - ถ้า parse ไม่ได้ → return true (safe default: ไม่ cache)
 */
function isNeverCache(url) {
  try {
    const path = new URL(url, self.location.origin).pathname;
    return NEVER_CACHE_PATTERNS.some((p) => p.test(path));
  } catch (_) {
    return true; // parse ไม่ได้ → ไม่ cache (safe default)
  }
}

/* Static assets to precache on install.
 * Query strings (e.g. style.css?v=20260930-...) are stripped by the
 * fetch handler when looking up the cache, so we precache the bare path.
 * IMPORTANT: worker/* is intentionally excluded — server-side only.
 */
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/style.css',
  '/notify.css',
  '/notify.js',
  '/app-user.js',
  '/app-cart.js',
  '/app-promotion.js',
  '/app-admin.js',
  '/customer-auth.js',
  '/auth-client.js',
  '/db-client.js',
  '/firebase-init.js',
  '/orders.js',
  '/storage-adapter.js',
  '/song-analyzer.js',
  '/thai-sort.js',
  '/admin-roles.js',
  // 🆕 (T049-B): เพิ่มไฟล์ใหม่จาก T013 + T045 — ไม่ precache จะทำให้ offline mode ไม่ทำงาน
  '/shared-utils.js',          // T013-R3: shared helpers
  '/phone-input.js',           // T045: country selector dropdown
  // 🆕 (T057): เพิ่ม privacy.html สำหรับ PDPA — ลูกค้าดู offline ได้
  '/privacy.html',             // T057: Privacy Policy page
  // 🆕 (T059): เพิ่ม idb-store.js สำหรับ PWA offline mode
  '/idb-store.js',             // T059: IndexedDB wrapper
  '/vendor/html2canvas.min.js',
  '/default-song-cover.svg',
  '/default-playlist-cover.svg',
  '/default-dj-cover.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-180.png'
];

/* ----------------------------------------------------------------- *
 *  INSTALL — precache static shell
 * ----------------------------------------------------------------- */
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(STATIC_CACHE);
    // Use addAll with per-URL error tolerance — one missing asset
    // must not abort the whole install (e.g. icon not yet deployed).
    await Promise.all(
      PRECACHE_URLS.map(async (url) => {
        try {
          // no-cache fetch so we always get fresh precache on install
          const res = await fetch(url, { cache: 'no-store' });
          if (res && res.ok) {
            await cache.put(url, res.clone());
          }
        } catch (err) {
          console.warn('[PWA] precache skip:', url, err?.message || err);
        }
      })
    );
    // Do NOT activate immediately — let activate handler clean old caches
    // and the page call skipWaiting() via message when ready.
  })());
});

/* ----------------------------------------------------------------- *
 *  ACTIVATE — purge caches from older versions + claim clients
 * ----------------------------------------------------------------- */
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((key) => !key.startsWith(CACHE_VERSION))
        .map((key) => {
          console.info('[PWA] deleting old cache:', key);
          return caches.delete(key);
        })
    );
    // Take control of all open clients immediately so the new SW
    // is in charge right after activation (no reload needed).
    await self.clients.claim();
  })());
});

/* ----------------------------------------------------------------- *
 *  MESSAGE — support skipWaiting trigger from page
 *           + CLEAR_API_CACHE (T004-SEC-01): รับ message จาก client
 *           ให้ล้าง API cache (ใช้ตอน logout กัน PII leak ข้าม session)
 * ----------------------------------------------------------------- */
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }
  // 🆕 (T004-SEC-01): client สั่งล้าง API cache (เรียกจาก customerLogout)
  if (event.data === 'CLEAR_API_CACHE') {
    caches.keys().then((names) => {
      return Promise.all(
        names.map((name) => {
          if (name.includes('api')) {
            console.info('[PWA] clearing API cache:', name);
            return caches.delete(name);
          }
          return undefined;
        })
      );
    }).then(() => {
      // แจ้ง client ว่าล้างแล้ว (client อาจ refresh หน้าถ้าต้องการ)
      if (event.source && event.source.postMessage) {
        event.source.postMessage('API_CACHE_CLEARED');
      }
    }).catch((err) => {
      console.warn('[PWA] CLEAR_API_CACHE error:', err);
    });
  }
});

/* ----------------------------------------------------------------- *
 *  HELPERS
 * ----------------------------------------------------------------- */

function isStaticAsset(url) {
  // Static assets live at the origin root (HTML/CSS/JS/PNG/SVG/JSON).
  // Exclude /api/* (dynamic) and worker/* (server-side, never cached).
  if (url.pathname.startsWith('/api/')) return false;
  if (url.pathname.startsWith('/worker/')) return false;
  return /\.(?:html?|css|js|png|jpe?g|gif|webp|svg|json|woff2?)$/i.test(url.pathname)
      || url.pathname === '/';
}

function isApiRequest(url) {
  return url.pathname.startsWith('/api/');
}

function isGoogleFont(url) {
  return url.hostname === 'fonts.googleapis.com'
      || url.hostname === 'fonts.gstatic.com';
}

/* Strip query string for static-asset cache keys so that
 * style.css?v=20260930 and style.css share the same cache entry. */
function cacheKeyFor(url) {
  return url.origin + url.pathname;
}

/* Stale-while-revalidate: serve from cache, refresh in background. */
async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const networkFetch = fetch(request).then((res) => {
    if (res && res.ok) {
      cache.put(request, res.clone()).catch(() => {});
    }
    return res;
  }).catch(() => cached);
  return cached || networkFetch;
}

/* Cache-first: serve from cache, fall back to network + cache the result. */
async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const key = cacheKeyFor(new URL(request.url));
  const cached = await cache.match(key) || await cache.match(request);
  if (cached) return cached;
  try {
    const res = await fetch(request);
    if (res && res.ok) {
      cache.put(key, res.clone()).catch(() => {});
    }
    return res;
  } catch (err) {
    // Last-resort: app shell so the UI doesn't show browser offline page.
    const fallback = await cache.match('/index.html') || await cache.match('/');
    if (fallback) return fallback;
    throw err;
  }
}

/* 🆕 (T004-SEC-01): Network-first พร้อม never-cache list
 *   - ลอง network ก่อน
 *   - cache response เฉพาะ res.ok + GET + ไม่ใช่ never-cache endpoint
 *   - ถ้า network fail → fallback cache เฉพาะถ้าไม่ใช่ never-cache
 *     (never-cache endpoint ไม่ serve offline cache เพื่อกัน PII leak)
 */
async function networkFirst(request, cacheName) {
  const neverCache = isNeverCache(request.url);
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(request);
    // Cache ONLY successful GET responses that are NOT in never-cache list.
    // (POST/PUT/DELETE already filtered out before this function.)
    if (res && res.ok && !neverCache) {
      cache.put(request, res.clone()).catch(() => {});
    }
    return res;
  } catch (err) {
    // never-cache endpoints ไม่ fallback ไป cache (กัน PII leak ข้าม session)
    if (!neverCache) {
      const cached = await cache.match(request);
      if (cached) return cached;
    }
    throw err;
  }
}

/* ----------------------------------------------------------------- *
 *  FETCH — strategy router
 * ----------------------------------------------------------------- */
self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Only handle GET. POST/PUT/DELETE go straight to network
  // (payments, order mutations, auth) — never intercept or cache.
  if (req.method !== 'GET') return;

  let url;
  try {
    url = new URL(req.url);
  } catch (_) {
    return; // malformed URL — let browser handle
  }

  // Same-origin routing
  if (url.origin === self.location.origin) {
    if (isApiRequest(url)) {
      // /api/* → network-first (cache fallback offline).
      // GET only (POST/PUT/DELETE already returned above).
      event.respondWith(networkFirst(req, API_CACHE));
      return;
    }
    if (isStaticAsset(url)) {
      event.respondWith(cacheFirst(req, STATIC_CACHE));
      return;
    }
    // Other same-origin GETs (e.g. navigation to /admin.html): cache-first.
    event.respondWith(cacheFirst(req, STATIC_CACHE));
    return;
  }

  // Cross-origin: Google Fonts → stale-while-revalidate
  if (isGoogleFont(url)) {
    event.respondWith(staleWhileRevalidate(req, FONT_CACHE));
    return;
  }

  // All other cross-origin requests (e.g. R2 cover art, analytics):
  // do NOT intercept — let browser handle natively. This avoids
  // caching opaque responses we cannot validate.
});
