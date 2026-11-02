// Shape inference: from a schema (or a sample) to resources, views and links.
//
// Everything here is pure and conservative. A guessed field is cheap to correct
// and expensive to trust, so every rule below either follows a convention that
// is near-universal (`id`, `*_id`, `items`/`data`) or refuses to guess at all.
// The caller marks what comes out as `inferred`, never `spec`.

import type { Link, Resource } from '../map/types.ts';
import type { ViewSpec } from '../view/types.ts';

export type Schema = Record<string, unknown>;
export type SchemaResolver = (schema: unknown) => Schema | undefined;

const SKIP_SEGMENT = /^(?:api|rest|v\d+(?:\.\d+)?)$/i;

/** Words whose plural is not an `s`. Small on purpose: a wrong singular is a
 * wrong resource id, and a wrong resource id is a broken address. */
const IRREGULAR: Readonly<Record<string, string>> = {
  people: 'person',
  children: 'child',
  men: 'man',
  women: 'woman',
  mice: 'mouse',
  data: 'data',
  media: 'media',
  news: 'news',
  series: 'series',
  species: 'species',
  status: 'status',
  info: 'info',
  feedback: 'feedback',
};

/** Ranked field names: identity first, then the fields people actually read. */
const FIELD_RANK: Readonly<Record<string, number>> = {
  id: 0,
  name: 1,
  title: 2,
  slug: 3,
  key: 4,
  state: 5,
  status: 6,
  type: 7,
  email: 8,
  price: 9,
  amount: 10,
  created_at: 11,
  updated_at: 12,
};

/** Container names that usually hold the collection an operation returns. */
const ARRAY_RANK: Readonly<Record<string, number>> = {
  data: 0,
  items: 1,
  results: 2,
  records: 3,
  rows: 4,
  content: 5,
  list: 6,
  entries: 7,
  values: 8,
  elements: 9,
  nodes: 10,
  docs: 11,
  documents: 12,
};

export function singularise(word: string): string {
  const lower = word.toLowerCase();
  if (IRREGULAR[lower] !== undefined) return IRREGULAR[lower]!;
  if (lower.endsWith('ies') && lower.length > 4) return `${lower.slice(0, -3)}y`;
  if (/(?:ses|xes|zes|ches|shes)$/.test(lower)) return lower.slice(0, -2);
  if (lower.endsWith('s') && !lower.endsWith('ss') && !lower.endsWith('us') && !lower.endsWith('is')) return lower.slice(0, -1);
  return lower;
}

/** A safe resource id: lower-case, dots and spaces become underscores. */
export function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
  if (slug === '') return 'resource';
  return /^[a-z]/.test(slug) ? slug : `r_${slug}`;
}

export function capitalise(id: string): string {
  const words = id.split(/[._-]+/).filter(Boolean);
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

/** Trailing segments that name an action, not a thing. Ambiguous nouns such as
 * `inventory` are here because in real specs they are operations (`GET
 * /store/inventory`), and a wrong resource id is a wrong address. */
const ACTION_WORDS = new Set([
  'inventory',
  'search',
  'login',
  'logout',
  'count',
  'stats',
  'summary',
  'export',
  'import',
  'upload',
  'download',
]);

function isActionSegment(segment: string): boolean {
  return /[A-Z]/.test(segment) || ACTION_WORDS.has(segment.toLowerCase());
}

/** `findByStatus` -> `find_by_status`, so an id reads as words. */
function snakeCase(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1_$2');
}

/** The segments of a path template that name a thing, not a parameter. */
function namedSegments(path: string): string[] {
  return path
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment !== '' && !segment.startsWith('{') && !SKIP_SEGMENT.test(segment));
}

/**
 * The resource an operation works on: the last named segment of its path.
 *
 * `/repos/{owner}/{repo}/issues` is about issues, not about repos; a path is not
 * a hierarchy of resources, which is why this is one segment and not a tree.
 * A trailing action (`/pet/findByStatus`, `/store/inventory`) is not a resource,
 * so the segment before it is used instead.
 */
export function resourceIdForPath(path: string): string | undefined {
  const segments = namedSegments(path);
  const last = segments.at(-1);
  if (last === undefined) return undefined;

  const chosen = isActionSegment(last) && segments.length > 1 ? segments.at(-2)! : last;
  return slugify(singularise(chosen));
}

/** The segment before the resource, used to disambiguate an id, not to nest it. */
export function containerForPath(path: string): string | undefined {
  const segments = namedSegments(path);
  const before = segments.at(-2);
  return before === undefined ? undefined : slugify(singularise(before));
}

export function actionForMethod(method: string, path: string): string {
  const segments = path.split('/').filter(Boolean);
  const last = segments.at(-1) ?? '';
  if (last !== '' && !last.startsWith('{') && isActionSegment(last)) return slugify(snakeCase(last));

  const item = last.startsWith('{');
  switch (method.toUpperCase()) {
    case 'GET':
      return item ? 'get' : 'list';
    case 'POST':
      // A POST on an item path is an update in all but name; naming it `create`
      // collides with the collection POST and tells the agent the wrong thing.
      return item ? 'update' : 'create';
    case 'PUT':
      return 'replace';
    case 'PATCH':
      return 'update';
    case 'DELETE':
      return 'delete';
    case 'HEAD':
      return 'head';
    default:
      return method.toLowerCase();
  }
}

function typeOf(schema: Schema): string | undefined {
  if (typeof schema['type'] === 'string') return schema['type'];
  if (Array.isArray(schema['type'])) {
    const types = schema['type'].filter((entry): entry is string => typeof entry === 'string' && entry !== 'null');
    return types[0];
  }
  if (schema['properties'] !== undefined) return 'object';
  if (schema['items'] !== undefined) return 'array';
  if (schema['enum'] !== undefined) return 'string';
  return undefined;
}

