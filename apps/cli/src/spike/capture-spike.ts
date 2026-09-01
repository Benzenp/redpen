/**
 * Phase 0 capture spike (docs/IMPLEMENTATION_PLAN.md #3).
 *
 * Validates the core architectural assumption: a single Playwright persistent
 * Chromium context can
 *   1. open a localhost fixture page,
 *   2. inject a Shadow DOM "Mark this screen" floating control that does not
 *      leak styles into the host page,
 *   3. on click, hide the control and capture a viewport screenshot together
 *      with a visible DOM index from the *same* moment,
 *   4. resolve screenshot-space click coordinates back to the correct DOM
 *      element, including after scrolling,
 *   5. never persist password input values into the DOM index.
 *
 * Run: `pnpm --filter @redpen/cli run spike:capture`
 * Output: apps/cli/.spike-output/{screenshot.png, dom-index.json, report.json}
 */
import { chromium } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findCandidateAtPoint, type DomIndexResult } from './dom-index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(__dirname, '../../../../fixtures/frontend/index.html');
const fixtureUrl = `file://${fixturePath.replace(/\\/g, '/')}`;
const outputDir = path.resolve(__dirname, '../../.spike-output');
const profileDir = path.resolve(__dirname, '../../.spike-profile');
const domIndexBrowserScriptPath = path.resolve(__dirname, './dom-index-browser.js');

interface CheckResult {
  name: string;
  pass: boolean;
  detail: string;
}

