import { useCallback, useEffect, useState } from 'preact/hooks';
import { ExtensionToWebview, type WebviewToExtension } from '../shared/messages.ts';
import { getVsCodeApi } from './vscode.ts';

type Listener = (message: ExtensionToWebview) => void;
const listeners = new Set<Listener>();
let listening = false;

export function post(message: WebviewToExtension): void {
  getVsCodeApi().postMessage(message);
}

/**
 * Parse a message from the extension. Unknown or malformed messages are reported back to the
 * extension's log and dropped, never thrown.
 */
export function receive(raw: unknown): ExtensionToWebview | undefined {
  const parsed = ExtensionToWebview.safeParse(raw);
  if (parsed.success) return parsed.data;
  const type =
    typeof raw === 'object' && raw !== null && 'type' in raw ? String(raw.type).slice(0, 64) : '?';
  post({ type: 'log', level: 'warn', message: `Dropped malformed message (type "${type}")` });
  return undefined;
}

function ensureListening(): void {
  if (listening) return;
  listening = true;
  window.addEventListener('message', (event: MessageEvent<unknown>) => {
    const message = receive(event.data);
    if (message) for (const l of listeners) l(message);
  });
}

/** Subscribe to validated messages from the extension, outside a component (stores). */
export function subscribe(listener: Listener): () => void {
  ensureListening();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Subscribe to validated messages from the extension. */
export function useBridge(listener: Listener): { post: typeof post } {
  useEffect(() => subscribe(listener), [listener]);
  return { post };
}

function readState(): Record<string, unknown> {
  const state = getVsCodeApi().getState();
  return typeof state === 'object' && state !== null ? (state as Record<string, unknown>) : {};
}

/**
 * `useState` that survives the webview being hidden and restored (via `vscode.getState/setState`).
 * `isValid` guards against stale shapes from older versions.
 */
export function usePersistentState<T>(
  key: string,
  initial: T,
  isValid: (value: unknown) => value is T,
): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    const stored = readState()[key];
    return isValid(stored) ? stored : initial;
  });
  const set = useCallback(
    (next: T) => {
      setValue(next);
      getVsCodeApi().setState({ ...readState(), [key]: next });
    },
    [key],
  );
  return [value, set];
}

export const isBoolean = (v: unknown): v is boolean => typeof v === 'boolean';
