// bridge/test/watchfolder-store.test.js
const assert = require('assert');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const store = require('../watchfolder-store.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-store-'));
store.setDir(dir);

const PROJ = '/Users/x/Series_A.prproj';

// 1. Project chưa có config → mảng rỗng, không ném
assert.deepStrictEqual(store.readConfig(PROJ), [], 'chưa có config → []');

// 2. Ghi rồi đọc lại đúng nguyên vẹn
const watches = [{ id: 'w_1', folder: '/a', binPath: 'Footage', include: ['video'] }];
store.writeConfig(PROJ, watches);
assert.deepStrictEqual(store.readConfig(PROJ), watches, 'đọc lại đúng');

// 3. Config của project khác không đè lên nhau
store.writeConfig('/Users/x/Series_B.prproj', []);
assert.deepStrictEqual(store.readConfig(PROJ), watches, 'project khác không đè config');

// 4. File config hỏng → trả [] chứ không làm sập bridge
fs.writeFileSync(path.join(dir, 'watchfolder-config.json'), '{ hỏng');
assert.deepStrictEqual(store.readConfig(PROJ), [], 'JSON hỏng → [] chứ không ném');

// 5. State đọc/ghi
store.writeConfig(PROJ, watches);
assert.deepStrictEqual(store.readState(), {}, 'state rỗng ban đầu');
store.writeState({ 'w_1': { snapshot: { 'a.mp4': [3, 111] } } });
assert.deepStrictEqual(store.readState()['w_1'].snapshot['a.mp4'], [3, 111], 'state lưu snapshot');

// 6. Ghi state là atomic — file tạm được dọn, không để lại rác
store.writeState({ 'w_1': { snapshot: {} } });
const leftovers = fs.readdirSync(dir).filter(f => f.endsWith('.tmp'));
assert.deepStrictEqual(leftovers, [], 'không để lại file .tmp');

fs.rmSync(dir, { recursive: true, force: true });
console.log('watchfolder-store: OK');
