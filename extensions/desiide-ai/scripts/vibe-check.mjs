/* global document -- used inside callbacks that Playwright runs in the page */
// UI-7 AC6 evidence: side-by-side window screenshots of stock VS Code (default theme, desiide-ai
// installed from its .vsix) and the built Desiide app (Desiide Midnight), each with
//   1. an empty editor, and
//   2. a real agent run: the "Try it" task on a small sample project, on a local Ollama model.
// Screenshots are the app window only (Playwright's renderer capture), never the screen.
//
//   node scripts/vibe-check.mjs [vscode|desiide]   (the built app, VS Code in /Applications, Ollama)
//   DESIIDE_VIBE_MODEL=qwen3.5:2b-q4_K_M   the Ollama model to use
// Not a test: a dev tool for the PR's vibe check. Profiles live under /tmp/dz (the IPC socket path
// must stay short).
import { _electron as electron } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, '.screenshots/vibe');
const base = '/tmp/dz/vibe';
const model = process.env.DESIIDE_VIBE_MODEL ?? 'qwen3.5:2b-q4_K_M';
const apps = [
  {
    // desiide-ai is installed from its .vsix (pnpm -F desiide-ai package): launched as a development
    // extension, VS Code would switch to the extension's own theme and hide the stock look.
    name: 'vscode',
    exe: '/Applications/Visual Studio Code.app/Contents/MacOS/Code',
    cli: '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
    extra: [],
  },
  {
    name: 'desiide',
    exe: join(
      root,
      `../../editor/VSCode-darwin-${process.arch}/Desiide.app/Contents/MacOS/Desiide`,
    ),
    extra: [],
  },
];

const SAMPLE = {
  'package.json':
    '{\n  "name": "checkout-api",\n  "type": "module",\n  "scripts": { "test": "node --test" }\n}\n',
  'src/auth/session.ts': `import { sign, verify } from './tokens.ts';

const COOKIE = 'sid';
const MAX_AGE_S = 60 * 60 * 8;

/** Starts a session and remembers where the user was going. */
export function startSession(userId: string, returnTo: string): Response {
  const token = sign({ userId, exp: Date.now() / 1000 + MAX_AGE_S });
  const headers = new Headers({ Location: returnTo });
  // TODO: the cookie is set after the redirect is decided, so /login loops.
  headers.append('Set-Cookie', \`\${COOKIE}=\${token}; HttpOnly; Path=/\`);
  return new Response(null, { status: 302, headers });
}

export function readSession(req: Request): { userId: string } | null {
  const raw = req.headers.get('cookie')?.match(/sid=([^;]+)/)?.[1];
  return raw ? verify(raw) : null;
}
`,
  'src/auth/tokens.ts': `export const sign = (claims: object): string => btoa(JSON.stringify(claims));
export const verify = (token: string) => JSON.parse(atob(token));
`,
  'README.md': '# checkout-api\n\nA tiny checkout service with cookie sessions.\n',
};

function prepare(app) {
  const dir = join(base, app.name);
  rmSync(dir, { recursive: true, force: true });
  const ws = join(dir, 'checkout-api');
  for (const [path, text] of Object.entries(SAMPLE)) {
    mkdirSync(dirname(join(ws, path)), { recursive: true });
    writeFileSync(join(ws, path), text);
  }
  const user = join(dir, 'ud/User');
  mkdirSync(user, { recursive: true });
  writeFileSync(
    join(user, 'settings.json'),
    JSON.stringify(
      {
        'desiide.models': [{ id: 'qwen-local', provider: 'ollama', model }],
        'desiide.roles': { cheap: 'qwen-local', strong: 'qwen-local' },
        'workbench.startupEditor': 'none',
        'security.workspace.trust.enabled': false,
        'update.mode': 'none',
        'telemetry.telemetryLevel': 'off',
        'extensions.autoCheckUpdates': false,
        'workbench.tips.enabled': false,
        'chat.disableAIFeatures': true,
      },
      null,
      2,
    ),
  );
  if (app.cli) {
    execFileSync(
      app.cli,
      [
        `--user-data-dir=${join(dir, 'ud')}`,
        `--extensions-dir=${join(dir, 'ext')}`,
        '--install-extension',
        join(root, 'desiide-ai.vsix'),
      ],
      { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } },
    );
  }
  return { dir, ws };
}

/** The webview frame that renders `selector` (VS Code nests each webview in two iframes). */
async function webviewFrame(page, selector, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const frame of page.frames()) {
      if (await frame.$(selector).catch(() => null)) return frame;
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`no webview frame with ${selector}`);
}

async function command(page, title) {
  await page.keyboard.press('Meta+Shift+P');
  await page.keyboard.type(title, { delay: 10 });
  await page.waitForTimeout(400);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(800);
}

mkdirSync(out, { recursive: true });
const only = process.argv[2];
for (const app of apps.filter((a) => !only || a.name === only)) {
  const { dir, ws } = prepare(app);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const electronApp = await electron.launch({
    executablePath: app.exe,
    env,
    args: [
      `--user-data-dir=${join(dir, 'ud')}`,
      `--extensions-dir=${join(dir, 'ext')}`,
      '--disable-workspace-trust',
      '--skip-release-notes',
      ...app.extra,
      ws,
    ],
    timeout: 90000,
  });
  try {
    const page = await electronApp.firstWindow();
    await electronApp.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      w.setSize(1440, 900);
      w.center();
    });
    await page.waitForSelector('.monaco-workbench', { timeout: 90000 });
    await page.waitForTimeout(6000);

    // 1. Empty editor.
    await command(page, 'View: Close All Editors');
    await page.waitForTimeout(1500);
    await page.screenshot({ path: join(out, `${app.name}-empty.png`) });

    // 2. An agent run: open a file, then the Try it task in the Desiide panel.
    await page.keyboard.press('Meta+P');
    await page.keyboard.type('session.ts', { delay: 10 });
    await page.waitForTimeout(600);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1000);
    await command(page, 'Desiide: Try a Sample Task');
    const frame = await webviewFrame(page, '.desiide-prompt__input');
    await frame.waitForFunction(
      () => document.querySelector('.desiide-prompt__input')?.value.length > 0,
      undefined,
      { timeout: 15000 },
    );
    await frame.focus('.desiide-prompt__input');
    await frame.press('.desiide-prompt__input', 'Enter');
    await frame.waitForSelector('.desiide-task-header', { timeout: 30000 });
    // Mid-run first (thinking / tools), then the finished task.
    await page.waitForTimeout(2500);
    await page.screenshot({ path: join(out, `${app.name}-run-live.png`) });
    await frame
      .waitForFunction(
        () =>
          /Done|Failed|Cancelled/.test(document.querySelector('.desiide-pill')?.textContent ?? ''),
        undefined,
        { timeout: 180000, polling: 1000 },
      )
      .catch(() => console.warn(`${app.name}: the task did not finish in 3 min`));
    await page.waitForTimeout(1500);
    await page.screenshot({ path: join(out, `${app.name}-run.png`) });
    console.log(`${app.name}: saved ${out}/${app.name}-{empty,run-live,run}.png`);
  } finally {
    await electronApp.close().catch(() => undefined);
  }
}
