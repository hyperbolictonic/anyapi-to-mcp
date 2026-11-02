// Legacy projection.
//
// `schemaVersion: 1` files are the earlier wrapper and recipe
// format. They are read through this projection and never rewritten in place:
// the user's files stay exactly as they were, and the projection is the only
// place that knows the old shape.
//
// The shape below was validated against real wrapper files:
// a wrapper is one request with an absolute `request.url`, `{{name}}` and
// `{{name|raw}}` placeholders, an optional JSON-Schema `inputSchema`, and a
// `response` recipe whose `fields` are a label -> path object. A wrapper may
// declare `mutating` explicitly (a login POST is not a write) and may name a
// secret with `request.auth`.
//
// The older `steps` shape has no known producer; it stays supported so a file
// written against the earlier projection keeps loading.

import { isPlainObject } from '../view/types.ts';
import type { ViewSpec } from '../view/types.ts';
import type { InputProperty, MapDocument, MapIssue, Operation, RequestTemplate, Resource } from './types.ts';
import { MAP_SCHEMA_VERSION } from './types.ts';

const STEP_PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_.-]*)\}/g;
/** `{{name}}` or `{{name|raw}}`; `raw` only affects URL encoding in the legacy executor. */
const WRAPPER_PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*(?:\|[A-Za-z]*)?\s*\}\}/g;

export function isLegacyDocument(input: unknown): boolean {
  return isPlainObject(input) && input['schemaVersion'] === 1;
}

function slugOf(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'legacy'
  );
}

function pointerOf(select: unknown): string | undefined {
  if (typeof select !== 'string' || select === '') return undefined;
  if (select === '$') return '/';
  if (select.startsWith('$.')) return `/${select.slice(2).replace(/\./g, '/')}`;
  if (select.startsWith('$')) return select.slice(1) || '/';
  return select;
}

/** Recipe `fields` are a label -> path object in the real format, an array in ours. */
function fieldPathOf(value: string): string {
  if (value === '$') return '';
  return value.startsWith('$.') ? value.slice(2) : value;
}

function fieldsOf(raw: unknown): readonly string[] | undefined {
  if (Array.isArray(raw)) {
    const fields = raw.filter((field): field is string => typeof field === 'string');
    return fields.length > 0 ? fields : undefined;
  }

  if (isPlainObject(raw)) {
    const fields: string[] = [];
    for (const value of Object.values(raw)) {
      if (typeof value === 'string') fields.push(fieldPathOf(value));
      else if (isPlainObject(value) && typeof value['path'] === 'string') fields.push(fieldPathOf(value['path']));
    }
    return fields.length > 0 ? fields : undefined;
  }

  return undefined;
}

function viewFrom(recipe: unknown): ViewSpec | undefined {
  if (!isPlainObject(recipe)) return undefined;
  const view: Record<string, unknown> = {};
  const select = pointerOf(recipe['select']);
  if (select !== undefined) view['select'] = select;
  if (typeof recipe['mode'] === 'string') view['mode'] = recipe['mode'];
  if (typeof recipe['style'] === 'string') view['style'] = recipe['style'];
  const fields = fieldsOf(recipe['fields']);
  if (fields !== undefined) view['fields'] = fields;
  if (typeof recipe['titleField'] === 'string') view['titleField'] = recipe['titleField'];
  return Object.keys(view).length > 0 ? (view as ViewSpec) : undefined;
}

function placeholdersIn(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  return [...value.matchAll(STEP_PLACEHOLDER)].map((match) => match[1]!);
}

/** `{{name}}` and `{{name|raw}}` become the `{name}` our request templates use. */
function normaliseTemplate(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(WRAPPER_PLACEHOLDER, '{$1}');
  if (Array.isArray(value)) return value.map(normaliseTemplate);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) out[key] = normaliseTemplate(entry);
    return out;
  }
  return value;
}

function deriveInput(path: string, query: Readonly<Record<string, string>>): Operation['input'] {
  const names = new Set<string>([...placeholdersIn(path), ...Object.values(query).flatMap(placeholdersIn)]);
  if (names.size === 0) return undefined;

  const properties: Record<string, InputProperty> = {};
  for (const name of names) properties[name] = { type: 'string' };

  return { required: [...names], properties };
}

