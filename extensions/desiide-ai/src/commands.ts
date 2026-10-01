/** Every `desiide.*` command. `package.json` must contribute exactly these (checked by a test). */
export const COMMAND_IDS = [
  'desiide.focus',
  'desiide.showLog',
  'desiide.restartOrchestrator',
  'desiide.dev.showcase',
] as const;
export type CommandId = (typeof COMMAND_IDS)[number];

export type CommandHandlers = Record<CommandId, (...args: unknown[]) => unknown>;
