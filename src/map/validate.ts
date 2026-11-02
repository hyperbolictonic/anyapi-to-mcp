// Map validation.
//
// Validation exists to catch the failures that cost an agent a whole call:
// a dangling resource reference, a placeholder with no declared input, a view
// that cannot resolve, and above all a credential pasted into a header.
//
// Unknown keys are ignored rather than rejected: a map written by a newer
// version must still load.

import { parseAddress } from '../view/address.ts';
import { normaliseMode } from '../view/detect.ts';
import { isPlainObject } from '../view/types.ts';
import type { MapDocument, MapIssue } from './types.ts';
import { MAP_SCHEMA_VERSION } from './types.ts';

const SLUG = /^[a-z0-9][a-z0-9._-]*$/i;
const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
const PROPERTY_TYPES = new Set(['string', 'integer', 'number', 'boolean']);
const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Headers a map may never set literally; they are credentials. */
const CREDENTIAL_HEADERS = new Set(['authorization', 'proxy-authorization', 'x-api-key', 'api-key', 'cookie']);

/** A value that looks like a real token, even under an innocent header name. */
const TOKEN_SHAPED = /^(?:bearer|token|basic)\s+\S{12,}$|^[A-Za-z0-9_-]{32,}$|^gh[pousr]_[A-Za-z0-9]{20,}$/;

class Reporter {
  readonly issues: MapIssue[] = [];

  error(path: string, message: string): void {
    this.issues.push({ path, message, severity: 'error' });
  }

  warn(path: string, message: string): void {
    this.issues.push({ path, message, severity: 'warning' });
  }

  get hasErrors(): boolean {
    return this.issues.some((issue) => issue.severity === 'error');
  }
}

function readString(value: unknown, path: string, report: Reporter): string | null {
  if (typeof value !== 'string' || value.trim() === '') {
    report.error(path, 'must be a non-empty string');
    return null;
  }
  return value;
}

function readArray(value: unknown, path: string, report: Reporter): readonly unknown[] {
  if (!Array.isArray(value)) {
    report.error(path, 'must be an array');
    return [];
  }
  return value;
}

function collectPlaceholders(template: string): string[] {
  return [...template.matchAll(PLACEHOLDER)].map((match) => match[1]!);
}

function checkView(value: unknown, path: string, report: Reporter): void {
  if (!isPlainObject(value)) {
    report.error(path, 'must be an object');
    return;
  }

  if (value['select'] !== undefined) {
    const parsed = parseAddress(String(value['select']));
    if (!parsed.ok) report.error(`${path}.select`, parsed.error.message);
  }

  if (value['mode'] !== undefined && normaliseMode(String(value['mode'])) === null) {
    report.error(`${path}.mode`, `unknown mode '${String(value['mode'])}'`);
  }

  if (value['style'] !== undefined && value['style'] !== 'outline' && value['style'] !== 'headings') {
    report.error(`${path}.style`, "must be 'outline' or 'headings'");
  }

  if (value['fields'] !== undefined) {
    const fields = readArray(value['fields'], `${path}.fields`, report);
    fields.forEach((field, index) => {
      if (typeof field !== 'string' || field.trim() === '') report.error(`${path}.fields[${index}]`, 'must be a dotted field path');
    });
  }
}

function checkHeaders(headers: unknown, path: string, report: Reporter): void {
  if (headers === undefined) return;
  if (!isPlainObject(headers)) {
    report.error(path, 'must be an object');
    return;
  }

  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    const text = typeof value === 'string' ? value : '';
    const headerPath = `${path}.${name}`;

    if (CREDENTIAL_HEADERS.has(lower)) {
      report.error(headerPath, 'a credential header belongs in a secret binding, not in a map');
      continue;
    }
    if (lower === 'host' || lower === 'content-length') {
      report.error(headerPath, `'${name}' is set by the runtime`);
      continue;
    }
    if (TOKEN_SHAPED.test(text.trim())) {
      report.error(headerPath, 'value looks like a credential; use a secret binding');
      continue;
    }
    if (text.includes('\n') || text.includes('\r')) {
      report.error(headerPath, 'header values must not contain newlines');
    }
  }
}

