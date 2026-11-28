// 录制端（content/recorder.js）的行为：在一个够用的假页面里加载它，派发事件，看它发给后台什么
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const recorderSrc = readFileSync(join(root, 'content', 'recorder.js'), 'utf8');

// 够 recorder.js 用的假页面：元素只有标签、属性、值，选择器只认「标签」「[属性]」「:not([type=x])」
function page() {
  const messages = []; // 发给后台的消息
  const listeners = new Map(); // document 上的事件监听
  const timers = [];
  const all = []; // 页面上的元素
  let onMessage = null;

  const matchSel = (e, sel) => String(sel).split(',').some((raw) => {
    const m = raw.trim().match(/^([a-z0-9-]+)?(.*)$/i);
    if (!m[1] && !m[2]) return false;
    if (m[1] && m[1].toUpperCase() !== e.tagName) return false;
    for (const n of m[2].matchAll(/:not\(\[type=([a-z]+)\]\)/g)) if ((e.type || '') === n[1]) return false;
    const rest = m[2].replace(/:not\([^)]*\)/g, '');
    if (/^[#.]/.test(rest)) return false; // id、类名选择器：这里的元素都不靠它们认
    for (const a of rest.matchAll(/\[([a-z-]+)(?:=("?)([^\]"]*)\2)?\]/gi)) {
      const v = e.getAttribute(a[1]);
      if (v == null || (a[3] && v !== a[3])) return false;
    }
    return true;
  });
  const doc = {
    title: '测试页', readyState: 'complete', activeElement: null,
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn); },
    removeEventListener() {},
    dispatchEvent() { return true; },
    querySelectorAll: (sel) => all.filter((e) => matchSel(e, sel)),
    querySelector: (sel) => all.find((e) => matchSel(e, sel)) || null,
    getElementById: (id) => all.find((e) => e.id === id) || null,
    elementFromPoint: () => null,
  };
  function el(tag, props = {}) {
    const { attrs = {}, ...rest } = props;
    const e = {
      nodeType: 1, tagName: tag.toUpperCase(), isConnected: true, children: [], childNodes: [], classList: [], className: '', id: '', name: '',
      type: tag === 'input' ? 'text' : tag === 'textarea' ? 'textarea' : undefined, value: '', textContent: '', innerText: '',
      parentElement: null, parentNode: null, ownerDocument: doc, labels: [], style: {}, clientWidth: 0, clientHeight: 0,
      getAttribute: (a) => (a in attrs ? attrs[a] : a === 'type' && e.type && /^(INPUT|BUTTON)$/.test(e.tagName) ? e.type : a === 'name' && e.name ? e.name : a === 'id' && e.id ? e.id : null),
      hasAttribute: (a) => e.getAttribute(a) != null,
      setAttribute(a, v) { attrs[a] = String(v); },
      matches: (sel) => matchSel(e, sel),
      closest: (sel) => (matchSel(e, sel) ? e : null),
      contains: (o) => o === e,
      querySelector: () => null, querySelectorAll: () => [], getElementsByTagName: () => [],
      getRootNode: () => doc,
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20 }),
      getClientRects: () => [{}], checkVisibility: () => true,
      addEventListener() {}, removeEventListener() {}, appendChild() {}, remove() {},
      attachShadow: () => ({ set innerHTML(v) {}, querySelector: () => el('span') }),
      ...rest,
    };
    return e;
  }
  const add = (tag, props) => { const e = el(tag, props); all.push(e); return e; };
  doc.documentElement = el('html');
  doc.body = el('body');
  doc.createElement = (tag) => el(tag);

  const env = {
    location: { href: 'https://app.test/form' },
    document: doc,
    chrome: {
      runtime: {
        id: 'ext', getManifest: () => ({ version: 'test' }),
        onMessage: { addListener(fn) { onMessage = fn; } },
        sendMessage(msg) {
          if (msg.type !== 'hello') messages.push(JSON.parse(JSON.stringify(msg)));
          if (msg.type === 'stop') return new Promise(() => {}); // 后台要停完才回 stop
          return Promise.resolve(msg.type === 'hello' ? null : { counts: { steps: 0, requests: 0 } });
        },
      },
      // closed 的 Shadow DOM 只有扩展专用接口拿得到
      dom: { openOrClosedShadowRoot: (e) => e.closedRoot || null },
    },
    setTimeout(fn, ms) { timers.push({ fn, ms }); return timers.length; },
    clearTimeout(id) { if (timers[id - 1]) timers[id - 1].fn = null; },
    setInterval: () => 0, clearInterval() {},
    getComputedStyle: () => ({ cursor: 'auto', position: 'static', visibility: 'visible' }),
    MutationObserver: class { observe() {} disconnect() {} },
    MessageChannel: class { constructor() { this.port1 = { postMessage() {} }; this.port2 = {}; } },
    CSS: { escape: (s) => String(s) },
    Event: class { constructor(type) { this.type = type; } },
    NodeFilter: { SHOW_TEXT: 4 },
    innerWidth: 1280, innerHeight: 800, scrollX: 0, scrollY: 0,
    addEventListener() {}, removeEventListener() {}, postMessage() {},
    getSelection: () => '',
    console,
  };
  const ctx = vm.createContext(env);
  const window = vm.runInContext('globalThis', ctx);
  window.window = window.top = window.parent = window;
  vm.runInContext(recorderSrc, ctx);

  const fire = (type, target, extra = {}) => {
    const ev = { type, isTrusted: true, target, composedPath: () => [target], clientX: 0, clientY: 0, offsetX: 0, offsetY: 0, button: 0, preventDefault() {}, stopImmediatePropagation() {}, stopPropagation() {}, ...extra };
    for (const fn of listeners.get(type) || []) fn(ev);
  };
  // 把到点的定时器跑掉（扫描字段、提交输入都靠它）；跑的过程中新加的留到下一次
  const runTimers = () => { for (const t of timers.splice(0)) if (t.fn) t.fn(); };
  const tell = (msg) => new Promise((resolve) => {
    const kept = onMessage(msg, { id: 'ext' }, resolve);
    if (!kept) resolve(undefined);
  });
  const start = async (settings = {}) => { await tell({ type: 'state', recording: true, settings, counts: { steps: 0, requests: 0 } }); runTimers(); };
  const steps = () => messages.filter((m) => m.type === 'event' && m.event.kind === 'step').map((m) => m.event);
  // 键入：改值、派发 input，再派发 change 让它提交
  const type = (target, value, { commit = true, before = true } = {}) => {
    if (before) fire('beforeinput', target);
    target.value = value;
    fire('input', target);
    if (commit) fire('change', target);
  };
  return { add, doc, fire, runTimers, tell, start, steps, messages, type, env };
}

