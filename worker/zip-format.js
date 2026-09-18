// worker/zip-format.js
// ===================================================
// Helpers สำหรับสร้าง ZIP file format แบบ streaming ฝั่ง Worker
// -----------------------------------------------------------
// ทำไมต้องเขียนเอง?
//   - JSZip ทำงานใน browser เท่านั้น ไม่มี streaming mode ที่ใช้กับ R2 Multipart Upload ได้
//   - บน Worker เราต้อง stream WAV ทีละ chunk ผ่าน CRC32 calculator แล้วส่งต่อเข้า R2 part
//     โดยไม่เก็บ WAV ทั้งไฟล์ใน memory (Worker memory limit 128MB → ไม่รองรับ WAV 100MB+)
//
// โครงสร้าง ZIP แบบสั้นๆ (ของจริงมีรายละเอียดมากกว่านี้ แต่เทียบเท่าที่เราใช้):
//   [Local File Header 1][File 1 bytes][Data Descriptor 1]
//   [Local File Header 2][File 2 bytes][Data Descriptor 2]
//   ...
//   [Central Directory Entry 1][Central Directory Entry 2]...
//   [End Of Central Directory Record (EOCD)]
//
// Trick สำคัญ: ใช้ "streaming mode" (bit flag 0x08) ทำให้ Local File Header
//   ไม่ต้องมี CRC32/compressedSize/uncompressedSize ล่วงหน้า — ส่งค่าเป็น 0 ใน LFH
//   แล้วส่ง "Data Descriptor" (มี CRC + sizes จริง) ต่อท้าย file bytes แทน
//   ทำให้เรา stream file ได้โดยไม่ต้องอ่านทั้งไฟล์ก่อน
//
// ผลกระทบต่อระบบเดิม: 0% — ไฟล์นี้เป็น dependency ใหม่ของ worker/index.js เท่านั้น
//   ไม่ถูก import โดยไฟล์อื่นใดในโปรเจกต์
// ===================================================

// ---------------- CRC32 ----------------
// Pre-compute table (standard CRC32 polynomial 0xEDB88320)
// เร็วกว่า per-bit loop มาก (ตาราง-lookup 8-bit ต่อ iteration)
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC_TABLE[n] = c >>> 0;
}

