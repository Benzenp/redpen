/**
 * In-memory runtime state layered on top of the persisted session record
 * (docs/ARCHITECTURE.md §2.4): wait-list of long-poll resolvers per session,
 * plus the captured-but-not-yet-submitted RawDomIndex/screenshot for the
 * `annotating` state. Nothing here is required to survive a daemon restart —
 * a restarted daemon just tells the caller to re-open/re-freeze
 * (docs/ARCHITECTURE.md §10 오류와 복구 table).
 */
import type { Page } from 'playwright';
import type { RawDomIndex } from '@redpen/grounding';

export interface AnnotatingCapture {
  frameId: string;
  screenshot: Buffer;
  domIndex: RawDomIndex;
  viewport: { width: number; height: number; deviceScaleFactor: number };
  scroll: { x: number; y: number };
  capturedAt: string;
}

interface SessionRuntimeEntry {
  page?: Page;
  capture?: AnnotatingCapture;
  waiters: Array<(taskId: string) => void>;
}

export class SessionRuntime {
  private readonly entries = new Map<string, SessionRuntimeEntry>();

  private entry(sessionId: string): SessionRuntimeEntry {
    let entry = this.entries.get(sessionId);
    if (!entry) {
      entry = { waiters: [] };
      this.entries.set(sessionId, entry);
    }
    return entry;
  }

  setPage(sessionId: string, page: Page): void {
    this.entry(sessionId).page = page;
  }

  getPage(sessionId: string): Page | undefined {
    return this.entries.get(sessionId)?.page;
  }

  setCapture(sessionId: string, capture: AnnotatingCapture): void {
    this.entry(sessionId).capture = capture;
  }

  getCapture(sessionId: string): AnnotatingCapture | undefined {
    return this.entries.get(sessionId)?.capture;
  }

  clearCapture(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (entry) entry.capture = undefined;
  }

  /** Resolves every pending `wait` call for this session with the submitted taskId. */
  notifySubmitted(sessionId: string, taskId: string): void {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    for (const waiter of entry.waiters) waiter(taskId);
    entry.waiters = [];
  }

  waitForSubmission(sessionId: string, timeoutMs: number): Promise<string | null> {
    return new Promise((resolve) => {
      const entry = this.entry(sessionId);
      const timer = setTimeout(() => {
        entry.waiters = entry.waiters.filter((w) => w !== onSubmit);
        resolve(null);
      }, timeoutMs);
      function onSubmit(taskId: string) {
        clearTimeout(timer);
        resolve(taskId);
      }
      entry.waiters.push(onSubmit);
    });
  }

  remove(sessionId: string): void {
    this.entries.delete(sessionId);
  }
}
