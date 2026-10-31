import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['server/test/**/*.test.ts', 'sdk/test/**/*.test.ts'],
    testTimeout: 20000,
    hookTimeout: 30000,
    fileParallelism: true,
  },
});
