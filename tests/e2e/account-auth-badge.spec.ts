/**
 * §2.157 E2E — "this mailbox needs signing in again" badge (AccountAuthBadge).
 *
 * ── Scope and why it stops here ─────────────────────────────────────────
 * The full show → click → navigate-to-Settings flow requires the account to
 * actually be flagged by `electron/services/accountAuthState.ts`. As of
 * §2.165 (fix wave 2) that state is fed by ONE general boundary rather than a
 * hand-picked list of call sites: the IMAP connection/retry boundary in
 * `packages/net/imap.ts` reports the verdict of every outward operation
 * (login, folder listing, header sync, remote search, pagination, move,
 * delete, drafts, body fetch, offline replay — everything that talks to the
 * server), forwarded by the single subscriber `electron/main.ts` registers at
 * module scope. Two verdicts legitimately bypass that boundary and raise
 * immediately, with no threshold: `assertImapAuth` (`noteMissingCredentials`
 * — a local precondition rejected before any connection is attempted) and the
 * `net:idleStart` catch (`noteLoginRejected` — IDLE's connect/select prologue
 * is a full login with no retry loop of its own, so a refusal has to be
 * escalated rather than folded into the counted stream). See
 * `electron/main.accountAuthStateWiring.test.ts` for the structural pins of
 * both, and `electron/services/accountAuthState.test.ts` for the state
 * machine each one drives.
 *
 * None of that is reachable from here. `net:idleStart` short-circuits under
 * `MAILCOPILOT_E2E=1` (`if (IS_E2E || getSettings().workOffline) return`) and
 * the e2e account is a stubbed in-memory box (`E2E_ACCOUNTS`), so there is no
 * real IMAP login for this build to fail — and there is deliberately no
 * test-only IPC channel that lets a spec fabricate a "credentials failed"
 * verdict (adding one is itself a security-relevant IPC surface change, out of
 * scope for a test-only patch — see `tests/e2e/sent-copy-failed-toast.spec.ts`
 * for the identical situation and the same resolution).
 *
 * What this spec DOES verify, and why each check is worth having on top of
 * the extensive unit coverage
 * (`electron/services/accountAuthState.test.ts`,
 *  `src/hooks/useAccountAuthState.test.ts`,
 *  `src/components/AccountAuthBadge.test.tsx`,
 *  `electron/main.accountAuthStateWiring.test.ts`,
 *  `packages/net/imap.test.ts` "§2.165 — connection outcome registry"):
 *
 *   1. The badge is absent on a clean load — proves wiring AccountAuthBadge
 *      into `src/App.tsx` did not make it render unconditionally (every unit
 *      test for the component mocks its way past this).
 *   2. `window.api.invoke('accounts:authState')` — the REAL preload bridge,
 *      not a mock — round-trips to the REAL main-process handler and
 *      resolves to a well-formed `{ needsReauth: [] }`. This is the one
 *      thing no unit test can prove: `accountAuthState.test.ts` exercises
 *      `preload.ts` / `electron-env.d.ts` only as SOURCE TEXT (string
 *      containment checks — see its "§2.157 IPC channel whitelist"
 *      `describe`), and `useAccountAuthState.test.ts` mocks `window.api`
 *      entirely. Only a real IPC round-trip proves the channel is actually
 *      registered on both ends and returns the documented shape.
 *   3. The app shell survives the hook mounting for real (no crash from the
 *      new `useEffect` / `useAccountAuthState` wiring in `App.tsx`).
 *
 * A test-only trigger channel that pre-seeds `accountAuthState`'s flagged set
 * at startup (gated on `MAILCOPILOT_E2E` AND `!app.isPackaged`, the same
 * double gate `secretStore` uses — CLAUDE.md §5 "E2E не касается OS
 * keychain") was evaluated for this fix wave and deliberately NOT built here:
 * it is a new main-process surface, and adding one is a decision for the
 * humans who own this codebase, not something a test-only patch should decide
 * on its own. If it is added later, extend this spec with:
 *   1. launchApp with extraEnv that flags account 1
 *   2. await expect(page.getByTestId('account-auth-badge-1')).toBeVisible()
 *   3. click page.getByTestId('account-auth-fix-1')
 *   4. assert the Account window opens in 'edit' mode for account 1
 * ──────────────────────────────────────────────────────────────────────
 */

import { test, expect } from '@playwright/test'
import { launchApp, cleanupApp, type AppContext } from './helpers'

test('account-auth-badge: absent on a clean load, real IPC round-trip resolves to an empty snapshot', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-auth-badge-'))
    const page = ctx.page!

    // No badge in the DOM at all — matching accountId is unknown a priori,
    // so match on the stable class rather than a specific data-testid.
    await expect(page.locator('.account-auth-badge')).toHaveCount(0)

    // Real round-trip through the actual preload whitelist + main handler —
    // not a mock. A regression that removed 'accounts:authState' from either
    // ALLOWED_INVOKE_CHANNELS (preload.ts) or the handleIpc registration
    // (main.ts) makes this reject instead of resolve.
    const snapshot = await page.evaluate(() => window.api.invoke('accounts:authState'))
    expect(snapshot).toEqual({ needsReauth: [] })

    // The app shell is unaffected by the new hook mounting.
    await expect(page.getByTestId('inbox-list')).toBeVisible()
  } finally {
    await cleanupApp(ctx)
  }
})
