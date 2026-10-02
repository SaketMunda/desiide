import { ContextRef, Preference, TaskState, WorkflowOption } from '@desiide/protocol';
import * as z from 'zod';

/**
 * Messages between the extension host and the webviews. Both sides validate everything they
 * receive; UI modules add new message types here (additively, like the RPC protocol).
 */

export const ViewId = z.enum(['panel', 'decisions']);
export type ViewId = z.infer<typeof ViewId>;

/** Commands a webview may ask the extension to run. Anything else is rejected. */
export const WebviewCommand = z.enum(['desiide.showLog', 'desiide.dev.showcase', 'desiide.setup']);
export type WebviewCommand = z.infer<typeof WebviewCommand>;

// --- Prompt Box (UI-2) ---

/** A context attachment shown as a chip. `ref` is exactly what goes into `task.create`. */
export const PromptChip = z.strictObject({
  ref: ContextRef,
  /** Short text on the chip, e.g. `app.ts:12-30`. */
  label: z.string().min(1).max(200),
  /** Tooltip: the full workspace path. */
  detail: z.string().max(4096),
  /** Characters of context this chip adds, for the token estimate. Absent when unknown. */
  chars: z.int().nonnegative().optional(),
});
export type PromptChip = z.infer<typeof PromptChip>;

/** The routing selector. `auto` lets Jev choose (no `workflowOverride`). */
export const WorkflowChoice = z.union([z.literal('auto'), WorkflowOption]);
export type WorkflowChoice = z.infer<typeof WorkflowChoice>;

export const PromptDraft = z.strictObject({
  text: z.string().max(20_000),
  chips: z.array(PromptChip).max(100),
});
export type PromptDraft = z.infer<typeof PromptDraft>;

export const MentionKind = z.enum(['file', 'folder', 'selection', 'diff']);
export type MentionKind = z.infer<typeof MentionKind>;

/** One row of the @-mention popup. */
export const MentionItem = z.object({
  kind: MentionKind,
  label: z.string(),
  detail: z.string(),
  /** Workspace-relative path for file/folder items. */
  path: z.string().optional(),
});
export type MentionItem = z.infer<typeof MentionItem>;

export const WorkflowAvailability = z.object({
  option: WorkflowOption,
  enabled: z.boolean(),
  /** Why it is disabled, for the tooltip. */
  reason: z.string().optional(),
  /** Hidden options (critique before COR-5 Beta) aren't rendered at all. */
  hidden: z.boolean().default(false),
});
export type WorkflowAvailability = z.infer<typeof WorkflowAvailability>;

export const PromptConfig = z.object({
  hasModels: z.boolean(),
  workflows: z.array(WorkflowAvailability),
  defaultPreference: Preference,
  /** Smallest configured context window, in tokens. Absent when no model declares one. */
  contextLimitTokens: z.int().positive().optional(),
  /** True while sends are echoed by the mock client (the task engine isn't available yet). */
  mock: z.boolean(),
});
export type PromptConfig = z.infer<typeof PromptConfig>;

export const ActiveTask = z.object({ id: z.string(), state: TaskState });
export type ActiveTask = z.infer<typeof ActiveTask>;

export const WebviewToExtension = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('ready'), view: ViewId }),
  z.strictObject({ type: z.literal('command'), command: WebviewCommand }),
  z.strictObject({
    type: z.literal('log'),
    level: z.enum(['info', 'warn', 'error']),
    message: z.string().max(2000),
  }),
  z.strictObject({ type: z.literal('prompt.draft'), draft: PromptDraft }),
  z.strictObject({
    type: z.literal('prompt.submit'),
    instruction: z.string().max(20_000),
    chips: z.array(PromptChip).max(100),
    preference: Preference,
    workflow: WorkflowChoice,
  }),
  /** Stop the running task started from the Prompt Box. */
  z.strictObject({ type: z.literal('prompt.cancel') }),
  z.strictObject({
    type: z.literal('mention.search'),
    requestId: z.int().nonnegative(),
    query: z.string().max(512),
  }),
  /** The user picked a popup item; the host turns it into a chip (or an error). */
  z.strictObject({ type: z.literal('mention.pick'), item: MentionItem }),
]);
export type WebviewToExtension = z.infer<typeof WebviewToExtension>;
export type WebviewMessageType = WebviewToExtension['type'];

export const ExtensionToWebview = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('init'),
    view: ViewId,
    devMode: z.boolean(),
    showcase: z.boolean(),
  }),
  z.object({ type: z.literal('showcase'), enabled: z.boolean() }),
  /** Sent after `init` to the panel: the persisted draft and this workspace's history. */
  z.object({
    type: z.literal('prompt.restore'),
    draft: PromptDraft,
    history: z.array(z.string()),
  }),
  z.object({ type: z.literal('prompt.config'), config: PromptConfig }),
  z.object({ type: z.literal('prompt.focus') }),
  z.object({ type: z.literal('prompt.addChip'), chip: PromptChip }),
  /** Replace the input text (example prompts, UI-6's "Try it"). */
  z.object({ type: z.literal('prompt.fill'), text: z.string() }),
  z.object({
    type: z.literal('prompt.sent'),
    taskId: z.string(),
    history: z.array(z.string()),
    /** The validated `task.create` params; only echoed by the mock client. */
    echo: z.unknown().optional(),
  }),
  z.object({ type: z.literal('prompt.error'), message: z.string() }),
  z.object({ type: z.literal('prompt.tasks'), active: z.array(ActiveTask) }),
  z.object({
    type: z.literal('mention.results'),
    requestId: z.int().nonnegative(),
    items: z.array(MentionItem),
  }),
]);
export type ExtensionToWebview = z.infer<typeof ExtensionToWebview>;
