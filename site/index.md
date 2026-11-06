# Any API → MCP

**Typed, token-efficient, navigable.** Experimental alpha (MIT), version 0.1.2.
CLI and MCP server id: `wrap2mcp`.

Turn a REST API into something an agent can *navigate* instead of something it
has to *read*. One declarative map per API, five verbs to move through it, and
every response stored behind an address.

- [Quick start](#quick-start)
- [Overview](README.html)
- [Design notes](docs/DESIGN.html)
- [Source on GitHub](https://github.com/hyperbolictonic/anyapi-to-mcp)
- [npm package](https://www.npmjs.com/package/anyapi-to-mcp)

## Navigate, not enumerate

A multi-megabyte OpenAPI document costs tokens before the agent has done
anything. A map is bounded: resources, the operations on them, and how each
response should be presented. The agent asks for what it needs next.

| Verb | Purpose |
| --- | --- |
| `ls` | children, one line each |
| `find` | ranked search across the map |
| `describe` | the input contract, on demand |
| `run` | execute; rows + meta + handle |
| `read` | drill into a stored payload |

There is deliberately no `cd`: every address is absolute, so transcripts replay
and subagents do not inherit hidden state.

## What you get

- **One map per API.** Resources, operations, links and views in a versioned
  document. Import OpenAPI 3, or learn a shape from one live call.
- **Drill-down is free.** Responses are stored behind content-addressed handles.
  A follow-up `read` costs no network call; handles expire.
- **Saved queries.** A pin names an operation, its arguments and an address;
  `read @name` resolves it again in any later session.
- **A real write gate.** Anything but GET/HEAD is previewed first. `confirm`,
  `open` or `deny` per workspace; no automatic retries.
- **Names, never values.** A map names a credential; a human binds it to exactly
  one host. No tool call can create a binding.
- **CLI, library, MCP.** No Electron, no local bridge. The same verbs from a
  shell, a stdio MCP server, or an import in your own code.

## Quick start

Node 22 or newer. Run the published package without installing it, or add it to
an MCP client.

```bash
npx -y anyapi-to-mcp ls --workspace ./workspace.json
npx -y anyapi-to-mcp describe products.list
npx -y anyapi-to-mcp serve --workspace ./workspace.json
```

```json
{
  "mcpServers": {
    "wrap2mcp": {
      "command": "npx",
      "args": ["-y", "anyapi-to-mcp", "serve", "--workspace", "./workspace.json"]
    }
  }
}
```

1. **Write a map.** Hand-write one, `import` an OpenAPI 3 document, or `learn`
   a draft from one live call.
2. **Point a workspace at it.** `workspace.json` names the map directory, the
   payload cache and the write policy.
3. **Connect the agent.** `serve` speaks stdio MCP; the agent navigates with
   `ls`, `find`, `describe`, `run` and `read`.

## Where it fits

Standalone by design: a library, a CLI and an MCP server over the same verbs. No
host application, no Electron, no bridge process in the core.

**Experimental alpha software.** Not production-ready. Try it, break it, and
file issues. The published package is `anyapi-to-mcp@0.1.2`; the CLI is
`wrap2mcp`.

- [Overview](README.html)
- [Design notes](docs/DESIGN.html)
- [Working rules](AGENTS.html)
- [Issues](https://github.com/hyperbolictonic/anyapi-to-mcp/issues)
- [HyperbolicTonic](https://hyperbolictonic.github.io/)

---

Any API → MCP · typed, token-efficient, navigable · MIT
