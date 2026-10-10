import type { WebviewCommand } from '../../shared/messages.ts';

export interface ErrorAction {
  label: string;
  /** A host command, or `retry` (re-create the task). */
  run: { command: WebviewCommand } | { retry: true };
}

export interface ErrorView {
  title: string;
  /** What to do about it, in one line. */
  hint: string;
  action?: ErrorAction;
  /** Show a "retry in Ns" countdown (rate limits). */
  countdownMs?: number;
}

const SETTINGS: ErrorAction = { label: 'Open model setup', run: { command: 'desiide.setup' } };
const RETRY: ErrorAction = { label: 'Retry', run: { retry: true } };
const LOG: ErrorAction = { label: 'Show log', run: { command: 'desiide.showLog' } };

/**
 * Maps an `error` event's kind (a `ModelErrorKind` or a task failure reason, see
 * docs/protocol.md → Task lifecycle) to something the user can act on. The event's own message
 * is shown under it, since it carries specifics such as the settings hint.
 */
export function errorView(kind: string, retryAfterMs?: number): ErrorView {
  const base = kind.startsWith('model_error:') ? kind.slice('model_error:'.length) : kind;
  if (base.startsWith('budget:')) {
    const limit = base.slice('budget:'.length);
    return {
      title: 'Budget reached',
      hint: `The task hit its ${BUDGETS[limit] ?? limit} limit. Retry, or split the task into smaller steps.`,
      action: RETRY,
    };
  }
  switch (base) {
    case 'auth':
      return {
        title: 'The model rejected the API key',
        hint: 'Check your key in Settings.',
        action: SETTINGS,
      };
    case 'rate_limit':
      return {
        title: 'Rate limited by the provider',
        hint:
          retryAfterMs === undefined
            ? 'Wait a moment, then retry.'
            : 'The provider asked to wait before retrying.',
        action: RETRY,
        ...(retryAfterMs === undefined ? {} : { countdownMs: retryAfterMs }),
      };
    case 'context_length':
      return {
        title: 'Too much context for this model',
        hint: 'Attach fewer files, or use a model with a larger context window.',
        action: RETRY,
      };
    case 'network':
      return {
        title: "Couldn't reach the model",
        hint: "Check your connection and the model's base URL.",
        action: RETRY,
      };
    case 'timeout':
      return {
        title: 'The model timed out',
        hint: 'Retry; local models may need a moment to load.',
        action: RETRY,
      };
    case 'server':
      return {
        title: 'The provider had an error',
        hint: 'Usually temporary. Retry in a moment.',
        action: RETRY,
      };
    case 'bad_request':
      return {
        title: 'The provider refused the request',
        hint: "Check the model's settings (model name, parameters).",
        action: SETTINGS,
      };
    case 'model_unavailable':
      return {
        title: 'No model for this task',
        hint: 'Assign a model to the role in Settings.',
        action: SETTINGS,
      };
    case 'loop_detected':
      return {
        title: 'Stopped a loop',
        hint: 'The model repeated the same call three times. Retry with a more specific prompt.',
        action: RETRY,
      };
    case 'verification_rejected':
      return {
        title: 'Check rejected',
        hint: 'You declined the test or lint run, so the task ended.',
      };
    case 'verification_blocked':
      return { title: 'Check blocked by policy', hint: 'Policy refused the test or lint command.' };
    case 'no_check_command':
      return {
        title: 'No test or lint command',
        hint: 'Set testCommand / lintCommand in .desiide/project.json.',
      };
    case 'ripgrep_missing':
      return {
        title: 'Search is unavailable',
        hint: 'Desiide could not find ripgrep. Restart Desiide, or set DESIIDE_RG_PATH.',
        action: LOG,
      };
    case 'no_workspace':
      return { title: 'No folder open', hint: 'Open a folder, then retry.', action: RETRY };
    case 'cancelled':
      return { title: 'Cancelled', hint: 'The request was cancelled.' };
    case 'internal_error':
      return {
        title: 'Something went wrong in Desiide',
        hint: 'Details are in the log.',
        action: LOG,
      };
    default:
      return { title: 'The task hit an error', hint: 'Details are in the log.', action: LOG };
  }
}

const BUDGETS: Record<string, string> = {
  maxIterations: 'fix-attempt',
  maxToolCalls: 'tool-call',
  maxTokens: 'token',
  wallClockMs: 'time',
};

/** Seconds left of a `retryAfterMs` that started at `ts`, never negative. */
export function secondsLeft(ts: string, retryAfterMs: number, now: number): number {
  const end = Date.parse(ts) + retryAfterMs;
  return Math.max(0, Math.ceil((end - now) / 1000));
}
