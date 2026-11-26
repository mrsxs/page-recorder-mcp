// 脚本库的本机副本：~/.page-recorder/library/<资料目录>/<脚本 id>.json。
// 扩展的 chrome.storage 跟着扩展 ID 走，卸载或换目录加载就没了；这里的文件不在扩展目录和 npm 缓存里，升级不会碰到。
// 扩展里的仍是工作副本（没开桥接时也能录），连上桥接后按 savedAt 同步到这里。每个浏览器资料一个目录，同一条脚本在不同资料里互不影响。
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FORMAT = 'page-recorder-library-item';
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const OWNER_DIR_RE = /^[0-9a-f]{32}$/;
const CHUNK_CHARS = 4 * 1024 * 1024; // 一条脚本可能几十 MB，分段传，不碰 WebSocket 单条消息的上限
const isId = (id) => typeof id === 'string' && ID_RE.test(id);
// instanceId 是扩展发来的，不直接当路径用
const ownerDir = (instanceId) => crypto.createHash('sha256').update(String(instanceId)).digest('hex').slice(0, 32);

function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (x) { /* 没写出来 */ }
    throw e;
  }
}

function createLibrary(dir) {
  const keyOf = (ownerId, id) => `${ownerDir(ownerId)}/${id}`;
  const fileOf = (key) => path.join(dir, `${key}.json`);
  const indexFile = path.join(dir, '.index.json');
  let index = null; // 资料目录/id → { id, savedAt, owner, name, restoredFrom, dismissed, mtimeMs }

  const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; } };
  const saveIndex = () => writeAtomic(indexFile, JSON.stringify(Object.fromEntries(index)));
  const entryOf = (j, mtimeMs) => ({ id: j.item.id, savedAt: j.savedAt, owner: j.owner, name: j.item.name || '', restoredFrom: j.restoredFrom, dismissed: j.dismissed, mtimeMs });
  const validFile = (j, sub, id) => !!(j && j.format === FORMAT && j.item && j.item.id === id && Number.isFinite(j.savedAt) && j.owner && ownerDir(j.owner.instanceId) === sub);

  // 索引只是加速：文件变过或索引丢了就重新读那个文件，脚本文件才是准的
  function load() {
    if (index) return index;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const saved = new Map(Object.entries(readJson(indexFile) || {}));
    const next = new Map();
    for (const sub of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!sub.isDirectory() || !OWNER_DIR_RE.test(sub.name)) continue;
      for (const name of fs.readdirSync(path.join(dir, sub.name))) {
        if (name.startsWith('.') || !name.endsWith('.json')) continue;
        const id = name.slice(0, -5);
        if (!isId(id)) continue;
        const key = `${sub.name}/${id}`;
        const mtimeMs = fs.statSync(fileOf(key)).mtimeMs;
        const known = saved.get(key);
        if (known && known.mtimeMs === mtimeMs && known.id === id && known.owner && ownerDir(known.owner.instanceId) === sub.name) { next.set(key, known); continue; }
        const j = readJson(fileOf(key));
        if (validFile(j, sub.name, id)) next.set(key, entryOf(j, mtimeMs));
      }
    }
    index = next;
    return index;
  }
  function save(key, record) {
    fs.mkdirSync(path.dirname(fileOf(key)), { recursive: true, mode: 0o700 });
    writeAtomic(fileOf(key), JSON.stringify(record));
    index.set(key, entryOf(record, fs.statSync(fileOf(key)).mtimeMs));
    saveIndex();
  }
  function write(item, owner, meta = {}) {
    if (!item || !isId(item.id) || !Number.isFinite(item.savedAt) || !Array.isArray(item.events)) throw new Error('脚本内容不完整');
    if (!owner || typeof owner.instanceId !== 'string' || !owner.instanceId) throw new Error('脚本没有归属的浏览器');
    load();
    // settings 里有 AI 的 API Key，不落到这个目录
    const { settings, ...clean } = item;
    const key = keyOf(owner.instanceId, clean.id);
    const restoredFrom = meta.restoredFrom || (index.get(key) || {}).restoredFrom;
    save(key, { format: FORMAT, version: 1, owner, savedAt: clean.savedAt, ...(restoredFrom ? { restoredFrom } : {}), item: clean });
  }
  // 只删这个资料自己的那份
  function remove(ownerId, id, at) {
    if (!isId(id)) return null;
    const key = keyOf(ownerId, id);
    const cur = load().get(key);
    if (!cur || cur.savedAt > at) return null;
    fs.rmSync(fileOf(key), { force: true });
    index.delete(key);
    saveIndex();
    return cur;
  }
  function mark(key, dismissed) {
    const j = load().has(key) ? readJson(fileOf(key)) : null;
    if (!j) return;
    const { dismissed: old, ...rest } = j;
    save(key, dismissed ? { ...rest, dismissed: true } : rest);
  }
  // 用户删掉了恢复来的那份：沿来源把旧副本藏起来，不再提示恢复。文件留着，来源资料还在用时下次连上就取消
  function dismiss(ownerId, id, at) {
    const seen = new Set();
    for (let o = ownerId; o && !seen.has(o);) {
      seen.add(o);
      const key = keyOf(o, id);
      const cur = load().get(key);
      if (!cur || cur.savedAt > at) return;
      if (!cur.dismissed) mark(key, true);
      o = cur.restoredFrom;
    }
  }
  function undismiss(ownerId, id) {
    const key = keyOf(ownerId, id);
    if ((load().get(key) || {}).dismissed) mark(key, false);
  }
  return {
    dir,
    fileOf: (ownerId, id) => fileOf(keyOf(ownerId, id)),
    list: () => [...load().values()].map(({ mtimeMs, ...x }) => x),
    get: (ownerId, id) => load().get(keyOf(ownerId, id)) || null,
    read: (ownerId, id) => (load().has(keyOf(ownerId, id)) ? (readJson(fileOf(keyOf(ownerId, id))) || {}).item || null : null),
    write,
    remove,
    dismiss,
    undismiss,
  };
}

