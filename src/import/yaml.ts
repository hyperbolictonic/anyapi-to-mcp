// A YAML reader for API descriptions, not a YAML implementation.
//
// OpenAPI documents use a small, boring subset of YAML: block mappings and
// sequences, flow collections, quoted and plain scalars, block scalars for
// descriptions, and occasionally anchors for shared response objects. This file
// reads exactly that subset and refuses the rest with a line number, because a
// parser that silently mis-reads a spec is worse than one that says no.
//
// Not supported, and reported as errors: multiple documents, tabs in
// indentation, complex (`?`) keys, and tags (`!!str`). Anchors, aliases and
// merge keys *are* supported, because real specs use them.

import type { Result } from '../view/result.ts';
import { err, ok } from '../view/result.ts';

export type YamlError = {
  readonly message: string;
  /** 1-based physical line. */
  readonly line: number;
};

type Line = {
  readonly indent: number;
  readonly content: string;
  readonly line: number;
};

type Scalar = string | number | boolean | null;
export type YamlValue = Scalar | YamlValue[] | { [key: string]: YamlValue };
type Value = YamlValue;

/** Remove a trailing `# comment`, respecting quotes and `#` inside a word. */
function stripComment(text: string): string {
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quote !== null) {
      if (char === '\\' && quote === '"') index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '#' && (index === 0 || /\s/.test(text[index - 1]!))) return text.slice(0, index);
  }
  return text;
}

function clone<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => clone(item)) as unknown as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = clone(item);
    return out as T;
  }
  return value;
}

const NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

class Parser {
  private index = 0;
  private anchors = new Map<string, Value>();
  private readonly lines: string[];
  private readonly fail: (message: string, line: number) => never;

  constructor(lines: string[], fail: (message: string, line: number) => never) {
    this.lines = lines;
    this.fail = fail;
  }

  run(): Value {
    const first = this.peek();
    if (first === null) return null;
    if (first.indent !== 0) this.fail('the document must start at column 0', first.line);

    const value = this.parseBlock(0);
    const rest = this.peek();
    if (rest !== null) this.fail(`unexpected content at column ${rest.indent}`, rest.line);
    return value;
  }

  // --- line handling -------------------------------------------------------

  private peek(): Line | null {
    while (this.index < this.lines.length) {
      const raw = this.lines[this.index]!;
      if (/^[ \t]*\t/.test(raw) && raw.trim() !== '') this.fail('tabs are not allowed in indentation', this.index + 1);

      const stripped = stripComment(raw);
      if (stripped.trim() === '') {
        this.index += 1;
        continue;
      }
      if (stripped.trimStart().startsWith('%')) this.fail('YAML directives are not supported', this.index + 1);
      if (stripped.trim() === '---' || stripped.trim() === '...') {
        // A single leading document marker is tolerated; a second one is not.
        if (this.index === 0) {
          this.index += 1;
          continue;
        }
        this.fail('multiple YAML documents are not supported', this.index + 1);
      }

      const indent = stripped.length - stripped.trimStart().length;
      return { indent, content: stripped.trim(), line: this.index + 1 };
    }
    return null;
  }

  private advance(): void {
    this.index += 1;
  }

  // --- structure -----------------------------------------------------------

  private parseBlock(indent: number): Value {
    const line = this.peek();
    if (line === null) return null;
    if (line.indent < indent) return null;
    if (line.indent !== indent) this.fail(`unexpected indentation at column ${line.indent}`, line.line);

    return this.isSequenceItem(line.content) ? this.parseSequence(indent) : this.parseMapping(indent);
  }

  private isSequenceItem(content: string): boolean {
    return content === '-' || content.startsWith('- ');
  }

  private parseSequence(indent: number): Value[] {
    const out: Value[] = [];

    for (;;) {
      const line = this.peek();
      if (line === null || line.indent !== indent || !this.isSequenceItem(line.content)) break;

      const rest = line.content === '-' ? '' : line.content.slice(2).trim();
      this.advance();

      if (rest === '') {
        const next = this.peek();
        if (next === null || next.indent <= indent) {
          out.push(null);
        } else {
          out.push(this.parseBlock(next.indent));
        }
        continue;
      }

      // `- key: value` starts a mapping whose indentation is where `key` sits.
      const afterDash = line.content.slice(2);
      const column = indent + 2 + (afterDash.length - afterDash.trimStart().length);
      if (this.splitKey(rest) !== null) {
        this.lines[this.index - 1] = `${' '.repeat(column)}${rest}`;
        this.index -= 1;
        out.push(this.parseMapping(column));
        continue;
      }

      out.push(this.parseAtom(rest, line.line));
    }

    return out;
  }

