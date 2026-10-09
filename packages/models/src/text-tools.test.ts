import { describe, expect, it } from 'vitest';
import { createTextToolParser, textToolsMessages, textToolsSystem } from './text-tools.ts';

const ids = () => {
  let n = 0;
  return () => `t${++n}`;
};

function run(chunks: string[]) {
  const parser = createTextToolParser(ids());
  const events = chunks.flatMap((c) => parser.push(c));
  return [...events, ...parser.end()];
}

const text = (events: ReturnType<typeof run>) =>
  events.flatMap((e) => (e.type === 'text_delta' ? [e.text] : [])).join('');
const calls = (events: ReturnType<typeof run>) =>
  events.flatMap((e) => (e.type === 'tool_call' ? [e.call] : []));

describe('createTextToolParser', () => {
  const reply =
    'Let me look.\n<tool_call>\n{"name": "read_file", "arguments": {"path": "a.ts"}}\n</tool_call>\n<tool_call>{"name":"read_file","arguments":{"path":"b.ts"}}</tool_call>';

  it('extracts calls and text at every split point', () => {
    for (let i = 0; i <= reply.length; i++) {
      const events = run([reply.slice(0, i), reply.slice(i)]);
      expect(text(events).trimEnd()).toBe('Let me look.');
      expect(calls(events)).toEqual([
        { id: 't1', name: 'read_file', args: '{"path":"a.ts"}' },
        { id: 't2', name: 'read_file', args: '{"path":"b.ts"}' },
      ]);
    }
  });

  it('streams plain text without holding it back, except a possible tag start', () => {
    const parser = createTextToolParser(ids());
    expect(parser.push('Hello <to')).toEqual([{ type: 'text_delta', text: 'Hello ' }]);
    expect(parser.push('day')).toEqual([{ type: 'text_delta', text: '<today' }]);
    expect(parser.end()).toEqual([]);
  });

  it('accepts fenced JSON and `parameters`, and keeps calls with broken args', () => {
    const events = run([
      '<tool_call>```json\n{"name":"a","parameters":{"x":1}}\n```</tool_call>',
      '<tool_call>{"name": "b", "arguments": {"x": </tool_call>',
    ]);
    expect(calls(events)).toEqual([
      { id: 't1', name: 'a', args: '{"x":1}' },
      { id: 't2', name: 'b', args: '{"name": "b", "arguments": {"x":' },
    ]);
  });

  it('a block without a readable name is text; an unterminated block is parsed at the end', () => {
    expect(text(run(['<tool_call>nonsense</tool_call>']))).toBe('<tool_call>nonsense');
    expect(calls(run(['<tool_call>{"name":"a","arguments":{}}']))).toEqual([
      { id: 't1', name: 'a', args: '{}' },
    ]);
  });
});

describe('textToolsSystem / textToolsMessages', () => {
  it('describes the tools after the caller system prompt', () => {
    const system = textToolsSystem('Be brief.', [
      { name: 'read_file', description: 'Read a file', inputSchema: { type: 'object' } },
    ]);
    expect(system.startsWith('Be brief.\n\n')).toBe(true);
    expect(system).toContain('- read_file: Read a file');
    expect(system).toContain('<tool_call>');
  });

  it('turns tool history into text turns and merges consecutive results', () => {
    expect(
      textToolsMessages([
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: 'ok',
          toolCalls: [
            { id: '1', name: 'a', args: '{"x":1}' },
            { id: '2', name: 'b', args: 'not json' },
          ],
        },
        { role: 'tool', toolCallId: '1', name: 'a', content: 'one' },
        { role: 'tool', toolCallId: '2', name: 'b"<', content: 'two', isError: true },
        { role: 'assistant', content: 'done' },
      ]),
    ).toEqual([
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content:
          'ok\n<tool_call>\n{"name":"a","arguments":{"x":1}}\n</tool_call>\n<tool_call>\n{"name":"b","arguments":"not json"}\n</tool_call>',
      },
      {
        role: 'user',
        content:
          '<tool_result name="a">\none\n</tool_result>\n<tool_result name="b&#34;&#60;" error="true">\ntwo\n</tool_result>',
      },
      { role: 'assistant', content: 'done' },
    ]);
  });
});
