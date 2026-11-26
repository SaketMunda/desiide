import { KnownPack, type ModelRole, type RolesConfig } from '@desiide/protocol';
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ModelRow, SettingsSection, SettingsState } from '../../shared/settings.ts';
import { post, usePersistentState } from '../bridge.ts';
import {
  Badge,
  Button,
  CodeBlock,
  Codicon,
  Collapsible,
  IconButton,
  Segmented,
  Spinner,
} from '../ui/index.ts';
import { Field, HealthLine, KeyInput, Select, TextInput, Toggle } from './fields.tsx';
import { onboardingProgress, prettyJson } from './logic.ts';
import { ModelForm } from './ModelForm.tsx';
import { useSettingsStore, type SettingsStore } from './store.ts';

const SECTIONS: ReadonlyArray<{ id: SettingsSection; label: string; icon: string }> = [
  { id: 'start', label: 'Get started', icon: 'rocket' },
  { id: 'models', label: 'Models', icon: 'server-environment' },
  { id: 'roles', label: 'Roles', icon: 'organization' },
  { id: 'jev', label: 'Jev', icon: 'lightbulb-sparkle' },
  { id: 'gating', label: 'Gating', icon: 'shield' },
  { id: 'project', label: 'Project', icon: 'folder' },
];

const isSection = (v: unknown): v is SettingsSection => SECTIONS.some((s) => s.id === v);

export function SettingsPage() {
  const { store, update, dismiss } = useSettingsStore();
  const [section, setSection] = usePersistentState<SettingsSection>(
    'settings.section',
    'start',
    isSection,
  );
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => post({ type: 'settings.ready' }), []);
  useEffect(() => {
    if (store.section) {
      setSection(store.section);
      update({ section: undefined });
    }
  }, [store.section]);

  const go = (id: SettingsSection) => {
    setSection(id);
    // Move focus to the new section so keyboard and screen-reader users land in it.
    requestAnimationFrame(() => headingRef.current?.focus());
  };

  const s = store.state;
  return (
    <div class="ds-page">
      <nav class="ds-nav" aria-label="Settings sections">
        <div class="ds-nav__brand" aria-hidden="true">
          <Codicon name="settings-gear" /> Desiide
        </div>
        {SECTIONS.map((x) => (
          <button
            key={x.id}
            type="button"
            class={`ds-nav__item${section === x.id ? ' ds-nav__item--on' : ''}`}
            aria-current={section === x.id ? 'page' : undefined}
            onClick={() => go(x.id)}
          >
            <Codicon name={x.icon} />
            <span>{x.label}</span>
          </button>
        ))}
      </nav>
      <main class="ds-main">
        <h1 class="ds-title" tabIndex={-1} ref={headingRef}>
          {SECTIONS.find((x) => x.id === section)?.label}
        </h1>
        <Notices notices={store.notices} onDismiss={dismiss} />
        {!s ? (
          <div class="ds-loading">
            <Spinner label="Loading settings" />
          </div>
        ) : (
          <>
            {s.problems.length > 0 && <Problems problems={s.problems} />}
            {section === 'start' && <StartSection s={s} store={store} update={update} go={go} />}
            {section === 'models' && <ModelsSection s={s} store={store} />}
            {section === 'roles' && <RolesSection s={s} />}
            {section === 'jev' && <JevSection s={s} store={store} update={update} />}
            {section === 'gating' && <GatingSection s={s} />}
            {section === 'project' && <ProjectSection s={s} />}
          </>
        )}
      </main>
    </div>
  );
}

type Update = (patch: Partial<SettingsStore>) => void;

