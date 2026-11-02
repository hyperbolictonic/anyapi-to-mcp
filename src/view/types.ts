// Types for the projection engine.
//
// Everything here is data. A view is a declarative record, never code, and a
// mode is a closed union so that adding one is a compile error everywhere it
// must be handled.

/** What a view may ask for. `auto` is resolved by shape before rendering. */
export type Mode = 'auto' | 'rows' | 'document' | 'list' | 'table' | 'jsonl' | 'shape' | 'scalar';

/** What the envelope reports. `auto` never survives resolution. */
export type ResolvedMode = Exclude<Mode, 'auto'>;

/** Legacy recipe modes map onto the closed set; see `normaliseMode`. */
export const MODE_ALIASES: Readonly<Record<string, Mode>> = {
  outline: 'document',
  documents: 'document',
  object: 'document',
  array: 'list',
  json: 'jsonl',
  columns: 'rows',
};

export type DocumentStyle = 'outline' | 'headings';

/** Type labels used in `fields` and in shape output. Deliberately short. */
export type ValueType = 'null' | 'int' | 'num' | 'str' | 'bool' | 'obj' | 'arr' | 'any';

/** A cell after projection: scalars pass through, containers become summaries. */
export type Cell = string | number | boolean | null;

/** Every cap in one object so it can be threaded explicitly, never read from
 * module state. Determinism is a property of the layer, not a convention. */
export type Limits = {
  readonly maxItems: number;
  readonly maxDepth: number;
  readonly maxFieldChars: number;
  readonly maxKeys: number;
};

export const DEFAULT_LIMITS: Limits = {
  maxItems: 10,
  maxDepth: 3,
  maxFieldChars: 120,
  maxKeys: 40,
};

/** A declarative projection. Mirrors the map format's view object. */
export type ViewSpec = {
  /** JSON Pointer, optionally ending in a key selector. Default `/`. */
  readonly select?: string;
  readonly mode?: Mode;
  /** Only meaningful for `document`: outline (default) or markdown headings. */
  readonly style?: DocumentStyle;
  /** Declared columns as dotted field paths. Declared beats auto-union. */
  readonly fields?: readonly string[];
  /** Field used as a heading label in `document` + `style: headings`. */
  readonly titleField?: string;
  readonly limits?: Partial<Limits>;
  readonly title?: string;
};

export type Provenance = 'spec' | 'inferred' | 'human' | 'learned';

/**
 * The result envelope. Published shape: field names and meanings are stable.
 *
 * `rows` is always rows-of-cells and `fields` always describes its columns, in
 * every mode that produces rows. `text` carries the modes whose content is
 * prose (document, shape, table, jsonl, scalar, list is columnar).
 */
export type Envelope = {
  readonly summary: string;
  readonly mode: ResolvedMode;
  readonly fields?: readonly string[];
  readonly rows?: readonly (readonly Cell[])[];
  readonly text?: string;
  readonly total: number | null;
  readonly returned: number | null;
  readonly truncated: boolean;
  readonly cursor?: string | null;
  readonly handle?: string;
  readonly address?: string;
  /** UTF-8 bytes of the rendered body: how big this answer is. */
  readonly bytes: number;
  /** Bytes of the source payload, when known: how big the answer *was*. */
  readonly sourceBytes?: number;
  readonly hint?: string;
  readonly provenance?: Provenance;
};

export function typeName(v: unknown): ValueType {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return 'arr';
  switch (typeof v) {
    case 'number':
      return Number.isInteger(v) ? 'int' : 'num';
    case 'string':
      return 'str';
    case 'boolean':
      return 'bool';
    case 'object':
      return 'obj';
    default:
      return 'any';
  }
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
