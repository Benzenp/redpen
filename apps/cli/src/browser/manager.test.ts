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
    const page = await manager.openPage(
      'session-1',
      `http://127.0.0.1:${address.port}/`,
      { port: 1, token: 'test-overlay' },
    );
    assert.equal(page.context().pages().length, 1);
    assert.equal(page.context().pages().some((candidate) => candidate.url() === 'about:blank'), false);
    const freezeButtonStyle = await page.evaluate(() => {
      const button = document.getElementById('__redpen_freeze_overlay_button__');
      if (!button) return null;
      const style = getComputedStyle(button);
      return {
        backgroundColor: style.backgroundColor,
        borderRadius: style.borderRadius,
        borderStyle: style.borderStyle,
        text: button.textContent,
      };
    });
    assert.deepEqual(freezeButtonStyle, {
      backgroundColor: 'rgb(192, 192, 192)',
      borderRadius: '0px',
      borderStyle: 'outset',
      text: 'Freeze screen (F9)',
    });
    await page.context().close();
    await notified;
    assert.equal(unexpectedCloses, 1);

    await manager.openPage('session-2', `http://127.0.0.1:${address.port}/`);
    await manager.closeAll();
    assert.equal(unexpectedCloses, 1);
  } finally {
    await manager.closeAll();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('distinguishes user-closed target and annotator tabs from managed closes', async () => {
  const profileDir = await mkdtemp(path.join(os.tmpdir(), 'redpen-page-close-'));
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end('<!doctype html><title>Page close test</title>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');

  const manager = new BrowserManager({ profileDir, headless: true });
  const targetCloses: string[] = [];
  const annotatorCloses: string[] = [];
  let targetClosed!: () => void;
  let annotatorClosed!: () => void;
  const targetNotification = new Promise<void>((resolve) => { targetClosed = resolve; });
  const annotatorNotification = new Promise<void>((resolve) => { annotatorClosed = resolve; });
  manager.onUnexpectedTargetPageClose((sessionId) => {
    targetCloses.push(sessionId);
    targetClosed();
  });
  manager.onUnexpectedAnnotatorPageClose((sessionId) => {
    annotatorCloses.push(sessionId);
    annotatorClosed();
  });

  try {
    const url = `http://127.0.0.1:${address.port}/`;
    const target = await manager.openPage('user-target', url);
    await target.close();
    await targetNotification;
    assert.deepEqual(targetCloses, ['user-target']);
    assert.equal(manager.getPage('user-target'), undefined);

    await manager.openPage('managed', url);
    const annotator = await manager.openAnnotatorTab('managed', url);
    await annotator.close();
    await annotatorNotification;
    assert.deepEqual(annotatorCloses, ['managed']);
    assert.equal(manager.getAnnotatorPage('managed'), undefined);

    await manager.closePage('managed');
    await Promise.resolve();
    assert.deepEqual(targetCloses, ['user-target']);
    assert.deepEqual(annotatorCloses, ['managed']);
  } finally {
    await manager.closeAll();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
