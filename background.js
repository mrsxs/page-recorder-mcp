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
  // 回放时用浏览器调试接口发真实的鼠标、键盘输入（回放期间页面上方会出现“正在调试此浏览器”的提示条）
  realInput: true,
  // 多个浏览器资料都装了扩展时，桥接用这个名字区分（AI 调用时可用 browser 参数指定）
  profileLabel: '',
};

const TRACKING = /google-analytics\.com|googletagmanager\.com|analytics\.google\.com|doubleclick\.net|googlesyndication|hm\.baidu\.com|cnzz\.com|umeng\.com|umengcloud|sentry\.io|ingest\.sentry|\/sentry\/api|hotjar\.|segment\.(io|com)|mixpanel\.com|amplitude\.com|clarity\.ms|facebook\.com\/tr|connect\.facebook\.net|bat\.bing\.com|newrelic\.com|nr-data\.net|datadoghq|browser-intake|growingio|sensorsdata|arms-retcode|mmstat\.com|zhugeio|fullstory\.com|intercom\.io|bytedance\.com\/.*\/(log|monitor)|mcs\.zijieapi|snssdk\.com\/.*log|log\.zhihu|\/collect\?v=|\/gen_204|\/log204|beacon/i;
const STATIC_CT = /^(image|font|audio|video)\/|text\/css|wasm/i;

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

// 录制中输入过的密码（只在内存 / 会话存储里，停止录制就清掉）
let secretCache = null;
async function secretsOf() {
  if (!secretCache) {
    try { secretCache = (await chrome.storage.session.get('secrets')).secrets || []; } catch (e) { secretCache = []; }
  }
  return secretCache;
}
function clearSecrets() {
  secretCache = [];
  chrome.storage.session.remove('secrets').catch(() => {});
}
function counts(c) {
  let steps = 0, requests = 0;
  // 语义步骤的成员（原始点击）不单独算一步
  const ids = new Set(c.events.map((e) => e.id));
  for (const e of c.events) {
    if (e.kind === 'request') requests++;
    else if (!(e.groupedIn && ids.has(e.groupedIn))) steps++;
  }
  return { steps, requests };
}
function lastStep(c) {
  for (let i = c.events.length - 1; i >= 0; i--) if (c.events[i].kind === 'step') return c.events[i];
  return null;
}
function addEvent(c, ev) { c.events.push(ev); groupMembers(c, ev); persist(); }
// 语义步骤（设置日期、选择选项、双击）的成员：原始点击保留但归到它下面，时间线和回放都由它负责
function groupMembers(c, ev) {
  if (!Array.isArray(ev.members)) return;
  const ids = new Set(ev.members);
  for (const e of c.events) {
    if (e === ev) continue;
    if (ids.has(e.id)) e.groupedIn = ev.id;
    else if (e.groupedIn === ev.id) delete e.groupedIn;
  }
}

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

