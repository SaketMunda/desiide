import { performance } from 'node:perf_hooks';
import * as vscode from 'vscode';
import type { Range } from '@desiide/protocol';
import type { ExtensionToWebview, MentionItem, WebviewToExtension } from '../../shared/messages.ts';
import type { MessageRouter } from '../bridge/router.ts';
import type { Logger } from '../log.ts';
import { ActiveTasks } from './activeTasks.ts';
import {
  DIFF_CHIP,
  excludeGlob,
  fileChip,
  folderChip,
  selectionChip,
  type ChipResult,
} from './chips.ts';
import { FileIndex, MAX_FILE_RESULTS, basename } from './fileIndex.ts';
import { EMPTY_DRAFT, pushHistory, readDraft, readHistory } from './history.ts';
import { buildTaskCreateParams } from './payload.ts';
import { parsePromptSettings, promptConfig, type PromptSettings } from './settings.ts';
import type { FallbackTaskClient } from './taskClient.ts';

const DRAFT_KEY = 'desiide.prompt.draft';
const HISTORY_KEY = 'desiide.prompt.history';
const MAX_INDEXED_FILES = 20_000;
const MAX_PENDING = 20;

/** The panel view, as the controller sees it. */
export interface PromptView {
  readonly router: MessageRouter;
  readonly isReady: boolean;
  post(message: ExtensionToWebview): void;
}

type Msg<T extends WebviewToExtension['type']> = Extract<WebviewToExtension, { type: T }>;

/**
 * Host side of the Prompt Box: answers the panel's messages, owns draft and history (per
 * workspace), the @-mention file index, and the tasks started from the box.
 */
export class PromptController implements vscode.Disposable {
  private readonly index: FileIndex;
  private readonly active = new ActiveTasks();
  private readonly disposables: vscode.Disposable[] = [];
  private pending: ExtensionToWebview[] = [];
  private search: AbortController | undefined;
  private watching = false;
  private loggedProblems = '';

  constructor(
    private readonly view: PromptView,
    private readonly tasks: FallbackTaskClient,
    private readonly state: vscode.Memento,
    private readonly log: Logger,
  ) {
    this.index = new FileIndex((signal) => this.listFiles(signal));
    const r = view.router;
    r.on('prompt.draft', (m) => this.state.update(DRAFT_KEY, m.draft));
    r.on('prompt.submit', (m) => this.submit(m));
    r.on('prompt.cancel', () => this.cancel());
    r.on('mention.search', (m) => this.searchMentions(m));
    r.on('mention.pick', (m) => this.pickMention(m.item));

    this.disposables.push(
      tasks.onEvent((event) => {
        if (this.active.apply(event))
          this.send({ type: 'prompt.tasks', active: this.active.list() });
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('desiide')) this.sendConfig();
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.index.invalidate()),
    );
  }

  /** The panel webview (re)loaded: restore its state and flush anything queued meanwhile. */
  onReady(): void {
    this.view.post({
      type: 'prompt.restore',
      draft: readDraft(this.state.get(DRAFT_KEY)),
      history: readHistory(this.state.get(HISTORY_KEY)),
    });
    this.sendConfig();
    this.view.post({ type: 'prompt.tasks', active: this.active.list() });
    const queued = this.pending;
    this.pending = [];
    for (const m of queued) this.view.post(m);
  }

  focus(): void {
    this.send({ type: 'prompt.focus' });
  }

  fill(text: string): void {
    this.send({ type: 'prompt.fill', text });
  }

