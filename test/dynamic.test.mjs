// 会过期的东西：页面现算的反爬串、发放接口、地址里会过期的参数、只让页面自己发一个接口
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const E = createRequire(import.meta.url)('../lib/exporter.js');
const runtimeSrc = readFileSync(join(root, 'lib', 'runtime.js'), 'utf8');

const json = (value) => ({ type: 'json', value });
const req = (id, ts, method, url, extra = {}) => ({
  kind: 'request', id, ts, endTs: ts + 5, via: 'fetch', method, url, pageUrl: 'https://app.test/page',
  requestHeaders: { 'content-type': 'application/json' }, status: 200,
  responseHeaders: { 'content-type': 'application/json' }, responseBody: json({ success: true }), ...extra,
});
const nav = { kind: 'step', id: 's0', ts: 1, type: 'navigate', url: 'https://app.test/page' };
// 录制时后台做的事：按脱敏前的原值找发放接口，再入库脱敏
function ingest(events) {
  const recent = [];
  return events.map((ev) => {
    if (ev.kind !== 'request') return ev;
    const sources = E.findSources(ev, recent);
    const values = E.responseValues(ev.responseBody);
    if (values.size) recent.push({ id: ev.id, endTs: ev.endTs, values, method: ev.method, url: ev.url, pageUrl: ev.pageUrl, frameUrl: ev.frameUrl });
    return E.scrubRequest(Object.keys(sources).length ? { ...ev, sources } : ev, [], true, true);
  });
}
const token = (n) => Array.from({ length: n }, (_, i) => 'aB3xY9kQ'[(i * 7 + n) % 8]).join('') + n;

// ======================= lib/exporter.js =======================

test('exporter: 反爬串按名字入库就打码，接口记成 pageGenerated，模板里不留原值', () => {
  const crawler = '0as' + token(300);
  const events = ingest([nav,
    req('r1', 10, 'POST', 'https://app.test/mms/list', {
      requestHeaders: { 'content-type': 'application/json', 'anti-content': '0aq' + token(120) },
      requestBody: json({ pageNumber: 1, crawlerInfo: crawler, quantity: 'x' }),
    }),
  ]);
  const stored = JSON.stringify(events);
  assert.ok(!stored.includes(crawler), '请求体里的反爬串入库前打码');
  assert.ok(!stored.includes('0aq' + token(120)), '请求头里的反爬串入库前打码');
  const a = E.analyze(events, {}, { startUrl: 'https://app.test/page' }).apis[0];
  assert.deepEqual(a.pageGenerated.sort(), ['body.crawlerInfo', 'header.anti-content']);
  assert.equal(a.masked, undefined, '反爬串不走“用页面最新值补”的脱敏字段');
  assert.equal(a.editParams.body.quantity, 'x', '名字里碰巧有 anti 的普通字段不算');
  assert.equal(a.triggerStep, 1);
});

