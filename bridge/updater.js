// 自动更新：只发 npm，扩展目录和技能跟着桥接的版本走。
// 只动 `extension` 子命令生成过的目录，并且目录算出来的扩展 ID 要和连上来的扩展一致。
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

// 把换过的文件还原，返回还原不了的
function rollback(dir, saved, done) {
  const stuck = [];
  for (const { rel, had } of [...done].reverse()) {
    try {
      if (had) fs.renameSync(path.join(saved, rel), path.join(dir, rel));
      else fs.rmSync(path.join(dir, rel), { force: true });
    } catch (e) { stuck.push(rel); }
  }
  return stuck;
}

function createUpdater({ root, version, stateDir, home, log }) {
  const installFailures = new Map();
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
  async function withLock(fn) {
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    try { fs.mkdirSync(lockDir); } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (Date.now() - fs.statSync(lockDir).mtimeMs < LOCK_STALE_MS) return { retry: true };
      fs.rmSync(lockDir, { recursive: true, force: true });
      fs.mkdirSync(lockDir);
    }
    try { return await fn(); } finally { fs.rmSync(lockDir, { recursive: true, force: true }); }
  }
  function rememberExtensionDir(dir) {
    const state = readState();
    const abs = path.resolve(dir);
    if (!state.extensionDirs.includes(abs)) saveState({ ...state, extensionDirs: [...state.extensionDirs, abs] });
  }
  function updatableDir(dir) {
    try {
      if (fs.existsSync(path.join(dir, '.git')) || fs.realpathSync(dir) === fs.realpathSync(root)) return false;
      return String(JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).name || '').startsWith('Page Recorder');
    } catch (e) { return false; }
  }
  const dirVersion = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).version;

  // 先在同级目录备好完整的一份再逐个换进去，换之前留一份旧文件，manifest 最后换。
  // 中途失败就全部还原，目录不会停在新旧混用的状态；还原不了时旧文件留在临时目录里，路径写进错误
  function installExtension(dir) {
    const stage = fs.mkdtempSync(path.join(path.dirname(dir), `.${path.basename(dir)}.update-`));
    const fresh = path.join(stage, 'new');
    const saved = path.join(stage, 'old');
    let keepStage = false;
    try {
      fs.mkdirSync(fresh);
      for (const f of EXTENSION_FILES) fs.cpSync(path.join(root, f), path.join(fresh, f), { recursive: true });
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
      if (!keepStage) fs.rmSync(stage, { recursive: true, force: true });
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
      const groups = new Map();
      for (const b of browsers) {
        if (!b.extensionId || !(b.capabilities || []).includes('selfUpdate')) continue;
        if (compareVersions(b.version, version) >= 0 || state.attempts[b.instanceId] === version) continue;
        const dir = dirs.find((d) => extensionIdsOf(d).has(b.extensionId));
        if (dir) groups.set(dir, [...(groups.get(dir) || []), b]);
      }
      let retry = false;
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
  return { rememberExtensionDir, updateExtensions, updateSkills };
}

module.exports = { createUpdater, compareVersions, unpackedExtensionId, EXTENSION_FILES };
