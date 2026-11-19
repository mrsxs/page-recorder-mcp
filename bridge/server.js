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
改了端口的话，扩展「设置」里的桥接地址也要改成 ws://127.0.0.1:<端口>/ext
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
const log = (...a) => process.stderr.write('[page-recorder-bridge] ' + a.join(' ') + '\n');

// ======================= 与扩展的 WebSocket 连接 =======================
let ext = null; // { socket, send }
const pending = new Map();
let seq = 0;
const extWaiters = [];
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
    if (ext === conn) {
      ext = null;
      log('扩展已断开');
      for (const [id, p] of pending) { p.reject(new Error('浏览器扩展连接已断开')); pending.delete(id); }
    }
  };
  socket.on('close', drop);
  socket.on('error', drop);
  if (ext) try { ext.socket.destroy(); } catch (e) { /* ignore */ }
  ext = conn;
  log('扩展已连接');
  while (extWaiters.length) extWaiters.shift()();
}
function onExtMessage(conn, text) {
  let m;
  try { m = JSON.parse(text); } catch (e) { return; }
  if (m.type === 'response') {
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    clearTimeout(p.timer);
    m.ok ? p.resolve(m.data) : p.reject(new Error(m.error || '执行失败'));
  } else if (m.type === 'event' && m.event === 'libraryChanged') {
    libraryListeners.forEach((fn) => fn());
  }
}
function waitExt(ms) {
  if (ext) return Promise.resolve(true);
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), ms);
    extWaiters.push(() => { clearTimeout(t); resolve(true); });
  });
}

