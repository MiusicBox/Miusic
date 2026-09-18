// orders.js — ระบบจัดการออเดอร์ (เชื่อมกับ Cloudflare D1 จริงของเว็บ Music Store)
// ใช้ collection "songs" ที่มีอยู่แล้วเป็นแหล่งข้อมูลเพลง/ราคา
// และสร้าง collection ใหม่ชื่อ "orders" สำหรับเก็บออเดอร์
// ===================================================
import { db } from "./firebase-init.js?v=20260905-fix1";
import {
  collection, getDocs, getDoc, setDoc, query, orderBy, where, doc, updateDoc, deleteDoc,
  // 🔧 (2026-09-17 Phase 2): เพิ่ม getDocsByIds สำหรับ batch fetch songs (ลด HTTP requests + Worker invocations)
  getDocsByIds
} from "./db-client.js?v=20260917-polling-fix";
import { uploadOrderZip, deleteFromStorage } from "./storage-adapter.js?v=20260904-rawzip";
// ===== ลดราคา + โปรโมชั่น (ระบบใหม่) — import มาจาก app-promotion.js กลาง (รวมไฟล์เดียว) =====
import {
  fetchActiveDiscounts, fetchActivePromotions, computeCartPricing
} from "./app-promotion.js?v=20261101-promo1";

/* ---------------- สถานะออเดอร์ (4 สถานะ) ---------------- */
const STATUS_ORDER = ["pending_verify", "processing", "completed", "cancelled"];
const STATUS_CONFIG = {
  pending_verify: { emoji: "🟡", label: "รอตรวจสอบการโอน", color: "#F5B400", bg: "rgba(245,180,0,.15)" },
  processing:     { emoji: "🔵", label: "ชำระเงินแล้ว - กำลังส่งเพลง", color: "#3B9EFF", bg: "rgba(59,158,255,.15)" },
  completed:      { emoji: "🟢", label: "สำเร็จ", color: "var(--success)", bg: "rgba(41,204,113,.15)" },
  cancelled:      { emoji: "🔴", label: "ยกเลิก", color: "var(--danger)", bg: "rgba(255,107,107,.15)" },
};

function escapeHtml(str) {
  return String(str == null ? "" : str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
// Safari (และเบราว์เซอร์มือถือส่วนใหญ่) เมิน HTML `download` attribute สำหรับลิงก์ข้ามโดเมน
// เลยเปิดไฟล์เสียง/วิดีโอด้วยเครื่องเล่นในตัวแทนที่จะดาวน์โหลดให้ — ต้องสั่ง Cloudinary ให้ส่งไฟล์
// แบบ Content-Disposition: attachment โดยแทรก fl_attachment เข้าไปใน URL แทน
function toCloudinaryDownloadUrl(url) {
  if (!url || typeof url !== "string") return url;
  const marker = "/upload/";
  const idx = url.indexOf(marker);
  if (idx === -1) return url; // ไม่ใช่ URL รูปแบบ Cloudinary มาตรฐาน ปล่อยผ่านไม่แตะต้อง
  if (url.includes("/fl_attachment")) return url; // ใส่ไปแล้ว ไม่ใส่ซ้ำ
  return url.slice(0, idx + marker.length) + "fl_attachment/" + url.slice(idx + marker.length);
}

// 🔒 R2 CORS Bypass (2026-09-12): แปลง R2 public URL ให้เป็น Worker proxy URL
// ใช้ตอนฝั่งแอดมิน fetch ไฟล์เพลงเพื่อสร้าง ZIP — แทน fetch() ตรงจาก R2 public URL
// ที่อาจโดน CORS block (เพราะ R2 pub-*.r2.dev ไม่ได้ตั้ง CORS headers ไว้)
// Worker proxy อ่านไฟล์จาก R2 binding ตรงๆ (เร็ว) แล้วส่งกลับเป็น blob พร้อม CORS headers
// ถ้าไม่ใช่ R2 URL (เช่น Cloudinary เก่า) จะปล่อยผ่านไม่แตะต้อง
function r2UrlToProxyUrl(url) {
  if (!url || typeof url !== "string") return url;
  // ตรวจจาก pattern "pub-xxx.r2.dev" ที่เป็น R2 public URL มาตรฐาน
  // หรือตรวจจากโดเมนเดียวกับเว็บเรา (ถ้าใช้ custom domain R2)
  const r2Pattern = /^https?:\/\/pub-[a-z0-9]+\.r2\.dev\//i;
  if (!r2Pattern.test(url)) return url; // ไม่ใช่ R2 public URL — ปล่อยผ่าน
  // ตัด prefix ออก เหลือแค่ key (รวม subfolder ถ้ามี)
  // ตัวอย่าง: https://pub-xxx.r2.dev/full-songs/123-abc.wav → /api/file/full-songs/123-abc.wav
  const key = url.replace(r2Pattern, "");
  // อย่าลืม decode URI components ที่อาจจะ encode อยู่ใน URL แล้วเข้ารหัสใหม่สำหรับ path
  // แต่เนื่องจาก Worker จะ decodeURIComponent อีกที ให้ส่งเป็น encoded path ไปเลย
  return "/api/file/" + key;
}
function formatLAK(v) { return Number(v || 0).toLocaleString("en-US") + " LAK"; }

// 🔧 แก้บั๊ก (2026-09-18): normalize เบอร์ Laos ให้เป็นมาตรฐานเดียวก่อนเก็บลง DB
// -----------------------------------------------------------
// ปัญหา: แอดมินสร้าง/แก้ไขออเดอร์ฝั่ง admin → เก็บเบอร์ตามที่กรอก ซึ่งอาจเป็น "+85620..." / "020..." / "20..."
//   → DB เก็บหลายรูปแบบ → ลูกค้า track order ไม่เจอ (query-time normalize ก็ยังต้องการความสอดคล้อง)
//
// วิธีแก้: normalize ทุกรูปแบบให้เป็น "20XXXXXXXX" ก่อนเก็บลง DB (เหมือนฝั่ง app-cart.js)
//   - strip country code Laos (+856 / 856) ออก
//   - strip "0" นำหน้าออก
//
// สอดคล้องกับ normalizePhoneForStorage ใน app-cart.js + normalizePhoneServer ใน worker/index.js
//   + normalizePhone ใน app-user.js / app-promotion.js (ที่แก้ใน Bug C5)
//
// ผลกระทบต่อระบบเดิม: 0% — เบอร์ที่แสดงในใบเสร็จ/WhatsApp message ยังเก็บรูปแบบเดิมใน UI
//   แค่เปลี่ยนค่าที่เก็บใน field "whatsapp" ของ order document ใน DB
function normalizePhoneForStorage(v) {
  let s = String(v || "").replace(/[^0-9]/g, "");
  if (s.startsWith("856")) s = s.slice(3);
  if (s.startsWith("0")) s = s.replace(/^0+/, "");
  return s;
}

// เปิดแชท WhatsApp ไปหาเบอร์ที่ระบุ (รูปแบบเดียวกับ buildWhatsAppLink ใน app-user.js/app-cart.js)
function buildWhatsAppLink(number, text) {
  const clean = String(number || "").replace(/[^0-9]/g, "");
  return "https://wa.me/" + clean + (text ? "?text=" + encodeURIComponent(text) : "");
}
function debounce(fn, wait) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), wait); }; }
// แอดมินย่อยทำได้ทุกอย่างในหน้าออเดอร์ตามปกติ ยกเว้นลบประวัติออเดอร์ (สงวนไว้ให้แอดมินหลักเท่านั้น)
// role ถูกตั้งค่าไว้ที่ window.__currentAdminRole โดย app-admin.js ตอนล็อกอินสำเร็จ
function isMainAdmin() { return window.__currentAdminRole === "main"; }
// ชื่อฟิลด์จริงใน Firestore คือ playlist_name แต่รองรับข้อมูลเก่าที่อาจใช้ name ด้วย
function getPlaylistName(playlist) {
  return String(playlist?.playlist_name ?? playlist?.name ?? "");
}

// งานสร้าง ZIP ถูกกันซ้ำไว้ในหน้านี้ เพื่อไม่ให้ออเดอร์เดียวกันถูกสร้างหลายไฟล์
// หาก Admin เปิด/กดซ้ำระหว่างที่กำลังดาวน์โหลด WAV จาก Cloud
const zipJobs = new Set();
let jsZipModulePromise = null;

async function loadJSZip() {
  if (!jsZipModulePromise) {
    jsZipModulePromise = import("https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm")
      .then((module) => module.default || module);
  }
  return jsZipModulePromise;
}

function orderToast(message, type = "") {
  if (window.__showToast) window.__showToast(message, type);
  else if (type === "error") alert(message);
}

function getOrderPlaylistIds(order) {
  const ids = [];
  if (order?.playlist_id) ids.push(String(order.playlist_id));
  if (Array.isArray(order?.playlist_ids)) {
    order.playlist_ids.forEach((id) => id && ids.push(String(id)));
  }
  if (Array.isArray(order?.playlists)) {
    order.playlists.forEach((playlist) => {
      const id = typeof playlist === "string"
        ? playlist
        : (playlist?.id || playlist?.playlist_id);
      if (id) ids.push(String(id));
    });
  }
  if (typeof order?.playlist === "string") {
    ids.push(String(order.playlist));
  } else if (order?.playlist?.id || order?.playlist?.playlist_id) {
    ids.push(String(order.playlist.id || order.playlist.playlist_id));
  }
  return [...new Set(ids)];
}

/*
 * รวมเพลงจากทั้ง items ของออเดอร์และ playlist ที่อ้างถึง
 * รองรับข้อมูลเก่า (playlist songs ถูก snapshot ไว้ใน items) และข้อมูลที่มี
 * เพลงเดี่ยว + playlist ในออเดอร์เดียวกัน โดยไม่แก้ข้อมูลเดิม
 */
async function resolveOrderSongs(order) {
  const songMap = new Map();
  (order?.items || []).forEach((item) => {
    if (!item?.song_id) return;
    songMap.set(String(item.song_id), {
      id: String(item.song_id),
      title: item.title || "เพลง",
    });
  });

  const playlistIds = getOrderPlaylistIds(order);
  const playlistSnaps = await Promise.all(
    playlistIds.map((playlistId) =>
      getDocs(query(collection(db, "songs"), where("playlist_id", "==", playlistId)))
    )
  );
  playlistSnaps.forEach((snap) => {
    snap.docs.forEach((songDoc) => {
      const song = songDoc.data();
      if (!songMap.has(songDoc.id)) {
        songMap.set(songDoc.id, { id: songDoc.id, title: song.song_name || "เพลง" });
      }
    });
  });

  return [...songMap.values()];
}

// 🔧 (2026-09-16): Helper ใหม่สำหรับจัดกลุ่มเพลงในออเดอร์แยกตาม playlist
// ใช้ใน createOrderZip เพื่อสร้าง folder แยกให้แต่ละ playlist (เพลงเดี่ยวอยู่ที่ root, เพลง playlist อยู่ใน folder ชื่อ playlist)
// return { singles: [{id, title}], playlists: [{id, name, songs: [{id, title}]}] }
// 
// Logic การจัดกลุ่มตาม order.order_type:
//   - "single"   → ทุก item ใน order.items เป็นเพลงเดี่ยว (singles)
//   - "playlist" → ทุก item ใน order.items อยู่ใน playlist เดียว (ใช้ order.playlist_id/playlist_name)
//   - "mixed"    → items มี kind แยก ("song" = single, "playlist" = playlist group มี song_ids snapshot)
//                  ถ้า playlist ไม่มี song_ids snapshot (order เก่า) → query จาก playlist_id เอง
async function resolveOrderSongsGrouped(order) {
  const singles = [];
  const playlistMap = new Map(); // playlist_id → { id, name, songs: [] }

  // Helper: ดึงหรือสร้าง playlist group ใน map
  function getOrCreatePlaylist(playlistId, playlistName) {
    const key = String(playlistId || "");
    if (!playlistMap.has(key)) {
      playlistMap.set(key, {
        id: key,
        name: String(playlistName || `Playlist-${key.slice(-6)}`),
        songs: [],
      });
    }
    return playlistMap.get(key);
  }

  // วน items ตาม order_type
  (order?.items || []).forEach((item) => {
    if (!item) return;

    if (order.order_type === "playlist") {
      // ทุก item อยู่ใน playlist เดียว (order.playlist_id)
      const group = getOrCreatePlaylist(order.playlist_id, order.playlist_name);
      if (item.song_id) {
        group.songs.push({
          id: String(item.song_id),
          title: item.title || "เพลง",
        });
      }
    } else if (order.order_type === "mixed") {
      // items มี kind แยก — "song" = single, "playlist" = playlist group
      if (item.kind === "playlist") {
        const group = getOrCreatePlaylist(item.playlist_id, item.title);
        // เพิ่มเพลงจาก song_ids snapshot (mixed items เก็บ song_ids ไว้ตอนสั่ง)
        (item.song_ids || []).forEach((sid) => {
          if (sid) group.songs.push({ id: String(sid), title: "" });
        });
      } else if (item.song_id) {
        // item.kind === "song" หรือไม่ระบุ kind → single
        singles.push({
          id: String(item.song_id),
          title: item.title || "เพลง",
        });
      }
    } else {
      // order_type === "single" หรือไม่ระบุ → ทุก item เป็น single
      if (item.song_id) {
        singles.push({
          id: String(item.song_id),
          title: item.title || "เพลง",
        });
      }
    }
  });

  // สำหรับ playlist groups ที่ไม่มี song_ids snapshot (order เก่า หรือ playlist ที่ยังไม่ได้ fill)
  // → query เพิ่มจาก playlist_id เพื่อดึงรายชื่อเพลงใน playlist นั้น
  for (const [playlistId, group] of playlistMap) {
    if (group.songs.length === 0 && playlistId) {
      try {
        const songsSnap = await getDocs(query(collection(db, "songs"), where("playlist_id", "==", playlistId)));
        songsSnap.docs.forEach((songDoc) => {
          const song = songDoc.data();
          group.songs.push({
            id: songDoc.id,
            title: song.song_name || "เพลง",
          });
        });
      } catch (err) {
        // query ล้มเหลว → ปล่อยให้ group มี songs ว่าง (createOrderZip จะ throw error ตอนนั้น)
        console.warn(`resolveOrderSongsGrouped: query songs ของ playlist "${playlistId}" ล้มเหลว:`, err?.message || err);
      }
    } else if (group.songs.length > 0 && !group.songs[0].title) {
      // มี song_ids แต่ไม่มี title (กรณี mixed) → query ดึง title ของแต่ละเพลง
      const songIds = group.songs.map((s) => s.id);
      const songDocs = await Promise.all(
        songIds.map((sid) => getDoc(doc(db, "songs", sid)).catch(() => null))
      );
      group.songs = songDocs.map((snap, i) => ({
        id: songIds[i],
        title: (snap && snap.exists()) ? (snap.data().song_name || "เพลง") : `เพลง ${i + 1}`,
      }));
    }
  }

  return {
    singles,
    playlists: [...playlistMap.values()],
  };
}

// ⚠️ สำคัญมาก — ห้ามแก้ให้บังคับเป็น .wav เพียงอย่างเดียวอีก
// ไฟล์เพลงเต็มรองรับทั้ง .wav และ .mp3 (ดู app-admin.js: เงื่อนไข isWav/isMp3)
// ถ้าบังคับเติม ".wav" ต่อท้ายไฟล์ที่เป็น .mp3 อยู่แล้ว จะได้ไฟล์ผิดนามสกุลซ้อน
// (เช่น "เพลง.mp3.wav" ที่เนื้อไฟล์จริงเป็น mp3) ทำให้ลูกค้าเปิด/เล่นไฟล์ในZIP ไม่เสถียร
// หรือเปิดไม่ได้เลยในบางเครื่องเล่น — นี่คือสาเหตุของบั๊ก "เพลงเต็ม mp3 ไม่เสถียร" ที่เคยเจอ
// กติกา: ถ้าชื่อไฟล์มีนามสกุล .wav หรือ .mp3 อยู่แล้ว ให้คงไว้เป๊ะๆ ไม่แตะต้อง
// จะ fallback เป็น .wav ก็ต่อเมื่อไม่มีนามสกุลที่รู้จักมาให้เลย (ข้อมูลเก่า/ไม่มีข้อมูล) เท่านั้น
function safeZipFileName(value, fallback) {
  const cleaned = String(value || fallback || "เพลง.wav")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return /\.(wav|mp3)$/i.test(cleaned) ? cleaned : `${cleaned}.wav`;
}

function uniqueZipFileName(value, usedNames) {
  const original = safeZipFileName(value, "เพลง.wav");
  if (!usedNames.has(original)) {
    usedNames.add(original);
    return original;
  }
  const dot = original.lastIndexOf(".");
  const base = dot > 0 ? original.slice(0, dot) : original;
  const ext = dot > 0 ? original.slice(dot) : ".wav";
  let index = 2;
  let candidate = `${base} (${index})${ext}`;
  while (usedNames.has(candidate)) {
    index += 1;
    candidate = `${base} (${index})${ext}`;
  }
  usedNames.add(candidate);
  return candidate;
}

/*
 * ดาวน์โหลด WAV เต็มจาก Cloud แล้วสร้าง ZIP ก่อนจึงค่อยอัปโหลด ZIP กลับขึ้น Cloud
 * จุดสำคัญ: อ่านเฉพาะ full_file_url ของเพลง ไม่แตะ preview_url/ไฟล์ตัวอย่าง
 */
