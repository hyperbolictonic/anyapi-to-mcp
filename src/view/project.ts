// Projection: JSON in, columns and cells out.
//
// Declared fields beat auto-union. Union is a fallback, and a capped one: on a
// real GitHub issue list, union produced 36 columns and cost 9,550 characters
// where 6 declared fields cost 3,980. The point of declaring fields is not
// tidiness, it is that a 2.4x token saving is the difference between one call
// and three.

import { getField } from './field.ts';
import { summariseCell } from './detect.ts';
import type { Cell, Limits } from './types.ts';
import { isPlainObject, typeName } from './types.ts';

export type RowsBody = {
  readonly fields: readonly string[];
  readonly rows: readonly (readonly Cell[])[];
  readonly total: number;
  readonly returned: number;
  readonly truncated: boolean;
  /** True when `fields` was derived from the data rather than declared. */
  readonly inferredFields: boolean;
  /** True when the inferred field list was capped. */
  readonly fieldsCapped: boolean;
};

/** First-appearance order, deduplicated, capped. */
export function unionFieldNames(items: readonly unknown[], cap: number): { names: string[]; capped: boolean } {
  const seen = new Set<string>();
  for (const item of items) {
    if (!isPlainObject(item)) continue;
    for (const key of Object.keys(item)) seen.add(key);
  }
  const all = [...seen];
  return { names: all.slice(0, cap), capped: all.length > cap };
}

/** `name:type` pairs. One sample per column is enough, and it keeps `fields`
 * to a single line instead of a schema object. */
export function fieldSpecs(items: readonly unknown[], names: readonly string[]): string[] {
  return names.map((name) => {
    let sample: unknown;
    for (const item of items) {
      const value = getField(item, name);
      if (value !== undefined && value !== null) {
        sample = value;
        break;
      }
    }
    return `${name}:${typeName(sample)}`;
  });
}

export function projectRows(items: readonly unknown[], names: readonly string[], limits: Limits): RowsBody {
  const declared = names.length > 0;
  const union = declared ? { names: [...names], capped: false } : unionFieldNames(items, limits.maxKeys);
  const columns = union.names;
  const shown = items.slice(0, limits.maxItems);

  return {
    fields: fieldSpecs(items, columns),
    rows: shown.map((item) => columns.map((name) => summariseCell(getField(item, name), limits.maxFieldChars))),
    total: items.length,
    returned: shown.length,
    truncated: items.length > shown.length,
    inferredFields: !declared,
    fieldsCapped: union.capped,
  };
}

/**
 * A list of scalars is rows with one column. Keeping `rows` as rows-of-cells in
 * every mode means a consumer has one shape to read, not one per mode.
 */
export function projectList(values: readonly unknown[], limits: Limits): RowsBody {
  const shown = values.slice(0, limits.maxItems);
  const types = new Set(values.map((v) => typeName(v)));
  const columnType = types.size === 1 ? [...types][0]! : 'any';

  return {
    fields: [`value:${columnType}`],
    rows: shown.map((v) => [summariseCell(v, limits.maxFieldChars)]),
    total: values.length,
    returned: shown.length,
    truncated: values.length > shown.length,
    inferredFields: true,
    fieldsCapped: false,
  };
}
