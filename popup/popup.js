/* global PR_EXPORTER */
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const send = (msg) => chrome.runtime.sendMessage(msg);

let data = null;
let tab = null;
let activeTab = 'steps';
let lastEventCount = -1;

// 显示时长按文字长度算，长消息停留更久；点击可提前关闭
function toast(text, ms) {
  document.querySelectorAll('.toast').forEach((x) => x.remove());
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = text;
  t.title = '点击关闭';
  t.onclick = () => t.remove();
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms || Math.min(8000, 1800 + text.length * 120));
}

async function refresh(force) {
  data = await send({ type: 'getData' });
  if (!data) return;
  renderHeader();
  renderAiStatus();
  if (force || data.events.length !== lastEventCount) {
    lastEventCount = data.events.length;
    renderTimeline();
    if (activeTab === 'apis' && !document.activeElement.closest('.api')) renderApis();
    if (activeTab === 'library') renderLibrary();
  }
}

function renderHeader() {
  const st = data.state || {};
  const rec = !!st.recording;
  const here = rec && tab && st.tabId === tab.id;
  $('#dot').classList.toggle('on', rec);
  $('#status').textContent = rec ? (here ? '录制中' : '正在录制其他标签页') : data.events.length ? '已停止' : '未录制';
  $('#nSteps').textContent = data.counts.steps;
  $('#nReqs').textContent = data.counts.requests;
  $('#btnStart').hidden = rec;
  $('#btnStart').textContent = data.events.length ? '● 重新录制' : '● 开始录制';
  $('#btnContinue').hidden = rec || !data.events.length;
  $('#btnStop').hidden = !rec;
  const n = $('#notice');
  if (rec && !here && !n.dataset.sticky) {
    n.hidden = false;
    if (!n.dataset.other) {
      n.dataset.other = '1';
      n.innerHTML = '正在录制另一个标签页。<button id="goRec">切换过去</button><button id="recHere">改为录制当前页</button>';
      $('#goRec').onclick = () => chrome.tabs.update(st.tabId, { active: true });
      $('#recHere').onclick = () => start(false);
    }
  } else if (!n.dataset.sticky) {
    n.hidden = true;
    delete n.dataset.other;
  }
  const b = $('#bridge');
  b.classList.toggle('on', !!data.bridge);
  b.textContent = data.bridge ? '桥接 ●' : '桥接 ○';
  if ($('#bridgeState')) $('#bridgeState').textContent = data.bridge ? '已连接' : '未连接（请先运行 node bridge/server.js）';
  const nm = $('#recName');
  if (document.activeElement !== nm) nm.value = st.name || '';
  nm.placeholder = data.aiDocs && data.aiDocs.title ? `AI 建议：${data.aiDocs.title}` : '给录制起个名字（停止后自动存入脚本库）';
  const has = data.events.length > 0;
  ['#btnExportJs', '#btnCopyJs', '#btnCopyMd', '#btnExportJson'].forEach((s) => { $(s).disabled = !has; });
}

// 提示会一直显示，直到点 × 关闭（弹窗每 800ms 刷新一次，不能依赖自动隐藏）
function showNotice(html, kind) {
  const n = $('#notice');
  n.hidden = false;
  n.className = 'notice' + (kind === 'error' ? ' error' : '');
  n.dataset.sticky = '1';
  delete n.dataset.other;
  n.innerHTML = '<button class="x" title="关闭">×</button>' + html;
  n.querySelector('.x').onclick = hideNotice;
}
function hideNotice() {
  const n = $('#notice');
  n.hidden = true;
  n.className = 'notice';
  delete n.dataset.sticky;
}

