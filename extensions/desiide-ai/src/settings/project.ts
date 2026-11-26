import { ProjectConfig } from '@desiide/protocol';

/** `.desiide/project.json`, relative to the first workspace folder. */
export const PROJECT_CONFIG_PATH = ['.desiide', 'project.json'] as const;

export interface ProjectFileState {
  config: ProjectConfig;
  /** The parsed JSON object, unknown keys included, so a save keeps them. */
  raw: Record<string, unknown>;
  /** The file exists but isn't a valid project config. */
  invalid: boolean;
}

export function parseProjectFile(text: string | undefined): ProjectFileState {
  if (text === undefined) return { config: {}, raw: {}, invalid: false };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { config: {}, raw: {}, invalid: true };
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    return { config: {}, raw: {}, invalid: true };
  }
  const parsed = ProjectConfig.safeParse(json);
  return parsed.success
    ? { config: parsed.data, raw: json as Record<string, unknown>, invalid: false }
    : { config: {}, raw: json as Record<string, unknown>, invalid: true };
}

export interface ProjectEdit {
  testCommand: string;
  lintCommand: string;
  sensitiveGlobs: readonly string[];
}

/**
 * The new file text: edited fields replaced, empty ones removed, unknown keys (e.g. `ignoreGlobs`)
 * kept. Throws if the result wouldn't validate, so a bad edit never reaches disk.
 */
export function renderProjectFile(raw: Record<string, unknown>, edit: ProjectEdit): string {
  let next: Record<string, unknown> = { ...raw };
  const set = (key: string, value: unknown, empty: boolean) => {
    next = Object.fromEntries(Object.entries(next).filter(([k]) => k !== key));
    if (!empty) next[key] = value;
  };
  set('testCommand', edit.testCommand.trim(), edit.testCommand.trim() === '');
  set('lintCommand', edit.lintCommand.trim(), edit.lintCommand.trim() === '');
  const globs = [...new Set(edit.sensitiveGlobs.map((g) => g.trim()).filter(Boolean))];
  set('sensitiveGlobs', globs, globs.length === 0);
  ProjectConfig.parse(next);
  return `${JSON.stringify(next, null, 2)}\n`;
}

/** What the workspace root contains, as far as detection cares. */
export interface ProjectMarkers {
  /** `package.json` text, if present. */
  packageJson?: string;
  /** Which lockfile decides the package manager. */
  lockfile?: 'pnpm-lock.yaml' | 'yarn.lock' | 'bun.lockb' | 'bun.lock' | 'package-lock.json';
  cargoToml?: boolean;
  goMod?: boolean;
  pyproject?: string;
  makefile?: string;
}

export interface DetectedCommands {
  testCommand?: string;
  lintCommand?: string;
}

const RUNNERS: Record<NonNullable<ProjectMarkers['lockfile']>, string> = {
  'pnpm-lock.yaml': 'pnpm',
  'yarn.lock': 'yarn',
  'bun.lockb': 'bun run',
  'bun.lock': 'bun run',
  'package-lock.json': 'npm run',
};

/** Best-effort test/lint commands from common project files. The user can always edit them. */
export function detectCommands(m: ProjectMarkers): DetectedCommands {
  if (m.packageJson !== undefined) {
    let scripts: Record<string, unknown> = {};
    try {
      const pkg: unknown = JSON.parse(m.packageJson);
      if (typeof pkg === 'object' && pkg !== null && 'scripts' in pkg) {
        const s = (pkg as { scripts: unknown }).scripts;
        if (typeof s === 'object' && s !== null) scripts = s as Record<string, unknown>;
      }
    } catch {
      // Unparsable package.json: fall through to the other markers.
    }
    const runner = m.lockfile ? RUNNERS[m.lockfile] : 'npm run';
    const run = (name: string) =>
      name === 'test' && runner === 'npm run' ? 'npm test' : `${runner} ${name}`;
    const has = (name: string) => typeof scripts[name] === 'string';
    const test = ['test', 'test:unit'].find(has);
    const lint = ['lint', 'check'].find(has);
    if (test || lint) {
      return {
        ...(test ? { testCommand: run(test) } : {}),
        ...(lint ? { lintCommand: run(lint) } : {}),
      };
    }
  }
  if (m.cargoToml) return { testCommand: 'cargo test', lintCommand: 'cargo clippy' };
  if (m.goMod) return { testCommand: 'go test ./...', lintCommand: 'go vet ./...' };
  if (m.pyproject !== undefined) {
    return {
      testCommand: 'pytest',
      ...(/\[tool\.ruff/.test(m.pyproject) ? { lintCommand: 'ruff check .' } : {}),
    };
  }
  if (m.makefile !== undefined) {
    const target = (name: string) => new RegExp(`^${name}\\s*:`, 'm').test(m.makefile ?? '');
    return {
      ...(target('test') ? { testCommand: 'make test' } : {}),
      ...(target('lint') ? { lintCommand: 'make lint' } : {}),
    };
  }
  return {};
}
