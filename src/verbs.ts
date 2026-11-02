// The five verbs, as text and as data.
//
// Each verb returns both: `text` is what an agent or a human reads, `data` is
// the same answer in a structured form for `--json` and for a UI. There is one
// implementation, so the CLI and the MCP server cannot drift.

import type { LoadedMap, MapCatalog } from './map/load.ts';
import type { MapDocument, Operation } from './map/types.ts';
import { isMutating, operationsFor, resourceOf } from './map/types.ts';
import type { Pin, PinIssue, PinState } from './pins.ts';
import { brokenCode } from './pins.ts';
import type { Envelope, Mode } from './view/types.ts';
import { emptyEnvelope } from './view/envelope.ts';
import { renderView } from './view/view.ts';

export type VerbResult = {
  readonly text: string;
  readonly data?: unknown;
  readonly isError?: boolean;
};

export type VerbContext = {
  readonly catalog: MapCatalog;
  /** Loaded pins, when the host has a pin store. */
  readonly pins?: readonly Pin[];
  /** Pin-file problems worth showing next to the pin list. */
  readonly pinIssues?: readonly PinIssue[];
};

function pad(value: string, width: number): string {
  return value.length >= width ? value : value.padEnd(width);
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** Find the map that declares an operation id. */
export function mapForOperation(catalog: MapCatalog, operationId: string): LoadedMap | undefined {
  const exactMap = catalog.maps.get(operationId.split('.')[0] ?? '');
  const candidates = exactMap ? [exactMap] : [...catalog.maps.values()];
  return candidates.find((loaded) => loaded.map.operations.some((operation) => operation.id === operationId));
}

export function findOperation(catalog: MapCatalog, operationId: string): { loaded: LoadedMap; operation: Operation } | undefined {
  for (const loaded of catalog.maps.values()) {
    const operation = loaded.map.operations.find((entry) => entry.id === operationId);
    if (operation) return { loaded, operation };
  }
  return undefined;
}

/** `ls /`, `ls /<map>`, `ls /<map>/<resource>`. Never more than ~20 lines. */
export function ls(context: VerbContext, address = '/'): VerbResult {
  const parts = address.split('/').filter(Boolean);
  const maps = [...context.catalog.maps.values()];

  if (parts[0] === 'pins') return lsPins(context, parts.slice(1));

  if (parts.length === 0) {
    const lines = maps.map(
      (loaded) => `${pad(loaded.map.id, 14)} ${loaded.map.title} — ${count(loaded.map.resources.length, 'resource')}, ${count(loaded.map.operations.length, 'operation')}  [${loaded.tier}]`,
    );
    return {
      text: lines.length > 0 ? lines.join('\n') : '(no maps loaded; point --workspace at a directory of maps)',
      data: maps.map((loaded) => ({ id: loaded.map.id, title: loaded.map.title, tier: loaded.tier, operations: loaded.map.operations.length })),
    };
  }

  const loaded = context.catalog.maps.get(parts[0]!);
  if (!loaded) {
    return {
      text: `unknown map '${parts[0]}'. Try: ls /`,
      isError: true,
      data: { error: 'unknown_map', map: parts[0], available: maps.map((entry) => entry.map.id) },
    };
  }

  if (parts.length === 1) {
    const lines = loaded.map.resources.map((resource) => {
      const count = operationsFor(loaded.map, resource.id).length;
      return `${pad(resource.id, 14)} ${resource.title} — ${count} operation${count === 1 ? '' : 's'}`;
    });
    return { text: lines.length > 0 ? lines.join('\n') : `(${loaded.map.id} declares no resources)`, data: loaded.map.resources };
  }

  const resource = resourceOf(loaded.map, parts[1]!);
  if (!resource) {
    return {
      text: `no resource '${parts[1]}' in ${loaded.map.id}. Resources: ${loaded.map.resources.map((entry) => entry.id).join(', ')}`,
      isError: true,
      data: { error: 'unknown_resource', resource: parts[1], available: loaded.map.resources.map((entry) => entry.id) },
    };
  }

  const operations = operationsFor(loaded.map, resource.id);
  const lines = operations.map(
    (operation) =>
      `${pad(operation.id, 26)} ${operation.title}${isMutating(operation) ? '  [mutating]' : ''}${operation.provenance ? `  ${operation.provenance}` : ''}`,
  );

  return { text: lines.length > 0 ? lines.join('\n') : `(no operations on ${resource.id})`, data: operations };
}

/** The state to show now: an operation that has gone away is provably retired. */
function pinStateIn(context: VerbContext, pin: Pin): PinState {
  const loaded = mapForOperation(context.catalog, pin.operation);
  if (loaded === undefined) return 'retired';
  return pin.state === 'retired' ? 'stale' : pin.state;
}

function issueLines(issues: readonly PinIssue[]): string[] {
  return issues.map((entry) => `# pins: ${entry.path}: ${entry.message}`);
}

/** `ls /pins` and `ls /pins/<name>`. Pins are the only durable agent memory. */
function lsPins(context: VerbContext, rest: readonly string[]): VerbResult {
  const issues = context.pinIssues ?? [];

  if (rest.length === 0) {
    const pins = [...(context.pins ?? [])].sort((a, b) => a.name.localeCompare(b.name));

    if (pins.length === 0) {
      return {
        text: ['(no pins; pin <name> <operation> [key=value...] saves a query)', ...issueLines(issues)].join('\n'),
        data: [],
      };
    }

    const rows = pins.map((pin) => {
      const state = pinStateIn(context, pin);
      const error = brokenCode(state) === undefined ? '' : `  ${pin.lastError?.message ?? ''}`.trimEnd();
      return `${pad(pin.name, 18)} ${pad(state, 24)} ${pad(pin.operation, 26)} ${pin.address}${error}`;
    });

    return {
      text: [
        ...rows,
        '# read @<name> re-resolves; ls /pins/<name> shows one; prune removes dead ones',
        ...issueLines(issues),
      ].join('\n'),
      data: pins.map((pin) => ({ ...pin, state: pinStateIn(context, pin) })),
    };
  }

  if (rest.length > 1) {
    return {
      text: `'${rest.join('/')}' is not a pin address. Try: ls /pins`,
      isError: true,
      data: { error: 'unknown_pin_address', path: rest.join('/') },
    };
  }

  const name = rest[0]!;
  const pin = (context.pins ?? []).find((entry) => entry.name === name);
  if (pin === undefined) {
    const known = (context.pins ?? []).map((entry) => entry.name);
    return {
      text: `no pin '${name}'.${known.length > 0 ? ` Known pins: ${known.join(', ')}` : ' Pin one with: pin <name> <operation>'}`,
      isError: true,
      data: { error: 'unknown_pin', pin: name, available: known },
    };
  }

  const state = pinStateIn(context, pin);
  const args = Object.entries(pin.args)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' ');

  const lines = [
    `@${pin.name} — ${pin.operation}  [${state}]`,
    `  args: ${args === '' ? '(none)' : args}`,
    `  address: ${pin.address}${pin.fields === undefined ? '' : `  fields=${pin.fields.join(',')}`}${pin.mode === undefined ? '' : `  mode=${pin.mode}`}${pin.view === undefined ? '' : `  view=${pin.view}`}`,
    `  state: ${state}${pin.lastResolved === undefined ? '' : ` · last resolved ${pin.lastResolved}`}${pin.lastHandle === undefined ? '' : ` · handle ${pin.lastHandle}`}${pin.expires === undefined ? '' : ` · expires ${pin.expires}`}`,
    ...(pin.lastError === undefined ? [] : [`  last error: ${pin.lastError.code} — ${pin.lastError.message}`]),
    ...(pin.note === undefined ? [] : [`  note: ${pin.note}`]),
    `  next: read @${pin.name}`,
  ];

  return { text: lines.join('\n'), data: { ...pin, state } };
}

