import { test } from 'node:test';
import assert from 'node:assert/strict';
import { colorForGroupNumber, GROUP_COLOR_PALETTE } from './palette.js';

test('colors are assigned in palette order for the first N groups', () => {
  for (let i = 0; i < GROUP_COLOR_PALETTE.length; i++) {
    assert.equal(colorForGroupNumber(i + 1), GROUP_COLOR_PALETTE[i]);
  }
});

test('palette cycles once group count exceeds palette length, but each color maps to a fixed number', () => {
  const wrapped = colorForGroupNumber(GROUP_COLOR_PALETTE.length + 1);
  assert.equal(wrapped, GROUP_COLOR_PALETTE[0]);
});

test('rejects non-positive or non-integer group numbers', () => {
  assert.throws(() => colorForGroupNumber(0));
  assert.throws(() => colorForGroupNumber(-1));
  assert.throws(() => colorForGroupNumber(1.5));
});
