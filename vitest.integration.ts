import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      // Same package aliases as vite.config.ts / tsconfig paths: packages/db
      // re-exports from @mailcopilot/core, so the suite cannot load without them.
      '@mailcopilot/types': resolve(__dirname, 'packages/types'),
      '@mailcopilot/core': resolve(__dirname, 'packages/core'),
    },
  },
  test: {
    include: ['tests/integration/**/*.test.ts'],
    testTimeout: 180_000, // 3 min per test (AI calls are slow)
    hookTimeout: 120_000, // 2 min for setup/teardown
  },
})
