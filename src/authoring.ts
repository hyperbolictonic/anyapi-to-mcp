// The authoring verbs: `import` and `learn`.
//
// These are the two ways a map comes into existence without hand-writing JSON.
// They are CLI verbs and library functions, but deliberately *not* MCP tools:
// authoring is a human decision about what an agent may later reach, and a tool
// an agent can call to widen its own surface is the wrong shape.

import path from 'node:path';

import type { WorkspaceDescriptor } from './workspace.ts';
import type { MapDocument } from './map/types.ts';
import { writeMap } from './map/write.ts';
import { readApiDocument } from './import/file.ts';
import { importOpenApi } from './import/openapi.ts';
import type { ImportReport } from './import/openapi.ts';
import { learnFromSample } from './learn.ts';
import type { LearnReport } from './learn.ts';
import type { PayloadStore } from './store/store.ts';
import type { AuditSink, FetchLike } from './runtime/execute.ts';
import type { Lookup, OutboundPolicy } from './runtime/policy.ts';
import type { BindingTable, SecretProvider } from './runtime/secrets.ts';
import { readBindings } from './runtime/secrets.ts';

export type AuthoringResult = {
  readonly text: string;
  readonly data?: unknown;
  readonly isError?: boolean;
};

export type AuthoringContext = {
  readonly workspace: WorkspaceDescriptor;
  readonly store: PayloadStore;
  readonly out?: string;
  readonly force?: boolean;
  readonly dryRun?: boolean;
};

export type ImportVerbOptions = {
  readonly id?: string;
  readonly title?: string;
  readonly baseUrl?: string;
  readonly today?: string;
};

export type LearnVerbOptions = {
  readonly id?: string;
  readonly title?: string;
  readonly secret?: string;
  readonly today?: string;
  readonly fetch?: FetchLike;
  readonly secrets?: SecretProvider;
  readonly bindings?: BindingTable;
  readonly policy?: Partial<OutboundPolicy>;
  readonly audit?: AuditSink;
  readonly lookup?: Lookup;
  readonly now?: () => number;
};

function failure(code: string, message: string, hint?: string, details?: readonly string[]): AuthoringResult {
  const text = [message, hint, ...(details ?? []).map((detail) => `  - ${detail}`)].filter(Boolean).join('\n');
  return {
    text,
    isError: true,
    data: { error: code, message, ...(hint === undefined ? {} : { hint }), ...(details === undefined ? {} : { details }) },
  };
}

/** The one place a generated map may be written: an explicit --out, or the
 * workspace's single writable map location. */
export function targetFor(id: string, context: AuthoringContext): string | undefined {
  if (context.out !== undefined) return path.resolve(context.out);

  const writable = context.workspace.maps.find((location) => location.writable === true);
  if (writable === undefined) return undefined;

  return writable.path.toLowerCase().endsWith('.json') ? writable.path : path.join(writable.path, `${id}.json`);
}

function linesForReport(report: ImportReport, wrote: string | undefined, dryRun: boolean): string[] {
  const { stats, map } = report;
  const host = new URL(map.baseUrl).hostname;

  return [
    `imported ${map.id} — ${stats.resources} resource${stats.resources === 1 ? '' : 's'}, ${stats.operations} operation${stats.operations === 1 ? '' : 's'}, ${stats.links} link${stats.links === 1 ? '' : 's'}`,
    `  base: ${map.baseUrl}`,
    ...(wrote === undefined ? ['  not written: no writable map location; pass --out <file>'] : [`  ${dryRun ? 'would write' : 'wrote'}: ${wrote}`]),
    ...(report.secrets.length === 0
      ? []
      : [`  secrets to bind: ${report.secrets.join(', ')} (host ${host}) — a human writes the binding`]),
    ...(report.issues.length === 0
      ? []
      : ['  notes:', ...report.issues.slice(0, 12).map((issue) => `    - ${issue.path}: ${issue.message}`)]),
  ];
}

