// Addresses.
//
// An address is a JSON Pointer (RFC 6901), optionally ending in a key selector:
//
//   /lines/12                  positional, rots when the data changes
//   /lines[name='Starforge']   keyed, stable, returns every match
//
// The single invariant the whole product rests on: **any address this module
// prints must parse back and resolve to the same node.** So parse and print are
// exact inverses, and the test suite checks that by round-trip.

import type { ViewError } from './errors.ts';
import { viewError } from './errors.ts';
import { getField } from './field.ts';
import type { Result } from './result.ts';
import { err, ok } from './result.ts';

export type SelectorValue = string | number | boolean;

export type Selector = {
  readonly field: string;
  readonly value: SelectorValue;
};

export type Address = {
  /** JSON Pointer to the parent node. `''` is the root, printed as `/`. */
  readonly base: string;
  readonly selector: Selector | null;
  /** Canonical text form: what printing produces and parsing accepts. */
  readonly text: string;
};

export type Resolution = {
  readonly node: unknown;
  /** The canonical address that was resolved. */
  readonly address: string;
  /** Number of rows matched when a selector was used; otherwise null. */
  readonly matched: number | null;
  /** For a selector match, the array it was applied to. */
  readonly baseNode?: unknown;
};

const FIELD_PATH = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
const INTEGER = /^(?:0|[1-9][0-9]*)$/;
const NUMERIC = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/;

function parseScalar(raw: string): SelectorValue {
  const trimmed = raw.trim();
  const first = trimmed[0];
  if (trimmed.length >= 2 && (first === "'" || first === '"') && trimmed[trimmed.length - 1] === first) {
    return trimmed.slice(1, -1).replace(/\\(.)/g, '$1');
  }
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (NUMERIC.test(trimmed)) return Number(trimmed);
  return trimmed;
}

function printScalar(value: SelectorValue): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  // Strings are always quoted, so the value can never be mistaken for a number
  // or a boolean on the way back in. Prefer ' unless the value is full of them.
  if (!value.includes("'")) return `'${value.replace(/\\/g, '\\\\')}'`;
  if (!value.includes('"')) return `"${value.replace(/\\/g, '\\\\')}"`;
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** Print the canonical form of a keyed address. */
export function printSelector(base: string, selector: Selector): string {
  const prefix = base === '' || base === '/' ? '' : base.replace(/\/+$/, '');
  return `${prefix}${prefix === '' ? '/' : ''}[${selector.field}=${printScalar(selector.value)}]`;
}

function validatePointer(pointer: string, source: string): Result<string, ViewError> {
  if (pointer === '' || pointer === '/') return ok('');
  if (!pointer.startsWith('/')) {
    return err(viewError('bad_address', `address must start with '/': ${source}`, { address: source, hint: 'try /' }));
  }
  for (const segment of pointer.slice(1).split('/')) {
    if (!/^(?:[^~]|~[01])*$/.test(segment)) {
      return err(
        viewError('bad_address', `invalid escape sequence in address segment '${segment}'`, {
          address: source,
          hint: 'escape `~` as ~0 and `/` as ~1',
        }),
      );
    }
  }
  return ok(pointer);
}

export function parseAddress(input: string): Result<Address, ViewError> {
  const text = String(input ?? '').trim();
  if (text === '' || text === '/') return ok({ base: '', selector: null, text: '/' });

  const open = text.lastIndexOf('[');
  if (open === -1) {
    const pointer = validatePointer(text, text);
    return pointer.ok ? ok({ base: pointer.value, selector: null, text: pointer.value === '' ? '/' : text }) : pointer;
  }

  if (!text.endsWith(']')) {
    return err(
      viewError('bad_address', `unterminated key selector in address: ${text}`, {
        address: text,
        hint: "close the selector, e.g. /lines[name='x']",
      }),
    );
  }

  const inner = text.slice(open + 1, -1);
  const eq = inner.indexOf('=');
  if (eq === -1) {
    return err(
      viewError('bad_address', `key selector needs field=value: [${inner}]`, {
        address: text,
        hint: "e.g. /lines[name='x']",
      }),
    );
  }

  const field = inner.slice(0, eq).trim();
  if (!FIELD_PATH.test(field)) {
    return err(viewError('bad_address', `bad selector field '${field}'`, { address: text, hint: 'use a dotted field path, e.g. customer.id' }));
  }

  const base = validatePointer(text.slice(0, open), text);
  if (!base.ok) return base;

  const selector: Selector = { field, value: parseScalar(inner.slice(eq + 1)) };
  return ok({ base: base.value, selector, text: printSelector(base.value, selector) });
}

