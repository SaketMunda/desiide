import {
  ModelConfig,
  Preference,
  RolesConfig,
  WorkflowOption,
  type ModelRole,
} from '@desiide/protocol';
import type { PromptConfig, WorkflowAvailability } from '../../shared/messages.ts';

/** The `desiide.*` settings the Prompt Box reads. UI-6 owns editing them. */
export interface RawPromptSettings {
  models: unknown;
  roles: unknown;
  defaultPreference: unknown;
}

export interface PromptSettings {
  models: ModelConfig[];
  roles: RolesConfig;
  defaultPreference: Preference;
  /** Human-readable problems with the raw settings, for the log. */
  problems: string[];
}

/** Validates settings entry by entry: one bad model entry doesn't hide the good ones. */
export function parsePromptSettings(raw: RawPromptSettings): PromptSettings {
  const problems: string[] = [];
  const models: ModelConfig[] = [];
  if (raw.models !== undefined && !Array.isArray(raw.models)) {
    problems.push('desiide.models must be an array');
  }
  for (const [i, entry] of (Array.isArray(raw.models) ? raw.models : []).entries()) {
    const parsed = ModelConfig.safeParse(entry);
    if (parsed.success) models.push(parsed.data);
    else problems.push(`desiide.models[${i}] is invalid and was ignored`);
  }
  const ids = new Set(models.map((m) => m.id));

  const rolesParsed = RolesConfig.safeParse(raw.roles ?? {});
  if (!rolesParsed.success) problems.push('desiide.roles is invalid and was ignored');
  const roles: RolesConfig = {};
  for (const [role, id] of Object.entries(rolesParsed.success ? rolesParsed.data : {})) {
    if (id === undefined) continue;
    if (ids.has(id)) roles[role as ModelRole] = id;
    else problems.push(`desiide.roles.${role} points to unknown model "${id}"`);
  }

  const pref = Preference.safeParse(raw.defaultPreference ?? 'balance');
  if (!pref.success) problems.push('desiide.defaultPreference is invalid; using "balance"');

  return {
    models,
    roles,
    defaultPreference: pref.success ? pref.data : 'balance',
    problems,
  };
}

/** Roles each workflow needs (COR-5: reviewer falls back to strong). */
const REQUIRED_ROLES: Record<WorkflowOption, readonly ModelRole[]> = {
  'local-single': ['cheap'],
  'cloud-single': ['strong'],
  'local-cloud-cascade': ['cheap', 'strong'],
  'cloud-with-critique': ['strong'],
};

/** Critique ships at Beta (COR-5); until then it's hidden from the selector. */
export const CRITIQUE_AVAILABLE = false;

export function workflowAvailability(roles: RolesConfig): WorkflowAvailability[] {
  return WorkflowOption.options.map((option) => {
    const missing = REQUIRED_ROLES[option].filter((r) => roles[r] === undefined);
    const hidden = option === 'cloud-with-critique' && !CRITIQUE_AVAILABLE;
    return missing.length === 0
      ? { option, enabled: true, hidden }
      : {
          option,
          enabled: false,
          hidden,
          reason: `Assign a model to the ${missing.map((r) => `"${r}"`).join(' and ')} role${missing.length > 1 ? 's' : ''} in Desiide settings.`,
        };
  });
}

export function promptConfig(settings: PromptSettings, mock: boolean): PromptConfig {
  const windows = settings.models.flatMap((m) =>
    m.capabilities?.contextTokens === undefined ? [] : [m.capabilities.contextTokens],
  );
  return {
    hasModels: settings.models.length > 0,
    workflows: workflowAvailability(settings.roles),
    defaultPreference: settings.defaultPreference,
    ...(windows.length > 0 ? { contextLimitTokens: Math.min(...windows) } : {}),
    mock,
  };
}
