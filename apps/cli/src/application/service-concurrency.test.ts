import assert from 'node:assert/strict';
import test from 'node:test';
import { RedpenApplicationService } from './service.js';

interface ServiceInternals {
  referenceMutationTails: Map<string, Promise<void>>;
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

  releaseReference();
  assert.equal((await submission).taskId, 'task-1');
  assert.equal(submitReadyCalled, true);
});
