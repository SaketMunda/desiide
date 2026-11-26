import { DEFAULT_SENSITIVE_GLOBS, DENY_RULES } from '@desiide/jev';
import {
  JevConfig,
  type ClientMethod,
  type DesiideConfig,
  type KnownPack,
  type ModelConfig,
  type ParamsInputOf,
  type ResultOf,
  type RolesConfig,
} from '@desiide/protocol';
import type {
  HealthResult,
  ModelRow,
  SettingsState,
  SettingsToHost,
  SettingsToWebview,
} from '../../shared/settings.ts';
import type { Logger } from '../log.ts';
import { secretStorageKey } from '../orchestrator/notice.ts';
import {
  effectiveLocality,
  inferLocality,
  readDesiideConfig,
  rolesWithout,
  suggestRoles,
  uniqueModelId,
  type RawDesiideSettings,
  type ReadConfig,
} from './config.ts';
import {
  detectCommands,
  parseProjectFile,
  renderProjectFile,
  type ProjectMarkers,
} from './project.ts';

/** Settings keys the page writes, relative to `desiide`. */
export type SettingKey =
  | 'models'
  | 'roles'
  | 'jev.enabled'
  | 'jev.endpoint'
  | 'jev.apiKey'
  | 'jev.redactPaths'
  | 'gating.mode';

export const JEV_KEY_REF = 'secret:jev';

export interface SettingsDeps {
  readRaw(): RawDesiideSettings;
  write(key: SettingKey, value: unknown): Promise<void>;
  /** VS Code SecretStorage, by storage key (the part after `secret:`). */
  secrets: {
    get(name: string): PromiseLike<string | undefined>;
    store(name: string, value: string): PromiseLike<void>;
    delete(name: string): PromiseLike<void>;
  };
  /** The workspace's redaction salt (created on first use). */
  redactSalt(): string;
  hasWorkspace(): boolean;
  orchestrator: {
    /** True while a session is up; background pushes never spawn the orchestrator. */
    isRunning(): boolean;
    request<M extends ClientMethod>(method: M, params: ParamsInputOf<M>): Promise<ResultOf<M>>;
  };
  project: {
    read(): Promise<string | undefined>;
    write(text: string): Promise<void>;
    markers(): Promise<ProjectMarkers>;
  };
  post(message: SettingsToWebview): void;
  log: Logger;
  tryIt(): Promise<void>;
  openJson(): Promise<void>;
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Host logic of the settings page and onboarding, with no `vscode` import. Keys arrive from the
 * webview once, go straight to SecretStorage, and are never posted back, written to settings,
 * or logged: the page only ever learns `set` / `missing`.
 */
export class SettingsService {
  private health = new Map<string, { healthy: boolean; contextTokens: number }>();

  constructor(private readonly deps: SettingsDeps) {}

  /** The config `config.update` sends: settings plus the redaction salt when it's needed. */
  read(): ReadConfig {
    const raw = this.deps.readRaw();
    const wantsRedaction = raw.jev.redactPaths === true;
    return readDesiideConfig(raw, wantsRedaction ? this.deps.redactSalt() : undefined);
  }

  config(): DesiideConfig {
    return this.read().config;
  }

  /**
   * Sends the current settings to the orchestrator. `force` starts it if needed (user actions);
   * otherwise a stopped orchestrator gets them at its next start (`onSessionStart`).
   */
  async push(force = false): Promise<boolean> {
    if (!this.deps.hasWorkspace()) return false;
    if (!force && !this.deps.orchestrator.isRunning()) return false;
    try {
      await this.deps.orchestrator.request('config.update', this.config());
      return true;
    } catch (err) {
      this.deps.log.warn(`Could not send settings to the orchestrator: ${errorMessage(err)}`);
      return false;
    }
  }