export async function importCommand(source: string, options: ImportVerbOptions, context: AuthoringContext): Promise<AuthoringResult> {
  const read = await readApiDocument(source);
  if (!read.ok) return failure(read.error.code, read.error.message, read.error.hint);

  const imported = importOpenApi(read.value.document, options);
  if (!imported.ok) return failure(imported.error.code, imported.error.message, imported.error.hint);

  const report = imported.value;
  const target = targetFor(report.map.id, context);

  if (target === undefined) {
    return {
      text: [
        `imported ${report.map.id} — ${report.stats.resources} resources, ${report.stats.operations} operations, ${report.stats.links} links`,
        'no writable map location; printing the map to stdout instead (pass --out <file> to write it)',
        JSON.stringify(report.map, null, 2),
      ].join('\n'),
      data: { ...report, written: false },
    };
  }

  const written = await writeMap(report.map, {
    file: target,
    ...(context.force === undefined ? {} : { force: context.force }),
    ...(context.dryRun === undefined ? {} : { dryRun: context.dryRun }),
  });

  if (!written.ok) {
    return failure(written.error.code, written.error.message, written.error.hint, written.error.details);
  }

  return {
    text: linesForReport(report, written.value.path, context.dryRun === true).join('\n'),
    data: { ...report, map: report.map, written: written.value },
  };
}

function learnLines(report: LearnReport, wrote: string | undefined, dryRun: boolean): string[] {
  const operation = report.map.operations[0];
  const { sample } = report;

  return [
    `learned ${report.map.id} — ${sample.status}, ${sample.items === null ? 'one record' : `${sample.items} item${sample.items === 1 ? '' : 's'}`}, ${sample.bytes} bytes, handle ${report.handle}`,
    `  operation: ${operation?.id ?? '(none)'}`,
    `  view: ${operation?.view?.select ?? '/'} mode=${operation?.view?.mode ?? 'auto'}${operation?.view?.fields === undefined ? '' : ` fields=${operation.view.fields.join(',')}`}`,
    ...(wrote === undefined ? ['  not written: pass --out <file> to keep this map'] : [`  ${dryRun ? 'would write' : 'wrote'}: ${wrote}`]),
    ...(report.issues.length === 0 ? [] : ['  notes:', ...report.issues.map((issue) => `    - ${issue.path}: ${issue.message}`)]),
  ];
}

export async function learnCommand(url: string, options: LearnVerbOptions, context: AuthoringContext): Promise<AuthoringResult> {
  let bindings = options.bindings;
  if (bindings === undefined && context.workspace.secrets !== undefined) {
    const read = await readBindings(context.workspace.secrets.path);
    // A missing bindings file only matters when the sample needs a secret; the
    // runtime produces the actionable error in that case.
    bindings = read.ok ? read.value : undefined;
  }

  const learned = await learnFromSample({
    url,
    store: context.store,
    ...(options.id === undefined ? {} : { id: options.id }),
    ...(options.title === undefined ? {} : { title: options.title }),
    ...(options.secret === undefined ? {} : { secret: options.secret }),
    ...(options.today === undefined ? {} : { today: options.today }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.secrets === undefined ? {} : { secrets: options.secrets }),
    ...(bindings === undefined ? {} : { bindings }),
    ...(options.policy === undefined ? {} : { policy: options.policy }),
    ...(options.audit === undefined ? {} : { audit: options.audit }),
    ...(options.lookup === undefined ? {} : { lookup: options.lookup }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  if (!learned.ok) return failure(learned.error.code, learned.error.message, learned.error.hint);

  const report = learned.value;
  const target = targetFor(report.map.id, context);

  if (target === undefined) {
    return {
      text: [
        ...learnLines(report, undefined, context.dryRun === true),
        'no writable map location; printing the proposed map to stdout instead (pass --out <file> to write it)',
        JSON.stringify(report.map, null, 2),
      ].join('\n'),
      data: { ...report, written: false },
    };
  }

  const written = await writeMap(report.map, {
    file: target,
    ...(context.force === undefined ? {} : { force: context.force }),
    ...(context.dryRun === undefined ? {} : { dryRun: context.dryRun }),
  });

  if (!written.ok) {
    return failure(written.error.code, written.error.message, written.error.hint, written.error.details);
  }

  return {
    text: learnLines(report, written.value.path, context.dryRun === true).join('\n'),
    data: { ...report, written: written.value },
  };
}
