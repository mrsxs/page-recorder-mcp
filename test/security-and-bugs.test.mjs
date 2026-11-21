// 安全与核心 Bug 回归测试：覆盖 exporter.js、runtime.js、bridge/server.js 的关键修复
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import net from 'node:net';
import crypto from 'node:crypto';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const server = join(root, 'bridge', 'server.js');
const PR_EXPORTER = createRequire(import.meta.url)('../lib/exporter.js');
const runtimeSrc = readFileSync(join(root, 'lib', 'runtime.js'), 'utf8');

// ======================= lib/exporter.js =======================

test('exporter: bodyType 注入换行符无法破坏生成脚本语法或执行任意代码', () => {
  const events = [
    { kind: 'step', id: 's1', ts: 1, type: 'navigate', url: 'https://app.test/' },
    {
      kind: 'request', id: 'r1', ts: 10, endTs: 20, via: 'fetch',
      method: 'POST', url: 'https://app.test/api/submit', pageUrl: 'https://app.test/',
      requestHeaders: { 'content-type': 'application/json' },
      requestBody: { type: 'json\n;globalThis.__INJECTED__=true;//', value: { a: 1 } },
      status: 200, responseHeaders: { 'content-type': 'application/json' },
      responseBody: { type: 'json', value: { ok: true } },
    },
  ];
  const out = PR_EXPORTER.build(events, {}, { startUrl: 'https://app.test/' });
  assert.doesNotMatch(out.script, /\n;globalThis\.__INJECTED__/);
  // 校验整个生成脚本语法合法（不会因注释逃逸而产生语法错误或注入语句）
  new vm.Script(out.script);
});

test('exporter: form 请求体里的 # 不截断后续字段，且 constructor/toString 参数名不崩溃', () => {
  const events = [
    { kind: 'step', id: 's1', ts: 1, type: 'navigate', url: 'https://app.test/' },
    {
      kind: 'request', id: 'r1', ts: 10, endTs: 20, via: 'fetch',
      method: 'POST', url: 'https://app.test/api/form?constructor=1&toString=2', pageUrl: 'https://app.test/',
      requestHeaders: { 'content-type': 'application/x-www-form-urlencoded' },
      requestBody: { type: 'form', value: 'tag=a%23b&color=#ff0000&after=ok&constructor=val' },
      status: 200, responseHeaders: { 'content-type': 'application/json' },
      responseBody: { type: 'json', value: { constructor: { a: 1 }, toString: 'ok' } },
    },
    {
      kind: 'request', id: 'r2', ts: 30, endTs: 40, via: 'fetch',
      method: 'POST', url: 'https://app.test/api/form?constructor=3', pageUrl: 'https://app.test/',
      requestHeaders: { 'content-type': 'application/x-www-form-urlencoded' },
      requestBody: { type: 'form', value: 'color=#00ff00&after=ok2&constructor=val2' },
      status: 200, responseHeaders: { 'content-type': 'application/json' },
      responseBody: { type: 'json', value: { constructor: { b: 2 }, toString: 'ok2' } },
    },
  ];
  const a = PR_EXPORTER.analyze(events, {}, { startUrl: 'https://app.test/' });
  const api = a.apis[0];
  assert.equal(api.editParams.body.color, '#ff0000');
  assert.equal(api.editParams.body.after, 'ok');
  assert.equal(api.editParams.body.constructor, 'val');
  assert.equal(api.editParams.query.constructor, '1');
});

test('exporter: 敏感信息脱敏覆盖 user:pass@、空值前置重复 query、#hash 和嵌套 JSON 表单字段', () => {
  const req = {
    kind: 'request', id: 'r1', ts: 10, method: 'POST',
    url: 'https://alice:SuperPass99@api.test/v1/auth?token=&token=REAL_SECRET_TOKEN#access_token=HASH_SECRET&page=1',
    requestHeaders: { authorization: 'Bearer abc', 'content-type': 'application/x-www-form-urlencoded' },
    requestBody: { type: 'form', value: 'payload=' + encodeURIComponent(JSON.stringify({ api_key: 'NESTED_KEY_123', normal: 'ok' })) },
  };
  const scrubbed = PR_EXPORTER.scrubRequest(req, [], true, true);
  assert.ok(!scrubbed.url.includes('SuperPass99'), scrubbed.url);
  assert.ok(!scrubbed.url.includes('REAL_SECRET_TOKEN'), scrubbed.url);
  assert.ok(!scrubbed.url.includes('HASH_SECRET'), scrubbed.url);
  assert.ok(scrubbed.url.includes('page=1'), scrubbed.url);
  assert.equal(scrubbed.requestHeaders.authorization, '***');
  assert.ok(!scrubbed.requestBody.value.includes('NESTED_KEY_123'), scrubbed.requestBody.value);
  assert.ok(scrubbed.requestBody.value.includes('normal'), scrubbed.requestBody.value);
});

