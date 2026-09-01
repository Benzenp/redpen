/**
 * Geometry primitives and coordinate transforms shared by the annotation UI,
 * DOM grounding, and task bundle schema (docs/ARCHITECTURE.md §6).
 *
 * Two coordinate systems are kept side by side for every mark/target:
 * - CSS pixel rect: relative to the captured viewport's CSS pixel box.
 * - Normalized rect: 0..1 fractions of the viewport, independent of any
 *   later resize/rescale of the stored screenshot.
 */

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Viewport {
  width: number;
  height: number;
  deviceScaleFactor: number;
}

export function cssRectToNormalized(rect: Rect, viewport: Pick<Viewport, 'width' | 'height'>): Rect {
  if (viewport.width <= 0 || viewport.height <= 0) {
    throw new RangeError('viewport width/height must be positive');
  }
  return {
    x: rect.x / viewport.width,
    y: rect.y / viewport.height,
    width: rect.width / viewport.width,
    height: rect.height / viewport.height,
  };
}

export function normalizedRectToCss(rect: Rect, viewport: Pick<Viewport, 'width' | 'height'>): Rect {
  return {
    x: rect.x * viewport.width,
    y: rect.y * viewport.height,
    width: rect.width * viewport.width,
    height: rect.height * viewport.height,
  };
}

export function cssPointToNormalized(point: Point, viewport: Pick<Viewport, 'width' | 'height'>): Point {
  if (viewport.width <= 0 || viewport.height <= 0) {
    throw new RangeError('viewport width/height must be positive');
  }
  return { x: point.x / viewport.width, y: point.y / viewport.height };
}

export function normalizedPointToCss(point: Point, viewport: Pick<Viewport, 'width' | 'height'>): Point {
  return { x: point.x * viewport.width, y: point.y * viewport.height };
}

export function rectArea(rect: Rect): number {
  return Math.max(0, rect.width) * Math.max(0, rect.height);
}

export function rectContainsPoint(rect: Rect, point: Point): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

export function intersectionArea(a: Rect, b: Rect): number {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= left || bottom <= top) return 0;
  return (right - left) * (bottom - top);
}
