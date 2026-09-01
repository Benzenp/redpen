import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  writeTaskBundle,
  listTaskIds,
  readTaskBundle,
  readLatestPointer,
} from './storage.js';
import { taskDir, taskTmpDir, tasksDir } from './paths.js';
import { SCHEMA_VERSION } from './schema.js';

async function withTempWorkspace(fn: (workspaceRoot: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'redpen-storage-test-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function makeTask(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: 'rpt_01J111111111111111111111',
    sessionId: 'rps_01J111111111111111111111',
    revision: 0,
    state: 'submitted' as const,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    workspace: { root: '/workspace' },
    frames: [],
    groups: [],
    references: [],
    marks: [],
    targets: [],
    ...overrides,
  };
}

test('writeTaskBundle atomically commits a valid task and it becomes readable', async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const task = makeTask();
    const { finalDir } = await writeTaskBundle(workspaceRoot, task as never, [
      { relativePath: 'frames/frame-001/source.png', content: Buffer.from([1, 2, 3]) },
    ]);

    assert.equal(finalDir, taskDir(workspaceRoot, task.id));

    const ids = await listTaskIds(workspaceRoot);
    assert.deepEqual(ids, [task.id]);

    const readBack = await readTaskBundle(workspaceRoot, task.id);
    assert.equal(readBack.id, task.id);
    assert.equal(readBack.state, 'submitted');

    const latest = await readLatestPointer(workspaceRoot);
    assert.equal(latest?.taskId, task.id);

    // tmp dir must not survive a successful write.
    const tmpExists = await readdir(tasksDir(workspaceRoot)).then(
      (entries) => entries.includes(`.tmp-${task.id}`),
      () => false,
    );
    assert.equal(tmpExists, false);
  });
});

test('an invalid task fails validation and leaves no tmp or final directory behind', async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const invalidTask = makeTask({ state: 'not-a-real-state' });

    await assert.rejects(() => writeTaskBundle(workspaceRoot, invalidTask as never));

    const entries = await readdir(tasksDir(workspaceRoot)).catch(() => [] as string[]);
    assert.deepEqual(entries, []);
  });
});

test('a write interrupted mid-flight (extra file write throws) is not exposed as a submitted task', async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const task = makeTask({ id: 'rpt_01J222222222222222222222' });

    // Force a failure after task.json/task.md would have been staged, by
    // passing a content value that fs.writeFile cannot serialize.
    const badFiles = [
      {
        relativePath: 'frames/frame-001/source.png',
        // Deliberately invalid content type (object, not Buffer|string) to simulate a
        // mid-write crash inside fs.writeFile.
        content: { not: 'a buffer or string' } as unknown as string,
      },
    ];

    await assert.rejects(() => writeTaskBundle(workspaceRoot, task as never, badFiles as never));

    const idsAfterCrash = await listTaskIds(workspaceRoot);
    assert.deepEqual(idsAfterCrash, [], 'interrupted write must not appear as a valid submitted task');

    const finalDirExists = await readdir(tasksDir(workspaceRoot))
      .then((entries) => entries.includes(task.id))
      .catch(() => false);
    assert.equal(finalDirExists, false);

    const tmpDirExists = await readdir(tasksDir(workspaceRoot))
      .then((entries) => entries.includes(path.basename(taskTmpDir(workspaceRoot, task.id))))
      .catch(() => false);
    assert.equal(tmpDirExists, false, 'tmp directory must be cleaned up after a failed write');
  });
});

test('writeTaskBundle overwrites a prior committed bundle with the same id (resubmission)', async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const task = makeTask({ revision: 0 });
    await writeTaskBundle(workspaceRoot, task as never);

    const revised = makeTask({ revision: 1, globalNote: 'revised' });
    await writeTaskBundle(workspaceRoot, revised as never);

    const readBack = await readTaskBundle(workspaceRoot, task.id);
    assert.equal(readBack.revision, 1);
    assert.equal(readBack.globalNote, 'revised');
  });
});

test('listTaskIds returns empty array when .redpen/tasks does not exist yet', async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    assert.deepEqual(await listTaskIds(workspaceRoot), []);
  });
});

test('readLatestPointer returns null before any task has been submitted', async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    assert.equal(await readLatestPointer(workspaceRoot), null);
  });
});
