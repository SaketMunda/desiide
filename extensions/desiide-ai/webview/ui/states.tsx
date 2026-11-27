/**
 * The five AI states (UI-7, ADR-023), one shared treatment each:
 *   thinking  — shimmering "Thinking…", collapses to "Thought for N s"
 *   decision  — violet chip with a probability bar; one soft pulse when it lands
 *   running   — cyan spinner that becomes a lime check (or a red cross)
 *   needs you — amber card whose primary button nudges gently until answered
 *   blocked   — a calm red note, never a red wall
 * Every animated state has a static look under prefers-reduced-motion.
 */
import type { ComponentChildren } from 'preact';
import { useRef } from 'preact/hooks';
import { Codicon } from './Codicon.tsx';
import { toPercent } from './metrics.ts';
import { type DecisionSummary, thinkingLabel } from './stateLogic.ts';

export interface ThinkingLabelProps {
  live: boolean;
  /** Formatted elapsed time ("3.2 s"). */
  elapsed: string;
}

export function ThinkingLabel({ live, elapsed }: ThinkingLabelProps) {
  return (
    <span class={`desiide-thinking-label${live ? ' is-live' : ''}`} data-state="thinking">
      <span class="desiide-thinking-label__text">{thinkingLabel(live, elapsed)}</span>
      {live && <span class="desiide-thinking-label__time">{elapsed}</span>}
    </span>
  );
}

const OUTCOME_TAGS = {
  auto: { text: 'auto', tone: 'done' },
  confirm: { text: 'asks you', tone: 'needs' },
  block: { text: 'blocked', tone: 'blocked' },
} as const;

export interface DecisionChipProps {
  summary: DecisionSummary;
  /** Play the one soft pulse (only when the decision has just landed). */
  pulse?: boolean;
  onClick?: () => void;
}

export function DecisionChip({ summary, pulse = false, onClick }: DecisionChipProps) {
  const pct = summary.probability === undefined ? undefined : toPercent(summary.probability);
  const tag = summary.outcome ? OUTCOME_TAGS[summary.outcome] : undefined;
  const body = (
    <>
      <Codicon name="git-merge" />
      <span class="desiide-decision__label">{summary.label}</span>
      {summary.workflow && <span class="desiide-decision__arrow">→ {summary.workflow}</span>}
      {pct !== undefined && (
        <span
          class="desiide-decision__meter"
          role="meter"
          aria-label={summary.probabilityLabel ?? 'probability'}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          aria-valuetext={`${summary.probabilityLabel ?? 'probability'} ${pct}%`}
        >
          <span class="desiide-decision__bar">
            <span class="desiide-decision__fill" style={{ width: `${pct}%` }} />
          </span>
          <span class="desiide-decision__pct">{pct}%</span>
        </span>
      )}
      {tag && <span class={`desiide-decision__tag desiide-tone--${tag.tone}`}>{tag.text}</span>}
    </>
  );
  const cls = `desiide-decision${pulse ? ' is-landing' : ''}`;
  return onClick ? (
    <button
      type="button"
      class={`${cls} desiide-decision--button`}
      onClick={onClick}
      data-state="decision"
    >
      {body}
    </button>
  ) : (
    <span class={cls} data-state="decision">
      {body}
    </span>
  );
}

export type RunStatus = 'running' | 'waiting' | 'done' | 'failed' | 'stopped';

const RUN_ICONS: Record<RunStatus, string> = {
  running: 'loading',
  waiting: 'question',
  done: 'check',
  failed: 'close',
  stopped: 'circle-slash',
};

export interface RunMarkProps {
  status: RunStatus;
  /** Accessible status text, e.g. "done". */
  label: string;
}

/**
 * Cyan spinner while running, amber while it waits for you; a lime check (with one small pop, only
 * if it finished while on screen) or a red cross after.
 */
export function RunMark({ status, label }: RunMarkProps) {
  const mountedAs = useRef(status).current;
  const landed = mountedAs !== status && (status === 'done' || status === 'failed');
  return (
    <span
      class={`desiide-run desiide-run--${status}${landed ? ' is-landing' : ''}`}
      data-state={status === 'waiting' ? 'needs' : status}
    >
      <Codicon name={RUN_ICONS[status]} spin={status === 'running'} />
      <span class="desiide-visually-hidden">{label}</span>
    </span>
  );
}

export interface NeedsYouProps {
  title: ComponentChildren;
  children?: ComponentChildren;
  /** Buttons; give the primary one `nudge` while unanswered. */
  actions?: ComponentChildren;
  /** Once answered the card settles: no nudge, no amber glow. */
  answered?: boolean;
}

/** "Needs you": amber and kind, never an alarm. */
export function NeedsYou({ title, children, actions, answered = false }: NeedsYouProps) {
  return (
    <section
      class={`desiide-needs${answered ? ' is-answered' : ''}`}
      data-state="needs"
      aria-live={answered ? undefined : 'polite'}
    >
      <header class="desiide-needs__title">
        <span class="desiide-needs__dot" aria-hidden="true" />
        {title}
      </header>
      {children && <div class="desiide-needs__body">{children}</div>}
      {actions && <div class="desiide-needs__actions">{actions}</div>}
    </section>
  );
}

export interface BlockedNoteProps {
  title: ComponentChildren;
  children?: ComponentChildren;
}

/** "Blocked": clear and red-marked, but calm (a soft edge, not a red wall). */
export function BlockedNote({ title, children }: BlockedNoteProps) {
  return (
    <section class="desiide-blocked" data-state="blocked">
      <header class="desiide-blocked__title">
        <Codicon name="circle-slash" />
        {title}
      </header>
      {children && <div class="desiide-blocked__body">{children}</div>}
    </section>
  );
}
