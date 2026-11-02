import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { projectLegacy } from '../../src/map/legacy.ts';

const fixtures = path.join(import.meta.dirname, 'fixtures', 'legacy');

async function load(name: string): Promise<unknown> {
  return JSON.parse(await readFile(path.join(fixtures, name), 'utf8')) as unknown;
}

test('a real wrapper shape projects to a runnable operation', async () => {
  const raw = await load('wrapper-get.json');
  const before = structuredClone(raw);
  const { map, issues } = projectLegacy(raw);

  assert.deepEqual(issues, []);
  assert.ok(map);
  assert.equal(map.id, 'sample.auth.me');
  assert.equal(map.baseUrl, 'https://api.sample.test');
  assert.equal(map.title, 'Sample: who am I');
  assert.equal(map.provenance?.source, 'human');

  const operation = map.operations[0]!;
  assert.equal(operation.id, 'sample.auth.me');
  assert.equal(operation.request.method, 'GET');
  assert.equal(operation.request.path, '/auth/me');
  assert.equal(operation.request.headers?.['Accept'], 'application/json');
  assert.equal(operation.secret, 'sample_token');
  // A login POST is not a write; an explicit `mutating` wins over the method.
  assert.equal(operation.mutating, false);
  assert.equal(operation.view?.select, '/');
  assert.equal(operation.view?.mode, 'document');
  assert.deepEqual(operation.view?.fields, ['firstName', 'lastName', 'email', 'id']);
  assert.equal(operation.input, undefined, 'no placeholders, no required inputs');

  // Projection reads, never rewrites.
  assert.deepEqual(raw, before);
});

test('body placeholders become typed inputs from the wrapper schema', async () => {
  const raw = await load('wrapper-post.json');
  const { map, issues } = projectLegacy(raw);

  assert.deepEqual(issues, []);
  const operation = map!.operations[0]!;
  assert.equal(operation.request.method, 'POST');
  assert.deepEqual(operation.request.body, {
    username: '{username}',
    password: '{password}',
    expiresInMins: '{expires_in_mins}',
  });
  assert.equal(operation.mutating, false, 'explicit mutating: false is respected');
  assert.deepEqual([...(operation.input?.required ?? [])].sort(), ['expires_in_mins', 'password', 'username']);

  const username = operation.input?.properties?.['username'];
  assert.equal(username?.type, 'string');
  assert.equal(username?.default, 'demo');

  const expires = operation.input?.properties?.['expires_in_mins'];
  assert.equal(expires?.type, 'integer');
  assert.equal(expires?.default, 43200);
  assert.equal(expires?.minimum, 1);
  assert.equal(expires?.maximum, 43200);
});

test('{{name|raw}} normalises, undeclared placeholders stay required, and fields keep their format paths', async () => {
  const raw = await load('wrapper-format.json');
  const { map, issues } = projectLegacy(raw);

  assert.deepEqual(issues, []);
  const operation = map!.operations[0]!;
  assert.equal(operation.request.path, '/repos/{owner}/{repo}/readme');
  assert.deepEqual([...(operation.input?.required ?? [])].sort(), ['owner', 'repo']);
  assert.equal(operation.input?.properties?.['owner']?.type, 'string');
  assert.deepEqual(operation.view?.fields, ['name', 'html_url', 'path', 'size']);
  assert.equal(map?.provenance?.date, '2026-10-26T17:50:40.932Z');
});

test('explicit mutating: true is kept, and a missing absolute target is an error', () => {
  const write = projectLegacy({
    schemaVersion: 1,
    id: 'notes.create',
    name: 'Create a note',
    request: { method: 'POST', url: 'https://api.sample.test/notes', body: { text: '{{text}}' } },
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    mutating: true,
  });
  assert.deepEqual(write.issues, []);
  assert.equal(write.map?.operations[0]?.mutating, true);

  const broken = projectLegacy({ schemaVersion: 1, id: 'x', request: { method: 'GET', url: 'not a url' } });
  assert.equal(broken.map, null);
  assert.equal(broken.issues[0]?.severity, 'error');
  assert.match(broken.issues[0]?.message ?? '', /neither absolute nor relative/);
});

test('a relative wrapper URL resolves against the file baseUrl', () => {
  const { map, issues } = projectLegacy({
    schemaVersion: 1,
    id: 'items.list',
    baseUrl: 'https://api.sample.test/v1',
    request: { method: 'GET', url: '/items', query: { page: '{{page}}' } },
    inputSchema: { type: 'object', properties: { page: { type: 'integer', default: 1 } } },
  });

  assert.deepEqual(issues, []);
  assert.equal(map?.baseUrl, 'https://api.sample.test/v1');
  assert.equal(map?.operations[0]?.request.path, '/items');
  assert.equal(map?.operations[0]?.request.query?.['page'], '{page}');
  assert.equal(map?.operations[0]?.input?.properties?.['page']?.type, 'integer');
});

test('the older steps shape still projects', async () => {
  const raw = await load('example.json');
  const { map, issues } = projectLegacy(raw);

  assert.deepEqual(issues, []);
  assert.equal(map?.id, 'old-wrapper');
  assert.equal(map?.operations[0]?.id, 'old-wrapper.list-things');
  assert.equal(map?.operations[0]?.request.path, '/things/{thingId}');
});

test('a form body is projected with a warning instead of silently changing encoding', () => {
  const { map, issues } = projectLegacy({
    schemaVersion: 1,
    id: 'forms.submit',
    request: { method: 'POST', url: 'https://api.sample.test/form', body: 'a={{a}}', bodyFormat: 'form' },
    inputSchema: { type: 'object', properties: { a: { type: 'string' } } },
  });

  assert.ok(map);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.severity, 'warning');
  assert.match(issues[0]?.message ?? '', /form body/);
});
