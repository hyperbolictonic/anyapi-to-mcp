import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { importOpenApi } from '../../src/import/openapi.ts';
import type { ImportReport } from '../../src/import/openapi.ts';
import type { MapDocument, Operation } from '../../src/map/types.ts';

const fixture = path.join(import.meta.dirname, 'fixtures', 'petstore.json');

async function petstore(): Promise<MapDocument> {
  const document = JSON.parse(await readFile(fixture, 'utf8')) as unknown;
  const result = importOpenApi(document, { today: '2026-11-01' });
  assert.equal(result.ok, true, result.ok ? '' : result.error.message);
  if (!result.ok) throw new Error('unreachable');
  return result.value.map;
}

async function report(): Promise<ImportReport> {
  const document = JSON.parse(await readFile(fixture, 'utf8')) as unknown;
  const result = importOpenApi(document, { today: '2026-11-01' });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function operation(map: MapDocument, id: string): Operation {
  const found = map.operations.find((entry) => entry.id === id);
  assert.ok(found, `missing operation ${id}; have ${map.operations.map((entry) => entry.id).join(', ')}`);
  return found;
}

test('a real spec imports without validation errors', async () => {
  const value = await report();

  assert.equal(value.issues.filter((issue) => issue.severity === 'error').length, 0, JSON.stringify(value.issues));
  assert.equal(value.map.schemaVersion, 2);
  assert.equal(value.map.id, 'petstore');
  assert.equal(value.map.baseUrl, 'https://api.example.com/v1');
  assert.deepEqual(value.map.provenance, { source: 'spec', date: '2026-11-01' });
});

test('paths become resources, not a URL tree', async () => {
  const map = await petstore();
  const ids = map.resources.map((resource) => resource.id).sort();

  assert.deepEqual(ids, ['avatar', 'owner', 'pet']);
  // `/owners/{ownerId}/pets` is about pets; the owner is a container.
  assert.equal(operation(map, 'pet.owner_list').resource, 'pet');
  assert.equal(operation(map, 'pet.owner_list').returns, 'pet');
});

test('operation ids are resource.action, disambiguated by container', async () => {
  const map = await petstore();
  const ids = map.operations.map((entry) => entry.id).sort();

  assert.deepEqual(ids, ['avatar.replace', 'owner.get', 'pet.create', 'pet.delete', 'pet.get', 'pet.list', 'pet.owner_list']);
  // The deprecated operation is skipped, not imported.
  assert.ok(!map.operations.some((entry) => entry.title === 'Upload a photo'));
});

test('a wrapped collection gets a rows view over the items path', async () => {
  const map = await petstore();
  const list = operation(map, 'pet.list');

  assert.equal(list.view?.mode, 'rows');
  assert.equal(list.view?.select, '/items');
  assert.deepEqual(list.view?.fields, ['id', 'name', 'status', 'created_at', 'tag', 'owner_id']);
});

test('an unwrapped array is rows at the root, and a single object is a document', async () => {
  const map = await petstore();

  assert.equal(operation(map, 'pet.owner_list').view?.select, '/');
  assert.equal(operation(map, 'pet.owner_list').view?.mode, 'rows');
  assert.equal(operation(map, 'pet.get').view?.mode, 'document');
  assert.equal(operation(map, 'pet.get').view?.select, '/');
});

test('inputs come from parameters with type, enum, default and bounds', async () => {
  const map = await petstore();
  const list = operation(map, 'pet.list');
  const properties = list.input?.properties ?? {};

  assert.deepEqual(properties['limit'], { type: 'integer', default: 20, minimum: 1, maximum: 100 });
  assert.deepEqual(properties['status'], { type: 'string', enum: ['available', 'sold'] });
  assert.deepEqual(list.request.query, { limit: '{limit}', offset: '{offset}', status: '{status}' });
  assert.deepEqual(list.input?.required, undefined);
  // An array query parameter cannot be declared, and says so.
  assert.equal(properties['tags'], undefined);

  const get = operation(map, 'pet.get');
  assert.deepEqual(get.input?.required, ['petId']);
  assert.deepEqual(get.input?.properties?.['petId'], { type: 'integer' });
});

test('a JSON body templates required and optional scalars; a multipart body is refused', async () => {
  const map = await petstore();

  // Optional scalars are templated too. A key the caller does not fill is
  // omitted when the request is built, so `tag` is never sent as the literal
  // string "{tag}"; it is simply not part of the body.
  assert.deepEqual(operation(map, 'pet.create').request.body, { name: '{name}', tag: '{tag}', owner_id: '{owner_id}' });
  assert.deepEqual(operation(map, 'pet.create').input?.required, ['name']);
  assert.deepEqual(operation(map, 'pet.create').input?.properties?.['tag'], { type: 'string' });

  assert.equal(operation(map, 'avatar.replace').request.body, undefined);
});

test('an all-optional PATCH body becomes a partial-update template', () => {
  const result = importOpenApi(
    {
      openapi: '3.0.0',
      info: { title: 'Notes', version: '1' },
      servers: [{ url: 'https://notes.example.com' }],
      paths: {
        '/notes/{noteId}': {
          patch: {
            summary: 'Update a note',
            parameters: [{ name: 'noteId', in: 'path', required: true, schema: { type: 'string' } }],
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      title: { type: 'string' },
                      body: { type: 'string' },
                    },
                  },
                },
              },
            },
            responses: { '200': { description: 'ok' } },
          },
        },
      },
    },
    { today: '2026-11-01' },
  );

  assert.equal(result.ok, true, result.ok ? '' : result.error.message);
  if (!result.ok) return;

  const update = result.value.map.operations.find((entry) => entry.request.method === 'PATCH');
  assert.ok(update, 'a PATCH operation was imported');
  assert.deepEqual(update.request.body, { title: '{title}', body: '{body}' });
  // Nothing beyond the path is required, so a caller may send any subset.
  assert.deepEqual(update.input?.required, ['noteId']);
  assert.equal(update.input?.properties?.['title']?.type, 'string');
});

