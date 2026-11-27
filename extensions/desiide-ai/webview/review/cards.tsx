import type { JSX } from 'preact';
import { useContext, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ApprovalAnswer } from '../../shared/review/model.ts';
import { reviewKey } from '../../shared/review/model.ts';
import type { ApprovalItem, EditProposalItem, ToolItem } from '../../shared/transcript/model.ts';
import { post } from '../bridge.ts';
import type { ItemProps } from '../transcript/items.tsx';
import {
  Badge,
  BlockedNote,
  Button,
  Codicon,
  DecisionChip,
  NeedsYou,
  summarizeDecision,
} from '../ui/index.ts';
import { TaskViewContext, useReview } from './store.ts';
import {
  applyLabel,
  approvalCardView,
  blockedCardView,
  cardKey,
  proposalCardView,
  type ApprovalStatus,
  type BlockedCardView,
  type ReasonView,
} from './view.ts';

const MOD =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';

const inField = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA');

function onCardKey(
  e: JSX.TargetedKeyboardEvent<HTMLElement>,
  handlers: { approve: () => void; reject: () => void },
): void {
  const action = cardKey({
    key: e.key,
    metaKey: e.metaKey,
    ctrlKey: e.ctrlKey,
    inField: inField(e.target),
  });
  if (!action) return;
  e.preventDefault();
  e.stopPropagation();
  handlers[action]();
}

function Reasons({ reasons }: { reasons: ReasonView[] }) {
  if (reasons.length === 0) return null;
  return (
    <ul class="desiide-review__reasons" aria-label="Why Desiide asks">
      {reasons.map((r) => (
        <li key={r.label} title={r.label}>
          {r.text}
        </li>
      ))}
    </ul>
  );
}

/** The optional "why not?" field, sent to the model with a rejection. */
function ReasonField({
  id,
  value,
  onInput,
  onSubmit,
  onCancel,
  autoFocus,
}: {
  id: string;
  value: string;
  onInput: (v: string) => void;
  onSubmit?: () => void;
  onCancel?: () => void;
  autoFocus?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  // `autoFocus` only works on page load; the field opens later, from the Reject button.
  useEffect(() => {
    if (autoFocus) input.current?.focus();
  }, [autoFocus]);
  return (
    <label class="desiide-review__reason" for={id}>
      <span>Why not? Optional, sent to the agent</span>
      <input
        id={id}
        type="text"
        maxLength={2000}
        ref={input}
        value={value}
        onInput={(e) => onInput(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && onSubmit) {
            e.preventDefault();
            onSubmit();
          } else if (e.key === 'Escape' && onCancel) {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          }
        }}
      />
    </label>
  );
}

const APPROVAL_STATUS: Record<
  ApprovalStatus,
  { text: string; tone: 'needs' | 'done' | 'neutral' | 'blocked' }
> = {
  waiting: { text: 'asks you', tone: 'needs' },
  sending: { text: 'sending…', tone: 'neutral' },
  approved: { text: 'approved', tone: 'done' },
  rejected: { text: 'rejected', tone: 'neutral' },
  blocked: { text: 'blocked', tone: 'blocked' },
  cancelled: { text: 'no longer asked', tone: 'neutral' },
};