test('exporter: 畸形模板字符串不会触发 ReDoS（线性时间完成）', () => {
  const evil = '{{' + 'a'.repeat(50000);
  const t0 = Date.now();
  const out = PR_EXPORTER.build(
    [
      { kind: 'step', id: 's1', ts: 1, type: 'navigate', url: 'https://app.test/' },
      { kind: 'step', id: 's2', ts: 2, type: 'fill', target: { selectors: ['#q'], tag: 'input', kind: '输入框', label: 'q', desc: '输入框 "q"', ctx: {} }, value: evil },
    ],
    {},
    { startUrl: 'https://app.test/' },
  );
  assert.ok(Date.now() - t0 < 2000);
  assert.ok(out.script.length > 0);
});

// ======================= lib/runtime.js =======================

function createRuntimeEnv(opts = {}) {
  const fetchCalls = [];
  let curHref = opts.href || 'https://app.test/page';
  const loc = {
    get href() { return curHref; },
    set href(v) { curHref = new URL(String(v), curHref).href; },
    get origin() { return new URL(curHref).origin; },
    get protocol() { return new URL(curHref).protocol; },
    get pathname() { return new URL(curHref).pathname; },
    get search() { return new URL(curHref).search; },
    get hash() { return new URL(curHref).hash; },
    assign(u) { this.href = u; },
  };
  const win = {
    __PR_TOKEN__: opts.token || 'tok-secret-123',
    location: loc,
    innerWidth: 1280,
    innerHeight: 800,
    scrollX: 0,
    scrollY: 0,
    addEventListener() {},
    removeEventListener() {},
    postMessage() {},
    fetch: async (url, init) => {
      fetchCalls.push({ url: String(url), init });
      return {
        status: 200,
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => JSON.stringify(opts.fetchResponse || { ok: true }),
      };
    },
    XMLHttpRequest: class FakeXHR {},
  };
  win.window = win;
  win.self = win;
  win.top = win;
  win.document = {
    readyState: 'complete',
    body: { tagName: 'BODY' },
    documentElement: { tagName: 'HTML' },
    querySelectorAll: () => [],
    querySelector: () => null,
    createElement: () => ({ style: {}, remove() {} }),
  };
  win.URL = URL;
  win.URLSearchParams = URLSearchParams;
  win.Headers = Headers;
  win.FormData = FormData;
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  win.console = { log() {}, warn() {}, error() {} };
  const ctx = vm.createContext(win);
  vm.runInContext(runtimeSrc, ctx);
  return { win, ctx, fetchCalls };
}

test('runtime: 启动后立刻清除 window.__PR_TOKEN__，且阻断 __proto__/constructor 原型污染', async () => {
  const { win, fetchCalls } = createRuntimeEnv({ token: 'secret-token-xyz' });
  const rec = {
    startUrl: 'https://app.test/page',
    steps: [],
    apis: [{
      name: 'POST /api/save',
      fn: 'save',
      method: 'POST',
      url: 'https://app.test/api/save',
      pathTemplate: '/api/save',
      bodyType: 'json',
      requestBody: { safe: '1', nested: JSON.stringify({ x: 1 }) },
      requestHeaders: { 'content-type': 'application/json' },
    }],
  };
  const apiParams = {
    'POST /api/save': {
      body: {
        '__proto__.polluted': 'yes',
        'constructor.prototype.polluted2': 'yes',
        'nested.__proto__.polluted3': 'yes',
        safe: '{{v}}',
      },
    },
  };
  await win.__pageRecorderRuntime(rec, { v: 'ok' }, apiParams, { autoRun: false, verbose: false, rewriteRequests: false, netLog: false });
  assert.equal(win.__PR_TOKEN__, undefined, '启动后应删除 window.__PR_TOKEN__');

  const res = await win.__PR__.api.call('save', {});
  assert.equal(res.ok, true);
  assert.equal(({}).polluted, undefined);
  assert.equal(({}).polluted2, undefined);
  assert.equal(({}).polluted3, undefined);
  assert.equal(fetchCalls.length, 1);
  assert.equal(JSON.parse(fetchCalls[0].init.body).safe, 'ok');
});

