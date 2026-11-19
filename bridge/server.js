#!/usr/bin/env node
// Page Recorder 本地桥接服务（零依赖，Node 18+）
//
// 让 Claude Code、Accio 等 AI 工具直接调用浏览器扩展里保存的录制脚本：
//   · MCP (stdio)            node server.js --stdio          ← Claude Code / Claude Desktop / Cursor 等
//   · MCP (Streamable HTTP)  http://127.0.0.1:17321/mcp      ← 支持远程 MCP URL 的客户端
//   · REST API               http://127.0.0.1:17321/api/...  ← 任何能发 HTTP 请求的工具
// 扩展通过 ws://127.0.0.1:17321/ext 连接进来，脚本在你自己的浏览器（带登录态）中执行。
'use strict';
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..'); // 扩展本体所在目录（npm 包根目录）
let VERSION = '0.0.0';
try { VERSION = require(path.join(ROOT, 'package.json')).version; } catch (e) { /* 直接从源码目录运行时也能用 */ }

// 命令行参数优先于同名环境变量：--port / --host / --token
const argv = process.argv.slice(2);
function flag(name) {
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
}

if (argv[0] === '--help' || argv[0] === '-h') {
  process.stdout.write(`page-recorder-mcp ${VERSION}

用法：
  page-recorder-mcp                 启动桥接服务（HTTP / REST / MCP Streamable HTTP）
  page-recorder-mcp --stdio         以 MCP stdio 方式运行（给 Claude Code、Accio、Cursor 等用）
  page-recorder-mcp extension [目录] 生成浏览器扩展（默认 ~/page-recorder-extension），
                                    在 Chrome 的 chrome://extensions 里「加载已解压的扩展程序」选这个目录

选项（也可以用环境变量）：
  --port <端口>     监听端口，默认 17321              PR_BRIDGE_PORT
  --host <地址>     监听地址，默认 127.0.0.1          PR_BRIDGE_HOST
  --token <口令>    HTTP 调用需带 Authorization: Bearer <口令>   PR_BRIDGE_TOKEN
改了端口的话，扩展「设置」里的桥接地址也要改成 ws://127.0.0.1:<端口>/ext；
设置了 token 的话，桥接地址要写成 ws://127.0.0.1:<端口>/ext?token=<口令>。监听非本机地址时必须设置 token。
多个浏览器资料（主 Chrome、指纹浏览器等）都装了扩展时可以同时连上，调用时用 browser 参数指定在哪个浏览器执行。
导入录制包（POST /api/packages、import_package 工具经 HTTP 调用）必须设置 token。
`);
  process.exit(0);
}
if (argv[0] === '--version' || argv[0] === '-v') {
  process.stdout.write(VERSION + '\n');
  process.exit(0);
}
if (argv[0] === 'extension') {
  const out = path.resolve(argv[1] || path.join(os.homedir(), 'page-recorder-extension'));
  fs.mkdirSync(out, { recursive: true });
  for (const f of ['manifest.json', 'background.js', 'content', 'inject', 'lib', 'popup', 'icons']) {
    fs.cpSync(path.join(ROOT, f), path.join(out, f), { recursive: true, force: true });
  }
  process.stdout.write(`Page Recorder 扩展 ${VERSION} 已生成到 ${out}
在 Chrome 打开 chrome://extensions → 打开「开发者模式」→「加载已解压的扩展程序」→ 选这个文件夹。
以后升级：再运行一次这个命令，然后在扩展卡片上点「重新加载」。
`);
  process.exit(0);
}

const PORT = Number(flag('port') || process.env.PR_BRIDGE_PORT || 17321);
const HOST = flag('host') || process.env.PR_BRIDGE_HOST || '127.0.0.1';
const TOKEN = flag('token') || process.env.PR_BRIDGE_TOKEN || ''; // 可选：设置后 HTTP 调用需带 Authorization: Bearer <token>
const STDIO = argv.includes('--stdio');
// 不只监听本机时必须设置 token，否则局域网里任何人都能借你的浏览器登录态执行脚本
if (!/^(127\.\d+\.\d+\.\d+|localhost|::1)$/.test(HOST) && !TOKEN) {
  process.stderr.write(`[page-recorder-bridge] 监听 ${HOST} 会暴露给本机以外的设备，必须同时设置 --token（或 PR_BRIDGE_TOKEN）\n`);
  process.exit(2);
}
const log = (...a) => process.stderr.write('[page-recorder-bridge] ' + a.join(' ') + '\n');

// ======================= 与扩展的 WebSocket 连接 =======================
// 每个 Chrome 用户资料里的扩展是一个“实例”，连上后先发 hello 报 instanceId（和资料名 profile）。
// 按 instanceId 各存一条连接：同一个实例重连只替换它自己，多个资料（主 Chrome、指纹浏览器、各店铺）可以同时在线。
const instances = new Map(); // instanceId -> conn
const ANON_ID = 'anonymous'; // 旧版扩展不发 hello：当成一个匿名实例（几个旧版之间仍互相替换，和以前一样）
const HELLO_WAIT_MS = 3000;  // 连上后等 hello 的时间，超时就按匿名实例登记
let seq = 0;
const extWaiters = [];       // 等有实例登记（连上或重连）的回调
const libraryListeners = new Set();

function wsAccept(key) {
  return crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
}
function wsFrame(data, opcode) {
  const payload = Buffer.from(data);
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([head, payload]);
}
function attachWs(socket) {
  let buf = Buffer.alloc(0);
  let fragments = [];
  const conn = {
    socket,
    instanceId: null, // 收到 hello（或等 hello 超时）后才登记
    profile: '',
    version: '',
    pending: new Map(), // 这条连接上还没返回的请求：连接断开或被替换时逐个以错误结束
    dead: false,
    send: (obj) => { if (!socket.destroyed) socket.write(wsFrame(JSON.stringify(obj), 1)); },
  };
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const maskLen = masked ? 4 : 0;
      if (buf.length < off + maskLen + len) return;
      let payload = buf.slice(off + maskLen, off + maskLen + len);
      if (masked) {
        const mask = buf.slice(off, off + 4);
        payload = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]));
      }
      buf = buf.slice(off + maskLen + len);
      if (opcode === 8) { socket.end(wsFrame('', 8)); return; }
      if (opcode === 9) { socket.write(wsFrame(payload, 10)); continue; }
      if (opcode === 10) continue;
      fragments.push(payload);
      if (!fin) continue;
      const text = Buffer.concat(fragments).toString('utf8');
      fragments = [];
      onExtMessage(conn, text);
    }
  });
  const drop = () => {
    if (conn.dead) return; // close 和 error 可能先后各来一次
    conn.dead = true;
    clearTimeout(conn.helloTimer);
    failPending(conn, '浏览器扩展连接已断开');
    if (conn.instanceId && instances.get(conn.instanceId) === conn) {
      instances.delete(conn.instanceId);
      recentlySeen.set(conn.instanceId, { profile: conn.profile, at: Date.now() });
      log(`扩展已断开：${browserLabel(conn)}，还剩 ${instances.size} 个浏览器`);
      invalidateIndex();
      toolsChanged();
    }
  };
  socket.on('close', drop);
  socket.on('error', drop);
  // HTTP 服务的连接允许半关闭：对方直接关 TCP（浏览器退出）时只来 end 不来 close，这里也关掉并当断开处理
  socket.on('end', () => { try { socket.end(); } catch (e) { /* ignore */ } drop(); });
  // 先挂着等 hello；旧版扩展不发 hello，超时后当匿名实例
  conn.helloTimer = setTimeout(() => register(conn, ANON_ID, {}), HELLO_WAIT_MS);
}
// 登记实例：只替换同一个 instanceId 的旧连接，旧连接上还没返回的请求以明确的错误结束
function register(conn, instanceId, info) {
  clearTimeout(conn.helloTimer);
  if (conn.dead) return;
  if (conn.instanceId === instanceId) { // 重复的 hello：只更新资料名、版本
    conn.profile = String(info.profile || conn.profile || '');
    conn.version = String(info.version || conn.version || '');
    return;
  }
  // 等 hello 超时先按匿名登记了，后来才收到 hello：从匿名位置挪走
  if (conn.instanceId && instances.get(conn.instanceId) === conn) instances.delete(conn.instanceId);
  conn.instanceId = instanceId;
  conn.profile = String(info.profile || '');
  conn.version = String(info.version || '');
  const old = instances.get(instanceId);
  instances.set(instanceId, conn);
  if (old && old !== conn) {
    failPending(old, `浏览器 ${browserLabel(old)} 的扩展重新连接了，这次调用在旧连接上被中断，请重试`);
    old.dead = true;
    try { old.socket.destroy(); } catch (e) { /* ignore */ }
    log(`扩展重新连接：${browserLabel(conn)}（替换同一资料的旧连接）`);
  } else {
    log(`扩展已连接：${browserLabel(conn)}${conn.version ? ' v' + conn.version : ''}，当前 ${instances.size} 个浏览器`);
    toolsChanged();
  }
  invalidateIndex();
  while (extWaiters.length) extWaiters.shift()();
}
function failPending(conn, message) {
  for (const [id, p] of conn.pending) {
    clearTimeout(p.timer);
    conn.pending.delete(id);
    p.reject(new Error(message));
  }
}
function onExtMessage(conn, text) {
  let m;
  try { m = JSON.parse(text); } catch (e) { return; }
  if (m.type === 'hello') {
    register(conn, String(m.instanceId || '').trim() || ANON_ID, m);
  } else if (m.type === 'response') {
    const p = conn.pending.get(m.id);
    if (!p) return;
    conn.pending.delete(m.id);
    clearTimeout(p.timer);
    m.ok ? p.resolve(m.data) : p.reject(new Error(m.error || '执行失败'));
  } else if (m.type === 'event' && m.event === 'libraryChanged') {
    invalidateIndex();
    toolsChanged();
  }
}
function toolsChanged() { libraryListeners.forEach((fn) => fn()); }
// 等到有实例登记（连上或重连）为止，超时返回 false
function waitChange(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), Math.max(0, ms));
    extWaiters.push(() => { clearTimeout(t); resolve(true); });
  });
}
function waitExt(ms) {
  if (instances.size) return Promise.resolve(true);
  return waitChange(ms);
}

