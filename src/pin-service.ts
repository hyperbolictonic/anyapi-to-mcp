// Pin actions: create, resolve, unpin, prune.
//
// Resolution is `run` with a name attached: execute the saved query, store the
// payload, render the saved address, and record what happened. The record is
// written every time, because the state *is* the value: `ok`, `broken:<code>`
// or `retired` tells the next session whether the memory still holds.
//
// Nothing here deletes a pin because a request failed. Pruning removes only what
// is provably dead: the operation is absent from every map, or an ephemeral pin
// passed its expiry.

import type { MapCatalog } from './map/load.ts';
import type { MapDocument } from './map/types.ts';
import { isMutating } from './map/types.ts';
import type { Pin, PinArgs, PinDraft, PinState, PinStore, PinStoreError } from './pins.ts';
import { isPinExpired, markFailed, markResolved, markRetired, brokenCode, pinFromDraft } from './pins.ts';
import type { PayloadStore } from './store/store.ts';
import { executeStored } from './runtime/run.ts';
import type { RunOptions } from './runtime/run.ts';
import { coerceArgs } from './runtime/request.ts';
import type { VerbResult } from './verbs.ts';
import { find, findOperation, readStoredView } from './verbs.ts';

export type PinContext = {
  readonly catalog: MapCatalog;
  readonly pins: PinStore;
  readonly store: PayloadStore;
  /** The client's run wiring: transport, bindings, policy, limits. */
  readonly runOptions: (map: MapDocument, view: string | undefined) => RunOptions;
  readonly now?: () => Date;
};

export type CreatePinOptions = {
  readonly dryRun?: boolean;
};

export type ReadPinOptions = {
  /** Drill into the resolved payload at a different address, without re-pinning. */
  readonly address?: string;
  readonly maxItems?: number;
};

function nowOf(context: PinContext): Date {
  return context.now?.() ?? new Date();
}

function failure(code: string, message: string, hint?: string, extra: Record<string, unknown> = {}): VerbResult {
  return {
    text: hint === undefined ? message : `${message}\n${hint}`,
    isError: true,
    data: { error: code, message, ...(hint === undefined ? {} : { hint }), ...extra },
  };
}

function storeFailure(error: PinStoreError): VerbResult {
  return failure(error.code, error.message, error.hint, error.details === undefined ? {} : { details: error.details });
}

/** A failed resolution: the state is the headline, because the pin still exists. */
function brokenResult(pin: Pin, message: string, hint: string | undefined, extra: Record<string, unknown> = {}): VerbResult {
  return {
    text: [
      `@${pin.name} — ${pin.operation}  [${pin.state}]`,
      message,
      ...(hint === undefined ? [] : [hint]),
      '# the pin is saved and marked, not deleted',
    ].join('\n'),
    isError: true,
    data: {
      error: brokenCode(pin.state) ?? pin.lastError?.code ?? 'error',
      message,
      ...(hint === undefined ? {} : { hint }),
      pin,
      ...extra,
    },
  };
}

function argsText(pin: Pin): string {
  return Object.entries(pin.args)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' ');
}

function pinLines(pin: Pin, heading: string): string[] {
  const args = argsText(pin);
  const view =
    pin.fields === undefined && pin.mode === undefined && pin.view === undefined
      ? ''
      : `  fields=${(pin.fields ?? []).join(',')}${pin.mode === undefined ? '' : `  mode=${pin.mode}`}${pin.view === undefined ? '' : `  view=${pin.view}`}`;

  return [
    `${heading} ${pin.name} — ${pin.operation}  [${pin.state}]`,
    `  address: ${pin.address}${view}`,
    ...(args === '' ? [] : [`  args: ${args}`]),
    ...(pin.lastError === undefined ? [] : [`  error: ${pin.lastError.code} — ${pin.lastError.message}`]),
    ...(pin.lastError === undefined ? [] : ['  # the pin is saved and marked, not deleted']),
    ...(pin.note === undefined ? [] : [`  note: ${pin.note}`]),
    ...(pin.expires === undefined ? [] : [`  expires: ${pin.expires}`]),
    ...(pin.state === 'ok' ? [`  next: read @${pin.name}`] : []),
  ];
}

type Resolution =
  | { readonly kind: 'ok'; readonly pin: Pin; readonly result: VerbResult }
  | { readonly kind: 'broken' | 'retired'; readonly pin: Pin; readonly result: VerbResult };

async function persist(context: PinContext, pin: Pin): Promise<{ pin: Pin; error?: PinStoreError }> {
  const saved = await context.pins.put(pin);
  return saved.ok ? { pin: saved.value } : { pin, error: saved.error };
}

