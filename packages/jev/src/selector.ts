import { JevResult, type JevConfig } from '@desiide/protocol';
import {
  JevRequestError,
  type ChoiceRequest,
  type FallbackReason,
  type JevAnswer,
  type JevEngine,
  type JevRequest,
} from './types.ts';

/** Skill: Jev decision p95 < 1.5 s, else fall back to rules for that call. */
export const DEFAULT_JEV_TIMEOUT_MS = 1500;
/** After a failure, skip Jev for this long instead of paying the timeout on every call. */
export const DEFAULT_UNHEALTHY_COOLDOWN_MS = 30_000;

export interface EngineSelectorOptions {
  rules: JevEngine;
  /** The TypeSafe engine (JEV-3). Absent until it exists or is constructed. */
  jev?: JevEngine;
  config: Pick<JevConfig, 'enabled' | 'endpoint'>;
  timeoutMs?: number;
  cooldownMs?: number;
  now?: () => number;
}

export type EngineStatus =
  { engine: 'jev' } | { engine: 'rules'; reason: 'not_configured' | 'unhealthy' };

export interface EngineSelector extends JevEngine {
  readonly kind: 'jev' | 'rules';
  /** Which engine the next call will try first, and why. */
  status(): EngineStatus;
  /** Returns the Jev engine when configured and healthy, else the rules engine. */
  select(): JevEngine;
  /** Swap config or the Jev engine on `config.update` without rebuilding callers. */
  update(next: { config?: EngineSelectorOptions['config']; jev?: JevEngine | null }): void;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

/**
 * Routes every question to Jev when it's configured and healthy, otherwise to rules. A Jev
 * failure or timeout falls back to rules *for that call* and marks Jev unhealthy for a cooldown.
 * Each answer carries the engine that produced it, plus `fallbackReason` when it fell back.
 */
export function createEngineSelector(options: EngineSelectorOptions): EngineSelector {
  const timeoutMs = options.timeoutMs ?? DEFAULT_JEV_TIMEOUT_MS;
  const cooldownMs = options.cooldownMs ?? DEFAULT_UNHEALTHY_COOLDOWN_MS;
  const now = options.now ?? Date.now;
  const { rules } = options;
  let jev = options.jev;
  let config = options.config;
  let unhealthyUntil = 0;

  const status = (): EngineStatus => {
    if (!jev || !config.enabled || !config.endpoint) {
      return { engine: 'rules', reason: 'not_configured' };
    }
    if (now() < unhealthyUntil) return { engine: 'rules', reason: 'unhealthy' };
    return { engine: 'jev' };
  };

  async function run<R extends JevResult>(
    kind: R['kind'],
    ask: (engine: JevEngine, signal?: AbortSignal) => Promise<JevAnswer<R>>,
    signal?: AbortSignal,
  ): Promise<JevAnswer<R>> {
    signal?.throwIfAborted();
    const current = status();
    if (current.engine === 'rules' || !jev) {
      const answer = await ask(rules, signal);
      return current.engine === 'rules' && current.reason === 'unhealthy'
        ? { ...answer, fallbackReason: 'jev_unavailable' }
        : answer;
    }
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let reason: FallbackReason;
    try {
      const answer = await ask(jev, combined);
      // JEV-3 validates the wire format; this guards any engine against a malformed answer.
      const parsed = JevResult.safeParse(answer.result);
      if (parsed.success && parsed.data.kind === kind) {
        unhealthyUntil = 0;
        return { ...answer, engine: 'jev' };
      }
      reason = 'jev_error';
    } catch (error) {
      // The caller cancelling is not a Jev failure, and a bad request is a caller bug.
      if (signal?.aborted || error instanceof JevRequestError) throw error;
      reason = timeout.aborted || isAbort(error) ? 'jev_timeout' : 'jev_error';
    }
    unhealthyUntil = now() + cooldownMs;
    const answer = await ask(rules, signal);
    return { ...answer, fallbackReason: reason };
  }

  return {
    get kind() {
      return status().engine;
    },
    status,
    select: () => (status().engine === 'jev' && jev ? jev : rules),
    update(next) {
      if (next.config) config = next.config;
      if (next.jev !== undefined) jev = next.jev ?? undefined;
      unhealthyUntil = 0;
    },
    choice: (request: ChoiceRequest, signal?: AbortSignal) =>
      run('choice', (e, s) => e.choice(request, s), signal),
    score: (request: JevRequest, signal?: AbortSignal) =>
      run('score', (e, s) => e.score(request, s), signal),
    noul: (request: JevRequest, signal?: AbortSignal) =>
      run('noul', (e, s) => e.noul(request, s), signal),
  };
}