function Notices({
  notices,
  onDismiss,
}: {
  notices: SettingsStore['notices'];
  onDismiss: (id: number) => void;
}) {
  return (
    <div class="ds-notices" aria-live="polite">
      {notices.map((n) => (
        <div
          key={n.id}
          class={`ds-notice ds-notice--${n.level}`}
          role={n.level === 'error' ? 'alert' : undefined}
        >
          <Codicon
            name={n.level === 'success' ? 'pass-filled' : n.level === 'info' ? 'info' : 'warning'}
          />
          <span>{n.message}</span>
          <IconButton icon="close" label="Dismiss" onClick={() => onDismiss(n.id)} />
        </div>
      ))}
    </div>
  );
}

function Problems({ problems }: { problems: string[] }) {
  return (
    <div class="ds-callout ds-callout--confirm">
      <Codicon name="warning" />
      <div>
        <strong>A few settings were skipped</strong>
        <ul>
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
        <Button variant="secondary" icon="json" onClick={() => post({ type: 'settings.openJson' })}>
          Open settings.json
        </Button>
      </div>
    </div>
  );
}

function NoFolder({ what }: { what: string }) {
  return (
    <p class="ds-muted">
      <Codicon name="folder-opened" /> Open a folder to {what}.
    </p>
  );
}

// --- Get started --------------------------------------------------------------------------

function Step({
  n,
  done,
  title,
  optional,
  children,
}: {
  n: number;
  done: boolean;
  title: string;
  optional?: boolean;
  children: ComponentChildren;
}) {
  return (
    <li class={`ds-step${done ? ' ds-step--done' : ''}`}>
      <span class="ds-step__dot" aria-hidden="true">
        {done ? <Codicon name="check" /> : n}
      </span>
      <div class="ds-step__body">
        <h2 class="ds-step__title">
          {title}
          {optional && <span class="ds-step__optional">optional</span>}
          {done && <span class="desiide-visually-hidden"> (done)</span>}
        </h2>
        {children}
      </div>
    </li>
  );
}

