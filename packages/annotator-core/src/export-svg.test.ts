import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderOverlaySvg } from './export-svg.js';
import { AnnotatorStore } from './store.js';
import type { NewMarkInput } from './store.js';

const FRAME = 'frm_test';

function rectMark(bounds: { x: number; y: number; width: number; height: number }): NewMarkInput {
  return { type: 'rectangle', frameId: FRAME, bounds, normalizedBounds: bounds };
}

test('renderOverlaySvg produces a well-formed SVG document containing every mark and group color', () => {
  const store = new AnnotatorStore();
  const group1 = store.getGroups()[0];
  const mark = store.addMark(rectMark({ x: 10, y: 10, width: 100, height: 40 }));

  const svg = renderOverlaySvg(
    { width: 1280, height: 900 },
    store.getMarks(),
    store.getGroups(),
    [{ groupNumber: group1.number, color: group1.color, cluster: { x: 60, y: 30, width: 100, height: 40 } }],
  );

  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, new RegExp(`data-mark-id="${mark.id}"`));
  assert.match(svg, new RegExp(`stroke="${group1.color}"`));
  assert.match(svg, /data-badge-number="1"/);
  assert.match(svg, /<\/svg>$/);
});

test('renderOverlaySvg escapes text mark content to avoid breaking the XML document', () => {
  const store = new AnnotatorStore();
  const group = store.getGroups()[0];
  store.addMark({
    type: 'text',
    frameId: FRAME,
    text: '<script>alert(1)</script> & "quoted"',
    anchor: { x: 5, y: 5 },
    bounds: { x: 5, y: 5, width: 1, height: 1 },
    normalizedBounds: { x: 5, y: 5, width: 1, height: 1 },
  });

  const svg = renderOverlaySvg({ width: 100, height: 100 }, store.getMarks(), store.getGroups(), []);
  assert.ok(!svg.includes('<script>alert(1)</script>'));
  assert.ok(svg.includes('&lt;script&gt;'));
  assert.ok(svg.includes('&quot;quoted&quot;'));
  assert.match(svg, /<foreignObject/);
  assert.match(svg, /white-space:pre-wrap/);
  void group;
});

test('renderOverlaySvg emits one SVG primitive per mark type without throwing', () => {
  const store = new AnnotatorStore();
  store.addMark(rectMark({ x: 0, y: 0, width: 10, height: 10 }));
  store.addMark({
    type: 'ellipse',
    frameId: FRAME,
    bounds: { x: 20, y: 20, width: 10, height: 10 },
    normalizedBounds: { x: 20, y: 20, width: 10, height: 10 },
  });
  store.addMark({
    type: 'arrow',
    frameId: FRAME,
    from: { x: 0, y: 0 },
    to: { x: 50, y: 50 },
    bounds: { x: 0, y: 0, width: 50, height: 50 },
    normalizedBounds: { x: 0, y: 0, width: 50, height: 50 },
  });
  const line = store.addMark({
    type: 'line',
    frameId: FRAME,
    from: { x: 20, y: 0 },
    to: { x: 70, y: 50 },
    bounds: { x: 20, y: 0, width: 50, height: 50 },
    normalizedBounds: { x: 20, y: 0, width: 50, height: 50 },
  });
  store.addMark({
    type: 'freehand',
    frameId: FRAME,
    points: [{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 10, y: 0 }],
    bounds: { x: 0, y: 0, width: 10, height: 5 },
    normalizedBounds: { x: 0, y: 0, width: 10, height: 5 },
  });
  store.addMark({
    type: 'mask',
    frameId: FRAME,
    bounds: { x: 0, y: 0, width: 30, height: 30 },
    normalizedBounds: { x: 0, y: 0, width: 30, height: 30 },
  });

  const svg = renderOverlaySvg({ width: 200, height: 200 }, store.getMarks(), store.getGroups(), []);
  assert.match(svg, /<rect/);
  assert.match(svg, /<ellipse/);
  assert.match(svg, /<line/);
  assert.match(svg, /<polyline/);
  assert.equal((svg.match(/<rect/g) ?? []).length, 2); // rectangle mark + mask mark
  assert.match(svg, new RegExp(`<line x1="20" y1="0" x2="70" y2="50" stroke="[^"]+" stroke-width="2" data-mark-id="${line.id}"`));
  assert.doesNotMatch(svg, new RegExp(`data-mark-id="${line.id}"[^>]*marker-end`));
});

test('renderOverlaySvg renders patch destinations and source-to-destination indicators', () => {
  const store = new AnnotatorStore();
  const patch = store.addMark({
    type: 'patch',
    frameId: FRAME,
    sourceRect: { x: 2, y: 4, width: 10, height: 8 },
    bounds: { x: 40, y: 50, width: 20, height: 16 },
    normalizedBounds: { x: 40, y: 50, width: 20, height: 16 },
  } as unknown as NewMarkInput);

  const svg = renderOverlaySvg({ width: 100, height: 100 }, store.getMarks(), store.getGroups(), []);
  assert.match(svg, new RegExp(`data-mark-id="${patch.id}"`));
  assert.match(svg, /x="2" y="4" width="10" height="8" fill="#fff"/);
  assert.match(svg, /stroke-dasharray="4 2"/);
  assert.match(svg, /x1="7" y1="8" x2="50" y2="58"/);
});
