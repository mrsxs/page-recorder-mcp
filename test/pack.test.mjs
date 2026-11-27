// pack 子命令：打出来的 crx 签名对得上、扩展 ID 固定，zip 里就是扩展文件（manifest.json 在根目录）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const server = join(root, 'bridge', 'server.js');
const require = createRequire(import.meta.url);
const { crc32 } = require('../bridge/pack.js');
const { EXTENSION_FILES } = require('../bridge/updater.js');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;

function pack(args, state) {
  return spawnSync(process.execPath, [server, 'pack', ...args], { encoding: 'utf8', env: { ...process.env, PR_BRIDGE_DIR: state } });
}
// 按 CRX3 格式拆开，不用 bridge/pack.js 里的代码
function readVarint(b, i) {
  let n = 0;
  for (let s = 1; ; s *= 128) {
    const x = b[i++];
    n += (x & 0x7f) * s;
    if (x < 0x80) return [n, i];
  }
}
function pbFields(b) {
  const out = [];
  for (let i = 0; i < b.length;) {
    let tag, len;
    [tag, i] = readVarint(b, i);
    assert.equal(tag & 7, 2);
    [len, i] = readVarint(b, i);
    out.push([Math.floor(tag / 8), b.subarray(i, i + len)]);
    i += len;
  }
  return out;
}
function parseCrx(buf) {
  assert.equal(buf.toString('latin1', 0, 4), 'Cr24');
  assert.equal(buf.readUInt32LE(4), 3);
  const len = buf.readUInt32LE(8);
  const header = pbFields(buf.subarray(12, 12 + len));
  const proofs = header.filter(([f]) => f === 2).map(([, v]) => Object.fromEntries(pbFields(v)));
  const signed = header.find(([f]) => f === 10000)[1];
  return { proofs, signed, crxId: Object.fromEntries(pbFields(signed))[1], zip: buf.subarray(12 + len) };
}
function unzip(buf) {
  const end = buf.length - 22;
  assert.equal(buf.readUInt32LE(end), 0x06054b50);
  const files = new Map();
  let p = buf.readUInt32LE(end + 16);
  for (let n = buf.readUInt16LE(end + 10); n > 0; n--) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const local = buf.readUInt32LE(p + 42);
    assert.equal(buf.readUInt32LE(local), 0x04034b50);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const body = buf.subarray(start, start + size);
    const data = method === 8 ? zlib.inflateRawSync(body) : Buffer.from(body);
    assert.equal(crc32(data), crc, name);
    files.set(name, data);
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return files;
}
const extensionFiles = () => EXTENSION_FILES.flatMap(function walk(rel) {
  const p = join(root, rel);
  return statSync(p).isDirectory() ? readdirSync(p).filter((n) => !n.startsWith('.')).flatMap((n) => walk(`${rel}/${n}`)) : [rel];
});

