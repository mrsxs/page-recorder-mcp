// 局域网读取共享脚本：这台电脑的桥接临时开一个局域网端口，另一台电脑的桥接凭口令来读「共享」了的脚本（只读，读完各管各的）。
// 口令是随机生成的 16 位（80 bit），请求和回应分别用它派生的密钥 AES-256-GCM 加密：局域网里抓包看不到内容，没口令的连列表都拿不到。
// 只认局域网地址（私有网段、本机、Tailscale 这类 100.64/10），两边都查。
// 只在用户打开开关、开开关的那个浏览器还连着时开着；关浏览器（扩展断开一阵子）就关。
'use strict';
const http = require('http');
const os = require('os');
const dns = require('dns');
const crypto = require('crypto');

const PATH = '/pr-lan/v1';
const DEFAULT_PORT = 17322;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉了容易看错的 I O 0 1
const MAX_REQUEST = 64 * 1024;
// 回应最多这么大：列表很小；一条脚本可能几十 MB。解密前就按这个截断，填错地址时不会被对方塞爆内存
const MAX_RESPONSE = { list: 8 * 1024 * 1024, get: 300 * 1024 * 1024 };
const MAX_CONN_PER_IP = 4;
const NONCE_TTL_MS = 10 * 60 * 1000;
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function newCode() {
  return Array.from(crypto.randomBytes(16), (b) => CODE_CHARS[b % 32]).join('');
}
// 用户抄口令时可能带空格、横线、小写
const normCode = (code) => String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const validCode = (code) => normCode(code).length === 16 && [...normCode(code)].every((ch) => CODE_CHARS.includes(ch));
const showCode = (code) => normCode(code).replace(/(.{4})(?=.)/g, '$1-');
// 请求和回应各用一把：拿到的回应不能当请求发回去
const keyOf = (code, use = 'req') => Buffer.from(crypto.hkdfSync('sha256', normCode(code), 'page-recorder-lan-v1', use, 32));

function seal(key, obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj)), c.final(), c.getAuthTag()]);
  return { v: 1, iv: iv.toString('base64'), data: data.toString('base64') };
}
// 口令不对、内容被改过都解不开，返回 null
function open(key, box) {
  try {
    if (!box || box.v !== 1 || typeof box.iv !== 'string' || typeof box.data !== 'string') return null;
    const iv = Buffer.from(box.iv, 'base64');
    const raw = Buffer.from(box.data, 'base64');
    if (iv.length !== 12 || raw.length < 17) return null;
    const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
    d.setAuthTag(raw.subarray(raw.length - 16));
    return JSON.parse(Buffer.concat([d.update(raw.subarray(0, raw.length - 16)), d.final()]).toString('utf8'));
  } catch (e) { return null; }
}

// 局域网地址：10/8、172.16/12、192.168/16、本机 127/8、链路本地 169.254/16、运营商级 NAT 和 Tailscale 的 100.64/10
function isLanIp(ip) {
  const m = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/i.exec(String(ip || ''));
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}

// 这台电脑在局域网里的地址（给另一台电脑填的），带网卡名，有 VPN、虚拟网卡时好分辨
function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.internal || (a.family !== 'IPv4' && a.family !== 4) || !isLanIp(a.address)) continue;
      if (/^169\.254\./.test(a.address)) continue; // 没拿到地址时的自分配地址
      out.push({ address: a.address, name });
    }
  }
  return out;
}

// 共享区里能给出去的：没删的
function listOf(shared) {
  return shared.list().filter((m) => !m.deleted).map((m) => ({ id: m.id, name: m.name, savedAt: m.savedAt, from: (m.from && m.from.profile) || '' }));
}

