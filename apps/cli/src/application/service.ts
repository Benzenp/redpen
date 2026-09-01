/**
 * Application core (docs/ARCHITECTURE.md §2.1 "CLI first", §3.2).
 *
 * Every use case (open/freeze/annotate/submit/claim/review/accept/cancel)
 * lives here exactly once. The CLI and (future) MCP adapter are both thin
 * callers of this same service — neither re-implements session/task logic.
 */
import type { Page } from 'playwright';
import { randomUUID } from 'node:crypto';
import { BrowserManager } from '../browser/manager.js';
import { SessionRuntime } from '../daemon/session-runtime.js';
import { saveSession, loadSession, listSessions, deleteSession } from './session-store.js';
import { assertLoopbackUrl } from './url-policy.js';
import { SessionNotFoundError, TaskNotFoundError, NoActiveCaptureError } from './errors.js';
import { nextSessionState } from '@redpen/protocol/state-machine';
import { generateSessionId, generateTaskId, generateFrameId } from '@redpen/protocol/ids';
import type { VisualSession, InstructionGroup, Mark, ReferenceAsset } from '@redpen/protocol/schema';
import { writeTaskBundle, readTaskBundle, listTaskIds } from '@redpen/protocol/storage';
import {
  saveReferenceImage as persistReferenceImage,
  deleteReferenceImage as persistDeleteReferenceImage,
  listReferenceImages as persistListReferenceImages,
  readReferenceImage as persistReadReferenceImage,
  type ReferenceImageMeta,
} from '@redpen/protocol/references';
import { collectDomIndex, captureAndGround, assembleVisualTask } from '@redpen/grounding';
import { AnnotatorStore, renderOverlaySvg, type NewMarkInput } from '@redpen/annotator-core';
import { compositeMarksOntoScreenshot } from '@redpen/annotator-core/composite';
import { createRevision } from '@redpen/review';

export class InvalidReferenceImageError extends Error {
  constructor() {
    super('invalid reference image');
    this.name = 'InvalidReferenceImageError';
  }
}

export class ReferenceImageTooLargeError extends Error {
  constructor() {
    super('reference image exceeds limits');
    this.name = 'ReferenceImageTooLargeError';
  }
}

export class MissingAttachedReferenceError extends Error {
  constructor(referenceId: string) {
    super(`attached reference image is missing: ${referenceId}`);
    this.name = 'MissingAttachedReferenceError';
  }
}

export class AnnotationSubmissionInProgressError extends Error {
  constructor(sessionId: string) {
    super(`annotation submission is already in progress: ${sessionId}`);
    this.name = 'AnnotationSubmissionInProgressError';
  }
}

export class AnnotationGroupNotFoundError extends Error {
  constructor(groupId: string) {
    super(`instruction group does not exist: ${groupId}`);
    this.name = 'AnnotationGroupNotFoundError';
  }
}

export class GroupReferenceLimitError extends Error {
  constructor(groupId: string) {
    super(`instruction group reference limit reached: ${groupId}`);
    this.name = 'GroupReferenceLimitError';
  }
}

