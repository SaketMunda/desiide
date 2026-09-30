/* global window, document -- used inside callbacks that Playwright runs in the page */
// Renders the built webview bundle in headless Chromium under Dark+, Light+ and High Contrast
// colors taken from the local VS Code's built-in theme files, plus the Desiide Dark/Light themes, and
// saves PNGs to .screenshots/.
// Approximates VS Code's webview theming (theme colors + registry defaults); final visual QA
// still happens in VS Code itself. No server or port: requests are fulfilled via page.route.
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, '.screenshots');
const themeDir =
  process.env.VSCODE_THEMES ??
  '/Applications/Visual Studio Code.app/Contents/Resources/app/extensions/theme-defaults/themes';

/** JSONC → JSON: drop comments outside strings, then trailing commas. */
function parseJsonc(text) {
  let s = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
      s += text.slice(start, i + 1);
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      s += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2) + 1;
    } else s += c;
  }
  return JSON.parse(s.replace(/,(\s*[}\]])/g, '$1'));
}

function themeColors(file, dir = themeDir) {
  const json = parseJsonc(readFileSync(join(dir, file), 'utf8'));
  const base = json.include ? themeColors(json.include.replace('./', ''), dir) : {};
  return { ...base, ...(json.colors ?? {}) };
}

// Registry defaults for keys the theme files leave unset (from VS Code's color registry).
const defaults = {
  dark: {
    foreground: '#cccccc',
    descriptionForeground: '#ccccccb3',
    focusBorder: '#007fd4',
    'sideBar.background': '#252526',
    'editorWidget.background': '#252526',
    'widget.shadow': '#0000005c',
    'button.background': '#0e639c',
    'button.foreground': '#ffffff',
    'button.hoverBackground': '#1177bb',
    'button.secondaryBackground': '#3a3d41',
    'button.secondaryForeground': '#ffffff',
    'button.secondaryHoverBackground': '#45494e',
    'toolbar.hoverBackground': '#5a5d5e50',
    'textCodeBlock.background': '#0a0a0a66',
    'icon.foreground': '#c5c5c5',
    'testing.iconPassed': '#73c991',
    'editorWarning.foreground': '#cca700',
    errorForeground: '#f48771',
  },
  light: {
    foreground: '#616161',
    descriptionForeground: '#717171',
    focusBorder: '#0090f1',
    'sideBar.background': '#f3f3f3',
    'editorWidget.background': '#f3f3f3',
    'widget.shadow': '#00000029',
    'button.background': '#007acc',
    'button.foreground': '#ffffff',
    'button.hoverBackground': '#0062a3',
    'button.secondaryBackground': '#5f6a79',
    'button.secondaryForeground': '#ffffff',
    'button.secondaryHoverBackground': '#4c5561',
    'toolbar.hoverBackground': '#b8b8b850',
    'textCodeBlock.background': '#dcdcdc66',
    'icon.foreground': '#424242',
    'testing.iconPassed': '#388a34',
    'editorWarning.foreground': '#bf8803',
    errorForeground: '#a1260d',
  },
  hc: {
    foreground: '#ffffff',
    descriptionForeground: '#ffffffb3',
    focusBorder: '#f38518',
    contrastBorder: '#6fc3df',
    'sideBar.background': '#000000',
    'editorWidget.background': '#0c141f',
    'button.background': '#000000',
    'button.foreground': '#ffffff',
    'button.border': '#6fc3df',
    'button.secondaryBackground': '#000000',
    'button.secondaryForeground': '#ffffff',
    'toolbar.hoverBackground': '#00000000',
    'textCodeBlock.background': '#000000',
    'icon.foreground': '#ffffff',
    'testing.iconPassed': '#73c991',
    'editorWarning.foreground': '#fff00f',
    errorForeground: '#f48771',
    'widget.border': '#6fc3df',
  },
};

const themes = [
  { name: 'dark-plus', file: 'dark_plus.json', kind: 'dark', bodyClass: 'vscode-dark' },
  { name: 'light-plus', file: 'light_plus.json', kind: 'light', bodyClass: 'vscode-light' },
  { name: 'high-contrast', file: 'hc_black.json', kind: 'hc', bodyClass: 'vscode-high-contrast' },
  {
    name: 'desiide-dark',
    file: 'desiide-dark-color-theme.json',
    dir: join(root, 'themes'),
    kind: 'dark',
    bodyClass: 'vscode-dark',
  },
  {
    name: 'desiide-light',
    file: 'desiide-light-color-theme.json',
    dir: join(root, 'themes'),
    kind: 'light',
    bodyClass: 'vscode-light',
  },
];

function cssVars(colors) {
  const vars = Object.entries(colors).map(([k, v]) => `--vscode-${k.replace(/\./g, '-')}: ${v};`);
  vars.push(
    "--vscode-font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;",
    '--vscode-font-size: 13px;',
    "--vscode-editor-font-family: Menlo, Monaco, 'Courier New', monospace;",
    '--vscode-editor-font-size: 12px;',
  );
  return `:root{${vars.join('')}}`;
}

const origin = 'https://desiide-webview.test';
const types = { '.js': 'text/javascript', '.css': 'text/css', '.ttf': 'font/ttf' };

mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
try {
  for (const theme of themes) {
    const colors = { ...defaults[theme.kind], ...themeColors(theme.file, theme.dir) };
    for (const [view, showcase] of [
      ['panel', true],
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
        ({ view, showcase }) => {
          window.acquireVsCodeApi = () => ({
            postMessage: (m) => {
              if (m?.type === 'ready') {
                setTimeout(() =>
                  window.postMessage({ type: 'init', view, devMode: true, showcase }, '*'),
                );
              }
            },
            getState: () => undefined,
            setState: () => undefined,
          });
        },
        { view, showcase },
      );
      await page.goto(`${origin}/index.html`);
      await page.waitForSelector(showcase ? '.desiide-card' : '.desiide-empty');
      await page.evaluate(() => document.fonts.ready);
      const target = join(out, `${theme.name}-${view}.png`);
      await page.screenshot({ path: target, fullPage: true });
      console.log(`saved ${target}`);
      await page.close();
    }
  }
} finally {
  await browser.close();
}
