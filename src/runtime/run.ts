// Orchestration: map + operation + arguments -> a stored handle and an envelope.
//
// This is the seam the CLI and the MCP server sit on. It is deliberately thin:
// the view layer decides presentation, the executor decides transport, and this
// file only joins them and puts the payload in the store.
//
// A dry run is the same path without the request: argument validation, URL
// building and binding checks all happen, so `--dry-run` proves the map is
// runnable without touching the network.

import { findOperationIn, isMutating } from '../map/types.ts';
import type { MapDocument, Operation } from '../map/types.ts';
import type { Envelope, Limits, ViewSpec } from '../view/types.ts';
import type { Result } from '../view/result.ts';
import { err, ok } from '../view/result.ts';
import { readAt, renderView } from '../view/view.ts';
import { emptyEnvelope } from '../view/envelope.ts';
import type { PayloadStore } from '../store/store.ts';
import { executeCursor, executeOperation } from './execute.ts';
import type { ExecutedResponse, ExecuteOptions } from './execute.ts';
import type { CursorError, CursorRecord, CursorStore } from '../cursors.ts';
import { coerceArgs, prepareRequest, runtimeError } from './request.ts';
import type { RuntimeError } from './request.ts';
import type { BindingTable } from './secrets.ts';
import type { WritesPolicy } from '../workspace.ts';
import { writesMode } from '../workspace.ts';

export type RunOptions = ExecuteOptions & {
  readonly store: PayloadStore;
  /** Named view to apply; defaults to the operation's primary view. */
  readonly view?: string;
  readonly dryRun?: boolean;
  readonly limits?: Partial<Limits>;
  readonly notes?: readonly string[];
  /** Store lifetime for the handle produced by this run. */
  readonly ttlSeconds?: number;
  /** The host's write policy. Unnamed means `confirm`. */
  readonly writes?: WritesPolicy;
  /** Explicit confirmation for a write when the mode is `confirm`. */
  readonly confirm?: boolean;
  /** Continue a paginated read from a cursor instead of running the operation. */
  readonly cursor?: string;
  /** Where cursor records live. Without it, a paged run reports no cursor. */
  readonly cursors?: CursorStore;
};

export type DryRunPlan = {
  readonly dryRun: true;
  readonly operation: string;
  readonly method: string;
  readonly host: string;
  readonly url: string;
  readonly query: Readonly<Record<string, string>>;
  /** Header *names* only. Values never leave the executor. */
  readonly headers: readonly string[];
  readonly body?: string;
  readonly secret?: { readonly name: string; readonly host: string; readonly header: string };
  /** Whether this call changes data; a preview of a write says so. */
  readonly mutating: boolean;
};

export type RunResult =
  | {
      readonly dryRun: false;
      readonly handle: string;
      readonly envelope: Envelope;
      readonly network: true;
      readonly status: number;
      readonly url: string;
      readonly method: string;
      readonly mutating: boolean;
      /** Opaque handle to the next page, when the API offered one. */
      readonly cursor?: string;
    }
  | DryRunPlan;

export function resolveView(operation: Operation, name?: string): Result<ViewSpec, RuntimeError> {
  if (name === undefined) return ok(operation.view ?? { select: '/', mode: 'auto' });

  const named = operation.views?.[name];
  if (named === undefined) {
    const available = Object.keys(operation.views ?? {});
    return err(
      runtimeError('unknown_view', `${operation.id} has no view '${name}'`, {
        hint: available.length > 0 ? `views: ${available.join(', ')}` : 'this operation declares only its primary view',
      }),
    );
  }

  return ok(named);
}

function hostOf(baseUrl: string): Result<string, RuntimeError> {
  try {
    return ok(new URL(baseUrl).hostname.toLowerCase());
  } catch {
    return err(runtimeError('invalid_argument', `the map's baseUrl is not an absolute URL: ${baseUrl}`));
  }
}

function checkBinding(operation: Operation, host: string, bindings: BindingTable | undefined): Result<DryRunPlan['secret'], RuntimeError> {
  if (operation.secret === undefined) return ok(undefined);

  const binding = bindings?.[operation.secret];
  if (binding === undefined) {
    return err(
      runtimeError('secret_unbound', `${operation.id} needs secret '${operation.secret}' but no binding names it`, {
        hint: 'a human binds a secret to a host in the bindings file; a map only names it',
      }),
    );
  }

  if (binding.host !== host) {
    return err(
      runtimeError('secret_unbound', `secret ${operation.secret} is bound to ${binding.host} and cannot be sent to ${host}`, {
        hint: 'binding is a human action; edit the bindings file deliberately',
      }),
    );
  }

  return ok({ name: operation.secret, host: binding.host, header: binding.header });
}

