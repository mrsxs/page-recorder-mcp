// 回放引擎（lib/runtime.js）里的面板选择：月份 / 年份 / 季度格子面板、周选择器、时间面板、虚拟滚动的下拉、按键码。
// 这些函数在 __pageRecorderRuntime 里面，靠只给测试用的 hooks.test 拿出来；页面是个够用的假 DOM，定时器换成假时钟（不真的等）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const runtimeSrc = readFileSync(join(root, 'lib', 'runtime.js'), 'utf8');
const plain = (x) => JSON.parse(JSON.stringify(x));

// ======================= 假 DOM =======================
// 选择器只认逗号分开的简单选择器：标签、*、[属性]、[属性=值]、[class*=片段]（可带 i）；不认后代选择器
function parseSel(sel) {
  return String(sel).split(',').map((raw) => {
    const s = raw.trim();
    const m = s.match(/^([a-z][a-z0-9-]*|\*)?((?:\[[^\]]+\])*)$/i);
    if (!m) return null;
    const attrs = [...m[2].matchAll(/\[([a-z-]+)(?:(\*?=)"?([^\]"]*?)"?(?:\s+i)?)?\]/gi)].map((a) => ({ name: a[1], op: a[2], val: a[3] }));
    return { tag: m[1] && m[1] !== '*' ? m[1].toUpperCase() : null, attrs };
  });
}
function matchOne(e, p) {
  if (!p || e.nodeType !== 1) return false;
  if (p.tag && e.tagName !== p.tag) return false;
  for (const a of p.attrs) {
    const v = e.getAttribute(a.name);
    if (v == null) return false;
    if (a.op === '=' && v !== a.val) return false;
    if (a.op === '*=' && !v.toLowerCase().includes(a.val.toLowerCase())) return false;
  }
  return true;
}
const matchSel = (e, sel) => parseSel(sel).some((p) => matchOne(e, p));

function makeDom() {
  const listeners = [];
  class Text {
    constructor(v) { this.nodeType = 3; this.nodeValue = String(v); this.parentNode = null; }
    get parentElement() { return this.parentNode; }
    get textContent() { return this.nodeValue; }
    set textContent(v) { this.nodeValue = String(v); }
  }
  class El {
    constructor(tag, props = {}) {
      this.nodeType = 1;
      this.tagName = tag.toUpperCase();
      this.childNodes = [];
      this.parentNode = null;
      this.attrs = {};
      this.className = '';
      this.id = '';
      this.on = {};
      this.style = {};
      this.disabled = false;
      this.rect = null; // 不给就跟着父元素
      this.pos = 'static';
      const { attrs, text, children } = props;
      const rest = Object.getOwnPropertyDescriptors(props); // 带 getter / setter 的（scrollTop）原样挂上，解构会读成死值
      delete rest.attrs; delete rest.text; delete rest.children;
      Object.assign(this.attrs, attrs || {});
      Object.defineProperties(this, rest);
      if (text != null) this.append(new Text(text));
      for (const c of children || []) this.append(c);
    }
    append(...cs) { for (const c of cs) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.childNodes.push(c); } return this; }
    appendChild(c) { this.append(c); return c; }
    removeChild(c) { this.childNodes = this.childNodes.filter((x) => x !== c); c.parentNode = null; return c; }
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
    get parentElement() { return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null; }
    get children() { return this.childNodes.filter((c) => c.nodeType === 1); }
    get childElementCount() { return this.children.length; }
    get firstElementChild() { return this.children[0] || null; }
    get lastElementChild() { const c = this.children; return c[c.length - 1] || null; }
    get textContent() { return this.childNodes.map((c) => c.textContent).join(''); }
    set textContent(v) { this.childNodes = []; this.append(new Text(v)); }
    get innerText() { return this.textContent; }
    get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return n === doc.documentElement; }
    get ownerDocument() { return doc; }
    get isContentEditable() { return false; }
    getAttribute(a) {
      if (a === 'class') return this.className || null;
      if (a === 'id') return this.id || null;
      if (a === 'disabled') return this.disabled ? '' : null;
      return a in this.attrs ? String(this.attrs[a]) : null;
    }
    hasAttribute(a) { return this.getAttribute(a) != null; }
    setAttribute(a, v) { if (a === 'class') this.className = String(v); else this.attrs[a] = String(v); }
    matches(sel) { return matchSel(this, sel); }
    closest(sel) { for (let n = this; n && n.nodeType === 1; n = n.parentNode) if (n.matches(sel)) return n; return null; }
    contains(o) { for (let n = o; n; n = n.parentNode) if (n === this) return true; return false; }
    descendants() { const out = []; const walk = (n) => { for (const c of n.children) { out.push(c); walk(c); } }; walk(this); return out; }
    querySelectorAll(sel) { const ps = parseSel(sel); return this.descendants().filter((e) => ps.some((p) => matchOne(e, p))); }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
    getBoundingClientRect() {
      let n = this;
      while (n && n.nodeType === 1 && !n.rect) n = n.parentNode;
      const r = (n && n.rect) || { left: 0, top: 0, width: 100, height: 20 };
      return { left: r.left, top: r.top, width: r.width, height: r.height, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top };
    }
    getClientRects() { return this.hidden ? [] : [{}]; }
    checkVisibility() { for (let n = this; n && n.nodeType === 1; n = n.parentNode) if (n.hidden) return false; return true; }
    dispatchEvent(ev) {
      ev.target = this;
      for (let n = this; n; n = n.parentNode) if (n.on && n.on[ev.type]) n.on[ev.type].call(n, ev);
      for (const [type, fn] of listeners) if (type === ev.type) fn(ev);
      return true;
    }
    click() { this.dispatchEvent({ type: 'click' }); }
    focus() { doc.activeElement = this; }
    blur() {}
    scrollIntoView() {}
    cloneNode() { return new El(this.tagName.toLowerCase(), { text: this.textContent }); }
  }
  const doc = {
    nodeType: 9, readyState: 'complete', activeElement: null, title: '测试页',
    addEventListener(type, fn) { listeners.push([type, fn]); }, removeEventListener() {},
    querySelectorAll: (sel) => [doc.documentElement, ...doc.documentElement.querySelectorAll(sel)].filter((e) => e.matches(sel)),
    querySelector: (sel) => doc.querySelectorAll(sel)[0] || null,
    getElementById: (id) => doc.documentElement.descendants().find((e) => e.id === id) || null,
    elementFromPoint: () => null,
    createElement: (tag) => new El(tag),
    createTreeWalker(rootEl) {
      const texts = [];
      const walk = (n) => { for (const c of n.childNodes) { if (c.nodeType === 3) texts.push(c); else walk(c); } };
      walk(rootEl);
      let i = 0;
      return { nextNode: () => texts[i++] || null };
    },
  };
  doc.documentElement = new El('html');
  doc.body = new El('body');
  doc.documentElement.append(doc.body);
  const h = (tag, props, ...children) => {
    const p = Object.defineProperties({}, Object.getOwnPropertyDescriptors(props || {})); // 不能 Object.assign：会把 getter 读成死值
    p.children = [...((props && props.children) || []), ...children.flat()];
    return new El(tag, p);
  };
  return { doc, El, Text, h };
}

