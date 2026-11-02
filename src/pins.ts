// Pins: saved queries.
//
// A pin is `(operation, args, address)`, never a saved pointer into a handle.
// A pointer rots the moment the payload is regenerated or the handle expires; a
// query re-resolves, survives sessions and compaction, and is the only durable
// form of agent memory this system has. Handles are cache; pins are code.
//
// This file is data only: the record format, its validation, and the two stores.
// Resolution lives in `pin-service.ts`, because it needs the runtime.
//
// Lifecycle, decided and implemented:
//
//   ok                   the last resolution worked
//   stale                never resolved in this file, or the shape is unknown
//   broken:<runtime code> a resolution failed (selector miss, 404, unbound secret)
//   retired              the operation is absent from every map — the only
//                        provable death, and the only auto-collected durable state
//
// Failures are marked, never deleted. A 503 or a delisted row is not proof that
// a curated pin is worthless, and deleting it during an outage loses work the
// user cannot reconstruct.

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Mode } from './view/types.ts';
import { isPlainObject } from './view/types.ts';
import { normaliseMode } from './view/detect.ts';
import { parseAddress } from './view/address.ts';
import type { Result } from './view/result.ts';
import { err, ok } from './view/result.ts';

export const PIN_SCHEMA_VERSION = 1;
export const MAX_PIN_NAME = 64;

const PIN_NAME = /^[a-z0-9][a-z0-9._-]*$/;
const BROKEN_STATE = /^broken:[a-z0-9_]+$/;
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export type PinState = 'ok' | 'stale' | 'retired' | `broken:${string}`;

export type PinArgs = Readonly<Record<string, string | number | boolean>>;

export type PinFailure = {
  readonly code: string;
  readonly message: string;
};

export type Pin = {
  readonly name: string;
  readonly operation: string;
  readonly args: PinArgs;
  /** JSON Pointer into the response, optionally ending in a key selector. */
  readonly address: string;
  readonly fields?: readonly string[];
  readonly mode?: Mode;
  /** Named view on the operation, applied before the pin's own address. */
  readonly view?: string;
  readonly note?: string;
  readonly state: PinState;
  readonly failCount: number;
  readonly lastError?: PinFailure;
  readonly lastResolved?: string;
  readonly lastHandle?: string;
  readonly created: string;
  readonly expires?: string;
  readonly ephemeral?: boolean;
};

/** What a caller supplies when naming a query. */
export type PinDraft = {
  readonly name: string;
  readonly operation: string;
  readonly args?: PinArgs;
  readonly address?: string;
  readonly fields?: readonly string[];
  readonly mode?: Mode;
  readonly view?: string;
  readonly note?: string;
  readonly ephemeral?: boolean;
  /** Lifetime in seconds; implies `ephemeral`. */
  readonly ttlSeconds?: number;
};

export type PinIssue = {
  readonly path: string;
  readonly message: string;
  readonly severity: 'error' | 'warning';
};

export type PinLoad = {
  readonly pins: readonly Pin[];
  readonly issues: readonly PinIssue[];
  /** Legacy layouts are read through a projection, never rewritten on read. */
  readonly legacy: boolean;
};

export type PinStoreError = {
  readonly code: 'pins_unreadable' | 'pins_invalid' | 'pins_write_failed' | 'pin_invalid' | 'pin_not_found';
  readonly message: string;
  readonly hint?: string;
  readonly details?: readonly string[];
};

export type PinStore = {
  list(): Promise<Result<PinLoad, PinStoreError>>;
  put(pin: Pin): Promise<Result<Pin, PinStoreError>>;
  delete(name: string): Promise<Result<boolean, PinStoreError>>;
};

function issue(path: string, message: string, severity: 'error' | 'warning' = 'error'): PinIssue {
  return { path, message, severity };
}

function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

/** A pin name is an address component, so it obeys the same rules as a map id. */
export function isValidPinName(name: string): boolean {
  return name.length > 0 && name.length <= MAX_PIN_NAME && PIN_NAME.test(name);
}

function readArgs(value: unknown, path: string, issues: PinIssue[]): PinArgs {
  if (value === undefined) return {};

  if (!isPlainObject(value)) {
    issues.push(issue(path, 'args must be an object of scalars'));
    return {};
  }

  const args: Record<string, string | number | boolean> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (!isScalar(entry)) {
      issues.push(issue(`${path}.${name}`, 'an argument must be a string, number or boolean'));
      continue;
    }
    args[name] = entry;
  }

  return args;
}

