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
  submittedTaskId?: string;
  waiters: Array<{
    timer: ReturnType<typeof setTimeout> | null;
    resolve: (taskId: string | null) => void;
  }>;
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

  hasOpenPage(): boolean {
    for (const entry of this.entries.values()) {
      if (entry.page && !entry.page.isClosed()) return true;
    }
    return false;
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

  /** Latches the submitted taskId and resolves every pending wait for this session. */
  notifySubmitted(sessionId: string, taskId: string): void {
    const entry = this.entry(sessionId);
    entry.submittedTaskId = taskId;
    for (const waiter of entry.waiters) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.resolve(taskId);
    }
    entry.waiters = [];
  }

  waitForSubmission(sessionId: string, timeoutMs: number): Promise<string | null> {
    const entry = this.entry(sessionId);
    if (entry.submittedTaskId !== undefined) {
      return Promise.resolve(entry.submittedTaskId);
    }

    return new Promise((resolve) => {
      const waiter = {
        timer: null as ReturnType<typeof setTimeout> | null,
        resolve,
      };
      const timer = setTimeout(() => {
        entry.waiters = entry.waiters.filter((current) => current !== waiter);
        resolve(null);
      }, timeoutMs);
      waiter.timer = timer;
      entry.waiters.push(waiter);
    });
  }

  remove(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (entry) {
      for (const waiter of entry.waiters) {
        if (waiter.timer) clearTimeout(waiter.timer);
        waiter.resolve(null);
      }
    }
    this.entries.delete(sessionId);
  }

  clear(): void {
    for (const sessionId of [...this.entries.keys()]) this.remove(sessionId);
  }
}
