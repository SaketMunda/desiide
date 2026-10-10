import { createSensitivity, globToRegExp } from '@desiide/jev';

/**
 * Areas where a change is high-risk even though the files hold no secrets: auth, money, schema
 * migrations, and infrastructure. They're marked `FileMeta.sensitive` for Jev and the review UI,
 * but their contents are ordinary code and may go into the model's context.
 */
export const DEFAULT_HIGH_RISK_GLOBS: readonly string[] = [
  '**/auth/**',
  '**/billing/**',
  '**/payment*/**',
  '**/*.env*',
  '**/migrations/**',
  '**/secrets/**',
  '*.tf',
  '*.tfvars',
  '*.hcl',
  'Dockerfile',
  'Dockerfile.*',
  '*.dockerfile',
  'docker-compose*.yml',
  'docker-compose*.yaml',
  'Jenkinsfile',
  '.gitlab-ci.yml',
  '.github/workflows/**',
];

export interface Sensitivity {
  /**
   * Secrets: exactly the files JEV-2's gate asks before reading (its defaults plus the project's
   * `sensitiveGlobs`). The context engine never inlines them, or it would bypass that question.
   */
  secret(path: string): boolean;
  /** `FileMeta.sensitive`: secrets plus the high-risk areas. */
  sensitive(path: string): boolean;
}

export function createContextSensitivity(projectGlobs: readonly string[] = []): Sensitivity {
  const secret = createSensitivity(projectGlobs);
  const highRisk = DEFAULT_HIGH_RISK_GLOBS.map(globToRegExp);
  return {
    secret,
    sensitive: (path) => secret(path) || highRisk.some((re) => re.test(path)),
  };
}

const LOCKFILES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb',
  'cargo.lock',
  'gemfile.lock',
  'poetry.lock',
  'pipfile.lock',
  'uv.lock',
  'pdm.lock',
  'composer.lock',
  'go.sum',
  'mix.lock',
  'pubspec.lock',
  'packages.lock.json',
  'flake.lock',
  'podfile.lock',
  'package.resolved',
]);

const BINARY_EXTENSIONS = new Set(
  (
    'png jpg jpeg gif webp avif ico icns bmp tif tiff psd ai sketch fig pdf ' +
    'zip gz tgz bz2 xz zst 7z rar tar jar war ear apk ipa dmg iso ' +
    'class so dylib dll exe bin o a lib obj pdb wasm node pyc pyo ' +
    'woff woff2 ttf otf eot mp3 mp4 m4a mov avi mkv wav flac ogg webm ' +
    'sqlite sqlite3 db parquet npy npz pkl pt onnx'
  ).split(' '),
);

/** Why a file's contents never go into the context. */
export type ExclusionReason = 'lockfile' | 'binary' | 'generated' | 'gitignored' | 'secret';

/** Exclusions that follow from the path alone (no listing or read needed). */
export function excludedByName(path: string): ExclusionReason | undefined {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  if (LOCKFILES.has(name) || name.endsWith('.lock')) return 'lockfile';
  const dot = name.lastIndexOf('.');
  if (dot > 0 && BINARY_EXTENSIONS.has(name.slice(dot + 1))) return 'binary';
  if (/\.min\.(js|css)$/.test(name) || name.endsWith('.map')) return 'generated';
  return undefined;
}

export const EXCLUSION_TEXT: Readonly<Record<ExclusionReason, string>> = {
  lockfile: 'lockfile, not shown',
  binary: 'binary file, not shown',
  generated: 'generated file, not shown',
  gitignored: 'ignored (.gitignore or ignoreGlobs), not shown',
  secret: 'may contain secrets, not shown; read_file asks the user first',
};
