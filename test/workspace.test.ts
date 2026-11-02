import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import { checkWorkspace, DEFAULT_PAYLOAD_TTL_SECONDS, defaultWorkspace, expandPath, normaliseWorkspace, readWorkspaceFile, writesMode } from '../src/workspace.ts';

test('expands ~, $VAR and ${VAR}, then resolves relatives', () => {
  const home = path.join(path.sep, 'home', 'someone');
  assert.equal(expandPath('~/maps', { home, env: {} }), path.join(home, 'maps'));
  assert.equal(expandPath('$WRAP/maps', { home, env: { WRAP: path.join(path.sep, 'w') } }), path.join(path.sep, 'w', 'maps'));
  assert.equal(expandPath('${WRAP}/maps', { home, env: { WRAP: path.join(path.sep, 'w') } }), path.join(path.sep, 'w', 'maps'));
  assert.equal(expandPath('maps', { home, env: {}, baseDir: path.join(path.sep, 'proj') }), path.resolve(path.sep, 'proj', 'maps'));
  // An unset variable is left alone rather than silently becoming empty.
  assert.equal(expandPath('$NOPE/maps', { home, env: {} }), '$NOPE/maps');
});

test('the shorthand expands into a full descriptor', () => {
  const descriptor = normaliseWorkspace(
    {
      maps: ['./maps', { path: './bundled', writable: false, label: 'bundled' }],
      pins: '.state/pins.json',
      payloads: '.cache/payloads',
    },
    { baseDir: path.join(path.sep, 'proj'), env: {}, home: path.join(path.sep, 'home') },
  );

  assert.equal(descriptor.maps.length, 2);
  assert.equal(descriptor.maps[0]?.path, path.resolve(path.sep, 'proj', 'maps'));
  assert.equal(descriptor.maps[1]?.label, 'bundled');
  assert.equal(descriptor.pins?.path, path.resolve(path.sep, 'proj', '.state', 'pins.json'));
  assert.deepEqual(descriptor.payloads, { path: path.resolve(path.sep, 'proj', '.cache', 'payloads') });
});

test('the default workspace puts payloads in cache, not user data', () => {
  const descriptor = defaultWorkspace({
    env: { WRAP2MCP_HOME: path.join(path.sep, 'cfg'), WRAP2MCP_CACHE: path.join(path.sep, 'cache') },
    home: path.join(path.sep, 'home'),
    cwd: path.join(path.sep, 'proj'),
  });

  assert.equal(descriptor.maps.length, 2);
  assert.equal(descriptor.maps.filter((location) => location.writable).length, 1, 'exactly one writable tier');
  assert.equal(descriptor.maps[0]?.label, 'project');
  assert.equal(descriptor.maps[0]?.writable, false);
  assert.equal(descriptor.maps[1]?.writable, true);
  assert.match(descriptor.payloads?.path ?? '', /cache/);
  assert.equal(descriptor.payloads?.ttlSeconds, DEFAULT_PAYLOAD_TTL_SECONDS);
  assert.match(descriptor.pins?.path ?? '', /cfg/);
  assert.deepEqual(checkWorkspace(descriptor), []);
});

test('two writable locations are refused', () => {
  const issues = checkWorkspace({
    maps: [
      { path: 'a', writable: true },
      { path: 'b', writable: true },
    ],
  });
  assert.equal(issues.length, 1);
  assert.match(issues[0]?.message ?? '', /exactly one map location may be writable/);
});

test('an empty workspace is refused', () => {
  assert.match(checkWorkspace({ maps: [] })[0]?.message ?? '', /at least one map location/);
});

test('a writes mode is validated, and an unnamed policy means confirm', () => {
  assert.deepEqual(
    checkWorkspace({ maps: [{ path: 'a' }], writes: { mode: 'deny' } }),
    [],
  );
  const bad = checkWorkspace({ maps: [{ path: 'a' }], writes: { mode: 'sometimes' as 'open' } });
  assert.equal(bad.length, 1);
  assert.match(bad[0]?.message ?? '', /writes\.mode must be one of open, confirm, deny/);

  assert.equal(writesMode(undefined), 'confirm');
  assert.equal(writesMode({ mode: 'open' }), 'open');

  // The JSON shorthand is accepted and normalised to an object.
  const normalised = normaliseWorkspace({ maps: ['a'], writes: 'open' });
  assert.deepEqual(normalised.writes, { mode: 'open' });
});

test('reading a workspace file reports missing and invalid input as data', async () => {
  const missing = await readWorkspaceFile(path.join(import.meta.dirname, 'fixtures', 'nope.json'));
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.error.code, 'not_found');

  const invalid = await readWorkspaceFile(path.join(import.meta.dirname, 'fixtures', 'invalid.json'));
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.equal(invalid.error.code, 'invalid_json');
});

test('a workspace file resolves relative paths against its own directory', async () => {
  const result = await readWorkspaceFile(path.join(import.meta.dirname, 'fixtures', 'workspace.json'));
  assert.ok(result.ok, result.ok ? '' : result.error.message);

  const projectMaps = result.value.maps[0]?.path ?? '';
  assert.ok(projectMaps.endsWith(path.join('fixtures', 'maps')), projectMaps);
  assert.equal(result.value.maps[0]?.writable, true);
});

test('payloads.maxBytes must be a positive number', () => {
  assert.deepEqual(checkWorkspace({ maps: [{ path: 'a' }], payloads: { path: 'p', maxBytes: 1024 } }), []);
  for (const maxBytes of [0, -1, Number.NaN]) {
    const issues = checkWorkspace({ maps: [{ path: 'a' }], payloads: { path: 'p', maxBytes } });
    assert.equal(issues.length, 1);
    assert.match(issues[0]?.message ?? '', /payloads\.maxBytes must be a positive number/);
  }
});