function createLanServer({ shared, log = () => {} }) {
  let server = null;
  let state = null; // { port, code, reqKey, resKey }
  const sockets = new Set();
  const perIp = new Map(); // ip → 连接数
  const failures = new Map(); // ip → { n, until }：口令不对太多次就先拒绝一会儿
  const seen = new Map(); // 用过的请求 nonce → 时间：同一个请求重放不再处理
  let queue = Promise.resolve(); // 开、关排队做：同时开两次不会留下没人管的端口
  const serial = (fn) => { const p = queue.then(fn, fn); queue = p.catch(() => {}); return p; };

  const blocked = (ip) => { const f = failures.get(ip); return !!(f && f.n >= 10 && Date.now() < f.until); };
  function fail(ip) {
    const f = failures.get(ip);
    const cur = f && Date.now() < f.until ? f : { n: 0 };
    failures.set(ip, { n: cur.n + 1, until: Date.now() + 60000 });
    if (failures.size > 1000) failures.delete(failures.keys().next().value);
  }
  function fresh(nonce) {
    const now = Date.now();
    if (seen.size > 5000) for (const [k, t] of seen) if (now - t > NONCE_TTL_MS || seen.size > 5000) seen.delete(k);
    if (seen.has(nonce) && now - seen.get(nonce) <= NONCE_TTL_MS) return false;
    seen.set(nonce, now);
    return true;
  }

  function answer(s, req, res) {
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    // 只给另一台电脑的桥接用：网页（带 Origin）不理
    if (req.method !== 'POST' || req.url !== PATH || req.headers.origin) return send(404, { error: 'not found' });
    const ip = req.socket.remoteAddress || '';
    if (blocked(ip)) return send(429, { error: '口令错误次数太多，请一分钟后再试' });
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_REQUEST) { req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      // 这条连接属于已经关掉（或换过）的那次开启：不处理
      if (s !== server || !state) return send(503, { error: '局域网同步已关闭' });
      if (blocked(ip)) return send(429, { error: '口令错误次数太多，请一分钟后再试' }); // 并发进来的也按最新次数算
      let box = null;
      try { box = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { /* 下面按解不开处理 */ }
      const msg = open(state.reqKey, box);
      if (!msg || typeof msg.nonce !== 'string' || msg.nonce.length > 64) { fail(ip); return send(403, { error: '口令不对' }); }
      failures.delete(ip);
      if (!fresh(msg.nonce)) return send(409, { error: '重复的请求' });
      const reply = (body) => send(200, seal(state.resKey, { ...body, nonce: msg.nonce }));
      try {
        if (msg.op === 'list') return reply({ ok: true, result: { device: os.hostname(), scripts: listOf(shared) } });
        if (msg.op === 'get' && typeof msg.id === 'string' && ID_RE.test(msg.id)) {
          const item = shared.read(msg.id);
          if (!item) throw new Error('这条脚本已经不共享了');
          return reply({ ok: true, result: { item } });
        }
        throw new Error('不认识的请求');
      } catch (e) {
        reply({ ok: false, error: e.message });
      }
    });
  }

  function listen(port) {
    return new Promise((resolve, reject) => {
      const s = http.createServer((req, res) => answer(s, req, res));
      s.maxConnections = 16;
      s.headersTimeout = 10000;
      s.requestTimeout = 30000;
      s.on('connection', (sock) => {
        const ip = sock.remoteAddress || '';
        const n = (perIp.get(ip) || 0) + 1;
        // 不是局域网来的、同一个地址连太多的（慢慢发占着连接）不理
        if (!isLanIp(ip) || n > MAX_CONN_PER_IP) { sock.destroy(); return; }
        perIp.set(ip, n);
        sockets.add(sock);
        sock.on('close', () => {
          sockets.delete(sock);
          const left = (perIp.get(ip) || 1) - 1;
          if (left > 0) perIp.set(ip, left); else perIp.delete(ip);
        });
      });
      s.once('error', reject);
      s.listen(port, '0.0.0.0', () => { s.removeListener('error', reject); resolve(s); });
    });
  }

  function close() {
    if (!server) return;
    const s = server;
    server = null;
    state = null;
    s.close();
    for (const sock of sockets) sock.destroy();
    sockets.clear();
    seen.clear();
    log('局域网同步已关闭');
  }
  // 端口被占了就往后找几个；口令沿用传进来的（扩展这次会话记着的），没有就新生成。
  // 已经开着（别的浏览器开的）就照旧：换口令会让已经填好的另一台电脑连不上
  function start({ port = DEFAULT_PORT, code } = {}) {
    return serial(async () => {
      if (server && state) return info();
      const c = validCode(code) ? normCode(code) : newCode();
      let lastErr = null;
      for (let p = port; p < port + 10; p++) {
        try {
          server = await listen(p);
          state = { port: p, code: c, reqKey: keyOf(c, 'req'), resKey: keyOf(c, 'res') };
          log(`局域网同步已开启：端口 ${p}`);
          return info();
        } catch (e) {
          lastErr = e;
          // EACCES：Windows 把一段端口保留给系统（Hyper-V 等），这段里监听不了，接着往后找
          if (e.code !== 'EADDRINUSE' && e.code !== 'EACCES') break;
        }
      }
      throw new Error(`开不了局域网端口：${lastErr ? lastErr.message : '未知错误'}`);
    });
  }
  const stop = () => serial(close);
  function info() {
    if (!state) return { on: false };
    return { on: true, port: state.port, code: showCode(state.code), addresses: lanAddresses(), count: listOf(shared).length };
  }
  return { start, stop, info, get running() { return !!server; } };
}

const STATUS_TEXT = {
  403: '口令不对',
  404: '对方这个端口不是 Page Recorder 的局域网同步',
  409: '请求重复了，请重试',
  429: '口令错误次数太多，对方先拒绝一分钟，请稍后再试',
  503: '对方已经关了局域网同步',
};
// 对方发来、要显示给用户的文字：去掉控制字符、限长
const clean = (text, n) => String(text).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);

