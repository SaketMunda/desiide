import { useCallback, useEffect, useState } from 'preact/hooks';
import type { ExtensionToWebview, ViewId } from '../../shared/messages.ts';
import { post, useBridge } from '../bridge.ts';
import { Button, EmptyState } from '../ui/index.ts';
import { Showcase } from './Showcase.tsx';

export interface AppProps {
  view: ViewId;
}

export function App({ view }: AppProps) {
  const [showcase, setShowcase] = useState(false);
  const [devMode, setDevMode] = useState(false);

  const onMessage = useCallback((m: ExtensionToWebview) => {
    if (m.type === 'init') {
      setShowcase(m.showcase);
      setDevMode(m.devMode);
    } else {
      setShowcase(m.enabled);
    }
  }, []);
  useBridge(onMessage);

  useEffect(() => post({ type: 'ready', view }), [view]);

  if (showcase) return <Showcase />;

  const devAction = devMode && (
    <Button
      variant="secondary"
      icon="symbol-color"
      onClick={() => post({ type: 'command', command: 'mutt.dev.showcase' })}
    >
      Show UI kit
    </Button>
  );

  return view === 'panel' ? (
    <EmptyState
      icon="sparkle"
      title="Mutt"
      description="Bring-your-own-model coding with visible routing and risk decisions. The prompt box arrives soon."
      action={devAction}
    />
  ) : (
    <EmptyState
      icon="law"
      title="No decisions yet"
      description="Routing and risk decisions for your tasks will appear here, with their reasons."
      action={devAction}
    />
  );
}
