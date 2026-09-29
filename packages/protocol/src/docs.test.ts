import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TASK_EVENT_TYPES } from './events.ts';
import { ClientMethods, RpcErrorCode, ServerMethods, ServerNotifications } from './methods.ts';

const doc = readFileSync(new URL('../../../docs/protocol.md', import.meta.url), 'utf8');

describe('docs/protocol.md', () => {
  const names = [
    ...Object.keys(ClientMethods),
    ...Object.keys(ServerMethods),
    ...Object.keys(ServerNotifications),
    ...TASK_EVENT_TYPES,
    ...Object.keys(RpcErrorCode),
  ];

  it.each(names)('documents `%s`', (name) => {
    expect(doc).toContain(`\`${name}\``);
  });
});
