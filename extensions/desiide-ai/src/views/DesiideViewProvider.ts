import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { ExtensionToWebview, ViewId } from '../../shared/messages.ts';
import { createMessageRouter, type MessageRouter } from '../bridge/router.ts';
import type { Logger } from '../log.ts';
import { buildWebviewHtml } from './html.ts';

export { VIEW_TYPES } from './viewTypes.ts';

const TITLES: Record<ViewId, string> = { panel: 'Desiide', decisions: 'Decisions' };

export interface ViewHost {
  readonly devMode: boolean;
  showcase: boolean;
  /** Called once a view's script has loaded under the CSP and sent `ready`. */
  onReady(view: ViewId): void;
}

export class DesiideViewProvider implements vscode.WebviewViewProvider {
  private webviewView: vscode.WebviewView | undefined;
  private ready = false;
  readonly router: MessageRouter;

  constructor(
    private readonly view: ViewId,
    private readonly extensionUri: vscode.Uri,
    private readonly host: ViewHost,
    private readonly log: Logger,
  ) {
    this.router = createMessageRouter(view, log);
    this.router.on('ready', () => {
      this.ready = true;
      this.post({
        type: 'init',
        view: this.view,
        devMode: host.devMode,
        showcase: host.showcase,
      });
      host.onReady(this.view);
    });
    this.router.on('command', ({ command }) => vscode.commands.executeCommand(command));
    this.router.on('log', ({ level, message }) => log[level](`[${view} webview] ${message}`));
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.webviewView = webviewView;
    this.ready = false;
    const dist = vscode.Uri.joinPath(this.extensionUri, 'dist');
    const webview = webviewView.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(dist, 'webview'),
        vscode.Uri.joinPath(dist, 'codicons'),
      ],
    };
    const asUri = (...parts: string[]): string =>
      webview.asWebviewUri(vscode.Uri.joinPath(dist, ...parts)).toString();
    webview.html = buildWebviewHtml({
      view: this.view,
      nonce: randomBytes(16).toString('base64'),
      cspSource: webview.cspSource,
      scriptUri: asUri('webview', 'main.js'),
      styleUri: asUri('webview', 'main.css'),
      codiconUri: asUri('codicons', 'codicon.css'),
      title: TITLES[this.view],
    });
    webview.onDidReceiveMessage((raw: unknown) => void this.router.handle(raw));
    webviewView.onDidDispose(() => {
      this.webviewView = undefined;
      this.ready = false;
    });
  }

  /** True once the current webview's script has loaded and said `ready`; messages before that are lost. */
  get isReady(): boolean {
    return this.ready;
  }

  post(message: ExtensionToWebview): void {
    void this.webviewView?.webview.postMessage(message);
  }

  reveal(): void {
    this.webviewView?.show(true);
  }
}
