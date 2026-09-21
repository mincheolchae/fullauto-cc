import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Integration tests spawn real `git` in temp dirs; keep them serial so
    // fixture directories don't race on cleanup.
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
