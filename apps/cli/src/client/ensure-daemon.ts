/**
 * Daemon auto-discovery/auto-start (docs/IMPLEMENTATION_PLAN.md Phase 4).
 *
 * If a live daemon is already recorded, reuse it. Otherwise spawn a new
 * detached daemon process and wait for its readiness line on stdout before
 * returning its connection info.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { readDaemonDiscovery, isProcessAlive, probeDaemonHealth, clearDaemonDiscovery, type DaemonDiscovery } from '../daemon/discovery.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const daemonEntry = path.resolve(__dirname, '../daemon/main.ts');
const require = createRequire(import.meta.url);
const tsxCliPath = require.resolve('tsx/cli');

export async function ensureDaemonRunning(): Promise<DaemonDiscovery> {
  const existing = await readDaemonDiscovery();
  if (!existing) {
    return spawnDaemon();
  }
  if (!isProcessAlive(existing.pid)) {
    await clearDaemonDiscovery();
    return spawnDaemon();
  }

  // PID is alive; still need to distinguish a genuinely running daemon from
  // a hung one (docs/IMPLEMENTATION_PLAN.md's "stale-lock 복구" gap: alive
  // PID + unresponsive port). `probeDaemonHealth` deliberately probes via
  // `node:http` rather than `fetch`/undici, because every CLI command that
  // reaches this point goes on to make its own real request via `fetch`
  // and then calls `process.exit()`; two undici requests in the same
  // short-lived process followed by a forced exit reliably crashes with a
  // libuv assertion on Windows ("Assertion failed:
  // !(handle->flags & UV_HANDLE_CLOSING)", src/win/async.c). Keeping the
  // probe off undici's connection pool avoids that interaction entirely.
  const health = await probeDaemonHealth(existing);
  if (health === 'running') {
    return existing;
  }

  if (health === 'hung') {
    try {
      process.kill(existing.pid, 'SIGTERM');
    } catch {
      // already gone between the health probe and here; ignore.
    }
  }

  await clearDaemonDiscovery();
  return spawnDaemon();
}

function spawnDaemon(): Promise<DaemonDiscovery> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsxCliPath, daemonEntry], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill();
        reject(new Error('daemon did not become ready within 10s'));
      }
    }, 10_000);

    let buffered = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf8');
      const newlineIndex = buffered.indexOf('\n');
      if (newlineIndex === -1) return;
      const line = buffered.slice(0, newlineIndex);
      try {
        const parsed = JSON.parse(line) as { ready: boolean; port: number; pid: number };
        if (parsed.ready && !settled) {
          settled = true;
          clearTimeout(timeout);
          child.unref();
          // The daemon writes its own discovery file with the real token;
          // re-read it now that we know it is up.
          import('../daemon/discovery.js').then(({ readDaemonDiscovery: reread }) =>
            reread().then((discovery) => {
              if (discovery) resolve(discovery);
              else reject(new Error('daemon started but discovery record is missing'));
            }),
          );
        }
      } catch {
        // Not a JSON readiness line yet; keep buffering.
      }
    });

    child.once('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(err);
      }
    });
  });
}
