import * as esbuild from 'esbuild';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliRoot = path.resolve(__dirname, '..');
const repositoryRoot = path.resolve(cliRoot, '../..');
const distDir = path.join(cliRoot, 'dist');
const publicDir = path.join(distDir, 'public');
const redpenAssetDir = path.join(distDir, 'assets', 'redpen');
const internalPackagePattern = /^@redpen\/(annotator-core|grounding|protocol|review)(?:\/(.+))?$/;

const bundleInternalPackages = {
  name: 'bundle-internal-packages',
  setup(build) {
    build.onResolve({ filter: internalPackagePattern }, (args) => {
      const [, packageName, subpath] = args.path.match(internalPackagePattern);
      return {
        path: path.join(
          repositoryRoot,
          'packages',
          packageName,
          'src',
          subpath ? `${subpath}.ts` : 'index.ts',
        ),
      };
    });
  },
};

await rm(distDir, { recursive: true, force: true });
await esbuild.build({
  entryPoints: {
    cli: path.join(cliRoot, 'src/cli.ts'),
    daemon: path.join(cliRoot, 'src/daemon/main.ts'),
  },
  outdir: distDir,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  sourcemap: true,
  packages: 'external',
  plugins: [bundleInternalPackages],
});

await mkdir(publicDir, { recursive: true });
for (const asset of ['session.html', 'session.bundle.js', 'execution-review.html', 'execution-review.js']) {
  await copyFile(path.join(repositoryRoot, 'apps/annotator/public', asset), path.join(publicDir, asset));
}

await mkdir(path.join(redpenAssetDir, 'commands'), { recursive: true });
await copyFile(path.join(repositoryRoot, 'skills/redpen/SKILL.md'), path.join(redpenAssetDir, 'SKILL.md'));
await copyFile(
  path.join(repositoryRoot, 'skills/redpen/commands/redpen.md'),
  path.join(redpenAssetDir, 'commands', 'redpen.md'),
);
