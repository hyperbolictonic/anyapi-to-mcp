// JSON Schema for the published shapes.
//
// Schemas are data here for the same reason maps are: a consumer (an MCP client,
// a UI, a validator) should be able to verify an envelope without importing the
// engine. Kept hand-written rather than generated so that a field name change is
// a visible diff in this file.

export const modeSchema = {
  type: 'string',
  enum: ['auto', 'rows', 'document', 'list', 'table', 'jsonl', 'shape', 'scalar'],
} as const;

export const addressSchema = {
  type: 'string',
  description: "JSON Pointer, optionally ending in a key selector: /lines[name='Starforge']",
} as const;

export const viewSpecSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://anyapi-to-mcp.dev/schema/view.schema.json',
  title: 'View',
  type: 'object',
  additionalProperties: false,
  properties: {
    select: addressSchema,
    mode: modeSchema,
    style: { type: 'string', enum: ['outline', 'headings'] },
    fields: { type: 'array', items: { type: 'string' }, description: 'Dotted field paths, in output order.' },
    titleField: { type: 'string' },
    title: { type: 'string' },
    limits: {
      type: 'object',
      additionalProperties: false,
      properties: {
        maxItems: { type: 'integer', minimum: 1 },
        maxDepth: { type: 'integer', minimum: 1 },
        maxFieldChars: { type: 'integer', minimum: 0, description: '0 disables the cap.' },
        maxKeys: { type: 'integer', minimum: 1 },
      },
    },
  },
} as const;

export const cellSchema = {
  type: ['string', 'number', 'boolean', 'null'],
  description: 'Containers are summarised as {obj:N} or [arr:N] rather than inlined.',
} as const;

export const envelopeSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://anyapi-to-mcp.dev/schema/envelope.schema.json',
  title: 'Result envelope',
  type: 'object',
  required: ['summary', 'mode', 'total', 'returned', 'truncated', 'address', 'bytes'],
  properties: {
    summary: { type: 'string' },
    mode: { type: 'string', enum: ['rows', 'document', 'list', 'table', 'jsonl', 'shape', 'scalar'] },
    fields: { type: 'array', items: { type: 'string' }, description: 'name:type, one per column.' },
    rows: { type: 'array', items: { type: 'array', items: cellSchema } },
    text: { type: 'string' },
    total: { type: ['integer', 'null'] },
    returned: { type: ['integer', 'null'] },
    truncated: { type: 'boolean' },
    cursor: { type: ['string', 'null'] },
    handle: { type: 'string' },
    address: addressSchema,
    bytes: { type: 'integer', description: 'UTF-8 bytes of the rendered body.' },
    sourceBytes: { type: 'integer' },
    hint: { type: 'string' },
    provenance: { type: 'string', enum: ['spec', 'inferred', 'human', 'learned'] },
  },
} as const;

export const viewSchemas = {
  view: viewSpecSchema,
  envelope: envelopeSchema,
} as const;