  async handle(m: SettingsToHost): Promise<void> {
    switch (m.type) {
      case 'settings.ready':
        await this.postState();
        void this.refreshHealth();
        return;
      case 'settings.discover':
        return this.discover();
      case 'settings.useDiscovered':
        return this.useDiscovered(m.model);
      case 'settings.saveModel':
        return this.saveModel(m.model, m.previousId, m.key, m.test);
      case 'settings.removeModel':
        return this.removeModel(m.id);
      case 'settings.testModel':
        return this.testModel(m.id);
      case 'settings.setKey':
        await this.deps.secrets.store(secretStorageKey(m.ref), m.key);
        this.deps.log.info(`Stored the key for ${m.ref} in SecretStorage`);
        await this.afterChange();
        this.notice('success', 'Key saved to your system keychain.');
        return;
      case 'settings.clearKey':
        await this.deps.secrets.delete(secretStorageKey(m.ref));
        this.deps.log.info(`Removed the key for ${m.ref}`);
        await this.afterChange();
        return;
      case 'settings.setRoles':
        return this.setRoles(m.roles);
      case 'settings.setJev':
        return this.setJev(m.enabled, m.endpoint, m.redactPaths);
      case 'settings.previewJev':
        return this.previewJev(m.pack);
      case 'settings.testJev':
        return this.testJev();
      case 'settings.setGatingMode':
        await this.deps.write('gating.mode', m.mode);
        await this.afterChange();
        return;
      case 'settings.saveProject':
        return this.saveProject(m);
      case 'settings.tryIt':
        return this.deps.tryIt();
      case 'settings.openJson':
        return this.deps.openJson();
    }
  }

  async state(): Promise<SettingsState> {
    const { config, problems, gatingWarnings } = this.read();
    const keyStatus = async (ref: string | undefined) =>
      ref === undefined
        ? ('none' as const)
        : (await this.deps.secrets.get(secretStorageKey(ref)))
          ? ('set' as const)
          : ('missing' as const);
    const models: ModelRow[] = [];
    for (const m of config.models) {
      const health = this.health.get(m.id);
      models.push({
        config: m,
        keyStatus: await keyStatus(m.apiKey),
        locality: effectiveLocality(m),
        localityOverridden: m.locality !== undefined && m.locality !== inferLocality(m),
        ...(health ? { healthy: health.healthy, contextTokens: health.contextTokens } : {}),
      });
    }
    const project = await this.readProject();
    return {
      workspace: this.deps.hasWorkspace(),
      models,
      roles: config.roles,
      jev: {
        enabled: config.jev.enabled,
        ...(config.jev.endpoint ? { endpoint: config.jev.endpoint } : {}),
        keyStatus: await keyStatus(JEV_KEY_REF),
        redactPaths: config.jev.redactPaths,
      },
      gating: {
        mode: config.gating.mode,
        warnings: gatingWarnings,
        denyList: DENY_RULES.map((r) => ({ id: r.id, text: r.text })),
        defaultSensitiveGlobs: [...DEFAULT_SENSITIVE_GLOBS],
      },
      project,
      problems,
    };
  }

  async postState(): Promise<void> {
    this.deps.post({ type: 'settings.state', state: await this.state() });
  }

  /** Model health from the orchestrator, if one is running or a workspace is open. */
  async refreshHealth(): Promise<void> {
    if (!this.deps.hasWorkspace() || this.config().models.length === 0) return;
    try {
      const { models } = await this.deps.orchestrator.request('models.list', { discover: false });
      this.health = new Map(
        models.map((m) => [
          m.id,
          { healthy: m.healthy, contextTokens: m.capabilities.contextTokens },
        ]),
      );
      await this.postState();
    } catch (err) {
      this.deps.log.debug(`Model health unavailable: ${errorMessage(err)}`);
    }
  }

  private async afterChange(): Promise<void> {
    await this.push(true);
    await this.postState();
  }

  private notice(level: 'info' | 'success' | 'warn' | 'error', message: string): void {
    this.deps.post({ type: 'settings.notice', level, message });
  }

