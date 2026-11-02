// Loading maps from a workspace.
//
// The loader is the only place that knows a map's physical layout, because the
// layout is a packaging detail, not a format. A location is either a single
// `.json` file or a directory of fragments, and both project to the same
// in-memory `MapDocument`.
//
// Reads come from every location, most specific first. Writes go to exactly one
// (the writable location), so "where did my edit land?" always has one answer.
// A shadowed map is reported, never silently ignored.

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { isPlainObject } from '../view/types.ts';
import { isLegacyDocument, projectLegacy, projectLegacyList } from './legacy.ts';
import { applyOverrides, overridesFor } from './overrides.ts';
import type { Link, MapDocument, MapIssue, Operation, Resource } from './types.ts';
import { validateMap } from './validate.ts';

export type MapLocation = {
  readonly path: string;
  /** Only one location is writable; the rest are read-only tiers. */
  readonly writable?: boolean;
  /** Reported in `ls`, e.g. "user", "project", "bundled". */
  readonly label?: string;
};

export type MapLoadIssue = {
  readonly file: string;
  readonly path: string;
  readonly message: string;
  readonly severity: 'error' | 'warning';
};

export type LoadedMap = {
  readonly map: MapDocument;
  readonly source: string;
  readonly tier: string;
  /** The more specific location whose map of the same id won. */
  readonly shadowedBy?: string;
  readonly warnings: readonly MapLoadIssue[];
};

export type MapCatalog = {
  readonly maps: ReadonlyMap<string, LoadedMap>;
  readonly issues: readonly MapLoadIssue[];
};

const INDEX = 'index.json';

function interpret(raw: unknown, fallbackId: string): { maps: MapDocument[]; issues: MapIssue[] } {
  if (Array.isArray(raw)) {
    const projected = projectLegacyList(raw);
    return { maps: projected.maps, issues: [...projected.issues] };
  }

  if (isLegacyDocument(raw)) {
    const projected = projectLegacy(raw, fallbackId);
    return { maps: projected.map ? [projected.map] : [], issues: [...projected.issues] };
  }

  const validated = validateMap(raw);
  return { maps: validated.map ? [validated.map] : [], issues: [...validated.issues] };
}

function isFragment(raw: unknown): boolean {
  return isPlainObject(raw) && raw['schemaVersion'] === undefined && (raw['resources'] !== undefined || raw['operations'] !== undefined);
}

function foldFragment(base: MapDocument, fragment: unknown, file: string, issues: MapLoadIssue[]): MapDocument {
  if (!isPlainObject(fragment)) {
    issues.push({ file, path: '$', message: 'fragment must be a JSON object', severity: 'error' });
    return base;
  }

  const list = <T>(key: 'resources' | 'operations' | 'links'): T[] => {
    const value = fragment[key];
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
      issues.push({ file, path: `$.${key}`, message: 'must be an array', severity: 'error' });
      return [];
    }
    return value as T[];
  };

  return {
    ...base,
    resources: [...base.resources, ...list<Resource>('resources')],
    operations: [...base.operations, ...list<Operation>('operations')],
    links: [...(base.links ?? []), ...list<Link>('links')],
  };
}

async function readJson(file: string, issues: MapLoadIssue[]): Promise<unknown | null> {
  try {
    return JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, '')) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    issues.push({ file, path: '$', message: `cannot read JSON: ${message}`, severity: 'error' });
    return null;
  }
}

async function statKind(candidate: string): Promise<'dir' | 'file' | 'missing'> {
  try {
    return (await stat(candidate)).isDirectory() ? 'dir' : 'file';
  } catch (error) {
    // A tier that does not exist yet is normal: the user tier is created on
    // first save, and a read-only tier may simply not be shipped.
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'file';
  }
}

async function filesAt(locationPath: string, isDir: boolean, issues: MapLoadIssue[]): Promise<string[]> {
  if (!isDir) return [locationPath];

  try {
    const entries = await readdir(locationPath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => path.join(locationPath, entry.name))
      .sort((a, b) => {
        // `index.json` is the base a split directory merges into.
        if (path.basename(a) === INDEX) return -1;
        if (path.basename(b) === INDEX) return 1;
        return a.localeCompare(b);
      });
  } catch (error) {
    issues.push({
      file: locationPath,
      path: '$',
      message: `cannot read location: ${error instanceof Error ? error.message : String(error)}`,
      severity: 'error',
    });
    return [];
  }
}