test('exporter: 名字看不出来、每次调用都不一样的长乱串也算页面现算；关联参数的、游标、追到来源的不算', () => {
  const steps = [nav, { kind: 'step', id: 's1', ts: 5, type: 'fill', value: 'shoes', target: { label: '搜索' } }];
  const call = (id, ts, i) => req(id, ts, 'POST', 'https://app.test/api/search', {
    requestBody: json({ kw: 'shoes', sig2: 'Zx' + token(80 + i), nextCursor: 'Cu' + token(90 + i), page: i }),
  });
  const a = E.analyze([...steps, call('r1', 10, 1), call('r2', 20, 2), call('r3', 30, 3)], {}, { startUrl: 'https://app.test/page' }).apis[0];
  assert.deepEqual(a.pageGenerated, ['body.sig2']);
  assert.equal(a.editParams.body.sig2, '', '现算的串在模板里清空');
  assert.match(a.editParams.body.kw, /\{\{/, '关联了输入参数的不动');
});

test('exporter: 发放接口——票据、地址里的参数、Bearer 令牌追到来源；同一接口的游标、写接口不算', () => {
  const ticket = 'TK-' + token(20);
  const frameToken = token(24);
  const jwt = 'eyJ' + token(40) + '.' + token(30) + '.' + token(20);
  const cursor = 'cur' + token(30);
  const events = ingest([nav,
    req('r1', 10, 'GET', 'https://app.test/api/ticket', { responseBody: json({ success: true, data: { ticket, menu: { url: `https://erp.test/frame?token=${frameToken}&m=1` } } }) }),
    req('r2', 20, 'POST', 'https://app.test/api/order/submit', { requestBody: json({ a: 1 }), responseBody: json({ success: true, accessToken: jwt }) }),
    req('r3', 30, 'GET', `https://app.test/api/list?ticket=${ticket}&token=${frameToken}`, {
      requestHeaders: { authorization: `Bearer ${jwt}` }, responseBody: json({ success: true, next: cursor }),
    }),
    req('r4', 40, 'GET', `https://app.test/api/list?ticket=${ticket}&token=${frameToken}&cursor=${cursor}`, { requestHeaders: { authorization: `Bearer ${jwt}` } }),
  ]);
  const A = E.analyze(events, {}, { startUrl: 'https://app.test/page' });
  const list = A.apis.find((x) => x.name === 'GET /api/list');
  const by = Object.fromEntries((list.sources || []).map((s) => [s.field, s]));
  assert.deepEqual(by['query.ticket'], { field: 'query.ticket', api: 'GET /api/ticket', path: 'data.ticket' });
  assert.deepEqual(by['query.token'], { field: 'query.token', api: 'GET /api/ticket', path: 'data.menu.url', urlParam: 'token' });
  assert.equal(by['header.authorization'], undefined, '提交类接口返回的令牌不会被顺带调用');
  assert.equal(by['query.cursor'], undefined, '同一接口上一页返回的游标不算发放');
  assert.ok(!JSON.stringify(events).includes(ticket), '入库的请求里票据照样打码');
});

test('exporter: 地址里会过期的参数——令牌、签名、时间戳、打码的去掉，路由参数留着', () => {
  const r = E.stripDynamic('https://a.test/p?mod=list&id=3&token=abc123def456&t=1795415909228&_=1700000000000&x=__PR_MASKED__#/x?sign=zz99aa88bb&k=1');
  assert.equal(r.url, 'https://a.test/p?mod=list&id=3#/x?k=1');
  assert.deepEqual(r.removed.sort(), ['_', 'sign', 't', 'token', 'x']);
  const keep = 'https://sso.test/#/list?externalSystem=spmp&fallbackMenu=%2Fspmp%2Flist';
  assert.equal(E.stripDynamic(keep).url, keep, '没有会过期的参数时地址原样不动（编码也不变）');
  assert.equal(E.dynamicParam('t', 'list'), false, '时间戳类参数名，值不像时间戳就不算');
  assert.equal(E.dynamicParam('sid', '12'), false, '名字像令牌、值很短的多半是业务参数');
  assert.equal(E.pageKey('https://a.test/p/?b=2&a=1&token=OLDTOKEN1#/r?y=2&t=1700000000'), E.pageKey('https://a.test/p?a=1&b=2&token=NEWTOKEN2#/r?y=2'), '同一页面：只是会过期的参数不同、参数顺序不同');
  assert.notEqual(E.pageKey('https://a.test/p?mod=list'), E.pageKey('https://a.test/p?mod=edit'), '其余参数不同就是不同页面');
});

test('exporter: iframe 里的接口记下嵌着它的主页面', () => {
  const events = [nav, { kind: 'step', id: 's1', ts: 5, type: 'navigate', url: 'https://app.test/main?menu=1' },
    req('r1', 10, 'GET', 'https://erp.test/api/stock', { frameUrl: 'https://erp.test/frame?token=abc', pageUrl: 'https://erp.test/frame?token=abc' })];
  const a = E.analyze(events, {}, { startUrl: 'https://app.test/page' }).apis[0];
  assert.equal(a.hostUrl, 'https://app.test/main?menu=1');
  const withTop = E.analyze([nav, req('r1', 10, 'GET', 'https://erp.test/api/stock', { frameUrl: 'https://erp.test/f', topUrl: 'https://app.test/shell' })], {}, { startUrl: 'https://app.test/page' }).apis[0];
  assert.equal(withTop.hostUrl, 'https://app.test/shell');
});

test('exporter: okCheck 和直接请求的业务码判断一致', () => {
  const a = { okSignals: { success: true, 'ret.0': { prefix: 'SUCCESS' } } };
  assert.equal(E.okCheck(a, { success: true, ret: ['SUCCESS::ok'] }), null);
  assert.equal(E.okCheck(a, { success: false, ret: ['SUCCESS::ok'], errorMsg: '风控' }).rejected, true);
  assert.match(E.okCheck(a, { success: false, ret: ['SUCCESS::ok'], errorMsg: '风控' }).error, /风控/);
  assert.equal(E.okCheck(a, '<html>').unknown, true);
});

// ======================= lib/runtime.js =======================

function runtimeEnv(href, routes) {
  const fetchCalls = [];
  let cur = href;
  const loc = {
    get href() { return cur; }, set href(v) { cur = new URL(String(v), cur).href; },
    get origin() { return new URL(cur).origin; }, get pathname() { return new URL(cur).pathname; },
    get search() { return new URL(cur).search; }, get hash() { return new URL(cur).hash; }, get protocol() { return new URL(cur).protocol; },
  };
  const win = {
    location: loc, innerWidth: 1280, innerHeight: 800, scrollX: 0, scrollY: 0,
    addEventListener() {}, removeEventListener() {}, postMessage() {},
    fetch: async (url, init) => {
      fetchCalls.push({ url: String(url), init });
      const body = (routes || {})[new URL(String(url)).pathname] || { success: true };
      return { status: 200, ok: true, redirected: false, url: String(url), headers: new Headers({ 'content-type': 'application/json' }), text: async () => JSON.stringify(body) };
    },
    XMLHttpRequest: class FakeXHR {},
  };
  win.window = win; win.self = win; win.top = win;
  win.document = { readyState: 'complete', body: { tagName: 'BODY' }, documentElement: { tagName: 'HTML' }, querySelectorAll: () => [], querySelector: () => null, createElement: () => ({ style: {}, remove() {} }) };
  Object.assign(win, { URL, URLSearchParams, Headers, FormData, setTimeout, clearTimeout, console: { log() {}, warn() {}, error() {} } });
  vm.runInContext(runtimeSrc, vm.createContext(win));
  return { win, fetchCalls };
}
const cfg = { autoRun: false, verbose: false, rewriteRequests: false, netLog: false, expose: false };

test('runtime: 带页面现算反爬串的接口不直接请求（不发旧值），调用方自己给了才发', async () => {
  const { win, fetchCalls } = runtimeEnv('https://app.test/page');
  const api = { name: 'POST /mms/list', fn: 'list', method: 'POST', url: 'https://app.test/mms/list', pathTemplate: '/mms/list', bodyType: 'json',
    requestBody: { pageNumber: 1, crawlerInfo: '' }, params: { body: { pageNumber: 1, crawlerInfo: '' } },
    requestHeaders: { 'anti-content': '***' }, pageGenerated: ['header.anti-content', 'body.crawlerInfo'], triggerStep: 3 };
  const rt = await win.__pageRecorderRuntime({ steps: [], apis: [api] }, {}, {}, cfg, { live: { headers: { 'anti-content': 'LIVE' }, fields: {} } });
  const r = await rt.api.call('list', { pageNumber: 2 });
  assert.equal(r.notSent, true);
  assert.equal(r.reason, 'page_generated_fields_required');
  assert.deepEqual([...r.pageGenerated], ['header.anti-content', 'body.crawlerInfo']);
  assert.equal(fetchCalls.length, 0, '不拿旧值或页面上采到的值发');
  const ok = await rt.api.call('list', { body: { pageNumber: 2, crawlerInfo: 'GIVEN' }, headers: { 'anti-content': 'GIVEN-H' } });
  assert.equal(ok.ok, true);
  assert.equal(JSON.parse(fetchCalls[0].init.body).crawlerInfo, 'GIVEN');
});

test('runtime: 先调发放接口拿新值再发；地址里的参数、Bearer 前缀照样填；来源没拿到值就不发', async () => {
  const routes = { '/api/ticket': { success: true, data: { ticket: 'NEW-TICKET', menu: { url: 'https://erp.test/f?token=NEWTOKEN&m=1' }, jwt: 'NEWJWT' } } };
  const { win, fetchCalls } = runtimeEnv('https://app.test/page', routes);
  const apis = [
    { name: 'GET /api/ticket', fn: 'ticket', method: 'GET', url: 'https://app.test/api/ticket', pathTemplate: '/api/ticket' },
    { name: 'GET /api/list', fn: 'list', method: 'GET', url: 'https://app.test/api/list?ticket=__PR_MASKED__&token=__PR_MASKED__&q=a', pathTemplate: '/api/list',
      params: { query: { ticket: '', token: '', q: 'a' } }, masked: ['query.ticket', 'query.token'], requestHeaders: { authorization: '***' },
      sources: [
        { field: 'query.ticket', api: 'GET /api/ticket', path: 'data.ticket' },
        { field: 'query.token', api: 'GET /api/ticket', path: 'data.menu.url', urlParam: 'token' },
        { field: 'header.authorization', api: 'GET /api/ticket', path: 'data.jwt', prefix: 'Bearer ' },
      ] },
    { name: 'GET /api/broken', fn: 'broken', method: 'GET', url: 'https://app.test/api/broken?ticket=OLD', pathTemplate: '/api/broken',
      params: { query: { ticket: 'OLD' } }, sources: [{ field: 'query.ticket', api: 'GET /api/ticket', path: 'data.missing' }] },
  ];
  const rt = await win.__pageRecorderRuntime({ steps: [], apis }, {}, {}, cfg, { live: { headers: {}, fields: {} } });
  const r = await rt.api.call('list', { q: 'b' });
  assert.equal(r.ok, true, r.error);
  assert.equal(fetchCalls.filter((c) => c.url.includes('/api/ticket')).length, 1, '同一个来源接口只调一次');
  const sent = new URL(fetchCalls[1].url);
  assert.equal(sent.searchParams.get('ticket'), 'NEW-TICKET');
  assert.equal(sent.searchParams.get('token'), 'NEWTOKEN');
  assert.equal(sent.searchParams.get('q'), 'b');
  assert.equal(fetchCalls[1].init.headers.authorization, 'Bearer NEWJWT');
  assert.deepEqual(JSON.parse(JSON.stringify(r.chained.map((x) => x.field))), ['query.ticket', 'query.token', 'header.authorization']);
  const given = await rt.api.call('list', { query: { ticket: 'MINE', token: 'T', q: 'c' } });
  assert.equal(given.chained.length, 1, '调用方给了的字段不再去拿');
  const before = fetchCalls.length;
  const bad = await rt.api.call('broken', {});
  assert.equal(bad.notSent, true, '来源没拿到新值：旧值多半过期了，不发');
  assert.match(bad.chainErrors[0], /没有值/);
  assert.ok(fetchCalls.slice(before).every((c) => c.url.includes('/api/ticket')), '只调了来源接口，目标接口没发');
});

test('runtime: 回放打开页面时不比会过期的参数，要跳转时去掉它们再打开', async () => {
  const step = (url) => ({ type: 'navigate', url, desc: '打开页面' });
  const same = runtimeEnv('https://app.test/page?id=1&token=NEWTOKEN2');
  const pr = await same.win.__pageRecorderRuntime({ steps: [step('https://app.test/page?id=1&token=OLDTOKEN1&t=1700000000000')], apis: [] }, {}, {}, { ...cfg, waitRequests: false, stepDelay: 0 });
  const r = await pr.replay({ from: 0 });
  assert.equal(r.ok, true, r.error);
  assert.equal(same.win.location.href, 'https://app.test/page?id=1&token=NEWTOKEN2', '已经在这个页面上（只是令牌是新的），不再跳回旧地址');
  const other = runtimeEnv('https://app.test/home');
  const pr2 = await other.win.__pageRecorderRuntime({ steps: [Object.assign(step('https://app.test/page?id=2&token=OLDTOKEN1'), { jump: true })], apis: [] }, {}, {}, { ...cfg, waitRequests: false, stepDelay: 0 });
  pr2.replay({ from: 0 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(other.win.location.href, 'https://app.test/page?id=2', '旧令牌去掉再打开，让站点重新发');
});

// ======================= background.js =======================

function loadBackground(tabs) {
  const stub = () => new Proxy(function () {}, {
    get(t, k) { if (k === 'then') return undefined; if (k === 'addListener') return () => {}; return stub(); },
    apply() { return Promise.resolve({}); },
  });
  const ctx = { console: { log() {}, warn() {}, error() {} }, URL, URLSearchParams, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, TextEncoder, TextDecoder, Headers };
  ctx.self = ctx;
  ctx.chrome = stub();
  ctx.chrome = new Proxy(ctx.chrome, { get: (t, k) => (k === 'tabs' ? new Proxy(stub(), { get: (x, m) => (m === 'query' ? async () => tabs || [] : stub()) }) : t[k]) });
  ctx.importScripts = (...files) => { for (const f of files) vm.runInContext(readFileSync(join(root, f), 'utf8'), ctx); };
  vm.createContext(ctx);
  vm.runInContext(readFileSync(join(root, 'background.js'), 'utf8'), ctx);
  return ctx;
}

test('background: 地址带会过期的参数时，先用开着的同一页面现在的地址，没有就去掉这些参数', async () => {
  const bg = loadBackground([{ url: 'https://app.test/other' }, { url: 'https://app.test/page?id=1&token=FRESHTOKEN3' }]);
  assert.deepEqual(JSON.parse(JSON.stringify(await bg.liveUrlOf('https://app.test/page?id=1&token=OLDTOKEN1'))), { url: 'https://app.test/page?id=1&token=FRESHTOKEN3', adjusted: 'open-tab', removed: ['token'] });
  const none = loadBackground([]);
  assert.equal((await none.liveUrlOf('https://app.test/page?id=1&token=OLDTOKEN1')).url, 'https://app.test/page?id=1');
  assert.deepEqual(JSON.parse(JSON.stringify(await none.liveUrlOf('https://app.test/page?id=1'))), { url: 'https://app.test/page?id=1' });
});

test('background: 只让页面自己发——重做发出接口的那一步，按调用参数改写；页面一打开就发的改不了参数', async () => {
  const bg = loadBackground([]);
  const steps = [
    { type: 'navigate', url: 'https://app.test/page', desc: '打开页面' },
    { type: 'click', desc: '点击 日期', waitFor: [] },
    { type: 'click', desc: '点击 查询', waitFor: [0] },
  ];
  const a = { name: 'POST /mms/list', fn: 'list', method: 'POST', host: 'app.test', pathTemplate: '/mms/list', bodyType: 'json',
    params: { body: { pageNumber: 1, crawlerInfo: '' } }, toolArgs: [{ arg: 'pageNumber', sec: 'body', key: 'pageNumber' }],
    pageGenerated: ['body.crawlerInfo'], triggeredBy: [0, 3], okSignals: { success: true } };
  const b = { name: '推广', params: {}, apiParams: {}, config: {}, recording: { startUrl: 'https://app.test/page', steps, apis: [a] } };
  let got = null;
  bg.runUi = async (item, only, opts) => {
    got = { steps: only.recording.steps.map((s) => s.desc), apiParams: JSON.parse(JSON.stringify(opts.apiParams)), fresh: opts.fresh };
    return { ok: true, completed: 3, responses: [{ step: 3, api: a.name, url: 'https://app.test/mms/list', status: 200, data: { success: true, result: [1] } }], tab: { id: 7 } };
  };
  const r = await bg.triggerApi({ id: 'x' }, b, { ...a, triggerStep: 3 }, { pageNumber: 2 }, {});
  assert.equal(r.ok, true, r.error);
  assert.equal(r.via, 'page');
  assert.deepEqual(JSON.parse(JSON.stringify(got)), { steps: ['打开页面', '点击 日期', '点击 查询'], apiParams: { 'POST /mms/list': { path: {}, query: {}, body: { pageNumber: 2 } } }, fresh: false });
  assert.equal(r.trigger.step, 3);
  assert.deepEqual(JSON.parse(JSON.stringify(r.data)), { success: true, result: [1] });

  bg.runUi = async () => ({ ok: true, completed: 3, responses: [{ step: 1, api: a.name, status: 200, data: { success: true } }] });
  const other = await bg.triggerApi({ id: 'x' }, b, a, { pageNumber: 2 }, {});
  assert.equal(other.unknown, true, '不是这一步等到的返回（页面初始化时发的）不算这次的结果');
  assert.equal(other.next, undefined, '说不准有没有发出去时不给能直接重跑的 next');
  bg.runUi = async () => ({ ok: false, completed: 0, error: '找不到元素', responses: [] });
  const notRun = await bg.triggerApi({ id: 'x' }, b, a, { pageNumber: 2 }, {});
  assert.equal(notRun.notSent, true, '没走到那一步，请求没发出');
  bg.runUi = async () => ({ ok: true, completed: 3, responses: [{ step: 3, api: a.name, status: 200, data: { success: false, errorMsg: '风控' } }] });
  const rej = await bg.triggerApi({ id: 'x' }, b, a, { pageNumber: 2 }, {});
  assert.equal(rej.rejected, true);
  assert.equal(rej.next.tool, 'run_recording');
  assert.match(rej.next.note, /控件/);

  const onLoad = { ...a, triggeredBy: [1] };
  let called = false;
  bg.runUi = async (item, only, opts) => { called = opts.fresh; return { ok: true, completed: 1, responses: [], network: [{ method: 'POST', url: 'https://app.test/mms/list', status: 200, data: { success: true } }] }; };
  const fixed = await bg.triggerApi({ id: 'x' }, b, onLoad, { pageNumber: 2 }, {});
  assert.equal(fixed.notSent, true, '页面一打开就发的接口改不了参数');
  assert.equal(fixed.next.args.mode, 'ui');
  const plain = await bg.triggerApi({ id: 'x' }, b, onLoad, {}, {});
  assert.equal(plain.ok, true, '不改参数时重新打开页面，从抓到的请求里取返回');
  assert.equal(called, true);
});

test('审查补充：写接口不当来源；关掉“隐藏请求头”时反爬头照样打码；会顺带提交的步骤不自动重做', async () => {
  const tk = 'TK-' + token(20);
  for (const [method, url] of [['DELETE', 'https://app.test/api/token'], ['POST', 'https://app.test/api/pay/token/'], ['PUT', 'https://app.test/api/config']]) {
    const events = ingest([nav,
      req('r1', 10, method, url, { responseBody: json({ success: true, data: { tk } }) }),
      req('r2', 20, 'GET', `https://app.test/api/list?ticket=${tk}`),
    ]);
    const list = E.analyze(events, {}, { startUrl: 'https://app.test/page' }).apis.find((x) => x.name === 'GET /api/list');
    assert.equal(list.sources, undefined, `${method} ${url} 不能当发放接口自动调用`);
  }
  const raw = { id: 'r', url: 'https://app.test/x', method: 'POST', requestHeaders: { 'anti-content': '0aq' + token(80), authorization: 'Bearer abc' } };
  const off = E.scrubRequest(raw, [], false, false);
  assert.equal(off.requestHeaders['anti-content'], '***');
  assert.equal(off.requestHeaders.authorization, 'Bearer abc', '其余请求头照设置走');

  const bg = loadBackground([]);
  const steps = [{ type: 'navigate', url: 'https://app.test/page', desc: '打开页面' },
    { type: 'click', desc: '点击 删除', sends: ['POST /api/order/delete', 'POST /mms/list'], waitFor: [0] }];
  const a = { name: 'POST /mms/list', fn: 'list', method: 'POST', host: 'app.test', pathTemplate: '/mms/list', bodyType: 'json', params: { body: {} }, pageGenerated: ['body.crawlerInfo'], triggerStep: 2, triggeredBy: [2] };
  let ran = false;
  bg.runUi = async () => { ran = true; return { ok: true, completed: 2, responses: [] }; };
  const r = await bg.triggerApi({ id: 'x' }, { name: 'n', params: {}, apiParams: {}, recording: { startUrl: 'https://app.test/page', steps, apis: [a] } }, a, {}, {});
  assert.equal(r.notSent, true);
  assert.equal(ran, false, '重做“删除”会把删除再做一遍');
});

test('复核补充：运行数据里带着步骤发过的接口；长乱串在接口地址、导出里都打码；结构对不上不算成功', () => {
  const click = { kind: 'step', id: 's1', ts: 5, type: 'click', target: { desc: '删除' } };
  const call = (id, ts, i) => req(id, ts, 'GET', `https://app.test/api/list?sig2=Zx${token(80 + i)}&page=1`);
  const events = [nav, click, req('w', 6, 'POST', 'https://app.test/api/order/delete', { requestBody: json({ id: 1 }) }), call('r1', 7, 1), call('r2', 20, 2)];
  const out = E.build(events, {}, { startUrl: 'https://app.test/page' });
  const step = out.bundle.recording.steps.find((s) => s.type === 'click');
  assert.deepEqual(step.sends.sort(), ['GET /api/list', 'POST /api/order/delete']);
  const list = out.bundle.recording.apis.find((a) => a.name === 'GET /api/list');
  assert.deepEqual(list.pageGenerated, ['query.sig2']);
  for (const k of [80, 81, 82]) assert.ok(!JSON.stringify(out.raw).includes('Zx' + token(k)) && !JSON.stringify(out.bundle).includes('Zx' + token(k)), '分析时才认出的长串不进导出和运行数据');
  assert.equal(E.okCheck({ okShape: { json: true, keys: ['data'] } }, '<html>login</html>').unknown, true);
  assert.equal(E.okCheck({ okShape: { json: true, keys: ['data'] } }, { data: [] }), null);
});

test('第二轮复核：翻页游标入库不打码、接口照样能直接请求；写接口按单词判断', () => {
  const cursor = 'cur' + token(40);
  const events = ingest([nav,
    req('r1', 10, 'GET', 'https://app.test/api/feed?size=20', { responseBody: json({ success: true, next: cursor }) }),
    req('r2', 20, 'GET', `https://app.test/api/feed?size=20&cursor=${cursor}`),
  ]);
  assert.ok(JSON.stringify(events).includes(cursor), '同一接口上一页返回的游标不是发放来的，原样保留');
  const feed = E.analyze(events, {}, { startUrl: 'https://app.test/page' }).apis.find((x) => x.name === 'GET /api/feed');
  assert.equal(feed.masked, undefined);
  assert.equal(feed.sources, undefined);
  for (const [m, p, w] of [['GET', '/api/address/list', false], ['GET', '/api/settings', false], ['GET', '/api/order/detail', false],
    ['GET', '/api/order/cancelOrder', true], ['POST', '/api/addItem', true], ['DELETE', '/api/items/3', true], ['POST', '/api/credit/token', false]]) {
    assert.equal(E.writeApi(m, p), w, `${m} ${p}`);
  }
});

// ======================= 只让页面自己发：前面的操作不能跳过、会改动数据的步骤不重做 =======================

test('只让页面自己发：打开页面后先照录制把筛选条件填好，再点查询（没传的条件用录制值，不是页面默认值）', async () => {
  const bg = loadBackground([]);
  const steps = [
    { type: 'navigate', url: 'https://app.test/home', desc: '打开首页' },
    { type: 'click', desc: '点击 推广', waitFor: [] },
    { type: 'url', url: 'https://app.test/promo#/list', desc: '切到 推广列表' },
    { type: 'fill', param: 'date', value: '2026-11-01', desc: '填写 日期', waitFor: [] },
    { type: 'select', param: 'status', value: '投放中', desc: '选择 状态', waitFor: [] },
    { type: 'click', desc: '点击 查询', waitFor: [0], sends: ['POST /mms/list', 'POST /mms/list/count'] },
  ];
  const a = { name: 'POST /mms/list', fn: 'list', method: 'POST', host: 'app.test', pathTemplate: '/mms/list', bodyType: 'json',
    params: { body: { date: '2026-11-01', status: 1, pageNumber: 1, crawlerInfo: '' } },
    toolArgs: [{ arg: 'pageNumber', sec: 'body', key: 'pageNumber' }], pageGenerated: ['body.crawlerInfo'], triggerStep: 6, triggeredBy: [6], okSignals: { success: true } };
  const b = { name: '推广', params: { date: '2026-11-01', status: '投放中' }, apiParams: {}, config: {},
    recording: { startUrl: 'https://app.test/home', steps, apis: [a] } };
  // 模拟页面：筛选框只有回放里真的填过才有值，没填就是页面默认的空值；页面只改写和录制值不同的字段（翻页）
  let seen = null;
  bg.runUi = async (item, only, opts) => {
    const done = only.recording.steps;
    seen = done.map((s) => s.desc);
    const filled = (p) => done.filter((s) => s.param === p).map((s) => s.value).pop();
    const body = { date: filled('date') || '', status: filled('status') ? 1 : '', pageNumber: (opts.apiParams[a.name].body || {}).pageNumber || 1 };
    return { ok: true, completed: done.length, responses: [{ step: done.length, api: a.name, status: 200, data: { success: true, echo: body } }] };
  };
  const r = await bg.triggerApi({ id: 'x' }, b, a, { pageNumber: 2 }, {});
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(JSON.parse(JSON.stringify(seen)), ['切到 推广列表', '填写 日期', '选择 状态', '点击 查询'], '从最后打开的那一页开始，中间的操作都做，不只做“查询”');
  assert.deepEqual(JSON.parse(JSON.stringify(r.data.echo)), { date: '2026-11-01', status: 1, pageNumber: 2 }, '没传的条件是录制值');
  assert.equal(r.trigger.step, 6);
});

test('只让页面自己发：要重做的步骤（包括前面的操作）会发看不出是查询的写接口时不自动做', async () => {
  for (const [m, p, w] of [['POST /goods/offline', true], ['POST /graphql #DeleteItem', true], ['POST /graphql #updateSku', true], ['POST /graphql', true],
    ['POST /graphql #ProductList', false], ['POST /graphql #op=ProductList', false], ['POST /graphql #op=RenameItem', true], ['POST /mms/list', false], ['POST erp.test/api/stat/summary?type=1', false], ['GET /api/list', false],
    ['GET /api/order/cancelOrder', true], ['PUT /api/x', true], ['POST /api/batchOperate', true]]) {
    assert.equal(E.sideEffectApi(m), p, m);
    void w;
  }
  const bg = loadBackground([]);
  const a = { name: 'POST /mms/list', fn: 'list', method: 'POST', host: 'app.test', pathTemplate: '/mms/list', bodyType: 'json', params: { body: {} }, pageGenerated: ['body.crawlerInfo'], triggerStep: 3, triggeredBy: [3] };
  const run = async (steps) => {
    let ran = false;
    bg.runUi = async () => { ran = true; return { ok: true, completed: steps.length, responses: [{ step: steps.length, api: a.name, status: 200, data: {} }] }; };
    const r = await bg.triggerApi({ id: 'x' }, { name: 'n', params: {}, apiParams: {}, recording: { startUrl: 'https://app.test/page', steps, apis: [a] } }, a, {}, {});
    return { r, ran };
  };
  const nav0 = { type: 'navigate', url: 'https://app.test/page', desc: '打开页面', sends: ['POST /api/init'] };
  const offline = await run([nav0, { type: 'click', desc: '点击 下架', sends: ['POST /goods/offline'] }, { type: 'click', desc: '点击 查询', sends: ['POST /mms/list'] }]);
  assert.equal(offline.ran, false, '前面的“下架”也要重做，会再下架一次');
  assert.equal(offline.r.notSent, true);
  assert.match(offline.r.error, /第 2 步.*goods\/offline/);
  const gql = await run([nav0, { type: 'fill', desc: '填写 名称' }, { type: 'click', desc: '点击 保存并刷新', sends: ['POST /graphql #RenameItem', 'POST /mms/list'] }]);
  assert.equal(gql.ran, false, 'GraphQL 的修改操作也拦下');
  const ok = await run([nav0, { type: 'fill', desc: '填写 名称' }, { type: 'click', desc: '点击 查询', sends: ['POST /mms/list', 'POST /graphql #ItemCount'] }]);
  assert.equal(ok.ran, true, ok.r.error);
  assert.equal(ok.r.ok, true, '打开页面时发的看不出是什么的 POST 不算（用户每次打开都会发），查询类的照常');
});

test('“打开页面”步骤的地址：导出 JSON、脚本、AI 提示词、给 AI 的录制概要里令牌打码；回放数据里留原地址', () => {
  const secret = 'OLDTOKEN' + token(24);
  const start = `https://app.test/promo?token=${secret}&id=7#/list`;
  const moved = `https://app.test/promo/detail?ticket=${secret}&id=8`;
  const events = [
    { kind: 'step', id: 's0', ts: 1, type: 'navigate', url: start },
    { kind: 'step', id: 's1', ts: 5, type: 'url', url: moved },
    req('r1', 10, 'GET', 'https://app.test/api/list?id=7'),
  ];
  const out = E.build(events, {}, { startUrl: start });
  for (const [where, v] of Object.entries({ raw: out.raw, script: out.script, prompt: out.prompt, summary: out.summary, steps: out.analysis.steps.map((s) => s.desc) })) {
    assert.ok(!JSON.stringify(v).includes(secret), `${where} 里不该有原令牌`);
  }
  assert.match(out.analysis.steps[0].desc, /打开页面 https:\/\/app\.test\/promo\?token=.*id=7/, '描述里还看得出是哪个页面');
  assert.equal(out.bundle.recording.steps[0].url, start, '回放数据要原地址（打开时再按会过期的参数处理）');

  const bg = loadBackground([]);
  const s = bg.recordingSummary({ id: 'x', events, state: { startUrl: start, name: 'n' } });
  assert.ok(!JSON.stringify(s).includes(secret), 'list_recordings 给 AI 的概要不带原令牌');
  assert.match(s.startUrl, /^https:\/\/app\.test\/promo\?token=/);
});
