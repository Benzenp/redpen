import { PNG } from 'pngjs';
import type { Mark } from '@redpen/protocol/schema';
import type { Rect } from '@redpen/protocol/geometry';

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function fillRect(
  destination: Buffer,
  destinationWidth: number,
  destinationHeight: number,
  rect: Rect,
  rgba: readonly [number, number, number, number],
): void {
  const left = clamp(Math.floor(rect.x), 0, destinationWidth);
  const top = clamp(Math.floor(rect.y), 0, destinationHeight);
  const right = clamp(Math.ceil(rect.x + rect.width), 0, destinationWidth);
  const bottom = clamp(Math.ceil(rect.y + rect.height), 0, destinationHeight);
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      const index = (y * destinationWidth + x) * 4;
      destination[index] = rgba[0];
      destination[index + 1] = rgba[1];
      destination[index + 2] = rgba[2];
      destination[index + 3] = rgba[3];
    }
  }
}

/**
 * Copies a source rectangle into a destination rectangle using nearest
 * neighbour sampling. Coordinates and dimensions are already device pixels;
 * callers are responsible for applying a screenshot's deviceScaleFactor to
 * CSS-pixel mark bounds before invoking this function.
 */
function copyScaled(
  source: { width: number; height: number; data: Buffer },
  sourceRect: Rect,
  destinationRect: Rect,
  destination: Buffer,
  destinationWidth: number,
  destinationHeight: number,
): void {
  const sourceX = Math.round(sourceRect.x);
  const sourceY = Math.round(sourceRect.y);
  const sourceWidth = Math.max(0, Math.round(sourceRect.width));
  const sourceHeight = Math.max(0, Math.round(sourceRect.height));
  const destinationX = Math.round(destinationRect.x);
  const destinationY = Math.round(destinationRect.y);
  const destinationWidthPixels = Math.max(0, Math.round(destinationRect.width));
  const destinationHeightPixels = Math.max(0, Math.round(destinationRect.height));

  if (
    sourceWidth === 0 ||
    sourceHeight === 0 ||
    destinationWidthPixels === 0 ||
    destinationHeightPixels === 0 ||
    source.width === 0 ||
    source.height === 0
  ) {
    return;
  }

  for (let destinationOffsetY = 0; destinationOffsetY < destinationHeightPixels; destinationOffsetY++) {
    const y = destinationY + destinationOffsetY;
    if (y < 0 || y >= destinationHeight) continue;
    const sampledY = clamp(
      sourceY + Math.floor((destinationOffsetY * sourceHeight) / destinationHeightPixels),
      0,
      source.height - 1,
    );

    for (let destinationOffsetX = 0; destinationOffsetX < destinationWidthPixels; destinationOffsetX++) {
      const x = destinationX + destinationOffsetX;
      if (x < 0 || x >= destinationWidth) continue;
      const sampledX = clamp(
        sourceX + Math.floor((destinationOffsetX * sourceWidth) / destinationWidthPixels),
        0,
        source.width - 1,
      );
      const sourceIndex = (sampledY * source.width + sampledX) * 4;
      const destinationIndex = (y * destinationWidth + x) * 4;
      destination[destinationIndex] = source.data[sourceIndex];
      destination[destinationIndex + 1] = source.data[sourceIndex + 1];
      destination[destinationIndex + 2] = source.data[sourceIndex + 2];
      destination[destinationIndex + 3] = source.data[sourceIndex + 3];
    }
  }
}

/**
 * Applies patch marks to a screenshot PNG and returns a new PNG.
 * Mark rectangles supplied to this function are already in device-pixel
 * coordinates; CSS-pixel to device-pixel scaling is the caller's
 * responsibility. Marks are composited in array order.
 */
export function compositeMarksOntoScreenshot(
  screenshotPng: Buffer,
  marks: readonly Mark[],
): Buffer {
  const screenshot = PNG.sync.read(screenshotPng);

  for (const mark of marks) {
    if (mark.type === 'patch') {
      // A patch may overlap its own source. Snapshot the current image before
      // writing so sampling never observes pixels written earlier in the copy.
      const sourceSnapshot = {
        width: screenshot.width,
        height: screenshot.height,
        data: Buffer.from(screenshot.data),
      };
      fillRect(screenshot.data, screenshot.width, screenshot.height, mark.sourceRect, [255, 255, 255, 255]);
      copyScaled(sourceSnapshot, mark.sourceRect, mark.bounds, screenshot.data, screenshot.width, screenshot.height);
    }
  }

  return PNG.sync.write(screenshot);
}