test('crc32 和标准值一致', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

test('pack 打出 crx 和 zip：签名对得上、扩展 ID 已放行、内容就是扩展文件', () => {
  const base = mkdtempSync(join(tmpdir(), 'pr-pack-'));
  try {
    const state = join(base, 'state');
    const out = join(base, 'out');
    const r = pack([out], state);
    assert.equal(r.status, 0, r.stderr);
    const crxFile = join(out, `page-recorder-${version}.crx`);
    const zipFile = join(out, `page-recorder-${version}.zip`);
    const crx = parseCrx(readFileSync(crxFile));
    assert.equal(crx.proofs.length, 1);
    const pub = crypto.createPublicKey({ key: crx.proofs[0][1], format: 'der', type: 'spki' });
    const len = Buffer.alloc(4);
    len.writeUInt32LE(crx.signed.length);
    const message = Buffer.concat([Buffer.from('CRX3 SignedData\x00', 'latin1'), len, crx.signed, crx.zip]);
    assert.ok(crypto.verify('sha256', message, pub, crx.proofs[0][2]), '签名验不过');
    const digest = crypto.createHash('sha256').update(crx.proofs[0][1]).digest();
    assert.deepEqual(crx.crxId, digest.subarray(0, 16));
    const id = digest.toString('hex').slice(0, 32).replace(/./g, (c) => String.fromCharCode(97 + parseInt(c, 16)));
    assert.match(r.stdout, new RegExp(id));
    assert.deepEqual(JSON.parse(readFileSync(join(state, 'trusted-extensions.json'), 'utf8')).ids, [id]);
    if (process.platform !== 'win32') assert.equal(statSync(join(state, 'extension-key.pem')).mode & 0o777, 0o600);

    assert.deepEqual(readFileSync(zipFile), crx.zip); // zip 就是 crx 里那份
    const files = unzip(readFileSync(zipFile));
    const expected = extensionFiles().sort();
    assert.deepEqual([...files.keys()], expected);
    for (const f of expected.filter((x) => x !== 'manifest.json')) assert.ok(files.get(f).equals(readFileSync(join(root, f))), f);
    // manifest.json 在根目录，多了 key（crx 的公钥），别的不变
    const { key, ...manifest } = JSON.parse(files.get('manifest.json').toString('utf8'));
    assert.deepEqual(manifest, JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')));
    assert.deepEqual(Buffer.from(key, 'base64'), crx.proofs[0][1]);

    // 再打一次用同一个私钥：扩展 ID 不变，同一版打出来一模一样
    const again = pack([join(base, 'out2')], state);
    assert.equal(again.status, 0, again.stderr);
    assert.deepEqual(readFileSync(join(base, 'out2', `page-recorder-${version}.crx`)), readFileSync(crxFile));
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('pack --key 指定的私钥不存在时报错，不悄悄生成新的', () => {
  const base = mkdtempSync(join(tmpdir(), 'pr-pack-'));
  try {
    const key = join(base, 'missing.pem');
    const r = pack(['--key', key, join(base, 'out')], join(base, 'state'));
    assert.equal(r.status, 1);
    assert.match(r.stderr, /打包失败/);
    assert.ok(!existsSync(key));
    assert.ok(!existsSync(join(base, 'out')));
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('pack --key 用指定的私钥签名', () => {
  const base = mkdtempSync(join(tmpdir(), 'pr-pack-'));
  try {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const key = join(base, 'my.pem');
    writeFileSync(key, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    const r = pack([join(base, 'out'), `--key=${key}`], join(base, 'state'));
    assert.equal(r.status, 0, r.stderr);
    const crx = parseCrx(readFileSync(join(base, 'out', `page-recorder-${version}.crx`)));
    assert.deepEqual(crx.proofs[0][1], publicKey.export({ type: 'spki', format: 'der' }));
    assert.ok(!existsSync(join(base, 'state', 'extension-key.pem')));
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('pack --key 没给路径、私钥不是 RSA 时报错', () => {
  const base = mkdtempSync(join(tmpdir(), 'pr-pack-'));
  try {
    const state = join(base, 'state');
    const bare = pack([join(base, 'out'), '--key'], state);
    assert.equal(bare.status, 1);
    assert.match(bare.stderr, /--key 后面要写私钥文件的路径/);
    assert.ok(!existsSync(join(state, 'extension-key.pem')));
    const ec = join(base, 'ec.pem');
    writeFileSync(ec, crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }));
    const r = pack([join(base, 'out'), '--key', ec], state);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /私钥要是 RSA 的/);
    assert.ok(!existsSync(join(base, 'out')));
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('pack --port 的值不当成输出目录，提示里的允许端口跟着变', () => {
  const base = mkdtempSync(join(tmpdir(), 'pr-pack-'));
  try {
    const out = join(base, 'out');
    const r = spawnSync(process.execPath, [server, 'pack', '--port', '18000', out], { encoding: 'utf8', cwd: base, env: { ...process.env, PR_BRIDGE_DIR: join(base, 'state') } });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(join(out, `page-recorder-${version}.crx`)));
    assert.ok(!existsSync(join(base, '18000')));
    assert.match(r.stdout, /允许端口 18000/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
