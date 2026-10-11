import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.test.ts'],
    // Every test file runs in a throwaway home with usage statistics off, and a
    // request to any host but loopback fails the test that made it.
    setupFiles: ['src/pipelex/__tests__/usageStatsIsolation.ts'],
  },
});
