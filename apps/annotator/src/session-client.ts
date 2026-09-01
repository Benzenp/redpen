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

export type ToolName = 'pen' | 'arrow' | 'line' | 'rectangle' | 'ellipse' | 'text' | 'mask' | 'select' | 'erase';

const ERASE_HIT_RADIUS_PX = 10;

/** [english, korean] tool names for the status bar readout. */
const TOOL_LABELS: Record<ToolName, readonly [string, string]> = {
  select: ['Select / Move', '선택 / 이동'],
  pen: ['Pen', '펜'],
  arrow: ['Arrow', '화살표'],
  line: ['Line', '직선'],
  rectangle: ['Rectangle', '사각형'],
  ellipse: ['Ellipse', '원'],
  text: ['Text area', '텍스트 영역'],
  mask: ['Mask', '가리기'],
  erase: ['Eraser', '지우개'],
};

interface AnnotatorState {
  frameId: string;
  viewport: { width: number; height: number };
  groups: InstructionGroup[];
  marks: Mark[];
  activeGroupId: string;
  globalNote?: string;
  emptyGroups: Array<{ groupId: string; number: number }>;
  canSubmit: boolean;
  canUndo: boolean;
  canRedo: boolean;
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
  updateMarks(marks: Mark[]): Promise<void> {
    return this.request('PATCH', '/marks', { marks });
  }
  updateMaskStyle(markIds: string[], opacity: number): Promise<void> {
    return this.request('PATCH', '/marks/mask-style', { markIds, opacity });
  }
  reassignMarks(markIds: string[], groupId: string): Promise<void> {
    return this.request('POST', '/marks/reassign', { markIds, groupId });
  }
  removeMarks(markIds: string[]): Promise<void> {
    return this.request('DELETE', '/marks', { markIds });
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
  deleteGroup(groupId: string): Promise<void> {
    return this.request('DELETE', `/groups/${groupId}`);
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
  private pendingMutationCount = 0;
  private loaded = false;
  private submissionPending = false;
  tool: ToolName = 'select';
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
  private spaceHeld = false;
  private panStart = { x: 0, y: 0 };
  private panOrigin = { x: 0, y: 0 };

  private drawing: { points: { x: number; y: number }[] } | null = null;
  private dragStart: { x: number; y: number } | null = null;

  private selectedMarkIds = new Set<string>();
  private selectionBounds: { x: number; y: number; width: number; height: number } | null = null;
  private selectMode: 'marquee' | 'move' | 'resize' | 'patch' | null = null;
  private selectOrigin: { x: number; y: number } | null = null;
  private selectInitialBounds: { x: number; y: number; width: number; height: number } | null = null;
  private resizeCorner: 'nw' | 'ne' | 'sw' | 'se' | null = null;
  private selectedAtStart: string[] = [];
  private selectionAdditive = false;
  private selectionPressedMarkId: string | null = null;
  private hoveredGroupId: string | null = null;
  private pendingMarkOverrides = new Map<string, Mark>();
  private maskOpacity = 0.5;
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

  async focusGroup(groupId: string): Promise<void> {
    await this.setActiveGroup(groupId);
    const marks = this.state?.marks.filter((mark) => mark.groupId === groupId) ?? [];
    if (marks.length === 0) return;
    const left = Math.min(...marks.map((mark) => mark.bounds.x));
    const top = Math.min(...marks.map((mark) => mark.bounds.y));
    const right = Math.max(...marks.map((mark) => mark.bounds.x + mark.bounds.width));
    const bottom = Math.max(...marks.map((mark) => mark.bounds.y + mark.bounds.height));
    this.panX = this.opts.canvas.width / 2 - ((left + right) / 2) * this.scale;
    this.panY = this.opts.canvas.height / 2 - ((top + bottom) / 2) * this.scale;
    this.render();
  }

  setHoveredGroup(groupId: string | null): void {
    this.hoveredGroupId = groupId;
    this.render();
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
      if (event.code === 'Space') {
        this.spaceHeld = true;
        this.opts.canvas.style.cursor = 'grab';
        event.preventDefault();
        return;
      }
      if (event.key === 'Escape') {
        this.cancelTextEditor();
        this.cancelInteraction();
        this.selectedMarkIds.clear();
        this.selectionBounds = null;
        this.render();
        return;
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && this.selectedMarkIds.size) { event.preventDefault(); this.deleteSelection(); return; }
      if (event.key === 'Enter' && this.selectedMarkIds.size === 1) {
        const mark = this.state?.marks.find((candidate) => this.selectedMarkIds.has(candidate.id));
        if (mark?.type === 'text') { event.preventDefault(); this.openTextEditor(mark.bounds, mark); return; }
      }
      if (/^[1-9]$/.test(event.key)) {
        const group = this.state?.groups.find((candidate) => candidate.number === Number(event.key));
        if (group) {
          void this.setActiveGroup(group.id).then(() => {
            this.setStatus(this.message(`Group #${group.number}`, `그룹 #${group.number}`));
          });
        }
        return;
      }
      if (event.key.toLowerCase() === 'v') { this.setTool('select'); return; }
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
    window.addEventListener('keyup', (event) => {
      if (event.code === 'Space') {
        this.spaceHeld = false;
        if (!this.isPanning) this.opts.canvas.style.cursor = this.tool === 'select' ? 'default' : '';
      }
    });
    window.addEventListener('blur', () => {
      this.spaceHeld = false;
      this.cancelInteraction();
      this.render();
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
    // Centered, not top-left pinned: a screenshot narrower than the canvas
    // used to sit against the left edge with a dead gray band beside it,
    // which reads like a broken layout rather than a document on a desk.
    this.panX = Math.max(0, (availableWidth - this.state.viewport.width * this.scale) / 2);
    this.panY = Math.max(0, (availableHeight - this.state.viewport.height * this.scale) / 2);
  }

  /** View menu / +,- keys: zoom around the middle of the visible canvas. */
  zoomBy(factor: number): void {
    const canvas = this.opts.canvas;
    const centerX = canvas.width / 2;
    const centerY = canvas.height / 2;
    const before = { x: (centerX - this.panX) / this.scale, y: (centerY - this.panY) / this.scale };
    this.scale = Math.min(Math.max(this.scale * factor, 0.1), 8);
    this.panX = centerX - before.x * this.scale;
    this.panY = centerY - before.y * this.scale;
    this.render();
  }

  /** View menu / 0 key / status-bar zoom readout: back to a full-page view. */
  fitToView(): void {
    this.fitToViewport();
    this.render();
  }

  hasSelection(): boolean {
    return this.selectedMarkIds.size > 0;
  }

  /** Edit menu counterpart of the Delete key. */
  deleteSelection(): void {
    if (this.selectedMarkIds.size === 0) return;
    const ids = [...this.selectedMarkIds];
    this.selectedMarkIds.clear();
    this.selectionBounds = null;
    void this.removeMarks(ids);
  }

  setTool(tool: ToolName): void {
    if (!this.isInteractionReady()) return;
    this.cancelTextEditor();
    this.cancelInteraction();
    this.tool = tool;
    this.opts.canvas.style.cursor = '';
    this.setIdleStatus();
  }

  /** Status-bar readout for "nothing is happening": current tool + group. */
  private setIdleStatus(): void {
    const groupNumber = this.state?.groups.find((group) => group.id === this.state?.activeGroupId)?.number ?? '';
    const label = TOOL_LABELS[this.tool][this.locale === 'ko' ? 1 : 0];
    this.setStatus(this.message(`${label} · Group #${groupNumber}`, `${label} · 그룹 #${groupNumber}`));
  }

  previewMaskOpacity(opacity: number): void {
    this.maskOpacity = Math.max(0.1, Math.min(1, opacity));
    this.render();
  }

  commitMaskOpacity(): Promise<void> {
    const selectedMasks = this.state?.marks.filter((mark) => this.selectedMarkIds.has(mark.id) && mark.type === 'mask') ?? [];
    if (selectedMasks.length === 0) return Promise.resolve();
    return this.updateMaskStyle(selectedMasks.map((mark) => mark.id), this.maskOpacity);
  }

  isMutationInFlight(): boolean {
    return this.pendingMutationCount > 0;
  }

  reassignSelection(groupId: string): Promise<void> {
    return this.enqueueMutation(async () => {
      if (!this.selectedMarkIds.size) return;
      await this.api.reassignMarks([...this.selectedMarkIds], groupId);
      await this.api.setActiveGroup(groupId);
      await this.refresh();
      this.selectionBounds = this.boundsForSelection();
    });
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

  private canvasPoint(event: MouseEvent): { x: number; y: number } {
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

      if (event.button === 1 || this.spaceHeld) {
        this.isPanning = true;
        canvas.style.cursor = 'grabbing';
        canvas.setPointerCapture(event.pointerId);
        this.panStart = canvasPoint;
        this.panOrigin = { x: this.panX, y: this.panY };
        return;
      }

      const point = this.toScreenshotSpace(canvasPoint.x, canvasPoint.y);
      if (!this.isInsideScreenshot(point)) return;
      canvas.setPointerCapture(event.pointerId);
      if (this.tool === 'select') {
        this.beginSelection(point, event.shiftKey);
        return;
      }
      if (this.tool === 'erase') {
        const hit = this.findMarkNear(point);
        if (hit) void this.removeMarks([hit.id]);
        return;
      } else if (this.tool === 'pen') {
        this.drawing = { points: [point] };
      } else if (this.tool === 'text' && event.detail === 2) {
        const hit = this.findMarkNear(point);
        if (hit?.type === 'text') this.openTextEditor(hit.bounds, hit);
      } else if (this.tool === 'rectangle' || this.tool === 'ellipse' || this.tool === 'mask' || this.tool === 'arrow' || this.tool === 'line' || this.tool === 'text') {
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

      let point = this.clampToScreenshot(this.toScreenshotSpace(canvasPoint.x, canvasPoint.y));
      if (this.dragStart && event.shiftKey) point = this.constrainDrawPoint(this.dragStart, point, this.tool);
      if (this.tool === 'select' && this.selectMode) {
        this.updateSelectionPreview(point, event.shiftKey);
      } else if (this.tool === 'select') {
        this.updateSelectCursor(point);
      } else if (this.tool === 'pen' && this.drawing) {
        const coalesced = event.getCoalescedEvents?.() ?? [event];
        for (const sample of coalesced) this.drawing.points.push(this.clampToScreenshot(this.toScreenshotSpace(this.canvasPoint(sample).x, this.canvasPoint(sample).y)));
        this.render();
        this.renderLivePreviewFreehand();
      } else if (this.dragStart && (this.tool === 'rectangle' || this.tool === 'ellipse' || this.tool === 'mask' || this.tool === 'arrow' || this.tool === 'line' || this.tool === 'text')) {
        this.render();
        this.renderLivePreviewDrag(this.dragStart, point);
      }
    });

    canvas.addEventListener('pointerup', (event) => {
      if (!this.isInteractionReady()) return;
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      if (this.isPanning) {
        this.isPanning = false;
        canvas.style.cursor = this.tool === 'select' ? 'default' : '';
        return;
      }

      const canvasPoint = this.canvasPoint(event);
      let point = this.clampToScreenshot(this.toScreenshotSpace(canvasPoint.x, canvasPoint.y));
      if (this.dragStart && event.shiftKey) point = this.constrainDrawPoint(this.dragStart, point, this.tool);

      if (this.tool === 'select' && this.selectMode) {
        this.finishSelection(point, event.shiftKey);
        return;
      }

      if (this.tool === 'pen' && this.drawing) {
        const points = this.drawing.points;
        const lastPoint = points[points.length - 1];
        if (!lastPoint || lastPoint.x !== point.x || lastPoint.y !== point.y) points.push(point);
        this.drawing = null;
        if (points.length >= 1) {
          const smoothed = smoothPoints(points);
          const bounds = boundsOfPoints(smoothed);
          void this.commitAddMark({ type: 'freehand', frameId: this.state!.frameId, points: smoothed, bounds, normalizedBounds: this.normalizeBounds(bounds) } as Omit<Mark, 'id' | 'groupId'>);
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

        if (this.tool === 'text' && bounds.width < 2 && bounds.height < 2) {
          bounds.width = Math.min(180, this.state!.viewport.width - bounds.x);
          bounds.height = Math.min(48, this.state!.viewport.height - bounds.y);
        } else if (bounds.width < 2 && bounds.height < 2) {
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
          void this.commitAddMark({ type: this.tool, frameId: this.state!.frameId, bounds, normalizedBounds: this.normalizeBounds(bounds), ...(this.tool === 'mask' ? { opacity: this.maskOpacity } : {}) } as Omit<Mark, 'id' | 'groupId'>);
        }
      }
    });

    canvas.addEventListener('pointercancel', (event) => {
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      this.cancelInteraction();
      this.render();
    });

    canvas.addEventListener('dblclick', (event) => {
      if (!this.isInteractionReady() || this.tool !== 'select') return;
      const canvasPoint = this.canvasPoint(event);
      const point = this.toScreenshotSpace(canvasPoint.x, canvasPoint.y);
      const hit = this.findMarkNear(point);
      if (hit?.type !== 'text') return;
      this.selectedMarkIds = new Set([hit.id]);
      this.selectionBounds = { ...hit.bounds };
      this.openTextEditor(hit.bounds, hit);
    });
  }

  private beginSelection(point: { x: number; y: number }, additive: boolean): void {
    const handle = this.selectionBounds && this.hitHandle(point, this.selectionBounds);
    this.selectOrigin = point;
    this.selectedAtStart = [...this.selectedMarkIds];
    this.selectionAdditive = additive;
    if (handle && this.selectionBounds) {
      this.selectMode = 'resize';
      this.selectInitialBounds = this.selectionBounds;
      this.resizeCorner = handle;
      return;
    }
    const anyHit = this.findMarkNear(point);
    if (anyHit && anyHit.groupId !== this.state!.activeGroupId) {
      this.selectedMarkIds.clear();
      this.selectionBounds = null;
      this.resetSelectionInteraction();
      void this.setActiveGroup(anyHit.groupId).then(() => {
        const refreshed = this.state?.marks.find((mark) => mark.id === anyHit.id);
        if (!refreshed) return;
        this.selectedMarkIds = new Set([refreshed.id]);
        this.selectionBounds = { ...refreshed.bounds };
        this.updateSelectionStatus();
        this.render();
        this.onStateChange?.();
      });
      return;
    }
    const hit = anyHit;
    if (hit) {
      this.selectionPressedMarkId = hit.id;
      if (additive) {
        if (!this.selectedMarkIds.has(hit.id)) this.selectedMarkIds.add(hit.id);
      } else if (!this.selectedMarkIds.has(hit.id)) {
        this.selectedMarkIds = new Set([hit.id]);
      }
      this.selectionBounds = this.boundsForSelection();
      this.selectMode = this.selectedMarkIds.has(hit.id) ? 'move' : null;
      this.selectInitialBounds = this.selectionBounds;
    } else if (this.selectionBounds && this.contains(this.selectionBounds, point)) {
      this.selectMode = 'patch';
      this.selectInitialBounds = this.selectionBounds;
    } else {
      if (!additive) this.selectedMarkIds.clear();
      this.selectionBounds = { x: point.x, y: point.y, width: 0, height: 0 };
      this.selectMode = 'marquee';
      this.selectInitialBounds = this.selectionBounds;
    }
    this.render();
  }

  private updateSelectionPreview(point: { x: number; y: number }, constrain: boolean): void {
    if (!this.selectOrigin || !this.selectionBounds) return;
    if (this.selectMode === 'marquee') {
      this.selectionBounds = this.rectFromPoints(this.selectOrigin, point, constrain);
    } else if (this.selectMode === 'move' || this.selectMode === 'patch') {
      let dx = point.x - this.selectOrigin.x;
      let dy = point.y - this.selectOrigin.y;
      if (constrain) { if (Math.abs(dx) >= Math.abs(dy)) dy = 0; else dx = 0; }
      const initial = this.selectInitialBounds!;
      this.selectionBounds = this.clampRectToScreenshot({ ...initial, x: initial.x + dx, y: initial.y + dy });
    } else if (this.selectMode === 'resize') {
      const initial = this.selectInitialBounds!;
      const opposite = {
        x: this.resizeCorner === 'nw' || this.resizeCorner === 'sw' ? initial.x + initial.width : initial.x,
        y: this.resizeCorner === 'nw' || this.resizeCorner === 'ne' ? initial.y + initial.height : initial.y,
      };
      if (constrain && initial.width && initial.height) {
        const dx = point.x - opposite.x; const dy = point.y - opposite.y; const ratio = initial.width / initial.height;
        const width = Math.max(Math.abs(dx), Math.abs(dy) * ratio); const height = width / ratio;
        this.selectionBounds = this.clampRectToScreenshot({ x: Math.min(opposite.x, opposite.x + Math.sign(dx || 1) * width), y: Math.min(opposite.y, opposite.y + Math.sign(dy || 1) * height), width, height });
      } else this.selectionBounds = this.clampRectToScreenshot(this.rectFromPoints(opposite, point, false));
    }
    this.render();
  }

  private finishSelection(point: { x: number; y: number }, constrain: boolean): void {
    const mode = this.selectMode;
    const origin = this.selectOrigin;
    this.selectMode = null;
    this.selectOrigin = null;
    if (!mode || !origin) return;
    if (mode === 'marquee') {
      const rect = this.rectFromPoints(origin, point, constrain);
      const matches = this.state!.marks.filter((mark) => mark.groupId === this.state!.activeGroupId && this.intersects(mark.bounds, rect)).map((mark) => mark.id);
      if (matches.length) {
        this.selectedMarkIds = new Set(this.selectionAdditive ? [...this.selectedAtStart, ...matches] : matches);
        this.selectionBounds = this.boundsForSelection();
      } else if (!this.selectionAdditive) {
        this.selectedMarkIds.clear();
        this.selectionBounds = rect.width >= 2 && rect.height >= 2 ? rect : null;
      }
      this.selectInitialBounds = null;
      this.updateSelectionStatus();
      this.resetSelectionInteraction();
      this.render();
      return;
    }
    const initial = this.selectInitialBounds!;
    if (mode === 'patch') {
      const destination = { ...initial, x: this.selectionBounds!.x, y: this.selectionBounds!.y };
      this.selectedMarkIds.clear();
      this.selectionBounds = null;
      this.selectInitialBounds = null;
      this.resetSelectionInteraction();
      void this.commitAddMark(
        { type: 'patch', frameId: this.state!.frameId, sourceRect: initial, bounds: destination, normalizedBounds: this.normalizeBounds(destination) } as Omit<Mark, 'id' | 'groupId'>,
        true,
      );
      return;
    }
    if (mode === 'move' || mode === 'resize') {
      const next = this.selectionBounds!;
      if (Math.abs(next.x - initial.x) < 0.01 && Math.abs(next.y - initial.y) < 0.01 && Math.abs(next.width - initial.width) < 0.01 && Math.abs(next.height - initial.height) < 0.01) {
        if (
          mode === 'move' &&
          this.selectionAdditive &&
          this.selectionPressedMarkId &&
          this.selectedAtStart.includes(this.selectionPressedMarkId)
        ) {
          this.selectedMarkIds.delete(this.selectionPressedMarkId);
          this.selectionBounds = this.boundsForSelection();
          this.updateSelectionStatus();
        } else if (
          mode === 'move' &&
          !this.selectionAdditive &&
          this.selectionPressedMarkId &&
          this.selectedAtStart.length > 1 &&
          this.selectedAtStart.includes(this.selectionPressedMarkId)
        ) {
          this.selectedMarkIds = new Set([this.selectionPressedMarkId]);
          this.selectionBounds = this.boundsForSelection();
          this.updateSelectionStatus();
        }
        this.selectInitialBounds = null;
        this.resetSelectionInteraction();
        this.render();
        return;
      }
      const sx = initial.width ? next.width / initial.width : 1;
      const sy = initial.height ? next.height / initial.height : 1;
      const dx = next.x - initial.x;
      const dy = next.y - initial.y;
      const marks = this.state!.marks.filter((mark) => this.selectedMarkIds.has(mark.id)).map((mark) =>
        this.transformMark(mark, initial, sx, sy, dx, dy),
      );
      this.selectionBounds = next;
      if (marks.length) void this.updateMarks(marks);
    }
    this.selectInitialBounds = null;
    this.updateSelectionStatus();
    this.resetSelectionInteraction();
    this.render();
  }

  private updateSelectionStatus(): void {
    const group = this.state?.groups.find((candidate) => candidate.id === this.state?.activeGroupId);
    if (this.selectedMarkIds.size > 0) {
      this.setStatus(this.message(
        `${this.selectedMarkIds.size} selected · Group #${group?.number ?? ''}`,
        `${this.selectedMarkIds.size}개 선택 · 그룹 #${group?.number ?? ''}`,
      ));
    } else if (this.selectionBounds) {
      this.setStatus(this.message(
        `Region ${Math.round(this.selectionBounds.width)} × ${Math.round(this.selectionBounds.height)}`,
        `영역 ${Math.round(this.selectionBounds.width)} × ${Math.round(this.selectionBounds.height)}`,
      ));
    } else {
      this.setStatus(this.message(`Select / Move · Group #${group?.number ?? ''}`, `선택 / 이동 · 그룹 #${group?.number ?? ''}`));
    }
  }

  private transformMark(mark: Mark, box: { x: number; y: number; width: number; height: number }, sx: number, sy: number, dx: number, dy: number): Mark {
    const point = (p: { x: number; y: number }) => ({ x: box.x + (p.x - box.x) * sx + dx, y: box.y + (p.y - box.y) * sy + dy });
    const bounds = { x: box.x + (mark.bounds.x - box.x) * sx + dx, y: box.y + (mark.bounds.y - box.y) * sy + dy, width: mark.bounds.width * sx, height: mark.bounds.height * sy };
    const result: Mark = { ...mark, bounds, normalizedBounds: this.normalizeBounds(bounds) } as Mark;
    if (result.type === 'line' || result.type === 'arrow') Object.assign(result, { from: point(result.from), to: point(result.to) });
    if (result.type === 'freehand') result.points = result.points.map(point);
    if (result.type === 'text') result.anchor = point(result.anchor);
    return result;
  }

  private boundsForSelectionOrEphemeral() { return this.selectedMarkIds.size ? this.boundsForSelection()! : this.selectionBounds!; }
  private boundsForSelection() {
    const marks = this.state!.marks.filter((mark) => this.selectedMarkIds.has(mark.id) && mark.groupId === this.state!.activeGroupId);
    if (!marks.length) return null;
    const left = Math.min(...marks.map((mark) => mark.bounds.x)); const top = Math.min(...marks.map((mark) => mark.bounds.y));
    const right = Math.max(...marks.map((mark) => mark.bounds.x + mark.bounds.width)); const bottom = Math.max(...marks.map((mark) => mark.bounds.y + mark.bounds.height));
    return { x: left, y: top, width: right - left, height: bottom - top };
  }
  private rectFromPoints(a: { x: number; y: number }, b: { x: number; y: number }, square: boolean) {
    let dx = b.x - a.x; let dy = b.y - a.y;
    if (square) { const size = Math.max(Math.abs(dx), Math.abs(dy)); dx = Math.sign(dx || 1) * size; dy = Math.sign(dy || 1) * size; }
    return { x: Math.min(a.x, a.x + dx), y: Math.min(a.y, a.y + dy), width: Math.abs(dx), height: Math.abs(dy) };
  }
  private clampRectToScreenshot(rect: { x: number; y: number; width: number; height: number }) {
    if (!this.state) return rect;
    const width = Math.min(Math.max(0, rect.width), this.state.viewport.width);
    const height = Math.min(Math.max(0, rect.height), this.state.viewport.height);
    return {
      x: Math.max(0, Math.min(this.state.viewport.width - width, rect.x)),
      y: Math.max(0, Math.min(this.state.viewport.height - height, rect.y)),
      width,
      height,
    };
  }
  private intersects(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) { return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y; }
  private contains(b: { x: number; y: number; width: number; height: number }, p: { x: number; y: number }) { return p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height; }
  private hitHandle(p: { x: number; y: number }, b: { x: number; y: number; width: number; height: number }) {
    const corners = { nw: [b.x, b.y], ne: [b.x + b.width, b.y], sw: [b.x, b.y + b.height], se: [b.x + b.width, b.y + b.height] } as const;
    return (Object.entries(corners).find(([, [x, y]]) => Math.hypot(p.x - x, p.y - y) <= 8 / this.scale)?.[0] ?? null) as 'nw' | 'ne' | 'sw' | 'se' | null;
  }

  private updateSelectCursor(point: { x: number; y: number }): void {
    const handle = this.selectionBounds && this.hitHandle(point, this.selectionBounds);
    if (handle === 'nw' || handle === 'se') {
      this.opts.canvas.style.cursor = 'nwse-resize';
    } else if (handle === 'ne' || handle === 'sw') {
      this.opts.canvas.style.cursor = 'nesw-resize';
    } else if (
      (this.selectionBounds && this.contains(this.selectionBounds, point)) ||
      this.findMarkNear(point)
    ) {
      this.opts.canvas.style.cursor = 'move';
    } else {
      this.opts.canvas.style.cursor = 'crosshair';
    }
  }

  private constrainDrawPoint(start: { x: number; y: number }, point: { x: number; y: number }, tool: ToolName) {
    let dx = point.x - start.x; let dy = point.y - start.y;
    if (tool === 'line' || tool === 'arrow') {
      const angle = Math.atan2(dy, dx); const snap = Math.round(angle / (Math.PI / 4)) * Math.PI / 4; const length = Math.hypot(dx, dy);
      return { x: start.x + Math.cos(snap) * length, y: start.y + Math.sin(snap) * length };
    }
    if (tool === 'rectangle' || tool === 'ellipse' || tool === 'mask') {
      const size = Math.max(Math.abs(dx), Math.abs(dy)); dx = Math.sign(dx || 1) * size; dy = Math.sign(dy || 1) * size;
      return { x: start.x + dx, y: start.y + dy };
    }
    return point;
  }

  private resetSelectionInteraction(): void {
    this.selectMode = null;
    this.selectOrigin = null;
    this.selectInitialBounds = null;
    this.resizeCorner = null;
    this.selectionAdditive = false;
    this.selectionPressedMarkId = null;
  }

  private cancelInteraction(): void {
    this.isPanning = false;
    this.opts.canvas.style.cursor = this.tool === 'select' ? 'default' : '';
    this.drawing = null;
    this.dragStart = null;
    if (this.selectedMarkIds.size > 0) {
      this.selectionBounds = this.boundsForSelection();
    } else if (this.selectInitialBounds && (this.selectMode === 'resize' || this.selectMode === 'patch')) {
      this.selectionBounds = { ...this.selectInitialBounds };
    } else if (this.selectMode === 'marquee') {
      this.selectionBounds = null;
    }
    this.resetSelectionInteraction();
  }

  private openTextEditor(dragBounds: { x: number; y: number; width: number; height: number }, existing?: Extract<Mark, { type: 'text' }>): void {
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
    editor.value = existing?.text ?? '';

    let settled = false;
    const finish = (commit: boolean) => {
      if (settled) return;
      settled = true;
      const text = editor.value.trim();
      editor.remove();
      this.textEditor = null;
      if (commit && text && existing) {
        void this.updateMarks([{ ...existing, text, bounds, anchor: { x: bounds.x, y: bounds.y }, normalizedBounds: this.normalizeBounds(bounds) }]);
      } else if (commit && text) {
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

  private commitAddMark(mark: Omit<Mark, 'id' | 'groupId'>, selectAfter = false): Promise<void> {
    return this.enqueueMutation(async () => {
      const created = await this.api.addMark(mark);
      await this.refresh();
      if (selectAfter) {
        this.selectedMarkIds = new Set([created.mark.id]);
        this.selectionBounds = { ...created.mark.bounds };
        this.updateSelectionStatus();
        this.render();
        this.onStateChange?.();
      }
    });
  }

  removeMarks(markIds: string[]): Promise<void> {
    return this.enqueueMutation(async () => {
      await this.api.removeMarks(markIds);
      await this.refresh();
    });
  }

  private updateMarks(marks: Mark[]): Promise<void> {
    this.pendingMarkOverrides = new Map(marks.map((mark) => [mark.id, structuredClone(mark)]));
    this.render();
    return this.enqueueMutation(async () => {
      try {
        await this.api.updateMarks(marks);
        await this.refresh();
      } finally {
        this.pendingMarkOverrides.clear();
        this.render();
      }
    });
  }

  private updateMaskStyle(markIds: string[], opacity: number): Promise<void> {
    return this.enqueueMutation(async () => {
      await this.api.updateMaskStyle(markIds, opacity);
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

  deleteGroup(groupId: string): Promise<void> {
    return this.enqueueMutation(async () => {
      await this.api.deleteGroup(groupId);
      await this.refresh();
    });
  }

  setActiveGroup(groupId: string): Promise<void> {
    if (!this.isInteractionReady()) return this.rejectUnavailable();
    this.selectedMarkIds.clear();
    this.selectionBounds = null;
    this.cancelInteraction();
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
    return this.loaded && this.state !== null && !this.submissionPending && this.pendingMutationCount === 0;
  }

  private enqueueMutation<T>(mutation: () => Promise<T>): Promise<T> {
    if (!this.isInteractionReady()) return this.rejectUnavailable();

    this.pendingMutationCount++;
    this.opts.canvas.style.cursor = 'wait';
    this.setStatus(this.message('Saving changes...', '변경사항 저장 중...'));
    this.onStateChange?.();
    const operation = this.mutationTail.then(mutation).finally(() => {
      this.pendingMutationCount--;
      this.opts.canvas.style.cursor = this.tool === 'select' ? 'default' : '';
      // Leaving "Saving changes..." in the status bar forever made the app
      // look stuck; once nothing is in flight the readout goes back to
      // telling the user which tool and group they are working in.
      if (this.pendingMutationCount === 0) this.setIdleStatus();
      this.onStateChange?.();
    });
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
      : this.pendingMutationCount > 0
        ? this.message('Wait for the current change to finish saving.', '현재 변경사항 저장이 끝날 때까지 기다려 주세요.')
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
    const interactionStatus = document.getElementById('interaction-status');
    if (interactionStatus) interactionStatus.textContent = message;
    const status = document.getElementById('submit-status');
    if (!status || !isError) return;
    status.textContent = message;
    status.className = 'error';
  }

  private async refresh(): Promise<void> {
    this.state = await this.api.getState();
    this.selectedMarkIds = new Set(
      [...this.selectedMarkIds].filter((id) => this.state!.marks.some((mark) => mark.id === id)),
    );
    this.selectionBounds = this.selectedMarkIds.size > 0 ? this.boundsForSelection() : this.selectionBounds;
    this.render();
    this.onStateChange?.();
  }

  private renderLivePreviewFreehand(): void {
    if (!this.drawing) return;
    const points = smoothPoints(this.drawing.points);
    if (points.length === 0) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(this.panX, this.panY);
    ctx.scale(this.scale, this.scale);
    ctx.strokeStyle = this.activeColor();
    ctx.lineWidth = 2 / this.scale;
    if (points.length === 1) {
      ctx.fillStyle = this.activeColor();
      ctx.beginPath();
      ctx.arc(points[0].x, points[0].y, 1.5 / this.scale, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (const point of points.slice(1)) ctx.lineTo(point.x, point.y);
      ctx.stroke();
    }
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

  private activeColor(): string {
    if (!this.state) return '#000000';
    const active = this.state.groups.find((g) => g.id === this.state!.activeGroupId);
    return active?.color ?? '#000000';
  }

  private selectionPreviewMarks(): Map<string, Mark> {
    if (
      !this.state ||
      !this.selectInitialBounds ||
      !this.selectionBounds ||
      (this.selectMode !== 'move' && this.selectMode !== 'resize') ||
      this.selectedMarkIds.size === 0
    ) {
      return new Map();
    }
    const initial = this.selectInitialBounds;
    const next = this.selectionBounds;
    const sx = initial.width ? next.width / initial.width : 1;
    const sy = initial.height ? next.height / initial.height : 1;
    const dx = next.x - initial.x;
    const dy = next.y - initial.y;
    return new Map(
      this.state.marks
        .filter((mark) => this.selectedMarkIds.has(mark.id))
        .map((mark) => [mark.id, this.transformMark(mark, initial, sx, sy, dx, dy)] as const),
    );
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
    // Hairline frame so the screenshot reads as a page sitting on the
    // workspace instead of bleeding into the gray around it.
    ctx.save();
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 1 / this.scale;
    ctx.strokeRect(-0.5 / this.scale, -0.5 / this.scale, state.viewport.width + 1 / this.scale, state.viewport.height + 1 / this.scale);
    ctx.restore();

    const colorByGroupId = new Map(state.groups.map((g) => [g.id, g.color] as const));

    const previewMarks = this.selectionPreviewMarks();
    for (const persistedMark of state.marks) {
      const mark = previewMarks.get(persistedMark.id) ?? this.pendingMarkOverrides.get(persistedMark.id) ?? persistedMark;
      const color = colorByGroupId.get(mark.groupId) ?? '#000000';
      ctx.globalAlpha = this.hoveredGroupId
        ? (mark.groupId === this.hoveredGroupId ? 1 : 0.2)
        : (mark.groupId === state.activeGroupId ? 1 : 0.3);
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
          if (mark.points.length === 1) {
            ctx.beginPath();
            ctx.arc(mark.points[0].x, mark.points[0].y, 1.5 / this.scale, 0, Math.PI * 2);
            ctx.fill();
          } else {
            ctx.beginPath();
            ctx.moveTo(mark.points[0].x, mark.points[0].y);
            for (const point of mark.points.slice(1)) ctx.lineTo(point.x, point.y);
            ctx.stroke();
          }
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
          ctx.globalAlpha *= this.tool === 'mask' && this.selectedMarkIds.has(mark.id)
            ? this.maskOpacity
            : mark.opacity;
          ctx.fillRect(mark.bounds.x, mark.bounds.y, mark.bounds.width, mark.bounds.height);
          ctx.globalAlpha = this.hoveredGroupId
            ? (mark.groupId === this.hoveredGroupId ? 1 : 0.2)
            : (mark.groupId === state.activeGroupId ? 1 : 0.3);
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
    if (this.selectMode === 'patch' && this.selectInitialBounds && this.selectionBounds) {
      const source = this.selectInitialBounds;
      const destination = this.selectionBounds;
      ctx.save();
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(source.x, source.y, source.width, source.height);
      const imageSource = this.screenshotSourceRect(source);
      ctx.drawImage(
        opts.screenshotImage,
        imageSource.x,
        imageSource.y,
        imageSource.width,
        imageSource.height,
        destination.x,
        destination.y,
        destination.width,
        destination.height,
      );
      this.drawPatchIndicator(source, destination, this.activeColor());
      ctx.restore();
    }
    ctx.globalAlpha = 1;

    if (this.selectionBounds) {
      ctx.save();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 3 / this.scale;
      ctx.strokeRect(this.selectionBounds.x, this.selectionBounds.y, this.selectionBounds.width, this.selectionBounds.height);
      ctx.strokeStyle = '#0055aa';
      ctx.lineWidth = 1 / this.scale;
      ctx.strokeRect(this.selectionBounds.x, this.selectionBounds.y, this.selectionBounds.width, this.selectionBounds.height);
      for (const [x, y] of [[this.selectionBounds.x, this.selectionBounds.y], [this.selectionBounds.x + this.selectionBounds.width, this.selectionBounds.y], [this.selectionBounds.x, this.selectionBounds.y + this.selectionBounds.height], [this.selectionBounds.x + this.selectionBounds.width, this.selectionBounds.y + this.selectionBounds.height]]) {
        ctx.fillStyle = '#fff'; ctx.strokeStyle = '#0055aa';
        ctx.fillRect(x - 4 / this.scale, y - 4 / this.scale, 8 / this.scale, 8 / this.scale);
        ctx.strokeRect(x - 4 / this.scale, y - 4 / this.scale, 8 / this.scale, 8 / this.scale);
      }
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
        ctx.save();
        ctx.globalAlpha = this.hoveredGroupId
          ? (group.id === this.hoveredGroupId ? 1 : 0.3)
          : (group.id === state.activeGroupId ? 1 : 0.4);
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
        ctx.restore();
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

/** Fixed three-point smoothing keeps both endpoints and retains dots/short strokes. */
function smoothPoints(points: { x: number; y: number }[]) {
  const deduped: { x: number; y: number }[] = [];
  for (const point of points) {
    const previous = deduped[deduped.length - 1];
    if (!previous || Math.hypot(point.x - previous.x, point.y - previous.y) >= 0.5) deduped.push(point);
  }
  const finalPoint = points[points.length - 1];
  if (finalPoint) {
    const lastIndex = deduped.length - 1;
    const previous = deduped[lastIndex];
    if (!previous) deduped.push(finalPoint);
    else if (previous !== finalPoint && Math.hypot(finalPoint.x - previous.x, finalPoint.y - previous.y) < 0.5) deduped[lastIndex] = finalPoint;
    else if (previous !== finalPoint) deduped.push(finalPoint);
  }
  if (deduped.length < 3) return deduped;
  return deduped.map((point, index) => index === 0 || index === deduped.length - 1
    ? point
    : { x: (deduped[index - 1].x + point.x + deduped[index + 1].x) / 3, y: (deduped[index - 1].y + point.y + deduped[index + 1].y) / 3 });
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
