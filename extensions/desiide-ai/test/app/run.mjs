// Runs the first-launch suite inside the built Desiide app with a brand-new profile (EDT-2 AC1).
// Build the app first: scripts/build-editor.sh. Override the binary with DESIIDE_APP_PATH.
import { runTests } from '@vscode/test-electron';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const editor = join(here, '../../../../editor');
const defaults = {
  darwin: join(editor, `VSCode-darwin-${process.arch}/Desiide.app/Contents/MacOS/Desiide`),
  linux: join(editor, `VSCode-linux-${process.arch}/desiide`),
};
const app = process.env.DESIIDE_APP_PATH ?? defaults[process.platform];
if (!app || !existsSync(app)) {
  console.error(`Desiide app not found at ${app}. Build it with scripts/build-editor.sh.`);
  process.exit(1);
}

delete process.env.ELECTRON_RUN_AS_NODE;
const profile = mkdtempSync(join(tmpdir(), 'desiide-app-'));

try {
  await runTests({
    vscodeExecutablePath: app,
    extensionDevelopmentPath: join(here, 'probe'),
    extensionTestsPath: join(here, 'suite.cjs'),
    // A first launch: no --skip-welcome, and a profile nobody has used.
    launchArgs: [
      '--disable-workspace-trust',
      `--user-data-dir=${join(profile, 'user')}`,
      `--extensions-dir=${join(profile, 'ext')}`,
    ],
    extensionTestsEnv: { DESIIDE_APP_RESULT: join(here, '../../.vscode-test/app-result.json') },
  });
} catch (err) {
  console.error('App first-launch tests failed:', err);
  process.exit(1);
}
