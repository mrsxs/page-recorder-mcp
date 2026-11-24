// 脚本库存到本机目录、只发 npm 时扩展目录和技能跟着更新
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { createLibrary, syncBrowser, restoreOwner, CHUNK_CHARS } = require('../bridge/library.js');
const { createUpdater, compareVersions, unpackedExtensionId, browserDataRoots, EXTENSION_FILES } = require('../bridge/updater.js');
const PR_EXPORTER = require('../lib/exporter.js');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = (name) => realpathSync(mkdtempSync(join(tmpdir(), `pr-${name}-`)));
const item = (id, savedAt, extra) => ({ id, name: `脚本 ${id}`, savedAt, state: { startUrl: 'https://app.test/' }, events: [{ kind: 'step', ts: 1, type: 'navigate', url: 'https://app.test/' }], ...extra });
const step = (id, extra) => ({ kind: 'step', id, ts: 1, ...extra });

// 假的浏览器一侧：按 background.js 的约定应答同步方法
function fakeBrowser(instanceId, items = []) {
  const lib = new Map(items.map((x) => [x.id, x]));
  const deleted = new Map();
  const parts = new Map();
  const state = { conn: { instanceId, profile: instanceId }, lib, deleted, offers: null, sources: [] };
  state.call = async (method, p) => {
    if (method === 'libraryManifest') return { items: [...lib.values()].map((x) => ({ id: x.id, savedAt: x.savedAt })), deleted: [...deleted].map(([id, at]) => ({ id, at })) };
    if (method === 'libraryGet') {
      const text = JSON.stringify(lib.get(p.id));
      const end = p.offset + p.limit;
      return { chunk: text.slice(p.offset, end), done: end >= text.length };
    }
    if (method === 'libraryRestore') {
      const text = (p.start ? '' : parts.get(p.id) || '') + p.chunk;
      if (!p.done) { parts.set(p.id, text); return { ok: true }; }
      const x = JSON.parse(text);
      if ((deleted.get(x.id) || 0) >= x.savedAt || (lib.get(x.id)?.savedAt >= x.savedAt)) return { ok: true, skipped: true };
      state.sources.push(p.sourceExtension);
      lib.set(x.id, x);
      return { ok: true };
    }
    if (method === 'libraryOffer') { state.offers = p.offers; return { ok: true }; }
    throw new Error('未知方法 ' + method);
  };
  return state;
}
const sync = (store, b, others = []) => syncBrowser(store, b.conn, b.call, { extensionId: 'ext', connected: new Set([b.conn.instanceId, ...others]), log: () => {} });
const restore = (store, b, owner, { offered = (b.offers || []).map((x) => x.owner), others = [] } = {}) => restoreOwner(store, b.conn, b.call, owner, { extensionId: 'ext', offered: new Set(offered), connected: new Set([b.conn.instanceId, ...others]) });