function unknownOperation(map: MapDocument, id: string): RuntimeError {
  const ids = map.operations.map((operation) => operation.id);
  const near = ids.filter((candidate) => candidate.includes(id) || id.includes(candidate.split('.')[0] ?? '')).slice(0, 5);
  return runtimeError('unknown_operation', `no operation '${id}' in map ${map.id}`, {
    hint: near.length > 0 ? `did you mean: ${near.join(', ')}` : `${map.id} has ${ids.length} operations; ls /${map.id} lists them`,
  });
}

/** Build the request without sending it. */
export function planOperation(
  map: MapDocument,
  operation: Operation,
  args: Readonly<Record<string, unknown>> = {},
  bindings?: BindingTable,
): Result<DryRunPlan, RuntimeError> {
  const coerced = coerceArgs(operation, args);
  if (!coerced.ok) return coerced;

  const host = hostOf(map.baseUrl);
  if (!host.ok) return host;

  const secret = checkBinding(operation, host.value, bindings);
  if (!secret.ok) return secret;

  const prepared = prepareRequest(map.baseUrl, operation, coerced.value);
  if (!prepared.ok) return prepared;

  const query: Record<string, string> = {};
  for (const [key, value] of prepared.value.url.searchParams) query[key] = value;

  const headerNames = new Set(Object.keys(prepared.value.headers));
  if (secret.value !== undefined) headerNames.add(secret.value.header);

  return ok({
    dryRun: true,
    operation: operation.id,
    method: prepared.value.method,
    host: host.value,
    url: `${prepared.value.url.origin}${prepared.value.url.pathname}`,
    query,
    headers: [...headerNames],
    ...(prepared.value.body === undefined ? {} : { body: prepared.value.body }),
    ...(secret.value === undefined ? {} : { secret: secret.value }),
    mutating: isMutating(operation),
  });
}

export type Executed = {
  readonly operation: Operation;
  readonly handle: string;
  readonly payload: unknown;
  readonly sourceBytes: number;
  readonly url: string;
  readonly requestUrl: string;
  readonly status: number;
  readonly nextUrl?: string;
};

/**
 * Run the request and store the payload, without rendering it.
 *
 * Rendering belongs to the caller: `run` renders the operation's view, a pin
 * renders its own address, and neither should fail because the other's view does
 * not fit.
 */
export async function executeStored(
  map: MapDocument,
  operationId: string,
  args: Readonly<Record<string, unknown>> = {},
  options: RunOptions,
): Promise<Result<Executed, RuntimeError>> {
  const operation = findOperationIn(map, operationId);
  if (operation === undefined) return err(unknownOperation(map, operationId));

  const executed = await executeOperation(operation, args, options);
  if (!executed.ok) return executed;

  return storeExecuted(operation, executed.value, options);
}

/** Store a response behind a handle and describe it as an `Executed`. */
async function storeExecuted(
  operation: Operation,
  response: ExecutedResponse,
  options: RunOptions,
): Promise<Result<Executed, RuntimeError>> {
  const handle = await options.store.put(response.payload, {
    operation: operation.id,
    view: options.view ?? null,
    url: response.url,
    host: response.host,
    status: response.status,
    kind: 'response',
    ...(options.ttlSeconds === undefined ? {} : { ttlSeconds: options.ttlSeconds }),
  });

  return ok({
    operation,
    handle: handle.handle,
    payload: response.payload,
    sourceBytes: response.bytes,
    url: response.url,
    requestUrl: response.requestUrl,
    status: response.status,
    ...(response.nextUrl === undefined ? {} : { nextUrl: response.nextUrl }),
  });
}

function cursorFailure(error: CursorError): RuntimeError {
  const code = error.code === 'cursor_not_found' ? 'unknown_cursor' : 'cursor_invalid';
  return error.hint === undefined
    ? runtimeError(code, error.message)
    : runtimeError(code, error.message, { hint: error.hint });
}