/**
 * Execute the query, render the saved address, and write the outcome back.
 * Every path returns a chart of what happened; none of them throws.
 */
async function resolve(context: PinContext, pin: Pin, options: ReadPinOptions = {}): Promise<Resolution> {
  const found = findOperation(context.catalog, pin.operation);
  if (found === undefined) {
    const message = `no map declares '${pin.operation}'`;
    const retired = markRetired(pin, message);
    const saved = await persist(context, retired);
    if (saved.error !== undefined) return { kind: 'retired', pin: retired, result: storeFailure(saved.error) };

    return {
      kind: 'retired',
      pin: saved.pin,
      result: failure(
        'pin_retired',
        `pin '${pin.name}' points at '${pin.operation}', which no map declares`,
        `unpin ${pin.name}, or re-point it: pin ${pin.name} <operation> ...`,
        { pin: saved.pin },
      ),
    };
  }

  const executed = await executeStored(found.loaded.map, pin.operation, pin.args, context.runOptions(found.loaded.map, pin.view));
  if (!executed.ok) {
    const broken = markFailed(pin, executed.error.code, executed.error.message);
    const saved = await persist(context, broken);
    if (saved.error !== undefined) return { kind: 'broken', pin: broken, result: storeFailure(saved.error) };

    return {
      kind: 'broken',
      pin: saved.pin,
      result: brokenResult(saved.pin, executed.error.message, executed.error.hint),
    };
  }

  const address = options.address ?? pin.address;
  const rendered = readStoredView(
    context.catalog,
    executed.value.payload,
    executed.value.handle,
    address,
    executed.value.sourceBytes,
    pin.operation,
    options.maxItems,
    {
      ...(pin.fields === undefined ? {} : { fields: pin.fields }),
      ...(pin.mode === undefined ? {} : { mode: pin.mode }),
    },
  );

  if (rendered.isError === true) {
    const data = rendered.data as { code?: string; message?: string } | undefined;
    const code = typeof data?.code === 'string' ? data.code : 'view_failed';
    const message = typeof data?.message === 'string' ? data.message : rendered.text;

    const broken = markFailed(pin, code, message);
    const saved = await persist(context, broken);
    if (saved.error !== undefined) return { kind: 'broken', pin: broken, result: storeFailure(saved.error) };

    return {
      kind: 'broken',
      pin: saved.pin,
      result: brokenResult(
        saved.pin,
        message,
        `address ${address} did not resolve; fix it with: pin ${pin.name} ${pin.operation} ... --address <address>`,
        { handle: executed.value.handle },
      ),
    };
  }

  const resolved = markResolved(pin, executed.value.handle, nowOf(context));
  const saved = await persist(context, resolved);
  if (saved.error !== undefined) return { kind: 'ok', pin: resolved, result: storeFailure(saved.error) };

  return {
    kind: 'ok',
    pin: saved.pin,
    result: {
      text: `@${saved.pin.name} — ${saved.pin.operation} → ${address}  [ok]\n${rendered.text}`,
      data: { pin: saved.pin, envelope: rendered.data },
    },
  };
}

export async function createPin(draft: PinDraft, context: PinContext, options: CreatePinOptions = {}): Promise<VerbResult> {
  const built = pinFromDraft(draft, nowOf(context));
  if (!built.ok) return storeFailure(built.error);

  const found = findOperation(context.catalog, draft.operation);
  if (found === undefined) {
    return failure('unknown_operation', `no operation '${draft.operation}' to pin`, find({ catalog: context.catalog }, draft.operation).text);
  }

  if (isMutating(found.operation)) {
    return failure(
      'mutating_operation',
      `${found.operation.id} changes data, and a pin re-resolves every time it is read`,
      'pin a read operation instead; a write belongs in run, not in durable memory',
    );
  }

  const coerced = coerceArgs(found.operation, draft.args ?? {});
  if (!coerced.ok) return failure(coerced.error.code, coerced.error.message, coerced.error.hint);

  if (options.dryRun === true) {
    return {
      text: [...pinLines(built.value, 'would pin'), '# dry run: nothing was resolved and nothing was written'].join('\n'),
      data: { pin: built.value, dryRun: true },
    };
  }

  const outcome = await resolve(context, built.value);
  if (outcome.result.isError === true && outcome.kind !== 'broken') return outcome.result;

  return {
    text: pinLines(outcome.pin, outcome.kind === 'ok' ? 'pinned' : 'pinned (unresolved)').join('\n'),
    data: {
      pin: outcome.pin,
      state: outcome.pin.state,
      ...(outcome.kind === 'ok' ? { envelope: (outcome.result.data as { envelope?: unknown } | undefined)?.envelope } : {}),
    },
    // A broken pin is still a saved pin: the state is the answer. Only a pin that
    // could not be created at all is an error.
    isError: false,
  };
}