function propertiesOf(schema: Schema): Record<string, unknown> {
  const properties = schema['properties'];
  return properties !== null && typeof properties === 'object' && !Array.isArray(properties)
    ? (properties as Record<string, unknown>)
    : {};
}

/**
 * The path to the array of records inside a response schema.
 *
 * Only arrays of objects count: an array of scalars is a list, not a table, and
 * a wrong `select` is worse than no view at all.
 */
export function findArrayPath(schema: unknown, resolve: SchemaResolver, maxDepth = 3): { at: string; item: Schema } | undefined {
  const root = resolve(schema);
  if (root === undefined) return undefined;

  if (typeOf(root) === 'array') {
    const item = resolve(root['items']);
    return item === undefined ? undefined : { at: '/', item };
  }

  type Candidate = { at: string; item: Schema; rank: number; order: number; depth: number };
  const candidates: Candidate[] = [];
  let order = 0;

  const walk = (node: Schema, prefix: string, depth: number): void => {
    for (const [name, raw] of Object.entries(propertiesOf(node))) {
      const child = resolve(raw);
      if (child === undefined) continue;
      const at = `${prefix}/${escapePointer(name)}`;

      if (typeOf(child) === 'array') {
        const item = resolve(child['items']);
        if (item !== undefined && typeOf(item) === 'object' && Object.keys(propertiesOf(item)).length > 0) {
          candidates.push({ at, item, rank: ARRAY_RANK[name] ?? 20, order: order++, depth });
        }
        continue;
      }

      if (typeOf(child) === 'object' && depth + 1 < maxDepth) walk(child, at, depth + 1);
    }
  };

  walk(root, '', 0);
  candidates.sort((a, b) => a.rank - b.rank || a.depth - b.depth || a.order - b.order);

  const best = candidates[0];
  return best === undefined ? undefined : { at: best.at, item: best.item };
}

function escapePointer(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}

/** Declared columns for a row of this shape: scalars, plus one level of object. */
export function scalarFields(item: Schema, resolve: SchemaResolver, limit = 8): string[] {
  const fields: Array<{ name: string; rank: number; order: number }> = [];
  let order = 0;

  const visit = (node: Schema, prefix: string, depth: number): void => {
    for (const [name, raw] of Object.entries(propertiesOf(node))) {
      const child = resolve(raw);
      if (child === undefined) continue;

      const type = typeOf(child);
      const field = prefix === '' ? name : `${prefix}.${name}`;

      if (type === 'object') {
        // One level of nesting is useful (`user.login`); more is a document.
        if (depth === 0) visit(child, field, depth + 1);
        continue;
      }
      if (type === 'array') continue;

      fields.push({ name: field, rank: depth === 0 ? FIELD_RANK[name] ?? 100 : 100, order: order++ });
    }
  };

  visit(item, '', 0);
  fields.sort((a, b) => a.rank - b.rank || a.order - b.order);
  return fields.slice(0, limit).map((field) => field.name);
}

/** A first-draft view for a response schema. Always safe to ignore or replace. */
export function draftView(schema: unknown, resolve: SchemaResolver): ViewSpec {
  const root = resolve(schema);
  if (root === undefined) return { select: '/', mode: 'auto' };

  if (typeOf(root) === 'array') {
    const item = resolve(root['items']);
    if (item === undefined) return { select: '/', mode: 'auto' };
    if (typeOf(item) !== 'object') return { select: '/', mode: 'list' };
    const fields = scalarFields(item, resolve);
    return { select: '/', mode: 'rows', ...(fields.length === 0 ? {} : { fields }) };
  }

  const array = findArrayPath(root, resolve);
  if (array !== undefined) {
    const fields = scalarFields(array.item, resolve);
    return { select: array.at, mode: 'rows', ...(fields.length === 0 ? {} : { fields }) };
  }

  if (typeOf(root) === 'object') return { select: '/', mode: 'document' };
  return { select: '/', mode: 'auto' };
}

/** The `$ref` name at the end of a JSON Reference, e.g. `Issue`. */
export function refName(ref: unknown): string | undefined {
  if (typeof ref !== 'string') return undefined;
  const tail = ref.split('/').at(-1);
  return tail === undefined || tail === '' ? undefined : tail;
}

/** The field that identifies a row, if the shape declares one. */
export function keyField(item: Schema, resourceId: string, resolve: SchemaResolver): string | undefined {
  const properties = propertiesOf(item);
  if (properties['id'] !== undefined) return 'id';
  const own = `${resourceId}_id`;
  if (properties[own] !== undefined) return own;
  return undefined;
}

export type LinkCandidate = {
  readonly from: string;
  readonly field: string;
  readonly to: string;
};

/**
 * Links from `*_id` fields in a resource's own shape, matched against resources
 * that already exist. No guessing at plural forms beyond `singularise`, and no
 * link to a resource that has no single-argument getter.
 */
export function inferLinkFields(schemas: ReadonlyMap<string, Schema>, resources: readonly Resource[]): LinkCandidate[] {
  const known = new Set(resources.map((resource) => resource.id));
  const candidates: LinkCandidate[] = [];
  const seen = new Set<string>();

  for (const [from, schema] of schemas) {
    for (const name of Object.keys(propertiesOf(schema))) {
      if (!name.endsWith('_id') || name.length <= 3) continue;
      const to = slugify(singularise(name.slice(0, -3)));
      if (to === from || !known.has(to)) continue;

      const key = `${from}|${name}|${to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({ from, field: name, to });
    }
  }

  return candidates;
}
