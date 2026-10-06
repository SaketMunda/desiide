/**
 * Which paths are sensitive (secrets, keys, credentials) and which point outside the workspace.
 * COR-4 reuses `createSensitivity` to fill `FileMeta.sensitive`.
 */

/**
 * Secrets that live in repos or home directories by convention. Matched like .gitignore: a
 * pattern without `/` matches the file name at any depth. Projects add their own via
 * `.desiide/project.json` `sensitiveGlobs`.
 */
export const DEFAULT_SENSITIVE_GLOBS: readonly string[] = [
  '.env',
  '.env.*',
  '*.env',
  '.envrc',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  '*.jks',
  '*.keystore',
  '*.kdbx',
  'id_rsa*',
  'id_dsa*',
  'id_ecdsa*',
  'id_ed25519*',
  '.npmrc',
  '.pypirc',
  '.netrc',
  '.git-credentials',
  '.htpasswd',
  '*.tfstate',
  '*.tfstate.*',
  '*.tfvars',
  'kubeconfig',
  'credentials',
  'credentials.*',
  '*secret*',
  '*credential*',
  'service-account*.json',
  '**/.ssh/**',
  '**/.aws/**',
  '**/.gnupg/**',
  '**/.kube/**',
  '**/.docker/config.json',
  '**/secrets/**',
];

/** Templates of secret files are meant to be shared. */
const NOT_SENSITIVE = /\.(example|sample|template|dist|defaults?)$/i;

function escapeRegex(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

/** Glob → RegExp for `*`, `**`, `?`, `{a,b}`, matched against a POSIX relative path. */
export function globToRegExp(glob: string): RegExp {
  const anchored = glob.includes('/') && !glob.startsWith('**/');
  let body = glob.replace(/^\.\//, '').replace(/^\//, '');
  if (!anchored && !body.startsWith('**/')) body = `**/${body}`;
  let re = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i] ?? '';
    if (c === '*') {
      if (body[i + 1] === '*') {
        const slash = body[i + 2] === '/';
        re += slash ? '(?:.*/)?' : '.*';
        i += slash ? 2 : 1;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const end = body.indexOf('}', i);
      if (end < 0) re += '\\{';
      else {
        re += `(?:${body
          .slice(i + 1, end)
          .split(',')
          .map(escapeRegex)
          .join('|')})`;
        i = end;
      }
    } else re += escapeRegex(c);
  }
  // A directory pattern also covers everything below it.
  return new RegExp(`^${re}(?:/.*)?$`, 'i');
}

export type Sensitivity = (path: string) => boolean;

export function createSensitivity(extraGlobs: readonly string[] = []): Sensitivity {
  const patterns = [...DEFAULT_SENSITIVE_GLOBS, ...extraGlobs].map(globToRegExp);
  return (path) => {
    const p = normalizeRelative(path);
    if (p === undefined) return false;
    const name = p.slice(p.lastIndexOf('/') + 1);
    if (NOT_SENSITIVE.test(name)) return false;
    return patterns.some((re) => re.test(p));
  };
}

function normalizeRelative(path: string): string | undefined {
  const p = path
    .replace(/\\/g, '/')
    .replace(/^(\.\/)+/, '')
    .replace(/\/+$/, '');
  return p === '' || p === '.' ? undefined : p;
}

/** Where a path-like argument points. Home and absolute paths are outside the workspace. */
export type PathScope = 'workspace' | 'outside' | 'system';

const SYSTEM_ROOTS = [
  '/etc',
  '/usr',
  '/bin',
  '/sbin',
  '/lib',
  '/lib64',
  '/boot',
  '/dev',
  '/proc',
  '/sys',
  '/var',
  '/opt',
  '/root',
  '/home',
  '/Users',
  '/System',
  '/Library',
  '/Applications',
  '/private/etc',
  '/private/var',
];
/** Shell start-up files and credential stores: writing one is code execution or a key leak. */
const HOME_SYSTEM =
  /^~\/(\.ssh|\.gnupg|\.aws|\.kube|\.docker|\.config|\.(bash|zsh|ksh)\w*|\.profile|\.gitconfig|\.npmrc|\.netrc|Library\/LaunchAgents)(\/|$)/;
const TEMP_ROOTS = ['/tmp', '/private/tmp', '/var/tmp', '/var/folders', '/private/var/folders'];
const HARMLESS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty', '-']);

/** Expands the home spellings a shell would (`$HOME`, `${HOME}`) to `~` for matching. */
export function normalizeShellPath(word: string): string {
  return word.replace(/^(\$HOME|\$\{HOME\})(?=\/|$)/, '~');
}

export function pathScope(word: string): PathScope {
  const p = normalizeShellPath(word);
  if (HARMLESS.has(p)) return 'workspace';
  if (p === '/' || p === '/*' || p === '~' || p === '~/' || p === '~/*') return 'system';
  if (p.startsWith('~'))
    return HOME_SYSTEM.test(p) || /^~\/[^/]*\/?\*?$/.test(p) ? 'system' : 'outside';
  if (p.startsWith('/')) {
    const trimmed = p.replace(/\/+\*?$/, '');
    if (TEMP_ROOTS.some((r) => trimmed.startsWith(`${r}/`))) return 'outside';
    if (SYSTEM_ROOTS.some((r) => trimmed === r || trimmed.startsWith(`${r}/`))) {
      // Inside a user's home: only the home itself or its dotfiles are "system"; projects aren't.
      const home = /^\/(Users|home)\/[^/]+(\/.*)?$/.exec(trimmed);
      if (home) {
        const rest = home[2] ?? '';
        return rest === '' || HOME_SYSTEM.test(`~${rest}`) ? 'system' : 'outside';
      }
      return 'system';
    }
    // `/foo` one level below root is as bad as `/`.
    return trimmed.split('/').length <= 2 ? 'system' : 'outside';
  }
  if (p === '..' || p.startsWith('../') || p.includes('/../') || p.endsWith('/..'))
    return 'outside';
  return 'workspace';
}

/** Words that look like paths (so `-n` or `HEAD~1` aren't treated as files). */
export function looksLikePath(word: string): boolean {
  if (word === '' || word.startsWith('-')) return false;
  const p = normalizeShellPath(word);
  return (
    p.startsWith('/') ||
    p.startsWith('~') ||
    p.startsWith('./') ||
    p.startsWith('../') ||
    p === '..' ||
    p.includes('/') ||
    /\.[A-Za-z0-9]{1,10}$/.test(p) ||
    /^\.[A-Za-z]/.test(p)
  );
}
