/** Every `mutt.*` command. `package.json` must contribute exactly these (checked by a test). */
export const COMMAND_IDS = ['mutt.focus', 'mutt.showLog', 'mutt.dev.showcase'] as const;
export type CommandId = (typeof COMMAND_IDS)[number];

export type CommandHandlers = Record<CommandId, (...args: unknown[]) => unknown>;
