import * as vscode from 'vscode';
import type { TaskInput, TaskSummary } from '@desiide/protocol';
import type { Logger } from '../log.ts';
import type { PromptView } from '../prompt/controller.ts';
import { MOCK_ID_PREFIX, type TaskClient } from '../prompt/taskClient.ts';
import { formatToolOutput } from './output.ts';
import { TaskStore } from './taskStore.ts';

/** Starts tracking a task in the Prompt Box's active list (drives Stop). */
export type TrackTask = (task: TaskSummary) => void;

/**
 * Host side of the task stream (UI-3): retains this window's tasks, streams their events to the
 * panel, and handles the transcript's actions (cancel, retry, insert code, full tool output).
 */
export class TranscriptController implements vscode.Disposable {
  private readonly store: TaskStore;
  private readonly disposables: vscode.Disposable[] = [];
  private outputChannel: vscode.OutputChannel | undefined;
  private refreshing = false;

  constructor(
    private readonly view: PromptView,
    private readonly tasks: TaskClient,
    private readonly track: TrackTask,
    private readonly log: Logger,
  ) {
    // Events while the panel is closed are retained and replayed by the snapshot on `ready`.
    this.store = new TaskStore({ post: (m) => view.isReady && view.post(m) });
    const r = view.router;
    r.on('task.cancel', (m) => this.cancel(m.taskId));
    r.on('task.retry', (m) => this.retry(m.taskId));
    r.on('code.insert', (m) => this.insert(m.code));
    r.on('tool.openOutput', (m) => this.openOutput(m.taskId, m.callId));
    this.disposables.push(
      tasks.onEvent((event) => {
        if (this.store.onEvent(event) && !event.taskId.startsWith(MOCK_ID_PREFIX)) {
          void this.refresh();
        }
      }),
    );
  }

  /** The panel webview (re)loaded. */
  onReady(): void {
    this.view.post({ type: 'tasks.snapshot', tasks: this.store.snapshot() });
  }

  /** A task was created from this window. */
  created(task: TaskSummary, params: TaskInput): void {
    this.store.created(task, params);
  }

  dispose(): void {
    this.store.dispose();
    this.outputChannel?.dispose();
    for (const d of this.disposables) d.dispose();
  }

  /** A task ended: pull the engine's totals (iteration, cost, models) for the header. */
  private async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      this.store.refresh(await this.tasks.list());
    } catch (err) {
      this.log.debug(`task.list after a task ended failed: ${String(err)}`);
    } finally {
      this.refreshing = false;
    }
  }

  private async cancel(taskId: string): Promise<void> {
    try {
      const cancelled = await this.tasks.cancel(taskId);
      if (!cancelled) this.log.info(`task.cancel ${taskId}: already finished`);
    } catch (err) {
      this.fail(`Couldn't stop the task: ${message(err)}`);
    }
  }

  private async retry(taskId: string): Promise<void> {
    const params = this.store.params(taskId);
    if (!params) {
      this.fail("This task can't be retried: it wasn't started from this window.");
      return;
    }
    try {
      const task = await this.tasks.create(params);
      this.log.info(`task.retry ${taskId} → ${task.id}`);
      this.store.created(task, params);
      this.track(task);
      this.view.post({ type: 'tasks.select', taskId: task.id });
    } catch (err) {
      this.fail(`Couldn't retry the task: ${message(err)}`);
    }
  }

  private async insert(code: string): Promise<void> {
    const editor = vscode.window.activeTextEditor ?? vscode.window.visibleTextEditors[0];
    if (!editor) {
      void vscode.window.showInformationMessage('Open a file to insert the code into.');
      return;
    }
    const ok = await editor.edit((b) => {
      for (const s of editor.selections) b.replace(s, code);
    });
    if (!ok) {
      this.fail("Couldn't insert the code: the editor rejected the edit.");
      return;
    }
    await vscode.window.showTextDocument(editor.document, editor.viewColumn);
  }

  private openOutput(taskId: string, callId: string): void {
    const found = this.store.toolOutput(taskId, callId);
    if (!found) {
      this.fail('That tool output is no longer available.');
      return;
    }
    this.outputChannel ??= vscode.window.createOutputChannel('Desiide: Tool Output');
    this.outputChannel.replace(formatToolOutput(found));
    this.outputChannel.show(true);
  }

  private fail(text: string): void {
    this.log.warn(text);
    void vscode.window.showWarningMessage(text);
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
