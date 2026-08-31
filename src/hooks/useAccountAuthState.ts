import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { captureException } from '../sentry'
import { recordEvent } from '../utils/metrics'

/**
 * §2.157 — renderer view of "which accounts need signing in again".
 *
 * Main owns the state (electron/services/accountAuthState.ts) and publishes it
 * two ways; this hook consumes both:
 *   - PUSH: the `accounts:authStateChanged` broadcast, edge-triggered, so the
 *     badge appears/disappears without polling.
 *   - PULL: one `accounts:authState` round-trip on mount, because a window
 *     that opens AFTER the flag was raised (app start with a credential that
 *     expired last night — the actual reported case) never sees the edge.
 *
 * Race between the two: the pull is asynchronous, so a broadcast can land
 * while it is still in flight. A pull result is therefore DISCARDED once any
 * broadcast has been applied — the broadcast is strictly newer, and letting a
 * stale snapshot win would resurrect a badge the user has just fixed.
 *
 * BACKLOG §2.25 subscription discipline (same as useCertRecovery): the preload
 * `off()` bridge matches listeners by identity, so the subscription effect is
 * mount-once (deps []) and the handler reaches state only through the setter.
 *
 * The payload carries account IDS ONLY. Nothing here is rendered as HTML and
 * nothing is trusted for its shape: a malformed payload is filtered down to
 * the numbers in it rather than thrown away or rendered.
 */

/** Payload of `accounts:authStateChanged` and of the `accounts:authState`
 *  reply. Mirror of AccountAuthStatePayload in
 *  electron/services/accountAuthState.ts — the renderer cannot import from
 *  electron/*, so the shape is re-declared here. Keep the two in sync. */
export type AccountAuthStatePayload = {
  needsReauth: number[]
}

/** Defensive narrowing of an IPC payload to the account ids it contains.
 *  Exported for the unit tests — the hook must never throw on a shape it did
 *  not expect, because that would take the whole window down with it. */
export function parseAuthStatePayload(raw: unknown): number[] {
  const list = (raw as AccountAuthStatePayload | null | undefined)?.needsReauth
  if (!Array.isArray(list)) return []
  return list.filter((id): id is number => typeof id === 'number' && Number.isInteger(id))
}

/** Fields a diagnosis line may carry: ids, counts and closed enums only —
 *  never an account field (name, address, host) and never server text. */
type AuthStateLogFields = Record<string, string | number | boolean>

/**
 * Field diagnosis instrumentation (incident 2026-08-24), renderer half.
 *
 * Main can prove that a payload LEFT (see the publish line in
 * electron/services/accountAuthState.ts); this side proves it ARRIVED, how big
 * it was and which ids it carried. Those are two distinct failures that look
 * identical from the user's chair — no badge either way — so the pair of logs
 * tells them apart.
 *
 * WHAT THIS DOES NOT OBSERVE: whether a badge was displayed. The badge is
 * rendered in src/App.tsx as `accounts.filter(a => needsReauth.has(a.id))`,
 * against that component's OWN account state, which it loads on its own
 * schedule and which can lag what main currently holds. This hook is below that
 * filter and cannot see it, so no line here may be read as "the user saw it" —
 * an id logged as arrived can still be dropped one layer above. Instrumenting
 * the filter means adding a line at the filter itself (followup: next time
 * App.tsx is opened); it cannot be approximated from here. An earlier version
 * tried, by pulling a fresh `accounts:list` and calling the intersection
 * `visible` — that measured main's list at that instant, never the renderer
 * state that actually filters, so it read "visible" precisely in the
 * stale-renderer case it was meant to catch, and told main nothing main did not
 * already know. Removed rather than relabelled.
 *
 * Local console output, same as the §2.236 consent handshake: renderer code has
 * no `createLogger`, and these lines are for a devtools session with a user, not
 * for telemetry. Nothing here reaches Sentry and nothing here changes state.
 */
function logAuthState(message: string, fields: AuthStateLogFields): void {
  try {
    console.info(`[AccountAuthState] ${message}`, fields)
  } catch { /* diagnostics must never throw */ }
}

export type UseAccountAuthState = {
  /** Account ids main believes need re-authentication. */
  needsReauth: Set<number>
  /** Open the account editor for a flagged account so the user can re-enter
   *  the password / reconnect the OAuth account. */
  openAccountSettings: (accountId: number) => void
}

export function useAccountAuthState(): UseAccountAuthState {
  const [ids, setIds] = useState<number[]>([])
  /** True once a broadcast has been applied — from then on the initial pull is
   *  stale by construction and must not overwrite it. */
  const pushApplied = useRef(false)

  useEffect(() => {
    let cancelled = false

    const onChanged = (...args: unknown[]) => {
      pushApplied.current = true
      const next = parseAuthStatePayload(args[0])
      logAuthState('broadcast arrived', {
        size: next.length,
        ids: next.join(','),
        // A payload whose shape did not survive parsing reads as "cleared".
        parsedAway: Array.isArray((args[0] as { needsReauth?: unknown } | null)?.needsReauth)
          ? ((args[0] as { needsReauth: unknown[] }).needsReauth.length - next.length)
          : 'unparsable',
      })
      setIds(next)
    }
    window.api.on('accounts:authStateChanged', onChanged)

    void (async () => {
      try {
        const snapshot = await window.api.invoke('accounts:authState')
        const pulled = parseAuthStatePayload(snapshot)
        const discarded = cancelled || pushApplied.current
        logAuthState('snapshot pull answered', {
          size: pulled.length,
          ids: pulled.join(','),
          // Discarded here is normal (a broadcast is strictly newer), but it
          // has to be visible: it is one of the ways an id "arrives" and is
          // still not shown.
          discarded,
        })
        if (discarded) return
        setIds(pulled)
      } catch (err) {
        logAuthState('snapshot pull failed', { pushApplied: pushApplied.current })
        // A failed snapshot only costs the badge until the next transition —
        // never a broken window.
        captureException(err, { source: 'useAccountAuthState.snapshot' })
      }
    })()

    return () => {
      cancelled = true
      window.api.off('accounts:authStateChanged', onChanged)
    }
  }, [])

  const needsReauth = useMemo(() => new Set(ids), [ids])

  const openAccountSettings = useCallback((accountId: number) => {
    // §2.157 telemetry — the middle of the funnel (flagged → clicked →
    // cleared). It has to be recorded here and not in main: the editor opens
    // through `ui:openAccount`, which main also serves for the ordinary
    // Settings path, so the handler cannot tell a badge click from any other
    // way of opening the same window. Recorded on the click, not on the
    // outcome: the question is whether the message reaches an action, and an
    // invoke that fails still means the user acted. No account id — the event
    // carries no tags at all. Fire-and-forget by construction (recordEvent
    // posts an ipcRenderer.send and swallows its own errors); the extra guard
    // keeps a future sink from taking the click with it.
    try {
      recordEvent('account.reauth_badge_clicked')
    } catch { /* telemetry must never break the click */ }
    // Deliberately does NOT switch the current account: the badge is a
    // notification, not a navigation request, and silently re-pointing the
    // mail list because the user asked to fix a sign-in would be a surprise.
    void (async () => {
      try {
        await window.api.invoke('ui:openAccount', 'edit', accountId)
      } catch (err) {
        captureException(err, { source: 'useAccountAuthState.openAccountSettings' })
      }
    })()
  }, [])

  return { needsReauth, openAccountSettings }
}
