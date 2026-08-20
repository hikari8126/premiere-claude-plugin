// ═══════════════════════════════════════════════════════════════════════════
// autosub-log.js — Ghi lại MỖI LẦN auto sub: Whisper NGHE ĐƯỢC gì, và LỆCH so
// với script ở chỗ nào. Mục đích: có dữ liệu thật để tìm hướng cải thiện
// (đổi model Whisper, sửa cách ghép clip, sửa chunker...).
//
// Mỗi lần chạy → 1 file .md trong ~/Documents/Claude Bridge Logs/autosub/
// + 1 dòng tóm tắt trong autosub-history.log (để soi xu hướng nhiều lần chạy).
// ═══════════════════════════════════════════════════════════════════════════
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const LOG_DIR      = path.join(os.homedir(), 'Documents', 'Claude Bridge Logs', 'autosub');
const HISTORY_PATH = path.join(LOG_DIR, 'autosub-history.log');
const KEEP_RUNS    = 60;   // giữ 60 file gần nhất, xoá dần cho khỏi phình

function norm(s) {
  return String(s || '').toLowerCase()
    .replace(/[\.,!\?;:"'\(\)\[\]\{\}—–\-_/\\]/g, '')
    .trim();
}

function ts(sec) {
  if (sec == null || !isFinite(sec)) return '--:--';
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  return String(m).padStart(2, '0') + ':' + (s - m * 60).toFixed(1).padStart(4, '0');
}

function stamp(d) {
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' +
         p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

// Bọc dòng ~100 ký tự cho transcript dễ đọc trong file .md.
function wrap(text, width) {
  width = width || 100;
  const out = [];
  let line = '';
  for (const w of String(text || '').split(/\s+/).filter(Boolean)) {
    if (line && (line.length + 1 + w.length) > width) { out.push(line); line = w; }
    else line = line ? line + ' ' + w : w;
  }
  if (line) out.push(line);
  return out.join('\n');
}

// ── Diff script ⇄ whisper theo TỪ (LCS) ───────────────────────────────────
// Trả về các "run" lệch: mỗi run = một đoạn script không khớp và đoạn whisper
// tương ứng ở cùng vị trí → đọc là biết Whisper nghe nhầm chữ nào thành chữ gì.
function diffWords(scriptTokens, whisperTokens) {
  const A = scriptTokens.map(t => t.n);
  const B = whisperTokens.map(t => norm(t.text));
  const n = A.length, m = B.length;
  // LCS DP — script/whisper thường vài trăm→vài nghìn từ, O(n·m) vẫn chấp nhận.
  // Chặn trên cho an toàn: quá lớn thì bỏ diff chi tiết, chỉ giữ tóm tắt.
  if (n * m > 6e6) return { runs: null, lcs: null, tooBig: true };
  const dp = [];
  for (let i = 0; i <= n; i++) dp.push(new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = (A[i] && A[i] === B[j]) ? dp[i + 1][j + 1] + 1
                                         : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const runs = [];
  let i = 0, j = 0, lcs = 0, cur = null;
  const flush = () => { if (cur && (cur.script.length || cur.heard.length)) runs.push(cur); cur = null; };
  while (i < n && j < m) {
    if (A[i] && A[i] === B[j]) { flush(); lcs++; i++; j++; continue; }
    if (!cur) cur = { script: [], heard: [], at: whisperTokens[j] ? whisperTokens[j].start : null };
    if (dp[i + 1][j] >= dp[i][j + 1]) { cur.script.push(scriptTokens[i].raw); i++; }
    else                              { cur.heard.push(whisperTokens[j].text); j++; }
  }
  while (i < n) { if (!cur) cur = { script: [], heard: [], at: null }; cur.script.push(scriptTokens[i++].raw); }
  while (j < m) { if (!cur) cur = { script: [], heard: [], at: whisperTokens[j].start }; cur.heard.push(whisperTokens[j++].text); }
  flush();
  return { runs, lcs, tooBig: false };
}

function pruneOldRuns() {
  try {
    const files = fs.readdirSync(LOG_DIR)
      .filter(f => /^autosub-.*\.md$/.test(f))
      .sort();
    while (files.length > KEEP_RUNS) {
      const f = files.shift();
      try { fs.unlinkSync(path.join(LOG_DIR, f)); } catch (e) {}
    }
  } catch (e) {}
}

// ── Ghi report ────────────────────────────────────────────────────────────
// info: {
//   kind, audioPath, language, whisperModel, clipCount, offset, audioDur,
//   words:   [{text,start,end}]        — Whisper nghe được
//   script:  [{raw,n,start,end}]|null  — từ script sau khi gán timing (sw)
//   scriptLines: [...]|null
//   cues:    [{start,end,text}]|null   — phụ đề cuối cùng
//   diag:    {...}                     — số liệu đã tính ở endpoint
// }
// Trả { path, summary } — hoặc null nếu ghi lỗi (không bao giờ throw ra endpoint).
function writeReport(info) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const now      = new Date();
    const words    = info.words || [];
    const script   = info.script || null;
    const cues     = info.cues || [];
    const diag     = info.diag || {};
    const heardTxt = words.map(w => w.text).join(' ');

    const L = [];
    L.push('# Auto Sub — ' + now.toLocaleString());
    L.push('');
    L.push('| | |');
    L.push('|---|---|');
    L.push('| Luồng | ' + (info.kind || 'subtext') + ' |');
    L.push('| Audio | `' + (info.audioPath || '?') + '` |');
    if (info.clipCount)  L.push('| Clip ghép | ' + info.clipCount + ' (offset ' + (info.offset || 0).toFixed(2) + 's) |');
    L.push('| Whisper | model `' + (info.whisperModel || '?') + '` · lang `' + (info.language || 'auto') + '` |');
    L.push('| Độ dài audio | ' + (diag.audioDur != null ? diag.audioDur : (info.audioDur || '?')) + 's |');
    L.push('| Whisper nghe được | ' + words.length + ' từ · span ' +
           (diag.wordSpan != null ? diag.wordSpan : '?') + 's · lặng cuối ' +
           (diag.silentTail != null ? diag.silentTail : '?') + 's |');
    if (script) {
      L.push('| Script | ' + script.length + ' từ · khớp ' + (diag.matched != null ? diag.matched : '?') +
             ' (' + (diag.matchPct != null ? diag.matchPct + '%' : '?') + ') |');
    } else {
      L.push('| Script | (không có — dùng chữ Whisper) |');
    }
    L.push('| Cue tạo ra | ' + cues.length + ' |');
    L.push('');

    // ── 1. Whisper nghe được gì ──
    L.push('## 1. Whisper nghe được');
    L.push('');
    L.push('```');
    L.push(wrap(heardTxt) || '(rỗng)');
    L.push('```');
    L.push('');

    // ── 2. Lệch ở đâu ──
    let runs = null, lcs = null;
    if (script && script.length) {
      L.push('## 2. Lệch so với script');
      L.push('');
      const d = diffWords(script, words);
      runs = d.runs; lcs = d.lcs;
      if (d.tooBig) {
        L.push('_Quá dài để diff chi tiết (script × whisper > 6M cặp) — xem mục 3._');
      } else if (!runs.length) {
        L.push('Khớp 100% theo từ — timing lệch (nếu có) KHÔNG phải do Whisper nghe sai.');
      } else {
        L.push('`script` = bạn viết · `nghe` = Whisper nghe thành · thời điểm theo audio đã ghép.');
        L.push('');
        L.push('| thời điểm | script | Whisper nghe |');
        L.push('|---|---|---|');
        for (const r of runs.slice(0, 300)) {
          const kind = !r.heard.length ? ' _(hụt — Whisper không nghe ra)_'
                     : !r.script.length ? ' _(Whisper thêm chữ)_' : '';
          L.push('| ' + ts(r.at) + ' | ' + (r.script.join(' ') || '—') + ' | ' +
                 (r.heard.join(' ') || '—') + kind + ' |');
        }
        if (runs.length > 300) L.push('| ... | _còn ' + (runs.length - 300) + ' đoạn lệch nữa_ | |');
      }
      L.push('');

      // ── 3. Từ script không lấy được timing thật (bị nội suy) ──
      const guessed = [];
      let run = null;
      script.forEach((s, idx) => {
        if (!s.hit) { if (!run) { run = { from: idx, words: [], start: s.start, end: s.end }; } run.words.push(s.raw); run.end = s.end; }
        else if (run) { guessed.push(run); run = null; }
      });
      if (run) guessed.push(run);
      L.push('## 3. Từ bị ĐOÁN timing (nội suy, không khớp từ Whisper nào)');
      L.push('');
      if (!guessed.length) L.push('Không có — mọi từ script đều bám vào một từ Whisper thật.');
      else {
        L.push('Đây là nơi caption dễ trôi/lệch nhất.');
        L.push('');
        L.push('| khoảng thời gian | số từ | nội dung |');
        L.push('|---|---|---|');
        guessed.sort((a, b) => b.words.length - a.words.length).slice(0, 40).forEach(g => {
          L.push('| ' + ts(g.start) + ' → ' + ts(g.end) + ' | ' + g.words.length + ' | ' +
                 g.words.join(' ').slice(0, 160) + ' |');
        });
        if (guessed.length > 40) L.push('| ... | | _còn ' + (guessed.length - 40) + ' đoạn nữa_ |');
      }
      L.push('');
    }

    // ── 4. Khoảng lặng dài ──
    L.push('## ' + (script ? '4' : '2') + '. Khoảng lặng dài (Whisper không có từ nào)');
    L.push('');
    const gaps = diag.bigGaps || [];
    if (!gaps.length) L.push('Không có khoảng lặng ≥2s.');
    else {
      L.push('| từ | đến | dài |');
      L.push('|---|---|---|');
      gaps.forEach(g => L.push('| ' + ts(g.after) + ' | ' + ts(g.before) + ' | ' + g.len + 's |'));
    }
    L.push('');

    // ── 5. Cue cuối cùng ──
    L.push('## ' + (script ? '5' : '3') + '. Cue cuối cùng');
    L.push('');
    L.push('```');
    cues.forEach((c, i) => L.push(String(i + 1).padStart(3) + '  ' + ts(c.start) + ' → ' + ts(c.end) + '  ' + c.text));
    L.push('```');
    L.push('');

    const file = path.join(LOG_DIR, 'autosub-' + stamp(now) + '.md');
    fs.writeFileSync(file, L.join('\n'), 'utf8');

    const summary =
      now.toISOString() +
      ' | ' + (info.kind || 'subtext') +
      ' | audio ' + (diag.audioDur != null ? diag.audioDur : '?') + 's' +
      ' | whisper ' + words.length + 'w' +
      ' | script ' + (script ? script.length + 'w khớp ' + (diag.matchPct != null ? diag.matchPct : '?') + '%' : '-') +
      ' | lệch ' + (runs ? runs.length : '-') + ' đoạn' +
      ' | lặng>2s ' + gaps.length +
      ' | cues ' + cues.length +
      ' | ' + path.basename(file);
    fs.appendFileSync(HISTORY_PATH, summary + '\n');
    pruneOldRuns();
    return { path: file, dir: LOG_DIR, summary, mismatches: runs ? runs.length : null };
  } catch (e) {
    console.error('[autosub-log]', e.message);
    return null;
  }
}

module.exports = { writeReport, LOG_DIR, HISTORY_PATH };