function readFields(value: unknown, path: string, issues: PinIssue[]): readonly string[] | undefined {
  if (value === undefined) return undefined;

  if (!Array.isArray(value)) {
    issues.push(issue(path, 'fields must be an array of field paths'));
    return undefined;
  }

  const fields: string[] = [];
  for (const field of value) {
    if (typeof field !== 'string' || field.trim() === '') {
      issues.push(issue(path, 'a field must be a non-empty string'));
      continue;
    }
    if (!fields.includes(field)) fields.push(field);
  }

  return fields.length === 0 ? undefined : fields;
}

function readState(value: unknown): PinState {
  if (value === 'ok' || value === 'stale' || value === 'retired') return value;
  if (typeof value === 'string' && BROKEN_STATE.test(value)) return value as PinState;
  return 'stale';
}

function readFailure(value: unknown): PinFailure | undefined {
  if (!isPlainObject(value) || typeof value['code'] !== 'string') return undefined;
  return { code: value['code'], message: typeof value['message'] === 'string' ? value['message'] : '' };
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

function readIso(value: unknown): string | undefined {
  return typeof value === 'string' && ISO.test(value) ? value : undefined;
}

/**
 * Read one record from a file. Unknown keys are ignored, so a pin file written
 * by a newer version still loads; a broken required field is an issue, not a
 * silent drop, because a dropped pin is lost work.
 */
export function readPinRecord(value: unknown, at: string): { pin: Pin | null; issues: PinIssue[] } {
  const issues: PinIssue[] = [];

  if (!isPlainObject(value)) {
    return { pin: null, issues: [issue(at, 'a pin must be an object')] };
  }

  const name = typeof value['name'] === 'string' ? value['name'] : '';
  if (!isValidPinName(name)) {
    issues.push(issue(`${at}.name`, `'${name}' is not a pin name (lower-case letters, digits, dot, dash, underscore; 1..${MAX_PIN_NAME})`));
  }

  const operation = typeof value['operation'] === 'string' ? value['operation'] : '';
  if (!OPERATION_ID.test(operation)) {
    issues.push(issue(`${at}.operation`, 'operation must be an operation id, e.g. repo.issues.list'));
  }

  const rawAddress = typeof value['address'] === 'string' ? value['address'] : '/';
  const parsed = parseAddress(rawAddress);
  if (!parsed.ok) {
    issues.push(issue(`${at}.address`, parsed.error.message));
  }

  const fields = readFields(value['fields'], `${at}.fields`, issues);
  const args = readArgs(value['args'], `${at}.args`, issues);

  const rawMode = value['mode'];
  const mode = rawMode === undefined ? undefined : normaliseMode(String(rawMode));
  if (rawMode !== undefined && mode === null) {
    issues.push(issue(`${at}.mode`, `unknown mode '${String(rawMode)}'`));
  }

  const expires = value['expires'] === undefined ? undefined : readIso(value['expires']);
  if (value['expires'] !== undefined && expires === undefined) {
    issues.push(issue(`${at}.expires`, 'expires must be an ISO 8601 timestamp in UTC, e.g. 2026-11-01T17:00:00.000Z'));
  }

  if (issues.some((entry) => entry.severity === 'error')) return { pin: null, issues };

  const failCount = typeof value['failCount'] === 'number' && Number.isFinite(value['failCount']) ? Math.max(0, Math.floor(value['failCount'])) : 0;
  const created = readIso(value['created']) ?? new Date(0).toISOString();
  const lastResolved = readIso(value['lastResolved']);
  const lastError = readFailure(value['lastError']);
  const note = typeof value['note'] === 'string' && value['note'].trim() !== '' ? value['note'] : undefined;
  const view = typeof value['view'] === 'string' && value['view'] !== '' ? value['view'] : undefined;
  const lastHandle = typeof value['lastHandle'] === 'string' ? value['lastHandle'] : undefined;

  return {
    pin: {
      name,
      operation,
      args,
      address: parsed.ok ? parsed.value.text : '/',
      ...(fields === undefined ? {} : { fields }),
      ...(mode === null || mode === undefined ? {} : { mode }),
      ...(view === undefined ? {} : { view }),
      ...(note === undefined ? {} : { note }),
      state: readState(value['state']),
      failCount,
      ...(lastError === undefined ? {} : { lastError }),
      ...(lastResolved === undefined ? {} : { lastResolved }),
      ...(lastHandle === undefined ? {} : { lastHandle }),
      created,
      ...(expires === undefined ? {} : { expires }),
      ...(value['ephemeral'] === true ? { ephemeral: true } : {}),
    },
    issues,
  };
}

function entriesOf(document: unknown): { entries: unknown[]; legacy: boolean } | null {
  if (!isPlainObject(document)) return null;

  if (Array.isArray(document['pins'])) {
    return { entries: document['pins'], legacy: false };
  }

  // An earlier release wrote a bare `{ name: pin }` object. Keep reading it rather than
  // rewriting a file a human may have committed.
  if (document['schemaVersion'] === undefined) {
    return { entries: Object.values(document), legacy: true };
  }

  return { entries: [], legacy: false };
}

/** Parse a whole pins file value, keeping every valid pin and reporting the rest. */
export function readPinFile(document: unknown, source = 'pins'): Result<PinLoad, PinStoreError> {
  const entries = entriesOf(document);
  if (entries === null) {
    return err({
      code: 'pins_invalid',
      message: `${source} must be a JSON object`,
      hint: 'expected { "schemaVersion": 1, "pins": [ ... ] }',
    });
  }

  const issues: PinIssue[] = [];
  if (entries.legacy) {
    issues.push(issue(source, 'legacy bare-record pins file; it is read through a projection and never rewritten in place', 'warning'));
  }

  const pins: Pin[] = [];
  const seen = new Set<string>();

  entries.entries.forEach((entry, index) => {
    const at = entries.legacy ? source : `pins[${index}]`;
    const read = readPinRecord(entry, at);
    issues.push(...read.issues);
    if (read.pin === null) return;

    if (seen.has(read.pin.name)) {
      issues.push(issue(at, `duplicate pin name '${read.pin.name}'; the later record wins`, 'warning'));
      const existing = pins.findIndex((pin) => pin.name === read.pin!.name);
      if (existing !== -1) pins.splice(existing, 1);
    }

    seen.add(read.pin.name);
    pins.push(read.pin);
  });

  return ok({
    pins: [...pins].sort((a, b) => a.name.localeCompare(b.name)),
    issues,
    legacy: entries.legacy,
  });
}

/** Validate a draft and turn it into a record that has never been resolved. */
export function pinFromDraft(draft: PinDraft, now: Date): Result<Pin, PinStoreError> {
  const issues: PinIssue[] = [];

  if (!isValidPinName(draft.name)) {
    issues.push(issue('name', `'${draft.name}' is not a pin name (lower-case letters, digits, dot, dash, underscore; 1..${MAX_PIN_NAME})`));
  }
  if (!OPERATION_ID.test(draft.operation)) {
    issues.push(issue('operation', 'operation must be an operation id, e.g. repo.issues.list'));
  }

  const address = typeof draft.address === 'string' ? draft.address : '/';
  const parsed = parseAddress(address);
  if (!parsed.ok) issues.push(issue('address', parsed.error.message));

  const mode = draft.mode === undefined ? undefined : normaliseMode(String(draft.mode));
  if (draft.mode !== undefined && mode === null) issues.push(issue('mode', `unknown mode '${String(draft.mode)}'`));

  const fields = readFields(draft.fields, 'fields', issues);

  let expires: string | undefined;
  if (draft.ttlSeconds !== undefined) {
    if (!Number.isFinite(draft.ttlSeconds) || draft.ttlSeconds <= 0) {
      issues.push(issue('ttlSeconds', 'ttl must be a positive number of seconds'));
    } else {
      expires = new Date(now.getTime() + draft.ttlSeconds * 1000).toISOString();
    }
  }

  if (draft.note !== undefined && draft.note.trim() === '') issues.push(issue('note', 'note must not be empty'));

  if (issues.some((entry) => entry.severity === 'error')) {
    return err({
      code: 'pin_invalid',
      message: 'the pin is not valid',
      hint: 'pin names are lower-case; an address looks like /items[name=\'x\']',
      details: issues.map((entry) => `${entry.path}: ${entry.message}`),
    });
  }

  const args: Record<string, string | number | boolean> = {};
  for (const [name, value] of Object.entries(draft.args ?? {})) {
    if (isScalar(value)) args[name] = value;
  }

  return ok({
    name: draft.name,
    operation: draft.operation,
    args,
    address: parsed.ok ? parsed.value.text : '/',
    ...(fields === undefined ? {} : { fields }),
    ...(mode === undefined || mode === null ? {} : { mode }),
    ...(draft.view === undefined ? {} : { view: draft.view }),
    ...(draft.note === undefined ? {} : { note: draft.note }),
    state: 'stale',
    failCount: 0,
    created: now.toISOString(),
    ...(expires === undefined ? {} : { expires }),
    ...(draft.ephemeral === true || expires !== undefined ? { ephemeral: true } : {}),
  });
}

/** Record a successful resolution. */
export function markResolved(pin: Pin, handle: string, at: Date): Pin {
  const { lastError: _lastError, ...rest } = pin;
  return { ...rest, state: 'ok', failCount: 0, lastResolved: at.toISOString(), lastHandle: handle };
}

/** Record a failure. Always a `broken:<code>` state, never a deletion. */
export function markFailed(pin: Pin, code: string, message: string): Pin {
  const safe = code.replace(/[^a-z0-9_]+/gi, '_').toLowerCase();
  return {
    ...pin,
    state: `broken:${safe === '' ? 'error' : safe}`,
    failCount: pin.failCount + 1,
    lastError: { code, message },
  };
}

export function markRetired(pin: Pin, message: string): Pin {
  return { ...pin, state: 'retired', failCount: pin.failCount + 1, lastError: { code: 'retired', message } };
}

export function isPinExpired(pin: Pin, now: Date): boolean {
  return pin.expires !== undefined && Date.parse(pin.expires) <= now.getTime();
}

/** Whether `state` came from a broken resolution rather than a clean one. */
export function isBroken(state: PinState): boolean {
  return state.startsWith('broken:');
}

export function brokenCode(state: PinState): string | undefined {
  return isBroken(state) ? state.slice('broken:'.length) : undefined;
}

function serialise(pins: readonly Pin[]): string {
  const sorted = [...pins].sort((a, b) => a.name.localeCompare(b.name));
  return `${JSON.stringify({ schemaVersion: PIN_SCHEMA_VERSION, pins: sorted }, null, 2)}\n`;
}

/** In-memory pins: tests, embedding, and a descriptor that names no pins file. */
export class MemoryPinStore implements PinStore {
  private pins = new Map<string, Pin>();

  constructor(initial: readonly Pin[] = []) {
    for (const pin of initial) this.pins.set(pin.name, pin);
  }

  async list(): Promise<Result<PinLoad, PinStoreError>> {
    return ok({
      pins: [...this.pins.values()].sort((a, b) => a.name.localeCompare(b.name)),
      issues: [],
      legacy: false,
    });
  }

  async put(pin: Pin): Promise<Result<Pin, PinStoreError>> {
    this.pins.set(pin.name, pin);
    return ok(pin);
  }

  async delete(name: string): Promise<Result<boolean, PinStoreError>> {
    return ok(this.pins.delete(name));
  }
}

/**
 * File-backed pins: one small JSON file, written atomically.
 *
 * Reads tolerate a missing file and a legacy layout. Writes refuse when any
 * record is unreadable, because rewriting the file would silently discard the
 * pin a human is in the middle of fixing.
 */
export class FilePinStore implements PinStore {
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  async list(): Promise<Result<PinLoad, PinStoreError>> {
    let text: string;
    try {
      text = (await readFile(this.file, 'utf8')).replace(/^\uFEFF/, '');
    } catch {
      return ok({ pins: [], issues: [], legacy: false });
    }

    let document: unknown;
    try {
      document = JSON.parse(text) as unknown;
    } catch (error) {
      return err({
        code: 'pins_unreadable',
        message: `${this.file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        hint: 'pins are a plain JSON file; fix it or remove it to start over',
      });
    }

    return readPinFile(document, this.file);
  }

  async put(pin: Pin): Promise<Result<Pin, PinStoreError>> {
    const current = await this.writable();
    if (!current.ok) return current;

    const pins = current.value.filter((entry) => entry.name !== pin.name);
    pins.push(pin);
    const written = await this.write(pins);
    return written.ok ? ok(pin) : written;
  }

  async delete(name: string): Promise<Result<boolean, PinStoreError>> {
    const current = await this.writable();
    if (!current.ok) return current;

    const kept = current.value.filter((entry) => entry.name !== name);
    if (kept.length === current.value.length) return ok(false);

    const written = await this.write(kept);
    return written.ok ? ok(true) : written;
  }

  /** Read for modification: any unreadable record blocks the write. */
  private async writable(): Promise<Result<readonly Pin[], PinStoreError>> {
    const loaded = await this.list();
    if (!loaded.ok) return loaded;

    const errors = loaded.value.issues.filter((entry) => entry.severity === 'error');
    if (errors.length > 0) {
      return err({
        code: 'pins_invalid',
        message: `${this.file} has ${errors.length} unreadable pin${errors.length === 1 ? '' : 's'}; not rewriting it`,
        hint: 'fix the listed records first; a rewrite would drop them',
        details: errors.map((entry) => `${entry.path}: ${entry.message}`),
      });
    }

    return ok(loaded.value.pins);
  }

  private async write(pins: readonly Pin[]): Promise<Result<void, PinStoreError>> {
    try {
      await mkdir(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.tmp-${process.pid}`;
      await writeFile(temporary, serialise(pins), 'utf8');

      try {
        await rename(temporary, this.file);
      } catch {
        // Windows refuses to rename onto an existing file.
        await unlink(this.file).catch(() => undefined);
        await rename(temporary, this.file);
      }

      return ok(undefined);
    } catch (error) {
      return err({
        code: 'pins_write_failed',
        message: `cannot write ${this.file}: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
}
