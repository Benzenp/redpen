import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visualTaskSchema, visualSessionSchema, SCHEMA_VERSION } from './schema.js';

function makeSampleTask() {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: 'rpt_01J000000000000000000000',
    sessionId: 'rps_01J000000000000000000000',
    revision: 0,
    state: 'submitted' as const,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    workspace: { root: '/workspace' },
    globalNote: 'fix the settings page',
    frames: [
      {
        id: 'frm_01J000000000000000000000',
        url: 'http://localhost:5173/settings',
        screenshot: 'frames/frame-001/source.png',
        annotated: 'frames/frame-001/annotated.png',
        overlaySvg: 'frames/frame-001/overlay.svg',
        viewport: { width: 1280, height: 900, deviceScaleFactor: 1 },
        scroll: { x: 0, y: 0 },
        capturedAt: '2026-09-01T00:00:00.000Z',
      },
    ],
    groups: [
      {
        id: 'grp_01J000000000000000000000',
        number: 1,
        color: '#dc2626',
        note: 'move this button',
        state: 'ready' as const,
        markIds: ['mrk_01J000000000000000000000'],
        targetIds: ['tgt_01J000000000000000000000'],
      },
    ],
    marks: [
      {
        type: 'rectangle' as const,
        id: 'mrk_01J000000000000000000000',
        frameId: 'frm_01J000000000000000000000',
        groupId: 'grp_01J000000000000000000000',
        bounds: { x: 10, y: 10, width: 100, height: 40 },
        normalizedBounds: { x: 0.01, y: 0.01, width: 0.1, height: 0.04 },
      },
    ],
    targets: [
      {
        id: 'tgt_01J000000000000000000000',
        frameId: 'frm_01J000000000000000000000',
        groupIds: ['grp_01J000000000000000000000'],
        rect: { x: 10, y: 10, width: 100, height: 40 },
        tag: 'button',
        role: null,
        accessibleName: 'Save',
        text: 'Save',
        selectorHints: ['[data-testid="save-button"]'],
        attributes: { 'data-testid': 'save-button' },
        relation: 'intersects' as const,
        context: {
          computedLayout: { display: 'flex', width: '100px' },
        },
      },
    ],
  };
}

test('visualTask schema round-trips without loss', () => {
  const original = makeSampleTask();
  const parsed = visualTaskSchema.parse(original);
  const serialized = JSON.parse(JSON.stringify(parsed));
  const reparsed = visualTaskSchema.parse(serialized);
  assert.deepEqual(reparsed, original);
});

test('visualTask schema rejects unknown mark type', () => {
  const task = makeSampleTask();
  // @ts-expect-error deliberately invalid type for round-trip validation test
  task.marks[0].type = 'triangle';
  assert.throws(() => visualTaskSchema.parse(task));
});

test('visualTask schema rejects computedLayout keys outside allowlist', () => {
  const task = makeSampleTask();
  task.targets[0].context = { computedLayout: { zIndex: '999' } as never };
  assert.throws(() => visualTaskSchema.parse(task));
});

test('visualSession schema round-trips', () => {
  const session = {
    schemaVersion: SCHEMA_VERSION,
    id: 'rps_01J000000000000000000000',
    state: 'browsing' as const,
    workspaceRoot: '/workspace',
    targetUrl: 'http://localhost:5173',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  };
  const parsed = visualSessionSchema.parse(session);
  assert.deepEqual(parsed, session);
});

test('visualSession schema rejects non-datetime timestamps', () => {
  const session = {
    schemaVersion: SCHEMA_VERSION,
    id: 'rps_01J000000000000000000000',
    state: 'browsing' as const,
    workspaceRoot: '/workspace',
    targetUrl: 'http://localhost:5173',
    createdAt: 'not-a-date',
    updatedAt: '2026-09-01T00:00:00.000Z',
  };
  assert.throws(() => visualSessionSchema.parse(session));
});
