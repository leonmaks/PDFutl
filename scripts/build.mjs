import { createRequire } from 'node:module';
import { copyFile, cp, mkdir } from 'node:fs/promises';
import { build } from 'esbuild';
import { join } from 'node:path';
import { root } from './code-oss.mjs';

const require = createRequire(import.meta.url);
const dist = join(root, 'extension', 'dist');
await mkdir(dist, { recursive: true });
await Promise.all([
  build({
    absWorkingDir: root,
    entryPoints: ['extension/src/host.ts'], outfile: join(dist, 'host.cjs'),
    bundle: true, platform: 'node', target: 'node24', external: ['vscode'],
  }),
  build({
    absWorkingDir: root,
    entryPoints: ['extension/src/viewer.tsx'], outfile: join(dist, 'viewer.js'),
    bundle: true, platform: 'browser', target: 'chrome156',
    define: { 'process.env.NODE_ENV': '"production"' },
    legalComments: 'inline',
  }),
  copyFile(require.resolve('@embedpdf/engine/workers/embedpdf-worker.js'), join(dist, 'pdf-worker.js')),
  copyFile(join(root, 'node_modules', '@embedpdf', 'engine-runtime-wasm32', 'lib', 'embedpdf.wasm'), join(dist, 'pdfium.wasm')),
  cp(join(root, 'extension', 'themes'), join(dist, 'themes'), { recursive: true }),
]);
