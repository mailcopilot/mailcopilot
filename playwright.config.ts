import { defineConfig } from '@playwright/test'

const isCI = Boolean(process.env.CI)

export default defineConfig({
  testDir: './tests/e2e',
  testIgnore: ['**/demo-*.spec.ts', '**/marketing.*.spec.ts'],
  timeout: isCI ? 120_000 : 60_000,
  expect: { timeout: isCI ? 30_000 : 10_000 },
  // Local retries: 1 absorbs residual transient launch flakes (Electron CDP-port
  // contention when ~6 workers cold-start under one software-rendered Xvfb). CI
  // keeps 2. Reverting this to 0 resurrects the local full-suite flake that
  // e75db9c fixed and ab2df0d silently reverted — keep the local retry.
  retries: isCI ? 2 : 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
})
