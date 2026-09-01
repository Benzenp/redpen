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
import { AnnotatorStore, renderOverlaySvg, type NewMarkInput } from '@redpen/annotator-core';
import { createRevision } from '@redpen/review';

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
  // Global note text staged by the annotation UI before submit, keyed by
  // sessionId. Mirrors `stores` lifetime exactly (set on freeze, cleared on
  // submit/close) rather than being folded into AnnotatorStore, since it is
  // task-level metadata rather than a group/mark.
  private readonly globalNotes = new Map<string, string | undefined>();
  // Set by daemon/server.ts once the HTTP server is actually listening, so
  // freeze() can point the annotation tab at this daemon's own address.
  // Unset in tests that call the service directly without a daemon (submit
  // still works via captureAndGround; only the actual tab-opening is skipped).
  private selfOrigin: { port: number; token: string } | undefined;

  setSelfOrigin(origin: { port: number; token: string }): void {
    this.selfOrigin = origin;
  }

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

    const transition = session.state === 'review' ? 'annotate-revision' : 'freeze';
    const nextState = nextSessionState(session.state, transition);
    const domIndex = await collectDomIndex(page as Page);
    // Captures the entire scrollable page, not just the currently visible
    // viewport, so the annotation UI shows the whole page at once instead
    // of forcing the user to scroll while marking it up.
    // Grounding at submit time still re-scans the live page's CURRENT
    // viewport (docs/ARCHITECTURE.md §4.3's collector is viewport-scoped
    // by design, and Phase 3's tests assert that scoping), so marks drawn
    // far below the fold ground best when the live page is scrolled back
    // near that position before submit — a known trade-off, not a
    // regression.
    const screenshot = await page.screenshot({ fullPage: true });
    const viewport = page.viewportSize() ?? { width: 1280, height: 900 };
    const fullPageHeight = await page.evaluate(() => document.documentElement.scrollHeight);

    this.runtime.setCapture(sessionId, {
      frameId: generateFrameId(),
      screenshot,
      domIndex,
      viewport: { width: viewport.width, height: fullPageHeight, deviceScaleFactor: domIndex.viewport.deviceScaleFactor },
      scroll: domIndex.scroll,
      capturedAt: domIndex.capturedAt,
    });
    this.stores.set(sessionId, new AnnotatorStore());
    this.globalNotes.delete(sessionId);

    session.state = nextState;
    session.updatedAt = new Date().toISOString();
    await saveSession(session);

    if (this.selfOrigin) {
      const annotatorUrl = `http://127.0.0.1:${this.selfOrigin.port}/annotator/${sessionId}?token=${this.selfOrigin.token}`;
      await this.browser.openAnnotatorTab(sessionId, annotatorUrl);
    }

    return session;
  }

  getAnnotatorStore(sessionId: string): AnnotatorStore {
    const store = this.stores.get(sessionId);
    if (!store) throw new NoActiveCaptureError(sessionId);
    return store;
  }

  /**
   * Snapshot the daemon-side AnnotatorStore + capture metadata as the
   * annotation UI's single source of truth (docs/ARCHITECTURE.md \u00a73.6:
   * the UI never keeps its own canonical mark state \u2014 it renders whatever
   * this returns and posts actions back through the methods below).
   */
  getAnnotatorState(sessionId: string) {
    const store = this.getAnnotatorStore(sessionId);
    const capture = this.runtime.getCapture(sessionId);
    if (!capture) throw new NoActiveCaptureError(sessionId);
    return {
      frameId: capture.frameId,
      viewport: capture.viewport,
      groups: store.getGroups(),
      marks: store.getMarks(),
      activeGroupId: store.getActiveGroupId(),
      globalNote: this.globalNotes.get(sessionId),
      emptyGroups: store.findEmptyGroups(),
      canSubmit: store.canSubmit(),
    };
  }

  getCaptureScreenshot(sessionId: string): Buffer {
    const capture = this.runtime.getCapture(sessionId);
    if (!capture) throw new NoActiveCaptureError(sessionId);
    return capture.screenshot;
  }

  addMark(sessionId: string, input: NewMarkInput) {
    const store = this.getAnnotatorStore(sessionId);
    return store.addMark(input);
  }

  removeMark(sessionId: string, markId: string): void {
    this.getAnnotatorStore(sessionId).removeMark(markId);
  }

  undoAnnotation(sessionId: string): boolean {
    return this.getAnnotatorStore(sessionId).undo();
  }

  redoAnnotation(sessionId: string): boolean {
    return this.getAnnotatorStore(sessionId).redo();
  }

  createAnnotationGroup(sessionId: string) {
    return this.getAnnotatorStore(sessionId).createGroup();
  }

  setActiveAnnotationGroup(sessionId: string, groupId: string): void {
    this.getAnnotatorStore(sessionId).setActiveGroup(groupId);
  }

  setAnnotationGroupNote(sessionId: string, groupId: string, note: string | undefined): void {
    this.getAnnotatorStore(sessionId).setGroupNote(groupId, note);
  }

  setGlobalNote(sessionId: string, note: string | undefined): void {
    this.globalNotes.set(sessionId, note);
  }

  exportAnnotationOverlaySvg(sessionId: string): string {
    const store = this.getAnnotatorStore(sessionId);
    const capture = this.runtime.getCapture(sessionId);
    if (!capture) throw new NoActiveCaptureError(sessionId);
    const groups = store.getGroups();
    const badges = groups.flatMap((g) =>
      store.computeBadgeClusters(g.id).map((cluster) => ({ groupNumber: g.number, color: g.color, cluster })),
    );
    return renderOverlaySvg(capture.viewport, store.getMarks(), groups, badges);
  }

  /**
   * Submits the active capture's marks/groups as an atomic task bundle. If
   * the session already has an \`activeTaskId\` (i.e. this is an "annotate
   * revision" pass from \`review\`), the new bundle is written as an
   * immutable revision that links back to the parent task via
   * \`parentTaskId\` (docs/ARCHITECTURE.md \u00a75, docs/IMPLEMENTATION_PLAN.md
   * Phase 6) \u2014 the parent task's own files are never touched.
   */
  async submit(sessionId: string, globalNote?: string): Promise<{ session: VisualSession; taskId: string }> {
    const session = await this.getSession(sessionId);
    const capture = this.runtime.getCapture(sessionId);
    const store = this.stores.get(sessionId);
    if (!capture || !store) throw new NoActiveCaptureError(sessionId);
    // An explicit --note/globalNote argument always wins; otherwise fall back
    // to whatever the annotation UI staged via setGlobalNote().
    const effectiveGlobalNote = globalNote ?? this.globalNotes.get(sessionId);

    const page = this.runtime.getPage(sessionId);
    const targets = page ? await captureAndGround(page, capture.frameId, store.getMarks()) : [];

    const frame = {
      id: capture.frameId,
      url: session.targetUrl,
      screenshot: 'frames/frame-001/source.png',
      annotated: 'frames/frame-001/annotated.png',
      overlaySvg: 'frames/frame-001/overlay.svg',
      viewport: capture.viewport,
      scroll: capture.scroll,
      capturedAt: capture.capturedAt,
    };

    const parentTaskId = session.activeTaskId;
    const taskId = generateTaskId();
    const task = parentTaskId
      ? createRevision({
          newTaskId: taskId,
          parentTask: await readTaskBundle(session.workspaceRoot, parentTaskId),
          frame,
          groups: store.getGroups(),
          marks: store.getMarks(),
          targets,
          globalNote: effectiveGlobalNote,
        })
      : assembleVisualTask({
          taskId,
          sessionId,
          workspaceRoot: session.workspaceRoot,
          frame,
          groups: store.getGroups(),
          marks: store.getMarks(),
          targets,
          globalNote: effectiveGlobalNote,
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
    this.globalNotes.delete(sessionId);
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
    this.globalNotes.delete(sessionId);
    await deleteSession(sessionId);
  }

  async shutdown(): Promise<void> {
    await this.browser.closeAll();
  }
}
