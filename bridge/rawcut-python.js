// bridge/rawcut-python.js — tìm python3 ≥3.8 cho engine Raw-cutter.
// Thứ tự: PYTHON_BIN (.env) → Homebrew → /usr/local → /usr/bin. /usr/bin/python3 để cuối:
// trên máy chưa có Command Line Tools nó là stub bật hộp thoại cài đặt — chạy thử có timeout.
'use strict';
const fs = require('fs');
const { execFileSync } = require('child_process');

const CANDIDATES = ['/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3'];

function parseVer(s) {
  const m = /^(\d+)\.(\d+)/.exec(String(s || '').trim());
  return m ? [Number(m[1]), Number(m[2])] : null;
}

function okVer(v) {
  return !!v && (v[0] > 3 || (v[0] === 3 && v[1] >= 8));
}

function defaultRun(p) {
  return execFileSync(p, ['-c', 'import sys;print("%d.%d" % sys.version_info[:2])'],
    { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
}

function defaultExists(p) {
  try { return fs.statSync(p).isFile(); } catch (e) { return false; }
}

function findPython(deps) {
  deps = deps || {};
  const env = deps.env || process.env;
  const exists = deps.exists || defaultExists;
  const run = deps.run || defaultRun;
  const list = (env.PYTHON_BIN ? [env.PYTHON_BIN] : []).concat(CANDIDATES);
  const tried = [];
  for (const p of list) {
    if (!exists(p)) { tried.push(p + ': không có'); continue; }
    let out;
    try { out = run(p); } catch (e) { tried.push(p + ': không chạy được'); continue; }
    const v = parseVer(out);
    if (okVer(v)) return { ok: true, bin: p, version: v.join('.'), tried };
    tried.push(p + ': bản ' + (v ? v.join('.') : '?') + ' (cần ≥3.8)');
  }
  return { ok: false, bin: '', version: '', tried };
}

module.exports = { findPython, parseVer, CANDIDATES };
