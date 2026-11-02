import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { importOpenApi } from '../../src/import/openapi.ts';
import { writeMap } from '../../src/map/write.ts';
import { loadMaps } from '../../src/map/load.ts';
import type { MapDocument } from '../../src/map/types.ts';

const fixture = path.join(import.meta.dirname, 'fixtures', 'petstore.json');
const scratch: string[] = [];

after(async () => {
  await Promise.all(scratch.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function spec(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(fixture, 'utf8')) as Record<string, unknown>;
}

function imported(document: unknown): MapDocument {
  const result = importOpenApi(document, { today: '2026-11-01' });
  assert.equal(result.ok, true, result.ok ? '' : result.error.message);
  if (!result.ok) throw new Error('unreachable');
  return result.value.map;
}

test('regenerating from a changed spec keeps human overrides', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wrap2mcp-regen-'));
  scratch.push(dir);
  const maps = path.join(dir, 'maps');
  const overrides = path.join(dir, 'overrides');
  const mapFile = path.join(maps, 'petstore.json');

  const first = await writeMap(imported(await spec()), { file: mapFile });
  assert.equal(first.ok, true, first.ok ? '' : first.error.message);

  // A human decides `pet.list` reads better as "Browse pets" — in an overrides
  // file, not by editing the generated map.
  await mkdir(overrides, { recursive: true });
  await writeFile(
    path.join(overrides, 'petstore.json'),
    JSON.stringify({ id: 'petstore', operations: [{ id: 'pet.list', title: 'Browse pets' }] }),
    'utf8',
  );

  const before = await loadMaps([{ path: maps }], [{ path: overrides }]);
  const beforeList = before.maps.get('petstore')?.map.operations.find((operation) => operation.id === 'pet.list');
  assert.equal(beforeList?.title, 'Browse pets');
  assert.equal(beforeList?.provenance, 'human');

  // The spec gains an operation. Regeneration needs no --force, because the
  // generated file itself contains no human entries.
  const changed = await spec();
  const paths = changed['paths'] as Record<string, Record<string, unknown>>;
  paths['/pets/{petId}/toys'] = {
    get: {
      summary: "List a pet's toys",
      parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'integer' } }],
      responses: { '200': { description: 'ok' } },
    },
  };

  const regenerated = await writeMap(imported(changed), { file: mapFile });
  assert.equal(regenerated.ok, true, regenerated.ok ? '' : regenerated.error.message);

  const after = await loadMaps([{ path: maps }], [{ path: overrides }]);
  const map = after.maps.get('petstore')?.map;
  assert.ok(map);

  assert.ok(map.operations.some((operation) => operation.id === 'toy.list'), 'the new operation arrived');
  assert.ok(map.resources.some((resource) => resource.id === 'toy'));

  const list = map.operations.find((operation) => operation.id === 'pet.list');
  assert.equal(list?.title, 'Browse pets');
  assert.equal(list?.provenance, 'human');
});