async function createOrderZip(orderId) {
  if (zipJobs.has(orderId)) return { ok: false, error: "กำลังสร้าง ZIP ของออเดอร์นี้อยู่" };
  const order = state.allOrders.find((item) => item.id === orderId);
  if (!order) return { ok: false, error: "ไม่พบออเดอร์นี้" };

  // ถ้ามี ZIP ที่สร้างสำเร็จแล้ว ใช้ลิงก์เดิมได้ ไม่สร้างไฟล์ซ้ำโดยไม่จำเป็น
  if (order.zip_status === "ready" && order.zip_download_url) {
    return { ok: true, url: order.zip_download_url };
  }

  zipJobs.add(orderId);
  const zipFileName = `Order-${orderId}.zip`;
  try {
    await updateDoc(doc(db, "orders", orderId), {
      zip_status: "preparing",
      zip_error: "",
      zip_requested_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const orderSongsGrouped = await resolveOrderSongsGrouped(order);
    const totalSongs = orderSongsGrouped.singles.length
      + orderSongsGrouped.playlists.reduce((sum, p) => sum + p.songs.length, 0);
    if (totalSongs === 0) {
      throw new Error("ออเดอร์นี้ไม่มีรายการเพลงสำหรับสร้าง ZIP");
    }

    // 🔧 (2026-09-17 Phase 2): Pre-fetch ทุกเพลงในครั้งเดียวแบบ batch
    //   เดิม: แต่ละเพลงยิง getDoc ทีละอัน = N HTTP requests = N Worker invocations (ช้า)
    //   ใหม่: ยิง batch endpoint ครั้งเดียว = 1 HTTP request = 1 Worker invocation (เร็วขึ้นมาก)
    //   D1 rows read เท่าเดิม แต่ลด Worker invocations และ latency อย่างมาก
    const allSongIds = [
      ...orderSongsGrouped.singles.map(s => s.id),
      ...orderSongsGrouped.playlists.flatMap(p => p.songs.map(s => s.id)),
    ];
    let songSnapMap = new Map();
    if (allSongIds.length > 0) {
      try {
        songSnapMap = await getDocsByIds("songs", allSongIds);
      } catch (err) {
        // fallback: ถ้า batch endpoint พัง → ใช้ getDoc ทีละอันเหมือนเดิม (เก็บเป็น Map ว่าง → addSongToZip จะยิง getDoc เอง)
        console.warn("createOrderZip: batch getDocsByIds failed, falling back to per-song getDoc", err?.message || err);
      }
    }

    const JSZip = await loadJSZip();
    const zip = new JSZip();
    // usedNames แยกสำหรับ root และแต่ละ playlist folder เพื่อกันชื่อไฟล์ซ้ำกันภายใน path เดียวกัน
    const rootUsedNames = new Set();
    let songIndex = 0;

    // ===== Helper: ดึงไฟล์เพลงจาก R2 + เพิ่มลง ZIP ใน path ที่กำหนด =====
    // folderPath = "" → ใส่ที่ root (เพลงเดี่ยว)
    // folderPath = "PlaylistName" → ใส่ใน folder ของ playlist (เพลง playlist)
    // usedNames = Set สำหรับ track ชื่อไฟล์ที่ใช้แล้วใน path นั้น เพื่อ unique ชื่อไฟล์
    // 🔧 (2026-09-17 Phase 2): ใช้ songSnapMap (pre-fetched) ถ้ามี แทนการยิง getDoc ทีละอัน
    async function addSongToZip(songId, songTitle, folderPath, usedNames) {
      songIndex += 1;
      // 🔧 (2026-09-17 Phase 2): ใช้ cache จาก batch fetch ก่อน ถ้ามี
      let songSnap = songSnapMap.get(songId);
      if (!songSnap) {
        // fallback: ถ้า batch fetch พัง หรือ id ไม่อยู่ใน cache → ยิง getDoc ทีละอันเหมือนเดิม
        songSnap = await getDoc(doc(db, "songs", songId));
      }
      if (!songSnap.exists()) {
        throw new Error(`ไม่พบข้อมูลเพลง "${songTitle || songId}"`);
      }
      const song = songSnap.data();
      // 🔒 Shared-file (Lazy-shared): ถ้าไม่มี full_file_url ให้ fallback ใช้ file_url แทน
      // เพราะเพลงใหม่บางเพลงใช้ไฟล์เดียวกันทั้งตอน preview และตอนส่งลูกค้า เพื่อประหยัดพื้นที่ R2
      // ถ้าไม่มีทั้งคู่ถึงจะ throw error เหมือนเดิม
      const songFileUrl = song.full_file_url || song.file_url;
      if (!songFileUrl) {
        throw new Error(`เพลง "${song.song_name || songTitle}" ยังไม่มีไฟล์เต็ม WAV บน Cloud (ไม่มีทั้ง full_file_url และ file_url)`);
      }

      // 🔒 R2 CORS Bypass (2026-09-12): แปลง R2 public URL ให้เป็น Worker proxy URL
      // กันโดน CORS block ตอน fetch ไฟล์เพลงมาสร้าง ZIP (R2 pub-*.r2.dev ไม่ได้ตั้ง CORS headers)
      // ถ้าเป็น Cloudinary URL เก่า จะปล่อยผ่านไม่แตะต้อง
      const fetchUrl = r2UrlToProxyUrl(songFileUrl);

      // คำนวณตำแหน่งปัจจุบันสำหรับ toast
      const displayPath = folderPath ? ` (ในโฟลเดอร์ ${folderPath})` : "";
      orderToast(`กำลังดึง WAV ${songIndex}/${totalSongs}${displayPath}...`, "progress");
      let response;
      try {
        response = await fetch(fetchUrl, {
          credentials: "same-origin", // ส่งคุกกี้ session ไปด้วย (Worker proxy ต้องการ admin session)
          cache: "no-store",
        });
      } catch (fetchErr) {
        // ถ้า fetch ล้มเหลวด้วย network/CORS error — ให้ข้อความชัดเจน
        const reason = fetchErr?.name === "TypeError" ? "CORS/Network" : (fetchErr?.name || "Unknown");
        throw new Error(
          `ดึงไฟล์ WAV ของเพลง "${song.song_name || songTitle}" ไม่สำเร็จ (${reason}) — ` +
          `ลอง refresh หน้าเว็บแล้วลองใหม่ หรือติดต่อผู้ดูแลระบบ`
        );
      }
      if (!response.ok) {
        let errDetail = `HTTP ${response.status}`;
        try {
          const errBody = await response.text();
          if (errBody) errDetail += `: ${errBody.slice(0, 200)}`;
        } catch (_) {}
        throw new Error(
          `ดึงไฟล์ WAV ของเพลง "${song.song_name || songTitle}" ไม่สำเร็จ (${errDetail}) — ` +
          `${response.status === 401 ? "กรุณาล็อกอินแอดมินใหม่" : response.status === 404 ? "ไม่พบไฟล์ใน R2" : "ลองอีกครั้ง"}`
        );
      }
      const wavBlob = await response.blob();
      // ใช้ชื่อไฟล์เต็มถ้ามี ไม่งั้น derive จาก file_url + ชื่อเพลง
      // uniqueZipFileName จะตรวจชื่อซ้ำใน usedNames แล้วเพิ่ม (2) (3) ต่อท้ายถ้าจำเป็น
      const baseName = uniqueZipFileName(
        song.full_file_name || `${song.song_name || songTitle}.wav`,
        usedNames
      );
      const entryName = folderPath ? `${folderPath}/${baseName}` : baseName;
      zip.file(entryName, wavBlob);
    }

    // ===== 1. ใส่เพลงเดี่ยวที่ root ของ ZIP (เหมือนเดิม — ไม่สร้าง folder) =====
    for (const single of orderSongsGrouped.singles) {
      await addSongToZip(single.id, single.title, "", rootUsedNames);
    }

    // ===== 2. ใส่เพลง playlist แยก folder ชื่อตาม playlist =====
    // 🔧 (2026-09-16): แต่ละ playlist สร้าง folder ของตัวเอง — ทุกเพลงใน playlist อยู่ใน folder นั้น
    // ถ้ามีหลาย playlist → มีหลาย folder (แต่อยู่ใน ZIP ไฟล์เดียวกัน)
    // ถ้าชื่อ playlist มีอักขระต้องห้ามใน OS (\/:*?"<>|) → แทนด้วย _ เพื่อกัน error ตอนแตก ZIP
    for (const playlist of orderSongsGrouped.playlists) {
      const rawFolderName = String(playlist.name || `Playlist-${playlist.id.slice(-6)}`).trim();
      const safeFolderName = rawFolderName.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").trim() || `Playlist-${playlist.id.slice(-6)}`;
      // usedNames สำหรับ folder นี้ (แยกจาก root และ folder อื่น) → กันชื่อไฟล์ซ้ำกันใน folder เดียวกัน
      const folderUsedNames = new Set();
      for (const songItem of playlist.songs) {
        await addSongToZip(songItem.id, songItem.title, safeFolderName, folderUsedNames);
      }
    }

    orderToast("กำลังบีบอัดไฟล์ WAV เป็น ZIP...", "progress");
    const zipBlob = await zip.generateAsync(
      { type: "blob", compression: "STORE" },
      (metadata) => orderToast(`กำลังสร้าง ZIP... ${Math.round(metadata.percent)}%`, "progress")
    );
    const zipFile = new File([zipBlob], zipFileName, { type: "application/zip" });

    orderToast("กำลังอัปโหลด ZIP ขึ้น Cloud...", "progress");
    const uploadResult = await uploadOrderZip(
      zipFile,
      (percent) => orderToast(`กำลังอัปโหลด ZIP... ${percent}%`, "progress")
    );
    if (!uploadResult?.url) {
      throw new Error("Cloud ไม่ส่ง Download Link กลับมา");
    }

    const downloadUrl = toCloudinaryDownloadUrl(uploadResult.url);
    // บันทึกลิงก์หลังอัปโหลดสำเร็จเท่านั้น
    await updateDoc(doc(db, "orders", orderId), {
      zip_status: "ready",
      zip_download_url: downloadUrl,
      zip_file_name: zipFileName,
      zip_public_id: uploadResult.publicId || "",
      zip_song_count: totalSongs, // 🔧 (2026-09-16): ใช้ totalSongs (รวมเพลงเดี่ยว + ทุกเพลงใน playlist) แทน orderSongs.length ที่ถูกลบไปแล้วตอน refactor
      zip_created_at: new Date().toISOString(),
      zip_error: "",
      updated_at: new Date().toISOString(),
    });
    return { ok: true, url: downloadUrl };
  } catch (err) {
    const errorMessage = err?.message || String(err);
    // ถ้าเกิดข้อผิดพลาด ให้คงสถานะออเดอร์เดิมไว้และไม่บันทึกลิงก์
    try {
      await updateDoc(doc(db, "orders", orderId), {
        zip_status: "failed",
        zip_error: errorMessage,
        zip_download_url: "",
        zip_file_name: "",
        updated_at: new Date().toISOString(),
      });
    } catch (statusError) {
      console.error("บันทึกสถานะ ZIP ไม่สำเร็จ:", statusError);
    }
    return { ok: false, error: errorMessage };
  } finally {
    zipJobs.delete(orderId);
  }
}

function getReceiptNumber(orderId, createdAt) {
  const date = new Date(createdAt || Date.now());
  const ymd = Number.isNaN(date.getTime())
    ? "00000000"
    : [
        date.getFullYear(),
        String(date.getMonth() + 1).padStart(2, "0"),
        String(date.getDate()).padStart(2, "0"),
      ].join("");
  return `RCPT-${ymd}-${String(orderId || "000000").slice(-6).toUpperCase()}`;
}

const state = {
  songs: [],        // เพลงทั้งหมดที่ไม่ได้ถูกซ่อน (status !== "hidden") จาก collection "songs"
  playlists: [],     // เพลย์ลิสต์ที่ตั้งราคาเหมาไว้แล้ว จาก collection "playlists"
  searchResults: [],
  // ---- ตะกร้าออเดอร์ที่กำลังกรอก (รองรับผสม): แต่ละรายการเป็น
  //   เพลงเดี่ยว   { kind: "song",     songId, title, price }
  //   เพลย์ลิสต์   { kind: "playlist", playlistId, title, price, songs: [{songId,title,price}] }
  // เลือกได้ทั้งเพลงหลายเพลง + เพลย์ลิสต์หลายรายการพร้อมกันในออเดอร์เดียว
  cartEntries: [],
  allOrders: [],      // แคชออเดอร์ล่าสุดที่โหลดมา (ใช้กรองสถานะโดยไม่ต้องโหลดซ้ำ)
  historyFilter: "all", // สถานะที่กำลังกรองดูในประวัติออเดอร์
  historySearch: "",    // คำค้นหาในประวัติออเดอร์ (ค้นจาก ชื่อลูกค้า/เบอร์/ชื่อเพลง/เพลย์ลิสต์/เลขออเดอร์/ชื่อ ZIP)
  listenersBound: false, // กันการผูก event ซ้ำเมื่อเปิดหน้านี้หลายครั้ง

  playlistSearchResults: [],

  // ---- สถานะสำหรับโหมดแก้ไขออเดอร์ (modal) ----
  editingOrderId: null,   // id ของออเดอร์ที่กำลังแก้ไขอยู่ (null = ไม่ได้เปิด modal)
  editCartEntries: [],    // ตะกร้าของ modal แก้ไข (โครงสร้างเดียวกับ cartEntries ด้านบน)
  editSearchResults: [],  // ผลค้นหาเพลงใน modal แก้ไข
  editPlaylistSearchResults: [],

  // ---- ธงบอกว่า "ยอดรวม" ถูกผู้ใช้แก้ไขเองหรือไม่ ----
  // true = ใช้ค่าที่ผู้ใช้พิมพ์เอง, false = คำนวณอัตโนมัติจากราคาเพลง/เพลย์ลิสต์ในตะกร้า
  cartTotalEdited: false,     // สำหรับฟอร์มสร้างออเดอร์ใหม่
  editCartTotalEdited: false, // สำหรับ modal แก้ไขออเดอร์
  storeName: "Music Store",
};

/* ---------------- โหลดเพลงจริงจาก Firestore ----------------
   หมายเหตุ (แก้ไข 2026-09): เดิมใช้ where("status","==","active") กรองฝั่ง Firestore ซึ่งต้องตรงคำเป๊ะๆ
   ทำให้เพลงที่ status ไม่ตรงคำว่า "active" แบบเป๊ะ (พิมพ์ใหญ่-เล็กไม่ตรง/มีช่องว่างเกิน/ไม่มีฟิลด์นี้จากข้อมูลเก่า)
   หายไปจากช่องค้นหาตอนสร้างออเดอร์แบบไม่มี error ให้เห็น ทั้งที่หน้าเว็บลูกค้า (app-user.js) และหน้า
   "จัดการเพลง" ยังเห็นเพลงพวกนี้ปกติ — เปลี่ยนมาโหลดเพลงทั้งหมดแล้วกรองฝั่ง client แบบเดียวกับ app-user.js
   (ตัดออกเฉพาะที่สั่งซ่อนชัดเจนว่า "hidden" เท่านั้น) เพื่อให้ตรงกันทั้ง 3 จุดในระบบ */
async function loadSongsFromDatabase() {
  const snap = await getDocs(collection(db, "songs"));
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(s => String(s.status || "").trim().toLowerCase() !== "hidden");
}

/* ---------------- โหลดออเดอร์ทั้งหมดจาก Firestore ---------------- */
async function loadOrdersFromDatabase() {
  const q = query(collection(db, "orders"), orderBy("created_at", "desc"));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

/* ---------------- โหลดเพลย์ลิสต์จริงจาก Firestore (สำหรับขายยกเพลย์ลิสต์) ----------------
   หมายเหตุ: เอาไว้เฉพาะเพลย์ลิสต์ที่ตั้ง "ราคาเหมา" ไว้แล้ว (price > 0) เพราะถือว่าเป็นชุดที่ขายทั้งชุดได้
   เพลย์ลิสต์ที่ไม่ได้ตั้งราคา (ปล่อยว่าง/0) จะไม่โผล่ในช่องค้นหานี้ */
async function loadPlaylistsFromDatabase() {
  const snap = await getDocs(collection(db, "playlists"));
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(p => Number(p.price || 0) > 0);
}

async function loadStoreName() {
  try {
    const snap = await getDoc(doc(db, "settings", "main"));
    return snap.exists() ? String(snap.data().website_name || "Music Store") : "Music Store";
  } catch (err) {
    console.warn("โหลดชื่อร้านไม่สำเร็จ ใช้ชื่อเริ่มต้นแทน:", err);
    return "Music Store";
  }
}

/* ---------------- หาเพลงทั้งหมดที่อยู่ในเพลย์ลิสต์ที่เลือก ----------------
   อ้างอิงจากฟิลด์ playlist_id บนเอกสารเพลงแต่ละเพลง (บันทึกไว้ตอนเพิ่ม/แก้ไขเพลงในหน้า "จัดการเพลง")
   ถ้าฐานข้อมูลจริงเก็บฟิลด์นี้ชื่ออื่น ให้แก้ตรง s.playlist_id ด้านล่างนี้จุดเดียว */
function getSongsInPlaylist(playlistId) {
  return state.songs.filter((s) => s.playlist_id === playlistId);
}

/* ---------------- คำนวณ ---------------- */
function calculateCartTotal(items) {
  return items.reduce((sum, item) => sum + Number(item.price || 0), 0);
}
function calculateOrderTotal(orderType, items, playlist) {
  return orderType === "playlist" && playlist
    ? Number(playlist.price || 0)
    : calculateCartTotal(items);
}

/* ---------------- ตะกร้าแบบผสม (เพลงเดี่ยว + เพลย์ลิสต์ หลายรายการ) ----------------
   ใช้ร่วมกันทั้งฟอร์ม "สร้างออเดอร์ใหม่" และ modal "แก้ไขออเดอร์"
   entry ที่เป็นเพลง:      { kind:"song", songId, title, price }
   entry ที่เป็นเพลย์ลิสต์: { kind:"playlist", playlistId, title, price, songs:[{songId,title,price}] }
   ยอดรวม = ผลรวมราคาของทุก entry เสมอ (เพลย์ลิสต์นับราคาเหมาครั้งเดียว ไม่บวกราคาเพลงย่อยซ้ำ) */
function sumCartEntries(entries) {
  return (entries || []).reduce((sum, e) => sum + Number(e.price || 0), 0);
}

// ===== (2026-09-16): Helper สำหรับตรวจเพลงซ้ำในตะกร้าออเดอร์ =====
// ปัญหา: เดิม addToCart/selectPlaylist เช็คซ้ำแค่ในระดับเดียวกัน (เพลงเดี่ยวซ้ำ / เพลย์ลิสต์ซ้ำ)
// แต่ไม่เช็คข้ามชนิด — ทำให้เพิ่มเพลง A เดี่ยว + playlist X (ที่มีเพลง A) ได้ → เพลง A ถูกนับ 2 ครั้ง → ลูกค้าเสียเงิน 2 ครั้ง
//
// Helper 2 ตัวนี้ใช้ตรวจ "เพลงนี้มีอยู่ใน cartEntries แล้วหรือไม่ (ทั้งในรูปแบบเพลงเดี่ยวและอยู่ใน playlist)"
// คืนค่าเป็น object ที่บอกชนิดซ้ำ + ชื่อรายการที่ซ้ำ เพื่อใช้ในข้อความ toast ให้ผู้ใช้เข้าใจง่าย

// ตรวจว่า songId นี้อยู่ใน cartEntries แล้วไหม (ทั้งเพลงเดี่ยวและอยู่ใน playlist)
// คืน { duplicate: true, inKind: "song"|"playlist", inTitle: "..." } หรือ { duplicate: false }
function findSongInCartEntries(cartEntries, songId) {
  // เช็คเพลงเดี่ยวก่อน
  const asSingle = (cartEntries || []).find((e) => e.kind === "song" && (e.songId || e.song_id) === songId);
  if (asSingle) {
    return { duplicate: true, inKind: "song", inTitle: asSingle.title || "เพลงเดี่ยว" };
  }
  // เช็คใน playlist entries
  for (const e of (cartEntries || [])) {
    if (e.kind === "playlist" && Array.isArray(e.songs)) {
      const found = e.songs.find((s) => (s.songId || s.song_id) === songId);
      if (found) {
        return { duplicate: true, inKind: "playlist", inTitle: e.title || "เพลย์ลิสต์" };
      }
    }
  }
  return { duplicate: false };
}

// ตรวจเพลงหลายตัวใน playlist ว่าซ้ำกับที่อยู่ใน cartEntries ไหม
// รับ playlistSongs: array ของ { songId, title }
// คืน array ของ { songId, songTitle, inKind, inTitle } สำหรับเพลงที่ซ้ำ
function findPlaylistSongDuplicates(cartEntries, playlistSongs) {
  const dups = [];
  for (const ps of (playlistSongs || [])) {
    const songId = ps.songId || ps.song_id;
    const result = findSongInCartEntries(cartEntries, songId);
    if (result.duplicate) {
      dups.push({
        songId,
        songTitle: ps.title || "เพลง",
        inKind: result.inKind,
        inTitle: result.inTitle,
      });
    }
  }
  return dups;
}

/*
 * แปลงตะกร้าแบบผสมเป็นข้อมูลออเดอร์ที่จะบันทึกลง Firestore
 * ใช้ตรรกะเดียวกับ resolveCartFromDatabase() ใน app-cart.js เพื่อให้ order_type ที่ได้
 * เข้ากันได้กับ Dashboard/ใบเสร็จ/ระบบสร้าง ZIP ที่มีอยู่แล้วทุกจุดโดยไม่ต้องแก้ไฟล์อื่น:
 *   - มีแต่เพลงเดี่ยว                     -> "single"   (items = เพลงแต่ละรายการ)
 *   - มีเพลย์ลิสต์เดียว ไม่มีเพลงเดี่ยวปน    -> "playlist" (items = เพลงที่ขยายจากเพลย์ลิสต์นั้น)
 *   - เพลงเดี่ยว+เพลย์ลิสต์ผสมกัน หรือมีเพลย์ลิสต์มากกว่า 1 -> "mixed"
 */
function buildOrderPayloadFromEntries(entries) {
  const songEntries = (entries || []).filter((e) => e.kind === "song");
  const playlistEntries = (entries || []).filter((e) => e.kind === "playlist");
  const total = sumCartEntries(entries);

  if (playlistEntries.length === 1 && songEntries.length === 0) {
    const pl = playlistEntries[0];
    return {
      items: (pl.songs || []).map((s) => ({ song_id: s.songId, title: s.title, price: s.price })),
      total,
      order_type: "playlist",
      playlist_id: pl.playlistId,
      playlist_name: pl.title,
      playlist_ids: [],
    };
  }

  if (playlistEntries.length === 0) {
    return {
      items: songEntries.map((s) => ({ song_id: s.songId, title: s.title, price: s.price })),
      total,
      order_type: "single",
      playlist_id: null,
      playlist_name: null,
      playlist_ids: [],
    };
  }

  const songItems = songEntries.map((s) => ({ kind: "song", song_id: s.songId, title: s.title, price: s.price }));
  const playlistItems = playlistEntries.map((pl) => ({
    kind: "playlist",
    playlist_id: pl.playlistId,
    title: pl.title,
    price: pl.price,
    song_ids: (pl.songs || []).map((s) => s.songId),
    song_titles: (pl.songs || []).map((s) => s.title),
  }));
  return {
    items: [...songItems, ...playlistItems],
    total,
    order_type: "mixed",
    playlist_id: null,
    playlist_name: null,
    playlist_ids: playlistEntries.map((pl) => pl.playlistId),
  };
}

/*
 * แปลงข้อมูลออเดอร์เดิม (ทุกรูปแบบ: single/playlist/mixed รวมถึงออเดอร์เก่าที่ไม่มี order_type)
 * กลับเป็นตะกร้าแบบผสม เพื่อโหลดเข้า modal แก้ไขออเดอร์ — ไม่ทำลายข้อมูลเดิมไม่ว่าออเดอร์จะเป็นแบบไหน
 */
function buildCartEntriesFromOrder(order) {
  const items = order?.items || [];

  if (order?.order_type === "playlist") {
    const playlist = order.playlist_id ? state.playlists.find((p) => p.id === order.playlist_id) : null;
    return [{
      kind: "playlist",
      playlistId: order.playlist_id || playlist?.id || null,
      title: order.playlist_name || getPlaylistName(playlist) || "เพลย์ลิสต์",
      price: Number(order.total || playlist?.price || 0),
      songs: items.map((i) => ({ songId: i.song_id, title: i.title, price: Number(i.price || 0) })),
    }];
  }

  if (order?.order_type === "mixed") {
    return items.map((item) => {
      if (item?.kind === "playlist") {
        const songIds = Array.isArray(item.song_ids) ? item.song_ids : [];
        const songTitles = Array.isArray(item.song_titles) ? item.song_titles : [];
        return {
          kind: "playlist",
          playlistId: item.playlist_id,
          title: item.title || "เพลย์ลิสต์",
          price: Number(item.price || 0),
          songs: songIds.map((id, idx) => ({ songId: id, title: songTitles[idx] || "เพลง", price: 0 })),
        };
      }
      return { kind: "song", songId: item.song_id, title: item.title, price: Number(item.price || 0) };
    });
  }

  // "single" หรือออเดอร์เก่าที่ไม่มี order_type — ทุกรายการเป็นเพลงเดี่ยวทั้งหมด
  return items.map((item) => ({ kind: "song", songId: item.song_id, title: item.title, price: Number(item.price || 0) }));
}

// รองรับหน้า admin.html รุ่นเก่าที่ยังไม่มี modal ใบเสร็จ
function ensureReceiptElements() {
  if (document.getElementById("receiptBackdrop")) return;

  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.id = "receiptBackdrop";
  backdrop.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <h3>ใบเสร็จดิจิทัล</h3>
        <button class="modal-close" id="receiptClose">✕</button>
      </div>
      <div id="receiptContent"></div>
      <div style="display:flex;gap:8px;margin-top:14px;">
        <button class="btn secondary" id="receiptCopyBtn" type="button" style="flex:1;">คัดลอกรายละเอียด</button>
        <button class="btn secondary" id="receiptWhatsAppBtn" type="button" style="flex:1;">ส่งทาง WhatsApp</button>
        <button class="btn" id="receiptDownloadImgBtn" type="button" style="flex:1;">ดาวน์โหลดใบเสร็จเป็นรูป</button>
      </div>
    </div>
  `;
  document.body.appendChild(backdrop);
}
// รองรับหน้า admin.html รุ่นเก่าที่ยังไม่มี modal ไฟล์เพลงเต็ม
function ensureFullFilesElements() {
  if (document.getElementById("fullFilesBackdrop")) return;

  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.id = "fullFilesBackdrop";
  backdrop.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <h3>ไฟล์เพลงเต็มสำหรับส่งลูกค้า</h3>
        <button class="modal-close" id="fullFilesClose">✕</button>
      </div>
       <p style="color:var(--text-dim);font-size:13px;margin-top:0;">คัดลอกลิงก์ดาวน์โหลดส่งให้ลูกค้า หรือกดปุ่ม WhatsApp เพื่อส่งตรง — ลูกค้าสามารถดาวน์โหลดได้จากลิงก์นี้</p>
      <div id="fullFilesContent"></div>
      <div id="fullFilesZipLinkWrap" style="display:none;margin-top:14px;padding:10px;background:rgba(16,185,129,.08);border-radius:10px;">
        <div style="font-size:12px;color:var(--success);font-weight:600;margin-bottom:6px;">🔗 ลิงก์ดาวน์โหลดสำหรับลูกค้า</div>
        <div id="fullFilesZipLinkText" style="font-size:11px;color:var(--text-dim);word-break:break-all;margin-bottom:8px;"></div>
        <button class="btn" type="button" id="fullFilesCopyLinkBtn" style="width:100%;margin-bottom:8px;">📋 คัดลอกลิงก์ดาวน์โหลด</button>
      </div>
      <button class="btn secondary" id="fullFilesWhatsAppBtn" type="button" style="margin-top:14px;width:100%;">💬 ส่ง WhatsApp พร้อมลิงก์ดาวน์โหลด</button>
    </div>
  `;
  document.body.appendChild(backdrop);
}
function calculateStats(orders) {
  // totalOrders = ออเดอร์ทั้งหมดทุกสถานะ (ปริมาณงานรวม)
  // totalSongsSold / totalRevenue = นับเฉพาะออเดอร์ที่ "สำเร็จ" แล้วเท่านั้น
  // เพื่อไม่ให้ออเดอร์ที่ยังรอตรวจสอบหรือถูกยกเลิกไปปนกับยอดขายจริง
  const totalOrders = orders.length;
  const completed = orders.filter((o) => o.status === "completed");
  // นับจำนวนเพลงต่อ Order: รายการปกติ (เพลงเดี่ยว) นับ 1, รายการที่เป็นเพลย์ลิสต์ (kind: "playlist",
  // มาจากตะกร้าแบบผสม/หลายเพลย์ลิสต์) ให้นับตามจำนวนเพลงจริงใน song_ids แทนการนับเป็น 1 รายการ
  const totalSongsSold = completed.reduce((sum, o) => {
    const items = o.items || [];
    const count = items.reduce((itemSum, item) => {
      if (item?.kind === "playlist") return itemSum + (Array.isArray(item.song_ids) ? item.song_ids.length : 1);
      return itemSum + 1;
    }, 0);
    return sum + count;
  }, 0);
  // ===== เพิ่มใหม่: ใช้ final_total ถ้ามี (รายได้จริงหลังหักส่วนลด), fallback ไป total สำหรับ order เก่า =====
  // เหตุผล: order.total เดิมถูกตั้งเท่ากับ final_total แล้วตอนสร้างใหม่ — แต่ order เก่า (ก่อน deploy ระบบใหม่)
  // ยังมี order.total = ราคาเต็ม จึงใช้ total เป็น fallback ปลอดภัย (สถิติยังถูกต้องสำหรับ order ใหม่ + ไม่พังสำหรับ order เก่า)
  const totalRevenue = completed.reduce((sum, o) => {
    const amount = (o.final_total != null) ? Number(o.final_total) : Number(o.total || 0);
    return sum + amount;
  }, 0);
  // แยกนับว่าออเดอร์ที่สำเร็จแล้วเป็นแบบ "เพลงเดี่ยว" หรือ "ยกเพลย์ลิสต์" กี่ออเดอร์
  // ออเดอร์เก่าที่ไม่มีฟิลด์ order_type (สร้างก่อนอัปเดตนี้) ให้นับเป็นเพลงเดี่ยวไว้ก่อน
  const singleCount = completed.filter((o) => (o.order_type || "single") === "single").length;
  const playlistCount = completed.filter((o) => o.order_type === "playlist").length;
  // ออเดอร์แบบผสม (เพลง+เพลย์ลิสต์ หรือหลายเพลย์ลิสต์ ที่สั่งซื้อจากตะกร้าฝั่งลูกค้า)
  const mixedCount = completed.filter((o) => o.order_type === "mixed").length;
  // ===== เพิ่มใหม่: สถิติส่วนลดรวมที่ให้ลูกค้าไป (สำหรับแอดมินดู performance ของโปรโมชั่น) =====
  const totalDiscountGiven = completed.reduce((sum, o) => sum + (Number(o.discount_amount) || 0), 0);
  return { totalOrders, totalSongsSold, totalRevenue, singleCount, playlistCount, mixedCount, totalDiscountGiven };
}

/* ---------------- Render: ผลค้นหาเพลง (ฟอร์มสร้างออเดอร์ใหม่) ---------------- */
function renderSearchResults() {
  const container = document.getElementById("ordSearchResults");
  container.innerHTML = "";

  if (state.searchResults.length === 0) return;

  state.searchResults.forEach((song) => {
    const alreadyAdded = state.cartEntries.some((e) => e.kind === "song" && e.songId === song.id);
    const row = document.createElement("div");
    row.className = "list-row";
    row.innerHTML = `
      <img src="${song.cover_url || ""}">
      <div class="info">
        <div class="n1">${escapeHtml(song.song_name)}</div>
        <div class="n2">${escapeHtml(song.dj_name || song.artist || "-")} · ${formatLAK(song.price)}</div>
      </div>
      <div class="row-actions">
        <button class="icon-btn" data-add="${song.id}" ${alreadyAdded ? "disabled" : ""} style="${alreadyAdded ? "opacity:.4;" : "background:var(--accent);color:#fff;"}">
          ${alreadyAdded ? "✓" : "＋"}
        </button>
      </div>
    `;
    container.appendChild(row);
  });

  container.querySelectorAll("[data-add]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.disabled) return;
      addToCart(btn.getAttribute("data-add"));
    });
  });
}