  private async readProject(): Promise<SettingsState['project']> {
    if (!this.deps.hasWorkspace()) {
      return { sensitiveGlobs: [], detected: {}, invalid: false };
    }
    const [text, markers] = await Promise.all([
      this.deps.project.read().catch(() => undefined),
      this.deps.project.markers().catch(() => ({})),
    ]);
    const file = parseProjectFile(text);
    return {
      ...(file.config.testCommand ? { testCommand: file.config.testCommand } : {}),
      ...(file.config.lintCommand ? { lintCommand: file.config.lintCommand } : {}),
      sensitiveGlobs: file.config.sensitiveGlobs ?? [],
      detected: detectCommands(markers),
      invalid: file.invalid,
    };
  }

  private async discover(): Promise<void> {
    if (!this.deps.hasWorkspace()) {
      this.deps.post({
        type: 'settings.discovered',
        models: [],
        error: 'Open a folder first: Desiide looks for local models from your workspace.',
      });
      return;
    }
    try {
      await this.push(true);
      const { discovered } = await this.deps.orchestrator.request('models.list', {
        discover: true,
      });
      const local = discovered.filter((m) => m.provider === 'ollama');
      this.deps.post({
        type: 'settings.discovered',
        models: local.map((m) => ({ model: m.model, contextTokens: m.capabilities.contextTokens })),
        ...(local.length === 0
          ? {
              error:
                'No local models found. If Ollama is installed, start it (`ollama serve`) and pull a model (`ollama pull qwen2.5-coder:7b`).',
            }
          : {}),
      });
    } catch (err) {
      this.deps.post({
        type: 'settings.discovered',
        models: [],
        error: `Couldn't look for local models: ${errorMessage(err)}`,
      });
    }
  }

  private async useDiscovered(model: string): Promise<void> {
    const { config } = this.read();
    const existing = config.models.find((m) => m.provider === 'ollama' && m.model === model);
    const id =
      existing?.id ??
      uniqueModelId(
        model,
        config.models.map((m) => m.id),
      );
    const models = existing
      ? config.models
      : [...config.models, { id, provider: 'ollama' as const, model }];
    await this.deps.write('models', models);
    await this.deps.write('roles', suggestRoles(models, { ...config.roles, cheap: id }));
    await this.afterChange();
    this.notice('success', `${model} is now your cheap model. It runs on your machine.`);
    await this.testModel(id);
  }

  private async saveModel(
    model: ModelConfig,
    previousId: string | undefined,
    key: string | undefined,
    test: boolean,
  ): Promise<void> {
    const { config } = this.read();
    const others = config.models.filter((m) => m.id !== (previousId ?? model.id));
    if (others.some((m) => m.id === model.id)) {
      this.notice('error', `A model called "${model.id}" already exists. Pick another name.`);
      return;
    }
    if (key !== undefined) {
      if (!model.apiKey) {
        this.notice('error', 'This model has no key reference, so the key was not saved.');
        return;
      }
      await this.deps.secrets.store(secretStorageKey(model.apiKey), key);
      this.deps.log.info(`Stored the key for ${model.apiKey} in SecretStorage`);
    }
    const index = config.models.findIndex((m) => m.id === (previousId ?? model.id));
    const models =
      index < 0
        ? [...config.models, model]
        : config.models.map((m, i) => (i === index ? model : m));
    let roles: RolesConfig = config.roles;
    if (previousId !== undefined && previousId !== model.id) {
      roles = Object.fromEntries(
        Object.entries(roles).map(([role, id]) => [role, id === previousId ? model.id : id]),
      ) as RolesConfig;
    }
    await this.deps.write('models', models);
    await this.deps.write('roles', suggestRoles(models, roles));
    await this.afterChange();
    this.notice('success', `Saved ${model.id}.`);
    if (test) await this.testModel(model.id);
  }