async function injectShadowControl(page: import('playwright').Page) {
  await page.evaluate(() => {
    const host = document.createElement('div');
    host.id = 'redpen-spike-control-host';
    host.style.position = 'fixed';
    host.style.top = '12px';
    host.style.right = '12px';
    host.style.zIndex = '2147483647';
    document.body.appendChild(host);

    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      button {
        font: 14px system-ui, sans-serif;
        background: #dc2626;
        color: white;
        border: none;
        border-radius: 6px;
        padding: 8px 14px;
        cursor: pointer;
      }
    `;
    const button = document.createElement('button');
    button.id = 'mark-screen-button';
    button.textContent = 'Mark this screen';
    button.addEventListener('click', () => {
      host.style.display = 'none';
      (window as unknown as { __redpenControlHidden?: boolean }).__redpenControlHidden = true;
    });
    shadow.appendChild(style);
    shadow.appendChild(button);
  });
}

async function clickShadowMarkButton(page: import('playwright').Page) {
  await page.evaluate(() => {
    const host = document.getElementById('redpen-spike-control-host');
    const shadow = host?.shadowRoot;
    const button = shadow?.getElementById('mark-screen-button') as HTMLButtonElement | undefined;
    button?.click();
  });
}

async function captureAtCurrentScroll(
  page: import('playwright').Page,
  label: string,
  domIndexBrowserScript: string,
) {
  await clickShadowMarkButton(page);

  const hidden = await page.evaluate(
    () => (window as unknown as { __redpenControlHidden?: boolean }).__redpenControlHidden === true,
  );

  const domIndex = (await page.evaluate(domIndexBrowserScript)) as DomIndexResult;

  const screenshotPath = path.join(outputDir, `screenshot-${label}.png`);
  await page.screenshot({ path: screenshotPath });

  // Re-show the control for subsequent captures in this spike run.
  await page.evaluate(() => {
    const host = document.getElementById('redpen-spike-control-host');
    if (host) host.style.display = '';
    (window as unknown as { __redpenControlHidden?: boolean }).__redpenControlHidden = false;
  });

  return { hidden, domIndex, screenshotPath };
}

async function main() {
  await mkdir(outputDir, { recursive: true });
  await mkdir(profileDir, { recursive: true });

  const checks: CheckResult[] = [];
  const record = (name: string, pass: boolean, detail: string) => {
    checks.push({ name, pass, detail });
    console.error(`${pass ? 'PASS' : 'FAIL'} ${name}: ${detail}`);
  };

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: true,
    viewport: { width: 1280, height: 900 },
  });

  try {
    const page = context.pages()[0] ?? (await context.newPage());
    const domIndexBrowserScript = await readFile(domIndexBrowserScriptPath, 'utf8');

    await page.goto(fixtureUrl, { waitUntil: 'load' });
    await injectShadowControl(page);

    // --- Capture #1: top of page, before scrolling ---
    const first = await captureAtCurrentScroll(page, 'top', domIndexBrowserScript);
    record(
      'shadow-control-hides-on-click',
      first.hidden,
      first.hidden ? 'control reported hidden after click' : 'control did not report hidden',
    );

    const saveButtonCandidate = first.domIndex.candidates.find((c) => c.testIdHint === 'save-button');
    record(
      'save-button-collected-at-top',
      Boolean(saveButtonCandidate),
      saveButtonCandidate ? `rect=${JSON.stringify(saveButtonCandidate.rect)}` : 'not found in visible index',
    );

    const hiddenElementLeaked = first.domIndex.candidates.some((c) => c.testIdHint === 'hidden-element');
    record(
      'display-none-excluded',
      !hiddenElementLeaked,
      hiddenElementLeaked ? 'hidden element leaked into index' : 'display:none element correctly excluded',
    );

    const offscreenLeaked = first.domIndex.candidates.some((c) => c.testIdHint === 'offscreen-element');
    record(
      'offscreen-excluded-at-top',
      !offscreenLeaked,
      offscreenLeaked ? 'offscreen element leaked into index' : 'far-offscreen element correctly excluded',
    );

    if (saveButtonCandidate) {
      const point = {
        x: saveButtonCandidate.rect.x + saveButtonCandidate.rect.width / 2,
        y: saveButtonCandidate.rect.y + saveButtonCandidate.rect.height / 2,
      };
      const resolved = findCandidateAtPoint(first.domIndex, point);
      record(
        'click-resolves-to-save-button',
        resolved?.testIdHint === 'save-button',
        `resolved testIdHint=${resolved?.testIdHint ?? 'null'}`,
      );
    } else {
      record('click-resolves-to-save-button', false, 'skipped: save button not found');
    }

    // --- Capture #2: after scrolling down (coordinate consistency check) ---
    await page.evaluate(() => window.scrollTo(0, 1100));
    const second = await captureAtCurrentScroll(page, 'scrolled', domIndexBrowserScript);

    const priceCardCandidate = second.domIndex.candidates.find((c) => c.testIdHint === 'price-card');
    record(
      'price-card-collected-after-scroll',
      Boolean(priceCardCandidate),
      priceCardCandidate ? `rect=${JSON.stringify(priceCardCandidate.rect)}` : 'not found after scroll',
    );

    if (priceCardCandidate) {
      const point = {
        x: priceCardCandidate.rect.x + 10,
        y: priceCardCandidate.rect.y + 10,
      };
      const resolved = findCandidateAtPoint(second.domIndex, point);
      record(
        'click-resolves-to-price-card-after-scroll',
        resolved?.testIdHint === 'price-card',
        `resolved testIdHint=${resolved?.testIdHint ?? 'null'}`,
      );
    } else {
      record('click-resolves-to-price-card-after-scroll', false, 'skipped: price card not found');
    }

    record(
      'scroll-offset-recorded',
      second.domIndex.scroll.y === 1100,
      `scroll.y=${second.domIndex.scroll.y}`,
    );

    // --- Sensitive data redaction check ---
    const secretCandidate = second.domIndex.candidates.find((c) => c.testIdHint === 'secret-input');
    const secretLeaksValue = JSON.stringify(second.domIndex).includes('super-secret-value');
    record(
      'password-value-not-collected',
      !secretLeaksValue,
      secretLeaksValue ? 'password value leaked into dom index' : 'password value absent from dom index',
    );
    record(
      'password-input-still-detected-as-candidate',
      Boolean(secretCandidate),
      secretCandidate ? 'password input present as element without value' : 'password input missing entirely',
    );

    await writeFile(
      path.join(outputDir, 'dom-index-top.json'),
      JSON.stringify(first.domIndex, null, 2),
      'utf8',
    );
    await writeFile(
      path.join(outputDir, 'dom-index-scrolled.json'),
      JSON.stringify(second.domIndex, null, 2),
      'utf8',
    );

    const allPass = checks.every((c) => c.pass);
    const report = {
      fixtureUrl,
      generatedAt: new Date().toISOString(),
      allPass,
      checks,
    };
    await writeFile(path.join(outputDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8');

    console.error(`\n${allPass ? 'ALL CHECKS PASSED' : 'SOME CHECKS FAILED'} — see ${outputDir}/report.json`);
    if (!allPass) {
      process.exitCode = 1;
    }
  } finally {
    await context.close();
  }
}

main().catch((err) => {
  console.error('capture spike crashed:', err);
  process.exitCode = 1;
});
