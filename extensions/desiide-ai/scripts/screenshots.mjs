/* global window, document -- used inside callbacks that Playwright runs in the page */
// Renders the built webview bundle in headless Chromium under Dark+, Light+ and High Contrast
// colors taken from the local VS Code's built-in theme files, plus the Desiide Midnight/Daylight themes, and
// saves PNGs to .screenshots/.
// Approximates VS Code's webview theming (theme colors + registry defaults); final visual QA
// still happens in VS Code itself. No server or port: requests are fulfilled via page.route.
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { colorsFor, cssVars, themes } from './webview-themes.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, '.screenshots');
const origin = 'https://desiide-webview.test';
// UI-3: the transcript of two recorded tasks (happy path selected), with Thinking and a tool open.
const fixture = (name) =>
  JSON.parse(readFileSync(join(root, 'shared/transcript/fixtures', `${name}.json`), 'utf8'));
const streamTasks = ['escalation', 'happy'].map((name) => {
  const f = fixture(name);
  return { id: f.summary.id, summary: f.summary, events: f.events, retryable: true };
});
const types = { '.js': 'text/javascript', '.css': 'text/css', '.ttf': 'font/ttf' };

mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
try {
  for (const theme of themes) {
    const colors = colorsFor(theme);
    for (const [view, showcase, name = view] of [
      ['panel', true],
      ['panel', false, 'prompt'],
      ['panel', false, 'stream'],
      ['decisions', false],
    ]) {
      const page = await browser.newPage({
        viewport: { width: 380, height: 900 },
        deviceScaleFactor: 2,
      });
      await page.route(`${origin}/**`, async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === '/index.html') {
          return route.fulfill({
            contentType: 'text/html',
            body: `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/dist/codicons/codicon.css"><link rel="stylesheet" href="/dist/webview/main.css">
<style>${cssVars(colors)}</style></head>
<body class="${theme.bodyClass}"><div id="root" data-view="${view}"></div>
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
        ({ view, showcase, tasks }) => {
          window.acquireVsCodeApi = () => ({
            postMessage: (m) => {
              if (m?.type === 'ready') {
                setTimeout(() =>
                  window.postMessage({ type: 'init', view, devMode: true, showcase }, '*'),
                );
                if (tasks)
                  setTimeout(() => window.postMessage({ type: 'tasks.snapshot', tasks }, '*'));
              }
            },
            getState: () => undefined,
            setState: () => undefined,
          });
        },
        { view, showcase, tasks: name === 'stream' ? streamTasks : undefined },
      );
      await page.goto(`${origin}/index.html`);
      await page.waitForSelector(
        showcase ? '.desiide-card' : view === 'panel' ? '.desiide-prompt' : '.desiide-empty',
      );
      if (name === 'stream') {
        await page.waitForSelector('.desiide-code .hljs-keyword');
        await page.click('.desiide-thinking__toggle');
        await page.click('.desiide-tool__head');
      }
      await page.evaluate(() => document.fonts.ready);
      const target = join(out, `${theme.name}-${name}.png`);
      await page.screenshot({ path: target, fullPage: true });
      console.log(`saved ${target}`);
      await page.close();
    }
  }
} finally {
  await browser.close();
}
