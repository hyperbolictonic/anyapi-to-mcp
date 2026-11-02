// Declarative joins inside one response.
//
// A join is field equality only. There is no expression language, and there
// will not be one: the moment a view can compute, a map becomes code and stops
// being reviewable data.
//
// `inner` / `left` / `anti` keep or filter the left rows; `right-anti` returns
// right rows with no match, which is the question a link cannot answer ("what
// is referenced but missing").

import { resolvePointer } from './address.ts';
import type { ViewError } from './errors.ts';
import { viewError } from './errors.ts';
import { getField } from './field.ts';
import type { Result } from './result.ts';
import { err, ok } from './result.ts';
import { isPlainObject } from './types.ts';

export type JoinType = 'inner' | 'left' | 'anti' | 'right-anti';

export type JoinSpec = {
  readonly type: JoinType;
  /** Address of the right-hand array inside the same payload. */
  readonly source: string;
  /** Dotted field path on the left row. */
  readonly left: string;
  /** Dotted field path on the right row. */
  readonly right: string;
  /** Right-hand fields attached to the output; defaults to the whole row. */
  readonly fields?: readonly string[];
  /**
   * Compare strings case-sensitively. The default is case-insensitive because
   * real APIs disagree with their own docs about case: poe.ninja's documented
   * `currencyDetails.id` -> `detailsId` join does not exist, and `detailsId`
   * is a case-varying slug of `name`.
   */
  readonly exact?: boolean;
};

const JOIN_TYPES: ReadonlySet<string> = new Set<JoinType>(['inner', 'left', 'anti', 'right-anti']);

/** A comparable key. Types are kept apart so `1` and `'1'` never join. */
function joinKey(row: unknown, field: string, exact: boolean): string {
  const value = getField(row, field);
  if (value === null || value === undefined) return 'null:';
  if (typeof value === 'string') return `s:${exact ? value : value.toLowerCase()}`;
  if (typeof value === 'number') return `n:${value}`;
  if (typeof value === 'boolean') return `b:${value}`;
  return `o:${JSON.stringify(value)}`;
}

function pick(row: unknown, fields: readonly string[] | undefined): Record<string, unknown> {
  if (!fields || fields.length === 0) return isPlainObject(row) ? row : {};
  const out: Record<string, unknown> = {};
  // A missing match is `null`, not `undefined`: an absent field has to survive
  // JSON serialisation so a `left` join is visibly "matched nothing".
  for (const field of fields) out[field] = getField(row, field) ?? null;
  return out;
}

export function applyJoin(payload: unknown, left: readonly unknown[], spec: JoinSpec): Result<readonly unknown[], ViewError> {
  if (!JOIN_TYPES.has(spec.type)) {
    return err(
      viewError('bad_join', `unknown join type '${String(spec.type)}'`, { hint: 'inner|left|anti|right-anti' }),
    );
  }

  const rightNode = resolvePointer(payload, spec.source);
  if (!rightNode.ok) return rightNode;
  if (!Array.isArray(rightNode.value)) {
    return err(
      viewError('bad_join', `join source ${spec.source} is not an array`, {
        address: spec.source,
        hint: `got ${rightNode.value === null ? 'null' : typeof rightNode.value}`,
      }),
    );
  }

  const right = rightNode.value;
  const exact = spec.exact === true;

  const index = new Map<string, unknown[]>();
  for (const row of right) {
    const key = joinKey(row, spec.right, exact);
    const bucket = index.get(key);
    if (bucket) bucket.push(row);
    else index.set(key, [row]);
  }

  const leftKeys = new Set(left.map((row) => joinKey(row, spec.left, exact)));
  const attach = (row: unknown, match: unknown | undefined): Record<string, unknown> => ({
    ...(isPlainObject(row) ? row : {}),
    ...pick(match ?? {}, spec.fields),
  });

  switch (spec.type) {
    case 'inner':
      return ok(left.filter((row) => index.has(joinKey(row, spec.left, exact))).map((row) => attach(row, index.get(joinKey(row, spec.left, exact))![0])));

    case 'left':
      return ok(left.map((row) => attach(row, index.get(joinKey(row, spec.left, exact))?.[0])));

    case 'anti':
      return ok(left.filter((row) => !index.has(joinKey(row, spec.left, exact))));

    case 'right-anti':
      return ok(right.filter((row) => !leftKeys.has(joinKey(row, spec.right, exact))));
  }
}
