import type Anthropic from '@anthropic-ai/sdk';
import * as z from 'zod';
import type { ChatMessage, ProviderState, ToolSpec } from './types.ts';

/** The API allows four `cache_control` breakpoints per request. */
const MAX_BREAKPOINTS = 4;
const EPHEMERAL: Anthropic.CacheControlEphemeral = { type: 'ephemeral' };

/**
 * What the adapter keeps in an assistant turn's `providerState`: the turn's content blocks exactly
 * as returned, when they include thinking. Anthropic requires signed thinking blocks to come back
 * unmodified and in order during tool use (ADR-022), so the turn is replayed verbatim.
 */
const ReplayBlock = z.union([
  z.object({ type: z.literal('thinking'), thinking: z.string(), signature: z.string() }),
  z.object({ type: z.literal('redacted_thinking'), data: z.string() }),
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('tool_use'),
    id: z.string().min(1),
    name: z.string().min(1),
    input: z.record(z.string(), z.unknown()),
  }),
]);
export type ReplayBlock = z.infer<typeof ReplayBlock>;
export const AnthropicTurnState = z.object({ blocks: z.array(ReplayBlock).min(1) });
export type AnthropicTurnState = z.infer<typeof AnthropicTurnState>;

/** The stored blocks, if `state` belongs to `owner` and is well-formed; otherwise `undefined`. */
export function replayBlocks(
  state: ProviderState | undefined,
  owner: string,
): ReplayBlock[] | undefined {
  if (!state || state.owner !== owner) return undefined;
  const parsed = AnthropicTurnState.safeParse(state.data);
  return parsed.success ? parsed.data.blocks : undefined;
}

