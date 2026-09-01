/**
 * Real-Chromium grounding tests (docs/IMPLEMENTATION_PLAN.md Phase 3 "테스트"
 * section): flex/grid/absolute layout, nested interactive element, icon-only
 * button, scroll offset, device scale factor, blank-area sketch,
 * password/input redaction, DOM-mutation capture consistency.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectDomIndex, captureAndGround } from './capture.js';
import { assertNoForbiddenValues } from './redaction.js';
import type { Mark } from '@redpen/protocol/schema';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(__dirname, '../../../fixtures/frontend/grounding.html');
const fixtureUrl = `file://${fixturePath.replace(/\\/g, '/')}`;
const FRAME = 'frm_grounding_test';

function rectMark(id: string, bounds: { x: number; y: number; width: number; height: number }): Mark {
  return {
    type: 'rectangle',
    id,
    frameId: FRAME,
    groupId: 'grp_test',
    bounds,
    normalizedBounds: bounds,
  };
}

let browser: Browser;

test.before(async () => {
  browser = await chromium.launch({ headless: true });
});

test.after(async () => {
  await browser.close();
});

async function newPage(viewport = { width: 1280, height: 1000 }, deviceScaleFactor = 1): Promise<Page> {
  const page = await browser.newPage({ viewport, deviceScaleFactor });
  await page.goto(fixtureUrl, { waitUntil: 'load' });
  return page;
}

test('flex layout: a rect drawn over a flex chip grounds to that chip, not the flex row ancestor', async () => {
  const page = await newPage();
  try {
    const chipRect = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="chip-b"]')!;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    const mark = rectMark('mrk_1', chipRect);
    const targets = await captureAndGround(page, FRAME, [mark]);
    const top = targets[0];
    assert.equal(top.attributes['data-testid'], 'chip-b');
  } finally {
    await page.close();
  }
});

test('grid layout: a rect drawn over a grid cell grounds to that cell', async () => {
  const page = await newPage();
  try {
    const cellRect = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="cell-2"]')!;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    const targets = await captureAndGround(page, FRAME, [rectMark('mrk_2', cellRect)]);
    assert.equal(targets[0].attributes['data-testid'], 'cell-2');
  } finally {
    await page.close();
  }
});

test('absolute layout: a rect drawn over an absolutely positioned card grounds correctly', async () => {
  const page = await newPage();
  try {
    const rect = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="absolute-card"]')!;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    const targets = await captureAndGround(page, FRAME, [rectMark('mrk_3', rect)]);
    assert.equal(targets[0].attributes['data-testid'], 'absolute-card');
    assert.equal(targets[0].role, 'region');
    assert.equal(targets[0].accessibleName, 'absolute card');
  } finally {
    await page.close();
  }
});

test('nested interactive element: a small mark over the nested button resolves to the button, not the wrapper', async () => {
  const page = await newPage();
  try {
    const rect = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="nested-button"]')!;
      const r = el.getBoundingClientRect();
      return { x: r.x + 5, y: r.y + 5, width: 10, height: 10 };
    });
    const targets = await captureAndGround(page, FRAME, [rectMark('mrk_4', rect)]);
    const best = targets.reduce((a, b) => (a.rect.width * a.rect.height <= b.rect.width * b.rect.height ? a : b));
    assert.equal(best.attributes['data-testid'], 'nested-button');
  } finally {
    await page.close();
  }
});

test('icon-only button (no text) still gets a target with its aria-label as accessibleName', async () => {
  const page = await newPage();
  try {
    const rect = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="icon-button"]')!;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    const targets = await captureAndGround(page, FRAME, [rectMark('mrk_5', rect)]);
    const iconTarget = targets.find((t) => t.attributes['data-testid'] === 'icon-button');
    assert.ok(iconTarget, 'icon button must be found even without text content');
    assert.equal(iconTarget?.accessibleName, 'settings');
    assert.equal(iconTarget?.text, null);
  } finally {
    await page.close();
  }
});

test('scroll offset: an element only reachable after scrolling is grounded using post-scroll coordinates', async () => {
  const page = await newPage();
  try {
    await page.evaluate(() => window.scrollTo(0, 2050));
    const rect = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="scrolled-target"]')!;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    const targets = await captureAndGround(page, FRAME, [rectMark('mrk_6', rect)]);
    assert.equal(targets[0].attributes['data-testid'], 'scrolled-target');
  } finally {
    await page.close();
  }
});

test('device scale factor: grounding still resolves correctly at deviceScaleFactor=2 (CSS pixel rects only)', async () => {
  const page = await newPage({ width: 1280, height: 1000 }, 2);
  try {
    const rect = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="absolute-card"]')!;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    const index = await collectDomIndex(page);
    assert.equal(index.viewport.deviceScaleFactor, 2);
    const targets = await captureAndGround(page, FRAME, [rectMark('mrk_7', rect)]);
    assert.equal(targets[0].attributes['data-testid'], 'absolute-card');
  } finally {
    await page.close();
  }
});

test('blank area sketch: a mark over empty space falls back to the nearest container instead of finding nothing', async () => {
  const page = await newPage();
  try {
    const rect = { x: 1100, y: 850, width: 100, height: 50 }; // right of #blank-area, no element there
    const targets = await captureAndGround(page, FRAME, [rectMark('mrk_8', rect)]);
    assert.ok(targets.length > 0, 'a nearest-container fallback target must still be produced');
  } finally {
    await page.close();
  }
});

test('password/input value redaction: grounding never leaks the password value into targets', async () => {
  const page = await newPage();
  try {
    const rect = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="password-field"]')!;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    const targets = await captureAndGround(page, FRAME, [rectMark('mrk_9', rect)]);
    assert.doesNotThrow(() => assertNoForbiddenValues(targets, ['do-not-collect-me']));
    const passwordTarget = targets.find((t) => t.attributes['data-testid'] === 'password-field');
    assert.ok(passwordTarget, 'the password field element itself is still a valid grounding candidate');
  } finally {
    await page.close();
  }
});

test('DOM mutation before/after capture: grounding reflects the DOM state at capture time, not a stale snapshot', async () => {
  const page = await newPage();
  try {
    const beforeRect = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="absolute-card"]')!;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    const beforeTargets = await captureAndGround(page, FRAME, [rectMark('mrk_10a', beforeRect)]);
    assert.equal(beforeTargets[0].attributes['data-testid'], 'absolute-card');

    // Mutate the DOM: move the card far away and add a new element in its place.
    await page.evaluate(() => {
      const card = document.querySelector('[data-testid="absolute-card"]') as HTMLElement;
      card.style.top = '5000px';
      const replacement = document.createElement('div');
      replacement.setAttribute('data-testid', 'replacement-card');
      replacement.style.position = 'absolute';
      replacement.style.top = '300px';
      replacement.style.left = '40px';
      replacement.style.width = '220px';
      replacement.style.height = '100px';
      replacement.style.background = '#fafafa';
      document.body.appendChild(replacement);
    });

    const afterRect = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="replacement-card"]')!;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    const afterTargets = await captureAndGround(page, FRAME, [rectMark('mrk_10b', afterRect)]);
    assert.equal(afterTargets[0].attributes['data-testid'], 'replacement-card');
    assert.ok(
      !afterTargets.some((t) => t.attributes['data-testid'] === 'absolute-card'),
      'the moved-away original element must not still be grounded at its old position',
    );
  } finally {
    await page.close();
  }
});
