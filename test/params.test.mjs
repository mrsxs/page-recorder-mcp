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
