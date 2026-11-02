#!/usr/bin/env node

// Entry point for both the local checkout and the published tarball. The
// implementation is TypeScript; `pnpm build` emits `dist/` and rewrites the
// `.ts` specifiers, so this file resolves the compiled module in either case.
// `pnpm cli` builds before it runs this.

import { main } from '../dist/cli.js';

process.exitCode = await main(process.argv.slice(2));
