/* global document -- page.evaluate callbacks run in the browser */
// Renders the social kit (Midnight Maker, ADR-023) to PNGs at each platform's size.
// Layouts are HTML so they use the site's own fonts (site/fonts). Re-run after any change:
//   node brand/social/render.mjs
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = join(here, '../..');
const require = createRequire(join(root, 'extensions/desiide-ai/package.json'));
const { chromium } = require('playwright-core');

// Fonts are inlined: Chromium treats file:// fonts as cross-origin and won't load them.
const font = (f) =>
  `data:font/woff2;base64,${readFileSync(join(root, 'site/fonts', f)).toString('base64')}`;
const wm = readFileSync(join(root, 'brand/wordmark-ink.svg'), 'utf8').match(/ d="([^"]+)"/)[1];
const icon = `data:image/svg+xml;base64,${readFileSync(join(root, 'brand/app-icon-glossy.svg')).toString('base64')}`;
const HANDLE = '@desiideonx';
const SITE = 'desiide.com';

const base = `
@font-face{font-family:B;font-weight:400 800;font-stretch:75% 100%;src:url(${font('BricolageGrotesque.woff2')})}
@font-face{font-family:G;font-weight:400 600;src:url(${font('Geist.woff2')})}
@font-face{font-family:M;font-weight:400 500;src:url(${font('GeistMono.woff2')})}
:root{--bg:#0A0C12;--fg:#ECEDE8;--muted:#9AA1B4;--dim:#626A80;--line:rgba(236,237,232,.09);--lime:#C6FF3D;--violet:#9C8CFF;--cyan:#5CE1E6;--amber:#FFB547;--red:#FF6B6B}
*{box-sizing:border-box;margin:0}
html,body{width:100%;height:100%;background:var(--bg);color:var(--fg);font-family:G,sans-serif;overflow:hidden}
.stage{position:relative;width:100%;height:100%;overflow:hidden;isolation:isolate}
.grid{position:absolute;inset:0;z-index:-2;background-image:linear-gradient(var(--line) 1px,transparent 1px),linear-gradient(90deg,var(--line) 1px,transparent 1px);background-size:var(--cell,56px) var(--cell,56px);-webkit-mask-image:radial-gradient(ellipse 70% 80% at var(--gx,60%) 45%,#000 20%,transparent 75%)}
.glow{position:absolute;z-index:-1;border-radius:50%;filter:blur(var(--blur,90px))}
.grain{position:absolute;inset:0;z-index:5;opacity:.08;mix-blend-mode:overlay;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")}
h1{font:800 var(--h,120px)/.88 B,sans-serif;font-stretch:80%;letter-spacing:-.022em}
h1 .r{color:var(--lime)}
h1 .r::after{content:"";display:inline-block;width:.09em;height:.72em;margin-left:.06em;background:var(--lime);vertical-align:-.02em}
.mono{font:400 var(--m,18px)/1.4 M,monospace;color:var(--muted);letter-spacing:.02em}
.eyebrow{font:500 var(--m,16px)/1 M,monospace;letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}
.chip{display:inline-flex;align-items:center;gap:.6em;padding:.55em .8em;border-radius:.7em;font:400 var(--c,15px)/1 M,monospace;color:var(--fg);background:rgba(18,22,36,.85);border:1px solid rgba(236,237,232,.14);white-space:nowrap}
.chip.v{border-color:rgba(156,140,255,.45);background:rgba(156,140,255,.1);box-shadow:0 0 30px -8px rgba(156,140,255,.6)}
.chip.a{border-color:rgba(255,181,71,.45);background:rgba(255,181,71,.07)}
.chip.l{border-color:rgba(198,255,61,.45);background:rgba(198,255,61,.07)}
.tag{font:500 .72em/1 M,monospace;letter-spacing:.1em;padding:.4em .55em;border-radius:.4em;text-transform:uppercase}
.tag.v{background:rgba(156,140,255,.22);color:var(--violet)}.tag.l{background:rgba(198,255,61,.18);color:var(--lime)}
.tag.a{background:rgba(255,181,71,.18);color:var(--amber)}.tag.c{background:rgba(92,225,230,.16);color:var(--cyan)}
.plus{color:var(--lime)}.minus{color:var(--red)}
.bar{display:inline-block;width:4em;height:.3em;border-radius:1em;background:rgba(236,237,232,.15);overflow:hidden}.bar i{display:block;height:100%;width:82%;background:var(--violet)}
.chips{display:flex;flex-direction:column;align-items:flex-start;gap:var(--cg,12px)}
.brand{display:flex;align-items:center;gap:.6em}
.brand img{width:var(--i,44px);height:var(--i,44px);filter:drop-shadow(0 6px 14px rgba(0,0,0,.6))}
.brand svg{height:calc(var(--i,44px)*.46);width:auto;color:var(--fg)}
.abs{position:absolute}
`;
const wordmark = `<svg viewBox="0 0 4139 873"><path fill="currentColor" d="${wm}"/></svg>`;
const brand = `<div class="brand"><img src="${icon}" alt="">${wordmark}</div>`;
const chips = `
  <span class="chip v"><span class="tag v">route</span>cascade → qwen3.5:2b <span class="tag l">local</span><span class="bar"><i></i></span></span>
  <span class="chip a"><span class="tag a">ask</span>run pnpm test auth</span>
  <span class="chip l"><span class="tag l">approved</span>2 files <span class="plus">+18</span> <span class="minus">−7</span></span>`;
