// Envelope assembly.
//
// The envelope is the fixed contract between the engine and any consumer: an
// agent, a CLI renderer, a UI. Field names and meanings are published, so this
// file is deliberately boring — no clever conditional shapes.

import type { Cell, Envelope, Provenance, ResolvedMode } from './types.ts';

export type RowsPayload = {
  readonly fields: readonly string[];
  readonly rows: readonly (readonly Cell[])[];
  readonly total: number;
  readonly returned: number;
  readonly truncated: boolean;
  readonly inferredFields: boolean;
  readonly fieldsCapped: boolean;
};

export type TextPayload = {
  readonly text: string;
  readonly total: number;
  readonly returned: number;
  readonly truncated: boolean;
};

export type Body = ({ readonly kind: 'rows' } & RowsPayload) | ({ readonly kind: 'text' } & TextPayload);

/** UTF-8 byte length, using the platform TextEncoder so the layer stays
 * portable (no Node built-ins, no Buffer). */
export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** The bytes a consumer actually pays for: the body, not the source payload. */
export function bodyBytes(body: Body): number {
  return body.kind === 'text' ? utf8Bytes(body.text) : utf8Bytes(JSON.stringify({ fields: body.fields, rows: body.rows }));
}

export type AssembleInput = {
  readonly body: Body;
  readonly mode: ResolvedMode;
  readonly address: string;
  readonly handle?: string;
  readonly sourceBytes?: number;
  readonly cursor?: string | null;
  readonly provenance?: Provenance;
  /** Count at the parent when a key selector narrowed the result. */
  readonly scanned?: number;
  /** Extra hints, in priority order, appended to the computed ones. */
  readonly notes?: readonly string[];
};

function summaryOf(input: AssembleInput): string {
  const { body, mode, scanned } = input;
  if (body.kind === 'rows') {
    const counted =
      scanned !== undefined && body.total !== scanned
        ? `${body.total} of ${scanned} rows`
        : `${body.total} row${body.total === 1 ? '' : 's'}`;
    return `${counted}, showing ${body.returned} (${mode})`;
  }
  if (mode === 'scalar') return `scalar`;
  if (scanned !== undefined && body.total !== scanned) return `${mode}, ${body.total} of ${scanned} matched`;
  return body.total > 1 ? `${mode}, ${body.returned} of ${body.total}` : mode;
}

function hintOf(input: AssembleInput): string | undefined {
  const { body, address, handle } = input;
  const hints: string[] = [];
  const target = address === '' ? '/' : address;

  if (body.truncated) {
    const omitted = body.total - body.returned;
    // The continuation address must resolve, so it points at the first omitted
    // node rather than naming a range.
    const next = `${target === '/' ? '' : target.replace(/\/+$/, '')}/${body.returned}`;
    if (handle) hints.push(`+${omitted} more -> read ${handle} ${next}`);
    else hints.push(`+${omitted} more (raise limits.maxItems)`);
  }

  if ((input.mode === 'document' || input.mode === 'shape') && handle) {
    hints.push(`drill: read ${handle} <address>`);
  }

  if (body.kind === 'rows' && body.fieldsCapped) {
    hints.push(`fields capped at ${body.fields.length} (declare view.fields)`);
  }

  for (const note of input.notes ?? []) hints.push(note);

  return hints.length > 0 ? hints.join('; ') : undefined;
}

/**
 * A 204/205 answer, as one line.
 *
 * There is no payload to project, and rendering `null` as a document would say
 * "null" where the honest answer is "no content". The handle still exists, so a
 * later `read` resolves to the same line rather than a different one.
 */
export function emptyEnvelope(options: {
  readonly operation?: string;
  readonly status: number;
  readonly handle?: string;
  readonly sourceBytes?: number;
  readonly provenance?: Provenance;
  readonly address?: string;
}): Envelope {
  const text = options.status === 205 ? 'no content (reset)' : 'no content';

  return {
    summary: `${options.operation ?? 'request'} · ${options.status}`,
    mode: 'scalar',
    text,
    total: 0,
    returned: 0,
    truncated: false,
    ...(options.handle === undefined ? {} : { handle: options.handle }),
    address: options.address ?? '/',
    bytes: utf8Bytes(text),
    ...(options.sourceBytes === undefined ? {} : { sourceBytes: options.sourceBytes }),
    ...(options.provenance === undefined ? {} : { provenance: options.provenance }),
  };
}

export function assembleEnvelope(input: AssembleInput): Envelope {
  const { body } = input;
  const hint = hintOf(input);

  return {
    summary: summaryOf(input),
    mode: input.mode,
    ...(body.kind === 'rows' ? { fields: body.fields, rows: body.rows } : { text: body.text }),
    total: body.total,
    returned: body.returned,
    truncated: body.truncated,
    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    ...(input.handle === undefined ? {} : { handle: input.handle }),
    address: input.address === '' ? '/' : input.address,
    bytes: bodyBytes(body),
    ...(input.sourceBytes === undefined ? {} : { sourceBytes: input.sourceBytes }),
    ...(hint === undefined ? {} : { hint }),
    ...(input.provenance === undefined ? {} : { provenance: input.provenance }),
  };
}