export async function readPin(name: string, context: PinContext, options: ReadPinOptions = {}): Promise<VerbResult> {
  const loaded = await context.pins.list();
  if (!loaded.ok) return storeFailure(loaded.error);

  const pin = loaded.value.pins.find((entry) => entry.name === name);
  if (pin === undefined) {
    const known = loaded.value.pins.map((entry) => entry.name);
    return failure(
      'pin_not_found',
      `no pin '${name}'`,
      known.length === 0 ? 'pin <name> <operation> saves a query' : `known pins: ${known.join(', ')}`,
      { available: known },
    );
  }

  const outcome = await resolve(context, pin, options);
  return outcome.result;
}

export async function unpin(name: string, context: PinContext): Promise<VerbResult> {
  const loaded = await context.pins.list();
  if (!loaded.ok) return storeFailure(loaded.error);

  const pin = loaded.value.pins.find((entry) => entry.name === name);
  if (pin === undefined) {
    const known = loaded.value.pins.map((entry) => entry.name);
    return failure('pin_not_found', `no pin '${name}'`, known.length === 0 ? 'there are no pins' : `known pins: ${known.join(', ')}`, {
      available: known,
    });
  }

  const removed = await context.pins.delete(name);
  if (!removed.ok) return storeFailure(removed.error);

  return {
    text: `unpinned ${name}${pin.state === 'ok' ? '' : ` (was ${pin.state})`}`,
    data: { unpinned: name, existed: true, state: pin.state },
  };
}

export type PruneOptions = {
  /** Without this, prune is a report. Removal is explicit. */
  readonly apply?: boolean;
};

export type PruneCandidate = {
  readonly name: string;
  readonly reason: 'retired' | 'expired';
  readonly detail: string;
};

export async function prunePins(context: PinContext, options: PruneOptions = {}): Promise<VerbResult> {
  const loaded = await context.pins.list();
  if (!loaded.ok) return storeFailure(loaded.error);

  const now = nowOf(context);
  const candidates: PruneCandidate[] = [];
  const kept: Pin[] = [];

  for (const pin of loaded.value.pins) {
    if (findOperation(context.catalog, pin.operation) === undefined) {
      candidates.push({ name: pin.name, reason: 'retired', detail: `no map declares '${pin.operation}'` });
      continue;
    }
    if (pin.ephemeral === true && isPinExpired(pin, now)) {
      candidates.push({ name: pin.name, reason: 'expired', detail: `expired ${pin.expires ?? ''}`.trim() });
      continue;
    }
    kept.push(pin);
  }

  if (candidates.length === 0) {
    const states = tally(loaded.value.pins);
    return {
      text: `prune: nothing to remove (${loaded.value.pins.length} pin${loaded.value.pins.length === 1 ? '' : 's'}${states === '' ? '' : `: ${states}`})`,
      data: { removed: [], kept: loaded.value.pins.map((pin) => pin.name), applied: false },
    };
  }

  if (options.apply !== true) {
    return {
      text: [
        `prune: ${candidates.length} pin${candidates.length === 1 ? '' : 's'} to remove (dry run; pass --apply to remove)`,
        ...candidates.map((candidate) => `  ${candidate.reason} ${candidate.name} — ${candidate.detail}`),
        `# kept ${kept.length}: broken pins are marked, never auto-removed`,
      ].join('\n'),
      data: { wouldRemove: candidates, kept: kept.map((pin) => pin.name), applied: false },
    };
  }

  const removed: string[] = [];
  for (const candidate of candidates) {
    const result = await context.pins.delete(candidate.name);
    if (!result.ok) return storeFailure(result.error);
    if (result.value) removed.push(candidate.name);
  }

  return {
    text: [
      `prune: removed ${removed.length} pin${removed.length === 1 ? '' : 's'}`,
      ...candidates.filter((candidate) => removed.includes(candidate.name)).map((candidate) => `  ${candidate.reason} ${candidate.name}`),
    ].join('\n'),
    data: { removed, kept: kept.map((pin) => pin.name), applied: true },
  };
}

function tally(pins: readonly Pin[]): string {
  const counts = new Map<PinState, number>();
  for (const pin of pins) counts.set(pin.state, (counts.get(pin.state) ?? 0) + 1);

  return [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([state, count]) => `${count} ${state}`)
    .join(', ');
}
