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
const importFixtures = path.join(import.meta.dirname, '..', 'import', 'fixtures');
const scratch: string[] = [];

after(async () => {
  await Promise.all(scratch.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function writableDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'wrap2mcp-cli-'));
  scratch.push(dir);
  return dir;
}

const issues = [
  { number: 1, title: 'First', state: 'open', user: { login: 'ann' }, created_at: '2026-10-01T00:00:00Z', comments: 0 },
  { number: 2, title: 'Second', state: 'closed', user: { login: 'bob' }, created_at: '2026-10-02T00:00:00Z', comments: 4 },
];

function client() {
  const fetch: FetchLike = async () =>
    new Response(JSON.stringify(issues), { status: 200, headers: { 'content-type': 'application/json' } });

  return createClient({
    workspace: { maps: [{ path: path.join(fixtures, 'github.json') }] },
    store: new MemoryStore(),
    fetch,
    env: {},
  });
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    deps: {
      client: client(),
      write: (text: string) => out.push(text),
      writeError: (text: string) => err.push(text),
    },
  };
}

test('parseArgs: bare verb defaults', () => {
  assert.deepEqual(parseArgs(['ls']), { kind: 'ls', path: '/', json: false });
  assert.deepEqual(parseArgs(['ls', '/github']), { kind: 'ls', path: '/github', json: false });
  assert.deepEqual(parseArgs(['describe', 'repo.get']), { kind: 'describe', operation: 'repo.get', json: false });
});

test('parseArgs: run collects key=value pairs and flags', () => {
  const command = parseArgs(['run', 'repo.issues.list', 'owner=a', 'repo=b', '--view', 'brief', '--max-items', '5', '--dry-run']);

  assert.equal(command.kind, 'run');
  if (command.kind !== 'run') return;

  assert.equal(command.operation, 'repo.issues.list');
  assert.deepEqual(command.args, { owner: 'a', repo: 'b' });
  assert.equal(command.view, 'brief');
  assert.equal(command.maxItems, 5);
  assert.equal(command.dryRun, true);
});

test('parseArgs: --flag=value and --json', () => {
  const command = parseArgs(['read', 'r_abc', '/0', '--max-items=3', '--json']);
  assert.equal(command.kind, 'read');
  if (command.kind !== 'read') return;

  assert.equal(command.address, '/0');
  assert.equal(command.maxItems, 3);
  assert.equal(command.json, true);
});

test('parseArgs: find joins words and takes --limit', () => {
  const command = parseArgs(['find', 'list', 'issues', '--limit', '3']);
  assert.deepEqual(command, { kind: 'find', query: 'list issues', limit: 3, json: false });
});

test('parseArgs: refuses a bare argument pair and an unknown command', () => {
  const pair = parseArgs(['run', 'repo.get', 'owner']);
  assert.equal(pair.kind, 'error');
  assert.match(pair.kind === 'error' ? pair.message : '', /must be key=value/);

  const unknown = parseArgs(['cd', '/github']);
  assert.equal(unknown.kind, 'error');
  assert.match(unknown.kind === 'error' ? unknown.message : '', /unknown command 'cd'/);
});

test('parseArgs: help and version win over a verb', () => {
  assert.deepEqual(parseArgs([]), { kind: 'help' });
  assert.deepEqual(parseArgs(['--help']), { kind: 'help' });
  assert.deepEqual(parseArgs(['ls', '--version']), { kind: 'version' });
});

test('main: --version reports the package version', async () => {
  const pkg = JSON.parse(await readFile(path.join(import.meta.dirname, '..', '..', 'package.json'), 'utf8')) as {
    version: string;
  };
  const cap = capture();
  assert.equal(await main(['--version'], cap.deps), 0);
  assert.equal(cap.out.join('').trim(), pkg.version);
});

test('main: ls prints the map line and exits 0', async () => {
  const cap = capture();
  assert.equal(await main(['ls', '/'], cap.deps), 0);
  assert.match(cap.out.join('\n'), /^github\s+GitHub REST/m);
  assert.deepEqual(cap.err, []);
});

test('main: run prints the envelope and read drills in', async () => {
  const cap = capture();

  assert.equal(await main(['run', 'repo.issues.list', 'owner=a', 'repo=b'], cap.deps), 0);
  const submitted = cap.out.at(-1) ?? '';
  const envelope = JSON.parse(submitted) as { handle: string; total: number };
  assert.equal(envelope.total, 2);
  assert.match(envelope.handle, /^r_/);

  assert.equal(await main(['read', envelope.handle, '/1'], cap.deps), 0);
  assert.match(cap.out.at(-1) ?? '', /\/title  "Second"/);
});

