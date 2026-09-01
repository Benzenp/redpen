#!/usr/bin/env node
// npm package `bin` entry (docs/IMPLEMENTATION_PLAN.md Phase 4). Delegates to
// the TypeScript CLI via tsx so the package can ship source directly during
// MVP development without a separate build step.
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const tsxCliPath = require.resolve('tsx/cli');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliEntry = path.resolve(__dirname, '../src/cli.ts');

const result = spawnSync(process.execPath, [tsxCliPath, cliEntry, ...process.argv.slice(2)], {
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
