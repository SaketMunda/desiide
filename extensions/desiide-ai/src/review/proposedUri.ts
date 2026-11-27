/**
 * `desiide-proposed:` URIs name one file of one proposal: the path keeps the file name (so the diff
 * editor picks the right language), the query says which proposal. Pure string code, no `vscode`.
 */
export const PROPOSED_SCHEME = 'desiide-proposed';

export interface ProposedRef {
  taskId: string;
  proposalId: string;
  /** Workspace-relative. */
  path: string;
}

export function proposedUriParts(ref: ProposedRef): { path: string; query: string } {
  return {
    path: `/${ref.path}`,
    query: new URLSearchParams({ task: ref.taskId, proposal: ref.proposalId }).toString(),
  };
}

export function parseProposedUri(uri: { path: string; query: string }): ProposedRef | undefined {
  const q = new URLSearchParams(uri.query);
  const taskId = q.get('task');
  const proposalId = q.get('proposal');
  const path = uri.path.replace(/^\/+/, '');
  if (!taskId || !proposalId || !path) return undefined;
  return { taskId, proposalId, path };
}