test('录制：先点「显示密码」再键入，密码不进步骤（见到是密码框就记下，之后 type 变了也按密码处理）', async () => {
  const p = page();
  const pw = p.add('input', { type: 'password', id: 'f1' });
  await p.start(); // 开始录制时扫一遍字段，这时它还是密码框
  pw.type = 'text'; // 用户点了小眼睛
  p.type(pw, 'hunter2-secret');
  const fill = p.steps().find((s) => s.type === 'fill');
  assert.ok(fill, '键入要录成一步');
  assert.equal(fill.value, '');
  assert.equal(fill.sensitive, true);
  // 明文只走 secret 消息（后台只放内存，用来把请求里的同一个值换成占位符）
  assert.deepEqual([...new Set(p.messages.filter((m) => JSON.stringify(m).includes('hunter2-secret')).map((m) => m.type))], ['secret']);

  // 开始录制之后才出现的密码框（登录弹窗）：点小眼睛那一下（按下鼠标时）先扫到它
  const late = p.add('input', { type: 'password', id: 'f2' });
  const eye = p.add('span');
  p.fire('pointerdown', eye);
  late.type = 'text';
  p.type(late, 'late-secret-9');
  const fills = p.steps().filter((s) => s.type === 'fill');
  assert.equal(fills.length, 2);
  assert.equal(fills[1].value, '');
  assert.equal(JSON.stringify(p.steps()).includes('late-secret-9'), false);
});

