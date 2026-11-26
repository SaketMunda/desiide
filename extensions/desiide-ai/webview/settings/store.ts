import { useCallback, useState } from 'preact/hooks';
import type { JevPackState, KnownPack } from '@desiide/protocol';
import type { ExtensionToWebview } from '../../shared/messages.ts';
import type {
  DiscoveredModel,
  HealthResult,
  SettingsSection,
  SettingsState,
} from '../../shared/settings.ts';
import { useBridge } from '../bridge.ts';

export interface Notice {
  id: number;
  level: 'info' | 'success' | 'warn' | 'error';
  message: string;
}

export interface SettingsStore {
  state: SettingsState | undefined;
  section: SettingsSection | undefined;
  discovery: { loading: boolean; models: DiscoveredModel[]; error?: string; done: boolean };
  tests: Record<string, { testing: boolean; result?: HealthResult }>;
  preview: { pack: KnownPack; loading: boolean; state?: JevPackState; error?: string } | undefined;
  jevTest: { loading: boolean; result?: HealthResult } | undefined;
  notices: Notice[];
}

let nextNotice = 1;

/** Everything the host tells the settings page. Keys never come back this way. */
export function useSettingsStore() {
  const [store, setStore] = useState<SettingsStore>({
    state: undefined,
    section: undefined,
    discovery: { loading: false, models: [], done: false },
    tests: {},
    preview: undefined,
    jevTest: undefined,
    notices: [],
  });

  const onMessage = useCallback((m: ExtensionToWebview) => {
    setStore((s) => {
      switch (m.type) {
        case 'settings.state':
          return { ...s, state: m.state };
        case 'settings.show':
          return { ...s, section: m.section };
        case 'settings.discovered':
          return {
            ...s,
            discovery: {
              loading: false,
              models: m.models,
              done: true,
              ...(m.error ? { error: m.error } : {}),
            },
          };
        case 'settings.modelTesting':
          return { ...s, tests: { ...s.tests, [m.id]: { testing: true } } };
        case 'settings.modelTest':
          return { ...s, tests: { ...s.tests, [m.id]: { testing: false, result: m.result } } };
        case 'settings.jevPreview':
          return {
            ...s,
            preview: {
              pack: m.pack,
              loading: false,
              ...(m.state ? { state: m.state } : {}),
              ...(m.error ? { error: m.error } : {}),
            },
          };
        case 'settings.jevTest':
          return { ...s, jevTest: { loading: false, result: m.result } };
        case 'settings.notice':
          return {
            ...s,
            notices: [
              ...s.notices.slice(-2),
              { id: nextNotice++, level: m.level, message: m.message },
            ],
          };
        default:
          return s;
      }
    });
  }, []);
  useBridge(onMessage);

  const update = useCallback(
    (patch: Partial<SettingsStore>) => setStore((s) => ({ ...s, ...patch })),
    [],
  );
  const dismiss = useCallback(
    (id: number) => setStore((s) => ({ ...s, notices: s.notices.filter((n) => n.id !== id) })),
    [],
  );
  return { store, update, dismiss };
}
