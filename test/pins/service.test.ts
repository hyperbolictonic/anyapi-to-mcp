import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { MapCatalog, LoadedMap } from '../../src/map/load.ts';
import type { MapDocument } from '../../src/map/types.ts';
import { MemoryPinStore, pinFromDraft } from '../../src/pins.ts';
import type { PinStore } from '../../src/pins.ts';
import { MemoryStore } from '../../src/store/store.ts';
import type { PayloadStore } from '../../src/store/store.ts';
import type { FetchLike } from '../../src/runtime/execute.ts';
import { createPin, prunePins, readPin, unpin } from '../../src/pin-service.ts';
import type { PinContext } from '../../src/pin-service.ts';

const now = new Date('2026-11-01T12:00:00.000Z');

const map: MapDocument = {
  schemaVersion: 2,
  id: 'demo',
  title: 'Demo API',
  baseUrl: 'https://api.example.com',
  resources: [{ id: 'item', title: 'Item', key: 'id' }],
  operations: [
    {
      id: 'item.list',
      resource: 'item',
      title: 'List items',
      request: { method: 'GET', path: '/items' },
      input: { required: [], properties: { limit: { type: 'integer', default: 10 } } },
      view: { select: '/items', mode: 'rows', fields: ['id', 'name'] },
    },
    {
      id: 'item.create',
      resource: 'item',
      title: 'Create an item',
      mutating: true,
      request: { method: 'POST', path: '/items', body: { name: '{name}' } },
      input: { required: ['name'], properties: { name: { type: 'string' } } },
      view: { select: '/', mode: 'document' },
    },
    {
      id: 'item.secret',
      resource: 'item',
      title: 'Secret items',
      secret: 'TOKEN',
      request: { method: 'GET', path: '/items' },
      input: { required: [], properties: {} },
      view: { select: '/items', mode: 'rows', fields: ['id'] },
    },
  ],
  links: [],
};

function catalog(document: MapDocument = map): MapCatalog {
  const loaded: LoadedMap = { map: document, source: 'memory', tier: 'test', warnings: [] };
  return { maps: new Map([[document.id, loaded]]), issues: [] };
}

const items = {
  items: [
    { id: 1, name: 'alpha', cha: 3 },
    { id: 2, name: 'beta', cha: 5 },
  ],
  total: 2,
};

function context(options: {
  readonly catalog?: MapCatalog;
  readonly pins?: PinStore;
  readonly store?: PayloadStore;
  readonly fetch?: FetchLike;
} = {}): PinContext {
  const pinStore = options.pins ?? new MemoryPinStore();
  const store = options.store ?? new MemoryStore();
  const fetch =
    options.fetch ??
    (async () => new Response(JSON.stringify(items), { status: 200, headers: { 'content-type': 'application/json' } }));

  return {
    catalog: options.catalog ?? catalog(),
    pins: pinStore,
    store,
    runOptions: (document) => ({
      baseUrl: document.baseUrl,
      store,
      fetch,
      now: () => now.getTime(),
    }),
    now: () => now,
  };
}

test('a good pin resolves once, persists ok, and applies the pin view', async () => {
  const pins = new MemoryPinStore();
  const result = await createPin(
    { name: 'all', operation: 'item.list', address: '/items', fields: ['id', 'name'] },
    context({ pins }),
  );

  assert.equal(result.isError, false);
  assert.match(result.text, /^pinned all — item\.list {2}\[ok\]/m);
  assert.match(result.text, /address: \/items {2}fields=id,name/);

  const loaded = await pins.list();
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;

  const pin = loaded.value.pins[0];
  assert.equal(pin?.state, 'ok');
  assert.equal(pin?.failCount, 0);
  assert.equal(pin?.lastResolved, now.toISOString());
  assert.match(pin?.lastHandle ?? '', /^r_[0-9a-f]{16}$/);

  const data = result.data as { envelope?: { fields?: string[]; rows?: unknown[] } };
  assert.deepEqual(data.envelope?.fields, ['id:int', 'name:str']);
  assert.equal(data.envelope?.rows?.length, 2);
});

test('a pin may select by key instead of by position', async () => {
  const pins = new MemoryPinStore();
  const result = await createPin(
    { name: 'beta', operation: 'item.list', address: "/items[name='beta']" },
    context({ pins }),
  );

  assert.equal(result.isError, false);
  const data = result.data as { envelope?: { rows?: (string | number)[][] } };
  assert.equal(data.envelope?.rows?.length, 1);
  assert.equal(data.envelope?.rows?.[0]?.[1], 'beta');
});

