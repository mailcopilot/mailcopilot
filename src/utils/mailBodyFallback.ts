/**
 * §2.17 Phase 1 fix wave — the one table that turns "why is there no body"
 * into words, an icon and a test id.
 *
 * It lives away from the component that renders it for two reasons. The
 * mechanical one is Fast Refresh, which wants a component module to export
 * only components. The one that matters is that this mapping is the thing the
 * §2.17 defect was made of: the wording used to be decided inline, twice, by a
 * `reason === 'timeout' ? … : offline` ternary, so every value that was not
 * 'timeout' — including one that did not exist yet — silently claimed the user
 * was offline. As a total Record over the reason union, a reason added to
 * `MessageDetails` without a decision here is a compile error instead.
 *
 * Which reason an envelope carries is decided in electron/main.ts
 * (`buildOfflineFallback`); nothing here infers or second-guesses it.
 */

import { CloudOff, Timer, WifiOff } from 'lucide-react'
import type { MessageDetails } from '../../packages/net/types'

/** Reason plus the "older envelope, field absent" case, which is presented as
 *  offline — a compatibility choice for rows cached before the field existed,
 *  not a statement about what happened to them. See `presentationForReason`. */
export type MailBodyFallbackReason = MessageDetails['offlineFallbackReason']

export type MailBodyFallbackPresentation = {
  testId: string
  icon: typeof WifiOff
  messageKey: string
}

export const MAIL_BODY_FALLBACK_PRESENTATION: Record<
  NonNullable<MailBodyFallbackReason>,
  MailBodyFallbackPresentation
> = {
  // Work-offline mode: the server was never contacted, so the crossed-out
  // Wi-Fi symbol is a statement of fact rather than a guess. This is the only
  // entry allowed to use the offline sentence.
  offline: {
    testId: 'mail-body-offline',
    icon: WifiOff,
    messageKey: 'app.errors.bodyNotAvailableOffline',
  },
  // Our own budget expired. The icon has to agree with the sentence: a
  // crossed-out Wi-Fi symbol on a working connection is the same lie in
  // picture form.
  timeout: {
    testId: 'mail-body-timeout',
    icon: Timer,
    messageKey: 'app.errors.bodyLoadTimedOut',
  },
  // The load failed and we do not know why — which includes not knowing
  // whether the server was even the part that failed (main.ts catches the
  // post-fetch save/parse/index work in the same block). Deliberately NOT the
  // Wi-Fi symbol: an expired password over a working connection lands here.
  unavailable: {
    testId: 'mail-body-unavailable',
    icon: CloudOff,
    messageKey: 'app.errors.bodyLoadFailed',
  },
}

/**
 * Absent reason ⇒ presented as offline. This is a COMPATIBILITY choice, not a
 * diagnosis: envelopes cached before the field existed carry no cause at all,
 * and the flag they do carry meant nothing more specific — the pre-field flag
 * was raised for our own expired budget and for arbitrary caught failures just
 * as readily as for work-offline mode, which is precisely the defect §2.17
 * exists to fix. So this line does not know that such a row was offline; it
 * picks the wording those rows have always been shown with, and every row
 * written from now on names its own cause instead.
 */
export function presentationForReason(
  reason: MailBodyFallbackReason,
): MailBodyFallbackPresentation {
  return MAIL_BODY_FALLBACK_PRESENTATION[reason ?? 'offline']
}
