// 同一台电脑上几个环境（浏览器资料、指纹浏览器）之间共享脚本
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import crypto, { webcrypto } from 'node:crypto';
import { spawn } from 'node:child_process';
import net from 'node:net';
import http from 'node:http';

const require = createRequire(import.meta.url);
const { createShared, syncEnv, shareOn, shareOff } = require('../bridge/shared.js');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'pr-shared-')));
const item = (id, savedAt, extra) => ({ id, name: `脚本 ${id}`, savedAt, state: { id, startUrl: 'https://app.test/' }, events: [{ kind: 'step', ts: 1, type: 'navigate', url: 'https://app.test/' }], ...extra });

// 各环境用同一个时钟（同一台电脑）
let now = 1000;
const tick = () => ++now;

// 假的环境：按 background.js 的约定应答
function fakeEnv(instanceId, items = [], { auto = false, profile } = {}) {
  const lib = new Map(items.map((x) => [x.id, x]));
  const deleted = new Map();
  const parts = new Map();
  const e = { env: { instanceId, profile: profile || `环境${instanceId}` }, lib, deleted, auto, state: null, notices: [], recording: null, failApply: 0 };
  const assemble = (p) => {
    const text = (p.start ? '' : parts.get(p.id) || '') + p.chunk;
    if (!p.done) { parts.set(p.id, text); return null; }
    parts.delete(p.id);
    return JSON.parse(text);
  };
  e.call = async (method, p) => {
    if (method === 'libraryManifest') return { items: [...lib.values()].map((x) => ({ id: x.id, savedAt: x.savedAt })), deleted: [...deleted].map(([id, at]) => ({ id, at })), autoReceiveShared: e.auto };
    if (method === 'libraryGet') {
      const text = JSON.stringify(lib.get(p.id));
      return { chunk: text.slice(p.offset, p.offset + p.limit), done: p.offset + p.limit >= text.length };
    }
    if (method === 'sharedApply') {
      const raw = assemble(p);
      if (!raw) return { ok: true };
      if (p.copyName) {
        const id = p.copyId;
        if (lib.has(id) || deleted.has(id)) return { ok: true, id, existed: true };
        const savedAt = tick();
        lib.set(id, { ...raw, id, name: p.copyName, savedAt });
        return { ok: true, id, savedAt };
      }
      if (e.failApply) { e.failApply--; return { ok: false, changed: true }; }
      if (e.recording === raw.id) return { ok: false, busy: true };
      if ((lib.has(raw.id) ? lib.get(raw.id).savedAt : 0) !== (p.expectAt || 0)) return { ok: false, changed: true };
      const savedAt = p.fromLan || !Number.isFinite(raw.savedAt) ? tick() : raw.savedAt; // 和扩展一样沿用共享版本的保存时间
      lib.set(raw.id, { ...raw, savedAt });
      deleted.delete(raw.id);
      return { ok: true, savedAt };
    }
    if (method === 'sharedRemove') {
      if (e.recording === p.id) return { ok: false, busy: true };
      if (!lib.has(p.id) || lib.get(p.id).savedAt !== p.expectAt) return { ok: false, changed: true };
      lib.delete(p.id);
      deleted.set(p.id, tick());
      return { ok: true };
    }
    if (method === 'sharedState') { e.state = { ...e.state, ...p }; e.notices.push(...p.notices); return { ok: true }; } // 只带提示的不换列表（和扩展一样）
    throw new Error('未知方法 ' + method);
  };
  e.edit = (id, patch) => lib.set(id, { ...lib.get(id), ...patch, savedAt: tick() });
  e.remove = (id) => { lib.delete(id); deleted.set(id, tick()); };
  return e;
}
const sync = (store, e, receive) => syncEnv(store, e.env, e.call, { receive: new Set(receive || []) });
const share = (store, e, id) => shareOn(store, e.env, e.call, id);
const names = (e) => [...e.lib.values()].map((x) => x.name).sort();

