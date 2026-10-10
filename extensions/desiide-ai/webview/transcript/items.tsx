import type { ComponentType } from 'preact';
import { memo } from 'preact/compat';
import { useEffect, useState } from 'preact/hooks';
import type {
  ApprovalItem,
  AssistantItem,
  DecisionItem,
  EditProposalItem,
  ErrorItem,
  StatusItem,
  ToolItem,
  TranscriptItem,
  TranscriptItemKind,
  UserItem,
} from '../../shared/transcript/model.ts';
import { post } from '../bridge.ts';
import { Badge, Button, Chip, Codicon } from '../ui/index.ts';
import { errorView, secondsLeft } from './errors.ts';
import {
  formatDuration,
  STATE_LABELS,
  summarizeArgs,
  tail,
  TOOL_ICONS,
  TOOL_LABELS,
  TOOL_STATUS,
} from './format.ts';
import { Markdown } from './Markdown.tsx';

/** What every item renderer gets. */
export interface ItemProps<T extends TranscriptItem = TranscriptItem> {
  item: T;
  taskId: string;
  /** The task is still running (for live timers, "Thinking…"). */
  live: boolean;
  /** This assistant item is the one receiving text. */
  streaming: boolean;
  retryable: boolean;
  /** Re-create the task (stable across renders). */
  onRetry: () => void;
}

/** Ticks `Date.now()` every `ms` while `active`. */
export function useNow(active: boolean, ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [active, ms]);
  return now;
}

function UserMessage({ item }: ItemProps<UserItem>) {
  return (
    <div class="desiide-turn desiide-turn--user">
      <p class="desiide-turn__user-text">{item.text}</p>
    </div>
  );
}

function Thinking({
  reasoning,
  live,
}: {
  reasoning: NonNullable<AssistantItem['reasoning']>;
  live: boolean;
}) {
  const [open, setOpen] = useState(false);
  const thinking = reasoning.endedAt === undefined && live;
  const now = useNow(thinking);
  const end = reasoning.endedAt ? Date.parse(reasoning.endedAt) : now;
  const elapsed = Math.max(0, end - Date.parse(reasoning.startedAt));
  const id = `thinking-${reasoning.startedAt}`;
  return (
    <div class={`desiide-thinking${thinking ? ' is-live' : ''}`}>
      <button
        type="button"
        class="desiide-thinking__toggle"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        <Codicon name={open ? 'chevron-down' : 'chevron-right'} />
        <span>{thinking ? 'Thinking…' : 'Thought'}</span>
        <span class="desiide-muted">{formatDuration(elapsed)}</span>
      </button>
      {/* Reasoning is plain text, not markdown (ADR-022). */}
      <pre id={id} class="desiide-thinking__text" hidden={!open}>
        {reasoning.text}
      </pre>
    </div>
  );
}

function AssistantMessage({ item, live, streaming }: ItemProps<AssistantItem>) {
  return (
    <div class="desiide-turn desiide-turn--assistant">
      {item.reasoning && <Thinking reasoning={item.reasoning} live={live} />}
      {item.text ? (
        <Markdown text={item.text} />
      ) : (
        streaming && !item.reasoning && <span class="desiide-muted">…</span>
      )}
      {streaming && item.text && <span class="desiide-caret" aria-hidden="true" />}
    </div>
  );
}

const OUTPUT_TAIL_LINES = 20;

