import pino, { type LevelWithSilent, type Logger } from 'pino';
import { RotatingFile } from './rotatingFile.ts';

export type { Logger } from 'pino';

export interface LoggerOptions {
  level?: LevelWithSilent;
  /** The extension's log dir. When set, logs also go to a rotating `orchestrator.log` there. */
  logDir?: string | undefined;
  /** Defaults to fd 2. stdout is never a log destination: it carries RPC frames only. */
  stderr?: { write(line: string): unknown };
}

export interface HostLogger {
  logger: Logger;
  close(): void;
}

/** Never log secret values, even by accident (e.g. a whole `secrets.get` result). */
const REDACT = ['value', '*.value', 'apiKey', '*.apiKey', 'authorization', '*.authorization'];

export function createLogger({ level = 'info', logDir, stderr }: LoggerOptions = {}): HostLogger {
  const file = logDir ? new RotatingFile({ dir: logDir }) : undefined;
  // Streams accept everything; the logger's own level does the filtering.
  const streams: pino.StreamEntry[] = [
    { level: 'trace', stream: stderr ?? pino.destination({ fd: 2, sync: true }) },
  ];
  if (file) streams.push({ level: 'trace', stream: { write: (line: string) => file.write(line) } });

  const logger = pino(
    { level, base: { name: 'orchestrator' }, redact: { paths: REDACT, censor: '[redacted]' } },
    pino.multistream(streams),
  );
  return { logger, close: () => file?.close() };
}
