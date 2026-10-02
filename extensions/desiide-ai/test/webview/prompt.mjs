/* global window, document -- used inside callbacks that Playwright runs in the page */
// Keyboard-only and accessibility checks for the Prompt Box webview (UI-2 AC1, AC4, AC6, AC7),
// in headless Chromium against the built bundle. A fake `acquireVsCodeApi` plays the extension
// host: it answers the bridge the way `PromptController` does and records every message posted.
// Run: pnpm -F desiide-ai test:webview (builds first). Not in verify.sh: it needs a browser.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const shots = join(root, '.screenshots');
const origin = 'https://desiide-webview.test';
const types = { '.js': 'text/javascript', '.css': 'text/css', '.ttf': 'font/ttf' };
const colors = `:root{--vscode-foreground:#ccc;--vscode-descriptionForeground:#ccccccb3;
--vscode-focusBorder:#007fd4;--vscode-sideBar-background:#252526;--vscode-editorWidget-background:#252526;
--vscode-input-background:#3c3c3c;--vscode-input-foreground:#ccc;--vscode-button-background:#0e639c;
--vscode-button-foreground:#fff;--vscode-button-secondaryBackground:#3a3d41;--vscode-button-secondaryForeground:#fff;
--vscode-list-activeSelectionBackground:#04395e;--vscode-list-activeSelectionForeground:#fff;
--vscode-widget-border:#454545;--vscode-editorWarning-foreground:#cca700;--vscode-errorForeground:#f48771;
--vscode-font-family:-apple-system,sans-serif;--vscode-font-size:13px;--vscode-editor-font-family:Menlo,monospace}`;

const FILES = ['src/parser.ts', 'src/util/paths.ts', 'test/parser.test.ts', 'README.md'];

async function openPanel(
  browser,
  { hasModels = true, draft = { text: '', chips: [] }, history = [] } = {},
) {
  const page = await browser.newPage({
    viewport: { width: 380, height: 640 },
    deviceScaleFactor: 2,
  });
  await page.route(`${origin}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/index.html') {
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/dist/codicons/codicon.css"><link rel="stylesheet" href="/dist/webview/main.css">
<style>${colors}</style></head><body class="vscode-dark"><div id="root" data-view="panel"></div>
<script type="module" src="/dist/webview/main.js"></script></body></html>`,
      });
    }
    const file = join(root, path);
    return route.fulfill({
      contentType: types[extname(file)] ?? 'application/octet-stream',
      body: readFileSync(file),
    });
  });
  await page.addInitScript(
    ({ hasModels, draft, history, files }) => {
      const reply = (m) => setTimeout(() => window.postMessage(m, '*'));
      const config = {
        hasModels,
        workflows: [
          {
            option: 'local-single',
            enabled: false,
            hidden: false,
            reason: 'Assign a model to the "cheap" role in Desiide settings.',
          },
          { option: 'cloud-single', enabled: true, hidden: false },
          {
            option: 'local-cloud-cascade',
            enabled: false,
            hidden: false,
            reason: 'Assign a model to the "cheap" role in Desiide settings.',
          },
          { option: 'cloud-with-critique', enabled: true, hidden: true },
        ],
        defaultPreference: 'balance',
        contextLimitTokens: 8192,
        mock: true,
      };
      let state;
      let hist = history;
      window.__posted = [];
      window.acquireVsCodeApi = () => ({
        postMessage: (m) => {
          window.__posted.push(m);
          if (m.type === 'ready') {
            reply({ type: 'init', view: 'panel', devMode: false, showcase: false });
            reply({ type: 'prompt.restore', draft, history: hist });
            reply({ type: 'prompt.config', config });
            reply({ type: 'prompt.tasks', active: [] });
          } else if (m.type === 'mention.search') {
            const q = m.query.toLowerCase();
            const items = files
              .filter((f) => [...q].every((c) => f.toLowerCase().includes(c)))
              .map((path) => ({ kind: 'file', label: path.split('/').pop(), detail: path, path }));
            reply({ type: 'mention.results', requestId: m.requestId, items });
          } else if (m.type === 'mention.pick') {
            const p = m.item.path ?? '';
            reply({
              type: 'prompt.addChip',
              chip:
                m.item.kind === 'file'
                  ? { ref: { type: 'file', path: p }, label: m.item.label, detail: p, chars: 4000 }
                  : {
                      ref: { type: 'diff', scope: 'working' },
                      label: 'working changes',
                      detail: '',
                    },
            });
          } else if (m.type === 'prompt.submit') {
            hist = [...hist, m.instruction.trim()];
            reply({
              type: 'prompt.sent',
              taskId: 'mock-1',
              history: hist,
              echo: { instruction: m.instruction.trim() },
            });
            reply({ type: 'prompt.tasks', active: [{ id: 'mock-1', state: 'running' }] });
          } else if (m.type === 'prompt.cancel') {
            reply({ type: 'prompt.tasks', active: [] });
          }
        },
        getState: () => state,
        setState: (s) => (state = s),
      });
      window.__send = (m) => window.postMessage(m, '*');
    },
    { hasModels, draft, history, files: FILES },
  );
  await page.goto(`${origin}/index.html`);
  await page.waitForSelector('.desiide-prompt__input');
  // Like the real host: talk to the view only after it said `ready` and got its state.
  await page.waitForFunction(() => window.__posted.some((m) => m.type === 'ready'));
  await page.waitForSelector('.desiide-segmented');
  return page;
}

