import type { ChatMessage } from './types.ts';

/**
 * The history to send to `adapterId`: provider state another adapter owns is dropped, e.g. after a
 * cascade escalates to a different model (ADR-022). Messages without foreign state are kept as-is.
 */
export function historyFor(messages: readonly ChatMessage[], adapterId: string): ChatMessage[] {
  return messages.map((m) => {
    if (m.role !== 'assistant' || !m.providerState || m.providerState.owner === adapterId) return m;
    return { role: m.role, content: m.content, ...(m.toolCalls ? { toolCalls: m.toolCalls } : {}) };
  });
}