/** Lexical search across ids, titles and descriptions. No embeddings here. */
export function find(context: VerbContext, query: string, limit = 8): VerbResult {
  const terms = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return { text: 'give me something to look for', isError: true };

  const scored: Array<{ score: number; operation: Operation; mapId: string }> = [];

  for (const loaded of context.catalog.maps.values()) {
    for (const operation of loaded.map.operations) {
      const id = operation.id.toLowerCase();
      const segments = id.split(/[.\-_]/);
      const title = (operation.title ?? '').toLowerCase();
      const description = (operation.description ?? '').toLowerCase();
      let score = 0;

      for (const term of terms) {
        if (segments.includes(term)) score += 5;
        else if (id.includes(term)) score += 3;
        if (operation.resource === term || operation.returns === term) score += 2;
        if (title.includes(term)) score += 2;
        if (description.includes(term)) score += 1;
      }

      if (score > 0) scored.push({ score, operation, mapId: loaded.map.id });
    }
  }

  scored.sort((a, b) => b.score - a.score || a.operation.id.localeCompare(b.operation.id));
  const top = scored.slice(0, Math.max(1, limit));

  if (top.length === 0) {
    return {
      text: `no match for '${query}'. Try ls / to see the maps.`,
      data: { query, matches: [] },
    };
  }

  return {
    text: top.map((entry) => `${pad(entry.operation.id, 26)} ${entry.operation.title}  [${entry.mapId}]`).join('\n'),
    data: { query, matches: top.map((entry) => ({ operation: entry.operation.id, title: entry.operation.title, map: entry.mapId, score: entry.score })) },
  };
}

