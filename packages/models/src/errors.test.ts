import { describe, expect, it } from 'vitest';
import { ModelError, toModelError } from './errors.ts';
import { redact, redactHeaders } from './redact.ts';

const SENTINEL = 'sk-SENTINEL-0123456789abcdef';

describe('redact', () => {
  it('removes known secret values', () => {
    expect(redact(`key is ${SENTINEL}!`, [SENTINEL])).toBe('key is ***!');
  });

  it('removes credential shapes it was not told about', () => {
    expect(redact('Authorization: Bearer abc.def-ghi')).not.toContain('abc.def-ghi');
    expect(redact('https://x.example/v1?key=AIzaSECRET&alt=sse')).toBe(
      'https://x.example/v1?key=***&alt=sse',
    );
    expect(redact('{"x-api-key":"zzzSECRETzzz"}')).not.toContain('zzzSECRETzzz');
    expect(redact('token sk-proj-ABCDEFGHIJKL')).toBe('token ***');
  });

  it('ignores very short values so text is not mangled', () => {
    expect(redact('a b c', ['a'])).toBe('a b c');
  });

  it('masks secret headers by name', () => {
    expect(
      redactHeaders({ Authorization: 'Bearer x', 'x-api-key': 'y', accept: 'text/event-stream' }),
    ).toEqual({ Authorization: '***', 'x-api-key': '***', accept: 'text/event-stream' });
  });
});

describe('ModelError', () => {
  it('redacts message and hint and drops the cause', () => {
    const error = new ModelError('auth', `bad key ${SENTINEL}`, {
      hint: `try ${SENTINEL}`,
      secrets: [SENTINEL],
      cause: new Error(SENTINEL),
      status: 401,
    });
    expect(
      JSON.stringify({ ...error, message: error.message, info: error.toInfo() }),
    ).not.toContain(SENTINEL);
    expect(error.cause).toBeUndefined();
    expect(error.toInfo()).toEqual({
      kind: 'auth',
      message: 'bad key ***',
      hint: 'try ***',
      status: 401,
    });
  });

  it('toModelError maps aborts to cancelled and unknowns to unknown', () => {
    const controller = new AbortController();
    controller.abort();
    expect(toModelError(new Error('x'), controller.signal).kind).toBe('cancelled');
    expect(toModelError('boom').kind).toBe('unknown');
    const original = new ModelError('timeout', 't');
    expect(toModelError(original)).toBe(original);
  });
});
