import { collectTurn } from './stream.ts';
import type { CompleteRequest, ModelAdapter } from './types.ts';

const COMPLETE_SYSTEM =
  'You are a coding assistant. Reply with only the requested code or text, without commentary or Markdown fences.';

/** Native completion when the adapter has one, otherwise a single tool-less chat turn. */
export async function complete(
  adapter: ModelAdapter,
  req: CompleteRequest,
  signal: AbortSignal,
): Promise<string> {
  if (adapter.complete) return adapter.complete(req, signal);
  const turn = await collectTurn(
    adapter.chat(
      {
        system: COMPLETE_SYSTEM,
        messages: [{ role: 'user', content: `${req.codeContext}\n\n${req.instruction}` }],
        ...(req.maxTokens === undefined ? {} : { maxTokens: req.maxTokens }),
      },
      signal,
    ),
  );
  return turn.text;
}
