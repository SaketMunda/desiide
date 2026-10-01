// Bundles the orchestrator into one self-contained CommonJS file (dist/orchestrator.js) that the
// extension forks with ELECTRON_RUN_AS_NODE. Usage: build.mjs [--entry <ts>] [--outfile <js>]
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? resolve(process.argv[i + 1]) : fallback;
};
const { version } = JSON.parse(
  readFileSync(join(root, '../../extensions/desiide-ai/package.json'), 'utf8'),
);

await build({
  entryPoints: [arg('--entry', join(root, 'src/host/main.ts'))],
  outfile: arg('--outfile', join(root, 'dist/orchestrator.js')),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  minify: true,
  sourcemap: false,
  define: { __DESIIDE_VERSION__: JSON.stringify(version) },
  logLevel: 'warning',
});
