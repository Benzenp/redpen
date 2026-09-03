import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertSafeSegment } from './git.js';
import { ExecutionError, type ExecutionRun } from './types.js';

function executionDirectory(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.redpen', 'executions');
}

function executionPath(workspaceRoot: string, runId: string): string {
  assertSafeSegment(runId, 'run id');
  return path.join(executionDirectory(workspaceRoot), `${runId}.json`);
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function validateRun(value: unknown): ExecutionRun {
  if (!value || typeof value !== 'object') throw new ExecutionError('execution record must be an object', 'INVALID_RUN');
  const run = value as ExecutionRun;
  assertSafeSegment(run.id, 'run id');
  if (typeof run.workspaceRoot !== 'string' || !path.isAbsolute(run.workspaceRoot)) {
    throw new ExecutionError('execution workspace root must be absolute', 'INVALID_RUN');
  }
  if (typeof run.baseCommit !== 'string' || !/^[0-9a-f]{40,64}$/i.test(run.baseCommit)) {
    throw new ExecutionError('execution base commit is invalid', 'INVALID_RUN');
  }
  if (!Array.isArray(run.tasks) || run.tasks.length > 9 || !isIsoTimestamp(run.createdAt) || !isIsoTimestamp(run.updatedAt)) {
    throw new ExecutionError('execution record has invalid tasks or timestamps', 'INVALID_RUN');
  }
  for (const task of run.tasks) {
    assertSafeSegment(task.id, 'task id');
    if (typeof task.name !== 'string' || !Array.isArray(task.candidates)) throw new ExecutionError('execution task is invalid', 'INVALID_RUN');
    for (const candidate of task.candidates) {
      assertSafeSegment(candidate.id, 'candidate id');
      if (typeof candidate.branch !== 'string' || typeof candidate.worktreePath !== 'string' || !path.isAbsolute(candidate.worktreePath)) {
        throw new ExecutionError('execution candidate path is invalid', 'INVALID_RUN');
      }
      if (candidate.status !== 'draft' && candidate.status !== 'sealed') throw new ExecutionError('execution candidate status is invalid', 'INVALID_RUN');
      if (typeof candidate.selected !== 'boolean' || !isIsoTimestamp(candidate.createdAt)) throw new ExecutionError('execution candidate is invalid', 'INVALID_RUN');
      if (candidate.commit !== undefined && !/^[0-9a-f]{40,64}$/i.test(candidate.commit)) throw new ExecutionError('execution candidate commit is invalid', 'INVALID_RUN');
    }
  }
  return run;
}

export class ExecutionStore {
  async load(workspaceRoot: string, runId: string): Promise<ExecutionRun | null> {
    try {
      return validateRun(JSON.parse(await readFile(executionPath(workspaceRoot, runId), 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async save(run: ExecutionRun): Promise<void> {
    const validated = validateRun(run);
    const directory = executionDirectory(validated.workspaceRoot);
    await mkdir(directory, { recursive: true });
    const destination = executionPath(validated.workspaceRoot, validated.id);
    const temporary = path.join(directory, `.${validated.id}.${process.pid}.${Date.now()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, 'utf8');
    await rename(temporary, destination);
  }
}
