import { useEffect, useRef } from 'react'
import type { Identity } from '@mailcopilot/types'

/**
 * Decide what the Compose Bcc field should contain after the active identity
 * changes. Mirrors the "don't clobber user-typed content" heuristic used by
 * the signature swap:
 *
 *   - Current Bcc empty                         → new identity's defaultBcc.
 *   - Current Bcc == previous identity's value  → user never edited it,
 *                                                  inherit the new default.
 *   - Anything else                             → leave it alone, the user
 *                                                  typed something they want
 *                                                  to keep.
 *
 * The inputs are normalised with `.trim()` because the rest of Compose uses
 * trimmed comparisons and typing whitespace around an email address should
 * not count as "user override" — that way someone switching identities after
 * accidentally hitting space still inherits the new default.
 *
 * Returns the next Bcc string (may equal the current one — caller is free to
 * skip the state update in that case).
 */
export function computeNextBccForIdentity(
  currentBcc: string,
  previousDefaultBcc: string | null | undefined,
  nextDefaultBcc: string | null | undefined,
): string {
  const cur = (currentBcc || '').trim()
  const prev = (previousDefaultBcc || '').trim()
  const next = (nextDefaultBcc || '').trim()
  if (cur === '') return next
  if (prev !== '' && cur === prev) return next
  return currentBcc
}

/**
 * Keep Compose's Bcc field in sync with the active identity's `defaultBcc`.
 *
 * Fires on every identity change (including the initial render — so a freshly
 * mounted Compose inherits the default identity's Bcc without requiring the
 * user to click anything). The previous identity's `defaultBcc` is tracked
 * across renders so we can distinguish "user kept the previous default" from
 * "user typed a custom address" — only the former is swapped out.
 */
export function useIdentityDefaultBcc(
  identity: Identity | null,
  currentBcc: string,
  setBcc: (next: string) => void,
): void {
  const previousDefaultBccRef = useRef<string | null>(null)

  useEffect(() => {
    const nextDefault = (identity?.defaultBcc || '').trim() || ''
    const prevDefault = previousDefaultBccRef.current
    const next = computeNextBccForIdentity(currentBcc, prevDefault, nextDefault)
    if (next !== currentBcc) setBcc(next)
    previousDefaultBccRef.current = nextDefault
    // We intentionally only react to identity changes. currentBcc is read at
    // effect time (not in deps) so a user-typed override does not retrigger
    // the swap — the guard is that the identity reference/id did not change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity?.id])
}
