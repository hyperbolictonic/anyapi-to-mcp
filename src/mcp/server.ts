// A stdio MCP server over the five verbs plus the three pin tools.
//
// Transport: newline-delimited JSON-RPC 2.0 on stdin/stdout, which is what the
// MCP stdio transport is. No SDK dependency: the protocol surface we need is
// initialize, tools/list and tools/call, and a dependency-free implementation
// keeps `npx` honest.
//
// The server is thin on purpose. Every verb is a method on the client, so the
// MCP transcript and the CLI output come from the same code and print the same
// addresses.

import { createInterface } from 'node:readline';

import type { Client } from '../client.ts';
import type { PinDraft } from '../pins.ts';
import type { VerbResult } from '../verbs.ts';

export type JsonRpcId = string | number | null;

export type JsonRpcRequest = {
  readonly jsonrpc: '2.0';
  readonly id?: JsonRpcId;
  readonly method: string;
  readonly params?: unknown;
};

export type JsonRpcResponse = {
  readonly jsonrpc: '2.0';
  readonly id: JsonRpcId;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown };
};

const DEFAULT_PROTOCOL = '2025-06-18';
const KNOWN_PROTOCOLS = new Set(['2024-11-05', '2025-03-26', '2025-06-18']);

export const TOOLS = [
  {
    name: 'ls',
    description:
      'List what is available: no argument lists maps, /<map> lists its resources, /<map>/<resource> lists its operations, /pins lists saved pins. Bounded output.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Address to list. Default "/". Use "/pins" for saved queries.' } },
      additionalProperties: false,
    },
  },
  {
    name: 'find',
    description: 'Search operations by words. Use this when you know what you want but not which operation id.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to look for, e.g. "list issues".' },
        limit: { type: 'integer', minimum: 1, maximum: 40, description: 'Maximum matches. Default 8.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'describe',
    description: 'Show one operation: request, inputs with defaults, view, links and whether it mutates. Call this before run when unsure.',
    inputSchema: {
      type: 'object',
      properties: { operation: { type: 'string', description: 'Operation id, e.g. repo.issues.list.' } },
      required: ['operation'],
      additionalProperties: false,
    },
  },
  {
    name: 'run',
    description:
      'Call an operation. Returns a result envelope with a handle. Every envelope prints an address that can be passed to read; use dryRun to check the request first. An operation that changes data may be previewed instead of sent, depending on the workspace writes mode: the answer is then a write_not_confirmed error containing the exact method, URL and body, and repeating with confirm: true sends it.',
    inputSchema: {
      type: 'object',
      properties: {
        operation: { type: 'string' },
        args: { type: 'object', description: 'Inputs declared by describe.', additionalProperties: true },
        view: { type: 'string', description: 'Named view declared by the operation.' },
        cursor: { type: 'string', description: 'Continue a paginated read: the c_ value printed as "next page: cursor=...".' },
        dryRun: { type: 'boolean', description: 'Build and validate the request without sending it.' },
        confirm: { type: 'boolean', description: 'Send a write that the workspace would otherwise only preview.' },
        maxItems: { type: 'integer', minimum: 1, description: 'Rows to show.' },
      },
      required: ['operation'],
      additionalProperties: false,
    },
  },
  {
    name: 'read',
    description:
      'Drill into a stored payload by handle and JSON Pointer address, without refetching. Addresses may select by key: /lines[name=\'x\']. Pass a pin name with @ (read @starforge) to re-resolve that saved query.',
    inputSchema: {
      type: 'object',
      properties: {
        handle: { type: 'string', description: 'Handle from a previous run (r_0123456789abcdef) or a pin (@name).' },
        address: { type: 'string', description: 'JSON Pointer into the payload. Default "/". For a pin, an override address.' },
        maxItems: { type: 'integer', minimum: 1 },
      },
      required: ['handle'],
      additionalProperties: false,
    },
  },
  {
    name: 'pin',
    description:
      'Save a named query (operation + args + address) so it re-resolves in a later session with read @name. This is the only durable memory in the system; handles are cache. Pins may not name a mutating operation.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Lower-case pin name, e.g. starforge.' },
        operation: { type: 'string' },
        args: { type: 'object', description: 'Inputs declared by describe.', additionalProperties: true },
        address: { type: 'string', description: 'Address inside the response, e.g. /items[name=\'x\']. Default "/".' },
        fields: { type: 'array', items: { type: 'string' }, description: 'Columns to keep.' },
        view: { type: 'string', description: 'Named view declared by the operation.' },
        mode: { type: 'string', description: 'Force a rendering mode.' },
        note: { type: 'string', description: 'Why this pin exists.' },
        ephemeral: { type: 'boolean', description: 'Eligible for pruning once expired.' },
        ttlSeconds: { type: 'integer', minimum: 1, description: 'Expire after this many seconds.' },
      },
      required: ['name', 'operation'],
      additionalProperties: false,
    },
  },
  {
    name: 'unpin',
    description: 'Delete a pin by name. Deletion is explicit; a failing pin is marked, not removed.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'prune',
    description:
      'Remove pins that are provably dead: the operation is absent from every map, or an ephemeral pin expired. A dry run unless apply is true. Broken pins are never auto-removed.',
    inputSchema: {
      type: 'object',
      properties: { apply: { type: 'boolean', description: 'Actually remove. Default false: report only.' } },
      additionalProperties: false,
    },
  },
] as const;

