import { ModelError } from './errors.ts';
import type { ProviderState, StreamEvent, ToolCallRequest } from './types.ts';

export interface CollectedTurn {
  text: string;
  /** Shown only; never put into history (ADR-022). */
  reasoning: string;
  toolCalls: ToolCallRequest[];
  providerState?: ProviderState;
  usage?: { inputTokens: number; outputTokens: number };
}

/** Drains a stream into one turn. An `error` event is thrown as a `ModelError`. */
export async function collectTurn(stream: AsyncIterable<StreamEvent>): Promise<CollectedTurn> {
  const turn: CollectedTurn = { text: '', reasoning: '', toolCalls: [] };
  for await (const event of stream) {
    switch (event.type) {
      case 'text_delta':
        turn.text += event.text;
        break;
      case 'reasoning_delta':
        turn.reasoning += event.text;
        break;
      case 'tool_call':
        turn.toolCalls.push(event.call);
        break;
      case 'provider_state':
        turn.providerState = event.state;
        break;
      case 'usage':
        turn.usage = { inputTokens: event.inputTokens, outputTokens: event.outputTokens };
        break;
      case 'error': {
        const { kind, message, hint, status } = event.error;
        throw new ModelError(kind, message, {
          ...(hint === undefined ? {} : { hint }),
          ...(status === undefined ? {} : { status }),
        });
      }
      case 'done':
        return turn;
    }
  }
  return turn;
}
