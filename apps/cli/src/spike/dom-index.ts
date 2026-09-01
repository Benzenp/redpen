/**
 * Visible DOM candidate collector used by the Phase 0 capture spike.
 *
 * Collects viewport-visible elements at the exact moment of screenshot capture so
 * that screen coordinates can later be mapped back to DOM elements ("grounding").
 *
 * Sensitive data handling (per docs/ARCHITECTURE.md #9, docs/IMPLEMENTATION_PLAN.md Phase 3):
 * - input values, password inputs, and script/style content are never collected.
 */

export interface DomCandidate {
  tempId: string;
  tag: string;
  role: string | null;
  accessibleName: string | null;
  textSummary: string | null;
  testIdHint: string | null;
  idHint: string | null;
  classHint: string | null;
  rect: { x: number; y: number; width: number; height: number };
}

export interface DomIndexResult {
  capturedAt: string;
  viewport: { width: number; height: number; deviceScaleFactor: number };
  scroll: { x: number; y: number };
  candidates: DomCandidate[];
}

/**
 * The actual browser-side collection logic lives in `dom-index-browser.js` as
 * plain untranspiled JS, because it is injected into the page via
 * `page.evaluate(<source text>)` and must not depend on esbuild/tsx compiler
 * helpers (e.g. `__name`) that do not exist once serialized into the page.
 * Keep that file's logic in sync with the shape of `DomIndexResult` below.
 */

/**
 * Given a CSS-pixel point (relative to the viewport at capture time), find the
 * best-matching DOM candidate by smallest containing/intersecting area.
 */
export function findCandidateAtPoint(
  index: DomIndexResult,
  point: { x: number; y: number },
): DomCandidate | null {
  let best: DomCandidate | null = null;
  let bestArea = Infinity;
  for (const candidate of index.candidates) {
    const { rect } = candidate;
    const within =
      point.x >= rect.x &&
      point.x <= rect.x + rect.width &&
      point.y >= rect.y &&
      point.y <= rect.y + rect.height;
    if (!within) continue;
    const area = rect.width * rect.height;
    if (area < bestArea) {
      bestArea = area;
      best = candidate;
    }
  }
  return best;
}
