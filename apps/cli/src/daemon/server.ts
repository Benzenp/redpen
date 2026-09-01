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
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RedpenApplicationService } from '../application/service.js';
import { SessionNotFoundError, TaskNotFoundError, NoActiveCaptureError } from '../application/errors.js';
import { UnsupportedUrlError } from '../application/url-policy.js';
import { InvalidSessionTransitionError } from '@redpen/protocol/state-machine';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// apps/cli/src/daemon -> apps/annotator/public. Resolved at runtime (not
// bundled) since these are static assets the daemon reads off disk.
const annotatorPublicDir = path.resolve(__dirname, '../../../annotator/public');

const STATIC_CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.png': 'image/png',
};

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
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const parts = url.pathname.split('/').filter(Boolean);

      if (req.method === 'GET' && parts[0] === 'health') {
        // No auth required: this is the liveness probe ensure-daemon.ts and
        // probeDaemonHealth() use precisely to tell a live-but-wrong-token
        // daemon apart from a genuinely dead one.
        send(200, { ok: true });
        return;
      }

      // The bundled annotator JS is static, session-independent code \u2014
      // serving it without auth lets the browser tab load
      // <script src="/session.bundle.js"> as a normal same-origin request
      // (it cannot attach an Authorization header or a query string to a
      // <script> tag's src). It never reveals anything session-specific.
      if (req.method === 'GET' && parts[0] === 'session.bundle.js') {
        const js = await readFile(path.join(annotatorPublicDir, 'session.bundle.js'));
        res.writeHead(200, { 'Content-Type': STATIC_CONTENT_TYPES['.js'] });
        res.end(js);
        return;
      }

      // The annotation UI is opened as a real browser tab (docs/ARCHITECTURE.md
      // \u00a74.2) which cannot attach an Authorization header to top-level
      // navigation or <img> requests, so its session-specific routes accept
      // the token as a query parameter instead. Every other route still
      // requires the header.
      const isBrowserTabRoute =
        req.method === 'GET' &&
        (parts[0] === 'annotator' || (parts[0] === 'api' && parts[1] === 'sessions' && parts[3] === 'annotator' && parts[4] === 'screenshot'));
      const auth = req.headers.authorization ?? '';
      const queryToken = url.searchParams.get('token');
      const authorized = isBrowserTabRoute ? queryToken === token : auth === `Bearer ${token}`;
      if (!authorized) {
        send(401, { error: 'unauthorized' });
        return;
      }

      if (req.method === 'GET' && parts[0] === 'annotator' && parts[1]) {
        const html = await readFile(path.join(annotatorPublicDir, 'session.html'), 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
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

      // --- Annotation UI API: /api/sessions/:id/annotator/* ---
      if (parts[0] === 'api' && parts[1] === 'sessions' && parts[2] && parts[3] === 'annotator') {
        const sessionId = parts[2];
        const sub = parts.slice(4);

        if (req.method === 'GET' && sub.length === 1 && sub[0] === 'screenshot') {
          const screenshot = service.getCaptureScreenshot(sessionId);
          res.writeHead(200, { 'Content-Type': 'image/png' });
          res.end(screenshot);
          return;
        }

        if (req.method === 'GET' && sub.length === 0) {
          send(200, service.getAnnotatorState(sessionId));
          return;
        }

        if (req.method === 'POST' && sub.length === 1 && sub[0] === 'marks') {
          const body = (await readJsonBody(req)) as Parameters<typeof service.addMark>[1];
          const mark = service.addMark(sessionId, body);
          send(200, { mark });
          return;
        }

        if (req.method === 'DELETE' && sub.length === 2 && sub[0] === 'marks') {
          service.removeMark(sessionId, sub[1]);
          send(200, { ok: true });
          return;
        }

        if (req.method === 'POST' && sub.length === 1 && sub[0] === 'undo') {
          send(200, { undone: service.undoAnnotation(sessionId) });
          return;
        }

        if (req.method === 'POST' && sub.length === 1 && sub[0] === 'redo') {
          send(200, { redone: service.redoAnnotation(sessionId) });
          return;
        }

        if (req.method === 'POST' && sub.length === 1 && sub[0] === 'groups') {
          const group = service.createAnnotationGroup(sessionId);
          send(200, { group });
          return;
        }

        if (req.method === 'POST' && sub.length === 1 && sub[0] === 'active-group') {
          const body = (await readJsonBody(req)) as { groupId: string };
          service.setActiveAnnotationGroup(sessionId, body.groupId);
          send(200, { ok: true });
          return;
        }

        if (req.method === 'POST' && sub.length === 3 && sub[0] === 'groups' && sub[2] === 'note') {
          const body = (await readJsonBody(req)) as { note?: string };
          service.setAnnotationGroupNote(sessionId, sub[1], body.note);
          send(200, { ok: true });
          return;
        }

        if (req.method === 'POST' && sub.length === 1 && sub[0] === 'global-note') {
          const body = (await readJsonBody(req)) as { note?: string };
          service.setGlobalNote(sessionId, body.note);
          send(200, { ok: true });
          return;
        }

        if (req.method === 'POST' && sub.length === 1 && sub[0] === 'submit') {
          const result = await service.submit(sessionId);
          send(200, { taskId: result.taskId });
          return;
        }
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
  service.setSelfOrigin({ port: actualPort, token });

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
