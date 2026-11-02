// Building a request from an operation, its inputs and a secret binding.
//
// Pure: no network, no clock. Everything here can be tested by inspection, and
// `run --dry-run` is just this module printed out. Request headers are returned
// once and then kept local — they are never written to a payload, a log or a
// result.

import type { Result } from '../view/result.ts';
import { err, ok } from '../view/result.ts';
import type { InputProperty, Operation } from '../map/types.ts';
import { checkSecretHost } from './secrets.ts';
import type { SecretBinding } from './secrets.ts';
import type { PolicyCode } from './policy.ts';

export type RuntimeErrorCode =
  | 'missing_argument'
  | 'unknown_argument'
  | 'invalid_argument'
  | 'unknown_operation'
  | 'unknown_view'
  | 'secret_unbound'
  | 'secret_missing'
  | 'too_many_redirects'
  | 'timeout'
  | 'response_too_large'
  | 'http_error'
  | 'bad_response'
  | 'network'
  /** The operation changes data and the workspace's writes mode needs a confirmation. */
  | 'write_not_confirmed'
  /** The workspace is read-only for writes (`writes.mode: deny`). */
  | 'write_denied'
  /** A write failed after the request may already have reached the server. */
  | 'outcome_unknown'
  /** A cursor is malformed, expired, or belongs to another operation. */
  | 'cursor_invalid'
  | 'unknown_cursor'
  | 'cursor_mismatch'
  | PolicyCode;

export type RuntimeError = {
  readonly code: RuntimeErrorCode;
  readonly message: string;
  readonly hint?: string;
  readonly status?: number;
};

export function runtimeError(
  code: RuntimeErrorCode,
  message: string,
  extra: { hint?: string | undefined; status?: number | undefined } = {},
): RuntimeError {
  return {
    code,
    message,
    ...(extra.hint === undefined ? {} : { hint: extra.hint }),
    ...(extra.status === undefined ? {} : { status: extra.status }),
  };
}

const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

function invalid(name: string, expected: string, got: unknown): Result<never, RuntimeError> {
  return err(
    runtimeError('invalid_argument', `argument '${name}' must be ${expected}`, {
      hint: `got ${JSON.stringify(got)}`,
    }),
  );
}

function coerceOne(name: string, property: InputProperty, value: unknown): Result<unknown, RuntimeError> {
  const asString = typeof value === 'string' ? value.trim() : value;

  switch (property.type) {
    case 'string':
      return typeof asString === 'string' ? ok(asString) : invalid(name, 'a string', value);

    case 'integer': {
      const number = typeof asString === 'string' ? Number(asString) : asString;
      if (typeof number !== 'number' || !Number.isInteger(number)) return invalid(name, 'an integer', value);
      return ok(number);
    }

    case 'number': {
      const number = typeof asString === 'string' ? Number(asString) : asString;
      if (typeof number !== 'number' || !Number.isFinite(number)) return invalid(name, 'a number', value);
      return ok(number);
    }

    case 'boolean':
      if (asString === true || asString === 'true') return ok(true);
      if (asString === false || asString === 'false') return ok(false);
      return invalid(name, 'a boolean', value);
  }
}

/**
 * Validate and coerce the call's arguments against the declared input contract.
 * Unknown arguments are an error, not a shrug: a typo that is silently ignored
 * costs a whole round trip and hides the bug.
 */
export function coerceArgs(operation: Operation, raw: Readonly<Record<string, unknown>>): Result<Record<string, unknown>, RuntimeError> {
  const properties = operation.input?.properties ?? {};
  const required = new Set(operation.input?.required ?? []);
  const declared = Object.keys(properties);
  const coerced: Record<string, unknown> = {};

  for (const name of Object.keys(raw)) {
    if (!Object.hasOwn(properties, name)) {
      return err(
        runtimeError('unknown_argument', `'${name}' is not an argument of ${operation.id}`, {
          hint: declared.length > 0 ? `arguments: ${declared.join(', ')}` : 'this operation takes no arguments',
        }),
      );
    }
  }

  for (const [name, property] of Object.entries(properties)) {
    const provided = raw[name];

    if (provided === undefined || provided === null) {
      if (property.default !== undefined) {
        coerced[name] = property.default;
        continue;
      }
      if (required.has(name)) return err(runtimeError('missing_argument', `missing required argument '${name}'`, { hint: describe(operation) }));
      coerced[name] = undefined;
      continue;
    }

    const value = coerceOne(name, property, provided);
    if (!value.ok) return err(value.error);

    const final = value.value;

    if (property.enum !== undefined && !property.enum.includes(final as string | number | boolean)) {
      return err(
        runtimeError('invalid_argument', `argument '${name}' must be one of ${property.enum.map((v) => JSON.stringify(v)).join(', ')}`, {
          hint: `got ${JSON.stringify(final)}`,
        }),
      );
    }
    if (typeof final === 'number') {
      if (property.minimum !== undefined && final < property.minimum) return invalid(name, `>= ${property.minimum}`, final);
      if (property.maximum !== undefined && final > property.maximum) return invalid(name, `<= ${property.maximum}`, final);
    }

    coerced[name] = final;
  }

  return ok(coerced);
}