/* ---------------- Render: ตะกร้าออเดอร์ปัจจุบัน (ฟอร์มสร้างออเดอร์ใหม่, รองรับผสม) ---------------- */
function renderCart() {
  const container = document.getElementById("ordCartItems");
  const totalEl = document.getElementById("ordCartTotal");
  const hintEl = document.getElementById("ordTotalHint");
  container.innerHTML = "";

  if (state.cartEntries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.style.padding = "10px 0";
    empty.textContent = "ยังไม่ได้เลือกเพลงหรือเพลย์ลิสต์";
    container.appendChild(empty);
  } else {
    state.cartEntries.forEach((entry, index) => {
      const row = document.createElement("div");
      row.className = "list-row";
      if (entry.kind === "playlist") {
        // 🔧 (2026-09-16): playlist entries เป็น collapsible dropdown
        // กด ▸ จะขยายแสดงรายชื่อเพลงทั้งหมดใน playlist พร้อมราคาแต่ละเพลง
        // กดอีกครั้ง (▾) จะซ่อน — เหมือน dropdown เปิด/ปิด
        const songCount = (entry.songs || []).length;
        const songsListHtml = (entry.songs || []).map((s, i) => `
          <div style="display:flex;justify-content:space-between;padding:4px 0;font-size:13px;color:var(--text-dim);">
            <span>${i + 1}. 🎵 ${escapeHtml(s.title || "เพลง")}</span>
            <span>${formatLAK(s.price)}</span>
          </div>
        `).join("");
        row.style.flexDirection = "column";
        row.style.alignItems = "stretch";
        row.innerHTML = `
          <div style="display:flex;align-items:center;gap:8px;width:100%;">
            <button class="icon-btn" data-toggle="${index}" title="เปิด/ปิดรายชื่อเพลง" style="background:transparent;font-size:14px;padding:4px 8px;line-height:1;">▸</button>
            <div class="info" style="flex:1;">
              <div class="n1">🎶 ${escapeHtml(entry.title)} <span style="color:var(--text-dim);font-weight:400;">(${songCount} เพลง)</span></div>
              <div class="n2">${formatLAK(entry.price)}</div>
            </div>
            <div class="row-actions"><button class="icon-btn danger" data-remove="${index}">🗑</button></div>
          </div>
          <div class="playlist-songs-list" data-songs="${index}" style="display:none;margin-top:6px;margin-left:32px;padding-left:12px;border-left:2px solid var(--border);">
            ${songsListHtml || '<div style="font-size:12px;color:var(--text-dim);padding:4px 0;">(ไม่มีเพลงในเพลย์ลิสต์นี้)</div>'}
          </div>
        `;
      } else {
        row.innerHTML = `
          <div class="info"><div class="n1">🎵 ${escapeHtml(entry.title)}</div><div class="n2">${formatLAK(entry.price)}</div></div>
          <div class="row-actions"><button class="icon-btn danger" data-remove="${index}">🗑</button></div>
        `;
      }
      container.appendChild(row);
    });
    // 🔧 (2026-09-16): event listener สำหรับปุ่ม toggle เปิด/ปิดรายชื่อเพลงใน playlist
    container.querySelectorAll("[data-toggle]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const idx = btn.getAttribute("data-toggle");
        const list = container.querySelector(`[data-songs="${idx}"]`);
        if (list) {
          const isOpen = list.style.display !== "none";
          list.style.display = isOpen ? "none" : "block";
          btn.textContent = isOpen ? "▸" : "▾";
        }
      });
    });
    container.querySelectorAll("[data-remove]").forEach((btn) => {
      btn.addEventListener("click", () => removeFromCart(Number(btn.getAttribute("data-remove"))));
    });
  }

  const computedTotal = sumCartEntries(state.cartEntries);
  totalEl.value = computedTotal;
  if (hintEl) {
    hintEl.textContent = "คำนวณอัตโนมัติ: รวมราคาเพลง + ราคาเหมาเพลย์ลิสต์ที่เลือก (ยังไม่หักส่วนลด/โปรโมชั่น — จะคำนวณตอนกดบันทึก)";
  }

  // ===== เพิ่มใหม่: แสดงส่วนลด/โปรโมชั่นแบบ approximate ใต้ช่องยอดรวม (async) =====
  // ใช้ cache จาก pricing.js — ถ้า cache ว่าง จะแสดงแค่ยอดรวมปกติ (admin ยังไม่ได้เข้าเมนูโปรโมชั่น)
  updateApproxPricingHint(state.cartEntries, hintEl);
}

