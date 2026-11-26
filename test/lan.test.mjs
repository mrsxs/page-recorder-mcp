// 局域网读取共享脚本：口令加密的协议、只读服务
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import http from 'node:http';

const require = createRequire(import.meta.url);
const { createLanServer, lanRequest, newCode, normCode, validCode, showCode, keyOf, seal, open, parseAddr } = require('../bridge/lan.js');
// 让系统给一个空闲端口：随机挑的可能落在 Windows 保留给系统的端口段里（监听报 EACCES）
const port = (host = '0.0.0.0') => new Promise((resolve, reject) => {
  const s = http.createServer().listen(0, host, () => { const { port: p } = s.address(); s.close(() => resolve(p)); });
  s.once('error', reject);
});
const store = (metas, items) => ({ list: () => metas, read: (id) => items[id] || null });

test('口令：16 位、能带横线小写空格，派生的密钥只有同一口令解得开，改过的内容解不开', () => {
  const code = newCode();
  assert.equal(code.length, 16);
  assert.ok(validCode(code));
  assert.equal(showCode(code), code.replace(/(.{4})(?=.)/g, '$1-'));
  assert.ok(validCode(' ' + showCode(code).toLowerCase() + ' '));
  assert.equal(normCode(showCode(code).toLowerCase()), code);
  assert.equal(validCode('ABCD-EFGH'), false);
  assert.equal(validCode('IIII-OOOO-0000-1111'), false, '容易看错的字不会出现在口令里');
  const box = seal(keyOf(code), { a: 1 });
  assert.deepEqual(open(keyOf(showCode(code)), box), { a: 1 });
  assert.equal(open(keyOf(newCode()), box), null);
  const raw = Buffer.from(box.data, 'base64');
  raw[0] ^= 1;
  assert.equal(open(keyOf(code), { ...box, data: raw.toString('base64') }), null);
  assert.equal(open(keyOf(code), { v: 2 }), null);
  assert.deepEqual(parseAddr('192.168.1.20:17400'), { host: '192.168.1.20', port: 17400 });
  assert.deepEqual(parseAddr(' mac.local '), { host: 'mac.local', port: 17322 });
  assert.throws(() => parseAddr('http://x/y'), /IP:端口/);
  assert.throws(() => parseAddr('1.2.3.4:70000'), /IP:端口/);
});

test('只读服务：凭口令拿共享脚本列表和内容，删了的不给；口令不对拿不到，错太多次先拒绝；网页来的不理', async () => {
  const items = { x: { id: 'x', name: 'X', events: [] } };
  const lan = createLanServer({ shared: store([{ id: 'x', name: 'X', savedAt: 5, from: { profile: '店铺A' } }, { id: 'gone', name: 'G', savedAt: 1, from: {}, deleted: { at: 2 } }], items) });
  const info = await lan.start({ port: await port() });
  try {
    assert.equal(info.on, true);
    assert.equal(info.count, 1);
    const addr = `127.0.0.1:${info.port}`;
    const list = await lanRequest(addr, info.code, 'list');
    assert.deepEqual(list.scripts, [{ id: 'x', name: 'X', savedAt: 5, from: '店铺A' }]);
    assert.ok(list.device);
    assert.deepEqual((await lanRequest(addr, info.code, 'get', { id: 'x' })).item, items.x);
    await assert.rejects(lanRequest(addr, info.code, 'get', { id: 'gone' }), /不共享了/);
    await assert.rejects(lanRequest(addr, info.code, 'get', { id: '../x' }), /不认识/);

    const again = await lan.start({ port: info.port, code: newCode() });
    assert.equal(again.port, info.port, '已经开着（别的浏览器开的）：沿用端口和口令，另一台电脑不用重填');
    assert.equal(again.code, info.code);

    const status = await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: info.port, path: '/pr-lan/v1', method: 'POST', headers: { origin: 'https://evil.test' } }, (res) => { res.resume(); resolve(res.statusCode); });
      req.end('{}');
    });
    assert.equal(status, 404);

    const wrong = newCode();
    for (let i = 0; i < 10; i++) await assert.rejects(lanRequest(addr, wrong, 'list'), /口令不对/);
    await assert.rejects(lanRequest(addr, wrong, 'list'), /错误次数太多/);
    await assert.rejects(lanRequest(addr, info.code, 'list'), /错误次数太多/, '同一个地址先拒绝一会儿');
  } finally { await lan.stop(); }
  assert.equal(lan.running, false);
  await assert.rejects(lanRequest(`127.0.0.1:${info.port}`, info.code, 'list'), /没有开局域网同步/);
});

test('端口被占了往后找', async () => {
  const p = await port();
  const busy = http.createServer().listen(p, '0.0.0.0');
  await new Promise((r) => busy.once('listening', r));
  const lan = createLanServer({ shared: store([], {}) });
  try {
    const info = await lan.start({ port: p });
    assert.ok(info.port > p && info.port < p + 10, '往后找到一个能用的');
  } finally { await lan.stop(); busy.close(); }
});

