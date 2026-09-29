import { z } from 'zod';
import { Id, IsoDateTime } from './common.ts';
import { FileMeta } from './context.ts';
import { PolicyOutcome, ReasonLabel } from './reasons.ts';
import { Preference, TaskKind, WorkflowOption } from './task.ts';

export const JevEngineKind = z.enum(['jev', 'rules']);
export type JevEngineKind = z.infer<typeof JevEngineKind>;

/** Pack identifier `name@version`, e.g. `risk_gate@1`. Open-ended so old logs stay readable. */
export const PackId = z.string().regex(/^[a-z][a-z0-9_]*@\d+$/, 'expected name@version');
export type PackId = z.infer<typeof PackId>;

/** Caps from the ide-jev-decisions skill: bounded payloads, metadata only. */
export const MAX_FILES_TOUCHED = 50;
export const MAX_COMMAND_CHARS = 500;

const Probability = z.number().min(0).max(1);

export const CostTier = z.enum(['free', 'low', 'medium', 'high']);
export type CostTier = z.infer<typeof CostTier>;

export const WorkflowSelectState = z.strictObject({
  pack: z.literal('workflow_select@1'),
  taskType: TaskKind,
  filesTouched: z.array(FileMeta).max(MAX_FILES_TOUCHED),
  truncatedCount: z.int().nonnegative().optional(),
  estimatedDiffSize: z.int().nonnegative(),
  lastRunStatus: z.enum(['none', 'success', 'failed', 'cancelled']),
  userPreference: Preference,
  availableModels: z.array(
    z.strictObject({
      id: Id,
      contextTokens: z.int().positive(),
      latencyMs: z.int().nonnegative(),
      costTier: CostTier,
    }),
  ),
});
export type WorkflowSelectState = z.infer<typeof WorkflowSelectState>;

export const RiskActionType = z.enum([
  'run_command',
  'run_tests',
  'lint',
  'apply_edit',
  'git_commit',
  'git_push',
  'install_dependency',
  'delete_file',
  'other',
]);
export type RiskActionType = z.infer<typeof RiskActionType>;

export const RiskGateState = z.strictObject({
  pack: z.literal('risk_gate@1'),
  actionType: RiskActionType,
  command: z.string().max(MAX_COMMAND_CHARS).optional(),
  editFileCount: z.int().nonnegative().optional(),
  context: z.strictObject({
    branch: z.string().max(256).nullable(),
    env: z.enum(['local', 'ci', 'remote', 'unknown']),
    hasPendingMigrations: z.boolean(),
  }),
  filesTouched: z
    .array(z.strictObject({ path: FileMeta.shape.path, sensitive: z.boolean() }))
    .max(MAX_FILES_TOUCHED),
  truncatedCount: z.int().nonnegative().optional(),
});
export type RiskGateState = z.infer<typeof RiskGateState>;

export const CostRouteState = z.strictObject({
  pack: z.literal('cost_route@1'),
  taskType: TaskKind,
  filesTouchedCount: z.int().nonnegative(),
  projectSizeLines: z.int().nonnegative(),
  userCostBias: Preference,
  recentFailures: z.int().nonnegative(),
});
export type CostRouteState = z.infer<typeof CostRouteState>;

/** Every known pack state, discriminated by `pack`. JEV-1 registers these as its v1 schemas. */
export const JevPackState = z.discriminatedUnion('pack', [
  WorkflowSelectState,
  RiskGateState,
  CostRouteState,
]);
export type JevPackState = z.infer<typeof JevPackState>;

export const KnownPack = z.enum(['workflow_select@1', 'risk_gate@1', 'cost_route@1']);
export type KnownPack = z.infer<typeof KnownPack>;

export const JevResult = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('choice'),
    selected: z.string().min(1),
    probs: z.record(z.string(), Probability),
  }),
  z.object({
    kind: z.literal('score'),
    score: z.int().min(0).max(4),
    probs: z.array(Probability).length(5).optional(),
  }),
  z.object({
    kind: z.literal('noul'),
    answer: z.enum(['yes', 'no', 'unknown']),
    pYes: Probability,
  }),
]);
export type JevResult = z.infer<typeof JevResult>;

export const DecisionRecord = z.object({
  id: Id,
  /** Null for decisions made outside a task (e.g. `jev.preview`). */
  taskId: Id.nullable(),
  pack: PackId,
  /** Question id within the pack, e.g. `safe_now`. */
  question: z.string().min(1).max(64),
  engine: JevEngineKind,
  stateHash: z.string().min(1).max(128),
  /**
   * Exactly what was sent to the engine (post-redaction). Kept as an open record rather than
   * `JevPackState` so logs from other pack versions still parse.
   */
  state: z.record(z.string(), z.unknown()),
  result: JevResult,
  /** Set for gating decisions (risk_gate); routing decisions have none. */
  policyOutcome: PolicyOutcome.optional(),
  /** Set for routing decisions after policy is applied. */
  workflow: WorkflowOption.optional(),
  reasons: z.array(ReasonLabel),
  latencyMs: z.int().nonnegative(),
  ts: IsoDateTime,
});
export type DecisionRecord = z.infer<typeof DecisionRecord>;