// ======================= 浏览器层面的兜底抓取 =======================
// 页面里的钩子只看得到页面自己发的 fetch / XHR（加上 JSONP、EventSource、sendBeacon）。Worker 里发的请求、表单提交、
// 点链接下载导出的文件、在钩子装上之前就把 fetch 拿走的代码，钩子都看不到。录制期间用 webRequest 看着录制标签页的全部请求：
// 钩子没抓到的补记一条（地址、方法、请求头、请求体、状态、返回头都有，只是没有返回内容）
const NET_TYPES = ['xmlhttprequest', 'main_frame', 'sub_frame', 'script', 'ping', 'object', 'other'];
const JSONP_KEY = /^(callback|cb|jsonp|jsoncallback|jsonpcallback|_callback|callbackname|jsonp_callback|_jsonp|_cb)$/i;
// 浏览器自己加的头不是页面代码设的，重发时不该带
const BROWSER_HDR = /^(user-agent|sec-.*|upgrade-insecure-requests|host|connection|content-length|x-client-data|origin|referer|if-none-match|if-modified-since|range|priority|dnt|cache-control|pragma|accept-encoding|accept-language|purpose|cookie)$/i;
const netSeen = new Map();     // requestId → 进行中的请求
let netDone = [];              // 已结束、等着和钩子抓到的对账
const pairedIds = new Set();   // 已经和浏览器层面的记录对上的钩子事件
let netTimer = null;
const netTabs = (c) => (c && c.state.recording ? [c.state.tabId, ...(c.state.childTabs || [])] : []);
const headerObj = (list) => {
  const o = {};
  for (const h of list || []) o[String(h.name).toLowerCase()] = h.value != null ? String(h.value) : '';
  return o;
};
const isDownload = (r) => {
  const h = r.responseHeaders || {};
  return /attachment/i.test(h['content-disposition'] || '') || /octet-stream|zip|excel|spreadsheet|officedocument|msword|\/csv|x-download|force-download/i.test(h['content-type'] || '');
};
function fileNameOf(h) {
  const cd = String((h || {})['content-disposition'] || '');
  const star = cd.match(/filename\*\s*=\s*[^']*'[^']*'([^;]+)/i);
  if (star) { try { return decodeURIComponent(star[1].trim()); } catch (e) { return star[1].trim(); } }
  const m = cd.match(/filename\s*=\s*("([^"]*)"|[^;]+)/i);
  return m ? (m[2] !== undefined ? m[2] : m[1]).trim() : '';
}
function onNetStart(d) {
  const c = cache;
  if (!netTabs(c).includes(d.tabId)) return;
  // 重定向（POST /submit → 303 → GET /success）沿用同一个编号再来一次：记的是页面最初发的那个请求（方法、请求体），不覆盖
  const prev = netSeen.get(d.requestId);
  if (prev) { prev.redirectedTo = d.url; return; }
  if (d.type === 'script') {
    // 脚本里只有 JSONP（地址带回调参数）是数据接口
    try { if (![...new URL(d.url).searchParams].some(([k, v]) => JSONP_KEY.test(k) && /^[A-Za-z_$][\w$.]*$/.test(v))) return; } catch (e) { return; }
  }
  if (netSeen.size > 2000) netSeen.delete(netSeen.keys().next().value);
  netSeen.set(d.requestId, { url: d.url, method: d.method, type: d.type, ts: Math.round(d.timeStamp), tabId: d.tabId, frameId: d.frameId, pageUrl: d.documentUrl || d.initiator || '', body: d.requestBody || null });
}
function onNetHeaders(d) {
  const r = netSeen.get(d.requestId);
  if (r && !r.requestHeaders) r.requestHeaders = headerObj(d.requestHeaders); // 重定向之后那一跳的头不算
}
function onNetResponse(d) {
  const r = netSeen.get(d.requestId);
  if (!r) return;
  r.status = d.statusCode;
  r.statusText = String(d.statusLine || '').replace(/^\S+\s+\d+\s*/, '');
  r.responseHeaders = headerObj(d.responseHeaders);
}
function onNetEnd(d) {
  const r = netSeen.get(d.requestId);
  if (!r) return;
  netSeen.delete(d.requestId);
  r.endTs = Math.round(d.timeStamp);
  if (d.statusCode) r.status = d.statusCode;
  if (d.responseHeaders) r.responseHeaders = headerObj(d.responseHeaders);
  // 变成下载的跳转会以“中止”结束：返回头已经到了就不算失败
  if (d.error && !(r.status && isDownload(r))) r.error = d.error;
  const nav = r.type === 'main_frame' || r.type === 'sub_frame';
  // 页面跳转本身是操作步骤，不是接口；提交表单（非 GET）和下载文件才记
  if (nav && r.method === 'GET' && !isDownload(r)) return;
  // 跨域预检不是页面发的
  if (r.method === 'OPTIONS' && (r.requestHeaders || {})['access-control-request-method']) return;
  netDone.push(r);
  if (!netTimer) netTimer = setTimeout(() => { netTimer = null; netFlush(false); }, 1000);
}
function netBody(b, ct, max) {
  if (!b) return null;
  if (b.formData) {
    const pairs = [];
    for (const [k, vs] of Object.entries(b.formData)) for (const v of vs) pairs.push([k, String(v)]);
    // multipart 多半带文件，浏览器层面拿不到文件内容：标成不完整，不能照着重发
    if (/multipart/i.test(ct)) return { type: 'multipart', value: pairs, truncated: true };
    return { type: 'form', value: new URLSearchParams(pairs).toString() };
  }
  if (!Array.isArray(b.raw) || !b.raw.length) return null;
  if (b.raw.some((x) => !x.bytes)) return { type: 'blob', mime: ct };
  const size = b.raw.reduce((n, x) => n + x.bytes.byteLength, 0);
  if (ct && !/json|^text\/|[/+]xml\b|javascript|x-www-form-urlencoded|graphql|csv|yaml/i.test(ct)) return { type: 'binary', size };
  const buf = new Uint8Array(size);
  let at = 0;
  for (const x of b.raw) { buf.set(new Uint8Array(x.bytes), at); at += x.bytes.byteLength; }
  let text = '';
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch (e) { return { type: 'binary', size }; }
  if (text.length > max) return { type: 'text', value: text.slice(0, max), size: text.length, truncated: true };
  if (/json/i.test(ct) || /^\s*[[{]/.test(text)) { try { return { type: 'json', value: JSON.parse(text), size: text.length }; } catch (e) { /* 不是 JSON */ } }
  if (/x-www-form-urlencoded/i.test(ct)) return { type: 'form', value: text };
  return { type: 'text', value: text, size: text.length };
}
function netEvent(r, c) {
  const reqH = {};
  for (const [k, v] of Object.entries(r.requestHeaders || {})) {
    if (BROWSER_HDR.test(k) || (k === 'accept' && (/^\*\/\*$/.test(v) || /^text\/html/.test(v)))) continue;
    reqH[k] = v;
  }
  const ev = {
    kind: 'request', id: uid(), via: 'browser', resType: r.type, ts: r.ts, endTs: r.endTs, pageUrl: r.pageUrl, method: r.method, url: r.url,
    requestHeaders: reqH, requestBody: netBody(r.body, String((r.requestHeaders || {})['content-type'] || ''), (c.settings.maxBodyKB || 512) * 1024),
    status: r.status || 0, statusText: r.statusText || '', responseHeaders: r.responseHeaders || {}, responseBody: null, noBody: true,
  };
  if (r.error) ev.error = r.error;
  if (r.tabId !== c.state.tabId) ev.otherTab = true;
  if (isDownload(r)) ev.download = fileNameOf(r.responseHeaders) || true;
  return ev;
}
// 对账：钩子抓到了同一条（方法、地址相同，时间相近）就以钩子的为准，没抓到的补记
async function netFlush(all) {
  const c = await load();
  const now = Date.now();
  const wait = [];
  for (const r of netDone.splice(0)) {
    if (!netTabs(c).includes(r.tabId)) continue;
    if (!all && now - r.endTs < 2500) { wait.push(r); continue; }
    try {
      // 先按入库的方式脱敏再比：钩子那条存的是脱敏后的地址（sign=…已经换成标记），拿原始地址比永远对不上
      const ev = PR_EXPORTER.scrubRequest(netEvent(r, c), await secretsOf(), c.settings.maskPasswords !== false, c.settings.maskHeaders !== false);
      const twin = c.events.find((e) => e.kind === 'request' && e.via !== 'browser' && !pairedIds.has(e.id) && sameRequest(e, ev));
      if (twin) { pairedIds.add(twin.id); continue; }
      await ingestRequest(c, ev, true);
    } catch (e) { /* 一条坏数据不影响别的 */ }
  }
  netDone = wait.concat(netDone);
  if (netDone.length && !netTimer) netTimer = setTimeout(() => { netTimer = null; netFlush(false); }, 1000);
}
// 后台刚被唤醒、录制状态还没从存储里读出来时，网络事件先按顺序排着，读完再一起处理
// （不然开始事件等着读状态，同一条请求的请求头、返回、结束事件先到，找不到记录就丢了）
const netWaiting = [];
const netDefer = (fn) => (d) => {
  if (cache && !netWaiting.length) return fn(d);
  netWaiting.push([fn, d]);
  if (netWaiting.length === 1) load().then(() => { for (const [f, x] of netWaiting.splice(0)) { try { f(x); } catch (e) { /* ignore */ } } });
};
const netOnStart = netDefer(onNetStart);
const netOnHeaders = netDefer(onNetHeaders);
const netOnResponse = netDefer(onNetResponse);
const netOnEnd = netDefer(onNetEnd);
function netListen(on) {
  const wr = chrome.webRequest;
  if (!wr || !wr.onBeforeRequest) return; // 没有这个权限（旧的安装）：只靠页面钩子
  const f = { urls: ['http://*/*', 'https://*/*'], types: NET_TYPES };
  const has = wr.onBeforeRequest.hasListener(netOnStart);
  if (on && !has) {
    wr.onBeforeRequest.addListener(netOnStart, f, ['requestBody']);
    wr.onSendHeaders.addListener(netOnHeaders, f, ['requestHeaders']);
    wr.onHeadersReceived.addListener(netOnResponse, f, ['responseHeaders']);
    wr.onCompleted.addListener(netOnEnd, f, ['responseHeaders']);
    wr.onErrorOccurred.addListener(netOnEnd, f);
  } else if (!on && has) {
    wr.onBeforeRequest.removeListener(netOnStart);
    wr.onSendHeaders.removeListener(netOnHeaders);
    wr.onHeadersReceived.removeListener(netOnResponse);
    wr.onCompleted.removeListener(netOnEnd);
    wr.onErrorOccurred.removeListener(netOnEnd);
    netSeen.clear();
    netDone = [];
    pairedIds.clear();
  }
}
// 后台被请求事件唤醒的那一刻就得同步挂上（不然唤醒它的那条收不到）；读完状态发现没在录制再摘掉，平时不占用
netListen(true);
load().then((c) => { if (!c.state.recording) netListen(false); });

// ======================= 录制控制 =======================
function keepRequest(r, s) {
  if (!r.url || !(/^https?:/i.test(r.url) || (r.via === 'websocket' && /^wss?:/i.test(r.url)))) return false;
  if (s.ignoreTracking && TRACKING.test(r.url)) return false;
  if (s.excludePattern) { try { if (new RegExp(s.excludePattern, 'i').test(r.url)) return false; } catch (e) { /* bad regex */ } }
  if (s.dataOnly && r.method === 'GET' && r.via !== 'jsonp') {
    const h = r.responseHeaders || {};
    const ct = h['content-type'] || '';
    // 静态资源：图片、字体、音视频、样式、wasm，和地址本身就是静态文件的。返回类型是 javascript 的可能是 JSONP、
    // 是 octet-stream 的多半是导出的文件：地址不像静态文件就留下；明确是下载（attachment）的都留下
    if (!/attachment/i.test(h['content-disposition'] || '') && (STATIC_CT.test(ct) || /\.(js|mjs|css|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|map|wasm)(\?|$)/i.test(r.url))) return false;
  }
  return true;
}
// 一条请求进当前录制：过滤 → 脱敏 → 入库。页面钩子后到的完整记录顶掉浏览器层面先补的那条（见“浏览器层面的兜底抓取”）
const sameRequest = (a, b) => a.method === b.method && String(a.url).split('#')[0] === String(b.url).split('#')[0] && Math.abs(a.ts - b.ts) < 5000;
// scrubbed：后台自己已经脱敏过的（浏览器层面补记的）。只认这个参数，不看事件对象上的字段（事件对象来自页面，可以伪造）
async function ingestRequest(c, ev, scrubbed) {
  if (!keepRequest(ev, c.settings)) return false;
  // 请求入库前脱敏：录到的密码按值换成占位符，名字像令牌、签名的字段换成标记（明文不进本地存储、导出和 AI 提示词）
  // 鉴权、令牌、签名一类的请求头入库时就换成 ***（设置里关掉“隐藏请求头”的除外）
  if (!scrubbed) ev = PR_EXPORTER.scrubRequest(ev, await secretsOf(), c.settings.maskPasswords !== false, c.settings.maskHeaders !== false);
  if (ev.via !== 'browser') {
    const i = c.events.findIndex((e) => e.kind === 'request' && e.via === 'browser' && sameRequest(e, ev));
    // 这条钩子记录已经和那条浏览器层面的对上了：之后同地址的另一条请求不能再和它配对
    if (i >= 0) { c.events.splice(i, 1); pairedIds.add(ev.id); }
  }
  addEvent(c, ev);
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
    clearSecrets();
    c.events = [];
    c.apiOverrides = {};
    c.aiDocs = {};
    c.state = { recording: true, tabId, id: uid(), name: '', startedAt: Date.now(), startUrl: tab.url, title: tab.title };
  } else {
    c.state = { ...c.state, recording: true, tabId, childTabs: (c.state.childTabs || []).filter((id) => id !== tabId) };
  }
  netListen(true);
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
  // 刚结束的请求：页面钩子的那条可能还在路上，等一下再对账，免得补记成没有返回内容的
  await sleep(350);
  await netFlush(true);
  netListen(false);
  clearSecrets();
  const tabId = c.state.tabId;
  for (const id of c.state.childTabs || []) chrome.tabs.sendMessage(id, { type: 'capture', on: false }).catch(() => {});
  c.state = { ...c.state, recording: false, stoppedAt: Date.now(), childTabs: [] };
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
  let reloaded = false;
  while (Date.now() < end) {
    const t = await chrome.tabs.get(tabId);
    if (t.status === 'complete') return t;
    // 被浏览器丢弃（内存节省）的标签页一直是 unloaded，不会自己加载：重新加载一次，不干等
    if ((t.discarded || t.status === 'unloaded') && !reloaded) { reloaded = true; await chrome.tabs.reload(tabId).catch(() => {}); }
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
  // 真实输入只接受这一段回放所在的框架、文档发来的、带这个令牌的请求
  const rs = realTabs.get(tabId);
  if (rs) Object.assign(rs, { token, frameId: frameId || 0, docId });
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

// ---------- 真实输入：通过浏览器调试接口发鼠标、键盘事件 ----------
// 页面收到的是浏览器真正产生的事件（isTrusted）：CSS 悬停菜单、焦点、Tab、回车提交、双击、右键、滚轮
// 都和人手操作一样，不用再为各种控件逐个模拟事件。只在回放期间连接，结束就断开；
// 连不上（页面开着别的调试器等）就回退到合成事件。原生弹窗（alert/confirm/prompt/离开页面确认）
// 也在这里按录制时的选择应答，不会把回放卡住
const realTabs = new Map(); // tabId → { runId, plan: 下一个动作预期的弹窗, dialogs: 弹出过的, mouse: 鼠标位置 }
const cdp = (tabId, method, params) => chrome.debugger.sendCommand({ tabId }, method, params || {});
// files：这次回放允许上传的本机文件（只能是参数里给的路径，页面不能借扩展读别的文件）
// 录制里所有步骤（含语义步骤的成员）录下的原生弹窗应答：按“类型 + 文字”匹配，不依赖弹出的时机
// （接口返回后隔一会儿才弹的 confirm，下一步已经开始了也认得出）
function recordedDialogs(b) {
  const out = [];
  for (const s of b.recording.steps) for (const x of [s, ...(s.members || [])]) for (const d of x.dialogs || []) out.push({ kind: d.kind, message: String(d.message || ''), result: d.result });
  return out;
}
function matchDialog(list, type, message) {
  const m = String(message || '').slice(0, 120);
  const i = list.findIndex((d) => d.kind === type && (d.message === m || (d.message && (m.startsWith(d.message.slice(0, 40)) || d.message.startsWith(m.slice(0, 40))))));
  return i < 0 ? null : list.splice(i, 1)[0];
}
async function attachReal(tabId, runId, files, dialogs) {
  if (!chrome.debugger) return false;
  try { await chrome.debugger.attach({ tabId }, '1.3'); } catch (e) { return false; }
  realTabs.set(tabId, { runId, plan: [], known: (dialogs || []).slice(), dialogs: [], mouse: null, files: new Set(files || []) });
  await cdp(tabId, 'Page.enable').catch(() => {});
  // 后台标签页也当作有焦点：focus/blur 事件、聚焦才弹出的日期框和下拉框都正常
  await cdp(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
  // 回放期间拦下系统的选文件对话框（点“上传”按钮不会弹出一个没人关的对话框），由上传步骤把参数里的文件设进去
  await cdp(tabId, 'Page.setInterceptFileChooserDialog', { enabled: true }).catch(() => {});
  await sleep(300); // 调试提示条出现会改变视口高度，等它出现后再算坐标
  return true;
}
async function detachReal(tabId) {
  const st = realTabs.get(tabId);
  realTabs.delete(tabId);
  if (st) await chrome.debugger.detach({ tabId }).catch(() => {});
  return st;
}
if (chrome.debugger) {
  chrome.debugger.onDetach.addListener((src) => { realTabs.delete(src.tabId); });
  chrome.debugger.onEvent.addListener((src, method, p) => {
    const st = realTabs.get(src.tabId);
    if (!st) return;
    if (method === 'Page.fileChooserOpened') {
      // 上传步骤正等着：把文件设进去；不是上传步骤点出来的（点按钮的那一步先于上传步骤）：记下来，上传步骤直接用
      if (st.pendingFiles) { const w = st.pendingFiles; st.pendingFiles = null; w.resolve(p); } else st.lastChooser = { backendNodeId: p.backendNodeId, ts: Date.now() };
      return;
    }
    if (method !== 'Page.javascriptDialogOpening') return;
    // 按触发它的动作录下的应答处理；没录到的：alert 点确定、离开页面放行，confirm / prompt 取消并在结果里标出
    const want = (st.plan.length && st.plan[0].kind === p.type ? st.plan.shift() : null) || matchDialog(st.known || [], p.type, p.message);
    let accept = p.type === 'alert' || p.type === 'beforeunload';
    let promptText;
    if (want) {
      accept = p.type === 'alert' || (want.result !== false && want.result !== null);
      if (p.type === 'prompt' && accept) promptText = String(want.result);
    }
    st.dialogs.push({ type: p.type, message: String(p.message || '').slice(0, 200), accepted: accept, expected: !!want });
    cdp(src.tabId, 'Page.handleJavaScriptDialog', promptText !== undefined ? { accept, promptText } : { accept }).catch(() => {});
  });
}
// [keyCode, code, 输入的字符]
const KEY_DEFS = {
  Enter: [13, 'Enter', '\r'], Tab: [9, 'Tab'], Escape: [27, 'Escape'], Backspace: [8, 'Backspace'], Delete: [46, 'Delete'],
  ArrowUp: [38, 'ArrowUp'], ArrowDown: [40, 'ArrowDown'], ArrowLeft: [37, 'ArrowLeft'], ArrowRight: [39, 'ArrowRight'],
  Home: [36, 'Home'], End: [35, 'End'], PageUp: [33, 'PageUp'], PageDown: [34, 'PageDown'], ' ': [32, 'Space', ' '],
  '-': [189, 'Minus', '-'], '=': [187, 'Equal', '='], ',': [188, 'Comma', ','], '.': [190, 'Period', '.'], '/': [191, 'Slash', '/'],
  ';': [186, 'Semicolon', ';'], "'": [222, 'Quote', "'"], '[': [219, 'BracketLeft', '['], ']': [221, 'BracketRight', ']'], '\\': [220, 'Backslash', '\\'], '`': [192, 'Backquote', '`'],
};
function keyDef(key) {
  if (KEY_DEFS[key]) return KEY_DEFS[key];
  if (/^[a-z]$/i.test(key)) return [key.toUpperCase().charCodeAt(0), 'Key' + key.toUpperCase(), key];
  if (/^[0-9]$/.test(key)) return [48 + Number(key), 'Digit' + key, key];
  if (/^F\d{1,2}$/.test(key)) return [111 + Number(key.slice(1)), key];
  return [0, '', key.length === 1 ? key : undefined];
}
async function realKey(tabId, key, mods) {
  mods = mods || {};
  const [keyCode, code, ch] = keyDef(key);
  const modifiers = (mods.alt ? 1 : 0) | (mods.ctrl ? 2 : 0) | (mods.meta ? 4 : 0) | (mods.shift ? 8 : 0);
  const text = mods.ctrl || mods.meta || mods.alt ? undefined : ch;
  const base = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers };
  started(tabId);
  await cdp(tabId, 'Input.dispatchKeyEvent', Object.assign({ type: text ? 'keyDown' : 'rawKeyDown', text, unmodifiedText: text }, base));
  await cdp(tabId, 'Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, base));
}
// 逐个字符按键（keydown / keypress / input / keyup 都有，靠 keyup 触发搜索的页面也能响应）；
// 中文等键盘上没有的字符按输入法上屏的方式插入：前后补输入法的按键事件（key = Process、keyCode 229），
// 和真人用输入法打字时页面收到的一样
const started = (tabId) => { const st = realTabs.get(tabId); if (st) st.started = true; };
async function imeCommit(tabId, text) {
  const k = { key: 'Process', code: '', windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 229 };
  await cdp(tabId, 'Input.dispatchKeyEvent', Object.assign({ type: 'rawKeyDown' }, k));
  await cdp(tabId, 'Input.insertText', { text });
  await cdp(tabId, 'Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, k));
}
async function realType(tabId, text) {
  text = String(text);
  started(tabId);
  if (text.length > 200) return imeCommit(tabId, text);
  // 连续的非 ASCII 字符一次上屏（像输入法选完词）
  for (const part of text.match(/[\x20-\x7e]|[^\x20-\x7e]+/g) || []) {
    if (/^[\x20-\x7e]$/.test(part)) await realKey(tabId, part);
    else await imeCommit(tabId, part);
  }
}
async function realMouse(tabId, a) {
  const st = realTabs.get(tabId);
  const btn = a.button === 2 ? 'right' : 'left';
  const mask = btn === 'right' ? 2 : 1;
  const ev = (type, x, y, extra) => cdp(tabId, 'Input.dispatchMouseEvent', Object.assign({ type, x, y }, extra));
  await ev('mouseMoved', a.x, a.y);
  if (st) st.mouse = { x: a.x, y: a.y };
  if (a.type === 'move') return;
  started(tabId);
  if (a.type === 'wheel') return ev('mouseWheel', a.x, a.y, { deltaX: a.dx || 0, deltaY: a.dy || 0 });
  if (a.type === 'drag') {
    await ev('mousePressed', a.x, a.y, { button: 'left', buttons: 1, clickCount: 1 });
    const n = 8;
    for (let k = 1; k <= n; k++) {
      await ev('mouseMoved', a.x + (a.tx - a.x) * k / n, a.y + (a.ty - a.y) * k / n, { button: 'left', buttons: 1 });
      await sleep(16);
    }
    await ev('mouseReleased', a.tx, a.ty, { button: 'left', buttons: 0, clickCount: 1 });
    if (st) st.mouse = { x: a.tx, y: a.ty };
    return;
  }
  const count = a.type === 'dblclick' ? 2 : 1;
  for (let c = 1; c <= count; c++) {
    await ev('mousePressed', a.x, a.y, { button: btn, buttons: mask, clickCount: c });
    await ev('mouseReleased', a.x, a.y, { button: btn, buttons: 0, clickCount: c });
  }
}
// 上传：页面给文件框打了临时标记，这里在各个框架里按标记找到它，把本机文件设进去
async function realFiles(tabId, mark, files) {
  const tree = await cdp(tabId, 'Page.getFrameTree');
  const ids = [];
  (function walk(n) { ids.push(n.frame.id); (n.childFrames || []).forEach(walk); })(tree.frameTree);
  for (const frameId of ids) {
    try {
      const w = await cdp(tabId, 'Page.createIsolatedWorld', { frameId, worldName: 'page-recorder-upload' });
      const r = await cdp(tabId, 'Runtime.evaluate', { expression: `document.querySelector('[data-pr-upload="${mark}"]')`, contextId: w.executionContextId });
      if (r.result && r.result.objectId) {
        started(tabId);
        await cdp(tabId, 'DOM.setFileInputFiles', { files, objectId: r.result.objectId });
        return true;
      }
    } catch (e) { /* 跨进程的 iframe 在这里拿不到，换下一个 */ }
  }
  return false;
}
async function realInputAction(tabId, a) {
  const st = realTabs.get(tabId);
  st.plan = Array.isArray(a.dialogs) ? a.dialogs.slice() : []; // 这个动作可能弹出的原生弹窗，动作前装好
  const num = (v) => typeof v === 'number' && isFinite(v);
  const allowed = () => {
    if (!Array.isArray(a.files) || !a.files.length) throw new Error('上传参数不对');
    const bad = a.files.map(String).filter((f) => !st.files.has(f));
    if (bad.length) throw new Error('只能上传回放参数里给的文件：' + bad.join(', '));
    return a.files.map(String);
  };
  if (a.type === 'key') await realKey(tabId, String(a.key), a.mods);
  else if (a.type === 'text') await realType(tabId, a.text);
  else if (a.type === 'files') {
    if (!/^[a-z0-9]+$/i.test(String(a.mark))) throw new Error('上传参数不对');
    if (!(await realFiles(tabId, a.mark, allowed()))) throw new Error('找不到上传控件（跨域 iframe 里的上传暂不支持）');
  } else if (a.type === 'chooser' && num(a.x) && num(a.y)) {
    // 点上传按钮 → 浏览器要弹选文件对话框（已被拦下）→ 把文件设到对话框对应的文件框上
    const files = allowed();
    let node = st.lastChooser && Date.now() - st.lastChooser.ts < 60000 ? st.lastChooser.backendNodeId : null;
    st.lastChooser = null;
    if (!node) {
      const opened = new Promise((resolve) => { st.pendingFiles = { resolve }; });
      await realMouse(tabId, { type: 'click', x: a.x, y: a.y });
      const p = await Promise.race([opened, sleep(5000).then(() => null)]);
      st.pendingFiles = null;
      if (!p) throw Object.assign(new Error('点了上传按钮，但页面没有打开选文件对话框'), { unknown: false });
      node = p.backendNodeId;
    }
    started(tabId);
    await cdp(tabId, 'DOM.setFileInputFiles', { files, backendNodeId: node });
  } else if (a.type === 'dropFiles' && num(a.x) && num(a.y)) {
    // 从桌面拖文件进上传区
    const data = { items: [], files: allowed(), dragOperationsMask: 1 };
    started(tabId);
    for (const type of ['dragEnter', 'dragOver', 'drop']) await cdp(tabId, 'Input.dispatchDragEvent', { type, x: a.x, y: a.y, data });
  } else if (num(a.x) && num(a.y) && (a.type !== 'drag' || (num(a.tx) && num(a.ty)))) await realMouse(tabId, a);
  else throw new Error('真实输入参数不对');
  return st.dialogs.splice(0);
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
    chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: () => ({ url: location.href, ready: document.readyState, shown: innerWidth > 0 && innerHeight > 0 }) }).catch(() => []),
    sleep(3000).then(() => []),
  ]);
  return (res || []).filter((r) => r && r.result && typeof r.result.url === 'string').map((r) => ({ frameId: r.frameId, url: r.result.url, ready: r.result.ready, shown: r.result.shown !== false }));
}
async function findFrame(tabId, url, timeout) {
  const end = Date.now() + timeout;
  for (;;) {
    const frames = await listFrames(tabId);
    let best = null;
    for (const f of frames) {
      if (f.frameId === 0) continue; // 录的是 iframe 里的步骤，不能落到顶层页面
      // 同一个地址的 iframe 有好几个（后台的多标签页布局，旧标签页藏着）：优先显示着的
      const sc = frameScore(url, f.url) + (f.shown ? 0.5 : 0);
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
  // 直接调用不开启请求改写、也不记录页面请求：这个页面之后用户自己的操作不能被改成这次的参数、不能被留在内存里
  try {
    await window.__pageRecorderRuntime(rec, params, apiParams, Object.assign({}, config, { autoRun: false, verbose: false, rewriteRequests: false, netLog: false }));
    if (window.__PR_NET__) { window.__PR_NET__.rewrite = null; window.__PR_NET__.active = false; }
  } catch (e) {
    return { ok: false, rejected: true, notSent: true, error: '页面里准备调用时出错：' + String((e && e.message) || e) };
  }
  try {
    return await window.__PR__.api.call(api, args || {});
  } catch (e) {
    // call() 只在发请求之前抛错（找不到接口、参数换算不了）；发出之后的错误它自己按“结果未知”返回
    return { ok: false, rejected: true, notSent: true, error: String((e && e.message) || e) };
  }
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
// 扩展为回放、接口调用打开的标签页留着不关，之后同一个站点的回放和调用都用它，省掉打开页面的时间。
// 记在本地存储里（扩展重新加载后也还认得；浏览器重启后标签页编号会变，按站点核对，对不上就不用）
// 返回的标签页可能已被别的任务占用：调用方拿到后要同步再检查一次再占用
function siteOf(u) {
  try {
    const h = new URL(u).hostname;
    if (/^[\d.]+$/.test(h) || !h.includes('.')) return h;
    const p = h.split('.');
    const n = p.length >= 3 && /^(com|net|org|gov|edu|co|ac)$/.test(p[p.length - 2]) && p[p.length - 1].length === 2 ? 3 : 2;
    return p.slice(-n).join('.');
  } catch (e) { return ''; }
}
async function ourTabs() {
  try { return (await chrome.storage.local.get('ourTabs')).ourTabs || {}; } catch (e) { return {}; }
}
// key：run:<录制> 或 call:<源>；url：要去的页面。先找这个 key 记下的，再找扩展在同一站点开过的其他标签页
async function reusedTab(key, url) {
  const all = await ourTabs();
  const site = siteOf(url);
  const list = [all[key], ...Object.entries(all).filter(([k, x]) => k !== key && x && x.site === site).map(([, x]) => x)].filter(Boolean);
  let dirty = false;
  for (const x of list) {
    let t = null;
    try { t = await chrome.tabs.get(x.tabId); } catch (e) { /* 已关闭 */ }
    if (!t) { for (const [k, v] of Object.entries(all)) if (v && v.tabId === x.tabId) { delete all[k]; dirty = true; } continue; }
    if (siteOf(t.url || t.pendingUrl || '') !== site || runningTabs.has(t.id)) continue;
    if (dirty) await chrome.storage.local.set({ ourTabs: all });
    if (t.discarded || t.status === 'unloaded') await chrome.tabs.reload(t.id).catch(() => {});
    return t;
  }
  if (dirty) await chrome.storage.local.set({ ourTabs: all });
  return null;
}
async function rememberTab(key, tabId, url) {
  // 留着复用的标签页不让浏览器在后台丢弃（丢弃后每次调用都要重新加载整页）
  chrome.tabs.update(tabId, { autoDiscardable: false }).catch(() => {});
  const all = await ourTabs();
  all[key] = { tabId, site: siteOf(url), ts: Date.now() };
  const keys = Object.keys(all).sort((a, b) => all[b].ts - all[a].ts);
  for (const k of keys.slice(100)) delete all[k];
  try { await chrome.storage.local.set({ ourTabs: all }); } catch (e) { /* ignore */ }
}
// 接口调用占用中的标签页（可以同时有多个调用）；回放要独占，等调用结束再用
const callingTabs = new Map();
const callBegin = (id) => callingTabs.set(id, (callingTabs.get(id) || 0) + 1);
const callEnd = (id) => { const n = (callingTabs.get(id) || 1) - 1; if (n > 0) callingTabs.set(id, n); else callingTabs.delete(id); };
// 直接请求模式：不操作页面，把输入参数填进关联了它的接口（字段值是 {{参数}} 的那些），在开着的页面里直接调用。
// 页面复用规则同 call_api：第一次在后台打开并留着，之后直接在里面发请求
const tplNames = (v) => {
  const out = new Set();
  JSON.stringify(v === undefined ? null : v).replace(/\{\{\s*([^}|]+?)\s*(\|[^}]*)?\}\}/g, (m, n) => { out.add(n.trim()); return m; });
  return [...out];
};
function linkedApis(b) {
  return b.recording.apis.filter((a) => !a.ignore && tplNames(b.apiParams[a.name] || {}).length);
}
// 这次实际用的参数里，和最初录到的值不一样的（弹窗里改过的默认值也算改了；下拉框填选项文字和录制的选项值是同一个就不算改）
function changedParams(b, given) {
  const out = [];
  const eff = Object.assign({}, b.params, given || {});
  const rec = b.paramRecorded || b.params;
  for (const [k, v] of Object.entries(eff)) {
    let x = v == null ? '' : String(v);
    const s = b.recording.steps.find((st) => st.type === 'select' && st.value === `{{${k}}}` && Array.isArray(st.options));
    if (s && !Array.isArray(v)) { const o = s.options.find((op) => op[0] === x) || s.options.find((op) => String(op[1]).trim() === x.trim()); if (o) x = String(o[0]); }
    // 单选：填值和填文字是同一个选项就不算改（基准是文字）；复选框：1/0 和 true/false 一样
    const r = b.recording.steps.find((st) => st.type === 'check' && st.value === `{{${k}}}` && Array.isArray(st.options));
    if (r) { const o = r.options.find((op) => String(op[1]).trim() === x.trim()) || r.options.find((op) => op[0] === x); if (o) x = String(o[1]); }
    if (b.recording.steps.some((st) => st.type === 'check' && st.checked === `{{${k}}}`)) x = { 1: 'true', 0: 'false' }[x] || x;
    if (x !== String(rec[k] == null ? '' : rec[k])) out.push(k);
  }
  return out;
}
// 页面回放校准过的参数：{ 录制 id: { savedAt, params: { 参数: 'ok' | 'mismatch' } } }。录制改过（savedAt 变了）就作废
async function verifiedOf(item) {
  try {
    const v = ((await chrome.storage.local.get('directVerified')).directVerified || {})[item.id];
    return v && v.savedAt === item.savedAt ? v.params || {} : {};
  } catch (e) { return {}; }
}
// 直接请求被服务端明确拒绝（签名、登录态要页面现算，比如淘宝 mtop 的 sign）：一天内这条录制不再先试直接请求
async function markDirectRejected(item, reason) {
  try {
    const all = (await chrome.storage.local.get('directVerified')).directVerified || {};
    const cur = all[item.id] && all[item.id].savedAt === item.savedAt ? all[item.id] : { savedAt: item.savedAt, params: {} };
    all[item.id] = Object.assign(cur, { rejectedAt: Date.now(), rejectedReason: String(reason || '').slice(0, 200) });
    await chrome.storage.local.set({ directVerified: all });
  } catch (e) { /* ignore */ }
}
async function directRejectedOf(item) {
  try {
    const v = ((await chrome.storage.local.get('directVerified')).directVerified || {})[item.id];
    return v && v.savedAt === item.savedAt && v.rejectedAt && Date.now() - v.rejectedAt < 24 * 3600 * 1000 ? v.rejectedReason || '直接请求最近被服务端拒绝' : null;
  } catch (e) { return null; }
}
async function saveVerified(item, verdicts) {
  const got = Object.entries(verdicts || {}).filter(([, r]) => r === 'ok' || r === 'mismatch');
  if (!got.length) return;
  try {
    const all = (await chrome.storage.local.get('directVerified')).directVerified || {};
    const cur = all[item.id] && all[item.id].savedAt === item.savedAt ? all[item.id].params || {} : {};
    for (const [k, r] of got) cur[k] = cur[k] === 'mismatch' ? 'mismatch' : r;
    all[item.id] = { savedAt: item.savedAt, params: cur };
    const keys = Object.keys(all);
    for (const k of keys.slice(0, Math.max(0, keys.length - 200))) delete all[k];
    await chrome.storage.local.set({ directVerified: all });
  } catch (e) { /* ignore */ }
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
        params: opts.params, apiParams: opts.apiParams, tabId: opts.tabId, active: opts.active, deadline,
        reuseTab: opts.newTab ? false : undefined, keepTab: opts.keepTab,
      });
      out.responses.push({ api: a.name, fn: a.fn, status: r.status, ok: r.ok, url: r.url, data: r.data, error: r.error });
      out.log.push({ api: a.name, ok: !!r.ok, status: r.status, error: r.error, notSent: r.notSent || undefined });
      if (r.tab) out.tab = r.tab;
      if (r.ok) { out.succeeded = (out.succeeded || 0) + 1; continue; }
      out.ok = false;
      out.error = `${a.name}：${r.error || 'HTTP ' + r.status}`;
      // 服务端明确拒绝（业务码不对、4xx）或者根本没发出去才算“没执行”；超时、5xx、网络错误结果未知
      out.rejected = !!r.rejected || !!r.notSent || (r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429);
      if (r.unknown) out.unknown = true;
      break; // 一个失败就停，后面的不再发
    } catch (e) {
      out.ok = false;
      out.error = `${a.name}：${(e && e.message) || e}`;
      if (e && e.unknown) out.unknown = true;
      out.log.push({ api: a.name, ok: false, error: String((e && e.message) || e) });
      break;
    }
  }
  out.ms = Date.now() - t0;
  return out;
}
// mode：'api' 直接请求；'ui' 回放页面操作；默认 'auto'：
//   改了的参数都关联到了接口字段、并且在页面回放里校准过（页面自己发的值和模板算的一致）→ 直接请求；
//   否则回放页面操作（同时校准，下次就能直接请求）。没改参数时有能重发的接口就直接请求
async function runRecording(item, opts) {
  opts = opts || {};
  const b = buildItem(item).bundle;
  const mode = opts.mode || 'auto';
  const given = Object.assign({}, opts.params || {});
  // 多选参数要数组；传来的是字符串（脚本库卡片、只能传字符串的客户端）就按 JSON 数组解析，不按逗号拆（选项文字里可能有逗号）
  for (const [k, v] of Object.entries(given)) {
    if (!Array.isArray(b.params[k]) || Array.isArray(v)) continue;
    let a = null;
    try { a = JSON.parse(String(v)); } catch (e) { /* 下面报错 */ }
    if (!Array.isArray(a)) throw new Error(`参数 ${k} 是多选，要传选项组成的数组，比如 ${JSON.stringify(b.params[k])}`);
    given[k] = a.map(String);
  }
  opts = Object.assign({}, opts, { params: given });
  const unknownNames = Object.keys(given).filter((k) => !(k in b.params));
  if (unknownNames.length) throw new Error(`这条录制没有这些输入参数：${unknownNames.join('、')}。可用的参数：${Object.keys(b.params).join('、') || '（无）'}`);
  const changed = changedParams(b, given);
  const linked = linkedApis(b);
  const callable = linked.filter((a) => a.replayable !== false && !a.optionalOnly);
  const used = new Set(callable.flatMap((a) => tplNames(b.apiParams[a.name])));
  // 页面回放时：这次改过、关联了任何接口字段的参数，这些字段都不改写（让页面自己发，误关联的字段不会被改错），
  // 同时拿来校准；判定能不能直接请求只看直接请求会调的每个接口里引用它的每个字段（required）
  const linkedAny = new Set(linked.flatMap((a) => tplNames(b.apiParams[a.name])));
  let calibrateNames = changed.filter((k) => linkedAny.has(k));
  const required = {};
  for (const a of callable) {
    for (const sec of ['path', 'query', 'body']) {
      for (const [k, v] of Object.entries((b.apiParams[a.name] || {})[sec] || {})) for (const n of tplNames(v)) (required[n] = required[n] || []).push(`${a.name} ${sec}.${k}`);
    }
  }
  let route = null;
  if (mode !== 'ui') {
    const reasons = [];
    if (!callable.length) reasons.push('没有关联输入参数、能直接重发的接口');
    const unlinked = changed.filter((k) => !used.has(k));
    if (unlinked.length) reasons.push(`参数 ${unlinked.join('、')} 没有关联到接口字段（改了直接请求也不会生效）`);
    const raw = linked.filter((a) => a.replayable === false && !a.optionalOnly);
    if (raw.length) reasons.push(`接口 ${raw.map((a) => a.name).join('、')} 的请求体不能直接重发`);
    if (b.recording.steps.some((s) => s.type === 'extract')) reasons.push('录制里有提取页面内容的步骤，只有页面回放拿得到');
    // 选择参数靠录到的选项表把文字换成接口要的编码：表里没有这个值就换不出来
    const eff = Object.assign({}, b.params, opts.params || {});
    const squash = (x) => String(x == null ? '' : x).trim().replace(/\s+/g, ' ');
    const noOpt = changed.filter((k) => {
      const tbl = (b.recording.paramOptions || {})[k];
      const v = squash(eff[k]);
      if (!tbl || !tbl.length || v === '') return false;
      return callable.some((a) => JSON.stringify(b.apiParams[a.name] || {}).includes(`{{${k}|opt`)) && !tbl.some((o) => String(o[0]) === v || squash(o[1]) === v);
    });
    if (noOpt.length) reasons.push(`参数 ${noOpt.join('、')} 的值不在录到的选项里，换不出接口要的编码`);
    const ver = await verifiedOf(item);
    const rejected = mode === 'auto' ? await directRejectedOf(item) : null;
    if (rejected) reasons.push(`直接请求最近被服务端拒绝过（${rejected}），一天内先用页面回放`);
    const mism = changed.filter((k) => ver[k] === 'mismatch');
    const unverified = changed.filter((k) => used.has(k) && ver[k] !== 'ok');
    if (mode === 'api') {
      if (reasons.length || mism.length) {
        return { ok: false, mode: 'api', recording: b.name, rejected: true, notSent: true, error: '不能直接请求：' + reasons.concat(mism.length ? [`参数 ${mism.join('、')} 上次页面回放校准时，页面发的值和直接请求算出来的不一样`] : []).join('；') };
      }
      const r = await runApiMode(item, b, callable, opts);
      if (unverified.length) r.warnings = [`参数 ${unverified.join('、')} 还没有在页面回放里校准过，直接请求的字段格式可能和页面发的不一样`];
      return r;
    }
    if (!reasons.length && !mism.length && !unverified.length) {
      const r = await runApiMode(item, b, callable, opts);
      // 直接请求被服务端明确拒绝（缺签名、登录态要页面现算等）或根本没发出去，而且这次没有任何接口已经成功：
      // 改成回放页面操作，让页面自己发请求、只改参数。已经有接口成功、或者失败原因不确定（超时、5xx）时不回退，
      // 免得把已经生效的提交再做一遍
      if (r.ok || !b.recording.steps.length || !r.rejected || r.succeeded) return r;
      await markDirectRejected(item, r.error);
      const ui = await runRecording(item, Object.assign({}, opts, { mode: 'ui', fallbackFrom: 'api' }));
      ui.fallback = { from: 'api', reason: r.error || '直接请求失败' };
      return ui;
    }
    route = { mode: 'ui', reason: reasons.concat(mism.length ? [`参数 ${mism.join('、')} 校准时对不上`] : [], unverified.length ? [`参数 ${unverified.join('、')} 第一次改，先用页面回放校准`] : []).join('；') };
  }
  const ui = await runUi(item, b, opts, calibrateNames, required);
  if (route) ui.route = route;
  if (ui.calibration) await saveVerified(item, ui.calibration.params);
  return ui;
}
async function runUi(item, b, opts, calibrateNames, required) {
  const params = Object.assign({}, b.params, opts.params || {});
  const apiParams = mergeApiParams(b.apiParams, opts.apiParams);
  const config = Object.assign({}, b.config, { highlight: !!opts.active, verbose: false }, opts.config || {});
  const deadline = Date.now() + (opts.timeout || 180000);
  // 同一个标签页同时只跑一个回放：指定了标签页时先占上（检查和占用之间不能有 await）
  if (opts.tabId) {
    if (runningTabs.has(opts.tabId) || callingTabs.has(opts.tabId)) throw new Error('这个标签页正在回放或调用接口，请等它结束再试');
    runningTabs.add(opts.tabId);
  }
  let picked;
  // 默认复用这条录制上次用的回放标签页（还开着的话），跑完留着；newTab: true 时用全新的标签页、跑完关掉
  const reuse = !opts.tabId && !opts.newTab;
  const keep = !!opts.keepTab || reuse;
  let locked = opts.tabId || null;
  const capture = opts.capture !== false; // 回放期间抓下这个标签页里所有框架的接口返回，放在结果的 network 里
  try {
    let old = reuse ? await reusedTab('run:' + item.id, b.recording.startUrl) : null;
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
      await rememberTab('run:' + item.id, old.id, b.recording.startUrl);
    } else {
      // 先开空白页、打开抓包，再跳到起始页面：页面一加载发的请求也能抓到
      picked = await pickTab(capture && !opts.tabId ? 'about:blank' : b.recording.startUrl, { ...opts, reuseTab: false });
      runningTabs.add(picked.tabId); // 新开的标签页立刻占上，免得导航期间被接口调用选走
      locked = picked.tabId;
      if (capture) startCapture(picked.tabId);
      if (capture && picked.created) await chrome.tabs.update(picked.tabId, { url: b.recording.startUrl });
      if (reuse) await rememberTab('run:' + item.id, picked.tabId, b.recording.startUrl);
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
  // 真实输入：连上调试接口后，页面里的点击、输入、按键都由浏览器真实产生；连不上就用合成事件
  // 上传参数里给的文件路径（| 分隔）是这次回放唯一允许设进文件框的文件
  const uploadFiles = b.recording.steps.filter((s) => s.type === 'upload' && s.param).flatMap((s) => String(params[s.param] || '').split('|').map((x) => x.trim()).filter(Boolean));
  const wantReal = (await load()).settings.realInput !== false && opts.realInput !== false;
  let real = false;
  // 按所在框架把步骤切成几段：顶层页面的连续步骤一段，同一个 iframe 里的连续步骤一段，依次在对应框架里执行
  const segs = [];
  b.recording.steps.forEach((s, i) => {
    const key = s.frame ? s.frame.url : '';
    const last = segs[segs.length - 1];
    if (last && last.key === key) { last.to = i + 1; last.allOptional = last.allOptional && !!s.optional; }
    else segs.push({ key, frame: s.frame || null, from: i, to: i + 1, allOptional: !!s.optional });
  });
  const total = { ok: true, total: b.recording.steps.length, completed: 0, extracted: {}, responses: [], log: [], input: 'synthetic', tab: { id: tabId, reused: !created } };
  let skip = false; // 可选步骤组的跳过状态，跨段传递
  if (calibrateNames && calibrateNames.length) config.calibrate = calibrateNames;
  const verdicts = {}; // 各段校准结果汇总：有一段对不上就是对不上，有一段没看清就不算校准过
  const details = [];
  try {
    // 连调试接口放在 try 里：之后任何异常都会在 finally 里断开
    real = wantReal ? await attachReal(tabId, runId, uploadFiles, recordedDialogs(b)) : false;
    config.realInput = real;
    if (real) total.input = 'real';
    for (let si = 0; si < segs.length; si++) {
      const seg = segs[si];
      if (si > 0) await sleep(config.stepDelay || 400);
      const key = runId + '.' + si; // 断点按“这次回放的第几段”归档，避免上一段迟到的断点混进来
      activeRuns.add(key);
      let r;
      try {
        r = await runSegment(tabId, key, b, params, apiParams, config, seg, si === 0 && created ? b.recording.startUrl : null, skip, deadline);
      } catch (e) {
        // 超时、页面一直没准备好：把这一段已经做完的步骤（最新断点）带回去，AI 才知道提交类的步骤做没做
        const prog = replayProgress.get(key);
        total.ok = false;
        total.unknown = true;
        total.error = `${(e && e.message) || e}${prog ? `（已经做完第 ${prog.i} 步，之后的结果未知）` : ''}`;
        if (prog) {
          Object.assign(total.extracted, prog.extracted || {});
          total.responses.push(...(prog.responses || []));
          total.log.push(...(prog.log || []));
          total.completed = prog.i;
        }
        break;
      }
      skip = !!r.skip;
      Object.assign(total.extracted, r.extracted || {});
      total.responses.push(...(r.responses || []));
      total.log.push(...(r.log || []));
      if (r.dialogs) total.dialogs = (total.dialogs || []).concat(r.dialogs);
      if (r.warnings) total.warnings = (total.warnings || []).concat(r.warnings);
      if (r.calibration) details.push(...(r.calibration.details || []));
      total.completed = r.completed;
      if (!r.ok) {
        total.ok = false;
        total.error = r.error;
        break;
      }
    }
    if (calibrateNames && calibrateNames.length) {
      // 每个参数：直接请求会调的接口里引用它的每个字段都在页面回放里看到、且一致才算 ok；有一处不一致就是 mismatch。
      // 页面回放全部成功才拿来校准（失败的回放里页面发的值不可信）
      for (const n of calibrateNames) {
        const need = (required && required[n]) || [];
        const needApis = new Set(need.map((f) => f.slice(0, f.lastIndexOf(' '))));
        // 只看直接请求会调的接口（可选接口、不可重放接口上的对不上不影响直接请求）；
        // extra = 这些接口里没关联参数、页面却也改了的字段（直接请求改不了它）
        const seen = details.filter((d) => (d.params || []).includes(n) && (need.includes(`${d.api} ${d.field}`) || (d.extra && needApis.has(d.api))));
        if (seen.some((d) => d.result === 'mismatch')) verdicts[n] = 'mismatch';
        else if (need.length && need.every((f) => seen.some((d) => `${d.api} ${d.field}` === f && d.result === 'ok'))) verdicts[n] = 'ok';
        else verdicts[n] = 'unknown';
      }
      total.calibration = { params: total.ok ? verdicts : Object.fromEntries(calibrateNames.map((n) => [n, 'unknown'])), details: details.slice(0, 40) };
    }
    const tab = await chrome.tabs.get(tabId);
    total.finalUrl = tab.url;
    total.recording = b.name;
    const cap = captures.get(tabId);
    if (cap) {
      await drainCapture(cap);
      total.network = cap.list.slice().sort((x, y) => x.ts - y.ts);
    }
    return total;
  } finally {
    if (realTabs.has(tabId) && realTabs.get(tabId).runId === runId) {
      const st = await detachReal(tabId);
      if (st && st.dialogs.length) total.dialogs = (total.dialogs || []).concat(st.dialogs);
    }
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
// 最后一步发出的请求可能还没返回：等到 1 秒内没有新请求进来（最多 5 秒）再收
async function drainCapture(cap) {
  const end = Date.now() + 5000;
  let n = -1;
  let quietSince = Date.now();
  while (Date.now() < end) {
    if (cap.list.length !== n) { n = cap.list.length; quietSince = Date.now(); }
    if (Date.now() - quietSince >= 1000) break;
    await sleep(200);
  }
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
  const deadline = opts.deadline || Date.now() + (opts.timeout || 90000);
  // 默认复用：先找上次为这个页面源开的接口调用标签页，再找其他开着的页面（包括 iframe）；都没有才新开一个并留着。
  // reuseTab: false 时用全新标签页，默认用完关掉（keepTab: true 保留）
  const reuse = !opts.tabId && opts.reuseTab !== false;
  const keep = opts.keepTab !== undefined ? !!opts.keepTab : reuse;
  let target = null;
  if (opts.tabId) {
    const f = (await listFrames(opts.tabId)).find((x) => x.url.startsWith(ctx + '/'));
    target = { tabId: opts.tabId, frameId: f ? f.frameId : 0 };
  } else if (reuse) {
    // 扩展开过的同站点标签页：页面（或其中某个 iframe）就在这个源上直接用；跳到同站别的子域名了就把它带回来
    const kept = await reusedTab('call:' + ctx, ctxUrl);
    // 先同步检查并占用（回放会等占用结束），再去看框架、导航
    if (kept && !callingTabs.has(kept.id) && !runningTabs.has(kept.id)) {
      callBegin(kept.id);
      let ok = false;
      try {
        if (kept.url && kept.url.startsWith(ctx + '/')) { target = { tabId: kept.id, frameId: 0, how: 'kept' }; ok = true; } else {
          const f = (await listFrames(kept.id)).find((x) => x.url.startsWith(ctx + '/'));
          if (f) { target = { tabId: kept.id, frameId: f.frameId, how: 'kept-frame' }; ok = true; } else {
            await chrome.tabs.update(kept.id, { url: ctxUrl });
            target = { tabId: kept.id, frameId: 0, how: 'kept-navigated' };
            ok = true;
          }
        }
      } finally { if (!ok) callEnd(kept.id); }
      if (target) target.claimed = true;
    }
    if (!target) { target = await findOriginFrame(ctx, siteOrigin); if (target) target.how = 'open-page'; }
  }
  // 选的时候还空着，可能已经被回放占了：同步复查后立刻占用（中间不能有 await）
  if (target && !target.claimed && runningTabs.has(target.tabId)) {
    if (opts.tabId) throw new Error('这个标签页正在回放，请等它结束再调用接口');
    target = null;
  }
  let created = false;
  if (target) { if (!target.claimed) callBegin(target.tabId); } else {
    const t = await pickTab(ctxUrl, { ...opts, tabId: undefined, reuseTab: false });
    created = t.created;
    target = { tabId: t.tabId, frameId: 0 };
    callBegin(t.tabId);
    target.how = 'new';
    if (created && reuse && keep) await rememberTab('call:' + ctx, t.tabId, ctxUrl);
  }
  const tabId = target.tabId;
  const left = () => deadline - Date.now();
  try {
    await waitTabComplete(tabId, Math.max(1000, Math.min(30000, left())));
    if (left() <= 0) throw new Error('超时：页面还没准备好');
    await injectRuntime(tabId, target.frameId);
    if (left() <= 0) throw new Error('超时：页面还没准备好');
    const config = Object.assign({}, b.config, { callTimeout: left() });
    // 页面在调用期间整页跳转时 executeScript 不会返回，所以也按截止时间兜底
    const [r] = await Promise.race([
      chrome.scripting.executeScript({
        target: { tabId, frameIds: [target.frameId] }, world: 'MAIN', func: pageCall,
        args: [b.recording, Object.assign({}, b.params, opts.params || {}), mergeApiParams(b.apiParams, opts.apiParams), config, a.name, args || {}],
      }),
      sleep(left() + 3000).then(() => { throw Object.assign(new Error('超时：接口没有在规定时间内返回（请求可能已经发出）'), { unknown: true }); }),
    ]);
    if (target.how === 'kept' || target.how === 'kept-frame' || target.how === 'kept-navigated') await rememberTab('call:' + ctx, tabId, ctxUrl);
    const head = { api: a.name, fn: a.fn, tab: { id: tabId, how: target.how } };
    if (!r || !r.result || typeof r.result !== 'object') return Object.assign(head, { ok: false, unknown: true, error: '页面里的调用没有返回结果（页面可能跳转或刷新了），请求可能已经发出' });
    return Object.assign(head, r.result);
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
    paramInfo: A.paramInfo,
    tools: out.tools,
    hasDocs: !!(item.aiDocs && item.aiDocs.apis),
  };
}
// ---------- 录制包：导出给别的机器、同事、备份；导入成脚本库里的新条目 ----------
// 不带设置（里面有 AI 的 API Key），请求按名字再脱敏一遍（旧版本录的请求入库时没脱敏）
function packageOf(item) {
  const s = item.settings || DEFAULT_SETTINGS;
  const events = (item.events || []).map((e) => (e.kind === 'request' ? PR_EXPORTER.exportRequest(e, s) : e));
  const state = Object.assign({}, item.state || {});
  delete state.tabId;
  return {
    format: 'page-recorder-package',
    version: 1,
    exportedAt: new Date().toISOString(),
    name: item.name || defaultName({ state, aiDocs: item.aiDocs }),
    item: { name: item.name, description: item.description || '', state, events, apiOverrides: PR_EXPORTER.maskDeep(item.apiOverrides || {}, s.maskPasswords !== false), aiDocs: item.aiDocs || {} },
  };
}
async function importPackage(c, pkg) {
  if (typeof pkg === 'string') { try { pkg = JSON.parse(pkg); } catch (e) { throw new Error('录制包不是有效的 JSON'); } }
  if (!pkg || pkg.format !== 'page-recorder-package' || !pkg.item || !Array.isArray(pkg.item.events)) throw new Error('不是 Page Recorder 导出的录制包');
  if (pkg.version > 1) throw new Error(`录制包版本 ${pkg.version} 比扩展新，请先升级扩展`);
  const src = pkg.item;
  const events = src.events.filter((e) => e && typeof e === 'object' && (e.kind === 'step' || e.kind === 'request') && typeof e.ts === 'number');
  if (!events.length) throw new Error('录制包里没有步骤');
  const id = uid();
  const state = Object.assign({}, src.state || {}, { id, recording: false });
  delete state.tabId;
  const name = String(src.name || pkg.name || '导入的录制').slice(0, 100);
  if (!state.name) state.name = name;
  const item = { id, name, description: String(src.description || ''), savedAt: Date.now(), state, events, apiOverrides: src.apiOverrides || {}, aiDocs: src.aiDocs || {}, settings: c.settings };
  const cnt = counts({ events });
  let params = {};
  let direct = false;
  try {
    const A = PR_EXPORTER.analyze(events, c.settings, state, item.apiOverrides, item.aiDocs);
    params = A.params;
    direct = A.apis.some((a) => !a.ignore && /\{\{[^}]+\}\}/.test(JSON.stringify(a.editParams || {})));
  } catch (e) { /* ignore */ }
  const entry = { id, name, description: item.description, startUrl: state.startUrl, savedAt: item.savedAt, steps: cnt.steps, requests: cnt.requests, hasDocs: !!(item.aiDocs && item.aiDocs.title), params, direct };
  c.libIndex = [entry, ...c.libIndex];
  await chrome.storage.local.set({ ['lib:' + id]: item, libIndex: c.libIndex });
  bridgeNotify('libraryChanged');
  return { ok: true, id, name };
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
        paramInfo: A.paramInfo,
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
    case 'exportPackage': return packageOf(await getLibItem(c, p.recording));
    case 'importPackage': return importPackage(c, p.pkg);
    default: throw new Error('未知方法 ' + method);
  }
}
function bridgeConnect() {
  if (!cache || !cache.settings.bridgeEnabled || !cache.settings.bridgeUrl) return;
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
  try { ws = new WebSocket(cache.settings.bridgeUrl); } catch (e) { ws = null; return; }
  const sock = ws;
  sock.onopen = async () => {
    // 实例 ID：每个 Chrome 用户资料里的扩展各有一个，桥接据此区分多个资料、替换同一资料的旧连接
    let instanceId = (await chrome.storage.local.get('instanceId')).instanceId;
    if (!instanceId) { instanceId = uid(); await chrome.storage.local.set({ instanceId }); }
    // profile：多个浏览器资料都装了扩展时给桥接看的名字（设置里可以填，没填就空着，桥接按 instanceId 区分）
    const profile = String((cache && cache.settings.profileLabel) || '').slice(0, 40);
    if (sock.readyState === 1) sock.send(JSON.stringify({ type: 'hello', version: chrome.runtime.getManifest().version, instanceId, profile }));
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
      const capture = !!(sender.tab && (captures.has(sender.tab.id) || (c.state.recording && (c.state.childTabs || []).includes(sender.tab.id))));
      if (rec && sender.frameId === 0) { // iframe 加载不算一步，只记顶层页面的跳转
        const last = lastStep(c);
        const dup = last && last.url === msg.url && (last.type === 'navigate' || Date.now() - last.ts < 1500) && Date.now() - last.ts < 3000;
        if (!dup) addEvent(c, { kind: 'step', type: 'navigate', id: uid(), ts: Date.now(), url: msg.url, title: msg.title });
      }
      return { recording: rec, capture, settings: c.settings, counts: counts(c) };
    }
    case 'event': {
      if (!c.state.recording || !sender.tab || sender.tab.id !== c.state.tabId) {
        // 录制中的标签页打开的新标签页（详情页、导出页）：只收请求，不记操作
        if (c.state.recording && sender.tab && (c.state.childTabs || []).includes(sender.tab.id)) {
          if (msg.event && msg.event.kind === 'request') await ingestRequest(c, Object.assign({}, msg.event, { otherTab: true }, sender.frameId ? { frameUrl: sender.url } : {}));
          return { counts: counts(c) };
        }
        // 不是录制中的标签页：回放抓包时收下请求
        const cap = sender.tab && captures.get(sender.tab.id);
        if (cap && msg.event && msg.event.kind === 'request' && keepRequest(msg.event, c.settings)) addCapture(cap, msg.event, sender);
        return { ignored: !cap };
      }
      let ev = msg.event;
      // 回放中的标签页：真实输入产生的也是用户级事件，不能当成录制的操作
      if (ev.kind === 'step' && runningTabs.has(sender.tab.id)) return { ignored: true };
      // 来自 iframe：步骤记下所在框架（回放时按地址找到这个框架再执行），请求记下发出它的页面
      if (sender.frameId) {
        if (ev.kind === 'step') ev.frame = { url: sender.url || ev.url };
        else ev.frameUrl = sender.url;
      }
      if (ev.kind === 'request') await ingestRequest(c, ev);
      else addEvent(c, ev);
      return { counts: counts(c) };
    }
    case 'secret': {
      // 录制中的密码框：明文只放在会话存储（内存里，不落盘、浏览器关掉就没了），用来把之后请求里的同一个值换成占位符
      if (!c.state.recording || !sender.tab || sender.tab.id !== c.state.tabId) return { ok: false };
      const id = String(msg.id || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 24);
      if (!id || typeof msg.value !== 'string') return { ok: false };
      const list = (await secretsOf()).filter((x) => x.id !== id);
      if (msg.value.length >= 3) list.push({ id, value: msg.value });
      secretCache = list.slice(-20);
      await chrome.storage.session.set({ secrets: secretCache }).catch(() => {});
      return { ok: true };
    }
    case 'updateEvent': {
      const ev = c.events.find((e) => e.id === msg.id);
      if (ev) { Object.assign(ev, msg.patch); if (msg.patch && msg.patch.members) groupMembers(c, ev); persist(); }
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
      // 删掉的是语义步骤：它的成员（原始点击）重新出现
      for (const e of c.events) if (e.groupedIn && ids.has(e.groupedIn)) delete e.groupedIn;
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
      const ev = c.events.find((e) => e.id === msg.id && e.kind === 'step' && /^(fill|select|upload|check)$/.test(e.type));
      if (!ev) throw new Error('找不到这个输入步骤');
      if (ev.sensitive) throw new Error('密码类参数不保存，回放时通过参数传入');
      // 只接受组件里已有的选项：单选填组里的选项，复选框填 true/false，多选下拉框填选项列表
      const optOf = (x) => { const t = String(x == null ? '' : x); return (ev.options || []).find((o) => o[0] === t) || (ev.options || []).find((o) => o[1] === t.trim()); };
      const listed = () => (ev.options || []).slice(0, 20).map((o) => o[1]).join('、');
      if (ev.type === 'check' || (ev.type === 'select' && Array.isArray(ev.value))) {
        if (ev.type === 'check' && !Array.isArray(ev.options)) {
          const b = { true: true, false: false, 1: true, 0: false }[String(msg.value)];
          if (b === undefined) throw new Error(`复选框只能填 true（勾选）或 false（不勾选）`);
          if (ev.recordedChecked === undefined) ev.recordedChecked = !!ev.checked;
          ev.checked = b;
        } else if (ev.type === 'check') {
          // 弹窗里按选项序号选（值可能重复，比如没写 value 的单选框都是 on）；手填的文字/值只认唯一的
          let opt = Number.isInteger(msg.index) ? ev.options[msg.index] : null;
          if (!opt) {
            const t = String(msg.value == null ? '' : msg.value).trim();
            const byText = ev.options.filter((o) => o[1] === t);
            const byVal = ev.options.filter((o) => o[0] === t);
            opt = byText.length === 1 ? byText[0] : byText.length ? null : byVal.length === 1 ? byVal[0] : null;
            if (!opt && (byText.length || byVal.length)) throw new Error(`单选项「${t}」对应好几个选项，分不清是哪个（可选：${listed()}）`);
          }
          if (!opt) throw new Error(`单选项里没有「${msg.value}」（可选：${listed()}）`);
          if (ev.recordedText === undefined) ev.recordedText = ev.optionText;
          ev.value = opt[0];
          ev.optionText = opt[1];
        } else {
          const list = Array.isArray(msg.value) ? msg.value : [];
          const opts = list.map(optOf);
          const miss = list.filter((x, i) => !opts[i]);
          if (miss.length) throw new Error(`下拉框里没有选项：${miss.join('、')}（可选：${listed()}）`);
          if (ev.recordedValue === undefined) ev.recordedValue = ev.value;
          ev.value = opts.map((o) => o[0]);
          ev.optionText = opts.map((o) => o[1]).join(', ');
        }
        await persist(true);
        if (!c.state.recording) await syncLibrary(c);
        return { ok: true };
      }
      let v = String(msg.value == null ? '' : msg.value);
      // 下拉框：填选项文字或值都行，存成选项的值
      if (ev.type === 'select') {
        const opt = (ev.options || []).find((o) => o[0] === v) || (ev.options || []).find((o) => o[1] === v.trim());
        if (!opt) throw new Error(`下拉框里没有「${v}」这个选项（可选：${(ev.options || []).slice(0, 20).map((o) => o[1]).join('、')}）`);
        v = opt[0];
        if (ev.recordedValue === undefined) ev.recordedValue = ev.value;
        ev.optionText = opt[1];
      }
      if (ev.type === 'upload') { ev.value = v; await persist(true); if (!c.state.recording) await syncLibrary(c); return { ok: true }; }
      // 留着最初录到的值：接口字段和输入参数的关联是按录制值对上的，改了默认值也不能断
      if (ev.recordedValue === undefined) ev.recordedValue = ev.value;
      ev.value = v;
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
    case 'realInput': {
      // 只给正在用真实输入回放的标签页、并且是这次回放的页面发（页面伪造的消息拿不到正确的回放编号）
      const tabId = sender.tab && sender.tab.id;
      const st = realTabs.get(tabId);
      if (!st || !st.token || msg.token !== st.token || sender.frameId !== st.frameId || (st.docId && sender.documentId && sender.documentId !== st.docId)) {
        return { ok: false, error: '当前没有在用真实输入回放' };
      }
      // 输入已经开始派发后出错（比如按下了但松开时调试连接断了）：结果未知，回放引擎不能再补一次模拟操作
      st.started = false;
      try { return { ok: true, dialogs: await realInputAction(tabId, msg.req || {}) }; } catch (e) { return { ok: false, error: e.message, unknown: !!st.started }; }
    }
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
    case 'exportPackage': {
      // 不传 id：当前录制（先存进脚本库再导出）
      if (!msg.id) {
        if (!c.events.length) throw new Error('当前没有录制内容');
        return { pkg: packageOf({ id: c.state.id, name: defaultName(c), description: c.state.description || '', state: c.state, events: c.events, apiOverrides: c.apiOverrides, aiDocs: c.aiDocs, settings: c.settings }) };
      }
      return { pkg: packageOf(await getLibItem(c, msg.id)) };
    }
    case 'importPackage': return importPackage(c, msg.pkg);
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
  else if ((c.state.childTabs || []).includes(tabId)) { c.state.childTabs = c.state.childTabs.filter((id) => id !== tabId); persist(); }
});
// 录制中的标签页（和它打开的标签页）新开的标签页：里面的请求也算这次录制的（点开详情、导出在新标签页里发的接口）
chrome.tabs.onCreated.addListener(async (tab) => {
  const c = await load();
  if (!c.state.recording || tab.openerTabId == null || runningTabs.has(tab.openerTabId)) return;
  const mine = [c.state.tabId, ...(c.state.childTabs || [])];
  if (!mine.includes(tab.openerTabId) || mine.includes(tab.id)) return;
  c.state.childTabs = [...(c.state.childTabs || []), tab.id].slice(-30);
  persist(true);
});

// 浏览器重启后标签页编号会重新分配，记下的“扩展开过的标签页”可能对到用户自己的标签页上：清掉
chrome.runtime.onStartup.addListener(() => { chrome.storage.local.remove('ourTabs').catch(() => {}); });

load().then((c) => { setBadge(!!c.state.recording); bridgeConnect(); });
