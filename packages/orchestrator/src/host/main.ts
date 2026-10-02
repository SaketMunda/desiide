// Orchestrator process entry, bundled to dist/orchestrator.js. Feature modules (JEV-*, COR-4/5)
// register their RPC handlers in `configure`. Unregistered methods answer NotImplemented.
import { BUILTIN_PROVIDERS, createModelRegistry } from '@desiide/models';
import { registerConfigUpdate } from '../config/handler.ts';
import { registerModelHandlers } from '../models/handlers.ts';
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
    registerConfigUpdate(host, [(config) => models.configure(config)]);
    registerTaskEngine(host, { models, logger: logger.child({ component: 'tasks' }) });
  },
});