// ===== เพิ่มใหม่: อัปเดต hint ของ admin cart ให้แสดงยอดหลังลดแบบ approximate =====
// ทำงาน async เพื่อไม่ให้ renderCart รอ — ใช้ cache ของ pricing.js (ถ้ามี)
async function updateApproxPricingHint(cartEntries, hintEl) {
  if (!hintEl || !cartEntries || cartEntries.length === 0) return;
  try {
    const pricing = await computeAdminPricing(cartEntries);
    const baseTotal = sumCartEntries(cartEntries);
    const finalTotal = pricing.finalTotal ?? baseTotal;
    const itemDiscount = pricing.itemDiscountAmount || 0;
    const promoDiscount = pricing.promoDiscountAmount || 0;
    const totalDiscount = itemDiscount + promoDiscount;
    if (totalDiscount > 0 && finalTotal < baseTotal) {
      let msg = `ยอดก่อนลด: ${formatLAK(baseTotal)} → หลังลด: ${formatLAK(finalTotal)} (ลด ${formatLAK(totalDiscount)})`;
      if (pricing.promotionApplied) {
        msg += ` · 🎁 ${pricing.promotionApplied.name}`;
      }
      hintEl.textContent = msg;
      hintEl.style.color = "var(--accent-2)";
    } else {
      hintEl.textContent = "คำนวณอัตโนมัติ: รวมราคาเพลง + ราคาเหมาเพลย์ลิสต์ที่เลือก (ยังไม่มีส่วนลด)";
      hintEl.style.color = "var(--text-dim)";
    }
  } catch (e) {
    console.warn("updateApproxPricingHint error:", e);
  }
}

/* ---------------- Render: ผลค้นหาเพลย์ลิสต์ (ฟอร์มสร้างออเดอร์ใหม่, เลือกได้หลายรายการ) ---------------- */
function renderPlaylistSearchResults() {
  const container = document.getElementById("ordPlaylistResults");
  if (!container) return;
  container.innerHTML = "";
  if (state.playlistSearchResults.length === 0) return;

  state.playlistSearchResults.forEach((pl) => {
    const alreadySelected = state.cartEntries.some((e) => e.kind === "playlist" && e.playlistId === pl.id);
    if (alreadySelected) return; // ซ่อนรายการที่เลือกไปแล้วออกจากผลค้นหา กันเลือกซ้ำ
    const songCount = getSongsInPlaylist(pl.id).length;
    const card = document.createElement("div");
    card.className = "playlist-result-card";
    card.innerHTML = `
      <img src="${pl.cover_url || ""}">
      <div class="info" style="flex:1;">
        <div class="n1">${escapeHtml(getPlaylistName(pl))}</div>
        <div class="n2">${songCount} เพลง · ราคาเหมา ${formatLAK(pl.price)}</div>
      </div>
    `;
    card.addEventListener("click", () => selectPlaylist(pl.id));
    container.appendChild(card);
  });
}

