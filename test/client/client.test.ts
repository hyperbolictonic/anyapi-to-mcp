import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { createClient } from '../../src/client.ts';
import type { Client, ClientOptions } from '../../src/client.ts';
import { MemoryStore } from '../../src/store/store.ts';
import type { FetchLike } from '../../src/runtime/execute.ts';

const fixtures = path.join(import.meta.dirname, '..', 'map', 'fixtures');
const scratch: string[] = [];

after(async () => {
  await Promise.all(scratch.map((dir) => rm(dir, { recursive: true, force: true })));
});

const issues = [
  { number: 1, title: 'First', state: 'open', user: { login: 'ann' }, created_at: '2026-10-01T00:00:00Z', comments: 0 },
  { number: 2, title: 'Second', state: 'closed', user: { login: 'bob' }, created_at: '2026-10-02T00:00:00Z', comments: 4 },
];

function fakeFetch(body: unknown): { fetch: FetchLike; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fetch: async (url) => {
      calls.push(url);
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  };
}

function client(options: Partial<ClientOptions> = {}): Client {
  return createClient({
    workspace: { maps: [{ path: path.join(fixtures, 'github.json') }] },
    store: new MemoryStore(),
    env: {},
    ...options,
  });
}

test('ls walks maps, resources and operations', async () => {
  const c = client();

  const root = await c.ls('/');
  assert.match(root.text, /^github\s+GitHub REST — 2 resources, 2 operations/m);

  const resources = await c.ls('/github');
  assert.match(resources.text, /^repo\s+Repository — 2 operations/m);
  assert.match(resources.text, /^issue\s+Issue — 1 operation/m);

  const operations = await c.ls('/github/issue');
  assert.match(operations.text, /^repo\.issues\.list\s+List issues/m);
});

test('ls reports an unknown map without throwing', async () => {
  const result = await client().ls('/nope');
  assert.equal(result.isError, true);
  assert.match(result.text, /unknown map 'nope'\. Try: ls \//);
});

test('find scores by operation id, resource and title', async () => {
  const result = await client().find('issues');
  assert.equal(result.isError, undefined);
  assert.match(result.text, /^repo\.issues\.list/m);
});

test('describe carries the request, inputs, view and links', async () => {
  const result = await client().describe('repo.issues.list');

  assert.match(result.text, /^repo\.issues\.list — List issues/m);
  assert.match(result.text, /GET https:\/\/api\.github\.com\/repos\/\{owner\}\/\{repo\}\/issues → issue/);
  assert.match(result.text, /input: owner: string required; repo: string required; state: string \[open\|closed\|all\] ="/);
  assert.match(result.text, /view: \/ mode=rows fields=number,title,state,user\.login,created_at,comments/);

  const data = result.data as { required: string[]; returns: string; mutating: boolean };
  assert.deepEqual(data.required, ['owner', 'repo']);
  assert.equal(data.returns, 'issue');
  assert.equal(data.mutating, false);
});

test('describe suggests a near miss', async () => {
  const result = await client().describe('repo.issue');
  assert.equal(result.isError, true);
  assert.match(result.text, /Did you mean: .*repo\.issues\.list/);
});

test('run stores a handle and read inherits the producing view', async () => {
  const { fetch, calls } = fakeFetch(issues);
  const c = client({ fetch });

  const run = await c.run('repo.issues.list', { owner: 'microsoft', repo: 'vscode' });
  assert.equal(run.isError, undefined);

  const envelope = (run.data as { envelope: { handle: string; mode: string; fields: string[]; total: number; bytes: number } }).envelope;
  assert.equal(envelope.mode, 'rows');
  assert.equal(envelope.total, 2);
  assert.deepEqual(envelope.fields, ['number:int', 'title:str', 'state:str', 'user.login:str', 'created_at:str', 'comments:int']);
  assert.ok(envelope.handle.startsWith('r_'));

  // Reading the address the view selected inherits its fields, so a follow-up
  // call costs a refetch nothing and keeps the same shape.
  const read = await c.read(envelope.handle, '/');
  const readEnvelope = (read.data as { mode: string; fields: string[] }).fields;
  assert.deepEqual(readEnvelope, envelope.fields);

  // A deeper address is a document, and costs no network.
  const deeper = await c.read(envelope.handle, '/1');
  assert.match(deeper.text, /# document/);
  assert.match(deeper.text, /\/title  "Second"/);

  assert.equal(calls.length, 1);
});

test('a dry run prints the plan and sends nothing', async () => {
  const { fetch, calls } = fakeFetch(issues);
  const c = client({ fetch });

  const result = await c.run('repo.issues.list', { owner: 'a', repo: 'b' }, { dryRun: true });
  const plan = result.data as { dryRun: boolean; url: string; query: Record<string, string> };

  assert.equal(plan.dryRun, true);
  assert.equal(plan.url, 'https://api.github.com/repos/a/b/issues');
  assert.deepEqual(plan.query, { state: 'open', per_page: '100' });
  assert.equal(calls.length, 0);
});

test('run reports an unknown operation with a suggestion', async () => {
  const result = await client().run('repo.issues', {});
  assert.equal(result.isError, true);
  assert.match(result.text, /no operation 'repo\.issues'/);
  assert.match(result.text, /repo\.issues\.list/);
});

test('read on an unknown handle is an actionable failure', async () => {
  const result = await client().read('r_0000000000000000');
  assert.equal(result.isError, true);
  assert.match(result.text, /unknown handle/);
});

test('reload picks up a map edited on disk', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wrap2mcp-reload-'));
  scratch.push(dir);
  await cp(path.join(fixtures, 'github.json'), path.join(dir, 'github.json'));

  const c = client({ workspace: { maps: [{ path: dir }] } });
  const before = await c.ls('/github');
  assert.match(before.text, /2 operations/);

  const raw = await readFile(path.join(dir, 'github.json'), 'utf8');
  const map = JSON.parse(raw) as { operations: unknown[] };
  map.operations.push({
    id: 'repo.search',
    resource: 'repo',
    title: 'Search repositories',
    request: { method: 'GET', path: '/search/repositories' },
    view: { select: '/', mode: 'rows' },
  });
  await writeFile(path.join(dir, 'github.json'), JSON.stringify(map), 'utf8');

  const reloaded = await c.reload();
  assert.ok(reloaded.maps.get('github')?.map.operations.some((operation) => operation.id === 'repo.search'));
});

test('a broken workspace descriptor is an error, not a crash', async () => {
  const c = createClient({ workspace: { maps: [] }, store: new MemoryStore(), env: {} });
  const result = await c.ls('/');
  assert.equal(result.isError, true);
  assert.match(result.text, /at least one map location/);
});

test('a file-backed workspace without a TTL still expires handles in a day', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wrap2mcp-ttl-'));
  scratch.push(dir);

  const c = createClient({
    workspace: {
      maps: [{ path: path.join(fixtures, 'github.json') }],
      payloads: { path: path.join(dir, 'payloads') },
    },
    fetch: fakeFetch(issues).fetch,
    env: {},
  });

  const run = await c.run('repo.issues.list', { owner: 'a', repo: 'b' });
  assert.equal(run.isError, undefined);
  const handle = (run.data as { handle?: string }).handle;
  assert.ok(handle);

  const record = await c.store.get(handle);
  assert.ok(record.ok, record.ok ? '' : record.error.message);
  if (record.ok) assert.match(record.value.meta.expiresAt ?? '', /^\d{4}-\d{2}-\d{2}T/);
});