// 给人和 AI 看的浏览器标识
function browserInfo(conn) { return { instanceId: conn.instanceId, profile: conn.profile || '' }; }
function browserLabel(conn) { return `${conn.profile ? '「' + conn.profile + '」' : '（未命名资料）'} instanceId=${conn.instanceId || '待定'}`; }
function browserList(conns) {
  return conns.map((c) => '  · ' + browserLabel(c)).join('\n') + '\n调用时传 browser 参数指定（填 instanceId 或资料名）。';
}
// 按 browser 参数（instanceId 或资料名）找连接；找不到返回空数组，资料名重名时返回多个
function findBrowser(ref) {
  const r = String(ref).trim();
  const all = [...instances.values()];
  let hit = all.filter((c) => c.instanceId === r);
  if (!hit.length) hit = all.filter((c) => c.profile && c.profile === r);
  if (!hit.length) hit = all.filter((c) => c.profile && c.profile.toLowerCase() === r.toLowerCase());
  return hit;
}
// 指定的浏览器可能正在重连（service worker 最多 30 秒唤醒一次）：最近连过的才等，填错的直接报错
const recentlySeen = new Map(); // instanceId -> { profile, at }
function seenRecently(ref) {
  const r = String(ref).trim().toLowerCase();
  for (const [id, x] of recentlySeen) {
    if (Date.now() - x.at < 10 * 60000 && (id.toLowerCase() === r || (x.profile && x.profile.toLowerCase() === r))) return true;
  }
  return false;
}
async function connByBrowser(ref, waitMs) {
  const end = Date.now() + (waitMs || 0);
  for (;;) {
    const hit = findBrowser(ref);
    if (hit.length === 1) return hit[0];
    if (hit.length > 1) throw new Error(`有 ${hit.length} 个浏览器的资料名都是「${ref}」，请改用 instanceId 指定：\n${browserList(hit)}`);
    if (!seenRecently(ref) || Date.now() >= end || !(await waitChange(end - Date.now()))) break;
  }
  throw new Error(`没有连着的浏览器「${ref}」。当前连着的浏览器：\n${browserList([...instances.values()])}`);
}

// 脚本库索引：录制 id / 名称 → 拥有它的实例。向各实例 list 一次后缓存，脚本库变化或实例增减时作废
let indexCache = null; // Promise<[{ conn, list: [{ id, name }] }]>
let indexGen = 0;
function invalidateIndex() { indexCache = null; indexGen++; }
const brief = (list) => (Array.isArray(list) ? list : []).map((x) => ({ id: x.id, name: x.name }));
function libraryIndex() {
  if (indexCache) return indexCache;
  const gen = indexGen;
  const p = Promise.all([...instances.values()].map((conn) => callConn(conn, 'list', {}, 20000)
    .then((list) => ({ conn, list: brief(list) }), (e) => ({ conn, list: [], error: e.message }))));
  indexCache = p;
  // 有实例没读到（超时、断开）就不缓存，下次重新读
  p.then((idx) => { if (indexCache === p && (gen !== indexGen || idx.some((x) => x.error))) indexCache = null; });
  return p;
}
// 和扩展里找脚本的规则一致：先按 id，再按完整名称，最后按名称包含；多个实例都命中同一级时报歧义
async function ownerOf(ref, retried) {
  if (!ref) throw new Error('缺少 recording 参数（脚本 id 或名称）');
  const r = String(ref).trim();
  const fromCache = !!indexCache;
  const idx = await libraryIndex();
  const rules = [(x) => x.id === r, (x) => x.name === r, (x) => String(x.name || '').includes(r)];
  for (const rule of rules) {
    const hit = idx.filter((e) => e.list.some(rule));
    // 读索引期间同一资料重连过：换成它现在的连接
    if (hit.length === 1) return (hit[0].conn.dead && instances.get(hit[0].conn.instanceId)) || hit[0].conn;
    if (hit.length > 1) {
      throw new Error(`有 ${hit.length} 个浏览器的脚本库里都有「${ref}」，请用 browser 参数指定在哪个浏览器执行：\n` +
        hit.map((e) => `  · ${browserLabel(e.conn)}：${e.list.filter(rule).map((x) => `${x.name}（id ${x.id}）`).join('、')}`).join('\n'));
    }
  }
  // 缓存的索引可能漏了刚加的脚本：重新读一次再下结论
  if (fromCache && !retried) { invalidateIndex(); return ownerOf(ref, true); }
  const lines = idx.map((e) => `  · ${browserLabel(e.conn)}：${e.error ? '读取失败 ' + e.error : e.list.map((x) => x.name).join('、') || '（空）'}`);
  throw new Error(`没有哪个浏览器的脚本库里有「${ref}」。各浏览器的脚本：\n${lines.join('\n')}`);
}

// 发给某一个实例
function callConn(conn, method, params, timeoutMs) {
  if (conn.dead || conn.socket.destroyed) return Promise.reject(new Error('浏览器扩展连接已断开'));
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { conn.pending.delete(id); reject(new Error('执行超时')); }, timeoutMs);
    conn.pending.set(id, { resolve, reject, timer });
    conn.send({ type: 'request', id, method, params });
  });
}
// list：向每个实例要列表并汇总，每条带上 browser: { instanceId, profile }
async function listAll(params, timeoutMs, browser) {
  const conns = browser ? [await connByBrowser(browser, 35000)] : [...instances.values()];
  const gen = indexGen;
  const results = await Promise.all(conns.map((conn) => callConn(conn, 'list', params || {}, timeoutMs)
    .then((list) => ({ conn, list: Array.isArray(list) ? list : [] }), (error) => ({ conn, error }))));
  const ok = results.filter((x) => !x.error);
  if (!ok.length) throw results[0].error;
  results.filter((x) => x.error).forEach((x) => log(`读取浏览器 ${browserLabel(x.conn)} 的脚本库失败：${x.error.message}`));
  // 顺手更新索引，后面按录制找实例时不用再问一遍
  if (!browser && ok.length === results.length && gen === indexGen) indexCache = Promise.resolve(ok.map(({ conn, list }) => ({ conn, list: brief(list) })));
  return [].concat(...ok.map(({ conn, list }) => list.map((r) => Object.assign({}, r, { browser: browserInfo(conn) }))));
}
// 按录制找实例的方法；importPackage 不带录制，多个实例时必须指定 browser
const RECORDING_METHODS = new Set(['get', 'script', 'run', 'call', 'saveDocs', 'exportPackage']);
async function pickConn(method, params, browser) {
  if (browser) return connByBrowser(browser, 35000);
  const all = [...instances.values()];
  if (all.length === 1) return all[0]; // 只有一个浏览器：和以前一样直接发，找不到脚本由扩展报错
  if (RECORDING_METHODS.has(method)) return ownerOf(params && params.recording);
  throw new Error(`现在有 ${all.length} 个浏览器连着，${method === 'importPackage' ? '导入录制包' : '这个调用'}要指定在哪个浏览器执行：\n${browserList(all)}`);
}

