import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { FileCursorStore, MemoryCursorStore, cursorFor, isCursor } from '../../src/cursors.ts';
import type { CursorStore } from '../../src/cursors.ts';
import { MAP_SCHEMA_VERSION } from '../../src/map/types.ts';
import type { MapDocument } from '../../src/map/types.ts';
import { MemoryStore } from '../../src/store/store.ts';
import { readHandle, runOperation } from '../../src/runtime/run.ts';
import type { RunResult } from '../../src/runtime/run.ts';
import type { FetchLike } from '../../src/runtime/execute.ts';

const now = new Date('2026-11-01T12:00:00.000Z');
const scratch: string[] = [];

after(async () => {
  await Promise.all(scratch.map((dir) => rm(dir, { recursive: true, force: true })));
});

const map: MapDocument = {
  schemaVersion: MAP_SCHEMA_VERSION,
  id: 'gh',
  title: 'Issues',
  baseUrl: 'https://api.github.test',
  resources: [{ id: 'issue', title: 'Issue', key: 'number' }],
  operations: [
    {
      id: 'issue.list',
      resource: 'issue',
      title: 'List issues',
      request: { method: 'GET', path: '/issues', query: { per_page: '{per_page}' } },
      input: { properties: { per_page: { type: 'integer', default: 2 } } },
      pagination: { kind: 'link-header' },
      view: { select: '/items', mode: 'rows', fields: ['number'] },
    },
    {
      id: 'item.list',
      resource: 'issue',
      title: 'List items',
      request: { method: 'GET', path: '/items', query: { limit: '{limit}', skip: '{skip}' } },
      input: { properties: { limit: { type: 'integer', default: 2 }, skip: { type: 'integer', default: 0 } } },
      pagination: { kind: 'offset', totalPath: '/total', skipPath: '/skip', limitPath: '/limit' },
      view: { select: '/items', mode: 'rows', fields: ['id'] },
    },
    {
      id: 'issue.create',
      resource: 'issue',
      title: 'Create an issue',
      request: { method: 'POST', path: '/issues', body: { title: '{title}' } },
      input: { required: ['title'], properties: { title: { type: 'string' } } },
      view: { select: '/', mode: 'document' },
    },
  ],
  links: [],
};

type Call = { url: string; method: string };

function recorder(answers: (Response | (() => Response))[]): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  let index = 0;

  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, method: String(init.method ?? 'GET') });
    const next = answers[Math.min(index, answers.length - 1)];
    index += 1;
    if (next === undefined) throw new Error('no response queued');
    return typeof next === 'function' ? next() : next;
  };

  return { fetch: fetchImpl, calls };
}

function json(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...headers } });
}

function expectOk<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  assert.ok(result.ok, JSON.stringify((result as { error: unknown }).error));
  return (result as { ok: true; value: T }).value;
}

function expectErr(result: { ok: boolean; error?: { code: string; hint?: string } }): { code: string; hint?: string } {
  assert.equal(result.ok, false);
  return (result as { ok: false; error: { code: string; hint?: string } }).error;
}

function build(options: { fetch: FetchLike; cursors?: CursorStore; now?: Date }) {
  const clock = options.now ?? now;
  return {
    store: new MemoryStore({ now: () => clock }),
    baseUrl: map.baseUrl,
    fetch: options.fetch,
    cursors: options.cursors ?? new MemoryCursorStore({ now: () => clock }),
    now: () => clock.getTime(),
  };
}

/** The non-dry `RunResult`, or a failed assertion. */
function expectRun(result: Awaited<ReturnType<typeof runOperation>>): Extract<RunResult, { dryRun: false }> {
  const value = expectOk(result);
  assert.equal(value.dryRun, false);
  if (value.dryRun) throw new Error('unreachable');
  return value;
}

test('a Link header becomes a cursor, and the cursor fetches the next page', async () => {
  const { fetch, calls } = recorder([
    json({ items: [{ number: 1 }, { number: 2 }] }, {
      link: '<https://api.github.test/issues?page=2>; rel="next", <https://api.github.test/issues?page=9>; rel="last"',
    }),
    json({ items: [{ number: 3 }] }),
  ]);

  const options = build({ fetch });
  const first = expectRun(await runOperation(map, 'issue.list', {}, options));
  assert.equal(first.mutating, false);
  assert.ok(first.cursor, 'the first page offers a cursor');
  assert.equal(first.envelope.cursor, first.cursor);

  const text = JSON.stringify(first.envelope);
  assert.equal(text.includes('page=2'), false, 'the URL never enters the envelope');

  const second = expectRun(await runOperation(map, 'issue.list', {}, { ...options, cursor: first.cursor! }));
  assert.deepEqual(calls, [
    { url: 'https://api.github.test/issues?per_page=2', method: 'GET' },
    { url: 'https://api.github.test/issues?page=2', method: 'GET' },
  ]);
  assert.equal(second.cursor, undefined, 'no next link, no cursor');

  // The page is stored like any other run, and reads back by handle.
  const page = expectOk(await readHandle(options.store, second.handle));
  assert.equal(typeof page.text, 'string');
});

