import type { OrchestratorStatus } from './client.ts';

export const RESTART_ACTION = 'Restart Orchestrator';
export const SHOW_LOG_ACTION = 'Show Log';

export interface StatusNotice {
  message: string;
  actions: string[];
}

/** The user-facing error for a status, or nothing when the status needs no attention. */
export function statusNotice(status: OrchestratorStatus): StatusNotice | undefined {
  if (status.state !== 'failed') return undefined;
  if (status.reason === 'protocol_mismatch') {
    // Restarting the same bundle can't fix a version mismatch, so don't offer it.
    return { message: status.message, actions: [SHOW_LOG_ACTION] };
  }
  return { message: status.message, actions: [RESTART_ACTION, SHOW_LOG_ACTION] };
}

/** `secret:<name>` → the SecretStorage key `<name>`. */
export function secretStorageKey(ref: string): string {
  return ref.startsWith('secret:') ? ref.slice('secret:'.length) : ref;
}
