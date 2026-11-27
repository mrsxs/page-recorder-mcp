// 打包成 .crx / .zip：HubStudio 等指纹浏览器的「上传扩展」只收安装包，不能选已解压的目录。
// crx 用本机私钥签名（CRX3），扩展 ID 由公钥决定：以后打新版用同一个私钥，装上后还是同一个扩展，脚本不丢。
// 零依赖：zip 自己写（deflate 用 zlib），签名用 node:crypto
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { extensionIdOfKey } = require('./updater');

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
// 文件时间固定写 2000-01-01：同一版打出来的包一样
const DOS_TIME = 0;
const DOS_DATE = ((2000 - 1980) << 9) | (1 << 5) | 1;
// entries: [{ name: 'popup/popup.js', data: Buffer }]，manifest.json 在压缩包根目录
function zipFiles(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const method = deflated.length < data.length ? 8 : 0; // 压不小的直接存
    const body = method ? deflated : data;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // 文件名是 UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, body);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + body.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

// protobuf 只用到长度定界的字段
function varint(n) {
  const out = [];
  while (n > 0x7f) { out.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); }
  out.push(n);
  return Buffer.from(out);
}
const pbBytes = (field, buf) => Buffer.concat([varint(field * 8 + 2), varint(buf.length), buf]);
// CRX3：'Cr24' + 版本 3 + 头长度 + CrxFileHeader（公钥和签名、带 crx_id 的 SignedData）+ zip
function crx3(zip, privateKey) {
  const pub = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  const signedData = pbBytes(1, crypto.createHash('sha256').update(pub).digest().subarray(0, 16));
  const len = Buffer.alloc(4);
  len.writeUInt32LE(signedData.length);
  const signature = crypto.sign('sha256', Buffer.concat([Buffer.from('CRX3 SignedData\x00', 'latin1'), len, signedData, zip]), privateKey);
  const header = Buffer.concat([pbBytes(2, Buffer.concat([pbBytes(1, pub), pbBytes(2, signature)])), pbBytes(10000, signedData)]);
  const prefix = Buffer.alloc(12);
  prefix.write('Cr24', 0, 'latin1');
  prefix.writeUInt32LE(3, 4);
  prefix.writeUInt32LE(header.length, 8);
  return { crx: Buffer.concat([prefix, header, zip]), id: extensionIdOfKey(pub) };
}

// 没有就生成一个 RSA 私钥（PKCS#8 PEM，Chrome「打包扩展程序」也认）。
// 先写临时文件再硬链接过去：两个进程同时生成时用先链接成的那个，读不到写了一半的
function loadOrCreateKey(file) {
  try { return crypto.createPrivateKey(fs.readFileSync(file)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  try { fs.linkSync(tmp, file); } catch (e) { if (e.code !== 'EEXIST') throw e; } finally { fs.unlinkSync(tmp); }
  return crypto.createPrivateKey(fs.readFileSync(file));
}

// manifest.json 里写上公钥（key）：浏览器装 crx 时本来就会写进去；有的工具把包解开按已解压扩展加载，有它扩展 ID 也一样
function extensionEntries(root, files, pubDer) {
  const walk = (rel) => {
    const p = path.join(root, rel);
    if (!fs.statSync(p).isDirectory()) return [rel];
    return fs.readdirSync(p).filter((n) => !n.startsWith('.')).flatMap((n) => walk(path.join(rel, n))); // .DS_Store 这类不打进去
  };
  return files.flatMap(walk).map((rel) => rel.split(path.sep).join('/')).sort().map((name) => {
    const data = fs.readFileSync(path.join(root, name));
    if (name !== 'manifest.json') return { name, data };
    const manifest = { ...JSON.parse(data.toString('utf8')), key: pubDer.toString('base64') };
    return { name, data: Buffer.from(JSON.stringify(manifest, null, 2) + '\n') };
  });
}

// 返回 { crx, zip, id }：两个包的路径和装上后的扩展 ID。
// 用户自己指定的私钥（createKey 为假）不存在时报错，不悄悄换一个新的（换了扩展 ID 就变了）
function packExtension({ root, files, outDir, keyFile, createKey, version }) {
  const key = createKey ? loadOrCreateKey(keyFile) : crypto.createPrivateKey(fs.readFileSync(keyFile));
  if (key.asymmetricKeyType !== 'rsa') throw new Error(`私钥要是 RSA 的（${keyFile} 是 ${key.asymmetricKeyType}）`); // 签名只按 RSA 写
  const zip = zipFiles(extensionEntries(root, files, crypto.createPublicKey(key).export({ type: 'spki', format: 'der' })));
  const { crx, id } = crx3(zip, key);
  fs.mkdirSync(outDir, { recursive: true });
  const base = path.join(outDir, `page-recorder-${version}`);
  fs.writeFileSync(`${base}.crx`, crx);
  fs.writeFileSync(`${base}.zip`, zip);
  return { crx: `${base}.crx`, zip: `${base}.zip`, id };
}

module.exports = { packExtension, zipFiles, crx3, crc32 };
