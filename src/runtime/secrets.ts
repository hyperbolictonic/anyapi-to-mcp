// Secrets.
//
// Two separate things, deliberately:
//
//   - a **provider** supplies a value for a name;
//   - a **binding** says which host that value may be sent to.
//
// Bindings are human-authored files. This module can read them and there is
// deliberately no API to write one: a human binds a secret to a host, never an
// agent and never a tool call. A map may reference a name only, and the runtime
// refuses to send a secret to any host its binding does not name.

import { readFile } from 'node:fs/promises';

import { isPlainObject } from '../view/types.ts';
import type { Result } from '../view/result.ts';
import { err, ok } from '../view/result.ts';

export interface SecretProvider {
  get(name: string): Promise<string | undefined>;
}

export type SecretBinding = {
  /** Exact host the value may be sent to. No wildcards, ever. */
  readonly host: string;
  /** Header to write it into. Lower-case. */
  readonly header: string;
  /** How to format the header value; `{value}` is replaced. */
  readonly format: string;
};

export type BindingTable = Readonly<Record<string, SecretBinding>>;

export type SecretError = {
  readonly code: 'bindings_not_found' | 'bindings_invalid' | 'secret_missing' | 'secret_host_mismatch';
  readonly message: string;
  readonly hint?: string;
};

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;

/** Read a secret from the environment. The simplest standalone provider, and
 * the one that never writes anything to disk. */
export function envSecrets(env: Readonly<Record<string, string | undefined>> = process.env): SecretProvider {
  return {
    async get(name: string): Promise<string | undefined> {
      return env[name];
    },
  };
}

/** A provider over a fixed table: handy for embedding and for tests. */
export function staticSecrets(values: Readonly<Record<string, string>>): SecretProvider {
  return {
    async get(name: string): Promise<string | undefined> {
      return values[name];
    },
  };
}

export function validateBindings(input: unknown): { table: BindingTable; issues: string[] } {
  const issues: string[] = [];
  const table: Record<string, SecretBinding> = {};

  const raw = isPlainObject(input) && isPlainObject(input['secrets']) ? input['secrets'] : input;
  if (!isPlainObject(raw)) {
    return { table, issues: ['bindings must be an object of name -> { host, header, format }'] };
  }

  for (const [name, value] of Object.entries(raw)) {
    if (name === 'schemaVersion') continue;

    if (!NAME.test(name)) {
      issues.push(`${name}: a binding name must look like an environment variable`);
      continue;
    }
    if (!isPlainObject(value)) {
      issues.push(`${name}: must be an object`);
      continue;
    }

    const host = typeof value['host'] === 'string' ? value['host'].toLowerCase() : '';
    if (!HOST.test(host)) {
      issues.push(`${name}.host: must be a bare hostname such as api.github.com`);
      continue;
    }

    const header = typeof value['header'] === 'string' ? value['header'].toLowerCase() : 'authorization';
    if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(header)) {
      issues.push(`${name}.header: not a valid header name`);
      continue;
    }

    const format = typeof value['format'] === 'string' ? value['format'] : '{value}';
    if (!format.includes('{value}')) {
      issues.push(`${name}.format: must contain {value}`);
      continue;
    }

    table[name] = { host, header, format };
  }

  return { table, issues };
}

/** Read the human-authored bindings file. Never writes it. */
export async function readBindings(file: string): Promise<Result<BindingTable, SecretError>> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return err({
      code: 'bindings_not_found',
      message: `no secret bindings at ${file}`,
      hint: 'create it by hand: { "GITHUB_TOKEN": { "host": "api.github.com" } }',
    });
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (error) {
    return err({ code: 'bindings_invalid', message: `bindings file is not valid JSON: ${String(error)}` });
  }

  const { table, issues } = validateBindings(raw);
  if (issues.length > 0) return err({ code: 'bindings_invalid', message: issues.join('; ') });

  return ok(table);
}

/** Refuse a secret for any host its binding does not name exactly. */
export function checkSecretHost(name: string, binding: SecretBinding, host: string): Result<void, SecretError> {
  if (binding.host !== host.toLowerCase()) {
    return err({
      code: 'secret_host_mismatch',
      message: `secret ${name} is bound to ${binding.host} and cannot be sent to ${host}`,
      hint: 'binding is a human action: edit the bindings file deliberately, do not route around it',
    });
  }
  return ok(undefined);
}