  private parseMapping(indent: number): { [key: string]: Value } {
    const out: Record<string, Value> = {};
    const merges: Value[] = [];

    for (;;) {
      const line = this.peek();
      if (line === null || line.indent !== indent) break;
      if (this.isSequenceItem(line.content)) break;

      const split = this.splitKey(line.content);
      if (split === null) this.fail(`expected 'key: value', found '${line.content}'`, line.line);

      const { key, rest } = split;
      this.advance();

      if (key === '<<') {
        merges.push(rest === '' ? this.parseBlock(indent + 2) : this.parseAtom(rest, line.line));
        continue;
      }

      out[key] = this.parseValue(rest, indent, line.line);
    }

    for (const merge of merges) {
      for (const source of Array.isArray(merge) ? merge : [merge]) {
        if (source === null || typeof source !== 'object' || Array.isArray(source)) continue;
        for (const [key, value] of Object.entries(source as Record<string, Value>)) {
          if (!Object.hasOwn(out, key)) out[key] = clone(value);
        }
      }
    }

    return out;
  }

  /** The value after `key:`, which may live on the following lines. */
  private parseValue(rest: string, indent: number, lineNo: number): Value {
    if (rest === '') {
      const next = this.peek();
      if (next === null) return null;

      // A sequence may sit at the same indent as its key.
      if (next.indent === indent && this.isSequenceItem(next.content)) return this.parseSequence(indent);
      if (next.indent <= indent) return null;
      return this.parseBlock(next.indent);
    }

    if (rest.startsWith('|') || rest.startsWith('>')) return this.parseBlockScalar(rest, indent, lineNo);

    return this.parseAtom(rest, lineNo);
  }

  private parseBlockScalar(header: string, indent: number, lineNo: number): string {
    const literal = header.startsWith('|');
    const chomp = header.includes('-') ? 'strip' : header.includes('+') ? 'keep' : 'clip';

    const collected: string[] = [];
    let blockIndent: number | null = null;

    while (this.index < this.lines.length) {
      const raw = this.lines[this.index]!;
      if (raw.trim() === '') {
        collected.push('');
        this.index += 1;
        continue;
      }

      const lineIndent = raw.length - raw.trimStart().length;
      if (lineIndent <= indent) break;
      if (blockIndent === null) blockIndent = lineIndent;
      if (lineIndent < blockIndent) break;

      collected.push(raw.slice(blockIndent));
      this.index += 1;
    }

    while (chomp !== 'keep' && collected.length > 0 && collected.at(-1) === '') collected.pop();

    const body = literal ? collected.join('\n') : fold(collected);
    if (chomp === 'strip') return body.trimEnd();
    return collected.length === 0 ? '' : `${body}\n`;
  }

  // --- atoms ---------------------------------------------------------------

  private parseAtom(text: string, lineNo: number): Value {
    let rest = text.trim();

    if (rest.startsWith('&')) {
      const space = rest.indexOf(' ');
      const name = space === -1 ? rest.slice(1) : rest.slice(1, space);
      const remainder = space === -1 ? '' : rest.slice(space + 1).trim();
      const value = remainder === '' ? this.parseDeferred(lineNo) : this.parseAtom(remainder, lineNo);
      if (!this.anchors.has(name)) this.anchors.set(name, clone(value));
      return value;
    }

    if (rest.startsWith('*')) {
      const name = rest.slice(1).trim();
      const anchor = this.anchors.get(name);
      if (anchor === undefined) this.fail(`unknown alias '*${name}'`, lineNo);
      return clone(anchor);
    }

    if (rest.startsWith('!')) this.fail('YAML tags are not supported', lineNo);
    if (rest.startsWith('[') || rest.startsWith('{')) return this.parseFlow(rest, lineNo);

    return this.parseScalar(rest);
  }

  /** A value declared on the lines below an anchor. */
  private parseDeferred(lineNo: number): Value {
    const next = this.peek();
    if (next === null) return null;
    if (next.indent < 0) this.fail('unexpected end of document', lineNo);
    return this.parseBlock(next.indent);
  }

