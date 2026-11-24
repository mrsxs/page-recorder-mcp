// 把录制事件整理成：步骤 + 接口目录（含识别出的参数），并生成可在浏览器执行的脚本 / JSON / Markdown 说明。
/* global __pageRecorderRuntime */
const PR_EXPORTER = (() => {
  // 单选参数填什么：显示文字在组里唯一就填文字，否则值唯一就填值（回放和直接请求的判断都按“文字唯一→值唯一”找选项）
  // （和 background.js 的 radioPick、runtime 的 radioFor 同一个规则；都不行就用序号 #N）
  const radioPick = (options, t) => {
    const byText = options.map((o, i) => (String(o[1]).trim() === String(t).trim() ? i : -1)).filter((i) => i >= 0);
    if (byText.length === 1) return byText[0];
    const byVal = options.map((o, i) => (o[0] === t ? i : -1)).filter((i) => i >= 0);
    if (byVal.length === 1) return byVal[0];
    const n = !byText.length && !byVal.length && String(t).match(/^#(\d+)$/);
    return n && +n[1] >= 1 && +n[1] <= options.length ? +n[1] - 1 : -1;
  };
  // index：录制/弹窗里选中的是组里第几个（文字和值都一样的选项只能靠它区分）；没有时只在文字+值唯一时才认，分不清就原样给文字，回放会明确报错
  const radioToken = (options, label, value, index) => {
    let want = Number.isInteger(index) && options[index] && options[index][1] === label ? index : -1;
    if (want < 0) { const m = options.map((o, i) => (o[0] === value && o[1] === label ? i : -1)).filter((i) => i >= 0); if (m.length === 1) want = m[0]; }
    if (want < 0) return label || value;
    return [label, value, `#${want + 1}`].find((t) => t != null && radioPick(options, t) === want) ?? (label || value);
  };
  const SENSITIVE_HEADER = /authorization|token|secret|session|api[-_]?key|csrf|xsrf|signature|^sign$|cookie|ticket|credential|auth/i;
  const DROP_HEADER = /^(cookie|content-length|host|connection|user-agent|accept-encoding|origin|referer|sec-|pragma|cache-control|priority)/i;
  // 字段名（最后一段，去掉 _ - 后小写）里含这些词的算敏感：loginPwd、userPassword、j_password、access_token、x_sign……
  const SENSITIVE_PART = /password|passwd|passwort|pwd|passcode|secret|token|csrf|xsrf|credential|captcha|apikey|accesskey|privatekey|authorization|signature|sessionid|authcode|authkey|jwt|otp$|smscode|verifycode/;
  const SENSITIVE_WORD = /^(pass|pin|sign|sid|auth|session|ticket|vcode|otp)$/;
  // 敏感值的样子：长串 base64 / hex / JWT（非标准请求头里出现就打码）
  const TOKEN_VALUE = /^(?:Bearer\s+)?(?:[A-Za-z0-9+/_-]{24,}={0,2}|[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/;
  // 密码在录制时按值替换成的占位符（content script 把明文只交给后台内存，入库前替换），导出时关联到密码参数
  const SECRET_MARK = /__PR_SECRET_([a-z0-9]+)__/;
  // 入库时按字段名脱敏留下的标记（导出时变成空串，并知道这里原来有值）
  const MASKED = '__PR_MASKED__';

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
  // 网关式接口（淘宝 mtop、GraphQL、JSON-RPC、按 action 分发的）：同一个地址，真正的操作写在请求体里。
  // 取出操作标识算进接口身份：查标签数量和查商品列表是两个接口。和回放引擎的 opOf 规则一致
  const OP_KEYS = /^(operationName|action|cmd|op|operation|optType|opType)$/;
  const OP_URL_KEYS = /^(url|path|uri)$/;
  const OP_QS = /^(mod|module|act|action|method|op|opt|optType|cmd|func|service|operation)$/i;
  const opIdent = (v) => typeof v === 'string' && /^[A-Za-z_][\w.\-/:]{0,79}$/.test(v);
  function opOfObj(o, depth) {
    if (!o || typeof o !== 'object' || Array.isArray(o) || depth > 2) return '';
    if (opIdent(o.operationName)) return 'op=' + o.operationName;
    if (typeof o.query === 'string') { const m = o.query.match(/^\s*(query|mutation|subscription)\s+([A-Za-z_]\w*)/); if (m) return 'op=' + m[2]; }
    if (opIdent(o.method) && (o.jsonrpc || /[./]/.test(o.method))) return 'method=' + o.method; // order.list 这种带命名空间的（付款方式 alipay 不算）
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
    // 包在 data / params 等字段里的 JSON 字符串（mtop 的 data）
    for (const k of ['data', 'params', 'body', 'payload', 'request', 'req']) {
      let x = o[k];
      if (typeof x === 'string' && /^\s*[{[]/.test(x)) { try { x = JSON.parse(x); } catch (e) { x = null; } }
      const r = opOfObj(x, depth + 1);
      if (r) return r;
    }
    return '';
  }
  function opOf(rb) {
    if (!rb || rb.value == null) return '';
    let o = null;
    if (rb.type === 'json') o = rb.value;
    else if (rb.type === 'multipart') { o = {}; (rb.value || []).forEach(([k, v]) => { if (typeof v === 'string') o[k] = v; }); }
    else if (typeof rb.value === 'string') {
      const t = rb.value.trim();
      if (/^[{[]/.test(t)) { try { o = JSON.parse(t); } catch (e) { o = null; } }
      else if (/^[^=&\s]+=[^&]*(&|$)/.test(t)) { o = {}; new URLSearchParams(t).forEach((v, k) => { o[k] = v; }); }
    }
    return opOfObj(o, 0).slice(0, 120);
  }
  // 接口名：方法 + 主机（主站省略）+ 路径模板 + 路由参数 + 请求体里的操作
  function apiNameOf(r, u, mainHost) {
    const op = opOf(r.requestBody);
    return `${r.method} ${u.host === mainHost ? '' : u.host}${pathTemplate(u.pathname).tpl}${routeStr(routeOf(u))}${op ? ' #' + op : ''}`;
  }
  const routeStr = (r) => {
    const s = Object.entries(r || {}).map(([k, v]) => `${k}=${v}`).join('&');
    return s ? '?' + s : '';
  };

  // ---------------- 参数识别 ----------------
  // 键名里本来就带点号、方括号的（"filter.name"）转义成 filter\.name，和嵌套路径 filter.name 区分开
  const escKey = (k) => String(k).replace(/[\\.[\]]/g, '\\$&');
  // 路径 → 逐层的键：a.b[0].c、filter\.name；和回放引擎的 pathTokens 规则一致
  function keyTokens(p) {
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
      for (const k of keys) flatten(v[k], isArr ? `${prefix}[${k}]` : prefix ? `${prefix}.${escKey(k)}` : escKey(k), out, depth + 1);
      return out;
    }
    out[prefix || '_raw'] = v;
    return out;
  }
  const setOwn = (o, k, v) => Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
  function queryOf(u) {
    const q = {};
    const sp = u instanceof URLSearchParams ? u : u.searchParams;
    sp.forEach((v, k) => {
      if (Object.prototype.hasOwnProperty.call(q, k)) setOwn(q, k, [].concat(q[k], v));
      else setOwn(q, k, v);
    });
    return q;
  }
  function bodyParams(rb) {
    if (!rb) return { type: null, params: {} };
    if (rb.type === 'json') {
      return { type: 'json', params: rb.value !== null && typeof rb.value === 'object' ? flatten(rb.value, '') : { _raw: rb.value } };
    }
    if (rb.type === 'form') return { type: 'form', params: rb.value != null ? queryOf(new URLSearchParams(String(rb.value))) : {} };
    if (rb.type === 'multipart') {
      const p = {};
      (rb.value || []).forEach(([k, v]) => { if (typeof v === 'string') setOwn(p, k, v); });
      return { type: 'multipart', params: p };
    }
    if (rb.type === 'text') {
      const t = String(rb.value || '');
      if (/^[^=&\s]+=[^&]*(&|$)/.test(t)) return { type: 'form', params: queryOf(new URLSearchParams(t)) };
      return { type: 'text', params: t ? { _raw: t } : {} };
    }
    return { type: rb.type, params: {} };
  }
  function maskFields(params, on) {
    if (!on) return params;
    const out = {};
    for (const [k, v] of Object.entries(params)) {
      out[k] = v === MASKED || (sensitiveKey(k) && v !== '' && v != null && !SECRET_MARK.test(String(v))) ? '' : v;
    }
    return out;
  }
  // 请求入库前脱敏（录制时调用）：密码按值换成占位符（URL、请求体、请求头里都换），
  // 名字像密码、令牌、签名的查询参数和请求体字段换成 MASKED。secrets：[{ id, value }]
  // maskHdr：名字是鉴权、令牌、签名一类的请求头入库时就换成 ***（头名留着，直接调用时用页面最新的值补）
  function scrubRequest(r, secrets, on, maskHdr) {
    if (!r) return r;
    if (!on) {
      if (!maskHdr || !r.requestHeaders) return r;
      const h = {};
      for (const [k, v] of Object.entries(r.requestHeaders)) h[k] = SENSITIVE_HEADER.test(k) && v ? '***' : v;
      return Object.assign({}, r, { requestHeaders: h });
    }
    const list = (secrets || []).filter((x) => x && typeof x.value === 'string' && x.value.length >= 3);
    const swap = (s) => {
      if (typeof s !== 'string' || !list.length) return s;
      for (const { id, value } of list) {
        const mark = `__PR_SECRET_${id}__`;
        // 原文、URL 编码、表单编码（空格是 +）、JSON 转义
        const forms = [value, encodeURIComponent(value), new URLSearchParams({ x: value }).toString().slice(2), JSON.stringify(value).slice(1, -1)];
        for (const form of new Set(forms)) if (form) s = s.split(form).join(mark);
      }
      return s;
    };
    const deep = (v) => redactTree(v, MASKED, swap);
    const deepJsonStr = (v) => redactTree(v, MASKED, swap);
    const formMask = (t) => {
      const sp = new URLSearchParams(t);
      const out = new URLSearchParams();
      for (const [k, v0] of sp) {
        const v = swap(v0);
        out.append(k, sensitiveKey(k) && v !== '' && !SECRET_MARK.test(v) ? MASKED : deepJsonStr(v));
      }
      return out.toString();
    };
    const out = Object.assign({}, r);
    for (const key of ['url', 'pageUrl', 'frameUrl']) {
      if (typeof r[key] === 'string') out[key] = redactUrl(swap(r[key]), MASKED, swap);
    }
    if (r.requestHeaders) {
      out.requestHeaders = {};
      for (const [k, v] of Object.entries(r.requestHeaders)) out.requestHeaders[k] = maskHdr && SENSITIVE_HEADER.test(k) && v ? '***' : swap(v);
    }
    if (r.responseHeaders) {
      out.responseHeaders = Object.fromEntries(Object.entries(r.responseHeaders).map(([k, v]) =>
        [k, maskHdr && secretHeader(k, v) ? '***' : /^(location|referer)$/i.test(k) ? redactUrl(swap(v), MASKED, swap) : swap(v)]));
    }
    const rb = r.requestBody;
    if (rb && rb.value != null) {
      let value = rb.value;
      if (rb.type === 'json') value = deep(value);
      else if (rb.type === 'multipart') value = (value || []).map(([k, v]) => [k, typeof v === 'string' ? (sensitiveKey(k) && v && !SECRET_MARK.test(swap(v)) ? MASKED : deepJsonStr(swap(v))) : v]);
      else if (typeof value === 'string') {
        value = swap(value);
        if (rb.type === 'form' || (rb.type === 'text' && /^[^=&\s]+=[^&]*(&|$)/.test(value))) value = formMask(value);
        else value = deepJsonStr(value);
      }
      out.requestBody = Object.assign({}, rb, { value });
    }
    if (r.responseBody) {
      const rb = r.responseBody;
      if (rb.type === 'json') out.responseBody = { ...rb, value: deep(rb.value) };
      else if (rb.type === 'text') {
        out.responseBody = { ...rb, value: rb.truncated ? '' : maskTextBody(rb.value, deepJsonStr, (k, v) => sensitiveKey(k) && v ? MASKED : deepJsonStr(v)) };
      }
    }
    return out;
  }
  // 导出给人看、给 AI 看的地址：查询参数、userinfo 密码与 hash 里的令牌打码
  function redactUrl(url, mask, transform) {
    if (typeof url !== 'string') return url;
    try {
      const u = new URL(url);
      let hit = false;
      if (u.password && !SECRET_MARK.test(u.password)) { u.password = mask; hit = true; }
      const field = (k, original) => {
        const v = transform(original);
        return sensitiveKey(k) && v && !SECRET_MARK.test(v) ? mask : redactTree(v, mask, transform);
      };
      const params = (text) => {
        if (!text.includes('=')) return text;
        const input = new URLSearchParams(text);
        const output = new URLSearchParams();
        let changed = false;
        for (const [k, v] of input) {
          const value = field(k, v);
          output.append(k, value);
          changed ||= value !== v;
        }
        return changed ? output.toString() : text;
      };
      const search = u.search.slice(1);
      const maskedSearch = params(search);
      if (maskedSearch !== search) { u.search = maskedSearch; hit = true; }
      const hash = u.hash.slice(1);
      const at = hash.indexOf('?');
      const maskedHash = at < 0 ? params(hash) : params(hash.slice(0, at)) + '?' + params(hash.slice(at + 1));
      if (maskedHash !== hash) { u.hash = maskedHash; hit = true; }
      return hit ? u.href : url;
    } catch (e) { return url; }
  }
  function maskUrl(url, on) {
    return on ? redactUrl(url, '***', (v) => v) : url;
  }
  function redactTree(v, mask, transform, depth = 0) {
    if (depth > 24) return mask;
    if (typeof v === 'string') {
      const s = transform(v);
      if (s === MASKED) return mask;
      if (s.length > 500000 || !/^\s*[[{]/.test(s)) return s;
      try {
        const parsed = JSON.parse(s);
        const redacted = JSON.stringify(redactTree(parsed, mask, transform, depth + 1));
        return redacted === JSON.stringify(parsed) ? s : redacted;
      } catch (e) { return s; }
    }
    if (!v || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map((x) => redactTree(x, mask, transform, depth + 1));
    return Object.fromEntries(Object.entries(v).map(([k, x]) => {
      const known = typeof x === 'string' && SECRET_MARK.test(transform(x));
      return [k, sensitiveKey(k) && x !== '' && x != null && !known ? mask : redactTree(x, mask, transform, depth + 1)];
    }));
  }
  function maskDeep(v, on) {
    return on ? redactTree(v, '', (x) => x) : v;
  }
  function maskTextBody(text, transform, field) {
    if (typeof text !== 'string') return text;
    if (!/^[^=&\s]+=[^&]*(&|$)/.test(text) || /^\s*[[{]/.test(text)) return transform(text);
    const entries = [...new URLSearchParams(text)];
    const masked = entries.map(([k, v]) => [k, field(k, v)]);
    return masked.some((pair, i) => pair[1] !== entries[i][1]) ? new URLSearchParams(masked).toString() : text;
  }
  function maskStepUrls(step, on) {
    if (!on) return step;
    const out = { ...step };
    if (typeof out.url === 'string') out.url = maskUrl(out.url, true);
    if (out.frame?.url) out.frame = { ...out.frame, url: maskUrl(out.frame.url, true) };
    if (Array.isArray(out.members) && out.members.some((x) => x && typeof x === 'object')) {
      out.members = out.members.map((x) => x && typeof x === 'object' ? maskStepUrls(x, true) : x);
    }
    return out;
  }
  // 导出原始请求时的脱敏：敏感请求头/响应头打码（按名字，非标准头再按值的样子），请求体里的密码、token 等字段清空
  const STD_HEADER = /^(accept|accept-language|content-type|content-language|x-requested-with|user-agent|referer|origin|cache-control|pragma|if-none-match|if-modified-since|etag|date|expires|last-modified|content-encoding|vary|server|location|range)$/i;
  const secretHeader = (k, v) => SENSITIVE_HEADER.test(k) || (!STD_HEADER.test(k) && typeof v === 'string' && TOKEN_VALUE.test(v.trim()));
  function maskHeaderValues(h, on) {
    if (!on) return h;
    return Object.fromEntries(Object.entries(h || {}).map(([k, v]) =>
      [k, secretHeader(k, v) ? '***' : /^(referer|location)$/i.test(k) ? maskUrl(v, true) : v]));
  }
  // 字段名按最后一段判断：user[password]、user.password、loginPwd、userPassword 都算密码
  const sensitiveKey = (k) => {
    const last = String(keyTokens(k).filter((x) => typeof x === 'string').pop() || '').toLowerCase().replace(/[_\-\s]/g, '');
    return !!last && (SENSITIVE_PART.test(last) || SENSITIVE_WORD.test(last));
  };
  function maskJsonStr(s) {
    if (typeof s !== 'string' || s.length > 200000 || !/^\s*[{[]/.test(s)) return null;
    try {
      const parsed = JSON.parse(s);
      if (!parsed || typeof parsed !== 'object') return null;
      const masked = maskDeep(parsed, true);
      const outStr = JSON.stringify(masked);
      return outStr === JSON.stringify(parsed) ? null : outStr;
    } catch (e) { return null; }
  }
  function maskRequestBody(rb, on) {
    if (!on || !rb) return rb;
    if (rb.type === 'json') return Object.assign({}, rb, { value: maskDeep(rb.value, true) });
    if (rb.type === 'multipart') {
      return Object.assign({}, rb, {
        value: (rb.value || []).map(([k, v]) => {
          if (typeof v !== 'string') return [k, v];
          if (sensitiveKey(k)) return [k, ''];
          const m = maskJsonStr(v);
          return [k, m !== null ? m : v];
        }),
      });
    }
    const t = String(rb.value || '');
    if (rb.type === 'form' || (rb.type === 'text' && /^[^=&\s]+=[^&]*(&|$)/.test(t))) {
      const sp = new URLSearchParams(t);
      const out = new URLSearchParams();
      let hit = false;
      for (const [k, v] of sp) {
        if (sensitiveKey(k) && v !== '') { hit = true; out.append(k, ''); continue; }
        const m = maskJsonStr(v);
        if (m !== null) { hit = true; out.append(k, m); } else out.append(k, v);
      }
      return hit ? Object.assign({}, rb, { value: out.toString() }) : rb;
    }
    if (rb.type === 'text') {
      const m = maskJsonStr(t);
      if (m !== null) return Object.assign({}, rb, { value: m });
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
      const keys = Object.create(null);
      for (const o of objs) for (const [k, n] of Object.entries(o.keys)) (keys[k] = keys[k] || []).push(n);
      const out = { t: 'obj', keys: {} };
      for (const k of Object.keys(keys)) {
        const m = mergeNodes(keys[k]);
        if (keys[k].length < objs.length) m.opt = true;
        setOwn(out.keys, k, m);
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
      case 'dblclick': return `双击 ${d}`;
      case 'contextmenu': return `右键点击 ${d}`;
      case 'fill': return `${s.pick === 'date' ? '设置日期' : s.pick === 'choice' ? '选择' : '在'} ${d} ${s.pick ? '为' : '中输入'} ${s.param ? `{{${s.param}}}` : JSON.stringify(short(s.value, 40))}`;
      case 'select': return `在 ${d} 中选择 ${s.param ? `{{${s.param}}}（录制时 "${short(s.optionText || s.value, 30)}"）` : `"${short(s.optionText || s.value, 40)}"`}`;
      case 'check':
        if (s.param && Array.isArray(s.options)) return `选择单选项${s.groupLabel ? ` "${short(s.groupLabel, 20)}"` : ''} 为 {{${s.param}}}（录制时 "${short(s.optionText || s.value, 30)}"）`;
        if (s.param) return `${d} 设为 {{${s.param}}}（录制时${s.checked ? '勾选' : '不勾选'}）`;
        return `${s.checked ? '勾选' : '取消勾选'} ${d}`;
      case 'press': return `按下 ${[s.ctrl && 'Ctrl', s.meta && 'Cmd', s.alt && 'Alt', s.shift && 'Shift', s.key === ' ' ? '空格' : s.key].filter(Boolean).join('+')} 键${s.target ? `（${d}）` : ''}`;
      case 'scroll': return s.target ? `滚动 ${d} 到 (${s.x}, ${s.y})` : `滚动页面到 (${s.x}, ${s.y})`;
      case 'drag': return `把 ${d} 拖到 ${(s.to && s.to.desc) || `偏移 (${s.dx}, ${s.dy})`}`;
      case 'extract': return `提取 ${d} 的内容 → 结果字段 "${s.name}"`;
      case 'upload': return `上传文件到 ${d}${s.param ? `：{{${s.param}}}` : ''}（录制时 ${(s.files || []).join(', ')}）`;
      default: return s.type;
    }
  }

  // ---------------- AI 文档 / 工具（每个接口拆成一个可调用的函数） ----------------
  const safeIdent = (s) => String(s || '').replace(/[^A-Za-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 48);
  function autoFn(a) {
    const rv = Object.values(a.route || {});
    // 网关式接口按请求体里的操作起名（url=/taobao/manager/async.htm?optType=queryTabNum → async queryTabNum）
    const opWords = a.op ? (() => {
      const v = a.op.replace(/^[^=]+=/, '');
      const [p, q] = v.split('?');
      const last = (p.split('/').filter(Boolean).pop() || '').replace(/\.(php|asp|aspx|jsp|do|action|cgi|html?|json)$/i, '');
      return [last, ...(q ? q.split('&').map((x) => x.split('=')[1]) : [])].filter(Boolean);
    })() : [];
    const src = opWords.length ? opWords : rv.length ? rv : a.pathTemplate.split('/').filter((w) => w && !/^\{.*\}$/.test(w) && !/^(api|v\d+|rest|service|gateway)$/i.test(w));
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
    const usedFn = new Set();
    for (const a of apis) {
      const d = docs[a.name] || {};
      a.title = d.title || '';
      a.description = d.description || '';
      a.returns = d.returns || '';
      a.ignore = !!d.ignore;
      const baseFn0 = safeIdent(d.fn) || autoFn(a);
      const baseFn = /^\d/.test(baseFn0) ? 'api_' + baseFn0 : baseFn0;
      let fn = baseFn;
      for (let idx = 2; usedFn.has(fn); idx++) fn = baseFn + idx;
      usedFn.add(fn);
      a.fn = fn;
      const pd = d.params || {};
      // 工具参数：把 path/query/body 里识别出的参数摊平成一个参数列表
      const all = [];
      for (const sec of ['path', 'query', 'body']) for (const k of Object.keys(a.editParams[sec] || {})) all.push({ sec, key: k });
      const seenArg = new Set();
      const usedKeys = new Map();
      for (const { key } of all) usedKeys.set(key, (usedKeys.get(key) || 0) + 1);
      const uniqueArg = (base) => {
        let arg = base;
        for (let idx = 2; seenArg.has(arg); idx++) arg = `${base}_${idx}`;
        seenArg.add(arg);
        return arg;
      };
      a.toolArgs = all.map(({ sec, key }) => {
        let baseArg = String(key).replace(/\[(\d+)\]/g, '.$1').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 60) || sec;
        if (usedKeys.get(key) > 1 || ['path', 'query', 'body', 'headers', 'rawBody'].includes(baseArg)) baseArg = `${sec}_${baseArg}`;
        const arg = uniqueArg(baseArg);
        const v = a.editParams[sec][key];
        const orig = (a.params[sec] || {})[key];
        const desc = pd[`${sec}.${key}`] || pd[key] || '';
        if (desc) a.paramMeta[`${sec}.${key}`] = desc + (a.paramMeta[`${sec}.${key}`] ? '；' + a.paramMeta[`${sec}.${key}`] : '');
        return { arg, sec, key, type: jsonType(orig !== undefined ? orig : v), desc, default: v };
      });
      // 值本身是 JSON 字符串的字段（mtop 的 data、里面再套的 jsonBody）：里面的字段也摊成参数（data.jsonBody.pagination.current），
      // 调用时只改这一个、别的照旧。没列出来的里层字段也可以按同样的写法给（接在这个字段的参数名后面）
      for (const t of [...a.toolArgs]) {
        const rec = (a.params[t.sec] || {})[t.key];
        if (typeof rec !== 'string' || rec.length > 20000 || !/^\s*[{[]/.test(rec)) continue;
        let n = 0;
        const add = (str, prefix, depth) => {
          let o;
          try { o = JSON.parse(str); } catch (e) { return false; }
          if (!o || typeof o !== 'object') return false;
          for (const [p, v] of Object.entries(flatten(o, ''))) {
            if (n >= 40 || p === '_raw') continue;
            const path = prefix ? `${prefix}.${p}` : p;
            if (typeof v === 'string' && depth < 3 && v.length <= 20000 && /^\s*[{[]/.test(v) && add(v, path, depth + 1)) continue;
            n++;
            const base = `${t.arg}.${path}`.replace(/\[(\d+)\]/g, '.$1').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 90);
            const arg = uniqueArg(base);
            a.toolArgs.push({ arg, sec: t.sec, key: t.key, path, type: jsonType(v), desc: '', default: v, nested: true });
          }
          return true;
        };
        if (add(rec, '', 0)) t.json = true;
      }
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
        parts.push(`${t.sec === 'path' ? '路径参数' : t.sec === 'query' ? 'Query 参数' : '请求体字段'} ${t.key}${t.nested ? ` 里面的 ${t.path}（${t.key} 是 JSON 字符串，只改这一个字段）` : ''}`);
        if (t.json) parts.push(`整个 JSON 字符串；只改里面某个字段时用 ${t.arg}.字段路径 这样的参数，不用整串重写`);
        const rec = t.nested ? t.default : (a.params[t.sec] || {})[t.key];
        const linked = t.nested ? [] : tplNames(t.default);
        if (rec !== undefined && rec !== '') parts.push(`录制值: ${short(JSON.stringify(rec), 60)}`);
        if (linked.length) parts.push(`默认跟随输入参数「${linked.join('、')}」`);
        p.description = parts.join('；');
        properties[t.arg] = p;
      }
      return {
        name: a.fn,
        api: a.name,
        description: [a.title, a.description || `调用 ${a.name}`, a.returns ? `返回：${a.returns}` : '',
          a.download ? '返回的是文件：直接调用会把文件存到浏览器的下载目录' : '', a.noBody && !a.download ? '录制时没拿到返回内容（Worker、表单提交等页面钩子看不到的请求）' : ''].filter(Boolean).join('。'),
        inputSchema: { type: 'object', properties, additionalProperties: true },
      };
    });
  }

  // 让 AI 解读每个接口用途的提示词
  function aiPrompt(A) {
    const L = [];
    L.push('下面是一次网页操作录制的内容，包括用户的操作步骤和期间页面调用的接口。请逐个分析每个接口是做什么的，并给出可作为“工具函数”调用的说明。');
    L.push('');
    L.push(`页面：${maskUrl(A.startUrl, true)}${A.title ? '（' + A.title + '）' : ''}`);
    L.push('');
    L.push('## 操作步骤');
    A.steps.forEach((s, i) => L.push(`${i + 1}. ${s.desc}${s.requests.length ? '  → ' + [...new Set(s.requests.map((r) => r.api))].join(', ') : ''}`));
    L.push('');
    L.push('## 接口');
    A.apis.forEach((a) => {
      L.push('');
      L.push(`### ${a.name}`);
      L.push(`示例 URL: ${short(maskUrl(a.url, true), 300)}`);
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
  // ---------- 选择参数的选项表（文字 → 编码） ----------
  // 请求里发的常是选项的编码（basic_score_ge60），参数填的是选项上显示的文字（基础分60分及以上）。
  // 录到的返回里常带着整张表（筛选项配置的 dataSource:[{value,text}]、字典接口）：找到同时有“录制时选的文字”和
  // “选完之后请求里发过的某个值”的那个数组，这张表就是 文字 → 编码
  // 值里套着的 JSON 字符串也展开看（mtop 的 data、里面再套的 jsonBody / result）
  function deepParse(v, depth, level) {
    level = level || 0;
    if (typeof v === 'string') {
      if (depth < 4 && v.length < 600000 && /^\s*[{[]/.test(v)) { try { return deepParse(JSON.parse(v), depth + 1, level + 1); } catch (e) { return v; } }
      return v;
    }
    if (level > 200) return v; // 太深的结构不再往里
    if (Array.isArray(v)) return v.map((x) => deepParse(x, depth, level + 1));
    if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = deepParse(v[k], depth, level + 1); return o; }
    return v;
  }
  // JSON 文本里的字符串值换成参数模板：按 JSON 的结构一个个字符串记号看——键名不动；值整个等于输入参数的换成
  // "{{参数|jsonesc:层数}}"；值本身又是一段 JSON 文本的（mtop 的 data 里再套的 jsonBody）进去接着找，改完按原来的方式编码回来。
  // 普通字符串里带引号的文字（"keep \"name\" unchanged"）不是 JSON，不会被当成里层的值。
  // pick(值) 返回 "{{参数" 或 "{{参数|opt"（没有结尾的 }}），不关联返回 null。整段没有可换的返回 null
  function linkJsonText(text, level, pick) {
    let o;
    try { o = JSON.parse(text); } catch (e) { return null; }
    if (!o || typeof o !== 'object') return null;
    let out = '';
    let changed = false;
    for (let i = 0; i < text.length;) {
      if (text[i] !== '"') { out += text[i++]; continue; }
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      const raw = text.slice(i, j + 1);
      let k = j + 1;
      while (k < text.length && /\s/.test(text[k])) k++;
      i = j + 1;
      if (text[k] === ':') { out += raw; continue; } // 键名
      let val;
      try { val = JSON.parse(raw); } catch (e) { out += raw; continue; }
      const head = typeof val === 'string' ? pick(val) : null;
      if (head) { out += `"${head}|jsonesc:${level}}}"`; changed = true; continue; }
      if (typeof val === 'string' && level < 4 && val.length < 20000 && /^\s*[{[]/.test(val)) {
        const inner = linkJsonText(val, level + 1, pick);
        if (inner !== null) { out += JSON.stringify(inner); changed = true; continue; }
      }
      out += raw;
    }
    return changed ? out : null;
  }
  const isScalar = (x) => typeof x === 'string' || typeof x === 'number';
  const squash = (s) => String(s == null ? '' : s).trim().replace(/\s+/g, ' ');
  function mineOptions(steps, reqs) {
    const picks = steps.filter((s) => s.type === 'fill' && s.pick === 'choice' && s.param && !s.sensitive && !(s.sel && Array.isArray(s.sel.options)) && typeof s.value === 'string' && s.value.trim());
    if (!picks.length) return;
    const parsed = new Map();
    const respOf = (r) => {
      if (!parsed.has(r)) parsed.set(r, r.responseBody && r.responseBody.type === 'json' ? deepParse(r.responseBody.value, 0) : null);
      return parsed.get(r);
    };
    const leavesOf = (r, out) => {
      const walk = (v) => {
        if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === 'object') Object.values(v).forEach(walk);
        else if (isScalar(v)) out.add(String(v));
      };
      try { new URL(r.url).searchParams.forEach((v) => walk(deepParse(v, 0))); } catch (e) { /* ignore */ }
      Object.values(bodyParams(r.requestBody).params).forEach((v) => walk(deepParse(v, 0)));
    };
    for (const s of picks) {
      const text = squash(s.recordedValue !== undefined ? s.recordedValue : s.value);
      const commit = s.commitTs || s.ts || 0;
      const sent = new Set(); // 选完之后发出的请求里出现过的值
      for (const r of reqs) if (r.ts >= commit) leavesOf(r, sent);
      const found = [];
      const visit = (v, depth) => {
        if (depth > 14 || !v || typeof v !== 'object') return;
        if (Array.isArray(v) && v.length >= 2 && v.length <= 5000 && v.every((x) => x && typeof x === 'object' && !Array.isArray(x))) {
          const hit = v.find((it) => Object.values(it).some((x) => typeof x === 'string' && squash(x) === text));
          if (hit) {
            const kT = Object.keys(hit).find((k) => typeof hit[k] === 'string' && squash(hit[k]) === text);
            for (const kV of Object.keys(hit)) {
              if (kV === kT || !isScalar(hit[kV]) || squash(hit[kV]) === text || !sent.has(String(hit[kV]))) continue;
              const table = v.filter((it) => isScalar(it[kV]) && typeof it[kT] === 'string' && it[kT].trim()).map((it) => [it[kV], squash(it[kT])]);
              // 编码、文字都不能有重复的（有重复说明这一列不是选项的编码）
              if (table.length >= 2 && new Set(table.map((x) => String(x[0]))).size === table.length && new Set(table.map((x) => x[1])).size === table.length) found.push({ table, code: hit[kV], key: kV });
            }
          }
        }
        for (const x of Array.isArray(v) ? v : Object.values(v)) visit(x, depth + 1);
      };
      for (const r of reqs) { const body = respOf(r); if (body) visit(body, 0); }
      if (!found.length) continue;
      // 几处找到的编码不一样：键名像 value / id / code 的那种说了算，还是不一致就不用（认不准）
      let use = found;
      if (new Set(use.map((f) => String(f.code))).size > 1) use = found.filter((f) => /^(value|val|id|code|key)$/i.test(f.key));
      if (!use.length || new Set(use.map((f) => String(f.code))).size > 1) continue;
      const best = use.sort((a, b) => b.table.length - a.table.length)[0];
      s.sel = Object.assign({}, s.sel, { options: best.table.slice(0, 1000), value: best.code, mined: true });
    }
  }

  function analyze(events, settings, state, apiOverrides, aiDocs) {
    settings = settings || {};
    aiDocs = aiDocs || {};
    apiOverrides = apiOverrides || {};
    const evs = [...(events || [])].sort((a, b) => a.ts - b.ts);
    const startUrl = (state && state.startUrl) || (evs.find((e) => e.kind === 'step' && e.url) || {}).url || '';
    let mainHost = '';
    try { mainHost = new URL(startUrl).host; } catch (e) { /* ignore */ }

    // 步骤整理
    // 归到语义步骤下的原始操作不单独成步，挂在语义步骤上（回放时按需要用）
    const groups = new Map(evs.filter((e) => e.kind === 'step' && Array.isArray(e.members)).map((e) => [e.id, e]));
    const memberOf = new Map();
    for (const e of evs) if (e.kind === 'step' && e.groupedIn && groups.has(e.groupedIn)) memberOf.set(e.id, e.groupedIn);
    const rawSteps = evs.filter((e) => e.kind === 'step' && !memberOf.has(e.id)).map((e) => (groups.has(e.id)
      ? Object.assign({}, e, { memberSteps: evs.filter((m) => memberOf.get(m.id) === e.id) })
      : e));
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
    // 老参数的计数保持原样（普通对象，连 constructor 这类名字的老行为也不变，已存脚本的参数名才对得上）；后加参数用无原型的计数
    const usedNames = {};
    const newNames = Object.create(null);
    // 输入框、下拉框、上传框都是输入参数（下拉框可以填选项的值或文字；上传填本机文件路径）
    // 参数名：优先用表单项的标签（“仓库”），几个输入框共用一个标签时（日期区间）用各自的提示文字
    // 单选/复选框：换成组里别的选项、勾或不勾；原生多选下拉框：参数是选项的列表（不拼成逗号字符串，选项文字里可能本来就有逗号）
    const isParamStep = (s) => s.type === 'fill' || s.type === 'upload' || s.type === 'check' || (s.type === 'select' && (!Array.isArray(s.value) || Array.isArray(s.options)));
    const ctxLabel = (s) => (s.target && s.target.ctx && s.target.ctx.label) || '';
    // 早就是参数的（输入框、上传、单选下拉框）和后来才加的（单选/复选框、多选下拉框）分开起名：
    // 后加的不能改变已有参数的名字（脚本库里存着的脚本按名字传参，名字变了就跑不了）
    const legacyParam = (s) => s.type === 'fill' || s.type === 'upload' || (s.type === 'select' && !Array.isArray(s.value));
    const labelUse = {};
    const labelUseAll = Object.create(null);
    for (const s of steps) if (isParamStep(s) && ctxLabel(s)) { const l = ctxLabel(s); if (legacyParam(s)) labelUse[l] = (labelUse[l] || 0) + 1; labelUseAll[l] = (labelUseAll[l] || 0) + 1; }
    const baseOf = (s) => {
      const fallback = s.type === 'select' || s.pick === 'choice' || (s.type === 'check' && Array.isArray(s.options)) ? '选择' : s.type === 'check' ? '勾选' : s.type === 'upload' ? '上传文件' : s.sensitive ? '密码' : s.pick === 'date' ? '日期' : '输入';
      const own = (s.type === 'check' && Array.isArray(s.options) ? s.groupLabel || (s.target && s.target.name) : s.target && s.target.label) || '';
      const cl = s.type === 'check' && Array.isArray(s.options) && s.groupLabel ? '' : ctxLabel(s); // 单选框的表单标签是选项自己的文字，用组名
      const uses = legacyParam(s) ? labelUse : labelUseAll;
      return short((cl && uses[cl] === 1 ? cl : own || cl), 20).replace(/["'`\\{}\n|#]/g, '').trim() || fallback;
    };
    // 同一个输入框录了几次（输入 abc 搜索 → 发现打错改成 abd 再搜）：最后一次用主名字，前面的加“_第N次”
    const tkey = (s) => `${(s.frame && s.frame.url) || ''}|${((s.target && s.target.selectors) || []).join('|')}|${(s.target && s.target.desc) || ''}`;
    const occ = new Map();
    for (const s of steps) if (isParamStep(s)) { if (!occ.has(tkey(s))) occ.set(tkey(s), []); occ.get(tkey(s)).push(s); }
    const bump = (base) => { usedNames[base] = (usedNames[base] || 0) + 1; return usedNames[base] > 1 ? `${base}_${usedNames[base]}` : base; };
    const assign = (group, name) => {
      for (const s of steps) if (isParamStep(s) && group(s)) { const l = occ.get(tkey(s)); if (l[l.length - 1] === s) s.param = name(baseOf(s)); }
      for (const s of steps) {
        if (!isParamStep(s) || !group(s) || s.param) continue;
        const l = occ.get(tkey(s));
        s.param = name(`${baseOf(s)}_第${l.indexOf(s) + 1}次`);
      }
    };
    // 1) 早就是参数的：和加单选/复选框之前完全一样地起名
    assign(legacyParam, bump);
    // 以前起名会撞（两个“Shipping”的第二个叫 Shipping_2，正好又有个字段就叫 Shipping_2）：
    // 名字留给提供默认值的那个（按步骤顺序最后一个，参数表里显示的就是它），其余的往后排
    const legacy = steps.filter((s) => isParamStep(s) && legacyParam(s));
    const taken = new Set(legacy.map((s) => s.param));
    const owner = new Map(legacy.map((s) => [s.param, s]));
    const fresh = (base) => { let k = 2, n; do n = `${base}_${k++}`; while (taken.has(n)); taken.add(n); return n; };
    for (const s of legacy) if (owner.get(s.param) !== s) s.param = fresh(s.param);
    // 2) 后加的（单选/复选框、多选下拉框）：不能和上面任何一个名字相同
    const bumpNew = (base) => { newNames[base] = (newNames[base] || 0) + 1; return newNames[base] > 1 ? `${base}_${newNames[base]}` : base; };
    assign((s) => !legacyParam(s), (base) => { let n = bumpNew(base); while (taken.has(n)) n = bumpNew(base); taken.add(n); return n; });
    // 两组都起完名再记“被谁覆盖”（同一个下拉框先单选后多选，最后那次在后一组才有名字）
    for (const s of steps) {
      if (!isParamStep(s)) continue;
      const l = occ.get(tkey(s));
      if (l[l.length - 1] !== s) s.overwrittenBy = l[l.length - 1].param;
    }
    // 年份在后的日期（11/10/2026、20/08/2026）：月、日谁在前在录制时定下来，回放和接口换算都按它
    for (const s of steps) if (s.type === 'fill' && s.pick === 'date') s.dateOrder = learnOrder(s);
    // 选择参数的选项表：背后没有原生 <select> 的自定义下拉，从录到的返回里找（文字 → 编码）
    mineOptions(steps, evs.filter((e) => e.kind === 'request'));
    const whereOf = (s) => `对应步骤「${stepDesc(Object.assign({}, s, { param: null }))}」`;
    const againOf = (s) => (s.overwrittenBy ? `同一输入框的较早一次输入（之后被参数「${s.overwrittenBy}」覆盖）；` : '');
    const dateNote = (s) => {
      const f = displayFormat(String(s.value || ''), s.dateOrder);
      return `${againOf(s)}日期${f ? `，格式 ${f}` : ''}${s.dateOrder === null ? '（月、日先后分不清，建议填 YYYY-MM-DD）' : ''}；${whereOf(s)}`;
    };
    for (const s of steps) {
      if (!isParamStep(s)) continue;
      const name = s.param;
      params[name] = s.sensitive ? '' : s.type === 'upload' ? s.value || '' : s.type === 'check' ? (Array.isArray(s.options) ? radioToken(s.options, s.optionText, s.value, s.optionIndex) : !!s.checked) : s.value;
      const where = whereOf(s);
      const again = againOf(s);
      if (s.sensitive) paramMetaFill[name] = '密码/敏感输入，录制时未保存，回放前必须填写';
      else if (s.type === 'upload') paramMetaFill[name] = `${again}本机文件的完整路径，多个用 | 分隔（录制时上传的是 ${(s.files || []).join(', ')}）；${where}`;
      else if (s.type === 'check' && Array.isArray(s.options)) {
        paramMetaFill[name] = `${again}单选项，填组里某个选项的文字或值（录制时选的是 ${s.optionText || s.value}）；可选：${s.options.slice(0, 30).map(([, t]) => t).join('、')}；${where}`;
      } else if (s.type === 'check') {
        paramMetaFill[name] = `${again}复选框，填 true（勾选）或 false（不勾选）（录制时${s.checked ? '勾选' : '不勾选'}）；${where}`;
      } else if (s.type === 'select' && Array.isArray(s.value)) {
        const opts = s.options.slice(0, 30).map(([v, t]) => (v === t ? t : `${v}=${t}`)).join('、');
        paramMetaFill[name] = `${again}多选下拉框，填选项值或文字组成的列表，如 ${JSON.stringify(s.value)}，只能是已有的选项；可选：${opts}；${where}`;
      } else if (s.type === 'select') {
        const opts = (s.options || []).slice(0, 30).map(([v, t]) => (v === t ? t : `${v}=${t}`)).join('、');
        paramMetaFill[name] = `${again}下拉框，填选项的值或文字（录制时选的是 ${s.optionText || s.value}）${opts ? '；可选：' + opts + ((s.options || []).length > 30 ? '…' : '') : ''}；${where}`;
      } else if (s.pick === 'date') {
        paramMetaFill[name] = dateNote(s);
      } else if (s.pick === 'choice') {
        const opts = s.sel && s.sel.options ? s.sel.options.slice(0, 30).map(([, t]) => t).join('、') : '';
        paramMetaFill[name] = `${again}选择项，填选项上显示的文字${opts ? '；可选：' + opts + (s.sel.options.length > 30 ? '…' : '') : ''}；${where}`;
      } else paramMetaFill[name] = `${again}录制值；${where}`;
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
      const op = opOf(r.requestBody);
      const key = `${r.method} ${u.host}${tpl}${routeStr(route)}${op ? ' #' + op : ''}`;
      let a = apiMap.get(key);
      if (!a) {
        a = { key, method: r.method, host: u.host, origin: u.origin, pathTemplate: tpl, route, op, calls: [] };
        apiMap.set(key, a);
      }
      a.calls.push({ r, u, pathValues: values, step: stepOf(r.ts) });
    }

    // 接口字段和输入参数按“录制时填的值”对上（之后在弹窗里改了默认值，recordedValue 留着原值）
    // 两个输入框录到同一个值时分不清字段对应哪个，不自动关联（null 表示有歧义）
    // 单选按显示文字、复选框按勾没勾（和 params 里的默认值同一种表示，判断“改没改”才对得上）
    const recordedOf = (s) => (s.type === 'check'
      ? (Array.isArray(s.options) ? (s.recordedText !== undefined ? radioToken(s.options, s.recordedText, s.recordedRadio, s.recordedIndex) : radioToken(s.options, s.optionText, s.value, s.optionIndex)) : (s.recordedChecked !== undefined ? s.recordedChecked : !!s.checked))
      : s.recordedValue !== undefined ? s.recordedValue : s.value);
    const fillValues = Object.create(null);
    const addValue = (map, v, p) => { map[v] = v in map && map[v] !== p ? null : p; };
    for (const s of steps) {
      if ((s.type !== 'fill' && s.type !== 'select') || !s.param || s.sensitive) continue;
      const v = recordedOf(s);
      if (typeof v !== 'string' || !v.length) continue;
      addValue(fillValues, v, s.param);
    }
    // 表格行里的目标记下的行文字：等于之前填过的输入参数的（搜索的单号）换成 {{参数}}，换了参数回放时按新值找行
    steps.forEach((s, idx) => {
      const row = s.target && s.target.ctx && s.target.ctx.row;
      if (!Array.isArray(row)) return;
      const earlier = (p) => steps.some((x, j) => j < idx && x.param === p);
      const cells = row.map((c) => (fillValues[c] && earlier(fillValues[c]) ? `{{${fillValues[c]}}}` : c));
      if (cells.some((c, k) => c !== row[k])) s.target = Object.assign({}, s.target, { ctx: Object.assign({}, s.target.ctx, { row: cells }) });
    });
    // 自定义下拉背后藏着原生 <select>（Chosen、Select2、layui）：参数是选项文字，接口发的是选项的值
    const optValues = Object.create(null);
    const paramOptions = {};
    const minedOpt = new Set(); // 选项表是从返回里找出来的参数（不是原生 select 的）
    for (const s of steps) {
      if (!s.param || !s.sel || !Array.isArray(s.sel.options)) continue;
      paramOptions[s.param] = s.sel.options.slice(0, 1000);
      if (s.sel.mined) minedOpt.add(s.param);
      if (s.sel.value != null && String(s.sel.value) !== '') addValue(optValues, String(s.sel.value), s.param);
    }
    // 密码按值替换成的占位符 → 密码参数（录制时 content script 把明文只交给后台内存，请求入库前替换成占位符）
    const secretOf = Object.create(null);
    for (const s of steps) if (s.sensitive && s.param && s.secretId) secretOf[s.secretId] = s.param;

    // 日期参数：接口里同一天的值换了格式（2026/08/20 00:00:00 ↔ 2026-08-20、20260820、时间戳、ISO）也关联上，
    // 调用时按接口里的格式换算。一个框里有两个日期的（“2026-09-01 - 2026-09-30”）按序号各自关联
    const dateParams = [];
    steps.forEach((s, idx) => {
      if (s.type !== 'fill' || !s.param || s.sensitive) return;
      const all = parseYMDAll(recordedOf(s), s.dateOrder);
      const n = new Set(all.map((d) => d.idx)).size;
      for (const d of all) dateParams.push({ name: s.param, d, idx: d.idx, n, order: d.order, raw: String(recordedOf(s)), label: `${(s.target && s.target.label) || ''} ${s.param}`, step: idx });
    });
    // 参数开始填（打开面板、开始键入）和实际填完（选完值、最后一次按键）的时间
    const paramCommit = Object.create(null);
    const paramStart = Object.create(null);
    steps.forEach((s) => {
      if (!s.param) return;
      paramCommit[s.param] = Math.max(paramCommit[s.param] || 0, s.commitTs || s.ts || 0);
      paramStart[s.param] = Math.min(paramStart[s.param] !== undefined ? paramStart[s.param] : Infinity, s.ts || 0);
    });
    const overwritten = new Set(steps.filter((s) => s.overwrittenBy).map((s) => s.param));
    const learned = {}; // 日期参数靠接口字段对上才定下来的月日顺序
    const maskOn = settings.maskPasswords !== false;
    const fieldsOf = (c) => c.fields || (c.fields = { path: c.pathValues, query: queryOf(c.u), body: bodyParams(c.r.requestBody).params });

    const apis = [];
    for (const a of apiMap.values()) {
      const name = `${a.method} ${a.host === mainHost ? '' : a.host}${a.pathTemplate}${routeStr(a.route)}${a.op ? ' #' + a.op : ''}`;
      const okCall = a.calls.find((c) => c.r.status >= 200 && c.r.status < 300 && okSignalsOf(c.r.responseBody))
        || a.calls.find((c) => c.r.status >= 200 && c.r.status < 300 && c.r.responseBody && c.r.responseBody.type === 'json') || a.calls.find((c) => c.r.status >= 200 && c.r.status < 300) || a.calls[0];
      const first = a.calls[0];
      // 这个字段在参数开始填之前的调用里就已经是这个值（页面一打开就发 pageSize=100，输入框也填了 100）：是撞值，不关联
      const coincide = (sec, k, v, p) => a.calls.some((c) => c.r.ts < (paramStart[p] || 0) && JSON.stringify((fieldsOf(c)[sec] || {})[k]) === JSON.stringify(v));
      // 一个值 → 参数模板：整值相等（字符串、数字）、下拉的选项值、日期（各种格式、时间戳、ISO）
      const linkOne = (c, sec, k, v, pos) => {
        const before = (p) => !(p in paramCommit) || paramCommit[p] <= c.r.ts; // 参数在这次调用之前就填完了
        if (typeof v === 'string') {
          const m = v.match(SECRET_MARK);
          if (m && secretOf[m[1]] && v === m[0]) return { tpl: `{{${secretOf[m[1]]}}}`, name: secretOf[m[1]], note: `来自密码参数 PARAMS["${secretOf[m[1]]}"]` };
        }
        // 日期样子的值先按日期关联（模板带格式：参数写成 2026/09/01 也换成接口要的 2026-09-01）
        if (typeof v === 'string' && dateParams.length && /\d{4}\s*[-/.年]\s*\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{4}|^\d{8}$/.test(v)) {
          const dl = dateLink(k, v, dateParams.filter((x) => before(x.name)), pos);
          if (dl && !coincide(sec, k, v, dl.name)) {
            if (dl.order) learned[dl.name] = dl.order;
            return { tpl: dl.tpl, name: dl.name, note: `来自日期参数 PARAMS["${dl.name}"]，调用时换成接口的格式（${dl.fmt}）` };
          }
        }
        if (typeof v === 'string' || typeof v === 'number') {
          const sv = String(v);
          const p = fillValues[sv];
          // 一两位的数字太容易撞值，只有下拉框的 name 和字段名对得上才关联（仓库 id 这类）
          const shortOk = p && (!/^\d{1,2}$/.test(sv) || steps.some((x) => x.param === p && x.type === 'select' && x.target && x.target.name && String(k).toLowerCase().includes(String(x.target.name).toLowerCase())));
          if (p && shortOk && before(p) && !coincide(sec, k, v, p)) return { tpl: typeof v === 'number' ? `{{${p}|num}}` : `{{${p}}}`, name: p, note: `来自输入框参数 PARAMS["${p}"]` };
          const q = optValues[sv];
          // 从返回里找出来的选项表、编码又是一两位数字的：这次调用里只有这一个字段是这个值才认（免得和页码之类撞上）
          const lone = () => ['path', 'query', 'body'].reduce((n, x) => n + Object.values(fieldsOf(c)[x] || {}).filter((y) => String(y) === sv).length, 0) === 1;
          if (q && before(q) && !coincide(sec, k, v, q) && !(minedOpt.has(q) && /^\d{1,2}$/.test(sv) && !lone())) return { tpl: typeof v === 'number' ? `{{${q}|opt|num}}` : `{{${q}|opt}}`, name: q, note: `来自选择参数 PARAMS["${q}"]（填选项文字，调用时换成选项的值）` };
        }
        const dl = dateParams.length ? dateLink(k, v, dateParams.filter((x) => before(x.name)), pos) : null;
        if (dl && !coincide(sec, k, v, dl.name)) {
          if (dl.order) learned[dl.name] = dl.order;
          return { tpl: dl.tpl, name: dl.name, note: `来自日期参数 PARAMS["${dl.name}"]，调用时换成接口的格式（${dl.fmt}）` };
        }
        // 字段本身是 JSON 字符串（mtop 的 data、里面再套一层 jsonBody）：里面值完全等于输入参数的字符串字段换成
        // {{参数|jsonesc:层数}}，调用时按嵌套层数转义后填进去
        if (typeof v === 'string' && v.length < 20000 && /^\s*[{[]/.test(v)) {
          const names = [];
          const jsonCoincide = (val, paramName) => {
            const needle = JSON.stringify(val);
            return a.calls.some((prev) => {
              if (prev.r.ts >= (paramStart[paramName] || 0)) return false;
              const pv = (fieldsOf(prev)[sec] || {})[k];
              return typeof pv === 'string' && (pv === v || pv.includes(needle));
            });
          };
          // 输入的值原样换；选项的编码换成 {{参数|opt}}（调用时由选项文字换成编码）
          const out = linkJsonText(v, 1, (val) => {
            if (val.length < 2 || /^\d{1,2}$/.test(val)) return null;
            const p = fillValues[val];
            if (p && before(p) && !jsonCoincide(val, p)) { names.push(p); return `{{${p}`; }
            const q = optValues[val];
            if (q && before(q) && !jsonCoincide(val, q)) { names.push(q); return `{{${q}|opt`; }
            return null;
          });
          if (out !== null && names.length) return { tpl: out, name: names[0], note: `里面的字段来自输入参数 ${[...new Set(names)].map((n) => `PARAMS["${n}"]`).join('、')}` };
        }
        return null;
      };
      // 一次调用的全部字段试着关联；数组逐项（区间放在数组里：第一项是开始、最后一项是结束）
      // 同一输入框较早一次的参数（之后被覆盖）只算半个：并列时取关联最终值的那次调用
      const weight = (n) => (overwritten.has(n) ? 0.5 : 1);
      const linkCall = (c) => {
        const bp = bodyParams(c.r.requestBody);
        const orig = { path: Object.assign({}, c.pathValues), query: maskFields(queryOf(c.u), maskOn), body: maskFields(bp.params, maskOn) };
        const edit = JSON.parse(JSON.stringify(orig));
        const notes = {};
        let count = 0;
        for (const sec of ['path', 'query', 'body']) {
          for (const [k, v] of Object.entries(edit[sec])) {
            if (Array.isArray(v)) {
              const hits = v.map((x, i) => linkOne(c, sec, k, x, v.length > 1 ? (i === 0 ? 'start' : i === v.length - 1 ? 'end' : null) : null));
              if (hits.some(Boolean)) {
                edit[sec][k] = v.map((x, i) => (hits[i] ? hits[i].tpl : x));
                notes[`${sec}.${k}`] = [...new Set(hits.filter(Boolean).map((h) => h.note))].join('；');
                count += hits.filter(Boolean).reduce((x, h) => x + weight(h.name), 0);
              }
              continue;
            }
            const h = linkOne(c, sec, k, v, null);
            if (h) { edit[sec][k] = h.tpl; notes[`${sec}.${k}`] = h.note; count += weight(h.name); }
          }
        }
        return { c, bp, orig, edit, notes, count };
      };
      // 接口的参数取哪一次调用：能关联上输入参数最多的那次（并列取最早的）；都关联不上时，取输入参数都填完之后的第一次
      // （选好筛选条件点搜索那次），而不是页面一打开时带默认值的那次
      const tried = a.calls.map(linkCall);
      let L = tried.reduce((x, y) => (y.count > x.count ? y : x), tried[0]);
      if (!L.count) {
        const lastInput = Math.max(0, ...Object.values(paramCommit));
        const c = !lastInput ? first : a.calls.find((x) => x.r.ts >= lastInput) || a.calls[a.calls.length - 1];
        L = tried[a.calls.indexOf(c)];
      }
      const base = L.c;
      const bp = L.bp;
      const orig = L.orig;
      const edit = L.edit;
      // 多次调用时参数取值是否变化
      const meta = {};
      const seen = {};
      for (const c of a.calls) {
        const p = fieldsOf(c);
        for (const sec of ['path', 'query', 'body']) {
          for (const [k, v] of Object.entries(p[sec] || {})) {
            const id = `${sec}.${k}`;
            (seen[id] = seen[id] || new Set()).add(JSON.stringify(v));
          }
        }
      }
      for (const [id, set] of Object.entries(seen)) {
        if (set.size > 1 && !sensitiveKey(id.replace(/^(path|query|body)\./, ''))) meta[id] = `录制中出现多个取值: ${short([...set].slice(0, 4).join(', '), 80)}${set.size > 4 ? ' …' : ''}`;
      }
      // 被脱敏的字段（密码、令牌、签名）：直接调用时用页面最新发出的同名字段值，拿不到就不发
      const masked = [];
      const rawQuery = queryOf(base.u);
      for (const sec of ['query', 'body']) {
        const raw = sec === 'query' ? rawQuery : bp.params;
        for (const [k, v] of Object.entries(orig[sec])) {
          if (v === '' && raw[k] !== '' && raw[k] != null && edit[sec][k] === '') {
            meta[`${sec}.${k}`] = '敏感字段，已脱敏：直接调用时用页面最新发出的值';
            masked.push(`${sec}.${k}`);
          }
        }
      }
      for (const [id, n] of Object.entries(L.notes)) meta[id] = (meta[id] ? meta[id] + '；' : '') + n;
      const ov = apiOverrides[name] || {};
      for (const sec of ['path', 'query', 'body']) {
        for (const [k, v] of Object.entries(ov[sec] || {})) {
          if (v && typeof v === 'object' && v.__deleted) delete edit[sec][k];
          else edit[sec][k] = v;
        }
      }
      const rb = okCall.r.responseBody;
      const reqBodyValue = base.r.requestBody && base.r.requestBody.type === 'json' ? maskDeep(base.r.requestBody.value, maskOn) : undefined;
      const triggered = [...new Set(a.calls.map((c) => c.step + 1))];
      apis.push({
        name,
        method: a.method,
        host: a.host,
        origin: a.origin,
        pathTemplate: a.pathTemplate,
        route: a.route,
        op: a.op || '',
        url: base.r.url,
        pageUrl: base.r.frameUrl || base.r.pageUrl || undefined, // 发出这个接口的页面（iframe 里的就是 iframe 的页面）
        count: a.calls.length,
        status: okCall.r.status,
        error: okCall.r.error,
        contentType: ((okCall.r.responseHeaders || {})['content-type'] || '').split(';')[0],
        bodyType: bp.type,
        requestHeaders: cleanHeaders(base.r.requestHeaders, settings.maskHeaders !== false),
        requestBody: reqBodyValue,
        requestBodyTruncated: !!(base.r.requestBody && base.r.requestBody.truncated),
        // 能不能照着重发：二进制、流、被截断的请求体发出去是空的或残缺的
        replayable: !(base.r.requestBody && base.r.requestBody.truncated) && (!bp.type || ['json', 'form', 'multipart', 'text'].includes(bp.type))
          && !(bp.type === 'multipart' && (base.r.requestBody.value || []).some(([, v]) => typeof v !== 'string')) // 带文件的表单：文件内容没录下来
          && base.r.via !== 'eventsource' && base.r.via !== 'websocket', // 服务端推送、WebSocket 长连接：没有“一次请求一次返回”
        // 怎么抓到的：fetch / xhr / jsonp / eventsource / websocket / beacon，browser = 页面钩子看不到、浏览器层面补记的（Worker、表单提交、下载）
        via: base.r.via || undefined,
        jsonp: base.r.via === 'jsonp' ? base.r.jsonp || 'callback' : undefined, // JSONP 的回调参数名：直接调用时也用 <script> 发
        download: a.calls.map((c) => c.r.download).find(Boolean) || (/attachment/i.test(((okCall.r.responseHeaders || {})['content-disposition']) || '') ? true : undefined), // 返回的是下载的文件
        noBody: a.calls.every((c) => c.r.noBody) || undefined, // 没录到返回内容
        credentials: base.r.credentials || undefined, // 页面发这个请求时的凭据模式（跨域接口带不带 Cookie）
        masked: masked.length ? masked : undefined,
        params: orig,
        editParams: edit,
        overridden: !!apiOverrides[name],
        paramMeta: meta,
        triggeredBy: triggered,
        // 只由可选步骤（比如未登录时才出现的登录）触发的接口：直接请求时不调
        optionalOnly: triggered.length > 0 && triggered.every((n) => n > 0 && steps[n - 1] && steps[n - 1].optional),
        // 返回里套着的 JSON 字符串（mtop 的 data.result）展开了再给结构和示例：数据的路径看得出来，里面像令牌的字段也照样打码
        // （先按原样遮盖一遍：名字敏感的字段值是 JSON 字符串时整个遮掉；再展开其余的、里面的敏感字段再遮一遍）
        schema: rb && rb.type === 'json' ? renderSchema(typeNode(maskDeep(deepParse(maskDeep(rb.value, maskOn), 0), maskOn), 0)) : null,
        sample: sampleOf(rb && rb.type === 'json' ? Object.assign({}, rb, { value: maskDeep(deepParse(maskDeep(rb.value, maskOn), 0), maskOn) }) : rb, settings.sampleKB || 20),
        okSignals: okSignalsOf(rb),
        okShape: okShapeOf(rb),
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
        const nm = apiNameOf(r, u, mainHost);
        const ai = apiIndex.get(nm);
        if (ai == null) continue;
        s.requests.push({ api: nm, status: r.status, url: maskUrl(r.url, true) });
        // 语义步骤（日期、选择）按选完值的时间算：打开面板翻了很久才选好，选完立刻发的请求也要等
        // 回放时等得到的只有页面自己用 fetch / XHR 发的：JSONP、Worker、表单提交、下载、别的标签页里的请求回放引擎看不到，不等
        if (r.ts - (s.commitTs || s.ts) < 5000 && waitSet.size < 5 && ctxOfReq(r) === ctxOfStep(s) && (!r.via || r.via === 'fetch' || r.via === 'xhr') && !r.otherTab) waitSet.add(ai);
      }
      s.waitFor = [...waitSet];
    });

    // 月日顺序靠接口字段才定下来的日期参数
    for (const s of steps) {
      if (s.pick === 'date' && s.param && s.dateOrder == null && learned[s.param]) { s.dateOrder = learned[s.param]; paramMetaFill[s.param] = dateNote(s); }
    }
    // 每个输入参数的说明（给 AI：类型、格式、可选项、是否必填、改了能不能直接请求）
    const paramInfo = {};
    const paramFmt = {};
    for (const s of steps) {
      if (!s.param) continue;
      const kind = s.sensitive ? 'secret' : s.type === 'upload' ? 'upload' : s.type === 'select' ? 'select' : s.pick === 'date' ? 'date' : s.pick === 'choice' ? 'choice' : 'text';
      const info = { kind, recorded: params[s.param], note: paramMetaFill[s.param] || '' };
      if (kind === 'date') {
        info.format = displayFormat(String(recordedOf(s) || ''), s.dateOrder) || undefined;
        if (s.dateOrder) paramFmt[s.param] = s.dateOrder;
      }
      if (kind === 'select' && s.options) info.options = s.options.slice(0, 200);
      if (kind === 'choice' && s.sel && s.sel.options) info.options = s.sel.options.slice(0, 200);
      if ((kind === 'secret' || kind === 'upload') && !s.overwrittenBy) info.required = true;
      if (s.overwrittenBy) info.overwrittenBy = s.overwrittenBy;
      info.linkedTo = [];
      paramInfo[s.param] = info;
    }
    for (const a of apis) {
      if (a.ignore) continue;
      for (const sec of ['path', 'query', 'body']) {
        for (const [k, v] of Object.entries(a.editParams[sec] || {})) {
          for (const n of tplNames(v)) if (paramInfo[n] && !paramInfo[n].linkedTo.includes(`${a.name} ${sec}.${k}`)) paramInfo[n].linkedTo.push(`${a.name} ${sec}.${k}`);
        }
      }
    }

    const title = (state && state.title) || '';
    let host = mainHost;
    const name = (state && state.name) || aiDocs.title || title || host || '未命名录制';
    const description = (state && state.description) || aiDocs.description || '';
    // 参数最初录到的值（弹窗里改过默认值也不变）：接口字段按它关联，判断“这次参数改没改”也按它
    const paramRecorded = {};
    for (const s of steps) if (s.param) paramRecorded[s.param] = s.sensitive ? '' : s.type === 'upload' ? (s.recordedValue !== undefined ? s.recordedValue : s.value) || '' : recordedOf(s);
    return { name, description, startUrl, mainHost, title, steps, apis, params, paramRecorded, paramMetaFill, paramInfo, paramOptions, paramFmt, aiDocs, id: (state && state.id) || 'rec' + Date.now().toString(36) };
  }
  // 值里引用到的参数名（{{名}}、{{名|过滤}}，数组、对象里的也算）
  function tplNames(v) {
    const out = new Set();
    JSON.stringify(v === undefined ? null : v).replace(/\{\{([^{}|]+)(?:\|[^{}]*)?\}\}/g, (m, n) => { const t = n.trim(); if (t) out.add(t); return m; });
    return [...out];
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
    L.push(`起始页面：${maskUrl(A.startUrl, true)}`);
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
      L.push(`  示例 URL：${short(maskUrl(a.url, true), 200)}`);
      L.push(`  触发步骤：${a.triggeredBy.map((x) => (x === 0 ? '页面加载' : x)).join(', ')}   调用 ${a.count} 次   状态 ${a.status == null ? '失败 ' + (a.error || '') : a.status}   ${a.contentType}`);
      if (Object.keys(a.params.path).length) L.push(`  路径参数：${paramLine(a.params.path)}`);
      if (Object.keys(a.params.query).length) L.push(`  Query 参数：${paramLine(a.params.query)}`);
      if (Object.keys(a.params.body).length) L.push(`  请求体(${a.bodyType})：${paramLine(a.params.body)}${Object.keys(a.params.body).length > 12 ? ' …' : ''}`);
      const hk = Object.keys(a.requestHeaders).filter((k) => !/^accept/i.test(k));
      const shownHdr = maskHeaderValues(a.requestHeaders, true);
      if (hk.length) L.push(`  请求头：${hk.map((k) => `${k}: ${short(shownHdr[k], 30)}`).join('; ')}`);
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
      L.push(`  // ${cm(a.name)}${a.title ? ' ' + cm(a.title) : ''}（${trig}触发${a.bodyType && !['json', 'form', 'multipart', 'text'].includes(a.bodyType) ? `，请求体为 ${cm(a.bodyType)}，不可修改` : ''}${a.requestBodyTruncated ? '，请求体过大已截断' : ''}）`);
      if (!secs.length) { L.push(`  ${JSON.stringify(a.name)}: {},`); return; }
      L.push(`  ${JSON.stringify(a.name)}: {`);
      for (const s of secs) {
        const note = s === 'path' ? `  // 路径参数，对应 ${cm(a.pathTemplate)}` : s === 'body' ? `  // 请求体字段（${cm(a.bodyType)}），a.b[0].c 形式表示嵌套路径` : '';
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

  // 日期：只认年月日，不做时区换算
  // 和回放引擎的 parseDate 规则一致：2026-08-20、2026/8/20、2026年8月20日、20260820、11/10/2026（月日顺序按 order），带不带时间都行
  const okYMD = (y, m, d) => m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 1900 && y <= 2200;
  const DATE_SCAN = /(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})日?|(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/g;
  const TIME_AFTER = /^[\sT,]*(\d{1,2}):(\d{2})(?::(\d{2}))?/;
  // 值里的全部日期，按出现顺序；年份在后、月日分不清（order 未知且两个数都不超过 12）时两种读法都给出，带上 order
  function parseYMDAll(v, order) {
    if (typeof v !== 'string') return [];
    const out = [];
    const c = v.trim().match(/^(\d{4})(\d{2})(\d{2})$/);
    if (c) return okYMD(+c[1], +c[2], +c[3]) ? [{ y: +c[1], m: +c[2], d: +c[3], time: null, idx: 0 }] : [];
    let m;
    let idx = 0;
    DATE_SCAN.lastIndex = 0;
    while ((m = DATE_SCAN.exec(v))) {
      const tm = v.slice(m.index + m[0].length).match(TIME_AFTER);
      const time = tm ? { H: +tm[1], i: +tm[2], s: +(tm[3] || 0) } : null;
      if (m[1]) {
        if (okYMD(+m[1], +m[2], +m[3])) out.push({ y: +m[1], m: +m[2], d: +m[3], time, idx: idx++ });
        continue;
      }
      const a = +m[4];
      const b = +m[5];
      const y = +m[6];
      const reads = order === 'DMY' ? [['DMY', b, a]] : order === 'MDY' ? [['MDY', a, b]]
        : a > 12 ? [['DMY', b, a]] : b > 12 || a === b ? [['MDY', a, b]] : [['MDY', a, b], ['DMY', b, a]];
      const ok = reads.filter(([, mm, dd]) => okYMD(y, mm, dd));
      for (const [o, mm, dd] of ok) out.push({ y, m: mm, d: dd, time, idx, order: ok.length > 1 ? o : undefined });
      if (ok.length) idx++;
    }
    // 只有一个日期、时间写在别处的（“08:00 2026-08-20”）
    if (out.length && new Set(out.map((x) => x.idx)).size === 1 && !out[0].time) {
      const tm = v.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
      if (tm) for (const x of out) x.time = { H: +tm[1], i: +tm[2], s: +(tm[3] || 0) };
    }
    return out;
  }
  function parseYMD(v, order) {
    const all = parseYMDAll(v, order);
    return all.length && !all[0].order ? all[0] : null;
  }
  // 年份在后的日期（11/10/2026）月、日谁在前：数字超过 12 的是日；面板里点的日期格子的数字也是日
  function learnOrder(s) {
    const v = String(s.recordedValue !== undefined ? s.recordedValue : s.value || '');
    const m = v.match(/(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
    if (!m) return undefined;
    const a = +m[1];
    const b = +m[2];
    if (a > 12 && b <= 12) return 'DMY';
    if (b > 12 && a <= 12) return 'MDY';
    if (a === b) return 'MDY';
    const day = (s.memberSteps || []).map((x) => x.target && x.target.text).filter((t) => /^\d{1,2}$/.test(t || '')).pop();
    if (day && +day === a) return 'DMY';
    if (day && +day === b) return 'MDY';
    return null; // 分不清（之后可能靠接口字段定下来）
  }
  // 值的格式说明：2026/05/23 00:00:00 → YYYY/MM/DD HH:mm:ss；11/10/2026 → MM/DD/YYYY
  function displayFormat(v, order) {
    let any = false;
    const f = v.replace(/(\d{4})(\s*[-/.年]\s*)(\d{1,2})(\s*[-/.月]\s*)(\d{1,2})|(\d{1,2})([-/.])(\d{1,2})([-/.])(\d{4})/g, (s, y, s1, mo, s2, d, a, t1, b, t2, y2) => {
      any = true;
      if (y) return `YYYY${s1}${mo.length === 2 ? 'MM' : 'M'}${s2}${d.length === 2 ? 'DD' : 'D'}`;
      const first = order === 'DMY' ? 'DD' : order === 'MDY' ? 'MM' : '??';
      const second = order === 'DMY' ? 'MM' : order === 'MDY' ? 'DD' : '??';
      return `${first}${t1}${second}${t2}YYYY`;
    }).replace(/\b\d{1,2}:\d{2}:\d{2}\b/g, 'HH:mm:ss').replace(/\b\d{1,2}:\d{2}\b/g, 'HH:mm');
    return any ? f : '';
  }
  // 把值里的年月日换成占位符：2026-08-20 00:00:00 → YYYY-MM-DD 00:00:00；08/20/2026 → MM/DD/YYYY。
  // 时间和参数录到的时间一样就也换成占位符（改参数的时间会跟着变），不一样就原样保留
  function dateFormatOf(v, d, pd) {
    let m = v.match(/^(\D*)(\d{4})([-/.年]?)(\d{1,2})([-/.月]?)(\d{1,2})(日?)(.*)$/);
    let head;
    let rest;
    if (m) {
      if (+m[2] !== d.y || +m[4] !== d.m || +m[6] !== d.d || (!m[3] && m[4].length !== 2)) return null;
      head = m[1] + 'YYYY' + m[3] + (m[4].length === 2 ? 'MM' : 'M') + m[5] + (m[6].length === 2 ? 'DD' : 'D') + m[7];
      rest = m[8];
    } else {
      m = v.match(/^(\D*)(\d{1,2})([-/.])(\d{1,2})([-/.])(\d{4})(.*)$/);
      if (!m || +m[6] !== d.y) return null;
      const tok = (s, kind) => (kind === 'm' ? (s.length === 2 ? 'MM' : 'M') : (s.length === 2 ? 'DD' : 'D'));
      if (+m[2] === d.m && +m[4] === d.d) head = m[1] + tok(m[2], 'm') + m[3] + tok(m[4], 'd') + m[5] + 'YYYY';
      else if (+m[2] === d.d && +m[4] === d.m) head = m[1] + tok(m[2], 'd') + m[3] + tok(m[4], 'm') + m[5] + 'YYYY';
      else return null;
      rest = m[7];
    }
    const tm = rest.match(/^(\s+|T)(\d{2}):(\d{2})(?::(\d{2}))?/);
    if (tm && pd && pd.time && pd.time.H === +tm[2] && pd.time.i === +tm[3] && pd.time.s === +(tm[4] || 0)) {
      rest = tm[1] + 'HH:mm' + (tm[4] !== undefined ? ':ss' : '') + rest.slice(tm[0].length);
    }
    return head + rest;
  }
  // pos：值在数组里的位置（区间放在数组里时第一项是开始、最后一项是结束）
  function dateLink(key, v, dps, pos) {
    let d = null;
    let fmt = null;
    const iso = typeof v === 'string' && v.match(/^\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2}):(\d{2})(\.\d{1,3})?Z$/);
    if (iso) {
      // 带 Z 的 ISO 时间（toISOString 的结果）：按本地时间换算后是不是当天零点 / 最后一刻 / 参数里的时间
      const t = new Date(v);
      if (isNaN(t)) return null;
      d = { y: t.getFullYear(), m: t.getMonth() + 1, d: t.getDate() };
      const ms = t.getMilliseconds();
      const hms = [t.getHours(), t.getMinutes(), t.getSeconds()];
      const sfx = iso[4] ? '' : ':s';
      if (hms.join() === '0,0,0' && ms === 0) fmt = 'iso:start' + sfx;
      else if (hms.join() === '23,59,59' && (ms === 999 || ms === 0)) fmt = 'iso:' + (ms === 999 ? 'end' : 'end0') + sfx;
      else fmt = { iso: hms, sfx };
    } else if (typeof v === 'number' || (typeof v === 'string' && /^\d{10}(\d{3})?$/.test(v))) {
      const n = Number(v);
      const ms13 = String(Math.trunc(n)).length === 13;
      const ms = ms13 ? n : n * 1000;
      if (!(ms > 946684800000 && ms < 4102444800000)) return null; // 2000～2100 年
      const t = new Date(ms);
      d = { y: t.getFullYear(), m: t.getMonth() + 1, d: t.getDate() };
      // 只关联当天零点或最后一刻的时间戳（区间的开始、结束），其他时刻换算后会变，不自动关联
      // 毫秒也要能原样还原：零点只认 .000，最后一刻认 .999 或 .000
      const msPart = ms13 ? t.getMilliseconds() : 0;
      const start = t.getHours() === 0 && t.getMinutes() === 0 && t.getSeconds() === 0 && msPart === 0;
      const end = t.getHours() === 23 && t.getMinutes() === 59 && t.getSeconds() === 59 && (msPart === 999 || msPart === 0);
      if (!start && !end) return null;
      fmt = (ms13 ? 'ts:ms' : 'ts:s') + (end ? (ms13 && msPart === 0 ? ':end0' : ':end') : '');
    } else if (typeof v === 'string') {
      // 接口里年份在后、月日分不清的写法：两种读法都试
      const reads = parseYMDAll(v).filter((x) => x.idx === 0);
      for (const r of reads) {
        const h = pickDateHit(key, dps.filter((p) => p.d.y === r.y && p.d.m === r.m && p.d.d === r.d), pos, v);
        if (!h) continue;
        const f = dateFormatOf(v, r, h.d);
        if (!f) continue;
        return dateResult(h, 'date:' + f);
      }
      return null;
    } else return null;
    const h = pickDateHit(key, dps.filter((p) => p.d.y === d.y && p.d.m === d.m && p.d.d === d.d), pos, v);
    if (!h) return null;
    if (fmt && typeof fmt === 'object') {
      // 带具体时刻的 ISO：参数里的时间（日期时间选择器）和它一致才关联
      const t = h.d.time;
      if (!t || [t.H, t.i, t.s].join() !== fmt.iso.join()) return null;
      fmt = 'iso:time' + fmt.sfx;
    }
    return dateResult(h, fmt);
  }
  // 同一天对上了几个参数（开始、结束是同一天；一个框里两个日期）：按字段名、数组位置里的“开始/结束”分
  function pickDateHit(key, hit, pos, v) {
    if (hit.length > 1) {
      // 几个参数是同一天（日期框和日期时间框）：录制值和接口值一字不差的那个就是它
      const exact = hit.filter((p) => p.n === 1 && p.raw === String(v));
      if (exact.length === 1) return exact[0];
      const isEnd = pos === 'end' || (!pos && /end|to$|stop|max|截止|结束/i.test(key));
      const isStart = pos === 'start' || (!pos && /start|begin|from|min|起|开始/i.test(key));
      const sameName = hit.every((p) => p.name === hit[0].name);
      if (sameName) {
        // 同一个参数里的两个日期（单框区间）：开始取第一个，结束取最后一个
        const idx = hit.map((p) => p.idx);
        const want = isEnd ? Math.max(...idx) : isStart ? Math.min(...idx) : null;
        hit = want == null ? [] : hit.filter((p) => p.idx === want);
      } else {
        hit = hit.filter((p) => (isEnd && (/结束|截止|end|to/i.test(p.label) || (p.n > 1 && p.idx === p.n - 1)))
          || (isStart && (/开始|起始|start|from|begin/i.test(p.label) || (p.n > 1 && p.idx === 0))));
      }
    }
    return hit.length === 1 ? hit[0] : null;
  }
  function dateResult(h, fmt) {
    const full = h.n > 1 ? `${fmt}#${h.idx}` : fmt; // 一个参数里有几个日期：#序号 指第几个
    return {
      name: h.name,
      order: h.order,
      tpl: `{{${h.name}|${full}}}`,
      fmt: fmt.replace(/^date:/, '').replace(/^ts:ms(:end0?)?$/, '毫秒时间戳').replace(/^ts:s(:end0?)?$/, '秒时间戳').replace(/^iso:.*$/, 'ISO 时间') + (h.n > 1 ? `，取第 ${h.idx + 1} 个日期` : ''),
    };
  }

  // 录制时成功响应里的业务状态字段（code: 0、success: true……）：直接调用时拿来判断这次是不是真的成功
  // （很多网站出错也返回 HTTP 200，只是业务码不同，比如缺签名、登录过期）
  // 只取“看起来就是成功”的值（code 0/200、success true……）；录到的本身就是失败响应的不用。
  // 键名按后缀认（errorCode、statusCode、retCode、bizCode……），status / state / result 在录到的是成功值时也算；
  // 再往下看一层常见的包装（head、meta、status、result……）
  const CODE_KEYS = /(code|errno|err_no)$|^(ret|retcode|ret_code)$/i;
  const STATUS_KEYS = /^(status|state|result|resultstatus|biz_?status)$/i;
  const BOOL_KEYS = /^(success|succeed|ok|issuccess|is_success|succ)$/i;
  const OK_VALUE = /^(0+|200|ok|success|succeed|succeeded|true)$/i;
  const WRAP_KEYS = /^(head|header|meta|status|result|response|resp|base_?resp|baseresponse|error)$/i;
  function okSignalsOf(rb) {
    if (!rb || rb.type !== 'json' || !rb.value || typeof rb.value !== 'object' || Array.isArray(rb.value)) return undefined;
    const out = {};
    const scan = (obj, prefix) => {
      for (const [k, v] of Object.entries(obj)) {
        const key = prefix + k;
        // 淘宝 mtop 这类：ret: ["SUCCESS::调用成功"]，第一项以 SUCCESS 开头才算成功
        if (Array.isArray(v)) { if (typeof v[0] === 'string' && /^(SUCCESS|OK)\b/i.test(v[0])) out[key + '.0'] = { prefix: v[0].match(/^(SUCCESS|OK)/i)[0] }; continue; }
        if (v && typeof v === 'object') { if (!prefix && WRAP_KEYS.test(k)) scan(v, key + '.'); continue; }
        if (!/^[A-Za-z_$][\w$]*$/.test(k)) continue;
        const scalar = typeof v === 'number' || typeof v === 'string';
        if ((CODE_KEYS.test(k) || STATUS_KEYS.test(k)) && scalar && OK_VALUE.test(String(v))) out[key] = v;
        else if ((BOOL_KEYS.test(k) || STATUS_KEYS.test(k)) && v === true) out[key] = v;
      }
    };
    scan(rb.value, '');
    return Object.keys(out).length ? out : undefined;
  }
  // 成功响应的形态：是不是 JSON、顶层有哪些键。这次的响应形态完全对不上（登录页 HTML、换了结构）就不能算成功
  function okShapeOf(rb) {
    if (!rb) return undefined;
    if (rb.type !== 'json') return { json: false };
    if (Array.isArray(rb.value)) return { json: true, array: true };
    if (rb.value && typeof rb.value === 'object') return { json: true, keys: Object.keys(rb.value).slice(0, 40) };
    return { json: true };
  }

  const tgt = (t) => t && {
    selectors: t.selectors, tag: t.tag, text: t.text || undefined, type: t.type || undefined, name: t.name || undefined, desc: t.desc,
    ctx: t.ctx || undefined, shadow: t.shadow || undefined, frames: t.frames || undefined, row: t.row || undefined,
  };
  // 一个动作怎么做（顶层步骤和语义步骤的成员共用：成员里的滚动、拖动、按键都要原样带上）
  function actionData(s) {
    const o = { type: s.type };
    if (s.target) o.target = tgt(s.target);
    if (s.type === 'check') o.checked = s.checked;
    if (s.type === 'press') { o.key = s.key; if (s.ctrl) o.ctrl = true; if (s.meta) o.meta = true; if (s.shift) o.shift = true; if (s.alt) o.alt = true; if (s.to) o.to = tgt(s.to); }
    if (s.type === 'scroll') { o.x = s.x; o.y = s.y; }
    if (s.type === 'drag') { o.to = tgt(s.to); o.toPos = s.toPos; o.dx = s.dx; o.dy = s.dy; if (s.html5) o.html5 = true; }
    if (s.type === 'upload') { if (s.chooser) o.chooser = true; if (s.drop) o.drop = true; }
    if (s.pos) o.pos = s.pos;
    if (s.hover && s.hover.length) o.hover = s.hover.map(tgt);
    if (s.toggle) o.toggle = s.toggle;
    if (s.state) o.state = s.state;
    if (s.dialogs && s.dialogs.length) o.dialogs = s.dialogs.map((d) => ({ kind: d.kind, message: short(d.message || '', 120), result: d.result }));
    return o;
  }
  // outward：给人、给 AI、写进导出脚本的版本（非标准请求头里像令牌的值也打码）；
  // 否则是扩展自己回放、直接请求用的（只按名字打码，页面实时请求头会补上）
  function recordingData(A, outward) {
    return {
      id: A.id,
      name: A.name,
      description: A.description,
      startUrl: maskUrl(A.startUrl, outward),
      title: A.title,
      paramOptions: Object.keys(A.paramOptions || {}).length ? A.paramOptions : undefined,
      paramFmt: Object.keys(A.paramFmt || {}).length ? A.paramFmt : undefined,
      steps: A.steps.map((s, i) => {
        const view = maskStepUrls(s, outward);
        const o = Object.assign(actionData(view), { desc: outward && view.url !== s.url && s.desc ? s.desc.split(s.url).join(view.url) : s.desc });
        if (s.url && (s.type === 'navigate' || s.type === 'url')) o.url = maskUrl(s.url, outward);
        if (s.type === 'navigate' && s.jump) o.jump = true;
        if (s.type === 'fill') o.value = `{{${s.param}}}`;
        if (s.type === 'select') { o.value = s.param ? `{{${s.param}}}` : s.value; o.optionText = s.optionText; if (s.options) o.options = s.options.slice(0, 1000); }
        if (s.type === 'check' && s.param && Array.isArray(s.options)) { o.value = `{{${s.param}}}`; o.optionText = s.optionText; o.options = s.options; } else if (s.type === 'check' && s.param) o.checked = `{{${s.param}}}`;
        if (s.type === 'extract') { o.name = s.name; if (s.sample) o.sample = short(s.sample, 120); }
        if (s.type === 'upload') { o.files = s.files; o.param = s.param; o.value = `{{${s.param}}}`; }
        if (s.sensitive) o.sensitive = true;
        // 录制时的值：之后步骤的目标文字里可能带着它（多选的标签、框旁显示的值），换了参数回放时据此放宽按文字找
        if (s.param && !s.sensitive && s.type !== 'upload' && !s.pick) o.recorded = s.type === 'check' ? (Array.isArray(s.options) ? (s.recordedText !== undefined ? s.recordedText : s.optionText || s.value) : undefined) : s.recordedValue !== undefined ? s.recordedValue : s.value;
        if (s.pick) {
          o.pick = s.pick;
          if (s.sid) o.sid = s.sid;
          o.recorded = s.recordedValue !== undefined ? s.recordedValue : s.value;
          if (s.pick === 'date' && s.dateOrder) o.dateFmt = s.dateOrder;
          if (s.sel && s.sel.target) o.sel = { target: tgt(s.sel.target) };
          if (s.typed) o.typed = true;
          if (s.multi) { o.multi = true; o.before = Array.isArray(s.before) ? s.before : []; }
          // 同一次打开面板里先后选出的两个日期（区间的开始和结束）：开始那个选完不点“确定”
          const nx = A.steps[i + 1];
          const pv = A.steps[i - 1];
          if (s.pick === 'date' && s.sid && nx && nx.pick === 'date' && nx.sid === s.sid) o.rangeStart = true;
          if (s.pick === 'date' && s.sid && pv && pv.pick === 'date' && pv.sid === s.sid) o.rangeEnd = true;
        }
        if (s.memberSteps && s.memberSteps.length && s.type !== 'dblclick') {
          o.members = s.memberSteps.map((m) => {
            const x = actionData(m);
            if (m.type === 'fill' || m.type === 'select') x.value = m.value;
            if (m.frame) x.frame = { url: maskUrl(m.frame.url, outward) };
            return x;
          });
        }
        if (s.waitFor && s.waitFor.length) o.waitFor = s.waitFor;
        if (s.optional) o.optional = true;
        if (s.frame) o.frame = { url: maskUrl(s.frame.url, outward) };
        return o;
      }),
      apis: A.apis.map((a) => ({
        name: a.name,
        fn: a.fn,
        title: a.title || undefined,
        description: a.description || undefined,
        returns: a.returns || undefined,
        ignore: a.ignore || undefined,
        toolArgs: a.toolArgs.map((t) => Object.assign({ arg: t.arg, sec: t.sec, key: t.key }, t.path ? { path: t.path } : {}, t.json ? { json: true } : {})),
        method: a.method,
        host: a.host,
        pathTemplate: a.pathTemplate,
        route: Object.keys(a.route || {}).length ? a.route : undefined,
        op: a.op || undefined,
        url: maskUrl(a.url, true),
        pageUrl: maskUrl(a.pageUrl, outward),
        triggeredBy: a.triggeredBy,
        optionalOnly: a.optionalOnly || undefined,
        status: a.status,
        contentType: a.contentType,
        bodyType: a.bodyType,
        replayable: a.replayable,
        via: a.via,
        jsonp: a.jsonp,
        download: a.download,
        credentials: a.credentials,
        masked: a.masked,
        requestHeaders: outward ? maskHeaderValues(a.requestHeaders, true) : a.requestHeaders,
        requestBody: a.requestBody,
        params: a.params,
        okSignals: a.okSignals,
        okShape: a.okShape,
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
      '  requestQuiet: 1500,     // 页面这么久(ms)没有请求开始或返回、也没有在等的请求，就不再等这一步剩下的接口（0 = 一直等到超时）',
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
      'const RECORDING = ' + JSON.stringify(recordingData(A, true), null, 2) + ';',
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
    L.push(`- 起始页面：${maskUrl(A.startUrl, true)}`);
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
      for (const [k, v] of Object.entries(A.params)) {
        const info = (A.paramInfo || {})[k] || {};
        const via = info.linkedTo && info.linkedTo.length ? `；改了能直接请求（关联 ${info.linkedTo.slice(0, 3).join('、')}）` : '';
        L.push(`- \`${k}\`: ${JSON.stringify(v)}（${info.kind || 'text'}${info.required ? '，必填' : ''}）${info.note ? ' ' + info.note : ''}${via}`);
      }
    }
    L.push('');
    L.push('## 接口');
    A.apis.forEach((a) => {
      L.push('');
      L.push(`### \`${a.name}\`${a.title ? ' — ' + a.title : ''}`);
      if (a.description) L.push(`- 用途：${a.description}`);
      if (!a.ignore) L.push(`- 工具函数：\`__PR__.tools.${a.fn}(args)\``);
      if (a.returns) L.push(`- 返回：${a.returns}`);
      L.push(`- 示例：\`${maskUrl(a.url, true)}\``);
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
    autoRun: true, resume: true, rewriteRequests: true, waitRequests: true, requestTimeout: 15000, requestQuiet: 1500,
    findTimeout: 10000, optionalTimeout: 3000, stepDelay: 400, typing: false, typingDelay: 40, continueOnError: false, highlight: true, verbose: true,
  };
  function bundleOf(A) {
    const apiParams = {};
    A.apis.forEach((a) => { apiParams[a.name] = a.editParams; });
    return { id: A.id, name: A.name, description: A.description, recording: recordingData(A), params: A.params, paramRecorded: A.paramRecorded, paramInfo: A.paramInfo, apiParams, config: Object.assign({}, DEFAULT_CONFIG), tools: toolSchemas(A) };
  }
  function build(events, settings, state, apiOverrides, aiDocs) {
    const A = analyze(events, settings, state, apiOverrides, aiDocs);
    const raw = {
      generator: 'Page Recorder',
      exportedAt: new Date().toISOString(),
      startUrl: maskUrl(A.startUrl, (settings || {}).maskPasswords !== false),
      name: A.name,
      description: A.description,
      title: A.title,
      steps: A.steps.map((s) => maskStepUrls(s, (settings || {}).maskPasswords !== false)),
      tools: toolSchemas(A),
      apis: A.apis.map((a) => Object.assign({}, a, { rawResponse: undefined, url: maskUrl(a.url, true), requestHeaders: maskHeaderValues(a.requestHeaders, (settings || {}).maskHeaders !== false) })),
      requests: (events || []).filter((e) => e.kind === 'request').sort((a, b) => a.ts - b.ts).map((r) => exportRequest(r, settings)),
      params: A.params,
      paramInfo: A.paramInfo,
    };
    return { analysis: A, script: buildScript(A), raw, summary: buildSummary(A), bundle: bundleOf(A), tools: toolSchemas(A), prompt: aiPrompt(A) };
  }

  // 录制包、导出 JSON 里的一条请求：入库脱敏之外，再按对外导出的规则打码（请求头按名字和值、地址里的令牌、响应里的令牌）
  function exportRequest(r, settings) {
    const s = settings || {};
    const on = s.maskPasswords !== false;
    const x = scrubRequest(r, [], on);
    return Object.assign({}, x, {
      url: maskUrl(x.url, on),
      pageUrl: maskUrl(x.pageUrl, on),
      frameUrl: maskUrl(x.frameUrl, on),
      requestBody: maskRequestBody(x.requestBody, on),
      requestHeaders: maskHeaderValues(x.requestHeaders, s.maskHeaders !== false),
      responseHeaders: maskHeaderValues(x.responseHeaders, s.maskHeaders !== false),
      responseBody: on && x.responseBody ? { ...x.responseBody, value: maskDeep(x.responseBody.value, true) } : x.responseBody,
    });
  }
  // 本机长期备份：不看这条录制的脱敏开关。密码框的明文清掉，请求和说明里同样的值换成占位符（回放时由密码参数填回）
  const SECRET_FIELD = /^(password|passwd|passcode|otp|pin|verification_?code)$/i;
  const secretStep = (s) => s.type === 'fill' && !!(s.sensitive || s.secretInput || /^password$/i.test(s.target?.type || '') || SECRET_FIELD.test(s.target?.name || ''));
  const swapSecrets = (v, list) => {
    if (typeof v === 'string') return list.reduce((t, x) => t.split(x.value).join(`__PR_SECRET_${x.id}__`), v);
    if (Array.isArray(v)) return v.map((x) => swapSecrets(x, list));
    return v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, swapSecrets(x, list)])) : v;
  };
  function scrubBackup(item) {
    const secrets = [];
    const clean = (s) => {
      const members = Array.isArray(s.members) ? s.members.map((x) => (x && typeof x === 'object' ? clean(x) : x)) : s.members;
      if (!secretStep(s)) return { ...s, members };
      const id = s.secretId || s.id;
      for (const v of [s.value, s.recordedValue]) if (typeof v === 'string' && v.length >= 3) secrets.push({ id, value: v });
      return { ...s, members, value: '', recordedValue: '', sensitive: true, secretId: id };
    };
    const events = (item.events || []).map((e) => (e.kind === 'step' ? clean(e) : e));
    if (!secrets.length) return { ...item, events };
    return {
      ...item,
      events: events.map((e) => (e.kind === 'request' ? scrubRequest(e, secrets, true, true) : { ...e, effects: swapSecrets(e.effects, secrets) })),
      apiOverrides: swapSecrets(item.apiOverrides, secrets),
      aiDocs: swapSecrets(item.aiDocs, secrets),
    };
  }
  // ---------- 几条录制按给定顺序接成一条新脚本（AI 排好顺序、截掉重复的登录步骤后调用）----------
  // 分析时事件按时间排序，所以每段的时间整体挪到上一段后面；事件 id 加上段号前缀，同一条脚本用两次也不撞
  const MERGE_GAP = 60000; // 段与段隔一分钟：前一段最后一步不会把后一段的接口当成自己触发的去等
  // 事件可能很多（轮询接口），不用 Math.min(...list)：参数太多会爆栈
  const minOf = (list) => list.reduce((m, x) => (x < m ? x : m), Infinity);
  const maxOf = (list) => list.reduce((m, x) => (x > m ? x : m), -Infinity);
  const hostOf = (url) => { try { return new URL(url).host; } catch (e) { return ''; } };
  // 顶层步骤（语义步骤的成员不算），按时间排好
  function topSteps(evs) {
    const groups = new Set(evs.filter((e) => e.kind === 'step' && Array.isArray(e.members)).map((e) => e.id));
    return evs.filter((e) => e.kind === 'step' && !groups.has(e.groupedIn)).sort((a, b) => a.ts - b.ts);
  }
  // from / to 是 get_recording 里的步骤号（从 1 开始，含两端）。语义步骤的成员跟着它走，请求按时间归到步骤
  function mergeRange(item, from, to, k) {
    const A = analyze(item.events, item.settings || {}, item.state, item.apiOverrides, item.aiDocs);
    const n = A.steps.length;
    const f = from == null ? 1 : from;
    const t = to == null ? n : to;
    const label = `第 ${k + 1} 段「${item.name || (item.state && item.state.name) || item.id || ''}」`;
    if (!Number.isInteger(f) || !Number.isInteger(t) || f < 1 || t > n || f > t) {
      throw new Error(`${label}只有 ${n} 步，步骤范围 ${f}-${t} 不对（步骤号从 1 开始，含两端）`);
    }
    const start = f === 1 ? -Infinity : A.steps[f - 1].ts;
    const end = t === n ? Infinity : A.steps[t].ts;
    const evs = item.events || [];
    const groups = new Set(evs.filter((e) => e.kind === 'step' && Array.isArray(e.members)).map((e) => e.id));
    const inside = (e) => e.ts >= start && e.ts < end;
    const keptGroups = new Set(evs.filter((e) => groups.has(e.id) && inside(e)).map((e) => e.id));
    let kept = evs.filter((e) => (e.kind === 'step' && groups.has(e.groupedIn) ? keptGroups.has(e.groupedIn) : inside(e)));
    // 截掉的下一步是“打开页面”，紧挨在它前面、同一地址的“地址变了”分析时被它替掉了，不能留在这一段末尾
    const next = A.steps[t];
    const tail = topSteps(kept).pop();
    if (next && next.type === 'navigate' && tail && tail.type === 'url' && tail.url === next.url && next.ts - tail.ts < 3000) kept = kept.filter((e) => e !== tail);
    if (!kept.some((e) => e.kind === 'step')) throw new Error(`${label}的步骤 ${f}-${t} 截出来没有操作`);
    // 这一段开头在哪个页面：开头那步之前（含）最后一个顶层页面里的步骤的地址（开头在 iframe 里时用它外面的页面）
    const lead = topSteps(kept)[0];
    const before = topSteps(evs).filter((e) => !e.frame && e.url && e.ts <= lead.ts).pop();
    const page = (before && before.url) || (item.state && item.state.startUrl) || '';
    const ownUrl = (item.state && item.state.startUrl) || (evs.find((e) => e.kind === 'step' && e.url) || {}).url || '';
    return { kept, lead, page, whole: f === 1, host: hostOf(ownUrl) };
  }
  // 一段挪到 cursor 之后：换 id、挪时间（sid 是录制时间，配对日期区间用，一起挪）。
  // 第二段起：不是从“打开页面”开始的（截掉了开头，或者开头那步被删过），先补一步打开它开头所在的页面；
  // 开头的“打开页面”标上 jump，上一段不会自己跳过去，回放时直接打开，不先等 5 秒。第一段由扩展打开起始页面，不用补
  function shiftPart(range, k, cursor) {
    const { kept, lead, page } = range;
    const p = `p${k + 1}_`;
    const nav = k > 0 && lead.type !== 'navigate' ? page : '';
    const off = cursor + (nav ? 1 : 0) - minOf(kept.map((e) => e.ts));
    const out = kept.map((e) => {
      const o = { ...e, id: p + e.id, ts: e.ts + off };
      if (e.groupedIn) o.groupedIn = p + e.groupedIn;
      if (Array.isArray(e.members)) o.members = e.members.map((x) => (typeof x === 'string' ? p + x : x));
      for (const key of ['endTs', 'commitTs', 'sid']) if (Number.isFinite(e[key])) o[key] = e[key] + off;
      if (k > 0 && e === lead && e.type === 'navigate') o.jump = true;
      return o;
    });
    if (nav) out.unshift({ kind: 'step', type: 'navigate', id: p + 'open', ts: cursor, url: nav, jump: true });
    return { events: out, end: maxOf(out.map((e) => (Number.isFinite(e.endTs) ? Math.max(e.ts, e.endTs) : e.ts))) };
  }
  // 同一条带密码的脚本用了两次：后面那段的密码换个编号，请求里的占位符跟着换，两段各对应自己的密码参数
  function secretSwapper(events, used, k) {
    const ids = [...new Set(events.map((e) => e.secretId).filter(Boolean))];
    const swap = ids.filter((id) => used.has(id)).map((id) => [id, `${id}p${k + 1}`]);
    ids.concat(swap.map((x) => x[1])).forEach((id) => used.add(id));
    if (!swap.length) return (x) => x;
    const to = new Map(swap);
    const text = (str) => swap.reduce((t, [a, b]) => t.split(`__PR_SECRET_${a}__`).join(`__PR_SECRET_${b}__`), str);
    const step = (e) => (e && to.has(e.secretId) ? { ...e, secretId: to.get(e.secretId) } : e);
    return (x) => {
      if (x == null) return x;
      const y = JSON.parse(text(JSON.stringify(x)));
      return Array.isArray(y) ? y.map(step) : y;
    };
  }
  // 接口名在起始页面那个站点时不带主机名：合并后起始页面换了站点，这一段的接口改了名，说明和手改的字段跟着改名
  function apiRenames(requests, from, to) {
    const map = new Map();
    if (from === to) return map;
    for (const r of requests) {
      try { const u = new URL(r.url); map.set(apiNameOf(r, u, from), apiNameOf(r, u, to)); } catch (e) { /* ignore */ }
    }
    return map;
  }
  const rekey = (obj, map) => Object.fromEntries(Object.entries(obj || {}).map(([name, v]) => [map.get(name) || name, v]));
  // 同一个接口在几段里都有说明：前面的段优先，后面的补空缺（空字符串、空对象算空缺，参数说明这类对象逐项补）
  const isPlain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  const blank = (v) => v == null || v === '' || (isPlain(v) && !Object.keys(v).length);
  function fillDocs(base, extra) {
    const out = { ...(extra || {}) };
    for (const [key, v] of Object.entries(base || {})) {
      if (blank(v)) { if (!(key in out)) out[key] = v; } else out[key] = isPlain(v) && isPlain(out[key]) ? fillDocs(v, out[key]) : v;
    }
    return out;
  }
  // 手改的接口字段：按字段整体取前面那段的值（字段值本身是对象时不拼两段的内容）
  function mergeOverrides(base, extra) {
    const out = { ...base };
    for (const [name, ov] of Object.entries(extra || {})) {
      const cur = out[name] || {};
      out[name] = Object.fromEntries([...new Set([...Object.keys(ov || {}), ...Object.keys(cur)])].map((sec) => [sec, { ...((ov || {})[sec] || {}), ...(cur[sec] || {}) }]));
    }
    return out;
  }
  // parts：[{ item, from, to }]，item 是脚本库里的一条；opts：{ id, name, description }。返回新脚本的 state、events、apiOverrides、aiDocs，原脚本不动
  function mergeRecordings(parts, opts) {
    opts = opts || {};
    if (!Array.isArray(parts) || !parts.length) throw new Error('至少要给一段脚本');
    const events = [];
    const apis = {};
    const secrets = new Set();
    let apiOverrides = {};
    let startUrl = '';
    let cursor = 0;
    parts.forEach((part, k) => {
      const item = part.item;
      const range = mergeRange(item, part.from, part.to, k);
      if (k === 0) startUrl = (range.whole && item.state && item.state.startUrl) || (range.lead.type === 'navigate' && range.lead.url) || range.page;
      const r = shiftPart(range, k, cursor);
      const swap = secretSwapper(r.events, secrets, k);
      const names = apiRenames(r.events.filter((e) => e.kind === 'request'), range.host, hostOf(startUrl));
      events.push(...swap(r.events));
      cursor = r.end + MERGE_GAP;
      apiOverrides = mergeOverrides(apiOverrides, rekey(swap(item.apiOverrides), names));
      for (const [name, d] of Object.entries(rekey(swap(item.aiDocs && item.aiDocs.apis), names))) apis[name] = fillDocs(apis[name], d);
    });
    const first = parts[0].item;
    const name = String(opts.name || parts.map((x) => x.item.name || (x.item.state && x.item.state.name) || '').filter(Boolean).join(' + ') || '合并的录制').slice(0, 100);
    const description = String(opts.description || '');
    const state = { id: opts.id, name, description, title: (first.state && first.state.title) || '', startUrl, startedAt: Date.now(), recording: false };
    return { state, events, apiOverrides, aiDocs: { apis } };
  }
  // 直接请求失败后能不能自动改走页面回放（等于再发一次）：没发出去、鉴权被拒的可以；
  // 写接口返回业务错误或其他 4xx 时说不准有没有生效，只读接口才可以
  function canFallback(method, r) {
    if (r.unknown) return false;
    if (r.notSent || r.status === 401 || r.status === 403) return true;
    const refused = !!r.rejected || (r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429);
    return refused && /^(GET|HEAD)$/i.test(method || 'GET');
  }
  return { analyze, build, pathTemplate, stepDesc, aiPrompt, toolSchemas, scrubRequest, exportRequest, maskDeep, maskUrl, maskStepUrls, sensitiveKey, keyTokens, scrubBackup, canFallback, mergeRecordings };
})();
if (typeof module !== 'undefined') module.exports = PR_EXPORTER;
