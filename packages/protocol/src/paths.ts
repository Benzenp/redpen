/**
 * Workspace and global application-data path resolution
 * (docs/ARCHITECTURE.md §3.4, §9; docs/IMPLEMENTATION_PLAN.md Phase 1).
 *
 * - Task bundles live under `<workspace>/.redpen/tasks/<task-id>/`.
 * - Daemon discovery records / browser profile live under a per-OS global
 *   application-data directory, OUTSIDE the repository, per
 *   docs/ARCHITECTURE.md §9 ("browser profile은 repository 밖 전용 디렉터리를 사용한다").
 */
import path from 'node:path';
import os from 'node:os';

export class PathTraversalError extends Error {
  constructor(public readonly attempted: string) {
    super(`refused to resolve path outside allowed root: ${attempted}`);
    this.name = 'PathTraversalError';
  }
}

/** Rejects any id containing path separators or `..` before it is used in a path. */
export function assertSafeIdSegment(id: string): void {
  if (!id || id.includes('..') || id.includes('/') || id.includes('\\') || id.includes('\0')) {
    throw new PathTraversalError(id);
  }
}

export function redpenRootDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.redpen');
}

export function tasksDir(workspaceRoot: string): string {
  return path.join(redpenRootDir(workspaceRoot), 'tasks');
}

export function taskDir(workspaceRoot: string, taskId: string): string {
  assertSafeIdSegment(taskId);
  const dir = path.join(tasksDir(workspaceRoot), taskId);
  const resolvedRoot = path.resolve(tasksDir(workspaceRoot));
  const resolvedDir = path.resolve(dir);
  if (!resolvedDir.startsWith(resolvedRoot + path.sep) && resolvedDir !== resolvedRoot) {
    throw new PathTraversalError(taskId);
  }
  return dir;
}

export function taskTmpDir(workspaceRoot: string, taskId: string): string {
  assertSafeIdSegment(taskId);
  return path.join(tasksDir(workspaceRoot), `.tmp-${taskId}`);
}

export function latestPointerPath(workspaceRoot: string): string {
  return path.join(redpenRootDir(workspaceRoot), 'latest.json');
}

function appDataRoot(): string {
  const platform = os.platform();
  if (platform === 'win32') {
    return process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
  }
  if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support');
  }
  return process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share');
}

export function globalAppDataDir(): string {
  return path.join(appDataRoot(), 'redpen');
}

export function daemonDiscoveryFilePath(): string {
  return path.join(globalAppDataDir(), 'daemon.json');
}

export function browserProfileDir(): string {
  return path.join(globalAppDataDir(), 'browser-profile');
}