function parseInput(args: string): Record<string, unknown> {
  try {
    const value = JSON.parse(args) as unknown;
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

type Block = Anthropic.ContentBlockParam;
type CacheableBlock = Anthropic.TextBlockParam | Anthropic.ToolResultBlockParam;
interface Turn {
  role: 'user' | 'assistant';
  content: Block[];
}

/**
 * Normalized history → Anthropic turns:
 * - Turns alternate: consecutive same-role messages merge into one turn.
 * - Tool results are `tool_result` blocks in the user turn right after the assistant's `tool_use`,
 *   ahead of any text in that turn.
 * - An assistant turn this adapter produced with thinking is replayed from its `providerState`.
 * - Pairing is repaired rather than sent broken (the API rejects both): a `tool_use` with no
 *   result gets an error result, and a result with no `tool_use` becomes plain text.
 * - Empty text is dropped (the API rejects empty text blocks), and so is a turn left empty.
 */
export function toAnthropicMessages(
  messages: readonly ChatMessage[],
  owner: string,
): { messages: Anthropic.MessageParam[]; cacheable: CacheableBlock[] } {
  const turns: Turn[] = [];
  // Blocks of `cacheable` messages: candidates for a cache breakpoint.
  const flagged = new Set<Block>();
  const push = (role: Turn['role'], blocks: Block[]): void => {
    if (blocks.length === 0) return;
    const last = turns.at(-1);
    if (last?.role === role) {
      if (role === 'user') {
        // Tool results lead the user turn.
        const results = blocks.filter((b) => b.type === 'tool_result');
        const rest = blocks.filter((b) => b.type !== 'tool_result');
        const firstText = last.content.findIndex((b) => b.type !== 'tool_result');
        if (firstText === -1) last.content.push(...results);
        else last.content.splice(firstText, 0, ...results);
        last.content.push(...rest);
      } else {
        last.content.push(...blocks);
      }
      return;
    }
    turns.push({ role, content: [...blocks] });
  };

  for (const m of messages) {
    if (m.role === 'user') {
      if (m.content === '') continue;
      const block: Anthropic.TextBlockParam = { type: 'text', text: m.content };
      if (m.cacheable) flagged.add(block);
      push('user', [block]);
    } else if (m.role === 'assistant') {
      const replay = replayBlocks(m.providerState, owner);
      if (replay) {
        push('assistant', replay.map(toParam));
        continue;
      }
      const blocks: Block[] = m.content === '' ? [] : [{ type: 'text', text: m.content }];
      for (const call of m.toolCalls ?? []) {
        blocks.push({
          type: 'tool_use',
          id: call.id,
          name: call.name,
          input: parseInput(call.args),
        });
      }
      push('assistant', blocks);
    } else {
      const block: Anthropic.ToolResultBlockParam = {
        type: 'tool_result',
        tool_use_id: m.toolCallId,
        content: m.content === '' ? '(no output)' : m.content,
        ...(m.isError ? { is_error: true } : {}),
      };
      if (m.cacheable) flagged.add(block);
      push('user', [block]);
    }
  }

  repairPairing(turns);
  const sent = turns.filter((t) => t.content.length > 0);
  // One candidate per turn, its last flagged block: two breakpoints in one turn waste one.
  const cacheable = sent.flatMap((t) => {
    const last = t.content.findLast((b): b is CacheableBlock => flagged.has(b));
    return last ? [last] : [];
  });
  return { messages: sent.map((t) => ({ role: t.role, content: t.content })), cacheable };
}

function toParam(block: ReplayBlock): Block {
  return block;
}

function repairPairing(turns: Turn[]): void {
  for (let i = 0; i < turns.length; i += 1) {
    const turn = turns[i];
    if (!turn) continue;
    if (turn.role === 'assistant') {
      const ids = turn.content.flatMap((b) => (b.type === 'tool_use' ? [b.id] : []));
      if (ids.length === 0) continue;
      let next = turns[i + 1];
      if (next?.role !== 'user') {
        next = { role: 'user', content: [] };
        turns.splice(i + 1, 0, next);
      }
      const answered = new Set(
        next.content.flatMap((b) => (b.type === 'tool_result' ? [b.tool_use_id] : [])),
      );
      const missing: Block[] = ids
        .filter((id) => !answered.has(id))
        .map((id) => ({
          type: 'tool_result',
          tool_use_id: id,
          content: 'No result was recorded for this call.',
          is_error: true,
        }));
      next.content.unshift(...missing);
    } else {
      const prev = turns[i - 1];
      const asked = new Set(
        prev?.role === 'assistant'
          ? prev.content.flatMap((b) => (b.type === 'tool_use' ? [b.id] : []))
          : [],
      );
      turn.content = turn.content.map((b) =>
        b.type === 'tool_result' && !asked.has(b.tool_use_id)
          ? { type: 'text', text: `Tool result (${b.tool_use_id}):\n${resultText(b)}` }
          : b,
      );
    }
  }
}

function resultText(block: Anthropic.ToolResultBlockParam): string {
  return typeof block.content === 'string' ? block.content : '';
}

/**
 * Tool input streams as it's generated (`eager_input_streaming`); buffered, a large edit would
 * arrive in one burst after a long silence that looks like a stalled stream.
 */
export function toAnthropicTools(tools: readonly ToolSpec[]): Anthropic.Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: { type: 'object', ...t.inputSchema },
    eager_input_streaming: true,
  }));
}

/**
 * Prompt-cache breakpoints, only on sections the caller marked stable: the system prompt (which
 * also covers the tools rendered before it) and `cacheable` messages, latest first, up to
 * the API's limit. Mutates the blocks in place.
 */
export function placeCacheBreakpoints(
  system: Anthropic.TextBlockParam[],
  cacheable: readonly CacheableBlock[],
): void {
  const lastSystem = system.at(-1);
  if (lastSystem) lastSystem.cache_control = EPHEMERAL;
  const left = MAX_BREAKPOINTS - (lastSystem ? 1 : 0);
  // The latest marks cover the longest stable prefix; earlier ones are found by lookback.
  for (const block of cacheable.slice(-left)) block.cache_control = EPHEMERAL;
}
