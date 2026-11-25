// Renders every brand SVG to a PNG beside it, at its own width/height (app icons at 1024).
//   node brand/render.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const here = fileURLToPath(new URL('.', import.meta.url));
const require = createRequire(join(here, '../extensions/desiide-ai/package.json'));
const { chromium } = require('playwright-core');
const files = [''].flatMap((d) =>
  readdirSync(join(here, d))
    .filter((f) => f.endsWith('.svg'))
    .map((f) => d + f),
);
const browser = await chromium.launch();
try {
  for (const f of files) {
    const svg = readFileSync(join(here, f), 'utf8');
    let [, w, h] = svg.match(/width="([\d.]+)" height="([\d.]+)"/).map(Number);
    if (f.startsWith('wordmark') || f.startsWith('mark')) {
      const s = 2000 / Math.max(w, h);
      w = Math.round(w * s);
      h = Math.round(h * s);
    }
    const page = await browser.newPage({ viewport: { width: w, height: h } });
    const src = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
    await page.setContent(
      `<style>html,body{margin:0;background:transparent}</style><img src="${src}" width="${w}" height="${h}">`,
    );
    await page.locator('img').evaluate((img) => img.decode());
    await page.screenshot({ path: join(here, f.replace(/\.svg$/, '.png')), omitBackground: true });
    await page.close();
  }
} finally {
  await browser.close();
}
console.log(`rendered ${files.length} files`);
