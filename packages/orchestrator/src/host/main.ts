// Orchestrator process entry, bundled to dist/orchestrator.js. Feature modules (JEV-*, COR-4/5)
// register their RPC handlers in `configure`. Unregistered methods answer NotImplemented.
import { BUILTIN_PROVIDERS, createModelRegistry } from '@desiide/models';
import { randomUUID } from 'node:crypto';
import { registerConfigUpdate } from '../config/handler.ts';
import { createContextEngine } from '../context/engine.ts';
import { registerModelHandlers } from '../models/handlers.ts';
import { createWorkspacePolicy } from '../policy/workspacePolicy.ts';
import { registerTaskEngine } from '../tasks/engine.ts';
import { startOrchestrator } from './start.ts';

startOrchestrator({
  argv: process.argv.slice(2),
  configure: (host, { logger }) => {
    const models = createModelRegistry({
      providers: BUILTIN_PROVIDERS,
      requestSecret: (ref, signal) => host.requestSecret(ref, signal),
      logger: logger.child({ component: 'models' }),
    });
    registerModelHandlers(host, models);
    const policy = createWorkspacePolicy(host, {
      logger: logger.child({ component: 'policy' }),
      newId: () => randomUUID(),
    });
    registerConfigUpdate(host, [(config) => models.configure(config), policy.onConfig]);
    const context = createContextEngine({
      workspaceRoots: () => host.session?.workspaceRoots,
      trackProcessGroup: (pid) => host.trackProcessGroup(pid),
      logger: logger.child({ component: 'context' }),
    });
    registerTaskEngine(host, {
      models,
      gate: () => policy.gate,
      context,
      logger: logger.child({ component: 'tasks' }),
    });
  },
});
