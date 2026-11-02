# Any API → MCP

> **Experimental alpha software.** This is an early, working prototype. APIs,
> file formats, CLI output and tool schemas may change without notice, and it is
> not production-ready. Try it, break it, and file issues.

**Typed, token-efficient, navigable.**

`anyapi-to-mcp` turns a REST API into something an agent can *navigate* rather
than something it has to *read*. One declarative **map** per API describes its
resources, the operations on them, the links between them, and how each response
should be presented. An agent moves through that map instead of assembling URLs,
headers and JSON envelopes — or loading a multi-megabyte OpenAPI document.

> Status: **alpha.** The core works end to end: maps load, the view layer renders
> addresses and envelopes, the runtime executes operations under an outbound
> policy and stores payloads behind content-addressed handles, and the five verbs
> are served by both a stdio MCP server and the `wrap2mcp` CLI. A map can be
> imported from OpenAPI 3 or learned from one live call. The package is not yet
> published to npm.

## Names

| Thing | Name |
| --- | --- |
| Repository / npm package | `anyapi-to-mcp` |
| CLI | `wrap2mcp` |
| MCP server id in client config | `wrap2mcp` |
| Product | **Any API → MCP** |

Both `wrap2mcp` and `anyapi-to-mcp` run the same CLI.

## Vocabulary

| Term | Meaning |
| --- | --- |
| **map** | One declarative document per API: resources, operations, links, views, provenance. |
| **resource** | A thing the API exposes (`customer`, `charge`). Navigation is by resource. |
| **operation** | One callable request on a resource. |
| **view** | A declarative projection of a response. |
| **link** | A reference from one resource to another. |
| **handle** | An opaque id for a stored response payload. |
| **address** | A JSON Pointer into a stored payload or projection. |

## What it does

- Navigate, not enumerate: `ls`, `find`, `describe`, `run`, `read`.
- Keep discovery cheap: bounded listings, contract-on-demand, declared fields,
  capped output, one merged page.
- Make drill-down free: responses are stored and addressed, so a follow-up
  costs no network call.
- Speak one address space: machine output is compact; human output is an
  outline — and both print the same pointers.
- Work as a standalone library and server, without Electron or a local bridge.
- Import an OpenAPI spec, or learn a shape from one live call, and produce a map
  (“instant modernisation”).
- Keep what matters: a pin names a query, re-resolves next session, and can be
  committed to the repository.

## What it will do

- Be published to npm so `npx anyapi-to-mcp` runs without a checkout.
- Be embedded by a host app; the library, CLI and MCP server are all entry
  points into the same verbs.

## The five verbs

| Verb | Purpose |
| --- | --- |
| `ls <path>` | children, one line each (`/pins` lists saved queries) |
| `describe <operation>` | input contract, view, mutating flag, provenance |
| `run <operation> k=v` | execute; rows + meta + handle |
| `find <query>` | ranked search across the map |
| `read <handle\|@pin> <pointer>` | drill into a stored payload, or re-resolve a pin |

There is deliberately no `cd`: every address is absolute, so transcripts
replay, subagents don’t inherit hidden state, and the audit log is reconstructable.

## Usage

Run from this repository (`pnpm cli` builds once, then runs the compiled CLI);
the tarball from `pnpm pack` installs into any project, and npm publication is
still pending:

```bash
pnpm cli ls                                  # maps
pnpm cli ls /dummyjson                       # resources
pnpm cli describe products.list              # inputs, view, links
pnpm cli run products.list limit=3           # rows + handle
pnpm cli run products.list limit=3 --cursor c_…  # next page, from the cursor printed before
pnpm cli run products.add title=New --confirm  # a write: previewed first, then sent
pnpm cli run products.add title=New --writes open  # no confirmation for this call
pnpm cli read r_64172fe191255484 /products/1 # no network
pnpm cli find products
pnpm cli pin cheap products.list limit=3 --address /products --fields id,title,price
pnpm cli ls /pins                              # saved queries and their state
pnpm cli read @cheap                           # re-resolve, in any later session
pnpm cli unpin cheap
pnpm cli prune                                 # report; --apply removes dead pins
pnpm cli import openapi ./api.yaml             # spec -> map
pnpm cli learn https://dummyjson.com/products  # one call -> draft map
pnpm cli serve                                 # stdio MCP server
```

Add `--workspace examples/workspace.json` (or run from a directory containing
`workspace.json`) to point at a set of maps. Commands that print an envelope
also print a handle and an address; paste both back into `read`.

Handles are plain text in the OS cache and expire after 24 hours by default
(`payloads.ttlSeconds` in the workspace changes it); a host that needs
encryption or body redaction supplies its own `PayloadStore`.

A paginated response ends with a short `cursor` when the API offers a next page
(`offset` totals and `Link` headers both work). Passing it back —
`run <operation> --cursor c_…` — fetches that page through the same outbound
policy, secret host check and view; the cursor stores only the operation and the
next URL, never headers, in `payloads/cursors`. Cursors expire with the payload
TTL. `payloads.maxBytes` caps the cache: the oldest records are evicted first,
and the record just written is always kept.

## Pins

A handle is cache: it expires, and it means nothing to the next session. A pin is
a **saved query** — operation, arguments, address — so `read @name` runs it again
and prints the same shape it would today:

```bash
pnpm cli pin cheap products.list limit=3 --address /products --fields id,title,price
# pinned cheap — products.list  [ok]
pnpm cli read @cheap
# @cheap — products.list → /products  [ok]
# {"summary":"3 rows, showing 3 (rows)","fields":["id:int","title:str","price:num"],…}
```

