import {
  DesiideConfig,
  ModelCapabilities,
  ModelProvider,
  ModelRole,
  type ModelConfig,
  type ModelInfo,
  type ResultOf,
} from '@desiide/protocol';
import { ModelError, defaultHint } from './errors.ts';
import { redact } from './redact.ts';
import type { FetchLike, ModelLogger } from './http.ts';
import { createSecretResolver, type RequestSecret, type SecretResolver } from './secrets.ts';
import { inferLocality, isLoopback } from './locality.ts';
import type { ModelAdapter } from './types.ts';

export interface ProviderContext {
  config: ModelConfig;
  /** The configured key, resolved lazily via `secrets.get`. `undefined` when none is configured. */
  apiKey(signal?: AbortSignal): Promise<string | undefined>;
  /** Every key resolved so far; pass to `httpRequest({secrets})` for redaction. */
  secrets(): string[];
  fetch?: FetchLike;
  logger?: ModelLogger;
}

export interface DiscoveredModel {
  model: string;
  capabilities?: Partial<ModelCapabilities>;
}

export interface ProviderDefinition {
  create(ctx: ProviderContext): ModelAdapter;
  /**
   * Where the provider's server runs when the config doesn't say (Ollama's loopback port). Used for
   * models without a `baseUrl`, and probed by `list({discover: true})` so onboarding can find a
   * running server. Must be a loopback URL: discovery never reaches beyond this machine on its own.
   */
  defaultBaseUrl?: string;
  /** Models a server offers (e.g. Ollama `/api/tags`). Only called for configured base URLs. */
  discover?(
    ctx: { baseUrl: string; fetch?: FetchLike; logger?: ModelLogger },
    signal: AbortSignal,
  ): Promise<DiscoveredModel[]>;
}

export type ProviderDefinitions = Partial<Record<ModelProvider, ProviderDefinition>>;

export type ModelTestResult = ResultOf<'models.test'>;

export interface ModelRegistryOptions {
  providers: ProviderDefinitions;
  requestSecret: RequestSecret;
  fetch?: FetchLike;
  logger?: ModelLogger;
  now?: () => number;
}

export interface ModelRegistry {
  /** Rebuilds adapters from `config.update`. Clears cached keys and health. */
  configure(config: DesiideConfig): void;
  /** Throws a `bad_request` ModelError for an unknown id or an unavailable provider. */
  get(id: string): ModelAdapter;
  /**
   * The model for a role (ADR-007). An unset role falls back to the only configured model, so a
   * single local model works without role setup.
   */
  forRole(role: ModelRole): ModelAdapter;
  /** Adapter capabilities with config-declared ones on top. */
  capabilities(id: string, signal?: AbortSignal): Promise<ModelCapabilities>;
  config(id: string): ModelConfig | undefined;
  list(options: { discover: boolean }, signal: AbortSignal): Promise<ResultOf<'models.list'>>;
  /** A tiny request: latency to the first output, or the error kind. */
  test(id: string, signal: AbortSignal): Promise<ModelTestResult>;
  /** Values to redact from anything this registry's adapters log. */
  knownSecrets(): string[];
}

/** Used when neither the adapter nor the config says otherwise. Deliberately modest. */
export const FALLBACK_CAPABILITIES: ModelCapabilities = {
  streaming: true,
  toolCalls: false,
  contextTokens: 8_192,
  vision: false,
};

const TEST_PROMPT = 'Reply with the single word OK.';

interface Entry {
  config: ModelConfig;
  adapter?: ModelAdapter;
  /** Why there's no adapter. */
  unavailable?: string;
}

