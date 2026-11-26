import { randomBytes } from 'node:crypto';

export const REDACT_SALT_KEY = 'desiide.jev.redactSalt';
/** 32 random bytes, hex: never derived from the workspace path, which could be guessed. */
const SALT_BYTES = 32;

export interface SaltStore {
  get(key: string): unknown;
  update(key: string, value: unknown): PromiseLike<void>;
}

const isSalt = (v: unknown): v is string =>
  typeof v === 'string' && new RegExp(`^[0-9a-f]{${SALT_BYTES * 2}}$`).test(v);

/**
 * The workspace's path-redaction salt, created on first use and kept in `workspaceState`, so
 * hashes stay stable within a workspace and differ across workspaces.
 */
export function ensureRedactSalt(
  store: SaltStore,
  random: () => string = () => randomBytes(SALT_BYTES).toString('hex'),
): string {
  const existing = store.get(REDACT_SALT_KEY);
  if (isSalt(existing)) return existing;
  const salt = random();
  void store.update(REDACT_SALT_KEY, salt);
  return salt;
}
