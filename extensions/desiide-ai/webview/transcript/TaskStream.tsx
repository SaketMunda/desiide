import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { ExtensionToWebview } from '../../shared/messages.ts';
import type { TaskView, TranscriptState } from '../../shared/transcript/model.ts';
import { isTerminal, streamingItemId, taskTotals } from '../../shared/transcript/reducer.ts';
import { post, useBridge, usePersistentState } from '../bridge.ts';
import { Badge, Button, Codicon, IconButton } from '../ui/index.ts';
import { formatCost, formatCount, STATE_LABELS, WORKFLOW_NAMES } from './format.ts';
import { TranscriptRow } from './items.tsx';
import { useTranscript } from './store.ts';
import { isAtBottom, visibleWindow } from './virtual.ts';

const isTaskId = (v: unknown): v is string | undefined => v === undefined || typeof v === 'string';

/** The task stream: task list, header and transcript of the selected task (UI-3). */
export function TaskStream() {
  const { state, retryable } = useTranscript();
  const [picked, setPicked] = usePersistentState<string | undefined>(
    'stream.selected',
    undefined,
    isTaskId,
  );
  // A new task (sent from the Prompt Box, or a retry) takes over the view.
  const onMessage = useCallback(
    (m: ExtensionToWebview) => {
      if (m.type === 'prompt.sent' || m.type === 'tasks.select') setPicked(m.taskId);
    },
    [setPicked],
  );
  useBridge(onMessage);

  const selected = picked && state.tasks[picked] ? picked : state.order.at(-1);
  const view = selected ? state.tasks[selected] : undefined;
  const onRetry = useCallback(() => {
    if (selected) post({ type: 'task.retry', taskId: selected });
  }, [selected]);
  if (!view) return null;

  return (
    <div class="desiide-stream">
      {state.order.length > 1 && (
        <TaskList state={state} selected={view.meta.id} onSelect={setPicked} />
      )}
      <TaskHeader view={view} canRetry={retryable.has(view.meta.id)} onRetry={onRetry} />
      <Transcript
        key={view.meta.id}
        view={view}
        retryable={retryable.has(view.meta.id)}
        onRetry={onRetry}
      />
    </div>
  );
}

