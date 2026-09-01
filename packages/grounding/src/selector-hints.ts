/**
 * Selector hint generation (docs/IMPLEMENTATION_PLAN.md Phase 3: "selector
 * hint 생성: test ID → stable ID → role/name → structural hint 순서").
 *
 * Hints are ordered strongest-first but are explicitly NOT guaranteed to be
 * executable selectors (docs/IMPLEMENTATION_PLAN.md "정확도 원칙") — they are
 * code-search clues for a coding agent, not a locator API.
 */
import type { RawDomCandidate } from './types.js';

export function buildSelectorHints(candidate: RawDomCandidate): string[] {
  const hints: string[] = [];

  if (candidate.testIdHint) {
    hints.push(`[data-testid="${candidate.testIdHint}"]`);
  }
  if (candidate.idHint) {
    hints.push(`#${candidate.idHint}`);
  }
  if (candidate.role && candidate.accessibleName) {
    hints.push(`role=${candidate.role}[name="${candidate.accessibleName}"]`);
  } else if (candidate.accessibleName) {
    hints.push(`text="${candidate.accessibleName}"`);
  }
  if (candidate.classHint) {
    const firstClass = candidate.classHint.split(/\s+/).filter(Boolean)[0];
    if (firstClass) hints.push(`${candidate.tag}.${firstClass}`);
  }
  // Structural fallback: always present so a target is never selector-less.
  hints.push(candidate.tag);

  return hints;
}
