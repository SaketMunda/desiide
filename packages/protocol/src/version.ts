import * as z from 'zod';

/** Semver of the wire protocol. Bump major only for breaking changes (needs an ADR, see ADR-010). */
export const PROTOCOL_VERSION = '1.0.0';

export const SemVer = z.string().regex(/^\d+\.\d+\.\d+$/, 'expected semver like 1.2.3');
export type SemVer = z.infer<typeof SemVer>;

export type ProtocolCompatibility =
  { ok: true } | { ok: false; reason: 'major_mismatch' | 'invalid_version'; message: string };

/**
 * Peers with the same major are compatible: minors only add optional fields, methods and event
 * types, which both sides tolerate.
 */
export function checkProtocolCompatibility(local: string, remote: string): ProtocolCompatibility {
  if (!SemVer.safeParse(local).success || !SemVer.safeParse(remote).success) {
    return {
      ok: false,
      reason: 'invalid_version',
      message: `Invalid protocol version (local "${local}", remote "${remote}").`,
    };
  }
  const localMajor = local.split('.')[0];
  const remoteMajor = remote.split('.')[0];
  if (localMajor !== remoteMajor) {
    return {
      ok: false,
      reason: 'major_mismatch',
      message: `Protocol mismatch: extension speaks ${remote}, orchestrator speaks ${local}. Update Mutt so both sides match.`,
    };
  }
  return { ok: true };
}