test('a pin that fails to resolve is saved and marked, not deleted', async () => {
  const pins = new MemoryPinStore();
  const result = await createPin(
    { name: 'ghost', operation: 'item.list', address: "/items[name='nobody']" },
    context({ pins }),
  );

  // Creating is not an error: the pin exists, and its state is the answer.
  assert.equal(result.isError, false);
  assert.match(result.text, /^pinned \(unresolved\) ghost/m);
  assert.match(result.text, /broken:selector_miss/);
  assert.match(result.text, /not deleted/);

  const loaded = await pins.list();
  assert.equal(loaded.ok, true);
  if (loaded.ok) assert.equal(loaded.value.pins[0]?.state, 'broken:selector_miss');
});

test('an operation that does not exist cannot be pinned at all', async () => {
  const pins = new MemoryPinStore();
  const result = await createPin({ name: 'nope', operation: 'item.missing' }, context({ pins }));

  assert.equal(result.isError, true);
  assert.equal((result.data as { error?: string }).error, 'unknown_operation');

  const loaded = await pins.list();
  assert.equal(loaded.ok, true);
  if (loaded.ok) assert.equal(loaded.value.pins.length, 0);
});

test('a mutating operation cannot be pinned, because a read would repeat it', async () => {
  const pins = new MemoryPinStore();
  const result = await createPin({ name: 'write', operation: 'item.create', args: { name: 'x' } }, context({ pins }));

  assert.equal(result.isError, true);
  assert.equal((result.data as { error?: string }).error, 'mutating_operation');

  const loaded = await pins.list();
  assert.equal(loaded.ok, true);
  if (loaded.ok) assert.equal(loaded.value.pins.length, 0);
});

test('a POST without `mutating: true` is still refused as a pin', async () => {
  // A hand-written map may forget the flag; the method alone must be enough to
  // keep a saved query from replaying a write.
  const undeclared: MapDocument = {
    ...map,
    operations: map.operations.map((operation) => {
      if (operation.id !== 'item.create') return operation;
      const { mutating: _forgotten, ...rest } = operation;
      return rest;
    }),
  };

  const pins = new MemoryPinStore();
  const result = await createPin(
    { name: 'write', operation: 'item.create', args: { name: 'x' } },
    context({ pins, catalog: catalog(undeclared) }),
  );

  assert.equal(result.isError, true);
  assert.equal((result.data as { error?: string }).error, 'mutating_operation');
});

test('a dry run validates without resolving or writing', async () => {
  const pins = new MemoryPinStore();
  const calls: string[] = [];
  const result = await createPin(
    { name: 'later', operation: 'item.list', address: '/items' },
    context({
      pins,
      fetch: async (url) => {
        calls.push(url);
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      },
    }),
    { dryRun: true },
  );

  assert.notEqual(result.isError, true);
  assert.match(result.text, /^would pin later/m);
  assert.match(result.text, /dry run/);
  assert.equal(calls.length, 0);

  const loaded = await pins.list();
  assert.equal(loaded.ok, true);
  if (loaded.ok) assert.equal(loaded.value.pins.length, 0);
});

test('an undeclared argument is refused before anything is stored', async () => {
  const pins = new MemoryPinStore();
  const result = await createPin({ name: 'typo', operation: 'item.list', args: { limt: '3' } }, context({ pins }));

  assert.equal(result.isError, true);
  assert.match(result.text, /limt/);
});