test('runtime: date 过滤器不破坏 GMT/PM/Date: 文本，且模板不会二次展开参数值中的 {{...}}', async () => {
  const { win, fetchCalls } = createRuntimeEnv();
  const rec = {
    startUrl: 'https://app.test/page',
    steps: [],
    apis: [{
      name: 'POST /api/search',
      fn: 'search',
      method: 'POST',
      url: 'https://app.test/api/search',
      pathTemplate: '/api/search',
      bodyType: 'json',
      requestBody: { dateText: '', compactDate: '', keyword: '', secret: '' },
      requestHeaders: { 'content-type': 'application/json' },
    }],
  };
  const apiParams = {
    'POST /api/search': {
      body: {
        dateText: '{{d|date:Date: YYYY-MM-DD HH:mm:ss GMT}}',
        compactDate: '{{d|date:YYYYMMDD}}',
        keyword: '{{kw}}',
        secret: '{{sec}}',
      },
    },
  };
  await win.__pageRecorderRuntime(
    rec,
    { d: '2026-05-09 14:30:05', kw: '{{sec}}', sec: 'TOP_SECRET' },
    apiParams,
    { autoRun: false, verbose: false, rewriteRequests: false, netLog: false },
  );
  await win.__PR__.api.call('search', {});
  const body = JSON.parse(fetchCalls[0].init.body);
  assert.equal(body.dateText, 'Date: 2026-05-09 14:30:05 GMT');
  assert.equal(body.compactDate, '20260509');
  assert.equal(body.keyword, '{{sec}}', '不应二次展开用户参数里的 {{sec}}');
  assert.equal(body.secret, 'TOP_SECRET');
});

test('runtime: call() 保留空对象 {}、支持顶层数组 _raw、重传已删字段、正确序列化 form 数组与对象', async () => {
  const { win, fetchCalls } = createRuntimeEnv();
  const rec = {
    startUrl: 'https://app.test/page',
    steps: [],
    apis: [
      {
        name: 'POST /api/json', fn: 'jsonApi', method: 'POST', url: 'https://app.test/api/json',
        pathTemplate: '/api/json',
        bodyType: 'json',
        requestBody: { filter: { a: 1 }, keep: 1, opt: 'old' },
        params: { body: { 'filter.a': 1, keep: 1, opt: 'old' } },
        requestHeaders: { 'content-type': 'application/json' },
      },
      {
        name: 'POST /api/arr', fn: 'arrApi', method: 'POST', url: 'https://app.test/api/arr',
        pathTemplate: '/api/arr',
        bodyType: 'json',
        requestBody: [1, 2],
        requestHeaders: { 'content-type': 'application/json' },
      },
      {
        name: 'POST /api/form', fn: 'formApi', method: 'POST', url: 'https://app.test/api/form',
        pathTemplate: '/api/form',
        bodyType: 'form',
        requestBody: 'a=1',
        requestHeaders: { 'content-type': 'application/x-www-form-urlencoded' },
      },
    ],
  };
  const apiParams = {
    'POST /api/json': { body: { keep: 1 } }, // opt 属于 removed（原录制有但 editParams 删掉了）
    'POST /api/arr': { body: { _raw: [1, 2] } },
    'POST /api/form': { body: { a: '1' } },
  };
  await win.__pageRecorderRuntime(rec, {}, apiParams, { autoRun: false, verbose: false, rewriteRequests: false, netLog: false });

  await win.__PR__.api.call('jsonApi', { body: { filter: {}, opt: 're-added' } });
  const j1 = JSON.parse(fetchCalls[0].init.body);
  assert.deepEqual(j1.filter, {}, '空对象不应被 flattenInput 丢弃');
  assert.equal(j1.opt, 're-added', '显式传入的已删字段不应被 removed 删掉');

  await win.__PR__.api.call('arrApi', { body: [9, 8, 7] });
  assert.deepEqual(JSON.parse(fetchCalls[1].init.body), [9, 8, 7]);

  await win.__PR__.api.call('formApi', { body: { ids: ['10', '20'], meta: { k: 'v' }, empty: null } });
  const formStr = fetchCalls[2].init.body;
  const sp = new URLSearchParams(formStr);
  assert.deepEqual(sp.getAll('ids'), ['10', '20']);
  assert.equal(sp.get('meta'), '{"k":"v"}');
  assert.equal(sp.has('empty'), false);
});

