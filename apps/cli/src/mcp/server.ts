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

  return server;
}

export async function runMcpServer(): Promise<void> {
  const server = createRedpenMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
