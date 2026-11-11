/** Who may sign in through Google, decided in main (`oauth:google:connect`,
 *  plus the `accounts:save` guard below that keeps its anchor out of reach).
 *
 *  Google caps an unverified app at 100 lifetime new users and the cap cannot
 *  be reset (BACKLOG §2.297), so the official build connects a mailbox through
 *  Google only to RECONNECT one that already signed in that way (revoked
 *  token, changed password). A hidden button is display, not enforcement: this
 *  is the enforcement, and it holds against a replaced renderer.
 *
 *  Boundary, stated so it is not over-read: Google counts the user before main
 *  ever sees the address, so none of this controls the cap — it keeps THIS app
 *  from spending it and from silently rebinding a mailbox to another account.
 *  `login_hint` is a hint only; the address comparison is the refusal.
 *
 *  The gate compares against the stored mailbox record, so that record must not
 *  be writable by the renderer: `refuseOAuthIdentityRewrite` closes
 *  `accounts:save` as a way to mint an OAuth mailbox or rewrite its address. */
import type { AccountMeta } from '../packages/net/types'

export type GoogleConnectRefusal = 'not_configured' | 'new_mailbox_closed' | 'account_mismatch'

type ExistingMailbox = Pick<AccountMeta, 'authType' | 'providerId' | 'imap'>

export type GoogleConnectPlan =
  | { ok: true; loginHint?: string }
  | { ok: false; refusal: GoogleConnectRefusal }

/** A mailbox that already signs in through Google. */
export function isGoogleSignInMailbox(meta: ExistingMailbox | undefined): meta is ExistingMailbox {
  return !!meta && meta.authType === 'oauth2' && meta.providerId === 'gmail'
}

export function planGoogleConnect(input: {
  configured: boolean
  newMailboxesAllowed: boolean
  existing?: ExistingMailbox
}): GoogleConnectPlan {
  if (!input.configured) return { ok: false, refusal: 'not_configured' }
  if (isGoogleSignInMailbox(input.existing)) {
    const hint = input.existing.imap.user.trim()
    if (hint) return { ok: true, loginHint: hint }
    // No usable stored address means nothing to compare the token against.
    // Where new mailboxes are closed that would accept any Google account, so
    // the mailbox counts as new and goes the app-password way.
    if (!input.newMailboxesAllowed) return { ok: false, refusal: 'new_mailbox_closed' }
    return { ok: true }
  }
  if (!input.newMailboxesAllowed) return { ok: false, refusal: 'new_mailbox_closed' }
  return { ok: true }
}

/** What the connect handler read before the browser round trip, kept to detect
 *  the mailbox being removed or replaced during it (up to minutes). */
export function mailboxIdentity(meta: ExistingMailbox | undefined): string {
  return meta ? `${meta.authType}|${meta.providerId}|${meta.imap.user}` : ''
}

const CONSUMER_GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com'])

/** One mailbox, one spelling. Gmail ignores dots in the local part and serves
 *  `googlemail.com` as `gmail.com` (https://support.google.com/mail/answer/7436150),
 *  so `ada.lovelace@gmail.com` and `adalovelace@googlemail.com` are the same
 *  address — but ONLY for consumer Gmail: on a Workspace domain, dots matter. */
export function canonicalGoogleAddress(address: string): string {
  const lower = address.trim().toLowerCase()
  const at = lower.lastIndexOf('@')
  if (at < 1) return lower
  const domain = lower.slice(at + 1)
  if (!CONSUMER_GMAIL_DOMAINS.has(domain)) return lower
  return `${lower.slice(0, at).replace(/\./g, '')}@gmail.com`
}

/** After the browser round trip: the token must belong to the address we
 *  asked for. An empty address from Google counts as a mismatch (fail closed). */
export function verifyTokenAddress(loginHint: string | undefined, tokenEmail: string): GoogleConnectRefusal | null {
  if (!loginHint) return null
  return canonicalGoogleAddress(loginHint) === canonicalGoogleAddress(tokenEmail) ? null : 'account_mismatch'
}

/** `accounts:save` must not create or re-address a GOOGLE sign-in mailbox: only
 *  the Google connect flow, which calls `saveAccount` directly, may. Returns the
 *  reason to refuse, or null. A replaced renderer could otherwise mint a record
 *  that the connect gate then treats as an existing Google mailbox, and the
 *  shipped edit form could re-address a real one before a reconnect.
 *
 *  Scope is Google on purpose (§2.297 leaves Outlook untouched): a Microsoft 365
 *  shared mailbox legitimately signs in with the owner's token under another
 *  login, so its user fields stay editable. Moving a record to or from the
 *  `gmail` provider is refused for the same reason as the address: it would
 *  turn a non-Google record into an "existing Google mailbox". */
export function refuseOAuthIdentityRewrite(
  incoming: { authType?: string; providerId?: string; imap: { user: string }; smtp: { user: string } },
  existing: (ExistingMailbox & { smtp: { user: string } }) | undefined,
): string | null {
  const targetsGoogle = (incoming.providerId ?? existing?.providerId ?? 'gmail') === 'gmail'
  if (incoming.authType === 'oauth2' && targetsGoogle && existing?.authType !== 'oauth2') {
    return 'A Google sign-in mailbox can only be created by its sign-in flow'
  }
  if (existing?.authType !== 'oauth2') return null
  if (incoming.providerId !== undefined && incoming.providerId !== existing.providerId
    && (incoming.providerId === 'gmail' || existing.providerId === 'gmail')) {
    return 'The provider of a mailbox that signs in with OAuth cannot be changed to or from Google'
  }
  if (existing.providerId !== 'gmail') return null
  if (incoming.imap.user !== existing.imap.user || incoming.smtp.user !== existing.smtp.user) {
    return 'The address of a mailbox that signs in with Google cannot be edited; reconnect it instead'
  }
  return null
}

/** `accounts:save` with the guard in front of the write, so the refusal runs as
 *  real code in tests. Returns the stored record as it was BEFORE the save.
 *
 *  The guard runs twice. Here, on a record read now: a refused save never reaches
 *  the saver's queue. And again through the `gate` handed to the
 *  saver, which a saver that serialises writes calls in its
 *  own turn on the record the write will overwrite: saves queued ahead of this
 *  one may have replaced the record read here. The record the gate saw, when it
 *  ran, is the `previous` returned. A saver that never calls the gate leaves the
 *  check made here. */
export async function saveAccountGuarded<TInput extends Parameters<typeof refuseOAuthIdentityRewrite>[0] & { id?: number }, TStored extends ExistingMailbox & { smtp: { user: string } }>(
  input: TInput,
  deps: {
    getAccountMeta: (id: number) => TStored | undefined
    saveAccount: (input: TInput, gate: (stored: TStored | undefined) => void) => Promise<{ id: number }>
  },
): Promise<{ id: number; previous: TStored | undefined }> {
  const refuse = (stored: TStored | undefined): void => {
    const refusal = refuseOAuthIdentityRewrite(input, stored)
    if (refusal) throw new Error(refusal)
  }
  let previous = input.id === undefined ? undefined : deps.getAccountMeta(input.id)
  refuse(previous)
  const { id } = await deps.saveAccount(input, (stored) => {
    refuse(stored)
    previous = stored
  })
  return { id, previous }
}
