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
import { createHmac, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RedpenApplicationService } from '../application/service.js';
import {
  AnnotationGroupNotFoundError,
  AnnotationSubmissionInProgressError,
  GroupReferenceLimitError,
  InvalidReferenceImageError,
  ReferenceImageTooLargeError,
  MissingAttachedReferenceError,
} from '../application/service.js';
import { SessionNotFoundError, TaskNotFoundError, NoActiveCaptureError } from '../application/errors.js';
import { UnsupportedUrlError } from '../application/url-policy.js';
import { InvalidSessionTransitionError } from '@redpen/protocol/state-machine';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isBundledRuntime = path.basename(__dirname) === 'dist';
const cliRoot = isBundledRuntime ? path.resolve(__dirname, '..') : path.resolve(__dirname, '../..');
const bundledPublicDir = path.join(cliRoot, 'dist/public');
// Source execution uses the annotator assets directly; the packaged bundle
// serves the copied assets from dist/public.
const annotatorPublicDir = isBundledRuntime && existsSync(bundledPublicDir)
  ? bundledPublicDir
  : path.resolve(cliRoot, '../annotator/public');

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
  if (err instanceof SessionNotFoundError || err instanceof TaskNotFoundError || err instanceof AnnotationGroupNotFoundError) return 404;
  if (err instanceof UnsupportedUrlError || err instanceof InvalidSessionTransitionError || err instanceof InvalidJsonBodyError || err instanceof InvalidReferenceImageError || err instanceof MissingAttachedReferenceError) return 400;
  if (err instanceof UnsupportedMediaTypeError) return 415;
  if (err instanceof RequestBodyTooLargeError || err instanceof ReferenceImageTooLargeError) return 413;
  if (err instanceof NoActiveCaptureError || err instanceof GroupReferenceLimitError || err instanceof AnnotationSubmissionInProgressError) return 409;
  return 500;
}

class InvalidJsonBodyError extends Error {
  constructor() {
    super('invalid JSON request body');
  }
}

class UnsupportedMediaTypeError extends Error {
  constructor() {
    super('expected application/json');
  }
}

class RequestBodyTooLargeError extends Error {
  constructor() {
    super('request body exceeds limit');
  }
}

