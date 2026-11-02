// Writing a generated map, without losing a human's corrections.
//
// A generated map is disposable. A human edit is not. The two live in different
// files — the map and its overrides — and this writer refuses to clobber a map
// that already contains human-provenance operations or links unless the caller
// says so explicitly.
//
// Writes are atomic (temp file, then rename), because a CLI and a stdio MCP
// server can share one directory.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Result } from '../view/result.ts';
import { err, ok } from '../view/result.ts';
import type { MapDocument } from './types.ts';
import { validateMap } from './validate.ts';

export type WriteError = {
  readonly code: 'invalid_map' | 'human_provenance' | 'write_failed';
  readonly message: string;
  readonly hint?: string;
  readonly details?: readonly string[];
};

export type WriteOutcome = {
  readonly path: string;
  readonly wrote: boolean;
  readonly replaced: boolean;
  /** Human-owned entries that would be lost by writing, listed for the report. */
  readonly human: readonly string[];
};

export type WriteOptions = {
  /** Full path of the map file. */
  readonly file: string;
  readonly force?: boolean;
  /** Report what would happen, write nothing. */
  readonly dryRun?: boolean;
};

/** Operations, links and top-level provenance a human has touched. */
export function humanEntries(map: MapDocument): string[] {
  const entries: string[] = [];

  if (map.provenance?.source === 'human') entries.push('$.provenance');

  for (const operation of map.operations) {
    if (operation.provenance === 'human') entries.push(`operation ${operation.id}`);
  }
  for (const link of map.links ?? []) {
    if (link.provenance === 'human') entries.push(`link ${link.from}.${link.field} -> ${link.to}`);
  }
  for (const resource of map.resources) {
    // Resources carry no provenance of their own; a hand-written title is not
    // detectable, so it is not claimed either.
    void resource;
  }

  return entries;
}

async function existingEntries(file: string): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return [];
  }

  try {
    const existing = JSON.parse(text) as MapDocument;
    return Array.isArray(existing.operations) ? humanEntries(existing) : [];
  } catch {
    // Not JSON: treat the file as something we must not overwrite silently.
    return ['existing file is not a map'];
  }
}

export async function writeMap(map: MapDocument, options: WriteOptions): Promise<Result<WriteOutcome, WriteError>> {
  const validated = validateMap(map);
  const errors = validated.issues.filter((issue) => issue.severity === 'error');
  if (errors.length > 0) {
    return err({
      code: 'invalid_map',
      message: `refusing to write an invalid map (${errors.length} error${errors.length === 1 ? '' : 's'})`,
      hint: 'run with --json to see the import report',
      details: errors.slice(0, 8).map((issue) => `${issue.path}: ${issue.message}`),
    });
  }

  const human = await existingEntries(options.file);
  if (human.length > 0 && options.force !== true) {
    return err({
      code: 'human_provenance',
      message: `${options.file} contains ${human.length} human-owned entr${human.length === 1 ? 'y' : 'ies'}; not overwriting`,
      hint: 'move hand edits to the overrides file (they survive regeneration), or pass --force to overwrite deliberately',
      details: human,
    });
  }

  if (options.dryRun === true) {
    return ok({ path: options.file, wrote: false, replaced: human.length > 0, human });
  }

  try {
    await mkdir(path.dirname(options.file), { recursive: true });
    const temporary = `${options.file}.tmp-${process.pid}`;
    await writeFile(temporary, `${JSON.stringify(validated.map ?? map, null, 2)}\n`, 'utf8');
    await rename(temporary, options.file);
  } catch (error) {
    return err({
      code: 'write_failed',
      message: `cannot write ${options.file}: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  return ok({ path: options.file, wrote: true, replaced: human.length > 0, human });
}