function propertyFrom(raw: unknown): InputProperty | undefined {
  if (!isPlainObject(raw)) return undefined;

  const type =
    raw['type'] === 'integer' || raw['type'] === 'number' || raw['type'] === 'boolean' ? raw['type'] : 'string';

  const property: {
    type: InputProperty['type'];
    description?: string;
    enum?: readonly (string | number | boolean)[];
    default?: string | number | boolean;
    minimum?: number;
    maximum?: number;
  } = { type };

  if (typeof raw['description'] === 'string') property.description = raw['description'];
  if (Array.isArray(raw['enum'])) {
    const values = raw['enum'].filter(
      (value): value is string | number | boolean =>
        typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean',
    );
    if (values.length > 0) property.enum = values;
  }
  if (typeof raw['default'] === 'string' || typeof raw['default'] === 'number' || typeof raw['default'] === 'boolean') {
    property.default = raw['default'];
  }
  if (typeof raw['minimum'] === 'number') property.minimum = raw['minimum'];
  if (typeof raw['maximum'] === 'number') property.maximum = raw['maximum'];

  return property;
}

/**
 * The wrapper's own input schema wins; placeholders it does not declare are
 * still required, so a run cannot silently omit part of the URL.
 */
function inputFromSchema(schema: unknown, placeholders: ReadonlySet<string>): Operation['input'] {
  const properties: Record<string, InputProperty> = {};
  const required = new Set<string>();

  if (isPlainObject(schema)) {
    if (isPlainObject(schema['properties'])) {
      for (const [name, raw] of Object.entries(schema['properties'])) {
        const property = propertyFrom(raw);
        if (property !== undefined) properties[name] = property;
      }
    }
    if (Array.isArray(schema['required'])) {
      for (const name of schema['required']) if (typeof name === 'string') required.add(name);
    }
  }

  for (const name of placeholders) {
    if (properties[name] === undefined) properties[name] = { type: 'string' };
    required.add(name);
  }

  for (const name of required) {
    if (properties[name] === undefined) properties[name] = { type: 'string' };
  }

  if (Object.keys(properties).length === 0) return undefined;
  return {
    ...(required.size === 0 ? {} : { required: [...required] }),
    properties,
  };
}

type Target = { readonly baseUrl: string; readonly path: string; readonly query: Record<string, string> };

function splitAbsolute(raw: string): Target | null {
  const match = /^(https?):\/\/([^/?#]+)([^?#]*)(?:\?([^#]*))?/i.exec(raw);
  if (match === null) return null;

  const scheme = match[1]!.toLowerCase();
  const host = match[2]!;
  const path = match[3] === '' || match[3] === undefined ? '/' : match[3];
  const query: Record<string, string> = {};
  for (const pair of (match[4] ?? '').split('&')) {
    if (pair === '') continue;
    const eq = pair.indexOf('=');
    const key = eq === -1 ? pair : pair.slice(0, eq);
    const value = eq === -1 ? '' : pair.slice(eq + 1);
    try {
      query[decodeURIComponent(key)] = decodeURIComponent(value);
    } catch {
      query[key] = value;
    }
  }

  return { baseUrl: `${scheme}://${host}`, path, query };
}

function wrapperTarget(input: Record<string, unknown>, request: Record<string, unknown>): Target | null {
  const rawUrl = typeof request['url'] === 'string' ? request['url'] : undefined;
  if (rawUrl === undefined || rawUrl.trim() === '') return null;

  let target = splitAbsolute(rawUrl);
  if (target === null) {
    const base = input['baseUrl'] ?? input['base_url'];
    if (typeof base !== 'string') return null;
    const origin = splitAbsolute(base);
    if (origin === null) return null;

    const raw = rawUrl.startsWith('/') ? rawUrl : `/${rawUrl}`;
    const relative = splitAbsolute(`https://placeholder.invalid${raw}`);
    if (relative === null) return null;

    target = { baseUrl: base.replace(/\/+$/, ''), path: relative.path, query: relative.query };
  }

  const query = { ...target.query };
  if (isPlainObject(request['query'])) {
    for (const [key, value] of Object.entries(request['query'])) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') query[key] = String(value);
    }
  }

  return { ...target, query };
}

function headersOf(request: Record<string, unknown>): Record<string, string> {
  const headers: Record<string, string> = {};
  if (isPlainObject(request['headers'])) {
    for (const [key, value] of Object.entries(request['headers'])) {
      if (typeof value === 'string') headers[key] = normaliseTemplate(value) as string;
    }
  }
  return headers;
}

function collectWrapperPlaceholders(target: Target, body: unknown): Set<string> {
  const names = new Set<string>();
  const collect = (value: unknown): void => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(WRAPPER_PLACEHOLDER)) names.add(match[1]!);
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) collect(entry);
      return;
    }
    if (isPlainObject(value)) {
      for (const entry of Object.values(value)) collect(entry);
    }
  };

  collect(target.path);
  for (const value of Object.values(target.query)) collect(value);
  collect(body);
  return names;
}

