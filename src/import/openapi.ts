// OpenAPI 3 -> map.
//
// The output is a *draft*: every field, view and link it invents is marked
// `inferred` or `spec`, never `human`, and a human correction goes into an
// overrides file so the next import cannot overwrite it.
//
// Two rules shape this file:
//
//   - a path is not a hierarchy. `/repos/{owner}/{repo}/issues` is about issues;
//     the repo is a container, not a parent resource.
//   - never invent a credential. A spec's security scheme becomes a *name* in
//     the map and a line in the import report; only a human binds a host to it.

import { isPlainObject } from '../view/types.ts';
import type { Result } from '../view/result.ts';
import { err, ok } from '../view/result.ts';
import type { InputProperty, Link, MapDocument, Operation, Pagination, Resource } from '../map/types.ts';
import { MAP_SCHEMA_VERSION } from '../map/types.ts';
import { validateMap } from '../map/validate.ts';
import type { ViewSpec } from '../view/types.ts';
import {
  actionForMethod,
  capitalise,
  containerForPath,
  draftView,
  findArrayPath,
  inferLinkFields,
  keyField,
  refName,
  resourceIdForPath,
  singularise,
  slugify,
} from './shapes.ts';
import type { Schema, SchemaResolver } from './shapes.ts';

export type ImportIssue = {
  readonly path: string;
  readonly message: string;
  readonly severity: 'error' | 'warning';
};

export type ImportStats = {
  readonly paths: number;
  readonly operations: number;
  readonly resources: number;
  readonly links: number;
  readonly skipped: number;
};

export type ImportReport = {
  readonly map: MapDocument;
  readonly issues: readonly ImportIssue[];
  readonly stats: ImportStats;
  /** Binding names a human must create; a map may not invent a credential. */
  readonly secrets: readonly string[];
};

export type ImportOptions = {
  readonly id?: string;
  readonly title?: string;
  /** Used when the document declares no usable `servers`. */
  readonly baseUrl?: string;
  /** ISO date for provenance; injected so tests are deterministic. */
  readonly today?: string;
};

export type ImportFailure = {
  readonly code: 'not_openapi' | 'unsupported_version' | 'no_paths' | 'no_base_url';
  readonly message: string;
  readonly hint?: string;
};

const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head'] as const;
const JSON_MEDIA = /(?:^|\/|\+)json$/i;
const PAGE_SKIP = ['skip', 'offset'];
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** A body with more scalars than this is not templated field by field. */
const MAX_BODY_FIELDS = 20;

type PointerResolver = (value: unknown) => unknown;

function pointerResolver(document: unknown): PointerResolver {
  const root = document;
  return (value: unknown): unknown => {
    let node = value;
    for (let hop = 0; hop < 16; hop += 1) {
      if (!isPlainObject(node) || typeof node['$ref'] !== 'string') return node;
      const ref = node['$ref'];
      if (!ref.startsWith('#/')) return undefined;
      const tokens = ref
        .slice(2)
        .split('/')
        .map((token) => decodeURIComponent(token).replace(/~1/g, '/').replace(/~0/g, '~'));
      let cursor: unknown = root;
      for (const token of tokens) {
        if (!isPlainObject(cursor)) return undefined;
        cursor = cursor[token];
      }
      node = cursor;
    }
    return undefined;
  };
}

/** `allOf` is common enough that ignoring it would drop half a real schema. */
function mergeAllOf(schema: Schema, deref: PointerResolver): Schema {
  const parts = schema['allOf'];
  if (!Array.isArray(parts)) return schema;

  const merged: Record<string, unknown> = { ...schema };
  const properties: Record<string, unknown> = {};
  const required = new Set<string>();

  for (const part of parts) {
    const resolved = deref(part);
    if (!isPlainObject(resolved)) continue;
    const flattened = mergeAllOf(resolved as Schema, deref);
    if (isPlainObject(flattened['properties'])) Object.assign(properties, flattened['properties']);
    if (Array.isArray(flattened['required'])) {
      for (const name of flattened['required']) if (typeof name === 'string') required.add(name);
    }
    for (const [key, value] of Object.entries(flattened)) {
      if (key === 'properties' || key === 'required' || key === 'allOf') continue;
      if (merged[key] === undefined) merged[key] = value;
    }
  }

  if (Object.keys(properties).length > 0) merged['properties'] = { ...properties, ...(isPlainObject(schema['properties']) ? schema['properties'] : {}) };
  if (required.size > 0) merged['required'] = [...new Set([...(Array.isArray(schema['required']) ? (schema['required'] as string[]) : []), ...required])];
  delete merged['allOf'];
  return merged;
}

