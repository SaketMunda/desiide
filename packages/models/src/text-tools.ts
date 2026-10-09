import type { ChatMessage, StreamEvent, ToolSpec } from './types.ts';

/**
 * Tool calling for models without a native tool API: the tools are described in the system prompt,
 * the model writes `<tool_call>{"name", "arguments"}</tool_call>` blocks (the format Qwen and
 * Hermes-style models are trained on), and results come back as `<tool_result>` blocks in a user
 * turn. The adapter turns the blocks into normal `tool_call` events, so the agent loop can't tell.
 */
const OPEN = '<tool_call>';
const CLOSE = '</tool_call>';

export function textToolsSystem(system: string | undefined, tools: readonly ToolSpec[]): string {
  const list = tools
    .map(
      (t) =>
        `- ${t.name}: ${t.description}\n  Arguments (JSON Schema): ${JSON.stringify(t.inputSchema)}`,
    )
    .join('\n');
  const instructions = [
    'You can call tools. To call one, write a block exactly like this:',
    `${OPEN}\n{"name": "<tool name>", "arguments": {<arguments as JSON>}}\n${CLOSE}`,
    'Put each call in its own block. After your tool calls, stop and wait: the results arrive in',
    '<tool_result> blocks in the next message. Only call the tools listed here.',
    '',
    'Tools:',
    list,
  ].join('\n');
  return system ? `${system}\n\n${instructions}` : instructions;
}

const escapeAttr = (value: string): string =>
  value.replace(/[&"<>]/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * Rewrites history for a model without tool roles: assistant tool calls become `<tool_call>` text,
 * and each run of tool results becomes one user turn of `<tool_result>` blocks.
 */
export function textToolsMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role === 'assistant') {
      const calls = (m.toolCalls ?? []).map((c) => {
        let args: unknown = c.args;
        try {
          args = JSON.parse(c.args) as unknown;
        } catch {
          // Malformed args are shown as the model wrote them.
        }
        return `${OPEN}\n${JSON.stringify({ name: c.name, arguments: args })}\n${CLOSE}`;
      });
      out.push({ role: 'assistant', content: [m.content, ...calls].filter(Boolean).join('\n') });
    } else if (m.role === 'tool') {
      const block = `<tool_result name="${escapeAttr(m.name)}"${m.isError ? ' error="true"' : ''}>\n${m.content}\n</tool_result>`;
      const prev = out.at(-1);
      if (prev?.role === 'user' && prev.content.endsWith('</tool_result>')) {
        prev.content += `\n${block}`;
      } else {
        out.push({ role: 'user', content: block });
      }
    } else {
      out.push({ ...m });
    }
  }
  return out;
}

type Parsed = Extract<StreamEvent, { type: 'text_delta' | 'tool_call' }>;

/** Length of the longest suffix of `text` that is a prefix of `tag` (a tag split across chunks). */
function partialTag(text: string, tag: string): number {
  for (let n = Math.min(tag.length - 1, text.length); n > 0; n--) {
    if (text.endsWith(tag.slice(0, n))) return n;
  }
  return 0;
}

function toCall(body: string, makeId: () => string): Parsed | undefined {
  const json = body
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  try {
    const value = JSON.parse(json) as unknown;
    if (typeof value === 'object' && value !== null && 'name' in value) {
      const { name } = value;
      const args =
        'arguments' in value ? value.arguments : 'parameters' in value ? value.parameters : {};
      if (typeof name === 'string' && name !== '') {
        return {
          type: 'tool_call',
          call: {
            id: makeId(),
            name,
            args: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
          },
        };
      }
    }
  } catch {
    // Fall through: maybe only the arguments are broken.
  }
  // Keep the call if the name is readable, so the loop can tell the model its arguments are bad.
  const name = /"name"\s*:\s*"([^"]+)"/.exec(json)?.[1];
  if (!name) return undefined;
  return { type: 'tool_call', call: { id: makeId(), name, args: json } };
}

/**
 * Splits streamed text into `text_delta` and `tool_call` events. Text that might be the start of a
 * `<tool_call>` tag is held back until the next chunk decides it.
 */
export function createTextToolParser(makeId: () => string) {
  let buffer = '';
  let inCall = false;

  const drain = (final: boolean): Parsed[] => {
    const events: Parsed[] = [];
    for (;;) {
      if (!inCall) {
        const open = buffer.indexOf(OPEN);
        if (open === -1) {
          const keep = final ? 0 : partialTag(buffer, OPEN);
          const text = buffer.slice(0, buffer.length - keep);
          if (text !== '') events.push({ type: 'text_delta', text });
          buffer = buffer.slice(buffer.length - keep);
          return events;
        }
        const text = buffer.slice(0, open).replace(/\s+$/, '');
        if (text !== '') events.push({ type: 'text_delta', text });
        buffer = buffer.slice(open + OPEN.length);
        inCall = true;
      }
      const close = buffer.indexOf(CLOSE);
      if (close === -1 && !final) return events;
      const body = close === -1 ? buffer : buffer.slice(0, close);
      buffer = close === -1 ? '' : buffer.slice(close + CLOSE.length).replace(/^\s+/, '');
      inCall = false;
      const call = toCall(body, makeId);
      if (call) events.push(call);
      else if (body.trim() !== '') events.push({ type: 'text_delta', text: `${OPEN}${body}` });
      if (final && buffer === '') return events;
    }
  };

  return {
    push(text: string): Parsed[] {
      buffer += text;
      return drain(false);
    },
    end(): Parsed[] {
      return drain(true);
    },
  };
}
