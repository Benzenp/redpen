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
import { chromium } from 'playwright';
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

async function main() {
  const server = await startStaticServer(fixturePath);
  const appDataDir = await mkdtemp(path.join(os.tmpdir(), 'redpen-patch-reference-e2e-appdata-'));
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'redpen-patch-reference-e2e-ws-'));
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

    const pwBrowser = await chromium.launch({ headless: true });
    const page = await pwBrowser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.setExtraHTTPHeaders({ Authorization: `Bearer ${discovery.token}` });
    const annotatorUrl = `http://127.0.0.1:${discovery.port}/annotator/${sessionId}`;
    await page.goto(annotatorUrl, { waitUntil: 'load' });
    await page.waitForFunction(() => Boolean((window as unknown as { __redpenSessionApp?: unknown }).__redpenSessionApp));

    const canvas = page.locator('#annotation-canvas');
    const box = await canvas.boundingBox();
    if (!box) throw new Error('canvas has no bounding box');

    // --- patch tool: two-step crop+move drag ---
    await page.click('#toolbar button[data-tool="patch"]');
    // Step 1: select a source region.
    await page.mouse.move(box.x + 100, box.y + 100);
    await page.mouse.down();
    await page.mouse.move(box.x + 160, box.y + 160, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(100);
    const awaitingDestination = await page.evaluate(
      () => (window as unknown as { __redpenSessionApp: { isAwaitingPatchDestination(): boolean } }).__redpenSessionApp.isAwaitingPatchDestination(),
    );
    record('patch-tool-enters-awaiting-destination-after-source-drag', awaitingDestination, `awaiting=${awaitingDestination}`);

    // Step 2: drag to the destination — this should commit a `patch` mark.
    await page.mouse.move(box.x + 400, box.y + 400);
    await page.mouse.down();
    await page.mouse.move(box.x + 460, box.y + 460, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(200);

    const marksAfterPatch = await page.evaluate(
      () => (window as unknown as { __redpenSessionApp: { state: { marks: Array<{ type: string }> } } }).__redpenSessionApp.state.marks,
    );
    const patchMark = marksAfterPatch.find((m) => m.type === 'patch');
    record('patch-drag-commits-a-patch-mark', Boolean(patchMark), `marks=${JSON.stringify(marksAfterPatch.map((m) => m.type))}`);

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
