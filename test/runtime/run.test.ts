import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import { loadLocation } from '../../src/map/load.ts';
import type { MapDocument } from '../../src/map/types.ts';
import { MemoryStore } from '../../src/store/store.ts';
import type { FetchLike } from '../../src/runtime/execute.ts';
import { planOperation, readHandle, runOperation } from '../../src/runtime/run.ts';
import { staticSecrets } from '../../src/runtime/secrets.ts';

const fixtures = path.join(import.meta.dirname, '..', 'map', 'fixtures');

async function githubMap(): Promise<MapDocument> {
  const maps = await loadLocation({ path: path.join(fixtures, 'github.json') });
  assert.equal(maps.length, 1);
  return maps[0]!;
}

const issues = [
  { number: 1, title: 'First', state: 'open', user: { login: 'ann' }, created_at: '2026-10-01T00:00:00Z', comments: 0 },
  { number: 2, title: 'Second', state: 'closed', user: { login: 'bob' }, created_at: '2026-10-02T00:00:00Z', comments: 4 },
];

function jsonFetch(body: unknown): { fetch: FetchLike; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fetch: async (url) => {
      calls.push(url);
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  };
}

function expectOk<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  assert.ok(result.ok, JSON.stringify((result as { error: unknown }).error));
  return (result as { ok: true; value: T }).value;
}

test('a dry run proves the request without touching the network', async () => {
  const map = await githubMap();
  const store = new MemoryStore();
  const { fetch, calls } = jsonFetch(issues);

  const plan = expectOk(
    await runOperation(map, 'repo.issues.list', { owner: 'microsoft', repo: 'vscode' }, { store, baseUrl: map.baseUrl, fetch, dryRun: true }),
  );

  assert.equal(plan.dryRun, true);
  if (!plan.dryRun) return;
  assert.equal(plan.method, 'GET');
  assert.equal(plan.host, 'api.github.com');
  assert.equal(plan.url, 'https://api.github.com/repos/microsoft/vscode/issues');
  assert.deepEqual(plan.query, { state: 'open', per_page: '100' }, 'defaults are applied in the plan');
  assert.deepEqual(plan.headers, [], 'this operation sets no literal headers');
  assert.equal(plan.secret, undefined);
  assert.equal(calls.length, 0, 'a dry run sends nothing');
});

test('a dry run surfaces a missing secret binding as an error, never a value', async () => {
  const map = await githubMap();
  const withSecret: MapDocument = {
    ...map,
    operations: map.operations.map((operation) => ({ ...operation, secret: 'GITHUB_TOKEN' })),
  };

  const plan = expectOk(await planOperation(withSecret, withSecret.operations[0]!, { owner: 'a', repo: 'b' }, {
    GITHUB_TOKEN: { host: 'api.github.com', header: 'authorization', format: 'Bearer {value}' },
  }));

  assert.deepEqual(plan.secret, { name: 'GITHUB_TOKEN', host: 'api.github.com', header: 'authorization' });
  assert.ok(plan.headers.includes('authorization'));
  assert.ok(plan.headers.includes('accept'));
  assert.equal(JSON.stringify(plan).includes('Bearer'), false, 'the plan carries the header name, not a value');

  const unbound = await planOperation(withSecret, withSecret.operations[0]!, { owner: 'a', repo: 'b' }, {});
  assert.equal(unbound.ok, false);
  if (!unbound.ok) {
    assert.equal(unbound.error.code, 'secret_unbound');
    assert.match(unbound.error.hint ?? '', /human binds a secret/);
  }
});

