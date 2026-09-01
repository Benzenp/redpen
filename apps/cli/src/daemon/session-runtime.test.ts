import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionRuntime } from './session-runtime.js';

interface RuntimeInternals {
  entries: Map<string, { waiters: unknown[] }>;
}

test('returns a submission that arrived before waiting', async () => {
  const runtime = new SessionRuntime();

  runtime.notifySubmitted('session-1', 'task-1');

  assert.equal(await runtime.waitForSubmission('session-1', 1_000), 'task-1');
});

test('settles all current waiters when a submission arrives', async () => {
  const runtime = new SessionRuntime();
  const first = runtime.waitForSubmission('session-1', 1_000);
  const second = runtime.waitForSubmission('session-1', 1_000);

  runtime.notifySubmitted('session-1', 'task-1');

  assert.deepEqual(await Promise.all([first, second]), ['task-1', 'task-1']);
});

test('removes timed out waiters', async () => {
  const runtime = new SessionRuntime();

  assert.equal(await runtime.waitForSubmission('session-1', 1), null);

  const entry = (runtime as unknown as RuntimeInternals).entries.get('session-1');
  assert.equal(entry?.waiters.length, 0);
});

test('removing a session settles outstanding waits with null', async () => {
  const runtime = new SessionRuntime();
  const wait = runtime.waitForSubmission('session-1', 1_000);

  runtime.remove('session-1');

  assert.equal(await wait, null);
  assert.equal((runtime as unknown as RuntimeInternals).entries.has('session-1'), false);
});

test('clearing the runtime settles waits for every session', async () => {
  const runtime = new SessionRuntime();
  const waits = [
    runtime.waitForSubmission('session-1', 1_000),
    runtime.waitForSubmission('session-2', 1_000),
  ];

  runtime.clear();

  assert.deepEqual(await Promise.all(waits), [null, null]);
  assert.equal((runtime as unknown as RuntimeInternals).entries.size, 0);
});
