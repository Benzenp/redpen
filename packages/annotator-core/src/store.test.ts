import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnnotatorStore } from './store.js';
import type { MarkUpdate, NewMarkInput } from './store.js';

function rectMark(frameId: string, bounds: { x: number; y: number; width: number; height: number }): NewMarkInput {
  return { type: 'rectangle', frameId, bounds, normalizedBounds: bounds };
}

function ellipseMark(frameId: string, bounds: { x: number; y: number; width: number; height: number }): NewMarkInput {
  return { type: 'ellipse', frameId, bounds, normalizedBounds: bounds };
}

function arrowMark(frameId: string, from: { x: number; y: number }, to: { x: number; y: number }): NewMarkInput {
  const bounds = {
    x: Math.min(from.x, to.x),
    y: Math.min(from.y, to.y),
    width: Math.abs(to.x - from.x),
    height: Math.abs(to.y - from.y),
  };
  return { type: 'arrow', frameId, from, to, bounds, normalizedBounds: bounds };
}

function maskMark(frameId: string, bounds: { x: number; y: number; width: number; height: number }): NewMarkInput {
  return { type: 'mask', frameId, bounds, normalizedBounds: bounds, opacity: 0.5 };
}

const FRAME = 'frm_test';

test('a new store auto-creates group #1 as the active group', () => {
  const store = new AnnotatorStore();
  const groups = store.getGroups();
  assert.equal(groups.length, 1);
  assert.equal(groups[0].number, 1);
  assert.deepEqual(groups[0].referenceIds, []);
  assert.equal(store.getActiveGroupId(), groups[0].id);
});

test('UX scenario: drawing an ellipse and an arrow in the same group both attach to #1', () => {
  const store = new AnnotatorStore();
  const group1 = store.getGroups()[0];

  store.addMark(ellipseMark(FRAME, { x: 10, y: 10, width: 40, height: 40 }));
  store.addMark(arrowMark(FRAME, { x: 100, y: 100 }, { x: 200, y: 200 }));

  const marksInGroup1 = store.getMarksForGroup(group1.id);
  assert.equal(marksInGroup1.length, 2);
  assert.ok(marksInGroup1.every((m) => m.groupId === group1.id));
});

test('UX scenario: "새 지시" creates #2 with the next palette color and next marks attach to it', () => {
  const store = new AnnotatorStore();
  const group2 = store.createGroup();
  assert.equal(group2.number, 2);

  store.setGroupNote(group2.id, '3열 표로 재구성');
  store.addMark(rectMark(FRAME, { x: 0, y: 0, width: 300, height: 30 }));
  store.addMark(rectMark(FRAME, { x: 0, y: 30, width: 300, height: 30 }));
  store.addMark(rectMark(FRAME, { x: 0, y: 60, width: 300, height: 30 }));

  const marks = store.getMarksForGroup(group2.id);
  assert.equal(marks.length, 3);
  const updatedGroup2 = store.getGroups().find((g) => g.id === group2.id)!;
  assert.equal(updatedGroup2.note, '3열 표로 재구성');
  assert.equal(updatedGroup2.state, 'ready');
});

test('UX scenario: #3 mask covers an existing element and a new mark is drawn over it', () => {
  const store = new AnnotatorStore();
  store.createGroup(); // #2
  const group3 = store.createGroup(); // #3
  assert.equal(group3.number, 3);

  const mask = store.addMark(maskMark(FRAME, { x: 400, y: 400, width: 200, height: 80 }));
  const newButton = store.addMark(rectMark(FRAME, { x: 420, y: 420, width: 100, height: 30 }));

  assert.equal(mask.groupId, group3.id);
  assert.equal(newButton.groupId, group3.id);
});

test('UX scenario: switching active group back and forth does not change an existing mark\'s groupId', () => {
  const store = new AnnotatorStore();
  const group1 = store.getGroups()[0];
  const mark = store.addMark(rectMark(FRAME, { x: 0, y: 0, width: 10, height: 10 }));

  const group2 = store.createGroup();
  store.setActiveGroup(group1.id);
  store.setActiveGroup(group2.id);
  store.setActiveGroup(group1.id);

  const stillGroup1 = store.getMarks().find((m) => m.id === mark.id);
  assert.equal(stillGroup1?.groupId, group1.id);
});

test('group numbers are never reused even as the store accumulates many groups (palette wraps)', () => {
  const store = new AnnotatorStore(); // #1
  const numbers = [store.getGroups()[0].number];
  for (let i = 0; i < 10; i++) {
    numbers.push(store.createGroup().number);
  }
  assert.deepEqual(numbers, Array.from({ length: 11 }, (_, i) => i + 1));
  assert.equal(new Set(numbers).size, 11, 'no number should repeat');
});

