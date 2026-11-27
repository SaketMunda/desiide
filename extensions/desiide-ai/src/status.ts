export interface StatusState {
  workflow?: string;
  model?: string;
  runningTasks: number;
  /** Approvals and reviews waiting for the user (UI-4). */
  pending?: number;
}

export interface StatusView {
  text: string;
  tooltip: string;
  /** Show the item in the "needs you" (warning) colors. */
  highlight: boolean;
}

/** Pure formatter for the status bar item; wiring lives in `extension.ts`. */
export function formatStatus(s: StatusState): StatusView {
  const route = [s.workflow, s.model].filter(Boolean).join(' · ');
  const running = s.runningTasks > 0 ? ` $(sync~spin) ${s.runningTasks}` : '';
  const pending = s.pending ?? 0;
  const waiting = pending > 0 ? ` $(bell-dot) ${pending}` : '';
  const text = `$(sparkle) ${route || 'Desiide'}${running}${waiting}`;
  const tasks =
    s.runningTasks === 0
      ? 'No tasks running'
      : `${s.runningTasks} task${s.runningTasks === 1 ? '' : 's'} running`;
  const tooltip = [
    route ? `Desiide: ${route}` : 'Desiide',
    tasks,
    ...(pending > 0 ? [`${pending} waiting for you (review or approval)`] : []),
    'Click to open the Desiide view',
  ].join('\n');
  return { text, tooltip, highlight: pending > 0 };
}
