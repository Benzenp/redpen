/**
 * Daemon discovery record (docs/ARCHITECTURE.md §3.4).
 *
 * Written to the OS-specific global app-data directory (never the repo) once
 * the daemon's HTTP server is listening. CLI commands read this file to find
 * the daemon; if it's missing or stale (the recorded PID is dead), the CLI
 * auto-starts a new daemon.
 */
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { daemonDiscoveryFilePath, globalAppDataDir } from '@redpen/protocol/paths';

export interface DaemonDiscovery {
  pid: number;
  port: number;
  token: string;
  startedAt: string;
}

export async function writeDaemonDiscovery(discovery: DaemonDiscovery): Promise<void> {
  await mkdir(globalAppDataDir(), { recursive: true });
  await writeFile(daemonDiscoveryFilePath(), JSON.stringify(discovery, null, 2));
}

export async function readDaemonDiscovery(): Promise<DaemonDiscovery | null> {
  try {
    const raw = await readFile(daemonDiscoveryFilePath(), 'utf8');
    return JSON.parse(raw) as DaemonDiscovery;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function clearDaemonDiscovery(): Promise<void> {
  await rm(daemonDiscoveryFilePath(), { force: true });
}

/** True if a process with this PID is currently alive (best-effort, cross-platform). */
export function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 does not kill the process; it only checks permission/existence.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export type DaemonHealth = 'running' | 'stale-pid' | 'hung' | 'not-running';

/**
 * Distinguishes a genuinely running daemon from a "half-dead" one: the PID
 * can be alive (survived a crash into a hung state, or belongs to a reused
 * PID from an unrelated process) while the HTTP server no longer answers.
 * `redpen daemon status` and `ensureDaemonRunning()` both use this instead
 * of relying on `isProcessAlive` alone.
 */
export async function probeDaemonHealth(discovery: DaemonDiscovery | null, timeoutMs = 2000): Promise<DaemonHealth> {
  if (!discovery) return 'not-running';
  if (!isProcessAlive(discovery.pid)) return 'stale-pid';

  // Uses node:http directly (not the global fetch/undici) so this probe
  // never shares undici's connection pool with the CLI's real request that
  // follows right after (see client/ensure-daemon.ts for why: two undici
  // requests in one short-lived process followed by process.exit() crashes
  // with a libuv assertion on Windows).
  const ok = await new Promise<boolean>((resolve) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: discovery.port,
        path: '/health',
        method: 'GET',
        headers: { Authorization: `Bearer ${discovery.token}` },
        timeout: timeoutMs,
      },
      (res) => {
        res.resume(); // drain and discard the body
        resolve((res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300);
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
    req.end();
  });

  return ok ? 'running' : 'hung';
}