export function createModelRegistry(options: ModelRegistryOptions): ModelRegistry {
  const { providers, logger } = options;
  const now = options.now ?? Date.now;
  const resolver: SecretResolver = createSecretResolver(options.requestSecret);
  let entries = new Map<string, Entry>();
  let roles: DesiideConfig['roles'] = {};
  const health = new Map<string, boolean>();

  const build = (config: ModelConfig): Entry => {
    const provider = providers[config.provider];
    if (!provider) {
      return {
        config,
        unavailable: `The ${config.provider} provider is not available in this build`,
      };
    }
    const ctx: ProviderContext = {
      config,
      apiKey: (signal) =>
        config.apiKey === undefined
          ? Promise.resolve(undefined)
          : resolver.resolve(config.apiKey, signal),
      secrets: () => resolver.known(),
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(logger ? { logger } : {}),
    };
    try {
      return { config, adapter: provider.create(ctx) };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logger?.warn(
        { modelId: config.id, provider: config.provider },
        'model adapter could not be created',
      );
      return { config, unavailable: reason };
    }
  };

  const entry = (id: string): Entry => {
    const found = entries.get(id);
    if (!found) {
      throw new ModelError('bad_request', `No model with id "${id}" is configured`, {
        hint: 'Add it under desiide.models in settings.',
      });
    }
    return found;
  };

  const roleOf = (id: string): ModelRole | undefined =>
    ModelRole.options.find((role) => roles[role] === id);

  const capabilities = async (e: Entry, signal?: AbortSignal): Promise<ModelCapabilities> => {
    const probed = e.adapter ? await e.adapter.capabilities(signal) : FALLBACK_CAPABILITIES;
    return ModelCapabilities.parse({ ...probed, ...e.config.capabilities });
  };

  const info = async (e: Entry, signal: AbortSignal): Promise<ModelInfo> => {
    let caps: ModelCapabilities;
    let probeOk = true;
    try {
      caps = await capabilities(e, signal);
    } catch {
      probeOk = false;
      caps = ModelCapabilities.parse({ ...FALLBACK_CAPABILITIES, ...e.config.capabilities });
    }
    const role = roleOf(e.config.id);
    return {
      id: e.config.id,
      provider: e.config.provider,
      model: e.config.model,
      ...(role ? { role } : {}),
      capabilities: caps,
      healthy: e.adapter !== undefined && probeOk && health.get(e.config.id) !== false,
      locality: inferLocality(e.config),
    };
  };

  const discover = async (signal: AbortSignal): Promise<ModelInfo[]> => {
    const baseUrlOf = (config: Pick<ModelConfig, 'provider' | 'baseUrl'>): string | undefined =>
      config.baseUrl ?? providers[config.provider]?.defaultBaseUrl;
    const configured = new Set(
      [...entries.values()].map(
        (e) => `${e.config.provider} ${baseUrlOf(e.config) ?? ''} ${e.config.model}`,
      ),
    );
    const targets = new Map<string, { provider: ModelProvider; baseUrl: string }>();
    for (const { config } of entries.values()) {
      const baseUrl = baseUrlOf(config);
      if (baseUrl && providers[config.provider]?.discover) {
        targets.set(`${config.provider} ${baseUrl}`, { provider: config.provider, baseUrl });
      }
    }
    // Onboarding: find a server running at its default local address even before it's configured.
    for (const [name, definition] of Object.entries(providers)) {
      const provider = ModelProvider.parse(name);
      const baseUrl = definition?.defaultBaseUrl;
      if (!baseUrl || !definition.discover || !isLoopback(baseUrl)) continue;
      if (![...targets.values()].some((t) => t.provider === provider)) {
        targets.set(`${provider} ${baseUrl}`, { provider, baseUrl });
      }
    }
    const found: ModelInfo[] = [];
    for (const { provider, baseUrl } of targets.values()) {
      const definition = providers[provider];
      if (!definition?.discover) continue;
      try {
        const models = await definition.discover(
          {
            baseUrl,
            ...(options.fetch ? { fetch: options.fetch } : {}),
            ...(logger ? { logger } : {}),
          },
          signal,
        );
        for (const m of models) {
          const id = `${provider}:${m.model}`.slice(0, 128);
          if (
            configured.has(`${provider} ${baseUrl} ${m.model}`) ||
            found.some((f) => f.id === id)
          ) {
            continue;
          }
          found.push({
            id,
            provider,
            model: m.model,
            capabilities: ModelCapabilities.parse({ ...FALLBACK_CAPABILITIES, ...m.capabilities }),
            healthy: true,
            locality: inferLocality({ provider, baseUrl }),
          });
        }
      } catch {
        // Discovery is best-effort; configured models are still listed.
        logger?.debug({ provider }, 'model discovery failed');
      }
    }
    return found;
  };

  return {
    configure(config) {
      const parsed = DesiideConfig.parse(config);
      resolver.clear();
      health.clear();
      entries = new Map(parsed.models.map((m) => [m.id, build(m)]));
      roles = parsed.roles;
      for (const role of ModelRole.options) {
        const id = roles[role];
        if (id !== undefined && !entries.has(id)) {
          logger?.warn({ role, modelId: id }, 'role points at a model that is not configured');
        }
      }
    },

    get(id) {
      const e = entry(id);
      if (!e.adapter) {
        throw new ModelError(
          'bad_request',
          `Model "${id}" is unavailable: ${e.unavailable ?? 'unknown reason'}`,
        );
      }
      return e.adapter;
    },

    forRole(role) {
      const id = roles[role];
      if (id !== undefined) return this.get(id);
      if (entries.size === 1) return this.get([...entries.keys()][0] ?? '');
      throw new ModelError('bad_request', `No model is assigned to the "${role}" role`, {
        hint: `Set desiide.roles.${role} in settings.`,
      });
    },

    capabilities(id, signal) {
      return capabilities(entry(id), signal);
    },

    config(id) {
      return entries.get(id)?.config;
    },

    async list({ discover: wantDiscover }, signal) {
      const models = await Promise.all([...entries.values()].map((e) => info(e, signal)));
      return { models, discovered: wantDiscover ? await discover(signal) : [] };
    },

    async test(id, signal) {
      const e = entries.get(id);
      if (!e) {
        return {
          ok: false,
          error: { kind: 'bad_request', message: `No model with id "${id}" is configured` },
        };
      }
      if (!e.adapter) {
        return {
          ok: false,
          error: { kind: 'bad_request', message: e.unavailable ?? 'Model unavailable' },
        };
      }
      // Stop reading once the model answers; the rest of the reply isn't needed.
      const local = new AbortController();
      const combined = AbortSignal.any([signal, local.signal]);
      const started = now();
      let result: ModelTestResult = {
        ok: false,
        error: { kind: 'unknown', message: 'The stream ended without a reply' },
      };
      try {
        for await (const event of e.adapter.chat(
          { messages: [{ role: 'user', content: TEST_PROMPT }], maxTokens: 16 },
          combined,
        )) {
          if (event.type === 'error') {
            const { kind, hint } = event.error;
            // Adapters redact already; scrub again since this goes straight to the UI.
            const message = redact(event.error.message, resolver.known());
            const finalHint = hint ?? defaultHint(kind);
            result = {
              ok: false,
              error: { kind, message, ...(finalHint ? { hint: finalHint } : {}) },
            };
            break;
          }
          if (event.type === 'text_delta' || event.type === 'tool_call' || event.type === 'done') {
            result = { ok: true, latencyMs: Math.max(0, Math.round(now() - started)) };
            break;
          }
        }
      } catch (error) {
        const err =
          error instanceof ModelError
            ? error
            : new ModelError(
                signal.aborted ? 'cancelled' : 'unknown',
                error instanceof Error ? error.message : String(error),
                { secrets: resolver.known() },
              );
        result = {
          ok: false,
          error: { kind: err.kind, message: err.message, ...(err.hint ? { hint: err.hint } : {}) },
        };
      } finally {
        local.abort();
      }
      health.set(id, result.ok);
      logger?.debug(
        { modelId: id, ok: result.ok, kind: result.error?.kind, latencyMs: result.latencyMs },
        'model test',
      );
      return result;
    },

    knownSecrets() {
      return resolver.known();
    },
  };
}
