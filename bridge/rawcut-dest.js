// bridge/rawcut-dest.js — thư mục xuất của Raw-cutter:
//   <Sản phẩm>/Output/ACT/<version>/raw|edited    (sản phẩm trong SAMX_WORKSPACE, hoặc có Output/)
//   <thư mục tự chọn>/<version>/raw|edited        (thư mục "tự do")
// Port quy tắc từ main.js của panel CEP 3.93 (seqVersion M3060, nextSaid M3127, versionKey,
// projectProduct M3168, saveToProduct M3182, chosenLayout, productRoute M3538, resolveDest
// M3788, resolveBoth M3960, folderTaken M4237 + folderRecord/folderExport/folderLedger).
// Bỏ phần chỉ có ở CEP: cache, localStorage (plugin gửi `chosen` / `productPick` theo project),
// Save to (không còn — thiếu đích thì trả needPick), vẽ UI, câu nhắc về Save to.
// ⚠️ Mỗi lần gọi đều hỏi lại đĩa, không cache: Tech tạo/đổi tên thư mục giữa Read và Export
// thì câu trả lời phải theo đĩa lúc đó.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const SAMX = 'SAMX_WORKSPACE';
const DRIVE_SHARED = 'Shared drives';     // thư mục ổ chung của Google Drive for desktop
const DRIVE_MOUNT = 'CloudStorage';       // ~/Library/CloudStorage
const DRIVE_ACCOUNT = 'GoogleDrive-';     // tiền tố thư mục từng tài khoản

// ── Version đọc từ TÊN SEQUENCE ─────────────────────────────────────────────
// ⚠️ "Chữ cái" không chỉ A-Z: tiếng Việt ("Phởv1" không có version), Hy Lạp, Kirin và dấu
// tổ hợp (chữ "ở" dạng tách NFD để lại dấu trước chữ v). Viết bằng dải \u thay cho \p{L}.
const VERSION_LETTER = 'A-Za-z0-9\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u024F'
  + '\\u0300-\\u036F\\u0370-\\u03FF\\u0400-\\u04FF\\u1E00-\\u1EFF';
// v / vid phải MỞ ĐẦU một từ, số phải KẾT THÚC từ: lookahead chặn chữ, số, ".số" và ",số"
// (dấu phẩy thập phân kiểu Việt "v1,2" bị từ chối chứ không đọc thành v1).
const VERSION_RE_SRC = '(^|[^' + VERSION_LETTER + '])(vid\\s*|v)(\\d+(?:\\.\\d+)*)'
  + '(?!\\.?[' + VERSION_LETTER + ']|,\\d)';
// Tên "trông như có version" (V 1.2, v.1.2, [v1.2], v1,2) → câu từ chối nói rõ dạng không đọc.
const VERSION_LOOKALIKE = new RegExp('(^|[^' + VERSION_LETTER + '])v(?:id)?[\\s.,]*\\d', 'i');
// Số có dấu chấm đứng riêng ("Brand 1.1") — chỉ là cách CUỐI CÙNG, khi không có vid/v nào.
// Không có chấm ("GV 2", "Copy 01") hoặc dính chữ ("FB9.16(O)") thì không phải version.
const VERSION_BARE_SRC = '(^|[^' + VERSION_LETTER + '.])(\\d+\\.\\d+(?:\\.\\d+)*)'
  + '(?!\\.?[' + VERSION_LETTER + ']|,\\d)';

// Bỏ handle trong ngoặc vuông: [a.b] nguyên vẹn, rồi "a.b]" mất "[" và "[a.b" mất "]".
function stripHandles(s) {
  return String(s).replace(/\[[^\]]*\]/g, ' ').replace(/\S*\]/g, ' ').replace(/\[\S*/g, ' ');
}

function qn(s) {
  return '“' + String(s === null || s === undefined || s === '' ? '?' : s) + '”';
}

// "v1", "v1.0", "V1.0.0" là MỘT version; "v1.2" và "v1.20" là hai. '' nếu không phải tên version.
function versionKey(v) {
  const m = /^\s*v(\d+(?:\.\d+)*)\s*$/i.exec(String(v === null || v === undefined ? '' : v));
  if (!m) return '';
  const g = m[1].split('.').map(x => String(parseInt(x, 10)));
  while (g.length > 1 && g[g.length - 1] === '0') g.pop();
  return g.join('.');
}

function sameVersion(a, b) {
  const ka = versionKey(a);
  return !!ka && ka === versionKey(b);
}

// → {version:'v13.0', said:'vid 13.0', why:''} hoặc {version:'', why:<câu từ chối>, two?:true}.
// vid thắng v; hai số KHÁC nhau thì từ chối, không đoán (số giống nhau là một).
function seqVersion(name) {
  const raw = String(name === null || name === undefined ? '' : name);
  const s = stripHandles(raw);
  const re = new RegExp(VERSION_RE_SRC, 'gi');
  const vids = [], vs = [];
  let m;
  while ((m = re.exec(s)) !== null) {
    const isVid = /^vid/i.test(m[2]);
    const list = isVid ? vids : vs;
    const v = 'v' + m[3];
    if (!list.some(x => sameVersion(x.version, v))) {
      list.push({ version: v, said: (isVid ? 'vid ' : m[2]) + m[3] });
    }
  }
  const q = qn(raw);
  const pick = vids.length ? vids : vs;
  if (pick.length > 1) {
    return { version: '', two: true, why: 'Tên sequence ' + q + ' có hai '
      + (vids.length ? 'số vid' : 'version') + ' khác nhau, ' + pick[0].said + ' và '
      + pick[1].said + ' — chỉ giữ một trong tên rồi bấm Read lại.' };
  }
  const lookalike = VERSION_LOOKALIKE.test(raw);
  if (!pick.length && !lookalike) {
    const bre = new RegExp(VERSION_BARE_SRC, 'g'), bares = [];
    while ((m = bre.exec(s)) !== null) {
      const v = 'v' + m[2];
      if (!bares.some(x => sameVersion(x.version, v))) bares.push({ version: v, said: m[2] });
    }
    if (bares.length > 1) {
      return { version: '', two: true, why: 'Tên sequence ' + q + ' có hai số version khác nhau, '
        + bares[0].said + ' và ' + bares[1].said + ' — chỉ giữ một trong tên rồi bấm Read lại.' };
    }
    if (bares.length) return { version: bares[0].version, said: bares[0].said, why: '' };
  }
  if (!pick.length && lookalike) {
    return { version: '', why: 'Tên sequence ' + q + ' không có version đọc được — đọc được '
      + '“v1.2” hay “vid 13.0”, nhưng không đọc chữ v có dấu cách hoặc dấu chấm trước số, '
      + 'dấu phẩy thập phân (viết “v1.2”, không phải “v1,2”), chữ dính liền sau số, hay bất cứ '
      + 'gì trong ngoặc vuông. Sửa tên trong Premiere rồi bấm Read lại.' };
  }
  if (!pick.length) {
    return { version: '', why: 'Tên sequence ' + q + ' không có version — thêm version như '
      + '“v1.2” hoặc “vid 13.0” vào tên trong Premiere rồi bấm Read lại.' };
  }
  return { version: pick[0].version, said: pick[0].said, why: '' };
}

