// 给 AI 的结果：套着的 JSON 字符串展开、超长时给预览 + result_id、read_result 按路径 / 字段 / 分页取。
// 用假扩展（WebSocket 客户端）顶替浏览器，不碰真实页面。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const server = join(dirname(fileURLToPath(import.meta.url)), '..', 'bridge', 'server.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 一页“商品”：网关式接口的返回，数据整个套在 data.result 这个 JSON 字符串里，每项带一大堆用不上的配置
const item = (i) => ({
  itemId: String(700000000000 + i), title: `商品标题 ${i}`, price: { current: `¥ ${i}.00` }, stock: { text: 1000 + i },
  actions: Array.from({ length: 12 }, (_, k) => ({ name: 'action' + k, uiType: 'link', text: '操作按钮 ' + k, href: `https://example.test/item/edit?id=${i}&step=${k}&from=list&padding=${'p'.repeat(200)}` })),
});
const LIST = { ok: true, status: 200, data: { ret: ['SUCCESS::调用成功'], data: { result: JSON.stringify({ success: true, data: { table: { dataSource: Array.from({ length: 20 }, (_, i) => item(i)) }, pagination: { current: 1, pageSize: 20, total: 417 } } }) } } };
const SMALL = { ok: true, status: 200, data: { code: 0, payload: JSON.stringify({ list: [{ id: 1, name: 'a' }], inner: JSON.stringify({ deep: true }) }) } };
const BIG = { ok: true, data: { rows: Array.from({ length: 200 }, (_, i) => ({ id: i, name: 'n' + i, a: { b: 'x'.repeat(3000) } })) } };
const WIDE = Object.assign(Object.fromEntries(Array.from({ length: 100 }, (_, i) => ['a_rather_long_field_name_number_' + i, 'v'.repeat(1000)])), { ok: false, error: 'permission denied' });
let DEEP = { leaf: 'x'.repeat(30) };
for (let i = 0; i < 4000; i++) DEEP = { c: DEEP };
const TEXTY = { ok: true, title: '[1,2]', note: '{"user":"example-user"}', payload: JSON.stringify({ a: 1, b: [1, 2, 3], big: 'y'.repeat(40) }), 'line\nkey': { v: 'z'.repeat(5000) } };
const LONGKEYS = Object.fromEntries(Array.from({ length: 40 }, (_, i) => ['k'.repeat(100) + i, 'v'.repeat(300)]));
const STRROWS = { rows: Array.from({ length: 5 }, (_, i) => JSON.stringify({ id: i, name: 'row' + i, pad: 'p'.repeat(40) })) };
const HUGE = { ok: true, rows: Array.from({ length: 2200 }, (_, i) => ({ id: i, pad: 'h'.repeat(1000) })) }; // 2MB 多
const SHORTROWS = { rows: ['{"id":1}', '{"id":2}'] };
// 很深的 JSON 字符串（展开时会出错走兜底）+ 一大堆引号和反斜杠
let nest = '{"leaf":"' + '\\"'.repeat(50) + '"}';
const QUOTES = { toJSON: null, text: '"\\'.repeat(3000), deep: '{"c":'.repeat(20000) + '1' + '}'.repeat(20000), nest };
const HUGEDEEP = { ok: true, pad: 'h'.repeat(1200000), deep: '{"c":'.repeat(20000) + '1' + '}'.repeat(20000) };
const KINDS = { LIST, SMALL, BIG, WIDE, DEEP, TEXTY, LONGKEYS, STRROWS, HUGE, SHORTROWS, QUOTES, HUGEDEEP };
const LIB = [{
  id: 'rec1', name: '商品列表', params: {}, steps: [],
  tools: [
    { name: 'list', api: 'POST /gateway #url=/table', description: '商品列表', inputSchema: { type: 'object', properties: { kind: { type: 'string' } } } },
    { name: 'own', api: 'POST /own', description: '自己有 result_limit 字段的接口', inputSchema: { type: 'object', properties: { result_limit: { type: 'number', description: '业务字段：每页条数' }, kind: { type: 'string' } } } },
  ],
}];

