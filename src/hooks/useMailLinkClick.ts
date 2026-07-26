import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { normalizeExternalUrl } from '../utils/mailLinks'

export type LinkPromptState = { url: string; text: string; warnings: string[] }

/** Strip leading "www." for mismatch comparison (case-insensitive). */
function stripWww(host: string): string {
  return (host || '').trim().toLowerCase().replace(/^www\./, '')
}

/**
 * Try to extract a domain/host from visible link text.
 * Handles both full URLs ("https://evil.com/path") and plain host-like strings ("evil.com").
 */
function extractHostFromText(text: string): string | null {
  const s = (text || '').trim()
  if (!s) return null
  try {
    const u = new URL(s)
    return u.host || null
  } catch {
    // ignore
  }
  // Domain-like text: google.com / google.com/path
  const m = s.match(/([a-z0-9-]+(?:\.[a-z0-9-]+)+)/i)
  return m ? m[1] : null
}

export interface UseMailLinkClickReturn {
  /** Current pending link prompt, or null when no prompt is shown. */
  linkPrompt: LinkPromptState | null
  /**
   * Evaluate a link click: runs phishing checks (IDN/http/mismatch/bypass),
   * either opens the URL directly via IPC or sets `linkPrompt` for confirmation.
   */
  handleLinkClick: (href: string, text: string, unsafeBypass?: boolean) => Promise<void>
  /** Dismiss the prompt without navigating. */
  dismissPrompt: () => void
  /** Approve the pending prompt and open the URL via IPC. */
  approvePrompt: () => Promise<void>
}

/**
 * Phishing-aware link-click handler for mail HTML bodies.
 *
 * Centralizes the logic shared between the main mail viewer (App.tsx) and the
 * standalone MailWindow. Checks:
 *   - mailto: → open directly
 *   - IDN/punycode hostname → warning
 *   - http: (not https) → warning
 *   - Display-text host mismatch → warning
 *   - unsafeBypass=true → force prompt (raw link slipped past rewriter)
 *   - No warnings → open directly via ui:openExternal IPC
 *   - Warnings present → populate linkPrompt for caller to render
 *
 * Also attaches and cleans up the `mail:link` IPC listener so callers don't
 * need to manage it separately.
 *
 * @param onOpenExternalError - optional callback when `ui:openExternal` IPC
 *   fails. In App.tsx this sets a visible error; in MailWindow it is silent.
 */
export function useMailLinkClick(
  onOpenExternalError?: (msg: string) => void,
): UseMailLinkClickReturn {
  const { t } = useTranslation()
  const tRef = useRef(t)
  tRef.current = t

  const [linkPrompt, setLinkPrompt] = useState<LinkPromptState | null>(null)

  const openExternalUrl = useCallback(async (url: string) => {
    try {
      await window.api.invoke('ui:openExternal', url)
    } catch (e) {
      onOpenExternalError?.(String(e))
    }
  }, [onOpenExternalError])

  const handleLinkClick = useCallback(async (
    href: string,
    text: string,
    unsafeBypass = false,
  ): Promise<void> => {
    const raw = (href || '').trim()
    if (!raw || raw.startsWith('#')) return

    const normalizedUrl = normalizeExternalUrl(raw)
    if (!normalizedUrl) return

    const u = new URL(normalizedUrl)
    if (u.protocol === 'mailto:') {
      await openExternalUrl(normalizedUrl)
      return
    }

    const warnings: string[] = []

    if (u.hostname.toLowerCase().includes('xn--')) {
      try {
        const res = await window.api.invoke('ui:domainToUnicode', u.hostname) as { unicode?: string; ascii?: string }
        warnings.push(tRef.current('mail.links.warningIdn', {
          unicode: res?.unicode || u.hostname,
          ascii: res?.ascii || u.hostname,
        }))
      } catch {
        warnings.push(tRef.current('mail.links.warningIdnSimple', { ascii: u.hostname }))
      }
    }

    if (u.protocol === 'http:') warnings.push(tRef.current('mail.links.warningHttp'))

    const shownHost = extractHostFromText(text)
    if (shownHost) {
      const shown = stripWww(shownHost)
      const real = stripWww(u.host)
      if (shown && real && shown !== real) {
        warnings.push(tRef.current('mail.links.warningMismatch', {
          shown: shownHost,
          real: u.host,
        }))
      }
    }

    // Defense-in-depth (codex-security-review HIGH B4): when the main process
    // routed a raw external URL through `mail:link` because it slipped past
    // rewriteMailHtmlLinks(), force the prompt unconditionally. Empty `text`
    // suppresses the mismatch heuristic, and a trusted-looking https URL would
    // otherwise pass without any warning — exactly the bypass class we're
    // closing.
    if (unsafeBypass) {
      warnings.push(tRef.current('mail.links.warningRawExternalLink'))
    }

    if (warnings.length === 0) {
      await openExternalUrl(normalizedUrl)
      return
    }

    setLinkPrompt({ url: normalizedUrl, text: (text || '').trim(), warnings })
  }, [openExternalUrl])

  // Keep the latest handler in a ref so the mail:link subscription below can be
  // mount-once (stable deps []) while still calling the current handleLinkClick.
  const handleLinkClickRef = useRef(handleLinkClick)
  handleLinkClickRef.current = handleLinkClick

  // Subscribe to mail:link IPC events emitted by the main process when the
  // user clicks a rewritten link inside the sandboxed iframe (will-frame-navigate
  // → mail:link broadcast). Without this, clicks fall through to
  // configureExternalLinks() → shell.openExternal() without any phishing warning.
  //
  // BACKLOG §2.25: this effect MUST be mount-once (deps []). `handleLinkClick`
  // changes identity on every render (it closes over the caller-supplied
  // `onOpenExternalError`, typically an inline arrow from App.tsx). If this
  // effect depended on it, it would resubscribe every render — and because the
  // preload `off()` bridge cannot match a contextBridge-proxied listener by
  // identity, the old listener is never removed. Each render then leaks another
  // live `mail:link` listener, so a single link click fans out into N
  // `ui:openExternal` calls → N browser tabs (the runaway-tabs incident).
  // Subscribing once and reading the handler through a ref removes the coupling.
  useEffect(() => {
    const onLink = (payload: unknown) => {
      const d = payload as { href?: unknown; text?: unknown; unsafeBypass?: unknown }
      if (!d || typeof d !== 'object') return
      const href = (d as { href?: unknown }).href
      const text = (d as { text?: unknown }).text
      const unsafeBypass = (d as { unsafeBypass?: unknown }).unsafeBypass === true
      if (typeof href !== 'string') return
      void handleLinkClickRef.current(href, typeof text === 'string' ? text : '', unsafeBypass)
    }
    window.api?.on('mail:link', onLink)
    return () => window.api?.off('mail:link', onLink)
  }, [])

  const dismissPrompt = useCallback(() => setLinkPrompt(null), [])

  const approvePrompt = useCallback(async (): Promise<void> => {
    if (!linkPrompt) return
    const url = linkPrompt.url
    await openExternalUrl(url).finally(() => setLinkPrompt(null))
  }, [linkPrompt, openExternalUrl])

  return { linkPrompt, handleLinkClick, dismissPrompt, approvePrompt }
}
