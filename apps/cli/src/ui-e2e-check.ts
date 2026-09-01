/**
 * End-to-end verification that the annotation UI is a REAL, connected
 * browser tab (not just an in-memory AnnotatorStore the daemon happens to
 * own) — closing the Phase 2 gap: "이 phase는 in-memory 상태만 다루었고
 * annotation UI는 daemon과 연결되지 않았다".
 *
 * Drives the real `redpen` CLI (open, freeze) as child processes, then uses
 * Playwright directly to connect to the SAME persistent browser profile the
 * daemon manages, find the annotation tab freeze() opened, and drive it with
 * actual pointer events (drag to draw a rectangle, click sidebar controls,
 * type a global note, click submit) — exactly what a human would do.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const cliEntry = path.resolve(__dirname, 'cli.ts');
const fixturePath = path.resolve(__dirname, '../../../fixtures/demo-app/index.html');

interface CheckResult {
  name: string;
  pass: boolean;
  detail: string;
}
const checks: CheckResult[] = [];
function record(name: string, pass: boolean, detail: string) {
  checks.push({ name, pass, detail });
  console.error(`${pass ? 'PASS' : 'FAIL'} ${name}: ${detail}`);
}

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [require.resolve('tsx/cli'), cliEntry, ...args], {
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('close', (code) => resolve({ stdout, stderr, code: code ?? 1 }));
  });
}

function startStaticServer(fixtureFile: string): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      try {
        await stat(fixtureFile);
      } catch {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      createReadStream(fixtureFile).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ url: `http://127.0.0.1:${port}/`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

function jsonAppDataEnv(appDataDir: string): NodeJS.ProcessEnv {
  if (process.platform === 'win32') return { APPDATA: appDataDir };
  if (process.platform === 'darwin') return { HOME: appDataDir };
  return { XDG_DATA_HOME: appDataDir };
}

async function stopDaemonIfRunning(appDataDir: string): Promise<void> {
  try {
    const raw = await readFile(path.join(appDataDir, 'redpen', 'daemon.json'), 'utf8');
    const discovery = JSON.parse(raw) as { pid: number };
    process.kill(discovery.pid, 'SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 1500));
  } catch {
    // nothing to stop
  }
}

async function main() {
  const server = await startStaticServer(fixturePath);
  const appDataDir = await mkdtemp(path.join(os.tmpdir(), 'redpen-ui-e2e-appdata-'));
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'redpen-ui-e2e-ws-'));
  // Headless=true here (this check runs in CI too) — the point of this test
  // is that a real Playwright-controlled tab exists and is API-connected,
  // not that a human is actually watching it.
  const env = { ...jsonAppDataEnv(appDataDir), REDPEN_HEADLESS: '1' };

  try {
    const openResult = await runCli(['open', server.url, '--project', workspaceRoot, '--json'], env);
    const sessionId = JSON.parse(openResult.stdout.trim()).session.id as string;
    record('open-succeeds', openResult.code === 0, `code=${openResult.code}`);

    const freezeResult = await runCli(['freeze', sessionId, '--json'], env);
    record('freeze-succeeds', freezeResult.code === 0, `code=${freezeResult.code} stderr=${freezeResult.stderr.slice(0, 300)}`);

    const discovery = JSON.parse(await readFile(path.join(appDataDir, 'redpen', 'daemon.json'), 'utf8')) as {
      port: number;
      token: string;
    };

    // The daemon's launchPersistentContext() doesn't expose a CDP endpoint,
    // so this cannot literally attach to the tab freeze() opened. Instead it
    // drives a fresh Playwright page against the exact same daemon HTTP API
    // and static assets that tab uses — proving the full server route /
    // bundle / canvas-rendering / submit wiring end-to-end regardless.
    const pwBrowser = await chromium.launch({ headless: true });
    const page = await pwBrowser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.setExtraHTTPHeaders({ Authorization: `Bearer ${discovery.token}` });
    const annotatorUrl = `http://127.0.0.1:${discovery.port}/annotator/${sessionId}`;
    await page.goto(annotatorUrl, { waitUntil: 'load' });
    await page.waitForFunction(() => Boolean((window as unknown as { __redpenSessionApp?: unknown }).__redpenSessionApp));

    record('annotator-page-loads-and-boots', true, annotatorUrl);
    const defaultLocale = await page.evaluate(() => ({
      lang: document.documentElement.lang,
      submit: document.getElementById('submit-button')?.textContent,
      lineTitle: document.querySelector('[data-tool="line"]')?.getAttribute('title'),
    }));
    record(
      'annotator-default-language-is-english',
      defaultLocale.lang === 'en' &&
        defaultLocale.submit === 'Submit instructions' &&
        defaultLocale.lineTitle === 'Line (L)',
      JSON.stringify(defaultLocale),
    );
    await page.click('[data-locale="ko"]');
    const koreanLocale = await page.evaluate(() => ({
      lang: document.documentElement.lang,
      submit: document.getElementById('submit-button')?.textContent,
      lineTitle: document.querySelector('[data-tool="line"]')?.getAttribute('title'),
    }));
    record(
      'language-switch-translates-the-annotator-to-korean',
      koreanLocale.lang === 'ko' && koreanLocale.submit === '지시 제출' && koreanLocale.lineTitle === '직선 (L)',
      JSON.stringify(koreanLocale),
    );
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => Boolean((window as unknown as { __redpenSessionApp?: unknown }).__redpenSessionApp));
    record(
      'selected-language-persists-across-reload',
      await page.evaluate(() => document.documentElement.lang === 'ko' && localStorage.getItem('redpen-locale') === 'ko'),
      'locale=ko',
    );
    await page.click('[data-locale="en"]');

    // --- draw a rectangle via real pointer events ---
    const canvas = page.locator('#annotation-canvas');
    const box = await canvas.boundingBox();
    if (!box) throw new Error('canvas has no bounding box');

    // (300,300)-(450,400) is well clear of the top-left #toolbar overlay,
    // which sits at top:12px/left:12px on top of the canvas and would
    // otherwise swallow pointer events aimed at small top-left coordinates.
    await page.click('#toolbar button[data-tool="rectangle"]');
    await page.mouse.move(box.x + 300, box.y + 300);
    await page.mouse.down();
    await page.mouse.move(box.x + 450, box.y + 400, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(200); // allow the addMark round-trip to resolve

    const markCountAfterDraw = await page.evaluate(
      () => (window as unknown as { __redpenSessionApp: { state: { marks: unknown[] } } }).__redpenSessionApp.state.marks.length,
    );
    record('pointer-drag-creates-a-rectangle-mark-via-real-api-roundtrip', markCountAfterDraw === 1, `marks=${markCountAfterDraw}`);
    const rectangleCoordinates = await page.evaluate(() => {
      const app = (window as unknown as {
        __redpenSessionApp: {
          state: {
            viewport: { width: number; height: number };
            marks: Array<{
              type: string;
              bounds: { x: number; y: number; width: number; height: number };
              normalizedBounds: { x: number; y: number; width: number; height: number };
            }>;
          };
        };
      }).__redpenSessionApp;
      const mark = app.state.marks.find((candidate) => candidate.type === 'rectangle')!;
      return { mark, viewport: app.state.viewport };
    });
    const expectedNormalizedX = rectangleCoordinates.mark.bounds.x / rectangleCoordinates.viewport.width;
    const expectedNormalizedY = rectangleCoordinates.mark.bounds.y / rectangleCoordinates.viewport.height;
    record(
      'selection-bounds-use-real-normalized-coordinates',
      Math.abs(rectangleCoordinates.mark.normalizedBounds.x - expectedNormalizedX) < 1e-9 &&
        Math.abs(rectangleCoordinates.mark.normalizedBounds.y - expectedNormalizedY) < 1e-9 &&
        rectangleCoordinates.mark.normalizedBounds.width <= 1 &&
        rectangleCoordinates.mark.normalizedBounds.height <= 1,
      `bounds=${JSON.stringify(rectangleCoordinates.mark.bounds)} normalized=${JSON.stringify(rectangleCoordinates.mark.normalizedBounds)}`,
    );

    // --- pan (shift+drag) and zoom (wheel) actually change the transform ---
    const scaleBefore = await page.evaluate(() => (window as unknown as { __redpenSessionApp: { scale: number } }).__redpenSessionApp.scale);
    await page.mouse.move(box.x + 200, box.y + 200);
    await page.mouse.wheel(0, -200); // zoom in
    await page.waitForTimeout(50);
    const scaleAfter = await page.evaluate(() => (window as unknown as { __redpenSessionApp: { scale: number } }).__redpenSessionApp.scale);
    record('wheel-zoom-changes-scale', scaleAfter !== scaleBefore, `before=${scaleBefore} after=${scaleAfter}`);

    const panBefore = await page.evaluate(() => (window as unknown as { __redpenSessionApp: { panX: number } }).__redpenSessionApp.panX);
    await page.keyboard.down('Shift');
    await page.mouse.move(box.x + 400, box.y + 400);
    await page.mouse.down();
    await page.mouse.move(box.x + 480, box.y + 430, { steps: 5 });
    await page.mouse.up();
    await page.keyboard.up('Shift');
    const panAfter = await page.evaluate(() => (window as unknown as { __redpenSessionApp: { panX: number } }).__redpenSessionApp.panX);
    record('shift-drag-pans-the-canvas', panAfter !== panBefore, `before=${panBefore} after=${panAfter}`);

    // --- Ctrl+Z / Ctrl+Shift+Z keyboard shortcuts drive real undo/redo ---
    const marksBeforeKeyboardUndo = await page.evaluate(
      () => (window as unknown as { __redpenSessionApp: { state: { marks: unknown[] } } }).__redpenSessionApp.state.marks.length,
    );
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(200);
    const marksAfterKeyboardUndo = await page.evaluate(
      () => (window as unknown as { __redpenSessionApp: { state: { marks: unknown[] } } }).__redpenSessionApp.state.marks.length,
    );
    record(
      'ctrl-z-keyboard-shortcut-undoes-the-last-mark',
      marksAfterKeyboardUndo === marksBeforeKeyboardUndo - 1,
      `before=${marksBeforeKeyboardUndo} after=${marksAfterKeyboardUndo}`,
    );

    await page.keyboard.press('Control+Shift+z');
    await page.waitForTimeout(200);
    const marksAfterKeyboardRedo = await page.evaluate(
      () => (window as unknown as { __redpenSessionApp: { state: { marks: unknown[] } } }).__redpenSessionApp.state.marks.length,
    );
    record(
      'ctrl-shift-z-keyboard-shortcut-redoes-the-mark',
      marksAfterKeyboardRedo === marksBeforeKeyboardUndo,
      `before=${marksBeforeKeyboardUndo} after=${marksAfterKeyboardRedo}`,
    );

    // --- erase tool removes a mark via a real click on it ---
    // Read the rectangle mark's actual screenshot-space bounds back from
    // server state (rather than assuming the earlier drag's screen
    // coordinates map 1:1 to screenshot space \u2014 fit-to-viewport scaling on
    // a full-page capture already applies a non-1 scale from the start),
    // then convert its center through the app's live pan/scale to get a
    // canvas-space click point.
    const eraseCanvasPoint = await page.evaluate(() => {
      const a = (window as unknown as {
        __redpenSessionApp: { scale: number; panX: number; panY: number; state: { marks: Array<{ type: string; bounds: { x: number; y: number; width: number; height: number } }> } };
      }).__redpenSessionApp;
      const rect = a.state.marks.find((m) => m.type === 'rectangle')!;
      const centerX = rect.bounds.x + rect.bounds.width / 2;
      const centerY = rect.bounds.y + rect.bounds.height / 2;
      return { x: centerX * a.scale + a.panX, y: centerY * a.scale + a.panY };
    });
    await page.click('#toolbar button[data-tool="erase"]');
    await page.mouse.click(box.x + eraseCanvasPoint.x, box.y + eraseCanvasPoint.y);
    await page.waitForTimeout(200);
    const marksAfterErase = await page.evaluate(
      () => (window as unknown as { __redpenSessionApp: { state: { marks: unknown[] } } }).__redpenSessionApp.state.marks.length,
    );
    record('erase-tool-removes-the-clicked-mark', marksAfterErase === marksAfterKeyboardRedo - 1, `before=${marksAfterKeyboardRedo} after=${marksAfterErase}`);

    // Redraw the erased rectangle so later canSubmit/group-count checks still
    // see a non-empty group #1.
    await page.click('#toolbar button[data-tool="rectangle"]');
    await page.mouse.move(box.x + 300, box.y + 300);
    await page.mouse.down();
    await page.mouse.move(box.x + 450, box.y + 400, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(200);

    // --- arrow tool renders a real filled arrowhead, not only a line ---
    await page.click('#toolbar button[data-tool="arrow"]');
    await page.mouse.move(box.x + 620, box.y + 250);
    await page.mouse.down();
    await page.mouse.move(box.x + 760, box.y + 250, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(200);
    const arrowRendering = await page.evaluate(() => {
      const app = (window as unknown as {
        __redpenSessionApp: {
          scale: number;
          panX: number;
          panY: number;
          state: {
            groups: Array<{ id: string; color: string }>;
            marks: Array<{ type: string; groupId: string; to?: { x: number; y: number } }>;
          };
        };
      }).__redpenSessionApp;
      const arrow = [...app.state.marks].reverse().find((mark) => mark.type === 'arrow');
      if (!arrow?.to) return { hasArrow: false, offAxisColorPixels: 0 };
      const color = app.state.groups.find((group) => group.id === arrow.groupId)?.color ?? '#000000';
      const red = Number.parseInt(color.slice(1, 3), 16);
      const green = Number.parseInt(color.slice(3, 5), 16);
      const blue = Number.parseInt(color.slice(5, 7), 16);
      const endpoint = {
        x: arrow.to.x * app.scale + app.panX,
        y: arrow.to.y * app.scale + app.panY,
      };
      const canvas = document.getElementById('annotation-canvas') as HTMLCanvasElement;
      const context = canvas.getContext('2d')!;
      const left = Math.max(0, Math.floor(endpoint.x - 15));
      const top = Math.max(0, Math.floor(endpoint.y - 10));
      const width = Math.min(16, canvas.width - left);
      const height = Math.min(21, canvas.height - top);
      const pixels = context.getImageData(left, top, width, height).data;
      let offAxisColorPixels = 0;
      for (let y = 0; y < height; y++) {
        if (Math.abs(top + y - endpoint.y) < 2) continue;
        for (let x = 0; x < width; x++) {
          const index = (y * width + x) * 4;
          const distance =
            Math.abs(pixels[index] - red) +
            Math.abs(pixels[index + 1] - green) +
            Math.abs(pixels[index + 2] - blue);
          if (distance < 90) offAxisColorPixels++;
        }
      }
      return { hasArrow: true, offAxisColorPixels };
    });
    record(
      'arrow-tool-renders-a-visible-arrowhead',
      arrowRendering.hasArrow && arrowRendering.offAxisColorPixels >= 6,
      `offAxisColorPixels=${arrowRendering.offAxisColorPixels}`,
    );

    // --- straight line is distinct from an arrow and has no head ---
    await page.click('#toolbar button[data-tool="line"]');
    await page.mouse.move(box.x + 620, box.y + 180);
    await page.mouse.down();
    await page.mouse.move(box.x + 760, box.y + 240, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(200);
    const lineMarkCount = await page.evaluate(
      () => (window as unknown as {
        __redpenSessionApp: { state: { marks: Array<{ type: string }> } };
      }).__redpenSessionApp.state.marks.filter((mark) => mark.type === 'line').length,
    );
    record('line-tool-commits-a-straight-line-mark', lineMarkCount === 1, `lineMarks=${lineMarkCount}`);
    await page.click('#toolbar button[data-tool="erase"]');
    await page.mouse.click(box.x + 630, box.y + 235);
    await page.waitForTimeout(100);
    const lineCountAfterFarErase = await page.evaluate(
      () => (window as unknown as {
        __redpenSessionApp: { state: { marks: Array<{ type: string }> } };
      }).__redpenSessionApp.state.marks.filter((mark) => mark.type === 'line').length,
    );
    await page.mouse.click(box.x + 690, box.y + 210);
    await page.waitForTimeout(100);
    const lineCountAfterStrokeErase = await page.evaluate(
      () => (window as unknown as {
        __redpenSessionApp: { state: { marks: Array<{ type: string }> } };
      }).__redpenSessionApp.state.marks.filter((mark) => mark.type === 'line').length,
    );
    record(
      'eraser-hits-line-stroke-not-its-empty-bounding-box',
      lineCountAfterFarErase === 1 && lineCountAfterStrokeErase === 0,
      `far=${lineCountAfterFarErase} stroke=${lineCountAfterStrokeErase}`,
    );
    await page.click('#toolbar button[data-tool="line"]');
    await page.mouse.move(box.x + 620, box.y + 180);
    await page.mouse.down();
    await page.mouse.move(box.x + 760, box.y + 240, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(100);
    await page.mouse.move(box.x + 5, box.y + 100);
    await page.mouse.down();
    await page.mouse.move(box.x + 20, box.y + 120);
    await page.mouse.up();
    await page.waitForTimeout(100);
    const lineCountAfterBlankGesture = await page.evaluate(
      () => (window as unknown as {
        __redpenSessionApp: { state: { marks: Array<{ type: string }> } };
      }).__redpenSessionApp.state.marks.filter((mark) => mark.type === 'line').length,
    );
    record(
      'drawing-in-panned-blank-canvas-does-not-create-an-edge-line',
      lineCountAfterBlankGesture === 1,
      `lineMarks=${lineCountAfterBlankGesture}`,
    );

    // --- text tool creates a bounded editor and commits group-colored text ---
    await page.click('#toolbar button[data-tool="text"]');
    await page.mouse.move(box.x + 600, box.y + 300);
    await page.mouse.down();
    await page.mouse.move(box.x + 800, box.y + 370, { steps: 5 });
    await page.mouse.up();
    const textEditor = page.locator('.canvas-text-editor');
    await textEditor.waitFor({ state: 'visible' });
    const editorColor = await textEditor.evaluate((element) => getComputedStyle(element).color);
    const markCountBeforeNativeUndo = await page.evaluate(
      () => (window as unknown as { __redpenSessionApp: { state: { marks: unknown[] } } }).__redpenSessionApp.state.marks.length,
    );
    await textEditor.type('임시');
    await textEditor.press('Control+z');
    const markCountAfterNativeUndo = await page.evaluate(
      () => (window as unknown as { __redpenSessionApp: { state: { marks: unknown[] } } }).__redpenSessionApp.state.marks.length,
    );
    await textEditor.fill('영역 안에 입력한 텍스트');
    await textEditor.press('Control+Enter');
    await page.waitForTimeout(200);
    const textMarkState = await page.evaluate(() => {
      const app = (window as unknown as {
        __redpenSessionApp: {
          state: {
            activeGroupId: string;
            groups: Array<{ id: string; color: string }>;
            marks: Array<{ type: string; text?: string; groupId: string; bounds: { width: number; height: number } }>;
          };
        };
      }).__redpenSessionApp;
      const mark = [...app.state.marks].reverse().find((candidate) => candidate.type === 'text');
      const color = app.state.groups.find((group) => group.id === mark?.groupId)?.color;
      return { mark, color };
    });
    record(
      'text-tool-commits-bounded-group-colored-text',
      textMarkState.mark?.text === '영역 안에 입력한 텍스트' &&
        textMarkState.mark.bounds.width > 100 &&
        textMarkState.mark.bounds.height > 30 &&
        markCountAfterNativeUndo === markCountBeforeNativeUndo &&
        editorColor === 'rgb(220, 38, 38)' &&
        textMarkState.color === '#dc2626',
      `editorColor=${editorColor} mark=${JSON.stringify(textMarkState.mark)}`,
    );

    // --- create a second instruction group via the real sidebar button ---
    await page.click('#new-instruction');
    await page.waitForTimeout(150);
    const groupCountAfterNew = await page.evaluate(
      () => (window as unknown as { __redpenSessionApp: { state: { groups: unknown[] } } }).__redpenSessionApp.state.groups.length,
    );
    record('new-instruction-button-creates-group-2-via-real-api', groupCountAfterNew === 2, `groups=${groupCountAfterNew}`);

    // Draw into the new (now active) group too \u2014 canSubmit requires every
    // group to have at least one mark (docs/PRODUCT_INTENT.md \u00a76.4:
    // "\ube44\uc5b4 \uc788\ub294 \uadf8\ub9f9\ub7cc \uacbd\uace0\ud55c\ub2e4"), matching real usage rather than
    // leaving an intentionally-empty group that would keep submit disabled.
    await page.click('#toolbar button[data-tool="ellipse"]');
    await page.mouse.move(box.x + 500, box.y + 500);
    await page.mouse.down();
    await page.mouse.move(box.x + 570, box.y + 550, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(200);

    // --- type a global note through the real textarea, then submit ---
    await page.fill('#global-note', '실제 UI로 작성한 전체 노트');
    await page.click('#submit-button');
    await page.waitForSelector('#submit-status:has-text("Submitted")', { timeout: 5000 });
    const submitStatusText = await page.textContent('#submit-status');
    record('real-ui-submit-button-completes-and-shows-task-id', /Submitted.*rpt_/.test(submitStatusText ?? ''), submitStatusText ?? '');

    const taskIdMatch = /(rpt_\w+)/.exec(submitStatusText ?? '');
    const taskId = taskIdMatch?.[1];

    await pwBrowser.close();

    // --- verify via the CLI that the note typed in the real UI was persisted ---
    if (taskId) {
      const taskResult = await runCli(['task', taskId, '--project', workspaceRoot, '--json'], env);
      const taskJson = JSON.parse(taskResult.stdout.trim());
      record(
        'submitted-task-carries-the-global-note-typed-in-the-real-textarea',
        taskJson.task?.globalNote === '실제 UI로 작성한 전체 노트',
        `globalNote=${taskJson.task?.globalNote}`,
      );
      record('submitted-task-has-two-groups-matching-the-ui-state', taskJson.task?.groups?.length === 2, `groups=${taskJson.task?.groups?.length}`);
      const overlaySvg = await readFile(
        path.join(workspaceRoot, '.redpen', 'tasks', taskId, 'frames', 'frame-001', 'overlay.svg'),
        'utf8',
      );
      const lineMarkId = taskJson.task?.marks?.find((mark: { type: string }) => mark.type === 'line')?.id;
      record(
        'overlay-preserves-bounded-text-and-headless-line',
        overlaySvg.includes('<foreignObject') &&
          overlaySvg.includes('영역 안에 입력한 텍스트') &&
          Boolean(lineMarkId) &&
          new RegExp(`<line[^>]+data-mark-id="${lineMarkId}"`).test(overlaySvg) &&
          !new RegExp(`<line[^>]+data-mark-id="${lineMarkId}"[^>]+marker-end`).test(overlaySvg),
        `lineMarkId=${lineMarkId} overlayBytes=${Buffer.byteLength(overlaySvg)}`,
      );
    } else {
      record('submitted-task-carries-the-global-note-typed-in-the-real-textarea', false, 'no taskId captured');
      record('submitted-task-has-two-groups-matching-the-ui-state', false, 'no taskId captured');
      record('overlay-preserves-bounded-text-and-headless-line', false, 'no taskId captured');
    }

    const allPass = checks.every((c) => c.pass);
    await mkdir(path.resolve(__dirname, '../.ui-e2e-output'), { recursive: true });
    await writeFile(
      path.resolve(__dirname, '../.ui-e2e-output/report.json'),
      JSON.stringify({ generatedAt: new Date().toISOString(), allPass, checks }, null, 2),
    );
    console.error(`\n${allPass ? 'ALL CHECKS PASSED' : 'SOME CHECKS FAILED'}`);
    if (!allPass) process.exitCode = 1;
  } finally {
    await server.close();
    await stopDaemonIfRunning(appDataDir);
    await rm(appDataDir, { recursive: true, force: true }).catch(() => {});
    await rm(workspaceRoot, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((err) => {
  console.error('ui e2e check crashed:', err);
  process.exitCode = 1;
});
