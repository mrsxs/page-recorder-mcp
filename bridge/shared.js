// 共享脚本：一个环境（浏览器资料、指纹浏览器里的一个环境）点了「共享」的脚本放到 ~/.page-recorder/shared/，
// 同一台电脑上连着桥接的其他环境可以接收，之后哪个环境改了都同步给其他环境，删了也一起删。
// 哪些环境在用（members）记在这里，扩展里不存。每个环境记着上次同步时的版本（rev，内容哈希）和它那份的 savedAt：
// savedAt 变了说明这个环境改过。都在同一台电脑上，各环境的 savedAt 用的是同一个时钟，可以比先后。
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { fetchItem, sendItem, writeAtomic } = require('./library');

const FORMAT = 'page-recorder-shared-item';
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const REV_RE = /^[0-9a-f]{32}$/;
const isId = (id) => typeof id === 'string' && ID_RE.test(id);
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);

// 键排好序再算哈希：同样的内容不管字段先后都是同一个版本
function stable(x) {
  if (Array.isArray(x)) return x.map(stable);
  if (!isObj(x)) return x;
  return Object.fromEntries(Object.keys(x).sort().map((k) => [k, stable(x[k])]));
}
function revOf(item) {
  const { savedAt, ...content } = item;
  return crypto.createHash('sha256').update(JSON.stringify(stable(content))).digest('hex').slice(0, 32);
}

// 另存副本的 id 由原脚本、内容和保存时间算出来：同一次冲突重试几轮也只有一份；之后再改出同样的内容是另一份
const copyIdOf = (id, rev, savedAt) => 'c' + crypto.createHash('sha256').update(`${id}:${rev}:${savedAt}`).digest('hex').slice(0, 23);

function validMeta(m, id) {
  return isObj(m) && m.id === id && REV_RE.test(m.rev || '') && Number.isFinite(m.savedAt) && isObj(m.from) && isObj(m.members)
    && Object.keys(m.members).every(isId) && Object.values(m.members).every((x) => isObj(x) && Number.isFinite(x.at) && typeof x.rev === 'string')
    && (m.keep === undefined || (isObj(m.keep) && Object.keys(m.keep).every(isId) && Object.values(m.keep).every((x) => typeof x === 'string')))
    && (m.left === undefined || (isObj(m.left) && Object.keys(m.left).every(isId)));
}

function createShared(dir) {
  const stateFile = path.join(dir, 'state.json');
  const itemsDir = path.join(dir, 'items');
  // 文件名带版本号：先写新版本、再改 state.json、最后删旧文件，中途断掉也读得到其中一版
  const itemFile = (id, rev) => path.join(itemsDir, `${id}.${rev}.json`);
  let metas = null; // id → { id, rev, name, savedAt, from, members, deleted?, keep?, left? }
  let loadedAt = -1; // 读进来时 state.json 的修改时间：别的桥接进程（另一个端口）改过就重新读

  const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; } };
  const mtimeOf = (file) => { try { return fs.statSync(file).mtimeMs; } catch (e) { return 0; } };
  function load() {
    if (metas && mtimeOf(stateFile) === loadedAt) return metas;
    fs.mkdirSync(itemsDir, { recursive: true, mode: 0o700 });
    loadedAt = mtimeOf(stateFile);
    const saved = readJson(stateFile);
    metas = new Map(isObj(saved) ? Object.entries(saved).filter(([id, m]) => isId(id) && validMeta(m, id)) : []);
    return metas;
  }
  const save = () => {
    writeAtomic(stateFile, JSON.stringify(Object.fromEntries(load())));
    loadedAt = mtimeOf(stateFile);
  };
  const dropFiles = (id, keepRev) => {
    for (const name of fs.readdirSync(itemsDir)) {
      if (name.startsWith(id + '.') && name !== `${id}.${keepRev}.json` && /^[0-9a-f]{32}\.json$/.test(name.slice(id.length + 1))) fs.rmSync(path.join(itemsDir, name), { force: true });
    }
  };
  function set(meta) {
    load().set(meta.id, meta);
    save();
    dropFiles(meta.id, meta.deleted ? '' : meta.rev);
    return meta;
  }
  function read(id) {
    const m = load().get(id);
    if (!m || m.deleted) return null;
    const j = readJson(itemFile(id, m.rev));
    // 内容和版本号对得上才用：文件被改坏、改过内容的不发给环境
    return j && j.format === FORMAT && j.id === id && j.rev === m.rev && isObj(j.item) && j.item.id === id && revOf(j.item) === m.rev ? j.item : null;
  }
  // 这个环境的版本成为共享版本；prev 里别的环境照旧在用，等它们同步时更新
  function publish(item, env, prev) {
    const rev = revOf(item);
    fs.mkdirSync(itemsDir, { recursive: true, mode: 0o700 });
    writeAtomic(itemFile(item.id, rev), JSON.stringify({ format: FORMAT, version: 1, id: item.id, rev, item }));
    const members = { ...(prev ? prev.members : {}), [env.instanceId]: { rev, at: item.savedAt, profile: env.profile || '' } };
    const keep = Object.fromEntries(Object.entries((prev && prev.keep) || {}).filter(([k]) => k !== env.instanceId));
    return set({ id: item.id, rev, name: String(item.name || ''), savedAt: item.savedAt, from: { instanceId: env.instanceId, profile: env.profile || '' }, members, ...(Object.keys(keep).length ? { keep } : {}) });
  }
  function purge(id) {
    load().delete(id);
    save();
    dropFiles(id, '');
  }
  return { dir, list: () => [...load().values()], get: (id) => load().get(id) || null, read, publish, set, purge };
}

