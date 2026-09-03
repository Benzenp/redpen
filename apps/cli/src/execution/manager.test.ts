import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { CherryPickError, ExecutionError } from './types.js';
import { ExecutionManager } from './manager.js';

const execFile = promisify(execFileCallback);

async function command(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFile('git', args, { cwd, encoding: 'utf8' });
  return stdout;
}

async function repository(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'redpen-execution-'));
  await command(root, ['init']);
  await command(root, ['config', 'user.email', 'execution-test@example.invalid']);
  await command(root, ['config', 'user.name', 'Execution Test']);
  await writeFile(path.join(root, 'base.txt'), 'base\n');
  await command(root, ['add', '.']);
  await command(root, ['commit', '-m', 'base']);
  return root;
}

async function commitCandidate(candidatePath: string, file: string, contents: string, message: string): Promise<void> {
  await writeFile(path.join(candidatePath, file), contents);
  await command(candidatePath, ['add', file]);
  await command(candidatePath, ['commit', '-m', message]);
}

test('creates, seals, inspects, selects, previews, and builds a subset final result', async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const manager = new ExecutionManager();
  const run = await manager.createRun({ workspaceRoot: root, taskNames: ['first', 'second'] });
  assert.equal(path.isAbsolute(run.workspaceRoot), true);
  assert.equal(run.tasks.length, 2);

  const first = await manager.addCandidate(root, run.id, run.tasks[0].id);
  const second = await manager.addCandidate(root, run.id, run.tasks[1].id);
  await commitCandidate(first.worktreePath, 'first.txt', 'one\n', 'first');
  await commitCandidate(second.worktreePath, 'second.txt', 'two\n', 'second');

  const inspection = await manager.inspectCandidate(root, run.id, run.tasks[0].id, first.id);
  assert.equal(inspection.clean, true);
  assert.equal(inspection.headCommit.length, 40);
  assert.match(inspection.patch, /first\.txt/);
  await manager.sealCandidate(root, run.id, run.tasks[0].id, first.id);
  await manager.sealCandidate(root, run.id, run.tasks[1].id, second.id);
  await manager.selectCandidate(root, run.id, run.tasks[0].id, first.id);
  await manager.selectCandidate(root, run.id, run.tasks[1].id, second.id);

  const preview = await manager.buildPreview(root, run.id);
  const previewContents = await Promise.all(
    ['first.txt', 'second.txt'].map(async (file) => (await readFile(path.join(preview.worktreePath, file), 'utf8')).replaceAll('\r\n', '\n')),
  );
  assert.deepEqual(previewContents, ['one\n', 'two\n']);
  const final = await manager.buildFinal(root, run.id, [run.tasks[1].id]);
  assert.equal((await readFile(path.join(final.worktreePath, 'second.txt'), 'utf8')).replaceAll('\r\n', '\n'), 'two\n');
  await assert.rejects(readFile(path.join(final.worktreePath, 'first.txt'), 'utf8'));
});

test('rejects dirty candidates, too many tasks, and unsafe run ids', async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const manager = new ExecutionManager();
  await assert.rejects(
    manager.createRun({ workspaceRoot: root, taskNames: Array.from({ length: 10 }, (_, index) => `task ${index}`) }),
    (error: unknown) => error instanceof ExecutionError && error.code === 'TASK_LIMIT',
  );
  const run = await manager.createRun({ workspaceRoot: root, taskNames: ['task'] });
  const candidate = await manager.addCandidate(root, run.id, run.tasks[0].id);
  await writeFile(path.join(candidate.worktreePath, 'dirty.txt'), 'dirty\n');
  await assert.rejects(
    manager.sealCandidate(root, run.id, run.tasks[0].id, candidate.id),
    (error: unknown) => error instanceof ExecutionError && error.code === 'DIRTY_CANDIDATE',
  );
  await assert.rejects(
    manager.getRun(root, '../outside'),
    (error: unknown) => error instanceof ExecutionError && error.code === 'UNSAFE_ID',
  );
});

test('aborts a conflicting cherry-pick and reports a typed failure', async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const manager = new ExecutionManager();
  const run = await manager.createRun({ workspaceRoot: root, taskNames: ['left', 'right'] });
  const left = await manager.addCandidate(root, run.id, run.tasks[0].id);
  const right = await manager.addCandidate(root, run.id, run.tasks[1].id);
  await commitCandidate(left.worktreePath, 'base.txt', 'left\n', 'left');
  await commitCandidate(right.worktreePath, 'base.txt', 'right\n', 'right');
  for (const [task, candidate] of [[run.tasks[0], left], [run.tasks[1], right]] as const) {
    await manager.sealCandidate(root, run.id, task.id, candidate.id);
    await manager.selectCandidate(root, run.id, task.id, candidate.id);
  }
  let failure: CherryPickError | undefined;
  try {
    await manager.buildPreview(root, run.id);
  } catch (error) {
    assert.equal(error instanceof CherryPickError, true);
    failure = error as CherryPickError;
  }
  assert.ok(failure);
  assert.equal((await command(failure.details.worktreePath, ['status', '--porcelain'])).trim(), '');
});