// อัปเดต CRC32 state ด้วย Uint8Array chunk (table-based)
// คืนค่า CRC32 ใหม่ (uint32) — call site เก็บ state ในตัวแปรเอง
export function crc32Update(crc, chunk) {
  let c = (crc ^ 0xFFFFFFFF) >>> 0;
  for (let i = 0; i < chunk.length; i += 1) {
    c = CRC_TABLE[(c ^ chunk[i]) & 0xFF] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// ---------------- ZIP constants (little-endian signatures) ----------------
export const ZIP_LFH_SIGNATURE       = 0x04034B50;  // PK\x03\x04
export const ZIP_CDH_SIGNATURE       = 0x02014B50;  // PK\x01\x02
export const ZIP_EOCD_SIGNATURE      = 0x06054B50;  // PK\x05\x06
export const ZIP_DATA_DESC_SIGNATURE = 0x08074B50;  // PK\x07\x08

// เวอร์ชั่นที่เราใช้: ZIP 2.0 (implies traditional compression flags)
const ZIP_VERSION_EXTRACT = 20;       // 2.0
const ZIP_VERSION_MADE_BY = 20;        // 2.0 + 0 (MS-DOS)
const ZIP_FLAG_STREAMING  = 0x08;      // bit 3 = data descriptor follows
const ZIP_FLAG_UTF8_NAMES  = 0x0800;   // bit 11 = filename is UTF-8
const ZIP_METHOD_STORE     = 0;        // no compression (เหมือนเดิมใน orders.js)
const DOS_EXTERNAL_ATTR_FILE = 0;      // binary 0000 0000 (normal file)

// ---------------- สร้าง Local File Header (streaming mode) ----------------
// ใช้ bit flag 0x08 (data descriptor follows) → ค่า CRC/sizes ใน LFH ตั้งเป็น 0
// ค่าจริงจะถูกส่งใน Data Descriptor ที่ต่อท้าย file bytes
//
// โครงสร้าง LFH (30 bytes + filename + extra):
//   [0..3]   signature            0x04034B50
//   [4..5]   version needed       20 (2.0)
//   [6..7]   general purpose bit flag  0x0808 (streaming + UTF-8)
//   [8..9]   compression method  0 (STORE)
//   [10..11] mod time            0 (unused)
//   [12..13] mod date            0 (unused)
//   [14..17] CRC-32              0 (ใน streaming mode)
//   [18..21] compressed size     0 (ใน streaming mode)
//   [22..25] uncompressed size   0 (ใน streaming mode)
//   [26..27] filename length     N
//   [28..29] extra field length  0
//   [30..]   filename (UTF-8 bytes)
export function buildLocalFileHeader(filenameBytes) {
  const fnameLen = filenameBytes.byteLength;
  const buf = new ArrayBuffer(30 + fnameLen);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  dv.setUint32(0, ZIP_LFH_SIGNATURE, true);
  dv.setUint16(4, ZIP_VERSION_EXTRACT, true);
  dv.setUint16(6, ZIP_FLAG_STREAMING | ZIP_FLAG_UTF8_NAMES, true);
  dv.setUint16(8, ZIP_METHOD_STORE, true);
  dv.setUint16(10, 0, true); // mod time
  dv.setUint16(12, 0, true); // mod date
  dv.setUint32(14, 0, true); // CRC (in data descriptor instead)
  dv.setUint32(18, 0, true); // compressed size (in data descriptor instead)
  dv.setUint32(22, 0, true); // uncompressed size (in data descriptor instead)
  dv.setUint16(26, fnameLen, true);
  dv.setUint16(28, 0, true); // extra field length
  u8.set(filenameBytes, 30);
  return u8;
}

// ---------------- สร้าง Data Descriptor ----------------
// ตามหลัง file bytes (เมื่อ bit flag 0x08 ตั้งอยู่)
// บาง unzip ต้องการ signature บางตัวไม่ต้อง — ใส่ signature ไว้เพื่อความเข้ากันได้สูงสุด
// โครงสร้าง (16 bytes with signature):
//   [0..3]   signature            0x08074B50
//   [4..7]   CRC-32
//   [8..11]  compressed size
//   [12..15] uncompressed size  (= compressed size for STORE)
export function buildDataDescriptor(crc32, size) {
  const buf = new ArrayBuffer(16);
  const dv = new DataView(buf);
  dv.setUint32(0, ZIP_DATA_DESC_SIGNATURE, true);
  dv.setUint32(4, crc32 >>> 0, true);
  dv.setUint32(8, size >>> 0, true);
  dv.setUint32(12, size >>> 0, true);
  return new Uint8Array(buf);
}

// ---------------- สร้าง Central Directory Entry สำหรับ 1 file ----------------
// โครงสร้าง (46 bytes + filename + extra + comment):
//   [0..3]   signature            0x02014B50
//   [4..5]   version made by      20 (2.0, MS-DOS)
//   [6..7]   version needed       20 (2.0)
//   [8..9]   general purpose bit flag  0x0808
//   [10..11] compression method  0 (STORE)
//   [12..13] mod time            0
//   [14..15] mod date            0
//   [16..19] CRC-32              (จริง)
//   [20..23] compressed size     (จริง)
//   [24..27] uncompressed size   (จริง, = compressed for STORE)
//   [28..29] filename length     N
//   [30..31] extra field length  0
//   [32..33] file comment length 0
//   [34..35] disk number start   0
//   [36..37] internal file attr   0
//   [38..41] external file attr   0
//   [42..45] local header offset  (จริง — offset จากต้นไฟล์)
//   [46..]   filename (UTF-8)
export function buildCentralDirectoryEntry(filenameBytes, crc32, size, localHeaderOffset) {
  const fnameLen = filenameBytes.byteLength;
  const buf = new ArrayBuffer(46 + fnameLen);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  dv.setUint32(0, ZIP_CDH_SIGNATURE, true);
  dv.setUint16(4, ZIP_VERSION_MADE_BY, true);
  dv.setUint16(6, ZIP_VERSION_EXTRACT, true);
  dv.setUint16(8, ZIP_FLAG_STREAMING | ZIP_FLAG_UTF8_NAMES, true);
  dv.setUint16(10, ZIP_METHOD_STORE, true);
  dv.setUint16(12, 0, true);
  dv.setUint16(14, 0, true);
  dv.setUint32(16, crc32 >>> 0, true);
  dv.setUint32(20, size >>> 0, true);
  dv.setUint32(24, size >>> 0, true);
  dv.setUint16(28, fnameLen, true);
  dv.setUint16(30, 0, true);
  dv.setUint16(32, 0, true);
  dv.setUint16(34, 0, true);
  dv.setUint16(36, 0, true);
  dv.setUint32(38, DOS_EXTERNAL_ATTR_FILE, true);
  dv.setUint32(42, localHeaderOffset >>> 0, true);
  u8.set(filenameBytes, 46);
  return u8;
}

// ---------------- สร้าง End Of Central Directory Record ----------------
// โครงสร้าง (22 bytes + comment):
//   [0..3]   signature            0x06054B50
//   [4..5]   disk number          0
//   [6..7]   disk with CD start   0
//   [8..9]   entries on this disk N
//   [10..11] total entries        N
//   [12..15] CD size              M
//   [16..19] CD offset            (จากต้นไฟล์)
//   [20..21] comment length       0
export function buildEndOfCentralDirectory(entriesCount, cdSize, cdOffset) {
  const buf = new ArrayBuffer(22);
  const dv = new DataView(buf);
  dv.setUint32(0, ZIP_EOCD_SIGNATURE, true);
  dv.setUint16(4, 0, true);
  dv.setUint16(6, 0, true);
  dv.setUint16(8, entriesCount, true);
  dv.setUint16(10, entriesCount, true);
  dv.setUint32(12, cdSize >>> 0, true);
  dv.setUint32(16, cdOffset >>> 0, true);
  dv.setUint16(20, 0, true);
  return new Uint8Array(buf);
}

// ---------------- แปลงชื่อไฟล์เป็น UTF-8 bytes ----------------
// Worker มี TextEncoder ให้แล้ว (global)
export function encodeFilename(name) {
  return new TextEncoder().encode(name);
}

// ---------------- concat Uint8Arrays ----------------
// ใช้กรณีต่อ LFH + WAV bytes (WAV ถูก stream แยก ไม่ได้ concat ใน memory)
// สำหรับกรณี Central Directory ที่ต้อง concat หลาย entry เป็น buffer เดียวก่อน upload
export function concatUint8(arrays) {
  let total = 0;
  for (const a of arrays) total += a.byteLength;
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.byteLength;
  }
  return out;
}

// ---------------- สร้าง ReadableStream สำหรับ 1 รายการเพลงใน ZIP ----------------
// รับ:
//   - filename: ชื่อไฟล์ใน ZIP (รวม path ถ้าอยู่ใน folder playlist)
//   - wavStream: ReadableStream ของ WAV จาก R2 (env.BUCKET.get(key).body)
//   - onDone (ไม่บังคับ): callback({ crc32, size }) ถูกเรียกเมื่อ stream สิ้นสุด
//     ใช้สำหรับ capture ค่า CRC/size จริงของ WAV (ไม่ใช่ CRC ของ bytes ทั้งหมดที่ผ่าน stream)
//     ทาง Worker จะใช้ค่านี้สร้าง Central Directory ในภายหลัง
// คืน: ReadableStream ที่ emit [LFH][WAV chunks][Data Descriptor] ตามลำดับ
//
// การทำงาน: pull-based streaming
//   1. emit LFH (30 bytes + filename)
//   2. pull WAV chunk จาก wavStream → update CRC32 + sizeCounter → emit chunk
//   3. เมื่อ WAV หมด → emit Data Descriptor (16 bytes) + เรียก onDone({ crc32, size })
//   4. close stream
//
// Memory footprint: ต่ำมาก — เก็บแค่ CRC state (4 bytes), size counter (number),
//   LFH buffer (~30+filename bytes) และ chunk buffer ปัจจุบันเท่านั้น
//
// ⚠️ สำคัญ: CRC32 ที่คำนวณที่นี่คือ CRC32 ของ **WAV bytes เท่านั้น** (ไม่รวม LFH และ DD)
//   เพราะ CRC32 ใน ZIP spec คือ CRC ของไฟล์ต้นฉบับ (uncompressed) — ไม่ใช่ CRC ของ ZIP entry bytes
//   ดังนั้น caller (Worker) ต้องใช้ค่า CRC ที่ส่งผ่าน onDone callback มาสร้าง Central Directory
//   ห้ามใช้ CRC ที่คำนวณเองจาก stream ที่ผ่านทั้งหมด (เพราะจะรวม LFH + DD bytes ด้วย → ผิด)
export function makeZipEntryStream(filename, wavStream, onDone) {
  const filenameBytes = encodeFilename(filename);
  const lfhBytes = buildLocalFileHeader(filenameBytes);
  const reader = wavStream.getReader();
  let crc = 0;
  let size = 0;
  let phase = 0; // 0=WAV, 1=DataDescriptor, 2=closed
  let lfhSent = false;
  let ddBytes = null;
  let onDoneCalled = false;

  return new ReadableStream({
    async pull(controller) {
      try {
        // emit LFH ก่อน (phase ยังไม่เปลี่ยน เพราะยังไม่ได้เริ่มอ่าน WAV)
        if (!lfhSent) {
          lfhSent = true;
          controller.enqueue(lfhBytes);
          return;
        }
        // Phase 0: pull WAV chunks → emit ทีละ chunk พร้อม update CRC
        if (phase === 0) {
          const { done, value } = await reader.read();
          if (done) {
            // ⚠️ สำคัญ: ต้อง enqueue DD ใน pull call เดียวกัน — ถ้า return เฉยๆ
            //   consumer จะรอ forever (ReadableStream pull ไม่ enqueue อะไร = deadlock)
            phase = 1;
            const dd = buildDataDescriptor(crc, size);
            controller.enqueue(dd);
            // เรียก onDone callback หลัง enqueue DD เสร็จ (ค่า crc/size สำเร็จแล้ว)
            if (onDone && !onDoneCalled) {
              onDoneCalled = true;
              try { onDone({ crc32: crc, size }); } catch (_) { /* ignore */ }
            }
            controller.close();
            return;
          }
          if (value && value.byteLength) {
            // ⚠️ คำนวณ CRC เฉพาะ WAV bytes (ไม่ใช่ LFH หรือ DD)
            // เพราะ CRC32 ใน ZIP spec คือ CRC ของไฟล์ต้นฉบับ เท่านั้น
            crc = crc32Update(crc, value);
            size += value.byteLength;
            controller.enqueue(value);
          }
          return;
        }
        // Phase 1: closed แล้ว — pull ไม่ควรถูกเรียกอีก
        // (ป้องกัน error if consumer ดึงซ้ำ)
        controller.close();
      } catch (err) {
        controller.error(err);
        try { reader.cancel(); } catch (_) { /* ignore */ }
      }
    },
    cancel() {
      try { reader.cancel(); } catch (_) { /* ignore */ }
    },
  });
}

// ---------------- สร้าง ReadableStream สำหรับ Central Directory + EOCD ----------------
// รับ: entries = [{ filename, crc32, size, offset, partSize }, ...]
//   - filename: ชื่อไฟล์ใน ZIP (รวม folderPath เช่น "PlaylistA/song2.wav")
//   - crc32: CRC32 ของ WAV bytes (จริง)
//   - size: ขนาดไฟล์ต้นฉบับ (WAV bytes) — ใช้สำหรับ compressed/uncompressed size ใน CD entry
//     (สำหรับ STORE method: compressed = uncompressed = WAV bytes ตาม ZIP spec)
//   - offset: ตำแหน่งของ Local File Header (LFH) ของ entry นี้ในไฟล์ ZIP
//     = ผลรวม partSize ของ entries ก่อนหน้า (partSize = LFH + WAV + DD total bytes)
//   - partSize: ขนาดรวมของ part นี้ในไฟล์ ZIP = LFH_size + WAV_size + DD_size
//     = (30 + filename_bytes_len) + WAV_size + 16
//     ใช้สำหรับคำนวณ cdOffset ที่ถูกต้อง
//
// ⚠️ สำคัญ: cdOffset ใน EOCD ต้องเป็นผลรวม partSize ของ entries ทั้งหมด
//   ไม่ใช่ผลรวม size (WAV bytes) — เพราะ CD อยู่ต่อจาก part สุดท้ายในไฟล์ ZIP
//   ถ้าคำนวณผิด → unzip จะบอก "extra bytes at beginning" หรือ "bad zipfile offset"
//
// คืน: ReadableStream ที่ emit [CD entry 1][CD entry 2]...[EOCD]
export function makeCentralDirectoryStream(entries) {
  return new ReadableStream({
    start(controller) {
      try {
        let cdSize = 0;
        // cdOffset = ตำแหน่งที่ Central Directory เริ่มต้นในไฟล์ ZIP
        // = ผลรวม partSize ของ entries ทั้งหมด (เพราะ CD อยู่ต่อจาก entries ทั้งหมด)
        let cdOffset = 0;
        for (const e of entries) {
          cdOffset += Number(e.partSize || 0);
        }
        for (const e of entries) {
          const filenameBytes = encodeFilename(e.filename);
          const cdEntry = buildCentralDirectoryEntry(
            filenameBytes,
            e.crc32,
            e.size,
            e.offset
          );
          cdSize += cdEntry.byteLength;
          controller.enqueue(cdEntry);
        }
        const eocd = buildEndOfCentralDirectory(entries.length, cdSize, cdOffset);
        controller.enqueue(eocd);
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });
}

// ---------------- สร้าง ReadableStream สำหรับ abort placeholder ----------------
// ใช้ตอนเริ่ม multipart upload: R2 API ไม่ต้องการ body ตอน createMultipartUpload
// แต่ helper ของเราอาจใช้ตอน build placeholder stream ในอนาคต
export function emptyStream() {
  return new ReadableStream({
    start(controller) { controller.close(); },
  });
}