/* ---------------- Render: การ์ดเพลย์ลิสต์ที่เลือกไว้ทั้งหมด (ฟอร์มสร้างออเดอร์ใหม่) ---------------- */
function renderPlaylistSelected() {
  const container = document.getElementById("ordPlaylistSelected");
  if (!container) return;
  container.innerHTML = "";
  const selected = state.cartEntries.filter((e) => e.kind === "playlist");
  if (selected.length === 0) return;

  selected.forEach((entry) => {
    const card = document.createElement("div");
    card.className = "playlist-selected-card";
    card.style.marginBottom = "8px";
    card.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <div style="font-weight:800;">🎶 ${escapeHtml(entry.title)}</div>
        <button class="icon-btn" data-clear-playlist="${entry.playlistId}">✕</button>
      </div>
      <div style="font-size:12px;color:var(--text-dim);">${(entry.songs || []).length} เพลง · ราคาเหมา ${formatLAK(entry.price)}</div>
    `;
    container.appendChild(card);
  });
  container.querySelectorAll("[data-clear-playlist]").forEach((btn) => {
    btn.addEventListener("click", () => removeSelectedPlaylist(btn.getAttribute("data-clear-playlist")));
  });
}

/* ---------------- เพิ่มเพลย์ลิสต์เข้าตะกร้า: ดึงเพลงทั้งชุด + ราคาเหมา (เพิ่มได้หลายรายการ ไม่ล้างเพลง/เพลย์ลิสต์อื่นที่เลือกไว้) ---------------- */
function selectPlaylist(playlistId) {
  const pl = state.playlists.find((p) => p.id === playlistId);
  if (!pl) return;
  if (state.cartEntries.some((e) => e.kind === "playlist" && e.playlistId === playlistId)) {
    orderToast(`เพลย์ลิสต์ "${getPlaylistName(pl)}" ถูกเพิ่มไปแล้ว — ห้ามเพิ่มซ้ำ`, "error");
    return;
  }

  const songs = getSongsInPlaylist(pl.id);

  // 🔧 (2026-09-16): ห้ามเพิ่ม playlist ถ้ามีเพลงใน playlist ซ้ำกับที่อยู่ในตะกร้าแล้ว
  // (เพลงเดี่ยวที่เพิ่มไป หรือ เพลงที่อยู่ใน playlist อื่นในตะกร้า) — กันลูกค้าเสียเงิน 2 ครั้ง
  const duplicates = findPlaylistSongDuplicates(
    state.cartEntries,
    songs.map((s) => ({ songId: s.id, title: s.song_name }))
  );
  if (duplicates.length > 0) {
    const sample = duplicates.slice(0, 3).map((d) => `"${d.songTitle}"`).join(", ");
    const more = duplicates.length > 3 ? ` และอีก ${duplicates.length - 3} เพลง` : "";
    orderToast(`ห้ามเพิ่ม — เพลง ${sample}${more} ในเพลย์ลิสต์นี้ซ้ำกับที่อยู่ในตะกร้าแล้ว (กันลูกค้าเสียเงิน 2 ครั้ง)`, "error");
    return;
  }

  state.cartEntries.push({
    kind: "playlist",
    playlistId: pl.id,
    title: getPlaylistName(pl),
    price: Number(pl.price || 0),
    songs: songs.map((s) => ({ songId: s.id, title: s.song_name, price: Number(s.price || 0) })),
  });
  state.cartTotalEdited = false;
  document.getElementById("ordPlaylistSearch").value = "";
  state.playlistSearchResults = [];

  renderPlaylistSelected();
  renderPlaylistSearchResults();
  renderCart();
}

function removeSelectedPlaylist(playlistId) {
  state.cartEntries = state.cartEntries.filter((e) => !(e.kind === "playlist" && e.playlistId === playlistId));
  state.cartTotalEdited = false;
  renderPlaylistSelected();
  renderPlaylistSearchResults();
  renderCart();
}

function handlePlaylistSearchInput(e) {
  const q = e.target.value.trim().toLowerCase();
  state.playlistSearchResults = !q ? [] : state.playlists.filter((p) => getPlaylistName(p).toLowerCase().includes(q));
  renderPlaylistSearchResults();
}

/* ---------------- Render: Dashboard สถิติออเดอร์ ---------------- */
function renderStats(orders) {
  const stats = calculateStats(orders);
  document.getElementById("ordStatCount").textContent = stats.totalOrders.toLocaleString("en-US");
  document.getElementById("ordStatSongs").textContent = stats.totalSongsSold.toLocaleString("en-US");
  document.getElementById("ordStatRevenue").textContent = formatLAK(stats.totalRevenue);
  document.getElementById("ordStatSingleCount").textContent = stats.singleCount.toLocaleString("en-US");
  document.getElementById("ordStatPlaylistCount").textContent = stats.playlistCount.toLocaleString("en-US");
  // ===== เพิ่มใหม่: สถิติส่วนลดรวม (optional — ถ้า element ยังไม่มี จะข้ามไปเฉยๆ) =====
  const discEl = document.getElementById("ordStatDiscount");
  if (discEl) discEl.textContent = formatLAK(stats.totalDiscountGiven || 0);
}

/* ---------------- Render: แถบกรองสถานะ ---------------- */
function renderFilterPills() {
  const wrap = document.getElementById("ordStatusFilter");
  if (!wrap) return;
  const filters = [{ key: "all", label: "ทั้งหมด" }].concat(
    STATUS_ORDER.map((k) => ({ key: k, label: `${STATUS_CONFIG[k].emoji} ${STATUS_CONFIG[k].label}` }))
  );
  wrap.innerHTML = filters.map((f) =>
    `<button data-filter="${f.key}" class="${state.historyFilter === f.key ? "active" : ""}">${f.label}</button>`
  ).join("");
  wrap.querySelectorAll("[data-filter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.historyFilter = btn.getAttribute("data-filter");
      renderFilterPills();
      renderHistory();
    });
  });
}

/* ---------------- ค้นหาในประวัติออเดอร์ ----------------
   ค้นหาจากข้อมูลออเดอร์จริงที่โหลดมาแล้ว (state.allOrders)
   รองรับหลายคำ (คั่นด้วย space = AND match) แบบ case-insensitive
   ครอบคลุม: ชื่อลูกค้า, เบอร์ WhatsApp, ชื่อเพลง (ทุกรายการใน items),
            ชื่อเพลย์ลิสต์, เลขออเดอร์ (id), ชื่อไฟล์ ZIP
   ทำงานร่วมกับ status filter — กรองทั้งสองเงื่อนไขไปด้วยกัน */
function orderMatchesSearch(order, keywords) {
  if (!keywords || keywords.length === 0) return true;
  const haystack = [
    order.customer_name,
    order.whatsapp,
    order.id,
    order.playlist_name,
    order.zip_file_name,
    (order.items || []).map((it) => it.title).join(" "),
  ].map((v) => (v == null ? "" : String(v))).join(" ").toLowerCase();
  return keywords.every((kw) => haystack.indexOf(kw) !== -1);
}

function handleHistorySearchInput(e) {
  const raw = (e.target.value || "").trim().toLowerCase();
  state.historySearch = raw;
  renderHistory();
}

/* ---------------- Render: ประวัติออเดอร์ ---------------- */
// ===== เพิ่มใหม่: badge ส่วนลด/โปรโมชั่น สำหรับรายการ history (ฝั่งแอดมิน) =====
// อ่านจาก snapshot ใน order (subtotal/discount_amount/promotion_applied/final_total)
// ถ้า order เก่าไม่มี snapshot → ไม่แสดง badge (back-compat)
function buildAdminHistoryDiscountBadge(order) {
  const subtotal = order.subtotal;
  const discountAmount = order.discount_amount;
  const promotionApplied = order.promotion_applied;
  const finalTotal = (order.final_total != null) ? Number(order.final_total) : Number(order.total);
  if (subtotal == null && discountAmount == null && !promotionApplied) return "";
  const totalDiscount = (Number(discountAmount) || 0);
  if (totalDiscount <= 0) return "";

  const parts = [];
  if (promotionApplied && promotionApplied.name) {
    parts.push(`🎁 ${escapeHtml(promotionApplied.name)}`);
  }
  // ถ้ามี item-level discount ด้วย ให้แสดงเป็น "ลดราคาปกติ"
  const promoAmount = promotionApplied?.discount_amount || 0;
  const itemDiscount = totalDiscount - promoAmount;
  if (itemDiscount > 0) {
    parts.push(`🏷️ ลดราคาปกติ`);
  }
  const label = parts.join(" + ") || "ส่วนลด";
  return `<div class="n2" style="color:var(--accent-2,#ec4899);">⚡ ${label} · ลด ${formatLAK(totalDiscount)} · ยอดชำระ ${formatLAK(finalTotal)}</div>`;
}

function renderHistory() {
  const wrap = document.getElementById("ordHistoryList");
  const keywords = (state.historySearch || "")
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  // กรองทั้งสถานะ (historyFilter) และคำค้นหา (historySearch) ไปด้วยกัน — flow เข้ากัน
  const orders = state.allOrders.filter((o) => {
    const passStatus = state.historyFilter === "all" ? true : o.status === state.historyFilter;
    if (!passStatus) return false;
    return orderMatchesSearch(o, keywords);
  });

  if (orders.length === 0) {
    const hasSearch = keywords.length > 0;
    wrap.innerHTML = `<div class="empty-state">${hasSearch ? "ไม่พบออเดอร์ที่ตรงกับคำค้นหา" : "ไม่พบออเดอร์ในสถานะนี้"}</div>`;
    return;
  }
  wrap.innerHTML = orders.map((o) => {
    const date = o.created_at ? new Date(o.created_at) : null;
    const dateStr = date ? date.toLocaleDateString("th-TH") + " " + date.toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" }) : "-";
    const songNames = (o.items || []).map(i => escapeHtml(i.title)).join(", ");
    const cfg = STATUS_CONFIG[o.status] || STATUS_CONFIG.pending_verify;
    const options = STATUS_ORDER.map((k) =>
      `<option value="${k}" ${o.status === k ? "selected" : ""}>${STATUS_CONFIG[k].emoji} ${STATUS_CONFIG[k].label}</option>`
    ).join("");
    const isPlaylistOrder = o.order_type === "playlist";
    const isMixedOrder = o.order_type === "mixed";
    const typeBadge = isPlaylistOrder
      ? `<span class="order-type-badge" style="background:rgba(122,92,255,.15);color:var(--accent);">🎶 ยกเพลย์ลิสต์${o.playlist_name ? " · " + escapeHtml(o.playlist_name) : ""}</span>`
      : isMixedOrder
        ? `<span class="order-type-badge" style="background:rgba(245,180,0,.15);color:#F5B400;">🛒 เพลง+เพลย์ลิสต์ (${(o.items || []).length} รายการ)</span>`
        : `<span class="order-type-badge" style="background:rgba(255,255,255,.08);color:var(--text-dim);">🎵 เพลงเดี่ยว</span>`;
    const zipInfo = o.zip_download_url
      ? `<div class="n2" style="color:var(--success);">📦 ${escapeHtml(o.zip_file_name || `Order-${o.id}.zip`)} · ${Number(o.zip_song_count || (o.items || []).length)} เพลง · <a href="${escapeHtml(toCloudinaryDownloadUrl(o.zip_download_url))}" target="_blank" rel="noopener" style="color:inherit;text-decoration:underline;">ดาวน์โหลด ZIP</a></div>`
      : o.zip_status === "failed"
        ? `<div class="n2" style="color:var(--danger);">⚠️ สร้าง ZIP ไม่สำเร็จ: ${escapeHtml(o.zip_error || "ไม่ทราบสาเหตุ")}</div>`
        : o.zip_status === "preparing"
          ? `<div class="n2" style="color:var(--accent);">⏳ กำลังสร้าง ZIP...</div>`
          : "";
    // ===== เพิ่มใหม่: แสดง badge ส่วนลด/โปรโมชั่น ถ้า order มี snapshot =====
    const discountInfo = buildAdminHistoryDiscountBadge(o);
    return `
      <div class="list-row" style="flex-direction:column;align-items:stretch;gap:8px;">
        <div class="info">
          ${typeBadge}
          <div class="n1">${escapeHtml(o.customer_name)} · ${formatLAK((o.final_total != null) ? Number(o.final_total) : Number(o.total))}</div>
          <div class="n2">${dateStr} · ${escapeHtml(o.whatsapp)}</div>
          <div class="n2">${songNames}</div>
          ${discountInfo}
          ${zipInfo}
        </div>
        <span class="status-badge" style="background:${cfg.bg};color:${cfg.color};">${cfg.emoji} ${cfg.label}</span>
        <select class="status-select" data-order-id="${o.id}">${options}</select>
        <div class="row-actions" style="justify-content:flex-end;">
          <button class="icon-btn" data-receipt-order="${o.id}" title="ดูใบเสร็จ">🧾</button>
          ${(o.status === "processing" || o.status === "completed") ? `<button class="icon-btn" data-fullfiles-order="${o.id}" title="ไฟล์เต็มสำหรับส่งลูกค้า">📥</button>` : ""}
          ${o.zip_status === "failed" ? `<button class="icon-btn" data-retry-zip-order="${o.id}" title="สร้าง ZIP ใหม่">🔁</button>` : ""}
          ${o.zip_download_url ? `<button class="icon-btn" data-delete-zip-order="${o.id}" title="ลบไฟล์ ZIP ออกจาก Cloud (ไม่ลบออเดอร์ — ประหยัดพื้นที่จัดเก็บ)">🧹</button>` : ""}
          <button class="icon-btn" data-edit-order="${o.id}" title="แก้ไขออเดอร์">✏️</button>
          ${isMainAdmin() ? `<button class="icon-btn danger" data-delete-order="${o.id}" title="ลบออเดอร์">🗑</button>` : ""}
        </div>
      </div>
    `;
  }).join("");

  wrap.querySelectorAll("[data-order-id]").forEach((sel) => {
    sel.addEventListener("change", () => handleStatusChange(sel.getAttribute("data-order-id"), sel.value));
  });
  wrap.querySelectorAll("[data-receipt-order]").forEach((btn) => {
    btn.addEventListener("click", () => openReceipt(btn.getAttribute("data-receipt-order")));
  });
  wrap.querySelectorAll("[data-fullfiles-order]").forEach((btn) => {
    btn.addEventListener("click", () => openFullFilesModal(btn.getAttribute("data-fullfiles-order")));
  });
  wrap.querySelectorAll("[data-retry-zip-order]").forEach((btn) => {
    btn.addEventListener("click", () => retryOrderZip(btn.getAttribute("data-retry-zip-order")));
  });
  wrap.querySelectorAll("[data-delete-zip-order]").forEach((btn) => {
    btn.addEventListener("click", () => handleDeleteOrderZip(btn.getAttribute("data-delete-zip-order")));
  });
  wrap.querySelectorAll("[data-edit-order]").forEach((btn) => {
    btn.addEventListener("click", () => openEditOrderModal(btn.getAttribute("data-edit-order")));
  });
  wrap.querySelectorAll("[data-delete-order]").forEach((btn) => {
    btn.addEventListener("click", () => handleDeleteOrder(btn.getAttribute("data-delete-order")));
  });
}

/* ---------------- ใบเสร็จดิจิทัล ---------------- */
function getReceiptStatusLabel(status) {
  return STATUS_CONFIG[status]?.label || "รอตรวจสอบการโอน";
}

function buildReceiptCopyText(order, receiptNumber, total, playlistName) {
  const date = order.created_at ? new Date(order.created_at) : new Date();
  const dateText = Number.isNaN(date.getTime())
    ? "-"
    : date.toLocaleString("th-TH", { dateStyle: "medium", timeStyle: "short" });
  const itemLines = order.order_type === "playlist"
    ? [`1. เพลย์ลิสต์: ${playlistName} — ${formatLAK(total)}`]
    : (order.items || []).map((item, index) =>
        `${index + 1}. ${item.title || "เพลง"} — ${formatLAK(item.price)}`
      );
  return [
    order.store_name || state.storeName || "Music Store",
    "ใบเสร็จรับเงิน / รายละเอียด Order",
    `เลขที่: ${receiptNumber}`,
    `วันที่: ${dateText}`,
    `สถานะ: ${getReceiptStatusLabel(order.status)}`,
    "",
    `ลูกค้า: ${order.customer_name || "-"}`,
    `WhatsApp: ${order.whatsapp || "-"}`,
    "",
    "รายการสั่งซื้อ:",
    ...(itemLines.length ? itemLines : ["ไม่มีรายการสินค้า"]),
    "",
    `รวมทั้งสิ้น: ${formatLAK(total)}`,
    "กรุณาโอนเงินตามช่องทางที่ร้านแจ้ง"
  ].join("\n");
}

async function copyReceiptDetails(order, receiptNumber, total, playlistName) {
  const text = buildReceiptCopyText(order, receiptNumber, total, playlistName);
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
    }
    orderToast("คัดลอกรายละเอียด Order แล้ว", "success");
  } catch (err) {
    orderToast("คัดลอกไม่สำเร็จ กรุณาลองใหม่", "error");
  }
}

// แคปเฉพาะส่วนใบเสร็จสีขาว (.receipt-paper) เป็น canvas — ใช้กับปุ่มดาวน์โหลดใบเสร็จเป็นรูป
// เรนเดอร์ฝั่ง client ล้วนๆ ด้วย html2canvas ไม่มีการอัปโหลดรูปขึ้นเซิร์ฟเวอร์ใดๆ
// โหลดไลบรารีแบบ dynamic import จาก CDN (ESM) เฉพาะตอนกดใช้งานจริง ไม่กระทบ bundle/perf ปกติ
async function captureReceiptCanvas() {
  const target = document.querySelector("#receiptContent .receipt-paper");
  if (!target) return null;
  const mod = await import("https://esm.sh/html2canvas@1.4.1");
  const html2canvas = mod.default;
  return html2canvas(target, {
    backgroundColor: "#ffffff",
    scale: 2,
    useCORS: true,
  });
}

// ดาวน์โหลดใบเสร็จเป็นไฟล์ PNG ลงเครื่องทันที
// - ใช้ data URL + <a download> ซึ่งรองรับทั้ง Chrome/Android และ Safari บนมือถือ/iPad
//   (บน iOS บางเวอร์ชันอาจเปิดรูปในแท็บใหม่แทนการดาวน์โหลดอัตโนมัติ ผู้ใช้กดค้างที่รูปเพื่อ "บันทึกลงรูปภาพ" ได้ตามปกติ)
async function downloadReceiptAsImage(receiptNumber) {
  try {
    const canvas = await captureReceiptCanvas();
    if (!canvas) {
      orderToast("ไม่พบใบเสร็จให้บันทึก", "error");
      return;
    }
    const dataUrl = canvas.toDataURL("image/png");
    const link = document.createElement("a");
    link.href = dataUrl;
    link.download = `receipt-${receiptNumber || "order"}.png`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    orderToast("บันทึกรูปใบเสร็จสำเร็จ", "success");
  } catch (err) {
    orderToast("บันทึกรูปใบเสร็จไม่สำเร็จ: " + err.message, "error");
  }
}

// สร้างรายการเพลงในใบเสร็จ — ถ้าเป็นเพลย์ลิสต์ (ทั้งออเดอร์ทั้งใบ หรือรายการย่อยในออเดอร์ผสม)
// ให้ขยายแสดงชื่อเพลงทุกเพลงในเพลย์ลิสต์นั้น แทนที่จะยุบเหลือบรรทัดเดียว
async function buildReceiptItemRows(order, total) {
  // กรณีออเดอร์ทั้งใบเป็นเพลย์ลิสต์เดียว (order_type "playlist"): items เป็นเพลงแต่ละเพลงอยู่แล้ว
  if (order.order_type === "playlist") {
    const items = order.items || [];
    const playlist = order.playlist_id ? state.playlists.find((p) => p.id === order.playlist_id) : null;
    const playlistName = order.playlist_name || getPlaylistName(playlist) || "เพลย์ลิสต์";
    const songLines = items.map((item) => `
      <div class="receipt-line" style="border-bottom:none;padding:4px 0 4px 14px;">
        <small>• ${escapeHtml(item.title || "เพลง")}</small>
      </div>
    `).join("");
    return `
      <div class="receipt-line" style="flex-direction:column;align-items:stretch;gap:2px;">
        <div style="display:flex;justify-content:space-between;">
          <strong>🎶 ${escapeHtml(playlistName)}</strong>
          <strong>${formatLAK(total)}</strong>
        </div>
        <small style="color:#666;">ยกเพลย์ลิสต์ · ${items.length} เพลง</small>
      </div>
      ${songLines}
    `;
  }

  // กรณีเพลงเดี่ยว/ออเดอร์ผสม: แต่ละ item อาจเป็นเพลงเดี่ยว หรือ kind:"playlist" ที่ต้องขยายรายชื่อเพลงข้างใน
  const items = order.items || [];
  const rowGroups = await Promise.all(items.map(async (item) => {
    if (item?.kind !== "playlist") {
      return `
        <div class="receipt-line">
          <div><strong>${escapeHtml(item.title || "เพลง")}</strong></div>
          <strong>${formatLAK(item.price)}</strong>
        </div>
      `;
    }
    // ดึงชื่อเพลงจาก song_ids ที่ snapshot ไว้ตอนสั่งซื้อ (เผื่อไม่มี ให้ query จาก playlist_id แทน เหมือน openFullFilesModal)
    let songIds = Array.isArray(item.song_ids) ? item.song_ids : [];
    if (songIds.length === 0 && item.playlist_id) {
      try {
        const songsSnap = await getDocs(query(collection(db, "songs"), where("playlist_id", "==", item.playlist_id)));
        songIds = songsSnap.docs.map((d) => d.id);
      } catch (_) { /* ปล่อยผ่าน แสดงแค่หัวข้อเพลย์ลิสต์ถ้า query ไม่สำเร็จ */ }
    }
    const songNames = await Promise.all(songIds.map(async (songId) => {
      try {
        const snap = await getDoc(doc(db, "songs", songId));
        return snap.exists() ? (snap.data().song_name || "เพลง") : "เพลง";
      } catch (_) {
        return "เพลง";
      }
    }));
    const songLines = songNames.map((name) => `
      <div class="receipt-line" style="border-bottom:none;padding:4px 0 4px 14px;">
        <small>• ${escapeHtml(name)}</small>
      </div>
    `).join("");
    return `
      <div class="receipt-line" style="flex-direction:column;align-items:stretch;gap:2px;">
        <div style="display:flex;justify-content:space-between;">
          <strong>🎶 ${escapeHtml(item.title || "เพลย์ลิสต์")}</strong>
          <strong>${formatLAK(item.price)}</strong>
        </div>
        <small style="color:#666;">ยกเพลย์ลิสต์ · ${songNames.length} เพลง</small>
      </div>
      ${songLines}
    `;
  }));
  return rowGroups.join("");
}

// ===== เพิ่มใหม่: แถวส่วนลด/โปรโมชั่นสำหรับใบเสร็จฝั่งแอดมิน =====
// อ่านจาก order.subtotal, order.discount_amount, order.promotion_applied (snapshot ตอนสั่ง)
// ถ้า order เก่าไม่มี field เหล่านี้ → ไม่แสดงแถวพิเศษ (back-compat)
function buildAdminReceiptDiscountRows(order) {
  const subtotal = order.subtotal;
  const discountAmount = order.discount_amount;
  const promotionApplied = order.promotion_applied;
  const finalTotal = (order.final_total != null) ? Number(order.final_total) : Number(order.total);
  if (subtotal == null && discountAmount == null && !promotionApplied) return "";
  const hasDiscount = (discountAmount && discountAmount > 0) || (promotionApplied && promotionApplied.discount_amount > 0);
  if (!hasDiscount) return "";

  let rows = "";
  if (subtotal != null && Number(subtotal) !== finalTotal) {
    rows += `<div class="receipt-line receipt-discount-row"><span>ยอดรวมก่อนลด</span><span>${formatLAK(Number(subtotal))}</span></div>`;
  }
  if (promotionApplied && promotionApplied.name) {
    const promoAmount = promotionApplied.discount_amount || 0;
    if (promoAmount > 0) {
      rows += `<div class="receipt-line receipt-promo-row"><span>🎁 โปรโมชั่น: ${escapeHtml(promotionApplied.name)}</span><span>-${formatLAK(promoAmount)}</span></div>`;
    }
  }
  if (discountAmount && discountAmount > 0) {
    const promoAmount = promotionApplied?.discount_amount || 0;
    const itemDiscount = Number(discountAmount) - promoAmount;
    if (itemDiscount > 0) {
      rows += `<div class="receipt-line receipt-discount-row"><span>ส่วนลดจากราคาปกติ</span><span>-${formatLAK(itemDiscount)}</span></div>`;
    }
  }
  return rows;
}

async function openReceipt(orderId) {
  const order = state.allOrders.find((o) => o.id === orderId);
  if (!order) return;
  ensureReceiptElements();

  const playlist = order.playlist_id
    ? state.playlists.find((p) => p.id === order.playlist_id)
    : null;
  const playlistName = order.playlist_name || getPlaylistName(playlist) || "เพลย์ลิสต์";
  const total = Number.isFinite(Number(order.total))
    ? Number(order.total)
    : calculateOrderTotal(order.order_type, order.items || [], playlist);
  const date = order.created_at ? new Date(order.created_at) : new Date();
  const dateText = Number.isNaN(date.getTime())
    ? "-"
    : date.toLocaleString("th-TH", { dateStyle: "medium", timeStyle: "short" });
  const receiptNumber = order.receipt_number || getReceiptNumber(order.id, order.created_at);

  const itemRows = await buildReceiptItemRows(order, total);

  // ===== เพิ่มใหม่: แถวส่วนลด/โปรโมชั่น (อ่านจาก snapshot ที่บันทึกใน order) =====
  const discountRows = buildAdminReceiptDiscountRows(order);
  const finalTotalForDisplay = (order.final_total != null) ? Number(order.final_total) : total;

  const content = document.getElementById("receiptContent");
  if (!content) return;
  content.innerHTML = `
    <div class="receipt-paper">
      <div class="receipt-head">
        <h2>${escapeHtml(order.store_name || state.storeName)}</h2>
        <div>ใบเสร็จรับเงิน</div>
        <small>เลขที่ ${escapeHtml(receiptNumber)}</small>
        <small>${escapeHtml(dateText)}</small>
      </div>
      <div class="receipt-customer">
        <div><span>ลูกค้า</span><strong>${escapeHtml(order.customer_name)}</strong></div>
        <div><span>WhatsApp</span><strong>${escapeHtml(order.whatsapp)}</strong></div>
      </div>
      <div class="receipt-items">
        ${itemRows || '<div class="receipt-empty">ไม่มีรายการสินค้า</div>'}
      </div>
      ${discountRows}
      <div class="receipt-total"><span>รวมทั้งสิ้น</span><strong>${formatLAK(finalTotalForDisplay)}</strong></div>
      <div class="receipt-thanks">ขอบคุณที่ใช้บริการ</div>
    </div>
  `;

  const backdrop = document.getElementById("receiptBackdrop");
  backdrop.classList.add("open");
  backdrop.style.display = "flex";
  const copyBtn = document.getElementById("receiptCopyBtn");
  if (copyBtn) {
    copyBtn.onclick = () => copyReceiptDetails(order, receiptNumber, total, playlistName);
  }
  const whatsappBtn = document.getElementById("receiptWhatsAppBtn");
  if (whatsappBtn) {
    whatsappBtn.onclick = () => {
      const number = String(order.whatsapp || "").replace(/[^0-9]/g, "");
      if (!number) {
        orderToast("ออเดอร์นี้ไม่มีเบอร์ WhatsApp ของลูกค้า", "error");
        return;
      }
      const text = "กรุณารอสักครู่ แอดมินกำลังสร้างออเดอร์และใบเสร็จให้ลูกค้าค่ะ/ครับ 🙏";
      window.open(buildWhatsAppLink(number, text), "_blank", "noopener");
    };
  }
  const downloadImgBtn = document.getElementById("receiptDownloadImgBtn");
  if (downloadImgBtn) {
    downloadImgBtn.onclick = () => downloadReceiptAsImage(receiptNumber);
  }
}

function closeReceipt() {
  const backdrop = document.getElementById("receiptBackdrop");
  backdrop.classList.remove("open");
  backdrop.style.display = "none";
}

/* ---------------- ไฟล์เพลงเต็ม WAV สำหรับ Admin ส่งลูกค้า (หลังชำระเงินแล้วเท่านั้น) ---------------- */
async function openFullFilesModal(orderId) {
  const order = state.allOrders.find((o) => o.id === orderId);
  const content = document.getElementById("fullFilesContent");
  const backdrop = document.getElementById("fullFilesBackdrop");
  if (!order || !content || !backdrop) return;

  if (order.status !== "processing" && order.status !== "completed") {
    alert("ออเดอร์นี้ยังไม่ได้ยืนยันการชำระเงิน");
    return;
  }

  content.innerHTML = `<div class="empty-state">กำลังโหลดไฟล์...</div>`;
  backdrop.classList.add("open");
  backdrop.style.display = "flex";

  // ดึงข้อมูลเพลงล่าสุดจาก Firestore ตรงๆ (ไม่ใช้ cache) เพราะเพลงอาจถูกปิดการขาย/แก้ไขไปแล้วหลังสั่งซื้อ
  const items = order.items || [];
  // แต่ละ item ปกติแทนเพลง 1 เพลง (มี song_id) — ยกเว้น item ที่เป็น "playlist" (มาจาก Order ผสมที่สั่งจาก
  // ตะกร้าฝั่งลูกค้า) ซึ่งไม่มี song_id ตรงๆ ต้องขยายเป็นรายเพลงจาก song_ids ที่ snapshot ไว้ตอนสั่งซื้อก่อน

  // 🔧 (2026-09-17 Phase 2): Pre-fetch ทุกเพลงแบบ batch ก่อน แทนการยิง getDoc ทีละอัน
  //   ลด HTTP requests + Worker invocations + latency ตอนเปิด modal
  const allSongIdsInModal = [];
  items.forEach((item) => {
    if (item?.kind === "playlist") {
      if (Array.isArray(item.song_ids)) {
        allSongIdsInModal.push(...item.song_ids);
      }
    } else if (item?.song_id) {
      allSongIdsInModal.push(item.song_id);
    }
  });
  let songSnapMapModal = new Map();
  if (allSongIdsInModal.length > 0) {
    try {
      songSnapMapModal = await getDocsByIds("songs", allSongIdsInModal);
    } catch (err) {
      // fallback: ถ้า batch พัง → downloadRowsOf จะยิง getDoc เองเหมือนเดิม
      console.warn("openFullFilesModal: batch getDocsByIds failed, falling back to per-song getDoc", err?.message || err);
    }
  }

  const downloadRowsOf = async (songId, fallbackTitle) => {
    try {
      // 🔧 (2026-09-17 Phase 2): ใช้ cache จาก batch fetch ก่อน ถ้ามี
      let snap = songSnapMapModal.get(songId);
      if (!snap) {
        // fallback: ถ้า batch fetch พัง หรือ id ไม่อยู่ใน cache → ยิง getDoc ทีละอันเหมือนเดิม
        snap = await getDoc(doc(db, "songs", songId));
      }
      const song = snap.exists() ? snap.data() : null;
      // 🔒 Shared-file (Lazy-shared): ถ้าไม่มี full_file_url ให้ fallback ใช้ file_url แทน
      // เพราะเพลงใหม่บางเพลงใช้ไฟล์เดียวกันทั้งตอน preview และตอนส่งลูกค้า เพื่อประหยัดพื้นที่ R2
      const songFileUrl = song?.full_file_url || song?.file_url;
      if (!song || !songFileUrl) {
        return `<div class="receipt-line"><div><strong>${escapeHtml(fallbackTitle || song?.song_name || "เพลง")}</strong><small>ยังไม่ได้อัปโหลดไฟล์เต็ม WAV</small></div></div>`;
      }
      // ถ้าใช้ file_url แทน ให้โชว์ label ต่างเล็กน้อย เพื่อให้แอดมินรู้ว่าเพลงนี้ใช้ไฟล์ร่วมกัน
      const isShared = !song.full_file_url && !!song.file_url;
      const fileNameLabel = song.full_file_name || (isShared ? "shared file" : "full.wav");
      return `
        <div class="receipt-line">
          <div><strong>${escapeHtml(fallbackTitle || song.song_name || "เพลง")}</strong><small>${escapeHtml(fileNameLabel)}</small></div>
          <a class="btn secondary" style="padding:8px 14px;font-size:13px;" href="${toCloudinaryDownloadUrl(songFileUrl)}" target="_blank" rel="noopener">ดาวน์โหลด</a>
        </div>`;
    } catch (err) {
      return `<div class="receipt-line"><div><strong>${escapeHtml(fallbackTitle || "เพลง")}</strong><small>โหลดข้อมูลไม่สำเร็จ</small></div></div>`;
    }
  };

  const rowGroups = await Promise.all(items.map(async (item) => {
    if (item?.kind === "playlist") {
      let songIds = Array.isArray(item.song_ids) ? item.song_ids : [];
      // เผื่อ Order เก่า/กรณีไม่มี song_ids snapshot ไว้ ให้ query จาก playlist_id แทน
      if (songIds.length === 0 && item.playlist_id) {
        try {
          const songsSnap = await getDocs(query(collection(db, "songs"), where("playlist_id", "==", item.playlist_id)));
          songIds = songsSnap.docs.map((d) => d.id);
        } catch (_) { /* ปล่อยผ่าน แสดง header ของเพลย์ลิสต์อย่างเดียวถ้า query ไม่สำเร็จ */ }
      }
      const header = `<div class="receipt-line" style="opacity:.75;"><div><small>🎶 เพลย์ลิสต์: ${escapeHtml(item.title || "เพลย์ลิสต์")}</small></div></div>`;
      const songRows = await Promise.all(songIds.map((songId) => downloadRowsOf(songId, null)));
      return header + songRows.join("");
    }
    return downloadRowsOf(item.song_id, item.title);
  }));
  const rows = rowGroups;

  const zipRow = order.zip_download_url
    ? `<div class="receipt-line" style="background:rgba(41,204,113,.08);border:1px solid rgba(41,204,113,.25);border-radius:10px;padding:12px;margin-bottom:10px;">
        <div><strong>📦 ZIP รวมเพลงทั้งออเดอร์</strong><small>${escapeHtml(order.zip_file_name || `Order-${order.id}.zip`)} · ${Number(order.zip_song_count || items.length)} เพลง</small></div>
        <a class="btn" style="padding:8px 14px;font-size:13px;" href="${escapeHtml(toCloudinaryDownloadUrl(order.zip_download_url))}" target="_blank" rel="noopener">ดาวน์โหลด ZIP</a>
      </div>`
    : order.zip_status === "failed"
      ? `<div class="receipt-line" style="color:var(--danger);"><div><strong>⚠️ ยังสร้าง ZIP ไม่สำเร็จ</strong><small>${escapeHtml(order.zip_error || "ไม่ทราบสาเหตุ")}</small></div></div>`
      : "";
  content.innerHTML = zipRow + (rows.join("") || `<div class="empty-state">ไม่มีรายการเพลงในออเดอร์นี้</div>`);

  // 🔧 (2026-09-16): แสดงกล่อง "ลิงก์ดาวน์โหลดสำหรับลูกค้า" + ปุ่ม "คัดลอกลิงก์" ถ้าออเดอร์มี zip_download_url แล้ว
  // ใช้วิธี A1 — ส่ง R2 public URL ตรงๆ ให้ลูกค้า (R2 security: UUID สุ่ม + ไม่มี directory listing ทำให้ทายไม่ได้)
  const zipLinkWrap = document.getElementById("fullFilesZipLinkWrap");
  const zipLinkText = document.getElementById("fullFilesZipLinkText");
  if (zipLinkWrap && zipLinkText) {
    if (order.zip_download_url) {
      zipLinkText.textContent = order.zip_download_url;
      zipLinkWrap.style.display = "block";
    } else {
      zipLinkWrap.style.display = "none";
    }
  }

  // 🔧 (2026-09-16): ปุ่ม "คัดลอกลิงก์ดาวน์โหลด" — คัดลอก zip_download_url ไป clipboard
  // ใช้สำหรับแอดมินที่ไม่อยากส่งผ่าน WhatsApp โดยตรง (เช่น ส่งทางอื่น) หรือต้องการคัดลอกเอง
  const copyLinkBtn = document.getElementById("fullFilesCopyLinkBtn");
  if (copyLinkBtn) {
    copyLinkBtn.onclick = async () => {
      if (!order.zip_download_url) {
        orderToast("ยังไม่มีลิงก์ดาวน์โหลด — ออเดอร์นี้ยังไม่ได้สร้าง ZIP", "error");
        return;
      }
      try {
        await navigator.clipboard.writeText(order.zip_download_url);
        orderToast("📋 คัดลอกลิงก์ดาวน์โหลดแล้ว — ไปวางใน WhatsApp หรือที่อื่นได้เลย", "success");
      } catch (err) {
        // fallback ถ้า browser ไม่รองรับ clipboard API (เช่น ไม่ใช่ HTTPS)
        orderToast("คัดลอกไม่สำเร็จ: " + (err?.message || err) + " — คัดลอกจากกล่องข้อความด้านบนเอง", "error");
      }
    };
  }

  const whatsappBtn = document.getElementById("fullFilesWhatsAppBtn");
  if (whatsappBtn) {
    whatsappBtn.onclick = () => {
      const number = String(order.whatsapp || "").replace(/[^0-9]/g, "");
      if (!number) {
        orderToast("ออเดอร์นี้ไม่มีเบอร์ WhatsApp ของลูกค้า", "error");
        return;
      }
      const receiptNumber = order.receipt_number || getReceiptNumber(order.id, order.created_at);
      const zipUrl = order.zip_download_url || "";
      // 🔧 (2026-09-16): แบบที่ 2 — สุภาพ + ขอบคุณ + ลิงก์ดาวน์โหลด (เปลี่ยนจากเดิมที่ไม่ส่งลิงก์)
      // เพราะ R2 public URL ปลอดภัยพอแล้ว (UUID + no directory listing)
      // ถ้ายังไม่มี zip_download_url → ส่งแค่ข้อความทักทาย ไม่มีลิงก์
      let text;
      if (zipUrl) {
        text =
          `สวัสดีค่ะ/ครับ 🎵\n` +
          `ขอบคุณที่สั่งซื้อกับร้านเรา\n` +
          `ไฟล์เพลงสำหรับ Order ${receiptNumber} ดาวน์โหลดได้ที่ลิงก์นี้:\n` +
          `${zipUrl}\n` +
          `หากมีปัญหาดาวน์โหลด ติดต่อเราได้ตลอดค่ะ/ครับ`;
      } else {
        // กรณีออเดอร์ยังไม่มี ZIP (ยังไม่ได้สร้าง หรือสร้างล้มเหลว)
        text = `สวัสดีค่ะ/ครับ 🎵 เกี่ยวกับ Order ${receiptNumber} ของคุณค่ะ/ครับ`;
      }
      window.open(buildWhatsAppLink(number, text), "_blank", "noopener");
    };
  }
}

function closeFullFilesModal() {
  const backdrop = document.getElementById("fullFilesBackdrop");
  backdrop.classList.remove("open");
  backdrop.style.display = "none";
}

/* ---------------- เปลี่ยนสถานะออเดอร์ ---------------- */
async function handleStatusChange(orderId, newStatus) {
  const order = state.allOrders.find((item) => item.id === orderId);
  // "ยืนยันโอนแล้ว" จะยังไม่เปลี่ยนเป็น processing จนกว่า ZIP และลิงก์จะพร้อม
  if (newStatus === "processing" && order?.status !== "processing") {
    await confirmPaymentAndCreateZip(orderId);
    return;
  }
  try {
    await updateDoc(doc(db, "orders", orderId), { status: newStatus, updated_at: new Date().toISOString() });
    // 🔧 (2026-09-17 Phase 2): อัปเดต state ฝั่ง client แทน re-fetch ทั้งหมด (ลด D1 reads)
    await updateOrderInState(orderId, { status: newStatus, updated_at: new Date().toISOString() });
    renderFromState();
  } catch (err) {
    alert("เปลี่ยนสถานะไม่สำเร็จ: " + err.message);
  }
}

async function confirmPaymentAndCreateZip(orderId) {
  const result = await createOrderZip(orderId);
  if (!result.ok) {
    // 🔧 (2026-09-17 Phase 2): ใช้ renderFromState แทน refreshDashboardAndHistory (ออเดอร์ยังอยู่ status เดิม)
    //   เพราะ createOrderZip อัปเดต zip_status='failed' ภายในตัวมันเอง → state ต้อง sync ด้วย
    //   แต่ fallback: ถ้า updateOrderInState ไม่เจอ order → จะเรียก refreshDashboardAndHistory เอง
    await updateOrderInState(orderId, {
      zip_status: "failed",
      zip_error: result.error,
      updated_at: new Date().toISOString(),
    });
    renderFromState();
    orderToast(`ยืนยันโอนไม่สำเร็จ: ${result.error} — ออเดอร์ยังคงรอตรวจสอบ และสามารถกดสร้าง ZIP ใหม่ได้`, "error_long");
    return;
  }

  try {
    const now = new Date().toISOString();
    await updateDoc(doc(db, "orders", orderId), {
      status: "processing",
      payment_verified_at: now,
      updated_at: now,
    });
    // 🔧 (2026-09-17 Phase 2): อัปเดต state ฝั่ง client แทน re-fetch ทั้งหมด (ลด D1 reads)
    //   รวมถึง zip fields ที่ createOrderZip ตั้งไว้ (zip_status, zip_download_url, etc.)
    //   เพื่อให้ list แสดง ZIP link ใหม่ทันที
    const order = state.allOrders.find(o => o.id === orderId);
    await updateOrderInState(orderId, {
      status: "processing",
      payment_verified_at: now,
      updated_at: now,
      // sync zip fields จาก result ด้วย (createOrderZip คืน url กลับมา)
      ...(result.url ? { zip_download_url: result.url } : {}),
      ...(result.publicId ? { zip_public_id: result.publicId } : {}),
      zip_status: "ready",
      zip_error: "",
    });
    renderFromState();
    orderToast("ยืนยันการโอนแล้ว และสร้าง Download Link สำหรับ Admin เรียบร้อย", "success_long");
  } catch (err) {
    // ZIP ยังอยู่บน Cloud แต่จะไม่แสดงเป็นออเดอร์ที่ชำระแล้วจนกว่าจะอัปเดตสถานะสำเร็จ
    await refreshDashboardAndHistory();
    orderToast("สร้าง ZIP สำเร็จ แต่เปลี่ยนสถานะออเดอร์ไม่สำเร็จ: " + err.message, "error_long");
  }
}

async function retryOrderZip(orderId) {
  const order = state.allOrders.find((item) => item.id === orderId);
  if (!order || zipJobs.has(orderId)) return;
  const result = await createOrderZip(orderId);
  if (!result.ok) {
    // 🔧 (2026-09-17 Phase 2): อัปเดต state ฝั่ง client (zip_status='failed') แทน re-fetch
    await updateOrderInState(orderId, {
      zip_status: "failed",
      zip_error: result.error,
      updated_at: new Date().toISOString(),
    });
    renderFromState();
    orderToast("สร้าง ZIP ใหม่ไม่สำเร็จ: " + result.error, "error_long");
    return;
  }

  // กรณี retry จากขั้นตอนยืนยันโอนที่ค้างอยู่ ให้เดินหน้าส่งสถานะ processing ต่ออัตโนมัติ
  if (order.status === "pending_verify") {
    await confirmPaymentAndCreateZip(orderId);
  } else {
    // 🔧 (2026-09-17 Phase 2): อัปเดต state ฝั่ง client (zip_status='ready' + url ใหม่) แทน re-fetch
    await updateOrderInState(orderId, {
      zip_status: "ready",
      zip_download_url: result.url || order.zip_download_url,
      zip_public_id: result.publicId || order.zip_public_id,
      zip_error: "",
      updated_at: new Date().toISOString(),
    });
    renderFromState();
    orderToast("สร้าง ZIP ใหม่และ Download Link เรียบร้อย", "success_long");
  }
}

/* =====================================================================
   ยืนยันก่อนลบ — ใช้ modal ที่มีอยู่แล้วในหน้า (confirmBackdrop) ทั้งเว็บ
   คืนค่าเป็น Promise<boolean> ว่าผู้ใช้กด "ลบ" หรือ "ยกเลิก"
   =====================================================================

   🔧 แก้บั๊ก (2026-09-17) C1: Bug #3 ยังไม่ถูกแก้จริง — ปัญหา openConfirm vs askConfirm
   -----------------------------------------------------------
   ปัญหาก่อนแก้:
     - openConfirm (app-admin.js:2128) ใช้ `classList.add("show")` + state variable `confirmAction`
     - askConfirm (orders.js) ใช้ `classList.add("open")` + `style.display = "flex"/"none"` + listener ใหม่
     - ทั้งสองผูก listener บนปุ่ม #confirmOk ตัวเดียวกัน → cross-module handler conflict
     - inline style `display: none` ของ askConfirm ค้างถาวร → override CSS rule `.modal-backdrop.show`
       → openConfirm ทุกครั้งถัดไปจะ "มองไม่เห็น modal"

   วิธีแก้: เปลี่ยน askConfirm ให้ใช้ window.__openConfirm ที่ app-admin.js expose ไว้แล้ว (บรรทัด 2141)
     - ใช้ classList.add("show") เหมือน openConfirm → ไม่มี inline style leak
     - ใช้ confirmAction state ตัวเดียวกัน → ไม่มี cross-handler trigger
     - มี fallback กันกรณี app-admin.js ยังไม่โหลด → ใช้ window.confirm ธรรมดา

   ผลกระทบต่อระบบเดิม: 0%
     - ทุก caller ของ askConfirm (handleDeleteOrder, handleDeleteOrderZip, ฯลฯ) ยังได้ Promise<boolean>
       เหมือนเดิม → ไม่ต้องแก้ caller เลย
     - openConfirm เดิมใน app-admin.js ไม่ถูกแตะ → ไม่กระทบ
   ===================================================================== */
function askConfirm(message) {
  // 🔧 แก้บั๊ก C1: ใช้ window.__openConfirm ของ app-admin.js แทน เพื่อกัน conflict + inline style leak
  if (window.__openConfirm) {
    return new Promise((resolve) => {
      let resolved = false;
      // กด "ยืนยัน" → openConfirm เรียก onOk callback → resolve(true)
      window.__openConfirm(message, () => {
        if (resolved) return;
        resolved = true;
        cleanup();
        resolve(true);
      });
      // กด "ยกเลิก" → ปุ่ม #confirmCancel แค่ remove "show" class → ไม่ resolve ปกติ
      //   เลยต้องเพิ่ม listener ชั่วคราวเพื่อ catch การกด cancel
      const cancelBtn = document.getElementById("confirmCancel");
      function onCancel() {
        if (resolved) return;
        resolved = true;
        cleanup();
        resolve(false);
      }
      function cleanup() {
        if (cancelBtn) cancelBtn.removeEventListener("click", onCancel);
      }
      if (cancelBtn) cancelBtn.addEventListener("click", onCancel);
    });
  }
  // Fallback: ถ้า app-admin.js ยังไม่โหลด (หากเรียกก่อน module load) → ใช้ window.confirm ธรรมดา
  return Promise.resolve(window.confirm(message));
}

/* ---------------- ลบไฟล์ ZIP ออกจาก Cloud (ใหม่ 2026-09-11) ----------------
   ต่างจาก handleDeleteOrder: ไม่ลบออเดอร์ ลบแค่ไฟล์ ZIP ออกจาก R2 + เคลียร์ field ที่เกี่ยวกับ ZIP
   ในออเดอร์ เพื่อประหยัดพื้นที่จัดเก็บ (ออเดอร์ยังอยู่ครบ กดปุ่ม 🔁 สร้าง ZIP ใหม่ได้ภายหลังถ้าต้องการ) */
async function handleDeleteOrderZip(orderId) {
  const order = state.allOrders.find((o) => o.id === orderId);
  const label = order ? `ZIP ของออเดอร์ ${order.customer_name}` : "ไฟล์ ZIP นี้";
  const ok = await askConfirm(`ต้องการลบ${label}ออกจาก Cloud หรือไม่? (ออเดอร์จะยังอยู่ในระบบเหมือนเดิม ไม่ได้ลบ — แค่ต้องกดสร้าง ZIP ใหม่ถ้าจะดาวน์โหลดอีกครั้ง)`);
  if (!ok) return;

  try {
    const orderSnap = await getDoc(doc(db, "orders", orderId));
    const orderData = orderSnap.exists() ? orderSnap.data() : null;
    if (orderData?.zip_public_id) {
      await deleteFromStorage({ key: orderData.zip_public_id });
    } else if (orderData?.zip_download_url) {
      await deleteFromStorage({ url: orderData.zip_download_url });
    }
    await updateDoc(doc(db, "orders", orderId), {
      zip_status: "",
      zip_download_url: "",
      zip_file_name: "",
      zip_public_id: "",
      zip_song_count: 0,
      zip_created_at: "",
      zip_error: "",
      updated_at: new Date().toISOString(),
    });
    // 🔧 (2026-09-17 Phase 2): อัปเดต state ฝั่ง client แทน re-fetch (ลด D1 reads)
    await updateOrderInState(orderId, {
      zip_status: "",
      zip_download_url: "",
      zip_file_name: "",
      zip_public_id: "",
      zip_song_count: 0,
      zip_created_at: "",
      zip_error: "",
      updated_at: new Date().toISOString(),
    });
    renderFromState();
    orderToast("ลบไฟล์ ZIP ออกจาก Cloud แล้ว", "success");
  } catch (err) {
    orderToast("ลบไฟล์ ZIP ไม่สำเร็จ: " + (err.message || err), "error");
  }
}

/* ---------------- ลบออเดอร์ ---------------- */
async function handleDeleteOrder(orderId) {
  if (!isMainAdmin()) {
    if (window.__showToast) window.__showToast("เฉพาะแอดมินหลักเท่านั้นที่ลบประวัติออเดอร์ได้", "error");
    else alert("เฉพาะแอดมินหลักเท่านั้นที่ลบประวัติออเดอร์ได้");
    return;
  }
  const order = state.allOrders.find((o) => o.id === orderId);
  const label = order ? `ออเดอร์ของ ${order.customer_name} (${formatLAK(order.total)})` : "ออเดอร์นี้";
  const ok = await askConfirm(`ต้องการลบ${label}ใช่หรือไม่? การลบไม่สามารถย้อนกลับได้`);
  if (!ok) return;

  try {
    // ดึงข้อมูลออเดอร์สดก่อนลบ เพื่อเช็คว่ามีไฟล์ ZIP บน Cloud ค้างอยู่หรือไม่ (ไม่พึ่ง state.allOrders
    // เพราะอาจไม่ตรงกับข้อมูลจริง ณ ขณะนี้)
    const orderSnap = await getDoc(doc(db, "orders", orderId));
    const orderData = orderSnap.exists() ? orderSnap.data() : null;
    await deleteDoc(doc(db, "orders", orderId));
    // ลบไฟล์ ZIP ออกจาก Cloud ตามไปด้วยถ้าออเดอร์นี้เคยสร้าง ZIP ไว้ — ทำแบบ background ไม่รอ/ไม่ block UI
    // และไม่ทำให้การลบออเดอร์ล้มเหลวถ้าลบไฟล์ cloud ไม่สำเร็จ (ตัว order ลบไปแล้ว ย้อนกลับไม่ได้อยู่แล้ว)
    if (orderData?.zip_public_id) {
      deleteFromStorage({ key: orderData.zip_public_id });
    } else if (orderData?.zip_download_url) {
      deleteFromStorage({ url: orderData.zip_download_url });
    }
    // 🔧 (2026-09-17 Phase 2): ลบ order ออกจาก state ฝั่ง client แทน re-fetch (ลด D1 reads)
    removeOrderFromState(orderId);
    renderFromState();
  } catch (err) {
    alert("ลบออเดอร์ไม่สำเร็จ: " + err.message);
  }
}

/* =====================================================================
   แก้ไขออเดอร์ (modal)
   ===================================================================== */
function renderEditSearchResults() {
  const container = document.getElementById("eOrderSearchResults");
  if (!container) return;
  container.innerHTML = "";
  if (state.editSearchResults.length === 0) return;

  state.editSearchResults.forEach((song) => {
    const alreadyAdded = state.editCartEntries.some((e) => e.kind === "song" && e.songId === song.id);
    const row = document.createElement("div");
    row.className = "list-row";
    row.innerHTML = `
      <img src="${song.cover_url || ""}">
      <div class="info">
        <div class="n1">${escapeHtml(song.song_name)}</div>
        <div class="n2">${escapeHtml(song.dj_name || song.artist || "-")} · ${formatLAK(song.price)}</div>
      </div>
      <div class="row-actions">
        <button class="icon-btn" data-eadd="${song.id}" ${alreadyAdded ? "disabled" : ""} style="${alreadyAdded ? "opacity:.4;" : "background:var(--accent);color:#fff;"}">
          ${alreadyAdded ? "✓" : "＋"}
        </button>
      </div>
    `;
    container.appendChild(row);
  });

  container.querySelectorAll("[data-eadd]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.disabled) return;
      addToEditCart(btn.getAttribute("data-eadd"));
    });
  });
}

function renderEditCart() {
  const container = document.getElementById("eOrderCartItems");
  const totalEl = document.getElementById("eOrderCartTotal");
  const hintEl = document.getElementById("eOrderTotalHint");
  if (!container || !totalEl) return;
  container.innerHTML = "";

  if (state.editCartEntries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.style.padding = "10px 0";
    empty.textContent = "ยังไม่ได้เลือกเพลงหรือเพลย์ลิสต์";
    container.appendChild(empty);
  } else {
    state.editCartEntries.forEach((entry, index) => {
      const row = document.createElement("div");
      row.className = "list-row";
      if (entry.kind === "playlist") {
        // 🔧 (2026-09-16): playlist entries เป็น collapsible dropdown (เหมือน renderCart ฝั่งสร้างใหม่)
        const songCount = (entry.songs || []).length;
        const songsListHtml = (entry.songs || []).map((s, i) => `
          <div style="display:flex;justify-content:space-between;padding:4px 0;font-size:13px;color:var(--text-dim);">
            <span>${i + 1}. 🎵 ${escapeHtml(s.title || "เพลง")}</span>
            <span>${formatLAK(s.price)}</span>
          </div>
        `).join("");
        row.style.flexDirection = "column";
        row.style.alignItems = "stretch";
        row.innerHTML = `
          <div style="display:flex;align-items:center;gap:8px;width:100%;">
            <button class="icon-btn" data-etoggle="${index}" title="เปิด/ปิดรายชื่อเพลง" style="background:transparent;font-size:14px;padding:4px 8px;line-height:1;">▸</button>
            <div class="info" style="flex:1;">
              <div class="n1">🎶 ${escapeHtml(entry.title)} <span style="color:var(--text-dim);font-weight:400;">(${songCount} เพลง)</span></div>
              <div class="n2">${formatLAK(entry.price)}</div>
            </div>
            <div class="row-actions"><button class="icon-btn danger" data-eremove="${index}">🗑</button></div>
          </div>
          <div class="playlist-songs-list" data-esongs="${index}" style="display:none;margin-top:6px;margin-left:32px;padding-left:12px;border-left:2px solid var(--border);">
            ${songsListHtml || '<div style="font-size:12px;color:var(--text-dim);padding:4px 0;">(ไม่มีเพลงในเพลย์ลิสต์นี้)</div>'}
          </div>
        `;
      } else {
        row.innerHTML = `
          <div class="info"><div class="n1">🎵 ${escapeHtml(entry.title)}</div><div class="n2">${formatLAK(entry.price)}</div></div>
          <div class="row-actions"><button class="icon-btn danger" data-eremove="${index}">🗑</button></div>
        `;
      }
      container.appendChild(row);
    });
    // 🔧 (2026-09-16): event listener สำหรับปุ่ม toggle เปิด/ปิดรายชื่อเพลงใน playlist (edit modal)
    container.querySelectorAll("[data-etoggle]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const idx = btn.getAttribute("data-etoggle");
        const list = container.querySelector(`[data-esongs="${idx}"]`);
        if (list) {
          const isOpen = list.style.display !== "none";
          list.style.display = isOpen ? "none" : "block";
          btn.textContent = isOpen ? "▸" : "▾";
        }
      });
    });
    container.querySelectorAll("[data-eremove]").forEach((btn) => {
      btn.addEventListener("click", () => removeFromEditCart(Number(btn.getAttribute("data-eremove"))));
    });
  }

  const computedTotal = sumCartEntries(state.editCartEntries);
  totalEl.value = computedTotal;
  if (hintEl) {
    hintEl.textContent = "คำนวณอัตโนมัติ: รวมราคาเพลง + ราคาเหมาเพลย์ลิสต์ที่เลือก";
  }
}

function addToEditCart(songId) {
  const song = state.songs.find((s) => s.id === songId);
  if (!song) return;
  // 🔧 (2026-09-16): ห้ามเพิ่มเพลงซ้ำในออเดอร์เดียวเด็ดขาด (เหมือน addToCart ฝั่งสร้างใหม่)
  const check = findSongInCartEntries(state.editCartEntries, song.id);
  if (check.duplicate) {
    if (check.inKind === "song") {
      orderToast(`เพลง "${song.song_name}" ถูกเพิ่มเป็นเพลงเดี่ยวไปแล้ว — ห้ามเพิ่มซ้ำในออเดอร์เดียวกัน`, "error");
    } else {
      orderToast(`เพลง "${song.song_name}" อยู่ในเพลย์ลิสต์ "${check.inTitle}" ในตะกร้าแล้ว — ห้ามเพิ่มซ้ำ (กันลูกค้าเสียเงิน 2 ครั้ง)`, "error");
    }
    return;
  }
  state.editCartEntries.push({ kind: "song", songId: song.id, title: song.song_name, price: Number(song.price || 0) });
  state.editCartTotalEdited = false; // ตะกร้าเปลี่ยน ให้กลับไปคำนวณยอดรวมอัตโนมัติอีกครั้ง
  renderEditCart();
  renderEditSearchResults();
}

function removeFromEditCart(index) {
  const removed = state.editCartEntries[index];
  state.editCartEntries.splice(index, 1);
  state.editCartTotalEdited = false; // ตะกร้าเปลี่ยน ให้กลับไปคำนวณยอดรวมอัตโนมัติอีกครั้ง
  renderEditCart();
  renderEditSearchResults();
  if (removed?.kind === "playlist") renderEditPlaylistSelected();
  renderEditPlaylistSearchResults();
}

function handleEditSearchInput(e) {
  const q = e.target.value.trim().toLowerCase();
  if (!q) {
    state.editSearchResults = [];
  } else {
    state.editSearchResults = state.songs.filter((s) =>
      [s.song_name, s.artist, s.dj_name].join(" ").toLowerCase().includes(q)
    );
  }
  renderEditSearchResults();
}

/* ---------------- Render: ผลค้นหาเพลย์ลิสต์ (modal แก้ไขออเดอร์, เลือกได้หลายรายการ) ---------------- */
function renderEditPlaylistSearchResults() {
  const container = document.getElementById("eOrdPlaylistResults");
  if (!container) return;
  container.innerHTML = "";
  if (state.editPlaylistSearchResults.length === 0) return;

  state.editPlaylistSearchResults.forEach((pl) => {
    const alreadySelected = state.editCartEntries.some((e) => e.kind === "playlist" && e.playlistId === pl.id);
    if (alreadySelected) return;
    const songCount = getSongsInPlaylist(pl.id).length;
    const card = document.createElement("div");
    card.className = "playlist-result-card";
    card.innerHTML = `
      <img src="${pl.cover_url || ""}">
      <div class="info" style="flex:1;">
        <div class="n1">${escapeHtml(getPlaylistName(pl))}</div>
        <div class="n2">${songCount} เพลง · ราคาเหมา ${formatLAK(pl.price)}</div>
      </div>
    `;
    card.addEventListener("click", () => selectEditPlaylist(pl.id));
    container.appendChild(card);
  });
}

function renderEditPlaylistSelected() {
  const container = document.getElementById("eOrdPlaylistSelected");
  if (!container) return;
  container.innerHTML = "";
  const selected = state.editCartEntries.filter((e) => e.kind === "playlist");
  if (selected.length === 0) return;

  selected.forEach((entry) => {
    const card = document.createElement("div");
    card.className = "playlist-selected-card";
    card.style.marginBottom = "8px";
    card.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <div style="font-weight:800;">🎶 ${escapeHtml(entry.title)}</div>
        <button class="icon-btn" data-eclear-playlist="${entry.playlistId}">✕</button>
      </div>
      <div style="font-size:12px;color:var(--text-dim);">${(entry.songs || []).length} เพลง · ราคาเหมา ${formatLAK(entry.price)}</div>
    `;
    container.appendChild(card);
  });
  container.querySelectorAll("[data-eclear-playlist]").forEach((btn) => {
    btn.addEventListener("click", () => removeEditSelectedPlaylist(btn.getAttribute("data-eclear-playlist")));
  });
}