function describe(operation: Operation): string {
  const required = operation.input?.required ?? [];
  const properties = operation.input?.properties ?? {};
  const parts = Object.entries(properties).map(([name, property]) => {
    const bits = [`${name}: ${property.type}`];
    if (required.includes(name)) bits.push('required');
    if (property.enum) bits.push(`one of ${property.enum.join('|')}`);
    if (property.default !== undefined) bits.push(`default ${JSON.stringify(property.default)}`);
    return bits.join(' ');
  });
  return parts.length > 0 ? parts.join('; ') : 'this operation takes no arguments';
}

function fillString(template: string, args: Readonly<Record<string, unknown>>, encode: (value: string) => string): string {
  return template.replace(PLACEHOLDER, (match, name: string) => {
    const value = args[name];
    return value === undefined ? match : encode(String(value));
  });
}

const UNFILLED = /\{[A-Za-z_][A-Za-z0-9_]*\}/;
const SOLE_PLACEHOLDER = /^\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

/** Whether a filled value still contains a placeholder the args did not supply. */
function unfilled(value: unknown): boolean {
  if (typeof value === 'string') return UNFILLED.test(value);
  if (Array.isArray(value)) return value.some(unfilled);
  if (value !== null && typeof value === 'object') return Object.values(value).some(unfilled);
  return false;
}

/**
 * Fill a body template.
 *
 * An object key whose value still holds an unfilled placeholder is **omitted**,
 * not sent literally: `{"title":"{title}"}` submits a form field containing
 * braces, which is worse than omitting it. This is also what makes an optional
 * body field — and therefore a real PATCH — expressible. Path and query
 * templates stay strict, because a missing path argument is already an error.
 */
function fillValue(value: unknown, args: Readonly<Record<string, unknown>>): unknown {
  if (typeof value === 'string') {
    // A template that is exactly one placeholder keeps the argument's JSON
    // type, so a boolean body field is `true` and not the string "true".
    const sole = SOLE_PLACEHOLDER.exec(value);
    if (sole !== null) {
      const raw = args[sole[1]!];
      return raw === undefined ? value : raw;
    }
    return fillString(value, args, (text) => text);
  }
  if (Array.isArray(value)) return value.map((item) => fillValue(item, args));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const filled = fillValue(item, args);
      if (unfilled(filled)) continue;
      out[key] = filled;
    }
    return out;
  }
  return value;
}

export type PreparedRequest = {
  readonly url: URL;
  readonly method: string;
  /** Included only in memory: never logged, stored or rendered. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  /** For a dry run: the binding that supplied the credential, never its value. */
  readonly secret?: { readonly name: string; readonly host: string; readonly header: string };
};

export type SecretInjection = {
  readonly name: string;
  readonly binding: SecretBinding;
  readonly value: string;
};

/** Build a request, attaching a secret only to the host its binding names. */
export function prepareRequest(
  baseUrl: string,
  operation: Operation,
  args: Readonly<Record<string, unknown>>,
  secret?: SecretInjection,
): Result<PreparedRequest, RuntimeError> {
  // Coerce here as well as in the callers: this is a public entry point, and a
  // template filled from uncoerced args would silently send '{default}'.
  const coerced = coerceArgs(operation, args);
  if (!coerced.ok) return err(coerced.error);
  const values = coerced.value;

  const base = baseUrl.replace(/\/+$/, '');
  const path = fillString(operation.request.path, values, encodeURIComponent);

  const unbound = [...path.matchAll(PLACEHOLDER)].map((match) => match[1]!);
  if (unbound.length > 0) {
    return err(runtimeError('missing_argument', `missing required argument${unbound.length === 1 ? '' : 's'} ${unbound.join(', ')}`, { hint: describe(operation) }));
  }

  let url: URL;
  try {
    url = new URL(`${base}${path}`);
  } catch {
    return err(runtimeError('invalid_argument', `cannot build a URL from ${base}${path}`));
  }

  for (const [key, template] of Object.entries(operation.request.query ?? {})) {
    const filled = fillString(template, values, (text) => text);
    // An optional argument that was not supplied omits the parameter rather
    // than sending an empty or literal placeholder.
    if (filled === '' || /\{[A-Za-z_][A-Za-z0-9_]*\}/.test(filled)) continue;
    url.searchParams.set(key, filled);
  }

  if (secret !== undefined) {
    const allowed = checkSecretHost(secret.name, secret.binding, url.hostname.toLowerCase());
    if (!allowed.ok) return err(runtimeError('secret_unbound', allowed.error.message, { hint: allowed.error.hint }));
  }

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(operation.request.headers ?? {})) {
    headers[name.toLowerCase()] = fillString(value, values, (text) => text);
  }

  if (secret !== undefined) {
    headers[secret.binding.header] = secret.binding.format.replace('{value}', secret.value);
  }

  const body = operation.request.body === undefined ? undefined : JSON.stringify(fillValue(operation.request.body, values));

  // A JSON body without a content type is rejected by strict APIs, and every
  // body this system can build is JSON. A map may still declare its own header.
  if (body !== undefined && headers['content-type'] === undefined) headers['content-type'] = 'application/json';

  return ok({
    url,
    method: operation.request.method,
    headers,
    ...(body === undefined ? {} : { body }),
    ...(secret === undefined ? {} : { secret: { name: secret.name, host: secret.binding.host, header: secret.binding.header } }),
  });
}
