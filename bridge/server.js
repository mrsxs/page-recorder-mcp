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
const { spawn, execFile } = require('child_process');
const { createLibrary, syncBrowser, restoreOwner, sendItem } = require('./library');
const { createShared, syncEnv, shareOn, shareOff } = require('./shared');
const { createLanServer, lanRequest } = require('./lan');
const { createUpdater, copyTree, EXTENSION_FILES } = require('./updater');

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
// 后台桥接的日志、本机转发用的口令文件、脚本库副本（PR_BRIDGE_DIR 可改，测试用）
const STATE_DIR = process.env.PR_BRIDGE_DIR || path.join(os.homedir(), '.page-recorder');

if (argv[0] === '--help' || argv[0] === '-h') {
  process.stdout.write(`page-recorder-mcp ${VERSION}

用法：
  page-recorder-mcp                 启动桥接服务（HTTP / REST / MCP Streamable HTTP）
  page-recorder-mcp --stdio         以 MCP stdio 方式运行（给 Claude Code、Accio、Cursor 等用）
  page-recorder-mcp trust <扩展ID>    放行桥接没认的扩展（找不到安装目录时，比如装在指纹浏览器里的）
  page-recorder-mcp extension [目录] 生成浏览器扩展（默认 ~/page-recorder-extension），
                                    在 Chrome 的 chrome://extensions 里「加载已解压的扩展程序」选这个目录

选项（也可以用环境变量）：
  --port <端口>     监听端口，默认 17321              PR_BRIDGE_PORT
  --host <地址>     监听地址，默认 127.0.0.1          PR_BRIDGE_HOST
  --token <口令>    HTTP 调用需带 Authorization: Bearer <口令>   PR_BRIDGE_TOKEN
  --no-daemon       --stdio 时不在后台起桥接，自己监听端口（旧做法）
  --max-tools <数量> 脚本和接口拆出的工具最多列多少个，默认 30；超过就一个都不列，   PR_MAX_TOOLS
                    改用 search_apis 按关键词找接口、call_api 调用（0 = 总是这样）
  --no-auto-update  不自动更新扩展目录和技能                         PR_AUTO_UPDATE=0
脚本库会同步到 ~/.page-recorder/library/，升级、重装扩展不影响。
在脚本库里点「共享」的脚本放在 ~/.page-recorder/shared/，这台电脑上连着桥接的其他浏览器资料可以接收、之后跟着同步。
在扩展弹窗「脚本库 → 局域网」打开开关后，局域网里的另一台电脑可以凭口令读这些共享脚本（端口默认 17322，PR_LAN_PORT 可改）；
关掉浏览器（开开关的那个）就关。
--stdio 时会在后台起一个桥接，之后各个 AI 工具、各次会话都复用它，扩展不用反复重连；
启动它的程序（WorkBuddy、Cursor 等）都退出后，后台桥接自动关闭。日志在 ~/.page-recorder/。
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
  // 不能生成到程序自己的目录里（或者包含它的目录）：先删旧文件再复制，会把自己的源文件删掉
  const realOut = fs.realpathSync(out);
  const realRoot = fs.realpathSync(ROOT);
  if (realOut === realRoot || realRoot.startsWith(realOut + path.sep) || realOut.startsWith(realRoot + path.sep)) {
    process.stderr.write(`不能把扩展生成到 page-recorder-mcp 自己的目录：${out}。请换一个文件夹，比如 ${path.join(os.homedir(), 'page-recorder-extension')}\n`);
    process.exit(1);
  }
  for (const f of EXTENSION_FILES) copyTree(path.join(ROOT, f), path.join(out, f));
  // 记下这个目录，之后的新版由桥接自动更新进来
  try { createUpdater({ root: ROOT, version: VERSION, stateDir: STATE_DIR, home: os.homedir(), log: () => {} }).rememberExtensionDir(out); } catch (e) { process.stderr.write(`记录扩展目录失败，这个目录不会自动更新：${e.message}\n`); }
  process.stdout.write(`Page Recorder 扩展 ${VERSION} 已生成到 ${out}
在 Chrome 打开 chrome://extensions → 打开「开发者模式」→「加载已解压的扩展程序」→ 选这个文件夹（已经加载过的话点「重新加载」）。
以后有新版时，AI 工具启动桥接就会自动更新这个目录并重新加载扩展。请一直用这个目录：换目录会变成另一个扩展。
`);
  process.exit(0);
}

// 认得的扩展（见 trustExtension）记在这里
const TRUST_FILE = path.join(STATE_DIR, 'trusted-extensions.json');
function readTrusted() {
  try { const j = JSON.parse(fs.readFileSync(TRUST_FILE, 'utf8')); return Array.isArray(j.ids) ? j.ids.filter((x) => typeof x === 'string' && /^[a-z0-9]{1,64}$/.test(x)) : []; } catch (e) { return []; }
}
// 加进去（和文件里现有的合并，别的进程刚写的不丢），先写临时文件再改名，写到一半退出不会留下坏文件。返回合并后的全部
function writeTrusted(ids) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const all = [...new Set([...readTrusted(), ...ids])];
  const tmp = `${TRUST_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ids: all }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, TRUST_FILE);
  return all;
}
if (argv[0] === 'trust') {
  // 桥接没认的扩展（比如指纹浏览器里装的，桥接找不到它的安装目录）：用户确认是自己装的 Page Recorder 后手动放行
  const id = String(argv[1] || '').trim().toLowerCase();
  if (!/^[a-z0-9]{1,64}$/.test(id)) {
    process.stderr.write('用法：page-recorder-mcp trust <扩展 ID>（扩展 ID 在扩展弹窗的桥接状态里，或 chrome://extensions 里这个扩展的“ID”）\n');
    process.exit(1);
  }
  writeTrusted([id]);
  process.stdout.write(`已放行扩展 ${id}，扩展 30 秒内会自动连上桥接\n`);
  process.exit(0);
}

const PORT = Number(flag('port') || process.env.PR_BRIDGE_PORT || 17321);
const HOST = flag('host') || process.env.PR_BRIDGE_HOST || '127.0.0.1';
const TOKEN = flag('token') || process.env.PR_BRIDGE_TOKEN || ''; // 可选：设置后 HTTP 调用需带 Authorization: Bearer <token>
// 脚本、接口拆出的工具最多列多少个：每个约 680 token，AI 每轮对话都要带上全部工具定义，几百个接口就放不下了
const maxToolsOpt = flag('max-tools') !== undefined ? flag('max-tools') : process.env.PR_MAX_TOOLS;
const MAX_TOOLS = maxToolsOpt !== undefined && maxToolsOpt !== '' && Number(maxToolsOpt) >= 0 ? Math.floor(Number(maxToolsOpt)) : 30;
const STDIO = argv.includes('--stdio');
const DAEMON = argv.includes('--daemon'); // stdio 实例在后台起的桥接：启动它的程序都退出后自己关闭
const NO_DAEMON = argv.includes('--no-daemon');
const STATE_FILE = path.join(STATE_DIR, `bridge-${PORT}.json`);
// 监听端口的实例写进 STATE_FILE；转发过来的请求带上它，说明是本机 stdio 实例（AI 客户端自己起的进程）发的
const SECRET = crypto.randomBytes(24).toString('hex');
const IS_LOOPBACK_HOST = /^(127\.\d+\.\d+\.\d+|localhost|::1|\[::1\])$/.test(HOST);
const EXT_ID_ALLOW = new Set(String(flag('extension-id') || process.env.PR_EXTENSION_ID || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
// 不只监听本机时必须设置 token，否则局域网里任何人都能借你的浏览器登录态执行脚本
if (!IS_LOOPBACK_HOST && !TOKEN) {
  process.stderr.write(`[page-recorder-bridge] 监听 ${HOST} 会暴露给本机以外的设备，必须同时设置 --token（或 PR_BRIDGE_TOKEN）\n`);
  process.exit(2);
}
const log = (...a) => process.stderr.write('[page-recorder-bridge] ' + a.join(' ') + '\n');

// ======================= 与扩展的 WebSocket 连接 =======================
// 每个 Chrome 用户资料里的扩展是一个“实例”，连上后先发 hello 报 instanceId（和资料名 profile）。
// 按 instanceId 各存一条连接：同一个实例重连只替换它自己，多个资料（主 Chrome、指纹浏览器、各店铺）可以同时在线。
const instances = new Map(); // instanceId -> conn
const instanceOrigins = new Map();
const wsSockets = new Set();
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
const WS_MAX_MSG = 64 * 1024 * 1024;
function attachWs(socket, origin, head) {
  let buf = Buffer.alloc(0);
  let used = 0;
  let fragments = [];
  let fragLen = 0;
  let fragmented = false;
  const conn = {
    socket,
    origin: String(origin || '').toLowerCase(),
    instanceId: null, // 收到 hello（或等 hello 超时）后才登记
    profile: '',
    version: '',
    pending: new Map(), // 这条连接上还没返回的请求：连接断开或被替换时逐个以错误结束
    dead: false,
    send: (obj) => { if (!socket.destroyed && !socket.writableEnded) socket.write(wsFrame(JSON.stringify(obj), 1)); },
  };
  const drop = () => {
    if (conn.dead) return; // close 和 error 可能先后各来一次
    conn.dead = true;
    buf = Buffer.alloc(0);
    used = 0;
    fragments = [];
    fragLen = 0;
    clearTimeout(conn.helloTimer);
    failPending(conn, '浏览器扩展连接已断开');
    if (conn.instanceId && instances.get(conn.instanceId) === conn) {
      instances.delete(conn.instanceId);
      recentlySeen.set(conn.instanceId, { profile: conn.profile, at: Date.now() });
      if (recentlySeen.size > 200) recentlySeen.delete(recentlySeen.keys().next().value);
      log(`扩展已断开：${browserLabel(conn)}，还剩 ${instances.size} 个浏览器`);
      invalidateIndex();
      toolsChanged();
      lanOwnerGone(conn.instanceId);
    }
  };
  const failWs = () => {
    try { socket.end(wsFrame('', 8)); } catch (e) { /* ignore */ }
    try { socket.destroy(); } catch (e) { /* ignore */ }
    drop();
  };
  conn.close = failWs;
  const onData = (chunk) => {
    if (conn.dead || !chunk || !chunk.length) return;
    const capacity = WS_MAX_MSG + 14 + 65536;
    const needed = used + chunk.length;
    if (needed > capacity) { failWs(); return; }
    if (needed > buf.length) {
      const next = Buffer.allocUnsafe(Math.min(capacity, Math.max(4096, needed, buf.length * 2)));
      buf.copy(next, 0, 0, used);
      buf = next;
    }
    chunk.copy(buf, used);
    used = needed;
    let pos = 0;
    while (!conn.dead) {
      const avail = used - pos;
      if (avail < 2) break;
      const b0 = buf[pos];
      const b1 = buf[pos + 1];
      if ((b0 & 0x70) !== 0) { failWs(); return; } // RSV 必须为 0
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      if (!masked) { failWs(); return; } // RFC 6455: 客户端帧必须带掩码
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) { if (avail < 4) break; len = buf.readUInt16BE(pos + 2); off = 4; }
      else if (len === 127) {
        if (avail < 10) break;
        const big = buf.readBigUInt64BE(pos + 2);
        if (big > BigInt(WS_MAX_MSG)) { failWs(); return; }
        len = Number(big);
        off = 10;
      }
      const control = opcode >= 8;
      if (len > WS_MAX_MSG ||
          (control ? (!fin || len > 125 || opcode > 10) : (opcode !== (fragmented ? 0 : 1) || fragments.length >= 16384))) {
        failWs();
        return;
      }
      const maskLen = 4;
      if (avail < off + maskLen + len) break;
      const mask = buf.subarray(pos + off, pos + off + 4);
      const raw = buf.subarray(pos + off + maskLen, pos + off + maskLen + len);
      const payload = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) payload[i] = raw[i] ^ mask[i & 3];
      pos += off + maskLen + len;
      if (opcode === 8) {
        try { socket.end(wsFrame('', 8)); } catch (e) { /* ignore */ }
        drop();
        return;
      }
      if (opcode === 9) { if (!socket.destroyed && !socket.writableEnded) socket.write(wsFrame(payload, 10)); continue; }
      if (opcode === 10) continue;
      fragLen += payload.length;
      if (fragLen > WS_MAX_MSG) { failWs(); return; }
      fragments.push(payload);
      fragmented = !fin;
      if (!fin) continue;
      const text = Buffer.concat(fragments, fragLen).toString('utf8');
      fragments = [];
      fragLen = 0;
      onExtMessage(conn, text);
    }
    if (conn.dead) return;
    if (pos > 0) {
      used -= pos;
      if (used) buf.copyWithin(0, pos, pos + used);
      else if (buf.length > 65536) buf = Buffer.alloc(0);
    }
  };
  socket.on('data', onData);
  socket.on('close', drop);
  socket.on('error', drop);
  // HTTP 服务的连接允许半关闭：对方直接关 TCP（浏览器退出）时只来 end 不来 close，这里也关掉并当断开处理
  socket.on('end', () => { try { socket.end(); } catch (e) { /* ignore */ } drop(); });
  // 先挂着等 hello；旧版扩展不发 hello，超时后当匿名实例
  conn.helloTimer = setTimeout(() => register(conn, ANON_ID, {}), HELLO_WAIT_MS);
  if (head && head.length) onData(head);
}
// 登记实例：只替换同一个 instanceId 的旧连接，旧连接上还没返回的请求以明确的错误结束
function register(conn, instanceId, info) {
  clearTimeout(conn.helloTimer);
  if (conn.dead) return;
  if (conn.instanceId === instanceId) { // 重复的 hello：只更新资料名、版本
    conn.profile = String(info.profile || conn.profile || '');
    conn.version = String(info.version || conn.version || '');
    conn.capabilities = capabilitiesOf(info);
    return;
  }
  const pinned = instanceOrigins.get(instanceId);
  if (pinned && pinned !== conn.origin) {
    log(`拒绝不同扩展来源 (${conn.origin}) 冒用实例标识`);
    conn.close();
    return;
  }
  if (!pinned && instanceOrigins.size >= 1024) { conn.close(); return; }
  instanceOrigins.set(instanceId, conn.origin);
  // 等 hello 超时先按匿名登记了，后来才收到 hello：从匿名位置挪走
  if (conn.instanceId && instances.get(conn.instanceId) === conn) instances.delete(conn.instanceId);
  conn.instanceId = instanceId;
  conn.profile = String(info.profile || '');
  conn.version = String(info.version || '');
  conn.capabilities = capabilitiesOf(info);
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
  scheduleLibrarySync(conn);
  scheduleAutoUpdate();
  // 局域网同步开着：新连上的浏览器马上显示（不用等下一次变化）
  if (canLan(conn) && lan.running) callConn(conn, 'lanState', lanState(), 10000).catch(() => {});
}
// 扩展在 hello 里声明自己支持什么；旧版扩展不声明，就不给它发新方法
const capabilitiesOf = (info) => (Array.isArray(info.capabilities) ? info.capabilities.map(String).slice(0, 16) : []);
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
  if (!m || typeof m !== 'object' || Array.isArray(m)) return;
  if (m.type === 'hello') {
    const id = typeof m.instanceId === 'string' ? m.instanceId.trim() : '';
    if (id.length > 128 || (conn.instanceId && conn.instanceId !== ANON_ID && conn.instanceId !== id)) { conn.close(); return; }
    register(conn, id || ANON_ID, m);
  } else if (m.type === 'response') {
    const p = conn.pending.get(m.id);
    if (!p) return;
    conn.pending.delete(m.id);
    clearTimeout(p.timer);
    m.ok ? p.resolve(m.data) : p.reject(new Error(m.error || '执行失败'));
  } else if (m.type === 'event' && m.event === 'libraryChanged') {
    invalidateIndex();
    toolsChanged();
    scheduleLibrarySync(conn);
  } else if (m.type === 'event' && m.event === 'libraryRestore') {
    runLibraryRestore(conn, m.owner);
  } else if (m.type === 'event' && m.event === 'shareSet') {
    if (m.req) replyTo(conn, m.req, () => runShareSet(conn, m.id, m.on === true));
    else runShareSet(conn, m.id, m.on === true).catch((e) => callConn(conn, 'sharedState', { notices: [`${m.on === true ? '共享' : '停止共享'}失败：${e.message}`] }, 10000).catch(() => {}));
  } else if (m.type === 'event' && typeof m.event === 'string' && Object.hasOwn(LAN_EVENTS, m.event)) {
    replyTo(conn, m.req, () => LAN_EVENTS[m.event](conn, m));
  } else if (m.type === 'event' && m.event === 'sharedReceive') {
    if (!Array.isArray(m.ids)) return;
    conn.sharedReceive = new Set([...(conn.sharedReceive || []), ...m.ids.filter((x) => typeof x === 'string').slice(0, 200)]);
    scheduleSharedSync(conn);
  }
}
function toolsChanged() { libraryListeners.forEach((fn) => fn()); }
// 等到有实例登记（连上或重连）为止，超时返回 false
function waitChange(ms) {
  return new Promise((resolve) => {
    const fn = () => { clearTimeout(t); resolve(true); };
    const t = setTimeout(() => {
      const idx = extWaiters.indexOf(fn);
      if (idx >= 0) extWaiters.splice(idx, 1);
      resolve(false);
    }, Math.max(0, ms));
    extWaiters.push(fn);
  });
}
function waitExt(ms) {
  if (instances.size) return Promise.resolve(true);
  return waitChange(ms);
}