test('同时开两次只开一个端口，关掉后端口确实释放；请求和回应用不同的密钥', async () => {
  const p = await port();
  const lan = createLanServer({ shared: store([], {}) });
  const [one, two] = await Promise.all([lan.start({ port: p }), lan.start({ port: p })]);
  assert.equal(one.port, p);
  assert.equal(two.port, p, '第二次等第一次开完，沿用同一个');
  await lan.stop();
  const again = http.createServer().listen(p, '0.0.0.0');
  await new Promise((r, j) => { again.once('listening', r); again.once('error', j); });
  again.close();
  const code = newCode();
  assert.equal(open(keyOf(code, 'req'), seal(keyOf(code, 'res'), { a: 1 })), null);
});

test('只连局域网地址；重放的请求不处理；对方回得太大就断开，不等它发完', async () => {
  await assert.rejects(lanRequest('8.8.8.8:17322', newCode(), 'list'), /不是局域网地址/);
  await assert.rejects(lanRequest('example.com', newCode(), 'list'), /不是局域网地址|找不到/);

  const lan = createLanServer({ shared: store([], {}) });
  const info = await lan.start({ port: await port() });
  try {
    // 抓到的请求原样再发一次
    const code = info.code;
    const body = JSON.stringify(seal(keyOf(code, 'req'), { op: 'list', nonce: 'fixed-nonce-1' }));
    const post = () => new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: info.port, path: '/pr-lan/v1', method: 'POST', agent: false, headers: { 'content-type': 'application/json' } }, (res) => { res.resume(); resolve(res.statusCode); });
      req.end(body);
    });
    assert.equal(await post(), 200);
    assert.equal(await post(), 409);
  } finally { await lan.stop(); }

  // 冒充的「对方」：不管口令，回一个很大的东西
  const big = http.createServer((req, res) => { res.writeHead(200, { 'content-length': String(64 * 1024 * 1024) }); res.write('x'.repeat(1024)); });
  const p = await port();
  await new Promise((r) => big.listen(p, '127.0.0.1', r));
  try {
    await assert.rejects(lanRequest(`127.0.0.1:${p}`, newCode(), 'list'), /太大/);
  } finally { big.close(); big.closeAllConnections?.(); }
});

test('对方的错误文字：没核对口令的不显示（按状态码说），核对过的去掉控制字符', async () => {
  const code = newCode();
  let mode = 'status';
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (mode === 'status') { res.writeHead(403, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: '口令过期了，请把口令发到 evil@example.com 重新激活' })); }
      if (mode === 'teapot') { res.writeHead(418); return res.end('{}'); }
      const msg = open(keyOf(code, 'req'), JSON.parse(body));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(seal(keyOf(code, 'res'), { nonce: msg.nonce, ok: false, error: 'bad\u0007\nthing'.repeat(100) })));
    });
  });
  const p = await port();
  await new Promise((r) => srv.listen(p, '127.0.0.1', r));
  try {
    await assert.rejects(lanRequest(`127.0.0.1:${p}`, code, 'list'), (e) => e.message === '口令不对');
    mode = 'teapot';
    await assert.rejects(lanRequest(`127.0.0.1:${p}`, code, 'list'), /对方返回 418（可能不是 Page Recorder/);
    mode = 'sealed';
    await assert.rejects(lanRequest(`127.0.0.1:${p}`, code, 'list'), (e) => /^对方说：bad  thing/.test(e.message) && !/[\u0000-\u001f]/.test(e.message) && e.message.length <= 204);
  } finally { srv.close(); }
});

test('对方一点点慢慢发：整个请求有总时限，不会一直拖着', async () => {
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    const t = setInterval(() => res.write(' '), 100);
    res.on('close', () => clearInterval(t));
  });
  const p = await port();
  await new Promise((r) => srv.listen(p, '127.0.0.1', r));
  try {
    const started = Date.now();
    await assert.rejects(lanRequest(`127.0.0.1:${p}`, newCode(), 'list', {}, 1200), /太久没传完/);
    assert.ok(Date.now() - started < 5000);
  } finally { srv.close(); srv.closeAllConnections?.(); }
});

test('连得上但对方一直不回：提示连不上（查防火墙），不说成「传得太慢」；取消时马上停', async () => {
  const net = await import('node:net');
  const silent = net.createServer(() => {}); // 收下连接，什么也不回
  const p = await port('127.0.0.1');
  await new Promise((r) => silent.listen(p, '127.0.0.1', r));
  try {
    await assert.rejects(lanRequest(`127.0.0.1:${p}`, newCode(), 'list', {}, 1200), /连不上对方/);
    const ctrl = new AbortController();
    const pending = lanRequest(`127.0.0.1:${p}`, newCode(), 'list', {}, 10000, ctrl.signal);
    setTimeout(() => ctrl.abort(), 100);
    const started = Date.now();
    await assert.rejects(pending, /已取消/);
    assert.ok(Date.now() - started < 3000);
  } finally { silent.close(); }
});

test('填主机名时取消也马上停（不等解析）', async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  const started = Date.now();
  await assert.rejects(lanRequest('some-host.invalid:17322', newCode(), 'list', {}, 10000, ctrl.signal), /已取消/);
  assert.ok(Date.now() - started < 1000);
});
