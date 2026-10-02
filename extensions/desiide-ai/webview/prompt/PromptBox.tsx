import type { Preference } from '@desiide/protocol';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type {
  ActiveTask,
  ExtensionToWebview,
  MentionItem,
  PromptChip,
  PromptConfig,
  WorkflowChoice,
} from '../../shared/messages.ts';
import { post, useBridge, usePersistentState } from '../bridge.ts';
import { Badge, Button, Card, CodeBlock, Codicon, IconButton, Segmented } from '../ui/index.ts';
import type { SegmentedOption } from '../ui/index.ts';
import {
  addChip,
  estimateTokens,
  EXAMPLE_PROMPTS,
  findMentionQuery,
  formatTokens,
  mentionItems,
  NO_HISTORY,
  removeMention,
  stepHistory,
  type HistoryCursor,
  type MentionQuery,
} from './logic.ts';

const MAX_LINES = 12;
const DRAFT_SAVE_MS = 300;
const SEARCH_DEBOUNCE_MS = 60;
const LISTBOX_ID = 'desiide-mentions';
const INPUT_ID = 'desiide-prompt';

const WORKFLOW_LABELS: Record<WorkflowChoice, string> = {
  auto: 'Auto (Jev)',
  'local-single': 'Local',
  'cloud-single': 'Cloud',
  'local-cloud-cascade': 'Cascade',
  'cloud-with-critique': 'Critique',
};
const PREFERENCE_OPTIONS: SegmentedOption<Preference>[] = [
  { value: 'cheap', label: 'cheap' },
  { value: 'balance', label: 'balance' },
  { value: 'quality', label: 'quality' },
];
const MENTION_ICONS: Record<MentionItem['kind'], string> = {
  file: 'file',
  folder: 'folder',
  selection: 'selection',
  diff: 'diff',
};

const isPreference = (v: unknown): v is Preference =>
  v === 'cheap' || v === 'balance' || v === 'quality';
const isWorkflow = (v: unknown): v is WorkflowChoice =>
  typeof v === 'string' && v in WORKFLOW_LABELS;

