import { useCallback, useEffect, useRef, useState } from 'react'
import { Save, Plug, Loader2, Plus, CheckCircle, LogIn, AlertCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { TranslatedError, presentedError } from '../utils/errorPresentation'
import type { AccountConfig, AccountMeta, AutoconfigResult, TlsPin } from '../../packages/net/types'
import type { OAuthConnectStage, OAuthProgress } from '@mailcopilot/types'
import WindowTitlebar from '../components/WindowTitlebar'
import OAuthWaiting from '../components/OAuthWaiting'
import { recordEvent, providerFromHost } from '../utils/metrics'
import { captureException } from '../sentry'

// §2.127 — `presentedError` / `TranslatedError` live in src/utils/errorPresentation.ts.
// The account wizard is where this matters most: it is the first screen a new
// user meets, and `String(e)` used to render "Error: Error invoking remote
// method 'accounts:save': ..." right under the password field.

/** Map a free-form error message to a low-cardinality failure tag. */
function failureKindFromError(err: unknown): 'auth' | 'tls' | 'network' | 'permanent' | 'unknown' {
  const msg = String((err as Error)?.message ?? err ?? '').toLowerCase()
  if (/auth|credentials|password|login/i.test(msg)) return 'auth'
  if (/tls|cert|ssl|pin/i.test(msg)) return 'tls'
  if (/timeout|network|enotfound|econn|offline|dns/i.test(msg)) return 'network'
  return 'unknown'
}

/** Stages the waiting step knows how to label. Guards the translation-key
 *  interpolation in {@link OAuthWaiting} — an unrecognised stage would render
 *  a raw dot-path rather than copy. */
const OAUTH_CONNECT_STAGES: readonly OAuthConnectStage[] = ['browser', 'token', 'imap', 'smtp', 'saving']

function isOAuthConnectStage(value: unknown): value is OAuthConnectStage {
  return typeof value === 'string' && (OAUTH_CONNECT_STAGES as readonly string[]).includes(value)
}

const defaultImap: AccountConfig['imap'] = { host: '', port: 993, secure: true, user: '', pass: '', tlsPinsSha256: [] }
const defaultSmtp: AccountConfig['smtp'] = { host: '', port: 465, secure: true, user: '', pass: '', tlsPinsSha256: [] }
type WizardStep = 'provider' | 'oauth' | 'type' | 'credentials' | 'detected' | 'manual'
type ProviderId = 'gmail' | 'outlook' | 'generic-imap'

// ---------------------------------------------------------------------------
// Provider brand logos — inline SVG so they render without network and follow
// the current stroke/fill model of surrounding lucide icons.
// ---------------------------------------------------------------------------
function GmailLogo() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
      <path fill="#4285F4" d="M2 7.5v11A1.5 1.5 0 0 0 3.5 20H6V9.6l6 4.5 6-4.5V20h2.5A1.5 1.5 0 0 0 22 18.5v-11l-10 7.5z" />
      <path fill="#34A853" d="M6 20V9.6L2 6.6V7.5A1.5 1.5 0 0 0 2 7.5V18.5A1.5 1.5 0 0 0 3.5 20H6z" />
      <path fill="#FBBC04" d="M18 20h2.5A1.5 1.5 0 0 0 22 18.5V6.6l-4 3z" />
      <path fill="#EA4335" d="M2 6.6l4 3V20H3.5A1.5 1.5 0 0 1 2 18.5zM22 6.6V5a1 1 0 0 0-1.6-.8L12 10.5 3.6 4.2A1 1 0 0 0 2 5v1.6l10 7.5z" />
      <path fill="#C5221F" d="M2 5v1.6l10 7.5 10-7.5V5a1 1 0 0 0-1.6-.8L12 10.5 3.6 4.2A1 1 0 0 0 2 5z" />
    </svg>
  )
}

function OutlookLogo() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
      <path fill="#0A2767" d="M22 6.5v11a1.5 1.5 0 0 1-1.5 1.5H13v-3h6V8h-6V5h7.5A1.5 1.5 0 0 1 22 6.5z" />
      <rect x="2" y="4" width="12" height="16" rx="1" fill="#0364B8" />
      <path fill="#ffffff" d="M8 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zm0 1.6a1.9 1.9 0 1 1 0 3.8 1.9 1.9 0 0 1 0-3.8z" />
    </svg>
  )
}

// ---------------------------------------------------------------------------
// ProviderPicker — local component, intentionally kept in this file to avoid
// creating a new file for a small surgical addition (per CLAUDE.md hotspot policy).
// ---------------------------------------------------------------------------
interface ProviderPickerProps {
  onSelect: (provider: ProviderId) => void
}

