// Service worker：录制状态与事件、脚本库、AI 解读接口、在浏览器中执行脚本、连接本地 AI 桥接服务。
/* global PR_EXPORTER */
importScripts('lib/runtime.js', 'lib/exporter.js');

const DEFAULT_SETTINGS = {
  maskPasswords: true,   // 密码输入不保存明文
  maskHeaders: true,     // 导出时隐藏 Authorization / Token / Cookie 等请求头
  ignoreTracking: true,  // 忽略统计、埋点、监控请求
  dataOnly: true,        // 只保留数据接口（忽略 js/css/图片/字体等）
  recordScroll: true,
  altExtract: true,      // Alt+点击 标记要提取的数据
  maxBodyKB: 512,        // 单个请求/响应体最多保存多少 KB
  sampleKB: 20,          // 导出脚本中每个接口的示例响应大小上限
  excludePattern: '',    // 额外排除的 URL 正则
  // AI 解读接口
  aiProvider: 'openai',  // openai = OpenAI 兼容接口（OpenAI / DeepSeek / 通义 / Kimi / OpenRouter / Ollama…）；anthropic = Claude
  aiBaseUrl: 'https://api.openai.com/v1',
  aiApiKey: '',
  aiModel: '',
  // 本地 AI 桥接服务（供 Claude Code / Accio 等 AI 工具调用）
  bridgeEnabled: true,
  bridgeUrl: 'ws://127.0.0.1:17321/ext',
};

const TRACKING = /google-analytics\.com|googletagmanager\.com|analytics\.google\.com|doubleclick\.net|googlesyndication|hm\.baidu\.com|cnzz\.com|umeng\.com|umengcloud|sentry\.io|ingest\.sentry|\/sentry\/api|hotjar\.|segment\.(io|com)|mixpanel\.com|amplitude\.com|clarity\.ms|facebook\.com\/tr|connect\.facebook\.net|bat\.bing\.com|newrelic\.com|nr-data\.net|datadoghq|browser-intake|growingio|sensorsdata|arms-retcode|mmstat\.com|zhugeio|fullstory\.com|intercom\.io|bytedance\.com\/.*\/(log|monitor)|mcs\.zijieapi|snssdk\.com\/.*log|log\.zhihu|\/collect\?v=|\/gen_204|\/log204|beacon/i;
const STATIC_CT = /^(image|font|audio|video)\/|javascript|ecmascript|text\/css|wasm|octet-stream/i;

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ======================= 存储 =======================
// 当前录制：state / events / apiOverrides / aiDocs；脚本库：libIndex + lib:<id>
let cache = null;
let loading = null;
function load() {
  if (cache) return Promise.resolve(cache);
  if (!loading) {
    loading = chrome.storage.local.get(['state', 'events', 'settings', 'apiOverrides', 'aiDocs', 'libIndex', 'aiStatus']).then((d) => {
      // 后台刚启动时不可能有进行中的 AI 任务，存着 running 说明上次被浏览器回收了
      const ai = d.aiStatus && d.aiStatus.running
        ? { ...d.aiStatus, running: false, error: 'AI 分析被中断了（浏览器回收了扩展后台），请重试', finishedAt: Date.now() }
        : d.aiStatus || null;
      cache = {
        state: d.state || { recording: false },
        events: d.events || [],
        settings: { ...DEFAULT_SETTINGS, ...(d.settings || {}) },
        apiOverrides: d.apiOverrides || {},
        aiDocs: d.aiDocs || {},
        libIndex: d.libIndex || [],
        aiStatus: ai,
      };
      return cache;
    });
  }
  return loading;
}
let saveTimer = null;
function persist(now) {
  clearTimeout(saveTimer);
  const run = () => chrome.storage.local.set({ state: cache.state, events: cache.events, settings: cache.settings, apiOverrides: cache.apiOverrides, aiDocs: cache.aiDocs });
  if (now) return run();
  saveTimer = setTimeout(run, 400);
  return Promise.resolve();
}

function counts(c) {
  let steps = 0, requests = 0;
  for (const e of c.events) e.kind === 'request' ? requests++ : steps++;
  return { steps, requests };
}
function lastStep(c) {
  for (let i = c.events.length - 1; i >= 0; i--) if (c.events[i].kind === 'step') return c.events[i];
  return null;
}
function addEvent(c, ev) { c.events.push(ev); persist(); }

