// tsc 5.9 rewrites relative import extensions in the emitted `.js` files but
// leaves `.ts` specifiers in the `.d.ts` files. A published declaration that
// points at `./x.ts` cannot be resolved by a consumer, so rewrite those too and
// prove every specifier lands on a declaration that exists.

import { access, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.argv[2] ?? 'dist';

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else if (entry.name.endsWith('.d.ts')) files.push(full);
  }
  return files;
}

const SPECIFIER = /(from\s+['"]|import\(\s*['"])(\.[^'"]+)\.ts(['"])/g;

let rewritten = 0;
const problems = [];

for (const file of await walk(root)) {
  const before = await readFile(file, 'utf8');
  const after = before.replace(SPECIFIER, '$1$2.js$3');
  if (after !== before) {
    await writeFile(file, after);
    rewritten += 1;
  }

  for (const match of after.matchAll(/(?:from\s+['"]|import\(\s*['"])(\.[^'"]+)(['"])/g)) {
    const target = match[1];
    if (target === undefined) continue;
    const declaration = path.resolve(path.dirname(file), target).replace(/\.js$/, '.d.ts');
    try {
      await access(declaration);
    } catch {
      problems.push(`${file}: ${target} has no ${path.basename(declaration)}`);
    }
  }
}

if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}

console.log(`declarations: rewrote ${rewritten} file(s), all relative specifiers resolve`);
