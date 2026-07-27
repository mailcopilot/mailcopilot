/**
 * aiAccountGate — per-account opt-in resolution for §3.3 AI features (B2 Thread
 * AI Summary, B4 Instant Reply).
 *
 * The per-account opt-in maps (`aiThreadSummaryEnabled` / `aiInstantReplyEnabled`)
 * are keyed by the stringified accountId. Both the thread path (ThreadView) and
 * the single-message reading-pane path resolve their gate through this single
 * helper so the two paths can never drift on how a per-account flag is read.
 *
 * The gate MUST be resolved against the accountId of the *active card / active
 * message* — not a thread lead — because a cross-account thread can surface a
 * card whose account differs from the lead. Gating on the lead would hide the
 * strip for an allowed account or show it for a disallowed one (backend is
 * fail-closed, but the UX would be wrong). Callers pass the active account's id.
 */

/** True iff the per-account opt-in map explicitly enables `accountId`. */
export function isAiFeatureEnabledForAccount(
  map: Record<string, boolean> | undefined,
  accountId: number | null | undefined,
): boolean {
  if (!map || accountId == null) return false
  return map[String(accountId)] === true
}
