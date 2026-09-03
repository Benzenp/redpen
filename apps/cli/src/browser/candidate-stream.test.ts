import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BrowserManager } from './manager.js';
import { CandidateStreamError, CandidateStreamManager } from './candidate-stream.js';

async function fixtureServer(): Promise<{ server: ReturnType<typeof createServer>; url: string }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(`<!doctype html><html><body><div id="edit" contenteditable="true" style="position:fixed;inset:0"></div><output id="state"></output><script>
      window.state = { pointer: null, text: '' };
      document.addEventListener('pointerdown', (event) => { window.state.pointer = [event.clientX, event.clientY]; document.querySelector('#state').textContent = 'pointer'; });
      document.addEventListener('input', (event) => { window.state.text = event.target.textContent; });
      document.querySelector('#edit').focus();
    </script></body></html>`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture server did not bind');
  return { server, url: `http://127.0.0.1:${address.port}/` };
}

test('streams CDP frames, dispatches input, validates requests, and closes only candidate pages', async () => {
  const profileDir = await mkdtemp(path.join(os.tmpdir(), 'redpen-candidate-stream-'));
  const { server, url } = await fixtureServer();
  const browser = new BrowserManager({ profileDir, headless: true });
  const streams = new CandidateStreamManager(browser);
  try {
    const context = await browser.ensureContext();
    const pagesBefore = context.pages().length;
    await streams.openCandidate('candidate-1', url);
    const frame = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('did not receive a CDP screencast frame')), 10_000);
      const unsubscribe = streams.subscribe('candidate-1', (received) => {
        clearTimeout(timeout);
        unsubscribe();
        resolve(received);
      });
    });
    assert.equal((frame as { mimeType: string }).mimeType, 'image/jpeg');
    assert.ok((frame as { data: string }).data.length > 0);

    await streams.dispatchInput('candidate-1', { type: 'pointerDown', x: 0.5, y: 0.5 });
    await streams.dispatchInput('candidate-1', { type: 'insertText', text: 'candidate text' });
    const candidatePage = context.pages().find((page) => page.url() === url);
    assert.ok(candidatePage);
    const state = await candidatePage.evaluate(() => (window as unknown as { state: { pointer: number[] | null; text: string } }).state);
    assert.ok(state.pointer);
    assert.equal(state.text, 'candidate text');

    await assert.rejects(() => streams.openCandidate('bad/id', url), (error: unknown) => error instanceof CandidateStreamError && error.code === 'INVALID_CANDIDATE_ID');
    await assert.rejects(() => streams.openCandidate('remote', 'https://example.com/'), (error: unknown) => error instanceof CandidateStreamError && error.code === 'INVALID_URL');
    await assert.rejects(() => streams.dispatchInput('candidate-1', { type: 'pointerMove', x: 2, y: 0 }), (error: unknown) => error instanceof CandidateStreamError && error.code === 'INVALID_INPUT');
    await assert.rejects(() => streams.dispatchInput('candidate-1', { type: 'insertText', text: 'x'.repeat(16_385) }), (error: unknown) => error instanceof CandidateStreamError && error.code === 'INVALID_INPUT');

    await streams.closeAll();
    assert.deepEqual(streams.listCandidates(), []);
    assert.equal(context.pages().length, pagesBefore);
  } finally {
    await streams.closeAll();
    await browser.closeAll();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
