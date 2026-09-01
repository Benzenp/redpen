/**
 * Real session-connected annotation UI client (docs/ARCHITECTURE.md §3.6,
 * §4.2/§4.4).
 *
 * Unlike `client.ts` (the local-only demo used by e2e-check.ts), this client
 * treats the daemon's AnnotatorStore as the single source of truth: every
 * user action (draw a mark, create a group, undo, set a note) is POSTed to
 * the daemon immediately, and the canvas re-renders from the daemon's
 * response rather than keeping an authoritative local copy. This is what
 * `redpen open` + freeze actually opens as a live tab.
 */
import type { Mark, InstructionGroup } from '@redpen/protocol/schema';
import { cssRectToNormalized } from '@redpen/protocol/geometry';

export type ToolName = 'pen' | 'arrow' | 'line' | 'rectangle' | 'ellipse' | 'text' | 'mask' | 'select' | 'erase' | 'patch';

const ERASE_HIT_RADIUS_PX = 10;

interface AnnotatorState {
  frameId: string;
  viewport: { width: number; height: number };
  groups: InstructionGroup[];
  marks: Mark[];
  activeGroupId: string;
  globalNote?: string;
  emptyGroups: Array<{ groupId: string; number: number }>;
  canSubmit: boolean;
}

interface ApiClientOptions {
  sessionId: string;
  token: string;
}

/** Thin fetch wrapper for the daemon's /api/sessions/:id/annotator/* routes. */
class AnnotatorApiClient {
  constructor(private readonly opts: ApiClientOptions) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`/api/sessions/${this.opts.sessionId}/annotator${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.opts.token}` },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.message ?? `annotator API request failed: ${method} ${path} (${res.status})`);
    }
    return res.json() as Promise<T>;
  }

  getState(): Promise<AnnotatorState> {
    return this.request('GET', '');
  }
  addGroupReference(groupId: string, pngBase64: string, label?: string): Promise<{ reference: ReferenceImageMeta }> {
    return this.request('POST', `/groups/${groupId}/references`, { pngBase64, label });
  }
  removeGroupReference(groupId: string, referenceId: string): Promise<void> {
    return this.request('DELETE', `/groups/${groupId}/references/${referenceId}`);
  }
  /**
   * Fetches a reference image's raw bytes with the same Authorization
   * header every other call uses (unlike the screenshot <img> src, this is
   * driven from JS, not a bare <img>/navigation request, so there is no
   * need for the daemon's query-token exception here).
   */
  async getReferenceImageBlob(refId: string): Promise<Blob> {
    const res = await fetch(`/api/sessions/${this.opts.sessionId}/annotator/references/${refId}`, {
      headers: { Authorization: `Bearer ${this.opts.token}` },
    });
    if (!res.ok) throw new Error(`failed to load reference image ${refId} (${res.status})`);
    return res.blob();
  }
  addMark(mark: Omit<Mark, 'id' | 'groupId'>): Promise<{ mark: Mark }> {
    return this.request('POST', '/marks', mark);
  }
  removeMark(markId: string): Promise<void> {
    return this.request('DELETE', `/marks/${markId}`);
  }
  undo(): Promise<void> {
    return this.request('POST', '/undo');
  }
  redo(): Promise<void> {
    return this.request('POST', '/redo');
  }
  createGroup(): Promise<{ group: InstructionGroup }> {
    return this.request('POST', '/groups');
  }
  setActiveGroup(groupId: string): Promise<void> {
    return this.request('POST', '/active-group', { groupId });
  }
  setGroupNote(groupId: string, note: string | undefined): Promise<void> {
    return this.request('POST', `/groups/${groupId}/note`, { note });
  }
  setGlobalNote(note: string | undefined): Promise<void> {
    return this.request('POST', '/global-note', { note });
  }
  submit(): Promise<{ taskId: string; cleanupWarnings?: string[] }> {
    return this.request('POST', '/submit');
  }
}

export interface ReferenceImageMeta {
  id: string;
  fileName: string;
  path: string;
  width: number;
  height: number;
  createdAt: string;
  label?: string;
}

export interface SessionAnnotatorAppOptions {
  canvas: HTMLCanvasElement;
  screenshotImage: HTMLImageElement;
  sessionId: string;
  token: string;
  locale?: 'en' | 'ko';
}

/**
 * Owns pan/zoom, pointer-driven drawing, and canvas rendering. State is
 * always the last value fetched from/returned by the daemon API — there is
 * no local optimistic mutation of groups/marks, so a page reload always
 * shows exactly what the daemon has.
 */
export class SessionAnnotatorApp {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly api: AnnotatorApiClient;
  private mutationTail: Promise<void> = Promise.resolve();
  private mutationFailureCount = 0;
  private loaded = false;
  private submissionPending = false;
  tool: ToolName = 'pen';
  state: AnnotatorState | null = null;
  /**
   * Called after every server round-trip that can change groups/marks —
   * including ones triggered by canvas pointer drawing, not just sidebar
   * button clicks — so the host page can re-render sidebar-only UI (group
   * cards, the submit button's disabled state) without polling.
   */
  onStateChange: (() => void) | null = null;

