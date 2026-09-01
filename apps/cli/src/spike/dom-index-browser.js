// Plain, untranspiled JS run inside the browser page context via page.evaluate(<source text>).
// Kept separate from dom-index.ts (which is compiled by esbuild/tsx) because esbuild injects a
// `__name()` helper call into compiled function bodies; that helper does not exist once the
// function source is serialized and re-evaluated inside the browser, causing a ReferenceError.
// This file must stay dependency-free and copy-pasted logic must be kept in sync with
// dom-index.ts's collectVisibleDomIndex.

(function collectVisibleDomIndex() {
  var viewportWidth = window.innerWidth;
  var viewportHeight = window.innerHeight;

  var SENSITIVE_TAGS = { SCRIPT: true, STYLE: true, INPUT: true, TEXTAREA: true };
  var candidates = [];
  var tempCounter = 0;

  function isVisible(el) {
    var style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false;
    }
    var rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return false;
    }
    if (rect.right <= 0 || rect.bottom <= 0 || rect.left >= viewportWidth || rect.top >= viewportHeight) {
      return false;
    }
    return true;
  }

  function textSummaryOf(el) {
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      return null;
    }
    var text = (el.textContent || '').trim().replace(/\s+/g, ' ');
    if (!text) return null;
    return text.length > 120 ? text.slice(0, 120) + '…' : text;
  }

  function walk(node) {
    var children = Array.prototype.slice.call(node.children);
    for (var i = 0; i < children.length; i++) {
      var child = children[i];
      if (child.tagName === 'SCRIPT' || child.tagName === 'STYLE') {
        continue;
      }
      if (isVisible(child)) {
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

        candidates.push({
          tempId: 'tmp-' + tempCounter++,
          tag: child.tagName.toLowerCase(),
          role: child.getAttribute('role'),
          accessibleName: accessibleName,
          textSummary: SENSITIVE_TAGS[child.tagName] ? null : textSummaryOf(child),
          testIdHint: testId,
          idHint: child.id || null,
          classHint: child.className && typeof child.className === 'string' ? child.className : null,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        });
      }
      walk(child);
    }
  }

  walk(document.body);

  return {
    capturedAt: new Date().toISOString(),
    viewport: {
      width: viewportWidth,
      height: viewportHeight,
      deviceScaleFactor: window.devicePixelRatio,
    },
    scroll: { x: window.scrollX, y: window.scrollY },
    candidates: candidates,
  };
})();
