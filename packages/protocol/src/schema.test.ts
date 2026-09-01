import { test } from 'node:test';
import assert from 'node:assert/strict';
import { instructionGroupSchema, visualTaskSchema, visualSessionSchema, SCHEMA_VERSION } from './schema.js';

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
        referenceIds: ['ref_01J000000000000000000000'],
      },
    ],
    references: [
      {
        id: 'ref_01J000000000000000000000',
        fileName: 'ref_01J000000000000000000000.png',
        path: 'references/ref_01J000000000000000000000.png',
        width: 240,
        height: 160,
        createdAt: '2026-09-01T00:00:00.000Z',
        label: 'Current logo',
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

test('visualTask schema accepts a patch mark with sourceRect', () => {
  const task = makeSampleTask();
  const patchMark = {
    type: 'patch' as const,
    id: 'mrk_01J000000000000000000001',
    frameId: 'frm_01J000000000000000000000',
    groupId: 'grp_01J000000000000000000000',
    bounds: { x: 300, y: 200, width: 120, height: 80 },
    normalizedBounds: { x: 0.234, y: 0.222, width: 0.094, height: 0.089 },
    sourceRect: { x: 20, y: 30, width: 120, height: 80 },
  };
  const withPatch = { ...task, marks: [...task.marks, patchMark] };
  const parsed = visualTaskSchema.parse(withPatch);
  const reparsed = visualTaskSchema.parse(JSON.parse(JSON.stringify(parsed)));
  assert.deepEqual(reparsed.marks[1], patchMark);
});

test('visualTask schema round-trips a line mark', () => {
  const task = makeSampleTask();
  const lineMark = {
    type: 'line' as const,
    id: 'mrk_01J000000000000000000002',
    frameId: 'frm_01J000000000000000000000',
    groupId: 'grp_01J000000000000000000000',
    bounds: { x: 400, y: 250, width: 240, height: 160 },
    normalizedBounds: { x: 0.3125, y: 0.278, width: 0.188, height: 0.178 },
    from: { x: 400, y: 250 },
    to: { x: 640, y: 410 },
  };
  const withLine = { ...task, marks: [...task.marks, lineMark] };
  const parsed = visualTaskSchema.parse(withLine);
  const reparsed = visualTaskSchema.parse(JSON.parse(JSON.stringify(parsed)));
  assert.deepEqual(reparsed.marks[1], lineMark);
});

test('visualTask schema rejects image marks', () => {
  const task = makeSampleTask();
  const imageMark = {
    type: 'image',
    id: 'mrk_01J000000000000000000002',
    frameId: 'frm_01J000000000000000000000',
    groupId: 'grp_01J000000000000000000000',
    bounds: { x: 400, y: 250, width: 240, height: 160 },
    normalizedBounds: { x: 0.3125, y: 0.278, width: 0.188, height: 0.178 },
    assetRef: 'reference-logo',
  };
  assert.throws(() => visualTaskSchema.parse({ ...task, marks: [...task.marks, imageMark] }));
});

test('visualTask schema rejects dangling, duplicate, and unattached reference assets', () => {
  const task = makeSampleTask();
  assert.throws(() =>
    visualTaskSchema.parse({
      ...task,
      groups: [{ ...task.groups[0], referenceIds: ['ref_missing'] }],
    }),
  );
  assert.throws(() =>
    visualTaskSchema.parse({
      ...task,
      references: [...task.references, task.references[0]],
    }),
  );
  assert.throws(() =>
    visualTaskSchema.parse({
      ...task,
      groups: [{ ...task.groups[0], referenceIds: [] }],
    }),
  );
});

test('instruction group referenceIds must be unique and contain at most three IDs', () => {
  const group = makeSampleTask().groups[0];
  assert.deepEqual(
    instructionGroupSchema.parse({ ...group, referenceIds: ['ref_1', 'ref_2', 'ref_3'] }).referenceIds,
    ['ref_1', 'ref_2', 'ref_3'],
  );
  assert.throws(() => instructionGroupSchema.parse({ ...group, referenceIds: ['ref_1', 'ref_1'] }));
  assert.throws(() => instructionGroupSchema.parse({ ...group, referenceIds: ['ref_1', 'ref_2', 'ref_3', 'ref_4'] }));
});

test('visualTask schema round-trips reference assets', () => {
  const task = makeSampleTask();
  const parsed = visualTaskSchema.parse(task);
  const reparsed = visualTaskSchema.parse(JSON.parse(JSON.stringify(parsed)));
  assert.deepEqual(reparsed.references, task.references);
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
