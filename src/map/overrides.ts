// Human overrides.
//
// A generated map is disposable; a human correction is not. Overrides live in a
// separate file so that regenerating a map cannot silently discard the work a
// person did to fix a view, a link or an argument name.
//
// Merge rules, in order of surprise:
//   - objects merge recursively;
//   - arrays replace wholesale, except the id-keyed collections below;
//   - `resources` and `operations` merge by `id`, `links` by from/field/to;
//   - an overridden operation or link is marked `provenance: "human"`.

import { isPlainObject } from '../view/types.ts';
import type { MapDocument } from './types.ts';

export type OverrideReport = {
  readonly map: MapDocument;
  /** Paths that were actually changed, for a `--dry-run` style report. */
  readonly applied: readonly string[];
};

const KEYED_COLLECTIONS = new Set(['resources', 'operations']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value);
}

function deepMerge(base: unknown, patch: unknown, path: string, applied: string[]): unknown {
  if (isRecord(base) && isRecord(patch)) {
    const out: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(patch)) {
      const child = `${path}.${key}`;
      if (value === undefined) continue;
      if (isRecord(out[key]) && isRecord(value)) {
        out[key] = deepMerge(out[key], value, child, applied);
      } else if (Array.isArray(out[key]) && Array.isArray(value) && KEYED_COLLECTIONS.has(key)) {
        out[key] = mergeKeyed(out[key] as unknown[], value, child, applied);
      } else {
        out[key] = value;
        applied.push(child);
      }
    }
    return out;
  }

  applied.push(path);
  return patch;
}

function identityOf(item: unknown, index: number): string {
  if (isRecord(item)) {
    if (typeof item['id'] === 'string') return item['id'];
    if (typeof item['from'] === 'string' && typeof item['field'] === 'string' && typeof item['to'] === 'string') {
      return `${item['from']}|${item['field']}|${item['to']}`;
    }
  }
  return `#${index}`;
}

function mergeKeyed(base: readonly unknown[], patch: readonly unknown[], path: string, applied: string[]): unknown[] {
  const out = [...base];
  const positions = new Map<string, number>();

  out.forEach((item, index) => positions.set(identityOf(item, index), index));

  patch.forEach((item, index) => {
    const key = identityOf(item, index);
    const existing = positions.get(key);

    if (existing === undefined) {
      out.push(item);
      applied.push(`${path}[+]${key}`);
      return;
    }

    const merged = deepMerge(out[existing], { ...(item as object), provenance: 'human' }, `${path}[${key}]`, applied);
    out[existing] = merged;
    applied.push(`${path}[${key}]`);
  });

  return out;
}

/** Apply a human overrides document to a loaded map. Never mutates either. */
export function applyOverrides(base: MapDocument, overrides: unknown): OverrideReport {
  if (!isRecord(overrides)) return { map: base, applied: [] };

  const applied: string[] = [];
  const merged = deepMerge({ ...base }, overrides, '$', applied) as MapDocument;

  // The id is identity, not content: an override must patch its own map.
  if (isRecord(overrides) && overrides['id'] !== undefined && overrides['id'] !== base.id) {
    return { map: base, applied: [] };
  }

  return { map: { ...merged, schemaVersion: base.schemaVersion, id: base.id }, applied };
}

/** True when an overrides document looks like it belongs to `id`. */
export function overridesFor(overrides: unknown, id: string): boolean {
  return isRecord(overrides) && (overrides['id'] === undefined || overrides['id'] === id);
}