test('findEmptyGroups flags groups with zero marks; groups with only a note are still empty', () => {
  const store = new AnnotatorStore();
  const group1 = store.getGroups()[0];
  const group2 = store.createGroup();
  store.setGroupNote(group2.id, 'note without any mark');

  const empty = store.findEmptyGroups();
  assert.deepEqual(empty.map((g) => g.number).sort(), [1, 2]);
  assert.equal(store.canSubmit(), false);

  store.setActiveGroup(group1.id);
  store.addMark(rectMark(FRAME, { x: 0, y: 0, width: 5, height: 5 }));
  store.setActiveGroup(group2.id);
  store.addMark(rectMark(FRAME, { x: 0, y: 0, width: 5, height: 5 }));

  assert.equal(store.findEmptyGroups().length, 0);
  assert.equal(store.canSubmit(), true);
  void group1;
});

test('undo removes the most recent mark and redo restores it', () => {
  const store = new AnnotatorStore();
  store.addMark(rectMark(FRAME, { x: 0, y: 0, width: 10, height: 10 }));
  assert.equal(store.getMarks().length, 1);

  const undone = store.undo();
  assert.equal(undone, true);
  assert.equal(store.getMarks().length, 0);

  const redone = store.redo();
  assert.equal(redone, true);
  assert.equal(store.getMarks().length, 1);
});

test('undo can roll back group creation and batch deletion, redo re-applies it', () => {
  const store = new AnnotatorStore();
  const mark = store.addMark(rectMark(FRAME, { x: 0, y: 0, width: 10, height: 10 }));
  store.createGroup();
  assert.equal(store.getGroups().length, 2);

  store.undo(); // undoes createGroup
  assert.equal(store.getGroups().length, 1);

  store.deleteMarks([mark.id]);
  assert.equal(store.getMarks().length, 0);

  store.undo(); // undoes batch deletion
  assert.equal(store.getMarks().length, 1);
});

test('batch update, reassign, and delete are atomic single history actions', () => {
  const store = new AnnotatorStore();
  const group1 = store.getGroups()[0];
  const mark1 = store.addMark(rectMark(FRAME, { x: 0, y: 0, width: 10, height: 10 }));
  const mark2 = store.addMark(rectMark(FRAME, { x: 20, y: 20, width: 10, height: 10 }));
  const group2 = store.createGroup();

  store.updateMarks([
    { ...mark1, bounds: { x: 1, y: 2, width: 10, height: 10 }, normalizedBounds: { x: 0.1, y: 0.2, width: 0.1, height: 0.1 } },
    { ...mark2, bounds: { x: 21, y: 22, width: 10, height: 10 }, normalizedBounds: { x: 0.2, y: 0.2, width: 0.1, height: 0.1 } },
  ]);
  assert.equal(store.getMarks()[0].bounds.x, 1);
  store.undo();
  assert.equal(store.getMarks()[0].bounds.x, 0, 'both updates undo together');

  store.reassignMarks([mark1.id, mark2.id], group2.id);
  assert.deepEqual(store.getGroups().find((group) => group.id === group1.id)?.markIds, []);
  assert.deepEqual(store.getGroups().find((group) => group.id === group2.id)?.markIds, [mark1.id, mark2.id]);
  store.undo();
  assert.equal(store.getMarks().every((mark) => mark.groupId === group1.id), true);

  store.deleteMarks([mark1.id, mark2.id]);
  assert.equal(store.getMarks().length, 0);
  store.undo();
  assert.equal(store.getMarks().length, 2, 'both deletions undo together');
});

test('selection mutations reject malformed IDs atomically and snapshots are immutable', () => {
  const store = new AnnotatorStore();
  const mark = store.addMark(rectMark(FRAME, { x: 0, y: 0, width: 10, height: 10 }));
  const before = store.getMarks();
  assert.throws(() => store.reassignMarks([mark.id, 'missing'], store.getGroups()[0].id));
  assert.deepEqual(store.getMarks(), before);
  assert.throws(() => store.deleteMarks([mark.id, mark.id]));
  assert.deepEqual(store.getMarks(), before);
  assert.throws(() => store.updateMarks([{ ...mark, type: 'ellipse' } as unknown as MarkUpdate]));
  assert.deepEqual(store.getMarks(), before);

  const exposed = store.getMarks()[0];
  exposed.bounds.x = 999;
  assert.equal(store.getMarks()[0].bounds.x, 0);
  store.updateMarks([{ ...mark, bounds: { x: 3, y: 0, width: 10, height: 10 } }]);
  store.undo();
  assert.equal(store.getMarks()[0].bounds.x, 0);
});

