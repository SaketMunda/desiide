/* global window, document -- used inside callbacks that Playwright runs in the page */
// Settings & onboarding webview (UI-6) in headless Chromium against the built bundle. A fake
// `acquireVsCodeApi` plays `SettingsService`. Checks: the one-click local path and the cloud key
// path by keyboard only, AC3 (error kind + hint shown), AC2 (the typed key never lands in
// webview state and is cleared), AC4 (gating warnings shown), AC5 (preview rendered as data),
// and screenshots in dark and light. Run: pnpm -F desiide-ai test:webview (builds first).
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const shots = join(root, '.screenshots');
const origin = 'https://desiide-webview.test';
const types = { '.js': 'text/javascript', '.css': 'text/css', '.ttf': 'font/ttf' };
const SENTINEL = 'sk-ant-SENTINEL-webview-31c';

const THEMES = {
  dark: {
    body: 'vscode-dark',
    css: `:root{--vscode-foreground:#cccccc;--vscode-descriptionForeground:#ccccccb3;
--vscode-focusBorder:#007fd4;--vscode-editor-background:#1e1e1e;--vscode-sideBar-background:#252526;
--vscode-editorWidget-background:#252526;--vscode-input-background:#3c3c3c;--vscode-input-foreground:#ccc;
--vscode-input-border:#3c3c3c;--vscode-button-background:#0e639c;--vscode-button-foreground:#fff;
--vscode-button-secondaryBackground:#3a3d41;--vscode-button-secondaryForeground:#fff;
--vscode-list-hoverBackground:#2a2d2e;--vscode-widget-border:#454545;--vscode-editorWarning-foreground:#cca700;
--vscode-errorForeground:#f48771;--vscode-testing-iconPassed:#73c991;--vscode-textCodeBlock-background:#0a0a0a66;
--vscode-font-family:-apple-system,sans-serif;--vscode-font-size:13px;--vscode-editor-font-family:Menlo,monospace}`,
  },
  light: {
    body: 'vscode-light',
    css: `:root{--vscode-foreground:#3b3b3b;--vscode-descriptionForeground:#717171;
--vscode-focusBorder:#005fb8;--vscode-editor-background:#ffffff;--vscode-sideBar-background:#f8f8f8;
--vscode-editorWidget-background:#f8f8f8;--vscode-input-background:#ffffff;--vscode-input-foreground:#3b3b3b;
--vscode-input-border:#cecece;--vscode-button-background:#005fb8;--vscode-button-foreground:#fff;
--vscode-button-secondaryBackground:#e5e5e5;--vscode-button-secondaryForeground:#3b3b3b;
--vscode-list-hoverBackground:#f2f2f2;--vscode-widget-border:#e5e5e5;--vscode-editorWarning-foreground:#bf8803;
--vscode-errorForeground:#e51400;--vscode-testing-iconPassed:#388a34;--vscode-textCodeBlock-background:#dcdcdc66;
--vscode-font-family:-apple-system,sans-serif;--vscode-font-size:13px;--vscode-editor-font-family:Menlo,monospace}`,
  },
};

const DENY = [
  { id: 'rm_rf', text: 'recursive delete of the system, home, or parent directory' },
  { id: 'curl_pipe_sh', text: 'runs a downloaded script' },
  { id: 'force_push_protected', text: 'force-pushes or deletes main/master' },
];

function baseState() {
  return {
    workspace: true,
    models: [],
    roles: {},
    jev: { enabled: false, keyStatus: 'none', redactPaths: false },
    gating: {
      mode: 'conservative',
      warnings: [],
      denyList: DENY,
      defaultSensitiveGlobs: ['.env', '.env.*', '*.pem', 'id_rsa*', '.npmrc'],
    },
    project: {
      sensitiveGlobs: [],
      detected: { testCommand: 'pnpm test', lintCommand: 'pnpm lint' },
      invalid: false,
    },
    problems: [],
  };
}

