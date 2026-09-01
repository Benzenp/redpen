/**
 * Daemon discovery record (docs/ARCHITECTURE.md §3.4).
 *
 * Written to the OS-specific global app-data directory (never the repo) once
 * the daemon's HTTP server is listening. CLI commands read this file to find
 * the daemon; if it's missing or stale (the recorded PID is dead), the CLI
 * auto-starts a new daemon.
 */
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { dirname, join } from 'node:path';
import { daemonDiscoveryFilePath, globalAppDataDir } from '@redpen/protocol/paths';

export interface DaemonDiscovery {
  pid: number;
  port: number;
  token: string;
  startedAt: string;
}

const MAX_PID = 0x7fffffff;
const MAX_PORT = 65_535;
const ISO_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(?:Z|([+-])(\d{2}):(\d{2}))$/;

function isValidIsoDateTime(value: string): boolean {
  const match = ISO_DATE_TIME.exec(value);
  if (!match || Number.isNaN(Date.parse(value))) return false;

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, millisecondText, , offsetHourText, offsetMinuteText] =
    match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText);
  const offsetMinute = offsetMinuteText === undefined ? 0 : Number(offsetMinuteText);
  if (hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) return false;

  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, Number((millisecondText ?? '').padEnd(3, '0')));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function isDaemonDiscovery(value: unknown): value is DaemonDiscovery {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;

  const discovery = value as Partial<DaemonDiscovery>;
  return (
    typeof discovery.pid === 'number' &&
    Number.isInteger(discovery.pid) &&
    Number.isFinite(discovery.pid) &&
    discovery.pid > 0 &&
    discovery.pid <= MAX_PID &&
    typeof discovery.port === 'number' &&
    Number.isInteger(discovery.port) &&
    Number.isFinite(discovery.port) &&
    discovery.port > 0 &&
    discovery.port <= MAX_PORT &&
    typeof discovery.token === 'string' &&
    discovery.token.trim().length > 0 &&
    typeof discovery.startedAt === 'string' &&
    isValidIsoDateTime(discovery.startedAt)
  );
}

async function removeCorruptDiscovery(path: string): Promise<void> {
  await rm(path, { force: true }).catch(() => undefined);
}

export async function writeDaemonDiscovery(discovery: DaemonDiscovery): Promise<void> {
  if (!isDaemonDiscovery(discovery)) {
    throw new TypeError('Invalid daemon discovery record');
  }

  const directory = globalAppDataDir();
  const destination = daemonDiscoveryFilePath();
  const temporary = join(directory, `.daemon-${randomUUID()}.tmp`);

  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(directory, 0o700);

  try {
    // The exclusive temporary file prevents following a pre-existing link.
    await writeFile(temporary, JSON.stringify(discovery, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    if (process.platform !== 'win32') await chmod(temporary, 0o600);

    // rename replaces a symlink itself rather than its target. Removing an
    // existing link first also supports platforms where rename will not
    // replace an existing destination.
    const current = await lstat(destination).catch(() => null);
    if (current?.isSymbolicLink()) await rm(destination, { force: true });
    await rename(temporary, destination);
    if (process.platform !== 'win32') await chmod(destination, 0o600);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function readDaemonDiscovery(): Promise<DaemonDiscovery | null> {
  const path = daemonDiscoveryFilePath();
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile()) {
      await removeCorruptDiscovery(path);
      return null;
    }

    const discovery: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!isDaemonDiscovery(discovery)) {
      await removeCorruptDiscovery(path);
      return null;
    }
    return discovery;
  } catch {
    await removeCorruptDiscovery(path);
    return null;
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
  const challenge = randomUUID();
  const expectedProof = createHmac('sha256', discovery.token).update(challenge).digest();
  const ok = await new Promise<boolean>((resolve) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: discovery.port,
        path: `/health?challenge=${encodeURIComponent(challenge)}`,
        method: 'GET',
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes <= 1_024) chunks.push(chunk);
        });
        res.on('end', () => {
          if (res.statusCode !== 200 || bytes > 1_024) {
            resolve(false);
            return;
          }
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { ok?: unknown; proof?: unknown };
            if (body.ok !== true || typeof body.proof !== 'string' || !/^[0-9a-f]{64}$/.test(body.proof)) {
              resolve(false);
              return;
            }
            resolve(timingSafeEqual(expectedProof, Buffer.from(body.proof, 'hex')));
          } catch {
            resolve(false);
          }
        });
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
    req.end();
  });

  return ok ? 'running' : 'hung';
}

export async function requestDaemonShutdown(discovery: DaemonDiscovery, timeoutMs = 2_000): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: discovery.port,
        path: '/shutdown',
        method: 'POST',
        headers: { Authorization: `Bearer ${discovery.token}` },
        timeout: timeoutMs,
      },
      (res) => {
        res.resume();
        if (res.statusCode === 202) resolve();
        else reject(new Error(`daemon shutdown request failed with HTTP ${res.statusCode ?? 0}`));
      },
    );
    req.on('timeout', () => req.destroy(new Error('daemon shutdown request timed out')));
    req.on('error', reject);
    req.end();
  });
}
