/**
 * Phase 4 CLI lifecycle + contract verification
 * (docs/IMPLEMENTATION_PLAN.md Phase 4 "완료 조건" and "CLI contract test").
 *
 * Drives the CLI as a real child process (never imports the application
 * service directly) against an isolated daemon + workspace, so what is
 * verified is the actual `redpen` command surface a user or agent would run.
 *
 * Completion-condition script (run without manual file edits):
 *   open -> status -> user submit -> wait returns task -> claim (working)
 *   -> review -> accept (done)
 *
 * Plus CLI contract checks:
 *   - JSON stdout is never polluted by log lines
 *   - `open` auto-starts the daemon when none is running
 *   - `wait` timeout keeps the session alive
 *   - two workspaces' sessions/tasks never mix
 *   - a closed task can still be found again by task id
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
import { EXIT_CODES } from './exit-codes.js';

const EXIT_CODES_INVALID_STATE = EXIT_CODES.INVALID_STATE;
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
  // Redirect the OS-specific global app-data root (daemon discovery, browser
  // profile, sessions) into an isolated temp dir per test run, via the same
  // env vars @redpen/protocol/paths already reads (APPDATA / XDG_DATA_HOME),
  // so concurrent test runs and the developer's real daemon never collide.
  // REDPEN_HEADLESS=1 is required explicitly \u2014 the daemon defaults to a
  // VISIBLE browser (see browser/manager.ts), which this check must override
  // since it runs unattended.
  const base = { REDPEN_HEADLESS: '1' };
  if (process.platform === 'win32') return { ...base, APPDATA: appDataDir };
  if (process.platform === 'darwin') return { ...base, HOME: appDataDir };
  return { ...base, XDG_DATA_HOME: appDataDir };
}

async function main() {
  const server = await startStaticServer(fixturePath);
  const appDataDir = await mkdtemp(path.join(os.tmpdir(), 'redpen-appdata-'));
  const workspaceA = await mkdtemp(path.join(os.tmpdir(), 'redpen-ws-a-'));
  const workspaceB = await mkdtemp(path.join(os.tmpdir(), 'redpen-ws-b-'));
  const env = jsonAppDataEnv(appDataDir);

  try {
    // --- open (auto-starts daemon since none is running yet) ---
    const openResult = await runCli(['open', server.url, '--project', workspaceA, '--json'], env);
    record('open-succeeds-and-auto-starts-daemon', openResult.code === 0, `code=${openResult.code} stderr=${openResult.stderr.slice(0, 200)}`);

    let openJson: { session: { id: string; state: string } };
    try {
      openJson = JSON.parse(openResult.stdout.trim());
      record('open-json-stdout-is-single-clean-document', true, 'parsed cleanly');
    } catch (err) {
      record('open-json-stdout-is-single-clean-document', false, `parse failed: ${(err as Error).message}; stdout=${openResult.stdout}`);
      throw err;
    }
    const sessionId = openJson.session.id;
    record('open-session-state-is-browsing', openJson.session.state === 'browsing', `state=${openJson.session.state}`);

    // --- status ---
    const statusResult = await runCli(['status', sessionId, '--json'], env);
    const statusJson = JSON.parse(statusResult.stdout.trim());
    record('status-returns-same-session-id', statusJson.session.id === sessionId, `id=${statusJson.session.id}`);

    // --- freeze (stand-in for "화면 표시하기") ---
    const freezeResult = await runCli(['freeze', sessionId, '--json'], env);
    if (!freezeResult.stdout.trim()) {
      record('freeze-transitions-to-annotating', false, `empty stdout; stderr=${freezeResult.stderr.slice(0, 500)}`);
      throw new Error(`freeze produced no stdout, stderr=${freezeResult.stderr}`);
    }
    const freezeJson = JSON.parse(freezeResult.stdout.trim());
    if (!freezeJson.session) {
      record('freeze-transitions-to-annotating', false, `no session key; raw=${freezeResult.stdout.trim()}`);
      throw new Error(`freeze returned no session: ${freezeResult.stdout}`);
    }
    record('freeze-transitions-to-annotating', freezeJson.session.state === 'annotating', `state=${freezeJson.session.state}`);

    // --- user submit (stand-in: CLI submit call represents the UI's "N개 지시 제출") ---
    const submitResult = await runCli(['submit', sessionId, '--note', 'fix the button', '--json'], env);
    const submitJson = JSON.parse(submitResult.stdout.trim());
    record('submit-returns-a-task-id', typeof submitJson.taskId === 'string' && submitJson.taskId.length > 0, `taskId=${submitJson.taskId}`);
    const taskId = submitJson.taskId as string;

    // --- wait returns task (already submitted, so this resolves immediately) ---
    const waitResult = await runCli(['wait', sessionId, '--timeout', '5', '--json'], env);
    const waitJson = JSON.parse(waitResult.stdout.trim());
    record('wait-returns-the-submitted-task-id', waitJson.taskId === taskId, `taskId=${waitJson.taskId}`);

    // --- claim (submitted -> working) ---
    const claimResult = await runCli(['claim', sessionId, '--json'], env);
    const claimJson = JSON.parse(claimResult.stdout.trim());
    record('claim-transitions-to-working', claimJson.session.state === 'working', `state=${claimJson.session.state}`);

    // --- review (working -> review) ---
    const reviewResult = await runCli(['review', sessionId, '--json'], env);
    const reviewJson = JSON.parse(reviewResult.stdout.trim());
    record('review-transitions-to-review-state', reviewJson.session.state === 'review', `state=${reviewJson.session.state}`);

    // --- accept (review -> done) ---
    const acceptResult = await runCli(['accept', sessionId, '--json'], env);
    const acceptJson = JSON.parse(acceptResult.stdout.trim());
    record('accept-transitions-to-done', acceptJson.session.state === 'done', `state=${acceptJson.session.state}`);

    // --- CLI contract: wait timeout keeps the session alive (open a second session, don't submit) ---
    const secondOpen = await runCli(['open', server.url, '--project', workspaceA, '--json'], env);
    const secondSessionId = JSON.parse(secondOpen.stdout.trim()).session.id as string;
    const timeoutWait = await runCli(['wait', secondSessionId, '--timeout', '1', '--json'], env);
    const timeoutWaitJson = JSON.parse(timeoutWait.stdout.trim());
    record('wait-timeout-returns-null-taskid-without-error', timeoutWaitJson.taskId === null, `taskId=${JSON.stringify(timeoutWaitJson.taskId)}`);

    const statusAfterTimeout = await runCli(['status', secondSessionId, '--json'], env);
    record(
      'wait-timeout-does-not-delete-the-session',
      statusAfterTimeout.code === 0 && JSON.parse(statusAfterTimeout.stdout.trim()).session.id === secondSessionId,
      `code=${statusAfterTimeout.code}`,
    );

    // --- CLI contract: two workspaces' sessions do not mix ---
    const openInWorkspaceB = await runCli(['open', server.url, '--project', workspaceB, '--json'], env);
    const workspaceBSessionId = JSON.parse(openInWorkspaceB.stdout.trim()).session.id as string;
    const listA = await runCli(['list', '--project', workspaceA, '--json'], env);
    const listAJson = JSON.parse(listA.stdout.trim());
    const listAIds = (listAJson.sessions as { id: string }[]).map((s) => s.id);
    record(
      'workspace-a-session-list-excludes-workspace-b-session',
      !listAIds.includes(workspaceBSessionId) && listAIds.includes(sessionId),
      `workspaceA sessions=${JSON.stringify(listAIds)}`,
    );

    // --- cancel: a browsing session can be cancelled, and a cancelled session rejects further transitions ---
    const cancelOpen = await runCli(['open', server.url, '--project', workspaceA, '--json'], env);
    const cancelSessionId = JSON.parse(cancelOpen.stdout.trim()).session.id as string;
    const cancelResult = await runCli(['cancel', cancelSessionId, '--json'], env);
    const cancelJson = JSON.parse(cancelResult.stdout.trim());
    record('cancel-transitions-to-cancelled', cancelJson.session?.state === 'cancelled', `state=${cancelJson.session?.state}`);

    const freezeAfterCancel = await runCli(['freeze', cancelSessionId, '--json'], env);
    record(
      'cancelled-session-rejects-further-transitions',
      freezeAfterCancel.code === EXIT_CODES_INVALID_STATE,
      `code=${freezeAfterCancel.code} stdout=${freezeAfterCancel.stdout.trim()}`,
    );

    // --- CLI contract: a closed task can still be found again by task id ---
    const closeResult = await runCli(['close', sessionId, '--json'], env);
    record('close-succeeds', closeResult.code === 0, `code=${closeResult.code}`);
    const taskAfterClose = await runCli(['task', taskId, '--project', workspaceA, '--json'], env);
    const taskAfterCloseJson = JSON.parse(taskAfterClose.stdout.trim());
    record(
      'closed-session-task-is-still-retrievable-by-task-id',
      taskAfterCloseJson.task?.id === taskId,
      `task.id=${taskAfterCloseJson.task?.id}`,
    );

    // --- CLI contract: no stray log lines mixed into JSON stdout across every call above ---
    const allStdouts = [
      openResult.stdout,
      statusResult.stdout,
      freezeResult.stdout,
      submitResult.stdout,
      waitResult.stdout,
      claimResult.stdout,
      reviewResult.stdout,
      acceptResult.stdout,
    ];
    const allSingleLineJson = allStdouts.every((s) => s.trim().split('\n').length === 1);
    record('every-json-call-stdout-is-exactly-one-line', allSingleLineJson, 'checked 8 calls');

    const allPass = checks.every((c) => c.pass);
    await mkdir(path.resolve(__dirname, '../.lifecycle-output'), { recursive: true });
    await writeFile(
      path.resolve(__dirname, '../.lifecycle-output/report.json'),
      JSON.stringify({ generatedAt: new Date().toISOString(), allPass, checks }, null, 2),
    );
    console.error(`\n${allPass ? 'ALL CHECKS PASSED' : 'SOME CHECKS FAILED'}`);
    if (!allPass) process.exitCode = 1;
  } finally {
    await server.close();
    await stopDaemonIfRunning(appDataDir);
    await rm(appDataDir, { recursive: true, force: true }).catch(() => {});
    await rm(workspaceA, { recursive: true, force: true }).catch(() => {});
    await rm(workspaceB, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * The daemon spawned during this run is detached and would otherwise keep
 * running (holding its Chromium browser-profile lock) after the check
 * finishes. Read its discovery file directly from the isolated appDataDir
 * and terminate it so cleanup of temp directories doesn't race a live lock.
 */
async function stopDaemonIfRunning(appDataDir: string): Promise<void> {
  const discoveryPath =
    process.platform === 'win32'
      ? path.join(appDataDir, 'redpen', 'daemon.json')
      : process.platform === 'darwin'
        ? path.join(appDataDir, 'Library', 'Application Support', 'redpen', 'daemon.json')
        : path.join(appDataDir, 'redpen', 'daemon.json');
  try {
    const raw = await readFile(discoveryPath, 'utf8');
    const discovery = JSON.parse(raw) as { pid: number };
    process.kill(discovery.pid, 'SIGTERM');
    // Give the daemon a moment to close its browser context before we delete
    // the profile directory out from under it.
    await new Promise((resolve) => setTimeout(resolve, 1500));
  } catch {
    // No discovery file or already dead; nothing to stop.
  }
}

main().catch((err) => {
  console.error('lifecycle check crashed:', err);
  process.exitCode = 1;
});
