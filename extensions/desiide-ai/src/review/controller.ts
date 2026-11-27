import * as vscode from 'vscode';
import type { TaskEvent } from '@desiide/protocol';
import type { ExtensionToWebview } from '../../shared/messages.ts';
import type { MessageRouter } from '../bridge/router.ts';
import type { Logger } from '../log.ts';
import { PROPOSED_SCHEME, parseProposedUri, proposedUriParts } from './proposedUri.ts';
import {
  ReviewService,
  type PendingItem,
  type ReviewRpc,
  type ReviewWorkspace,
} from './service.ts';
import { workspaceRoot } from './vscodeWorkspace.ts';

/** The panel view, as the controller needs it. */
export interface ReviewView {
  readonly router: MessageRouter;
  readonly isReady: boolean;
  /** The panel is on screen (no notification needed). */
  readonly visible: boolean;
  post(message: ExtensionToWebview): void;
  setBadge(count: number, tooltip: string): void;
}

export interface ReviewControllerOptions {
  panel: ReviewView;
  /** The Decisions view (UI-5), for "View decision". */
  decisions: { post(message: ExtensionToWebview): void };
  onEvent(listener: (event: TaskEvent) => void): { dispose(): void };
  rpc: ReviewRpc;
  workspace: ReviewWorkspace;
  /** Status bar highlight (extension.ts owns the item). */
  setPending(count: number): void;
  focusPanel(): Thenable<unknown>;
  log: Logger;
}

const EMPTY_QUERY = 'empty=1';

/**
 * Host side of review & approval (UI-4): the `desiide-proposed:` documents behind the native diff,
 * the card actions from the panel, and the "needs you" signals (view badge, status bar,
 * notification while the panel is hidden).
 */
export class ReviewController implements vscode.Disposable {
  readonly service: ReviewService;
  private readonly disposables: { dispose(): unknown }[] = [];
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  /** Pending items already announced, so each notifies at most once. */
  private readonly announced = new Set<string>();

  constructor(private readonly opts: ReviewControllerOptions) {
    this.service = new ReviewService({ workspace: opts.workspace, rpc: opts.rpc });
    const r = opts.panel.router;
    r.on('review.openDiff', (m) => this.openDiff(m.taskId, m.proposalId, m.path));
    r.on('review.submit', async (m) => {
      const out = await this.service.submit(m.taskId, m.proposalId, m.files, m.reason);
      if (!out.ok) this.warn(out.error);
    });
    r.on('approval.answer', async (m) => {
      const out = await this.service.answer(m.taskId, m.approvalId, m.answer, m.reason);
      if (!out.ok) this.warn(out.error);
    });
    r.on('decision.open', async (m) => {
      await vscode.commands.executeCommand('desiide.decisions.focus');
      opts.decisions.post({ type: 'decisions.focus', decisionId: m.decisionId });
    });

    const content: vscode.TextDocumentContentProvider = {
      onDidChange: this.changed.event,
      provideTextDocumentContent: async (uri) => {
        if (uri.query === EMPTY_QUERY) return '';
        const ref = parseProposedUri(uri);
        if (!ref) return '';
        const preview = await this.service.proposedText(ref.taskId, ref.proposalId, ref.path);
        return preview?.text ?? '';
      },
    };
    this.disposables.push(
      this.changed,
      vscode.workspace.registerTextDocumentContentProvider(PROPOSED_SCHEME, content),
      opts.onEvent((e) => this.service.onEvent(e)),
      this.service.onChange(() => this.publish()),
      // The proposed side follows the file as the user types (it's the blocks applied to it now).
      vscode.workspace.onDidChangeTextDocument((e) => this.refreshProposed(e.document.uri)),
    );
  }

  /** The panel webview (re)loaded. */
  onReady(): void {
    this.postState();
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }

  private publish(): void {
    this.postState();
    const pending = this.service.pending();
    const n = pending.length;
    this.opts.panel.setBadge(n, n === 1 ? '1 thing needs you' : `${n} things need you`);
    this.opts.setPending(n);
    this.notify(pending);
  }

  private postState(): void {
    if (!this.opts.panel.isReady) return;
    this.opts.panel.post({
      type: 'review.state',
      proposals: this.service.state(),
      reasons: this.service.reasons(),
    });
  }

  private notify(pending: PendingItem[]): void {
    const fresh = pending.filter((p) => !this.announced.has(`${p.taskId}/${p.id}`));
    for (const p of fresh) this.announced.add(`${p.taskId}/${p.id}`);
    const first = fresh[0];
    if (!first || this.opts.panel.visible) return;
    if (!vscode.workspace.getConfiguration('desiide').get<boolean>('review.notify', true)) return;
    const text =
      fresh.length === 1
        ? `Desiide needs you: ${first.label}`
        : `Desiide needs you (${fresh.length})`;
    void vscode.window.showInformationMessage(text, 'Review').then(async (pick) => {
      if (pick !== 'Review') return;
      await this.opts.focusPanel();
      this.opts.panel.post({ type: 'tasks.select', taskId: first.taskId });
    });
  }

  private async openDiff(taskId: string, proposalId: string, path: string): Promise<void> {
    const preview = await this.service.proposedText(taskId, proposalId, path);
    const root = workspaceRoot();
    if (!preview || !root) {
      this.warn(root ? 'That proposal is no longer available.' : 'Open a folder to review edits.');
      return;
    }
    const right = vscode.Uri.from({
      scheme: PROPOSED_SCHEME,
      ...proposedUriParts({ taskId, proposalId, path }),
    });
    const left = preview.exists
      ? vscode.Uri.joinPath(root, ...path.split('/'))
      : vscode.Uri.from({ scheme: PROPOSED_SCHEME, path: `/${path}`, query: EMPTY_QUERY });
    const name = path.split('/').at(-1) ?? path;
    await vscode.commands.executeCommand(
      'vscode.diff',
      left,
      right,
      `${name} (${preview.exists ? 'current' : 'new file'} ↔ proposed)`,
      { preview: true },
    );
    if (preview.stale) {
      void vscode.window.showWarningMessage(
        `${path} changed since this edit was proposed, so it no longer applies. Accepting it tells the agent to re-read the file and propose it again.`,
      );
    }
  }

  private refreshProposed(uri: vscode.Uri): void {
    if (uri.scheme === PROPOSED_SCHEME) return;
    const root = workspaceRoot();
    if (!root) return;
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.scheme !== PROPOSED_SCHEME) continue;
      const ref = parseProposedUri(doc.uri);
      if (ref && vscode.Uri.joinPath(root, ...ref.path.split('/')).toString() === uri.toString()) {
        this.changed.fire(doc.uri);
      }
    }
  }

  private warn(text: string): void {
    this.opts.log.warn(text);
    void vscode.window.showWarningMessage(text);
  }
}