const memberOf = (meta, instanceId) => (hasOwn(meta.members, instanceId) ? meta.members[instanceId] : null);
const withMember = (meta, env, rev, at) => ({ ...meta, members: { ...meta.members, [env.instanceId]: { rev, at, profile: env.profile || '' } } });
// keep：被别的环境较新的改动盖掉的那个环境，下次同步时先把它自己那份另存一份（值是盖掉它的环境名）
const keepOf = (meta, instanceId) => (meta.keep && hasOwn(meta.keep, instanceId) ? meta.keep[instanceId] : null);
function withoutKeep(meta, instanceId) {
  if (!keepOf(meta, instanceId)) return meta;
  const keep = Object.fromEntries(Object.entries(meta.keep).filter(([k]) => k !== instanceId));
  const { keep: old, ...bare } = meta;
  return Object.keys(keep).length ? { ...bare, keep } : bare;
}
function withoutMember(meta, instanceId) {
  const members = Object.fromEntries(Object.entries(meta.members).filter(([k]) => k !== instanceId));
  return withoutKeep({ ...meta, members }, instanceId);
}
// 没有环境在用了就整条去掉
function keepOrPurge(store, meta) {
  if (Object.keys(meta.members).length) store.set(meta);
  else store.purge(meta.id);
}
const labelOf = (x) => (x && x.profile) || '未命名环境';

// 发给扩展：expectAt 是这个环境那份脚本现在的 savedAt（0 = 应该还没有），对不上说明刚改过，扩展不覆盖；
// copyName 给了就另存成 copyId 这条新脚本（不共享），已经有了（或用户删过）就不再存
function apply(call, item, opts) {
  return sendItem(call, 'sharedApply', item.id, item, opts);
}

// 两个环境都改过：较新的成为共享版本，被盖掉的那份另存在改它的那个环境里，哪边改的都不丢。
// 返回 'published'（这里的成为共享版本）、'applied'（换成了共享版本）、'failed'（这一轮没办成）
async function resolveConflict(store, env, call, meta, mine, notices) {
  const head = store.read(meta.id);
  if (!head) return 'failed';
  const other = labelOf(meta.from);
  if (mine.savedAt > meta.savedAt) {
    const next = store.publish(mine, env, store.get(meta.id));
    // 共享版本是 other 改的：它下次同步、被换成这里的版本之前，先把它自己那份另存（它不在了就不用存，内容本来就在它那里）
    const by = meta.from.instanceId;
    if (by !== env.instanceId && memberOf(next, by)) store.set({ ...next, keep: { ...(next.keep || {}), [by]: labelOf(env) } });
    notices.push(`「${mine.name}」在 ${other} 也改过：共享的是这里较新的版本，${other} 改的会在那边另存一份`);
    return 'published';
  }
  const copyName = `${mine.name || '脚本'}（本环境的版本）`;
  const c = await apply(call, mine, { copyName, copyId: copyIdOf(meta.id, revOf(mine), mine.savedAt) });
  if (!c || !c.ok) return 'failed';
  const r = await apply(call, head, { expectAt: mine.savedAt });
  if (!r || !r.ok) return 'failed'; // 刚又改了、或正在录：副本 id 固定，下一轮不会再存一份
  store.set(withMember(store.get(meta.id), env, meta.rev, r.savedAt));
  notices.push(`「${head.name}」在 ${other} 改得更晚：已换成那边的版本，这里改的另存为「${copyName}」`);
  return 'applied';
}

// 共享区里已经删了的：这个环境没改过就跟着删，改过就留下当它自己的脚本
async function followDelete(store, env, call, meta, local, notices) {
  const member = memberOf(meta, env.instanceId);
  const by = meta.deleted.by || '其他环境';
  if (local !== undefined && local === member.at) {
    const r = await call('sharedRemove', { id: meta.id, expectAt: local }, 30000);
    if (r && r.busy) return; // 正在录这条，下次再删
    notices.push(r && r.ok ? `「${meta.name}」已在 ${by} 删除，这里也删了` : `「${meta.name}」已在 ${by} 删除，这里刚改过，留作本环境的脚本`);
  } else if (local !== undefined) {
    notices.push(`「${meta.name}」已在 ${by} 删除，这里改过，留作本环境的脚本`);
  }
  keepOrPurge(store, withoutMember(meta, env.instanceId));
}

