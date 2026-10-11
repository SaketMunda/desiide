import { describe, expect, it } from 'vitest';
import { buildChangelog, buildReleaseNotes, type Commit } from './notes.ts';
import { checkExtensionVersion, parseReleaseTag } from './tag.ts';
import { compareVscodiumVersions } from './upstream.ts';

describe('parseReleaseTag', () => {
  it('parses app tags, with pre-release for -alpha/-beta', () => {
    expect(parseReleaseTag('app-v0.1.0-alpha.1')).toEqual({
      kind: 'app',
      tag: 'app-v0.1.0-alpha.1',
      version: '0.1.0-alpha.1',
      core: '0.1.0',
      prerelease: true,
    });
    expect(parseReleaseTag('app-v0.2.0-beta').prerelease).toBe(true);
    expect(parseReleaseTag('app-v1.0.0').prerelease).toBe(false);
  });

  it('parses extension tags', () => {
    expect(parseReleaseTag('ext-v0.2.0-beta.3')).toMatchObject({ kind: 'ext', core: '0.2.0' });
  });

  it.each([
    'v0.1.0',
    'app-0.1.0',
    'app-v0.1',
    'app-v01.0.0',
    'app-v0.1.0-',
    'app-v0.1.0+build',
    'app-v0.1.0 ',
    'web-v0.1.0',
    'app-v0.1.0-alpha..1',
  ])('rejects %j', (tag) => {
    expect(() => parseReleaseTag(tag)).toThrow();
  });
});

describe('checkExtensionVersion', () => {
  it('accepts a tag whose core version is package.json version', () => {
    expect(() => checkExtensionVersion(parseReleaseTag('ext-v0.2.0-beta'), '0.2.0')).not.toThrow();
    expect(() => checkExtensionVersion(parseReleaseTag('ext-v0.2.0'), '0.2.0')).not.toThrow();
  });

  it('rejects a mismatch with an actionable message', () => {
    expect(() => checkExtensionVersion(parseReleaseTag('ext-v0.3.0'), '0.2.0')).toThrow(
      /bump package.json to 0.3.0, or tag ext-v0.2.0/,
    );
  });

  it('rejects app tags', () => {
    expect(() => checkExtensionVersion(parseReleaseTag('app-v0.2.0'), '0.2.0')).toThrow();
  });
});

const commit = (subject: string, body = '', hash = 'abcdef1234567890'): Commit => ({
  hash,
  subject,
  body,
});

describe('buildChangelog', () => {
  it('groups Conventional Commits and drops the rest', () => {
    const changelog = buildChangelog([
      commit('feat(UI-3): task stream webview', '', '1111111aaaa'),
      commit('fix: crash on empty prompt', '', '2222222bbbb'),
      commit('docs(UI-3): handoff notes'),
      commit('chore: bump deps'),
      commit('Merge pull request #24 from x/y'),
      commit('perf(COR-4): cache file index', '', '3333333cccc'),
    ]);
    expect(changelog).toBe(
      [
        '### Features\n\n- **UI-3:** task stream webview (1111111)',
        '### Fixes\n\n- crash on empty prompt (2222222)',
        '### Performance\n\n- **COR-4:** cache file index (3333333)',
      ].join('\n\n'),
    );
  });

  it('lists breaking changes first, from `!` or a BREAKING CHANGE footer', () => {
    const changelog = buildChangelog([
      commit('feat(protocol)!: drop v0 events', '', 'aaaaaaa0'),
      commit('refactor: new config file', 'Details.\n\nBREAKING CHANGE: config moved', 'bbbbbbb0'),
    ]);
    expect(changelog.startsWith('### Breaking changes\n\n- **protocol:** drop v0 events')).toBe(
      true,
    );
    expect(changelog).toContain('- new config file (bbbbbbb)');
    expect(changelog).toContain('### Features');
  });

  it('says so when nothing is user-facing', () => {
    expect(buildChangelog([commit('docs: typo')])).toBe('_No user-facing changes._');
  });
});

describe('buildReleaseNotes', () => {
  it('app notes carry the files and the macOS first-launch step', () => {
    const notes = buildReleaseNotes('app', '0.1.0-alpha.1', 'app-v0.0.9', [commit('feat: x')]);
    expect(notes).toContain('Desiide-0.1.0-alpha.1-darwin-arm64.dmg');
    expect(notes).toContain('Desiide-0.1.0-alpha.1-linux-x86_64.AppImage');
    expect(notes).toContain('xattr -dr com.apple.quarantine /Applications/Desiide.app');
    expect(notes).toContain('## Changes since app-v0.0.9');
    expect(notes).not.toContain('{version}');
  });

  it('extension notes point to the registries and the .vsix', () => {
    const notes = buildReleaseNotes('ext', '0.2.0', undefined, []);
    expect(notes).toContain('desiide-ai-0.2.0.vsix');
    expect(notes).toContain('## Changes in this first release');
  });
});

describe('compareVscodiumVersions', () => {
  it('orders by minor, then patch digit, then build', () => {
    expect(compareVscodiumVersions('1.136.00123', '1.135.06055')).toBeGreaterThan(0);
    expect(compareVscodiumVersions('1.135.16100', '1.135.06055')).toBeGreaterThan(0);
    expect(compareVscodiumVersions('1.135.06056', '1.135.06055')).toBeGreaterThan(0);
    expect(compareVscodiumVersions('1.135.06055', '1.135.06055')).toBe(0);
    expect(compareVscodiumVersions('1.126.04524', '1.135.06055')).toBeLessThan(0);
    expect(compareVscodiumVersions('2.0.00001', '1.999.99999')).toBeGreaterThan(0);
  });

  it('tolerates the trailing newline of base-version', () => {
    expect(compareVscodiumVersions('1.135.06055\n', '1.135.06055')).toBe(0);
  });

  it.each(['1.135.06055-insider', 'v1.135.06055', '1.135', ''])('rejects %j', (bad) => {
    expect(() => compareVscodiumVersions(bad, '1.135.06055')).toThrow();
  });
});
