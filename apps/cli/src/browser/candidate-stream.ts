import type { BrowserManager } from './manager.js';
import type { CDPSession, Page } from 'playwright';

const MAX_CANDIDATES = 9;
const MAX_CANDIDATE_ID_LENGTH = 64;
const MAX_TEXT_LENGTH = 16_384;
const MAX_KEY_LENGTH = 128;
const MAX_WHEEL_DELTA = 10_000;
const MAX_URL_LENGTH = 8_192;

export type CandidateStreamStatus = 'opening' | 'streaming' | 'error' | 'closed';

export interface CandidateFrame {
  candidateId: string;
  data: string;
  mimeType: 'image/jpeg';
  width: number;
  height: number;
  timestamp: number;
}

export interface CandidateStreamMetadata {
  candidateId: string;
  url: string;
  status: CandidateStreamStatus;
  width: number;
  height: number;
  timestamp: number | null;
  error?: string;
}

export type CandidateInput =
  | { type: 'pointerMove'; x: number; y: number }
  | { type: 'pointerDown'; x: number; y: number; button?: 'left' | 'middle' | 'right' }
  | { type: 'pointerUp'; x: number; y: number; button?: 'left' | 'middle' | 'right' }
  | { type: 'wheel'; x: number; y: number; deltaX: number; deltaY: number }
  | { type: 'keyDown'; key: string; code?: string; modifiers?: string[] }
  | { type: 'keyUp'; key: string; code?: string; modifiers?: string[] }
  | { type: 'insertText'; text: string };

export type CandidateStreamErrorCode =
  | 'INVALID_CANDIDATE_ID'
  | 'INVALID_URL'
  | 'CANDIDATE_LIMIT_REACHED'
  | 'CANDIDATE_NOT_FOUND'
  | 'INVALID_INPUT';

export class CandidateStreamError extends Error {
  constructor(readonly code: CandidateStreamErrorCode, message: string) {
    super(message);
    this.name = 'CandidateStreamError';
  }
}

type Listener = (frame: CandidateFrame) => void;

interface CandidateResource {
  metadata: CandidateStreamMetadata;
  page: Page;
  session: CDPSession;
  listeners: Set<Listener>;
  latestFrame: CandidateFrame | null;
}

function invalid(code: CandidateStreamErrorCode, message: string): never {
  throw new CandidateStreamError(code, message);
}

function validateCandidateId(candidateId: string): void {
  if (typeof candidateId !== 'string' || candidateId.length > MAX_CANDIDATE_ID_LENGTH || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(candidateId)) {
    invalid('INVALID_CANDIDATE_ID', `Invalid candidate ID: ${candidateId}`);
  }
}

function validateUrl(value: string): URL {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_URL_LENGTH) {
    return invalid('INVALID_URL', 'Candidate URL is empty or too large');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalid('INVALID_URL', 'Candidate URL must be an absolute loopback HTTP URL');
  }
  const hostname = url.hostname.toLowerCase();
  const loopback = hostname === 'localhost' || hostname === '::1' || hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(hostname);
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !loopback || url.username || url.password) {
    invalid('INVALID_URL', 'Candidate URL must be an unauthenticated loopback HTTP URL');
  }
  return url;
}

function finite(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    invalid('INVALID_INPUT', `${label} must be a finite number between ${min} and ${max}`);
  }
  return value;
}

function modifiersMask(modifiers: string[] | undefined): number {
  if (modifiers === undefined) return 0;
  if (!Array.isArray(modifiers) || modifiers.length > 4) invalid('INVALID_INPUT', 'Invalid keyboard modifiers');
  const flags: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
  let mask = 0;
  for (const modifier of modifiers) {
    if (typeof modifier !== 'string' || flags[modifier] === undefined) invalid('INVALID_INPUT', 'Invalid keyboard modifier');
    mask |= flags[modifier];
  }
  return mask;
}

