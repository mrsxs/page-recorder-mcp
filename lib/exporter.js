// 把录制事件整理成：步骤 + 接口目录（含识别出的参数），并生成可在浏览器执行的脚本 / JSON / Markdown 说明。
/* global __pageRecorderRuntime */
const PR_EXPORTER = (() => {
  const SENSITIVE_HEADER = /authorization|token|secret|session|api[-_]?key|csrf|xsrf|signature|^sign$|cookie|ticket|credential/i;
  const DROP_HEADER = /^(cookie|content-length|host|connection|user-agent|accept-encoding|origin|referer|sec-|pragma|cache-control|priority)/i;
  const SENSITIVE_FIELD = /^(password|passwd|pwd|pass|secret|token|access_token|refresh_token|otp|pin)$/i;

  // ---------------- URL 模板（识别路径参数） ----------------
  function segKind(s) {
    if (!s) return null;
    if (/^\d+$/.test(s)) return 'id';
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return 'uuid';
    if (/^[0-9a-f]{16,}$/i.test(s)) return 'key';
    if (s.length >= 16 && /^[\w-]+$/.test(s) && (s.match(/\d/g) || []).length >= 3 && /[a-z]/i.test(s)) return 'key';
    return null;
  }
  function pathTemplate(pathname) {
    const used = {};
    const values = {};
    const tpl = pathname.split('/').map((s) => {
      const k = segKind(s);
      if (!k) return s;
      used[k] = (used[k] || 0) + 1;
      const name = used[k] > 1 ? `${k}${used[k]}` : k;
      try { values[name] = decodeURIComponent(s); } catch (e) { values[name] = s; }
      return `{${name}}`;
    }).join('/');
    return { tpl, values };
  }
  // 靠查询参数分发的接口（如 index.php?mod=stock.list）：路由参数算进接口身份，不同 mod 是不同接口
  const ROUTE_KEY = /^(mod|module|act|action|method|route|op|cmd|do|service|api|func|ctl|controller)$/i;
  const SCRIPT_ROUTE_KEY = /^(m|c|a|r|s)$/i;
  // 键按字母排序（参数顺序不同也是同一个接口）；同名参数出现多次时按全部取值（逗号连接）
  function routeOfParams(sp, script) {
    const out = {};
    for (const k of [...new Set(sp.keys())].sort()) {
      if (!ROUTE_KEY.test(k) && !(script && SCRIPT_ROUTE_KEY.test(k))) continue;
      const vs = sp.getAll(k);
      if (vs.every((v) => /^[A-Za-z_][\w.\-/:]{0,79}$/.test(v))) out[k] = vs.join(',');
    }
    return out;
  }
  const routeOf = (u) => routeOfParams(u.searchParams, /(\.(php|asp|aspx|jsp|do|action|cgi)|\/)$/i.test(u.pathname));
  const routeStr = (r) => {
    const s = Object.entries(r || {}).map(([k, v]) => `${k}=${v}`).join('&');
    return s ? '?' + s : '';
  };

  // ---------------- 参数识别 ----------------
  function flatten(v, prefix, out, depth) {
    out = out || {};
    depth = depth || 0;
    if (Object.keys(out).length >= 120) return out;
    if (Array.isArray(v) && v.length <= 50 && v.every((x) => x === null || typeof x !== 'object')) {
      out[prefix || '_raw'] = v; // 简单数组整体作为一个参数
      return out;
    }
    if (v && typeof v === 'object' && depth < 8) {
      const isArr = Array.isArray(v);
      const keys = isArr ? v.map((_, i) => i) : Object.keys(v);
      if (!keys.length) { out[prefix || '_raw'] = isArr ? [] : {}; return out; }
      for (const k of keys) flatten(v[k], isArr ? `${prefix}[${k}]` : prefix ? `${prefix}.${k}` : k, out, depth + 1);
      return out;
    }
    out[prefix || '_raw'] = v;
    return out;
  }
  function queryOf(u) {
    const q = {};
    u.searchParams.forEach((v, k) => {
      if (k in q) q[k] = [].concat(q[k], v);
      else q[k] = v;
    });
    return q;
  }
  function bodyParams(rb) {
    if (!rb) return { type: null, params: {} };
    if (rb.type === 'json') {
      return { type: 'json', params: rb.value !== null && typeof rb.value === 'object' ? flatten(rb.value, '') : { _raw: rb.value } };
    }
    if (rb.type === 'form') return { type: 'form', params: queryOf(new URL('http://x/?' + rb.value)) };
    if (rb.type === 'multipart') {
      const p = {};
      (rb.value || []).forEach(([k, v]) => { if (typeof v === 'string') p[k] = v; });
      return { type: 'multipart', params: p };
    }
    if (rb.type === 'text') {
      const t = String(rb.value || '');
      if (/^[^=&\s]+=[^&]*(&|$)/.test(t)) return { type: 'form', params: queryOf(new URL('http://x/?' + t)) };
      return { type: 'text', params: t ? { _raw: t } : {} };
    }
    return { type: rb.type, params: {} };
  }
  function maskFields(params, on) {
    if (!on) return params;
    const out = {};
    for (const [k, v] of Object.entries(params)) {
      out[k] = sensitiveKey(k) && v !== '' && v != null ? '' : v;
    }
    return out;
  }
  function maskDeep(v, on, depth) {
    if (!on || !v || typeof v !== 'object' || (depth || 0) > 10) return v;
    if (Array.isArray(v)) return v.map((x) => maskDeep(x, on, (depth || 0) + 1));
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = sensitiveKey(k) && typeof x !== 'object' ? '' : maskDeep(x, on, (depth || 0) + 1);
    return o;
  }
  // 导出原始请求时的脱敏：敏感请求头/响应头打码，请求体里的密码、token 等字段清空
  function maskHeaderValues(h, on) {
    if (!on) return h;
    const out = {};
    for (const [k, v] of Object.entries(h || {})) out[k] = SENSITIVE_HEADER.test(k) ? '***' : v;
    return out;
  }
  // 字段名按最后一段判断：user[password]、user.password 都算密码
  const sensitiveKey = (k) => SENSITIVE_FIELD.test(String(k).split(/[.[\]]/).filter(Boolean).pop() || '');
  function maskRequestBody(rb, on) {
    if (!on || !rb) return rb;
    if (rb.type === 'json') return Object.assign({}, rb, { value: maskDeep(rb.value, true) });
    if (rb.type === 'multipart') return Object.assign({}, rb, { value: (rb.value || []).map(([k, v]) => [k, sensitiveKey(k) && typeof v === 'string' ? '' : v]) });
    const t = String(rb.value || '');
    if (rb.type === 'form' || (rb.type === 'text' && /^[^=&\s]+=[^&]*(&|$)/.test(t))) {
      const sp = new URLSearchParams(t);
      const out = new URLSearchParams();
      let hit = false;
      for (const [k, v] of sp) { const s = sensitiveKey(k) && v !== ''; hit = hit || s; out.append(k, s ? '' : v); }
      return hit ? Object.assign({}, rb, { value: out.toString() }) : rb;
    }
    return rb;
  }
  function cleanHeaders(h, mask) {
    const out = {};
    for (const [k, v] of Object.entries(h || {})) {
      if (DROP_HEADER.test(k)) continue;
      out[k] = mask && SENSITIVE_HEADER.test(k) ? '***' : v;
    }
    return out;
  }

  // ---------------- 响应结构推断 ----------------
  function typeNode(v, depth) {
    if (v === null || v === undefined) return { t: 'null' };
    if (Array.isArray(v)) return { t: 'arr', n: v.length, item: v.length ? mergeNodes(v.slice(0, 20).map((x) => typeNode(x, depth + 1))) : null };
    if (typeof v === 'object') {
      if (depth > 6) return { t: 'obj', keys: null };
      const keys = {};
      const all = Object.keys(v);
      for (const k of all.slice(0, 40)) keys[k] = typeNode(v[k], depth + 1);
      return { t: 'obj', keys, more: all.length > 40 };
    }
    return { t: typeof v, ex: v };
  }
  function mergeNodes(nodes) {
    const objs = nodes.filter((n) => n.t === 'obj' && n.keys);
    if (objs.length && objs.length === nodes.length) {
      const keys = {};
      for (const o of objs) for (const [k, n] of Object.entries(o.keys)) (keys[k] = keys[k] || []).push(n);
      const out = { t: 'obj', keys: {} };
      for (const k of Object.keys(keys)) {
        const m = mergeNodes(keys[k]);
        if (keys[k].length < objs.length) m.opt = true;
        out.keys[k] = m;
      }
      return out;
    }
    const nonNull = nodes.filter((n) => n.t !== 'null');
    if (!nonNull.length) return { t: 'null' };
    const types = [...new Set(nonNull.map((n) => n.t))];
    const nullable = nonNull.length < nodes.length;
    if (types.length === 1) {
      if (types[0] === 'arr') {
        const items = nonNull.map((n) => n.item).filter(Boolean);
        return { t: 'arr', n: nonNull[0].n, item: items.length ? mergeNodes(items) : null, nullable };
      }
      if (types[0] === 'obj') return Object.assign({}, nonNull[0], { nullable });
      return Object.assign({}, nonNull[0], { nullable });
    }
    return { t: 'union', types: types.map((t) => (t === 'arr' ? 'array' : t === 'obj' ? 'object' : t)), nullable };
  }
  function renderSchema(node, maxLines) {
    maxLines = maxLines || 80;
    const lines = [];
    const pad = (n) => '  '.repeat(n);
    const keyName = (k) => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k));
    const ex = (n) => {
      if (n.ex === undefined) return '';
      if (typeof n.ex === 'string') return JSON.stringify(n.ex.length > 30 ? n.ex.slice(0, 30) + '…' : n.ex).replace(/\n/g, ' ');
      return String(n.ex);
    };
    const tn = (n) => {
      if (!n) return 'any';
      let base = n.t === 'union' ? n.types.join(' | ') : n.t === 'arr' ? `${tn(n.item)}[]` : n.t === 'obj' ? 'object' : n.t;
      if (n.nullable) base += ' | null';
      return base;
    };
    function walk(n, level, head) {
      if (lines.length >= maxLines) return;
      if (n.t === 'obj' && n.keys) {
        lines.push(pad(level) + head + '{');
        for (const [k, c] of Object.entries(n.keys)) walk(c, level + 1, `${keyName(k)}${c.opt ? '?' : ''}: `);
        if (n.more) lines.push(pad(level + 1) + '…');
        lines.push(pad(level) + '}' + (n.nullable ? ' | null' : ''));
      } else if (n.t === 'arr' && n.item && n.item.t === 'obj' && n.item.keys) {
        lines.push(pad(level) + head + `Array<{  // 本次 ${n.n} 项`);
        for (const [k, c] of Object.entries(n.item.keys)) walk(c, level + 1, `${keyName(k)}${c.opt ? '?' : ''}: `);
        lines.push(pad(level) + '}>' + (n.nullable ? ' | null' : ''));
      } else {
        const e = ex(n);
        lines.push(pad(level) + head + tn(n) + (e ? `  // 例: ${e}` : n.t === 'arr' ? `  // 本次 ${n.n} 项` : ''));
      }
    }
    walk(node, 0, '');
    if (lines.length >= maxLines) lines.push('…（结构过长已截断）');
    return lines;
  }
  function prune(v, depth, arrMax, strMax) {
    if (depth > 8) return '…';
    if (Array.isArray(v)) {
      const out = v.slice(0, arrMax).map((x) => prune(x, depth + 1, arrMax, strMax));
      if (v.length > arrMax) out.push(`…（共 ${v.length} 项，已省略 ${v.length - arrMax} 项）`);
      return out;
    }
    if (v && typeof v === 'object') {
      const o = {};
      for (const k of Object.keys(v)) o[k] = prune(v[k], depth + 1, arrMax, strMax);
      return o;
    }
    if (typeof v === 'string' && v.length > strMax) return v.slice(0, strMax) + '…';
    return v;
  }
  function sampleOf(rb, limitKB) {
    if (!rb) return null;
    const limit = limitKB * 1024;
    if (rb.type === 'json') {
      let s = prune(rb.value, 0, 3, 300);
      if (JSON.stringify(s).length > limit) s = prune(rb.value, 0, 1, 80);
      if (JSON.stringify(s).length > limit) return '（响应过大，已省略，见响应结构）';
      return s;
    }
    if (rb.type === 'text') return String(rb.value || '').slice(0, Math.min(limit, 2000)) + (rb.truncated || (rb.value || '').length > 2000 ? '…' : '');
    return `（${rb.type}${rb.mime ? ' ' + rb.mime : ''}${rb.size ? '，' + rb.size + ' 字节' : ''}）`;
  }

  // ---------------- 步骤描述 ----------------
  const short = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' '); return s.length > n ? s.slice(0, n) + '…' : s; };
  function stepDesc(s) {
    const d = (s.target && s.target.desc) || '页面';
    switch (s.type) {
      case 'navigate': return `打开页面 ${s.url}`;
      case 'url': return `页面地址变为 ${s.url}`;
      case 'click': return `点击 ${d}`;
      case 'fill': return `在 ${d} 中输入 ${s.param ? `{{${s.param}}}` : JSON.stringify(short(s.value, 40))}`;
      case 'select': return `在 ${d} 中选择 "${short(s.optionText || s.value, 40)}"`;
      case 'check': return `${s.checked ? '勾选' : '取消勾选'} ${d}`;
      case 'press': return `按下 ${s.key} 键${s.target ? `（${d}）` : ''}`;
      case 'scroll': return `滚动页面到 (${s.x}, ${s.y})`;
      case 'extract': return `提取 ${d} 的内容 → 结果字段 "${s.name}"`;
      case 'upload': return `上传文件到 ${d}（${(s.files || []).join(', ')}，需手动）`;
      default: return s.type;
    }
  }

  // ---------------- AI 文档 / 工具（每个接口拆成一个可调用的函数） ----------------
  const safeIdent = (s) => String(s || '').replace(/[^A-Za-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 48);
  function autoFn(a) {
    const rv = Object.values(a.route || {});
    const src = rv.length ? rv : a.pathTemplate.split('/').filter((w) => w && !/^\{.*\}$/.test(w) && !/^(api|v\d+|rest|service|gateway)$/i.test(w));
    const words = src.map((w) => w.replace(/\.(php|asp|aspx|jsp|do|action|cgi|html?)$/i, '')).join(' ').split(/[^A-Za-z0-9]+/).filter(Boolean).slice(-4);
    const base = [a.method.toLowerCase(), ...words.map((w) => w[0].toUpperCase() + w.slice(1))].join('');
    return safeIdent(base) || a.method.toLowerCase() + 'Api';
  }
  function jsonType(v) {
    if (Array.isArray(v)) return 'array';
    if (v === null) return 'string';
    if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
    if (typeof v === 'boolean') return 'boolean';
    if (typeof v === 'object') return 'object';
    return 'string';
  }
  function applyDocs(apis, aiDocs) {
    const docs = (aiDocs && aiDocs.apis) || {};
    const usedFn = {};
    for (const a of apis) {
      const d = docs[a.name] || {};
      a.title = d.title || '';
      a.description = d.description || '';
      a.returns = d.returns || '';
      a.ignore = !!d.ignore;
      let fn = safeIdent(d.fn) || autoFn(a);
      if (/^\d/.test(fn)) fn = 'api_' + fn;
      usedFn[fn] = (usedFn[fn] || 0) + 1;
      if (usedFn[fn] > 1) fn += usedFn[fn];
      a.fn = fn;
      const pd = d.params || {};
      // 工具参数：把 path/query/body 里识别出的参数摊平成一个参数列表
      const all = [];
      for (const sec of ['path', 'query', 'body']) for (const k of Object.keys(a.editParams[sec] || {})) all.push({ sec, key: k });
      const seenArg = {};
      a.toolArgs = all.map(({ sec, key }) => {
        let arg = String(key).replace(/\[(\d+)\]/g, '.$1').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 60) || sec;
        if (all.filter((x) => x.key === key).length > 1 || ['path', 'query', 'body', 'headers', 'rawBody'].includes(arg)) arg = `${sec}_${arg}`;
        seenArg[arg] = (seenArg[arg] || 0) + 1;
        if (seenArg[arg] > 1) arg += '_' + seenArg[arg];
        const v = a.editParams[sec][key];
        const orig = (a.params[sec] || {})[key];
        const desc = pd[`${sec}.${key}`] || pd[key] || '';
        if (desc) a.paramMeta[`${sec}.${key}`] = desc + (a.paramMeta[`${sec}.${key}`] ? '；' + a.paramMeta[`${sec}.${key}`] : '');
        return { arg, sec, key, type: jsonType(orig !== undefined ? orig : v), desc, default: v };
      });
    }
  }
  function toolSchemas(A) {
    return A.apis.filter((a) => !a.ignore).map((a) => {
      const properties = {};
      for (const t of a.toolArgs) {
        const p = { type: t.type };
        if (t.type === 'array') p.items = {};
        const parts = [];
        if (t.desc) parts.push(t.desc);
        parts.push(`${t.sec === 'path' ? '路径参数' : t.sec === 'query' ? 'Query 参数' : '请求体字段'} ${t.key}`);
        if (t.default !== undefined && t.default !== '') parts.push(`录制值: ${short(JSON.stringify(t.default), 60)}`);
        p.description = parts.join('；');
        properties[t.arg] = p;
      }
      return {
        name: a.fn,
        api: a.name,
        description: [a.title, a.description || `调用 ${a.name}`, a.returns ? `返回：${a.returns}` : ''].filter(Boolean).join('。'),
        inputSchema: { type: 'object', properties, additionalProperties: true },
      };
    });
  }

  // 让 AI 解读每个接口用途的提示词
  function aiPrompt(A) {
    const L = [];
    L.push('下面是一次网页操作录制的内容，包括用户的操作步骤和期间页面调用的接口。请逐个分析每个接口是做什么的，并给出可作为“工具函数”调用的说明。');
    L.push('');
    L.push(`页面：${A.startUrl}${A.title ? '（' + A.title + '）' : ''}`);
    L.push('');
    L.push('## 操作步骤');
    A.steps.forEach((s, i) => L.push(`${i + 1}. ${s.desc}${s.requests.length ? '  → ' + [...new Set(s.requests.map((r) => r.api))].join(', ') : ''}`));
    L.push('');
    L.push('## 接口');
    A.apis.forEach((a) => {
      L.push('');
      L.push(`### ${a.name}`);
      L.push(`示例 URL: ${short(a.url, 300)}`);
      L.push(`触发步骤: ${a.triggeredBy.map((x) => (x === 0 ? '页面加载' : x)).join(', ')}；状态 ${a.status}；${a.contentType}`);
      for (const sec of ['path', 'query', 'body']) {
        const p = a.params[sec];
        if (p && Object.keys(p).length) L.push(`${sec} 参数: ${short(JSON.stringify(p), 800)}`);
      }
      if (a.schema) L.push('响应结构:\n' + a.schema.slice(0, 40).join('\n'));
      else if (a.sample) L.push('响应: ' + short(typeof a.sample === 'string' ? a.sample : JSON.stringify(a.sample), 300));
    });
    L.push('');
    L.push('请只输出一个 JSON 对象（不要 markdown 代码块），格式：');
    L.push(`{
  "title": "给这个录制脚本起的简短中文名称（10 字以内）",
  "slug": "英文短名，snake_case，如 product_search_order",
  "description": "这个录制完成了什么业务流程（1-2 句）",
  "apis": {
    "<上面的接口名，原样>": {
      "fn": "英文 camelCase 函数名，如 searchProducts",
      "title": "中文短标题",
      "description": "这个接口做什么、什么时候调用",
      "params": { "<path|query|body>.<参数名>": "参数含义及取值说明" },
      "returns": "返回数据中关键字段的含义",
      "ignore": false
    }
  }
}`);
    L.push('对埋点、心跳、配置拉取等与业务无关的接口，ignore 设为 true。params 的键必须与上面给出的参数名一致（body 字段用 a.b[0].c 形式）。');
    return L.join('\n');
  }

  // ---------------- 分析：步骤、接口、参数 ----------------
  function analyze(events, settings, state, apiOverrides, aiDocs) {
    settings = settings || {};
    aiDocs = aiDocs || {};
    apiOverrides = apiOverrides || {};
    const evs = [...(events || [])].sort((a, b) => a.ts - b.ts);
    const startUrl = (state && state.startUrl) || (evs.find((e) => e.kind === 'step' && e.url) || {}).url || '';
    let mainHost = '';
    try { mainHost = new URL(startUrl).host; } catch (e) { /* ignore */ }

    // 步骤整理
    const rawSteps = evs.filter((e) => e.kind === 'step');
    const steps = [];
    for (const s of rawSteps) {
      const prev = steps[steps.length - 1];
      if (s.type === 'url' && prev && (prev.type === 'navigate' || prev.type === 'url') && prev.url === s.url) continue;
      if (s.type === 'navigate' && prev && prev.type === 'url' && prev.url === s.url && s.ts - prev.ts < 3000) { steps.pop(); }
      steps.push(Object.assign({}, s));
    }

    // 输入参数 PARAMS
    const params = {};
    const paramMetaFill = {};
    const usedNames = {};
    for (const s of steps) {
      if (s.type !== 'fill') continue;
      let base = short((s.target && s.target.label) || '', 20).replace(/["'`\\{}\n]/g, '').trim() || '输入';
      if (s.sensitive || (s.target && s.target.type === 'password')) base = base || '密码';
      usedNames[base] = (usedNames[base] || 0) + 1;
      const name = usedNames[base] > 1 ? `${base}_${usedNames[base]}` : base;
      s.param = name;
      params[name] = s.sensitive ? '' : s.value;
      paramMetaFill[name] = s.sensitive ? '密码/敏感输入，录制时未保存，回放前请填写' : `录制值；对应步骤「${stepDesc(Object.assign({}, s, { param: null }))}」`;
    }
    let extractN = 0;
    for (const s of steps) {
      if (s.type === 'extract') {
        extractN++;
        s.name = short(s.name || '', 30).replace(/["'`\\\n]/g, '') || `${(s.target && s.target.kind) || '数据'}${extractN}`;
      }
    }

    // 请求关联到步骤
    const reqs = evs.filter((e) => e.kind === 'request');
    const stepOf = (ts) => {
      let idx = -1;
      for (let i = 0; i < steps.length; i++) { if (steps[i].ts <= ts) idx = i; else break; }
      return idx;
    };

    // 接口分组
    const apiMap = new Map();
    for (const r of reqs) {
      let u;
      try { u = new URL(r.url); } catch (e) { continue; }
      const { tpl, values } = pathTemplate(u.pathname);
      const route = routeOf(u);
      const key = `${r.method} ${u.host}${tpl}${routeStr(route)}`;
      let a = apiMap.get(key);
      if (!a) {
        a = { key, method: r.method, host: u.host, origin: u.origin, pathTemplate: tpl, route, calls: [] };
        apiMap.set(key, a);
      }
      a.calls.push({ r, u, pathValues: values, step: stepOf(r.ts) });
    }

    // 接口字段和输入参数按“录制时填的值”对上（之后在弹窗里改了默认值，recordedValue 留着原值）
    // 两个输入框录到同一个值时分不清字段对应哪个，不自动关联（null 表示有歧义）
    const fillValues = Object.create(null);
    for (const s of steps) {
      if (s.type !== 'fill' || !s.param || s.sensitive) continue;
      const v = s.recordedValue !== undefined ? s.recordedValue : s.value;
      if (typeof v !== 'string' || !v.length) continue;
      fillValues[v] = v in fillValues && fillValues[v] !== s.param ? null : s.param;
    }

    const apis = [];
    for (const a of apiMap.values()) {
      const name = `${a.method} ${a.host === mainHost ? '' : a.host}${a.pathTemplate}${routeStr(a.route)}`;
      const okCall = a.calls.find((c) => c.r.status >= 200 && c.r.status < 300 && c.r.responseBody && c.r.responseBody.type === 'json') || a.calls.find((c) => c.r.status >= 200 && c.r.status < 300) || a.calls[0];
      const first = a.calls[0];
      const bp = bodyParams(first.r.requestBody);
      const orig = {
        path: Object.assign({}, first.pathValues),
        query: queryOf(first.u),
        body: maskFields(bp.params, settings.maskPasswords !== false),
      };
      // 多次调用时参数取值是否变化
      const meta = {};
      const seen = {};
      for (const c of a.calls) {
        const p = { path: c.pathValues, query: queryOf(c.u), body: bodyParams(c.r.requestBody).params };
        for (const sec of ['path', 'query', 'body']) {
          for (const [k, v] of Object.entries(p[sec] || {})) {
            const id = `${sec}.${k}`;
            (seen[id] = seen[id] || new Set()).add(JSON.stringify(v));
          }
        }
      }
      for (const [id, set] of Object.entries(seen)) {
        if (set.size > 1) meta[id] = `录制中出现多个取值: ${short([...set].slice(0, 4).join(', '), 80)}${set.size > 4 ? ' …' : ''}`;
      }
      for (const sec of ['body']) {
        for (const [k, v] of Object.entries(orig[sec])) {
          if (v === '' && bp.params[k] !== '' && bp.params[k] != null) meta[`${sec}.${k}`] = '敏感字段，已脱敏，需要时请填写';
        }
      }
      // 可编辑参数：录制值 → 关联输入框 {{参数}} → 用户在弹窗中的修改
      const edit = JSON.parse(JSON.stringify(orig));
      for (const sec of ['path', 'query', 'body']) {
        for (const [k, v] of Object.entries(edit[sec])) {
          if (typeof v === 'string' && fillValues[v] && !/^\d{1,2}$/.test(v)) {
            edit[sec][k] = `{{${fillValues[v]}}}`;
            meta[`${sec}.${k}`] = (meta[`${sec}.${k}`] ? meta[`${sec}.${k}`] + '；' : '') + `来自输入框参数 PARAMS["${fillValues[v]}"]`;
          }
        }
      }
      const ov = apiOverrides[name] || {};
      for (const sec of ['path', 'query', 'body']) {
        for (const [k, v] of Object.entries(ov[sec] || {})) {
          if (v && typeof v === 'object' && v.__deleted) delete edit[sec][k];
          else edit[sec][k] = v;
        }
      }
      const rb = okCall.r.responseBody;
      const reqBodyValue = first.r.requestBody && first.r.requestBody.type === 'json' ? maskDeep(first.r.requestBody.value, settings.maskPasswords !== false) : undefined;
      apis.push({
        name,
        method: a.method,
        host: a.host,
        origin: a.origin,
        pathTemplate: a.pathTemplate,
        route: a.route,
        url: first.r.url,
        pageUrl: first.r.frameUrl || first.r.pageUrl || undefined, // 发出这个接口的页面（iframe 里的就是 iframe 的页面）
        count: a.calls.length,
        status: okCall.r.status,
        error: okCall.r.error,
        contentType: ((okCall.r.responseHeaders || {})['content-type'] || '').split(';')[0],
        bodyType: bp.type,
        requestHeaders: cleanHeaders(first.r.requestHeaders, settings.maskHeaders !== false),
        requestBody: reqBodyValue,
        requestBodyTruncated: !!(first.r.requestBody && first.r.requestBody.truncated),
        params: orig,
        editParams: edit,
        overridden: !!apiOverrides[name],
        paramMeta: meta,
        triggeredBy: [...new Set(a.calls.map((c) => c.step + 1))],
        schema: rb && rb.type === 'json' ? renderSchema(typeNode(rb.value, 0)) : null,
        sample: sampleOf(rb, settings.sampleKB || 20),
        rawResponse: rb,
        firstTs: first.r.ts,
      });
    }
    apis.sort((x, y) => x.firstTs - y.firstTs);
    applyDocs(apis, aiDocs);
    const apiIndex = new Map(apis.map((a, i) => [a.name, i]));

    // 每个步骤触发的接口（用于回放等待和说明）
    // 步骤/请求所在的框架：顶层为空，iframe 为它的页面（源 + 路径 + hash 路由 + 路由参数）。回放时只能等到同一个框架里发出的请求
    const pageOf = (url) => {
      try {
        const u = new URL(url);
        const [hp, hq] = u.hash.split('?');
        return u.origin + u.pathname + routeStr(routeOf(u)) + hp + routeStr(routeOfParams(new URLSearchParams(hq || ''), false));
      } catch (e) { return ''; }
    };
    const ctxOfStep = (s) => (s.frame ? pageOf(s.frame.url) : '');
    const ctxOfReq = (r) => (r.frameUrl ? pageOf(r.frameUrl) : '');
    steps.forEach((s, i) => {
      let where = '';
      if (s.frame) { try { where = `（在 iframe ${new URL(s.frame.url).host} 中）`; } catch (e) { where = '（在 iframe 中）'; } }
      s.desc = stepDesc(s) + where + (s.optional ? '（可选：页面上没有就跳过）' : '');
      const next = steps[i + 1] ? steps[i + 1].ts : Infinity;
      const own = reqs.filter((r) => r.ts >= s.ts && r.ts < next);
      s.requests = [];
      const waitSet = new Set();
      for (const r of own) {
        let u;
        try { u = new URL(r.url); } catch (e) { continue; }
        const nm = `${r.method} ${u.host === mainHost ? '' : u.host}${pathTemplate(u.pathname).tpl}${routeStr(routeOf(u))}`;
        const ai = apiIndex.get(nm);
        if (ai == null) continue;
        s.requests.push({ api: nm, status: r.status, url: r.url });
        if (r.ts - s.ts < 5000 && waitSet.size < 5 && ctxOfReq(r) === ctxOfStep(s)) waitSet.add(ai);
      }
      s.waitFor = [...waitSet];
    });

    const title = (state && state.title) || '';
    let host = mainHost;
    const name = (state && state.name) || aiDocs.title || title || host || '未命名录制';
    const description = (state && state.description) || aiDocs.description || '';
    return { name, description, startUrl, mainHost, title, steps, apis, params, paramMetaFill, aiDocs, id: (state && state.id) || 'rec' + Date.now().toString(36) };
  }

  // ---------------- 生成脚本 ----------------
  const cm = (s) => String(s == null ? '' : s).replace(/\*\//g, '*\\/').replace(/[\r\n\u2028\u2029]+/g, ' ');
  const fmtTime = (ts) => {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  function paramLine(obj, n) {
    return Object.entries(obj || {}).slice(0, n || 12).map(([k, v]) => `${k}=${short(typeof v === 'string' ? v : JSON.stringify(v), 40)}`).join(', ');
  }

  function headerComment(A) {
    const L = [];
    L.push(`═══ ${A.name} ═══`);
    L.push('浏览器操作回放脚本（由 Page Recorder 生成）');
    if (A.description) L.push(`说明：${A.description}`);
    L.push(`录制时间：${fmtTime(Date.now())}`);
    L.push(`起始页面：${A.startUrl}`);
    if (A.title) L.push(`页面标题：${A.title}`);
    L.push(`共 ${A.steps.length} 个步骤，${A.apis.length} 个接口`);
    L.push('');
    L.push('【使用方法】');
    L.push(' 1. 在浏览器中打开起始页面（保持登录状态），按 F12 打开控制台（Console），粘贴整个脚本后回车。');
    L.push(' 2. 脚本会按录制的步骤自动操作页面，并返回 Promise<结果>：');
    L.push('    { ok, completed, total, extracted: Alt+点击标记的数据, responses: 各步骤触发的接口返回数据, log, error }');
    L.push(' 3. 遇到整页跳转时脚本会中断；新页面加载后再执行一次本脚本，会自动从断点继续。');
    L.push(' 4. 想换参数：修改下方 PARAMS（输入框内容）或 API_PARAMS（接口请求参数）后再执行。');
    L.push('    回放时页面发出的对应请求会被自动改写成新参数（只改写与录制值不同的字段）。');
    L.push(' 5. 执行后可通过 window.__PR__ 继续操作：');
    L.push('      __PR__.replay({ from: 0 })      从第 1 步重新回放（from/to 为步骤下标）');
    L.push('      __PR__.api.list()               查看接口及参数');
    const t0 = A.apis.find((a) => !a.ignore);
    if (t0) L.push(`      __PR__.tools.${t0.fn}({...})    每个接口都被拆成一个工具函数，参数见下方【接口说明】`);
    L.push(`      __PR__.api.call(${A.apis[0] ? JSON.stringify(A.apis[0].name) : "'GET /api/xxx'"}, { query: {...}, body: {...} })`);
    L.push('                                      直接调用接口（自动带上当前页面的 Cookie 登录态）');
    L.push(' 6. 自动化工具中使用：Playwright `await page.evaluate(脚本文本)`；Puppeteer 同理；');
    L.push('    CDP 用 Runtime.evaluate({ expression: 脚本文本, awaitPromise: true })。');
    L.push('');
    L.push('【操作步骤】');
    A.steps.forEach((s, i) => {
      L.push(`${String(i + 1).padStart(3)}. ${s.desc}`);
      const shown = new Set();
      for (const r of s.requests) {
        if (shown.has(r.api)) continue;
        shown.add(r.api);
        L.push(`       → ${r.api}  [${r.status == null ? '失败' : r.status}]`);
        if (shown.size >= 6) { L.push('       → …'); break; }
      }
    });
    L.push('');
    L.push('【接口说明】（参数可在 API_PARAMS 中修改）');
    A.apis.forEach((a) => {
      L.push('');
      L.push(`▸ ${a.name}${a.title ? '  —  ' + a.title : ''}${a.ignore ? '（无关接口）' : ''}`);
      if (a.description) L.push(`  用途：${a.description}`);
      if (!a.ignore) L.push(`  调用：__PR__.tools.${a.fn}({ ${a.toolArgs.slice(0, 4).map((t) => `${/^[A-Za-z_$][\w$]*$/.test(t.arg) ? t.arg : JSON.stringify(t.arg)}: …`).join(', ')}${a.toolArgs.length > 4 ? ', …' : ''} })`);
      if (a.returns) L.push(`  返回：${a.returns}`);
      L.push(`  示例 URL：${short(a.url, 200)}`);
      L.push(`  触发步骤：${a.triggeredBy.map((x) => (x === 0 ? '页面加载' : x)).join(', ')}   调用 ${a.count} 次   状态 ${a.status == null ? '失败 ' + (a.error || '') : a.status}   ${a.contentType}`);
      if (Object.keys(a.params.path).length) L.push(`  路径参数：${paramLine(a.params.path)}`);
      if (Object.keys(a.params.query).length) L.push(`  Query 参数：${paramLine(a.params.query)}`);
      if (Object.keys(a.params.body).length) L.push(`  请求体(${a.bodyType})：${paramLine(a.params.body)}${Object.keys(a.params.body).length > 12 ? ' …' : ''}`);
      const hk = Object.keys(a.requestHeaders).filter((k) => !/^accept/i.test(k));
      if (hk.length) L.push(`  请求头：${hk.map((k) => `${k}: ${short(a.requestHeaders[k], 30)}`).join('; ')}`);
      if (a.schema) {
        L.push('  响应结构：');
        a.schema.forEach((x) => L.push('    ' + x));
      } else if (a.sample) L.push(`  响应：${short(typeof a.sample === 'string' ? a.sample : JSON.stringify(a.sample), 200)}`);
    });
    return '/**\n' + L.map((x) => ' * ' + cm(x)).join('\n') + '\n */';
  }

  function fmtParams(A) {
    const L = ['const PARAMS = {'];
    const keys = Object.keys(A.params);
    if (!keys.length) L.push('  // 录制中没有输入操作');
    for (const k of keys) L.push(`  ${JSON.stringify(k)}: ${JSON.stringify(A.params[k])},  // ${cm(A.paramMetaFill[k])}`);
    L.push('};');
    return L.join('\n');
  }

  function fmtApiParams(A) {
    const L = ['const API_PARAMS = {'];
    if (!A.apis.length) L.push('  // 录制中没有抓到接口请求');
    A.apis.forEach((a) => {
      const secs = ['path', 'query', 'body'].filter((s) => Object.keys(a.editParams[s] || {}).length);
      const trig = a.triggeredBy.map((x) => (x === 0 ? '页面加载' : `步骤${x}`)).join('、');
      L.push(`  // ${cm(a.name)}${a.title ? ' ' + cm(a.title) : ''}（${trig}触发${a.bodyType && !['json', 'form', 'multipart', 'text'].includes(a.bodyType) ? `，请求体为 ${a.bodyType}，不可修改` : ''}${a.requestBodyTruncated ? '，请求体过大已截断' : ''}）`);
      if (!secs.length) { L.push(`  ${JSON.stringify(a.name)}: {},`); return; }
      L.push(`  ${JSON.stringify(a.name)}: {`);
      for (const s of secs) {
        const note = s === 'path' ? `  // 路径参数，对应 ${cm(a.pathTemplate)}` : s === 'body' ? `  // 请求体字段（${a.bodyType}），a.b[0].c 形式表示嵌套路径` : '';
        L.push(`    ${s}: {${note}`);
        for (const [k, v] of Object.entries(a.editParams[s])) {
          const m = a.paramMeta[`${s}.${k}`];
          let val = JSON.stringify(v);
          if (val === undefined) val = 'null';
          L.push(`      ${JSON.stringify(k)}: ${val},${m ? '  // ' + cm(m) : ''}`);
        }
        L.push('    },');
      }
      L.push('  },');
    });
    L.push('};');
    return L.join('\n');
  }

  function recordingData(A) {
    return {
      id: A.id,
      name: A.name,
      description: A.description,
      startUrl: A.startUrl,
      title: A.title,
      steps: A.steps.map((s) => {
        const o = { type: s.type, desc: s.desc };
        if (s.url && (s.type === 'navigate' || s.type === 'url')) o.url = s.url;
        if (s.target) o.target = { selectors: s.target.selectors, tag: s.target.tag, text: s.target.text || undefined, type: s.target.type || undefined, name: s.target.name || undefined, desc: s.target.desc };
        if (s.type === 'fill') o.value = `{{${s.param}}}`;
        if (s.type === 'select') { o.value = s.value; o.optionText = s.optionText; }
        if (s.type === 'check') o.checked = s.checked;
        if (s.type === 'press') { o.key = s.key; if (s.ctrl) o.ctrl = true; if (s.meta) o.meta = true; if (s.shift) o.shift = true; }
        if (s.type === 'scroll') { o.x = s.x; o.y = s.y; }
        if (s.type === 'extract') { o.name = s.name; if (s.sample) o.sample = short(s.sample, 120); }
        if (s.type === 'upload') o.files = s.files;
        if (s.waitFor && s.waitFor.length) o.waitFor = s.waitFor;
        if (s.optional) o.optional = true;
        if (s.frame) o.frame = { url: s.frame.url };
        return o;
      }),
      apis: A.apis.map((a) => ({
        name: a.name,
        fn: a.fn,
        title: a.title || undefined,
        description: a.description || undefined,
        returns: a.returns || undefined,
        ignore: a.ignore || undefined,
        toolArgs: a.toolArgs.map((t) => ({ arg: t.arg, sec: t.sec, key: t.key })),
        method: a.method,
        host: a.host,
        pathTemplate: a.pathTemplate,
        route: Object.keys(a.route || {}).length ? a.route : undefined,
        url: a.url,
        pageUrl: a.pageUrl,
        triggeredBy: a.triggeredBy,
        status: a.status,
        contentType: a.contentType,
        bodyType: a.bodyType,
        requestHeaders: a.requestHeaders,
        requestBody: a.requestBody,
        params: a.params,
        responseSample: a.sample,
      })),
    };
  }

  function buildScript(A) {
    const rt = typeof __pageRecorderRuntime === 'function' ? __pageRecorderRuntime.toString() : '';
    return [
      headerComment(A),
      '(async () => {',
      '',
      '// ==================== 1. 输入参数（录制时在输入框中填写的内容，可修改） ====================',
      fmtParams(A),
      '',
      '// ==================== 2. 接口请求参数（可修改） ====================',
      '// 修改后执行脚本：回放时页面发出的对应请求会被改写为这里的值（仅改写与录制值不同的字段，删掉某个键=从请求中移除该参数）。',
      '// 值可写成 "{{参数名}}" 引用上面的 PARAMS。__PR__.api.call() 直接调用接口时也使用这些值。',
      fmtApiParams(A),
      '',
      '// ==================== 3. 回放配置 ====================',
      'const CONFIG = {',
      '  autoRun: true,          // 执行脚本后立即回放；设为 false 则只注册 window.__PR__',
      '  resume: true,           // 整页跳转后再次执行脚本时，从断点继续',
      '  rewriteRequests: true,  // 按 API_PARAMS 改写页面发出的请求',
      '  waitRequests: true,     // 每步操作后等待该步录制时触发的接口返回',
      '  requestTimeout: 15000,  // 等待接口的超时时间(ms)，超时只警告不中断',
      '  findTimeout: 10000,     // 等待元素出现的超时时间(ms)',
      '  optionalTimeout: 3000,  // 可选步骤（如登录）等待元素的时间(ms)，等不到就跳过',
      '  stepDelay: 400,         // 步骤间隔(ms)',
      '  typing: false,          // true = 逐字输入（适合有联想/自动补全的输入框）',
      '  typingDelay: 40,',
      '  continueOnError: false, // 某步失败后是否继续',
      '  highlight: true,        // 高亮正在操作的元素',
      '  verbose: true,          // 在控制台打印过程',
      '};',
      '',
      '// ==================== 4. 录制数据（一般无需修改） ====================',
      'const RECORDING = ' + JSON.stringify(recordingData(A), null, 2) + ';',
      '',
      '// ==================== 5. 回放引擎 ====================',
      rt,
      '',
      'return __pageRecorderRuntime(RECORDING, PARAMS, API_PARAMS, CONFIG);',
      '})();',
      '',
    ].join('\n');
  }

  function buildSummary(A) {
    const L = [];
    L.push(`# ${A.name}`);
    if (A.description) { L.push(''); L.push(A.description); }
    L.push('');
    L.push(`- 起始页面：${A.startUrl}`);
    L.push(`- ${A.steps.length} 个步骤，${A.apis.length} 个接口`);
    L.push('');
    L.push('## 操作步骤');
    A.steps.forEach((s, i) => {
      L.push(`${i + 1}. ${s.desc}`);
      [...new Set(s.requests.map((r) => r.api))].slice(0, 6).forEach((n) => L.push(`   - 触发接口 \`${n}\``));
    });
    if (Object.keys(A.params).length) {
      L.push('');
      L.push('## 输入参数');
      for (const [k, v] of Object.entries(A.params)) L.push(`- \`${k}\`: ${JSON.stringify(v)}`);
    }
    L.push('');
    L.push('## 接口');
    A.apis.forEach((a) => {
      L.push('');
      L.push(`### \`${a.name}\`${a.title ? ' — ' + a.title : ''}`);
      if (a.description) L.push(`- 用途：${a.description}`);
      if (!a.ignore) L.push(`- 工具函数：\`__PR__.tools.${a.fn}(args)\``);
      if (a.returns) L.push(`- 返回：${a.returns}`);
      L.push(`- 示例：\`${a.url}\``);
      L.push(`- 状态：${a.status}，${a.contentType}，调用 ${a.count} 次，触发于步骤 ${a.triggeredBy.join(', ')}`);
      const p = a.editParams;
      if (Object.keys(p.path).length || Object.keys(p.query).length || Object.keys(p.body).length) {
        L.push('- 请求参数：');
        L.push('```json');
        L.push(JSON.stringify(p, null, 2));
        L.push('```');
      }
      if (a.schema) {
        L.push('- 响应结构：');
        L.push('```ts');
        L.push(a.schema.join('\n'));
        L.push('```');
      }
      if (a.sample && typeof a.sample === 'object') {
        L.push('- 响应示例：');
        L.push('```json');
        L.push(JSON.stringify(a.sample, null, 2).slice(0, 4000));
        L.push('```');
      }
    });
    return L.join('\n');
  }

  const DEFAULT_CONFIG = {
    autoRun: true, resume: true, rewriteRequests: true, waitRequests: true, requestTimeout: 15000,
    findTimeout: 10000, optionalTimeout: 3000, stepDelay: 400, typing: false, typingDelay: 40, continueOnError: false, highlight: true, verbose: true,
  };
  function bundleOf(A) {
    const apiParams = {};
    A.apis.forEach((a) => { apiParams[a.name] = a.editParams; });
    return { id: A.id, name: A.name, description: A.description, recording: recordingData(A), params: A.params, apiParams, config: Object.assign({}, DEFAULT_CONFIG), tools: toolSchemas(A) };
  }
  function build(events, settings, state, apiOverrides, aiDocs) {
    const A = analyze(events, settings, state, apiOverrides, aiDocs);
    const raw = {
      generator: 'Page Recorder',
      exportedAt: new Date().toISOString(),
      startUrl: A.startUrl,
      name: A.name,
      description: A.description,
      title: A.title,
      steps: A.steps,
      tools: toolSchemas(A),
      apis: A.apis.map((a) => Object.assign({}, a, { rawResponse: undefined })),
      requests: (events || []).filter((e) => e.kind === 'request').sort((a, b) => a.ts - b.ts).map((r) => Object.assign({}, r, {
        requestHeaders: maskHeaderValues(r.requestHeaders, (settings || {}).maskHeaders !== false),
        responseHeaders: maskHeaderValues(r.responseHeaders, (settings || {}).maskHeaders !== false),
        requestBody: maskRequestBody(r.requestBody, (settings || {}).maskPasswords !== false),
      })),
      params: A.params,
    };
    return { analysis: A, script: buildScript(A), raw, summary: buildSummary(A), bundle: bundleOf(A), tools: toolSchemas(A), prompt: aiPrompt(A) };
  }

  return { analyze, build, pathTemplate, stepDesc, aiPrompt, toolSchemas };
})();
if (typeof module !== 'undefined') module.exports = PR_EXPORTER;
