import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import { loadLocation, loadMaps } from '../../src/map/load.ts';
import type { MapLoadIssue } from '../../src/map/load.ts';

const fixtures = path.join(import.meta.dirname, 'fixtures');

function errorsOf(issues: readonly MapLoadIssue[]): string[] {
  return issues.filter((issue) => issue.severity === 'error').map((issue) => `${issue.path}: ${issue.message}`);
}

test('loads a single map file', async () => {
  const maps = await loadLocation({ path: path.join(fixtures, 'github.json') });
  assert.equal(maps.length, 1);
  assert.equal(maps[0]?.id, 'github');
  assert.equal(maps[0]?.schemaVersion, 2);
});

test('a split directory merges fragments into the index map', async () => {
  const issues: MapLoadIssue[] = [];
  const maps = await loadLocation({ path: path.join(fixtures, 'split') }, issues);

  assert.deepEqual(errorsOf(issues), []);
  assert.equal(maps.length, 1);

  const map = maps[0]!;
  assert.equal(map.id, 'dummyjson');
  assert.equal(map.operations.length, 2);
  assert.equal(map.operations[1]?.id, 'products.get');
  assert.equal(map.resources.length, 1);
  // The merged whole is revalidated, so a dangling reference in a fragment fails.
  assert.ok(map.operations.every((operation) => operation.resource === 'product'));
});

test('a missing location is absent, not an error', async () => {
  const issues: MapLoadIssue[] = [];
  const maps = await loadLocation({ path: path.join(fixtures, 'does-not-exist') }, issues);
  assert.equal(maps.length, 0);
  assert.deepEqual(errorsOf(issues), []);
});

test('the first location wins and the shadowed map is reported', async () => {
  const catalog = await loadMaps([
    { path: path.join(fixtures, 'github.json'), label: 'project' },
    { path: path.join(fixtures, 'github.json'), label: 'user' },
  ]);

  assert.equal(catalog.maps.size, 1);
  assert.equal(catalog.maps.get('github')?.tier, 'project');
  assert.match(catalog.issues.map((issue) => issue.message).join('\n'), /shadowed by the project location/);
});

test('overrides win field by field and are marked human', async () => {
  const catalog = await loadMaps(
    [{ path: path.join(fixtures, 'github.json'), label: 'project' }],
    [{ path: path.join(fixtures, 'overrides') }],
  );

  const loaded = catalog.maps.get('github');
  assert.ok(loaded);

  const operation = loaded.map.operations.find((entry) => entry.id === 'repo.get');
  assert.ok(operation);
  assert.equal(operation.title, 'Get a repository (human-corrected)');
  assert.equal(operation.view?.mode, 'document');
  assert.equal(operation.provenance, 'human');

  // Untouched parts survive the merge.
  assert.equal(operation.request.path, '/repos/{owner}/{repo}');
  assert.equal(loaded.map.operations.length, 2);
  assert.equal(loaded.map.resources.length, 2);
  assert.ok(loaded.warnings.some((warning) => warning.message === 'overridden'));
});

test('a legacy wrapper is projected into a runnable operation', async () => {
  const issues: MapLoadIssue[] = [];
  const maps = await loadLocation({ path: path.join(fixtures, 'legacy', 'example.json') }, issues);

  assert.deepEqual(errorsOf(issues), []);
  assert.equal(maps.length, 1);

  const map = maps[0]!;
  assert.equal(map.schemaVersion, 2);
  assert.equal(map.id, 'old-wrapper');
  assert.equal(map.baseUrl, 'https://example.test/api');
  assert.equal(map.operations.length, 1);

  const operation = map.operations[0]!;
  assert.equal(operation.id, 'old-wrapper.list-things');
  assert.equal(operation.provenance, 'human');
  assert.equal(operation.mutating, false);
  // Placeholders become required string inputs, so the operation is describable.
  assert.deepEqual([...(operation.input?.required ?? [])].sort(), ['limit', 'thingId']);
  assert.equal(operation.input?.properties?.['thingId']?.type, 'string');
  // Legacy mode names survive projection; the view layer normalises them.
  assert.equal(operation.view?.mode, 'documents');
  assert.equal(operation.request.query?.['limit'], '{limit}');
});

test('a broken map file is reported with its path and does not throw', async () => {
  const issues: MapLoadIssue[] = [];
  const maps = await loadLocation({ path: path.join(fixtures, 'broken.json') }, issues);
  assert.equal(maps.length, 0);
  assert.ok(issues.some((issue) => issue.severity === 'error' && issue.file.endsWith('broken.json')));
});
