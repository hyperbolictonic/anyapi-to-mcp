# Agent rules

## Read before changing architecture

Read `README.md` and `docs/DESIGN.md` first. The design notes record what is
settled and what is deliberately still open; do not import another project’s
directory structure by default.

## Scope

- This repository is a standalone library, CLI and MCP server.
- No Electron, no local bridge, and no dependency on a host application in the
  core packages.
- A host application may later consume this package as a dependency; this
  repository must never consume the host.

## Credentials

- Never store a credential value in a map, an operation, a view, a stored
  payload, a log, a test fixture, or a commit.
- A map may reference a secret by name only.
- A human, not an MCP tool, binds a secret to a host.
- Request headers are never written to a payload store.

## Compatibility

- The map, operation and view formats are versioned.
- Legacy `schemaVersion: 1` wrapper and recipe files must stay readable. Read
  them through a projection layer; do not rewrite user files in place.
- Keep tool names and result shapes stable once published.
- An address printed by one version must still resolve in the next.

## House rules

- Use **pnpm** for this repository (pinned via `packageManager`). Do not run
  `npm install` or `yarn`; never commit `package-lock.json` or `yarn.lock`.
  Scripts are still run with `pnpm <script>`, not `npm run <script>`.
- Do not write a local disk path into any file. Use `<repo>`, `~/`, `$HOME`,
  `<home>`, or environment variables instead.
- `node_modules/`, build output, coverage and local data are ignored; do not
  commit them.
- The GitHub Pages site is generated from repository Markdown by
  `scripts/build-pages.mjs` (`pnpm build:pages`). Do not commit `_site/`, and
  keep a Markdown alternate next to every page.
- Run typecheck and tests before committing once those scripts exist.
- Update the docs when a decision changes; `DESIGN.md` is the decision log.

## Start of a new session

Begin with `README.md` (what it is and how to run it) and `docs/DESIGN.md`
(what is settled, what is open). Run `pnpm typecheck` and `pnpm test` before
changing anything.