test('runtime: navigate 拒绝 javascript: 协议，同页 #hash 跳转立即完成不卡 20 秒', async () => {
  const { win } = createRuntimeEnv({ href: 'https://app.test/spa#/home' });
  const badRec = {
    startUrl: 'https://app.test/spa#/home',
    steps: [{ type: 'navigate', url: 'javascript:alert(1)', desc: '跳转' }],
    apis: [],
  };
  await win.__pageRecorderRuntime(badRec, {}, {}, { autoRun: false, verbose: false, rewriteRequests: false, netLog: false, stepDelay: 1 });
  const tBad = Date.now();
  const rBad = await win.__PR__.replay({ from: 0 });
  assert.equal(rBad.ok, false);
  assert.match(rBad.error, /拒绝跳转到不安全的地址协议/);
  assert.ok(Date.now() - tBad < 1000, '非法协议应立即拒绝，不等待 5 秒');

  const hashRec = {
    startUrl: 'https://app.test/spa#/home',
    steps: [{ type: 'navigate', url: 'https://app.test/spa#/orders', desc: '切 hash' }],
    apis: [],
  };
  await win.__pageRecorderRuntime(hashRec, {}, {}, { autoRun: false, verbose: false, rewriteRequests: false, netLog: false, stepDelay: 1 });
  const t0 = Date.now();
  const rHash = await win.__PR__.replay({ from: 0 });
  assert.equal(rHash.ok, true);
  assert.equal(win.location.hash, '#/orders');
  assert.ok(Date.now() - t0 < 2000, 'SPA hash 导航不应等待 20 秒');
});

test('runtime: 合成模式下空文本 confirm("") 不会误匹配跨步骤录制的非空弹窗', async () => {
  const { win } = createRuntimeEnv({ href: 'https://app.test/' });
  win.confirm = () => { throw new Error('original confirm should be intercepted'); };
  const rec = {
    startUrl: 'https://app.test/',
    steps: [
      {
        type: 'click',
        desc: '第一步',
        target: { selectors: ['#btn1'], tag: 'button' },
        dialogs: [{ kind: 'confirm', message: '确认删除全部数据？', result: true }],
      },
      {
        type: 'click',
        desc: '第二步',
        target: { selectors: ['#btn2'], tag: 'button' },
      },
    ],
    apis: [],
  };
  let confirmResult = null;
  const makeBtn = (onClick) => ({
    nodeType: 1,
    tagName: 'BUTTON',
    isConnected: true,
    getBoundingClientRect: () => ({ left: 10, top: 10, width: 40, height: 20, right: 50, bottom: 30 }),
    getClientRects: () => [{ width: 40, height: 20 }],
    scrollIntoView() {},
    focus() {},
    dispatchEvent() { return true; },
    click: onClick,
    matches: () => false,
    getAttribute: () => null,
  });
  const btn1 = makeBtn(() => {}); // 录制时有 confirm，回放时延迟到后面或未弹
  const btn2 = makeBtn(() => { confirmResult = win.confirm(''); });
  win.document.querySelectorAll = (sel) => (sel === '#btn1' ? [btn1] : sel === '#btn2' ? [btn2] : []);
  win.getComputedStyle = () => ({ display: 'block', visibility: 'visible', opacity: '1' });
  win.MouseEvent = class { constructor(t) { this.type = t; } };
  win.PointerEvent = class { constructor(t) { this.type = t; } };
  await win.__pageRecorderRuntime(rec, {}, {}, { autoRun: false, verbose: false, rewriteRequests: false, netLog: false, stepDelay: 1, realInput: false });
  await win.__PR__.replay({ from: 0 });
  assert.equal(confirmResult, false, '空消息 confirm("") 不应误匹配已录制的非空弹窗并自动点确定');
});

// ======================= bridge/server.js =======================

function wsFrame(text, masked = true) {
  const payload = Buffer.from(text);
  const maskBit = masked ? 0x80 : 0;
  let head;
  if (payload.length < 126) head = Buffer.from([0x81, maskBit | payload.length]);
  else if (payload.length < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = maskBit | 126; head.writeUInt16BE(payload.length, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = maskBit | 127; head.writeBigUInt64BE(BigInt(payload.length), 2); }
  if (!masked) return Buffer.concat([head, payload]);
  const mask = crypto.randomBytes(4);
  return Buffer.concat([head, mask, Buffer.from(payload.map((b, i) => b ^ mask[i % 4]))]);
}

async function startBridge(extraArgs = []) {
  const stateDir = mkdtempSync(join(tmpdir(), 'pr-sec-'));
  const port = 22000 + Math.floor(Math.random() * 18000);
  const p = spawn(process.execPath, [server, '--port', String(port), ...extraArgs], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, PR_BRIDGE_DIR: stateDir },
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('启动超时')), 10000);
    let err = '';
    p.stderr.on('data', (d) => {
      err += String(d);
      if (err.includes('已启动')) { clearTimeout(t); resolve(); }
    });
    p.on('exit', (code) => { clearTimeout(t); reject(new Error(`退出 ${code}: ${err}`)); });
  });
  return {
    port,
    proc: p,
    stop() {
      p.kill();
      rmSync(stateDir, { recursive: true, force: true });
    },
  };
}