  // Pan/zoom: `scale` maps canvas pixels -> screenshot CSS pixels is 1/scale.
  private scale = 1;
  private panX = 0;
  private panY = 0;

  private isPanning = false;
  private panStart = { x: 0, y: 0 };
  private panOrigin = { x: 0, y: 0 };

  private drawing: { points: { x: number; y: number }[] } | null = null;
  private dragStart: { x: number; y: number } | null = null;

  /**
   * Patch tool is a two-step gesture: drag once to select the source
   * rectangle to copy, then drag again to place it at a destination \u2014
   * only the second drag commits a `patch` mark. `patchSourceRect` holds
   * the first drag's result while awaiting the second.
   */
  private patchSourceRect: { x: number; y: number; width: number; height: number } | null = null;
  private textEditor: HTMLTextAreaElement | null = null;
  private locale: 'en' | 'ko';

  constructor(private readonly opts: SessionAnnotatorAppOptions) {
    this.locale = opts.locale ?? 'en';
    const ctx = opts.canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context unavailable');
    this.ctx = ctx;
    this.api = new AnnotatorApiClient({ sessionId: opts.sessionId, token: opts.token });
    this.attachPointerHandlers();
    this.attachWheelZoom();
    this.attachKeyboardShortcuts();
    this.attachClipboardPaste();
  }

  setLocale(locale: 'en' | 'ko'): void {
    this.locale = locale;
  }

  private message(english: string, korean: string): string {
    return this.locale === 'ko' ? korean : english;
  }

  private attachClipboardPaste(): void {
    document.addEventListener('paste', (event: ClipboardEvent) => {
      if (!this.isInteractionReady() || this.textEditor || document.activeElement?.tagName === 'TEXTAREA') return;
      const items = event.clipboardData?.items;
      const item = items ? Array.from(items).find((i) => i.type.startsWith('image/')) : undefined;
      if (!item) return;
      const blob = item.getAsFile();
      if (!blob) return;
      event.preventDefault();
      void this.addGroupReference(this.state!.activeGroupId, blob).catch(() => {});
    });
  }

  addGroupReference(groupId: string, blob: Blob): Promise<ReferenceImageMeta> {
    if (!this.state?.groups.some((group) => group.id === groupId)) {
      return this.rejectRequest(new Error(this.message('Instruction group not found.', '지시 그룹을 찾을 수 없습니다.')));
    }
    if ((this.state.groups.find((group) => group.id === groupId)?.referenceIds.length ?? 0) >= 3) {
      return this.rejectRequest(new Error(this.message(
        'Each instruction group can have up to three reference images.',
        '각 지시 그룹에는 레퍼런스 이미지를 최대 3개까지 첨부할 수 있습니다.',
      )));
    }
    return this.enqueueMutation(async () => {
      const pngBase64 = await blobToBase64(blob);
      const { reference } = await this.api.addGroupReference(groupId, pngBase64);
      await this.refresh();
      return reference;
    });
  }

  removeGroupReference(groupId: string, referenceId: string): Promise<void> {
    return this.enqueueMutation(async () => {
      await this.api.removeGroupReference(groupId, referenceId);
      await this.refresh();
    });
  }

  getReferenceImageBlob(referenceId: string): Promise<Blob> {
    if (!this.loaded) return this.rejectUnavailable();
    return this.handleRequest(this.api.getReferenceImageBlob(referenceId));
  }

  /** Ctrl/Cmd+Z = undo, Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y = redo. */
  private attachKeyboardShortcuts(): void {
    window.addEventListener('keydown', (event) => {
      if (!this.isInteractionReady()) return;
      const target = event.target as HTMLElement | null;
      if (
        this.textEditor ||
        target?.isContentEditable ||
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA'
      ) {
        return;
      }
      const meta = event.ctrlKey || event.metaKey;
      if (!meta) return;
      const key = event.key.toLowerCase();
      if (key === 'z' && event.shiftKey) {
        event.preventDefault();
        void this.redo();
      } else if (key === 'z') {
        event.preventDefault();
        void this.undo();
      } else if (key === 'y') {
        event.preventDefault();
        void this.redo();
      }
    });
  }

  load(): Promise<void> {
    return this.handleRequest(this.api.getState().then((state) => {
      this.state = state;
      this.loaded = true;
      this.fitToViewport();
      this.render();
    }));
  }

  private fitToViewport(): void {
    if (!this.state) return;
    const canvas = this.opts.canvas;
    const availableWidth = canvas.clientWidth || this.state.viewport.width;
    const availableHeight = canvas.clientHeight || this.state.viewport.height;
    this.scale = Math.min(availableWidth / this.state.viewport.width, availableHeight / this.state.viewport.height, 1);
    this.panX = 0;
    this.panY = 0;
  }

