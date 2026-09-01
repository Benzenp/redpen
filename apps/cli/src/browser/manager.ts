/**
 * Managed Playwright browser (docs/ARCHITECTURE.md §3.5).
 *
 * One persistent Chromium profile per daemon process, stored outside the
 * repository under the global app-data directory. Pages are keyed by
 * sessionId so CLI/MCP calls addressing the same session reuse the same tab.
 */
import { chromium, type BrowserContext, type Page } from 'playwright';
import { browserProfileDir } from '@redpen/protocol/paths';
import { mkdir } from 'node:fs/promises';

/**
 * Headless by default (matches every automated check in this repo, and is
 * the safe default for an agent-spawned daemon), but overridable via
 * `REDPEN_HEADLESS=0` so a human running `redpen open` locally can actually
 * see the live page and the annotation tab that `freeze()` opens.
 */
function resolveHeadless(): boolean {
  const raw = process.env.REDPEN_HEADLESS;
  if (raw === undefined) return true;
  return raw !== '0' && raw.toLowerCase() !== 'false';
}

export class BrowserManager {
  private context: BrowserContext | null = null;
  private readonly pages = new Map<string, Page>();
  private readonly annotatorPages = new Map<string, Page>();

  async ensureContext(): Promise<BrowserContext> {
    if (this.context) return this.context;
    await mkdir(browserProfileDir(), { recursive: true });
    this.context = await chromium.launchPersistentContext(browserProfileDir(), {
      headless: resolveHeadless(),
      viewport: { width: 1280, height: 900 },
    });
    return this.context;
  }

  async openPage(sessionId: string, url: string): Promise<Page> {
    const context = await this.ensureContext();
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'load' });
    this.pages.set(sessionId, page);
    return page;
  }

  getPage(sessionId: string): Page | undefined {
    return this.pages.get(sessionId);
  }

  /**
   * Opens (or focuses, if already open) the annotation UI as a separate tab
   * in the SAME persistent context as the live target page
   * (docs/ARCHITECTURE.md \u00a74.2: "annotation UI\ub97c \ubcc4\ub3c4 local tab\uc73c\ub85c \uc5f0\ub2e4").
   */
  async openAnnotatorTab(sessionId: string, url: string): Promise<Page> {
    const existing = this.annotatorPages.get(sessionId);
    if (existing && !existing.isClosed()) {
      await existing.goto(url, { waitUntil: 'load' });
      await existing.bringToFront().catch(() => {});
      return existing;
    }
    const context = await this.ensureContext();
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'load' });
    await page.bringToFront().catch(() => {});
    this.annotatorPages.set(sessionId, page);
    return page;
  }

  getAnnotatorPage(sessionId: string): Page | undefined {
    return this.annotatorPages.get(sessionId);
  }

  async closePage(sessionId: string): Promise<void> {
    const page = this.pages.get(sessionId);
    if (page) {
      await page.close().catch(() => {});
      this.pages.delete(sessionId);
    }
    const annotatorPage = this.annotatorPages.get(sessionId);
    if (annotatorPage) {
      await annotatorPage.close().catch(() => {});
      this.annotatorPages.delete(sessionId);
    }
  }

  async closeAll(): Promise<void> {
    for (const sessionId of [...this.pages.keys(), ...this.annotatorPages.keys()]) {
      await this.closePage(sessionId);
    }
    if (this.context) {
      await this.context.close().catch(() => {});
      this.context = null;
    }
  }
}
