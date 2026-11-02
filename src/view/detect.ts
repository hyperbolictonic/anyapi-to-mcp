// Shape detection.
//
// The chosen mode is always reported, so an agent never has to guess how its
// answer was shaped. Detection is a total function over any JSON value.

import type { Cell, Limits, Mode, ResolvedMode, ValueType } from './types.ts';
import { isPlainObject, typeName, MODE_ALIASES } from './types.ts';
import { childAddress } from './address.ts';

const KNOWN: ReadonlySet<string> = new Set<Mode>(['auto', 'rows', 'document', 'list', 'table', 'jsonl', 'shape', 'scalar']);

/** Accept a mode string from a map (including legacy recipe names) or reject it
 * with the list of valid values. Never falls back silently: a typo must not
 * quietly change how the data is presented. */
export function normaliseMode(mode: string | undefined): Mode | null {
  if (mode === undefined || mode === '') return 'auto';
  const lower = String(mode).toLowerCase();
  if (KNOWN.has(lower)) return lower as Mode;
  const alias = MODE_ALIASES[lower];
  return alias ?? null;
}

export function isScalar(v: unknown): boolean {
  return v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === undefined;
}

export function inferMode(node: unknown): ResolvedMode {
  if (Array.isArray(node)) {
    if (node.length === 0) return 'list';
    if (node.every(isPlainObject)) return 'rows';
    if (node.every(isScalar)) return 'list';
    // Mixed arrays go to `document`: a list of `[object Object]` is worse than
    // a depth-capped tree, and rows would silently drop the scalars.
    return 'document';
  }
  if (isPlainObject(node)) return 'document';
  return 'scalar';
}

/** A cell after projection. Containers become summaries carrying their size,
 * which is the drill-down prompt: `{obj:36}` says where to look next. */
export function summariseCell(value: unknown, maxFieldChars: number): Cell {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) return `[arr:${value.length}]`;
  if (typeof value === 'object') return `{obj:${Object.keys(value as Record<string, unknown>).length}}`;
  if (typeof value === 'string' && maxFieldChars > 0 && value.length > maxFieldChars) {
    return `${value.slice(0, maxFieldChars)}…`;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  return String(value);
}

function shortScalar(v: unknown, maxChars: number): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') {
    const s = maxChars > 0 && v.length > maxChars ? `${v.slice(0, maxChars)}…` : v;
    return JSON.stringify(s);
  }
  return String(v);
}

/**
 * Keys and types only, no values. The cheapest "what is in here" call: a
 * measured 832 KB payload reduces to about 380 characters, which is what makes
 * `ls`-style exploration of an unknown response affordable.
 */
export function shapeOf(node: unknown, address: string, limits: Limits): string {
  const lines: string[] = [];
  const root = address === '' || address === '/' ? '/' : address;

  function walk(n: unknown, ptr: string, depth: number): void {
    if (Array.isArray(n)) {
      const sample = n.find(isPlainObject);
      if (sample !== undefined) {
        const keys = Object.keys(sample);
        const shown = keys.slice(0, limits.maxKeys);
        const spec = shown.map((k) => `${k}:${typeName((sample as Record<string, unknown>)[k])}`).join(' ');
        const more = keys.length > shown.length ? ` +${keys.length - shown.length} keys` : '';
        lines.push(`${ptr}  arr(${n.length}) of obj(${keys.length}): ${spec}${more}`);
      } else {
        lines.push(`${ptr}  arr(${n.length}) of ${n.length ? typeName(n[0]) : 'empty'}`);
      }
      return;
    }

    if (isPlainObject(n)) {
      const keys = Object.keys(n);
      if (depth > 0) lines.push(`${ptr}  obj(${keys.length})`);
      for (const key of keys.slice(0, limits.maxKeys)) {
        const child = n[key];
        const childPtr = childAddress(ptr, key);
        if ((isPlainObject(child) || Array.isArray(child)) && depth < 2) walk(child, childPtr, depth + 1);
        else lines.push(`${childPtr}  ${typeName(child)}`);
      }
      if (keys.length > limits.maxKeys) lines.push(`${ptr}  +${keys.length - limits.maxKeys} keys`);
      return;
    }

    lines.push(`${ptr}  ${typeName(n)}`);
  }

  walk(node, root, 0);
  return lines.join('\n');
}

export function fieldTypeSpec(value: unknown): ValueType {
  return typeName(value);
}