// 给人和 AI 看的浏览器标识
function browserInfo(conn) { return { instanceId: conn.instanceId, profile: conn.profile || '' }; }
// 给 AI 选浏览器用的值：资料名在所有浏览器里唯一就用资料名，没起名或重名的用 instanceId（按资料名找重名时会报错）
function browserChoices(list, all) {
  const count = (p) => all.filter((b) => b.profile === p).length;
  return list.map((b) => (b.profile && count(b.profile) === 1 ? b.profile : b.instanceId));
}
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
  const now = Date.now();
  let hit = false;
  for (const [id, x] of recentlySeen) {
    if (now - x.at >= 10 * 60000) { recentlySeen.delete(id); continue; }
    if (!hit && (id.toLowerCase() === r || (x.profile && x.profile.toLowerCase() === r))) hit = true;
  }
  return hit;
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
function invalidateIndex() { indexCache = null; lateList = null; indexGen++; }
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
  const r = String(ref == null ? '' : ref).trim();
  if (!r) throw new Error('缺少 recording 参数（脚本 id 或名称）');
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
  if (conn.dead || conn.socket.destroyed || conn.socket.writableEnded) return Promise.reject(new Error('浏览器扩展连接已断开'));
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
// 按录制找实例的方法（mergeRecordings 按第一段的脚本找）；importPackage 不带录制，多个实例时必须指定 browser
const RECORDING_METHODS = new Set(['get', 'script', 'run', 'call', 'saveDocs', 'exportPackage', 'mergeRecordings']);
async function pickConn(method, params, browser) {
  if (browser) return connByBrowser(browser, 35000);
  const all = [...instances.values()];
  if (all.length === 1) return all[0]; // 只有一个浏览器：和以前一样直接发，找不到脚本由扩展报错
  if (RECORDING_METHODS.has(method)) return ownerOf(params && params.recording);
  throw new Error(`现在有 ${all.length} 个浏览器连着，${method === 'importPackage' ? '导入录制包' : '这个调用'}要指定在哪个浏览器执行：\n${browserList(all)}`);
}

// 调用扩展：本进程持有连接则直接发；否则（端口已被另一个桥接实例占用）通过 HTTP 转发给它
// browser：多个浏览器资料都装了扩展时指定在哪个浏览器执行（instanceId 或资料名），不传则按录制自动找
// waitMs：扩展还没连上时最多等多久，默认按 service worker 最多每 30 秒唤醒一次重连来等
const EXT_WAIT_MS = 35000;
let isPrimary = false;
let markReady;
const ready = new Promise((r) => { markReady = r; });
async function extCall(method, params, timeoutMs, browser, waitMs) {
  timeoutMs = timeoutMs || 60000;
  browser = browser == null ? '' : String(browser).trim();
  waitMs = waitMs == null ? EXT_WAIT_MS : waitMs;
  await ready;
  if (!isPrimary) {
    try {
      return await forwardToPrimary(method, params, timeoutMs, browser, waitMs);
    } catch (e) {
      // 后台桥接没了（启动它的程序都退出了、被关掉了）：重新起一个再发一次
      if (e.code !== 'ECONNREFUSED' || !STDIO || NO_DAEMON || !(await ensureBridge())) throw e;
      return forwardToPrimary(method, params, timeoutMs, browser, waitMs);
    }
  }
  if (!(await waitExt(waitMs))) {
    throw new Error('浏览器扩展未连接。请确认：1) Chrome 已打开并安装了 Page Recorder 扩展；2) 扩展设置中开启了“连接本地桥接服务”，地址为 ws://127.0.0.1:' + PORT + '/ext');
  }
  if (method === 'list') return listAll(params, timeoutMs, browser);
  return callConn(await pickConn(method, params, browser), method, params, timeoutMs);
}
// 监听 0.0.0.0 / :: 时转发也走本机回环地址（Host 头校验只认本机地址）
const WILDCARD = /^(0\.0\.0\.0|::|\[::\])$/.test(HOST);
const BRIDGE_HOST = WILDCARD ? '127.0.0.1' : HOST;
// 发给监听端口的那个实例时带的请求头：token（设置了的话）和本机口令（读它写的 STATE_FILE）
function bridgeHeaders(extra) {
  const h = Object.assign({}, extra, TOKEN ? { authorization: 'Bearer ' + TOKEN } : {});
  try { h['x-page-recorder-secret'] = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).secret; } catch (e) { /* 旧版桥接没写这个文件 */ }
  return h;
}
function forwardToPrimary(method, params, timeoutMs, browser, waitMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const ok = (v) => { if (!settled) { settled = true; resolve(v); } };
    const fail = (e) => { if (!settled) { settled = true; reject(e); } };
    const body = JSON.stringify({ method, params, timeout: timeoutMs, browser: browser || undefined, wait: waitMs });
    const req = http.request({ host: BRIDGE_HOST, port: PORT, path: '/api/ext', method: 'POST', headers: bridgeHeaders({ 'content-type': 'application/json' }) }, (res) => {
      const chunks = [];
      res.on('data', (c) => { chunks.push(c); });
      res.on('end', () => {
        const d = Buffer.concat(chunks).toString('utf8');
        try {
          const j = JSON.parse(d);
          j.ok ? ok(j.data) : fail(new Error(j.error));
        } catch (e) { fail(new Error('桥接服务返回异常：' + d.slice(0, 200))); }
      });
      res.on('error', (e) => fail(Object.assign(new Error('读取桥接响应失败：' + e.message), { code: e.code })));
      res.on('close', () => { if (!res.complete) fail(new Error('桥接服务响应中断')); });
    });
    req.on('error', (e) => fail(Object.assign(new Error('无法连接桥接服务：' + e.message), { code: e.code })));
    req.setTimeout(waitMs + timeoutMs + 5000, () => req.destroy(new Error('超时')));
    req.end(body);
  });
}

// ======================= 后台桥接（--stdio 时） =======================
// AI 客户端可能每条消息都重起一次 MCP 进程（WorkBuddy 就是这样）。桥接如果跟着 MCP 进程走，
// 扩展每次都要重连（最多 30 秒）。所以 stdio 实例在后台起一个独立的桥接，大家都转发给它；
// 每个 stdio 实例向它登记「启动自己的程序」，这些程序都退出后它自己关闭。
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 端口上有没有在应答的服务（不管是不是新版）：连不上返回 false
function bridgeUp() {
  return new Promise((resolve) => {
    const req = http.get({ host: BRIDGE_HOST, port: PORT, path: '/api/status', headers: bridgeHeaders() }, (res) => { res.resume(); resolve(true); });
    req.on('error', () => resolve(false));
    req.setTimeout(1500, () => req.destroy());
  });
}
function spawnDaemon() {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const logFile = path.join(STATE_DIR, `bridge-${PORT}.log`);
  try { if (fs.statSync(logFile).size > 1e6) fs.truncateSync(logFile, 0); } catch (e) { /* 还没有日志 */ }
  const out = fs.openSync(logFile, 'a');
  // token 走环境变量，不出现在进程列表里
  const child = spawn(process.execPath, [__filename, '--daemon', '--port', String(PORT), '--host', HOST, '--max-tools', String(MAX_TOOLS), ...(argv.includes('--no-auto-update') ? ['--no-auto-update'] : [])], {
    detached: true, windowsHide: true, stdio: ['ignore', out, out],
    env: Object.assign({}, process.env, TOKEN ? { PR_BRIDGE_TOKEN: TOKEN } : {}, { PR_EXTENSION_ID: [...EXT_ID_ALLOW].join(',') }),
  });
  child.on('error', (e) => log('后台桥接启动失败：' + e.message));
  child.unref();
  fs.closeSync(out);
  log(`已在后台启动桥接（日志 ${logFile}）`);
}
// 保证端口上有桥接：没有就在后台起一个，等它开始监听。几个调用同时来只起一次
let ensuring = null;
function ensureBridge() {
  if (!ensuring) {
    ensuring = (async () => {
      if (await bridgeUp()) return true;
      spawnDaemon();
      for (const end = Date.now() + 3000; Date.now() < end;) {
        await sleep(100);
        if (await bridgeUp()) return true;
      }
      log('后台桥接 3 秒内没有启动');
      return false;
    })().finally(() => { ensuring = null; });
  }
  return ensuring;
}

