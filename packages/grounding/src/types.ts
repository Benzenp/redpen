/** Raw candidate shape produced by `collector-source.ts` inside the browser. */
export interface RawElementSummary {
  tag: string;
  role: string | null;
  accessibleName: string | null;
  textSummary: string | null;
}

export interface RawDomCandidate {
  tempId: string;
  tag: string;
  role: string | null;
  accessibleName: string | null;
  textSummary: string | null;
  testIdHint: string | null;
  idHint: string | null;
  classHint: string | null;
  rect: { x: number; y: number; width: number; height: number };
  attributes: Record<string, string>;
  parent: RawElementSummary | null;
  siblings: RawElementSummary[];
  computedLayout: Record<string, string>;
}

export interface RawDomIndex {
  capturedAt: string;
  viewport: { width: number; height: number; deviceScaleFactor: number };
  scroll: { x: number; y: number };
  candidates: RawDomCandidate[];
}