/** The composer: input, @-mentions, chips, routing controls, Send/Stop. */
export function PromptBox() {
  const [text, setText] = useState('');
  const [chips, setChips] = useState<PromptChip[]>([]);
  const [restored, setRestored] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [cursor, setCursor] = useState<HistoryCursor>(NO_HISTORY);
  const [config, setConfig] = useState<PromptConfig | undefined>();
  const [active, setActive] = useState<ActiveTask[]>([]);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'error' | 'info'; text: string } | undefined>();
  const [echo, setEcho] = useState<unknown>();

  const [mention, setMention] = useState<MentionQuery | undefined>();
  const [dismissedAt, setDismissedAt] = useState<number | undefined>();
  const [results, setResults] = useState<MentionItem[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const requestId = useRef(0);

  // `undefined` = follow the settings default until the user picks one.
  const [preferencePick, setPreferencePick] = usePersistentState<Preference | undefined>(
    'prompt.preference',
    undefined,
    (v): v is Preference | undefined => v === undefined || isPreference(v),
  );
  const [workflow, setWorkflow] = usePersistentState<WorkflowChoice>(
    'prompt.workflow',
    'auto',
    isWorkflow,
  );

  const input = useRef<HTMLTextAreaElement>(null);
  const pendingCaret = useRef<number | undefined>(undefined);
  const composing = useRef(false);

  const preference = preferencePick ?? config?.defaultPreference ?? 'balance';
  const workflowState = config?.workflows.find((w) => w.option === workflow);
  // A choice whose roles were since removed falls back to Auto rather than failing on send.
  const effectiveWorkflow: WorkflowChoice =
    workflow === 'auto' || workflowState?.enabled === true ? workflow : 'auto';

  const replaceText = (next: string, caret = next.length) => {
    pendingCaret.current = caret;
    setText(next);
  };

  const onMessage = useCallback((m: ExtensionToWebview) => {
    switch (m.type) {
      case 'prompt.restore':
        setText((t) => (t.length > 0 ? t : m.draft.text));
        setChips((c) => (c.length > 0 ? c : m.draft.chips));
        setHistory(m.history);
        setRestored(true);
        break;
      case 'prompt.config':
        setConfig(m.config);
        break;
      case 'prompt.focus':
        focusInput(input.current);
        break;
      case 'prompt.addChip':
        setChips((c) => addChip(c, m.chip));
        setNotice(undefined);
        break;
      case 'prompt.fill':
        pendingCaret.current = m.text.length;
        setText(m.text);
        focusInput(input.current);
        break;
      case 'prompt.sent':
        setSending(false);
        setText('');
        setChips([]);
        setHistory(m.history);
        setCursor(NO_HISTORY);
        setEcho(m.echo);
        setNotice(undefined);
        break;
      case 'prompt.error':
        setSending(false);
        setNotice({ tone: 'error', text: m.message });
        break;
      case 'prompt.tasks':
        setActive(m.active);
        break;
      case 'mention.results':
        if (m.requestId === requestId.current) {
          setResults(m.items);
          setActiveIndex(0);
        }
        break;
      default:
        break;
    }
  }, []);
  useBridge(onMessage);

  // Persist the draft (debounced) once the stored one has been restored, so we never overwrite it.
  useEffect(() => {
    if (!restored) return undefined;
    const timer = setTimeout(
      () => post({ type: 'prompt.draft', draft: { text, chips } }),
      DRAFT_SAVE_MS,
    );
    return () => clearTimeout(timer);
  }, [text, chips, restored]);

  // Auto-grow up to MAX_LINES, then scroll.
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    if (pendingCaret.current !== undefined) {
      el.setSelectionRange(pendingCaret.current, pendingCaret.current);
      pendingCaret.current = undefined;
    }
    const style = getComputedStyle(el);
    const line = Number.parseFloat(style.lineHeight) || 18;
    const padding = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
    const max = line * MAX_LINES + padding;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
  }, [text]);

  // Debounced @-search; a newer request id makes older results stale (the host cancels them).
  const query = mention?.query;
  useEffect(() => {
    if (query === undefined) return undefined;
    const timer = setTimeout(() => {
      requestId.current++;
      post({ type: 'mention.search', requestId: requestId.current, query });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const popupOpen = mention !== undefined && mention.start !== dismissedAt;
  const items = popupOpen ? mentionItems(mention.query, results) : [];
  const activeItem = items[Math.min(activeIndex, items.length - 1)];

  const syncMention = (el: HTMLTextAreaElement) => {
    const m =
      el.selectionStart === el.selectionEnd
        ? findMentionQuery(el.value, el.selectionStart)
        : undefined;
    setMention(m);
    if (!m) setDismissedAt(undefined);
  };

  const pick = (item: MentionItem) => {
    if (!mention) return;
    const next = removeMention(text, mention);
    replaceText(next.text, next.caret);
    setMention(undefined);
    setResults([]);
    post({ type: 'mention.pick', item });
  };

  const hasModels = config?.hasModels ?? true;
  const running = active.length > 0;
  const canSend = text.trim().length > 0 && !sending;

  const submit = () => {
    if (!canSend) return;
    if (!hasModels) {
      setNotice({ tone: 'info', text: 'Connect a model before sending a task.' });
      return;
    }
    setSending(true);
    setNotice(undefined);
    post({
      type: 'prompt.submit',
      instruction: text,
      chips,
      preference,
      workflow: effectiveWorkflow,
    });
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const el = e.currentTarget as HTMLTextAreaElement;
    // IME: Enter confirms the composition, it must not send.
    if (e.isComposing || composing.current || e.keyCode === 229) return;

    if (popupOpen && items.length > 0) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        setActiveIndex((i) => (Math.min(i, items.length - 1) + step + items.length) % items.length);
        return;
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        e.preventDefault();
        if (activeItem) pick(activeItem);
        return;
      }
    }
    if (popupOpen && e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setDismissedAt(mention.start);
      return;
    }

    if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape') {
      el.blur();
    } else if (e.key === 'ArrowUp' && el.selectionStart === 0 && el.selectionEnd === 0) {
      const step = stepHistory(history, cursor, 'up', text);
      if (step) {
        e.preventDefault();
        setCursor(step.cursor);
        replaceText(step.text, 0);
      }
    } else if (
      e.key === 'ArrowDown' &&
      el.selectionStart === el.value.length &&
      el.selectionEnd === el.value.length
    ) {
      const step = stepHistory(history, cursor, 'down', text);
      if (step) {
        e.preventDefault();
        setCursor(step.cursor);
        replaceText(step.text);
      }
    }
  };

  const removeChip = (index: number) => {
    setChips((c) => c.filter((_, i) => i !== index));
    focusInput(input.current);
  };

  const tokens = estimateTokens(text, chips);
  const overLimit = config?.contextLimitTokens !== undefined && tokens > config.contextLimitTokens;
  const workflowOptions: SegmentedOption<WorkflowChoice>[] = [
    { value: 'auto', label: WORKFLOW_LABELS.auto },
    ...(config?.workflows ?? [])
      .filter((w) => !w.hidden)
      .map((w) => ({
        value: w.option,
        label: WORKFLOW_LABELS[w.option],
        ...(w.enabled ? {} : { disabledReason: w.reason ?? 'Not configured' }),
      })),
  ];
  const showExamples = text.length === 0 && chips.length === 0 && !running && echo === undefined;

  return (
    <div class="desiide-prompt-panel">
      <div class="desiide-prompt-panel__main">
        {!hasModels ? (
          <Card tone="ai" title="Connect a model to start">
            <p class="desiide-prompt__muted">
              Desiide runs on your own models: a local Ollama model or a cloud API key.
            </p>
            <Button icon="plug" onClick={() => post({ type: 'command', command: 'desiide.setup' })}>
              Set up a model
            </Button>
          </Card>
        ) : showExamples ? (
          <div class="desiide-prompt__examples">
            <p class="desiide-prompt__muted">Try one of these, or type @ to attach context.</p>
            {EXAMPLE_PROMPTS.map((example) => (
              <button
                key={example}
                type="button"
                class="desiide-prompt__example"
                onClick={() => {
                  replaceText(example);
                  focusInput(input.current);
                }}
              >
                <Codicon name="lightbulb" />
                <span>{example}</span>
              </button>
            ))}
          </div>
        ) : null}
        {echo !== undefined && (
          <Card
            tone="ai"
            title={
              <>
                <Badge tone="ai">mock</Badge> Sent <code>task.create</code>
              </>
            }
            actions={
              <IconButton icon="close" label="Dismiss payload" onClick={() => setEcho(undefined)} />
            }
          >
            <p class="desiide-prompt__muted">
              The task engine isn't available yet, so the mock orchestrator echoes the validated
              payload.
            </p>
            <CodeBlock language="json" code={JSON.stringify(echo, null, 2)} />
          </Card>
        )}
      </div>

      <div class="desiide-prompt">
        {chips.length > 0 && (
          <ul class="desiide-prompt__chips" aria-label="Attached context">
            {chips.map((chip, i) => (
              <li
                key={JSON.stringify(chip.ref)}
                class="desiide-prompt__chip desiide-chip desiide-tone--ai"
                title={chip.detail || chip.label}
              >
                <Codicon name={MENTION_ICONS[chip.ref.type]} />
                <span>{chip.label}</span>
                <button
                  type="button"
                  class="desiide-prompt__chip-remove"
                  aria-label={`Remove ${chip.label}`}
                  onClick={() => removeChip(i)}
                  onKeyDown={(e) => {
                    if (e.key === 'Backspace' || e.key === 'Delete') {
                      e.preventDefault();
                      removeChip(i);
                    }
                  }}
                >
                  <Codicon name="close" />
                </button>
              </li>
            ))}
          </ul>
        )}

        <div class="desiide-prompt__input-wrap">
          {popupOpen && (
            <ul
              class="desiide-prompt__mentions"
              id={LISTBOX_ID}
              role="listbox"
              aria-label="Attach context"
            >
              {items.length === 0 ? (
                <li class="desiide-prompt__mention-empty" role="presentation">
                  No matching files
                </li>
              ) : (
                items.map((item, i) => (
                  <li
                    key={`${item.kind}:${item.path ?? item.label}`}
                    id={`${LISTBOX_ID}-${i}`}
                    role="option"
                    aria-selected={item === activeItem}
                    class={`desiide-prompt__mention${item === activeItem ? ' is-active' : ''}`}
                    // mousedown, not click: keep focus (and the caret) in the textarea.
                    onMouseDown={(e) => {
                      e.preventDefault();
                      pick(item);
                    }}
                  >
                    <Codicon name={MENTION_ICONS[item.kind]} />
                    <span class="desiide-prompt__mention-label">{item.label}</span>
                    <span class="desiide-prompt__mention-detail">{item.detail}</span>
                  </li>
                ))
              )}
            </ul>
          )}
          <label class="desiide-visually-hidden" for={INPUT_ID}>
            Prompt
          </label>
          <textarea
            id={INPUT_ID}
            ref={input}
            class="desiide-prompt__input"
            rows={1}
            value={text}
            placeholder={running ? 'Queue another task…' : 'Describe a change. @ to attach context'}
            aria-label="Prompt"
            aria-describedby="desiide-prompt-hint"
            aria-autocomplete="list"
            aria-controls={popupOpen ? LISTBOX_ID : undefined}
            aria-activedescendant={
              popupOpen && activeItem ? `${LISTBOX_ID}-${items.indexOf(activeItem)}` : undefined
            }
            onInput={(e) => {
              const el = e.currentTarget;
              setText(el.value);
              if (cursor.index !== null) setCursor(NO_HISTORY);
              syncMention(el);
            }}
            onKeyDown={onKeyDown}
            onKeyUp={(e) => {
              if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key))
                syncMention(e.currentTarget);
            }}
            onClick={(e) => syncMention(e.currentTarget)}
            onCompositionStart={() => (composing.current = true)}
            onCompositionEnd={() => (composing.current = false)}
          />
          <span id="desiide-prompt-hint" class="desiide-visually-hidden">
            Enter sends, Shift+Enter adds a new line, @ attaches a file, folder, selection or diff.
          </span>
        </div>

        <div class="desiide-prompt__row">
          <Segmented
            label="Workflow"
            options={workflowOptions}
            value={effectiveWorkflow}
            onChange={setWorkflow}
            onDisabledPick={(o) =>
              setNotice({ tone: 'info', text: `${o.label}: ${o.disabledReason ?? ''}` })
            }
          />
          <Segmented
            label="Cost preference"
            options={PREFERENCE_OPTIONS}
            value={preference}
            onChange={setPreferencePick}
          />
        </div>

        <div class="desiide-prompt__row desiide-prompt__row--end">
          <span
            class={`desiide-prompt__tokens${overLimit ? ' is-over' : ''}`}
            title={
              config?.contextLimitTokens === undefined
                ? 'Estimated tokens of the prompt and attached context (chars ÷ 4).'
                : `Estimated tokens (chars ÷ 4). The smallest configured model fits ${formatTokens(config.contextLimitTokens)}.`
            }
          >
            {overLimit && <Codicon name="warning" />}~{formatTokens(tokens)} tokens
          </span>
          {config?.mock && <Badge tone="ai">mock</Badge>}
          <span class="desiide-prompt__spacer" />
          {running && (
            <Button
              variant={canSend ? 'secondary' : 'primary'}
              icon="debug-stop"
              onClick={() => post({ type: 'prompt.cancel' })}
              aria-label="Stop the running task"
            >
              Stop
            </Button>
          )}
          {!hasModels ? (
            <Button icon="plug" onClick={() => post({ type: 'command', command: 'desiide.setup' })}>
              Set up
            </Button>
          ) : (
            (!running || canSend) && (
              <Button icon={running ? 'add' : 'send'} disabled={!canSend} onClick={submit}>
                {running ? 'Queue' : 'Send'}
              </Button>
            )
          )}
        </div>

        <div class="desiide-prompt__notice" role={notice?.tone === 'error' ? 'alert' : 'status'}>
          {notice && (
            <span class={`desiide-prompt__notice-text is-${notice.tone}`}>
              <Codicon name={notice.tone === 'error' ? 'error' : 'info'} />
              {notice.text}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function focusInput(el: HTMLTextAreaElement | null): void {
  if (!el) return;
  el.focus();
  el.setSelectionRange(el.value.length, el.value.length);
}
