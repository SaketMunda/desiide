import type { LevelWithSilent } from 'pino';
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from 'vscode-jsonrpc/node';
import { createHost, type Host } from './host.ts';
import { createLogger, type Logger } from './logger.ts';
import { claimStdout } from './stdio.ts';

declare const __DESIIDE_VERSION__: string | undefined;
/** Injected by the bundler; unbundled runs (tests) report the dev version. */
const SERVER_VERSION = typeof __DESIIDE_VERSION__ === 'string' ? __DESIIDE_VERSION__ : '0.0.0-dev';

export interface StartOptions {
  argv: readonly string[];
  /** Where feature modules register their handlers (`host.register(...)`). */
  configure?: (host: Host, ctx: { logger: Logger }) => void;
}

export interface CliArgs {
  logDir?: string;
  logLevel: LevelWithSilent;
}

const LEVELS = new Set<string>(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);

export function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = { logLevel: 'info' };
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i + 1];
    if (argv[i] === '--log-dir' && value) {
      args.logDir = value;
      i++;
    } else if (argv[i] === '--log-level' && value && LEVELS.has(value)) {
      args.logLevel = value as LevelWithSilent;
      i++;
    }
  }
  return args;
}

/** Process entry: wires stdio, logging, the RPC connection and shutdown. */
export function startOrchestrator({ argv, configure }: StartOptions): Host {
  // First, so nothing that runs later can write to the transport.
  const transport = claimStdout();
  const args = parseArgs(argv);
  const { logger, close } = createLogger({ level: args.logLevel, logDir: args.logDir });

  const connection = createMessageConnection(
    new StreamMessageReader(process.stdin),
    new StreamMessageWriter(transport),
  );
  const host = createHost({
    connection,
    logger,
    server: { name: 'desiide-orchestrator', version: SERVER_VERSION },
  });
  configure?.(host, { logger });

  const exit = (reason: string, code: number): void => {
    void host.shutdown(reason).finally(() => {
      close();
      process.exit(code);
    });
  };
  connection.onClose(() => exit('connection closed', 0));
  connection.onError(([err]) => logger.error({ err }, 'rpc transport error'));
  process.stdin.on('end', () => exit('stdin closed', 0));
  process.on('SIGTERM', () => exit('SIGTERM', 0));
  process.on('SIGINT', () => exit('SIGINT', 0));
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaught exception');
    exit('uncaught exception', 1);
  });
  process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandled rejection'));

  connection.listen();
  logger.info({ pid: process.pid }, 'orchestrator started');
  return host;
}
