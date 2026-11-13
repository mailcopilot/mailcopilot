/**
 * The From address and header of an outgoing message.
 *
 * One function for both moments that need it: the send (the From header) and
 * the enqueue (the domain of the Message-ID minted for the queued message).
 * Reading the renderer's `from` at enqueue while the send used the chosen
 * identity minted Message-IDs at the wrong domain for an alias.
 *
 * 2.3-B: a chosen identity wins over both the account `name` and the
 * renderer's `from`: the selector lets the user send from an alias without
 * touching the account config. An unknown identity id falls back to `from`.
 */
export interface SendFromMeta {
  name?: string
  identities?: Array<{ id?: string; displayName?: string; email?: string }>
}

export function resolveSendFrom(
  meta: SendFromMeta | undefined,
  options: { from: string; identityId?: string },
): { fromEmail: string; fromHeader: string } {
  const identity = options.identityId
    ? (meta?.identities ?? []).find(i => i.id === options.identityId)
    : undefined
  const displayName = (identity?.displayName?.trim() || meta?.name || '').trim()
  const fromEmail = identity?.email?.trim() || options.from
  const fromHeader = displayName ? `${displayName} <${fromEmail}>` : fromEmail
  return { fromEmail, fromHeader }
}
