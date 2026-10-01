// Test-only entry: a handler that writes to stdout in every way it can. Bundled by stdout.test.ts.
import { startOrchestrator } from '../start.ts';

startOrchestrator({
  argv: process.argv.slice(2),
  configure: (host) => {
    host.register('task.list', () => {
      console.log('console.log from a handler');
      console.info('console.info', { nested: true });
      console.debug('console.debug');
      process.stdout.write('process.stdout.write from a handler\n');
      return { tasks: [] };
    });
  },
});
