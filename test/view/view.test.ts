import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { resolvePointer } from '../../src/view/address.ts';
import type { Envelope } from '../../src/view/types.ts';
import { renderView } from '../../src/view/view.ts';

const issue = (n: number) => ({
  id: 1000 + n,
  number: n,
  title: `Issue number ${n}`,
  state: n % 3 === 0 ? 'closed' : 'open',
  user: { login: `user${n}`, id: n, site_admin: false },
  labels: [{ name: 'bug' }, { name: 'help wanted' }],
  body: `A body long enough to be truncated at one hundred and twenty characters when the cap applies, and clearly over the limit for issue number ${n}`,
  comments: n,
  created_at: `2026-10-${String(n + 1).padStart(2, '0')}T00:00:00Z`,
  pull_request: undefined,
});

const payload = {
  total_count: 1240,
  incomplete_results: false,
  items: Array.from({ length: 12 }, (_, i) => issue(i)),
};

function unwrap(result: ReturnType<typeof renderView>): Envelope {
  assert.ok(result.ok, `expected ok, got ${result.ok ? '' : JSON.stringify(result.error)}`);
  return result.value;
}

/** Every address printed at the start of an outline line must resolve. This is
 * the product invariant, so it is asserted generically rather than sampled. */
function assertPrintedAddressesResolve(text: string, root: unknown): void {
  for (const line of text.split('\n')) {
    const match = /^\s*(\/\S*)\s\s/.exec(line);
    if (!match) continue;
    const address = match[1]!;
    const resolved = resolvePointer(root, address.split(/\s/)[0]!);
    assert.ok(resolved.ok, `printed address ${address} does not resolve`);
  }
}

test('rows use declared fields and beat auto-union', () => {
  const envelope = unwrap(
    renderView(payload, {
      select: '/items',
      mode: 'rows',
      fields: ['number', 'title', 'state', 'user.login', 'comments', 'created_at'],
    }),
  );

  assert.equal(envelope.mode, 'rows');
  assert.deepEqual(envelope.fields, [
    'number:int',
    'title:str',
    'state:str',
    'user.login:str',
    'comments:int',
    'created_at:str',
  ]);
  assert.equal(envelope.total, 12);
  assert.equal(envelope.returned, 10);
  assert.equal(envelope.truncated, true);
  assert.equal(envelope.rows?.length, 10);
  assert.deepEqual(envelope.rows?.[0], [0, 'Issue number 0', 'closed', 'user0', 0, '2026-10-01T00:00:00Z']);
  assert.equal(envelope.address, '/items');
});

test('nested values are summarised instead of inlined', () => {
  const envelope = unwrap(renderView(payload, { select: '/items', mode: 'rows', fields: ['labels', 'user'], limits: { maxItems: 1 } }));
  assert.deepEqual(envelope.rows?.[0], ['[arr:2]', '{obj:3}']);
});

test('long strings respect the field cap, and 0 disables it', () => {
  const capped = unwrap(renderView(payload, { select: '/items', mode: 'rows', fields: ['body'], limits: { maxItems: 1 } }));
  assert.equal(String(capped.rows?.[0]?.[0]).length, 121, '120 chars plus an ellipsis');

  const full = unwrap(
    renderView(payload, { select: '/items', mode: 'rows', fields: ['body'], limits: { maxItems: 1, maxFieldChars: 0 } }),
  );
  assert.equal(full.rows?.[0]?.[0], issue(0).body);
});

test('union is the fallback and is capped', () => {
  const envelope = unwrap(renderView(payload, { select: '/items', mode: 'rows', limits: { maxItems: 2, maxKeys: 4 } }));
  assert.deepEqual(envelope.fields, ['id:int', 'number:int', 'title:str', 'state:str']);
  assert.match(envelope.hint ?? '', /fields capped at 4/);
});

