/**
 * useAccountIdentities — extracts a normalized list of email identity strings
 * for a given AccountMeta.
 *
 * Collects all email addresses that could be "this user":
 *   - identities[].email (2.3-A multi-identity list, always present after migration)
 *   - meta.email (legacy top-level address)
 *   - smtp.user (SMTP login may differ from display email on some providers)
 *   - imap.user (IMAP login, less common but valid fallback)
 *
 * Returns strings already trimmed and lowercased so call sites can do a
 * simple `identities.some(i => i === organizerNormalized)` check.
 *
 * §2.22 fix iter2B: used by InviteCard to detect organizer==self without
 * a single-string, case-sensitive comparison that failed on mixed-case or
 * trailing-whitespace addresses.
 */

import { useMemo } from 'react'
import type { AccountMeta } from '../../packages/types'

/**
 * Returns a deduplicated, normalized (trim + lowercase) list of email
 * addresses that represent the given account. Returns [] if meta is undefined.
 */
export function useAccountIdentities(meta: AccountMeta | undefined): string[] {
  return useMemo(() => {
    if (!meta) return []

    const raw: string[] = []

    // 2.3-A multi-identity list (always non-empty after accountMetaSchema migration)
    if (meta.identities) {
      for (const id of meta.identities) {
        if (id.email) raw.push(id.email)
      }
    }

    // Legacy top-level email field
    if (meta.email) raw.push(meta.email)

    // SMTP / IMAP login addresses (may be alias or plus-address)
    if (meta.smtp?.user) raw.push(meta.smtp.user)
    if (meta.imap?.user) raw.push(meta.imap.user)

    // Normalize and deduplicate
    const seen = new Set<string>()
    const normalized: string[] = []
    for (const addr of raw) {
      const norm = addr.trim().toLowerCase()
      if (norm && !seen.has(norm)) {
        seen.add(norm)
        normalized.push(norm)
      }
    }

    return normalized
  }, [meta])
}