function connectFakeExt(port, { origin = 'chrome-extension://extaaa', instanceId = 'inst-1', profile = 'P1', onReq } = {}) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1');
    let buf = Buffer.alloc(0);
    let up = false;
    let closed = false;
    s.on('close', () => { closed = true; });
    s.on('error', () => { closed = true; });
    s.write(`GET /ext HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nOrigin: ${origin}\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!up) {
        const i = buf.indexOf('\r\n\r\n');
        if (i < 0) return;
        const head = buf.slice(0, i).toString();
        buf = buf.slice(i + 4);
        if (!head.startsWith('HTTP/1.1 101')) return reject(new Error(head.split('\r\n')[0]));
        up = true;
        s.write(wsFrame(JSON.stringify({ type: 'hello', version: '1.4.0', instanceId, profile })));
        resolve({ socket: s, isClosed: () => closed });
      }
      while (buf.length >= 2) {
        let len = buf[1] & 0x7f, off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + len) return;
        const op = buf[0] & 0x0f;
        const body = buf.slice(off, off + len).toString('utf8');
        buf = buf.slice(off + len);
        if (op === 8) { s.end(); return; }
        if (op !== 1) continue;
        const m = JSON.parse(body);
        if (m.type === 'request' && onReq) {
          Promise.resolve(onReq(m.method, m.params)).then(
            (data) => s.write(wsFrame(JSON.stringify({ type: 'response', id: m.id, ok: true, data }))),
            (e) => s.write(wsFrame(JSON.stringify({ type: 'response', id: m.id, ok: false, error: e.message }))),
          );
        }
      }
    });
  });
}

test('bridge: 畸形 URL 不崩溃、XSSI/CSRF 拦截、空参数校验、UTF-8 分片解码、跨扩展劫持防护、原型链拦截', async () => {
  const b = await startBridge();
  let extA;
  try {
    // 1. 畸形 URL (//[::1) 不崩溃
    const rawResp = await new Promise((resolve) => {
      const sock = net.connect(b.port, '127.0.0.1', () => {
        sock.write(`GET //[::1 HTTP/1.1\r\nHost: 127.0.0.1:${b.port}\r\nConnection: close\r\n\r\n`);
      });
      let out = '';
      sock.on('data', (c) => { out += c.toString(); });
      sock.on('end', () => resolve(out));
    });
    assert.match(rawResp, /^HTTP\/1\.1 400/);

    // 2. Simple-POST CSRF (Content-Type: text/plain) 返回 415
    const csrfRes = await fetch(`http://127.0.0.1:${b.port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    assert.equal(csrfRes.status, 415);

    // 3. 空白 recording 参数 (/%20) 返回 400
    const emptyRecRes = await fetch(`http://127.0.0.1:${b.port}/api/recordings/%20`);
    assert.equal(emptyRecRes.status, 400);

    // 4. 连接扩展 A
    extA = await connectFakeExt(b.port, {
      origin: 'chrome-extension://extaaa',
      instanceId: 'shared-inst',
      profile: 'RealExt',
      onReq: (method, params) => {
        if (method === 'list') return [{ id: 'r1', name: '中文录制', params: {}, steps: [], tools: [] }];
        if (method === 'script') return { name: '中文录制', script: 'console.log("ok");' };
        if (method === 'call') return { ok: true, data: { real: '值', echoed: params.args } };
        return {};
      },
    });
    await new Promise((r) => setTimeout(r, 80));

    // 5. 跨扩展 B 尝试用同一 instanceId 劫持 A -> 被拒，A 保持存活
    const extB = await connectFakeExt(b.port, {
      origin: 'chrome-extension://extbbb',
      instanceId: 'shared-inst',
      profile: 'EvilExt',
      onReq: () => ({ hijacked: true }),
    });
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(extB.isClosed(), true, '冒名顶替的扩展连接应被关闭');
    assert.equal(extA.isClosed(), false, '原扩展连接不应被踢掉');
    const st = await (await fetch(`http://127.0.0.1:${b.port}/api/status`)).json();
    assert.equal(st.browsers.length, 1);
    assert.equal(st.browsers[0].profile, 'RealExt');

    // 6. XSSI 防护：Sec-Fetch-Dest: script 与 Sec-Fetch-Site: cross-site 被拒，正常请求带 CORP/nosniff
    const xssiRes = await fetch(`http://127.0.0.1:${b.port}/api/recordings/r1/script`, {
      headers: { 'sec-fetch-dest': 'script' },
    });
    assert.equal(xssiRes.status, 403);
    const crossSiteRes = await fetch(`http://127.0.0.1:${b.port}/api/recordings/r1/script`, {
      headers: { 'sec-fetch-site': 'cross-site' },
    });
    assert.equal(crossSiteRes.status, 403);
    const okScriptRes = await fetch(`http://127.0.0.1:${b.port}/api/recordings/r1/script`);
    assert.equal(okScriptRes.status, 200);
    assert.equal(okScriptRes.headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.equal(okScriptRes.headers.get('x-content-type-options'), 'nosniff');

    // 7. UTF-8 多字节字符在 TCP 分片边界拆分时不被破坏
    const payload = Buffer.from(JSON.stringify({
      jsonrpc: '2.0', id: 7, method: 'tools/call',
      params: { name: 'call_api', arguments: { recording: 'r1', api: 'x', args: { word: '你好世界测试中文' } } },
    }), 'utf8');
    const splitAt = payload.indexOf(Buffer.from('好', 'utf8')) + 1; // 故意在 3 字节 UTF-8 字符中间断开
    const chunkResp = await new Promise((resolve, reject) => {
      const sock = net.connect(b.port, '127.0.0.1', () => {
        sock.write(`POST /mcp HTTP/1.0\r\nHost: 127.0.0.1:${b.port}\r\nContent-Type: application/json\r\nContent-Length: ${payload.length}\r\nConnection: close\r\n\r\n`);
        sock.write(payload.slice(0, splitAt));
        setTimeout(() => sock.write(payload.slice(splitAt)), 30);
      });
      const chunks = [];
      sock.on('data', (c) => chunks.push(c));
      sock.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      sock.on('error', reject);
    });
    const jsonBody = JSON.parse(chunkResp.split('\r\n\r\n')[1]);
    assert.ok(jsonBody.result.content[0].text.includes('你好世界测试中文'), jsonBody.result.content[0].text);
    assert.ok(!jsonBody.result.content[0].text.includes('\ufffd'));

    // 8. 未掩码 WebSocket 客户端帧（违反 RFC 6455）被关闭且不崩溃服务
    await new Promise((resolve) => {
      const s = net.connect(b.port, '127.0.0.1', () => {
        s.write(`GET /ext HTTP/1.1\r\nHost: 127.0.0.1:${b.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nOrigin: chrome-extension://extccc\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
      });
      let sent = false;
      s.on('data', (d) => {
        if (!sent && d.toString().includes('101')) {
          sent = true;
          s.write(wsFrame(JSON.stringify({ type: 'ping' }), false));
        }
      });
      s.on('close', resolve);
      setTimeout(() => { s.destroy(); resolve(); }, 1000);
    });
    const stillAlive = await fetch(`http://127.0.0.1:${b.port}/api/status`);
    assert.equal(stillAlive.status, 200);
  } finally {
    if (extA) extA.socket.destroy();
    b.stop();
  }
});

test('bridge: read_result pathGet 不遍历 Object.prototype（toString / constructor 报找不到路径）', async () => {
  const b = await startBridge();
  let ext;
  try {
    const big = { ok: true, items: Array.from({ length: 120 }, (_, i) => ({ id: i, text: 'x'.repeat(200) })) };
    ext = await connectFakeExt(b.port, {
      origin: 'chrome-extension://extproto',
      instanceId: 'proto-inst',
      onReq: (method) => (method === 'list' ? [{ id: 'r1', name: 'R1', params: {}, steps: [], tools: [] }] : big),
    });
    await new Promise((r) => setTimeout(r, 80));
    const mcp = async (method, params) => (await (await fetch(`http://127.0.0.1:${b.port}/mcp`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })).json()).result;
    const callRes = await mcp('tools/call', { name: 'call_api', arguments: { recording: 'r1', api: 'x' } });
    const ridMatch = callRes.content[0].text.match(/result_id["']?\s*[:=]\s*["']?([a-z0-9_]+)/i);
    assert.ok(ridMatch, callRes.content[0].text);
    const readProto = await mcp('tools/call', { name: 'read_result', arguments: { result_id: ridMatch[1], path: 'toString' } });
    assert.equal(readProto.isError, true, JSON.stringify(readProto));
    assert.match(readProto.content[0].text, /不存在/);
  } finally {
    if (ext) ext.socket.destroy();
    b.stop();
  }
});

test('录制通道：两种注入顺序下都保留首个请求，直到后台确认抓包状态', async () => {
  const scripts = ['inject/hook.js', 'content/recorder.js'].map((p) => readFileSync(join(root, p), 'utf8'));
  for (const order of [[0, 1], [1, 0]]) {
    const messages = [];
    const listeners = new Set();
    const work = [];
    let completeHello;
    class Channel {
      constructor() {
        this.port1 = { postMessage: (data) => work.push(() => this.port2.onmessage?.({ data })) };
        this.port2 = { postMessage: (data) => work.push(() => this.port1.onmessage?.({ data })) };
      }
    }
    const env = {
      location: { href: 'https://app.test/' },
      document: { addEventListener() {}, title: '' },
      chrome: { runtime: { id: 'test', onMessage: { addListener() {} }, sendMessage(msg) {
        if (msg.type === 'hello') return new Promise((resolve) => { completeHello = resolve; });
        messages.push(msg);
        return Promise.resolve({});
      } } },
      URL, URLSearchParams, Headers, TextDecoder, MessageChannel: Channel,
      XMLHttpRequest: class {}, setTimeout() {}, clearTimeout() {}, setInterval() {},
      fetch: async () => new Response(null, { status: 204 }),
      addEventListener(type, fn) { if (type === 'message') listeners.add(fn); },
      removeEventListener(type, fn) { if (type === 'message') listeners.delete(fn); },
      postMessage(data, origin, ports = []) {
        work.push(() => {
          let stopped = false;
          for (const fn of [...listeners]) {
            fn({ source: window, data, ports, isTrusted: true, stopImmediatePropagation() { stopped = true; } });
            if (stopped) break;
          }
        });
      },
    };
    const ctx = vm.createContext(env);
    const window = vm.runInContext('globalThis', ctx);
    window.window = window.top = window.parent = window;
    for (const i of order) vm.runInContext(scripts[i], ctx);
    await vm.runInContext("fetch('https://app.test/api/early')", ctx);
    await new Promise(setImmediate);
    const flush = () => { while (work.length) work.shift()(); };
    flush();
    assert.equal(messages.length, 0);
    completeHello({ capture: true, settings: {} });
    await new Promise(setImmediate);
    flush();
    assert.deepEqual(messages.map((m) => m.event.url), ['https://app.test/api/early']);
  }
});

test('runtime: 显式传入的数组替换录制数组，调用参数中的模板文本按字面发送', async () => {
  const { win, fetchCalls } = createRuntimeEnv();
  const api = { name: 'batch', url: 'https://app.test/batch', method: 'POST', bodyType: 'json',
    requestBody: [{ id: 1 }], params: { body: { '[0].id': 1 } } };
  const runtime = await win.__pageRecorderRuntime({ steps: [], apis: [api] }, { label: 'template value' }, {}, { expose: false });
  await runtime.api.call('batch', { query: { q: '{{label}}' }, body: [{ id: 2 }, { id: 3 }] });
  assert.equal(new URL(fetchCalls[0].url).searchParams.get('q'), '{{label}}');
  assert.deepEqual(JSON.parse(fetchCalls[0].init.body), [{ id: 2 }, { id: 3 }]);
  assert.equal(win.__PR__, undefined);
});

test('runtime: 跨源接口直调用后台按目标接口记下的鉴权头补上脱敏的头；页面上读的隐藏字段只给同源接口', async () => {
  const api = (name, fn, url, extra = {}) => ({ name, fn, method: 'GET', url, pathTemplate: new URL(url).pathname, requestHeaders: { authorization: '***', 'x-sign': '***', accept: 'application/json' }, ...extra });
  const rec = {
    startUrl: 'https://app.test/page',
    steps: [],
    apis: [
      api('GET cross', 'cross', 'https://api.test/v1/me'),
      api('GET same', 'same', 'https://app.test/api/me'),
      api('GET crossField', 'crossField', 'https://api.test/v1/list?csrf_token=__PR_MASKED__', { masked: ['query.csrf_token'], params: { query: { csrf_token: '' } } }),
    ],
  };
  const cfg = { autoRun: false, verbose: false, rewriteRequests: false, netLog: false };
  const { win, fetchCalls } = createRuntimeEnv();
  win.document.querySelectorAll = () => [{ name: 'csrf_token', value: 'FROM-PAGE' }];
  await win.__pageRecorderRuntime(rec, {}, {}, cfg, { live: { headers: { authorization: 'Bearer LIVE' }, fields: {} } });

  for (const fn of ['cross', 'same']) {
    const r = await win.__PR__.api.call(fn, {});
    const sent = fetchCalls.pop().init.headers;
    assert.equal(sent.authorization, 'Bearer LIVE', fn);
    assert.equal('x-sign' in sent, false);
    assert.deepEqual([...r.liveHeaders], ['authorization']);
    assert.deepEqual([...r.omittedHeaders], ['x-sign'], '补不上的脱敏头要在结果里说明');
  }
  const r = await win.__PR__.api.call('crossField', {});
  assert.equal(r.notSent, true, '页面上的隐藏字段不能带去别的源');
  assert.equal(fetchCalls.length, 0);

  const live = createRuntimeEnv();
  await live.win.__pageRecorderRuntime(rec, {}, {}, cfg, { live: { headers: {}, fields: { csrf_token: 'FROM-API' } } });
  await live.win.__PR__.api.call('crossField', {});
  assert.equal(new URL(live.fetchCalls[0].url).searchParams.get('csrf_token'), 'FROM-API');
});

test('runtime: MAIN world 的那份替 ISOLATED world 的回放执行组件适配，只认约定的操作名，结束后不再响应', async () => {
  const { win } = createRuntimeEnv();
  const handlers = new Map();
  win.addEventListener = (type, fn) => handlers.set(type, fn);
  win.removeEventListener = (type) => handlers.delete(type);
  win.CustomEvent = CustomEvent;
  const calls = [];
  win.layui = { form: { render: (kind) => calls.push(kind) } };
  const name = 'pr:0123456789abcdef';
  const runtime = await win.__pageRecorderRuntime({ startUrl: 'https://app.test/page', steps: [], apis: [] }, {}, {}, {
    autoRun: false, expose: false, verbose: false, rewriteRequests: false, netLog: false, networkOnly: true, pageBridge: name,
  });
  const el = Object.assign(new EventTarget(), { nodeType: 1, parentElement: null, __vue__: {}, closest: () => null });
  const ask = (op, arg) => {
    let reply;
    el.addEventListener(name + ':r', (e) => { reply = JSON.parse(e.detail); }, { once: true });
    handlers.get(name)({ detail: JSON.stringify({ name: op, arg }), composedPath: () => [el] });
    return reply;
  };
  assert.equal(ask('frameworkOwned'), true);
  assert.equal(ask('layuiSelect', false), true);
  assert.equal(ask('layuiSelect', true), false, '不在 layui 表单里的下拉不刷新');
  assert.equal(ask('selectmenu', 1), false, '页面没有 jQuery');
  assert.equal(ask('constructor'), false);
  assert.equal(ask('toString'), false);
  assert.deepEqual(calls, ['select']);
  runtime.finish();
  assert.equal(handlers.has(name), false);
});

test('exporter: 嵌套凭据、跳转地址和文本响应在导出时脱敏', () => {
  const masked = PR_EXPORTER.exportRequest({
    url: 'https://app.test/api#token=fragment-secret?show=yes',
    pageUrl: 'https://app.test/page?access_key=page-secret',
    requestBody: { type: 'json', value: { password: ['body-secret'], normal: 'keep' } },
    responseBody: { type: 'text', value: '{"payload":"{\\"private_key\\":\\"response-secret\\"}","normal":"keep"}' },
  }, {});
  assert.doesNotMatch(JSON.stringify(masked), /fragment-secret|page-secret|body-secret|response-secret/);
  assert.equal(new URL(masked.url).hash.endsWith('?show=yes'), true);
  assert.equal(masked.requestBody.value.normal, 'keep');
  assert.equal(JSON.parse(masked.responseBody.value).normal, 'keep');
});

test('bridge: HTTP 扩展白名单、内部路由鉴权和批量上限同时生效', async () => {
  const bridge = await startBridge(['--extension-id', 'extaaa']);
  try {
    const base = `http://127.0.0.1:${bridge.port}`;
    const status = (origin) => fetch(base + '/api/status', { headers: { origin } });
    assert.equal((await status('chrome-extension://extaaa')).status, 200);
    assert.equal((await status('chrome-extension://extbbb')).status, 403);
    const post = (path, payload) => fetch(base + path, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    });
    assert.equal((await post('/api/ext', { method: 'list' })).status, 403);
    assert.equal((await post('/mcp', Array.from({ length: 21 }, () => ({ jsonrpc: '2.0', method: 'ping' })))).status, 400);
    const statusLine = await new Promise((resolve, reject) => {
      const sock = net.connect(bridge.port, '127.0.0.1', () => {
        sock.write(`POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${bridge.port}\r\nContent-Type: application/json\r\nContent-Length: 20000001\r\nConnection: close\r\n\r\n`);
      });
      sock.setTimeout(3000, () => sock.destroy(new Error('没有收到 HTTP 响应')));
      sock.once('error', reject);
      sock.once('data', (data) => { resolve(data.toString().split('\r\n')[0]); sock.destroy(); });
    });
    assert.match(statusLine, /^HTTP\/1\.1 413/);
  } finally {
    bridge.stop();
  }
});