function checkInput(operation: unknown, path: string, report: Reporter): string[] {
  const placeholders: string[] = [];
  if (!isPlainObject(operation)) return placeholders;

  const request = operation['request'];
  if (!isPlainObject(request)) {
    report.error(`${path}.request`, 'must be an object');
    return placeholders;
  }

  const method = request['method'];
  if (typeof method !== 'string' || !METHODS.has(method.toUpperCase())) {
    report.error(`${path}.request.method`, `must be one of ${[...METHODS].join(', ')}`);
  }

  const requestPath = request['path'];
  if (typeof requestPath !== 'string' || !requestPath.startsWith('/')) {
    report.error(`${path}.request.path`, "must start with '/'");
  } else {
    placeholders.push(...collectPlaceholders(requestPath));
  }

  const query = request['query'];
  if (query !== undefined) {
    if (!isPlainObject(query)) {
      report.error(`${path}.request.query`, 'must be an object');
    } else {
      for (const [key, value] of Object.entries(query)) {
        if (typeof value !== 'string') report.error(`${path}.request.query.${key}`, 'must be a string template');
        else placeholders.push(...collectPlaceholders(value));
      }
    }
  }

  checkHeaders(request['headers'], `${path}.request.headers`, report);

  const input = operation['input'];
  const declared = new Set<string>();

  if (input !== undefined) {
    if (!isPlainObject(input)) {
      report.error(`${path}.input`, 'must be an object');
    } else {
      const properties = input['properties'];
      if (properties !== undefined) {
        if (!isPlainObject(properties)) {
          report.error(`${path}.input.properties`, 'must be an object');
        } else {
          for (const [name, property] of Object.entries(properties)) {
            const propertyPath = `${path}.input.properties.${name}`;
            declared.add(name);

            if (!isPlainObject(property)) {
              report.error(propertyPath, 'must be an object');
              continue;
            }

            const type = property['type'];
            if (typeof type !== 'string' || !PROPERTY_TYPES.has(type)) {
              report.error(`${propertyPath}.type`, `must be one of ${[...PROPERTY_TYPES].join(', ')}`);
            }

            const allowed = property['enum'];
            if (allowed !== undefined) {
              if (!Array.isArray(allowed) || allowed.length === 0) {
                report.error(`${propertyPath}.enum`, 'must be a non-empty array');
              }
            }

            const fallback = property['default'];
            if (fallback !== undefined && allowed !== undefined && Array.isArray(allowed) && !allowed.includes(fallback)) {
              report.error(`${propertyPath}.default`, 'must be one of the declared enum values');
            }
          }
        }
      }

      const required = input['required'];
      if (required !== undefined) {
        if (!Array.isArray(required)) {
          report.error(`${path}.input.required`, 'must be an array');
        } else {
          required.forEach((name, index) => {
            if (typeof name !== 'string') report.error(`${path}.input.required[${index}]`, 'must be a string');
            else if (!declared.has(name)) report.error(`${path}.input.required[${index}]`, `'${name}' is not a declared property`);
          });
        }
      }
    }
  }

  for (const placeholder of new Set(placeholders)) {
    if (!declared.has(placeholder)) {
      report.error(`${path}.request`, `placeholder {${placeholder}} has no declared input property`);
    }
  }

  return placeholders;
}

function checkPagination(value: unknown, path: string, report: Reporter): void {
  if (value === undefined) return;
  if (!isPlainObject(value)) {
    report.error(path, 'must be an object');
    return;
  }

  const kind = value['kind'];
  if (kind === 'none' || kind === 'link-header') return;
  if (kind === 'offset') {
    for (const key of ['totalPath', 'skipPath', 'limitPath']) {
      if (typeof value[key] !== 'string' || value[key] === '') report.error(`${path}.${key}`, 'must be a non-empty string');
    }
    return;
  }
  report.error(`${path}.kind`, "must be 'none', 'link-header' or 'offset'");
}

