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
import { readDaemonDiscovery, isProcessAlive, type DaemonDiscovery } from '../daemon/discovery.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const daemonEntry = path.resolve(__dirname, '../daemon/main.ts');
const require = createRequire(import.meta.url);
const tsxCliPath = require.resolve('tsx/cli');

export async function ensureDaemonRunning(): Promise<DaemonDiscovery> {
  const existing = await readDaemonDiscovery();
  if (existing && isProcessAlive(existing.pid)) {
    return existing;
  }

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