const MAX_REFERENCE_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_REFERENCE_IMAGE_DIMENSION = 8192;
const MAX_REFERENCE_IMAGE_PIXELS = 40_000_000;

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
  private selfOrigin: { port: number } | undefined;
  private readonly capabilities = new Map<string, { overlay?: string; annotator?: string }>();
  private readonly referenceMutationTails = new Map<string, Promise<void>>();
  private readonly sessionReferenceIds = new Map<string, Set<string>>();
  private readonly submittingSessions = new Set<string>();
  private readonly initializedReferenceWorkspaces = new Set<string>();

  private assertAnnotationMutable(sessionId: string): void {
    if (this.submittingSessions.has(sessionId)) throw new AnnotationSubmissionInProgressError(sessionId);
  }

  private enqueueReferenceMutation<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.referenceMutationTails.get(sessionId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    const tail = current.then(() => undefined, () => undefined);
    this.referenceMutationTails.set(sessionId, tail);
    return current.finally(() => {
      if (this.referenceMutationTails.get(sessionId) === tail) this.referenceMutationTails.delete(sessionId);
    });
  }

  private trackSessionReference(sessionId: string, referenceId: string): void {
    let owned = this.sessionReferenceIds.get(sessionId);
    if (!owned) {
      owned = new Set();
      this.sessionReferenceIds.set(sessionId, owned);
    }
    owned.add(referenceId);
  }

  private async cleanupSessionReferences(sessionId: string, workspaceRoot: string): Promise<string[]> {
    const owned = this.sessionReferenceIds.get(sessionId);
    if (!owned) return [];
    const failures: string[] = [];
    for (const referenceId of [...owned]) {
      try {
        await persistDeleteReferenceImage(workspaceRoot, referenceId);
        owned.delete(referenceId);
      } catch {
        failures.push(referenceId);
      }
    }
    if (owned.size === 0) this.sessionReferenceIds.delete(sessionId);
    return failures;
  }

  setSelfOrigin(origin: { port: number }): void {
    this.selfOrigin = origin;
  }

  getBrowserCapability(sessionId: string, kind: 'overlay' | 'annotator'): string | undefined {
    return this.capabilities.get(sessionId)?.[kind];
  }

  hasBrowserCapability(sessionId: string, kind: 'overlay' | 'annotator', capability: string | null): boolean {
    const stored = this.getBrowserCapability(sessionId, kind);
    return Boolean(stored) && Boolean(capability) && stored === capability;
  }

  revokeBrowserCapabilities(sessionId: string, kinds: readonly ('overlay' | 'annotator')[] = ['overlay', 'annotator']): void {
    const capabilities = this.capabilities.get(sessionId);
    if (!capabilities) return;
    for (const kind of kinds) delete capabilities[kind];
    if (!capabilities.overlay && !capabilities.annotator) this.capabilities.delete(sessionId);
  }

  async openSession(opts: OpenSessionOptions): Promise<VisualSession> {
    assertLoopbackUrl(opts.url);
    if (!this.initializedReferenceWorkspaces.has(opts.workspaceRoot)) {
      const staleReferences = await persistListReferenceImages(opts.workspaceRoot);
      for (const reference of staleReferences) {
        await persistDeleteReferenceImage(opts.workspaceRoot, reference.id);
      }
      this.initializedReferenceWorkspaces.add(opts.workspaceRoot);
    }
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

    const capabilities = { overlay: randomUUID(), annotator: randomUUID() };
    this.capabilities.set(session.id, capabilities);
    try {
      const page = await this.browser.openPage(
        session.id,
        opts.url,
        this.selfOrigin ? { port: this.selfOrigin.port, token: capabilities.overlay } : undefined,
      );
      this.runtime.setPage(session.id, page);
    } catch (err) {
      session.state = 'error';
      session.lastError = { code: 'OPEN_FAILED', message: (err as Error).message };
      this.revokeBrowserCapabilities(session.id);
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
      const sessionCapabilities = this.capabilities.get(sessionId);
      if (!sessionCapabilities) throw new SessionNotFoundError(sessionId);
      const capability = randomUUID();
      sessionCapabilities.annotator = capability;
      const annotatorUrl = `http://127.0.0.1:${this.selfOrigin.port}/annotator/${sessionId}?token=${capability}`;
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

  async uploadGroupReference(
    sessionId: string,
    groupId: string,
    pngBase64: string,
    meta: { label?: string },
  ): Promise<ReferenceImageMeta> {
    this.assertAnnotationMutable(sessionId);
    return this.enqueueReferenceMutation(sessionId, async () => {
      this.assertAnnotationMutable(sessionId);
      return this.persistAndAttachGroupReference(sessionId, groupId, pngBase64, meta);
    });
  }

  private async persistAndAttachGroupReference(
    sessionId: string,
    groupId: string,
    pngBase64: string,
    meta: { label?: string },
  ): Promise<ReferenceImageMeta> {
    const session = await this.getSession(sessionId);
    const store = this.getAnnotatorStore(sessionId);
    const group = store.getGroups().find((candidate) => candidate.id === groupId);
    if (!group) throw new AnnotationGroupNotFoundError(groupId);
    if (group.referenceIds.length >= 3) throw new GroupReferenceLimitError(groupId);
    const maxEncodedLength = Math.ceil(MAX_REFERENCE_IMAGE_BYTES / 3) * 4;
    if (typeof pngBase64 === 'string' && pngBase64.length > maxEncodedLength) {
      throw new ReferenceImageTooLargeError();
    }
    if (typeof pngBase64 === 'string' && pngBase64.length % 4 === 0) {
      const padding = pngBase64.endsWith('==') ? 2 : pngBase64.endsWith('=') ? 1 : 0;
      const decodedLength = (pngBase64.length / 4) * 3 - padding;
      if (decodedLength > MAX_REFERENCE_IMAGE_BYTES) throw new ReferenceImageTooLargeError();
    }
    if (
      typeof pngBase64 !== 'string' ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(pngBase64)
    ) {
      throw new InvalidReferenceImageError();
    }
    const buffer = Buffer.from(pngBase64, 'base64');
    if (buffer.length > MAX_REFERENCE_IMAGE_BYTES) throw new ReferenceImageTooLargeError();
    if (
      buffer.length < 24 ||
      !buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      buffer.toString('ascii', 12, 16) !== 'IHDR'
    ) {
      throw new InvalidReferenceImageError();
    }
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    if (width === 0 || height === 0 || width > MAX_REFERENCE_IMAGE_DIMENSION || height > MAX_REFERENCE_IMAGE_DIMENSION || width * height > MAX_REFERENCE_IMAGE_PIXELS) {
      throw new ReferenceImageTooLargeError();
    }
    try {
      const { PNG } = await import('pngjs');
      const decoded = PNG.sync.read(buffer);
      if (decoded.width !== width || decoded.height !== height) throw new InvalidReferenceImageError();
    } catch (error) {
      if (error instanceof InvalidReferenceImageError) throw error;
      throw new InvalidReferenceImageError();
    }
    const reference = await persistReferenceImage(session.workspaceRoot, buffer, {
      width,
      height,
      label: meta.label,
    });
    this.trackSessionReference(sessionId, reference.id);
    try {
      const currentGroup = store.getGroups().find((candidate) => candidate.id === groupId);
      if (!currentGroup) throw new AnnotationGroupNotFoundError(groupId);
      if (currentGroup.referenceIds.length >= 3) throw new GroupReferenceLimitError(groupId);
      store.attachReference(groupId, reference.id);
    } catch (error) {
      try {
        await persistDeleteReferenceImage(session.workspaceRoot, reference.id);
        this.sessionReferenceIds.get(sessionId)?.delete(reference.id);
      } catch {
        // Keep the tracked ID and durable index entry for close/shutdown retry.
      }
      throw error;
    }
    return reference;
  }

  detachGroupReference(sessionId: string, groupId: string, referenceId: string): void {
    this.assertAnnotationMutable(sessionId);
    this.getAnnotatorStore(sessionId).detachReference(groupId, referenceId);
  }

  async getReferenceImage(sessionId: string, refId: string): Promise<Buffer> {
    const session = await this.getSession(sessionId);
    return persistReadReferenceImage(session.workspaceRoot, refId);
  }

  addMark(sessionId: string, input: NewMarkInput) {
    this.assertAnnotationMutable(sessionId);
    const store = this.getAnnotatorStore(sessionId);
    return store.addMark(input);
  }

  removeMark(sessionId: string, markId: string): void {
    this.assertAnnotationMutable(sessionId);
    this.getAnnotatorStore(sessionId).removeMark(markId);
  }

  undoAnnotation(sessionId: string): boolean {
    this.assertAnnotationMutable(sessionId);
    return this.getAnnotatorStore(sessionId).undo();
  }

  redoAnnotation(sessionId: string): boolean {
    this.assertAnnotationMutable(sessionId);
    return this.getAnnotatorStore(sessionId).redo();
  }

  createAnnotationGroup(sessionId: string) {
    this.assertAnnotationMutable(sessionId);
    return this.getAnnotatorStore(sessionId).createGroup();
  }

  setActiveAnnotationGroup(sessionId: string, groupId: string): void {
    this.assertAnnotationMutable(sessionId);
    this.getAnnotatorStore(sessionId).setActiveGroup(groupId);
  }

  setAnnotationGroupNote(sessionId: string, groupId: string, note: string | undefined): void {
    this.assertAnnotationMutable(sessionId);
    this.getAnnotatorStore(sessionId).setGroupNote(groupId, note);
  }

  setGlobalNote(sessionId: string, note: string | undefined): void {
    this.assertAnnotationMutable(sessionId);
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
  async submit(sessionId: string, globalNote?: string): Promise<{ session: VisualSession; taskId: string; cleanupWarnings?: string[] }> {
    this.assertAnnotationMutable(sessionId);
    this.submittingSessions.add(sessionId);
    try {
      await (this.referenceMutationTails.get(sessionId) ?? Promise.resolve());
      return await this.submitReady(sessionId, globalNote);
    } finally {
      this.submittingSessions.delete(sessionId);
    }
  }

  private async submitReady(sessionId: string, globalNote?: string): Promise<{ session: VisualSession; taskId: string; cleanupWarnings?: string[] }> {
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
    const referenceIds = [...new Set(store.getGroups().flatMap((group) => group.referenceIds))];
    const referenceMetadata = new Map(
      (await persistListReferenceImages(session.workspaceRoot)).map((reference) => [reference.id, reference]),
    );
    const references: ReferenceAsset[] = referenceIds.map((referenceId) => {
      const reference = referenceMetadata.get(referenceId);
      if (!reference) throw new MissingAttachedReferenceError(referenceId);
      return { ...reference, path: `references/${reference.fileName}` };
    });
    const referenceFiles = await Promise.all(references.map(async (reference) => {
      try {
        return {
          relativePath: reference.path,
          content: await persistReadReferenceImage(session.workspaceRoot, reference.id),
        };
      } catch {
        throw new MissingAttachedReferenceError(reference.id);
      }
    }));
    const task = parentTaskId
      ? createRevision({
          newTaskId: taskId,
          parentTask: await readTaskBundle(session.workspaceRoot, parentTaskId),
          frame,
          groups: store.getGroups(),
          marks: store.getMarks(),
          targets,
          references,
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
          references,
          globalNote: effectiveGlobalNote,
        });

    const annotatedPng = await this.compositeAnnotatedScreenshot(capture.screenshot, capture.viewport.deviceScaleFactor, store.getMarks());
    const overlaySvg = this.exportAnnotationOverlaySvg(sessionId);

    await writeTaskBundle(session.workspaceRoot, task, [
      { relativePath: 'frames/frame-001/source.png', content: capture.screenshot },
      { relativePath: 'frames/frame-001/annotated.png', content: annotatedPng },
      { relativePath: 'frames/frame-001/overlay.svg', content: overlaySvg },
      ...referenceFiles,
    ]);

    session.state = nextSessionState(session.state, 'submit');
    session.activeTaskId = taskId;
    session.updatedAt = new Date().toISOString();
    await saveSession(session);

    this.runtime.clearCapture(sessionId);
    this.stores.delete(sessionId);
    this.globalNotes.delete(sessionId);
    this.runtime.notifySubmitted(sessionId, taskId);
    this.revokeBrowserCapabilities(sessionId, ['annotator']);
    const cleanupWarnings = await this.cleanupSessionReferences(sessionId, session.workspaceRoot);
    return cleanupWarnings.length > 0 ? { session, taskId, cleanupWarnings } : { session, taskId };
  }

  /**
   * Renders `annotated.png` by compositing patch marks onto the raw
   * screenshot. Every other mark stays vector-only in overlay.svg.
   * `compositeMarksOntoScreenshot` operates in
   * device-pixel space; marks are authored in CSS-pixel space, so every
   * rect is scaled by `deviceScaleFactor` first.
   */
  private async compositeAnnotatedScreenshot(
    screenshot: Buffer,
    deviceScaleFactor: number,
    marks: readonly Mark[],
  ): Promise<Buffer> {
    const hasPixelMarks = marks.some((m) => m.type === 'patch');
    if (!hasPixelMarks) return screenshot;

    const scaleRect = (rect: { x: number; y: number; width: number; height: number }) => ({
      x: rect.x * deviceScaleFactor,
      y: rect.y * deviceScaleFactor,
      width: rect.width * deviceScaleFactor,
      height: rect.height * deviceScaleFactor,
    });
    const devicePixelMarks: Mark[] = marks.map((m) => {
      if (m.type === 'patch') return { ...m, bounds: scaleRect(m.bounds), sourceRect: scaleRect(m.sourceRect) };
      return m;
    });

    return compositeMarksOntoScreenshot(screenshot, devicePixelMarks);
  }

  /**
   * Closes only the authoring tab after submission. The target page remains
   * visible while the agent confirms intent and implements the change.
   */
  async closeAnnotatorTab(sessionId: string): Promise<void> {
    await this.browser.closeAnnotatorPage(sessionId).catch(() => {});
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
    const session = await this.getSession(sessionId);
    const nextState = nextSessionState(session.state, 'implementation-ready');
    let page = this.runtime.getPage(sessionId);
    if (page && !page.isClosed()) {
      await this.browser.reloadPage(sessionId);
    } else if (this.selfOrigin) {
      let capabilities = this.capabilities.get(sessionId);
      if (!capabilities) {
        capabilities = {};
        this.capabilities.set(sessionId, capabilities);
      }
      const overlayCapability = capabilities.overlay || randomUUID();
      capabilities.overlay = overlayCapability;
      page = await this.browser.openPage(sessionId, session.targetUrl, {
        port: this.selfOrigin.port,
        token: overlayCapability,
      });
      this.runtime.setPage(sessionId, page);
    }

    session.state = nextState;
    session.updatedAt = new Date().toISOString();
    await saveSession(session);
    return session;
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
    if (session.state === 'done' || session.state === 'cancelled') this.revokeBrowserCapabilities(sessionId);
    return session;
  }

  async closeSession(sessionId: string): Promise<void> {
    this.assertAnnotationMutable(sessionId);
    this.submittingSessions.add(sessionId);
    try {
      await (this.referenceMutationTails.get(sessionId) ?? Promise.resolve());
      const session = await this.getSession(sessionId);
      await this.browser.closePage(sessionId);
      this.runtime.remove(sessionId);
      this.stores.delete(sessionId);
      this.globalNotes.delete(sessionId);
      this.revokeBrowserCapabilities(sessionId);
      const cleanupFailures = await this.cleanupSessionReferences(sessionId, session.workspaceRoot);
      if (cleanupFailures.length > 0) {
        throw new Error(`failed to clean staged references: ${cleanupFailures.join(', ')}`);
      }
      await deleteSession(sessionId);
    } finally {
      this.submittingSessions.delete(sessionId);
    }
  }

  async shutdown(): Promise<void> {
    this.runtime.clear();
    await this.browser.closeAll();
  }
}
