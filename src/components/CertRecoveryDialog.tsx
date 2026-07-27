import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { Copy, ShieldAlert } from 'lucide-react'
import { sanitizeUntrustedText, CN_MAX, HOST_MAX, type CertRecoveryDialogState } from '../hooks/useCertRecovery'
import { captureException } from '../sentry'

/** Longest raw TLS error we render inline. Server strings can be arbitrarily
 *  long; anything past this is truncated with an ellipsis. UNTRUSTED text is
 *  always placed in a text node — never HTML. */
const RAW_MESSAGE_MAX = 500
/** A normalized SHA-256 fingerprint is 64 hex chars (95 with colon separators).
 *  The bound is generous enough to always show a real one in full, and small
 *  enough that a hostile value cannot flood the dialog. */
const FINGERPRINT_MAX = 128
/** How long the "copied" confirmation stays on the copy button. */
const COPIED_FEEDBACK_MS = 1500

/** Inline style forcing left-to-right, isolated, monospace rendering for the
 *  fingerprint. The user compares this string character by character against
 *  what the server/AV console shows, so its visual order must not be
 *  influenced by neighbouring text or by anything inside the value itself. */
const FINGERPRINT_STYLE: CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  unicodeBidi: 'isolate',
  wordBreak: 'break-all',
  flex: 1,
  minWidth: 0,
}

/** Untrusted values that are plain prose still get bidi isolation so they can
 *  never reorder the labels around them. */
const ISOLATE_STYLE: CSSProperties = { unicodeBidi: 'isolate' }

/** Fingerprint value + copy button on one row. Inline because the dialog
 *  deliberately reuses existing stylesheet classes and adds no new CSS. */
const FINGERPRINT_ROW_STYLE: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8 }

type Props = {
  state: CertRecoveryDialogState
  onTrust: () => void
  onCancel: () => void
}

/**
 * TLS trust rework Phase A3 — modal shown when a mail server presents an
 * unexpected certificate (typically local AV/proxy interception, e.g. Kaspersky
 * on Windows). Thin, presentational: all logic (re-probe, invoke, queue) lives
 * in useCertRecovery. Reuses the existing confirm-overlay / confirm-dialog /
 * link-dialog styling — no new CSS, no dangerouslySetInnerHTML.
 *
 * Every server-supplied field (host, issuer, fingerprint, raw error) is
 * UNTRUSTED. Beyond being rendered as a plain text node it is also:
 *   - bounded in length, so a multi-kilobyte issuer CN cannot push the action
 *     buttons out of the viewport;
 *   - stripped of control / bidi / zero-width characters, so an embedded
 *     RTL override cannot visually reorder the fingerprint the user is about
 *     to trust (a classic spoofing trick against confirm dialogs);
 *   - rendered with `dir="ltr"` + `unicode-bidi: isolate`, so even a purely
 *     RTL script value cannot flip the surrounding layout.
 * Only the *displayed* copies are sanitized — the raw values stay in
 * `state.request` for the IPC round-trip (see sanitizeUntrustedText docs).
 *
 * The fingerprint / issuer / subject come from the dialog STATE, not from
 * `state.request`: when the hook re-reads the certificate (payload without a
 * fingerprint, or main rejecting the previous one as stale) the fresh values
 * replace them and `state.review` explains why. That is what makes
 * "what you see is what you pin" observable — the primary button always
 * confirms the certificate rendered here, and while there is nothing to
 * confirm it is labelled as a read action instead.
 */
