// Runs the integration suite in a real VS Code with an isolated profile.
// Uses VSCODE_PATH (or the standard macOS install) when present, else downloads stable VS Code.
import { runTests } from '@vscode/test-electron';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const macDefault = '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
const vscodeExecutablePath =
  process.env.VSCODE_PATH ?? (existsSync(macDefault) ? macDefault : undefined);

// Set when this script itself runs from a VS Code terminal/task; it would make Code act as Node.
delete process.env.ELECTRON_RUN_AS_NODE;

const profile = mkdtempSync(join(tmpdir(), 'desiide-it-'));
// The orchestrator needs a workspace folder (initialize requires at least one root).
const workspace = join(profile, 'workspace');
mkdirSync(workspace);

try {
  await runTests({
    ...(vscodeExecutablePath ? { vscodeExecutablePath } : {}),
    extensionDevelopmentPath: join(here, '../..'),
    extensionTestsPath: join(here, 'suite.cjs'),
    launchArgs: [
      workspace,
      '--disable-extensions',
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes',
      `--user-data-dir=${join(profile, 'user')}`,
      `--extensions-dir=${join(profile, 'ext')}`,
    ],
    extensionTestsEnv: { DESIIDE_IT_RESULT: join(here, '../../.vscode-test/result.json') },
  });
} catch (err) {
  console.error('Integration tests failed:', err);
  process.exit(1);
}
