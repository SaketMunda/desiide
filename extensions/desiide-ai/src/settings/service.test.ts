import type { ModelInfo } from '@desiide/protocol';
import { describe, expect, it } from 'vitest';
import type { SettingsState, SettingsToWebview } from '../../shared/settings.ts';
import { SettingsService } from './service.ts';
import { fakeSettingsDeps } from './testDeps.ts';

const SENTINEL = 'sk-ant-SENTINEL-4b1e9';

const info = (over: Partial<ModelInfo> & Pick<ModelInfo, 'id' | 'model'>): ModelInfo => ({
  provider: 'ollama',
  capabilities: { streaming: true, toolCalls: true, contextTokens: 32_000, vision: false },
  healthy: true,
  locality: 'local',
  ...over,
});

const lastState = (posts: SettingsToWebview[]): SettingsState => {
  const s = posts.filter((p) => p.type === 'settings.state').at(-1);
  if (s?.type !== 'settings.state') throw new Error('no state posted');
  return s.state;
};

describe('SettingsService: onboarding', () => {
  it('finds Ollama and makes a discovered model the cheap role in one click, then tests it', async () => {
    const f = fakeSettingsDeps({
      handlers: {
        'models.list': (p) => ({
          models: [],
          discovered: p.discover
            ? [info({ id: 'ollama:qwen2.5-coder:7b', model: 'qwen2.5-coder:7b' })]
            : [],
        }),
        'models.test': () => ({ ok: true, latencyMs: 420 }),
      },
    });
    const s = new SettingsService(f.deps);
    await s.handle({ type: 'settings.discover' });
    expect(f.posts.at(-1)).toEqual({
      type: 'settings.discovered',
      models: [{ model: 'qwen2.5-coder:7b', contextTokens: 32_000 }],
    });

    await s.handle({ type: 'settings.useDiscovered', model: 'qwen2.5-coder:7b' });
    expect(f.settings.get('models')).toEqual([
      { id: 'qwen2.5-coder-7b', provider: 'ollama', model: 'qwen2.5-coder:7b' },
    ]);
    expect(f.settings.get('roles')).toEqual({
      cheap: 'qwen2.5-coder-7b',
      strong: 'qwen2.5-coder-7b',
      reviewer: 'qwen2.5-coder-7b',
    });
    // Settings reached the orchestrator before the test ran.
    const order = f.requests.map(([m]) => m);
    expect(order.indexOf('config.update')).toBeLessThan(order.indexOf('models.test'));
    expect(f.posts).toContainEqual({
      type: 'settings.modelTest',
      id: 'qwen2.5-coder-7b',
      result: { ok: true, latencyMs: 420 },
    });
    // Picking it again doesn't add a duplicate.
    await s.handle({ type: 'settings.useDiscovered', model: 'qwen2.5-coder:7b' });
    expect(f.settings.get('models')).toHaveLength(1);
  });

  it('explains what to do when no local model is found, or no folder is open', async () => {
    const f = fakeSettingsDeps({
      handlers: { 'models.list': () => ({ models: [], discovered: [] }) },
    });
    await new SettingsService(f.deps).handle({ type: 'settings.discover' });
    expect(f.posts.at(-1)).toMatchObject({
      models: [],
      error: expect.stringMatching(/ollama serve/),
    });

    const none = fakeSettingsDeps({ workspace: false });
    await new SettingsService(none.deps).handle({ type: 'settings.discover' });
    expect(none.posts.at(-1)).toMatchObject({ error: expect.stringMatching(/Open a folder/) });
    expect(none.requests).toEqual([]);
  });

  it('adds a cloud model next to a local one and suggests cloud → strong', async () => {
    const f = fakeSettingsDeps({
      settings: {
        models: [{ id: 'local', provider: 'ollama', model: 'qwen' }],
        roles: { cheap: 'local' },
      },
    });
    await new SettingsService(f.deps).handle({
      type: 'settings.saveModel',
      model: {
        id: 'claude',
        provider: 'anthropic',
        model: 'claude-sonnet-5-5',
        apiKey: 'secret:anthropic',
      },
      key: SENTINEL,
      test: false,
    });
    expect(f.settings.get('roles')).toEqual({
      cheap: 'local',
      strong: 'claude',
      reviewer: 'claude',
    });
    expect(f.secrets.get('anthropic')).toBe(SENTINEL);
  });
});