  setTool(tool: ToolName): void {
    if (!this.isInteractionReady()) return;
    this.cancelTextEditor();
    this.tool = tool;
  }

  private toScreenshotSpace(canvasX: number, canvasY: number): { x: number; y: number } {
    return { x: (canvasX - this.panX) / this.scale, y: (canvasY - this.panY) / this.scale };
  }

  private isInsideScreenshot(point: { x: number; y: number }): boolean {
    return Boolean(
      this.state &&
        point.x >= 0 &&
        point.y >= 0 &&
        point.x <= this.state.viewport.width &&
        point.y <= this.state.viewport.height,
    );
  }

  private clampToScreenshot(point: { x: number; y: number }): { x: number; y: number } {
    if (!this.state) return point;
    return {
      x: Math.max(0, Math.min(this.state.viewport.width, point.x)),
      y: Math.max(0, Math.min(this.state.viewport.height, point.y)),
    };
  }

  private canvasPoint(event: PointerEvent | WheelEvent): { x: number; y: number } {
    const rect = this.opts.canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * (this.opts.canvas.width / rect.width),
      y: (event.clientY - rect.top) * (this.opts.canvas.height / rect.height),
    };
  }

  private normalizeBounds(bounds: { x: number; y: number; width: number; height: number }) {
    if (!this.state) return bounds;
    return cssRectToNormalized(bounds, this.state.viewport);
  }

  private screenshotSourceRect(bounds: { x: number; y: number; width: number; height: number }) {
    if (!this.state) return bounds;
    const scaleX = this.opts.screenshotImage.naturalWidth / this.state.viewport.width;
    const scaleY = this.opts.screenshotImage.naturalHeight / this.state.viewport.height;
    return {
      x: bounds.x * scaleX,
      y: bounds.y * scaleY,
      width: bounds.width * scaleX,
      height: bounds.height * scaleY,
    };
  }

  private attachWheelZoom(): void {
    this.opts.canvas.addEventListener('wheel', (event) => {
      if (!this.isInteractionReady()) return;
      if (this.textEditor) this.textEditor.blur();
      event.preventDefault();
      const { x: canvasX, y: canvasY } = this.canvasPoint(event);
      const before = this.toScreenshotSpace(canvasX, canvasY);

      const zoomFactor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
      this.scale = Math.min(Math.max(this.scale * zoomFactor, 0.1), 8);

      // Keep the point under the cursor stationary while zooming.
      this.panX = canvasX - before.x * this.scale;
      this.panY = canvasY - before.y * this.scale;
      this.render();
    });
  }

  private attachPointerHandlers(): void {
    const canvas = this.opts.canvas;

    canvas.addEventListener('pointerdown', (event) => {
      if (!this.isInteractionReady()) return;
      const canvasPoint = this.canvasPoint(event);

      if (event.button === 1 || event.shiftKey) {
        this.isPanning = true;
        canvas.setPointerCapture(event.pointerId);
        this.panStart = canvasPoint;
        this.panOrigin = { x: this.panX, y: this.panY };
        return;
      }

      const point = this.toScreenshotSpace(canvasPoint.x, canvasPoint.y);
      if (!this.isInsideScreenshot(point)) return;
      canvas.setPointerCapture(event.pointerId);
      if (this.tool === 'erase') {
        const hit = this.findMarkNear(point);
        if (hit) void this.removeMark(hit.id);
        return;
      } else if (this.tool === 'pen') {
        this.drawing = { points: [point] };
      } else if (this.tool === 'rectangle' || this.tool === 'ellipse' || this.tool === 'mask' || this.tool === 'arrow' || this.tool === 'line' || this.tool === 'text') {
        this.dragStart = point;
      } else if (this.tool === 'patch') {
        // First drag on this tool selects the crop source; a second drag
        // (handled below) places it. Starting a fresh drag while a source
        // is already pending restarts the gesture from the new point.
        this.dragStart = point;
      }
    });

    canvas.addEventListener('pointermove', (event) => {
      if (!this.isInteractionReady()) return;
      const canvasPoint = this.canvasPoint(event);

      if (this.isPanning) {
        this.panX = this.panOrigin.x + (canvasPoint.x - this.panStart.x);
        this.panY = this.panOrigin.y + (canvasPoint.y - this.panStart.y);
        this.render();
        return;
      }

      const point = this.clampToScreenshot(this.toScreenshotSpace(canvasPoint.x, canvasPoint.y));
      if (this.tool === 'pen' && this.drawing) {
        this.drawing.points.push(point);
        this.render();
        this.renderLivePreviewFreehand();
      } else if (this.dragStart && (this.tool === 'rectangle' || this.tool === 'ellipse' || this.tool === 'mask' || this.tool === 'arrow' || this.tool === 'line' || this.tool === 'text')) {
        this.render();
        this.renderLivePreviewDrag(this.dragStart, point);
      } else if (this.dragStart && this.tool === 'patch' && !this.patchSourceRect) {
        // Dragging out the source-selection rectangle (step 1).
        this.render();
        this.renderLivePreviewDrag(this.dragStart, point);
      } else if (this.dragStart && this.tool === 'patch' && this.patchSourceRect) {
        // Dragging out the destination (step 2): show the actual cropped
        // pixels following the cursor, not just an outline, so placement is
        // a real "cut and move" preview rather than an abstract box.
        this.render();
        this.renderLivePreviewPatchPlacement(this.dragStart, point);
      }
    });

    canvas.addEventListener('pointerup', (event) => {
      if (!this.isInteractionReady()) return;
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      if (this.isPanning) {
        this.isPanning = false;
        return;
      }

      const canvasPoint = this.canvasPoint(event);
      const point = this.clampToScreenshot(this.toScreenshotSpace(canvasPoint.x, canvasPoint.y));

      if (this.tool === 'pen' && this.drawing) {
        const points = this.drawing.points;
        this.drawing = null;
        if (points.length >= 2) {
          const bounds = boundsOfPoints(points);
          void this.commitAddMark({ type: 'freehand', frameId: this.state!.frameId, points, bounds, normalizedBounds: this.normalizeBounds(bounds) } as Omit<Mark, 'id' | 'groupId'>);
        }
        return;
      }

      if (this.dragStart) {
        const start = this.dragStart;
        this.dragStart = null;
        const bounds = {
          x: Math.min(start.x, point.x),
          y: Math.min(start.y, point.y),
          width: Math.abs(point.x - start.x),
          height: Math.abs(point.y - start.y),
        };

        if (this.tool === 'patch' && !this.patchSourceRect) {
          // Step 1 finished: remember the source rect and wait for the
          // destination drag. Zero-size drags cancel the gesture.
          if (bounds.width >= 2 || bounds.height >= 2) this.patchSourceRect = bounds;
          this.render();
          return;
        }
        if (this.tool === 'patch' && this.patchSourceRect) {
          const sourceRect = this.patchSourceRect;
          this.patchSourceRect = null;
          if (bounds.width < 2 && bounds.height < 2) {
            this.render();
            return;
          }
          void this.commitAddMark({ type: 'patch', frameId: this.state!.frameId, sourceRect, bounds, normalizedBounds: this.normalizeBounds(bounds) } as Omit<Mark, 'id' | 'groupId'>);
          return;
        }
        if (bounds.width < 2 && bounds.height < 2) {
          this.render();
          return;
        }
        if (this.tool === 'arrow') {
          void this.commitAddMark({ type: 'arrow', frameId: this.state!.frameId, from: start, to: point, bounds, normalizedBounds: this.normalizeBounds(bounds) } as Omit<Mark, 'id' | 'groupId'>);
        } else if (this.tool === 'line') {
          void this.commitAddMark({ type: 'line', frameId: this.state!.frameId, from: start, to: point, bounds, normalizedBounds: this.normalizeBounds(bounds) } as Omit<Mark, 'id' | 'groupId'>);
        } else if (this.tool === 'text') {
          this.openTextEditor(bounds);
        } else if (this.tool === 'rectangle' || this.tool === 'ellipse' || this.tool === 'mask') {
          void this.commitAddMark({ type: this.tool, frameId: this.state!.frameId, bounds, normalizedBounds: this.normalizeBounds(bounds) } as Omit<Mark, 'id' | 'groupId'>);
        }
      }
    });

    canvas.addEventListener('pointercancel', (event) => {
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      this.isPanning = false;
      this.drawing = null;
      this.dragStart = null;
      this.render();
    });
  }

  /** Whether the patch tool is currently waiting for its destination drag (source already picked). */
  isAwaitingPatchDestination(): boolean {
    return this.patchSourceRect !== null;
  }

  /** Cancels an in-progress two-step patch gesture (e.g. tool switched away mid-gesture). */
  cancelPendingPatch(): void {
    this.patchSourceRect = null;
    this.dragStart = null;
    this.render();
  }

  private openTextEditor(dragBounds: { x: number; y: number; width: number; height: number }): void {
    if (!this.state) return;
    const bounds = {
      x: dragBounds.x,
      y: dragBounds.y,
      width: Math.min(Math.max(80, dragBounds.width), this.state.viewport.width - dragBounds.x),
      height: Math.min(Math.max(36, dragBounds.height), this.state.viewport.height - dragBounds.y),
    };
    if (bounds.width < 2 || bounds.height < 2) {
      this.render();
      return;
    }
    const canvas = this.opts.canvas;
    const parent = canvas.parentElement;
    if (!parent) return;
    const canvasRect = canvas.getBoundingClientRect();
    const editor = document.createElement('textarea');
    editor.className = 'canvas-text-editor';
    editor.style.left = `${((bounds.x * this.scale + this.panX) / canvas.width) * canvasRect.width}px`;
    editor.style.top = `${((bounds.y * this.scale + this.panY) / canvas.height) * canvasRect.height}px`;
    editor.style.width = `${(bounds.width * this.scale / canvas.width) * canvasRect.width}px`;
    editor.style.height = `${(bounds.height * this.scale / canvas.height) * canvasRect.height}px`;
    editor.style.color = this.activeColor();
    editor.style.fontSize = `${14 * this.scale * (canvasRect.width / canvas.width)}px`;
    editor.style.lineHeight = '1.25';
    parent.appendChild(editor);
    this.textEditor = editor;

    let settled = false;
    const finish = (commit: boolean) => {
      if (settled) return;
      settled = true;
      const text = editor.value.trim();
      editor.remove();
      this.textEditor = null;
      if (commit && text) {
        void this.commitAddMark({
          type: 'text',
          frameId: this.state!.frameId,
          anchor: { x: bounds.x, y: bounds.y },
          text,
          bounds,
          normalizedBounds: this.normalizeBounds(bounds),
        } as Omit<Mark, 'id' | 'groupId'>);
      } else {
        this.render();
      }
    };
    editor.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        finish(false);
      } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        finish(true);
      }
    });
    editor.addEventListener('blur', () => finish(true));
    editor.focus();
  }

  private cancelTextEditor(): void {
    if (!this.textEditor) return;
    this.textEditor.remove();
    this.textEditor = null;
  }

  /**
   * Finds the topmost (most-recently-added) mark whose bounds contain
   * `point`, expanded by a small tolerance so thin freehand/arrow strokes
   * are still easy to click on with the erase tool.
   */
  private findMarkNear(point: { x: number; y: number }): Mark | null {
    if (!this.state) return null;
    const tolerance = ERASE_HIT_RADIUS_PX / this.scale;
    for (let i = this.state.marks.length - 1; i >= 0; i--) {
      const mark = this.state.marks[i];
      if (mark.type === 'line' || mark.type === 'arrow') {
        if (pointToSegmentDistance(point, mark.from, mark.to) <= tolerance) return mark;
        continue;
      }
      if (mark.type === 'freehand') {
        if (mark.points.length === 1) {
          if (Math.hypot(point.x - mark.points[0].x, point.y - mark.points[0].y) <= tolerance) return mark;
        } else if (
          mark.points.some((current, index) =>
            index > 0 && pointToSegmentDistance(point, mark.points[index - 1], current) <= tolerance
          )
        ) {
          return mark;
        }
        continue;
      }
      const b = mark.bounds;
      if (
        point.x >= b.x - tolerance &&
        point.x <= b.x + b.width + tolerance &&
        point.y >= b.y - tolerance &&
        point.y <= b.y + b.height + tolerance
      ) {
        return mark;
      }
    }
    return null;
  }

  private commitAddMark(mark: Omit<Mark, 'id' | 'groupId'>): Promise<void> {
    return this.enqueueMutation(async () => {
      await this.api.addMark(mark);
      await this.refresh();
    });
  }

  removeMark(markId: string): Promise<void> {
    return this.enqueueMutation(async () => {
      await this.api.removeMark(markId);
      await this.refresh();
    });
  }

  undo(): Promise<void> {
    return this.enqueueMutation(async () => {
      await this.api.undo();
      await this.refresh();
    });
  }

  redo(): Promise<void> {
    return this.enqueueMutation(async () => {
      await this.api.redo();
      await this.refresh();
    });
  }

  createGroup(): Promise<void> {
    return this.enqueueMutation(async () => {
      await this.api.createGroup();
      await this.refresh();
    });
  }

  setActiveGroup(groupId: string): Promise<void> {
    return this.enqueueMutation(async () => {
      await this.api.setActiveGroup(groupId);
      await this.refresh();
    });
  }

  setGroupNote(groupId: string, note: string): Promise<void> {
    return this.enqueueMutation(async () => {
      await this.api.setGroupNote(groupId, note || undefined);
      await this.refresh();
    });
  }

  setGlobalNote(note: string): Promise<void> {
    return this.enqueueMutation(async () => {
      await this.api.setGlobalNote(note || undefined);
      await this.refresh();
    });
  }

  submit(): Promise<{ taskId: string; cleanupWarnings?: string[] }> {
    if (!this.loaded) return this.rejectUnavailable();
    if (this.submissionPending) {
      return this.rejectRequest(new Error(this.message('Submission is already in progress.', '제출이 이미 진행 중입니다.')));
    }

    this.submissionPending = true;
    this.setStatus(this.message('Submitting...', '제출 중...'));
    const submission = this.mutationTail.then(async () => {
      if (this.mutationFailureCount > 0) {
        throw new Error(this.message(
          'Some changes could not be saved. Reload the page and try again.',
          '저장하지 못한 변경이 있어 제출할 수 없습니다. 페이지를 새로고침한 뒤 다시 시도하세요.',
        ));
      }
      return this.api.submit();
    });
    submission.then(
      () => { this.submissionPending = false; },
      () => { this.submissionPending = false; },
    );
    return this.handleRequest(submission);
  }

  private isInteractionReady(): boolean {
    return this.loaded && this.state !== null && !this.submissionPending;
  }

  private enqueueMutation<T>(mutation: () => Promise<T>): Promise<T> {
    if (!this.isInteractionReady()) return this.rejectUnavailable();

    const operation = this.mutationTail.then(mutation);
    this.mutationTail = operation.then(
      () => undefined,
      (error) => {
        this.mutationFailureCount++;
        this.reportError(error);
      },
    );
    return operation;
  }

  private handleRequest<T>(request: Promise<T>): Promise<T> {
    request.catch((error) => this.reportError(error));
    return request;
  }

  private rejectUnavailable<T>(): Promise<T> {
    return this.rejectRequest(new Error(this.submissionPending
      ? this.message('Changes are disabled while submitting.', '제출이 진행 중인 동안에는 변경할 수 없습니다.')
      : this.message('Wait for the session to load, then try again.', '세션을 불러온 뒤에 다시 시도하세요.')));
  }

  private rejectRequest<T>(error: Error): Promise<T> {
    const rejection = Promise.reject<T>(error);
    rejection.catch((reason) => this.reportError(reason));
    return rejection;
  }

  private reportError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.setStatus(this.message(`Error: ${message} Try again.`, `오류: ${message} 다시 시도하세요.`), true);
  }

  private setStatus(message: string, isError = false): void {
    const status = document.getElementById('submit-status');
    if (!status) return;
    status.textContent = message;
    status.className = isError ? 'error' : '';
  }

  private async refresh(): Promise<void> {
    this.state = await this.api.getState();
    this.render();
    this.onStateChange?.();
  }

  private renderLivePreviewFreehand(): void {
    if (!this.drawing) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(this.panX, this.panY);
    ctx.scale(this.scale, this.scale);
    ctx.strokeStyle = this.activeColor();
    ctx.lineWidth = 2 / this.scale;
    ctx.beginPath();
    ctx.moveTo(this.drawing.points[0].x, this.drawing.points[0].y);
    for (const p of this.drawing.points.slice(1)) ctx.lineTo(p.x, p.y);
    ctx.stroke();
    ctx.restore();
  }

  private drawArrow(start: { x: number; y: number }, end: { x: number; y: number }): void {
    const ctx = this.ctx;
    const angle = Math.atan2(end.y - start.y, end.x - start.x);
    const headLength = 12 / this.scale;
    const headSpread = Math.PI / 7;

    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(end.x, end.y);
    ctx.lineTo(
      end.x - headLength * Math.cos(angle - headSpread),
      end.y - headLength * Math.sin(angle - headSpread),
    );
    ctx.lineTo(
      end.x - headLength * Math.cos(angle + headSpread),
      end.y - headLength * Math.sin(angle + headSpread),
    );
    ctx.closePath();
    ctx.fill();
  }

  private drawPatchIndicator(
    source: { x: number; y: number; width: number; height: number },
    destination: { x: number; y: number; width: number; height: number },
    color: string,
  ): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 2 / this.scale;
    ctx.setLineDash([4 / this.scale, 3 / this.scale]);
    ctx.strokeRect(source.x, source.y, source.width, source.height);
    ctx.setLineDash([]);
    this.drawArrow(
      { x: source.x + source.width / 2, y: source.y + source.height / 2 },
      { x: destination.x + destination.width / 2, y: destination.y + destination.height / 2 },
    );
    ctx.restore();
  }

  private renderLivePreviewDrag(start: { x: number; y: number }, end: { x: number; y: number }): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(this.panX, this.panY);
    ctx.scale(this.scale, this.scale);
    ctx.strokeStyle = this.activeColor();
    ctx.fillStyle = this.activeColor();
    ctx.lineWidth = 2 / this.scale;
    if (this.tool === 'arrow') {
      this.drawArrow(start, end);
    } else if (this.tool === 'line') {
      ctx.beginPath();
      ctx.moveTo(start.x, start.y);
      ctx.lineTo(end.x, end.y);
      ctx.stroke();
    } else {
      const x = Math.min(start.x, end.x);
      const y = Math.min(start.y, end.y);
      const w = Math.abs(end.x - start.x);
      const h = Math.abs(end.y - start.y);
      if (this.tool === 'ellipse') {
        ctx.beginPath();
        ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        ctx.strokeRect(x, y, w, h);
      }
    }
    ctx.restore();
  }

  /**
   * Draws the crop-source screenshot pixels following the destination drag
   * so the patch tool previews an actual "cut and move" \u2014 not just an
   * outline \u2014 before the mark is committed.
   */
  private renderLivePreviewPatchPlacement(destStart: { x: number; y: number }, destEnd: { x: number; y: number }): void {
    if (!this.patchSourceRect || !this.state) return;
    const ctx = this.ctx;
    const destBounds = {
      x: Math.min(destStart.x, destEnd.x),
      y: Math.min(destStart.y, destEnd.y),
      width: Math.abs(destEnd.x - destStart.x),
      height: Math.abs(destEnd.y - destStart.y),
    };
    ctx.save();
    ctx.translate(this.panX, this.panY);
    ctx.scale(this.scale, this.scale);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(
      this.patchSourceRect.x,
      this.patchSourceRect.y,
      this.patchSourceRect.width,
      this.patchSourceRect.height,
    );
    ctx.globalAlpha = 0.85;
    const sourceRect = this.screenshotSourceRect(this.patchSourceRect);
    ctx.drawImage(
      this.opts.screenshotImage,
      sourceRect.x,
      sourceRect.y,
      sourceRect.width,
      sourceRect.height,
      destBounds.x,
      destBounds.y,
      destBounds.width || 1,
      destBounds.height || 1,
    );
    ctx.globalAlpha = 1;
    ctx.strokeStyle = this.activeColor();
    ctx.lineWidth = 2 / this.scale;
    ctx.strokeRect(destBounds.x, destBounds.y, destBounds.width, destBounds.height);
    this.drawPatchIndicator(this.patchSourceRect, destBounds, this.activeColor());
    ctx.restore();
  }

  private activeColor(): string {
    if (!this.state) return '#000000';
    const active = this.state.groups.find((g) => g.id === this.state!.activeGroupId);
    return active?.color ?? '#000000';
  }

  render(): void {
    if (!this.state) return;
    const { ctx, opts, state } = this;
    const canvas = opts.canvas;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.translate(this.panX, this.panY);
    ctx.scale(this.scale, this.scale);

    ctx.drawImage(opts.screenshotImage, 0, 0, state.viewport.width, state.viewport.height);

    const colorByGroupId = new Map(state.groups.map((g) => [g.id, g.color] as const));

    for (const mark of state.marks) {
      const color = colorByGroupId.get(mark.groupId) ?? '#000000';
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 2 / this.scale;
      switch (mark.type) {
        case 'rectangle':
          ctx.strokeRect(mark.bounds.x, mark.bounds.y, mark.bounds.width, mark.bounds.height);
          break;
        case 'ellipse':
          ctx.beginPath();
          ctx.ellipse(
            mark.bounds.x + mark.bounds.width / 2,
            mark.bounds.y + mark.bounds.height / 2,
            mark.bounds.width / 2,
            mark.bounds.height / 2,
            0,
            0,
            Math.PI * 2,
          );
          ctx.stroke();
          break;
        case 'arrow':
          this.drawArrow(mark.from, mark.to);
          break;
        case 'line':
          ctx.beginPath();
          ctx.moveTo(mark.from.x, mark.from.y);
          ctx.lineTo(mark.to.x, mark.to.y);
          ctx.stroke();
          break;
        case 'freehand':
          ctx.beginPath();
          ctx.moveTo(mark.points[0].x, mark.points[0].y);
          for (const point of mark.points.slice(1)) ctx.lineTo(point.x, point.y);
          ctx.stroke();
          break;
        case 'text':
          ctx.font = '14px sans-serif';
          ctx.save();
          ctx.beginPath();
          ctx.rect(mark.bounds.x, mark.bounds.y, mark.bounds.width, mark.bounds.height);
          ctx.clip();
          drawWrappedText(ctx, mark.text, mark.bounds, 14);
          ctx.restore();
          break;
        case 'mask':
          ctx.fillRect(mark.bounds.x, mark.bounds.y, mark.bounds.width, mark.bounds.height);
          break;
        case 'patch':
          // Renders the actual cropped screenshot pixels at the destination
          // \u2014 this is a real pixel edit, not a vector annotation, mirroring
          // what @redpen/annotator-core's compositeMarksOntoScreenshot bakes
          // into annotated.png at submit time.
          {
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(
              mark.sourceRect.x,
              mark.sourceRect.y,
              mark.sourceRect.width,
              mark.sourceRect.height,
            );
            const sourceRect = this.screenshotSourceRect(mark.sourceRect);
            ctx.drawImage(
              opts.screenshotImage,
              sourceRect.x,
              sourceRect.y,
              sourceRect.width,
              sourceRect.height,
              mark.bounds.x,
              mark.bounds.y,
              mark.bounds.width,
              mark.bounds.height,
            );
          }
          ctx.strokeRect(mark.bounds.x, mark.bounds.y, mark.bounds.width, mark.bounds.height);
          this.drawPatchIndicator(mark.sourceRect, mark.bounds, color);
          break;
      }
    }

    if (this.patchSourceRect) {
      // Highlights the already-picked crop source while the destination drag
      // (step 2) is still pending, so the two-step gesture stays legible.
      ctx.save();
      ctx.strokeStyle = this.activeColor();
      ctx.setLineDash([4 / this.scale, 3 / this.scale]);
      ctx.lineWidth = 2 / this.scale;
      ctx.strokeRect(this.patchSourceRect.x, this.patchSourceRect.y, this.patchSourceRect.width, this.patchSourceRect.height);
      ctx.restore();
    }

    ctx.restore();

    // Badges are drawn in canvas-pixel space (not scaled) so their size stays
    // legible at any zoom level; compute cluster centers in screenshot space
    // then transform to canvas space manually.
    for (const group of state.groups) {
      for (const cluster of computeBadgeClustersClientSide(state.marks, group.id)) {
        const screenshotX = cluster.x - 8;
        const screenshotY = cluster.y - 8;
        const cx = screenshotX * this.scale + this.panX;
        const cy = screenshotY * this.scale + this.panY;
        ctx.beginPath();
        ctx.fillStyle = group.color;
        ctx.arc(cx, cy, 10, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = 'white';
        ctx.font = 'bold 11px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(group.number), cx, cy);
        ctx.textAlign = 'start';
        ctx.textBaseline = 'alphabetic';
      }
    }
  }
}

