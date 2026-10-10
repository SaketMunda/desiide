import {
  DECISION_LOG_DIR,
  InvalidCursorError,
  ReplayError,
  createDecisionLog,
  replayDecision,
  type DecisionLog,
  type ReplayOptions,
} from '@desiide/jev';
import type { DecisionRecord } from '@desiide/protocol';
import { join } from 'node:path';
import { ErrorCodes, ResponseError } from 'vscode-jsonrpc/node';
import type { Host } from '../host/host.ts';
import type { TaskLogger } from '../tasks/taskManager.ts';

export interface DecisionServiceOptions {
  /** Engines and current gating settings for replay. */
  replayOptions(): ReplayOptions;
  /** Emits `decision_made` (`TaskManager.publishDecision`). Must not throw. */
  publish?(record: DecisionRecord): void;
  logger?: TaskLogger;
  maxBytes?: number;
  keep?: number;
}

export interface DecisionService {
  /** The `onDecision` sink: persist, then publish. Never throws; write failures are reported. */
  record(record: DecisionRecord): void;
  /** Resolves when every record so far is on disk (tests, shutdown). */
  flush(): Promise<void>;
}

/**
 * JEV-4 in the orchestrator: every decision goes to `.desiide/logs/decisions.jsonl` in the
 * first workspace folder and out as a `decision_made` event, and `decisions.list` /
 * `decisions.replay` read it back. Without a workspace folder nothing is persisted.
 */
export function createDecisionService(host: Host, opts: DecisionServiceOptions): DecisionService {
  let log: DecisionLog | undefined;
  let logRoot: string | undefined;
  let failing = false;

  const current = (): DecisionLog | undefined => {
    const root = host.session?.workspaceRoots[0];
    if (root === undefined) return undefined;
    if (!log || logRoot !== root) {
      logRoot = root;
      log = createDecisionLog({
        dir: join(root, DECISION_LOG_DIR),
        ...(opts.maxBytes === undefined ? {} : { maxBytes: opts.maxBytes }),
        ...(opts.keep === undefined ? {} : { keep: opts.keep }),
        onInvalidLine: (file, line) =>
          opts.logger?.warn({ file, line }, 'skipped an unreadable decision log line'),
      });
    }
    return log;
  };

  const reportFailure = (err: unknown): void => {
    opts.logger?.error({ err }, 'decision log write failed');
    // Once per failure streak, so a full disk doesn't flood the output channel.
    if (failing) return;
    failing = true;
    const reason = err instanceof Error ? err.message : String(err);
    host
      .notify('log', {
        level: 'warn',
        message: `Desiide couldn't write the decision log (${reason}). Decisions still apply but won't be listed or replayable.`,
        ts: new Date().toISOString(),
      })
      .catch(() => {});
  };

  host.register('decisions.list', async (query) => {
    const target = current();
    if (!target) return { decisions: [] };
    try {
      return await target.list(query);
    } catch (err) {
      if (err instanceof InvalidCursorError) {
        throw new ResponseError(ErrorCodes.InvalidParams, err.message);
      }
      throw err;
    }
  });

  host.register('decisions.replay', async ({ id }, { signal }) => {
    const record = await current()?.get(id);
    if (!record) {
      throw new ResponseError(
        ErrorCodes.InvalidParams,
        `No decision with id "${id}" in the decision log (it may have rotated out)`,
      );
    }
    try {
      return await replayDecision(record, opts.replayOptions(), signal);
    } catch (err) {
      if (err instanceof ReplayError)
        throw new ResponseError(ErrorCodes.InvalidParams, err.message);
      throw err;
    }
  });

  return {
    record(record) {
      const target = current();
      target?.append(record).then(() => {
        failing = false;
      }, reportFailure);
      try {
        opts.publish?.(record);
      } catch (err) {
        opts.logger?.error({ err, decisionId: record.id }, 'decision_made publish failed');
      }
    },
    flush: () => log?.flush() ?? Promise.resolve(),
  };
}
