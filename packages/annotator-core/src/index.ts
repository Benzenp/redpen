export * from './palette.js';
export * from './store.js';
export * from './export-svg.js';
// composite.ts is intentionally NOT re-exported here: it depends on pngjs
// (Node's zlib/stream/util builtins), and this barrel is bundled straight
// into the browser-side annotation UI via apps/annotator/src/client.ts's
// bare `@redpen/annotator-core` import. Server-only callers (apps/cli) use
// the `@redpen/annotator-core/composite` subpath export instead.