test('reading a pin re-resolves it over the network every time', async () => {
  const pins = new MemoryPinStore();
  const calls: string[] = [];
  const ctx = context({
    pins,
    fetch: async (url) => {
      calls.push(url);
      return new Response(JSON.stringify(items), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });

  await createPin({ name: 'all', operation: 'item.list', address: '/items', fields: ['name'] }, ctx);
  assert.equal(calls.length, 1);

  const first = await readPin('all', ctx);
  const second = await readPin('all', ctx);
  assert.equal(calls.length, 3);

  assert.match(first.text, /^@all — item\.list → \/items {2}\[ok\]/m);
  assert.equal(second.isError, undefined);
});

test('reading a pin can drill into another address without changing the pin', async () => {
  const pins = new MemoryPinStore();
  const ctx = context({ pins });

  await createPin({ name: 'all', operation: 'item.list', address: '/items', fields: ['id'] }, ctx);
  const drilled = await readPin('all', ctx, { address: '/items/0' });

  assert.match(drilled.text, /→ \/items\/0/);
  assert.match(drilled.text, /alpha/);

  const loaded = await pins.list();
  assert.equal(loaded.ok, true);
  if (loaded.ok) assert.equal(loaded.value.pins[0]?.address, '/items');
});

test('reading an unknown pin names the ones that exist', async () => {
  const pins = new MemoryPinStore();
  const ctx = context({ pins });
  await createPin({ name: 'all', operation: 'item.list', address: '/items' }, ctx);

  const result = await readPin('nope', ctx);
  assert.equal(result.isError, true);
  assert.match(result.text, /no pin 'nope'/);
  assert.match(result.text, /known pins: all/);
});

test('a pin whose operation has gone is retired, and stays until deleted', async () => {
  const pins = new MemoryPinStore();
  const full = context({ pins });
  await createPin({ name: 'all', operation: 'item.list', address: '/items' }, full);

  // The map is gone, but the pin is not: it is evidence that it once worked.
  const withoutItem = { ...map, operations: map.operations.filter((operation) => operation.id !== 'item.list') };
  const gone = context({ pins, catalog: catalog(withoutItem) });

  const result = await readPin('all', gone);
  assert.equal(result.isError, true);
  assert.match(result.text, /'item\.list', which no map declares/);
  assert.match(result.text, /unpin all/);

  const loaded = await pins.list();
  assert.equal(loaded.ok, true);
  if (loaded.ok) {
    assert.equal(loaded.value.pins[0]?.state, 'retired');
    assert.equal(loaded.value.pins.length, 1);
  }
});

test('a server error marks the pin broken and keeps the last success', async () => {
  const pins = new MemoryPinStore();
  const ok = context({ pins });
  await createPin({ name: 'all', operation: 'item.list', address: '/items' }, ok);

  const failing = context({
    pins,
    fetch: async () => new Response('{"message":"boom"}', { status: 500, headers: { 'content-type': 'application/json' } }),
  });

  const result = await readPin('all', failing);
  assert.equal(result.isError, true);
  assert.match(result.text, /\[broken:http_error\]/);
  assert.match(result.text, /returned 500/);

  const loaded = await pins.list();
  assert.equal(loaded.ok, true);
  if (loaded.ok) {
    assert.equal(loaded.value.pins[0]?.state, 'broken:http_error');
    assert.equal(loaded.value.pins[0]?.lastResolved, now.toISOString());
  }
});

test('an unbound secret is a marked failure, not a lost pin', async () => {
  const pins = new MemoryPinStore();
  const result = await createPin({ name: 'secret', operation: 'item.secret' }, context({ pins }));

  assert.equal(result.isError, false);
  assert.match(result.text, /broken:secret_unbound/);

  const loaded = await pins.list();
  assert.equal(loaded.ok, true);
  if (loaded.ok) assert.equal(loaded.value.pins[0]?.state, 'broken:secret_unbound');
});

test('unpin deletes exactly one pin', async () => {
  const pins = new MemoryPinStore();
  const ctx = context({ pins });
  await createPin({ name: 'a', operation: 'item.list', address: '/items' }, ctx);

  const removed = await unpin('a', ctx);
  assert.equal(removed.isError, undefined);
  assert.match(removed.text, /unpinned a/);

  const loaded = await pins.list();
  assert.equal(loaded.ok, true);
  if (loaded.ok) assert.equal(loaded.value.pins.length, 0);

  const again = await unpin('a', ctx);
  assert.equal(again.isError, true);
});

test('prune reports by default and removes only provably dead pins', async () => {
  const pins = new MemoryPinStore();
  const full = context({ pins });

  await createPin({ name: 'good', operation: 'item.list', address: '/items' }, full);
  // This one fails for a transient reason on an operation that stays behind.
  await createPin({ name: 'broken', operation: 'item.secret' }, full);

  const expired = pinFromDraft({ name: 'temp', operation: 'item.secret', ttlSeconds: 1, ephemeral: true }, new Date(now.getTime() - 60_000));
  assert.equal(expired.ok, true);
  if (expired.ok) await pins.put({ ...expired.value, state: 'ok' });

  const withoutItem = { ...map, operations: map.operations.filter((operation) => operation.id !== 'item.list') };
  const gone = context({ pins, catalog: catalog(withoutItem) });

  const report = await prunePins(gone);
  assert.match(report.text, /2 pins to remove \(dry run/);
  assert.match(report.text, /retired good/);
  assert.match(report.text, /expired temp/);
  assert.match(report.text, /broken pins are marked, never auto-removed/);

  const loaded = await pins.list();
  assert.equal(loaded.ok, true);
  if (loaded.ok) assert.equal(loaded.value.pins.length, 3);

  const applied = await prunePins(gone, { apply: true });
  assert.match(applied.text, /removed 2 pins/);

  const after = await pins.list();
  assert.equal(after.ok, true);
  if (after.ok) assert.deepEqual(after.value.pins.map((pin) => pin.name), ['broken']);
});

test('prune says so plainly when there is nothing to remove', async () => {
  const pins = new MemoryPinStore();
  const ctx = context({ pins });
  await createPin({ name: 'good', operation: 'item.list', address: '/items' }, ctx);

  const result = await prunePins(ctx);
  assert.equal(result.isError, undefined);
  assert.match(result.text, /nothing to remove \(1 pin: 1 ok\)/);
});
