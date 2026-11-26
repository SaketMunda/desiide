import {
  buildCostRouteState,
  buildRiskGateState,
  buildWorkflowSelectState,
  type AvailableModel,
  type GitInfo,
  type PathRedactor,
} from '@desiide/jev';
import type {
  CostTier,
  FileMeta,
  JevPackState,
  KnownPack,
  ModelConfig,
  ModelInfo,
  ResultOf,
} from '@desiide/protocol';
import { listFiles } from '../context/workspaceIO.ts';
import type { Host } from '../host/host.ts';
import { resolveRgPath } from '../tools/ripgrep.ts';
import type { JevSettings } from '../policy/workspacePolicy.ts';

export interface JevHandlerDeps {
  /** Configured models and their configs (for cost tiers). */
  models: {
    list(options: { discover: boolean }, signal: AbortSignal): Promise<ResultOf<'models.list'>>;
    config(id: string): ModelConfig | undefined;
  };
  /** A few real workspace files, as metadata only (COR-4's `describeFiles`). */
  sampleFiles(signal: AbortSignal): Promise<FileMeta[]>;
  git(signal: AbortSignal): Promise<GitInfo>;
  redactor(): PathRedactor | undefined;
  jevSettings(): JevSettings;
}

/** Files the preview samples: enough to show the shape and redaction, not a full listing. */
export const PREVIEW_SAMPLE_FILES = 5;

/**
 * A rough price bucket for `availableModels[].costTier`, from `costPerMTok.output` ($/MTok).
 * Local models are free; a cloud model with no known price counts as `medium`.
 */
export function costTierOf(info: Pick<ModelInfo, 'locality'>, config?: ModelConfig): CostTier {
  if (info.locality === 'local') return 'free';
  const output = config?.costPerMTok?.output;
  if (output === undefined) return 'medium';
  if (output === 0) return 'free';
  if (output < 2) return 'low';
  if (output < 20) return 'medium';
  return 'high';
}

export function availableModels(
  models: readonly ModelInfo[],
  config: (id: string) => ModelConfig | undefined,
): AvailableModel[] {
  return models.map((m) => ({
    id: m.id,
    contextTokens: m.capabilities.contextTokens,
    // Unknown until COR-5 measures it; 0 reads as "no data", not "instant".
    latencyMs: 0,
    costTier: costTierOf(m, config(m.id)),
    ...(m.locality ? { locality: m.locality } : {}),
  }));
}

/** `count` paths spread evenly over a sorted listing, so the sample isn't all one folder. */
export function pickSample(paths: readonly string[], count = PREVIEW_SAMPLE_FILES): string[] {
  if (paths.length <= count) return [...paths];
  return Array.from(
    { length: count },
    (_, i) => paths[Math.floor((i * paths.length) / count)] ?? '',
  ).filter((p) => p !== '');
}

/**
 * `sampleFiles` for the real workspace: the agent's own rg walk (gitignore-aware), a spread
 * sample, then COR-4's metadata. File text is read only to count lines and never leaves here.
 */
export function workspaceSampler(opts: {
  workspaceRoots(): readonly string[] | undefined;
  describeFiles(paths: string[], signal: AbortSignal): Promise<FileMeta[]>;
  env?: NodeJS.ProcessEnv;
}): (signal: AbortSignal) => Promise<FileMeta[]> {
  const env = opts.env ?? process.env;
  return async (signal) => {
    const root = opts.workspaceRoots()?.[0];
    const rg = await resolveRgPath(env);
    if (!root || !rg) return [];
    const listing = await listFiles(root, rg, [], { env }, signal);
    return opts.describeFiles(pickSample(listing?.files ?? []), signal);
  };
}

/** The sample task the preview pretends to route: a small bug fix at the default preference. */
const SAMPLE_TASK = { kind: 'bug_fix', preference: 'balance' } as const;

/**
 * Builds exactly the state Desiide would send to Jev for `pack`, from the current workspace:
 * the same JEV-1 builders, redaction, and caps as real decisions. Metadata only (ADR-005).
 */
export async function buildPreviewState(
  pack: KnownPack,
  deps: JevHandlerDeps,
  signal: AbortSignal,
): Promise<JevPackState> {
  const redactor = deps.redactor();
  const options = redactor ? { redactor } : {};
  const files = await deps.sampleFiles(signal);
  if (pack === 'workflow_select@1') {
    const { models } = await deps.models.list({ discover: false }, signal);
    return buildWorkflowSelectState(
      {
        task: SAMPLE_TASK,
        context: { files },
        estimatedDiffSize: 20,
        lastRunStatus: 'none',
        models: availableModels(models, (id) => deps.models.config(id)),
      },
      options,
    );
  }
  if (pack === 'risk_gate@1') {
    const edited = files.slice(0, 2);
    return buildRiskGateState(
      {
        action: { actionType: 'apply_edit', editFileCount: edited.length },
        files: edited,
        git: await deps.git(signal),
      },
      options,
    );
  }
  return buildCostRouteState({
    task: SAMPLE_TASK,
    context: { files },
    projectSizeLines: files.reduce((sum, f) => sum + f.sizeLines, 0),
    recentFailures: 0,
  });
}

/**
 * `jev.test`. The Jev HTTP client is JEV-3 (blocked on the API docs, ADR-020), so this build
 * never calls the endpoint: it reports honestly that decisions run on the rules engine.
 */
export function jevTestResult(settings: JevSettings): ResultOf<'jev.test'> {
  if (!settings.enabled) {
    return {
      ok: false,
      error: {
        kind: 'not_configured',
        message: 'Jev is off. Decisions run on the built-in rules engine.',
        hint: 'Turn on Jev and add its endpoint to use it.',
      },
    };
  }
  if (!settings.endpoint) {
    return {
      ok: false,
      error: {
        kind: 'not_configured',
        message: 'Jev is on, but no endpoint is set.',
        hint: 'Add the Jev endpoint URL.',
      },
    };
  }
  return {
    ok: false,
    error: {
      kind: 'unavailable',
      message:
        'This build has no Jev API client yet, so decisions run on the built-in rules engine.',
      hint: 'Nothing is sent to the endpoint until the client ships. Your settings are kept.',
    },
  };
}

export function registerJevHandlers(host: Host, deps: JevHandlerDeps): void {
  host.register('jev.preview', async ({ pack }, { signal }) => ({
    state: await buildPreviewState(pack, deps, signal),
  }));
  host.register('jev.test', () => jevTestResult(deps.jevSettings()));
}
