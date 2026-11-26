import { resolveThresholds } from '@desiide/jev';
import {
  DesiideConfig,
  GatingConfig,
  JevConfig,
  ModelConfig,
  type ModelLocality,
  type ModelRole,
  type RolesConfig,
} from '@desiide/protocol';
import { parsePromptSettings } from '../prompt/settings.ts';

/** The raw `desiide.*` values, exactly as `getConfiguration('desiide').get(...)` returns them. */
export interface RawDesiideSettings {
  models: unknown;
  roles: unknown;
  jev: { enabled: unknown; endpoint: unknown; apiKey: unknown; redactPaths: unknown };
  gating: { mode: unknown; thresholds: unknown };
}

export interface ReadConfig {
  /** What goes to the orchestrator with `config.update`. Always valid. */
  config: DesiideConfig;
  /** One line per ignored or invalid value, for the log and the settings page. */
  problems: string[];
  /** Gating values that were rejected because they would loosen gating (AC4). */
  gatingWarnings: string[];
}

/**
 * Reads `desiide.*` value by value, so one bad entry never drops the rest, and never loosens
 * anything: an unknown gating mode becomes `conservative`, and threshold overrides that would
 * weaken gating are reported here (the orchestrator ignores them too, JEV-2).
 */
export function readDesiideConfig(raw: RawDesiideSettings, redactSalt?: string): ReadConfig {
  const prompt = parsePromptSettings({
    models: raw.models,
    roles: raw.roles,
    defaultPreference: undefined,
  });
  const problems = prompt.problems.filter((p) => !p.startsWith('desiide.defaultPreference'));
  const gatingWarnings: string[] = [];

  const jevField = <K extends keyof JevConfig>(key: K, value: unknown): Partial<JevConfig> => {
    if (value === undefined || value === null || value === '') return {};
    const parsed = JevConfig.shape[key].safeParse(value);
    if (parsed.success) return { [key]: parsed.data } as Partial<JevConfig>;
    problems.push(`desiide.jev.${key} is invalid and was ignored`);
    return {};
  };
  const jev: JevConfig = {
    enabled: false,
    redactPaths: false,
    ...jevField('enabled', raw.jev.enabled),
    ...jevField('endpoint', raw.jev.endpoint),
    ...jevField('apiKey', raw.jev.apiKey),
    ...jevField('redactPaths', raw.jev.redactPaths),
    ...(redactSalt ? { redactSalt } : {}),
  };

  const mode = GatingConfig.shape.mode.safeParse(raw.gating.mode ?? 'conservative');
  if (!mode.success) {
    gatingWarnings.push(
      `Ignored desiide.gating.mode = ${JSON.stringify(raw.gating.mode)}: only "conservative" and "strict" exist, so "conservative" is used.`,
    );
  }
  const thresholds: Record<string, number> = {};
  if (raw.gating.thresholds !== undefined && raw.gating.thresholds !== null) {
    if (typeof raw.gating.thresholds === 'object' && !Array.isArray(raw.gating.thresholds)) {
      for (const [key, value] of Object.entries(raw.gating.thresholds)) {
        if (typeof value === 'number') thresholds[key] = value;
        else gatingWarnings.push(`Ignored desiide.gating.thresholds.${key}: must be a number.`);
      }
    } else {
      gatingWarnings.push('Ignored desiide.gating.thresholds: must be an object.');
    }
  }
  gatingWarnings.push(...resolveThresholds(thresholds).warnings);

  const config = DesiideConfig.parse({
    models: prompt.models,
    roles: prompt.roles,
    jev,
    // Thresholds are passed through; the orchestrator applies only the stricter ones.
    gating: { mode: mode.success ? mode.data : 'conservative', thresholds },
  });
  return { config, problems, gatingWarnings };
}

/** Inference from ADR-017, for display before the orchestrator has answered. */
export function inferLocality(model: Pick<ModelConfig, 'provider' | 'baseUrl'>): ModelLocality {
  if (model.provider === 'ollama') return 'local';
  if (!model.baseUrl) return 'cloud';
  try {
    const host = new URL(model.baseUrl).hostname.replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '::1' || /^127\./.test(host) ? 'local' : 'cloud';
  } catch {
    return 'cloud';
  }
}

export const effectiveLocality = (m: ModelConfig): ModelLocality => m.locality ?? inferLocality(m);

/**
 * Fills only the unset roles: local → cheap, cloud → strong (and reviewer). With one model, the
 * orchestrator's single-model fallback covers every role, but filling them keeps the UI honest.
 */
export function suggestRoles(models: readonly ModelConfig[], current: RolesConfig): RolesConfig {
  const ids = new Set(models.map((m) => m.id));
  const roles: RolesConfig = {};
  for (const [role, id] of Object.entries(current) as Array<[ModelRole, string | undefined]>) {
    if (id !== undefined && ids.has(id)) roles[role] = id;
  }
  const local = models.find((m) => effectiveLocality(m) === 'local');
  const cloud = models.find((m) => effectiveLocality(m) === 'cloud');
  roles.cheap ??= (local ?? cloud)?.id;
  roles.strong ??= (cloud ?? local)?.id;
  roles.reviewer ??= roles.strong;
  return Object.fromEntries(
    Object.entries(roles).filter(([, id]) => id !== undefined),
  ) as RolesConfig;
}

/** Roles after removing a model: anything pointing at it is unset. */
export function rolesWithout(roles: RolesConfig, id: string): RolesConfig {
  const next: RolesConfig = {};
  for (const [role, value] of Object.entries(roles) as Array<[ModelRole, string | undefined]>) {
    if (value !== undefined && value !== id) next[role] = value;
  }
  return next;
}

/** A model id that's readable and not taken: `qwen2.5-coder:7b` → `qwen2.5-coder-7b`. */
export function uniqueModelId(base: string, taken: Iterable<string>): string {
  const slug =
    base
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 100) || 'model';
  const used = new Set(taken);
  if (!used.has(slug)) return slug;
  for (let i = 2; ; i++) if (!used.has(`${slug}-${i}`)) return `${slug}-${i}`;
}
