import { ModelError } from './errors.ts';
import type { StreamEvent, ToolCallRequest } from './types.ts';

export interface CollectedTurn {
  text: string;
  toolCalls: ToolCallRequest[];
  usage?: { inputTokens: number; outputTokens: number };
}

/** Drains a stream into one turn. An `error` event is thrown as a `ModelError`. */
export async function collectTurn(stream: AsyncIterable<StreamEvent>): Promise<CollectedTurn> {
  const turn: CollectedTurn = { text: '', toolCalls: [] };
  for await (const event of stream) {
    switch (event.type) {
      case 'text_delta':
        turn.text += event.text;
        break;
      case 'tool_call':
        turn.toolCalls.push(event.call);
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
