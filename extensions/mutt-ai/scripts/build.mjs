// Builds the extension host bundle (esbuild), the webview bundle (Vite), and copies static assets.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
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
  sourcemap: !production,
  minify: production,
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

// The orchestrator bundle comes from COR-1; ship it when it has been built.
const orchestrator = join(root, '../../packages/orchestrator/dist/orchestrator.js');
if (existsSync(orchestrator)) {
  copyFileSync(orchestrator, join(dist, 'orchestrator.js'));
} else {
  console.warn('mutt-ai build: orchestrator bundle not found, skipping (built by COR-1).');
}
