// Upstream sync (REL-1): is VSCodium's latest release newer than the one the fork is based on?
//
//   node scripts/release/upstream.ts <latest VSCodium tag> <editor/patches/desiide/base-version>
//
// Prints `newer=true|false` and `current=<base version>` for $GITHUB_OUTPUT.
import { readFileSync } from 'node:fs';

// VSCodium versions: VS Code's major.minor, then the patch digit followed by a 4-digit build number
// (`1.135.06055` = VS Code 1.135.0, build 6055). The last field is fixed-width, so comparing the three
// fields as numbers orders patches before builds.
const VSCODIUM_VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

function parse(version: string): readonly [number, number, number] {
  const match = VSCODIUM_VERSION.exec(version.trim());
  if (!match) throw new Error(`"${version}" is not a VSCodium release version (e.g. 1.135.06055)`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Negative if a < b, 0 if equal, positive if a > b. */
export function compareVscodiumVersions(a: string, b: string): number {
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

if (import.meta.main) {
  try {
    const [latest, baseVersionFile] = process.argv.slice(2);
    if (!latest || !baseVersionFile)
      throw new Error('usage: upstream.ts <latest> <base-version file>');
    const current = readFileSync(baseVersionFile, 'utf8').trim();
    const newer = compareVscodiumVersions(latest, current) > 0;
    process.stdout.write(`newer=${String(newer)}\ncurrent=${current}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