async function readJsonBody(req: import('node:http').IncomingMessage, maxBytes = 1024 * 1024): Promise<unknown> {
  const contentType = req.headers['content-type'];
  if (!contentType || !/^application\/json(?:\s*;|$)/i.test(contentType)) throw new UnsupportedMediaTypeError();
  const contentLength = req.headers['content-length'];
  if (contentLength && !/^\d+$/.test(contentLength)) throw new InvalidJsonBodyError();
  if (contentLength && Number(contentLength) > maxBytes) throw new RequestBodyTooLargeError();
  const chunks: Buffer[] = [];
  let byteCount = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteCount += buffer.length;
    if (byteCount > maxBytes) throw new RequestBodyTooLargeError();
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new InvalidJsonBodyError();
  }
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
        const challenge = url.searchParams.get('challenge');
        if (!challenge || challenge.length > 128) {
          send(400, { error: 'invalid_challenge' });
          return;
        }
        const proof = createHmac('sha256', token).update(challenge).digest('hex');
        send(200, { ok: true, proof });
        return;
      }

      // The bundled annotator JS is static, session-independent code \u2014
      // serving it without auth lets the browser tab load
      // <script src="/session.bundle.js"> as a normal same-origin request
      // (it cannot attach an Authorization header or a query string to a
      // <script> tag's src). It never reveals anything session-specific.
      if (req.method === 'GET' && parts[0] === 'session.bundle.js') {
        const js = await readFile(path.join(annotatorPublicDir, 'session.bundle.js'));
        res.writeHead(200, {
          'Content-Type': STATIC_CONTENT_TYPES['.js'],
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer',
        });
        res.end(js);
        return;
      }

      const isOverlayFreezeRoute = req.method === 'POST' && parts[0] === 'sessions' && parts[1] !== undefined && parts[2] === 'freeze';
      const isOverlayStatusRoute = req.method === 'GET' && parts[0] === 'sessions' && parts[1] !== undefined && !parts[2];
      const isAnnotatorTabRoute = req.method === 'GET' && parts[0] === 'annotator' && parts[1] !== undefined && !parts[2];
      const isAnnotatorApiRoute = parts[0] === 'api' && parts[1] === 'sessions' && parts[2] !== undefined && parts[3] === 'annotator';
      const browserSessionId = isOverlayFreezeRoute || isOverlayStatusRoute
        ? parts[1]
        : isAnnotatorTabRoute
          ? parts[1]
          : isAnnotatorApiRoute
            ? parts[2]
            : undefined;
      const auth = req.headers.authorization ?? '';
      const queryToken = url.searchParams.get('token');
      const headerCapability = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : null;
      const masterAuthorized = auth === `Bearer ${token}`;
      const authorized = masterAuthorized || (browserSessionId
        ? service.hasBrowserCapability(
            browserSessionId,
            isOverlayFreezeRoute || isOverlayStatusRoute ? 'overlay' : 'annotator',
            queryToken ?? headerCapability,
          )
        : false);
      if (browserSessionId) {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Referrer-Policy', 'no-referrer');
      }
      if (isOverlayFreezeRoute || isOverlayStatusRoute) {
        // Simple cross-origin GET/POST with no custom headers/body (no CORS
        // preflight is sent for this shape), so only the response-readable
        // header is needed, not full OPTIONS handling.
        res.setHeader('Access-Control-Allow-Origin', '*');
      }
      if (!authorized) {
        send(401, { error: 'unauthorized' });
        return;
      }

      if (req.method === 'POST' && parts[0] === 'shutdown' && !parts[1]) {
        send(202, { ok: true });
        setImmediate(() => server.emit('redpenShutdownRequested'));
        return;
      }

      if (req.method === 'GET' && parts[0] === 'annotator' && parts[1]) {
        const html = await readFile(path.join(annotatorPublicDir, 'session.html'), 'utf8');
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer',
        });
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
        void service.closeAnnotatorTab(parts[1]);
        return;
      }

      if (req.method === 'GET' && parts[0] === 'sessions' && parts[1] && parts[2] === 'wait') {
        const timeoutSeconds = Number(url.searchParams.get('timeout') ?? '600');
        if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0 || timeoutSeconds > 600) {
          throw new InvalidJsonBodyError();
        }
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

        if (req.method === 'POST' && sub.length === 3 && sub[0] === 'groups' && sub[1] && sub[2] === 'references') {
          const body = (await readJsonBody(req, 12 * 1024 * 1024)) as { pngBase64: string; label?: string };
          const reference = await service.uploadGroupReference(sessionId, sub[1], body.pngBase64, { label: body.label });
          send(200, { reference });
          return;
        }

        if (req.method === 'GET' && sub.length === 2 && sub[0] === 'references') {
          const image = await service.getReferenceImage(sessionId, sub[1]);
          res.writeHead(200, {
            'Content-Type': 'image/png',
            'Cache-Control': 'no-store',
            'Referrer-Policy': 'no-referrer',
          });
          res.end(image);
          return;
        }

        if (req.method === 'DELETE' && sub.length === 4 && sub[0] === 'groups' && sub[1] && sub[2] === 'references' && sub[3]) {
          service.detachGroupReference(sessionId, sub[1], sub[3]);
          send(200, { ok: true });
          return;
        }

        if (req.method === 'GET' && sub.length === 1 && sub[0] === 'screenshot') {
          const screenshot = service.getCaptureScreenshot(sessionId);
          res.writeHead(200, {
            'Content-Type': 'image/png',
            'Cache-Control': 'no-store',
            'Referrer-Policy': 'no-referrer',
          });
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
          send(200, { taskId: result.taskId, cleanupWarnings: result.cleanupWarnings });
          // Closing the annotation tab MUST happen after the response above
          // has actually been flushed to the client, not before/during: the
          // in-page `app.submit()` fetch is running on this exact tab, and
          // closing it out from under an in-flight response body read hangs
          // that promise forever (session.html's success overlay/UI status
          // never appears). `res.end()` (inside `send`) queues the write;
          // deferring to the next macrotask via `setTimeout` gives the
          // socket a beat to actually deliver it before the page is torn
          // down.
          setTimeout(() => {
            void service.closeAnnotatorTab(sessionId);
          }, 300);
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
      const status = errorToHttpStatus(err);
      send(status, err instanceof MissingAttachedReferenceError
        ? { error: 'missing_attached_reference', message: err.message }
        : status === 500 ? { error: 'internal_error' } : { error: 'bad_request' });
    }
  });

  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  service.setSelfOrigin({ port: actualPort });

  return {
    server,
    port: actualPort,
    token,
    service,
    close: async () => {
      const serverClosed = new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      const forceCloseTimer = setTimeout(() => server.closeAllConnections(), 2_000);
      try {
        const results = await Promise.allSettled([service.shutdown(), serverClosed]);
        const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
        if (failure) throw failure.reason;
      } finally {
        clearTimeout(forceCloseTimer);
        server.closeAllConnections();
      }
    },
  };
}
