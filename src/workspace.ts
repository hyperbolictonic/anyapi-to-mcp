// The workspace descriptor.
//
// The library never chooses a path. The host passes this document, and it is
// data rather than code so an app, the CLI and the MCP server can share the
// exact same configuration instead of each deriving its own.
//
// Read from every map location, most specific first; write to exactly one. One
// pins store and one payload cache, both explicit.

import { homedir } from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

import { isPlainObject } from './view/types.ts';
import type { MapLocation } from './map/load.ts';
import type { Result } from './view/result.ts';
import { err, ok } from './view/result.ts';

export type PinsLocation = { readonly path: string };
export type PayloadLocation = {
  readonly path: string;
  /** Soft cap, declared in the descriptor; eviction is not enforced yet. */
  readonly maxBytes?: number;
  /** Default handle lifetime. Expiry is per handle, not per store. */
  readonly ttlSeconds?: number;
};

/**
 * A handle outlives the process, not the day. Payloads are a cache, so the
 * default is short: a day is enough for a session's drill-down, and a stale
 * response is worse than a refetch. A host that wants longer names it.
 */
export const DEFAULT_PAYLOAD_TTL_SECONDS = 86_400;

/**
 * What the host allows `run` to do with an operation that changes data.
 *
 * `open` sends it. `confirm` (the default) returns the built request and sends
 * nothing until the caller repeats the call with `confirm`; that makes the write
 * a distinct, visible act in a transcript. `deny` is for a read-only deployment.
 *
 * The flag cannot prove a human agreed: it is a speed bump the agent must take
 * deliberately, not an authorisation. A host that needs real approval puts one
 * in front of the tool call.
 */
export type WritesMode = 'open' | 'confirm' | 'deny';
export const WRITES_MODES: readonly WritesMode[] = ['open', 'confirm', 'deny'];
export type WritesPolicy = { readonly mode: WritesMode };

export type WorkspaceDescriptor = {
  readonly maps: readonly MapLocation[];
  readonly overrides?: readonly MapLocation[];
  readonly pins?: PinsLocation;
  readonly payloads?: PayloadLocation;
  readonly secrets?: PinsLocation;
  readonly writes?: WritesPolicy;
};

export type WorkspaceError = {
  readonly code: 'not_found' | 'invalid_json' | 'invalid_descriptor';
  readonly message: string;
  readonly path?: string;
};

export type ExpandOptions = {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly home?: string;
  /** Relative paths resolve against this, usually the workspace file's dir. */
  readonly baseDir?: string;
};

const VARIABLE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

/** Expand `~`, `$VAR` and `${VAR}`, then resolve against `baseDir`. */
export function expandPath(input: string, options: ExpandOptions = {}): string {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();

  let out = String(input).trim();
  if (out === '~') out = home;
  else if (out.startsWith('~/') || out.startsWith('~\\')) out = path.join(home, out.slice(2));

  out = out.replace(VARIABLE, (match, braced: string | undefined, bare: string | undefined) => {
    const name = braced ?? bare ?? '';
    const value = env[name];
    return value === undefined ? match : value;
  });

  if (options.baseDir && !path.isAbsolute(out)) return path.resolve(options.baseDir, out);
  // Normalise absolute results so a substituted variable cannot produce a mix
  // of separators; leave unexpanded templates exactly as written.
  return path.isAbsolute(out) ? path.normalize(out) : out;
}

function expandLocation(location: MapLocation, options: ExpandOptions): MapLocation {
  return {
    path: expandPath(location.path, options),
    ...(location.writable === undefined ? {} : { writable: location.writable }),
    ...(location.label === undefined ? {} : { label: location.label }),
  };
}

function defaultConfigHome(env: Readonly<Record<string, string | undefined>>): string {
  if (env['WRAP2MCP_HOME']) return env['WRAP2MCP_HOME']!;
  if (process.platform === 'win32' && env['APPDATA']) return path.join(env['APPDATA'], 'wrap2mcp');
  return path.join(env['XDG_CONFIG_HOME'] ?? path.join(env['HOME'] ?? homedir(), '.config'), 'wrap2mcp');
}

function defaultCacheHome(env: Readonly<Record<string, string | undefined>>): string {
  if (env['WRAP2MCP_CACHE']) return env['WRAP2MCP_CACHE']!;
  if (process.platform === 'win32' && env['LOCALAPPDATA']) return path.join(env['LOCALAPPDATA'], 'wrap2mcp', 'cache');
  return path.join(env['XDG_CACHE_HOME'] ?? path.join(env['HOME'] ?? homedir(), '.cache'), 'wrap2mcp');
}

/** Shorthand: `maps` may be bare strings, and `payloads`/`pins`/`writes` bare values. */
export type WorkspaceInput = {
  readonly maps?: readonly (string | MapLocation)[];
  readonly overrides?: readonly (string | MapLocation)[];
  readonly pins?: string | PinsLocation;
  readonly payloads?: string | PayloadLocation;
  readonly secrets?: string | PinsLocation;
  readonly writes?: WritesMode | WritesPolicy;
};

/** Read `writes` tolerantly so `checkWorkspace` can report a bad mode. */
function readWrites(value: unknown): WritesPolicy | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return { mode: value as WritesMode };
  if (isPlainObject(value) && typeof value['mode'] === 'string') return { mode: value['mode'] as WritesMode };
  // Present but shapeless: reported as an invalid mode rather than dropped.
  return { mode: '' as WritesMode };
}