function selectEditPlaylist(playlistId) {
  const pl = state.playlists.find((p) => p.id === playlistId);
  if (!pl) return;
  if (state.editCartEntries.some((e) => e.kind === "playlist" && e.playlistId === playlistId)) {
    orderToast(`เพลย์ลิสต์ "${getPlaylistName(pl)}" ถูกเพิ่มไปแล้ว — ห้ามเพิ่มซ้ำ`, "error");
    return;
  }

  const songs = getSongsInPlaylist(pl.id);

  // 🔧 (2026-09-16): ห้ามเพิ่ม playlist ถ้ามีเพลงใน playlist ซ้ำกับที่อยู่ในตะกร้าแล้ว (เหมือน selectPlaylist ฝั่งสร้างใหม่)
  const duplicates = findPlaylistSongDuplicates(
    state.editCartEntries,
    songs.map((s) => ({ songId: s.id, title: s.song_name }))
  );
  if (duplicates.length > 0) {
    const sample = duplicates.slice(0, 3).map((d) => `"${d.songTitle}"`).join(", ");
    const more = duplicates.length > 3 ? ` และอีก ${duplicates.length - 3} เพลง` : "";
    orderToast(`ห้ามเพิ่ม — เพลง ${sample}${more} ในเพลย์ลิสต์นี้ซ้ำกับที่อยู่ในตะกร้าแล้ว (กันลูกค้าเสียเงิน 2 ครั้ง)`, "error");
    return;
  }

  state.editCartEntries.push({
    kind: "playlist",
    playlistId: pl.id,
    title: getPlaylistName(pl),
    price: Number(pl.price || 0),
    songs: songs.map((s) => ({ songId: s.id, title: s.song_name, price: Number(s.price || 0) })),
  });
  state.editCartTotalEdited = false;
  document.getElementById("eOrdPlaylistSearch").value = "";
  state.editPlaylistSearchResults = [];

  renderEditPlaylistSelected();
  renderEditPlaylistSearchResults();
  renderEditCart();
}

