/* global window, document, getComputedStyle -- used inside callbacks that Playwright runs in the page */
// Task stream (UI-3) checks in headless Chromium against the built bundle, under the webview's
// real CSP (nonce + 'strict-dynamic', so the lazily loaded highlight.js chunks are exercised).
// A fake `acquireVsCodeApi` plays the host and replays the fixtures recorded from the real
// orchestrator (shared/transcript/fixtures).
//   AC2: 5,000 streamed deltas, no long task > 50 ms.  AC4: keyboard-only use, focus, ARIA.
//   Also: rendering of every item kind, actions posted to the host, virtualization over 300 rows.
// Run: pnpm -F desiide-ai test:webview (builds first). Not in verify.sh: it needs a browser.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const shots = join(root, '.screenshots');
const origin = 'https://desiide-webview.test';
const nonce = 'dGVzdC1ub25jZQ==';
const types = { '.js': 'text/javascript', '.css': 'text/css', '.ttf': 'font/ttf' };
const csp = [
  "default-src 'none'",
  `img-src ${origin} data:`,
  `font-src ${origin}`,
  `style-src ${origin}`,
  `script-src 'nonce-${nonce}' 'strict-dynamic'`,
].join('; ');
const colors = `:root{--vscode-foreground:#ccc;--vscode-descriptionForeground:#ccccccb3;
--vscode-focusBorder:#007fd4;--vscode-sideBar-background:#252526;--vscode-editorWidget-background:#252526;
--vscode-input-background:#3c3c3c;--vscode-input-foreground:#ccc;--vscode-button-background:#0e639c;
--vscode-button-foreground:#fff;--vscode-button-secondaryBackground:#3a3d41;--vscode-button-secondaryForeground:#fff;
--vscode-list-activeSelectionBackground:#04395e;--vscode-list-activeSelectionForeground:#fff;
--vscode-widget-border:#454545;--vscode-editorWarning-foreground:#cca700;--vscode-errorForeground:#f48771;
--vscode-textCodeBlock-background:#0a0a0a66;--vscode-textLink-foreground:#3794ff;
--vscode-font-family:-apple-system,sans-serif;--vscode-font-size:13px;--vscode-editor-font-family:Menlo,monospace}`;

const fixture = (name) =>
  JSON.parse(readFileSync(join(root, 'shared/transcript/fixtures', `${name}.json`), 'utf8'));
const happy = fixture('happy');
const escalation = fixture('escalation');
const failure = fixture('failure');
const cancel = fixture('cancel');
const record = (f, retryable = false) => ({
  id: f.summary.id,
  summary: f.summary,
  events: f.events,
  retryable,
});

async function openPanel(browser, { tasks = [], hasModels = true } = {}) {
  const page = await browser.newPage({
    viewport: { width: 400, height: 760 },
    deviceScaleFactor: 2,
  });
  const violations = [];
  page.on('console', (m) => {
    if (/Content Security Policy/i.test(m.text())) violations.push(m.text());
  });
  await page.route(`${origin}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/index.html') {
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<link rel="stylesheet" href="/dist/codicons/codicon.css"><link rel="stylesheet" href="/dist/webview/main.css">
<link rel="stylesheet" href="/colors.css"></head><body class="vscode-dark"><div id="root" data-view="panel"></div>
<script type="module" nonce="${nonce}" src="/dist/webview/main.js"></script></body></html>`,
      });
    }
    if (path === '/colors.css') return route.fulfill({ contentType: 'text/css', body: colors });
    const file = join(root, path);
    return route.fulfill({
      contentType: types[extname(file)] ?? 'application/octet-stream',
      body: readFileSync(file),
    });
  });
  await page.addInitScript(
    ({ tasks, hasModels }) => {
      window.__longTasks = [];
      new PerformanceObserver((list) => {
        for (const e of list.getEntries())
          window.__longTasks.push({ start: e.startTime, ms: e.duration });
      }).observe({ type: 'longtask', buffered: true });
      const reply = (m) => setTimeout(() => window.postMessage(m, '*'));
      let state;
      window.__posted = [];
      window.acquireVsCodeApi = () => ({
        postMessage: (m) => {
          window.__posted.push(m);
          if (m.type === 'ready') {
            reply({ type: 'init', view: 'panel', devMode: false, showcase: false });
            reply({ type: 'prompt.restore', draft: { text: '', chips: [] }, history: [] });
            reply({
              type: 'prompt.config',
              config: {
                hasModels,
                workflows: [{ option: 'cloud-single', enabled: true, hidden: false }],
                defaultPreference: 'balance',
                mock: false,
              },
            });
            reply({ type: 'prompt.tasks', active: [] });
            reply({ type: 'tasks.snapshot', tasks });
          }
        },
        getState: () => state,
        setState: (s) => (state = s),
      });
      window.__send = (m) => window.postMessage(m, '*');
    },
    { tasks, hasModels },
  );
  await page.goto(`${origin}/index.html`);
  await page.waitForFunction(() => window.__posted.some((m) => m.type === 'ready'));
  if (tasks.length > 0) await page.waitForSelector('.desiide-task-header');
  return { page, violations };
}

