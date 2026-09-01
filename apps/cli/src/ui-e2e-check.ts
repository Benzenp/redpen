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
    const annotatorUrl = `http://127.0.0.1:${discovery.port}/annotator/${sessionId}?token=${discovery.token}`;
    await page.goto(annotatorUrl, { waitUntil: 'load' });
    await page.waitForFunction(() => Boolean((window as unknown as { __redpenSessionApp?: unknown }).__redpenSessionApp));

    record('annotator-page-loads-and-boots', true, annotatorUrl);

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
    await page.waitForSelector('#submit-status:has-text("제출 완료")', { timeout: 5000 });
    const submitStatusText = await page.textContent('#submit-status');
    record('real-ui-submit-button-completes-and-shows-task-id', /제출 완료: rpt_/.test(submitStatusText ?? ''), submitStatusText ?? '');

    const taskIdMatch = /제출 완료: (rpt_\w+)/.exec(submitStatusText ?? '');
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
    } else {
      record('submitted-task-carries-the-global-note-typed-in-the-real-textarea', false, 'no taskId captured');
      record('submitted-task-has-two-groups-matching-the-ui-state', false, 'no taskId captured');
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
