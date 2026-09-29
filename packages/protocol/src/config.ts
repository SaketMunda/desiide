import { z } from 'zod';
import { Id, SecretRef } from './common.ts';
import { ModelConfig } from './models.ts';

/** `.mutt/project.json`. Tolerant: unknown keys are ignored so newer files still load. */
export const ProjectConfig = z.object({
  testCommand: z.string().min(1).max(1000).optional(),
  lintCommand: z.string().min(1).max(1000).optional(),
  sensitiveGlobs: z.array(z.string().min(1)).optional(),
  ignoreGlobs: z.array(z.string().min(1)).optional(),
});
export type ProjectConfig = z.infer<typeof ProjectConfig>;

export const RolesConfig = z.strictObject({
  cheap: Id.optional(),
  strong: Id.optional(),
  reviewer: Id.optional(),
});
export type RolesConfig = z.infer<typeof RolesConfig>;

export const JevConfig = z.strictObject({
  /** Off until the user configures it (ADR-005). */
  enabled: z.boolean().default(false),
  endpoint: z.url().optional(),
  apiKey: SecretRef.optional(),
  redactPaths: z.boolean().default(false),
});
export type JevConfig = z.infer<typeof JevConfig>;

export const GatingConfig = z.strictObject({
  /** No permissive mode in Alpha (ADR-006). */
  mode: z.enum(['conservative', 'strict']).default('conservative'),
  /** Threshold overrides by name; JEV-2 rejects any that loosen the defaults. */
  thresholds: z.record(z.string(), z.number()).default({}),
});
export type GatingConfig = z.infer<typeof GatingConfig>;

/** The full `mutt.*` settings snapshot the extension pushes with `config.update`. */
export const MuttConfig = z.strictObject({
  models: z.array(ModelConfig).default([]),
  roles: RolesConfig.prefault({}),
  jev: JevConfig.prefault({}),
  gating: GatingConfig.prefault({}),
});
export type MuttConfig = z.infer<typeof MuttConfig>;
export type MuttConfigInput = z.input<typeof MuttConfig>;
