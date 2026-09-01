import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSelectorHints } from './selector-hints.js';
import type { RawDomCandidate } from './types.js';

function candidate(overrides: Partial<RawDomCandidate> = {}): RawDomCandidate {
  return {
    tempId: 'tmp-0',
    tag: 'button',
    role: null,
    accessibleName: null,
    textSummary: null,
    testIdHint: null,
    idHint: null,
    classHint: null,
    rect: { x: 0, y: 0, width: 10, height: 10 },
    attributes: {},
    parent: null,
    siblings: [],
    computedLayout: {},
    ...overrides,
  };
}

test('test-id hint is preferred first when present', () => {
  const hints = buildSelectorHints(candidate({ testIdHint: 'save-button', idHint: 'save', role: 'button' }));
  assert.equal(hints[0], '[data-testid="save-button"]');
});

test('stable id hint is used when no test id is present', () => {
  const hints = buildSelectorHints(candidate({ idHint: 'save' }));
  assert.equal(hints[0], '#save');
});

test('role/name hint is used when no test id or stable id is present', () => {
  const hints = buildSelectorHints(candidate({ role: 'button', accessibleName: 'Save' }));
  assert.equal(hints[0], 'role=button[name="Save"]');
});

test('structural tag hint is always present as the final fallback', () => {
  const hints = buildSelectorHints(candidate({ tag: 'div' }));
  assert.equal(hints[hints.length - 1], 'div');
});

test('every hint tier can coexist, ordered strongest-first', () => {
  const hints = buildSelectorHints(
    candidate({ testIdHint: 'a', idHint: 'b', role: 'button', accessibleName: 'C', classHint: 'btn primary', tag: 'button' }),
  );
  assert.deepEqual(hints, ['[data-testid="a"]', '#b', 'role=button[name="C"]', 'button.btn', 'button']);
});
