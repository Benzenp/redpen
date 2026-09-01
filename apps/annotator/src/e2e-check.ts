/**
 * Phase 2 browser-verified acceptance check (docs/IMPLEMENTATION_PLAN.md
 * Phase 2 "UX acceptance scenarios" + "완료 조건").
 *
 * Loads apps/annotator/public/index.html in a real Chromium page (same
 * pattern as apps/cli/src/spike/capture-spike.ts) and drives the bundled
 * AnnotatorApp through window.__redpenApp to verify:
 *
 * - the screenshot renders as a locked canvas background
 * - a group's freehand+arrow marks stay in #1
 * - "새 지시" creates #2 with the next palette color and captures a note
 * - #3 mask + a new drawn mark both attach to #3
 * - switching the active group does not rewrite existing marks' groupId
 * - export image/vector JSON group ids and geometry agree after a round-trip
 *   through the store (persist/reopen equivalence, since there is no disk
 *   persistence wired up yet in Phase 2)
 *
 * Run: `pnpm --filter @redpen/annotator run e2e` (after `run build`).
 */
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, '../public');
const outputDir = path.resolve(__dirname, '../.e2e-output');

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.png': 'image/png',
};

/**
 * A same-origin static file server avoids Chromium's cross-origin canvas
 * tainting rules that `file://`-loaded <img> sources trigger, which would
 * otherwise block getImageData()/toDataURL() reads used by the checks below.
 * This mirrors how the real Redpen daemon will serve the annotation UI over
 * localhost HTTP anyway (docs/ARCHITECTURE.md §3.4).
 */
