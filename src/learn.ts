// Learn a map from one live call.
//
// For APIs whose description is missing or wrong, a single sample is the only
// reliable shape source. This module fetches once, infers a shape from the
// JSON, drafts a view, and returns a map marked `learned`. It writes nothing:
// the caller decides whether the proposed map is worth keeping.
//
// One sample is honest about what it is: it cannot show optional fields, a
// second page, or an empty collection. Every report says so.

import type { Result } from './view/result.ts';
import { err, ok } from './view/result.ts';
import type { MapDocument, Operation, Resource } from './map/types.ts';
import { MAP_SCHEMA_VERSION } from './map/types.ts';
import { validateMap } from './map/validate.ts';
import type { PayloadStore } from './store/store.ts';
import { executeOperation } from './runtime/execute.ts';
import type { AuditSink, FetchLike } from './runtime/execute.ts';
import type { Lookup, OutboundPolicy } from './runtime/policy.ts';
import type { RuntimeError } from './runtime/request.ts';
import type { BindingTable, SecretProvider } from './runtime/secrets.ts';
import { capitalise, draftView, findArrayPath, keyField, resourceIdForPath, slugify } from './import/shapes.ts';
import type { Schema } from './import/shapes.ts';

export type LearnIssue = {
  readonly path: string;
  readonly message: string;
  readonly severity: 'error' | 'warning';
};

export type LearnOptions = {
  readonly url: string;
  /** Map id; defaults to the resource name. */
  readonly id?: string;
  readonly title?: string;
  /** Binding name to send, if the endpoint needs one. */
  readonly secret?: string;
  readonly today?: string;
  readonly store: PayloadStore;
  readonly fetch?: FetchLike;
  readonly secrets?: SecretProvider;
  readonly bindings?: BindingTable;
  readonly policy?: Partial<OutboundPolicy>;
  readonly audit?: AuditSink;
  readonly lookup?: Lookup;
  readonly now?: () => number;
};

export type LearnReport = {
  readonly map: MapDocument;
  readonly issues: readonly LearnIssue[];
  readonly handle: string;
  readonly sample: {
    readonly status: number;
    readonly bytes: number;
    readonly items: number | null;
    readonly fields: readonly string[];
  };
};

export type LearnError =
  | { readonly code: 'invalid_url'; readonly message: string; readonly hint?: string }
  | RuntimeError;

const identity = (schema: unknown): Schema | undefined =>
  schema !== null && typeof schema === 'object' && !Array.isArray(schema) ? (schema as Schema) : undefined;

function typeName(value: unknown): 'null' | 'boolean' | 'number' | 'string' | 'array' | 'object' {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  const type = typeof value;
  return type === 'boolean' || type === 'number' || type === 'string' ? type : 'object';
}

/**
 * A JSON Schema from a sample. Arrays merge their items; objects union their
 * keys and keep the intersection as `required`, which is the honest reading of
 * "this field was present in every record we saw".
 */
export function inferSchema(sample: unknown): Schema {
  switch (typeName(sample)) {
    case 'null':
      return {};
    case 'boolean':
      return { type: 'boolean' };
    case 'number':
      return { type: Number.isInteger(sample) ? 'integer' : 'number' };
    case 'string':
      return { type: 'string' };
    case 'array': {
      const items = [...new Set((sample as unknown[]).map((item) => JSON.stringify(inferSchema(item))))]
        .map((text) => JSON.parse(text) as Schema)
        .reduce<Schema | undefined>((merged, schema) => (merged === undefined ? schema : mergeSchemas(merged, schema)), undefined);
      return { type: 'array', ...(items === undefined ? {} : { items }) };
    }
    case 'object': {
      const entries = Object.entries(sample as Record<string, unknown>);
      const properties: Record<string, Schema> = {};
      for (const [key, value] of entries) properties[key] = inferSchema(value);
      return { type: 'object', properties, required: entries.map(([key]) => key) };
    }
  }
}

function mergeSchemas(a: Schema, b: Schema): Schema {
  if (a['type'] === 'object' && b['type'] === 'object') {
    const aProperties = (a['properties'] ?? {}) as Record<string, Schema>;
    const bProperties = (b['properties'] ?? {}) as Record<string, Schema>;
    const properties: Record<string, Schema> = { ...aProperties };

    for (const [key, schema] of Object.entries(bProperties)) {
      properties[key] = properties[key] === undefined ? schema : mergeSchemas(properties[key]!, schema);
    }

    const aRequired = new Set(Array.isArray(a['required']) ? (a['required'] as string[]) : []);
    const required = (Array.isArray(b['required']) ? (b['required'] as string[]) : []).filter((key) => aRequired.has(key));
    return { type: 'object', properties, ...(required.length === 0 ? {} : { required }) };
  }

  if (a['type'] === 'array' && b['type'] === 'array') {
    const aItems = identity(a['items']);
    const bItems = identity(b['items']);
    if (aItems === undefined) return b;
    if (bItems === undefined) return a;
    return { type: 'array', items: mergeSchemas(aItems, bItems) };
  }

  return a['type'] === b['type'] ? a : {};
}