// ======================= 脚本库 =======================
function defaultName(c) {
  if (c.state.name) return c.state.name;
  if (c.aiDocs && c.aiDocs.title) return c.aiDocs.title;
  let host = '';
  try { host = new URL(c.state.startUrl).host; } catch (e) { /* ignore */ }
  const d = new Date(c.state.startedAt || Date.now());
  return `${c.state.title || host || '录制'} ${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
async function syncLibrary(c) {
  if (!c.state.id) return;
  if (!c.events.length) {
    // 录制被删光了（停止录制或删除步骤时都会走到这里）：脚本库里这条也删掉，免得还能运行旧步骤
    if (!c.libIndex.some((x) => x.id === c.state.id)) return;
    c.libIndex = c.libIndex.filter((x) => x.id !== c.state.id);
    await chrome.storage.local.remove('lib:' + c.state.id);
    await chrome.storage.local.set({ libIndex: c.libIndex });
    bridgeNotify('libraryChanged');
    return;
  }
  const item = {
    id: c.state.id,
    name: defaultName(c), // 未手动命名时：优先用 AI 建议的名称，否则用页面标题 + 时间
    description: c.state.description || (c.aiDocs && c.aiDocs.description) || '',
    savedAt: Date.now(),
    state: { ...c.state, recording: false },
    events: c.events,
    apiOverrides: c.apiOverrides,
    aiDocs: c.aiDocs,
    settings: c.settings,
  };
  const cnt = counts(c);
  let params = {};
  let direct = false; // 有没有关联输入参数的接口（能不能直接请求）
  try {
    const A = PR_EXPORTER.analyze(c.events, c.settings, c.state, c.apiOverrides, c.aiDocs);
    params = A.params;
    direct = A.apis.some((a) => !a.ignore && /\{\{[^}]+\}\}/.test(JSON.stringify(a.editParams || {})));
  } catch (e) { /* ignore */ }
  const entry = { id: item.id, name: item.name, description: item.description, startUrl: c.state.startUrl, savedAt: item.savedAt, steps: cnt.steps, requests: cnt.requests, hasDocs: !!(c.aiDocs && (c.aiDocs.title || Object.values(c.aiDocs.apis || {}).some((d) => d.fn || d.title || d.description))), params, direct };
  c.libIndex = [entry, ...c.libIndex.filter((x) => x.id !== item.id)];
  await chrome.storage.local.set({ ['lib:' + item.id]: item, libIndex: c.libIndex, state: c.state });
  bridgeNotify('libraryChanged');
}
async function getLibItem(c, ref) {
  if (!ref) throw new Error('缺少 recording 参数（脚本 id 或名称）');
  const r = String(ref).trim();
  const e = c.libIndex.find((x) => x.id === r) || c.libIndex.find((x) => x.name === r) || c.libIndex.find((x) => x.name.includes(r));
  if (!e) throw new Error(`脚本库中没有「${ref}」。可用：${c.libIndex.map((x) => x.name).join('、') || '（空）'}`);
  const d = await chrome.storage.local.get('lib:' + e.id);
  const item = d['lib:' + e.id];
  if (!item) throw new Error('脚本数据丢失：' + e.name);
  return item;
}
function buildItem(item) {
  return PR_EXPORTER.build(item.events, item.settings || DEFAULT_SETTINGS, item.state, item.apiOverrides, item.aiDocs);
}

// ======================= 录制控制 =======================
function keepRequest(r, s) {
  if (!r.url || !/^https?:/i.test(r.url)) return false;
  if (s.ignoreTracking && TRACKING.test(r.url)) return false;
  if (s.excludePattern) { try { if (new RegExp(s.excludePattern, 'i').test(r.url)) return false; } catch (e) { /* bad regex */ } }
  if (s.dataOnly) {
    const ct = (r.responseHeaders && r.responseHeaders['content-type']) || '';
    if (STATIC_CT.test(ct) && r.method === 'GET') return false;
    if (/\.(js|mjs|css|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|map)(\?|$)/i.test(r.url) && r.method === 'GET') return false;
  }
  return true;
}
function setBadge(on) {
  chrome.action.setBadgeText({ text: on ? 'REC' : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#e5484d' });
}
async function notifyTab(tabId, c, injectIfMissing) {
  const msg = { type: 'state', recording: !!(c.state.recording && c.state.tabId === tabId), settings: c.settings, counts: counts(c) };
  try {
    await chrome.tabs.sendMessage(tabId, msg, { frameId: 0 });
    chrome.tabs.sendMessage(tabId, msg).catch(() => {}); // 页面里的 iframe 也要知道录制状态
  } catch (e) {
    if (!injectIfMissing || !msg.recording) return;
    // 扩展安装前就打开的页面没有 content script，手动注入（之前的请求无法抓到）
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['inject/hook.js'], world: 'MAIN' }).catch(() => {});
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['content/recorder.js'] }).catch(() => {});
  }
}
async function start(c, tabId, fresh) {
  const tab = await chrome.tabs.get(tabId);
  if (!/^(https?|file):/i.test(tab.url || '')) throw new Error('当前页面不支持录制（仅支持 http/https/file 页面）');
  const prevTab = c.state.recording ? c.state.tabId : null;
  if (fresh || !c.events.length) {
    c.events = [];
    c.apiOverrides = {};
    c.aiDocs = {};
    c.state = { recording: true, tabId, id: uid(), name: '', startedAt: Date.now(), startUrl: tab.url, title: tab.title };
  } else {
    c.state = { ...c.state, recording: true, tabId };
  }
  const last = lastStep(c);
  if (!(last && last.type === 'navigate' && last.url === tab.url)) {
    addEvent(c, { kind: 'step', type: 'navigate', id: uid(), ts: Date.now(), url: tab.url, title: tab.title });
  }
  await persist(true);
  setBadge(true);
  if (prevTab && prevTab !== tabId) notifyTab(prevTab, c, false);
  await notifyTab(tabId, c, true);
}
async function stop(c) {
  const tabId = c.state.tabId;
  c.state = { ...c.state, recording: false, stoppedAt: Date.now() };
  await persist(true);
  setBadge(false);
  if (tabId != null) notifyTab(tabId, c, false);
  await syncLibrary(c); // 停止后自动存入脚本库
}

// ======================= AI 解读接口 =======================
// MV3 的 service worker 在 fetch 响应超过 30 秒没到时会被 Chrome 终止，而 AI 分析经常要更久：
// 所以用流式返回（响应头几秒内就到），分析期间定时调用扩展 API 重置空闲计时，
// 并且分析作为后台任务运行，状态存在 aiStatus 里，关掉弹窗也能继续，重新打开能看到结果或错误。
function parseJsonLoose(text) {
  const t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(t); } catch (e) { /* fallthrough */ }
  const i = t.indexOf('{');
  const j = t.lastIndexOf('}');
  if (i >= 0 && j > i) return JSON.parse(t.slice(i, j + 1));
  throw new Error('AI 返回的不是 JSON');
}
function aiEndpoint(s) {
  const anthropic = s.aiProvider === 'anthropic';
  let base = String(s.aiBaseUrl || '').trim().replace(/\/+$/, '').replace(/\/(chat\/completions|messages)$/, '');
  if (!base || (anthropic && base === 'https://api.openai.com/v1')) base = anthropic ? 'https://api.anthropic.com/v1' : 'https://api.openai.com/v1';
  return base + (anthropic ? '/messages' : '/chat/completions');
}
function errText(e) {
  if (typeof e === 'string') return e;
  return (e && (e.message || e.msg)) || JSON.stringify(e);
}
async function httpError(res) {
  const raw = await res.text().catch(() => '');
  let msg = '';
  try { const j = JSON.parse(raw); msg = errText(j.error || j); } catch (e) { msg = raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); }
  return new Error(`HTTP ${res.status}${res.statusText ? ' ' + res.statusText : ''}：${(msg || '无返回内容').slice(0, 300)}`);
}
async function readSSE(res, onData) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const flush = (all) => {
    let i;
    while ((i = buf.indexOf('\n')) >= 0 || (all && buf)) {
      const line = (i >= 0 ? buf.slice(0, i) : buf).trim();
      buf = i >= 0 ? buf.slice(i + 1) : '';
      if (!line.startsWith('data:')) continue;
      const d = line.slice(5).trim();
      if (!d || d === '[DONE]') continue;
      let j;
      try { j = JSON.parse(d); } catch (e) { continue; }
      onData(j);
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      flush(false);
    }
    flush(true);
  } catch (e) {
    reader.cancel().catch(() => {});
    throw e;
  }
}
async function callLLM(s, prompt, onProgress, signal) {
  const anthropic = s.aiProvider === 'anthropic';
  if (!s.aiApiKey && anthropic) throw new Error('请先在「设置」中填写 AI 的 API Key');
  if (!s.aiModel) throw new Error('请先在「设置」中填写 AI 模型名称');
  const system = '你是资深前端与接口分析专家，擅长从抓包数据中理解接口的业务含义。只输出 JSON。';
  const url = aiEndpoint(s);
  const headers = { 'content-type': 'application/json' };
  let body;
  if (anthropic) {
    Object.assign(headers, { 'x-api-key': s.aiApiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' });
    if (!/\/\/api\.anthropic\.com\//.test(url)) headers.authorization = 'Bearer ' + s.aiApiKey; // 中转服务多数认 Bearer
    body = { model: s.aiModel, max_tokens: 8000, system, messages: [{ role: 'user', content: prompt }] };
  } else {
    if (s.aiApiKey) headers.authorization = 'Bearer ' + s.aiApiKey;
    // 不传 temperature：gpt-5 / o 系列等推理模型会直接拒绝这个参数
    body = { model: s.aiModel, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] };
  }
  const post = async (stream) => {
    try {
      return await fetch(url, { method: 'POST', headers, body: JSON.stringify(Object.assign({}, body, stream ? { stream: true } : {})), signal });
    } catch (e) {
      if (signal && signal.aborted) throw new Error('AI 超过 5 分钟没有完成，已取消。接口太多时可以先删掉无关的步骤和请求再试');
      throw new Error(`连不上 ${url}（${e.message}）。请检查 Base URL、网络或代理`);
    }
  };
  let res = await post(true);
  if (!res.ok) {
    const err = await httpError(res);
    if (res.status !== 400 || !/stream/i.test(err.message)) throw err;
    res = await post(false); // 少数服务不支持流式
    if (!res.ok) throw await httpError(res);
  }
  let text = '';
  let stop = '';
  if (/event-stream/i.test(res.headers.get('content-type') || '')) {
    await readSSE(res, (j) => {
      if (j.error || j.type === 'error') throw new Error('AI 返回错误：' + errText(j.error || j));
      if (anthropic) {
        if (j.type === 'content_block_delta' && j.delta && j.delta.type === 'text_delta') text += j.delta.text;
        if (j.type === 'message_delta' && j.delta && j.delta.stop_reason) stop = j.delta.stop_reason;
      } else {
        const ch = j.choices && j.choices[0];
        if (ch && ch.delta && typeof ch.delta.content === 'string') text += ch.delta.content;
        if (ch && ch.finish_reason) stop = ch.finish_reason;
      }
      if (onProgress) onProgress(text.length);
    });
  } else {
    const raw = await res.text();
    let j;
    try { j = JSON.parse(raw); } catch (e) { throw new Error('AI 服务返回的不是 JSON（Base URL 可能填错了）：' + raw.replace(/\s+/g, ' ').slice(0, 200)); }
    if (j.error) throw new Error('AI 返回错误：' + errText(j.error));
    if (anthropic) {
      text = (j.content || []).map((x) => x.text || '').join('');
      stop = j.stop_reason || '';
    } else {
      const ch = (j.choices && j.choices[0]) || {};
      const content = ch.message && ch.message.content;
      text = Array.isArray(content) ? content.map((x) => x.text || '').join('') : content || '';
      stop = ch.finish_reason || '';
    }
  }
  if (!text.trim()) throw new Error(`AI 没有返回内容${stop ? '（结束原因：' + stop + '）' : ''}，请检查模型名称或换个模型`);
  return { text, stop };
}

let aiRunning = false;
async function setAiStatus(c, st) {
  c.aiStatus = st;
  await chrome.storage.local.set({ aiStatus: st });
}
async function startAiJob(c) {
  if (aiRunning) return;
  const startedAt = Date.now();
  const recId = c.state.id;
  const s = c.settings;
  let prompt;
  try {
    if (!s.aiModel) throw new Error('请先在「设置」中填写 AI 模型名称');
    if (!s.aiApiKey && s.aiProvider === 'anthropic') throw new Error('请先在「设置」中填写 AI 的 API Key');
    const out = PR_EXPORTER.build(c.events, s, c.state, c.apiOverrides, c.aiDocs);
    if (!out.analysis.apis.length) throw new Error('还没有抓到接口');
    prompt = out.prompt;
  } catch (e) {
    await setAiStatus(c, { error: e.message, startedAt, finishedAt: Date.now(), recId });
    return;
  }
  aiRunning = true;
  await setAiStatus(c, { running: true, startedAt, chars: 0, recId, model: s.aiModel });
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 300000);
  try {
    const { text, stop } = await callLLM(s, prompt, (n) => { c.aiStatus.chars = n; }, ctl.signal);
    let docs;
    try { docs = parseJsonLoose(text); } catch (e) {
      throw new Error(stop === 'length' || stop === 'max_tokens'
        ? 'AI 输出太长被截断了。可以先删掉无关的步骤和请求，或换一个输出上限更大的模型'
        : 'AI 返回的不是有效 JSON，开头是：' + text.replace(/\s+/g, ' ').slice(0, 150));
    }
    await saveDocsTo(c, recId || 'current', docs);
    await setAiStatus(c, { ok: true, startedAt, finishedAt: Date.now(), recId, apis: Object.keys(docs.apis || {}).length });
  } catch (e) {
    await setAiStatus(c, { error: String((e && e.message) || e), startedAt, finishedAt: Date.now(), recId, model: s.aiModel });
  } finally {
    clearInterval(keepAlive);
    clearTimeout(timer);
    aiRunning = false;
  }
}
function mergeDocs(old, docs) {
  const out = Object.assign({}, old || {});
  if (docs.title) out.title = docs.title;
  if (docs.slug) out.slug = docs.slug;
  if (docs.description) out.description = docs.description;
  out.apis = Object.assign({}, (old && old.apis) || {});
  for (const [k, v] of Object.entries(docs.apis || {})) out.apis[k] = Object.assign({}, out.apis[k] || {}, v);
  return out;
}
async function saveDocsTo(c, ref, docs) {
  if (!ref || ref === c.state.id || ref === 'current') {
    c.aiDocs = mergeDocs(c.aiDocs, docs);
    await persist(true);
    if (!c.state.recording) await syncLibrary(c);
    return { ok: true, id: c.state.id };
  }
  const item = await getLibItem(c, ref);
  if (item.id === c.state.id) return saveDocsTo(c, 'current', docs);
  item.aiDocs = mergeDocs(item.aiDocs, docs);
  if (!item.state.name && item.aiDocs.title) item.name = item.aiDocs.title;
  item.savedAt = Date.now();
  c.libIndex = c.libIndex.map((x) => (x.id === item.id ? { ...x, name: item.name, hasDocs: true, description: item.description || item.aiDocs.description || '' } : x));
  await chrome.storage.local.set({ ['lib:' + item.id]: item, libIndex: c.libIndex });
  bridgeNotify('libraryChanged');
  return { ok: true, id: item.id };
}

// ======================= 在浏览器中执行 =======================
async function waitTabComplete(tabId, timeout) {
  const end = Date.now() + (timeout || 30000);
  while (Date.now() < end) {
    const t = await chrome.tabs.get(tabId);
    if (t.status === 'complete') return t;
    await sleep(200);
  }
  return chrome.tabs.get(tabId);
}
// 返回注入的文档 id（Chrome 106+），之后用它判断框架里是不是还是同一个页面
async function injectRuntime(tabId, frameId) {
  const r = await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId || 0] }, files: ['lib/runtime.js'], world: 'MAIN' });
  return (r && r[0] && r[0].documentId) || null;
}
// 以下两个函数会被序列化后在页面主环境中执行
// seg = { from, to }：只执行这一段步骤（同一个框架里的连续步骤）；resume：扩展收到的最新断点
async function pageReplay(rec, params, apiParams, config, from, opened, seg, resume, skip, token) {
  window.__PR_TOKEN__ = token; // 断点回传时带上，扩展据此归到这次回放
  await window.__pageRecorderRuntime(rec, params, apiParams, Object.assign({}, config, { autoRun: false }));
  return window.__PR__.replay(Object.assign({ segment: seg, skip }, from === null ? { resume: resume || undefined } : { from, opened }));
}
// 回放中页面回传的断点：回放段 → 最新的断点（时间戳最大的）
const replayProgress = new Map();
// 页面在 executeScript 等待期间整页跳转时，Chrome 不会让这个 Promise 返回（会一直挂起），
// 所以每秒探测一次：框架里的文档换了（或者框架已经没了），就说明已经跳转，交给下一轮从断点继续
async function execReplay(tabId, frameId, docId, runId, args, deadline) {
  const token = runId + '|' + uid();
  const target = docId ? { tabId, documentIds: [docId] } : { tabId, frameIds: [frameId || 0] };
  const probeTarget = { tabId, frameIds: [frameId || 0] };
  let settled = null;
  chrome.scripting.executeScript({ target, world: 'MAIN', func: pageReplay, args: [...args, token] })
    .then((r) => { settled = { result: r && r[0] && r[0].result }; }, (e) => { settled = { error: e }; });
  let failures = 0;
  while (!settled && Date.now() < deadline) {
    await sleep(1000);
    if (settled) break;
    const alive = await Promise.race([
      chrome.scripting.executeScript({ target: probeTarget, world: 'MAIN', func: (t) => window.__PR_TOKEN__ === t, args: [token] })
        .then((r) => (docId && r && r[0] && r[0].documentId ? r[0].documentId === docId : r && r[0] && r[0].result), () => 'error'),
      sleep(3000).then(() => null),
    ]);
    failures = alive === 'error' ? failures + 1 : 0;
    if ((alive === false || failures >= 2) && !settled) return { navigated: true };
  }
  if (!settled) {
    // 超时：让页面里的回放停下，避免用户重试时出现两份操作
    await chrome.scripting.executeScript({ target: probeTarget, world: 'MAIN', func: () => { if (window.__PR__ && window.__PR__.cancel) window.__PR__.cancel(); } }).catch(() => {});
    await sleep(1000); // 给页面里正在等待/输入的步骤一点时间停下来
    throw new Error('超时');
  }
  if (settled.error) throw settled.error;
  return settled;
}

// ---------- iframe：按录制时的框架地址找到当前页面里对应的框架 ----------
// 源、路径、hash 路由、路由参数（mod 等）必须一致；其余参数（如每次不同的 cMKey）只用来在多个候选里挑最像的
const FRAME_ROUTE_KEY = /^(mod|module|act|action|method|route|op|cmd|do|service|api|func|ctl|controller|m|c|a|r|s)$/i;
function frameScore(recUrl, curUrl) {
  let a;
  let b;
  try { a = new URL(recUrl); b = new URL(curUrl); } catch (e) { return -1; }
  const [ah, aq] = a.hash.split('?');
  const [bh, bq] = b.hash.split('?');
  if (a.origin !== b.origin || a.pathname !== b.pathname || ah !== bh) return -1;
  let s = 1;
  for (const [A, B] of [[a.searchParams, b.searchParams], [new URLSearchParams(aq || ''), new URLSearchParams(bq || '')]]) {
    for (const k of new Set([...A.keys(), ...B.keys()])) {
      const same = A.getAll(k).join(',') === B.getAll(k).join(',');
      if (FRAME_ROUTE_KEY.test(k) && !same) return -1; // 路由参数（两边任一有的）必须一致
      if (same && A.has(k)) s += 1;
    }
  }
  return s;
}
async function listFrames(tabId) {
  const res = await Promise.race([
    chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: () => ({ url: location.href, ready: document.readyState }) }).catch(() => []),
    sleep(3000).then(() => []),
  ]);
  return (res || []).filter((r) => r && r.result && typeof r.result.url === 'string').map((r) => ({ frameId: r.frameId, url: r.result.url, ready: r.result.ready }));
}
async function findFrame(tabId, url, timeout) {
  const end = Date.now() + timeout;
  for (;;) {
    const frames = await listFrames(tabId);
    let best = null;
    for (const f of frames) {
      if (f.frameId === 0) continue; // 录的是 iframe 里的步骤，不能落到顶层页面
      const sc = frameScore(url, f.url);
      if (sc > 0 && (!best || sc > best.sc)) best = Object.assign({ sc }, f);
    }
    if (best && (best.ready === 'complete' || Date.now() > end)) return best.frameId;
    if (Date.now() > end) throw new Error(`页面里找不到 iframe ${url}（当前框架：${frames.map((f) => f.url).join('、') || '无'}）`);
    await sleep(400);
  }
}
async function findOriginFrame(origin, siteOrigin) {
  // 正在回放的标签页不用：在里面初始化接口调用会覆盖回放用的运行时
  const tabs = (await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] })).filter((t) => !runningTabs.has(t.id));
  const own = tabs.find((t) => t.url && t.url.startsWith(origin + '/'));
  if (own) return { tabId: own.id, frameId: 0 };
  for (const t of tabs.filter((x) => siteOrigin && x.url && x.url.startsWith(siteOrigin + '/'))) {
    const f = (await listFrames(t.id)).find((x) => x.url.startsWith(origin + '/'));
    if (f) return { tabId: t.id, frameId: f.frameId };
  }
  return null;
}
async function pageCall(rec, params, apiParams, config, api, args) {
  // 直接调用不开启请求改写：这个页面之后用户自己的操作不能被改成这次的参数
  await window.__pageRecorderRuntime(rec, params, apiParams, Object.assign({}, config, { autoRun: false, verbose: false, rewriteRequests: false }));
  return window.__PR__.api.call(api, args || {});
}
function mergeApiParams(base, extra) {
  const out = JSON.parse(JSON.stringify(base || {}));
  for (const [name, secs] of Object.entries(extra || {})) {
    out[name] = out[name] || {};
    for (const [sec, kv] of Object.entries(secs || {})) out[name][sec] = Object.assign({}, out[name][sec] || {}, kv);
  }
  return out;
}
async function pickTab(url, opts) {
  if (opts.tabId) return { tabId: opts.tabId, created: false };
  if (opts.reuseTab) {
    let origin = '';
    try { origin = new URL(url).origin; } catch (e) { /* ignore */ }
    const tabs = await chrome.tabs.query({});
    const t = tabs.find((x) => x.url && x.url.startsWith(origin));
    if (t) return { tabId: t.id, created: false };
  }
  const t = await chrome.tabs.create({ url, active: !!opts.active });
  return { tabId: t.id, created: true };
}
// ---------- 复用标签页 ----------
// 每条录制一个回放标签页、每个源一个接口调用标签页：第一次打开后留着，之后直接在里面执行，省掉打开页面的时间。
// 记在 chrome.storage.session 里（扩展后台被回收也不丢，浏览器重启后清空）
// 返回的标签页可能已被别的任务占用：调用方拿到后要同步再检查一次再占用
async function reusedTab(key) {
  let id = null;
  try { id = (await chrome.storage.session.get('reuse:' + key))['reuse:' + key]; } catch (e) { /* ignore */ }
  if (!id) return null;
  try { return await chrome.tabs.get(id); } catch (e) { return null; }
}
async function rememberTab(key, tabId) {
  try { await chrome.storage.session.set({ ['reuse:' + key]: tabId }); } catch (e) { /* ignore */ }
}
// 接口调用占用中的标签页（可以同时有多个调用）；回放要独占，等调用结束再用
const callingTabs = new Map();
const callBegin = (id) => callingTabs.set(id, (callingTabs.get(id) || 0) + 1);
const callEnd = (id) => { const n = (callingTabs.get(id) || 1) - 1; if (n > 0) callingTabs.set(id, n); else callingTabs.delete(id); };
// 直接请求模式：不操作页面，把输入参数填进关联了它的接口（字段值是 {{参数}} 的那些），在开着的页面里直接调用。
// 页面复用规则同 call_api：第一次在后台打开并留着，之后直接在里面发请求
function linkedApis(b) {
  return b.recording.apis.filter((a) => !a.ignore && /\{\{[^}]+\}\}/.test(JSON.stringify(b.apiParams[a.name] || {})));
}
async function runApiMode(item, b, apis, opts) {
  const t0 = Date.now();
  const deadline = t0 + (opts.timeout || 180000);
  const out = { ok: true, mode: 'api', recording: b.name, params: Object.assign({}, b.params, opts.params || {}), responses: [], extracted: {}, log: [] };
  for (const a of apis) {
    const left = deadline - Date.now();
    if (left <= 0) { out.ok = false; out.error = '超时，后面的接口没有调用'; break; }
    try {
      // newTab：用全新标签页（默认跑完关掉）；否则复用开着的页面。fresh 对直接请求没有意义（不依赖页面状态）
      const r = await callApi(item, a.name, {}, {
        params: opts.params, apiParams: opts.apiParams, tabId: opts.tabId, active: opts.active, callTimeout: left,
        reuseTab: opts.newTab ? false : undefined, keepTab: opts.keepTab,
      });
      out.responses.push({ api: a.name, fn: a.fn, status: r.status, ok: r.ok, url: r.url, data: r.data });
      out.log.push({ api: a.name, ok: !!r.ok, status: r.status });
      if (!r.ok) out.ok = false;
    } catch (e) {
      out.ok = false;
      out.error = `${a.name}：${(e && e.message) || e}`;
      out.log.push({ api: a.name, ok: false, error: String((e && e.message) || e) });
    }
  }
  out.ms = Date.now() - t0;
  return out;
}
// mode：'api' 直接请求；'ui' 回放页面操作；默认 'auto'：有关联输入参数的接口就直接请求，没有就回放页面操作
async function runRecording(item, opts) {
  opts = opts || {};
  const b = buildItem(item).bundle;
  const mode = opts.mode || 'auto';
  if (mode !== 'ui') {
    const apis = linkedApis(b);
    if (apis.length) return runApiMode(item, b, apis, opts);
    if (mode === 'api') throw new Error('这条录制里没有关联输入参数的接口，没法直接请求，请用 mode: "ui" 回放页面操作');
  }
  const params = Object.assign({}, b.params, opts.params || {});
  const apiParams = mergeApiParams(b.apiParams, opts.apiParams);
  const config = Object.assign({}, b.config, { highlight: !!opts.active, verbose: false }, opts.config || {});
  const deadline = Date.now() + (opts.timeout || 180000);
  // 同一个标签页同时只跑一个回放：指定了标签页时先占上（检查和占用之间不能有 await）
  if (opts.tabId) {
    if (runningTabs.has(opts.tabId)) throw new Error('这个标签页正在回放，请等它结束再试');
    runningTabs.add(opts.tabId);
  }
  let picked;
  // 默认复用这条录制上次用的回放标签页（还开着的话），跑完留着；newTab: true 时用全新的标签页、跑完关掉
  const reuse = !opts.tabId && !opts.newTab;
  const keep = !!opts.keepTab || reuse;
  let locked = opts.tabId || null;
  const capture = opts.capture !== false; // 回放期间抓下这个标签页里所有框架的接口返回，放在结果的 network 里
  try {
    let old = reuse ? await reusedTab('run:' + item.id) : null;
    for (let k = 0; old && callingTabs.has(old.id) && k < 50; k++) await sleep(100);
    if (old && (runningTabs.has(old.id) || callingTabs.has(old.id))) old = null; // 拿到后同步复查再占用
    if (old) {
      runningTabs.add(old.id);
      locked = old.id;
      if (capture) startCapture(old.id);
      // 默认不刷新（最快）；fresh: true 时回到起始页面重新加载，从干净的页面状态开始
      if (opts.fresh || !sameSitePath(old.url, b.recording.startUrl)) await chrome.tabs.update(old.id, { url: b.recording.startUrl });
      if (opts.active) await chrome.tabs.update(old.id, { active: true });
      picked = { tabId: old.id, created: false };
    } else {
      // 先开空白页、打开抓包，再跳到起始页面：页面一加载发的请求也能抓到
      picked = await pickTab(capture && !opts.tabId ? 'about:blank' : b.recording.startUrl, { ...opts, reuseTab: false });
      if (capture) startCapture(picked.tabId);
      if (capture && picked.created) await chrome.tabs.update(picked.tabId, { url: b.recording.startUrl });
      if (reuse) await rememberTab('run:' + item.id, picked.tabId);
    }
  } catch (e) {
    if (locked) runningTabs.delete(locked);
    if (picked) stopCapture(picked.tabId);
    if (locked) stopCapture(locked);
    throw e;
  }
  const { tabId, created } = picked;
  const runId = uid();
  runningTabs.add(tabId);
  // 按所在框架把步骤切成几段：顶层页面的连续步骤一段，同一个 iframe 里的连续步骤一段，依次在对应框架里执行
  const segs = [];
  b.recording.steps.forEach((s, i) => {
    const key = s.frame ? s.frame.url : '';
    const last = segs[segs.length - 1];
    if (last && last.key === key) { last.to = i + 1; last.allOptional = last.allOptional && !!s.optional; }
    else segs.push({ key, frame: s.frame || null, from: i, to: i + 1, allOptional: !!s.optional });
  });
  const total = { ok: true, total: b.recording.steps.length, completed: 0, extracted: {}, responses: [], log: [] };
  let skip = false; // 可选步骤组的跳过状态，跨段传递
  try {
    for (let si = 0; si < segs.length; si++) {
      const seg = segs[si];
      if (si > 0) await sleep(config.stepDelay || 400);
      const key = runId + '.' + si; // 断点按“这次回放的第几段”归档，避免上一段迟到的断点混进来
      activeRuns.add(key);
      const r = await runSegment(tabId, key, b, params, apiParams, config, seg, si === 0 && created ? b.recording.startUrl : null, skip, deadline);
      skip = !!r.skip;
      Object.assign(total.extracted, r.extracted || {});
      total.responses.push(...(r.responses || []));
      total.log.push(...(r.log || []));
      total.completed = r.completed;
      if (!r.ok) {
        total.ok = false;
        total.error = r.error;
        break;
      }
    }
    const tab = await chrome.tabs.get(tabId);
    total.finalUrl = tab.url;
    total.recording = b.name;
    const cap = captures.get(tabId);
    if (cap) total.network = cap.list;
    return total;
  } finally {
    stopCapture(tabId);
    runningTabs.delete(tabId);
    for (const k of [...activeRuns]) if (k.startsWith(runId + '.')) { activeRuns.delete(k); replayProgress.delete(k); }
    if (created && !keep) chrome.tabs.remove(tabId).catch(() => {});
  }
}
// ---------- 回放期间全量抓包 ----------
// 回放标签页里所有框架（包括整页跳转后的新页面、跨域 iframe）发出的 fetch / XHR 及返回，
// 由录制用的 hook.js / recorder.js 抓下来送到这里（它们在页面一开始加载时就注入，页面加载时的请求也能抓到）
const captures = new Map(); // tabId → { list, bytes }
const CAPTURE_MAX = 300;
const CAPTURE_BYTES = 8 * 1024 * 1024;
function startCapture(tabId) {
  if (!captures.has(tabId)) captures.set(tabId, { list: [], bytes: 0 });
  chrome.tabs.sendMessage(tabId, { type: 'capture', on: true }).catch(() => {});
}
function stopCapture(tabId) {
  if (!captures.delete(tabId)) return;
  chrome.tabs.sendMessage(tabId, { type: 'capture', on: false }).catch(() => {});
}
function addCapture(cap, ev, sender) {
  if (cap.list.length >= CAPTURE_MAX) return;
  const rb = ev.responseBody;
  let data = rb ? (rb.value !== undefined ? rb.value : null) : null;
  const size = data == null ? 0 : (typeof data === 'string' ? data.length : JSON.stringify(data).length);
  if (cap.bytes + size > CAPTURE_BYTES) data = '(总量过大，已省略)';
  else cap.bytes += size;
  cap.list.push({
    ts: ev.ts, method: ev.method, url: ev.url, status: ev.status, error: ev.error,
    frame: sender.frameId ? sender.url : undefined, type: rb ? rb.type : null, truncated: !!(rb && rb.truncated), data,
  });
}
// 复用的标签页还在同一个站点同一个路径上，就不用重新打开
function sameSitePath(a, b) {
  try { const x = new URL(a); const y = new URL(b); return x.origin === y.origin && x.pathname === y.pathname; } catch (e) { return false; }
}
const runningTabs = new Set(); // 同一个标签页同时只跑一个回放
const activeRuns = new Set();  // 正在进行的回放段，只接收它们回传的断点
async function runSegment(tabId, runId, b, params, apiParams, config, seg, opened, skip, deadline) {
  // 整段都是可选步骤（比如只在未登录时出现的登录 iframe）：iframe 不在就整段跳过
  if (seg.frame && seg.allOptional) {
    await waitTabComplete(tabId);
    const found = await findFrame(tabId, seg.frame.url, config.optionalTimeout || 3000).then(() => true, () => false);
    if (!found) {
      const steps = b.recording.steps.slice(seg.from, seg.to);
      return { ok: true, skip: true, completed: seg.to, extracted: {}, responses: [], log: steps.map((s, k) => ({ step: seg.from + k + 1, desc: s.desc, ok: true, skipped: true, reason: '页面里没有这个 iframe' })) };
    }
  }
  let lastErr = null;
  for (let round = 0; round < 20 && Date.now() < deadline; round++) {
    let resume = null;
    if (round > 0) {
      await sleep(800);
      // 整页跳转后：以页面回传的最新断点为准。最后一步引起的跳转，这一段其实已经做完了
      resume = replayProgress.get(runId) || null;
      if (resume && resume.i >= seg.to) {
        return { ok: true, skip: !!resume.skip, completed: resume.i, extracted: resume.extracted || {}, responses: resume.responses || [], log: resume.log || [] };
      }
      if (resume && resume.i < seg.from) resume = null;
    }
    await waitTabComplete(tabId);
    try {
      const frameId = seg.frame ? await findFrame(tabId, seg.frame.url, Math.min(20000, deadline - Date.now())) : 0;
      const docId = await injectRuntime(tabId, frameId);
      const r = await execReplay(tabId, frameId, docId, runId, [b.recording, params, apiParams, config, round === 0 ? seg.from : null, round === 0 ? opened : null, { from: seg.from, to: seg.to }, resume, skip], deadline);
      const result = r.navigated ? null : r.result;
      if (result && typeof result === 'object' && 'ok' in result && !result.navigating) return result;
    } catch (e) {
      lastErr = e; // 整页跳转会中断当前执行，下一轮从断点继续
    }
  }
  throw new Error(`第 ${seg.from + 1}～${seg.to} 步执行未完成：${(lastErr && lastErr.message) || '超时'}`);
}
async function callApi(item, api, args, opts) {
  opts = opts || {};
  const b = buildItem(item).bundle;
  const a = b.recording.apis.find((x) => x.name === api || x.fn === api) || b.recording.apis.find((x) => x.name.includes(api));
  if (!a) throw new Error(`「${b.name}」中没有接口 ${api}。可用：${b.recording.apis.map((x) => x.fn + ' (' + x.name + ')').join(', ')}`);
  // 在“发出这个接口的页面”里调用：iframe 里的接口在那个 iframe 的页面里调；跨域接口也照页面当初的方式发
  // （带着浏览器的 Cookie、登录态，不额外跨域）
  const ctxUrl = a.pageUrl || b.recording.startUrl;
  let ctx = '';
  let siteOrigin = '';
  try { ctx = new URL(ctxUrl).origin; siteOrigin = new URL(b.recording.startUrl).origin; } catch (e) { /* ignore */ }
  if (opts.tabId && runningTabs.has(opts.tabId)) throw new Error('这个标签页正在回放，请等它结束再调用接口');
  // 默认复用：先找上次为这个页面源开的接口调用标签页，再找其他开着的页面（包括 iframe）；都没有才新开一个并留着。
  // reuseTab: false 时用全新标签页，默认用完关掉（keepTab: true 保留）
  const reuse = !opts.tabId && opts.reuseTab !== false;
  const keep = opts.keepTab !== undefined ? !!opts.keepTab : reuse;
  let target = null;
  if (reuse) {
    const kept = await reusedTab('call:' + ctx);
    if (kept && kept.url && kept.url.startsWith(ctx + '/')) target = { tabId: kept.id, frameId: 0 };
    if (!target) target = await findOriginFrame(ctx, siteOrigin);
    if (target && runningTabs.has(target.tabId)) target = null; // 选的时候还空着，现在被回放占了
  }
  let created = false;
  if (!target) {
    const t = await pickTab(ctxUrl, { ...opts, reuseTab: false });
    created = t.created;
    target = { tabId: t.tabId, frameId: 0 };
    if (created && reuse && keep) await rememberTab('call:' + ctx, t.tabId);
  }
  const tabId = target.tabId;
  callBegin(tabId);
  try {
    await waitTabComplete(tabId);
    await injectRuntime(tabId, target.frameId);
    const config = Object.assign({}, b.config, opts.callTimeout ? { callTimeout: opts.callTimeout } : {});
    const [r] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [target.frameId] }, world: 'MAIN', func: pageCall,
      args: [b.recording, Object.assign({}, b.params, opts.params || {}), mergeApiParams(b.apiParams, opts.apiParams), config, a.name, args || {}],
    });
    return Object.assign({ api: a.name, fn: a.fn }, r && r.result);
  } finally {
    callEnd(tabId);
    if (created && !keep) chrome.tabs.remove(tabId).catch(() => {});
  }
}

// ======================= 本地 AI 桥接 =======================
let ws = null;
let wsKeep = null;
function bridgeConnected() { return !!(ws && ws.readyState === 1); }
function bridgeNotify(event) { if (bridgeConnected()) ws.send(JSON.stringify({ type: 'event', event })); }
function recordingSummary(item) {
  const out = buildItem(item);
  const A = out.analysis;
  return {
    id: item.id,
    name: A.name,
    slug: (item.aiDocs && item.aiDocs.slug) || '',
    description: A.description,
    startUrl: A.startUrl,
    savedAt: item.savedAt,
    steps: A.steps.map((s, i) => `${i + 1}. ${s.desc}`),
    params: A.params,
    tools: out.tools,
    hasDocs: !!(item.aiDocs && item.aiDocs.apis),
  };
}
async function bridgeHandle(method, p) {
  const c = await load();
  switch (method) {
    case 'list': {
      const out = [];
      for (const e of c.libIndex) { try { out.push(recordingSummary(await getLibItem(c, e.id))); } catch (err) { /* skip */ } }
      return out;
    }
    case 'get': {
      const item = await getLibItem(c, p.recording);
      const out = buildItem(item);
      const A = out.analysis;
      return {
        id: item.id, name: A.name, description: A.description, startUrl: A.startUrl,
        steps: A.steps.map((s, i) => ({ index: i + 1, desc: s.desc, apis: [...new Set(s.requests.map((r) => r.api))] })),
        params: A.params,
        apis: A.apis.map((a) => ({
          name: a.name, fn: a.fn, title: a.title, description: a.description, returns: a.returns, ignore: a.ignore,
          url: a.url, status: a.status, contentType: a.contentType, triggeredBy: a.triggeredBy, count: a.count,
          params: a.editParams, paramNotes: a.paramMeta, responseSchema: a.schema, responseSample: a.sample,
        })),
        tools: out.tools,
        analysisPrompt: out.prompt,
      };
    }
    case 'script': return { name: (await getLibItem(c, p.recording)).name, script: buildItem(await getLibItem(c, p.recording)).script };
    case 'run': return runRecording(await getLibItem(c, p.recording), p);
    case 'call': return callApi(await getLibItem(c, p.recording), p.api, p.args, p);
    case 'saveDocs': return saveDocsTo(c, p.recording, p.docs || {});
    default: throw new Error('未知方法 ' + method);
  }
}
function bridgeConnect() {
  if (!cache || !cache.settings.bridgeEnabled || !cache.settings.bridgeUrl) return;
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
  try { ws = new WebSocket(cache.settings.bridgeUrl); } catch (e) { ws = null; return; }
  const sock = ws;
  sock.onopen = () => {
    sock.send(JSON.stringify({ type: 'hello', version: chrome.runtime.getManifest().version }));
    clearInterval(wsKeep);
    wsKeep = setInterval(() => { if (sock.readyState === 1) sock.send(JSON.stringify({ type: 'ping' })); }, 20000);
  };
  sock.onmessage = async (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.type !== 'request') return;
    try {
      const data = await bridgeHandle(m.method, m.params || {});
      sock.send(JSON.stringify({ type: 'response', id: m.id, ok: true, data }));
    } catch (e) {
      sock.send(JSON.stringify({ type: 'response', id: m.id, ok: false, error: String((e && e.message) || e) }));
    }
  };
  sock.onclose = () => { if (ws === sock) ws = null; clearInterval(wsKeep); };
  sock.onerror = () => {};
}
chrome.alarms.create('bridge', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'bridge') load().then(bridgeConnect); });

// ======================= 消息 =======================
async function handle(msg, sender) {
  const c = await load();
  switch (msg.type) {
    case 'hello': {
      const rec = !!(c.state.recording && sender.tab && sender.tab.id === c.state.tabId);
      const capture = !!(sender.tab && captures.has(sender.tab.id));
      if (rec && sender.frameId === 0) { // iframe 加载不算一步，只记顶层页面的跳转
        const last = lastStep(c);
        const dup = last && last.url === msg.url && (last.type === 'navigate' || Date.now() - last.ts < 1500) && Date.now() - last.ts < 3000;
        if (!dup) addEvent(c, { kind: 'step', type: 'navigate', id: uid(), ts: Date.now(), url: msg.url, title: msg.title });
      }
      return { recording: rec, capture, settings: c.settings, counts: counts(c) };
    }
    case 'event': {
      if (!c.state.recording || !sender.tab || sender.tab.id !== c.state.tabId) {
        // 不是录制中的标签页：回放抓包时收下请求
        const cap = sender.tab && captures.get(sender.tab.id);
        if (cap && msg.event && msg.event.kind === 'request' && keepRequest(msg.event, c.settings)) addCapture(cap, msg.event, sender);
        return { ignored: !cap };
      }
      const ev = msg.event;
      if (ev.kind === 'request' && !keepRequest(ev, c.settings)) return { counts: counts(c) };
      // 来自 iframe：步骤记下所在框架（回放时按地址找到这个框架再执行），请求记下发出它的页面
      if (sender.frameId) {
        if (ev.kind === 'step') ev.frame = { url: sender.url || ev.url };
        else ev.frameUrl = sender.url;
      }
      addEvent(c, ev);
      return { counts: counts(c) };
    }
    case 'updateEvent': {
      const ev = c.events.find((e) => e.id === msg.id);
      if (ev) { Object.assign(ev, msg.patch); persist(); }
      return { ok: !!ev };
    }
    case 'start': await start(c, msg.tabId, !!msg.fresh); return { ok: true };
    case 'stop': await stop(c); return { ok: true };
    case 'getData':
      return { state: c.state, events: c.events, settings: c.settings, apiOverrides: c.apiOverrides, aiDocs: c.aiDocs, aiStatus: c.aiStatus, counts: counts(c), libIndex: c.libIndex, bridge: bridgeConnected() };
    case 'clear':
      c.events = [];
      c.apiOverrides = {};
      c.aiDocs = {};
      c.state = c.state.recording ? { ...c.state, id: uid(), name: '' } : { recording: false };
      await persist(true);
      return { ok: true };
    case 'deleteEvent':
    case 'deleteEvents': {
      const ids = new Set(msg.ids || [msg.id]);
      const firstStep = (list) => list.filter((e) => e.kind === 'step' && !e.frame).reduce((a, e) => (!a || e.ts < a.ts ? e : a), null);
      const first = firstStep(c.events);
      c.events = c.events.filter((e) => !ids.has(e.id));
      // 删掉了开头的顶层步骤（比如打开页面 + 登录），起始页面改成剩下第一个顶层步骤所在的页面
      if (first && ids.has(first.id)) {
        const next = firstStep(c.events);
        if (next && next.url) c.state.startUrl = next.url;
      }
      await persist(true);
      if (!c.state.recording) await syncLibrary(c);
      return { ok: true, deleted: ids.size };
    }
    case 'setParam': {
      // 修改输入参数的默认值 = 修改对应输入步骤录下的值（导出脚本的 PARAMS、回放、关联的接口字段都跟着变）
      const ev = c.events.find((e) => e.id === msg.id && e.kind === 'step' && e.type === 'fill');
      if (!ev) throw new Error('找不到这个输入步骤');
      if (ev.sensitive) throw new Error('密码类参数不保存，回放时通过参数传入');
      // 留着最初录到的值：接口字段和输入参数的关联是按录制值对上的，改了默认值也不能断
      if (ev.recordedValue === undefined) ev.recordedValue = ev.value;
      ev.value = String(msg.value == null ? '' : msg.value);
      await persist(true);
      if (!c.state.recording) await syncLibrary(c);
      return { ok: true };
    }
    case 'setOptional': {
      // 可选步骤：回放时页面上有这个元素就执行，没有就跳过（比如只在未登录时出现的登录步骤）
      const ids = new Set(msg.ids || []);
      let n = 0;
      for (const e of c.events) {
        if (e.kind !== 'step' || !ids.has(e.id)) continue;
        if (msg.optional) e.optional = true; else delete e.optional;
        n++;
      }
      await persist(true);
      if (!c.state.recording) await syncLibrary(c);
      return { ok: true, changed: n };
    }
    case 'setMeta':
      if (msg.name != null) c.state.name = String(msg.name).trim();
      if (msg.description != null) c.state.description = String(msg.description).trim();
      await persist(true);
      if (!c.state.recording) await syncLibrary(c);
      return { ok: true };
    case 'saveSettings': {
      const prevBridge = c.settings.bridgeUrl + c.settings.bridgeEnabled;
      c.settings = { ...c.settings, ...msg.settings };
      await persist(true);
      if (prevBridge !== c.settings.bridgeUrl + c.settings.bridgeEnabled) { if (ws) ws.close(); ws = null; bridgeConnect(); }
      return { settings: c.settings };
    }
    case 'saveApiOverrides':
      c.apiOverrides = msg.apiOverrides || {};
      await persist(true);
      if (!c.state.recording) await syncLibrary(c);
      return { ok: true };
    case 'saveToLibrary': await syncLibrary(c); return { ok: true };
    case 'replayProgress': {
      const runId = String(msg.token || '').split('|')[0];
      if (!activeRuns.has(runId)) return { ok: false };
      let data = null;
      try { data = JSON.parse(msg.data); } catch (e) { return { ok: false }; }
      const cur = replayProgress.get(runId);
      if (runId && data && typeof data.i === 'number' && (!cur || data.t >= cur.t)) replayProgress.set(runId, data);
      return { ok: true };
    }
    case 'aiAnalyze':
      startAiJob(c); // 后台运行，进度和结果通过 getData 的 aiStatus 查看
      await sleep(50);
      return { ok: true, aiStatus: c.aiStatus };
    case 'aiDismiss':
      if (c.aiStatus && !c.aiStatus.running) await setAiStatus(c, null);
      return { ok: true };
    case 'getPrompt': return { prompt: PR_EXPORTER.build(c.events, c.settings, c.state, c.apiOverrides, c.aiDocs).prompt };
    case 'saveAiDocs': return saveDocsTo(c, 'current', msg.docs || {});
    case 'libGet': return { item: await getLibItem(c, msg.id) };
    case 'libOpen': {
      if (c.state.recording) throw new Error('请先停止录制');
      const item = await getLibItem(c, msg.id);
      c.state = { ...item.state, recording: false };
      c.events = item.events;
      c.apiOverrides = item.apiOverrides || {};
      c.aiDocs = item.aiDocs || {};
      await persist(true);
      return { ok: true };
    }
    case 'libDelete':
      c.libIndex = c.libIndex.filter((x) => x.id !== msg.id);
      await chrome.storage.local.remove('lib:' + msg.id);
      await chrome.storage.local.set({ libIndex: c.libIndex });
      bridgeNotify('libraryChanged');
      return { ok: true };
    case 'libRun': return { result: await runRecording(await getLibItem(c, msg.id), { active: true, keepTab: true, params: msg.params || undefined, fresh: !!msg.fresh, newTab: !!msg.newTab, mode: msg.mode || 'ui' }) };
    case 'bridgeReconnect': if (ws) ws.close(); ws = null; bridgeConnect(); await sleep(600); return { bridge: bridgeConnected() };
    default:
      return { error: 'unknown message' };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg || {}, sender).then(sendResponse, (e) => sendResponse({ error: String((e && e.message) || e) }));
  return true;
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const c = await load();
  if (c.state.recording && c.state.tabId === tabId) await stop(c);
});

load().then((c) => { setBadge(!!c.state.recording); bridgeConnect(); });
