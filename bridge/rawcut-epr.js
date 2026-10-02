// bridge/rawcut-epr.js — preset H.264 cho Premiere render từng cut (port host.jsx H1082-1222, H2114-2365).
// Gốc là "Match Source - High bitrate" (theo size/fps của sequence); chỉ sửa 3 tham số bitrate.
// Không bao giờ ghi ADBEVideoBitrateEncoding (pass mode): ghi 1 đã làm treo render thật.
'use strict';
const fs = require('fs');
const path = require('path');

const PRESET_NAME = '_xmlcut_render.epr';
const PRESET_SUBDIR = path.join('Contents', 'MediaIO', 'systempresets', '4E49434B_48323634');
const STOCK_NAMES = ['00 - Match Source - High bitrate.epr', '01 - Match Source - High bitrate.epr',
  '00 - Match Source - Medium bitrate.epr', '01 - Match Source - Medium bitrate.epr'];

// Value chỉ được tìm TRONG block <ExporterParam …>…</ExporterParam> của chính identifier.
function eprValueSpan(xml, ident, field) {
  field = field || 'ParamValue';
  const at = xml.indexOf('<ParamIdentifier>' + ident + '</ParamIdentifier>');
  if (at < 0) return null;
  const start = xml.lastIndexOf('<ExporterParam ', at);
  if (start < 0) return null;
  const end = xml.indexOf('</ExporterParam>', start);
  if (end < at) return null;
  const block = xml.substring(start, end);
  const open = '<' + field + '>', shut = '</' + field + '>';
  const vs = block.indexOf(open);
  if (vs < 0) return null;
  const ve = block.indexOf(shut, vs);
  if (ve < 0) return null;
  return { from: start + vs + open.length, to: start + ve };
}

function patchEprParam(xml, ident, value) {
  const span = eprValueSpan(xml, ident);
  return span ? xml.substring(0, span.from) + value + xml.substring(span.to) : null;
}

function readEprParam(xml, ident) {
  const span = eprValueSpan(xml, ident);
  return span ? xml.substring(span.from, span.to) : null;
}

// 0 = file không khai giới hạn (không phải "giới hạn là 0").
function eprLimit(xml, ident, which) {
  const span = eprValueSpan(xml, ident, which);
  if (!span) return 0;
  const n = Number(String(xml.substring(span.from, span.to)).replace(/\.$/, ''));
  return n > 0 ? n : 0;
}

// Adobe ghi số nguyên dạng "10." — giữ đúng định dạng file vẫn dùng.
function eprNumber(n) {
  n = Math.round(Number(n) * 10) / 10;
  return n === Math.floor(n) ? String(Math.floor(n)) + '.' : String(n);
}

function planBitrate(mbps, xml) {
  let target = Number(mbps);
  let maxb = target * 1.2; // preset của Adobe để max cao hơn target 20%
  const capM = eprLimit(xml, 'ADBEVideoMaxBitrate', 'ParamMaxValue');
  const capT = eprLimit(xml, 'ADBEVideoTargetBitrate', 'ParamMaxValue');
  if (capM > 0 && maxb > capM) { maxb = capM; if (target > maxb / 1.2) target = maxb / 1.2; }
  if (capT > 0 && target > capT) { target = capT; if (maxb < target) maxb = target; }
  return { target, max: maxb, min: Math.min(2, target), capped: target !== Number(mbps) };
}

function writeRenderPreset(o) {
  let xml0;
  try { xml0 = fs.readFileSync(o.basePath, 'utf8'); } catch (e) { return { ok: false, error: 'Không đọc được preset gốc ' + o.basePath }; }
  if (!(Number(o.mbps) > 0)) return { ok: false, error: 'Không có bitrate để ghi' };
  const plan = planBitrate(o.mbps, xml0);
  let xml = xml0;
  const pairs = [['ADBEVideoTargetBitrate', eprNumber(plan.target)], ['ADBEVideoMaxBitrate', eprNumber(plan.max)], ['ADBEVideoMinBitrate', eprNumber(plan.min)]];
  for (const [id, v] of pairs) {
    const next = patchEprParam(xml, id, v);
    if (next === null) return { ok: false, error: 'Preset không có ' + id + ' — không đoán chỗ ghi, dùng preset gốc' };
    xml = next;
  }
  fs.mkdirSync(o.destDir, { recursive: true });
  const out = path.join(o.destDir, PRESET_NAME);
  fs.writeFileSync(out, xml, 'utf8');
  const back = fs.readFileSync(out, 'utf8');
  if (readEprParam(back, 'ADBEVideoTargetBitrate') !== eprNumber(plan.target) || readEprParam(back, 'ADBEVideoMaxBitrate') !== eprNumber(plan.max)) {
    return { ok: false, error: 'Preset đọc lại không đúng bitrate vừa ghi — không dùng' };
  }
  const pass = readEprParam(back, 'ADBEVideoBitrateEncoding');
  if (pass !== readEprParam(xml0, 'ADBEVideoBitrateEncoding')) return { ok: false, error: 'Pass mode của preset bị đổi — không dùng' };
  return { ok: true, path: out, target: plan.target, max: plan.max, min: plan.min, pass, capped: plan.capped };
}

// Premiere trước Media Encoder, bản mới trước. Mỗi app: thử STOCK_NAMES theo thứ tự.
function findStockPreset(o) {
  const appsDir = (o && o.appsDir) || '/Applications';
  const tried = [];
  let tops;
  try { tops = fs.readdirSync(appsDir).filter(n => /^Adobe (Premiere Pro|Media Encoder)/.test(n)); } catch (e) { tops = []; }
  tops.sort((a, b) => {
    const pa = /Premiere/.test(a) ? 0 : 1, pb = /Premiere/.test(b) ? 0 : 1;
    return pa !== pb ? pa - pb : b.localeCompare(a, undefined, { numeric: true });
  });
  for (const top of tops) {
    let apps;
    try { apps = fs.readdirSync(path.join(appsDir, top)).filter(n => n.endsWith('.app')); } catch (e) { continue; }
    for (const app of apps) {
      for (const name of STOCK_NAMES) {
        const p = path.join(appsDir, top, app, PRESET_SUBDIR, name);
        tried.push(p);
        if (fs.existsSync(p)) return { found: p, name: top + ' / ' + name, tried };
      }
    }
  }
  return { found: '', name: '', tried };
}

module.exports = { PRESET_NAME, eprValueSpan, patchEprParam, readEprParam, eprLimit, eprNumber, planBitrate, writeRenderPreset, findStockPreset };