test('auto picks a mode from the shape and reports it', () => {
  const cases: Array<[unknown, string]> = [
    [payload.items, 'rows'],
    [payload, 'document'],
    [['a', 'b'], 'list'],
    [42, 'scalar'],
    [[], 'list'],
    [[{ a: 1 }, 'mixed'], 'document'],
  ];

  for (const [node, expected] of cases) {
    const envelope = unwrap(renderView(node));
    assert.equal(envelope.mode, expected, `for ${JSON.stringify(node)?.slice(0, 30)}`);
  }
});

test('document outline prints only addresses that resolve', () => {
  const envelope = unwrap(renderView(payload.items[0]));
  assert.equal(envelope.mode, 'document');
  assertPrintedAddressesResolve(envelope.text ?? '', payload.items[0]);
  assert.match(envelope.text ?? '', /\/user  obj\(3\)/);
});

test('outline elision points at the first omitted node, not a range', () => {
  const envelope = unwrap(renderView(payload, { mode: 'document', limits: { maxItems: 2, maxDepth: 3 } }));
  assert.match(envelope.text ?? '', /\+10 more -> \/items\/2/);
  const resolved = resolvePointer(payload, '/items/2');
  assert.ok(resolved.ok);
});

test('depth cap says how to continue', () => {
  const envelope = unwrap(renderView(payload, { mode: 'document', limits: { maxDepth: 1 } }));
  assert.match(envelope.text ?? '', /keys -> \/  \(raise depth\)/);
});

test('headings style is opt-in and labels rows by a chosen field', () => {
  const envelope = unwrap(
    renderView(payload, {
      select: '/items',
      mode: 'document',
      style: 'headings',
      titleField: 'title',
      limits: { maxItems: 2 },
    }),
  );

  assert.equal(envelope.mode, 'document');
  assert.match(envelope.text ?? '', /^## 1\. Issue number 0$/m);
  assert.match(envelope.text ?? '', /^- \*\*number\*\* 0$/m);
  assertPrintedAddressesResolve(envelope.text ?? '', payload);
  assert.equal(envelope.truncated, true);
});

test('list is rows with one column, so consumers read one shape', () => {
  const envelope = unwrap(renderView(['alpha', 'beta', 'gamma']));
  assert.equal(envelope.mode, 'list');
  assert.deepEqual(envelope.fields, ['value:str']);
  assert.deepEqual(envelope.rows, [['alpha'], ['beta'], ['gamma']]);
  assert.equal(envelope.text, undefined, 'list is columnar, not text');
});

test('table renders markdown and escapes pipes', () => {
  const envelope = unwrap(renderView([{ a: 'x|y', b: 1 }], { mode: 'table' }));
  assert.equal(envelope.mode, 'table');
  assert.equal(envelope.text, '| a | b |\n| --- | --- |\n| x\\|y | 1 |');
});

test('jsonl is one object per line', () => {
  const envelope = unwrap(renderView([{ a: 1 }, { a: 2 }], { mode: 'jsonl' }));
  assert.equal(envelope.text, '{"a":1}\n{"a":2}');
  assert.equal(envelope.total, 2);
});

test('shape costs a fraction of what it describes', () => {
  const envelope = unwrap(renderView(payload, { mode: 'shape' }));
  assert.equal(envelope.mode, 'shape');
  assert.ok((envelope.text ?? '').includes('/items  arr(12) of obj(10)'), envelope.text ?? '');
  assert.ok(envelope.bytes < 400, `shape should be tiny, got ${envelope.bytes}`);
});

test('scalar is a single value', () => {
  const envelope = unwrap(renderView('hello'));
  assert.equal(envelope.mode, 'scalar');
  assert.equal(envelope.text, '"hello"');
  assert.equal(envelope.total, 1);
});

test('a selector narrows and says how many of the parent matched', () => {
  const envelope = unwrap(
    renderView(payload, { select: "/items[state='open']", mode: 'rows', fields: ['number'], limits: { maxItems: 5 } }),
  );
  assert.equal(envelope.address, "/items[state='open']");
  assert.equal(envelope.total, 8);
  assert.match(envelope.summary, /8 of 12 rows/);
});

test('truncation hints at a resolvable continuation', () => {
  const envelope = unwrap(renderView(payload, { select: '/items', mode: 'rows', fields: ['number'] }, { handle: 'r_test' }));
  const hint = envelope.hint ?? '';
  assert.match(hint, /^\+2 more -> read r_test \/items\/10$/);

  const address = /read r_test (\S+)$/.exec(hint)?.[1];
  assert.ok(address);
  assert.ok(resolvePointer(payload, address).ok);
});

test('bytes is the utf8 size of the body the consumer pays for', () => {
  const envelope = unwrap(renderView(payload, { select: '/items', mode: 'rows', fields: ['number'] }));
  const body = JSON.stringify({ fields: envelope.fields, rows: envelope.rows });
  assert.equal(envelope.bytes, new TextEncoder().encode(body).length);
  assert.ok(envelope.bytes > 0);
});

test('rendering is deterministic', () => {
  const spec = { select: '/items', mode: 'rows', fields: ['number', 'title'] } as const;
  const first = unwrap(renderView(payload, spec, { handle: 'r_abc' }));
  const second = unwrap(renderView(payload, spec, { handle: 'r_abc' }));
  assert.deepEqual(first, second);
});

test('bad mode and shape mismatches are data, not exceptions', () => {
  const badMode = renderView(payload, { mode: 'sparkles' as never });
  assert.equal(badMode.ok, false);
  if (!badMode.ok) {
    assert.equal(badMode.error.code, 'unknown_mode');
    assert.match(badMode.error.hint ?? '', /valid modes:/);
  }

  const mismatch = renderView(payload, { mode: 'rows' });
  assert.equal(mismatch.ok, false);
  if (!mismatch.ok) {
    assert.equal(mismatch.error.code, 'mode_shape_mismatch');
    assert.equal(mismatch.error.address, '/');
  }
});

test('a bad address surfaces the address and its hint', () => {
  const result = renderView(payload, { select: '/items/99' });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, 'address_not_found');
    assert.equal(result.error.address, '/items/99');
    assert.match(result.error.hint ?? '', /0\.\.11/);
  }
});