// ── Đĩa ───────────────────────────────────────────────────────────────────
function isDir(p) {
  try { return !!p && fs.statSync(p).isDirectory(); } catch (e) { return false; }
}

// Thư mục con theo QUY TẮC (không phân biệt hoa thường…), trả TÊN THẬT trên đĩa. Sắp xếp để
// luôn ra cùng kết quả; đúng chính tả ưu tiên (`prefer`) thì thắng luôn.
function childDir(dir, match, prefer) {
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { return ''; }
  names = names.map(String).sort();
  let hit = '';
  for (const n of names) {
    if (!match(n) || !isDir(path.join(dir, n))) continue;
    if (n === prefer) return n;
    if (!hit) hit = n;
  }
  return hit;
}

// Một FILE (không phải thư mục) trùng tên — mọi kiểu hoa thường — đúng chỗ thư mục sắp tạo.
function blockingFile(dir, name) {
  let names;
  const want = String(name).toLowerCase();
  try { names = fs.readdirSync(dir); } catch (e) { return ''; }
  for (const n of names.map(String)) {
    if (n.toLowerCase() === want && !isDir(path.join(dir, n))) return n;
  }
  return '';
}

// Giữ đuôi đường dẫn (phần nhận ra được nó) cho câu thông báo.
function shortPath(p, keep) {
  p = String(p || '');
  keep = keep || 44;
  if (p.length <= keep) return p;
  const parts = p.split('/');
  let out = parts.pop() || '';
  while (parts.length) {
    const next = parts.pop();
    if (next === '') continue;
    if (('…/' + next + '/' + out).length > keep) break;
    out = next + '/' + out;
  }
  if (out.length + 2 > keep) return '…' + out.substring(out.length - keep + 1);
  return '…/' + out;
}

// ── Sản phẩm ────────────────────────────────────────────────────────────────
// ".../SAMX_WORKSPACE/<Product>/Asset/project/x.prproj" → ".../SAMX_WORKSPACE/<Product>".
// Đoạn sau SAMX_WORKSPACE phải là THƯ MỤC (project nằm thẳng trong SAMX không có sản phẩm).
function projectProduct(projectPath) {
  const parts = String(projectPath || '').split('/');
  for (let i = 0; i < parts.length - 2; i++) {
    if (parts[i].toLowerCase() === 'samx_workspace' && parts[i + 1]) {
      return parts.slice(0, i + 2).join('/');
    }
  }
  return '';
}

// Chọn Output/, Output/ACT/, thư mục version hay raw|edited bên trong = cùng một sản phẩm.
function saveToProduct(p) {
  const at = String(p || '').replace(/\/+$/, '');
  if (!at) return '';
  const up1 = path.dirname(at), up2 = path.dirname(up1), up3 = path.dirname(up2);
  const low = x => path.basename(x).toLowerCase();
  if ((low(at) === 'raw' || low(at) === 'edited') && low(up2) === 'act' && low(up3) === 'output') return path.dirname(up3);
  if (low(up1) === 'act' && low(up2) === 'output') return path.dirname(up2);
  if (low(at) === 'act' && low(up1) === 'output') return up2;
  if (low(at) === 'output') return up1;
  return at;
}

const isMode = n => { const l = String(n).toLowerCase(); return l === 'raw' || l === 'edited'; };

// Thư mục tự do: chọn chính <folder>/v1.1/raw hoặc <folder>/v1.1 (đang chứa raw|edited) thì
// là <folder>. Chỉ đi lên khi nhận ra đúng bố cục này — "v2" rỗng tự tạo vẫn là chính nó.
function freeBase(at) {
  const up = path.dirname(at);
  if (isMode(path.basename(at)) && versionKey(path.basename(up))) return path.dirname(up);
  if (versionKey(path.basename(at)) && childDir(at, isMode, '')) return up;
  return at;
}

// Thư mục chọn tay là gì: samx (trong một sản phẩm SAMX) / product (có Output/, hoặc là
// Output|ACT|version|mode của nó) / samxroot (chính SAMX_WORKSPACE) / root ("/") / free.
// ⚠️ `walk` chỉ bật LÚC CHỌN (rồi lưu thư mục đã đi lên) — đi lên lại ở mỗi lần resolve sẽ
// dời đích sang chỗ không ai chọn khi raw/ của v1.1 bị chuyển đi.
function chosenLayout(p, walk) {
  const at = String(p || '').replace(/\/+$/, '');
  const out = { kind: '', product: '', base: '' };
  if (!at) { if (/^\/+$/.test(String(p || ''))) out.kind = 'root'; return out; }
  const sp = projectProduct(at + '/');
  if (sp) { out.kind = 'samx'; out.product = sp; return out; }
  if (path.basename(at).toLowerCase() === 'samx_workspace') { out.kind = 'samxroot'; return out; }
  const prod = saveToProduct(at);
  if (prod !== at || childDir(at, n => n.toLowerCase() === 'output', 'Output')) {
    out.kind = 'product';
    out.product = prod;
    return out;
  }
  out.kind = 'free';
  out.base = walk ? freeBase(at) : at;
  return out;
}

// Thư mục nên lưu khi người dùng vừa chọn: thư mục tự do đã đi lên, còn lại giữ nguyên.
function chosenFolder(at) {
  const lay = chosenLayout(at, true);
  return lay.kind === 'free' ? lay.base : String(at || '');
}

// Tên thư mục như người đọc hiểu: NFC (đĩa Mac trả dạng tách), gộp khoảng trắng, chữ thường.
function nameKey(s) {
  let t = String(s === null || s === undefined ? '' : s);
  try { t = t.normalize('NFC'); } catch (e) {}
  return t.replace(/\s+/g, ' ').replace(/^ | $/g, '').toLowerCase();
}
function alnumKey(s) {
  return nameKey(s).replace(/[^a-z0-9ß-öø-ɏḀ-ỿ]/g, '');
}

