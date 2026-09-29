/** Typed wrapper over the webview API VS Code injects. */
export interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare global {
  // Injected by VS Code into webviews; callable only once per page.
  function acquireVsCodeApi(): VsCodeApi;
}

let api: VsCodeApi | undefined;

export function getVsCodeApi(): VsCodeApi {
  api ??= acquireVsCodeApi();
  return api;
}