// AI 解读在后台运行，这里显示进度和失败原因；失败信息一直保留到手动关闭或下次解读
let aiSeen = null;
let aiHtml = '';
function renderAiStatus() {
  const st = data.aiStatus;
  const running = !!(st && st.running);
  const btn = $('#btnAi');
  btn.disabled = running;
  btn.textContent = running ? '分析中…' : '✨ AI 解读接口';
  if (aiSeen && aiSeen.running && st && st.ok && st.startedAt === aiSeen.startedAt) {
    toast(`AI 解读完成，已解读 ${st.apis} 个接口`);
    if (activeTab === 'apis') renderApis();
  }
  aiSeen = st;
  const mine = st && (running || !st.recId || st.recId === data.state.id);
  let html = '';
  let cls = '';
  if (mine && running) {
    cls = 'running';
    html = `AI 正在分析${st.model ? '（' + esc(st.model) + '）' : ''}… 已用 ${Math.round((Date.now() - st.startedAt) / 1000)} 秒，${st.chars ? '已收到 ' + st.chars + ' 字' : '等待返回'}
      <div class="tip">可以关掉弹窗，后台会继续分析，结果自动保存。</div>`;
  } else if (mine && st.error) {
    cls = 'error';
    html = `<button class="x" title="关闭">×</button><b>AI 解读失败</b><span class="time">${new Date(st.finishedAt || Date.now()).toLocaleTimeString()}</span>
      <div>${esc(st.error)}</div>
      <div class="tip">检查「设置」里的接口类型、Base URL、API Key 和模型；也可以「复制提示词」交给任意 AI，再「粘贴 AI 结果」。</div>`;
  }
  if (html === aiHtml) return;
  aiHtml = html;
  const box = $('#aiStatus');
  box.className = 'aistatus ' + cls;
  box.innerHTML = html;
  box.hidden = !html;
  const x = box.querySelector('.x');
  if (x) x.onclick = async () => { await send({ type: 'aiDismiss' }); refresh(true); };
}

function shortUrl(u) {
  try { const x = new URL(u); return x.pathname + x.search; } catch (e) { return u; }
}

// ---------------- 时间线（含编辑模式：批量删除步骤） ----------------
let tlEditing = false;
const tlSel = new Set();
let tlAnchor = null; // Shift 连选的起点
let tlShown = [];    // 当前列表里显示的事件 id，按顺序

const sortedEvents = () => [...data.events].sort((a, b) => a.ts - b.ts);

function renderTimeline() {
  const showReqs = $('#showReqs').checked;
  const evs = sortedEvents();
  const list = showReqs ? evs : evs.filter((e) => e.kind === 'step');
  const shown = list.slice(-400);
  tlShown = shown.map((e) => e.id);
  $('#emptyTip').hidden = evs.length > 0;
  const pick = (e) => (tlEditing ? `<input type="checkbox" class="pick" tabindex="-1" ${tlSel.has(e.id) ? 'checked' : ''} />` : '');
  const del = (e) => (tlEditing ? '' : `<button class="del" data-id="${esc(e.id)}" title="删除">×</button>`);
  const html = shown.map((e) => {
    const sel = tlEditing && tlSel.has(e.id) ? ' sel' : '';
    if (e.kind === 'request') {
      const err = e.error || !(e.status >= 200 && e.status < 400);
      let host = '';
      try { host = new URL(e.url).host; } catch (x) { /* ignore */ }
      return `<li class="req${sel}" data-id="${esc(e.id)}">${pick(e)}<span class="ico ${err ? 'err' : ''}">${esc(e.method)} ${esc(e.status || '×')}</span>
        <div class="body"><div class="main" title="${esc(e.url)}">${esc(shortUrl(e.url))}</div>
        <div class="sub">${esc(host)} · ${e.endTs ? e.endTs - e.ts + 'ms' : ''} · ${esc(e.responseBody ? e.responseBody.type : '')}</div></div>
        ${del(e)}</li>`;
    }
    const cls = e.type === 'extract' ? 'extract' : e.type === 'navigate' || e.type === 'url' ? 'nav' : 'step';
    const label = { click: '点击', fill: '输入', select: '选择', check: '勾选', press: '按键', scroll: '滚动', navigate: '打开', url: '路由', extract: '提取', upload: '上传' }[e.type] || e.type;
    let frameTag = '';
    if (e.frame) {
      let fh = '';
      try { fh = new URL(e.frame.url).host; } catch (x) { /* ignore */ }
      frameTag = `<span class="frametag" title="${esc(e.frame.url)}">iframe · ${esc(fh)}</span>`;
    }
    const opt = tlEditing ? '' : `<button class="opt${e.optional ? ' on' : ''}" data-id="${esc(e.id)}" title="可选步骤：回放时页面上有这个元素就执行，没有就跳过（比如只在未登录时出现的登录）">可选</button>`;
    return `<li class="${(sel + (e.optional ? ' optional' : '')).trim()}" data-id="${esc(e.id)}">${pick(e)}<span class="ico ${cls}">${label}</span>
      <div class="body"><div class="main">${esc(PR_EXPORTER.stepDesc(e))}${frameTag}${e.optional ? '<span class="opttag">可选 · 没有就跳过</span>' : ''}</div>
      ${e.target ? `<div class="sub" title="${esc((e.target.selectors || []).join('\n'))}">${esc((e.target.selectors || [])[0] || '')}</div>` : ''}</div>
      ${opt}${del(e)}</li>`;
  }).join('');
  const tl = $('#timeline');
  tl.classList.toggle('editing', tlEditing);
  const box = tl.parentElement;
  const atBottom = !tlEditing && box.scrollTop + box.clientHeight >= box.scrollHeight - 20;
  tl.innerHTML = html;
  if (atBottom) box.scrollTop = box.scrollHeight;
  if (tlEditing) updateEditBar();
}

