import type { ModelRegistry } from '@desiide/models';
import type { Host } from '../host/host.ts';

export function registerModelHandlers(host: Host, registry: ModelRegistry): void {
  host.register('models.list', (params, { signal }) => registry.list(params, signal));
  host.register('models.test', ({ modelId }, { signal }) => registry.test(modelId, signal));
}
