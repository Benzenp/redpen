import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const testRoot = path.resolve(process.argv[2] ?? 'src');

async function collectTestFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectTestFiles(entryPath);
    return entry.isFile() && entry.name.endsWith('.test.ts') ? [entryPath] : [];
  }));
  return files.flat();
}

const testFiles = (await collectTestFiles(testRoot)).sort();
if (testFiles.length === 0) {
  throw new Error(`no *.test.ts files found under ${testRoot}`);
}

const requireFromPackage = createRequire(path.join(process.cwd(), 'package.json'));
const tsxCli = requireFromPackage.resolve('tsx/cli');
const child = spawn(process.execPath, [tsxCli, '--test', ...testFiles], {
  stdio: 'inherit',
  windowsHide: true,
});

child.once('error', (error) => {
  throw error;
});
child.once('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