/** Project the real wrapper shape (one absolute request). */
function projectWrapper(
  input: Record<string, unknown>,
  request: Record<string, unknown>,
  issues: MapIssue[],
): { map: MapDocument | null } {
  const target = wrapperTarget(input, request);
  if (target === null) {
    return { map: null };
  }

  const method = String(request['method'] ?? 'GET').toUpperCase() as RequestTemplate['method'];
  const headers = headersOf(request);
  const rawBody = request['body'];
  const body = rawBody === undefined ? undefined : normaliseTemplate(rawBody);
  const rawBodyFormat = request['bodyFormat'];

  if (rawBodyFormat === 'form') {
    issues.push({
      path: '$.request.bodyFormat',
      message: "the wrapper sends a form body; this projection sends JSON, so the body encoding would differ",
      severity: 'warning',
    });
  } else if (rawBodyFormat === 'text') {
    issues.push({
      path: '$.request.bodyFormat',
      message: "the wrapper sends a text body; the projected request labels the body as JSON",
      severity: 'warning',
    });
  }

  if (Array.isArray(request['methods']) && request['methods'].length > 1) {
    issues.push({
      path: '$.request.methods',
      message: `the wrapper accepts several methods; only ${method} is projected`,
      severity: 'warning',
    });
  }

  const placeholders = collectWrapperPlaceholders(target, rawBody);
  const path = normaliseTemplate(target.path) as string;
  const query: Record<string, string> = {};
  for (const [key, value] of Object.entries(target.query)) query[key] = normaliseTemplate(value) as string;
  const inputContract = inputFromSchema(input['inputSchema'], placeholders);

  const wrapperId = typeof input['id'] === 'string' && input['id'].trim() !== '' ? slugOf(input['id']) : 'legacy';
  const title =
    typeof input['name'] === 'string' && input['name'].trim() !== ''
      ? input['name']
      : typeof input['title'] === 'string'
        ? input['title']
        : wrapperId;

  const view = viewFrom(input['response'] ?? input['recipe']) ?? { select: '/', mode: 'auto' as const };
  const resource: Resource = { id: 'result', title };

  const mutating =
    typeof input['mutating'] === 'boolean' ? input['mutating'] : method !== 'GET' && method !== 'HEAD';

  const operation: Operation = {
    id: wrapperId,
    resource: resource.id,
    returns: resource.id,
    title,
    ...(typeof input['description'] === 'string' ? { description: input['description'] } : {}),
    mutating,
    provenance: 'human',
    request: {
      method,
      path,
      ...(Object.keys(query).length === 0 ? {} : { query }),
      ...(Object.keys(headers).length === 0 ? {} : { headers }),
      ...(body === undefined ? {} : { body }),
    },
    ...(inputContract === undefined ? {} : { input: inputContract }),
    ...(typeof request['auth'] === 'string' && request['auth'].trim() !== '' ? { secret: request['auth'] } : {}),
    view,
  };

  const map: MapDocument = {
    schemaVersion: MAP_SCHEMA_VERSION,
    id: wrapperId,
    title,
    baseUrl: target.baseUrl,
    ...(typeof input['description'] === 'string' ? { description: input['description'] } : {}),
    provenance: {
      source: 'human',
      ...(typeof input['lastVerified'] === 'string' ? { date: input['lastVerified'] } : {}),
    },
    resources: [resource],
    operations: [operation],
    links: [],
  };

  return { map };
}

/** Project the older `steps` shape: one request per step. */
function toRequest(step: Record<string, unknown>): RequestTemplate | null {
  const path = step['path'];
  if (typeof path !== 'string' || !path.startsWith('/')) return null;

  const method = String(step['method'] ?? step['verb'] ?? 'GET').toUpperCase() as RequestTemplate['method'];
  const query: Record<string, string> = {};
  const rawQuery = step['query'] ?? step['params'] ?? step['queryParams'];
  if (isPlainObject(rawQuery)) {
    for (const [key, value] of Object.entries(rawQuery)) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') query[key] = String(value);
    }
  }

  const headers: Record<string, string> = {};
  if (isPlainObject(step['headers'])) {
    for (const [key, value] of Object.entries(step['headers'])) if (typeof value === 'string') headers[key] = value;
  }

  return {
    method,
    path,
    ...(Object.keys(query).length > 0 ? { query } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(step['body'] === undefined ? {} : { body: step['body'] }),
  };
}

