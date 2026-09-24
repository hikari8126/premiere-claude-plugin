// plugin/csv-parse.js — parser + map thuần cho tính năng "Thêm CSV" của Autocut.
// Classic script nạp TRƯỚC main.js (expose global csvParse/csvRowsToSac); đồng thời
// export cho node để test. KHÔNG đụng DOM. Thiết kế:
// docs/superpowers/specs/2026-09-24-autocut-csv-import-design.md

function csvParse(text) {
  text = String(text == null ? '' : text).replace(/^﻿/, ''); // strip BOM
  var rows = [], row = [], cell = '', inQ = false, i = 0, ch, nx;
  while (i < text.length) {
    ch = text[i]; nx = text[i + 1];
    if (inQ) {
      if (ch === '"' && nx === '"') { cell += '"'; i += 2; }   // "" -> "
      else if (ch === '"')          { inQ = false; i++; }       // end quote
      else                          { cell += ch; i++; }        // gồm cả \n trong ô
    } else {
      if      (ch === '"')                 { inQ = true; i++; }
      else if (ch === ',')                 { row.push(cell); cell = ''; i++; }
      else if (ch === '\n' || ch === '\r') {
        row.push(cell); cell = '';
        if (row.some(function (c) { return c !== ''; })) rows.push(row);
        row = [];
        if (ch === '\r' && nx === '\n') i++; // CRLF
        i++;
      } else { cell += ch; i++; }
    }
  }
  row.push(cell);
  if (row.some(function (c) { return c !== ''; })) rows.push(row);
  return rows;
}

function csvRowsToSac(rows) {
  if (!rows || !rows.length) return { rows: [], error: 'CSV rỗng' };
  var header = rows[0].map(function (h) { return String(h == null ? '' : h).trim().toLowerCase(); });
  function col(name) { return header.indexOf(name); }
  var iText = col('text_overlay'), iFoot = col('footage_name'),
      iStart = col('shot_start'), iEnd = col('shot_end');
  var missing = [];
  if (iText  < 0) missing.push('text_overlay');
  if (iFoot  < 0) missing.push('footage_name');
  if (iStart < 0) missing.push('shot_start');
  if (missing.length) return { rows: [], error: 'CSV thiếu cột: ' + missing.join(', ') };

  var out = [];
  for (var r = 1; r < rows.length; r++) {
    var rw = rows[r] || [];
    var textRaw = String(rw[iText] != null ? rw[iText] : '');
    var text = textRaw.split('\n').map(function (l) { return l.trim(); })
      .filter(Boolean).join(' ').trim();
    var start = String(rw[iStart] != null ? rw[iStart] : '').trim();
    var end   = iEnd >= 0 ? String(rw[iEnd] != null ? rw[iEnd] : '').trim() : '';
    var time  = (start && end) ? (start + '-' + end) : (start || '');
    var src   = String(rw[iFoot] != null ? rw[iFoot] : '').trim();
    if (!text && !src) continue; // dòng trắng
    out.push({ text: text, time: time, src: src });
  }
  return { rows: out, error: null };
}

(function (root) {
  if (root) { root.csvParse = csvParse; root.csvRowsToSac = csvRowsToSac; }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { csvParse: csvParse, csvRowsToSac: csvRowsToSac };
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
