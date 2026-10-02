// bridge/rawcut-runner.js — chạy xmlcut.py, stream event, Cancel giết cả group.
// detached:true cho engine process group riêng: Cancel gửi SIGTERM tới -pid để ffmpeg con
// chết theo (engine tự xoá file .part và nhả lock trong handler SIGTERM). 1.5s sau còn sống → SIGKILL.
'use strict';
const { spawn } = require('child_process');
const { createParser } = require('./rawcut-protocol.js');

const ENGINE_PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';

function engineEnv() {
  return { PATH: ENGINE_PATH, HOME: process.env.HOME || '', LANG: 'en_US.UTF-8', PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' };
}

function runEngine(opts) {
  const child = spawn(opts.bin, opts.args, {
    cwd: opts.cwd, env: opts.env || engineEnv(), detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '', cancelled = false;
  const parser = createParser(opts.onEvent, opts.onLine);
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', d => { stdout += d; parser.feed(d); });
  child.stderr.on('data', d => { stderr += d; });
  const done = new Promise(resolve => {
    child.on('error', e => resolve({ code: -1, signal: null, stdout, stderr: stderr + '\n' + e.message, spawnError: e.message, cancelled }));
    child.on('close', (code, signal) => { parser.end(); resolve({ code, signal, stdout, stderr, cancelled }); });
  });
  function cancel() {
    if (cancelled || child.pid == null) return;
    cancelled = true;
    try { process.kill(-child.pid, 'SIGTERM'); } catch (e) {}
    setTimeout(() => {
      try { process.kill(-child.pid, 0); process.kill(-child.pid, 'SIGKILL'); } catch (e) {}
    }, 1500).unref();
  }
  return { child, done, cancel };
}

module.exports = { runEngine, engineEnv };