const MAX_ITEM_CHARS = 512 * 1024 * 1024; // 一条脚本最多这么大，超过就不收（防止一直不结束的分段把内存占满）
// tx：这次读取的编号，扩展按它留快照，同一条脚本被两处同时读也各读各的
async function fetchItem(call, id) {
  const tx = crypto.randomBytes(8).toString('hex');
  let text = '';
  for (;;) {
    const r = await call('libraryGet', { id, offset: text.length, limit: CHUNK_CHARS, tx }, 60000);
    if (!r || typeof r.chunk !== 'string') return null;
    text += r.chunk;
    if (r.done) return JSON.parse(text);
    if (!r.chunk) throw new Error('读取脚本时没有拿到内容');
    if (text.length > MAX_ITEM_CHARS) throw new Error('脚本太大');
  }
}
// 分段发给扩展，返回最后一段的应答。tx：这次传输的编号，扩展按它拼，同一条脚本同时传两次也不串。
// stop：每段发之前问一下，返回原因（取消、超时）就不发了，扩展那边的半截过一会儿自己清掉
async function sendItem(call, method, id, item, extra, stop) {
  const text = JSON.stringify(item);
  const tx = crypto.randomBytes(8).toString('hex');
  let last = null;
  for (let i = 0; i < text.length; i += CHUNK_CHARS) {
    const why = stop && stop();
    if (why) throw new Error(why);
    last = await call(method, { ...extra, id, tx, chunk: text.slice(i, i + CHUNK_CHARS), start: i === 0, done: i + CHUNK_CHARS >= text.length }, 60000);
  }
  return last;
}
// 扩展判断要跳过（已删除、已有更新的）时不算恢复成功
async function pushItem(lib, call, e) {
  const item = lib.read(e.owner.instanceId, e.id);
  if (!item) return false;
  const last = await sendItem(call, 'libraryRestore', e.id, item, { sourceExtension: e.owner.extensionId || '' });
  return !!(last && last.ok && !last.skipped);
}
// 一条恢复不了不影响后面的
async function tryPush(lib, call, e, log) {
  try { return await pushItem(lib, call, e); } catch (x) {
    log(`脚本 ${e.id} 恢复失败：${x.message}`);
    return false;
  }
}
const ownerOf = (conn, extensionId) => ({ instanceId: conn.instanceId, profile: conn.profile || '', extensionId: extensionId || '' });

