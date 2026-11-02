// Smoke test: load a map, dry-run, execute, store, read back.
//
// Run with: node examples/runtime-smoke.ts
//
// This one makes a live request to a public, credential-free API. It uses the
// in-memory store so it writes nothing to disk.

import path from 'node:path';

import { MemoryStore } from '../src/store/store.ts';
import { loadMaps } from '../src/map/load.ts';
import { readHandle, runOperation } from '../src/runtime/run.ts';

const catalog = await loadMaps([{ path: path.join(import.meta.dirname, 'maps'), label: 'examples' }]);

const loaded = catalog.maps.get('dummyjson');
if (!loaded) {
  console.error('map did not load:', catalog.issues);
  process.exit(1);
}

const store = new MemoryStore();

const plan = await runOperation(loaded.map, 'products.list', { limit: 5 }, { store, baseUrl: loaded.map.baseUrl, dryRun: true });
if (!plan.ok) {
  console.error('dry run failed:', plan.error);
  process.exit(1);
}
console.log('dry run:', JSON.stringify(plan.value, null, 2));

const run = await runOperation(loaded.map, 'products.list', { limit: 5 }, { store, baseUrl: loaded.map.baseUrl, fetch });
if (!run.ok) {
  console.error('run failed:', run.error);
  process.exit(1);
}
if (run.value.dryRun) throw new Error('unexpected dry run');

const { envelope, handle } = run.value;
console.log('\nenvelope:', envelope.summary);
console.log('fields:  ', envelope.fields?.join(', '));
console.log('bytes:   ', envelope.bytes, `(source ${envelope.sourceBytes})`);
console.log('handle:  ', handle);
console.log('hint:    ', envelope.hint ?? '(none)');
console.log('rows:');
for (const row of envelope.rows ?? []) console.log('  ', row.join('  |  '));

const first = await readHandle(store, handle, '/products/0', { maxItems: 8 });
if (!first.ok) console.error('read failed:', first.error);
else {
  console.log('\nread /products/0 (no network):');
  console.log(first.value.text);
}
