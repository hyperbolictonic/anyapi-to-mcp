// Field paths are dotted (`customer.name`), addresses are JSON Pointers
// (`/customer/name`). They are related but never interchangeable: a dotted path
// printed as an address would not paste back into `read`, and an address
// printed as a field path would collide with keys that contain a dot.
//
// So there is exactly one function that converts one into the other, and the
// printer never emits a dotted string in address position.

import type { Result } from './result.ts';
import { err, ok } from './result.ts';

/** RFC 6901 token escaping. */
export function escapeToken(token: string | number): string {
  return String(token).replace(/~/g, '~0').replace(/\//g, '~1');
}

export function unescapeToken(token: string): string {
  // Order matters: ~1 first, or `~01` would decode to `/` instead of `~1`.
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

export function joinPointer(pointer: string, token: string | number): string {
  const base = pointer === '/' ? '' : pointer.replace(/\/+$/, '');
  return `${base}/${escapeToken(token)}`;
}

/** Split a dotted field path into segments. No escaping: a key containing a dot
 * is addressed with a pointer instead. */
export function fieldSegments(dotted: string): readonly string[] {
  return dotted.split('.');
}

/** Read a dotted field path. A missing path is `undefined`, which is distinct
 * from a `null` value: a declared column that is absent is not null data. */
export function getField(node: unknown, dotted: string): unknown {
  let current: unknown = node;
  for (const part of fieldSegments(dotted)) {
    if (current === null || typeof current !== 'object') return undefined;
    if (Array.isArray(current)) {
      const index = Number(part);
      current = Number.isInteger(index) ? current[index] : undefined;
    } else {
      current = (current as Record<string, unknown>)[part];
    }
    if (current === undefined) return undefined;
  }
  return current;
}

/** True when the path exists and is not `undefined`. */
export function hasField(node: unknown, dotted: string): boolean {
  return getField(node, dotted) !== undefined;
}

/** Convert a dotted field path into an address segment sequence. */
export function addressOfField(base: string, dotted: string): string {
  let pointer = base;
  for (const part of fieldSegments(dotted)) pointer = joinPointer(pointer, part);
  return pointer;
}

/** Convert an address into a dotted field path, refusing tokens that would be
 * ambiguous. Used only for hints and diagnostics, never for resolution. */
export function fieldOfAddress(address: string): Result<string, string> {
  const trimmed = address.trim();
  if (trimmed === '' || trimmed === '/') return ok('');
  if (!trimmed.startsWith('/')) return err(`address must start with '/': ${address}`);
  const tokens = trimmed.slice(1).split('/').map(unescapeToken);
  if (tokens.some((t) => t.includes('.'))) return err(`address segment contains a dot: ${address}`);
  return ok(tokens.join('.'));
}
