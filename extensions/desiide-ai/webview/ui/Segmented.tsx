import { useRef } from 'preact/hooks';

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  /** Unavailable options stay focusable (so the tooltip is reachable) but can't be chosen. */
  disabledReason?: string;
}

export interface SegmentedProps<T extends string> {
  label: string;
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Called when the user tries to pick a disabled option, so the caller can explain why. */
  onDisabledPick?: (option: SegmentedOption<T>) => void;
}

/** A radio group drawn as joined buttons. Arrow keys move between options (roving tabindex). */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  onDisabledPick,
}: SegmentedProps<T>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const pick = (o: SegmentedOption<T>) =>
    o.disabledReason ? onDisabledPick?.(o) : onChange(o.value);

  const onKeyDown = (e: KeyboardEvent, index: number) => {
    const step =
      e.key === 'ArrowRight' || e.key === 'ArrowDown'
        ? 1
        : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
          ? -1
          : 0;
    if (step === 0) return;
    e.preventDefault();
    const next = (index + step + options.length) % options.length;
    refs.current[next]?.focus();
    const option = options[next];
    if (option && !option.disabledReason) onChange(option.value);
  };

  const anyChecked = options.some((o) => o.value === value);
  return (
    <div class="desiide-segmented" role="radiogroup" aria-label={label}>
      {options.map((o, i) => {
        const checked = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-disabled={o.disabledReason ? true : undefined}
            title={o.disabledReason}
            tabIndex={checked || (!anyChecked && i === 0) ? 0 : -1}
            class={`desiide-segmented__option${checked ? ' is-checked' : ''}${o.disabledReason ? ' is-disabled' : ''}`}
            onClick={() => pick(o)}
            onKeyDown={(e) => onKeyDown(e, i)}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
