// bridge/rawcut-args.js — options → argv cho xmlcut.py.
// Thứ tự cờ giữ đúng panel CEP 3.93 (argsFor M628 + settingArgs M8471) để manifest/ledger
// của bản mới giống bản cũ. Giá trị mặc định của engine (crf 1, scale 100, libx264) không gửi.
'use strict';

function buildArgs(o) {
  o = o || {};
  if (!o.script) throw new Error('thiếu đường dẫn engine (script)');
  if (!o.dump) throw new Error('thiếu dump sequence');
  if (!o.out) throw new Error('thiếu thư mục ra (out)');
  if (o.renderPlanned && o.renderDir) throw new Error('--render-planned không đi cùng --render-dir (chỉ dùng khi scan)');
  if (o.renderPlanned && !o.manifestOnly) throw new Error('--render-planned phải đi cùng --manifest-only');

  const a = [o.script];
  if (o.xml) a.push(o.xml, '--sequence', 'name:' + String(o.sequenceName || ''), '--panel', o.dump);
  else a.push(o.dump);
  a.push('-o', o.out);

  if (o.ext && o.ext.length) a.push('--ext', o.ext.map(e => String(e).toLowerCase().replace(/^\./, '')).join(','));
  if (o.videoTrack) a.push('--video-track', String(o.videoTrack));
  if (o.crf != null && Number(o.crf) !== 1) a.push('--crf', String(o.crf));
  if (o.fps) a.push('--fps', String(o.fps));
  if (o.scale != null && Number(o.scale) < 100) a.push('--scale', String(o.scale));
  if (o.vcodec && o.vcodec !== 'libx264') a.push('--vcodec', String(o.vcodec));
  if (o.audioPerTrack) a.push('--audio-per-track');
  if (o.audio) a.push('--audio');
  if (o.audioTracks && o.audioTracks.length) a.push('--audio-tracks', o.audioTracks.join(','));
  if (o.renderAudio) a.push('--render-audio');
  if (o.transitions) a.push('--transitions', String(o.transitions));
  (o.remap || []).slice()
    .sort((x, y) => String(y[0]).length - String(x[0]).length)
    .forEach(p => a.push('--remap', p[0] + '=' + p[1]));
  if (o.sizeProbe) a.push('--size-probe');
  if (o.manifestOnly) a.push('--manifest-only');
  if (o.renderPlanned) a.push('--render-planned');
  if (o.renderDir) a.push('--render-dir', o.renderDir);
  if (o.resume) a.push('--resume');
  if (o.pick) a.push('--pick', o.pick);
  return a;
}

module.exports = { buildArgs };
