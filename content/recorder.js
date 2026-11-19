// Content script (ISOLATED world)：记录用户操作，转发 hook.js 抓到的请求，显示录制浮层。
(() => {
  if (window.__PAGE_RECORDER_CONTENT__) return;
  window.__PAGE_RECORDER_CONTENT__ = true;
  // iframe（包括跨域的）里也录制操作和接口；页面跳转、地址变化只记顶层的，浮层也只在顶层显示
  const IS_TOP = window.top === window;

  const TAG = '__page_recorder__';
  let recording = false;
  let settings = {};
  let counts = { steps: 0, requests: 0 };
  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  const alive = () => { try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; } };

  function send(msg) {
    if (!alive()) return Promise.resolve(null);
    try { return chrome.runtime.sendMessage(msg).catch(() => null); } catch (e) { return Promise.resolve(null); }
  }

  // ---------------- 元素描述与选择器 ----------------
  const CLICKABLE = 'a,button,input,select,textarea,label,summary,option,[role=button],[role=link],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=tab],[role=option],[role=checkbox],[role=radio],[role=switch],[role=treeitem],[onclick],[contenteditable=""],[contenteditable=true],[tabindex]:not([tabindex="-1"])';
  const STABLE_ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy', 'data-e2e', 'name', 'aria-label', 'placeholder', 'title', 'alt', 'for', 'href', 'value'];

  const textOf = (el) => ((el && (el.innerText || el.textContent)) || '').trim().replace(/\s+/g, ' ');
  const dynamicId = (s) => !s || s.length > 50 || /\d{4,}|[0-9a-f]{8,}|^:|^(ember|react|mui|headlessui|radix|el-id|rc_|rc-|ext-gen|yui|ui-id|j_id|__)/i.test(s);
  const dynamicClass = (s) => !s || s.length > 40 || /^(css|sc|jsx|svelte|emotion|tw|ng)-/i.test(s) || /__[A-Za-z0-9_-]{5,}$/.test(s) || /\d{3,}/.test(s) || /[A-Z0-9]{4,}/.test(s) || /^(active|hover|focus|selected|is-|has-|ng-|v-)/.test(s);
  const cssAttr = (v) => '"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\a ') + '"';

  function unique(sel, el) {
    try { const r = document.querySelectorAll(sel); return r.length === 1 && r[0] === el; } catch (e) { return false; }
  }

  function interactive(el) {
    if (!el || el.nodeType !== 1) return el;
    let cur = el;
    for (let d = 0; cur && cur.nodeType === 1 && d < 6; d++, cur = cur.parentElement) {
      if (cur.matches && cur.matches(CLICKABLE)) return cur;
    }
    try {
      if (getComputedStyle(el).cursor === 'pointer') {
        let top = el;
        for (let d = 0; d < 6 && top.parentElement && top.parentElement !== document.body; d++) {
          if (getComputedStyle(top.parentElement).cursor !== 'pointer') break;
          top = top.parentElement;
        }
        return top;
      }
    } catch (e) { /* ignore */ }
    return el;
  }

  function stableClasses(el) {
    return [...(el.classList || [])].filter((c) => !dynamicClass(c)).slice(0, 3);
  }

  function pathSelector(el) {
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
      if (cur !== el) {
        if (cur.id && !dynamicId(cur.id)) { parts.unshift('#' + CSS.escape(cur.id)); const s = parts.join(' > '); return s; }
        const tid = cur.getAttribute('data-testid');
        if (tid) { parts.unshift(`[data-testid=${cssAttr(tid)}]`); return parts.join(' > '); }
      }
      let seg = cur.tagName.toLowerCase();
      const parent = cur.parentElement;
      if (parent) {
        const sibs = [...parent.children].filter((c) => c.tagName === cur.tagName);
        if (sibs.length > 1) seg += `:nth-of-type(${sibs.indexOf(cur) + 1})`;
      }
      parts.unshift(seg);
      const sel = parts.join(' > ');
      if (unique(sel, el)) return sel;
      cur = parent;
    }
    return parts.join(' > ');
  }

  function buildSelectors(el) {
    const out = [];
    const tag = el.tagName.toLowerCase();
    const push = (s) => { if (s && !out.includes(s) && unique(s, el)) out.push(s); };
    if (el.id && !dynamicId(el.id)) push('#' + CSS.escape(el.id));
    for (const a of STABLE_ATTRS) {
      if (out.length >= 3) break;
      const v = el.getAttribute(a);
      if (v == null || v === '' || v.length > 80) continue;
      if (a === 'value' && !/^(button|submit|reset|radio|checkbox)$/i.test(el.type || '')) continue;
      push(`${tag}[${a}=${cssAttr(v)}]`);
    }
    const name = el.getAttribute('name');
    const type = el.getAttribute('type');
    if (name && type) push(`${tag}[type=${cssAttr(type)}][name=${cssAttr(name)}]`);
    if (name && /^(radio|checkbox)$/i.test(el.type || '') && el.value) push(`${tag}[name=${cssAttr(name)}][value=${cssAttr(el.value)}]`);
    const cls = stableClasses(el);
    if (cls.length) push(tag + cls.map((c) => '.' + CSS.escape(c)).join(''));
    const p = pathSelector(el);
    if (p && !out.includes(p)) out.push(p);
    return out.slice(0, 5);
  }

  function labelOf(el) {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria.trim();
    const lb = el.getAttribute('aria-labelledby');
    if (lb) {
      const t = lb.split(/\s+/).map((id) => textOf(document.getElementById(id))).join(' ').trim();
      if (t) return t;
    }
    if (el.labels && el.labels.length) { const t = textOf(el.labels[0]); if (t) return t; }
    if (el.placeholder) return el.placeholder;
    if (el.tagName === 'INPUT' && /^(submit|button|reset)$/i.test(el.type) && el.value) return el.value;
    if (!/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) { const t = textOf(el); if (t) return t.slice(0, 40); }
    return el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('name') || el.id || '';
  }

  function kindName(el) {
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role');
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (tag === 'a' || role === 'link') return '链接';
    if (tag === 'button' || role === 'button' || (tag === 'input' && /^(submit|button|reset|image)$/.test(type))) return '按钮';
    if ((tag === 'input' && type === 'checkbox') || role === 'checkbox' || role === 'switch') return '复选框';
    if ((tag === 'input' && type === 'radio') || role === 'radio') return '单选框';
    if (tag === 'select' || role === 'combobox' || role === 'listbox') return '下拉框';
    if (tag === 'textarea' || tag === 'input' || el.isContentEditable || role === 'textbox') return '输入框';
    if (role === 'tab') return '标签页';
    if (role === 'menuitem') return '菜单项';
    if (role === 'option' || tag === 'option' || tag === 'li') return '选项';
    if (/^h[1-6]$/.test(tag)) return '标题';
    if (tag === 'img') return '图片';
    if (tag === 'table') return '表格';
    if (tag === 'ul' || tag === 'ol') return '列表';
    return '元素';
  }

  function describe(el) {
    if (!el || el.nodeType !== 1) return null;
    const label = (labelOf(el) || '').slice(0, 60);
    const kind = kindName(el);
    const text = textOf(el).slice(0, 80);
    return {
      selectors: buildSelectors(el),
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || undefined,
      name: el.getAttribute('name') || undefined,
      role: el.getAttribute('role') || undefined,
      kind,
      label,
      text: /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) ? '' : text,
      desc: `${kind}${label ? ` "${label}"` : ''}`,
    };
  }

  // ---------------- 录制 ----------------
  let lastStep = null; // { id, type, el }
  function record(step, el) {
    if (!recording) return null;
    step.kind = 'step';
    step.id = step.id || uid();
    step.ts = step.ts || Date.now();
    step.url = location.href;
    step.title = document.title;
    send({ type: 'event', event: step }).then(updateCounts);
    lastStep = { id: step.id, type: step.type, el };
    return step.id;
  }

  const isOurUI = (e) => !!(uiHost && e.composedPath && e.composedPath().includes(uiHost));
  function isTextField(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.tagName === 'TEXTAREA') return true;
    if (el.tagName === 'INPUT') return !/^(checkbox|radio|submit|button|reset|image|file|hidden)$/i.test(el.type);
    return !!el.isContentEditable;
  }
  const valueOf = (el) => (el.isContentEditable && !('value' in el) ? el.innerText : el.value);
  const isSensitive = (el) => el.type === 'password' || el.autocomplete === 'one-time-code' || el.autocomplete === 'current-password' || el.autocomplete === 'new-password';

  // 输入：合并连续输入，只记录最终值
  let pending = null;
  let pendingTimer = null;
  const lastValue = new WeakMap();
  function flushInput() {
    clearTimeout(pendingTimer);
    if (!pending) return;
    const { el, ts } = pending;
    pending = null;
    if (!el.isConnected || !recording) return;
    const v = valueOf(el);
    if (lastValue.get(el) === v) return;
    lastValue.set(el, v);
    const sensitive = isSensitive(el) && settings.maskPasswords !== false;
    const value = sensitive ? '' : v;
    if (lastStep && lastStep.type === 'fill' && lastStep.el === el) {
      send({ type: 'updateEvent', id: lastStep.id, patch: { value, sensitive } });
      return;
    }
    record({ type: 'fill', ts, target: describe(el), value, sensitive: sensitive || undefined }, el);
  }

  document.addEventListener('input', (e) => {
    if (!recording || !e.isTrusted) return;
    const el = e.target;
    if (!isTextField(el)) return;
    if (pending && pending.el !== el) flushInput();
    if (!pending) pending = { el, ts: Date.now() };
    clearTimeout(pendingTimer);
    pendingTimer = setTimeout(flushInput, 1500);
  }, true);

  document.addEventListener('change', (e) => {
    if (!recording) return;
    const el = e.target;
    if (!el || el.nodeType !== 1) return;
    // 下拉框的 change 有时由自动化工具或组件库以非 trusted 事件派发，仍然记录
    if (!e.isTrusted && el.tagName !== 'SELECT') return;
    if (el.tagName === 'SELECT') {
      flushInput();
      const opts = [...el.selectedOptions];
      record({ type: 'select', target: describe(el), value: el.multiple ? opts.map((o) => o.value) : el.value, optionText: opts.map((o) => o.text.trim()).join(', ') }, el);
      return;
    }
    if (el.tagName === 'INPUT' && /^(checkbox|radio)$/i.test(el.type)) {
      flushInput();
      record({ type: 'check', target: describe(el), checked: el.checked }, el);
      return;
    }
    if (el.tagName === 'INPUT' && el.type === 'file') {
      flushInput();
      record({ type: 'upload', target: describe(el), files: [...el.files].map((f) => f.name) }, el);
      return;
    }
    if (isTextField(el)) {
      if (!pending || pending.el !== el) { flushInput(); pending = { el, ts: Date.now() }; }
      flushInput();
    }
  }, true);

  document.addEventListener('click', (e) => {
    if (!recording || !e.isTrusted || isOurUI(e)) return;
    if (e.altKey && settings.altExtract !== false) {
      e.preventDefault();
      e.stopImmediatePropagation();
      flushInput();
      // Alt+点击 = 提取该元素；Alt+Shift+点击 = 提取它所在的整个表格/列表
      let el = e.target;
      if (e.shiftKey) el = el.closest('table,ul,ol,dl,[role=table],[role=grid],[role=list]') || el;
      const t = describe(el);
      t.text = ''; // 内容会变化，不用文本定位
      const name = (el.getAttribute('aria-label') || el.getAttribute('title') || el.id || el.getAttribute('name') || '').trim().slice(0, 30);
      record({ type: 'extract', target: t, name: name || undefined, sample: textOf(el).slice(0, 200) }, el);
      toast('已标记提取：' + t.desc);
      return;
    }
    flushInput();
    const el = interactive(e.target);
    if (!el || el.nodeType !== 1) return;
    if (el.tagName === 'INPUT' && /^(checkbox|radio|file)$/i.test(el.type)) return; // 由 change 记录
    if (el.tagName === 'LABEL' && el.control && /^(checkbox|radio|file)$/i.test(el.control.type)) return;
    if (el.tagName === 'SELECT' || el.tagName === 'OPTION') return;
    record({ type: 'click', target: describe(el) }, el);
  }, true);

  // Alt 点击时阻止页面的 mousedown 行为
  document.addEventListener('mousedown', (e) => {
    if (recording && e.isTrusted && e.altKey && settings.altExtract !== false && !isOurUI(e)) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }, true);

  document.addEventListener('keydown', (e) => {
    if (!recording || !e.isTrusted || isOurUI(e)) return;
    if (e.key === 'Alt') return;
    if (e.key !== 'Enter' && e.key !== 'Escape') return;
    if (e.isComposing || e.keyCode === 229) return; // 输入法组字中
    flushInput();
    const el = e.target && e.target !== document.body && e.target.nodeType === 1 ? e.target : null;
    record({ type: 'press', key: e.key, target: el ? describe(el) : null, ctrl: e.ctrlKey || undefined, meta: e.metaKey || undefined, shift: e.shiftKey || undefined }, el);
  }, true);

  let scrollTimer = null;
  let lastScroll = { x: 0, y: 0 };
  window.addEventListener('scroll', (e) => {
    if (!recording || settings.recordScroll === false) return;
    if (e.target !== document && e.target !== window) return;
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      const x = Math.round(window.scrollX);
      const y = Math.round(window.scrollY);
      if (Math.abs(y - lastScroll.y) < 200 && Math.abs(x - lastScroll.x) < 200) return;
      lastScroll = { x, y };
      if (lastStep && lastStep.type === 'scroll') send({ type: 'updateEvent', id: lastStep.id, patch: { x, y } });
      else record({ type: 'scroll', x, y }, null);
    }, 600);
  }, { capture: true, passive: true });

  // SPA 路由变化
  let lastHref = location.href;
  if (IS_TOP) {
    setInterval(() => {
      if (location.href === lastHref) return;
      lastHref = location.href;
      if (recording) record({ type: 'url' }, null);
    }, 400);
  }

  window.addEventListener('pagehide', flushInput, true);

  // 转发 hook.js 抓到的请求
  window.addEventListener('message', (e) => {
    const d = e.data;
    // 回放引擎的断点，转给扩展（跨源跳转后以扩展收到的为准）
    if (e.source === window && d && d[TAG] === 'progress' && typeof d.token === 'string') {
      send({ type: 'replayProgress', token: d.token, data: d.data });
      return;
    }
    if (e.source !== window || !d || d[TAG] !== 'net' || !(recording || capturing)) return;
    const r = d.data;
    r.kind = 'request';
    send({ type: 'event', event: r }).then(updateCounts);
  });

  function updateCounts(res) {
    if (res && res.counts) { counts = res.counts; renderUI(); }
  }

  // 抓包模式：扩展回放这个标签页时只转发接口请求和返回，不记录操作、不显示浮层
  let capturing = false;
  const hookState = () => window.postMessage({ [TAG]: 'state', recording: recording || capturing, maxBody: (settings.maxBodyKB || 512) * 1024 }, '*');
  function setCapture(on) { capturing = !!on; hookState(); }
  function setRecording(on, s, c) {
    if (s) settings = s;
    if (c) counts = c;
    if (!on) flushInput();
    recording = !!on;
    lastScroll = { x: Math.round(window.scrollX), y: Math.round(window.scrollY) };
    hookState();
    if (recording) showUI(); else hideUI();
  }

  if (alive()) {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg && msg.type === 'state') { setRecording(msg.recording, msg.settings, msg.counts); sendResponse({ ok: true }); }
      if (msg && msg.type === 'capture') { setCapture(msg.on); sendResponse({ ok: true }); }
      return false;
    });
  }

  function hello() {
    send({ type: 'hello', url: location.href, title: document.title }).then((res) => {
      capturing = !!(res && res.capture);
      setRecording(!!(res && res.recording), res && res.settings, res && res.counts);
    });
  }
  hello();
  window.addEventListener('pageshow', (e) => { if (e.persisted) hello(); });

  // ---------------- 页面浮层 ----------------
  let uiHost = null;
  let uiRoot = null;
  let hl = null;
  function ensureUI() {
    if (uiHost) return;
    uiHost = document.createElement('page-recorder-ui');
    uiHost.style.cssText = 'all:initial;position:fixed;z-index:2147483647;top:0;left:0;width:0;height:0;';
    uiRoot = uiHost.attachShadow({ mode: 'closed' });
    uiRoot.innerHTML = `
      <style>
        .bar{position:fixed;right:16px;bottom:16px;display:flex;align-items:center;gap:10px;padding:8px 10px 8px 12px;
          background:#18181b;color:#fafafa;border-radius:999px;font:12px/1.2 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;
          box-shadow:0 6px 24px rgba(0,0,0,.25);user-select:none;cursor:move}
        .dot{width:9px;height:9px;border-radius:50%;background:#e5484d;animation:p 1.2s infinite}
        @keyframes p{50%{opacity:.35}}
        .n{color:#a1a1aa} .n b{color:#fafafa;font-weight:600}
        button{all:unset;cursor:pointer;background:#e5484d;color:#fff;border-radius:999px;padding:4px 10px;font-weight:600}
        button:hover{background:#dc3e43}
        .tip{color:#71717a}
        .hl{position:fixed;pointer-events:none;border:2px solid #e5484d;background:rgba(229,72,77,.08);border-radius:3px;display:none}
        .toast{position:fixed;right:16px;bottom:64px;background:#18181b;color:#fff;padding:8px 12px;border-radius:8px;
          font:12px -apple-system,"PingFang SC",sans-serif;opacity:0;transition:opacity .2s;max-width:320px}
        ${IS_TOP ? '' : '.bar{display:none}'}
      </style>
      <div class="hl"></div><div class="toast"></div>
      <div class="bar"><span class="dot"></span><span class="n">录制中 · 步骤 <b class="s">0</b> · 接口 <b class="r">0</b></span>
      <span class="tip">Alt+点击 提取数据 · Alt+Shift 提取整表</span><button class="stop">停止</button></div>`;
    hl = uiRoot.querySelector('.hl');
    uiRoot.querySelector('.stop').addEventListener('click', (e) => {
      e.stopPropagation();
      flushInput();
      send({ type: 'stop' });
    });
    // 拖动
    const bar = uiRoot.querySelector('.bar');
    bar.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      const r = bar.getBoundingClientRect();
      const ox = e.clientX - r.left, oy = e.clientY - r.top;
      const mv = (ev) => { bar.style.left = ev.clientX - ox + 'px'; bar.style.top = ev.clientY - oy + 'px'; bar.style.right = 'auto'; bar.style.bottom = 'auto'; };
      const up = () => { removeEventListener('mousemove', mv, true); removeEventListener('mouseup', up, true); };
      addEventListener('mousemove', mv, true);
      addEventListener('mouseup', up, true);
    });
  }
  function showUI() {
    const attach = () => { ensureUI(); if (!uiHost.isConnected) document.documentElement.appendChild(uiHost); renderUI(); };
    if (document.documentElement) attach(); else document.addEventListener('DOMContentLoaded', attach, { once: true });
  }
  function hideUI() { if (uiHost && uiHost.isConnected) uiHost.remove(); }
  function renderUI() {
    if (!uiRoot) return;
    uiRoot.querySelector('.s').textContent = counts.steps;
    uiRoot.querySelector('.r').textContent = counts.requests;
  }
  let toastTimer = null;
  function toast(text) {
    if (!uiRoot) return;
    const t = uiRoot.querySelector('.toast');
    t.textContent = text;
    t.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.style.opacity = '0'; }, 1800);
  }
  document.addEventListener('mousemove', (e) => {
    if (!recording || !hl) return;
    if (e.altKey && !isOurUI(e)) {
      const r = e.target.getBoundingClientRect();
      Object.assign(hl.style, { display: 'block', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
    } else hl.style.display = 'none';
  }, true);
  document.addEventListener('keyup', (e) => { if (e.key === 'Alt' && hl) hl.style.display = 'none'; }, true);
})();
