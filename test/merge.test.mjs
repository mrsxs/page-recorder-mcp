// 几条录制按 AI 排好的顺序接成一条新脚本：顺序、截取步骤、事件 id、接口说明
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const PR_EXPORTER = createRequire(import.meta.url)('../lib/exporter.js');
const tgt = (sel, label, tag = 'input') => ({ selectors: [sel], tag, kind: tag === 'button' ? '按钮' : '输入框', label, desc: `${tag === 'button' ? '按钮' : '输入框'} "${label}"`, ctx: { label } });
const step = (id, ts, o) => Object.assign({ kind: 'step', id, ts }, o);
const req = (id, ts, method, url, body) => ({
  kind: 'request', id, ts, endTs: ts + 30, via: 'fetch', method, url, pageUrl: url,
  requestHeaders: {}, requestBody: body ? { type: 'json', value: body } : null,
  status: 200, responseHeaders: { 'content-type': 'application/json' }, responseBody: { type: 'json', value: { code: 0, list: [] } },
});

// A：搜索商品，录得晚；最后一步是“选择城市”这种带成员的语义步骤
function recA() {
  const home = 'https://shop.test/';
  return {
    name: '搜索商品',
    state: { id: 'A', startUrl: home, title: '商城' },
    events: [
      step('a0', 5000, { type: 'navigate', url: home }),
      step('a1', 5100, { type: 'fill', url: home, target: tgt('#q', '关键词'), value: 'phone' }),
      step('a2', 5200, { type: 'click', url: home, target: tgt('#go', '查询', 'button') }),
      req('ar1', 5250, 'GET', 'https://shop.test/api/search?q=phone'),
      step('m1', 5300, { type: 'click', url: home, target: tgt('#city', '城市'), groupedIn: 'g1' }),
      step('m2', 5340, { type: 'click', url: home, target: tgt('li.sh', '上海', 'li'), groupedIn: 'g1' }),
      step('g1', 5300, { type: 'select', url: home, commitTs: 5340, sid: 5300, target: tgt('#city', '城市'), value: '上海', members: ['m1', 'm2'], via: 'program' }),
    ],
    apiOverrides: {},
    aiDocs: {},
  };
}
// B：登录后导出订单，录得早
function recB() {
  const login = 'https://shop.test/login';
  const orders = 'https://shop.test/orders';
  return {
    name: '导出订单',
    state: { id: 'B', startUrl: login, title: '登录' },
    events: [
      step('b0', 1000, { type: 'navigate', url: login }),
      step('b1', 1100, { type: 'fill', url: login, target: tgt('#user', '账号'), value: 'tom' }),
      step('b2', 1200, { type: 'click', url: login, target: tgt('#login', '登录', 'button') }),
      req('br1', 1250, 'POST', 'https://shop.test/api/login', { user: 'tom' }),
      step('b3', 1300, { type: 'navigate', url: orders }),
      step('b4', 1400, { type: 'click', url: orders, target: tgt('#export', '导出', 'button') }),
      req('br2', 1450, 'GET', 'https://shop.test/api/orders/export'),
    ],
    apiOverrides: {},
    aiDocs: {},
  };
}
const analyzeOf = (m) => PR_EXPORTER.analyze(m.events, {}, m.state, m.apiOverrides, m.aiDocs);
const apisOf = (s) => s.requests.map((r) => r.api).join(' ');

