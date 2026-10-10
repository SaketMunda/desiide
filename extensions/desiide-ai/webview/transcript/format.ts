import type { TaskState, ToolCall, WorkflowOption } from '@desiide/protocol';
import type { ToolStatus } from '../../shared/transcript/model.ts';
import type { Tone } from '../ui/index.ts';

const MAX_SUMMARY = 80;

const clip = (s: string, max = MAX_SUMMARY): string => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

/** The collapsed tool card's one-line argument summary (COR-3 argument shapes). */
export function summarizeArgs(call: ToolCall | undefined): string {
  if (!call) return '';
  const a = call.args;
  switch (call.tool) {
    case 'read_file': {
      const path = str(a['path']) ?? '';
      const start = num(a['startLine']);
      const end = num(a['endLine']);
      return clip(start || end ? `${path}:${start ?? 1}-${end ?? ''}` : path);
    }
    case 'list_files':
      return clip(str(a['path']) ?? '.');
    case 'search': {
      const where = str(a['path']);
      return clip(`"${str(a['query']) ?? ''}"${where && where !== '.' ? ` in ${where}` : ''}`);
    }
    case 'propose_edit': {
      const files = Array.isArray(a['files']) ? (a['files'] as unknown[]) : [];
      const paths = files.flatMap((f) =>
        typeof f === 'object' && f !== null
          ? (str((f as Record<string, unknown>)['path']) ?? [])
          : [],
      );
      return clip(paths.length <= 2 ? paths.join(', ') : `${paths.length} files`);
    }
    case 'shell':
      return clip(str(a['command']) ?? '');
    case 'git_read':
      return clip(
        ['git', str(a['command']), str(a['ref']), str(a['path'])].filter(Boolean).join(' '),
      );
    case 'run_tests':
    case 'lint':
      return '';
    default:
      return clip(Object.values(a).find((v) => typeof v === 'string') ?? '');
  }
}

export const TOOL_ICONS: Record<string, string> = {
  read_file: 'file',
  list_files: 'list-tree',
  search: 'search',
  propose_edit: 'edit',
  shell: 'terminal',
  run_tests: 'beaker',
  lint: 'checklist',
  git_read: 'git-commit',
};

export const TOOL_LABELS: Record<string, string> = {
  read_file: 'Read',
  list_files: 'List files',
  search: 'Search',
  propose_edit: 'Propose edit',
  shell: 'Run',
  run_tests: 'Run tests',
  lint: 'Lint',
  git_read: 'Git',
};

export const TOOL_STATUS: Record<ToolStatus, { label: string; tone: Tone; icon: string }> = {
  running: { label: 'running', tone: 'ai', icon: 'loading' },
  awaiting_approval: { label: 'awaiting approval', tone: 'confirm', icon: 'question' },
  ok: { label: 'done', tone: 'auto', icon: 'check' },
  failed: { label: 'failed', tone: 'block', icon: 'error' },
  blocked: { label: 'blocked', tone: 'block', icon: 'circle-slash' },
  rejected: { label: 'rejected', tone: 'confirm', icon: 'circle-slash' },
  invalid_args: { label: 'invalid args', tone: 'block', icon: 'error' },
  timeout: { label: 'timed out', tone: 'block', icon: 'watch' },
  cancelled: { label: 'cancelled', tone: 'neutral', icon: 'circle-slash' },
};

export const STATE_LABELS: Record<TaskState, { label: string; tone: Tone }> = {
  queued: { label: 'Queued', tone: 'neutral' },
  planning: { label: 'Planning', tone: 'ai' },
  running: { label: 'Running', tone: 'ai' },
  awaiting_approval: { label: 'Needs you', tone: 'confirm' },
  verifying: { label: 'Verifying', tone: 'ai' },
  done: { label: 'Done', tone: 'auto' },
  failed: { label: 'Failed', tone: 'block' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

export const WORKFLOW_NAMES: Record<WorkflowOption, string> = {
  'local-single': 'local',
  'cloud-single': 'cloud',
  'local-cloud-cascade': 'cascade',
  'cloud-with-critique': 'critique',
};

/** `1234` → `1.2k`, `2500000` → `2.5M`. */
export function formatCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** An estimate, so it's shown with ~ and a sensible number of digits. */
export function formatCost(usd: number): string {
  if (usd === 0) return '$0';
  if (usd < 0.01) return `~$${usd.toFixed(4)}`;
  if (usd < 1) return `~$${usd.toFixed(3)}`;
  return `~$${usd.toFixed(2)}`;
}

/** `850` → `850 ms`, `12300` → `12.3 s`, `125000` → `2m 5s`. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** The last `lines` lines of a tool's output, for the expanded card. */
export function tail(output: string, lines = 20): { text: string; hidden: number } {
  const all = output.replace(/\n$/, '').split('\n');
  const hidden = Math.max(0, all.length - lines);
  return { text: all.slice(hidden).join('\n'), hidden };
}
