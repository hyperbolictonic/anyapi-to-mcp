import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { MapDocument } from '../../src/map/types.ts';
import { MAP_SCHEMA_VERSION } from '../../src/map/types.ts';
import { MemoryStore } from '../../src/store/store.ts';
import { executeOperation } from '../../src/runtime/execute.ts';
import type { AuditEvent, FetchLike } from '../../src/runtime/execute.ts';
import { readHandle, runOperation } from '../../src/runtime/run.ts';
import type { RunResult } from '../../src/runtime/run.ts';

const map: MapDocument = {
  schemaVersion: MAP_SCHEMA_VERSION,
  id: 'notes',
  title: 'Notes',
  baseUrl: 'https://notes.example.com',
  resources: [{ id: 'note', title: 'Note', key: 'id' }],
  operations: [
    {
      id: 'note.create',
      resource: 'note',
      title: 'Create a note',
      // Deliberately no `mutating: true`: the method decides.
      request: {
        method: 'POST',
        path: '/notes',
        body: { title: '{title}', body: '{body}', pinned: '{pinned}' },
      },
      input: {
        required: ['title'],
        properties: { title: { type: 'string' }, body: { type: 'string' }, pinned: { type: 'boolean' } },
      },
    },
    {
      id: 'note.delete',
      resource: 'note',
      title: 'Delete a note',
      request: { method: 'DELETE', path: '/notes/{id}' },
      input: { required: ['id'], properties: { id: { type: 'string' } } },
    },
    {
      id: 'note.get',
      resource: 'note',
      title: 'Get a note',
      request: { method: 'GET', path: '/notes/{id}' },
      input: { required: ['id'], properties: { id: { type: 'string' } } },
    },
  ],
  links: [],
};

type Call = { url: string; method: string; body?: string; headers: Record<string, string> };

type Answer = Response | (() => Promise<Response>);

function recorder(answers: Answer[]): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  let index = 0;

  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({
      url,
      method: String(init.method ?? 'GET'),
      ...(typeof init.body === 'string' ? { body: init.body } : {}),
      headers: { ...(init.headers as Record<string, string>) },
    });
    const next = answers[Math.min(index, answers.length - 1)];
    index += 1;
    if (next === undefined) throw new Error('no response queued');
    return typeof next === 'function' ? next() : next;
  };

  return { fetch: fetchImpl, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function expectOk<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  assert.ok(result.ok, JSON.stringify((result as { error: unknown }).error));
  return (result as { ok: true; value: T }).value;
}

function expectErr(result: { ok: boolean; error?: { code: string; hint?: string; status?: number } }): {
  code: string;
  hint?: string;
  status?: number;
} {
  assert.equal(result.ok, false);
  return (result as { ok: false; error: { code: string; hint?: string; status?: number } }).error;
}

/** A run result known to have reached the network. */
function expectRun(result: { ok: true; value: RunResult } | { ok: false; error: unknown }): Exclude<RunResult, { dryRun: true }> {
  const value = expectOk(result);
  assert.equal(value.dryRun, false);
  return value as Exclude<RunResult, { dryRun: true }>;
}

test('a write sends its method, its body and a JSON content type', async () => {
  const store = new MemoryStore();
  const { fetch, calls } = recorder([json({ id: 'n1', title: 'Hello' }, 201)]);

  const result = expectRun(
    await runOperation(
      map,
      'note.create',
      { title: 'Hello' },
      { store, baseUrl: map.baseUrl, fetch, writes: { mode: 'open' } },
    ),
  );

  assert.equal(result.mutating, true, 'the method alone marks a POST as a write');
  assert.equal(result.status, 201);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.method, 'POST');
  assert.equal(calls[0]!.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0]!.body ?? '{}'), { title: 'Hello' }, 'an unfilled optional key is omitted, not sent as "{body}"');
});

test('an unfilled optional body key is omitted; a supplied one is sent', async () => {
  const store = new MemoryStore();
  const { fetch, calls } = recorder([json({ id: 'n1' }, 201)]);

  expectOk(
    await runOperation(
      map,
      'note.create',
      { title: 'Hello', pinned: true },
      { store, baseUrl: map.baseUrl, fetch, writes: { mode: 'open' } },
    ),
  );

  assert.deepEqual(JSON.parse(calls[0]!.body ?? '{}'), { title: 'Hello', pinned: true });
});

test('confirm mode builds the request and sends nothing', async () => {
  const store = new MemoryStore();
  const { fetch, calls } = recorder([json({ id: 'n1' }, 201)]);

  const refused = await runOperation(map, 'note.create', { title: 'Hello' }, { store, baseUrl: map.baseUrl, fetch });
  const error = expectErr(refused);
  assert.equal(error.code, 'write_not_confirmed');
  assert.equal(calls.length, 0, 'nothing reached the network');

  const sent = expectRun(
    await runOperation(
      map,
      'note.create',
      { title: 'Hello' },
      { store, baseUrl: map.baseUrl, fetch, confirm: true },
    ),
  );
  assert.equal(sent.status, 201);
  assert.equal(calls.length, 1);
});