test('按给定顺序接起来，不按录制时间；后一段从自己的起始页开始，原脚本不被改动', () => {
  const a = recA();
  const b = recB();
  const before = JSON.stringify([a, b]);
  const m = PR_EXPORTER.mergeRecordings([{ item: a }, { item: b }], { id: 'M1', name: '搜索后导出' });
  assert.equal(JSON.stringify([a, b]), before);
  const A = analyzeOf(m);
  assert.deepEqual(A.steps.map((s) => s.type), ['navigate', 'fill', 'click', 'select', 'navigate', 'fill', 'click', 'navigate', 'click']);
  assert.equal(A.steps[4].url, 'https://shop.test/login');
  assert.equal(m.state.startUrl, 'https://shop.test/');
  assert.equal(m.state.id, 'M1');
  assert.equal(m.state.name, '搜索后导出');
  assert.match(apisOf(A.steps[2]), /\/api\/search/);
  assert.match(apisOf(A.steps[6]), /\/api\/login/);
  assert.match(apisOf(A.steps[8]), /\/api\/orders\/export/);
  // 两段之间隔得够开：前一段最后一步不会去等后一段的接口
  assert.deepEqual(A.steps[3].requests, []);
});

test('同一条脚本用两次：事件 id 不重复，语义步骤的成员跟着改，不会散成单独的点击', () => {
  const m = PR_EXPORTER.mergeRecordings([{ item: recA() }, { item: recA() }], { id: 'M2' });
  const ids = m.events.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const e of m.events) {
    if (e.groupedIn) assert.ok(m.events.some((g) => g.id === e.groupedIn && g.members.includes(e.id)), e.id);
  }
  const A = analyzeOf(m);
  assert.deepEqual(A.steps.map((s) => s.type), ['navigate', 'fill', 'click', 'select', 'navigate', 'fill', 'click', 'select']);
  // 日期区间这类按 sid 配对的步骤：两段的 sid 不能撞
  const sids = m.events.filter((e) => e.sid != null).map((e) => e.sid);
  assert.equal(new Set(sids).size, sids.length);
  assert.equal(m.state.name, '搜索商品 + 搜索商品');
});

test('按步骤号截取：去掉的步骤和它们触发的接口都不带上；不是从打开页面开始的段补一步打开它所在的页面', () => {
  const m = PR_EXPORTER.mergeRecordings([{ item: recA() }, { item: recB(), from: 5 }], { id: 'M3' });
  const A = analyzeOf(m);
  assert.deepEqual(A.steps.map((s) => s.type), ['navigate', 'fill', 'click', 'select', 'navigate', 'click']);
  assert.equal(A.steps[4].url, 'https://shop.test/orders');
  assert.match(apisOf(A.steps[5]), /\/api\/orders\/export/);
  assert.ok(!m.events.some((e) => /\/api\/login/.test(e.url || '')));
  assert.ok(!('账号' in A.params));

  // 第一段就截取：起始页面是截取后第一步所在的页面
  const head = PR_EXPORTER.mergeRecordings([{ item: recB(), from: 4, to: 5 }], { id: 'M4' });
  assert.equal(head.state.startUrl, 'https://shop.test/orders');
  assert.deepEqual(analyzeOf(head).steps.map((s) => s.type), ['navigate', 'click']);
  const tail = PR_EXPORTER.mergeRecordings([{ item: recA(), to: 2 }], { id: 'M5' });
  assert.deepEqual(analyzeOf(tail).steps.map((s) => s.type), ['navigate', 'fill']);
  assert.ok(!tail.events.some((e) => e.kind === 'request'));
});

test('第二段起开头的“打开页面”回放时直接打开，不先等上一步自己跳过去；第一段和段中间的跳转照旧', () => {
  for (const parts of [[{ item: recA() }, { item: recB() }], [{ item: recA() }, { item: recB(), from: 5 }]]) {
    const m = PR_EXPORTER.mergeRecordings(parts, { id: 'J' });
    const steps = PR_EXPORTER.build(m.events, {}, m.state, m.apiOverrides, m.aiDocs).bundle.recording.steps;
    const navs = steps.map((s, i) => [i + 1, s.type, !!s.jump]).filter(([, t]) => t === 'navigate');
    assert.deepEqual(navs, parts[1].from ? [[1, 'navigate', false], [5, 'navigate', true]] : [[1, 'navigate', false], [5, 'navigate', true], [8, 'navigate', false]]);
  }
});

