import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // The pipeline tests use an injected clock and fake providers, so no timing
    // should ever be relied on; a short timeout surfaces accidental real I/O.
    testTimeout: 15_000,
    hookTimeout: 15_000,
    reporters: ['default'],
  },
});
