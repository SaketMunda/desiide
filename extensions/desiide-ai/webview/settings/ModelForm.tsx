import type { ModelConfig } from '@desiide/protocol';
import { useState } from 'preact/hooks';
import {
  PROVIDER_PRESETS,
  presetById,
  type KeyStatus,
  type ProviderPresetId,
} from '../../shared/settings.ts';
import { post } from '../bridge.ts';
import { Button, Collapsible } from '../ui/index.ts';
import { Field, KeyInput, Select, TextInput } from './fields.tsx';
import {
  buildModelConfig,
  draftFromConfig,
  draftFromPreset,
  needsKey,
  uniqueId,
  type ModelDraft,
} from './logic.ts';

export interface ModelFormProps {
  /** Editing an existing model; absent to add one. */
  original?: ModelConfig;
  keyStatus?: KeyStatus;
  takenIds: readonly string[];
  /** Offered providers; onboarding shows only the cloud ones. */
  initialPreset?: ProviderPresetId;
  submitLabel?: string;
  onDone?: () => void;
}

const TRI = [
  { value: 'auto', label: 'Auto (as reported)' },
  { value: 'yes', label: 'Yes' },
  { value: 'no', label: 'No' },
] as const;

/**
 * Add or edit one model. Picking a provider fills the base URL and key name; the key goes to the
 * host with the save and is cleared here right after.
 */
