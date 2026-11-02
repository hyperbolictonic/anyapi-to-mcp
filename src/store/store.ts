// The payload store.
//
// A handle is content-addressed: `r_` + 16 hex of sha256 over the payload. The
// handle *is* the version, so unchanged data reuses it and appends a fetch
// record, changed data yields a new handle, and identical payloads dedupe for
// free. 64 bits because a collision here would serve the wrong data, unlike a
// random id.
//
// Payloads are cache, never user data. Losing a handle costs a refetch and
// nothing else; anything worth keeping is a pin.

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Result } from '../view/result.ts';
import { err, ok } from '../view/result.ts';

export type StoreError = {
  readonly code: 'handle_not_found' | 'handle_expired' | 'handle_invalid' | 'store_error';
  readonly message: string;
  readonly hint?: string;
};

export type PayloadMeta = {
  readonly operation?: string;
  readonly view?: string | null;
  readonly url?: string;
  readonly host?: string;
  readonly status?: number;
  readonly bytes: number;
  readonly createdAt: string;
  readonly expiresAt?: string;
  /** How many times this exact payload has been produced or read. */
  readonly fetches: number;
  readonly derivedFrom?: string;
  readonly kind?: 'response' | 'join' | 'pin';
};

export type StoredPayload = {
  readonly handle: string;
  readonly payload: unknown;
  readonly meta: PayloadMeta;
};

export type PutOptions = {
  readonly operation?: string;
  readonly view?: string | null;
  readonly url?: string;
  readonly host?: string;
  readonly status?: number;
  readonly derivedFrom?: string;
  readonly kind?: 'response' | 'join' | 'pin';
  /** Lifetime in seconds; omitted means the store default. */
  readonly ttlSeconds?: number;
};

export type PayloadStore = {
  put(payload: unknown, options?: PutOptions): Promise<StoredPayload>;
  get(handle: string): Promise<Result<StoredPayload, StoreError>>;
  /** Remove handles past their expiry. Durable data is never pruned. */
  prune(): Promise<number>;
};

/**
 * Deterministic JSON: keys are sorted so that the same data always hashes the
 * same, however it was serialised on the way in.
 */