test('共享后别的环境能接收；之后哪边改了另一边跟着更新，不在线的连上后补上', async () => {
  const dir = tmp();
  try {
    const store = createShared(dir);
    const a = fakeEnv('a', [item('x', tick())]);
    const b = fakeEnv('b');
    const c = fakeEnv('c');
    assert.equal(await share(store, a, 'x'), true);
    await sync(store, a);
    assert.deepEqual(a.state.shared, [{ id: 'x', others: [] }]);
    await sync(store, b);
    assert.equal(b.lib.size, 0, '不自动接收');
    assert.deepEqual(b.state.offers.map((x) => [x.id, x.from]), [['x', '环境a']]);
    await sync(store, b, ['x']);
    await sync(store, c, ['x']);
    assert.equal(b.lib.get('x').name, '脚本 x');
    assert.deepEqual(b.state.shared, [{ id: 'x', others: ['环境a'] }]);

    a.edit('x', { name: 'A 改的' });
    assert.equal((await sync(store, a)).changed, true, '共享区变了，桥接要让别的环境同步');
    await sync(store, b);
    assert.equal(b.lib.get('x').name, 'A 改的');

    b.edit('x', { name: 'B 改的' });
    await sync(store, b);
    await sync(store, a);
    assert.equal(a.lib.get('x').name, 'B 改的');
    assert.equal((await sync(store, a)).changed, false, '刚同步过的不算改过，不会来回同步');

    // c 这段时间没连桥接
    await sync(store, c);
    assert.equal(c.lib.get('x').name, 'B 改的');
    assert.equal(createShared(dir).get('x').name, 'B 改的', '桥接重启后还在');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('开了自动接收的环境不用点；删过的、本来就有同 id 的不收', async () => {
  const dir = tmp();
  try {
    const store = createShared(dir);
    const a = fakeEnv('a', [item('x', tick()), item('y', tick())]);
    await share(store, a, 'x');
    await share(store, a, 'y');
    const auto = fakeEnv('auto', [item('y', tick(), { name: '自己的 y' })], { auto: true });
    auto.deleted.set('x', tick());
    await sync(store, auto);
    assert.deepEqual(names(auto), ['自己的 y']);
    assert.deepEqual(auto.state.offers, [], '这两条都不再提示');
    const fresh = fakeEnv('fresh', [], { auto: true });
    await sync(store, fresh);
    assert.deepEqual(names(fresh), ['脚本 x', '脚本 y']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('在用的环境删了：没改过的环境跟着删，改过的留下并提示；都处理完删除记录就清掉', async () => {
  const dir = tmp();
  try {
    const store = createShared(dir);
    const a = fakeEnv('a', [item('x', tick())]);
    const b = fakeEnv('b');
    const c = fakeEnv('c');
    await share(store, a, 'x');
    await sync(store, b, ['x']);
    await sync(store, c, ['x']);
    c.edit('x', { name: 'C 改了还没同步' });
    a.remove('x');
    assert.equal((await sync(store, a)).changed, true);
    await sync(store, b);
    assert.equal(b.lib.size, 0);
    assert.match(b.notices.join(), /已在 环境a 删除，这里也删了/);
    assert.ok(store.get('x').deleted, 'c 还没处理，删除记录留着');
    await sync(store, c);
    assert.equal(c.lib.get('x').name, 'C 改了还没同步');
    assert.match(c.notices.join(), /留作本环境的脚本/);
    assert.equal(store.get('x'), null);
    assert.deepEqual(readdirSync(join(dir, 'items')), []);
    await sync(store, c);
    assert.deepEqual(c.state.shared, [], '留下的那份不再共享');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('两个环境都改过：较新的成为共享版本，另一份另存，哪边改的都不丢', async () => {
  const dir = tmp();
  try {
    const store = createShared(dir);
    const a = fakeEnv('a', [item('x', tick())]);
    const b = fakeEnv('b');
    await share(store, a, 'x');
    await sync(store, b, ['x']);
    b.edit('x', { name: 'B 先改' });
    a.edit('x', { name: 'A 后改' });
    await sync(store, a); // A 先连上：A 的成为共享版本
    await sync(store, b); // B 改得更早：换成 A 的，B 的另存
    assert.deepEqual(names(b), ['A 后改', 'B 先改（本环境的版本）']);
    assert.match(b.notices.join(), /改得更晚/);
    await sync(store, a);
    assert.deepEqual(names(a), ['A 后改'], '另存的副本不共享');

    // 反过来：这个环境改得更晚。被盖掉的 A 那份另存在 A 自己那里
    a.edit('x', { name: 'A 再改' });
    b.edit('x', { name: 'B 再改（更晚）' });
    await sync(store, a);
    a.notices.length = 0;
    assert.equal((await sync(store, b)).changed, true);
    assert.deepEqual(names(b).filter((n) => /再改/.test(n)), ['B 再改（更晚）'], 'B 不用存 A 的');
    assert.match(b.notices.join(), /环境a 改的会在那边另存一份/);
    a.recording = 'x';
    await sync(store, a);
    assert.equal(a.lib.get('x').name, 'A 再改', '正在录：先不换');
    a.recording = null;
    await sync(store, a);
    assert.deepEqual(names(a).filter((n) => /再改/.test(n)), ['A 再改（本环境的版本）', 'B 再改（更晚）']);
    assert.match(a.notices.join(), /在 环境b 改得更晚：已换成那边的版本，这里改的另存为「A 再改（本环境的版本）」/);
    a.notices.length = 0;
    await sync(store, a);
    assert.deepEqual(a.notices, [], '只提示一次');
    assert.equal(store.get('x').keep, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('冲突时换版本没成功（刚又改了、正在录）：不提示，重试几轮也只另存一份', async () => {
  const dir = tmp();
  try {
    const store = createShared(dir);
    const a = fakeEnv('a', [item('x', tick())]);
    const b = fakeEnv('b');
    await share(store, a, 'x');
    await sync(store, b, ['x']);
    b.edit('x', { name: 'B 先改' });
    a.edit('x', { name: 'A 后改' });
    await sync(store, a);
    b.failApply = 2;
    await sync(store, b);
    await sync(store, b);
    assert.deepEqual(b.notices, []);
    assert.equal(b.lib.get('x').name, 'B 先改');
    await sync(store, b);
    assert.deepEqual(names(b), ['A 后改', 'B 先改（本环境的版本）']);
    assert.equal(b.notices.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('状态发不出去（超时）也照样报告共享区变了', async () => {
  const dir = tmp();
  try {
    const store = createShared(dir);
    const a = fakeEnv('a', [item('x', tick())]);
    await share(store, a, 'x');
    a.edit('x', { name: '改了' });
    const call = a.call;
    const r = await syncEnv(store, a.env, (m, p) => (m === 'sharedState' ? Promise.reject(new Error('执行超时')) : call(m, p)), { log: () => {} });
    assert.equal(r.changed, true);
    assert.equal(store.get('x').name, '改了');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('停止共享：环境里的脚本留着、不再跟着更新；都停了共享区就清掉', async () => {
  const dir = tmp();
  try {
    const store = createShared(dir);
    const a = fakeEnv('a', [item('x', tick())]);
    const b = fakeEnv('b');
    await share(store, a, 'x');
    await sync(store, b, ['x']);
    assert.equal(shareOff(store, b.env, 'x'), true);
    a.edit('x', { name: 'A 改的' });
    await sync(store, a);
    await sync(store, b);
    assert.equal(b.lib.get('x').name, '脚本 x');
    assert.deepEqual(b.state.offers, [], '自己有同 id 的不再提示');
    shareOff(store, a.env, 'x');
    assert.equal(store.get('x'), null);
    assert.equal(a.lib.get('x').name, 'A 改的');

    // 重新共享：内容一样的直接算在用，不一样的按两边都改过处理
    await share(store, a, 'x');
    assert.equal(await share(store, b, 'x'), true);
    assert.deepEqual(names(b), ['A 改的', '脚本 x（本环境的版本）']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('接收时应答丢了（断线）：下一轮发现内容一样就补记成在用；停止共享过的不会自己算回去', async () => {
  const dir = tmp();
  try {
    const store = createShared(dir);
    const a = fakeEnv('a', [item('x', tick())]);
    const b = fakeEnv('b');
    await share(store, a, 'x');
    const call = b.call;
    b.call = async (m, p) => { const r = await call(m, p); if (m === 'sharedApply' && p.done) throw new Error('浏览器扩展连接已断开'); return r; };
    await sync(store, b, ['x']);
    assert.ok(b.lib.has('x'), '扩展其实存好了');
    b.call = call;
    await sync(store, b);
    assert.deepEqual(b.state.shared, [{ id: 'x', others: ['环境a'] }]);
    a.edit('x', { name: 'A 改的' });
    await sync(store, a);
    await sync(store, b);
    assert.equal(b.lib.get('x').name, 'A 改的');

    shareOff(store, b.env, 'x');
    await sync(store, b);
    assert.deepEqual(b.state.shared, []);
    await share(store, b, 'x');
    assert.deepEqual(store.get('x').left, undefined, '重新共享就不算停止过了');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('删了之后同一轮里又存回去（编辑区）：不让别的环境跟着删', async () => {
  const dir = tmp();
  try {
    const store = createShared(dir);
    const a = fakeEnv('a', [item('x', tick())]);
    const b = fakeEnv('b');
    await share(store, a, 'x');
    await sync(store, b, ['x']);
    const saved = a.lib.get('x');
    a.remove('x');
    const call = a.call;
    let first = true;
    a.call = async (m, p) => {
      const r = await call(m, p);
      if (m === 'libraryManifest' && first) { first = false; a.lib.set('x', { ...saved, savedAt: tick() }); } // 取完清单就又存回去了
      return r;
    };
    await sync(store, a);
    assert.equal(store.get('x').deleted, undefined);
    await sync(store, b);
    assert.ok(b.lib.has('x'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('共享时这条正在录：明确报失败；共享区文件内容被改过（版本号对不上）不发出去', async () => {
  const dir = tmp();
  try {
    const store = createShared(dir);
    const a = fakeEnv('a', [item('x', tick())]);
    const b = fakeEnv('b');
    await share(store, a, 'x');
    await sync(store, b, ['x']);
    shareOff(store, b.env, 'x');
    a.edit('x', { name: 'A 改的' });
    await sync(store, a);
    b.edit('x', { name: 'B 更晚' });
    b.recording = 'x';
    a.edit('x', { name: 'A 最后改' });
    await sync(store, a);
    await assert.rejects(share(store, b, 'x'), /正在录制或刚改过/);

    const file = join(dir, 'items', readdirSync(join(dir, 'items'))[0]);
    const j = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...j, item: { ...j.item, imported: false, name: '偷偷改的' } }));
    const c = fakeEnv('c');
    await sync(store, c, ['x']);
    assert.equal(c.lib.has('x'), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('另一个桥接进程（另一个端口）改了共享区：这边重新读，不拿旧的覆盖', async () => {
  const dir = tmp();
  try {
    const one = createShared(dir);
    const two = createShared(dir);
    const a = fakeEnv('a', [item('x', tick()), item('y', tick())]);
    await share(one, a, 'x');
    await share(two, a, 'y');
    assert.deepEqual(one.list().map((m) => m.id).sort(), ['x', 'y']);
    assert.deepEqual(createShared(dir).list().map((m) => m.id).sort(), ['x', 'y']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('正在录这条脚本时不覆盖、不删除，录完再同步', async () => {
  const dir = tmp();
  try {
    const store = createShared(dir);
    const a = fakeEnv('a', [item('x', tick())]);
    const b = fakeEnv('b');
    await share(store, a, 'x');
    await sync(store, b, ['x']);
    a.edit('x', { name: 'A 改的' });
    await sync(store, a);
    b.recording = 'x';
    await sync(store, b);
    assert.equal(b.lib.get('x').name, '脚本 x');
    b.recording = null;
    await sync(store, b);
    assert.equal(b.lib.get('x').name, 'A 改的');

    a.remove('x');
    await sync(store, a);
    b.recording = 'x';
    await sync(store, b);
    assert.ok(b.lib.has('x'));
    b.recording = null;
    await sync(store, b);
    assert.equal(b.lib.has('x'), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('导入的录制包共享出去还是导入的；共享区文件被改坏、对不上版本的不用', async () => {
  const dir = tmp();
  try {
    const store = createShared(dir);
    const a = fakeEnv('a', [item('x', tick(), { imported: true }), item('y', tick())]);
    await share(store, a, 'x');
    await share(store, a, 'y');
    const b = fakeEnv('b');
    await sync(store, b, ['x']);
    assert.equal(b.lib.get('x').imported, true);

    const file = join(dir, 'items', readdirSync(join(dir, 'items')).find((n) => n.startsWith('y.')));
    const j = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...j, item: { ...j.item, id: 'other' } }));
    await sync(store, b, ['y']);
    assert.equal(b.lib.has('y'), false);

    const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ ...state, ['__proto__']: state.x, 'bad id': state.x, z: { ...state.x, id: 'z', rev: 'not-a-rev' } }));
    const reopened = createShared(dir);
    assert.deepEqual(reopened.list().map((m) => m.id).sort(), ['x', 'y']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('大脚本分段传', async () => {
  const dir = tmp();
  try {
    const store = createShared(dir);
    const big = item('x', tick(), { description: 'z'.repeat(9 * 1024 * 1024) });
    const a = fakeEnv('a', [big]);
    await share(store, a, 'x');
    const b = fakeEnv('b');
    let calls = 0;
    const call = b.call;
    b.call = (m, p) => { if (m === 'sharedApply') calls++; return call(m, p); };
    await sync(store, b, ['x']);
    assert.equal(b.lib.get('x').description.length, big.description.length);
    assert.equal(calls, 3);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ======================= 扩展一侧（background.js） =======================

// chrome.storage.local 用内存里的 Map，其余 chrome 接口都是空的
function loadBackground(initial = {}) {
  const store = new Map(Object.entries(initial));
  const local = {
    get: async (keys) => {
      const list = keys == null ? [...store.keys()] : Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter((k) => store.has(k)).map((k) => [k, structuredClone(store.get(k))]));
    },
    set: async (o) => { for (const [k, v] of Object.entries(o)) store.set(k, structuredClone(v)); },
    remove: async (keys) => { for (const k of [].concat(keys)) store.delete(k); },
  };
  const stub = () => new Proxy(function () {}, {
    get(t, k) { if (k === 'then') return undefined; if (k === 'addListener') return () => {}; return stub(); },
    apply() { return Promise.resolve({}); },
  });
  const ctx = { console: { log() {}, warn() {}, error() {} }, URL, URLSearchParams, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, TextEncoder, TextDecoder, Headers, crypto: webcrypto, structuredClone };
  ctx.self = ctx;
  ctx.chrome = new Proxy(stub(), { get: (t, k) => (k === 'storage' ? { local, session: local } : stub()) });
  ctx.importScripts = (...files) => { for (const f of files) vm.runInContext(readFileSync(join(root, f), 'utf8'), ctx); };
  vm.createContext(ctx);
  vm.runInContext(readFileSync(join(root, 'background.js'), 'utf8'), ctx);
  return { bg: ctx, store };
}
const plain = (x) => JSON.parse(JSON.stringify(x));
// 按桥接的做法分段发
async function applyTo(bg, it, opts, size = 50) {
  const text = JSON.stringify(it);
  let last;
  for (let i = 0; i < text.length; i += size) last = await bg.bridgeHandle('sharedApply', { ...opts, id: it.id, chunk: text.slice(i, i + size), start: i === 0, done: i + size >= text.length });
  return plain(last);
}

test('background: 共享来的按这里录的对待，导入的还是导入的；刚改过、正在录的不覆盖；另存是一条新脚本', async () => {
  const { bg, store } = loadBackground();
  const c = await bg.load();
  let r = await applyTo(bg, item('x', 5, { imported: false }), { expectAt: 0 });
  assert.equal(r.ok, true);
  const saved = store.get('lib:x');
  assert.equal(saved.imported, false);
  assert.equal(saved.savedAt, r.savedAt);
  assert.deepEqual(plain(c.libIndex.map((x) => x.id)), ['x']);

  assert.deepEqual(await applyTo(bg, item('x', 6, { name: '新的' }), { expectAt: r.savedAt - 1 }), { ok: false, changed: true });
  r = await applyTo(bg, item('x', 6, { name: '新的', imported: true }), { expectAt: r.savedAt });
  assert.equal(store.get('lib:x').name, '新的');
  assert.equal(store.get('lib:x').imported, true);

  c.state = { ...store.get('lib:x').state, recording: true };
  assert.deepEqual(await applyTo(bg, item('x', 7), { expectAt: r.savedAt }), { ok: false, busy: true });
  assert.deepEqual(plain(await bg.bridgeHandle('sharedRemove', { id: 'x', expectAt: r.savedAt })), { ok: false, busy: true });

  // 正打开编辑的那条：编辑区也换成新内容
  c.state = { ...store.get('lib:x').state, recording: false };
  c.events = [];
  r = await applyTo(bg, item('x', 8, { name: '再改', events: [{ kind: 'step', ts: 2, type: 'navigate', url: 'https://app.test/b' }] }), { expectAt: r.savedAt });
  assert.equal(r.ok, true);
  assert.equal(c.events[0].url, 'https://app.test/b');

  const copy = await applyTo(bg, item('x', 9), { copyName: '脚本 x（别处的版本）', copyId: 'cx1' });
  assert.equal(copy.id, 'cx1');
  assert.equal(store.get('lib:cx1').name, '脚本 x（别处的版本）');
  assert.equal(store.get('lib:cx1').state.id, 'cx1');
  assert.equal(store.get('lib:x').name, '再改', '原来那条不动');
  assert.equal((await applyTo(bg, item('x', 10, { name: '又一份' }), { copyName: '别的名字', copyId: 'cx1' })).existed, true, '同一个副本不存两次');
  assert.equal(store.get('lib:cx1').name, '脚本 x（别处的版本）');
  await bg.handle({ type: 'libDelete', id: 'cx1' }, {});
  assert.equal((await applyTo(bg, item('x', 11), { copyName: '脚本 x（别处的版本）', copyId: 'cx1' })).existed, true, '用户删掉的副本不再存回来');
  assert.equal(store.has('lib:cx1'), false);
  await assert.rejects(applyTo(bg, item('x', 12), { copyName: '没给 id' }), /缺少 id/);

  await assert.rejects(applyTo(bg, item('y', 1, { state: { startUrl: 'javascript:alert(1)' } }), { expectAt: 0 }), /格式不对/);
  const up = [{ kind: 'step', ts: 1, type: 'upload', value: '/Users/me/a.png', recordedValue: '/Users/me/a.png' }];
  await applyTo(bg, item('lan1', 1, { events: up }), { expectAt: 0, fromLan: true });
  assert.equal(store.get('lib:lan1').events[0].value, '', '另一台电脑来的：本机文件路径清掉');
  await applyTo(bg, item('same1', 1, { events: up }), { expectAt: 0 });
  assert.equal(store.get('lib:same1').events[0].value, '', '同一台电脑上的环境共享也清掉（和恢复备份、导入一样）');
  assert.equal(store.get('lib:same1').savedAt, 1, '沿用共享版本的保存时间');
  assert.equal(store.get('lib:lan1').imported, true, '另一台电脑来的按导入的对待');
  assert.equal(store.get('lib:lan1').state.imported, true);
  await assert.rejects(applyTo(bg, item('lan2', 1, { state: { startUrl: 'file:///etc/hosts' } }), { expectAt: 0, fromLan: true }), /http\(s\)/);
  await applyTo(bg, item('extra1', 1, { sneaky: 'x', settings: { aiApiKey: 'K' } }), { expectAt: 0 });
  assert.equal(store.get('lib:extra1').sneaky, undefined, '只存脚本该有的字段');
  assert.deepEqual(plain(await bg.bridgeHandle('sharedRemove', { id: 'x', expectAt: 1 })), { ok: false, changed: true });
  assert.deepEqual(plain(await bg.bridgeHandle('sharedRemove', { id: 'x', expectAt: r.savedAt })), { ok: true });
  assert.equal(store.has('lib:x'), false);
  assert.ok(store.get('libDeleted').x, '记下删除，备份也会删掉');
  assert.deepEqual(plain(c.state), { recording: false }, '正打开着的被删了：编辑区清掉，不会再存回去');
  assert.equal(c.events.length, 0);
});

test('background: 导入的录制包打开改过再存还是导入的（旧索引没记的读原来那条）', async () => {
  const old = item('x', 5, { imported: true });
  const { bg, store } = loadBackground({ libIndex: [{ id: 'x', name: '脚本 x', savedAt: 5 }], 'lib:x': old });
  const c = await bg.load();
  c.state = { ...old.state, recording: false };
  c.events = old.events;
  await bg.syncLibrary(c);
  assert.equal(store.get('lib:x').imported, true);
  assert.equal(c.libIndex[0].imported, true);
  store.set('lib:x', { ...store.get('lib:x'), imported: 'stale' });
  await bg.syncLibrary(c);
  assert.equal(store.get('lib:x').imported, true, '索引里记了就用索引的');

  // 打开编辑时记在编辑区：脚本库里那条被删掉后再改，存回去也还是导入的
  await bg.handle({ type: 'libOpen', id: 'x' }, {});
  assert.equal(c.state.imported, true);
  await bg.handle({ type: 'libDelete', id: 'x' }, {});
  await bg.syncLibrary(c);
  assert.equal(store.get('lib:x').imported, true);
  const { pkg } = plain(await bg.handle({ type: 'exportPackage', id: 'x' }, {}));
  assert.equal(pkg.item.state.imported, undefined, '编辑区的标记不进录制包');
});

test('background: 清单带自动接收开关；共享状态整份替换，只带提示的追加提示', async () => {
  const { bg } = loadBackground({ settings: { autoReceiveShared: true } });
  assert.equal((await bg.bridgeHandle('libraryManifest', {})).autoReceiveShared, true);
  await bg.bridgeHandle('sharedState', { shared: [{ id: 'x', others: ['店铺B'] }], offers: [{ id: 'y', name: 'Y', from: '店铺B', savedAt: 1 }], notices: ['一'] });
  await bg.bridgeHandle('sharedState', { notices: ['二'] });
  const d = plain(await bg.handle({ type: 'getData' }, {}));
  assert.deepEqual(d.sharedInfo, { ready: true, shared: [{ id: 'x', others: ['店铺B'] }], offers: [{ id: 'y', name: 'Y', from: '店铺B', savedAt: 1 }], notices: ['一', '二'] });
  await bg.handle({ type: 'sharedDismiss' }, {});
  assert.deepEqual(plain(await bg.handle({ type: 'getData' }, {})).sharedInfo.notices, []);
  await assert.rejects(bg.handle({ type: 'libShare', id: 'x', on: true }, {}), /桥接没有连接/);
});

// ======================= 真的桥接 + 两个假扩展 =======================

function frame(text) { // 客户端帧必须带掩码
  const payload = Buffer.from(text);
  const mask = crypto.randomBytes(4);
  let head;
  if (payload.length < 126) head = Buffer.from([0x81, 0x80 | payload.length]);
  else if (payload.length < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 0x80 | 126; head.writeUInt16BE(payload.length, 2); } else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(payload.length), 2); }
  return Buffer.concat([head, mask, Buffer.from(payload.map((b, i) => b ^ mask[i % 4]))]);
}
// 用 fakeEnv 应答同步方法，list / run 按脚本库应答
function connectEnv(port, e) {
  const s = net.connect(port, '127.0.0.1');
  let buf = Buffer.alloc(0);
  let up = false;
  e.runs = [];
  e.waits = new Map();
  e.send = (obj) => s.write(frame(JSON.stringify(obj)));
  // 和扩展的 bridgeRequest 一样：事件带 req，等桥接调 bridgeReply
  e.request = (event, params) => new Promise((resolve, reject) => {
    const req = crypto.randomBytes(6).toString('hex');
    e.waits.set(req, { resolve, reject });
    e.send({ ...params, type: 'event', event, req });
  });
  e.close = () => s.destroy();
  s.write(`GET /ext HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nOrigin: chrome-extension://abcdef\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  const answer = async (m) => {
    if (m.method === 'list') return [...e.lib.values()].map((x) => ({ id: x.id, name: x.name, savedAt: x.savedAt, params: {}, steps: [], tools: (x.apis || ['q']).map((n) => ({ name: n, api: 'GET /' + n, description: '查询', inputSchema: { type: 'object', properties: {} } })) }));
    if (m.method === 'run' || m.method === 'call') { e.runs.push(m.params.recording); return { ok: true, env: e.env.instanceId }; }
    if (m.method === 'libraryRestore') return { ok: true, skipped: true };
    if (m.method === 'libraryOffer') return { ok: true };
    if (m.method === 'lanState') { e.lan = m.params; return { ok: true }; }
    if (m.method === 'bridgeReply') {
      const w = e.waits.get(m.params.req);
      e.waits.delete(m.params.req);
      if (w) (m.params.ok ? w.resolve(m.params.data) : w.reject(new Error(m.params.error)));
      return { ok: true };
    }
    return e.call(m.method, m.params);
  };
  s.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    if (!up) {
      const i = buf.indexOf('\r\n\r\n');
      if (i < 0) return;
      buf = buf.slice(i + 4);
      up = true;
      e.send({ type: 'hello', version: 'test', instanceId: e.env.instanceId, profile: e.env.profile, capabilities: ['librarySync', 'sharedSync', 'lanSync'] });
    }
    for (;;) {
      if (buf.length < 2) return;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; } else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (buf.length < off + len) return;
      const m = JSON.parse(buf.slice(off, off + len).toString());
      buf = buf.slice(off + len);
      if (m.type !== 'request') continue;
      answer(m).then((data) => e.send({ type: 'response', id: m.id, ok: true, data }), (err) => e.send({ type: 'response', id: m.id, ok: false, error: err.message }));
    }
  });
  s.on('error', () => {});
}
async function until(fn, what, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail('等不到：' + what);
}

test('桥接：一个环境共享，另一个接收；之后改动自动同步；AI 工具只列一套、要指定浏览器', async () => {
  const dir = tmp();
  writeFileSync(join(dir, 'trusted-extensions.json'), JSON.stringify({ ids: ['abcdef'] }));
  const port = 20000 + Math.floor(Math.random() * 12000);
  const p = spawn(process.execPath, [join(root, 'bridge', 'server.js'), '--port', String(port)], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, PR_BRIDGE_DIR: dir, PR_AUTO_UPDATE: '0' } });
  const a = fakeEnv('envA', [item('x', tick())]);
  const b = fakeEnv('envB');
  const twin = fakeEnv('envC', [item('w', tick())], { profile: '环境envA' }); // 和 A 重名、没有这条脚本
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('启动超时')), 10000);
      p.stderr.on('data', (d) => { if (String(d).includes('已启动')) { clearTimeout(t); resolve(); } });
      p.on('exit', (code) => { clearTimeout(t); reject(new Error('进程退出 ' + code)); });
    });
    connectEnv(port, a);
    connectEnv(port, b);
    connectEnv(port, twin);
    await until(() => a.state && b.state && twin.state, '三个环境都同步过一次');
    a.send({ type: 'event', event: 'shareSet', id: 'x', on: true });
    await until(() => b.state.offers.some((x) => x.id === 'x'), 'B 收到可接收的共享脚本');
    b.send({ type: 'event', event: 'sharedReceive', ids: ['x'] });
    await until(() => b.lib.has('x'), 'B 接收');

    a.edit('x', { name: 'A 改的' });
    a.send({ type: 'event', event: 'libraryChanged' });
    await until(() => b.lib.get('x').name === 'A 改的', 'B 跟着更新');

    let id = 0;
    const rpc = (method, params) => new Promise((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
        let d = '';
        res.on('data', (c) => { d += c; });
        res.on('end', () => { try { resolve(JSON.parse(d).result); } catch (err) { reject(new Error(d)); } });
      });
      r.on('error', reject);
      r.end(JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }));
    });
    let tools = [];
    const xTools = (all) => all.filter((t) => t.name.includes('__') && /「(A 改的|B 另改)」/.test(t.description));
    await until(async () => { tools = xTools((await rpc('tools/list', {})).tools); return tools.length === 2; }, '共享脚本只列一套工具');
    const run = tools.find((t) => t.name.endsWith('__run'));
    assert.deepEqual(run.inputSchema.properties.browser.enum.sort(), ['envA', '环境envB'], '资料名和别的浏览器重名的用 instanceId');
    assert.ok(run.inputSchema.required.includes('browser'));
    const missing = await rpc('tools/call', { name: run.name, arguments: {} });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /在 2 个浏览器里都有/);
    const other = await rpc('tools/call', { name: run.name, arguments: { browser: '环境envA' } });
    assert.match(other.content[0].text, /只能是这几个/, '没有这条脚本的浏览器不发过去');
    const ok = await rpc('tools/call', { name: run.name, arguments: { browser: '环境envB' } });
    assert.match(ok.content[0].text, /envB/);
    assert.deepEqual(b.runs, ['x']);
    assert.deepEqual(a.runs, []);
    assert.deepEqual(twin.runs, []);

    // B 停止共享后各改各的：接口不一样了，各列各的工具
    b.send({ type: 'event', event: 'shareSet', id: 'x', on: false });
    await until(() => b.state.shared.length === 0, 'B 停止共享');
    b.edit('x', { name: 'B 另改', apis: ['q', 'extra'] });
    b.send({ type: 'event', event: 'libraryChanged' });
    await until(async () => { tools = xTools((await rpc('tools/list', {})).tools); return tools.length === 5; }, '各列各的（A 的运行 + 1 个接口，B 的运行 + 2 个接口）');
    assert.ok(tools.every((t) => !t.inputSchema.properties.browser), '不用再选浏览器');
    b.send({ type: 'event', event: 'shareSet', id: 'x', on: true });
    await until(() => b.state.shared.length === 1, 'B 重新共享');

    const status = await new Promise((resolve) => http.get({ host: '127.0.0.1', port, path: '/api/status' }, (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve(JSON.parse(d))); }));
    assert.equal(status.sharedScripts, 1);

    await until(() => a.lib.get('x').name === 'B 另改', '重新共享：B 的较新，A 换成 B 的版本');
    b.remove('x');
    b.send({ type: 'event', event: 'libraryChanged' });
    await until(() => !a.lib.has('x'), 'B 删了 A 也删');
  } finally {
    a.close?.();
    b.close?.();
    twin.close?.();
    p.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

async function startBridge(env = {}) {
  const dir = tmp();
  writeFileSync(join(dir, 'trusted-extensions.json'), JSON.stringify({ ids: ['abcdef'] }));
  const port = 20000 + Math.floor(Math.random() * 12000);
  const p = spawn(process.execPath, [join(root, 'bridge', 'server.js'), '--port', String(port)], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, PR_BRIDGE_DIR: dir, PR_AUTO_UPDATE: '0', ...env } });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('启动超时')), 10000);
    p.stderr.on('data', (d) => { if (String(d).includes('已启动')) { clearTimeout(t); resolve(); } });
    p.on('exit', (code) => { clearTimeout(t); reject(new Error('进程退出 ' + code)); });
  });
  return { port, stop: () => { p.kill(); rmSync(dir, { recursive: true, force: true }); } };
}

test('局域网：一台开开关显示地址口令，另一台凭口令读共享脚本、复制一份；开开关的浏览器关了端口就关', async () => {
  const lanPort = 33000 + Math.floor(Math.random() * 20000);
  const host = await startBridge({ PR_LAN_PORT: String(lanPort), PR_LAN_GRACE_MS: '400' });
  const guest = await startBridge();
  const a = fakeEnv('macA', [item('x', tick(), { events: [{ kind: 'step', ts: 1, type: 'upload', value: '/Users/me/a.png', recordedValue: '/Users/me/a.png' }] }), item('private', tick())]);
  const w = fakeEnv('winW');
  try {
    connectEnv(host.port, a);
    connectEnv(guest.port, w);
    await until(() => a.state && w.state, '两边都连上');
    a.send({ type: 'event', event: 'shareSet', id: 'x', on: true });
    await until(() => a.state.shared.length === 1, 'A 共享了 x');

    const info = await a.request('lanSet', { on: true });
    assert.equal(info.on, true);
    assert.equal(info.port, lanPort);
    assert.match(info.code, /^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/);
    assert.equal(info.count, 1);
    await until(() => a.lan && a.lan.on, 'A 收到局域网状态');

    const addr = `127.0.0.1:${info.port}`;
    for (const event of ['constructor', '__proto__', 'toString']) a.send({ type: 'event', event, req: 'r' + event }); // 原型上的名字不当成事件
    assert.equal((await a.request('lanSet', { on: true, code: 'ZZZZ-ZZZZ-ZZZZ-ZZZZ' })).code, info.code, '已经开着：口令不变');
    await assert.rejects(w.request('lanList', { addr, code: 'AAAA-BBBB-CCCC-DDDD' }), /口令不对/);
    const list = await w.request('lanList', { addr, code: info.code.toLowerCase() });
    assert.deepEqual(list.scripts.map((x) => x.id), ['x'], '没共享的不给');
    const r = await w.request('lanReceive', { addr, code: info.code, ids: ['x', 'private'] });
    assert.deepEqual(r.received.map((x) => x.id), ['x']);
    assert.equal(r.failed[0].id, 'private');
    assert.equal(w.lib.get('x').name, '脚本 x');
    assert.equal(w.lib.get('x').imported, undefined, '假扩展不处理信任标记（扩展那边的测试管）');

    // 覆盖要核对用户确认时的版本：确认后这里又改过就不覆盖
    const seenAt = w.lib.get('x').savedAt;
    w.edit('x', { name: 'W 刚改' });
    const stale = await w.request('lanReceive', { addr, code: info.code, ids: ['x'], expect: { x: seenAt } });
    assert.match(stale.failed[0].error, /确认后变过/);
    assert.equal(w.lib.get('x').name, 'W 刚改');
    const ok = await w.request('lanReceive', { addr, code: info.code, ids: ['x'], expect: { x: w.lib.get('x').savedAt } });
    assert.deepEqual(ok.received.map((x) => x.id), ['x']);

    // 别的浏览器关掉过：错过通知的浏览器重连时带着旧编号来，不再打开
    assert.deepEqual(a.lan.owners, ['环境macA']);
    const other = fakeEnv('macB');
    connectEnv(host.port, other);
    await until(() => other.state, 'B 连上');
    assert.deepEqual(await other.request('lanSet', { on: false }), { on: false });
    assert.deepEqual(await a.request('lanSet', { on: true, resume: info.session, code: info.code }), { on: false });
    await assert.rejects(w.request('lanList', { addr, code: info.code }), /没有开|断开/);
    const reopened = await a.request('lanSet', { on: true });
    assert.equal(reopened.on, true);
    assert.notEqual(reopened.session, info.session);
    other.close();

    a.close();
    const addr2 = `127.0.0.1:${reopened.port}`;
    await until(async () => { try { await w.request('lanList', { addr: addr2, code: reopened.code }); return false; } catch (e) { return /没有开|断开/.test(e.message); } }, '开开关的浏览器断开后端口关掉');
  } finally {
    w.close?.();
    host.stop();
    guest.stop();
  }
});
