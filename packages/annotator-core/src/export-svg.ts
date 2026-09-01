/**
 * Vendor-canvas-independent SVG export (docs/ARCHITECTURE.md §2.2, §3.6:
 * "Adapter가 필요한 mark만 Redpen schema로 변환한다").
 *
 * Takes canonical `Mark` + `InstructionGroup` data (never a vendor canvas
 * library's native state) and renders a standalone `overlay.svg` string.
 */
import type { InstructionGroup, Mark } from '@redpen/protocol/schema';

function escapeXml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function markToSvgElement(mark: Mark, color: string): string {
  switch (mark.type) {
    case 'rectangle':
      return `<rect x="${mark.bounds.x}" y="${mark.bounds.y}" width="${mark.bounds.width}" height="${mark.bounds.height}" fill="none" stroke="${color}" stroke-width="2" data-mark-id="${mark.id}" data-group-id="${mark.groupId}" />`;
    case 'ellipse': {
      const cx = mark.bounds.x + mark.bounds.width / 2;
      const cy = mark.bounds.y + mark.bounds.height / 2;
      return `<ellipse cx="${cx}" cy="${cy}" rx="${mark.bounds.width / 2}" ry="${mark.bounds.height / 2}" fill="none" stroke="${color}" stroke-width="2" data-mark-id="${mark.id}" data-group-id="${mark.groupId}" />`;
    }
    case 'arrow':
      return `<line x1="${mark.from.x}" y1="${mark.from.y}" x2="${mark.to.x}" y2="${mark.to.y}" stroke="${color}" stroke-width="2" marker-end="url(#redpen-arrowhead)" data-mark-id="${mark.id}" data-group-id="${mark.groupId}" />`;
    case 'freehand': {
      const points = mark.points.map((p) => `${p.x},${p.y}`).join(' ');
      return `<polyline points="${points}" fill="none" stroke="${color}" stroke-width="2" data-mark-id="${mark.id}" data-group-id="${mark.groupId}" />`;
    }
    case 'text':
      return `<text x="${mark.anchor.x}" y="${mark.anchor.y}" fill="${color}" font-size="14" data-mark-id="${mark.id}" data-group-id="${mark.groupId}">${escapeXml(mark.text)}</text>`;
    case 'mask':
      return `<rect x="${mark.bounds.x}" y="${mark.bounds.y}" width="${mark.bounds.width}" height="${mark.bounds.height}" fill="${color}" fill-opacity="1" data-mark-id="${mark.id}" data-group-id="${mark.groupId}" />`;
  }
}

function badgeToSvgElement(x: number, y: number, number: number, color: string): string {
  return (
    `<g data-badge-number="${number}">` +
    `<circle cx="${x}" cy="${y}" r="12" fill="${color}" stroke="white" stroke-width="2" />` +
    `<text x="${x}" y="${y}" fill="white" font-size="12" font-weight="bold" text-anchor="middle" dominant-baseline="central">${number}</text>` +
    `</g>`
  );
}

export interface BadgePlacement {
  groupNumber: number;
  color: string;
  cluster: { x: number; y: number; width: number; height: number };
}

export function renderOverlaySvg(
  viewport: { width: number; height: number },
  marks: readonly Mark[],
  groups: readonly InstructionGroup[],
  badges: readonly BadgePlacement[],
): string {
  const colorByGroupId = new Map(groups.map((g) => [g.id, g.color] as const));
  const markElements = marks
    .map((mark) => markToSvgElement(mark, colorByGroupId.get(mark.groupId) ?? '#000000'))
    .join('\n  ');
  const badgeElements = badges
    .map((b) => badgeToSvgElement(b.cluster.x - 12, b.cluster.y - 12, b.groupNumber, b.color))
    .join('\n  ');

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${viewport.width}" height="${viewport.height}" viewBox="0 0 ${viewport.width} ${viewport.height}">`,
    `<defs><marker id="redpen-arrowhead" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto"><path d="M0,0 L10,5 L0,10 Z" /></marker></defs>`,
    `  ${markElements}`,
    `  ${badgeElements}`,
    `</svg>`,
  ].join('\n');
}
