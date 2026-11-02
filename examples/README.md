# Examples

Runnable so far:

- `view-quickstart.ts` — the level-1 library import: render a payload into the
  result envelope, then resolve a printed address back out of the same payload.
  No map, no network, no files.
- `runtime-smoke.ts` — the whole stack against live DummyJSON: load a map,
  dry-run the request, execute it, store the payload, and read an address back
  with no second request. Uses the in-memory store, so it writes nothing.

  ```
  node examples/view-quickstart.ts
  node examples/runtime-smoke.ts
  ```

- `maps/dummyjson.json` — a hand-written map used by the smoke test.
- `workspace.json` — points a CLI or MCP server at `maps/`. Use it as
  `--workspace examples/workspace.json`, or copy it next to your own maps and
  the CLI finds it as `./workspace.json`.

The CLI and MCP flows need no example file of their own:

```
pnpm cli ls --workspace examples/workspace.json
pnpm cli describe products.list --workspace examples/workspace.json
pnpm cli run products.list limit=3 --workspace examples/workspace.json
pnpm cli read <handle-from-the-last-command> /products/1 --workspace examples/workspace.json
```

`run` and `read` in *different* processes still work, because the payload store
is a directory in the OS cache. That is the drill-down guarantee: a handle is
not process memory.

Pins go one step further and survive the cache:

```
pnpm cli pin cheap products.list limit=3 --address /products --fields id,title,price --workspace examples/workspace.json
pnpm cli read @cheap --workspace examples/workspace.json
pnpm cli ls /pins --workspace examples/workspace.json
pnpm cli prune --workspace examples/workspace.json --apply
```

`examples/workspace.json` names no pins file, so the CLI uses the default
`~/.config/wrap2mcp/pins.json` rather than writing into this directory. Name one
with `"pins": { "path": "pins.json" }` when you want pins committed next to the
maps they belong to.

Writes are previewed by default, because the workspace names no `writes` mode:

```
pnpm cli run products.add title=Example price=9 --workspace examples/workspace.json
pnpm cli run products.add title=Example price=9 --confirm --workspace examples/workspace.json
```

The first prints `not sent: POST …` with the body and exits 1; the second prints
`wrote POST … · 201` and the stored answer. DummyJSON's `/products/add` only
simulates a create, which is why a write is safe in an example at all: never
point one at an API that keeps the record.

Authoring needs no example file either:

```
pnpm cli import openapi test/import/fixtures/petstore.json --out $env:TEMP/maps/petstore.json
pnpm cli learn "https://dummyjson.com/products?limit=3" --out $env:TEMP/maps/products.json
```

Planned, in phase order:

- `mcp/` — a minimal `mcpServers` config for the stdio server.
- `openapi/` — import a small spec and inspect the generated resources,
  operations and links.

Guidelines:

- Use public, read-only test APIs.
- Never commit an API key, token, or cookie.
- Show the secret-binding step as a human action, not an agent action.
- Keep each example runnable from a clean checkout.
- Show both renderers: machine output and the human outline must print the same
  addresses.