// 调用扩展：本进程持有连接则直接发；否则（端口已被另一个桥接实例占用）通过 HTTP 转发给它
// browser：多个浏览器资料都装了扩展时指定在哪个浏览器执行（instanceId 或资料名），不传则按录制自动找
let isPrimary = false;
let markReady;
const ready = new Promise((r) => { markReady = r; });
async function extCall(method, params, timeoutMs, browser) {
  timeoutMs = timeoutMs || 60000;
  browser = browser == null ? '' : String(browser).trim();
  await ready;
  if (!isPrimary) return forwardToPrimary(method, params, timeoutMs, browser);
  // 扩展的 service worker 最多每 30 秒唤醒一次重连
  if (!(await waitExt(35000))) {
    throw new Error('浏览器扩展未连接。请确认：1) Chrome 已打开并安装了 Page Recorder 扩展；2) 扩展设置中开启了“连接本地桥接服务”，地址为 ws://127.0.0.1:' + PORT + '/ext');
  }
  if (method === 'list') return listAll(params, timeoutMs, browser);
  return callConn(await pickConn(method, params, browser), method, params, timeoutMs);
}
// 监听 0.0.0.0 / :: 时转发也走本机回环地址（Host 头校验只认本机地址）
const WILDCARD = /^(0\.0\.0\.0|::|\[::\])$/.test(HOST);
function forwardToPrimary(method, params, timeoutMs, browser) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ method, params, timeout: timeoutMs, browser: browser || undefined });
    const req = http.request({ host: WILDCARD ? '127.0.0.1' : HOST, port: PORT, path: '/api/ext', method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, TOKEN ? { authorization: 'Bearer ' + TOKEN } : {}) }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
          j.ok ? resolve(j.data) : reject(new Error(j.error));
        } catch (e) { reject(new Error('桥接服务返回异常：' + d.slice(0, 200))); }
      });
    });
    req.on('error', (e) => reject(new Error('无法连接桥接服务：' + e.message)));
    req.setTimeout(timeoutMs + 5000, () => req.destroy(new Error('超时')));
    req.end(body);
  });
}

// ======================= MCP 工具 =======================
const SAVE_DOCS_FORMAT = `{
  "title": "脚本中文名",
  "slug": "英文短名 snake_case（用作工具名前缀）",
  "description": "这个录制完成了什么流程",
  "apis": {
    "<接口名，如 GET /api/search>": {
      "fn": "英文 camelCase 函数名",
      "title": "中文短标题",
      "description": "接口用途",
      "params": { "query.q": "参数含义", "body.item.qty": "参数含义" },
      "returns": "返回字段含义",
      "ignore": false
    }
  }
}`;
// 多个浏览器资料都装了扩展、同时连着桥接时，用它指定在哪个浏览器执行
const BROWSER_PARAM = { type: 'string', description: '可选。多个浏览器资料（比如主 Chrome 和指纹浏览器、不同店铺）都装了扩展时，用来指定在哪个浏览器执行：填 list_recordings 返回的 browser.instanceId 或 browser.profile（资料名）。只连着一个浏览器、或录制名只在一个浏览器里有时不用传' };
// 一次返回给 AI 的字符数上限（环境变量 PR_RESULT_CHARS 可改）、桥接里留最近多少次的完整结果
const RESULT_CHARS = Math.max(2000, Number(process.env.PR_RESULT_CHARS) || 24000);
const RESULT_KEEP = 30;
// 运行、调用接口的工具都可以带的参数：只要结果的一部分
const RESULT_PROPS = {
  result_path: { type: 'string', description: '可选。只要结果里的这一部分，如 responses[0].data.list（接口返回的结构见 get_recording）。套在 JSON 字符串里的数据已经展开，路径直接往里写' },
  result_fields: { type: 'array', items: { type: 'string' }, description: '可选。result_path 指到数组时每一项只留这些字段（相对路径，如 id、price.amount）；指到对象时只留它的这些字段' },
  result_offset: { type: 'number', description: '可选。result_path 指到数组时从第几项开始' },
  result_limit: { type: 'number', description: '可选。result_path 指到数组时取几项' },
  result_max_chars: { type: 'number', description: '可选。这次最多返回多少字符（默认约 24000）。超过时返回压缩过的预览和 result_id，再用 read_result 取具体部分' },
};
const STATIC_TOOLS = [
  {
    name: 'list_recordings',
    description: '列出浏览器扩展脚本库中保存的所有录制脚本：名称、说明、起始页面、操作步骤、可修改的输入参数（params 是录制值，paramHelp 是每个参数怎么填：类型、格式、可选项、是否必填、改了能不能直接请求接口），以及每个接口拆分出的工具函数。多个浏览器同时连着时汇总所有浏览器的脚本，每条带 browser 字段说明在哪个浏览器。',
    inputSchema: { type: 'object', properties: { browser: Object.assign({}, BROWSER_PARAM, { description: '可选。只列某一个浏览器的脚本：填 instanceId 或资料名。不传则列出所有连着的浏览器的脚本' }) } },
  },
  {
    name: 'get_recording',
    description: '获取某个录制脚本的详细信息：每一步操作、输入参数说明（paramHelp / paramInfo：类型、格式、全部可选项、是否必填、关联的接口字段）、每个接口的 URL / 参数 / 参数说明 / 响应结构 / 响应示例 / 用途说明。分析接口用途前先调用它。',
    inputSchema: { type: 'object', properties: { recording: { type: 'string', description: '脚本 id 或名称' }, browser: BROWSER_PARAM }, required: ['recording'] },
  },
  {
    name: 'run_recording',
    description: '在用户的浏览器中（带登录态）运行录制脚本。默认：录制里有接口关联了输入参数时，不操作页面，直接在已开着的页面里请求这些接口（快，第二次起复用页面；带页面最新的登录/签名请求头；业务返回码不对时自动改为回放页面操作、由页面自己发请求）；否则回放页面操作（真实鼠标键盘输入）。返回接口数据(responses)、提取数据(extracted)、执行记录(log)、用的标签页(tab)。可修改输入参数（输入框、日期、下拉、上传文件路径）和接口请求参数。',
    inputSchema: {
      type: 'object',
      properties: {
        recording: { type: 'string', description: '脚本 id 或名称' },
        params: { type: 'object', description: '输入框参数，覆盖录制时的输入，如 {"搜索商品": "macbook"}。可用参数见 list_recordings 的 params，怎么填见它的 paramHelp（密码类参数录制时没保存，必须传）', additionalProperties: true },
        api_params: { type: 'object', description: '接口请求参数改写，如 {"GET /api/search": {"query": {"page": "2"}}}。回放时页面发出的匹配请求会被改写', additionalProperties: true },
        mode: { type: 'string', enum: ['auto', 'api', 'ui'], description: 'api = 不操作页面，把参数填进关联的接口直接在页面里发请求（快）；ui = 回放页面操作；默认 auto：有关联输入参数的接口就用 api' },
        new_tab: { type: 'boolean', description: '一般不要传。用全新的标签页执行，跑完关掉。默认复用扩展在这个站点开过的标签页（第一次会新开并留着），省掉打开页面的时间' },
        keep_tab: { type: 'boolean', description: '配合 new_tab：执行后保留新开的标签页' },
        fresh: { type: 'boolean', description: '复用标签页时先刷新回起始页面，从干净的页面状态开始（默认不刷新，更快）' },
        visible: { type: 'boolean', description: '在前台标签页中执行，便于观察（默认后台）' },
        timeout_ms: { type: 'number', description: '超时时间，默认 180000' },
        browser: BROWSER_PARAM,
        ...RESULT_PROPS,
      },
      required: ['recording'],
    },
  },
  {
    name: 'call_api',
    description: '不回放页面操作，直接调用录制中的某个接口：在已经开着的同源页面里发请求（带浏览器的 Cookie、登录态和录制时的请求头），没有就在后台打开一次并留着，之后的调用直接复用，很快。返回接口数据。参数可以是扁平的工具参数，也可以是 {path, query, body} 结构；未传的参数使用录制值。',
    inputSchema: {
      type: 'object',
      properties: {
        recording: { type: 'string', description: '脚本 id 或名称' },
        api: { type: 'string', description: '接口函数名(fn)或接口名，如 searchProducts 或 "GET /api/search"' },
        args: { type: 'object', description: '接口参数', additionalProperties: true },
        browser: BROWSER_PARAM,
        ...RESULT_PROPS,
      },
      required: ['recording', 'api'],
    },
  },
  {
    name: 'read_result',
    description: '从上一次 run_recording / call_api / 接口工具的结果里取一部分，不会再调接口。结果太大时那些工具只返回压缩过的预览和 result_id，用这个工具按路径取具体数据：path 指到某个对象或数组（预览里省略的地方都写了路径），数组用 offset / limit 分页，fields 只留每一项里要的字段。例：path="responses[0].data.data.result.data.table.dataSource"，fields=["itemId","itemDesc.desc[0].text","managerPrice.currentPrice"]。',
    inputSchema: {
      type: 'object',
      properties: {
        result_id: { type: 'string', description: '结果编号（预览里的 result_id）' },
        path: { type: 'string', description: '要取的位置，如 responses[0].data.list；不传是整个结果。键名带点号的写成 a["x.y"]' },
        fields: { type: 'array', items: { type: 'string' }, description: '只留这些字段（相对 path 指到的对象、或数组里每一项的路径，如 id、price.amount、tags[0]）' },
        offset: { type: 'number', description: 'path 指到数组时从第几项开始，默认 0' },
        limit: { type: 'number', description: 'path 指到数组时取几项，默认 50（给了 fields 时默认 200）' },
        max_chars: { type: 'number', description: `这次最多返回多少字符，默认 ${RESULT_CHARS}` },
        raw: { type: 'boolean', description: '不展开套着的 JSON 字符串，按原样读（预览里 decoded_json_strings 列出的位置原来是字符串）' },
      },
      required: ['result_id'],
    },
  },
  {
    name: 'get_script',
    description: '获取录制脚本的完整 JavaScript 源码（可直接粘贴到浏览器控制台或用 Playwright page.evaluate 执行）。',
    inputSchema: { type: 'object', properties: { recording: { type: 'string', description: '脚本 id 或名称' }, browser: BROWSER_PARAM }, required: ['recording'] },
  },
  {
    name: 'save_api_docs',
    description: '把你对接口用途的分析写回脚本库：给脚本命名，为每个接口设置函数名、标题、用途、参数说明、返回说明。保存后每个接口会作为独立工具出现。推荐流程：get_recording → 分析 → save_api_docs。docs 格式：' + SAVE_DOCS_FORMAT,
    inputSchema: {
      type: 'object',
      properties: {
        recording: { type: 'string', description: '脚本 id 或名称' },
        docs: { type: 'object', description: '接口说明 JSON', additionalProperties: true },
        browser: BROWSER_PARAM,
      },
      required: ['recording', 'docs'],
    },
  },
  {
    name: 'export_package',
    description: '把录制脚本导出成录制包（JSON，已脱敏：不含密码、登录令牌等）。可以存成 <名称>.prpkg.json 文件，用来换电脑、发给同事或备份；用 import_package 或扩展弹窗「脚本库 → 导入录制包」导回。',
    inputSchema: { type: 'object', properties: { recording: { type: 'string', description: '脚本 id 或名称' }, browser: BROWSER_PARAM }, required: ['recording'] },
  },
  {
    name: 'import_package',
    description: '把录制包（export_package 返回的 JSON，或扩展弹窗导出的 .prpkg.json 文件内容）导入浏览器扩展的脚本库，成为一条新脚本，返回新脚本的 id 和名称。通过 HTTP（/mcp）调用时桥接服务必须设置了 token。',
    inputSchema: {
      type: 'object',
      properties: {
        pkg: { type: 'object', description: '录制包 JSON：{ "format": "page-recorder-package", "version": 1, "name": …, "item": {…} }', additionalProperties: true },
        browser: Object.assign({}, BROWSER_PARAM, { description: '可选。多个浏览器资料都装了扩展时，指定导入到哪个浏览器：填 instanceId 或资料名。只连着一个浏览器时不用传' }),
      },
      required: ['pkg'],
    },
  },
];

