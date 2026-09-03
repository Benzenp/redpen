import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertContainedPath, assertSafeSegment, canonicalGitTopLevel, git, GitError } from './git.js';
import { ExecutionStore } from './store.js';
import {
  CherryPickError,
  ExecutionError,
  type CandidateInspection,
  type ExecutionCandidate,
  type ExecutionRun,
  type ExecutionTask,
  type IntegrationResult,
} from './types.js';

function now(): string {
  return new Date().toISOString();
}

function worktreesRoot(run: ExecutionRun): string {
  return path.join(run.workspaceRoot, '.redpen', 'worktrees', run.id);
}

function managedWorktreePath(run: ExecutionRun, ...segments: string[]): string {
  for (const segment of segments) assertSafeSegment(segment, 'worktree segment');
  const target = path.join(worktreesRoot(run), ...segments);
  assertContainedPath(worktreesRoot(run), target);
  return target;
}

function taskFor(run: ExecutionRun, taskId: string): ExecutionTask {
  assertSafeSegment(taskId, 'task id');
  const task = run.tasks.find((entry) => entry.id === taskId);
  if (!task) throw new ExecutionError(`task not found: ${taskId}`, 'TASK_NOT_FOUND');
  return task;
}

function candidateFor(task: ExecutionTask, candidateId: string): ExecutionCandidate {
  assertSafeSegment(candidateId, 'candidate id');
  const candidate = task.candidates.find((entry) => entry.id === candidateId);
  if (!candidate) throw new ExecutionError(`candidate not found: ${candidateId}`, 'CANDIDATE_NOT_FOUND');
  return candidate;
}

function taskIdAt(index: number): string {
  return `task-${index + 1}`;
}

function candidateId(): string {
  return `candidate-${randomUUID()}`;
}

function parseNameStatus(raw: string): Array<{ status: string; path: string }> {
  return raw.split('\n').filter(Boolean).map((line) => {
    const tab = line.indexOf('\t');
    return tab === -1 ? { status: line, path: '' } : { status: line.slice(0, tab), path: line.slice(tab + 1) };
  });
}

export class ExecutionManager {
  constructor(private readonly store = new ExecutionStore()) {}

