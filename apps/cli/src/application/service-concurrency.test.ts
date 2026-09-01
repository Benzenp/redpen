import assert from 'node:assert/strict';
import test from 'node:test';
import { RedpenApplicationService } from './service.js';

interface ServiceInternals {
  referenceMutationTails: Map<string, Promise<void>>;
  enqueueLifecycleMutation: <T>(sessionId: string, operation: () => Promise<T>) => Promise<T>;
  submitReady: (sessionId: string, globalNote?: string) => Promise<{ session: object; taskId: string }>;
}

test('submit waits for reference mutations and blocks later annotation writes', async () => {
  const service = new RedpenApplicationService();
  const internals = service as unknown as ServiceInternals;
  let releaseReference!: () => void;
  const pendingReference = new Promise<void>((resolve) => {
    releaseReference = resolve;
  });
  internals.referenceMutationTails.set('session-1', pendingReference);

  let submitReadyCalled = false;
  internals.submitReady = async () => {
    submitReadyCalled = true;
    return { session: {}, taskId: 'task-1' };
  };

  const submission = service.submit('session-1');
  await Promise.resolve();
  assert.equal(submitReadyCalled, false);
  assert.throws(
    () => service.setGlobalNote('session-1', 'late mutation'),
    /submission is already in progress/,
  );
  await assert.rejects(
    service.cancel('session-1'),
    /submission is already in progress/,
  );

  releaseReference();
  assert.equal((await submission).taskId, 'task-1');
  assert.equal(submitReadyCalled, true);
});

test('session lifecycle mutations execute in one per-session critical section', async () => {
  const service = new RedpenApplicationService();
  const internals = service as unknown as ServiceInternals;
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const order: string[] = [];

  const first = internals.enqueueLifecycleMutation('session-1', async () => {
    order.push('first-start');
    await firstGate;
    order.push('first-end');
  });
  const second = internals.enqueueLifecycleMutation('session-1', async () => {
    order.push('second-start');
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['first-start']);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first-start', 'first-end', 'second-start']);
});
