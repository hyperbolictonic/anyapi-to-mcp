import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { humanEntries, writeMap } from '../../src/map/write.ts';
import type { MapDocument } from '../../src/map/types.ts';
import { MAP_SCHEMA_VERSION } from '../../src/map/types.ts';

const scratch: string[] = [];

after(async () => {
  await Promise.all(scratch.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function directory(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'wrap2mcp-write-'));
  scratch.push(dir);
  return dir;
}

function generated(): MapDocument {
  return {
    schemaVersion: MAP_SCHEMA_VERSION,
    id: 'demo',
    title: 'Demo',
    baseUrl: 'https://api.example.com',
    provenance: { source: 'spec', date: '2026-11-01' },
    resources: [{ id: 'thing', title: 'Thing' }],
    operations: [
      {
        id: 'thing.list',
        resource: 'thing',
        title: 'List things',
        provenance: 'spec',
        request: { method: 'GET', path: '/things' },
        view: { select: '/', mode: 'rows' },
      },
    ],
    links: [],
  };
}

test('writes an indented JSON file and creates the directory', async () => {
  const dir = await directory();
  const file = path.join(dir, 'nested', 'demo.json');

  const result = await writeMap(generated(), { file });
  assert.equal(result.ok, true, result.ok ? '' : result.error.message);

  const text = await readFile(file, 'utf8');
  assert.ok(text.endsWith('\n'));
  assert.deepEqual(JSON.parse(text), generated());
});

test('a dry run reports the destination and writes nothing', async () => {
  const dir = await directory();
  const file = path.join(dir, 'demo.json');

  const result = await writeMap(generated(), { file, dryRun: true });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.wrote, false);
  await assert.rejects(readFile(file, 'utf8'));
});

test('an invalid map is refused before it reaches the disk', async () => {
  const dir = await directory();
  const file = path.join(dir, 'demo.json');

  const broken = { ...generated(), operations: [{ id: 'thing.list', resource: 'missing', title: 'x', request: { method: 'GET', path: '/x' } }] };
  const result = await writeMap(broken as MapDocument, { file });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, 'invalid_map');
    assert.match(result.error.details?.[0] ?? '', /is not a declared resource/);
  }
  await assert.rejects(readFile(file, 'utf8'));
});

test('refuses to overwrite human work, and names it', async () => {
  const dir = await directory();
  const file = path.join(dir, 'demo.json');

  const human: MapDocument = {
    ...generated(),
    provenance: { source: 'human', date: '2026-11-01' },
    operations: generated().operations.map((operation) => ({ ...operation, provenance: 'human' as const })),
    links: [{ from: 'thing', field: 'owner_id', to: 'thing', operation: 'thing.list', argument: 'id', provenance: 'human' }],
  };

  assert.deepEqual(humanEntries(human), ['$.provenance', 'operation thing.list', 'link thing.owner_id -> thing']);
  await writeFile(file, JSON.stringify(human), 'utf8');

  const blocked = await writeMap(generated(), { file });
  assert.equal(blocked.ok, false);
  if (!blocked.ok) {
    assert.equal(blocked.error.code, 'human_provenance');
    assert.deepEqual(blocked.error.details, ['$.provenance', 'operation thing.list', 'link thing.owner_id -> thing']);
  }

  const forced = await writeMap(generated(), { file, force: true });
  assert.equal(forced.ok, true);
  if (forced.ok) assert.equal(forced.value.replaced, true);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), generated());
});

test('a previously generated map is replaced without asking', async () => {
  const dir = await directory();
  const file = path.join(dir, 'demo.json');

  await writeMap(generated(), { file });
  const again = await writeMap({ ...generated(), title: 'Demo 2' }, { file });

  assert.equal(again.ok, true);
  if (again.ok) assert.equal(again.value.replaced, false);
  assert.equal((JSON.parse(await readFile(file, 'utf8')) as MapDocument).title, 'Demo 2');
});
