import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyJoin } from '../../src/view/join.ts';
import type { JoinSpec } from '../../src/view/join.ts';

const payload = {
  lines: [
    { detailsId: 'starforge', chaosValue: 120 },
    { detailsId: 'starforge', chaosValue: 300 },
    { detailsId: 'the-apostle', chaosValue: 80 },
  ],
  currencyDetails: [
    { id: 'Starforge', name: 'Starforge' },
    { id: 'Tabula Rasa', name: 'Tabula Rasa' },
  ],
};

const base: Omit<JoinSpec, 'type'> = {
  source: '/currencyDetails',
  left: 'detailsId',
  right: 'id',
  fields: ['name'],
};

function run(spec: JoinSpec): readonly unknown[] {
  const result = applyJoin(payload, payload.lines, spec);
  assert.ok(result.ok, `expected ok, got ${result.ok ? '' : JSON.stringify(result.error)}`);
  return result.value;
}

test('inner keeps matching left rows and attaches right fields', () => {
  const rows = run({ ...base, type: 'inner' });
  assert.deepEqual(rows, [
    { detailsId: 'starforge', chaosValue: 120, name: 'Starforge' },
    { detailsId: 'starforge', chaosValue: 300, name: 'Starforge' },
  ]);
});

test('left keeps every left row and nulls the right fields', () => {
  const rows = run({ ...base, type: 'left' });
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[2], { detailsId: 'the-apostle', chaosValue: 80, name: null });
});

test('anti is the left rows with no match', () => {
  const rows = run({ ...base, type: 'anti' });
  assert.deepEqual(rows, [{ detailsId: 'the-apostle', chaosValue: 80 }]);
});

test('right-anti is the right rows nothing refers to', () => {
  const rows = run({ ...base, type: 'right-anti' });
  assert.deepEqual(rows, [{ id: 'Tabula Rasa', name: 'Tabula Rasa' }]);
});

test('string comparison is case-insensitive by default and exact on request', () => {
  assert.equal(run({ ...base, type: 'inner' }).length, 2);
  assert.equal(run({ ...base, type: 'inner', exact: true }).length, 0);
});

test('without declared fields the whole right row is attached', () => {
  const rows = run({ type: 'inner', source: '/currencyDetails', left: 'detailsId', right: 'id' });
  assert.deepEqual(rows[0], { detailsId: 'starforge', chaosValue: 120, id: 'Starforge', name: 'Starforge' });
});

test('types never join implicitly', () => {
  const typed = { left: [{ k: 1 }], right: [{ k: '1', label: 'string one' }] };
  const result = applyJoin(typed, typed.left, { type: 'inner', source: '/right', left: 'k', right: 'k', fields: ['label'] });
  assert.ok(result.ok);
  assert.equal(result.value.length, 0);
});

test('a bad source or join type is an error, not a throw', () => {
  const notArray = applyJoin(payload, payload.lines, { ...base, type: 'inner', source: '/lines/0' });
  assert.equal(notArray.ok, false);
  if (!notArray.ok) assert.equal(notArray.error.code, 'bad_join');

  const missing = applyJoin(payload, payload.lines, { ...base, type: 'inner', source: '/nope' });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.error.code, 'address_not_found');

  const badType = applyJoin(payload, payload.lines, { ...base, type: 'cross' as never });
  assert.equal(badType.ok, false);
  if (!badType.ok) assert.match(badType.error.hint ?? '', /inner\|left\|anti\|right-anti/);
});
