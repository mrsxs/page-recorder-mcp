// 自动更新：只发 npm，扩展目录和技能跟着桥接的版本走。
// 只动 `extension` 子命令生成过的目录、默认目录，或浏览器资料里记着的这个扩展的加载目录，并且目录算出来的扩展 ID 要和连上来的扩展一致。
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const EXTENSION_FILES = ['manifest.json', 'background.js', 'content', 'inject', 'lib', 'popup', 'icons'];
const LOCK_STALE_MS = 60000;
const MAX_INSTALL_TRIES = 3; // 目录写不了时这个进程最多试这么多次，下次启动桥接再来

function compareVersions(a, b) {
  const parts = (v) => String(v).split('.').slice(0, 3).map((x) => parseInt(x, 10) || 0);
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0) ? -1 : 1;
  return 0;
}
// Chrome 给已解压扩展的 ID：路径的 SHA-256 前 16 字节，每半字节映射到 a-p（Windows 上路径是 UTF-16、盘符大写）
function unpackedExtensionId(p, platform = process.platform) {
  const bytes = platform === 'win32'
    ? Buffer.from(p.replace(/^[a-z]:/, (x) => x.toUpperCase()), 'utf16le')
    : Buffer.from(p, 'utf8');
  return crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 32).replace(/./g, (c) => String.fromCharCode(97 + parseInt(c, 16)));
}
function extensionIdsOf(dir) {
  const out = new Set([unpackedExtensionId(path.resolve(dir))]);
  for (const real of [fs.realpathSync, fs.realpathSync.native]) {
    try { out.add(unpackedExtensionId(real(dir))); } catch (e) { /* 目录没了 */ }
  }
  return out;
}
// 浏览器资料目录（Chrome / Edge / Chromium / Brave）。用户自己“加载已解压的扩展程序”选的目录没登记过，
// 从资料的 Preferences 里按扩展 ID 找回来，第一次会话就能更新
// 指纹浏览器、--user-data-dir 启动的这类自定义资料目录用 PR_BROWSER_DATA_DIRS 指定（多个用系统路径分隔符隔开）
function browserDataRoots(home, platform = process.platform, env = process.env) {
  const extra = String(env.PR_BROWSER_DATA_DIRS || '').split(platform === 'win32' ? ';' : ':').map((x) => x.trim()).filter(Boolean);
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    return extra.concat([['Google', 'Chrome'], ['Google', 'Chrome Beta'], ['Google', 'Chrome Dev'], ['Google', 'Chrome SxS'], ['Microsoft', 'Edge'], ['Chromium'], ['BraveSoftware', 'Brave-Browser']].map((x) => join(local, ...x, 'User Data')));
  }
  if (platform === 'darwin') {
    const support = join(home, 'Library', 'Application Support');
    return extra.concat([['Google', 'Chrome'], ['Google', 'Chrome Beta'], ['Google', 'Chrome Dev'], ['Google', 'Chrome Canary'], ['Microsoft Edge'], ['Chromium'], ['BraveSoftware', 'Brave-Browser']].map((x) => join(support, ...x)));
  }
  const config = env.XDG_CONFIG_HOME || join(home, '.config');
  const chrome = env.CHROME_CONFIG_HOME || config; // Chrome / Chromium 用它代替 XDG_CONFIG_HOME，下面照样接 google-chrome 这些
  return extra.concat(['google-chrome', 'google-chrome-beta', 'google-chrome-unstable', 'chromium'].map((x) => join(chrome, x)), [['microsoft-edge'], ['BraveSoftware', 'Brave-Browser']].map((x) => join(config, ...x)));
}
// 已解压扩展在资料里记的是绝对路径（商店装的是相对路径，不算）。异步一个个读，不卡住桥接；特别大的文件不读。
// 资料目录可能是 <根>/<资料>/Preferences（Chrome），也可能直接就是一个资料（<根>/Preferences），
// 或者指纹浏览器那样每个环境一个 --user-data-dir（<根>/<环境>/Default/Preferences）：三种都找
const PREFS_MAX_BYTES = 32 * 1024 * 1024;
async function unpackedDirsOf(roots, ids) {
  const out = new Set();
  for (const root of roots) {
    let children = [];
    try { children = (await fs.promises.readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name); } catch (e) { continue; }
    const profiles = [root, ...children.map((c) => path.join(root, c)), ...children.map((c) => path.join(root, c, 'Default'))];
    for (const profile of profiles) {
      for (const file of ['Secure Preferences', 'Preferences']) {
        const f = path.join(profile, file);
        let settings = null;
        try {
          if ((await fs.promises.stat(f)).size > PREFS_MAX_BYTES) continue;
          settings = JSON.parse(await fs.promises.readFile(f, 'utf8')).extensions.settings;
        } catch (e) { continue; }
        for (const id of ids) {
          const p = settings && settings[id] && settings[id].path;
          if (typeof p === 'string' && path.isAbsolute(p)) out.add(p);
        }
      }
    }
  }
  return [...out];
}
const sha = (x) => crypto.createHash('sha256').update(x).digest('hex');
function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (x) { /* 没写出来 */ }
    throw e;
  }
}
function filesUnder(root, rel = '') {
  return fs.readdirSync(path.join(root, rel), { withFileTypes: true }).flatMap((e) => {
    const p = path.join(rel, e.name);
    return e.isDirectory() ? filesUnder(root, p) : [p];
  });
}

