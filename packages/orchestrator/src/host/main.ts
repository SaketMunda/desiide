// Orchestrator process entry, bundled to dist/orchestrator.js. Feature modules (COR-2, MOD-1,
// JEV-*) register their RPC handlers in `configure`. Unregistered methods answer NotImplemented.
import { startOrchestrator } from './start.ts';

startOrchestrator({
  argv: process.argv.slice(2),
  configure: () => {},
});
