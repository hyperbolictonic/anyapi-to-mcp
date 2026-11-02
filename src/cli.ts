// The CLI: the same five verbs, from a shell.
//
// It prints exactly what the MCP server returns, so a human reading a terminal
// sees the same addresses an agent sees in a transcript. `--json` switches to
// the structured data for scripting.

import { existsSync } from 'node:fs';
import path from 'node:path';

import { createClient } from './client.ts';
import type { Client, ClientOptions } from './client.ts';
import type { FetchLike } from './runtime/execute.ts';
import { envSecrets } from './runtime/secrets.ts';
import { defaultWorkspace, readWorkspaceFile, WRITES_MODES } from './workspace.ts';
import type { WorkspaceDescriptor } from './workspace.ts';
import { createMcpServer } from './mcp/server.ts';
import { importCommand, learnCommand } from './authoring.ts';
import type { AuthoringResult } from './authoring.ts';
import type { Mode } from './view/types.ts';

export type Command =
  | { readonly kind: 'ls'; readonly path: string; readonly json: boolean }
  | { readonly kind: 'find'; readonly query: string; readonly limit: number; readonly json: boolean }
  | { readonly kind: 'describe'; readonly operation: string; readonly json: boolean }
  | {
      readonly kind: 'run';
      readonly operation: string;
      readonly args: Readonly<Record<string, string>>;
      readonly view?: string;
      readonly dryRun: boolean;
      readonly confirm: boolean;
      readonly cursor?: string;
      readonly maxItems?: number;
      readonly json: boolean;
    }
  | { readonly kind: 'read'; readonly handle: string; readonly address: string; readonly maxItems?: number; readonly json: boolean }
  | {
      readonly kind: 'import';
      readonly source: string;
      readonly id?: string;
      readonly title?: string;
      readonly baseUrl?: string;
      readonly out?: string;
      readonly force: boolean;
      readonly dryRun: boolean;
      readonly json: boolean;
    }
  | {
      readonly kind: 'learn';
      readonly url: string;
      readonly id?: string;
      readonly title?: string;
      readonly secret?: string;
      readonly out?: string;
      readonly force: boolean;
      readonly dryRun: boolean;
      readonly json: boolean;
    }
  | {
      readonly kind: 'pin';
      readonly name: string;
      readonly operation: string;
      readonly args: Readonly<Record<string, string>>;
      readonly address?: string;
      readonly fields?: readonly string[];
      readonly mode?: string;
      readonly view?: string;
      readonly note?: string;
      readonly ttlSeconds?: number;
      readonly ephemeral: boolean;
      readonly dryRun: boolean;
      readonly json: boolean;
    }
  | { readonly kind: 'unpin'; readonly name: string; readonly json: boolean }
  | { readonly kind: 'prune'; readonly apply: boolean; readonly json: boolean }
  | { readonly kind: 'serve' }
  | { readonly kind: 'help' }
  | { readonly kind: 'version' }
  | { readonly kind: 'error'; readonly message: string };

const USAGE = `wrap2mcp — turn any API into a navigable surface

Usage:
  wrap2mcp ls [path]                      list maps, resources or operations
  wrap2mcp find <words>                   search operations
  wrap2mcp describe <operation>           show inputs, view and links
  wrap2mcp run <operation> [key=value...] call it and get a handle
  wrap2mcp read <handle|@pin> [address]   drill into a stored payload or a pin
  wrap2mcp pin <name> <operation> [k=v...] save a query that re-resolves on read
  wrap2mcp unpin <name>                   delete a pin
  wrap2mcp prune [--apply]                remove pins that are provably dead
  wrap2mcp import openapi <file>          build a map from an OpenAPI 3 document
  wrap2mcp learn <url>                    learn a draft map from one live call
  wrap2mcp serve                          run the stdio MCP server

Flags:
  --workspace <file>   read a workspace descriptor instead of ./workspace.json
                       or the OS defaults
  --view <name>        named view for run, or for a pin
  --cursor <id>        run: continue a paginated read from a cursor
  --dry-run            build the request without sending it (or report a write)
  --max-items <n>      rows to show
  --out <file>         where import/learn writes the map
  --id <name>          map id for import/learn
  --title <text>       map title for import/learn
  --base-url <url>     base URL when a spec declares no usable server
  --secret <name>      binding name to send when learning from a URL
  --address <addr>     pin: address inside the response, e.g. /items[name='x']
  --fields <a,b>       pin: columns to keep
  --mode <mode>        pin: force a rendering mode
  --note <text>        pin: why this pin exists
  --ttl <seconds>      pin: expire after this many seconds
  --ephemeral          pin: eligible for pruning once expired
  --apply              prune: actually remove (without it, prune is a report)
  --confirm            run: send a write the workspace would only preview
  --writes <mode>      open | confirm | deny: override the workspace write mode
  --force              overwrite a map that contains human-owned entries
  --json               print the structured result instead of text
  -h, --help           this text
  -v, --version        version

Every result prints an address that pastes back into read. Nothing here talks
to an API until you ask it to: ls, find and describe are local.`;