export function stableStringify(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

export function bytesOf(value: unknown): number {
  return new TextEncoder().encode(typeof value === 'string' ? value : stableStringify(value)).length;
}

/** `r_` + 16 hex of sha256 over the payload. */
export function handleFor(payload: unknown): string {
  return `r_${createHash('sha256').update(stableStringify(payload)).digest('hex').slice(0, 16)}`;
}

export function isHandle(value: string): boolean {
  return /^r_[0-9a-f]{16}$/.test(value);
}

function isoAt(now: Date, offsetSeconds?: number): string {
  return new Date(now.getTime() + (offsetSeconds ?? 0) * 1000).toISOString();
}

export type StoreOptions = {
  readonly now?: () => Date;
  /** Default lifetime for handles that do not specify one. */
  readonly ttlSeconds?: number;
  /** Soft cap for a file store: beyond it, the oldest records are evicted. */
  readonly maxBytes?: number;
};

function buildMeta(payload: unknown, options: PutOptions, store: StoreOptions, now: Date, fetches: number): PayloadMeta {
  const ttl = options.ttlSeconds ?? store.ttlSeconds;
  return {
    ...(options.operation === undefined ? {} : { operation: options.operation }),
    ...(options.view === undefined ? {} : { view: options.view }),
    ...(options.url === undefined ? {} : { url: options.url }),
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(options.status === undefined ? {} : { status: options.status }),
    bytes: bytesOf(payload),
    createdAt: now.toISOString(),
    ...(ttl === undefined ? {} : { expiresAt: isoAt(now, ttl) }),
    fetches,
    ...(options.derivedFrom === undefined ? {} : { derivedFrom: options.derivedFrom }),
    ...(options.kind === undefined ? {} : { kind: options.kind }),
  };
}

/** In-memory store: tests, embedding, and anything that should touch no disk. */
export class MemoryStore implements PayloadStore {
  private readonly records = new Map<string, StoredPayload>();
  private readonly options: StoreOptions;

  constructor(options: StoreOptions = {}) {
    this.options = options;
  }

  async put(payload: unknown, put: PutOptions = {}): Promise<StoredPayload> {
    const now = this.options.now?.() ?? new Date();
    const handle = handleFor(payload);
    const existing = this.records.get(handle);

    const record: StoredPayload = {
      handle,
      payload,
      meta: buildMeta(payload, put, this.options, now, (existing?.meta.fetches ?? 0) + 1),
    };

    this.records.set(handle, record);
    return record;
  }

  async get(handle: string): Promise<Result<StoredPayload, StoreError>> {
    const record = this.records.get(handle);
    if (!record) return err({ code: 'handle_not_found', message: `unknown handle ${handle}`, hint: 'run an operation first, or read a pin' });

    const expired = record.meta.expiresAt !== undefined && Date.parse(record.meta.expiresAt) <= (this.options.now?.() ?? new Date()).getTime();
    if (expired) {
      return err({
        code: 'handle_expired',
        message: `handle ${handle} expired at ${record.meta.expiresAt}`,
        hint: record.meta.operation ? `re-run ${record.meta.operation} to get a fresh handle` : 're-run the operation',
      });
    }

    return ok(record);
  }

  async prune(): Promise<number> {
    const now = (this.options.now?.() ?? new Date()).getTime();
    let removed = 0;
    for (const [handle, record] of this.records) {
      if (record.meta.expiresAt !== undefined && Date.parse(record.meta.expiresAt) <= now) {
        this.records.delete(handle);
        removed += 1;
      }
    }
    return removed;
  }
}

/** File-backed store: a directory of `<handle>.json`, written atomically. */
export class FileStore implements PayloadStore {
  private readonly directory: string;
  private readonly options: StoreOptions;

  constructor(directory: string, options: StoreOptions = {}) {
    this.directory = directory;
    this.options = options;
  }

  private fileFor(handle: string): string {
    if (!isHandle(handle)) throw new Error(`not a handle: ${handle}`);
    return path.join(this.directory, `${handle}.json`);
  }

  async put(payload: unknown, put: PutOptions = {}): Promise<StoredPayload> {
    const now = this.options.now?.() ?? new Date();
    const handle = handleFor(payload);

    let fetches = 1;
    const existing = await this.read(handle);
    if (existing !== null) fetches = existing.meta.fetches + 1;

    const record: StoredPayload = { handle, payload, meta: buildMeta(payload, put, this.options, now, fetches) };

    await mkdir(this.directory, { recursive: true });
    const target = this.fileFor(handle);
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, stableStringify(record), 'utf8');

    try {
      await rename(temporary, target);
    } catch {
      // Windows refuses to rename onto an existing file.
      await unlink(target).catch(() => undefined);
      await rename(temporary, target);
    }

    await this.evict(handle);

    return record;
  }

  /**
   * Keep the directory under `maxBytes` by removing the oldest records.
   *
   * The record just written is never evicted, even if it alone is over the cap:
   * a single large response should fail the size policy, not delete itself and
   * leave the caller with a handle that resolves to nothing.
   */
  private async evict(keep: string): Promise<void> {
    const cap = this.options.maxBytes;
    if (cap === undefined || cap <= 0) return;

    const entries = (await readdir(this.directory).catch(() => [] as string[])).filter((entry) => entry.endsWith('.json'));
    const files: { file: string; size: number; createdAt: string }[] = [];
    let total = 0;

    for (const entry of entries) {
      const file = path.join(this.directory, entry);
      const info = await stat(file).catch(() => null);
      if (info === null) continue;
      total += info.size;
      files.push({ file, size: info.size, createdAt: '' });
    }

    if (total <= cap) return;

    for (const entry of files) {
      const text = await readFile(entry.file, 'utf8').catch(() => '');
      try {
        const record = JSON.parse(text) as { meta?: { createdAt?: unknown } };
        if (typeof record.meta?.createdAt === 'string') entry.createdAt = record.meta.createdAt;
      } catch {
        // A file that does not parse is the best eviction candidate there is.
      }
    }

    const keepFile = path.join(this.directory, `${keep}.json`);
    files.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.file.localeCompare(b.file));

    for (const entry of files) {
      if (total <= cap) break;
      if (entry.file === keepFile) continue;
      await unlink(entry.file).catch(() => undefined);
      total -= entry.size;
    }
  }

  private async read(handle: string): Promise<StoredPayload | null> {
    try {
      const text = await readFile(this.fileFor(handle), 'utf8');
      return JSON.parse(text) as StoredPayload;
    } catch {
      return null;
    }
  }

  async get(handle: string): Promise<Result<StoredPayload, StoreError>> {
    if (!isHandle(handle)) {
      return err({ code: 'handle_invalid', message: `'${handle}' is not a handle`, hint: 'handles look like r_0123456789abcdef' });
    }

    const record = await this.read(handle);
    if (record === null) {
      return err({ code: 'handle_not_found', message: `unknown handle ${handle}`, hint: 'run an operation first, or read a pin' });
    }

    const now = (this.options.now?.() ?? new Date()).getTime();
    if (record.meta.expiresAt !== undefined && Date.parse(record.meta.expiresAt) <= now) {
      return err({
        code: 'handle_expired',
        message: `handle ${handle} expired at ${record.meta.expiresAt}`,
        hint: record.meta.operation ? `re-run ${record.meta.operation} to get a fresh handle` : 're-run the operation',
      });
    }

    return ok(record);
  }

  async prune(): Promise<number> {
    const now = (this.options.now?.() ?? new Date()).getTime();
    let removed = 0;

    const entries = await readdir(this.directory).catch(() => [] as string[]);
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const handle = entry.slice(0, -5);
      if (!isHandle(handle)) continue;

      const record = await this.read(handle);
      if (record === null) continue;
      if (record.meta.expiresAt !== undefined && Date.parse(record.meta.expiresAt) <= now) {
        await unlink(path.join(this.directory, entry)).catch(() => undefined);
        removed += 1;
      }
    }

    return removed;
  }
}
