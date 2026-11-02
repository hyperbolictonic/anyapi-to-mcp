import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Operation } from '../../src/map/types.ts';
import { executeOperation } from '../../src/runtime/execute.ts';
import type { AuditEvent, FetchLike } from '../../src/runtime/execute.ts';
import { normalisePolicy } from '../../src/runtime/policy.ts';
import { staticSecrets } from '../../src/runtime/secrets.ts';

const operation: Operation = {
  id: 'issue.get',
  resource: 'issue',
  title: 'Get an issue',
  secret: 'DEMO_TOKEN',
  request: { method: 'GET', path: '/issues/{number}', query: { q: '{q}' }, headers: { accept: 'application/json' } },
  input: {
    required: ['number'],
    properties: { number: { type: 'integer' }, q: { type: 'string' } },
  },
};

const bindings = { DEMO_TOKEN: { host: 'api.demo.test', header: 'authorization', format: 'Bearer {value}' } };
const secrets = staticSecrets({ DEMO_TOKEN: 'top-secret-value' });

type Call = { url: string; headers: Record<string, string> };
type FetchResult = Response | (() => Promise<Response>);

function recorder(responses: FetchResult[]): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  let index = 0;

  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, headers: { ...(init.headers as Record<string, string>) } });
    const next = responses[Math.min(index, responses.length - 1)];
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

function expectErr(result: { ok: boolean; error?: { code: string; message: string; hint?: string; status?: number } }): {
  code: string;
  message: string;
  hint?: string;
  status?: number;
} {
  assert.equal(result.ok, false);
  return (result as { ok: false; error: { code: string; message: string } }).error;
}

test('a successful call returns the payload and audits without headers', async () => {
  const events: AuditEvent[] = [];
  const { fetch, calls } = recorder([json({ number: 7, title: 'hi' })]);

  const result = expectOk(
    await executeOperation(
      operation,
      { number: 7, q: 'open' },
      {
        baseUrl: 'https://api.demo.test',
        fetch,
        bindings,
        secrets,
        audit: { record: (event) => void events.push(event) },
      },
    ),
  );

  assert.deepEqual(result.payload, { number: 7, title: 'hi' });
  assert.equal(result.status, 200);
  assert.equal(result.host, 'api.demo.test');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, 'https://api.demo.test/issues/7?q=open');

  assert.equal(events.length, 1);
  const event = events[0]!;
  assert.equal(event.operation, 'issue.get');
  assert.equal(event.status, 200);
  assert.equal(event.host, 'api.demo.test');
  assert.equal(event.url, 'https://api.demo.test/issues/7', 'the query is dropped from the audit line');
  assert.equal(JSON.stringify(event).includes('top-secret-value'), false, 'the audit event must not carry the secret');
  assert.equal(JSON.stringify(result).includes('top-secret-value'), false, 'the result must not carry the secret');
});

test('a secret is sent to its bound host and dropped on a cross-origin redirect', async () => {
  const { fetch, calls } = recorder([
    new Response(null, { status: 302, headers: { location: 'https://cdn.demo.test/file' } }),
    json({ ok: true }),
  ]);

  const result = expectOk(
    await executeOperation(operation, { number: 7 }, { baseUrl: 'https://api.demo.test', fetch, bindings, secrets }),
  );

  assert.deepEqual(result.payload, { ok: true });
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.headers['authorization'], 'Bearer top-secret-value');
  assert.equal(calls[1]?.headers['authorization'], undefined, 'the credential must not travel across origins');
  assert.deepEqual(result.redirects, ['https://cdn.demo.test/file']);
});

test('a same-origin redirect keeps the credential', async () => {
  const { fetch, calls } = recorder([new Response(null, { status: 307, headers: { location: '/issues/7?page=2' } }), json({ ok: true })]);
  expectOk(await executeOperation(operation, { number: 7 }, { baseUrl: 'https://api.demo.test', fetch, bindings, secrets }));

  assert.equal(calls[1]?.headers['authorization'], 'Bearer top-secret-value');
  assert.equal(calls[1]?.url, 'https://api.demo.test/issues/7?page=2');
});

test('redirect loops stop at the policy limit', async () => {
  const { fetch } = recorder([new Response(null, { status: 302, headers: { location: '/again' } })]);

  const error = expectErr(
    await executeOperation(operation, { number: 7 }, { baseUrl: 'https://api.demo.test', fetch, bindings, secrets, policy: { maxRedirects: 2 } }),
  );
  assert.equal(error.code, 'too_many_redirects');
});