// ---------------- 输入参数说明（扩展 list / get 返回的 paramInfo → 给 AI 看的一句话） ----------------
const KIND_TEXT = {
  text: '文本输入框',
  date: '日期',
  choice: '输入后从候选项里选（填要选的文字）',
  select: '下拉框（填选项的文字或值）',
  upload: '上传文件（填本机文件的完整路径，多个用 | 分隔）',
  secret: '密码 / 口令',
  check: '勾选框（true = 勾选，false = 不勾选）',
};
const MAX_OPTIONS_SHOWN = 30;
const fmtOption = (o) => (Array.isArray(o) ? (o[1] && String(o[1]) !== String(o[0]) ? `${o[1]}(${o[0]})` : String(o[0])) : String(o));
function paramHelp(info, recorded) {
  if (!info || typeof info !== 'object') return `输入框参数，录制值: ${JSON.stringify(recorded)}`; // 旧版扩展没有 paramInfo
  const parts = [KIND_TEXT[info.kind] || '输入参数'];
  const options = Array.isArray(info.options) ? info.options : [];
  if (info.kind === 'secret') parts.push('必填，录制时未保存');
  else {
    if (info.format) parts.push(`格式 ${info.format}`);
    const rv = info.recorded !== undefined ? info.recorded : recorded;
    const opt = options.find((o) => Array.isArray(o) && String(o[0]) === String(rv));
    parts.push(`录制值: ${JSON.stringify(rv)}${opt && opt[1] && String(opt[1]) !== String(opt[0]) ? `（${opt[1]}）` : ''}`);
    if (options.length) parts.push(`可选: ${options.slice(0, MAX_OPTIONS_SHOWN).map(fmtOption).join('、')}${options.length > MAX_OPTIONS_SHOWN ? ` …共 ${options.length} 项，全部见 get_recording` : ''}`);
    parts.push(info.required ? '必填' : '可不传（不传用录制值）');
  }
  const linked = Array.isArray(info.linkedTo) ? info.linkedTo : [];
  parts.push(linked.length
    ? `改了能直接请求接口（关联 ${linked.slice(0, 4).join('、')}${linked.length > 4 ? ` 等 ${linked.length} 处` : ''}）`
    : '没有关联接口字段，改了只能回放页面操作');
  if (info.note) parts.push(String(info.note));
  return parts.join('；');
}
function paramHelps(r) {
  const out = {};
  const names = new Set(Object.keys(r.params || {}).concat(Object.keys(r.paramInfo || {})));
  for (const k of names) out[k] = paramHelp((r.paramInfo || {})[k], (r.params || {})[k]);
  return out;
}
// 接口工具参数说明里，关联了输入参数的字段“录制值”显示成 {{参数}}：换成真实录制值，并注明关联的参数名
function linkedText(desc, r) {
  if (typeof desc !== 'string' || !desc.includes('{{')) return desc;
  const names = [];
  const out = desc.replace(/\{\{\s*([^{}|]+?)\s*(?:\|[^{}]*)?\}\}/g, (m, name) => {
    const info = (r.paramInfo || {})[name];
    if (!info && !(r.params && name in r.params)) return m;
    if (!names.includes(name)) names.push(name);
    const v = info && info.recorded !== undefined ? info.recorded : r.params[name];
    return v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v);
  });
  return names.length ? `${out}（关联输入参数${names.map((n) => `「${n}」`).join('')}，不传时跟着它走）` : desc;
}
function fixToolSchema(schema, r) {
  if (!schema || !schema.properties) return schema;
  const properties = {};
  for (const [k, p] of Object.entries(schema.properties)) properties[k] = p && p.description ? Object.assign({}, p, { description: linkedText(p.description, r) }) : p;
  return Object.assign({}, schema, { properties });
}
// 给 AI 看的脚本信息：params 后面紧跟 paramHelp；full=false（列表）时去掉冗长的 paramInfo 原文
function forAi(r, full) {
  if (!r || typeof r !== 'object') return r;
  const out = {};
  for (const [k, v] of Object.entries(r)) {
    if (k === 'paramInfo' && !full) continue;
    if (k === 'tools' && Array.isArray(v)) out.tools = v.map((t) => Object.assign({}, t, { inputSchema: fixToolSchema(t.inputSchema, r) }));
    else out[k] = v;
    if (k === 'params' && r.paramInfo) out.paramHelp = paramHelps(r);
  }
  if (r.paramInfo && !out.paramHelp) out.paramHelp = paramHelps(r);
  return out;
}

// 每个脚本的每个接口 → 一个独立 MCP 工具
let dynamicMap = new Map(); // toolName -> { kind, recording, api, browser }
function slug(s, fallback) {
  const a = String(s || '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24);
  return a.length >= 2 ? a : fallback;
}
// 接口工具的参数里补上“只要结果的一部分”那几个（接口自己有同名字段的不覆盖）
function withResultProps(schema) {
  const s = Object.assign({ type: 'object' }, schema || {});
  s.properties = Object.assign({}, RESULT_PROPS, s.properties || {});
  return s;
}
async function dynamicTools() {
  dynamicMap = new Map();
  let list = [];
  try { list = await extCall('list', {}, 15000); } catch (e) { return []; }
  const tools = [];
  const used = new Set(STATIC_TOOLS.map((t) => t.name));
  // 多个浏览器同时连着：工具说明里注明是哪个浏览器的脚本，调用时直接发给那个浏览器
  const multi = new Set(list.map((r) => r.browser && r.browser.instanceId)).size > 1;
  for (const r of list) {
    const base = slug(r.slug || r.name, 'rec_' + String(r.id).slice(0, 6));
    const where = multi && r.browser ? ` · 浏览器 ${r.browser.profile || r.browser.instanceId}` : '';
    const browser = r.browser ? r.browser.instanceId : '';
    const add = (name, def, info) => {
      let n = name.slice(0, 64);
      let i = 2;
      while (used.has(n)) n = (name.slice(0, 60) + '_' + i++).slice(0, 64);
      used.add(n);
      dynamicMap.set(n, info);
      tools.push(Object.assign({ name: n }, def));
    };
    // 每个参数的说明：类型、格式、可选项、是否必填、改了能不能直接请求（扩展没给 paramInfo 时退回只写录制值）
    const props = {};
    const required = [];
    for (const [k, v] of Object.entries(r.params || {})) {
      const info = (r.paramInfo || {})[k];
      props[k] = { type: 'string', description: paramHelp(info, v) };
      if (info && (info.required || info.kind === 'secret')) required.push(k);
    }
    for (const [k, info] of Object.entries(r.paramInfo || {})) {
      if (props[k]) continue;
      props[k] = { type: 'string', description: paramHelp(info, undefined) };
      if (info && (info.required || info.kind === 'secret')) required.push(k);
    }
    add(`${base}__run`, {
      description: `[录制脚本「${r.name}」${where}] ${r.description || (r.steps || []).slice(0, 6).join('；')}。传入参数后运行：有关联接口时直接在页面里请求接口（不操作界面），否则回放页面操作。返回接口数据与提取数据。`,
      inputSchema: Object.assign({ type: 'object', properties: Object.assign({}, RESULT_PROPS, props), additionalProperties: true }, required.length ? { required } : {}),
    }, { kind: 'run', recording: r.id, browser, own: Object.keys(props) });
    for (const t of r.tools || []) {
      add(`${base}__${t.name}`, {
        description: `[录制脚本「${r.name}」${where} ${t.api}] ${t.description}`,
        inputSchema: withResultProps(fixToolSchema(t.inputSchema, r)),
      }, { kind: 'call', recording: r.id, api: t.api, browser, own: Object.keys((t.inputSchema && t.inputSchema.properties) || {}) });
    }
  }
  return tools;
}

// 导入录制包会往脚本库里加能用登录态执行的脚本：经 HTTP 来的只接受带 token 的请求（stdio 是 AI 客户端自己起的进程，不受限）
const IMPORT_NEEDS_TOKEN = '导入录制包只接受带 token 的 HTTP 请求：启动桥接服务时加 --token <口令>（或环境变量 PR_BRIDGE_TOKEN），请求带 Authorization: Bearer <口令>。也可以在扩展弹窗「脚本库 → 导入录制包」里导入';
function parsePkg(pkg) {
  if (typeof pkg === 'string') {
    try { pkg = JSON.parse(pkg); } catch (e) { throw new Error('pkg 不是合法的 JSON：' + e.message); }
  }
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) throw new Error('pkg 必须是录制包 JSON 对象（export_package 或弹窗「导出录制包」得到的内容）');
  return pkg;
}