// Mọi thư mục "Shared drives" tổ tiên của đường dẫn, trong cùng trước:
// {root: '.../Shared drives', drive, below: [các THƯ MỤC dưới drive, không gồm tên file]}.
function sharedDrivesOf(projectPath) {
  const parts = String(projectPath || '').split('/'), want = DRIVE_SHARED.toLowerCase();
  const out = [];
  for (let i = parts.length - 3; i >= 0; i--) {
    if (parts[i].toLowerCase() === want && parts[i + 1]) {
      out.push({ root: parts.slice(0, i + 1).join('/'), drive: parts[i + 1],
                 below: parts.slice(i + 2, parts.length - 1).filter(x => !!x) });
    }
  }
  return out;
}

// SAMX_WORKSPACE cạnh một thư mục "Shared drives", theo chính tả thật; '' nếu không có.
function samxBeside(root) {
  if (!root) return '';
  const s = childDir(root, n => n.toLowerCase() === 'samx_workspace', SAMX);
  return s ? path.join(root, s) : '';
}

// SAMX_WORKSPACE trong tài khoản Google Drive for desktop đầu tiên có nó.
function cloudSamx(opts) {
  opts = opts || {};
  const cs = opts.cloudStorage || path.join(opts.home || os.homedir(), 'Library', DRIVE_MOUNT);
  let names = [];
  try { names = fs.readdirSync(cs).map(String).sort(); } catch (e) { names = []; }
  for (const n of names) {
    if (n.indexOf(DRIVE_ACCOUNT) !== 0) continue;
    const p = path.join(cs, n, DRIVE_SHARED, SAMX);
    if (isDir(p)) return p;
  }
  return '';
}

// SAMX_WORKSPACE của project: chứa project → cạnh ổ chung của project (trong ra ngoài) →
// tài khoản Drive for desktop (chỉ khi project nằm trên ổ chung, như bản gốc). '' nếu không có.
// opts: {cloudStorage?, home?} — tiêm được cho test.
function findSamx(projectPath, opts) {
  const own = projectProduct(projectPath);
  if (own) return path.dirname(own);
  return samxRoute(projectPath, opts).samx;
}

function samxRoute(projectPath, opts) {
  const drives = sharedDrivesOf(projectPath);
  let sd = drives[0] || null, samx = '';
  for (const d of drives) {
    const b = samxBeside(d.root);
    if (b) { sd = d; samx = b; break; }
  }
  if (sd && !samx) samx = cloudSamx(opts);
  return { sd, samx, drives };
}

