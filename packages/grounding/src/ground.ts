/**
 * DOM grounding: intersects mark geometry with the visible DOM candidate
 * index to produce ranked `DomTarget`s (docs/ARCHITECTURE.md §4.3,
 * docs/IMPLEMENTATION_PLAN.md Phase 3).
 *
 * Per-mark-type scoring:
 * - rectangle/ellipse/mask: bounding-box intersection area / candidate area
 *   (containment and overlap both score well; a huge ancestor scores low).
 * - freehand: point-in-candidate-rect proximity sampled along the path.
 * - arrow/line: `from` point -> arrow-source nearest candidate,
 *               `to` point -> arrow-destination nearest candidate.
 * - text: anchor point -> nearest containing element.
 * - blank-area sketch (no intersecting/near candidate at all): falls back to
 *   the nearest layout container by center-distance.
 *
 * "정확도 원칙": multiple similar candidates are never collapsed to one —
 * ranking is preserved and the top N are kept per group (deduped by tempId).
 */
import type { Mark, DomTarget, DomTargetRelation } from '@redpen/protocol/schema';
import { rectContainsPoint, intersectionArea, rectArea } from '@redpen/protocol/geometry';
import { generateTargetId } from '@redpen/protocol/ids';
import type { RawDomCandidate, RawDomIndex } from './types.js';
import { buildSelectorHints } from './selector-hints.js';

export interface ScoredCandidate {
  candidate: RawDomCandidate;
  score: number;
  relation: DomTargetRelation;
}

const MAX_TARGETS_PER_MARK = 5;
const COMPUTED_LAYOUT_ALLOWLIST = [
  'display',
  'position',
  'gap',
  'padding',
  'margin',
  'width',
  'height',
  'fontSize',
  'fontWeight',
  'lineHeight',
  'color',
  'backgroundColor',
] as const;

function centerOf(rect: { x: number; y: number; width: number; height: number }) {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function scoreByOverlap(bounds: Mark['bounds'], candidates: RawDomCandidate[]): ScoredCandidate[] {
  const scored: ScoredCandidate[] = [];
  for (const candidate of candidates) {
    const area = intersectionArea(bounds, candidate.rect);
    if (area <= 0) continue;
    const candidateArea = rectArea(candidate.rect);
    const markArea = rectArea(bounds);
    const relation: DomTargetRelation =
      area >= candidateArea - 1e-6 ? 'contains' : area >= markArea - 1e-6 ? 'intersects' : 'intersects';
    // Intersection-over-union: rewards a candidate whose size closely matches
    // the mark's footprint, so a tightly-drawn box over a small element beats
    // a huge ancestor that merely happens to fully contain the mark too.
    const unionArea = candidateArea + markArea - area;
    const iou = unionArea > 0 ? area / unionArea : 0;
    scored.push({ candidate, score: iou, relation });
  }
  return scored;
}

function scoreByProximity(points: { x: number; y: number }[], candidates: RawDomCandidate[]): ScoredCandidate[] {
  const scored: ScoredCandidate[] = [];
  for (const candidate of candidates) {
    let bestPointScore = 0;
    let insideAny = false;
    for (const point of points) {
      if (rectContainsPoint(candidate.rect, point)) {
        insideAny = true;
        bestPointScore = 1;
        break;
      }
      const d = distance(point, centerOf(candidate.rect));
      const proximityScore = 1 / (1 + d / 50);
      bestPointScore = Math.max(bestPointScore, proximityScore);
    }
    if (bestPointScore > 0) {
      scored.push({ candidate, score: bestPointScore, relation: insideAny ? 'intersects' : 'nearest' });
    }
  }
  return scored;
}

function nearestContainer(anchor: { x: number; y: number }, candidates: RawDomCandidate[]): ScoredCandidate[] {
  let best: ScoredCandidate | null = null;
  for (const candidate of candidates) {
    const d = distance(anchor, centerOf(candidate.rect));
    const score = 1 / (1 + d / 50);
    if (!best || score > best.score) {
      best = { candidate, score, relation: 'nearest' };
    }
  }
  return best ? [best] : [];
}

/** Scores all candidates for a single mark, per the rules above. */
export function scoreCandidatesForMark(mark: Mark, index: RawDomIndex): ScoredCandidate[] {
  switch (mark.type) {
    case 'rectangle':
    case 'ellipse':
    case 'mask':
    case 'patch':
      return scoreByOverlap(mark.bounds, index.candidates);
    case 'freehand':
      return scoreByProximity(mark.points, index.candidates);
    case 'text':
      return scoreByOverlap(mark.bounds, index.candidates);
    case 'arrow':
    case 'line': {
      const sourceRelation: DomTargetRelation = mark.type === 'arrow' ? 'arrow-source' : 'line-start';
      const destinationRelation: DomTargetRelation = mark.type === 'arrow' ? 'arrow-destination' : 'line-end';
      const sourceScored = nearestContainer(mark.from, index.candidates).map((s) => ({
        ...s,
        relation: sourceRelation,
      }));
      const destScored = nearestContainer(mark.to, index.candidates).map((s) => ({
        ...s,
        relation: destinationRelation,
      }));
      return [...sourceScored, ...destScored];
    }
  }
}

/** Falls back to nearest-container scoring when overlap/proximity found nothing (blank-area sketch). */
export function groundMark(mark: Mark, index: RawDomIndex): ScoredCandidate[] {
  const primary = scoreCandidatesForMark(mark, index);
  if (primary.length > 0) {
    return primary.sort((a, b) => b.score - a.score).slice(0, MAX_TARGETS_PER_MARK);
  }
  if (mark.type === 'arrow' || mark.type === 'line') return primary; // already tried nearest-container internally
  const center = centerOf(mark.bounds);
  return nearestContainer(center, index.candidates);
}

function toComputedLayoutSubset(raw: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of COMPUTED_LAYOUT_ALLOWLIST) {
    if (raw[key] !== undefined) out[key] = raw[key];
  }
  return out;
}

/**
 * Builds the persisted `DomTarget[]` for one frame: grounds every mark,
 * then deduplicates by tempId per group (docs/ARCHITECTURE.md §6:
 * "group별 target ranking과 중복 제거").
 */
export function buildDomTargets(frameId: string, marks: readonly Mark[], index: RawDomIndex): DomTarget[] {
  const targetsByTempId = new Map<string, DomTarget>();

  for (const mark of marks) {
    const scored = groundMark(mark, index);
    for (const { candidate, relation } of scored) {
      const key = candidate.tempId;
      let target = targetsByTempId.get(key);
      if (!target) {
        target = {
          id: generateTargetId(),
          frameId,
          groupIds: [],
          rect: candidate.rect,
          tag: candidate.tag,
          role: candidate.role,
          accessibleName: candidate.accessibleName,
          text: candidate.textSummary,
          selectorHints: buildSelectorHints(candidate),
          attributes: candidate.attributes,
          relation,
          context: {
            parent: candidate.parent ?? undefined,
            siblings: candidate.siblings,
            computedLayout: toComputedLayoutSubset(candidate.computedLayout),
          },
        };
        targetsByTempId.set(key, target);
      }
      if (!target.groupIds.includes(mark.groupId)) {
        target.groupIds.push(mark.groupId);
      }
    }
  }

  return Array.from(targetsByTempId.values());
}
