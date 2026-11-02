import assert from 'node:assert/strict';
import { test } from 'node:test';

import { childAddress, parseAddress, printSelector, resolveAddress, resolvePointer } from '../../src/view/address.ts';

const fixture = {
  data: {
    'a/b': 1,
    'til~de': 2,
    '': 'empty key',
    list: [{ name: 'Starforge', chaos: 120 }, { name: 'starforge', chaos: 300 }, { name: 'Tabula Rasa', chaos: 20 }],
    nested: { deeper: { value: 42 } },
  },
};

test('resolves the root forms', () => {
  for (const address of ['', '/']) {
    const parsed = parseAddress(address);
    assert.ok(parsed.ok);
    assert.equal(parsed.value.text, '/');
    const resolved = resolveAddress(fixture, parsed.value);
    assert.ok(resolved.ok);
    assert.deepEqual(resolved.value.node, fixture);
  }
});

test('escapes ~ and / in tokens', () => {
  assert.equal(childAddress('', 'a/b'), '/a~1b');
  assert.equal(childAddress('', 'til~de'), '/til~0de');
  assert.equal(childAddress('/data', 'a/b'), '/data/a~1b');
});

test('every printed pointer resolves to the same node', () => {
  const targets: Array<[string, unknown]> = [
    ['/data/a~1b', 1],
    ['/data/til~0de', 2],
    ['/data/', 'empty key'],
    ['/data/nested/deeper/value', 42],
    ['/data/list/1/name', 'starforge'],
  ];

  for (const [address, expected] of targets) {
    const resolved = resolvePointer(fixture, address);
    assert.ok(resolved.ok, `${address} must resolve`);
    assert.equal(resolved.value, expected);
  }
});

test('rejects non-canonical array indexes so an address has one printed form', () => {
  for (const address of ['/data/list/01', '/data/list/-1', '/data/list/3', '/data/list/x']) {
    const resolved = resolvePointer(fixture, address);
    assert.equal(resolved.ok, false, `${address} must not resolve`);
    if (!resolved.ok) assert.equal(resolved.error.code, 'address_not_found');
  }
});

test('missing key names the available keys', () => {
  const resolved = resolvePointer(fixture, '/data/nope');
  assert.equal(resolved.ok, false);
  if (!resolved.ok) {
    assert.equal(resolved.error.code, 'address_not_found');
    assert.match(resolved.error.hint ?? '', /available: /);
  }
});

test('key selector returns every match, case-insensitively', () => {
  const resolved = resolveAddress(fixture, "/data/list[name='starforge']");
  assert.ok(resolved.ok);
  assert.equal(resolved.value.matched, 2);
  assert.deepEqual(
    (resolved.value.node as Array<{ name: string }>).map((row) => row.name),
    ['Starforge', 'starforge'],
  );
});

test('a selector miss is an error that lists values seen', () => {
  const resolved = resolveAddress(fixture, "/data/list[name='nothing']");
  assert.equal(resolved.ok, false);
  if (!resolved.ok) {
    assert.equal(resolved.error.code, 'selector_miss');
    assert.equal(resolved.error.address, "/data/list[name='nothing']");
    assert.match(resolved.error.hint ?? '', /values seen:/);
  }
});

test('a selector on a non-array says what it found instead', () => {
  const resolved = resolveAddress(fixture, "/data/nested[value=1]");
  assert.equal(resolved.ok, false);
  if (!resolved.ok) {
    assert.equal(resolved.error.code, 'selector_needs_array');
    assert.match(resolved.error.hint ?? '', /object, not an array/);
  }
});

test('selector values round-trip through print and parse', () => {
  const cases: Array<[string, string]> = [
    ["it's", `"it's"`],
    ['a "quoted" word', `'a "quoted" word'`],
    ['both \' and "', "'both \\' and \"'"],
  ];

  for (const [value, printed] of cases) {
    const text = printSelector('/data/list', { field: 'name', value });
    assert.equal(text, `/data/list[name=${printed}]`);
    const parsed = parseAddress(text);
    assert.ok(parsed.ok, `${text} must parse`);
    assert.equal(parsed.value.selector?.value, value);
    assert.equal(parsed.value.text, text, 'canonical form must be stable');
  }

  const numeric = parseAddress("/data/list[chaos=120]");
  assert.ok(numeric.ok);
  assert.equal(numeric.value.selector?.value, 120);

  const quotedNumeric = parseAddress("/data/list[chaos='120']");
  assert.ok(quotedNumeric.ok);
  assert.equal(quotedNumeric.value.selector?.value, '120', 'quoting keeps a string a string');

  const boolean = parseAddress('/data/list[chaos=true]');
  assert.ok(boolean.ok);
  assert.equal(boolean.value.selector?.value, true);
});

test('root-level selectors print a leading slash', () => {
  const parsed = parseAddress("/[name='x']");
  assert.ok(parsed.ok);
  assert.equal(parsed.value.base, '');
  assert.equal(parsed.value.text, "/[name='x']");
});

test('rejects malformed addresses with a hint', () => {
  const cases = [
    'data/list',
    '/data/list[name',
    '/data/list[name]',
    '/data/list[na me=x]',
    '/data/a~2b',
  ];

  for (const address of cases) {
    const parsed = parseAddress(address);
    assert.equal(parsed.ok, false, `${address} must be rejected`);
    if (!parsed.ok) assert.equal(parsed.error.code, 'bad_address', `${address}: ${parsed.error.code}`);
  }
});
