// bridge/source-roots.js
// Các thư mục gốc để Autocut đi tìm source còn thiếu.
//
// Vì sao không chỉ quét "cấp cha của thư mục chứa .prproj" như trước: trong
// SAMX_WORKSPACE project nằm ở <SP>/Asset/project/x.prproj, nên cấp cha là
// <SP>/Asset — còn footage thật lại nằm ở <SP>/Sources, ngang hàng với Asset:
//
//   <SP>/Asset/    project, BGM, VO, SFX, Image, Clips…
//   <SP>/Output/   ACT, FB, GG, PIN… — bản render của team, KHÔNG phải source
//   <SP>/Sources/  legacy|offer / studio|model|crawl|borrow|ai|_untyped / <tên> / approve|reject / …
//
// Nên khi nhận ra sản phẩm SAMX của project (nằm trong SAMX_WORKSPACE, hoặc
// project ở ổ team / máy local mà khớp được sản phẩm — cùng luật với tab RAW),
// quét cả <SP> trừ Output, Sources trước. Thư mục cạnh project vẫn quét như cũ
// khi nó nằm ngoài <SP>.

const fs   = require('fs');
const path = require('path');
const wfBrowse = require('./watchfolder-browse.js');
const dest     = require('./rawcut-dest.js');

const SKIP_TOP = ['output'];
const FIRST    = ['sources', 'asset'];

// readdir có hạn giờ: thư mục sản phẩm trên Drive chưa cache có thể treo lâu,
// không được để cả lượt tìm chờ ở bước liệt kê gốc.
function readdirSoft(p, ms) {
  return new Promise(resolve => {
    const t = setTimeout(() => resolve(null), ms);
    fs.promises.readdir(p, { withFileTypes: true }).then(
      ents => { clearTimeout(t); resolve(ents); },
      () => { clearTimeout(t); resolve(null); });
  });
}

const inside = (p, root) => p === root || p.indexOf(root + path.sep) === 0;

// Sản phẩm SAMX của project: '' nếu không nhận ra (hoặc nhiều ứng viên — không đoán).
function productOf(projectPath, o) {
  const own = dest.projectProduct(projectPath);
  if (own) return { product: own, by: 'inside' };
  let r = null;
  try {
    r = dest.productRoute(projectPath, o.productPick, o, o.seqName)
      || dest.localRoute(projectPath, o.productPick, o, o.seqName);
  } catch (e) { r = null; }
  if (r && r.product) return { product: r.product, by: r.pick ? 'picked' : (r.by || 'auto') };
  return { product: '', by: '' };
}

// → { display, product, productName, by, roots: [{path, kind:'samx'|'project', label}] }
//   display: gốc để tính đường dẫn tương đối hiển thị trong bảng duyệt.
async function searchRoots(projectPath, opts) {
  const o = opts || {};
  const near = wfBrowse.productRoot(projectPath);
  const { product, by } = productOf(projectPath, o);
  if (!product) {
    return { display: near, product: '', productName: '', by: '',
             roots: near ? [{ path: near, kind: 'project', label: path.basename(near) }] : [] };
  }

  const ents = await readdirSoft(product, Number(o.listMs) || 8000);
  let tops;
  if (ents) {
    tops = ents.filter(e => !e.name.startsWith('.')
        && (e.isDirectory() || e.isSymbolicLink())
        && SKIP_TOP.indexOf(e.name.toLowerCase()) < 0)
      .map(e => e.name);
  } else {
    // Không liệt kê kịp: thử thẳng hai thư mục chuẩn, walk tự bỏ cái không có.
    tops = ['Sources', 'Asset'];
  }
  const rank = n => { const i = FIRST.indexOf(n.toLowerCase()); return i < 0 ? FIRST.length : i; };
  tops.sort((a, b) => rank(a) - rank(b) || wfBrowse.natCmp(a, b));

  const roots = tops.map(n => ({ path: path.join(product, n), kind: 'samx', label: n }));
  if (near && !inside(near, product) && !inside(product, near)) {
    roots.push({ path: near, kind: 'project', label: path.basename(near) });
  }
  return { display: product, product, productName: path.basename(product), by, roots };
}

module.exports = { searchRoots, productOf };
