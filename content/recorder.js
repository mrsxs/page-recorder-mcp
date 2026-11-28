// Content script (ISOLATED world)：记录用户操作，转发 hook.js 抓到的请求，显示录制浮层。
(() => {
  // 扩展更新后，打开着的页面里旧脚本已失效：版本不同就由新的接管（重新注入时）
  const BUILD = (() => { try { return chrome.runtime.getManifest().version; } catch (e) { return 'unknown'; } })();
  if (window.__PAGE_RECORDER_CONTENT__ === BUILD) return;
  // 同源的 about:blank / srcdoc iframe（富文本编辑器等）由外层页面的 blankFrameDocs 统一录制（带 frameChain）；
  // 沙箱或跨域的 about:blank iframe 访问不了外层，继续往下走以便和 hook.js 配对
  try {
    if (/^about:/.test(location.href) && window.parent !== window) {
      let w = window.parent;
      while (/^about:/.test(w.location.href) && w.parent !== w) w = w.parent;
      if (/^(https?|file|blob):/i.test(w.location.href)) return;
    }
  } catch (e) { /* 沙箱/跨域 iframe 按独立页面处理 */ }
  window.__PAGE_RECORDER_CONTENT__ = BUILD;
  // iframe（包括跨域的）里也录制操作和接口；页面跳转、地址变化只记顶层的，浮层也只在顶层显示
  const IS_TOP = window.top === window;

  const TAG = '__page_recorder__';
  let recording = false;
  let settings = {};
  let counts = { steps: 0, requests: 0 };
  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  const alive = () => { try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; } };

  let lastSent = Promise.resolve(null); // 最近发给后台的那条消息（停止录制前要等它送到）
  function send(msg) {
    if (!alive()) return Promise.resolve(null);
    try {
      const p = chrome.runtime.sendMessage(msg).catch(() => null);
      // 只记录制内容（步骤、步骤的补充、密码）；stop 的应答要等后台停完才回来，等它就成了和后台互相等
      if (msg.type === 'event' || msg.type === 'updateEvent' || msg.type === 'secret') lastSent = p;
      return p;
    } catch (e) { return Promise.resolve(null); }
  }

  // ---------------- 元素描述与选择器 ----------------
  const CLICKABLE = 'a,button,input,select,textarea,label,summary,option,[role=button],[role=link],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=tab],[role=option],[role=checkbox],[role=radio],[role=switch],[role=treeitem],[onclick],[contenteditable=""],[contenteditable=true],[tabindex]:not([tabindex="-1"])';
  const STABLE_ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy', 'data-e2e', 'name', 'aria-label', 'placeholder', 'title', 'alt', 'for', 'href', 'value'];

  const norm = (s) => String(s || '').trim().replace(/\s+/g, ' ');
  const textOf = (el) => norm(el && (el.innerText || el.textContent));
  const dynamicId = (s) => !s || s.length > 50 || /\d{4,}|[0-9a-f]{8,}|^:|^(ember|react|mui|headlessui|radix|el-id|rc_|rc-|ext-gen|yui|ui-id|j_id|__)/i.test(s);
  // 构建工具生成的哈希类名（CSS-in-JS、CSS Modules）每次发版都会变，不能当选择器
  const UI_PREFIX = /^(soui|so|ant|el|ivu|layui|mui|arco|t|n|van|semi|next|ui|chakra|v)-/i;
  function hashedClass(s, all) {
    if (!/^[a-z]{1,2}-?[a-z0-9]{5,8}$/.test(s)) return false;
    if (/\d/.test(s)) return true; // c229po6、c-99sfs3
    return !!(all && all.some((c) => UI_PREFIX.test(c))); // 和组件库类名一起出现的短类名（cqvauqu）
  }
  const dynamicClass = (s, all) => !s || s.length > 40 || /^(css|sc|jsx|svelte|emotion|tw|ng)-/i.test(s) || /__[A-Za-z0-9_-]{5,}$/.test(s)
    || /--[A-Za-z0-9_]{5,}$/.test(s) || /\d{3,}/.test(s) || /[A-Z0-9]{4,}/.test(s) || /^(active|hover|focus|selected|is-|has-|ng-|v-)/.test(s) || hashedClass(s, all);
  const cssAttr = (v) => '"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\a ').replace(/\r/g, '\\d ').replace(/\f/g, '\\c ') + '"';
  const rootOf = (el) => (el.getRootNode ? el.getRootNode() : document);

  function unique(sel, el) {
    try { const r = rootOf(el).querySelectorAll(sel); return r.length === 1 && r[0] === el; } catch (e) { return false; }
  }
  // 事件的真正目标：Shadow DOM 里的元素在 document 上会被换成宿主，用 composedPath 取回
  const deepTarget = (e) => { const p = e.composedPath ? e.composedPath() : []; return (p[0] && p[0].nodeType === 1 ? p[0] : e.target); };
  function deepActive() {
    let a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return a;
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
    const all = [...(el.classList || [])];
    return all.filter((c) => !dynamicClass(c, all)).slice(0, 3);
  }

  function pathSelector(el) {
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
      if (cur !== el) {
        if (cur.id && !dynamicId(cur.id)) {
          const s = ['#' + CSS.escape(cur.id), ...parts].join(' > ');
          if (unique(s, el)) return s;
        }
        const tid = cur.getAttribute('data-testid');
        if (tid) {
          const s = [`[data-testid=${cssAttr(tid)}]`, ...parts].join(' > ');
          if (unique(s, el)) return s;
        }
      }
      let seg = cur.tagName.toLowerCase();
      const parent = cur.parentNode;
      if (parent && parent.children) {
        const sibs = [...parent.children].filter((c) => c.tagName === cur.tagName);
        if (sibs.length > 1) seg += `:nth-of-type(${sibs.indexOf(cur) + 1})`;
      }
      parts.unshift(seg);
      const sel = parts.join(' > ');
      if (unique(sel, el)) return sel;
      cur = parent && parent.nodeType === 1 ? parent : null;
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

  // 组件库给输入框默认加的 aria-label（Fusion 下拉的 "select"）不是它的名字：有 <label for>、占位文字就用那些
  const GENERIC_LABEL = /^(select|input|search|text|textbox|combobox|dropdown|listbox|choose|please select|请选择|请输入|选择|搜索)$/i;
  function labelOf(el) {
    const aria = (el.getAttribute('aria-label') || '').trim();
    const generic = !!aria && GENERIC_LABEL.test(aria);
    if (aria && !generic) return aria;
    const lb = el.getAttribute('aria-labelledby');
    if (lb) {
      const t = lb.split(/\s+/).map((id) => textOf(rootOf(el).getElementById ? rootOf(el).getElementById(id) : document.getElementById(id))).join(' ').trim();
      if (t) return t;
    }
    if (el.labels && el.labels.length) { const t = textOf(el.labels[0]); if (t) return t; }
    if (el.placeholder) return el.placeholder;
    const ph = el.getAttribute('data-placeholder') || el.getAttribute('aria-placeholder');
    if (ph) return ph;
    if (el.tagName === 'INPUT' && /^(submit|button|reset)$/i.test(el.type) && el.value) return el.value;
    // 可编辑区域（富文本编辑器）的文字是用户输入的内容，不能当它的名字
    if (!/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && !el.isContentEditable) { const t = textOf(el); if (t) return t.slice(0, 40); }
    return el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('name') || (dynamicId(el.id) ? '' : el.id) || (generic ? aria : '') || '';
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
    if (tag === 'canvas') return '画布';
    if (tag === 'table') return '表格';
    if (tag === 'ul' || tag === 'ol') return '列表';
    return '元素';
  }

  // ---------- 元素所在的上下文（和回放引擎 lib/runtime.js 的算法一致） ----------
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
  // Shadow DOM 宿主链：从最外层到最里层，每层宿主的选择器
  function hostChain(el) {
    const hosts = [];
    for (let r = rootOf(el); r && r.host; r = rootOf(r.host)) hosts.unshift(buildSelectors(r.host));
    return hosts.length ? hosts : undefined;
  }

  // 表格行、列表行里的元素（每行都有的“编辑”“删除”）：记下这一行前几格的文字，回放时先按行找，免得点到别的记录上
  function rowOf(el) {
    const row = el.closest && el.closest('tr,[role=row]');
    if (!row || !row.parentElement) return undefined;
    const sibs = [...row.parentElement.children].filter((r) => r.tagName === row.tagName);
    if (sibs.length < 2) return undefined;
    const cells = [...row.children].filter((c) => !c.contains(el)).map((c) => textOf(c)).filter((t) => t && t.length <= 40).slice(0, 3);
    return cells.length ? cells : undefined;
  }
  // 同源的 about:blank / srcdoc iframe（富文本编辑器）里的元素：由外层页面录，记下从外层到它的 iframe 选择器链
  function frameChain(el) {
    const chain = [];
    for (let doc = el.ownerDocument; doc && doc !== document; ) {
      const f = doc.defaultView && doc.defaultView.frameElement;
      if (!f) break;
      chain.unshift(buildSelectors(f));
      doc = f.ownerDocument;
    }
    return chain.length ? chain : undefined;
  }
  function describe(el) {
    if (!el || el.nodeType !== 1) return null;
    // iframe 编辑器的正文（designMode 的 body）：名字、表单标签取外层 iframe 的（“商品描述”）
    const doc = el.ownerDocument;
    const host = doc !== document && el === doc.body && doc.defaultView && doc.defaultView.frameElement;
    const label = ((host ? labelOf(host) : labelOf(el)) || '').slice(0, 60);
    const kind = kindName(el);
    const text = textOf(el).slice(0, 80);
    const box = boxOf(host || el);
    const ctx = {};
    const fl = fieldLabelOf(host || el);
    if (fl) ctx.label = fl;
    if (box) ctx.box = { title: boxTitle(box) || undefined };
    const row = rowOf(el);
    if (row) ctx.row = row;
    return {
      selectors: buildSelectors(el),
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || undefined,
      name: el.getAttribute('name') || undefined,
      role: el.getAttribute('role') || undefined,
      kind,
      label: label || fl || '',
      // 输入框、可编辑区域的文字是用户填的内容，会变，不用来定位
      text: /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable ? '' : text,
      desc: `${kind}${label || fl ? ` "${label || fl}"` : ''}`,
      ctx,
      shadow: hostChain(el),
      frames: frameChain(el),
    };
  }
  // 点击位置在元素里的相对坐标：画布、图片、SVG 这类点哪里有区别的元素才记
  function posIn(el, e) {
    if (!el || !/^(CANVAS|IMG|AREA|VIDEO|svg)$/i.test(el.tagName)) return undefined;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return undefined;
    return [Math.round((e.clientX - r.left) / r.width * 1000) / 1000, Math.round((e.clientY - r.top) / r.height * 1000) / 1000];
  }

  // ---------------- 录制 ----------------
  let lastStep = null; // { id, type, el, dialogs }
  const recentSteps = []; // 本框架最近录下的步骤（双击归组用）
  function record(step, el) {
    if (!recording) return null;
    if (session && !step.members && !(el && (session.fields.has(el) || inSessionUI(el)))) endSession();
    step.kind = 'step';
    step.id = step.id || uid();
    step.ts = step.ts || Date.now();
    step.url = location.href;
    step.title = document.title;
    send({ type: 'event', event: step }).then(updateCounts);
    lastStep = { id: step.id, type: step.type, el, dialogs: [], ts: Date.now() };
    // ov：点的时候在不在浮层里（日历、下拉面板选完就关掉了，之后再看就不知道了）
    recentSteps.push({ id: step.id, type: step.type, el, ts: Date.now(), ov: !!(el && step.type === 'click' && inOverlay(el)) });
    if (recentSteps.length > 30) recentSteps.shift();
    // 选择器会话中：在控件和它的面板里的操作归入会话；操作了别的东西（另一个输入框、下拉框、页面跳转）就先结束会话
    if (session && !step.members) {
      if (el && (session.fields.has(el) || inSessionUI(el))) {
        session.steps.push(step.id);
        if (!session.fields.has(el) && !session.widget.contains(el)) session.inPanel.add(step.id);
      } else endSession();
    }
    return step.id;
  }

  // 录制用的监听：挂在本页面的 document 上；同源的 about:blank / srcdoc iframe（UEditor、KindEditor、TinyMCE、
  // CKEditor 4 这类 iframe 编辑器）没有自己的 content script，也挂一份，由本页面录（目标带 iframe 选择器链）
  const HANDLERS = [];
  function listen(type, fn, opts) { HANDLERS.push([type, fn, opts]); document.addEventListener(type, fn, opts); }
  const PING = '__page_recorder_ping__';
  let pinged = false;
  const onPing = () => { pinged = true; };
  function ensureDoc(doc) {
    // 编辑器常用 document.open() 重写 iframe，会清掉挂好的监听：先探一下还在不在
    pinged = false;
    try { doc.dispatchEvent(new Event(PING)); } catch (e) { return; }
    if (pinged) return;
    try {
      for (const [type, fn, opts] of HANDLERS) doc.addEventListener(type, fn, opts);
      doc.addEventListener(PING, onPing);
    } catch (e) { /* ignore */ }
  }
  function blankFrameDocs(doc, depth, out) {
    out = out || [];
    if (depth > 3) return out;
    for (const f of doc.querySelectorAll('iframe,frame')) {
      // 没有自己地址的框架（不写 src、about:blank、srcdoc；编辑器 document.open() 写过之后地址会变成外层页面的）、
      // 里面也没有本扩展的 content script（有的话它自己会录）
      const src = (f.getAttribute('src') || '').trim();
      if (src && !/^(about:|javascript:)/i.test(src) && !f.hasAttribute('srcdoc')) continue;
      let d = null;
      try { if (f.contentWindow && !f.contentWindow.__PAGE_RECORDER_CONTENT__) d = f.contentDocument; } catch (e) { d = null; }
      if (d && d.documentElement) { out.push(d); blankFrameDocs(d, depth + 1, out); }
    }
    return out;
  }
  setInterval(() => { if (recording) for (const d of blankFrameDocs(document, 0)) ensureDoc(d); }, 700);

  const isOurUI = (e) => !!(uiHost && e.composedPath && e.composedPath().includes(uiHost));
  function isTextField(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.tagName === 'TEXTAREA') return true;
    if (el.tagName === 'INPUT') return !/^(checkbox|radio|submit|button|reset|image|file|hidden)$/i.test(el.type);
    return !!el.isContentEditable;
  }
  const valueOf = (el) => (el.isContentEditable && !('value' in el) ? el.innerText : el.value);
  // 见过一次是密码框就一直按密码处理（点“显示密码”小眼睛后 type 变成 text，内容还是密码）
  const everSensitive = new WeakSet();
  // 还没键入就先点了“显示密码”的：键入时 type 已经是 text 了。所以每次扫描字段、聚焦时看到是密码框就先记下
  const notePassword = (el) => { if (el && el.type === 'password') everSensitive.add(el); };
  // 名字、id 里带 password / pwd 的（loginPwd、user_password、confirmPassword）也算；
  // otp、cvv、secret 这类短词要单独成词（option、secretary 不算），pin 只认整个名字就是它（pin_code 是邮编）；
  // pass 只认名字的最后一个词（后面只能跟数字、符号：pass1、pass_1、pass[0]、user[pass]），前面也不能是 is / no / not / un / has
  // ——passReason、pass_rate、isPass、noPassReason、passport 是审核、证件字段，不是密码
  const SECRET_WORD = /pass[_-]?(?:word|wd|code|phrase)|pwd|(?:^|[^a-z])(?:otp|cvv|cvc|secret)(?:$|[^a-z])|(?<!(?:^|[^a-z])(?:is|no|not|un|has))(?:^|[^a-z])pass[^a-z]*$|^pin$|verif(?:y|ication)[_-]?code/;
  const nameWords = (s) => String(s || '').replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2').toLowerCase();
  const isSensitive = (el) => {
    if (everSensitive.has(el)) return true;
    // 按名字认只对能键入的框：name 是 remember_password 的复选框不是密码
    const hit = el.type === 'password' || (isTextField(el) && (/(?:^|\s)(one-time-code|current-password|new-password)(?:$|\s)/i.test(el.autocomplete || '')
      || SECRET_WORD.test(nameWords(el.name)) || SECRET_WORD.test(nameWords(el.id))));
    if (hit) everSensitive.add(el);
    return hit;
  };
  const visibleEl = (el) => !!(el && el.isConnected && (el.checkVisibility ? el.checkVisibility({ visibilityProperty: true }) : el.getClientRects().length));
  function selectData(el) {
    const opts = [...el.selectedOptions];
    return {
      value: el.multiple ? opts.map((o) => o.value) : el.value,
      optionText: opts.map((o) => norm(o.text)).join(', '),
      // 选项表只存前 200 个，但选中的一定要在里面（不然在弹窗里改参数时会把它丢掉）
      options: [...el.options].filter((o, i) => i < 200 || o.selected).map((o) => [o.value, norm(o.text)]),
    };
  }

  // 输入：合并连续输入，只记录最终值
  let pending = null;
  let pendingTimer = null;
  let lastValue = new WeakMap();
  let fillOf = new WeakMap(); // 输入框 → 键入它的那一步（之后页面格式化了值，就改这一步的值）
  function flushInput() {
    clearTimeout(pendingTimer);
    if (!pending) return;
    const { el, ts } = pending;
    pending.last = pending.last || Date.now();
    const p0 = pending;
    pending = null;
    if (!el.isConnected || !recording) return;
    remember(el);
    const v = valueOf(el);
    if (lastValue.get(el) === v) return;
    lastValue.set(el, v);
    const sensitive = isSensitive(el) && settings.maskPasswords !== false;
    const value = sensitive ? '' : v;
    const commitTs = p0.last;
    // 密码明文只交给扩展后台的内存：之后请求里出现同一个值就换成占位符（关联到密码参数），不进存储、不进导出
    const reuse = lastStep && lastStep.type === 'fill' && lastStep.el === el;
    const sid = reuse ? lastStep.id : p0.id || uid();
    if (sensitive && v && p0.sent !== v) send({ type: 'secret', id: sid, value: v });
    if (reuse) {
      send({ type: 'updateEvent', id: lastStep.id, patch: Object.assign({ value, sensitive, secretInput: isSensitive(el) || undefined, commitTs }, sensitive ? { secretId: sid } : {}) });
      fillOf.set(el, { id: lastStep.id, ts: Date.now(), value: v });
      return;
    }
    // secretInput：关了脱敏时值照常留在录制里，但写长期备份时要认得出这是密码框
    const id = record({ id: sid, type: 'fill', ts, commitTs, target: describe(el), value, sensitive: sensitive || undefined, secretInput: isSensitive(el) || undefined, secretId: sensitive ? sid : undefined }, el);
    if (id) fillOf.set(el, { id, ts: Date.now(), value: v });
  }
  // 键入之后页面把值格式化了（1000 → 1,000.00）：几秒内、内容基本没变的，并回键入那一步；
  // 之后的清空、重置等变化不改历史输入
  // 格式等价：去掉空白和千分位后数值相等（1000 ↔ 1,000.00），或者去掉分隔符后完全一样（20261104 ↔ 2026-11-04）、只差大小写
  function sameFormatted(a, b) {
    const num = (v) => { const t = String(v).trim().replace(/[\s,，]/g, ''); return /^[-+]?\d+(\.\d+)?$/.test(t) ? Number(t) : NaN; };
    const x = num(a);
    const y = num(b);
    if (!Number.isNaN(x) || !Number.isNaN(y)) return x === y; // 数值就按数值比（12.34 和 1234、-100 和 100 不是同一个值）
    const sq = (v) => norm(v).toLowerCase().replace(/[\s,，.。:：\-_/]/g, '');
    return !!sq(a) && sq(a) === sq(b);
  }
  function formattedFill(el) {
    const f = fillOf.get(el);
    if (!f || Date.now() - f.ts > 4000) return null;
    return sameFormatted(f.value, valueOf(el)) ? f.id : null;
  }

  function onInput(e) {
    if (!recording || !e.isTrusted) return;
    const el = deepTarget(e);
    if (!isTextField(el)) return;
    noteRoot(el);
    const sensitive = isSensitive(el) && settings.maskPasswords !== false;
    if (pending && pending.el !== el) flushInput();
    if (!pending) pending = { el, ts: Date.now() };
    if (sensitive) {
      pending.id ||= lastStep?.type === 'fill' && lastStep.el === el ? lastStep.id : uid();
      const value = valueOf(el);
      if (value && pending.sent !== value) {
        pending.sent = value;
        send({ type: 'secret', id: pending.id, value });
      }
    }
    pending.last = Date.now();
    clearTimeout(pendingTimer);
    pendingTimer = setTimeout(flushInput, 1500);
  }
  listen('input', onInput, true);
  // 这一轮键入开始前，框里已经不是上次录的值了（聊天框、扫码框回车后被页面清空；可编辑区域不在字段扫描里，只能在这里看）：
  // 上次录的值跟着改，不然再键入同样的内容会被当成“没变”漏掉
  listen('beforeinput', (e) => {
    if (!recording || !e.isTrusted) return;
    const el = deepTarget(e);
    if (!isTextField(el) || (pending && pending.el === el) || !lastValue.has(el)) return;
    const v = valueOf(el);
    if (lastValue.get(el) !== v) lastValue.set(el, v);
  }, true);

  function onChange(e) {
    if (!recording) return;
    const el = deepTarget(e);
    if (!el || el.nodeType !== 1) return;
    // 下拉框的 change 有时由自动化工具或组件库以非 trusted 事件派发，仍然记录
    if (!e.isTrusted && el.tagName !== 'SELECT') return;
    if (el.tagName === 'SELECT') {
      flushInput();
      if (known.get(el) === fieldKey(el) && !e.isTrusted) return; // 程序改值已经按字段变化录过了
      // 藏起来的原生下拉框被组件改值后派发的 change：走字段变化的归组（挂到组件界面的语义步骤上），不单独录一步
      // 等组件这一轮同步更新完（有的先改隐藏下拉框、派发 change，再改显示框）再一起扫
      if (!e.isTrusted && !visibleEl(el)) { setTimeout(scan, 0); return; }
      remember(el);
      record(Object.assign({ type: 'select', target: describe(el) }, selectData(el)), el);
      return;
    }
    if (el.tagName === 'INPUT' && /^(checkbox|radio)$/i.test(el.type)) {
      flushInput();
      remember(el);
      if (el.type === 'radio') for (const r of allFields()) if (r.type === 'radio' && r.name === el.name) remember(r); // 同组被联动取消的不单独录
      if (el.type === 'radio') {
        // 单选：记下同组的所有选项（值、显示文字），回放时可以换成组里别的选项
        const text = (r) => norm([...(r.labels || [])].map((l) => l.textContent).join(' ')) || r.value;
        const group = el.name ? allFields().filter((r) => r.type === 'radio' && r.name === el.name && r.form === el.form) : [el];
        // 组名：包住整组的元素去掉各个选项后剩下的文字（“水果：”），没有就用 name
        let box = el.parentElement;
        while (box && !group.every((r) => box.contains(r))) box = box.parentElement;
        let groupLabel = '';
        if (box) { const c = box.cloneNode(true); c.querySelectorAll('label,input').forEach((x) => x.remove()); groupLabel = norm(c.textContent).replace(/[:：]\s*$/, '').slice(0, 20); }
        record({ type: 'check', target: describe(el), checked: el.checked, value: el.value, optionText: text(el), options: group.slice(0, 200).map((r) => [r.value, text(r)]), optionIndex: group.indexOf(el), groupLabel: groupLabel || el.name || '' }, el);
        return;
      }
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
  }
  listen('change', onChange, true);

  // ---------------- 动作的效果：字段值变化 ----------------
  // 日期框、下拉组件、自动完成常用脚本直接改输入框的值，没有键盘输入事件。
  // 每次用户动手前后比对所有字段的值；用户点开某个字段（或它所在的小控件）之后它的值被改了，
  // 就录成“设置这个字段的值”的步骤（可以当参数改），期间在控件和它弹出的面板里的点击作为它的成员保留
  const FIELD_SEL = 'input:not([type=hidden]):not([type=button]):not([type=submit]):not([type=reset]):not([type=image]):not([type=file]),textarea,select';
  const knownRoots = new Set();
  function noteRoot(el) {
    for (let r = el && rootOf(el); r && r.host && !knownRoots.has(r); r = rootOf(r.host)) {
      knownRoots.add(r);
      r.addEventListener('change', onChange, true); // change 不会穿出 Shadow DOM
    }
  }
  const fieldKey = (el) => (/^(checkbox|radio)$/i.test(el.type) ? 'c' + el.checked : el.tagName === 'SELECT' ? 's' + [...el.selectedOptions].map((o) => o.value).join('\u0001') : 'v' + el.value);
  let known = new WeakMap();
  let lastReqScan = 0;
  function allFields() {
    const out = [...document.querySelectorAll(FIELD_SEL)];
    for (const r of [...knownRoots]) {
      if (!r.host.isConnected) { knownRoots.delete(r); continue; } // 宿主被移除（重新渲染时再进来会重新登记）
      out.push(...r.querySelectorAll(FIELD_SEL));
    }
    return out;
  }
  function remember(el) { if (el && el.nodeType === 1 && el.matches(FIELD_SEL)) known.set(el, fieldKey(el)); }
  function scan() {
    if (!recording) return;
    const changed = [];
    for (const el of allFields()) {
      notePassword(el);
      const k = fieldKey(el);
      const old = known.get(el);
      known.set(el, k);
      if (old === undefined || old === k) continue; // 第一次见到的只记基线
      changed.push(el);
      // 不是正在键入的框被页面改了值（发送后清空、重置）：上次录的值跟着改，之后再键入同样的内容照样录
      if (!(pending && pending.el === el) && lastValue.has(el)) lastValue.set(el, valueOf(el));
    }
    if (changed.length) onFieldsChanged(changed);
  }
  let scanTimers = [];
  function scheduleScans() {
    scanTimers.forEach(clearTimeout);
    scanTimers = [0, 150, 600, 1500].map((ms) => setTimeout(scan, ms));
  }
  // 按值判断：值本身是日期或时间才算日期（类名、name 里带 date / time 的联想框、校验框太多）；
  // 值是空的（清空了日期）才参考提示文字和 name
  const DATE_HINT = /日期|时间|^date|date$|^time|time$|calendar/i;
  const dateLike = (el, v) => /^(date|datetime-local|month|week|time)$/i.test(el.type || '')
    || /\d{4}\s*[-/.年]\s*\d{1,2}/.test(v) || /\d{1,2}[-/.]\d{1,2}[-/.]\d{4}/.test(v) || /^\s*\d{1,2}:\d{2}(:\d{2})?\s*$/.test(v || '')
    || (!v && (DATE_HINT.test(el.placeholder || '') || DATE_HINT.test(el.name || '')));

  let session = null; // 选择器会话：用户点开某个字段，到点了控件和它弹出的面板以外的东西为止
  let gesture = null; // 最近一次用户动手 { ts, target, stepId }
  // 控件外壳：一行以内的小块，里面没有带文字的按钮/链接（整个表单、带“搜索”按钮的那一行都不算）
  function compactWidget(n) {
    if (n === document.body || n === document.documentElement) return false;
    const r = n.getBoundingClientRect();
    if (r.height > 80 || r.width > 900) return false;
    return ![...n.querySelectorAll('button,a,[role=button],input[type=submit],input[type=button]')].some((b) => textOf(b) || b.value);
  }
  function widgetNear(t) {
    const pickable = (f) => f.tagName !== 'SELECT' && !/^(checkbox|radio)$/i.test(f.type);
    if (t.matches && t.matches(FIELD_SEL)) {
      if (!pickable(t)) return null;
      // 区间控件（开始、结束两个框）：选完开始日期焦点会自动跳到结束框，两个框算一个控件
      for (let n = t.parentElement, d = 0; n && d < 3; n = n.parentElement, d++) {
        const fs = [...n.querySelectorAll(FIELD_SEL)];
        if (fs.length > 2 || !compactWidget(n)) break;
        if (fs.length === 2 && fs.every(pickable)) return { fields: fs, widget: n };
      }
      return { fields: [t], widget: t };
    }
    // 点在控件的外壳、图标上（日期区间的两个框共用一个外壳）：往上找只包着一两个输入框的小块；
    // 带文字的按钮、链接不算（输入框旁边的“搜索”按钮）；纯图标按钮、声明了会弹出东西的按钮（打开日历的小图标）算
    const it = interactive(t);
    const opener = (b) => (!textOf(b) && !b.value) || b.hasAttribute('aria-haspopup') || b.hasAttribute('aria-expanded') || b.hasAttribute('aria-controls');
    if (it && (/^(BUTTON|A)$/.test(it.tagName) || it.getAttribute('role') === 'button') && !opener(it)) return null;
    for (let n = t, d = 0; n && n.nodeType === 1 && d < 8; n = n.parentElement, d++) {
      const fs = [...n.querySelectorAll(FIELD_SEL)];
      if (fs.length > 2 || !compactWidget(n)) break;
      if (fs.length && fs.every(pickable)) return { fields: fs, widget: n };
    }
    return null;
  }
  function startSession(near) {
    endSession();
    const s = { fields: new Set(near.fields), widget: near.widget, ts: Date.now(), steps: [], inPanel: new Set(), made: new Map(), claimed: new Set(), appeared: new WeakSet(), mutated: new WeakSet() };
    s.before = new Set(allFields().filter(visibleEl));
    // 会话期间新出现（插入或从隐藏变显示）的元素算作控件弹出的面板
    s.mo = new MutationObserver((list) => {
      for (const m of list) {
        if (m.type === 'childList') { for (const n of m.addedNodes) if (n.nodeType === 1) s.appeared.add(n); continue; }
        s.mutated.add(m.target);
        const o = m.oldValue || '';
        const shown = m.attributeName === 'hidden' ? !m.target.hasAttribute('hidden')
          : m.attributeName === 'style' ? /display:\s*none|visibility:\s*hidden/i.test(o) && !/display:\s*none|visibility:\s*hidden/i.test(m.target.getAttribute('style') || '')
            : /hidden|hide|closed|collapse/i.test(o) && !/hidden|hide|closed|collapse/i.test(m.target.getAttribute('class') || '');
        if (shown) s.appeared.add(m.target);
      }
    });
    const opts = { childList: true, subtree: true, attributes: true, attributeOldValue: true, attributeFilter: ['style', 'class', 'hidden'] };
    s.mo.observe(document.documentElement, opts);
    for (const r of knownRoots) { try { s.mo.observe(r, opts); } catch (e) { /* ignore */ } } // 面板在 Shadow DOM 里的
    s.timer = setTimeout(endSession, 120000);
    session = s;
  }
  // 弹出层：绝对/固定定位、没有铺满屏幕（日历面板、下拉列表）。页面主体区域重新渲染的表格不算
  function overlayNode(n) {
    try {
      const cs = getComputedStyle(n);
      if (cs.position !== 'absolute' && cs.position !== 'fixed') return false;
      const r = n.getBoundingClientRect();
      return r.width < innerWidth * 0.9 && r.height < innerHeight * 0.9;
    } catch (e) { return false; }
  }
  function inSessionUI(t) {
    if (!session || !t) return false;
    if (session.widget.contains(t)) return true;
    // 会话期间新出现、或者被改过（加上 show / open / active 之类的类名显示出来）的浮层
    for (let n = t; n && n.nodeType === 1; n = up(n)) if ((session.appeared.has(n) || session.mutated.has(n)) && overlayNode(n)) return true;
    // 控件自己带的下拉层（和输入框在同一个组件外壳里，会话开始后靠切换类名、样式显示出来的）
    let scope = session.widget;
    for (let k = 0; k < 3 && scope.parentElement; k++) scope = scope.parentElement;
    const changed = (n) => n && (session.mutated.has(n) || session.appeared.has(n));
    if (scope.contains(t)) {
      for (let n = t; n && n !== scope; n = n.parentElement) {
        if (overlayNode(n) && (changed(n) || changed(n.parentElement) || (n.parentElement && changed(n.parentElement.parentElement)))) return true;
      }
    }
    return false;
  }
  function endSession() {
    const s = session;
    if (!s) return;
    scan();
    session = null;
    s.mo.disconnect();
    clearTimeout(s.timer);
    // 会话里还没归属的、在弹出面板里的操作（比如选完日期后点的“确定”）并到最后一个语义步骤里，回放时由它负责；
    // 其他的（点了输入框本身但没选值等）照常保留
    const rest = s.steps.filter((id) => !s.claimed.has(id) && s.inPanel.has(id));
    const last = [...s.made.values()].pop();
    if (last && rest.length) {
      last.members.push(...rest);
      send({ type: 'updateEvent', id: last.id, patch: { members: last.members } });
    }
  }
  function semanticStep(el) {
    const s = session;
    const isSel = el.tagName === 'SELECT';
    const isChk = /^(checkbox|radio)$/i.test(el.type);
    const fresh = s.steps.filter((id) => !s.claimed.has(id));
    fresh.forEach((id) => s.claimed.add(id));
    const sens = isSensitive(el) && settings.maskPasswords !== false;
    const data = isSel ? selectData(el) : isChk ? { checked: el.checked } : { value: sens ? '' : valueOf(el), sensitive: sens || undefined, secretInput: isSensitive(el) || undefined };
    // 值是哪次操作改的就算那次的时间（扫描是异步的，比页面紧接着发的请求晚）
    const commitTs = gesture && gesture.ts >= s.ts ? gesture.ts : Date.now();
    const made = s.made.get(el);
    if (made) {
      made.members.push(...fresh);
      send({ type: 'updateEvent', id: made.id, patch: Object.assign({ members: made.members, commitTs }, data) });
      return;
    }
    const step = Object.assign({ type: isSel ? 'select' : isChk ? 'check' : 'fill', ts: s.ts, commitTs, target: describe(el), members: fresh, via: 'program', sid: s.ts }, data);
    if (step.type === 'fill') step.pick = dateLike(el, step.value) ? 'date' : 'choice';
    fresh.forEach((id) => claimed.add(id));
    const id = record(step, el);
    if (id) s.made.set(el, { id, members: fresh.slice(), el });
  }
  const claimed = new Set(); // 已经归到某个语义步骤下的原始操作
  // 按下鼠标就选中的组件（Chosen 在 mouseup 时选中）：选择那一步已经录好，这一下按完浏览器还会补来 click，并进那一步
  let pressPick = null;
  // 只认按在这个下拉自己的选项上的那一下（不是弹层里的「确定」之类按钮让组件失焦时才提交的值）
  const pressedOption = (t, field) => {
    if (!t || t.nodeType !== 1) return false;
    const opt = t.closest('[role=option],[role=treeitem],li,dd');
    const ctl = t.closest('button,[role=button],a[href],input,textarea');
    return !!(opt && (!ctl || ctl.matches('[role=option],[role=treeitem]')) && (!t.isConnected || inOverlay(t) || nearField(t, field)));
  };
  const notePressPick = (id, members, el) => {
    pressPick = id && gesture && pressedOption(gesture.target, el) ? { id, members, el, g: gesture } : null;
  };
  const hiddenField = (el) => !visibleEl(el) || tinyEl(el);
  let hiddenMulti = new WeakMap(); // 藏起来的多选原生下拉框 → 正在累加选项的那一步
  const nearField = (a, f) => { for (let n = f, d = 0; n && d < 8; n = n.parentElement, d++) if (n.contains(a)) return compactWidget(n) || d <= 2; return false; };
  const inOverlay = (a) => { for (let n = a; n && n.nodeType === 1; n = up(n)) if (overlayNode(n)) return true; return false; };
  // 刚才那几下点击是不是在给这个字段选值：从最近一次点击往回，取点在浮层里、或者点在这个字段旁边的连续点击；
  // 最早的一下必须点在字段旁边（打开面板的那个图标、外壳），免得把联动回填的字段认成是用户选的
  function retroMembers(field) {
    const out = [];
    for (let i = recentSteps.length - 1; i >= 0; i--) {
      const s = recentSteps[i];
      if (s.type === 'fill' && s.el === field && out.length && !claimed.has(s.id) && Date.now() - s.ts < 15000) { out.unshift(s); break; } // 联想框：先键入、再点联想项
      if (Date.now() - s.ts > 15000 || s.type !== 'click' || claimed.has(s.id) || !s.el) break;
      // 选完就被移出页面的联想项、下拉项（Element Plus 的联想框）也算点在浮层里
      if (!(s.ov || !s.el.isConnected || nearField(s.el, field))) break;
      out.unshift(s);
    }
    while (out.length && !nearField(out[0].el, field)) out.shift();
    return out;
  }
  function onFieldsChanged(list) {
    const effects = [];
    // 原生下拉框放最后：先让它的界面（layui 的输入框）建好语义步骤，再把下拉框挂上去
    list = list.slice().sort((a, b) => (a.tagName === 'SELECT') - (b.tagName === 'SELECT'));
    for (const el of list) {
      if (pending && pending.el === el) continue; // 正在键入，键入结束时一起录
      if (isSensitive(el) && settings.maskPasswords !== false) continue; // 密码框的变化不记值
      const fmt = formattedFill(el);
      if (session && session.fields.has(el)) {
        // 只是点开字段后键入、页面格式化了一下（没有在面板里选东西）：并进键入那一步
        const picked = session.steps.some((id) => session.inPanel.has(id));
        if (!picked && fmt) { send({ type: 'updateEvent', id: fmt, patch: { value: valueOf(el) } }); continue; }
        // 没在面板里选东西、值被清空了（扫码框、标签输入框、聊天框：键入回车后页面清空；输入框旁的清除按钮）：
        // 不是选值，键入和回车照常保留
        if (!picked && valueOf(el) === '') continue;
        // 可搜索下拉的搜索框（antd、Element Plus、Fusion）：选完被清空，值在下拉显示的文字上，由“选择”那一步录
        if (picked && valueOf(el) === '' && triggerOf(el)) continue;
        semanticStep(el);
        continue;
      }
      if (session && inSessionUI(el)) continue; // 面板里的字段（时间框、年月下拉）
      if (fmt) { send({ type: 'updateEvent', id: fmt, patch: { value: valueOf(el) } }); continue; }
      const recent = gesture && gesture.stepId && Date.now() - gesture.ts < 3000;
      // Select2、Chosen 在 mouseup 时选中并收起列表，选项上的 click 来不了（gesture 里没有步骤）：按刚按下鼠标算
      const pressed = gesture && Date.now() - gesture.ts < 3000;
      if (pressed && el.tagName === 'SELECT' && el.multiple && hiddenField(el)) {
        const prev = hiddenMulti.get(el);
        const mem = retroMembers(el);
        mem.forEach((m) => claimed.add(m.id));
        const data = selectData(el);
        // 只并接连的几次选择（中间的点击都是打开这个下拉的）；中间做了别的（点了“应用”）就另起一步
        const k = prev ? recentSteps.findIndex((x) => x.id === prev.id) : -1;
        const consecutive = k >= 0 && recentSteps.slice(k + 1).every((x) => claimed.has(x.id));
        if (prev && consecutive && Date.now() - prev.at < 15000) {
          prev.members.push(...mem.map((m) => m.id));
          prev.at = Date.now();
          send({ type: 'updateEvent', id: prev.id, patch: Object.assign({ members: prev.members, commitTs: gesture.ts }, data) });
          notePressPick(prev.id, prev.members, el);
          continue;
        }
        const sid = record(Object.assign({ type: 'select', ts: mem.length ? mem[0].ts : gesture.ts, commitTs: gesture.ts, target: describe(el), members: mem.map((m) => m.id), via: 'program' }, data), el);
        if (sid) { const h = { id: sid, members: mem.map((m) => m.id), at: Date.now() }; hiddenMulti.set(el, h); notePressPick(sid, h.members, el); }
        continue;
      }
      if (pressed && el.tagName === 'SELECT' && !el.multiple && hiddenField(el)) {
        // 藏起来的原生下拉框被组件改了值（layui、Chosen、Select2 这类自己画界面的下拉）：
        // 刚选值的那个语义步骤就是它的界面，挂上它的选项（接口发的是选项的值）；没有的话补一个选择步骤
        const made = session && [...session.made.values()].find((m) => m.el && nearField(m.el, el));
        const sel = Object.assign({ target: describe(el) }, selectData(el));
        if (made) { send({ type: 'updateEvent', id: made.id, patch: { sel } }); continue; }
        const mem = retroMembers(el);
        if (mem.length) {
          mem.forEach((m) => claimed.add(m.id));
          const members = mem.map((m) => m.id);
          notePressPick(record(Object.assign({ type: 'select', ts: mem[0].ts, commitTs: gesture.ts, target: sel.target, members, via: 'program' }, selectData(el)), el), members, el);
          continue;
        }
      }
      if (recent && !session && el.tagName !== 'SELECT' && !/^(checkbox|radio)$/i.test(el.type) && valueOf(el) !== '' && el !== gesture.target) {
        // 点图标按钮打开日历、面板里选值（焦点不在输入框上，没建起会话）：回头把这几下点击认作给这个字段选值
        const mem = retroMembers(el);
        if (mem.length) {
          mem.forEach((m) => claimed.add(m.id));
          const sens = isSensitive(el) && settings.maskPasswords !== false;
          if (!sens) {
            record({ type: 'fill', ts: mem[0].ts, commitTs: gesture.ts, target: describe(el), value: valueOf(el), members: mem.map((m) => m.id), via: 'program', sid: mem[0].ts, pick: dateLike(el, valueOf(el)) ? 'date' : 'choice' }, el);
            continue;
          }
        }
      }
      // 其他字段跟着变了（联动、回填）：只作为这一步的效果记下，不当输入参数
      if (recent && !isSensitive(el)) effects.push({ desc: (describe(el) || {}).desc, value: String(el.tagName === 'SELECT' ? selectData(el).optionText : /^(checkbox|radio)$/i.test(el.type) ? el.checked : valueOf(el)).slice(0, 60) });
    }
    if (effects.length && gesture && gesture.stepId) {
      gesture.effects = (gesture.effects || []).concat(effects).slice(0, 8);
      send({ type: 'updateEvent', id: gesture.stepId, patch: { effects: gesture.effects } });
    }
  }

  // ---------------- 动作的效果：展开 / 收起 ----------------
  // 点击前后，目标和往上三层里 aria-expanded 或“展开”类名变了、并且里面显示的东西也跟着变了，
  // 就记下点完之后的状态；回放时已经是这个状态（比如菜单分组本来就展开着）就不再点
  const TOGGLE_TOKEN = /(^|[-_])(open|opened|expand|expanded|unfold|unfolded|collapse|collapsed|fold|folded|show|shown)$/i;
  function visibleCount(n) {
    const all = n.getElementsByTagName('*');
    if (all.length > 400) return -1;
    let c = 0;
    for (const x of all) if (x.getClientRects().length) c++;
    return c;
  }
  function toggleSnap(el) {
    const out = [];
    for (let n = el, k = 0; n && n.nodeType === 1 && k <= 3; n = n.parentElement, k++) {
      out.push({ n, k, aria: n.getAttribute('aria-expanded'), cls: [...n.classList].filter((c) => TOGGLE_TOKEN.test(c)), vis: visibleCount(n) });
    }
    return out;
  }
  // 只认菜单、树、折叠面板这类“展开收起本身就是全部作用”的元素（“保存并收起”这种按钮不算）
  const menuish = (n) => n.matches('li,dd,dt,details,summary,[role=treeitem],[role=menuitem],[role=tab],[aria-expanded]')
    || /menu|tree|collapse|accordion|nav|group|fold|expand|submenu|panel-header|sider/i.test(typeof n.className === 'string' ? n.className : '');
  function toggleOf(before, href) {
    if (location.href !== href) return null; // 点完跳转了，不是单纯的开关
    for (const b of before) {
      const { n, k } = b;
      if (!n.isConnected || !menuish(n)) continue;
      const aria = n.getAttribute('aria-expanded');
      if (b.aria !== null && aria !== null && aria !== b.aria) return { up: k, attr: 'aria-expanded', after: aria === 'true' };
      const cls = [...n.classList].filter((c) => TOGGLE_TOKEN.test(c));
      const added = cls.filter((c) => !b.cls.includes(c));
      const removed = b.cls.filter((c) => !cls.includes(c));
      const vis = visibleCount(n);
      if ((added.length || removed.length) && b.vis >= 0 && vis >= 0 && vis !== b.vis) return { up: k, cls: added[0] || removed[0], after: !!added.length };
    }
    return null;
  }

  // ---------------- 只显示、不能编辑的下拉 ----------------
  // 淘宝千牛、Fusion、antd 这类 Select 的显示框不是输入框，值不在任何字段里：
  // 点开下拉 → 在弹层里点选项 → 下拉上显示的文字变成这个选项，就录成“选择 … 为 {{参数}}”（两下点击作成员），
  // 回放时点开、按文字点选项，参数改了也能选
  let lastTrigger = null; // { id, el, text, tags, ts, ts0, clicked, chain, again, dateStep }
  const selectish = (n) => n.matches('[role=combobox],[aria-haspopup=listbox],[aria-haspopup=true]') || /(^|[-_\s])(select|dropdown|combo(box)?)([-_\s]|$)/i.test(typeof n.className === 'string' ? n.className : '')
    || (dateish(n) && !n.querySelector(FIELD_SEL)); // 没有输入框、只显示日期的日期选择（shineout）
  // 多选下拉把选中的每一项显示成一个标签（带自己的“删除”小按钮）
  const TAG_CLASS = /(^|[-_\s])(tag|chip|token|selection-item|select-item)([-_\s]|$)/i;
  const isTag = (n) => TAG_CLASS.test(typeof n.className === 'string' ? n.className : '');
  // 已选标签：看得见，且标签到外壳之间没有菜单行、列表（antd 的 ant-select-item-option 也带 select-item）
  const LIST_ROW = '[role=option],[role=listbox],[class*=option],[class*=dropdown],[class*=popup]';
  const isShownTag = (n, root) => {
    if (!isTag(n) || !n.getClientRects().length || getComputedStyle(n).visibility === 'hidden') return false;
    for (let a = n; a && a !== root; a = a.parentElement) if (a.matches(LIST_ROW)) return false;
    return true;
  };
  function shownTags(root) {
    const tags = [...root.querySelectorAll('[class*=tag],[class*=chip],[class*=token],[class*=selection-item],[class*=select-item]')].filter((t) => isShownTag(t, root));
    return tags.filter((t) => !tags.some((o) => o !== t && o.contains(t))).map(tagText).filter(Boolean);
  }
  // 标签上的文字，不算它的删除按钮（有的写成 × 字符）
  function tagText(t) {
    const c = t.cloneNode(true);
    c.querySelectorAll('[class*=close],[class*=remove],[class*=delete],button,[role=button],svg,i').forEach((x) => x.remove());
    return norm(c.textContent);
  }
  // 下拉的外壳不大、里面没有别的按钮（标签上的删除按钮不算）
  function selectBox(n) {
    if (n === document.body || n === document.documentElement) return false;
    const r = n.getBoundingClientRect();
    if (r.height > 160 || r.width > 900) return false;
    return ![...n.querySelectorAll('button,a,[role=button],input[type=submit],input[type=button]')].some((b) => (textOf(b) || b.value) && !isTag(b) && !(b.parentElement && b.parentElement.closest('[class*=tag],[class*=chip],[class*=token],[class*=selection-item]')));
  }
  // 下拉的外壳：往上找“像下拉”的祖先，取最外层的那个（Fusion 的 span.next-select、antd 的 div.ant-select、
  // shineout 的 div.soui-select-wrapper），显示选中文字的就是它；原生 <select> 由 change 录，不走这里
  const LIST_SEL = '[role=option],[role=listbox],[role=menu]';
  function triggerOf(el) {
    if (!el || el.tagName === 'SELECT' || el.tagName === 'OPTION' || el.closest(LIST_SEL)) return null;
    let root = null;
    for (let n = el, k = 0; n && n.nodeType === 1 && k < 7; n = n.parentElement, k++) {
      if (!selectish(n)) { if (root) break; continue; }
      if (n !== el && !selectBox(n)) break;
      if (n.querySelectorAll('select').length) return null;
      root = n;
    }
    return root;
  }
  // 下拉上显示的文字：有的组件把选项列表就放在外壳里面（shineout），列表里的、看不见的文字不算
  const tinyEl = (n) => { const r = n.getBoundingClientRect(); return r.width <= 1 || r.height <= 1 || (n.checkVisibility && !n.checkVisibility({ opacityProperty: true })); };
  function shownText(root) {
    const skip = new Map();
    const hidden = (n) => {
      if (!n || n === root) return false;
      if (skip.has(n)) return skip.get(n);
      const v = n.matches('ul,ol,dl,[role=listbox]') || !visibleEl(n) || (overlayNode(n) && (!!n.querySelector('[role=option],[role=treeitem],li,dd,[class*=option],[class*=node]') || /option|menu|list|popup|panel|picker/i.test(typeof n.className === 'string' ? n.className : ''))) || hidden(n.parentElement);
      skip.set(n, v);
      return v;
    };
    let out = '';
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    // 外层容器可能高度为 0（Element Plus 的 el-select__selection），只看直接包着文字的元素是不是 0 大小、透明（antd 的读屏镜像）
    for (let t = w.nextNode(); t; t = w.nextNode()) if (!hidden(t.parentElement) && !(t.parentElement !== root && tinyEl(t.parentElement))) out += ' ' + t.nodeValue;
    return norm(out);
  }
  const HAS_CHILDREN = '[class*=has-children],[class*=expand],[aria-haspopup=true],[aria-expanded]';
  const OPTION_SEL = '[role=option],[role=treeitem],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],li,dd,[class*=option],[class*=item],[class*=node]';
  const dateText = (v) => /\d{4}\s*[-/.年]\s*\d{1,2}/.test(v) || /\d{1,2}[-/.]\d{1,2}[-/.]\d{4}/.test(v);
  const dateish = (n) => /(^|[-_\s])(date|datepicker|date-picker|picker|calendar|range)([-_\s]|$)/i.test(typeof n.className === 'string' ? n.className : '');
  function noteDisplayChoice(el, id, raw) {
    const at = Date.now();
    const lt = lastTrigger;
    // 刚点开过一个下拉、这一下点的是列表里的一项：当选项看（选项列表的类名里也常带 select，不能先按“下拉外壳”认）。
    // 选项不一定是 li / role=option（antd 的 div.ant-select-item、shineout 的 a.so-select-option、级联和树的节点），点在弹层里的也算
    const fresh = !!(lt && at - lt.ts <= 15000);
    const src = raw && raw.nodeType === 1 && (el.contains(raw) || !raw.isConnected) ? raw : el;
    // 按下时列表重新渲染了（shineout）：click 落在公共祖先上，按按下的那个元素算（可能已经不在页面上）
    const listy = fresh && (inOverlay(src) || !src.isConnected);
    const item = fresh ? src.closest('[role=option],li,dd') || (listy ? src.closest(OPTION_SEL) || src : null) : null;
    const asOption = !!(fresh && item && !item.contains(lt.clicked) && !item.contains(lt.el) && (listy || item.matches('[role=option]') || lt.el.contains(item) || (item.parentElement && item.parentElement.children.length > 1)));
    if (!asOption) {
      // 输入框的值也跟着变了的（会话里由字段变化录成语义步骤）会先认领这两下点击，这里就不再重复录
      const trig = triggerOf(el);
      if (trig) {
        if (!(lt && lt.el === trig && at - lt.ts < 400)) lastTrigger = { id, ts0: at, el: trig, text: shownText(trig), tags: shownTags(trig), ts: at, clicked: el, chain: [], again: false };
      } else lastTrigger = null;
      return;
    }
    const optText = textOf(item.contains(el) ? el : item);
    if (!optText || optText.length > 60) { lastTrigger = null; return; }
    // 下拉还算开着：多选接着点下一项、级联点下一级都要接得上（用户点得快，350ms 的确认还没回来）
    // col：点的时候所在的那一列（组件可能在确认前就把选项从列里拿掉）
    const entry = { id, text: optText, el: item, col: item.parentElement, at, done: false };
    lt.chain.push(entry);
    lt.ts = at;
    setTimeout(() => settleChoice(lt, entry), 350);
  }
  function settleChoice(lt, entry) {
    if (!lt.el.isConnected || entry.done || claimed.has(entry.id) || (!lt.again && claimed.has(lt.id))) return;
    const optText = entry.text;
    const now = shownText(lt.el);
    const tags = shownTags(lt.el);
    const added = tags.includes(optText) && !(lt.tags || []).includes(optText);
    if (now === lt.text && !added) return; // 显示没变：级联的中间一级，或者点了已经选着的那一项
    // 级联点得慢：上一级点完显示就先变成了它（已经录成一步），这一下点的是下一列：把那一步改成整条路径
    const cs = lt.cascStep;
    if (cs && entry.col !== cs.cols[cs.cols.length - 1] && !claimed.has(entry.id)) {
      // 按列记路径：这次之前还没并进来的几下（显示没变的中间一级、回到前面某列换了分支）按时间顺序过一遍，
      // 点在已有的第 d 列就把第 d 级及以下换掉，点在新列就接在后面；原始点击都留在 members 里给原样回放
      const steps = lt.chain.filter((e) => e !== entry && !e.done && !claimed.has(e.id) && e.at > cs.lastAt && e.at <= entry.at).concat(entry);
      for (const e of steps) {
        const col = e.col;
        // 不知道是哪一列的（没记下来）当成新的一列，不截断已有路径
        let d = col ? cs.cols.indexOf(col) : -1;
        if (d < 0) d = cs.cols.length;
        cs.cols.length = d;
        cs.texts.length = d;
        cs.cols.push(col);
        cs.texts.push(e.text);
        cs.members.push(e.id);
        claimed.add(e.id);
        e.done = true;
      }
      cs.lastAt = entry.at;
      send({ type: 'updateEvent', id: cs.id, patch: { value: cs.texts.join(' / '), members: cs.members, commitTs: entry.at } });
      lt.text = now;
      if (!entry.el.matches(HAS_CHILDREN) && lastTrigger === lt) lastTrigger = null;
      return;
    }
    const idx = lt.chain.indexOf(entry);
    const later = idx < lt.chain.length - 1;
    // 之前点过、显示没跟着变的几下（级联的上几级，在别的列里）
    const prior = lt.chain.slice(0, idx).filter((e) => !e.done && e.el.parentElement !== entry.el.parentElement);
    const parts = now.split(/\s*[/>＞]\s*/).filter(Boolean);
    let value = null;
    let pick = 'choice';
    let multi = false;
    let used = [entry];
    if (dateish(lt.el) && dateText(now) && !tags.length) {
      // 只显示、没有输入框的日期选择（shineout 的 DatePicker）：显示的日期就是值；区间点两下，并成一步
      value = now;
      pick = 'date';
      used = prior.concat(entry);
    } else if (added) {
      value = optText;
      multi = true;
    } else if (parts.length > 1 && norm(parts[parts.length - 1]) === optText) {
      value = parts.join(' / ');
      used = prior.concat(entry);
    } else if (prior.length && norm(now.replace(/[/>＞]/g, ' ')) === prior.map((e) => e.text).concat(optText).join(' ')) {
      // 级联各级分开显示、没有分隔符（shineout）
      value = prior.map((e) => e.text).concat(optText).join(' / ');
      used = prior.concat(entry);
    } else if (now === optText) {
      value = prior.length ? prior.map((e) => e.text).concat(optText).join(' / ') : optText;
      used = prior.concat(entry);
    } else if (later) {
      return; // 后面还点了别的（级联的下一级）：由最后一下来定
    } else if (!tags.length && now.includes(optText) && !lt.text.includes(optText)) {
      value = optText;
      multi = true;
    }
    if (value == null) return;
    if (/(^|[-_\s])(multiple|multi|tags)([-_\s]|$)/i.test(typeof lt.el.className === 'string' ? lt.el.className : '')) multi = pick === 'choice' && !parts[1];
    used.forEach((e) => { e.done = true; });
    // 可搜索的下拉：先在外壳里的搜索框键入过滤，再点选项（选完搜索框清空）。键入那一步并进来，回放时由选择负责
    const inner = lt.el.querySelector(FIELD_SEL);
    const typed = inner && fillOf.get(inner);
    const typedId = typed && typed.ts >= lt.ts - 15000 && !claimed.has(typed.id) ? typed.id : null;
    const members = (lt.again ? [] : [lt.id]).concat(typedId ? [typedId] : [], used.map((e) => e.id));
    members.forEach((m) => claimed.add(m));
    if (pick === 'date' && lt.dateStep) {
      lt.dateStep.members.push(...members);
      send({ type: 'updateEvent', id: lt.dateStep.id, patch: { value, members: lt.dateStep.members, commitTs: entry.at } });
      lt.text = now;
      return;
    }
    // 外壳的文字就是选中的值，会变，不能拿来定位，也不能当名字；名字取表单项标签，或里面输入框的（label for、name）
    const tg = describe(lt.el);
    const lbl = (tg.ctx && tg.ctx.label) || (inner ? labelOf(inner) : '') || '';
    Object.assign(tg, { text: '', kind: '下拉框', label: lbl, desc: `下拉框${lbl ? ` "${lbl}"` : ''}` });
    // 值是点选项那一刻定下来的（350ms 只是用来确认下拉上显示的变了）：选完立刻发的请求要算在这一步之后
    const ts = lt.again ? used[0].at : lt.ts0 || lt.ts;
    const step = { type: 'fill', ts, commitTs: entry.at, target: tg, value, members, via: 'program', sid: ts, pick };
    // 多选：记下选之前下拉上已有的项（回放时页面上留着上一次选的，先清掉再选）
    if (multi) { step.multi = true; step.before = lt.tags || []; }
    const sid = record(step, lt.el);
    lt.text = now;
    lt.tags = multi ? (lt.tags || []).concat(value) : tags;
    lt.again = true;
    if (pick === 'date' && sid) lt.dateStep = { id: sid, members: members.slice() };
    // 点的是级联里有下一级的节点：下拉还开着，接着点的下一列并进这一步
    // 前面几级在哪一列不确定（点击顺序不一定是层级顺序），先用占位，不会被匹配上截断路径
    if (!multi && pick === 'choice' && entry.el.matches(HAS_CHILDREN) && sid) { const texts = String(value).split(' / '); lt.cascStep = { id: sid, members: members.slice(), texts, cols: texts.slice(1).map(() => ({})).concat(entry.col || {}), lastAt: entry.at }; return; }
    // 多选下拉点完面板还开着，接着点的下一项也是这个下拉的；单选选完就结束
    if (!multi && pick !== 'date' && lastTrigger === lt) lastTrigger = null;
  }

  // ---------------- 动作的效果：开关、勾选、按下 ----------------
  // 自定义开关（el-switch、Naive UI 的 switch）、复选框、按下态按钮：点击前后 aria-checked / aria-pressed / aria-selected
  // 或者里面的原生复选框变了，就记下点完的状态；回放时已经是这个状态就不再点（再点会把开关翻回去）
  function stateSnap(el) {
    const out = [];
    for (let n = el, k = 0; n && n.nodeType === 1 && k <= 3; n = n.parentElement, k++) {
      for (const a of ['aria-checked', 'aria-pressed', 'aria-selected']) {
        const v = n.getAttribute(a);
        if (v === 'true' || v === 'false') out.push({ n, up: k, attr: a, v });
      }
    }
    const box = el.matches('input') ? null : el.control && /^(checkbox|radio)$/i.test(el.control.type) ? el.control : el.querySelector && el.querySelector('input[type=checkbox],input[type=radio]');
    if (box) out.push({ n: box, input: true, v: String(box.checked) });
    return out;
  }
  function stateOf(before) {
    for (const b of before || []) {
      if (!b.n.isConnected) continue;
      const v = b.input ? String(b.n.checked) : b.n.getAttribute(b.attr);
      if (v !== b.v && (v === 'true' || v === 'false')) return b.input ? { input: true, after: v === 'true' } : { up: b.up, attr: b.attr, after: v === 'true' };
    }
    return null;
  }

  // ---------------- 鼠标经过的菜单（悬停才展开的菜单，回放时找不到目标就沿这条路悬停一遍） ----------------
  const hoverTrail = [];
  function menuLike(el) {
    for (let n = el, k = 0; n && n.nodeType === 1 && k < 3; n = n.parentElement, k++) {
      if (n.hasAttribute('aria-haspopup') || n.hasAttribute('aria-expanded')) return true;
      if (/menu|dropdown|submenu|nav|popover|trigger/i.test(typeof n.className === 'string' ? n.className : '')) return true;
    }
    return false;
  }
  listen('mouseover', (e) => {
    if (!recording || !e.isTrusted) return;
    const t = deepTarget(e);
    const el = t && t.closest ? t.closest(CLICKABLE) || t : null;
    if (!el || !menuLike(el)) return;
    const last = hoverTrail[hoverTrail.length - 1];
    if (last && last.el === el) { last.ts = Date.now(); return; }
    hoverTrail.push({ el, ts: Date.now() });
    if (hoverTrail.length > 6) hoverTrail.shift();
  }, { capture: true, passive: true });
  function trailFor(target) {
    const out = [];
    for (const h of hoverTrail) {
      if (Date.now() - h.ts > 5000 || !h.el.isConnected || h.el === target || h.el.contains(target) || target.contains(h.el)) continue;
      if (!out.includes(h.el)) out.push(h.el);
    }
    return out.length ? out.slice(-3).map(describe) : undefined;
  }

  // ---------------- 手势：每次按下鼠标 ----------------
  let pressInfo = null; // { t, x, y, ts, max, toggle, href }
  let dragEndTs = 0;
  let userScrollTs = 0;
  listen('pointerdown', (e) => {
    if (!recording || !e.isTrusted || isOurUI(e)) return;
    const t = deepTarget(e);
    noteRoot(t);
    scan(); // 先把上一次操作之后异步发生的变化归到上一次
    if (session && !inSessionUI(t)) endSession();
    if (!session) { const near = widgetNear(t); if (near) startSession(near); }
    gesture = { ts: Date.now(), target: t };
    scheduleScans();
    // 拖动滚动条
    if (t.clientWidth && (e.offsetX > t.clientWidth || e.offsetY > t.clientHeight)) userScrollTs = Date.now();
    pressInfo = { t, x: e.clientX, y: e.clientY, ts: Date.now(), max: 0, button: e.button, toggle: e.button === 0 ? toggleSnap(interactive(t)) : null, state: e.button === 0 ? stateSnap(interactive(t)) : null, href: location.href };
  }, true);
  listen('focusin', (e) => {
    if (!recording || !e.isTrusted) return;
    const t = deepTarget(e);
    noteRoot(t);
    notePassword(t); // 空白 iframe、还没登记的 Shadow DOM 里的密码框扫描不到，聚焦时记
    if (!t.matches || !t.matches(FIELD_SEL) || (session && (session.fields.has(t) || inSessionUI(t)))) return;
    const near = widgetNear(t);
    if (near) startSession(near);
  }, true);
  listen('pointermove', (e) => {
    if (pressInfo && e.isTrusted) pressInfo.max = Math.max(pressInfo.max, Math.hypot(e.clientX - pressInfo.x, e.clientY - pressInfo.y));
  }, { capture: true, passive: true });
  // 拖动：按住移动超过 10 像素再松开。选中文字、拖滚动条、在输入框里拖选不算
  listen('pointerup', (e) => {
    const d = pressInfo;
    if (!d || !recording || !e.isTrusted || d.button !== 0 || isOurUI(e)) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (d.max < 10 || Math.hypot(dx, dy) < 10 || Date.now() - d.ts < 120) return;
    if (isTextField(d.t) || Date.now() - userScrollTs < 500) return;
    const selText = window.getSelection ? String(window.getSelection()).trim() : '';
    if (selText && !(d.t.closest && d.t.closest('[draggable=true]'))) return;
    const src = interactive(d.t);
    const end = deepAt(e.clientX, e.clientY, d.t.ownerDocument);
    const rel = (el, x, y) => { const r = el.getBoundingClientRect(); return r.width && r.height ? [Math.round((x - r.left) / r.width * 1000) / 1000, Math.round((y - r.top) / r.height * 1000) / 1000] : undefined; };
    dragEndTs = Date.now();
    flushInput();
    const toEl = end && end !== src && !src.contains(end) ? interactive(end) : null;
    record({ type: 'drag', target: describe(src), pos: rel(src, d.x, d.y), to: toEl ? describe(toEl) : undefined, toPos: toEl ? rel(toEl, e.clientX, e.clientY) : undefined, dx: Math.round(dx), dy: Math.round(dy) }, src);
  }, true);
  function deepAt(x, y, doc) {
    let h = (doc || document).elementFromPoint(x, y);
    while (h && h.shadowRoot) { const i = h.shadowRoot.elementFromPoint(x, y); if (!i || i === h) break; h = i; }
    return h;
  }
  // 原生拖放（draggable）：pointerup 不会来，按 dragstart → drop 录
  let dndSrc = null;
  listen('dragstart', (e) => { if (recording && e.isTrusted) dndSrc = interactive(deepTarget(e)); }, true);
  // 没拖到能放的地方（不会有 drop）也要清掉，不然之后从桌面拖文件进来会被当成“拖动刚才那个元素”
  listen('dragend', () => { dndSrc = null; }, true);
  listen('drop', (e) => {
    if (!recording || !e.isTrusted) return;
    // 从桌面拖文件进页面（上传区）：录成上传，回放时用浏览器调试接口把参数里的文件拖进去
    const dropped = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length ? [...e.dataTransfer.files].map((f) => f.name) : null;
    // 只带着文件、没有别的类型：是从桌面拖进来的（页面里拖图片也带文件，但同时有 text/html、text/uri-list）。
    // 这时还留着拖动起点，是上一次拖动的起点被页面移走、没收到 dragend
    const fromDesktop = !!dropped && [...(e.dataTransfer.types || [])].every((x) => x === 'Files');
    if (dropped && (!dndSrc || fromDesktop)) {
      dndSrc = null;
      const zone = interactive(deepTarget(e));
      flushInput();
      record({ type: 'upload', drop: true, target: describe(zone), files: dropped }, zone);
      return;
    }
    if (!dndSrc) return;
    const to = interactive(deepTarget(e));
    const src = dndSrc;
    dndSrc = null;
    dragEndTs = Date.now();
    pressInfo = null;
    record({ type: 'drag', html5: true, target: describe(src), to: describe(to), dx: 0, dy: 0 }, src);
  }, true);

  listen('click', (e) => {
    if (!recording || !e.isTrusted || isOurUI(e)) return;
    const t = deepTarget(e);
    if (e.altKey && settings.altExtract !== false) {
      e.preventDefault();
      e.stopImmediatePropagation();
      flushInput();
      // Alt+点击 = 提取该元素；Alt+Shift+点击 = 提取它所在的整个表格/列表
      let el = t;
      if (e.shiftKey) el = el.closest('table,ul,ol,dl,[role=table],[role=grid],[role=list]') || el;
      const tg = describe(el);
      tg.text = ''; // 内容会变化，不用文本定位
      const name = (el.getAttribute('aria-label') || el.getAttribute('title') || el.id || el.getAttribute('name') || '').trim().slice(0, 30);
      record({ type: 'extract', target: tg, name: name || undefined, sample: textOf(el).slice(0, 200) }, el);
      toast('已标记提取：' + tg.desc);
      return;
    }
    if (Date.now() - dragEndTs < 300) return; // 拖动结束时浏览器补的 click，已经录成拖动
    flushInput();
    const el = interactive(t);
    if (!el || el.nodeType !== 1) return;
    if (el.tagName === 'INPUT' && /^(checkbox|radio|file)$/i.test(el.type)) return; // 由 change 记录
    if (el.tagName === 'LABEL' && el.control && /^(checkbox|radio|file)$/i.test(el.control.type)) return;
    if (el.tagName === 'SELECT' || el.tagName === 'OPTION') return;
    const id = record({ type: 'click', target: describe(el), pos: posIn(el, e), hover: trailFor(el) }, el);
    const pp = pressPick;
    pressPick = null;
    if (id && pp && pp.g === gesture && Date.now() - pp.g.ts < 3000 && (inOverlay(el) || nearField(el, pp.el))) {
      claimed.add(id);
      pp.members.push(id);
      send({ type: 'updateEvent', id: pp.id, patch: { members: pp.members } });
      gesture.stepId = pp.id;
      return;
    }
    if (gesture) gesture.stepId = id;
    if (id) noteDisplayChoice(el, id, pressInfo && pressInfo.t && (t.contains(pressInfo.t) || !pressInfo.t.isConnected) ? pressInfo.t : t);
    // 点完 350ms 看看是不是展开/收起开关、勾选开关
    const p = pressInfo;
    if (id && p && (p.toggle || (p.state && p.state.length))) {
      setTimeout(() => {
        const patch = {};
        const tg = p.toggle && toggleOf(p.toggle, p.href);
        if (tg) patch.toggle = tg;
        const st = location.href === p.href ? stateOf(p.state) : null;
        if (st) patch.state = st;
        if (tg || st) send({ type: 'updateEvent', id, patch });
      }, 350);
    }
  }, true);

  listen('dblclick', (e) => {
    if (!recording || !e.isTrusted || isOurUI(e)) return;
    const el = interactive(deepTarget(e));
    if (!el || el.nodeType !== 1) return;
    // 双击前浏览器已经发了两次 click（各录了一步）：作为这一步的成员，回放时一起由双击完成
    const clicks = recentSteps.filter((s) => s.type === 'click' && s.el === el && Date.now() - s.ts < 1500).slice(-2);
    record({ type: 'dblclick', target: describe(el), pos: posIn(el, e), members: clicks.map((c) => c.id) }, el);
  }, true);

  listen('contextmenu', (e) => {
    if (!recording || !e.isTrusted || isOurUI(e)) return;
    flushInput();
    const el = interactive(deepTarget(e));
    if (!el || el.nodeType !== 1) return;
    const id = record({ type: 'contextmenu', target: describe(el), pos: posIn(el, e) }, el);
    if (gesture) gesture.stepId = id;
  }, true);

  // Alt 点击时阻止页面的 mousedown 行为
  listen('mousedown', (e) => {
    if (recording && e.isTrusted && e.altKey && settings.altExtract !== false && !isOurUI(e)) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }, true);

  // 宿主里的 Shadow DOM：open 的直接拿；closed 的用扩展专用接口（没有这个接口的旧浏览器拿不到）
  const shadowOf = (n) => { try { return n.shadowRoot || (chrome.dom && chrome.dom.openOrClosedShadowRoot ? chrome.dom.openOrClosedShadowRoot(n) : null); } catch (e) { return null; } };
  // 焦点真正在哪个元素上（一层层进 Shadow DOM）
  function innerFocus(el) {
    let a = el;
    for (let k = 0; k < 8; k++) { const r = shadowOf(a); if (!r || !r.activeElement) break; a = r.activeElement; }
    return a;
  }
  // 自定义元素、又看不到它里面（没有上面那个接口）：里面可能正是个输入框
  const unseenShadow = (el) => el.tagName.includes('-') && !el.shadowRoot && !(chrome.dom && chrome.dom.openOrClosedShadowRoot);
  // 目标或外面几层的名字、类名、说明像密码 / 验证码的
  const SECRET_HINT = /pass(?:word|wd|code|phrase)|pwd|(?:^|[^a-z])(?:pass|otp|pin|cvv|cvc|secret)(?![a-z])|密码|口令|验证码|安全码/;
  function secretish(el) {
    for (let n = el, k = 0; n && n.nodeType === 1 && k < 4; n = n.parentElement, k++) {
      if (SECRET_HINT.test(nameWords(`${n.id || ''} ${typeof n.className === 'string' ? n.className : ''} ${n.getAttribute('aria-label') || ''} ${n.getAttribute('name') || ''} ${n.getAttribute('placeholder') || ''}`))) return true;
    }
    return false;
  }
  // 按键：回车、Esc、Tab、功能键都录；方向键、翻页只在不是打字的时候（或者有展开的下拉/联想列表时）录；
  // Ctrl/Cmd 组合键录（输入框里的复制、粘贴、全选、撤销除外）；不在打字时的空格、单个字符当快捷键录；普通打字由输入事件录
  listen('keydown', (e) => {
    if (!recording || !e.isTrusted || isOurUI(e)) return;
    if (/^(Alt|Control|Meta|Shift|CapsLock|Process|Unidentified|Dead)$/.test(e.key)) return;
    if (e.isComposing || e.keyCode === 229) return; // 输入法组字中
    if (/^(PageUp|PageDown|ArrowUp|ArrowDown|Home|End| )$/.test(e.key)) userScrollTs = Date.now();
    const t = deepTarget(e);
    noteRoot(t);
    const el = t && t !== document.body && t !== document.documentElement && t.nodeType === 1 ? t : null;
    // 是不是在打字不看 el（目标是 body 时 el 为空）：可编辑的 body、designMode 的 iframe 编辑器（CKEditor4、UEditor）里
    // 打的字、空格、方向键、退格都是内容，由输入事件录成「输入」
    const tdoc = (t && (t.nodeType === 9 ? t : t.ownerDocument)) || document;
    const bodyEditable = tdoc.designMode === 'on' || !!(tdoc.body && tdoc.body.isContentEditable);
    const typing = !!((el && isTextField(el)) || (t && t.nodeType === 1 && isTextField(t)) || bodyEditable);
    // 焦点在 body 上（页面在 document 上接键盘）时，页面上有看得见的密码框、验证码框，就当是在输自己画的 PIN 键盘
    const secretOnPage = () => [...tdoc.querySelectorAll('input')].some((f) => isSensitive(f) && visibleEl(f));
    // 单个字符、空格当快捷键录之前再确认不是在输入内容：焦点在 closed Shadow DOM 里的输入框上（事件目标只到宿主）、
    // 自己画的密码 / PIN 键盘（div、canvas 接键盘事件）、按住不放的重复，都不录——不然密码会一个字符一个字符明文录下来。
    // 焦点在 body 上时数字键一律不当快捷键（PIN、验证码多半是数字；在 body 上用数字当快捷键的页面很少）
    const asShortcut = () => !typing && !e.repeat && (el
      ? !(isTextField(innerFocus(el)) || unseenShadow(el) || secretish(el))
      : !/^\d$/.test(e.key) && !secretOnPage());
    const popup = !!(el && (el.getAttribute('aria-expanded') === 'true' || el.hasAttribute('aria-activedescendant') || session));
    let keep = false;
    if (/^(Enter|Escape|Tab)$/.test(e.key)) keep = true;
    else if (e.ctrlKey || e.metaKey) keep = !(typing && /^[acvxyz]$/i.test(e.key));
    else if (/^(ArrowUp|ArrowDown|PageUp|PageDown)$/.test(e.key)) keep = !typing || popup;
    else if (/^(ArrowLeft|ArrowRight|Home|End|Delete|Backspace)$/.test(e.key)) keep = !typing;
    // 功能键：F5 刷新、F12 开发者工具是浏览器自己的，不录
    else if (/^F([1-9]|1[0-2])$/.test(e.key)) keep = !/^F(5|12)$/.test(e.key);
    // 不在打字时按的空格、单个字符是页面的快捷键（播放/暂停、j/k 上下条、/ 聚焦搜索）。
    // 按钮、复选框、原生下拉框上的空格浏览器会接着发 click / change（已经录了），原生下拉框上的字符是按首字母选项：都不再录按键
    else if (e.key === ' ') keep = asShortcut() && !(el && el.matches('button,summary,input,select'));
    else if (e.key.length === 1) keep = asShortcut() && !(el && el.tagName === 'SELECT');
    if (!keep) return;
    flushInput();
    scan();
    gesture = { ts: Date.now(), target: t };
    scheduleScans();
    const id = record({ type: 'press', key: e.key, target: el ? describe(el) : null, ctrl: e.ctrlKey || undefined, meta: e.metaKey || undefined, shift: e.shiftKey || undefined, alt: e.altKey || undefined }, el);
    gesture.stepId = id;
    // Tab：记下焦点落到了哪里（模拟事件回放时按这个移动焦点）
    if (e.key === 'Tab' && id) setTimeout(() => { const a = deepActive(); if (a && a !== el && a !== document.body) send({ type: 'updateEvent', id, patch: { to: describe(a) } }); }, 0);
  }, true);

  // 滚动：页面和可滚动的容器（表格、虚拟列表）。只录用户滚的（滚轮、触摸、键盘、拖滚动条），
  // 页面自己滚的（展开时自动滚到可见位置）不录
  ['wheel', 'touchmove'].forEach((type) => listen(type, (e) => { if (e.isTrusted) userScrollTs = Date.now(); }, { capture: true, passive: true }));
  const scrollTimers = new Map();
  let lastScroll = { x: 0, y: 0 };
  const lastElScroll = new WeakMap();
  listen('scroll', (e) => {
    if (!recording || settings.recordScroll === false || Date.now() - userScrollTs > 1500) return;
    const t = e.target === document || e.target === window ? window : e.target;
    clearTimeout(scrollTimers.get(t));
    scrollTimers.set(t, setTimeout(() => {
      scrollTimers.delete(t);
      if (t === window) {
        const x = Math.round(window.scrollX);
        const y = Math.round(window.scrollY);
        if (Math.abs(y - lastScroll.y) < 200 && Math.abs(x - lastScroll.x) < 200) return;
        lastScroll = { x, y };
        if (lastStep && lastStep.type === 'scroll' && !lastStep.el) send({ type: 'updateEvent', id: lastStep.id, patch: { x, y } });
        else record({ type: 'scroll', x, y }, null);
        return;
      }
      if (t.nodeType !== 1 || !t.isConnected || t === uiHost) return;
      const x = Math.round(t.scrollLeft);
      const y = Math.round(t.scrollTop);
      const prev = lastElScroll.get(t) || { x: 0, y: 0 };
      if (Math.abs(y - prev.y) < 50 && Math.abs(x - prev.x) < 50) return;
      lastElScroll.set(t, { x, y });
      if (lastStep && lastStep.type === 'scroll' && lastStep.el === t) send({ type: 'updateEvent', id: lastStep.id, patch: { x, y } });
      else record({ type: 'scroll', target: describe(t), x, y }, t);
    }, 600));
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

  window.addEventListener('pagehide', () => { flushInput(); endSession(); }, true);

  // Chrome 将真实输入的调用入口保留在 ISOLATED world。
  window.__pageRecorderInput = async (token, req) => {
    if (!IS_TOP) return { ok: false, error: '子框架使用模拟输入' };
    const inside = (x, y) => {
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return false;
      const hit = document.elementFromPoint(x, y);
      return hit && !/^(IFRAME|FRAME)$/.test(hit.tagName);
    };
    if (('x' in req && !inside(req.x, req.y)) || ('tx' in req && !inside(req.tx, req.ty))) {
      return { ok: false, error: '坐标不在顶层页面的可操作区域内' };
    }
    if (req.type === 'key' || req.type === 'text') {
      const a = deepActive();
      if (!document.hasFocus() || (a && /^(IFRAME|FRAME)$/.test(a.tagName))) return { ok: false, error: '焦点不在顶层页面' };
    }
    return (await send({ type: 'realInput', token, req })) || { ok: false, unknown: true, error: '扩展没有响应' };
  };

  let hookPort = null;
  let hookBound = false;
  let stateKnown = false;
  function sendHook(msg) {
    if (!hookBound) return;
    try { hookPort.postMessage(msg); } catch (e) { /* ignore */ }
  }
  function onHookMessage(d) {
    if (!d || typeof d !== 'object') return;
    if (d[TAG] === 'initAck') {
      hookBound = true;
      hookState();
      return;
    }
    if (!hookBound) return;
    // 页面弹了原生弹窗：记到触发它的那一步上（回放时提前装好同样的应答）
    if (d[TAG] === 'dialog' && recording) {
      if (lastStep) {
        lastStep.dialogs.push({ kind: d.kind, message: String(d.message || '').slice(0, 300), result: d.result });
        send({ type: 'updateEvent', id: lastStep.id, patch: { dialogs: lastStep.dialogs } });
      }
      return;
    }
    if (d[TAG] === 'reqstart') { if (Date.now() - lastReqScan > 150) { lastReqScan = Date.now(); scan(); } return; }
    // 没挂到页面上的文件框选了文件（hook.js 报告）：记成上传，目标是刚才点的那个“上传”按钮，回放时点它、拦下选文件对话框设文件
    if (d[TAG] === 'filepick' && recording && Array.isArray(d.files)) {
      const s = lastStep && lastStep.type === 'click' && Date.now() - lastStep.ts < 30000 && lastStep.el && lastStep.el.isConnected ? lastStep : null;
      if (s) record({ type: 'upload', chooser: true, target: describe(s.el), files: d.files.map(String).slice(0, 20) }, s.el);
      return;
    }
    if (d[TAG] !== 'net' || !(recording || capturing)) return;
    const r = d.data;
    if (!r || typeof r !== 'object') return;
    send({ type: 'event', event: { ...r, kind: 'request' } }).then(updateCounts);
  }
  function connectHook() {
    if (hookPort) return;
    const ch = new MessageChannel();
    hookPort = ch.port1;
    hookPort.onmessage = (ev) => onHookMessage(ev.data);
    window.postMessage({ [TAG]: 'init' }, '*', [ch.port2]);
  }

  window.addEventListener('message', (e) => {
    if (e.isTrusted && e.source === window && e.data?.[TAG] === 'ready') connectHook();
  });

  function updateCounts(res) {
    if (res && res.counts) { counts = res.counts; renderUI(); }
  }

  // 抓包模式：扩展回放这个标签页时只转发接口请求和返回，不记录操作、不显示浮层
  let capturing = false;
  const hookState = () => {
    if (stateKnown) sendHook({ [TAG]: 'state', recording: recording || capturing, maxBody: (settings.maxBodyKB || 512) * 1024 });
  };
  let stateVersion = 0;
  let captureVersion = 0;
  function setCapture(on) { capturing = !!on; if (capturing) stateKnown = true; hookState(); }
  function resetRecordingState(clearRoots) {
    lastStep = null;
    recentSteps.length = 0;
    lastValue = new WeakMap();
    fillOf = new WeakMap();
    hiddenMulti = new WeakMap();
    known = new WeakMap();
    claimed.clear();
    lastTrigger = null;
    gesture = null;
    pressPick = null;
    pressInfo = null;
    dndSrc = null;
    hoverTrail.length = 0;
    scanTimers.forEach(clearTimeout);
    scanTimers = [];
    for (const tm of scrollTimers.values()) clearTimeout(tm);
    scrollTimers.clear();
    if (clearRoots) {
      for (const r of knownRoots) { try { r.removeEventListener('change', onChange, true); } catch (e) { /* ignore */ } }
      knownRoots.clear();
    }
  }
  function setRecording(on, s, c) {
    stateKnown = true;
    if (s) settings = s;
    if (c) counts = c;
    if (!on) { flushInput(); endSession(); }
    const starting = on && !recording;
    recording = !!on;
    if (!on) resetRecordingState(true);
    else if (starting) { resetRecordingState(false); scan(); } // 重置状态并记下所有字段的初始值
    lastScroll = { x: Math.round(window.scrollX), y: Math.round(window.scrollY) };
    hookState();
    if (recording) showUI(); else hideUI();
  }

  if (alive()) {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (sender.id !== chrome.runtime.id) return false;
      if (msg?.type === 'state') {
        stateVersion++;
        setRecording(msg.recording, msg.settings, msg.counts);
        sendResponse({ ok: true });
      }
      if (msg?.type === 'capture') { captureVersion++; setCapture(msg.on); sendResponse({ ok: true }); }
      // 后台准备停止录制（在弹窗里点的「停止」）：键入后还没提交的输入、没收尾的选择先交上去，送到了再回话
      if (msg?.type === 'flush') {
        if (recording) { flushInput(); endSession(); }
        lastSent.then(() => sendResponse({ ok: true }));
        return true;
      }
      return false;
    });
  }

  window.postMessage({ [TAG]: 'helloHook' }, '*');
  function hello() {
    const version = stateVersion;
    const captureAt = captureVersion;
    send({ type: 'hello', url: location.href, title: document.title }).then((res) => {
      if (!res) return;
      if (captureAt === captureVersion) setCapture(res.capture);
      if (version === stateVersion) setRecording(!!res.recording, res.settings, res.counts);
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
