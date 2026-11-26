import type { ClientMethod, ParamsInputOf, ResultOf } from '@desiide/protocol';
import type { SettingsToWebview } from '../../shared/settings.ts';
import type { RawDesiideSettings } from './config.ts';
import type { SettingKey, SettingsDeps } from './service.ts';

type Handlers = {
  [M in ClientMethod]?: (params: ParamsInputOf<M>) => ResultOf<M> | Promise<ResultOf<M>>;
};

/** In-memory `SettingsDeps` for tests: settings, SecretStorage, project file, posts and logs. */
export function fakeSettingsDeps(opts: {
  settings?: Record<string, unknown>;
  workspace?: boolean;
  running?: boolean;
  handlers?: Handlers;
  request?: SettingsDeps['orchestrator']['request'];
  projectFile?: string;
}) {
  const settings = new Map<string, unknown>(Object.entries(opts.settings ?? {}));
  const secrets = new Map<string, string>();
  const posts: SettingsToWebview[] = [];
  const logs: string[] = [];
  const writes: Array<[SettingKey, unknown]> = [];
  const requests: Array<[ClientMethod, unknown]> = [];
  let projectFile = opts.projectFile;
  const at = (level: string) => (m: string) => logs.push(`${level}: ${m}`);
  const deps: SettingsDeps = {
    readRaw: (): RawDesiideSettings => ({
      models: settings.get('models'),
      roles: settings.get('roles'),
      jev: {
        enabled: settings.get('jev.enabled'),
        endpoint: settings.get('jev.endpoint'),
        apiKey: settings.get('jev.apiKey'),
        redactPaths: settings.get('jev.redactPaths'),
      },
      gating: { mode: settings.get('gating.mode'), thresholds: settings.get('gating.thresholds') },
    }),
    write: (key, value) => {
      writes.push([key, value]);
      if (value === undefined) settings.delete(key);
      else settings.set(key, value);
      return Promise.resolve();
    },
    secrets: {
      get: (name) => Promise.resolve(secrets.get(name)),
      store: (name, value) => {
        secrets.set(name, value);
        return Promise.resolve();
      },
      delete: (name) => {
        secrets.delete(name);
        return Promise.resolve();
      },
    },
    redactSalt: () => 'c'.repeat(64),
    hasWorkspace: () => opts.workspace ?? true,
    orchestrator: {
      isRunning: () => opts.running ?? true,
      request:
        opts.request ??
        (async <M extends ClientMethod>(method: M, params: ParamsInputOf<M>) => {
          requests.push([method, params]);
          const handler = opts.handlers?.[method] as
            ((p: ParamsInputOf<M>) => ResultOf<M> | Promise<ResultOf<M>>) | undefined;
          if (handler) return handler(params);
          if (method === 'config.update') return { ok: true } as ResultOf<M>;
          throw new Error(`no handler for ${method}`);
        }),
    },
    project: {
      read: () => Promise.resolve(projectFile),
      write: (text) => {
        projectFile = text;
        return Promise.resolve();
      },
      markers: () => Promise.resolve({ packageJson: '{"scripts":{"test":"vitest"}}' }),
    },
    post: (m) => posts.push(m),
    log: { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') },
    tryIt: () => Promise.resolve(),
    openJson: () => Promise.resolve(),
  };
  return {
    deps,
    settings,
    secrets,
    posts,
    logs,
    writes,
    requests,
    projectFile: () => projectFile,
  };
}
