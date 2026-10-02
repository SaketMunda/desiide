import type { DesiideConfig } from '@desiide/protocol';
import type { Host } from '../host/host.ts';

/** A feature that reacts to the settings snapshot (models, Jev, gating). Must not throw. */
export type ConfigListener = (config: DesiideConfig) => void;

/**
 * `config.update` has a single handler, so every feature that needs settings subscribes here
 * (MOD-1 models now, JEV-* next) instead of registering the method itself.
 */
export function registerConfigUpdate(host: Host, listeners: readonly ConfigListener[]): void {
  host.register('config.update', (config) => {
    for (const listener of listeners) listener(config);
    return { ok: true };
  });
}
