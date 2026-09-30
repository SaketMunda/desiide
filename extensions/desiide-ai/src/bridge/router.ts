import type { WebviewMessageType, WebviewToExtension } from '../../shared/messages.ts';
import { WebviewToExtension as WebviewToExtensionSchema } from '../../shared/messages.ts';
import type { Logger } from '../log.ts';

type Handler<T extends WebviewMessageType> = (
  message: Extract<WebviewToExtension, { type: T }>,
) => unknown;

export interface MessageRouter {
  on<T extends WebviewMessageType>(type: T, handler: Handler<T>): void;
  /** Validates and dispatches. Never throws: malformed messages and handler errors are logged. */
  handle(raw: unknown): Promise<boolean>;
}

export function createMessageRouter(source: string, log: Logger): MessageRouter {
  const handlers = new Map<WebviewMessageType, (message: WebviewToExtension) => unknown>();

  return {
    on(type, handler) {
      handlers.set(type, handler as (message: WebviewToExtension) => unknown);
    },
    async handle(raw) {
      const parsed = WebviewToExtensionSchema.safeParse(raw);
      if (!parsed.success) {
        // Log the shape of the problem, never the payload itself (it may be large or sensitive).
        const issues = parsed.error.issues
          .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
          .join('; ');
        log.warn(`Rejected malformed message from ${source} webview (${issues})`);
        return false;
      }
      const handler = handlers.get(parsed.data.type);
      if (!handler) {
        log.debug(`No handler for "${parsed.data.type}" from ${source} webview`);
        return false;
      }
      try {
        await handler(parsed.data);
        return true;
      } catch (err) {
        log.error(
          `Handler for "${parsed.data.type}" from ${source} webview failed: ${String(err)}`,
        );
        return false;
      }
    },
  };
}
