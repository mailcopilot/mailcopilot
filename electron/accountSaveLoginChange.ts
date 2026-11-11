/**
 * Did an `accounts:save` payload actually change what the IMAP login is made
 * of?
 *
 * WHY THIS EXISTS
 *
 * `accounts:save` used to clear the per-account login latch
 * (packages/net/authLoginLatch.ts) unconditionally, on the reasoning that new
 * credentials are owed a real login instead of the remainder of a backoff
 * window earned by the old ones. That reasoning is right; the trigger was not.
 * `accounts:save` is not only "the user retyped their password" — it is also
 * every avatar-colour change and every signature edit. `saveAvatarSettings` in
 * src/windows/Settings.tsx sends the WHOLE account record back with
 * `pass: undefined`, and the identities save sends `{...meta.imap}`, which
 * never carries a password because `AccountMeta` omits it.
 *
 * So on an account whose stored password the server is rejecting, picking a
 * different avatar colour released the latch and let the storm the latch was
 * built to stop resume — roughly twelve failed LOGINs per folder per hour, the
 * rate that gets a mailbox locked out for credential stuffing. Nothing about
 * choosing a colour makes the next login more likely to succeed.
 *
 * WHAT COUNTS
 *
 * The latch holds back OUR OWN logins to one mailbox, so the question is
 * narrow: is the next login going to be different from the one that was just
 * refused? That is decided by the IMAP login tuple and nothing else —
 * where we connect (`host`, `port`, `secure`), who we claim to be (`user`),
 * how we authenticate (`authType`), and whether a fresh secret was submitted
 * (`imap.pass` present and non-empty).
 *
 * Deliberately NOT counted:
 *
 *   * `smtp.pass`. An SMTP-only password change does not make an IMAP login
 *     any more likely to succeed. When the two share a password — the common
 *     case, and what the wizard writes — `imap.pass` is present anyway.
 *   * Everything else on the record (name, email, colour, avatar, signature,
 *     identities, folder roles). None of it reaches a LOGIN command.
 *
 * WHAT NOT CLEARING COSTS, SAID OUT LOUD
 *
 * Nothing permanent. The latch is not "no attempts ever": every window admits
 * one probe, and a probe that succeeds clears the latch outright (see the
 * header of authLoginLatch.ts). So a change this function fails to recognise
 * delays recovery by at most the current window, and recovery still happens
 * without the user being told to do anything. Clearing on every save, by
 * contrast, removed the guarantee entirely.
 *
 * A save with no previous record is a NEW account: there is nothing to compare
 * against, no latch can have been armed against credentials that did not exist
 * yet, and its first login is owed immediately. That returns `true`.
 *
 * Pure and dependency-free on purpose — `electron/main.ts` is a hotspot
 * (CLAUDE.md §5), and the decision is worth a test of its own. Types are
 * structural so both the parsed `accountSaveSchema` payload and a stored
 * `AccountMeta` satisfy them without either being imported here.
 */

/** The parts of a transport config an IMAP login is actually made of. */
export interface LoginEndpoint {
  host: string
  port: number
  secure: boolean
  user: string
}

/** The incoming `accounts:save` payload, narrowed to what matters here. */
export interface AccountSaveLoginView {
  authType?: 'password' | 'oauth2'
  imap: LoginEndpoint & { pass?: string }
}

/** The stored record as it was BEFORE the save. */
export interface StoredAccountLoginView {
  authType?: 'password' | 'oauth2'
  imap: LoginEndpoint
}

/**
 * True when the save is worth an immediate login attempt — i.e. when the login
 * the latch refused is not the login we would make next.
 *
 * @param payload  the parsed save payload
 * @param previous the stored record read BEFORE the save committed, or
 *                 `undefined` for a brand-new account
 */
export function accountSaveChangesLogin(
  payload: AccountSaveLoginView,
  previous: StoredAccountLoginView | undefined,
): boolean {
  // A fresh secret is the unambiguous case and needs no comparison: the user
  // typed something into the password field, which the form leaves empty on
  // load precisely so that an untouched field means "keep what is stored".
  if (typeof payload.imap.pass === 'string' && payload.imap.pass.length > 0) return true
  // Nothing to compare against — a new account is owed its first login.
  if (!previous) return true
  if ((payload.authType ?? 'password') !== (previous.authType ?? 'password')) return true
  return payload.imap.host !== previous.imap.host
    || payload.imap.port !== previous.imap.port
    || payload.imap.secure !== previous.imap.secure
    || payload.imap.user !== previous.imap.user
}
