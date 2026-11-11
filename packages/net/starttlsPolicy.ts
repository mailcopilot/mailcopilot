import { STARTTLS_REQUIRED_CODE, isStarttlsRefusal } from '@mailcopilot/core/transportFailure'

/**
 * One policy for both transports: a connection that is not on immediate TLS
 * (`secure === false`, ports 143/587 and the like) MUST be upgraded with
 * STARTTLS before any credential or message byte is sent. Without the
 * requirement both libraries continue in cleartext when the server does not
 * advertise STARTTLS — `rejectUnauthorized` only verifies a TLS session that
 * is actually being set up, it does not demand that one is.
 *
 * Only an explicit `secure === false` opts in. `secure: true` is already TLS
 * (ImapFlow even rejects `doSTARTTLS` together with it), and an absent flag
 * keeps each constructor's own default, so port and `secure` semantics are
 * unchanged. There is deliberately no "allow cleartext" switch here: whether
 * an unencrypted local bridge deserves an explicit mode is a product decision.
 */
export function imapStarttlsPolicy(cfg: { secure?: boolean }): { doSTARTTLS?: true } {
  return cfg.secure === false ? { doSTARTTLS: true } : {}
}

export function smtpStarttlsPolicy(cfg: { secure?: boolean }): { requireTLS?: true } {
  return cfg.secure === false ? { requireTLS: true } : {}
}

/**
 * Give a refused upgrade the closed code and a fixed message. The server's own
 * reply text is dropped on purpose: it is third-party prose and adds nothing
 * the code does not say. Other errors, including certificate failures after an
 * accepted STARTTLS, pass through untouched. `responseCode` is kept so the
 * send queue still treats a 5xx refusal as permanent.
 */
export function markStarttlsRefusal<T>(err: T): T {
  if (!isStarttlsRefusal(err) || !(err instanceof Error)) return err
  const tagged = err as Error & { code?: string }
  tagged.code = STARTTLS_REQUIRED_CODE
  tagged.message = `${STARTTLS_REQUIRED_CODE}: the server does not offer an encrypted connection (STARTTLS); no password or message was sent`
  return err
}