const headline = `Vibe code,<br>with <span class="r">receipts.</span>`;
const glows = (a, b, c) => `
  <div class="glow" style="${a};background:rgba(198,255,61,.16)"></div>
  <div class="glow" style="${b};background:rgba(156,140,255,.22)"></div>
  ${c ? `<div class="glow" style="${c};background:rgba(92,225,230,.10)"></div>` : ''}`;

const ASSETS = {
  // Profile picture for X, LinkedIn, YouTube, Instagram, GitHub. Platforms crop to a circle.
  'avatar.png': [
    800,
    800,
    `
    <div class="stage" style="display:grid;place-items:center;--blur:70px">
      ${glows('width:420px;height:420px;left:190px;top:330px', 'width:360px;height:360px;left:-60px;top:-60px')}
      <img src="${icon}" style="width:640px;height:640px;filter:drop-shadow(0 30px 40px rgba(0,0,0,.7))" alt="">
      <div class="grain"></div>
    </div>`,
  ],
  // X header. The avatar covers the bottom-left on desktop; phones crop top and bottom.
  'x-header.png': [
    1500,
    500,
    `
    <div class="stage" style="--gx:70%;--h:140px;--m:19px;--c:17px">
      <div class="grid"></div>
      ${glows('width:520px;height:420px;left:520px;top:-200px', 'width:620px;height:520px;right:-220px;top:60px', 'width:300px;height:300px;left:-80px;top:-120px')}
      <div class="abs chips" style="left:56px;top:56px">${chips}</div>
      <div class="abs" style="left:560px;top:96px">
        <h1>${headline}</h1>
        <p class="mono" style="margin-top:26px">open-source AI IDE · your models · every decision visible</p>
      </div>
      <div class="abs eyebrow" style="right:48px;top:40px;--m:15px">${SITE} · ${HANDLE}</div>
      <div class="grain"></div>
    </div>`,
  ],
  // LinkedIn personal/company banner. The avatar covers the bottom-left.
  'linkedin-banner.png': [
    1584,
    396,
    `
    <div class="stage" style="--gx:75%;--h:112px;--m:17px;--c:16px;--cell:48px">
      <div class="grid"></div>
      ${glows('width:480px;height:360px;left:600px;top:-180px', 'width:560px;height:460px;right:-200px;top:20px')}
      <div class="abs chips" style="left:48px;top:36px;--cg:10px">${chips}</div>
      <div class="abs" style="right:64px;top:70px;text-align:right">
        <h1>${headline}</h1>
        <p class="mono" style="margin-top:22px">open-source AI IDE · your models · every decision visible</p>
      </div>
      <div class="grain"></div>
    </div>`,
  ],
  // YouTube channel art: everything readable sits in the 1546×423 centre safe area.
  'youtube-banner.png': [
    2560,
    1440,
    `
    <div class="stage" style="--gx:50%;--h:170px;--m:24px;--c:24px;--cell:72px;--blur:140px;--i:64px">
      <div class="grid"></div>
      ${glows('width:900px;height:700px;left:500px;top:240px', 'width:1000px;height:800px;right:300px;top:420px', 'width:600px;height:600px;left:1100px;top:900px')}
      <svg class="abs" viewBox="0 0 4139 873" style="left:-120px;right:-120px;bottom:-40px;width:2800px;color:#ECEDE8;opacity:.05"><path fill="currentColor" d="${wm}"/></svg>
      <div class="abs" style="left:507px;top:508px;width:1546px;height:423px;display:flex;align-items:center;justify-content:space-between;gap:60px">
        <div>
          ${brand}
          <h1 style="margin-top:26px">${headline}</h1>
        </div>
        <div class="chips" style="--cg:16px">${chips}<span class="mono" style="margin-top:14px">${SITE} · ${HANDLE}</span></div>
      </div>
      <div class="grain"></div>
    </div>`,
  ],
  // Link previews (site og:image, X cards, LinkedIn, WhatsApp).
  'og-image.png': [
    1200,
    630,
    `
    <div class="stage" style="--gx:55%;--h:136px;--m:18px;--c:16px;--i:46px">
      <div class="grid"></div>
      ${glows('width:460px;height:420px;left:-120px;top:-140px', 'width:560px;height:520px;right:-200px;top:160px')}
      <div class="abs" style="left:64px;top:56px">${brand}</div>
      <div class="abs eyebrow" style="right:64px;top:72px">${SITE}</div>
      <div class="abs" style="left:64px;top:170px"><h1>${headline}</h1></div>
      <div class="abs" style="left:64px;bottom:56px;display:flex;gap:12px">${chips}</div>
      <div class="grain"></div>
    </div>`,
  ],
};

const tmp = mkdtempSync(join(tmpdir(), 'desiide-social-'));
const browser = await chromium.launch();
try {
  for (const [file, [w, h, body]] of Object.entries(ASSETS)) {
    const page = await browser.newPage({ viewport: { width: w, height: h } });
    // Load from a file:// page: a blank page may not read the local font files.
    const html = join(tmp, file.replace('.png', '.html'));
    writeFileSync(html, `<!doctype html><meta charset="utf-8"><style>${base}</style>${body}`);
    await page.goto(pathToFileURL(html).href);
    await page.evaluate(async () => {
      await Promise.all(
        ['800 10px B', '400 10px G', '400 10px M'].map((f) => document.fonts.load(f)),
      );
      await document.fonts.ready;
      const loaded = [...document.fonts].filter((f) => f.status === 'loaded').length;
      if (loaded < 3) throw new Error(`only ${loaded} fonts loaded`);
    });
    await page.screenshot({ path: join(here, file) });
    await page.close();
  }
} finally {
  await browser.close();
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`rendered ${Object.keys(ASSETS).length} social assets`);