Pins live in one versioned JSON file named by the workspace (`pins: { "path": … }`),
and each record carries its own state: `ok`, `stale`, `broken:<code>` (a selector
miss, an HTTP error, an unbound secret) or `retired` (the operation is gone from
every map). A failure marks the pin and keeps it; only `retired` and expired
`ephemeral` pins are pruned, and `prune` is a report until `--apply`. A pin may
not name a mutating operation, because reading it would repeat the write.

## Writes

An operation that changes data — anything but GET/HEAD, declared or not — is run
through the workspace's write policy. The default is `confirm`:

```bash
pnpm cli run products.add title=New price=9
# not sent: POST https://dummyjson.com/products/add  [mutating]
#   body: {"title":"New","price":9}
#   writes.mode is 'confirm'
# # nothing has been sent; repeat with confirm to send it

pnpm cli run products.add title=New price=9 --confirm
# wrote POST https://dummyjson.com/products/add · 201
# # document · 49B · r_4ee99d7fed2f2ace
# /  obj(3)
```

`writes` in `workspace.json` is a string or `{ "mode": … }`:

| Mode | Behaviour |
| --- | --- |
| `confirm` (default) | build the request, send nothing; repeat with `--confirm` / `confirm: true` |
| `open` | send it, after printing the `wrote …` line |
| `deny` | refuse with `write_denied`, even when confirmed — for a read-only deployment |

The confirmation is a deliberate second step, not proof that a human agreed; a
host that needs real approval puts one in front of the tool call. It never covers
a pin: a pin may not name a mutating operation.

Two consequences worth knowing:

- an optional body field the caller does not fill is **omitted**, so a partial
  `PATCH` sends only what was given, and a clean JSON body gets
  `content-type: application/json`;
- a write that fails before or ambiguously after a response (timeout, network,
  5xx) reports `outcome_unknown`, and is **never retried automatically**. Read
  the resource before retrying. A `204` prints as one line, `no content`.

Idempotency keys are not sent yet; see `docs/DESIGN.md` for the open items.

## Instant modernisation

`import` turns an OpenAPI 3 document (JSON or YAML) into a map: resources from
paths, operations with typed inputs and request templates, a first-draft view
per operation, links from `*_id` fields, and the security scheme as a secret
*name* — never a value.

```bash
pnpm cli import openapi ./openapi.yaml --out ./maps/my-api.json
# imported my-api — 5 resources, 19 operations, 1 link
#   base: https://api.example.com/v1
#   secrets to bind: api_key (host api.example.com) — a human writes the binding
#   notes: …array query parameters and multipart bodies are skipped, not guessed
```

`learn` is for APIs whose description is missing or wrong. It fetches the URL
once, infers a shape from the JSON, drafts a view, stores the sample behind a
handle and prints the proposed map; nothing is written unless `--out` or a
writable map location exists.

```bash
pnpm cli learn "https://dummyjson.com/products?limit=3" --out ./maps/products.json
```

Corrections belong in `overrides/<map>.json`, not in the generated map: the
importer will rewrite a generated file happily, but refuses to overwrite one
that contains `provenance: human` entries unless you pass `--force`.

As an MCP server:

```json
{
  "mcpServers": {
    "wrap2mcp": {
      "command": "node",
      "args": ["<repo>/bin/wrap2mcp.js", "serve", "--workspace", "<repo>/examples/workspace.json"]
    }
  }
}
```

As a library:

```ts
import { createClient, MemoryStore } from 'anyapi-to-mcp';

const client = createClient({ workspace: { maps: [{ path: 'maps' }] }, store: new MemoryStore() });

await client.ls('/');                       // what is here
await client.describe('products.list');     // what it needs
const result = await client.run('products.list', { limit: 3 });
const handle = (result.data as { handle: string }).handle;
await client.read(handle, '/products/1');   // no refetch

await client.pin({ name: 'cheap', operation: 'products.list', args: { limit: 3 }, fields: ['id', 'title', 'price'] });
await client.read('@cheap');                // re-resolves; name a pins path to persist it
await client.prune();                       // a report; { apply: true } removes dead pins
```

`ls`, `find` and `describe` are local. Nothing touches an API until `run`, and
`run --dry-run` validates and builds the request without sending it.

## Secrets

A map *names* a secret; it never holds a value, and no tool call can create a
binding. A human writes the bindings file by hand — by default
`<config>/bindings.json`, next to the maps — naming the one host the value may
be sent to:

```json
{
  "GITHUB_TOKEN": {
    "host": "api.github.com",
    "header": "authorization",
    "format": "Bearer {value}"
  }
}
```

`host` is required; `header` defaults to `authorization` and `format` to
`{value}`. Then put the value in the environment (`GITHUB_TOKEN=...` in a POSIX
shell, `$env:GITHUB_TOKEN = "..."` in PowerShell).

`run --dry-run` reports the header *name* and never the value; a secret bound to
one host is refused for any other host, before any request is built.

## Development

pnpm only, pinned through `packageManager` in `package.json`.

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build          # emits dist/ for the published artifact
pnpm pack           # the tarball ships dist, bin, README and LICENSE
```

`pnpm cli` builds first, because `bin/wrap2mcp.js` resolves the compiled
`dist/cli.js`; the source itself is what the tests run.

Do not commit `package-lock.json` or `yarn.lock`. The MCP config above uses
`node` plus a path because the package is not published yet; the published form
will be `npx -y anyapi-to-mcp serve`.

## Documentation

- [`docs/DESIGN.md`](./docs/DESIGN.md) — the design notes: what is settled,
  and what is deliberately still open.
- [`AGENTS.md`](./AGENTS.md) — rules for anyone (human or agent) working here.

## Not affiliated

Not affiliated with Anthropic, the Model Context Protocol project, or any API
vendor. “MCP” refers to the open Model Context Protocol.

## License

MIT. See [`LICENSE`](./LICENSE).