type CallParams = { name?: unknown; arguments?: unknown };

function rpcError(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

function textOf(result: VerbResult): unknown {
  return { content: [{ type: 'text', text: result.text }], ...(result.isError === true ? { isError: true } : {}) };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringArg(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function intArg(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Math.floor(Number(value));
  return undefined;
}

/** Pin arguments are scalars only: an operation's inputs are strings/numbers/booleans. */
function scalarsOf(value: unknown): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, entry] of Object.entries(asRecord(value))) {
    if (typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean') out[key] = entry;
  }
  return out;
}

function stringsOf(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((entry): entry is string => typeof entry === 'string' && entry !== '');
  return out.length === 0 ? undefined : out;
}

export type McpServer = {
  /** Handle one JSON-RPC message. Returns null for notifications. */
  handle(message: JsonRpcRequest): Promise<JsonRpcResponse | null>;
  /** Serve until the input stream ends. Streams default to stdin/stdout. */
  start(input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream): Promise<void>;
};

export type McpServerOptions = {
  readonly client: Client;
  readonly input?: NodeJS.ReadableStream;
  readonly output?: NodeJS.WritableStream;
  readonly serverInfo?: { readonly name: string; readonly version: string };
};

export function createMcpServer(options: McpServerOptions): McpServer {
  const { client } = options;
  const info = options.serverInfo ?? { name: 'wrap2mcp', version: '0.1.0' };

  async function callTool(name: string, params: CallParams): Promise<unknown> {
    const args = asRecord(params.arguments);

    switch (name) {
      case 'ls':
        return textOf(await client.ls(stringArg(args, 'path') ?? '/'));

      case 'find':
        return textOf(await client.find(stringArg(args, 'query') ?? '', intArg(args, 'limit')));

      case 'describe':
        return textOf(await client.describe(stringArg(args, 'operation') ?? ''));

      case 'run':
        return textOf(
          await client.run(stringArg(args, 'operation') ?? '', asRecord(args['args']), {
            ...(stringArg(args, 'view') === undefined ? {} : { view: stringArg(args, 'view')! }),
            ...(stringArg(args, 'cursor') === undefined ? {} : { cursor: stringArg(args, 'cursor')! }),
            ...(typeof args['dryRun'] === 'boolean' ? { dryRun: args['dryRun'] } : {}),
            ...(typeof args['confirm'] === 'boolean' ? { confirm: args['confirm'] } : {}),
            ...(intArg(args, 'maxItems') === undefined ? {} : { maxItems: intArg(args, 'maxItems')! }),
          }),
        );

      case 'read':
        return textOf(
          await client.read(
            stringArg(args, 'handle') ?? '',
            stringArg(args, 'address') ?? '/',
            intArg(args, 'maxItems') === undefined ? {} : { maxItems: intArg(args, 'maxItems')! },
          ),
        );

      case 'pin': {
        const fields = stringsOf(args['fields']);
        const address = stringArg(args, 'address');
        const view = stringArg(args, 'view');
        const mode = stringArg(args, 'mode');
        const note = stringArg(args, 'note');
        const ttl = intArg(args, 'ttlSeconds');

        return textOf(
          await client.pin({
            name: stringArg(args, 'name') ?? '',
            operation: stringArg(args, 'operation') ?? '',
            args: scalarsOf(args['args']),
            ...(address === undefined ? {} : { address }),
            ...(fields === undefined ? {} : { fields }),
            ...(view === undefined ? {} : { view }),
            ...(mode === undefined ? {} : { mode: mode as NonNullable<PinDraft['mode']> }),
            ...(note === undefined ? {} : { note }),
            ...(ttl === undefined ? {} : { ttlSeconds: ttl }),
            ...(typeof args['ephemeral'] === 'boolean' ? { ephemeral: args['ephemeral'] } : {}),
          }),
        );
      }

      case 'unpin':
        return textOf(await client.unpin(stringArg(args, 'name') ?? ''));

      case 'prune':
        return textOf(await client.prune(typeof args['apply'] === 'boolean' ? { apply: args['apply'] } : {}));

      default:
        throw new Error(`unknown tool '${name}'`);
    }
  }

  async function handle(message: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    const id = message.id ?? null;
    const isNotification = message.id === undefined;

    if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      return isNotification ? null : rpcError(id, -32600, 'invalid request');
    }

    switch (message.method) {
      case 'initialize': {
        const requested = stringArg(asRecord(message.params), 'protocolVersion');
        const protocolVersion = requested !== undefined && KNOWN_PROTOCOLS.has(requested) ? requested : DEFAULT_PROTOCOL;
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: info.name, version: info.version },
            instructions:
              'Start with ls /. Use find when you know the words but not the operation id, describe before run when unsure, and read to drill into a handle. read @name re-resolves a pin; pin keeps a query for a later session, and ls /pins lists them.',
          },
        };
      }

      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null;

      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };

      case 'tools/list':
        return { jsonrpc: '2.0', id, result: { tools: TOOLS } };

      case 'tools/call': {
        const params = asRecord(message.params);
        const name = typeof params['name'] === 'string' ? params['name'] : '';
        if (!TOOLS.some((tool) => tool.name === name)) {
          return rpcError(id, -32602, `unknown tool '${name}'`, { tools: TOOLS.map((tool) => tool.name) });
        }
        try {
          return { jsonrpc: '2.0', id, result: await callTool(name, params as CallParams) };
        } catch (error) {
          // A tool failure is a result with isError, not a protocol error: the
          // agent should see it as output it can act on.
          return { jsonrpc: '2.0', id, result: textOf({ text: String(error), isError: true }) };
        }
      }

      default:
        return isNotification ? null : rpcError(id, -32601, `method not found: ${message.method}`);
    }
  }

  async function start(input: NodeJS.ReadableStream = options.input ?? process.stdin, output: NodeJS.WritableStream = options.output ?? process.stdout): Promise<void> {
    const lines = createInterface({ input, crlfDelay: Infinity });

    for await (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === '') continue;

      let message: JsonRpcRequest;
      try {
        message = JSON.parse(trimmed) as JsonRpcRequest;
      } catch {
        output.write(`${JSON.stringify(rpcError(null, -32700, 'parse error'))}\n`);
        continue;
      }

      const response = await handle(message);
      if (response !== null) output.write(`${JSON.stringify(response)}\n`);
    }
  }

  return { handle, start };
}
