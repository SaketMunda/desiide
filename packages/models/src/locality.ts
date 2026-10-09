import type { ModelConfig, ModelLocality } from '@desiide/protocol';

const LOOPBACK_HOSTS = new Set(['localhost', '[::1]', '::1']);

/** True for `localhost`, `*.localhost`, `127.x.x.x` and `::1`. */
export function isLoopback(baseUrl: string): boolean {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  return (
    LOOPBACK_HOSTS.has(host) || host.endsWith('.localhost') || /^127(\.\d{1,3}){3}$/.test(host)
  );
}

/**
 * Where a model runs. An explicit `locality` in the config wins. Otherwise Ollama and loopback
 * endpoints count as local. Everything else counts as cloud, including LAN addresses, because
 * claiming "local" wrongly would route private context off the machine.
 */
export function inferLocality(
  config: Pick<ModelConfig, 'provider' | 'baseUrl' | 'locality'>,
): ModelLocality {
  if (config.locality) return config.locality;
  if (config.provider === 'ollama') return 'local';
  if (config.baseUrl && isLoopback(config.baseUrl)) return 'local';
  return 'cloud';
}