function TaskList({
  state,
  selected,
  onSelect,
}: {
  state: TranscriptState;
  selected: string;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ids = [...state.order].reverse();
  const running = ids.filter((id) => {
    const t = state.tasks[id];
    return t && !isTerminal(t);
  }).length;
  return (
    <nav class="desiide-task-list" aria-label="Tasks">
      <button
        type="button"
        class="desiide-task-list__toggle"
        aria-expanded={open}
        aria-controls="desiide-task-list"
        onClick={() => setOpen(!open)}
      >
        <Codicon name={open ? 'chevron-down' : 'chevron-right'} />
        <span>Tasks</span>
        <Badge>{ids.length}</Badge>
        {running > 0 && <Badge tone="ai">{running} running</Badge>}
      </button>
      <ul id="desiide-task-list" class="desiide-task-list__items" hidden={!open}>
        {ids.map((id) => {
          const t = state.tasks[id];
          if (!t) return null;
          const s = STATE_LABELS[t.meta.state];
          return (
            <li key={id}>
              <button
                type="button"
                class={`desiide-task-list__item${id === selected ? ' is-selected' : ''}`}
                aria-current={id === selected ? 'true' : undefined}
                onClick={() => {
                  onSelect(id);
                  setOpen(false);
                }}
              >
                <Badge tone={s.tone}>{s.label}</Badge>
                <span class="desiide-task-list__text">{t.meta.instruction || 'Task'}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function TaskHeader({
  view,
  canRetry,
  onRetry,
}: {
  view: TaskView;
  canRetry: boolean;
  onRetry: () => void;
}) {
  const { meta } = view;
  const state = STATE_LABELS[meta.state];
  const live = !isTerminal(view);
  const totals = taskTotals(meta);
  const facts = [
    meta.workflow ? WORKFLOW_NAMES[meta.workflow] : undefined,
    meta.models.length > 0 ? meta.models.join(' → ') : undefined,
    meta.iteration > 0 ? `iteration ${meta.iteration}` : undefined,
    totals.tokens > 0 ? `${formatCount(totals.tokens)} tokens` : undefined,
    totals.costUsd === undefined ? undefined : formatCost(totals.costUsd),
  ].filter((f): f is string => f !== undefined);
  return (
    <header class="desiide-task-header">
      <div class="desiide-task-header__top">
        <span class={`desiide-pill desiide-tone--${state.tone}${live ? ' is-live' : ''}`}>
          {state.label}
        </span>
        <span class="desiide-task-header__instruction" title={meta.instruction}>
          {meta.instruction || 'Task'}
        </span>
        <span class="desiide-task-header__actions">
          {live ? (
            <IconButton
              icon="debug-stop"
              label="Stop this task"
              onClick={() => post({ type: 'task.cancel', taskId: meta.id })}
            />
          ) : (
            canRetry && <IconButton icon="refresh" label="Retry this task" onClick={onRetry} />
          )}
        </span>
      </div>
      {facts.length > 0 && (
        <div class="desiide-task-header__facts" aria-label="Task details">
          {facts.map((f) => (
            <span key={f}>{f}</span>
          ))}
        </div>
      )}
      <span class="desiide-visually-hidden" role="status">
        {`Task ${state.label.toLowerCase()}`}
      </span>
    </header>
  );
}

function Transcript({
  view,
  retryable,
  onRetry,
}: {
  view: TaskView;
  retryable: boolean;
  onRetry: () => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const heights = useRef(new Map<string, number>());
  const [scroll, setScroll] = useState({ top: 0, viewport: 800 });
  const [, setMeasured] = useState(0);
  const following = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const live = !isTerminal(view);
  const streaming = streamingItemId(view);
  const items = view.items;
  const virtual = items.length > 300;

  // One observer for every row: heights feed the virtual window.
  const observer = useRef<ResizeObserver | undefined>(undefined);
  useEffect(() => {
    observer.current = new ResizeObserver((entries) => {
      let changed = false;
      for (const e of entries) {
        const id = (e.target as HTMLElement).dataset['id'];
        const h = (e.target as HTMLElement).offsetHeight;
        if (id && heights.current.get(id) !== h) {
          heights.current.set(id, h);
          changed = true;
        }
      }
      if (changed && virtual) setMeasured((n) => n + 1);
    });
    return () => observer.current?.disconnect();
  }, [virtual]);
  const measure = useCallback((el: HTMLDivElement | null) => {
    if (el) observer.current?.observe(el);
  }, []);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    following.current = isAtBottom(el.scrollTop, el.clientHeight, el.scrollHeight);
    setShowJump(!following.current);
    if (virtual) setScroll({ top: el.scrollTop, viewport: el.clientHeight });
  };

  // Follow the stream while the user is at the bottom.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && following.current) el.scrollTop = el.scrollHeight;
  });

  const jump = () => {
    const el = scroller.current;
    if (!el) return;
    following.current = true;
    setShowJump(false);
    el.scrollTop = el.scrollHeight;
  };

  const win = visibleWindow(
    items.map((i) => heights.current.get(i.id)),
    items.length,
    scroll.top,
    scroll.viewport,
  );

  return (
    <div class="desiide-transcript-wrap">
      <div
        ref={scroller}
        class="desiide-transcript"
        role="log"
        aria-label="Transcript"
        aria-live="off"
        tabIndex={0}
        onScroll={onScroll}
      >
        {win.before > 0 && <div style={{ height: `${win.before}px` }} aria-hidden="true" />}
        {items.slice(win.start, win.end).map((item) => (
          <div key={item.id} data-id={item.id} ref={measure} class="desiide-transcript__row">
            <TranscriptRow
              item={item}
              taskId={view.meta.id}
              live={live}
              streaming={item.id === streaming}
              retryable={retryable}
              onRetry={onRetry}
            />
          </div>
        ))}
        {win.after > 0 && <div style={{ height: `${win.after}px` }} aria-hidden="true" />}
      </div>
      {showJump && (
        <div class="desiide-transcript__jump">
          <Button variant="secondary" icon="arrow-down" onClick={jump}>
            Latest
          </Button>
        </div>
      )}
    </div>
  );
}
