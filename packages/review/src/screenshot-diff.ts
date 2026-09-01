/**
 * Same-environment screenshot diff (docs/IMPLEMENTATION_PLAN.md Phase 6:
 * "동일 환경 screenshot diff 옵션"; docs/ARCHITECTURE.md §11 notes
 * Playwright visual comparison is sensitive to render environment, so diffs
 * are only meaningful within one environment/run — this module makes no
 * cross-machine promises).
 */
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

export interface DiffResult {
  width: number;
  height: number;
  diffPixelCount: number;
  totalPixels: number;
  diffRatio: number;
  diffPng: Buffer;
}

export class DimensionMismatchError extends Error {
  constructor(public readonly before: { width: number; height: number }, public readonly after: { width: number; height: number }) {
    super(`cannot diff screenshots of different dimensions: before=${before.width}x${before.height} after=${after.width}x${after.height}`);
    this.name = 'DimensionMismatchError';
  }
}

/** Diffs two same-size PNG buffers captured in the same environment. */
export function diffScreenshots(beforePng: Buffer, afterPng: Buffer, threshold = 0.1): DiffResult {
  const before = PNG.sync.read(beforePng);
  const after = PNG.sync.read(afterPng);

  if (before.width !== after.width || before.height !== after.height) {
    throw new DimensionMismatchError(before, after);
  }

  const { width, height } = before;
  const diff = new PNG({ width, height });
  const diffPixelCount = pixelmatch(before.data, after.data, diff.data, width, height, { threshold });

  return {
    width,
    height,
    diffPixelCount,
    totalPixels: width * height,
    diffRatio: diffPixelCount / (width * height),
    diffPng: PNG.sync.write(diff),
  };
}
