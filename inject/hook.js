// 运行在页面主环境 (MAIN world)：拦截 fetch / XMLHttpRequest，抓取请求与响应数据，
// 通过 window.postMessage 交给 content script。只有在录制状态下才会读取响应体。
(() => {
  if (window.__PAGE_RECORDER_HOOK__) return;
  try { Object.defineProperty(window, '__PAGE_RECORDER_HOOK__', { value: true }); } catch (e) { return; }

  const TAG = '__page_recorder__';
  let state = null; // null = 尚未得知(先缓冲) | true = 录制中 | false = 未录制
  let buffer = [];
  let maxBody = 512 * 1024;
  const TEXT_CT = /json|text|xml|javascript|ecmascript|x-www-form-urlencoded|graphql|event-stream|csv|yaml/i;
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

  async function serializeBody(body) {
    try {
      if (body == null) return null;
      if (typeof body === 'string') return parseText(body);
      if (body instanceof URLSearchParams) return { type: 'form', value: body.toString() };
      if (typeof FormData !== 'undefined' && body instanceof FormData) {
        const value = [];
        body.forEach((v, k) => value.push([k, typeof v === 'string' ? v : { file: v.name, size: v.size, mime: v.type }]));
        return { type: 'multipart', value };
      }
      if (body instanceof Blob) {
        if (body.size <= maxBody && TEXT_CT.test(body.type || '')) return parseText(await body.text(), body.type);
        return { type: 'blob', size: body.size, mime: body.type };
      }
      if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return { type: 'binary', size: body.byteLength };
      if (typeof Document !== 'undefined' && body instanceof Document) {
        return parseText(new XMLSerializer().serializeToString(body), 'xml');
      }
      if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) return { type: 'stream' };
      return parseText(String(body));
    } catch (e) {
      return { type: 'error', value: String(e) };
    }
  }

  function headersToObj(h) {
    const o = {};
    if (!h) return o;
    try {
      if (typeof Headers !== 'undefined' && h instanceof Headers) h.forEach((v, k) => { o[k] = v; });
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

  // ---------------- fetch ----------------
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      if (!active()) return origFetch.apply(this, arguments);
      const rec = { id: uid(), via: 'fetch', ts: Date.now(), pageUrl: location.href };
      let reqBodyP = null;
      try {
        const req = typeof Request !== 'undefined' && input instanceof Request ? input : null;
        rec.url = new URL(req ? req.url : String(input), location.href).href;
        rec.method = String((init && init.method) || (req && req.method) || 'GET').toUpperCase();
        rec.requestHeaders = Object.assign(headersToObj(req && req.headers), headersToObj(init && init.headers));
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
  const XHR = XMLHttpRequest.prototype;
  const oOpen = XHR.open;
  const oSend = XHR.send;
  const oSet = XHR.setRequestHeader;
  XHR.open = function (method, url) {
    try {
      this.__pr = { method: String(method || 'GET').toUpperCase(), url: new URL(String(url), location.href).href, headers: {} };
    } catch (e) { this.__pr = null; }
    return oOpen.apply(this, arguments);
  };
  XHR.setRequestHeader = function (k, v) {
    try { if (this.__pr) this.__pr.headers[String(k).toLowerCase()] = String(v); } catch (e) { /* ignore */ }
    return oSet.apply(this, arguments);
  };
  XHR.send = function (body) {
    const info = this.__pr;
    if (info && active()) {
      const rec = { id: uid(), via: 'xhr', ts: Date.now(), pageUrl: location.href, method: info.method, url: info.url, requestHeaders: info.headers };
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
})();