test('步骤范围不对时报错，说清楚这一段有几步', () => {
  for (const r of [{ from: 0 }, { from: 3, to: 2 }, { to: 99 }, { from: 1.5 }]) {
    assert.throws(() => PR_EXPORTER.mergeRecordings([{ item: recA() }, Object.assign({ item: recB() }, r)], { id: 'X' }), /第 2 段「导出订单」只有 5 步/, JSON.stringify(r));
  }
  assert.throws(() => PR_EXPORTER.mergeRecordings([], { id: 'X' }), /至少/);
});

test('接口说明和手改的接口字段按接口合并：同一处冲突时前面的段优先；脚本名、slug 不沿用', () => {
  const a = Object.assign(recA(), {
    aiDocs: { title: '搜索', slug: 'search', description: 'A', apis: { 'GET /api/search': { fn: 'searchGoods', description: 'A 说明' } } },
    apiOverrides: { 'GET /api/search': { query: { q: 'x' } } },
  });
  const b = Object.assign(recB(), {
    aiDocs: { apis: { 'GET /api/search': { fn: 'other', title: 'B 标题' }, 'GET /api/orders/export': { fn: 'exportOrders' } } },
    apiOverrides: { 'GET /api/search': { query: { q: 'y', page: '2' } }, 'GET /api/orders/export': { body: { all: true } } },
  });
  const m = PR_EXPORTER.mergeRecordings([{ item: a }, { item: b }], { id: 'M6', description: '先搜再导出' });
  assert.deepEqual(m.aiDocs.apis['GET /api/search'], { fn: 'searchGoods', description: 'A 说明', title: 'B 标题' });
  assert.deepEqual(m.aiDocs.apis['GET /api/orders/export'], { fn: 'exportOrders' });
  assert.equal(m.aiDocs.title, undefined);
  assert.equal(m.aiDocs.slug, undefined);
  assert.deepEqual(m.apiOverrides, { 'GET /api/search': { query: { q: 'x', page: '2' } }, 'GET /api/orders/export': { body: { all: true } } });
  assert.equal(m.state.description, '先搜再导出');
});

test('后一段在别的站点：接口改了名（带主机名），这一段的说明和手改字段跟着改名，不会挂到前一段的同名接口上', () => {
  const b = recB();
  b.state.startUrl = 'https://b.test/login';
  b.events = b.events.map((e) => (e.url ? { ...e, url: e.url.replace('shop.test', 'b.test'), pageUrl: e.pageUrl && e.pageUrl.replace('shop.test', 'b.test') } : e));
  b.aiDocs = { apis: { 'GET /api/orders/export': { fn: 'exportOrders', description: 'B 的导出' } } };
  b.apiOverrides = { 'GET /api/orders/export': { query: { all: '1' } } };
  assert.ok(PR_EXPORTER.analyze(b.events, {}, b.state).apis.some((a) => a.name === 'GET /api/orders/export'));
  const m = PR_EXPORTER.mergeRecordings([{ item: recA() }, { item: b }], { id: 'H' });
  assert.deepEqual(Object.keys(m.aiDocs.apis), ['GET b.test/api/orders/export']);
  assert.deepEqual(Object.keys(m.apiOverrides), ['GET b.test/api/orders/export']);
  const api = analyzeOf(m).apis.find((a) => a.name === 'GET b.test/api/orders/export');
  assert.equal(api.fn, 'exportOrders');
  assert.equal(api.editParams.query.all, '1');
});

