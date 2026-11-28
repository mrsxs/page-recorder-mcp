// 会过期的东西：页面现算的反爬串、发放接口、地址里会过期的参数、只让页面自己发一个接口
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

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
  const ctx = { console: { log() {}, warn() {}, error() {} }, URL, URLSearchParams, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, TextEncoder, TextDecoder, Headers, crypto: webcrypto };
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
  const plain = loadBackground([{ url: 'https://app.test/page?id=1' }]);
  assert.equal((await plain.liveUrlOf('https://app.test/page?id=1&token=OLDTOKEN1')).adjusted, 'stripped', '开着的同一页面不带令牌：和去掉参数打开一样，不算');
  const none = loadBackground([]);
  assert.equal((await none.liveUrlOf('https://app.test/page?id=1&token=OLDTOKEN1')).url, 'https://app.test/page?id=1');
  assert.deepEqual(JSON.parse(JSON.stringify(await none.liveUrlOf('https://app.test/page?id=1'))), { url: 'https://app.test/page?id=1' });
});

test('background: 上传时按标记找文件框，open 的 Shadow DOM 里的（一层套一层的）也找得到', () => {
  const bg = loadBackground([]);
  const expr = vm.runInContext('findUploadExpr', bg)('up1abc');
  // 假的 DOM：节点有属性、子节点，可能带 shadowRoot；querySelector 和真的一样不进 shadowRoot
  const flat = (n) => n.children.flatMap((c) => [c, ...flat(c)]);
  const tree = (children) => {
    const r = { children };
    r.querySelectorAll = () => flat(r);
    r.querySelector = (sel) => flat(r).find((c) => sel === `[data-pr-upload="${c.attrs['data-pr-upload']}"]`) || null;
    return r;
  };
  const node = (attrs = {}, children = [], shadow = null) => ({ attrs, children, shadowRoot: shadow && tree(shadow) });
  const input = node({ 'data-pr-upload': 'up1abc' });
  const run = (document) => vm.runInNewContext(expr, { document });
  assert.equal(run(tree([node({}, [input])])), input, '普通页面');
  assert.equal(run(tree([node({}, [node({}, [], [node({}, [input])])])])), input, '组件的 Shadow DOM 里');
  assert.equal(run(tree([node(), node({}, [], [node({}, [node({}, [], [node(), input])])])])), input, 'Shadow DOM 里套 Shadow DOM');
  assert.equal(run(tree([node({}, [node({ 'data-pr-upload': 'other' })], [node()])])), null, '标记对不上的不算');
});

test('background: 回放允许上传的文件——调用时给的路径；没传这个参数就用本机存的默认路径；传空 = 这次不上传', () => {
  const bg = loadBackground([]);
  const b = { params: { 文件: '/Users/me/默认.pdf', 关键词: 'a' }, recording: { steps: [{ type: 'upload', param: '文件' }, { type: 'fill', param: '关键词' }, { type: 'upload' }] } };
  const list = (params) => JSON.parse(JSON.stringify(bg.uploadWhitelist(b, params)));
  assert.deepEqual(list({ 关键词: 'x' }), ['/Users/me/默认.pdf'], '没传上传参数：用存着的默认路径（以前白名单是空的，回放报“只能上传回放参数里给的文件”）');
  assert.deepEqual(list(undefined), ['/Users/me/默认.pdf']);
  assert.deepEqual(list({ 文件: ' /tmp/a.png | /tmp/b.png ' }), ['/tmp/a.png', '/tmp/b.png'], '传了就只认传的');
  assert.deepEqual(list({ 文件: '' }), [], '传空：这次不上传，默认路径也不放行');
  assert.deepEqual(JSON.parse(JSON.stringify(bg.uploadWhitelist({ params: {}, recording: { steps: [{ type: 'upload', param: 'toString' }] } }, {}))), [], '参数名撞上原型上的名字也不出错');
});

