import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDomTargets, scoreCandidatesForMark } from './ground.js';
import { assertNoForbiddenValues, ForbiddenDataError } from './redaction.js';
import type { RawDomCandidate, RawDomIndex } from './types.js';
import type { Mark } from '@redpen/protocol/schema';

const FRAME = 'frm_test';

function makeIndex(candidates: RawDomCandidate[]): RawDomIndex {
  return {
    capturedAt: '2026-09-01T00:00:00.000Z',
    viewport: { width: 1280, height: 900, deviceScaleFactor: 1 },
    scroll: { x: 0, y: 0 },
    candidates,
  };
}

function candidate(overrides: Partial<RawDomCandidate> = {}): RawDomCandidate {
  return {
    tempId: 'tmp-0',
    tag: 'div',
    role: null,
    accessibleName: null,
    textSummary: null,
    testIdHint: null,
    idHint: null,
    classHint: null,
    rect: { x: 0, y: 0, width: 100, height: 100 },
    attributes: {},
    parent: null,
    siblings: [],
    computedLayout: {},
    ...overrides,
  };
}

function rectMark(bounds: { x: number; y: number; width: number; height: number }, groupId = 'grp_1'): Mark {
  return { type: 'rectangle', id: 'mrk_1', frameId: FRAME, groupId, bounds, normalizedBounds: bounds };
}

test('scoreCandidatesForMark ranks a small tightly-overlapping candidate above a huge loosely-overlapping ancestor', () => {
  const small = candidate({ tempId: 'small', rect: { x: 10, y: 10, width: 20, height: 20 } });
  const huge = candidate({ tempId: 'huge', rect: { x: 0, y: 0, width: 1000, height: 1000 } });
  const mark = rectMark({ x: 10, y: 10, width: 20, height: 20 });

  const scored = scoreCandidatesForMark(mark, makeIndex([huge, small]));
  const sorted = scored.sort((a, b) => b.score - a.score);
  assert.equal(sorted[0].candidate.tempId, 'small');
});

test('multiple similar candidates are preserved with distinct ranking, never collapsed to one', () => {
  const a = candidate({ tempId: 'a', rect: { x: 0, y: 0, width: 50, height: 50 } });
  const b = candidate({ tempId: 'b', rect: { x: 5, y: 5, width: 50, height: 50 } });
  const mark = rectMark({ x: 0, y: 0, width: 50, height: 50 });

  const scored = scoreCandidatesForMark(mark, makeIndex([a, b]));
  assert.equal(scored.length, 2);
  assert.notDeepEqual(scored[0].score, undefined);
});

test('arrow mark grounds from-point as arrow-source and to-point as arrow-destination separately', () => {
  const sourceEl = candidate({ tempId: 'source', rect: { x: 0, y: 0, width: 20, height: 20 } });
  const destEl = candidate({ tempId: 'dest', rect: { x: 200, y: 200, width: 20, height: 20 } });
  const mark: Mark = {
    type: 'arrow',
    id: 'mrk_arrow',
    frameId: FRAME,
    groupId: 'grp_1',
    from: { x: 10, y: 10 },
    to: { x: 210, y: 210 },
    bounds: { x: 10, y: 10, width: 200, height: 200 },
    normalizedBounds: { x: 10, y: 10, width: 200, height: 200 },
  };

  const scored = scoreCandidatesForMark(mark, makeIndex([sourceEl, destEl]));
  const sourceScore = scored.find((s) => s.candidate.tempId === 'source');
  const destScore = scored.find((s) => s.candidate.tempId === 'dest');
  assert.equal(sourceScore?.relation, 'arrow-source');
  assert.equal(destScore?.relation, 'arrow-destination');
});

test('DOM target is not required for submission: an empty candidate index yields zero targets without throwing', () => {
  const mark = rectMark({ x: 0, y: 0, width: 10, height: 10 });
  const targets = buildDomTargets(FRAME, [mark], makeIndex([]));
  assert.deepEqual(targets, []);
});

test('buildDomTargets deduplicates by tempId across multiple marks in the same group', () => {
  const shared = candidate({ tempId: 'shared', rect: { x: 0, y: 0, width: 100, height: 100 } });
  const markA = rectMark({ x: 0, y: 0, width: 50, height: 50 }, 'grp_1');
  const markB = rectMark({ x: 50, y: 50, width: 50, height: 50 }, 'grp_1');

  const targets = buildDomTargets(FRAME, [markA, markB], makeIndex([shared]));
  assert.equal(targets.length, 1);
  assert.deepEqual(targets[0].groupIds, ['grp_1']);
});

test('buildDomTargets records every distinct groupId that grounds to the same element', () => {
  const shared = candidate({ tempId: 'shared', rect: { x: 0, y: 0, width: 100, height: 100 } });
  const markA = rectMark({ x: 0, y: 0, width: 50, height: 50 }, 'grp_1');
  const markB = rectMark({ x: 50, y: 50, width: 50, height: 50 }, 'grp_2');

  const targets = buildDomTargets(FRAME, [markA, markB], makeIndex([shared]));
  assert.equal(targets.length, 1);
  assert.deepEqual(targets[0].groupIds.sort(), ['grp_1', 'grp_2']);
});

test('buildDomTargets only exposes the computedLayout allowlist keys, dropping anything else', () => {
  const withExtraLayout = candidate({
    tempId: 'x',
    rect: { x: 0, y: 0, width: 50, height: 50 },
    computedLayout: { display: 'flex', zIndex: '999', cursor: 'pointer' },
  });
  const mark = rectMark({ x: 0, y: 0, width: 50, height: 50 });
  const targets = buildDomTargets(FRAME, [mark], makeIndex([withExtraLayout]));
  assert.deepEqual(targets[0].context?.computedLayout, { display: 'flex' });
});

test('assertNoForbiddenValues throws when a target result contains a forbidden literal', () => {
  const withSecret = [{ text: 'contains super-secret-token somewhere' }];
  assert.throws(() => assertNoForbiddenValues(withSecret, ['super-secret-token']), ForbiddenDataError);
});

test('assertNoForbiddenValues passes when none of the forbidden values are present', () => {
  const clean = [{ text: 'nothing sensitive here' }];
  assert.doesNotThrow(() => assertNoForbiddenValues(clean, ['super-secret-token', 'cookie-value']));
});