function schemaResolver(deref: PointerResolver): SchemaResolver {
  return (schema) => {
    const first = deref(schema);
    if (!isPlainObject(first)) return undefined;
    return mergeAllOf(first as Schema, deref);
  };
}


function typeOfSchema(schema: Schema): string | undefined {
  if (typeof schema['type'] === 'string') return schema['type'];
  if (Array.isArray(schema['type'])) {
    return schema['type'].find((entry): entry is string => typeof entry === 'string' && entry !== 'null');
  }
  if (schema['properties'] !== undefined) return 'object';
  if (schema['items'] !== undefined) return 'array';
  if (schema['enum'] !== undefined) return 'string';
  return undefined;
}

function propertiesOf(schema: Schema | undefined): Record<string, unknown> {
  const properties = schema?.['properties'];
  return isPlainObject(properties) ? properties : {};
}

function trim(text: unknown, limit: number): string | undefined {
  if (typeof text !== 'string') return undefined;
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine === '') return undefined;
  return oneLine.length <= limit ? oneLine : `${oneLine.slice(0, limit - 1).trimEnd()}…`;
}

function sanitiseName(name: string, taken: Set<string>): string {
  const base = IDENTIFIER.test(name) ? name : name.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^([0-9])/, 'n_$1') || 'value';
  let candidate = base;
  let suffix = 2;
  while (taken.has(candidate)) candidate = `${base}_${suffix++}`;
  taken.add(candidate);
  return candidate;
}

function inputType(schema: Schema): InputProperty['type'] {
  switch (typeOfSchema(schema)) {
    case 'integer':
      return 'integer';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    default:
      return 'string';
  }
}

function inputEnum(schema: Schema): readonly (string | number | boolean)[] | undefined {
  const values = schema['enum'];
  if (!Array.isArray(values)) return undefined;
  const allowed = values.filter((value): value is string | number | boolean => ['string', 'number', 'boolean'].includes(typeof value));
  return allowed.length === 0 ? undefined : allowed;
}

function inputLimits(schema: Schema): Pick<InputProperty, 'minimum' | 'maximum'> {
  const minimum = schema['minimum'];
  const maximum = schema['maximum'];
  return {
    ...(typeof minimum === 'number' ? { minimum } : {}),
    ...(typeof maximum === 'number' ? { maximum } : {}),
  };
}

function serverUrl(servers: unknown, deref: PointerResolver): { absolute: string | undefined; relative: readonly string[] } {
  if (!Array.isArray(servers)) return { absolute: undefined, relative: [] };

  const relative: string[] = [];

  for (const entry of servers) {
    const server = deref(entry);
    if (!isPlainObject(server) || typeof server['url'] !== 'string') continue;

    let url = server['url'];
    const variables = isPlainObject(server['variables']) ? server['variables'] : {};
    url = url.replace(/\{([^}]+)\}/g, (match, name: string) => {
      const variable = variables[name];
      if (isPlainObject(variable) && typeof variable['default'] === 'string') return variable['default'];
      return match;
    });

    if (/\{[^}]+\}/.test(url)) continue;
    if (!/^https?:\/\//i.test(url)) {
      relative.push(url);
      continue;
    }
    return { absolute: url.replace(/\/+$/, ''), relative };
  }

  return { absolute: undefined, relative };
}

const GENERIC_HOST_LABELS = new Set(['api', 'www', 'openapi', 'rest', 'docs', 'localhost', 'v1', 'v2', 'v3']);