// 进程表 pid -> { ppid, path }，用来找是哪个程序启动了这个 MCP 进程
function processTable() {
  return new Promise((resolve) => {
    const table = new Map();
    const parse = (out, re) => {
      for (const line of String(out || '').split(/\r?\n/)) {
        const m = line.match(re);
        if (m) table.set(Number(m[1]), { ppid: Number(m[2]), path: m[3].trim() });
      }
      resolve(table);
    };
    if (process.platform === 'win32') {
      const ps = 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.ExecutablePath)" }';
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 20000, maxBuffer: 32e6 }, (e, out) => parse(out, /^(\d+)\t(\d+)\t(.*)$/));
    } else if (process.platform === 'linux') {
      for (const name of fs.readdirSync('/proc').filter((x) => /^\d+$/.test(x))) {
        try {
          const stat = fs.readFileSync(`/proc/${name}/stat`, 'utf8');
          let exe = '';
          try { exe = fs.readlinkSync(`/proc/${name}/exe`); } catch (e) { /* 别人的进程读不到 */ }
          table.set(Number(name), { ppid: Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]), path: exe });
        } catch (e) { /* 进程刚退出 */ }
      }
      resolve(table);
    } else {
      execFile('ps', ['-A', '-o', 'pid=,ppid=,comm='], { timeout: 10000, maxBuffer: 32e6 }, (e, out) => parse(out, /^\s*(\d+)\s+(\d+)\s+(.*)$/));
    }
  });
}
// 启动链上的中间层：npx、node、shell 等，不算「启动它的程序」
const LAUNCHERS = new Set(['node', 'npm', 'npx', 'sh', 'bash', 'zsh', 'dash', 'fish', 'login', 'env', 'cmd', 'powershell', 'pwsh', 'conhost']);
function exeName(p) {
  return path.basename(String(p).replace(/\\/g, '/')).replace(/^-/, '').replace(/\.exe$/i, '').toLowerCase();
}
// 同一个程序：macOS 看所在的 .app（主进程和各种 Helper 都在里面），其他系统看可执行文件路径
function appKey(p) {
  const s = String(p).replace(/\\/g, '/').toLowerCase();
  const i = s.indexOf('.app/');
  return i >= 0 ? s.slice(0, i + 4) : s;
}
// 顺着父进程往上：跳过启动链上的中间层，找到第一个程序，再往上走到同一个程序的最外层进程。
// WorkBuddy 每条消息起的进程和主进程是同一个 .app，最后落到 WorkBuddy 主进程；终端里跑的 claude 就是 claude 自己
function ownerPid(table) {
  const chain = [];
  for (let pid = process.ppid; pid > 1 && table.has(pid) && !chain.includes(pid); pid = table.get(pid).ppid) chain.push(pid);
  // npx 起的进程会把名字改成「npm exec …」
  const launcher = (pid) => LAUNCHERS.has(exeName(table.get(pid).path)) || /^npm\b/i.test(table.get(pid).path);
  const i = chain.findIndex((pid) => !launcher(pid));
  if (i < 0) return process.ppid;
  let owner = chain[i];
  for (const pid of chain.slice(i + 1)) {
    if (appKey(table.get(pid).path) !== appKey(table.get(owner).path)) break;
    owner = pid;
  }
  return owner;
}
let ownerOnce = null;
function registerOwner() {
  if (!ownerOnce) ownerOnce = processTable().then(ownerPid, () => process.ppid).catch(() => process.ppid);
  return ownerOnce.then((owner) => new Promise((resolve) => {
    const req = http.request({ host: BRIDGE_HOST, port: PORT, path: '/api/owners', method: 'POST', headers: bridgeHeaders({ 'content-type': 'application/json' }) }, (res) => { res.resume(); resolve(); });
    req.on('error', () => resolve());
    req.end(JSON.stringify({ pids: [process.pid, owner] }));
  }));
}
// 订阅后台桥接的事件：脚本库变化、扩展连上时通知 AI 客户端重新拉工具列表。
// 断了就重连（桥接没了就重新起一个），重连上以后重新登记、通知一次
function watchBridge(reconnected) {
  let retried = false;
  const retry = () => setTimeout(async () => { if (await ensureBridge().catch(() => false)) watchBridge(true); else retry(); }, 2000);
  const again = () => { // end 和 error 可能都来：只重连一次
    if (retried) return;
    retried = true;
    retry();
  };
  const req = http.get({ host: BRIDGE_HOST, port: PORT, path: '/api/events', headers: bridgeHeaders() }, (res) => {
    if (res.statusCode !== 200) { res.resume(); return; } // 旧版桥接没有事件：不订阅
    registerOwner();
    if (reconnected) toolsChanged();
    res.setEncoding('utf8');
    let buf = '';
    res.on('data', (d) => {
      buf += d;
      for (let i; (i = buf.indexOf('\n\n')) >= 0; buf = buf.slice(i + 2)) if (buf.slice(0, i).includes('event: tools')) toolsChanged();
    });
    res.on('end', again);
    res.on('error', again);
  });
  req.on('error', again);
}

// 后台桥接：记下启动它的程序，这些程序都退出后关闭
const owners = new Set();
let everOwned = false;
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
if (DAEMON) {
  const started = Date.now();
  setInterval(() => {
    for (const pid of owners) if (!alive(pid)) owners.delete(pid);
    // 刚起来时给 stdio 实例 30 秒登记
    if (!owners.size && (everOwned || Date.now() - started > 30000)) {
      log('启动桥接的程序都已退出，桥接关闭');
      process.exit(0);
    }
  }, 2000);
}

// ======================= 脚本库副本、自动更新 =======================
const library = createLibrary(path.join(STATE_DIR, 'library'));
const canSync = (conn) => !conn.dead && (conn.capabilities || []).includes('librarySync');
const connCall = (conn) => (method, params, timeoutMs) => callConn(conn, method, params, timeoutMs);
function scheduleLibrarySync(conn) {
  if (!canSync(conn)) return;
  clearTimeout(conn.syncTimer);
  conn.syncTimer = setTimeout(() => runLibrarySync(conn), 300);
}
async function runLibrarySync(conn) {
  if (!canSync(conn)) return;
  if (conn.syncing) { conn.syncAgain = true; return; }
  conn.syncing = true;
  try {
    const offers = await syncBrowser(library, conn, connCall(conn), { extensionId: extensionOriginId(conn.origin), connected: new Set(instances.keys()), log });
    conn.libraryOffers = new Set(offers.map((x) => x.owner));
    await runSharedSync(conn);
  } catch (e) {
    if (!conn.dead) log(`同步脚本库失败：${e.message}`);
  } finally {
    conn.syncing = false;
    if (conn.syncAgain) { conn.syncAgain = false; scheduleLibrarySync(conn); }
  }
}
// 共享脚本：几个环境共用一个共享区，一次只处理一个环境；共享区变了就让其他环境也同步一次
const shared = createShared(path.join(STATE_DIR, 'shared'));
// instanceId 是扩展自己报的：要当共享区里的键用，只认正常的格式
const SHARE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const canShare = (conn) => canSync(conn) && conn.instanceId !== ANON_ID && SHARE_ID_RE.test(conn.instanceId || '')
  && !['__proto__', 'constructor', 'prototype'].includes(conn.instanceId) && (conn.capabilities || []).includes('sharedSync');
const envOf = (conn) => ({ instanceId: conn.instanceId, profile: conn.profile || '' });
let sharedQueue = Promise.resolve();
function sharedTask(fn) {
  const p = sharedQueue.then(fn);
  sharedQueue = p.catch(() => {});
  return p;
}
// 只同步共享脚本（不碰脚本库备份）：别的环境改了共享脚本、用户点了接收时
function scheduleSharedSync(conn) {
  if (!canShare(conn)) return;
  clearTimeout(conn.sharedTimer);
  conn.sharedTimer = setTimeout(() => runSharedSync(conn).catch((e) => { if (!conn.dead) log(`同步共享脚本失败：${e.message}`); }), 300);
}
function sharedChanged(conn) {
  for (const other of instances.values()) if (other !== conn) scheduleSharedSync(other);
  if (lan.running) lanBroadcast(); // 弹窗里「现在有几条共享的脚本」跟着变
}
function sharedCount() {
  try { return shared.list().filter((m) => !m.deleted).length; } catch (e) { return 0; }
}
// 和 syncBrowser 各取一次清单：备份那一步可能刚把脚本补回扩展，用它的清单会过时
async function runSharedSync(conn) {
  if (!canShare(conn)) return;
  const receive = conn.sharedReceive || new Set();
  conn.sharedReceive = null;
  let changed = false;
  try {
    ({ changed } = await sharedTask(() => syncEnv(shared, envOf(conn), connCall(conn), { receive, log })));
  } catch (e) {
    conn.sharedReceive = new Set([...receive, ...(conn.sharedReceive || [])]); // 用户点的接收留到下一轮
    throw e;
  }
  if (changed) sharedChanged(conn);
}
// 共享 / 停止共享：改完、再和这个环境对一次才回（弹窗等它回了才算完成：「停止共享」后马上删除不能被当成在共享时删的）
async function runShareSet(conn, id, on) {
  if (!canShare(conn) || typeof id !== 'string') throw new Error('这个扩展版本不支持共享');
  const notices = [];
  const changed = await sharedTask(() => (on ? shareOn(shared, envOf(conn), connCall(conn), id, { notices }) : shareOff(shared, envOf(conn), id)));
  if (changed) sharedChanged(conn);
  const r = await sharedTask(() => syncEnv(shared, envOf(conn), connCall(conn), { log }));
  if (r.changed) sharedChanged(conn);
  if (notices.length) callConn(conn, 'sharedState', { notices }, 10000).catch(() => {});
  return { notices, state: r.state };
}
// ---------- 局域网同步：这台电脑开端口给另一台读共享脚本；或者去读另一台的 ----------
// 开关只在开它的浏览器连着时有效：那个浏览器断开超过 LAN_GRACE_MS（关了浏览器）就关掉端口。
// 扩展的后台偶尔重启会断开一下，重连后会把开关再发过来
const lan = createLanServer({ shared, log });
const LAN_GRACE_MS = Number(process.env.PR_LAN_GRACE_MS) || 60000;
const LAN_PORT = Number(process.env.PR_LAN_PORT) || undefined; // 默认 17322，被占了往后找
const LAN_RECEIVE_MAX = 500;
const LAN_RECEIVE_MS = 10 * 60 * 1000;
const lanOwners = new Map(); // instanceId → { at: 断开的时间（0 = 连着）, profile }
let lanSession = ''; // 这次开启的编号，扩展记在会话里；关掉就作废
const lanClosed = new Set(); // 关掉过的编号：断线时错过了关闭通知的浏览器重连带着旧编号来，不再打开
let lanQueue = Promise.resolve(); // 开、关、自动关排队做
const lanSerial = (fn) => { const p = lanQueue.then(fn, fn); lanQueue = p.catch(() => {}); return p; };
const canLan = (conn) => !conn.dead && (conn.capabilities || []).includes('lanSync');
// 给弹窗看的：开着时还有是哪几个浏览器开的
const lanState = () => (lan.running ? { ...lan.info(), owners: [...lanOwners.values()].map((o) => o.profile || '未命名环境') } : { on: false });
function lanBroadcast() {
  const info = lanState();
  for (const c of instances.values()) if (canLan(c)) callConn(c, 'lanState', info, 10000).catch(() => {});
}
async function lanClose() {
  if (lanSession) lanClosed.add(lanSession);
  lanSession = '';
  lanOwners.clear();
  await lan.stop();
  lanBroadcast();
}
function lanOwnerGone(instanceId) {
  if (!lanOwners.has(instanceId)) return;
  lanOwners.set(instanceId, { ...lanOwners.get(instanceId), at: Date.now() });
  setTimeout(() => lanSerial(async () => {
    // 重连上来并且又发了开关的，at 已经回到 0；只连上没发（浏览器关了又开，会话里的开关没了）的照样算走了
    for (const [id, o] of lanOwners) if (o.at && Date.now() - o.at >= LAN_GRACE_MS) lanOwners.delete(id);
    if (!lanOwners.size && lan.running) await lanClose();
  }), LAN_GRACE_MS + 100).unref();
}
// 扩展发来的请求（带 req 编号）：做完把结果按编号发回去
function replyTo(conn, req, fn) {
  if (typeof req !== 'string' || !req || req.length > 64) return;
  Promise.resolve().then(fn).then(
    (data) => callConn(conn, 'bridgeReply', { req, ok: true, data }, 10000),
    (e) => callConn(conn, 'bridgeReply', { req, ok: false, error: e.message }, 10000),
  ).catch(() => {});
}
const lanTarget = (m) => ({ addr: typeof m.addr === 'string' ? m.addr : '', code: typeof m.code === 'string' ? m.code : '' });
const LAN_EVENTS = {
  lanSet(conn, m) {
    if (!canLan(conn)) throw new Error('这个扩展版本不支持局域网同步');
    const code = typeof m.code === 'string' ? m.code : '';
    return lanSerial(async () => {
      if (m.on !== true) { await lanClose(); return { on: false }; }
      // resume：扩展重连后按会话里记着的开关恢复。这次开启已经被关掉过就不再开；桥接重启过（不认识这个编号）就照旧开
      const resume = typeof m.resume === 'string' ? m.resume : null;
      if (resume !== null && (!resume || lanClosed.has(resume))) return { on: false };
      if (!lan.running) {
        await lan.start({ port: LAN_PORT, code });
        lanSession = resume || crypto.randomBytes(8).toString('hex');
      }
      // 开端口期间这个浏览器断开了：不登记（登记了就没人会再关它）
      if (conn.dead || instances.get(conn.instanceId) !== conn) {
        if (!lanOwners.size) await lanClose();
        throw new Error('浏览器连接断开了');
      }
      lanOwners.set(conn.instanceId, { at: 0, profile: conn.profile || '' });
      lanBroadcast();
      return { ...lanState(), session: lanSession };
    });
  },
  async lanList(conn, m) {
    const { addr, code } = lanTarget(m);
    return lanRequest(addr, code, 'list');
  },
  // 收到的复制一份进这个浏览器的脚本库（之后各管各的）。这里已有同一条的，只在它还是用户确认覆盖时的那个版本（expect）才覆盖。
  // 同一个浏览器一次只跑一批；整批有总时限，浏览器断开就停
  async lanReceive(conn, m) {
    if (!canShare(conn)) throw new Error('这个扩展版本不支持接收');
    if (conn.lanReceiving) throw new Error('上一批还在接收，等它完了再点');
    const { addr, code } = lanTarget(m);
    const all = (Array.isArray(m.ids) ? m.ids : []).filter((x) => typeof x === 'string' && SHARE_ID_RE.test(x));
    const expect = m.expect && typeof m.expect === 'object' ? m.expect : {};
    const call = connCall(conn);
    const out = { received: [], failed: all.slice(LAN_RECEIVE_MAX).map((id) => ({ id, error: `一次最多接收 ${LAN_RECEIVE_MAX} 条` })) };
    const deadline = Date.now() + LAN_RECEIVE_MS;
    conn.lanReceiving = true;
    try {
      for (const id of all.slice(0, LAN_RECEIVE_MAX)) {
        if (conn.dead || Date.now() > deadline) { out.failed.push({ id, error: conn.dead ? '浏览器连接断开了' : '这一批太久了，剩下的没接收' }); continue; }
        try {
          const want = Object.hasOwn(expect, id) && Number.isFinite(expect[id]) ? expect[id] : 0;
          const { item } = await lanRequest(addr, code, 'get', { id }, Math.min(120000, deadline - Date.now()));
          if (!item || item.id !== id) throw new Error('对方发来的不是这条脚本');
          if (conn.dead) throw new Error('浏览器连接断开了');
          const r = await sendItem(call, 'sharedApply', id, item, { expectAt: want, fromLan: true });
          if (!r || !r.ok) throw new Error(r && r.busy ? '这个浏览器正在录制或编辑这条脚本' : '这个浏览器里的这条在你确认后变过，没有覆盖；刷新后重新接收');
          out.received.push({ id, name: item.name });
        } catch (e) { out.failed.push({ id, error: e.message }); }
      }
    } finally { conn.lanReceiving = false; }
    return out;
  },
};
async function runLibraryRestore(conn, ownerId) {
  if (!canSync(conn) || typeof ownerId !== 'string') return;
  try {
    const n = await restoreOwner(library, conn, connCall(conn), ownerId, { extensionId: extensionOriginId(conn.origin), offered: conn.libraryOffers || new Set(), connected: new Set(instances.keys()), log });
    log(`已恢复 ${n} 条脚本到 ${browserLabel(conn)}`);
    scheduleLibrarySync(conn);
  } catch (e) { log(`恢复脚本失败：${e.message}`); }
}
// 从源码目录运行时不自动改东西（开发、跑测试）
const AUTO_UPDATE = !argv.includes('--no-auto-update') && process.env.PR_AUTO_UPDATE !== '0'
  && (process.env.PR_AUTO_UPDATE === '1' || !fs.existsSync(path.join(ROOT, '.git')));