test('录制：名字里带 password / pwd 的输入框按密码处理；passport、shipping_option、pin_code、名字带 password 的复选框不算', async () => {
  for (const name of ['loginPwd', 'user_password', 'confirmPassword', 'pass', 'smsOtp', 'card_cvv', 'client_secret', 'PIN', 'verifyCode', 'verification_code']) {
    const p = page();
    const f = p.add('input', { name });
    await p.start();
    p.type(f, 'value-123');
    const fill = p.steps().find((s) => s.type === 'fill');
    assert.equal(fill.sensitive, true, name);
    assert.equal(fill.value, '', name);
  }
  for (const name of ['passport_no', 'shipping_option', 'pin_code', 'pincode', 'compass', 'bypassReason', 'secretary', 'topic', 'username']) {
    const p = page();
    const f = p.add('input', { name });
    await p.start();
    p.type(f, 'value-123');
    const fill = p.steps().find((s) => s.type === 'fill');
    assert.equal(fill.sensitive, undefined, name);
    assert.equal(fill.value, 'value-123', name);
  }
  // id 也看（name 是没意义的 field_3）
  const p = page();
  const f = p.add('input', { name: 'field_3', id: 'userPwd' });
  await p.start();
  p.type(f, 'value-123');
  assert.equal(p.steps().find((s) => s.type === 'fill').sensitive, true);
  // 关了脱敏：值照常录，但标出是密码框
  const q = page();
  const g = q.add('input', { name: 'loginPwd' });
  await q.start({ maskPasswords: false });
  q.type(g, 'value-123');
  const fill = q.steps().find((s) => s.type === 'fill');
  assert.equal(fill.value, 'value-123');
  assert.equal(fill.secretInput, true);
});

test('录制：输入框被页面清空后再键入同样的内容，第二次也录（聊天框、扫码框回车后清空）', async () => {
  // 可编辑区域、空白 iframe 里的框不在字段扫描里：靠键入前的 beforeinput 发现值已经变了
  let p = page();
  let box = p.add('textarea', { id: 'chat' });
  await p.start();
  p.type(box, '你好', { commit: false });
  p.fire('keydown', box, { key: 'Enter' });
  box.value = ''; // 页面发送后清空
  p.type(box, '你好', { commit: false });
  p.fire('keydown', box, { key: 'Enter' });
  assert.deepEqual(p.steps().map((s) => (s.type === 'fill' ? `fill:${s.value}` : `${s.type}:${s.key}`)), ['fill:你好', 'press:Enter', 'fill:你好', 'press:Enter']);

  // 没有 beforeinput 的情况（比如脚本触发的键入）：靠操作之后的字段扫描发现被清空了
  p = page();
  box = p.add('input', { id: 'scan' });
  await p.start();
  p.type(box, 'SKU-1', { commit: false, before: false });
  p.fire('keydown', box, { key: 'Enter' });
  box.value = '';
  p.runTimers(); // 回车之后的几次扫描
  p.type(box, 'SKU-1', { commit: false, before: false });
  p.fire('keydown', box, { key: 'Enter' });
  assert.equal(p.steps().filter((s) => s.type === 'fill').length, 2);

  // 值没被清空：改来改去最后还是原来的值，不多录一步
  p = page();
  box = p.add('input', { id: 'same' });
  await p.start();
  p.type(box, 'abc');
  p.type(box, 'abcd', { commit: false });
  p.type(box, 'abc');
  assert.equal(p.steps().filter((s) => s.type === 'fill').length, 1);
});

