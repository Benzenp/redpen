import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import type { VisualTask } from '@redpen/protocol/schema';
import { RedpenApplicationService } from '../application/service.js';
import { buildExecutionTaskPlans } from './task-plan.js';

const execFile = promisify(execFileCallback);

async function git(cwd: string, args: string[]): Promise<void> {
  await execFile('git', args, { cwd });
}

function visualTask(workspaceRoot: string): VisualTask {
  return {
    id: 'rpt_test',
    sessionId: 'rps_test',
    workspace: { root: workspaceRoot },
    groups: [
      { id: 'group-b', number: 2, color: '#222', note: 'Move chart', state: 'ready', markIds: ['mark-b'], targetIds: [], referenceIds: [] },
      { id: 'group-a', number: 1, color: '#111', note: 'Fix header', state: 'ready', markIds: ['mark-a'], targetIds: ['target-a'], referenceIds: ['reference-a'] },
    ],
    marks: [
      { id: 'mark-a', type: 'rectangle', frameId: 'frame-a', groupId: 'group-a', bounds: { x: 0, y: 0, width: 10, height: 10 }, normalizedBounds: { x: 0, y: 0, width: 0.1, height: 0.1 } },
      { id: 'mark-b', type: 'ellipse', frameId: 'frame-a', groupId: 'group-b', bounds: { x: 10, y: 10, width: 10, height: 10 }, normalizedBounds: { x: 0.1, y: 0.1, width: 0.1, height: 0.1 } },
    ],
    targets: [{ id: 'target-a', frameId: 'frame-a', groupIds: ['group-a'], tag: 'header', role: 'banner', text: '', attributes: {}, rect: { x: 0, y: 0, width: 10, height: 10 }, relation: 'intersects', selectorHints: ['[data-testid="header"]'] }],
    references: [{ id: 'reference-a', fileName: 'reference-a.png', path: 'references/reference-a.png', width: 10, height: 10, createdAt: new Date().toISOString() }],
    frames: [{ id: 'frame-a', url: 'http://127.0.0.1/', screenshot: 'frames/frame-001/source.png', annotated: 'frames/frame-001/annotated.png', overlaySvg: 'frames/frame-001/overlay.svg', viewport: { width: 100, height: 100, deviceScaleFactor: 1 }, scroll: { x: 0, y: 0 }, capturedAt: new Date().toISOString() }],
    schemaVersion: 1,
    revision: 0,
    state: 'submitted',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as VisualTask;
}

test('visual groups become ordered self-contained execution plans', () => {
  const plans = buildExecutionTaskPlans(visualTask('/repo'));
  assert.deepEqual(plans.map((plan) => plan.sourceGroupId), ['group-a', 'group-b']);
  assert.match(plans[0].instruction, /Fix header/);
  assert.match(plans[0].instruction, /data-testid/);
  assert.match(plans[0].instruction, /reference-a\.png/);
});

test('prepare creates one isolated candidate worktree per visual group', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'redpen-workflow-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, ['init']);
  await git(root, ['config', 'user.email', 'workflow@example.invalid']);
  await git(root, ['config', 'user.name', 'Workflow Test']);
  await writeFile(path.join(root, 'base.txt'), 'base\n');
  await git(root, ['add', '.']);
  await git(root, ['commit', '-m', 'base']);

  const service = new RedpenApplicationService();
  service.getTask = async () => visualTask(root);
  service.getSession = async () => ({ state: 'submitted' }) as never;
  service.claim = async () => ({ state: 'working' }) as never;
  const run = await service.prepareTaskExecution({ workspaceRoot: root, taskId: 'rpt_test' });
  assert.equal(run.sourceTaskId, 'rpt_test');
  assert.equal(run.tasks.length, 2);
  assert.equal(run.tasks.every((task) => task.candidates.length === 1), true);
  assert.equal(run.tasks.every((task) => path.isAbsolute(task.candidates[0].worktreePath)), true);
  await service.shutdown();
});

test('service runs an agent, verifies and pushes its candidate, then publishes the selected result', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'redpen-workflow-repo-'));
  const origin = await mkdtemp(path.join(tmpdir(), 'redpen-workflow-origin-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(origin, { recursive: true, force: true });
  });
  await git(origin, ['init', '--bare']);
  await git(root, ['init']);
  await git(root, ['config', 'user.email', 'workflow@example.invalid']);
  await git(root, ['config', 'user.name', 'Workflow Test']);
  await writeFile(path.join(root, 'base.txt'), 'base\n');
  await git(root, ['add', '.']);
  await git(root, ['commit', '-m', 'base']);
  await git(root, ['remote', 'add', 'origin', origin]);
  await git(root, ['push', '-u', 'origin', 'HEAD']);

  const service = new RedpenApplicationService();
  try {
    const run = await service.createExecutionRun({ workspaceRoot: root, taskNames: ['Add result'] });
    const candidate = await service.addExecutionCandidate(root, run.id, run.tasks[0].id);
    const started = await service.startExecutionAgent({
      workspaceRoot: root,
      runId: run.id,
      taskId: run.tasks[0].id,
      candidateId: candidate.id,
      command: process.execPath,
      args: ['-e', "require('node:fs').writeFileSync('result.txt', process.env.REDPEN_INSTRUCTION)"],
    });
    const exited = await service.waitExecutionProcess(started.id);
    assert.equal(exited.status, 'exited');

    const published = await service.finalizeExecutionCandidate({
      workspaceRoot: root,
      runId: run.id,
      taskId: run.tasks[0].id,
      candidateId: candidate.id,
      commitMessage: 'feat: add result',
      verificationCommands: [[process.execPath, '-e', "if(require('node:fs').readFileSync('result.txt','utf8')!=='Add result')process.exit(1)"]],
    });
    assert.equal(published.status, 'published');
    await service.selectExecutionCandidate(root, run.id, run.tasks[0].id, candidate.id);
    const result = await service.publishExecutionFinal({ workspaceRoot: root, runId: run.id });
    assert.equal(result.commits.length, 1);
    assert.equal((await execFile('git', ['ls-remote', origin, `refs/heads/${result.targetBranch}`], { cwd: root })).stdout.trim().split(/\s/)[0], result.commit);
  } finally {
    await service.shutdown();
  }
});
