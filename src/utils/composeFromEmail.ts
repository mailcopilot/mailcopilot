import type { AccountMeta } from '@mailcopilot/types'

/**
 * Resolve the "From" address to seed in Compose from account metadata.
 *
 * Priority order mirrors long-standing Compose behavior:
 *   1. `meta.email` — explicit display email if the user set one.
 *   2. `meta.smtp.user` — SMTP auth user, typical for most providers.
 *   3. `meta.imap.user` — last-resort fallback (some IMAP-only setups).
 *   4. Empty string — Compose treats this as "unknown", Send stays disabled.
 *
 * Extracted for unit-testability. The behavior is covered by the §2.15 Send
 * button fix (85d6221): reply/forward must seed `fromEmail` from meta on
 * every compose:init so canSend flips true immediately, not after a manual
 * account re-pick. Duplicated in two places inside Compose.tsx (compose:init
 * handler and reload-on-account-change effect); both call this helper so the
 * priority order cannot drift between them.
 */
export function resolveFromEmailFromMeta(meta: AccountMeta | null | undefined): string {
  if (!meta) return ''
  return meta.email || meta.smtp?.user || meta.imap?.user || ''
}