const hasLeft = (meta, instanceId) => !!(meta.left && hasOwn(meta.left, instanceId));
// 已经比过、内容不一样的（环境 + 脚本 + 两边版本）：不用每轮都把整条脚本取过来再比
const compared = new Set();

// 一条共享脚本和一个环境对一次，返回共享区有没有变（内容、在用的环境；变了要让别的环境也同步）
async function syncOne(store, env, call, meta, { local, del, receive, notices }) {
  const member = memberOf(meta, env.instanceId);
  if (meta.deleted) {
    if (member) await followDelete(store, env, call, meta, local, notices);
    return !!member;
  }
  if (!member) {
    if (local !== undefined) return rejoin(store, env, call, meta, local);
    // 删过的不收
    if (del !== undefined || !receive) return false;
    const item = store.read(meta.id);
    const r = item && await apply(call, item, { expectAt: 0 });
    if (!r || !r.ok) return false;
    store.set(withMember(store.get(meta.id), env, meta.rev, r.savedAt));
    return true;
  }
  if (local === undefined) {
    if (del !== undefined && del >= member.at) {
      // 清单是这一轮开头取的：真要让别的环境跟着删之前再问一次，用户可能刚从编辑区又存回去了
      const now = await call('libraryManifest', {}, 30000);
      if (!now || !Array.isArray(now.items) || now.items.some((x) => x.id === meta.id)) return false;
      // 这个环境删了：别的环境跟着删。留下删除记录，等不在线的环境连上来再处理
      keepOrPurge(store, { ...withoutMember(meta, env.instanceId), deleted: { at: del, by: env.profile || '' } });
      return true;
    }
    keepOrPurge(store, withoutMember(meta, env.instanceId)); // 不是删的（扩展存储被清掉了）：只是不再算它在用
    return true;
  }
  if (local === member.at) {
    if (member.rev === meta.rev) return false;
    const item = store.read(meta.id);
    if (!item) return false;
    const by = keepOf(meta, env.instanceId);
    let copyName = '';
    if (by) {
      // 这里改的被 by 较新的改动盖掉了：先把这里这份另存，再换成共享版本
      const mine = await fetchItem(call, meta.id);
      if (!mine || mine.id !== meta.id || mine.savedAt !== local) return false;
      copyName = `${mine.name || '脚本'}（本环境的版本）`;
      const c = await apply(call, mine, { copyName, copyId: copyIdOf(meta.id, revOf(mine), mine.savedAt) });
      if (!c || !c.ok) return false;
    }
    const r = await apply(call, item, { expectAt: local });
    if (!r || !r.ok) return false;
    store.set(withoutKeep(withMember(store.get(meta.id), env, meta.rev, r.savedAt), env.instanceId));
    if (by) notices.push(`「${item.name}」在 ${by} 改得更晚：已换成那边的版本，这里改的另存为「${copyName}」`);
    return false;
  }
  // 这个环境改过（被别人盖掉要另存的记号作废：这次按两边都改过重新处理）
  if (keepOf(meta, env.instanceId)) meta = store.set(withoutKeep(meta, env.instanceId));
  const mine = await fetchItem(call, meta.id);
  if (!mine || mine.id !== meta.id || mine.savedAt !== local) return false; // 取的时候又改了，下一轮再对
  const rev = revOf(mine);
  if (rev === meta.rev) { store.set(withMember(meta, env, rev, local)); return false; }
  if (member.rev === meta.rev) { store.publish(mine, env, meta); return true; }
  return (await resolveConflict(store, env, call, meta, mine, notices)) === 'published';
}

// 环境里有同 id 的、却不算在用：接收时扩展存好了、应答没传回来（断线），或者重装扩展后从备份恢复的。
// 内容和共享版本一样就补记成在用；停止共享过的（left）不动，内容不一样的当它自己的脚本
async function rejoin(store, env, call, meta, local) {
  if (hasLeft(meta, env.instanceId)) return false;
  const key = `${env.instanceId}\n${meta.id}\n${local}\n${meta.rev}`;
  if (compared.has(key)) return false;
  const mine = await fetchItem(call, meta.id);
  if (!mine || mine.id !== meta.id || mine.savedAt !== local || revOf(mine) !== meta.rev) {
    if (compared.size > 5000) compared.clear();
    compared.add(key);
    return false;
  }
  store.set(withMember(store.get(meta.id), env, meta.rev, local));
  return true;
}

