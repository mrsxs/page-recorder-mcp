// 导出脚本内嵌的回放引擎。会通过 Function.prototype.toString() 原样写入导出的脚本，
// 因此这个函数必须完全自包含，不能引用外部变量。
async function __pageRecorderRuntime(REC, PARAMS, API_PARAMS, CONFIG) {
  'use strict';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = (...a) => { if (CONFIG.verbose) console.log('%c[回放]', 'color:#e5484d;font-weight:bold', ...a); };
  const warnings = []; // 回放中的警告，放进结果里给 AI / 用户排查
  const warn = (...a) => { console.warn('[回放]', ...a); if (warnings.length < 50) warnings.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ').slice(0, 300)); };
  const norm = (s) => String(s || '').trim().replace(/\s+/g, ' ');
  const steps = REC.steps;

  // ---------- 输入后端 ----------
  // 扩展回放时连着浏览器调试接口：点击、输入、按键交给扩展发真实输入（浏览器真正产生的事件，
  // 悬停菜单、焦点、回车提交、Tab 都和人手操作一样）；导出的控制台脚本没有这个能力，用合成事件
  let REAL = !!CONFIG.realInput && typeof window.__PR_TOKEN__ === 'string';
  let realSeq = 0;
  const dialogLog = []; // 回放中弹出过的原生弹窗
  function realInput(req) {
    return new Promise((resolve, reject) => {
      const id = 'in' + (++realSeq) + '_' + Date.now().toString(36);
      const on = (e) => {
        const d = e.data;
        if (e.source !== window || !d || d.__page_recorder__ !== 'inputRes' || d.id !== id) return;
        removeEventListener('message', on);
        clearTimeout(timer);
        const res = d.res || {};
        if (res.dialogs && res.dialogs.length) dialogLog.push(...res.dialogs);
        if (res.ok) resolve(res);
        else reject(Object.assign(new Error(res.unknown ? `真实输入执行到一半出错，动作结果未知（${res.error}）` : res.error || '真实输入失败'), { unknown: !!res.unknown }));
      };
      // 已经发出去但没有回音：动作可能已经生效，不能再补一次模拟操作
      const timer = setTimeout(() => { removeEventListener('message', on); reject(Object.assign(new Error('真实输入没有响应，动作结果未知'), { unknown: true })); }, 30000);
      addEventListener('message', on);
      window.postMessage({ __page_recorder__: 'input', token: window.__PR_TOKEN__, id, req }, '*');
    });
  }
  // 真实输入失败（还没发出去）就换成模拟事件；结果未知的直接报错
  async function tryReal(fn, what) {
    if (!REAL) return false;
    try { return (await fn()) !== false; } catch (e) {
      if (e.unknown || e.detached) throw e;
      warn(`${what}：真实输入失败，改用模拟事件（${e.message}）`);
      return false;
    }
  }
  // 合成事件模式下页面弹原生窗会卡住回放：回放期间替换 alert/confirm/prompt，按这一步录下的选择应答；
  // 没录到的 confirm / prompt 一律取消（不替用户确认没见过的操作），结果里标出来
  let dialogPlan = [];
  let dialogSaved = null;
  // 整条录制里录下的弹窗应答：触发它的动作已经过去了（接口返回后隔一会儿才弹）也能按“类型 + 文字”认出来
  const knownDialogs = [];
  for (const s of steps) for (const x of [s, ...(s.members || [])]) for (const d of x.dialogs || []) knownDialogs.push(d);
  function matchKnown(kind, msg) {
    const m = String(msg == null ? '' : msg).slice(0, 120);
    const i = knownDialogs.findIndex((d) => d.kind === kind && (d.message === m || (d.message && (m.startsWith(d.message.slice(0, 40)) || d.message.startsWith(m.slice(0, 40))))));
    return i < 0 ? null : knownDialogs.splice(i, 1)[0];
  }
  function installDialogs() {
    if (REAL || dialogSaved) return;
    dialogSaved = { alert: window.alert, confirm: window.confirm, prompt: window.prompt };
    const answer = (kind, msg) => {
      const want = (dialogPlan.length && dialogPlan[0].kind === kind ? dialogPlan.shift() : null) || matchKnown(kind, msg);
      const accepted = kind === 'alert' || (want ? want.result !== false && want.result !== null : false);
      dialogLog.push({ type: kind, message: String(msg == null ? '' : msg).slice(0, 200), accepted, expected: !!want });
      log(`自动应答${kind}：${accepted ? '确定' : '取消'}`, msg);
      return want;
    };
    window.alert = function (m) { answer('alert', m); };
    window.confirm = function (m) { const w = answer('confirm', m); return w ? w.result !== false && w.result !== null : false; };
    window.prompt = function (m) { const w = answer('prompt', m); return w && w.result !== false ? w.result : null; };
  }
  function restoreDialogs() { if (dialogSaved) { Object.assign(window, dialogSaved); dialogSaved = null; } }

  // ---------- 参数模板 {{name}} ----------
  // {{参数}}；{{参数|date:YYYY-MM-DD 00:00:00}} 按格式输出日期；{{参数|ts:ms}} / {{参数|ts:s:end}} 输出时间戳（end = 当天最后一刻）；
  // {{参数|iso:start}} / {{参数|iso:end}} 输出 toISOString 那样的 UTC 时间；末尾 #序号 取参数里的第几个日期（一个框里的区间）；
  // {{参数|num}} 转成数字；{{参数|opt}} 选项文字换成选项的值（自定义下拉背后的原生 select）
  const paramOrder = (name) => (REC.paramFmt && REC.paramFmt[name]) || null;
  function applyFilter(v, f, name) {
    const i = f.indexOf(':');
    const kind = i < 0 ? f : f.slice(0, i);
    let arg = i < 0 ? '' : f.slice(i + 1);
    if (kind === 'num') { const n = Number(v); return v !== '' && v != null && isFinite(n) ? n : v; }
    // 填进 JSON 字符串里（可能套了几层）：按层数做 JSON 字符串转义
    if (kind === 'jsonesc') { let x = String(v == null ? '' : v); for (let k = 0; k < (+arg || 1); k++) x = JSON.stringify(x).slice(1, -1); return x; }
    if (kind === 'opt') {
      const opts = (REC.paramOptions && REC.paramOptions[name]) || [];
      const s = String(v == null ? '' : v);
      const hit = opts.find((o) => String(o[0]) === s) || opts.find((o) => norm(o[1]) === norm(s));
      if (hit) return hit[0];
      // 选项表里没有这个值：换不出接口要的编码，把文字原样发出去是错的
      if (opts.length && s !== '') throw new Error(`参数「${name}」的值「${s}」不在录到的选项里（${opts.slice(0, 8).map((o) => o[1]).join('、')}${opts.length > 8 ? '…' : ''}），换不出接口要的编码`);
      return v;
    }
    let idx = 0;
    const im = arg.match(/#(\d+)$/);
    if (im) { idx = +im[1]; arg = arg.slice(0, im.index); }
    const all = parseDates(v, paramOrder(name));
    if (all.ambiguous) throw new Error(`参数「${name}」的日期 ${v} 分不清月和日，请写成 YYYY-MM-DD`);
    const d = all[Math.min(idx, all.length - 1)];
    if (!d || d.d == null) return v;
    const pad = (n) => String(n).padStart(2, '0');
    if (kind === 'date') {
      const tm = d.time || { H: 0, i: 0, s: 0 };
      return arg.replace(/YYYY|MM|DD|HH|mm|ss|M|D/g, (t) => ({ YYYY: String(d.y), MM: pad(d.m), DD: pad(d.d), HH: pad(tm.H), mm: pad(tm.i), ss: pad(tm.s), M: String(d.m), D: String(d.d) })[t]);
    }
    if (kind === 'ts') {
      const end = /:end/.test(arg);
      const ms = new Date(d.y, d.m - 1, d.d, end ? 23 : 0, end ? 59 : 0, end ? 59 : 0, end && !/:end0$/.test(arg) ? 999 : 0).getTime();
      return /^s/.test(arg) ? Math.floor(ms / 1000) : ms;
    }
    if (kind === 'iso') {
      const [mode, sec] = arg.split(':');
      const tm = mode === 'time' ? d.time || { H: 0, i: 0, s: 0 } : mode === 'start' ? { H: 0, i: 0, s: 0 } : { H: 23, i: 59, s: 59 };
      const out = new Date(d.y, d.m - 1, d.d, tm.H, tm.i, tm.s, mode === 'end' ? 999 : 0).toISOString();
      return sec === 's' ? out.replace(/\.\d{3}Z$/, 'Z') : out;
    }
    return v;
  }
  function tplValue(expr) {
    const parts = expr.split('|').map((x) => x.trim());
    const name = parts.shift();
    if (!(name in PARAMS)) return undefined;
    return parts.reduce((v, f) => applyFilter(v, f, name), PARAMS[name]);
  }
  function fillTpl(v) {
    if (Array.isArray(v)) return v.map(fillTpl);
    if (v && typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = fillTpl(x); return o; }
    if (typeof v !== 'string') return v;
    const whole = v.match(/^\{\{\s*([^}]+?)\s*\}\}$/);
    if (whole) { const r = tplValue(whole[1]); if (r !== undefined) return r; }
    return v.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (s, k) => { const r = tplValue(k); return r !== undefined ? String(r) : s; });
  }

  // 下拉框参数填的是选项文字时换成选项的值：页面回放和直接请求接口用同一个值
  for (const s of steps) {
    if (s.type !== 'select' || !Array.isArray(s.options)) continue;
    const m = typeof s.value === 'string' && s.value.match(/^\{\{\s*([^}]+?)\s*\}\}$/);
    if (!m || !(m[1] in PARAMS)) continue;
    const v = String(PARAMS[m[1]]);
    if (s.options.some((o) => o[0] === v)) continue;
    const hit = s.options.filter((o) => norm(o[1]) === norm(v));
    if (hit.length === 1) PARAMS[m[1]] = hit[0][0];
  }

  // ---------- 接口匹配与参数改写 ----------
  function matchPath(tpl, path) {
    const A = tpl.split('/');
    const B = path.split('/');
    if (A.length !== B.length) return false;
    return A.every((s, i) => /^\{.+\}$/.test(s) || s === B[i]);
  }
  // 网关式接口（mtop、GraphQL、JSON-RPC）请求体里的操作标识，和导出器的 opOf 规则一致
  const OP_KEYS = /^(operationName|action|cmd|op|operation|optType|opType)$/;
  const OP_URL_KEYS = /^(url|path|uri)$/;
  const OP_QS = /^(mod|module|act|action|method|op|opt|optType|cmd|func|service|operation)$/i;
  const opIdent = (v) => typeof v === 'string' && /^[A-Za-z_][\w.\-/:]{0,79}$/.test(v);
  function opOfObj(o, depth) {
    if (!o || typeof o !== 'object' || Array.isArray(o) || depth > 2) return '';
    if (opIdent(o.operationName)) return 'op=' + o.operationName;
    if (typeof o.query === 'string') { const m = o.query.match(/^\s*(query|mutation|subscription)\s+([A-Za-z_]\w*)/); if (m) return 'op=' + m[2]; }
    if (opIdent(o.method) && (o.jsonrpc || /[./]/.test(o.method))) return 'method=' + o.method;
    for (const [k, v] of Object.entries(o)) if (OP_KEYS.test(k) && opIdent(v)) return `${k}=${v}`;
    for (const [k, v] of Object.entries(o)) {
      if (!OP_URL_KEYS.test(k) || typeof v !== 'string' || !/^\/\S{0,200}$/.test(v)) continue;
      try {
        const u = new URL(v, 'http://x');
        const q = [];
        u.searchParams.forEach((x, n) => { if (OP_QS.test(n) && opIdent(x)) q.push(`${n}=${x}`); });
        return `${k}=${u.pathname}${q.length ? '?' + q.join('&') : ''}`;
      } catch (e) { /* ignore */ }
    }
    for (const k of ['data', 'params', 'body', 'payload', 'request', 'req']) {
      let x = o[k];
      if (typeof x === 'string' && /^\s*[{[]/.test(x)) { try { x = JSON.parse(x); } catch (e) { x = null; } }
      const r = opOfObj(x, depth + 1);
      if (r) return r;
    }
    return '';
  }
  function opOf(body) {
    let o = null;
    try {
      if (typeof body === 'string') {
        const t = body.trim();
        if (/^[{[]/.test(t)) o = JSON.parse(t);
        else if (/^[^=&\s]+=[^&]*(&|$)/.test(t)) { o = {}; new URLSearchParams(t).forEach((v, k) => { o[k] = v; }); }
      } else if (body instanceof URLSearchParams || (typeof FormData !== 'undefined' && body instanceof FormData)) {
        o = {};
        body.forEach((v, k) => { if (typeof v === 'string') o[k] = v; });
      }
    } catch (e) { o = null; }
    return opOfObj(o, 0).slice(0, 120);
  }
  // 路由参数（如 ?mod=stock.list）也要相同；同一路径有多个接口时取路由参数最多的那个；
  // 网关式接口再按请求体里的操作对上（body 拿不到时取第一个）
  function findApi(method, url, body) {
    let u;
    try { u = new URL(url, location.href); } catch (e) { return -1; }
    let best = -1;
    let bestN = -1;
    const op = body !== undefined ? opOf(body) : null;
    for (let i = 0; i < REC.apis.length; i++) {
      const a = REC.apis[i];
      if (a.method !== method || a.host !== u.host || !matchPath(a.pathTemplate, u.pathname)) continue;
      const route = Object.entries(a.route || {});
      if (!route.every(([k, v]) => u.searchParams.getAll(k).join(',') === v)) continue;
      const n = route.length * 2 + (op !== null && (a.op || '') === op ? 1 : 0);
      if (op !== null && a.op && a.op !== op) continue; // 操作不同就不是这个接口
      if (n > bestN) { best = i; bestN = n; }
    }
    return best;
  }
  // a.b[0].c → ['a','b',0,'c']；键名本身带点号、方括号的导出时转义成 filter\.name（和导出器的 keyTokens 一致）
  function pathTokens(p) {
    const out = [];
    const s = String(p);
    let cur = '';
    let has = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === '\\' && i + 1 < s.length) { cur += s[++i]; has = true; continue; }
      if (ch === '.' || ch === '[') {
        if (has) out.push(cur);
        cur = '';
        has = false;
        if (ch === '[') {
          const j = s.indexOf(']', i);
          if (j > i) { const x = s.slice(i + 1, j); out.push(/^\d+$/.test(x) ? Number(x) : x); i = j; }
        }
        continue;
      }
      cur += ch;
      has = true;
    }
    if (has) out.push(cur);
    return out;
  }
  function getPath(obj, p) {
    let cur = obj;
    for (const k of pathTokens(p)) { if (cur == null || typeof cur !== 'object') return undefined; cur = cur[k]; }
    return cur;
  }
  function setPath(obj, p, v, del) {
    const t = pathTokens(p);
    if (!t.length) return;
    let cur = obj;
    for (let i = 0; i < t.length - 1; i++) {
      const k = t[i];
      if (cur[k] == null || typeof cur[k] !== 'object') {
        if (del) return;
        cur[k] = typeof t[i + 1] === 'number' ? [] : {};
      }
      cur = cur[k];
    }
    const last = t[t.length - 1];
    if (del) { if (Array.isArray(cur) && typeof last === 'number') cur.splice(last, 1); else delete cur[last]; } else cur[last] = v;
  }
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const calibrating = Array.isArray(CONFIG.calibrate) ? CONFIG.calibrate : [];
  const tplRefs = (v) => { const out = new Set(); JSON.stringify(v === undefined ? null : v).replace(/\{\{\s*([^}|]+?)\s*(\|[^}]*)?\}\}/g, (m, n) => { out.add(n.trim()); return m; }); return [...out]; };
  // 只改写用户修改过的参数（与录制值不同的、新增的、删除的）
  function diffOf(i) {
    const a = REC.apis[i];
    const cur = API_PARAMS[a.name];
    if (!cur) return null;
    const orig = a.params || {};
    const d = {};
    let any = false;
    for (const sec of ['path', 'query', 'body']) {
      const o = orig[sec] || {};
      const c = cur[sec] || {};
      const sd = {};
      for (const k of Object.keys(c)) {
        // 正在校准的参数关联的字段不改写：让页面自己发，才看得出模板对不对（误关联的字段也不会被改错）
        if (calibrating.length && tplRefs(c[k]).some((n) => calibrating.includes(n))) continue;
        let v;
        try { v = fillTpl(c[k]); } catch (e) { continue; } // 模板算不出来（选项表里没有这个值）：不改，页面自己发的为准
        if (!same(v, o[k])) { sd[k] = { v }; any = true; }
      }
      for (const k of Object.keys(o)) if (!(k in c)) { sd[k] = { del: true }; any = true; }
      d[sec] = sd;
    }
    return any ? d : null;
  }
  function rewriteUrl(a, url, d) {
    const u = new URL(url, location.href);
    if (d.path && Object.keys(d.path).length) {
      const T = a.pathTemplate.split('/');
      const S = u.pathname.split('/');
      T.forEach((s, idx) => {
        const m = s.match(/^\{(.+)\}$/);
        if (m && d.path[m[1]] && !d.path[m[1]].del) S[idx] = encodeURIComponent(d.path[m[1]].v);
      });
      u.pathname = S.join('/');
    }
    for (const [k, x] of Object.entries(d.query || {})) {
      if (x.del || x.v === undefined || x.v === null) u.searchParams.delete(k);
      else if (Array.isArray(x.v)) { u.searchParams.delete(k); x.v.forEach((v) => u.searchParams.append(k, String(v))); }
      else u.searchParams.set(k, typeof x.v === 'object' ? JSON.stringify(x.v) : String(x.v));
    }
    return u.href;
  }
  function rewriteBody(a, body, d) {
    const entries = Object.entries(d.body || {});
    if (!entries.length || body == null) return body;
    const str = (v) => (typeof v === 'object' ? JSON.stringify(v) : String(v));
    if (typeof body === 'string') {
      const t = body.trim();
      if (/^[[{]/.test(t)) {
        try {
          const o = JSON.parse(t);
          entries.forEach(([k, x]) => setPath(o, k, x.v, x.del));
          return JSON.stringify(o);
        } catch (e) { /* not json */ }
      }
      if (a.bodyType === 'form' || /^[^=&\s]+=[^&]*(&|$)/.test(t)) {
        const p = new URLSearchParams(body);
        entries.forEach(([k, x]) => (x.del ? p.delete(k) : p.set(k, str(x.v))));
        return p.toString();
      }
      if (d.body._raw && !d.body._raw.del) return str(d.body._raw.v);
      return body;
    }
    if (body instanceof URLSearchParams) {
      const p = new URLSearchParams(body);
      entries.forEach(([k, x]) => (x.del ? p.delete(k) : p.set(k, str(x.v))));
      return p;
    }
    if (typeof FormData !== 'undefined' && body instanceof FormData) {
      const f = new FormData();
      body.forEach((v, k) => f.append(k, v));
      entries.forEach(([k, x]) => (x.del ? f.delete(k) : f.set(k, str(x.v))));
      return f;
    }
    return body;
  }
  function rewrite(method, url, body) {
    const i = findApi(method, url, body);
    if (i < 0) return null;
    const out = { api: i, url, body };
    if (!CONFIG.rewriteRequests) return out;
    const d = diffOf(i);
    if (!d) return out;
    try {
      out.url = rewriteUrl(REC.apis[i], url, d);
      out.body = rewriteBody(REC.apis[i], body, d);
      if (out.url !== url || out.body !== body) log('已改写请求参数', REC.apis[i].name, out.url);
    } catch (e) { warn('改写请求失败', e); }
    return out;
  }

  // ---------- 网络监听（记录回放过程中的请求和响应） ----------
  async function readRes(res) {
    const ct = res.headers.get('content-type') || '';
    if (ct && !/json|text|xml|javascript|graphql|form/i.test(ct)) return null;
    if (/event-stream/i.test(ct) || +(res.headers.get('content-length') || 0) > 5e6) return null; // 流式、太大的不读
    const t = await res.text();
    try { return JSON.parse(t); } catch (e) { return t.length > 200000 ? t.slice(0, 200000) : t; }
  }
  // 请求体的文字形式（只认字符串、表单），给页面回放校准用
  function bodyText(b) {
    try {
      if (typeof b === 'string') return b.length > 100000 ? null : b;
      if (b instanceof URLSearchParams) return b.toString();
      if (typeof FormData !== 'undefined' && b instanceof FormData) { const p = new URLSearchParams(); b.forEach((v, k) => { if (typeof v === 'string') p.append(k, v); }); return p.toString(); }
    } catch (e) { /* ignore */ }
    return null;
  }
  // 只在回放、调用期间记录（扩展跑完会关掉）：之后用户在这个页面里的请求不再被克隆、读取、留在内存里
  function installNet() {
    let net = window.__PR_NET__;
    if (!net) {
      net = { log: [], rewrite: null, active: true };
      Object.defineProperty(window, '__PR_NET__', { value: net, configurable: true });
      const push = (e) => { net.log.push(e); if (net.log.length > 1000) net.log.splice(0, 200); };
      const of = window.fetch;
      window.fetch = function (input, init) {
        if (!net.active && !net.rewrite) return of.call(this, input, init);
        const entry = { ts: Date.now(), method: 'GET', url: '', api: -1, done: false };
        try {
          const req = typeof Request !== 'undefined' && input instanceof Request ? input : null;
          entry.url = new URL(req ? req.url : String(input), location.href).href;
          entry.method = String((init && init.method) || (req && req.method) || 'GET').toUpperCase();
          // __PR__.api.call 自己发的请求已经按调用参数组装好，不再按 API_PARAMS 改写
          const r = net.rewrite && !(init && init.__prNoRewrite) && net.rewrite(entry.method, entry.url, init ? init.body : undefined);
          if (r) {
            entry.api = r.api;
            entry.pre = { url: entry.url, body: init ? bodyText(init.body) : null }; // 改写前页面自己要发的
            if (r.url !== entry.url) { entry.url = r.url; input = req ? new Request(r.url, req) : r.url; }
            if (init && r.body !== init.body) init = Object.assign({}, init, { body: r.body });
          }
        } catch (e) { /* ignore */ }
        if (!net.active) return of.call(this, input, init);
        push(entry);
        const p = of.call(this, input, init);
        p.then((res) => {
          entry.status = res.status;
          let c = null;
          try { c = res.clone(); } catch (e) { /* ignore */ }
          if (!c) { entry.done = true; return; }
          readRes(c).then((b) => { entry.body = b; }, () => {}).finally(() => { entry.done = true; });
        }, (err) => { entry.error = String(err); entry.done = true; });
        return p;
      };
      const XP = XMLHttpRequest.prototype;
      const oo = XP.open;
      const os = XP.send;
      XP.open = function (method, url, ...rest) {
        this.__prn = null;
        if (!net.active && !net.rewrite) return oo.call(this, method, url, ...rest);
        const entry = { method: String(method || 'GET').toUpperCase(), url: String(url), api: -1, done: false };
        try {
          entry.url = new URL(String(url), location.href).href;
          const r = net.rewrite && net.rewrite(entry.method, entry.url, undefined);
          if (r) { entry.api = r.api; entry.pre = { url: entry.url, body: null }; entry.url = r.url; }
        } catch (e) { /* ignore */ }
        this.__prn = entry;
        return oo.call(this, method, entry.url, ...rest);
      };
      XP.send = function (body) {
        const entry = this.__prn;
        if (entry) {
          entry.ts = Date.now();
          try {
            if (entry.pre) entry.pre.body = bodyText(body);
            const r = net.rewrite && net.rewrite(entry.method, entry.url, body);
            if (r) entry.api = r.api; // 有了请求体才认得出网关式接口是哪个操作
            if (r && r.body !== body) body = r.body;
          } catch (e) { /* ignore */ }
          if (net.active) push(entry);
          if (net.active) this.addEventListener('loadend', () => {
            entry.status = this.status;
            try {
              if (this.responseType === 'json') entry.body = this.response;
              else if (this.responseType === '' || this.responseType === 'text') {
                const t = this.responseText;
                try { entry.body = JSON.parse(t); } catch (e) { entry.body = t && t.length > 200000 ? t.slice(0, 200000) : t; }
              }
            } catch (e) { /* ignore */ }
            entry.done = true;
          });
        }
        return os.call(this, body);
      };
    }
    net.rewrite = rewrite;
    net.active = CONFIG.netLog !== false;
    return net;
  }
  function netOff() {
    const net = window.__PR_NET__;
    if (!net) return;
    if (net.rewrite === rewrite) net.rewrite = null;
    net.active = false;
    net.log.length = 0;
  }
  // 页面回放校准直接请求：参数改过的接口字段，页面自己（改写前）发的值和模板算出来的一不一样。
  // ok = 一样（以后可以放心直接请求）；mismatch = 不一样（格式没学对，直接请求会发错）；unknown = 没看到 / 页面没改这个值
  function calibrate(names) {
    const net = window.__PR_NET__;
    const verdict = {};
    const details = [];
    const eq = (x, y) => JSON.stringify(x) === JSON.stringify(y) || (x != null && y != null && typeof x !== 'object' && typeof y !== 'object' && String(x) === String(y));
    const refsOf = (v) => { const out = new Set(); JSON.stringify(v === undefined ? null : v).replace(/\{\{\s*([^}|]+?)\s*(\|[^}]*)?\}\}/g, (m, n) => { out.add(n.trim()); return m; }); return [...out]; };
    REC.apis.forEach((a, i) => {
      const tpl = API_PARAMS[a.name];
      if (!tpl) return;
      // 这个框架里没看到这个接口（在别的框架、或者这次没发）：不下结论，由扩展汇总各段
      const e = net ? [...net.log].reverse().find((x) => x.api === i && x.pre) : null;
      if (!e) return;
      let u = null;
      let bodyObj;
      let form = null;
      try { u = new URL(e.pre.url, location.href); } catch (x) { /* ignore */ }
      if (typeof e.pre.body === 'string') { try { bodyObj = JSON.parse(e.pre.body); } catch (x) { form = new URLSearchParams(e.pre.body); } }
      const pageVal = (sec, k, v) => {
        if (u && sec === 'query') { const all = u.searchParams.getAll(k); return Array.isArray(v) ? all : all.length ? all[0] : undefined; }
        if (u && sec === 'path') { const T = a.pathTemplate.split('/'); const S = u.pathname.split('/'); const at = T.indexOf(`{${k}}`); return at >= 0 && S[at] !== undefined ? decodeURIComponent(S[at]) : undefined; }
        if (sec === 'body') return bodyObj !== undefined ? getPath(bodyObj, k) : form ? (form.has(k) ? form.get(k) : undefined) : undefined;
        return undefined;
      };
      // 这个接口引用了正在校准的参数：没关联参数的字段页面也不能变（比如选项的代码跟着选项文字变了，
      // 直接请求只换得了文字，代码还是旧的）；时间戳、签名这类每次都变的不算
      const apiRefs = new Set();
      for (const sec of ['path', 'query', 'body']) for (const v of Object.values(tpl[sec] || {})) refsOf(v).filter((n) => names.includes(n)).forEach((n) => apiRefs.add(n));
      const VOLATILE = /^(t|_|_t|ts|timestamp|time|nonce|sign|signature|callback|jsonp|rnd|random|traceid|requestid|reqid|r)$/i;
      if (apiRefs.size) {
        for (const sec of ['path', 'query', 'body']) {
          for (const [k, v] of Object.entries(tpl[sec] || {})) {
            if (refsOf(v).length || VOLATILE.test(String(pathTokens(k).pop()))) continue;
            const rec = ((a.params || {})[sec] || {})[k];
            if (rec === '' || rec == null || (a.masked || []).includes(`${sec}.${k}`) || /^\d{10}(\d{3})?$/.test(String(rec))) continue;
            // 页面这次的请求读得出来（地址、JSON 或表单请求体）、里面却没有这个字段了：也是对不上（直接请求还会带着它）
            const readable = sec === 'body' ? bodyObj !== undefined || !!form : !!u;
            if (!readable) continue;
            const got = pageVal(sec, k, v);
            if (got !== undefined && eq(got, rec)) continue;
            details.push({ api: a.name, field: `${sec}.${k}`, params: [...apiRefs], page: got === undefined ? null : got, template: rec, result: 'mismatch', extra: true, missing: got === undefined || undefined });
            for (const n of apiRefs) verdict[n] = 'mismatch';
          }
        }
      }
      for (const sec of ['path', 'query', 'body']) {
        for (const [k, v] of Object.entries(tpl[sec] || {})) {
          const refs = refsOf(v).filter((n) => names.includes(n));
          if (!refs.length) continue;
          let got;
          if (u && sec === 'query') { const all = u.searchParams.getAll(k); got = Array.isArray(v) ? all : all.length ? all[0] : undefined; }
          else if (u && sec === 'path') { const T = a.pathTemplate.split('/'); const S = u.pathname.split('/'); const at = T.indexOf(`{${k}}`); got = at >= 0 && S[at] !== undefined ? decodeURIComponent(S[at]) : undefined; }
          else if (sec === 'body') got = bodyObj !== undefined ? getPath(bodyObj, k) : form ? (form.has(k) ? form.get(k) : undefined) : undefined;
          let want;
          try { want = fillTpl(v); } catch (x) { want = undefined; }
          const rec = ((a.params || {})[sec] || {})[k];
          const r = got === undefined || want === undefined ? 'unknown' : eq(got, want) ? 'ok' : eq(got, rec) ? 'unknown' : 'mismatch';
          details.push({ api: a.name, field: `${sec}.${k}`, params: refs, page: got, template: want, result: r });
          for (const n of refs) {
            const prev = verdict[n];
            verdict[n] = prev === 'mismatch' || r === 'mismatch' ? 'mismatch' : prev === 'unknown' || r === 'unknown' ? 'unknown' : 'ok';
          }
        }
      }
    });
    return { params: verdict, details: details.slice(0, 300) };
  }

  // 优先认这一步开始之后发出的请求（取最新的一次）；1.5 秒内没等到，再看上一步开始之后的
  // （页面常在输入时就发请求，而不是等到回车）。已经算给某一步的请求不再重复计入
  async function waitRequests(apiIdx, since, timeout, lookback) {
    const net = window.__PR_NET__;
    const end = Date.now() + timeout;
    const found = [];
    const pending = new Set(apiIdx);
    const pick = (i, from) => {
      const a = REC.apis[i];
      const hits = net.log.filter((x) => x.done && !x.claimed && x.ts >= from && x.method === a.method && (x.api === i || (x.api < 0 && findApi(x.method, x.url) === i)));
      return hits[hits.length - 1];
    };
    while (pending.size && Date.now() < end) {
      checkCancel();
      for (const i of [...pending]) {
        const a = REC.apis[i];
        const e = pick(i, since) || (lookback != null && Date.now() - since > 1500 ? pick(i, lookback) : null);
        if (e) { e.claimed = true; pending.delete(i); found.push({ api: a.name, method: e.method, url: e.url, status: e.status, data: e.body }); }
      }
      if (pending.size) await sleep(100);
    }
    for (const i of pending) warn(`等待接口超时：${REC.apis[i].name}（已继续执行）`);
    return found;
  }

  // ---------- 元素定位 ----------
  function visible(el) {
    if (!el || !el.isConnected) return false;
    if (el.checkVisibility) return el.checkVisibility({ visibilityProperty: true });
    return el.getClientRects().length > 0;
  }
  function qsaIn(root, sel) { try { return [...root.querySelectorAll(sel)]; } catch (e) { return []; } }
  // 目标在 Shadow DOM 里时，录制时记下了宿主链（每层宿主的选择器），按链逐层进入 shadowRoot
  // 目标在同源的 about:blank / srcdoc iframe（富文本编辑器）里：先按 iframe 选择器链进到它的 document
  function rootsOf(t) {
    let roots = [document];
    for (const frameSels of (t && t.frames) || []) {
      const next = new Set();
      for (const r of roots) {
        for (const sel of frameSels) {
          for (const f of qsaIn(r, sel)) { try { if (f.contentDocument && f.contentDocument.documentElement) next.add(f.contentDocument); } catch (e) { /* 跨域的进不去 */ } }
        }
      }
      roots = [...next];
      if (!roots.length) return roots;
    }
    for (const hostSels of (t && t.shadow) || []) {
      const next = new Set();
      for (const r of roots) for (const sel of hostSels) for (const h of qsaIn(r, sel)) if (h.shadowRoot) next.add(h.shadowRoot);
      roots = [...next];
      if (!roots.length) break;
    }
    return roots;
  }
  function qsa(sel, roots) { const out = []; for (const r of roots || [document]) out.push(...qsaIn(r, sel)); return out; }
  const textOf = (el) => norm(el.innerText || el.textContent).slice(0, 80);
  // ---------- 元素所在的上下文（和录制端 content/recorder.js 的算法一致） ----------
  // 弹层：对话框、抽屉、下拉、气泡、日期面板等。同一个页面里常有多个结构相同的弹窗，靠弹层标题区分
  const BOX_SEL = '[role=dialog],[role=alertdialog],[aria-modal=true],dialog,[role=menu],[role=listbox],[role=tooltip]';
  const BOX_CLASS = /(^|[-_\s])(modal|dialog|drawer|popover|popup|dropdown|picker|layer|overlay|popper|tooltip)([-_\s]|$)/i;
  const up = (n) => n.parentElement || (n.parentNode && n.parentNode.host) || null;
  function boxOf(el) {
    for (let n = up(el), d = 0; n && n.nodeType === 1 && d < 30; n = up(n), d++) {
      if (n.matches(BOX_SEL) || (typeof n.className === 'string' && BOX_CLASS.test(n.className))) return n;
    }
    return null;
  }
  function boxTitle(b) {
    const h = b.querySelector('[class*=title i],[class*=header i],h1,h2,h3,h4,legend');
    return h ? norm(h.innerText || h.textContent).slice(0, 40) : '';
  }
  // 表单项的标签文字（“下单时间”“仓库”）：从元素往上找，同级里第一个像标签的元素
  function fieldLabelOf(el) {
    let n = el;
    for (let d = 0; d < 6 && n.parentElement; d++) {
      const p = n.parentElement;
      for (const c of p.children) {
        if (c === n || c.contains(el)) continue;
        const cls = typeof c.className === 'string' ? c.className : '';
        if (c.tagName === 'LABEL' || /(^|[-_\s])(label|item-title)([-_\s]|$)/i.test(cls)) {
          const t = norm(c.innerText || c.textContent).replace(/[:：*\s]+$/, '');
          if (t && t.length <= 30) return t;
        }
      }
      n = p;
    }
    // 上面没找到：组件库套得深的（标签在七八层以外），和没有 <label>、只是在控件前面放一段文字的（“发货时间 [日期框]”）。
    // 只在同一行里往上找：紧挨在前面的纯文字就是名字，再往上遇到带 label 的兄弟也算
    n = el;
    for (let d = 0; d < 9 && n.parentElement; d++) {
      const p = n.parentElement;
      if (p === document.body || p.getBoundingClientRect().height > 100) break;
      if (d >= 6) {
        for (const c of p.children) {
          if (c === n || c.contains(el)) continue;
          const cls = typeof c.className === 'string' ? c.className : '';
          if (c.tagName === 'LABEL' || /(^|[-_\s])(label|item-title)([-_\s]|$)/i.test(cls)) {
            const t = norm(c.innerText || c.textContent).replace(/[:：*\s]+$/, '');
            if (t && t.length <= 30) return t;
          }
        }
      }
      for (let c = n.previousElementSibling; c; c = c.previousElementSibling) {
        if (c.matches('input,select,textarea,button,a,[role=button]') || c.querySelector('input,select,textarea,button,a,[role=button],[tabindex]') || c.children.length > 2) break;
        const t = norm(c.innerText || c.textContent).replace(/[:：*\s]+$/, '');
        if (t.length >= 2 && t.length <= 20 && /[A-Za-z\u4e00-\u9fff]/.test(t)) return t;
      }
      n = p;
    }
    return '';
  }
  // 表格行里的元素：录制时记下这一行前几格的文字（等于输入参数的已经换成 {{参数}}），回放时按格子对
  // 对得上几格（0 = 一格都对不上）：按单元格整格比，ORD-1 不能算进 ORD-10 里
  function rowMatch(el, t) {
    const cells = t.ctx && t.ctx.row;
    if (!cells || !cells.length) return null;
    const row = el.closest && el.closest('tr,[role=row]');
    if (!row) return 0;
    const own = new Set([...row.children].map((c) => norm(c.innerText || c.textContent)));
    return cells.filter((c) => { const v = norm(fillTpl(c)); return v && own.has(v); }).length;
  }
  // 按行筛：对上格子最多的；最多的有好几行（客户、状态这类公共字段一样）就分不清，返回 null 让调用方继续等或报错
  function byRow(list, t) {
    const scored = list.map((e) => ({ e, n: rowMatch(e, t) }));
    const max = Math.max(0, ...scored.map((x) => x.n));
    if (!max) return list.length > 1 ? null : list;
    const best = scored.filter((x) => x.n === max).map((x) => x.e);
    const rows = new Set(best.map((e) => e.closest('tr,[role=row]')));
    return rows.size > 1 ? null : best;
  }
  // 录制时在弹层（对话框、抽屉）里的目标，候选也必须在弹层里、标题一致（弹窗还没出来时不能点到页面上同名的按钮）
  function ctxOk(el, t) {
    const c = t.ctx && t.ctx.box;
    if (!c) return true;
    const b = boxOf(el);
    return !!b && (!c.title || boxTitle(b) === c.title);
  }
  // 多个候选时打分：命中的选择器越多、文字/name/表单标签/所在弹层（标题）和录制时一致的越优先
  function scoreOf(el, t, hits) {
    let s = (hits.get(el) || 0) * 2;
    if (t.text) s += textOf(el) === t.text ? 5 : -3; // 文字对不上算身份冲突
    if (t.selectors && /^#/.test(t.selectors[0] || '') && qsaIn(el.getRootNode(), t.selectors[0]).includes(el)) s += 4; // 稳定 id
    if (t.name && el.getAttribute('name') === t.name) s += 1;
    const c = t.ctx;
    if (c) {
      if (c.label) s += fieldLabelOf(el) === c.label ? 3 : -1;
      const b = boxOf(el);
      if (c.box) {
        if (!b) s -= 3;
        else if (c.box.title) s += boxTitle(b) === c.box.title ? 4 : 0;
        else s += 1;
      } else if (b) s -= 1;
    }
    return s;
  }
  let ambiguity = null; // 最近一次定位遇到的“分不清是哪个”（写进步骤日志）
  function pickBest(cands, t, hits) {
    if (cands.length === 1) return cands[0];
    const ranked = cands.map((e, i) => ({ e, s: scoreOf(e, t, hits), i })).sort((a, b) => b.s - a.s || a.i - b.i);
    if (ranked[0].s === ranked[1].s) {
      const tie = ranked.filter((x) => x.s === ranked[0].s);
      ambiguity = { count: tie.length, desc: t.desc };
      // 平分时优先最上层弹层里的（新弹出的弹层在 DOM 后面）
      const inBox = tie.filter((x) => boxOf(x.e));
      if (inBox.length && t.ctx && t.ctx.box) return inBox[inBox.length - 1].e;
    }
    return ranked[0].e;
  }
  // relaxCtx：等了很久还是找不到在弹层里的那个，才退而求其次接受弹层外的（写进警告）
  function locate(t, allowHidden, relaxCtx) {
    const roots = rootsOf(t);
    const rows = !!(t.ctx && t.ctx.row && t.ctx.row.length);
    // 表格行里的元素有稳定的 id（#order-123-edit）：id 就是身份，直接用
    const s0 = (t.selectors || [])[0] || '';
    if (rows && /^#[^\s>+~:[]+$/.test(s0)) {
      const m = qsa(s0, roots).filter(visible);
      if (m.length === 1 && (!t.text || textOf(m[0]) === t.text) && (relaxCtx || ctxOk(m[0], t))) return m[0];
    }
    // 按录制时的优先顺序：某个选择器正好命中一个可见元素、文字也对得上、上下文也对，就是它
    // （表格行里的元素不走这条：tr:nth-of-type(5) 这种按位置的选择器换了数据就是别的记录）
    if (!rows) {
      for (const sel of t.selectors || []) {
        const vis = qsa(sel, roots).filter(visible);
        if (vis.length === 1 && (!t.text || textOf(vis[0]) === t.text) && (relaxCtx || ctxOk(vis[0], t))) return vis[0];
      }
    }
    const hits = new Map();
    for (const sel of t.selectors || []) for (const e of qsa(sel, roots)) hits.set(e, (hits.get(e) || 0) + 1);
    const all = [...hits.keys()];
    let vis = all.filter(visible);
    // 选择器失效或者命中的都不是这个文字（类名每次构建都变的网站）、或者是表格行里的：再按标签+文字找，一起打分
    if (t.text && (rows || !vis.some((e) => textOf(e) === t.text))) {
      vis = vis.concat(qsa(t.tag || '*', roots).filter((e) => !hits.has(e) && visible(e) && textOf(e) === t.text));
    }
    if (!relaxCtx && t.ctx && t.ctx.box) vis = vis.filter((e) => ctxOk(e, t));
    if (rows && vis.length) {
      // 按行找：对上格子最多的那一行；一格都对不上时只有一个候选（搜出来就这一条）才用它，否则宁可报错也不点到别的记录
      vis = byRow(vis, t);
      if (!vis) return null;
    }
    if (vis.length) return pickBest(vis, t, hits);
    // 只剩隐藏的（藏起来的原生下拉框、文件框）：同样要过弹层上下文和行的筛选
    let hid = allowHidden ? all.filter((e) => !visible(e) && (relaxCtx || ctxOk(e, t))) : [];
    if (rows && hid.length) hid = byRow(hid, t) || [];
    if (hid.length) return pickBest(hid, t, hits);
    return null;
  }
  // 目标是靠文字认的，而文字里带着这次换掉了的参数旧值（点在多选框、日期框所在的那块区域上，区域文字里有选中的值）：
  // 按文字精确找不到时，找同标签、文字的词重合度最高的那个；对不上一半或者有两个差不多的就算没找到
  function changedPairs() {
    const out = [];
    for (const s of steps) {
      if (s.recorded === undefined || typeof s.value !== 'string') continue;
      const m = s.value.match(/^\{\{\s*([^}|]+?)\s*\}\}$/);
      if (!m || !(m[1] in PARAMS)) continue;
      const a = [].concat(s.recorded).map(String);
      const b = [].concat(PARAMS[m[1]]).map(String);
      if (a.join('\u0001') === b.join('\u0001')) continue;
      // 多选按位置一一对应，级联按层对应，其他整个值对应
      if (a.length === b.length) a.forEach((x, i) => { out.push([x, b[i]]); const xs = x.split(' / '), ys = b[i].split(' / '); if (xs.length > 1 && xs.length === ys.length) xs.forEach((y, j) => out.push([y, ys[j]])); });
      else out.push([a.join(', '), b.join(', ')]);
    }
    return out.map(([x, y]) => [norm(x), norm(y)]).filter(([x, y]) => x && x !== y).sort((p, q) => q[0].length - p[0].length);
  }
  function locateFuzzy(t) {
    // 点在页面空白处（html/body）：页面上只有一个，文字跟着内容变，不用比
    if (t && /^(html|body)$/i.test(t.tag || '')) return t.tag.toLowerCase() === 'html' ? document.documentElement : document.body;
    // 只用于点在表单区域上（不是链接、按钮、列表行这类有自己含义的目标），而且这块区域里得有输入框/下拉框
    if (!t || !t.text || /^(a|button|input|select|textarea|option|li|tr|td|th)$/i.test(t.tag || '')) return null;
    const pairs = changedPairs();
    if (!pairs.some(([x]) => t.text.toLowerCase().includes(x.toLowerCase()))) return null;
    // 把录制时文字里的旧值换成这次的新值，再按词比
    let guess = t.text;
    for (const [x, y] of pairs) guess = guess.replace(new RegExp(x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), y);
    const tok = (s) => new Set(norm(s).toLowerCase().split(/[\s,，、/|:：×]+/).filter(Boolean));
    const want = tok(guess);
    const sim = (e) => { const h = tok(textOf(e)); let n = 0; for (const w of h) if (want.has(w)) n++; return n / (want.size + h.size - n || 1); };
    const FIELD = 'input:not([type=hidden]),select,textarea,[role=combobox],[contenteditable=""],[contenteditable=true],[class*=select],[class*=picker],[class*=cascader]';
    const cands = qsa(t.tag || '*', rootsOf(t)).filter((e) => visible(e) && ctxOk(e, t) && !e.closest('a,button,[role=button],[role=link]') && e.querySelector(FIELD)).map((e) => [e, sim(e)]).filter(([, v]) => v >= 0.6).sort((x, y) => y[1] - x[1]);
    if (!cands.length) return null;
    const top = cands.filter(([, v]) => v >= cands[0][1] - 0.05).map(([e]) => e);
    // 几乎一样的几个是一层套一层的（外框和里面的框）就点最里面那个，不是的话分不清
    return top.find((e) => top.every((o) => o === e || o.contains(e))) || null;
  }
  // 可选步骤：只认可见、并且标签和文字都和录制时一致的元素
  // （避免“登录”没了却点到同一位置的“退出登录”，或者填到隐藏的登录框里）
  // 输入框没有文字，就看 type / name（录制时有的话）；都没有就只能信选择器
  const sameIdentity = (el, t) => (!t.tag || el.tagName.toLowerCase() === t.tag)
    && (!t.text || textOf(el) === t.text)
    && (!t.type || (el.getAttribute('type') || '').toLowerCase() === String(t.type).toLowerCase())
    && (!t.name || el.getAttribute('name') === t.name);
  function locateStrict(t) {
    const roots = rootsOf(t);
    for (const sel of t.selectors || []) {
      const m = qsa(sel, roots).filter(visible).find((e) => sameIdentity(e, t));
      if (m) return m;
    }
    if (t.text) return qsa(t.tag || '*', roots).filter(visible).find((e) => textOf(e) === t.text) || null;
    return null;
  }
  // 取消（扩展在超时等情况下调用 __PR__.cancel()）：正在等待的查找和后续步骤都会停下
  let cancelled = false;
  const checkCancel = () => { if (cancelled) throw new Error('回放已取消'); };
  let optionalFind = null;
  // allowHidden：先等可见的（联动才出现的字段），等过一半时间还没有才接受隐藏的（藏起来的原生下拉框、文件框）
  async function find(t, allowHidden) {
    if (!t) throw new Error('步骤缺少目标元素');
    const start = Date.now();
    const span = optionalFind != null ? optionalFind : CONFIG.findTimeout;
    const end = start + span;
    // 本来就常藏着的（原生下拉框被组件替换、文件框、自定义样式的复选框）不用等
    const hiddenKind = t.tag === 'select' || /^(file|checkbox|radio|hidden)$/i.test(t.type || '');
    for (;;) {
      checkCancel();
      const late = hiddenKind || Date.now() - start > span / 2;
      let el = optionalFind != null ? locateStrict(t) : locate(t, allowHidden && late);
      if (!el && optionalFind == null && late && t.ctx && t.ctx.box) {
        el = locate(t, allowHidden, true);
        if (el) warn(`${t.desc || '元素'}：录制时在弹层「${t.ctx.box.title || ''}」里，现在只在弹层外找到`);
      }
      if (!el && optionalFind == null && late) {
        el = locateFuzzy(t);
        if (el) warn(`${t.desc || '元素'}：文字里有换掉的参数值，按相近的文字找到「${textOf(el).slice(0, 30)}」`);
      }
      if (el) return el;
      if (Date.now() > end) throw new Error(`找不到元素 ${t.desc || ''}（选择器：${(t.selectors || []).join(' | ')}）`);
      await sleep(150);
    }
  }
  // 点击目标：优先等可见元素。找不到时先沿录制时鼠标经过的元素悬停一遍（悬停才展开的菜单），
  // 还是只有隐藏的就悬停它的祖先；仍看不见就返回 { hidden } 让调用方直接触发点击。
  // 可选步骤不走这条路：隐藏的元素算作“没有”
  function hoverSynthetic(el) {
    const chain = [];
    for (let e = el; e && e !== document.body; e = e.parentElement) {
      chain.unshift(e);
      if (e !== el && visible(e)) break;
    }
    for (const e of chain) {
      const r = e.getBoundingClientRect();
      const o = { bubbles: true, cancelable: true, composed: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
      e.dispatchEvent(new PointerEvent('pointerover', Object.assign({ pointerType: 'mouse', isPrimary: true }, o)));
      e.dispatchEvent(new PointerEvent('pointerenter', Object.assign({ pointerType: 'mouse', isPrimary: true }, o, { bubbles: false })));
      e.dispatchEvent(new MouseEvent('mouseover', o));
      e.dispatchEvent(new MouseEvent('mouseenter', Object.assign({}, o, { bubbles: false })));
      e.dispatchEvent(new MouseEvent('mousemove', o));
    }
  }
  async function hoverEl(el) {
    const ok = await tryReal(async () => {
      const p = await pointFor(el, null, 300);
      if (!p) return false;
      await realInput({ type: 'move', x: p.x, y: p.y });
    }, '悬停');
    if (!ok) hoverSynthetic(el);
  }
  async function hoverTrail(trail) {
    for (const h of trail || []) {
      const el = locate(h, false);
      if (!el) continue;
      await hoverEl(el);
      await sleep(300);
    }
  }
  async function findClickable(t, s) {
    if (!t) throw new Error('步骤缺少目标元素');
    if (optionalFind != null) return find(t, false);
    const start = Date.now();
    const end = start + CONFIG.findTimeout;
    let trailed = false;
    let hovered = false;
    // 隐藏着的目标（悬停才展开的菜单里的）可以直接触发点击；还没弹出来的对话框、抽屉里的“确定”不能点
    const menuHidden = (h) => !(h.closest && h.closest('[role=dialog],[role=alertdialog],dialog,[aria-modal=true],[class*=modal],[class*=dialog],[class*=drawer]'));
    for (;;) {
      checkCancel();
      let el = locate(t, false);
      if (!el && t.ctx && t.ctx.box && Date.now() - start > CONFIG.findTimeout * 0.7) {
        el = locate(t, false, true);
        if (el) warn(`${t.desc || '元素'}：录制时在弹层「${t.ctx.box.title || ''}」里，现在只在弹层外找到，点了弹层外的`);
      }
      if (el) return el;
      if (!trailed && s && s.hover && s.hover.length && Date.now() - start > 500) { trailed = true; await hoverTrail(s.hover); continue; }
      let hidden = Date.now() - start > 800 ? locate(t, true) : null;
      if (hidden && !menuHidden(hidden)) hidden = null;
      if (hidden) {
        if (!hovered) {
          hovered = true;
          let anc = hidden.parentElement;
          while (anc && anc !== document.body && !visible(anc)) anc = anc.parentElement;
          if (anc && anc !== document.body) await hoverEl(anc);
          hoverSynthetic(hidden);
          await sleep(300);
          if (visible(hidden)) return hidden;
        }
        return { hidden };
      }
      const near = Date.now() - start > 800 ? locateFuzzy(t) : null;
      if (near) { warn(`${t.desc || '元素'}：文字里有换掉的参数值，按相近的文字找到「${textOf(near).slice(0, 30)}」`); return near; }
      if (Date.now() > end) throw new Error(`找不到元素 ${t.desc || ''}（选择器：${(t.selectors || []).join(' | ')}）`);
      await sleep(150);
    }
  }

  let hlBox = null;
  function highlight(el) {
    if (!CONFIG.highlight || !el) return;
    if (!hlBox) {
      hlBox = document.createElement('div');
      hlBox.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #e5484d;background:rgba(229,72,77,.12);border-radius:3px;transition:all .15s';
    }
    const r = rectOf(el);
    Object.assign(hlBox.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px', display: 'block' });
    document.documentElement.appendChild(hlBox);
    clearTimeout(highlight.t);
    highlight.t = setTimeout(() => { hlBox.style.display = 'none'; }, 600);
  }

  // ---------- 操作 ----------
  // 能点、能操作的元素（遮挡判断、定位用）
  const INTERACTIVE = 'a,button,input,select,textarea,label,summary,details,option,[onclick],[tabindex],[contenteditable]:not([contenteditable=false]),'
    + ['button', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'tab', 'checkbox', 'radio', 'switch', 'treeitem', 'combobox', 'slider', 'spinbutton', 'textbox', 'searchbox', 'gridcell', 'row'].map((r) => `[role=${r}]`).join(',');
  // 坐标处的元素（穿透 open Shadow DOM、同源 iframe）
  const frameInner = (f) => { const r = f.getBoundingClientRect(); const cs = getComputedStyle(f); return { x: r.left + f.clientLeft + (parseFloat(cs.paddingLeft) || 0), y: r.top + f.clientTop + (parseFloat(cs.paddingTop) || 0) }; };
  function deepHit(x, y) {
    let h = document.elementFromPoint(x, y);
    for (let k = 0; k < 6 && h; k++) {
      while (h && h.shadowRoot) {
        const inner = h.shadowRoot.elementFromPoint(x, y);
        if (!inner || inner === h) break;
        h = inner;
      }
      if (!h || !/^(IFRAME|FRAME)$/.test(h.tagName)) break;
      let d = null;
      try { d = h.contentDocument; } catch (e) { d = null; }
      if (!d) break;
      const o = frameInner(h);
      x -= o.x;
      y -= o.y;
      const inner = d.elementFromPoint(x, y);
      if (!inner) break;
      h = inner;
    }
    return h;
  }
  // 元素在本页面视口里的位置（在同源 iframe 编辑器里的加上 iframe 的位置）
  function frameOff(el) {
    let x = 0;
    let y = 0;
    for (let w = el.ownerDocument && el.ownerDocument.defaultView; w && w !== window; w = w.parent) {
      const f = w.frameElement;
      if (!f) break;
      const o = frameInner(f);
      x += o.x;
      y += o.y;
    }
    return { x, y };
  }
  function rectOf(el, r) {
    r = r || el.getBoundingClientRect();
    if (el.ownerDocument === document) return r;
    const o = frameOff(el);
    return { left: r.left + o.x, top: r.top + o.y, right: r.right + o.x, bottom: r.bottom + o.y, width: r.width, height: r.height };
  }
  function covers(el, h) {
    for (let n = h; n; n = n.parentNode || n.host) {
      if (n === el) return true;
      if (n.tagName === 'LABEL' && n.control === el) return true;
    }
    return false;
  }
  // 能真实点到这个元素的位置（本框架视口坐标）：点下去命中的要是它自己或它里面的元素，被挡住就换个位置。
  // pos 是录制时点击的相对位置（画布、图片这类点哪里有区别的元素才有）
  // 等元素停稳：它或祖先还在做过渡/动画（弹出层展开、面板滑入）时算出的坐标，点下去时已经偏了。
  // 无限循环的动画（加载转圈）不等
  async function settle(el, max) {
    const end = Date.now() + (max || 1200);
    let last = '';
    for (;;) {
      const r = el.getBoundingClientRect();
      const key = [r.left, r.top, r.width, r.height].map(Math.round).join(',');
      let moving = false;
      for (let n = el; n && n.nodeType === 1 && !moving; n = n.parentElement || (n.parentNode && n.parentNode.host)) {
        if (n.getAnimations) moving = n.getAnimations().some((a) => a.playState === 'running' && !(a.effect && a.effect.getTiming && a.effect.getTiming().iterations === Infinity));
      }
      if ((!moving && key === last) || Date.now() > end) return;
      last = key;
      await sleep(50);
    }
  }
  // 加载中的遮罩（表格刷新时的 loading 层、骨架屏）
  const LOADING = /loading|spin|mask|skeleton|busy|progress/i;
  function loadingCover(h, el) {
    for (let n = h, k = 0; n && n.nodeType === 1 && k < 4; n = n.parentElement, k++) {
      if (n.getAttribute('aria-busy') === 'true') return true;
      // 包着目标的容器上的类名一直都在（ant-spin-container），只认盖在目标上面的那层
      if (!covers(n, el) && LOADING.test(typeof n.className === 'string' ? n.className : '')) return true;
    }
    return false;
  }
  const detached = () => Object.assign(new Error('要操作的元素被页面重新渲染掉了'), { detached: true });
  async function pointFor(el, pos, wait) {
    // 已经完整显示在视口里就不滚动：有的下拉、日历一滚动就关闭或重新定位
    const fullyIn = () => { const r = rectOf(el); return r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth; };
    let scrolled = !fullyIn();
    if (scrolled) el.scrollIntoView({ block: 'center', inline: 'center' });
    await settle(el);
    let end = Date.now() + (wait == null ? 1500 : wait);
    const hardEnd = Date.now() + Math.max(CONFIG.findTimeout || 10000, wait || 0);
    for (;;) {
      checkCancel();
      if (!el.isConnected) throw detached();
      const r = rectOf(el);
      if (r.width >= 1 && r.height >= 1) {
        const fr = pos ? [pos] : [[0.5, 0.5], [0.3, 0.5], [0.7, 0.5], [0.5, 0.3], [0.5, 0.7], [0.12, 0.5], [0.88, 0.5]];
        // 折成多行的行内元素（链接文字换行）：外框中心可能落在两行之间，先试每一行的中心
        const rects = pos ? [] : [...el.getClientRects()].filter((q) => q.width >= 1 && q.height >= 1).map((q) => rectOf(el, q));
        const pts = (rects.length > 1 ? rects.map((q) => [q.left + q.width / 2, q.top + q.height / 2]) : [])
          .concat(fr.map(([fx, fy]) => [r.left + r.width * fx, r.top + r.height * fy]));
        for (const [x, y] of pts) {
          if (x >= 0 && y >= 0 && x <= innerWidth && y <= innerHeight && covers(el, deepHit(x, y))) return { x, y };
        }
        const hc = deepHit(r.left + r.width / 2, r.top + r.height / 2);
        // 被顶部固定栏之类挡住：没滚过就滚到中间再试
        if (!scrolled && Date.now() > end - 1000) { scrolled = true; el.scrollIntoView({ block: 'center', inline: 'center' }); await settle(el); continue; }
        // 被加载遮罩挡着：一直等到加载完（最长等到找元素的超时）
        if (Date.now() > end && hc && loadingCover(hc, el) && Date.now() < hardEnd) end = Date.now() + 500;
        if (Date.now() > end) {
          // 挡住它的是紧挨着它的、不可点的东西（控件自带的透明点击层、图标）：照样点中间，用户当时点到的也是它。
          // 其他情况（弹窗、遮罩挡着）不点，交给调用方处理
          const x = r.left + r.width / 2;
          const y = r.top + r.height / 2;
          const h = deepHit(x, y);
          const p = el.parentElement;
          let clickable = false;
          for (let n = h; n && n !== p; n = n.parentElement) if (n.matches(INTERACTIVE) || n.isContentEditable) clickable = true;
          const ok = h && p && p !== el.ownerDocument.body && p !== el.ownerDocument.documentElement && p.contains(h) && !clickable;
          return ok ? { x, y } : null;
        }
      } else if (Date.now() > end) return null;
      await sleep(100);
    }
  }
  function synthClick(el, type, button) {
    const r = el.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, composed: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button };
    const po = Object.assign({ pointerId: 1, pointerType: 'mouse', isPrimary: true }, o);
    const one = (detail) => {
      el.dispatchEvent(new PointerEvent('pointerover', po));
      el.dispatchEvent(new MouseEvent('mouseover', o));
      el.dispatchEvent(new PointerEvent('pointerdown', po));
      el.dispatchEvent(new MouseEvent('mousedown', Object.assign({ buttons: button === 2 ? 2 : 1, detail }, o)));
      if (typeof el.focus === 'function') el.focus({ preventScroll: true });
      el.dispatchEvent(new PointerEvent('pointerup', po));
      el.dispatchEvent(new MouseEvent('mouseup', Object.assign({ detail }, o)));
      if (button === 2) return;
      if (detail === 1 && typeof el.click === 'function') el.click();
      else el.dispatchEvent(new MouseEvent('click', Object.assign({ detail }, o)));
    };
    one(1);
    if (button === 2) el.dispatchEvent(new MouseEvent('contextmenu', o));
    if (type === 'dblclick') { one(2); el.dispatchEvent(new MouseEvent('dblclick', Object.assign({ detail: 2 }, o))); }
  }
  // 暂时禁用的按钮（数据加载中灰掉的“搜索”“确定”）：录制时用户点的时候它是能点的，等它恢复
  const disabledNow = (el) => !!(el.disabled || el.getAttribute('aria-disabled') === 'true' || (el.closest && el.closest('fieldset[disabled]'))
    || /(^|[-_\s])(is-)?disabled($|[-_\s])/i.test(typeof el.className === 'string' ? el.className : ''));
  async function waitEnabled(el, s) {
    const end = Date.now() + 5000;
    while (disabledNow(el) && Date.now() < end) { checkCancel(); await sleep(150); }
    if (disabledNow(el)) warn(`${(s && s.desc) || '点击'}：元素一直是禁用状态，照样点了`);
  }
  async function doClick(el, s) {
    s = s || {};
    const type = s.type === 'dblclick' ? 'dblclick' : 'click';
    const button = s.type === 'contextmenu' ? 2 : 0;
    await waitEnabled(el, s);
    highlight(el);
    const ok = await tryReal(async () => {
      const p = await pointFor(el, s.pos);
      if (!p) throw new Error('元素被遮住或不在可视区域');
      await realInput({ type, button, x: p.x, y: p.y, dialogs: s.dialogs });
    }, s.desc || '点击');
    if (ok) return;
    if (!el.isConnected) throw detached(); // 模拟事件发给已经不在页面上的元素等于没点
    el.scrollIntoView({ block: 'center', inline: 'center' });
    await sleep(60);
    dialogPlan = (s.dialogs || []).slice();
    synthClick(el, type, button);
  }
  function setNativeValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value); else el.value = value;
  }
  const valueOf = (el) => (el.isContentEditable && !('value' in el) ? el.innerText : el.value);
  // 能真实键入的输入框（日期、颜色、滑块这类浏览器自带控件直接赋值）
  const typable = (el) => !el.readOnly && !el.disabled && (el.isContentEditable || el.tagName === 'TEXTAREA'
    || (el.tagName === 'INPUT' && !/^(date|datetime-local|month|week|time|color|range|file|hidden)$/i.test(el.type)));
  function selectAllIn(el) {
    try {
      if (el.isContentEditable && !('value' in el)) {
        const r = el.ownerDocument.createRange();
        r.selectNodeContents(el);
        const sel = el.ownerDocument.defaultView.getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
      } else if (typeof el.select === 'function') el.select();
    } catch (e) { /* 部分类型不支持选中 */ }
  }
  // 浏览器自带的日期、时间框要的标准格式：date=YYYY-MM-DD、datetime-local=YYYY-MM-DDTHH:mm、month=YYYY-MM、time=HH:mm、week=YYYY-Www
  function nativeFormat(type, value, order) {
    const pad = (n) => String(n).padStart(2, '0');
    const v = String(value == null ? '' : value).trim();
    if (!v) return '';
    if (type === 'week') return /^\d{4}-W\d{2}$/.test(v) ? v : null;
    if (type === 'time') { const m = v.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/); return m ? `${pad(m[1])}:${m[2]}${m[3] && m[3] !== '00' ? ':' + m[3] : ''}` : null; }
    const d = parseDate(v, order);
    if (!d) return null;
    if (type === 'month') return `${d.y}-${pad(d.m)}`;
    if (d.d == null) return null;
    const day = `${d.y}-${pad(d.m)}-${pad(d.d)}`;
    if (type === 'date') return day;
    const t = d.time || { H: 0, i: 0, s: 0 };
    return `${day}T${pad(t.H)}:${pad(t.i)}${t.s ? ':' + pad(t.s) : ''}`;
  }
  async function setNative(el, value, order) {
    const type = el.type.toLowerCase();
    const v = nativeFormat(type, value, order);
    if (v === null) throw new Error(`「${value}」不是 ${type} 框能用的值（${type === 'date' ? 'YYYY-MM-DD' : type === 'month' ? 'YYYY-MM' : type === 'time' ? 'HH:mm' : type === 'week' ? 'YYYY-Www' : 'YYYY-MM-DD HH:mm'}）`);
    await setDirect(el, v);
    if (el.value !== v) throw new Error(`没能把 ${type} 框设置成 ${v}（框里是「${el.value}」）`);
  }
  // 真正拿到焦点的元素（穿透 Shadow DOM、同源 iframe）
  function activeDeep() {
    let a = document.activeElement;
    for (let k = 0; k < 8 && a; k++) {
      if (a.shadowRoot && a.shadowRoot.activeElement) { a = a.shadowRoot.activeElement; continue; }
      if (/^(IFRAME|FRAME)$/.test(a.tagName)) { let d = null; try { d = a.contentDocument; } catch (e) { d = null; } if (d && d.activeElement) { a = d.activeElement; continue; } }
      break;
    }
    return a;
  }
  function focusEl(el) {
    const w = el.ownerDocument && el.ownerDocument.defaultView;
    if (w && w !== window) { try { w.focus(); } catch (e) { /* ignore */ } }
    if (typeof el.focus === 'function') el.focus({ preventScroll: true });
    return activeDeep() === el || el.contains(activeDeep());
  }
  async function doFill(el, value) {
    value = value == null ? '' : String(value);
    el.scrollIntoView({ block: 'center' });
    highlight(el);
    // 浏览器自带的日期、时间框：换成它要的标准格式直接赋值，再核对（格式不对浏览器会清空）
    if (el.tagName === 'INPUT' && /^(date|datetime-local|month|week|time)$/i.test(el.type)) return setNative(el, value);
    // 真实键入：选中原内容后逐字输入，keydown / input / keyup 都是浏览器真实产生的。
    // 先确认焦点真的在它上面：目标还没显示、被别的元素抢着焦点时，键盘输入会打进别的输入框
    if (typable(el)) {
      const ok = await tryReal(async () => {
        if (!focusEl(el)) return false;
        selectAllIn(el);
        if (value) await realInput({ type: 'text', text: value });
        else if (valueOf(el)) await realInput({ type: 'key', key: 'Backspace' });
        await sleep(30);
        if (value && !valueOf(el)) return false; // 没打进去（输入框拦掉了键盘），下面直接赋值
      }, '输入');
      if (ok) return;
    }
    focusEl(el);
    if (el.isContentEditable && !('value' in el)) {
      const sel = el.ownerDocument.defaultView.getSelection();
      sel.selectAllChildren(el);
      if (!el.ownerDocument.execCommand('insertText', false, value)) {
        el.textContent = value;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
      }
      return;
    }
    if (CONFIG.typing) {
      setNativeValue(el, '');
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
      for (let i = 1; i <= value.length; i++) {
        checkCancel();
        const ch = value[i - 1];
        el.dispatchEvent(keyEvent('keydown', ch));
        setNativeValue(el, value.slice(0, i));
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ch }));
        el.dispatchEvent(keyEvent('keyup', ch));
        await sleep(CONFIG.typingDelay);
      }
    } else {
      setNativeValue(el, value);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
      // 很多页面靠 keyup 触发搜索/刷新列表（比如马帮的筛选框），一次性填值也补一个 keyup
      if (value) el.dispatchEvent(keyEvent('keyup', value[value.length - 1]));
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  // 键盘事件：keyCode / which / charCode 不能在构造时设置（浏览器固定为 0），
  // 而 jQuery 等老代码靠 event.keyCode == 13 判断回车，所以在事件对象上补上这几个值
  const KEY_CODES = { Enter: 13, Escape: 27, Tab: 9, Backspace: 8, Delete: 46, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Home: 36, End: 35, PageUp: 33, PageDown: 34, ' ': 32 };
  function keyEvent(type, key, extra) {
    const code = KEY_CODES[key] || (key && key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
    const ev = new KeyboardEvent(type, Object.assign({ key, bubbles: true, cancelable: true, composed: true }, extra));
    const charCode = type === 'keypress' ? (key === 'Enter' ? 13 : key && key.length === 1 ? key.charCodeAt(0) : 0) : 0;
    try {
      Object.defineProperty(ev, 'keyCode', { get: () => (type === 'keypress' ? charCode : code) });
      Object.defineProperty(ev, 'which', { get: () => (type === 'keypress' ? charCode : code) });
      Object.defineProperty(ev, 'charCode', { get: () => charCode });
    } catch (e) { /* ignore */ }
    return ev;
  }
  // 下拉框：参数可以填选项的值，也可以填选项上显示的文字
  function optionFor(el, v) {
    const opts = [...el.options];
    return opts.find((o) => o.value === String(v)) || opts.find((o) => norm(o.text) === norm(v)) || null;
  }
  async function doSelect(el, value) {
    highlight(el);
    el.focus();
    if (el.multiple && Array.isArray(value)) {
      const want = value.map((v) => optionFor(el, v));
      const miss = value.filter((v, i) => !want[i]);
      if (miss.length) throw new Error(`下拉框里没有选项：${miss.join('、')}（可选：${[...el.options].slice(0, 20).map((x) => norm(x.text)).join('、')}）`);
      [...el.options].forEach((o) => { o.selected = want.includes(o); });
    } else {
      const o = optionFor(el, Array.isArray(value) ? value[0] : value);
      if (!o) throw new Error(`下拉框里没有选项「${value}」（可选：${[...el.options].slice(0, 20).map((x) => norm(x.text)).join('、')}）`);
      if (selectmenuPick(el, o)) return;
      setNativeValue(el, o.value);
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    // Chosen 这类把原生下拉框藏起来、自己画界面的插件，要通知它刷新显示
    try { if (window.jQuery && window.jQuery(el).data('chosen')) window.jQuery(el).trigger('chosen:updated'); } catch (e) { /* ignore */ }
    try { if (window.layui && window.layui.form && el.closest('.layui-form')) window.layui.form.render('select'); } catch (e) { /* ignore */ }
  }
  // jQuery UI selectmenu：页面的回调挂在组件的 change 上（原生 change 不会触发它），用组件自己的选择
  function selectmenuPick(el, o) {
    const $ = window.jQuery;
    try {
      if (!$ || !$(el).data('ui-selectmenu')) return false;
      $(el).selectmenu('refresh');
      const inst = $(el).selectmenu('instance');
      const item = (inst.items || []).find((x) => x && x.index === o.index);
      if (!item) return false;
      inst._select(item, $.Event('click'));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    } catch (e) { return false; }
  }
  // 单选：在录到的那个单选框的同组里，按值或显示文字找要选的那个；组里没有就报错（只接受已有的选项）
  function radioFor(el, value, s) {
    const text = (r) => norm([...(r.labels || [])].map((l) => l.textContent).join(' ')) || r.value;
    const group = el.name ? [...el.getRootNode().querySelectorAll('input[type=radio]')].filter((r) => r.name === el.name && r.form === el.form) : [el];
    const want = String(value == null ? '' : value);
    const hit = group.find((r) => r.value === want) || group.find((r) => text(r) === norm(want));
    if (!hit) throw new Error(`${s.desc}：单选项里没有「${want}」（可选：${group.map(text).join('、')}）`);
    return hit;
  }
  async function doCheck(el, checked, s) {
    if (el.checked === checked) return;
    // 自定义样式的复选框常把 input 藏起来，点它的 label（用户看到、点到的那个）
    const target = visible(el) ? el : [...(el.labels || [])].find(visible);
    if (target) await doClick(target, Object.assign({}, s, { type: 'click' }));
    else el.click();
    await sleep(50);
    if (el.checked !== checked) {
      el.checked = checked;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }
  function tabbables() {
    return qsa('a[href],button,input,select,textarea,[tabindex],[contenteditable=""],[contenteditable=true]')
      .filter((e) => !e.disabled && e.tabIndex >= 0 && visible(e));
  }
  async function doPress(el, s) {
    el = el || document.activeElement || document.body;
    highlight(el);
    const ok = await tryReal(async () => {
      if (el !== document.activeElement && typeof el.focus === 'function') el.focus();
      await realInput({ type: 'key', key: s.key, mods: { ctrl: s.ctrl, meta: s.meta, shift: s.shift, alt: s.alt }, dialogs: s.dialogs });
    }, '按键');
    if (ok) return;
    dialogPlan = (s.dialogs || []).slice();
    const o = { code: s.key, ctrlKey: !!s.ctrl, metaKey: !!s.meta, shiftKey: !!s.shift, altKey: !!s.alt };
    const down = el.dispatchEvent(keyEvent('keydown', s.key, o));
    if (s.key === 'Enter') el.dispatchEvent(keyEvent('keypress', s.key, o));
    el.dispatchEvent(keyEvent('keyup', s.key, o));
    if (!down) return;
    // 模拟浏览器的默认行为：回车提交表单、Tab 移动焦点（录制时记下了焦点落到哪里）
    if (s.key === 'Enter' && el.tagName === 'INPUT' && el.form && !s.ctrl && !s.meta) {
      if (el.form.requestSubmit) el.form.requestSubmit(); else el.form.submit();
    }
    if (s.key === 'Tab') {
      const next = s.to ? locate(s.to, false) : null;
      const list = tabbables();
      const i = list.indexOf(el);
      const to = next || list[s.shift ? i - 1 : i + 1];
      if (to) to.focus();
    }
  }
  // 容器滚动（表格、虚拟列表）：直接设滚动位置；组件自己处理滚轮、设了不动的，用真实滚轮滚过去
  async function doScroll(s) {
    if (!s.target) {
      window.scrollTo({ left: s.x, top: s.y, behavior: 'instant' });
      await sleep(300);
      return;
    }
    const el = await find(s.target, false);
    const x0 = el.scrollLeft;
    const y0 = el.scrollTop;
    el.scrollTo({ left: s.x, top: s.y, behavior: 'instant' });
    await sleep(120);
    if (el.scrollLeft === x0 && el.scrollTop === y0 && (s.x !== x0 || s.y !== y0)) {
      await tryReal(async () => {
        const p = await pointFor(el, null, 300);
        if (!p) return false;
        await realInput({ type: 'wheel', x: p.x, y: p.y, dx: s.x - x0, dy: s.y - y0 });
      }, '滚动');
    }
    await sleep(400);
  }
  // 上传：参数里给本机文件路径（多个用 | 分隔），由扩展通过调试接口设进文件框
  let uploadSeq = 0;
  async function doUpload(el, s, i) {
    const files = String(fillTpl(s.value) || '').split('|').map((x) => x.trim()).filter(Boolean);
    if (!files.length) {
      if (s.optional) return;
      throw new Error(`第 ${i + 1} 步要上传文件（录制时是 ${(s.files || []).join(', ') || '文件'}），请在参数「${s.param || '上传文件'}」里填本机文件的完整路径`);
    }
    if (!REAL) throw new Error('上传文件需要扩展的真实输入回放（导出的控制台脚本不能上传）');
    // 从桌面拖文件进上传区：用调试接口把文件拖到它上面
    if (s.drop) {
      const p = await pointFor(el, null);
      if (!p) throw new Error('上传区被遮住或不在可视区域');
      await realInput({ type: 'dropFiles', x: p.x, y: p.y, files });
      return;
    }
    // 不是文件框本身（点“上传”按钮、页面临时建一个没挂到页面上的文件框）：点按钮，拦下选文件对话框，把文件设进去
    if (s.chooser || !(el.tagName === 'INPUT' && el.type === 'file')) {
      const p = await pointFor(el, null);
      if (!p) throw new Error('上传按钮被遮住或不在可视区域');
      await realInput({ type: 'chooser', x: p.x, y: p.y, files });
      return;
    }
    const mark = 'up' + (++uploadSeq) + Date.now().toString(36);
    el.setAttribute('data-pr-upload', mark);
    try { await realInput({ type: 'files', mark, files }); } finally { el.removeAttribute('data-pr-upload'); }
    if (!el.files || !el.files.length) throw new Error('文件没有设置进上传框');
  }
  // 拖动：从起点元素拖到终点元素（找不到终点就按录制时的位移）
  async function doDrag(el, s) {
    const p = await pointFor(el, s.pos);
    if (!p) throw new Error('拖动的起点被遮住或不在可视区域');
    let q = null;
    const toEl = s.to ? locate(s.to, false) : null;
    if (toEl) {
      const r = toEl.getBoundingClientRect();
      const tp = s.toPos || [0.5, 0.5];
      q = { x: r.left + r.width * tp[0], y: r.top + r.height * tp[1] };
    } else q = { x: p.x + (s.dx || 0), y: p.y + (s.dy || 0) };
    const ok = await tryReal(() => realInput({ type: 'drag', x: p.x, y: p.y, tx: q.x, ty: q.y }), '拖动');
    if (ok) return;
    // 原生拖放（draggable）：派发 dragstart → dragenter → dragover → drop → dragend，共用一个 DataTransfer
    if (s.html5 && typeof DragEvent !== 'undefined') {
      const dt = typeof DataTransfer !== 'undefined' ? new DataTransfer() : null;
      const target = toEl || deepHit(q.x, q.y) || document.body;
      const de = (type, at, x, y) => at.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, dataTransfer: dt }));
      de('dragstart', el, p.x, p.y);
      de('dragenter', target, q.x, q.y);
      de('dragover', target, q.x, q.y);
      de('drop', target, q.x, q.y);
      de('dragend', el, q.x, q.y);
      return;
    }
    const o = (x, y, extra) => Object.assign({ bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, button: 0 }, extra);
    el.dispatchEvent(new PointerEvent('pointerdown', o(p.x, p.y, { pointerId: 1, pointerType: 'mouse', isPrimary: true, buttons: 1 })));
    el.dispatchEvent(new MouseEvent('mousedown', o(p.x, p.y, { buttons: 1 })));
    for (let k = 1; k <= 8; k++) {
      const x = p.x + (q.x - p.x) * k / 8;
      const y = p.y + (q.y - p.y) * k / 8;
      const h = deepHit(x, y) || document;
      h.dispatchEvent(new PointerEvent('pointermove', o(x, y, { pointerId: 1, pointerType: 'mouse', isPrimary: true, buttons: 1 })));
      h.dispatchEvent(new MouseEvent('mousemove', o(x, y, { buttons: 1 })));
      await sleep(16);
    }
    const h = deepHit(q.x, q.y) || document;
    h.dispatchEvent(new PointerEvent('pointerup', o(q.x, q.y, { pointerId: 1, pointerType: 'mouse', isPrimary: true })));
    h.dispatchEvent(new MouseEvent('mouseup', o(q.x, q.y)));
  }
  // ---------- 值类控件：日期、下拉选择 ----------
  // 录制时用户在面板里点选出来的值（日期、下拉组件），回放时按值去设置：参数改了也能设对
  const CN_MONTH = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12 };
  const EN_MONTH = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  // 只认年月日，不做时区换算（避免差一天）。年份在后的写法（11/10/2026）按 order（MDY / DMY）读：
  // 录制时学到的顺序；没学到时数字超过 12 的是日，两个都不超过 12 又不相等就分不清（ambiguous）
  const okYMD = (y, m, d) => m >= 1 && m <= 12 && d >= 1 && d <= 31;
  function parseDates(v, order) {
    const t = String(v == null ? '' : v);
    const out = [];
    const c = t.trim().match(/^(\d{4})(\d{2})(\d{2})$/);
    if (c) { if (okYMD(+c[1], +c[2], +c[3])) out.push({ y: +c[1], m: +c[2], d: +c[3], time: null }); return out; }
    const re = /(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})日?|(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/g;
    let m;
    while ((m = re.exec(t))) {
      const tm = t.slice(m.index + m[0].length).match(/^[\sT,]*(\d{1,2}):(\d{2})(?::(\d{2}))?/);
      const time = tm ? { H: +tm[1], i: +tm[2], s: +(tm[3] || 0) } : null;
      if (m[1]) { if (okYMD(+m[1], +m[2], +m[3])) out.push({ y: +m[1], m: +m[2], d: +m[3], time }); continue; }
      const a = +m[4];
      const b = +m[5];
      let mo;
      let da;
      if (order === 'DMY' || (!order && a > 12)) { mo = b; da = a; } else if (order === 'MDY' || (!order && (b > 12 || a === b))) { mo = a; da = b; } else { out.ambiguous = true; continue; }
      if (okYMD(+m[6], mo, da)) out.push({ y: +m[6], m: mo, d: da, time });
    }
    if (out.length === 1 && !out[0].time) {
      const tm = t.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
      if (tm) out[0].time = { H: +tm[1], i: +tm[2], s: +(tm[3] || 0) };
    }
    return out;
  }
  function parseDate(v, order) {
    const all = parseDates(v, order);
    if (all.length) return all[0];
    const m = String(v || '').match(/(\d{4})\s*[-/.年]\s*(\d{1,2})(?!\d)/);
    if (m) return { y: +m[1], m: +m[2], d: null };
    return null;
  }
  // 框里的值是不是目标日期；参数里带了时间的，时间也要一致。order：框里年份在后的写法怎么读
  function hasDate(text, want, order) {
    for (const x of parseDates(text, order || 'MDY')) {
      if (x.y !== want.y || x.m !== want.m || (want.d != null && x.d !== want.d)) continue;
      if (want.time && (!x.time || x.time.H !== want.time.H || x.time.i !== want.time.i || x.time.s !== want.time.s)) continue;
      return true;
    }
    if (!order) for (const x of parseDates(text, 'DMY')) if (x.y === want.y && x.m === want.m && (want.d == null || x.d === want.d) && (!want.time || (x.time && x.time.H === want.time.H && x.time.i === want.time.i && x.time.s === want.time.s))) return true;
    return false;
  }
  function parseYM(t) {
    let m = t.match(/(\d{4})\s*年\s*(\d{1,2})\s*月/);
    if (m) return { y: +m[1], m: +m[2] };
    m = t.match(/(\d{4})\s*年\s*([一二三四五六七八九十]{1,3})\s*月/);
    if (m && CN_MONTH[m[2]]) return { y: +m[1], m: CN_MONTH[m[2]] };
    m = t.match(/(\d{1,2})\s*月\s*,?\s*(\d{4})/);
    if (m) return { y: +m[2], m: +m[1] };
    m = t.match(/(\d{4})\s*[-/.]\s*(\d{1,2})(?!\d)/);
    if (m && +m[2] >= 1 && +m[2] <= 12) return { y: +m[1], m: +m[2] };
    m = t.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*,?\s*(\d{4})/i);
    if (m) return { y: +m[2], m: EN_MONTH.indexOf(m[1].toLowerCase()) + 1 };
    m = t.match(/(\d{4})\s*,?\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i);
    if (m) return { y: +m[1], m: EN_MONTH.indexOf(m[2].toLowerCase()) + 1 };
    // 年、月分开显示（“2026年” “11月” / “十一月”）
    const y = t.match(/(\d{4})\s*年?/);
    const mm = t.match(/(?:^|\D)(\d{1,2})\s*月/) || t.match(/([一二三四五六七八九十]{1,3})\s*月/);
    if (y && mm) { const mv = /\d/.test(mm[1]) ? +mm[1] : CN_MONTH[mm[1]]; if (mv >= 1 && mv <= 12) return { y: +y[1], m: mv }; }
    return null;
  }
  // 页面和里面所有打开的 Shadow DOM（日历面板、下拉选项挂在 Web Components 里的）；半秒内复用
  let rootsCache = null;
  function deepRoots() {
    if (rootsCache && Date.now() - rootsCache.t < 500) return rootsCache.list;
    const list = [document];
    for (let i = 0; i < list.length && list.length < 200; i++) {
      for (const e of list[i].querySelectorAll('*')) if (e.shadowRoot) list.push(e.shadowRoot);
    }
    rootsCache = { t: Date.now(), list };
    return list;
  }
  // 日历网格：可见的、文字是 1～31 的最里层格子，按它们共同的祖先归组；
  // 只有里面能连出 1,2,3…28 以上这样一串的才算（排除表格里的数量列）
  function calendarGrids() {
    const cells = [];
    for (const c of qsa('td,th,button,a,span,div,li,em,i,b', deepRoots())) {
      if (c.childElementCount > 3) continue; // 先粗筛：日期格子很小，取 textContent 前排除大块容器（大表格页面上很慢）
      const t = c.textContent.trim();
      if (!/^\d{1,2}$/.test(t) || +t < 1 || +t > 31) continue;
      if (c.firstElementChild && /^\d{1,2}$/.test(c.firstElementChild.textContent.trim())) continue; // 取最里层
      if (!visible(c)) continue;
      cells.push(c);
    }
    const count = new Map();
    for (const c of cells) for (let a = c.parentElement, k = 0; a && k < 6; a = a.parentElement, k++) count.set(a, (count.get(a) || 0) + 1);
    const grids = new Set();
    for (const c of cells) for (let a = c.parentElement, k = 0; a && k < 6; a = a.parentElement, k++) if (count.get(a) >= 28) { grids.add(a); break; }
    const out = [];
    for (const g of grids) {
      const gc = cells.filter((c) => g.contains(c));
      const nums = gc.map((c) => +c.textContent.trim());
      let start = -1;
      let len = 0;
      for (let i = 0; i < nums.length; i++) {
        if (nums[i] !== 1) continue;
        let j = i;
        while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
        if (j - i + 1 > len) { len = j - i + 1; start = i; }
      }
      if (len >= 28) out.push({ grid: g, days: gc.slice(start, start + len) });
    }
    return out;
  }
  function textOutside(container, grid) {
    let out = '';
    const walk = (n) => {
      if (n === grid) return;
      if (n.nodeType === 3) { out += n.nodeValue + ' '; return; }
      if (n.nodeType !== 1) return;
      if (n.tagName === 'SELECT') { out += (n.selectedOptions[0] ? n.selectedOptions[0].text : '') + ' '; return; }
      // 年份在输入框里的（flatpickr 的 cur-year）
      if (n.tagName === 'INPUT') { if (n.type !== 'hidden' && n.value) out += n.value + ' '; return; }
      if (n.tagName === 'SCRIPT' || n.tagName === 'STYLE') return;
      for (const c of n.childNodes) walk(c);
    };
    walk(container);
    return out;
  }
  // 网格对应的年月：往上找，第一个“网格之外的文字”里能读出年月的祖先就是它的面板
  function gridInfo(g) {
    for (let a = g.grid.parentElement, k = 0; a && k < 6; a = a.parentElement, k++) {
      let ym = parseYM(textOutside(a, g.grid));
      // 两个月并排、标题都在一个公共的头部里（Fusion RangePicker）：用水平位置离这个网格最近的那个年月标题
      if (ym && a.querySelectorAll('table,[role=grid]').length > 1) {
        const gr = g.grid.getBoundingClientRect(), cx = gr.left + gr.width / 2;
        const heads = [...a.querySelectorAll('*')].filter((e) => !e.querySelector('table,[role=grid]') && !e.closest('table,[role=grid]') && visible(e) && parseYM(norm(e.textContent)) && ![...e.children].some((c) => parseYM(norm(c.textContent))));
        const best = heads.sort((x, y) => { const rx = x.getBoundingClientRect(), ry = y.getBoundingClientRect(); return Math.abs(rx.left + rx.width / 2 - cx) - Math.abs(ry.left + ry.width / 2 - cx); })[0];
        if (best) ym = parseYM(norm(best.textContent));
      }
      if (ym) return Object.assign(g, { ym, panel: a });
    }
    return null;
  }
  const NAV_CLASS = (e) => `${(typeof e.className === 'string' ? e.className : (e.className && e.className.baseVal) || '').replace(/(^|\s)next-/g, '$1')} ${e.getAttribute('aria-label') || ''} ${e.getAttribute('title') || ''} ${norm(e.textContent)}`;
  // ownOnly：只看这个日历自己宽度以内的按钮（判断它是不是自己能前后翻页）
  function navButtons(panel, grid, ownOnly) {
    const out = { prevM: null, nextM: null, prevY: null, nextY: null };
    const gr = grid.getBoundingClientRect();
    const found = [...panel.querySelectorAll('button,a,span,i,div,[role=button]')].filter((e) => !grid.contains(e) && visible(e) && norm(e.textContent).length <= 2 && e.getBoundingClientRect().bottom <= gr.top + 2);
    // 装着两个以上按钮的外框（“左边一组”“右边一组”）不是按钮：点它的中心会落在两个按钮之间
    const all = found.filter((e) => found.filter((o) => o !== e && e.contains(o) && !found.some((x) => x !== o && x !== e && e.contains(x) && x.contains(o))).length < 2);
    // 双面板各自翻页（开始、结束各一个面板）：先在这个日历自己的横向范围里找；
    // 两个面板联动、每边只有一个方向按钮的（Ant Design），缺的方向再到整个面板里找
    // 按钮中心落在这个日历自己的宽度以内才算它的（相邻面板的按钮挨得再近也不算）
    const inX = (e) => { const r = e.getBoundingClientRect(); const cx = r.left + r.width / 2; return cx >= gr.left - 4 && cx <= gr.right + 4; };
    const own = all.filter(inX);
    for (const cands of ownOnly ? [own] : [own, all]) {
      for (const e of cands) {
        const sig = NAV_CLASS(e);
        const year = /super|double|fast|year|上一?年|下一?年|«|»|[-_]y(\s|$)/i.test(sig);
        if (/prev|previous|left|上一|上个|«|‹|^\s*<\s*$/i.test(sig)) { if (year) out.prevY = out.prevY || e; else out.prevM = out.prevM || e; }
        else if (/next|right|下一|下个|»|›|^\s*>\s*$/i.test(sig)) { if (year) out.nextY = out.nextY || e; else out.nextM = out.nextM || e; }
      }
    }
    // 没有可辨认的名字：按位置，头部左边的是“上”，右边的是“下”，外侧的是年、内侧的是月
    if (!out.prevM && !out.nextM) {
      const mid = gr.left + gr.width / 2;
      const icons = (own.length || ownOnly ? own : all).filter((e) => !norm(e.textContent) || /^[<>‹›«»]$/.test(norm(e.textContent))).map((e) => ({ e, x: e.getBoundingClientRect().left }));
      const left = icons.filter((o) => o.x < mid).sort((a, b) => a.x - b.x);
      const right = icons.filter((o) => o.x >= mid).sort((a, b) => b.x - a.x);
      if (left.length) { out.prevM = left[left.length - 1].e; if (left.length > 1) out.prevY = left[0].e; }
      if (right.length) { out.nextM = right[right.length - 1].e; if (right.length > 1) out.nextY = right[0].e; }
    }
    return out;
  }
  // 离输入框最近的、有年月的日历面板
  function nearestCalendar(el, avoid) {
    const r = el.getBoundingClientRect();
    const list = calendarGrids().map(gridInfo).filter((g) => g && !(avoid && avoid.has(g.grid)));
    const dist = (g) => { const q = g.grid.getBoundingClientRect(); return Math.hypot(q.left - r.left, q.top - r.bottom); };
    return list.sort((a, b) => dist(a) - dist(b));
  }
  const offDay = (c) => {
    for (let n = c, k = 0; n && k < 3; n = n.parentElement, k++) {
      const sig = `${typeof n.className === 'string' ? n.className : ''}`;
      if (/disabled|disable(?!d)/i.test(sig) || n.getAttribute('aria-disabled') === 'true' || n.disabled) return true;
    }
    return false;
  };
  // 日历面板的弹出层根节点（绝对/固定定位的最外层），翻页后网格会重新渲染，按这个根找
  // 日历的弹出层：往上第一个绝对/固定定位、和日历差不多大的祖先（双月面板约两倍宽）；
  // 碰到对话框、抽屉就停（日历在弹窗里时不能把整个弹窗当成日历面板）
  const DIALOG = /modal|dialog|drawer/i;
  function popupRoot(grid) {
    const g = grid.getBoundingClientRect();
    const fits = (n) => { const r = n.getBoundingClientRect(); return r.width <= g.width * 3 + 40 && r.height <= g.height * 2.5 + 120; };
    let last = grid;
    for (let n = grid.parentElement, k = 0; n && n !== document.body && k < 12 && fits(n); n = n.parentElement, k++) {
      if (n.matches('[role=dialog],[role=alertdialog],[aria-modal=true],dialog') || (typeof n.className === 'string' && DIALOG.test(n.className))) break;
      last = n;
      const p = getComputedStyle(n).position;
      if (p === 'absolute' || p === 'fixed') return n;
    }
    return last;
  }
  // 这个日期框是区间的开始还是结束：同一次选出来的两个日期按先后；只改了其中一个的，看它是同一个控件里两个框中的第几个
  function rangeRole(el, s) {
    if (s.rangeStart) return 'start';
    if (s.rangeEnd) return 'end';
    for (let n = el.parentElement, k = 0; n && k < 6; n = n.parentElement, k++) {
      const ins = [...n.querySelectorAll('input')].filter((i) => i.type !== 'hidden' && visible(i));
      if (ins.length === 2 && ins.includes(el)) return ins[0] === el ? 'start' : 'end';
      if (ins.length > 2) break;
    }
    return null;
  }
  // 只认属于这个日期框的面板：点开它之后新出现的；区间的结束日期沿用开始日期打开的那个面板
  const rangePanels = new Map(); // 区间：开始日期打开的面板和开始框，结束日期沿用、选完一起核对
  // 只显示、不能编辑的日期选择（shineout 的 DatePicker 没有输入框）看它显示的文字
  const dateVal = (el) => (valueOf(el) !== undefined ? valueOf(el) : shownText(el));
  async function calendarPick(el, want, s) {
    let root = null;
    const prev = s.rangeEnd && s.sid ? rangePanels.get(s.sid) : null;
    if (prev && prev.root && prev.root.isConnected && calendarGrids().some((g) => prev.root.contains(g.grid))) root = prev.root;
    if (!root) {
      const before = new Set(calendarGrids().map((g) => g.grid));
      await doClick(el, { desc: s.desc });
      const end = Date.now() + 2000;
      let fresh = [];
      while (!(fresh = nearestCalendar(el).filter((g) => !before.has(g.grid))).length && Date.now() < end) await sleep(150);
      if (!fresh.length) return false;
      root = popupRoot(fresh[0].grid);
    }
    if (s.rangeStart && s.sid) Object.assign(rangePanels.get(s.sid) || {}, { root });
    const mine = () => (root.isConnected ? nearestCalendar(el).filter((g) => root.contains(g.grid)) : []);
    let cals;
    const target = want.y * 12 + want.m;
    // 两个面板各管一头的区间（shineout：左边的面板选开始、右边的选结束，各有自己的前后翻页）：
    // 开始日期只在左边的面板里选、结束日期只在右边的选。两个面板联动的（Ant Design、Element）不分，哪个面板显示着目标月份就用哪个
    const role = rangeRole(el, s);
    let bound = null; // null = 还没判断
    for (let n = 0; n < 60; n++) {
      checkCancel();
      cals = mine();
      if (!cals.length) return false;
      let pool = cals;
      if (role && cals.length === 2 && bound !== false) {
        const lr = [...cals].sort((a, b) => a.grid.getBoundingClientRect().left - b.grid.getBoundingClientRect().left);
        if (bound === null) bound = lr.every((g) => { const nv = navButtons(g.panel.parentElement || g.panel, g.grid, true); return !!(nv.prevM && nv.nextM); });
        if (bound) pool = [role === 'start' ? lr[0] : lr[1]];
      }
      // 双面板（区间）：目标月份已经显示在其中一个面板里就直接用
      const shown = pool.find((g) => g.ym.y * 12 + g.ym.m === target);
      if (shown) {
        const cell = shown.days.find((c) => +c.textContent.trim() === want.d);
        if (!cell) return false;
        if (offDay(cell)) throw new Error(`日期 ${want.y}-${want.m}-${want.d} 不可选（被页面禁用）`);
        const was = dateVal(el);
        await doClick(cell, { desc: `日期 ${want.d}` });
        await sleep(250);
        // 点完框里变成了别的日期：点偏了（面板还在动画里移动等），停稳后重点一次
        const now = parseDate(dateVal(el));
        if (now && now.d != null && dateVal(el) !== was && !hasDate(dateVal(el), Object.assign({}, want, { time: null }), s.dateFmt || null)) {
          warn(`${s.desc}：点日期 ${want.d} 后框里是「${dateVal(el)}」，重点一次`);
          const again = (mine().find((g) => g.ym.y * 12 + g.ym.m === target) || {}).days;
          const c2 = again && again.find((c) => +c.textContent.trim() === want.d);
          if (c2) { await doClick(c2, { desc: `日期 ${want.d}` }); await sleep(250); }
        }
        // 需要点“确定”的（带时间的、区间的）：值还没写进去且有确定按钮就点
        // 单框区间的结束日期：框里原来的区间可能本来就含这个结束日期，开始日期也对上了才算已经写进去
        const st = s.rangeEnd && s.sid ? rangePanels.get(s.sid) : null;
        const committed = hasDate(dateVal(el), want, s.dateFmt || null) && !(st && st.el === el && st.want && !hasDate(dateVal(el), st.want, s.dateFmt || null));
        if (!committed) {
          const ok = [...shown.panel.parentElement.querySelectorAll('button,a,span')].find((b) => visible(b) && /^(确定|确认|ok|apply|应用|完成|done)$/i.test(norm(b.textContent)) && !b.disabled && !/disabled/i.test(b.className));
          const stillOpen = mine().length;
          if (ok && stillOpen && !s.rangeStart) { await doClick(ok, { desc: '确定' }); await sleep(250); }
        }
        return true;
      }
      const g = pool[0];
      const cur = g.ym.y * 12 + g.ym.m;
      const diff = target - cur;
      const nav = navButtons(g.panel.parentElement || g.panel, g.grid, !!bound);
      const btn = Math.abs(diff) >= 12 && (diff > 0 ? nav.nextY : nav.prevY) ? (diff > 0 ? nav.nextY : nav.prevY) : (diff > 0 ? nav.nextM : nav.prevM);
      // 按“各管一头”翻不过去（这一侧的面板不让翻到那个月）：退回不分面板的办法
      if (!btn) { if (bound) { bound = false; continue; } return false; }
      const gLeft = g.grid.getBoundingClientRect().left;
      await doClick(btn, { desc: diff > 0 ? '下一页' : '上一页' });
      await sleep(200);
      // 翻页后网格会重新渲染：按横向位置找回刚才那个日历
      const list = mine();
      const after = list.length ? list.reduce((a, b) => (Math.abs(b.grid.getBoundingClientRect().left - gLeft) < Math.abs(a.grid.getBoundingClientRect().left - gLeft) ? b : a)) : null;
      if (!after) return false;
      const moved = after.ym.y * 12 + after.ym.m - cur;
      if (!moved || Math.sign(moved) !== Math.sign(diff)) { // 翻不动或者方向不对：停下，交给其他办法
        if (bound) { bound = false; continue; }
        return false;
      }
    }
    return false;
  }
  const isoDate = (d) => `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
  async function setDirect(el, value) {
    setNativeValue(el, value);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  // 区间的结束日期设好后，开始日期也必须是目标值（有的组件两个日期选完才一起写进框里）
  function checkRangeStart(s) {
    const st = s.rangeEnd && s.sid ? rangePanels.get(s.sid) : null;
    if (!st || !st.want) return;
    const se = st.el && st.el.isConnected ? st.el : st.t ? locate(st.t, true) : null; // 框被重新渲染了就重新找
    if (!se) throw new Error(`${s.desc}：找不到区间的开始日期框，没法核对`);
    if (!hasDate(valueOf(se), st.want, s.dateFmt || null)) throw new Error(`${s.desc}：结束日期设好了，但开始日期没有生效（框里是「${valueOf(se)}」）`);
  }
  // 区间开始日期选了、面板还开着等结束日期
  function rangePending(s) {
    const st = s.rangeEnd && s.sid ? rangePanels.get(s.sid) : null;
    return !!(st && st.root && st.root.isConnected && calendarGrids().some((g) => st.root.contains(g.grid)));
  }
  async function pickDate(el, value, s) {
    const all = parseDates(value, s.dateFmt || null);
    if (!all.length && all.ambiguous) throw new Error(`${s.desc}：日期 ${value} 分不清哪个是月、哪个是日，请写成 YYYY-MM-DD`);
    const want = all[0] || parseDate(value, s.dateFmt || null);
    const r = await pickDateInner(el, value, s, want);
    checkRangeStart(s);
    return r;
  }
  async function pickDateInner(el, value, s, want) {
    const order = s.dateFmt || null;
    // 一个框里两个日期（layDate、daterangepicker 的单框区间）：两个都要对上
    const wantAll = want ? parseDates(value, order) : [];
    const ok = () => (wantAll.length > 1 ? wantAll.every((d) => hasDate(dateVal(el), d, order)) : want ? hasDate(dateVal(el), want, order) : dateVal(el) === value);
    // 浏览器自带的日期框：写它要的标准格式，写完核对
    if (/^(date|datetime-local|month|week|time)$/i.test(el.type || '')) return setNative(el, value, order);
    // 键入、直接写值时按框里录制时的写法（参数写成 2026-11-10，框要的是 11/10/2026）
    const typed = want ? formatLike(s.recorded, parseDates(value, order), order) || value : value;
    // jQuery UI 日期框：用它自己的 setDate（关联的隐藏字段一起更新），传日期对象免得格式对不上
    const $ = window.jQuery;
    try {
      if ($ && $.datepicker && $(el).hasClass('hasDatepicker')) {
        $(el).datepicker('setDate', want && want.d != null ? new Date(want.y, want.m - 1, want.d) : value);
        if (!want || ok() || dateVal(el) === value) {
          // setDate 不会调页面的 onSelect（用户在面板上点日期才调），页面常在那里发请求
          const onSel = $(el).datepicker('option', 'onSelect');
          if (typeof onSel === 'function') onSel.call(el, dateVal(el), $.datepicker._getInst(el));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return;
        }
      }
    } catch (e) { /* 不是 jQuery UI */ }
    // 能直接输入的：真实键入后按 Tab 离开让组件确认（不用回车，回车可能直接提交整个筛选表单）
    // layDate（lay-key）：键入的值不会触发页面的 done 回调，先走日历面板
    const panelFirst = el.hasAttribute && el.hasAttribute('lay-key');
    if (typable(el) && REAL && !panelFirst) {
      await doFill(el, typed);
      await tryReal(() => realInput({ type: 'key', key: 'Tab' }), '确认日期');
      await sleep(300);
      if (ok()) return;
    }
    // 单框区间：在同一个面板里先点开始、再点结束
    if (wantAll.length > 1 && wantAll[0].d != null && wantAll[1].d != null) {
      const sid = 'one' + Date.now();
      rangePanels.set(sid, { el, want: wantAll[0], t: s.target, root: null });
      const a = await calendarPick(el, wantAll[0], Object.assign({}, s, { sid, rangeStart: true, rangeEnd: false }));
      if (a && (await calendarPick(el, wantAll[1], Object.assign({}, s, { sid, rangeStart: false, rangeEnd: true })))) {
        await sleep(150);
        if (ok()) return;
      }
    } else if (want && want.d != null && (await calendarPick(el, want, s))) {
      // 通用日历面板：打开 → 翻到目标年月 → 点日期 → 需要的话点确定
      await sleep(150);
      if (ok()) return;
      const st = s.rangeStart && s.sid ? rangePanels.get(s.sid) : null;
      if (st && st.root && st.root.isConnected && calendarGrids().some((g) => st.root.contains(g.grid))) return; // 等结束日期选完一起核对
    }
    if (panelFirst && typable(el) && REAL) {
      await doFill(el, typed);
      await tryReal(() => realInput({ type: 'key', key: 'Tab' }), '确认日期');
      await sleep(300);
      if (ok()) return;
    }
    // 兜底：直接写值（My97、layDate 等直接读输入框值的插件）。Vue/React 管着的框直接写值不会生效，不能当成功
    if (frameworkOwned(el)) throw new Error(`${s.desc}：没能通过日历面板设置成 ${value}（面板的年月或翻页按钮没认出来）`);
    await setDirect(el, typed);
    await sleep(200);
    if (!ok()) throw new Error(`${s.desc}：没能设置成 ${value}`);
    warn(`${s.desc}：没能通过日历面板设置，已直接写入 ${typed}`);
  }
  // 按样本的写法输出日期（分隔符、补零、月日顺序、时间都照样本）：样本 11/10/2026 08:00 + 2026-09-01 → 09/01/2026 08:00
  function formatLike(sample, dates, order) {
    if (!sample || !dates || !dates.length) return '';
    const pad = (n, w) => (w >= 2 ? String(n).padStart(2, '0') : String(n));
    let k = 0;
    let any = false;
    const out = String(sample).replace(/(\d{4})(\s*[-/.年]\s*)(\d{1,2})(\s*[-/.月]\s*)(\d{1,2})|(\d{1,2})([-/.])(\d{1,2})([-/.])(\d{4})/g, (m0, y, s1, mo, s2, d, a, t1, b, t2) => {
      const x = dates[Math.min(k++, dates.length - 1)];
      any = true;
      if (y) return `${x.y}${s1}${pad(x.m, mo.length)}${s2}${pad(x.d, d.length)}`;
      return order === 'DMY' ? `${pad(x.d, a.length)}${t1}${pad(x.m, b.length)}${t2}${x.y}` : `${pad(x.m, a.length)}${t1}${pad(x.d, b.length)}${t2}${x.y}`;
    });
    if (!any) return '';
    let j = 0;
    return out.replace(/\b(\d{1,2}):(\d{2})(?::(\d{2}))?\b/g, (m0, h, mi, se) => {
      const x = dates[Math.min(j++, dates.length - 1)];
      if (!x || !x.time) return m0;
      return `${pad(x.time.H, h.length)}:${pad(x.time.i, 2)}${se !== undefined ? ':' + pad(x.time.s, 2) : ''}`;
    });
  }
  // 输入框由 Vue / React 组件管着（直接改 DOM 的值，组件里的状态不会跟着变）
  function frameworkOwned(el) {
    for (let n = el, k = 0; n && k < 6; n = n.parentElement, k++) {
      if (n.__vue__ || n.__vueParentComponent || n._vnode) return true;
      for (const key of Object.keys(n)) if (/^__(react|vue)/.test(key)) return true;
    }
    return false;
  }
  const tinyBox = (e) => { const q = e.getBoundingClientRect(); return q.width <= 1 || q.height <= 1; };
  // 选项：文字等于参数值的可见元素
  function optionCands(value, el) {
    const want = norm(value);
    if (!want) return [];
    // 先用 textContent 粗筛（不触发排版），对得上的再看 innerText 和可见性；选项也可能在 Shadow DOM 里
    return qsa('[role=option],li,dd,option,[class*=option],[class*=item],a,span,div', deepRoots()).filter((e) => {
      if (e === el || e.contains(el) || e.childElementCount > 8) return false;
      const tc = e.textContent;
      if (!tc || tc.length > want.length * 3 + 60 || !tc.replace(/\s+/g, '').includes(want.replace(/\s+/g, ''))) return false;
      return visible(e) && norm(e.innerText || tc) === want;
    });
  }
  // 只在点开之后才出现的选项里找（或者字段 aria-controls 指向的列表里），优先列表项、离字段近的
  function findOption(value, el, pre, ok) {
    const r = el.getBoundingClientRect();
    const ctl = (el.getAttribute('aria-controls') || el.getAttribute('aria-owns') || '').split(/\s+/).map((id) => id && document.getElementById(id)).filter(Boolean);
    let hits = optionCands(value, el).filter((e) => (!pre || !pre.has(e)) && (!ok || ok(e)));
    if (ctl.length) { const inCtl = hits.filter((e) => ctl.some((c) => c.contains(e))); if (inCtl.length) hits = inCtl; }
    if (!hits.length) return null;
    // 同一个选项的多层包装只留最外层的可点击元素
    const top = hits.filter((e) => !hits.some((o) => o !== e && o.contains(e) && !/^(SPAN|I|B|EM)$/.test(o.tagName)));
    // 0 大小的（antd 给读屏用的隐藏选项列表）排最后
    // 点中心点不到它的（antd 给读屏用、被裁掉的选项副本，被盖住的）排在点得到的后面
    const reach = (e) => { const q = e.getBoundingClientRect(); return covers(e, deepHit(q.left + q.width / 2, q.top + q.height / 2)); };
    const score = (e) => (tinyBox(e) ? 4000 : 0) + (reach(e) ? 0 : 2000) + (e.matches('[role=option],li,dd') ? 0 : 1) * 1000 + (boxOf(e) ? 0 : 500) + Math.hypot(e.getBoundingClientRect().left - r.left, e.getBoundingClientRect().top - r.bottom) / 10;
    return (top.length ? top : hits).sort((a, b) => score(a) - score(b))[0];
  }
  // 多选下拉把选中的每一项显示成一个标签：看有没有这一项，而不是整个框的文字
  const TAG_CLASS = /(^|[-_\s])(tag|chip|token|selection-item|select-item)([-_\s]|$)/i;
  // 选中项的标签；antd 的菜单行 ant-select-item-option 也带 select-item，弹层挂在外壳里时不能算
  const LIST_ROW = '[role=option],[role=listbox],[class*=option],[class*=dropdown],[class*=popup]';
  // root：下拉的外壳。只排除标签和外壳之间的菜单行、列表（外壳本身在筛选弹层里不算）
  // 选中的标签一定看得见；一直挂着、用 CSS 藏起来的内嵌菜单行（ul > li.select-item）不算
  const isTag = (n, root) => {
    if (!TAG_CLASS.test(typeof n.className === 'string' ? n.className : '')) return false;
    if (!n.getClientRects().length || getComputedStyle(n).visibility === 'hidden') return false;
    for (let a = n; a && a !== root; a = a.parentElement) if (a.matches(LIST_ROW)) return false;
    return true;
  };
  function shownTags(el) {
    if (!el.querySelectorAll) return [];
    const tags = [...el.querySelectorAll('[class*=tag],[class*=chip],[class*=token],[class*=selection-item],[class*=select-item]')].filter((t) => isTag(t, el));
    return tags.filter((t) => !tags.some((o) => o !== t && o.contains(t))).map((t) => {
      // 标签上的文字，不算它的删除按钮（有的写成 × 字符）
      const c = t.cloneNode(true);
      c.querySelectorAll('[class*=close],[class*=remove],[class*=delete],button,[role=button],svg,i').forEach((x) => x.remove());
      return norm(c.textContent);
    }).filter(Boolean);
  }
  // 只显示的下拉上的文字：有的组件把选项列表就放在外壳里面（shineout），列表里的、看不见的文字不算
  const overlayish = (n) => { try { const p = getComputedStyle(n).position; return p === 'absolute' || p === 'fixed'; } catch (e) { return false; } };
  function shownText(el) {
    if (!el.querySelector) return textOf(el);
    const skip = new Map();
    const hidden = (n) => {
      if (!n || n === el) return false;
      if (skip.has(n)) return skip.get(n);
      const v = n.matches('ul,ol,dl,[role=listbox]') || !visible(n) || (overlayish(n) && (!!n.querySelector('[role=option],[role=treeitem],li,dd,[class*=option],[class*=node]') || /option|menu|list|popup|panel|picker/i.test(typeof n.className === 'string' ? n.className : ''))) || hidden(n.parentElement);
      skip.set(n, v);
      return v;
    };
    const tiny = (n) => { const r = n.getBoundingClientRect(); return r.width <= 1 || r.height <= 1 || (n.checkVisibility && !n.checkVisibility({ opacityProperty: true })); };
    let out = '';
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let t = w.nextNode(); t; t = w.nextNode()) if (!hidden(t.parentElement) && !(t.parentElement !== el && tiny(t.parentElement))) out += ' ' + t.nodeValue;
    return norm(out).slice(0, 80);
  }
  const shows = (el, value) => {
    const tags = valueOf(el) === undefined ? shownTags(el) : [];
    return tags.length ? tags.includes(norm(value)) : norm(valueOf(el) || shownText(el)) === norm(value);
  };
  const dropOpen = (el) => el.getAttribute('aria-expanded') === 'true' || !!(el.querySelector && el.querySelector('[aria-expanded=true]'));
  // 多选下拉上留着别的选中项（上一次回放选的、地址里带的筛选）：录制时是从空的开始选的，就先把它们去掉
  const multiCleared = new WeakSet();
  // keep：录制时选之前就有的项、和这一步要选的项，留着；其余的是上一次留下的，去掉
  async function clearMulti(el, s, keep) {
    const textOfTag = (t) => { const c = t.cloneNode(true); c.querySelectorAll('[class*=close],[class*=remove],[class*=delete],button,[role=button],svg,i').forEach((x) => x.remove()); return norm(c.textContent); };
    const stale = () => {
      const tags = [...el.querySelectorAll('[class*=tag],[class*=chip],[class*=token],[class*=selection-item],[class*=select-item]')].filter((t) => isTag(t, el));
      return tags.filter((t) => !tags.some((o) => o !== t && o.contains(t)) && textOfTag(t) && !keep.has(textOfTag(t)));
    };
    for (let k = 0; k < 30; k++) {
      const x = stale().map((t) => [...t.querySelectorAll('[class*=close],[class*=remove],[class*=delete],[aria-label*=删除],[aria-label*=emove]')].find(visible)).find(Boolean);
      if (!x) break;
      await doClick(x, { desc: `${s.desc}：去掉已选的` });
      await sleep(150);
    }
    const left = stale().map(textOfTag);
    if (left.length) warn(`${s.desc}：框里原来就选着「${left.join('、')}」，没能去掉，这次选的会加在它们后面`);
  }
  // 语义步骤的成员（录制时的原始操作）：和顶层步骤一样按类型执行（滚动就是滚动，不能当成点击）
  async function runMember(m, value) {
    switch (m.type) {
      case 'scroll': return doScroll(m);
      case 'press': return doPress(m.target ? await find(m.target, true) : null, m);
      case 'drag': return doDrag(await findClickable(m.target, m), m);
      case 'check': return doCheck(await find(m.target, true), !!m.checked, m);
      case 'fill': return doFill(await find(m.target, true), value !== undefined ? value : m.value);
      case 'select': return doSelect(await find(m.target, true), m.value);
      case 'click':
      case 'dblclick':
      case 'contextmenu': {
        const el = await findClickable(m.target, m);
        if (el.hidden) return el.hidden.click();
        return doClick(el, m);
      }
      default: warn(`不认识的原始操作类型 ${m.type}，跳过`);
    }
  }
  // 选项在不在这个下拉自己的弹层里：aria-controls / aria-owns 指向的，或者紧挨着下拉、不在对话框里、像下拉列表的浮层
  function ownPopup(el, e) {
    const ids = `${el.getAttribute('aria-controls') || ''} ${el.getAttribute('aria-owns') || ''} ${[...el.querySelectorAll('[aria-controls],[aria-owns]')].map((x) => `${x.getAttribute('aria-controls') || ''} ${x.getAttribute('aria-owns') || ''}`).join(' ')}`.split(/\s+/).filter(Boolean);
    if (ids.some((id) => { const c = document.getElementById(id); return c && c.contains(e); })) return true;
    const er = el.getBoundingClientRect();
    for (let n = e; n && n !== document.body; n = n.parentElement) {
      if (n.contains(el) || n.matches('[role=dialog],[role=alertdialog],[aria-modal=true],dialog') || (typeof n.className === 'string' && DIALOG.test(n.className))) return false;
      if (!overlayish(n)) continue;
      const r = n.getBoundingClientRect();
      const near = Math.abs(r.top - er.bottom) < 40 || Math.abs(r.bottom - er.top) < 40;
      // 虚拟列表的每一行自己也是绝对定位：这一层对不上就接着往外找整个弹层
      if (near && (n.matches('[role=listbox],[role=menu],[role=tree]') || !!n.querySelector('[role=listbox],[role=menu],[role=option],li,[class*=option]') || /option|menu|dropdown|popup|select|list/i.test(n.className))) return true;
    }
    return false;
  }
  // 整行选项（antd TreeSelect 的 treenode 带缩进和展开按钮）点中间可能点到空白：点里面写着这个值的标题/内容那一块
  function labelOf(opt, value) {
    const want = norm(String(value).split(' / ').pop());
    const inner = [...opt.querySelectorAll('[class*=content],[class*=title],[class*=label]')].find((x) => norm(x.textContent) === want && visible(x) && !tinyBox(x));
    return inner ? (inner.closest('[class*=content-wrapper]') && opt.contains(inner.closest('[class*=content-wrapper]')) ? inner.closest('[class*=content-wrapper]') : inner) : opt;
  }
  // 弹层还在展开动画里（antd 的缩放）：位置、大小还在变，点中心会落到别的选项上。
  // 等到位置停稳、点下去命中的就是它（最多 1.5 秒）
  async function hittable(e, retry) {
    const end = Date.now() + (retry ? 1000 : 1500);
    let last = '';
    while (Date.now() < end && e.isConnected) {
      const r = rectOf(e);
      const key = [r.left, r.top, r.width, r.height].map(Math.round).join(',');
      if (key === last && r.width >= 1 && r.height >= 1 && covers(e, deepHit(r.left + r.width / 2, r.top + r.height / 2))) return;
      last = key;
      await sleep(100);
    }
    // 还是点不中（被别的浮层挡着、在可视区外）：滚到可视区再等一会儿
    if (e.isConnected && !retry) { try { e.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (x) { /* ignore */ } await sleep(200); return hittable(e, true); }
  }
  async function pickChoice(el, value, s) {
    // 和录制时的值一样：把录制时的操作原样再做一遍（最稳）
    const wasOpen = !!s.multi && dropOpen(el); // 多选下拉点完上一项面板还开着
    if (s.members && s.members.length && String(s.recorded) === value && !(s.multi && s.members.length < 2 && !wasOpen)) {
      try {
        for (const m of s.members) { await runMember(m); await sleep(150); }
        if (shows(el, value)) return;
      } catch (e) {
        if (e.unknown) throw e; // 动作可能已经生效，不能再选一遍
        warn(`${s.desc}：按录制时的操作选择失败（${e.message}），改为按文字找选项`);
      }
    }
    const open = !!s.multi && (dropOpen(el) || !!findOption(value, el, null, (e) => ownPopup(el, e)));
    const pre = new Set(open ? [] : optionCands(value, el)); // 点开之前就看得见的同名文字不是选项（面板本来就开着的除外）
    const parts = String(value).split(/\s*[/>＞]\s*/).filter(Boolean);
    const pres = parts.length > 1 ? parts.map((x) => new Set(optionCands(x, el))) : [];
    if (!open) await doClick(el, { desc: s.desc });
    await sleep(300);
    const tagsBefore = s.multi ? shownTags(el) : [];
    let opt = findOption(value, el, pre);
    // 弹层展开动画还没走完（高度从 0 长出来）：再等一会儿
    // 只找到 0 大小的（antd 的读屏副本、还没长出来的列表）也再等等，等不到再用它
    for (const end = Date.now() + 1500; (!opt || tinyBox(opt)) && Date.now() < end && !(parts.length > 1 && findOption(parts[0], el, pres[0]));) { await sleep(150); opt = findOption(value, el, pre) || opt; }
    // 级联选择（“广东省 / 深圳市 / 南山区”）：第一级找得到才按层逐级点（选项文字本身带斜杠的“S/M/L”不是级联）
    let cascade = false;
    if (!opt && parts.length > 1) {
      const end = Date.now() + 1500;
      while (!(cascade = !!findOption(parts[0], el, pres[0])) && Date.now() < end) await sleep(150);
    }
    if (cascade) {
      const picked = [];
      // 下一级不能是已经点过的那一列里的（“北京市 / 北京市 / 朝阳区”这种同名层）
      const fresh = (e) => !picked.some((p) => p.isConnected && (p === e || p.contains(e) || e.contains(p) || (p.parentElement && p.parentElement === e.parentElement)));
      for (let k = 0; k < parts.length; k++) {
        let o = null;
        const end = Date.now() + 3000;
        while (!(o = findOption(parts[k], el, pres[k], fresh)) && Date.now() < end) await sleep(150);
        // 上一级点的时候弹层还在动、没点中（下一列没出来）：等它停稳再点一次上一级
        const up = picked[k - 1];
        if (!o && up && up.isConnected) {
          await hittable(up);
          await doClick(up, { desc: `选项 ${parts[k - 1]}` });
          const end2 = Date.now() + 3000;
          while (!(o = findOption(parts[k], el, pres[k], fresh)) && Date.now() < end2) await sleep(150);
        }
        if (!o) throw new Error(`${s.desc}：第 ${k + 1} 级找不到选项「${parts[k]}」`);
        await hittable(o);
        await doClick(o, { desc: `选项 ${parts[k]}` });
        picked.push(o);
        await sleep(300);
      }
      await sleep(200);
      // 分隔符写法可以不一样（“浙江省 > 杭州市”对“浙江省 / 杭州市”）；只显示最后一级的组件也算对
      const path = (v) => norm(v).split(/\s*[/>＞]\s*|\s+/).filter(Boolean).join('/'); // 各级分开显示、没有分隔符的（shineout）也算
      const got = path(valueOf(el) || shownText(el));
      if (got !== path(value) && got !== norm(parts[parts.length - 1])) throw new Error(`${s.desc}：逐级选了「${value}」，但框里显示的是「${valueOf(el) || shownText(el)}」`);
      return;
    }
    // 能输入的（可搜索的下拉、联想框）：输入文字过滤后再找
    // 能输入的（外壳里有搜索框的也算：antd AutoComplete）：不输入就没有看得见的选项时，输入文字过滤后再找
    const box = typable(el) ? el : el.querySelector ? [...el.querySelectorAll('input,textarea')].find((i) => typable(i) && visible(i)) : null;
    if ((!opt || tinyBox(opt)) && box) {
      await doFill(box, value);
      await sleep(600);
      // 输入后列表重新过滤，组件可能复用了点开前就在的选项元素（前一步已经点开过联想框）：这时不再排除它们
      const real = (e) => !tinyBox(e);
      opt = findOption(value, el, pre, real) || findOption(value, el, null, real) || opt;
      // 输入后有了选项但弹层没开（antd AutoComplete 用程序输入时只更新了给读屏用的隐藏列表）：点一下框、再按向下键把它打开
      for (const kick of [() => doClick(box, { desc: s.desc }), () => box.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, bubbles: true }))]) {
        if (opt && !tinyBox(opt)) break;
        await kick();
        await sleep(500);
        opt = findOption(value, el, null, real) || opt;
      }
    }
    if (!opt) throw new Error(`${s.desc}：点开后找不到选项「${value}」`);
    opt = labelOf(opt, value);
    await hittable(opt);
    await doClick(opt, { desc: `选项 ${value}` });
    await sleep(250);
    // 没选上（点的时候弹层还在动、点到了别的项或空白）：还看得见这个选项就再点一次，弹层关了就重新打开再找
    let retried = false;
    for (let k = 0; k < 2 && !shows(el, value); k++) {
      retried = true;
      let again = opt.isConnected && visible(opt) && !tinyBox(opt) ? opt : findOption(value, el);
      if (!again) { await doClick(el, { desc: s.desc }); await sleep(400); again = findOption(value, el); }
      if (!again) break;
      again = labelOf(again, value);
      await hittable(again);
      await doClick(again, { desc: `选项 ${value}` });
      await sleep(300);
    }
    // 多选里点歪了多选上的别的项（弹层还在动时点到了相邻一行）：再点一次把它取消掉
    // 只在第一下没选上、重点过的时候；树形多选勾父节点会连带勾上子节点，那些是该有的，不动
    const treeish = (e) => /tree/i.test(typeof e.className === 'string' ? e.className : '') || !!e.querySelector('[class*=tree],[role=tree]');
    if (s.multi && retried && !treeish(el) && !treeish(opt) && shows(el, value)) {
      for (const t of shownTags(el).filter((t) => !tagsBefore.includes(t) && t !== norm(value))) {
        const o = findOption(t, el);
        if (o) { await hittable(o); await doClick(o, { desc: `取消误选 ${t}` }); await sleep(300); warn(`多选时误选了「${t}」，已取消`); }
      }
    }
    if (!shows(el, value)) throw new Error(`${s.desc}：点了选项「${value}」，但框里显示的是「${valueOf(el) !== undefined ? valueOf(el) : shownText(el)}」`);
  }
  async function doPick(el, value, s) {
    value = value == null ? '' : String(value);
    highlight(el);
    const members = s.members || [];
    // 旧录制里“键入 + 回车后页面清空”的输入框（扫码框、标签输入）被录成了值为空的选择：照成员重放，键入的换成参数值
    if (String(s.recorded) === '' && members.some((m) => m.type === 'fill' || m.type === 'press')) {
      for (const m of members) { await runMember(m, m.type === 'fill' && value ? value : undefined); await sleep(150); }
      return;
    }
    // 区间开始：不管这一步要不要动，都登记开始框和目标值，结束日期设完后核对它没被联动改掉
    if (s.pick === 'date' && s.rangeStart && s.sid) rangePanels.set(s.sid, { el, want: parseDate(value, s.dateFmt || null), t: s.target, root: null });
    // 已经是这个值就不动（区间开始日期刚选、面板还等着结束日期时除外：要选完才会一起生效）。
    // 只显示、不能编辑的下拉（不是输入框）看它显示的文字
    const cur = valueOf(el) !== undefined ? valueOf(el) : shownText(el);
    if (s.multi && s.pick === 'choice') {
      // 这次回放里第一次动这个多选框：框里应该只有录制时选之前就有的那些项，多出来的（上一次回放留下的）先去掉
      if (!multiCleared.has(el)) {
        const keep = new Set((s.before || []).map(norm).concat(norm(value)));
        if (shownTags(el).some((t) => !keep.has(t))) await clearMulti(el, s, keep);
      }
      multiCleared.add(el);
      if (shownTags(el).includes(norm(value))) return; // 这一项已经选着
    }
    if (cur === value && !(s.pick === 'date' && rangePending(s))) {
      if (s.pick === 'date') checkRangeStart(s);
      return;
    }
    // 录成日期、但参数根本不是日期（旧录制把类名带 date 的联想框当成了日期）：按选择处理
    const all = parseDates(value, s.dateFmt || null);
    if (s.pick === 'date' && (all.length || all.ambiguous || /^\s*\d{1,2}:\d{2}/.test(value) || !value)) return pickDate(el, value, s);
    // 看着是日期、按这个框的写法却读不通（美式框给了 20/08/2026）：直接报错，不去面板里乱点
    if (s.pick === 'date' && /\d{1,4}\s*[-/.年]\s*\d{1,2}\s*[-/.月]\s*\d{1,4}/.test(value)) {
      throw new Error(`${s.desc}：日期 ${value} 按这个框的格式${s.dateFmt === 'MDY' ? '（月/日/年）' : s.dateFmt === 'DMY' ? '（日/月/年）' : ''}读不通，请写成 YYYY-MM-DD`);
    }
    try {
      return await pickChoice(el, value, s);
    } catch (e) {
      // 自定义下拉背后有原生 <select>（layui、Chosen、Select2）：界面上选不中时直接设原生下拉框，再让组件刷新显示
      if (e.unknown || !(s.sel && s.sel.target)) throw e;
      const sel = await find(s.sel.target, true).catch(() => null);
      if (!sel || sel.tagName !== 'SELECT' || !optionFor(sel, value)) throw e;
      await doSelect(sel, value);
      try { if (window.layui && window.layui.form) window.layui.form.render('select'); } catch (x) { /* ignore */ }
      await sleep(200);
      warn(`${s.desc}：界面上没选中（${e.message}），已直接设置背后的下拉框`);
    }
  }
  function extractOf(el) {
    const tag = el.tagName;
    if (tag === 'TABLE') {
      return [...el.rows].map((r) => [...r.cells].map((c) => norm(c.innerText)));
    }
    if (tag === 'UL' || tag === 'OL') return [...el.children].map((li) => norm(li.innerText));
    if (tag === 'SELECT') return { value: el.value, text: el.selectedOptions[0] ? el.selectedOptions[0].text : '' };
    if ('value' in el && /^(INPUT|TEXTAREA)$/.test(tag)) return el.value;
    if (tag === 'A') return { text: norm(el.innerText), href: el.href };
    if (tag === 'IMG') return { src: el.src, alt: el.alt };
    return norm(el.innerText || el.textContent);
  }

  // 录制地址里的查询参数（统计参数除外）当前页面都有且相同，才算同一页面：
  // 像 index.php?mod=stock.list 这种靠参数区分页面的站点，参数不同就是不同页面
  // hash 路由（#/list?page=1）里的参数同样比较；同名参数按全部取值比较
  const TRACK_PARAM = /^(spm|scm|utm_.*|gclid|fbclid|_|_t|timestamp)$/i;
  function paramsMatch(a, b) {
    for (const k of new Set(a.keys())) {
      if (TRACK_PARAM.test(k)) continue;
      const x = a.getAll(k);
      const y = b.getAll(k);
      if (x.length !== y.length || x.some((v, i) => v !== y[i])) return false;
    }
    return true;
  }
  function samePage(u) {
    try {
      const a = new URL(u, location.href);
      const b = new URL(location.href);
      const strip = (x) => x.replace(/\/$/, '');
      if (strip(a.href) === strip(b.href)) return true;
      const [ah, aq] = a.hash.split('?');
      const [bh, bq] = b.hash.split('?');
      if (a.origin !== b.origin || strip(a.pathname) !== strip(b.pathname) || ah !== bh) return false;
      return paramsMatch(a.searchParams, b.searchParams) && paramsMatch(new URLSearchParams(aq || ''), new URLSearchParams(bq || ''));
    } catch (e) { return false; }
  }
  async function waitUntil(fn, timeout) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { checkCancel(); if (fn()) return true; await sleep(100); }
    return !!fn();
  }

  // ---------- 断点续跑（整页跳转后再次执行脚本） ----------
  const PKEY = '__PR_PROGRESS__' + REC.id;
  function loadProgress() {
    try {
      const p = JSON.parse(sessionStorage.getItem(PKEY) || 'null');
      if (p && Date.now() - p.t < 30 * 60 * 1000) return p;
    } catch (e) { /* ignore */ }
    return null;
  }
  // extra.nav：为第 i 步（打开页面）已经跳转过一次。再次执行时不管落在哪个页面都继续往下，
  // 避免被服务器重定向（比如已登录时登录页跳到后台首页）后反复跳转；extra.skip：可选步骤组正在跳过
  // 断点同时发给扩展（经 content script 转发）：跨源跳转（A → 登录站 B → A）时各源的 sessionStorage
  // 互不相通，回到 A 会读到旧断点，扩展以收到的最新断点为准
  function saveProgress(i, result, extra) {
    try {
      const snap = (responses) => JSON.stringify(Object.assign({ i, t: Date.now(), extracted: result.extracted, responses, log: result.log }, extra));
      let s = snap(result.responses);
      if (s.length > 2e6) s = snap(result.responses.map((r) => Object.assign({}, r, { data: '(过大已省略)' })));
      try { sessionStorage.setItem(PKEY, s); } catch (e) { /* ignore */ }
      if (window.__PR_TOKEN__) window.postMessage({ __page_recorder__: 'progress', token: window.__PR_TOKEN__, data: s }, '*');
    } catch (e) { /* ignore */ }
  }
  const clearProgress = () => { try { sessionStorage.removeItem(PKEY); } catch (e) { /* ignore */ } };

  // 开关状态：录制时记下点击前后变化的那个状态（目标或往上几层的 aria-expanded / 展开类名）
  function toggleState(el, tg) {
    let n = el;
    for (let k = 0; k < (tg.up || 0) && n.parentElement; k++) n = n.parentElement;
    if (tg.attr) return n.getAttribute(tg.attr) === 'true';
    return n.classList.contains(tg.cls);
  }
  // 勾选类状态（录制端 stateOf 记的）：aria-checked / aria-pressed / aria-selected，或者里面的原生复选框；读不到返回 null
  function checkedState(el, st) {
    if (st.input) {
      const box = el.control && /^(checkbox|radio)$/i.test(el.control.type) ? el.control : el.querySelector && el.querySelector('input[type=checkbox],input[type=radio]');
      return box ? box.checked : null;
    }
    let n = el;
    for (let k = 0; k < (st.up || 0) && n.parentElement; k++) n = n.parentElement;
    const v = n.getAttribute(st.attr);
    return v === 'true' ? true : v === 'false' ? false : null;
  }

  // mark(n, extra)：保存断点。找到元素、真正要动手之前才把断点推进到下一步——
  // 这样在等待元素期间页面被别的原因刷新，续跑时还会重做这一步
  async function runStep(s, i, result, mark) {
    const t = s.target;
    // 动手前先记一条成功日志：动作引起整页跳转时，这一步也算做完了，日志不会丢
    const act = async (elP) => {
      const el = await elP;
      result.log.push({ step: i + 1, desc: s.desc, ok: true });
      result.completed = i + 1;
      mark(i + 1);
      return el;
    };
    switch (s.type) {
      case 'navigate': {
        if (samePage(s.url)) return;
        if (await waitUntil(() => samePage(s.url), 5000)) return;
        log(`跳转到 ${s.url}，页面加载后请再次执行本脚本继续（会自动从第 ${i + 1} 步继续）`);
        result.navigating = s.url;
        mark(i, { nav: s.url });
        location.href = s.url;
        await sleep(20000);
        throw new Error('页面跳转未完成');
      }
      case 'url':
        if (!(await waitUntil(() => samePage(s.url), 5000))) warn(`页面地址未变为 ${s.url}，继续执行`);
        return;
      case 'click':
      case 'dblclick':
      case 'contextmenu': {
        const el = await act(findClickable(t, s));
        if (el.hidden) {
          warn(`第 ${i + 1} 步的元素是隐藏的（可能在悬停才展开的菜单里），直接触发点击：${t.desc || ''}`);
          return el.hidden.click();
        }
        // 展开/收起这类开关：已经是录制时点完之后的状态（比如菜单分组本来就展开着）就不再点，免得点了反而收起
        // 开关、复选框、按下态：已经是录制时点完之后的状态就不点（再点会把开关翻回去）
        const already = (e) => {
          const tg = s.toggle && toggleState(e, s.toggle) === s.toggle.after && !(s.waitFor && s.waitFor.length);
          const st = !tg && s.state && checkedState(e, s.state) === s.state.after;
          if (!tg && !st) return false;
          const entry = result.log[result.log.length - 1];
          entry.skipped = true;
          entry.reason = tg ? (s.toggle.after ? '已经是展开状态' : '已经是收起状态') : s.state.after ? '已经是打开 / 选中状态' : '已经是关闭 / 未选中状态';
          log(`${i + 1} 已是目标状态，跳过点击：${s.desc}`);
          return true;
        };
        if (already(el)) return;
        try {
          return await doClick(el, s);
        } catch (e) {
          if (!e.detached) throw e;
          // 刚找到就被重新渲染（数据回来后整块重画）：重新找一次，重新判断开关状态再点
          log(`${i + 1} 元素被重新渲染，重新定位`);
          const el2 = await findClickable(t, s);
          if (el2.hidden) return el2.hidden.click();
          if (already(el2)) return;
          return doClick(el2, s);
        }
      }
      case 'fill': {
        const el = await act(find(t, true));
        return s.pick ? doPick(el, fillTpl(s.value), s) : doFill(el, fillTpl(s.value), s);
      }
      case 'select': return doSelect(await act(find(t, true)), Array.isArray(s.value) ? s.value.map(fillTpl) : fillTpl(s.value));
      case 'check': {
        if (Array.isArray(s.options) && s.value !== undefined) return doCheck(radioFor(await act(find(t, true)), fillTpl(s.value), s), true, s);
        const v = fillTpl(s.checked);
        if (![true, false, 'true', 'false', 1, 0, '1', '0'].includes(v)) throw new Error(`${s.desc}：复选框只能填 true（勾选）或 false（不勾选），收到「${v}」`);
        return doCheck(await act(find(t, true)), v === true || v === 'true' || v === 1 || v === '1', s);
      }
      case 'press': return doPress(t ? await act(find(t, true)) : (mark(i + 1), null), s);
      case 'scroll': return doScroll(s);
      case 'drag': return doDrag(await act(findClickable(t, s)), s);
      case 'upload': return doUpload(await act(find(t, true)), s, i);
      case 'extract': {
        const el = await find(t, true);
        highlight(el);
        result.extracted[s.name || `步骤${i + 1}`] = extractOf(el);
        return;
      }
      default:
        warn('未知步骤类型', s.type);
    }
  }

  async function replay(opts) {
    opts = opts || {};
    installNet();
    installDialogs();
    // seg：扩展按框架分段执行时只跑这一段；断点不在这一段里就是过期的，不用
    // opts.resume：扩展收集到的最新断点（优先于本页 sessionStorage 里的）；opts.skip：上一段结束时可选组的跳过状态
    cancelled = false;
    const seg = opts.segment || null;
    let p = opts.from != null ? null : opts.resume || (CONFIG.resume ? loadProgress() : null);
    if (p && seg && (p.i < seg.from || p.i > seg.to)) p = null;
    const result = { ok: true, total: steps.length, completed: 0, extracted: {}, responses: [], log: [] };
    let from = 0;
    if (opts.from != null) {
      from = opts.from;
      // 扩展刚打开的起始页面被重定向了（比如已登录时登录页跳到后台）：第一步“打开页面”算完成
      const s0 = steps[from];
      if (opts.opened && s0 && s0.type === 'navigate' && s0.url === opts.opened && !samePage(s0.url)) {
        log(`起始页面 ${s0.url} 被重定向到 ${location.href}，按新页面继续`);
        result.log.push({ step: from + 1, desc: s0.desc, ok: true, redirected: location.href });
        from += 1;
      }
    } else if (p) {
      from = p.i;
      Object.assign(result.extracted, p.extracted || {});
      result.responses.push(...(p.responses || []));
      result.log.push(...(p.log || []));
      if (p.nav && steps[from] && steps[from].type === 'navigate' && !samePage(steps[from].url)) {
        log(`第 ${from + 1} 步打开 ${steps[from].url} 后到了 ${location.href}（被重定向），按新页面继续`);
        result.log.push({ step: from + 1, desc: steps[from].desc, ok: true, redirected: location.href });
        from += 1;
      }
      log(`从第 ${from + 1} 步继续回放`);
    } else if (seg) {
      from = seg.from;
    } else if (steps[0] && steps[0].type === 'navigate' && !samePage(steps[0].url)) {
      const idx = steps.findIndex((s) => s.type === 'navigate' && samePage(s.url));
      if (idx > 0) { from = idx; log(`当前页面对应第 ${idx + 1} 步，从这里开始`); }
    }
    result.completed = from;
    const to = Math.min(seg ? seg.to : opts.to != null ? opts.to : steps.length, steps.length);
    // 可选步骤（如登录）：元素在就执行，不在就跳过。一个可选步骤被跳过后，
    // 直到下一个非可选步骤之前的可选步骤都算同一组（登录后续的输入、提交、跳转）：
    // 跳转类直接跳过，其余只快速检查一下。组状态随断点保存，整页跳转后也不丢
    // 跨框架分段执行时，上一段结束时的组状态由扩展通过 opts.skip 传进来
    let skipping = p ? !!p.skip : !!opts.skip;
    const mark = (n, extra) => saveProgress(n, result, Object.assign({ skip: skipping }, extra));
    let prevSince = null;
    const skip = (i, s, reason) => {
      skipping = true;
      log(`${i + 1}/${steps.length} 跳过可选步骤：${s.desc}${reason ? '（' + reason + '）' : ''}`);
      result.completed = i + 1;
      result.log.push({ step: i + 1, desc: s.desc, ok: true, skipped: true, reason });
      mark(i + 1);
    };
    for (let i = from; i < to; i++) {
      const s = steps[i];
      if (!s.optional) skipping = false;
      else if (skipping && (s.type === 'navigate' || s.type === 'url')) { skip(i, s, ''); continue; }
      mark(i); // 先记在这一步；真正动手前（runStep 里）才推进到下一步
      const since = Date.now() - 20;
      optionalFind = s.optional ? (skipping ? 300 : CONFIG.optionalTimeout || 3000) : null;
      try {
        checkCancel();
        log(`${i + 1}/${steps.length} ${s.desc}`);
        if (s.frame && !seg) {
          let host = s.frame.url;
          try { host = new URL(s.frame.url).host; } catch (x) { /* ignore */ }
          throw new Error(`这一步在 iframe（${host}）里，控制台脚本不能操作跨域 iframe。请用扩展脚本库的「▶ 运行」或桥接服务的 run_recording 执行`);
        }
        ambiguity = null;
        dialogPlan = [];
        await runStep(s, i, result, mark);
        optionalFind = null;
        if (ambiguity) {
          const entry = result.log.filter((x) => x.step === i + 1).pop();
          if (entry) entry.ambiguous = ambiguity.count;
          warn(`第 ${i + 1} 步有 ${ambiguity.count} 个分不清的同样元素，按位置和上下文选了最像的一个：${s.desc}`);
        }
        if (CONFIG.waitRequests && s.waitFor && s.waitFor.length && s.type !== 'navigate') {
          const got = await waitRequests(s.waitFor, since, CONFIG.requestTimeout, prevSince);
          got.forEach((g) => result.responses.push(Object.assign({ step: i + 1 }, g)));
        }
        checkCancel();
        prevSince = since;
        result.completed = i + 1;
        const last = result.log[result.log.length - 1];
        if (!(last && last.step === i + 1 && last.ok)) result.log.push({ step: i + 1, desc: s.desc, ok: true });
        mark(i + 1);
        await sleep(CONFIG.stepDelay);
      } catch (e) {
        optionalFind = null;
        if (cancelled) {
          result.ok = false;
          result.error = `第 ${i + 1} 步时回放被取消`;
          break;
        }
        if (s.optional) { skip(i, s, String((e && e.message) || e)); continue; }
        result.log = result.log.filter((x) => !(x.step === i + 1 && x.ok && !x.skipped));
        result.log.push({ step: i + 1, desc: s.desc, ok: false, error: String((e && e.message) || e) });
        console.error('[回放] 第 ' + (i + 1) + ' 步失败：', e);
        if (!CONFIG.continueOnError) {
          result.ok = false;
          result.error = `第 ${i + 1} 步失败：${(e && e.message) || e}。修正后可执行 __PR__.replay({ from: ${i} }) 从该步继续`;
          break;
        }
      }
    }
    clearProgress();
    restoreDialogs();
    if (dialogLog.length) result.dialogs = dialogLog.splice(0);
    if (warnings.length) result.warnings = warnings.splice(0);
    // 页面回放校准直接请求：这次改过的参数，页面自己发的值和模板算的是否一致
    if (Array.isArray(CONFIG.calibrate) && CONFIG.calibrate.length) result.calibration = calibrate(CONFIG.calibrate);
    // 扩展分段执行时，跑完就撤掉请求改写和请求记录，免得用户之后在这个页面里的正常操作被改写、被留在内存里
    if (seg) netOff();
    result.skip = skipping;
    if (result.ok) log('回放完成', result);
    return result;
  }

  // ---------- 直接调用接口（自动携带当前页面的登录态 Cookie） ----------
  // JSONP：往页面里插一个 <script>，回调参数换成临时函数，服务端返回的脚本调用它时拿到数据
  let jsonpSeq = 0;
  function jsonpCall(u, key, timeout) {
    return new Promise((resolve, reject) => {
      const name = `__prJsonp${Date.now().toString(36)}${++jsonpSeq}`;
      const url = new URL(u.href);
      url.searchParams.set(key, name);
      const s = document.createElement('script');
      let timer = null;
      const done = (fn, v) => { clearTimeout(timer); try { delete window[name]; } catch (e) { window[name] = undefined; } s.remove(); fn(v); };
      window[name] = (d) => done(resolve, d);
      s.onerror = () => done(reject, new Error('脚本加载失败'));
      // 脚本执行完了回调却没被调用：返回的不是 JSONP（多半是登录页或报错页）
      s.onload = () => setTimeout(() => { if (name in window && window[name]) done(reject, new Error('返回的内容没有调用回调')); }, 0);
      timer = setTimeout(() => done(reject, new Error('超时')), timeout);
      s.src = url.href;
      (document.head || document.documentElement).appendChild(s);
    });
  }
  function apiByName(n) {
    if (typeof n === 'number') return REC.apis[n];
    return REC.apis.find((a) => a.name === n || a.fn === n) || REC.apis.find((a) => a.name.includes(n));
  }
  // 工具式扁平参数 { q: 'x', page: 2 } → { path, query, body }
  function splitArgs(a, args) {
    args = args || {};
    const structured = ['path', 'query', 'body', 'headers', 'rawBody'];
    const argNames = (a.toolArgs || []).map((t) => t.arg);
    if (Object.keys(args).some((k) => structured.includes(k) && !argNames.includes(k))) return args;
    const out = { path: {}, query: {}, body: {}, nested: [] };
    const list = a.toolArgs || [];
    for (const [k, v] of Object.entries(args)) {
      const t = list.find((x) => x.arg === k) || list.find((x) => !x.path && x.key === k);
      // 值是 JSON 字符串的字段里面的某个字段（data.jsonBody.pagination.current）：单独记下，发之前改进那个字符串里
      if (t && t.path) { out.nested.push({ sec: t.sec, key: t.key, path: t.path, value: v }); continue; }
      if (t) { out[t.sec][t.key] = v; continue; }
      // 没列出来的里层字段：接在 JSON 字符串字段的参数名后面写
      const host = list.filter((x) => x.json && k.startsWith(x.arg + '.')).sort((x, y) => y.arg.length - x.arg.length)[0];
      if (host) out.nested.push({ sec: host.sec, key: host.key, path: k.slice(host.arg.length + 1), value: v });
      else if (/^(GET|HEAD|DELETE)$/.test(a.method)) out.query[k] = v;
      else out.body[k] = v;
    }
    return out;
  }
  // JSON 字符串里改一个字段：逐层往里走，路上遇到又是 JSON 字符串的接着解析，改完按原来的层次序列化回去
  function setInJson(str, tokens, value) {
    const walk = (node, i) => {
      const packed = typeof node === 'string' && /^\s*[{[]/.test(node);
      // 到了要改的那个字段：它原来是 JSON 字符串、给的是对象，就照样序列化成字符串
      if (i === tokens.length) return packed && value && typeof value === 'object' ? JSON.stringify(value) : value;
      if (packed) return JSON.stringify(walk(JSON.parse(node), i));
      const t = tokens[i];
      if (node == null || typeof node !== 'object') node = typeof t === 'number' ? [] : {};
      node[t] = walk(node[t], i + 1);
      return node;
    };
    if (!tokens.length) return str;
    return JSON.stringify(walk(JSON.parse(str), 0));
  }
  // 调用方传的嵌套对象摊平成路径；键名本身带点号的转义（和导出的路径写法一致），已经是导出路径写法的原样用
  const escKey = (k) => String(k).replace(/[\\.[\]]/g, '\\$&');
  function flattenInput(v, prefix, out, known) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const k of Object.keys(v)) {
        const seg = !prefix && known && k in known ? k : escKey(k);
        flattenInput(v[k], prefix ? `${prefix}.${seg}` : seg, out, null);
      }
    } else out[prefix] = v;
    return out;
  }
  // 被脱敏的字段（令牌、签名、CSRF）：用页面最近一次发出的同名字段值，再看页面上的 meta / 隐藏输入框
  function liveField(url, key) {
    const last = String(pathTokens(key).filter((x) => typeof x === 'string').pop() || key);
    try {
      if (typeof window.__PR_LIVE_FIELDS__ === 'function') {
        const f = window.__PR_LIVE_FIELDS__(url) || {};
        if (f[key] != null) return f[key];
        if (f[last] != null) return f[last];
      }
    } catch (e) { /* ignore */ }
    try {
      const inp = [...document.querySelectorAll('input[type=hidden][name]')].find((x) => x.name === last && x.value);
      if (inp) return inp.value;
      if (/csrf|xsrf|_token|authenticity/i.test(last)) {
        const meta = document.querySelector('meta[name=csrf-token],meta[name=_csrf],meta[name=csrf_token],meta[name=x-csrf-token]');
        if (meta && meta.content) return meta.content;
      }
    } catch (e) { /* ignore */ }
    return null;
  }
  async function call(name, opts) {
    const a = apiByName(name);
    if (!a) throw new Error('未找到接口：' + name + '。可用接口：' + REC.apis.map((x) => `${x.fn} (${x.name})`).join(', '));
    // 二进制、流式、被截断的请求体照着发出去是空的或残缺的：不发
    if (a.via === 'eventsource' || a.via === 'websocket') {
      return { ok: false, rejected: true, notSent: true, error: `接口 ${a.name} 是${a.via === 'websocket' ? ' WebSocket' : '服务端推送的'}长连接，没有“一次请求一次返回”，不能直接请求，请用页面回放` };
    }
    if (a.replayable === false && !(opts && opts.rawBody !== undefined)) {
      return { ok: false, rejected: true, notSent: true, error: `接口 ${a.name} 的请求体是 ${a.bodyType || '二进制'}${a.bodyType && ['json', 'form', 'multipart', 'text'].includes(a.bodyType) ? '（录制时被截断）' : ''}，不能直接重发，请用页面回放` };
    }
    opts = splitArgs(a, opts);
    const P = API_PARAMS[a.name] || a.params || {};
    const path = Object.assign({}, P.path, opts.path);
    const query = Object.assign({}, P.query, opts.query);
    const u = new URL(a.url);
    const T = a.pathTemplate.split('/');
    const S = u.pathname.split('/');
    T.forEach((s, i) => { const m = s.match(/^\{(.+)\}$/); if (m && path[m[1]] != null) S[i] = encodeURIComponent(fillTpl(path[m[1]])); });
    u.pathname = S.join('/');
    u.search = '';
    const maskedSet = new Set(a.masked || []);
    const missing = [];
    // 淘宝 / 天猫 / 1688 的 mtop 网关（/h5/<api>/<版本>/）：sign、t 每次由页面自己的 SDK 现算，重发录到的会被拒；
    // 页面上有 lib.mtop 就交给它发（签名它来算），查询参数里脱敏的签名不用补
    const mt = u.pathname.match(/^\/h5\/([^/]+)\/([^/]+)\/?$/i);
    const mtop = mt && window.lib && window.lib.mtop && typeof window.lib.mtop.request === 'function' ? window.lib.mtop : null;
    // 录制时脱敏了、调用方也没给的字段：用页面上最新的值；拿不到就记下来，整个请求不发
    const fillMasked = (sec, k, v, given) => {
      if (mtop && sec === 'query') return v;
      if (!maskedSet.has(`${sec}.${k}`) || given || (v !== '' && v != null)) return v;
      const live = liveField(u.href, k);
      if (live == null) { missing.push(`${sec}.${k}`); return v; }
      return live;
    };
    const withNested = (sec, k, v) => {
      for (const n of opts.nested || []) {
        if (n.sec !== sec || n.key !== k) continue;
        try { v = setInJson(String(v), pathTokens(n.path), n.value); } catch (e) { throw new Error(`接口 ${a.name} 的字段 ${k} 不是 JSON 字符串，改不了里面的 ${n.path}`); }
      }
      return v;
    };
    for (const [k, v0] of Object.entries(query)) {
      const v = withNested('query', k, fillMasked('query', k, fillTpl(v0), opts.query && k in opts.query));
      if (v == null) continue;
      if (Array.isArray(v)) v.forEach((x) => u.searchParams.append(k, String(x)));
      else u.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
    const headers = {};
    for (const [k, v] of Object.entries(a.requestHeaders || {})) if (v !== '***' && !/\{\{|__PR_(SECRET_[a-z0-9]+|MASKED)__/.test(v)) headers[k] = v;
    // 页面最近一次请求同一接口（签名类只认同一路径）、同一站点时带的鉴权/签名/CSRF 头比录制时的新，用它覆盖
    const setHeader = (k, v) => { for (const h of Object.keys(headers)) if (h.toLowerCase() === k.toLowerCase()) delete headers[h]; headers[k] = v; };
    let liveHdr = {};
    try { if (typeof window.__PR_LIVE_HEADERS__ === 'function') liveHdr = window.__PR_LIVE_HEADERS__(u.href) || {}; } catch (e) { /* ignore */ }
    const usedLive = [];
    for (const [k, v] of Object.entries(liveHdr)) {
      const had = Object.keys(a.requestHeaders || {}).some((h) => h.toLowerCase() === k);
      if (had) { setHeader(k, v); usedLive.push(k); }
    }
    for (const [k, v] of Object.entries(opts.headers || {})) setHeader(k, v);
    let body;
    if (!/^(GET|HEAD)$/.test(a.method)) {
      if (opts.rawBody !== undefined) body = opts.rawBody;
      else {
        const givenBody = opts.body ? flattenInput(opts.body, '', {}, P.body || {}) : {};
        const leaves = Object.assign({}, P.body, givenBody);
        for (const k of Object.keys(leaves)) leaves[k] = withNested('body', k, fillMasked('body', k, fillTpl(leaves[k]), k in givenBody));
        const removed = Object.keys((a.params && a.params.body) || {}).filter((k) => !(k in (P.body || {})));
        if (a.bodyType === 'json') {
          let o = a.requestBody !== undefined ? JSON.parse(JSON.stringify(a.requestBody)) : {};
          if ('_raw' in leaves && Object.keys(leaves).length === 1) o = fillTpl(leaves._raw);
          else {
            for (const [k, v] of Object.entries(leaves)) setPath(o, k, fillTpl(v));
            removed.forEach((k) => setPath(o, k, undefined, true));
          }
          body = JSON.stringify(o);
          if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json';
        } else if (a.bodyType === 'form') {
          const p = new URLSearchParams();
          for (const [k, v] of Object.entries(leaves)) p.append(k, String(fillTpl(v)));
          body = p.toString();
          if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['content-type'] = 'application/x-www-form-urlencoded';
        } else if (a.bodyType === 'multipart') {
          body = new FormData();
          for (const [k, v] of Object.entries(leaves)) body.append(k, String(fillTpl(v)));
          for (const k of Object.keys(headers)) if (k.toLowerCase() === 'content-type') delete headers[k];
        } else if ('_raw' in leaves) body = String(fillTpl(leaves._raw));
      }
    }
    // 还留着脱敏占位符（密码嵌在别的字符串里、没关联上参数）：发出去就是错的
    const MARK = /__PR_(SECRET_[a-z0-9]+|MASKED)__/;
    const bodyText = typeof body === 'string' ? body : body instanceof FormData ? [...body.values()].filter((x) => typeof x === 'string').join('&') : '';
    if (!missing.length && (MARK.test(u.href) || MARK.test(bodyText))) missing.push('含脱敏占位符的字段');
    if (missing.length) {
      return { ok: false, rejected: true, notSent: true, error: `接口 ${a.name} 的 ${missing.join('、')} 录制时脱敏了，页面上也没有找到最新的值，没有发送（请用页面回放，或在参数里给出）` };
    }
    if (mtop) {
      const q = Object.fromEntries(u.searchParams);
      let raw = q.data;
      const form = typeof body === 'string' ? new URLSearchParams(body) : body instanceof URLSearchParams ? body : null;
      if (form && form.has('data')) raw = form.get('data');
      let data0 = raw;
      try { data0 = raw ? JSON.parse(raw) : {}; } catch (e) { /* 不是 JSON 就原样给 */ }
      const opt = { api: q.api || mt[1], v: q.v || mt[2], data: data0, type: a.method === 'GET' ? 'GET' : 'POST', dataType: a.jsonp || q.type === 'jsonp' ? 'jsonp' : 'json' };
      for (const k of ['ecode', 'isSec', 'needLogin', 'timeout', 'SV', 'H5Request', 'valueType', 'AntiCreep', 'AntiFlood', 'LoginRequest', 'secType', 'sessionOption']) {
        if (q[k] !== undefined) opt[k] = /^\d+$/.test(q[k]) ? Number(q[k]) : q[k];
      }
      let resp;
      try {
        resp = await window.lib.mtop.request(opt);
      } catch (e) {
        // SDK 把业务失败（ret 不是 SUCCESS）当成拒绝抛出来，带着 ret；没有 ret 的是网络错误，结果未知
        if (e && Array.isArray(e.ret)) return { ok: false, rejected: true, status: 200, url: u.href, via: 'mtop', data: e, error: `mtop 返回 ${e.ret.join('；')}` };
        return { ok: false, unknown: true, url: u.href, via: 'mtop', error: `mtop 请求没有拿到返回（${(e && e.message) || e}），服务端可能已经收到并处理了` };
      }
      const okRet = !(resp && Array.isArray(resp.ret)) || /^SUCCESS/i.test(String(resp.ret[0]));
      return Object.assign({ ok: okRet, status: 200, url: u.href, via: 'mtop', data: resp }, okRet ? {} : { rejected: true, error: `mtop 返回 ${resp.ret.join('；')}` });
    }
    let res;
    let data;
    if (a.jsonp) {
      // JSONP：照页面的方式用 <script> 发（跨域接口没有 CORS 头，fetch 读不到返回），数据从回调的参数里拿
      try {
        data = await jsonpCall(u, a.jsonp, CONFIG.callTimeout || 30000);
      } catch (e) {
        return { ok: false, unknown: true, url: u.href, via: 'jsonp', error: `JSONP 请求没有拿到返回（${(e && e.message) || e}），服务端可能已经收到并处理了` };
      }
      res = { ok: true, status: 200, redirected: false, url: u.href };
    } else {
      const signal = CONFIG.callTimeout && typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(CONFIG.callTimeout) : undefined;
      try {
        // 凭据模式照页面当初发这个请求的方式（跨域接口的服务端返回 Access-Control-Allow-Origin: * 时带 Cookie 会被浏览器拦下）
        res = await fetch(u.href, { method: a.method, headers, body, credentials: a.credentials || 'include', signal, __prNoRewrite: true });
      } catch (e) {
        // 网络错误、超时、跨域被拦：请求可能已经到了服务端，结果未知
        return { ok: false, unknown: true, url: u.href, error: `请求没有拿到返回（${(e && e.message) || e}），服务端可能已经收到并处理了` };
      }
      const ct = res.headers.get('content-type') || '';
      const cd = res.headers.get('content-disposition') || '';
      // 返回的是文件（导出的表格、压缩包）：不当文字读（几兆的二进制读成乱码没有用），只说明是什么文件；文本类的（csv）内容照常给
      if (res.ok && (/attachment/i.test(cd) || (ct && !/json|^text\/|[/+]xml\b|javascript|ecmascript|x-www-form-urlencoded|csv|yaml/i.test(ct)))) {
        let blob;
        try { blob = await res.blob(); } catch (e) {
          return { ok: false, unknown: true, status: res.status, url: u.href, error: `返回内容没读完（${(e && e.message) || e}），服务端已经处理了请求` };
        }
        const star = cd.match(/filename\*\s*=\s*[^']*'[^']*'([^;]+)/i);
        const plain = cd.match(/filename\s*=\s*("([^"]*)"|[^;]+)/i);
        let filename = '';
        try { filename = star ? decodeURIComponent(star[1].trim()) : plain ? (plain[2] !== undefined ? plain[2] : plain[1]).trim() : ''; } catch (e) { filename = star ? star[1].trim() : ''; }
        if (!filename) filename = (typeof a.download === 'string' && a.download) || decodeURIComponent(u.pathname.split('/').pop() || '') || 'download';
        const file = { filename, type: ct.split(';')[0], size: blob.size };
        const texty = /csv|^text\/|json|[/+]xml\b/i.test(ct) && blob.size <= 512 * 1024;
        return { ok: true, status: res.status, url: u.href, file, data: texty ? await blob.text() : `（文件 ${filename}，${blob.size} 字节，${file.type || '类型未知'}：直接请求只确认服务端返回了文件，要拿到文件请用页面回放，浏览器会把它存到下载目录）` };
      }
      let text = '';
      try { text = await res.text(); } catch (e) {
        return { ok: false, unknown: true, status: res.status, url: u.href, error: `返回内容没读完（${(e && e.message) || e}），服务端已经处理了请求` };
      }
      data = text;
      const isJson = /json/i.test(ct) || /^\s*[[{]/.test(text);
      if (isJson) { try { data = JSON.parse(text); } catch (e) { /* keep text */ } }
    }
    const out = { ok: res.ok, status: res.status, url: u.href, data };
    if (a.jsonp) out.via = 'jsonp';
    const get = (o, p) => p.split('.').reduce((x, k) => (x && typeof x === 'object' ? x[k] : undefined), o);
    const shape = a.okShape;
    const obj = data && typeof data === 'object';
    // 被重定向到了别的路径（多半是登录页）、或者形态和录制时成功的完全对不上（不是 JSON、顶层键一个都没有）：
    // 不能算成功，也说不清有没有执行
    let moved = false;
    try { moved = res.redirected && new URL(res.url).pathname !== u.pathname; } catch (e) { /* ignore */ }
    const shapeBad = shape && shape.json && (!obj || (shape.array && !Array.isArray(data)) || (shape.keys && shape.keys.length && !Array.isArray(data) && !shape.keys.some((k) => k in data)));
    if (res.ok && (moved || shapeBad || (a.okSignals && (!obj || Object.keys(a.okSignals).some((k) => get(data, k) === undefined))))) {
      out.ok = false;
      out.unknown = true;
      out.error = moved ? `请求被重定向到 ${res.url}，可能登录失效了`
        : `返回的内容和录制时成功的结构不一样${a.okSignals ? `（缺少 ${Object.keys(a.okSignals).join('、')}）` : ''}，可能登录失效或被重定向到别的页面`;
    } else if (res.ok && a.okSignals && obj) {
      const bad = Object.entries(a.okSignals).filter(([k, v]) => {
        const x = get(data, k);
        if (v && typeof v === 'object' && v.prefix) return !String(x == null ? '' : x).toUpperCase().startsWith(v.prefix.toUpperCase());
        return x !== v && String(x) !== String(v);
      });
      if (bad.length) {
        out.ok = false;
        const msg = ['msg', 'message', 'errMsg', 'errmsg', 'error', 'error_msg', 'errorMessage', 'info', 'desc'].map((k) => data[k]).find((v) => typeof v === 'string' && v);
        out.rejected = true; // 服务端明确拒绝：请求没有生效
        out.error = `业务返回码和录制时成功的不同（${bad.map(([k, v]) => `${k}: 录制时 ${JSON.stringify(v)}，这次 ${JSON.stringify(get(data, k))}`).join('；')}）${msg ? '：' + msg : ''}`;
      }
    }
    if (usedLive.length) out.liveHeaders = usedLive;
    return out;
  }

  const tools = {};
  REC.apis.forEach((a) => { if (a.fn && !a.ignore) tools[a.fn] = (args) => call(a.name, args); });
  const PR = {
    name: REC.name,
    recording: REC,
    tools,
    params: PARAMS,
    apiParams: API_PARAMS,
    config: CONFIG,
    replay,
    cancel: () => { cancelled = true; },
    reset: clearProgress,
    api: {
      list: () => REC.apis.map((a) => ({ fn: a.fn, name: a.name, title: a.title, description: a.description, returns: a.returns, url: a.url, triggeredBy: a.triggeredBy, args: (a.toolArgs || []).map((t) => t.arg), params: API_PARAMS[a.name] || a.params })),
      call,
    },
  };
  window.__PR__ = PR;
  installNet();
  if (!CONFIG.autoRun) {
    log(`「${REC.name || ''}」已就绪：__PR__.replay() 开始回放，__PR__.tools.xxx(args) 调用接口，__PR__.api.list() 查看接口`);
    return { ready: true, steps: steps.length, apis: REC.apis.map((a) => a.name) };
  }
  return replay();
}