export function ModelForm({
  original,
  keyStatus = 'none',
  takenIds,
  initialPreset = 'anthropic',
  submitLabel,
  onDone,
}: ModelFormProps) {
  const [preset, setPreset] = useState<ProviderPresetId>(initialPreset);
  const [draft, setDraft] = useState<ModelDraft>(() =>
    original ? draftFromConfig(original) : draftFromPreset(presetById(initialPreset), takenIds),
  );
  const [error, setError] = useState<string>();
  const set = <K extends keyof ModelDraft>(key: K, value: ModelDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const pickPreset = (id: ProviderPresetId) => {
    setPreset(id);
    const p = PROVIDER_PRESETS.find((x) => x.id === id);
    if (p) setDraft((d) => ({ ...draftFromPreset(p, takenIds), key: d.key }));
  };

  const keyStored = keyStatus === 'set';
  const presetInfo = PROVIDER_PRESETS.find((p) => p.id === preset);
  const showKey = draft.provider !== 'ollama';

  const submit = (e: Event) => {
    e.preventDefault();
    const built = buildModelConfig(draft, original);
    if (!built.ok) {
      setError(built.error);
      return;
    }
    if (needsKey(draft, keyStored)) {
      setError('Paste an API key: this provider needs one.');
      return;
    }
    setError(undefined);
    const key = draft.key.trim();
    post({
      type: 'settings.saveModel',
      model: built.config,
      ...(original ? { previousId: original.id } : {}),
      ...(key ? { key } : {}),
      test: true,
    });
    // The key leaves this form now; nothing keeps a copy.
    setDraft((d) => ({ ...d, key: '' }));
    onDone?.();
  };

  return (
    <form
      class="ds-form"
      onSubmit={submit}
      aria-label={original ? `Edit ${original.id}` : 'Add a model'}
    >
      {!original && (
        <div class="ds-presets" role="radiogroup" aria-label="Provider">
          {PROVIDER_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={preset === p.id}
              class={`ds-preset${preset === p.id ? ' ds-preset--on' : ''}`}
              onClick={() => pickPreset(p.id)}
            >
              {p.label}
            </button>
          ))}
        </div>
      )}
      <div class="ds-grid">
        <Field
          label="Model"
          hint={presetInfo && !original ? `e.g. ${presetInfo.modelPlaceholder}` : undefined}
        >
          {(id, hint) => (
            <TextInput
              id={id}
              aria-describedby={hint}
              value={draft.model}
              placeholder={presetInfo?.modelPlaceholder}
              onValue={(v) => {
                set('model', v);
                if (!original) set('id', v.trim() ? uniqueName(v, takenIds) : draft.id);
              }}
            />
          )}
        </Field>
        <Field label="Name" hint="How roles refer to it.">
          {(id, hint) => (
            <TextInput
              id={id}
              aria-describedby={hint}
              value={draft.id}
              onValue={(v) => set('id', v)}
            />
          )}
        </Field>
        {draft.provider === 'openai-compatible' && (
          <Field label="Base URL">
            {(id) => (
              <TextInput
                id={id}
                value={draft.baseUrl}
                placeholder="https://host/v1"
                onValue={(v) => set('baseUrl', v)}
              />
            )}
          </Field>
        )}
        {showKey && (
          <Field
            label="API key"
            hint={
              keyStored
                ? 'A key is saved. Leave blank to keep it.'
                : `Stored in your system keychain, never in settings.json.${presetInfo?.keyUrlHint && !original ? ` Get one at ${presetInfo.keyUrlHint}.` : ''}`
            }
          >
            {(id, hint) => (
              <KeyInput
                id={id}
                aria-describedby={hint}
                value={draft.key}
                placeholder={keyStored ? '••••••••  (saved)' : 'Paste your key'}
                onValue={(v) => set('key', v)}
              />
            )}
          </Field>
        )}
      </div>
      <Collapsible title="Advanced">
        <div class="ds-grid">
          <Field label="Runs" hint="Local models keep your code on this machine.">
            {(id, hint) => (
              <Select
                id={id}
                describedBy={hint}
                value={draft.locality}
                options={[
                  { value: 'auto', label: 'Auto-detect' },
                  { value: 'local', label: 'Local' },
                  { value: 'cloud', label: 'Cloud' },
                ]}
                onValue={(v) => set('locality', v)}
              />
            )}
          </Field>
          <Field label="Context window (tokens)">
            {(id) => (
              <TextInput
                id={id}
                inputMode="numeric"
                value={draft.contextTokens}
                placeholder="as reported"
                onValue={(v) => set('contextTokens', v)}
              />
            )}
          </Field>
          <Field label="Max output (tokens)">
            {(id) => (
              <TextInput
                id={id}
                inputMode="numeric"
                value={draft.maxOutputTokens}
                placeholder="as reported"
                onValue={(v) => set('maxOutputTokens', v)}
              />
            )}
          </Field>
          <Field label="Tool calls">
            {(id) => (
              <Select
                id={id}
                value={draft.toolCalls}
                options={TRI}
                onValue={(v) => set('toolCalls', v)}
              />
            )}
          </Field>
          <Field label="Images">
            {(id) => (
              <Select
                id={id}
                value={draft.vision}
                options={TRI}
                onValue={(v) => set('vision', v)}
              />
            )}
          </Field>
          <Field label="Cost in / out ($ per 1M tokens)" hint="For cost estimates only.">
            {(id, hint) => (
              <div class="ds-pair">
                <TextInput
                  id={id}
                  aria-describedby={hint}
                  aria-label="Input cost"
                  inputMode="decimal"
                  value={draft.costInput}
                  placeholder="in"
                  onValue={(v) => set('costInput', v)}
                />
                <TextInput
                  aria-label="Output cost"
                  inputMode="decimal"
                  value={draft.costOutput}
                  placeholder="out"
                  onValue={(v) => set('costOutput', v)}
                />
              </div>
            )}
          </Field>
        </div>
      </Collapsible>
      {error && (
        <div class="ds-form__error" role="alert">
          {error}
        </div>
      )}
      <div class="ds-actions">
        <Button type="submit" icon="check">
          {submitLabel ?? (original ? 'Save & test' : 'Add & test')}
        </Button>
        {onDone && original && (
          <Button variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}

function uniqueName(model: string, taken: readonly string[]): string {
  return uniqueId(model.split('/').pop() ?? model, taken);
}
