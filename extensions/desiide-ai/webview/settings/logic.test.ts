import { describe, expect, it } from 'vitest';
import { PROVIDER_PRESETS, SettingsToHost, type SettingsState } from '../../shared/settings.ts';
import {
  buildModelConfig,
  describeHealth,
  draftFromConfig,
  draftFromPreset,
  needsKey,
  onboardingProgress,
  uniqueId,
} from './logic.ts';

const preset = (id: string) => {
  const p = PROVIDER_PRESETS.find((x) => x.id === id);
  if (!p) throw new Error(id);
  return p;
};

describe('model drafts', () => {
  it('Anthropic preset: current model prefilled, shared key ref, valid once a key is typed', () => {
    const d = draftFromPreset(preset('anthropic'), []);
    expect(d).toMatchObject({
      id: 'claude-sonnet-5-5',
      provider: 'anthropic',
      keyRef: 'secret:anthropic',
    });
    expect(needsKey(d, false)).toBe(true);
    expect(needsKey({ ...d, key: 'k' }, false)).toBe(false);
    expect(needsKey(d, true)).toBe(false);
    expect(buildModelConfig({ ...d, key: 'sk-SENTINEL' })).toEqual({
      ok: true,
      config: {
        id: 'claude-sonnet-5-5',
        provider: 'anthropic',
        model: 'claude-sonnet-5-5',
        apiKey: 'secret:anthropic',
      },
    });
  });

  it('never puts the typed key into the config', () => {
    const d = {
      ...draftFromPreset(preset('custom'), []),
      model: 'm',
      baseUrl: 'http://h/v1',
      key: 'sk-SENTINEL',
    };
    const r = buildModelConfig(d);
    expect(JSON.stringify(r)).not.toContain('SENTINEL');
    // A key typed for a preset without a shared ref gets one named after the model.
    expect(r).toMatchObject({ ok: true, config: { apiKey: 'secret:custom' } });
    // A local server without a key gets no ref at all.
    expect(buildModelConfig({ ...d, key: '' })).toMatchObject({
      ok: true,
      config: { id: 'custom' },
    });
    expect(buildModelConfig({ ...d, key: '' })).not.toHaveProperty('config.apiKey');
  });

  it('OpenAI-compatible presets fill the base URL and need one', () => {
    const d = draftFromPreset(preset('openrouter'), ['openrouter']);
    expect(d.baseUrl).toBe('https://openrouter.ai/api/v1');
    expect(d.id).toBe('openrouter-2');
    expect(buildModelConfig({ ...d, model: 'x', baseUrl: ' ' })).toEqual({
      ok: false,
      error: 'OpenAI-compatible servers need a base URL.',
    });
  });

  it('round-trips an existing config, keeping fields the form does not show', () => {
    const original = {
      id: 'c',
      provider: 'openai-compatible' as const,
      model: 'gpt',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'secret:example' as const,
      costPerMTok: { input: 1, output: 4 },
      // `vision: false` is explicit because the protocol's partial capabilities keep its
      // `.default(false)`: any override sets it (pre-existing, see UI-6 handoff follow-ups).
      capabilities: { contextTokens: 128_000, toolCalls: false, streaming: true, vision: false },
      locality: 'cloud' as const,
      quirks: { streamUsage: false },
      reasoning: 'low' as const,
    };
    expect(buildModelConfig(draftFromConfig(original), original)).toEqual({
      ok: true,
      config: original,
    });
  });

  it('validates numbers and cost pairs with readable errors', () => {
    const d = { ...draftFromPreset(preset('anthropic'), []), key: 'k' };
    expect(buildModelConfig({ ...d, contextTokens: '12.5' })).toMatchObject({
      ok: false,
      error: 'Context window must be a whole number above 0.',
    });
    expect(buildModelConfig({ ...d, costInput: '1' })).toMatchObject({
      ok: false,
      error: 'Set both input and output cost, or neither.',
    });
    expect(buildModelConfig({ ...d, id: ' ' })).toMatchObject({
      ok: false,
      error: 'Give the model a name.',
    });
    expect(
      buildModelConfig({ ...d, toolCalls: 'no', vision: 'yes', locality: 'local' }),
    ).toMatchObject({
      ok: true,
      config: { capabilities: { toolCalls: false, vision: true }, locality: 'local' },
    });
  });

  it('makes unique slug ids', () => {
    expect(uniqueId('Qwen 2.5 Coder', [])).toBe('qwen-2.5-coder');
    expect(uniqueId('x', ['x', 'x-2'])).toBe('x-3');
  });
});

describe('page helpers', () => {
  it('describes a test result: latency, or the error message', () => {
    expect(describeHealth({ ok: true, latencyMs: 420 })).toEqual({
      tone: 'auto',
      text: 'Connected · 420 ms',
    });
    expect(
      describeHealth({ ok: false, error: { kind: 'auth', message: 'Bad key', hint: 'h' } }),
    ).toEqual({
      tone: 'confirm',
      text: 'Bad key',
    });
  });

  it('tracks onboarding progress', () => {
    const state = {
      models: [{ locality: 'local' }],
      roles: { cheap: 'x' },
      jev: { enabled: false },
    } as unknown as SettingsState;
    expect(onboardingProgress(state)).toEqual({
      hasModel: true,
      hasLocal: true,
      hasCloud: false,
      rolesSet: true,
      jevOn: false,
    });
    const broken = {
      ...state,
      models: [
        { locality: 'local', healthy: false, keyStatus: 'none' },
        { locality: 'cloud', healthy: true, keyStatus: 'missing' },
      ],
    } as unknown as SettingsState;
    expect(onboardingProgress(broken)).toMatchObject({
      hasModel: true,
      hasLocal: false,
      hasCloud: false,
    });
  });
});

describe('settings messages', () => {
  it('reject a raw key where a secret reference belongs', () => {
    expect(
      SettingsToHost.safeParse({
        type: 'settings.saveModel',
        model: { id: 'c', provider: 'anthropic', model: 'x', apiKey: 'sk-raw' },
      }).success,
    ).toBe(false);
    expect(
      SettingsToHost.safeParse({ type: 'settings.setKey', ref: 'secret:a', key: '  ' }).success,
    ).toBe(false);
    expect(
      SettingsToHost.safeParse({ type: 'settings.setGatingMode', mode: 'permissive' }).success,
    ).toBe(false);
  });
});
