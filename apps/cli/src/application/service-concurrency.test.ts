import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { generateSessionId } from '@redpen/protocol/ids';
import { RedpenApplicationService } from './service.js';
import { loadSession, saveSession } from './session-store.js';

interface ServiceInternals {
  referenceMutationTails: Map<string, Promise<void>>;
  enqueueLifecycleMutation: <T>(sessionId: string, operation: () => Promise<T>) => Promise<T>;
  submitReady: (sessionId: string, globalNote?: string) => Promise<{ session: object; taskId: string }>;
  abandonCapture: (sessionId: string) => Promise<void>;
  capabilities: Map<string, { overlay?: string; annotator?: string }>;
  browser: { getPage: (sessionId: string) => { close: () => Promise<void> } | undefined };
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

test('closing the annotator tab discards its capture and returns to browsing', { concurrency: false }, async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'redpen-abandon-capture-'));
  const previousAppData = process.env.APPDATA;
  const previousXdgData = process.env.XDG_DATA_HOME;
  process.env.APPDATA = dataRoot;
  process.env.XDG_DATA_HOME = dataRoot;

  try {
    const sessionId = generateSessionId();
    const now = new Date().toISOString();
    await saveSession({
      schemaVersion: 1,
      id: sessionId,
      state: 'annotating',
      workspaceRoot: dataRoot,
      targetUrl: 'http://127.0.0.1:4173/',
      createdAt: now,
      updatedAt: now,
    });
    const service = new RedpenApplicationService();
    const internals = service as unknown as ServiceInternals;
    internals.capabilities.set(sessionId, { overlay: 'overlay', annotator: 'annotator' });

    await internals.abandonCapture(sessionId);

    assert.equal((await loadSession(sessionId))?.state, 'browsing');
    assert.equal(service.getBrowserCapability(sessionId, 'overlay'), 'overlay');
    assert.equal(service.getBrowserCapability(sessionId, 'annotator'), undefined);
  } finally {
    if (previousAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = previousAppData;
    if (previousXdgData === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previousXdgData;
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('closing the target tab immediately removes its session resources', { concurrency: false }, async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'redpen-target-close-'));
  const previousAppData = process.env.APPDATA;
  const previousXdgData = process.env.XDG_DATA_HOME;
  const previousHeadless = process.env.REDPEN_HEADLESS;
  process.env.APPDATA = dataRoot;
  process.env.XDG_DATA_HOME = dataRoot;
  process.env.REDPEN_HEADLESS = '1';
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end('<!doctype html><title>Target close</title>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  const service = new RedpenApplicationService();
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');
    const session = await service.openSession({
      url: `http://127.0.0.1:${address.port}/`,
      workspaceRoot: dataRoot,
    });
    const page = (service as unknown as ServiceInternals).browser.getPage(session.id);
    assert.ok(page);
    const closed = new Promise<void>((resolve) => service.onTargetPageClosed(() => resolve()));

    await page.close();
    await closed;

    assert.equal(await loadSession(session.id), null);
    assert.equal(service.isIdle(), true);
  } finally {
    await service.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previousAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = previousAppData;
    if (previousXdgData === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previousXdgData;
    if (previousHeadless === undefined) delete process.env.REDPEN_HEADLESS;
    else process.env.REDPEN_HEADLESS = previousHeadless;
    await rm(dataRoot, { recursive: true, force: true });
  }
});