// 另一台电脑一侧：addr 是「IP:端口」，只连局域网地址；按口令加密发请求、解开回应
function parseAddr(addr) {
  const m = /^\s*([A-Za-z0-9.-]{1,253})(?::(\d{1,5}))?\s*$/.exec(String(addr || ''));
  const port = m ? Number(m[2] || DEFAULT_PORT) : 0;
  if (!m || !port || port > 65535) throw new Error('地址要写成 IP:端口，比如 192.168.1.20:17322');
  return { host: m[1], port };
}
// 名字先解析成地址再查是不是局域网的，然后就连这个地址（不让它两次解析到不同地方）。解析也算在请求的时限里
async function lanTarget(addr, ms) {
  const { host, port } = parseAddr(addr);
  const lookup = dns.promises.lookup(host, { family: 4 }).catch(() => ({}));
  const slow = new Promise((resolve) => { const t = setTimeout(() => resolve({}), ms); t.unref(); });
  const ip = isLanIp(host) ? host : (await Promise.race([lookup, slow])).address;
  if (!ip) throw new Error(`找不到 ${host} 的地址`);
  if (!isLanIp(ip)) throw new Error(`${host} 不是局域网地址（只能连 192.168.x.x、10.x.x.x、172.16–31.x.x 这类）`);
  return { host: ip, port };
}
// timeoutMs 是整个请求（解析地址、连接、收完）的时限，不只是空闲时长：对方一点点慢慢发也拖不过它。
// signal：批量接收被取消时用它断掉正在进行的请求
async function lanRequest(addr, code, op, params = {}, timeoutMs = 15000, signal) {
  if (!validCode(code)) throw new Error('口令是 16 位字母数字（可以带横线），请照对方弹窗里显示的填');
  const end = Date.now() + Math.max(1000, Number(timeoutMs) || 15000);
  const target = await lanTarget(addr, end - Date.now());
  const left = Math.max(1, end - Date.now());
  const reqKey = keyOf(code, 'req');
  const resKey = keyOf(code, 'res');
  const limit = MAX_RESPONSE[op] || MAX_RESPONSE.list;
  const nonce = crypto.randomBytes(12).toString('hex');
  const body = JSON.stringify(seal(reqKey, { ...params, op, nonce }));
  return new Promise((resolve, reject) => {
    // agent: false 每次新连一条：对方关掉端口后不会拿到池里断掉的旧连接
    let answered = false; // 收到回应头没有：超时时分清是连不上，还是对方发得太慢
    const req = http.request({ host: target.host, port: target.port, path: PATH, method: 'POST', agent: false, signal, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }, timeout: left }, (res) => {
      answered = true;
      const tooBig = () => req.destroy(new Error('对方发来的内容太大'));
      if (Number(res.headers['content-length']) > limit) return tooBig();
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > limit) return tooBig();
        chunks.push(c);
      });
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { /* 下面报错 */ }
        // 还没核对口令的回应里的文字不显示（冒充的一方能随便写），按状态码说
        if (res.statusCode !== 200) return reject(new Error(STATUS_TEXT[res.statusCode] || `对方返回 ${res.statusCode}（可能不是 Page Recorder 的局域网端口）`));
        const msg = open(resKey, j);
        // 回应要能用口令解开、并且是这次请求的：对不上就当没收到
        if (!msg || msg.nonce !== nonce) return reject(new Error('对方的回应解不开（口令不对，或者不是 Page Recorder）'));
        const said = typeof msg.error === 'string' ? clean(msg.error, 200) : '';
        if (!msg.ok) return reject(new Error(said ? `对方说：${said}` : '对方处理失败'));
        resolve(msg.result);
      });
      res.on('error', reject);
    });
    const unreachable = () => new Error('连不上对方：超时。确认对方开着局域网同步、两台电脑在同一个网络、防火墙允许 node 接收连接');
    const overall = setTimeout(() => req.destroy(answered ? new Error('对方太久没传完，超时了') : unreachable()), left);
    req.on('close', () => clearTimeout(overall));
    req.on('timeout', () => req.destroy(answered ? new Error('对方太久没传完，超时了') : unreachable()));
    req.on('error', (e) => reject(e.code === 'ECONNREFUSED' ? new Error('对方没有开局域网同步（连接被拒绝）')
      : e.code === 'ECONNRESET' ? new Error('连接被对方断开了（对方可能刚关了局域网同步）')
        : e.name === 'AbortError' || e.code === 'ABORT_ERR' ? new Error('已取消') : e));
    req.end(body);
  });
}

module.exports = { createLanServer, lanRequest, newCode, normCode, validCode, showCode, keyOf, seal, open, parseAddr, isLanIp, DEFAULT_PORT };
