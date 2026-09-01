/**
 * Session persistence (docs/ARCHITECTURE.md §2.4 "Recoverable sessions").
 *
 * Sessions are process-lifetime browser state bound to a daemon, but the
 * session *record* (id, state, targetUrl, workspaceRoot, activeTaskId) must
 * survive a daemon restart so `redpen list`/`status` still work and a
 * submitted task is never lost. Each session is stored as one JSON file
 * under the global app-data directory (never the repo — sessions are not
 * workspace content, task bundles are).
 */
import { mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { globalAppDataDir } from '@redpen/protocol/paths';
import { visualSessionSchema, type VisualSession } from '@redpen/protocol/schema';

function sessionsDir(): string {
  return path.join(globalAppDataDir(), 'sessions');
}

function sessionFilePath(id: string): string {
  if (!id || id.includes('..') || id.includes('/') || id.includes('\\')) {
    throw new Error(`invalid session id: ${id}`);
  }
  return path.join(sessionsDir(), `${id}.json`);
}

export async function saveSession(session: VisualSession): Promise<void> {
  const validated = visualSessionSchema.parse(session);
  await mkdir(sessionsDir(), { recursive: true });
  await writeFile(sessionFilePath(validated.id), JSON.stringify(validated, null, 2));
}

export async function loadSession(id: string): Promise<VisualSession | null> {
  try {
    const raw = await readFile(sessionFilePath(id), 'utf8');
    return visualSessionSchema.parse(JSON.parse(raw));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function listSessions(filter?: { workspaceRoot?: string }): Promise<VisualSession[]> {
  let files: string[];
  try {
    files = await readdir(sessionsDir());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const sessions: VisualSession[] = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const raw = await readFile(path.join(sessionsDir(), file), 'utf8');
    const session = visualSessionSchema.parse(JSON.parse(raw));
    if (filter?.workspaceRoot && path.resolve(session.workspaceRoot) !== path.resolve(filter.workspaceRoot)) {
      continue;
    }
    sessions.push(session);
  }
  return sessions.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function deleteSession(id: string): Promise<void> {
  await rm(sessionFilePath(id), { force: true });
}
