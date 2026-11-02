// Renderers. One address space, several renderers: every mode here prints the
// same JSON Pointers, so a human reading an agent transcript sees exactly where
// the agent went, and a UI can link each address to its node.
//
// Elision markers always carry an address that actually resolves (the first
// omitted node), never a range like `[3..999]`. An address that does not paste
// back is a lie, and the whole navigation model depends on addresses being
// honest.

import { childAddress } from './address.ts';
import { summariseCell } from './detect.ts';
import { getField } from './field.ts';
import type { Cell, Limits } from './types.ts';
import { isPlainObject } from './types.ts';

export type TextBody = {
  readonly text: string;
  readonly total: number;
  readonly returned: number;
  readonly truncated: boolean;
};

function indent(depth: number): string {
  return '  '.repeat(depth);
}

function shortScalar(v: unknown, maxChars: number): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') {
    const s = maxChars > 0 && v.length > maxChars ? `${v.slice(0, maxChars)}…` : v;
    return JSON.stringify(s);
  }
  return String(v);
}

function isContainer(v: unknown): boolean {
  return Array.isArray(v) || isPlainObject(v);
}

/** How much of a selected node a text mode can show: an array has as many
 * "rows" as elements, any other node is one unit. */
export function textScale(node: unknown, limits: Limits): { total: number; returned: number; truncated: boolean } {
  if (!Array.isArray(node)) return { total: 1, returned: 1, truncated: false };
  const returned = Math.min(node.length, limits.maxItems);
  return { total: node.length, returned, truncated: node.length > returned };
}

/**
 * Depth- and size-capped tree. The default for a single object, because for one
 * object the structure *is* the content; deliberately not the default for a
 * collection, where one header beats one label per row per item.
 */
export function renderOutline(root: unknown, address: string, limits: Limits): TextBody {
  const lines: string[] = [];
  const rootAddress = address === '' ? '/' : address;

  function walk(node: unknown, addr: string, depth: number): void {
    if (Array.isArray(node)) {
      const head = `${indent(depth)}${addr}  arr(${node.length})`;

      if (node.length === 0) {
        lines.push(head);
        return;
      }

      if (node.every((v) => !isContainer(v))) {
        const shown = node.slice(0, limits.maxItems).map((v) => shortScalar(v, limits.maxFieldChars));
        const rest = node.length - shown.length;
        const more = rest > 0 ? `, +${rest} more -> ${childAddress(addr, shown.length)}` : '';
        lines.push(`${head} [${shown.join(', ')}${more}]`);
        return;
      }

      lines.push(head);
      if (depth + 1 >= limits.maxDepth) {
        lines.push(`${indent(depth + 1)}+${node.length} items -> ${childAddress(addr, 0)}  (raise depth)`);
        return;
      }

      const shown = node.slice(0, limits.maxItems);
      shown.forEach((child, i) => walk(child, childAddress(addr, i), depth + 1));
      if (node.length > shown.length) {
        lines.push(`${indent(depth + 1)}+${node.length - shown.length} more -> ${childAddress(addr, shown.length)}`);
      }
      return;
    }

    if (isPlainObject(node)) {
      const keys = Object.keys(node);
      lines.push(`${indent(depth)}${addr}  obj(${keys.length})`);

      if (depth + 1 >= limits.maxDepth) {
        if (keys.length > 0) lines.push(`${indent(depth + 1)}${keys.length} keys -> ${addr}  (raise depth)`);
        return;
      }

      for (const key of keys) {
        const value = node[key];
        const child = childAddress(addr, key);
        if (isContainer(value)) walk(value, child, depth + 1);
        else lines.push(`${indent(depth + 1)}${child}  ${shortScalar(value, limits.maxFieldChars)}`);
      }
      return;
    }

    lines.push(`${indent(depth)}${addr}  ${shortScalar(node, limits.maxFieldChars)}`);
  }

  walk(root, rootAddress, 0);
  return { text: lines.join('\n'), ...textScale(root, limits) };
}

/**
 * Markdown headings: an index for a single object, one section per item for an
 * array. Explodes on collections by design — it is the human renderer, not the
 * agent default.
 */
export function renderHeadings(root: unknown, address: string, limits: Limits, titleField: string | null): TextBody {
  const rootAddress = address === '' ? '/' : address;
  const lines: string[] = [];

  function labelOf(item: unknown, fallback: string): string {
    if (titleField) {
      const value = getField(item, titleField);
      if (typeof value === 'string' || typeof value === 'number') return String(value);
    }
    return fallback;
  }

  function fieldLines(node: Record<string, unknown>, nodeAddress: string): void {
    for (const key of Object.keys(node)) {
      const value = node[key];
      const child = childAddress(nodeAddress, key);
      if (isContainer(value)) lines.push(`- **${key}** ${summariseCell(value, limits.maxFieldChars)}  ${child}`);
      else lines.push(`- **${key}** ${shortScalar(value, limits.maxFieldChars)}`);
    }
  }

  if (Array.isArray(root)) {
    const shown = root.slice(0, limits.maxItems);
    shown.forEach((item, i) => {
      const ItemAddress = childAddress(rootAddress, i);
      lines.push(`## ${i + 1}. ${labelOf(item, ItemAddress)}`);
      if (isPlainObject(item)) fieldLines(item, ItemAddress);
      else lines.push(`- ${summariseCell(item, limits.maxFieldChars)}`);
    });
    if (root.length > shown.length) {
      lines.push(`## +${root.length - shown.length} more -> ${childAddress(rootAddress, shown.length)}`);
    }
  } else if (isPlainObject(root)) {
    lines.push(`# ${rootAddress}`);
    fieldLines(root, rootAddress);
  } else {
    lines.push(shortScalar(root, limits.maxFieldChars));
  }

  return { text: lines.join('\n'), ...textScale(root, limits) };
}

function escapeMarkdown(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/** Markdown table. For humans and for a UI; never the agent default, because a
 * pipe table costs more per cell than columnar rows. */
export function renderTable(items: readonly unknown[], columns: readonly string[], limits: Limits): TextBody {
  const shown = items.slice(0, limits.maxItems);
  const cellText = (item: unknown, name: string): string =>
    escapeMarkdown(String(summariseCell(getField(item, name), limits.maxFieldChars) ?? ''));

  const lines = [
    `| ${columns.map(escapeMarkdown).join(' | ')} |`,
    `| ${columns.map(() => '---').join(' | ')} |`,
    ...shown.map((item) => `| ${columns.map((name) => cellText(item, name)).join(' | ')} |`),
  ];

  return { text: lines.join('\n'), total: items.length, returned: shown.length, truncated: items.length > shown.length };
}

/** One compact JSON object per line. Lossless, and the right form when rows are
 * heterogeneous and a columnar union would be mostly nulls. */
export function renderJsonl(items: readonly unknown[], limits: Limits): TextBody {
  const shown = items.slice(0, limits.maxItems);
  return {
    text: shown.map((item) => JSON.stringify(item)).join('\n'),
    total: items.length,
    returned: shown.length,
    truncated: items.length > shown.length,
  };
}

export function renderScalar(value: unknown): TextBody {
  return { text: shortScalar(value, 0), total: 1, returned: 1, truncated: false };
}

export function renderRowsText(fields: readonly string[], rows: readonly (readonly Cell[])[]): string {
  return JSON.stringify({ fields, rows });
}

export { shortScalar };
