// The executor.
//
// One operation, one request, one JSON value. Everything external is injected:
// `fetch`, the resolver, the clock, the audit sink. The core therefore makes no
// network call it was not handed and records nothing it was not given.
//
// Two invariants are enforced here rather than documented:
//   - a credential is attached only to the host its binding names, and is
//     dropped the moment a redirect changes origin;
//   - request headers never reach the audit sink, the result or a log.

import { createHash } from 'node:crypto';

import type { Operation } from '../map/types.ts';
import { isMutating } from '../map/types.ts';
import type { Result } from '../view/result.ts';
import { err, ok } from '../view/result.ts';
import { checkResolvedHost, checkUrl, normalisePolicy, resolveRedirect, sameOrigin } from './policy.ts';
import type { Lookup, OutboundPolicy } from './policy.ts';
import { coerceArgs, prepareRequest, runtimeError } from './request.ts';
import type { PreparedRequest, RuntimeError } from './request.ts';
import type { BindingTable, SecretProvider } from './secrets.ts';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type AuditEvent = {
  readonly operation: string;
  readonly method: string;
  readonly host: string;
  readonly status: number;
  readonly bytes: number;
  readonly durationMs: number;
  readonly redirects: number;
  /** Origin and path only: a query value may be sensitive too. */
  readonly url: string;
  /**
   * SHA-256 of the request body, when there was one. A write is recorded by
   * hash, never by content: a body may carry personal data, and the audit sink
   * is not a place to keep it.
   */
  readonly bodySha256?: string;
  readonly bodyBytes?: number;
  /** Whether this event was a write, so an audit reader need not consult the map. */
  readonly mutating?: boolean;
};

export type AuditSink = {
  record(event: AuditEvent): void | Promise<void>;
};

export type ExecuteOptions = {
  readonly baseUrl: string;
  readonly fetch?: FetchLike;
  readonly policy?: Partial<OutboundPolicy>;
  readonly secrets?: SecretProvider;
  readonly bindings?: BindingTable;
  readonly audit?: AuditSink;
  readonly lookup?: Lookup;
  readonly now?: () => number;
};

export type ExecutedResponse = {
  readonly payload: unknown;
  readonly status: number;
  /** Origin and path only: safe to print. */
  readonly url: string;
  /** The URL that actually answered, query included. Internal: never printed. */
  readonly requestUrl: string;
  readonly host: string;
  readonly bytes: number;
  readonly redirects: readonly string[];
  /** The next page a Link header advertised, already absolute. */
  readonly nextUrl?: string;
};

type SecretInjection = { name: string; binding: NonNullable<BindingTable[string]>; value: string };

async function resolveSecret(
  operation: Operation,
  hostname: string,
  options: ExecuteOptions,
): Promise<Result<SecretInjection | undefined, RuntimeError>> {
  if (operation.secret === undefined) return ok(undefined);

  const name = operation.secret;
  const binding = options.bindings?.[name];
  if (binding === undefined) {
    return err(
      runtimeError('secret_unbound', `${operation.id} needs secret '${name}' but no binding names it`, {
        hint: 'a human binds a secret to a host in the bindings file; a map only names it',
      }),
    );
  }

  if (binding.host !== hostname.toLowerCase()) {
    return err(
      runtimeError('secret_unbound', `secret ${name} is bound to ${binding.host} and cannot be sent to ${hostname}`, {
        hint: 'binding is a human action; edit the bindings file deliberately',
      }),
    );
  }

  const value = await options.secrets?.get(name, hostname.toLowerCase());
  if (value === undefined || value === '') {
    return err(
      runtimeError('secret_missing', `secret '${name}' is bound to ${binding.host} but no provider has a value`, {
        hint: `set ${name} in the environment, or supply a provider`,
      }),
    );
  }

  return ok({ name, binding, value });
}

async function readBody(response: Response, maxBytes: number): Promise<Result<{ text: string; bytes: number }, RuntimeError>> {
  const text = await response.text();
  const bytes = new TextEncoder().encode(text).length;

  if (bytes > maxBytes) {
    return err(
      runtimeError('response_too_large', `response is ${bytes} bytes, over the ${maxBytes} byte cap`, {
        hint: 'narrow the request, or raise maxBytes deliberately',
      }),
    );
  }

  return ok({ text, bytes });
}

