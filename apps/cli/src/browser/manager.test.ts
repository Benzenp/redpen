import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BrowserManager } from './manager.js';

test('unexpected Chromium close notifies the daemon but intentional shutdown does not', async () => {
  const profileDir = await mkdtemp(path.join(os.tmpdir(), 'redpen-browser-close-'));
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end('<!doctype html><title>Browser close test</title>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');

  const manager = new BrowserManager({ profileDir, headless: true });
  let unexpectedCloses = 0;
  let notify!: () => void;
  const notified = new Promise<void>((resolve) => {
    notify = resolve;
  });
  manager.onUnexpectedContextClose(() => {
    unexpectedCloses++;
    notify();
  });

  try {
    const page = await manager.openPage('session-1', `http://127.0.0.1:${address.port}/`);
    await page.context().close();
    await notified;
    assert.equal(unexpectedCloses, 1);

    await manager.openPage('session-2', `http://127.0.0.1:${address.port}/`);
    await manager.closeAll();
    assert.equal(unexpectedCloses, 1);
  } finally {
    await manager.closeAll();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(profileDir, { recursive: true, force: true });
  }
});