// 步骤触发的请求：从该步骤到下一个步骤之间发出的请求（和导出时的归属规则一致）
function ownRequests(evs, id) {
  const i = evs.findIndex((e) => e.id === id);
  const out = [];
  if (i < 0 || evs[i].kind !== 'step') return out;
  for (let k = i + 1; k < evs.length && evs[k].kind !== 'step'; k++) out.push(evs[k].id);
  return out;
}
function pickEvent(id, range) {
  const evs = sortedEvents();
  const withReqs = $('#tlWithReqs').checked;
  const expand = (ids) => ids.flatMap((x) => (withReqs ? [x, ...ownRequests(evs, x)] : [x]));
  const a = tlShown.indexOf(tlAnchor);
  const b = tlShown.indexOf(id);
  if (range && a >= 0 && b >= 0) {
    expand(tlShown.slice(Math.min(a, b), Math.max(a, b) + 1)).forEach((x) => tlSel.add(x));
  } else {
    const on = !tlSel.has(id);
    expand([id]).forEach((x) => (on ? tlSel.add(x) : tlSel.delete(x)));
  }
  tlAnchor = id;
}
function selCounts() {
  let steps = 0;
  let reqs = 0;
  for (const e of data.events) if (tlSel.has(e.id)) { if (e.kind === 'step') steps++; else reqs++; }
  return { steps, reqs };
}
function updateEditBar() {
  const alive = new Set(data.events.map((e) => e.id));
  for (const id of tlSel) if (!alive.has(id)) tlSel.delete(id);
  const n = selCounts();
  $('#tlSel').textContent = tlSel.size ? `已选 ${n.steps} 个步骤、${n.reqs} 个请求` : '已选 0 项';
  $('#tlDelete').disabled = !tlSel.size;
  $('#tlOpt').disabled = !n.steps;
  $('#tlNoOpt').disabled = !n.steps;
}
async function setSelOptional(optional) {
  const r = (await send({ type: 'setOptional', ids: [...tlSel], optional })) || {};
  toast(optional ? `已把 ${r.changed || 0} 个步骤设为可选：回放时页面上没有就跳过` : `已取消 ${r.changed || 0} 个步骤的可选`);
  tlSel.clear();
  tlAnchor = null;
  await refresh(true);
}
$('#tlOpt').onclick = () => setSelOptional(true);
$('#tlNoOpt').onclick = () => setSelOptional(false);
function setEditing(on) {
  tlEditing = on;
  tlSel.clear();
  tlAnchor = null;
  $('#tlEditBar').hidden = !on;
  $('#btnEditTl').textContent = on ? '退出编辑' : '编辑';
  renderTimeline();
}

