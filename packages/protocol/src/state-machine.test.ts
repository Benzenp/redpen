import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  nextSessionState,
  isValidSessionTransition,
  InvalidSessionTransitionError,
  nextTaskState,
  isValidTaskTransition,
  InvalidTaskTransitionError,
  type SessionTransition,
} from './state-machine.js';
import { sessionStateSchema, taskStateSchema } from './schema.js';

const ALL_SESSION_STATES = sessionStateSchema.options;
const ALL_SESSION_TRANSITIONS: SessionTransition[] = [
  'freeze',
  'submit',
  'claim',
  'implementation-ready',
  'annotate-revision',
  'accept',
  'cancel',
  'fail',
  'retry',
];

const LEGAL_SESSION_TRANSITIONS: Array<[Parameters<typeof nextSessionState>[0], SessionTransition, string]> = [
  ['browsing', 'freeze', 'annotating'],
  ['annotating', 'submit', 'submitted'],
  ['submitted', 'claim', 'working'],
  ['working', 'implementation-ready', 'review'],
  ['review', 'annotate-revision', 'annotating'],
  ['review', 'accept', 'done'],
  ['browsing', 'cancel', 'cancelled'],
  ['annotating', 'cancel', 'cancelled'],
  ['browsing', 'fail', 'error'],
  ['annotating', 'fail', 'error'],
  ['error', 'retry', 'browsing'],
];

test('every documented legal session transition succeeds and lands on the expected state', () => {
  for (const [from, transition, expected] of LEGAL_SESSION_TRANSITIONS) {
    assert.equal(nextSessionState(from, transition), expected);
    assert.equal(isValidSessionTransition(from, transition), true);
  }
});

test('every non-documented (state, transition) pair is rejected', () => {
  const legalSet = new Set(LEGAL_SESSION_TRANSITIONS.map(([from, t]) => `${from}:${t}`));
  let checked = 0;
  for (const state of ALL_SESSION_STATES) {
    for (const transition of ALL_SESSION_TRANSITIONS) {
      checked++;
      const key = `${state}:${transition}`;
      if (legalSet.has(key)) continue;
      assert.equal(isValidSessionTransition(state, transition), false, key);
      assert.throws(() => nextSessionState(state, transition), InvalidSessionTransitionError, key);
    }
  }
  // Sanity: we actually enumerated all 8 states x 9 transitions = 72 pairs.
  assert.equal(checked, ALL_SESSION_STATES.length * ALL_SESSION_TRANSITIONS.length);
});

test('terminal states (done, cancelled) accept no transitions', () => {
  for (const transition of ALL_SESSION_TRANSITIONS) {
    assert.equal(isValidSessionTransition('done', transition), false);
    assert.equal(isValidSessionTransition('cancelled', transition), false);
  }
});

// --- Task transitions ---

const ALL_TASK_STATES = taskStateSchema.options;
const ALL_TASK_TRANSITIONS = ['claim', 'implementation-ready', 'accept', 'revise', 'cancel'] as const;
const LEGAL_TASK_TRANSITIONS: Array<[(typeof ALL_TASK_STATES)[number], (typeof ALL_TASK_TRANSITIONS)[number], string]> = [
  ['submitted', 'claim', 'working'],
  ['submitted', 'cancel', 'cancelled'],
  ['working', 'implementation-ready', 'review'],
  ['working', 'cancel', 'cancelled'],
  ['review', 'accept', 'done'],
  ['review', 'revise', 'working'],
  ['review', 'cancel', 'cancelled'],
];

test('every documented legal task transition succeeds', () => {
  for (const [from, transition, expected] of LEGAL_TASK_TRANSITIONS) {
    assert.equal(nextTaskState(from, transition), expected);
    assert.equal(isValidTaskTransition(from, transition), true);
  }
});

test('every non-documented task (state, transition) pair is rejected', () => {
  const legalSet = new Set(LEGAL_TASK_TRANSITIONS.map(([from, t]) => `${from}:${t}`));
  for (const state of ALL_TASK_STATES) {
    for (const transition of ALL_TASK_TRANSITIONS) {
      const key = `${state}:${transition}`;
      if (legalSet.has(key)) continue;
      assert.equal(isValidTaskTransition(state, transition), false, key);
      assert.throws(() => nextTaskState(state, transition), InvalidTaskTransitionError, key);
    }
  }
});