// Các thư mục sản phẩm trong SAMX_WORKSPACE, đã sắp xếp (bỏ tên bắt đầu bằng ".").
function samxProducts(samx) {
  const out = [];
  let ents = null;
  try { ents = fs.readdirSync(samx, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of ents) {
    const n = String(e.name);
    if (n.charAt(0) === '.') continue;
    if (e.isDirectory() || (e.isSymbolicLink() && isDir(path.join(samx, n)))) out.push(n);
  }
  return out.sort();
}

// Độ giống (chỉ để SẮP XẾP menu): 1 cùng chữ+số, 2 tên này mở đầu tên kia ở ranh giới từ,
// 3 như 2 nhưng chỉ chữ+số, 4 tên này nằm trong tên kia. 0 = không phải ứng viên.
function candidateScore(name, below) {
  let best = 0;
  const nk = nameKey(name), na = alnumKey(name);
  const starts = (lng, sht) => sht.length >= 3 && lng.length > sht.length && lng.indexOf(sht) === 0
    && !/[a-zß-öø-ɏḀ-ỿ]/.test(lng.charAt(sht.length));
  for (const b of below) {
    const ck = nameKey(b), ca = alnumKey(b);
    let s = 0;
    if (!ck) continue;
    if (na && na === ca) s = 1;
    else if (starts(ck, nk) || starts(nk, ck)) s = 2;
    else if (na.length >= 4 && ca.length >= 4 && (ca.indexOf(na) === 0 || na.indexOf(ca) === 0)) s = 3;
    else if ((nk.length >= 4 && ck.indexOf(nk) >= 0) || (ck.length >= 4 && nk.indexOf(ck) >= 0)
             || (na.length >= 5 && ca.indexOf(na) >= 0) || (ca.length >= 5 && na.indexOf(ca) >= 0)) s = 4;
    if (s && (!best || s < best)) best = s;
  }
  return best;
}

// Sản phẩm có tên TRÙNG ĐÚNG (nameKey) một thư mục của đường dẫn.
function matchedProducts(names, below) {
  const keys = new Set(below.map(nameKey).filter(Boolean));
  return names.filter(n => keys.has(nameKey(n)));
}

// Thư mục MỞ ĐẦU bằng tên sản phẩm, theo sau là dấu phân cách (không phải chữ/số) và KHÔNG
// phải một version ("Brand 2 - …", "Brand v2" có thể là sản phẩm khác → để menu hỏi).
const LEAD_VERSION_RE = /^[\s\-_.,:–—]*(?:\d|(?:v|ver|version)\.?\s*(?:\d|[a-z](?![a-z])))/;
function leadingProducts(names, below) {
  const hit = [];
  for (const name of names) {
    const nk = nameKey(name);
    if (nk.length < 3) continue;
    for (const b of below) {
      const ck = nameKey(b);
      if (ck.length <= nk.length || ck.indexOf(nk) !== 0) continue;
      const rest = ck.slice(nk.length);
      if (/[a-z0-9ß-öø-ɏḀ-ỿ]/.test(rest.charAt(0))) continue;
      if (LEAD_VERSION_RE.test(rest)) continue;
      hit.push(name);
      break;
    }
  }
  return hit;
}

// Sản phẩm mà tên (chỉ chữ+số) MỞ ĐẦU tên sequence: "CurvyFlex2.0 vid14.1" → "CurvyFlex 2.0".
// Nhiều sản phẩm cùng khớp ("CurvyFlex", "CurvyFlex 2.0") → lấy tên DÀI nhất; cùng dài → trả cả hai.
function sequenceProducts(names, seqName) {
  const sk = alnumKey(stripHandles(seqName));
  if (sk.length < 4) return [];
  let best = 0, hits = [];
  for (const n of names) {
    const nk = alnumKey(n);
    if (nk.length < 4 || sk.indexOf(nk) !== 0) continue;
    if (nk.length > best) { best = nk.length; hits = [n]; } else if (nk.length === best) hits.push(n);
  }
  return hits;
}

// Sản phẩm có version ở đuôi ("CurvyFlex 2.0", "EllaCurve3") mà phần tên gốc MỞ ĐẦU một thư mục
// của project, theo sau là dấu phân cách: "CurvyFlex (BEVA ZoeyFlex v.A) - Side Smoothing…".
const VERSION_TAIL_RE = /[\s\-_.]*(?:v(?:er(?:sion)?)?\.?\s*)?\d+(?:\.\d+)*$/;
function baseLeadProducts(names, below) {
  const hits = [];
  for (const n of names) {
    const nk = nameKey(n), base = nk.replace(VERSION_TAIL_RE, '');
    if (base === nk || base.length < 4) continue;
    for (const b of below) {
      const ck = nameKey(b);
      if (ck.indexOf(base) !== 0) continue;
      const rest = ck.slice(base.length);
      if (rest && /[a-z0-9ß-öø-ɏḀ-ỿ]/.test(rest.charAt(0))) continue;
      hits.push(n);
      break;
    }
  }
  return hits;
}

// Bỏ version ở đuôi CẢ HAI phía rồi so chữ+số: thư mục "EaseMotions 2" → sản phẩm "EaseMotions",
// "NavieLift" → "NavieLift 2.0". Chỉ thư mục không phải thư mục làm việc chung.
function tailProducts(names, below) {
  const strip = s => alnumKey(nameKey(s).replace(VERSION_TAIL_RE, ''));
  const keys = below.filter(b => !GENERIC_FOLDER_RE.test(nameKey(b))).map(strip).filter(k => k.length >= 4);
  if (!keys.length) return [];
  return names.filter(n => keys.indexOf(strip(n)) >= 0);
}

function sharedLead(name, below) {
  const nk = nameKey(name);
  let best = 0;
  for (const b of below) {
    const ck = nameKey(b);
    let n = 0;
    while (n < nk.length && n < ck.length && nk.charAt(n) === ck.charAt(n)) n++;
    if (n > best) best = n;
  }
  return best;
}

// Ứng viên giống nhất trước: điểm, rồi phần chung ở đầu DÀI hơn, rồi tên.
function productCandidates(names, below) {
  const scored = [];
  for (const n of names) {
    const s = candidateScore(n, below);
    if (s) scored.push({ n, s, lead: sharedLead(n, below) });
  }
  scored.sort((a, b) => (a.s - b.s) || (b.lead - a.lead) || (a.n < b.n ? -1 : a.n > b.n ? 1 : 0));
  return scored.map(x => x.n);
}

// Thư mục "sản phẩm" để câu từ chối nhắc tên: thư mục đầu tiên dưới drive không phải thư mục
// làm việc chung (Video, Projects 2026…).
const GENERIC_FOLDER_RE = new RegExp('^(?:videos?|projects?|project files?|editing files?|edit'
  + '|editing|outputs?|assets?|sources?|footage|exports?|renders?|raw|edited|premiere'
  + '|ae|after effects|files?|work|wip|archive|old|backup)(?:[ _.\\-]*\\d[\\d ._\\-]*)?$');
function productFolderOf(below) {
  for (const b of below) {
    const k = nameKey(b);
    if (k && !GENERIC_FOLDER_RE.test(k)) return b;
  }
  return '';
}

// Đường đi sản phẩm của project nằm trên ổ chung KHÁC (không trong SAMX_WORKSPACE):
// khớp đúng / khớp phần đầu / chọn từ menu. null khi không áp dụng.
function productRoute(projectPath, productPick, opts, seqName) {
  const pp = String(projectPath || '');
  if (!pp || projectProduct(pp)) return null;
  const sr = samxRoute(pp, opts);
  if (!sr.sd || !sr.samx) return null;
  const names = samxProducts(sr.samx);
  const below = sr.sd.below;
  const matches = matchedProducts(names, below);
  const lead = matches.length ? [] : leadingProducts(names, below);
  if (lead.length > 1) {
    const ord = productCandidates(names, below);
    const at = n => { const i = ord.indexOf(n); return i < 0 ? ord.length : i; };
    lead.sort((a, b) => (at(a) - at(b)) || (a < b ? -1 : a > b ? 1 : 0));
  }
  // Cùng một sản phẩm hay mang tên khác nhau giữa SAMX và ổ của team ("CurvyFlex 2.0" vs
  // "CurvyFlex (BEVA ZoeyFlex v.A) - …") → dò thêm tên sequence, rồi tên gốc bỏ version.
  // Còn nhiều hơn một ứng viên thì KHÔNG đoán (xuất nhầm sản phẩm là lỗi khó thấy) → menu.
  const seqHit = matches.length ? [] : sequenceProducts(names, seqName);
  let by = matches.length === 1 ? 'exact' : '', auto = matches.length === 1 ? matches[0] : '', multi = [];
  if (!matches.length) {
    const leadSeq = lead.filter(n => seqHit.indexOf(n) >= 0);
    if (lead.length === 1) { auto = lead[0]; by = 'lead'; }
    else if (lead.length > 1 && leadSeq.length === 1) { auto = leadSeq[0]; by = 'sequence'; }
    else if (!lead.length && seqHit.length === 1) { auto = seqHit[0]; by = 'sequence'; }
    else if (!lead.length) {
      const base = baseLeadProducts(names, below);
      if (base.length === 1) { auto = base[0]; by = 'base'; }
      else multi = seqHit.length > 1 ? seqHit : base;
    }
  }
  // Còn trượt: thư mục mang version ở đuôi mà sản phẩm thì không ("EaseMotions 2" ↔ "EaseMotions"),
  // hoặc chỉ tên file .prproj gọi tên sản phẩm ("…/Template/Editing File/SolviEase.prproj").
  if (!auto && !multi.length && matches.length < 2 && lead.length < 2) {
    const tail = tailProducts(names, below);
    if (tail.length === 1) { auto = tail[0]; by = 'tail'; }
    else if (tail.length > 1) multi = tail;
    else {
      const file = path.basename(pp).replace(/\.prproj$/i, '');
      const fh = nameProducts(names, [file]);
      if (fh.length === 1) { auto = fh[0]; by = 'file'; } else if (fh.length > 1) multi = fh;
    }
  }
  // ⚠️ Sản phẩm đã chọn mà SAMX_WORKSPACE không còn → `gone`, từ chối chứ không lặng lẽ
  // quay về sản phẩm khớp mà người dùng đã chọn bỏ.
  let pick = String(productPick || ''), gone = '';
  if (pick && names.indexOf(pick) < 0) { gone = pick; pick = ''; }
  const chosen = pick || (gone ? '' : auto);
  return { samx: sr.samx, names, below, folder: productFolderOf(below), matches, lead, auto, by, multi,
           pick, gone, product: chosen ? path.join(sr.samx, chosen) : '' };
}

// Project KHÔNG nằm trên ổ chung (copy về máy, Desktop…): vẫn nhận sản phẩm nếu tên một sản phẩm
// của SAMX_WORKSPACE (Drive for desktop) nằm trong đường dẫn project hoặc tên sequence — so chữ+số
// nên "_" / khoảng trắng / dấu chấm đều là ranh giới: "FB9.16(O) GlamyCurve_v8.0_[…]" → GlamyCurve.
// Nhiều sản phẩm khớp → lấy tên dài nhất ("CurvyFlex 2.0" hơn "CurvyFlex"); dài bằng nhau → menu.
// Không khớp gì → null (giữ câu "chọn thư mục xuất" như trước). productPick vẫn được tôn trọng.
function nameProducts(names, texts) {
  const keys = texts.map(alnumKey).filter(Boolean);
  let best = 0, hits = [];
  for (const n of names) {
    const nk = alnumKey(n);
    if (nk.length < 5 || !keys.some(k => k.indexOf(nk) >= 0)) continue;
    if (nk.length > best) { best = nk.length; hits = [n]; } else if (nk.length === best) hits.push(n);
  }
  return hits;
}
function localRoute(projectPath, productPick, opts, seqName) {
  const pp = String(projectPath || '');
  if (!pp || projectProduct(pp) || sharedDrivesOf(pp).length) return null;
  const samx = cloudSamx(opts);
  if (!samx) return null;
  const names = samxProducts(samx);
  const below = pp.split('/').filter(Boolean);
  below[below.length - 1] = (below[below.length - 1] || '').replace(/\.prproj$/i, '');
  const hits = nameProducts(names, below.concat([stripHandles(seqName)]));
  let pick = String(productPick || ''), gone = '';
  if (pick && names.indexOf(pick) < 0) { gone = pick; pick = ''; }
  if (!hits.length && !pick && !gone) return null;
  const auto = hits.length === 1 ? hits[0] : '';
  const chosen = pick || (gone ? '' : auto);
  return { samx, names, below, folder: '', matches: [], lead: [], auto, by: auto ? 'name' : '',
           multi: hits.length > 1 ? hits : [], pick, gone, product: chosen ? path.join(samx, chosen) : '' };
}

function pickGoneWhy(r) {
  const s = 'Sản phẩm đã chọn cho project này, ' + qn(r.gone) + ', không còn trong SAMX_WORKSPACE '
    + '— hỏi Tech xem có bị đổi tên hay xoá không — nên không xuất gì';
  return r.auto
    ? s + ', kể cả vào ' + qn(r.auto) + ' (sản phẩm khớp mà bạn đã chọn thay): chọn ' + qn(r.auto)
      + ' hoặc sản phẩm khác.'
    : s + ': hãy chọn lại sản phẩm.';
}

function unmatchedWhy(r) {
  if (r.matches.length > 1) {
    return 'Các thư mục của project trùng tên ' + r.matches.length + ' sản phẩm trong SAMX_WORKSPACE, '
      + qn(r.matches[0]) + ' và ' + qn(r.matches[1]) + ', nên chưa xuất được — chọn sản phẩm của bản dựng này.';
  }
  if (r.multi && r.multi.length > 1) {
    const named = r.multi.map(qn);
    return 'Project và tên sequence khớp ' + r.multi.length + ' sản phẩm trong SAMX_WORKSPACE, '
      + named.slice(0, -1).join(', ') + ' và ' + named[named.length - 1]
      + ', nên chưa xuất được — chọn sản phẩm của bản dựng này.';
  }
  if (r.lead && r.lead.length > 1) {
    const named = r.lead.map(qn);
    return 'Các thư mục của project mở đầu bằng tên của ' + r.lead.length + ' sản phẩm trong SAMX_WORKSPACE, '
      + named.slice(0, -1).join(', ') + ' và ' + named[named.length - 1]
      + ', nên chưa xuất được — chọn sản phẩm của bản dựng này.';
  }
  const near = productCandidates(r.names, r.below);
  if (!r.folder) {
    return 'Không có gì trong đường dẫn project gọi tên một sản phẩm của SAMX_WORKSPACE, nên chưa '
      + 'xuất được — hãy chọn sản phẩm.';
  }
  if (near.length) {
    return 'SAMX_WORKSPACE không có thư mục tên đúng ' + qn(r.folder) + ', nên chưa xuất được — hãy '
      + 'chọn sản phẩm; giống nhất là ' + near.slice(0, 3).join(', ') + '.';
  }
  return 'SAMX_WORKSPACE chưa có thư mục cho ' + qn(r.folder) + ' — nhờ Tech tạo, hoặc chọn sản phẩm.';
}

// Câu từ chối cho thư mục CHỌN TAY. Raw-cutter không bao giờ tạo thư mục được chọn.
function handWhy(at, what, kind) {
  const who = 'Thư mục đã chọn cho project này, ' + shortPath(at, 44) + ',';
  if (what === 'root') {
    return 'Thư mục đã chọn cho project này là gốc ổ đĩa (/), không xuất vào đó được — chọn thư mục khác.';
  }
  if (what === 'samxroot') {
    return 'Thư mục đã chọn cho project này là chính SAMX_WORKSPACE, không phải một sản phẩm, nên '
      + 'không xuất vào đó được — chọn thư mục sản phẩm bên trong, hoặc thư mục bất kỳ ngoài SAMX_WORKSPACE.';
  }
  if (what === 'gone' && kind === 'samx') {
    return who + ' không có ở đó — kết nối lại ổ chung (hỏi Tech nếu sản phẩm bị đổi tên hay xoá), '
      + 'hoặc chọn thư mục khác.';
  }
  if (what === 'gone') {
    return who + ' không có ở đó, và Raw-cutter không bao giờ tự tạo thư mục xuất — kết nối lại ổ '
      + 'chứa nó, tạo thư mục, hoặc chọn thư mục khác.';
  }
  if (kind === 'samx') {
    return who + ' là sản phẩm trong SAMX_WORKSPACE nhưng không có Output/, nên không xuất vào đó được '
      + '— nhờ Tech tạo thư mục Output/, hoặc chọn thư mục khác; Raw-cutter không bao giờ tự tạo.';
  }
  return who + ' không có Output/, nên không xuất vào đó được — chọn thư mục khác; Raw-cutter '
    + 'không bao giờ tự tạo.';
}

// ── Version đã thuộc sequence khác? ──────────────────────────────────────────
// Chỉ file engine gọi là clip: "NN_…" có đuôi media, và hai bản mix.
const CLIP_FILE_RE = /^\d+_.*\.(?:mp4|mov|mkv|m4v|m4a|wav|mp3|aac)$/i;
const MIX_FILE_RE = /^_(?:timeline_audio|track_A\d+)\.(?:mp3|m4a|wav|aac)$/i;
const LEGACY_RECORDS = ['manifest.json', 'manifest.csv', 'clips.csv', '.xmlcut-ledger.json'];
const LEGACY_DIRS = ['_renders', '_earlier_export', 'report'];

function clipNames(dir) {
  let names;
  if (!dir) return [];
  try { names = fs.readdirSync(dir); } catch (e) { return []; }
  return names.map(String).filter(n => CLIP_FILE_RE.test(n) || MIX_FILE_RE.test(n));
}

// manifest.json: sequence (id, name), mode, số clip ĐÃ ENCODE (status ok | skipped_existing).
function folderExport(dir) {
  let m;
  try { m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); } catch (e) { return null; }
  if (!m || typeof m !== 'object') return null;
  const seq = (m.sequence && typeof m.sequence === 'object') ? m.sequence : {};
  const st = (m.settings && typeof m.settings === 'object') ? m.settings : {};
  const rows = Array.isArray(m.clips) ? m.clips : [];
  const enc = rows.filter(r => r && typeof r === 'object' && (r.status === 'ok' || r.status === 'skipped_existing')).length;
  const id = seq.id;
  return {
    name: typeof seq.name === 'string' ? seq.name : '',
    id: (typeof id === 'string' || typeof id === 'number') ? String(id) : '',
    cutFrom: (st.cut_from === 'render' || st.cut_from === 'source') ? st.cut_from : '',
    encoded: enc,
  };
}