function inputLines(operation: Operation): string[] {
  const properties = operation.input?.properties ?? {};
  const required = new Set(operation.input?.required ?? []);
  const entries = Object.entries(properties);
  if (entries.length === 0) return ['(none)'];

  return entries.map(([name, property]) => {
    const bits = [`${name}: ${property.type}`];
    if (required.has(name)) bits.push('required');
    if (property.enum) bits.push(`[${property.enum.join('|')}]`);
    if (property.default !== undefined) bits.push(`=${JSON.stringify(property.default)}`);
    if (property.minimum !== undefined) bits.push(`min ${property.minimum}`);
    if (property.maximum !== undefined) bits.push(`max ${property.maximum}`);
    return bits.join(' ');
  });
}

/** Everything needed to call the operation, and nothing else. */
export function describe(context: VerbContext, operationId: string): VerbResult {
  const found = findOperation(context.catalog, operationId);
  if (!found) {
    const near = [...context.catalog.maps.values()]
      .flatMap((loaded) => loaded.map.operations.map((operation) => operation.id))
      .filter((id) => id.includes(operationId) || operationId.includes(id.split('.')[0] ?? ''))
      .slice(0, 5);

    return {
      text: `no operation '${operationId}'.${near.length > 0 ? ` Did you mean: ${near.join(', ')}` : ' Try: find <query>'}`,
      isError: true,
      data: { error: 'unknown_operation', operation: operationId, candidates: near },
    };
  }

  const { loaded, operation } = found;
  const map: MapDocument = loaded.map;
  const view = operation.view ?? { select: '/', mode: 'auto' };
  const links = (map.links ?? []).filter((link) => link.from === (operation.returns ?? operation.resource));

  const data = {
    operation: operation.id,
    title: operation.title,
    description: operation.description,
    map: map.id,
    mutating: isMutating(operation),
    provenance: operation.provenance,
    request: `${operation.request.method} ${map.baseUrl}${operation.request.path}`,
    resource: operation.resource,
    returns: operation.returns ?? operation.resource,
    input: Object.fromEntries(
      Object.entries(operation.input?.properties ?? {}).map(([name, property]) => [name, property.type]),
    ),
    required: operation.input?.required ?? [],
    secret: operation.secret,
    view: `${view.select ?? '/'} mode=${view.mode ?? 'auto'}${view.fields ? ` fields=${view.fields.join(',')}` : ''}`,
    views: Object.keys(operation.views ?? {}),
    pagination: operation.pagination?.kind ?? 'none',
    links: links.map((link) => `${link.field} -> ${link.operation}(${link.argument})`),
  };

  const text = [
    `${operation.id} — ${operation.title}  [${map.id}]`,
    ...(operation.description ? [operation.description] : []),
    `${operation.request.method} ${map.baseUrl}${operation.request.path} → ${data.returns}`,
    `mutating: ${data.mutating ? 'yes' : 'no'}${operation.provenance ? ` · provenance: ${operation.provenance}` : ''}${operation.secret ? ` · secret: ${operation.secret}` : ''}`,
    `input: ${inputLines(operation).join('; ')}`,
    `view: ${data.view}`,
    ...(data.views.length > 0 ? [`alternative views: ${data.views.join(', ')}`] : []),
    ...(data.pagination !== 'none' ? [`pagination: ${data.pagination}`] : []),
    ...(links.length > 0 ? [`links: ${data.links.join('; ')}`] : []),
  ].join('\n');

  return { text, data };
}

