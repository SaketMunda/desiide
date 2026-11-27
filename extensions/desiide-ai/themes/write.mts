// Regenerates the theme JSON files from palette.ts: `pnpm -F desiide-ai themes`.
import { writeFileSync } from 'node:fs';
import { buildTheme, serialize, THEME_FILES } from './palette.ts';

for (const { palette, file } of THEME_FILES) {
  writeFileSync(new URL(file, import.meta.url), serialize(buildTheme(palette)));
  console.log(`wrote themes/${file}`);
}
