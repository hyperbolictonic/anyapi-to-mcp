import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import { readApiDocument } from '../../src/import/file.ts';
import { importOpenApi } from '../../src/import/openapi.ts';
import type { MapDocument } from '../../src/map/types.ts';

const fixtures = path.join(import.meta.dirname, 'fixtures');

test('a YAML document reaches the importer exactly like JSON', async () => {
  const read = await readApiDocument(path.join(fixtures, 'widgets.yaml'));
  assert.equal(read.ok, true, read.ok ? '' : `${read.error.code}: ${read.error.message}`);
  if (!read.ok) return;
  assert.equal(read.value.format, 'yaml');

  const imported = importOpenApi(read.value.document, { today: '2026-11-01' });
  assert.equal(imported.ok, true, imported.ok ? '' : imported.error.message);
  if (!imported.ok) return;

  const map: MapDocument = imported.value.map;
  assert.equal(map.id, 'widgets');
  assert.equal(map.baseUrl, 'https://widgets.example.com/v1');
  assert.deepEqual(map.resources.map((resource) => resource.id), ['widget']);
  assert.deepEqual(map.operations.map((operation) => operation.id).sort(), ['widget.create', 'widget.get', 'widget.list']);

  const list = map.operations.find((operation) => operation.id === 'widget.list');
  assert.deepEqual(list?.view, { select: '/', mode: 'rows', fields: ['id', 'name'] });
  assert.deepEqual(list?.input?.properties?.['status'], { type: 'string', enum: ['active', 'retired'] });

  const create = map.operations.find((operation) => operation.id === 'widget.create');
  assert.deepEqual(create?.request.body, { name: '{name}' });
});

test('a broken YAML document reports a line number', async () => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wrap2mcp-yaml-'));
  const file = path.join(dir, 'broken.yaml');

  try {
    await fs.writeFile(file, 'openapi: 3.0.3\ninfo:\n\t title: tabs\n', 'utf8');
    const read = await readApiDocument(file);
    assert.equal(read.ok, false);
    if (!read.ok) {
      assert.equal(read.error.code, 'invalid_yaml');
      assert.match(read.error.message, /:3: tabs are not allowed/);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a JSON document is parsed as JSON, and a bad one says so', async () => {
  const good = await readApiDocument(path.join(fixtures, 'petstore.json'));
  assert.equal(good.ok, true);
  if (good.ok) assert.equal(good.value.format, 'json');

  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wrap2mcp-json-'));
  const file = path.join(dir, 'truncated.json');

  try {
    await fs.writeFile(file, '{"openapi": "3.0.3",', 'utf8');
    const bad = await readApiDocument(file);
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.equal(bad.error.code, 'invalid_json');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a missing file is an actionable error', async () => {
  const read = await readApiDocument(path.join(fixtures, 'nope.yaml'));
  assert.equal(read.ok, false);
  if (!read.ok) {
    assert.equal(read.error.code, 'not_found');
    assert.match(read.error.hint ?? '', /OpenAPI 3 document/);
  }
});