  /** `desiide.addSelectionToPrompt`. Returns the error message, if any, for the caller to show. */
  addActiveSelection(): string | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return 'Open a file and select some code first.';
    const result = selectionChip(
      this.relativePath(editor.document.uri),
      toRange(editor.selection),
      editor.document.getText(editor.selection).length,
    );
    if (!result.ok) return result.message;
    this.send({ type: 'prompt.addChip', chip: result.chip });
    this.focus();
    return undefined;
  }

  onFallbackToMock(): void {
    this.log.info(
      'The task engine is not available yet (task.create not implemented); using the mock client.',
    );
    this.sendConfig();
  }

  dispose(): void {
    this.search?.abort();
    for (const d of this.disposables) d.dispose();
  }

  private send(message: ExtensionToWebview): void {
    if (this.view.isReady) this.view.post(message);
    else this.pending = [...this.pending, message].slice(-MAX_PENDING);
  }

  private settings(): PromptSettings {
    const cfg = vscode.workspace.getConfiguration('desiide');
    const settings = parsePromptSettings({
      models: cfg.get('models'),
      roles: cfg.get('roles'),
      defaultPreference: cfg.get('defaultPreference'),
    });
    const problems = settings.problems.join('; ');
    if (problems && problems !== this.loggedProblems) this.log.warn(`Settings: ${problems}`);
    this.loggedProblems = problems;
    return settings;
  }

  private sendConfig(): void {
    this.send({ type: 'prompt.config', config: promptConfig(this.settings(), this.tasks.mocked) });
  }

  private async submit(m: Msg<'prompt.submit'>): Promise<void> {
    if (!this.settings().models.length) {
      this.send({
        type: 'prompt.error',
        message: 'Connect a model first: run "Desiide: Set Up Models".',
      });
      return;
    }
    const built = buildTaskCreateParams({
      instruction: m.instruction,
      chips: m.chips,
      preference: m.preference,
      workflow: m.workflow,
      openEditors: this.openEditors(),
    });
    if (!built.ok) {
      this.send({ type: 'prompt.error', message: built.message });
      return;
    }
    try {
      const task = await this.tasks.create(built.params);
      this.active.add(task.id, task.state);
      const history = pushHistory(readHistory(this.state.get(HISTORY_KEY)), m.instruction);
      await this.state.update(HISTORY_KEY, history);
      await this.state.update(DRAFT_KEY, EMPTY_DRAFT);
      // Metadata only: prompts and file contents never go to the log at info level.
      this.log.info(
        `task.create → ${task.id} (kind ${built.params.kind}, ${built.params.context.refs.length} refs, ` +
          `${built.params.workflowOverride ?? 'auto'}, ${built.params.preference})`,
      );
      this.send({
        type: 'prompt.sent',
        taskId: task.id,
        history,
        ...(this.tasks.mocked ? { echo: built.params } : {}),
      });
      this.send({ type: 'prompt.tasks', active: this.active.list() });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error(`task.create failed: ${message}`);
      this.send({ type: 'prompt.error', message: `Couldn't start the task: ${message}` });
    }
  }

  private async cancel(): Promise<void> {
    const id = this.active.current();
    if (!id) {
      this.send({ type: 'prompt.tasks', active: [] });
      return;
    }
    try {
      const cancelled = await this.tasks.cancel(id);
      if (!cancelled) this.log.info(`task.cancel ${id}: already finished`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error(`task.cancel ${id} failed: ${message}`);
      this.send({ type: 'prompt.error', message: `Couldn't stop the task: ${message}` });
    }
  }

  private async searchMentions({ requestId, query }: Msg<'mention.search'>): Promise<void> {
    this.search?.abort();
    const search = new AbortController();
    this.search = search;
    this.ensureWatcher();
    const started = performance.now();
    try {
      const items = query.trim() === '' ? this.openEditorItems() : [];
      const found = items.length > 0 ? items : await this.index.search(query, search.signal);
      if (search.signal.aborted) return;
      this.log.debug(
        `@-search (${query.length} chars) → ${found.length} in ${(performance.now() - started).toFixed(1)} ms`,
      );
      this.send({ type: 'mention.results', requestId, items: found });
    } catch (err) {
      if (search.signal.aborted) return;
      this.log.warn(`@-search failed: ${String(err)}`);
      this.send({ type: 'mention.results', requestId, items: [] });
    }
  }

  private async pickMention(item: MentionItem): Promise<void> {
    let result: ChipResult;
    switch (item.kind) {
      case 'selection': {
        const error = this.addActiveSelection();
        if (error) this.send({ type: 'prompt.error', message: error });
        return;
      }
      case 'diff':
        result = { ok: true, chip: DIFF_CHIP };
        break;
      case 'folder':
        result = folderChip(item.path ?? '');
        break;
      case 'file':
        result = fileChip(item.path ?? '', await this.fileSize(item.path ?? ''));
        break;
    }
    this.send(
      result.ok
        ? { type: 'prompt.addChip', chip: result.chip }
        : { type: 'prompt.error', message: result.message },
    );
  }

  private async listFiles(signal: AbortSignal): Promise<string[]> {
    const source = new vscode.CancellationTokenSource();
    const onAbort = () => source.cancel();
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      const files = vscode.workspace
        .getConfiguration('files')
        .get<Record<string, unknown>>('exclude');
      const search = vscode.workspace
        .getConfiguration('search')
        .get<Record<string, unknown>>('exclude');
      const started = performance.now();
      const uris = await vscode.workspace.findFiles(
        '**/*',
        excludeGlob(files, search),
        MAX_INDEXED_FILES,
        source.token,
      );
      const paths = uris.flatMap((u) => this.relativePath(u) ?? []).sort();
      this.log.debug(
        `Indexed ${paths.length} files for @-mentions in ${(performance.now() - started).toFixed(0)} ms`,
      );
      if (paths.length >= MAX_INDEXED_FILES) {
        this.log.info(`@-mentions index capped at ${MAX_INDEXED_FILES} files`);
      }
      return paths;
    } finally {
      signal.removeEventListener('abort', onAbort);
      source.dispose();
    }
  }

  /** Created on the first @-search, not at activation, to keep activation cheap. */
  private ensureWatcher(): void {
    if (this.watching) return;
    this.watching = true;
    const watcher = vscode.workspace.createFileSystemWatcher('**/*', false, true, false);
    const invalidate = () => this.index.invalidate();
    this.disposables.push(
      watcher,
      watcher.onDidCreate(invalidate),
      watcher.onDidDelete(invalidate),
    );
  }

  private async fileSize(path: string): Promise<number | undefined> {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      try {
        return (await vscode.workspace.fs.stat(vscode.Uri.joinPath(folder.uri, path))).size;
      } catch {
        // not in this root; try the next
      }
    }
    return undefined;
  }

  /** Workspace-relative POSIX path, or undefined for files outside the workspace / non-file URIs. */
  private relativePath(uri: vscode.Uri): string | undefined {
    if (uri.scheme !== 'file' || !vscode.workspace.getWorkspaceFolder(uri)) return undefined;
    return vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
  }

  /** Open text editors, active first, as workspace-relative paths. */
  private openEditors(): string[] {
    const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs);
    tabs.sort(
      (a, b) => Number(b.isActive && b.group.isActive) - Number(a.isActive && a.group.isActive),
    );
    const paths = tabs.flatMap((t) =>
      t.input instanceof vscode.TabInputText ? (this.relativePath(t.input.uri) ?? []) : [],
    );
    return [...new Set(paths)];
  }

  private openEditorItems(): MentionItem[] {
    return this.openEditors()
      .slice(0, MAX_FILE_RESULTS)
      .map((path) => ({ kind: 'file', label: basename(path), detail: path, path }));
  }
}

function toRange(s: vscode.Selection): Range {
  return {
    start: { line: s.start.line, character: s.start.character },
    end: { line: s.end.line, character: s.end.character },
  };
}