function StartSection({
  s,
  store,
  update,
  go,
}: {
  s: SettingsState;
  store: SettingsStore;
  update: Update;
  go: (id: SettingsSection) => void;
}) {
  const p = onboardingProgress(s);
  const [cloudOpen, setCloudOpen] = useState(false);
  const discover = () => {
    update({ discovery: { ...store.discovery, loading: true } });
    post({ type: 'settings.discover' });
  };
  // Look for Ollama right away on a fresh setup: it's the one-click path.
  useEffect(() => {
    if (!store.discovery.done && !store.discovery.loading && s.workspace && !p.hasLocal) discover();
  }, [s.workspace]);

  const localRow = s.models.find((m) => m.locality === 'local');
  const cloudRow = s.models.find((m) => m.locality === 'cloud');
  const configured = new Set(
    s.models.filter((m) => m.config.provider === 'ollama').map((m) => m.config.model),
  );

  return (
    <div class="ds-start">
      <p class="ds-lede">
        {p.hasModel
          ? "You're set up. Tweak anything below, or jump straight in."
          : "Let's get you coding. Two minutes, tops."}
      </p>
      <ol class="ds-steps">
        <Step n={1} done={p.hasLocal} title="Use a local model" optional={p.hasCloud}>
          <p class="ds-muted">Free and private: runs through Ollama on this machine.</p>
          {!s.workspace ? (
            <NoFolder what="look for local models" />
          ) : store.discovery.loading ? (
            <div class="ds-row-inline">
              <Spinner label="Looking for Ollama" /> Looking for Ollama…
            </div>
          ) : (
            <>
              {store.discovery.models.length > 0 && (
                <ul class="ds-discovered" aria-label="Local models found">
                  {store.discovery.models.map((m) => (
                    <li key={m.model}>
                      <code>{m.model}</code>
                      <span class="ds-muted">{Math.round(m.contextTokens / 1000)}k context</span>
                      {configured.has(m.model) ? (
                        <Badge tone="auto">added</Badge>
                      ) : (
                        <Button
                          icon="zap"
                          onClick={() => post({ type: 'settings.useDiscovered', model: m.model })}
                        >
                          Use as cheap
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {store.discovery.error && <p class="ds-muted">{store.discovery.error}</p>}
              {localRow && <HealthLine {...store.tests[localRow.config.id]} />}
              <Button variant="ghost" icon="refresh" onClick={discover}>
                Look again
              </Button>
            </>
          )}
        </Step>
        <Step n={2} done={p.hasCloud} title="Add a cloud model" optional={p.hasLocal}>
          <p class="ds-muted">Claude, OpenAI, OpenRouter or Gemini, for the harder tasks.</p>
          {cloudRow && <HealthLine {...store.tests[cloudRow.config.id]} />}
          {cloudOpen ||
          (!p.hasLocal && store.discovery.done && store.discovery.models.length === 0) ? (
            <ModelForm
              takenIds={s.models.map((m) => m.config.id)}
              onDone={() => setCloudOpen(false)}
            />
          ) : (
            <Button variant="secondary" icon="add" onClick={() => setCloudOpen(true)}>
              {p.hasCloud ? 'Add another' : 'Add a provider'}
            </Button>
          )}
        </Step>
        <Step n={3} done={p.rolesSet} title="Pick who does what">
          <RolesSummary s={s} />
          <Button variant="ghost" icon="arrow-right" onClick={() => go('roles')}>
            Change roles
          </Button>
        </Step>
        <Step n={4} done={p.jevOn} title="Turn on Jev" optional>
          <p class="ds-muted">
            Jev makes the routing and risk calls. It only sees metadata (paths, sizes, command
            names), never your code. Without it, built-in rules make the same calls.
          </p>
          <Button variant="ghost" icon="eye" onClick={() => go('jev')}>
            See exactly what Jev gets
          </Button>
        </Step>
        <Step n={5} done={false} title="Try it">
          <p class="ds-muted">A small, read-only first task on this project.</p>
          <Button
            icon="play"
            disabled={!p.hasModel}
            onClick={() => post({ type: 'settings.tryIt' })}
          >
            Try a sample task
          </Button>
          {!p.hasModel && <p class="ds-muted">Add a model first.</p>}
        </Step>
      </ol>
    </div>
  );
}

const ROLE_INFO: Record<ModelRole, string> = {
  cheap: 'Drafts and small edits',
  strong: 'The hard stuff',
  reviewer: 'Second opinions',
};

function RolesSummary({ s }: { s: SettingsState }) {
  if (s.models.length === 0) return <p class="ds-muted">Roles fill in once you add a model.</p>;
  return (
    <dl class="ds-roles-summary">
      {(Object.keys(ROLE_INFO) as ModelRole[]).map((r) => (
        <div key={r}>
          <dt>{r}</dt>
          <dd>
            {s.roles[r] ?? (s.models.length === 1 ? `${s.models[0]?.config.id} (only model)` : '—')}
          </dd>
        </div>
      ))}
    </dl>
  );
}

// --- Models -------------------------------------------------------------------------------

function ModelsSection({ s, store }: { s: SettingsState; store: SettingsStore }) {
  const [editing, setEditing] = useState<string>();
  const [adding, setAdding] = useState(s.models.length === 0);
  const taken = s.models.map((m) => m.config.id);
  return (
    <div class="ds-stack">
      {s.models.length === 0 && (
        <p class="ds-lede">No models yet. Add one below, or use Get started to find a local one.</p>
      )}
      <ul class="ds-models" aria-label="Models">
        {s.models.map((m) => (
          <li key={m.config.id} class="ds-model">
            {editing === m.config.id ? (
              <ModelForm
                original={m.config}
                keyStatus={m.keyStatus}
                takenIds={taken.filter((id) => id !== m.config.id)}
                onDone={() => setEditing(undefined)}
              />
            ) : (
              <ModelSummary
                row={m}
                roles={s.roles}
                test={store.tests[m.config.id]}
                onEdit={() => setEditing(m.config.id)}
              />
            )}
          </li>
        ))}
      </ul>
      {adding ? (
        <div class="ds-panel">
          <h2 class="ds-h2">Add a model</h2>
          <ModelForm takenIds={taken} onDone={() => setAdding(s.models.length === 0)} />
        </div>
      ) : (
        <Button variant="secondary" icon="add" onClick={() => setAdding(true)}>
          Add a model
        </Button>
      )}
    </div>
  );
}

function ModelSummary({
  row,
  roles,
  test,
  onEdit,
}: {
  row: ModelRow;
  roles: RolesConfig;
  test: SettingsStore['tests'][string] | undefined;
  onEdit: () => void;
}) {
  const c = row.config;
  const roleNames = (Object.entries(roles) as Array<[ModelRole, string | undefined]>)
    .filter(([, id]) => id === c.id)
    .map(([r]) => r);
  return (
    <div class="ds-model__summary">
      <div class="ds-model__head">
        <span
          class={`ds-dot ds-dot--${row.healthy === undefined ? 'unknown' : row.healthy ? 'ok' : 'bad'}`}
          role="img"
          aria-label={
            row.healthy === undefined ? 'Health unknown' : row.healthy ? 'Healthy' : 'Not reachable'
          }
        />
        <strong class="ds-model__name">{c.id}</strong>
        <Badge tone={row.locality === 'local' ? 'auto' : 'ai'}>
          <Codicon name={row.locality === 'local' ? 'vm' : 'cloud'} />{' '}
          {row.locality === 'local' ? 'Local' : 'Cloud'}
          {row.localityOverridden ? ' (set)' : ''}
        </Badge>
        {roleNames.map((r) => (
          <Badge key={r} tone="jev">
            {r}
          </Badge>
        ))}
        <span class="ds-spacer" />
        <Button
          variant="ghost"
          icon="debug-start"
          onClick={() => post({ type: 'settings.testModel', id: c.id })}
        >
          Test
        </Button>
        <IconButton icon="edit" label={`Edit ${c.id}`} onClick={onEdit} />
        <IconButton
          icon="trash"
          label={`Remove ${c.id}`}
          onClick={() => post({ type: 'settings.removeModel', id: c.id })}
        />
      </div>
      <div class="ds-model__meta">
        <code>{c.provider}</code> · <code>{c.model}</code>
        {row.contextTokens !== undefined && <> · {Math.round(row.contextTokens / 1000)}k context</>}
        {c.apiKey && (
          <>
            {' · '}
            <span class={`ds-key ds-key--${row.keyStatus}`}>
              <Codicon name={row.keyStatus === 'set' ? 'key' : 'warning'} />{' '}
              {row.keyStatus === 'set' ? 'key saved' : 'key missing'}
            </span>
            {row.keyStatus === 'set' && (
              <Button
                variant="ghost"
                onClick={() => c.apiKey && post({ type: 'settings.clearKey', ref: c.apiKey })}
              >
                Forget key
              </Button>
            )}
          </>
        )}
      </div>
      <HealthLine {...test} />
    </div>
  );
}

// --- Roles --------------------------------------------------------------------------------

function RolesSection({ s }: { s: SettingsState }) {
  if (s.models.length === 0)
    return <p class="ds-lede">Add a model first; roles point at your models.</p>;
  const options = [
    { value: '', label: '— not set —' },
    ...s.models.map((m) => ({ value: m.config.id, label: `${m.config.id} (${m.locality})` })),
  ];
  const set = (role: ModelRole, id: string) => {
    const next = Object.fromEntries(
      Object.entries({ ...s.roles, [role]: id }).filter(([, v]) => v),
    ) as RolesConfig;
    post({ type: 'settings.setRoles', roles: next });
  };
  return (
    <div class="ds-stack">
      <p class="ds-lede">
        Workflows ask for a role, never a model, so you can swap models without breaking anything.
      </p>
      <div class="ds-grid">
        {(Object.keys(ROLE_INFO) as ModelRole[]).map((r) => (
          <Field
            key={r}
            label={r}
            hint={ROLE_INFO[r] + (r === 'reviewer' ? ' (falls back to strong)' : '')}
          >
            {(id, hint) => (
              <Select
                id={id}
                describedBy={hint}
                value={s.roles[r] ?? ''}
                options={options}
                onValue={(v) => set(r, v)}
              />
            )}
          </Field>
        ))}
      </div>
      {s.models.length === 1 && <p class="ds-muted">With one model, it plays every role.</p>}
    </div>
  );
}

// --- Jev ----------------------------------------------------------------------------------

const PACK_LABEL: Record<KnownPack, string> = {
  'workflow_select@1': 'Routing',
  'risk_gate@1': 'Risk',
  'cost_route@1': 'Cost',
};

function JevSection({
  s,
  store,
  update,
}: {
  s: SettingsState;
  store: SettingsStore;
  update: Update;
}) {
  const [enabled, setEnabled] = useState(s.jev.enabled);
  const [endpoint, setEndpoint] = useState(s.jev.endpoint ?? '');
  const [redact, setRedact] = useState(s.jev.redactPaths);
  const [key, setKey] = useState('');
  const [pack, setPack] = usePersistentState<KnownPack>(
    'settings.jevPack',
    'workflow_select@1',
    (v): v is KnownPack => KnownPack.safeParse(v).success,
  );
  const dirty =
    enabled !== s.jev.enabled ||
    endpoint !== (s.jev.endpoint ?? '') ||
    redact !== s.jev.redactPaths;

  const save = () => {
    const k = key.trim();
    if (k) post({ type: 'settings.setKey', ref: 'secret:jev', key: k });
    setKey('');
    post({ type: 'settings.setJev', enabled, endpoint, redactPaths: redact });
  };
  const preview = (p: KnownPack) => {
    update({ preview: { pack: p, loading: true } });
    post({ type: 'settings.previewJev', pack: p });
  };

  return (
    <div class="ds-stack">
      <p class="ds-lede">
        Jev decides which model takes a task and whether an action needs your OK. It's off by
        default; built-in rules make the same calls. Jev can only make gating stricter, never
        looser.
      </p>
      <div class="ds-panel">
        <Toggle checked={enabled} onChange={setEnabled} label="Use Jev" />
        <div class="ds-grid">
          <Field label="Endpoint">
            {(id) => (
              <TextInput
                id={id}
                type="url"
                value={endpoint}
                placeholder="https://…"
                onValue={setEndpoint}
              />
            )}
          </Field>
          <Field
            label="API key"
            hint={
              s.jev.keyStatus === 'set'
                ? 'A key is saved. Leave blank to keep it.'
                : 'Stored in your system keychain.'
            }
          >
            {(id, hint) => (
              <KeyInput
                id={id}
                aria-describedby={hint}
                value={key}
                placeholder={s.jev.keyStatus === 'set' ? '••••••••  (saved)' : 'Paste your key'}
                onValue={setKey}
              />
            )}
          </Field>
        </div>
        <Toggle
          checked={redact}
          onChange={setRedact}
          label="Redact paths"
          description="Folder and file names are hashed with a random salt kept in this workspace. Common names like src or test stay readable."
        />
        <div class="ds-actions">
          <Button icon="check" disabled={!dirty && key.trim() === ''} onClick={save}>
            Save
          </Button>
          <Button
            variant="secondary"
            icon="plug"
            onClick={() => {
              update({ jevTest: { loading: true } });
              post({ type: 'settings.testJev' });
            }}
          >
            Test connection
          </Button>
        </div>
        <HealthLine testing={store.jevTest?.loading} result={store.jevTest?.result} />
      </div>

      <div class="ds-panel">
        <h2 class="ds-h2">
          <Codicon name="eye" /> What Jev would receive
        </h2>
        <p class="ds-muted">
          A live sample built from this workspace, exactly as Desiide would send it
          {redact || s.jev.redactPaths ? ', redaction included' : ''}. Metadata only: paths, line
          counts, languages, command names, your branch. <strong>Never file contents.</strong>
        </p>
        {!s.workspace ? (
          <NoFolder what="preview the payload" />
        ) : (
          <>
            <div class="ds-row-inline">
              <Segmented
                label="Decision"
                options={KnownPack.options.map((p) => ({ value: p, label: PACK_LABEL[p] }))}
                value={pack}
                onChange={(p) => {
                  setPack(p);
                  preview(p);
                }}
              />
              <Button variant="secondary" icon="refresh" onClick={() => preview(pack)}>
                Preview payload
              </Button>
            </div>
            {store.preview?.loading && <Spinner label="Building preview" />}
            {store.preview?.error && <p class="ds-muted">{store.preview.error}</p>}
            {store.preview?.state && store.preview.pack === pack && (
              <CodeBlock code={prettyJson(store.preview.state)} language="json" />
            )}
          </>
        )}
      </div>
    </div>
  );
}

// --- Gating -------------------------------------------------------------------------------

function GatingSection({ s }: { s: SettingsState }) {
  const [globs, setGlobs] = useState(s.project.sensitiveGlobs);
  const [draft, setDraft] = useState('');
  useEffect(() => setGlobs(s.project.sensitiveGlobs), [s.project.sensitiveGlobs.join('\n')]);
  const add = () => {
    const g = draft.trim();
    if (g && !globs.includes(g)) setGlobs([...globs, g]);
    setDraft('');
  };
  const dirty = globs.join('\n') !== s.project.sensitiveGlobs.join('\n');
  const save = () =>
    post({
      type: 'settings.saveProject',
      testCommand: s.project.testCommand ?? '',
      lintCommand: s.project.lintCommand ?? '',
      sensitiveGlobs: globs,
    });

  return (
    <div class="ds-stack">
      <div class="ds-panel">
        <Segmented
          label="Gating mode"
          options={[
            { value: 'conservative', label: 'Conservative' },
            { value: 'strict', label: 'Strict' },
          ]}
          value={s.gating.mode}
          onChange={(mode) => post({ type: 'settings.setGatingMode', mode })}
        />
        <p class="ds-muted">
          {s.gating.mode === 'conservative'
            ? 'Asks before anything sensitive or risky: secrets, multi-file edits, commands with side effects. Plain reads just run.'
            : 'Asks before every command and edit. Plain reads still just run.'}{' '}
          There's no looser mode.
        </p>
        {s.gating.warnings.length > 0 && (
          <div class="ds-callout ds-callout--confirm" role="status">
            <Codicon name="shield" />
            <div>
              <strong>Ignored, to keep you safe</strong>
              <ul>
                {s.gating.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
              <Button
                variant="secondary"
                icon="json"
                onClick={() => post({ type: 'settings.openJson' })}
              >
                Open settings.json
              </Button>
            </div>
          </div>
        )}
      </div>

      <div class="ds-panel">
        <h2 class="ds-h2">Sensitive files in this project</h2>
        <p class="ds-muted">
          Desiide always asks before touching these. Saved to .desiide/project.json, so your team
          gets them too.
        </p>
        {!s.workspace ? (
          <NoFolder what="edit sensitive files" />
        ) : (
          <>
            <ul class="ds-globs" aria-label="Project sensitive globs">
              {globs.map((g) => (
                <li key={g}>
                  <code>{g}</code>
                  <IconButton
                    icon="close"
                    label={`Remove ${g}`}
                    onClick={() => setGlobs(globs.filter((x) => x !== g))}
                  />
                </li>
              ))}
            </ul>
            <form
              class="ds-row-inline"
              onSubmit={(e) => {
                e.preventDefault();
                add();
              }}
            >
              <TextInput
                aria-label="New sensitive glob"
                value={draft}
                placeholder="e.g. infra/prod/**"
                onValue={setDraft}
              />
              <Button type="submit" variant="secondary" icon="add">
                Add
              </Button>
              <Button icon="check" disabled={!dirty} onClick={save}>
                Save
              </Button>
            </form>
            {s.project.invalid && (
              <p class="ds-muted">
                <Codicon name="warning" /> .desiide/project.json couldn't be read; saving replaces
                the fields shown here.
              </p>
            )}
          </>
        )}
        <Collapsible title={`Always sensitive (${s.gating.defaultSensitiveGlobs.length} built-in)`}>
          <ul class="ds-readonly">
            {s.gating.defaultSensitiveGlobs.map((g) => (
              <li key={g}>
                <code>{g}</code>
              </li>
            ))}
          </ul>
        </Collapsible>
      </div>

      <div class="ds-panel">
        <h2 class="ds-h2">
          <Codicon name="lock" /> Always blocked
        </h2>
        <p class="ds-muted">
          The hard deny-list runs before anything else, Jev included. It can't be turned off.
        </p>
        <ul class="ds-readonly ds-deny" aria-label="Deny-list">
          {s.gating.denyList.map((d) => (
            <li key={d.id}>
              <code>{d.id}</code> <span>{d.text}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// --- Project ------------------------------------------------------------------------------

function ProjectSection({ s }: { s: SettingsState }) {
  const [test, setTest] = useState(s.project.testCommand ?? '');
  const [lint, setLint] = useState(s.project.lintCommand ?? '');
  useEffect(() => {
    setTest(s.project.testCommand ?? '');
    setLint(s.project.lintCommand ?? '');
  }, [s.project.testCommand, s.project.lintCommand]);
  if (!s.workspace) return <NoFolder what="set project commands" />;
  const d = s.project.detected;
  const dirty = test !== (s.project.testCommand ?? '') || lint !== (s.project.lintCommand ?? '');
  return (
    <div class="ds-stack">
      <p class="ds-lede">
        How Desiide checks its work. These run without asking, so keep them to tests and linters.
      </p>
      <div class="ds-panel">
        <div class="ds-grid">
          <Field
            label="Test command"
            hint={
              d.testCommand ? (
                <>
                  Detected: <code>{d.testCommand}</code>
                </>
              ) : (
                'Nothing detected.'
              )
            }
          >
            {(id, hint) => (
              <div class="ds-pair">
                <TextInput
                  id={id}
                  aria-describedby={hint}
                  value={test}
                  placeholder={d.testCommand ?? 'e.g. npm test'}
                  onValue={setTest}
                />
                {d.testCommand && test !== d.testCommand && (
                  <Button variant="ghost" onClick={() => setTest(d.testCommand ?? '')}>
                    Use detected
                  </Button>
                )}
              </div>
            )}
          </Field>
          <Field
            label="Lint command"
            hint={
              d.lintCommand ? (
                <>
                  Detected: <code>{d.lintCommand}</code>
                </>
              ) : (
                'Nothing detected.'
              )
            }
          >
            {(id, hint) => (
              <div class="ds-pair">
                <TextInput
                  id={id}
                  aria-describedby={hint}
                  value={lint}
                  placeholder={d.lintCommand ?? 'e.g. npm run lint'}
                  onValue={setLint}
                />
                {d.lintCommand && lint !== d.lintCommand && (
                  <Button variant="ghost" onClick={() => setLint(d.lintCommand ?? '')}>
                    Use detected
                  </Button>
                )}
              </div>
            )}
          </Field>
        </div>
        <div class="ds-actions">
          <Button
            icon="check"
            disabled={!dirty}
            onClick={() =>
              post({
                type: 'settings.saveProject',
                testCommand: test,
                lintCommand: lint,
                sensitiveGlobs: s.project.sensitiveGlobs,
              })
            }
          >
            Save to .desiide/project.json
          </Button>
        </div>
      </div>
    </div>
  );
}
