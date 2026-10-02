// Runs the integration suite in a real VS Code with an isolated profile.
// Uses VSCODE_PATH (or the standard macOS install) when present, else downloads stable VS Code.
import { runTests } from '@vscode/test-electron';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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
// UI-2 AC3: @file search is measured on a 10k-file workspace (100 folders × 100 files).
const words = ['user', 'parser', 'config', 'session', 'router', 'model', 'view', 'store'];
for (let d = 0; d < 100; d++) {
  const dir = join(workspace, `pkg${d % 10}`, `${words[d % words.length]}${d}`);
  mkdirSync(dir, { recursive: true });
  for (let f = 0; f < 100; f++) {
    writeFileSync(
      join(dir, `${words[f % words.length]}${words[(f * 3) % words.length]}${f}.ts`),
      '',
    );
  }
}

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
    extensionTestsEnv: {
      DESIIDE_IT_RESULT: join(here, '../../.vscode-test/result.json'),
      // Optional: write every default key to this file (used to pick non-conflicting shortcuts).
      ...(process.env.DESIIDE_DUMP_KEYS
        ? { DESIIDE_DUMP_KEYS: process.env.DESIIDE_DUMP_KEYS }
        : {}),
    },
  });
} catch (err) {
  console.error('Integration tests failed:', err);
  process.exit(1);
}
