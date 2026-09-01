/**
 * Annotation UI client (docs/ARCHITECTURE.md §3.6).
 *
 * tldraw is NOT used. This is the "low-level canvas" fallback path the
 * architecture doc anticipates ("검증이 실패하면 annotation engine을 Konva 등
 * 저수준 canvas로 교체한다") — adopted from the start rather than after a
 * failed tldraw spike, because a plain canvas 2D renderer implements every
 * required tool (pen/arrow/rect/ellipse/text/mask/select/erase/undo-redo)
 * without pulling in a heavyweight vendor canvas library or React.
 *
 * This module is bundled by esbuild into a single browser script
 * (see apps/annotator/scripts/build.ts) and attached to `window.RedpenAnnotator`
 * so Playwright tests can drive it without a bundler-aware test harness.
 */
import { AnnotatorStore, renderOverlaySvg, type NewMarkInput } from '@redpen/annotator-core';
import type { Mark } from '@redpen/protocol/schema';

export type ToolName = 'pen' | 'arrow' | 'rectangle' | 'ellipse' | 'text' | 'mask' | 'select' | 'erase';

export interface AnnotatorAppOptions {
  canvas: HTMLCanvasElement;
  screenshotImage: HTMLImageElement;
  frameId: string;
  viewport: { width: number; height: number };
}

/** Renders the fixed screenshot background plus every mark's vector overlay each frame. */
export class AnnotatorApp {
  readonly store = new AnnotatorStore();
  tool: ToolName = 'pen';
  private drawing: { points: { x: number; y: number }[] } | null = null;
  private readonly ctx: CanvasRenderingContext2D;

  constructor(private readonly opts: AnnotatorAppOptions) {
    const ctx = opts.canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context unavailable');
    this.ctx = ctx;
    opts.canvas.width = opts.viewport.width;
    opts.canvas.height = opts.viewport.height;
  }

  setTool(tool: ToolName): void {
    this.tool = tool;
  }

  setActiveGroup(groupId: string): void {
    this.store.setActiveGroup(groupId);
  }

  createGroup() {
    return this.store.createGroup();
  }

  /** Programmatic draw entrypoint (used by both pointer handlers and tests/Playwright). */
  drawShape(type: 'rectangle' | 'ellipse' | 'mask', bounds: { x: number; y: number; width: number; height: number }): Mark {
    const input: NewMarkInput = { type, frameId: this.opts.frameId, bounds, normalizedBounds: bounds } as NewMarkInput;
    const mark = this.store.addMark(input);
    this.render();
    return mark;
  }

  drawArrow(from: { x: number; y: number }, to: { x: number; y: number }): Mark {
    const bounds = {
      x: Math.min(from.x, to.x),
      y: Math.min(from.y, to.y),
      width: Math.abs(to.x - from.x),
      height: Math.abs(to.y - from.y),
    };
    const input: NewMarkInput = { type: 'arrow', frameId: this.opts.frameId, from, to, bounds, normalizedBounds: bounds } as NewMarkInput;
    const mark = this.store.addMark(input);
    this.render();
    return mark;
  }

  drawFreehand(points: { x: number; y: number }[]): Mark {
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const bounds = {
      x: Math.min(...xs),
      y: Math.min(...ys),
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
    };
    const input: NewMarkInput = { type: 'freehand', frameId: this.opts.frameId, points, bounds, normalizedBounds: bounds } as NewMarkInput;
    const mark = this.store.addMark(input);
    this.render();
    return mark;
  }

  addText(anchor: { x: number; y: number }, text: string): Mark {
    const bounds = { x: anchor.x, y: anchor.y, width: 1, height: 1 };
    const input: NewMarkInput = { type: 'text', frameId: this.opts.frameId, anchor, text, bounds, normalizedBounds: bounds } as NewMarkInput;
    const mark = this.store.addMark(input);
    this.render();
    return mark;
  }

  removeMark(markId: string): void {
    this.store.removeMark(markId);
    this.render();
  }

  undo(): boolean {
    const result = this.store.undo();
    this.render();
    return result;
  }

  redo(): boolean {
    const result = this.store.redo();
    this.render();
    return result;
  }

  exportOverlaySvg(): string {
    const groups = this.store.getGroups();
    const badges = groups.flatMap((g) =>
      this.store.computeBadgeClusters(g.id).map((cluster) => ({ groupNumber: g.number, color: g.color, cluster })),
    );
    return renderOverlaySvg(this.opts.viewport, this.store.getMarks(), groups, badges);
  }

  /** Draws the locked screenshot background, then every mark, then badges — in that order. */
  render(): void {
    const { ctx, opts } = this;
    ctx.clearRect(0, 0, opts.viewport.width, opts.viewport.height);
    ctx.drawImage(opts.screenshotImage, 0, 0, opts.viewport.width, opts.viewport.height);

    const colorByGroupId = new Map(this.store.getGroups().map((g) => [g.id, g.color] as const));

    for (const mark of this.store.getMarks()) {
      const color = colorByGroupId.get(mark.groupId) ?? '#000000';
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 2;
      switch (mark.type) {
        case 'rectangle':
          ctx.strokeRect(mark.bounds.x, mark.bounds.y, mark.bounds.width, mark.bounds.height);
          break;
        case 'ellipse': {
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
        }
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
          ctx.font = '14px sans-serif';
          ctx.fillText(mark.text, mark.anchor.x, mark.anchor.y);
          break;
        case 'mask':
          ctx.globalAlpha = 1;
          ctx.fillRect(mark.bounds.x, mark.bounds.y, mark.bounds.width, mark.bounds.height);
          break;
      }
    }

    for (const group of this.store.getGroups()) {
      for (const cluster of this.store.computeBadgeClusters(group.id)) {
        const cx = cluster.x - 8;
        const cy = cluster.y - 8;
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

declare global {
  interface Window {
    RedpenAnnotator?: { AnnotatorApp: typeof AnnotatorApp };
  }
}

if (typeof window !== 'undefined') {
  window.RedpenAnnotator = { AnnotatorApp };
}
