export interface RestartPolicyOptions {
  /** Restarts allowed inside `windowMs` before giving up. */
  maxRestarts?: number;
  windowMs?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export type RestartDecision =
  { restart: true; attempt: number; delayMs: number } | { restart: false };

/**
 * Crash-loop guard: at most `maxRestarts` automatic restarts in a sliding `windowMs`, with
 * exponential backoff. A manual restart calls `reset()`.
 */
export class RestartPolicy {
  private crashes: number[] = [];
  private readonly maxRestarts: number;
  private readonly windowMs: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;

  constructor({
    maxRestarts = 3,
    windowMs = 60_000,
    baseDelayMs = 250,
    maxDelayMs = 4_000,
  }: RestartPolicyOptions = {}) {
    this.maxRestarts = maxRestarts;
    this.windowMs = windowMs;
    this.baseDelayMs = baseDelayMs;
    this.maxDelayMs = maxDelayMs;
  }

  onCrash(now: number): RestartDecision {
    this.crashes = this.crashes.filter((t) => now - t < this.windowMs);
    this.crashes.push(now);
    const attempt = this.crashes.length;
    if (attempt > this.maxRestarts) return { restart: false };
    const delayMs = Math.min(this.baseDelayMs * 2 ** (attempt - 1), this.maxDelayMs);
    return { restart: true, attempt, delayMs };
  }

  reset(): void {
    this.crashes = [];
  }
}
