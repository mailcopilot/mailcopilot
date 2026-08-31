/**
 * Canonical derivation of the "this process is an e2e run" flag.
 *
 * WHY THIS IS A MODULE, AND WHY IT IS PURE
 * ----------------------------------------
 * `MAILCOPILOT_E2E=1` switches large parts of `main.ts` onto in-memory
 * fixtures (account roster, mailboxes, message bodies, send/sync no-ops) and
 * short-circuits gates that exist for the user's benefit (the native
 * certificate-trust dialog, the audit-log clear confirmation). An environment
 * variable is not a capability: anything running as the user — a wrapper
 * script, a dropper, a line in a shell profile — can set it. Reading it on its
 * own therefore means a shipped build can be talked into serving fabricated
 * mail and skipping confirmations by an attacker who never touched the app.
 *
 * `app.isPackaged` is true for every electron-builder artifact (AppImage, deb,
 * rpm, NSIS, DMG) and cannot be changed from the environment, so the flag is
 * the CONJUNCTION: env opt-in AND unpackaged build. The legitimate harness is
 * unaffected — Playwright launches the `electron` binary out of `node_modules`
 * against a `vite build --mode e2e` tree (`tests/e2e/helpers.ts`), which keeps
 * `isPackaged === false`, exactly like a plain `electron .` dev run.
 *
 * This is the same pair of conditions that already guards the `e2e:*` IPC
 * handlers (`assertE2EHandlerAllowed` in `main.ts`), the secret store
 * (CLAUDE.md §2.132 / ARCHITECTURE.md "Secret store") and the telemetry
 * consent bypass. The flag itself was the odd one out: every one of those
 * guards had to re-state `!app.isPackaged` next to it, and any branch that
 * forgot to was live on a shipped build. Folding the build check into the flag
 * makes "packaged ⇒ production behaviour" hold for all ~60 `IS_E2E` branches
 * by construction instead of per call site.
 *
 * The function is pure (env and the packaged bit are parameters) so the whole
 * truth table is unit-testable without importing `electron` or `main.ts`.
 */

/**
 * Environment shape this decision needs — anything carrying the opt-in key.
 * The index signature is what makes `process.env` (`NodeJS.ProcessEnv`) an
 * acceptable argument; the named member documents the only key read.
 */
export interface E2EFlagEnv {
  readonly MAILCOPILOT_E2E?: string | undefined
  readonly [key: string]: string | undefined
}

/**
 * True only for a non-packaged build that was explicitly opted in via
 * `MAILCOPILOT_E2E=1`.
 *
 *   isPackaged | MAILCOPILOT_E2E=1 | result
 *   -----------+-------------------+--------
 *   true       | true              | false   ← env injection on a shipped build
 *   true       | false             | false
 *   false      | true              | true    ← dev run / Playwright harness
 *   false      | false             | false
 *
 * Any value other than the exact string `'1'` (including `'true'`, `'0'` and
 * the empty string) is not an opt-in: the harness sets `'1'` and nothing else,
 * so a looser reading would only widen the surface.
 */
export function computeIsE2E(env: E2EFlagEnv, isPackaged: boolean): boolean {
  if (isPackaged) return false
  return env.MAILCOPILOT_E2E === '1'
}