test('background: 在弹窗里点停止——先让页面把没提交的输入交上来（这时还算在录制中），再结束录制', async () => {
  const sent = [];
  const stub = () => new Proxy(function () {}, {
    get(t, k) { if (k === 'then') return undefined; if (k === 'addListener') return () => {}; return stub(); },
    apply() { return Promise.resolve({}); },
  });
  const ctx = { console: { log() {}, warn() {}, error() {} }, URL, URLSearchParams, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, TextEncoder, TextDecoder, Headers, crypto: webcrypto };
  ctx.self = ctx;
  const c = { state: { id: 'r1', tabId: 5, recording: true, childTabs: [] }, events: [], settings: {}, libIndex: [], apiOverrides: {}, aiDocs: {} };
  const tabs = new Proxy(stub(), { get: (x, m) => (m === 'sendMessage' ? async (tabId, msg) => { sent.push({ tabId, type: msg.type, recording: c.state.recording }); return { ok: true }; } : m === 'query' ? async () => [] : stub()) });
  ctx.chrome = new Proxy(stub(), { get: (t, k) => (k === 'tabs' ? tabs : t[k]) });
  ctx.importScripts = (...files) => { for (const f of files) vm.runInContext(readFileSync(join(root, f), 'utf8'), ctx); };
  vm.createContext(ctx);
  vm.runInContext(readFileSync(join(root, 'background.js'), 'utf8'), ctx);
  await ctx.stop(c);
  assert.equal(c.state.recording, false);
  assert.deepEqual(sent[0], { tabId: 5, type: 'flush', recording: true }, '第一件事是让页面交输入，这时录制还没结束');
  assert.ok(sent.some((m) => m.type === 'state' && m.recording === false), '之后才通知页面录制结束');
});