// ======================= 给 AI 的结果 =======================
// 接口返回常常很大（一页商品十几万字符），数据还套在 JSON 字符串里（淘宝 mtop 的 data.result）。原样整段发给 AI，
// 客户端会截断或者直接报超长，AI 看不到数据。所以：
// 1. 套着的 JSON 字符串展开成对象（哪些位置展开过会标出来，read_result raw=true 可以读原文）；
// 2. 不超过上限就整段给；
// 3. 超过就给按结构压缩的预览（数组只给开头几项、长文本截短，省略的地方写明路径），完整内容留在桥接内存里，
//    AI 用 read_result 按路径、字段、分页取 —— 不会把接口再调一遍（提交类接口重调一次是有后果的）
const RESULT_CACHE_BYTES = Math.max(1, Number(process.env.PR_RESULT_CACHE_MB) || 64) * 1024 * 1024;
const RESULT_TTL = 30 * 60 * 1000;
const savedResults = new Map(); // result_id → { raw: 扩展返回的原样结果, size, at }；最近 RESULT_KEEP 次、总共不超过 RESULT_CACHE_BYTES、留 30 分钟
let savedBytes = 0;
let resultSeq = 0;
function pruneResults() {
  const now = Date.now();
  for (const [id, r] of savedResults) { // Map 按放进去的先后遍历：从最旧的开始清
    if (savedResults.size <= RESULT_KEEP && savedBytes <= RESULT_CACHE_BYTES && now - r.at <= RESULT_TTL) break;
    savedResults.delete(id);
    savedBytes -= r.size;
  }
}
// size：结果序列化后的字节数。一条就超过总量上限的不留（返回 null），调用方改成提示“调用时直接用 result_path 取”
function saveResult(raw, size) {
  if (size > RESULT_CACHE_BYTES) return null;
  const id = `r${Date.now().toString(36)}${(++resultSeq).toString(36)}`;
  savedResults.set(id, { raw, size, at: Date.now() });
  savedBytes += size;
  pruneResults();
  return id;
}
function savedResult(id) {
  const r = savedResults.get(String(id || ''));
  if (r && Date.now() - r.at > RESULT_TTL) { savedResults.delete(String(id)); savedBytes -= r.size; return null; }
  return r || null;
}
// 结构套得特别深时 JSON.stringify 会栈溢出（能套多深各平台不一样）：量不出来就当作“很大”，走按结构压缩的路
const jsonLen = (v) => { try { const s = JSON.stringify(v); return s === undefined ? 0 : s.length; } catch (e) { return Infinity; } };
const jsonBytes = (v) => { try { const s = JSON.stringify(v); return s === undefined ? 0 : Buffer.byteLength(s, 'utf8'); } catch (e) { return 4 * 1024 * 1024; } };
const sizeText = (n) => (Number.isFinite(n) ? `${n} 字符` : '很大（结构太深，量不出来）');
const clip = (x, n) => { const t = String(x == null ? '' : x); return t.length > n ? `${t.slice(0, n)}…(+${t.length - n}字)` : t; };
// 路径写法：a.b[0].c；键名里有点号等特殊字符的写成 a["x.y"]（引号里按 JSON 字符串的写法）
function pathTokens(p) {
  const out = [];
  const re = /\[(\d+)\]|\[("(?:[^"\\]|\\.)*")\]|([^.[\]]+)/g;
  let m;
  while ((m = re.exec(String(p == null ? '' : p)))) {
    if (m[1] !== undefined) out.push(Number(m[1]));
    else if (m[2] !== undefined) { try { out.push(JSON.parse(m[2])); } catch (e) { out.push(m[2].slice(1, -1)); } } else out.push(m[3]);
  }
  return out;
}
const pathJoin = (base, k) => (typeof k === 'number' ? `${base}[${k}]` : /^[A-Za-z_$][\w$]*$/.test(k) ? (base ? `${base}.${k}` : k) : `${base}[${JSON.stringify(k)}]`);
// 相对路径接在后面（fields 里写的 a.b、[0].c）
const pathAdd = (base, rel) => (!rel ? base : rel[0] === '[' ? base + rel : base ? `${base}.${rel}` : rel);
const looksJson = (x) => typeof x === 'string' && x.length >= 12 && x.length < 8e6 && /^\s*[{[]/.test(x);
// 显式按路径、字段往里取时，字符串只要像 JSON 就现解析（不管多短）；解析不了、不是对象就原样
const jsonObj = (x) => {
  if (typeof x !== 'string' || x.length >= 8e6 || !/^\s*[{[]/.test(x)) return x;
  try { const y = JSON.parse(x); return y && typeof y === 'object' ? y : x; } catch (e) { return x; }
};
// lazy：路上遇到 JSON 字符串就解析了接着往里走
function pathGet(v, p, lazy) {
  for (const t of pathTokens(p)) {
    if (lazy) v = jsonObj(v);
    if (v == null || typeof v !== 'object') return undefined;
    v = v[t];
  }
  return v;
}
// 套着的 JSON 字符串展开成对象（最多套 4 层；很短的不动，免得把 "[1,2]" 这种普通文字改了类型）。notes 收集展开过的位置
const MAX_DEPTH = 200;
function unwrapJson(v, notes, path, strDepth, depth) {
  if (typeof v === 'string') {
    if (strDepth < 4 && looksJson(v)) {
      let o;
      try { o = JSON.parse(v); } catch (e) { return v; }
      if (o && typeof o === 'object') {
        if (notes.length < 50) notes.push(path);
        return unwrapJson(o, notes, path, strDepth + 1, depth + 1);
      }
    }
    return v;
  }
  if (!v || typeof v !== 'object' || depth > MAX_DEPTH) return v; // 太深的结构不再往里（免得递归爆栈）
  if (Array.isArray(v)) return v.map((x, i) => unwrapJson(x, notes, pathJoin(path, i), strDepth, depth + 1));
  const o = {};
  for (const k of Object.keys(v)) o[k] = unwrapJson(v[k], notes, pathJoin(path, k), strDepth, depth + 1);
  return o;
}
// 说明结果成败的字段：对象再宽也先留着它们
const STATE_KEY = /^(ok|error|errors|err|status|code|success|message|msg|ret|rejected|unknown|notSent|warnings|mode|total|count|result_id)$/i;
// 按结构压缩到大约 budget 个字符：小的字段原样留，大的数组只留开头几项，长文本截短；省略的地方写明完整内容的路径。
// 分到的额度很小时只留一句“省略了什么、多大”（它在哪就是它所在的路径）
function compactValue(v, path, budget, depth) {
  depth = depth || 0;
  if (typeof v === 'string') {
    if (v.length <= budget) return v;
    if (budget >= 160) return `${v.slice(0, Math.floor(budget) - 60)}…（共 ${v.length} 字，全文：read_result path=${JSON.stringify(path)}）`;
    const keep = Math.max(12, Math.floor(budget) - 14);
    return `${v.slice(0, keep)}…(+${v.length - keep}字)`;
  }
  if (!v || typeof v !== 'object') return v;
  const size = jsonLen(v);
  if (size <= budget) return v;
  if (Array.isArray(v)) {
    const n = v.length;
    if (budget < 140 || depth > 40) return `…省略：数组 ${n} 项，${sizeText(size)}`;
    const room = budget - 110;
    // 每项至少 60 字符：按额度算最多放几项
    const k = Math.max(1, Math.min(n, 50, Math.floor(room / Math.max(60, size / n))));
    const out = v.slice(0, k).map((x, i) => compactValue(x, pathJoin(path, i), room / k, depth + 1));
    out.push(`…共 ${n} 项，这里是前 ${k} 项。其余：read_result path=${JSON.stringify(path)}，offset / limit 分页、fields 挑字段`);
    return out;
  }
  const keys = Object.keys(v);
  if (budget < 140 || depth > 40) return `…省略：对象 ${keys.length} 个字段，${sizeText(size)}`;
  // 先放说明成败的字段（ok、error、status…），再按原来的顺序放其余的；每个字段至少占“键名 + 30 字符”，按额度算能放几个
  const cand = keys.filter((k) => STATE_KEY.test(k)).concat(keys.filter((k) => !STATE_KEY.test(k)));
  const chosen = new Set();
  let floor = 0;
  for (const k of cand) {
    const cost = k.length + 34;
    if (chosen.size >= 80 || floor + cost > budget - 90) break;
    chosen.add(k);
    floor += cost;
  }
  if (!chosen.size) return `…省略：对象 ${keys.length} 个字段，${sizeText(size)}`;
  const shown = keys.filter((k) => chosen.has(k));
  const sizes = shown.map((k) => jsonLen(v[k]) + k.length + 4);
  const order = shown.map((k, i) => i).sort((a, b) => sizes[a] - sizes[b]);
  const picked = new Array(shown.length);
  let room = budget - 2 - (keys.length > shown.length ? 90 : 0);
  order.forEach((i, done) => {
    const share = Math.max(0, room) / (order.length - done);
    if (sizes[i] <= share) { picked[i] = v[shown[i]]; room -= sizes[i]; } else {
      picked[i] = compactValue(v[shown[i]], pathJoin(path, shown[i]), Math.max(24, share - shown[i].length - 4), depth + 1);
      room -= Math.min(sizes[i], jsonLen(picked[i]) + shown[i].length + 4);
    }
  });
  const out = {};
  shown.forEach((k, i) => { out[k] = picked[i]; });
  if (keys.length > shown.length) out['…'] = `共 ${keys.length} 个字段，这里是 ${shown.length} 个。其余：read_result path=${JSON.stringify(path)}，fields 写字段名`;
  return out;
}
// build(额度) → 要发的对象。序列化后超过上限就按比例收紧了重来；实在压不进去返回 null（调用方给一句话的摘要）
function fitText(build, budget) {
  let inner = budget - 100;
  for (let i = 0; i < 12; i++) {
    const t = JSON.stringify(build(Math.max(150, inner)));
    if (t.length <= budget) return t;
    if (inner <= 150) break;
    inner = Math.max(150, Math.min(inner * 0.75, inner * (budget / t.length) * 0.9));
  }
  return null;
}
// 从完整结果里取一部分：path 取到某个对象 / 数组，数组用 offset、limit 分页，fields 只留每一项里要的字段（相对路径）
function pickView(full, o, lazy) {
  const path = String(o.path == null ? '' : o.path);
  let v = path ? pathGet(full, path, lazy) : full;
  if (v === undefined) {
    let cur = full;
    let okPath = '';
    for (const t of pathTokens(path)) {
      if (lazy) cur = jsonObj(cur);
      if (cur == null || typeof cur !== 'object' || !(t in cur)) break;
      cur = cur[t];
      okPath = pathJoin(okPath, t);
    }
    const here = cur && typeof cur === 'object' ? (Array.isArray(cur) ? `是数组，共 ${cur.length} 项` : `的字段有：${Object.keys(cur).slice(0, 40).join('、')}`) : `是 ${cur === null ? 'null' : typeof cur}`;
    throw new Error(clip(`路径 ${clip(path, 200)} 不存在。${okPath ? `能走到 ${clip(okPath, 200)}，它` : '最外层'}${here}`, 900));
  }
  const info = { path: clip(path, 300) };
  const fields = Array.isArray(o.fields) ? o.fields.map(String).filter(Boolean) : typeof o.fields === 'string' && o.fields ? o.fields.split(',').map((x) => x.trim()).filter(Boolean) : [];
  // 要取字段 / 分页的那个值本身是 JSON 字符串就现解析
  const parsed = (x) => (lazy ? jsonObj(x) : x);
  const proj = (x) => {
    if (!fields.length) return x;
    x = parsed(x);
    return x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(fields.map((f) => [f, pathGet(x, f, lazy)])) : x;
  };
  if (fields.length || o.offset != null || o.limit != null) v = parsed(v);
  info.fields = fields;
  if (Array.isArray(v)) {
    const offset = Math.max(0, Math.floor(Number(o.offset) || 0));
    const limit = Number(o.limit) > 0 ? Math.floor(Number(o.limit)) : fields.length ? 200 : 50;
    info.total = v.length;
    info.offset = offset;
    info.items = v.slice(offset, offset + limit).map(proj);
  } else info.value = proj(v);
  return info;
}
// 取出来的一项（或按 fields 投影过的一项）压缩：省略处的路径按它在完整结果里的真实位置写
function compactPicked(x, itemPath, budget, fields) {
  if (!fields.length || !x || typeof x !== 'object' || Array.isArray(x) || jsonLen(x) <= budget) return compactValue(x, itemPath, budget);
  const out = {};
  const each = Math.max(40, budget / fields.length);
  for (const f of fields) out[f] = compactValue(x[f], pathAdd(itemPath, f), each - f.length - 4);
  return out;
}
// 结果变成发给 AI 的文字。opts：result_path / result_fields / result_offset / result_limit（只要其中一部分）、
// result_max_chars、raw（不展开 JSON 字符串）。saved：read_result 读已经留着的结果时传 { id, entry }
function aiText(raw, opts, saved) {
  opts = opts || {};
  const budget = Math.max(2000, Math.min(400000, Math.floor(Number(opts.result_max_chars)) || RESULT_CHARS));
  let id = saved ? saved.id : null;
  let tried = !!saved;
  // 完整结果留在桥接里（一条就超过缓存总量上限的留不了，id 是 null）
  const keep = () => {
    if (!tried) { tried = true; id = saveResult(raw, jsonBytes(raw)); }
    return id;
  };
  const how = () => (id
    ? '完整内容留在桥接里，用 read_result 取：result_id、path（如 responses[0].data…）、fields（每一项只留哪些字段，相对路径）、offset / limit（数组分页）。read_result 不会再调一次接口'
    : '这个结果太大，桥接里留不下：需要哪部分，请在调用时直接带 result_path / result_fields / result_offset / result_limit');
  const withId = (o) => (id ? Object.assign({ result_id: id }, o) : o);
  // 实在放不下预览时的一句话摘要：长度也按上限卡
  const tiny = (what, extra) => {
    keep();
    const e = {};
    for (const [k, v] of Object.entries(extra || {})) e[k] = typeof v === 'string' ? clip(v, Math.max(80, Math.floor(budget / 8))) : v;
    let t = JSON.stringify(withId(Object.assign({ note: `${what}太大（上限 ${budget} 字符），这里放不下预览。${how()}` }, e)));
    if (t.length > budget) t = JSON.stringify(withId({ note: clip(`${what}太大，这里放不下预览。${how()}`, budget - 80) }));
    return t;
  };
  const pretty = (o) => { const t = JSON.stringify(o, null, 2); return t.length <= budget ? t : JSON.stringify(o); };
  try {
    const decoded = [];
    const full = opts.raw ? raw : unwrapJson(raw, decoded, '', 0, 0);
    // 展开过 JSON 字符串：原样结果留着，raw=true 才读得回原文
    if (decoded.length) keep();
    const mark = decoded.length ? { decoded_json_strings: decoded.slice(0, 20).map((x) => clip(x || '（整个结果）', 200)), decoded_note: id ? '这些位置原来是 JSON 字符串，已经展开成对象；要原文用 read_result 加 raw=true' : '这些位置原来是 JSON 字符串，已经展开成对象' } : {};
    const part = opts.result_path != null || opts.result_fields != null || opts.result_offset != null || opts.result_limit != null;
    if (!part) {
      // 整段给。展开过 JSON 字符串的，在最外层加说明（和读原文用的编号）
      const whole = decoded.length && full && typeof full === 'object' && !Array.isArray(full)
        ? Object.assign({}, full, { _decoded_json_strings: mark.decoded_json_strings, _decoded_note: mark.decoded_note }, id ? { _result_id: id } : {})
        : full;
      if (jsonLen(whole) <= budget) return pretty(whole);
      keep();
      const note = `结果共 ${sizeText(jsonLen(full))}，超过一次能给的 ${budget}：下面是按结构压缩过的预览（数组只给开头几项、长文本截短；写着“省略”的字段，路径就是它所在的位置）。${how()}`;
      return fitText((b) => withId(Object.assign({ note }, mark, { preview: compactValue(full, '', Math.max(150, b - jsonLen(mark) - note.length - 80)) })), budget) || tiny('结果');
    }
    // 只要一部分：完整结果先留着，之后翻页、换路径都不用重新调接口
    keep();
    let view;
    try {
      view = pickView(full, { path: opts.result_path, fields: opts.result_fields, offset: opts.result_offset, limit: opts.result_limit }, true);
    } catch (e) {
      if (saved) throw e; // read_result：直接报路径不对
      // 接口已经调用过了：路径写错不能让 AI 再调一次
      const error = clip(e.message, Math.max(200, Math.floor(budget / 5)));
      const note = id ? '接口已经调用过了，结果留在桥接里：改正路径后用 read_result 读，不要重新调用接口。下面是整个结果的预览' : '接口已经调用过了，但结果太大、桥接里留不下，不能用 read_result 读：改正 result_path 后要重新调用（接口会再执行一次，提交类接口先确认能不能重复执行）。下面是整个结果的预览';
      return fitText((b) => withId({ error, note, preview: compactValue(full, '', Math.max(150, b - error.length - note.length - 80)) }), budget) || tiny('结果', { error });
    }
    const base = String(opts.result_path == null ? '' : opts.result_path);
    const fields = view.fields;
    delete view.fields;
    const head = withId(view);
    // 没留存：说明白后面不能用 read_result 接着读
    if (!id) head.not_kept = '这个结果太大，桥接里留不下，不能用 read_result 接着读：还要别的部分（比如下一页）请重新调用并带 result_path / result_offset（接口会再执行一次）';
    if (Array.isArray(view.items)) {
      const all = view.items;
      const finish = (items) => {
        const o = Object.assign({}, head, { returned: items.length, items });
        if (view.offset + items.length < view.total) o.next_offset = view.offset + items.length;
        return o;
      };
      if (jsonLen(finish(all)) <= budget) return pretty(finish(all));
      // 放不下：少给几项（每项至少 150 字符），每项按结构压缩；剩下的用 next_offset 接着取
      const t = fitText((b) => {
        const k = Math.max(1, Math.min(all.length, Math.floor((b - 400) / 150)));
        const o = finish(all.slice(0, k).map((x, i) => compactPicked(x, pathJoin(base, view.offset + i), (b - 400) / k, fields)));
        o.note = `这一页放不下：给了 ${k} 项${k < all.length ? '（接着用 next_offset 取）' : ''}，每项里太大的部分已经压缩，省略处写了路径；用 fields 只挑要的字段可以一次拿更多`;
        return o;
      }, budget);
      return t || tiny('这一部分', { path: base, total: view.total, offset: view.offset });
    }
    if (jsonLen(head) <= budget) return pretty(head);
    return fitText((b) => Object.assign({}, head, { note: '这一部分放不下，已经按结构压缩；省略处写了路径，接着用更具体的 path / fields 取', value: compactPicked(view.value, base, b - 400, fields) }), budget) || tiny('这一部分', { path: base });
  } catch (e) {
    if (saved) throw e;
    // 整理结果时出错（结构太深之类）：接口已经执行了，结果不能丢
    keep();
    let t = '';
    try { t = JSON.stringify(raw); } catch (x) { t = String(x && x.message); }
    const note = clip(`整理结果时出错（${e.message}），下面是原始结果的开头。${id ? '完整内容留在桥接里，用 read_result 加 raw=true 分块读' : '结果太大、桥接里留不下，不能用 read_result 读：要别的部分请重新调用并带 result_path（接口会再执行一次）'}`, 400);
    // 开头这段再序列化一次，引号、反斜杠会变长：按最终长度往回收
    let n = Math.max(0, budget - 700);
    let out = JSON.stringify(withId({ note, raw_head: t.slice(0, n) }));
    for (let i = 0; i < 20 && out.length > budget && n > 0; i++) { n = Math.floor(n * Math.min(0.9, budget / out.length)); out = JSON.stringify(withId({ note, raw_head: t.slice(0, n) })); }
    if (out.length > budget) out = JSON.stringify(withId({ note: clip(note, Math.max(40, budget - 120)) }));
    return out;
  }
}

const text = (obj) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] });
// 运行 / 调用接口的结果：展开、控制长度后再给（见上面“给 AI 的结果”）
const RESULT_ARGS = ['result_path', 'result_fields', 'result_offset', 'result_limit', 'result_max_chars'];
// own：这个工具自己（接口字段、脚本的输入参数）就有的同名参数。同名的归工具自己，不当成“只要结果的一部分”的参数
const resultNames = (own) => RESULT_ARGS.filter((k) => !(own || []).includes(k));
const resultOpts = (args, own) => Object.fromEntries(resultNames(own).filter((k) => args[k] != null).map((k) => [k, args[k]]));
const withoutResultArgs = (args, own) => { const drop = resultNames(own); return Object.fromEntries(Object.entries(args).filter(([k]) => !drop.includes(k))); };
const aiResult = (result, args, own) => text(aiText(result, resultOpts(args || {}, own)));
// ctx.via：'stdio' = 本进程的 MCP stdio；'http' = /mcp 接口
async function callTool(name, args, ctx) {
  args = args || {};
  ctx = ctx || {};
  const browser = args.browser;
  switch (name) {
    case 'list_recordings': return text((await extCall('list', {}, 60000, browser)).map((r) => forAi(r, false)));
    case 'get_recording': return text(forAi(await extCall('get', { recording: args.recording }, 60000, browser), true));
    case 'get_script': {
      const r = await extCall('script', { recording: args.recording }, 60000, browser);
      return text(r.script);
    }
    case 'run_recording': {
      const timeout = Number(args.timeout_ms) || 180000;
      return aiResult(await extCall('run', { recording: args.recording, params: args.params, apiParams: args.api_params, mode: args.mode, keepTab: args.keep_tab, newTab: !!args.new_tab, fresh: !!args.fresh, active: !!args.visible, timeout }, timeout + 30000, browser), args);
    }
    case 'call_api': return aiResult(await extCall('call', { recording: args.recording, api: args.api, args: args.args || {} }, 90000, browser), args);
    case 'read_result': {
      const entry = savedResult(args.result_id);
      if (!entry) throw new Error(`result_id ${args.result_id || '（没给）'} 已经不在了：桥接只留最近 ${RESULT_KEEP} 次、30 分钟内的结果，重启后清空。请重新调用接口`);
      return text(aiText(entry.raw, { result_path: args.path == null ? '' : args.path, result_fields: args.fields, result_offset: args.offset, result_limit: args.limit, result_max_chars: args.max_chars, raw: !!args.raw }, { id: String(args.result_id), entry }));
    }
    case 'save_api_docs': {
      let docs = args.docs;
      if (typeof docs === 'string') docs = JSON.parse(docs);
      return text(await extCall('saveDocs', { recording: args.recording, docs }, 60000, browser));
    }
    case 'export_package': {
      const r = await extCall('exportPackage', { recording: args.recording }, 60000, browser);
      return text(r && r.pkg ? r.pkg : r);
    }
    case 'import_package': {
      if (ctx.via === 'http' && !TOKEN) throw new Error(IMPORT_NEEDS_TOKEN);
      return text(await extCall('importPackage', { pkg: parsePkg(args.pkg) }, 60000, browser));
    }
    default: {
      if (!dynamicMap.has(name)) await dynamicTools();
      const info = dynamicMap.get(name);
      if (!info) throw new Error('未知工具：' + name);
      if (info.kind === 'run') return aiResult(await extCall('run', { recording: info.recording, params: withoutResultArgs(args, info.own), timeout: 180000 }, 210000, info.browser), args, info.own);
      return aiResult(await extCall('call', { recording: info.recording, api: info.api, args: withoutResultArgs(args, info.own) }, 90000, info.browser), args, info.own);
    }
  }
}

async function handleRpc(msg, ctx) {
  const { id, method, params } = msg || {};
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  try {
    switch (method) {
      case 'initialize':
        return ok({
          protocolVersion: (params && params.protocolVersion) || '2025-06-18',
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: 'page-recorder', version: VERSION },
          instructions: '这些工具用于执行用户在浏览器中录制的网页操作脚本，并调用录制中抓到的接口（在用户自己的浏览器中执行，带登录态）。先用 list_recordings 查看可用脚本（paramHelp 说明每个输入参数怎么填）；运行、调用接口的结果里，套在 JSON 字符串里的数据已经展开成对象；结果太大时只返回压缩过的预览和 result_id，用 read_result 按路径 / 字段 / 分页取具体数据（不会再调接口），也可以调用时直接带 result_path、result_fields 只要一部分；需要了解接口细节用 get_recording；如果接口还没有说明，可以分析后用 save_api_docs 写回。多个浏览器资料都连着桥接时，每个脚本带 browser 字段，同名脚本要用 browser 参数指定在哪个浏览器执行。export_package / import_package 用来导出、导入录制包。',
        });
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null;
      case 'ping': return ok({});
      case 'tools/list': return ok({ tools: STATIC_TOOLS.concat(await dynamicTools()) });
      case 'tools/call': {
        try {
          return ok(await callTool(params.name, params.arguments, ctx));
        } catch (e) {
          return ok({ content: [{ type: 'text', text: '错误：' + e.message }], isError: true });
        }
      }
      default:
        if (id === undefined) return null;
        return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } };
    }
  } catch (e) {
    return { jsonrpc: '2.0', id, error: { code: -32603, message: e.message } };
  }
}

