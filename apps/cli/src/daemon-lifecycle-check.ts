/**
 * `redpen daemon start|stop|status` and half-dead (alive-but-unresponsive)
 * daemon recovery verification. Closes the two Phase 4 gaps recorded in
 * docs/IMPLEMENTATION_PLAN.md as "미해결 항목":
 *   - "daemon stop/status 하위명령"
 *   - "살아있지만 응답 없음 같은 반쪽 죽음 상태 복구"
 *
 * Drives the real `redpen` CLI as child processes, same pattern as
 * lifecycle-check.ts, against an isolated app-data dir.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import { createServer, type Server } from 'node:http';
import { isProcessAlive } from './daemon/discovery.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const cliEntry = path.resolve(__dirname, 'cli.ts');

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

function jsonAppDataEnv(appDataDir: string): NodeJS.ProcessEnv {
  // REDPEN_HEADLESS=1 required explicitly \u2014 the daemon defaults to a
  // visible browser (see browser/manager.ts); this unattended check must
  // override that default.
  const base = { REDPEN_HEADLESS: '1' };
  if (process.platform === 'win32') return { ...base, APPDATA: appDataDir };
  if (process.platform === 'darwin') return { ...base, HOME: appDataDir };
  return { ...base, XDG_DATA_HOME: appDataDir };
}

function discoveryPathFor(appDataDir: string): string {
  return path.join(appDataDir, 'redpen', 'daemon.json');
}

async function stopDaemonIfRunning(appDataDir: string): Promise<void> {
  try {
    const raw = await readFile(discoveryPathFor(appDataDir), 'utf8');
    const discovery = JSON.parse(raw) as { pid: number };
    process.kill(discovery.pid, 'SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 1000));
  } catch {
    // nothing to stop
  }
}

/** Starts a plain HTTP server that never responds, to simulate a wedged daemon. */
function startHangingServer(port: number): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer(() => {
      // Never call res.end() / res.writeHead() — the connection just hangs.
    });
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

