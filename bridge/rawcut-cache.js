// bridge/rawcut-cache.js — nơi Premiere render từng cut cho nửa Timeline Render.
// Một thư mục cache / một thư mục edited/ (hash đường dẫn), giữ lại khi chạy lỗi để Retry
// dùng lại render cũ; xoá khi chạy sạch; entry quá 7 ngày bị dọn.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_ROOT = path.join(os.homedir(), 'Library', 'Caches', 'Raw-cutter', 'renders');
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;

function fnv1a64(s) {
  let h = 0xcbf29ce484222325n;
  const P = 0x100000001b3n;
  for (const b of Buffer.from(String(s), 'utf8')) {
    h ^= BigInt(b);
    h = (h * P) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, '0');
}

function renderCacheDir(outDir, root) {
  return path.join(root || DEFAULT_ROOT, fnv1a64(path.resolve(outDir)));
}

function pruneCache(root, maxAgeMs, now) {
  let names;
  try { names = fs.readdirSync(root); } catch (e) { return 0; }
  let removed = 0;
  for (const n of names) {
    const p = path.join(root, n);
    let st;
    try { st = fs.statSync(p); } catch (e) { continue; }
    if (st.isDirectory() && now - st.mtimeMs > maxAgeMs) {
      try { fs.rmSync(p, { recursive: true, force: true }); removed++; } catch (e) {}
    }
  }
  return removed;
}

function isUnder(root, p) {
  const rel = path.relative(path.resolve(root), path.resolve(p));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function freeBytes(dir) {
  const st = fs.statfsSync(dir);
  return Number(st.bavail) * Number(st.bsize);
}

module.exports = { DEFAULT_ROOT, MAX_AGE_MS, fnv1a64, renderCacheDir, pruneCache, isUnder, freeBytes };