// ======================= HTTP 服务 =======================
function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 20e6) req.destroy(); });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(new Error('请求体不是合法 JSON')); } });
    req.on('error', reject);
  });
}
function sendJson(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj, null, 2));
}
// 防止普通网页跨站调用本地服务：浏览器发出的跨站请求都带 Origin，只放行扩展
function allowed(req) {
  const o = req.headers.origin;
  if (o && !o.startsWith('chrome-extension://') && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(o)) return false;
  if (TOKEN) {
    const auth = req.headers.authorization || '';
    const q = new URL(req.url, 'http://x').searchParams.get('token');
    if (auth !== 'Bearer ' + TOKEN && q !== TOKEN) return false;
  }
  return true;
}
// 防 DNS 重绑定：Host 头只能是本机地址加本服务端口（端口可省略）。
// 用 --host 监听了别的地址时也认那个地址；监听 0.0.0.0 / :: 时认本机各网卡的地址（这时必须设了 token）
function hostAllowed(req) {
  const h = String(req.headers.host || '').trim().toLowerCase();
  const m = h.match(/^\[([0-9a-f:.]+)\](?::(\d+))?$/) || h.match(/^([^:[\]]+)(?::(\d+))?$/);
  if (!m) return false;
  const port = (server.address() && server.address().port) || PORT;
  if (m[2] !== undefined && Number(m[2]) !== port) return false;
  const name = m[1];
  if (name === '127.0.0.1' || name === 'localhost' || name === '::1') return true;
  if (!WILDCARD) return name === HOST.toLowerCase().replace(/^\[|\]$/g, '');
  return Object.values(os.networkInterfaces()).some((list) => (list || []).some((x) => String(x.address).toLowerCase() === name));
}
// 请求里的 browser 参数：查询串 ?browser= 或请求体里的 browser
const browserOf = (u, b) => u.searchParams.get('browser') || (b && typeof b.browser === 'string' ? b.browser : '') || '';

