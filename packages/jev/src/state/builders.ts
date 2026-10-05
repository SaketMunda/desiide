import {
  CostRouteState,
  MAX_COMMAND_CHARS,
  MAX_FILES_TOUCHED,
  RiskGateState,
  WorkflowSelectState,
  type FileMeta,
  type RiskActionType,
  type Task,
} from '@desiide/protocol';
import type * as z from 'zod';
import { JevRequestError } from '../types.ts';
import type { PathRedactor } from './redact.ts';

/** The part of COR-4's `ContextBundle` the builders read. Metadata only (ADR-005). */
export interface ContextFiles {
  files: readonly FileMeta[];
}

export interface GitInfo {
  branch: string | null;
  hasPendingMigrations: boolean;
}

export interface BuildOptions {
  /** Set when `desiide.jev.redactPaths` is on. */
  redactor?: PathRedactor;
}

export type AvailableModel = WorkflowSelectState['availableModels'][number];

export interface WorkflowSelectInput {
  task: Pick<Task, 'kind' | 'preference'>;
  context: ContextFiles;
  estimatedDiffSize: number;
  lastRunStatus: WorkflowSelectState['lastRunStatus'];
  models: readonly AvailableModel[];
}

export interface RiskAction {
  actionType: RiskActionType;
  /** Full command; truncated to `MAX_COMMAND_CHARS` by the builder. */
  command?: string;
  editFileCount?: number;
}

export interface RiskGateInput {
  action: RiskAction;
  /** Files the action touches (e.g. the edit's files), with sensitivity from COR-4. */
  files: readonly Pick<FileMeta, 'path' | 'sensitive'>[];
  git: GitInfo;
  env?: RiskGateState['context']['env'];
}

export interface CostRouteInput {
  task: Pick<Task, 'kind' | 'preference'>;
  context: ContextFiles;
  projectSizeLines: number;
  recentFailures: number;
}

/** Sensitive files first, then larger files, then by path so the cut is deterministic. */
function capFiles<F extends { path: string; sensitive: boolean; sizeLines?: number }>(
  files: readonly F[],
): { kept: F[]; truncatedCount?: number } {
  const sorted = [...files].sort(
    (a, b) =>
      Number(b.sensitive) - Number(a.sensitive) ||
      (b.sizeLines ?? 0) - (a.sizeLines ?? 0) ||
      (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  );
  const kept = sorted.slice(0, MAX_FILES_TOUCHED);
  const dropped = sorted.length - kept.length;
  return dropped > 0 ? { kept, truncatedCount: dropped } : { kept };
}

export function truncateCommand(command: string): string {
  return command.length <= MAX_COMMAND_CHARS
    ? command
    : `${command.slice(0, MAX_COMMAND_CHARS - 1)}…`;
}

/** Final gate: the strict pack schema rejects any key that isn't allowed metadata. */
function finish<S>(schema: z.ZodType<S>, state: unknown, pack: string): S {
  const parsed = schema.safeParse(state);
  if (!parsed.success) {
    throw new JevRequestError(
      'invalid_state',
      `Built ${pack} state is invalid: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      pack,
    );
  }
  return parsed.data;
}

const identity = (s: string): string => s;

// Every builder copies fields one by one: callers may pass richer objects (a FileMeta with
// extra runtime keys, a ContextBundle with sections), and none of that may leak into state.

export function buildWorkflowSelectState(
  input: WorkflowSelectInput,
  options: BuildOptions = {},
): WorkflowSelectState {
  const redactPath = options.redactor?.path ?? identity;
  const { kept, truncatedCount } = capFiles(input.context.files);
  return finish(
    WorkflowSelectState,
    {
      pack: 'workflow_select@1',
      taskType: input.task.kind,
      filesTouched: kept.map((f) => ({
        path: redactPath(f.path),
        sizeLines: f.sizeLines,
        language: f.language,
        sensitive: f.sensitive,
      })),
      ...(truncatedCount === undefined ? {} : { truncatedCount }),
      estimatedDiffSize: input.estimatedDiffSize,
      lastRunStatus: input.lastRunStatus,
      userPreference: input.task.preference,
      availableModels: input.models.map((m) => ({
        id: m.id,
        contextTokens: m.contextTokens,
        latencyMs: m.latencyMs,
        costTier: m.costTier,
        ...(m.locality ? { locality: m.locality } : {}),
      })),
    },
    'workflow_select@1',
  );
}

export function buildRiskGateState(
  input: RiskGateInput,
  options: BuildOptions = {},
): RiskGateState {
  const redactPath = options.redactor?.path ?? identity;
  const redactCommand = options.redactor?.command ?? identity;
  const { kept, truncatedCount } = capFiles(input.files);
  const { action } = input;
  return finish(
    RiskGateState,
    {
      pack: 'risk_gate@1',
      actionType: action.actionType,
      ...(action.command === undefined
        ? {}
        : { command: truncateCommand(redactCommand(action.command)) }),
      ...(action.editFileCount === undefined ? {} : { editFileCount: action.editFileCount }),
      context: {
        branch: input.git.branch === null ? null : input.git.branch.slice(0, 256),
        env: input.env ?? 'local',
        hasPendingMigrations: input.git.hasPendingMigrations,
      },
      filesTouched: kept.map((f) => ({ path: redactPath(f.path), sensitive: f.sensitive })),
      ...(truncatedCount === undefined ? {} : { truncatedCount }),
    },
    'risk_gate@1',
  );
}

export function buildCostRouteState(input: CostRouteInput): CostRouteState {
  return finish(
    CostRouteState,
    {
      pack: 'cost_route@1',
      taskType: input.task.kind,
      filesTouchedCount: input.context.files.length,
      projectSizeLines: input.projectSizeLines,
      userCostBias: input.task.preference,
      recentFailures: input.recentFailures,
    },
    'cost_route@1',
  );
}
