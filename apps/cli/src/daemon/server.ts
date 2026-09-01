/**
 * Local daemon HTTP server (docs/ARCHITECTURE.md §3.4).
 *
 * - Binds 127.0.0.1 only.
 * - Every request must carry `Authorization: Bearer <token>` matching the
 *   discovery record's random token.
 * - Routes are thin: they parse the request, call RedpenApplicationService,
 *   and serialize the result. No business logic lives here.
 */
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { RedpenApplicationService } from '../application/service.js';
import { SessionNotFoundError, TaskNotFoundError, NoActiveCaptureError } from '../application/errors.js';
import { UnsupportedUrlError } from '../application/url-policy.js';
import { InvalidSessionTransitionError } from '@redpen/protocol/state-machine';

export interface StartedDaemon {
  server: Server;
  port: number;
  token: string;
  service: RedpenApplicationService;
  close: () => Promise<void>;
}

function errorToHttpStatus(err: unknown): number {
  if (err instanceof SessionNotFoundError || err instanceof TaskNotFoundError) return 404;
  if (err instanceof UnsupportedUrlError || err instanceof InvalidSessionTransitionError) return 400;
  if (err instanceof NoActiveCaptureError) return 409;
  return 500;
}

async function readJsonBody(req: import('node:http').IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function startDaemon(port = 0): Promise<StartedDaemon> {
  const service = new RedpenApplicationService();
  const token = randomUUID();

  const server = createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    try {
      const auth = req.headers.authorization ?? '';
      if (auth !== `Bearer ${token}`) {
        send(401, { error: 'unauthorized' });
        return;
      }

      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const parts = url.pathname.split('/').filter(Boolean);

      if (req.method === 'GET' && parts[0] === 'health') {
        send(200, { ok: true });
        return;
      }

      if (req.method === 'POST' && parts[0] === 'sessions' && !parts[1]) {
        const body = (await readJsonBody(req)) as { url: string; workspaceRoot: string };
        const session = await service.openSession({ url: body.url, workspaceRoot: body.workspaceRoot });
        send(200, { session });
        return;
      }

      if (req.method === 'GET' && parts[0] === 'sessions' && !parts[1]) {
        const workspaceRoot = url.searchParams.get('workspaceRoot') ?? undefined;
        const sessions = await service.listAllSessions(workspaceRoot ? { workspaceRoot } : undefined);
        send(200, { sessions });
        return;
      }

      if (req.method === 'GET' && parts[0] === 'sessions' && parts[1] && !parts[2]) {
        const session = await service.getSession(parts[1]);
        send(200, { session });
        return;
      }

      if (req.method === 'POST' && parts[0] === 'sessions' && parts[1] && parts[2] === 'freeze') {
        const session = await service.freeze(parts[1]);
        send(200, { session });
        return;
      }

      if (req.method === 'POST' && parts[0] === 'sessions' && parts[1] && parts[2] === 'submit') {
        const body = (await readJsonBody(req)) as { globalNote?: string };
        const result = await service.submit(parts[1], body.globalNote);
        send(200, result);
        return;
      }

      if (req.method === 'GET' && parts[0] === 'sessions' && parts[1] && parts[2] === 'wait') {
        const timeoutSeconds = Number(url.searchParams.get('timeout') ?? '600');
        const result = await service.waitForSubmission(parts[1], timeoutSeconds);
        send(200, result);
        return;
      }

      if (req.method === 'POST' && parts[0] === 'sessions' && parts[1] && parts[2] === 'claim') {
        const session = await service.claim(parts[1]);
        send(200, { session });
        return;
      }

      if (req.method === 'POST' && parts[0] === 'sessions' && parts[1] && parts[2] === 'review-ready') {
        const session = await service.markReviewReady(parts[1]);
        send(200, { session });
        return;
      }

      if (req.method === 'POST' && parts[0] === 'sessions' && parts[1] && parts[2] === 'accept') {
        const session = await service.accept(parts[1]);
        send(200, { session });
        return;
      }

      if (req.method === 'POST' && parts[0] === 'sessions' && parts[1] && parts[2] === 'cancel') {
        const session = await service.cancel(parts[1]);
        send(200, { session });
        return;
      }

      if (req.method === 'DELETE' && parts[0] === 'sessions' && parts[1]) {
        await service.closeSession(parts[1]);
        send(200, { ok: true });
        return;
      }

      if (req.method === 'GET' && parts[0] === 'tasks' && parts[1]) {
        const workspaceRoot = url.searchParams.get('workspaceRoot') ?? '';
        const task = await service.getTask(workspaceRoot, parts[1]);
        send(200, { task });
        return;
      }

      if (req.method === 'GET' && parts[0] === 'tasks' && !parts[1]) {
        const workspaceRoot = url.searchParams.get('workspaceRoot') ?? '';
        const taskIds = await service.listTasks(workspaceRoot);
        send(200, { taskIds });
        return;
      }

      send(404, { error: 'not_found' });
    } catch (err) {
      send(errorToHttpStatus(err), { error: (err as Error).name, message: (err as Error).message });
    }
  });

  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;

  return {
    server,
    port: actualPort,
    token,
    service,
    close: async () => {
      await service.shutdown();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
