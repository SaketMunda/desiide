import type {
  EditProposal,
  ProjectConfig,
  SideEffect,
  ToolErrorKind,
  ToolName,
} from '@desiide/protocol';
import * as z from 'zod';
import type { EditError } from './proposeEdit.ts';
import type { Workspace } from './paths.ts';

/** Everything a tool may touch. Tools are stateless; the task engine (COR-2) builds this per task. */
export interface ToolContext {
  workspace: Workspace;
  taskId: string;
  projectConfig: ProjectConfig;
  /** Base env for child processes; scrubbed before use. Usually `process.env`. */
  env: NodeJS.ProcessEnv;
  /** Absolute path of the ripgrep binary (see `resolveRgPath`). */
  rgPath: string;
  newId: () => string;
  trackProcessGroup?: (pid: number) => () => void;
  /** Defaults: shell 120 s, run_tests/lint 300 s, read-only helpers (rg, git) 30 s. */
  timeouts?: { shellMs?: number; checksMs?: number; readMs?: number };
}

export interface ToolOutput {
  ok: boolean;
  /** Text the model sees. Already capped. */
  output: string;
  truncated?: boolean;
  exitCode?: number;
  error?: { kind: ToolErrorKind; message: string };
  /** `propose_edit` success: what the review gate (UI-4) shows. */
  proposal?: EditProposal;
  /** `propose_edit` failure: per-block problems, also embedded in `output` for the model. */
  editErrors?: EditError[];
}

/** JSON-Schema tool spec handed to model adapters (MOD-*). */
export interface ToolSpec {
  name: ToolName;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface Tool<S extends z.ZodType = z.ZodType> {
  name: ToolName;
  description: string;
  argsSchema: S;
  spec: ToolSpec;
  sideEffect: SideEffect;
  // Method syntax so a registry of differently-typed tools stays assignable.
  run(args: z.output<S>, ctx: ToolContext, signal: AbortSignal): Promise<ToolOutput>;
}

export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  // `input` so defaulted fields are optional for the model; `$schema` trips some providers.
  const json: Record<string, unknown> = { ...z.toJSONSchema(schema, { io: 'input' }) };
  delete json.$schema;
  return json;
}

export function defineTool<S extends z.ZodType>(def: Omit<Tool<S>, 'spec'>): Tool<S> {
  return {
    ...def,
    spec: {
      name: def.name,
      description: def.description,
      inputSchema: toJsonSchema(def.argsSchema),
    },
  };
}

export function failure(kind: ToolErrorKind, message: string): ToolOutput {
  return { ok: false, output: message, error: { kind, message } };
}

/** Shared path argument; confinement happens at run time (needs the filesystem). */
export const PathArg = z
  .string()
  .min(1)
  .max(4096)
  .describe('Workspace-relative POSIX path, e.g. "src/app.ts". No absolute paths, no "..".');