$('#timeline').addEventListener('click', async (e) => {
  if (tlEditing) {
    const li = e.target.closest('li[data-id]');
    if (!li) return;
    if (e.shiftKey) window.getSelection().removeAllRanges();
    pickEvent(li.dataset.id, e.shiftKey);
    renderTimeline();
    return;
  }
  const o = e.target.closest('.opt');
  if (o) {
    await send({ type: 'setOptional', ids: [o.dataset.id], optional: !o.classList.contains('on') });
    return refresh(true);
  }
  const b = e.target.closest('.del');
  if (!b) return;
  await send({ type: 'deleteEvents', ids: [b.dataset.id] });
  refresh(true);
});
$('#showReqs').addEventListener('change', () => renderTimeline());
$('#btnEditTl').onclick = () => setEditing(!tlEditing);
$('#tlDone').onclick = () => setEditing(false);
$('#tlNone').onclick = () => { tlSel.clear(); tlAnchor = null; renderTimeline(); };
$('#tlDelete').onclick = async () => {
  if (!tlSel.size) return;
  const n = selCounts();
  if (!confirm(`删除所选的 ${n.steps} 个步骤、${n.reqs} 个请求？删除后不能恢复。`)) return;
  const r = await send({ type: 'deleteEvents', ids: [...tlSel] });
  tlSel.clear();
  tlAnchor = null;
  toast(!r || r.error ? '删除失败：' + ((r && r.error) || '后台没有响应') : `已删除 ${r.deleted} 项`);
  await refresh(true);
};

// ---------------- 接口参数编辑 ----------------
const display = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
function parseVal(text, orig) {
  if (typeof orig === 'string' || orig === undefined) return text;
  try { return JSON.parse(text); } catch (e) { return text; }
}
const SEC_NAME = { path: '路径', query: 'Query', body: 'Body' };

// 「输入参数」：录制时在输入框里填的内容。改这里就是改回放时填的值，关联的接口字段（{{参数}}）会跟着变
function renderParams(A) {
  const box = $('#paramBox');
  if (box.contains(document.activeElement)) return;
  const fills = A.steps.filter((s) => s.type === 'fill' && s.param);
  box.hidden = !fills.length;
  if (!fills.length) return;
  box.innerHTML = '<div class="ptitle">输入参数<span>回放时填进输入框，接口里关联的字段会跟着变。想搜别的内容改这里</span></div>' + fills.map((s) => {
    const n = A.steps.indexOf(s) + 1;
    return `<label class="prow"><span class="pname" title="${esc(s.desc)}">${esc(s.param)}</span>
      <input data-param-step="${esc(s.id)}" value="${esc(s.sensitive ? '' : s.value || '')}"${s.sensitive ? ' disabled placeholder="密码不保存，回放时通过参数传入"' : ''} />
      <span class="pfrom">步骤 ${n}${s.frame ? ' · iframe' : ''}</span></label>`;
  }).join('');
}
$('#paramBox').addEventListener('change', async (e) => {
  const inp = e.target.closest('input[data-param-step]');
  if (!inp) return;
  const r = await send({ type: 'setParam', id: inp.dataset.paramStep, value: inp.value });
  if (r && r.error) { showNotice(esc(r.error), 'error'); return; }
  inp.blur();
  toast(`已改成「${inp.value}」，回放和导出的脚本都会用这个值`);
  await refresh(true);
  renderApis();
});

