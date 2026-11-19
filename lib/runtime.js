// 导出脚本内嵌的回放引擎。会通过 Function.prototype.toString() 原样写入导出的脚本，
// 因此这个函数必须完全自包含，不能引用外部变量。
async function __pageRecorderRuntime(REC, PARAMS, API_PARAMS, CONFIG) {
  'use strict';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = (...a) => { if (CONFIG.verbose) console.log('%c[回放]', 'color:#e5484d;font-weight:bold', ...a); };
  const warn = (...a) => console.warn('[回放]', ...a);
  const norm = (s) => String(s || '').trim().replace(/\s+/g, ' ');
  const steps = REC.steps;

  // ---------- 参数模板 {{name}} ----------
  function fillTpl(v) {
    if (typeof v !== 'string') return v;
    const whole = v.match(/^\{\{\s*([^}]+?)\s*\}\}$/);
    if (whole && whole[1] in PARAMS) return PARAMS[whole[1]];
    return v.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (s, k) => (k in PARAMS ? String(PARAMS[k]) : s));
  }

  // ---------- 接口匹配与参数改写 ----------
  function matchPath(tpl, path) {
    const A = tpl.split('/');
    const B = path.split('/');
    if (A.length !== B.length) return false;
    return A.every((s, i) => /^\{.+\}$/.test(s) || s === B[i]);
  }
  // 路由参数（如 ?mod=stock.list）也要相同；同一路径有多个接口时取路由参数最多的那个
  function findApi(method, url) {
    let u;
    try { u = new URL(url, location.href); } catch (e) { return -1; }
    let best = -1;
    let bestN = -1;
    for (let i = 0; i < REC.apis.length; i++) {
      const a = REC.apis[i];
      if (a.method !== method || a.host !== u.host || !matchPath(a.pathTemplate, u.pathname)) continue;
      const route = Object.entries(a.route || {});
      if (!route.every(([k, v]) => u.searchParams.getAll(k).join(',') === v)) continue;
      if (route.length > bestN) { best = i; bestN = route.length; }
    }
    return best;
  }
  function pathTokens(p) {
    const out = [];
    String(p).replace(/[^.[\]]+|\[(\d+)\]/g, (m, idx) => { out.push(idx !== undefined ? Number(idx) : m); return m; });
    return out;
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
        const v = fillTpl(c[k]);
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
    const i = findApi(method, url);
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
    const t = await res.text();
    try { return JSON.parse(t); } catch (e) { return t.length > 200000 ? t.slice(0, 200000) : t; }
  }
  function installNet() {
    let net = window.__PR_NET__;
    if (!net) {
      net = { log: [], rewrite: null };
      Object.defineProperty(window, '__PR_NET__', { value: net, configurable: true });
      const push = (e) => { net.log.push(e); if (net.log.length > 1000) net.log.splice(0, 200); };
      const of = window.fetch;
      window.fetch = function (input, init) {
        const entry = { ts: Date.now(), method: 'GET', url: '', api: -1, done: false };
        try {
          const req = typeof Request !== 'undefined' && input instanceof Request ? input : null;
          entry.url = new URL(req ? req.url : String(input), location.href).href;
          entry.method = String((init && init.method) || (req && req.method) || 'GET').toUpperCase();
          // __PR__.api.call 自己发的请求已经按调用参数组装好，不再按 API_PARAMS 改写
          const r = net.rewrite && !(init && init.__prNoRewrite) && net.rewrite(entry.method, entry.url, init ? init.body : undefined);
          if (r) {
            entry.api = r.api;
            if (r.url !== entry.url) { entry.url = r.url; input = req ? new Request(r.url, req) : r.url; }
            if (init && r.body !== init.body) init = Object.assign({}, init, { body: r.body });
          }
        } catch (e) { /* ignore */ }
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
        const entry = { method: String(method || 'GET').toUpperCase(), url: String(url), api: -1, done: false };
        try {
          entry.url = new URL(String(url), location.href).href;
          const r = net.rewrite && net.rewrite(entry.method, entry.url, undefined);
          if (r) { entry.api = r.api; entry.url = r.url; }
        } catch (e) { /* ignore */ }
        this.__prn = entry;
        return oo.call(this, method, entry.url, ...rest);
      };
      XP.send = function (body) {
        const entry = this.__prn;
        if (entry) {
          entry.ts = Date.now();
          try {
            const r = net.rewrite && net.rewrite(entry.method, entry.url, body);
            if (r && r.body !== body) body = r.body;
          } catch (e) { /* ignore */ }
          push(entry);
          this.addEventListener('loadend', () => {
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
    return net;
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
      const hits = net.log.filter((x) => x.done && !x.claimed && x.ts >= from && x.method === a.method && (x.api === i || findApi(x.method, x.url) === i));
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
  function qsa(sel) { try { return [...document.querySelectorAll(sel)]; } catch (e) { return []; } }
  const textOf = (el) => norm(el.innerText || el.textContent).slice(0, 80);
  function locate(t, allowHidden) {
    let multi = null;
    let hidden = null;
    for (const sel of t.selectors || []) {
      const all = qsa(sel);
      const vis = all.filter(visible);
      if (vis.length === 1) return vis[0];
      if (vis.length > 1) {
        if (t.text) { const m = vis.find((e) => textOf(e) === t.text); if (m) return m; }
        multi = multi || vis[0];
      } else if (all.length === 1 && !hidden) hidden = all[0];
    }
    if (t.text) {
      const pool = qsa(t.tag || '*').filter(visible);
      const m = pool.find((e) => textOf(e) === t.text);
      if (m) return m;
    }
    if (multi) return multi;
    if (allowHidden && hidden) return hidden;
    return null;
  }
  // 可选步骤：只认可见、并且标签和文字都和录制时一致的元素
  // （避免“登录”没了却点到同一位置的“退出登录”，或者填到隐藏的登录框里）
  // 输入框没有文字，就看 type / name（录制时有的话）；都没有就只能信选择器
  const sameIdentity = (el, t) => (!t.tag || el.tagName.toLowerCase() === t.tag)
    && (!t.text || textOf(el) === t.text)
    && (!t.type || (el.getAttribute('type') || '').toLowerCase() === String(t.type).toLowerCase())
    && (!t.name || el.getAttribute('name') === t.name);
  function locateStrict(t) {
    for (const sel of t.selectors || []) {
      const m = qsa(sel).filter(visible).find((e) => sameIdentity(e, t));
      if (m) return m;
    }
    if (t.text) return qsa(t.tag || '*').filter(visible).find((e) => textOf(e) === t.text) || null;
    return null;
  }
  // 取消（扩展在超时等情况下调用 __PR__.cancel()）：正在等待的查找和后续步骤都会停下
  let cancelled = false;
  const checkCancel = () => { if (cancelled) throw new Error('回放已取消'); };
  let optionalFind = null;
  async function find(t, allowHidden) {
    if (!t) throw new Error('步骤缺少目标元素');
    const end = Date.now() + (optionalFind != null ? optionalFind : CONFIG.findTimeout);
    for (;;) {
      checkCancel();
      const el = optionalFind != null ? locateStrict(t) : locate(t, allowHidden);
      if (el) return el;
      if (Date.now() > end) throw new Error(`找不到元素 ${t.desc || ''}（选择器：${(t.selectors || []).join(' | ')}）`);
      await sleep(150);
    }
  }
  // 点击目标：优先等可见元素。如果只找到隐藏的（比如鼠标悬停才展开的下拉菜单），
  // 先模拟悬停把菜单展开；还是看不见就返回 { hidden } 让调用方直接触发点击。
  // 可选步骤不走这条路：隐藏的元素算作“没有”
  function hover(el) {
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
  async function findClickable(t) {
    if (!t) throw new Error('步骤缺少目标元素');
    if (optionalFind != null) return find(t, false);
    const start = Date.now();
    const end = start + CONFIG.findTimeout;
    let hovered = false;
    for (;;) {
      checkCancel();
      const el = locate(t, false);
      if (el) return el;
      const hidden = Date.now() - start > 800 ? locate(t, true) : null;
      if (hidden) {
        if (!hovered) {
          hovered = true;
          hover(hidden);
          await sleep(300);
          if (visible(hidden)) return hidden;
        }
        return { hidden };
      }
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
    const r = el.getBoundingClientRect();
    Object.assign(hlBox.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px', display: 'block' });
    document.documentElement.appendChild(hlBox);
    clearTimeout(highlight.t);
    highlight.t = setTimeout(() => { hlBox.style.display = 'none'; }, 600);
  }

  // ---------- 操作 ----------
  async function doClick(el) {
    el.scrollIntoView({ block: 'center', inline: 'center' });
    await sleep(60);
    highlight(el);
    const r = el.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, composed: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
    const po = Object.assign({ pointerId: 1, pointerType: 'mouse', isPrimary: true }, o);
    el.dispatchEvent(new PointerEvent('pointerover', po));
    el.dispatchEvent(new MouseEvent('mouseover', o));
    el.dispatchEvent(new PointerEvent('pointerdown', po));
    el.dispatchEvent(new MouseEvent('mousedown', Object.assign({ buttons: 1 }, o)));
    if (typeof el.focus === 'function') el.focus({ preventScroll: true });
    el.dispatchEvent(new PointerEvent('pointerup', po));
    el.dispatchEvent(new MouseEvent('mouseup', o));
    if (typeof el.click === 'function') el.click();
    else el.dispatchEvent(new MouseEvent('click', o));
  }
  function setNativeValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value); else el.value = value;
  }
  async function doFill(el, value) {
    value = value == null ? '' : String(value);
    el.scrollIntoView({ block: 'center' });
    highlight(el);
    el.focus();
    if (el.isContentEditable && !('value' in el)) {
      const sel = window.getSelection();
      sel.selectAllChildren(el);
      if (!document.execCommand('insertText', false, value)) {
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
  const KEY_CODES = { Enter: 13, Escape: 27, Tab: 9, Backspace: 8, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, ' ': 32 };
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
  async function doSelect(el, value) {
    highlight(el);
    el.focus();
    if (el.multiple && Array.isArray(value)) [...el.options].forEach((o) => { o.selected = value.includes(o.value); });
    else setNativeValue(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  async function doCheck(el, checked) {
    if (el.checked === checked) return;
    if (visible(el)) await doClick(el); else el.click();
    if (el.checked !== checked) {
      el.checked = checked;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }
  async function doPress(el, s) {
    el = el || document.activeElement || document.body;
    highlight(el);
    const o = { code: s.key, ctrlKey: !!s.ctrl, metaKey: !!s.meta, shiftKey: !!s.shift };
    const down = el.dispatchEvent(keyEvent('keydown', s.key, o));
    if (s.key === 'Enter') el.dispatchEvent(keyEvent('keypress', s.key, o));
    el.dispatchEvent(keyEvent('keyup', s.key, o));
    // 模拟浏览器的“回车提交表单”
    if (down && s.key === 'Enter' && el.tagName === 'INPUT' && el.form && !s.ctrl && !s.meta) {
      if (el.form.requestSubmit) el.form.requestSubmit(); else el.form.submit();
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
      case 'click': {
        const el = await act(findClickable(t));
        if (!el.hidden) return doClick(el);
        warn(`第 ${i + 1} 步的元素是隐藏的（可能在悬停才展开的菜单里），直接触发点击：${t.desc || ''}`);
        return el.hidden.click();
      }
      case 'fill': return doFill(await act(find(t, true)), fillTpl(s.value));
      case 'select': return doSelect(await act(find(t, true)), Array.isArray(s.value) ? s.value.map(fillTpl) : fillTpl(s.value));
      case 'check': return doCheck(await act(find(t, true)), s.checked);
      case 'press': return doPress(t ? await act(find(t, true)) : (mark(i + 1), null), s);
      case 'scroll':
        window.scrollTo({ left: s.x, top: s.y, behavior: 'instant' });
        await sleep(300);
        return;
      case 'extract': {
        const el = await find(t, true);
        highlight(el);
        result.extracted[s.name || `步骤${i + 1}`] = extractOf(el);
        return;
      }
      case 'upload':
        warn(`第 ${i + 1} 步需要上传文件（${(s.files || []).join(', ')}），脚本无法自动完成，已跳过`);
        return;
      default:
        warn('未知步骤类型', s.type);
    }
  }

  async function replay(opts) {
    opts = opts || {};
    installNet();
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
        await runStep(s, i, result, mark);
        optionalFind = null;
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
    // 扩展分段执行时，跑完就撤掉请求改写，免得用户之后在这个页面里的正常操作被改写
    if (seg && window.__PR_NET__ && window.__PR_NET__.rewrite === rewrite) window.__PR_NET__.rewrite = null;
    result.skip = skipping;
    if (result.ok) log('回放完成', result);
    return result;
  }

  // ---------- 直接调用接口（自动携带当前页面的登录态 Cookie） ----------
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
    const out = { path: {}, query: {}, body: {} };
    for (const [k, v] of Object.entries(args)) {
      const t = (a.toolArgs || []).find((x) => x.arg === k || x.key === k);
      if (t) out[t.sec][t.key] = v;
      else if (/^(GET|HEAD|DELETE)$/.test(a.method)) out.query[k] = v;
      else out.body[k] = v;
    }
    return out;
  }
  function flattenInput(v, prefix, out) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const k of Object.keys(v)) flattenInput(v[k], prefix ? `${prefix}.${k}` : k, out);
    } else out[prefix] = v;
    return out;
  }
  async function call(name, opts) {
    const a = apiByName(name);
    if (!a) throw new Error('未找到接口：' + name + '。可用接口：' + REC.apis.map((x) => `${x.fn} (${x.name})`).join(', '));
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
    for (const [k, v0] of Object.entries(query)) {
      const v = fillTpl(v0);
      if (v == null) continue;
      if (Array.isArray(v)) v.forEach((x) => u.searchParams.append(k, String(x)));
      else u.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
    const headers = {};
    for (const [k, v] of Object.entries(a.requestHeaders || {})) if (v !== '***' && !/\{\{/.test(v)) headers[k] = v;
    Object.assign(headers, opts.headers || {});
    let body;
    if (!/^(GET|HEAD)$/.test(a.method)) {
      if (opts.rawBody !== undefined) body = opts.rawBody;
      else {
        const leaves = Object.assign({}, P.body, opts.body ? flattenInput(opts.body, '', {}) : {});
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
    const signal = CONFIG.callTimeout && typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(CONFIG.callTimeout) : undefined;
    const res = await fetch(u.href, { method: a.method, headers, body, credentials: 'include', signal, __prNoRewrite: true });
    const ct = res.headers.get('content-type') || '';
    const text = await res.text();
    let data = text;
    if (/json/i.test(ct) || /^\s*[[{]/.test(text)) { try { data = JSON.parse(text); } catch (e) { /* keep text */ } }
    return { ok: res.ok, status: res.status, url: u.href, data };
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
