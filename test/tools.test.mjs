// 脚本库大时：不把每个接口都列成工具，用 search_apis 找接口；list_recordings 不超长
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import net from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const server = join(dirname(fileURLToPath(import.meta.url)), '..', 'bridge', 'server.js');
process.env.PR_BRIDGE_DIR = mkdtempSync(join(tmpdir(), 'pr-state-'));

const DOMAINS = [['order', '订单'], ['product', '商品'], ['refund', '退款'], ['coupon', '优惠券']];
const VERBS = [['list', '列表'], ['detail', '详情'], ['export', '导出报表'], ['stats', '统计'], ['update', '修改']];
// nRec 条脚本，每条 5 个接口
function library(nRec) {
  return Array.from({ length: nRec }, (_, r) => {
    const [dom, domCn] = DOMAINS[r % DOMAINS.length];
    return {
      id: `rec${r}`, name: `${domCn}管理 ${r}`, slug: `${dom}_${r}`, description: `在${domCn}后台查询、导出`, startUrl: `https://${dom}${r}.example.test/admin`,
      steps: ['1. 打开页面', '2. 输入 {{关键词}}', '3. 点击 查询'], params: { 关键词: 'a' },
      paramInfo: { 关键词: { kind: 'text', recorded: 'a', linkedTo: [`GET /api/${dom}/list query.keyword`] } },
      tools: VERBS.map(([verb, verbCn]) => ({
        name: `${verb}${dom[0].toUpperCase()}${dom.slice(1)}`, api: `GET /api/${dom}/${verb}`,
        description: `${domCn}${verbCn}。按关键词分页查询${domCn}的${verbCn}数据。返回：data.list 是记录数组`,
        inputSchema: { type: 'object', properties: {
          keyword: { type: 'string', description: '搜索关键词；Query 参数 keyword；录制值: "{{关键词}}"' },
          page: { type: 'string', description: '页码，从 1 开始；Query 参数 page；录制值: "1"' },
          warehouseId: { type: 'string', description: `仓库编号；Query 参数 warehouseId；录制值: "${r}"` },
        }, additionalProperties: true },
      })),
    };
  });
}
function frame(text) { // 客户端帧必须带掩码
  const payload = Buffer.from(text);
  const mask = crypto.randomBytes(4);
  let head;
  if (payload.length < 126) head = Buffer.from([0x81, 0x80 | payload.length]);
  else if (payload.length < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 0x80 | 126; head.writeUInt16BE(payload.length, 2); } else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(payload.length), 2); }
  return Buffer.concat([head, mask, Buffer.from(payload.map((b, i) => b ^ mask[i % 4]))]);
}
// 假扩展：list 返回脚本库；call 把收到的参数原样回来
// 和 background.js 的 callApi 一样认接口：名字或函数名相同，或名字里包含
function reply(lib, params) {
  const rec = lib.find((r) => r.id === params.recording);
  if (rec && params.api != null && !rec.tools.some((t) => t.api === params.api || t.name === params.api || t.api.includes(params.api))) return { ok: false, error: '没有接口 ' + params.api };
  return { ok: true, got: params };
}
function fakeExt(port, lib, instanceId = 'test1') {
  const s = net.connect(port, '127.0.0.1');
  let buf = Buffer.alloc(0);
  let up = false;
  s.write(`GET /ext HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nOrigin: chrome-extension://abcdef\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  s.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    if (!up) {
      const i = buf.indexOf('\r\n\r\n');
      if (i < 0) return;
      buf = buf.slice(i + 4);
      up = true;
      s.write(frame(JSON.stringify({ type: 'hello', version: 'test', instanceId, profile: 'main' })));
    }
    for (;;) { // 服务端帧不带掩码
      if (buf.length < 2) return;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; } else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (buf.length < off + len) return;
      const m = JSON.parse(buf.slice(off, off + len).toString());
      buf = buf.slice(off + len);
      if (m.type !== 'request') continue;
      s.write(frame(JSON.stringify({ type: 'response', id: m.id, ok: true, data: m.method === 'list' ? lib : reply(lib, m.params) })));
    }
  });
  s.on('error', () => {});
  return s;
}
async function withBridge(lib, args, fn, lib2) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const p = spawn(process.execPath, [server, '--port', String(port), ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
  let ext = null;
  let ext2 = null;
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('启动超时')), 10000);
      p.stderr.on('data', (d) => { if (String(d).includes('已启动')) { clearTimeout(t); resolve(); } });
      p.on('exit', (code) => { clearTimeout(t); reject(new Error('进程退出 ' + code)); });
    });
    ext = fakeExt(port, lib);
    if (lib2) ext2 = fakeExt(port, lib2, 'test2'); // 第二个浏览器，资料名和第一个一样
    let id = 0;
    const rpc = (method, params) => new Promise((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
        let d = '';
        res.on('data', (c) => { d += c; });
        res.on('end', () => { try { resolve(JSON.parse(d).result); } catch (e) { reject(new Error(d)); } });
      });
      r.on('error', reject);
      r.end(JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }));
    });
    for (let i = 0; i < 60 && !(await (await fetch(`http://127.0.0.1:${port}/api/status`)).json()).extensionConnected; i++) await new Promise((r) => setTimeout(r, 50));
    for (let i = 0; ext2 && i < 60 && JSON.parse((await rpc('tools/call', { name: 'search_apis', arguments: { limit: 1 } })).content[0].text).total < lib.length * 5 + lib2.length * 5; i++) await new Promise((r) => setTimeout(r, 50));
    const tool = async (name, a) => { const r = await rpc('tools/call', { name, arguments: a || {} }); return { text: r.content[0].text, err: !!r.isError }; };
    await fn({ rpc, tool });
  } finally {
    if (ext) ext.destroy();
    if (ext2) ext2.destroy();
    p.kill();
  }
}
const fixed = (tools) => tools.filter((t) => !t.name.includes('__'));

