import type { OrchestratorClient } from '../orchestrator/client.ts';
import type { ReviewRpc } from './service.ts';

/** UI-4's answers over the orchestrator's RPC (COR-2's `task.approve/reject`, `edits.report`). */
export function orchestratorReviewRpc(client: Pick<OrchestratorClient, 'request'>): ReviewRpc {
  return {
    report: async (taskId, proposalId, files) => {
      await client.request('edits.report', { taskId, proposalId, files });
    },
    approve: async (taskId, approvalId, scope) => {
      await client.request('task.approve', { taskId, approvalId, scope });
    },
    reject: async (taskId, approvalId, reason) => {
      await client.request('task.reject', {
        taskId,
        approvalId,
        ...(reason === undefined ? {} : { reason }),
      });
    },
  };
}