export default function CertRecoveryDialog({ state, onTrust, onCancel }: Props) {
  const { t } = useTranslation()
  const {
    request, fingerprint, issuerCn, subjectCn, review,
    trusting, reprobing, dismissing, reprobeFailed, stale, errorKey,
  } = state
  const busy = trusting || reprobing || dismissing
  // Trust is impossible without a fingerprint that a probe also failed to
  // recover (pinning needs a concrete SHA-256), and equally impossible once main
  // has retired the prompt — an enabled button there would only invite the user
  // to re-run a refusal.
  const trustDisabled = busy || stale || (!fingerprint && reprobeFailed)
  // With no fingerprint on screen the primary action cannot pin anything: it
  // reads the certificate so the user can look at it before confirming
  // (useCertRecovery invariant 5). Label it for what it actually does.
  const readsCertificate = !stale && !fingerprint && !reprobeFailed

  const host = useMemo(() => sanitizeUntrustedText(request.host, HOST_MAX), [request.host])
  const issuer = useMemo(() => sanitizeUntrustedText(issuerCn, CN_MAX), [issuerCn])
  const subject = useMemo(() => sanitizeUntrustedText(subjectCn, CN_MAX), [subjectCn])
  const rawMessage = useMemo(
    () => sanitizeUntrustedText(request.rawMessage, RAW_MESSAGE_MAX),
    [request.rawMessage],
  )
  const fingerprintText = useMemo(
    () => sanitizeUntrustedText(fingerprint, FINGERPRINT_MAX),
    [fingerprint],
  )

  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current) }, [])

  const copyFingerprint = useCallback(() => {
    if (!fingerprintText) return
    let written: Promise<void> | undefined
    try {
      // Copy exactly what is on screen, so an out-of-band comparison cannot be
      // fooled by a difference between the rendered and the copied value.
      written = navigator.clipboard?.writeText(fingerprintText)
    } catch (err) {
      captureException(err, { source: 'CertRecoveryDialog.copyFingerprint' })
      return
    }
    // No Clipboard API (insecure context / older runtime) or a rejected write:
    // stay silent rather than claim a copy that did not happen — the user is
    // about to compare this value against the server out of band.
    if (!written) return
    void written.then(
      () => {
        setCopied(true)
        if (copyTimer.current) clearTimeout(copyTimer.current)
        copyTimer.current = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS)
      },
      (err: unknown) => captureException(err, { source: 'CertRecoveryDialog.copyFingerprint' }),
    )
  }, [fingerprintText])

  return (
    <div className="confirm-overlay" role="presentation" onClick={busy ? undefined : onCancel}>
      <div
        className="confirm-dialog link-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="cert-recovery-title"
        aria-describedby="cert-recovery-desc"
        data-testid="cert-recovery-dialog"
        onClick={e => e.stopPropagation()}
      >
        <p id="cert-recovery-title">
          <ShieldAlert size={16} /> {t('app.certRecovery.title')}
        </p>

        <div className="link-prompt-text" id="cert-recovery-desc">
          <div className="link-prompt-label">{t('app.certRecovery.serverLabel')}</div>
          <div className="link-prompt-value" data-testid="cert-recovery-host" dir="ltr" style={ISOLATE_STYLE}>
            {host}:{request.port}
          </div>
        </div>

        {/* The certificate was re-read from the server, so the values below are
            not the ones the prompt originally described. The user has to look at
            them and confirm with a separate click — the hook never pins a probe
            result on its own (useCertRecovery invariant 5). */}
        {review && (
          <ul className="link-warnings" data-testid="cert-recovery-review">
            <li>{t(`app.certRecovery.review.${review}`)}</li>
          </ul>
        )}

        <div className="link-prompt-text">
          <div className="link-prompt-label">{t('app.certRecovery.issuerLabel')}</div>
          <div className="link-prompt-value" data-testid="cert-recovery-issuer" dir="ltr" style={ISOLATE_STYLE}>
            {issuer || t('app.certRecovery.issuerUnknown')}
          </div>
        </div>

        {subject && (
          <div className="link-prompt-text">
            <div className="link-prompt-label">{t('app.certRecovery.subjectLabel')}</div>
            <div className="link-prompt-value" data-testid="cert-recovery-subject" dir="ltr" style={ISOLATE_STYLE}>
              {subject}
            </div>
          </div>
        )}

        <div className="link-prompt-text">
          <div className="link-prompt-label">{t('app.certRecovery.fingerprintLabel')}</div>
          <div style={FINGERPRINT_ROW_STYLE}>
            <div
              className="link-prompt-url"
              data-testid="cert-recovery-fingerprint"
              dir="ltr"
              style={FINGERPRINT_STYLE}
            >
              {fingerprintText || t('app.certRecovery.fingerprintUnknown')}
            </div>
            {fingerprintText && (
              <button
                type="button"
                data-testid="cert-recovery-copy"
                aria-label={t('app.certRecovery.copyFingerprint')}
                title={t('app.certRecovery.copyFingerprint')}
                onClick={copyFingerprint}
              >
                <Copy size={14} /> {copied ? t('app.certRecovery.copied') : t('app.certRecovery.copy')}
              </button>
            )}
          </div>
        </div>

        {request.systemOnly && (
          <ul className="link-warnings" data-testid="cert-recovery-interception">
            <li dir="ltr" style={ISOLATE_STYLE}>
              {t('app.certRecovery.interception', {
                issuer: issuer || t('app.certRecovery.issuerUnknown'),
              })}
            </li>
          </ul>
        )}

        {rawMessage && (
          <div className="link-prompt-text">
            <div className="link-prompt-label">{t('app.certRecovery.detailsLabel')}</div>
            <div className="link-prompt-value" data-testid="cert-recovery-raw" dir="ltr" style={ISOLATE_STYLE}>
              {rawMessage}
            </div>
          </div>
        )}

        {errorKey && (
          <p className="status-err" role="alert" data-testid="cert-recovery-error">
            {t(`app.certRecovery.error.${errorKey}`)}
          </p>
        )}

        {/* Confirming makes main re-probe the endpoint to capture the certificate
            body before pinning (up to ~12s). Without a word about it the dialog
            just looks frozen, so the spinner-less busy state gets a reason. */}
        {trusting && (
          <p className="link-prompt-label" role="status" data-testid="cert-recovery-trusting-hint">
            {t('app.certRecovery.trustingHint')}
          </p>
        )}

        <div className="confirm-dialog-actions">
          <button type="button" data-testid="cert-recovery-cancel" disabled={busy} onClick={onCancel}>
            {dismissing ? t('app.certRecovery.dismissing') : t('app.certRecovery.cancel')}
          </button>
          <button
            type="button"
            className="btn-primary"
            data-testid="cert-recovery-trust"
            disabled={trustDisabled}
            onClick={onTrust}
          >
            {reprobing
              ? t('app.certRecovery.reprobing')
              : trusting
                ? t('app.certRecovery.trusting')
                : readsCertificate
                  ? t('app.certRecovery.readCertificate')
                  : t('app.certRecovery.trust')}
          </button>
        </div>
      </div>
    </div>
  )
}