test('a redirect to a refused scheme is blocked, not followed', async () => {
  const { fetch, calls } = recorder([new Response(null, { status: 302, headers: { location: 'http://insecure.demo.test/x' } })]);

  const error = expectErr(await executeOperation(operation, { number: 7 }, { baseUrl: 'https://api.demo.test', fetch, bindings, secrets }));
  assert.equal(error.code, 'blocked_scheme');
  assert.equal(calls.length, 1, 'the refused target is never requested');
});

test('http errors are data with status and a short body hint', async () => {
  const { fetch } = recorder([json({ message: 'Not Found' }, 404)]);
  const error = expectErr(await executeOperation(operation, { number: 7 }, { baseUrl: 'https://api.demo.test', fetch, bindings, secrets }));

  assert.equal(error.code, 'http_error');
  assert.equal(error.status, 404);
  assert.match(error.hint ?? '', /Not Found/);
});

test('an oversized response is refused before it becomes an envelope', async () => {
  const { fetch } = recorder([json({ blob: 'x'.repeat(500) })]);
  const error = expectErr(
    await executeOperation(operation, { number: 7 }, {
      baseUrl: 'https://api.demo.test',
      fetch,
      bindings,
      secrets,
      policy: normalisePolicy({ maxBytes: 64 }),
    }),
  );
  assert.equal(error.code, 'response_too_large');
});

test('a timeout is reported as a timeout, not a generic failure', async () => {
  const fetch: FetchLike = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    });

  const error = expectErr(
    await executeOperation(operation, { number: 7 }, {
      baseUrl: 'https://api.demo.test',
      fetch,
      bindings,
      secrets,
      policy: normalisePolicy({ timeoutMs: 5 }),
    }),
  );
  assert.equal(error.code, 'timeout');
});

test('a network failure keeps the message and drops nothing else', async () => {
  const fetch: FetchLike = async () => {
    throw new Error('ECONNREFUSED');
  };
  const error = expectErr(await executeOperation(operation, { number: 7 }, { baseUrl: 'https://api.demo.test', fetch, bindings, secrets }));
  assert.equal(error.code, 'network');
  assert.match(error.message, /ECONNREFUSED/);
});

test('a secret bound elsewhere is refused before any request is made', async () => {
  const { fetch, calls } = recorder([json({})]);
  const error = expectErr(
    await executeOperation(operation, { number: 7 }, {
      baseUrl: 'https://other.demo.test',
      fetch,
      bindings,
      secrets,
    }),
  );

  assert.equal(error.code, 'secret_unbound');
  assert.equal(calls.length, 0);
});

test('a bound secret with no value is a named failure', async () => {
  const { fetch, calls } = recorder([json({})]);
  const error = expectErr(
    await executeOperation(operation, { number: 7 }, {
      baseUrl: 'https://api.demo.test',
      fetch,
      bindings,
      secrets: staticSecrets({}),
    }),
  );

  assert.equal(error.code, 'secret_missing');
  assert.match(error.hint ?? '', /DEMO_TOKEN/);
  assert.equal(calls.length, 0);
});

test('a private target is blocked even when the map asks for it', async () => {
  const { fetch, calls } = recorder([json({})]);
  const error = expectErr(await executeOperation(operation, { number: 7 }, { baseUrl: 'https://10.0.0.5', fetch, bindings, secrets }));
  assert.equal(error.code, 'blocked_host');
  assert.equal(calls.length, 0);
});

test('a hostname resolving to a private address is blocked by the resolver check', async () => {
  const { fetch, calls } = recorder([json({})]);
  const error = expectErr(
    await executeOperation(operation, { number: 7 }, {
      baseUrl: 'https://api.demo.test',
      fetch,
      bindings,
      secrets,
      lookup: async () => ['10.1.2.3'],
    }),
  );

  assert.equal(error.code, 'blocked_host');
  assert.match(error.message, /resolves to the private address/);
  assert.equal(calls.length, 0);
});

test('arguments are validated before the network is touched', async () => {
  const { fetch, calls } = recorder([json({})]);
  const error = expectErr(await executeOperation(operation, { number: 'not-a-number' }, { baseUrl: 'https://api.demo.test', fetch, bindings, secrets }));

  assert.equal(error.code, 'invalid_argument');
  assert.equal(calls.length, 0);
});
