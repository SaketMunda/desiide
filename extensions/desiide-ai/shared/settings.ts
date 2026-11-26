import {
  JevPackState,
  KnownPack,
  ModelConfig,
  ModelLocality,
  ModelProvider,
  RolesConfig,
  SecretRef,
} from '@desiide/protocol';
import * as z from 'zod';

/**
 * Settings page & onboarding (UI-6) contract between host and webview. API keys only ever travel
 * webview → host (`settings.setKey`), and the host only ever answers with `set` / `missing`.
 */

export const SettingsSection = z.enum(['start', 'models', 'roles', 'jev', 'gating', 'project']);
export type SettingsSection = z.infer<typeof SettingsSection>;

export const ProviderPresetId = z.enum(['anthropic', 'openai', 'openrouter', 'gemini', 'custom']);
export type ProviderPresetId = z.infer<typeof ProviderPresetId>;

export interface ProviderPreset {
  id: ProviderPresetId;
  label: string;
  provider: ModelProvider;
  baseUrl?: string;
  /** Shared by every model of this preset, so one key covers them all. */
  keyRef?: SecretRef;
  modelPlaceholder: string;
  /** Prefilled model name, only where we know a current one. */
  defaultModel?: string;
  keyUrlHint?: string;
}

const ANTHROPIC_PRESET: ProviderPreset = {
  id: 'anthropic',
  label: 'Anthropic (Claude)',
  provider: 'anthropic',
  keyRef: 'secret:anthropic',
  modelPlaceholder: 'claude-sonnet-5-5',
  defaultModel: 'claude-sonnet-5-5',
  keyUrlHint: 'console.anthropic.com → API keys',
};

/** Cloud providers offered in onboarding and "Add model". Local models come from discovery. */
export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  ANTHROPIC_PRESET,
  {
    id: 'openai',
    label: 'OpenAI',
    provider: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    keyRef: 'secret:openai',
    modelPlaceholder: 'a model id from your OpenAI account',
    keyUrlHint: 'platform.openai.com → API keys',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    provider: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyRef: 'secret:openrouter',
    modelPlaceholder: 'vendor/model, e.g. anthropic/claude-sonnet-5-5',
    keyUrlHint: 'openrouter.ai → Keys',
  },
  {
    id: 'gemini',
    label: 'Gemini (OpenAI-compatible)',
    provider: 'openai-compatible',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyRef: 'secret:gemini',
    modelPlaceholder: 'a Gemini model id',
    keyUrlHint: 'aistudio.google.com → API keys',
  },
  {
    id: 'custom',
    label: 'Other OpenAI-compatible server',
    provider: 'openai-compatible',
    modelPlaceholder: 'model name the server expects',
  },
];

export const presetById = (id: ProviderPresetId): ProviderPreset =>
  PROVIDER_PRESETS.find((p) => p.id === id) ?? ANTHROPIC_PRESET;

export const KeyStatus = z.enum(['set', 'missing', 'none']);
export type KeyStatus = z.infer<typeof KeyStatus>;

export const HealthResult = z.object({
  ok: z.boolean(),
  latencyMs: z.int().nonnegative().optional(),
  error: z
    .object({ kind: z.string(), message: z.string(), hint: z.string().optional() })
    .optional(),
});
export type HealthResult = z.infer<typeof HealthResult>;

export const ModelRow = z.object({
  config: ModelConfig,
  /** `none`: this model takes no key. Never the key itself. */
  keyStatus: KeyStatus,
  /** Override if set, else inferred (ADR-017). */
  locality: ModelLocality,
  localityOverridden: z.boolean(),
  /** From `models.list`; absent until the orchestrator has answered. */
  healthy: z.boolean().optional(),
  contextTokens: z.int().positive().optional(),
});
export type ModelRow = z.infer<typeof ModelRow>;

export const DiscoveredModel = z.object({ model: z.string(), contextTokens: z.int().positive() });
export type DiscoveredModel = z.infer<typeof DiscoveredModel>;

