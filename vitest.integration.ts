import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  resolve: {
    alias: { '@': resolve(__dirname, 'src') },
  },
  test: {
    include: ['tests/integration/**/*.test.ts'],
    testTimeout: 180_000, // 3 min per test (AI calls are slow)
    hookTimeout: 120_000, // 2 min for setup/teardown
  },
})
