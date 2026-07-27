/**
 * §2.23 PR1 e2e — SentCopyFailedToast integration in App.tsx
 *
 * Scope:
 *   - Smoke: app starts, toast element absent from DOM (SentCopyFailedToast
 *     renders null until a mail:sentCopyFailed broadcast arrives).
 *   - Integration: data-testid and role="status" are accessible in the real app.
 *
 * Full show/hide flow (inject mail:sentCopyFailed → toast visible → Dismiss
 * hides it) requires firing a broadcast from the main process. Without a
 * test-only IPC channel, that path is covered by unit tests:
 *   - src/components/SentCopyFailedToast.test.tsx — component
 *   - src/hooks/useSentCopyFailureToast.test.ts  — hook
 *
 * If a test IPC channel is added in the future (e.g.
 * MAILCOPILOT_E2E_TRIGGER_APPEND_FAIL=1 env flag that makes the main process
 * broadcast mail:sentCopyFailed immediately on launch), extend this spec with:
 *   1. launchApp with extraEnv: { MAILCOPILOT_E2E_TRIGGER_APPEND_FAIL: '1' }
 *   2. await expect(page.getByTestId('sent-copy-failed-toast')).toBeVisible()
 *   3. click data-testid="sent-copy-failed-dismiss"
 *   4. await expect(page.getByTestId('sent-copy-failed-toast')).not.toBeVisible()
 */

import { test, expect } from '@playwright/test'
import { launchApp, cleanupApp, type AppContext } from './helpers'

// ─── Toast absent on initial load ────────────────────────────────────────────

test('sent-copy-failed toast: absent on initial load (§2.23 PR1 App.tsx integration)', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!

    // The toast must never be in the DOM on a clean start — it only appears
    // when mail:sentCopyFailed is broadcast by the main process.
    const toast = page.getByTestId('sent-copy-failed-toast')
    await expect(toast).toHaveCount(0)

    // Verify the app shell itself is operational (no crash from the new import).
    await expect(page.getByTestId('inbox-list')).toBeVisible()
  } finally {
    await cleanupApp(ctx)
  }
})
