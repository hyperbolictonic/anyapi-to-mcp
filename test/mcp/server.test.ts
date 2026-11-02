import assert from 'node:assert/strict';
import { PassThrough, Readable } from 'node:stream';
import path from 'node:path';
import { test } from 'node:test';

import { createClient } from '../../src/client.ts';
import { MemoryStore } from '../../src/store/store.ts';
import { TOOLS, createMcpServer } from '../../src/mcp/server.ts';
import type { JsonRpcResponse } from '../../src/mcp/server.ts';
import type { FetchLike } from '../../src/runtime/execute.ts';

const fixtures = path.join(import.meta.dirname, '..', 'map', 'fixtures');

const issues = [{ number: 1, title: 'First', state: 'open', user: { login: 'ann' }, created_at: '2026-10-01T00:00:00Z', comments: 0 }];

function server(fetch?: FetchLike) {
  const client = createClient({
    workspace: { maps: [{ path: path.join(fixtures, 'github.json') }] },
    store: new MemoryStore(),
    env: {},
    ...(fetch === undefined ? {} : { fetch }),
  });
  return createMcpServer({ client });
}

function result(response: JsonRpcResponse | null): Record<string, unknown> {
  assert.ok(response, 'expected a response');
  assert.equal(response.error, undefined, JSON.stringify(response.error));
  return response.result as Record<string, unknown>;
}

function textOf(response: JsonRpcResponse | null): string {
  const content = result(response)['content'] as Array<{ type: string; text: string }>;
  return content[0]?.text ?? '';
}

test('initialize negotiates a protocol version and advertises tools', async () => {
  const response = await server().handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  const payload = result(response);

  assert.equal(payload['protocolVersion'], '2025-06-18');
  assert.deepEqual(payload['capabilities'], { tools: { listChanged: false } });
  assert.equal((payload['serverInfo'] as { name: string }).name, 'wrap2mcp');
  assert.match(String(payload['instructions']), /Start with ls \//);
});

test('an unknown protocol version falls back instead of failing', async () => {
  const response = await server().handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
  assert.equal(result(response)['protocolVersion'], '2025-06-18');
});

test('tools/list exposes the five verbs plus the three pin tools', async () => {
  const response = await server().handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const tools = result(response)['tools'] as Array<{ name: string; inputSchema: { additionalProperties: boolean } }>;

  assert.deepEqual(
    tools.map((tool) => tool.name),
    ['ls', 'find', 'describe', 'run', 'read', 'pin', 'unpin', 'prune'],
  );
  assert.equal(tools.length, TOOLS.length);
  for (const tool of tools) assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} rejects unknown params`);
});

test('tools/call ls returns text the agent can read', async () => {
  const response = await server().handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ls', arguments: {} } });
  const text = textOf(response);
  assert.match(text, /^github\s+GitHub REST/m);
  assert.equal(result(response)['isError'], undefined);
});

test('tools/call run returns an envelope with a handle, and read resolves it', async () => {
  const fetch: FetchLike = async () =>
    new Response(JSON.stringify(issues), { status: 200, headers: { 'content-type': 'application/json' } });
  const mcp = server(fetch);

  const run = await mcp.handle({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'run', arguments: { operation: 'repo.issues.list', args: { owner: 'a', repo: 'b' } } },
  });

  const envelope = JSON.parse(textOf(run)) as { handle: string; mode: string; total: number };
  assert.equal(envelope.mode, 'rows');
  assert.equal(envelope.total, 1);
  assert.match(envelope.handle, /^r_/);

  const read = await mcp.handle({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: { name: 'read', arguments: { handle: envelope.handle, address: '/0' } },
  });

  assert.match(textOf(read), /\/title  "First"/);
});

test('an agent can pin a query, list it, re-resolve it and prune it', async () => {
  const fetch: FetchLike = async () =>
    new Response(JSON.stringify(issues), { status: 200, headers: { 'content-type': 'application/json' } });
  const mcp = server(fetch);

  const pinned = await mcp.handle({
    jsonrpc: '2.0',
    id: 20,
    method: 'tools/call',
    params: {
      name: 'pin',
      arguments: {
        name: 'open-issues',
        operation: 'repo.issues.list',
        args: { owner: 'a', repo: 'b' },
        fields: ['number', 'title'],
        note: 'what we are watching',
      },
    },
  });

  assert.equal(result(pinned)['isError'], undefined);
  assert.match(textOf(pinned), /^pinned open-issues — repo\.issues\.list {2}\[ok\]/m);

  const listed = await mcp.handle({ jsonrpc: '2.0', id: 21, method: 'tools/call', params: { name: 'ls', arguments: { path: '/pins' } } });
  assert.match(textOf(listed), /open-issues\s+ok\s+repo\.issues\.list/);

  const read = await mcp.handle({
    jsonrpc: '2.0',
    id: 22,
    method: 'tools/call',
    params: { name: 'read', arguments: { handle: '@open-issues' } },
  });
  assert.match(textOf(read), /^@open-issues — repo\.issues\.list → \//m);

  const pruned = await mcp.handle({
    jsonrpc: '2.0',
    id: 23,
    method: 'tools/call',
    params: { name: 'prune', arguments: {} },
  });
  assert.match(textOf(pruned), /nothing to remove/);

  const removed = await mcp.handle({
    jsonrpc: '2.0',
    id: 24,
    method: 'tools/call',
    params: { name: 'unpin', arguments: { name: 'open-issues' } },
  });
  assert.match(textOf(removed), /unpinned open-issues/);
});

test('a tool failure is a result with isError, not a protocol error', async () => {  const response = await server().handle({
    jsonrpc: '2.0',
    id: 6,
    method: 'tools/call',
    params: { name: 'describe', arguments: { operation: 'nope.nothing' } },
  });

  assert.equal(response?.error, undefined);
  assert.equal(result(response)['isError'], true);
  assert.match(textOf(response), /no operation 'nope\.nothing'/);
});

test('an unknown tool and an unknown method are protocol errors with codes', async () => {
  const tool = await server().handle({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'delete' } });
  assert.equal(tool?.error?.code, -32602);
  assert.deepEqual(tool?.error?.data, { tools: ['ls', 'find', 'describe', 'run', 'read', 'pin', 'unpin', 'prune'] });

  const method = await server().handle({ jsonrpc: '2.0', id: 8, method: 'resources/list' });
  assert.equal(method?.error?.code, -32601);
});

test('notifications get no response', async () => {
  assert.equal(await server().handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal(await server().handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: {} }), null);
});

test('start() speaks newline-delimited JSON-RPC over a stream', async () => {
  const input = Readable.from([
    `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`,
    `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
    `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`,
    'not json\n',
  ]);

  const sink = new PassThrough();
  let collected = '';
  sink.on('data', (chunk: Buffer) => {
    collected += chunk.toString('utf8');
  });

  await server().start(input, sink);

  const lines = collected.trim().split('\n').map((line) => JSON.parse(line) as JsonRpcResponse);
  assert.equal(lines.length, 3, 'two responses and one parse error');
  assert.equal((lines[0]?.result as { protocolVersion: string }).protocolVersion, '2025-06-18');
  assert.ok(Array.isArray((lines[1]?.result as { tools: unknown[] }).tools));
  assert.equal(lines[2]?.error?.code, -32700);
});