function parseBody(text: string, contentType: string): Result<unknown, RuntimeError> {
  if (text.trim() === '') return ok(null);

  if (/json/i.test(contentType) || /^[\[{]/.test(text.trim())) {
    try {
      return ok(JSON.parse(text) as unknown);
    } catch {
      return err(runtimeError('bad_response', 'response claimed JSON but did not parse', { hint: text.slice(0, 120) }));
    }
  }

  return ok(text);
}

export async function executeOperation(
  operation: Operation,
  args: Readonly<Record<string, unknown>> = {},
  options: ExecuteOptions,
): Promise<Result<ExecutedResponse, RuntimeError>> {
  const policy = normalisePolicy(options.policy);
  const fetchImpl = options.fetch;
  if (fetchImpl === undefined) {
    return err(
      runtimeError('network', 'no fetch implementation was supplied', { hint: 'the host app passes one; the core never imports one' }),
    );
  }

  const coerced = coerceArgs(operation, args);
  if (!coerced.ok) return coerced;

  // Refuse the destination before touching a credential: a map must not be able
  // to make the runtime read a secret on the way to a blocked host.
  const destination = checkUrl(options.baseUrl, policy);
  if (!destination.ok) {
    return err(runtimeError(destination.error.code, destination.error.message, { hint: destination.error.hint }));
  }

  // The binding is checked against the map's own host, before any request is
  // built, so a map cannot point a secret at an arbitrary destination.
  let hostname: string;
  try {
    hostname = new URL(options.baseUrl).hostname;
  } catch {
    return err(runtimeError('invalid_argument', `${options.baseUrl} is not an absolute URL`));
  }

  const secret = await resolveSecret(operation, hostname, options);
  if (!secret.ok) return secret;

  const prepared = prepareRequest(options.baseUrl, operation, coerced.value, secret.value);
  if (!prepared.ok) return prepared;

  return sendPrepared(operation, prepared.value, options, policy, fetchImpl);
}

/** The `next` URL a Link header advertises, resolved against the request URL. */
export function nextFromLink(header: string | null, base: URL): string | undefined {
  if (header === null) return undefined;

  for (const part of header.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel\s*=\s*"?next"?/i.exec(part);
    const target = match?.[1];
    if (target === undefined) continue;
    try {
      return new URL(target, base).href;
    } catch {
      return undefined;
    }
  }

  return undefined;
}

async function sendPrepared(
  operation: Operation,
  prepared: PreparedRequest,
  options: ExecuteOptions,
  policy: OutboundPolicy,
  fetchImpl: FetchLike,
): Promise<Result<ExecutedResponse, RuntimeError>> {
  const started = (options.now ?? Date.now)();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), policy.timeoutMs);

  let url = prepared.url;
  let method = prepared.method;
  let requestBody = prepared.body;
  const headers: Record<string, string> = { ...prepared.headers };
  const authHeader = prepared.secret?.header;
  const redirects: string[] = [];
  let status = 0;
  let bytes = 0;

  const mutating = isMutating(operation);
  const bodySha256 = requestBody === undefined ? undefined : createHash('sha256').update(requestBody, 'utf8').digest('hex');
  const bodyBytes = requestBody === undefined ? undefined : new TextEncoder().encode(requestBody).length;

  const audit = async (finalStatus: number, finalBytes: number): Promise<void> => {
    if (options.audit === undefined) return;
    await options.audit.record({
      operation: operation.id,
      method,
      host: url.hostname.toLowerCase(),
      status: finalStatus,
      bytes: finalBytes,
      durationMs: (options.now ?? Date.now)() - started,
      redirects: redirects.length,
      url: `${url.origin}${url.pathname}`,
      ...(bodySha256 === undefined ? {} : { bodySha256 }),
      ...(bodyBytes === undefined ? {} : { bodyBytes }),
      ...(mutating ? { mutating: true } : {}),
    });
  };

  try {
    for (;;) {
      const checked = checkUrl(url.href, policy);
      if (!checked.ok) {
        await audit(0, 0);
        return err(runtimeError(checked.error.code, checked.error.message, { hint: checked.error.hint }));
      }

      const resolved = await checkResolvedHost(url, policy, options.lookup);
      if (!resolved.ok) {
        await audit(0, 0);
        return err(runtimeError(resolved.error.code, resolved.error.message, { hint: resolved.error.hint }));
      }

      let response: Response;
      try {
        response = await fetchImpl(url.href, {
          method,
          headers,
          ...(requestBody === undefined ? {} : { body: requestBody }),
          redirect: 'manual',
          signal: controller.signal,
        });
      } catch (error) {
        await audit(0, 0);
        if (controller.signal.aborted) {
          return err(
            mutating
              ? runtimeError('outcome_unknown', `${operation.id} timed out after ${policy.timeoutMs}ms before a response`, {
                  hint: 'the write may have been applied; read the resource before retrying',
                })
              : runtimeError('timeout', `${operation.id} timed out after ${policy.timeoutMs}ms`),
          );
        }
        return err(
          mutating
            ? runtimeError('outcome_unknown', `${operation.id} failed before a response: ${error instanceof Error ? error.message : String(error)}`, {
                hint: 'the write may have been applied; read the resource before retrying',
              })
            : runtimeError('network', `${operation.id} failed: ${error instanceof Error ? error.message : String(error)}`),
        );
      }

      status = response.status;

      if (status >= 300 && status < 400) {
        const location = response.headers.get('location');
        if (location !== null) {
          if (redirects.length >= policy.maxRedirects) {
            await audit(status, 0);
            return err(runtimeError('too_many_redirects', `more than ${policy.maxRedirects} redirects`, { status }));
          }

          const next = resolveRedirect(url, location);
          if (!next.ok) {
            await audit(status, 0);
            return err(runtimeError(next.error.code, next.error.message));
          }

          // Cross-origin: the credential does not travel with it.
          if (!sameOrigin(url, next.value) && authHeader !== undefined) {
            delete headers[authHeader];
          }

          // 303 means "retrieve that with GET", and 301/302 are treated the same
          // way for a non-GET. Replaying a POST body onto a redirected endpoint
          // is how one create becomes two.
          if (status === 303 || ((status === 301 || status === 302) && method !== 'GET' && method !== 'HEAD')) {
            if (method !== 'GET' && method !== 'HEAD') {
              method = 'GET';
              requestBody = undefined;
              delete headers['content-type'];
              delete headers['content-length'];
            }
          }

          redirects.push(next.value.href);
          url = next.value;
          continue;
        }
      }

      const nextUrl = operation.pagination?.kind === 'link-header' ? nextFromLink(response.headers.get('link'), url) : undefined;

      const answer = await readBody(response, policy.maxBytes);
      if (!answer.ok) {
        await audit(status, 0);
        return answer;
      }

      bytes = answer.value.bytes;
      const payload = parseBody(answer.value.text, response.headers.get('content-type') ?? '');
      await audit(status, bytes);
      if (!payload.ok) return payload;

      if (status >= 400) {
        // A 5xx on a write may have committed before the server gave up.
        const code = mutating && status >= 500 ? 'outcome_unknown' : 'http_error';
        return err(
          runtimeError(code, `${operation.id} returned ${status}`, {
            status,
            hint:
              code === 'outcome_unknown'
                ? 'the write may have been applied; read the resource before retrying'
                : typeof payload.value === 'string'
                  ? payload.value.slice(0, 160)
                  : JSON.stringify(payload.value).slice(0, 160),
          }),
        );
      }

      return ok({
        payload: payload.value,
        status,
        url: `${url.origin}${url.pathname}`,
        requestUrl: url.href,
        host: url.hostname.toLowerCase(),
        bytes,
        redirects,
        ...(nextUrl === undefined ? {} : { nextUrl }),
      });
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch a page a cursor names.
 *
 * Nothing from the original request is trusted except the operation itself: the
 * URL is checked against the outbound policy again, the credential is re-bound
 * against the cursor URL's host, and only literal headers are replayed. A
 * header templated from an argument needs arguments this call does not have, so
 * it is left out rather than sent as `{value}`.
 */
export async function executeCursor(
  operation: Operation,
  url: string,
  options: ExecuteOptions,
): Promise<Result<ExecutedResponse, RuntimeError>> {
  const policy = normalisePolicy(options.policy);
  const fetchImpl = options.fetch;
  if (fetchImpl === undefined) {
    return err(
      runtimeError('network', 'no fetch implementation was supplied', { hint: 'the host app passes one; the core never imports one' }),
    );
  }

  if (isMutating(operation)) {
    return err(runtimeError('cursor_invalid', `${operation.id} changes data; a cursor only continues a read`));
  }

  const destination = checkUrl(url, policy);
  if (!destination.ok) {
    return err(runtimeError(destination.error.code, destination.error.message, { hint: destination.error.hint }));
  }

  const target = destination.value;
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(operation.request.headers ?? {})) {
    if (/\{[A-Za-z_][A-Za-z0-9_]*\}/.test(value)) continue;
    headers[name.toLowerCase()] = value;
  }

  const secret = await resolveSecret(operation, target.hostname, options);
  if (!secret.ok) return secret;

  if (secret.value !== undefined) {
    headers[secret.value.binding.header] = secret.value.binding.format.replace('{value}', secret.value.value);
  }

  const prepared: PreparedRequest = {
    url: target,
    method: 'GET',
    headers,
    ...(secret.value === undefined
      ? {}
      : { secret: { name: secret.value.name, host: secret.value.binding.host, header: secret.value.binding.header } }),
  };

  return sendPrepared(operation, prepared, options, policy, fetchImpl);
}
