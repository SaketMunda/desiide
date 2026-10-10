import { describe, expect, it } from 'vitest';
import { detectLanguage } from './language.ts';

describe('detectLanguage', () => {
  it.each([
    ['src/a.ts', 'typescript'],
    ['src/App.TSX', 'typescriptreact'],
    ['lib/x.py', 'python'],
    ['cmd/main.go', 'go'],
    ['Dockerfile', 'dockerfile'],
    ['build/Dockerfile.prod', 'dockerfile'],
    ['Makefile', 'makefile'],
    ['infra/main.tf', 'terraform'],
    ['.env', 'dotenv'],
    ['.env.local', 'dotenv'],
    ['.github/workflows/ci.yml', 'yaml'],
    ['README', 'plaintext'],
    ['notes.unknownext', 'plaintext'],
    ['.gitignore', 'ignore'],
  ])('%s → %s', (path, lang) => {
    expect(detectLanguage(path)).toBe(lang);
  });
});
