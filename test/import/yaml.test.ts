import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseYaml } from '../../src/import/yaml.ts';

function ok(text: string): unknown {
  const result = parseYaml(text);
  assert.equal(result.ok, true, result.ok ? '' : `line ${result.error.line}: ${result.error.message}`);
  if (!result.ok) throw new Error('unreachable');
  return result.value;
}

function failure(text: string): { message: string; line: number } {
  const result = parseYaml(text);
  assert.equal(result.ok, false);
  if (result.ok) throw new Error('unreachable');
  return result.error;
}

test('reads a nested OpenAPI-shaped document', () => {
  const value = ok(`
openapi: 3.0.3
info:
  title: Petstore
  version: "1.0.0"
servers:
  - url: https://api.example.com/v1
paths:
  /pets:
    get:
      summary: List pets
      parameters:
        - name: limit
          in: query
          schema:
            type: integer
            default: 20
      responses:
        "200":
          description: ok
`);

  assert.deepEqual(value, {
    openapi: '3.0.3',
    info: { title: 'Petstore', version: '1.0.0' },
    servers: [{ url: 'https://api.example.com/v1' }],
    paths: {
      '/pets': {
        get: {
          summary: 'List pets',
          parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', default: 20 } }],
          responses: { '200': { description: 'ok' } },
        },
      },
    },
  });
});

test('flow collections, quoting and comments', () => {
  const value = ok(`
# leading comment
required: [id, name]
mode: {a: 1, b: two}
quoted: "has: a colon"
single: 'it''s fine'
url: https://example.com/#fragment
commented: value # trailing comment
hashed: "a # b"
`);

  assert.deepEqual(value, {
    required: ['id', 'name'],
    mode: { a: 1, b: 'two' },
    quoted: 'has: a colon',
    single: "it's fine",
    url: 'https://example.com/#fragment',
    commented: 'value',
    hashed: 'a # b',
  });
});

test('scalars: booleans, null, numbers', () => {
  const value = ok(`
a: true
b: false
c: null
d: ~
e: 3.5
f: -12
g: 1e3
h: "007"
`);

  assert.deepEqual(value, { a: true, b: false, c: null, d: null, e: 3.5, f: -12, g: 1000, h: '007' });
});

test('literal and folded block scalars', () => {
  const value = ok(`
literal: |
  first line
  second line
folded: >
  one
  two

  three
plain: next
`);

  assert.deepEqual(value, {
    literal: 'first line\nsecond line\n',
    folded: 'one two\nthree\n',
    plain: 'next',
  });
});

test('anchors, aliases and merge keys', () => {
  const value = ok(`
base: &base
  type: object
  properties:
    id:
      type: integer
derived:
  <<: *base
  description: inherits
copy: *base
list:
  - &item abc
  - *item
`);

  assert.deepEqual(value, {
    base: { type: 'object', properties: { id: { type: 'integer' } } },
    derived: { type: 'object', properties: { id: { type: 'integer' } }, description: 'inherits' },
    copy: { type: 'object', properties: { id: { type: 'integer' } } },
    list: ['abc', 'abc'],
  });
});

test('a sequence may sit at the same indent as its key', () => {
  assert.deepEqual(ok('tags:\n- a\n- b\n'), { tags: ['a', 'b'] });
});

test('a document marker is tolerated once', () => {
  assert.deepEqual(ok('---\na: 1\n'), { a: 1 });
});

test('CRLF input parses the same as LF', () => {
  assert.deepEqual(ok('a:\r\n  b: 1\r\n'), { a: { b: 1 } });
});

test('errors carry a line number and a reason', () => {
  assert.match(failure('a: 1\n---\nb: 2\n').message, /multiple YAML documents/);
  assert.match(failure('a:\n\tb: 1\n').message, /tabs/);
  assert.match(failure('a: *missing\n').message, /unknown alias/);
  assert.match(failure('a: !!str x\n').message, /tags/);
  assert.equal(failure('a: 1\n---\n').line, 2);
});
