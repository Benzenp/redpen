/**
 * Full Phase 3 pipeline integration test (docs/IMPLEMENTATION_PLAN.md Phase 3
 * 완료 조건): capture screenshot + DOM index in real Chromium -> author marks
 * via @redpen/annotator-core -> ground against the DOM index -> assemble a
 * VisualTask -> write an atomic task bundle via @redpen/protocol -> read it
 * back and verify no forbidden values leaked and the schema round-trips.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import { AnnotatorStore } from '@redpen/annotator-core';
import { writeTaskBundle, readTaskBundle } from '@redpen/protocol/storage';
import { generateSessionId, generateTaskId, generateFrameId } from '@redpen/protocol/ids';
import { captureAndGround } from './capture.js';
import { assembleVisualTask } from './assemble.js';
import { assertNoForbiddenValues } from './redaction.js';
import type { NewMarkInput } from '@redpen/annotator-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(__dirname, '../../../fixtures/frontend/grounding.html');
const fixtureUrl = `file://${fixturePath.replace(/\\/g, '/')}`;

test('capture -> annotate -> ground -> assemble -> atomic bundle write -> read back, with no forbidden values', async () => {
  const browser = await chromium.launch({ headless: true });
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'redpen-bundle-e2e-'));
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    await page.goto(fixtureUrl, { waitUntil: 'load' });

    const frameId = generateFrameId();
    const store = new AnnotatorStore();
    const group1 = store.getGroups()[0];

    const cardRect = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="absolute-card"]')!;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    store.addMark({ type: 'rectangle', frameId, bounds: cardRect, normalizedBounds: cardRect } as NewMarkInput);

    const group2 = store.createGroup();
    const passwordRect = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="password-field"]')!;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    store.addMark({ type: 'rectangle', frameId, bounds: passwordRect, normalizedBounds: passwordRect } as NewMarkInput);
    store.setGroupNote(group2.id, 'remove this field');

    const targets = await captureAndGround(page, frameId, store.getMarks());

    const screenshotBuffer = await page.screenshot();

    const task = assembleVisualTask({
      taskId: generateTaskId(),
      sessionId: generateSessionId(),
      workspaceRoot,
      frame: {
        id: frameId,
        url: fixtureUrl,
        screenshot: 'frames/frame-001/source.png',
        annotated: 'frames/frame-001/annotated.png',
        overlaySvg: 'frames/frame-001/overlay.svg',
        viewport: { width: 1280, height: 1000, deviceScaleFactor: 1 },
        scroll: { x: 0, y: 0 },
        capturedAt: new Date().toISOString(),
      },
      groups: store.getGroups(),
      references: [],
      marks: store.getMarks(),
      targets,
      globalNote: 'fix these two things',
    });

    assert.doesNotThrow(() => assertNoForbiddenValues(task, ['do-not-collect-me']));

    const { finalDir } = await writeTaskBundle(workspaceRoot, task, [
      { relativePath: 'frames/frame-001/source.png', content: screenshotBuffer },
      { relativePath: 'frames/frame-001/annotated.png', content: screenshotBuffer },
      { relativePath: 'frames/frame-001/overlay.svg', content: '<svg xmlns="http://www.w3.org/2000/svg"/>' },
    ]);
    assert.ok(finalDir.length > 0);

    const readBack = await readTaskBundle(workspaceRoot, task.id);
    assert.equal(readBack.groups.length, 2);

    const groupWithCardTarget = readBack.groups.find((g) => g.id === group1.id);
    assert.ok(groupWithCardTarget && groupWithCardTarget.targetIds.length > 0, 'group #1 must have a grounded target');

    const cardTarget = readBack.targets.find((t) => t.id === groupWithCardTarget!.targetIds[0]);
    assert.equal(cardTarget?.attributes['data-testid'], 'absolute-card');

    // The password field is still a valid grounding candidate (element presence
    // is fine to report) but its VALUE must never appear anywhere in the bundle.
    assert.doesNotThrow(() => assertNoForbiddenValues(readBack, ['do-not-collect-me']));
  } finally {
    await browser.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
