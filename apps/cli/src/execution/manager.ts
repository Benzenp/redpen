import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import crossSpawn from 'cross-spawn';
import { assertContainedPath, assertSafeSegment, canonicalGitTopLevel, git, GitError } from './git.js';
import { ExecutionStore } from './store.js';
import {
  CherryPickError,
  ExecutionError,
  type CandidateInspection,
  type ExecutionCandidate,
  type ExecutionRun,
  type ExecutionTask,
  type FinalPublishResult,
  type IntegrationResult,
  VerificationError,
} from './types.js';

const verificationOutputLimit = 64 * 1024;
const verificationTimeoutMs = 10 * 60_000;

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

function boundedOutput(value: string | Buffer | undefined): string {
  const text = value?.toString() ?? '';
  return text.length <= verificationOutputLimit ? text : `${text.slice(0, verificationOutputLimit)}\n[output truncated]`;
}

function appendBounded(current: Buffer, chunk: Buffer): Buffer {
  const combined = current.length === 0 ? chunk : Buffer.concat([current, chunk]);
  return combined.length <= verificationOutputLimit
    ? combined
    : combined.subarray(combined.length - verificationOutputLimit);
}

function assertRemote(remote: string): void {
  if (!remote || remote.startsWith('-') || /[\r\n\0]/.test(remote)) {
    throw new ExecutionError('remote name is invalid', 'INVALID_REMOTE');
  }
}

function assertBranchName(branch: string): void {
  if (!branch || branch.startsWith('-') || /[\r\n\0]/.test(branch)) {
    throw new ExecutionError('branch name is invalid', 'INVALID_BRANCH');
  }
}

export class ExecutionManager {
  constructor(private readonly store = new ExecutionStore()) {}

