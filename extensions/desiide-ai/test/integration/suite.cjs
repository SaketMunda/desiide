// Integration suite, executed inside the VS Code extension host (CommonJS, no test framework).
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
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
  const ext = vscode.extensions.getExtension('desiide.desiide-ai');
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

  // COR-1 AC5: activation never spawns the orchestrator; the first request does.
  results.orchestratorAfterActivation = api.orchestrator.status.state;
  assert.equal(api.orchestrator.status.state, 'idle', 'orchestrator not spawned during activation');

  // `ready` is sent by the webview script, so this proves the bundle loads under the CSP and the
  // bridge round-trips.
  await waitFor(() => api.readyViews.has('panel'), 'panel webview ready');
  await waitFor(() => api.readyViews.has('decisions'), 'decisions webview ready');
  results.readyViews = [...api.readyViews].sort();

  // EDT-2 AC2: app-only first-run behavior stays off in stock VS Code. The run uses --skip-welcome,
  // so any editor tab here could only be the walkthrough opened by the extension.
  results.appName = vscode.env.appName;
  assert.notEqual(vscode.env.appName, 'Desiide', 'this suite runs in stock VS Code');
  await new Promise((r) => setTimeout(r, 1000));
  results.tabsAfterActivation = vscode.window.tabGroups.all
    .flatMap((g) => g.tabs)
    .map((t) => t.label);
  assert.deepEqual(results.tabsAfterActivation, [], 'no walkthrough opened outside the app');
  results.welcomeOpened = api.welcomeOpened;
  assert.equal(api.welcomeOpened, false, 'the first-run walkthrough is app-only');

  // Dev-only showcase command is registered and runs.
  await vscode.commands.executeCommand('desiide.dev.showcase');
  results.showcaseCommand = 'ok';

  const expected = [
    'desiide.focus',
    'desiide.focusPrompt',
    'desiide.addSelectionToPrompt',
    'desiide.setup',
    'desiide.showLog',
    'desiide.restartOrchestrator',
    'desiide.dev.showcase',
  ];
  const all = await vscode.commands.getCommands(true);
  results.commands = expected.filter((c) => all.includes(c));
  assert.deepEqual(results.commands, expected, 'all desiide.* commands registered');

  // COR-1: the orchestrator runs on the editor's own runtime (fork + ELECTRON_RUN_AS_NODE).
  const orch = api.orchestrator;
  const firstRequest = Date.now();
  const ping = await orch.request('health.ping', {});
  results.orchestratorFirstPingMs = Date.now() - firstRequest;
  assert.equal(ping.ok, true);
  const firstPid = orch.status.pid;
  assert.equal(orch.status.state, 'ready');
  assert.ok(firstPid, 'orchestrator has a pid');

  // COR-1 AC2 in the real host: kill -9 → the supervisor restarts it.
  const seen = [];
  const sub = orch.onStatus((s) => seen.push(s.state));
  process.kill(firstPid, 'SIGKILL');
  await waitFor(
    () => orch.status.state === 'ready' && orch.status.pid !== firstPid,
    'orchestrator restart after kill -9',
  );
  results.orchestratorStatusesAfterKill = [...seen];
  assert.deepEqual(seen, ['restarting', 'starting', 'ready']);
  assert.equal((await orch.request('health.ping', {})).ok, true);

  // Manual restart command.
  const beforeRestart = orch.status.pid;
  await vscode.commands.executeCommand('desiide.restartOrchestrator');
  await waitFor(
    () => orch.status.state === 'ready' && orch.status.pid !== beforeRestart,
    'manual orchestrator restart',
  );
  sub.dispose();
  results.orchestratorRestartCommand = 'ok';

  await promptBoxChecks(api, results);

  results.vscodeVersion = vscode.version;
  const out = process.env.DESIIDE_IT_RESULT;
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(results, null, 2));
  }
  console.log('desiide-ai integration results', JSON.stringify(results));
}

/** VS Code's generated default-keybindings document (all built-in and extension bindings). */
async function defaultKeybindings() {
  const doc = await vscode.workspace.openTextDocument(
    vscode.Uri.parse('vscode://defaultsettings/keybindings.json'),
  );
  // JSONC: drop line comments (none of the keys/commands contain `//`), then trailing commas.
  const json = doc
    .getText()
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n')
    .replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(json);
}

async function promptBoxChecks(api, results) {
  // UI-2: the chosen default shortcuts don't collide with anything VS Code (or a built-in
  // extension) binds by default on this platform.
  const ours = { 'desiide.focusPrompt': [], 'desiide.addSelectionToPrompt': [] };
  const bindings = await defaultKeybindings();
  for (const b of bindings) if (b.command in ours) ours[b.command].push(b.key);
  if (process.env.DESIIDE_DUMP_KEYS) {
    writeFileSync(process.env.DESIIDE_DUMP_KEYS, JSON.stringify(bindings.map((b) => b.key)));
  }
  const keys = Object.values(ours).flat();
  assert.equal(keys.length, 2, `both shortcuts are registered: ${JSON.stringify(ours)}`);
  const clashes = bindings.filter((b) => keys.includes(b.key) && !(b.command in ours));
  results.promptKeybindings = ours;
  results.promptKeybindingClashes = clashes.map((b) => `${b.key} → ${b.command}`);
  assert.deepEqual(results.promptKeybindingClashes, [], 'no default keybinding clashes');
  results.defaultKeybindingCount = bindings.length;

  // UI-2 AC3: @file search on the 10k-file workspace created by run.mjs.
  const signal = new AbortController().signal;
  let t = Date.now();
  const first = await api.prompt.searchFiles('parser', signal);
  results.mentionFirstSearchMs = Date.now() - t; // includes the one-time findFiles listing
  const times = [];
  for (const q of ['u', 'usr', 'parserconf', 'pkg3/view', 'sessionrouter12', 'zzz']) {
    t = performance.now();
    await api.prompt.searchFiles(q, signal);
    times.push(Number((performance.now() - t).toFixed(1)));
  }
  results.mentionSearchMs = times;
  results.mentionFirstResults = first.length;
  assert.equal(first.filter((i) => i.kind === 'file').length, 50, '50 file results');
  assert.ok(Math.max(...times) < 150, `@file search under 150 ms (${times.join(', ')})`);

  // Add selection: the command focuses the panel and the chip is queued for the webview.
  const doc = await vscode.workspace.openTextDocument(
    vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, 'pkg0/user0/useruser0.ts'),
  );
  const editor = await vscode.window.showTextDocument(doc);
  await editor.edit((e) => e.insert(new vscode.Position(0, 0), 'const a = 1;\nconst b = 2;\n'));
  editor.selection = new vscode.Selection(0, 0, 1, 12);
  await vscode.commands.executeCommand('desiide.addSelectionToPrompt');
  await vscode.commands.executeCommand('desiide.focusPrompt');
  results.addSelectionCommand = 'ok';
  await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
}

module.exports = { run };
