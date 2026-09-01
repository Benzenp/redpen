/**
 * Application core (docs/ARCHITECTURE.md §2.1 "CLI first", §3.2).
 *
 * Every use case (open/freeze/annotate/submit/claim/review/accept/cancel)
 * lives here exactly once. The CLI and (future) MCP adapter are both thin
 * callers of this same service — neither re-implements session/task logic.
 */
import type { Page } from 'playwright';
import { BrowserManager } from '../browser/manager.js';
import { SessionRuntime } from '../daemon/session-runtime.js';
import { saveSession, loadSession, listSessions, deleteSession } from './session-store.js';
import { assertLoopbackUrl } from './url-policy.js';
import { SessionNotFoundError, TaskNotFoundError, NoActiveCaptureError } from './errors.js';
import { nextSessionState } from '@redpen/protocol/state-machine';
import { generateSessionId, generateTaskId, generateFrameId } from '@redpen/protocol/ids';
import type { VisualSession, InstructionGroup, Mark } from '@redpen/protocol/schema';
import { writeTaskBundle, readTaskBundle, listTaskIds } from '@redpen/protocol/storage';
import { collectDomIndex, captureAndGround, assembleVisualTask } from '@redpen/grounding';
import { AnnotatorStore } from '@redpen/annotator-core';

export interface OpenSessionOptions {
  url: string;
  workspaceRoot: string;
  viewport?: { width: number; height: number };
}

export class RedpenApplicationService {
  private readonly browser = new BrowserManager();
  private readonly runtime = new SessionRuntime();
  // In-memory annotator stores keyed by sessionId, mirroring the annotating UI's
  // authoring state until submit. Not persisted — a daemon restart loses drafts
  // in progress, matching docs/ARCHITECTURE.md §10's stated recovery behavior.
  private readonly stores = new Map<string, AnnotatorStore>();

  async openSession(opts: OpenSessionOptions): Promise<VisualSession> {
    assertLoopbackUrl(opts.url);
    const now = new Date().toISOString();
    const session: VisualSession = {
      schemaVersion: 1,
      id: generateSessionId(),
      state: 'browsing',
      workspaceRoot: opts.workspaceRoot,
      targetUrl: opts.url,
      createdAt: now,
      updatedAt: now,
    };

    try {
      const page = await this.browser.openPage(session.id, opts.url);
      this.runtime.setPage(session.id, page);
    } catch (err) {
      session.state = 'error';
      session.lastError = { code: 'OPEN_FAILED', message: (err as Error).message };
    }

    await saveSession(session);
    return session;
  }

  async getSession(sessionId: string): Promise<VisualSession> {
    const session = await loadSession(sessionId);
    if (!session) throw new SessionNotFoundError(sessionId);
    return session;
  }

  async listAllSessions(filter?: { workspaceRoot?: string }): Promise<VisualSession[]> {
    return listSessions(filter);
  }

  /** "화면 고정" (docs/ARCHITECTURE.md §4.2): capture screenshot + DOM index at the same moment. */
  async freeze(sessionId: string): Promise<VisualSession> {
    const session = await this.getSession(sessionId);
    const page = this.runtime.getPage(sessionId);
    if (!page) throw new SessionNotFoundError(sessionId);

    const nextState = nextSessionState(session.state, 'freeze');
    const domIndex = await collectDomIndex(page as Page);
    const screenshot = await page.screenshot();
    const viewport = page.viewportSize() ?? { width: 1280, height: 900 };

    this.runtime.setCapture(sessionId, {
      frameId: generateFrameId(),
      screenshot,
      domIndex,
      viewport: { ...viewport, deviceScaleFactor: domIndex.viewport.deviceScaleFactor },
      scroll: domIndex.scroll,
      capturedAt: domIndex.capturedAt,
    });
    this.stores.set(sessionId, new AnnotatorStore());

    session.state = nextState;
    session.updatedAt = new Date().toISOString();
    await saveSession(session);
    return session;
  }

