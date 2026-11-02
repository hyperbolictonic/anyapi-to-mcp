// Reading an API description from disk, in whichever of the two formats real
// projects actually publish.

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { Result } from '../view/result.ts';
import { err, ok } from '../view/result.ts';
import { parseYaml } from './yaml.ts';

export type ApiDocument = {
  readonly document: unknown;
  readonly format: 'json' | 'yaml';
};

export type ApiDocumentError = {
  readonly code: 'not_found' | 'invalid_json' | 'invalid_yaml';
  readonly message: string;
  readonly hint?: string;
};

function looksLikeJson(text: string): boolean {
  const first = text.trimStart().charAt(0);
  return first === '{' || first === '[';
}

export async function readApiDocument(file: string): Promise<Result<ApiDocument, ApiDocumentError>> {
  let text: string;
  try {
    text = (await readFile(file, 'utf8')).replace(/^\uFEFF/, '');
  } catch {
    return err({
      code: 'not_found',
      message: `cannot read ${file}`,
      hint: 'pass the path to an OpenAPI 3 document, in JSON or YAML',
    });
  }

  const extension = path.extname(file).toLowerCase();
  const asYaml = extension === '.yaml' || extension === '.yml' || (!looksLikeJson(text) && extension !== '.json');

  if (!asYaml) {
    try {
      return ok({ document: JSON.parse(text) as unknown, format: 'json' });
    } catch (error) {
      return err({
        code: 'invalid_json',
        message: `${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        hint: 'the file does not look like YAML either; check that it was not truncated',
      });
    }
  }

  const parsed = parseYaml(text);
  if (!parsed.ok) {
    return err({
      code: 'invalid_yaml',
      message: `${file}:${parsed.error.line}: ${parsed.error.message}`,
      hint: 'the reader understands block maps and sequences, flow collections, quoted scalars, block scalars and anchors',
    });
  }

  return ok({ document: parsed.value, format: 'yaml' });
}
