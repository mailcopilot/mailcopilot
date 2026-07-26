import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Identity } from '@mailcopilot/types'

/**
 * Extract email addresses from an RFC-style recipient list string.
 *
 * Handles the two shapes the renderer actually receives today:
 *   - Bare "a@x, b@y" lists (from ComposeInit.to when the caller has already
 *     flattened addresses).
 *   - "Name <addr@host>, ..." lists with optional display names.
 *
 * Pure, no network. Returns lowercase addresses for case-insensitive matching.
 */
export function extractEmailsFromRecipients(raw: string | null | undefined): string[] {
  if (!raw) return []
  const out: string[] = []
  for (const piece of String(raw).split(',')) {
    const trimmed = piece.trim()
    if (!trimmed) continue
    const angle = trimmed.match(/<([^>]+)>/)
    const candidate = (angle ? angle[1] : trimmed).trim().toLowerCase()
    if (candidate) out.push(candidate)
  }
  return out
}

/**
 * Find the identity whose email matches any address in the original To/Cc.
 * Comparison is case-insensitive and exact (no alias/plus-address heuristics
 * in v1 — reserved for follow-up work once we see real usage).
 *
 * Returns null when no identity matches.
 */
export function pickReplyIdentity(
  identities: readonly Identity[],
  originalTo: string | null | undefined,
  originalCc: string | null | undefined,
): Identity | null {
  if (!identities.length) return null
  const recipientEmails = new Set<string>([
    ...extractEmailsFromRecipients(originalTo),
    ...extractEmailsFromRecipients(originalCc),
  ])
  if (!recipientEmails.size) return null
  for (const ident of identities) {
    const email = (ident.email || '').trim().toLowerCase()
    if (email && recipientEmails.has(email)) return ident
  }
  return null
}

/**
 * Locate the default identity within the list, falling back to the first
 * entry when no `isDefault` flag is set (which is a data-shape violation
 * upstream but should not crash the UI).
 */
export function findDefaultIdentity(identities: readonly Identity[]): Identity | null {
  if (!identities.length) return null
  return identities.find(i => i.isDefault) ?? identities[0]
}

export type UseIdentitySelectionInput = {
  identities: readonly Identity[]
  /** Original recipient list from the email being replied to, if any. */
  originalTo?: string | null
  /** Original Cc list from the email being replied to, if any. */
  originalCc?: string | null
  /**
   * Identity id to honour on initialisation, ahead of reply-match/default.
   * Used by Compose when re-opening a cancelled queued send so the user's
   * original From alias is preserved. If the id does not exist in
   * `identities[]` (e.g. the identity was deleted between queueing and
   * editing), the hook silently falls back to the normal pick.
   */
  initialIdentityId?: string | null
}

export type UseIdentitySelectionResult = {
  selectedId: string | null
  selectedIdentity: Identity | null
  setSelectedId: (id: string) => void
  /**
   * True when the current selection was picked automatically from the reply
   * context (To/Cc match). Flips to false the moment the user overrides.
   */
  autoMatched: boolean
}

/**
 * Tracks the active identity for a Compose window.
 *
 *   - New compose (no originalTo/originalCc) → default identity.
 *   - Reply / forward with originalTo/Cc     → match identity by email.
 *   - User-picked override                   → persists until identities[] changes.
 *
 * `identities` is expected to be stable across re-renders for a given account
 * (re-computed only when switching accounts). We key the internal memory by
 * the identity ids so mutating-in-place without a reference change still
 * reconciles correctly.
 */
export function useIdentitySelection(input: UseIdentitySelectionInput): UseIdentitySelectionResult {
  const { identities, originalTo, originalCc, initialIdentityId } = input

  const idsKey = useMemo(() => identities.map(i => i.id).join('\x1f'), [identities])

  const initial = useMemo(() => {
    // Explicit hint from the caller wins: when we are rehydrating a queued
    // draft we already know exactly which identity the user authored with.
    // Validate against the current list so a deleted identity falls through
    // to the normal pick instead of pinning a ghost id.
    if (initialIdentityId && identities.some(i => i.id === initialIdentityId)) {
      return { id: initialIdentityId, autoMatched: false }
    }
    const replyMatch = pickReplyIdentity(identities, originalTo, originalCc)
    if (replyMatch) return { id: replyMatch.id, autoMatched: true }
    const def = findDefaultIdentity(identities)
    return { id: def?.id ?? null, autoMatched: false }
    // Recompute only when the identity set or the reply context changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, originalTo, originalCc, initialIdentityId])

  const [selectedId, setSelectedIdState] = useState<string | null>(initial.id)
  const [autoMatched, setAutoMatched] = useState<boolean>(initial.autoMatched)

  // Reconcile when identities or reply context change (e.g. account switch,
  // late-loading reply metadata). If the current selection is still present
  // in the list we keep it — switching to default would clobber a deliberate
  // user choice.
  useEffect(() => {
    setSelectedIdState(prev => {
      if (prev && identities.some(i => i.id === prev)) return prev
      return initial.id
    })
    setAutoMatched(prev => (prev && identities.some(i => i.id === selectedId) ? prev : initial.autoMatched))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, initial.id, initial.autoMatched])

  const setSelectedId = useCallback((id: string) => {
    setSelectedIdState(id)
    setAutoMatched(false)
  }, [])

  const selectedIdentity = useMemo(() => {
    if (!selectedId) return null
    return identities.find(i => i.id === selectedId) ?? null
  }, [identities, selectedId])

  return { selectedId, selectedIdentity, setSelectedId, autoMatched }
}
