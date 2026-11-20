// 冒烟测试：所有脚本能解析；桥接服务能启动并应答；extension 子命令能生成可加载的扩展目录
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import net from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const server = join(root, 'bridge', 'server.js');
// 桥接写的口令文件、后台桥接的日志放临时目录，不碰 ~/.page-recorder
process.env.PR_BRIDGE_DIR = mkdtempSync(join(tmpdir(), 'pr-state-'));

test('所有脚本语法正确', () => {
  for (const f of ['bridge/server.js', 'background.js', 'content/recorder.js', 'inject/hook.js', 'lib/runtime.js', 'lib/exporter.js', 'popup/popup.js']) {
    const r = spawnSync(process.execPath, ['--check', join(root, f)], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
  }
});

test('manifest 和 package.json 版本一致', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  assert.equal(manifest.version, pkg.version);
});

test('--version 输出包版本', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const r = spawnSync(process.execPath, [server, '--version'], { encoding: 'utf8' });
  assert.equal(r.stdout.trim(), pkg.version);
});

test('extension 子命令生成扩展目录', () => {
  const out = mkdtempSync(join(tmpdir(), 'pr-ext-'));
  try {
    const r = spawnSync(process.execPath, [server, 'extension', out], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    for (const f of ['manifest.json', 'background.js', 'content/recorder.js', 'inject/hook.js', 'lib/runtime.js', 'lib/exporter.js', 'popup/popup.html', 'icons/icon128.png']) {
      assert.ok(existsSync(join(out, f)), `缺少 ${f}`);
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('桥接服务启动并应答 /api/status（--port 生效）', async () => {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const p = spawn(process.execPath, [server, '--port', String(port)], { stdio: ['ignore', 'ignore', 'pipe'] });
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('启动超时')), 10000);
      p.stderr.on('data', (d) => { if (String(d).includes('已启动')) { clearTimeout(t); resolve(); } });
      p.on('exit', (code) => { clearTimeout(t); reject(new Error('进程退出 ' + code)); });
    });
    const res = await fetch(`http://127.0.0.1:${port}/api/status`);
    const j = await res.json();
    assert.equal(j.ok, true);
    assert.equal(j.extensionConnected, false);
  } finally {
    p.kill();
  }
});

test('--no-daemon：扩展没连上时 tools/list 也很快返回固定工具（自己监听端口、转发给别的实例都一样）', async () => {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const listTools = () => new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [server, '--stdio', '--no-daemon', '--port', String(port)], { stdio: ['pipe', 'pipe', 'ignore'] });
    const t0 = Date.now();
    const t = setTimeout(() => { p.kill(); reject(new Error('tools/list 超过 8 秒')); }, 8000);
    let buf = '';
    p.stdout.on('data', (c) => {
      buf += c;
      for (let i; (i = buf.indexOf('\n')) >= 0; buf = buf.slice(i + 1)) {
        const m = JSON.parse(buf.slice(0, i));
        if (m.id === 2) { clearTimeout(t); p.kill(); resolve({ ms: Date.now() - t0, names: m.result.tools.map((x) => x.name) }); }
      }
    });
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
  });
  const primary = await listTools();
  assert.ok(primary.ms < 5000, `用了 ${primary.ms}ms`);
  assert.ok(primary.names.includes('list_recordings'));
  const p = spawn(process.execPath, [server, '--port', String(port)], { stdio: ['ignore', 'ignore', 'pipe'] });
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('启动超时')), 10000);
      p.stderr.on('data', (d) => { if (String(d).includes('已启动')) { clearTimeout(t); resolve(); } });
    });
    const forwarded = await listTools();
    assert.ok(forwarded.ms < 5000, `用了 ${forwarded.ms}ms`);
    assert.ok(forwarded.names.includes('list_recordings'));
  } finally {
    p.kill();
  }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return false; } };
