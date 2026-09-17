// bridge/watchfolder-store.js
// Config + state nằm ngoài repo, cùng chỗ hotkeys.json, nên không mất khi
// cập nhật bridge. setDir() để test chạy trên thư mục tạm.

const fs   = require('fs');
const os   = require('os');
const path = require('path');

let DIR = path.join(os.homedir(), 'Library', 'Application Support', 'ClaudeBridge');

function setDir(d) { DIR = d; }
function configPath() { return path.join(DIR, 'watchfolder-config.json'); }
function statePath()  { return path.join(DIR, 'watchfolder-state.json'); }

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return fallback; }   // thiếu file hoặc JSON hỏng đều không được làm sập bridge
}

// Ghi qua file tạm rồi rename: bridge bị kill giữa chừng cũng không để lại
// file JSON cụt làm mất toàn bộ config.
function writeJson(file, data) {
  fs.mkdirSync(DIR, { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function readConfig(projectPath) {
  const all = readJson(configPath(), {});
  const list = all && all[projectPath];
  return Array.isArray(list) ? list : [];
}

function writeConfig(projectPath, watches) {
  const all = readJson(configPath(), {}) || {};
  all[projectPath] = watches;
  writeJson(configPath(), all);
}

function readState()  { return readJson(statePath(), {}) || {}; }
function writeState(s) { writeJson(statePath(), s); }

module.exports = { setDir, readConfig, writeConfig, readState, writeState, configPath, statePath };