test('main: --json prints data, and a failure exits 1', async () => {
  const cap = capture();

  assert.equal(await main(['describe', 'repo.issues.list', '--json'], cap.deps), 0);
  const described = JSON.parse(cap.out.at(-1) ?? '') as { operation: string; required: string[] };
  assert.equal(described.operation, 'repo.issues.list');
  assert.deepEqual(described.required, ['owner', 'repo']);

  const failing = capture();
  assert.equal(await main(['describe', 'nope.thing'], failing.deps), 1);
  assert.match(failing.out.at(-1) ?? '', /no operation 'nope\.thing'/);
});

test('main: a command error goes to stderr and exits 1', async () => {
  const cap = capture();
  assert.equal(await main(['run', 'repo.get', 'owner'], cap.deps), 1);
  assert.match(cap.err.join('\n'), /must be key=value/);
  assert.deepEqual(cap.out, []);
});

test('parseArgs: import and learn', () => {
  assert.deepEqual(parseArgs(['import', 'openapi', './api.yaml']), {
    kind: 'import',
    source: './api.yaml',
    force: false,
    dryRun: false,
    json: false,
  });

  const imported = parseArgs(['import', './api.json', '--id', 'mine', '--base-url', 'https://x.test', '--out', 'm.json', '--force']);
  assert.equal(imported.kind, 'import');
  if (imported.kind !== 'import') return;
  assert.equal(imported.id, 'mine');
  assert.equal(imported.baseUrl, 'https://x.test');
  assert.equal(imported.out, 'm.json');
  assert.equal(imported.force, true);

  assert.deepEqual(parseArgs(['learn', 'https://api.test/pets']), {
    kind: 'learn',
    url: 'https://api.test/pets',
    force: false,
    dryRun: false,
    json: false,
  });

  const missing = parseArgs(['import']);
  assert.equal(missing.kind, 'error');
});

test('main: import writes the map into the writable location', async () => {
  const dir = await writableDir();
  const cap = capture();

  const code = await main(['import', 'openapi', path.join(importFixtures, 'petstore.json')], {
    ...cap.deps,
    workspace: { maps: [{ path: dir, writable: true }] },
  });

  assert.equal(code, 0, cap.out.join('\n'));
  const text = cap.out.join('\n');
  assert.match(text, /imported petstore — 3 resources, 7 operations, 1 link/);
  assert.match(text, /secrets to bind: bearerAuth/);

  const written = JSON.parse(await readFile(path.join(dir, 'petstore.json'), 'utf8')) as { id: string; operations: unknown[] };
  assert.equal(written.id, 'petstore');
  assert.equal(written.operations.length, 7);
});

test('main: import --dry-run names the target and writes nothing', async () => {
  const dir = await writableDir();
  const cap = capture();

  const code = await main(['import', 'openapi', path.join(importFixtures, 'petstore.json'), '--dry-run'], {
    ...cap.deps,
    workspace: { maps: [{ path: dir, writable: true }] },
  });

  assert.equal(code, 0);
  assert.match(cap.out.join('\n'), /would write/);
  await assert.rejects(readFile(path.join(dir, 'petstore.json'), 'utf8'));
});

test('main: import refuses to overwrite human work without --force', async () => {
  const dir = await writableDir();
  const human = {
    schemaVersion: 2,
    id: 'petstore',
    title: 'Hand written',
    baseUrl: 'https://api.example.com/v1',
    provenance: { source: 'human', date: '2026-11-01' },
    resources: [{ id: 'pet', title: 'Pet' }],
    operations: [
      { id: 'pet.list', resource: 'pet', title: 'List pets', provenance: 'human', request: { method: 'GET', path: '/pets' } },
    ],
  };
  await import('node:fs/promises').then((fs) => fs.writeFile(path.join(dir, 'petstore.json'), JSON.stringify(human), 'utf8'));

  const blocked = capture();
  const code = await main(['import', 'openapi', path.join(importFixtures, 'petstore.json')], {
    ...blocked.deps,
    workspace: { maps: [{ path: dir, writable: true }] },
  });
  assert.equal(code, 1);
  assert.match(blocked.out.join('\n'), /human-owned entr/);
  assert.match(blocked.out.join('\n'), /operation pet\.list/);

  const forced = capture();
  assert.equal(
    await main(['import', 'openapi', path.join(importFixtures, 'petstore.json'), '--force'], {
      ...forced.deps,
      workspace: { maps: [{ path: dir, writable: true }] },
    }),
    0,
  );
});