function renderApis() {
  const A = PR_EXPORTER.analyze(data.events, data.settings, data.state, data.apiOverrides, data.aiDocs);
  // 不带手动修改时的接口参数：用来判断某个字段原本是不是关联着输入参数
  const base = Object.keys(data.apiOverrides || {}).length ? PR_EXPORTER.analyze(data.events, data.settings, data.state, {}, data.aiDocs) : A;
  const baseOf = (name) => base.apis.find((x) => x.name === name);
  const linkOf = (v) => { const m = typeof v === 'string' && v.match(/^\{\{\s*(.+?)\s*\}\}$/); return m ? m[1] : null; };
  renderParams(A);
  $('#apiEmpty').hidden = A.apis.length > 0;
  const info = $('#aiInfo');
  if (data.aiDocs && (data.aiDocs.title || data.aiDocs.description)) {
    info.hidden = false;
    info.innerHTML = `<b>${esc(data.aiDocs.title || '')}</b>${esc(data.aiDocs.description || '')}`;
  } else info.hidden = true;
  $('#apiList').innerHTML = A.apis.map((a, ai) => {
    const ov = data.apiOverrides[a.name] || {};
    const b0 = baseOf(a.name);
    const rows = [];
    for (const sec of ['path', 'query', 'body']) {
      for (const [k, v] of Object.entries(a.editParams[sec] || {})) {
        const mod = ov[sec] && k in ov[sec];
        const m = a.paramMeta[`${sec}.${k}`];
        const link = linkOf(v);
        const wasLink = mod && b0 ? linkOf((b0.editParams[sec] || {})[k]) : null;
        let cell;
        if (link) {
          // 关联着输入参数：不在这里改，改上面的「输入参数」
          cell = `<div class="linked">= 输入参数「${esc(link)}」<span>当前：${esc(A.params[link] == null ? '' : A.params[link])}</span></div>`;
        } else {
          cell = `<input class="${mod ? 'mod' : ''}" data-api="${ai}" data-sec="${sec}" data-key="${esc(k)}" value="${esc(display(v))}" />
          ${wasLink ? `<div class="warn">已固定成这个值，不再跟着输入参数「${esc(wasLink)}」变 <button data-relink="${ai}" data-sec="${sec}" data-key="${esc(k)}">恢复关联</button></div>` : m ? `<div class="meta">${esc(m)}</div>` : ''}`;
        }
        rows.push(`<tr><td class="sec"><span>${SEC_NAME[sec]}</span></td><td class="key">${esc(k)}</td>
          <td class="val">${cell}</td>
          <td class="rm">${sec === 'path' || link ? '' : `<button data-rm="${ai}" data-sec="${sec}" data-key="${esc(k)}" title="从请求中移除此参数">×</button>`}</td></tr>`);
      }
    }
    const trig = a.triggeredBy.map((x) => (x === 0 ? '页面加载' : '步骤' + x)).join('、');
    const doc = `<div class="api-doc"><span class="fn">${esc(a.fn)}()</span>${a.title ? ' · <b>' + esc(a.title) + '</b>' : ''}${a.ignore ? ' · 无关接口' : ''}${a.description ? '<br>' + esc(a.description) : ''}${a.returns ? '<br>返回：' + esc(a.returns) : ''}</div>`;
    return `<div class="api ${a.overridden ? 'changed' : ''} ${a.ignore ? 'ignored' : ''}" data-name="${esc(a.name)}">
      <div class="api-head"><div><div class="api-name">${esc(a.name)}</div>
        <div class="api-meta">${esc(a.status)} · ${esc(a.contentType || a.bodyType || '')} · ${a.count} 次 · ${esc(trig)}</div></div>
        <div class="api-ops"><label class="aiuse" title="勾选的接口才会作为工具提供给 AI（MCP），直接请求模式也只调用勾选的"><input type="checkbox" data-aiuse="${ai}" ${a.ignore ? '' : 'checked'} /> AI 可调用</label>
        ${a.overridden ? `<button data-reset="${ai}">重置</button>` : ''}</div></div>
      ${doc}
      ${rows.length ? `<table>${rows.join('')}</table>` : '<div class="noparam">无参数</div>'}
      <div class="add"><select data-addsec="${ai}"><option value="query">Query</option>${a.method !== 'GET' ? '<option value="body">Body</option>' : ''}</select>
        <input placeholder="新参数名" data-addkey="${ai}" /><input placeholder="值" data-addval="${ai}" /><button data-add="${ai}">添加</button></div>
      ${a.schema || a.sample ? `<details><summary>响应结构 / 示例</summary><pre>${esc(a.schema ? a.schema.join('\n') : '')}${a.schema ? '\n\n' : ''}${esc(typeof a.sample === 'string' ? a.sample : JSON.stringify(a.sample, null, 2))}</pre></details>` : ''}
    </div>`;
  }).join('');
  renderApis.cache = A;
  const bar = $('#apiBar');
  const used = A.apis.filter((a) => !a.ignore).length;
  bar.hidden = !A.apis.length;
  bar.innerHTML = `<span>AI 可调用 <b>${used}</b> / ${A.apis.length} 个接口</span><span class="hint">只勾你要用的，MCP 里就只出现这几个工具</span>
    <button data-aiall="1">全选</button><button data-aiall="0">全不选</button>`;
}
// 「AI 可调用」：存成 AI 文档里的 ignore 标记（和 AI 解读标出的无关接口是同一个开关）
async function setAiUse(names, use) {
  const apis = {};
  names.forEach((n) => { apis[n] = { ignore: !use }; });
  const r = await send({ type: 'saveAiDocs', docs: { apis } });
  if (r && r.error) return showNotice(esc(r.error), 'error');
  await refresh(true);
  renderApis();
}
$('#apiBar').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-aiall]');
  if (b) setAiUse(renderApis.cache.apis.map((a) => a.name), b.dataset.aiall === '1');
});

