// First-launch suite, executed inside the built Desiide app (not stock VS Code). The extension
// under test is the app's *built-in* desiide-ai; this suite loads as an empty probe extension.
const assert = require('node:assert/strict');
const { mkdirSync, writeFileSync } = require('node:fs');
const { dirname, sep } = require('node:path');
const vscode = require('vscode');

async function waitFor(predicate, what, timeoutMs = 20000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const tabs = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs.map((t) => t.label));

async function run() {
  const results = { appName: vscode.env.appName };
  const out = process.env.DESIIDE_APP_RESULT;
  const save = () => {
    if (!out) return;
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(results, null, 2));
  };
  try {
    assert.equal(vscode.env.appName, 'Desiide', 'runs inside the Desiide app');

    const ext = vscode.extensions.getExtension('desiide-dev.desiide-ai');
    assert.ok(ext, 'desiide-ai is present');
    results.builtIn = ext.extensionPath.includes(`${sep}Resources${sep}app${sep}extensions${sep}`);
    assert.ok(results.builtIn, `desiide-ai is the app's built-in copy (${ext.extensionPath})`);

    // AC1: nothing is clicked. The Desiide panel is visible on first launch, which activates the
    // extension, which opens the walkthrough.
    await waitFor(() => ext.isActive, 'desiide-ai to activate from its visible panel');
    results.activatedWithoutInteraction = true;
    await waitFor(() => ext.exports.readyViews.has('panel'), 'the Desiide panel webview');
    results.readyViews = [...ext.exports.readyViews].sort();
    await waitFor(() => ext.exports.welcomeOpened, 'the first-run walkthrough', 10000);
    results.welcomeOpened = true;
    results.tabs = tabs();

    const all = await vscode.commands.getCommands(true);
    results.focusCommand = all.includes('desiide.focus');
  } catch (err) {
    results.error = String(err && err.message ? err.message : err);
    results.tabs = tabs();
    throw err;
  } finally {
    save();
    console.log('desiide app first-launch results', JSON.stringify(results));
  }
}

module.exports = { run };
