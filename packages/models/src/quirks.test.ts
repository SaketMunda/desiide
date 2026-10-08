import { describe, expect, it } from 'vitest';
import { ModelError } from './errors.ts';
import { adaptQuirks, resolveQuirks } from './quirks.ts';

describe('resolveQuirks', () => {
  it.each([
    ['https://api.openai.com/v1', { streamUsage: true, maxTokensField: 'max_completion_tokens' }],
    [
      'https://me.openai.azure.com/openai',
      { streamUsage: true, maxTokensField: 'max_completion_tokens' },
    ],
    ['https://api.mistral.ai/v1', { streamUsage: false, maxTokensField: 'max_tokens' }],
    ['https://openrouter.ai/api/v1', { streamUsage: true, maxTokensField: 'max_tokens' }],
    ['http://localhost:1234/v1', { streamUsage: true, maxTokensField: 'max_tokens' }],
    [undefined, { streamUsage: true, maxTokensField: 'max_tokens' }],
  ])('%s', (baseUrl, expected) => {
    expect(resolveQuirks(baseUrl ? { baseUrl } : {})).toEqual(expected);
  });

  it('explicit config wins over the host table', () => {
    expect(
      resolveQuirks({
        baseUrl: 'https://api.openai.com/v1',
        quirks: { maxTokensField: 'max_tokens', streamUsage: false },
      }),
    ).toEqual({ streamUsage: false, maxTokensField: 'max_tokens' });
  });
});

describe('adaptQuirks', () => {
  const base = { streamUsage: true, maxTokensField: 'max_tokens' } as const;
  const bad = (message: string) => new ModelError('bad_request', message);

  it('drops stream_options when the server rejects it', () => {
    expect(
      adaptQuirks(bad('Unrecognized request argument supplied: stream_options'), base),
    ).toEqual({ streamUsage: false, maxTokensField: 'max_tokens' });
  });

  it('switches the max-tokens field both ways', () => {
    expect(
      adaptQuirks(bad("Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens'."), base),
    ).toEqual({ streamUsage: true, maxTokensField: 'max_completion_tokens' });
    expect(
      adaptQuirks(bad('unknown field max_completion_tokens'), {
        streamUsage: false,
        maxTokensField: 'max_completion_tokens',
      }),
    ).toEqual({ streamUsage: false, maxTokensField: 'max_tokens' });
  });

  it('ignores unrelated errors and non-request errors', () => {
    expect(adaptQuirks(bad('model not found'), base)).toBeUndefined();
    expect(adaptQuirks(new ModelError('server', 'stream_options'), base)).toBeUndefined();
    expect(adaptQuirks(new Error('stream_options'), base)).toBeUndefined();
    expect(
      adaptQuirks(bad('stream_options'), { streamUsage: false, maxTokensField: 'max_tokens' }),
    ).toBeUndefined();
  });
});