async function saveOverrides() {
  await send({ type: 'saveApiOverrides', apiOverrides: data.apiOverrides });
}
function setOverride(a, sec, key, value) {
  const o = (data.apiOverrides[a.name] = data.apiOverrides[a.name] || {});
  o[sec] = o[sec] || {};
  const orig = (a.params[sec] || {})[key];
  if (value !== undefined && JSON.stringify(value) === JSON.stringify(orig)) delete o[sec][key];
  else o[sec][key] = value;
  if (!Object.keys(o[sec]).length) delete o[sec];
  if (!Object.keys(o).length) delete data.apiOverrides[a.name];
}

$('#apiList').addEventListener('change', async (e) => {
  const use = e.target.closest('input[data-aiuse]');
  if (use) return setAiUse([renderApis.cache.apis[+use.dataset.aiuse].name], use.checked);
  const inp = e.target.closest('input[data-api]');
  if (!inp) return;
  const a = renderApis.cache.apis[+inp.dataset.api];
  const { sec, key } = inp.dataset;
  const v = parseVal(inp.value, (a.params[sec] || {})[key]);
  setOverride(a, sec, key, v);
  inp.classList.add('mod');
  inp.closest('.api').classList.add('changed');
  await saveOverrides();
});
$('#apiList').addEventListener('click', async (e) => {
  const t = e.target;
  const A = renderApis.cache;
  if (t.dataset.reset != null) {
    delete data.apiOverrides[A.apis[+t.dataset.reset].name];
  } else if (t.dataset.relink != null) {
    const a = A.apis[+t.dataset.relink];
    const { sec, key } = t.dataset;
    const o = data.apiOverrides[a.name];
    if (o && o[sec]) {
      delete o[sec][key];
      if (!Object.keys(o[sec]).length) delete o[sec];
      if (!Object.keys(o).length) delete data.apiOverrides[a.name];
    }
    toast('已恢复关联输入参数');
  } else if (t.dataset.rm != null) {
    const a = A.apis[+t.dataset.rm];
    const { sec, key } = t.dataset;
    if ((a.params[sec] || {})[key] !== undefined) setOverride(a, sec, key, { __deleted: true });
    else { const o = data.apiOverrides[a.name]; if (o && o[sec]) delete o[sec][key]; }
  } else if (t.dataset.add != null) {
    const ai = t.dataset.add;
    const a = A.apis[+ai];
    const sec = $(`[data-addsec="${ai}"]`).value;
    const key = $(`[data-addkey="${ai}"]`).value.trim();
    if (!key) return toast('请填写参数名');
    setOverride(a, sec, key, parseVal($(`[data-addval="${ai}"]`).value, 0));
  } else return;
  await saveOverrides();
  renderApis();
});

// ---------------- 设置 ----------------
function renderSettings() {
  document.querySelectorAll('[data-k]').forEach((el) => {
    const v = data.settings[el.dataset.k];
    if (el.type === 'checkbox') el.checked = !!v; else el.value = v == null ? '' : v;
  });
}
document.querySelectorAll('[data-k]').forEach((el) => {
  el.addEventListener('change', async () => {
    const v = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value;
    if (el.dataset.k === 'aiProvider') {
      const base = $('[data-k=aiBaseUrl]');
      base.value = v === 'anthropic' ? 'https://api.anthropic.com/v1' : 'https://api.openai.com/v1';
      await send({ type: 'saveSettings', settings: { aiBaseUrl: base.value } });
    }
    if (el.dataset.k === 'excludePattern' && v) { try { new RegExp(v); } catch (e) { toast('正则表达式无效'); return; } }
    const r = await send({ type: 'saveSettings', settings: { [el.dataset.k]: v } });
    data.settings = r.settings;
    toast('已保存');
  });
});

