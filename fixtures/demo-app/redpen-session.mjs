#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDemoServer } from './serve.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(__dirname, '../..');
const cliEntry = path.join(workspaceRoot, 'apps', 'cli', 'bin', 'redpen.mjs');
const requestedPort = Number(process.argv[2] ?? 4173);
const parentPid = Number(process.env.REDPEN_OWNER_PID ?? process.ppid);
const terminalStates = new Set(['done', 'cancelled']);

function appDataRoot() {
  if (process.platform === 'win32') {
    return process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support');
  }
  return process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share');
}

const redpenDataDir = path.join(appDataRoot(), 'redpen');
const discoveryPath = path.join(redpenDataDir, 'daemon.json');
const sessionsDir = path.join(redpenDataDir, 'sessions');

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function runCli(args, { allowFailure = false, timeoutMs = 20_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliEntry, ...args], {
      cwd: workspaceRoot,
      env: process.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const result = {
        code: timedOut ? 124 : code ?? 1,
        stdout: stdout.trim(),
        stderr: timedOut ? `redpen command timed out after ${timeoutMs}ms` : stderr.trim(),
      };
      if (result.code === 0 || allowFailure) resolve(result);
      else reject(new Error(result.stderr || result.stdout || `redpen exited with code ${result.code}`));
    });
  });
}

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

const demo = await startDemoServer(requestedPort);
const initialDiscovery = await readJson(discoveryPath).catch(() => null);
const daemonWasRunning = Boolean(initialDiscovery && isProcessAlive(initialDiscovery.pid));
let sessionId;
let pollTimer;
let ownerTimer;
let cleanupPromise;
let sawDaemon = false;
let startupComplete = false;
let pendingCleanup;

async function cleanup(reason, exitCode = 0) {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    if (pollTimer) clearInterval(pollTimer);
    if (ownerTimer) clearInterval(ownerTimer);

    const failures = [];
    if (sessionId) {
      try {
        const closeResult = await runCli(
          ['close', sessionId, '--shutdown-if-idle', '--json'],
          { allowFailure: true },
        );
        if (closeResult.code !== 0) {
          failures.push(`session close failed: ${closeResult.stderr || closeResult.stdout}`);
        }
      } catch (error) {
        failures.push(`session close failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else if (!daemonWasRunning) {
      try {
        const stopResult = await runCli(['daemon', 'stop', '--json'], { allowFailure: true });
        if (stopResult.code !== 0) {
          failures.push(`daemon stop failed: ${stopResult.stderr || stopResult.stdout}`);
        }
      } catch (error) {
        failures.push(`daemon stop failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    try {
      await demo.close();
    } catch (error) {
      failures.push(`demo server close failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    process.stdout.write(`${JSON.stringify({
      stopped: true,
      clean: failures.length === 0,
      reason,
      sessionId,
      url: demo.url,
      failures,
    })}\n`);
    process.exitCode = failures.length === 0 ? exitCode : 1;
  })();
  return cleanupPromise;
}

function requestCleanup(reason, exitCode = 0) {
  if (!startupComplete) {
    pendingCleanup ??= { reason, exitCode };
    return;
  }
  void cleanup(reason, exitCode);
}

process.once('SIGINT', () => requestCleanup('SIGINT'));
process.once('SIGTERM', () => requestCleanup('SIGTERM'));
ownerTimer = setInterval(() => {
  if (!isProcessAlive(parentPid)) requestCleanup('parent-exited');
}, 250);
ownerTimer.unref();

try {
  const opened = await runCli(['open', demo.url, '--project', workspaceRoot, '--json']);
  const payload = JSON.parse(opened.stdout);
  sessionId = payload.session.id;
  sawDaemon = true;
  startupComplete = true;
  if (pendingCleanup) {
    await cleanup(pendingCleanup.reason, pendingCleanup.exitCode);
  } else {
    process.stdout.write(`${JSON.stringify({ ready: true, sessionId, url: demo.url })}\n`);

    let pollRunning = false;
    pollTimer = setInterval(async () => {
      if (pollRunning || cleanupPromise) return;
      pollRunning = true;
      try {
        let discovery;
        try {
          discovery = await readJson(discoveryPath);
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
          discovery = null;
        }
        if (discovery && isProcessAlive(discovery.pid)) sawDaemon = true;
        else if (sawDaemon) {
          requestCleanup('browser-or-daemon-closed');
          return;
        }

        let session;
        try {
          session = await readJson(path.join(sessionsDir, `${sessionId}.json`));
        } catch (error) {
          if (error instanceof SyntaxError) return;
          throw error;
        }
        if (!session) {
          requestCleanup('session-closed');
          return;
        }
        if (terminalStates.has(session.state)) requestCleanup(`session-${session.state}`);
      } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
        requestCleanup('watcher-error', 1);
      } finally {
        pollRunning = false;
      }
    }, 250);
    pollTimer.unref();
  }
} catch (error) {
  startupComplete = true;
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  await cleanup(pendingCleanup?.reason ?? 'startup-error', pendingCleanup?.exitCode ?? 1);
}