// .xmlcut-ledger.json: với mỗi file nó ghi mà CÒN trên đĩa (`present`) — sequence và mode.
// ⚠️ Manifest chỉ tả MỘT lần chạy (Retry hỏng có thể ghi đè thành "không gì"); ledger thì
// engine không bao giờ xoá mục của file còn nằm đó.
function folderLedger(dir, present) {
  let m;
  const out = [];
  try { m = JSON.parse(fs.readFileSync(path.join(dir, '.xmlcut-ledger.json'), 'utf8')); } catch (e) { return out; }
  const files = (m && typeof m === 'object') ? m.files : null;
  if (!files || typeof files !== 'object' || Array.isArray(files)) return out;
  for (const name of Object.keys(files)) {
    if (!present[name]) continue;
    const e = files[name];
    if (!e || typeof e !== 'object') continue;
    const sq = (e.sequence && typeof e.sequence === 'object') ? e.sequence : {};
    const st = (e.settings && typeof e.settings === 'object') ? e.settings : {};
    out.push({
      name: typeof sq.name === 'string' ? sq.name : '',
      id: (typeof sq.id === 'string' || typeof sq.id === 'number') ? String(sq.id) : '',
      cutFrom: (st.cut_from === 'render' || st.cut_from === 'source') ? st.cut_from : '',
    });
  }
  return out;
}

