/**
 * End-to-end verification for patch marks and grouped reference attachments.
 * Crop+move remains a pixel edit, while pasted/dropped images are attached
 * to an instruction group as task-bundled references and never stamped onto
 * the screenshot canvas.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { chromium, type Browser, type Page } from 'playwright';
import { PNG } from 'pngjs';

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

function solidPngBase64(width: number, height: number, rgba: [number, number, number, number]): string {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      png.data[i] = rgba[0];
      png.data[i + 1] = rgba[1];
      png.data[i + 2] = rgba[2];
      png.data[i + 3] = rgba[3];
    }
  }
  return PNG.sync.write(png).toString('base64');
}

async function screenshotPoint(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  return page.evaluate(({ x, y }) => {
    const app = (window as unknown as { __redpenSessionApp: { scale: number; panX: number; panY: number } }).__redpenSessionApp;
    return { x: x * app.scale + app.panX, y: y * app.scale + app.panY };
  }, { x, y });
}

async function dragScreenshot(
  page: Page,
  canvasBox: { x: number; y: number },
  from: { x: number; y: number },
  to: { x: number; y: number },
  shift = false,
): Promise<void> {
  const start = await screenshotPoint(page, from.x, from.y);
  const end = await screenshotPoint(page, to.x, to.y);
  if (shift) await page.keyboard.down('Shift');
  await page.mouse.move(canvasBox.x + start.x, canvasBox.y + start.y);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + end.x, canvasBox.y + end.y, { steps: 5 });
  await page.mouse.up();
  if (shift) await page.keyboard.up('Shift');
}

async function main() {
  const server = await startStaticServer(fixturePath);
  const appDataDir = await mkdtemp(path.join(os.tmpdir(), 'redpen-patch-reference-appdata-'));
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'redpen-patch-reference-ws-'));
  let pwBrowser: Browser | null = null;
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

    pwBrowser = await chromium.launch({ headless: true });
    const page = await pwBrowser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.setExtraHTTPHeaders({ Authorization: `Bearer ${discovery.token}` });
    const annotatorUrl = `http://127.0.0.1:${discovery.port}/annotator/${sessionId}`;
    await page.goto(annotatorUrl, { waitUntil: 'load' });
    await page.waitForFunction(() => Boolean((window as unknown as { __redpenSessionApp?: unknown }).__redpenSessionApp));

    const canvas = page.locator('#annotation-canvas');
    const box = await canvas.boundingBox();
    if (!box) throw new Error('canvas has no bounding box');

    // --- Select/Move: empty marquee creates a screenshot region ---
    record(
      'patch-is-not-a-toolbar-tool',
      (await page.locator('#toolbar button[data-tool="patch"]').count()) === 0 &&
        (await page.locator('#toolbar button[data-tool="select"].active').count()) === 1,
      'select is active',
    );
    await dragScreenshot(page, box, { x: 300, y: 200 }, { x: 360, y: 260 });
    const region = await page.evaluate(() => {
      const app = (window as unknown as {
        __redpenSessionApp: { selectionBounds: { x: number; y: number; width: number; height: number } | null; state: { marks: unknown[] } };
      }).__redpenSessionApp;
      return { bounds: app.selectionBounds, markCount: app.state.marks.length };
    });
    record(
      'empty-select-marquee-creates-an-ephemeral-region',
      Boolean(region.bounds && region.bounds.width > 20 && region.bounds.height > 20 && region.markCount === 0),
      JSON.stringify(region),
    );

    // Dragging that region previews real source pixels before committing.
    const patchDragStart = await screenshotPoint(page, 330, 230);
    const patchDragEnd = await screenshotPoint(page, 630, 530);
    await page.mouse.move(box.x + patchDragStart.x, box.y + patchDragStart.y);
    await page.mouse.down();
    await page.mouse.move(box.x + patchDragEnd.x, box.y + patchDragEnd.y, { steps: 6 });
    const livePatchPreview = await page.evaluate(() => {
      const app = (window as any).__redpenSessionApp;
      const source = app.selectInitialBounds as { x: number; y: number; width: number; height: number };
      const destination = app.selectionBounds as { x: number; y: number; width: number; height: number };
      const image = document.getElementById('screenshot-source') as HTMLImageElement;
      const canvas = document.getElementById('annotation-canvas') as HTMLCanvasElement;
      const context = canvas.getContext('2d')!;
      const sourceCanvasPoint = {
        x: (source.x + source.width / 2) * app.scale + app.panX,
        y: (source.y + source.height / 2) * app.scale + app.panY,
      };
      const destinationCanvasPoint = {
        x: (destination.x + destination.width / 2) * app.scale + app.panX,
        y: (destination.y + destination.height / 2) * app.scale + app.panY,
      };
      const sourcePixel = [...context.getImageData(Math.round(sourceCanvasPoint.x), Math.round(sourceCanvasPoint.y), 1, 1).data];
      const destinationPixel = [...context.getImageData(Math.round(destinationCanvasPoint.x), Math.round(destinationCanvasPoint.y), 1, 1).data];
      const sample = document.createElement('canvas');
      sample.width = 1;
      sample.height = 1;
      const sampleContext = sample.getContext('2d')!;
      const sourceScaleX = image.naturalWidth / app.state.viewport.width;
      const sourceScaleY = image.naturalHeight / app.state.viewport.height;
      sampleContext.drawImage(
        image,
        (source.x + source.width / 2) * sourceScaleX,
        (source.y + source.height / 2) * sourceScaleY,
        1,
        1,
        0,
        0,
        1,
        1,
      );
      const expectedPixel = [...sampleContext.getImageData(0, 0, 1, 1).data];
      return { mode: app.selectMode, sourcePixel, destinationPixel, expectedPixel };
    });
    const previewDistance = livePatchPreview.destinationPixel.reduce(
      (sum, value, index) => sum + Math.abs(value - livePatchPreview.expectedPixel[index]),
      0,
    );
    const sourceOverlayDistance = livePatchPreview.sourcePixel.reduce(
      (sum, value, index) => sum + Math.abs(value - livePatchPreview.expectedPixel[index]),
      0,
    );
    record(
      'patch-placement-previews-cropped-pixels-before-pointer-up',
      livePatchPreview.mode === 'patch' &&
        sourceOverlayDistance > 20 &&
        previewDistance < 100,
      JSON.stringify({ ...livePatchPreview, previewDistance, sourceOverlayDistance }),
    );
    await page.mouse.up();
    await page.waitForFunction(
      () => (window as unknown as { __redpenSessionApp: { state: { marks: Array<{ type: string }> } } }).__redpenSessionApp.state.marks.some((mark) => mark.type === 'patch'),
    );

    const marksAfterPatch = await page.evaluate(
      () => (window as unknown as { __redpenSessionApp: { state: { marks: Array<{ type: string }> } } }).__redpenSessionApp.state.marks,
    );
    const patchMark = marksAfterPatch.find((m) => m.type === 'patch');
    record('patch-drag-commits-a-patch-mark', Boolean(patchMark), `marks=${JSON.stringify(marksAfterPatch.map((m) => m.type))}`);
    const patchBeforeTransform = await page.evaluate(() => {
      const app = (window as any).__redpenSessionApp as {
        selectedMarkIds: Set<string>;
        state: { marks: Array<{ id: string; type: string; groupId: string; sourceRect?: { x: number; y: number; width: number; height: number }; bounds: { x: number; y: number; width: number; height: number } }> };
      };
      const patch = app.state.marks.find((mark) => mark.type === 'patch')!;
      return { id: patch.id, groupId: patch.groupId, sourceRect: patch.sourceRect, bounds: patch.bounds, selected: [...app.selectedMarkIds] };
    });
    record(
      'new-patch-is-selected-with-stable-id-and-source-rect',
      patchBeforeTransform.selected.length === 1 && patchBeforeTransform.selected[0] === patchBeforeTransform.id && Boolean(patchBeforeTransform.sourceRect),
      JSON.stringify(patchBeforeTransform),
    );
    await dragScreenshot(
      page,
      box,
      { x: patchBeforeTransform.bounds.x + patchBeforeTransform.bounds.width / 2, y: patchBeforeTransform.bounds.y + patchBeforeTransform.bounds.height / 2 },
      { x: patchBeforeTransform.bounds.x + patchBeforeTransform.bounds.width / 2 + 70, y: patchBeforeTransform.bounds.y + patchBeforeTransform.bounds.height / 2 + 25 },
    );
    await page.waitForFunction(({ id, previousX }) => {
      const app = (window as unknown as { __redpenSessionApp: { state: { marks: Array<{ id: string; bounds: { x: number } }> } } }).__redpenSessionApp;
      return (app.state.marks.find((mark) => mark.id === id)?.bounds.x ?? previousX) > previousX;
    }, { id: patchBeforeTransform.id, previousX: patchBeforeTransform.bounds.x });
    const patchAfterMove = await page.evaluate((id) => {
      const app = (window as any).__redpenSessionApp as {
        state: { marks: Array<{ id: string; groupId: string; sourceRect?: unknown; bounds: { x: number; y: number; width: number; height: number } }> };
      };
      return app.state.marks.find((mark) => mark.id === id)!;
    }, patchBeforeTransform.id);
    await dragScreenshot(
      page,
      box,
      { x: patchAfterMove.bounds.x + patchAfterMove.bounds.width, y: patchAfterMove.bounds.y + patchAfterMove.bounds.height },
      { x: patchAfterMove.bounds.x + patchAfterMove.bounds.width + 50, y: patchAfterMove.bounds.y + patchAfterMove.bounds.height + 10 },
      true,
    );
    await page.waitForFunction(({ id, previousWidth }) => {
      const app = (window as unknown as { __redpenSessionApp: { state: { marks: Array<{ id: string; bounds: { width: number } }> } } }).__redpenSessionApp;
      return (app.state.marks.find((mark) => mark.id === id)?.bounds.width ?? previousWidth) > previousWidth;
    }, { id: patchBeforeTransform.id, previousWidth: patchAfterMove.bounds.width });
    const patchAfterResize = await page.evaluate((id) => {
      const app = (window as any).__redpenSessionApp as {
        state: { marks: Array<{ id: string; groupId: string; sourceRect?: unknown; bounds: { width: number; height: number } }> };
      };
      return app.state.marks.find((mark) => mark.id === id)!;
    }, patchBeforeTransform.id);
    record(
      'patch-move-and-shift-resize-preserve-id-group-source-rect-and-aspect',
      patchAfterResize.groupId === patchBeforeTransform.groupId &&
        JSON.stringify(patchAfterResize.sourceRect) === JSON.stringify(patchBeforeTransform.sourceRect) &&
        Math.abs(patchAfterResize.bounds.width / patchAfterResize.bounds.height - patchAfterMove.bounds.width / patchAfterMove.bounds.height) < 0.001,
      JSON.stringify({ before: patchBeforeTransform, after: patchAfterResize }),
    );

    // --- grouped references: paste one image, then drop two together ---
    const referencePngBase64 = solidPngBase64(20, 20, [0, 255, 0, 255]);
    await page.evaluate((pngBase64) => {
      const binary = atob(pngBase64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], 'pasted.png', { type: 'image/png' }));
      document.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, clipboardData: transfer }));
    }, referencePngBase64);
    await page.waitForFunction(
      () => (window as unknown as { __redpenSessionApp: { state: { groups: Array<{ referenceIds: string[] }> } } }).__redpenSessionApp.state.groups[0].referenceIds.length === 1,
    );
    record('clipboard-paste-attaches-reference-to-active-group', true, 'referenceIds=1');

    await page.evaluate((pngBase64) => {
      const binary = atob(pngBase64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], 'dropped-1.png', { type: 'image/png' }));
      transfer.items.add(new File([bytes], 'dropped-2.png', { type: 'image/png' }));
      document.querySelector('.group-card')!.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer }));
    }, referencePngBase64);
    await page.waitForFunction(
      () => (window as unknown as { __redpenSessionApp: { state: { groups: Array<{ referenceIds: string[] }> } } }).__redpenSessionApp.state.groups[0].referenceIds.length === 3,
    );
    const referenceUiState = await page.evaluate(() => {
      const app = (window as unknown as {
        __redpenSessionApp: { state: { groups: Array<{ referenceIds: string[] }>; marks: Array<{ type: string }> } };
      }).__redpenSessionApp;
      return {
        referenceIds: app.state.groups[0].referenceIds,
        thumbnails: document.querySelectorAll('.group-card .reference-thumb').length,
        hasImageTool: document.querySelector('[data-tool="image"]') !== null,
        hasImageMark: app.state.marks.some((mark) => mark.type === 'image'),
      };
    });
    record(
      'multi-file-drop-fills-group-reference-zone-to-three',
      referenceUiState.referenceIds.length === 3 && referenceUiState.thumbnails === 3,
      JSON.stringify(referenceUiState),
    );
    record(
      'references-never-create-canvas-image-tools-or-marks',
      !referenceUiState.hasImageTool && !referenceUiState.hasImageMark,
      JSON.stringify(referenceUiState),
    );
    await page.locator('.group-card .reference-thumb button').first().click();
    await page.waitForFunction(
      () => (window as unknown as { __redpenSessionApp: { state: { groups: Array<{ referenceIds: string[] }> } } }).__redpenSessionApp.state.groups[0].referenceIds.length === 2,
    );
    await page.evaluate((pngBase64) => {
      const binary = atob(pngBase64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], 'replacement.png', { type: 'image/png' }));
      document.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, clipboardData: transfer }));
    }, referencePngBase64);
    await page.waitForFunction(
      () => (window as unknown as { __redpenSessionApp: { state: { groups: Array<{ referenceIds: string[] }> } } }).__redpenSessionApp.state.groups[0].referenceIds.length === 3,
    );
    record('reference-thumbnail-can-be-removed-and-replaced', true, 'referenceIds=3');
    const fullGroupUploadStatus = await page.evaluate(async (pngBase64) => {
      const app = (window as unknown as {
        __redpenSessionApp: { state: { groups: Array<{ id: string }> } };
      }).__redpenSessionApp;
      return fetch(`/api/sessions/${location.pathname.split('/').pop()}/annotator/groups/${app.state.groups[0].id}/references`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pngBase64 }),
      }).then((response) => response.status);
    }, referencePngBase64);
    record(
      'backend-rejects-a-fourth-reference-with-conflict',
      fullGroupUploadStatus === 409,
      `status=${fullGroupUploadStatus}`,
    );

    // --- ensure group #1 is non-empty for canSubmit, then submit ---
    await page.click('#toolbar button[data-tool="rectangle"]');
    await page.mouse.move(box.x + 900, box.y + 700);
    await page.mouse.down();
    await page.mouse.move(box.x + 950, box.y + 750, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(200);

    await page.click('#submit-button');
    await page.waitForSelector('#submit-status:has-text("Submitted")', { timeout: 5000 });
    const submitStatusText = await page.textContent('#submit-status');
    const taskIdMatch = /(rpt_\w+)/.exec(submitStatusText ?? '');
    const taskId = taskIdMatch?.[1];
    record('submit-succeeds-with-patch-and-group-references', Boolean(taskId), submitStatusText ?? '');

    await pwBrowser.close();
    pwBrowser = null;

    if (taskId) {
      const taskResult = await runCli(['task', taskId, '--project', workspaceRoot, '--json'], env);
      const taskJson = JSON.parse(taskResult.stdout.trim());
      const marks: Array<{
        type: string;
        sourceRect?: { x: number; y: number; width: number; height: number };
      }> = taskJson.task?.marks ?? [];
      record('submitted-task-bundle-contains-a-patch-mark', marks.some((m) => m.type === 'patch'), `types=${JSON.stringify(marks.map((m) => m.type))}`);
      const taskReferences: Array<{ id: string; path: string }> = taskJson.task?.references ?? [];
      const groupReferenceIds: string[] = taskJson.task?.groups?.[0]?.referenceIds ?? [];
      record(
        'submitted-task-carries-three-grouped-reference-assets',
        taskReferences.length === 3 &&
          groupReferenceIds.length === 3 &&
          groupReferenceIds.every((id) => taskReferences.some((reference) => reference.id === id)),
        `references=${JSON.stringify(taskReferences)} groupReferenceIds=${JSON.stringify(groupReferenceIds)}`,
      );

      // --- the annotated.png actually differs from source.png (real pixel edit) ---
      const taskDir = path.join(workspaceRoot, '.redpen', 'tasks', taskId);
      const sourcePng = await readFile(path.join(taskDir, 'frames', 'frame-001', 'source.png'));
      const annotatedPng = await readFile(path.join(taskDir, 'frames', 'frame-001', 'annotated.png'));
      const overlaySvg = await readFile(path.join(taskDir, 'frames', 'frame-001', 'overlay.svg'), 'utf8');
      const bundledReferenceFilesExist = await Promise.all(
        taskReferences.map(async (reference) => {
          try {
            return (await stat(path.join(taskDir, reference.path))).isFile();
          } catch {
            return false;
          }
        }),
      );
      record(
        'reference-png-files-are-copied-into-the-task-bundle',
        bundledReferenceFilesExist.length === 3 && bundledReferenceFilesExist.every(Boolean),
        JSON.stringify(bundledReferenceFilesExist),
      );
      const stagingReferenceDir = path.join(workspaceRoot, '.redpen', 'references');
      const stagingIndex = JSON.parse(await readFile(path.join(stagingReferenceDir, 'index.json'), 'utf8')) as unknown[];
      const stagingPngs = (await readdir(stagingReferenceDir)).filter((fileName) => fileName.endsWith('.png'));
      record(
        'submit-cleans-attached-and-detached-staging-reference-files',
        stagingIndex.length === 0 && stagingPngs.length === 0,
        `index=${stagingIndex.length} pngs=${stagingPngs.length}`,
      );
      record(
        'overlay-svg-contains-the-submitted-vector-and-patch-marks',
        overlaySvg.includes('<svg') && overlaySvg.includes('data-mark-id=') && overlaySvg.includes('stroke-dasharray="4 2"'),
        `overlayBytes=${Buffer.byteLength(overlaySvg)}`,
      );
      const differs = !sourcePng.equals(annotatedPng);
      record('annotated-png-diff-comes-from-patch-not-reference-attachments', differs, `sourceBytes=${sourcePng.length} annotatedBytes=${annotatedPng.length}`);
      const patch = marks.find((mark) => mark.type === 'patch');
      const viewport = taskJson.task?.frames?.[0]?.viewport as { width: number; height: number } | undefined;
      if (patch?.sourceRect && viewport) {
        const annotated = PNG.sync.read(annotatedPng);
        const scaleX = annotated.width / viewport.width;
        const scaleY = annotated.height / viewport.height;
        const left = Math.floor(patch.sourceRect.x * scaleX);
        const top = Math.floor(patch.sourceRect.y * scaleY);
        const right = Math.ceil((patch.sourceRect.x + patch.sourceRect.width) * scaleX);
        const bottom = Math.ceil((patch.sourceRect.y + patch.sourceRect.height) * scaleY);
        let whitePixels = 0;
        let totalPixels = 0;
        for (let y = top; y < bottom; y++) {
          for (let x = left; x < right; x++) {
            const index = (y * annotated.width + x) * 4;
            totalPixels++;
            if (
              annotated.data[index] === 255 &&
              annotated.data[index + 1] === 255 &&
              annotated.data[index + 2] === 255 &&
              annotated.data[index + 3] === 255
            ) {
              whitePixels++;
            }
          }
        }
        record(
          'patch-clears-the-cut-source-region-to-whitespace',
          totalPixels > 0 && whitePixels === totalPixels,
          `whitePixels=${whitePixels}/${totalPixels}`,
        );
      } else {
        record('patch-clears-the-cut-source-region-to-whitespace', false, 'missing patch sourceRect or viewport');
      }
    } else {
      record('submitted-task-bundle-contains-a-patch-mark', false, 'no taskId captured');
      record('submitted-task-carries-three-grouped-reference-assets', false, 'no taskId captured');
      record('reference-png-files-are-copied-into-the-task-bundle', false, 'no taskId captured');
      record('submit-cleans-attached-and-detached-staging-reference-files', false, 'no taskId captured');
      record('overlay-svg-contains-the-submitted-vector-and-patch-marks', false, 'no taskId captured');
      record('annotated-png-diff-comes-from-patch-not-reference-attachments', false, 'no taskId captured');
      record('patch-clears-the-cut-source-region-to-whitespace', false, 'no taskId captured');
    }

    const allPass = checks.every((c) => c.pass);
    console.error(`\n${allPass ? 'ALL CHECKS PASSED' : 'SOME CHECKS FAILED'}`);
    if (!allPass) process.exitCode = 1;
  } finally {
    await pwBrowser?.close().catch(() => {});
    await server.close();
    await stopDaemonIfRunning(appDataDir);
    await rm(appDataDir, { recursive: true, force: true }).catch(() => {});
    await rm(workspaceRoot, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((err) => {
  console.error('patch/reference e2e check crashed:', err);
  process.exitCode = 1;
});