test('脚本库小：每个接口照旧是一个工具，list_recordings 照旧给整份', async () => {
  await withBridge(library(2), [], async ({ rpc, tool }) => {
    const tools = (await rpc('tools/list', {})).tools;
    assert.equal(tools.length - fixed(tools).length, 12); // 2 个 __run + 10 个接口
    assert.ok(tools.some((t) => t.name === 'order_0__listOrder') && tools.some((t) => t.name === 'search_apis'));
    const list = JSON.parse((await tool('list_recordings')).text);
    assert.equal(list.length, 2);
    assert.equal(list[0].tools.length, 5);
    assert.ok(list[0].paramHelp['关键词']);
  });
});

test('脚本库大：只列固定工具；search_apis 找到接口后用 call_api 调用；按名字调用照旧能用', async () => {
  await withBridge(library(60), [], async ({ rpc, tool }) => {
    const tools = (await rpc('tools/list', {})).tools;
    assert.deepEqual(tools, fixed(tools), '300 个接口不该逐个列成工具');
    assert.ok(JSON.stringify(tools).length < 14000, '工具定义 ' + JSON.stringify(tools).length + ' 字符');

    // 英文、中文、连着写的中文都能找到；都匹配的排前面
    let r = JSON.parse((await tool('search_apis', { query: 'refund export' })).text);
    assert.equal(r.total, 15);
    assert.ok(r.apis.every((a) => a.api === 'GET /api/refund/export'));
    assert.deepEqual(r.apis[0].params, ['keyword', 'page', 'warehouseId']);
    assert.match(r.note, /call_api/);
    r = JSON.parse((await tool('search_apis', { query: '退款导出' })).text);
    assert.equal(r.apis[0].fn, 'exportRefund');
    r = JSON.parse((await tool('search_apis', { query: '优惠券 统计', recording: 'rec3' })).text);
    assert.equal(r.total, 1);
    // 结果少时直接带完整参数定义，关联输入参数的录制值换成真实值
    assert.match(r.apis[0].inputSchema.properties.keyword.description, /录制值: "a"（关联输入参数「关键词」/);
    const got = JSON.parse((await tool('call_api', { recording: r.apis[0].recording_id, api: r.apis[0].api, args: { page: '2' } })).text);
    assert.deepEqual(got.got, { recording: 'rec3', api: 'GET /api/coupon/stats', args: { page: '2' } });

    // 分页、长度上限
    r = JSON.parse((await tool('search_apis', { limit: 7 })).text);
    assert.deepEqual([r.total, r.count, r.next_offset], [300, 7, 7]);
    const all = await tool('search_apis', { detail: true, limit: 300 });
    assert.ok(all.text.length <= 24000, '长度 ' + all.text.length);
    r = JSON.parse(all.text);
    assert.ok(r.count > 5 && r.next_offset === r.count);
    r = JSON.parse((await tool('search_apis', { query: 'nothinglikethis' })).text);
    assert.equal(r.total, 0);
    assert.match(r.note, /没有接口匹配/);
    assert.ok((await tool('search_apis', { recording: '没有这个脚本' })).err);

    // 以前列出来过的工具名（客户端可能还留着）照旧能调
    const byName = JSON.parse((await tool('order_0__listOrder', { page: '3' })).text);
    assert.deepEqual(byName.got, { recording: 'rec0', api: 'GET /api/order/list', args: { page: '3' } });
  });
});