async function route(req, res) {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname.replace(/\/+$/, '') || '/';
  if (!hostAllowed(req)) return sendJson(res, 403, { ok: false, error: 'forbidden host' });
  if (!allowed(req)) return sendJson(res, 403, { ok: false, error: 'forbidden' });
  const ctx = { via: 'http' };
  try {
    if (p === '/mcp') {
      if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }); return res.end(); }
      const body = await readBody(req);
      if (Array.isArray(body)) {
        const out = (await Promise.all(body.map((m) => handleRpc(m, ctx)))).filter(Boolean);
        if (!out.length) { res.writeHead(202); return res.end(); }
        return sendJson(res, 200, out);
      }
      const out = await handleRpc(body, ctx);
      if (!out) { res.writeHead(202); return res.end(); }
      return sendJson(res, 200, out);
    }
    if (p === '/' || p === '/api' || p === '/api/status') {
      return sendJson(res, 200, {
        ok: true, name: 'page-recorder-bridge', version: VERSION, extensionConnected: instances.size > 0,
        browsers: [...instances.values()].map((c) => Object.assign(browserInfo(c), { version: c.version })),
        endpoints: {
          'GET  /api/recordings': '脚本列表（含每个接口拆出的工具；多个浏览器时汇总，每条带 browser）',
          'GET  /api/recordings/:id': '脚本详情（步骤、接口、参数、参数说明 paramInfo、响应结构）',
          'GET  /api/recordings/:id/script': '导出的 JS 脚本源码',
          'GET  /api/recordings/:id/package': '导出录制包（已脱敏的 JSON，可存成 .prpkg.json）',
          'POST /api/recordings/:id/run': '运行 body: { params?, apiParams?, mode?: auto|api|ui, newTab?, fresh?, keepTab?, active?, timeout? }（api=直接请求接口；默认复用已开的页面）',
          'POST /api/recordings/:id/call': '调用单个接口 body: { api, args? }',
          'POST /api/recordings/:id/docs': '保存 AI 对接口的说明 body: docs',
          'POST /api/packages': '导入录制包 body: 录制包 JSON，或 { pkg, browser? }（必须设置 token 并带上）',
          'POST /mcp': 'MCP Streamable HTTP 端点',
        },
        browserParam: '以上接口都可以带 ?browser=<instanceId 或资料名>（POST 也可以放在 body.browser）：多个浏览器资料都装了扩展时用来指定在哪个浏览器执行',
      });
    }
    if (p === '/api/ext' && req.method === 'POST') {
      // 另一个桥接进程（stdio）转发来的调用
      const b = await readBody(req);
      if (b.method === 'importPackage' && !TOKEN) return sendJson(res, 403, { ok: false, error: IMPORT_NEEDS_TOKEN });
      return sendJson(res, 200, { ok: true, data: await extCall(b.method, b.params || {}, b.timeout, b.browser) });
    }
    if (p === '/api/recordings' && req.method === 'GET') return sendJson(res, 200, { ok: true, data: await extCall('list', {}, 60000, browserOf(u)) });
    if (p === '/api/packages' && req.method === 'POST') {
      if (!TOKEN) return sendJson(res, 403, { ok: false, error: IMPORT_NEEDS_TOKEN });
      const b = await readBody(req);
      const pkg = parsePkg(b && b.format ? b : b.pkg); // 直接 POST 录制包文件，或 { pkg, browser }
      return sendJson(res, 200, { ok: true, data: await extCall('importPackage', { pkg }, 60000, browserOf(u, b.format ? null : b)) });
    }
    const m = p.match(/^\/api\/recordings\/([^/]+)(?:\/(run|call|script|docs|package))?$/);
    if (m) {
      const recording = decodeURIComponent(m[1]);
      const action = m[2];
      if (!action && req.method === 'GET') return sendJson(res, 200, { ok: true, data: await extCall('get', { recording }, 60000, browserOf(u)) });
      if (action === 'script' && req.method === 'GET') {
        const r = await extCall('script', { recording }, 60000, browserOf(u));
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
        return res.end(r.script);
      }
      if (action === 'package' && req.method === 'GET') {
        const r = await extCall('exportPackage', { recording }, 60000, browserOf(u));
        const pkg = r && r.pkg ? r.pkg : r;
        const file = String((pkg && pkg.name) || recording).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 80) + '.prpkg.json';
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="package.prpkg.json"; filename*=UTF-8''${encodeURIComponent(file).replace(/['()*!]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())}` });
        return res.end(JSON.stringify(pkg, null, 2));
      }
      if (req.method === 'POST') {
        const b = await readBody(req);
        const browser = browserOf(u, b);
        if (action === 'run') {
          const timeout = Number(b.timeout) || 180000;
          const params = Object.assign({}, b, { recording, timeout });
          delete params.browser;
          return sendJson(res, 200, { ok: true, data: await extCall('run', params, timeout + 30000, browser) });
        }
        if (action === 'call') return sendJson(res, 200, { ok: true, data: await extCall('call', { recording, api: b.api, args: b.args || {}, params: b.params, apiParams: b.apiParams }, 90000, browser) });
        if (action === 'docs') {
          let docs = b.docs;
          if (!docs) { docs = Object.assign({}, b); delete docs.browser; } // body 直接就是 docs 时，browser 不是说明的一部分
          return sendJson(res, 200, { ok: true, data: await extCall('saveDocs', { recording, docs }, 60000, browser) });
        }
      }
    }
    return sendJson(res, 404, { ok: false, error: 'not found' });
  } catch (e) {
    return sendJson(res, 500, { ok: false, error: e.message });
  }
}

