import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import type { Mark } from '@redpen/protocol/schema';
import { compositeMarksOntoScreenshot } from './composite.js';

const FRAME = 'frm_composite';

function pixelIndex(width: number, x: number, y: number): number {
  return (y * width + x) * 4;
}

function solidPng(width: number, height: number, rgba: [number, number, number, number]): Buffer {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = pixelIndex(width, x, y);
      png.data[index] = rgba[0];
      png.data[index + 1] = rgba[1];
      png.data[index + 2] = rgba[2];
      png.data[index + 3] = rgba[3];
    }
  }
  return PNG.sync.write(png);
}

function mark(input: object): Mark {
  return input as Mark;
}

test('compositeMarksOntoScreenshot moves patch pixels and clears the source to whitespace', () => {
  const screenshot = PNG.sync.read(solidPng(10, 10, [0, 0, 255, 255]));
  for (const [x, y] of [
    [1, 1],
    [2, 1],
    [1, 2],
    [2, 2],
  ] as const) {
    const index = pixelIndex(10, x, y);
    screenshot.data[index] = 255;
    screenshot.data[index + 1] = 0;
    screenshot.data[index + 2] = 0;
  }

  const result = PNG.sync.read(
    compositeMarksOntoScreenshot(
      PNG.sync.write(screenshot),
      [
        mark({
          type: 'patch',
          id: 'patch-1',
          groupId: 'group-1',
          frameId: FRAME,
          sourceRect: { x: 1, y: 1, width: 2, height: 2 },
          bounds: { x: 5, y: 5, width: 2, height: 2 },
          normalizedBounds: { x: 5, y: 5, width: 2, height: 2 },
        }),
      ],
    ),
  );

  for (const [x, y] of [
    [5, 5],
    [6, 5],
    [5, 6],
    [6, 6],
  ] as const) {
    const index = pixelIndex(10, x, y);
    assert.equal(result.data[index], 255);
    assert.equal(result.data[index + 1], 0);
    assert.equal(result.data[index + 2], 0);
    assert.equal(result.data[index + 3], 255);
  }
  for (const [x, y] of [
    [1, 1],
    [2, 1],
    [1, 2],
    [2, 2],
  ] as const) {
    const index = pixelIndex(10, x, y);
    assert.equal(result.data[index], 255);
    assert.equal(result.data[index + 1], 255);
    assert.equal(result.data[index + 2], 255);
    assert.equal(result.data[index + 3], 255);
  }
});
