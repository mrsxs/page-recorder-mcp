// 冒烟测试：所有脚本能解析；桥接服务能启动并应答；extension 子命令能生成可加载的扩展目录
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const server = join(root, 'bridge', 'server.js');

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
