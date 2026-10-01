// bridge/rawcut-protocol.js — đọc stdout/stderr của xmlcut.py.
// Định dạng lấy từ engine 3.93: `  >> {type}/{track}/{in}/{out} {file}` (xmlcut.py ~9267),
// `  [{done}/{total}] {FLAG} {file}` (~12241), lý do lỗi thụt 8 cách ngay sau đó,
// `++` = ghi chú gộp dump/XML, `!!` = cảnh báo. Chỉ OK và HAVE là thành công.
'use strict';

const RE_START  = /^\s*>>\s+(?:([a-z]+\/\d+\/\d+(?:\/\d+)?)\s+)?(.+)$/;
const RE_DONE   = /\[(\d+)\/(\d+)\]\s+(\S+)\s*(.*)$/;
const RE_NOTE   = /^\s*\+\+\s*(.+)$/;
const RE_WARN   = /^\s*!!\s*(.+)$/;
const RE_REASON = /^ {8}\S/;
const RE_LOCK   = /error: (another export is already writing into [\s\S]*?)\.?\s*$/;

function parseLine(line, prev) {
  let m;
  if ((m = RE_START.exec(line))) return { type: 'start', key: m[1] || null, file: m[2].trim() };
  if ((m = RE_NOTE.exec(line))) return { type: 'note', text: m[1].trim() };
  if ((m = RE_WARN.exec(line))) return { type: 'warn', text: m[1].trim() };
  if ((m = RE_DONE.exec(line))) {
    const flag = m[3];
    return { type: 'done', n: Number(m[1]), total: Number(m[2]), flag, file: m[4].trim(), ok: flag === 'OK' || flag === 'HAVE' };
  }
  if (/^\s*Cutting with\b/.test(line)) return { type: 'encoding' };
  if (prev && (prev.type === 'done' || prev.type === 'reason') && RE_REASON.test(line)) return { type: 'reason', text: line.trim() };
  return null;
}

// onEvent(ev) cho dòng có nghĩa, onLine(line) cho mọi dòng (để ghi log).
function createParser(onEvent, onLine) {
  let buf = '', prev = null;
  function line(l) {
    l = l.replace(/\r$/, '');
    if (onLine) onLine(l);
    const ev = parseLine(l, prev);
    if (ev) { prev = ev; if (onEvent) onEvent(ev); }
    else if (l.trim()) prev = null;
  }
  return {
    feed(chunk) {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { line(buf.slice(0, i)); buf = buf.slice(i + 1); }
    },
    end() { if (buf) { line(buf); buf = ''; } },
  };
}

function parseStderr(s) {
  s = String(s || '');
  const lock = RE_LOCK.exec(s);
  const lines = s.split('\n').map(x => x.replace(/\s+$/, '')).filter(Boolean);
  return { lock: lock ? lock[1].trim() : null, noCuts: /No cuts found/.test(s), tail: lines.slice(-6).join('\n') };
}

module.exports = { parseLine, createParser, parseStderr };