function queryTemplate(search: URLSearchParams, issues: LearnIssue[]): Record<string, string> | undefined {
  const query: Record<string, string> = {};

  for (const [key, value] of search) {
    if (value === '') continue;
    if (/[{}]/.test(value)) {
      issues.push({
        path: 'request.query',
        message: `query value for '${key}' contains braces; dropped so it cannot be read as a placeholder`,
        severity: 'warning',
      });
      continue;
    }
    query[key] = value;
  }

  return Object.keys(query).length === 0 ? undefined : query;
}

export async function learnFromSample(options: LearnOptions): Promise<Result<LearnReport, LearnError>> {
  let url: URL;
  try {
    url = new URL(options.url);
  } catch {
    return err({ code: 'invalid_url', message: `not an absolute URL: ${options.url}` });
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return err({ code: 'invalid_url', message: `only http(s) URLs can be sampled; got ${url.protocol}` });
  }

  const resource = resourceIdForPath(url.pathname) ?? 'sample';
  const issues: LearnIssue[] = [];

  const query = queryTemplate(url.searchParams, issues);
  if (query !== undefined) {
    issues.push({
      path: 'request.query',
      message: 'the sample URL\'s query string was kept literally; declare inputs and use {placeholders} to parameterise it',
      severity: 'warning',
    });
  }

  // The final id depends on the shape, so the probe runs under a stable name.
  const probe: Operation = {
    id: 'learn.sample',
    resource: 'sample',
    title: 'Sample',
    request: {
      method: 'GET',
      path: url.pathname,
      ...(query === undefined ? {} : { query }),
    },
    ...(options.secret === undefined ? {} : { secret: options.secret }),
  };

  const executed = await executeOperation(probe, {}, {
    baseUrl: url.origin,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.secrets === undefined ? {} : { secrets: options.secrets }),
    ...(options.bindings === undefined ? {} : { bindings: options.bindings }),
    ...(options.policy === undefined ? {} : { policy: options.policy }),
    ...(options.audit === undefined ? {} : { audit: options.audit }),
    ...(options.lookup === undefined ? {} : { lookup: options.lookup }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  if (!executed.ok) return err(executed.error);

  const handle = await options.store.put(executed.value.payload, {
    operation: probe.id,
    view: null,
    url: executed.value.url,
    host: executed.value.host,
    status: executed.value.status,
    kind: 'response',
  });

  const schema = inferSchema(executed.value.payload);
  const array = findArrayPath(schema, identity);
  const record = array?.item ?? (schema['type'] === 'object' ? schema : undefined);
  const action = array === undefined ? 'get' : 'list';
  const id = slugify(options.id ?? resource);

  const fields = record === undefined ? [] : Object.keys((record['properties'] ?? {}) as Record<string, unknown>);
  const key = record === undefined ? undefined : keyField(record, resource, identity);

  const operationId = `${resource}.${action}`;
  const operation: Operation = {
    ...probe,
    id: operationId,
    resource,
    title: options.title ?? `${capitalise(action)} ${capitalise(resource)}`,
    description: `Learned from one ${executed.value.status} response at ${url.origin}${url.pathname}${url.search}.`,
    provenance: 'learned',
    view: draftView(schema, identity),
  };

  const resources: Resource[] = [{ id: resource, title: capitalise(resource), ...(key === undefined ? {} : { key }) }];

  const map: MapDocument = {
    schemaVersion: MAP_SCHEMA_VERSION,
    id,
    title: options.title ?? `${capitalise(resource)} — learned`,
    baseUrl: url.origin,
    description: `Learned from a live sample of ${url.origin}${url.pathname}. One sample cannot show optional fields or empty collections.`,
    provenance: { source: 'learned', date: options.today ?? new Date().toISOString().slice(0, 10) },
    resources,
    operations: [operation],
  };

  issues.push({
    path: 'view',
    message: 'the view is inferred from one sample; fields that were absent are not columns',
    severity: 'warning',
  });
  if (array !== undefined && array.at !== '/') {
    issues.push({
      path: 'view.select',
      message: `records were found at ${array.at}; confirm that this is the collection you meant`,
      severity: 'warning',
    });
  }

  const validated = validateMap(map);
  for (const issue of validated.issues) {
    issues.push({ path: issue.path, message: issue.message, severity: issue.severity });
  }

  return ok({
    map: validated.map ?? map,
    issues,
    handle: handle.handle,
    sample: {
      status: executed.value.status,
      bytes: executed.value.bytes,
      items: numberOfItems(executed.value.payload),
      fields,
    },
  });
}

function numberOfItems(payload: unknown): number | null {
  if (Array.isArray(payload)) return payload.length;
  if (payload === null || typeof payload !== 'object') return null;

  for (const value of Object.values(payload as Record<string, unknown>)) {
    if (Array.isArray(value)) return value.length;
  }
  return null;
}
