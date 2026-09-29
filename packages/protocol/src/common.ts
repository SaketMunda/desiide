import { z } from 'zod';

export const Id = z.string().min(1).max(128);
export type Id = z.infer<typeof Id>;

export const IsoDateTime = z.iso.datetime({ offset: true });
export type IsoDateTime = z.infer<typeof IsoDateTime>;

/** Workspace-relative POSIX path. Absolute paths and `..` are rejected at the boundary. */
export const WorkspacePath = z
  .string()
  .min(1)
  .max(4096)
  .refine((p) => !p.startsWith('/') && !/^[a-zA-Z]:[\\/]/.test(p), 'must be workspace-relative')
  .refine((p) => !p.split(/[\\/]/).includes('..'), 'must not contain ".."');
export type WorkspacePath = z.infer<typeof WorkspacePath>;

/** Zero-based, like VS Code's `Position`. */
export const Position = z.strictObject({
  line: z.int().nonnegative(),
  character: z.int().nonnegative(),
});
export type Position = z.infer<typeof Position>;

export const Range = z.strictObject({ start: Position, end: Position });
export type Range = z.infer<typeof Range>;

/** Reference to a key in VS Code SecretStorage. The value itself never crosses into config. */
export const SecretRef = z
  .string()
  .regex(/^secret:[A-Za-z0-9._-]{1,128}$/, 'expected secret:<name>');
export type SecretRef = z.infer<typeof SecretRef>;

export const Ack = z.object({ ok: z.literal(true) });
export type Ack = z.infer<typeof Ack>;

export const Empty = z.strictObject({});
export type Empty = z.infer<typeof Empty>;