function removeEditSelectedPlaylist(playlistId) {
  state.editCartEntries = state.editCartEntries.filter((e) => !(e.kind === "playlist" && e.playlistId === playlistId));
  state.editCartTotalEdited = false;
  renderEditPlaylistSelected();
  renderEditPlaylistSearchResults();
  renderEditCart();
}

function handleEditPlaylistSearchInput(e) {
  const q = e.target.value.trim().toLowerCase();
  state.editPlaylistSearchResults = !q ? [] : state.playlists.filter((p) => getPlaylistName(p).toLowerCase().includes(q));
  renderEditPlaylistSearchResults();
}

/* เปิด modal แก้ไข พร้อมกรอกข้อมูลออเดอร์เดิมลงในฟอร์ม */
function openEditOrderModal(orderId) {
  const order = state.allOrders.find((o) => o.id === orderId);
  if (!order) return;

  // รองรับทุกรูปแบบออเดอร์แล้ว (single/playlist/mixed รวมถึงออเดอร์เก่าที่ไม่มี order_type)
  // แปลงกลับเป็นตะกร้าแบบผสมเพื่อแก้ไขต่อได้โดยไม่ทำข้อมูลเดิมหาย
  state.editingOrderId = orderId;
  state.editCartEntries = buildCartEntriesFromOrder(order);
  state.editSearchResults = [];
  state.editPlaylistSearchResults = [];

  document.getElementById("eOrderCustomerName").value = order.customer_name || "";
  document.getElementById("eOrderCustomerWhatsapp").value = order.whatsapp || "";
  document.getElementById("eOrderSongSearch").value = "";
  document.getElementById("eOrdPlaylistSearch").value = "";
  document.getElementById("eOrderFeedback").textContent = "";

  // ทุกครั้งที่แก้ไข ให้ยอดรวมกลับมาคำนวณจากข้อมูลสินค้าจริง
  state.editCartTotalEdited = false;

  renderEditCart();
  renderEditSearchResults();
  renderEditPlaylistSelected();
  renderEditPlaylistSearchResults();
  const backdrop = document.getElementById("orderFormBackdrop");
  backdrop.classList.add("open");
  backdrop.style.display = "flex";
}

function closeEditOrderModal() {
  const backdrop = document.getElementById("orderFormBackdrop");
  backdrop.classList.remove("open");
  backdrop.style.display = "none";
  state.editingOrderId = null;
  state.editCartEntries = [];
  state.editSearchResults = [];
  state.editCartTotalEdited = false;
  state.editPlaylistSearchResults = [];
}

/* บันทึกการแก้ไขออเดอร์ลง Firestore จริง */
async function handleUpdateOrder() {
  const orderId = state.editingOrderId;
  if (!orderId) return;

  const nameInput = document.getElementById("eOrderCustomerName");
  const whatsappInput = document.getElementById("eOrderCustomerWhatsapp");
  const feedback = document.getElementById("eOrderFeedback");
  const btn = document.getElementById("eOrderSaveBtn");

  const customerName = nameInput.value.trim();
  const whatsapp = whatsappInput.value.trim();
  const payload = buildOrderPayloadFromEntries(state.editCartEntries);
  const total = payload.total;
  const existingOrder = state.allOrders.find((o) => o.id === orderId);

  feedback.style.color = "var(--danger)";
  feedback.textContent = "";

  if (!customerName || !whatsapp) {
    feedback.textContent = "กรุณากรอกชื่อลูกค้าและเบอร์ WhatsApp";
    return;
  }
  if (state.editCartEntries.length === 0) {
    feedback.textContent = "กรุณาเลือกเพลงหรือเพลย์ลิสต์อย่างน้อย 1 รายการ";
    return;
  }
  if (!Number.isFinite(total) || total < 0) {
    feedback.textContent = "กรุณากรอกยอดรวมให้ถูกต้อง";
    return;
  }

  btn.disabled = true;
  btn.textContent = "กำลังบันทึก...";

  // ===== คำนวณ discount/promotion ใหม่จาก edit cart entries (เหมือนตอนสร้างใหม่) =====
  // เหตุผล: ถ้า admin แก้ items ใน order → ส่วนลดต้องคำนวณใหม่ด้วย
  // แต่ถ้า admin แค่เปลี่ยนชื่อลูกค้า/เบอร์ → ส่วนลดเดิมควรคงไว้
  // ใน v1: กระทำการ "คำนวณใหม่เสมอ" เพราะง่ายและปลอดภัย (snapshot ใหม่ = ส่วนลดใหม่ที่ถูกต้องตาม items ปัจจุบัน)
  const pricingResult = await computeAdminPricing(state.editCartEntries);
  const subtotal = pricingResult.subtotal ?? total;
  const discountAmount = pricingResult.discountAmount ?? 0;
  const promotionApplied = pricingResult.promotionApplied ?? null;
  const finalTotal = pricingResult.finalTotal ?? total;

  const updatedData = {
    customer_name: customerName,
    // 🔧 แก้บั๊ก (2026-09-18): normalize เบอร์ Laos ก่อนเก็บลง DB (เหมือนฝั่ง app-cart.js)
    //   ทำให้ track order ตามเบอร์รูปแบบใดก็เจอ (020 / 20 / +85620 ฯลฯ)
    whatsapp: normalizePhoneForStorage(whatsapp),
    items: payload.items,
    total: finalTotal, // ← ใช้ finalTotal สำหรับ back-compat
    order_type: payload.order_type, // "single" | "playlist" | "mixed"
    playlist_id: payload.playlist_id,
    playlist_name: payload.playlist_name,
    // เคลียร์ playlist_ids ให้ตรงกับ order_type ใหม่เสมอ (กันเศษข้อมูลเก่าค้าง เช่น แก้จาก mixed
    // กลับมาเป็น single/playlist แล้ว resolveOrderSongs ไปดึงเพลย์ลิสต์เก่าที่ไม่เกี่ยวข้องมาทำ ZIP)
    playlist_ids: payload.playlist_ids,
    store_name: existingOrder?.store_name || state.storeName,
    receipt_number: existingOrder?.receipt_number || getReceiptNumber(orderId, existingOrder?.created_at),
    updated_at: new Date().toISOString(),
    // ===== ฟิลด์ใหม่: snapshot ใหม่ ตาม items ปัจจุบัน =====
    subtotal,
    discount_amount: discountAmount,
    promotion_applied: promotionApplied,
    final_total: finalTotal,
  };

  try {
    await updateDoc(doc(db, "orders", orderId), updatedData);
    closeEditOrderModal();
    // 🔧 (2026-09-17 Phase 2): อัปเดต state ฝั่ง client แทน re-fetch (ลด D1 reads)
    //   updatedData มีทุก field ที่จำเป็น (items, total, status, zip fields, ฯลฯ) อยู่แล้ว
    //   รวมถึง id (คงเดิมจาก orderId) + created_at + receipt_number + store_name ที่อาจไม่ได้ส่งใน updatedData
    //   → ใช้ existingOrder (state.allOrders.find) เป็น base แล้ว merge updatedData เข้าไป
    const updatedOrderState = {
      ...(existingOrder || {}),
      ...updatedData,
      id: orderId,
    };
    await updateOrderInState(orderId, updatedOrderState);
    renderFromState();
    openReceipt(orderId);
  } catch (err) {
    feedback.textContent = "บันทึกไม่สำเร็จ: " + err.message;
  }

  btn.disabled = false;
  btn.textContent = "บันทึกการแก้ไข";
}

/* ---------------- Event handlers (ฟอร์มสร้างออเดอร์ใหม่) ---------------- */
function handleSearchInput(e) {
  const q = e.target.value.trim().toLowerCase();
  if (!q) {
    state.searchResults = [];
  } else {
    state.searchResults = state.songs.filter((s) =>
      [s.song_name, s.artist, s.dj_name].join(" ").toLowerCase().includes(q)
    );
  }
  renderSearchResults();
}