test('an offset pagination produces cursors until the total is reached', async () => {
  const { fetch, calls } = recorder([
    json({ items: [{ id: 1 }, { id: 2 }], total: 5, skip: 0, limit: 2 }),
    json({ items: [{ id: 3 }, { id: 4 }], total: 5, skip: 2, limit: 2 }),
    json({ items: [{ id: 5 }], total: 5, skip: 4, limit: 2 }),
  ]);

  const options = build({ fetch });
  const first = expectRun(await runOperation(map, 'item.list', {}, options));
  assert.ok(first.cursor);

  const second = expectRun(await runOperation(map, 'item.list', {}, { ...options, cursor: first.cursor! }));
  assert.ok(second.cursor, '2 + 2 is still below 5');

  const third = expectRun(await runOperation(map, 'item.list', {}, { ...options, cursor: second.cursor! }));
  assert.equal(third.cursor, undefined, '4 + 2 reaches the total');

  assert.deepEqual(
    calls.map((call) => new URL(call.url).searchParams.get('skip')),
    ['0', '2', '4'],
  );
});

test('a cursor from another operation is refused', async () => {
  const cursors = new MemoryCursorStore({ now: () => now });
  const record = expectOk(await cursors.put({ operation: 'issue.list', url: 'https://api.github.test/issues?page=2' }));
  const { fetch } = recorder([json({ items: [] })]);

  const error = expectErr(await runOperation(map, 'item.list', {}, { ...build({ fetch, cursors }), cursor: record.id }));
  assert.equal(error.code, 'cursor_mismatch');
  assert.match(error.hint ?? '', /issue\.list/);
});

test('an unknown or malformed cursor is an error value, not a fetch', async () => {
  const { fetch, calls } = recorder([json({ items: [] })]);
  const options = build({ fetch });

  assert.equal(expectErr(await runOperation(map, 'issue.list', {}, { ...options, cursor: 'c_0000000000000000' })).code, 'unknown_cursor');
  assert.equal(expectErr(await runOperation(map, 'issue.list', {}, { ...options, cursor: 'nope' })).code, 'cursor_invalid');
  assert.equal(calls.length, 0);
});

test('a cursor takes no arguments, and cannot continue a write', async () => {
  const { fetch, calls } = recorder([
    json({ items: [] }, { link: '<https://api.github.test/issues?page=2>; rel="next"' }),
  ]);
  const cursors = new MemoryCursorStore({ now: () => now });
  const options = build({ fetch, cursors });

  const first = expectRun(await runOperation(map, 'issue.list', {}, options));
  const withArgs = expectErr(await runOperation(map, 'issue.list', { per_page: 3 }, { ...options, cursor: first.cursor! }));
  assert.equal(withArgs.code, 'invalid_argument');

  const write = expectOk(await cursors.put({ operation: 'issue.create', url: 'https://api.github.test/issues' }));
  const refused = expectErr(await runOperation(map, 'issue.create', {}, { ...options, cursor: write.id, writes: { mode: 'open' } }));
  assert.equal(refused.code, 'cursor_invalid');

  assert.equal(calls.length, 1, 'only the first page reached the network');
});

test('a dry run with a cursor builds the plan without sending it', async () => {
  const cursors = new MemoryCursorStore({ now: () => now });
  const record = expectOk(await cursors.put({ operation: 'issue.list', url: 'https://api.github.test/issues?page=2' }));
  const { fetch, calls } = recorder([json({ items: [] })]);

  const plan = expectOk(
    await runOperation(map, 'issue.list', {}, { ...build({ fetch, cursors }), cursor: record.id, dryRun: true }),
  );

  assert.equal(plan.dryRun, true);
  if (!plan.dryRun) return;
  assert.equal(plan.method, 'GET');
  assert.equal(plan.url, 'https://api.github.test/issues');
  assert.deepEqual(plan.query, { page: '2' });
  assert.equal(calls.length, 0);
});

test('file cursors survive a new store instance, and expire', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wrap2mcp-cursors-'));
  scratch.push(dir);

  const first = new FileCursorStore(dir, { now: () => now, ttlSeconds: 60 });
  const stored = expectOk(await first.put({ operation: 'issue.list', url: 'https://api.github.test/issues?page=2' }));
  assert.ok(isCursor(stored.id));
  assert.equal(stored.id, cursorFor({ operation: 'issue.list', url: 'https://api.github.test/issues?page=2' }));

  const second = new FileCursorStore(dir, { now: () => now, ttlSeconds: 60 });
  assert.equal(expectOk(await second.get(stored.id)).url, 'https://api.github.test/issues?page=2');

  const later = new FileCursorStore(dir, { now: () => new Date(now.getTime() + 120_000), ttlSeconds: 60 });
  assert.equal(expectErr(await later.get(stored.id)).code, 'cursor_expired');

  const pruned = new FileCursorStore(dir, { now: () => new Date(now.getTime() + 120_000), ttlSeconds: 60 });
  assert.equal(await pruned.prune(), 1);
  assert.equal(expectErr(await pruned.get(stored.id)).code, 'cursor_not_found');
});

test('a cursor id is derived from operation and URL', () => {
  const a = cursorFor({ operation: 'x', url: 'https://a.test/1' });
  const b = cursorFor({ operation: 'x', url: 'https://a.test/2' });
  assert.notEqual(a, b);
  assert.equal(a, cursorFor({ operation: 'x', url: 'https://a.test/1' }));
});
