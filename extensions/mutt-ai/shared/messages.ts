import * as z from 'zod';

/**
 * Messages between the extension host and the webviews. Both sides validate everything they
 * receive; UI modules add new message types here (additively, like the RPC protocol).
 */

export const ViewId = z.enum(['panel', 'decisions']);
export type ViewId = z.infer<typeof ViewId>;

/** Commands a webview may ask the extension to run. Anything else is rejected. */
export const WebviewCommand = z.enum(['mutt.showLog', 'mutt.dev.showcase']);
export type WebviewCommand = z.infer<typeof WebviewCommand>;

export const WebviewToExtension = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('ready'), view: ViewId }),
  z.strictObject({ type: z.literal('command'), command: WebviewCommand }),
  z.strictObject({
    type: z.literal('log'),
    level: z.enum(['info', 'warn', 'error']),
    message: z.string().max(2000),
  }),
]);
export type WebviewToExtension = z.infer<typeof WebviewToExtension>;
export type WebviewMessageType = WebviewToExtension['type'];

export const ExtensionToWebview = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('init'),
    view: ViewId,
    devMode: z.boolean(),
    showcase: z.boolean(),
  }),
  z.object({ type: z.literal('showcase'), enabled: z.boolean() }),
]);
export type ExtensionToWebview = z.infer<typeof ExtensionToWebview>;
