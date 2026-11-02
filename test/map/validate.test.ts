import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { splitIssues, validateMap } from '../../src/map/validate.ts';

type Mutable = Record<string, any>;

const fixturePath = path.join(import.meta.dirname, 'fixtures', 'github.json');
const base = JSON.parse(await readFile(fixturePath, 'utf8')) as Mutable;

function mutate(change: (doc: Mutable) => void): ReturnType<typeof validateMap> {
  const doc = structuredClone(base) as Mutable;
  change(doc);
  return validateMap(doc);
}

function errorsOf(result: ReturnType<typeof validateMap>): string[] {
  return result.issues.filter((issue) => issue.severity === 'error').map((issue) => `${issue.path}: ${issue.message}`);
}

test('the reference map is valid and has no errors', () => {
  const result = validateMap(structuredClone(base));
  assert.deepEqual(errorsOf(result), []);
  assert.ok(result.map);
  assert.equal(result.map.id, 'github');
  assert.equal(result.map.operations.length, 2);
});

test('unknown keys are ignored so a newer map still loads', () => {
  const result = mutate((doc) => {
    doc['madeUpFeature'] = { anything: true };
    doc['operations'][0]['newField'] = 1;
  });
  assert.deepEqual(errorsOf(result), []);
  assert.ok(result.map);
});

test('duplicate operation ids are rejected', () => {
  const result = mutate((doc) => {
    doc['operations'][1]['id'] = doc['operations'][0]['id'];
  });
  assert.match(errorsOf(result).join('\n'), /duplicate operation id/);
});

test('a dangling resource reference is rejected in both directions', () => {
  const resource = mutate((doc) => {
    doc['operations'][0]['resource'] = 'nope';
  });
  assert.match(errorsOf(resource).join('\n'), /'nope' is not a declared resource/);

  const returned = mutate((doc) => {
    doc['operations'][1]['returns'] = 'ghost';
  });
  assert.match(errorsOf(returned).join('\n'), /'ghost' is not a declared resource/);
});

test('a placeholder with no declared input is rejected', () => {
  const result = mutate((doc) => {
    doc['operations'][0]['request']['path'] = '/repos/{owner}/{organisation}';
  });
  assert.match(errorsOf(result).join('\n'), /placeholder \{organisation\} has no declared input property/);
});

test('a required name that is not a declared property is rejected', () => {
  const result = mutate((doc) => {
    doc['operations'][0]['input']['required'] = ['owner', 'repo', 'phantom'];
  });
  assert.match(errorsOf(result).join('\n'), /'phantom' is not a declared property/);
});

test('a credential header in a map is a hard error', () => {
  for (const header of ['authorization', 'Authorization', 'x-api-key', 'Cookie']) {
    const result = mutate((doc) => {
      doc['operations'][0]['request']['headers'][header] = 'Bearer abcdefghijklmnop';
    });
    assert.match(errorsOf(result).join('\n'), /belongs in a secret binding/, header);
  }
});

test('a token-shaped value under an innocent header name is still refused', () => {
  const result = mutate((doc) => {
    doc['operations'][0]['request']['headers']['x-custom'] = 'ghp_abcdefghijklmnopqrstuvwxyz012345';
  });
  assert.match(errorsOf(result).join('\n'), /looks like a credential/);
});

test('a header that the runtime owns is refused', () => {
  for (const header of ['host', 'content-length']) {
    const result = mutate((doc) => {
      doc['operations'][0]['request']['headers'][header] = 'x';
    });
    assert.match(errorsOf(result).join('\n'), /is set by the runtime/, header);
  }
});

test('plain HTTP is a warning, not an error', () => {
  const result = mutate((doc) => {
    doc['baseUrl'] = 'http://legacy.internal.example';
  });
  assert.deepEqual(errorsOf(result), []);
  const { warnings } = splitIssues(result.issues);
  assert.match(warnings.map((w) => w.message).join('\n'), /plain HTTP/);
});

test('an unknown mode or an unresolvable select is rejected', () => {
  const mode = mutate((doc) => {
    doc['operations'][0]['view']['mode'] = 'sparkles';
  });
  assert.match(errorsOf(mode).join('\n'), /unknown mode 'sparkles'/);

  const select = mutate((doc) => {
    doc['operations'][0]['view']['select'] = 'repos/0';
  });
  assert.match(errorsOf(select).join('\n'), /must start with '\/'/);
});

test('named views are validated too', () => {
  const result = mutate((doc) => {
    doc['operations'][1]['views'] = { broken: { mode: 'nonsense' } };
  });
  assert.match(errorsOf(result).join('\n'), /operations\[1\]\.views\.broken\.mode/);
});

test('a link must point at a declared operation and resource', () => {
  const result = mutate((doc) => {
    doc['links'][0]['operation'] = 'repo.nope';
    doc['links'][0]['to'] = 'unicorn';
  });
  const errors = errorsOf(result).join('\n');
  assert.match(errors, /'repo.nope' is not a declared operation/);
  assert.match(errors, /'unicorn' is not a declared resource/);
});

test('a secret reference is a name, never a value', () => {
  const result = mutate((doc) => {
    doc['operations'][0]['secret'] = 'Bearer abcdefghijklmnopqrstuvwxyz';
  });
  assert.match(errorsOf(result).join('\n'), /never a value/);

  const ok = mutate((doc) => {
    doc['operations'][0]['secret'] = 'GITHUB_TOKEN';
  });
  assert.deepEqual(errorsOf(ok), []);
});

test('schemaVersion 1 is refused as a map and named as legacy', () => {
  const result = validateMap({ schemaVersion: 1, id: 'x' });
  assert.match(errorsOf(result).join('\n'), /legacy format/);
});

test('an enum default must be a member of the enum', () => {
  const result = mutate((doc) => {
    doc['operations'][1]['input']['properties']['state']['default'] = 'pending';
  });
  assert.match(errorsOf(result).join('\n'), /must be one of the declared enum values/);
});
