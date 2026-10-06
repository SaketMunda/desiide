import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findEditorRipgrep } from './ripgrep.ts';

const root = '/app';
const only =
  (...paths: string[]) =>
  (p: string) =>
    paths.includes(p);

describe('findEditorRipgrep', () => {
  it("finds Desiide's per-platform binary, unpacked from the asar", () => {
    const rg = join(
      root,
      'node_modules.asar.unpacked/@vscode/ripgrep-universal/bin/darwin-arm64/rg',
    );
    expect(findEditorRipgrep(root, { platform: 'darwin', arch: 'arm64', exists: only(rg) })).toBe(
      rg,
    );
  });

  it("falls back to stock VS Code's @vscode/ripgrep", () => {
    const rg = join(root, 'node_modules/@vscode/ripgrep/bin/rg');
    expect(findEditorRipgrep(root, { platform: 'linux', arch: 'x64', exists: only(rg) })).toBe(rg);
  });

  it('uses rg.exe on Windows', () => {
    const rg = join(root, 'node_modules.asar.unpacked/@vscode/ripgrep/bin/rg.exe');
    expect(findEditorRipgrep(root, { platform: 'win32', arch: 'x64', exists: only(rg) })).toBe(rg);
  });

  it('ignores binaries for another platform and returns undefined when none exist', () => {
    const other = join(
      root,
      'node_modules.asar.unpacked/@vscode/ripgrep-universal/bin/linux-x64/rg',
    );
    expect(
      findEditorRipgrep(root, { platform: 'darwin', arch: 'arm64', exists: only(other) }),
    ).toBe(undefined);
  });
});