  getAnnotatorStore(sessionId: string): AnnotatorStore {
    const store = this.stores.get(sessionId);
    if (!store) throw new NoActiveCaptureError(sessionId);
    return store;
  }

  /** Submits the active capture's marks/groups as an atomic task bundle. */
  async submit(sessionId: string, globalNote?: string): Promise<{ session: VisualSession; taskId: string }> {
    const session = await this.getSession(sessionId);
    const capture = this.runtime.getCapture(sessionId);
    const store = this.stores.get(sessionId);
    if (!capture || !store) throw new NoActiveCaptureError(sessionId);

    const page = this.runtime.getPage(sessionId);
    const targets = page ? await captureAndGround(page, capture.frameId, store.getMarks()) : [];

    const taskId = generateTaskId();
    const task = assembleVisualTask({
      taskId,
      sessionId,
      workspaceRoot: session.workspaceRoot,
      frame: {
        id: capture.frameId,
        url: session.targetUrl,
        screenshot: 'frames/frame-001/source.png',
        annotated: 'frames/frame-001/annotated.png',
        overlaySvg: 'frames/frame-001/overlay.svg',
        viewport: capture.viewport,
        scroll: capture.scroll,
        capturedAt: capture.capturedAt,
      },
      groups: store.getGroups(),
      marks: store.getMarks(),
      targets,
      globalNote,
    });

    await writeTaskBundle(session.workspaceRoot, task, [
      { relativePath: 'frames/frame-001/source.png', content: capture.screenshot },
      { relativePath: 'frames/frame-001/annotated.png', content: capture.screenshot },
      { relativePath: 'frames/frame-001/overlay.svg', content: '<svg xmlns="http://www.w3.org/2000/svg"/>' },
    ]);

    session.state = nextSessionState(session.state, 'submit');
    session.activeTaskId = taskId;
    session.updatedAt = new Date().toISOString();
    await saveSession(session);

    this.runtime.clearCapture(sessionId);
    this.runtime.notifySubmitted(sessionId, taskId);

    return { session, taskId };
  }

  async waitForSubmission(sessionId: string, timeoutSeconds: number): Promise<{ taskId: string | null; session: VisualSession }> {
    const session = await this.getSession(sessionId);
    if (session.activeTaskId) {
      return { taskId: session.activeTaskId, session };
    }
    const taskId = await this.runtime.waitForSubmission(sessionId, timeoutSeconds * 1000);
    const refreshed = await this.getSession(sessionId);
    return { taskId, session: refreshed };
  }

  async getTask(workspaceRoot: string, taskId: string) {
    const ids = await listTaskIds(workspaceRoot);
    if (!ids.includes(taskId)) throw new TaskNotFoundError(taskId);
    return readTaskBundle(workspaceRoot, taskId);
  }

  async listTasks(workspaceRoot: string) {
    return listTaskIds(workspaceRoot);
  }

  async claim(sessionId: string): Promise<VisualSession> {
    return this.transition(sessionId, 'claim');
  }

  async markReviewReady(sessionId: string): Promise<VisualSession> {
    return this.transition(sessionId, 'implementation-ready');
  }

  async accept(sessionId: string): Promise<VisualSession> {
    return this.transition(sessionId, 'accept');
  }

  async cancel(sessionId: string): Promise<VisualSession> {
    return this.transition(sessionId, 'cancel');
  }

  private async transition(sessionId: string, transition: Parameters<typeof nextSessionState>[1]): Promise<VisualSession> {
    const session = await this.getSession(sessionId);
    session.state = nextSessionState(session.state, transition);
    session.updatedAt = new Date().toISOString();
    await saveSession(session);
    return session;
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.browser.closePage(sessionId);
    this.runtime.remove(sessionId);
    this.stores.delete(sessionId);
    await deleteSession(sessionId);
  }

  async shutdown(): Promise<void> {
    await this.browser.closeAll();
  }
}