/** Load every map from one location. A directory merges into one map. */
export async function loadLocation(location: MapLocation, issues: MapLoadIssue[] = []): Promise<MapDocument[]> {
  const kind = await statKind(location.path);
  if (kind === 'missing') return [];

  const files = await filesAt(location.path, kind === 'dir', issues);
  const dir = kind === 'dir';

  const maps: MapDocument[] = [];
  let base: MapDocument | null = null;

  for (const file of files) {
    const raw = await readJson(file, issues);
    if (raw === null) continue;

    if (isFragment(raw)) {
      if (base === null) {
        issues.push({
          file,
          path: '$',
          message: 'a split directory needs an index.json (or the map file) declaring id, title and baseUrl',
          severity: 'error',
        });
        continue;
      }
      base = foldFragment(base, raw, file, issues);
      continue;
    }

    const interpreted = interpret(raw, path.basename(file, '.json'));
    for (const issue of interpreted.issues) {
      issues.push({ file, path: issue.path, message: issue.message, severity: issue.severity });
    }

    for (const map of interpreted.maps) {
      if (dir && base === null) base = map;
      else maps.push(map);
    }
  }

  if (base !== null) {
    // Fragments are folded in after per-file validation, so validate the whole.
    const merged = validateMap(base);
    for (const issue of merged.issues) {
      if (issue.severity === 'error') {
        issues.push({ file: location.path, path: issue.path, message: issue.message, severity: 'error' });
      }
    }
    if (merged.map) maps.unshift(merged.map);
  }

  return maps;
}

async function loadOverrides(locations: readonly MapLocation[], issues: MapLoadIssue[]): Promise<Map<string, unknown>> {
  const found = new Map<string, unknown>();

  for (const location of locations) {
    const kind = await statKind(location.path);
    if (kind === 'missing') continue;
    for (const file of await filesAt(location.path, kind === 'dir', issues)) {
      const raw = await readJson(file, issues);
      if (raw === null) continue;
      const declared = isPlainObject(raw) && typeof raw['id'] === 'string' ? raw['id'] : path.basename(file, '.json');
      found.set(declared, raw);
    }
  }

  return found;
}

/**
 * Load a catalog from a workspace's map locations.
 *
 * Overrides are a separate list because they are separate on disk: regenerating
 * a map must not touch a human correction, and a human correction must survive
 * a regenerated map.
 */
export async function loadMaps(locations: readonly MapLocation[], overrides: readonly MapLocation[] = []): Promise<MapCatalog> {
  const issues: MapLoadIssue[] = [];
  const maps = new Map<string, LoadedMap>();
  const shadowedBy = new Map<string, string>();

  for (const location of locations) {
    const tier = location.label ?? (location.writable ? 'writable' : 'read-only');
    const before = issues.length;
    const loaded = await loadLocation({ ...location, label: tier }, issues);
    const warnings = issues.slice(before).filter((issue) => issue.severity === 'warning');

    for (const map of loaded) {
      const existing = maps.get(map.id);
      if (existing) {
        shadowedBy.set(map.id, existing.tier);
        issues.push({
          file: location.path,
          path: '$',
          message: `map '${map.id}' is shadowed by the ${existing.tier} location`,
          severity: 'warning',
        });
        continue;
      }

      maps.set(map.id, { map, source: location.path, tier, warnings });
    }
  }

  const overrideDocuments = await loadOverrides(overrides, issues);
  const result = new Map<string, LoadedMap>();

  for (const [id, loaded] of maps) {
    const override = overrideDocuments.get(id);
    if (override === undefined || !overridesFor(override, id)) {
      result.set(id, loaded);
      continue;
    }

    const report = applyOverrides(loaded.map, override);
    const validated = validateMap(report.map);
    for (const issue of validated.issues) {
      issues.push({ file: `overrides/${id}.json`, path: issue.path, message: issue.message, severity: issue.severity });
    }

    result.set(id, {
      ...loaded,
      map: validated.map ?? loaded.map,
      ...(shadowedBy.has(id) ? { shadowedBy: shadowedBy.get(id)! } : {}),
      warnings: [
        ...loaded.warnings,
        ...report.applied.map((issuePath) => ({
          file: `overrides/${id}.json`,
          path: issuePath,
          message: 'overridden',
          severity: 'warning' as const,
        })),
      ],
    });
  }

  return { maps: result, issues };
}