const VALUE_FLAGS = new Set([
  '--workspace',
  '--view',
  '--cursor',
  '--max-items',
  '--limit',
  '--out',
  '--id',
  '--title',
  '--base-url',
  '--secret',
  '--address',
  '--fields',
  '--mode',
  '--note',
  '--ttl',
  '--writes',
]);

function splitFlag(token: string): { name: string; value?: string } {
  const eq = token.indexOf('=');
  if (eq === -1) return { name: token };
  return { name: token.slice(0, eq), value: token.slice(eq + 1) };
}

export function parseArgs(argv: readonly string[]): Command {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith('-')) {
      positional.push(token);
      continue;
    }

    const { name, value } = splitFlag(token);
    if (VALUE_FLAGS.has(name)) {
      const next = value ?? argv[index + 1];
      if (next === undefined) return { kind: 'error', message: `${name} needs a value` };
      if (value === undefined) index += 1;
      flags.set(name, next);
      continue;
    }
    flags.set(name, value ?? true);
  }

  const json = flags.has('--json');
  if (flags.has('-h') || flags.has('--help')) return { kind: 'help' };
  if (flags.has('-v') || flags.has('--version')) return { kind: 'version' };

  const [verb, ...rest] = positional;

  switch (verb) {
    case undefined:
      return { kind: 'help' };

    case 'ls':
      return { kind: 'ls', path: rest[0] ?? '/', json };

    case 'find': {
      const query = rest.join(' ').trim();
      if (query === '') return { kind: 'error', message: 'find needs something to look for' };
      const limit = Number(flags.get('--limit') ?? 8);
      return { kind: 'find', query, limit: Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 8, json };
    }

    case 'describe':
      if (rest[0] === undefined) return { kind: 'error', message: 'describe needs an operation id' };
      return { kind: 'describe', operation: rest[0], json };

    case 'run': {
      const [operation, ...pairs] = rest;
      if (operation === undefined) return { kind: 'error', message: 'run needs an operation id' };

      const args: Record<string, string> = {};
      for (const pair of pairs) {
        const eq = pair.indexOf('=');
        if (eq === -1) return { kind: 'error', message: `argument '${pair}' must be key=value` };
        args[pair.slice(0, eq)] = pair.slice(eq + 1);
      }

      const view = flags.get('--view');
      const cursor = flags.get('--cursor');
      const maxItems = Number(flags.get('--max-items'));

      return {
        kind: 'run',
        operation,
        args,
        ...(typeof view === 'string' ? { view } : {}),
        dryRun: flags.has('--dry-run'),
        confirm: flags.has('--confirm'),
        ...(typeof cursor === 'string' ? { cursor } : {}),
        ...(Number.isFinite(maxItems) && maxItems > 0 ? { maxItems: Math.floor(maxItems) } : {}),
        json,
      };
    }

    case 'read': {
      const [handle, address] = rest;
      if (handle === undefined) return { kind: 'error', message: 'read needs a handle, e.g. read r_0123456789abcdef /items/0' };
      const maxItems = Number(flags.get('--max-items'));
      return {
        kind: 'read',
        handle,
        address: address ?? '/',
        ...(Number.isFinite(maxItems) && maxItems > 0 ? { maxItems: Math.floor(maxItems) } : {}),
        json,
      };
    }

    case 'pin': {
      const [name, operation, ...pairs] = rest;
      if (name === undefined) return { kind: 'error', message: 'pin needs a name, e.g. pin starforge items.overview league=Standard' };
      if (operation === undefined) return { kind: 'error', message: `pin ${name} needs an operation id` };

      const args: Record<string, string> = {};
      for (const pair of pairs) {
        const eq = pair.indexOf('=');
        if (eq === -1) return { kind: 'error', message: `argument '${pair}' must be key=value` };
        args[pair.slice(0, eq)] = pair.slice(eq + 1);
      }

      const address = flags.get('--address');
      const fields = flags.get('--fields');
      const mode = flags.get('--mode');
      const view = flags.get('--view');
      const note = flags.get('--note');
      const ttl = Number(flags.get('--ttl'));

      return {
        kind: 'pin',
        name,
        operation,
        args,
        ...(typeof address === 'string' ? { address } : {}),
        ...(typeof fields === 'string'
          ? { fields: fields.split(',').map((field) => field.trim()).filter((field) => field !== '') }
          : {}),
        ...(typeof mode === 'string' ? { mode } : {}),
        ...(typeof view === 'string' ? { view } : {}),
        ...(typeof note === 'string' ? { note } : {}),
        ...(flags.has('--ttl') && Number.isFinite(ttl) && ttl > 0 ? { ttlSeconds: ttl } : {}),
        ephemeral: flags.has('--ephemeral'),
        dryRun: flags.has('--dry-run'),
        json,
      };
    }

    case 'unpin': {
      const name = rest[0];
      if (name === undefined) return { kind: 'error', message: 'unpin needs a pin name' };
      return { kind: 'unpin', name, json };
    }

    case 'prune':
      return { kind: 'prune', apply: flags.has('--apply'), json };

    case 'import': {
      const [subject, source] = rest;
      if (subject === undefined) return { kind: 'error', message: 'import needs a document, e.g. import openapi ./api.yaml' };
      const file = subject === 'openapi' ? source : subject;
      if (file === undefined) return { kind: 'error', message: 'import openapi needs a file' };

      const id = flags.get('--id');
      const title = flags.get('--title');
      const baseUrl = flags.get('--base-url');
      const out = flags.get('--out');

      return {
        kind: 'import',
        source: file,
        ...(typeof id === 'string' ? { id } : {}),
        ...(typeof title === 'string' ? { title } : {}),
        ...(typeof baseUrl === 'string' ? { baseUrl } : {}),
        ...(typeof out === 'string' ? { out } : {}),
        force: flags.has('--force'),
        dryRun: flags.has('--dry-run'),
        json,
      };
    }

    case 'learn': {
      const url = rest[0];
      if (url === undefined) return { kind: 'error', message: 'learn needs a URL, e.g. learn https://api.example.com/products' };

      const id = flags.get('--id');
      const title = flags.get('--title');
      const secret = flags.get('--secret');
      const out = flags.get('--out');

      return {
        kind: 'learn',
        url,
        ...(typeof id === 'string' ? { id } : {}),
        ...(typeof title === 'string' ? { title } : {}),
        ...(typeof secret === 'string' ? { secret } : {}),
        ...(typeof out === 'string' ? { out } : {}),
        force: flags.has('--force'),
        dryRun: flags.has('--dry-run'),
        json,
      };
    }

    case 'serve':
      return { kind: 'serve' };

    default:
      return { kind: 'error', message: `unknown command '${verb}'. Run wrap2mcp --help` };
  }
}