test('a run stores the payload, applies the view and returns an envelope', async () => {
  const map = await githubMap();
  const store = new MemoryStore();
  const { fetch, calls } = jsonFetch(issues);

  const result = expectOk(
    await runOperation(map, 'repo.issues.list', { owner: 'microsoft', repo: 'vscode' }, { store, baseUrl: map.baseUrl, fetch }),
  );

  assert.equal(result.dryRun, false);
  if (result.dryRun) return;

  assert.match(result.handle, /^r_[0-9a-f]{16}$/);
  assert.equal(calls[0], 'https://api.github.com/repos/microsoft/vscode/issues?state=open&per_page=100');

  const envelope = result.envelope;
  assert.equal(envelope.mode, 'rows');
  assert.deepEqual(envelope.fields, ['number:int', 'title:str', 'state:str', 'user.login:str', 'created_at:str', 'comments:int']);
  assert.equal(envelope.total, 2);
  assert.equal(envelope.address, '/');
  assert.equal(envelope.handle, result.handle);
  assert.ok(envelope.bytes > 0);
  assert.ok((envelope.sourceBytes ?? 0) > 0, 'the payload size is reported separately');

  // The stored payload is addressable, and reading costs no network call.
  const read = expectOk(await readHandle(store, result.handle, '/1'));
  assert.equal(read.mode, 'document');
  assert.match(read.text ?? '', /\/title  "Second"/);
  assert.equal(calls.length, 1, 'reading a handle never refetches');
});

test('a named view is selected, and a missing one lists the alternatives', async () => {
  const map = await githubMap();
  const withViews: MapDocument = {
    ...map,
    operations: map.operations.map((operation) =>
      operation.id === 'repo.issues.list'
        ? { ...operation, views: { titles: { select: '/', mode: 'list', fields: ['title'] } } }
        : operation,
    ),
  };

  const store = new MemoryStore();
  const { fetch } = jsonFetch(issues);

  const named = expectOk(await runOperation(withViews, 'repo.issues.list', { owner: 'a', repo: 'b' }, { store, baseUrl: map.baseUrl, fetch, view: 'titles' }));
  assert.equal(named.dryRun, false);
  if (!named.dryRun) assert.equal(named.envelope.mode, 'list');

  const missing = await runOperation(withViews, 'repo.issues.list', { owner: 'a', repo: 'b' }, { store, baseUrl: map.baseUrl, fetch, view: 'nope' });
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.equal(missing.error.code, 'unknown_view');
    assert.match(missing.error.hint ?? '', /views: titles/);
  }
});

test('an unknown operation suggests what the map does have', async () => {
  const map = await githubMap();
  const store = new MemoryStore();

  const result = await runOperation(map, 'repo.issues', {}, { store, baseUrl: map.baseUrl });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, 'unknown_operation');
    assert.match(result.error.hint ?? '', /repo\.issues\.list/);
  }
});

test('a view that does not fit the response is reported with the handle', async () => {
  const map = await githubMap();
  const store = new MemoryStore();
  // A payload that is not the array the view expects.
  const { fetch } = jsonFetch({ message: 'unexpected shape' });

  const result = await runOperation(map, 'repo.issues.list', { owner: 'a', repo: 'b' }, { store, baseUrl: map.baseUrl, fetch });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, 'bad_response');
    assert.match(result.error.hint ?? '', /r_[0-9a-f]{16}/, 'the stored handle is offered for inspection');
  }
});

test('a secret reaches the request only through the provider, and never the envelope', async () => {
  const map = await githubMap();
  const withSecret: MapDocument = {
    ...map,
    operations: map.operations.map((operation) => (operation.id === 'repo.issues.list' ? { ...operation, secret: 'GITHUB_TOKEN' } : operation)),
  };

  const store = new MemoryStore();
  const seen: Array<Record<string, string>> = [];
  const fetch: FetchLike = async (_url, init) => {
    seen.push({ ...(init.headers as Record<string, string>) });
    return new Response(JSON.stringify(issues), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const result = expectOk(
    await runOperation(withSecret, 'repo.issues.list', { owner: 'a', repo: 'b' }, {
      store,
      baseUrl: map.baseUrl,
      fetch,
      bindings: { GITHUB_TOKEN: { host: 'api.github.com', header: 'authorization', format: 'Bearer {value}' } },
      secrets: staticSecrets({ GITHUB_TOKEN: 'ghp_secret_value_1234567890' }),
    }),
  );

  assert.equal(seen[0]?.['authorization'], 'Bearer ghp_secret_value_1234567890');

  const everything = JSON.stringify(result);
  assert.equal(everything.includes('ghp_secret_value_1234567890'), false, 'no credential in the result');
  assert.equal(JSON.stringify(await store.get((result as { handle: string }).handle)).includes('ghp_secret_value'), false, 'no credential in the store');
});