/**
 * Render an envelope for a text consumer. Columnar rows travel as compact JSON,
 * because that *is* their cheapest form; text modes travel as text, because
 * escaping a tree into JSON doubles its cost for no benefit.
 */
export function renderEnvelopeText(envelope: Envelope): string {
  const size = envelope.bytes > 0 ? ` · ${envelope.bytes}B` : '';

  if (envelope.text !== undefined) {
    const head = `# ${envelope.summary}${size}${envelope.handle ? ` · ${envelope.handle}` : ''}`;
    const lines = [head, envelope.text];
    if (envelope.hint) lines.push(`# ${envelope.hint}`);
    if (envelope.cursor) lines.push(`# next page: cursor=${envelope.cursor}`);
    return lines.join('\n');
  }

  return JSON.stringify(envelope);
}

export type ReadViewOptions = {
  /** Columns or mode a pin declares, taking precedence over the operation's view. */
  readonly fields?: readonly string[];
  readonly mode?: Mode;
  /** HTTP status of the stored response; a 204/205 renders as one line. */
  readonly status?: number;
};

/** Read a stored payload through the view layer, inheriting the producing
 * operation's view when the address is the one that view selected. */
export function readStoredView(
  catalog: MapCatalog,
  payload: unknown,
  handle: string,
  address: string,
  sourceBytes: number,
  operationId: string | undefined,
  maxItems: number | undefined,
  override: ReadViewOptions = {},
): VerbResult {
  if (override.status === 204 || override.status === 205) {
    const empty = emptyEnvelope({
      ...(operationId === undefined ? {} : { operation: operationId }),
      status: override.status,
      handle,
      sourceBytes,
    });
    return { text: renderEnvelopeText(empty), data: empty };
  }

  const found = operationId === undefined ? undefined : findOperation(catalog, operationId);
  const view = found?.operation.view;

  const matchesSelect = view?.select !== undefined && normaliseAddress(view.select) === normaliseAddress(address);
  const mode = override.mode ?? (matchesSelect ? view?.mode : undefined);
  const fields = override.fields ?? (matchesSelect ? view?.fields : undefined);

  const rendered = renderView(
    payload,
    {
      select: address,
      ...(mode === undefined ? {} : { mode }),
      ...(fields === undefined ? {} : { fields }),
      ...(maxItems === undefined ? {} : { limits: { maxItems } }),
    },
    { handle, sourceBytes },
  );

  if (!rendered.ok) {
    return {
      text: `${rendered.error.message}${rendered.error.hint ? `\n${rendered.error.hint}` : ''}`,
      isError: true,
      data: rendered.error,
    };
  }

  return { text: renderEnvelopeText(rendered.value), data: rendered.value };
}

function normaliseAddress(address: string): string {
  return address === '' || address === '/' ? '/' : address.replace(/\/+$/, '');
}
