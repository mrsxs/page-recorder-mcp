// 运行在页面主环境 (MAIN world)：拦截 fetch / XMLHttpRequest，以及 JSONP、EventSource、WebSocket、sendBeacon，
// 抓取请求与响应数据，通过 window.postMessage 交给 content script。只有在录制状态下才会读取响应体。
// 页面钩子看不到的（Worker 里的请求、表单提交、下载）由后台用 webRequest 补记（见 background.js“浏览器层面的兜底抓取”）。
(() => {
  if (window.__PAGE_RECORDER_HOOK__) return;
  // 空白 iframe（about:blank、srcdoc）没有自己的 content script 来转发：交给最近的、有地址的外层页面里的钩子
  try {
    if (/^about:/.test(location.href) && window.parent !== window) {
      let w = window.parent;
      while (/^about:/.test(w.location.href) && w.parent !== w) w = w.parent;
      if (typeof w.__PR_HOOK_PATCH__ === 'function') { w.__PR_HOOK_PATCH__(window); return; }
    }
  } catch (e) { /* 沙箱 iframe 访问不了外层：按独立页面处理 */ }
  try { Object.defineProperty(window, '__PAGE_RECORDER_HOOK__', { value: true }); } catch (e) { return; }

  const TAG = '__page_recorder__';
  let state = null; // null = 尚未得知(先缓冲) | true = 录制中 | false = 未录制
  let buffer = [];
  let maxBody = 512 * 1024;
  // xml 只认 /xml、+xml（xlsx 的类型名 …openxmlformats… 里也有 xml 这几个字母，那是二进制文件）
  const TEXT_CT = /json|^text\/|[/+]xml\b|javascript|ecmascript|x-www-form-urlencoded|graphql|event-stream|csv|yaml/i;
  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

  function post(data) {
    try {
      window.postMessage({ [TAG]: 'net', data }, '*');
    } catch (e) {
      try { window.postMessage({ [TAG]: 'net', data: JSON.parse(JSON.stringify(data)) }, '*'); } catch (e2) { /* ignore */ }
    }
  }
  function emit(data) {
    if (state === true) post(data);
    else if (state === null) {
      buffer.push(data);
      if (buffer.length > 300) buffer.shift();
    }
  }
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (e.source !== window || !d || d[TAG] !== 'state') return;
    state = !!d.recording;
    if (d.maxBody) maxBody = d.maxBody;
    if (state) buffer.forEach(post);
    buffer = [];
    syncObservers();
  });
  const active = () => state !== false;

  function parseText(text, ct) {
    if (typeof text !== 'string') return null;
    const size = text.length;
    const truncated = size > maxBody;
    const t = truncated ? text.slice(0, maxBody) : text;
    if (!truncated && (/json/i.test(ct || '') || /^\s*[[{]/.test(t))) {
      try { return { type: 'json', value: JSON.parse(t), size }; } catch (e) { /* not json */ }
    }
    const out = { type: 'text', value: t, size };
    if (truncated) out.truncated = true;
    return out;
  }

  // 对象的类型按标签认（空白 iframe 里的对象是另一个窗口造的，instanceof 对不上）
  const tagOf = (x) => Object.prototype.toString.call(x).slice(8, -1);
  async function serializeBody(body) {
    try {
      if (body == null) return null;
      if (typeof body === 'string') return parseText(body);
      const tag = tagOf(body);
      if (tag === 'URLSearchParams') return { type: 'form', value: body.toString() };
      if (tag === 'FormData') {
        const value = [];
        body.forEach((v, k) => value.push([k, typeof v === 'string' ? v : { file: v.name, size: v.size, mime: v.type }]));
        return { type: 'multipart', value };
      }
      if (tag === 'Blob' || tag === 'File') {
        if (body.size <= maxBody && TEXT_CT.test(body.type || '')) return parseText(await body.text(), body.type);
        return { type: 'blob', size: body.size, mime: body.type };
      }
      if (tag === 'ArrayBuffer' || ArrayBuffer.isView(body)) return { type: 'binary', size: body.byteLength };
      if (body.nodeType === 9) {
        return parseText(new XMLSerializer().serializeToString(body), 'xml');
      }
      if (tag === 'ReadableStream') return { type: 'stream' };
      return parseText(String(body));
    } catch (e) {
      return { type: 'error', value: String(e) };
    }
  }

  function headersToObj(h) {
    const o = {};
    if (!h) return o;
    try {
      if (tagOf(h) === 'Headers') h.forEach((v, k) => { o[k] = v; });
      else if (Array.isArray(h)) h.forEach(([k, v]) => { o[String(k).toLowerCase()] = String(v); });
      else Object.keys(h).forEach((k) => { o[k.toLowerCase()] = String(h[k]); });
    } catch (e) { /* ignore */ }
    return o;
  }

  function parseRawHeaders(raw) {
    const o = {};
    (raw || '').trim().split(/[\r\n]+/).forEach((line) => {
      const i = line.indexOf(':');
      if (i > 0) o[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    });
    return o;
  }

  // 以流的方式读取响应副本：超过上限或超时(长连接/SSE)就截断，不影响页面自身读取
  async function readStream(res, ct) {
    if (!res.body) return parseText(await res.text(), ct);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    let truncated = false;
    const deadline = Date.now() + 30000;
    try {
      for (;;) {
        const remain = deadline - Date.now();
        if (remain <= 0) { truncated = true; break; }
        const r = await Promise.race([
          reader.read(),
          new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), remain)),
        ]);
        if (r.timeout) { truncated = true; break; }
        if (r.done) break;
        text += decoder.decode(r.value, { stream: true });
        if (text.length > maxBody) { truncated = true; break; }
      }
    } finally {
      if (truncated) reader.cancel().catch(() => {});
    }
    if (!truncated) text += decoder.decode();
    const out = parseText(text, ct);
    if (truncated && out) { out.truncated = true; if (out.type === 'json') out.type = 'text'; }
    return out;
  }

  // ---------------- 页面自己最新的请求头 ----------------
  // 页面代码给请求加的头（Authorization、token、签名、CSRF 等）随登录、时间变化，录下的值会过期。
  // 这里始终记着页面最近一次发请求时用的值（只在页面内存里，不发到任何地方），扩展直接调用接口时用它补上。
  // 只有会话级的鉴权头（Authorization、CSRF、token）在同一个源的不同路径之间共用，并按每个头的更新时间取最新；
  // 其他头（签名、租户、业务头）只认同一路径，免得把别的路径、别的身份的值带过去
  const STD_HDR = /^(accept|accept-language|content-type|content-length|content-language|cache-control|pragma)$/i;
  const SHARED_HDR = /^(authorization|x-csrf-token|x-xsrf-token|x-csrftoken|csrf-token|csrftoken|x-token|token|x-auth-token|x-access-token|access-token)$/i;
  const live = new Map(); // origin+path 或 origin → { 头名: [值, 序号] }
  let seq = 0; // 递增序号表示先后（同一毫秒里的多次更新也分得清）
  function noteHeaders(url, headers) {
    try {
      const u = new URL(url, location.href);
      const now = ++seq;
      const h = Object.entries(headers || {}).filter(([k, v]) => !STD_HDR.test(k) && typeof v === 'string').map(([k, v]) => [k.toLowerCase(), v]);
      if (!h.length) return;
      const put = (key, sharedOnly) => {
        const cur = live.get(key) || {};
        live.delete(key); // 重新插入，保持最近使用的在后面
        for (const [k, v] of h) if (!sharedOnly || SHARED_HDR.test(k)) cur[k] = [v, now];
        if (Object.keys(cur).length) live.set(key, cur);
      };
      put(u.origin + u.pathname, false);
      put(u.origin, true);
      while (live.size > 300) live.delete(live.keys().next().value);
    } catch (e) { /* ignore */ }
  }
  try {
    Object.defineProperty(window, '__PR_LIVE_HEADERS__', {
      value: (url) => {
        try {
          const u = new URL(url, location.href);
          const out = Object.assign({}, live.get(u.origin + u.pathname));
          for (const [k, x] of Object.entries(live.get(u.origin) || {})) if (!out[k] || out[k][1] < x[1]) out[k] = x;
          return Object.fromEntries(Object.entries(out).map(([k, x]) => [k, x[0]]));
        } catch (e) { return {}; }
      },
    });
  } catch (e) { /* ignore */ }

  // ---------------- 页面自己最新的令牌字段 ----------------
  // 查询参数、请求体里名字像令牌、签名、CSRF 的字段（录制时会脱敏），同样记着页面最近一次发的值，直接调用时补上。
  // 会话级的（csrf、token、session）同源各路径共用，其余只认同一路径
  const SENS_PART = /password|passwd|pwd|passcode|secret|token|csrf|xsrf|credential|captcha|apikey|signature|sessionid|authcode|authkey|otp$|smscode|verifycode/;
  const SENS_WORD = /^(pass|pin|sign|sid|auth|session|ticket|vcode|otp)$/;
  const SHARED_FIELD = /csrf|xsrf|token|session|^sid$|^auth$/;
  const sensName = (k) => { const n = String(k).toLowerCase().replace(/[_\-\s]/g, ''); return !!n && (SENS_PART.test(n) || SENS_WORD.test(n)); };
  // 和导出时的路径写法一致：a.b[0].c，键名本身带点号、方括号的转义
  const escKey = (k) => String(k).replace(/[\\.[\]]/g, '\\$&');
  const liveFields = new Map(); // origin+path 或 origin → { 字段: [值, 序号] }
  function noteFields(url, body) {
    try {
      const u = new URL(url, location.href);
      const found = [];
      u.searchParams.forEach((v, k) => { if (v && sensName(k)) found.push([k, k, v]); });
      let text = null;
      if (typeof body === 'string') text = body;
      else if (body && tagOf(body) === 'URLSearchParams') text = body.toString();
      else if (body && tagOf(body) === 'FormData') body.forEach((v, k) => { if (typeof v === 'string' && v && sensName(k)) found.push([k, k, v]); });
      if (text && text.length < 200000) {
        const t = text.trim();
        let o = null;
        if (/^[[{]/.test(t)) { try { o = JSON.parse(t); } catch (e) { o = null; } }
        if (o && typeof o === 'object') {
          const walk = (v, path, depth) => {
            if (depth > 8 || !v || typeof v !== 'object') return;
            for (const [k, x] of Object.entries(v)) {
              const p = Array.isArray(v) ? `${path}[${k}]` : path ? `${path}.${escKey(k)}` : escKey(k);
              if (x && typeof x === 'object') walk(x, p, depth + 1);
              else if (x != null && x !== '' && !Array.isArray(v) && sensName(k)) found.push([p, k, String(x)]);
            }
          };
          walk(o, '', 0);
        } else if (/^[^=&\s]+=[^&]*(&|$)/.test(t)) new URLSearchParams(t).forEach((v, k) => { if (v && sensName(k)) found.push([k, k, v]); });
      }
      if (!found.length) return;
      const now = ++seq;
      const put = (key, shared) => {
        const cur = liveFields.get(key) || {};
        liveFields.delete(key);
        for (const [p, k, v] of found) {
          if (shared && !SHARED_FIELD.test(String(k).toLowerCase().replace(/[_\-\s]/g, ''))) continue;
          cur[p] = [v, now];
          if (p !== k) cur[k] = [v, now];
        }
        if (Object.keys(cur).length) liveFields.set(key, cur);
      };
      put(u.origin + u.pathname, false);
      put(u.origin, true);
      while (liveFields.size > 300) liveFields.delete(liveFields.keys().next().value);
    } catch (e) { /* ignore */ }
  }
  try {
    Object.defineProperty(window, '__PR_LIVE_FIELDS__', {
      value: (url) => {
        try {
          const u = new URL(url, location.href);
          const out = Object.assign({}, liveFields.get(u.origin + u.pathname));
          for (const [k, x] of Object.entries(liveFields.get(u.origin) || {})) if (!out[k] || out[k][1] < x[1]) out[k] = x;
          return Object.fromEntries(Object.entries(out).map(([k, x]) => [k, x[0]]));
        } catch (e) { return {}; }
      },
    });
  } catch (e) { /* ignore */ }

  // ---------------- 没挂到页面上的文件框 ----------------
  // document.createElement('input') 后直接 .click() 选文件（VueUse useFileDialog、编辑器的上传按钮）：
  // change 事件不经过 document，录制端收不到，这里替它报告选了哪些文件
  try {
    const IP = HTMLInputElement.prototype;
    const watch = (input) => {
      if (input.type !== 'file' || input.isConnected || input.__prWatch) return;
      input.__prWatch = true;
      input.addEventListener('change', () => {
        if (state !== true) return;
        const files = [...(input.files || [])].map((f) => f.name);
        if (files.length) window.postMessage({ [TAG]: 'filepick', files, multiple: !!input.multiple, accept: input.accept || '' }, '*');
      });
    };
    for (const name of ['click', 'showPicker']) {
      const orig = IP[name];
      if (typeof orig !== 'function') continue;
      IP[name] = function () { try { watch(this); } catch (e) { /* ignore */ } return orig.apply(this, arguments); };
    }
  } catch (e) { /* ignore */ }

  // ---------------- 原生弹窗 ----------------
  // 录下弹窗类型、内容和用户的选择，回放时按同样的选择应答
  for (const kind of ['alert', 'confirm', 'prompt']) {
    const orig = window[kind];
    if (typeof orig !== 'function') continue;
    window[kind] = function (message) {
      const result = orig.apply(this, arguments);
      if (state === true) {
        try { window.postMessage({ [TAG]: 'dialog', kind, message: String(message == null ? '' : message).slice(0, 300), result: kind === 'alert' ? true : result }, '*'); } catch (e) { /* ignore */ }
      }
      return result;
    };
  }
  // 发请求的那一刻通知录制端核对字段值（选完日期立刻发请求时，请求里的值就是这一刻的）
  const reqStart = () => { if (state === true) window.postMessage({ [TAG]: 'reqstart' }, '*'); };

  // ---------------- JSONP ----------------
  // <script src="…?callback=fn"> 这种请求不走 fetch / XHR（淘宝、1688 的 mtop，老系统的跨域接口）：
  // 看到带回调参数的脚本插进页面，就把那个回调包一层，返回的数据从回调的参数里拿
  const CB_KEY = /^(callback|cb|jsonp|jsoncallback|jsonpcallback|_callback|callbackname|jsonp_callback|_jsonp|_cb)$/i;
  const CB_NAME = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/;
  const observers = []; // [观察器, 文档]
  function noteScript(W, s, seen) {
    if (seen.has(s) || !active()) return;
    let u;
    try { u = new URL(s.src); } catch (e) { return; }
    if (!/^https?:$/.test(u.protocol)) return;
    let key = null;
    let name = null;
    for (const [k, v] of u.searchParams) if (CB_KEY.test(k) && CB_NAME.test(v)) { key = k; name = v; break; }
    if (!key) return;
    seen.add(s);
    const parts = name.split('.');
    const prop = parts.pop();
    let holder = W;
    for (const p of parts) holder = holder == null ? null : holder[p];
    const rec = { id: uid(), via: 'jsonp', ts: Date.now(), pageUrl: location.href, method: 'GET', url: u.href, requestHeaders: {}, credentials: 'include', jsonp: key };
    let done = false;
    const finish = (got, data, err) => {
      if (done) return;
      done = true;
      rec.endTs = Date.now();
      if (err) rec.error = err;
      else {
        rec.status = 200;
        rec.statusText = 'OK';
        rec.responseHeaders = { 'content-type': 'application/json' };
        rec.responseBody = null;
        if (got) { try { const t = JSON.stringify(data); if (t !== undefined) rec.responseBody = parseText(t, 'json'); } catch (e) { rec.responseBody = { type: 'error', value: String(e) }; } }
      }
      emit(rec);
    };
    const wrap = (fn) => function () { try { finish(true, arguments[0]); } catch (e) { /* ignore */ } return fn.apply(this, arguments); };
    let restore = null;
    if (holder && (typeof holder === 'object' || typeof holder === 'function')) {
      try {
        const desc = Object.getOwnPropertyDescriptor(holder, prop);
        // 原型链上有没有同名属性（继承来的存取器、只读属性）：有就不能在对象自己身上再定义一个把它挡住
        let inherited = false;
        if (!desc) for (let x = Object.getPrototypeOf(holder); x && !inherited; x = Object.getPrototypeOf(x)) inherited = !!Object.getOwnPropertyDescriptor(x, prop);
        const plain = !!desc && !desc.get && !desc.set && desc.writable; // 对象自己的、普通可写的属性
        const cur = holder[prop];
        if (typeof cur === 'function') {
          // 页面自己的存取器、只读属性、继承来的属性不动（只记请求，没有返回）
          if (plain) holder[prop] = wrap(cur);
        } else if ((!desc && !inherited) || (plain && desc.configurable)) {
          // 回调在脚本插入之后才定义：临时换成存取器，等它被赋值时包上；请求结束后还原成普通属性
          let val = cur;
          const get = () => val;
          Object.defineProperty(holder, prop, { configurable: true, enumerable: desc ? desc.enumerable : true, get, set(v) { val = typeof v === 'function' && !done ? wrap(v) : v; } });
          restore = () => {
            try {
              const now = Object.getOwnPropertyDescriptor(holder, prop);
              if (!now || now.get !== get) return; // 页面已经删掉或自己重新定义了
              // 原来没有这个属性、之后也一直没被赋值：删掉，不给页面留下多余的全局属性
              if (!desc && val === undefined) delete holder[prop];
              else Object.defineProperty(holder, prop, { configurable: true, enumerable: desc ? desc.enumerable : true, writable: true, value: val });
            } catch (e) { /* ignore */ }
          };
        }
      } catch (e) { /* 不能改写的属性：只记请求，没有返回 */ }
    }
    const end = (got, data, err) => { finish(got, data, err); if (restore) { const r = restore; restore = null; r(); } };
    s.addEventListener('error', () => end(false, null, 'script load error'));
    // 脚本执行完回调还没被调用（回调换了名字、被别的代码接走）：只记请求
    s.addEventListener('load', () => setTimeout(() => end(false), 0));
  }
  function watchJsonp(W) {
    try {
      const seen = new WeakSet();
      const obs = new W.MutationObserver((muts) => {
        for (const m of muts) for (const n of m.addedNodes) if (n.nodeType === 1 && n.tagName === 'SCRIPT' && n.src) noteScript(W, n, seen);
      });
      observers.push([obs, W.document]);
      if (state !== false) obs.observe(W.document, { childList: true, subtree: true });
    } catch (e) { /* ignore */ }
  }
  // 不在录制时不观察页面变化（省开销），开始录制再接上
  function syncObservers() {
    for (const [obs, doc] of observers) {
      try { obs.disconnect(); if (state !== false) obs.observe(doc, { childList: true, subtree: true }); } catch (e) { /* 文档已经没了 */ }
    }
  }

  // 一个窗口里的 fetch / XHR / EventSource / sendBeacon / JSONP。除了页面自己的窗口，页面新建的空白 iframe
  // （about:blank、srcdoc，没有自己的地址）里也有一套独立的 fetch / XHR：有的页面专门从空白 iframe 里取“干净”的来发请求，
  // 所以这些窗口也照样接上，抓到的请求都算在外层页面上
  function patchNet(W) {
    if (W !== window) {
      try {
        if (W.__PAGE_RECORDER_HOOK__) return;
        Object.defineProperty(W, '__PAGE_RECORDER_HOOK__', { value: true });
      } catch (e) { return; }
    }
    const base = () => { try { return W.document.baseURI || location.href; } catch (e) { return location.href; } };
    const abs = (x) => new URL(String(x), base()).href;

    // ---------------- fetch ----------------
    const origFetch = W.fetch;
    if (typeof origFetch === 'function') {
      W.fetch = function (input, init) {
        const req = input && tagOf(input) === 'Request' ? input : null;
        try {
          if (!(init && init.__prNoRewrite)) {
            const url = abs(req ? req.url : input);
            noteHeaders(url, Object.assign(headersToObj(req && req.headers), headersToObj(init && init.headers)));
            noteFields(url, init ? init.body : null);
          }
        } catch (e) { /* ignore */ }
        if (!active()) return origFetch.apply(this, arguments);
        reqStart();
        const rec = { id: uid(), via: 'fetch', ts: Date.now(), pageUrl: location.href };
        let reqBodyP = null;
        try {
          rec.url = abs(req ? req.url : input);
          rec.method = String((init && init.method) || (req && req.method) || 'GET').toUpperCase();
          rec.requestHeaders = Object.assign(headersToObj(req && req.headers), headersToObj(init && init.headers));
          rec.credentials = (init && init.credentials) || (req && req.credentials) || 'same-origin';
          if (init && init.body != null) reqBodyP = serializeBody(init.body);
          else if (req && !/^(GET|HEAD)$/.test(rec.method) && !req.bodyUsed) {
            const ct = req.headers.get('content-type');
            reqBodyP = req.clone().text().then((t) => parseText(t, ct)).catch(() => null);
          }
        } catch (e) { /* ignore */ }
        const p = origFetch.apply(this, arguments);
        p.then(
          (res) => {
            let clone = null;
            try { clone = res.clone(); } catch (e) { /* body already used */ }
            (async () => {
              rec.status = res.status;
              rec.statusText = res.statusText;
              rec.responseHeaders = headersToObj(res.headers);
              const ct = res.headers.get('content-type') || '';
              if (!clone || res.type === 'opaque' || res.status === 204 || res.status === 304) rec.responseBody = null;
              else if (ct && !TEXT_CT.test(ct)) {
                rec.responseBody = { type: 'binary', mime: ct, size: +res.headers.get('content-length') || undefined };
                clone.body && clone.body.cancel().catch(() => {});
              } else {
                try { rec.responseBody = await readStream(clone, ct); } catch (e) { rec.responseBody = { type: 'error', value: String(e) }; }
              }
              rec.requestBody = await reqBodyP;
              rec.endTs = Date.now();
              emit(rec);
            })();
          },
          async (err) => {
            rec.requestBody = await reqBodyP;
            rec.error = String((err && err.message) || err);
            rec.endTs = Date.now();
            emit(rec);
          }
        );
        return p;
      };
    }

    // ---------------- XMLHttpRequest ----------------
    const XHR = W.XMLHttpRequest.prototype;
    const oOpen = XHR.open;
    const oSend = XHR.send;
    const oSet = XHR.setRequestHeader;
    XHR.open = function (method, url) {
      try {
        this.__pr = { method: String(method || 'GET').toUpperCase(), url: abs(url), headers: {} };
      } catch (e) { this.__pr = null; }
      return oOpen.apply(this, arguments);
    };
    XHR.setRequestHeader = function (k, v) {
      try { if (this.__pr) this.__pr.headers[String(k).toLowerCase()] = String(v); } catch (e) { /* ignore */ }
      return oSet.apply(this, arguments);
    };
    XHR.send = function (body) {
      const info = this.__pr;
      if (info) { noteHeaders(info.url, info.headers); noteFields(info.url, body); }
      if (info && active()) {
        reqStart();
        const rec = { id: uid(), via: 'xhr', ts: Date.now(), pageUrl: location.href, method: info.method, url: info.url, requestHeaders: info.headers, credentials: this.withCredentials ? 'include' : 'same-origin' };
        const reqBodyP = serializeBody(body);
        const xhr = this;
        xhr.addEventListener('loadend', async () => {
          rec.status = xhr.status;
          rec.statusText = xhr.statusText;
          rec.endTs = Date.now();
          rec.responseHeaders = parseRawHeaders(xhr.getAllResponseHeaders());
          try {
            const rt = xhr.responseType;
            const ct = xhr.getResponseHeader('content-type') || '';
            if (xhr.status === 0) rec.responseBody = null;
            else if (rt === '' || rt === 'text') rec.responseBody = parseText(xhr.responseText, ct);
            else if (rt === 'json') {
              const s = JSON.stringify(xhr.response);
              rec.responseBody = s && s.length > maxBody
                ? { type: 'text', value: s.slice(0, maxBody), truncated: true, size: s.length }
                : { type: 'json', value: xhr.response, size: s ? s.length : 0 };
            } else if (rt === 'document') {
              rec.responseBody = xhr.responseXML ? parseText(new XMLSerializer().serializeToString(xhr.responseXML), ct) : null;
            } else if (rt === 'blob' && TEXT_CT.test(ct) && xhr.response && xhr.response.size <= maxBody) {
              rec.responseBody = parseText(await xhr.response.text(), ct);
            } else {
              const r = xhr.response;
              rec.responseBody = { type: 'binary', mime: ct, size: (r && (r.size || r.byteLength)) || undefined };
            }
          } catch (e) {
            rec.responseBody = { type: 'error', value: String(e) };
          }
          if (xhr.status === 0) rec.error = 'network error / aborted';
          rec.requestBody = await reqBodyP;
          emit(rec);
        });
      }
      return oSend.apply(this, arguments);
    };

    // ---------------- EventSource（服务端推送） ----------------
    // 连接本身是一次 GET；返回是一条条推过来的消息，记下开头的几条
    try {
      const OES = W.EventSource;
      if (typeof OES === 'function') {
        // 用 Proxy 只拦“构造”：静态属性、prototype、instanceof 和继承它的子类（new.target）都照旧
        W.EventSource = new Proxy(OES, {
          construct(target, args, newTarget) {
            const es = Reflect.construct(target, args, newTarget);
            if (active()) { try { tapEventSource(es, abs(args[0]), args[1]); } catch (e) { /* ignore */ } }
            return es;
          },
        });
      }
    } catch (e) { /* ignore */ }

    // ---------------- WebSocket ----------------
    // 长连接不是“一次请求一次返回”，不能重发；记下连到哪、开头收发了什么，方便看懂页面的数据是从哪来的
    try {
      const OWS = W.WebSocket;
      if (typeof OWS === 'function') {
        W.WebSocket = new Proxy(OWS, {
          construct(target, args, newTarget) {
            const ws = Reflect.construct(target, args, newTarget);
            if (active()) { try { tapWebSocket(ws, ws.url || abs(args[0])); } catch (e) { /* ignore */ } }
            return ws;
          },
        });
      }
    } catch (e) { /* ignore */ }

    // ---------------- sendBeacon ----------------
    // 页面关闭、跳转前用它发数据（多数是埋点，也有保存草稿的）；浏览器不给返回，只记请求
    try {
      const NP = W.Navigator && W.Navigator.prototype;
      const oBeacon = NP && NP.sendBeacon;
      if (typeof oBeacon === 'function') {
        NP.sendBeacon = function (url, data) {
          const queued = oBeacon.apply(this, arguments);
          if (active()) {
            try {
              const rec = { id: uid(), via: 'beacon', ts: Date.now(), pageUrl: location.href, method: 'POST', url: abs(url), requestHeaders: {}, credentials: 'include', status: 0, responseBody: null, noResponse: true };
              if (!queued) rec.error = 'sendBeacon 没有排上队';
              serializeBody(data).then((b) => { rec.requestBody = b; rec.endTs = Date.now(); emit(rec); });
            } catch (e) { /* ignore */ }
          }
          return queued;
        };
      }
    } catch (e) { /* ignore */ }

    watchJsonp(W);

    // 页面取 iframe.contentWindow / contentDocument 时，空白 iframe 的窗口也接上
    try {
      const seenForeign = new WeakSet();
      const adopt = (w) => {
        if (!w || w === W || (typeof w !== 'object' && typeof w !== 'function') || seenForeign.has(w)) return;
        try { if (!w.__PAGE_RECORDER_HOOK__ && /^about:/.test(w.location.href)) patchNet(w); } catch (e) { seenForeign.add(w); /* 跨域的 iframe 有它自己的一套钩子 */ }
      };
      const FP = W.HTMLIFrameElement.prototype;
      const dw = Object.getOwnPropertyDescriptor(FP, 'contentWindow');
      if (dw && dw.get) Object.defineProperty(FP, 'contentWindow', { configurable: true, enumerable: dw.enumerable, get() { const w = dw.get.call(this); adopt(w); return w; } });
      const dd = Object.getOwnPropertyDescriptor(FP, 'contentDocument');
      if (dd && dd.get) Object.defineProperty(FP, 'contentDocument', { configurable: true, enumerable: dd.enumerable, get() { const d = dd.get.call(this); try { adopt(d && d.defaultView); } catch (e) { /* ignore */ } return d; } });
    } catch (e) { /* ignore */ }
  }

  function tapWebSocket(ws, url) {
    const rec = { id: uid(), via: 'websocket', ts: Date.now(), pageUrl: location.href, method: 'WS', url, requestHeaders: {}, credentials: 'include' };
    let sent = '';
    let got = '';
    let n = 0;
    let done = false;
    let timer = null;
    const line = (d) => (typeof d === 'string' ? d : `（二进制 ${(d && (d.byteLength || d.size)) || 0} 字节）`) + '\n';
    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      rec.endTs = Date.now();
      if (err && !n) rec.error = err;
      else { rec.status = 101; rec.statusText = 'Switching Protocols'; rec.responseHeaders = {}; }
      // 只是开头的几条，标成截断：不能当成完整的请求、返回
      rec.requestBody = sent ? { type: 'text', value: sent.slice(0, maxBody), size: sent.length, truncated: true } : null;
      rec.responseBody = got ? { type: 'text', value: got.slice(0, maxBody), size: got.length, truncated: true } : null;
      emit(rec);
    };
    const count = () => { if (++n >= 20 || sent.length + got.length > maxBody) finish(); };
    const oSend = ws.send;
    ws.send = function (d) { try { if (!done) { sent += line(d); count(); } } catch (e) { /* ignore */ } return oSend.apply(this, arguments); };
    ws.addEventListener('message', (e) => { if (!done) { got += line(e.data); count(); } });
    ws.addEventListener('open', () => { timer = setTimeout(() => finish(), 3000); });
    ws.addEventListener('error', () => finish('连接失败'));
    ws.addEventListener('close', () => finish(n ? '' : '连接已关闭'));
  }

  function tapEventSource(es, url, init) {
    const rec = { id: uid(), via: 'eventsource', ts: Date.now(), pageUrl: location.href, method: 'GET', url, requestHeaders: { accept: 'text/event-stream' }, credentials: init && init.withCredentials ? 'include' : 'same-origin' };
    let text = '';
    let n = 0;
    let done = false;
    let timer = null;
    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      rec.endTs = Date.now();
      if (err && !n) rec.error = err;
      else {
        rec.status = 200;
        rec.statusText = 'OK';
        rec.responseHeaders = { 'content-type': 'text/event-stream' };
        // 推送流没有“完整的返回”：只是开头的几条，标成截断（不能当成可重放的完整返回）
        rec.responseBody = { type: 'text', value: text.slice(0, maxBody), size: text.length, truncated: true };
      }
      emit(rec);
    };
    const push = (type, e) => {
      if (done) return;
      text += `${type === 'message' ? '' : `event: ${type}\n`}data: ${typeof e.data === 'string' ? e.data : ''}\n\n`;
      if (++n >= 20 || text.length > maxBody) finish();
    };
    const add = es.addEventListener;
    const types = new Set(['message', 'open', 'error']);
    add.call(es, 'message', (e) => push('message', e));
    add.call(es, 'open', () => { timer = setTimeout(() => finish(), 3000); });
    add.call(es, 'error', () => finish('连接失败或已断开'));
    // 自定义事件名（event: xxx）只有页面监听了才收得到：页面监听哪个就跟着听哪个
    es.addEventListener = function (type) {
      try { if (typeof type === 'string' && !types.has(type)) { types.add(type); add.call(es, type, (e) => push(type, e)); } } catch (e) { /* ignore */ }
      return add.apply(this, arguments);
    };
  }

  patchNet(window);
  // 空白 iframe 里注入的本脚本找到外层页面的这一套接上（见文件开头）
  try { Object.defineProperty(window, '__PR_HOOK_PATCH__', { value: patchNet }); } catch (e) { /* ignore */ }
})();