// 调用扩展：本进程持有连接则直接发；否则（端口已被另一个桥接实例占用）通过 HTTP 转发给它
let isPrimary = false;
let markReady;
const ready = new Promise((r) => { markReady = r; });
async function extCall(method, params, timeoutMs) {
  timeoutMs = timeoutMs || 60000;
  await ready;
  if (!isPrimary) return forwardToPrimary(method, params, timeoutMs);
  // 扩展的 service worker 最多每 30 秒唤醒一次重连
  if (!(await waitExt(35000))) {
    throw new Error('浏览器扩展未连接。请确认：1) Chrome 已打开并安装了 Page Recorder 扩展；2) 扩展设置中开启了“连接本地桥接服务”，地址为 ws://127.0.0.1:' + PORT + '/ext');
  }
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('执行超时')); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    ext.send({ type: 'request', id, method, params });
  });
}
function forwardToPrimary(method, params, timeoutMs) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ method, params, timeout: timeoutMs });
    const req = http.request({ host: HOST, port: PORT, path: '/api/ext', method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, TOKEN ? { authorization: 'Bearer ' + TOKEN } : {}) }, (res) => {
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
const STATIC_TOOLS = [
  {
    name: 'list_recordings',
    description: '列出浏览器扩展脚本库中保存的所有录制脚本：名称、说明、起始页面、操作步骤、可修改的输入参数，以及每个接口拆分出的工具函数。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_recording',
    description: '获取某个录制脚本的详细信息：每一步操作、每个接口的 URL / 参数 / 参数说明 / 响应结构 / 响应示例 / 用途说明。分析接口用途前先调用它。',
    inputSchema: { type: 'object', properties: { recording: { type: 'string', description: '脚本 id 或名称' } }, required: ['recording'] },
  },
  {
    name: 'run_recording',
    description: '在用户的浏览器中（带登录态）运行录制脚本。默认：录制里有接口关联了输入参数时，不操作页面，直接在已开着的页面里请求这些接口（快，第二次起复用页面）；否则回放页面操作。返回接口数据(responses)、提取数据(extracted)、执行记录(log)。可修改输入框参数和接口请求参数。',
    inputSchema: {
      type: 'object',
      properties: {
        recording: { type: 'string', description: '脚本 id 或名称' },
        params: { type: 'object', description: '输入框参数，覆盖录制时的输入，如 {"搜索商品": "macbook"}。可用参数见 list_recordings 的 params', additionalProperties: true },
        api_params: { type: 'object', description: '接口请求参数改写，如 {"GET /api/search": {"query": {"page": "2"}}}。回放时页面发出的匹配请求会被改写', additionalProperties: true },
        mode: { type: 'string', enum: ['auto', 'api', 'ui'], description: 'api = 不操作页面，把参数填进关联的接口直接在页面里发请求（快）；ui = 回放页面操作；默认 auto：有关联输入参数的接口就用 api' },
        new_tab: { type: 'boolean', description: '用全新的标签页执行，跑完关掉。默认复用这条录制上次的回放标签页（第一次会新开并留着），省掉打开页面的时间' },
        keep_tab: { type: 'boolean', description: '配合 new_tab：执行后保留新开的标签页' },
        fresh: { type: 'boolean', description: '复用标签页时先刷新回起始页面，从干净的页面状态开始（默认不刷新，更快）' },
        visible: { type: 'boolean', description: '在前台标签页中执行，便于观察（默认后台）' },
        timeout_ms: { type: 'number', description: '超时时间，默认 180000' },
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
      },
      required: ['recording', 'api'],
    },
  },
  {
    name: 'get_script',
    description: '获取录制脚本的完整 JavaScript 源码（可直接粘贴到浏览器控制台或用 Playwright page.evaluate 执行）。',
    inputSchema: { type: 'object', properties: { recording: { type: 'string', description: '脚本 id 或名称' } }, required: ['recording'] },
  },
  {
    name: 'save_api_docs',
    description: '把你对接口用途的分析写回脚本库：给脚本命名，为每个接口设置函数名、标题、用途、参数说明、返回说明。保存后每个接口会作为独立工具出现。推荐流程：get_recording → 分析 → save_api_docs。docs 格式：' + SAVE_DOCS_FORMAT,
    inputSchema: {
      type: 'object',
      properties: {
        recording: { type: 'string', description: '脚本 id 或名称' },
        docs: { type: 'object', description: '接口说明 JSON', additionalProperties: true },
      },
      required: ['recording', 'docs'],
    },
  },
];

// 每个脚本的每个接口 → 一个独立 MCP 工具
let dynamicMap = new Map(); // toolName -> { kind, recording, api }
function slug(s, fallback) {
  const a = String(s || '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24);
  return a.length >= 2 ? a : fallback;
}
async function dynamicTools() {
  dynamicMap = new Map();
  let list = [];
  try { list = await extCall('list', {}, 15000); } catch (e) { return []; }
  const tools = [];
  const used = new Set(STATIC_TOOLS.map((t) => t.name));
  for (const r of list) {
    const base = slug(r.slug || r.name, 'rec_' + String(r.id).slice(0, 6));
    const add = (name, def, info) => {
      let n = name.slice(0, 64);
      let i = 2;
      while (used.has(n)) n = (name.slice(0, 60) + '_' + i++).slice(0, 64);
      used.add(n);
      dynamicMap.set(n, info);
      tools.push(Object.assign({ name: n }, def));
    };
    const props = {};
    for (const [k, v] of Object.entries(r.params || {})) props[k] = { type: 'string', description: `输入框参数，录制值: ${JSON.stringify(v)}` };
    add(`${base}__run`, {
      description: `[录制脚本「${r.name}」] ${r.description || r.steps.slice(0, 6).join('；')}。传入参数后运行：有关联接口时直接在页面里请求接口（不操作界面），否则回放页面操作。返回接口数据与提取数据。`,
      inputSchema: { type: 'object', properties: props, additionalProperties: true },
    }, { kind: 'run', recording: r.id });
    for (const t of r.tools || []) {
      add(`${base}__${t.name}`, {
        description: `[录制脚本「${r.name}」 ${t.api}] ${t.description}`,
        inputSchema: t.inputSchema,
      }, { kind: 'call', recording: r.id, api: t.api });
    }
  }
  return tools;
}

const text = (obj) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] });
async function callTool(name, args) {
  args = args || {};
  switch (name) {
    case 'list_recordings': return text(await extCall('list', {}));
    case 'get_recording': return text(await extCall('get', { recording: args.recording }));
    case 'get_script': {
      const r = await extCall('script', { recording: args.recording });
      return text(r.script);
    }
    case 'run_recording': {
      const timeout = Number(args.timeout_ms) || 180000;
      return text(await extCall('run', { recording: args.recording, params: args.params, apiParams: args.api_params, mode: args.mode, keepTab: args.keep_tab, newTab: !!args.new_tab, fresh: !!args.fresh, active: !!args.visible, timeout }, timeout + 30000));
    }
    case 'call_api': return text(await extCall('call', { recording: args.recording, api: args.api, args: args.args || {} }, 90000));
    case 'save_api_docs': {
      let docs = args.docs;
      if (typeof docs === 'string') docs = JSON.parse(docs);
      return text(await extCall('saveDocs', { recording: args.recording, docs }));
    }
    default: {
      if (!dynamicMap.has(name)) await dynamicTools();
      const info = dynamicMap.get(name);
      if (!info) throw new Error('未知工具：' + name);
      if (info.kind === 'run') return text(await extCall('run', { recording: info.recording, params: args, timeout: 180000 }, 210000));
      return text(await extCall('call', { recording: info.recording, api: info.api, args }, 90000));
    }
  }
}

