import { describe, expect, it } from 'vitest';
import { parseNdjson } from './ndjson.ts';

async function collect(chunks: Array<string | Uint8Array>) {
  async function* source() {
    yield* chunks;
  }
  const out = [];
  for await (const item of parseNdjson(source())) out.push(item);
  return out;
}

describe('parseNdjson', () => {
  const text = '{"a":1}\n{"b":"é"}\n\n{"c":[1,2]}';

  it('yields each line, whatever the chunk boundaries', async () => {
    const expected = [{ value: { a: 1 } }, { value: { b: 'é' } }, { value: { c: [1, 2] } }];
    for (let i = 0; i <= text.length; i++) {
      expect(await collect([text.slice(0, i), text.slice(i)])).toEqual(expected);
    }
  });

  it('handles byte splits inside a multi-byte character', async () => {
    const bytes = new TextEncoder().encode(text);
    for (let i = 0; i <= bytes.length; i++) {
      expect(await collect([bytes.slice(0, i), bytes.slice(i)])).toHaveLength(3);
    }
  });

  it('accepts CRLF and reports non-JSON lines instead of throwing', async () => {
    expect(await collect(['{"a":1}\r\nnot json\r\n'])).toEqual([
      { value: { a: 1 } },
      { invalid: 'not json' },
    ]);
  });
});
