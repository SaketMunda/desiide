import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { ExtensionToWebview } from '../../shared/messages.ts';
import { SettingsToHost, type SettingsSection } from '../../shared/settings.ts';
import { createMessageRouter } from '../bridge/router.ts';
import type { Logger } from '../log.ts';
import { buildWebviewHtml } from '../views/html.ts';
import type { RawDesiideSettings } from './config.ts';
import { PROJECT_CONFIG_PATH, type ProjectMarkers } from './project.ts';
import { ensureRedactSalt } from './salt.ts';
import { SettingsService, type SettingKey, type SettingsDeps } from './service.ts';

export const SETTINGS_PANEL_TYPE = 'desiide.settings';
/** Set while at least one model is configured; walkthrough steps complete on it. */
export const HAS_MODELS_CONTEXT = 'desiide.hasModels';

const SETTINGS_SECTION = 'desiide';

/** Reads the raw `desiide.*` values the settings page manages. */
export function readRawSettings(): RawDesiideSettings {
  const c = vscode.workspace.getConfiguration(SETTINGS_SECTION);
  return {
    models: c.get('models'),
    roles: c.get('roles'),
    jev: {
      enabled: c.get('jev.enabled'),
      endpoint: c.get('jev.endpoint'),
      apiKey: c.get('jev.apiKey'),
      redactPaths: c.get('jev.redactPaths'),
    },
    gating: { mode: c.get('gating.mode'), thresholds: c.get('gating.thresholds') },
  };
}

/** Writes where the value already lives (workspace wins over user), else to user settings. */
async function writeSetting(key: SettingKey, value: unknown): Promise<void> {
  const c = vscode.workspace.getConfiguration(SETTINGS_SECTION);
  const inspected = c.inspect(key);
  const target =
    inspected?.workspaceFolderValue !== undefined
      ? vscode.ConfigurationTarget.WorkspaceFolder
      : inspected?.workspaceValue !== undefined
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
  await c.update(key, value, target);
}

const firstFolder = (): vscode.Uri | undefined =>
  vscode.workspace.workspaceFolders?.find((f) => f.uri.scheme === 'file')?.uri;

async function readText(uri: vscode.Uri): Promise<string | undefined> {
  try {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  } catch {
    return undefined;
  }
}

async function projectMarkers(root: vscode.Uri): Promise<ProjectMarkers> {
  const file = (name: string) => readText(vscode.Uri.joinPath(root, name));
  const exists = async (name: string) => (await file(name)) !== undefined;
  const lockfiles = [
    'pnpm-lock.yaml',
    'yarn.lock',
    'bun.lock',
    'bun.lockb',
    'package-lock.json',
  ] as const;
  let lockfile: ProjectMarkers['lockfile'];
  for (const l of lockfiles) {
    try {
      await vscode.workspace.fs.stat(vscode.Uri.joinPath(root, l));
      lockfile = l;
      break;
    } catch {
      // not this one
    }
  }
  const [packageJson, cargoToml, goMod, pyproject, makefile] = await Promise.all([
    file('package.json'),
    exists('Cargo.toml'),
    exists('go.mod'),
    file('pyproject.toml'),
    file('Makefile'),
  ]);
  return {
    ...(packageJson !== undefined ? { packageJson } : {}),
    ...(lockfile ? { lockfile } : {}),
    cargoToml,
    goMod,
    ...(pyproject !== undefined ? { pyproject } : {}),
    ...(makefile !== undefined ? { makefile } : {}),
  };
}

export interface SettingsControllerOptions {
  extensionUri: vscode.Uri;
  context: vscode.ExtensionContext;
  orchestrator: SettingsDeps['orchestrator'];
  log: Logger;
  tryIt(): Promise<void>;
}

/**
 * The Settings editor tab (UI-6) and the glue between `SettingsService` and VS Code: settings,
 * SecretStorage, workspaceState (redaction salt), `.desiide/project.json`, and the panel.
 */
