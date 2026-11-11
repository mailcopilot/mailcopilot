/** Translated text for a verdict `oauth:google:connect` returned instead of
 *  connecting (§2.297). Every consumer of that channel goes through this, so a
 *  new verdict cannot reach the user as a generic failure in one window and as
 *  a precise sentence in another. Consumers: the Add Account window and the
 *  main window's re-authentication prompt. */
type Translate = (key: string, opts?: Record<string, unknown>) => string

export function googleRefusalMessage(refusal: unknown, mailboxAddress: string, t: Translate): string {
  if (refusal === 'new_mailbox_closed') return t('account.errors.googleNewMailboxClosed')
  if (refusal === 'account_mismatch') return t('account.errors.googleAccountMismatch', { email: mailboxAddress })
  if (refusal === 'not_configured') return t('account.errors.googleNotConfigured')
  return t('account.errors.googleOAuthFailed')
}
