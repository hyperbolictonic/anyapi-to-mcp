# Design

How the pieces fit, and why. This is the durable record; the repository history
holds the deliberation.

## Vocabulary

| Term | Meaning |
| --- | --- |
| **map** | One declarative document describing an API: resources, operations, links, views. |
| **resource** | A noun an agent navigates to (a collection or an item), not a URL path. |
| **operation** | A fixed request template with typed inputs; the only thing `run` executes. |
| **view** | A declarative projection of a response: `select`, `mode`, `fields`, limits. |
| **link** | A declared, directed relation between resources. |
| **handle** | A short, content-addressed reference to a stored response body. |
| **address** | A JSON Pointer into a stored payload, printed by every result. |
| **pin** | A saved query `(operation, args, address)` that re-resolves in a later session. |

Five verbs: `ls`, `describe`, `run`, `find`, `read`. There is deliberately no
`cd`; every address is absolute, so transcripts replay and subagents inherit no
hidden state.

## Addresses and the envelope

- Addresses are JSON Pointers (`/data/2/address/city`); field paths are dotted.
- Key selectors are supported: `/lines[name='Starforge']` returns all matches;
  a miss is an error, not an empty list.
- Every result prints its **handle**, its **address**, and enough metadata
  (`total`, `returned`, `truncated`, `bytes`) to decide what to read next.
- Rows are columnar `{fields, rows}` in every mode; `list` is a one-column
  projection. Nested values render as `{obj:N}` / `[arr:N]`, never inline.
- Text-like modes travel as text; columnar modes travel as compact JSON.
- Truncation always prints a resolvable continuation, never a range.

## Views

- Modes are explicit and reported: `auto`, `rows`, `document`, `list`, `outline`,
  `shape`, `scalar`, `jsonl`, `table`.
- `auto` may choose, but a response always states the mode it chose.
- One operation may declare a primary view plus named alternates.
- A transforming view gets its own derived handle, linked to its source.

## Runtime

- No `eval`, ever. Requests come from a map's declarative template; the agent
  supplies only arguments.
- Inputs are typed and validated: unknown arguments are errors, defaults are
  applied, and required values are checked before any network call.
- A dry run is a first-class path: it validates and builds the request without
  sending it.
- Outbound policy: HTTPS only; plain HTTP only for explicitly allow-listed hosts;
  private ranges refused; redirects followed under the same policy, and the
  credential is dropped when the origin changes.
- `fetch`, clock, payload store, secret provider and audit sink are injected by
  the host. The core chooses no paths and performs no I/O at import time.

## Secrets

- A map names a secret; a human binds that name to a host and a header. A map can
  never widen where a secret is sent, and a credential never enters a map, a
  view, a handle, a log, a stored payload or the audit trail.
- The core ships an environment provider only. Every other provider — including
  third-party secret managers — is an adapter injected by the host. A provider is
  told the destination host (`get(name, host)`), so one with its own affinity can
  refuse; that is a second check, never a replacement for the binding.
- Request headers are never written to a payload store.

## Handles and payloads

- Handles are content-addressed: `r_` plus 16 hex of SHA-256 over the payload.
  Unchanged data reuses a handle; identical payloads dedupe.
- Payloads are a cache, never user data. They expire (24 hours by default) and
  are safe to delete; anything worth keeping is a pin.
- `payloads.maxBytes` caps the file store: oldest records are evicted first, and
  the record just written is never evicted.
- Encryption and body redaction are supplied by the host through `PayloadStore`.
- Store and map writes are atomic (temp file, then rename).

## Pins

- A pin is a saved query, not a saved pointer. `read @name` re-runs it and prints
  the same shape it would today.
- Lifecycle: `ok`, `stale`, `broken:<code>`, `retired`. Failures are marked, not
  auto-deleted: only `retired` (operation gone from every map) is provable.
- A pin may not name a mutating operation.
- `prune` reports; `prune --apply` removes what is provably dead.

## Writes

- A write is derived from the method (anything but GET/HEAD), not only from
  `mutating: true`.
- The workspace owns the policy: `writes.mode` is `open`, `confirm` (default) or
  `deny`.
- In `confirm` mode the first call sends nothing and returns `write_not_confirmed`
  with the method, URL, body and secret name it would use; the second call passes
  `--confirm` / `confirm: true`.
- Unfilled optional body keys are omitted; whole-field placeholders keep the JSON
  type. JSON bodies default to `content-type: application/json`.
- 303 — and 301/302 for a non-GET — become GET without a body; 307/308 preserve
  the method and body.
- A write that fails ambiguously (`network`, timeout, 5xx) is `outcome_unknown`
  and is never auto-retried.
- The audit records a write body by SHA-256 and byte count, never by content.
- A 204/205 renders as one line (`no content`) on both `run` and `read`.

## Pagination

- `pagination` is declarative: `offset`, `link-header`, or none.
- A paginated response offers a short opaque `cursor` (`c_` plus 16 hex). It
  stores only `{operation, url}` under the payload cache with the payload TTL —
  never headers.
- `run <operation> --cursor c_…` continues: the URL is re-checked against the
  outbound policy, the secret is re-bound to that URL's host, and only literal
  headers are replayed.

## Maps, provenance and compatibility

- One logical map schema; packaging (one file or a split directory) is a loader
  detail.
- Every operation and link carries provenance: `spec`, `inferred`, `human`,
  `learned`. Human edits win.
- The map format is versioned. Tool names and result shapes stay stable once
  published, and an address printed by one version still resolves in the next.
- Legacy `schemaVersion: 1` files are read through a projection layer and never
  rewritten in place. The projection matches the real wrapper shape: an absolute
  `request.url`, `{{name}}` / `{{name|raw}}` placeholders, an `inputSchema`, and a
  `response` recipe whose `fields` map labels to paths.

## Deliberately open

- Idempotency keys for writes (shape left to the first real consumer).
- A predicate-pushdown payload engine (plain JSON files today).
- Embeddings, if ever, only for map authoring — never runtime resolution.
- Publication details (npm timing, alias package).
- Importer depth: array query parameters, one-level nested bodies, and
  multipart/octet-stream bodies are skipped with a warning today.

## Changing a decision

Add or edit the relevant section and say why. If it changes a published shape,
note the compatibility impact; versioned shapes do not move silently.
