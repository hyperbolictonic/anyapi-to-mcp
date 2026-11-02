import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { createClient } from '../../src/client.ts';
import { MemoryStore } from '../../src/store/store.ts';
import { main, parseArgs } from '../../src/cli.ts';
import type { FetchLike } from '../../src/runtime/execute.ts';

const fixtures = path.join(import.meta.dirname, '..', 'map', 'fixtures');
const scratch: string[] = [];

after(async () => {
  await Promise.all(scratch.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function writableDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'wrap2mcp-pins-cli-'));
  scratch.push(dir);
  return dir;
}

const issues = [
  { number: 1, title: 'First', state: 'open', user: { login: 'ann' }, created_at: '2026-10-01T00:00:00Z', comments: 0 },
  { number: 2, title: 'Second', state: 'closed', user: { login: 'bob' }, created_at: '2026-10-02T00:00:00Z', comments: 4 },
];

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function client(pinsFile: string, fetch: FetchLike = async () => json(issues)) {
  return createClient({
    workspace: {
      maps: [{ path: path.join(fixtures, 'github.json') }],
      pins: { path: pinsFile },
    },
    store: new MemoryStore(),
    fetch,
    env: {},
  });
}

function capture(pinsFile: string, fetch?: FetchLike) {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    deps: {
      client: client(pinsFile, fetch),
      write: (text: string) => out.push(text),
      writeError: (text: string) => err.push(text),
    },
  };
}

test('parseArgs: pin takes a name, an operation and key=value pairs', () => {
  const command = parseArgs([
    'pin',
    'open-issues',
    'repo.issues.list',
    'owner=a',
    'repo=b',
    '--address',
    "/0",
    '--fields',
    'number,title',
    '--note',
    'watch these',
    '--ttl',
    '3600',
    '--ephemeral',
  ]);

  assert.equal(command.kind, 'pin');
  if (command.kind !== 'pin') return;

  assert.equal(command.name, 'open-issues');
  assert.equal(command.operation, 'repo.issues.list');
  assert.deepEqual(command.args, { owner: 'a', repo: 'b' });
  assert.equal(command.address, '/0');
  assert.deepEqual(command.fields, ['number', 'title']);
  assert.equal(command.note, 'watch these');
  assert.equal(command.ttlSeconds, 3600);
  assert.equal(command.ephemeral, true);
});

test('parseArgs: pin without a name or an operation is an error', () => {
  assert.equal(parseArgs(['pin']).kind, 'error');
  assert.equal(parseArgs(['pin', 'only-a-name']).kind, 'error');
  assert.equal(parseArgs(['unpin']).kind, 'error');
});

test('parseArgs: prune is a report until --apply', () => {
  const dry = parseArgs(['prune']);
  assert.equal(dry.kind, 'prune');
  if (dry.kind === 'prune') assert.equal(dry.apply, false);

  const applied = parseArgs(['prune', '--apply']);
  assert.equal(applied.kind, 'prune');
  if (applied.kind === 'prune') assert.equal(applied.apply, true);
});

test('pin writes a versioned pins file, and read @name re-resolves it', async () => {
  const dir = await writableDir();
  const pinsFile = path.join(dir, 'pins.json');
  const first = capture(pinsFile);

  const pinned = await main(
    ['pin', 'open-issues', 'repo.issues.list', 'owner=a', 'repo=b', '--address', '/0', '--fields', 'number,title'],
    first.deps,
  );

  assert.equal(pinned, 0);
  assert.match(first.out.join('\n'), /^pinned open-issues — repo\.issues\.list {2}\[ok\]/m);
  assert.match(first.out.join('\n'), /next: read @open-issues/);

  const document = JSON.parse(await readFile(pinsFile, 'utf8')) as { schemaVersion: number; pins: Array<{ name: string; state: string }> };
  assert.equal(document.schemaVersion, 1);
  assert.equal(document.pins[0]?.name, 'open-issues');
  assert.equal(document.pins[0]?.state, 'ok');

  // A second process reads the same file: pins survive the session.
  const second = capture(pinsFile);
  const listed = await main(['ls', '/pins'], second.deps);
  assert.equal(listed, 0);
  assert.match(second.out.join('\n'), /open-issues\s+ok\s+repo\.issues\.list\s+\/0/);

  const read = await main(['read', '@open-issues'], second.deps);
  assert.equal(read, 0);
  assert.match(second.out.join('\n'), /^@open-issues — repo\.issues\.list → \/0 {2}\[ok\]/m);
});

test('read @name takes an address to drill deeper without re-pinning', async () => {
  const dir = await writableDir();
  const pinsFile = path.join(dir, 'pins.json');
  const deps = capture(pinsFile);

  await main(['pin', 'all', 'repo.issues.list', 'owner=a', 'repo=b'], deps.deps);
  deps.out.length = 0;

  const exit = await main(['read', '@all', '/0'], deps.deps);
  assert.equal(exit, 0);
  assert.match(deps.out.join('\n'), /→ \/0/);
  assert.match(deps.out.join('\n'), /First/);
});