function unescapeToken(token: string): string {
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

function sameValue(a: unknown, b: SelectorValue): boolean {
  // Case-insensitive for strings: real data disagrees with its own docs about
  // case (poe.ninja's `detailsId` is a slug of `name`). Decided in docs/DESIGN.md.
  if (typeof a === 'string' && typeof b === 'string') return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

/**
 * Resolve a pointer. Strict on arrays: a token must be the canonical decimal of
 * an in-range index, so every resolvable address has exactly one printed form.
 */
export function resolvePointer(root: unknown, pointer: string): Result<unknown, ViewError> {
  const normalised = pointer === '/' ? '' : pointer;
  if (normalised === '') return ok(root);
  if (!normalised.startsWith('/')) {
    return err(viewError('bad_address', `address must start with '/': ${pointer}`, { address: pointer }));
  }

  let node: unknown = root;
  for (const raw of normalised.slice(1).split('/')) {
    const token = unescapeToken(raw);

    if (Array.isArray(node)) {
      if (!INTEGER.test(token) || Number(token) >= node.length) {
        return err(
          viewError('address_not_found', `index '${token}' is out of range at ${pointer} (length ${node.length})`, {
            address: pointer,
            hint: node.length > 0 ? `valid range is 0..${node.length - 1}` : 'this array is empty',
          }),
        );
      }
      node = node[Number(token)];
      continue;
    }

    if (node === null || typeof node !== 'object') {
      return err(
        viewError('address_not_found', `cannot resolve ${pointer}: hit a ${node === null ? 'null' : typeof node} before '${token}'`, {
          address: pointer,
        }),
      );
    }

    const record = node as Record<string, unknown>;
    if (!Object.hasOwn(record, token)) {
      const keys = Object.keys(record);
      return err(
        viewError('address_not_found', `no key '${token}' at ${pointer}`, {
          address: pointer,
          hint: keys.length ? `available: ${keys.slice(0, 8).join(', ')}${keys.length > 8 ? ', …' : ''}` : 'this object has no keys',
        }),
      );
    }
    node = record[token];
  }

  return ok(node);
}

/** Resolve an address, applying a key selector when present. */
export function resolveAddress(
  root: unknown,
  input: string | Address,
  options: { hintHandle?: string } = {},
): Result<Resolution, ViewError> {
  const parsed = typeof input === 'string' ? parseAddress(input) : ok(input);
  if (!parsed.ok) return parsed;
  const address = parsed.value;
  const selector = address.selector;

  if (selector === null) {
    const node = resolvePointer(root, address.base);
    return node.ok ? ok({ node: node.value, address: address.text, matched: null }) : node;
  }

  const baseNode = resolvePointer(root, address.base);
  if (!baseNode.ok) return baseNode;
  if (!Array.isArray(baseNode.value)) {
    return err(
      viewError('selector_needs_array', `a key selector needs an array at ${address.base || '/'}`, {
        address: address.text,
        hint: `${address.base || '/'} is ${baseNode.value === null ? 'null' : typeof baseNode.value}, not an array`,
      }),
    );
  }

  const rows = baseNode.value;
  const hits = rows.filter((row) => sameValue(getField(row, selector.field), selector.value));

  if (hits.length === 0) {
    const seen = rows
      .map((row) => getField(row, selector.field))
      .filter((v): v is SelectorValue => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
      .slice(0, 5);
    return err(
      viewError('selector_miss', `no row where ${selector.field} = ${JSON.stringify(selector.value)} at ${address.base || '/'}`, {
        address: address.text,
        hint: seen.length
          ? `values seen: ${seen.map((v) => JSON.stringify(v)).join(', ')}${rows.length > 5 ? ', …' : ''}`
          : `read ${options.hintHandle ?? '<handle>'} ${address.base || '/'} --fields ${selector.field}`,
      }),
    );
  }

  return ok({ node: hits, address: address.text, matched: hits.length, baseNode: rows });
}

export function childAddress(base: string, token: string | number): string {
  const escaped = String(token).replace(/~/g, '~0').replace(/\//g, '~1');
  const prefix = base === '' || base === '/' ? '' : base.replace(/\/+$/, '');
  return `${prefix}/${escaped}`;
}
