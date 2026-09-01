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
 * Headed (visible) by default. Redpen's entire point is that the user
 * looks at the live page and draws on it (docs/PRODUCT_INTENT.md "Visual
 * first") \u2014 a headless browser makes the product unusable, since there is
 * no window for the user to see or click on. Automated checks in this repo
 * are the only legitimate reason to run headless, and they always set
 * `REDPEN_HEADLESS=1` explicitly rather than relying on a default. Do not
 * flip this default back to headless; if a daemon needs to run unattended
 * (e.g. spawned by an agent with no human present), that caller must still
 * pass `REDPEN_HEADLESS=1` deliberately, not inherit it silently.
 */
function resolveHeadless(): boolean {
  const raw = process.env.REDPEN_HEADLESS;
  if (raw === undefined) return false;
  return raw === '1' || raw.toLowerCase() === 'true';
}

/**
 * Injected into every target page via addInitScript so the user has a
 * visible, discoverable way to trigger "freeze" without needing a separate
 * terminal/CLI command running alongside the browser. Previously `freeze`
 * only existed as a CLI/MCP call the agent issued on the user's behalf \u2014
 * there was no in-page affordance at all, so a user driving the browser
 * themselves had no way to know freezing was even possible.
 *
 * Kept as a plain injected string (not bundled/compiled) since it's a tiny,
 * dependency-free DOM widget and Playwright's addInitScript only accepts a
 * function or string evaluated in the page context, not a module import.
 */
// Written as a raw source string (not a TS function passed to
// addInitScript) because esbuild/tsx wraps named function declarations
// with a `__name(fn, "fn")` helper call for class-name-preservation
// purposes; Playwright serializes the function to its `.toString()` source
// and evaluates it standalone in the page context, where that `__name`
// helper doesn't exist \u2014 causing a silent `ReferenceError: __name is not
// defined` inside the init script (i.e. the whole overlay never installs).
// A plain string body sidesteps that transform entirely.
const FREEZE_OVERLAY_SCRIPT_SOURCE = `(function(origin) {
  var STYLE_ID = '__redpen_freeze_overlay_style__';
  var BUTTON_ID = '__redpen_freeze_overlay_button__';
  var TOAST_ID = '__redpen_freeze_overlay_toast__';

  var sessionId = '';
  window.__redpenSetSessionId = function (id) { sessionId = id; };

  function activeModalHost() {
    var dialogs = Array.prototype.slice.call(document.querySelectorAll('dialog[open]'));
    for (var i = dialogs.length - 1; i >= 0; i--) {
      try {
        if (dialogs[i].matches(':modal')) return dialogs[i];
      } catch (_) {
        return dialogs[i];
      }
    }
    return document.querySelector('[aria-modal="true"]') || document.documentElement;
  }

  function syncOverlayHost() {
    var host = activeModalHost();
    var button = document.getElementById(BUTTON_ID);
    var toast = document.getElementById(TOAST_ID);
    if (button && button.parentElement !== host) host.appendChild(button);
    if (toast && toast.parentElement !== host) host.appendChild(toast);
  }

  function showToast(text, isError) {
    var toast = document.getElementById(TOAST_ID);
    if (!toast) {
      toast = document.createElement('div');
      toast.id = TOAST_ID;
      document.documentElement.appendChild(toast);
    }
    syncOverlayHost();
    toast.textContent = text;
    toast.style.cssText = [
      'position:fixed', 'bottom:20px', 'right:20px', 'z-index:2147483647',
      'padding:10px 16px', 'border-radius:8px', 'font:600 13px system-ui,sans-serif',
      'background:' + (isError ? '#dc2626' : '#18181b'), 'color:#fff',
      'box-shadow:0 4px 12px rgba(0,0,0,.25)', 'transition:opacity .2s ease', 'opacity:1'
    ].join(';');
    setTimeout(function () {
      if (toast) toast.style.opacity = '0';
    }, 2200);
  }

  function pollForSubmission() {
    var timer = setInterval(function () {
      fetch('http://127.0.0.1:' + origin.port + '/sessions/' + sessionId + '?token=' + origin.token)
        .then(function (res) { return res.ok ? res.json() : null; })
        .then(function (body) {
          if (!body) return;
          var state = body.session && body.session.state;
          if (state === 'submitted') {
            clearInterval(timer);
            showToast('Submitted \u2014 task ' + ((body.session && body.session.activeTaskId) || ''), false);
          } else if (state !== 'annotating') {
            clearInterval(timer);
          }
        })
        .catch(function () {});
    }, 1500);
  }

  function triggerFreeze() {
    if (!sessionId) {
      showToast('Redpen session not ready yet.', true);
      return;
    }
    var button = document.getElementById(BUTTON_ID);
    if (button) {
      button.disabled = true;
      button.textContent = 'Freezing...';
    }
    fetch('http://127.0.0.1:' + origin.port + '/sessions/' + sessionId + '/freeze?token=' + origin.token, { method: 'POST' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        showToast('Screen frozen \u2014 switch to the Redpen annotation tab to draw.', false);
        pollForSubmission();
      })
      .catch(function (err) {
        showToast('Freeze failed: ' + err.message, true);
      })
      .then(function () {
        if (button) {
          button.disabled = false;
          button.textContent = 'Freeze screen (F9)';
        }
      });
  }

  function install() {
    if (document.getElementById(BUTTON_ID)) return;
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent =
      '#' + BUTTON_ID + ' { position: fixed; bottom: 20px; left: 20px; z-index: 2147483647;' +
      ' padding: 10px 18px; border: none; border-radius: 999px;' +
      ' background: #18181b; color: #fff; font: 600 13px system-ui, sans-serif;' +
      ' box-shadow: 0 4px 12px rgba(0,0,0,.25); cursor: pointer; }' +
      '#' + BUTTON_ID + ':hover { opacity: .85; }' +
      '#' + BUTTON_ID + ':disabled { opacity: .5; cursor: not-allowed; }';
    document.documentElement.appendChild(style);

    var button = document.createElement('button');
    button.id = BUTTON_ID;
    button.textContent = 'Freeze screen (F9)';
    button.addEventListener('click', triggerFreeze);
    document.documentElement.appendChild(button);
    syncOverlayHost();

    new MutationObserver(syncOverlayHost).observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['open', 'aria-modal'],
    });

    document.addEventListener('keydown', function (event) {
      if (event.key === 'F9') {
        event.preventDefault();
        triggerFreeze();
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install);
  } else {
    install();
  }
})`;

export class BrowserManager {
  private context: BrowserContext | null = null;
  private contextPromise: Promise<BrowserContext> | null = null;
  private closing = false;
  private readonly closedContexts = new WeakSet<BrowserContext>();
  private readonly pages = new Map<string, Page>();
  private readonly annotatorPages = new Map<string, Page>();

  async ensureContext(): Promise<BrowserContext> {
    if (this.closing) throw new Error('browser manager is shutting down');
    if (this.context) return this.context;
    if (this.contextPromise) return this.contextPromise;

    const launch = this.launchContext();
    this.contextPromise = launch;
    try {
      return await launch;
    } catch (error) {
      if (this.contextPromise === launch) {
        this.contextPromise = null;
        this.context = null;
      }
      throw error;
    } finally {
      if (this.contextPromise === launch) this.contextPromise = null;
    }
  }

  private async launchContext(): Promise<BrowserContext> {
    await mkdir(browserProfileDir(), { recursive: true });
    const context = await chromium.launchPersistentContext(browserProfileDir(), {
      headless: resolveHeadless(),
      viewport: { width: 1280, height: 900 },
      // 2x device scale so annotation screenshots (and the user's own eyes
      // when marking up the page) aren't stuck at blurry 1x. The daemon
      // still reports the CSS-pixel viewport size to callers; Playwright
      // captures at this multiplier under the hood.
      deviceScaleFactor: 2,
    });
    context.once('close', () => {
      this.closedContexts.add(context);
      if (this.context === context) {
        this.context = null;
        this.contextPromise = null;
        this.pages.clear();
        this.annotatorPages.clear();
      }
    });
    this.context = context;
    return context;
  }

  private async closePageResource(page: Page): Promise<void> {
    if (page.isClosed()) return;
    try {
      await page.close();
    } catch (error) {
      if (!page.isClosed()) throw error;
    }
  }

  private async closeContextResource(context: BrowserContext): Promise<void> {
    if (this.closedContexts.has(context)) return;
    try {
      await context.close();
    } catch (error) {
      if (!this.closedContexts.has(context)) throw error;
    }
  }

  /**
   * Opens `url` in a fresh tab, retrying a handful of times on
   * `ERR_CONNECTION_REFUSED`. The dev server a user points `redpen open` at
   * (e.g. `pnpm demo`, `vite`, `next dev`) is very often still binding its
   * port in the same breath as the CLI command that starts it, so a single
   * immediate `goto` failure here was previously a hard, non-retryable
   * `error` session state for a race that resolves itself within a second.
   */
  private async gotoWithRetry(page: Page, url: string, attempts = 5, delayMs = 500): Promise<void> {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        await page.goto(url, { waitUntil: 'load' });
        return;
      } catch (err) {
        const message = (err as Error).message;
        const isConnectionRefused = message.includes('ERR_CONNECTION_REFUSED') || message.includes('ECONNREFUSED');
        if (!isConnectionRefused || attempt === attempts) throw err;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  async openPage(sessionId: string, url: string, overlayOrigin?: { port: number; token: string }): Promise<Page> {
    const context = await this.ensureContext();
    const page = await context.newPage();
    try {
      if (overlayOrigin) {
        // addInitScript (not a one-off evaluate) so the freeze overlay
        // survives every future navigation/reload on this tab, not just the
        // first load. Playwright's string-form addInitScript rejects a
        // separate `arg` ("Cannot evaluate a string with arguments"), so the
        // origin is inlined via JSON.stringify directly into the source
        // instead of being passed as a second parameter.
        await page.addInitScript(`(${FREEZE_OVERLAY_SCRIPT_SOURCE})(${JSON.stringify(overlayOrigin)});`);
      }
      await this.gotoWithRetry(page, url);
      if (overlayOrigin) {
        await page.evaluate((sid) => {
          (window as unknown as { __redpenSetSessionId?: (id: string) => void }).__redpenSetSessionId?.(sid);
        }, sessionId);
      }
      this.pages.set(sessionId, page);
      return page;
    } catch (error) {
      await this.closePageResource(page);
      throw error;
    }
  }

  getPage(sessionId: string): Page | undefined {
    return this.pages.get(sessionId);
  }

  async reloadPage(sessionId: string): Promise<Page | undefined> {
    const page = this.pages.get(sessionId);
    if (!page || page.isClosed()) return undefined;
    await page.reload({ waitUntil: 'load' });
    await page.evaluate((id) => {
      (window as unknown as { __redpenSetSessionId?: (sessionId: string) => void }).__redpenSetSessionId?.(id);
    }, sessionId);
    await page.bringToFront();
    return page;
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
      await existing.bringToFront();
      return existing;
    }
    const context = await this.ensureContext();
    const page = await context.newPage();
    try {
      await page.goto(url, { waitUntil: 'load' });
      await page.bringToFront();
      this.annotatorPages.set(sessionId, page);
      return page;
    } catch (error) {
      await this.closePageResource(page);
      throw error;
    }
  }

  getAnnotatorPage(sessionId: string): Page | undefined {
    return this.annotatorPages.get(sessionId);
  }

  /**
   * Closes only the annotation-UI tab for `sessionId`, leaving the target
   * page (and its freeze overlay) open. Called by the daemon after a
   * successful submit instead of relying on the annotation page's own
   * `window.close()`, which the browser treats as a no-op for tabs it does
   * not consider script-opened — Playwright's `context.newPage()` +
   * `page.goto()` is not that, so the in-page `window.close()` call in
   * session.html previously left the tab sitting open forever after the
   * "submitted" overlay. Driving the close from here via the Playwright
   * API works regardless of how the tab was opened.
   */
  async closeAnnotatorPage(sessionId: string): Promise<void> {
    const page = this.annotatorPages.get(sessionId);
    if (!page) return;
    await this.closePageResource(page);
    this.annotatorPages.delete(sessionId);
  }

  async closePage(sessionId: string): Promise<void> {
    const page = this.pages.get(sessionId);
    if (page) {
      await this.closePageResource(page);
      this.pages.delete(sessionId);
    }
    const annotatorPage = this.annotatorPages.get(sessionId);
    if (annotatorPage) {
      await this.closePageResource(annotatorPage);
      this.annotatorPages.delete(sessionId);
    }
  }

  async closeAll(): Promise<void> {
    this.closing = true;
    try {
      if (this.contextPromise) await this.contextPromise.catch(() => undefined);
      for (const sessionId of [...this.pages.keys(), ...this.annotatorPages.keys()]) {
        await this.closePage(sessionId);
      }
      const context = this.context;
      if (context) {
        await this.closeContextResource(context);
        if (this.context === context) {
          this.context = null;
          this.contextPromise = null;
          this.pages.clear();
          this.annotatorPages.clear();
        }
      }
    } finally {
      this.closing = false;
    }
  }
}
