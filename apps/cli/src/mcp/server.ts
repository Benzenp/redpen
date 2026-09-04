/**
 * MCP stdio adapter (docs/ARCHITECTURE.md §8, docs/IMPLEMENTATION_PLAN.md
 * Phase 5).
 *
 * Every tool here is a thin wrapper around DaemonClient — the same
 * application-core calls the CLI makes (docs/ARCHITECTURE.md §2.1 "CLI
 * first"; MCP is "같은 core를 호출하는 얇은 어댑터"). No business logic is
 * duplicated here.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { DaemonClient, DaemonRequestError } from '../client/daemon-client.js';

function textResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

function errorResult(err: unknown) {
  const message = err instanceof DaemonRequestError ? err.message : (err as Error).message;
  return { content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }], isError: true };
}

const identifier = z.string().min(1).max(200);
const workspaceRoot = z.string().min(1).max(4096);
const command = z.string().min(1).max(1024);
const argument = z.string().max(4096);
const argv = z.array(argument).max(128);
const environment = z.record(z.string().min(1).max(128), z.string().max(8192)).refine(
  (value) => Object.keys(value).length <= 64,
  'environment may contain at most 64 variables',
);
const readyTimeoutMs = z.number().int().positive().max(10 * 60_000);
const verificationCommands = z.array(z.array(z.string().min(1).max(4096)).min(1).max(128)).max(32);
const includedTaskIds = z.array(identifier).min(1).max(9).refine(
  (ids) => new Set(ids).size === ids.length,
  'included task ids must be unique',
);

export function createRedpenMcpServer(): McpServer {
  const server = new McpServer({ name: 'redpen', version: '0.0.0' });

  server.registerTool(
    'redpen_start_session',
    {
      description: 'Open a Redpen session against a local (loopback-only) URL so the user can visually annotate it.',
      inputSchema: {
        url: z.string().describe('localhost/127.0.0.1 URL to open'),
        workspace_root: z.string().optional().describe('workspace root; defaults to the current directory'),
      },
    },
    async ({ url, workspace_root }) => {
      try {
        const client = await DaemonClient.connect();
        const result = await client.openSession(url, workspace_root ?? process.cwd());
        return textResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'redpen_wait_for_submission',
    {
      description:
        'Wait for the user to submit annotations for a session. Times out gracefully without failing — the session stays open and redpen_get_task can be retried.',
      inputSchema: {
        session_id: z.string(),
        timeout_seconds: z.number().int().positive().optional().default(600),
      },
    },
    async ({ session_id, timeout_seconds }) => {
      try {
        const client = await DaemonClient.connect();
        const result = await client.wait(session_id, timeout_seconds);
        return textResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'redpen_get_task',
    {
      description: 'Fetch a submitted task bundle (groups, marks, DOM targets, asset paths) by task id.',
      inputSchema: {
        task_id: z.string(),
        workspace_root: z.string().optional(),
      },
    },
    async ({ task_id, workspace_root }) => {
      try {
        const client = await DaemonClient.connect();
        const result = await client.getTask(task_id, workspace_root ?? process.cwd());
        return textResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'redpen_update_task',
    {
      description: 'Advance a session\'s state as the agent works on a task: claim (submitted->working), review (working->review), or accept (review->done).',
      inputSchema: {
        session_id: z.string(),
        state: z.enum(['working', 'review', 'done']),
      },
    },
    async ({ session_id, state }) => {
      try {
        const client = await DaemonClient.connect();
        const result =
          state === 'working' ? await client.claim(session_id) : state === 'review' ? await client.reviewReady(session_id) : await client.accept(session_id);
        return textResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'redpen_open_review',
    {
      description: 'Re-open a session for review (alias for redpen_update_task with state=review), optionally noting a URL the implementation is now running at.',
      inputSchema: {
        session_id: z.string(),
        url: z.string().optional(),
      },
    },
    async ({ session_id }) => {
      try {
        const client = await DaemonClient.connect();
        const result = await client.reviewReady(session_id);
        return textResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'redpen_cancel_session',
    {
      description: 'Cancel a Redpen session that is no longer needed.',
      inputSchema: {
        session_id: z.string(),
      },
    },
    async ({ session_id }) => {
      try {
        const client = await DaemonClient.connect();
        const result = await client.cancelSession(session_id);
        return textResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'redpen_prepare_execution',
    {
      description: 'Create an execution run, one task per submitted VisualTask instruction group, and candidate worktrees. Preparation alone does not implement anything.',
      inputSchema: {
        task_id: identifier,
        workspace_root: workspaceRoot.optional(),
        base_ref: z.string().min(1).max(512).optional(),
        candidates_per_task: z.number().int().min(1).max(9).optional().default(1),
      },
    },
    async ({ task_id, workspace_root, base_ref, candidates_per_task }) => {
      try {
        const result = await (await DaemonClient.connect()).prepareTaskExecution(
          workspace_root ?? process.cwd(), task_id, candidates_per_task, base_ref,
        );
        return textResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'redpen_start_candidate_agent',
    {
      description: 'Start an owned external agent in a draft candidate worktree. command and args expand {instruction}, {worktree}, {runId}, {taskId}, and {candidateId}.',
      inputSchema: {
        run_id: identifier, task_id: identifier, candidate_id: identifier, command,
        args: argv, env: environment.optional(), workspace_root: workspaceRoot.optional(),
      },
    },
    async ({ run_id, task_id, candidate_id, command, args, env, workspace_root }) => {
      try {
        const result = await (await DaemonClient.connect()).startExecutionAgent(run_id, {
          workspaceRoot: workspace_root ?? process.cwd(), taskId: task_id, candidateId: candidate_id, command, args, env,
        });
        return textResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'redpen_add_candidate',
    {
      description: 'Add another isolated candidate worktree to one execution task for an alternative implementation.',
      inputSchema: {
        run_id: identifier,
        task_id: identifier,
        workspace_root: workspaceRoot.optional(),
      },
    },
    async ({ run_id, task_id, workspace_root }) => {
      try {
        const result = await (await DaemonClient.connect()).addExecutionCandidate(
          run_id,
          task_id,
          workspace_root ?? process.cwd(),
        );
        return textResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  for (const [name, method, description] of [
    ['redpen_get_execution_process', 'getExecutionProcess', 'Get an owned execution process.'],
    ['redpen_wait_execution_process', 'waitExecutionProcess', 'Wait for an owned execution process to exit.'],
    ['redpen_stop_execution_process', 'stopExecutionProcess', 'Stop an owned execution process and its process tree.'],
  ] as const) {
    server.registerTool(
      name,
      { description, inputSchema: { run_id: identifier, process_id: identifier } },
      async ({ run_id, process_id }) => {
        try {
          const client = await DaemonClient.connect();
          const result = method === 'getExecutionProcess'
            ? await client.getExecutionProcess(run_id, process_id)
            : method === 'waitExecutionProcess'
              ? await client.waitExecutionProcess(run_id, process_id)
              : await client.stopExecutionProcess(run_id, process_id);
          return textResult(result);
        } catch (err) {
          return errorResult(err);
        }
      },
    );
  }

  server.registerTool(
    'redpen_finalize_candidate',
    {
      description: 'Run candidate verification commands, commit its worktree, push it, and verify the remote commit.',
      inputSchema: {
        run_id: identifier, task_id: identifier, candidate_id: identifier,
        commit_message: z.string().min(1).max(4096),
        verification_commands: verificationCommands.optional(),
        remote: z.string().min(1).max(256).optional(),
        workspace_root: workspaceRoot.optional(),
      },
    },
    async ({ run_id, task_id, candidate_id, commit_message, verification_commands, remote, workspace_root }) => {
      try {
        const result = await (await DaemonClient.connect()).finalizeExecutionCandidate(run_id, task_id, candidate_id, {
          workspaceRoot: workspace_root ?? process.cwd(), commitMessage: commit_message,
          verificationCommands: verification_commands, remote,
        });
        return textResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'redpen_select_candidate',
    {
      description: 'Select the finalized candidate to include for one execution task.',
      inputSchema: { run_id: identifier, task_id: identifier, candidate_id: identifier, workspace_root: workspaceRoot.optional() },
    },
    async ({ run_id, task_id, candidate_id, workspace_root }) => {
      try {
        return textResult(await (await DaemonClient.connect()).selectExecutionCandidate(
          run_id, task_id, candidate_id, workspace_root ?? process.cwd(),
        ));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'redpen_start_preview',
    {
      description: 'Build the selected candidate integration, start its managed preview server, wait for its URL, and open it.',
      inputSchema: {
        run_id: identifier, command, args: argv, url: z.string().url().max(2048),
        workspace_root: workspaceRoot.optional(), included_task_ids: includedTaskIds.optional(),
        env: environment.optional(), ready_timeout_ms: readyTimeoutMs.optional(),
      },
    },
    async ({ run_id, command, args, url, workspace_root, included_task_ids, env, ready_timeout_ms }) => {
      try {
        return textResult(await (await DaemonClient.connect()).startExecutionPreview(run_id, {
          workspaceRoot: workspace_root ?? process.cwd(), command, args, url, includedTaskIds: included_task_ids, env, readyTimeoutMs: ready_timeout_ms,
        }));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'redpen_start_candidate_comparison',
    {
      description: 'Start managed servers for sealed candidates and open an interactive CDP comparison review.',
      inputSchema: {
        run_id: identifier, workspace_root: workspaceRoot.optional(),
        candidates: z.array(z.object({
          candidate_id: identifier, command, args: argv, env: environment.optional(),
          url: z.string().url().max(2048), ready_timeout_ms: readyTimeoutMs.optional(),
        })).min(1).max(9).refine(
          (candidates) => new Set(candidates.map((candidate) => candidate.candidate_id)).size === candidates.length,
          'candidate ids must be unique',
        ),
      },
    },
    async ({ run_id, workspace_root, candidates }) => {
      try {
        return textResult(await (await DaemonClient.connect()).startCandidateComparison(run_id, {
          workspaceRoot: workspace_root ?? process.cwd(),
          candidates: candidates.map(({ candidate_id, ready_timeout_ms, ...candidate }) => ({
            candidateId: candidate_id, readyTimeoutMs: ready_timeout_ms, ...candidate,
          })),
        }));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'redpen_publish_execution',
    {
      description: 'Assemble selected finalized candidates cleanly, fast-forward merge them to the target branch, push, and verify the remote result.',
      inputSchema: {
        run_id: identifier, workspace_root: workspaceRoot.optional(), included_task_ids: includedTaskIds.optional(),
        target_branch: z.string().min(1).max(512).optional(), remote: z.string().min(1).max(256).optional(),
      },
    },
    async ({ run_id, workspace_root, included_task_ids, target_branch, remote }) => {
      try {
        return textResult(await (await DaemonClient.connect()).publishExecutionFinal(run_id, {
          workspaceRoot: workspace_root ?? process.cwd(), includedTaskIds: included_task_ids, targetBranch: target_branch, remote,
        }));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  return server;
}

export async function runMcpServer(): Promise<void> {
  const server = createRedpenMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