function projectSteps(input: Record<string, unknown>, fallbackId: string): { map: MapDocument | null; issues: readonly MapIssue[] } {
  const issues: MapIssue[] = [];

  const baseUrl = input['baseUrl'] ?? input['base_url'] ?? input['url'];
  if (typeof baseUrl !== 'string' || !/^https?:\/\//i.test(baseUrl)) {
    return {
      map: null,
      issues: [{ path: '$.baseUrl', message: 'legacy file has no absolute baseUrl; cannot project an operation', severity: 'error' }],
    };
  }

  const rawSteps = input['steps'] ?? input['requests'] ?? input['operations'];
  const steps: unknown[] = Array.isArray(rawSteps) ? rawSteps : [];
  if (steps.length === 0) {
    return {
      map: null,
      issues: [{ path: '$.steps', message: 'legacy file has no steps/request to project into an operation', severity: 'error' }],
    };
  }

  const rawId = input['id'] ?? input['name'] ?? input['slug'] ?? fallbackId;
  const mapId = slugOf(typeof rawId === 'string' ? rawId : fallbackId);
  const title = typeof input['title'] === 'string' ? input['title'] : typeof input['name'] === 'string' ? input['name'] : mapId;

  const view = viewFrom(input['recipe'] ?? input['view']) ?? { select: '/', mode: 'auto' as const };
  const resource: Resource = { id: 'result', title: 'Result' };

  const operations: Operation[] = [];
  steps.forEach((step, index) => {
    if (!isPlainObject(step)) {
      issues.push({ path: `$.steps[${index}]`, message: 'must be an object', severity: 'error' });
      return;
    }

    const request = toRequest(step);
    if (request === null) {
      issues.push({ path: `$.steps[${index}].path`, message: "must start with '/'", severity: 'error' });
      return;
    }

    const name = typeof step['name'] === 'string' ? slugOf(step['name']) : String(index + 1);
    const input = deriveInput(request.path, request.query ?? {});
    const stepView = viewFrom(step['recipe'] ?? step['view']) ?? view;

    operations.push({
      id: `${mapId}.${name}`,
      resource: resource.id,
      returns: resource.id,
      title: typeof step['title'] === 'string' ? step['title'] : typeof step['name'] === 'string' ? step['name'] : `${mapId} step ${index + 1}`,
      ...(typeof step['description'] === 'string' ? { description: step['description'] } : {}),
      mutating: request.method !== 'GET' && request.method !== 'HEAD',
      provenance: 'human',
      request,
      ...(input === undefined ? {} : { input }),
      view: stepView,
    });
  });

  if (operations.length === 0) return { map: null, issues };

  const map: MapDocument = {
    schemaVersion: MAP_SCHEMA_VERSION,
    id: mapId,
    title,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    ...(typeof input['description'] === 'string' ? { description: input['description'] } : {}),
    provenance: { source: 'human', ...(typeof input['updatedAt'] === 'string' ? { date: input['updatedAt'] } : {}) },
    resources: [resource],
    operations,
    links: [],
  };

  return { map, issues };
}

/** Project one legacy file: a real wrapper, or the older `steps` shape. */
export function projectLegacy(input: unknown, fallbackId = 'legacy'): { map: MapDocument | null; issues: readonly MapIssue[] } {
  if (!isPlainObject(input)) {
    return { map: null, issues: [{ path: '$', message: 'legacy file must be a JSON object', severity: 'error' }] };
  }

  const request = input['request'];
  if (isPlainObject(request) && typeof request['url'] === 'string') {
    const issues: MapIssue[] = [];
    const projected = projectWrapper(input, request, issues);
    if (projected.map === null) {
      issues.push({
        path: '$.request.url',
        message: 'the wrapper URL is neither absolute nor relative to an absolute baseUrl',
        severity: 'error',
      });
    }
    return { map: projected.map, issues };
  }

  return projectSteps(input, fallbackId);
}

/** Project an array of legacy wrappers. Each becomes its own map. */
export function projectLegacyList(input: readonly unknown[]): { maps: MapDocument[]; issues: readonly MapIssue[] } {
  const maps: MapDocument[] = [];
  const issues: MapIssue[] = [];

  input.forEach((item, index) => {
    const projected = projectLegacy(item, `legacy-${index + 1}`);
    if (projected.map) maps.push(projected.map);
    for (const issue of projected.issues) issues.push({ ...issue, path: `$[${index}]${issue.path.slice(1)}` });
  });

  return { maps, issues };
}
