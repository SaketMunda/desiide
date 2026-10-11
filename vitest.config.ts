import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      'packages/*',
      'extensions/*',
      // Repo tooling: release helpers run by the CI workflows (REL-1).
      { test: { name: 'scripts', include: ['scripts/**/*.test.ts'] } },
    ],
  },
});