async function resolveCursor(
  operation: Operation,
  id: string,
  options: RunOptions,
): Promise<Result<CursorRecord, RuntimeError>> {
  if (options.cursors === undefined) {
    return err(
      runtimeError('unknown_cursor', `no cursor store is configured, so ${id} cannot be resolved`, {
        hint: 'a cursor is cache; the host supplies the store, as it does for payloads',
      }),
    );
  }

  const found = await options.cursors.get(id);
  if (!found.ok) return err(cursorFailure(found.error));

  if (found.value.operation !== operation.id) {
    return err(
      runtimeError('cursor_mismatch', `cursor ${id} continues ${found.value.operation}, not ${operation.id}`, {
        hint: `pass this cursor to ${found.value.operation}`,
      }),
    );
  }

  return ok(found.value);
}

/** A cursor's next page as a dry-run plan, with the same fields `planOperation` prints. */
async function planCursor(operation: Operation, id: string, options: RunOptions): Promise<Result<RunResult, RuntimeError>> {
  const record = await resolveCursor(operation, id, options);
  if (!record.ok) return record;

  const url = new URL(record.value.url);
  const query: Record<string, string> = {};
  for (const [key, value] of url.searchParams) query[key] = value;

  let secret: DryRunPlan['secret'];
  if (operation.secret !== undefined) {
    const binding = options.bindings?.[operation.secret];
    if (binding === undefined || binding.host !== url.hostname.toLowerCase()) {
      return err(
        runtimeError('secret_unbound', `${operation.id} needs secret '${operation.secret}' for ${url.hostname}, and no binding names that host`, {
          hint: 'binding is a human action; edit the bindings file deliberately',
        }),
      );
    }
    secret = { name: operation.secret, host: binding.host, header: binding.header };
  }

  return ok({
    dryRun: true,
    operation: operation.id,
    method: 'GET',
    host: url.hostname.toLowerCase(),
    url: `${url.origin}${url.pathname}`,
    query,
    headers: Object.keys(operation.request.headers ?? {}).map((name) => name.toLowerCase()),
    ...(secret === undefined ? {} : { secret }),
    mutating: false,
  });
}

function lastSegment(path: string): string | undefined {
  return path.split('/').filter((part) => part !== '').pop();
}

/**
 * The next page of an offset-paginated response, when the total says there is one.
 *
 * The query keys come from the pagination paths' last segment (`/skip` → `skip`),
 * which is how the importer and the hand-written maps both name them.
 */
export function nextOffsetUrl(operation: Operation, payload: unknown, requestUrl: string): string | undefined {
  const pagination = operation.pagination;
  if (pagination?.kind !== 'offset') return undefined;

  const total = readAt(payload, pagination.totalPath);
  if (!total.ok || typeof total.value.node !== 'number') return undefined;

  const skipKey = lastSegment(pagination.skipPath);
  const limitKey = lastSegment(pagination.limitPath);
  if (skipKey === undefined || limitKey === undefined) return undefined;

  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return undefined;
  }

  const skip = Number(url.searchParams.get(skipKey));
  const limit = Number(url.searchParams.get(limitKey));
  if (!Number.isFinite(skip) || !Number.isFinite(limit) || limit <= 0) return undefined;

  const next = skip + limit;
  if (next >= total.value.node) return undefined;

  url.searchParams.set(skipKey, String(next));
  return url.href;
}

/**
 * Store the next page URL and return its id.
 *
 * A cursor that cannot be written is a missing convenience, not a failed run:
 * the payload is already stored and the envelope is still correct.
 */
async function nextCursor(
  operation: Operation,
  executed: Executed,
  cursors: CursorStore | undefined,
): Promise<string | undefined> {
  if (cursors === undefined || isMutating(operation)) return undefined;

  const next = executed.nextUrl ?? nextOffsetUrl(operation, executed.payload, executed.requestUrl);
  if (next === undefined) return undefined;

  const stored = await cursors.put({ operation: operation.id, url: next });
  return stored.ok ? stored.value.id : undefined;
}