const updater = createUpdater({ root: ROOT, version: VERSION, stateDir: STATE_DIR, home: os.homedir(), log });
// 连上来的扩展认不认：本机任何扩展都能连 ws://127.0.0.1:17321，连上就能收到 AI 发来的参数（包括密码）、读写脚本库备份。
// --extension-id 指定了就只认那些；设了 token 的连接本身要带口令，不再另外核对。都没设时：
// 要找得到它的安装目录、里面装的确实是 Page Recorder 才认（updater.extensionDir），认过的记下来；
// 找不到就拒绝，用户确认是自己装的可以用 `page-recorder-mcp trust <ID>` 手动放行。
// 第一个连上来的也一样要核对：升级时先连上来的不一定是原来那个
// （本机程序能伪造 Origin，那是本机进程能读你文件的情形，这里不防）
let trustedIds = new Set(readTrusted());
const rejectedIds = new Map(); // 扩展 ID → 最近一次被拒的时间，给 /api/status 看
const rejectCount = new Map(); // 扩展 ID → 连续被拒几次
let trustQueue = Promise.resolve();
const trustOpen = () => !EXT_ID_ALLOW.size && !TOKEN;
function trustExtension(id) {
  if (!trustOpen()) return Promise.resolve(!EXT_ID_ALLOW.size || EXT_ID_ALLOW.has(id));
  const run = trustQueue.then(async () => {
    trustedIds = new Set([...trustedIds, ...readTrusted()]); // 别的实例、trust 子命令可能刚记过
    if (trustedIds.has(id)) return true;
    // 刚拒过的先不再翻浏览器资料（扩展每 30 秒重连一次）：前 3 次只隔 3 秒（刚加载的扩展，浏览器可能还没把资料写盘），
    // 之后隔一分钟；trust 子命令放行后上面就认了
    if (Date.now() - (rejectedIds.get(id) || 0) < ((rejectCount.get(id) || 0) <= 3 ? 3000 : 60000)) return false;
    const dir = await updater.extensionDir(id).catch(() => '');
    if (!dir) {
      if (!rejectedIds.has(id)) log(`没认扩展 ${id}：找不到它的安装目录，确认不了是 Page Recorder。是你自己装的就运行 page-recorder-mcp trust ${id} 放行（装在指纹浏览器等自定义资料目录里的，也可以把资料目录写进 PR_BROWSER_DATA_DIRS）`);
      rejectedIds.set(id, Date.now());
      rejectCount.set(id, (rejectCount.get(id) || 0) + 1);
      return false;
    }
    trustedIds.add(id);
    rejectedIds.delete(id);
    rejectCount.delete(id);
    try { trustedIds = new Set(writeTrusted([id])); } catch (e) { log('记下认得的扩展失败：' + e.message); }
    log(`认下扩展 ${id}（安装目录 ${dir}）`);
    return true;
  });
  trustQueue = run.catch(() => false);
  return run;
}
const browserStatus = (c) => Object.assign(browserInfo(c), { version: c.version, extensionId: extensionOriginId(c.origin), capabilities: c.capabilities || [] });
// 这个进程可能只是转发的 stdio 实例：连着哪些浏览器要问监听端口的那个
function connectedBrowsers() {
  if (isPrimary) return Promise.resolve([...instances.values()].map(browserStatus));
  return new Promise((resolve) => {
    const req = http.get({ host: BRIDGE_HOST, port: PORT, path: '/api/status', headers: bridgeHeaders() }, (res) => {
      let d = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { d += c; });
      res.on('end', () => { try { resolve(JSON.parse(d).browsers || []); } catch (e) { resolve([]); } });
    });
    req.on('error', () => resolve([]));
    req.setTimeout(3000, () => req.destroy());
  });
}
let updateTimer = null;
let updateDue = 0;
let updateRunning = false;
let updateAgain = false; // 更新进行中又来了触发（比如扩展这时才连上）：这一轮看不到它，结束后再跑一轮
// 已经排了更早的一轮就不往后推（扩展刚连上排的 1.5 秒，不能被“忙，一分钟后再试”盖掉）
function scheduleAutoUpdate(ms = 1500) {
  if (!AUTO_UPDATE) return;
  const due = Date.now() + ms;
  if (updateTimer && updateDue <= due) return;
  clearTimeout(updateTimer);
  updateDue = due;
  updateTimer = setTimeout(() => { updateTimer = null; runAutoUpdate(); }, ms);
  updateTimer.unref();
}
async function runAutoUpdate() {
  if (updateRunning) { updateAgain = true; return; }
  updateRunning = true;
  updateAgain = false;
  try {
    // 技能更新失败不影响扩展更新
    const skills = await updater.updateSkills().catch((e) => { log(`更新技能失败：${e.message}`); return { retry: false }; });
    const r = await updater.updateExtensions(await connectedBrowsers(), (b, method, params, timeoutMs) => extCall(method, params, timeoutMs, b.instanceId, 0));
    if (skills.retry || r.retry) scheduleAutoUpdate(60000); // 扩展正忙（录制、回放中）或别的进程在更新：过一会儿再试
  } catch (e) {
    log(`自动更新失败：${e.message}`);
  } finally {
    updateRunning = false;
    if (updateAgain) scheduleAutoUpdate();
  }
}
libraryListeners.add(() => scheduleAutoUpdate());
ready.then(() => scheduleAutoUpdate(500));

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
const START_URL_PARAM = { type: 'string', description: '一般不用传。起始页面的地址带会过期的令牌、签名，站点又必须带有效的才能打开时（结果的 warnings 会提示），传用户这次拿到的新地址。必须是同一个页面（只有令牌、时间戳这类参数可以不同）。回放页面操作时一定用它打开；直接请求接口时只在要打开页面时用（已经开着同源页面就直接在那里发）' };
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
    description: '列出浏览器扩展脚本库中保存的所有录制脚本：名称、说明、起始页面、操作步骤、可修改的输入参数（params 是录制值，paramHelp 是每个参数怎么填：类型、格式、可选项、是否必填、改了能不能直接请求接口），以及每个接口拆分出的工具函数。脚本库大、整份放不下时改成分页给概要（名称、说明、参数名、接口函数名），细节用 get_recording、找接口用 search_apis。多个浏览器同时连着时汇总所有浏览器的脚本，每条带 browser 字段说明在哪个浏览器。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '可选。只列名称、说明、起始页面里有这些关键词的脚本（空格分开，都要有）' },
        offset: { type: 'number', description: '可选。脚本多、分页给概要时从第几条开始' },
        limit: { type: 'number', description: '可选。最多给几条' },
        browser: Object.assign({}, BROWSER_PARAM, { description: '可选。只列某一个浏览器的脚本：填 instanceId 或资料名。不传则列出所有连着的浏览器的脚本' }),
      },
    },
  },
  {
    name: 'search_apis',
    description: `按关键词在脚本库里找接口，返回每个接口属于哪个脚本、接口名、用途、参数名；再用 call_api 调用（recording 填 recording_id，api 填接口名，args 填参数）。脚本和接口拆出的工具超过 ${MAX_TOOLS} 个时不再逐个列成工具（工具定义太多 AI 放不下），这时就用它找接口。不传 query 是按顺序列出全部接口。`,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词，空格分开，如 "订单 导出"、"refund list"。在脚本名、接口名、函数名、用途、参数名和参数说明里找；都匹配的排前面' },
        recording: { type: 'string', description: '可选。只在这个脚本里找（脚本 id 或名称）' },
        detail: { type: 'boolean', description: '可选。带上每个接口完整的参数定义（类型、说明、录制值）。不传时结果不超过 3 个才带' },
        offset: { type: 'number', description: '可选。从第几个结果开始，默认 0' },
        limit: { type: 'number', description: '可选。最多给几个，默认 20' },
        browser: BROWSER_PARAM,
      },
    },
  },
  {
    name: 'get_recording',
    description: '获取某个录制脚本的详细信息：每一步操作、输入参数说明（paramHelp / paramInfo：类型、格式、全部可选项、是否必填、关联的接口字段）、每个接口的 URL / 参数 / 参数说明 / 响应结构 / 响应示例 / 用途说明。分析接口用途前先调用它。内容太多时先返回概要（步骤、参数、接口目录）和 result_id，某个接口的详情用 read_result 取 path="apis[序号]"，也可以直接带 result_path。',
    inputSchema: { type: 'object', properties: { recording: { type: 'string', description: '脚本 id 或名称' }, browser: BROWSER_PARAM, ...RESULT_PROPS }, required: ['recording'] },
  },
  {
    name: 'run_recording',
    description: '在用户的浏览器中（带登录态）运行录制脚本。默认：录制里有接口关联了输入参数时，不操作页面，直接在已开着的页面里请求这些接口（快，第二次起复用页面；带页面最新的登录/签名请求头；业务返回码不对时自动改为回放页面操作、由页面自己发请求；写接口只有 401/403 或没发出去时才自动回放，其他失败返回 writeRejected，先确认有没有生效）；否则回放页面操作（真实鼠标键盘输入）。接口带页面每次现算的反爬串时自动回放页面操作。起始地址带会过期的参数（令牌、签名、时间戳）时，依次用：调用时传的 start_url、开着的同一页面现在的地址、录制时的来源页上指向它的链接、去掉这些参数再打开（结果里 startPage；跳到别的页面时 warnings 会说明）。返回接口数据(responses)、提取数据(extracted)、执行记录(log)、用的标签页(tab)。可修改输入参数（输入框、日期、下拉、上传文件路径）和接口请求参数。',
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
        start_url: START_URL_PARAM,
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
    description: '不回放页面操作，直接调用录制中的某个接口：在已经开着的同源页面里发请求（带浏览器的 Cookie、登录态，鉴权头用页面最新的值），没有就在后台打开一次并留着，之后的调用直接复用，很快。返回接口数据。参数可以是扁平的工具参数，也可以是 {path, query, body} 结构；未传的参数使用录制值。'
      + '会自己处理会过期的东西，不用你拼地址或签名：字段的值是别的接口发放的（票据、带令牌的地址），先调那个接口拿新值（结果里 chained）；接口带页面每次现算的反爬串（如拼多多 anti-content / crawlerInfo，结果里 pageGenerated），不发旧值，改为只重做发出它的那一步、让页面自己发（结果里 via="page"）；页面地址带会过期的参数时用开着的同一页面或去掉这些参数再打开（结果里 page）。'
      + '失败时按结果里的 error 和 next 做：next 是下一步该调的工具和参数，照着调即可。',
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
    description: '从上一次 run_recording / call_api / 接口工具 / get_recording 的结果里取一部分，不会再调接口。结果太大时那些工具只返回压缩过的预览和 result_id，用这个工具按路径取具体数据：path 指到某个对象或数组（预览里省略的地方都写了路径），数组用 offset / limit 分页，fields 只留每一项里要的字段。例：path="responses[0].data.data.result.data.table.dataSource"，fields=["itemId","itemDesc.desc[0].text","managerPrice.currentPrice"]。',
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
    description: '获取录制脚本的 JavaScript 源码（可直接粘贴到浏览器控制台或用 Playwright page.evaluate 执行）。源码长时按行分段返回，开头写着总行数和下一段从哪行开始；要整份源码用 to_file=true 写成文件。',
    inputSchema: {
      type: 'object',
      properties: {
        recording: { type: 'string', description: '脚本 id 或名称' },
        start_line: { type: 'number', description: '从第几行开始读，默认 1' },
        line_count: { type: 'number', description: '最多读几行（还受 max_chars 限制）' },
        max_chars: { type: 'number', description: `这次最多返回多少字符，默认 ${RESULT_CHARS}` },
        to_file: { type: 'boolean', description: '把整份源码写到本机文件（~/.page-recorder/exports/），只返回文件路径' },
        browser: BROWSER_PARAM,
      },
      required: ['recording'],
    },
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
    name: 'merge_recordings',
    description: '把脚本库里的几条脚本按给定顺序接成一条新脚本（原来的不动），返回新脚本的 id、步骤和输入参数。用法：先用 get_recording 看每条的起始页面和步骤，排好先后（登录在前；前一段拿到的数据是后一段的输入时前一段在前），后面几段重复的打开首页、登录用 from_step 截掉；合并后用 get_recording 核对，再用 save_api_docs 起名、写接口说明。第二段起每段开头直接打开它的起始页面（截掉了开头时打开截取后第一步所在的页面）。几段在同一个输入框里输入过时，前面几次的参数名带“_第N次”。只给一段时就是把这条脚本的一部分另存成新脚本。',
    inputSchema: {
      type: 'object',
      properties: {
        parts: {
          type: 'array',
          description: '按执行顺序排好的各段，1 到 20 段',
          items: {
            type: 'object',
            properties: {
              recording: { type: 'string', description: '脚本 id 或名称' },
              from_step: { type: 'number', description: '可选。从第几步开始（get_recording 里的步骤号，从 1 开始），默认 1' },
              to_step: { type: 'number', description: '可选。到第几步为止（含这一步），默认到最后一步' },
            },
            required: ['recording'],
          },
        },
        name: { type: 'string', description: '可选。新脚本的名字，默认把各段的名字用“ + ”连起来' },
        description: { type: 'string', description: '可选。新脚本完成了什么流程' },
        browser: Object.assign({}, BROWSER_PARAM, { description: '可选。多个浏览器资料都装了扩展时，指定用哪个浏览器的脚本库：填 instanceId 或资料名。各段必须在同一个浏览器里；不传时按第一段的脚本找' }),
      },
      required: ['parts'],
    },
  },
  {
    name: 'export_package',
    description: '把录制脚本导出成录制包（JSON，已脱敏：不含密码、登录令牌等），写成本机文件（~/.page-recorder/exports/<名称>-<时间>.prpkg.json），返回文件路径和概况；包不大时也直接带上内容（通过 HTTP /mcp 调用时直接返回内容，不写文件）。用来换电脑、发给同事或备份；用 import_package（传 file）或扩展弹窗「脚本库 → 导入录制包」导回。',
    inputSchema: { type: 'object', properties: { recording: { type: 'string', description: '脚本 id 或名称' }, browser: BROWSER_PARAM }, required: ['recording'] },
  },
  {
    name: 'import_package',
    description: '把录制包（export_package 导出的文件，或扩展弹窗导出的 .prpkg.json）导入浏览器扩展的脚本库，成为一条新脚本，返回新脚本的 id 和名称。pkg（JSON 内容）和 file（文件路径）给一个，包大时用 file。通过 HTTP（/mcp）调用时桥接服务必须设置了 token。',
    inputSchema: {
      type: 'object',
      properties: {
        pkg: { type: 'object', description: '录制包 JSON：{ "format": "page-recorder-package", "version": 1, "name": …, "item": {…} }；扩展「导出 JSON」的内容也行', additionalProperties: true },
        file: { type: 'string', description: '录制包文件的路径（.json 结尾，如 export_package 返回的 file）' },
        browser: Object.assign({}, BROWSER_PARAM, { description: '可选。多个浏览器资料都装了扩展时，指定导入到哪个浏览器：填 instanceId 或资料名。只连着一个浏览器时不用传' }),
      },
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
const ownValue = (obj, key) => obj && Object.hasOwn(obj, key) ? obj[key] : undefined;
function paramHelps(r) {
  const out = Object.create(null);
  const names = new Set(Object.keys(r.params || {}).concat(Object.keys(r.paramInfo || {})));
  for (const k of names) out[k] = paramHelp(ownValue(r.paramInfo, k), ownValue(r.params, k));
  return out;
}
// 接口工具参数说明里，关联了输入参数的字段“录制值”显示成 {{参数}}：换成真实录制值，并注明关联的参数名
function linkedText(desc, r) {
  if (typeof desc !== 'string' || !desc.includes('{{')) return desc;
  const names = [];
  const out = desc.replace(/\{\{([^{}|]+)(?:\|[^{}]*)?\}\}/g, (m, ref) => {
    const name = ref.trim();
    const info = ownValue(r.paramInfo, name);
    const param = ownValue(r.params, name);
    if (!info && param === undefined) return m;
    if (!names.includes(name)) names.push(name);
    const v = info && info.recorded !== undefined ? info.recorded : param;
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
// tools/list 不能久等：WorkBuddy 等客户端拉工具列表约 10 秒就超时，超时后一个工具都不给 AI。
// 所以 quick（tools/list）时连等后台桥接、等扩展一共最多等 6 秒，没等到先只给固定工具：
// 扩展连上后会发 tools/list_changed；列表晚到的话先存着再发一次，客户端重新拉时直接用
const LIST_DEADLINE_MS = 6000;
let lateList = null; // { list, at }
async function dynamicTools(quick) {
  let list = [];
  if (quick && lateList && Date.now() - lateList.at < 60000) {
    list = lateList.list;
    lateList = null;
  } else if (quick) {
    const listing = extCall('list', {}, 15000, '', 2000);
    const late = {};
    const got = await Promise.race([listing.catch(() => []), sleep(LIST_DEADLINE_MS).then(() => late)]);
    if (got === late) {
      const gen = indexGen;
      listing.then((l) => { if (gen === indexGen) { lateList = { list: l, at: Date.now() }; toolsChanged(); } }, () => {});
      return [];
    }
    list = got;
  } else {
    try { list = await extCall('list', {}, 15000); } catch (e) { return []; }
  }
  const nextMap = new Map();
  const tools = [];
  const used = new Set(STATIC_TOOLS.map((t) => t.name));
  // 多个浏览器同时连着：工具说明里注明是哪个浏览器的脚本，调用时直接发给那个浏览器
  const multi = new Set(list.map((r) => r.browser && r.browser.instanceId)).size > 1;
  // 同一条脚本（共享的、恢复来的）在几个浏览器里都一样：只列一套工具，调用时必须指定在哪个浏览器执行。
  // 参数、接口不一样的（停止共享后各改各的）还是各列各的
  const allBrowsers = [...new Map([...list.map((r) => r.browser).filter(Boolean), ...[...instances.values()].map(browserInfo)].map((b) => [b.instanceId, b])).values()];
  const groups = new Map();
  for (const r of list) {
    const tools = (r.tools || []).map((t) => [t.name, t.api, t.inputSchema]).sort((x, y) => String(x[0]).localeCompare(String(y[0])));
    const key = JSON.stringify([r.id, Object.keys(r.params || {}).sort(), r.paramInfo || {}, !!r.dynamicStart, tools]);
    groups.set(key, [...(groups.get(key) || []), r]);
  }
  for (const copies of groups.values()) {
    const r = copies.reduce((a, b) => ((b.savedAt || 0) > (a.savedAt || 0) ? b : a));
    const pickFrom = copies.length > 1 ? copies.map((x) => x.browser).filter(Boolean) : [];
    const pick = pickFrom.length > 1 ? browserChoices(pickFrom, allBrowsers) : null;
    const base = slug(r.slug || r.name, 'rec_' + String(r.id).slice(0, 6));
    const where = pick ? ` · 浏览器 ${pick.join('、')}` : multi && r.browser ? ` · 浏览器 ${r.browser.profile || r.browser.instanceId}` : '';
    const browser = !pick && r.browser ? r.browser.instanceId : '';
    // 加上选浏览器的参数（和脚本自己的参数重名时换个名字）
    const withPick = (schema, info) => {
      if (!pick) return { schema, info };
      const props = schema.properties || {};
      let arg = 'browser';
      for (let i = 2; props[arg]; i++) arg = i === 2 ? 'pr_browser' : `pr_browser_${i}`;
      // 选项 → instanceId：调用时只按这个精确的 id 发，资料名改了、和别人的 id 撞了都不会发错
      const target = Object.fromEntries(pick.map((v, i) => [v, pickFrom[i].instanceId]));
      return {
        schema: { ...schema, properties: { ...props, [arg]: { type: 'string', enum: pick, description: `必填。这条脚本在这几个浏览器里都有，填在哪个执行：${pick.join('、')}` } }, required: [...(schema.required || []), arg] },
        info: { ...info, browsers: pick, browserTarget: target, browserArg: arg },
      };
    };
    const add = (name, def0, info0) => {
      const { schema, info } = withPick(def0.inputSchema, info0);
      const def = { ...def0, inputSchema: schema };
      let n = name.slice(0, 64);
      let i = 2;
      while (used.has(n)) n = (name.slice(0, 60) + '_' + i++).slice(0, 64);
      used.add(n);
      nextMap.set(n, info);
      tools.push(Object.assign({ name: n }, def));
    };
    // 每个参数的说明：类型、格式、可选项、是否必填、改了能不能直接请求（扩展没给 paramInfo 时退回只写录制值）
    const props = Object.create(null);
    const required = [];
    for (const [k, v] of Object.entries(r.params || {})) {
      const info = ownValue(r.paramInfo, k);
      // 多选参数是选项数组，复选框是 true/false
      props[k] = Array.isArray(v) ? { type: 'array', items: { type: 'string' }, description: paramHelp(info, v) } : typeof v === 'boolean' ? { type: 'boolean', description: paramHelp(info, v) } : { type: 'string', description: paramHelp(info, v) };
      if (info && (info.required || info.kind === 'secret')) required.push(k);
    }
    for (const [k, info] of Object.entries(r.paramInfo || {})) {
      if (props[k]) continue;
      props[k] = { type: 'string', description: paramHelp(info, undefined) };
      if (info && (info.required || info.kind === 'secret')) required.push(k);
    }
    // 起始地址带会过期的参数：多给一个 start_url（和输入参数重名时不给）
    const startArg = !!r.dynamicStart && !props.start_url;
    add(`${base}__run`, {
      description: `[录制脚本「${r.name}」${where}] ${r.description || (r.steps || []).slice(0, 6).join('；')}。传入参数后运行：有关联接口时直接在页面里请求接口（不操作界面），否则回放页面操作。返回接口数据与提取数据。`,
      inputSchema: Object.assign({ type: 'object', properties: Object.assign(Object.create(null), RESULT_PROPS, startArg ? { start_url: START_URL_PARAM } : {}, props), additionalProperties: true }, required.length ? { required } : {}),
    }, { kind: 'run', recording: r.id, name: r.name, browser, own: Object.keys(props), startArg });
    for (const t of r.tools || []) {
      add(`${base}__${t.name}`, {
        description: `[录制脚本「${r.name}」${where} ${t.api}] ${t.description}`,
        inputSchema: withResultProps(fixToolSchema(t.inputSchema, r)),
      }, { kind: 'call', recording: r.id, name: r.name, api: t.api, browser, own: Object.keys((t.inputSchema && t.inputSchema.properties) || {}) });
    }
  }
  dynamicMap = nextMap;
  // 太多就一个都不列：只列一部分的话 AI 会以为没列出来的接口不存在。按名字调用照旧能用（dynamicMap 留着）
  return tools.length > MAX_TOOLS ? [] : tools;
}

// ---------------- 脚本库大时按需找接口（search_apis）、list_recordings 给概要 ----------------
const lower = (x) => String(x == null ? '' : x).toLowerCase();
const termsOf = (q) => lower(q).split(/[\s,，、;；]+/).filter(Boolean);
// 一个关键词在一段文字里算不算有：直接包含；中文没有空格分词，连着写的词（“订单导出”）按相邻两个字拆开，过半出现也算（分数减半）
function termHit(term, hay) {
  if (hay.includes(term)) return 1;
  if (term.length < 3 || !/[\u3400-\u9fff]/.test(term)) return 0;
  let hit = 0;
  for (let i = 0; i + 1 < term.length; i++) if (hay.includes(term.slice(i, i + 2))) hit++;
  return hit * 2 >= term.length - 1 ? 0.5 : 0;
}
// 按分数从高到低排；所有关键词都有的排在只有一部分的前面，一个都没有的不要
function rank(items, terms, fieldsOf) {
  if (!terms.length) return { hits: items, all: true };
  const scored = [];
  for (const item of items) {
    const fields = fieldsOf(item); // [[权重, 文字]]
    let score = 0;
    let matched = 0;
    for (const term of terms) {
      const best = Math.max(0, ...fields.map(([w, hay]) => w * termHit(term, hay)));
      if (best > 0) matched++;
      score += best;
    }
    if (matched) scored.push({ item, score, full: matched === terms.length });
  }
  const all = scored.some((x) => x.full);
  return { hits: scored.filter((x) => x.full === all).sort((a, b) => b.score - a.score).map((x) => x.item), all };
}
const pageArgs = (args, dflt) => ({
  offset: Math.max(0, Math.floor(Number(args.offset)) || 0),
  limit: Math.floor(Number(args.limit)) > 0 ? Math.floor(Number(args.limit)) : dflt,
});
// 从 offset 起尽量多放，放到 limit 条或长度上限为止（至少放一条）。一条就超长时 wrap 的第三个参数是还能用多少字符，由它把这一条写短
function fitPage(hits, offset, limit, wrap) {
  const page = hits.slice(offset, offset + limit);
  for (let n = page.length; n >= 1; n = n > 8 ? Math.floor(n * 0.75) : n - 1) {
    const t = JSON.stringify(wrap(page.slice(0, n), n), null, 2);
    if (t.length <= RESULT_CHARS) return t;
  }
  if (!page.length) return JSON.stringify(wrap([], 0), null, 2);
  for (let room = Math.floor(RESULT_CHARS / 2); ; room = Math.floor(room / 2)) {
    const t = JSON.stringify(wrap(page.slice(0, 1), 1, room), null, 2);
    if (t.length <= RESULT_CHARS || room < 1) return t;
  }
}
// 名字列表太长时只留开头的，末尾写明还有多少
function names(list, room) {
  if (room == null) return list;
  const out = [];
  let used = 0;
  for (const x of list) {
    used += String(x).length + 8;
    if (used > room) { out.push(`…还有 ${list.length - out.length} 个`); break; }
    out.push(x);
  }
  return out;
}
function sameRecording(r, ref) {
  const x = String(ref).trim();
  return r.id === x || r.name === x || String(r.name || '').includes(x);
}
function searchApis(list, args) {
  let recs = list;
  if (args.recording) {
    recs = list.filter((r) => r.id === String(args.recording).trim());
    if (!recs.length) recs = list.filter((r) => sameRecording(r, args.recording));
    if (!recs.length) throw new Error(`脚本库里没有「${args.recording}」。用 list_recordings 看有哪些脚本`);
  }
  const multi = new Set(list.map((r) => r.browser && r.browser.instanceId)).size > 1;
  const entries = [];
  for (const r of recs) {
    for (const t of r.tools || []) {
      const schema = fixToolSchema(t.inputSchema, r) || {};
      entries.push({ r, t, schema, params: Object.keys(schema.properties || {}) });
    }
  }
  const terms = termsOf(args.query);
  const { hits, all } = rank(entries, terms, (e) => [
    [3, lower(`${e.t.name} ${e.t.api}`)],
    [2, lower(e.t.description)],
    [1, lower(`${e.r.name} ${e.r.slug || ''} ${e.r.description || ''}`)],
    [1, lower(e.params.join(' ') + ' ' + Object.values(e.schema.properties || {}).map((p) => (p && p.description) || '').join(' '))],
  ]);
  const { offset, limit } = pageArgs(args, 20);
  const shown = Math.min(limit, Math.max(0, hits.length - offset));
  const detail = args.detail != null ? !!args.detail : shown > 0 && shown <= 3;
  return fitPage(hits, offset, limit, (page, n, room) => {
    const out = { total: hits.length, offset, count: n };
    const full = detail && room == null; // 一个接口的参数定义就超长：只给参数名
    out.apis = page.map((e) => Object.assign(
      { recording: clip(e.r.name, 200), recording_id: e.r.id, api: String(e.t.api).length > 300 ? e.t.name : e.t.api, fn: e.t.name, description: clip(e.t.description, room != null ? Math.min(200, room) : detail ? 600 : 200) },
      // 资料名可能重复，给 instanceId 才能原样填回 browser
      multi && e.r.browser ? Object.assign({ browser: e.r.browser.instanceId }, e.r.browser.profile ? { browser_name: e.r.browser.profile } : {}) : {},
      // api 要原样填回 call_api，不能截短：名字太长时上面给的是函数名（call_api 也认），原名截短放这里
      String(e.t.api).length > 300 ? { api_name: clip(e.t.api, 300) } : {},
      full ? { inputSchema: e.schema } : { params: names(e.params, room) },
    ));
    if (offset + n < hits.length) out.next_offset = offset + n;
    const notes = [];
    if (!hits.length) notes.push(terms.length ? `没有接口匹配「${args.query}」（共 ${entries.length} 个接口）。换个关键词，或不传 query 按顺序看全部` : '脚本库里没有可调用的接口');
    else {
      if (terms.length > 1 && !all) notes.push('没有接口同时匹配所有关键词，这里是匹配了一部分的');
      notes.push(`调用：call_api，recording 填 recording_id，api 填接口名，args 填参数（不传的用录制值）${multi ? '，browser 填上面的 browser' : ''}。${full ? '' : detail ? '这个接口的参数定义太长放不下，用 get_recording 看。' : '参数的类型、说明、录制值：带 detail=true，或把关键词写具体些。'}整段运行脚本用 run_recording`);
      if (out.next_offset != null) notes.push(`还有 ${hits.length - offset - n} 个，接着看用 offset=${out.next_offset}`);
    }
    out.note = notes.join('；');
    return out;
  });
}
// list_recordings：整份放得下就整份给（和以前一样）；放不下、或要求分页时给概要
function recordingList(list, args) {
  const terms = termsOf(args.query);
  const ranked = rank(list, terms, (r) => [[2, lower(`${r.name} ${r.slug || ''}`)], [1, lower(`${r.description || ''} ${r.startUrl || ''}`)]]);
  const hits = ranked.all ? ranked.hits : []; // 这里是筛选：关键词都要有，不像 search_apis 那样退到只匹配一部分
  const paged = args.offset != null || args.limit != null;
  if (!paged) {
    const full = JSON.stringify(hits.map((r) => forAi(r, false)), null, 2);
    if (full.length <= RESULT_CHARS) return full;
  }
  const { offset, limit } = pageArgs(args, 50);
  return fitPage(hits, offset, limit, (page, n, room) => {
    const out = { total: hits.length, offset, count: n };
    out.recordings = page.map((r) => Object.assign(
      { id: r.id, name: clip(r.name, 200) },
      r.slug ? { slug: clip(r.slug, 200) } : {},
      { description: clip(r.description || (r.steps || []).slice(0, 4).join('；'), 200), startUrl: clip(r.startUrl, 120), steps: (r.steps || []).length, params: names(Object.keys(Object.assign({}, r.paramInfo, r.params)), room), apis: names((r.tools || []).map((t) => t.name), room) },
      r.browser ? { browser: r.browser } : {},
    ));
    if (offset + n < hits.length) out.next_offset = offset + n;
    out.note = `脚本库整份放不下，这里是概要：params 是输入参数名，apis 是接口的函数名。某个脚本的步骤、参数怎么填、接口详情用 get_recording；按关键词找接口用 search_apis（可带 recording 只在一个脚本里找）${out.next_offset != null ? `；还有 ${hits.length - offset - n} 条，接着看用 offset=${out.next_offset}` : ''}`;
    return out;
  });
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
// 从文件读录制包：只读 .json 文件，报错时不带出文件内容，HTTP 模式下限定在 exports 目录内
function readPkgFile(file, restrictDir) {
  const raw = String(file);
  const f = path.resolve(raw.replace(/^~(?=$|[\\/])/, os.homedir()));
  const shown = raw.startsWith('~') ? raw : f;
  if (!/\.json$/i.test(f)) throw new Error('录制包文件要以 .json 结尾（export_package 导出的是 .prpkg.json）');
  if (restrictDir) {
    const root = path.resolve(restrictDir);
    const rel = path.relative(root, f);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('HTTP 模式下只能从导出目录导入录制包文件');
  }
  let st;
  try { st = fs.statSync(f); } catch (e) { throw new Error('读不到录制包文件：' + shown); }
  if (restrictDir) {
    const rootReal = fs.existsSync(restrictDir) ? fs.realpathSync(restrictDir) : path.resolve(restrictDir);
    const fileReal = fs.realpathSync(f);
    const relReal = path.relative(rootReal, fileReal);
    if (relReal.startsWith('..') || path.isAbsolute(relReal)) throw new Error('HTTP 模式下只能从导出目录导入录制包文件');
  }
  if (!st.isFile() || st.size > 50 * 1024 * 1024) throw new Error('不是录制包文件，或文件超过 50MB：' + shown);
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { throw new Error('录制包文件不是合法的 JSON：' + shown); }
  return parsePkg(pkg);
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
const setOwn = (o, k, v) => Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
const hasOwnKey = (o, t) => (Array.isArray(o) ? typeof t === 'number' && t >= 0 && t < o.length : Object.hasOwn(o, t));
// lazy：路上遇到 JSON 字符串就解析了接着往里走
function pathGet(v, p, lazy) {
  for (const t of pathTokens(p)) {
    if (lazy) v = jsonObj(v);
    if (v == null || typeof v !== 'object' || !hasOwnKey(v, t)) return undefined;
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
  for (const k of Object.keys(v)) setOwn(o, k, unwrapJson(v[k], notes, pathJoin(path, k), strDepth, depth + 1));
  return o;
}
// 说明结果成败的字段：对象再宽也先留着它们
const STATE_KEY = /^(ok|error|errors|err|status|code|success|message|msg|ret|rejected|writeRejected|unknown|notSent|warnings|mode|total|count|result_id)$/i;
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
  shown.forEach((k, i) => { setOwn(out, k, picked[i]); });
  if (keys.length > shown.length) setOwn(out, '…', `共 ${keys.length} 个字段，这里是 ${shown.length} 个。其余：read_result path=${JSON.stringify(path)}，fields 写字段名`);
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
      if (cur == null || typeof cur !== 'object' || !hasOwnKey(cur, t)) break;
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
  for (const f of fields) setOwn(out, f, compactValue(x[f], pathAdd(itemPath, f), each - f.length - 4));
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
// 直接请求没成功：不按 result_path 截取（失败时 data 里没有要的那部分），整个给出来，AI 才看得到 error 和 next
const callResult = (result, args, own) => (result && typeof result === 'object' && result.ok === false
  ? text(aiText(result, { result_max_chars: resultOpts(args || {}, own).result_max_chars }))
  : aiResult(result, args, own));

// get_recording：接口多、响应示例长时整份有十几万字符，客户端放不下。先给概要（步骤、参数、接口目录），
// 完整内容留在桥接里，用 read_result 按 apis[i] 取某个接口；带了 result_path 等参数就直接按参数取
function recordingDetail(full, args) {
  const opts = resultOpts(args);
  if (Object.keys(opts).length || jsonLen(full) <= RESULT_CHARS) return aiResult(full, args);
  const id = saveResult(full, jsonBytes(full));
  if (!id) return aiResult(full, args); // 留不下：按结构压缩的预览
  const o = { result_id: id };
  const SHOWN = ['id', 'name', 'description', 'startUrl', 'steps', 'params', 'paramHelp'];
  for (const k of SHOWN) if (full[k] !== undefined) o[k] = full[k];
  o.apis = (full.apis || []).map((a, i) => ({ path: `apis[${i}]`, fn: a.fn, name: a.name, title: a.title || undefined, ignore: a.ignore || undefined, count: a.count }));
  o.tools = (full.tools || []).map((t) => t.name);
  const rest = Object.keys(full).filter((k) => !SHOWN.includes(k) && k !== 'apis').map((k) => `"${k}"`);
  o.note = `完整内容共 ${sizeText(jsonLen(full))}，这里只给概要。某个接口的 URL、参数、参数说明、响应结构、响应示例用 read_result 取：result_id="${id}"，path 写上面 apis 里的 path（如 "apis[0]"），只看几项加 fields（如 ["url","params","responseSchema"]）。${rest.length ? `其他部分的 path：${rest.join('、')}（paramInfo 是参数的完整说明，tools 是各接口工具的参数定义，analysisPrompt 是分析接口用的提示词）。` : ''}result_id 过期了就重新调用 get_recording 并直接带 result_path`;
  const t = JSON.stringify(o, null, 2);
  return t.length <= RESULT_CHARS ? text(t) : text(aiText(full, {}, { id, entry: savedResult(id) }));
}
// get_script：按行分段。开头一行注释写总行数和下一段从哪行开始
function scriptPart(script, args) {
  const budget = Math.max(2000, Math.min(400000, Math.floor(Number(args.max_chars)) || RESULT_CHARS));
  if (args.start_line == null && args.line_count == null && script.length <= budget) return script;
  const lines = script.split('\n');
  const start = Math.min(lines.length, Math.max(1, Math.floor(Number(args.start_line)) || 1));
  const want = Math.floor(Number(args.line_count)) > 0 ? Math.floor(Number(args.line_count)) : Infinity;
  const out = [];
  let used = 0;
  for (let i = start - 1; i < lines.length && out.length < want; i++) {
    let line = lines[i];
    if (used + line.length + 1 > budget - 300) {
      if (out.length) break;
      line = clip(line, budget - 400); // 一行就超长：截断着给
    }
    out.push(line);
    used += line.length + 1;
  }
  const end = start + out.length - 1;
  const next = end < lines.length ? `接着读用 start_line=${end + 1}；` : '已经到结尾；';
  return `// 源码共 ${lines.length} 行、${script.length} 字符，这里是第 ${start}-${end} 行。${next}要整份源码用 to_file=true 写成文件\n${out.join('\n')}`;
}
// 大块内容写成本机文件给 AI：放在 STATE_DIR/exports，文件名带时间不会覆盖
let httpExportBytes = 0;
function writeExport(name, ext, content, via) {
  const bytes = Buffer.byteLength(content);
  if (via === 'http' && (bytes > 16 * 1024 * 1024 || httpExportBytes + bytes > 64 * 1024 * 1024)) {
    throw new Error('HTTP 写盘额度已满，请改用 start_line 分段读取');
  }
  const dir = path.join(STATE_DIR, 'exports');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const base = path.join(dir, `${String(name || 'recording').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60)}-${new Date().toISOString().replace(/\D/g, '').slice(0, 17)}`);
  for (let i = 1; ; i++) {
    const file = base + (i > 1 ? '-' + i : '') + ext;
    try {
      fs.writeFileSync(file, content, { mode: 0o600, flag: 'wx' });
      if (via === 'http') httpExportBytes += bytes;
      return file;
    } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
}
// ctx.via：'stdio' = 本进程的 MCP stdio；'http' = /mcp 接口
async function callTool(name, args, ctx) {
  args = args || {};
  ctx = ctx || {};
  const browser = args.browser;
  switch (name) {
    case 'list_recordings': return text(recordingList(await extCall('list', {}, 60000, browser), args));
    case 'search_apis': return text(searchApis(await extCall('list', {}, 60000, browser), args));
    case 'get_recording': return recordingDetail(forAi(await extCall('get', { recording: args.recording }, 60000, browser), true), args);
    case 'get_script': {
      if (args.to_file && ctx.via === 'http' && !ctx.canWrite) throw new Error('HTTP 写盘需要本机认证，请改用 start_line 分段读取');
      const r = await extCall('script', { recording: args.recording }, 60000, browser);
      if (args.to_file) {
        const lines = String(r.script || '').split('\n').length;
        return text({ file: writeExport(r.name || args.recording, '.js', r.script || '', ctx.via), lines, chars: String(r.script || '').length });
      }
      return text(scriptPart(String(r.script || ''), args));
    }
    case 'run_recording': {
      const timeout = Number(args.timeout_ms) || 180000;
      return aiResult(await extCall('run', { recording: args.recording, params: args.params, apiParams: args.api_params, mode: args.mode, keepTab: args.keep_tab, newTab: !!args.new_tab, fresh: !!args.fresh, active: !!args.visible, startUrl: args.start_url, timeout }, timeout + 30000, browser), args);
    }
    case 'call_api': return callResult(await extCall('call', { recording: args.recording, api: args.api, args: args.args || {} }, 90000, browser), args);
    case 'read_result': {
      const entry = savedResult(args.result_id);
      if (!entry) throw new Error(`result_id ${args.result_id || '（没给）'} 已经不在了：只留最近 ${RESULT_KEEP} 次、30 分钟内的结果，MCP 进程重启后清空（有的 AI 工具每条消息都重启一次，上一条消息的结果读不到）。请重新调用并直接带 result_path / result_fields 取要的部分；get_recording 也一样，如 result_path="apis[3]"`);
      return text(aiText(entry.raw, { result_path: args.path == null ? '' : args.path, result_fields: args.fields, result_offset: args.offset, result_limit: args.limit, result_max_chars: args.max_chars, raw: !!args.raw }, { id: String(args.result_id), entry }));
    }
    case 'save_api_docs': {
      let docs = args.docs;
      if (typeof docs === 'string') docs = JSON.parse(docs);
      return text(await extCall('saveDocs', { recording: args.recording, docs }, 60000, browser));
    }
    case 'merge_recordings': {
      let parts = args.parts;
      if (typeof parts === 'string') parts = JSON.parse(parts);
      if (!Array.isArray(parts) || !parts.length) throw new Error('parts 至少给一段，如 [{"recording": "脚本 id 或名称", "from_step": 3}]');
      return text(await extCall('mergeRecordings', { recording: parts[0] && parts[0].recording, parts, name: args.name, description: args.description }, 60000, browser));
    }
    case 'export_package': {
      const r = await extCall('exportPackage', { recording: args.recording }, 60000, browser);
      const pkg = r && r.pkg ? r.pkg : r;
      // HTTP 调用的客户端可能在别的机器上，读不到这台机器的文件：照旧直接给内容
      if (ctx.via === 'http') return text(pkg);
      const body = JSON.stringify(pkg, null, 2);
      const events = (pkg && pkg.item && pkg.item.events) || [];
      const out = {
        file: writeExport((pkg && pkg.name) || args.recording, '.prpkg.json', body),
        name: pkg && pkg.name,
        chars: body.length,
        steps: events.filter((e) => e && e.kind === 'step').length,
        requests: events.filter((e) => e && e.kind === 'request').length,
      };
      // 包不大就顺便带上内容，省得再读文件
      if (body.length + 500 <= RESULT_CHARS) out.pkg = pkg;
      else out.note = `录制包 ${body.length} 字符，太大不直接给：内容在 file 里。导回用 import_package 传 file`;
      return text(out);
    }
    case 'import_package': {
      if (ctx.via === 'http' && !TOKEN) throw new Error(IMPORT_NEEDS_TOKEN);
      if (args.pkg == null && !args.file) throw new Error('pkg（录制包 JSON）和 file（录制包文件路径）给一个');
      if (args.pkg == null && ctx.via === 'http' && !IS_LOOPBACK_HOST) throw new Error('非本机 HTTP 访问不支持通过 file 读取服务端本地文件，请直接传 pkg');
      return text(await extCall('importPackage', { pkg: args.pkg != null ? parsePkg(args.pkg) : readPkgFile(args.file, ctx.via === 'http' ? path.join(STATE_DIR, 'exports') : null) }, 60000, browser));
    }
    default: {
      if (!dynamicMap.has(name)) await dynamicTools();
      const info = dynamicMap.get(name);
      if (!info) throw new Error('未知工具：' + name);
      // 几个浏览器里都有的脚本：在哪个执行由调用方选，不替它挑（挑错店铺比报错更糟）
      let target = info.browser;
      let rest = args;
      if (info.browsers) {
        const v = typeof args[info.browserArg] === 'string' ? args[info.browserArg].trim() : '';
        const ids = Object.values(info.browserTarget);
        target = Object.hasOwn(info.browserTarget, v) ? info.browserTarget[v] : ids.includes(v) ? v : '';
        if (!target) throw new Error(`脚本「${info.name}」在 ${info.browsers.length} 个浏览器里都有，请用 ${info.browserArg} 参数指定在哪个执行（只能是这几个）：${info.browsers.join('、')}`);
        rest = Object.fromEntries(Object.entries(args).filter(([k]) => k !== info.browserArg));
      }
      if (info.kind === 'run') {
        const params = withoutResultArgs(rest, info.own);
        let startUrl;
        if (info.startArg) { startUrl = params.start_url; delete params.start_url; }
        return aiResult(await extCall('run', { recording: info.recording, params, startUrl, timeout: 180000 }, 210000, target), args, info.own);
      }
      return callResult(await extCall('call', { recording: info.recording, api: info.api, args: withoutResultArgs(rest, info.own) }, 90000, target), args, info.own);
    }
  }
}

// 本服务实现的 MCP 协议版本（都是带 initialize 握手的）。客户端要的版本不在这里面时回最新的一个，不照抄：
// 2026-07-28 起取消了握手，照抄回去等于声称支持一个没实现的版本
const MCP_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

async function handleRpc(msg, ctx) {
  const { id, method, params } = msg || {};
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  try {
    switch (method) {
      case 'initialize':
        return ok({
          protocolVersion: params && MCP_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : MCP_VERSIONS[0],
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: 'page-recorder', version: VERSION },
          instructions: '这些工具用于执行用户在浏览器中录制的网页操作脚本，并调用录制中抓到的接口（在用户自己的浏览器中执行，带登录态）。先用 list_recordings 查看可用脚本（paramHelp 说明每个输入参数怎么填）；脚本库里接口多时不会把每个接口都列成工具，用 search_apis 按关键词找接口，再用 call_api 调用；运行、调用接口的结果里，套在 JSON 字符串里的数据已经展开成对象；结果太大时只返回压缩过的预览和 result_id，用 read_result 按路径 / 字段 / 分页取具体数据（不会再调接口），也可以调用时直接带 result_path、result_fields 只要一部分；需要了解接口细节用 get_recording；如果接口还没有说明，可以分析后用 save_api_docs 写回。多个浏览器资料都连着桥接时，每个脚本带 browser 字段，同名脚本要用 browser 参数指定在哪个浏览器执行。export_package / import_package 用来导出、导入录制包。用户分几条录了一个流程时，用 merge_recordings 按顺序合成一条新脚本。',
        });
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null;
      case 'ping': return ok({});
      case 'tools/list': return ok({ tools: STATIC_TOOLS.concat(await dynamicTools(true)) });
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
function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const ct = String(req.headers['content-type'] || '');
    if (req.method === 'POST' && !/^application\/json(?:\s*;|$)/i.test(ct)) {
      req.resume();
      return reject(Object.assign(new Error('Content-Type 必须是 application/json'), { statusCode: 415 }));
    }
    const limit = max || 20e6;
    const tooLarge = () => Object.assign(new Error('请求体过大'), { statusCode: 413 });
    if (Number(req.headers['content-length']) > limit) {
      req.pause();
      reject(tooLarge());
      return;
    }
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const done = (fn, v) => { if (!settled) { settled = true; fn(v); } };
    req.on('data', (c) => {
      if (settled) return;
      bytes += c.length;
      if (bytes > limit) {
        done(reject, tooLarge());
        chunks.length = 0;
        req.pause();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (settled) return;
      const d = chunks.length ? Buffer.concat(chunks, bytes).toString('utf8') : '';
      try { done(resolve, d ? JSON.parse(d) : {}); } catch (e) { done(reject, Object.assign(new Error('请求体不是合法 JSON'), { statusCode: 400 })); }
    });
    req.on('error', (e) => done(reject, e));
    req.on('close', () => { if (!req.complete) done(reject, new Error('请求连接已中断')); });
  });
}
function sendJson(res, code, obj) {
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
    'cross-origin-resource-policy': 'same-origin',
  });
  res.end(JSON.stringify(obj, null, 2));
}
// 防止普通网页跨站调用本地服务：校验 Origin、Sec-Fetch-Site 与可选 Token
function sameSecret(got, want) {
  const left = Buffer.from(String(got || ''));
  const right = Buffer.from(want);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
function extensionOriginId(origin) {
  return /^chrome-extension:\/\/([a-z0-9]+)$/i.exec(origin || '')?.[1].toLowerCase() || '';
}
const SAFE_RESPONSE = { 'x-content-type-options': 'nosniff', 'cross-origin-resource-policy': 'same-origin' };
function allowed(req, u) {
  const o = req.headers.origin;
  const extId = extensionOriginId(o);
  const isExt = !!extId;
  if (isExt && EXT_ID_ALLOW.size && !EXT_ID_ALLOW.has(extId)) return false;
  if (isExt && trustOpen() && !trustedIds.has(extId)) { // 没认的扩展不能借 HTTP 调用工具（trust 子命令刚放行的重读一次文件就有）
    trustedIds = new Set([...trustedIds, ...readTrusted()]);
    if (!trustedIds.has(extId)) return false;
  }
  if (o && !isExt && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(o)) return false;
  const sfs = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (sfs === 'cross-site' && !isExt) return false;
  if (TOKEN) {
    const auth = req.headers.authorization || '';
    const q = u.searchParams.get('token');
    if (!sameSecret(auth, 'Bearer ' + TOKEN) && !sameSecret(q, TOKEN)) return false;
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
// 本机 stdio 实例转发来的请求：带着本实例写进 STATE_FILE 的口令
function fromStdio(req) {
  const got = Buffer.from(String(req.headers['x-page-recorder-secret'] || ''));
  const want = Buffer.from(SECRET);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
// 请求里的 browser 参数：查询串 ?browser= 或请求体里的 browser
const browserOf = (u, b) => u.searchParams.get('browser') || (b && typeof b.browser === 'string' ? b.browser : '') || '';

async function route(req, res) {
  let u;
  try { u = new URL(req.url, 'http://x'); } catch (e) { return sendJson(res, 400, { ok: false, error: 'invalid url' }); }
  const p = u.pathname.replace(/\/+$/, '') || '/';
  if (!hostAllowed(req)) return sendJson(res, 403, { ok: false, error: 'forbidden host' });
  if (!allowed(req, u)) return sendJson(res, 403, { ok: false, error: 'forbidden' });
  const ctx = { via: 'http', canWrite: IS_LOOPBACK_HOST && (fromStdio(req) || !!TOKEN) };
  try {
    if (p === '/mcp') {
      if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }); return res.end(); }
      const body = await readBody(req);
      if (Array.isArray(body)) {
        if (body.length > 20) return sendJson(res, 400, { ok: false, error: '批量请求最多 20 项' });
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
        ok: true, name: 'page-recorder-bridge', version: VERSION, pid: process.pid, extensionConnected: instances.size > 0,
        ...(DAEMON ? { background: true, owners: [...owners] } : {}),
        browsers: [...instances.values()].map(browserStatus),
        sharedScripts: sharedCount(),
        lan: lan.running ? { on: true, port: lan.info().port } : { on: false }, // 口令不放这里
        ...(rejectedIds.size ? { rejectedExtensions: [...rejectedIds.keys()].slice(-10).map((id) => ({ id, how: `page-recorder-mcp trust ${id}` })) } : {}),
        endpoints: {
          'GET  /api/recordings': '脚本列表（含每个接口拆出的工具；多个浏览器时汇总，每条带 browser）',
          'GET  /api/recordings/:id': '脚本详情（步骤、接口、参数、参数说明 paramInfo、响应结构）',
          'GET  /api/recordings/:id/script': '导出的 JS 脚本源码',
          'GET  /api/recordings/:id/package': '导出录制包（已脱敏的 JSON，可存成 .prpkg.json）',
          'POST /api/recordings/:id/run': '运行 body: { params?, apiParams?, mode?: auto|api|ui, newTab?, fresh?, keepTab?, active?, startUrl?, timeout? }（api=直接请求接口；默认复用已开的页面）',
          'POST /api/recordings/:id/call': '调用单个接口 body: { api, args? }',
          'POST /api/recordings/:id/docs': '保存 AI 对接口的说明 body: docs',
          'POST /api/packages': '导入录制包 body: 录制包 JSON，或 { pkg, browser? }（必须设置 token 并带上）',
          'POST /mcp': 'MCP Streamable HTTP 端点',
        },
        browserParam: '以上接口都可以带 ?browser=<instanceId 或资料名>（POST 也可以放在 body.browser）：多个浏览器资料都装了扩展时用来指定在哪个浏览器执行',
      });
    }
    if (p === '/api/events' && req.method === 'GET') {
      // stdio 实例订阅：脚本库变化、扩展连上或断开时推一条，让它通知 AI 客户端重新拉工具列表
      res.writeHead(200, { ...SAFE_RESPONSE, 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
      res.write(': ok\n\n');
      const push = () => res.write('event: tools\ndata: {}\n\n');
      libraryListeners.add(push);
      res.on('close', () => libraryListeners.delete(push));
      return;
    }
    if (p === '/api/owners' && req.method === 'POST') {
      // stdio 实例登记启动它的程序（后台桥接在这些程序都退出后关闭）
      if (!fromStdio(req)) return sendJson(res, 403, { ok: false, error: 'forbidden' });
      const b = await readBody(req);
      for (const pid of Array.isArray(b.pids) ? b.pids : []) {
        if (Number.isInteger(pid) && pid > 1 && !owners.has(pid)) { owners.add(pid); everOwned = true; }
      }
      return sendJson(res, 200, { ok: true });
    }
    if (p === '/api/ext' && req.method === 'POST') {
      // 另一个桥接进程（stdio）转发来的调用。导入的录制包最大 50MB（见 readPkgFile），转成 JSON 还会变长一些
      if (!fromStdio(req)) return sendJson(res, 403, { ok: false, error: 'forbidden' });
      const b = await readBody(req, 64e6);
      const wait = Number.isFinite(b.wait) ? Math.min(Math.max(0, b.wait), EXT_WAIT_MS) : undefined;
      return sendJson(res, 200, { ok: true, data: await extCall(b.method, b.params || {}, b.timeout, b.browser, wait) });
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
      let recording;
      try { recording = decodeURIComponent(m[1]).trim(); } catch (e) { return sendJson(res, 400, { ok: false, error: 'invalid recording id' }); }
      if (!recording) return sendJson(res, 400, { ok: false, error: '缺少 recording 参数' });
      const action = m[2];
      if (!action && req.method === 'GET') return sendJson(res, 200, { ok: true, data: await extCall('get', { recording }, 60000, browserOf(u)) });
      if (action === 'script' && req.method === 'GET') {
        // 防跨站 <script src> 窃取脚本内容（XSSI）
        if (String(req.headers['sec-fetch-dest'] || '').toLowerCase() === 'script') return sendJson(res, 403, { ok: false, error: 'forbidden script inclusion' });
        const r = await extCall('script', { recording }, 60000, browserOf(u));
        res.writeHead(200, {
          'content-type': 'text/javascript; charset=utf-8',
          'x-content-type-options': 'nosniff',
          'cross-origin-resource-policy': 'same-origin',
        });
        return res.end(r.script);
      }
      if (action === 'package' && req.method === 'GET') {
        const r = await extCall('exportPackage', { recording }, 60000, browserOf(u));
        const pkg = r && r.pkg ? r.pkg : r;
        const file = String((pkg && pkg.name) || recording).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 80) + '.prpkg.json';
        res.writeHead(200, { ...SAFE_RESPONSE, 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="package.prpkg.json"; filename*=UTF-8''${encodeURIComponent(file).replace(/['()*!]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())}` });
        return res.end(JSON.stringify(pkg, null, 2));
      }
      if (req.method === 'POST') {
        const b = await readBody(req);
        const browser = browserOf(u, b);
        if (action === 'run') {
          const timeout = Math.max(1000, Math.min(900000, Number(b.timeout) || 180000));
          const params = { recording, timeout };
          for (const key of ['params', 'apiParams', 'mode', 'newTab', 'fresh', 'keepTab', 'active', 'capture', 'realInput', 'startUrl']) {
            if (Object.hasOwn(b, key)) params[key] = b[key];
          }
          if (Object.hasOwn(b, 'start_url') && !Object.hasOwn(b, 'startUrl')) params.startUrl = b.start_url; // 和 MCP 工具一样的写法也认
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
    if (res.headersSent) { try { res.end(); } catch (_) { /* ignore */ } return; }
    if (e.statusCode === 413) res.setHeader('Connection', 'close');
    return sendJson(res, e.statusCode || 500, { ok: false, error: e.message });
  }
}

const server = http.createServer((req, res) => {
  route(req, res).catch((e) => {
    try { if (!res.headersSent) sendJson(res, 500, { ok: false, error: String((e && e.message) || e) }); else res.end(); } catch (_) { /* ignore */ }
  });
});
server.on('upgrade', (req, socket, head) => {
  socket.on('error', () => { try { socket.destroy(); } catch (e) { /* ignore */ } });
  let u;
  try { u = new URL(req.url, 'http://x'); } catch (e) {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return;
  }
  const origin = String(req.headers.origin || '');
  const extId = extensionOriginId(origin);
  // Origin 只能挡住网页，挡不住本机/局域网里的其他程序：设置了 token 时扩展也要带上（桥接地址写成 ws://…/ext?token=口令）
  if (u.pathname !== '/ext' || !hostAllowed(req) || !extId || (EXT_ID_ALLOW.size && !EXT_ID_ALLOW.has(extId)) || !req.headers['sec-websocket-key'] || (TOKEN && !sameSecret(u.searchParams.get('token'), TOKEN))) {
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    return;
  }
  if (wsSockets.size >= 32) { socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n'); return; }
  wsSockets.add(socket);
  socket.once('close', () => wsSockets.delete(socket));
  socket.on('error', () => {});
  trustExtension(extId).then((ok) => {
    if (socket.destroyed) return;
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Accept: ' + wsAccept(req.headers['sec-websocket-key']),
      '', '',
    ].join('\r\n'));
    if (!ok) {
      // 握手后告诉扩展为什么不认（直接 403 的话扩展只知道连不上），然后关掉；什么请求都不转给它
      // 关闭帧带 1008（违反策略）；对方不回关闭也 2 秒后断开，不占连接名额
      socket.end(Buffer.concat([wsFrame(JSON.stringify({ type: 'rejected', extensionId: extId, reason: `桥接没认这个扩展（ID ${extId}）：找不到它的安装目录，确认不了是 Page Recorder。是你自己装的，就在终端运行 npx page-recorder-mcp trust ${extId}` }), 1), wsFrame(Buffer.from([0x03, 0xf0]), 8)]));
      setTimeout(() => socket.destroy(), 2000).unref();
      return;
    }
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 15000);
    attachWs(socket, origin, head);
  }, () => socket.destroy());
});
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    isPrimary = false;
    markReady();
    log(`端口 ${PORT} 已被另一个桥接实例占用，本实例将转发给它`);
    if (!STDIO) process.exit(1);
    // 等不及的后台桥接后来起来了：照样订阅、登记，不然它没人登记会自己关掉
    if (!NO_DAEMON) watchBridge(false);
  } else log('服务错误：' + e.message);
});
function listen() {
  server.listen(PORT, HOST, () => {
    isPrimary = true;
    markReady();
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
      fs.writeFileSync(STATE_FILE, JSON.stringify({ pid: process.pid, version: VERSION, secret: SECRET }), { mode: 0o600 });
    } catch (e) { log('写入 ' + STATE_FILE + ' 失败：' + e.message); }
    log(`已启动：http://${HOST}:${PORT}  （MCP: /mcp，REST: /api，扩展: ws://${HOST}:${PORT}/ext）${TOKEN ? '，已启用 token' : ''}${DAEMON ? '，后台运行' : ''}`);
    log('等待浏览器扩展连接…（扩展最多 30 秒内自动连上）');
  });
}
process.on('exit', () => {
  try { if (JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).pid === process.pid) fs.unlinkSync(STATE_FILE); } catch (e) { /* 没写过或已被新实例覆盖 */ }
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
if (STDIO && !NO_DAEMON) {
  // 复用或在后台起一个桥接；起不来就退回自己监听端口
  // 起后台桥接时出错（比如家目录只读、写不了日志）也退回自己监听，不能让未处理的异常把 MCP 进程带走
  ensureBridge().catch((e) => { log('后台桥接起不来：' + ((e && e.message) || e)); return false; }).then((up) => {
    if (!up) return listen();
    markReady();
    log('转发给后台桥接');
    watchBridge(false);
  });
} else listen();

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