describe('SettingsService: AC2 keys stay in SecretStorage', () => {
  it('a sentinel key never reaches settings, logs, or anything posted to the webview', async () => {
    const f = fakeSettingsDeps({
      handlers: {
        'models.list': () => ({ models: [], discovered: [] }),
        'models.test': () => ({
          ok: false,
          error: { kind: 'auth', message: 'Invalid API key', hint: 'Check the key' },
        }),
        'jev.test': () => ({ ok: false }),
      },
    });
    const s = new SettingsService(f.deps);
    await s.handle({
      type: 'settings.saveModel',
      model: {
        id: 'claude',
        provider: 'anthropic',
        model: 'claude-sonnet-5-5',
        apiKey: 'secret:anthropic',
      },
      key: SENTINEL,
      test: true,
    });
    await s.handle({ type: 'settings.setKey', ref: 'secret:jev', key: SENTINEL });
    await s.handle({
      type: 'settings.setJev',
      enabled: true,
      endpoint: 'https://jev.example.com',
      redactPaths: false,
    });
    await s.handle({ type: 'settings.ready' });

    expect(f.secrets.get('anthropic')).toBe(SENTINEL);
    expect(f.secrets.get('jev')).toBe(SENTINEL);
    expect(JSON.stringify(f.writes)).not.toContain(SENTINEL);
    expect(JSON.stringify([...f.settings])).not.toContain(SENTINEL);
    expect(f.logs.join('\n')).not.toContain(SENTINEL);
    expect(JSON.stringify(f.posts)).not.toContain(SENTINEL);
    expect(JSON.stringify(f.requests)).not.toContain(SENTINEL);
    // The page only learns the status, and settings hold only the reference.
    const state = lastState(f.posts);
    expect(state.models[0]?.keyStatus).toBe('set');
    expect(state.jev.keyStatus).toBe('set');
    expect(f.settings.get('jev.apiKey')).toBe('secret:jev');
  });

  it('reports missing keys and clears them', async () => {
    const f = fakeSettingsDeps({
      settings: {
        models: [{ id: 'c', provider: 'anthropic', model: 'x', apiKey: 'secret:anthropic' }],
      },
    });
    const s = new SettingsService(f.deps);
    await s.handle({ type: 'settings.setKey', ref: 'secret:anthropic', key: 'k' });
    await s.handle({ type: 'settings.clearKey', ref: 'secret:anthropic' });
    expect(lastState(f.posts).models[0]?.keyStatus).toBe('missing');
  });
});

describe('SettingsService: AC3 test shows the error kind and hint', () => {
  it('passes models.test errors through', async () => {
    const error = { kind: 'auth', message: 'Invalid x-api-key', hint: 'Check your Anthropic key' };
    const f = fakeSettingsDeps({
      settings: { models: [{ id: 'c', provider: 'anthropic', model: 'x', apiKey: 'secret:a' }] },
      handlers: {
        'models.test': () => ({ ok: false, error: { ...error, kind: 'auth' as const } }),
      },
    });
    await new SettingsService(f.deps).handle({ type: 'settings.testModel', id: 'c' });
    expect(f.posts).toEqual([
      { type: 'settings.modelTesting', id: 'c' },
      { type: 'settings.modelTest', id: 'c', result: { ok: false, error } },
    ]);
  });

  it('turns an unreachable orchestrator into a readable error', async () => {
    const f = fakeSettingsDeps({
      request: () => Promise.reject(new Error('The Desiide orchestrator stopped.')),
    });
    await new SettingsService(f.deps).handle({ type: 'settings.testModel', id: 'c' });
    expect(f.posts.at(-1)).toMatchObject({
      result: {
        ok: false,
        error: { kind: 'unavailable', message: 'The Desiide orchestrator stopped.' },
      },
    });
  });
});

describe('SettingsService: AC4 gating', () => {
  it('shows hand-edited loosening as warnings, and the UI can only pick safe modes', async () => {
    const f = fakeSettingsDeps({
      settings: { 'gating.mode': 'permissive', 'gating.thresholds': { autoSafeNowMin: 0.2 } },
    });
    const s = new SettingsService(f.deps);
    await s.handle({ type: 'settings.ready' });
    const state = lastState(f.posts);
    expect(state.gating.mode).toBe('conservative');
    expect(state.gating.warnings).toHaveLength(2);
    expect(state.gating.denyList.map((d) => d.id)).toContain('rm_rf');
    expect(state.gating.defaultSensitiveGlobs).toContain('.env');
    expect(s.config().gating.mode).toBe('conservative');
    await s.handle({ type: 'settings.setGatingMode', mode: 'strict' });
    expect(f.settings.get('gating.mode')).toBe('strict');
  });
});

