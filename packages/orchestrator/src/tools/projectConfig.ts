import { ProjectConfig } from '@desiide/protocol';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as z from 'zod';
import { PathError, resolveWorkspacePath, type Workspace } from './paths.ts';

export const PROJECT_CONFIG_PATH = '.desiide/project.json';

export type CommandSource = 'project.json' | 'detected';

export interface LoadedProjectConfig {
  config: ProjectConfig;
  /** Where each command came from, so the UI can say "detected: pnpm test". */
  sources: { testCommand?: CommandSource; lintCommand?: CommandSource };
  /** Non-fatal problems (e.g. invalid project.json), shown to the user; detection still runs. */
  warnings: string[];
}

interface DetectedCommands {
  testCommand?: string;
  lintCommand?: string;
}

/** npm writes this into every fresh package.json; it isn't a real test command. */
const NPM_PLACEHOLDER_TEST = /no test specified/;

const PackageJson = z.object({
  scripts: z.record(z.string(), z.string()).optional(),
});

async function exists(root: string, rel: string): Promise<boolean> {
  try {
    await access(join(root, rel));
    return true;
  } catch {
    return false;
  }
}

async function readText(root: string, rel: string): Promise<string | null> {
  try {
    return await readFile(join(root, rel), 'utf8');
  } catch {
    return null;
  }
}

async function nodePackageManager(root: string): Promise<string> {
  if (await exists(root, 'pnpm-lock.yaml')) return 'pnpm';
  if (await exists(root, 'yarn.lock')) return 'yarn';
  if ((await exists(root, 'bun.lockb')) || (await exists(root, 'bun.lock'))) return 'bun';
  return 'npm';
}

async function detectNode(root: string): Promise<DetectedCommands | null> {
  const raw = await readText(root, 'package.json');
  if (raw === null) return null;
  let scripts: Record<string, string>;
  try {
    scripts = PackageJson.parse(JSON.parse(raw)).scripts ?? {};
  } catch {
    return null;
  }
  const pm = await nodePackageManager(root);
  const out: DetectedCommands = {};
  if (scripts.test && !NPM_PLACEHOLDER_TEST.test(scripts.test)) out.testCommand = `${pm} test`;
  if (scripts.lint) out.lintCommand = `${pm} run lint`;
  return out;
}

async function detectPython(root: string): Promise<DetectedCommands | null> {
  const pyproject = await readText(root, 'pyproject.toml');
  const markers = ['pytest.ini', 'setup.cfg', 'tox.ini', 'conftest.py', 'setup.py'];
  const hasMarker = (await Promise.all(markers.map((m) => exists(root, m)))).some(Boolean);
  if (pyproject === null && !hasMarker) return null;
  const out: DetectedCommands = { testCommand: 'pytest' };
  const ruff =
    /^\[tool\.ruff/m.test(pyproject ?? '') ||
    (await exists(root, 'ruff.toml')) ||
    (await exists(root, '.ruff.toml'));
  if (ruff) out.lintCommand = 'ruff check .';
  return out;
}

async function detectGo(root: string): Promise<DetectedCommands | null> {
  if (!(await exists(root, 'go.mod'))) return null;
  return { testCommand: 'go test ./...', lintCommand: 'go vet ./...' };
}

async function detectRust(root: string): Promise<DetectedCommands | null> {
  if (!(await exists(root, 'Cargo.toml'))) return null;
  return { testCommand: 'cargo test', lintCommand: 'cargo clippy --all-targets' };
}

/** First ecosystem that yields a test command wins; lint falls back across ecosystems the same way. */
export async function detectCommands(root: string): Promise<DetectedCommands> {
  const found = (
    await Promise.all([detectNode(root), detectPython(root), detectGo(root), detectRust(root)])
  ).filter((d): d is DetectedCommands => d !== null);
  const out: DetectedCommands = {};
  const test = found.find((d) => d.testCommand)?.testCommand;
  const lint = found.find((d) => d.lintCommand)?.lintCommand;
  if (test) out.testCommand = test;
  if (lint) out.lintCommand = lint;
  return out;
}

async function readProjectJson(
  ws: Workspace,
  warnings: string[],
): Promise<ProjectConfig | undefined> {
  let abs: string;
  try {
    const resolved = await resolveWorkspacePath(ws, PROJECT_CONFIG_PATH, { mustExist: true });
    abs = resolved.abs;
  } catch (err) {
    if (err instanceof PathError && err.reason === 'not_found') return undefined;
    warnings.push(`${PROJECT_CONFIG_PATH} ignored: ${(err as Error).message}`);
    return undefined;
  }
  let json: unknown;
  try {
    json = JSON.parse(await readFile(abs, 'utf8'));
  } catch (err) {
    warnings.push(`${PROJECT_CONFIG_PATH} is not valid JSON: ${(err as Error).message}`);
    return undefined;
  }
  const parsed = ProjectConfig.safeParse(json);
  if (!parsed.success) {
    warnings.push(`${PROJECT_CONFIG_PATH} ignored: ${z.prettifyError(parsed.error)}`);
    return undefined;
  }
  return parsed.data;
}

/**
 * `.desiide/project.json` from the first workspace root, with each missing command filled in by
 * auto-detection. An invalid file is reported as a warning and treated as absent.
 */
export async function loadProjectConfig(ws: Workspace): Promise<LoadedProjectConfig> {
  const warnings: string[] = [];
  const fromFile = (await readProjectJson(ws, warnings)) ?? {};
  const config: ProjectConfig = { ...fromFile };
  const sources: LoadedProjectConfig['sources'] = {};
  if (config.testCommand) sources.testCommand = 'project.json';
  if (config.lintCommand) sources.lintCommand = 'project.json';
  if (!config.testCommand || !config.lintCommand) {
    const root = ws.roots[0];
    const detected = root ? await detectCommands(root) : {};
    if (!config.testCommand && detected.testCommand) {
      config.testCommand = detected.testCommand;
      sources.testCommand = 'detected';
    }
    if (!config.lintCommand && detected.lintCommand) {
      config.lintCommand = detected.lintCommand;
      sources.lintCommand = 'detected';
    }
  }
  return { config, sources, warnings };
}