async function main() {
  const appDataDir = await mkdtemp(path.join(os.tmpdir(), 'redpen-daemon-lifecycle-'));
  const env = jsonAppDataEnv(appDataDir);
  let hangingServer: Server | undefined;

  try {
    // --- daemon status with nothing running ---
    const statusBefore = await runCli(['daemon', 'status', '--json'], env);
    const statusBeforeJson = JSON.parse(statusBefore.stdout.trim());
    record('status-reports-not-running-before-any-start', statusBeforeJson.health === 'not-running', `health=${statusBeforeJson.health}`);
    record('status-exit-code-reflects-unavailable', statusBefore.code === 5, `code=${statusBefore.code}`);

    // --- daemon start ---
    const startResult = await runCli(['daemon', 'start', '--json'], env);
    const startJson = JSON.parse(startResult.stdout.trim());
    record('daemon-start-succeeds', startResult.code === 0 && startJson.started === true, `code=${startResult.code}`);
    const originalPid = startJson.pid as number;

    // --- daemon status after start reports running ---
    const statusAfterStart = await runCli(['daemon', 'status', '--json'], env);
    const statusAfterStartJson = JSON.parse(statusAfterStart.stdout.trim());
    record('status-reports-running-after-start', statusAfterStartJson.health === 'running', `health=${statusAfterStartJson.health}`);
    record('status-exit-code-ok-when-running', statusAfterStart.code === 0, `code=${statusAfterStart.code}`);

    // --- daemon start again is idempotent (reuses the same pid, doesn't spawn a second one) ---
    const startAgainResult = await runCli(['daemon', 'start', '--json'], env);
    const startAgainJson = JSON.parse(startAgainResult.stdout.trim());
    record('daemon-start-is-idempotent-when-already-running', startAgainJson.pid === originalPid, `pid=${startAgainJson.pid} original=${originalPid}`);

    // --- daemon stop ---
    const stopResult = await runCli(['daemon', 'stop', '--json'], env);
    const stopJson = JSON.parse(stopResult.stdout.trim());
    record('daemon-stop-succeeds', stopJson.stopped === true && stopJson.pid === originalPid, JSON.stringify(stopJson));

    await new Promise((resolve) => setTimeout(resolve, 500));
    const statusAfterStop = await runCli(['daemon', 'status', '--json'], env);
    const statusAfterStopJson = JSON.parse(statusAfterStop.stdout.trim());
    record('status-reports-not-running-after-stop', statusAfterStopJson.health === 'not-running', `health=${statusAfterStopJson.health}`);

    // --- half-dead recovery: write a discovery record pointing at a real-but-hanging process ---
    // Use a separate dummy child process as the "alive" pid, NOT this check
    // script's own process.pid — ensure-daemon's recovery path sends SIGTERM
    // to that pid, which would otherwise kill the checker itself.
    const dummyProcess = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    await new Promise((resolve) => setTimeout(resolve, 200)); // let it actually start

    const hangingPort = 34567;
    hangingServer = await startHangingServer(hangingPort);
    await mkdir(path.dirname(discoveryPathFor(appDataDir)), { recursive: true });
    await writeFile(
      discoveryPathFor(appDataDir),
      JSON.stringify({
        pid: dummyProcess.pid,
        port: hangingPort,
        token: 'wrong-token-hangs-anyway',
        startedAt: new Date().toISOString(),
      }),
    );
    // dummyProcess.pid is genuinely alive (isProcessAlive would say "running")
    // but the HTTP port never answers — exactly the "half-dead" scenario
    // docs/IMPLEMENTATION_PLAN.md calls out.

    const statusWhileHung = await runCli(['daemon', 'status', '--json'], env);
    const statusWhileHungJson = JSON.parse(statusWhileHung.stdout.trim());
    record('status-distinguishes-hung-from-not-running', statusWhileHungJson.health === 'hung', `health=${statusWhileHungJson.health}`);

    // A live PID that fails authenticated health may belong to an unrelated
    // process. Recovery may replace stale discovery, but must not signal it.
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body>fixture</body></html>');
    });
    const fixturePort = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        resolve(typeof address === 'object' && address ? address.port : 0);
      });
    });
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'redpen-daemon-lifecycle-ws-'));

    const openAfterHang = await runCli(['open', `http://127.0.0.1:${fixturePort}/`, '--project', workspaceRoot, '--json'], env);
    record(
      'open-recovers-without-killing-an-unverified-live-pid',
      openAfterHang.code === 0 && dummyProcess.pid !== undefined && isProcessAlive(dummyProcess.pid),
      `code=${openAfterHang.code} dummyAlive=${dummyProcess.pid === undefined ? false : isProcessAlive(dummyProcess.pid)}`,
    );

    const statusAfterRecovery = await runCli(['daemon', 'status', '--json'], env);
    const statusAfterRecoveryJson = JSON.parse(statusAfterRecovery.stdout.trim());
    record(
      'status-reports-a-new-authenticated-daemon-after-safe-recovery',
      statusAfterRecoveryJson.health === 'running' && statusAfterRecoveryJson.discovery.pid !== dummyProcess.pid,
      `health=${statusAfterRecoveryJson.health} pid=${statusAfterRecoveryJson.discovery?.pid}`,
    );

    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(workspaceRoot, { recursive: true, force: true }).catch(() => {});
    dummyProcess.kill();

    const allPass = checks.every((c) => c.pass);
    await mkdir(path.resolve(__dirname, '../.daemon-lifecycle-output'), { recursive: true });
    await writeFile(
      path.resolve(__dirname, '../.daemon-lifecycle-output/report.json'),
      JSON.stringify({ generatedAt: new Date().toISOString(), allPass, checks }, null, 2),
    );
    console.error(`\n${allPass ? 'ALL CHECKS PASSED' : 'SOME CHECKS FAILED'}`);
    if (!allPass) process.exitCode = 1;
  } finally {
    if (hangingServer) await new Promise<void>((resolve) => hangingServer!.close(() => resolve()));
    await stopDaemonIfRunning(appDataDir);
    await rm(appDataDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((err) => {
  console.error('daemon lifecycle check crashed:', err);
  process.exitCode = 1;
});