// Tên sequence như người đọc hiểu: bỏ handle [..], gộp khoảng trắng, chữ thường.
function normSeqName(name) {
  return stripHandles(String(name === null || name === undefined ? '' : name))
    .replace(/\s+/g, ' ').replace(/^ | $/g, '').toLowerCase();
}

// ID quyết định khi hai đầu đều có (đổi tên vẫn là một sequence); thiếu ID thì so tên đã chuẩn
// hoá; bản ghi không tên không ID thì không thể nói là của sequence khác.
function otherSequence(fx, me) {
  if (!fx) return '';
  const nowId = String((me && me.id) || '');
  if (fx.id && nowId) return fx.id !== nowId ? (fx.name || fx.id) : '';
  if (!fx.name) return '';
  return normSeqName(fx.name) !== normSeqName((me && me.name) || '') ? fx.name : '';
}

// Bản ghi của thư mục nói gì về clip trong nó: {clips, known, other}.
function folderRecord(dir, me) {
  const rec = { clips: 0, known: false, other: '' };
  const names = clipNames(dir);
  rec.clips = names.length;
  if (!names.length) return rec;
  const present = {};
  for (const n of names) present[n] = 1;
  const fx = folderExport(dir), led = folderLedger(dir, present);
  const ev = (fx && (fx.encoded > 0 || led.length > 0)) ? [fx] : [];
  for (const l of led) ev.push(l);
  for (const e of ev) {
    if (e.id || e.name) rec.known = true;
    if (!rec.other) rec.other = otherSequence(e, me);
  }
  return rec;
}

// Thứ 3.90 để PHẲNG trong thư mục version (trước khi có raw/ edited/). null nếu không có.
function legacyFlat(vp) {
  let names;
  try { names = fs.readdirSync(vp).map(String); } catch (e) { return null; }
  let clips = 0, recs = false;
  for (const n of names) {
    if (CLIP_FILE_RE.test(n) || MIX_FILE_RE.test(n)) clips++;
    else if (LEGACY_RECORDS.indexOf(n) >= 0) recs = true;
  }
  const dirs = LEGACY_DIRS.filter(d => names.indexOf(d) >= 0 && isDir(path.join(vp, d))).map(d => d + '/');
  if (!clips && !recs && !dirs.length) return null;
  return { clips, records: recs, dirs };
}

const MODE_DIR = { source: 'raw', render: 'edited' };
function modeName(m) {
  const l = String(m || '').toLowerCase();
  if (l === 'raw' || l === 'edited') return l;
  return MODE_DIR[l === 'render' ? 'render' : 'source'];
}

// Một version là MỘT bản giao: hỏi thư mục mode của lần xuất này, thư mục mode KIA, và file
// phẳng 3.90 ở đỉnh version. → {other, dir, leaf, into, here} hoặc null.
function takenHit(versionPath, mode, me) {
  const mn = modeName(mode), on = mn === 'raw' ? 'edited' : 'raw';
  const md = childDir(versionPath, n => n.toLowerCase() === mn, mn);
  const od = childDir(versionPath, n => n.toLowerCase() === on, on);
  const here = md ? folderRecord(path.join(versionPath, md), me) : null;
  const there = od ? folderRecord(path.join(versionPath, od), me) : null;
  const flat = legacyFlat(versionPath) ? folderRecord(versionPath, me) : null;
  let hit = null;
  if (here && here.other) hit = { other: here.other, dir: path.join(versionPath, md), leaf: md + '/', into: 'it' };
  else if (there && there.other) hit = { other: there.other, dir: path.join(versionPath, od), leaf: od + '/', into: 'version' };
  else if (flat && flat.other) hit = { other: flat.other, dir: versionPath, leaf: '', into: 'it' };
  return { hit, here };
}

