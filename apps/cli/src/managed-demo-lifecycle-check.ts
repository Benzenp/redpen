import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(__dirname, '../../..');
const runnerEntry = path.join(workspaceRoot, 'fixtures', 'demo-app', 'redpen-session.mjs');
const cliEntry = path.join(workspaceRoot, 'apps', 'cli', 'bin', 'redpen.mjs');

interface RunnerEvent {
  ready?: boolean;
  stopped?: boolean;
  reason?: string;
  sessionId?: string;
  url?: string;
}

interface RunningRunner {
  child: ChildProcess;
  events: RunnerEvent[];
  ready: RunnerEvent;
  waitForEvent: (predicate: (event: RunnerEvent) => boolean, timeoutMs?: number) => Promise<RunnerEvent>;
  waitForExit: (timeoutMs?: number) => Promise<number>;
}

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

function isolatedEnv(appDataDir: string): NodeJS.ProcessEnv {
  const base = { ...process.env, REDPEN_HEADLESS: '1' };
  if (process.platform === 'win32') return { ...base, APPDATA: appDataDir };
  if (process.platform === 'darwin') return { ...base, HOME: appDataDir };
  return { ...base, XDG_DATA_HOME: appDataDir };
}

function waitForExit(child: ChildProcess, timeoutMs = 20_000): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('runner exit timed out')), timeoutMs);
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  });
}

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliEntry, ...args], {
      cwd: workspaceRoot,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('close', (code) => resolve({ code: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() }));
  });
}

function launchRunner(env: NodeJS.ProcessEnv): Promise<RunningRunner> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runnerEntry, '0'], {
      cwd: workspaceRoot,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const events: RunnerEvent[] = [];
    const waiters: Array<{
      predicate: (event: RunnerEvent) => boolean;
      resolve: (event: RunnerEvent) => void;
    }> = [];
    let stderr = '';
    let buffer = '';

    const emit = (event: RunnerEvent) => {
      events.push(event);
      for (const waiter of [...waiters]) {
        if (!waiter.predicate(event)) continue;
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(event);
      }
      if (event.ready) {
        resolve({
          child,
          events,
          ready: event,
          waitForEvent: (predicate, timeoutMs = 20_000) => new Promise((eventResolve, eventReject) => {
            const existing = events.find(predicate);
            if (existing) {
              eventResolve(existing);
              return;
            }
            let timer: NodeJS.Timeout;
            const waiter = {
              predicate,
              resolve: (event: RunnerEvent) => {
                clearTimeout(timer);
                eventResolve(event);
              },
            };
            waiters.push(waiter);
            timer = setTimeout(() => {
              const index = waiters.indexOf(waiter);
              if (index !== -1) waiters.splice(index, 1);
              eventReject(new Error(`runner event timed out; stderr=${stderr}`));
            }, timeoutMs);
          }),
          waitForExit: (timeoutMs) => waitForExit(child, timeoutMs),
        });
      }
    };

    child.stdout?.on('data', (chunk) => {
      buffer += chunk.toString();
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) emit(JSON.parse(line) as RunnerEvent);
        newline = buffer.indexOf('\n');
      }
    });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', (code) => {
      if (!events.some((event) => event.ready)) {
        reject(new Error(`runner exited before ready: code=${code ?? 1} stderr=${stderr}`));
      }
    });
  });
}