/** A gated action (`approval_required`): run once, allow for this task, or reject. */
export function ApprovalCard({ item, taskId, live }: ItemProps<ApprovalItem>) {
  const { reasons } = useReview();
  const view = useContext(TaskViewContext);
  const [sent, setSent] = useState<ApprovalAnswer | undefined>(undefined);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const card = approvalCardView(item, {
    live,
    reasons,
    ...(view ? { view } : {}),
    ...(sent ? { sent } : {}),
  });
  const decision = useMemo(() => summarizeDecision(card.decisions), [card.decisions]);
  const answer = (a: ApprovalAnswer, why?: string) => {
    if (card.actions.length === 0) return;
    setSent(a);
    setRejecting(false);
    post({
      type: 'approval.answer',
      taskId,
      approvalId: item.approvalId,
      answer: a,
      ...(why ? { reason: why } : {}),
    });
  };
  const status = APPROVAL_STATUS[card.status];
  const open = card.actions.length > 0;
  const fieldId = `reject-${item.approvalId}`;
  return (
    <div
      class="desiide-review desiide-review--approval"
      data-slot="approval"
      data-status={card.status}
      tabIndex={open ? 0 : -1}
      role="group"
      aria-label={`${card.title}: ${card.command}`}
      onKeyDown={(e) =>
        open && onCardKey(e, { approve: () => answer('once'), reject: () => answer('reject') })
      }
    >
      <NeedsYou
        answered={!open}
        title={
          <>
            <span>{open ? `Needs you · ${card.title}` : card.title}</span>
            <Badge tone={status.tone}>{status.text}</Badge>
          </>
        }
        actions={
          open &&
          (rejecting ? (
            <>
              <ReasonField
                id={fieldId}
                value={reason}
                onInput={setReason}
                onSubmit={() => answer('reject', reason.trim())}
                onCancel={() => setRejecting(false)}
                autoFocus
              />
              <Button
                variant="secondary"
                icon="close"
                onClick={() => answer('reject', reason.trim())}
              >
                Reject
              </Button>
              <Button variant="ghost" onClick={() => setRejecting(false)}>
                Cancel
              </Button>
            </>
          ) : (
            <>
              <Button icon="play" nudge onClick={() => answer('once')}>
                Run once
              </Button>
              <Button
                variant="secondary"
                icon="check-all"
                title="Allow this exact action again in this task without asking"
                onClick={() => answer('task')}
              >
                Allow for this task
              </Button>
              <Button variant="ghost" icon="close" onClick={() => setRejecting(true)}>
                Reject
              </Button>
              <span class="desiide-review__keys" aria-hidden="true">
                {MOD}↵ run once · Esc reject
              </span>
            </>
          ))
        }
      >
        <pre class="desiide-review__command">{card.command}</pre>
        <div class="desiide-review__meta">
          <span>
            <Codicon name="folder" /> {card.cwd}
          </span>
          <Badge tone="needs">policy: confirm</Badge>
        </div>
        <Reasons reasons={card.reasons} />
        {decision && (
          <div class="desiide-review__decision">
            <DecisionChip
              summary={decision}
              {...(card.decisionId
                ? {
                    onClick: () =>
                      post({ type: 'decision.open', decisionId: card.decisionId ?? '' }),
                  }
                : {})}
            />
          </div>
        )}
        {!decision && card.decisionId && (
          <Button
            variant="ghost"
            icon="git-merge"
            onClick={() => post({ type: 'decision.open', decisionId: card.decisionId ?? '' })}
          >
            View decision
          </Button>
        )}
      </NeedsYou>
    </div>
  );
}

function BlockedCard({ card }: { card: BlockedCardView }) {
  return (
    <div class="desiide-review desiide-review--blocked" data-slot="blocked">
      <BlockedNote title={<span>Blocked · {card.title}</span>}>
        {card.command && <pre class="desiide-review__command">{card.command}</pre>}
        <Reasons reasons={card.reasons} />
        <p class="desiide-review__note">
          Desiide never runs this. The agent was told why and can try another way.
        </p>
      </BlockedNote>
    </div>
  );
}

/** Tool cards, with blocked calls as a non-actionable card of their own. */
export function makeToolRenderer(ToolCard: (p: ItemProps<ToolItem>) => JSX.Element) {
  return function ToolRow(props: ItemProps<ToolItem>) {
    const { reasons } = useReview();
    const blocked = blockedCardView(props.item, reasons);
    return blocked ? <BlockedCard card={blocked} /> : <ToolCard {...props} />;
  };
}

const FILE_STATUS = {
  pending: undefined,
  applied: { text: 'applied', tone: 'done' },
  rejected: { text: 'rejected', tone: 'neutral' },
  stale: { text: 'stale · agent redoes', tone: 'needs' },
} as const;