test('脚本存到本机目录；扩展重装后可以恢复，API Key 不落盘', async () => {
  const dir = tmp('lib');
  try {
    const store = createLibrary(dir);
    const old = fakeBrowser('old', [item('a', 10, { settings: { aiApiKey: 'SECRET-KEY' } })]);
    await sync(store, old);
    assert.doesNotMatch(readFileSync(store.fileOf('old', 'a'), 'utf8'), /SECRET-KEY/);
    if (process.platform !== 'win32') assert.equal(statSync(store.fileOf('old', 'a')).mode & 0o077, 0);

    // 重新打开目录（桥接重启）、扩展重装成新实例：不自动并入，给出可恢复的一组
    const reopened = createLibrary(dir);
    const fresh = fakeBrowser('new');
    await sync(reopened, fresh);
    assert.equal(fresh.lib.size, 0);
    assert.deepEqual(fresh.offers.map((x) => [x.owner, x.count]), [['old', 1]]);
    assert.equal(await restore(reopened, fresh, 'old'), 1);
    assert.equal(fresh.lib.get('a').name, '脚本 a');
    assert.deepEqual(fresh.sources, ['ext']);
    assert.equal(reopened.get('new', 'a').owner.instanceId, 'new');
    assert.equal(reopened.get('old', 'a').owner.instanceId, 'old', '来源的备份不动');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('两个资料里同 id 的脚本各存一份，互不覆盖', async () => {
  const dir = tmp('lib');
  try {
    const store = createLibrary(dir);
    const a = fakeBrowser('a', [item('x', 10, { name: 'A 的' })]);
    const b = fakeBrowser('b', [item('x', 20, { name: 'B 的' })]);
    await sync(store, a, ['b']);
    await sync(store, b, ['a']);
    assert.equal(store.read('a', 'x').name, 'A 的');
    assert.equal(store.read('b', 'x').name, 'B 的');
    assert.equal(createLibrary(dir).read('a', 'x').name, 'A 的', '重新打开目录后还在');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('恢复被扩展跳过时不算成功，不转移归属，备份也不会被下一轮同步删掉', async () => {
  const dir = tmp('lib');
  try {
    const store = createLibrary(dir);
    await sync(store, fakeBrowser('old', [item('x', 10)]));
    const fresh = fakeBrowser('new');
    fresh.deleted.set('x', 20);
    assert.equal(await restore(store, fresh, 'old', { offered: ['old'] }), 0);
    await sync(store, fresh);
    assert.equal(store.get('new', 'x'), null);
    assert.equal(store.get('old', 'x').savedAt, 10);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('从别的扩展 ID 恢复的，备份里也标成导入，再次重装不会变回原生脚本', async () => {
  const dir = tmp('lib');
  try {
    const store = createLibrary(dir);
    const a = fakeBrowser('a', [item('x', 10)]);
    await syncBrowser(store, a.conn, a.call, { extensionId: 'ext-a', connected: new Set(['a']), log: () => {} });
    const b = fakeBrowser('b');
    await syncBrowser(store, b.conn, b.call, { extensionId: 'ext-b', connected: new Set(['b']), log: () => {} });
    const n = await restoreOwner(store, b.conn, b.call, 'a', { extensionId: 'ext-b', offered: new Set(['a']), connected: new Set(['b']) });
    assert.equal(n, 1);
    assert.equal(store.read('b', 'x').imported, true);
    assert.equal(store.read('a', 'x').imported, undefined, '来源的备份不动');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('只能恢复发给这个连接的、当前不在线的来源', async () => {
  const dir = tmp('lib');
  try {
    const store = createLibrary(dir);
    await sync(store, fakeBrowser('victim', [item('x', 10)]));
    const b = fakeBrowser('b');
    assert.equal(await restore(store, b, 'victim', { offered: [] }), 0, '没提供过的来源');
    assert.equal(await restore(store, b, 'victim', { offered: ['victim'], others: ['victim'] }), 0, '在线的资料');
    assert.equal(b.lib.size, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('删掉恢复来的脚本后，再次重装不会再提示；来源资料还在用时取消隐藏', async () => {
  const dir = tmp('lib');
  try {
    const store = createLibrary(dir);
    const first = fakeBrowser('first', [item('x', 10), item('keep', 10)]);
    await sync(store, first);
    const second = fakeBrowser('second');
    await sync(store, second);
    assert.equal(await restore(store, second, 'first'), 2);
    await sync(store, second);
    second.lib.delete('x');
    second.deleted.set('x', 20);
    await sync(store, second);

    const third = fakeBrowser('third');
    await sync(store, third);
    assert.deepEqual(third.offers.map((x) => x.count), [1, 1], '每组只剩没删的那条');
    assert.equal(await restore(store, third, 'first'), 1);
    assert.equal(third.lib.has('x'), false);
    assert.equal(third.lib.has('keep'), true);
    assert.ok(existsSync(store.fileOf('first', 'x')), '来源的文件还在');

    await sync(store, first);
    assert.equal(store.get('first', 'x').dismissed, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('备份不留密码框的明文，请求和说明里同样的值换成占位符', () => {
  const pwd = step('p1', { type: 'fill', target: { type: 'password', name: 'loginKey' }, value: 'Hunter-2-Secret', recordedValue: 'Hunter-2-Secret' });
  const shown = step('p2', { type: 'fill', secretInput: true, target: { type: 'text', name: 'x' }, value: 'Shown-Secret-9' });
  const normal = step('n1', { type: 'fill', target: { type: 'text', name: 'city' }, value: '杭州', effects: [{ desc: '回填', value: 'Hunter-2-Secret' }] });
  const req = { kind: 'request', id: 'r1', ts: 5, method: 'POST', url: 'https://app.test/login', requestBody: { type: 'json', value: { user: 'a', note: 'Hunter-2-Secret' } } };
  const out = PR_EXPORTER.scrubBackup({ id: 'a', events: [pwd, shown, normal, req], apiOverrides: { x: 'Hunter-2-Secret' }, aiDocs: { description: '密码 Shown-Secret-9' } });
  const text = JSON.stringify(out);
  assert.doesNotMatch(text, /Hunter-2-Secret|Shown-Secret-9/);
  assert.equal(out.events[0].sensitive, true);
  assert.equal(out.events[0].secretId, 'p1');
  assert.equal(out.events[2].value, '杭州');
  assert.match(text, /__PR_SECRET_p1__/);
});

test('写接口失败时不自动再发一次，只有没发出、鉴权被拒、只读接口才回放', () => {
  const can = PR_EXPORTER.canFallback;
  assert.equal(can('POST', { notSent: true }), true);
  assert.equal(can('POST', { status: 401 }), true);
  assert.equal(can('POST', { status: 403, rejected: true }), true);
  assert.equal(can('POST', { status: 200, rejected: true }), false, '业务码不同');
  assert.equal(can('POST', { status: 422 }), false);
  assert.equal(can('DELETE', { status: 409 }), false);
  assert.equal(can('GET', { status: 200, rejected: true }), true);
  assert.equal(can('GET', { status: 404 }), true);
  assert.equal(can('GET', { status: 429 }), false);
  assert.equal(can('GET', { status: 200, unknown: true }), false);
});

test('按 savedAt 同步：新的覆盖旧的，超过一段的大脚本完整存下', async () => {
  const dir = tmp('lib');
  try {
    const store = createLibrary(dir);
    const big = item('big', 1, { description: 'x'.repeat(CHUNK_CHARS + 100) });
    const b = fakeBrowser('i', [item('a', 1), big]);
    await sync(store, b);
    assert.equal(store.read('i', 'big').description.length, CHUNK_CHARS + 100);
    b.lib.set('a', item('a', 2, { name: '改过' }));
    await sync(store, b);
    assert.equal(store.read('i', 'a').name, '改过');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('删除同步到本机目录，已删的不会被补回；删除后重新保存的算新的', async () => {
  const dir = tmp('lib');
  try {
    const store = createLibrary(dir);
    const b = fakeBrowser('i', [item('a', 10)]);
    await sync(store, b);
    b.lib.delete('a');
    b.deleted.set('a', 20);
    await sync(store, b);
    assert.equal(existsSync(store.fileOf('i', 'a')), false);
    await sync(store, b);
    assert.equal(b.lib.has('a'), false);
    b.deleted.delete('a');
    b.lib.set('a', item('a', 30));
    await sync(store, b);
    assert.equal(store.get('i', 'a').savedAt, 30);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('同一实例丢了但没删过的脚本自动补回；正在连着的别的资料不算可恢复', async () => {
  const dir = tmp('lib');
  try {
    const store = createLibrary(dir);
    const b = fakeBrowser('i', [item('a', 1)]);
    const other = fakeBrowser('other', [item('z', 1)]);
    await sync(store, b);
    await sync(store, other);
    b.lib.clear();
    await sync(store, b, ['other']);
    assert.equal(b.lib.has('a'), true);
    assert.deepEqual(b.offers, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('一个资料删除脚本，不影响另一个资料还在用的那份', async () => {
  const dir = tmp('lib');
  try {
    const store = createLibrary(dir);
    const a = fakeBrowser('a', [item('x', 10)]);
    const b = fakeBrowser('b', [item('x', 10)]);
    await sync(store, a);
    b.lib.delete('x');
    b.deleted.set('x', 20);
    await sync(store, b, ['a']);
    assert.equal(store.get('a', 'x').owner.instanceId, 'a');
    assert.equal(a.lib.has('x'), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('一条恢复失败不影响后面的，也照样告诉弹窗可恢复的脚本', async () => {
  const dir = tmp('lib');
  try {
    const store = createLibrary(dir);
    const b = fakeBrowser('i', [item('bad', 1), item('good', 2)]);
    await sync(store, b);
    b.lib.clear();
    const call = b.call;
    b.call = async (method, p) => { if (method === 'libraryRestore' && p.id === 'bad') throw new Error('格式不对'); return call(method, p); };
    await sync(store, b);
    assert.deepEqual([...b.lib.keys()], ['good']);
    assert.ok(Array.isArray(b.offers));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('版本比较和已解压扩展 ID', () => {
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(compareVersions('1.5.0', '1.5.0'), 0);
  assert.equal(compareVersions('1.4.9', '1.5'), -1);
  assert.match(unpackedExtensionId('/Users/a/ext'), /^[a-p]{32}$/);
  assert.equal(unpackedExtensionId('c:\\ext', 'win32'), unpackedExtensionId('C:\\ext', 'win32'));
});

// 一份“新版 npm 包”和一个旧版扩展目录
function fixture(version = '9.0.0', extName = 'ext', browserRoots = [], pkgName = 'pkg') {
  const base = tmp('update');
  const pkg = join(base, pkgName);
  const ext = join(base, extName);
  const home = join(base, 'home');
  const stateDir = join(base, 'state');
  for (const f of EXTENSION_FILES) {
    const target = join(pkg, f);
    if (f.includes('.')) { mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, f === 'manifest.json' ? JSON.stringify({ name: 'Page Recorder', version }) : `new ${f}`); } else { mkdirSync(target, { recursive: true }); writeFileSync(join(target, 'a.js'), `new ${f}`); }
  }
  mkdirSync(join(pkg, 'skills/page-recorder'), { recursive: true });
  writeFileSync(join(pkg, 'skills/page-recorder/SKILL.md'), 'new skill');
  mkdirSync(join(ext, 'lib'), { recursive: true });
  writeFileSync(join(ext, 'lib', 'a.js'), 'old lib');
  writeFileSync(join(ext, 'manifest.json'), JSON.stringify({ name: 'Page Recorder', version: '1.0.0' }));
  writeFileSync(join(ext, 'background.js'), 'old');
  mkdirSync(home, { recursive: true });
  const logs = [];
  const updater = createUpdater({ root: pkg, version, stateDir, home, log: (x) => logs.push(x), browserRoots });
  return { base, pkg, ext, home, stateDir, updater, logs };
}
const browser = (ext, extra) => ({ instanceId: 'i1', version: '1.0.0', extensionId: unpackedExtensionId(ext), capabilities: ['selfUpdate'], ...extra });
const caller = (prepare = { ok: true }, reload = { ok: true }) => {
  const calls = [];
  return { calls, call: async (b, method) => { calls.push(method); if (method === 'updatePrepare') return prepare; if (method === 'updateReload' && reload instanceof Error) throw reload; return method === 'updateReload' ? reload : { ok: true }; } };
};

test('新版：先确认空闲，再写扩展目录，最后重新加载；同一版本只试一次', async () => {
  const f = fixture();
  try {
    f.updater.rememberExtensionDir(f.ext);
    const c = caller();
    await f.updater.updateExtensions([browser(f.ext)], c.call);
    assert.deepEqual(c.calls, ['updatePrepare', 'updateReload']);
    assert.equal(JSON.parse(readFileSync(join(f.ext, 'manifest.json'), 'utf8')).version, '9.0.0');
    assert.equal(readFileSync(join(f.ext, 'background.js'), 'utf8'), 'new background.js');
    assert.equal(readdirSync(f.base).some((x) => x.includes('.update-')), false);
    const again = caller();
    await f.updater.updateExtensions([browser(f.ext)], again.call);
    assert.deepEqual(again.calls, [], '重载后版本没变也不反复重载');
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('扩展目录在中文路径下（C:\\靖云\\page-recorder-1.6.0 这种）：照样覆盖成新版，不留临时目录', async () => {
  const f = fixture('9.0.0', join('靖云', 'page-recorder-1.6.0'), [], join('用户', 'npm-cache', 'pkg'));
  try {
    f.updater.rememberExtensionDir(f.ext);
    const c = caller();
    await f.updater.updateExtensions([browser(f.ext)], c.call);
    assert.deepEqual(c.calls, ['updatePrepare', 'updateReload'], f.logs.join('\n'));
    assert.equal(JSON.parse(readFileSync(join(f.ext, 'manifest.json'), 'utf8')).version, '9.0.0');
    assert.equal(readFileSync(join(f.ext, 'lib', 'a.js'), 'utf8'), 'new lib');
    assert.equal(readdirSync(dirname(f.ext)).some((x) => x.includes('.update-')), false);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

// 用户自己“加载已解压的扩展程序”选的目录：没登记过，从浏览器资料的 Preferences 里按扩展 ID 找到
function withProfile(f, dirs) {
  const roots = join(f.base, 'Chrome User Data');
  mkdirSync(join(roots, 'Default'), { recursive: true });
  mkdirSync(join(roots, 'Profile 1'), { recursive: true });
  const settings = Object.fromEntries(dirs.map((d) => [unpackedExtensionId(d), { location: 4, path: d }]));
  settings.storeext = { location: 1, path: 'storeext/1.0_0' };
  writeFileSync(join(roots, 'Default', 'Preferences'), JSON.stringify({ extensions: { settings: {} } }));
  writeFileSync(join(roots, 'Profile 1', 'Secure Preferences'), JSON.stringify({ extensions: { settings } }));
  return createUpdater({ root: f.pkg, version: '9.0.0', stateDir: f.stateDir, home: f.home, log: (x) => f.logs.push(x), browserRoots: [roots, join(f.base, '没装这个浏览器')] });
}
test('没登记的扩展目录：从浏览器资料里按扩展 ID 找到，第一次就更新', async () => {
  const f = fixture('9.0.0', join('靖云', 'page-recorder-1.6.0'));
  try {
    const updater = withProfile(f, [f.ext]);
    const c = caller();
    await updater.updateExtensions([browser(f.ext)], c.call);
    assert.deepEqual(c.calls, ['updatePrepare', 'updateReload'], f.logs.join('\n'));
    assert.equal(JSON.parse(readFileSync(join(f.ext, 'manifest.json'), 'utf8')).version, '9.0.0');
    assert.match(f.logs.join('\n'), /在浏览器资料里找到扩展目录/);
    assert.deepEqual(JSON.parse(readFileSync(join(f.stateDir, 'update.json'), 'utf8')).extensionDirs, [f.ext], '记下来，下次不用再找');
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});
test('扩展放在源码仓库的子目录里（.git 在上级目录）：不动', async () => {
  const f = fixture('9.0.0', join('repo', 'extension'));
  try {
    mkdirSync(join(f.base, 'repo', '.git'));
    const updater = withProfile(f, [f.ext]);
    const c = caller();
    await updater.updateExtensions([browser(f.ext)], c.call);
    assert.deepEqual(c.calls, []);
    assert.equal(JSON.parse(readFileSync(join(f.ext, 'manifest.json'), 'utf8')).version, '1.0.0');
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});
test('整个用户主目录是 git 仓库（管配置文件）：主目录下的扩展目录照样更新', async () => {
  const f = fixture();
  try {
    const ext = join(f.home, 'page-recorder-extension');
    mkdirSync(join(f.home, '.git'));
    mkdirSync(ext);
    writeFileSync(join(ext, 'manifest.json'), JSON.stringify({ name: 'Page Recorder', version: '1.0.0' }));
    const c = caller();
    await f.updater.updateExtensions([browser(ext)], c.call);
    assert.deepEqual(c.calls, ['updatePrepare', 'updateReload'], f.logs.join('\n'));
    assert.equal(JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8')).version, '9.0.0');
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});
test('浏览器资料里还找不到这个扩展：隔一分钟再找，最多 3 次', async () => {
  const f = fixture();
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    const updater = withProfile(f, []);
    const run = async (advance) => { now += advance; return (await updater.updateExtensions([browser(f.ext)], caller().call)).retry; };
    // 第 1 次找；马上再触发不找；隔一分钟第 2、3 次；之后不再找、不再要求重试
    assert.deepEqual([await run(0), await run(1000), await run(61000), await run(61000), await run(61000)], [true, true, true, false, false]);
  } finally { Date.now = realNow; rmSync(f.base, { recursive: true, force: true }); }
});
test('更新锁：持有者还在就等下一轮；持有者没了、锁也过期了才回收', async () => {
  const f = fixture();
  try {
    f.updater.rememberExtensionDir(f.ext);
    const lock = join(f.stateDir, 'update.lock');
    mkdirSync(lock);
    writeFileSync(join(lock, 'owner'), String(process.pid));
    const old = new Date(Date.now() - 120000);
    utimesSync(lock, old, old);
    assert.equal((await f.updater.updateExtensions([browser(f.ext)], caller().call)).retry, true, '持有者还活着，锁再旧也不回收');
    writeFileSync(join(lock, 'owner'), '999999999');
    utimesSync(lock, old, old);
    const c = caller();
    await f.updater.updateExtensions([browser(f.ext)], c.call);
    assert.deepEqual(c.calls, ['updatePrepare', 'updateReload']);
    assert.equal(existsSync(lock), false, '用完释放');
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});
test('扩展目录里的旧文件是只读的：照样换成新版', async () => {
  const f = fixture();
  try {
    chmodSync(join(f.ext, 'background.js'), 0o444);
    f.updater.rememberExtensionDir(f.ext);
    const c = caller();
    await f.updater.updateExtensions([browser(f.ext)], c.call);
    assert.deepEqual(c.calls, ['updatePrepare', 'updateReload'], f.logs.join('\n'));
    assert.equal(readFileSync(join(f.ext, 'background.js'), 'utf8'), 'new background.js');
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});
test('扩展目录里有链接（符号链接、目录联接）：不自动更新，免得写到目录外面', { skip: process.platform === 'win32' }, async () => {
  const f = fixture();
  try {
    const shared = join(f.base, 'shared');
    mkdirSync(shared);
    rmSync(join(f.ext, 'lib'), { recursive: true, force: true });
    symlinkSync(shared, join(f.ext, 'lib'));
    f.updater.rememberExtensionDir(f.ext);
    const c = caller();
    await f.updater.updateExtensions([browser(f.ext)], c.call);
    assert.deepEqual(c.calls, []);
    assert.deepEqual(readdirSync(shared), []);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});
test('浏览器资料目录：各系统的 Chrome / Edge 等，PR_BROWSER_DATA_DIRS 指定的排在最前', () => {
  const win = browserDataRoots('C:\\Users\\a', 'win32', { LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local', PR_BROWSER_DATA_DIRS: 'D:\\fp\\1;D:\\fp\\2' });
  assert.deepEqual(win.slice(0, 3), ['D:\\fp\\1', 'D:\\fp\\2', 'C:\\Users\\a\\AppData\\Local\\Google\\Chrome\\User Data']);
  assert.ok(win.includes('C:\\Users\\a\\AppData\\Local\\Microsoft\\Edge\\User Data'));
  const mac = browserDataRoots('/Users/a', 'darwin', {});
  assert.equal(mac[0], '/Users/a/Library/Application Support/Google/Chrome');
  const linux = browserDataRoots('/home/a', 'linux', { CHROME_CONFIG_HOME: '/opt/chrome-cfg' });
  assert.equal(linux[0], '/opt/chrome-cfg/google-chrome');
  assert.ok(linux.includes('/opt/chrome-cfg/chromium') && linux.includes('/home/a/.config/microsoft-edge'));
});
test('浏览器资料里记着的是源码目录（有 .git）：照样不动', async () => {
  const f = fixture();
  try {
    mkdirSync(join(f.ext, '.git'));
    const updater = withProfile(f, [f.ext]);
    const c = caller();
    await updater.updateExtensions([browser(f.ext)], c.call);
    assert.deepEqual(c.calls, []);
    assert.equal(JSON.parse(readFileSync(join(f.ext, 'manifest.json'), 'utf8')).version, '1.0.0');
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('重新加载没成功时下一轮再来，文件不用再写一遍', async () => {
  const f = fixture();
  try {
    f.updater.rememberExtensionDir(f.ext);
    const failed = caller({ ok: true }, new Error('连接断了'));
    assert.equal((await f.updater.updateExtensions([browser(f.ext)], failed.call)).retry, true);
    assert.equal(JSON.parse(readFileSync(join(f.ext, 'manifest.json'), 'utf8')).version, '9.0.0');
    const again = caller();
    assert.equal((await f.updater.updateExtensions([browser(f.ext)], again.call)).retry, false);
    assert.deepEqual(again.calls, ['updatePrepare', 'updateReload']);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('写扩展目录中途失败：全部还原、不重新加载，稍后重试，试够次数就停', async () => {
  const f = fixture();
  try {
    f.updater.rememberExtensionDir(f.ext);
    mkdirSync(join(f.ext, 'popup/a.js'), { recursive: true }); // 目标位置是目录，换到这个文件时会失败
    for (const expected of [true, true, false]) {
      const c = caller();
      assert.equal((await f.updater.updateExtensions([browser(f.ext)], c.call)).retry, expected);
      assert.deepEqual(c.calls, ['updatePrepare', 'updateAbort']);
      assert.equal(readFileSync(join(f.ext, 'background.js'), 'utf8'), 'old');
      assert.equal(existsSync(join(f.ext, 'content/a.js')), false, '新增的文件也撤掉');
      assert.equal(JSON.parse(readFileSync(join(f.ext, 'manifest.json'), 'utf8')).version, '1.0.0');
      assert.equal(readdirSync(f.base).some((x) => x.includes('.update-')), false);
    }
    const stopped = caller();
    assert.equal((await f.updater.updateExtensions([browser(f.ext)], stopped.call)).retry, false);
    assert.deepEqual(stopped.calls, [], '试够次数后不再打扰扩展');
    rmSync(join(f.ext, 'popup'), { recursive: true });
    const restarted = createUpdater({ root: f.pkg, version: '9.0.0', stateDir: f.stateDir, home: f.home, log: () => {} });
    const ok = caller();
    assert.equal((await restarted.updateExtensions([browser(f.ext)], ok.call)).retry, false);
    assert.equal(readFileSync(join(f.ext, 'background.js'), 'utf8'), 'new background.js');
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('--no-auto-update 会传给后台桥接', { skip: process.platform === 'win32' }, async () => {
  const dir = tmp('daemon');
  const port = 20000 + Math.floor(Math.random() * 20000);
  const env = { ...process.env, PR_BRIDGE_DIR: dir };
  delete env.PR_AUTO_UPDATE;
  const p = spawn(process.execPath, [join(root, 'bridge/server.js'), '--stdio', '--port', String(port), '--no-auto-update'], { env, stdio: ['pipe', 'ignore', 'ignore'] });
  let pid = 0;
  try {
    for (const end = Date.now() + 8000; !pid && Date.now() < end; await new Promise((r) => setTimeout(r, 100))) {
      try { pid = (await (await fetch(`http://127.0.0.1:${port}/api/status`)).json()).pid; } catch (e) { /* 还没起来 */ }
    }
    assert.ok(pid && pid !== p.pid, '起了单独的后台桥接');
    assert.match(execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }), /--daemon.*--no-auto-update/);
  } finally {
    p.kill();
    if (pid) { try { process.kill(pid); } catch (e) { /* 已经退出 */ } }
    await new Promise((r) => setTimeout(r, 200));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('录制或回放中不写文件，稍后重试；关闭自动更新时不动', async () => {
  const f = fixture();
  try {
    f.updater.rememberExtensionDir(f.ext);
    const busy = caller({ ok: false, busy: true });
    assert.equal((await f.updater.updateExtensions([browser(f.ext)], busy.call)).retry, true);
    assert.equal(readFileSync(join(f.ext, 'background.js'), 'utf8'), 'old');
    const off = caller({ ok: false, disabled: true });
    assert.equal((await f.updater.updateExtensions([browser(f.ext)], off.call)).retry, false);
    assert.equal(readFileSync(join(f.ext, 'background.js'), 'utf8'), 'old');
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('只更新 ID 对得上的目录；旧版扩展、源码目录、不是更新的版本都不动', async () => {
  const f = fixture();
  try {
    f.updater.rememberExtensionDir(f.ext);
    for (const b of [browser(f.ext, { extensionId: 'p'.repeat(32) }), browser(f.ext, { capabilities: [] }), browser(f.ext, { version: '9.0.0' }), browser(f.ext, { version: '10.0.0' })]) {
      const c = caller();
      await f.updater.updateExtensions([b], c.call);
      assert.deepEqual(c.calls, []);
    }
    mkdirSync(join(f.ext, '.git'));
    const c = caller();
    await f.updater.updateExtensions([browser(f.ext)], c.call);
    assert.deepEqual(c.calls, []);
    assert.equal(readFileSync(join(f.ext, 'background.js'), 'utf8'), 'old');
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('技能：只更新已安装的，第一次先备份，用户之后改过的不覆盖', async () => {
  const f = fixture();
  try {
    const wb = join(f.home, '.workbuddy/skills/page-recorder/SKILL.md');
    mkdirSync(dirname(wb), { recursive: true });
    writeFileSync(wb, 'old skill');
    await f.updater.updateSkills();
    assert.equal(readFileSync(wb, 'utf8'), 'new skill');
    assert.equal(existsSync(join(f.home, '.claude/skills/page-recorder/SKILL.md')), false);
    const backups = readdirSync(join(f.stateDir, 'skill-backups'));
    assert.equal(readFileSync(join(f.stateDir, 'skill-backups', backups[0]), 'utf8'), 'old skill');
    writeFileSync(wb, 'my edits');
    await f.updater.updateSkills();
    assert.equal(readFileSync(wb, 'utf8'), 'my edits');
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('技能是符号链接时不动', { skip: process.platform === 'win32' }, async () => {
  const f = fixture();
  try {
    const wb = join(f.home, '.workbuddy/skills/page-recorder/SKILL.md');
    const real = join(f.base, 'my-skill.md');
    mkdirSync(dirname(wb), { recursive: true });
    writeFileSync(real, 'my own skill');
    symlinkSync(real, wb);
    await f.updater.updateSkills();
    assert.equal(lstatSync(wb).isSymbolicLink(), true);
    assert.equal(readFileSync(real, 'utf8'), 'my own skill');
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('发布包包含桥接模块和技能', () => {
  const { files } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.ok(files.includes('bridge/'));
  assert.ok(files.includes('skills/'));
});
