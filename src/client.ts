// The client: one object that wires a workspace, a store, a secret provider and
// `fetch` into the five verbs.
//
// This is the level-2 API an app embeds and the level-3 CLI and MCP server are
// built on. Constructing it does no I/O; the first verb call loads the catalog.
// `reload()` re-reads it, which is what a host app needs when a user edits a map
// on disk while the process is running.

import path from 'node:path';

import { defaultWorkspace, checkWorkspace, normaliseWorkspace, readWorkspaceFile, writesMode, DEFAULT_PAYLOAD_TTL_SECONDS } from './workspace.ts';
import type { WorkspaceDescriptor, WorkspaceInput, WritesMode, WritesPolicy } from './workspace.ts';
import { loadMaps } from './map/load.ts';
import type { MapCatalog } from './map/load.ts';
import { isMutating } from './map/types.ts';
import type { MapDocument, Operation } from './map/types.ts';
import { FileStore, MemoryStore } from './store/store.ts';
import type { PayloadStore } from './store/store.ts';
import type { AuditSink, FetchLike } from './runtime/execute.ts';
import type { Lookup, OutboundPolicy } from './runtime/policy.ts';
import { planOperation, runOperation } from './runtime/run.ts';
import type { DryRunPlan, RunOptions } from './runtime/run.ts';
import { readBindings } from './runtime/secrets.ts';
import type { BindingTable, SecretProvider } from './runtime/secrets.ts';
import { FilePinStore, MemoryPinStore } from './pins.ts';
import type { PinDraft, PinStore } from './pins.ts';
import { FileCursorStore, MemoryCursorStore } from './cursors.ts';
import type { CursorStore } from './cursors.ts';
import { createPin, prunePins, readPin, unpin } from './pin-service.ts';
import type { PinContext, PruneOptions } from './pin-service.ts';
import { describe, find, findOperation, ls, mapForOperation, readStoredView, renderEnvelopeText } from './verbs.ts';
import type { VerbResult } from './verbs.ts';

export type ClientOptions = {
  /** A workspace descriptor, or the shorthand `{ maps: [...] }`. */
  readonly workspace?: WorkspaceDescriptor | WorkspaceInput;
  /** A `workspace.json` to read instead of passing a descriptor. */
  readonly workspaceFile?: string;
  readonly store?: PayloadStore;
  /** Pin storage. Defaults to the workspace's pins file, or memory. */
  readonly pins?: PinStore;
  /** Cursor storage. Defaults to the cache next to payloads, or memory. */
  readonly cursors?: CursorStore;
  readonly fetch?: FetchLike;
  readonly secrets?: SecretProvider;
  readonly bindings?: BindingTable;
  readonly policy?: Partial<OutboundPolicy>;
  readonly audit?: AuditSink;
  readonly now?: () => number;
  readonly lookup?: Lookup;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Write policy for this host; overrides the workspace descriptor. */
  readonly writes?: WritesPolicy;
};

export type RunVerbOptions = {
  readonly view?: string;
  readonly dryRun?: boolean;
  readonly maxItems?: number;
  /** Required to send a write when the workspace's writes mode is `confirm`. */
  readonly confirm?: boolean;
  /** Continue a paginated read from an opaque cursor. */
  readonly cursor?: string;
};

export type ReadVerbOptions = {
  readonly maxItems?: number;
};

export type PinVerbOptions = {
  /** Validate and describe the pin without resolving or writing it. */
  readonly dryRun?: boolean;
};

export type Client = {
  readonly store: PayloadStore;
  readonly pins: PinStore;
  readonly workspace: WorkspaceDescriptor;
  /** The mode `run` will apply to an operation that changes data. */
  readonly writes: WritesMode;
  catalog(): Promise<MapCatalog>;
  /** Discard the cached catalog and read the locations again. */
  reload(): Promise<MapCatalog>;
  ls(address?: string): Promise<VerbResult>;
  find(query: string, limit?: number): Promise<VerbResult>;
  describe(operation: string): Promise<VerbResult>;
  run(operation: string, args?: Readonly<Record<string, unknown>>, options?: RunVerbOptions): Promise<VerbResult>;
  read(handle: string, address?: string, options?: ReadVerbOptions): Promise<VerbResult>;
  /** Save a query under a name, resolving it once to prove it works. */
  pin(draft: PinDraft, options?: PinVerbOptions): Promise<VerbResult>;
  unpin(name: string): Promise<VerbResult>;
  /** Remove pins that are provably dead; a report unless `apply` is set. */
  prune(options?: PruneOptions): Promise<VerbResult>;
};