// 不用 fs.cpSync：Windows 上它往中文等非 ASCII 路径里覆盖文件会失败（Node 22 实测，C:\靖云\… 报 unlink errno 0）。
// 逐个文件 copyFileSync；扩展目录旁的临时目录、回滚时的删除也只用最基本的 unlink / rmdir
function copyTree(src, dst) {
  let old = null;
  try { old = fs.lstatSync(dst); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (fs.statSync(src).isDirectory()) {
    if (old && !old.isDirectory()) removeTree(dst); // 原来是同名文件
    fs.mkdirSync(dst, { recursive: true });
    for (const name of fs.readdirSync(src)) copyTree(path.join(src, name), path.join(dst, name));
    return;
  }
  // 和 cpSync 一样先删掉旧的再复制：只读文件也换得了；目标是链接时换掉链接本身，不写到它指向的地方；原来是同名目录也换掉。
  // 源和目标是同一个文件时什么都不做（删了就没得复制了）
  if (old && !old.isSymbolicLink() && fs.realpathSync(dst) === fs.realpathSync(src)) return;
  if (old) removeTree(dst);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}
// 扩展目录里有链接（符号链接、Windows 目录联接）时不自动更新：沿着链接写会写到扩展目录外面
function hasLinks(dir) {
  const walk = (p) => {
    let st;
    try { st = fs.lstatSync(p); } catch (e) { return false; }
    if (st.isSymbolicLink()) return true;
    return st.isDirectory() && fs.readdirSync(p).some((name) => walk(path.join(p, name)));
  };
  return EXTENSION_FILES.some((f) => walk(path.join(dir, f)));
}
function removeTree(p) {
  let st;
  try { st = fs.lstatSync(p); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  if (st.isDirectory()) {
    for (const name of fs.readdirSync(p)) removeTree(path.join(p, name));
    fs.rmdirSync(p);
    return;
  }
  try { fs.unlinkSync(p); } catch (e) {
    if (!['EPERM', 'EACCES', 'EISDIR'].includes(e.code)) throw e;
    // Windows 上指向目录的链接、目录联接要用 rmdir 删；只读的普通文件先去掉只读再删（链接不 chmod，会改到它指向的文件）
    if (st.isSymbolicLink()) fs.rmdirSync(p);
    else { fs.chmodSync(p, 0o666); fs.unlinkSync(p); }
  }
}

// 把换过的文件还原，返回还原不了的
function rollback(dir, saved, done) {
  const stuck = [];
  for (const { rel, had } of [...done].reverse()) {
    try {
      if (had) fs.renameSync(path.join(saved, rel), path.join(dir, rel));
      else removeTree(path.join(dir, rel));
    } catch (e) { stuck.push(rel); }
  }
  return stuck;
}

function createUpdater({ root, version, stateDir, home, log, browserRoots }) {
  const installFailures = new Map();
  const lookups = new Map(); // 扩展 ID → { n: 找了几次没找到, next: 下次最早什么时候再找 }（资料文件可能还没写盘，隔一分钟再找，最多 3 次）
  const stateFile = path.join(stateDir, 'update.json');
  const lockDir = path.join(stateDir, 'update.lock');
  const skillSource = path.join(root, 'skills', 'page-recorder', 'SKILL.md');
  const skillTargets = ['.workbuddy', '.claude'].map((d) => path.join(home, d, 'skills', 'page-recorder', 'SKILL.md'));

  function readState() {
    let j = {};
    try { j = JSON.parse(fs.readFileSync(stateFile, 'utf8')) || {}; } catch (e) { /* 第一次 */ }
    return {
      extensionDirs: Array.isArray(j.extensionDirs) ? j.extensionDirs.filter((x) => typeof x === 'string') : [],
      skills: j.skills && typeof j.skills === 'object' ? j.skills : {},
      attempts: j.attempts && typeof j.attempts === 'object' ? j.attempts : {},
    };
  }
  function saveState(state) {
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    writeAtomic(stateFile, JSON.stringify(state));
  }
  // 几个 AI 工具可能同时启动：同一时间只有一个在写
  // 锁目录里记着持有者的进程号：持有者还在就不回收（扫浏览器资料、等扩展回复加起来可能超过一分钟），只删自己的锁
  const ownerFile = path.join(lockDir, 'owner');
  const lockOwner = () => { try { return Number(fs.readFileSync(ownerFile, 'utf8')) || 0; } catch (e) { return 0; } };
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
  function takeLock() {
    try { fs.mkdirSync(lockDir); } catch (e) { if (e.code === 'EEXIST') return false; throw e; }
    fs.writeFileSync(ownerFile, String(process.pid));
    return true;
  }
  async function withLock(fn) {
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    if (!takeLock()) {
      // 拿不到：持有者还在就等下一轮；持有者没了（或刚建锁还没写进程号）且锁已经过期才回收，回收时又被别人抢先也等下一轮
      const owner = lockOwner();
      let age = Infinity;
      try { age = Date.now() - fs.statSync(lockDir).mtimeMs; } catch (x) { if (x.code !== 'ENOENT') throw x; }
      if ((owner && alive(owner)) || (age !== Infinity && age < LOCK_STALE_MS)) return { retry: true };
      if (age !== Infinity) { try { removeTree(lockDir); } catch (x) { return { retry: true }; } }
      if (!takeLock()) return { retry: true };
    }
    try { return await fn(); } finally {
      try { if (lockOwner() === process.pid) removeTree(lockDir); } catch (e) { log(`释放更新锁失败：${e.message}`); }
    }
  }
  function rememberExtensionDir(dir) {
    const state = readState();
    const abs = path.resolve(dir);
    if (!state.extensionDirs.includes(abs)) saveState({ ...state, extensionDirs: [...state.extensionDirs, abs] });
  }
  // 在源码仓库里（.git 在这一级或上级目录）：开发环境，不动。查到用户主目录为止（有人把整个主目录放进 git 管配置文件）
  // 主目录按原路径和真实路径都认，Windows 上不分大小写
  const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const homes = new Set([norm(path.resolve(home))]);
  try { homes.add(norm(fs.realpathSync(home))); } catch (e) { /* 主目录不存在（测试） */ }
  function inGitRepo(dir) {
    for (let d = path.resolve(dir); !homes.has(norm(d)); d = path.dirname(d)) {
      if (fs.existsSync(path.join(d, '.git'))) return true;
      if (path.dirname(d) === d) return false;
    }
    return false;
  }
  function updatableDir(dir) {
    try {
      // 链接路径和真实路径都查：~/page-recorder-extension 可能链到某个仓库的子目录
      const real = fs.realpathSync(dir);
      if (inGitRepo(dir) || inGitRepo(real) || real === fs.realpathSync(root) || hasLinks(dir)) return false;
      return String(JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).name || '').startsWith('Page Recorder');
    } catch (e) { return false; }
  }
  const dirVersion = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).version;

  // 先在同级目录备好完整的一份再逐个换进去，换之前留一份旧文件，manifest 最后换。
  // 中途失败就全部还原，目录不会停在新旧混用的状态；还原不了时旧文件留在临时目录里，路径写进错误
  function installExtension(linkDir) {
    // 扩展目录本身是链接、目录联接（可能在别的盘上）时按真实位置写，临时目录和它在同一个盘上才能直接改名换进去
    const dir = fs.realpathSync(linkDir);
    let stage;
    try { stage = fs.mkdtempSync(path.join(path.dirname(dir), `.${path.basename(dir)}.update-`)); } catch (e) {
      if (!['EACCES', 'EPERM', 'EROFS'].includes(e.code)) throw e;
      stage = fs.mkdtempSync(path.join(dir, '.page-recorder-update-')); // 父目录写不了（比如放在盘的根目录下）
    }
    const fresh = path.join(stage, 'new');
    const saved = path.join(stage, 'old');
    let keepStage = false;
    try {
      fs.mkdirSync(fresh);
      for (const f of EXTENSION_FILES) copyTree(path.join(root, f), path.join(fresh, f));
      const files = filesUnder(fresh).sort((a, b) => (a === 'manifest.json') - (b === 'manifest.json'));
      const done = [];
      try {
        for (const rel of files) {
          const target = path.join(dir, rel);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          const had = fs.existsSync(target);
          if (had) {
            fs.mkdirSync(path.dirname(path.join(saved, rel)), { recursive: true });
            fs.copyFileSync(target, path.join(saved, rel));
            // Windows 上改名换不掉只读的目标文件：先去掉只读（旧文件已经留了一份）
            const st = fs.lstatSync(target);
            if (st.isFile() && !(st.mode & 0o200)) fs.chmodSync(target, st.mode | 0o200);
          }
          fs.renameSync(path.join(fresh, rel), target);
          done.push({ rel, had });
        }
      } catch (e) {
        const stuck = rollback(dir, saved, done);
        if (!stuck.length) throw e;
        keepStage = true;
        throw new Error(`${e.message}；${stuck.length} 个文件没能还原，旧文件在 ${saved}`);
      }
    } finally {
      // 新版已经换进去了，清理临时目录失败（Windows 上文件被占用等）不算更新失败
      if (!keepStage) { try { removeTree(stage); } catch (e) { log(`清理临时目录失败：${stage}：${e.message}`); } }
    }
  }
  async function updateGroup(dir, browsers, call) {
    if ((installFailures.get(dir) || 0) >= MAX_INSTALL_TRIES) return { retry: false };
    const prepared = [];
    const abort = () => Promise.all(prepared.map((b) => call(b, 'updateAbort', {}, 5000).catch(() => {})));
    for (const b of browsers) {
      const r = await call(b, 'updatePrepare', { version }, 5000).catch(() => null);
      if (!r || !r.ok) {
        await abort();
        return { retry: !!(r && r.busy) }; // 正在录制或回放：等它忙完
      }
      prepared.push(b);
    }
    try {
      if (compareVersions(dirVersion(dir), version) < 0) installExtension(dir);
      installFailures.delete(dir);
    } catch (e) {
      const tries = (installFailures.get(dir) || 0) + 1;
      installFailures.set(dir, tries);
      log(`更新扩展目录失败（${dir}，第 ${tries} 次）：${e.message}`);
      await abort();
      return { retry: tries < MAX_INSTALL_TRIES };
    }
    const reloaded = (await Promise.all(browsers.map(async (b) => {
      try {
        const r = await call(b, 'updateReload', { version }, 5000);
        return r && r.ok ? b : null;
      } catch (e) {
        log(`重新加载扩展失败：${e.message}`);
        return null;
      }
    }))).filter(Boolean);
    // 只记下确实重新加载了的：加载后版本还是没变时不反复重载；没加载成的下一轮再来（文件已是新的，不用再写）
    const state = readState();
    saveState({ ...state, attempts: { ...state.attempts, ...Object.fromEntries(reloaded.map((b) => [b.instanceId, version])) } });
    if (reloaded.length) log(`扩展已更新到 ${version}：${dir}`);
    return { retry: reloaded.length < browsers.length };
  }
  async function updateExtensions(browsers, call) {
    return withLock(async () => {
      const state = readState();
      const dirs = [...new Set([...state.extensionDirs, path.join(home, 'page-recorder-extension')])].filter(updatableDir);
      const due = browsers.filter((b) => b.extensionId && (b.capabilities || []).includes('selfUpdate')
        && compareVersions(b.version, version) < 0 && state.attempts[b.instanceId] !== version);
      const dirOf = (b) => dirs.find((d) => extensionIdsOf(d).has(b.extensionId));
      const tried = (id) => lookups.get(id) || { n: 0, next: 0 };
      const unknown = [...new Set(due.filter((b) => !dirOf(b)).map((b) => b.extensionId))].filter((id) => tried(id).n < 3 && Date.now() >= tried(id).next);
      if (unknown.length) {
        for (const d of await unpackedDirsOf(browserRoots || browserDataRoots(home), unknown)) {
          if (dirs.includes(d) || !updatableDir(d) || !unknown.some((id) => extensionIdsOf(d).has(id))) continue;
          dirs.push(d);
          rememberExtensionDir(d); // 记下来，下次不用再找
          log(`在浏览器资料里找到扩展目录：${d}`);
        }
      }
      const missing = unknown.filter((id) => !due.some((b) => b.extensionId === id && dirOf(b)));
      missing.forEach((id) => lookups.set(id, { n: tried(id).n + 1, next: Date.now() + 60000 }));
      const groups = new Map();
      for (const b of due) {
        const dir = dirOf(b);
        if (dir) groups.set(dir, [...(groups.get(dir) || []), b]);
      }
      let retry = due.some((b) => !dirOf(b) && tried(b.extensionId).n < 3);
      for (const [dir, list] of groups) retry = (await updateGroup(dir, list, call)).retry || retry;
      return { retry };
    });
  }
  // 只更新已经装了的技能。用户手动改过的不覆盖；第一次接管时先备份
  function updateSkill(file, text, hash, rec) {
    if (rec && compareVersions(version, rec.version) < 0) return rec; // 别的工具已经装了更新的版本
    if (fs.lstatSync(file).isSymbolicLink()) return rec; // 链到别处的是用户自己管的，写进去会把链接换成普通文件
    const cur = fs.readFileSync(file);
    const curHash = sha(cur);
    if (curHash === hash) return { hash, version };
    if (rec && rec.hash !== curHash) { log(`技能被手动改过，不覆盖：${file}`); return rec; }
    if (!rec) {
      const backups = path.join(stateDir, 'skill-backups');
      fs.mkdirSync(backups, { recursive: true, mode: 0o700 });
      writeAtomic(path.join(backups, `${path.basename(path.dirname(path.dirname(path.dirname(file))))}-${Date.now()}.md`), cur);
    }
    writeAtomic(file, text);
    fs.chmodSync(file, 0o644);
    log(`技能已更新到 ${version}：${file}`);
    return { hash, version };
  }
  function updateSkills() {
    return withLock(async () => {
      if (!fs.existsSync(skillSource)) return { retry: false };
      const text = fs.readFileSync(skillSource);
      const hash = sha(text);
      const state = readState();
      const skills = { ...state.skills };
      for (const file of skillTargets) {
        if (!fs.existsSync(file)) continue;
        try {
          skills[file] = updateSkill(file, text, hash, skills[file]);
        } catch (e) { log(`更新技能失败（${file}）：${e.message}`); }
      }
      if (JSON.stringify(skills) !== JSON.stringify(state.skills)) saveState({ ...state, skills });
      return { retry: false };
    });
  }
  // 连上来的扩展是不是 Page Recorder：按路径算出来的 ID 就是它的目录里，
  // · 扩展文件和这个程序带的逐个一样（内容比对，别人照抄名字改了代码的过不了）；
  // · 或者是 `extension` 子命令生成、更新器记下的目录、默认目录（旧版本的文件，等连上后自动更新），manifest 名字对得上。
  // 浏览器资料里登记的其他目录只认第一种。找到返回目录，找不到返回空
  let packageHashes = null;
  const hashesOf = (dir) => {
    const out = new Map();
    for (const f of EXTENSION_FILES) {
      const p = path.join(dir, f);
      const files = fs.statSync(p).isDirectory() ? filesUnder(p).filter((x) => !path.basename(x).startsWith('.')).map((x) => path.join(f, x)) : [f]; // .DS_Store 这类不算
      for (const x of files) out.set(x.split(path.sep).join('/'), sha(fs.readFileSync(path.join(dir, x))));
    }
    return out;
  };
  const samePackage = (dir) => {
    try {
      packageHashes = packageHashes || hashesOf(root);
      for (const [f, h] of packageHashes) if (sha(fs.readFileSync(path.join(dir, f))) !== h) return false;
      return true;
    } catch (e) { return false; }
  };
  const namedOurs = (dir) => {
    try { return String(JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).name || '').startsWith('Page Recorder'); } catch (e) { return false; }
  };
  async function extensionDir(id) {
    const known = [...readState().extensionDirs, path.join(home, 'page-recorder-extension'), root];
    for (const d of known) if (extensionIdsOf(d).has(id) && namedOurs(d)) return d;
    for (const d of await unpackedDirsOf(browserRoots || browserDataRoots(home), [id])) if (extensionIdsOf(d).has(id) && samePackage(d)) return d;
    return '';
  }
  return { rememberExtensionDir, updateExtensions, updateSkills, extensionDir };
}

module.exports = { createUpdater, compareVersions, unpackedExtensionId, copyTree, browserDataRoots, EXTENSION_FILES };
