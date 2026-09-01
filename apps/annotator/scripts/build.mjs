// Bundles the annotator client into a single browser-loadable script.
// Plain untranspiled-at-runtime output (esbuild target matches modern
// browsers) so it can be loaded directly via <script src="..."> in the demo
// page and driven by Playwright, without a dev server / bundler-aware test
// harness.
import * as esbuild from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

await esbuild.build({
  entryPoints: [path.resolve(__dirname, '../src/client.ts')],
  bundle: true,
  outfile: path.resolve(__dirname, '../public/client.bundle.js'),
  format: 'iife',
  target: ['chrome110'],
  sourcemap: false,
  logLevel: 'info',
});
