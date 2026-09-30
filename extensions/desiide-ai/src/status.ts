export interface StatusState {
  workflow?: string;
  model?: string;
  runningTasks: number;
}

export interface StatusView {
  text: string;
  tooltip: string;
}

/** Pure formatter for the status bar item; wiring lives in `extension.ts`. */
export function formatStatus(s: StatusState): StatusView {
  const route = [s.workflow, s.model].filter(Boolean).join(' · ');
  const running = s.runningTasks > 0 ? ` $(sync~spin) ${s.runningTasks}` : '';
  const text = `$(sparkle) ${route || 'Desiide'}${running}`;
  const tasks =
    s.runningTasks === 0
      ? 'No tasks running'
      : `${s.runningTasks} task${s.runningTasks === 1 ? '' : 's'} running`;
  const tooltip = [
    route ? `Desiide: ${route}` : 'Desiide',
    tasks,
    'Click to open the Desiide view',
  ].join('\n');
  return { text, tooltip };
}