export const SettingsState = z.object({
  /** False without an open folder: the orchestrator (tests, discovery, preview) needs one. */
  workspace: z.boolean(),
  models: z.array(ModelRow),
  roles: RolesConfig,
  jev: z.object({
    enabled: z.boolean(),
    endpoint: z.string().optional(),
    keyStatus: KeyStatus,
    redactPaths: z.boolean(),
  }),
  gating: z.object({
    mode: z.enum(['conservative', 'strict']),
    /** Rejected values from settings.json, shown next to the mode (AC4). */
    warnings: z.array(z.string()),
    denyList: z.array(z.object({ id: z.string(), text: z.string() })),
    defaultSensitiveGlobs: z.array(z.string()),
  }),
  project: z.object({
    testCommand: z.string().optional(),
    lintCommand: z.string().optional(),
    sensitiveGlobs: z.array(z.string()),
    /** Found in the workspace (package.json scripts, Cargo.toml, …), offered when unset. */
    detected: z.object({ testCommand: z.string().optional(), lintCommand: z.string().optional() }),
    /** `.desiide/project.json` exists but couldn't be parsed; saving would overwrite it. */
    invalid: z.boolean(),
  }),
  problems: z.array(z.string()),
});
export type SettingsState = z.infer<typeof SettingsState>;

const KeyValue = z.string().trim().min(1).max(8192);
const Command = z.string().trim().max(1000);

export const SettingsToHost = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('settings.ready') }),
  z.strictObject({ type: z.literal('settings.discover') }),
  /** One click: add a discovered local model and make it the cheap role. */
  z.strictObject({ type: z.literal('settings.useDiscovered'), model: z.string().min(1).max(256) }),
  z.strictObject({
    type: z.literal('settings.saveModel'),
    model: ModelConfig,
    /** Set when editing, so a renamed id replaces the old entry. */
    previousId: z.string().optional(),
    /** Sent with a new key, so save + store + test is one step. Never echoed back. */
    key: KeyValue.optional(),
    test: z.boolean().default(false),
  }),
  z.strictObject({ type: z.literal('settings.removeModel'), id: z.string() }),
  z.strictObject({ type: z.literal('settings.testModel'), id: z.string() }),
  z.strictObject({ type: z.literal('settings.setKey'), ref: SecretRef, key: KeyValue }),
  z.strictObject({ type: z.literal('settings.clearKey'), ref: SecretRef }),
  z.strictObject({ type: z.literal('settings.setRoles'), roles: RolesConfig }),
  z.strictObject({
    type: z.literal('settings.setJev'),
    enabled: z.boolean(),
    endpoint: z.string().max(2048),
    redactPaths: z.boolean(),
  }),
  z.strictObject({ type: z.literal('settings.previewJev'), pack: KnownPack }),
  z.strictObject({ type: z.literal('settings.testJev') }),
  z.strictObject({
    type: z.literal('settings.setGatingMode'),
    mode: z.enum(['conservative', 'strict']),
  }),
  z.strictObject({
    type: z.literal('settings.saveProject'),
    testCommand: Command,
    lintCommand: Command,
    sensitiveGlobs: z.array(z.string().trim().min(1).max(512)).max(200),
  }),
  z.strictObject({ type: z.literal('settings.tryIt') }),
  z.strictObject({ type: z.literal('settings.openJson') }),
]);
export type SettingsToHost = z.infer<typeof SettingsToHost>;

export const SettingsToWebview = z.discriminatedUnion('type', [
  z.object({ type: z.literal('settings.state'), state: SettingsState }),
  z.object({ type: z.literal('settings.show'), section: SettingsSection }),
  z.object({ type: z.literal('settings.modelTest'), id: z.string(), result: HealthResult }),
  z.object({ type: z.literal('settings.modelTesting'), id: z.string() }),
  z.object({
    type: z.literal('settings.discovered'),
    models: z.array(DiscoveredModel),
    error: z.string().optional(),
  }),
  z.object({
    type: z.literal('settings.jevPreview'),
    pack: KnownPack,
    state: JevPackState.optional(),
    error: z.string().optional(),
  }),
  z.object({ type: z.literal('settings.jevTest'), result: HealthResult }),
  z.object({
    type: z.literal('settings.notice'),
    level: z.enum(['info', 'success', 'warn', 'error']),
    message: z.string(),
  }),
]);
export type SettingsToWebview = z.infer<typeof SettingsToWebview>;
