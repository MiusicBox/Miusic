// predeploy-check.mjs — ตรวจความพร้อมก่อน deploy (รัน: node predeploy-check.mjs)
// ตรวจ 5 อย่าง: ไฟล์ที่ต้องมี / ไวยากรณ์ JS ทุกไฟล์ / ไฟล์ที่ HTML+service worker อ้างถึง / .assetsignore / เวอร์ชัน cache
// ถ้ามี ❌ ให้แก้ก่อน แล้วค่อย `npx wrangler deploy` (ต้อง deploy ทั้งโฟลเดอร์ — รวม worker/ ด้วย ไม่ใช่แค่ไฟล์หน้าเว็บ)
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

let fail = 0;
const ok = (m) => console.log("✅", m);
const bad = (m) => { fail++; console.log("❌", m); };
const read = (f) => fs.readFileSync(f, "utf8");

// 1) ไฟล์จำเป็น
const required = ["index.html", "admin.html", "style.css", "notify.css", "notify.js", "service-worker.js",
  "worker/index.js", "worker/order-scope.js", "wrangler.jsonc", "_headers", ".assetsignore"];
const missing = required.filter((f) => !fs.existsSync(f));
missing.length ? bad("ไฟล์หาย: " + missing.join(", ")) : ok("ไฟล์จำเป็นครบ " + required.length + " ไฟล์");

// 2) ไวยากรณ์ JS (ทุกไฟล์ .js ในโฟลเดอร์หลัก + worker/)
const jsFiles = [...fs.readdirSync(".").filter((f) => f.endsWith(".js")),
  ...fs.readdirSync("worker").filter((f) => f.endsWith(".js")).map((f) => "worker/" + f)];
let synErr = 0;
for (const f of jsFiles) {
  const tmp = path.join(os.tmpdir(), "chk-" + path.basename(f) + ".mjs");
  fs.copyFileSync(f, tmp);
  try { execFileSync(process.execPath, ["--check", tmp], { stdio: "pipe" }); }
  catch (e) { synErr++; bad("syntax error: " + f + "\n   " + String(e.stderr || e.message).split("\n").slice(0, 3).join("\n   ")); }
}
if (!synErr) ok("ไวยากรณ์ JS ผ่านทั้งหมด " + jsFiles.length + " ไฟล์");

// 3) ไฟล์ที่ HTML อ้างถึง (src/href แบบ local) + notify ถูกโหลดทั้งสองหน้า
for (const page of ["index.html", "admin.html"]) {
  if (!fs.existsSync(page)) continue;
  const h = read(page);
  const refs = [...h.matchAll(/(?:src|href)="([^"#?:]+\.(?:js|css|json|svg|png))(?:\?[^"]*)?"/g)].map((m) => m[1]);
  const gone = [...new Set(refs)].filter((r) => !r.startsWith("/") && !fs.existsSync(r));
  gone.length ? bad(page + " อ้างถึงไฟล์ที่ไม่มี: " + gone.join(", ")) : ok(page + " อ้างถึงไฟล์ครบ");
  (h.includes("notify.css") && h.includes("notify.js")) ? ok(page + " โหลด notify.css/notify.js แล้ว") : bad(page + " ยังไม่ได้โหลด notify.css/notify.js");
}
// service worker precache
const sw = read("service-worker.js");
const pre = [...sw.matchAll(/'\/([^'\/][^']*\.[a-z]+)'/g)].map((m) => m[1]).filter((f) => !fs.existsSync(f));
pre.length ? bad("service-worker precache อ้างถึงไฟล์ที่ไม่มี: " + pre.join(", ")) : ok("service-worker precache ครบ");
(sw.includes("notify.js") && sw.includes("notify.css")) ? ok("service-worker cache notify.* แล้ว") : bad("service-worker ยังไม่ได้ cache notify.css/js");

// 4) .assetsignore ต้องกันไฟล์ภายใน
const ign = read(".assetsignore").split("\n").map((l) => l.trim());
const mustIgnore = ["worker", "scripts", "ai-team", "wrangler.jsonc", ".env"];
const notIgnored = mustIgnore.filter((x) => !ign.includes(x));
notIgnored.length ? bad(".assetsignore ยังไม่กัน: " + notIgnored.join(", ") + " (จะถูกเสิร์ฟสาธารณะ)") : ok(".assetsignore กันไฟล์ภายในครบ");

// 5) cache version
/CACHE_VERSION\s*=\s*['"]([^'"]+)['"]/.test(sw) ? ok("service-worker cache version: " + sw.match(/CACHE_VERSION\s*=\s*['"]([^'"]+)['"]/)[1]) : console.log("ℹ️ ไม่พบ CACHE_VERSION (ข้าม)");

console.log(fail ? `\n❌ พบ ${fail} ปัญหา — อย่าเพิ่ง deploy` : "\n🎉 พร้อม deploy: npx wrangler deploy");
process.exit(fail ? 1 : 0);
