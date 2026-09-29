import { defineConfig } from 'vitest/config';

export default defineConfig({
  oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
  test: {
    include: ['src/**/*.test.ts', 'shared/**/*.test.ts', 'webview/**/*.test.{ts,tsx}'],
  },
});
