// Builds the extension host bundle (esbuild), the webview bundle (Vite), and copies static assets.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const production = process.argv.includes('--production');

rmSync(dist, { recursive: true, force: true });

await build({
  entryPoints: [join(root, 'src/extension.ts')],
  outfile: join(dist, 'extension.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  // Always minified: bundle size is parse time, which counts against the 150 ms activation budget.
  sourcemap: !production,
  minify: true,
  logLevel: 'warning',
});

execFileSync(join(root, 'node_modules/.bin/vite'), ['build', '--logLevel', 'warn'], {
  cwd: root,
  stdio: 'inherit',
});

const codicons = join(root, 'node_modules/@vscode/codicons/dist');
mkdirSync(join(dist, 'codicons'), { recursive: true });
for (const file of ['codicon.css', 'codicon.ttf']) {
  copyFileSync(join(codicons, file), join(dist, 'codicons', file));
}

// The orchestrator (COR-1) ships next to the extension and is forked from dist/ on first use.
execFileSync(
  process.execPath,
  [
    join(root, '../../packages/orchestrator/scripts/build.mjs'),
    '--outfile',
    join(dist, 'orchestrator.js'),
  ],
  { stdio: 'inherit' },
);
