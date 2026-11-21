import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const PR_EXPORTER = createRequire(import.meta.url)('../lib/exporter.js');
const tgt = (sel, label, ctxLabel, tag = 'input', type) => ({ selectors: [sel], tag, type, kind: '输入框', label, desc: `输入框 "${label}"`, ctx: { label: ctxLabel } });
const step = (id, ts, o) => Object.assign({ kind: 'step', id, ts }, o);

test('加了单选/复选框参数后，已有参数的名字不变（脚本库里存的脚本按名字传参）', () => {
  const nav = step('n', 1, { type: 'navigate', url: 'https://shop.test/' });
  const zip = step('a', 2, { type: 'fill', target: tgt('#zip', 'ZIP code', 'Shipping'), value: '10001' });
  const express = step('b', 3, { type: 'check', target: tgt('#express', 'Express', 'Shipping', 'input', 'checkbox'), checked: true });
  const before = PR_EXPORTER.analyze([nav, zip], {}, {});
  const after = PR_EXPORTER.analyze([nav, zip, express], {}, {});
  assert.deepEqual(Object.keys(before.params), ['Shipping']);
  assert.ok('Shipping' in after.params, JSON.stringify(after.params));
  assert.equal(after.params.Shipping, '10001');
  assert.equal(Object.keys(after.params).length, 2);
});

test('复选框和已有参数同名时，已有参数保留原名，复选框另起名', () => {
  const nav = step('n', 1, { type: 'navigate', url: 'https://shop.test/' });
  const agreeCb = step('a', 2, { type: 'check', target: tgt('#agree', 'Agree', '', 'input', 'checkbox'), checked: true });
  const agreeText = step('b', 3, { type: 'fill', target: tgt('#note', 'Agree', ''), value: 'yes' });
  const p = PR_EXPORTER.analyze([nav, agreeCb, agreeText], {}, {}).params;
  assert.equal(p.Agree, 'yes', JSON.stringify(p));
  assert.equal(p.Agree_2, true, JSON.stringify(p));
});

test('起出来的带后缀名字不和已有的同名字段撞上', () => {
  const nav = step('n', 1, { type: 'navigate', url: 'https://shop.test/' });
  const zip = step('a', 2, { type: 'fill', target: tgt('#zip', 'ZIP code', 'Shipping'), value: '10001' });
  const cb = step('b', 3, { type: 'check', target: tgt('#ship', 'Shipping', 'Shipping', 'input', 'checkbox'), checked: true });
  const other = step('c', 4, { type: 'fill', target: tgt('#s2', 'Shipping_2', ''), value: 'x' });
  const p = PR_EXPORTER.analyze([nav, zip, cb, other], {}, {}).params;
  assert.equal(Object.keys(p).length, 3, JSON.stringify(p));
  assert.equal(p.Shipping, '10001');
  assert.equal(p.Shipping_2, 'x');
  assert.ok(Object.values(p).includes(true), JSON.stringify(p));
});

test('同一个下拉框先单选后多选：前一次记成被后一次覆盖', () => {
  const nav = step('n', 1, { type: 'navigate', url: 'https://shop.test/' });
  const sel = (id, ts, value) => step(id, ts, { type: 'select', target: tgt('#region', 'Region', '', 'select'), value, options: [['north', 'North'], ['south', 'South']] });
  const a = PR_EXPORTER.analyze([nav, sel('a', 2, 'north'), sel('b', 3, ['south'])], {}, {});
  const first = a.steps.find((s) => s.id === 'a');
  const last = a.steps.find((s) => s.id === 'b');
  assert.ok(last.param, JSON.stringify(a.params));
  assert.equal(first.overwrittenBy, last.param);
});

test('字段名叫 constructor 也能起名，不卡死', () => {
  const nav = step('n', 1, { type: 'navigate', url: 'https://shop.test/' });
  const a = step('a', 2, { type: 'fill', target: tgt('#c1', 'constructor', ''), value: '1' });
  const b = step('b', 3, { type: 'fill', target: tgt('#c2', 'constructor', ''), value: '2' });
  const p = PR_EXPORTER.analyze([nav, a, b], {}, {}).params;
  assert.deepEqual(p, { constructor: '1', constructor_2: '2' });
});

test('以前撞名的老参数：名字留给提供默认值的那个字段', () => {
  const nav = step('n', 1, { type: 'navigate', url: 'https://shop.test/' });
  const s1 = step('a', 2, { type: 'fill', target: tgt('#s1', 'Shipping', ''), value: '10001' });
  const s2 = step('b', 3, { type: 'fill', target: tgt('#s2', 'Shipping', ''), value: '20002' });
  const s3 = step('c', 4, { type: 'fill', target: tgt('#s3', 'Shipping_2', ''), value: '30004' });
  const r = PR_EXPORTER.analyze([nav, s1, s2, s3], {}, {});
  assert.equal(r.params.Shipping_2, '30004');
  assert.equal(r.steps.find((s) => s.id === 'c').param, 'Shipping_2');
  assert.equal(new Set(r.steps.filter((s) => s.param).map((s) => s.param)).size, 3);
});
