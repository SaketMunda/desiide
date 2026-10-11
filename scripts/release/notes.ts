// Release notes from Conventional Commits (REL-1).
//
//   node scripts/release/notes.ts <tag>
//
// Prints Markdown for the GitHub Release: install / first-launch steps for the kind of release, then
// the changes since the previous tag of the same kind. Extension notes only list commits that touch
// what the .vsix bundles.
import { execFileSync } from 'node:child_process';
import { parseReleaseTag, type ReleaseKind } from './tag.ts';

export interface Commit {
  readonly hash: string;
  readonly subject: string;
  readonly body: string;
}

const SECTIONS = [
  { types: ['feat'], title: 'Features' },
  { types: ['fix'], title: 'Fixes' },
  { types: ['perf'], title: 'Performance' },
  { types: ['revert'], title: 'Reverts' },
] as const;

const HEADER = /^(?<type>[a-z]+)(?:\((?<scope>[^)]+)\))?(?<bang>!)?: (?<description>.+)$/;

/** Paths whose changes ship in the `.vsix` (the extension bundles the orchestrator packages). */
export const EXTENSION_PATHS = ['extensions/desiide-ai', 'packages'] as const;

export function buildChangelog(commits: readonly Commit[]): string {
  const breaking: string[] = [];
  const bySection = new Map<string, string[]>();
  for (const commit of commits) {
    const header = HEADER.exec(commit.subject);
    if (!header?.groups) continue; // merge commits and non-conventional subjects
    const { type = '', scope, bang, description = '' } = header.groups;
    const line = `- ${scope ? `**${scope}:** ` : ''}${description} (${commit.hash.slice(0, 7)})`;
    if (bang || /^BREAKING[ -]CHANGE: /m.test(commit.body)) breaking.push(line);
    const section = SECTIONS.find((s) => (s.types as readonly string[]).includes(type));
    if (section) bySection.set(section.title, [...(bySection.get(section.title) ?? []), line]);
  }
  const parts: string[] = [];
  if (breaking.length > 0) parts.push(`### Breaking changes\n\n${breaking.join('\n')}`);
  for (const { title } of SECTIONS) {
    const lines = bySection.get(title);
    if (lines) parts.push(`### ${title}\n\n${lines.join('\n')}`);
  }
  return parts.length > 0 ? parts.join('\n\n') : '_No user-facing changes._';
}

const APP_INSTALL = `## Install

These Alpha builds are **unsigned**. Pick the file for your machine, then do the one first-launch step.

| Platform | File |
|---|---|
| macOS, Apple silicon | \`Desiide-{version}-darwin-arm64.dmg\` (or \`.zip\`) |
| macOS, Intel | \`Desiide-{version}-darwin-x64.dmg\` (or \`.zip\`) |
| Linux x64, Debian/Ubuntu | \`Desiide-{version}-linux-x64.deb\` |
| Linux x64, any distro | \`Desiide-{version}-linux-x86_64.AppImage\` or \`.tar.gz\` |

**macOS first launch:** drag Desiide to Applications, then run this once in Terminal (macOS blocks unsigned apps downloaded from the internet and reports them as "damaged"):

\`\`\`sh
xattr -dr com.apple.quarantine /Applications/Desiide.app
\`\`\`

**Linux:** \`sudo apt install ./Desiide-{version}-linux-x64.deb\`, or \`chmod +x\` the AppImage and run it (AppImages need FUSE 2, e.g. \`sudo apt install libfuse2\`).

Check a download against \`SHA256SUMS\`: \`shasum -a 256 -c SHA256SUMS --ignore-missing\`.`;

const EXT_INSTALL = `## Install

Search for **Desiide AI** in the Extensions view (VS Code Marketplace or Open VSX), or install the attached \`.vsix\`: \`code --install-extension desiide-ai-{version}.vsix\`.`;

export function buildReleaseNotes(
  kind: ReleaseKind,
  version: string,
  previousTag: string | undefined,
  commits: readonly Commit[],
): string {
  const install = (kind === 'app' ? APP_INSTALL : EXT_INSTALL).replaceAll('{version}', version);
  const since = previousTag ? `since ${previousTag}` : 'in this first release';
  return `${install}\n\n## Changes ${since}\n\n${buildChangelog(commits)}\n`;
}

function git(args: readonly string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function previousTagOf(tag: string, kind: ReleaseKind): string | undefined {
  try {
    return git(['describe', '--tags', '--abbrev=0', '--match', `${kind}-v*`, `${tag}^`]);
  } catch {
    return undefined; // the first tag of its kind
  }
}

const FIELD = '\x1f';
const RECORD = '\x1e';

function commitsBetween(from: string | undefined, to: string, paths: readonly string[]): Commit[] {
  const range = from ? `${from}..${to}` : to;
  const log = git([
    'log',
    '--no-merges',
    `--format=%H${FIELD}%s${FIELD}%b${RECORD}`,
    range,
    '--',
    ...paths,
  ]);
  return log
    .split(RECORD)
    .map((record) => record.trim())
    .filter((record) => record.length > 0)
    .map((record) => {
      const [hash = '', subject = '', body = ''] = record.split(FIELD);
      return { hash, subject, body };
    });
}

if (import.meta.main) {
  try {
    const tagArg = process.argv[2];
    if (!tagArg) throw new Error('usage: notes.ts <tag>');
    const { kind, tag, version } = parseReleaseTag(tagArg);
    const previous = previousTagOf(tag, kind);
    const commits = commitsBetween(previous, tag, kind === 'ext' ? EXTENSION_PATHS : []);
    process.stdout.write(buildReleaseNotes(kind, version, previous, commits));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