/** The mode a host actually gets: an unnamed policy is `confirm`. */
export function writesMode(policy: WritesPolicy | undefined): WritesMode {
  return policy?.mode ?? 'confirm';
}

function toLocation(value: string | MapLocation, writable: boolean | undefined): MapLocation {
  return typeof value === 'string' ? { path: value, ...(writable === undefined ? {} : { writable }) } : value;
}

/** Accept a shorthand or a full descriptor. Explicit descriptor fields win. */
export function normaliseWorkspace(input: WorkspaceInput | WorkspaceDescriptor, options: ExpandOptions = {}): WorkspaceDescriptor {
  const raw = input as WorkspaceInput & Partial<WorkspaceDescriptor>;

  const maps = (raw.maps ?? []).map((entry) => expandLocation(toLocation(entry, undefined), options));
  const overrides = raw.overrides?.map((entry) => expandLocation(toLocation(entry, undefined), options));

  const pins = raw.pins === undefined ? undefined : expandPath(typeof raw.pins === 'string' ? raw.pins : raw.pins.path, options);
  const payloads =
    raw.payloads === undefined
      ? undefined
      : typeof raw.payloads === 'string'
        ? expandPath(raw.payloads, options)
        : { ...raw.payloads, path: expandPath(raw.payloads.path, options) };
  const secrets = raw.secrets === undefined ? undefined : expandPath(typeof raw.secrets === 'string' ? raw.secrets : raw.secrets.path, options);
  const writes = readWrites(raw.writes);

  return {
    maps,
    ...(overrides === undefined ? {} : { overrides }),
    ...(pins === undefined ? {} : { pins: { path: pins } }),
    ...(payloads === undefined ? {} : { payloads: typeof payloads === 'string' ? { path: payloads } : payloads }),
    ...(secrets === undefined ? {} : { secrets: { path: secrets } }),
    ...(writes === undefined ? {} : { writes }),
  };
}

/**
 * A descriptor with sane OS defaults: the project directory overrides the user
 * config, and the user config is the only writable tier. Payloads live in the
 * cache, never in user data, because they are disposable.
 */
export function defaultWorkspace(options: ExpandOptions & { cwd?: string } = {}): WorkspaceDescriptor {
  const env = options.env ?? process.env;
  const configHome = defaultConfigHome(env);
  const cacheHome = defaultCacheHome(env);
  const cwd = options.cwd ?? process.cwd();
  const home = options.home ?? homedir();

  return {
    maps: [
      { path: path.join(cwd, '.wrap2mcp', 'maps'), writable: false, label: 'project' },
      { path: path.join(configHome, 'maps'), writable: true, label: 'user' },
    ],
    overrides: [{ path: path.join(configHome, 'overrides') }],
    pins: { path: path.join(configHome, 'pins.json') },
    payloads: { path: path.join(cacheHome, 'payloads'), ttlSeconds: DEFAULT_PAYLOAD_TTL_SECONDS },
    secrets: { path: path.join(configHome, 'bindings.json') },
  };
}

/** Check the invariants a descriptor must satisfy before anything is read. */
export function checkWorkspace(descriptor: WorkspaceDescriptor): WorkspaceError[] {
  const issues: WorkspaceError[] = [];

  if (descriptor.maps.length === 0) {
    issues.push({ code: 'invalid_descriptor', message: 'a workspace needs at least one map location' });
  }

  const writable = descriptor.maps.filter((location) => location.writable === true);
  if (writable.length > 1) {
    issues.push({
      code: 'invalid_descriptor',
      message: `exactly one map location may be writable; found ${writable.length} (${writable.map((l) => l.path).join(', ')})`,
    });
  }

  for (const location of descriptor.maps) {
    if (location.path.trim() === '') issues.push({ code: 'invalid_descriptor', message: 'a map location has an empty path' });
  }

  const maxBytes = descriptor.payloads?.maxBytes;
  if (maxBytes !== undefined && (!Number.isFinite(maxBytes) || maxBytes <= 0)) {
    issues.push({
      code: 'invalid_descriptor',
      message: `payloads.maxBytes must be a positive number of bytes; got '${String(maxBytes)}'`,
    });
  }

  if (descriptor.writes !== undefined && !WRITES_MODES.includes(descriptor.writes.mode)) {
    issues.push({
      code: 'invalid_descriptor',
      message: `writes.mode must be one of ${WRITES_MODES.join(', ')}; got '${descriptor.writes.mode}'`,
    });
  }

  return issues;
}

/** Read and normalise a `workspace.json`. Relative paths are relative to it. */
export async function readWorkspaceFile(file: string, options: ExpandOptions = {}): Promise<Result<WorkspaceDescriptor, WorkspaceError>> {
  let text: string;
  try {
    // A UTF-8 BOM is common on Windows and is not part of the document.
    text = (await readFile(file, 'utf8')).replace(/^\uFEFF/, '');
  } catch {
    return err({ code: 'not_found', message: `workspace file not found: ${file}`, path: file });
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (error) {
    return err({ code: 'invalid_json', message: `workspace file is not valid JSON: ${String(error)}`, path: file });
  }

  if (!isPlainObject(raw)) {
    return err({ code: 'invalid_descriptor', message: 'a workspace file must be a JSON object', path: file });
  }

  const descriptor = normaliseWorkspace(raw as WorkspaceInput, { ...options, baseDir: options.baseDir ?? path.dirname(file) });
  const issues = checkWorkspace(descriptor);
  if (issues.length > 0) return err({ ...issues[0]!, path: file });

  return ok(descriptor);
}