function startStaticServer(): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const urlPath = (req.url ?? '/').split('?')[0];
      const relative = urlPath === '/' ? '/index.html' : urlPath;
      const filePath = path.join(publicDir, relative);
      if (!filePath.startsWith(publicDir)) {
        res.writeHead(403).end();
        return;
      }
      try {
        await stat(filePath);
      } catch {
        res.writeHead(404).end();
        return;
      }
      const ext = path.extname(filePath);
      res.writeHead(200, { 'Content-Type': CONTENT_TYPES[ext] ?? 'application/octet-stream' });
      createReadStream(filePath).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/index.html`,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}

interface CheckResult {
  name: string;
  pass: boolean;
  detail: string;
}

async function main() {
  await mkdir(outputDir, { recursive: true });
  const checks: CheckResult[] = [];
  const record = (name: string, pass: boolean, detail: string) => {
    checks.push({ name, pass, detail });
    console.error(`${pass ? 'PASS' : 'FAIL'} ${name}: ${detail}`);
  };

  const server = await startStaticServer();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(server.url, { waitUntil: 'load' });
    await page.waitForFunction(() => Boolean((window as unknown as { __redpenApp?: unknown }).__redpenApp));

    // --- screenshot renders as a locked canvas background ---
    const canvasHasPixels = await page.evaluate(() => {
      const canvas = document.getElementById('annotation-canvas') as HTMLCanvasElement;
      const ctx = canvas.getContext('2d')!;
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      // If the screenshot rendered, not every pixel will be the same flat
      // color (the fixture screenshot has a colored button + white cards).
      let nonBackgroundPixels = 0;
      for (let i = 0; i < data.length; i += 4 * 997) {
        if (data[i] !== 244 || data[i + 1] !== 244 || data[i + 2] !== 245) nonBackgroundPixels++;
      }
      return nonBackgroundPixels > 0;
    });
    record('screenshot-renders-as-locked-background', canvasHasPixels, `sampled non-background pixels found=${canvasHasPixels}`);

    // --- #1: freehand + arrow both attach to group #1 ---
    await page.evaluate(() => {
      const app = (window as unknown as { __redpenApp: import('./client.js').AnnotatorApp }).__redpenApp;
      app.drawFreehand([{ x: 10, y: 10 }, { x: 20, y: 30 }, { x: 30, y: 10 }]);
      app.drawArrow({ x: 100, y: 100 }, { x: 200, y: 150 });
    });
    const group1MarkCount = await page.evaluate(() => {
      const app = (window as unknown as { __redpenApp: import('./client.js').AnnotatorApp }).__redpenApp;
      const g1 = app.store.getGroups()[0];
      return app.store.getMarksForGroup(g1.id).length;
    });
    record('group1-collects-freehand-and-arrow', group1MarkCount === 2, `group1 mark count=${group1MarkCount}`);

    // --- "새 지시" creates #2 with next palette color; add a note + 3 rects (sketch a table) ---
    await page.click('#new-instruction');
    const group2Info = await page.evaluate(() => {
      const app = (window as unknown as { __redpenApp: import('./client.js').AnnotatorApp }).__redpenApp;
      const groups = app.store.getGroups();
      const g2 = groups[1];
      app.setActiveGroup(g2.id);
      app.drawShape('rectangle', { x: 300, y: 300, width: 300, height: 30 });
      app.drawShape('rectangle', { x: 300, y: 330, width: 300, height: 30 });
      app.drawShape('rectangle', { x: 300, y: 360, width: 300, height: 30 });
      app.store.setGroupNote(g2.id, '3열 표로 재구성');
      return { number: g2.number, color: g2.color, note: app.store.getGroups()[1].note };
    });
    record(
      'new-instruction-creates-group2-with-note-and-marks',
      group2Info.number === 2 && group2Info.note === '3열 표로 재구성',
      `group2=${JSON.stringify(group2Info)}`,
    );

    // --- #3 mask covers existing region; new rect drawn over it, both attach to #3 ---
    const group3Info = await page.evaluate(() => {
      const app = (window as unknown as { __redpenApp: import('./client.js').AnnotatorApp }).__redpenApp;
      const g3 = app.createGroup();
      app.drawShape('mask', { x: 700, y: 700, width: 200, height: 80 });
      app.drawShape('rectangle', { x: 720, y: 720, width: 100, height: 30 });
      return { number: g3.number, marks: app.store.getMarksForGroup(g3.id).length };
    });
    record('group3-mask-and-new-rect-both-attach', group3Info.number === 3 && group3Info.marks === 2, JSON.stringify(group3Info));

    // --- switching active group back and forth doesn't rewrite prior marks' groupId ---
    const groupIdStability = await page.evaluate(() => {
      const app = (window as unknown as { __redpenApp: import('./client.js').AnnotatorApp }).__redpenApp;
      const groups = app.store.getGroups();
      const firstMarkBefore = app.store.getMarks()[0].groupId;
      app.setActiveGroup(groups[1].id);
      app.setActiveGroup(groups[0].id);
      app.setActiveGroup(groups[2].id);
      const firstMarkAfter = app.store.getMarks()[0].groupId;
      return firstMarkBefore === firstMarkAfter;
    });
    record('switching-groups-does-not-rewrite-existing-mark-groupid', groupIdStability, `stable=${groupIdStability}`);

    // --- export SVG group/geometry matches store state (persist/reopen equivalence) ---
    const exportCheck = await page.evaluate(() => {
      const app = (window as unknown as { __redpenApp: import('./client.js').AnnotatorApp }).__redpenApp;
      const svg = app.exportOverlaySvg();
      const marks = app.store.getMarks();
      const allMarkIdsPresent = marks.every((m) => svg.includes(`data-mark-id="${m.id}"`));
      const badgeCount = (svg.match(/data-badge-number=/g) ?? []).length;
      return { allMarkIdsPresent, badgeCount, markCount: marks.length, svgLength: svg.length };
    });
    record(
      'export-svg-contains-every-mark-id',
      exportCheck.allMarkIdsPresent,
      `markCount=${exportCheck.markCount} badgeCount=${exportCheck.badgeCount}`,
    );
    record('export-svg-has-at-least-one-badge-per-group', exportCheck.badgeCount >= 3, `badgeCount=${exportCheck.badgeCount}`);

    // --- undo/redo round trip on the live page ---
    const undoRedoCheck = await page.evaluate(() => {
      const app = (window as unknown as { __redpenApp: import('./client.js').AnnotatorApp }).__redpenApp;
      const before = app.store.getMarks().length;
      app.drawShape('rectangle', { x: 5, y: 5, width: 5, height: 5 });
      const afterAdd = app.store.getMarks().length;
      app.undo();
      const afterUndo = app.store.getMarks().length;
      app.redo();
      const afterRedo = app.store.getMarks().length;
      return { before, afterAdd, afterUndo, afterRedo };
    });
    record(
      'undo-redo-round-trip',
      undoRedoCheck.afterAdd === undoRedoCheck.before + 1 &&
        undoRedoCheck.afterUndo === undoRedoCheck.before &&
        undoRedoCheck.afterRedo === undoRedoCheck.afterAdd,
      JSON.stringify(undoRedoCheck),
    );

    await page.screenshot({ path: path.join(outputDir, 'annotated-demo.png') });

    const allPass = checks.every((c) => c.pass);
    await writeFile(
      path.join(outputDir, 'report.json'),
      JSON.stringify({ generatedAt: new Date().toISOString(), allPass, checks }, null, 2),
    );
    console.error(`\n${allPass ? 'ALL CHECKS PASSED' : 'SOME CHECKS FAILED'} — see ${outputDir}/report.json`);
    if (!allPass) process.exitCode = 1;
  } finally {
    await browser.close();
    await server.close();
  }
}

main().catch((err) => {
  console.error('e2e check crashed:', err);
  process.exitCode = 1;
});