test('main: learn proposes a map from one sample and writes it', async () => {
  const dir = await writableDir();
  const cap = capture();
  const fetch: FetchLike = async () =>
    new Response(JSON.stringify([{ id: 1, title: 'Mascara' }, { id: 2, title: 'Palette' }]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  const code = await main(['learn', 'https://api.test/products'], {
    ...cap.deps,
    fetch,
    workspace: { maps: [{ path: dir, writable: true }] },
  });

  assert.equal(code, 0, cap.out.join('\n'));
  assert.match(cap.out.join('\n'), /learned product — 200, 2 items/);
  assert.match(cap.out.join('\n'), /fields=id,title/);

  const written = JSON.parse(await readFile(path.join(dir, 'product.json'), 'utf8')) as {
    operations: Array<{ id: string; view: { mode: string } }>;
  };
  assert.equal(written.operations[0]?.id, 'product.list');
  assert.equal(written.operations[0]?.view.mode, 'rows');
});

const notesMap = {
  schemaVersion: 2,
  id: 'notes',
  title: 'Notes',
  baseUrl: 'https://notes.example.com',
  resources: [{ id: 'note', title: 'Note', key: 'id' }],
  operations: [
    {
      id: 'note.create',
      resource: 'note',
      title: 'Create a note',
      request: { method: 'POST', path: '/notes', body: { title: '{title}', body: '{body}' } },
      input: { required: ['title'], properties: { title: { type: 'string' }, body: { type: 'string' } } },
    },
  ],
  links: [],
};

async function noteFiles(): Promise<{ map: string; workspace: string }> {
  const dir = await writableDir();
  const map = path.join(dir, 'notes.json');
  await writeFile(map, JSON.stringify(notesMap), 'utf8');
  const workspace = path.join(dir, 'workspace.json');
  await writeFile(workspace, JSON.stringify({ maps: [{ path: map }] }), 'utf8');
  return { map, workspace };
}

test('a write is only previewed until --confirm', async () => {
  const files = await noteFiles();
  const calls: string[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push(`${init.method} ${url}`);
    return new Response(JSON.stringify({ id: 'n1', title: 'Hello' }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    });
  };

  const client = createClient({
    workspace: { maps: [{ path: files.map }] },
    store: new MemoryStore(),
    fetch,
    env: {},
  });

  const out: string[] = [];
  const deps = {
    client,
    write: (text: string) => out.push(text),
    writeError: (text: string) => out.push(text),
  };

  assert.equal(await main(['run', 'note.create', 'title=Hello'], deps), 1);
  assert.match(out.join('\n'), /not sent: POST https:\/\/notes\.example\.com\/notes/);
  assert.equal(calls.length, 0, 'nothing was sent');

  out.length = 0;
  assert.equal(await main(['run', 'note.create', 'title=Hello', '--confirm'], deps), 0);
  assert.match(out.join('\n'), /^wrote POST https:\/\/notes\.example\.com\/notes · 201/);
  assert.deepEqual(calls, ['POST https://notes.example.com/notes']);
});

test('--writes deny makes a confirmed write refuse without a client override', async () => {
  const files = await noteFiles();
  const out: string[] = [];
  const deps = {
    write: (text: string) => out.push(text),
    writeError: (text: string) => out.push(text),
  };

  const code = await main(['run', 'note.create', 'title=Hello', '--confirm', '--writes', 'deny', '--workspace', files.workspace], deps);
  assert.equal(code, 1);
  assert.match(out.join('\n'), /read-only/);

  out.length = 0;
  assert.equal(await main(['run', 'note.create', 'title=Hello', '--writes', 'sometimes'], deps), 1);
  assert.match(out.join('\n'), /--writes must be one of open, confirm, deny/);
});

test('parseArgs: --confirm is a run flag and defaults to false', () => {
  const plain = parseArgs(['run', 'note.create', 'title=x']);
  assert.equal(plain.kind, 'run');
  if (plain.kind !== 'run') return;
  assert.equal(plain.confirm, false);

  const confirmed = parseArgs(['run', 'note.create', 'title=x', '--confirm']);
  assert.equal(confirmed.kind, 'run');
  if (confirmed.kind !== 'run') return;
  assert.equal(confirmed.confirm, true);
});
