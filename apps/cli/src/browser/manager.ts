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

export class BrowserManager {
  private context: BrowserContext | null = null;
  private readonly pages = new Map<string, Page>();

  async ensureContext(): Promise<BrowserContext> {
    if (this.context) return this.context;
    await mkdir(browserProfileDir(), { recursive: true });
    this.context = await chromium.launchPersistentContext(browserProfileDir(), {
      headless: true,
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

  async closePage(sessionId: string): Promise<void> {
    const page = this.pages.get(sessionId);
    if (page) {
      await page.close().catch(() => {});
      this.pages.delete(sessionId);
    }
  }

  async closeAll(): Promise<void> {
    for (const sessionId of [...this.pages.keys()]) {
      await this.closePage(sessionId);
    }
    if (this.context) {
      await this.context.close().catch(() => {});
      this.context = null;
    }
  }
}
