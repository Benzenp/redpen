import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { ExecutionError } from './types.js';

const execFile = promisify(execFileCallback);

export interface GitCommandFailure {
  args: string[];
  cwd: string;
  stdout: string;
  stderr: string;
}

export class GitError extends ExecutionError {
  constructor(message: string, readonly details: GitCommandFailure) {
    super(message, 'GIT_COMMAND_FAILED');
    this.name = 'GitError';
  }
}

export async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFile('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  } catch (error) {
    const failed = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    throw new GitError(`git ${args.join(' ')} failed: ${failed.stderr?.trim() || failed.message}`, {
      args,
      cwd,
      stdout: failed.stdout ?? '',
      stderr: failed.stderr ?? '',
    });
  }
}

export async function canonicalGitTopLevel(workspaceRoot: string): Promise<string> {
  const topLevel = (await git(path.resolve(workspaceRoot), ['rev-parse', '--show-toplevel'])).trim();
  if (!topLevel) throw new ExecutionError('git did not report a repository top level', 'INVALID_REPOSITORY');
  return realpath(topLevel);
}

export function assertSafeSegment(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)) {
    throw new ExecutionError(`${label} must be a safe path and branch segment`, 'UNSAFE_ID');
  }
}

export function assertContainedPath(root: string, target: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new ExecutionError(`path is outside manager-owned worktree directory: ${target}`, 'UNSAFE_PATH');
  }
}
