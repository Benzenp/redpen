import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AnnotatorStore } from '@redpen/annotator-core';
import { startDaemon } from './server.js';

const masterHeaders = (token: string) => ({ Authorization: `Bearer ${token}` });
const jsonHeaders = (token: string) => ({ ...masterHeaders(token), 'Content-Type': 'application/json' });

async function withDaemon(run: (base: string, token: string, service: Awaited<ReturnType<typeof startDaemon>>['service']) => Promise<void>): Promise<void> {
  const daemon = await startDaemon();
  try {
    await run(`http://127.0.0.1:${daemon.port}`, daemon.token, daemon.service);
  } finally {
    await daemon.close();
  }
}

test('browser capabilities are session- and route-scoped', async () => {
  await withDaemon(async (base, master, service) => {
    const capabilities = (service as unknown as { capabilities: Map<string, { overlay: string; annotator: string }> }).capabilities;
    capabilities.set('one', { overlay: 'overlay-one', annotator: 'annotator-one' });
    capabilities.set('two', { overlay: 'overlay-two', annotator: 'annotator-two' });
    (service as unknown as { getSession: (id: string) => Promise<unknown> }).getSession = async (id) => ({ id, state: 'annotating' });
    (service as unknown as { getCaptureScreenshot: (id: string) => Buffer }).getCaptureScreenshot = () => Buffer.from('png');

    assert.equal((await fetch(`${base}/health`)).status, 400);
    const health = await fetch(`${base}/health?challenge=test-challenge`);
    assert.equal(health.status, 200);
    assert.equal(
      (await health.json() as { proof: string }).proof,
      createHmac('sha256', master).update('test-challenge').digest('hex'),
    );
    assert.equal((await fetch(`${base}/sessions/one?token=${master}`)).status, 401);
    assert.equal((await fetch(`${base}/api/sessions/one/annotator?token=`)).status, 401);
    assert.equal((await fetch(`${base}/sessions/one?token=annotator-one`)).status, 401);
    assert.equal((await fetch(`${base}/sessions/two?token=overlay-one`)).status, 401);
    assert.equal((await fetch(`${base}/sessions/one?token=overlay-one`)).status, 200);
    assert.equal((await fetch(`${base}/sessions/one`, { headers: masterHeaders(master) })).status, 200);
    assert.equal((await fetch(`${base}/annotator/one?token=${master}`)).status, 401);
    assert.equal((await fetch(`${base}/annotator/one?token=overlay-one`)).status, 401);
    const annotator = await fetch(`${base}/api/sessions/one/annotator/screenshot?token=annotator-one`);
    assert.equal(annotator.status, 200);
    assert.equal(annotator.headers.get('cache-control'), 'no-store');
    assert.equal(annotator.headers.get('referrer-policy'), 'no-referrer');
    assert.equal((await fetch(`${base}/shutdown`, { method: 'POST' })).status, 401);
    assert.equal((await fetch(`${base}/shutdown`, { method: 'POST', headers: masterHeaders(master) })).status, 202);
  });
});

test('JSON limits and wait timeout reject before service work', async () => {
  await withDaemon(async (base, master, service) => {
    let opens = 0;
    let waits = 0;
    (service as unknown as { openSession: () => Promise<unknown> }).openSession = async () => {
      opens++;
      return {};
    };
    (service as unknown as { waitForSubmission: () => Promise<unknown> }).waitForSubmission = async () => {
      waits++;
      return {};
    };

    assert.equal((await fetch(`${base}/sessions`, { method: 'POST', headers: masterHeaders(master), body: '{}' })).status, 415);
    assert.equal((await fetch(`${base}/sessions`, { method: 'POST', headers: jsonHeaders(master), body: '{' })).status, 400);
    assert.equal((await fetch(`${base}/sessions`, { method: 'POST', headers: jsonHeaders(master), body: JSON.stringify({ data: 'x'.repeat(1024 * 1024) }) })).status, 413);
    assert.equal(opens, 0);
    assert.equal((await fetch(`${base}/sessions/one/wait?timeout=601`, { headers: masterHeaders(master) })).status, 400);
    assert.equal((await fetch(`${base}/sessions/one/wait?timeout=NaN`, { headers: masterHeaders(master) })).status, 400);
    assert.equal(waits, 0);
  });
});

test('reference uploads reject invalid and oversized images predictably', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'redpen-server-security-'));
  try {
    await withDaemon(async (base, _master, service) => {
      const capabilities = (service as unknown as { capabilities: Map<string, { overlay: string; annotator: string }> }).capabilities;
      capabilities.set('one', { overlay: 'overlay-one', annotator: 'annotator-one' });
      (service as unknown as { getSession: () => Promise<unknown> }).getSession = async () => ({ workspaceRoot });
      const store = new AnnotatorStore();
      (service as unknown as { stores: Map<string, AnnotatorStore> }).stores.set('one', store);
      const groupId = store.getActiveGroupId();
      const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer annotator-one' };
      assert.equal((await fetch(`${base}/api/sessions/one/annotator/groups/${groupId}/references`, { method: 'POST', headers, body: JSON.stringify({ pngBase64: 'not png' }) })).status, 400);
      const oversized = Buffer.alloc(8 * 1024 * 1024 + 1).toString('base64');
      assert.equal((await fetch(`${base}/api/sessions/one/annotator/groups/${groupId}/references`, { method: 'POST', headers, body: JSON.stringify({ pngBase64: oversized }) })).status, 413);
    });
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