function ProviderPicker({ onSelect }: ProviderPickerProps) {
  const { t } = useTranslation()
  const [focused, setFocused] = useState<ProviderId>('gmail')

  const providers: Array<{ id: ProviderId; labelKey: string; descKey: string; disabled?: boolean }> = [
    { id: 'gmail', labelKey: 'account.wizard.provider.gmail.label', descKey: 'account.wizard.provider.gmail.desc' },
    { id: 'outlook', labelKey: 'account.wizard.provider.outlook.label', descKey: 'account.wizard.provider.outlook.desc' },
    { id: 'generic-imap', labelKey: 'account.wizard.provider.generic.label', descKey: 'account.wizard.provider.generic.desc' },
  ]

  const handleKeyDown = (e: React.KeyboardEvent, id: ProviderId, disabled?: boolean) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      if (!disabled) onSelect(id)
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
      e.preventDefault()
      const idx = providers.findIndex(p => p.id === focused)
      const next = providers[(idx + 1) % providers.length]
      setFocused(next.id)
      document.getElementById(`provider-card-${next.id}`)?.focus()
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      e.preventDefault()
      const idx = providers.findIndex(p => p.id === focused)
      const prev = providers[(idx - 1 + providers.length) % providers.length]
      setFocused(prev.id)
      document.getElementById(`provider-card-${prev.id}`)?.focus()
    }
  }

  return (
    <section className="form-section" data-testid="account-wizard-provider">
      <h3>{t('account.wizard.stepProvider.title')}</h3>
      <p className="hint">{t('account.wizard.stepProvider.hint')}</p>
      <div className="provider-picker">
        {providers.map(({ id, labelKey, descKey, disabled }) => (
          <div
            key={id}
            id={`provider-card-${id}`}
            className={`provider-card${disabled ? ' provider-card--disabled' : ''}`}
            role="button"
            tabIndex={disabled ? -1 : 0}
            aria-disabled={disabled}
            aria-label={t(labelKey)}
            onFocus={() => setFocused(id)}
            onClick={() => { if (!disabled) onSelect(id) }}
            onKeyDown={e => handleKeyDown(e, id, disabled)}
          >
            <span className="provider-card__icon">
              {id === 'gmail' && <GmailLogo />}
              {id === 'outlook' && <OutlookLogo />}
              {id === 'generic-imap' && <Plug size={22} />}
            </span>
            <span className="provider-card__label">{t(labelKey)}</span>
            <span className="provider-card__desc">{t(descKey)}</span>
            {disabled && (
              <span className="provider-card__badge">
                <AlertCircle size={12} />
                {t('account.wizard.provider.comingSoon')}
              </span>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}

function normalizeFingerprintSha256(fpRaw: string): string {
  return (fpRaw || '').trim().toUpperCase().replace(/-/g, ':')
}

function uniqPins(values?: string[]): string[] {
  return Array.from(new Set((values || []).map(normalizeFingerprintSha256).filter(Boolean)))
}

function isTlsCertificateError(messageRaw: string): boolean {
  const message = (messageRaw || '').toLowerCase()
  return (
    message.includes('certificate')
    || message.includes('tls')
    || message.includes('self signed')
    || message.includes('self-signed')
    || message.includes('unable to verify')
    || message.includes('hostname/ip does not match')
    || message.includes('altname')
    || message.includes('fingerprint')
    || message.includes('depth_zero_self_signed_cert')
    || message.includes('unable_to_verify_leaf_signature')
  )
}

function suggestDisplayNameFromEmail(emailRaw: string): string {
  const email = (emailRaw || '').trim()
  const local = email.split('@')[0] || ''
  const words = local
    .split(/[._-]+/)
    .map(w => w.trim())
    .filter(Boolean)
  if (words.length === 0) return ''
  return words.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

/**
 * Returns true when the account uses Google OAuth2 authentication. Persisted
 * AccountMeta always carries providerId — accountMetaSchema's read-side
 * preprocess fills it for legacy records, and the write-side schema enforces
 * `oauth2 => providerId === 'gmail'`. The optional providerId parameter
 * accommodates transient form state where the field may not yet be set
 * during edits.
 */
function isGmailOAuth(
  authType: AccountMeta['authType'] | undefined,
  providerId?: string,
): boolean {
  if (authType !== 'oauth2') return false
  return providerId === undefined || providerId === 'gmail'
}

/** Returns true when the account uses Microsoft/Outlook OAuth2 authentication. */
function isOutlookOAuth(
  authType: AccountMeta['authType'] | undefined,
  providerId?: string,
): boolean {
  return authType === 'oauth2' && providerId === 'outlook'
}

function mapMetaToForm(meta: AccountMeta): {
  id: number
  name?: string
  email?: string
  authType: NonNullable<AccountMeta['authType']>
  providerId?: ProviderId
  transportType?: 'imap-smtp'
  imap: AccountConfig['imap']
  smtp: AccountConfig['smtp']
} {
  return {
    id: meta.id,
    name: meta.name,
    email: meta.email,
    authType: meta.authType ?? 'password',
    providerId: (meta.providerId as ProviderId | undefined) ?? undefined,
    transportType: meta.transportType,
    imap: { ...meta.imap, pass: '', tlsPinsSha256: [] },
    smtp: { ...meta.smtp, pass: '', tlsPinsSha256: [] },
  }
}

export default function Account({ initialMode = 'new', initialEditId }: { initialMode?: 'new' | 'edit'; initialEditId?: number }) {
  const { t } = useTranslation()
  const [, setAccounts] = useState<AccountMeta[]>([])
  const [selected, setSelected] = useState<number | 'new'>(initialMode === 'edit' && initialEditId != null ? initialEditId : 'new')
  const [form, setForm] = useState<{
    id?: number
    name?: string
    email?: string
    authType: NonNullable<AccountMeta['authType']>
    providerId?: ProviderId
    transportType?: 'imap-smtp'
    imap: AccountConfig['imap']
    smtp: AccountConfig['smtp']
  }>({
    authType: 'password',
    imap: defaultImap,
    smtp: defaultSmtp,
  })
  const [testing, setTesting] = useState(false)
  const [connectingGoogle, setConnectingGoogle] = useState(false)
  const [connectingMicrosoft, setConnectingMicrosoft] = useState(false)
  const [autoconfiguring, setAutoconfiguring] = useState(false)
  const [wizardStep, setWizardStep] = useState<WizardStep>('provider')
  // §2.94 — which provider the wizard is currently connecting, and how far
  // main has got. Seeded to 'browser' on click so the waiting step never
  // renders an empty stage line before the first broadcast arrives.
  const [oauthProvider, setOauthProvider] = useState<'gmail' | 'outlook'>('gmail')
  const [oauthStage, setOauthStage] = useState<OAuthConnectStage>('browser')
  // Which provider's connect flow THIS window started, if any. Read from the
  // mount-once progress listener, so it has to be a ref rather than state.
  const activeOAuthProviderRef = useRef<'gmail' | 'outlook' | null>(null)
  const [smtpSeparateAuth, setSmtpSeparateAuth] = useState(false)
  const [tlsPins, setTlsPins] = useState<TlsPin[]>([])
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const initialLoadDone = useRef(false)

  const refreshTlsPins = useCallback(async (id: number, endpoints?: {
    imap: { host: string; port: number }
    smtp: { host: string; port: number }
  }) => {
    try {
      const pins = await window.api.invoke('tls:listPins', id) as TlsPin[]
      setTlsPins(pins)
      if (!endpoints) return
      const imapHost = endpoints.imap.host.trim().toLowerCase()
      const smtpHost = endpoints.smtp.host.trim().toLowerCase()
      const imapPins = uniqPins(pins
        .filter(p => p.host.trim().toLowerCase() === imapHost && p.port === endpoints.imap.port)
        .map(p => p.fingerprintSha256))
      const smtpPins = uniqPins(pins
        .filter(p => p.host.trim().toLowerCase() === smtpHost && p.port === endpoints.smtp.port)
        .map(p => p.fingerprintSha256))
      setForm(prev => ({
        ...prev,
        imap: { ...prev.imap, tlsPinsSha256: imapPins },
        smtp: { ...prev.smtp, tlsPinsSha256: smtpPins },
      }))
    } catch {
      setTlsPins([])
    }
  }, [])

  const persistPinsForEndpoint = useCallback(async (id: number, endpoint: { host: string; port: number }, pins?: string[]) => {
    const host = endpoint.host.trim()
    const port = Math.floor(Number(endpoint.port))
    if (!host || !Number.isFinite(port) || port <= 0) return
    const unique = uniqPins(pins)
    for (const fingerprintSha256 of unique) {
      try {
        await window.api.invoke('tls:addPin', { accountId: id, host, port, fingerprintSha256 })
      } catch {
        // ignore
      }
    }
  }, [])

  const load = useCallback(async () => {
    setError('')
    try {
      const list = await window.api.invoke('accounts:list') as AccountMeta[]
      setAccounts(list)

      if (selected === 'new') {
        // Wizard — empty form
        if (!initialLoadDone.current) {
          initialLoadDone.current = true
          setTlsPins([])
          setForm({ authType: 'password', imap: defaultImap, smtp: defaultSmtp })
          setWizardStep('provider')
          // Onboarding funnel entry point. first_run = the user has no
          // accounts yet — this is their very first connection.
          recordEvent('onboarding.wizard_opened', { first_run: list.length === 0 })
        }
      } else {
        // Editing — load the specific account
        const meta = list.find(a => a.id === selected)
        if (meta) {
          if (!initialLoadDone.current) {
            initialLoadDone.current = true
            setForm(mapMetaToForm(meta))
            void refreshTlsPins(meta.id, {
              imap: { host: meta.imap.host, port: meta.imap.port },
              smtp: { host: meta.smtp.host, port: meta.smtp.port },
            })
          }
        } else {
          // Account was deleted externally — close the window
          window.close()
        }
      }
    } catch (e) {
      setError(presentedError(t, e))
    }
  }, [refreshTlsPins, selected, t])

  useEffect(() => {
    let cancelled = false
    void load()
    const onChanged = () => { if (!cancelled) void load() }
    window.api?.on('accounts:changed', onChanged)
    return () => {
      cancelled = true
      window.api?.off('accounts:changed', onChanged)
    }
  }, [load])

  // §2.94 — stage updates for the OAuth waiting step. Mount-once (deps []):
  // the preload `off()` bridge cannot match a re-created listener by identity,
  // so a re-subscribing effect would leak one listener per render (the same
  // failure mode as the runaway-tabs incident, §2.25).
  useEffect(() => {
    const onProgress = (payload: unknown) => {
      const p = payload as Partial<OAuthProgress> | null
      if (!p || typeof p !== 'object') return
      if (p.provider !== 'gmail' && p.provider !== 'outlook') return
      // Validate the stage against the known set rather than accepting any
      // string: the value is interpolated into a translation key, and an
      // unknown one would render the raw dot-path to the user.
      if (!isOAuthConnectStage(p.stage)) return
      // `broadcast` reaches every window and both providers have independent
      // mutexes, so a flow the user did NOT start here (the other provider's
      // re-auth from edit mode) can emit while this one is running. Only the
      // flow this window actually started may drive the waiting step.
      if (activeOAuthProviderRef.current !== p.provider) return
      setOauthProvider(p.provider)
      setOauthStage(p.stage)
    }
    window.api?.on('oauth:progress', onProgress)
    return () => window.api?.off('oauth:progress', onProgress)
  }, [])

  const isGoogle = isGmailOAuth(form.authType, form.providerId)
  const isOutlook = isOutlookOAuth(form.authType, form.providerId)
  const isOAuthAccount = isGoogle || isOutlook


  const trustServerCertificate = useCallback(async (
    target: 'imap' | 'smtp',
    endpoint: { host: string; port: number },
    pinsBefore?: string[],
  ): Promise<string | undefined> => {
    const host = endpoint.host.trim()
    const port = Math.floor(Number(endpoint.port))
    if (!host || !Number.isFinite(port) || port <= 0) return undefined

    try {
      const cert = await window.api.invoke('tls:getServerCert', { host, port }) as {
        host?: string
        port?: number
        fingerprintSha256?: string
        subject?: string
        issuer?: string
      }
      const fingerprintSha256 = normalizeFingerprintSha256(String(cert?.fingerprintSha256 || ''))
      if (!fingerprintSha256) {
        setError(t('account.errors.tlsPinFetch', { error: t('common.error') }))
        return undefined
      }

      const ok = window.confirm(t('account.tls.pinConfirm', {
        host: cert.host || host,
        port: cert.port || port,
        subject: cert.subject || t('account.tls.unknown'),
        issuer: cert.issuer || t('account.tls.unknown'),
        fingerprint: fingerprintSha256,
      }))
      if (!ok) return undefined

      const nextPins = uniqPins([...(pinsBefore || []), fingerprintSha256])
      setForm(prev => {
        if (target === 'imap') return { ...prev, imap: { ...prev.imap, tlsPinsSha256: nextPins } }
        return { ...prev, smtp: { ...prev.smtp, tlsPinsSha256: nextPins } }
      })

      if (selected !== 'new') {
        await persistPinsForEndpoint(selected, { host, port }, [fingerprintSha256])
        await refreshTlsPins(selected, {
          imap: { host: target === 'imap' ? host : form.imap.host, port: target === 'imap' ? port : form.imap.port },
          smtp: { host: target === 'smtp' ? host : form.smtp.host, port: target === 'smtp' ? port : form.smtp.port },
        })
      } else {
        setTlsPins(prev => {
          const exists = prev.some(p => p.host === host.toLowerCase() && p.port === port && normalizeFingerprintSha256(p.fingerprintSha256) === fingerprintSha256)
          if (exists) return prev
          return [{ id: Date.now(), accountId: 0, host: host.toLowerCase(), port, fingerprintSha256, createdAt: new Date().toISOString() }, ...prev]
        })
      }

      setStatus(t('account.status.tlsPinned', { host, port }))
      return fingerprintSha256
    } catch (e) {
      // Vocabulary rather than the raw text even though this is a diagnostic
      // screen: this path is only reached AFTER the connection test already
      // failed with a certificate error, i.e. the host resolved and answered.
      // Whatever `tls:getServerCert` says on top of that ("unable to verify",
      // a TLS alert) is not something the user can act on, and it comes from a
      // server we have explicitly not decided to trust yet.
      setError(t('account.errors.tlsPinFetch', { error: presentedError(t, e) }))
      return undefined
    }
  }, [form.imap.host, form.imap.port, form.smtp.host, form.smtp.port, persistPinsForEndpoint, refreshTlsPins, selected, t])

  const testConnections = useCallback(async (): Promise<boolean> => {
    setTesting(true)
    setError('')
    setStatus('')
    try {
      const imapPass = form.imap.pass ?? ''
      const smtpPass = form.smtp.pass ?? ''
      if (imapPass.length === 0 || smtpPass.length === 0) {
        setError(t('account.errors.enterPassword'))
        return false
      }

      const runImap = async (pins: string[]) => (
        await window.api.invoke('net:testImap', { ...form.imap, pass: imapPass, tlsPinsSha256: pins }) as { ok: boolean; error?: string }
      )
      const runSmtp = async (pins: string[]) => (
        await window.api.invoke('net:testSmtp', { ...form.smtp, pass: smtpPass, tlsPinsSha256: pins }) as { ok: boolean; error?: string }
      )

      let imapPins = uniqPins(form.imap.tlsPinsSha256)
      let imapRes = await runImap(imapPins)
      if (!imapRes.ok && form.imap.secure && isTlsCertificateError(String(imapRes.error || ''))) {
        const trusted = await trustServerCertificate('imap', { host: form.imap.host, port: form.imap.port }, imapPins)
        if (trusted) {
          imapPins = uniqPins([...imapPins, trusted])
          imapRes = await runImap(imapPins)
        }
      }

      let smtpPins = uniqPins(form.smtp.tlsPinsSha256)
      let smtpRes = await runSmtp(smtpPins)
      if (!smtpRes.ok && form.smtp.secure && isTlsCertificateError(String(smtpRes.error || ''))) {
        const trusted = await trustServerCertificate('smtp', { host: form.smtp.host, port: form.smtp.port }, smtpPins)
        if (trusted) {
          smtpPins = uniqPins([...smtpPins, trusted])
          smtpRes = await runSmtp(smtpPins)
        }
      }

      // Only count tests in the onboarding funnel; editing an existing
      // account pollutes the funnel with re-auth/diagnostic flows.
      if (selected === 'new') {
        recordEvent('onboarding.connection_test_result', {
          kind: 'imap',
          success: imapRes.ok,
          failure_kind: imapRes.ok ? undefined : failureKindFromError(imapRes.error),
        })
        recordEvent('onboarding.connection_test_result', {
          kind: 'smtp',
          success: smtpRes.ok,
          failure_kind: smtpRes.ok ? undefined : failureKindFromError(smtpRes.error),
        })
      }
      if (imapRes.ok && smtpRes.ok) {
        setStatus(t('account.status.ok'))
        return true
      }
      setError(t('account.errors.imapSmtp', { imap: imapRes.error || t('common.error'), smtp: smtpRes.error || t('common.error') }))
      return false
    } catch (e) {
      // The EXPECTED failure of a connection test is the `{ ok, error }`
      // envelope handled above, which still shows the server's own words on
      // purpose. Reaching this catch means the call itself broke (validation,
      // IPC), and that text is ours and useless to the user.
      setError(presentedError(t, e))
      return false
    } finally {
      setTesting(false)
    }
  }, [form.imap, form.smtp, selected, t, trustServerCertificate])

  const runAutoconfig = useCallback(async () => {
    const email = (form.imap.user || form.smtp.user || '').trim()
    if (!email || !email.includes('@')) {
      setError(t('account.errors.enterEmailForAutoconfig'))
      return
    }
    setAutoconfiguring(true)
    setError('')
    setStatus('')
    try {
      const cfg = await window.api.invoke('accounts:autoconfig', email) as AutoconfigResult | null
      if (!cfg) {
        setError(t('account.errors.autoconfigNotFound'))
        return
      }
      setForm(prev => ({
        ...prev,
        name: (prev.name || '').trim() || suggestDisplayNameFromEmail(email),
        email: prev.email || email,
        imap: {
          ...prev.imap,
          host: cfg.imap.host,
          port: cfg.imap.port,
          secure: cfg.imap.secure,
          user: prev.imap.user || email,
          tlsPinsSha256: [],
        },
        smtp: {
          ...prev.smtp,
          host: cfg.smtp.host,
          port: cfg.smtp.port,
          secure: cfg.smtp.secure,
          user: prev.smtp.user || email,
          tlsPinsSha256: [],
        },
      }))
      setStatus(t('account.status.autoconfigApplied', { source: cfg.source }))
    } catch (e) {
      // "Settings not found" has its own message above; anything landing here
      // is a fetch/parse failure against a third-party autoconfig endpoint,
      // whose text is neither actionable nor ours to render.
      setError(t('account.errors.autoconfigFailed', { error: presentedError(t, e) }))
    } finally {
      setAutoconfiguring(false)
    }
  }, [form.imap.user, form.smtp.user, t])

  const detectWizardServers = useCallback(async () => {
    const email = (form.imap.user || form.smtp.user || '').trim()
    const pass = form.imap.pass ?? ''
    if (!email || !email.includes('@') || pass.length === 0) {
      setError(t('account.errors.enterEmailPassword'))
      return
    }
    // Method selection event — manual password path.
    recordEvent('onboarding.method_selected', { method: 'manual' })

    const nextName = (form.name || '').trim() || suggestDisplayNameFromEmail(email)
    setForm(prev => ({
      ...prev,
      name: nextName,
      email: email,
      authType: 'password',
      imap: { ...prev.imap, user: email, pass },
      smtp: {
        ...prev.smtp,
        user: smtpSeparateAuth ? prev.smtp.user : (prev.smtp.user || email),
        pass: smtpSeparateAuth ? prev.smtp.pass : pass,
      },
    }))

    setAutoconfiguring(true)
    setError('')
    setStatus('')
    try {
      const cfg = await window.api.invoke('accounts:autoconfig', email) as AutoconfigResult | null
      if (!cfg) {
        recordEvent('onboarding.autoconfig_result', { success: false, provider: providerFromHost(email.split('@')[1] || '') })
        setWizardStep('manual')
        setStatus(t('account.status.autoconfigManual'))
        return
      }
      recordEvent('onboarding.autoconfig_result', { success: true, provider: providerFromHost(cfg.imap.host) })

      setForm(prev => ({
        ...prev,
        name: nextName,
        email: prev.email || email,
        authType: 'password',
        imap: {
          ...prev.imap,
          host: cfg.imap.host,
          port: cfg.imap.port,
          secure: cfg.imap.secure,
          user: prev.imap.user || email,
          pass: prev.imap.pass || pass,
          tlsPinsSha256: [],
        },
        smtp: {
          ...prev.smtp,
          host: cfg.smtp.host,
          port: cfg.smtp.port,
          secure: cfg.smtp.secure,
          user: prev.smtp.user || email,
          pass: prev.smtp.pass || pass,
          tlsPinsSha256: [],
        },
      }))
      setStatus(t('account.status.autoconfigApplied', { source: cfg.source }))
      setWizardStep('detected')
    } catch (e) {
      recordEvent('onboarding.autoconfig_result', { success: false, provider: providerFromHost(email.split('@')[1] || '') })
      setError(t('account.errors.autoconfigFailed', { error: presentedError(t, e) }))
      setWizardStep('manual')
    } finally {
      setAutoconfiguring(false)
    }
  }, [form.imap.pass, form.imap.user, form.name, form.smtp.user, smtpSeparateAuth, t])

  const saveAccount = useCallback(async (closeAfter: boolean) => {
    try {
      setError('')
      setStatus('')
      // Do not trim — passwords may contain leading/trailing spaces.
      const normalizePass = (p?: string) => p || undefined
      const payload = {
        id: form.id,
        name: (form.name || '').trim() || undefined,
        email: (form.email || '').trim() || undefined,
        authType: form.authType,
        providerId: form.providerId,
        transportType: form.transportType,
        imap: { ...form.imap, pass: normalizePass(form.imap.pass), tlsPinsSha256: undefined },
        smtp: { ...form.smtp, pass: normalizePass(form.smtp.pass), tlsPinsSha256: undefined },
      }
      const res = await window.api.invoke('accounts:save', payload) as { id: number }
      await persistPinsForEndpoint(res.id, { host: form.imap.host, port: form.imap.port }, form.imap.tlsPinsSha256)
      await persistPinsForEndpoint(res.id, { host: form.smtp.host, port: form.smtp.port }, form.smtp.tlsPinsSha256)
      await refreshTlsPins(res.id, {
        imap: { host: form.imap.host, port: form.imap.port },
        smtp: { host: form.smtp.host, port: form.smtp.port },
      })
      // First-time-save vs edit: only emit onboarding event on new accounts.
      if (!form.id) {
        recordEvent('onboarding.account_saved', {
          provider: providerFromHost(form.imap.host),
          auth_type: (isGmailOAuth(form.authType, form.providerId) || isOutlookOAuth(form.authType, form.providerId)) ? 'oauth' : 'password',
        })
      }
      setSelected(res.id)
      setStatus(t('account.status.saved'))
      if (closeAfter) window.close()
    } catch (e) {
      setError(presentedError(t, e))
    }
  }, [form, persistPinsForEndpoint, refreshTlsPins, t])

  const wizardConnectAndSave = useCallback(async () => {
    const ok = await testConnections()
    if (!ok) return
    await saveAccount(true)
  }, [saveAccount, testConnections])

  const connectGoogle = useCallback(async () => {
    // Method selection event — only for the onboarding flow, not for
    // re-authorizing an existing account.
    const isOnboarding = selected === 'new'
    if (isOnboarding) {
      recordEvent('onboarding.method_selected', { method: 'oauth' })
    }
    setConnectingGoogle(true)
    setError('')
    setStatus('')
    activeOAuthProviderRef.current = 'gmail'
    // Set once the account exists in main: past that point a renderer-side
    // failure (e.g. the accounts:list refresh below) must NOT be presented as
    // "connect failed", or the user retries and creates a duplicate.
    let accountPersisted = false
    let persistedAccountId: number | undefined
    try {
      // If editing an existing Google account — re-authorize. Otherwise create a new one.
      const existingId = (selected !== 'new' && isGmailOAuth(form.authType, form.providerId)) ? selected : undefined
      const res = await window.api.invoke('oauth:google:connect', existingId) as {
        ok: boolean; id: number; email: string
        tlsCertRequired?: { imap?: { host: string; port: number }; smtp?: { host: string; port: number } }
      }
      if (!res.ok) {
        // Failure is reported by the catch block below — avoid double-counting.
        // TranslatedError so `presentedError` keeps this copy instead of
        // replacing it with the generic vocabulary sentence.
        throw new TranslatedError(t('account.errors.googleOAuthFailed'))
      }
      accountPersisted = true
      persistedAccountId = res.id
      if (isOnboarding) {
        recordEvent('onboarding.google_oauth_result', { success: true })
        recordEvent('onboarding.account_saved', { provider: 'gmail', auth_type: 'oauth' })
      }

      // If antivirus/proxy replaces the TLS certificate — offer the user to accept it.
      if (res.tlsCertRequired) {
        for (const endpoint of [res.tlsCertRequired.imap, res.tlsCertRequired.smtp]) {
          if (!endpoint) continue
          try {
            const cert = await window.api.invoke('tls:getServerCert', { host: endpoint.host, port: endpoint.port }) as {
              host?: string; port?: number; fingerprintSha256?: string; subject?: string; issuer?: string
            }
            const fp = normalizeFingerprintSha256(String(cert?.fingerprintSha256 || ''))
            if (!fp) continue
            const ok = window.confirm(t('account.tls.pinConfirm', {
              host: cert.host || endpoint.host,
              port: cert.port || endpoint.port,
              subject: cert.subject || t('account.tls.unknown'),
              issuer: cert.issuer || t('account.tls.unknown'),
              fingerprint: fp,
            }))
            if (ok) {
              await window.api.invoke('tls:addPin', { accountId: res.id, host: endpoint.host, port: endpoint.port, fingerprintSha256: fp })
            }
          } catch (err) {
            captureException(err, { source: 'Account.tlsCertFetch' })
          }
        }
      }

      const list = await window.api.invoke('accounts:list') as AccountMeta[]
      setAccounts(list)

      const meta = list.find(a => a.id === res.id)
      if (meta) {
        setSelected(meta.id)
        setForm(mapMetaToForm(meta))
        void refreshTlsPins(meta.id, {
          imap: { host: meta.imap.host, port: meta.imap.port },
          smtp: { host: meta.smtp.host, port: meta.smtp.port },
        })
      } else {
        setSelected(res.id)
      }

      setStatus(t('account.status.googleConnected', { email: res.email }))
    } catch (e) {
      if (isOnboarding && !accountPersisted) {
        recordEvent('onboarding.google_oauth_result', { success: false, failure_kind: failureKindFromError(e) })
      }
      // The main-side flow rejects with developer-facing English strings
      // ("Google access token does not contain scope ...") that also carry
      // provider prose; the wizard shows a vocabulary sentence instead, while
      // `presentedError` keeps our own TranslatedError copy.
      setError(presentedError(t, e))
      // Hand the picker back so the user can retry or pick another provider;
      // the error banner above it explains what went wrong. Not after the
      // account was already saved, though — inviting a retry there produces a
      // duplicate (codex-bg-review, 2026-08-02).
      if (!accountPersisted) {
        setWizardStep(prev => (prev === 'oauth' ? 'provider' : prev))
      } else if (persistedAccountId !== undefined) {
        // The account DID get created; only a renderer-side step failed. Leave
        // the waiting step for that account's form so the spinner terminates —
        // otherwise onboarding sits on it forever with an error banner above.
        setSelected(persistedAccountId)
      }
    } finally {
      setConnectingGoogle(false)
      if (activeOAuthProviderRef.current === 'gmail') activeOAuthProviderRef.current = null
    }
  }, [form.authType, form.providerId, refreshTlsPins, selected, t])

  const connectMicrosoft = useCallback(async () => {
    const isOnboarding = selected === 'new'
    if (isOnboarding) {
      recordEvent('onboarding.method_selected', { method: 'oauth' })
    }
    setConnectingMicrosoft(true)
    setError('')
    setStatus('')
    activeOAuthProviderRef.current = 'outlook'
    // See the Google counterpart: past this point a renderer-side failure must
    // not read as "connect failed", or a retry duplicates the account.
    let accountPersisted = false
    let persistedAccountId: number | undefined
    try {
      const existingId = (selected !== 'new' && isOutlookOAuth(form.authType, form.providerId)) ? selected : undefined
      const res = await window.api.invoke('oauth:microsoft:connect', existingId) as {
        ok: boolean; id: number; email: string
        tlsCertRequired?: { imap?: { host: string; port: number }; smtp?: { host: string; port: number } }
      }
      if (!res.ok) {
        // See the Google counterpart on TranslatedError.
        throw new TranslatedError(t('account.errors.microsoftOAuthFailed'))
      }
      accountPersisted = true
      persistedAccountId = res.id
      if (isOnboarding) {
        recordEvent('onboarding.account_saved', { provider: 'outlook', auth_type: 'oauth' })
      }

      if (res.tlsCertRequired) {
        for (const endpoint of [res.tlsCertRequired.imap, res.tlsCertRequired.smtp]) {
          if (!endpoint) continue
          try {
            const cert = await window.api.invoke('tls:getServerCert', { host: endpoint.host, port: endpoint.port }) as {
              host?: string; port?: number; fingerprintSha256?: string; subject?: string; issuer?: string
            }
            const fp = normalizeFingerprintSha256(String(cert?.fingerprintSha256 || ''))
            if (!fp) continue
            const ok = window.confirm(t('account.tls.pinConfirm', {
              host: cert.host || endpoint.host,
              port: cert.port || endpoint.port,
              subject: cert.subject || t('account.tls.unknown'),
              issuer: cert.issuer || t('account.tls.unknown'),
              fingerprint: fp,
            }))
            if (ok) {
              await window.api.invoke('tls:addPin', { accountId: res.id, host: endpoint.host, port: endpoint.port, fingerprintSha256: fp })
            }
          } catch (err) {
            captureException(err, { source: 'Account.tlsCertFetch' })
          }
        }
      }

      const list = await window.api.invoke('accounts:list') as AccountMeta[]
      setAccounts(list)

      const meta = list.find(a => a.id === res.id)
      if (meta) {
        setSelected(meta.id)
        setForm(mapMetaToForm(meta))
        void refreshTlsPins(meta.id, {
          imap: { host: meta.imap.host, port: meta.imap.port },
          smtp: { host: meta.smtp.host, port: meta.smtp.port },
        })
      } else {
        setSelected(res.id)
      }

      setStatus(t('account.status.microsoftConnected', { email: res.email }))
    } catch (e) {
      // Microsoft-specific oauth_result event is not yet in metricsSchema.ts —
      // tracked as followup. Generic account_saved / method_selected cover the funnel.
      // See the Google counterpart on why the raw text is not shown.
      setError(presentedError(t, e))
      if (!accountPersisted) {
        setWizardStep(prev => (prev === 'oauth' ? 'provider' : prev))
      } else if (persistedAccountId !== undefined) {
        // See the Google counterpart — terminate the waiting step on the
        // account that was in fact created.
        setSelected(persistedAccountId)
      }
    } finally {
      setConnectingMicrosoft(false)
      if (activeOAuthProviderRef.current === 'outlook') activeOAuthProviderRef.current = null
    }
  }, [form.authType, form.providerId, refreshTlsPins, selected, t])

  /** Handle provider selection on the first wizard step. */
  const handleProviderSelect = useCallback((provider: ProviderId) => {
    if (provider === 'gmail') {
      setForm(prev => ({ ...prev, providerId: 'gmail', transportType: 'imap-smtp' }))
      // Leave the picker immediately: it must not stay clickable while the
      // flow runs, or a second click starts a competing connection (§2.94).
      setOauthProvider('gmail')
      setOauthStage('browser')
      setWizardStep('oauth')
      // Proceed directly to OAuth — skip the manual credentials step
      void connectGoogle()
    } else if (provider === 'outlook') {
      setForm(prev => ({ ...prev, providerId: 'outlook', transportType: 'imap-smtp' }))
      setOauthProvider('outlook')
      setOauthStage('browser')
      setWizardStep('oauth')
      // Proceed directly to Microsoft OAuth — same pattern as Gmail
      void connectMicrosoft()
    } else if (provider === 'generic-imap') {
      setForm(prev => ({ ...prev, providerId: 'generic-imap', transportType: 'imap-smtp', authType: 'password' }))
      setWizardStep('type')
    }
  }, [connectGoogle, connectMicrosoft])

  return (
    <>
    {/* Custom titlebar for frameless window */}
    <WindowTitlebar title={selected === 'new' ? t('account.title') : t('account.editTitle')} />
    <div className="window-container">
      <h2>{selected === 'new' ? t('account.title') : t('account.editTitle')}</h2>
      <p className="hint">
        {selected === 'new' ? t('account.hint') : t('account.editHint')}
      </p>

      {status && <div className="status-ok">{status}</div>}
      {error && <div className="status-err">{error}</div>}

      {selected === 'new' ? (
        <>
          {wizardStep === 'provider' && (
            <ProviderPicker onSelect={handleProviderSelect} />
          )}

          {wizardStep === 'oauth' && (
            <OAuthWaiting provider={oauthProvider} stage={oauthStage} />
          )}

          {wizardStep === 'type' && (
            <section className="form-section" data-testid="account-wizard-type">
              <h3>{t('account.wizard.stepType.title')}</h3>
              <p className="hint">{t('account.wizard.stepType.hint')}</p>
              <div className="form-actions">
                <button onClick={() => setWizardStep('provider')}>{t('account.actions.back')}</button>
                <button
                  data-testid="account-wizard-imap"
                  className="btn-primary"
                  onClick={() => {
                    setForm(prev => ({ ...prev, authType: 'password' }))
                    setWizardStep('credentials')
                  }}
                >
                  <Plus size={14} /> {t('account.wizard.actions.imapSmtp')}
                </button>
              </div>
            </section>
          )}

          {wizardStep === 'credentials' && (
            <section className="form-section" data-testid="account-wizard-credentials">
              <h3>{t('account.wizard.stepCredentials.title')}</h3>
              <div className="form-grid">
                <input
                  placeholder={t('account.fields.displayName')}
                  value={form.name || ''}
                  onChange={e => setForm(prev => ({ ...prev, name: e.target.value }))}
                />
                <input
                  data-testid="account-wizard-email"
                  placeholder={t('account.fields.emailAddress')}
                  value={form.imap.user}
                  onChange={e => {
                    const v = e.target.value
                    setForm(prev => ({
                      ...prev,
                      name: (prev.name || '').trim() || suggestDisplayNameFromEmail(v),
                      email: v,
                      imap: { ...prev.imap, user: v },
                      smtp: { ...prev.smtp, user: smtpSeparateAuth ? prev.smtp.user : v },
                    }))
                  }}
                />
                <input
                  data-testid="account-wizard-password"
                  placeholder={t('account.fields.password')}
                  type="password"
                  value={form.imap.pass || ''}
                  onChange={e => {
                    const v = e.target.value
                    setForm(prev => ({
                      ...prev,
                      imap: { ...prev.imap, pass: v },
                      smtp: smtpSeparateAuth ? prev.smtp : { ...prev.smtp, pass: v },
                    }))
                  }}
                />
                <label className="setting-row setting-row-start">
                  <input
                    type="checkbox"
                    checked={smtpSeparateAuth}
                    onChange={e => {
                      const next = e.target.checked
                      setSmtpSeparateAuth(next)
                      if (!next) {
                        setForm(prev => ({ ...prev, smtp: { ...prev.smtp, user: prev.imap.user, pass: prev.imap.pass } }))
                      }
                    }}
                  />
                  {t('account.wizard.smtpSeparate')}
                </label>
                {smtpSeparateAuth && (
                  <>
                    <input
                      placeholder={t('account.fields.smtpUser')}
                      value={form.smtp.user}
                      onChange={e => setForm(prev => ({ ...prev, smtp: { ...prev.smtp, user: e.target.value } }))}
                    />
                    <input
                      placeholder={t('account.fields.smtpPassword')}
                      type="password"
                      value={form.smtp.pass || ''}
                      onChange={e => setForm(prev => ({ ...prev, smtp: { ...prev.smtp, pass: e.target.value } }))}
                    />
                  </>
                )}
              </div>
              <div className="form-actions">
                <button onClick={() => setWizardStep('type')}>{t('account.actions.back')}</button>
                <button data-testid="account-wizard-next" className="btn-primary" onClick={() => void detectWizardServers()} disabled={autoconfiguring}>
                  {autoconfiguring ? <Loader2 size={14} className="spin" /> : <Plug size={14} />}
                  {t('account.actions.next')}
                </button>
              </div>
            </section>
          )}

          {wizardStep === 'detected' && (
            <section className="form-section" data-testid="account-wizard-detected">
              <h3>{t('account.wizard.stepDetected.title')}</h3>
              <div className="form-grid">
                <input
                  placeholder={t('account.fields.displayName')}
                  value={form.name || ''}
                  onChange={e => setForm(prev => ({ ...prev, name: e.target.value }))}
                />
                <input
                  placeholder={t('account.fields.email')}
                  type="email"
                  value={form.email || ''}
                  onChange={e => setForm(prev => ({ ...prev, email: e.target.value }))}
                />
              </div>
              <div className="form-grid-2col">
                <div className="form-grid">
                  <label className="hint" style={{ margin: 0 }}>IMAP</label>
                  <input placeholder={t('account.fields.host')} value={form.imap.host} onChange={e => setForm(prev => ({ ...prev, imap: { ...prev.imap, host: e.target.value, tlsPinsSha256: [] } }))} />
                  <input placeholder={t('account.fields.port')} type="number" value={form.imap.port} onChange={e => setForm(prev => ({ ...prev, imap: { ...prev.imap, port: Number(e.target.value), tlsPinsSha256: [] } }))} />
                  <label className="setting-row">
                    <input type="checkbox" checked={form.imap.secure} onChange={e => setForm(prev => ({ ...prev, imap: { ...prev.imap, secure: e.target.checked } }))} />
                    {t('account.fields.ssl')}
                  </label>
                </div>
                <div className="form-grid">
                  <label className="hint" style={{ margin: 0 }}>SMTP</label>
                  <input placeholder={t('account.fields.host')} value={form.smtp.host} onChange={e => setForm(prev => ({ ...prev, smtp: { ...prev.smtp, host: e.target.value, tlsPinsSha256: [] } }))} />
                  <input placeholder={t('account.fields.port')} type="number" value={form.smtp.port} onChange={e => setForm(prev => ({ ...prev, smtp: { ...prev.smtp, port: Number(e.target.value), tlsPinsSha256: [] } }))} />
                  <label className="setting-row">
                    <input type="checkbox" checked={form.smtp.secure} onChange={e => setForm(prev => ({ ...prev, smtp: { ...prev.smtp, secure: e.target.checked } }))} />
                    {t('account.fields.ssl')}
                  </label>
                </div>
              </div>
              <div className="form-actions">
                <button onClick={() => setWizardStep('manual')}>{t('account.actions.manual')}</button>
                <button data-testid="account-wizard-connect" className="btn-primary" onClick={() => void wizardConnectAndSave()} disabled={testing}>
                  {testing ? <Loader2 size={14} className="spin" /> : <CheckCircle size={14} />}
                  {t('account.actions.connect')}
                </button>
              </div>
            </section>
          )}

          {wizardStep === 'manual' && (
            <div data-testid="account-wizard-manual">
              <div className="form-grid" style={{ marginBottom: 12 }}>
                <input
                  placeholder={t('account.fields.displayName')}
                  value={form.name || ''}
                  onChange={e => setForm(prev => ({ ...prev, name: e.target.value }))}
                />
                <input
                  placeholder={t('account.fields.email')}
                  type="email"
                  value={form.email || ''}
                  onChange={e => setForm(prev => ({ ...prev, email: e.target.value }))}
                />
              </div>
              <div className="form-grid-2col">
                <section className="form-section">
                  <h3>{t('account.sections.imap')}</h3>
                  <div className="form-grid">
                    <input
                      data-testid="account-wizard-manual-imap-host"
                      placeholder={t('account.fields.host')}
                      value={form.imap.host}
                      onChange={e => setForm(prev => ({ ...prev, imap: { ...prev.imap, host: e.target.value, tlsPinsSha256: [] } }))}
                    />
                    <input placeholder={t('account.fields.port')} type="number" value={form.imap.port} onChange={e => setForm(prev => ({ ...prev, imap: { ...prev.imap, port: Number(e.target.value), tlsPinsSha256: [] } }))} />
                    <label className="setting-row">
                      <input type="checkbox" checked={form.imap.secure} onChange={e => setForm(prev => ({ ...prev, imap: { ...prev.imap, secure: e.target.checked } }))} />
                      {t('account.fields.ssl')}
                    </label>
                    <input placeholder={t('account.fields.user')} value={form.imap.user} onChange={e => setForm(prev => ({ ...prev, imap: { ...prev.imap, user: e.target.value } }))} />
                    <input placeholder={t('account.fields.password')} type="password" value={form.imap.pass || ''} onChange={e => setForm(prev => ({ ...prev, imap: { ...prev.imap, pass: e.target.value } }))} />
                  </div>
                </section>

                <section className="form-section">
                  <h3>{t('account.sections.smtp')}</h3>
                  <div className="form-grid">
                    <input
                      data-testid="account-wizard-manual-smtp-host"
                      placeholder={t('account.fields.host')}
                      value={form.smtp.host}
                      onChange={e => setForm(prev => ({ ...prev, smtp: { ...prev.smtp, host: e.target.value, tlsPinsSha256: [] } }))}
                    />
                    <input placeholder={t('account.fields.port')} type="number" value={form.smtp.port} onChange={e => setForm(prev => ({ ...prev, smtp: { ...prev.smtp, port: Number(e.target.value), tlsPinsSha256: [] } }))} />
                    <label className="setting-row">
                      <input type="checkbox" checked={form.smtp.secure} onChange={e => setForm(prev => ({ ...prev, smtp: { ...prev.smtp, secure: e.target.checked } }))} />
                      {t('account.fields.ssl')}
                    </label>
                    <input placeholder={t('account.fields.smtpUser')} value={form.smtp.user} onChange={e => setForm(prev => ({ ...prev, smtp: { ...prev.smtp, user: e.target.value } }))} />
                    <input placeholder={t('account.fields.smtpPassword')} type="password" value={form.smtp.pass || ''} onChange={e => setForm(prev => ({ ...prev, smtp: { ...prev.smtp, pass: e.target.value } }))} />
                  </div>
                </section>
              </div>
              <div className="form-actions">
                <button onClick={() => void runAutoconfig()} disabled={autoconfiguring}>
                  {autoconfiguring ? <Loader2 size={14} className="spin" /> : <Plug size={14} />}
                  {t('account.actions.autoconfig')}
                </button>
                <button onClick={() => void testConnections()} disabled={testing}>
                  {testing ? <Loader2 size={14} className="spin" /> : <Plug size={14} />}
                  {t('account.actions.test')}
                </button>
                <button data-testid="account-wizard-connect" className="btn-primary" onClick={() => void wizardConnectAndSave()} disabled={testing}>
                  {testing ? <Loader2 size={14} className="spin" /> : <CheckCircle size={14} />}
                  {t('account.actions.connect')}
                </button>
              </div>
            </div>
          )}
        </>
      ) : (
        <>
          {/* Sender name and email — common account fields */}
          <div className="form-grid" style={{ marginBottom: 12 }}>
            <input
              placeholder={t('account.fields.displayName')}
              value={form.name || ''}
              onChange={e => setForm(prev => ({ ...prev, name: e.target.value }))}
            />
            <input
              placeholder={t('account.fields.email')}
              type="email"
              value={form.email || ''}
              onChange={e => setForm(prev => ({ ...prev, email: e.target.value }))}
            />
          </div>

          {/* Account actions */}
          <div className="form-actions">
            <button onClick={() => void connectGoogle()} disabled={connectingGoogle}>
              {connectingGoogle ? <Loader2 size={14} className="spin" /> : <LogIn size={14} />}
              {isGoogle ? t('account.actions.googleReauth') : t('account.actions.googleSignIn')}
            </button>
            <button onClick={() => void connectMicrosoft()} disabled={connectingMicrosoft}>
              {connectingMicrosoft ? <Loader2 size={14} className="spin" /> : <LogIn size={14} />}
              {isOutlook ? t('account.actions.microsoftReauth') : t('account.actions.microsoftSignIn')}
            </button>
            {!isOAuthAccount && (
              <button onClick={() => void runAutoconfig()} disabled={autoconfiguring}>
                {autoconfiguring ? <Loader2 size={14} className="spin" /> : <Plug size={14} />}
                {t('account.actions.autoconfig')}
              </button>
            )}
          </div>

          {/* IMAP / SMTP — aligned columns */}
          <div className="form-grid-2col">
            <section className="form-section">
              <h3>{t('account.sections.imap')}</h3>
              <div className="form-grid">
                <input placeholder={t('account.fields.host')} value={form.imap.host} onChange={e => setForm(prev => ({ ...prev, imap: { ...prev.imap, host: e.target.value, tlsPinsSha256: [] } }))} />
                <input placeholder={t('account.fields.port')} type="number" value={form.imap.port} onChange={e => setForm(prev => ({ ...prev, imap: { ...prev.imap, port: Number(e.target.value), tlsPinsSha256: [] } }))} />
                <label className="setting-row">
                  <input type="checkbox" checked={form.imap.secure} onChange={e => setForm(prev => ({ ...prev, imap: { ...prev.imap, secure: e.target.checked } }))} />
                  {t('account.fields.ssl')}
                </label>
                <input
                  placeholder={t('account.fields.user')}
                  value={form.imap.user}
                  onChange={e => {
                    const v = e.target.value
                    setForm(prev => {
                      const nextName = (prev.name || '').trim() ? prev.name : suggestDisplayNameFromEmail(v)
                      const nextSmtpUser = prev.smtp.user || v
                      return { ...prev, name: nextName, imap: { ...prev.imap, user: v }, smtp: { ...prev.smtp, user: nextSmtpUser } }
                    })
                  }}
                />
                {!isOAuthAccount && (
                  <input placeholder={t('account.fields.password')} type="password" value={form.imap.pass || ''} onChange={e => setForm(prev => ({ ...prev, imap: { ...prev.imap, pass: e.target.value } }))} />
                )}
              </div>
            </section>

            <section className="form-section">
              <h3>{t('account.sections.smtp')}</h3>
              <div className="form-grid">
                <input placeholder={t('account.fields.host')} value={form.smtp.host} onChange={e => setForm(prev => ({ ...prev, smtp: { ...prev.smtp, host: e.target.value, tlsPinsSha256: [] } }))} />
                <input placeholder={t('account.fields.port')} type="number" value={form.smtp.port} onChange={e => setForm(prev => ({ ...prev, smtp: { ...prev.smtp, port: Number(e.target.value), tlsPinsSha256: [] } }))} />
                <label className="setting-row">
                  <input type="checkbox" checked={form.smtp.secure} onChange={e => setForm(prev => ({ ...prev, smtp: { ...prev.smtp, secure: e.target.checked } }))} />
                  {t('account.fields.ssl')}
                </label>
                <input placeholder={t('account.fields.user')} value={form.smtp.user} onChange={e => setForm(prev => ({ ...prev, smtp: { ...prev.smtp, user: e.target.value } }))} />
                {!isOAuthAccount && (
                  <input placeholder={t('account.fields.password')} type="password" value={form.smtp.pass || ''} onChange={e => setForm(prev => ({ ...prev, smtp: { ...prev.smtp, pass: e.target.value } }))} />
                )}
              </div>
            </section>
          </div>

          {/* TLS */}
          <p className="hint" style={{ marginTop: 12 }}>{t('account.tlsHint')}</p>
          {tlsPins.length > 0 && (
            <div className="badges-list" style={{ marginTop: 8 }}>
              {tlsPins.map(pin => (
                <div className="badges-item" key={`${pin.id}-${pin.fingerprintSha256}`}>
                  <span title={pin.fingerprintSha256}>
                    {pin.host}:{pin.port} · {pin.fingerprintSha256.slice(0, 16)}…
                  </span>
                  <button
                    type="button"
                    onClick={async () => {
                      await window.api.invoke('tls:removePin', pin.id)
                      if (typeof selected === 'number') {
                        await refreshTlsPins(selected, {
                          imap: { host: form.imap.host, port: form.imap.port },
                          smtp: { host: form.smtp.host, port: form.smtp.port },
                        })
                      }
                    }}
                  >
                    {t('account.actions.remove')}
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Save */}
          <div className="form-actions" style={{ marginTop: 12 }}>
            <button onClick={() => void saveAccount(false)}>
              <Save size={14} /> {t('account.actions.save')}
            </button>
            <button className="btn-primary" onClick={() => void saveAccount(true)}>
              <Save size={14} /> {t('account.actions.saveAndClose')}
            </button>
            {!isOAuthAccount && (
              <button onClick={() => void testConnections()} disabled={testing}>
                {testing ? <Loader2 size={14} className="spin" /> : <Plug size={14} />}
                {t('account.actions.test')}
              </button>
            )}
          </div>
        </>
      )}
    </div>
    </>
  )
}
