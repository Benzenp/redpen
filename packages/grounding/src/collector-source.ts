/**
 * Browser-side visible DOM candidate collector (docs/ARCHITECTURE.md §4.3,
 * docs/IMPLEMENTATION_PLAN.md Phase 3).
 *
 * IMPORTANT: this file's *source text* is read and injected into a page via
 * `page.evaluate(sourceText)` — never imported and executed as a normal
 * module. It must stay plain, untranspiled JS with no external imports,
 * because esbuild/tsx inject a `__name()` compiler helper into compiled
 * function bodies that does not exist once the source is serialized and
 * re-evaluated inside the browser (see docs/IMPLEMENTATION_PLAN.md Phase 0
 * "주요 구현 제약"). Keep this file's output shape in sync with
 * `RawDomCandidate` in `./types.ts`.
 *
 * Collects:
 * - rect, tag, role, accessible name, visible text summary
 * - id, data-testid family, class hint (selector hint raw material)
 * - a parent/sibling summary (tag + short text only)
 * - an allowlisted subset of computed layout properties
 *
 * Never collects: input/textarea values, password fields' presence-adjacent
 * values, script/style content, cookies, storage.
 */

export const COLLECTOR_SOURCE = `
(function collectVisibleDomIndex() {
  var viewportWidth = window.innerWidth;
  var viewportHeight = window.innerHeight;

  var SENSITIVE_VALUE_TAGS = { INPUT: true, TEXTAREA: true };
  var SKIP_TAGS = { SCRIPT: true, STYLE: true };
  var LAYOUT_ALLOWLIST = ['display', 'position', 'gap', 'padding', 'margin', 'width', 'height', 'fontSize', 'fontWeight', 'lineHeight', 'color', 'backgroundColor'];

  var candidates = [];
  var tempCounter = 0;
  var activeModal = null;
  var openDialogs = Array.prototype.slice.call(document.querySelectorAll('dialog[open]'));
  for (var dialogIndex = openDialogs.length - 1; dialogIndex >= 0; dialogIndex--) {
    try {
      if (openDialogs[dialogIndex].matches(':modal')) {
        activeModal = openDialogs[dialogIndex];
        break;
      }
    } catch (_) {
      activeModal = openDialogs[dialogIndex];
      break;
    }
  }
  if (!activeModal) {
    activeModal = document.querySelector('[aria-modal="true"]');
  }

  function isVisible(el) {
    var style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    var rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    if (rect.right <= 0 || rect.bottom <= 0 || rect.left >= viewportWidth || rect.top >= viewportHeight) return false;
    return true;
  }

  function textSummaryOf(el) {
    if (SENSITIVE_VALUE_TAGS[el.tagName]) return null;
    var text = (el.textContent || '').trim().replace(/\\s+/g, ' ');
    if (!text) return null;
    return text.length > 120 ? text.slice(0, 120) + '\u2026' : text;
  }

  function shortSummary(el) {
    if (!el || el.nodeType !== 1) return null;
    return {
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || null,
      accessibleName: el.getAttribute('aria-label') || null,
      textSummary: textSummaryOf(el),
    };
  }

  function computedLayoutOf(el) {
    var style = window.getComputedStyle(el);
    var out = {};
    for (var i = 0; i < LAYOUT_ALLOWLIST.length; i++) {
      var key = LAYOUT_ALLOWLIST[i];
      out[key] = style[key];
    }
    return out;
  }

  function classHintOf(el) {
    return el.className && typeof el.className === 'string' ? el.className : null;
  }

  function walk(node) {
    var children = Array.prototype.slice.call(node.children);
    for (var i = 0; i < children.length; i++) {
      var child = children[i];
      if (SKIP_TAGS[child.tagName]) continue;
      var insideActiveModal = !activeModal || child === activeModal || activeModal.contains(child);
      var leadsToActiveModal = activeModal && child.contains(activeModal);
      if (activeModal && !insideActiveModal && !leadsToActiveModal) continue;
      if (insideActiveModal && isVisible(child)) {
        var rect = child.getBoundingClientRect();
        var testId =
          child.getAttribute('data-testid') ||
          child.getAttribute('data-test-id') ||
          child.getAttribute('data-test') ||
          null;

        var accessibleName = child.getAttribute('aria-label') || child.getAttribute('alt') || null;
        if (!accessibleName && (child.tagName === 'INPUT' || child.tagName === 'BUTTON' || child.tagName === 'A')) {
          accessibleName = child.getAttribute('title') || textSummaryOf(child);
        }

        var attributes = {};
        if (testId) attributes['data-testid'] = testId;
        if (child.id) attributes.id = child.id;

        candidates.push({
          tempId: 'tmp-' + tempCounter++,
          tag: child.tagName.toLowerCase(),
          role: child.getAttribute('role'),
          accessibleName: accessibleName,
          textSummary: textSummaryOf(child),
          testIdHint: testId,
          idHint: child.id || null,
          classHint: classHintOf(child),
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          attributes: attributes,
          parent: shortSummary(child.parentElement),
          siblings: Array.prototype.slice
            .call((child.parentElement && child.parentElement.children) || [])
            .filter(function (s) { return s !== child; })
            .slice(0, 3)
            .map(shortSummary)
            .filter(Boolean),
          computedLayout: computedLayoutOf(child),
        });
      }
      walk(child);
    }
  }

  walk(document.body);

  return {
    capturedAt: new Date().toISOString(),
    viewport: { width: viewportWidth, height: viewportHeight, deviceScaleFactor: window.devicePixelRatio },
    scroll: { x: window.scrollX, y: window.scrollY },
    candidates: candidates,
  };
})();
`;