/** Reads a Blob's raw bytes and base64-encodes them for the daemon's JSON `pngBase64` field. */
async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function pointToSegmentDistance(
  point: { x: number; y: number },
  start: { x: number; y: number },
  end: { x: number; y: number },
): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (dx === 0 && dy === 0) return Math.hypot(point.x - start.x, point.y - start.y);
  const projection = Math.max(
    0,
    Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy)),
  );
  return Math.hypot(point.x - (start.x + projection * dx), point.y - (start.y + projection * dy));
}

function drawWrappedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  bounds: { x: number; y: number; width: number; height: number },
  fontSize: number,
): void {
  const lineHeight = fontSize * 1.25;
  let y = bounds.y + fontSize;
  const writeLine = (line: string): boolean => {
    if (y > bounds.y + bounds.height) return false;
    ctx.fillText(line, bounds.x, y);
    y += lineHeight;
    return true;
  };
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const token of paragraph.match(/\s+|\S+/g) ?? []) {
      if (ctx.measureText(line + token).width <= bounds.width) {
        line += token;
        continue;
      }
      if (line) {
        if (!writeLine(line)) return;
        line = '';
      }
      let remainder = token;
      while (remainder && ctx.measureText(remainder).width > bounds.width) {
        let splitAt = 1;
        while (
          splitAt < remainder.length &&
          ctx.measureText(remainder.slice(0, splitAt + 1)).width <= bounds.width
        ) {
          splitAt++;
        }
        if (!writeLine(remainder.slice(0, splitAt))) return;
        remainder = remainder.slice(splitAt);
      }
      line = remainder;
    }
    if (!writeLine(line)) return;
  }
}

