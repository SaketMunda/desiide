import { describe, expect, it } from 'vitest';
import { parseSse, type ParseSseOptions, type SseEvent } from './sse.ts';

async function* from<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) yield item;
}

async function parse(
  chunks: Array<string | Uint8Array>,
  options?: ParseSseOptions,
): Promise<SseEvent[]> {
  const out: SseEvent[] = [];
  for await (const event of parseSse(from(chunks), options)) out.push(event);
  return out;
}

const STREAM = [
  ': keep-alive comment',
  'event: message_start',
  'data: {"a":1}',
  '',
  'data: line one',
  'data: line two',
  'id: 7',
  '',
  'data:no-space',
  '',
  'data: héllo 🌍',
  '',
  'data: [DONE]',
  '',
  'data: after done',
  '',
].join('\n');

const EXPECTED: SseEvent[] = [
  { event: 'message_start', data: '{"a":1}' },
  { data: 'line one\nline two', id: '7' },
  // The last event id carries over (WHATWG "last event ID buffer").
  { data: 'no-space', id: '7' },
  { data: 'héllo 🌍', id: '7' },
];

describe('parseSse', () => {
  it('parses events, multi-line data, comments and stops at [DONE]', async () => {
    expect(await parse([STREAM])).toEqual(EXPECTED);
  });

  it('gives the same result for every split point (string chunks)', async () => {
    for (const eol of ['\n', '\r\n', '\r']) {
      const text = STREAM.replaceAll('\n', eol);
      for (let i = 0; i <= text.length; i++) {
        expect(
          await parse([text.slice(0, i), text.slice(i)]),
          `eol=${JSON.stringify(eol)} split=${i}`,
        ).toEqual(EXPECTED);
      }
    }
  });

  it('gives the same result for every byte split, including inside UTF-8 characters', async () => {
    const bytes = new TextEncoder().encode(STREAM.replaceAll('\n', '\r\n'));
    for (let i = 0; i <= bytes.length; i++) {
      expect(await parse([bytes.slice(0, i), bytes.slice(i)]), `split=${i}`).toEqual(EXPECTED);
    }
  });

  it('handles one-byte chunks', async () => {
    const bytes = new TextEncoder().encode(STREAM);
    expect(await parse([...bytes].map((b) => Uint8Array.of(b)))).toEqual(EXPECTED);
  });

  it('treats CR then LF across chunks as one line break', async () => {
    expect(await parse(['data: a\r', '\n\r', '\ndata: b\r\n\r\n'])).toEqual([
      { data: 'a' },
      { data: 'b' },
    ]);
  });

  it('delivers a final event without a trailing blank line', async () => {
    expect(await parse(['data: tail'])).toEqual([{ data: 'tail' }]);
  });

  it('ignores events with no data and unknown fields', async () => {
    expect(await parse(['event: ping\n\nretry: 10\nfoo: bar\ndata: x\n\n'])).toEqual([
      { data: 'x' },
    ]);
  });

  it('keeps empty data lines and a lone "data" field', async () => {
    expect(await parse(['data\ndata:\ndata: z\n\n'])).toEqual([{ data: '\n\nz' }]);
  });

  it('does not stop at [DONE] when disabled', async () => {
    expect(await parse(['data: [DONE]\n\n'], { stopAtDone: false })).toEqual([{ data: '[DONE]' }]);
  });

  it('stops reading the source after [DONE]', async () => {
    let pulled = 0;
    async function* source(): AsyncGenerator<string> {
      pulled++;
      yield 'data: [DONE]\n\n';
      pulled++;
      yield 'data: never\n\n';
    }
    const out: SseEvent[] = [];
    for await (const e of parseSse(source())) out.push(e);
    expect(out).toEqual([]);
    expect(pulled).toBe(1);
  });
});
