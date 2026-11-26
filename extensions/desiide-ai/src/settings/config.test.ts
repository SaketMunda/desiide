import { DEFAULT_THRESHOLDS } from '@desiide/jev';
import type { ModelConfig } from '@desiide/protocol';
import { describe, expect, it } from 'vitest';
import {
  inferLocality,
  readDesiideConfig,
  rolesWithout,
  suggestRoles,
  uniqueModelId,
  type RawDesiideSettings,
} from './config.ts';

const raw = (over: Partial<RawDesiideSettings> = {}): RawDesiideSettings => ({
  models: [],
  roles: {},
  jev: { enabled: undefined, endpoint: undefined, apiKey: undefined, redactPaths: undefined },
  gating: { mode: undefined, thresholds: undefined },
  ...over,
});

const local: ModelConfig = { id: 'local', provider: 'ollama', model: 'qwen2.5-coder:7b' };
const claude: ModelConfig = {
  id: 'claude',
  provider: 'anthropic',
  model: 'claude-sonnet-5-5',
  apiKey: 'secret:anthropic',
};

describe('readDesiideConfig', () => {
  it('defaults to Jev off and conservative gating', () => {
    const { config, problems, gatingWarnings } = readDesiideConfig(raw());
    expect(config).toEqual({
      models: [],
      roles: {},
      jev: { enabled: false, redactPaths: false },
      gating: { mode: 'conservative', thresholds: {} },
    });
    expect(problems).toEqual([]);
    expect(gatingWarnings).toEqual([]);
  });

  it('keeps good model entries and reports bad ones', () => {
    const { config, problems } = readDesiideConfig(
      raw({ models: [local, { id: 'x' }, claude], roles: { cheap: 'local', strong: 'gone' } }),
    );
    expect(config.models.map((m) => m.id)).toEqual(['local', 'claude']);
    expect(config.roles).toEqual({ cheap: 'local' });
    expect(problems).toEqual([
      'desiide.models[1] is invalid and was ignored',
      'desiide.roles.strong points to unknown model "gone"',
    ]);
  });

  it('rejects a raw API key in settings instead of passing it on', () => {
    const { config, problems } = readDesiideConfig(
      raw({
        models: [{ ...claude, apiKey: 'sk-live-SENTINEL' }],
        jev: {
          enabled: true,
          endpoint: 'https://j.example',
          apiKey: 'sk-SENTINEL',
          redactPaths: 1,
        },
      }),
    );
    expect(JSON.stringify(config)).not.toContain('SENTINEL');
    expect(problems).toContain('desiide.jev.apiKey is invalid and was ignored');
    expect(problems).toContain('desiide.jev.redactPaths is invalid and was ignored');
  });

  it('adds the salt only when given', () => {
    const salt = 'a'.repeat(64);
    expect(
      readDesiideConfig(raw({ jev: { ...raw().jev, redactPaths: true } }), salt).config.jev,
    ).toEqual({ enabled: false, redactPaths: true, redactSalt: salt });
  });

  describe('AC4: hand-edited gating never loosens', () => {
    it('turns an unknown mode into conservative, with a warning', () => {
      const r = readDesiideConfig(raw({ gating: { mode: 'permissive', thresholds: undefined } }));
      expect(r.config.gating.mode).toBe('conservative');
      expect(r.gatingWarnings[0]).toMatch(/permissive.*"conservative" is used/);
    });

    it('warns about each loosening, unknown, or malformed threshold', () => {
      const r = readDesiideConfig(
        raw({
          gating: {
            mode: 'strict',
            thresholds: {
              autoSafeNowMin: 0.1,
              blockSafeNowBelow: 0.3,
              maxAutoEditFiles: 50,
              nope: 1,
              autoReversibleMin: 'high',
            },
          },
        }),
      );
      expect(r.config.gating.mode).toBe('strict');
      const text = r.gatingWarnings.join('\n');
      expect(text).toMatch(/autoSafeNowMin = 0\.1: it would loosen gating/);
      expect(text).toMatch(/maxAutoEditFiles = 50: it would loosen gating/);
      expect(text).toMatch(/nope: unknown threshold/);
      expect(text).toMatch(/autoReversibleMin: must be a number/);
      // The stricter one isn't a warning.
      expect(text).not.toMatch(/blockSafeNowBelow/);
      expect(DEFAULT_THRESHOLDS.blockSafeNowBelow).toBe(0);
    });

    it('warns when thresholds is not an object', () => {
      const r = readDesiideConfig(raw({ gating: { mode: undefined, thresholds: [1] } }));
      expect(r.gatingWarnings).toEqual(['Ignored desiide.gating.thresholds: must be an object.']);
      expect(r.config.gating.thresholds).toEqual({});
    });
  });
});

describe('roles and ids', () => {
  it('infers locality like ADR-017', () => {
    expect(inferLocality(local)).toBe('local');
    expect(inferLocality(claude)).toBe('cloud');
    const compat = { provider: 'openai-compatible' as const };
    expect(inferLocality({ ...compat, baseUrl: 'http://127.0.0.1:1234/v1' })).toBe('local');
    expect(inferLocality({ ...compat, baseUrl: 'http://[::1]:8080/v1' })).toBe('local');
    expect(inferLocality({ ...compat, baseUrl: 'http://192.168.1.4:8080/v1' })).toBe('cloud');
  });

  it('suggests local → cheap, cloud → strong and reviewer, without overriding choices', () => {
    expect(suggestRoles([local, claude], {})).toEqual({
      cheap: 'local',
      strong: 'claude',
      reviewer: 'claude',
    });
    expect(suggestRoles([local, claude], { cheap: 'claude' })).toMatchObject({ cheap: 'claude' });
    expect(suggestRoles([local], {})).toEqual({
      cheap: 'local',
      strong: 'local',
      reviewer: 'local',
    });
    expect(suggestRoles([], { cheap: 'gone' })).toEqual({});
    expect(suggestRoles([{ ...local, locality: 'cloud' }, claude], {}).cheap).toBe('local');
  });

  it('unsets roles of a removed model', () => {
    expect(rolesWithout({ cheap: 'a', strong: 'b', reviewer: 'b' }, 'b')).toEqual({ cheap: 'a' });
  });

  it('makes readable unique ids', () => {
    expect(uniqueModelId('qwen2.5-coder:7b', [])).toBe('qwen2.5-coder-7b');
    expect(uniqueModelId('qwen2.5-coder:7b', ['qwen2.5-coder-7b'])).toBe('qwen2.5-coder-7b-2');
    expect(uniqueModelId(':::', [])).toBe('model');
  });
});