const server = http.createServer((req, res) => { route(req, res); });
server.on('upgrade', (req, socket) => {
  const u = new URL(req.url, 'http://x');
  const origin = req.headers.origin || '';
  // Origin 只能挡住网页，挡不住本机/局域网里的其他程序：设置了 token 时扩展也要带上（桥接地址写成 ws://…/ext?token=口令）
  if (u.pathname !== '/ext' || !hostAllowed(req) || !origin.startsWith('chrome-extension://') || !req.headers['sec-websocket-key'] || (TOKEN && u.searchParams.get('token') !== TOKEN)) {
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    return;
  }
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    'Sec-WebSocket-Accept: ' + wsAccept(req.headers['sec-websocket-key']),
    '', '',
  ].join('\r\n'));
  socket.setNoDelay(true);
  socket.setKeepAlive(true, 15000);
  attachWs(socket);
});
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    isPrimary = false;
    markReady();
    log(`端口 ${PORT} 已被另一个桥接实例占用，本实例将转发给它`);
    if (!STDIO) process.exit(1);
  } else log('服务错误：' + e.message);
});
server.listen(PORT, HOST, () => {
  isPrimary = true;
  markReady();
  log(`已启动：http://${HOST}:${PORT}  （MCP: /mcp，REST: /api，扩展: ws://${HOST}:${PORT}/ext）${TOKEN ? '，已启用 token' : ''}`);
  log('等待浏览器扩展连接…（扩展最多 30 秒内自动连上）');
});

// ======================= MCP stdio =======================
if (STDIO) {
  let buf = '';
  const write = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (e) { write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); continue; }
      const msgs = Array.isArray(msg) ? msg : [msg];
      msgs.forEach((m) => handleRpc(m, { via: 'stdio' }).then((out) => { if (out) write(out); }));
    }
  });
  process.stdin.on('end', () => process.exit(0));
  libraryListeners.add(() => write({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }));
}