const kill = (pid) => { try { process.kill(pid); } catch (e) { /* 已经退出 */ } };
async function waitFor(fn, ms, what) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (await fn()) return;
  throw new Error('等待超时：' + what);
}
// 在 perl 里起 stdio 实例：perl 就是「启动它的程序」（AI 客户端），杀掉 perl 等于关掉客户端
function mcpUnderApp(port) {
  const app = spawn('/usr/bin/perl', ['-e', 'system @ARGV; sleep 600', process.execPath, server, '--stdio', '--port', String(port)], { stdio: ['pipe', 'pipe', 'ignore'] });
  const waiting = new Map();
  const notes = [];
  let id = 0;
  let buf = '';
  app.stdout.on('data', (c) => {
    buf += c;
    for (let i; (i = buf.indexOf('\n')) >= 0; buf = buf.slice(i + 1)) {
      const m = JSON.parse(buf.slice(0, i));
      if (m.id != null && waiting.has(m.id)) waiting.get(m.id)(m.result);
      else if (m.method) notes.push(m.method);
    }
  });
  const rpc = (method, params) => new Promise((resolve) => {
    waiting.set(++id, resolve);
    app.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }) + '\n');
  });
  return { app, rpc, notes };
}
// 假扩展：连上、报个 hello；list 请求过 listDelay 毫秒回一个脚本（不传就不回）
function fakeExt(port, listDelay) {
  const s = net.connect(port, '127.0.0.1');
  const send = (obj) => {
    const payload = Buffer.from(JSON.stringify(obj));
    const mask = crypto.randomBytes(4);
    s.write(Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, Buffer.from(payload.map((b, i) => b ^ mask[i % 4]))]));
  };
  s.write(`GET /ext HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nOrigin: chrome-extension://abcdef\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  let buf = null;
  s.on('data', (d) => {
    if (!buf) { // 握手响应
      buf = d.slice(d.indexOf('\r\n\r\n') + 4);
      send({ type: 'hello', version: 'test', instanceId: 'test1', profile: 'main' });
    } else buf = Buffer.concat([buf, d]);
    while (buf.length >= 2 && buf.length >= 2 + (buf[1] & 0x7f)) { // 服务端发的都是短帧、不带掩码
      const m = JSON.parse(buf.slice(2, 2 + (buf[1] & 0x7f)).toString());
      buf = buf.slice(2 + (buf[1] & 0x7f));
      if (m.method === 'list' && listDelay != null) setTimeout(() => send({ type: 'response', id: m.id, ok: true, data: [{ id: 'r1', name: '慢脚本', slug: 'slow' }] }), listDelay);
    }
  });
  s.on('error', () => {});
  return s;
}

test('tools/list 最多等 6 秒；脚本列表晚到时通知客户端，重新拉就有', async () => {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const p = spawn(process.execPath, [server, '--port', String(port)], { stdio: ['ignore', 'ignore', 'pipe'] });
  let ext = null;
  let events = null;
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('启动超时')), 10000);
      p.stderr.on('data', (d) => { if (String(d).includes('已启动')) { clearTimeout(t); resolve(); } });
    });
    ext = fakeExt(port, 7000);
    await waitFor(async () => (await (await fetch(`http://127.0.0.1:${port}/api/status`)).json()).extensionConnected, 5000, '假扩展连上');
    let changed = 0;
    events = http.get({ host: '127.0.0.1', port, path: '/api/events' }, (res) => res.on('data', (d) => { if (String(d).includes('event: tools')) changed++; }));
    events.on('error', () => {});
    const list = async () => (await (await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })).json()).result.tools.map((t) => t.name);
    const t0 = Date.now();
    const first = await list();
    assert.ok(Date.now() - t0 < 7000, `用了 ${Date.now() - t0}ms`);
    assert.ok(!first.includes('slow__run'));
    await waitFor(() => changed > 0, 5000, '列表晚到后通知');
    assert.ok((await list()).includes('slow__run'));
  } finally {
    if (events) events.destroy();
    if (ext) ext.destroy();
    p.kill();
  }
});

