import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  actionForMethod,
  containerForPath,
  draftView,
  findArrayPath,
  inferLinkFields,
  keyField,
  refName,
  resourceIdForPath,
  scalarFields,
  singularise,
  slugify,
} from '../../src/import/shapes.ts';

const identity = (schema: unknown) =>
  schema !== null && typeof schema === 'object' && !Array.isArray(schema)
    ? (schema as Record<string, unknown>)
    : undefined;

test('singularise handles the shapes real APIs use', () => {
  assert.equal(singularise('pets'), 'pet');
  assert.equal(singularise('issues'), 'issue');
  assert.equal(singularise('categories'), 'category');
  assert.equal(singularise('statuses'), 'status');
  assert.equal(singularise('addresses'), 'address');
  assert.equal(singularise('branches'), 'branch');
  assert.equal(singularise('boxes'), 'box');
  assert.equal(singularise('people'), 'person');
  assert.equal(singularise('children'), 'child');
  assert.equal(singularise('status'), 'status');
  assert.equal(singularise('series'), 'series');
  assert.equal(singularise('Pet'), 'pet');
});

test('slugify keeps addresses safe', () => {
  assert.equal(slugify('Pet Store'), 'pet_store');
  assert.equal(slugify('v1.2 API'), 'v1_2_api');
  assert.equal(slugify('  --  '), 'resource');
  assert.equal(slugify('2fa'), 'r_2fa');
});

test('the resource is the last named segment, not the first', () => {
  assert.equal(resourceIdForPath('/pets'), 'pet');
  assert.equal(resourceIdForPath('/pets/{petId}'), 'pet');
  assert.equal(resourceIdForPath('/repos/{owner}/{repo}/issues'), 'issue');
  assert.equal(resourceIdForPath('/v1/orgs/{org}/issues/{issue}/comments'), 'comment');
  assert.equal(resourceIdForPath('/api'), undefined);
  assert.equal(resourceIdForPath('/{id}'), undefined);

  assert.equal(containerForPath('/repos/{owner}/{repo}/issues'), 'repo');
  assert.equal(containerForPath('/pets'), undefined);
});

test('the action says what the call does, not which method it used', () => {
  assert.equal(actionForMethod('GET', '/pets'), 'list');
  assert.equal(actionForMethod('GET', '/pets/{id}'), 'get');
  assert.equal(actionForMethod('POST', '/pets'), 'create');
  assert.equal(actionForMethod('PATCH', '/pets/{id}'), 'update');
  assert.equal(actionForMethod('DELETE', '/pets/{id}'), 'delete');
});

test('findArrayPath prefers a conventional container over an incidental one', () => {
  const page = { type: 'object', properties: { meta: { type: 'object' }, items: { type: 'array', items: { type: 'object', properties: { id: {} } } } } };
  assert.deepEqual(findArrayPath(page, identity), { at: '/items', item: page.properties.items.items });

  const nested = { type: 'object', properties: { data: { type: 'object', properties: { records: { type: 'array', items: { type: 'object', properties: { id: {} } } } } } } };
  assert.equal(findArrayPath(nested, identity)?.at, '/data/records');

  const top = { type: 'array', items: { type: 'object', properties: { id: {} } } };
  assert.equal(findArrayPath(top, identity)?.at, '/');

  // An array of scalars is a list, not a table.
  const scalars = { type: 'object', properties: { tags: { type: 'array', items: { type: 'string' } } } };
  assert.equal(findArrayPath(scalars, identity), undefined);
});

test('scalarFields ranks identity first and stops at one level of nesting', () => {
  const item = {
    type: 'object',
    properties: {
      created_at: { type: 'string' },
      name: { type: 'string' },
      user: { type: 'object', properties: { login: { type: 'string' }, id: { type: 'integer' } } },
      deep: { type: 'object', properties: { inner: { type: 'object', properties: { x: { type: 'string' } } } } },
      tags: { type: 'array', items: { type: 'string' } },
      id: { type: 'integer' },
    },
  };

  assert.deepEqual(scalarFields(item, identity), ['id', 'name', 'created_at', 'user.login', 'user.id']);
});

test('a draft view is rows for collections and document for a single object', () => {
  const collection = { type: 'array', items: { type: 'object', properties: { id: { type: 'integer' }, title: { type: 'string' } } } };
  assert.deepEqual(draftView(collection, identity), { select: '/', mode: 'rows', fields: ['id', 'title'] });

  const single = { type: 'object', properties: { id: { type: 'integer' } } };
  assert.deepEqual(draftView(single, identity), { select: '/', mode: 'document' });

  const scalars = { type: 'array', items: { type: 'string' } };
  assert.deepEqual(draftView(scalars, identity), { select: '/', mode: 'list' });

  assert.deepEqual(draftView(undefined, identity), { select: '/', mode: 'auto' });
});

test('links come only from *_id fields that name a resource we know', () => {
  const schemas = new Map<string, Record<string, unknown>>([
    ['pet', { type: 'object', properties: { id: { type: 'integer' }, owner_id: { type: 'integer' }, ghost_id: { type: 'integer' } } }],
    ['owner', { type: 'object', properties: { id: { type: 'integer' } } }],
  ]);
  const resources = [
    { id: 'pet', title: 'Pet' },
    { id: 'owner', title: 'Owner' },
  ];

  assert.deepEqual(inferLinkFields(schemas, resources), [{ from: 'pet', field: 'owner_id', to: 'owner' }]);
});

test('keyField and refName read the declared identity', () => {
  const item = { type: 'object', properties: { pet_id: { type: 'integer' } } };
  assert.equal(keyField(item, 'pet', identity), 'pet_id');
  assert.equal(keyField({ type: 'object', properties: { id: {} } }, 'pet', identity), 'id');
  assert.equal(keyField({ type: 'object', properties: { name: {} } }, 'pet', identity), undefined);

  assert.equal(refName('#/components/schemas/Pet'), 'Pet');
  assert.equal(refName('Pet'), 'Pet');
  assert.equal(refName(undefined), undefined);
});
