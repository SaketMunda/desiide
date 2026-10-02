import { performance } from 'node:perf_hooks';
import * as vscode from 'vscode';
import type { ViewId } from '../shared/messages.ts';
import { shouldOpenWelcome, WALKTHROUGH_ID, WELCOME_SHOWN_KEY } from './appWelcome.ts';
import type { CommandHandlers } from './commands.ts';
import type { Logger } from './log.ts';
import { OrchestratorClient } from './orchestrator/client.ts';
import {
  RESTART_ACTION,
  SHOW_LOG_ACTION,
  secretStorageKey,
  statusNotice,
} from './orchestrator/notice.ts';
import { PromptController } from './prompt/controller.ts';
import { FallbackTaskClient, MockTaskClient, orchestratorTaskClient } from './prompt/taskClient.ts';
import { formatStatus, type StatusState } from './status.ts';
import { DesiideViewProvider, VIEW_TYPES } from './views/DesiideViewProvider.ts';

/** Returned from `activate` so integration tests (and later modules) can observe the shell. */
export interface DesiideApi {
  readonly activationMs: number;
  readonly readyViews: ReadonlySet<ViewId>;
  /** True once the app-only first-run walkthrough has been opened (always false in stock VS Code). */
  readonly welcomeOpened: boolean;
  /** Spawned lazily on the first request; never during activation. */
  readonly orchestrator: OrchestratorClient;
  /** Host side of the Prompt Box (UI-2). `fill` lets onboarding (UI-6) prefill a sample task. */
  readonly prompt: Pick<PromptController, 'fill' | 'focus' | 'searchFiles'>;
  setStatus(state: StatusState): void;
}

let orchestrator: OrchestratorClient | undefined;

export function activate(context: vscode.ExtensionContext): DesiideApi {
  const start = performance.now();
  const channel = vscode.window.createOutputChannel('Desiide', { log: true });
  const log: Logger = channel;
  const devMode = context.extensionMode !== vscode.ExtensionMode.Production;
  const readyViews = new Set<ViewId>();

  // Views are constructed before the controller that listens to them; it is attached below.
  const late: { prompt?: PromptController } = {};
  const host = {
    devMode,
    showcase: false,
    onReady: (view: ViewId) => {
      readyViews.add(view);
      if (view === 'panel') late.prompt?.onReady();
    },
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

  const client = new OrchestratorClient({
    modulePath: vscode.Uri.joinPath(context.extensionUri, 'dist', 'orchestrator.js').fsPath,
    logDir: context.logUri.fsPath,
    logLevel: devMode ? 'debug' : 'info',
    workspaceRoots: () =>
      (vscode.workspace.workspaceFolders ?? [])
        .filter((folder) => folder.uri.scheme === 'file')
        .map((folder) => folder.uri.fsPath),
    client: {
      name: 'desiide-ai',
      version: (context.extension.packageJSON as { version?: string }).version ?? '0.0.0',
    },
    secrets: async (ref) => (await context.secrets.get(secretStorageKey(ref))) ?? null,
    log,
  });
  orchestrator = client;
  const restartOrchestrator = (): Promise<void> =>
    client.restart().catch((err: unknown) => {
      log.error(`Orchestrator restart failed: ${String(err)}`);
    });
  client.onStatus((state) => {
    const notice = statusNotice(state);
    if (!notice) return;
    void vscode.window.showErrorMessage(notice.message, ...notice.actions).then((action) => {
      if (action === RESTART_ACTION) void restartOrchestrator();
      else if (action === SHOW_LOG_ACTION) channel.show(true);
    });
  });

  // The engine behind `task.create` (COR-2) may not be registered yet; until it is, sends are
  // echoed by the mock (UI-2 mock strategy).
  const tasks = new FallbackTaskClient(orchestratorTaskClient(client), new MockTaskClient(), () =>
    late.prompt?.onFallbackToMock(),
  );
  const promptController = new PromptController(
    providers.panel,
    tasks,
    context.workspaceState,
    log,
  );
  late.prompt = promptController;
  const focusPanel = () => vscode.commands.executeCommand(`${VIEW_TYPES.panel}.focus`);

  const focusPrompt = async (): Promise<void> => {
    await focusPanel();
    promptController.focus();
  };

  const commands: CommandHandlers = {
    // The app binds Cmd/Ctrl+L to `desiide.focus` (EDT-2), so it lands in the Prompt Box too.
    'desiide.focus': focusPrompt,
    'desiide.focusPrompt': focusPrompt,
    'desiide.addSelectionToPrompt': async () => {
      const error = promptController.addActiveSelection();
      if (error) {
        void vscode.window.showInformationMessage(error);
        return;
      }
      await focusPanel();
    },
    'desiide.setup': () =>
      vscode.commands.executeCommand(
        'workbench.action.openWalkthrough',
        `${context.extension.id}#${WALKTHROUGH_ID}`,
        false,
      ),
    'desiide.showLog': () => channel.show(true),
    'desiide.restartOrchestrator': restartOrchestrator,
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
    promptController,
    { dispose: () => void client.dispose() },
    ...(Object.keys(providers) as ViewId[]).map((view) =>
      vscode.window.registerWebviewViewProvider(VIEW_TYPES[view], providers[view]),
    ),
    ...Object.entries(commands).map(([id, handler]) =>
      vscode.commands.registerCommand(id, handler),
    ),
  );
  void vscode.commands.executeCommand('setContext', 'desiide.devMode', devMode);

  // App build only: open the walkthrough on first run (EDT-2). In stock VS Code this is a no-op.
  let welcomeOpened = false;
  if (shouldOpenWelcome(vscode.env.appName, context.globalState.get(WELCOME_SHOWN_KEY) === true)) {
    void context.globalState.update(WELCOME_SHOWN_KEY, true);
    vscode.commands
      .executeCommand(
        'workbench.action.openWalkthrough',
        `${context.extension.id}#${WALKTHROUGH_ID}`,
      )
      .then(
        () => (welcomeOpened = true),
        (err: unknown) => log.warn(`Could not open the welcome walkthrough: ${String(err)}`),
      );
  }

  const activationMs = performance.now() - start;
  log.info(`Desiide activated in ${activationMs.toFixed(1)} ms`);
  return {
    activationMs,
    readyViews,
    get welcomeOpened() {
      return welcomeOpened;
    },
    orchestrator: client,
    prompt: promptController,
    setStatus,
  };
}

/** Returning the promise gives the orchestrator its SIGTERM grace period before the host exits. */
export function deactivate(): Promise<void> | undefined {
  const client = orchestrator;
  orchestrator = undefined;
  return client?.dispose();
}
