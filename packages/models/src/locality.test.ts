import { describe, expect, it } from 'vitest';
import { inferLocality } from './locality.ts';

describe('inferLocality', () => {
  it.each([
    [{ provider: 'ollama' as const }, 'local'],
    [{ provider: 'ollama' as const, baseUrl: 'https://ollama.example.com/v1' }, 'local'],
    [{ provider: 'openai-compatible' as const, baseUrl: 'http://localhost:1234/v1' }, 'local'],
    [{ provider: 'openai-compatible' as const, baseUrl: 'http://127.0.0.1:8080/v1' }, 'local'],
    [{ provider: 'openai-compatible' as const, baseUrl: 'http://[::1]:8080/v1' }, 'local'],
    [{ provider: 'openai-compatible' as const, baseUrl: 'http://llm.localhost/v1' }, 'local'],
    [{ provider: 'openai-compatible' as const, baseUrl: 'https://api.openai.com/v1' }, 'cloud'],
    [{ provider: 'openai-compatible' as const, baseUrl: 'http://192.168.1.20:8000/v1' }, 'cloud'],
    [{ provider: 'openai-compatible' as const, baseUrl: 'http://localhost.evil.com/v1' }, 'cloud'],
    [{ provider: 'openai-compatible' as const, baseUrl: 'http://127.0.0.1.nip.io/v1' }, 'cloud'],
    [{ provider: 'openai-compatible' as const }, 'cloud'],
    [{ provider: 'anthropic' as const }, 'cloud'],
  ])('%o → %s', (config, expected) => {
    expect(inferLocality(config)).toBe(expected);
  });

  it('an explicit setting wins both ways', () => {
    expect(
      inferLocality({
        provider: 'openai-compatible',
        baseUrl: 'http://10.0.0.5/v1',
        locality: 'local',
      }),
    ).toBe('local');
    expect(inferLocality({ provider: 'ollama', locality: 'cloud' })).toBe('cloud');
  });
});