test('同一条带密码的脚本用两次：两段各对应自己的密码参数', () => {
  const login = () => {
    const url = 'https://shop.test/login';
    return {
      name: '登录', state: { id: 'L', startUrl: url },
      events: [
        step('n', 1000, { type: 'navigate', url }),
        step('pw', 1100, { type: 'fill', url, target: tgt('#pw', '密码'), value: '', sensitive: true, secretId: 'pwid' }),
        step('go', 1200, { type: 'click', url, target: tgt('#go', '登录', 'button') }),
        req('r', 1250, 'POST', 'https://shop.test/api/login', { pwd: '__PR_SECRET_pwid__' }),
      ],
      apiOverrides: {}, aiDocs: {},
    };
  };
  const m = PR_EXPORTER.mergeRecordings([{ item: login() }, { item: login() }], { id: 'S' });
  const bodies = m.events.filter((e) => e.kind === 'request').map((e) => e.requestBody.value.pwd);
  const ids = m.events.filter((e) => e.secretId).map((e) => e.secretId);
  assert.deepEqual(bodies, ['__PR_SECRET_pwid__', '__PR_SECRET_pwidp2__']);
  assert.deepEqual(ids, ['pwid', 'pwidp2']);
  assert.equal(Object.keys(analyzeOf(m).params).length, 2);
});

test('段开头在 iframe 里：补的“打开页面”打开它外面的页面；第一段整条用时不补，步骤号和原脚本一样', () => {
  const page = 'https://shop.test/pay';
  const framed = {
    name: '支付', state: { id: 'F', startUrl: page },
    events: [
      step('c1', 1000, { type: 'click', url: page, target: tgt('#open', '去支付', 'button') }),
      step('f1', 1100, { type: 'fill', url: 'https://pay.test/frame', frame: { url: 'https://pay.test/frame' }, target: tgt('#card', '卡号'), value: '4242' }),
      step('c2', 1200, { type: 'click', url: page, target: tgt('#ok', '确认', 'button') }),
    ],
    apiOverrides: {}, aiDocs: {},
  };
  const m = PR_EXPORTER.mergeRecordings([{ item: recA() }, { item: framed, from: 2 }], { id: 'F' });
  const steps = analyzeOf(m).steps;
  assert.deepEqual(steps.slice(4).map((s) => [s.type, s.url, !!s.frame]), [['navigate', page, false], ['fill', 'https://pay.test/frame', true], ['click', page, false]]);
  // 原脚本开头没有“打开页面”：整条当第一段时不补，第 2 步还是第 2 步
  const alone = PR_EXPORTER.mergeRecordings([{ item: framed }], { id: 'F2' });
  assert.deepEqual(analyzeOf(alone).steps.map((s) => s.type), ['click', 'fill', 'click']);
  assert.equal(alone.state.startUrl, page);
});

test('截到“打开页面”前一步：被它替掉的“地址变了”不留在末尾', () => {
  const home = 'https://shop.test/';
  const next = 'https://shop.test/list';
  const rec = {
    name: '翻页', state: { id: 'U', startUrl: home },
    events: [
      step('n', 1000, { type: 'navigate', url: home }),
      step('c', 1100, { type: 'click', url: home, target: tgt('#more', '更多', 'button') }),
      step('u', 1300, { type: 'url', url: next }),
      step('n2', 1400, { type: 'navigate', url: next }),
    ],
    apiOverrides: {}, aiDocs: {},
  };
  assert.deepEqual(analyzeOf({ ...rec, state: rec.state }).steps.map((s) => s.type), ['navigate', 'click', 'navigate']);
  const m = PR_EXPORTER.mergeRecordings([{ item: rec, to: 2 }], { id: 'U' });
  assert.deepEqual(analyzeOf(m).steps.map((s) => s.type), ['navigate', 'click']);
  assert.ok(!m.events.some((e) => e.type === 'url'));
});

test('接口说明里前一段是空的、参数说明只写了一部分：后一段补上', () => {
  const a = Object.assign(recA(), { aiDocs: { apis: { 'GET /api/search': { description: '', params: { 'query.q': '关键词' } } } } });
  const b = Object.assign(recB(), { aiDocs: { apis: { 'GET /api/search': { description: '搜商品', params: { 'query.page': '页码', 'query.q': '别的说法' } } } } });
  const m = PR_EXPORTER.mergeRecordings([{ item: a }, { item: b }], { id: 'D' });
  assert.deepEqual(m.aiDocs.apis['GET /api/search'], { description: '搜商品', params: { 'query.q': '关键词', 'query.page': '页码' } });
});