async function finishOperation(
  operation: Operation,
  view: ViewSpec,
  executed: Executed,
  options: RunOptions,
): Promise<Result<RunResult, RuntimeError>> {
  const cursor = await nextCursor(operation, executed, options.cursors);
  const mutating = isMutating(operation);

  if (executed.status === 204 || executed.status === 205) {
    return ok({
      dryRun: false,
      handle: executed.handle,
      envelope: emptyEnvelope({
        operation: operation.id,
        status: executed.status,
        handle: executed.handle,
        sourceBytes: executed.sourceBytes,
        ...(operation.provenance === undefined ? {} : { provenance: operation.provenance }),
      }),
      network: true,
      status: executed.status,
      url: executed.url,
      method: executed.operation.request.method,
      mutating,
    });
  }

  const spec: ViewSpec = {
    ...view,
    ...(options.limits === undefined ? {} : { limits: { ...view.limits, ...options.limits } }),
  };

  const rendered = renderView(executed.payload, spec, {
    handle: executed.handle,
    sourceBytes: executed.sourceBytes,
    ...(operation.provenance === undefined ? {} : { provenance: operation.provenance }),
    ...(options.notes === undefined ? {} : { notes: options.notes }),
  });

  if (!rendered.ok) {
    return err(
      runtimeError('bad_response', `view for ${operation.id} does not fit the response: ${rendered.error.message}`, {
        hint: `${rendered.error.hint ?? ''} (handle ${executed.handle} is stored; read it to inspect)`.trim(),
      }),
    );
  }

  return ok({
    dryRun: false,
    handle: executed.handle,
    envelope: cursor === undefined ? rendered.value : { ...rendered.value, cursor },
    network: true,
    status: executed.status,
    url: executed.url,
    method: executed.operation.request.method,
    mutating,
    ...(cursor === undefined ? {} : { cursor }),
  });
}

export async function runOperation(
  map: MapDocument,
  operationId: string,
  args: Readonly<Record<string, unknown>> = {},
  options: RunOptions,
): Promise<Result<RunResult, RuntimeError>> {
  const operation = findOperationIn(map, operationId);
  if (operation === undefined) return err(unknownOperation(map, operationId));

  const view = resolveView(operation, options.view);
  if (!view.ok) return view;

  if (options.dryRun === true) {
    if (options.cursor === undefined) return planOperation(map, operation, args, options.bindings);
    return planCursor(operation, options.cursor, options);
  }

  if (options.cursor !== undefined) {
    if (Object.keys(args).length > 0) {
      return err(
        runtimeError('invalid_argument', 'a cursor already names the next page and takes no arguments', {
          hint: 'drop the key=value pairs, or run the operation without a cursor',
        }),
      );
    }

    const record = await resolveCursor(operation, options.cursor, options);
    if (!record.ok) return record;

    const response = await executeCursor(operation, record.value.url, options);
    if (!response.ok) return response;

    const stored = await storeExecuted(operation, response.value, options);
    if (!stored.ok) return stored;

    return finishOperation(operation, view.value, stored.value, options);
  }

  const mutating = isMutating(operation);
  if (mutating) {
    const mode = writesMode(options.writes);
    if (mode === 'deny') {
      return err(
        runtimeError('write_denied', `${operation.id} changes data, and this workspace is read-only`, {
          hint: 'writes.mode is deny in the workspace descriptor; a host that allows writes sets open or confirm',
        }),
      );
    }
    if (mode === 'confirm' && options.confirm !== true) {
      return err(
        runtimeError('write_not_confirmed', `${operation.id} changes data and was not sent`, {
          hint: 'nothing has been sent; repeat the call with confirm to send it',
        }),
      );
    }
  }

  const executed = await executeStored(map, operationId, args, options);
  if (!executed.ok) return executed;

  return finishOperation(operation, view.value, executed.value, options);
}

/** Read a stored handle at an address, re-applying the operation's view when the
 * address is the one the view selected. */
export async function readHandle(
  store: PayloadStore,
  handle: string,
  address = '/',
  options: { maxItems?: number } = {},
): Promise<Result<Envelope, RuntimeError>> {
  const record = await store.get(handle);
  if (!record.ok) {
    return err(runtimeError('bad_response', record.error.message, { hint: record.error.hint }));
  }

  const status = record.value.meta.status;
  if (status === 204 || status === 205) {
    return ok(
      emptyEnvelope({
        ...(record.value.meta.operation === undefined ? {} : { operation: record.value.meta.operation }),
        status,
        handle,
        sourceBytes: record.value.meta.bytes,
      }),
    );
  }

  const at = readAt(record.value.payload, address, { hintHandle: handle });
  if (!at.ok) return err(runtimeError('bad_response', at.error.message, { hint: at.error.hint }));

  const rendered = renderView(record.value.payload, {
    select: address,
    ...(options.maxItems === undefined ? {} : { limits: { maxItems: options.maxItems } }),
  }, { handle, sourceBytes: record.value.meta.bytes });

  if (!rendered.ok) return err(runtimeError('bad_response', rendered.error.message, { hint: rendered.error.hint }));
  return ok(rendered.value);
}