type Ready = {
  readonly catalog: MapCatalog;
  readonly bindings: BindingTable | undefined;
};

const EMPTY_CATALOG: MapCatalog = { maps: new Map(), issues: [] };

function failure(code: string, message: string, hint?: string): VerbResult {
  return {
    text: hint === undefined ? message : `${message}\n${hint}`,
    isError: true,
    data: { error: code, message, ...(hint === undefined ? {} : { hint }) },
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The answer to a write that was not sent.
 *
 * It is an error value, not a success, so the caller cannot mistake a preview
 * for a completed write; the built request is in `data.plan` so the next call is
 * a decision, not a guess.
 */
function writePreview(
  map: MapDocument,
  operation: Operation,
  args: Readonly<Record<string, unknown>>,
  bindings: BindingTable | undefined,
  mode: WritesMode,
): VerbResult {
  const plan = planOperation(map, operation, args, bindings);
  if (!plan.ok) return failure(plan.error.code, plan.error.message, plan.error.hint);

  const built: DryRunPlan = plan.value;
  const text = [
    `not sent: ${built.method} ${built.url}  [mutating]`,
    ...(built.body === undefined ? [] : [`  body: ${built.body}`]),
    ...(built.secret === undefined ? [] : [`  secret: ${built.secret.name} (bound to ${built.secret.host})`]),
    `  writes.mode is '${mode}'`,
    '# nothing has been sent; repeat with confirm to send it',
  ].join('\n');

  return {
    text,
    isError: true,
    data: { error: 'write_not_confirmed', writes: mode, plan: built },
  };
}

export function createClient(options: ClientOptions = {}): Client {
  const env = options.env ?? process.env;

  let activeWorkspace: WorkspaceDescriptor =
    options.workspace !== undefined
      ? normaliseWorkspace(options.workspace, { env, ...(options.cwd === undefined ? {} : { baseDir: options.cwd }) })
      : defaultWorkspace({ env, ...(options.cwd === undefined ? {} : { cwd: options.cwd }) });

  const store: PayloadStore =
    options.store ??
    (activeWorkspace.payloads === undefined
      ? new MemoryStore()
      : new FileStore(activeWorkspace.payloads.path, {
          ttlSeconds: activeWorkspace.payloads.ttlSeconds ?? DEFAULT_PAYLOAD_TTL_SECONDS,
          ...(activeWorkspace.payloads.maxBytes === undefined ? {} : { maxBytes: activeWorkspace.payloads.maxBytes }),
        }));

  const payloadTtl = activeWorkspace.payloads?.ttlSeconds ?? DEFAULT_PAYLOAD_TTL_SECONDS;

  const cursorStore: CursorStore =
    options.cursors ??
    (activeWorkspace.payloads === undefined
      ? new MemoryCursorStore({ ttlSeconds: payloadTtl })
      : new FileCursorStore(path.join(activeWorkspace.payloads.path, 'cursors'), { ttlSeconds: payloadTtl }));

  let pending: Promise<Ready> | null = null;

  function pinsFor(workspace: WorkspaceDescriptor): PinStore {
    return workspace.pins === undefined ? new MemoryPinStore() : new FilePinStore(workspace.pins.path);
  }

  let pinStore: PinStore = options.pins ?? pinsFor(activeWorkspace);

  async function resolveWorkspace(): Promise<WorkspaceDescriptor> {
    if (options.workspaceFile === undefined) return activeWorkspace;

    const read = await readWorkspaceFile(options.workspaceFile, { env });
    if (!read.ok) throw new Error(read.error.message);
    activeWorkspace = read.value;
    if (options.pins === undefined) pinStore = pinsFor(activeWorkspace);
    return activeWorkspace;
  }

  async function load(): Promise<Ready> {
    const resolved = await resolveWorkspace();
    const issues = checkWorkspace(resolved);
    if (issues.length > 0) throw new Error(issues[0]!.message);

    const catalog = await loadMaps(resolved.maps, resolved.overrides ?? []);

    let bindings = options.bindings;
    if (bindings === undefined && resolved.secrets !== undefined) {
      const read = await readBindings(resolved.secrets.path);
      // A missing bindings file is normal: only operations that name a secret
      // need one, and they carry their own error when they do.
      bindings = read.ok ? read.value : undefined;
    }

    return { catalog, bindings };
  }

  function ready(): Promise<Ready> {
    if (pending === null) {
      pending = load().catch((error: unknown) => {
        pending = null;
        throw error;
      });
    }
    return pending;
  }

  function currentWrites(): WritesMode {
    return writesMode(options.writes ?? activeWorkspace.writes);
  }

  function runOptionsFor(map: { baseUrl: string }, bindings: BindingTable | undefined, verb: RunVerbOptions): RunOptions {
    return {
      baseUrl: map.baseUrl,
      store,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.policy === undefined ? {} : { policy: options.policy }),
      ...(options.secrets === undefined ? {} : { secrets: options.secrets }),
      ...(options.audit === undefined ? {} : { audit: options.audit }),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.lookup === undefined ? {} : { lookup: options.lookup }),
      ...(bindings === undefined ? {} : { bindings }),
      ...(verb.view === undefined ? {} : { view: verb.view }),
      ...(verb.dryRun === undefined ? {} : { dryRun: verb.dryRun }),
      ...(verb.maxItems === undefined ? {} : { limits: { maxItems: verb.maxItems } }),
      writes: { mode: currentWrites() },
      ...(verb.confirm === undefined ? {} : { confirm: verb.confirm }),
      cursors: cursorStore,
      ...(verb.cursor === undefined ? {} : { cursor: verb.cursor }),
    };
  }

  function pinContextFor(state: Ready): PinContext {
    return {
      catalog: state.catalog,
      pins: pinStore,
      store,
      runOptions: (map, view) => runOptionsFor(map, state.bindings, view === undefined ? {} : { view }),
      ...(options.now === undefined ? {} : { now: () => new Date(options.now!()) }),
    };
  }

  return {
    store,

    get pins(): PinStore {
      return pinStore;
    },

    get workspace(): WorkspaceDescriptor {
      return activeWorkspace;
    },

    get writes(): WritesMode {
      return currentWrites();
    },

    async catalog(): Promise<MapCatalog> {
      return (await ready()).catalog;
    },

    async reload(): Promise<MapCatalog> {
      pending = null;
      return (await ready()).catalog;
    },

    async ls(address = '/'): Promise<VerbResult> {
      try {
        const { catalog } = await ready();
        const loaded = await pinStore.list();
        const pins = loaded.ok ? loaded.value.pins : [];
        const pinIssues = loaded.ok
          ? loaded.value.issues
          : [{ path: 'pins', message: loaded.error.message, severity: 'error' as const }];
        return ls({ catalog, pins, pinIssues }, address);
      } catch (error) {
        return failure('workspace', `cannot load maps: ${messageOf(error)}`);
      }
    },

    async find(query, limit): Promise<VerbResult> {
      try {
        const { catalog } = await ready();
        return find({ catalog }, query, limit ?? 8);
      } catch (error) {
        return failure('workspace', `cannot load maps: ${messageOf(error)}`);
      }
    },

    async describe(operation): Promise<VerbResult> {
      try {
        const { catalog } = await ready();
        const described = describe({ catalog }, operation);
        const found = described.isError === true ? undefined : findOperation(catalog, operation);
        if (found === undefined || !isMutating(found.operation)) return described;

        const mode = currentWrites();
        const note =
          mode === 'deny'
            ? '# this workspace is read-only: run will refuse this operation (writes.mode: deny)'
            : mode === 'confirm'
              ? '# writes need confirmation: run with confirm (CLI: --confirm; MCP: confirm: true) or it is only previewed'
              : '# this workspace sends writes without confirmation (writes.mode: open)';

        return {
          ...described,
          text: `${described.text}\n${note}`,
          data: { ...(described.data as Record<string, unknown>), writes: mode },
        };
      } catch (error) {
        return failure('workspace', `cannot load maps: ${messageOf(error)}`);
      }
    },

    async run(operation, args = {}, verb = {}): Promise<VerbResult> {
      let state: Ready;
      try {
        state = await ready();
      } catch (error) {
        return failure('workspace', `cannot load maps: ${messageOf(error)}`);
      }

      const found = findOperation(state.catalog, operation);
      if (found === undefined) {
        return failure('unknown_operation', `no operation '${operation}'`, find({ catalog: state.catalog }, operation).text);
      }

      const result = await runOperation(found.loaded.map, operation, args, runOptionsFor(found.loaded.map, state.bindings, verb));

      if (!result.ok) {
        if (result.error.code === 'write_not_confirmed') {
          return writePreview(found.loaded.map, found.operation, args, state.bindings, currentWrites());
        }
        return failure(result.error.code, result.error.message, result.error.hint);
      }

      if (result.value.dryRun) {
        return { text: JSON.stringify(result.value, null, 2), data: result.value };
      }

      const write = result.value.mutating
        ? { method: result.value.method, url: result.value.url, status: result.value.status }
        : undefined;

      return {
        text:
          write === undefined
            ? renderEnvelopeText(result.value.envelope)
            : `wrote ${write.method} ${write.url} · ${write.status}\n${renderEnvelopeText(result.value.envelope)}`,
        data: {
          envelope: result.value.envelope,
          handle: result.value.handle,
          ...(write === undefined ? {} : { write }),
        },
      };
    },

    async read(handle, address = '/', verb = {}): Promise<VerbResult> {
      if (handle.startsWith('@')) {
        let state: Ready;
        try {
          state = await ready();
        } catch (error) {
          // Never resolve a pin against an empty catalog: that would mark every
          // pin retired because a directory was temporarily unreadable.
          return failure('workspace', `cannot load maps: ${messageOf(error)}`);
        }

        return readPin(handle.slice(1), pinContextFor(state), {
          ...(address === '/' ? {} : { address }),
          ...(verb.maxItems === undefined ? {} : { maxItems: verb.maxItems }),
        });
      }

      const record = await store.get(handle);
      if (!record.ok) return failure(record.error.code, record.error.message, record.error.hint);

      let catalog: MapCatalog = EMPTY_CATALOG;
      try {
        catalog = (await ready()).catalog;
      } catch {
        // A stored payload must still be readable when the map has gone away.
      }

      return readStoredView(
        catalog,
        record.value.payload,
        handle,
        address,
        record.value.meta.bytes,
        record.value.meta.operation,
        verb.maxItems,
        record.value.meta.status === undefined ? {} : { status: record.value.meta.status },
      );
    },

    async pin(draft, verb = {}): Promise<VerbResult> {
      let state: Ready;
      try {
        state = await ready();
      } catch (error) {
        return failure('workspace', `cannot load maps: ${messageOf(error)}`);
      }

      return createPin(draft, pinContextFor(state), verb.dryRun === true ? { dryRun: true } : {});
    },

    async unpin(name): Promise<VerbResult> {
      let state: Ready;
      try {
        state = await ready();
      } catch (error) {
        return failure('workspace', `cannot load maps: ${messageOf(error)}`);
      }

      return unpin(name, pinContextFor(state));
    },

    async prune(verb = {}): Promise<VerbResult> {
      let state: Ready;
      try {
        state = await ready();
      } catch (error) {
        return failure('workspace', `cannot load maps: ${messageOf(error)}`);
      }

      return prunePins(pinContextFor(state), verb);
    },
  };
}