export class SettingsController implements vscode.Disposable {
  readonly service: SettingsService;
  private panel: vscode.WebviewPanel | undefined;
  private ready = false;
  private pendingSection: SettingsSection | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private pushTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly opts: SettingsControllerOptions) {
    const { context } = opts;
    this.service = new SettingsService({
      readRaw: readRawSettings,
      write: writeSetting,
      secrets: context.secrets,
      redactSalt: () => ensureRedactSalt(context.workspaceState),
      hasWorkspace: () => firstFolder() !== undefined,
      orchestrator: opts.orchestrator,
      project: {
        read: async () => {
          const root = firstFolder();
          return root ? readText(vscode.Uri.joinPath(root, ...PROJECT_CONFIG_PATH)) : undefined;
        },
        write: async (text) => {
          const root = firstFolder();
          if (!root) throw new Error('No folder is open.');
          await vscode.workspace.fs.createDirectory(
            vscode.Uri.joinPath(root, PROJECT_CONFIG_PATH[0]),
          );
          await vscode.workspace.fs.writeFile(
            vscode.Uri.joinPath(root, ...PROJECT_CONFIG_PATH),
            new TextEncoder().encode(text),
          );
        },
        markers: async () => {
          const root = firstFolder();
          return root ? projectMarkers(root) : {};
        },
      },
      post: (m) => this.post(m),
      log: opts.log,
      tryIt: () => opts.tryIt(),
      openJson: async () => {
        await vscode.commands.executeCommand('workbench.action.openSettingsJson');
      },
    });

    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration(SETTINGS_SECTION)) return;
        this.updateContext();
        this.schedulePush();
        if (this.ready) void this.service.postState();
      }),
      // Secrets can change from another window; the orchestrator drops cached keys on a push.
      context.secrets.onDidChange(() => {
        this.schedulePush();
        if (this.ready) void this.service.postState();
      }),
    );
    this.updateContext();
    const { problems } = this.service.read();
    for (const p of problems) opts.log.warn(`Settings: ${p}`);
  }

  /** Opens (or reveals) the Settings tab, optionally on one section. */
  open(section?: SettingsSection): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active);
      if (section) this.show(section);
      return;
    }
    const dist = vscode.Uri.joinPath(this.opts.extensionUri, 'dist');
    const panel = vscode.window.createWebviewPanel(
      SETTINGS_PANEL_TYPE,
      'Desiide Settings',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: false,
        localResourceRoots: [
          vscode.Uri.joinPath(dist, 'webview'),
          vscode.Uri.joinPath(dist, 'codicons'),
        ],
      },
    );
    panel.iconPath = vscode.Uri.joinPath(this.opts.extensionUri, 'media', 'desiide.svg');
    this.panel = panel;
    this.ready = false;
    this.pendingSection = section;
    const asUri = (...parts: string[]) =>
      panel.webview.asWebviewUri(vscode.Uri.joinPath(dist, ...parts)).toString();
    panel.webview.html = buildWebviewHtml({
      view: 'settings',
      nonce: randomBytes(16).toString('base64'),
      cspSource: panel.webview.cspSource,
      scriptUri: asUri('webview', 'main.js'),
      styleUri: asUri('webview', 'main.css'),
      codiconUri: asUri('codicons', 'codicon.css'),
      title: 'Desiide Settings',
    });

    const router = createMessageRouter('settings', this.opts.log);
    router.on('ready', () => {
      this.ready = true;
      this.post({ type: 'init', view: 'settings', devMode: false, showcase: false });
      if (this.pendingSection) this.show(this.pendingSection);
      this.pendingSection = undefined;
    });
    router.on('command', ({ command }) => vscode.commands.executeCommand(command));
    router.on('log', ({ level, message }) => this.opts.log[level](`[settings webview] ${message}`));
    for (const type of SettingsToHost.options.map((o) => o.shape.type.value)) {
      router.on(type, (m) => this.service.handle(m as SettingsToHost));
    }
    panel.webview.onDidReceiveMessage((raw: unknown) => void router.handle(raw));
    panel.onDidDispose(() => {
      this.panel = undefined;
      this.ready = false;
    });
  }

  private show(section: SettingsSection): void {
    if (this.ready) this.post({ type: 'settings.show', section });
    else this.pendingSection = section;
  }

  private post(message: ExtensionToWebview): void {
    void this.panel?.webview.postMessage(message);
  }

  private updateContext(): void {
    const has = this.service.config().models.length > 0;
    void vscode.commands.executeCommand('setContext', HAS_MODELS_CONTEXT, has);
  }

  /** Coalesces bursts (a save writes several keys) into one `config.update`. */
  private schedulePush(): void {
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => {
      this.pushTimer = undefined;
      void this.service.push();
    }, 150);
  }

  dispose(): void {
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.panel?.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
