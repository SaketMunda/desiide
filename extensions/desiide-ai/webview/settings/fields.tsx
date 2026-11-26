import type { ComponentChildren, JSX } from 'preact';
import { useId } from 'preact/hooks';
import type { HealthResult } from '../../shared/settings.ts';
import { Badge, Codicon, Spinner } from '../ui/index.ts';
import { describeHealth } from './logic.ts';

export interface FieldProps {
  label: string;
  hint?: ComponentChildren;
  children: (id: string, hintId: string | undefined) => ComponentChildren;
}

/** A label, the control, and an optional hint wired up with `aria-describedby`. */
export function Field({ label, hint, children }: FieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div class="ds-field">
      <label class="ds-field__label" for={id}>
        {label}
      </label>
      {children(id, hintId)}
      {hint && (
        <div class="ds-field__hint" id={hintId}>
          {hint}
        </div>
      )}
    </div>
  );
}

export interface TextInputProps extends Omit<
  JSX.InputHTMLAttributes<HTMLInputElement>,
  'onInput' | 'value'
> {
  value: string;
  onValue: (value: string) => void;
}

export function TextInput({ value, onValue, ...rest }: TextInputProps) {
  return (
    <input
      class="ds-input"
      spellcheck={false}
      autoComplete="off"
      value={value}
      onInput={(e) => onValue(e.currentTarget.value)}
      {...rest}
    />
  );
}

/**
 * A key field. Its text lives only in the form's memory: never in `vscode.setState`, never echoed
 * back by the host, and cleared after saving. `autocomplete=off` keeps it out of autofill.
 */
export function KeyInput(props: Omit<TextInputProps, 'type'>) {
  return <TextInput type="password" autoComplete="off" {...props} />;
}

export interface SelectProps<T extends string> {
  id: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onValue: (value: T) => void;
  describedBy?: string | undefined;
}

export function Select<T extends string>({
  id,
  value,
  options,
  onValue,
  describedBy,
}: SelectProps<T>) {
  return (
    <select
      id={id}
      class="ds-select"
      value={value}
      aria-describedby={describedBy}
      onChange={(e) => onValue(e.currentTarget.value as T)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  description,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  description?: string;
}) {
  const id = useId();
  return (
    <div class="ds-toggle">
      <input
        id={id}
        type="checkbox"
        role="switch"
        class="ds-toggle__input"
        checked={checked}
        aria-describedby={description ? `${id}-d` : undefined}
        onChange={(e) => onChange(e.currentTarget.checked)}
      />
      <label for={id} class="ds-toggle__label">
        <span class="ds-toggle__track" aria-hidden="true">
          <span class="ds-toggle__thumb" />
        </span>
        <span>{label}</span>
      </label>
      {description && (
        <div id={`${id}-d`} class="ds-field__hint">
          {description}
        </div>
      )}
    </div>
  );
}

/** The result of a Test: latency on success, else the error kind, message and hint (AC3). */
export function HealthLine({
  testing,
  result,
}: {
  testing?: boolean | undefined;
  result?: HealthResult | undefined;
}) {
  if (testing) {
    return (
      <div class="ds-health">
        <Spinner label="Testing" /> <span aria-hidden="true">Testing…</span>
      </div>
    );
  }
  if (!result) return null;
  const { tone, text } = describeHealth(result);
  return (
    <div class={`ds-health ds-health--${tone}`} role="status">
      <Codicon name={result.ok ? 'pass-filled' : 'warning'} />
      <div>
        <div class="ds-health__text">
          {!result.ok && result.error && <Badge tone="confirm">{result.error.kind}</Badge>} {text}
        </div>
        {!result.ok && result.error?.hint && <div class="ds-health__hint">{result.error.hint}</div>}
      </div>
    </div>
  );
}
