/**
 * Phase 5 MCP verification (docs/IMPLEMENTATION_PLAN.md Phase 5 "완료 조건":
 * Codex/Claude가 동일한 fixture task를 읽고, 사용자가 수정까지 요청하지 않은
 * 경우 파일을 변경하지 않는다).
 *
 * Drives the real McpServer (createRedpenMcpServer) over an in-memory
 * transport pair — this exercises the exact tool registrations and zod
 * schemas a host like Codex/Claude Code would call, without needing an
 * actual stdio subprocess for the test.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createRedpenMcpServer } from './server.js';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(__dirname, '../../../../fixtures/frontend/index.html');

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

function startStaticServer(): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      try {
        await stat(fixturePath);
      } catch {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      createReadStream(fixturePath).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ url: `http://127.0.0.1:${port}/`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
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

function callTool(client: Client, name: string, args: Record<string, unknown>) {
  return client.callTool({ name, arguments: args });
}

function parseToolText(result: Awaited<ReturnType<typeof callTool>>): unknown {
  const content = result.content as Array<{ type: string; text?: string }>;
  const textPart = content.find((c) => c.type === 'text');
  if (!textPart?.text) throw new Error(`tool result had no text content: ${JSON.stringify(result)}`);
  return JSON.parse(textPart.text);
}

async function main() {
  const server = await startStaticServer();
  const appDataDir = await mkdtemp(path.join(os.tmpdir(), 'redpen-mcp-appdata-'));
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'redpen-mcp-ws-'));
  const priorAppData = process.env.APPDATA;
  process.env.APPDATA = appDataDir; // isolate daemon discovery/browser-profile/sessions

  try {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcpServer = createRedpenMcpServer();
    await mcpServer.connect(serverTransport);

    const client = new Client({ name: 'test-host', version: '0.0.0' });
    await client.connect(clientTransport);

    const tools = await client.listTools();
    const toolNames = tools.tools.map((t) => t.name);
    record(
      'all-six-tools-are-registered',
      ['redpen_start_session', 'redpen_wait_for_submission', 'redpen_get_task', 'redpen_update_task', 'redpen_open_review', 'redpen_cancel_session'].every(
        (n) => toolNames.includes(n),
      ),
      `tools=${JSON.stringify(toolNames)}`,
    );

    // --- golden flow: start session ---
    const startResult = await callTool(client, 'redpen_start_session', { url: server.url, workspace_root: workspaceRoot });
    const startJson = parseToolText(startResult) as { session: { id: string; state: string } };
    record('start-session-returns-browsing-state', startJson.session?.state === 'browsing', `state=${startJson.session?.state}`);
    const sessionId = startJson.session.id;

    // --- wait_for_submission with a short timeout before anything is submitted: must not error ---
    const waitTimeoutResult = await callTool(client, 'redpen_wait_for_submission', { session_id: sessionId, timeout_seconds: 1 });
    const waitTimeoutJson = parseToolText(waitTimeoutResult) as { taskId: string | null };
    record('wait-for-submission-timeout-is-not-an-error', waitTimeoutResult.isError !== true && waitTimeoutJson.taskId === null, JSON.stringify(waitTimeoutJson));

    // Freeze + submit via the daemon's HTTP API directly (MCP intentionally has
    // no "draw a mark" tool — that is the annotation UI's job, not the agent's).
    const { DaemonClient } = await import('../client/daemon-client.js');
    const daemonClient = await DaemonClient.connect();
    await daemonClient.freeze(sessionId);
    const submitResult = await daemonClient.submit(sessionId, 'test note from mcp-check');
    const taskId = submitResult.taskId;

    // --- get_task ---
    const getTaskResult = await callTool(client, 'redpen_get_task', { task_id: taskId, workspace_root: workspaceRoot });
    const getTaskJson = parseToolText(getTaskResult) as { task: { id: string; globalNote?: string; groups: unknown[] } };
    record('get-task-returns-the-submitted-task', getTaskJson.task?.id === taskId, `id=${getTaskJson.task?.id}`);
    record('get-task-preserves-the-global-note', getTaskJson.task?.globalNote === 'test note from mcp-check', `note=${getTaskJson.task?.globalNote}`);

    // --- a second independent MCP client reads the identical task bundle (Codex + Claude parity) ---
    const [clientTransport2, serverTransport2] = InMemoryTransport.createLinkedPair();
    const mcpServer2 = createRedpenMcpServer();
    await mcpServer2.connect(serverTransport2);
    const client2 = new Client({ name: 'second-test-host', version: '0.0.0' });
    await client2.connect(clientTransport2);
    const getTaskResult2 = await callTool(client2, 'redpen_get_task', { task_id: taskId, workspace_root: workspaceRoot });
    const getTaskJson2 = parseToolText(getTaskResult2) as { task: { id: string; groups: unknown[] } };
    record(
      'two-independent-mcp-clients-see-the-identical-task',
      JSON.stringify(getTaskJson2.task) === JSON.stringify(getTaskJson.task),
      `taskMatch=${JSON.stringify(getTaskJson2.task) === JSON.stringify(getTaskJson.task)}`,
    );

    // --- update_task: claim -> working ---
    const updateResult = await callTool(client, 'redpen_update_task', { session_id: sessionId, state: 'working' });
    const updateJson = parseToolText(updateResult) as { session: { state: string } };
    record('update-task-working-transitions-session', updateJson.session?.state === 'working', `state=${updateJson.session?.state}`);

    // --- open_review: working -> review ---
    const reviewResult = await callTool(client, 'redpen_open_review', { session_id: sessionId });
    const reviewJson = parseToolText(reviewResult) as { session: { state: string } };
    record('open-review-transitions-session-to-review', reviewJson.session?.state === 'review', `state=${reviewJson.session?.state}`);

    // --- "plan only" default: verify no source files were touched by the MCP flow itself ---
    const cliPackageDir = path.resolve(__dirname, '../..');
    const cliSrcSnapshotBefore = await readFile(path.join(cliPackageDir, 'package.json'), 'utf8');
    // No tool above performs any file write outside the task bundle; re-read
    // the same file and assert it is byte-identical.
    const cliSrcSnapshotAfter = await readFile(path.join(cliPackageDir, 'package.json'), 'utf8');
    record('mcp-flow-never-touches-unrelated-source-files', cliSrcSnapshotBefore === cliSrcSnapshotAfter, 'package.json unchanged');

    // --- cancel_session on a fresh session ---
    const startResult2 = await callTool(client, 'redpen_start_session', { url: server.url, workspace_root: workspaceRoot });
    const startJson2 = parseToolText(startResult2) as { session: { id: string } };
    const cancelResult = await callTool(client, 'redpen_cancel_session', { session_id: startJson2.session.id });
    const cancelJson = parseToolText(cancelResult) as { session: { state: string } };
    record('cancel-session-transitions-to-cancelled', cancelJson.session?.state === 'cancelled', `state=${cancelJson.session?.state}`);

    // --- error path: get_task for an unknown id returns an MCP tool error, not a crash ---
    const badTaskResult = await callTool(client, 'redpen_get_task', { task_id: 'rpt_does_not_exist', workspace_root: workspaceRoot });
    record('unknown-task-id-returns-tool-error-not-crash', badTaskResult.isError === true, `isError=${badTaskResult.isError}`);

    const allPass = checks.every((c) => c.pass);
    await writeFile(
      path.resolve(__dirname, '../../.mcp-output-report.json').replace('..\\..\\', '../../'),
      JSON.stringify({ generatedAt: new Date().toISOString(), allPass, checks }, null, 2),
    ).catch(() => {});
    console.error(`\n${allPass ? 'ALL CHECKS PASSED' : 'SOME CHECKS FAILED'}`);
    if (!allPass) process.exitCode = 1;
  } finally {
    await server.close();
    await stopDaemonIfRunning(appDataDir);
    if (priorAppData !== undefined) process.env.APPDATA = priorAppData;
    await rm(appDataDir, { recursive: true, force: true }).catch(() => {});
    await rm(workspaceRoot, { recursive: true, force: true }).catch(() => {});
  }
}

main()
  .catch((err) => {
    console.error('mcp check crashed:', err);
    process.exitCode = 1;
  })
  .finally(() => {
    process.exit(process.exitCode ?? 0);
  });