export type MainDeps = {
  readonly write?: (text: string) => void;
  readonly writeError?: (text: string) => void;
  readonly client?: Client;
  /** Override workspace resolution; authoring verbs need it without a client. */
  readonly workspace?: WorkspaceDescriptor;
  /** Injected transport, mainly so tests never touch the network. */
  readonly fetch?: FetchLike;
};

export async function main(argv: readonly string[], deps: MainDeps = {}): Promise<number> {
  const write = deps.write ?? ((text: string) => process.stdout.write(`${text}\n`));
  const writeError = deps.writeError ?? ((text: string) => process.stderr.write(`${text}\n`));
  const fetch = deps.fetch ?? (globalThis.fetch as FetchLike);
  const command = parseArgs(argv);

  if (command.kind === 'help') {
    write(USAGE);
    return 0;
  }
  if (command.kind === 'version') {
    write('0.1.0');
    return 0;
  }
  if (command.kind === 'error') {
    writeError(command.message);
    return 1;
  }

  const writesFlag = valueOf(argv, '--writes');
  const writesOverride = writesFlag === undefined ? undefined : WRITES_MODES.find((mode) => mode === writesFlag);
  if (writesFlag !== undefined && writesOverride === undefined) {
    writeError(`--writes must be one of ${WRITES_MODES.join(', ')}; got '${writesFlag}'`);
    return 1;
  }

  const authoring = command.kind === 'import' || command.kind === 'learn';

  let workspace = deps.workspace;
  if (workspace === undefined && (deps.client === undefined || authoring)) {
    try {
      workspace = await resolveWorkspace(valueOf(argv, '--workspace'));
    } catch (error) {
      writeError(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }

  const client =
    deps.client ??
    createClient({
      workspace: workspace!,
      fetch,
      secrets: envSecrets(),
      ...(writesOverride === undefined ? {} : { writes: { mode: writesOverride } }),
    });

  if (command.kind === 'serve') {
    const server = createMcpServer({ client });
    await server.start();
    return 0;
  }

  if (command.kind === 'import' || command.kind === 'learn') {
    const context = {
      workspace: workspace ?? client.workspace,
      store: client.store,
      ...(command.out === undefined ? {} : { out: command.out }),
      force: command.force,
      dryRun: command.dryRun,
    };

    const authored: AuthoringResult =
      command.kind === 'import'
        ? await importCommand(command.source, {
            ...(command.id === undefined ? {} : { id: command.id }),
            ...(command.title === undefined ? {} : { title: command.title }),
            ...(command.baseUrl === undefined ? {} : { baseUrl: command.baseUrl }),
          }, context)
        : await learnCommand(command.url, {
            ...(command.id === undefined ? {} : { id: command.id }),
            ...(command.title === undefined ? {} : { title: command.title }),
            ...(command.secret === undefined ? {} : { secret: command.secret }),
            fetch,
            secrets: envSecrets(),
          }, context);

    if (command.json) write(JSON.stringify(authored.data ?? authored.text, null, 2));
    else write(authored.text);

    return authored.isError === true ? 1 : 0;
  }

  if (command.kind === 'pin' || command.kind === 'unpin' || command.kind === 'prune') {
    const result =
      command.kind === 'pin'
        ? await client.pin(
            {
              name: command.name,
              operation: command.operation,
              args: command.args,
              ...(command.address === undefined ? {} : { address: command.address }),
              ...(command.fields === undefined ? {} : { fields: command.fields }),
              ...(command.mode === undefined ? {} : { mode: command.mode as Mode }),
              ...(command.view === undefined ? {} : { view: command.view }),
              ...(command.note === undefined ? {} : { note: command.note }),
              ...(command.ttlSeconds === undefined ? {} : { ttlSeconds: command.ttlSeconds }),
              ...(command.ephemeral ? { ephemeral: true } : {}),
            },
            command.dryRun ? { dryRun: true } : {},
          )
        : command.kind === 'unpin'
          ? await client.unpin(command.name)
          : await client.prune(command.apply ? { apply: true } : {});

    if (command.json) write(JSON.stringify(result.data ?? result.text, null, 2));
    else write(result.text);

    return result.isError === true ? 1 : 0;
  }

  const result =
    command.kind === 'ls'
      ? await client.ls(command.path)
      : command.kind === 'find'
        ? await client.find(command.query, command.limit)
        : command.kind === 'describe'
          ? await client.describe(command.operation)
          : command.kind === 'run'
            ? await client.run(command.operation, command.args, {
                ...(command.view === undefined ? {} : { view: command.view }),
                ...(command.dryRun ? { dryRun: true } : {}),
                ...(command.confirm ? { confirm: true } : {}),
                ...(command.cursor === undefined ? {} : { cursor: command.cursor }),
                ...(command.maxItems === undefined ? {} : { maxItems: command.maxItems }),
              })
            : await client.read(command.handle, command.address, command.maxItems === undefined ? {} : { maxItems: command.maxItems });

  if (command.json) write(JSON.stringify(result.data ?? result.text, null, 2));
  else write(result.text);

  return result.isError === true ? 1 : 0;
}

function valueOf(argv: readonly string[], flag: string): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === flag) return argv[index + 1];
    if (token.startsWith(`${flag}=`)) return token.slice(flag.length + 1);
  }
  return undefined;
}

/**
 * The CLI is the host here, so it is the CLI that picks paths: an explicit
 * --workspace, else a `workspace.json` in the current directory, else the OS
 * defaults. A descriptor that names no payload directory or pins file still gets
 * the default ones, because otherwise `run` and `read` could not talk to each
 * other across two invocations, and a pin would silently live in memory.
 */
async function resolveWorkspace(flag: string | undefined): Promise<WorkspaceDescriptor> {
  const candidate = flag ?? (existsSync(path.resolve('workspace.json')) ? path.resolve('workspace.json') : undefined);
  if (candidate === undefined) return defaultWorkspace();

  const read = await readWorkspaceFile(candidate);
  if (!read.ok) throw new Error(read.error.message);
  return withDefaults(read.value);
}

function withDefaults(workspace: WorkspaceDescriptor): WorkspaceDescriptor {
  const defaults = defaultWorkspace();
  return {
    ...workspace,
    ...(workspace.payloads === undefined && defaults.payloads !== undefined ? { payloads: defaults.payloads } : {}),
    ...(workspace.pins === undefined && defaults.pins !== undefined ? { pins: defaults.pins } : {}),
  };
}