  async createRun(options: {
    workspaceRoot: string;
    taskNames?: string[];
    tasks?: Array<{ name: string; sourceGroupId?: string; instruction?: string }>;
    sourceTaskId?: string;
    baseRef?: string;
  }): Promise<ExecutionRun> {
    if ((options.taskNames === undefined) === (options.tasks === undefined)) {
      throw new ExecutionError('provide exactly one of taskNames or tasks', 'INVALID_TASKS');
    }
    const tasks: Array<{ name: string; sourceGroupId?: string; instruction?: string }> =
      options.tasks ?? options.taskNames!.map((name) => ({ name }));
    if (!Array.isArray(tasks) || tasks.length === 0 || tasks.length > 9) {
      throw new ExecutionError('an execution run requires between 1 and 9 tasks', 'TASK_LIMIT');
    }
    if (tasks.some((task) => typeof task?.name !== 'string' || task.name.trim() === ''
      || (task.sourceGroupId !== undefined && (typeof task.sourceGroupId !== 'string' || task.sourceGroupId.trim() === ''))
      || (task.instruction !== undefined && typeof task.instruction !== 'string'))) {
      throw new ExecutionError('task names must be non-empty strings', 'INVALID_TASK_NAME');
    }
    if (options.sourceTaskId !== undefined && (typeof options.sourceTaskId !== 'string' || options.sourceTaskId.trim() === '')) {
      throw new ExecutionError('source task id must be a non-empty string', 'INVALID_SOURCE_TASK_ID');
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
      ...(options.sourceTaskId === undefined ? {} : { sourceTaskId: options.sourceTaskId }),
      tasks: tasks.map((task, index) => ({
        id: taskIdAt(index),
        name: task.name.trim(),
        ...(task.sourceGroupId === undefined ? {} : { sourceGroupId: task.sourceGroupId }),
        ...(task.instruction === undefined ? {} : { instruction: task.instruction }),
        candidates: [],
      })),
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

  async discardRun(workspaceRoot: string, runId: string): Promise<void> {
    const run = await this.getRun(workspaceRoot, runId);
    for (const task of run.tasks) {
      for (const candidate of task.candidates) {
        await this.removeManagedWorktree(run, candidate.worktreePath);
        await git(run.workspaceRoot, ['branch', '-D', candidate.branch]).catch(() => {});
      }
    }
    for (const kind of ['preview', 'final'] as const) {
      await this.removeManagedWorktree(run, managedWorktreePath(run, kind));
      await git(run.workspaceRoot, ['branch', '-D', `redpen/${kind}/${run.id}`]).catch(() => {});
    }
    await this.store.delete(run.workspaceRoot, run.id);
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
    if (candidate.status === 'sealed' || candidate.status === 'published') return candidate;
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

  async finalizeCandidate(options: {
    workspaceRoot: string;
    runId: string;
    taskId: string;
    candidateId: string;
    commitMessage: string;
    verificationCommands?: string[][];
    remote?: string;
  }): Promise<ExecutionCandidate> {
    if (typeof options.commitMessage !== 'string' || options.commitMessage.trim() === '') {
      throw new ExecutionError('commit message must be a non-empty string', 'INVALID_COMMIT_MESSAGE');
    }
    const commands = options.verificationCommands ?? [];
    if (!Array.isArray(commands) || commands.some((command) => !Array.isArray(command) || command.length === 0
      || command[0] === '' || command.some((argument) => typeof argument !== 'string'))) {
      throw new ExecutionError('verification commands must be non-empty string argv arrays', 'INVALID_VERIFICATION_COMMAND');
    }
    const remote = options.remote ?? 'origin';
    assertRemote(remote);
    const run = await this.getRun(options.workspaceRoot, options.runId);
    const candidate = candidateFor(taskFor(run, options.taskId), options.candidateId);
    this.assertCandidatePath(run, candidate);
    if (candidate.status === 'published') return candidate;
    for (const command of commands) await this.runVerification(candidate.worktreePath, command);
    let sealed = candidate;
    if (candidate.status === 'draft') {
      const status = (await git(candidate.worktreePath, ['status', '--porcelain'])).trim();
      const headCommit = (await git(candidate.worktreePath, ['rev-parse', 'HEAD'])).trim();
      if (status) {
        await git(candidate.worktreePath, ['add', '-A']);
        await git(candidate.worktreePath, ['commit', '-m', options.commitMessage]);
      } else if (headCommit === run.baseCommit) {
        throw new ExecutionError('candidate must contain changes or one commit on top of the base', 'EMPTY_CANDIDATE');
      }
      sealed = await this.sealCandidate(run.workspaceRoot, run.id, options.taskId, candidate.id);
    } else if (candidate.status !== 'sealed' || !candidate.commit) {
      throw new ExecutionError('candidate cannot be finalized from its current state', 'CANDIDATE_NOT_DRAFT');
    }

    await git(candidate.worktreePath, ['push', '-u', remote, candidate.branch]);
    const remoteCommit = await this.remoteBranchCommit(candidate.worktreePath, remote, candidate.branch);
    if (remoteCommit !== sealed.commit) {
      throw new ExecutionError('remote candidate branch does not match sealed commit', 'REMOTE_VERIFICATION_FAILED');
    }
    const publishedRun = await this.getRun(run.workspaceRoot, run.id);
    const published = candidateFor(taskFor(publishedRun, options.taskId), candidate.id);
    published.status = 'published';
    published.remote = remote;
    published.publishedAt = now();
    publishedRun.updatedAt = now();
    await this.store.save(publishedRun);
    return published;
  }

  async selectCandidate(workspaceRoot: string, runId: string, taskId: string, candidateIdValue: string): Promise<ExecutionRun> {
    const run = await this.getRun(workspaceRoot, runId);
    const task = taskFor(run, taskId);
    const selected = candidateFor(task, candidateIdValue);
    if ((selected.status !== 'sealed' && selected.status !== 'published') || !selected.commit) {
      throw new ExecutionError('only sealed candidates can be selected', 'CANDIDATE_NOT_SEALED');
    }
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

  async publishFinal(options: {
    workspaceRoot: string;
    runId: string;
    includedTaskIds?: string[];
    targetBranch?: string;
    remote?: string;
  }): Promise<FinalPublishResult> {
    const run = await this.getRun(options.workspaceRoot, options.runId);
    const remote = options.remote ?? 'origin';
    assertRemote(remote);
    const canonicalStatus = (await git(run.workspaceRoot, ['status', '--porcelain', '--', '.', ':(exclude).redpen'])).trim();
    if (canonicalStatus) throw new ExecutionError('canonical workspace must be clean before publishing final', 'DIRTY_WORKSPACE');
    const checkedOutBranch = (await git(run.workspaceRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim();
    const targetBranch = options.targetBranch ?? checkedOutBranch;
    assertBranchName(targetBranch);
    try {
      await git(run.workspaceRoot, ['switch', targetBranch]);
    } catch {
      throw new ExecutionError(`target branch is unavailable: ${targetBranch}`, 'TARGET_BRANCH_UNAVAILABLE');
    }

    const requestedTaskIds = options.includedTaskIds ?? run.tasks.map((task) => task.id);
    const prior = run.finalPublication;
    if (prior) {
      const sameRequest = prior.remote === remote
        && prior.targetBranch === targetBranch
        && JSON.stringify(prior.includedTaskIds) === JSON.stringify(requestedTaskIds);
      if (!sameRequest) throw new ExecutionError('execution was already published with a different selection or target', 'ALREADY_PUBLISHED');
      let remoteCommit = await this.remoteBranchCommit(run.workspaceRoot, remote, targetBranch);
      if (remoteCommit === run.baseCommit && prior.state === 'publishing') {
        await git(run.workspaceRoot, ['push', remote, `${prior.commit}:refs/heads/${targetBranch}`]);
        remoteCommit = await this.remoteBranchCommit(run.workspaceRoot, remote, targetBranch);
      }
      if (remoteCommit !== prior.commit) throw new ExecutionError('published remote target no longer matches the recorded commit', 'REMOTE_VERIFICATION_FAILED');
      const localCommit = (await git(run.workspaceRoot, ['rev-parse', 'HEAD'])).trim();
      if (localCommit === run.baseCommit) await git(run.workspaceRoot, ['merge', '--ff-only', prior.commit]);
      else if (localCommit !== prior.commit) throw new ExecutionError('local target moved after publication', 'BASE_MOVED');
      if (prior.state !== 'published') {
        prior.state = 'published';
        run.updatedAt = now();
        await this.store.save(run);
      }
      return {
        branch: `redpen/final/${run.id}`,
        commit: prior.commit,
        remote,
        targetBranch,
        includedTaskIds: [...prior.includedTaskIds],
        commits: [...prior.commits],
      };
    }

    const final = await this.buildFinal(run.workspaceRoot, run.id, requestedTaskIds);
    try {
      const targetCommit = (await git(run.workspaceRoot, ['rev-parse', 'HEAD'])).trim();
      if (targetCommit !== run.baseCommit) {
        throw new ExecutionError('target branch no longer matches the run base commit', 'BASE_MOVED');
      }
      const commit = (await git(run.workspaceRoot, ['rev-parse', final.branch])).trim();
      const remoteBefore = await this.remoteBranchCommit(run.workspaceRoot, remote, targetBranch);
      if (remoteBefore !== run.baseCommit && remoteBefore !== commit) {
        throw new ExecutionError('remote target branch no longer matches the run base commit', 'BASE_MOVED');
      }
      run.finalPublication = {
        state: 'publishing',
        commit,
        remote,
        targetBranch,
        includedTaskIds: [...final.includedTaskIds],
        commits: [...final.commits],
        publishedAt: now(),
      };
      run.updatedAt = now();
      await this.store.save(run);
      if (remoteBefore === run.baseCommit) {
        await git(run.workspaceRoot, ['push', remote, `refs/heads/${final.branch}:refs/heads/${targetBranch}`]);
      }
      const remoteCommit = await this.remoteBranchCommit(run.workspaceRoot, remote, targetBranch);
      if (remoteCommit !== commit) {
        throw new ExecutionError('remote target branch does not match the final commit', 'REMOTE_VERIFICATION_FAILED');
      }
      run.finalPublication.state = 'published';
      run.updatedAt = now();
      await this.store.save(run);
      await git(run.workspaceRoot, ['merge', '--ff-only', final.branch]);
      return { branch: final.branch, commit, remote, targetBranch, includedTaskIds: final.includedTaskIds, commits: final.commits };
    } finally {
      await this.removeManagedWorktree(run, final.worktreePath).catch(() => {});
    }
  }

  private async buildIntegration(workspaceRoot: string, runId: string, kind: 'preview' | 'final', includedTaskIds?: string[]): Promise<IntegrationResult> {
    const run = await this.getRun(workspaceRoot, runId);
    const taskIds = includedTaskIds ?? run.tasks.map((task) => task.id);
    if (taskIds.length === 0) throw new ExecutionError('at least one task must be included', 'EMPTY_TASK_SELECTION');
    if (new Set(taskIds).size !== taskIds.length) throw new ExecutionError('included task ids must be unique', 'INVALID_TASK_SELECTION');
    const selected = taskIds.map((taskId) => {
      const task = taskFor(run, taskId);
      const candidate = task.candidates.find((entry) => entry.selected);
      if (!candidate || (candidate.status !== 'sealed' && candidate.status !== 'published') || !candidate.commit) {
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

  private async runVerification(cwd: string, command: string[]): Promise<void> {
    const child = crossSpawn(command[0], command.slice(1), {
      cwd,
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout: Buffer = Buffer.alloc(0);
    let stderr: Buffer = Buffer.alloc(0);
    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout = appendBounded(stdout, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr = appendBounded(stderr, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      if (!child.pid) return;
      if (process.platform === 'win32') {
        crossSpawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          shell: false,
          windowsHide: true,
          stdio: 'ignore',
        });
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Process already exited. */ }
      }
    }, verificationTimeoutMs);
    try {
      const result = await new Promise<{ code: number | null; error?: Error }>((resolve) => {
        child.once('error', (error) => resolve({ code: null, error }));
        child.once('close', (code) => resolve({ code }));
      });
      if (result.error || result.code !== 0 || timedOut) {
        throw new VerificationError(`verification command failed: ${command[0]}`, {
          command,
          cwd,
          stdout: boundedOutput(stdout),
          stderr: boundedOutput(Buffer.concat([
            stderr,
            timedOut ? Buffer.from('\nverification timed out') : Buffer.alloc(0),
            result.error ? Buffer.from(`\n${result.error.message}`) : Buffer.alloc(0),
          ])),
        });
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  private async remoteBranchCommit(cwd: string, remote: string, branch: string): Promise<string> {
    const output = await git(cwd, ['ls-remote', '--exit-code', remote, `refs/heads/${branch}`]);
    const commit = output.split(/\s+/)[0];
    if (!/^[0-9a-f]{40}$/i.test(commit)) {
      throw new ExecutionError(`remote did not return a commit for ${branch}`, 'REMOTE_VERIFICATION_FAILED');
    }
    return commit;
  }

  private assertCandidatePath(run: ExecutionRun, candidate: ExecutionCandidate): void {
    assertSafeSegment(candidate.id, 'candidate id');
    for (const segment of candidate.branch.split('/')) assertSafeSegment(segment, 'candidate branch segment');
    assertContainedPath(worktreesRoot(run), candidate.worktreePath);
  }
}
