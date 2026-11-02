import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import {
  FilePinStore,
  MemoryPinStore,
  isPinExpired,
  markFailed,
  markResolved,
  markRetired,
  pinFromDraft,
  readPinFile,
} from '../../src/pins.ts';
import type { Pin, PinDraft } from '../../src/pins.ts';
import { PIN_SCHEMA_VERSION } from '../../src/pins.ts';

const scratch: string[] = [];
const now = new Date('2026-11-01T12:00:00.000Z');

after(async () => {
  await Promise.all(scratch.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function directory(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'wrap2mcp-pins-'));
  scratch.push(dir);
  return dir;
}

function draft(overrides: Record<string, unknown> = {}) {
  return {
    name: 'starforge',
    operation: 'item.overview',
    ...overrides,
  };
}

function record(overrides: Partial<Pin> = {}): Pin {
  return {
    name: 'starforge',
    operation: 'item.overview',
    args: { league: 'Standard' },
    address: '/lines',
    state: 'ok',
    failCount: 0,
    created: now.toISOString(),
    ...overrides,
  };
}

test('a missing pins file reads as no pins, not an error', async () => {
  const dir = await directory();
  const store = new FilePinStore(path.join(dir, 'pins.json'));

  const loaded = await store.list();
  assert.equal(loaded.ok, true);
  if (loaded.ok) {
    assert.deepEqual(loaded.value.pins, []);
    assert.deepEqual(loaded.value.issues, []);
  }
});

test('pins round-trip through one versioned JSON file, sorted by name', async () => {
  const dir = await directory();
  const file = path.join(dir, 'nested', 'pins.json');
  const store = new FilePinStore(file);

  assert.equal((await store.put(record({ name: 'zeta' }))).ok, true);
  assert.equal((await store.put(record({ name: 'alpha', fields: ['name', 'chaosValue'] }))).ok, true);

  const written = JSON.parse(await readFile(file, 'utf8')) as { schemaVersion: number; pins: Pin[] };
  assert.equal(written.schemaVersion, PIN_SCHEMA_VERSION);
  assert.deepEqual(written.pins.map((pin) => pin.name), ['alpha', 'zeta']);

  const loaded = await store.list();
  assert.equal(loaded.ok, true);
  if (loaded.ok) {
    assert.deepEqual(loaded.value.pins.map((pin) => pin.name), ['alpha', 'zeta']);
    assert.deepEqual(loaded.value.pins[0]?.fields, ['name', 'chaosValue']);
  }
});

test('a legacy bare-record file is readable and never rewritten by a read', async () => {
  const dir = await directory();
  const file = path.join(dir, 'pins.json');
  const legacy = {
    ghosts: {
      name: 'ghosts',
      operation: 'item.overview',
      args: { league: 'Standard' },
      address: '/lines[name=\'Nope\']',
      state: 'broken:selector_miss',
      failCount: 1,
      created: '2026-11-01T11:00:00.000Z',
    },
  };

  await writeFile(file, JSON.stringify(legacy), 'utf8');
  const store = new FilePinStore(file);

  const loaded = await store.list();
  assert.equal(loaded.ok, true);
  if (loaded.ok) {
    assert.equal(loaded.value.legacy, true);
    assert.equal(loaded.value.pins[0]?.name, 'ghosts');
    assert.equal(loaded.value.pins[0]?.state, 'broken:selector_miss');
    assert.ok(loaded.value.issues.some((entry) => entry.message.includes('legacy bare-record')));
  }

  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), legacy);
});

test('an unreadable record is reported and blocks rewriting the file', async () => {
  const dir = await directory();
  const file = path.join(dir, 'pins.json');
  const store = new FilePinStore(file);

  await writeFile(
    file,
    JSON.stringify({
      schemaVersion: 1,
      pins: [
        { name: 'ok-one', operation: 'item.overview', address: '/' },
        { name: 'NOT A NAME', operation: 'item.overview', address: '/' },
      ],
    }),
    'utf8',
  );

  const loaded = await store.list();
  assert.equal(loaded.ok, true);
  if (loaded.ok) {
    assert.equal(loaded.value.pins.length, 1);
    assert.equal(loaded.value.issues.filter((entry) => entry.severity === 'error').length, 1);
  }

  const put = await store.put(record());
  assert.equal(put.ok, false);
  if (!put.ok) {
    assert.equal(put.error.code, 'pins_invalid');
    assert.ok(put.error.details?.[0]?.includes('pins[1].name'));
  }

  // The good record and the bad one are both still on disk.
  const raw = JSON.parse(await readFile(file, 'utf8')) as { pins: unknown[] };
  assert.equal(raw.pins.length, 2);
});