// '' hoặc tên (không có tên thì id) của sequence KHÁC đang sở hữu thư mục version.
// opts: {sequenceName?, mode?: 'source'|'render'|'raw'|'edited'} — không có mode thì hỏi cả hai.
function folderTaken(versionDir, sequenceId, opts) {
  opts = opts || {};
  const me = { id: sequenceId || '', name: opts.sequenceName || '' };
  const modes = opts.mode ? [opts.mode] : ['source', 'render'];
  for (const m of modes) {
    const t = takenHit(versionDir, m, me).hit;
    if (t) return t.other;
  }
  return '';
}

// Một version tiến một bước, viết theo kiểu TÊN viết ("vid 9.0" → "vid 9.1", "v1.2" → "v1.3",
// "vid 9" → "vid 9.1"), bỏ qua version mà ACT/ đã có. `act`: mảng tên thư mục hoặc đường dẫn ACT/.
function nextSaid(said, act) {
  const m = /^(.*?)(\d+(?:\.\d+)*)$/.exec(String(said || ''));
  if (!m) return '';
  let names = null;
  if (Array.isArray(act)) names = act.map(String);
  else if (act) { try { names = fs.readdirSync(act).map(String).filter(n => isDir(path.join(act, n))); } catch (e) { names = []; } }
  const g = m[2].split('.');
  if (g.length === 1) g.push('0');
  for (let tries = 0; tries < 50; tries++) {
    g[g.length - 1] = String(parseInt(g[g.length - 1], 10) + 1);
    const v = 'v' + g.join('.');
    if (!names || !names.some(n => sameVersion(n, v))) return m[1] + g.join('.');
  }
  return '';
}

const HALF_NAME = { source: 'Source Render', render: 'Timeline Render' };

