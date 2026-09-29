import { performance } from 'node:perf_hooks';
import * as vscode from 'vscode';
import type { ViewId } from '../shared/messages.ts';
import type { CommandHandlers } from './commands.ts';
import type { Logger } from './log.ts';
import { formatStatus, type StatusState } from './status.ts';
import { MuttViewProvider, VIEW_TYPES } from './views/MuttViewProvider.ts';

/** Returned from `activate` so integration tests (and later modules) can observe the shell. */
export interface MuttApi {
  readonly activationMs: number;
  readonly readyViews: ReadonlySet<ViewId>;
  setStatus(state: StatusState): void;
}

export function activate(context: vscode.ExtensionContext): MuttApi {
  const start = performance.now();
  const channel = vscode.window.createOutputChannel('Mutt', { log: true });
  const log: Logger = channel;
  const devMode = context.extensionMode !== vscode.ExtensionMode.Production;
  const readyViews = new Set<ViewId>();

  const host = {
    devMode,
    showcase: false,
    onReady: (view: ViewId) => readyViews.add(view),
  };
  const providers = {
    panel: new MuttViewProvider('panel', context.extensionUri, host, log),
    decisions: new MuttViewProvider('decisions', context.extensionUri, host, log),
  } satisfies Record<ViewId, MuttViewProvider>;

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.name = 'Mutt';
  status.command = 'mutt.focus';
  const setStatus = (state: StatusState): void => {
    const view = formatStatus(state);
    status.text = view.text;
    status.tooltip = view.tooltip;
  };
  setStatus({ runningTasks: 0 });
  status.show();

  const commands: CommandHandlers = {
    'mutt.focus': () => vscode.commands.executeCommand(`${VIEW_TYPES.panel}.focus`),
    'mutt.showLog': () => channel.show(true),
    'mutt.dev.showcase': () => {
      if (!devMode) {
        log.warn('mutt.dev.showcase is only available in development builds');
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
  void vscode.commands.executeCommand('setContext', 'mutt.devMode', devMode);

  const activationMs = performance.now() - start;
  log.info(`Mutt activated in ${activationMs.toFixed(1)} ms`);
  return { activationMs, readyViews, setStatus };
}

export function deactivate(): void {
  // Disposables are released through context.subscriptions.
}