/** Validate, and return a usable map only when there are no errors. */
export function validateMap(input: unknown): { map: MapDocument | null; issues: readonly MapIssue[] } {
  const report = new Reporter();

  if (!isPlainObject(input)) {
    report.error('$', 'a map must be a JSON object');
    return { map: null, issues: report.issues };
  }

  if (input['schemaVersion'] !== MAP_SCHEMA_VERSION) {
    report.error(
      '$.schemaVersion',
      `expected ${MAP_SCHEMA_VERSION}; version 1 is the legacy format and is projected on load, not validated as a map`,
    );
  }

  const id = readString(input['id'], '$.id', report);
  if (id !== null && !SLUG.test(id)) report.error('$.id', 'must be a slug of letters, digits, dot, dash or underscore');

  readString(input['title'], '$.title', report);

  const baseUrl = readString(input['baseUrl'], '$.baseUrl', report);
  if (baseUrl !== null) {
    if (!/^https?:\/\//i.test(baseUrl)) {
      report.error('$.baseUrl', 'must be an absolute http(s) URL');
    } else if (baseUrl.toLowerCase().startsWith('http://')) {
      report.warn('$.baseUrl', 'plain HTTP; the outbound policy refuses it unless the host is explicitly allow-listed');
    }
    if (baseUrl.endsWith('/')) report.warn('$.baseUrl', 'trailing slash makes path joining ambiguous');
  }

  const resources = input['resources'] === undefined ? [] : readArray(input['resources'], '$.resources', report);
  const resourceIds = new Set<string>();
  resources.forEach((resource, index) => {
    const path = `$.resources[${index}]`;
    if (!isPlainObject(resource)) {
      report.error(path, 'must be an object');
      return;
    }
    const resourceId = readString(resource['id'], `${path}.id`, report);
    readString(resource['title'], `${path}.title`, report);
    if (resourceId !== null) {
      if (!SLUG.test(resourceId)) report.error(`${path}.id`, 'must be a slug');
      if (resourceIds.has(resourceId)) report.error(`${path}.id`, `duplicate resource id '${resourceId}'`);
      resourceIds.add(resourceId);
    }
    if (resource['key'] !== undefined && typeof resource['key'] !== 'string') {
      report.error(`${path}.key`, 'must be a dotted field path');
    }
  });

  const operations = input['operations'] === undefined ? [] : readArray(input['operations'], '$.operations', report);
  const operationIds = new Set<string>();
  operations.forEach((operation, index) => {
    const path = `$.operations[${index}]`;
    if (!isPlainObject(operation)) {
      report.error(path, 'must be an object');
      return;
    }

    const operationId = readString(operation['id'], `${path}.id`, report);
    if (operationId !== null) {
      if (operationId.includes(' ')) report.error(`${path}.id`, 'must not contain spaces');
      if (operationIds.has(operationId)) report.error(`${path}.id`, `duplicate operation id '${operationId}'`);
      operationIds.add(operationId);
    }

    const resource = operation['resource'];
    if (typeof resource !== 'string' || !resourceIds.has(resource)) {
      report.error(`${path}.resource`, `'${String(resource)}' is not a declared resource`);
    }
    if (operation['returns'] !== undefined && (typeof operation['returns'] !== 'string' || !resourceIds.has(operation['returns']))) {
      report.error(`${path}.returns`, `'${String(operation['returns'])}' is not a declared resource`);
    }
    if (operation['secret'] !== undefined) {
      const secret = operation['secret'];
      if (typeof secret !== 'string' || !SECRET_NAME.test(secret)) {
        report.error(`${path}.secret`, 'must be a binding name such as GITHUB_TOKEN, never a value');
      }
    }

    readString(operation['title'], `${path}.title`, report);
    checkInput(operation, path, report);
    checkPagination(operation['pagination'], `${path}.pagination`, report);

    if (operation['view'] !== undefined) checkView(operation['view'], `${path}.view`, report);
    if (operation['views'] !== undefined) {
      if (!isPlainObject(operation['views'])) {
        report.error(`${path}.views`, 'must be an object of named views');
      } else {
        for (const [name, view] of Object.entries(operation['views'])) checkView(view, `${path}.views.${name}`, report);
      }
    }
  });

  const links = input['links'] === undefined ? [] : readArray(input['links'], '$.links', report);
  links.forEach((link, index) => {
    const path = `$.links[${index}]`;
    if (!isPlainObject(link)) {
      report.error(path, 'must be an object');
      return;
    }
    for (const key of ['from', 'to']) {
      const value = link[key];
      if (typeof value !== 'string' || !resourceIds.has(value)) report.error(`${path}.${key}`, `'${String(value)}' is not a declared resource`);
    }
    readString(link['field'], `${path}.field`, report);
    readString(link['argument'], `${path}.argument`, report);
    const operation = link['operation'];
    if (typeof operation !== 'string' || !operationIds.has(operation)) {
      report.error(`${path}.operation`, `'${String(operation)}' is not a declared operation`);
    }
  });

  // Default the collections so a split index (metadata only) is still a valid
  // base for fragments, and so a loader never has to guard for their absence.
  const normalised = {
    ...(input as Record<string, unknown>),
    resources,
    operations,
    links,
  } as unknown as MapDocument;

  return { map: report.hasErrors ? null : normalised, issues: report.issues };
}

/** The issues that must stop a load, separated from the ones that merely inform. */
export function splitIssues(issues: readonly MapIssue[]): { errors: MapIssue[]; warnings: MapIssue[] } {
  return {
    errors: issues.filter((issue) => issue.severity === 'error'),
    warnings: issues.filter((issue) => issue.severity === 'warning'),
  };
}