function addToCart(songId) {
  const song = state.songs.find((s) => s.id === songId);
  if (!song) return;
  // 🔧 (2026-09-16): ห้ามเพิ่มเพลงซ้ำในออเดอร์เดียวเด็ดขาด
  // ตรวจทั้งกรณี "เพลงเดี่ยวซ้ำ" และ "เพลงนี้อยู่ใน playlist ในตะกร้าแล้ว"
  // กันลูกค้าเสียเงิน 2 ครั้งในเพลงเดียวกัน
  const check = findSongInCartEntries(state.cartEntries, song.id);
  if (check.duplicate) {
    if (check.inKind === "song") {
      orderToast(`เพลง "${song.song_name}" ถูกเพิ่มเป็นเพลงเดี่ยวไปแล้ว — ห้ามเพิ่มซ้ำในออเดอร์เดียวกัน`, "error");
    } else {
      orderToast(`เพลง "${song.song_name}" อยู่ในเพลย์ลิสต์ "${check.inTitle}" ในตะกร้าแล้ว — ห้ามเพิ่มซ้ำ (กันลูกค้าเสียเงิน 2 ครั้ง)`, "error");
    }
    return;
  }
  state.cartEntries.push({ kind: "song", songId: song.id, title: song.song_name, price: Number(song.price || 0) });
  state.cartTotalEdited = false; // ตะกร้าเปลี่ยน ให้กลับไปคำนวณยอดรวมอัตโนมัติอีกครั้ง
  renderCart();
  renderSearchResults();
}

function removeFromCart(index) {
  const removed = state.cartEntries[index];
  state.cartEntries.splice(index, 1);
  state.cartTotalEdited = false; // ตะกร้าเปลี่ยน ให้กลับไปคำนวณยอดรวมอัตโนมัติอีกครั้ง
  renderCart();
  renderSearchResults();
  if (removed?.kind === "playlist") renderPlaylistSelected();
  renderPlaylistSearchResults();
}

/* ---------------- Init (เรียกทุกครั้งที่เปิดหน้า "จัดการออเดอร์") ---------------- */
// 🔧 แก้บั๊ก I11 (2026-09-18): export refreshDashboardAndHistory ให้เรียกจากปุ่ม "รีเฟรช" ได้
//   เดิม: refreshDashboardAndHistory ไม่ถูก export → admin ต้องกด F5 เพื่อ sync ข้อมูล
//   แก้: export ให้ → ปุ่ม "รีเฟรช" ใน admin.html สามารถเรียกได้ → โหลดออเดอร์ล่าสุดโดยไม่ต้อง F5
export async function refreshDashboardAndHistory() {
  const orders = await loadOrdersFromDatabase();
  state.allOrders = orders;
  renderStats(orders);
  renderFilterPills();
  renderHistory();
  // 🔧 (2026-09-16): อัปเดต badge จำนวนออเดอร์ "รอตรวจสอบการโอน" บนปุ่ม "🧾 จัดการออเดอร์"
  // ส่ง state.allOrders เข้าไปเพื่อ reuse ข้อมูลที่โหลดแล้ว → ไม่ต้อง query DB ซ้ำ (ประหยัด Cloudflare D1 quota)
  // ถ้า app-admin.js ยังไม่โหลด (เช่น หน้า user ไม่มี badge) → __updateOrdersBadge จะเป็น undefined → ข้ามไปเฉยๆ
  if (window.__updateOrdersBadge) window.__updateOrdersBadge(state.allOrders);
}

// ===================================================
// 🔧 (2026-09-17 Phase 2): State update helpers — อัปเดต state.allOrders ฝั่ง client
// เป้าหมาย: หลัง admin action (status change/delete/create/edit) → อัปเดต state ตรง ๆ
//   แทนการ re-fetch orders ทั้งหมด → ลด D1 reads มาก (15,000 reads/วัน → ~30 reads/วัน)
//   ความเสีย: ถ้ามีหลายแอดมิน หรือ customer ลบออเดอร์จากฝั่ง user → admin อื่นจะไม่เห็นจนกว่าจะ refresh
//   แต่ music store ของคุณมี admin สูงสุด 3 คน → ผลกระทบต่ำ
//   กรณี state ผิดพลาด → กด refresh หน้าเว็บ (F5) → refreshDashboardAndHistory จะ fetch ใหม่ให้
// ===================================================

// Re-render จาก state.allOrders โดยไม่ re-fetch (ใช้หลัง update/remove/add order)
function renderFromState() {
  renderStats(state.allOrders);
  renderFilterPills();
  renderHistory();
  if (window.__updateOrdersBadge) window.__updateOrdersBadge(state.allOrders);
}

// อัปเดต order ใน state.allOrders (merge patch เข้าไป)
// ถ้าไม่เจอ order ใน state (เกิดจาก multi-admin race) → fallback เรียก refreshDashboardAndHistory
async function updateOrderInState(orderId, patch) {
  const idx = state.allOrders.findIndex(o => o.id === orderId);
  if (idx === -1) {
    // fallback: order ไม่อยู่ใน state (อาจถูกลบไปแล้วจากอีก admin) → re-fetch ใหม่
    console.warn("updateOrderInState: order not found in state, falling back to full refresh", orderId);
    await refreshDashboardAndHistory();
    return;
  }
  state.allOrders[idx] = { ...state.allOrders[idx], ...patch };
}

// ลบ order ออกจาก state.allOrders
function removeOrderFromState(orderId) {
  state.allOrders = state.allOrders.filter(o => o.id !== orderId);
}

// เพิ่ม order ใหม่เข้าไปด้านหน้า state.allOrders (ใหม่สุดอยู่บนสุดของ list ที่ sort ตาม created_at desc)
function addOrderToState(order) {
  if (!order || !order.id) return;
  state.allOrders.unshift(order);
}

async function handleSubmitOrder() {
  const nameInput = document.getElementById("ordCustomerName");
  const whatsappInput = document.getElementById("ordCustomerWhatsapp");
  const feedback = document.getElementById("ordFormFeedback");
  const btn = document.getElementById("ordSubmitBtn");

  const customerName = nameInput.value.trim();
  // 🔧 แก้บั๊ก (2026-09-18): normalize เบอร์ Laos ก่อนเก็บลง DB (เหมือนฝั่ง app-cart.js + edit order)
  //   ทำให้ track order ตามเบอร์รูปแบบใดก็เจอ (020 / 20 / +85620 ฯลฯ)
  const whatsapp = normalizePhoneForStorage(whatsappInput.value.trim());
  const payload = buildOrderPayloadFromEntries(state.cartEntries);
  const total = payload.total;

  feedback.textContent = "";
  feedback.style.color = "var(--danger)";

  if (!customerName || !whatsapp) {
    feedback.textContent = "กรุณากรอกชื่อลูกค้าและเบอร์ WhatsApp";
    return;
  }
  if (state.cartEntries.length === 0) {
    feedback.textContent = "กรุณาเลือกเพลงหรือเพลย์ลิสต์อย่างน้อย 1 รายการ";
    return;
  }
  if (!Number.isFinite(total) || total < 0) {
    feedback.textContent = "กรุณากรอกยอดรวมให้ถูกต้อง";
    return;
  }

  btn.disabled = true;
  btn.textContent = "กำลังบันทึก...";

  // ===== คำนวณ discount/promotion แบบเดียวกับฝั่งลูกค้า — เพื่อบันทึก snapshot ใน order =====
  // ใช้ cart entries ปัจจุบัน แปลงเป็น cartItems format
  const pricingResult = await computeAdminPricing(state.cartEntries);
  const subtotal = pricingResult.subtotal ?? total;
  const discountAmount = pricingResult.discountAmount ?? 0;
  const promotionApplied = pricingResult.promotionApplied ?? null;
  const finalTotal = pricingResult.finalTotal ?? total;

  const order = {
    customer_name: customerName,
    whatsapp: whatsapp,
    items: payload.items,
    total: finalTotal, // ← ใช้ finalTotal (หลังลด) สำหรับ back-compat กับ admin code ที่อ่าน order.total
    order_type: payload.order_type, // "single" | "playlist" | "mixed" — ใช้แยกสถิติใน Dashboard
    playlist_id: payload.playlist_id,
    playlist_name: payload.playlist_name,
    playlist_ids: payload.playlist_ids,
    store_name: state.storeName,
    status: "pending_verify",
    created_at: new Date().toISOString(),
    // ===== ฟิลด์ใหม่: snapshot การคำนวณส่วนลด ณ เวลาสั่ง =====
    subtotal,
    discount_amount: discountAmount,
    promotion_applied: promotionApplied,
    final_total: finalTotal,
  };

  try {
    const orderRef = doc(collection(db, "orders"));
    order.receipt_number = getReceiptNumber(orderRef.id, order.created_at);
    await setDoc(orderRef, order);

    nameInput.value = "";
    whatsappInput.value = "";
    document.getElementById("ordSongSearch").value = "";
    document.getElementById("ordPlaylistSearch").value = "";
    state.cartEntries = [];
    state.searchResults = [];
    state.cartTotalEdited = false;
    state.playlistSearchResults = [];
    renderCart();
    renderSearchResults();
    renderPlaylistSelected();
    renderPlaylistSearchResults();

    feedback.style.color = "var(--success)";
    feedback.textContent = `บันทึกออเดอร์ของ ${customerName} เรียบร้อยแล้ว ✓`;

    // 🔧 (2026-09-17 Phase 2): เพิ่ม order ใหม่เข้า state ฝั่ง client แทน re-fetch (ลด D1 reads)
    //   order ที่บันทึกมี id (orderRef.id), created_at, receipt_number, items, status='pending_verify', ฯลฯ ครบ
    addOrderToState({ id: orderRef.id, ...order });
    renderFromState();
    openReceipt(orderRef.id);
  } catch (err) {
    feedback.textContent = "บันทึกไม่สำเร็จ: " + err.message;
  }

  btn.disabled = false;
  btn.textContent = "บันทึกออเดอร์";
}

// ===== เพิ่มใหม่: คำนวณ discount/promotion สำหรับ admin cart entries =====
// cartEntries: array ของ { kind, song_id, playlist_id, price, ... }
// return: { subtotal, discountSubtotal, itemDiscountAmount, promoDiscountAmount, discountAmount, promotionApplied, finalTotal }
async function computeAdminPricing(cartEntries) {
  try {
    // โหลด active discounts + promotions แบบ forceRefresh (เหมือนฝั่งลูกค้า)
    const [discounts, promotions] = await Promise.all([
      fetchActiveDiscounts(true),
      fetchActivePromotions(true)
    ]);
    // แปลง cartEntries → cartItems format ที่ pricing.js ต้องการ
    // 🔧 (2026-09-16): รองรับทั้ง snake_case (playlist_id/song_id — จาก app-cart.js)
    // และ camelCase (playlistId/songId — จาก orders.js addToCart/addToPlaylist)
    // ก่อนหน้านี้อ่านแค่ snake_case ทำให้ cartEntries ฝั่งแอดมิน (ที่ใช้ camelCase) ส่งค่า
    // "undefined" เข้า computeCartPricing → findActiveDiscountFor ไม่เจอ → ไม่มีส่วนลด
    const cartItems = cartEntries.map(entry => {
      if (entry.kind === "playlist") {
        return {
          kind: "playlist",
          playlist_id: entry.playlist_id || entry.playlistId || String(entry.id || "").replace(/^playlist:/, ""),
          price: Number(entry.price) || 0
        };
      } else {
        // song — หา category_id จาก state.songs
        const songId = entry.song_id || entry.songId || String(entry.id || "");
        const songData = state.songs.find(s => s.id === songId) || {};
        return {
          kind: "song",
          song_id: songId,
          price: Number(entry.price) || 0,
          category_id: songData.category_id || songData.categoryId || null
        };
      }
    });
    return computeCartPricing(cartItems, discounts, promotions);
  } catch (e) {
    console.warn("computeAdminPricing error:", e);
    // fallback: ไม่มี discount/promo
    const subtotal = cartEntries.reduce((s, e) => s + (Number(e.price) || 0), 0);
    return {
      subtotal,
      discountSubtotal: subtotal,
      itemDiscountAmount: 0,
      promoDiscountAmount: 0,
      discountAmount: 0,
      promotionApplied: null,
      finalTotal: subtotal
    };
  }
}

/* ---------------- Init (เรียกทุกครั้งที่เปิดหน้า "จัดการออเดอร์") ---------------- */
export async function initOrdersView() {
  const loadingEl = document.getElementById("ordSongsLoading");
  ensureReceiptElements();
  ensureFullFilesElements();
  loadingEl.style.display = "block";
  loadingEl.textContent = "กำลังโหลดรายชื่อเพลง...";

  try {
    // โหลดทั้งเพลงและเพลย์ลิสต์ (ราคาเหมา) พร้อมกัน เพื่อให้ระบบขายยกเพลย์ลิสต์ใช้งานได้ทันที
    const [songs, playlists, storeName] = await Promise.all([
      loadSongsFromDatabase(),
      loadPlaylistsFromDatabase(),
      loadStoreName(),
    ]);
    state.songs = songs;
    state.playlists = playlists;
    state.storeName = storeName;
    loadingEl.style.display = "none";
  } catch (err) {
    loadingEl.textContent = "โหลดข้อมูลไม่สำเร็จ: " + err.message;
    return;
  }

  if (!state.listenersBound) {
    document.getElementById("ordSongSearch").addEventListener("input", debounce(handleSearchInput, 200));
    document.getElementById("ordSubmitBtn").addEventListener("click", handleSubmitOrder);
    document.getElementById("ordPlaylistSearch").addEventListener("input", debounce(handlePlaylistSearchInput, 200));

    // 🔧 แก้บั๊ก I11 (2026-09-18): ปุ่ม "รีเฟรช" — โหลดออเดอร์ล่าสุดจาก DB โดยไม่ต้อง F5
    //   ใช้เมื่อ: สงสัยว่าข้อมูลไม่ใช่ล่าสุด / อยากเช็คว่ามีออเดอร์ใหม่ไหม / ก่อน action สำคัญ
    //   ทำงาน: เรียก refreshDashboardAndHistory() → โหลด orders ทั้งหมดจาก DB ใหม่ → render ใหม่
    const ordersRefreshBtnEl = document.getElementById("ordersRefreshBtn");
    if (ordersRefreshBtnEl) {
      ordersRefreshBtnEl.addEventListener("click", async () => {
        // แสดงสถานะ "กำลังรีเฟรช..." ขณะโหลด (กัน user กดซ้ำ)
        ordersRefreshBtnEl.style.opacity = "0.5";
        ordersRefreshBtnEl.style.pointerEvents = "none";
        try {
          await refreshDashboardAndHistory();
          // ใช้ toast ของ app-admin.js (ถ้ามี) หรือ console.log (fallback)
          if (window.__showToast) window.__showToast("รีเฟรชออเดอร์แล้ว", "success");
          else console.log("✅ รีเฟรชออเดอร์แล้ว");
        } catch (err) {
          console.error("รีเฟรชออเดอร์ไม่สำเร็จ:", err);
          if (window.__showToast) window.__showToast("รีเฟรชไม่สำเร็จ: " + (err?.message || err), "error");
        } finally {
          ordersRefreshBtnEl.style.opacity = "";
          ordersRefreshBtnEl.style.pointerEvents = "";
        }
      });
    }

    // ---- ค้นหาในประวัติออเดอร์ (เพิ่มใหม่ — ไม่กระทบระบบเดิม) ----
    const ordHistorySearchEl = document.getElementById("ordHistorySearch");
    if (ordHistorySearchEl) {
      ordHistorySearchEl.addEventListener("input", debounce(handleHistorySearchInput, 200));
    }
    const ordHistorySearchClearEl = document.getElementById("ordHistorySearchClear");
    if (ordHistorySearchClearEl) {
      ordHistorySearchClearEl.addEventListener("click", () => {
        state.historySearch = "";
        const inp = document.getElementById("ordHistorySearch");
        if (inp) inp.value = "";
        renderHistory();
      });
    }

    // ปุ่ม/ช่องค้นหาของ modal แก้ไขออเดอร์
    document.getElementById("eOrderSongSearch").addEventListener("input", debounce(handleEditSearchInput, 200));
    document.getElementById("eOrderSaveBtn").addEventListener("click", handleUpdateOrder);
    document.getElementById("orderFormClose").addEventListener("click", closeEditOrderModal);
    document.getElementById("orderFormBackdrop").addEventListener("click", (e) => {
      if (e.target.id === "orderFormBackdrop") closeEditOrderModal();
    });
    document.getElementById("eOrdPlaylistSearch").addEventListener("input", debounce(handleEditPlaylistSearchInput, 200));

    document.getElementById("receiptClose").addEventListener("click", closeReceipt);
    // ปุ่มคัดลอก/WhatsApp/ดาวน์โหลดรูป ถูกผูกกับ Order ที่เปิดอยู่ใน openReceipt() แทน (ต้องใช้ข้อมูล order ของแต่ละครั้ง)
    document.getElementById("receiptBackdrop").addEventListener("click", (e) => {
      if (e.target.id === "receiptBackdrop") closeReceipt();
    });

    document.getElementById("fullFilesClose").addEventListener("click", closeFullFilesModal);
    document.getElementById("fullFilesBackdrop").addEventListener("click", (e) => {
      if (e.target.id === "fullFilesBackdrop") closeFullFilesModal();
    });

    state.listenersBound = true;
  }

  // รีเซ็ตฟอร์มสร้างออเดอร์ใหม่ทุกครั้งที่เปิดหน้านี้
  state.cartEntries = [];
  state.searchResults = [];
  state.cartTotalEdited = false;
  state.playlistSearchResults = [];
  document.getElementById("ordSongSearch").value = "";
  document.getElementById("ordPlaylistSearch").value = "";
  document.getElementById("ordFormFeedback").textContent = "";
  // รีเซ็ตการค้นหาในประวัติออเดอร์ (เพิ่มใหม่ — กันค่าค้างจาก session ก่อน)
  state.historySearch = "";
  const ordHistorySearchInput = document.getElementById("ordHistorySearch");
  if (ordHistorySearchInput) ordHistorySearchInput.value = "";
  renderCart();
  renderSearchResults();
  renderPlaylistSelected();
  renderPlaylistSearchResults();

  await refreshDashboardAndHistory();
}
