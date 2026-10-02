import { RpcErrorCode } from '@desiide/protocol';
import { ErrorCodes, ResponseError } from 'vscode-jsonrpc/node';
import type { Host } from '../host/host.ts';
import {
  ApprovalNotFoundError,
  InvalidReportError,
  TaskNotFoundError,
  type TaskManager,
} from './taskManager.ts';

function rpcError(err: unknown): unknown {
  if (err instanceof TaskNotFoundError)
    return new ResponseError(RpcErrorCode.TaskNotFound, err.message);
  if (err instanceof ApprovalNotFoundError) {
    return new ResponseError(RpcErrorCode.ApprovalNotFound, err.message);
  }
  if (err instanceof InvalidReportError)
    return new ResponseError(ErrorCodes.InvalidParams, err.message);
  return err;
}

function mapErrors<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    throw rpcError(err);
  }
}

/** `task.*` and `edits.report`. Tasks are cancelled on shutdown. */
export function registerTaskHandlers(host: Host, tasks: TaskManager): void {
  host.register('task.create', (input) => ({ task: tasks.create(input) }));
  host.register('task.cancel', ({ taskId }) => ({
    cancelled: mapErrors(() => tasks.cancel(taskId)),
  }));
  host.register('task.list', () => ({ tasks: tasks.list() }));
  host.register('task.approve', ({ taskId, approvalId, scope }) => {
    mapErrors(() => tasks.approve(taskId, approvalId, scope));
    return { ok: true };
  });
  host.register('task.reject', ({ taskId, approvalId, reason }) => {
    mapErrors(() => tasks.reject(taskId, approvalId, reason));
    return { ok: true };
  });
  host.register('edits.report', ({ taskId, proposalId, files }) => {
    mapErrors(() => tasks.reportEdits(taskId, proposalId, files));
    return { ok: true };
  });
  host.onShutdown(() => tasks.cancelAll('orchestrator shutting down'));
}
