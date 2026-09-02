/**
 * Session and task state transition validation (docs/ARCHITECTURE.md §5).
 *
 * ```
 * browsing --> annotating: freeze
 * annotating --> annotating: freeze (replace the current capture)
 * annotating --> browsing: discard capture (annotation tab closed)
 * annotating --> submitted: submit
 * submitted --> working: claim
 * working --> review: implementation ready
 * review --> annotating: annotate revision
 * review --> done: accept
 * browsing --> cancelled
 * annotating --> cancelled
 * browsing --> error: open/capture failure
 * annotating --> error: capture/export failure
 * error --> browsing: retry
 * ```
 */
import type { SessionState, TaskState } from './schema.js';

export type SessionTransition =
  | 'freeze'
  | 'discard-capture'
  | 'submit'
  | 'claim'
  | 'implementation-ready'
  | 'annotate-revision'
  | 'accept'
  | 'cancel'
  | 'fail'
  | 'retry';

const SESSION_TRANSITIONS: Record<SessionState, Partial<Record<SessionTransition, SessionState>>> = {
  browsing: { freeze: 'annotating', cancel: 'cancelled', fail: 'error' },
  annotating: { freeze: 'annotating', 'discard-capture': 'browsing', submit: 'submitted', cancel: 'cancelled', fail: 'error' },
  submitted: { claim: 'working' },
  working: { 'implementation-ready': 'review' },
  review: { 'annotate-revision': 'annotating', accept: 'done' },
  done: {},
  cancelled: {},
  error: { retry: 'browsing' },
};

export class InvalidSessionTransitionError extends Error {
  constructor(public readonly from: SessionState, public readonly transition: SessionTransition) {
    super(`invalid session transition '${transition}' from state '${from}'`);
    this.name = 'InvalidSessionTransitionError';
  }
}

export function nextSessionState(current: SessionState, transition: SessionTransition): SessionState {
  const next = SESSION_TRANSITIONS[current]?.[transition];
  if (!next) {
    throw new InvalidSessionTransitionError(current, transition);
  }
  return next;
}

export function isValidSessionTransition(current: SessionState, transition: SessionTransition): boolean {
  return Boolean(SESSION_TRANSITIONS[current]?.[transition]);
}

// --- Task state (subset of session lifecycle, once a task exists) ---

export type TaskTransition = 'claim' | 'implementation-ready' | 'accept' | 'revise' | 'cancel';

const TASK_TRANSITIONS: Record<TaskState, Partial<Record<TaskTransition, TaskState>>> = {
  submitted: { claim: 'working', cancel: 'cancelled' },
  working: { 'implementation-ready': 'review', cancel: 'cancelled' },
  review: { accept: 'done', revise: 'working', cancel: 'cancelled' },
  done: {},
  cancelled: {},
};

export class InvalidTaskTransitionError extends Error {
  constructor(public readonly from: TaskState, public readonly transition: TaskTransition) {
    super(`invalid task transition '${transition}' from state '${from}'`);
    this.name = 'InvalidTaskTransitionError';
  }
}

export function nextTaskState(current: TaskState, transition: TaskTransition): TaskState {
  const next = TASK_TRANSITIONS[current]?.[transition];
  if (!next) {
    throw new InvalidTaskTransitionError(current, transition);
  }
  return next;
}

export function isValidTaskTransition(current: TaskState, transition: TaskTransition): boolean {
  return Boolean(TASK_TRANSITIONS[current]?.[transition]);
}