test('stdio 在后台起桥接，别的 stdio 复用它；启动它们的程序都退出后桥接自动关闭', { skip: !existsSync('/usr/bin/perl') && '没有 perl' }, async () => {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const status = async () => (await fetch(`http://127.0.0.1:${port}/api/status`)).json();
  const pids = [];
  let ext = null;
  try {
    const a = mcpUnderApp(port);
    pids.push(a.app.pid);
    const t0 = Date.now();
    const list = await a.rpc('tools/list');
    assert.ok(Date.now() - t0 < 5000, `用了 ${Date.now() - t0}ms`);
    assert.ok(list.tools.some((t) => t.name === 'list_recordings'));
    let s = await status();
    const bridgePid = s.pid;
    pids.push(bridgePid);
    assert.equal(s.background, true);
    await waitFor(async () => (s = await status()).owners.includes(a.app.pid), 5000, '登记启动 a 的程序');
    const stdioA = s.owners.find((x) => x !== a.app.pid);
    pids.push(stdioA);

    const b = mcpUnderApp(port);
    pids.push(b.app.pid);
    await b.rpc('tools/list');
    await waitFor(async () => (s = await status()).owners.includes(b.app.pid), 5000, '登记启动 b 的程序');
    assert.equal(s.pid, bridgePid, '第二个 stdio 复用同一个后台桥接');
    pids.push(...s.owners.filter((x) => !pids.includes(x)));

    ext = fakeExt(port);
    await waitFor(() => a.notes.includes('notifications/tools/list_changed') && b.notes.includes('notifications/tools/list_changed'), 8000, '扩展连上后两个 stdio 都通知客户端重新拉工具');

    kill(a.app.pid);
    kill(stdioA);
    await sleep(3000);
    assert.ok(alive(bridgePid), '还有程序在用，桥接不关');
    for (const pid of pids) if (pid !== bridgePid) kill(pid);
    await waitFor(() => !alive(bridgePid), 8000, '程序都退出后桥接关闭');
    assert.ok(!existsSync(join(process.env.PR_BRIDGE_DIR, `bridge-${port}.json`)), '退出时删掉口令文件');
  } finally {
    if (ext) ext.destroy();
    pids.forEach(kill);
  }
});

test('导入录制包：没设 token 时，转发来的请求带本机口令才放行', async () => {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const p = spawn(process.execPath, [server, '--port', String(port)], { stdio: ['ignore', 'ignore', 'pipe'] });
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('启动超时')), 10000);
      p.stderr.on('data', (d) => { if (String(d).includes('已启动')) { clearTimeout(t); resolve(); } });
    });
    const post = (headers) => fetch(`http://127.0.0.1:${port}/api/ext`, { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, headers), body: JSON.stringify({ method: 'importPackage', params: {}, wait: 0 }) });
    assert.equal((await post({})).status, 403);
    const { secret } = JSON.parse(readFileSync(join(process.env.PR_BRIDGE_DIR, `bridge-${port}.json`), 'utf8'));
    const r = await post({ 'x-page-recorder-secret': secret });
    assert.match((await r.json()).error, /浏览器扩展未连接/);
  } finally {
    p.kill();
  }
});

test('监听非本机地址但没设 token 时拒绝启动', () => {
  const r = spawnSync(process.execPath, [server, '--host', '0.0.0.0', '--port', '0'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /必须同时设置 --token/);
});

test('设置了 token：扩展连接不带 token 被拒，带上才放行', async () => {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const p = spawn(process.execPath, [server, '--port', String(port), '--token', 'abc'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const http = await import('node:http');
  const upgrade = (path) => new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path, headers: { Connection: 'Upgrade', Upgrade: 'websocket', Origin: 'chrome-extension://x', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '13' } });
    req.on('upgrade', (res, socket) => { socket.destroy(); resolve(101); });
    req.on('response', (res) => resolve(res.statusCode));
    req.on('error', () => resolve('closed'));
    req.end();
  });
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('启动超时')), 10000);
      p.stderr.on('data', (d) => { if (String(d).includes('已启动')) { clearTimeout(t); resolve(); } });
    });
    assert.notEqual(await upgrade('/ext'), 101);
    assert.equal(await upgrade('/ext?token=abc'), 101);
  } finally {
    p.kill();
  }
});