test('录制：拖动没放成功之后，从桌面拖文件进来录成上传，不是“拖动刚才那个元素”', async () => {
  const files = { files: [{ name: '发票.pdf' }], types: ['Files'] };
  // 拖到不能放的地方：没有 drop，只有 dragend
  let p = page();
  let card = p.add('div', { attrs: { draggable: 'true' } });
  let zone = p.add('div', { attrs: { 'data-testid': 'dropzone' } });
  await p.start();
  p.fire('dragstart', card);
  p.fire('dragend', card);
  p.fire('drop', zone, { dataTransfer: files });
  assert.deepEqual(p.steps().map((s) => [s.type, s.files]), [['upload', ['发票.pdf']]]);
  assert.equal(p.steps()[0].drop, true);

  // 拖动的起点被页面移走、连 dragend 都没有：只带着文件的 drop 还是按上传录
  p = page();
  card = p.add('div', { attrs: { draggable: 'true' } });
  zone = p.add('div', { attrs: { 'data-testid': 'dropzone' } });
  await p.start();
  p.fire('dragstart', card);
  p.fire('drop', zone, { dataTransfer: files });
  assert.deepEqual(p.steps().map((s) => s.type), ['upload']);

  // 页面里拖一张图片到另一个位置：也带着文件，但同时有 text/html，照旧录成拖动
  p = page();
  card = p.add('img', { attrs: { draggable: 'true' } });
  zone = p.add('div', { attrs: { 'data-testid': 'dropzone' } });
  await p.start();
  p.fire('dragstart', card);
  p.fire('drop', zone, { dataTransfer: { files: [{ name: 'a.png' }], types: ['text/uri-list', 'text/html', 'Files'] } });
  assert.deepEqual(p.steps().map((s) => [s.type, s.html5]), [['drag', true]]);
});

test('录制：不在打字时按的空格、单个字符、功能键录成按键；打字时的、按钮上的空格、F5 / F12 不录', async () => {
  const p = page();
  const input = p.add('input', { id: 'q' });
  const button = p.add('button');
  const grid = p.add('div', { attrs: { tabindex: '0', role: 'grid' } });
  const select = p.add('select', { selectedOptions: [], options: [] });
  await p.start();
  const keys = () => p.steps().filter((s) => s.type === 'press').map((s) => s.key);
  p.fire('keydown', p.doc.body, { key: ' ' }); // 播放 / 暂停
  p.fire('keydown', grid, { key: 'j' }); // 下一条
  p.fire('keydown', grid, { key: '/' });
  p.fire('keydown', grid, { key: 'F2' });
  p.fire('keydown', input, { key: 'F9' }); // 功能键在输入框里也是快捷键
  assert.deepEqual(keys(), [' ', 'j', '/', 'F2', 'F9']);
  p.fire('keydown', input, { key: 'j' }); // 打字
  p.fire('keydown', input, { key: ' ' });
  p.fire('keydown', button, { key: ' ' }); // 浏览器会接着发 click，那一下已经录了
  p.fire('keydown', select, { key: 'c' }); // 按首字母选项，由 change 录
  p.fire('keydown', grid, { key: 'F5' });
  p.fire('keydown', grid, { key: 'F12' });
  p.fire('keydown', grid, { key: 'a', isComposing: true }); // 输入法组字
  assert.deepEqual(keys(), [' ', 'j', '/', 'F2', 'F9']);
  p.fire('keydown', button, { key: 'j' }); // 焦点在按钮上按的快捷键照样录
  assert.deepEqual(keys().slice(-1), ['j']);
});

test('录制：后台要停止前发来 flush，键入后还没提交的输入先交上去，送到了才回话', async () => {
  const p = page();
  const f = p.add('input', { id: 'kw' });
  await p.start();
  p.type(f, '最后一次输入', { commit: false }); // 还在等 1.5 秒的合并，没提交
  assert.equal(p.steps().length, 0);
  const res = await p.tell({ type: 'flush' });
  assert.equal(JSON.stringify(res), '{"ok":true}'); // 另一个 vm 里的对象，按内容比
  assert.deepEqual(p.steps().map((s) => [s.type, s.value]), [['fill', '最后一次输入']]);
});