const posted = (page, type) =>
  page.evaluate((t) => window.__posted.filter((m) => m.type === t), type);
const results = {};

mkdirSync(shots, { recursive: true });
const browser = await chromium.launch();
try {
  // --- AC1 + AC7: keyboard-only flow, ARIA ---
  {
    const page = await openPanel(browser);
    const input = page.getByRole('textbox', { name: 'Prompt' });
    assert.equal(await input.count(), 1, 'AC7: the input has an accessible name "Prompt"');

    // "Focus Prompt Box" command → the host posts prompt.focus.
    await page.evaluate(() => window.__send({ type: 'prompt.focus' }));
    await page.waitForFunction(() => document.activeElement?.id === 'desiide-prompt');

    await page.keyboard.type('Fix the bug in ');
    await page.keyboard.type('@pars');
    const listbox = page.getByRole('listbox', { name: 'Attach context' });
    await listbox.waitFor();
    assert.equal(
      await input.getAttribute('aria-controls'),
      'desiide-mentions',
      'AC7: input controls the listbox',
    );
    const options = listbox.getByRole('option');
    await page.waitForFunction(() => document.querySelectorAll('[role=option]').length >= 2);
    results.optionsForPars = await options.allTextContents();
    assert.equal(await options.first().getAttribute('aria-selected'), 'true');
    const firstId = await input.getAttribute('aria-activedescendant');
    await page.keyboard.press('ArrowDown');
    const secondId = await input.getAttribute('aria-activedescendant');
    assert.notEqual(firstId, secondId, 'AC7: arrow keys move aria-activedescendant');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter'); // picks src/parser.ts, does not send
    await page.getByRole('list', { name: 'Attached context' }).getByText('parser.ts').waitFor();
    assert.equal(await input.inputValue(), 'Fix the bug in ', 'the @query is replaced by the chip');
    assert.equal(
      (await posted(page, 'prompt.submit')).length,
      0,
      'Enter in the popup picks, it does not send',
    );

    // A second mention, @diff, chosen from the static items.
    await page.keyboard.type('@diff');
    await page.getByRole('option', { name: /diff/ }).first().waitFor();
    await page.keyboard.press('Tab');
    await page.getByText('working changes').waitFor();

    // Shift+Enter adds a newline, Enter sends.
    await page.keyboard.type('and add a test');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('quickly');
    assert.match(await input.inputValue(), /test\nquickly$/);
    results.tokenLabel = await page.locator('.desiide-prompt__tokens').textContent();
    await page.screenshot({ path: join(shots, 'prompt-composing.png') });
    await page.keyboard.press('Enter');
    const [submit] = await posted(page, 'prompt.submit');
    assert.ok(submit, 'AC1: Enter sent the prompt');
    assert.deepEqual(
      submit.chips.map((c) => c.ref),
      [
        { type: 'file', path: 'src/parser.ts' },
        { type: 'diff', scope: 'working' },
      ],
      'AC2: chips in the order they were added',
    );
    assert.equal(submit.workflow, 'auto');
    assert.equal(submit.preference, 'balance');
    results.submit = submit;

    // After send: cleared, Stop shown (task running), mock echo shown.
    await page.waitForFunction(() => document.querySelector('#desiide-prompt').value === '');
    const stop = page.getByRole('button', { name: 'Stop the running task' });
    await stop.waitFor();
    await page.screenshot({ path: join(shots, 'prompt-running.png') });

    // AC4: history — ArrowUp at the start recalls the last prompt; ArrowDown returns to the draft.
    await input.focus();
    await page.keyboard.press('ArrowUp');
    assert.match(await input.inputValue(), /^Fix the bug in/);
    // The recalled prompt is two lines: ArrowDown only leaves history from the very end.
    await page.keyboard.press('ArrowDown');
    assert.match(await input.inputValue(), /^Fix the bug in/, 'ArrowDown mid-text moves the caret');
    await input.evaluate((el) => el.setSelectionRange(el.value.length, el.value.length));
    await page.keyboard.press('ArrowDown');
    assert.equal(await input.inputValue(), '');

    // AC5 (webview side): Stop via keyboard posts prompt.cancel and Stop goes away.
    await stop.focus();
    await page.keyboard.press('Enter');
    assert.equal((await posted(page, 'prompt.cancel')).length, 1);
    await stop.waitFor({ state: 'detached' });

    // AC7: chips are removable by keyboard.
    await input.focus();
    await page.keyboard.type('@READ');
    await page.getByRole('option', { name: /README/ }).waitFor();
    await page.keyboard.press('Enter');
    const remove = page.getByRole('button', { name: 'Remove README.md' });
    await remove.waitFor();
    await remove.focus();
    await page.keyboard.press('Delete');
    await remove.waitFor({ state: 'detached' });
    assert.equal(
      await page.evaluate(() => document.activeElement?.id),
      'desiide-prompt',
      'focus returns to the input',
    );

    // Escape closes the popup first, then blurs the input.
    await page.keyboard.type(' @');
    await listbox.waitFor();
    await page.keyboard.press('Escape');
    await listbox.waitFor({ state: 'detached' });
    await page.keyboard.press('Escape');
    assert.notEqual(await page.evaluate(() => document.activeElement?.id), 'desiide-prompt');

    // Workflow radios: disabled options explain themselves, arrows skip choosing them.
    const workflow = page.getByRole('radiogroup', { name: 'Workflow' });
    assert.deepEqual(await workflow.getByRole('radio').allTextContents(), [
      'Auto (Jev)',
      'Local',
      'Cloud',
      'Cascade',
    ]);
    const local = workflow.getByRole('radio', { name: 'Local' });
    assert.equal(await local.getAttribute('aria-disabled'), 'true');
    assert.match(await local.getAttribute('title'), /cheap/);
    await workflow.getByRole('radio', { name: 'Auto (Jev)' }).focus();
    await page.keyboard.press('ArrowRight'); // Local (disabled): focus moves, choice stays
    await page.keyboard.press('ArrowRight'); // Cloud
    assert.equal(
      await workflow.getByRole('radio', { name: 'Cloud' }).getAttribute('aria-checked'),
      'true',
    );
    await page.close();
    results.keyboardFlow = 'ok';
  }

  // --- IME: Enter while composing must not send ---
  {
    const page = await openPanel(browser);
    const input = page.getByRole('textbox', { name: 'Prompt' });
    await input.focus();
    await page.keyboard.type('こんにちは');
    await input.dispatchEvent('compositionstart');
    await input.dispatchEvent('keydown', { key: 'Enter', isComposing: true, keyCode: 229 });
    await input.dispatchEvent('compositionend');
    assert.equal((await posted(page, 'prompt.submit')).length, 0, 'IME Enter does not send');
    await page.close();
    results.ime = 'ok';
  }

  // --- AC4: the draft is restored after a reload and saved (debounced) while typing ---
  {
    const chip = {
      ref: { type: 'file', path: 'src/parser.ts' },
      label: 'parser.ts',
      detail: 'src/parser.ts',
      chars: 10,
    };
    const page = await openPanel(browser, { draft: { text: 'half-written idea', chips: [chip] } });
    const input = page.getByRole('textbox', { name: 'Prompt' });
    await page.waitForFunction(
      () => document.querySelector('#desiide-prompt').value === 'half-written idea',
    );
    await page.getByRole('button', { name: 'Remove parser.ts' }).waitFor();
    await input.focus();
    await page.keyboard.press('End');
    await page.keyboard.type(' more');
    await page.waitForTimeout(450);
    const drafts = await posted(page, 'prompt.draft');
    assert.deepEqual(drafts.at(-1).draft, { text: 'half-written idea more', chips: [chip] });
    await page.close();
    results.draft = 'ok';
  }

  // --- AC6: no model configured → onboarding CTA, Enter doesn't send ---
  {
    const page = await openPanel(browser, { hasModels: false });
    const cta = page.getByRole('button', { name: 'Set up a model' });
    await cta.waitFor();
    const input = page.getByRole('textbox', { name: 'Prompt' });
    await input.focus();
    await page.keyboard.type('Fix it');
    await page.keyboard.press('Enter');
    assert.equal((await posted(page, 'prompt.submit')).length, 0, 'AC6: no send without a model');
    await page.getByRole('status').getByText('Connect a model').waitFor();
    await cta.focus();
    await page.keyboard.press('Enter');
    assert.deepEqual(await posted(page, 'command'), [
      { type: 'command', command: 'desiide.setup' },
    ]);
    await page.screenshot({ path: join(shots, 'prompt-no-model.png') });
    await page.close();
    results.noModel = 'ok';
  }

  // Empty state: examples fill the box.
  {
    const page = await openPanel(browser);
    await page.screenshot({ path: join(shots, 'prompt-empty.png') });
    const example = page.locator('.desiide-prompt__example').first();
    await example.focus();
    await page.keyboard.press('Enter');
    assert.match(await page.locator('#desiide-prompt').inputValue(), /^Explain/);
    await page.close();
    results.examples = 'ok';
  }
} finally {
  await browser.close();
}
console.log(JSON.stringify(results, null, 2));
console.log('Prompt Box webview checks passed');
