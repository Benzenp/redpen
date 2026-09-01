import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { diffScreenshots, DimensionMismatchError } from './screenshot-diff.js';

function solidPng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) {
    png.data[i * 4] = rgb[0];
    png.data[i * 4 + 1] = rgb[1];
    png.data[i * 4 + 2] = rgb[2];
    png.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(png);
}

test('identical screenshots produce zero diff pixels', () => {
  const a = solidPng(20, 20, [255, 0, 0]);
  const b = solidPng(20, 20, [255, 0, 0]);
  const result = diffScreenshots(a, b);
  assert.equal(result.diffPixelCount, 0);
  assert.equal(result.diffRatio, 0);
});

test('a fully different screenshot produces a full diff', () => {
  const a = solidPng(20, 20, [255, 0, 0]);
  const b = solidPng(20, 20, [0, 255, 0]);
  const result = diffScreenshots(a, b);
  assert.equal(result.diffPixelCount, 20 * 20);
  assert.equal(result.diffRatio, 1);
});

test('a partial change produces a proportional diff ratio', () => {
  const width = 10;
  const height = 10;
  const before = new PNG({ width, height });
  const after = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) {
    before.data[i * 4] = 0;
    before.data[i * 4 + 1] = 0;
    before.data[i * 4 + 2] = 0;
    before.data[i * 4 + 3] = 255;
    after.data[i * 4] = 0;
    after.data[i * 4 + 1] = 0;
    after.data[i * 4 + 2] = 0;
    after.data[i * 4 + 3] = 255;
  }
  // Change exactly the top row (10 of 100 pixels) to white.
  for (let x = 0; x < width; x++) {
    const idx = x * 4;
    after.data[idx] = 255;
    after.data[idx + 1] = 255;
    after.data[idx + 2] = 255;
  }
  const result = diffScreenshots(PNG.sync.write(before), PNG.sync.write(after));
  assert.equal(result.diffPixelCount, 10);
  assert.equal(result.diffRatio, 0.1);
});

test('mismatched dimensions throw DimensionMismatchError instead of a confusing pixelmatch error', () => {
  const a = solidPng(10, 10, [0, 0, 0]);
  const b = solidPng(20, 20, [0, 0, 0]);
  assert.throws(() => diffScreenshots(a, b), DimensionMismatchError);
});