test('the view layer imports no I/O', async () => {
  const dir = path.join(import.meta.dirname, '..', '..', 'src', 'view');
  const files = (await readdir(dir)).filter((name) => name.endsWith('.ts'));

  for (const file of files) {
    const source = await readFile(path.join(dir, file), 'utf8');
    assert.doesNotMatch(source, /from ['"]node:/, `${file} must not import a Node built-in`);
    assert.doesNotMatch(source, /\brequire\s*\(/, `${file} must not use require`);
    assert.doesNotMatch(source, /\bDate\.now\b|\bnew Date\b/, `${file} must not read the clock`);
    assert.doesNotMatch(source, /\bprocess\.(env|cwd|hrtime)\b/, `${file} must not read process state`);
    assert.doesNotMatch(source, /\bfetch\s*\(/, `${file} must not touch the network`);
    assert.doesNotMatch(source, /\beval\s*\(|new Function\b/, `${file} must not evaluate code`);
  }
});

test('legacy recipe modes still render after the mode union was closed', async () => {
  const raw = await readFile(path.join(import.meta.dirname, 'fixtures', 'legacy-views.json'), 'utf8');
  const legacy = JSON.parse(raw) as { views: Record<string, Record<string, unknown>> };

  const expected: Record<string, string> = {
    table: 'table',
    documents: 'document',
    outline: 'document',
    json: 'jsonl',
    array: 'list',
  };

  for (const [name, view] of Object.entries(legacy.views)) {
    const envelope = unwrap(renderView(payload, view as never));
    assert.equal(envelope.mode, expected[name], `${name} must normalise to ${expected[name]}`);
    assert.ok((envelope.text ?? JSON.stringify(envelope.rows)).length > 0, `${name} must render something`);
    assert.ok(envelope.bytes > 0);
  }
});