/** Streams isolated execution-candidate tabs without touching managed target or annotator pages. */
export class CandidateStreamManager {
  private readonly candidates = new Map<string, CandidateResource>();

  constructor(private readonly browserManager: BrowserManager) {}

  async openCandidate(candidateId: string, targetUrl: string): Promise<CandidateStreamMetadata> {
    validateCandidateId(candidateId);
    const url = validateUrl(targetUrl);
    const existing = this.candidates.get(candidateId);
    if (existing) {
      if (existing.metadata.url !== url.toString()) invalid('INVALID_URL', 'Candidate ID is already open for a different URL');
      return this.metadata(existing);
    }
    if (this.candidates.size >= MAX_CANDIDATES) invalid('CANDIDATE_LIMIT_REACHED', `At most ${MAX_CANDIDATES} candidates may stream at once`);

    const context = await this.browserManager.ensureContext();
    const page = await context.newPage();
    let session: CDPSession | undefined;
    const metadata: CandidateStreamMetadata = {
      candidateId,
      url: url.toString(),
      status: 'opening',
      width: 0,
      height: 0,
      timestamp: null,
    };
    try {
      await page.goto(metadata.url, { waitUntil: 'load' });
      session = await context.newCDPSession(page);
      const resource: CandidateResource = { metadata, page, session, listeners: new Set(), latestFrame: null };
      this.candidates.set(candidateId, resource);
      session.on('Page.screencastFrame', (event: { data: string; sessionId: number; metadata?: { deviceWidth?: number; deviceHeight?: number } }) => {
        // Do not wait for listeners or image bookkeeping before returning this frame's CDP credit.
        void session!.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});
        const width = event.metadata?.deviceWidth ?? resource.metadata.width;
        const height = event.metadata?.deviceHeight ?? resource.metadata.height;
        const frame: CandidateFrame = { candidateId, data: event.data, mimeType: 'image/jpeg', width, height, timestamp: Date.now() };
        resource.latestFrame = frame;
        resource.metadata.width = width;
        resource.metadata.height = height;
        resource.metadata.timestamp = frame.timestamp;
        for (const listener of resource.listeners) {
          try { listener(frame); } catch { /* Subscribers cannot disrupt streaming. */ }
        }
      });
      page.once('close', () => {
        if (this.candidates.get(candidateId) === resource) {
          resource.metadata.status = 'closed';
          this.candidates.delete(candidateId);
          resource.listeners.clear();
          void resource.session.send('Page.stopScreencast').catch(() => {});
          void resource.session.detach().catch(() => {});
        }
      });
      await session.send('Page.startScreencast', { format: 'jpeg', quality: 80, everyNthFrame: 1 });
      metadata.status = 'streaming';
      return this.metadata(resource);
    } catch (error) {
      metadata.status = 'error';
      metadata.error = error instanceof Error ? error.message : String(error);
      if (session) await session.detach().catch(() => {});
      await page.close().catch(() => {});
      throw error;
    }
  }

  getCandidate(candidateId: string): CandidateStreamMetadata | undefined {
    validateCandidateId(candidateId);
    const resource = this.candidates.get(candidateId);
    return resource ? this.metadata(resource) : undefined;
  }

  listCandidates(): CandidateStreamMetadata[] {
    return [...this.candidates.values()].map((resource) => this.metadata(resource));
  }

  subscribe(candidateId: string, listener: Listener): () => void {
    validateCandidateId(candidateId);
    if (typeof listener !== 'function') invalid('INVALID_INPUT', 'Stream listener must be a function');
    const resource = this.requireCandidate(candidateId);
    resource.listeners.add(listener);
    if (resource.latestFrame) listener(resource.latestFrame);
    return () => resource.listeners.delete(listener);
  }

  async dispatchInput(candidateId: string, input: CandidateInput): Promise<void> {
    validateCandidateId(candidateId);
    const resource = this.requireCandidate(candidateId);
    if (!input || typeof input !== 'object' || typeof input.type !== 'string') invalid('INVALID_INPUT', 'Input must be an event object');
    const session = resource.session;
    switch (input.type) {
      case 'pointerMove':
      case 'pointerDown':
      case 'pointerUp': {
        const { x, y } = await this.viewportPoint(session, input.x, input.y);
        const button = input.type === 'pointerMove' ? 'none' : input.button ?? 'left';
        if (button !== 'none' && button !== 'left' && button !== 'middle' && button !== 'right') invalid('INVALID_INPUT', 'Invalid pointer button');
        await session.send('Input.dispatchMouseEvent', {
          type: input.type === 'pointerMove' ? 'mouseMoved' : input.type === 'pointerDown' ? 'mousePressed' : 'mouseReleased',
          x, y, button, clickCount: input.type === 'pointerMove' ? 0 : 1,
        });
        return;
      }
      case 'wheel': {
        const { x, y } = await this.viewportPoint(session, input.x, input.y);
        const deltaX = finite(input.deltaX, 'deltaX', -MAX_WHEEL_DELTA, MAX_WHEEL_DELTA);
        const deltaY = finite(input.deltaY, 'deltaY', -MAX_WHEEL_DELTA, MAX_WHEEL_DELTA);
        await session.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY });
        return;
      }
      case 'keyDown':
      case 'keyUp': {
        if (typeof input.key !== 'string' || input.key.length === 0 || input.key.length > MAX_KEY_LENGTH || (input.code !== undefined && (typeof input.code !== 'string' || input.code.length > MAX_KEY_LENGTH))) {
          invalid('INVALID_INPUT', 'Invalid key input');
        }
        await session.send('Input.dispatchKeyEvent', {
          type: input.type === 'keyDown' ? 'keyDown' : 'keyUp', key: input.key, code: input.code ?? '', modifiers: modifiersMask(input.modifiers),
        });
        return;
      }
      case 'insertText':
        if (typeof input.text !== 'string' || input.text.length > MAX_TEXT_LENGTH) invalid('INVALID_INPUT', 'Text payload is invalid or too large');
        await session.send('Input.insertText', { text: input.text });
        return;
      default:
        invalid('INVALID_INPUT', 'Unsupported input event');
    }
  }

  async closeCandidate(candidateId: string): Promise<void> {
    validateCandidateId(candidateId);
    const resource = this.candidates.get(candidateId);
    if (!resource) return;
    this.candidates.delete(candidateId);
    resource.metadata.status = 'closed';
    resource.listeners.clear();
    await resource.session.send('Page.stopScreencast').catch(() => {});
    await resource.session.detach().catch(() => {});
    await resource.page.close().catch(() => {});
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.candidates.keys()].map((candidateId) => this.closeCandidate(candidateId)));
  }

  private requireCandidate(candidateId: string): CandidateResource {
    const resource = this.candidates.get(candidateId);
    if (!resource) invalid('CANDIDATE_NOT_FOUND', `Candidate is not open: ${candidateId}`);
    return resource;
  }

  private metadata(resource: CandidateResource): CandidateStreamMetadata {
    return { ...resource.metadata };
  }

  private async viewportPoint(session: CDPSession, normalizedX: unknown, normalizedY: unknown): Promise<{ x: number; y: number }> {
    const x = finite(normalizedX, 'x', 0, 1);
    const y = finite(normalizedY, 'y', 0, 1);
    const metrics = await session.send('Page.getLayoutMetrics') as { cssLayoutViewport?: { clientWidth: number; clientHeight: number } };
    const width = metrics.cssLayoutViewport?.clientWidth;
    const height = metrics.cssLayoutViewport?.clientHeight;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width! <= 0 || height! <= 0) invalid('INVALID_INPUT', 'Candidate viewport is unavailable');
    return { x: x * width!, y: y * height! };
  }
}
