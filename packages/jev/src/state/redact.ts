import { createHmac } from 'node:crypto';

/**
 * Folder names common enough to say nothing about the project, yet useful to Jev as
 * coarse signals (`auth`, `billing`, `migrations` matter for risk). Matched case-insensitively.
 */
export const DEFAULT_PATH_ALLOWLIST: readonly string[] = [
  '.github',
  '__tests__',
  'api',
  'app',
  'apps',
  'assets',
  'auth',
  'billing',
  'bin',
  'build',
  'client',
  'cmd',
  'common',
  'components',
  'config',
  'core',
  'db',
  'deploy',
  'docs',
  'e2e',
  'fixtures',
  'infra',
  'internal',
  'lib',
  'migrations',
  'models',
  'packages',
  'payments',
  'pkg',
  'public',
  'scripts',
  'server',
  'services',
  'shared',
  'spec',
  'src',
  'styles',
  'test',
  'tests',
  'types',
  'utils',
  'web',
  'workflows',
];

const MIN_SALT_LENGTH = 16;
const HASH_HEX_CHARS = 10;
const EXTENSION = /^(.+?)(\.[A-Za-z0-9]{1,8})$/;
/** Path-like tokens inside a command: at least one `/` between name characters. */
const PATH_IN_COMMAND = /[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]+)+/g;

export interface PathRedactor {
  /** Hashes every segment of a workspace path that isn't on the allow-list. */
  path(path: string): string;
  /** Applies `path` to every path-like token in a shell command. */
  command(command: string): string;
}

export interface PathRedactorOptions {
  /**
   * Per-workspace secret, so hashes are stable within a workspace but not guessable by
   * hashing common names. The caller owns generating and persisting it.
   */
  salt: string;
  allowList?: readonly string[];
}

/**
 * `desiide.jev.redactPaths`: deterministic for a given salt (the same segment always hashes the
 * same way), so Jev still sees that two files share a folder. File extensions are kept.
 */
export function createPathRedactor(options: PathRedactorOptions): PathRedactor {
  if (options.salt.length < MIN_SALT_LENGTH) {
    throw new Error(`Redaction salt must be at least ${MIN_SALT_LENGTH} characters`);
  }
  const allow = new Set((options.allowList ?? DEFAULT_PATH_ALLOWLIST).map((s) => s.toLowerCase()));
  const cache = new Map<string, string>();

  const hash = (segment: string): string => {
    let hashed = cache.get(segment);
    if (hashed === undefined) {
      const digest = createHmac('sha256', options.salt).update(segment).digest('hex');
      hashed = `h_${digest.slice(0, HASH_HEX_CHARS)}`;
      cache.set(segment, hashed);
    }
    return hashed;
  };

  const segment = (s: string, isLast: boolean): string => {
    if (s === '' || s === '.' || allow.has(s.toLowerCase())) return s;
    const ext = isLast ? EXTENSION.exec(s) : null;
    return ext ? `${hash(ext[1] ?? s)}${ext[2] ?? ''}` : hash(s);
  };

  const path = (p: string): string => {
    const parts = p.split('/');
    return parts.map((s, i) => segment(s, i === parts.length - 1)).join('/');
  };

  return {
    path,
    command: (command) => command.replace(PATH_IN_COMMAND, (match) => path(match)),
  };
}
