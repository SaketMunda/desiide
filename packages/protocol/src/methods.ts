import * as z from 'zod';
import { Ack, Empty, Id, SecretRef } from './common.ts';
import { MuttConfig } from './config.ts';
import { FileApplyResult } from './edits.ts';
import { TaskEvent, LogNotification } from './events.ts';
import {
  DecisionRecord,
  JevEngineKind,
  JevPackState,
  JevResult,
  KnownPack,
  PackId,
} from './jev.ts';
import { ModelErrorKind, ModelInfo } from './models.ts';
import { PolicyOutcome } from './reasons.ts';
import { TaskInput, TaskSummary } from './task.ts';
import { SemVer } from './version.ts';

/** Requests are strict (unknown params rejected); results are tolerant (unknown fields stripped). */

const TaskRef = z.strictObject({ taskId: Id });

const HealthCheck = z.object({
  ok: z.boolean(),
  latencyMs: z.int().nonnegative().optional(),
  error: z
    .object({ kind: z.string(), message: z.string(), hint: z.string().optional() })
    .optional(),
});

const EngineRun = z.object({
  engine: JevEngineKind,
  result: JevResult,
  policyOutcome: PolicyOutcome.optional(),
  latencyMs: z.int().nonnegative(),
});

/** Extension → orchestrator requests. */
export const ClientMethods = {
  initialize: {
    params: z.strictObject({
      protocolVersion: SemVer,
      client: z.strictObject({ name: z.string().min(1), version: z.string().min(1) }),
      workspaceRoots: z.array(z.string().min(1)).min(1),
    }),
    result: z.object({
      protocolVersion: SemVer,
      server: z.object({ name: z.string(), version: z.string() }),
    }),
  },
  'task.create': { params: TaskInput, result: z.object({ task: TaskSummary }) },
  'task.cancel': { params: TaskRef, result: z.object({ cancelled: z.boolean() }) },
  'task.list': { params: Empty, result: z.object({ tasks: z.array(TaskSummary) }) },
  'task.approve': {
    params: z.strictObject({ taskId: Id, approvalId: Id, scope: z.enum(['once', 'task']) }),
    result: Ack,
  },
  'task.reject': {
    params: z.strictObject({ taskId: Id, approvalId: Id, reason: z.string().max(2000).optional() }),
    result: Ack,
  },
  'edits.report': {
    params: z.strictObject({
      taskId: Id,
      proposalId: Id,
      files: z.array(FileApplyResult).min(1),
    }),
    result: Ack,
  },
  'models.list': {
    params: z.strictObject({ discover: z.boolean().default(false) }),
    result: z.object({
      models: z.array(ModelInfo),
      /** Unconfigured models found locally (e.g. Ollama) when `discover` is set. */
      discovered: z.array(ModelInfo).default([]),
    }),
  },
  'models.test': {
    params: z.strictObject({ modelId: Id }),
    result: HealthCheck.extend({
      error: z
        .object({ kind: ModelErrorKind, message: z.string(), hint: z.string().optional() })
        .optional(),
    }),
  },
  'jev.test': { params: Empty, result: HealthCheck },
  'jev.preview': {
    params: z.strictObject({ pack: KnownPack }),
    result: z.object({ state: JevPackState }),
  },
  'decisions.list': {
    params: z.strictObject({
      taskId: Id.optional(),
      pack: PackId.optional(),
      outcome: PolicyOutcome.optional(),
      limit: z.int().min(1).max(500).default(50),
      cursor: z.string().optional(),
    }),
    result: z.object({ decisions: z.array(DecisionRecord), nextCursor: z.string().optional() }),
  },
  'decisions.replay': {
    params: z.strictObject({ id: Id }),
    result: z.object({
      record: DecisionRecord,
      rules: EngineRun,
      /** Absent when Jev isn't configured; `jevError` explains a failed call. */
      jev: EngineRun.optional(),
      jevError: z.string().optional(),
      differs: z.boolean(),
    }),
  },
  'config.update': { params: MuttConfig, result: Ack },
  'health.ping': {
    params: Empty,
    result: z.object({ ok: z.literal(true), uptimeMs: z.int().nonnegative() }),
  },
} as const;

/** Orchestrator → extension reverse requests. There is no `workspace.applyEdit` (ADR-004). */
export const ServerMethods = {
  'secrets.get': {
    params: z.strictObject({ ref: SecretRef }),
    /** `null` when the secret isn't set; the orchestrator surfaces an actionable error. */
    result: z.object({ value: z.string().nullable() }),
  },
} as const;

/** Orchestrator → extension notifications. */
export const ServerNotifications = {
  'task.event': TaskEvent,
  log: LogNotification,
} as const;

export type ClientMethod = keyof typeof ClientMethods;
export type ServerMethod = keyof typeof ServerMethods;
export type ServerNotification = keyof typeof ServerNotifications;

export type ParamsOf<M extends ClientMethod> = z.infer<(typeof ClientMethods)[M]['params']>;
/** Params as a caller may send them, before defaults are applied. */
export type ParamsInputOf<M extends ClientMethod> = z.input<(typeof ClientMethods)[M]['params']>;
export type ResultOf<M extends ClientMethod> = z.infer<(typeof ClientMethods)[M]['result']>;
export type ServerParamsOf<M extends ServerMethod> = z.infer<(typeof ServerMethods)[M]['params']>;
export type ServerResultOf<M extends ServerMethod> = z.infer<(typeof ServerMethods)[M]['result']>;
export type NotificationOf<N extends ServerNotification> = z.infer<(typeof ServerNotifications)[N]>;

/** JSON-RPC application error codes (-32000..-32099 is the server-defined range). */
export const RpcErrorCode = {
  ProtocolMismatch: -32001,
  NotInitialized: -32002,
  NotImplemented: -32003,
  TaskNotFound: -32004,
  ApprovalNotFound: -32005,
  SecretMissing: -32006,
} as const;
export type RpcErrorCode = (typeof RpcErrorCode)[keyof typeof RpcErrorCode];
