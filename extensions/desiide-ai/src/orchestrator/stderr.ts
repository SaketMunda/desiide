import type { Logger } from '../log.ts';

type Level = keyof Logger;

/** Shown by the output channel already, or noise there. */
const PINO_BASE_KEYS = new Set(['level', 'msg', 'time', 'pid', 'hostname', 'name']);

/** pino numeric levels → output channel levels. */
function levelOf(n: unknown): Level {
  if (typeof n !== 'number') return 'info';
  if (n >= 50) return 'error';
  if (n >= 40) return 'warn';
  if (n >= 30) return 'info';
  return 'debug';
}

/**
 * Forwards one orchestrator stderr line to the Desiide log. Lines are pino JSON; anything else
 * (redirected console output, crash traces) is passed through as-is.
 */
export function forwardStderrLine(line: string, log: Logger): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  if (trimmed.startsWith('{')) {
    try {
      const entry = JSON.parse(trimmed) as Record<string, unknown>;
      if (typeof entry.msg === 'string') {
        const rest = Object.fromEntries(
          Object.entries(entry).filter(([key]) => !PINO_BASE_KEYS.has(key)),
        );
        const fields = Object.keys(rest).length > 0 ? ` ${JSON.stringify(rest)}` : '';
        log[levelOf(entry.level)](`[orchestrator] ${entry.msg}${fields}`);
        return;
      }
    } catch {
      // Not JSON after all: fall through.
    }
  }
  log.info(`[orchestrator] ${trimmed}`);
}