test('录制：单个字符当快捷键录之前先确认不是在输入密码——closed Shadow DOM 里的输入框、像密码键盘的地方、按住不放的重复都不录', async () => {
  const p = page();
  // 组件把密码框放在 closed Shadow DOM 里：键盘事件的目标只到宿主，看不出是在打字
  const inner = p.add('input', { type: 'password' });
  const host = p.add('x-password', { closedRoot: { activeElement: inner } });
  const pad = p.add('div', { className: 'pin-pad', attrs: { tabindex: '0' } }); // 自己画的 PIN 键盘
  const label = p.add('div', { attrs: { tabindex: '0', 'aria-label': '请输入支付密码' } });
  const grid = p.add('div', { attrs: { tabindex: '0', role: 'grid' } });
  const spin = p.add('div', { className: 'ant-spin shipping-list', attrs: { tabindex: '0' } }); // 名字里只是带着 pin 这三个字母
  await p.start();
  const keys = () => p.steps().filter((s) => s.type === 'press').map((s) => s.key);
  for (const k of 'Secret1') p.fire('keydown', host, { key: k });
  for (const k of '4821') p.fire('keydown', pad, { key: k });
  for (const k of '4821') p.fire('keydown', label, { key: k });
  p.fire('keydown', host, { key: ' ' });
  assert.deepEqual(keys(), [], JSON.stringify(p.steps()));
  p.fire('keydown', grid, { key: 'j' });
  p.fire('keydown', grid, { key: 'j', repeat: true }); // 按住不放
  p.fire('keydown', grid, { key: 'j', repeat: true });
  p.fire('keydown', spin, { key: 'k' });
  assert.deepEqual(keys(), ['j', 'k']);
  // 这些地方的回车、功能键照常录（不是内容）
  p.fire('keydown', host, { key: 'Enter' });
  p.fire('keydown', pad, { key: 'F2' });
  assert.deepEqual(keys(), ['j', 'k', 'Enter', 'F2']);

  // 旧浏览器没有那个接口：自定义元素里面看不到，单个字符一律不录
  const q = page();
  delete q.env.chrome.dom;
  const blind = q.add('x-input');
  const plain = q.add('div', { attrs: { tabindex: '0' } });
  await q.start();
  q.fire('keydown', blind, { key: 'a' });
  q.fire('keydown', plain, { key: 'b' });
  assert.deepEqual(q.steps().filter((s) => s.type === 'press').map((s) => s.key), ['b']);
});

test('录制：点页面上的「停止」后后台发来 flush，马上回话（不等 stop 的应答——那要后台停完才回，等它就互相等到超时）', async () => {
  const p = page();
  const f = p.add('input', { id: 'kw' });
  await p.start();
  p.type(f, 'abc', { commit: false });
  // 页面上的停止按钮做的事：先提交输入，再发 stop（这个假后台不回 stop）
  await p.tell({ type: 'flush' });
  p.env.chrome.runtime.sendMessage({ type: 'stop' });
  const res = await Promise.race([p.tell({ type: 'flush' }), new Promise((r) => setTimeout(() => r('卡住了'), 300))]);
  assert.equal(JSON.stringify(res), '{"ok":true}');
});


test('录制：可编辑的 body、designMode 的编辑器里打的字不录成按键（由输入事件录），回车、Tab、Ctrl+B 照常录', async () => {
  for (const setup of [(p) => { p.doc.body.isContentEditable = true; }, (p) => { p.doc.designMode = 'on'; }]) {
    const p = page();
    setup(p);
    await p.start();
    const keys = () => p.steps().filter((s) => s.type === 'press').map((s) => s.key);
    for (const k of ['a', 'b', 'c', ' ', '1', 'ArrowLeft', 'Backspace', 'Home']) p.fire('keydown', p.doc.body, { key: k });
    assert.deepEqual(keys(), []);
    p.fire('keydown', p.doc.body, { key: 'Enter' });
    p.fire('keydown', p.doc.body, { key: 'Tab' });
    p.fire('keydown', p.doc.body, { key: 'b', ctrlKey: true });
    assert.deepEqual(keys(), ['Enter', 'Tab', 'b']);
  }
});