/** An edit proposal: per-file accept/reject, native diff per file, one WorkspaceEdit on apply. */
export function EditReviewCard({ item, taskId, live }: ItemProps<EditProposalItem>) {
  const { proposals } = useReview();
  const review = proposals.get(reviewKey(taskId, item.proposal.id));
  const card = proposalCardView(item, review, live);
  const [rejected, setRejected] = useState<ReadonlySet<string>>(() => new Set());
  const [reason, setReason] = useState('');
  const [sent, setSent] = useState(false);
  const sentFor = useRef(review?.error);
  // A failed apply comes back as `pending` with an error: answering is possible again.
  useEffect(() => {
    if (review?.state === 'pending' && review.error && review.error !== sentFor.current) {
      setSent(false);
    }
  }, [review?.state, review?.error]);
  const open = card.canAnswer && !sent;
  const total = card.files.length;
  const accepted = total - rejected.size;

  const submit = (acceptAll?: boolean) => {
    if (!open) return;
    setSent(true);
    sentFor.current = review?.error;
    const files = card.files.map((f) => ({
      path: f.path,
      accept: acceptAll ?? !rejected.has(f.path),
    }));
    const why = reason.trim();
    post({
      type: 'review.submit',
      taskId,
      proposalId: item.proposal.id,
      files,
      ...(why && files.some((f) => !f.accept) ? { reason: why } : {}),
    });
  };
  const toggle = (path: string) => {
    const next = new Set(rejected);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setRejected(next);
  };
  const title = total === 1 ? 'Review edit' : `Review edits · ${total} files`;
  const stateBadge =
    card.state === 'expired'
      ? { text: 'task ended', tone: 'neutral' as const }
      : card.state === 'done'
        ? { text: 'reviewed', tone: 'done' as const }
        : sent || card.state === 'applying'
          ? { text: 'applying…', tone: 'neutral' as const }
          : { text: 'needs you', tone: 'needs' as const };

  return (
    <div
      class="desiide-review desiide-review--edit"
      data-slot="edit_proposal"
      data-state={card.state}
      tabIndex={open ? 0 : -1}
      role="group"
      aria-label={title}
      onKeyDown={(e) =>
        open && onCardKey(e, { approve: () => submit(), reject: () => submit(false) })
      }
    >
      <NeedsYou
        answered={!open}
        title={
          <>
            <Codicon name="diff" />
            <span>{title}</span>
            <span class="desiide-review__stats">
              <span class="desiide-review__added">+{card.added}</span>{' '}
              <span class="desiide-review__removed">−{card.removed}</span>
            </span>
            <Badge tone={stateBadge.tone}>{stateBadge.text}</Badge>
          </>
        }
        actions={
          open && (
            <>
              <Button icon="check" nudge onClick={() => submit()}>
                {applyLabel(accepted, total)}
              </Button>
              {accepted > 0 && total > 1 && (
                <Button variant="secondary" icon="close" onClick={() => submit(false)}>
                  Reject all
                </Button>
              )}
              {accepted < total && accepted > 0 && (
                <Button variant="ghost" onClick={() => setRejected(new Set())}>
                  Select all
                </Button>
              )}
              <span class="desiide-review__keys" aria-hidden="true">
                {MOD}↵ {accepted === 0 ? 'reject' : 'apply'} · Esc reject all
              </span>
            </>
          )
        }
      >
        <ul class="desiide-review__files" aria-label="Files">
          {card.files.map((f) => {
            const done = FILE_STATUS[f.status];
            const id = `file-${item.proposal.id}-${f.path}`;
            return (
              <li key={f.path} class={`desiide-review__file is-${f.status}`}>
                {open ? (
                  <input
                    id={id}
                    type="checkbox"
                    checked={!rejected.has(f.path)}
                    aria-label={`Accept ${f.path}`}
                    onChange={() => toggle(f.path)}
                  />
                ) : (
                  <Codicon
                    name={
                      f.status === 'applied'
                        ? 'check'
                        : f.status === 'stale'
                          ? 'warning'
                          : 'circle-slash'
                    }
                  />
                )}
                <button
                  type="button"
                  class="desiide-review__path"
                  title={`Open the diff: ${f.path}`}
                  onClick={() =>
                    post({
                      type: 'review.openDiff',
                      taskId,
                      proposalId: item.proposal.id,
                      path: f.path,
                    })
                  }
                >
                  {f.path}
                </button>
                <span
                  class="desiide-review__stats"
                  aria-label={`${f.added} lines added, ${f.removed} removed`}
                >
                  <span class="desiide-review__added">+{f.added}</span>{' '}
                  <span class="desiide-review__removed">−{f.removed}</span>
                </span>
                {f.sensitive && (
                  <Badge tone="needs">
                    <Codicon name="shield" /> sensitive
                  </Badge>
                )}
                {done && <Badge tone={done.tone}>{done.text}</Badge>}
              </li>
            );
          })}
        </ul>
        {card.critique && (
          <div class="desiide-review__critique">
            <Badge tone="decision">
              reviewer: {card.critique.verdict}
              {card.critique.model ? ` · ${card.critique.model}` : ''}
            </Badge>
            {card.critique.issues.length > 0 && (
              <ul>
                {card.critique.issues.map((issue) => (
                  <li key={issue}>{issue}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        {open && rejected.size > 0 && (
          <ReasonField id={`why-${item.proposal.id}`} value={reason} onInput={setReason} />
        )}
        {card.error && <p class="desiide-review__error">{card.error}</p>}
      </NeedsYou>
    </div>
  );
}
