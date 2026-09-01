/**
 * Phase 6 review-loop verification (docs/IMPLEMENTATION_PLAN.md Phase 6
 * 완료 조건): a task goes through implementation -> review -> revision ->
 * done, and the earlier images/instructions are preserved unchanged.
 *
 * Drives the real `redpen` CLI as child processes, same pattern as
 * lifecycle-check.ts.
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const cliEntry = path.resolve(__dirname, 'cli.ts');
const fixturePath = path.resolve(__dirname, '../../../fixtures/frontend/index.html');

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
  const discoveryPath = path.join(appDataDir, 'redpen', 'daemon.json');
  try {
    const raw = await readFile(discoveryPath, 'utf8');
    const discovery = JSON.parse(raw) as { pid: number };
    process.kill(discovery.pid, 'SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 1500));
  } catch {
    // nothing to stop
  }
}

async function main() {
  const server = await startStaticServer(fixturePath);
  const appDataDir = await mkdtemp(path.join(os.tmpdir(), 'redpen-review-appdata-'));
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'redpen-review-ws-'));
  const env = jsonAppDataEnv(appDataDir);

  try {
    // --- open, freeze, submit (revision 0 / implementation) ---
    const openResult = await runCli(['open', server.url, '--project', workspaceRoot, '--json'], env);
    const sessionId = JSON.parse(openResult.stdout.trim()).session.id as string;

    const freeze0 = await runCli(['freeze', sessionId, '--json'], env);
    if (freeze0.code !== 0) {
      record('v0-freeze-succeeds', false, `code=${freeze0.code} stderr=${freeze0.stderr.slice(0, 500)}`);
      throw new Error(`v0 freeze failed: ${freeze0.stderr}`);
    }
    const submit0 = await runCli(['submit', sessionId, '--note', 'v0 note', '--json'], env);
    if (submit0.code !== 0 || !submit0.stdout.trim()) {
      record('v0-submit-succeeds', false, `code=${submit0.code} stdout=${submit0.stdout.trim()} stderr=${submit0.stderr.slice(0, 500)}`);
      throw new Error(`v0 submit failed: code=${submit0.code} stderr=${submit0.stderr}`);
    }
    const submit0Json = JSON.parse(submit0.stdout.trim());
    const taskV0Id = submit0Json.taskId as string;
    record('v0-submit-succeeds', typeof taskV0Id === 'string' && taskV0Id.length > 0, `taskId=${taskV0Id}`);

    const taskV0Before = await runCli(['task', taskV0Id, '--project', workspaceRoot, '--json'], env);
    const taskV0BeforeJson = JSON.parse(taskV0Before.stdout.trim()).task;

    // --- claim -> working (implementation phase) ---
    await runCli(['claim', sessionId, '--json'], env);

    // --- review-ready: working -> review ---
    const reviewResult = await runCli(['review', sessionId, '--json'], env);
    const reviewJson = JSON.parse(reviewResult.stdout.trim());
    record('review-transitions-from-working', reviewJson.session.state === 'review', `state=${reviewJson.session.state}`);

    // --- annotate a revision: freeze again from `review` state ---
    const freezeRevisionResult = await runCli(['freeze', sessionId, '--json'], env);
    const freezeRevisionJson = JSON.parse(freezeRevisionResult.stdout.trim());
    record(
      'freeze-from-review-transitions-to-annotating',
      freezeRevisionJson.session.state === 'annotating',
      `state=${freezeRevisionJson.session.state}`,
    );

    const submit1 = await runCli(['submit', sessionId, '--note', 'v1 revision note', '--json'], env);
    const submit1Json = JSON.parse(submit1.stdout.trim());
    const taskV1Id = submit1Json.taskId as string;
    record('v1-revision-submit-succeeds', typeof taskV1Id === 'string' && taskV1Id !== taskV0Id, `taskId=${taskV1Id}`);

    const taskV1Result = await runCli(['task', taskV1Id, '--project', workspaceRoot, '--json'], env);
    const taskV1Json = JSON.parse(taskV1Result.stdout.trim()).task;
    record('v1-task-has-revision-number-1', taskV1Json.revision === 1, `revision=${taskV1Json.revision}`);
    record('v1-task-links-parentTaskId-to-v0', taskV1Json.parentTaskId === taskV0Id, `parentTaskId=${taskV1Json.parentTaskId}`);
    record('v1-task-carries-its-own-note', taskV1Json.globalNote === 'v1 revision note', `note=${taskV1Json.globalNote}`);

    // --- claim -> working -> review -> accept (done) for the revision ---
    await runCli(['claim', sessionId, '--json'], env);
    await runCli(['review', sessionId, '--json'], env);
    const acceptResult = await runCli(['accept', sessionId, '--json'], env);
    const acceptJson = JSON.parse(acceptResult.stdout.trim());
    record('accept-transitions-session-to-done', acceptJson.session.state === 'done', `state=${acceptJson.session.state}`);

    // --- immutability: the v0 bundle is byte-identical to before the revision was submitted ---
    const taskV0After = await runCli(['task', taskV0Id, '--project', workspaceRoot, '--json'], env);
    const taskV0AfterJson = JSON.parse(taskV0After.stdout.trim()).task;
    record(
      'v0-task-bundle-unchanged-after-revision-and-accept',
      JSON.stringify(taskV0AfterJson) === JSON.stringify(taskV0BeforeJson),
      'byte-for-byte JSON comparison of task.json before vs after',
    );
    record('v0-task-note-preserved', taskV0AfterJson.globalNote === 'v0 note', `note=${taskV0AfterJson.globalNote}`);
    record('v0-task-still-has-revision-0', taskV0AfterJson.revision === 0, `revision=${taskV0AfterJson.revision}`);

    const allPass = checks.every((c) => c.pass);
    await mkdir(path.resolve(__dirname, '../.review-loop-output'), { recursive: true });
    await writeFile(
      path.resolve(__dirname, '../.review-loop-output/report.json'),
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
  console.error('review loop check crashed:', err);
  process.exitCode = 1;
});