// 告诉扩展：它在用的共享脚本（还有哪些环境在用）、别的环境共享了还没接收的、这一轮要提示用户的事
function stateFor(store, env, here, deleted) {
  const shared = [];
  const offers = [];
  for (const meta of store.list()) {
    if (meta.deleted) continue;
    if (memberOf(meta, env.instanceId)) {
      shared.push({ id: meta.id, others: Object.entries(meta.members).filter(([k]) => k !== env.instanceId).map(([, v]) => labelOf(v)) });
    } else if (!here.has(meta.id) && !deleted.has(meta.id)) {
      offers.push({ id: meta.id, name: meta.name, from: labelOf(meta.from), savedAt: meta.savedAt });
    }
  }
  return { shared, offers: offers.sort((a, b) => b.savedAt - a.savedAt).slice(0, 100) };
}

// 环境改了名字：成员列表、作者里的名字跟着改，别的环境看到的是新名字
function renamed(store, meta, env) {
  const member = memberOf(meta, env.instanceId);
  if (!member || member.profile === (env.profile || '')) return meta;
  const from = meta.from.instanceId === env.instanceId ? { from: { ...meta.from, profile: env.profile || '' } } : {};
  return store.set({ ...meta, ...from, members: { ...meta.members, [env.instanceId]: { ...member, profile: env.profile || '' } } });
}

// 一个环境和共享区对一次。receive：用户在弹窗里点了接收的；扩展设置里开了自动接收的全收
async function syncEnv(store, env, call, { receive = new Set(), log = () => {} } = {}) {
  const m = await call('libraryManifest', {}, 30000);
  if (!m || !Array.isArray(m.items)) return { changed: false };
  const here = new Map(m.items.filter((x) => isId(x.id) && Number.isFinite(x.savedAt)).map((x) => [x.id, x.savedAt]));
  const deleted = new Map((Array.isArray(m.deleted) ? m.deleted : []).filter((d) => isId(d.id) && Number.isFinite(d.at)).map((d) => [d.id, d.at]));
  const notices = [];
  let changed = false;
  for (const { id } of store.list()) {
    if (!store.get(id)) continue;
    try {
      const meta = renamed(store, store.get(id), env);
      const opts = { local: here.get(id), del: deleted.get(id), receive: m.autoReceiveShared === true || receive.has(id), notices };
      if (await syncOne(store, env, call, meta, opts)) changed = true;
    } catch (e) { log(`共享脚本 ${id} 和环境 ${labelOf(env)} 同步失败：${e.message}`); }
  }
  const state = stateFor(store, env, here, deleted);
  // 发不出去也要把 changed 交回去：共享区已经改了，别的环境还得同步
  try { await call('sharedState', { ...state, notices }, 10000); } catch (e) { log(`共享脚本的状态没发给环境 ${labelOf(env)}：${e.message}`); }
  return { changed, state };
}

// 用户在某个环境点了「共享」：还没人共享就成为新的共享脚本；共享区里已有（重新共享、重装后恢复的）按两边都改过处理
async function shareOn(store, env, call, id, { notices = [] } = {}) {
  if (!isId(id)) throw new Error('脚本 id 不对');
  const mine = await fetchItem(call, id);
  if (!mine || mine.id !== id || !Number.isFinite(mine.savedAt)) throw new Error('这个环境里没有这条脚本');
  const found = store.get(id);
  const meta = found && found.left ? store.set(withoutLeft(found, env.instanceId)) : found;
  // 删过的重新共享：当成全新的一条，删除流程里还没处理完的环境不跟过来（它们手上那份留作自己的脚本）
  if (!meta || meta.deleted) { store.publish(mine, env, null); return true; }
  if (memberOf(meta, env.instanceId)) return false;
  if (revOf(mine) === meta.rev) { store.set(withMember(meta, env, meta.rev, mine.savedAt)); return true; }
  const r = await resolveConflict(store, env, call, meta, mine, notices);
  if (r === 'failed') throw new Error('这条脚本正在录制或刚改过，等一会儿再点「共享」');
  return true;
}
function withoutLeft(meta, instanceId) {
  const left = Object.fromEntries(Object.entries(meta.left || {}).filter(([k]) => k !== instanceId));
  const { left: old, ...bare } = meta;
  return Object.keys(left).length ? { ...bare, left } : bare;
}

// 停止共享：只是这个环境不再跟着同步，脚本留在环境里；别的环境照旧
function shareOff(store, env, id) {
  const meta = store.get(id);
  if (!meta || !memberOf(meta, env.instanceId)) return false;
  // 记下停止共享过：环境里留着的那份内容和共享版本一样，也不再自动算回在用
  keepOrPurge(store, { ...withoutMember(meta, env.instanceId), left: { ...(meta.left || {}), [env.instanceId]: true } });
  return true;
}

module.exports = { createShared, syncEnv, shareOn, shareOff, revOf };
