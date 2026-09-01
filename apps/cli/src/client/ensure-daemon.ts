/**
 * Daemon auto-discovery/auto-start (docs/IMPLEMENTATION_PLAN.md Phase 4).
 *
 * If a live daemon is already recorded, reuse it. Otherwise spawn a new
 * detached daemon process and wait for its readiness line on stdout before
 * returning its connection info.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, link, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { globalAppDataDir } from '@redpen/protocol/paths';
import { readDaemonDiscovery, isProcessAlive, probeDaemonHealth, clearDaemonDiscovery, type DaemonDiscovery } from '../daemon/discovery.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourceDaemonEntry = path.resolve(__dirname, '../daemon/main.ts');
const bundledDaemonEntry = path.resolve(__dirname, 'daemon.js');
const startupLockPath = path.join(globalAppDataDir(), 'daemon-start.lock');
const LOCK_WAIT_MS = 10_000;
const LOCK_RETRY_MS = 50;
const MALFORMED_LOCK_STALE_MS = 2_000;
const READY_TIMEOUT_MS = 10_000;
const MAX_STDERR_DIAGNOSTIC_BYTES = 4_096;

interface StartupLock {
  release(): Promise<void>;
}

interface LockOwner {
  pid: number;
  token: string;
}

export async function ensureDaemonRunning(): Promise<DaemonDiscovery> {
  const running = await findRunningDaemon();
  if (running) return running;

  const lock = await acquireStartupLock();
  try {
    // Another CLI may have started the daemon while this process waited for
    // the lock, so discovery must be checked again while owning the lock.
    const reread = await findRunningDaemon();
    if (reread) return reread;

    const discovery = await readDaemonDiscovery();
    if (discovery) {
      if (await waitForDaemonRecovery(discovery)) return discovery;
      // Never signal an unauthenticated PID. Clearing the stale discovery
      // lets a replacement start safely even when the OS reused that PID.
      await clearDaemonDiscovery();
    }
    return await spawnDaemon();
  } finally {
    await lock.release();
  }
}

async function findRunningDaemon(): Promise<DaemonDiscovery | null> {
  const discovery = await readDaemonDiscovery();
  if (!discovery) return null;
  return (await probeDaemonHealth(discovery)) === 'running' ? discovery : null;
}

async function waitForDaemonRecovery(discovery: DaemonDiscovery): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if ((await probeDaemonHealth(discovery, 750)) === 'running') return true;
    if (attempt < 2) await delay(250);
  }
  return false;
}

async function acquireStartupLock(): Promise<StartupLock> {
  await mkdir(globalAppDataDir(), { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(globalAppDataDir(), 0o700);

  const deadline = Date.now() + LOCK_WAIT_MS;
  while (Date.now() < deadline) {
    const token = randomUUID();
    const temporaryLockPath = path.join(globalAppDataDir(), `.daemon-start-${token}.tmp`);
    try {
      await writeFile(temporaryLockPath, JSON.stringify({ pid: process.pid, token }), {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      await link(temporaryLockPath, startupLockPath);
      await rm(temporaryLockPath, { force: true });
      if (process.platform !== 'win32') await chmod(startupLockPath, 0o600);
      return {
        release: async () => {
          const owner = await readLockOwner();
          if (owner?.token === token) await rm(startupLockPath, { force: true });
        },
      };
    } catch (error) {
      await rm(temporaryLockPath, { force: true }).catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;

      const owner = await readLockOwner();
      // A malformed lock, or one held by a PID which still exists, is not
      // demonstrably stale. Leave it in place and let the bounded wait fail.
      if (owner && !isProcessAlive(owner.pid)) {
        await rm(startupLockPath, { force: true });
        continue;
      }
      if (!owner) {
        const metadata = await lstat(startupLockPath).catch(() => null);
        if (metadata?.isFile() && Date.now() - metadata.mtimeMs >= MALFORMED_LOCK_STALE_MS) {
          await rm(startupLockPath, { force: true });
          continue;
        }
      }
      await delay(LOCK_RETRY_MS);
    }
  }
  throw new Error('timed out waiting for daemon startup lock');
}

async function readLockOwner(): Promise<LockOwner | null> {
  try {
    const metadata = await lstat(startupLockPath);
    if (!metadata.isFile()) return null;
    const value: unknown = JSON.parse(await readFile(startupLockPath, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const owner = value as Partial<LockOwner>;
    return typeof owner.pid === 'number' &&
      Number.isInteger(owner.pid) &&
      owner.pid > 0 &&
      typeof owner.token === 'string' &&
      owner.token.length > 0
      ? { pid: owner.pid, token: owner.token }
      : null;
  } catch {
    return null;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function spawnDaemon(): Promise<DaemonDiscovery> {
  return new Promise((resolve, reject) => {
    const daemonArgs = existsSync(bundledDaemonEntry)
      ? [bundledDaemonEntry]
      : [createRequire(import.meta.url).resolve('tsx/cli'), sourceDaemonEntry];
    const child = spawn(process.execPath, daemonArgs, {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let settled = false;
    let readinessSeen = false;
    let stderrDiagnostic = '';
    let buffered = '';
    const appendStderr = (chunk: Buffer) => {
      if (stderrDiagnostic.length >= MAX_STDERR_DIAGNOSTIC_BYTES) return;
      stderrDiagnostic += chunk.toString('utf8').slice(0, MAX_STDERR_DIAGNOSTIC_BYTES - stderrDiagnostic.length);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout?.off('data', onStdout);
      child.stderr?.off('data', appendStderr);
      child.off('error', onError);
      child.off('exit', onExit);
      child.stdout?.destroy();
      child.stderr?.destroy();
    };
    const settle = (result: { discovery: DaemonDiscovery } | { error: Error }) => {
      if (settled) return;
      settled = true;
      cleanup();
      if ('discovery' in result) {
        child.unref();
        resolve(result.discovery);
      } else {
        reject(result.error);
      }
    };
    const timeout = setTimeout(() => {
      if (settled) return;
      child.kill();
      settle({ error: new Error('daemon did not become ready within 10s') });
    }, READY_TIMEOUT_MS);

    const confirmReadiness = async () => {
      try {
        const discovery = await readDaemonDiscovery();
        if (!discovery) throw new Error('daemon started but discovery record is missing');
        if ((await probeDaemonHealth(discovery)) !== 'running') {
          throw new Error('daemon started but failed authenticated health verification');
        }
        settle({ discovery });
      } catch (error) {
        settle({ error: error instanceof Error ? error : new Error(String(error)) });
      }
    };
    const onStdout = (chunk: Buffer) => {
      buffered += chunk.toString('utf8');
      let newlineIndex: number;
      while ((newlineIndex = buffered.indexOf('\n')) !== -1) {
        const line = buffered.slice(0, newlineIndex);
        buffered = buffered.slice(newlineIndex + 1);
        try {
          const parsed = JSON.parse(line) as { ready?: unknown };
          if (parsed.ready === true && !readinessSeen && !settled) {
            readinessSeen = true;
            void confirmReadiness();
          }
        } catch {
          // Daemon logs can precede its JSON readiness line.
        }
      }
      // Do not let a child which never emits a newline retain unbounded data.
      if (buffered.length > MAX_STDERR_DIAGNOSTIC_BYTES) buffered = buffered.slice(-MAX_STDERR_DIAGNOSTIC_BYTES);
    };
    const onError = (error: Error) => {
      const diagnostic = stderrDiagnostic.trim();
      settle({ error: new Error(`${error.message}${diagnostic ? `: ${diagnostic}` : ''}`, { cause: error }) });
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      const diagnostic = stderrDiagnostic.trim();
      settle({
        error: new Error(
          `daemon exited before readiness (code ${code ?? 'none'}, signal ${signal ?? 'none'})${diagnostic ? `: ${diagnostic}` : ''}`,
        ),
      });
    };

    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', appendStderr);
    child.once('error', onError);
    child.once('exit', onExit);
  });
}