function frame(text) { // 客户端帧必须带掩码
  const payload = Buffer.from(text);
  const mask = crypto.randomBytes(4);
  let head;
  if (payload.length < 126) head = Buffer.from([0x81, 0x80 | payload.length]);
  else if (payload.length < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 0x80 | 126; head.writeUInt16BE(payload.length, 2); } else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(payload.length), 2); }
  return Buffer.concat([head, mask, Buffer.from(payload.map((b, i) => b ^ mask[i % 4]))]);
}
// 假扩展：list 返回脚本库；run / call 按参数里的 kind 返回上面的某个结果
function fakeExt(port) {
  const s = net.connect(port, '127.0.0.1');
  const st = { calls: 0, last: null, socket: s };
  let buf = Buffer.alloc(0);
  let up = false;
  s.write(`GET /ext HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nOrigin: chrome-extension://abcdef\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  const reply = (id, data) => s.write(frame(JSON.stringify({ type: 'response', id, ok: true, data })));
  s.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    if (!up) {
      const i = buf.indexOf('\r\n\r\n');
      if (i < 0) return;
      buf = buf.slice(i + 4);
      up = true;
      s.write(frame(JSON.stringify({ type: 'hello', version: 'test', instanceId: 'test1', profile: 'main' })));
    }
    for (;;) { // 服务端帧不带掩码
      if (buf.length < 2) return;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; } else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (buf.length < off + len) return;
      const text = buf.slice(off, off + len).toString();
      buf = buf.slice(off + len);
      let m;
      try { m = JSON.parse(text); } catch (e) { continue; }
      if (m.type !== 'request') continue;
      if (m.method === 'list') { reply(m.id, LIB); continue; }
      st.calls++;
      st.last = m.params;
      const a = m.params.args || m.params.params || {};
      reply(m.id, KINDS[a.kind] || LIST);
    }
  });
  s.on('error', () => {});
  return st;
}

async function withBridge(fn, env) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const p = spawn(process.execPath, [server, '--port', String(port)], { stdio: ['ignore', 'ignore', 'pipe'], env: Object.assign({}, process.env, env || {}) });
  let ext = null;
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('启动超时')), 10000);
      p.stderr.on('data', (d) => { if (String(d).includes('已启动')) { clearTimeout(t); resolve(); } });
      p.on('exit', (code) => { clearTimeout(t); reject(new Error('进程退出 ' + code)); });
    });
    ext = fakeExt(port);
    let id = 0;
    const rpc = (method, params) => new Promise((resolve, reject) => {
      const data = JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params });
      const r = http.request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
        let d = '';
        res.on('data', (c) => { d += c; });
        res.on('end', () => { try { resolve(JSON.parse(d).result); } catch (e) { reject(new Error(d)); } });
      });
      r.on('error', reject);
      r.end(data);
    });
    for (let i = 0; i < 60; i++) {
      const tools = (await rpc('tools/list', {})).tools;
      if (tools.some((t) => /__list$/.test(t.name))) break;
      await sleep(100);
    }
    const tool = async (name, args) => { const r = await rpc('tools/call', { name, arguments: args }); return { text: r.content[0].text, err: !!r.isError }; };
    const call = (kind, extra) => tool('call_api', Object.assign({ recording: 'rec1', api: 'list', args: { kind } }, extra || {}));
    await fn({ rpc, tool, call, ext });
  } finally {
    if (ext) ext.socket.destroy();
    p.kill();
  }
}

test('小结果整段返回，套着的 JSON 字符串展开并标出位置', async () => {
  await withBridge(async ({ call }) => {
    const o = JSON.parse((await call('SMALL')).text);
    assert.equal(o.data.payload.list[0].name, 'a');
    assert.equal(o.data.payload.inner.deep, true);
    assert.deepEqual(o._decoded_json_strings.sort(), ['data.payload', 'data.payload.inner']);
  });
});

test('大结果：预览不超长、看得到数据在哪；read_result 按路径和字段取，不再调接口', async () => {
  await withBridge(async ({ call, tool, ext }) => {
    const r = await call('LIST');
    assert.ok(r.text.length <= 24000, '预览长度 ' + r.text.length);
    const o = JSON.parse(r.text);
    assert.ok(o.result_id && /read_result/.test(o.note));
    const ds = o.preview.data.data.result.data.table.dataSource;
    assert.equal(ds[0].itemId, '700000000000');
    assert.match(ds[ds.length - 1], /共 20 项/);
    assert.ok(ds[ds.length - 1].includes('data.data.result.data.table.dataSource'));
    assert.equal(o.preview.data.data.result.data.pagination.total, 417);
    assert.equal(o.preview.ok, true);
    const calls = ext.calls;
    const path = 'data.data.result.data.table.dataSource';
    let x = JSON.parse((await tool('read_result', { result_id: o.result_id, path, fields: ['itemId', 'title', 'price.current', 'stock.text'] })).text);
    assert.equal(x.total, 20);
    assert.equal(x.items.length, 20);
    assert.deepEqual(x.items[3], { itemId: '700000000003', title: '商品标题 3', 'price.current': '¥ 3.00', 'stock.text': 1003 });
    x = JSON.parse((await tool('read_result', { result_id: o.result_id, path, fields: ['itemId'], offset: 18, limit: 5 })).text);
    assert.deepEqual([x.total, x.offset, x.returned, x.next_offset], [20, 18, 2, undefined]);
    assert.equal(ext.calls, calls, 'read_result 没有再调接口');
    x = await tool('read_result', { result_id: o.result_id, path: 'data.data.result.data.list' });
    assert.ok(x.err && /能走到 data\.data\.result\.data/.test(x.text) && /table/.test(x.text), x.text);
    x = await tool('read_result', { result_id: 'nope' });
    assert.ok(x.err && /已经不在了/.test(x.text));
  });
});

test('调用时直接只要一部分；取一部分时结果也留着；路径写错不用重新调接口', async () => {
  await withBridge(async ({ call, tool, ext }) => {
    let o = JSON.parse((await call('BIG', { result_path: 'data.rows', result_fields: ['id', 'name'], result_limit: 20 })).text);
    assert.ok(o.result_id && o.next_offset === 20 && o.items.length === 20);
    const next = JSON.parse((await tool('read_result', { result_id: o.result_id, path: 'data.rows', fields: ['id'], offset: o.next_offset, limit: 3 })).text);
    assert.deepEqual(next.items.map((i) => i.id), [20, 21, 22]);
    const r = await call('BIG', { result_path: 'data.list' });
    o = JSON.parse(r.text);
    assert.ok(!r.err && o.result_id && /路径 data\.list 不存在/.test(o.error) && /不要重新调用/.test(o.note) && o.preview.ok === true);
    const again = JSON.parse((await tool('read_result', { result_id: o.result_id, path: 'data.rows', fields: ['name'], limit: 2 })).text);
    assert.equal(again.items[1].name, 'n1');
    assert.equal(ext.calls, 2);
  });
});

test('长度上限是硬的；宽对象里说明成败的字段留着；很深的结构不报错', async () => {
  await withBridge(async ({ call }) => {
    for (const limit of [200, 50]) {
      const t = (await call('BIG', { result_path: 'data.rows', result_limit: limit, result_max_chars: 2000 })).text;
      assert.ok(t.length <= 2000, `${limit} 项、上限 2000 时 ${t.length}`);
      const o = JSON.parse(t);
      assert.ok(o.returned >= 1 && o.next_offset === o.returned && o.total === 200);
    }
    let r = await call('WIDE');
    assert.ok(r.text.length <= 24000, '宽对象 ' + r.text.length);
    const w = JSON.parse(r.text);
    assert.equal(w.preview.ok, false);
    assert.equal(w.preview.error, 'permission denied');
    r = await call('LIST', { result_max_chars: 6000 });
    assert.ok(r.text.length <= 6000);
    assert.ok(JSON.parse(r.text).preview.data.data.result.data.table.dataSource.length >= 2);
    r = await call('DEEP');
    assert.ok(!r.err && r.text.length <= 24000 && JSON.parse(r.text).result_id, r.text.slice(0, 200));
  });
});

test('接口自己有同名字段时归接口；结果参数不会发给接口', async () => {
  await withBridge(async ({ rpc, tool, ext }) => {
    const tools = (await rpc('tools/list', {})).tools;
    const own = tools.find((t) => /__own$/.test(t.name));
    const list = tools.find((t) => /__list$/.test(t.name));
    assert.equal(own.inputSchema.properties.result_limit.description, '业务字段：每页条数');
    assert.ok(list.inputSchema.properties.result_path && tools.find((t) => t.name === 'read_result'));
    let r = await tool(own.name, { kind: 'SMALL', result_limit: 123, result_path: 'data.payload.list' });
    assert.deepEqual(ext.last.args, { kind: 'SMALL', result_limit: 123 });
    assert.equal(JSON.parse(r.text).items[0].name, 'a');
    r = await tool(list.name, { kind: 'LIST', result_path: 'data.data.result.data.pagination', result_limit: 5 });
    assert.deepEqual(ext.last.args, { kind: 'LIST' });
    assert.equal(JSON.parse(r.text).value.total, 417);
  });
});

test('展开过的位置能读原文；短的像 JSON 的文字不动；特殊键名和投影字段的路径读得回来', async () => {
  await withBridge(async ({ call, tool }) => {
    let o = JSON.parse((await call('TEXTY')).text);
    assert.equal(o.title, '[1,2]');
    assert.deepEqual(o.note, { user: 'example-user' });
    assert.deepEqual(o._decoded_json_strings.sort(), ['note', 'payload']);
    o = JSON.parse((await call('TEXTY', { result_path: 'payload' })).text);
    let x = JSON.parse((await tool('read_result', { result_id: o.result_id, path: 'note', raw: true })).text);
    assert.equal(x.value, '{"user":"example-user"}');
    x = JSON.parse((await tool('read_result', { result_id: o.result_id, path: 'payload.b', raw: true })).text);
    assert.deepEqual(x.items, [1, 2, 3]);
    x = await tool('read_result', { result_id: o.result_id, path: '["line\\nkey"].v' });
    assert.ok(!x.err && JSON.parse(x.text).value.length === 5000);
    const t = (await call('BIG', { result_path: 'data.rows', result_fields: ['a.b', 'id'], result_limit: 3, result_max_chars: 2000 })).text;
    assert.match(t, /read_result path=\\"data\.rows\[0\]\.a\.b\\"/);
    x = JSON.parse((await tool('read_result', { result_id: JSON.parse(t).result_id, path: 'data.rows[0].a.b', max_chars: 4000 })).text);
    assert.equal(x.value.length, 3000);
  });
});

test('一句话摘要也不超上限；小结果展开后能按编号读原文；读原文时字段投影照样生效', async () => {
  await withBridge(async ({ call, tool }) => {
    // 字段名很长的对象 + 写错的路径：错误信息里会列字段名，整体仍然不超上限
    let r = await call('LONGKEYS', { result_path: 'missing', result_max_chars: 2000 });
    assert.ok(r.text.length <= 2000, '错误路径时 ' + r.text.length);
    assert.ok(JSON.parse(r.text).result_id);
    r = await call('LONGKEYS', { result_path: 'x'.repeat(5000), result_max_chars: 2000 });
    assert.ok(r.text.length <= 2000, '超长路径时 ' + r.text.length);
    // 小结果里有展开过的 JSON 字符串：带 _result_id，raw=true 读得回原文
    const o = JSON.parse((await call('SMALL')).text);
    assert.ok(o._result_id);
    let x = JSON.parse((await tool('read_result', { result_id: o._result_id, path: 'data.payload', raw: true })).text);
    assert.equal(typeof x.value, 'string');
    assert.equal(JSON.parse(x.value).list[0].name, 'a');
    // 每一项本身是 JSON 字符串：原样读（raw）时 fields 也要生效
    r = await call('STRROWS', { result_path: 'rows[0]' });
    const id = JSON.parse(r.text).result_id;
    x = JSON.parse((await tool('read_result', { result_id: id, path: 'rows', fields: ['id', 'name'], raw: true })).text);
    assert.deepEqual(x.items[2], { id: 2, name: 'row2' });
    x = JSON.parse((await tool('read_result', { result_id: id, path: 'rows', raw: true, limit: 1 })).text);
    assert.equal(typeof x.items[0], 'string');
    // 很短的 JSON 字符串不会自动展开，但显式取字段、按路径往里走都取得到
    r = await call('SHORTROWS', { result_path: 'rows', result_fields: ['id'] });
    assert.deepEqual(JSON.parse(r.text).items, [{ id: 1 }, { id: 2 }]);
    const sid = JSON.parse(r.text).result_id;
    x = JSON.parse((await tool('read_result', { result_id: sid, path: 'rows', fields: ['id'], raw: true })).text);
    assert.deepEqual(x.items, [{ id: 1 }, { id: 2 }]);
    x = JSON.parse((await tool('read_result', { result_id: sid, path: 'rows[1].id' })).text);
    assert.equal(x.value, 2);
    x = JSON.parse((await tool('read_result', { result_id: sid, path: 'rows' })).text);
    assert.deepEqual(x.items, ['{"id":1}', '{"id":2}']);
    // 整理结果出错时的兜底也不超上限（内容里全是引号、反斜杠，序列化后会变长）
    r = await call('QUOTES', { result_max_chars: 2000 });
    assert.ok(r.text.length <= 2000 && !r.err, '兜底 ' + r.text.length);
    assert.ok(JSON.parse(r.text).raw_head && JSON.parse(r.text).result_id, '走的是出错兜底：' + r.text.slice(0, 200));
  });
});

test('一条结果就超过缓存总量上限：不留存，提示调用时直接取需要的部分', async () => {
  await withBridge(async ({ call, tool }) => {
    let r = await call('HUGE');
    assert.ok(r.text.length <= 24000);
    let o = JSON.parse(r.text);
    assert.equal(o.result_id, undefined);
    assert.match(o.note, /留不下/);
    assert.equal(o.preview.ok, true);
    r = await call('HUGE', { result_path: 'rows', result_fields: ['id'], result_offset: 2000, result_limit: 3 });
    o = JSON.parse(r.text);
    assert.deepEqual(o.items.map((i) => i.id), [2000, 2001, 2002]);
    assert.equal(o.result_id, undefined);
    assert.equal(o.next_offset, 2003);
    assert.match(o.not_kept, /不能用 read_result/);
    r = await call('HUGE', { result_path: 'nope' });
    o = JSON.parse(r.text);
    assert.ok(o.result_id === undefined && /路径 nope 不存在/.test(o.error) && /留不下/.test(o.note) && r.text.length <= 24000);
    // 留不下、整理又出错（结构太深）：兜底里也说明留不下
    r = await call('HUGEDEEP', { result_path: 'nope', result_max_chars: 2000 });
    o = JSON.parse(r.text);
    assert.ok(!r.err && r.text.length <= 2000 && o.result_id === undefined && /留不下/.test(o.note), r.text.slice(0, 300));
    // 留得下的结果照常留
    o = JSON.parse((await call('LIST')).text);
    assert.ok(o.result_id);
    assert.ok(!(await tool('read_result', { result_id: o.result_id, path: 'ok' })).err);
  }, { PR_RESULT_CACHE_MB: '1' });
});
