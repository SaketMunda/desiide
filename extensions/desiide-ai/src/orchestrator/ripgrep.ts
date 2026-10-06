import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface RipgrepProbe {
  platform?: NodeJS.Platform;
  arch?: string;
  exists?: (path: string) => boolean;
}

/**
 * The ripgrep binary the editor itself ships, for the orchestrator's `list_files` / `search`
 * (its bundle can't carry `@vscode/ripgrep`). Desiide ships `@vscode/ripgrep-universal` with one
 * binary per platform; stock VS Code ships `@vscode/ripgrep`. Both may sit inside or outside the
 * asar archive.
 */
export function findEditorRipgrep(appRoot: string, probe: RipgrepProbe = {}): string | undefined {
  const platform = probe.platform ?? process.platform;
  const arch = probe.arch ?? process.arch;
  const exists = probe.exists ?? existsSync;
  const exe = platform === 'win32' ? 'rg.exe' : 'rg';
  const candidates = ['node_modules.asar.unpacked', 'node_modules'].flatMap((dir) => [
    join(appRoot, dir, '@vscode', 'ripgrep-universal', 'bin', `${platform}-${arch}`, exe),
    join(appRoot, dir, '@vscode', 'ripgrep', 'bin', exe),
  ]);
  return candidates.find((p) => exists(p));
}