/** A short map id from the base URL host: api.github.com -> github. */
function idFromHost(baseUrl: string): string | undefined {
  try {
    const labels = new URL(baseUrl).hostname.toLowerCase().split('.');
    if (labels.length > 1) labels.pop();
    const label = labels.find((entry) => !GENERIC_HOST_LABELS.has(entry) && !/^\d+$/.test(entry));
    return label === undefined ? undefined : slugify(label);
  } catch {
    return undefined;
  }
}

function mapId(title: string, baseUrl: string, explicit: string | undefined): string {
  if (explicit !== undefined) return slugify(explicit);
  const fromTitle = slugify(title);
  // A short title is already the name; a long marketing title is not an address.
  return fromTitle.length <= 24 ? fromTitle : (idFromHost(baseUrl) ?? fromTitle.slice(0, 24).replace(/_+$/, ''));
}

function pickResponse(responses: unknown, deref: PointerResolver): { status: string; schema: unknown } | undefined {
  if (!isPlainObject(responses)) return undefined;

  const preferred = ['200', '201', '202', '203', '204'];
  const keys = [...preferred.filter((key) => responses[key] !== undefined), ...Object.keys(responses).sort()];

  for (const key of keys) {
    if (key === '204') return { status: key, schema: undefined };
    const response = deref(responses[key]);
    if (!isPlainObject(response)) continue;
    const content = response['content'];
    if (!isPlainObject(content)) continue;

    for (const [media, entry] of Object.entries(content)) {
      if (!JSON_MEDIA.test(media)) continue;
      const media_object = deref(entry);
      if (isPlainObject(media_object) && media_object['schema'] !== undefined) {
        return { status: key, schema: media_object['schema'] };
      }
    }
  }

  return undefined;
}

