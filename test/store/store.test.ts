import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { FileStore, MemoryStore, handleFor, isHandle, stableStringify } from '../../src/store/store.ts';

const scratch: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'wrap2mcp-store-'));
  scratch.push(dir);
  return dir;
}

after(async () => {
  await Promise.all(scratch.map((dir) => rm(dir, { recursive: true, force: true })));
});

test('a handle is content-addressed and independent of key order', () => {
  const a = { b: 2, a: 1, nested: { y: 2, x: 1 } };
  const b = { nested: { x: 1, y: 2 }, a: 1, b: 2 };

  assert.equal(stableStringify(a), stableStringify(b));
  assert.equal(handleFor(a), handleFor(b));
  assert.ok(isHandle(handleFor(a)));
  assert.notEqual(handleFor(a), handleFor({ a: 1, b: 2, nested: { x: 1, y: 3 } }));
});

test('identical payloads dedupe and count their fetches', async () => {
  const store = new MemoryStore();
  const first = await store.put({ items: [1, 2, 3] });
  const second = await store.put({ items: [1, 2, 3] });

  assert.equal(first.handle, second.handle);
  assert.equal(second.meta.fetches, 2);

  const read = await store.get(first.handle);
  assert.ok(read.ok);
  assert.deepEqual(read.value.payload, { items: [1, 2, 3] });
});

test('a handle survives a process restart because the store is on disk', async () => {
  const dir = await tempDir();

  const writer = new FileStore(dir);
  const stored = await writer.put({ hello: 'world' }, { operation: 'demo.get' });

  // A different store instance over the same directory: the process restarted.
  const reader = new FileStore(dir);
  const read = await reader.get(stored.handle);

  assert.ok(read.ok);
  assert.deepEqual(read.value.payload, { hello: 'world' });
  assert.equal(read.value.meta.operation, 'demo.get');
  assert.equal(read.value.meta.status, undefined);
});

test('an unknown handle and a malformed handle are distinct, actionable errors', async () => {
  const store = new MemoryStore();

  const missing = await store.get('r_0000000000000000');
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.equal(missing.error.code, 'handle_not_found');
    assert.match(missing.error.hint ?? '', /run an operation first/);
  }

  const dir = await tempDir();
  const fileStore = new FileStore(dir);
  const malformed = await fileStore.get('not-a-handle');
  assert.equal(malformed.ok, false);
  if (!malformed.ok) {
    assert.equal(malformed.error.code, 'handle_invalid');
    assert.match(malformed.error.hint ?? '', /r_0123456789abcdef/);
  }
});

test('expiry is per handle and prune only removes expired data', async () => {
  let now = new Date('2026-11-01T00:00:00Z');
  const store = new MemoryStore({ now: () => now, ttlSeconds: 60 });

  const shortLived = await store.put({ a: 1 });
  const durable = await store.put({ b: 2 }, { ttlSeconds: 3600 });

  now = new Date('2026-11-01T00:02:00Z');

  const expired = await store.get(shortLived.handle);
  assert.equal(expired.ok, false);
  if (!expired.ok) {
    assert.equal(expired.error.code, 'handle_expired');
    assert.match(expired.error.hint ?? '', /re-run/);
  }

  const stillThere = await store.get(durable.handle);
  assert.ok(stillThere.ok);

  assert.equal(await store.prune(), 1);
  assert.equal((await store.get(durable.handle)).ok, true);
  assert.equal(await store.prune(), 0);
});

test('the file store prunes expired handles from disk', async () => {
  let now = new Date('2026-11-01T00:00:00Z');
  const dir = await tempDir();
  const store = new FileStore(dir, { now: () => now, ttlSeconds: 30 });

  const record = await store.put({ temp: true });
  assert.equal((await store.get(record.handle)).ok, true);

  now = new Date('2026-11-01T00:01:00Z');
  assert.equal(await store.prune(), 1);
  assert.equal((await store.get(record.handle)).ok, false);
});

test('bytes are measured over the stable form, not the input string', async () => {
  const store = new MemoryStore();
  const record = await store.put({ a: 'ü' });
  assert.equal(record.meta.bytes, new TextEncoder().encode(stableStringify({ a: 'ü' })).length);
});

test('a file store evicts the oldest records beyond maxBytes', async () => {
  const dir = await tempDir();
  let clock = new Date('2026-11-01T00:00:00.000Z');
  const store = new FileStore(dir, { maxBytes: 5_000, now: () => clock });

  const first = await store.put({ text: 'a'.repeat(2_000) });
  clock = new Date('2026-11-01T00:00:01.000Z');
  const second = await store.put({ text: 'b'.repeat(2_000) });

  // Two records fit; the third pushes the directory over the cap, and the
  // oldest is the one that goes.
  clock = new Date('2026-11-01T00:00:02.000Z');
  const third = await store.put({ text: 'c'.repeat(2_000) });

  assert.equal((await store.get(first.handle)).ok, false);
  assert.ok((await store.get(second.handle)).ok);
  assert.ok((await store.get(third.handle)).ok);
});

test('a record larger than the cap is kept, not deleted by its own write', async () => {
  const dir = await tempDir();
  const store = new FileStore(dir, { maxBytes: 100 });

  const record = await store.put({ text: 'x'.repeat(500) });
  assert.ok((await store.get(record.handle)).ok);
});

test('a store under the cap evicts nothing', async () => {
  const dir = await tempDir();
  const store = new FileStore(dir, { maxBytes: 1_000_000 });

  const first = await store.put({ value: 1 });
  const second = await store.put({ value: 2 });
  assert.ok((await store.get(first.handle)).ok);
  assert.ok((await store.get(second.handle)).ok);
});