  async createRun(options: { workspaceRoot: string; taskNames: string[]; baseRef?: string }): Promise<ExecutionRun> {
    if (!Array.isArray(options.taskNames) || options.taskNames.length === 0 || options.taskNames.length > 9) {
      throw new ExecutionError('an execution run requires between 1 and 9 tasks', 'TASK_LIMIT');
    }
    if (options.taskNames.some((name) => typeof name !== 'string' || name.trim() === '')) {
      throw new ExecutionError('task names must be non-empty strings', 'INVALID_TASK_NAME');
    }
    const workspaceRoot = await canonicalGitTopLevel(options.workspaceRoot);
    const baseRef = options.baseRef ?? 'HEAD';
    if (!baseRef || /[\r\n\0]/.test(baseRef)) throw new ExecutionError('base ref is invalid', 'INVALID_BASE_REF');
    const baseCommit = (await git(workspaceRoot, ['rev-parse', '--verify', `${baseRef}^{commit}`])).trim();
    const timestamp = now();
    const run: ExecutionRun = {
      id: `run-${randomUUID()}`,
      workspaceRoot,
      baseCommit,
      tasks: options.taskNames.map((name, index) => ({ id: taskIdAt(index), name: name.trim(), candidates: [] })),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.store.save(run);
    return run;
  }

  async getRun(workspaceRoot: string, runId: string): Promise<ExecutionRun> {
    assertSafeSegment(runId, 'run id');
    const canonicalRoot = await canonicalGitTopLevel(workspaceRoot);
    const run = await this.store.load(canonicalRoot, runId);
    if (!run) throw new ExecutionError(`execution run not found: ${runId}`, 'RUN_NOT_FOUND');
    if (run.workspaceRoot !== canonicalRoot) throw new ExecutionError('execution run belongs to another workspace', 'WORKSPACE_MISMATCH');
    return run;
  }

  async addCandidate(workspaceRoot: string, runId: string, taskId: string): Promise<ExecutionCandidate> {
    const run = await this.getRun(workspaceRoot, runId);
    const task = taskFor(run, taskId);
    const id = candidateId();
    assertSafeSegment(id, 'candidate id');
    const candidate: ExecutionCandidate = {
      id,
      branch: `redpen/execution/${run.id}/${task.id}/${id}`,
      worktreePath: managedWorktreePath(run, task.id, id),
      status: 'draft',
      selected: false,
      createdAt: now(),
    };
    await mkdir(path.dirname(candidate.worktreePath), { recursive: true });
    await git(run.workspaceRoot, ['worktree', 'add', '-b', candidate.branch, candidate.worktreePath, run.baseCommit]);
    task.candidates.push(candidate);
    run.updatedAt = now();
    try {
      await this.store.save(run);
    } catch (error) {
      await this.removeManagedWorktree(run, candidate.worktreePath);
      throw error;
    }
    return candidate;
  }

  async inspectCandidate(workspaceRoot: string, runId: string, taskId: string, candidateIdValue: string): Promise<CandidateInspection> {
    const run = await this.getRun(workspaceRoot, runId);
    const candidate = candidateFor(taskFor(run, taskId), candidateIdValue);
    this.assertCandidatePath(run, candidate);
    const [porcelain, headCommit, names, stat, patch] = await Promise.all([
      git(candidate.worktreePath, ['status', '--porcelain']),
      git(candidate.worktreePath, ['rev-parse', 'HEAD']),
      git(candidate.worktreePath, ['diff', '--name-status', run.baseCommit]),
      git(candidate.worktreePath, ['diff', '--stat', run.baseCommit]),
      git(candidate.worktreePath, ['diff', '--binary', run.baseCommit]),
    ]);
    return { clean: porcelain.trim() === '', headCommit: headCommit.trim(), changedFiles: parseNameStatus(names), stat, patch };
  }

  async sealCandidate(workspaceRoot: string, runId: string, taskId: string, candidateIdValue: string): Promise<ExecutionCandidate> {
    const run = await this.getRun(workspaceRoot, runId);
    const candidate = candidateFor(taskFor(run, taskId), candidateIdValue);
    if (candidate.status === 'sealed') return candidate;
    const inspection = await this.inspectCandidate(run.workspaceRoot, run.id, taskId, candidate.id);
    if (!inspection.clean) throw new ExecutionError('candidate worktree must be clean before sealing', 'DIRTY_CANDIDATE');
    if (inspection.headCommit === run.baseCommit) throw new ExecutionError('candidate must contain a commit different from the base', 'EMPTY_CANDIDATE');
    const commitCount = Number((await git(candidate.worktreePath, ['rev-list', '--count', `${run.baseCommit}..${inspection.headCommit}`])).trim());
    if (commitCount !== 1) throw new ExecutionError('candidate must contain exactly one commit on top of the base', 'CANDIDATE_NOT_SQUASHED');
    candidate.status = 'sealed';
    candidate.commit = inspection.headCommit;
    candidate.diffSummary = { changedFiles: inspection.changedFiles.map((file) => `${file.status}\t${file.path}`), stat: inspection.stat };
    candidate.sealedAt = now();
    run.updatedAt = now();
    await this.store.save(run);
    return candidate;
  }

  async selectCandidate(workspaceRoot: string, runId: string, taskId: string, candidateIdValue: string): Promise<ExecutionRun> {
    const run = await this.getRun(workspaceRoot, runId);
    const task = taskFor(run, taskId);
    const selected = candidateFor(task, candidateIdValue);
    if (selected.status !== 'sealed' || !selected.commit) throw new ExecutionError('only sealed candidates can be selected', 'CANDIDATE_NOT_SEALED');
    for (const candidate of task.candidates) candidate.selected = candidate.id === selected.id;
    run.updatedAt = now();
    await this.store.save(run);
    return run;
  }

  async buildPreview(workspaceRoot: string, runId: string, includedTaskIds?: string[]): Promise<IntegrationResult> {
    return this.buildIntegration(workspaceRoot, runId, 'preview', includedTaskIds);
  }

  async buildFinal(workspaceRoot: string, runId: string, includedTaskIds?: string[]): Promise<IntegrationResult> {
    return this.buildIntegration(workspaceRoot, runId, 'final', includedTaskIds);
  }

  private async buildIntegration(workspaceRoot: string, runId: string, kind: 'preview' | 'final', includedTaskIds?: string[]): Promise<IntegrationResult> {
    const run = await this.getRun(workspaceRoot, runId);
    const taskIds = includedTaskIds ?? run.tasks.map((task) => task.id);
    if (new Set(taskIds).size !== taskIds.length) throw new ExecutionError('included task ids must be unique', 'INVALID_TASK_SELECTION');
    const selected = taskIds.map((taskId) => {
      const task = taskFor(run, taskId);
      const candidate = task.candidates.find((entry) => entry.selected);
      if (!candidate || candidate.status !== 'sealed' || !candidate.commit) {
        throw new ExecutionError(`task ${taskId} has no selected sealed candidate`, 'MISSING_SELECTION');
      }
      return { taskId, candidate, commit: candidate.commit };
    });
    const worktreePath = managedWorktreePath(run, kind);
    const branch = `redpen/${kind}/${run.id}`;
    await this.replaceIntegrationWorktree(run, branch, worktreePath);
    const commits: string[] = [];
    for (const { candidate, commit } of selected) {
      try {
        await git(worktreePath, ['cherry-pick', commit]);
        commits.push(commit);
      } catch (error) {
        const gitError = error instanceof GitError ? error : undefined;
        try {
          await git(worktreePath, ['cherry-pick', '--abort']);
        } catch {
          // The original cherry-pick failure is more useful than an abort failure.
        }
        throw new CherryPickError(`failed to cherry-pick candidate ${candidate.id}`, {
          branch,
          worktreePath,
          candidateId: candidate.id,
          commit,
          stderr: gitError?.details.stderr ?? String(error),
        });
      }
    }
    return { branch, worktreePath, baseCommit: run.baseCommit, includedTaskIds: taskIds, commits };
  }

  private async replaceIntegrationWorktree(run: ExecutionRun, branch: string, worktreePath: string): Promise<void> {
    await this.removeManagedWorktree(run, worktreePath);
    await mkdir(path.dirname(worktreePath), { recursive: true });
    await git(run.workspaceRoot, ['worktree', 'add', '-B', branch, worktreePath, run.baseCommit]);
  }

  private async removeManagedWorktree(run: ExecutionRun, worktreePath: string): Promise<void> {
    assertContainedPath(worktreesRoot(run), worktreePath);
    try {
      await git(run.workspaceRoot, ['worktree', 'remove', '--force', worktreePath]);
    } catch {
      // It may be an interrupted creation which Git never registered.
    }
    await rm(worktreePath, { recursive: true, force: true });
  }

  private assertCandidatePath(run: ExecutionRun, candidate: ExecutionCandidate): void {
    assertSafeSegment(candidate.id, 'candidate id');
    for (const segment of candidate.branch.split('/')) assertSafeSegment(segment, 'candidate branch segment');
    assertContainedPath(worktreesRoot(run), candidate.worktreePath);
  }
}