// ---------------- tabs ----------------
document.querySelectorAll('.tabs button').forEach((b) => {
  b.addEventListener('click', () => {
    activeTab = b.dataset.tab;
    document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
    document.querySelectorAll('.tab').forEach((x) => { x.hidden = x.id !== 'tab-' + activeTab; });
    if (activeTab === 'apis') renderApis();
    if (activeTab === 'settings') renderSettings();
    if (activeTab === 'library') renderLibrary();
  });
});

// ---------------- 控制 ----------------
async function start(fresh) {
  if (fresh && data.events.length && !confirm('重新录制会清空当前录制内容，确定吗？')) return;
  const r = await send({ type: 'start', tabId: tab.id, fresh });
  if (r && r.error) { showNotice(esc(r.error), 'error'); return; }
  hideNotice();
  if (fresh) showNotice('录制已开始。如果页面是在安装扩展之前打开的，建议<b>刷新页面</b>以抓取首屏请求。<button id="reload">刷新页面</button>');
  const rb = $('#reload');
  if (rb) rb.onclick = () => { chrome.tabs.reload(tab.id); window.close(); };
  refresh(true);
}
$('#btnStart').onclick = () => start(true);
$('#btnContinue').onclick = () => start(false);
$('#btnStop').onclick = async () => { await send({ type: 'stop' }); if (!$('#notice').classList.contains('error')) hideNotice(); refresh(true); };
$('#btnClear').onclick = async () => {
  if (data.events.length && !confirm('确定清空所有录制内容？')) return;
  await send({ type: 'clear' });
  refresh(true);
};