test('录制：焦点在 body 上时数字不录成按键；页面上有看得见的密码框、验证码框时字母也不录，没有时 j、k 照常录', async () => {
  let p = page();
  await p.start();
  const keys = (q) => q.steps().filter((s) => s.type === 'press').map((s) => s.key);
  for (const k of '123456') p.fire('keydown', p.doc.body, { key: k });
  assert.deepEqual(keys(p), []);
  p.fire('keydown', p.doc.body, { key: 'j' });
  p.fire('keydown', p.doc.body, { key: 'k' });
  assert.deepEqual(keys(p), ['j', 'k']);

  // 自己画的 PIN 面板，旁边有个看得见的密码框（或验证码框）：键盘事件在 document 上接，目标是 body
  for (const props of [{ type: 'password' }, { autocomplete: 'one-time-code' }, { name: 'payPwd' }]) {
    p = page();
    p.add('input', props);
    await p.start();
    for (const k of 'a1b2c3') p.fire('keydown', p.doc.body, { key: k });
    p.fire('keydown', p.doc.body, { key: 'Enter' });
    assert.deepEqual(keys(p), ['Enter'], JSON.stringify(props));
  }
  // 密码框藏起来了（登录弹窗关了）：不算
  p = page();
  p.add('input', { type: 'password', checkVisibility: () => false, getClientRects: () => [] });
  await p.start();
  p.fire('keydown', p.doc.body, { key: 'j' });
  assert.deepEqual(keys(p), ['j']);
});

test('录制：Shadow DOM（open 和 closed）里看得见的密码框也算，字母不录；后来才打开的，点一下或换焦点就认得出', async () => {
  const keys = (q) => q.steps().filter((s) => s.type === 'press').map((s) => s.key);
  const shadowWith = (inputs) => ({ querySelectorAll: (sel) => (sel === 'input' ? inputs : []), activeElement: null });
  for (const attach of [(h, r) => { h.shadowRoot = r; }, (h, r) => { h.closedRoot = r; }]) {
    const p = page();
    const pw = { nodeType: 1, tagName: 'INPUT', type: 'password', name: '', id: '', isConnected: true, checkVisibility: () => true, getClientRects: () => [{}] };
    // 外层宿主里套一层宿主，密码框在里面那层
    const inner = p.add('x-pin-box', {});
    attach(inner, shadowWith([pw]));
    const outer = p.add('x-login', {});
    attach(outer, { querySelectorAll: (sel) => (sel === '*' ? [inner] : []), activeElement: null });
    p.doc.querySelectorAll = ((orig) => (sel) => orig(sel).filter((e) => e !== inner))(p.doc.querySelectorAll); // inner 只在 outer 的 Shadow DOM 里
    await p.start();
    for (const k of 'a1b2') p.fire('keydown', p.doc.body, { key: k });
    p.fire('keydown', p.doc.body, { key: 'Enter' });
    assert.deepEqual(keys(p), ['Enter']);
  }

  // 一开始没有密码框，j 照常录；登录弹窗（Shadow DOM 里）后来才打开，按下鼠标后就认得出
  const p = page();
  const pw = { nodeType: 1, tagName: 'INPUT', type: 'password', name: '', id: '', isConnected: true, checkVisibility: () => true, getClientRects: () => [{}] };
  await p.start();
  p.fire('keydown', p.doc.body, { key: 'j' });
  assert.deepEqual(keys(p), ['j']);
  for (const ev of ['pointerdown', 'focusin']) {
    const before = keys(p).length;
    const host = p.add('x-login', { shadowRoot: shadowWith([pw]) }); // 弹窗开了
    p.fire(ev, p.doc.body);
    p.fire('keydown', p.doc.body, { key: 'k' });
    assert.equal(keys(p).length, before, ev);
    host.shadowRoot = null; // 弹窗关了
    p.fire(ev, p.doc.body);
    p.fire('keydown', p.doc.body, { key: 'm' });
    assert.deepEqual(keys(p).slice(before), ['m'], ev);
  }
});

test('录制：pass 只认名字最后一个词——审核、证件字段（passReason、isPass、pass_rate、passport）不当密码', async () => {
  const sensitive = ['pass', 'userPass', 'login_pass', 'user-pass', 'password', 'pass_word', 'pass1', 'pass_1', 'pass[0]', 'user[pass]', 'passCode', 'pwd', 'loginPwd'];
  const plain = ['passReason', 'pass_rate', 'isPass', 'is_pass', 'noPassReason', 'notPass', 'hasPass', 'pass_status', 'passport', 'bypass', 'compass'];
  for (const [names, want] of [[sensitive, true], [plain, undefined]]) {
    for (const name of names) {
      const p = page();
      const f = p.add('input', { name });
      await p.start();
      p.type(f, 'value-123');
      assert.equal(p.steps().find((s) => s.type === 'fill').sensitive, want, name);
    }
  }
});
