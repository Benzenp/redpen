import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRevision, resolveRevisionChain } from './revision.js';
import { SCHEMA_VERSION, type VisualTask } from '@redpen/protocol/schema';

function baseTask(overrides: Partial<VisualTask> = {}): VisualTask {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: 'rpt_original',
    sessionId: 'rps_1',
    revision: 0,
    state: 'submitted',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    workspace: { root: '/workspace' },
    frames: [],
    groups: [],
    marks: [],
    targets: [],
    ...overrides,
  };
}

function frame(id: string) {
  return {
    id,
    url: 'http://localhost:3000',
    screenshot: 'frames/frame-001/source.png',
    annotated: 'frames/frame-001/annotated.png',
    overlaySvg: 'frames/frame-001/overlay.svg',
    viewport: { width: 1280, height: 900, deviceScaleFactor: 1 },
    scroll: { x: 0, y: 0 },
    capturedAt: '2026-09-01T00:00:00.000Z',
  };
}

test('createRevision increments revision number and links parentTaskId', () => {
  const parent = baseTask();
  const revision = createRevision({
    newTaskId: 'rpt_revision1',
    parentTask: parent,
    frame: frame('frm_1'),
    groups: [],
    marks: [],
    targets: [],
  });

  assert.equal(revision.revision, 1);
  assert.equal(revision.parentTaskId, 'rpt_original');
  assert.equal(revision.sessionId, parent.sessionId);
  assert.equal(revision.state, 'submitted');
});

test('createRevision does not mutate the parent task object', () => {
  const parent = baseTask();
  const parentSnapshot = JSON.stringify(parent);
  createRevision({ newTaskId: 'rpt_revision1', parentTask: parent, frame: frame('frm_1'), groups: [], marks: [], targets: [] });
  assert.equal(JSON.stringify(parent), parentSnapshot);
});

test('a chain of three revisions resolves oldest-first via resolveRevisionChain', async () => {
  const original = baseTask({ id: 'rpt_v0' });
  const v1 = createRevision({ newTaskId: 'rpt_v1', parentTask: original, frame: frame('frm_2'), groups: [], marks: [], targets: [] });
  const v2 = createRevision({ newTaskId: 'rpt_v2', parentTask: v1, frame: frame('frm_3'), groups: [], marks: [], targets: [] });

  const store = new Map<string, VisualTask>([
    ['rpt_v0', original],
    ['rpt_v1', v1],
    ['rpt_v2', v2],
  ]);
  const chain = await resolveRevisionChain(v2, async (id) => store.get(id) ?? null);

  assert.deepEqual(chain.map((t) => t.id), ['rpt_v0', 'rpt_v1', 'rpt_v2']);
});

test('resolveRevisionChain on a task with no parent returns just that task', async () => {
  const original = baseTask({ id: 'rpt_v0' });
  const chain = await resolveRevisionChain(original, async () => null);
  assert.deepEqual(chain.map((t) => t.id), ['rpt_v0']);
});

test('resolveRevisionChain stops gracefully if a parent lookup returns null (missing/deleted parent)', async () => {
  const original = baseTask({ id: 'rpt_v0' });
  const v1 = createRevision({ newTaskId: 'rpt_v1', parentTask: original, frame: frame('frm_2'), groups: [], marks: [], targets: [] });
  const chain = await resolveRevisionChain(v1, async () => null);
  assert.deepEqual(chain.map((t) => t.id), ['rpt_v1']);
});