test('脚本库大：list_recordings 分页给概要，不超长；query 筛选', async () => {
  await withBridge(library(60), [], async ({ tool }) => {
    const t = (await tool('list_recordings')).text;
    assert.ok(t.length <= 24000, '长度 ' + t.length);
    let r = JSON.parse(t);
    assert.equal(r.total, 60);
    assert.deepEqual(r.recordings[0].apis, ['listOrder', 'detailOrder', 'exportOrder', 'statsOrder', 'updateOrder']);
    assert.deepEqual(r.recordings[0].params, ['关键词']);
    assert.match(r.note, /get_recording/);
    const seen = r.recordings.map((x) => x.id);
    while (r.next_offset != null) {
      r = JSON.parse((await tool('list_recordings', { offset: r.next_offset })).text);
      seen.push(...r.recordings.map((x) => x.id));
    }
    assert.equal(new Set(seen).size, 60);
    // 筛到整份放得下就给整份
    r = JSON.parse((await tool('list_recordings', { query: '退款 6' })).text);
    assert.ok(Array.isArray(r) && r.length && r.every((x) => /退款/.test(x.name) && x.tools.length === 5));
    // 关键词都要有：只有一部分匹配的不算
    assert.deepEqual(JSON.parse((await tool('list_recordings', { query: '退款 nothinglikethis' })).text), []);
  });
});

test('--max-tools：调大后大脚本库照旧逐个列，0 = 总是按需', async () => {
  await withBridge(library(60), ['--max-tools', '1000'], async ({ rpc }) => {
    const tools = (await rpc('tools/list', {})).tools;
    assert.equal(tools.length - fixed(tools).length, 360);
  });
  await withBridge(library(1), ['--max-tools=0'], async ({ rpc }) => {
    const tools = (await rpc('tools/list', {})).tools;
    assert.deepEqual(tools, fixed(tools));
  });
});

test('一个接口的参数定义就超长：search_apis 仍是完整的 JSON，只给参数名', async () => {
  const lib = library(1);
  for (let i = 0; i < 3000; i++) lib[0].tools[0].inputSchema.properties[`filter.field${i}`] = { type: 'string', description: `筛选字段 ${i}；` + '说明'.repeat(4) };
  await withBridge(lib, [], async ({ tool }) => {
    const t = (await tool('search_apis', { query: 'listOrder' })).text;
    assert.ok(t.length <= 24000, '长度 ' + t.length);
    const r = JSON.parse(t);
    assert.deepEqual([r.total, r.count, r.apis[0].fn], [1, 1, 'listOrder']);
    assert.equal(r.apis[0].inputSchema, undefined);
    assert.equal(r.apis[0].params[0], 'keyword');
    assert.match(r.apis[0].params[r.apis[0].params.length - 1], /还有 \d+ 个/);
    assert.match(r.note, /get_recording/);
  });
});

test('两个浏览器资料名一样：search_apis 给的 browser 能原样填回 call_api', async () => {
  const other = library(1).map((x) => Object.assign({}, x, { id: 'other0', name: '另一个店的订单' }));
  await withBridge(library(1), [], async ({ tool }) => {
    const r = JSON.parse((await tool('search_apis', { query: 'listOrder' })).text);
    assert.equal(r.total, 2);
    assert.deepEqual(r.apis.map((a) => a.browser).sort(), ['test1', 'test2']);
    assert.ok(r.apis.every((a) => a.browser_name === 'main'));
    const a = r.apis.find((x) => x.recording_id === 'other0');
    const got = await tool('call_api', { recording: a.recording_id, api: a.api, browser: a.browser });
    assert.ok(!got.err, got.text);
    assert.equal(JSON.parse(got.text).got.recording, 'other0');
  }, other);
});

test('接口名很长：search_apis 给的 api 仍能原样填回 call_api', async () => {
  const lib = library(1);
  lib[0].tools[0].api = 'GET /api/order/list?' + 'x'.repeat(500);
  await withBridge(lib, [], async ({ tool }) => {
    const a = JSON.parse((await tool('search_apis', { query: 'listOrder' })).text).apis[0];
    assert.equal(a.api, 'listOrder');
    assert.ok(a.api_name.startsWith('GET /api/order/list?') && a.api_name.length < 400);
    const got = JSON.parse((await tool('call_api', { recording: a.recording_id, api: a.api })).text);
    assert.equal(got.ok, true);
  });
});

test('merge_recordings：各段原样交给扩展；两个浏览器连着时按第一段的脚本找浏览器，不用指定 browser', async () => {
  const other = library(1).map((x) => Object.assign({}, x, { id: 'other0', name: '另一个店的订单' }));
  await withBridge(library(1), [], async ({ tool, rpc }) => {
    assert.ok((await rpc('tools/list', {})).tools.some((t) => t.name === 'merge_recordings'));
    const parts = [{ recording: 'other0' }, { recording: 'other0', from_step: 3 }];
    let got = await tool('merge_recordings', { parts, name: '合并后' });
    assert.ok(!got.err, got.text);
    let r = JSON.parse(got.text).got;
    assert.equal(r.recording, 'other0');
    assert.deepEqual(r.parts, parts);
    assert.equal(r.name, '合并后');
    // 有的 AI 把数组写成 JSON 字符串
    got = await tool('merge_recordings', { parts: JSON.stringify(parts) });
    assert.ok(!got.err, got.text);
    assert.deepEqual(JSON.parse(got.text).got.parts, parts);
    got = await tool('merge_recordings', { parts: [] });
    assert.ok(got.err);
    assert.match(got.text, /parts 至少给一段/);
  }, other);
});