  private parseScalar(text: string): Scalar {
    const trimmed = text.trim();

    if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
      return trimmed.slice(1, -1).replace(/''/g, "'");
    }
    if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
      return unescapeDouble(trimmed.slice(1, -1));
    }

    if (trimmed === '' || trimmed === '~' || trimmed === 'null' || trimmed === 'Null' || trimmed === 'NULL') return null;
    if (/^(?:true|True|TRUE)$/.test(trimmed)) return true;
    if (/^(?:false|False|FALSE)$/.test(trimmed)) return false;
    if (NUMBER.test(trimmed)) return Number(trimmed);

    return trimmed;
  }

  private parseFlow(text: string, lineNo: number): Value {
    let cursor = 0;

    const skipSpace = (): void => {
      while (cursor < text.length && /\s/.test(text[cursor]!)) cursor += 1;
    };

    const readQuoted = (): string => {
      const quote = text[cursor]!;
      let out = '';
      cursor += 1;
      while (cursor < text.length) {
        const char = text[cursor]!;
        if (quote === '"' && char === '\\') {
          out += char + text[cursor + 1]!;
          cursor += 2;
          continue;
        }
        if (char === quote) {
          if (quote === "'" && text[cursor + 1] === "'") {
            out += "'";
            cursor += 2;
            continue;
          }
          cursor += 1;
          return quote === '"' ? unescapeDouble(out) : out;
        }
        out += char;
        cursor += 1;
      }
      this.fail('unterminated quoted string in a flow collection', lineNo);
    };

    const readValue = (): Value => {
      skipSpace();
      const char = text[cursor];

      if (char === '[') {
        cursor += 1;
        const items: Value[] = [];
        for (;;) {
          skipSpace();
          if (text[cursor] === ']') {
            cursor += 1;
            return items;
          }
          items.push(readValue());
          skipSpace();
          if (text[cursor] === ',') {
            cursor += 1;
            continue;
          }
          if (text[cursor] === ']') {
            cursor += 1;
            return items;
          }
          this.fail('expected , or ] in a flow sequence', lineNo);
        }
      }

      if (char === '{') {
        cursor += 1;
        const map: Record<string, Value> = {};
        for (;;) {
          skipSpace();
          if (text[cursor] === '}') {
            cursor += 1;
            return map;
          }
          const key = text[cursor] === '"' || text[cursor] === "'" ? readQuoted() : readBareKey();
          skipSpace();
          if (text[cursor] !== ':') this.fail('expected : in a flow mapping', lineNo);
          cursor += 1;
          map[key] = readValue();
          skipSpace();
          if (text[cursor] === ',') {
            cursor += 1;
            continue;
          }
          if (text[cursor] === '}') {
            cursor += 1;
            return map;
          }
          this.fail('expected , or } in a flow mapping', lineNo);
        }
      }

      if (char === '"' || char === "'") return readQuoted();

      let out = '';
      while (cursor < text.length && !/[,}\]]/.test(text[cursor]!)) {
        out += text[cursor];
        cursor += 1;
      }
      return this.parseScalar(out);
    };

    const readBareKey = (): string => {
      let out = '';
      while (cursor < text.length && text[cursor] !== ':') {
        out += text[cursor];
        cursor += 1;
      }
      return out.trim();
    };

    const value = readValue();
    skipSpace();
    if (cursor < text.length) this.fail('trailing characters after a flow collection', lineNo);
    return value;
  }

  // --- key splitting -------------------------------------------------------

  /** `key: value` -> `{key, rest}`; null when the line is not a mapping entry. */
  private splitKey(content: string): { key: string; rest: string } | null {
    if (content.startsWith('? ')) this.fail('complex mapping keys are not supported', this.peek()?.line ?? 1);

    let quote: '"' | "'" | null = null;
    let depth = 0;

    for (let index = 0; index < content.length; index += 1) {
      const char = content[index]!;
      if (quote !== null) {
        if (char === '\\' && quote === '"') index += 1;
        else if (char === quote) quote = null;
        continue;
      }
      if (char === '"' || char === "'") {
        quote = char;
        continue;
      }
      if (char === '[' || char === '{') depth += 1;
      if (char === ']' || char === '}') depth -= 1;
      if (char === ':' && depth === 0 && (index + 1 === content.length || /\s/.test(content[index + 1]!))) {
        const rawKey = content.slice(0, index).trim();
        const key =
          rawKey.length >= 2 && rawKey.startsWith('"') && rawKey.endsWith('"')
            ? unescapeDouble(rawKey.slice(1, -1))
            : rawKey.length >= 2 && rawKey.startsWith("'") && rawKey.endsWith("'")
              ? rawKey.slice(1, -1).replace(/''/g, "'")
              : rawKey;
        return { key, rest: content.slice(index + 1).trim() };
      }
    }

    return null;
  }
}

function unescapeDouble(text: string): string {
  return text.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (match, escape: string) => {
    if (escape.startsWith('u')) return String.fromCharCode(Number.parseInt(escape.slice(1), 16));
    if (escape.startsWith('x')) return String.fromCharCode(Number.parseInt(escape.slice(1), 16));
    switch (escape) {
      case 'n':
        return '\n';
      case 't':
        return '\t';
      case 'r':
        return '\r';
      case 'b':
        return '\b';
      case 'f':
        return '\f';
      case '0':
        return '\0';
      default:
        return match.length === 2 ? escape : match;
    }
  });
}

/** Folded block scalar: single newlines become spaces, blank lines stay breaks. */
function fold(lines: readonly string[]): string {
  let out = '';

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line === '') continue;

    if (out !== '') {
      const previous = lines[index - 1] ?? '';
      out += previous === '' || previous.startsWith(' ') || line.startsWith(' ') ? '\n' : ' ';
    }
    out += line;
  }

  return out;
}

/** Parse a YAML document. Returns an error with a line number, never throws. */
export function parseYaml(text: string): Result<Value, YamlError> {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');

  // A single leading `---` is common; the parser tolerates it but the document
  // must not be empty after it.
  let failure: YamlError | null = null;
  const fail = (message: string, line: number): never => {
    failure = { message, line };
    throw new Error('yaml');
  };

  try {
    const parser = new Parser(lines, fail);
    const value = parser.run();
    return ok(value);
  } catch (error) {
    if (failure !== null) return err(failure);
    return err({ message: error instanceof Error ? error.message : String(error), line: 1 });
  }
}