  private async removeModel(id: string): Promise<void> {
    const { config } = this.read();
    await this.deps.write(
      'models',
      config.models.filter((m) => m.id !== id),
    );
    await this.deps.write('roles', rolesWithout(config.roles, id));
    this.health.delete(id);
    await this.afterChange();
  }

  async testModel(id: string): Promise<void> {
    const post = (result: HealthResult) =>
      this.deps.post({ type: 'settings.modelTest', id, result });
    if (!this.deps.hasWorkspace()) {
      post({
        ok: false,
        error: { kind: 'no_workspace', message: 'Open a folder to test models.' },
      });
      return;
    }
    this.deps.post({ type: 'settings.modelTesting', id });
    try {
      const result = await this.deps.orchestrator.request('models.test', { modelId: id });
      post(result);
      const current = this.health.get(id);
      if (current) this.health.set(id, { ...current, healthy: result.ok });
      void this.refreshHealth();
    } catch (err) {
      post({ ok: false, error: { kind: 'unavailable', message: errorMessage(err) } });
    }
  }

  private async setRoles(roles: RolesConfig): Promise<void> {
    const ids = new Set(this.config().models.map((m) => m.id));
    const unknown = Object.values(roles).filter((id) => id !== undefined && !ids.has(id));
    if (unknown.length > 0) {
      this.notice('error', `Unknown model: ${unknown.join(', ')}.`);
      return;
    }
    await this.deps.write('roles', roles);
    await this.afterChange();
  }

  private async setJev(enabled: boolean, endpoint: string, redactPaths: boolean): Promise<void> {
    const trimmed = endpoint.trim();
    if (trimmed !== '' && !JevConfig.shape.endpoint.safeParse(trimmed).success) {
      this.notice('error', 'The Jev endpoint must be a full URL, like https://jev.example.com.');
      return;
    }
    const hasKey = (await this.deps.secrets.get(secretStorageKey(JEV_KEY_REF))) !== undefined;
    await this.deps.write('jev.enabled', enabled);
    await this.deps.write('jev.endpoint', trimmed === '' ? undefined : trimmed);
    await this.deps.write('jev.apiKey', hasKey ? JEV_KEY_REF : undefined);
    await this.deps.write('jev.redactPaths', redactPaths);
    await this.afterChange();
  }

  private async previewJev(pack: KnownPack): Promise<void> {
    if (!this.deps.hasWorkspace()) {
      this.deps.post({
        type: 'settings.jevPreview',
        pack,
        error: 'Open a folder to preview: the sample is built from your workspace.',
      });
      return;
    }
    try {
      await this.push(true);
      const { state } = await this.deps.orchestrator.request('jev.preview', { pack });
      this.deps.post({ type: 'settings.jevPreview', pack, state });
    } catch (err) {
      this.deps.post({ type: 'settings.jevPreview', pack, error: errorMessage(err) });
    }
  }

  private async testJev(): Promise<void> {
    try {
      await this.push(true);
      const result = await this.deps.orchestrator.request('jev.test', {});
      this.deps.post({ type: 'settings.jevTest', result });
    } catch (err) {
      this.deps.post({
        type: 'settings.jevTest',
        result: { ok: false, error: { kind: 'unavailable', message: errorMessage(err) } },
      });
    }
  }

  private async saveProject(edit: {
    testCommand: string;
    lintCommand: string;
    sensitiveGlobs: string[];
  }): Promise<void> {
    if (!this.deps.hasWorkspace()) {
      this.notice('error', 'Open a folder to save project settings.');
      return;
    }
    const file = parseProjectFile(await this.deps.project.read().catch(() => undefined));
    let text: string;
    try {
      text = renderProjectFile(file.raw, edit);
    } catch (err) {
      this.notice('error', `Not saved: ${errorMessage(err)}`);
      return;
    }
    await this.deps.project.write(text);
    this.notice('success', 'Saved .desiide/project.json.');
    await this.postState();
  }
}