describe('SettingsService: models, roles, Jev, project', () => {
  it('renames a model and moves its roles; removing unsets them', async () => {
    const f = fakeSettingsDeps({
      settings: {
        models: [{ id: 'a', provider: 'ollama', model: 'q' }],
        roles: { cheap: 'a', strong: 'a' },
      },
    });
    const s = new SettingsService(f.deps);
    await s.handle({
      type: 'settings.saveModel',
      model: { id: 'b', provider: 'ollama', model: 'q', locality: 'cloud' },
      previousId: 'a',
      test: false,
    });
    expect(f.settings.get('roles')).toEqual({ cheap: 'b', strong: 'b', reviewer: 'b' });
    expect(lastState(f.posts).models[0]).toMatchObject({
      locality: 'cloud',
      localityOverridden: true,
    });
    await s.handle({ type: 'settings.removeModel', id: 'b' });
    expect(f.settings.get('models')).toEqual([]);
    expect(f.settings.get('roles')).toEqual({});
  });

  it('refuses a duplicate id and unknown role targets', async () => {
    const f = fakeSettingsDeps({
      settings: {
        models: [
          { id: 'a', provider: 'ollama', model: 'q' },
          { id: 'b', provider: 'ollama', model: 'r' },
        ],
      },
    });
    const s = new SettingsService(f.deps);
    await s.handle({
      type: 'settings.saveModel',
      model: { id: 'b', provider: 'ollama', model: 'q' },
      previousId: 'a',
      test: false,
    });
    expect(f.posts.at(-1)).toMatchObject({ level: 'error' });
    await s.handle({ type: 'settings.setRoles', roles: { cheap: 'zzz' } });
    expect(f.posts.at(-1)).toMatchObject({ level: 'error', message: 'Unknown model: zzz.' });
    expect(f.writes).toEqual([]);
  });

  it('validates the Jev endpoint, previews with the salt pushed first', async () => {
    const f = fakeSettingsDeps({
      handlers: {
        'jev.preview': () => ({
          state: {
            pack: 'cost_route@1',
            taskType: 'bug_fix',
            filesTouchedCount: 1,
            projectSizeLines: 3,
            userCostBias: 'balance',
            recentFailures: 0,
          },
        }),
      },
    });
    const s = new SettingsService(f.deps);
    await s.handle({
      type: 'settings.setJev',
      enabled: true,
      endpoint: 'not a url',
      redactPaths: true,
    });
    expect(f.posts.at(-1)).toMatchObject({ level: 'error' });
    await s.handle({ type: 'settings.setJev', enabled: false, endpoint: '', redactPaths: true });
    await s.handle({ type: 'settings.previewJev', pack: 'cost_route@1' });
    const update = f.requests.filter(([m]) => m === 'config.update').at(-1)?.[1];
    expect(update).toMatchObject({ jev: { redactPaths: true, redactSalt: 'c'.repeat(64) } });
    expect(f.posts.at(-1)).toMatchObject({ type: 'settings.jevPreview', pack: 'cost_route@1' });
  });

  it('does not spawn the orchestrator for background pushes', async () => {
    const f = fakeSettingsDeps({ running: false });
    expect(await new SettingsService(f.deps).push()).toBe(false);
    expect(f.requests).toEqual([]);
  });

  it('saves the project file and shows detected commands', async () => {
    const f = fakeSettingsDeps({ projectFile: '{"ignoreGlobs":["dist/**"]}' });
    const s = new SettingsService(f.deps);
    await s.handle({
      type: 'settings.saveProject',
      testCommand: 'pnpm test',
      lintCommand: '',
      sensitiveGlobs: ['infra/**'],
    });
    expect(JSON.parse(f.projectFile() ?? '')).toEqual({
      ignoreGlobs: ['dist/**'],
      testCommand: 'pnpm test',
      sensitiveGlobs: ['infra/**'],
    });
    const state = lastState(f.posts);
    expect(state.project).toEqual({
      testCommand: 'pnpm test',
      sensitiveGlobs: ['infra/**'],
      detected: { testCommand: 'npm test' },
      invalid: false,
    });
  });
});
