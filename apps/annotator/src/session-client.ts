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

export type ToolName = 'pen' | 'arrow' | 'rectangle' | 'ellipse' | 'text' | 'mask' | 'select' | 'erase';

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
  submit(): Promise<{ taskId: string }> {
    return this.request('POST', '/submit');
  }
}

export interface SessionAnnotatorAppOptions {
  canvas: HTMLCanvasElement;
  screenshotImage: HTMLImageElement;
  sessionId: string;
  token: string;
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

  constructor(private readonly opts: SessionAnnotatorAppOptions) {
    const ctx = opts.canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context unavailable');
    this.ctx = ctx;
    this.api = new AnnotatorApiClient({ sessionId: opts.sessionId, token: opts.token });
    this.attachPointerHandlers();
    this.attachWheelZoom();
  }

  async load(): Promise<void> {
    this.state = await this.api.getState();
    this.fitToViewport();
    this.render();
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
    this.tool = tool;
  }

  private toScreenshotSpace(canvasX: number, canvasY: number): { x: number; y: number } {
    return { x: (canvasX - this.panX) / this.scale, y: (canvasY - this.panY) / this.scale };
  }

  private attachWheelZoom(): void {
    this.opts.canvas.addEventListener('wheel', (event) => {
      event.preventDefault();
      const rect = this.opts.canvas.getBoundingClientRect();
      const canvasX = event.clientX - rect.left;
      const canvasY = event.clientY - rect.top;
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
      const rect = canvas.getBoundingClientRect();
      const canvasPoint = { x: event.clientX - rect.left, y: event.clientY - rect.top };

      if (event.button === 1 || event.shiftKey) {
        this.isPanning = true;
        this.panStart = canvasPoint;
        this.panOrigin = { x: this.panX, y: this.panY };
        return;
      }

      const point = this.toScreenshotSpace(canvasPoint.x, canvasPoint.y);
      if (this.tool === 'pen') {
        this.drawing = { points: [point] };
      } else if (this.tool === 'rectangle' || this.tool === 'ellipse' || this.tool === 'mask' || this.tool === 'arrow') {
        this.dragStart = point;
      } else if (this.tool === 'text') {
        const text = window.prompt('텍스트 입력:');
        if (text) void this.commitAddMark({ type: 'text', frameId: this.state!.frameId, anchor: point, text, bounds: { x: point.x, y: point.y, width: 1, height: 1 }, normalizedBounds: { x: point.x, y: point.y, width: 1, height: 1 } } as Omit<Mark, 'id' | 'groupId'>);
      }
    });

    canvas.addEventListener('pointermove', (event) => {
      const rect = canvas.getBoundingClientRect();
      const canvasPoint = { x: event.clientX - rect.left, y: event.clientY - rect.top };

      if (this.isPanning) {
        this.panX = this.panOrigin.x + (canvasPoint.x - this.panStart.x);
        this.panY = this.panOrigin.y + (canvasPoint.y - this.panStart.y);
        this.render();
        return;
      }

      const point = this.toScreenshotSpace(canvasPoint.x, canvasPoint.y);
      if (this.tool === 'pen' && this.drawing) {
        this.drawing.points.push(point);
        this.render();
        this.renderLivePreviewFreehand();
      } else if (this.dragStart && (this.tool === 'rectangle' || this.tool === 'ellipse' || this.tool === 'mask' || this.tool === 'arrow')) {
        this.render();
        this.renderLivePreviewDrag(this.dragStart, point);
      }
    });

    canvas.addEventListener('pointerup', (event) => {
      if (this.isPanning) {
        this.isPanning = false;
        return;
      }

      const rect = canvas.getBoundingClientRect();
      const canvasPoint = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      const point = this.toScreenshotSpace(canvasPoint.x, canvasPoint.y);

      if (this.tool === 'pen' && this.drawing) {
        const points = this.drawing.points;
        this.drawing = null;
        if (points.length >= 2) {
          const bounds = boundsOfPoints(points);
          void this.commitAddMark({ type: 'freehand', frameId: this.state!.frameId, points, bounds, normalizedBounds: bounds } as Omit<Mark, 'id' | 'groupId'>);
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
        if (bounds.width < 2 && bounds.height < 2) {
          this.render();
          return;
        }
        if (this.tool === 'arrow') {
          void this.commitAddMark({ type: 'arrow', frameId: this.state!.frameId, from: start, to: point, bounds, normalizedBounds: bounds } as Omit<Mark, 'id' | 'groupId'>);
        } else if (this.tool === 'rectangle' || this.tool === 'ellipse' || this.tool === 'mask') {
          void this.commitAddMark({ type: this.tool, frameId: this.state!.frameId, bounds, normalizedBounds: bounds } as Omit<Mark, 'id' | 'groupId'>);
        }
      }
    });
  }

  private async commitAddMark(mark: Omit<Mark, 'id' | 'groupId'>): Promise<void> {
    await this.api.addMark(mark);
    await this.refresh();
  }

  async removeMark(markId: string): Promise<void> {
    await this.api.removeMark(markId);
    await this.refresh();
  }

  async undo(): Promise<void> {
    await this.api.undo();
    await this.refresh();
  }

  async redo(): Promise<void> {
    await this.api.redo();
    await this.refresh();
  }

  async createGroup(): Promise<void> {
    await this.api.createGroup();
    await this.refresh();
  }

  async setActiveGroup(groupId: string): Promise<void> {
    await this.api.setActiveGroup(groupId);
    await this.refresh();
  }

  async setGroupNote(groupId: string, note: string): Promise<void> {
    await this.api.setGroupNote(groupId, note || undefined);
    await this.refresh();
  }

  async setGlobalNote(note: string): Promise<void> {
    await this.api.setGlobalNote(note || undefined);
    await this.refresh();
  }

  async submit(): Promise<{ taskId: string }> {
    return this.api.submit();
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

  private renderLivePreviewDrag(start: { x: number; y: number }, end: { x: number; y: number }): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(this.panX, this.panY);
    ctx.scale(this.scale, this.scale);
    ctx.strokeStyle = this.activeColor();
    ctx.lineWidth = 2 / this.scale;
    if (this.tool === 'arrow') {
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
          ctx.font = `${14 / this.scale}px sans-serif`;
          ctx.fillText(mark.text, mark.anchor.x, mark.anchor.y);
          break;
        case 'mask':
          ctx.fillRect(mark.bounds.x, mark.bounds.y, mark.bounds.width, mark.bounds.height);
          break;
      }
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