/** Follow a JSON Pointer through resolved nodes, returning the raw node there. */
function nodeAt(root: unknown, at: string, deref: PointerResolver): unknown {
  let node: unknown = root;
  for (const token of at.split('/').filter(Boolean)) {
    const resolved = deref(node);
    if (!isPlainObject(resolved)) return undefined;
    node = resolved[token.replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  return node;
}

/**
 * The shape of one record in a response, and the `$ref` name it came from.
 *
 * A list endpoint usually wraps its array (`{items: [...]}`), so the record
 * shape is found through `findArrayPath` rather than assumed to be the response
 * root. The `$ref` name is what tells us the operation returns a resource we
 * already know, instead of a shape named `PetsPage`.
 */
function recordSchema(
  schema: unknown,
  resolve: SchemaResolver,
  deref: PointerResolver,
): { shape: Schema | undefined; ref: string | undefined } {
  const array = findArrayPath(schema, resolve);
  if (array !== undefined) {
    const arrayNode = deref(nodeAt(schema, array.at, deref));
    const items = isPlainObject(arrayNode) ? arrayNode['items'] : undefined;
    return {
      shape: array.item,
      ref: refName(isPlainObject(items) ? items['$ref'] : items),
    };
  }

  const root = resolve(schema);
  const raw = isPlainObject(schema) ? schema : undefined;
  return { shape: root, ref: refName(raw?.['$ref']) };
}

function paginationFor(operation: unknown, schema: Schema | undefined, resolve: SchemaResolver): Pagination | undefined {
  if (!isPlainObject(operation) || !Array.isArray(operation['parameters'])) return undefined;
  if (schema === undefined) return undefined;

  const names = new Set<string>();
  for (const raw of operation['parameters']) {
    if (isPlainObject(raw) && typeof raw['name'] === 'string') names.add(raw['name']);
  }

  if (!names.has('limit')) return undefined;
  const skip = PAGE_SKIP.find((name) => names.has(name));
  if (skip === undefined) return undefined;

  const properties = propertiesOf(schema);
  if (properties['total'] === undefined || properties[skip] === undefined || properties['limit'] === undefined) return undefined;

  return { kind: 'offset', totalPath: '/total', skipPath: `/${skip}`, limitPath: '/limit' };
}

function securityNames(security: unknown): string[] {
  if (!Array.isArray(security)) return [];
  const names: string[] = [];

  for (const requirement of security) {
    if (!isPlainObject(requirement)) continue;
    for (const name of Object.keys(requirement)) {
      const clean = name.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^([0-9])/, 'n_$1');
      if (IDENTIFIER.test(clean) && !names.includes(clean)) names.push(clean);
    }
  }

  return names;
}

type OperationDraft = {
  readonly method: string;
  readonly path: string;
  readonly pathItem: Record<string, unknown>;
  readonly operation: unknown;
  readonly resource: string;
  readonly container: string | undefined;
  readonly action: string;
  readonly secret?: string;
};

export function importOpenApi(document: unknown, options: ImportOptions = {}): Result<ImportReport, ImportFailure> {
  if (!isPlainObject(document)) {
    return err({ code: 'not_openapi', message: 'the document is not a JSON object' });
  }

  const version = document['openapi'];
  if (typeof version !== 'string') {
    if (document['swagger'] !== undefined) {
      return err({
        code: 'unsupported_version',
        message: `Swagger ${String(document['swagger'])} is not supported`,
        hint: 'convert with swagger2openapi first; this importer reads OpenAPI 3.x',
      });
    }
    return err({ code: 'not_openapi', message: "the document has no 'openapi' field", hint: 'expected an OpenAPI 3.x document' });
  }
  if (!version.startsWith('3.')) {
    return err({ code: 'unsupported_version', message: `OpenAPI ${version} is not supported`, hint: 'this importer reads OpenAPI 3.x' });
  }

  const paths = document['paths'];
  if (!isPlainObject(paths)) return err({ code: 'no_paths', message: 'the document declares no paths' });

  const deref = pointerResolver(document);
  const resolve = schemaResolver(deref);

  const servers = serverUrl(document['servers'], deref);
  const baseUrl = servers.absolute ?? options.baseUrl;
  if (baseUrl === undefined) {
    return err({
      code: 'no_base_url',
      message:
        servers.relative.length === 0
          ? 'no usable server URL'
          : `the document declares only a relative server URL (${servers.relative.join(', ')}), which is resolved against the document's own location and cannot be known from a file`,
      hint: servers.relative.length === 0
        ? 'pass --base-url, or add a server whose url is absolute'
        : `pass --base-url, e.g. --base-url https://api.example.com${servers.relative[0]?.startsWith('/') ? '' : '/'}${servers.relative[0] ?? ''}`,
    });
  }

  const info = isPlainObject(document['info']) ? document['info'] : {};
  const rawTitle = options.title ?? trim(info['title'], 120) ?? 'api';
  const id = mapId(rawTitle, baseUrl, options.id);
  const title = options.title ?? trim(info['title'], 120) ?? capitalise(id);
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  const globalSecurity = securityNames(document['security']);

  const issues: ImportIssue[] = [];
  const drafts: OperationDraft[] = [];
  const secrets = new Set<string>();

  for (const [path, rawItem] of Object.entries(paths)) {
    const item = deref(rawItem);
    if (!isPlainObject(item)) {
      issues.push({ path: `paths.${path}`, message: 'path item must be an object', severity: 'warning' });
      continue;
    }

    const resource = resourceIdForPath(path);
    if (resource === undefined) {
      issues.push({ path: `paths.${path}`, message: 'cannot infer a resource from this path', severity: 'warning' });
      continue;
    }

    for (const method of METHODS) {
      const operation = item[method];
      if (operation === undefined) continue;
      if (!isPlainObject(operation)) {
        issues.push({ path: `paths.${path}.${method}`, message: 'operation must be an object', severity: 'warning' });
        continue;
      }
      if (operation['deprecated'] === true) {
        issues.push({ path: `paths.${path}.${method}`, message: 'deprecated; skipped', severity: 'warning' });
        continue;
      }

      const security = Array.isArray(operation['security']) ? securityNames(operation['security']) : undefined;
      const names = security ?? globalSecurity;
      const secret = names[0];

      drafts.push({
        method: method.toUpperCase(),
        path,
        pathItem: item,
        operation,
        resource,
        container: containerForPath(path),
        action: actionForMethod(method, path),
        ...(secret === undefined ? {} : { secret }),
      });
      if (secret !== undefined) secrets.add(secret);
    }
  }

  if (drafts.length === 0) {
    return err({ code: 'no_paths', message: 'no importable operations', hint: 'every path was skipped; see the import report with --json' });
  }

  // Ids: `<resource>.<action>`, disambiguated by container, then by counter.
  const usedIds = new Set<string>();
  const operationIds = drafts.map((draft) => {
    const base = `${draft.resource}.${draft.action}`;
    const candidates = [
      base,
      draft.container === undefined ? undefined : `${draft.resource}.${draft.container}_${draft.action}`,
    ].filter((value): value is string => value !== undefined);

    for (const candidate of candidates) {
      if (!usedIds.has(candidate)) {
        usedIds.add(candidate);
        return candidate;
      }
    }

    let index = 2;
    while (usedIds.has(`${base}_${index}`)) index += 1;
    const fallback = `${base}_${index}`;
    usedIds.add(fallback);
    issues.push({ path: `paths.${draft.path}`, message: `id ${base} was taken; used ${fallback}`, severity: 'warning' });
    return fallback;
  });

  const operations: Operation[] = [];
  const resourceTitles = new Map<string, string>();
  const resourceKeys = new Map<string, string>();
  const schemasByResource = new Map<string, Schema>();

  drafts.forEach((draft, index) => {
    const operationId = operationIds[index]!;
    const source = draft.operation as Record<string, unknown>;
    const declaredTags = Array.isArray(source['tags'])
      ? source['tags'].filter((tag): tag is string => typeof tag === 'string')
      : [];
    if (!resourceTitles.has(draft.resource) && declaredTags.length > 0) {
      resourceTitles.set(draft.resource, declaredTags[0]!);
    }

    const parameters = new Map<string, { readonly in: string; readonly name: string; readonly node: Schema; readonly raw: Record<string, unknown> }>();
    const collect = (list: unknown): void => {
      if (!Array.isArray(list)) return;
      for (const raw of list) {
        const parameter = deref(raw);
        if (!isPlainObject(parameter)) continue;
        const location = typeof parameter['in'] === 'string' ? parameter['in'] : '';
        const name = typeof parameter['name'] === 'string' ? parameter['name'] : '';
        if (location === '' || name === '') continue;
        const schema = resolve(isPlainObject(parameter['schema']) ? parameter['schema'] : parameter);
        if (schema === undefined) continue;
        parameters.set(`${location}:${name}`, { in: location, name, node: schema, raw: parameter });
      }
    };
    collect(draft.pathItem['parameters']);
    collect(source['parameters']);

    const properties: Record<string, InputProperty> = {};
    const required = new Set<string>();
    const query: Record<string, string> = {};
    const taken = new Set<string>();

    for (const parameter of parameters.values()) {
      if (parameter.in === 'header' || parameter.in === 'cookie') continue;

      const type = typeOfSchema(parameter.node);
      if (type === 'array' || type === 'object') {
        issues.push({
          path: `paths.${draft.path}.${draft.method.toLowerCase()}.parameters`,
          message: `${parameter.in} parameter '${parameter.name}' is ${type}; skipped`,
          severity: 'warning',
        });
        continue;
      }

      const name = parameter.in === 'path' ? parameter.name : sanitiseName(parameter.name, taken);
      const isRequired = parameter.in === 'path' || parameter.raw['required'] === true;
      const allowed = inputEnum(parameter.node);
      const fallback = parameter.node['default'];
      const description = trim(parameter.raw['description'], 160);

      properties[name] = {
        type: inputType(parameter.node),
        ...(description === undefined ? {} : { description }),
        ...(allowed === undefined ? {} : { enum: allowed }),
        ...(typeof fallback === 'string' || typeof fallback === 'number' || typeof fallback === 'boolean' ? { default: fallback } : {}),
        ...inputLimits(parameter.node),
      };
      taken.add(name);
      if (isRequired) required.add(name);

      if (parameter.in === 'query') query[parameter.name] = `{${name}}`;
    }

    // Paths must declare every placeholder they contain, even when the spec
    // forgot to describe the parameter.
    for (const match of draft.path.matchAll(/\{([^}]+)\}/g)) {
      const name = match[1]!;
      if (properties[name] === undefined) {
        properties[name] = { type: 'string' };
        required.add(name);
        issues.push({
          path: `paths.${draft.path}`,
          message: `path placeholder {${name}} has no parameter declaration; declared as a required string`,
          severity: 'warning',
        });
      }
    }

    const body = requestBodyTemplate(source['requestBody'], deref, resolve, properties, required, issues, draft.path);
    const picked = pickResponse(source['responses'], deref);
    const view = picked === undefined ? { select: '/', mode: 'auto' as const } : draftView(picked.schema, resolve);

    const record = recordSchema(picked?.schema, resolve, deref);
    const returned = record.ref === undefined ? undefined : slugify(singularise(record.ref));
    if (record.shape !== undefined && returned === draft.resource && !schemasByResource.has(draft.resource)) {
      schemasByResource.set(draft.resource, record.shape);
      const key = keyField(record.shape, draft.resource, resolve);
      if (key !== undefined) resourceKeys.set(draft.resource, key);
    }

    const returns = returned;

    const summary = trim(source['summary'], 120);
    const description = trim(source['description'], 600);
    const pagination = paginationFor(source, resolve(picked?.schema), resolve);

    operations.push({
      id: operationId,
      resource: draft.resource,
      ...(returns === undefined ? {} : { returns }),
      title: summary ?? `${capitalise(draft.action)} ${capitalise(draft.resource).toLowerCase()}`,
      ...(description === undefined ? {} : { description }),
      ...(draft.method === 'GET' || draft.method === 'HEAD' ? {} : { mutating: true }),
      provenance: 'spec',
      request: {
        method: draft.method as Operation['request']['method'],
        path: draft.path,
        ...(Object.keys(query).length === 0 ? {} : { query }),
        ...(body === undefined ? {} : { body }),
      },
      ...(Object.keys(properties).length === 0
        ? {}
        : {
            input: {
              ...(required.size === 0 ? {} : { required: [...required] }),
              properties,
            },
          }),
      ...(pagination === undefined ? {} : { pagination }),
      view,
      ...(draft.secret === undefined ? {} : { secret: draft.secret }),
    });
  });

  // Resources: every operation's own resource, plus anything it returns.
  const resourceIds = new Set<string>();
  for (const operation of operations) {
    resourceIds.add(operation.resource);
    if (operation.returns !== undefined) resourceIds.add(operation.returns);
  }

  const resources: Resource[] = [...resourceIds].sort().map((resourceId) => {
    const key = resourceKeys.get(resourceId);
    return {
      id: resourceId,
      title: resourceTitles.get(resourceId) ?? capitalise(resourceId),
      ...(key === undefined ? {} : { key }),
    };
  });

  const links = buildLinks(schemasByResource, resources, operations, issues);

  const map: MapDocument = {
    schemaVersion: MAP_SCHEMA_VERSION,
    id,
    title,
    baseUrl,
    ...(trim(info['description'], 400) === undefined ? {} : { description: trim(info['description'], 400)! }),
    provenance: { source: 'spec', date: today },
    resources,
    operations,
    ...(links.length === 0 ? {} : { links }),
  };

  const validated = validateMap(map);
  for (const issue of validated.issues) {
    issues.push({ path: issue.path, message: issue.message, severity: issue.severity });
  }

  return ok({
    map: validated.map ?? map,
    issues,
    stats: {
      paths: Object.keys(paths).length,
      operations: operations.length,
      resources: resources.length,
      links: links.length,
      skipped: issues.filter((issue) => issue.message.includes('skipped')).length,
    },
    secrets: [...secrets].sort(),
  });
}

