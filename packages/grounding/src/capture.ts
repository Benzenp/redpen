/**
 * Orchestrates one capture: runs the browser-side collector, grounds every
 * mark against it, and returns only the persisted `DomTarget[]` — the full
 * temporary index is discarded after this function returns
 * (docs/ARCHITECTURE.md §4.3: "전체 temporary index는 제출/취소 후 폐기한다").
 */
import type { Page } from 'playwright';
import type { Mark, DomTarget } from '@redpen/protocol/schema';
import { COLLECTOR_SOURCE } from './collector-source.js';
import { buildDomTargets } from './ground.js';
import type { RawDomIndex } from './types.js';

export async function collectDomIndex(page: Page): Promise<RawDomIndex> {
  return (await page.evaluate(COLLECTOR_SOURCE)) as RawDomIndex;
}

/**
 * Runs the collector against `page`, grounds `marks`, and returns targets.
 * The caller must not retain the intermediate `RawDomIndex` beyond this call.
 */
export async function captureAndGround(page: Page, frameId: string, marks: readonly Mark[]): Promise<DomTarget[]> {
  const index = await collectDomIndex(page);
  return buildDomTargets(frameId, marks, index);
}