const posted = (page, type) =>
  page.evaluate((t) => window.__posted.filter((m) => m.type === t), type);
const focused = (page) =>
  page.evaluate(() => {
    const el = document.activeElement;
    return {
      label: el?.getAttribute('aria-label') ?? el?.textContent?.trim().slice(0, 40) ?? '',
      cls: el?.className ?? '',
      outline: el ? getComputedStyle(el).outlineStyle : 'none',
    };
  });
/** Tab until `match` has focus (keyboard only); fails after `max` presses. */
async function tabTo(page, match, max = 40) {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    const f = await focused(page);
    if (match(f)) return f;
  }
  throw new Error('tabTo: target never focused');
}

const results = {};
mkdirSync(shots, { recursive: true });
const browser = await chromium.launch();
try {
  // --- Rendering + keyboard (AC4) on the recorded happy path ---
  {
    const { page, violations } = await openPanel(browser, { tasks: [record(happy, true)] });
    const header = await page.textContent('.desiide-task-header');
    assert.match(header, /Fix the bug in add\(\) in src\/a\.ts/);
    assert.match(header, /Done/);
    assert.match(header, /qwen-local/);
    assert.match(header, /iteration 1/);
    assert.match(header, /3\.9k tokens/);
    assert.match(header, /~\$0\.0018/);
    assert.equal(await page.locator('.desiide-tool').count(), 2);
    assert.equal(await page.locator('[data-slot="edit_proposal"]').count(), 1);
    assert.equal(await page.locator('[data-slot="decision"]').count(), 2);
    assert.equal(await page.locator('.desiide-turn--user').count(), 1);
    // The examples give way to the transcript.
    assert.equal(await page.locator('.desiide-prompt__examples').count(), 0);

    // Highlighting arrives as a lazily imported chunk, allowed by 'strict-dynamic'.
    await page.waitForSelector('.desiide-code .hljs-keyword', { timeout: 5000 });
    assert.deepEqual(violations, [], 'no CSP violations');
    results.highlight = 'lazy typescript chunk loaded under the real CSP';

    // Keyboard only: Retry in the header, the transcript region, Thinking, a tool card, code actions.
    const retry = await tabTo(page, (f) => f.label === 'Retry this task');
    assert.notEqual(retry.outline, 'none', 'visible focus on header buttons');
    await page.keyboard.press('Enter');
    assert.deepEqual((await posted(page, 'task.retry')).at(-1), {
      type: 'task.retry',
      taskId: happy.summary.id,
    });

    const log = await tabTo(page, (f) => f.label === 'Transcript');
    assert.notEqual(log.outline, 'none', 'visible focus on the transcript');
    const role = await page.getAttribute('.desiide-transcript', 'role');
    assert.equal(role, 'log');

    await tabTo(page, (f) => f.cls.includes('desiide-thinking__toggle'));
    assert.equal(
      await page.isVisible('.desiide-thinking__text'),
      false,
      'Thinking starts collapsed',
    );
    await page.keyboard.press('Enter');
    assert.equal(await page.isVisible('.desiide-thinking__text'), true);
    assert.equal(
      (await page.textContent('.desiide-thinking__text')).trim(),
      'The user says `add` is wrong. I should read src/a.ts first.',
    );
    assert.match(await page.textContent('.desiide-thinking__toggle'), /Thought.*ms|Thought.*s/);

    await tabTo(page, (f) => f.cls.includes('desiide-tool__head'));
    await page.keyboard.press('Enter');
    await tabTo(page, (f) => f.label === 'Open full output');
    await page.keyboard.press('Enter');
    assert.deepEqual((await posted(page, 'tool.openOutput')).at(-1), {
      type: 'tool.openOutput',
      taskId: happy.summary.id,
      callId: 'call_read',
    });

    await tabTo(page, (f) => f.label === 'Insert at cursor');
    await page.keyboard.press('Enter');
    assert.deepEqual((await posted(page, 'code.insert')).at(-1), {
      type: 'code.insert',
      code: 'export const add = (a: number, b: number) => a - b;',
    });
    await page.screenshot({ path: join(shots, 'stream-happy.png'), fullPage: true });
    results.keyboard =
      'Retry, transcript (role=log), Thinking, tool card, Open full output, Insert reached and used by Tab + Enter';
    await page.close();
  }

  // --- Task list, errors, cancel ---
  {
    const { page } = await openPanel(browser, {
      tasks: [record(happy), record(escalation), record(failure, true), record(cancel)],
    });
    // The newest task shows first.
    assert.match(await page.textContent('.desiide-task-header'), /Explain the whole module/);
    assert.match(await page.textContent('.desiide-task-header'), /Cancelled/);
    assert.match(await page.textContent('.desiide-turn--assistant'), /Here is a long explanation/);

    await tabTo(page, (f) => f.cls.includes('desiide-task-list__toggle'));
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('.desiide-task-list__item').count(), 4);
    await tabTo(page, (f) => f.label.includes('Explain src/a.ts'));
    await page.keyboard.press('Enter');
    assert.match(await page.textContent('.desiide-task-header'), /Failed/);
    assert.match(await page.textContent('.desiide-error'), /The model rejected the API key/);
    assert.match(await page.textContent('.desiide-error'), /Check your key in Settings\./);
    await tabTo(page, (f) => f.label === 'Open model setup');
    await page.keyboard.press('Enter');
    assert.deepEqual((await posted(page, 'command')).at(-1), {
      type: 'command',
      command: 'desiide.setup',
    });
    await page.screenshot({ path: join(shots, 'stream-failure.png'), fullPage: true });

    // Escalation: approval slots resolved, a rejected tool card.
    await page.click('.desiide-task-list__toggle');
    await page.click('.desiide-task-list__item >> text=Clean dist and publish');
    assert.equal(await page.locator('[data-slot="approval"]').count(), 2);
    assert.match(await page.textContent('.desiide-transcript'), /approved[\s\S]*rejected/);
    await page.screenshot({ path: join(shots, 'stream-escalation.png'), fullPage: true });
    results.list =
      'task list switch by keyboard; auth error → "Open model setup" posts desiide.setup';
    await page.close();
  }

  // --- AC2: 5,000 streamed deltas, no long task > 50 ms ---
  for (const throttle of [1, 4]) {
    const { page } = await openPanel(browser);
    if (throttle > 1) {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
    }
    const stats = await page.evaluate(async () => {
      const ts = () => new Date().toISOString();
      const taskId = 'perf-task';
      window.__send({
        type: 'tasks.summary',
        retryable: false,
        summary: {
          id: taskId,
          kind: 'explain',
          instruction: 'Explain the parser',
          state: 'running',
          models: [],
          iteration: 1,
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: ts(),
          updatedAt: ts(),
        },
      });
      await new Promise((r) => setTimeout(r, 100));
      // Token-sized deltas with markdown: prose, lists, a code fence every ~400 deltas.
      const words = ['The ', 'parser ', 'reads ', '`tokens` ', 'and ', 'builds ', 'an ', 'AST. '];
      const deltas = [];
      for (let i = 0; i < 5000; i++) {
        if (i % 400 === 0) deltas.push('\n\n```ts\nconst node = parse(input);\n');
        else if (i % 400 === 40) deltas.push('\n```\n\n- item one\n- item two\n\n');
        else deltas.push(words[i % words.length]);
      }
      const start = performance.now();
      let seq = 0;
      // Like TaskStore: one post per ~16 ms with whatever arrived (here ~2,000 tokens/s).
      const perBatch = 32;
      for (let i = 0; i < deltas.length; i += perBatch) {
        window.__send({
          type: 'tasks.events',
          events: deltas.slice(i, i + perBatch).map((delta) => ({
            taskId,
            seq: seq++,
            ts: ts(),
            type: 'text_delta',
            messageId: 'm1',
            delta,
          })),
        });
        await new Promise((r) => setTimeout(r, 16));
      }
      const expected = deltas.join('').trim().slice(-20);
      while (!document.querySelector('.desiide-md')?.textContent?.includes('AST.')) {
        await new Promise((r) => setTimeout(r, 16));
      }
      await new Promise((r) => setTimeout(r, 300));
      const long = window.__longTasks.filter((t) => t.start >= start);
      // The observer itself works: a deliberate 80 ms block is recorded.
      const probe = performance.now();
      while (performance.now() - probe < 80);
      await new Promise((r) => setTimeout(r, 100));
      const probeSeen = window.__longTasks.some((t) => t.start >= probe - 1 && t.ms >= 80);
      return {
        probeSeen,
        ms: Math.round(performance.now() - start),
        longTasks: long.length,
        maxLongTaskMs: Math.round(Math.max(0, ...long.map((t) => t.ms))),
        chars: deltas.join('').length,
        codeBlocks: document.querySelectorAll('.desiide-code').length,
        tail: expected,
      };
    });
    results[`ac2_cpu${throttle}x`] = stats;
    assert.ok(stats.probeSeen, 'the long-task observer records long tasks');
    assert.ok(stats.codeBlocks >= 12, `code blocks rendered: ${stats.codeBlocks}`);
    if (throttle === 1) {
      assert.equal(stats.longTasks, 0, `long tasks during streaming: ${JSON.stringify(stats)}`);
    }
    await page.close();
  }

  // --- Virtualization: 1,000 tool calls ---
  {
    const ts = '2026-10-10T00:00:00.000Z';
    const id = 'big-task';
    const events = [{ taskId: id, seq: 0, ts, type: 'state_changed', from: null, to: 'running' }];
    for (let i = 0; i < 1000; i++) {
      const call = {
        id: `c${i}`,
        tool: 'read_file',
        args: { path: `src/f${i}.ts` },
        sideEffect: 'none',
      };
      events.push({ taskId: id, seq: events.length, ts, type: 'tool_call_started', call });
      events.push({
        taskId: id,
        seq: events.length,
        ts,
        type: 'tool_call_finished',
        result: { callId: call.id, ok: true, output: 'ok', truncated: false, durationMs: 3 },
      });
    }
    const summary = { ...happy.summary, id, instruction: 'Read everything', state: 'running' };
    const { page } = await openPanel(browser, {
      tasks: [{ id, summary, events, retryable: false }],
    });
    await page.waitForSelector('.desiide-tool');
    const rows = await page.locator('.desiide-transcript__row').count();
    assert.ok(rows < 150, `rendered ${rows} of 1001 rows`);
    // Following the stream: scrolled to the end, the last call is in the DOM.
    assert.equal(await page.locator('text=src/f999.ts').count(), 1);
    await page.evaluate(() => (document.querySelector('.desiide-transcript').scrollTop = 0));
    await page.waitForSelector('.desiide-turn--user');
    assert.equal(await page.locator('text=src/f999.ts').count(), 0);
    assert.ok(await page.isVisible('text=Latest'), '"Latest" appears when scrolled up');
    results.virtualization = `${rows} of 1001 rows in the DOM; scroll to top renders the start`;
    await page.close();
  }
} finally {
  await browser.close();
}
console.log(JSON.stringify(results, null, 2));
