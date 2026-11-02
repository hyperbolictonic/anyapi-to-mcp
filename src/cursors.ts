// Cursors: the opaque end of a paginated read.
//
// The envelope field is published as a short opaque value, so this module is the
// only place that knows what it means: `{ operation, url }`, written beside the
// payload cache. A cursor carries no headers and no credential — just the page
// that comes next, resolved again under the normal outbound policy when it is
// used.
//
// Like handles, cursors are cache: they expire, and losing one costs a refetch.

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Result } from './view/result.ts';
import { err, ok } from './view/result.ts';

export const CURSOR_SCHEMA_VERSION = 1;

export type CursorRecord = {
  readonly id: string;
  readonly operation: string;
  readonly url: string;
  readonly createdAt: string;
  readonly expiresAt?: string;
};

export type CursorDraft = {
  readonly operation: string;
  readonly url: string;
};

export type CursorError = {
  readonly code: 'cursor_invalid' | 'cursor_not_found' | 'cursor_expired';
  readonly message: string;
  readonly hint?: string;
};

export type CursorStore = {
  put(draft: CursorDraft): Promise<Result<CursorRecord, CursorError>>;
  get(id: string): Promise<Result<CursorRecord, CursorError>>;
  /** Remove cursors past their expiry. */
  prune(): Promise<number>;
};

export type CursorStoreOptions = {
  readonly now?: () => Date;
  readonly ttlSeconds?: number;
};

/** `c_` + 16 hex over operation and URL: the same next page has one id. */
export function cursorFor(draft: CursorDraft): string {
  const seed = `${draft.operation}\n${draft.url}`;
  return `c_${createHash('sha256').update(seed, 'utf8').digest('hex').slice(0, 16)}`;
}

export function isCursor(value: string): boolean {
  return /^c_[0-9a-f]{16}$/.test(value);
}

function invalid(value: string): CursorError {
  return { code: 'cursor_invalid', message: `'${value}' is not a cursor`, hint: 'cursors look like c_0123456789abcdef' };
}

function expired(record: CursorRecord): CursorError {
  return {
    code: 'cursor_expired',
    message: `cursor ${record.id} expired at ${record.expiresAt}`,
    hint: record.operation === '' ? 'run the operation again' : `run ${record.operation} again to get a fresh cursor`,
  };
}

function recordFor(draft: CursorDraft, now: Date, ttlSeconds?: number): CursorRecord {
  return {
    id: cursorFor(draft),
    operation: draft.operation,
    url: draft.url,
    createdAt: now.toISOString(),
    ...(ttlSeconds === undefined ? {} : { expiresAt: new Date(now.getTime() + ttlSeconds * 1000).toISOString() }),
  };
}

function isExpired(record: CursorRecord, now: Date): boolean {
  return record.expiresAt !== undefined && Date.parse(record.expiresAt) <= now.getTime();
}

export class MemoryCursorStore implements CursorStore {
  private readonly records = new Map<string, CursorRecord>();
  private readonly options: CursorStoreOptions;

  constructor(options: CursorStoreOptions = {}) {
    this.options = options;
  }

  async put(draft: CursorDraft): Promise<Result<CursorRecord, CursorError>> {
    const record = recordFor(draft, this.options.now?.() ?? new Date(), this.options.ttlSeconds);
    this.records.set(record.id, record);
    return ok(record);
  }

  async get(id: string): Promise<Result<CursorRecord, CursorError>> {
    if (!isCursor(id)) return err(invalid(id));

    const record = this.records.get(id);
    if (record === undefined) {
      return err({ code: 'cursor_not_found', message: `unknown cursor ${id}`, hint: 'run the operation again to get a fresh cursor' });
    }

    if (isExpired(record, this.options.now?.() ?? new Date())) return err(expired(record));
    return ok(record);
  }

  async prune(): Promise<number> {
    const now = this.options.now?.() ?? new Date();
    let removed = 0;
    for (const [id, record] of this.records) {
      if (isExpired(record, now)) {
        this.records.delete(id);
        removed += 1;
      }
    }
    return removed;
  }
}

/** File-backed cursors: a directory of `<id>.json`, written atomically. */
export class FileCursorStore implements CursorStore {
  private readonly directory: string;
  private readonly options: CursorStoreOptions;

  constructor(directory: string, options: CursorStoreOptions = {}) {
    this.directory = directory;
    this.options = options;
  }

  private fileFor(id: string): string {
    if (!isCursor(id)) throw new Error(`not a cursor: ${id}`);
    return path.join(this.directory, `${id}.json`);
  }

  async put(draft: CursorDraft): Promise<Result<CursorRecord, CursorError>> {
    const record = recordFor(draft, this.options.now?.() ?? new Date(), this.options.ttlSeconds);

    await mkdir(this.directory, { recursive: true });
    const target = this.fileFor(record.id);
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify({ schemaVersion: CURSOR_SCHEMA_VERSION, ...record }), 'utf8');

    try {
      await rename(temporary, target);
    } catch {
      await unlink(target).catch(() => undefined);
      await rename(temporary, target);
    }

    return ok(record);
  }

  async get(id: string): Promise<Result<CursorRecord, CursorError>> {
    if (!isCursor(id)) return err(invalid(id));

    let record: CursorRecord;
    try {
      const parsed = JSON.parse(await readFile(this.fileFor(id), 'utf8')) as Partial<CursorRecord>;
      if (typeof parsed.operation !== 'string' || typeof parsed.url !== 'string' || typeof parsed.createdAt !== 'string') {
        return err({ code: 'cursor_invalid', message: `cursor file ${id} is not a cursor record`, hint: 'run the operation again' });
      }
      record = {
        id,
        operation: parsed.operation,
        url: parsed.url,
        createdAt: parsed.createdAt,
        ...(typeof parsed.expiresAt === 'string' ? { expiresAt: parsed.expiresAt } : {}),
      };
    } catch {
      return err({ code: 'cursor_not_found', message: `unknown cursor ${id}`, hint: 'run the operation again to get a fresh cursor' });
    }

    if (isExpired(record, this.options.now?.() ?? new Date())) return err(expired(record));
    return ok(record);
  }

  async prune(): Promise<number> {
    const now = this.options.now?.() ?? new Date();
    const entries = await readdir(this.directory).catch(() => [] as string[]);
    let removed = 0;

    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const id = entry.slice(0, -5);
      if (!isCursor(id)) continue;

      const record = await this.get(id);
      if (!record.ok) {
        if (record.error.code === 'cursor_expired') {
          await unlink(path.join(this.directory, entry)).catch(() => undefined);
          removed += 1;
        }
        continue;
      }
      if (isExpired(record.value, now)) {
        await unlink(path.join(this.directory, entry)).catch(() => undefined);
        removed += 1;
      }
    }

    return removed;
  }
}