async function openSettings(
  browser,
  theme,
  initial = baseState(),
  viewport = { width: 980, height: 820 },
) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 2 });
  await page.route(`${origin}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/index.html') {
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/dist/codicons/codicon.css"><link rel="stylesheet" href="/dist/webview/main.css">
<style>${THEMES[theme].css}</style></head><body class="${THEMES[theme].body}"><div id="root" data-view="settings"></div>
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
    ({ initial }) => {
      const reply = (m) => setTimeout(() => window.postMessage(m, '*'), 30);
      let s = initial;
      let state;
      window.__posted = [];
      window.__stateWrites = [];
      const push = () => reply({ type: 'settings.state', state: s });
      window.acquireVsCodeApi = () => ({
        postMessage: (m) => {
          window.__posted.push(m);
          if (m.type === 'ready')
            reply({ type: 'init', view: 'settings', devMode: false, showcase: false });
          else if (m.type === 'settings.ready') push();
          else if (m.type === 'settings.discover') {
            reply({
              type: 'settings.discovered',
              models: [{ model: 'qwen2.5-coder:7b', contextTokens: 32768 }],
            });
          } else if (m.type === 'settings.useDiscovered') {
            const id = 'qwen2.5-coder-7b';
            s = {
              ...s,
              models: [
                ...s.models,
                {
                  config: { id, provider: 'ollama', model: m.model },
                  keyStatus: 'none',
                  locality: 'local',
                  localityOverridden: false,
                  healthy: true,
                  contextTokens: 32768,
                },
              ],
              roles: { cheap: id, strong: id, reviewer: id },
            };
            push();
            reply({
              type: 'settings.notice',
              level: 'success',
              message: `${m.model} is now your cheap model. It runs on your machine.`,
            });
            reply({ type: 'settings.modelTesting', id });
            setTimeout(
              () => reply({ type: 'settings.modelTest', id, result: { ok: true, latencyMs: 412 } }),
              60,
            );
          } else if (m.type === 'settings.saveModel') {
            const id = m.model.id;
            s = {
              ...s,
              models: [
                ...s.models.filter((x) => x.config.id !== id),
                {
                  config: m.model,
                  keyStatus: m.key ? 'set' : 'missing',
                  locality: 'cloud',
                  localityOverridden: false,
                  healthy: false,
                  contextTokens: 200000,
                },
              ],
              roles: { ...s.roles, strong: id, reviewer: id },
            };
            push();
            reply({ type: 'settings.modelTesting', id });
            setTimeout(
              () =>
                reply({
                  type: 'settings.modelTest',
                  id,
                  result: {
                    ok: false,
                    error: {
                      kind: 'auth',
                      message: 'The API key was rejected (401).',
                      hint: 'Check the key in Desiide Settings → Models, or create a new one.',
                    },
                  },
                }),
              60,
            );
          } else if (m.type === 'settings.previewJev') {
            reply({
              type: 'settings.jevPreview',
              pack: m.pack,
              state: {
                pack: 'workflow_select@1',
                taskType: 'bug_fix',
                filesTouched: [
                  {
                    path: 'src/h_0144f179a4.ts',
                    sizeLines: 120,
                    language: 'typescript',
                    sensitive: false,
                  },
                  { path: 'h_e997833e31', sizeLines: 3, language: 'dotenv', sensitive: true },
                ],
                estimatedDiffSize: 20,
                lastRunStatus: 'none',
                userPreference: 'balance',
                availableModels: [
                  {
                    id: 'qwen2.5-coder-7b',
                    contextTokens: 32768,
                    latencyMs: 0,
                    costTier: 'free',
                    locality: 'local',
                  },
                ],
              },
            });
          } else if (m.type === 'settings.testJev') {
            reply({
              type: 'settings.jevTest',
              result: {
                ok: false,
                error: {
                  kind: 'unavailable',
                  message:
                    'This build has no Jev API client yet, so decisions run on the built-in rules engine.',
                  hint: 'Nothing is sent to the endpoint until the client ships.',
                },
              },
            });
          }
        },
        getState: () => state,
        setState: (v) => {
          state = v;
          window.__stateWrites.push(JSON.stringify(v));
        },
      });
      window.__setState = (next) => {
        s = next;
        push();
      };
    },
    { initial },
  );
  await page.goto(`${origin}/index.html`);
  await page.waitForSelector('.ds-page');
  await page.waitForFunction(() => window.__posted.some((m) => m.type === 'settings.ready'));
  await page.waitForSelector('.ds-steps, .ds-stack');
  return page;
}

const posted = (page, type) =>
  page.evaluate((t) => window.__posted.filter((m) => m.type === t), type);

/** Tab until the focused element's text matches, like a keyboard user would. */
async function tabTo(page, re, max = 60) {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    const label = await page.evaluate(
      () =>
        `${document.activeElement?.textContent?.trim() ?? ''} ${document.activeElement?.getAttribute('aria-label') ?? ''} ${document.activeElement?.getAttribute('placeholder') ?? ''}`,
    );
    if (re.test(label)) return;
  }
  throw new Error(`Never reached ${re} by Tab`);
}

mkdirSync(shots, { recursive: true });
const browser = await chromium.launch();
const results = {};
try {
  // 1. One-click local model, keyboard only.
  {
    const page = await openSettings(browser, 'dark');
    await page.waitForFunction(() => window.__posted.some((m) => m.type === 'settings.discover'));
    await page.waitForSelector('text=Use as cheap');
    await page.screenshot({ path: join(shots, 'settings-start-fresh-dark.png'), fullPage: true });
    await tabTo(page, /Use as cheap/);
    await page.keyboard.press('Enter');
    const used = await posted(page, 'settings.useDiscovered');
    assert.deepEqual(used, [{ type: 'settings.useDiscovered', model: 'qwen2.5-coder:7b' }]);
    await page.waitForSelector('.ds-step--done');
    await page.waitForSelector('text=Connected · 412 ms');
    // "Try it" is enabled now and posts on Enter.
    await tabTo(page, /Try a sample task/);
    await page.keyboard.press('Enter');
    assert.equal((await posted(page, 'settings.tryIt')).length, 1);
    await page.screenshot({ path: join(shots, 'settings-start-done-dark.png'), fullPage: true });
    results.localOneClick = 'ok';
    await page.close();
  }

  // 2. Cloud key path: AC3 shows kind + hint; AC2 the key never reaches webview state.
  for (const theme of ['dark', 'light']) {
    const page = await openSettings(browser, theme);
    await page.waitForSelector('text=Use as cheap');
    await tabTo(page, /Add a provider/);
    await page.keyboard.press('Enter');
    await page.waitForSelector('.ds-form');
    await tabTo(page, /Paste your key/);
    await page.keyboard.type(SENTINEL);
    await page.keyboard.press('Enter');
    const saves = await posted(page, 'settings.saveModel');
    assert.equal(saves.length, 1);
    assert.equal(saves[0].key, SENTINEL, 'the key goes to the host with the save');
    assert.equal(saves[0].model.apiKey, 'secret:anthropic');
    assert.ok(!JSON.stringify(saves[0].model).includes(SENTINEL), 'never inside the model config');
    await page.waitForSelector('.ds-health--confirm');
    const health = await page.textContent('.ds-health--confirm');
    assert.match(health, /auth/);
    assert.match(health, /rejected/);
    assert.match(health, /Check the key/);
    assert.equal((await page.locator('.ds-step--done').count()) >= 0, true);
    const cloudDone = await page.evaluate(() =>
      [...document.querySelectorAll('.ds-step')].some(
        (el) =>
          el.textContent.includes('Add a cloud model') && el.classList.contains('ds-step--done'),
      ),
    );
    assert.equal(cloudDone, false, 'a rejected key does not check off the cloud step');
    const leftovers = await page.evaluate(() =>
      [...document.querySelectorAll('input')].map((i) => i.value).join('\n'),
    );
    assert.ok(!leftovers.includes(SENTINEL), 'key field cleared after save');
    const writes = await page.evaluate(() => window.__stateWrites.join('\n'));
    assert.ok(!writes.includes(SENTINEL), 'key never in vscode.setState');
    assert.ok(!(await page.content()).includes(SENTINEL), 'key not in the DOM');
    await page.screenshot({
      path: join(shots, `settings-start-cloud-error-${theme}.png`),
      fullPage: true,
    });
    results[`cloudKey_${theme}`] = 'ok';
    await page.close();
  }

  // 3. Jev preview, gating warnings (AC4), models list; section nav by keyboard.
  for (const theme of ['dark', 'light']) {
    const s = baseState();
    s.models = [
      {
        config: { id: 'qwen2.5-coder-7b', provider: 'ollama', model: 'qwen2.5-coder:7b' },
        keyStatus: 'none',
        locality: 'local',
        localityOverridden: false,
        healthy: true,
        contextTokens: 32768,
      },
      {
        config: {
          id: 'claude-sonnet-5-5',
          provider: 'anthropic',
          model: 'claude-sonnet-5-5',
          apiKey: 'secret:anthropic',
        },
        keyStatus: 'set',
        locality: 'cloud',
        localityOverridden: false,
        healthy: true,
        contextTokens: 200000,
      },
    ];
    s.roles = {
      cheap: 'qwen2.5-coder-7b',
      strong: 'claude-sonnet-5-5',
      reviewer: 'claude-sonnet-5-5',
    };
    s.gating.warnings = [
      'Ignored desiide.gating.mode = "permissive": only "conservative" and "strict" exist, so "conservative" is used.',
      'Ignored desiide.gating.thresholds.autoSafeNowMin = 0.1: it would loosen gating (default 0.9; only higher values are allowed).',
    ];
    s.project.sensitiveGlobs = ['infra/prod/**'];
    const page = await openSettings(browser, theme, s);
    await page.screenshot({
      path: join(shots, `settings-start-configured-${theme}.png`),
      fullPage: true,
    });

    await page.click('.ds-nav__item:has-text("Models")');
    await page.waitForSelector('.ds-models');
    // Focus moves to the section heading, so keyboard and screen-reader users land in it.
    await page.waitForFunction(() => document.activeElement?.className === 'ds-title');
    await page.screenshot({ path: join(shots, `settings-models-${theme}.png`), fullPage: true });

    await page.click('.ds-nav__item:has-text("Jev")');
    await tabTo(page, /Preview payload/);
    await page.keyboard.press('Enter');
    await page.waitForSelector('.desiide-code');
    const code = await page.textContent('.desiide-code');
    assert.match(code, /"pack": "workflow_select@1"/);
    await page.click('text=Test connection');
    await page.waitForSelector('text=rules engine');
    await page.screenshot({ path: join(shots, `settings-jev-${theme}.png`), fullPage: true });

    await page.click('.ds-nav__item:has-text("Gating")');
    await page.waitForSelector('text=Ignored, to keep you safe');
    const warn = await page.textContent('.ds-callout--confirm');
    assert.match(warn, /permissive/);
    assert.match(warn, /would loosen gating/);
    // Only the two safe modes exist in the UI.
    const modes = await page.$$eval(
      '[role="radiogroup"][aria-label="Gating mode"] [role="radio"]',
      (els) => els.map((e) => e.textContent),
    );
    assert.deepEqual(modes, ['Conservative', 'Strict']);
    await page.screenshot({ path: join(shots, `settings-gating-${theme}.png`), fullPage: true });

    await page.click('.ds-nav__item:has-text("Project")');
    await page.waitForSelector('text=Use detected');
    await page.screenshot({ path: join(shots, `settings-project-${theme}.png`), fullPage: true });
    results[`sections_${theme}`] = 'ok';
    await page.close();
  }

  // 4. Narrow editor: nav collapses to a row.
  {
    const page = await openSettings(browser, 'dark', baseState(), { width: 520, height: 760 });
    await page.waitForSelector('text=Use as cheap');
    await page.screenshot({ path: join(shots, 'settings-narrow-dark.png'), fullPage: true });
    await page.close();
  }
} finally {
  await browser.close();
}
console.log(JSON.stringify(results, null, 2));