// 别的浏览器资料（或卸载前的这个扩展）留下、这里没有的脚本：不自动并进来（不同资料可能是不同店铺的账号），由用户在弹窗里选
function offersFor(lib, here, deleted, connected) {
  const groups = new Map();
  for (const e of lib.list()) {
    const owner = e.owner.instanceId;
    if (here.has(e.id) || connected.has(owner) || e.dismissed || (deleted.get(e.id) || 0) >= e.savedAt) continue;
    const g = groups.get(owner) || { owner, profile: e.owner.profile || '', count: 0, savedAt: 0 };
    groups.set(owner, { ...g, count: g.count + 1, savedAt: Math.max(g.savedAt, e.savedAt) });
  }
  return [...groups.values()].sort((a, b) => b.savedAt - a.savedAt);
}

// 一个浏览器和本机目录对一次：删除、备份新的、补回自己缺的，最后告诉它还有哪些别处的备份（也作为返回值）
async function syncBrowser(lib, conn, call, { extensionId, connected, log }) {
  const m = await call('libraryManifest', {}, 30000);
  if (!m || !Array.isArray(m.items)) return [];
  const me = conn.instanceId;
  const here = new Map(m.items.filter((x) => isId(x.id) && Number.isFinite(x.savedAt)).map((x) => [x.id, x.savedAt]));
  const deleted = new Map();
  for (const d of Array.isArray(m.deleted) ? m.deleted : []) {
    if (!isId(d.id) || here.has(d.id) || !Number.isFinite(d.at)) continue;
    deleted.set(d.id, d.at);
    const gone = lib.remove(me, d.id, d.at);
    if (gone && gone.restoredFrom) lib.dismiss(gone.restoredFrom, d.id, d.at);
  }
  const owner = ownerOf(conn, extensionId);
  for (const [id, savedAt] of here) {
    lib.undismiss(me, id); // 这个资料还在用
    const cur = lib.get(me, id);
    if (cur && cur.savedAt >= savedAt) continue;
    try {
      const item = await fetchItem(call, id);
      if (item && item.id === id) lib.write(item, owner);
    } catch (e) { log(`脚本 ${id} 存到本机失败：${e.message}`); }
  }
  for (const e of lib.list()) {
    if (e.owner.instanceId === me && !here.has(e.id) && !deleted.has(e.id)) await tryPush(lib, call, e, log);
  }
  const offers = offersFor(lib, here, deleted, connected);
  await call('libraryOffer', { offers }, 10000);
  return offers;
}

// 用户在弹窗里选了恢复某一组：只接受发给这个连接的、当前不在线的来源。复制一份归这个浏览器，来源的备份不动
async function restoreOwner(lib, conn, call, ownerId, { extensionId, offered, connected, log = () => {} }) {
  if (ownerId === conn.instanceId || !offered.has(ownerId) || connected.has(ownerId)) return 0;
  const m = await call('libraryManifest', {}, 30000);
  const here = new Set(((m && m.items) || []).map((x) => x.id));
  const owner = ownerOf(conn, extensionId);
  let restored = 0;
  for (const e of lib.list()) {
    if (e.owner.instanceId !== ownerId || here.has(e.id) || e.dismissed) continue;
    if (!await tryPush(lib, call, e, log)) continue;
    const src = lib.read(ownerId, e.id);
    // 和扩展里这份的标记一致：来自别的扩展 ID 的，之后再恢复也按导入的录制包对待
    const imported = !!src.imported || !extensionId || e.owner.extensionId !== extensionId;
    lib.write({ ...src, imported }, owner, { restoredFrom: ownerId });
    restored++;
  }
  return restored;
}

module.exports = { createLibrary, syncBrowser, restoreOwner, fetchItem, sendItem, writeAtomic, CHUNK_CHARS };