// ── Đích xuất ───────────────────────────────────────────────────────────────
// o = {projectPath, sequenceName, sequenceId?, mode:'source'|'render'|'both', chosen?, productPick?, walk?}
// env = {cloudStorage?, home?} (tiêm cho test). Thứ tự ưu tiên (chốt từ bản gốc):
//   thư mục chọn cho project này → project nằm trong sản phẩm SAMX → sản phẩm khớp (đúng tên
//   hoặc mở đầu bằng tên) trên ổ chung khác → sản phẩm chọn từ menu → không thì needPick.
function resolveDest(o, env) {
  o = o || {};
  const pp = String(o.projectPath || '');
  const seqName = String(o.sequenceName || '');
  const me = { id: String(o.sequenceId || ''), name: seqName };
  const mode = o.mode === 'source' || o.mode === 'render' ? o.mode : 'both';
  const res = { ok: false, why: '', version: '', samx: '', products: [], route: '', product: null };
  const own = projectProduct(pp);
  const r = own ? null : (productRoute(pp, o.productPick, env, seqName) || localRoute(pp, o.productPick, env, seqName));
  if (r) {
    res.samx = r.samx;
    res.products = r.names;
    const near = productCandidates(r.names, r.below);
    res.candidates = (r.multi || []).concat(near.filter(n => (r.multi || []).indexOf(n) < 0));
  } else if (own) {
    res.samx = path.dirname(own);
    res.products = samxProducts(res.samx);
  } else {
    // Không đoán được gì vẫn đưa danh sách sản phẩm để menu chọn tay hiện ra.
    const cs = samxRoute(pp, env).samx || cloudSamx(env);
    if (cs) { res.samx = cs; res.products = samxProducts(cs); }
  }
  const whys = [];
  let product = '', kind = '', free = false, fromProject = false, whose = '';
  const chosen = String(o.chosen || '');
  if (chosen) {
    res.chosen = true;
    const lay = chosenLayout(chosen, !!o.walk);
    kind = lay.kind;
    if (kind === 'samx') {
      res.route = 'samx'; product = lay.product;
      if (!res.samx) { res.samx = path.dirname(product); res.products = samxProducts(res.samx); }
    }
    else if (kind === 'product') { res.route = 'chosen-product'; product = lay.product; }
    else if (kind === 'free') { res.route = 'free'; product = lay.base; free = true; }
    else whys.push(handWhy(chosen, kind === 'samxroot' ? 'samxroot' : 'root', kind));
  } else if (own) {
    res.route = 'samx'; product = own; fromProject = true;
    whose = 'Thư mục sản phẩm của project đang mở, ';
  } else if (r) {
    fromProject = true;
    if (r.gone) { res.route = 'picked'; res.needPick = true; whys.push(pickGoneWhy(r)); }
    else if (r.pick) { res.route = 'picked'; product = r.product; whose = 'Sản phẩm đã chọn cho project này, '; }
    else if (r.auto) { res.route = 'matched'; res.matchedBy = r.by; product = r.product; whose = 'Sản phẩm khớp với project đang mở, '; }
    else { res.needPick = true; whys.push(unmatchedWhy(r)); }
  } else if (o.productPick && res.products.indexOf(String(o.productPick)) >= 0) {
    fromProject = true; res.route = 'picked';
    product = path.join(res.samx, String(o.productPick)); whose = 'Sản phẩm đã chọn cho project này, ';
  } else {
    res.needPick = true;
    whys.push(sharedDrivesOf(pp).length
      ? 'Không tìm thấy SAMX_WORKSPACE để nhận sản phẩm của project này — chọn thư mục xuất cho project.'
      : 'Project không nằm trong SAMX_WORKSPACE hay ổ chung nào nên không nhận ra sản phẩm — chọn thư mục xuất cho project.');
  }

  // ⚠️ Output/ KHÔNG BAO GIỜ được tạo ở đây — đó chính là phép thử "đây có phải sản phẩm".
  // Thư mục tự do cũng không được tạo: engine chỉ mkdir version/mode BÊN TRONG thư mục có sẵn.
  let output = '';
  if (product) {
    const at = shortPath(product, 44);
    if (!isDir(product)) {
      whys.push(fromProject ? whose + at + ', không truy cập được — kết nối lại ổ chung rồi bấm Read lại.'
        : handWhy(product, 'gone', kind));
    } else if (!free) {
      const oname = childDir(product, n => n.toLowerCase() === 'output', 'Output');
      if (oname) output = path.join(product, oname);
      else if (fromProject) {
        whys.push(whose + at + ', không có Output/, nên không xuất vào đó được — nhờ Tech tạo thư mục Output/'
          + (res.route === 'picked' || res.route === 'matched' ? ', hoặc chọn sản phẩm khác' : '')
          + '; Raw-cutter không bao giờ tự tạo.');
      } else whys.push(handWhy(product, 'nooutput', kind));
    }
    res.product = free ? null : { name: path.basename(product), path: product };
  }
  const v = seqVersion(seqName);
  if (v.why) whys.push(v.why);
  res.version = v.version;
  if (whys.length) { res.why = whys.join(' '); return res; }

  // ACT/ theo chính tả thật trên đĩa; chưa có thì "ACT" (engine mkdir — an toàn vì Output/ vừa thấy).
  let act, actExists;
  if (free) { act = product; actExists = true; }
  else {
    const a = childDir(output, n => n.toLowerCase() === 'act', 'ACT');
    actExists = !!a;
    act = path.join(output, a || 'ACT');
  }
  // Thư mục version có sẵn (v1 = v1.0) được dùng lại thay vì tạo cái thứ hai bên cạnh.
  const vd = actExists ? childDir(act, n => sameVersion(n, v.version), v.version) : '';
  // ⚠️ Một FILE đúng chỗ thư mục phải tạo là từ chối, không phải "sẽ tạo".
  const blockSentence = (holder, wants, blocker) => path.basename(holder) + '/ trong '
    + shortPath(path.dirname(holder), 44) + ' có một FILE tên “' + blocker + '” đúng chỗ thư mục '
    + wants + '/ phải nằm, nên không xuất được — chuyển hoặc đổi tên file đó rồi xuất lại.';
  let holder = '', wants = '';
  if (!actExists) { holder = output; wants = 'ACT'; }
  else if (!vd) { holder = act; wants = v.version; }
  const blocker = holder ? blockingFile(holder, wants) : '';
  if (blocker) { res.why = blockSentence(holder, wants, blocker); return res; }

  const versionDir = path.join(act, vd || v.version);
  const said = v.said || v.version;
  const vleaf = path.basename(act) + '/' + (vd || v.version) + '/';
  const halves = {};
  for (const m of ['source', 'render']) {
    const mn = modeName(m);
    const md = vd ? childDir(versionDir, n => n.toLowerCase() === mn, mn) : '';
    const h = { dir: path.join(versionDir, md || mn), modeDir: md || mn, why: '', taken: false, takenDir: '', clips: 0, known: false };
    if (vd && !md) {
      const b = blockingFile(versionDir, mn);
      if (b) h.why = blockSentence(versionDir, mn, b);
    }
    if (!h.why && vd) {
      const t = takenHit(versionDir, m, me);
      if (t.here) { h.clips = t.here.clips; h.known = t.here.known; }
      if (t.hit) {
        h.taken = true;
        h.takenDir = t.hit.dir;
        const next = nextSaid(said, act);
        const twin = normSeqName(t.hit.other) === normSeqName(seqName);
        h.why = vleaf + t.hit.leaf + ' đã chứa bản xuất của ' + qn(t.hit.other) + (twin
          ? ', một sequence khác trùng tên (Premiere cấp ID khác)'
          : ', một sequence khác cho cùng version (' + v.version + ')')
          + ', nên không xuất vào ' + (t.hit.into === 'it' ? 'đó' : vleaf) + ' được — đổi tên sequence '
          + 'này sang version khác' + (next ? ' (vd ' + qn(next) + ')' : '') + ', hoặc nếu sequence này '
          + 'thay thế sequence kia thì chuyển clip trong thư mục đó ra trước.';
      }
    }
    halves[m] = h;
  }
  res.dirs = { raw: halves.source.dir, edited: halves.render.dir };
  res.versionDir = versionDir;
  res.act = free ? null : act;
  res.said = said;

  // Gộp lời từ chối: một mode → của mode đó; Both → cả hai phải qua (một nửa bị chặn thì
  // không xuất gì), câu giống nhau nói một lần.
  let why = '';
  const s = halves.source, rr = halves.render;
  if (mode !== 'both') why = halves[mode].why;
  else if (s.why && rr.why) {
    if (s.why === rr.why) why = s.why;
    else if (s.taken && rr.taken && s.takenDir === rr.takenDir) why = s.takenDir === s.dir ? rr.why : s.why;
    else why = 'Cả hai nửa của Both đều không xuất được. ' + HALF_NAME.source + ' (raw/): ' + s.why
      + ' ' + HALF_NAME.render + ' (edited/): ' + rr.why;
  } else if (s.why || rr.why) {
    const bad = s.why ? 'source' : 'render', other = bad === 'source' ? rr : s;
    why = 'Nửa ' + HALF_NAME[bad] + ' của Both bị từ chối nên Both không xuất gì — kể cả '
      + (vd || v.version) + '/' + other.modeDir + '/: ' + (s.why || rr.why);
  }
  if (why) {
    res.why = why;
    const tk = mode === 'both' ? (s.taken || rr.taken) : halves[mode].taken;
    if (tk) {
      res.taken = true;
      res.takenDir = mode === 'both' ? (s.takenDir || rr.takenDir) : halves[mode].takenDir;
    }
    return res;
  }

  const notes = [];
  if (!actExists) notes.push('Output/ACT chưa có — lần xuất sẽ tạo.');
  else if (!vd) notes.push(vleaf.replace(/\/$/, '') + ' chưa có — lần xuất sẽ tạo.');
  const L = vd ? legacyFlat(versionDir) : null;
  if (L) {
    const bits = [];
    if (L.clips) bits.push(L.clips + ' clip');
    for (const d of L.dirs) bits.push(d);
    if (L.records) bits.push('manifest');
    notes.push(vd + '/ còn file của một lần xuất cũ nằm thẳng bên trong, từ trước khi có raw/ và edited/ ('
      + bits.join(', ') + '): lần xuất này không đụng tới — dọn tay.');
  }
  for (const m of (mode === 'both' ? ['source', 'render'] : [mode])) {
    const h = halves[m];
    if (h.clips && !h.known) {
      notes.push(h.modeDir + '/ đang có ' + h.clips + ' clip mà không bản ghi nào cho biết của sequence '
        + 'nào — kiểm tra trước khi xuất.');
    } else if (h.clips) {
      notes.push(h.modeDir + '/ đã có ' + h.clips + ' clip của chính sequence này.');
    }
  }
  res.ok = true;
  res.notes = notes;
  return res;
}

module.exports = {
  seqVersion, sameVersion, versionKey, nextSaid, normSeqName,
  projectProduct, saveToProduct, chosenLayout, chosenFolder, sharedDrivesOf,
  samxBeside, findSamx, samxProducts, productRoute, productCandidates,
  matchedProducts, leadingProducts, folderRecord, folderTaken, legacyFlat,
  resolveDest, shortPath, localRoute, nameProducts,
};