function boundsOfPoints(points: { x: number; y: number }[]) {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  return {
    x: Math.min(...xs),
    y: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
}

/**
 * Client-side mirror of AnnotatorStore.computeBadgeClusters (packages/
 * annotator-core/src/store.ts) so the badge layout can be recomputed after
 * every render without a round trip to the server. Kept minimal — server
 * state stays authoritative for everything except this purely visual
 * clustering.
 */
function computeBadgeClustersClientSide(marks: Mark[], groupId: string, proximityPx = 24) {
  const groupMarks = marks.filter((m) => m.groupId === groupId);
  if (groupMarks.length === 0) return [];

  const expanded = groupMarks.map((m) => ({
    x: m.bounds.x - proximityPx,
    y: m.bounds.y - proximityPx,
    width: m.bounds.width + proximityPx * 2,
    height: m.bounds.height + proximityPx * 2,
  }));

  function intersects(a: { x: number; y: number; width: number; height: number }, b: typeof a): boolean {
    return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
  }

  const parent = groupMarks.map((_, i) => i);
  function find(i: number): number {
    while (parent[i] !== i) i = parent[i];
    return i;
  }
  function union(a: number, b: number) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }
  for (let i = 0; i < expanded.length; i++) {
    for (let j = i + 1; j < expanded.length; j++) {
      if (intersects(expanded[i], expanded[j])) union(i, j);
    }
  }

  const clusters = new Map<number, { minX: number; minY: number; maxX: number; maxY: number }>();
  for (let i = 0; i < groupMarks.length; i++) {
    const root = find(i);
    const bounds = groupMarks[i].bounds;
    const existing = clusters.get(root);
    if (!existing) {
      clusters.set(root, { minX: bounds.x, minY: bounds.y, maxX: bounds.x + bounds.width, maxY: bounds.y + bounds.height });
    } else {
      existing.minX = Math.min(existing.minX, bounds.x);
      existing.minY = Math.min(existing.minY, bounds.y);
      existing.maxX = Math.max(existing.maxX, bounds.x + bounds.width);
      existing.maxY = Math.max(existing.maxY, bounds.y + bounds.height);
    }
  }
  return Array.from(clusters.values()).map((c) => ({ x: c.minX, y: c.minY, width: c.maxX - c.minX, height: c.maxY - c.minY }));
}

declare global {
  interface Window {
    RedpenSession?: { SessionAnnotatorApp: typeof SessionAnnotatorApp };
  }
}
if (typeof window !== 'undefined') {
  window.RedpenSession = { SessionAnnotatorApp };
}