test('deny mode refuses even a confirmed write, but a dry run still previews', async () => {
  const store = new MemoryStore();
  const { fetch, calls } = recorder([json({ id: 'n1' }, 201)]);
  const writes = { mode: 'deny' } as const;

  const refused = await runOperation(map, 'note.create', { title: 'Hello' }, { store, baseUrl: map.baseUrl, fetch, writes, confirm: true });
  assert.equal(expectErr(refused).code, 'write_denied');
  assert.equal(calls.length, 0);

  const plan = expectOk(
    await runOperation(map, 'note.create', { title: 'Hello' }, { store, baseUrl: map.baseUrl, fetch, writes, dryRun: true }),
  );
  assert.equal(plan.dryRun, true);
  if (!plan.dryRun) return;
  assert.equal(plan.mutating, true);
  assert.equal(plan.method, 'POST');
  assert.deepEqual(JSON.parse(plan.body ?? '{}'), { title: 'Hello' });
});

test('a 204 is a one-line answer, and reading the handle gives the same line', async () => {
  const store = new MemoryStore();
  const { fetch } = recorder([new Response(null, { status: 204 })]);

  const result = expectRun(
    await runOperation(map, 'note.delete', { id: 'n1' }, { store, baseUrl: map.baseUrl, fetch, writes: { mode: 'open' } }),
  );

  assert.equal(result.envelope.mode, 'scalar');
  assert.equal(result.envelope.text, 'no content');
  assert.equal(result.envelope.total, 0);
  assert.ok(result.envelope.handle);
  assert.equal(result.handle, result.envelope.handle);

  const read = expectOk(await readHandle(store, result.handle));
  assert.equal(read.text, result.envelope.text, 'the printed address resolves to the same line');
});

test('a 303 turns a POST into a GET without a body', async () => {
  const store = new MemoryStore();
  const { fetch, calls } = recorder([
    new Response(null, { status: 303, headers: { location: '/notes/n1' } }),
    json({ id: 'n1', title: 'Hello' }),
  ]);

  expectOk(
    await runOperation(map, 'note.create', { title: 'Hello' }, { store, baseUrl: map.baseUrl, fetch, writes: { mode: 'open' } }),
  );

  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.method, 'GET');
  assert.equal(calls[1]!.body, undefined, 'the body is not replayed onto the redirect');
  assert.equal(calls[1]!.headers['content-type'], undefined);
});

test('a 307 keeps the method and the body', async () => {
  const store = new MemoryStore();
  const { fetch, calls } = recorder([
    new Response(null, { status: 307, headers: { location: '/notes/n1' } }),
    json({ id: 'n1' }, 201),
  ]);

  expectOk(
    await runOperation(map, 'note.create', { title: 'Hello' }, { store, baseUrl: map.baseUrl, fetch, writes: { mode: 'open' } }),
  );

  assert.equal(calls[1]!.method, 'POST');
  assert.deepEqual(JSON.parse(calls[1]!.body ?? '{}'), { title: 'Hello' });
});

test('a write that fails before a response is outcome_unknown, not network', async () => {
  const store = new MemoryStore();
  const { fetch } = recorder([
    () => {
      throw new Error('socket hang up');
    },
  ]);

  const error = expectErr(
    await runOperation(map, 'note.create', { title: 'Hello' }, { store, baseUrl: map.baseUrl, fetch, writes: { mode: 'open' } }),
  );
  assert.equal(error.code, 'outcome_unknown');
  assert.match(error.hint ?? '', /may have been applied/);

  const readError = expectErr(
    await runOperation(map, 'note.get', { id: 'n1' }, { store, baseUrl: map.baseUrl, fetch, writes: { mode: 'open' } }),
  );
  assert.equal(readError.code, 'network', 'a read keeps the plain network code');
});

test('a 5xx on a write is outcome_unknown; on a read it is http_error', async () => {
  const store = new MemoryStore();
  const { fetch } = recorder([json({ error: 'gateway' }, 502), json({ error: 'gateway' }, 502)]);

  const write = expectErr(
    await runOperation(map, 'note.create', { title: 'Hello' }, { store, baseUrl: map.baseUrl, fetch, writes: { mode: 'open' } }),
  );
  assert.equal(write.code, 'outcome_unknown');
  assert.equal(write.status, 502);

  const read = expectErr(
    await runOperation(map, 'note.get', { id: 'n1' }, { store, baseUrl: map.baseUrl, fetch, writes: { mode: 'open' } }),
  );
  assert.equal(read.code, 'http_error');
  assert.equal(read.status, 502);
});

test('the audit records the body by hash and never by content', async () => {
  const store = new MemoryStore();
  const events: AuditEvent[] = [];
  const { fetch } = recorder([json({ id: 'n1' }, 201)]);

  expectOk(
    await executeOperation(
      map.operations[0]!,
      { title: 'Top secret title' },
      {
        baseUrl: map.baseUrl,
        fetch,
        audit: { record: (event) => void events.push(event) },
      },
    ),
  );

  assert.equal(events.length, 1);
  const event = events[0]!;
  assert.equal(event.method, 'POST');
  assert.equal(event.mutating, true);
  assert.match(event.bodySha256 ?? '', /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(event).includes('Top secret title'), false, 'the body never reaches the sink');
  assert.equal(JSON.stringify(event).includes('content-type'), false, 'headers never reach the sink');
});
