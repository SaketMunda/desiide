import { performance } from 'node:perf_hooks';
import * as vscode from 'vscode';
import type { ViewId } from '../shared/messages.ts';
import type { CommandHandlers } from './commands.ts';
import type { Logger } from './log.ts';
import { formatStatus, type StatusState } from './status.ts';
import { DesiideViewProvider, VIEW_TYPES } from './views/DesiideViewProvider.ts';

/** Returned from `activate` so integration tests (and later modules) can observe the shell. */
export interface DesiideApi {
  readonly activationMs: number;
  readonly readyViews: ReadonlySet<ViewId>;
  setStatus(state: StatusState): void;
}

export function activate(context: vscode.ExtensionContext): DesiideApi {
  const start = performance.now();
  const channel = vscode.window.createOutputChannel('Desiide', { log: true });
  const log: Logger = channel;
  const devMode = context.extensionMode !== vscode.ExtensionMode.Production;
  const readyViews = new Set<ViewId>();

  const host = {
    devMode,
    showcase: false,
    onReady: (view: ViewId) => readyViews.add(view),
  };
  const providers = {
    panel: new DesiideViewProvider('panel', context.extensionUri, host, log),
    decisions: new DesiideViewProvider('decisions', context.extensionUri, host, log),
  } satisfies Record<ViewId, DesiideViewProvider>;

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.name = 'Desiide';
  status.command = 'desiide.focus';
  const setStatus = (state: StatusState): void => {
    const view = formatStatus(state);
    status.text = view.text;
    status.tooltip = view.tooltip;
  };
  setStatus({ runningTasks: 0 });
  status.show();

  const commands: CommandHandlers = {
    'desiide.focus': () => vscode.commands.executeCommand(`${VIEW_TYPES.panel}.focus`),
    'desiide.showLog': () => channel.show(true),
    'desiide.dev.showcase': () => {
      if (!devMode) {
        log.warn('desiide.dev.showcase is only available in development builds');
        return undefined;
      }
      host.showcase = !host.showcase;
      for (const p of Object.values(providers))
        p.post({ type: 'showcase', enabled: host.showcase });
      log.info(`UI kit showcase ${host.showcase ? 'on' : 'off'}`);
      return vscode.commands.executeCommand(`${VIEW_TYPES.panel}.focus`);
    },
  };

  context.subscriptions.push(
    channel,
    status,
    ...(Object.keys(providers) as ViewId[]).map((view) =>
      vscode.window.registerWebviewViewProvider(VIEW_TYPES[view], providers[view]),
    ),
    ...Object.entries(commands).map(([id, handler]) =>
      vscode.commands.registerCommand(id, handler),
    ),
  );
  void vscode.commands.executeCommand('setContext', 'desiide.devMode', devMode);

  const activationMs = performance.now() - start;
  log.info(`Desiide activated in ${activationMs.toFixed(1)} ms`);
  return { activationMs, readyViews, setStatus };
}

export function deactivate(): void {
  // Disposables are released through context.subscriptions.
}