test('a file that is not JSON is an error, not an empty list', async () => {
  const dir = await directory();
  const file = path.join(dir, 'pins.json');
  await writeFile(file, 'not json at all', 'utf8');

  const loaded = await new FilePinStore(file).list();
  assert.equal(loaded.ok, false);
  if (!loaded.ok) assert.equal(loaded.error.code, 'pins_unreadable');
});

test('a UTF-8 BOM is tolerated', async () => {
  const dir = await directory();
  const file = path.join(dir, 'pins.json');
  const store = new FilePinStore(file);
  await store.put(record());

  const text = await readFile(file, 'utf8');
  await writeFile(file, `\uFEFF${text}`, 'utf8');

  const loaded = await store.list();
  assert.equal(loaded.ok, true);
  if (loaded.ok) assert.equal(loaded.value.pins.length, 1);
});

test('delete removes one pin and reports whether it existed', async () => {
  const dir = await directory();
  const store = new FilePinStore(path.join(dir, 'pins.json'));
  await store.put(record());

  const first = await store.delete('starforge');
  assert.equal(first.ok, true);
  if (first.ok) assert.equal(first.value, true);

  const again = await store.delete('starforge');
  assert.equal(again.ok, true);
  if (again.ok) assert.equal(again.value, false);
});

test('an in-memory store behaves the same, for hosts that touch no disk', async () => {
  const store = new MemoryPinStore([record()]);
  const loaded = await store.list();

  assert.equal(loaded.ok, true);
  if (loaded.ok) assert.deepEqual(loaded.value.pins.map((pin) => pin.name), ['starforge']);
});

test('a draft is validated before it can become a pin', () => {
  const bad = pinFromDraft(draft({ name: 'Not A Name' }) as PinDraft, now);
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.equal(bad.error.code, 'pin_invalid');
    assert.ok(bad.error.details?.[0]?.includes('lower-case'));
  }

  const badAddress = pinFromDraft(draft({ address: '/lines[name=' }) as PinDraft, now);
  assert.equal(badAddress.ok, false);

  const badMode = pinFromDraft(draft({ mode: 'sparkles' }) as PinDraft, now);
  assert.equal(badMode.ok, false);
});

test('a draft gains a canonical address, sorted fields and an expiry', () => {
  const built = pinFromDraft(
    draft({
      address: '/lines[name=Starforge]',
      fields: ['name', 'name', 'chaosValue'],
      ttlSeconds: 60,
      note: 'the one we watch',
    }) as PinDraft,
    now,
  );

  assert.equal(built.ok, true);
  if (!built.ok) return;

  assert.equal(built.value.name, 'starforge');
  assert.equal(built.value.address, "/lines[name='Starforge']");
  assert.deepEqual(built.value.fields, ['name', 'chaosValue']);
  assert.equal(built.value.state, 'stale');
  assert.equal(built.value.expires, '2026-11-01T12:01:00.000Z');
  assert.equal(built.value.ephemeral, true);
  assert.equal(built.value.note, 'the one we watch');
});

test('the lifecycle marks, never deletes', () => {
  const pin = record();

  const resolved = markResolved(pin, 'r_0123456789abcdef', now);
  assert.equal(resolved.state, 'ok');
  assert.equal(resolved.lastHandle, 'r_0123456789abcdef');
  assert.equal(resolved.lastResolved, now.toISOString());

  const broken = markFailed(resolved, 'selector_miss', 'no row matched');
  assert.equal(broken.state, 'broken:selector_miss');
  assert.equal(broken.failCount, 1);
  assert.deepEqual(broken.lastError, { code: 'selector_miss', message: 'no row matched' });
  // The last success is kept: it is still evidence the pin once worked.
  assert.equal(broken.lastResolved, now.toISOString());

  const retired = markRetired(pin, 'gone');
  assert.equal(retired.state, 'retired');
  assert.equal(retired.lastError?.code, 'retired');
});

test('expiry is per pin, and only ephemeral pins are pruned for it', () => {
  const expiring = record({ expires: '2026-11-01T11:59:00.000Z', ephemeral: true });
  const durable = record({ expires: '2026-11-01T11:59:00.000Z' });

  assert.equal(isPinExpired(expiring, now), true);
  assert.equal(isPinExpired(durable, now), true);
  assert.equal(isPinExpired(record(), now), false);
});

test('readPinFile keeps valid records and reports duplicates', () => {
  const file = {
    schemaVersion: 1,
    pins: [
      { name: 'a', operation: 'x.y', address: '/' },
      { name: 'a', operation: 'x.z', address: '/' },
    ],
  };

  const loaded = readPinFile(file);
  assert.equal(loaded.ok, true);
  if (loaded.ok) {
    assert.equal(loaded.value.pins.length, 1);
    assert.equal(loaded.value.pins[0]?.operation, 'x.z');
    assert.ok(loaded.value.issues.some((entry) => entry.message.includes('duplicate')));
  }
});
