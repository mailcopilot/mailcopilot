import { useCallback, useEffect, useState } from 'react'

/**
 * Payload of the `mail:sentCopyFailed` broadcast (see
 * electron/services/sentCopyFailure.ts): SMTP delivery succeeded but the
 * IMAP APPEND of the message copy into the Sent folder failed.
 */
export type SentCopyFailure = {
  accountId: number
  /** Sent folder path the APPEND targeted, or null when it could not be resolved. */
  folder: string | null
}

export interface UseSentCopyFailureToastReturn {
  /** Latest unacknowledged failure, or null when no toast should be shown. */
  sentCopyFailure: SentCopyFailure | null
  /** Hide the toast. */
  dismissSentCopyFailure: () => void
}

/**
 * Listens for `mail:sentCopyFailed` IPC events and exposes toast state for a
 * non-modal "message delivered, but Sent copy failed" notification
 * (BACKLOG §2.23 PR1). No Retry action here — the retry queue is §2.23 PR2.
 *
 * BACKLOG §2.25 / §2.25.f1: the preload `off()` bridge cannot remove a
 * contextBridge-proxied listener by identity, so an effect that re-subscribes
 * on re-render leaks live listeners (the runaway-tabs incident class). The
 * subscription below is therefore mount-once (deps []). The handler only
 * calls the stable `setFailure` setter, so no ref indirection is needed.
 */
export function useSentCopyFailureToast(): UseSentCopyFailureToastReturn {
  const [failure, setFailure] = useState<SentCopyFailure | null>(null)

  useEffect(() => {
    const onSentCopyFailed = (payload: unknown) => {
      if (!payload || typeof payload !== 'object') return
      const d = payload as { accountId?: unknown; folder?: unknown }
      if (typeof d.accountId !== 'number') return
      const folder = typeof d.folder === 'string' && d.folder.length > 0 ? d.folder : null
      // Latest failure wins: payload carries no message content, only the
      // account id and the Sent folder path (no PII in the toast).
      setFailure({ accountId: d.accountId, folder })
    }
    window.api?.on('mail:sentCopyFailed', onSentCopyFailed)
    return () => window.api?.off('mail:sentCopyFailed', onSentCopyFailed)
  }, [])

  const dismissSentCopyFailure = useCallback(() => setFailure(null), [])

  return { sentCopyFailure: failure, dismissSentCopyFailure }
}
