import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isEligibleForDeletion, selectTasksForDeletion } from './retention.js';
import { SCHEMA_VERSION, type VisualTask } from '@redpen/protocol/schema';

function task(overrides: Partial<VisualTask> = {}): VisualTask {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: 'rpt_1',
    sessionId: 'rps_1',
    revision: 0,
    state: 'done',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    workspace: { root: '/workspace' },
    frames: [],
    groups: [],
    marks: [],
    targets: [],
    ...overrides,
  };
}

const POLICY = { maxAgeMs: 10 * 24 * 60 * 60 * 1000 }; // 10 days
const NOW = new Date('2026-02-01T00:00:00.000Z');

test('a done task older than the retention window is eligible for deletion', () => {
  const t = task({ state: 'done', updatedAt: '2026-01-01T00:00:00.000Z' });
  assert.equal(isEligibleForDeletion(t, NOW, POLICY), true);
});

test('a done task younger than the retention window is NOT eligible', () => {
  const t = task({ state: 'done', updatedAt: '2026-01-31T00:00:00.000Z' });
  assert.equal(isEligibleForDeletion(t, NOW, POLICY), false);
});

test('a working/submitted/review task is never eligible regardless of age', () => {
  for (const state of ['submitted', 'working', 'review'] as const) {
    const t = task({ state, updatedAt: '2020-01-01T00:00:00.000Z' });
    assert.equal(isEligibleForDeletion(t, NOW, POLICY), false, state);
  }
});

test('a cancelled old task is eligible for deletion', () => {
  const t = task({ state: 'cancelled', updatedAt: '2026-01-01T00:00:00.000Z' });
  assert.equal(isEligibleForDeletion(t, NOW, POLICY), true);
});

test('selectTasksForDeletion excludes a task that is still referenced as a parentTaskId', () => {
  const parent = task({ id: 'rpt_parent', state: 'done', updatedAt: '2026-01-01T00:00:00.000Z' });
  const child = task({ id: 'rpt_child', state: 'submitted', parentTaskId: 'rpt_parent', updatedAt: '2026-01-15T00:00:00.000Z' });

  const selected = selectTasksForDeletion([parent, child], NOW, POLICY);
  assert.deepEqual(selected.map((t) => t.id), [], 'parent must be protected because a revision still references it');
});

test('selectTasksForDeletion includes an old done task once no revision still references it', () => {
  const parent = task({ id: 'rpt_parent', state: 'done', updatedAt: '2026-01-01T00:00:00.000Z' });
  const unrelated = task({ id: 'rpt_other', state: 'done', updatedAt: '2026-01-01T00:00:00.000Z' });

  const selected = selectTasksForDeletion([parent, unrelated], NOW, POLICY);
  assert.deepEqual(selected.map((t) => t.id).sort(), ['rpt_other', 'rpt_parent']);
});