// 假时钟：sleep / 等待循环都按它走，定时器到点就跑，不真的等
function loadRuntime(dom) {
  let clock = 1_700_000_000_000;
  class FakeDate extends Date {
    constructor(...a) { if (a.length) super(...a); else super(clock); }
    static now() { return clock; }
  }
  const timers = [];
  let tid = 0;
  const win = {
    document: dom.doc, location: { href: 'https://app.test/form', origin: 'https://app.test' },
    innerWidth: 1280, innerHeight: 800, scrollX: 0, scrollY: 0,
    addEventListener() {}, removeEventListener() {}, postMessage() {},
    Date: FakeDate,
    setTimeout(fn, ms) { const id = ++tid; timers.push(id); setImmediate(() => { if (!timers.includes(id)) return; timers.splice(timers.indexOf(id), 1); clock += Math.max(0, ms || 0); fn(); }); return id; },
    clearTimeout(id) { const i = timers.indexOf(id); if (i >= 0) timers.splice(i, 1); },
    setInterval: () => 0, clearInterval() {},
    getComputedStyle: (n) => ({ position: n.pos || 'static', overflowY: n.overflowY || 'visible', visibility: 'visible', cursor: 'auto', display: 'block' }),
    PointerEvent: class { constructor(type, o) { Object.assign(this, o, { type }); } },
    MouseEvent: class { constructor(type, o) { Object.assign(this, o, { type }); } },
    KeyboardEvent: class { constructor(type, o) { Object.assign(this, o, { type }); } },
    InputEvent: class { constructor(type, o) { Object.assign(this, o, { type }); } },
    Event: class { constructor(type, o) { Object.assign(this, o, { type }); } },
    NodeFilter: { SHOW_TEXT: 4 },
    HTMLInputElement: { prototype: {} }, HTMLTextAreaElement: { prototype: {} }, HTMLSelectElement: { prototype: {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    URL, URLSearchParams, Headers,
    console: { log() {}, warn() {}, error() {} },
  };
  win.window = win; win.self = win; win.top = win;
  vm.runInContext(runtimeSrc, vm.createContext(win));
  let fns = null;
  const ready = win.__pageRecorderRuntime({ steps: [], apis: [] }, {}, {}, { autoRun: false, verbose: false, rewriteRequests: false, netLog: false, expose: false, highlight: false }, { test: (x) => { fns = x; } });
  return { fns: () => fns, ready, win };
}
async function runtimeFor(dom) {
  const r = loadRuntime(dom);
  await r.ready;
  return r.fns();
}

// 一个绝对定位的弹层（overlay），挨着输入框下方
const input = (dom, props = {}) => dom.h('input', Object.assign({ value: '', rect: { left: 100, top: 100, width: 200, height: 30 } }, props));
const popup = (dom, props, ...children) => dom.h('div', Object.assign({ pos: 'absolute', className: 'picker-dropdown', rect: { left: 100, top: 132, width: 280, height: 260 } }, props), ...children);

// ======================= 纯函数 =======================

test('partialDate：月、年、季、周、时间的各种写法；周数按这一年的 ISO 周数核对（2026 有第 53 周，2027 没有）', async () => {
  const f = await runtimeFor(makeDom());
  const cases = [
    ['2026-09', { kind: 'month', y: 2026, m: 9 }],
    ['2026/9', { kind: 'month', y: 2026, m: 9 }],
    ['2026年09月', { kind: 'month', y: 2026, m: 9 }],
    ['09/2026', { kind: 'month', y: 2026, m: 9 }],
    ['2026-13', null],
    ['2026', { kind: 'year', y: 2026 }],
    ['2026年', { kind: 'year', y: 2026 }],
    ['1800', null],
    ['2026-Q3', { kind: 'quarter', y: 2026, q: 3 }],
    ['2026年第三季度', { kind: 'quarter', y: 2026, q: 3 }],
    ['2026-W45', { kind: 'week', y: 2026, w: 45 }],
    ['2026-45周', { kind: 'week', y: 2026, w: 45 }],
    ['2026-W53', { kind: 'week', y: 2026, w: 53 }],
    ['2027-W53', null],
    ['2027-W52', { kind: 'week', y: 2027, w: 52 }],
    ['2020-W53', { kind: 'week', y: 2020, w: 53 }],
    ['2026-W0', null],
    ['08:30', { kind: 'time', H: 8, i: 30, s: null }],
    ['8:30:15', { kind: 'time', H: 8, i: 30, s: 15 }],
    ['24:00', null],
    ['08:60', null],
    ['shoes', null],
  ];
  for (const [v, want] of cases) assert.deepEqual(plain(f.partialDate(v)), want, v);
  assert.deepEqual([2015, 2020, 2025, 2026, 2027, 2032].map(f.isoWeeks), [53, 53, 52, 53, 52, 53]);
});

test('samePartial / shownWeek：框里显示的写法和参数不一样也认', async () => {
  const f = await runtimeFor(makeDom());
  const yes = [['2026-9', '2026-09'], ['2026年09月', '2026-09'], ['2026', '2026'], ['2026年 第3季度', '2026-Q3'], ['2026 Q3', '2026-Q3'],
    ['2026-45周', '2026-W45'], ['2026 W45', '2026-W45'], ['08:30:00', '08:30'], ['下午 2:05', '14:05']];
  for (const [shown, v] of yes) assert.equal(f.samePartial(shown, f.partialDate(v)), true, `${shown} ↔ ${v}`);
  const no = [['2026-10', '2026-09'], ['2025', '2026'], ['2026-Q2', '2026-Q3'], ['2026-W44', '2026-W45'], ['08:31', '08:30'], ['', '2026']];
  for (const [shown, v] of no) assert.equal(f.samePartial(shown, f.partialDate(v)), false, `${shown} ↔ ${v}`);
  assert.deepEqual(plain(f.shownWeek('2026年 第45周')), { y: 2026, w: 45 });
  assert.equal(f.shownWeek('2026-11-05'), null);
});

test('keyInfo：Shift 符号按它所在的键算 keyCode 和 code（美式键盘）', async () => {
  const f = await runtimeFor(makeDom());
  const cases = { '!': [49, 'Digit1'], '@': [50, 'Digit2'], ')': [48, 'Digit0'], '?': [191, 'Slash'], _: [189, 'Minus'], '+': [187, 'Equal'], '{': [219, 'BracketLeft'],
    '|': [220, 'Backslash'], '~': [192, 'Backquote'], ':': [186, 'Semicolon'], '"': [222, 'Quote'], '<': [188, 'Comma'], '>': [190, 'Period'],
    a: [65, 'KeyA'], Z: [90, 'KeyZ'], 7: [55, 'Digit7'], Enter: [13, 'Enter'], ' ': [32, 'Space'], F2: [113, 'F2'], ArrowDown: [40, 'ArrowDown'] };
  for (const [k, want] of Object.entries(cases)) assert.deepEqual(plain(f.keyInfo(k)), want, k);
});

// ======================= 月份 / 年份 / 季度面板 =======================

// 月份面板：头上是年份和前后翻年的按钮，下面 12 格。点格子把值写进框里
function monthPanel(dom, box, year, { left = 100, top = 132, id } = {}) {
  const state = { year };
  const title = dom.h('span', { className: 'picker-header-view', text: `${year}年` });
  const prev = dom.h('button', { className: 'picker-header-super-prev-btn', text: '«', rect: { left: left + 4, top, width: 20, height: 20 } });
  const next = dom.h('button', { className: 'picker-header-super-next-btn', text: '»', rect: { left: left + 250, top, width: 20, height: 20 } });
  const cells = Array.from({ length: 12 }, (_, i) => dom.h('td', { className: 'picker-cell', text: `${i + 1}月` }));
  const grid = dom.h('table', { rect: { left, top: top + 30, width: 280, height: 200 } }, dom.h('tbody', {}, cells));
  const root = popup(dom, { rect: { left, top, width: 280, height: 240 }, id }, dom.h('div', { className: 'picker-header', rect: { left, top, width: 280, height: 24 } }, prev, title, next), grid);
  const setYear = (y) => { state.year = y; title.textContent = `${y}年`; };
  prev.on.click = () => setYear(state.year - 1);
  next.on.click = () => setYear(state.year + 1);
  cells.forEach((c, i) => { c.on.click = () => { box.value = `${state.year}-${String(i + 1).padStart(2, '0')}`; }; });
  return { root, state, prev, next, cells };
}

test('pickUnit：月份面板翻到目标年份、点对应的格子；往前翻也行；翻不动时返回 false', async () => {
  const dom = makeDom();
  const box = input(dom);
  const p = monthPanel(dom, box, 2026);
  dom.doc.body.append(box, p.root);
  const f = await runtimeFor(dom);
  const s = { desc: '月份' };
  assert.equal(await f.pickUnit(box, f.partialDate('2028-03'), s), true);
  assert.equal(box.value, '2028-03');
  assert.equal(p.state.year, 2028);
  assert.equal(await f.pickUnit(box, f.partialDate('2025-11'), s), true);
  assert.equal(box.value, '2025-11');

  // 翻页按钮点了没反应：不死等，返回 false
  p.next.on.click = () => {};
  assert.equal(await f.pickUnit(box, f.partialDate('2030-01'), s), false);
  assert.equal(box.value, '2025-11');
});

test('pickUnit：没有格子面板（普通下拉）时什么都不点，返回 false', async () => {
  const dom = makeDom();
  const box = input(dom);
  const list = popup(dom, {}, dom.h('ul', {}, ['2026-09', '2026-10'].map((t) => dom.h('li', { text: t }))));
  dom.doc.body.append(box, list);
  const f = await runtimeFor(dom);
  assert.equal(await f.pickUnit(box, f.partialDate('2026-09'), { desc: '月份' }), false);
  assert.equal(box.value, '');
});

test('pickUnit：年份面板（一个十年）翻到目标那十年再点；季度面板四格', async () => {
  const dom = makeDom();
  const box = input(dom);
  const state = { from: 2020 };
  const cells = Array.from({ length: 10 }, () => dom.h('td', { text: '' }));
  const draw = () => cells.forEach((c, i) => { c.textContent = String(state.from + i); });
  draw();
  const prev = dom.h('button', { className: 'picker-header-super-prev-btn', text: '«', rect: { left: 104, top: 132, width: 20, height: 20 } });
  const next = dom.h('button', { className: 'picker-header-super-next-btn', text: '»', rect: { left: 350, top: 132, width: 20, height: 20 } });
  prev.on.click = () => { state.from -= 10; draw(); };
  next.on.click = () => { state.from += 10; draw(); };
  cells.forEach((c) => { c.on.click = () => { box.value = c.textContent; }; });
  dom.doc.body.append(box, popup(dom, {}, prev, next, dom.h('table', { rect: { left: 100, top: 160, width: 280, height: 200 } }, cells)));
  const f = await runtimeFor(dom);
  assert.equal(await f.pickUnit(box, f.partialDate('2047'), { desc: '年份' }), true);
  assert.equal(box.value, '2047');
  assert.equal(state.from, 2040);

  const dom2 = makeDom();
  const box2 = input(dom2);
  const qs = ['Q1', 'Q2', 'Q3', 'Q4'].map((t) => dom2.h('td', { text: t }));
  qs.forEach((c) => { c.on.click = () => { box2.value = `2026-${c.textContent}`; }; });
  dom2.doc.body.append(box2, popup(dom2, {}, dom2.h('div', { text: '2026' }), dom2.h('table', { rect: { left: 100, top: 160, width: 280, height: 60 } }, qs)));
  const f2 = await runtimeFor(dom2);
  assert.equal(await f2.pickUnit(box2, f2.partialDate('2026-Q3'), { desc: '季度' }), true);
  assert.equal(box2.value, '2026-Q3');
});

// ======================= 周选择器 =======================

// 按天的日历：头上“2026年11月”，下面这个月的 1～31，点一天把那天所在的 ISO 周写进框里、弹层关掉；再点框重新弹出一个
function weekCalendar(dom, box, y, m, { shift = 0 } = {}) {
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const isoWeek = (d) => {
    const t = new Date(Date.UTC(y, m - 1, d));
    const thu = new Date(t.getTime() + (3 - ((t.getUTCDay() + 6) % 7)) * 86400000);
    return { y: thu.getUTCFullYear(), w: Math.ceil(((thu - Date.UTC(thu.getUTCFullYear(), 0, 1)) / 86400000 + 1) / 7) };
  };
  const clicked = [];
  const make = () => {
    const cells = Array.from({ length: days }, (_, i) => dom.h('td', { text: String(i + 1) }));
    const grid = dom.h('table', { rect: { left: 100, top: 160, width: 280, height: 200 } }, dom.h('tbody', {}, cells));
    const root = popup(dom, {}, dom.h('div', { className: 'picker-header', text: `${y}年${m}月`, rect: { left: 100, top: 132, width: 280, height: 24 } }), grid);
    cells.forEach((c, i) => {
      c.on.click = () => { clicked.push(i + 1); const w = isoWeek(i + 1); box.value = `${w.y}-W${String(w.w + shift).padStart(2, '0')}`; root.remove(); };
    });
    return root;
  };
  const cal = { root: make(), clicked };
  box.on.click = () => { if (!cal.root.isConnected) { cal.root = make(); dom.doc.body.append(cal.root); } };
  return cal;
}

test('pickWeek：点目标那一周的周四；页面的周编号差一周时按差的周数挪一次再点', async () => {
  const dom = makeDom();
  const box = input(dom);
  const cal = weekCalendar(dom, box, 2026, 11);
  dom.doc.body.append(box, cal.root);
  const f = await runtimeFor(dom);
  assert.equal(await f.pickWeek(box, '2026-W46', { desc: '周' }, f.partialDate('2026-W46')), true);
  assert.deepEqual(cal.clicked, [12], '2026 年第 46 周的周四是 11 月 12 日');
  assert.equal(box.value, '2026-W46');

  // 页面的周编号比 ISO 大一（周日开头等算法）：先点 12 日得到 W47，挪回一周点 5 日
  const dom2 = makeDom();
  const box2 = input(dom2);
  const cal2 = weekCalendar(dom2, box2, 2026, 11, { shift: 1 });
  dom2.doc.body.append(box2, cal2.root);
  const f2 = await runtimeFor(dom2);
  assert.equal(await f2.pickWeek(box2, '2026-W46', { desc: '周' }, f2.partialDate('2026-W46')), true);
  assert.deepEqual(cal2.clicked, [12, 5]);
  assert.equal(box2.value, '2026-W46');
});

test('pickWeek：弹层里没有日历（普通下拉）返回 false，什么都不点', async () => {
  const dom = makeDom();
  const box = input(dom);
  dom.doc.body.append(box, popup(dom, {}, dom.h('ul', {}, dom.h('li', { text: '2026-W46' }))));
  const f = await runtimeFor(dom);
  assert.equal(await f.pickWeek(box, '2026-W46', { desc: '周' }, f.partialDate('2026-W46')), false);
});

// ======================= 时间面板 =======================

// 并排的几列，每列竖着排：left 是这一列的横坐标
function timePanel(dom, box, cols) {
  const picked = [];
  const ul = (vals, left) => dom.h('ul', { rect: { left, top: 132, width: 50, height: 200 } }, vals.map((v) => {
    const li = dom.h('li', { text: String(v).padStart(2, '0') });
    li.on.click = () => picked.push(v);
    return li;
  }));
  const ok = dom.h('button', { text: '确定' });
  const root = popup(dom, { className: 'time-picker-panel' }, cols.map((vals, k) => ul(vals, 100 + k * 60)), ok);
  ok.on.click = () => { box.value = picked.map((v) => String(v).padStart(2, '0')).join(':'); };
  return { root, picked };
}
const range = (n, step = 1) => Array.from({ length: Math.ceil(n / step) }, (_, i) => i * step);

test('时间面板：时、分两列按列点中再点确定；15 分钟一档的分钟列也认；参数不在档上时报清楚', async () => {
  const dom = makeDom();
  const box = input(dom);
  const tp = timePanel(dom, box, [range(24), range(60)]);
  dom.doc.body.append(box, tp.root);
  const f = await runtimeFor(dom);
  const cols = f.timeColumns(box);
  assert.equal(cols.cols.length, 2);
  assert.equal(await f.pickTimePanel(box, f.partialDate('08:35'), { desc: '时间' }), true);
  assert.deepEqual(tp.picked, [8, 35]);
  assert.equal(box.value, '08:35');

  for (const step of [5, 10, 15]) {
    const d = makeDom();
    const b = input(d);
    const p = timePanel(d, b, [range(24), range(60, step)]);
    d.doc.body.append(b, p.root);
    const g = await runtimeFor(d);
    assert.ok(g.timeColumns(b), `${step} 分钟一档`);
    assert.equal(await g.pickTimePanel(b, g.partialDate('14:30'), { desc: '时间' }), true);
    assert.deepEqual(p.picked, [14, 30]);
  }
  const d = makeDom();
  const b = input(d);
  d.doc.body.append(b, timePanel(d, b, [range(24), range(60, 15)]).root);
  const g = await runtimeFor(d);
  await assert.rejects(g.pickTimePanel(b, g.partialDate('14:20'), { desc: '时间' }), /第 2 列里没有 20/);
});

test('时间面板：不是从 0 起、不等差、不到 4 格、只有一列的数字列表不当时间面板', async () => {
  for (const cols of [[range(24)], [range(24).map((v) => v + 1), range(60)], [range(24), [0, 10, 15, 30, 45]], [range(24), [0, 30]], [range(12), range(60)]]) {
    const d = makeDom();
    const b = input(d);
    d.doc.body.append(b, timePanel(d, b, cols).root);
    const g = await runtimeFor(d);
    assert.equal(g.timeColumns(b), null, JSON.stringify(cols.map((c) => c.slice(0, 5))));
  }
});

// ======================= 虚拟滚动的下拉 =======================

test('scrollToOption：只渲染看得见那几行的列表，滚过去才有后面的选项', async () => {
  const dom = makeDom();
  const box = input(dom, { attrs: { 'aria-controls': 'list1' } });
  const all = Array.from({ length: 200 }, (_, i) => `城市 ${i + 1}`);
  const list = dom.h('ul', { attrs: { role: 'listbox' }, rect: { left: 100, top: 132, width: 200, height: 200 } });
  const ROW = 20;
  let top = 0;
  const draw = () => {
    list.childNodes = [];
    const first = Math.floor(top / ROW);
    for (let i = first; i < Math.min(all.length, first + 12); i++) list.append(dom.h('li', { attrs: { role: 'option' }, text: all[i], rect: { left: 100, top: 132 + (i - first) * ROW, width: 200, height: ROW } }));
  };
  const scroller = dom.h('div', {
    id: 'list1', pos: 'absolute', className: 'select-dropdown', overflowY: 'auto', rect: { left: 100, top: 132, width: 200, height: 200 },
    clientHeight: 200, scrollHeight: all.length * ROW,
    get scrollTop() { return top; },
    set scrollTop(v) { top = Math.max(0, Math.min(v, all.length * ROW - 200)); draw(); },
  }, list);
  draw();
  dom.doc.body.append(box, scroller);
  const f = await runtimeFor(dom);
  const o = await f.scrollToOption(box, '城市 150', new Set());
  assert.ok(o, '滚到了');
  assert.equal(o.textContent, '城市 150');
  assert.equal(await f.scrollToOption(box, '城市 999', new Set()), null, '没有的选项滚到底返回 null');
});