test('empty groups can be deleted, but the last group cannot and numbers are never reused', () => {
  const store = new AnnotatorStore();
  const group1 = store.getGroups()[0];
  const group2 = store.createGroup();
  store.deleteGroup(group2.id);
  assert.equal(store.getGroups().length, 1);
  const group3 = store.createGroup();
  assert.equal(group3.number, 3);
  store.addMark(rectMark(FRAME, { x: 0, y: 0, width: 1, height: 1 }));
  assert.throws(() => store.deleteGroup(group3.id), /non-empty/);

  const lastGroupStore = new AnnotatorStore();
  assert.throws(() => lastGroupStore.deleteGroup(lastGroupStore.getGroups()[0].id), /last group/);
});

test('batch mask style persists opacity and rejects non-mask selections atomically', () => {
  const store = new AnnotatorStore();
  const mask = store.addMark(maskMark(FRAME, { x: 0, y: 0, width: 10, height: 10 }));
  const rectangle = store.addMark(rectMark(FRAME, { x: 20, y: 0, width: 10, height: 10 }));
  store.updateMaskStyle([mask.id], 0.75);
  let persistedMask = store.getMarks()[0];
  assert.equal(persistedMask.type === 'mask' && persistedMask.opacity, 0.75);
  assert.throws(() => store.updateMaskStyle([mask.id, rectangle.id], 0.4));
  persistedMask = store.getMarks()[0];
  assert.equal(persistedMask.type === 'mask' && persistedMask.opacity, 0.75);
});

test('undo with empty history returns false and leaves state unchanged', () => {
  const store = new AnnotatorStore();
  assert.equal(store.undo(), false);
  assert.equal(store.getGroups().length, 1);
});

test('redo stack is cleared by a new action after an undo', () => {
  const store = new AnnotatorStore();
  const mark = store.addMark(rectMark(FRAME, { x: 0, y: 0, width: 10, height: 10 }));
  store.undo();
  store.addMark(rectMark(FRAME, { x: 1, y: 1, width: 1, height: 1 }));
  const redone = store.redo();
  assert.equal(redone, false, 'redo history must be invalidated by a new action');
  assert.equal(store.getMarks().length, 1);
  void mark;
});

test('computeBadgeClusters groups nearby marks into one cluster and distant marks into separate clusters', () => {
  const store = new AnnotatorStore();
  const group = store.getGroups()[0];

  // Two overlapping/near rects -> one cluster.
  store.addMark(rectMark(FRAME, { x: 0, y: 0, width: 20, height: 20 }));
  store.addMark(rectMark(FRAME, { x: 15, y: 15, width: 20, height: 20 }));
  // A far-away rect -> separate cluster.
  store.addMark(rectMark(FRAME, { x: 1000, y: 1000, width: 20, height: 20 }));

  const clusters = store.computeBadgeClusters(group.id, 5);
  assert.equal(clusters.length, 2);
});

test('setActiveGroup throws for an unknown groupId', () => {
  const store = new AnnotatorStore();
  assert.throws(() => store.setActiveGroup('grp_does_not_exist'));
});

test('groups start with no references and reject a fourth distinct reference', () => {
  const store = new AnnotatorStore();
  const group1 = store.getGroups()[0];
  const group2 = store.createGroup();
  assert.deepEqual(group2.referenceIds, []);

  store.attachReference(group1.id, 'ref_1');
  store.attachReference(group1.id, 'ref_2');
  store.attachReference(group1.id, 'ref_3');
  assert.deepEqual(store.getGroups()[0].referenceIds, ['ref_1', 'ref_2', 'ref_3']);

  assert.throws(() => store.attachReference(group1.id, 'ref_4'));
  assert.deepEqual(store.getGroups()[0].referenceIds, ['ref_1', 'ref_2', 'ref_3']);
});

test('attachReference and detachReference are idempotent and undoable', () => {
  const store = new AnnotatorStore();
  const groupId = store.getGroups()[0].id;

  store.attachReference(groupId, 'ref_1');
  store.attachReference(groupId, 'ref_1');
  assert.deepEqual(store.getGroups()[0].referenceIds, ['ref_1']);

  assert.equal(store.undo(), true);
  assert.deepEqual(store.getGroups()[0].referenceIds, []);
  assert.equal(store.redo(), true);
  assert.deepEqual(store.getGroups()[0].referenceIds, ['ref_1']);

  store.detachReference(groupId, 'ref_1');
  store.detachReference(groupId, 'ref_1');
  assert.deepEqual(store.getGroups()[0].referenceIds, []);

  assert.equal(store.undo(), true);
  assert.deepEqual(store.getGroups()[0].referenceIds, ['ref_1']);
  assert.equal(store.redo(), true);
  assert.deepEqual(store.getGroups()[0].referenceIds, []);
});
