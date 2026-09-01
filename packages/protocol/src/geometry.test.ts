import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cssRectToNormalized,
  normalizedRectToCss,
  cssPointToNormalized,
  normalizedPointToCss,
  rectContainsPoint,
  rectsIntersect,
  intersectionArea,
} from './geometry.js';

const viewport = { width: 1280, height: 900 };

test('cssRectToNormalized -> normalizedRectToCss round-trips for a grid of rects', () => {
  const samples = [
    { x: 0, y: 0, width: 1280, height: 900 },
    { x: 10, y: 20, width: 100, height: 40 },
    { x: 640, y: 450, width: 1, height: 1 },
    { x: 1279, y: 899, width: 0, height: 0 },
  ];
  for (const rect of samples) {
    const normalized = cssRectToNormalized(rect, viewport);
    const back = normalizedRectToCss(normalized, viewport);
    assert.ok(Math.abs(back.x - rect.x) < 1e-9, `x mismatch for ${JSON.stringify(rect)}`);
    assert.ok(Math.abs(back.y - rect.y) < 1e-9, `y mismatch for ${JSON.stringify(rect)}`);
    assert.ok(Math.abs(back.width - rect.width) < 1e-9, `width mismatch for ${JSON.stringify(rect)}`);
    assert.ok(Math.abs(back.height - rect.height) < 1e-9, `height mismatch for ${JSON.stringify(rect)}`);
  }
});

test('cssPointToNormalized -> normalizedPointToCss round-trips', () => {
  const points = [
    { x: 0, y: 0 },
    { x: 1280, y: 900 },
    { x: 640.5, y: 450.25 },
  ];
  for (const point of points) {
    const normalized = cssPointToNormalized(point, viewport);
    const back = normalizedPointToCss(normalized, viewport);
    assert.ok(Math.abs(back.x - point.x) < 1e-9);
    assert.ok(Math.abs(back.y - point.y) < 1e-9);
  }
});

test('normalized coordinates stay within [0,1] for in-viewport rects', () => {
  const rect = { x: 100, y: 200, width: 300, height: 50 };
  const normalized = cssRectToNormalized(rect, viewport);
  assert.ok(normalized.x >= 0 && normalized.x <= 1);
  assert.ok(normalized.y >= 0 && normalized.y <= 1);
  assert.ok(normalized.x + normalized.width <= 1 + 1e-9);
  assert.ok(normalized.y + normalized.height <= 1 + 1e-9);
});

test('cssRectToNormalized rejects a zero-size viewport', () => {
  assert.throws(() => cssRectToNormalized({ x: 0, y: 0, width: 10, height: 10 }, { width: 0, height: 900 }));
});

test('rectContainsPoint identifies inside, edge, and outside points', () => {
  const rect = { x: 10, y: 10, width: 100, height: 50 };
  assert.equal(rectContainsPoint(rect, { x: 50, y: 30 }), true);
  assert.equal(rectContainsPoint(rect, { x: 10, y: 10 }), true); // edge inclusive
  assert.equal(rectContainsPoint(rect, { x: 110, y: 60 }), true); // far edge inclusive
  assert.equal(rectContainsPoint(rect, { x: 9, y: 30 }), false);
  assert.equal(rectContainsPoint(rect, { x: 50, y: 61 }), false);
});

test('rectsIntersect and intersectionArea agree on overlapping rects', () => {
  const a = { x: 0, y: 0, width: 100, height: 100 };
  const b = { x: 50, y: 50, width: 100, height: 100 };
  assert.equal(rectsIntersect(a, b), true);
  assert.equal(intersectionArea(a, b), 50 * 50);
});

test('rectsIntersect is false for disjoint rects and area is zero', () => {
  const a = { x: 0, y: 0, width: 10, height: 10 };
  const b = { x: 20, y: 20, width: 10, height: 10 };
  assert.equal(rectsIntersect(a, b), false);
  assert.equal(intersectionArea(a, b), 0);
});

test('rectsIntersect is false for merely touching (adjacent) rects', () => {
  const a = { x: 0, y: 0, width: 10, height: 10 };
  const b = { x: 10, y: 0, width: 10, height: 10 };
  assert.equal(rectsIntersect(a, b), false);
});
