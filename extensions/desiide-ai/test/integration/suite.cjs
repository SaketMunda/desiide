// Integration suite, executed inside the VS Code extension host (CommonJS, no test framework).
const assert = require('node:assert/strict');
const { mkdirSync, writeFileSync } = require('node:fs');
const { dirname } = require('node:path');
const vscode = require('vscode');

const ACTIVATION_BUDGET_MS = 150;

async function waitFor(predicate, what, timeoutMs = 15000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function run() {
  const results = {};
  const ext = vscode.extensions.getExtension('desiide-dev.desiide-ai');
  assert.ok(ext, 'desiide-ai extension is installed in the dev host');

  // AC3: no activation on startup while no Desiide view is visible.
  await new Promise((r) => setTimeout(r, 3000));
  results.activeAfterStartup = ext.isActive;
  assert.equal(ext.isActive, false, 'extension must not activate at startup');

  // AC1: opening the Desiide container activates the extension and renders both views.
  const opened = Date.now();
  await vscode.commands.executeCommand('workbench.view.extension.desiide');
  await waitFor(() => ext.isActive, 'activation');
  // Upper bound: includes opening the container, loading the bundle and running activate().
  results.openToActiveWallMs = Date.now() - opened;
  const api = ext.exports;
  results.activationMs = Number(api.activationMs.toFixed(2));
  assert.ok(
    api.activationMs < ACTIVATION_BUDGET_MS,
    `activation took ${api.activationMs} ms (budget ${ACTIVATION_BUDGET_MS} ms)`,
  );

  // `ready` is sent by the webview script, so this proves the bundle loads under the CSP and the
  // bridge round-trips.
  await waitFor(() => api.readyViews.has('panel'), 'panel webview ready');
  await waitFor(() => api.readyViews.has('decisions'), 'decisions webview ready');
  results.readyViews = [...api.readyViews].sort();

  // Dev-only showcase command is registered and runs.
  await vscode.commands.executeCommand('desiide.dev.showcase');
  results.showcaseCommand = 'ok';

  const all = await vscode.commands.getCommands(true);
  results.commands = ['desiide.focus', 'desiide.showLog', 'desiide.dev.showcase'].filter((c) =>
    all.includes(c),
  );
  assert.equal(results.commands.length, 3, 'all desiide.* commands registered');

  results.vscodeVersion = vscode.version;
  const out = process.env.DESIIDE_IT_RESULT;
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(results, null, 2));
  }
  console.log('desiide-ai integration results', JSON.stringify(results));
}

module.exports = { run };