async function urlIsReachable(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitUntilUnreachable(url: string): Promise<boolean> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!(await urlIsReachable(url))) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function runTerminalStateCheck(state: 'done' | 'cancelled'): Promise<void> {
  const appDataDir = await mkdtemp(path.join(os.tmpdir(), `redpen-managed-${state}-`));
  try {
    const runner = await launchRunner(isolatedEnv(appDataDir));
    const { sessionId, url } = runner.ready;
    if (!sessionId || !url) throw new Error('runner ready event omitted session data');
    record(`${state}-runner-serves-target`, await urlIsReachable(url), `url=${url}`);

    const sessionPath = path.join(appDataDir, 'redpen', 'sessions', `${sessionId}.json`);
    const session = JSON.parse(await readFile(sessionPath, 'utf8')) as { state: string; updatedAt: string };
    session.state = state;
    session.updatedAt = new Date().toISOString();
    await writeFile(sessionPath, JSON.stringify(session, null, 2));

    const stopped = await runner.waitForEvent((event) => event.stopped === true);
    const exitCode = await runner.waitForExit();
    record(
      `${state}-triggers-cleanup`,
      stopped.reason === `session-${state}` && exitCode === 0,
      `reason=${stopped.reason} code=${exitCode}`,
    );
    record(`${state}-closes-owned-port`, await waitUntilUnreachable(url), `url=${url}`);
    const sessionStillExists = await readFile(sessionPath, 'utf8').then(() => true, () => false);
    record(`${state}-removes-session-record`, !sessionStillExists, `exists=${sessionStillExists}`);
  } finally {
    await rm(appDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

async function runDaemonExitCheck(): Promise<void> {
  const appDataDir = await mkdtemp(path.join(os.tmpdir(), 'redpen-managed-browser-'));
  try {
    const runner = await launchRunner(isolatedEnv(appDataDir));
    const { url } = runner.ready;
    if (!url) throw new Error('runner ready event omitted url');
    const discoveryPath = path.join(appDataDir, 'redpen', 'daemon.json');
    const discovery = JSON.parse(await readFile(discoveryPath, 'utf8')) as { pid: number };
    process.kill(discovery.pid, 'SIGTERM');

    const stopped = await runner.waitForEvent((event) => event.stopped === true);
    const exitCode = await runner.waitForExit();
    record(
      'daemon-exit-triggers-owned-server-cleanup',
      stopped.reason === 'browser-or-daemon-closed' && exitCode === 0,
      `reason=${stopped.reason} code=${exitCode}`,
    );
    record('daemon-exit-closes-owned-port', await waitUntilUnreachable(url), `url=${url}`);
  } finally {
    await rm(appDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

async function runParentExitCheck(): Promise<void> {
  const appDataDir = await mkdtemp(path.join(os.tmpdir(), 'redpen-managed-parent-'));
  const owner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    windowsHide: true,
    stdio: 'ignore',
  });
  try {
    if (!owner.pid) throw new Error('owner process did not start');
    const runner = await launchRunner({
      ...isolatedEnv(appDataDir),
      REDPEN_OWNER_PID: String(owner.pid),
    });
    const { url } = runner.ready;
    if (!url) throw new Error('runner ready event omitted url');
    owner.kill('SIGTERM');
    const stopped = await runner.waitForEvent((event) => event.stopped === true);
    const exitCode = await runner.waitForExit();
    record('wrapper-exit-triggers-cleanup', stopped.reason === 'parent-exited', `reason=${stopped.reason}`);
    record('wrapper-exit-exits-runner', exitCode === 0, `code=${exitCode}`);
    record('wrapper-exit-closes-owned-port', await waitUntilUnreachable(url), `url=${url}`);
  } finally {
    owner.kill('SIGTERM');
    await rm(appDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

async function runSharedDaemonCheck(): Promise<void> {
  const appDataDir = await mkdtemp(path.join(os.tmpdir(), 'redpen-managed-shared-'));
  const env = isolatedEnv(appDataDir);
  const secondServer = createServer((_request, response) => response.end('<!doctype html><title>Second session</title>'));
  await new Promise<void>((resolve) => secondServer.listen(0, '127.0.0.1', resolve));
  const address = secondServer.address();
  const secondUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/`;
  try {
    const runner = await launchRunner(env);
    const runnerSessionId = runner.ready.sessionId;
    if (!runnerSessionId) throw new Error('managed runner omitted session id');
    const secondOpen = await runCli(['open', secondUrl, '--project', workspaceRoot, '--json'], env);
    if (secondOpen.code !== 0) throw new Error(`second session open failed: ${secondOpen.stderr}`);
    const secondSessionId = (JSON.parse(secondOpen.stdout) as { session: { id: string } }).session.id;
    const discoveryPath = path.join(appDataDir, 'redpen', 'daemon.json');
    const daemonBefore = JSON.parse(await readFile(discoveryPath, 'utf8')) as { pid: number };

    const runnerSessionPath = path.join(appDataDir, 'redpen', 'sessions', `${runnerSessionId}.json`);
    const runnerSession = JSON.parse(await readFile(runnerSessionPath, 'utf8')) as { state: string; updatedAt: string };
    runnerSession.state = 'done';
    runnerSession.updatedAt = new Date().toISOString();
    await writeFile(runnerSessionPath, JSON.stringify(runnerSession, null, 2));
    await runner.waitForEvent((event) => event.stopped === true);
    await runner.waitForExit();

    const daemonAfter = JSON.parse(await readFile(discoveryPath, 'utf8')) as { pid: number };
    record(
      'shared-daemon-process-is-preserved',
      daemonAfter.pid === daemonBefore.pid,
      `before=${daemonBefore.pid} after=${daemonAfter.pid}`,
    );
    const secondStatus = await runCli(['status', secondSessionId, '--json'], env);
    record('shared-daemon-survives-first-session-cleanup', secondStatus.code === 0, `code=${secondStatus.code}`);
    const secondClose = await runCli(['close', secondSessionId, '--shutdown-if-idle', '--json'], env);
    record('last-session-close-succeeds', secondClose.code === 0, `code=${secondClose.code}`);
  } finally {
    await runCli(['daemon', 'stop', '--json'], env);
    await new Promise<void>((resolve) => secondServer.close(() => resolve()));
    await rm(appDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

async function main() {
  await runTerminalStateCheck('done');
  await runTerminalStateCheck('cancelled');
  await runDaemonExitCheck();
  await runParentExitCheck();
  await runSharedDaemonCheck();

  const failed = checks.filter((check) => !check.pass);
  if (failed.length > 0) {
    console.error(`\n${failed.length} managed lifecycle check(s) failed.`);
    process.exit(1);
  }
  console.log('ALL MANAGED DEMO LIFECYCLE CHECKS PASSED');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