async function handleRpc(msg) {
  const { id, method, params } = msg;
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  try {
    switch (method) {
      case 'initialize':
        return ok({
          protocolVersion: (params && params.protocolVersion) || '2025-06-18',
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: 'page-recorder', version: VERSION },
          instructions: '这些工具用于执行用户在浏览器中录制的网页操作脚本，并调用录制中抓到的接口（在用户自己的浏览器中执行，带登录态）。先用 list_recordings 查看可用脚本；需要了解接口细节用 get_recording；如果接口还没有说明，可以分析后用 save_api_docs 写回。',
        });
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null;
      case 'ping': return ok({});
      case 'tools/list': return ok({ tools: STATIC_TOOLS.concat(await dynamicTools()) });
      case 'tools/call': {
        try {
          return ok(await callTool(params.name, params.arguments));
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

async function route(req, res) {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname.replace(/\/+$/, '') || '/';
  if (!allowed(req)) return sendJson(res, 403, { ok: false, error: 'forbidden' });
  try {
    if (p === '/mcp') {
      if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }); return res.end(); }
      const body = await readBody(req);
      if (Array.isArray(body)) {
        const out = (await Promise.all(body.map(handleRpc))).filter(Boolean);
        if (!out.length) { res.writeHead(202); return res.end(); }
        return sendJson(res, 200, out);
      }
      const out = await handleRpc(body);
      if (!out) { res.writeHead(202); return res.end(); }
      return sendJson(res, 200, out);
    }
    if (p === '/' || p === '/api' || p === '/api/status') {
      return sendJson(res, 200, {
        ok: true, name: 'page-recorder-bridge', version: VERSION, extensionConnected: !!ext,
        endpoints: {
          'GET  /api/recordings': '脚本列表（含每个接口拆出的工具）',
          'GET  /api/recordings/:id': '脚本详情（步骤、接口、参数、响应结构）',
          'GET  /api/recordings/:id/script': '导出的 JS 脚本源码',
          'POST /api/recordings/:id/run': '运行 body: { params?, apiParams?, mode?: auto|api|ui, newTab?, fresh?, keepTab?, active?, timeout? }（api=直接请求接口；默认复用已开的页面）',
          'POST /api/recordings/:id/call': '调用单个接口 body: { api, args? }',
          'POST /api/recordings/:id/docs': '保存 AI 对接口的说明 body: docs',
          'POST /mcp': 'MCP Streamable HTTP 端点',
        },
      });
    }
    if (p === '/api/ext' && req.method === 'POST') {
      const b = await readBody(req);
      return sendJson(res, 200, { ok: true, data: await extCall(b.method, b.params || {}, b.timeout) });
    }
    if (p === '/api/recordings' && req.method === 'GET') return sendJson(res, 200, { ok: true, data: await extCall('list', {}) });
    const m = p.match(/^\/api\/recordings\/([^/]+)(?:\/(run|call|script|docs))?$/);
    if (m) {
      const recording = decodeURIComponent(m[1]);
      const action = m[2];
      if (!action && req.method === 'GET') return sendJson(res, 200, { ok: true, data: await extCall('get', { recording }) });
      if (action === 'script' && req.method === 'GET') {
        const r = await extCall('script', { recording });
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
        return res.end(r.script);
      }
      if (req.method === 'POST') {
        const b = await readBody(req);
        if (action === 'run') {
          const timeout = Number(b.timeout) || 180000;
          return sendJson(res, 200, { ok: true, data: await extCall('run', Object.assign({}, b, { recording, timeout }), timeout + 30000) });
        }
        if (action === 'call') return sendJson(res, 200, { ok: true, data: await extCall('call', { recording, api: b.api, args: b.args || {}, params: b.params, apiParams: b.apiParams }, 90000) });
        if (action === 'docs') return sendJson(res, 200, { ok: true, data: await extCall('saveDocs', { recording, docs: b.docs || b }) });
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
  if (u.pathname !== '/ext' || !origin.startsWith('chrome-extension://') || !req.headers['sec-websocket-key']) {
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
      msgs.forEach((m) => handleRpc(m).then((out) => { if (out) write(out); }));
    }
  });
  process.stdin.on('end', () => process.exit(0));
  libraryListeners.add(() => write({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }));
}