// ---------------- 导出 ----------------
function fileBase() {
  let host = 'page';
  try { host = new URL(data.state.startUrl || data.events[0].url).host.replace(/[^\w.-]/g, '_'); } catch (e) { /* ignore */ }
  const nm = (data.state.name || (data.aiDocs && data.aiDocs.title) || '').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40);
  if (nm) host = nm;
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `recording-${host}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}
function download(text, name, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
function buildOut() { return PR_EXPORTER.build(data.events, data.settings, data.state, data.apiOverrides, data.aiDocs); }

$('#btnExportJs').onclick = () => { download(buildOut().script, fileBase() + '.js', 'text/javascript'); };
$('#btnExportJson').onclick = () => { download(JSON.stringify(buildOut().raw, null, 2), fileBase() + '.json', 'application/json'); };
$('#btnCopyJs').onclick = async () => { await navigator.clipboard.writeText(buildOut().script); toast('脚本已复制'); };
$('#btnCopyMd').onclick = async () => { await navigator.clipboard.writeText(buildOut().summary); toast('说明已复制（Markdown）'); };

// ---------------- 名称 ----------------
$('#recName').addEventListener('change', async (e) => {
  await send({ type: 'setMeta', name: e.target.value });
  toast('名称已保存');
  refresh(true);
});

// ---------------- AI 解读 ----------------
// 只负责启动；进度、结果和失败原因由 renderAiStatus 根据后台的 aiStatus 显示
$('#btnAi').onclick = async () => {
  $('#btnAi').disabled = true;
  try {
    const r = await send({ type: 'aiAnalyze' });
    if (r && r.error) throw new Error(r.error);
  } catch (e) {
    showNotice('AI 解读启动失败：' + esc(e.message), 'error');
  }
  await refresh(true);
};
$('#btnPrompt').onclick = async () => {
  const r = await send({ type: 'getPrompt' });
  await navigator.clipboard.writeText(r.prompt);
  toast('提示词已复制，发给 AI 后把返回的 JSON 粘贴回来');
};
$('#btnPasteDocs').onclick = async () => {
  let text = '';
  try { text = await navigator.clipboard.readText(); } catch (e) { /* ignore */ }
  if (!text || !text.includes('{')) text = prompt('粘贴 AI 返回的 JSON：') || '';
  if (!text) return;
  try {
    const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    const docs = JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1));
    const r = await send({ type: 'saveAiDocs', docs });
    if (r.error) throw new Error(r.error);
    toast('已应用 AI 解读');
    await refresh(true);
    renderApis();
  } catch (e) { showNotice('粘贴的内容不是有效的 JSON：' + esc(e.message), 'error'); }
};

// ---------------- 脚本库 ----------------
function renderLibrary() {
  const list = data.libIndex || [];
  $('#libEmpty').hidden = list.length > 0;
  if ($('#libList').contains(document.activeElement) && document.activeElement.matches('input')) return; // 正在填参数，别刷掉
  // 有输入参数的脚本，运行前可以直接在卡片上改（只影响这次运行）
  const paramRows = (x) => {
    const ps = Object.entries(x.params || {});
    if (!ps.length) return '';
    return `<div class="lib-params">${ps.map(([k, v]) => `<label><span>${esc(k)}</span><input data-lp="${esc(k)}" value="${esc(v)}" /></label>`).join('')}</div>`;
  };
  $('#libList').innerHTML = list.map((x) => `<div class="lib ${x.id === data.state.id ? 'current' : ''}" data-id="${esc(x.id)}">
    <div class="lib-name">${esc(x.name)}${x.hasDocs ? '<span class="tag">AI 已解读</span>' : ''}${x.id === data.state.id ? '<span class="tag">当前</span>' : ''}</div>
    ${x.description ? `<div class="lib-desc">${esc(x.description)}</div>` : ''}
    <div class="lib-meta">${x.steps} 步 · ${x.requests} 个请求 · ${new Date(x.savedAt).toLocaleString()} · ${esc(x.startUrl || '')}</div>
    ${paramRows(x)}
    <div class="lib-actions">${x.direct ? '<button data-act="query" class="primary" title="不操作页面，把参数填进接口，直接在开着的页面里请求（快）">⚡ 直接请求</button>' : ''}<button data-act="run" title="在页面上重放录制的操作">▶ 回放操作</button><button data-act="open">打开编辑</button><button data-act="export">导出 .js</button><button data-act="del">删除</button></div>
    <div class="lib-out"></div></div>`).join('');
}
$('#libList').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const card = b.closest('.lib');
  const id = card.dataset.id;
  const act = b.dataset.act;
  if (act === 'del') {
    if (!confirm('确定删除这个脚本？')) return;
    await send({ type: 'libDelete', id });
  } else if (act === 'open') {
    const r = await send({ type: 'libOpen', id });
    if (r.error) return toast(r.error);
    toast('已打开为当前录制');
  } else if (act === 'export') {
    const { item } = await send({ type: 'libGet', id });
    const out = PR_EXPORTER.build(item.events, item.settings, item.state, item.apiOverrides, item.aiDocs);
    download(out.script, (item.name || 'recording').replace(/[\\/:*?"<>|\s]+/g, '_') + '.js', 'text/javascript');
    return;
  } else if (act === 'run' || act === 'query') {
    const label = b.textContent;
    b.disabled = true;
    b.textContent = act === 'query' ? '请求中…' : '运行中…';
    const params = {};
    card.querySelectorAll('input[data-lp]').forEach((i) => { params[i.dataset.lp] = i.value; });
    const r = await send({ type: 'libRun', id, params, mode: act === 'query' ? 'api' : 'ui' });
    b.disabled = false;
    b.textContent = label;
    card.querySelector('.lib-out').innerHTML = `<pre class="result">${esc(r.error ? '失败：' + r.error : JSON.stringify(r.result, null, 2))}</pre>`;
    return;
  }
  await refresh(true);
  renderLibrary();
});

$('#btnReconnect').onclick = async () => {
  const r = await send({ type: 'bridgeReconnect' });
  toast(r.bridge ? '桥接已连接' : '连接失败：请先运行 node bridge/server.js');
  refresh(true);
};

(async () => {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await refresh(true);
  setInterval(() => refresh(false), 800);
})();