function ToolCard({ item, taskId, live }: ItemProps<ToolItem>) {
  const [open, setOpen] = useState(false);
  const status = TOOL_STATUS[item.status];
  const tool = item.call?.tool;
  const running = item.status === 'running' && live;
  const now = useNow(running);
  const duration =
    item.result?.durationMs ?? (running ? now - Date.parse(item.startedAt) : undefined);
  const summary = summarizeArgs(item.call);
  const out = item.result ? tail(item.result.output, OUTPUT_TAIL_LINES) : undefined;
  const bodyId = `tool-${item.callId}`;
  return (
    <div class={`desiide-tool desiide-tone--${status.tone}`}>
      <button
        type="button"
        class="desiide-tool__head"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen(!open)}
      >
        <Codicon name={open ? 'chevron-down' : 'chevron-right'} />
        <Codicon name={(tool && TOOL_ICONS[tool]) ?? 'tools'} />
        <span class="desiide-tool__name">{(tool && TOOL_LABELS[tool]) ?? tool ?? 'Tool call'}</span>
        <span class="desiide-tool__args" title={summary}>
          {summary}
        </span>
        <span class="desiide-tool__status">
          <Codicon name={status.icon} spin={running} />
          <span>{status.label}</span>
          {duration !== undefined && <span class="desiide-muted">{formatDuration(duration)}</span>}
        </span>
      </button>
      <div id={bodyId} class="desiide-tool__body" hidden={!open}>
        {open && (
          <>
            {item.call && (
              <>
                <div class="desiide-tool__label">Arguments</div>
                <pre class="desiide-tool__pre">{JSON.stringify(item.call.args, null, 2)}</pre>
              </>
            )}
            {item.result?.error && (
              <p class="desiide-tool__error">
                {item.result.error.message}
                {item.result.error.reasons.length > 0 && (
                  <span class="desiide-muted"> ({item.result.error.reasons.join(', ')})</span>
                )}
              </p>
            )}
            {out && (
              <>
                <div class="desiide-tool__label">
                  Output
                  {(out.hidden > 0 || item.result?.truncated) && (
                    <span class="desiide-muted"> · last {OUTPUT_TAIL_LINES} lines</span>
                  )}
                  {item.result?.exitCode !== undefined && (
                    <span class="desiide-muted"> · exit {item.result.exitCode}</span>
                  )}
                </div>
                <pre class="desiide-tool__pre">{out.text || '(no output)'}</pre>
                <Button
                  variant="ghost"
                  icon="output"
                  onClick={() => post({ type: 'tool.openOutput', taskId, callId: item.callId })}
                >
                  Open full output
                </Button>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** UI-4 replaces this with the diff review. */
function EditProposalPlaceholder({ item }: ItemProps<EditProposalItem>) {
  const paths = item.proposal.files.map((f) => f.path);
  return (
    <div class="desiide-slot" data-slot="edit_proposal">
      <Codicon name="diff" />
      <span>Edit proposed: {paths.length === 1 ? paths[0] : `${paths.length} files`}</span>
      <Badge tone="confirm">review</Badge>
    </div>
  );
}

const RESOLUTION: Record<NonNullable<ApprovalItem['resolution']>, string> = {
  approved: 'approved',
  rejected: 'rejected',
  blocked: 'blocked',
  cancelled: 'cancelled',
};

/** UI-4 replaces this with the approval card (approve / reject). */
function ApprovalPlaceholder({ item }: ItemProps<ApprovalItem>) {
  return (
    <div class="desiide-slot" data-slot="approval">
      <Codicon name="shield" />
      <span>
        Approval needed: {TOOL_LABELS[item.call.tool] ?? item.call.tool}{' '}
        <code>{summarizeArgs(item.call)}</code>
      </span>
      <Badge tone={item.resolution ? 'neutral' : 'confirm'}>
        {item.resolution ? RESOLUTION[item.resolution] : 'waiting'}
      </Badge>
    </div>
  );
}

/** UI-5 replaces this with the inline decision chip and its panel link. */
function DecisionPlaceholder({ item }: ItemProps<DecisionItem>) {
  const first = item.decisions[0];
  if (!first) return null;
  const pack = first.pack.split('@')[0] ?? first.pack;
  const outcome = first.policyOutcome ?? first.workflow;
  const tone = first.policyOutcome ?? 'jev';
  return (
    <div class="desiide-slot desiide-slot--chip" data-slot="decision">
      <Chip
        tone={tone === 'auto' || tone === 'confirm' || tone === 'block' ? tone : 'jev'}
        icon="law"
      >
        {first.engine === 'rules' ? 'rules' : 'Jev'} · {pack.replace('_', ' ')}
        {outcome ? ` → ${outcome}` : ''}
      </Chip>
    </div>
  );
}

function ErrorCard({ item, retryable, live, onRetry }: ItemProps<ErrorItem>) {
  const view = errorView(item.errorKind, item.retryAfterMs);
  const counting = view.countdownMs !== undefined;
  const now = useNow(counting);
  const left = counting ? secondsLeft(item.ts, view.countdownMs ?? 0, now) : 0;
  const action = view.action;
  const showAction = action && ('command' in action.run || (retryable && !live));
  return (
    <div class="desiide-error" role="alert">
      <div class="desiide-error__title">
        <Codicon name="error" />
        <span>{view.title}</span>
      </div>
      <p class="desiide-error__hint">{view.hint}</p>
      <p class="desiide-error__message">{item.message}</p>
      {showAction && (
        <Button
          variant="secondary"
          disabled={left > 0}
          onClick={() =>
            'command' in action.run
              ? post({ type: 'command', command: action.run.command })
              : onRetry()
          }
        >
          {left > 0 ? `${action.label} in ${left}s` : action.label}
        </Button>
      )}
    </div>
  );
}

function StatusLine({ item }: ItemProps<StatusItem>) {
  const state = STATE_LABELS[item.state];
  return (
    <div class="desiide-status-line">
      <Badge tone={state.tone}>{state.label}</Badge>
      {item.reason && item.state !== 'done' && <span class="desiide-muted">{item.reason}</span>}
    </div>
  );
}

type Renderers = {
  [K in TranscriptItemKind]: ComponentType<ItemProps<Extract<TranscriptItem, { kind: K }>>>;
};

/**
 * Item renderers by kind. UI-4 (edit_proposal, approval) and UI-5 (decision) replace their
 * placeholders here, e.g. `ITEM_RENDERERS.approval = ApprovalCard`.
 */
export const ITEM_RENDERERS: Renderers = {
  user: UserMessage,
  assistant: AssistantMessage,
  tool: ToolCard,
  edit_proposal: EditProposalPlaceholder,
  approval: ApprovalPlaceholder,
  decision: DecisionPlaceholder,
  error: ErrorCard,
  status: StatusLine,
};

/** One transcript row; skipped on re-render when its item and flags didn't change. */
export const TranscriptRow = memo(function TranscriptRow(props: ItemProps) {
  const Renderer = ITEM_RENDERERS[props.item.kind] as ComponentType<ItemProps>;
  return <Renderer {...props} />;
});