test('a pin that cannot resolve is still saved, and says so', async () => {
  const dir = await writableDir();
  const pinsFile = path.join(dir, 'pins.json');
  const deps = capture(pinsFile, async () => json({ message: 'boom' }, 500));

  const exit = await main(['pin', 'flaky', 'repo.issues.list', 'owner=a', 'repo=b'], deps.deps);

  assert.equal(exit, 0, 'the pin was saved; its state is the answer');
  assert.match(deps.out.join('\n'), /^pinned \(unresolved\) flaky/m);
  assert.match(deps.out.join('\n'), /broken:http_error/);

  const document = JSON.parse(await readFile(pinsFile, 'utf8')) as { pins: Array<{ state: string }> };
  assert.equal(document.pins[0]?.state, 'broken:http_error');
});

test('an unknown operation is refused and nothing is written', async () => {
  const dir = await writableDir();
  const pinsFile = path.join(dir, 'pins.json');
  const deps = capture(pinsFile);

  const exit = await main(['pin', 'nope', 'repo.issues.delete', 'owner=a', 'repo=b'], deps.deps);
  assert.equal(exit, 1);
  assert.match(deps.out.join('\n'), /no operation 'repo\.issues\.delete'/);

  await assert.rejects(readFile(pinsFile, 'utf8'));
});

test('pin --dry-run resolves nothing and writes nothing', async () => {
  const dir = await writableDir();
  const pinsFile = path.join(dir, 'pins.json');
  let calls = 0;
  const deps = capture(pinsFile, async () => {
    calls += 1;
    return json(issues);
  });

  const exit = await main(['pin', 'later', 'repo.issues.list', 'owner=a', 'repo=b', '--dry-run'], deps.deps);

  assert.equal(exit, 0);
  assert.equal(calls, 0);
  assert.match(deps.out.join('\n'), /^would pin later/m);
  await assert.rejects(readFile(pinsFile, 'utf8'));
});

test('prune reports first, then --apply removes only retired pins', async () => {
  const dir = await writableDir();
  const pinsFile = path.join(dir, 'pins.json');
  const deps = capture(pinsFile);

  await main(['pin', 'keep', 'repo.get', 'owner=a', 'repo=b'], deps.deps);
  await main(['pin', 'gone', 'repo.get', 'owner=a', 'repo=b'], deps.deps);

  // Remove 'gone' from the pin file's map by writing one that names no real op.
  const document = JSON.parse(await readFile(pinsFile, 'utf8')) as {
    schemaVersion: number;
    pins: Array<Record<string, unknown>>;
  };
  document.pins = document.pins.map((pin) => (pin['name'] === 'gone' ? { ...pin, operation: 'retired.op' } : pin));
  await writeFile(pinsFile, `${JSON.stringify(document, null, 2)}\n`, 'utf8');

  deps.out.length = 0;
  assert.equal(await main(['prune'], deps.deps), 0);
  assert.match(deps.out.join('\n'), /1 pin to remove \(dry run/);
  assert.match(deps.out.join('\n'), /retired gone/);

  const still = JSON.parse(await readFile(pinsFile, 'utf8')) as { pins: unknown[] };
  assert.equal(still.pins.length, 2);

  deps.out.length = 0;
  assert.equal(await main(['prune', '--apply'], deps.deps), 0);
  assert.match(deps.out.join('\n'), /removed 1 pin/);

  const after = JSON.parse(await readFile(pinsFile, 'utf8')) as { pins: Array<{ name: string }> };
  assert.deepEqual(after.pins.map((pin) => pin.name), ['keep']);
});

test('unpin deletes one pin; reading it afterwards is an error', async () => {
  const dir = await writableDir();
  const pinsFile = path.join(dir, 'pins.json');
  const deps = capture(pinsFile);

  await main(['pin', 'one', 'repo.get', 'owner=a', 'repo=b'], deps.deps);
  deps.out.length = 0;

  assert.equal(await main(['unpin', 'one'], deps.deps), 0);
  assert.match(deps.out.join('\n'), /unpinned one/);

  deps.out.length = 0;
  assert.equal(await main(['read', '@one'], deps.deps), 1);
  assert.match(deps.out.join('\n'), /no pin 'one'/);
});

test('pin --json prints the record, not just the text', async () => {
  const dir = await writableDir();
  const deps = capture(path.join(dir, 'pins.json'));

  const exit = await main(['pin', 'all', 'repo.issues.list', 'owner=a', 'repo=b', '--json'], deps.deps);
  assert.equal(exit, 0);

  const data = JSON.parse(deps.out.join('\n')) as { pin: { name: string; state: string; operation: string } };
  assert.equal(data.pin.name, 'all');
  assert.equal(data.pin.state, 'ok');
  assert.equal(data.pin.operation, 'repo.issues.list');
});

test('a corrupt pins file is reported, never silently overwritten', async () => {
  const dir = await writableDir();
  const pinsFile = path.join(dir, 'pins.json');
  await writeFile(pinsFile, '{"schemaVersion":1,"pins":[{"name":"BAD NAME","operation":"x.y","address":"/"}]}', 'utf8');

  const deps = capture(pinsFile);
  const exit = await main(['pin', 'ok', 'repo.get', 'owner=a', 'repo=b'], deps.deps);

  assert.equal(exit, 1);
  assert.match(deps.out.join('\n'), /unreadable pin/);

  const raw = await readFile(pinsFile, 'utf8');
  assert.match(raw, /BAD NAME/);
});
