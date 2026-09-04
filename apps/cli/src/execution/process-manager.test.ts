import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ManagedExecutionProcessManager } from './process-manager.js';

const NODE = process.execPath;

async function temporaryDirectory(t: test.TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'redpen-process-manager-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function unusedLoopbackUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return url;
}

async function processIsGone(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`owned child process ${pid} is still running`);
}

async function childPid(file: string): Promise<number> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      return Number((await readFile(file, 'utf8')).trim());
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  assert.fail('fixture did not write its child pid');
}

const TREE_FIXTURE = [
  "const { spawn } = require('node:child_process');",
  "const { writeFileSync } = require('node:fs');",
  "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
  'writeFileSync(process.argv[1], String(child.pid));',
  'setInterval(() => {}, 1000);',
].join('');

test('captures successful child exit and output', async (t) => {
  const cwd = await temporaryDirectory(t);
  const manager = new ManagedExecutionProcessManager();
  await manager.start({ id: 'success', kind: 'agent', cwd, command: NODE, args: ['-e', "process.stdout.write('out'); process.stderr.write('err')"] });
  const result = await manager.wait('success');
  assert.equal(result.status, 'exited');
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'out');
  assert.equal(result.stderr, 'err');
  assert.equal(manager.get('success')?.pid, result.pid);
});

test('launches package-manager command shims without a shell', async (t) => {
  const cwd = await temporaryDirectory(t);
  const manager = new ManagedExecutionProcessManager();
  await manager.start({ id: 'npm-shim', kind: 'agent', cwd, command: 'npm', args: ['--version'] });
  const result = await manager.wait('npm-shim');
  assert.equal(result.status, 'exited');
  assert.match(result.stdout, /^\d+\./);
});

test('waits for a loopback HTTP server to become ready', async (t) => {
  const cwd = await temporaryDirectory(t);
  const url = await unusedLoopbackUrl();
  const port = new URL(url).port;
  const manager = new ManagedExecutionProcessManager();
  const started = await manager.start({
    id: 'ready-server', kind: 'candidate-server', cwd, command: NODE,
    args: ['-e', `require('node:http').createServer((_, response) => response.end('ok')).listen(${port}, '127.0.0.1')`],
    readyUrl: url, readyTimeoutMs: 5_000,
  });
  assert.equal(started.status, 'ready');
  assert.ok(started.readyAt);
  await manager.stop('ready-server');
});

test('readiness timeout terminates the complete owned process tree', async (t) => {
  const cwd = await temporaryDirectory(t);
  const pidFile = path.join(cwd, 'timeout-child.pid');
  const manager = new ManagedExecutionProcessManager();
  await assert.rejects(manager.start({
    id: 'timeout-tree', kind: 'candidate-server', cwd, command: NODE, args: ['-e', TREE_FIXTURE, pidFile],
    readyUrl: await unusedLoopbackUrl(), readyTimeoutMs: 250,
  }), /readiness timed out/);
  const record = manager.get('timeout-tree');
  assert.equal(record?.status, 'stopped');
  await processIsGone(await childPid(pidFile));
});

test('explicit stop terminates the complete owned process tree', async (t) => {
  const cwd = await temporaryDirectory(t);
  const pidFile = path.join(cwd, 'stopped-child.pid');
  const manager = new ManagedExecutionProcessManager();
  const started = await manager.start({ id: 'stop-tree', kind: 'agent', cwd, command: NODE, args: ['-e', TREE_FIXTURE, pidFile] });
  await manager.stop('stop-tree');
  assert.equal(manager.get('stop-tree')?.status, 'stopped');
  await processIsGone(started.pid);
  await processIsGone(await childPid(pidFile));
});

test('rejects remote ready URLs before starting a child', async (t) => {
  const cwd = await temporaryDirectory(t);
  const manager = new ManagedExecutionProcessManager();
  await assert.rejects(manager.start({ id: 'remote', kind: 'preview-server', cwd, command: NODE, args: ['-e', 'process.exit(0)'], readyUrl: 'https://example.com' }));
  assert.equal(manager.get('remote'), undefined);
});

test('rejects duplicate live process IDs', async (t) => {
  const cwd = await temporaryDirectory(t);
  const manager = new ManagedExecutionProcessManager();
  await manager.start({ id: 'duplicate', kind: 'agent', cwd, command: NODE, args: ['-e', 'setInterval(() => {}, 1000)'] });
  await assert.rejects(manager.start({ id: 'duplicate', kind: 'agent', cwd, command: NODE, args: ['-e', 'process.exit(0)'] }), /already live/);
  await manager.stop('duplicate');
});

test('retains only the rolling 64 KiB of output', async (t) => {
  const cwd = await temporaryDirectory(t);
  const manager = new ManagedExecutionProcessManager();
  await manager.start({ id: 'bounded-output', kind: 'agent', cwd, command: NODE, args: ['-e', "process.stdout.write('a'.repeat(70 * 1024)); process.stderr.write('b'.repeat(70 * 1024))"] });
  const result = await manager.wait('bounded-output');
  assert.equal(Buffer.byteLength(result.stdout), 64 * 1024);
  assert.equal(Buffer.byteLength(result.stderr), 64 * 1024);
  assert.match(result.stdout, /^a+$/);
  assert.match(result.stderr, /^b+$/);
});
