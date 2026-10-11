import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The python component compiles in a few hundred milliseconds; a whole
    // fixture suite through it is seconds, not minutes.
    testTimeout: 30_000,
  },
});
