// Release tags (REL-1). The tag is the version source of truth for the app; the extension's is its
// package.json, and its tag must match it.
//
//   node scripts/release/tag.ts <tag> [--package <package.json>]
//
// Prints `key=value` lines for $GITHUB_OUTPUT: kind, version, prerelease. Exits 1 on a bad tag.
import { readFileSync } from 'node:fs';

export type ReleaseKind = 'app' | 'ext';

export interface ReleaseTag {
  readonly kind: ReleaseKind;
  readonly tag: string;
  /** The tag's SemVer without the `app-v`/`ext-v` prefix, e.g. `0.1.0-alpha.1`. */
  readonly version: string;
  /** `major.minor.patch` only. */
  readonly core: string;
  readonly prerelease: boolean;
}

const SEMVER =
  /^(?<core>(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(?:-(?<pre>[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function parseReleaseTag(tag: string): ReleaseTag {
  const prefix = /^(app|ext)-v/.exec(tag);
  if (!prefix) {
    throw new Error(`"${tag}" is not a release tag: use app-v<semver> or ext-v<semver>`);
  }
  const kind = prefix[1] as ReleaseKind;
  const version = tag.slice(prefix[0].length);
  const match = SEMVER.exec(version);
  if (!match?.groups?.['core']) {
    throw new Error(`"${tag}": "${version}" is not SemVer (e.g. ${kind}-v0.1.0-alpha.1)`);
  }
  return {
    kind,
    tag,
    version,
    core: match.groups['core'],
    prerelease: match.groups['pre'] !== undefined,
  };
}

/**
 * The VS Code Marketplace has no SemVer pre-release versions: a pre-release is a normal version
 * published with `--pre-release`. So `ext-v0.2.0-beta` publishes package.json version `0.2.0`.
 */
export function checkExtensionVersion(tag: ReleaseTag, packageVersion: string): void {
  if (tag.kind !== 'ext') {
    throw new Error(`${tag.tag} is not an extension tag`);
  }
  if (tag.core !== packageVersion) {
    throw new Error(
      `${tag.tag} doesn't match extensions/desiide-ai/package.json version ${packageVersion}: ` +
        `bump package.json to ${tag.core}, or tag ext-v${packageVersion}`,
    );
  }
}

function main(argv: readonly string[]): void {
  const [tag, flag, packagePath] = argv;
  if (!tag) {
    throw new Error('usage: tag.ts <tag> [--package <package.json>]');
  }
  const parsed = parseReleaseTag(tag);
  if (flag === '--package' && packagePath) {
    const pkg: unknown = JSON.parse(readFileSync(packagePath, 'utf8'));
    const version =
      typeof pkg === 'object' && pkg !== null && 'version' in pkg ? pkg.version : undefined;
    if (typeof version !== 'string') {
      throw new Error(`${packagePath} has no version`);
    }
    checkExtensionVersion(parsed, version);
  }
  process.stdout.write(
    `kind=${parsed.kind}\nversion=${parsed.version}\nprerelease=${String(parsed.prerelease)}\n`,
  );
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
