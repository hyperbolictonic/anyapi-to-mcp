// The projection engine entry point.
//
// Pipeline: parse address -> resolve -> choose mode -> project -> envelope.
// Every stage is a pure function, so the same payload and spec always produce
// the same envelope, byte for byte. That determinism is what makes `bytes` a
// comparable measurement and what lets a test assert on token cost.

import { resolveAddress } from './address.ts';
import type { Resolution } from './address.ts';
import { inferMode, normaliseMode, shapeOf } from './detect.ts';
import { assembleEnvelope } from './envelope.ts';
import type { Body } from './envelope.ts';
import type { ViewError } from './errors.ts';
import { viewError } from './errors.ts';
import { projectList, projectRows, unionFieldNames } from './project.ts';
import { renderHeadings, renderJsonl, renderOutline, renderScalar, renderTable, textScale } from './render.ts';
import type { Result } from './result.ts';
import { err, ok } from './result.ts';
import type { Envelope, Limits, Provenance, ResolvedMode, ViewSpec } from './types.ts';
import { DEFAULT_LIMITS } from './types.ts';

export type RenderContext = {
  /** Handle the payload was stored under; printed in hints, never invented. */
  readonly handle?: string;
  /** Size of the source payload, when known. */
  readonly sourceBytes?: number;
  readonly provenance?: Provenance;
  /** Extra hints appended after the computed ones. */
  readonly notes?: readonly string[];
};

const ARRAY_MODES: ReadonlySet<ResolvedMode> = new Set<ResolvedMode>(['rows', 'list', 'table', 'jsonl']);

const MODE_LIST = 'auto|rows|document|list|table|jsonl|shape|scalar';

function withLimits(spec: ViewSpec): Limits {
  const overrides = spec.limits ?? {};
  const clamp = (value: number | undefined, fallback: number, min: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value >= min ? Math.floor(value) : fallback;

  return {
    maxItems: clamp(overrides.maxItems, DEFAULT_LIMITS.maxItems, 1),
    maxDepth: clamp(overrides.maxDepth, DEFAULT_LIMITS.maxDepth, 1),
    // 0 means "no cap" on field length, which is meaningful, so the floor is 0.
    maxFieldChars: clamp(overrides.maxFieldChars, DEFAULT_LIMITS.maxFieldChars, 0),
    maxKeys: clamp(overrides.maxKeys, DEFAULT_LIMITS.maxKeys, 1),
  };
}

function buildBody(node: unknown, mode: ResolvedMode, spec: ViewSpec, address: string, limits: Limits): Body {
  switch (mode) {
    case 'rows':
      return { kind: 'rows', ...projectRows(node as readonly unknown[], spec.fields ?? [], limits) };

    case 'list':
      return { kind: 'rows', ...projectList(node as readonly unknown[], limits) };

    case 'table': {
      const columns = spec.fields && spec.fields.length > 0 ? spec.fields : unionFieldNames(node as readonly unknown[], limits.maxKeys).names;
      return { kind: 'text', ...renderTable(node as readonly unknown[], columns, limits) };
    }

    case 'jsonl':
      return { kind: 'text', ...renderJsonl(node as readonly unknown[], limits) };

    case 'document':
      return spec.style === 'headings'
        ? { kind: 'text', ...renderHeadings(node, address, limits, spec.titleField ?? null) }
        : { kind: 'text', ...renderOutline(node, address, limits) };

    case 'shape':
      return { kind: 'text', text: shapeOf(node, address, limits), total: 1, returned: 1, truncated: false };

    case 'scalar':
      return { kind: 'text', ...renderScalar(node) };
  }
}

/** Render a payload at an address into the result envelope. Never throws. */
export function renderView(payload: unknown, spec: ViewSpec = {}, context: RenderContext = {}): Result<Envelope, ViewError> {
  const requested = normaliseMode(spec.mode);
  if (requested === null) {
    return err(
      viewError('unknown_mode', `unknown mode '${String(spec.mode)}'`, {
        hint: `valid modes: ${MODE_LIST}`,
      }),
    );
  }

  const resolution = resolveAddress(payload, spec.select ?? '/', context.handle === undefined ? {} : { hintHandle: context.handle });
  if (!resolution.ok) return resolution;

  const { node, address, matched, baseNode } = resolution.value;
  const limits = withLimits(spec);
  const mode: ResolvedMode = requested === 'auto' ? inferMode(node) : requested;

  if (ARRAY_MODES.has(mode) && !Array.isArray(node)) {
    return err(
      viewError('mode_shape_mismatch', `mode '${mode}' needs an array at ${address}`, {
        address,
        hint: `got ${node === null ? 'null' : typeof node}; try mode document or shape`,
      }),
    );
  }

  const body = buildBody(node, mode, spec, address, limits);

  return ok(
    assembleEnvelope({
      body,
      mode,
      address,
      ...(context.handle === undefined ? {} : { handle: context.handle }),
      ...(context.sourceBytes === undefined ? {} : { sourceBytes: context.sourceBytes }),
      ...(context.provenance === undefined ? {} : { provenance: context.provenance }),
      ...(context.notes === undefined ? {} : { notes: context.notes }),
      ...(matched === null ? {} : { scanned: Array.isArray(baseNode) ? baseNode.length : matched }),
    }),
  );
}

/** Resolve an address for the `read` verb. The same function `run` uses, so a
 * printed address cannot mean one thing in one verb and another in the other. */
export function readAt(payload: unknown, address: string, options: { hintHandle?: string } = {}): Result<Resolution, ViewError> {
  return resolveAddress(payload, address, options);
}

/** The mode a payload would render as at an address, without rendering it. */
export function peekMode(payload: unknown, address = '/'): Result<ResolvedMode, ViewError> {
  const resolution = resolveAddress(payload, address);
  if (!resolution.ok) return resolution;
  return ok(inferMode(resolution.value.node));
}