test('offset paging is inferred only when the response carries the fields', async () => {
  const map = await petstore();

  assert.deepEqual(operation(map, 'pet.list').pagination, {
    kind: 'offset',
    totalPath: '/total',
    skipPath: '/offset',
    limitPath: '/limit',
  });
  assert.equal(operation(map, 'pet.get').pagination, undefined);
});

test('an allOf schema is flattened, and links are inferred from *_id fields', async () => {
  const map = await petstore();

  assert.deepEqual(map.links, [
    {
      from: 'pet',
      field: 'owner_id',
      to: 'owner',
      operation: 'owner.get',
      argument: 'ownerId',
      provenance: 'inferred',
    },
  ]);
  assert.equal(map.resources.find((resource) => resource.id === 'pet')?.key, 'id');
});

test('a security scheme becomes a binding name, never a value', async () => {
  const value = await report();

  assert.deepEqual(value.secrets, ['bearerAuth']);
  for (const operation of value.map.operations) {
    if (operation.id === 'pet.create') assert.equal(operation.secret, undefined);
    else assert.equal(operation.secret, 'bearerAuth');
  }
  assert.ok(!JSON.stringify(value.map).toLowerCase().includes('bearer '));
});

test('refuses a Swagger 2.0 document with a conversion hint', () => {
  const result = importOpenApi({ swagger: '2.0', paths: {} });
  assert.equal(result.ok, false);
  if (result.ok) return;

  assert.equal(result.error.code, 'unsupported_version');
  assert.match(result.error.hint ?? '', /swagger2openapi/);
});

test('refuses a document with no usable server unless a base URL is given', () => {
  const document = {
    openapi: '3.1.0',
    info: { title: 'No servers' },
    paths: { '/things': { get: { responses: { '200': { description: 'ok' } } } } },
  };

  const without = importOpenApi(document);
  assert.equal(without.ok, false);
  if (!without.ok) assert.equal(without.error.code, 'no_base_url');

  const withBase = importOpenApi(document, { baseUrl: 'https://api.example.com', today: '2026-11-01' });
  assert.equal(withBase.ok, true);
  if (withBase.ok) assert.equal(withBase.value.map.baseUrl, 'https://api.example.com');
});
