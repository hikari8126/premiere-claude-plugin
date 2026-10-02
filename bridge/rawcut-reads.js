// bridge/rawcut-reads.js — mỗi lần Read timeline: lưu dump JSON + FCP XML cạnh project.
// Port từ host.jsx (readFolderFor H369, pruneOldReads H394, safeName H305). Thư mục có thể
// nằm trên shared drive nên prune chỉ xoá đúng file tên dạng thời gian.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const KEEP_READS = 10;
const READ_RE = /^\d{4}-\d{2}-\d{2}_\d{6}\.(json|xml)$/;

function safeName(s) {
  s = String(s == null ? '' : s)
    .replace(/[\/:\\]/g, '-')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/^[\s.]+|[\s.]+$/g, '');
  if (!s) s = 'Untitled Sequence';
  return s.slice(0, 80);
}

function stamp(d) {
  d = d || new Date();
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

function readFolderFor(projectPath, seqName, home) {
  if (projectPath && path.isAbsolute(projectPath)) {
    return { dir: path.join(path.dirname(projectPath), 'xmlcut', safeName(seqName)), besideProject: true };
  }
  return { dir: path.join(home || os.homedir(), 'Desktop', 'xmlcut-dumps', safeName(seqName)), besideProject: false };
}

function pruneReads(dir, keep) {
  keep = keep || KEEP_READS;
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { return 0; }
  const stamps = Array.from(new Set(names.filter(n => READ_RE.test(n)).map(n => n.replace(/\.(json|xml)$/, '')))).sort().reverse();
  let removed = 0;
  for (const s of stamps.slice(keep)) {
    for (const ext of ['.json', '.xml']) {
      try { fs.unlinkSync(path.join(dir, s + ext)); removed++; } catch (e) {}
    }
  }
  return removed;
}

function saveRead(o) {
  const f = readFolderFor(o.projectPath, o.sequenceName, o.home);
  fs.mkdirSync(f.dir, { recursive: true });
  const s = stamp(o.now);
  const json = path.join(f.dir, s + '.json');
  fs.writeFileSync(json, JSON.stringify(o.dump));
  let xml = null;
  if (o.xmlPath) {
    xml = path.join(f.dir, s + '.xml');
    fs.copyFileSync(o.xmlPath, xml);
  }
  const pruned = pruneReads(f.dir);
  return { json, xml, dir: f.dir, besideProject: f.besideProject, stamp: s, pruned };
}

module.exports = { safeName, stamp, readFolderFor, pruneReads, saveRead, KEEP_READS };