function requestBodyTemplate(
  requestBody: unknown,
  deref: PointerResolver,
  resolve: SchemaResolver,
  properties: Record<string, InputProperty>,
  required: Set<string>,
  issues: ImportIssue[],
  path: string,
): unknown | undefined {
  const body = deref(requestBody);
  if (!isPlainObject(body)) return undefined;

  const content = body['content'];
  if (!isPlainObject(content)) return undefined;

  const media = Object.keys(content).find((name) => JSON_MEDIA.test(name));
  if (media === undefined) {
    const kinds = Object.keys(content).join(', ');
    issues.push({
      path: `paths.${path}.requestBody`,
      message: `request body is ${kinds || 'undeclared'}; only JSON bodies are templated`,
      severity: 'warning',
    });
    return undefined;
  }

  const entry = deref(content[media]);
  const schema = resolve(isPlainObject(entry) ? entry['schema'] : undefined);
  if (schema === undefined) return undefined;

  const bodyRequired = new Set(
    Array.isArray(schema['required']) ? (schema['required'] as unknown[]).filter((name): name is string => typeof name === 'string') : [],
  );

  const template: Record<string, string> = {};
  let optional = 0;
  let dropped = 0;

  for (const [name, raw] of Object.entries(propertiesOf(schema))) {
    const child = resolve(raw);
    if (child === undefined) continue;
    const type = typeOfSchema(child);
    if (type === 'object' || type === 'array') continue;
    if (!IDENTIFIER.test(name)) continue;

    const needed = bodyRequired.has(name);

    // Optional scalars are templated too, because the request builder omits a
    // key whose placeholder the caller did not fill. That is what makes a
    // partial PATCH expressible: `pet.update { name }` sends only `name`.
    // Nested objects and arrays are still left out; templating them would need
    // a whole subtree the caller cannot see in `describe`.
    if (!needed && optional >= MAX_BODY_FIELDS) {
      dropped += 1;
      continue;
    }

    const description = trim(isPlainObject(raw) ? raw['description'] : undefined, 160);
    const allowed = inputEnum(child);
    const fallback = child['default'];

    if (properties[name] === undefined) {
      properties[name] = {
        type: inputType(child),
        ...(description === undefined ? {} : { description }),
        ...(allowed === undefined ? {} : { enum: allowed }),
        ...(typeof fallback === 'string' || typeof fallback === 'number' || typeof fallback === 'boolean' ? { default: fallback } : {}),
        ...inputLimits(child),
      };
    }

    if (needed) required.add(name);
    else optional += 1;

    template[name] = `{${name}}`;
  }

  if (dropped > 0) {
    issues.push({
      path: `paths.${path}.requestBody`,
      message: `${dropped} optional body field(s) beyond ${MAX_BODY_FIELDS} were not templated`,
      severity: 'warning',
    });
  }

  return Object.keys(template).length === 0 ? undefined : template;
}

function buildLinks(
  schemas: ReadonlyMap<string, Schema>,
  resources: readonly Resource[],
  operations: readonly Operation[],
  issues: ImportIssue[],
): Link[] {
  const getters = operations.filter((operation) => {
    const placeholders = [...operation.request.path.matchAll(/\{([^}]+)\}/g)];
    return operation.request.method === 'GET' && placeholders.length === 1;
  });

  const links: Link[] = [];
  for (const candidate of inferLinkFields(schemas, resources)) {
    const target = getters.find((operation) => (operation.returns ?? operation.resource) === candidate.to);
    if (target === undefined) continue;

    const argument = [...target.request.path.matchAll(/\{([^}]+)\}/g)][0]?.[1];
    if (argument === undefined) continue;

    links.push({
      from: candidate.from,
      field: candidate.field,
      to: candidate.to,
      operation: target.id,
      argument,
      provenance: 'inferred',
    });
  }

  if (links.length === 0 && schemas.size > 0) {
    issues.push({
      path: 'links',
      message: 'no links inferred; no resource declares a *_id field that names another resource',
      severity: 'warning',
    });
  }

  return links;
}

export type { Schema, SchemaResolver };
