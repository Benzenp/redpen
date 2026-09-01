/**
 * Daemon discovery record (docs/ARCHITECTURE.md §3.4).
 *
 * Written to the OS-specific global app-data directory (never the repo) once
 * the daemon's HTTP server is listening. CLI commands read this file to find
 * the daemon; if it's missing or stale (the recorded PID is dead), the CLI
 * auto-starts a new daemon.
 */
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
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
