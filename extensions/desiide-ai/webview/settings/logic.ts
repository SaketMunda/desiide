import { ModelConfig, type ModelProvider, type SecretRef } from '@desiide/protocol';
import type { HealthResult, ProviderPreset, SettingsState } from '../../shared/settings.ts';

type TriState = 'auto' | 'yes' | 'no';

/** The model form's fields, as strings where the user types numbers. Never persisted. */
export interface ModelDraft {
  id: string;
  provider: ModelProvider;
  model: string;
  baseUrl: string;
  /** Typed key; sent once with the save, then cleared. Empty keeps the stored one. */
  key: string;
  keyRef?: SecretRef;
  locality: 'auto' | 'local' | 'cloud';
  contextTokens: string;
  maxOutputTokens: string;
  toolCalls: TriState;
  vision: TriState;
  costInput: string;
  costOutput: string;
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);

export function uniqueId(base: string, taken: readonly string[]): string {
  const root = slug(base) || 'model';
  if (!taken.includes(root)) return root;
  for (let i = 2; ; i++) if (!taken.includes(`${root}-${i}`)) return `${root}-${i}`;
}

const EMPTY: Omit<ModelDraft, 'id' | 'provider' | 'model'> = {
  baseUrl: '',
  key: '',
  locality: 'auto',
  contextTokens: '',
  maxOutputTokens: '',
  toolCalls: 'auto',
  vision: 'auto',
  costInput: '',
  costOutput: '',
};

export function draftFromPreset(preset: ProviderPreset, taken: readonly string[]): ModelDraft {
  const model = preset.defaultModel ?? '';
  return {
    ...EMPTY,
    id: uniqueId(model || preset.id, taken),
    provider: preset.provider,
    model,
    baseUrl: preset.baseUrl ?? '',
    ...(preset.keyRef ? { keyRef: preset.keyRef } : {}),
  };
}

const tri = (v: boolean | undefined): TriState => (v === undefined ? 'auto' : v ? 'yes' : 'no');
const str = (n: number | undefined) => (n === undefined ? '' : String(n));

export function draftFromConfig(c: ModelConfig): ModelDraft {
  return {
    ...EMPTY,
    id: c.id,
    provider: c.provider,
    model: c.model,
    baseUrl: c.baseUrl ?? '',
    ...(c.apiKey ? { keyRef: c.apiKey } : {}),
    locality: c.locality ?? 'auto',
    contextTokens: str(c.capabilities?.contextTokens),
    maxOutputTokens: str(c.capabilities?.maxOutputTokens),
    toolCalls: tri(c.capabilities?.toolCalls),
    vision: tri(c.capabilities?.vision),
    costInput: str(c.costPerMTok?.input),
    costOutput: str(c.costPerMTok?.output),
  };
}

export type BuildResult = { ok: true; config: ModelConfig } | { ok: false; error: string };

/**
 * The `ModelConfig` a draft saves as. Keys never go in here: only the `secret:` reference, which
 * is the preset's shared one, the existing one, or one named after the model when a key is typed.
 */
export function buildModelConfig(d: ModelDraft, original?: ModelConfig): BuildResult {
  const id = d.id.trim();
  const model = d.model.trim();
  const baseUrl = d.baseUrl.trim();
  if (!id) return { ok: false, error: 'Give the model a name.' };
  if (!model) return { ok: false, error: 'Enter the model name the provider expects.' };
  if (d.provider === 'openai-compatible' && !baseUrl) {
    return { ok: false, error: 'OpenAI-compatible servers need a base URL.' };
  }
  const num = (s: string, label: string, int: boolean): number | undefined | string => {
    const t = s.trim();
    if (t === '') return undefined;
    const n = Number(t);
    if (!Number.isFinite(n) || n < 0 || (int && (!Number.isInteger(n) || n === 0))) {
      return `${label} must be ${int ? 'a whole number above 0' : 'a number, 0 or more'}.`;
    }
    return n;
  };
  const ctx = num(d.contextTokens, 'Context window', true);
  const maxOut = num(d.maxOutputTokens, 'Max output', true);
  const costIn = num(d.costInput, 'Input cost', false);
  const costOut = num(d.costOutput, 'Output cost', false);
  for (const v of [ctx, maxOut, costIn, costOut])
    if (typeof v === 'string') return { ok: false, error: v };
  if ((costIn === undefined) !== (costOut === undefined)) {
    return { ok: false, error: 'Set both input and output cost, or neither.' };
  }

  const keyRef: SecretRef | undefined =
    d.keyRef ?? (d.key.trim() !== '' ? (`secret:${slug(id) || 'model'}` as SecretRef) : undefined);
  const capabilities = {
    ...(original?.capabilities?.streaming !== undefined
      ? { streaming: original.capabilities.streaming }
      : {}),
    ...(typeof ctx === 'number' ? { contextTokens: ctx } : {}),
    ...(typeof maxOut === 'number' ? { maxOutputTokens: maxOut } : {}),
    ...(d.toolCalls === 'auto' ? {} : { toolCalls: d.toolCalls === 'yes' }),
    ...(d.vision === 'auto' ? {} : { vision: d.vision === 'yes' }),
  };
  const candidate = {
    // Fields the form doesn't edit (quirks, reasoning) survive an edit.
    ...(original?.quirks ? { quirks: original.quirks } : {}),
    ...(original?.reasoning ? { reasoning: original.reasoning } : {}),
    id,
    provider: d.provider,
    model,
    ...(baseUrl ? { baseUrl } : {}),
    ...(keyRef ? { apiKey: keyRef } : {}),
    ...(typeof costIn === 'number' && typeof costOut === 'number'
      ? { costPerMTok: { input: costIn, output: costOut } }
      : {}),
    ...(Object.keys(capabilities).length > 0 ? { capabilities } : {}),
    ...(d.locality === 'auto' ? {} : { locality: d.locality }),
  };
  const parsed = ModelConfig.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      error: `${issue?.path.join('.') || 'model'}: ${issue?.message ?? 'invalid'}`,
    };
  }
  return { ok: true, config: parsed.data };
}

/** Does this model need a key the user hasn't stored yet? */
export const needsKey = (d: ModelDraft, keyStored: boolean) =>
  d.provider !== 'ollama' && d.keyRef !== undefined && !keyStored && d.key.trim() === '';

export function describeHealth(r: HealthResult): { tone: 'auto' | 'confirm'; text: string } {
  if (r.ok) {
    return {
      tone: 'auto',
      text: r.latencyMs === undefined ? 'Connected' : `Connected · ${r.latencyMs} ms`,
    };
  }
  return { tone: 'confirm', text: r.error?.message ?? 'The test failed.' };
}

export interface OnboardingProgress {
  hasModel: boolean;
  hasLocal: boolean;
  hasCloud: boolean;
  rolesSet: boolean;
  jevOn: boolean;
}

export function onboardingProgress(s: SettingsState): OnboardingProgress {
  // A step is done when its model works, not merely exists: a rejected key or a model the
  // orchestrator can't reach doesn't get a check.
  const working = (m: SettingsState['models'][number]) =>
    m.healthy !== false && m.keyStatus !== 'missing';
  return {
    hasModel: s.models.length > 0,
    hasLocal: s.models.some((m) => m.locality === 'local' && working(m)),
    hasCloud: s.models.some((m) => m.locality === 'cloud' && working(m)),
    rolesSet: s.roles.cheap !== undefined || s.roles.strong !== undefined,
    jevOn: s.jev.enabled,
  };
}

/** Pretty JSON for the payload preview. */
export const prettyJson = (value: unknown) => JSON.stringify(value, null, 2);