test('background: start_url 只认同一页面；只能去掉参数打开时先到来源页找指向它的链接', async () => {
  const bg = loadBackground([]);
  const page = 'https://app.test/page?id=1&ticket=OLDTICKET1';
  const g = bg.givenStart('https://app.test/page?ticket=NEWTICKET9&id=1', page);
  assert.deepEqual(JSON.parse(JSON.stringify(g)), { url: 'https://app.test/page?ticket=NEWTICKET9&id=1', adjusted: 'given', removed: ['ticket'] });
  assert.equal(bg.givenStart('https://app.test/page?id=2&ticket=NEWTICKET9', page), null, '别的记录不行');
  assert.equal(bg.givenStart('https://other.test/page?id=1', page), null);
  assert.equal(bg.givenStart('javascript:alert(1)//https://app.test/page?id=1', page), null);
  assert.equal(bg.givenStart(undefined, page), null);
  assert.equal(bg.givenStart('https://u:p@app.test/page?id=1&ticket=NEWTICKET9', page), null, '带账号密码的地址不认');
  assert.equal(bg.givenStart('https://app.test/page/?id=1&ticket=NEWTICKET9', page), null, '路径要一字不差（末尾多一个 / 也不行）');

  let url = 'about:blank';
  let links = [];
  let adLinks = [];
  const own = {
    tabs: { get: async () => ({ status: 'complete', url }), update: async (id, o) => { url = o.url === 'https://app.test/moved' ? 'https://login.test/' : o.url; } },
    scripting: { executeScript: async () => [{ result: { origin: new URL(url).origin, links } }, { result: { origin: 'https://ads.test', links: adLinks } }, { result: null }] },
  };
  const orig = bg.chrome;
  bg.chrome = new Proxy({}, { get: (t, k) => own[k] || orig[k] });
  bg.waitTabComplete = async () => {};
  const stripped = { url: 'https://app.test/page?id=1', adjusted: 'stripped', removed: ['ticket'] };
  const b = { recording: { startUrl: page, entry: { from: 'https://app.test/list' } } };
  links = ['https://app.test/page?id=2&ticket=OTHER12345', 'https://app.test/page?id=1', 'https://app.test/page?id=1&ticket=FRESH12345'];
  let r = await bg.viaSource(1, { id: 'r1' }, b, stripped, Date.now());
  assert.equal(url, 'https://app.test/list', '先打开来源页');
  assert.deepEqual(JSON.parse(JSON.stringify(r)), { url: 'https://app.test/page?id=1&ticket=FRESH12345', adjusted: 'source-link', removed: ['ticket'], from: 'https://app.test/list', left: true }, '优先带新令牌的那个链接，别的记录的链接不要');
  assert.equal(await bg.viaSource(1, { id: 'r1' }, b, { url: page }, Date.now()).then((x) => x.adjusted), undefined, '不用去掉参数打开时不找');

  links = ['https://app.test/page?id=2&ticket=OTHER12345', 'https://app.test/page?id=1', 'https://u:p@app.test/page?id=1&ticket=FRESH12345'];
  adLinks = ['https://app.test/page?id=1&ticket=FROMANAD99'];
  url = 'about:blank';
  r = await bg.viaSource(1, { id: 'r2' }, b, stripped, Date.now() + 60000, 0);
  assert.equal(r.adjusted, 'stripped', '只有不带令牌的链接（和去掉参数打开一样）、带账号密码的链接、别的源的框架里的链接，都不算找到');
  assert.equal(r.source, 'https://app.test/list');
  assert.equal(r.left, true, '标签页已经在来源页上，调用方要重新打开起始页面');
  url = 'about:blank';
  r = await bg.viaSource(1, { id: 'r2' }, b, stripped, Date.now());
  assert.equal(url, 'about:blank', '刚找过没找到的，一段时间内不再找');
  assert.equal(r.left, undefined);
  url = 'about:blank';
  r = await bg.viaSource(1, { id: 'r4' }, b, stripped, Date.now());
  assert.equal(r.adjusted, 'stripped');
  url = 'about:blank';
  await bg.viaSource(1, { id: 'r4' }, b, stripped, Date.now());
  assert.equal(url, 'https://app.test/list', '时间不够、没等满就没找到的不算，下次照样找');

  links = ['https://app.test/page?id=1&ticket=FRESH12345'];
  r = await bg.viaSource(1, { id: 'r5' }, { recording: { startUrl: page, entry: { from: 'https://app.test/moved' } } }, stripped, Date.now() + 60000, 0);
  assert.equal(r.adjusted, 'stripped', '来源页被跳到别的源上（登录页）：那里的链接不认');

  const cross = { recording: { startUrl: page, entry: { from: 'https://evil.test/list' } } };
  assert.equal(bg.sourceOf({ id: 'r3' }, cross, stripped), '', '不认别的站点的来源页');
  assert.equal(bg.sourceOf({ id: 'r3' }, { recording: { startUrl: page, entry: { from: 'https://www.app.test/list' } } }, stripped), 'https://www.app.test/list', '自己录的：同一站点的子域名可以');
  assert.equal(bg.sourceOf({ id: 'r3', imported: true }, { recording: { startUrl: page, entry: { from: 'https://www.app.test/list' } } }, stripped), '', '导入的：只认同源');
  assert.equal(bg.sourceOf({ id: 'r3', imported: true }, { recording: { startUrl: page, entry: { from: 'https://app.test/list' } } }, stripped), 'https://app.test/list');
  assert.equal(bg.sourceOf({ id: 'r3' }, { recording: { startUrl: page, entry: { from: 'https://app.test/user/logout' } } }, stripped), '', '打开就会改数据的地址不去');
  assert.equal(bg.sourceOf({ id: 'r3' }, { recording: { startUrl: page, entry: { from: 'https://app.test/act?op=delete' } } }, stripped), '', '查询参数里的也认');
  assert.equal(bg.sourceOf({ id: 'r3' }, { recording: { startUrl: page, entry: { from: 'https://app.test/%6Cogout' } } }, stripped), '', '编码过的也认');
  assert.equal(bg.sourceOf({ id: 'r3' }, { recording: { startUrl: page, entry: { from: 'https://app.test/#/user/logout' } } }, stripped), '', 'hash 路由里的也认');
  assert.equal(bg.sourceOf({ id: 'r3' }, { recording: { startUrl: page, entry: { from: 'https://app.test/list?kw=%C5%AE%D7%B0' } } }, stripped), 'https://app.test/list?kw=%C5%AE%D7%B0', 'GBK 编码的参数解不出来也不误杀');
  assert.equal(bg.sourceOf({ id: 'r3' }, { recording: { startUrl: page, entry: { from: 'javascript:x' } } }, stripped), '');
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

test('导出 JSON 能用「导入录制包」导回：步骤、参数、AI 写的接口说明、改过的接口参数和原来一样', async () => {
  const secret = 'MEMBERTOKEN' + token(24);
  const q = { selectors: ['#q'], tag: 'input', label: '关键词' };
  const events = [
    nav,
    { kind: 'step', id: 'f1', ts: 3, type: 'fill', target: q, value: 'abc', url: 'https://app.test/page' },
    { kind: 'step', id: 'f2', ts: 5, type: 'fill', target: q, value: 'abd', url: 'https://app.test/page' },
    { kind: 'step', id: 'g1', ts: 7, type: 'fill', pick: 'date', target: { selectors: ['#d'], tag: 'input', label: '日期' }, value: '2026-11-01', members: ['m1', 'm2'], url: 'https://app.test/page' },
    { kind: 'step', id: 'm1', ts: 7, type: 'click', groupedIn: 'g1', target: { selectors: ['#d'] }, url: `https://app.test/page?token=${secret}` },
    { kind: 'step', id: 'm2', ts: 8, type: 'click', groupedIn: 'g1', target: { selectors: ['.day'] }, url: 'https://app.test/page' },
    req('r1', 10, 'GET', 'https://app.test/api/list?kw=abd&date=2026-11-01&page=1&size=20'),
  ];
  const A0 = E.analyze(events, {}, { startUrl: nav.url });
  const api = A0.apis[0].name;
  const aiDocs = { title: '查列表', description: '按关键词查', apis: { [api]: { fn: 'listItems', title: '列表', description: '查列表', params: { 'query.kw': '关键词' }, returns: 'data[]' } } };
  const overrides = { [api]: { query: { page: '2', size: { __deleted: true } } } };
  const state = { startUrl: nav.url };
  const before = E.build(events, {}, state, overrides, aiDocs);
  const file = JSON.parse(JSON.stringify(before.raw));
  assert.equal(E.exportedJson(file), true);
  assert.ok(!JSON.stringify(file).includes(secret), '导出 JSON 里语义步骤带着的原始操作地址也打码');

  const pkg = E.packageFromExport(file);
  const it = pkg.item;
  assert.deepEqual(it.events.filter((e) => e.kind === 'step').map((e) => e.id), ['s0', 'f1', 'f2', 'g1', 'm1', 'm2'], '语义步骤下的原始操作还原成单独的事件');
  assert.ok(it.events.every((e) => e.desc === undefined && e.param === undefined && e.waitFor === undefined), '分析时加的字段去掉');
  const after = E.build(it.events, {}, it.state, it.apiOverrides, it.aiDocs);
  const again = JSON.parse(JSON.stringify(after.raw));
  for (const k of ['name', 'description', 'steps', 'tools', 'apis', 'requests', 'params', 'paramInfo']) assert.deepEqual(again[k], file[k], k);
  assert.deepEqual(after.analysis.steps.map((s) => s.param).filter(Boolean), before.analysis.steps.map((s) => s.param).filter(Boolean));
  assert.equal(after.analysis.apis[0].fn, 'listItems');
  assert.equal(after.analysis.apis[0].editParams.query.size, undefined, '删掉的参数还是删掉');

  const bg = loadBackground([]);
  const c = { settings: {}, libIndex: [] };
  const r = await bg.importPackage(c, file);
  assert.equal(r.ok, true);
  assert.equal(r.fromExport, true);
  assert.equal(c.libIndex[0].hasDocs, true);
  assert.deepEqual(JSON.parse(JSON.stringify(c.libIndex[0].params)), file.params);
  await assert.rejects(bg.importPackage(c, { generator: 'Page Recorder' }), /不是 Page Recorder 导出的录制包（\.prpkg\.json）或导出 JSON/);
});

test('导出再导回（录制包、导出 JSON）：按值认出的页面现算串还是页面现算；改过的令牌参数打码；只改了函数名的带回来', async () => {
  const sigReq = (id, ts, sig, extra) => req(id, ts, 'POST', 'https://app.test/api/list', { requestBody: json({ page: 1, sig2: sig }), ...extra });
  const events = [nav, sigReq('r1', 10, token(80)), { kind: 'step', id: 's1', ts: 20, type: 'click', target: { selectors: ['#b'] }, url: nav.url }, sigReq('r2', 30, token(81))];
  const state = { startUrl: nav.url };
  const A0 = E.analyze(events, {}, state);
  const api = A0.apis[0].name;
  assert.deepEqual(A0.apis[0].pageGenerated, ['body.sig2']);
  const again = E.analyze(E.maskGenerated(events, A0), {}, state);
  assert.deepEqual(again.apis[0].pageGenerated, ['body.sig2'], '值打了码，靠标记认');
  assert.equal(again.apis[0].masked, undefined, '不当成用页面最新值补的脱敏字段');

  const secret = 'OVERRIDE' + token(30);
  const file = JSON.parse(JSON.stringify(E.build(events, {}, state, { [api]: { body: { token: secret } } }, { apis: { [api]: { fn: 'myList' } } }).raw));
  assert.ok(!JSON.stringify(file).includes(secret), '改过的令牌参数不出现在导出 JSON 里');
  const it = E.packageFromExport(file).item;
  const A1 = E.analyze(it.events, {}, it.state, it.apiOverrides, it.aiDocs);
  assert.deepEqual(A1.apis[0].pageGenerated, ['body.sig2']);
  assert.equal(A1.apis[0].fn, 'myList', '只改了函数名也带回来');
  assert.equal(it.aiDocs.title, undefined, '没有 AI 写的说明，不算 AI 已解读');
  assert.equal(E.packageFromExport(JSON.parse(JSON.stringify(E.build(events, {}, state).raw))).item.aiDocs.apis, undefined, '自动起的函数名不用带');

  // 同一接口还有带原值的调用（合并进来的别的录制）：标记不作数，照原值判断
  const marked = E.maskGenerated(events, A0).filter((e) => e.kind === 'request');
  const mixed = [nav, marked[0], { kind: 'step', id: 's2', ts: 40, type: 'click', target: { selectors: ['#c'] }, url: nav.url }, sigReq('r3', 50, 'plain-value')];
  assert.equal(E.analyze(mixed, {}, state).apis[0].pageGenerated, undefined);

  // 密码字段跟随密码参数（{{密码}}）：导出不打掉模板；导回后只记真正改过的参数，绑定还在
  const pw = [nav, { kind: 'step', id: 'p1', ts: 3, type: 'fill', sensitive: true, secretId: 'p1', target: { selectors: ['#pw'], tag: 'input', type: 'password', label: '密码' }, value: '', url: nav.url },
    req('r9', 10, 'POST', 'https://app.test/api/login?page=1', { requestBody: json({ user: 'u', password: '__PR_SECRET_p1__' }) })];
  const P0 = E.analyze(pw, {}, state);
  const pwApi = P0.apis[0].name;
  assert.equal(P0.apis[0].editParams.body.password, '{{密码}}');
  const pwFile = JSON.parse(JSON.stringify(E.build(pw, {}, state, { [pwApi]: { query: { page: '2' } } }).raw));
  assert.equal(pwFile.apis[0].editParams.body.password, '{{密码}}');
  const pwIt = E.packageFromExport(pwFile).item;
  assert.equal(pwIt.apiOverrides[pwApi].body.user, undefined, '和录制值一样的不记');
  const P1 = E.analyze(pwIt.events, {}, pwIt.state, pwIt.apiOverrides, pwIt.aiDocs);
  assert.deepEqual([P1.apis[0].editParams.body.password, P1.apis[0].editParams.query.page], ['{{密码}}', '2']);

  // 自己起的名字正好是“自动名 + 数字”：没有别的接口占着自动名，就是自己起的
  const one = JSON.parse(JSON.stringify(E.build(events, {}, state, {}, { apis: { [api]: { fn: `${A0.apis[0].fn}2` } } }).raw));
  assert.equal(E.packageFromExport(one).item.aiDocs.apis[api].fn, `${A0.apis[0].fn}2`);
});

test('导入：文件里的 __proto__ 键去掉（复制步骤时会被当成原型、绕过地址校验）；分析不了的不进脚本库', async () => {
  const bg = loadBackground([]);
  const text = JSON.stringify({ format: 'page-recorder-package', version: 1, name: 'x', item: { state: { startUrl: nav.url }, events: [nav] } })
    .replace('"events":[{', '"events":[{"kind":"step","id":"p1","ts":2,"type":"navigate","__proto__":{"url":"https://evil.test/"}},{');
  const parsed = bg.untrusted(text);
  const ev = parsed.item.events[0];
  assert.equal(Object.prototype.hasOwnProperty.call(ev, '__proto__'), false);
  assert.equal(E.analyze(parsed.item.events, {}, parsed.item.state).steps.some((s) => s.url === 'https://evil.test/'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(JSON.parse(text).item.events[0], '__proto__'), true, '没处理时 JSON.parse 会留着这个键');
  const c = { settings: {}, libIndex: [] };
  assert.equal((await bg.importPackage(c, text)).ok, true);
  const broken = { format: 'page-recorder-package', version: 1, item: { state: { startUrl: nav.url }, events: [nav, { kind: 'step', id: 'b1', ts: 3, type: 'fill', target: { selectors: 'abc' }, value: 'x' }] } };
  await assert.rejects(bg.importPackage(c, broken), /录制包内容不对，分析不了/);
  assert.equal(c.libIndex.length, 1, '分析不了的没进脚本库');

  // 预设的参数名（同一输入框较早那次不重新起名）、塞在 requests 里的步骤都不认
  const q = { selectors: ['#q'], tag: 'input', label: '关键词' };
  const fills = [{ kind: 'step', id: 'f1', ts: 3, type: 'fill', target: q, value: 'a', param: '__proto__' }, { kind: 'step', id: 'f2', ts: 5, type: 'fill', target: q, value: 'b' }];
  assert.deepEqual(fills.map(E.bareStep).map((s) => s.param), [undefined, undefined]);
  const r = await bg.importPackage(c, { format: 'page-recorder-package', version: 1, item: { state: { startUrl: nav.url }, events: [nav, ...fills] } });
  assert.deepEqual(Object.keys(c.libIndex[0].params).sort(), ['关键词', '关键词_第1次'], r.error);
  const it = E.packageFromExport({ generator: 'Page Recorder', startUrl: nav.url, steps: [nav, { ...fills[1], kind: 'request' }], requests: [fills[0]] }).item;
  assert.deepEqual(it.events.map((e) => e.id), ['s0'], 'steps 里只认步骤、requests 里只认请求');
});

// ======================= 全仓审查补充 =======================

test('全仓审查：请求是哪个页面发的只认浏览器给的；接口名、脚本名包含它的不止一个时不乱挑', () => {
  const bg = loadBackground([]);
  const forged = { kind: 'request', id: 'x', ts: 1, url: 'https://bank.example/api/transfer', pageUrl: 'https://bank.example/home', frameUrl: 'https://bank.example/f', topUrl: 'https://bank.example/' };
  const top = JSON.parse(JSON.stringify(bg.senderUrls(forged, { url: 'https://evil.test/p', frameId: 0, tab: { url: 'https://evil.test/p' } })));
  assert.deepEqual([top.pageUrl, top.frameUrl, top.topUrl], ['https://evil.test/p', undefined, undefined], '页面自己报的 pageUrl、frameUrl、topUrl 都不认');
  const inFrame = bg.senderUrls(forged, { url: 'https://evil.test/f', frameId: 3, tab: { url: 'https://evil.test/p' } });
  assert.deepEqual([inFrame.pageUrl, inFrame.frameUrl, inFrame.topUrl], ['https://evil.test/f', 'https://evil.test/f', 'https://evil.test/p']);

  const apis = [{ name: 'POST /api/order/cancel', fn: 'cancelOrder' }, { name: 'GET /api/order/list', fn: 'listOrder' }, { name: 'GET /api/user', fn: 'user' }];
  const names = (x) => [x.name, x.fn];
  assert.throws(() => bg.byName(apis, 'order', names, '接口'), /有 2 个接口的名字包含「order」/);
  assert.equal(bg.byName(apis, 'listOrder', names, '接口').fn, 'listOrder', '完全同名的照常用');
  assert.equal(bg.byName(apis, 'api/user', names, '接口').fn, 'user', '只有一个包含它的照常用');
  assert.equal(bg.byName(apis, 'nothing', names, '接口'), null);
  assert.equal(bg.byName(apis, 'list', names, '接口').fn, 'listOrder', '名字包含的只比完整名称，不比函数名（和导出脚本一致）');
  const readOnly = (x) => !E.sideEffectApi(x.name);
  assert.throws(() => bg.byName([apis[0], apis[2]], 'order', names, '接口', readOnly), /会改数据，要写完整的名字/, '只有一个包含 order 的、但它是取消订单：不自动调');
  assert.equal(bg.byName([apis[0], apis[2]], 'POST /api/order/cancel', names, '接口', readOnly).fn, 'cancelOrder', '写完整名字照常调');
  assert.equal(bg.byName(apis, 'api/user', names, '接口', readOnly).fn, 'user', '查询类接口包含的照常用');

  // 导入的录制：接口记的页面要是录制打开过的网站，不然不直接请求（别人的录制包能填成任意网站）
  const b = { recording: { startUrl: 'https://shop.test/a', steps: [{ type: 'navigate', url: 'https://www.shop.test/b' }, { type: 'click', frame: { url: 'https://erp.vendor.test/f' } }] } };
  assert.equal(bg.pageVisited(b, 'https://api.shop.test/x'), true, '同一站点');
  assert.equal(bg.pageVisited(b, 'https://erp.vendor.test/f?id=1'), true, '步骤所在的 iframe');
  assert.equal(bg.pageVisited(b, 'https://bank.example/home'), false);
  assert.equal(bg.pageVisited(b, 'javascript:alert(1)'), false);
});

test('全仓审查：路径参数不能是 . 或 ..；接口名包含它的不止一个时不调；导出脚本回放完撤掉请求改写', async () => {
  const { win, fetchCalls } = runtimeEnv('https://app.test/page');
  const apis = [
    { name: 'GET /api/orders/{id}/detail', fn: 'detail', method: 'GET', url: 'https://app.test/api/orders/1/detail', pathTemplate: '/api/orders/{id}/detail', params: { path: { id: '1' } } },
    { name: 'GET /api/order/cancel', fn: 'cancelOrder', method: 'GET', url: 'https://app.test/api/order/cancel', pathTemplate: '/api/order/cancel' },
    { name: 'GET /api/order/list', fn: 'listOrder', method: 'GET', url: 'https://app.test/api/order/list', pathTemplate: '/api/order/list' },
  ];
  const rt = await win.__pageRecorderRuntime({ steps: [], apis }, {}, {}, cfg, { live: { headers: {}, fields: {} } });
  const err = (p) => p.then((r) => r.error || '', (e) => e.message);
  for (const id of ['..', '.']) assert.match(await err(rt.api.call('detail', { path: { id } })), /不能是/);
  assert.ok(await err(rt.api.call('order', {})), '包含 order 的有两个，不挑一个调');
  const only = runtimeEnv('https://app.test/page');
  const rt2 = await only.win.__pageRecorderRuntime({ steps: [], apis: [apis[0], apis[1]] }, {}, {}, cfg, { live: { headers: {}, fields: {} } });
  assert.match(await err(rt2.api.call('order/', {})), /会改数据/, '只有一个包含 order/ 的、但它是取消订单：不自动调');
  assert.equal(only.fetchCalls.length, 0);
  assert.equal((await rt2.api.call('orders/{id}', { path: { id: '3' } })).ok, true, '查询类接口包含的照常调');
  assert.equal(fetchCalls.length, 0);
  const ok = await rt.api.call('detail', { path: { id: '2' } });
  assert.equal(ok.ok, true, ok.error);
  assert.equal(new URL(fetchCalls[0].url).pathname, '/api/orders/2/detail');

  const exp = runtimeEnv('https://app.test/page');
  await exp.win.__pageRecorderRuntime({ steps: [], apis }, {}, { 'GET /api/order/list': { query: { q: 'x' } } }, { autoRun: false, verbose: false, rewriteRequests: true, netLog: true, stepDelay: 0, waitRequests: false });
  assert.equal(exp.win.__PR_NET__, undefined, '只是准备好、还没回放：不装网络钩子，不改写页面的请求');
  await exp.win.__PR__.replay();
  assert.equal(exp.win.__PR_NET__.rewrite, null, '回放完撤掉改写，之后页面自己的请求不被改成参数里的值');
});

test('全仓审查：一行一条的 WebSocket / SSE 文本、sig、app_key、常见密钥格式、OAuth 授权码都打码', () => {
  const ws = { kind: 'request', id: 'w', ts: 1, via: 'websocket', method: 'WS', url: 'wss://app.test/ws', pageUrl: 'https://app.test/', requestHeaders: {},
    requestBody: { type: 'text', value: '{"type":"auth","token":"SECRETTOKEN123"}\n42["login",{"password":"PW123456"}]\n', truncated: true } };
  const out = E.scrubRequest(ws, [], true, true);
  assert.ok(!JSON.stringify(out).includes('SECRETTOKEN123') && !JSON.stringify(out).includes('PW123456'), out.requestBody.value);
  assert.match(out.requestBody.value, /^\{"type":"auth","token":"__PR_MASKED__"\}\n42\["login",\{"password":"__PR_MASKED__"\}\]\n$/);
  const sse = 'event: hello\ndata: {"msg":"hi","access_token":"AT-SECRET-1"}\n\n';
  assert.equal(E.maskDeep(sse, true), 'event: hello\ndata: {"msg":"hi","access_token":""}\n\n');

  const gkey = 'AIza' + 'Bc1'.repeat(11) + 'xy';
  const u = E.maskUrl(`https://app.test/cb?code=OAUTHCODE123&state=st8Rand0m&sig=SIGVALUE99&app_key=APPKEY12345&key=${gkey}&page=2`, true);
  for (const secret of ['OAUTHCODE123', 'SIGVALUE99', 'APPKEY12345', gkey]) assert.ok(!u.includes(secret), `${secret} 没打码：${u}`);
  assert.match(u, /page=2/);
  assert.match(E.maskUrl('https://app.test/p?code=SKU12345', true), /code=SKU12345/, '单独的 code 多半是商品编码，不打码');
  assert.match(E.maskUrl('https://app.test/api/orders?code=ORD0012345678&state=1', true), /code=ORD0012345678/, '订单号配订单状态不是授权码');
  const order = E.scrubRequest(req('o', 1, 'GET', 'https://app.test/api/orders?code=ORD0012345678&state=paid'), [], true, true);
  assert.match(order.url, /code=ORD0012345678/, '入库时也不打码，接口照样能直接调');
  const form = E.scrubRequest({ kind: 'request', id: 'f', ts: 1, method: 'POST', url: 'https://app.test/oauth/token', pageUrl: 'https://app.test/', requestHeaders: {},
    requestBody: { type: 'form', value: 'grant_type=authorization_code&code=ABCDEF1234&redirect_uri=https%3A%2F%2Fapp.test%2Fcb' } }, [], true, true);
  assert.ok(!form.requestBody.value.includes('ABCDEF1234'));
  assert.deepEqual(E.maskDeep({ list: ['sk-' + 'a1B2'.repeat(6), 'plain'] }, true), { list: ['', 'plain'] }, '名字看不出来、值一看就是密钥的也打码');
  assert.deepEqual(E.maskDeep({ code: 'JSONCODE12', state: 'st8Rand0m' }, true), { code: '', state: 'st8Rand0m' }, 'JSON 里和 state 一起的授权码也打码');
  assert.equal(E.maskDeep('42["auth",{"token":"ONELINE123"}]', true), '42["auth",{"token":""}]', '只有一行的 socket.io 帧也打码');
  const cut = E.scrubRequest({ ...ws, requestBody: { type: 'text', value: '{"a":1}\n{"type":"auth","pin":123456,"token":"HALFSECRET12', truncated: true } }, [], true, true);
  assert.ok(!cut.requestBody.value.includes('HALFSECRET12') && !cut.requestBody.value.includes('123456'), '截断在半行的也打码：' + cut.requestBody.value);
  assert.match(cut.requestBody.value, /"type":"auth"/);

  // 长期不变的 key 只打码，不当成会过期的参数去掉；判断同一页面时不比按值认出的密钥、OAuth 授权码
  assert.deepEqual(JSON.parse(JSON.stringify(E.stripDynamic('https://app.test/p?appkey=APPKEY12345&apikey=APIKEY12345&sig=SIGVALUE99'))), { url: 'https://app.test/p?appkey=APPKEY12345&apikey=APIKEY12345', removed: ['sig'] });
  assert.equal(E.pageKey(`https://app.test/embed?key=${gkey}&q=1`), E.pageKey('https://app.test/embed?key=__PR_MASKED__&q=1'));
  assert.equal(E.pageKey('https://app.test/cb?code=REALCODE1234&state=st8Rand0m'), E.pageKey('https://app.test/cb?code=__PR_MASKED__&state=st8Rand0m'));
  assert.notEqual(E.pageKey('https://app.test/p?sid=12&q=1'), E.pageKey('https://app.test/p?sid=13&q=1'), 'sid=12 和 sid=13 是两个页面，不能混');
  assert.equal(E.exportRequest({ ...ws, requestBody: { type: 'text', value: '{"token":"LINE1SECRET"}\n{"a":1}\n' } }, { maskPasswords: true }).requestBody.value.includes('LINE1SECRET'), false, '导出时请求体里一行一条的 JSON 也打码');
  assert.notEqual(E.pageKey('https://app.test/p?code=SKU1'), E.pageKey('https://app.test/p?code=SKU2'), '单独的 code 照样区分页面');
});

test('全仓审查：起后台桥接出错（状态目录写不了）时，MCP 进程退回自己监听，不崩', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { spawn } = await import('node:child_process');
  const file = join(mkdtempSync(join(tmpdir(), 'pr-ro-')), 'f');
  writeFileSync(file, 'x'); // 状态目录放在一个文件下面：哪个系统上都建不出来
  const port = 20000 + Math.floor(Math.random() * 20000);
  const p = spawn(process.execPath, [join(root, 'bridge', 'server.js'), '--stdio', '--port', String(port)], { env: { ...process.env, PR_BRIDGE_DIR: join(file, 'state'), PR_AUTO_UPDATE: '0' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { err += d; });
  let exit = null;
  p.on('exit', (c) => { exit = c; });
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }) + '\n');
  for (let i = 0; i < 200 && !out.includes('"id":1') && exit === null; i++) await new Promise((r) => setTimeout(r, 50));
  p.kill();
  assert.equal(exit, null, '进程退出了：' + err);
  assert.match(out, /"id":1/, err);
  assert.match(err, /后台桥接起不来/);
});

test('按键表：回放引擎（runtime.js）和后台（background.js）两份 SHIFT_KEYS、按键码表内容一样（runtime.js 注入页面跑，不能共用一份）', () => {
  const bgSrc = readFileSync(join(root, 'background.js'), 'utf8');
  // 取出对象字面量，在空环境里求值成对象再比，不比源码文本（换行、引号写法不同不算不一样）
  const take = (src, name) => {
    const m = src.match(new RegExp(`const ${name} = (\\{[\\s\\S]*?\\});\\n`));
    assert.ok(m, `${name} 没找到`);
    return vm.runInNewContext(`(${m[1]})`);
  };
  const plain = (x) => JSON.parse(JSON.stringify(x));
  assert.deepEqual(plain(take(runtimeSrc, 'SHIFT_KEYS')), plain(take(bgSrc, 'SHIFT_KEYS')));
  // 后台的 KEY_DEFS = 回放引擎的 KEY_CODES（特殊键，code 就是键名，空格是 Space）+ PUNCT_KEYS（标点）
  const codes = take(runtimeSrc, 'KEY_CODES');
  const punct = take(runtimeSrc, 'PUNCT_KEYS');
  const fromRuntime = {};
  for (const [k, c] of Object.entries(codes)) fromRuntime[k] = [c, k === ' ' ? 'Space' : k];
  for (const [k, v] of Object.entries(punct)) fromRuntime[k] = [v[0], v[1]];
  const fromBg = Object.fromEntries(Object.entries(take(bgSrc, 'KEY_DEFS')).map(([k, v]) => [k, [v[0], v[1]]]));
  assert.deepEqual(plain(fromRuntime), plain(fromBg));
});
