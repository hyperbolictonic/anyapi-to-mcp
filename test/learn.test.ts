import assert from 'node:assert/strict';
import { test } from 'node:test';

import { inferSchema, learnFromSample } from '../src/learn.ts';
import type { LearnReport } from '../src/learn.ts';
import { MemoryStore } from '../src/store/store.ts';
import { validateMap } from '../src/map/validate.ts';
import type { FetchLike } from '../src/runtime/execute.ts';

const products = [
  { id: 1, title: 'Mascara', price: 9.99, meta: { brand: 'Essence' } },
  { id: 2, title: 'Palette', price: 19.99, stock: 4 },
];

function fakeFetch(payload: unknown, status = 200): { fetch: FetchLike; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fetch: async (url) => {
      calls.push(url);
      return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
    },
  };
}

async function learn(payload: unknown, url = 'https://dummyjson.com/products', extra: Record<string, unknown> = {}): Promise<LearnReport> {
  const { fetch } = fakeFetch(payload);
  const result = await learnFromSample({
    url,
    store: new MemoryStore(),
    fetch,
    today: '2026-11-01',
    ...extra,
  });

  assert.equal(result.ok, true, result.ok ? '' : `${result.error.code}: ${result.error.message}`);
  if (!result.ok) throw new Error('unreachable');
  return result.value;
}

test('a bare array becomes a rows operation on the last path segment', async () => {
  const report = await learn(products);
  const map = report.map;

  assert.equal(map.id, 'product');
  assert.equal(map.baseUrl, 'https://dummyjson.com');
  assert.equal(map.provenance?.source, 'learned');
  assert.deepEqual(map.resources.map((resource) => resource.id), ['product']);
  assert.equal(map.resources[0]?.key, 'id');

  const operation = map.operations[0]!;
  assert.equal(operation.id, 'product.list');
  assert.equal(operation.provenance, 'learned');
  assert.deepEqual(operation.view, {
    select: '/',
    mode: 'rows',
    fields: ['id', 'title', 'price', 'meta.brand', 'stock'],
  });

  assert.equal(report.sample.items, 2);
  assert.equal(report.handle.startsWith('r_'), true);
  assert.deepEqual(validateMap(map).issues.filter((issue) => issue.severity === 'error'), []);
});

test('a wrapped collection selects the wrapper path it found', async () => {
  const report = await learn({ total: 2, data: products });
  const operation = report.map.operations[0]!;

  assert.equal(operation.view?.select, '/data');
  assert.equal(operation.view?.mode, 'rows');
  assert.ok(report.issues.some((issue) => issue.path === 'view.select' && issue.message.includes('/data')));
});

test('a single object becomes a document, not an empty table', async () => {
  const report = await learn({ id: 1, title: 'Mascara' });
  const operation = report.map.operations[0]!;

  assert.equal(operation.id, 'product.get');
  assert.equal(operation.view?.mode, 'document');
  assert.equal(report.sample.items, null);
});

test('the sample URL query is kept literally and says so', async () => {
  const report = await learn(products, 'https://dummyjson.com/products?limit=3&skip=0');

  assert.deepEqual(report.map.operations[0]?.request.query, { limit: '3', skip: '0' });
  assert.ok(report.issues.some((issue) => issue.message.includes('query string was kept literally')));
});

test('the map is honest that one sample is one sample', async () => {
  const report = await learn(products);
  assert.ok(report.issues.some((issue) => issue.message.includes('inferred from one sample')));
  assert.match(report.map.description ?? '', /One sample cannot show optional fields/);
});

test('an unbound secret is refused before any request', async () => {
  const { fetch, calls } = fakeFetch(products);
  const result = await learnFromSample({
    url: 'https://dummyjson.com/products',
    store: new MemoryStore(),
    fetch,
    secret: 'DUMMY_TOKEN',
  });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'secret_unbound');
  assert.equal(calls.length, 0);
});

test('a URL that is not absolute is an error, not a crash', async () => {
  const result = await learnFromSample({ url: 'not a url', store: new MemoryStore() });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'invalid_url');
});

test('inferSchema unions object keys and keeps the intersection as required', () => {
  const schema = inferSchema([{ a: 1, b: 'x' }, { a: 2, c: true }]) as {
    items: { properties: Record<string, unknown>; required?: string[] };
  };

  assert.deepEqual(Object.keys(schema.items.properties), ['a', 'b', 'c']);
  assert.deepEqual(schema.items.required, ['a']);
  assert.deepEqual(schema.items.properties['a'], { type: 'integer' });
});
